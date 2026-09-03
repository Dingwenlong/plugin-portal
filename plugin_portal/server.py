from __future__ import annotations

import json
import mimetypes
import os
import re
import stat
import ipaddress
import http.client
from email.message import Message
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote, unquote, urlsplit

from .api import ApiError, PortalApi
from .directory_picker import choose_plugin_archive, choose_plugin_directory
from .download_publication import DownloadPublisher, PluginReleaseAuditor, read_9134_download
from .lan_download import read_download
from .storage import PortalStore
from .uploads import UploadRegistry


class ServerConfigurationError(ValueError):
    """Raised when the local service would violate its loopback contract."""


class PortalHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], api: PortalApi, web_root: Path, *,
                 read_only: bool = False, access_mode: str = "local-management",
                 https_origin: str | None = None):
        self.api = api
        self.web_root = web_root
        self.read_only = read_only
        self.access_mode = access_mode
        self.file_selection_mode = {
            "local-management": "server-picker",
            "remote-management": "browser-upload",
            "read-only": "none",
        }[access_mode]
        self.external_mode = access_mode != "local-management"
        self.https_origin = https_origin
        self.public_files = _public_static_files(web_root) if self.external_mode else {}
        super().__init__(address, PortalRequestHandler)

    def server_close(self) -> None:
        self.api.close()
        super().server_close()


def create_server(
    *,
    host: str,
    port: int,
    data_root: Path | str,
    web_root: Path | str,
    test_only: bool = False,
    read_only: bool = False,
    remote_management: bool = False,
    https_origin: str | None = None,
    directory_picker=choose_plugin_directory,
    archive_picker=choose_plugin_archive,
    download_publisher=None,
) -> PortalHTTPServer:
    access_mode = _access_mode(read_only=read_only, remote_management=remote_management)
    external_mode = access_mode != "local-management"
    if https_origin is not None:
        _validate_https_origin(
            https_origin,
            allow_test_loopback=test_only and access_mode == "remote-management",
        )
        if not external_mode or host != "127.0.0.1" or (not test_only and port != 9135):
            raise ServerConfigurationError("HTTPS 代理后台只能绑定 127.0.0.1:9135")
    elif access_mode == "remote-management":
        raise ServerConfigurationError("远端管理模式必须提供明确的 HTTPS 来源")
    elif read_only and not test_only:
        try:
            address = ipaddress.IPv4Address(host)
        except ipaddress.AddressValueError:
            raise ServerConfigurationError("只读 Portal 必须绑定明确的局域网 IPv4 地址") from None
        if not any(address in ipaddress.IPv4Network(network)
                   for network in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")) or port != 9135:
            raise ServerConfigurationError("只读 Portal 必须绑定局域网地址及 9135 端口")
    elif host != "127.0.0.1":
        raise ServerConfigurationError("Portal 只允许绑定 127.0.0.1")
    if test_only:
        if port != 0:
            raise ServerConfigurationError("测试模式必须使用系统分配的临时端口")
    elif external_mode:
        if port != 9135:
            raise ServerConfigurationError("正式外部 Portal 端口必须是 9135")
    elif port != 9137:
        raise ServerConfigurationError("正式 Portal 端口必须是 9137")

    if external_mode and not Path(data_root).is_dir():
        raise ServerConfigurationError("外部 Portal 需要已存在的本机资料目录")
    root = Path(web_root).expanduser().absolute()
    try:
        info = os.lstat(root)
    except OSError as error:
        raise ServerConfigurationError("Portal 静态目录不存在") from error
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise ServerConfigurationError("Portal 静态目录无效")
    store = PortalStore(data_root)
    upload_registry = UploadRegistry() if access_mode == "remote-management" else None
    publisher = download_publisher
    if publisher is None and not read_only:
        publisher = DownloadPublisher(
            download_root=_default_download_root(),
            receipt_root=store.root / "download-publications",
            auditor=PluginReleaseAuditor(),
            download_reader=read_9134_download,
        )
    return PortalHTTPServer(
        (host, port),
        PortalApi(
            store,
            directory_picker=directory_picker,
            archive_picker=archive_picker,
            download_publisher=publisher,
            upload_registry=upload_registry,
            access_mode=access_mode,
        ),
        root,
        read_only=read_only,
        access_mode=access_mode,
        https_origin=https_origin,
    )


def _access_mode(*, read_only: bool, remote_management: bool) -> str:
    if read_only and remote_management:
        raise ServerConfigurationError("访问模式不能同时为只读和远端管理")
    if read_only:
        return "read-only"
    if remote_management:
        return "remote-management"
    return "local-management"


def _validate_https_origin(origin: str, *, allow_test_loopback: bool = False) -> None:
    try:
        parsed = urlsplit(origin)
        address = ipaddress.IPv4Address(parsed.hostname)
        port = parsed.port
        private_origin = (
            port == 9135
            and any(address in ipaddress.IPv4Network(network)
                    for network in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
        )
        loopback_origin = allow_test_loopback and address.is_loopback and isinstance(port, int)
        valid = (
            parsed.scheme == "https"
            and (private_origin or loopback_origin)
            and origin == f"https://{address}:{port}"
        )
    except (ValueError, TypeError):
        valid = False
    if not valid:
        raise ServerConfigurationError("HTTPS 来源必须是明确的局域网 IPv4 地址及 9135 端口")


def _public_static_files(root: Path) -> dict[str, tuple[str, bytes]]:
    # Freeze only the built page and assets, never expose arbitrary files from the runtime directory.
    files: dict[str, tuple[str, bytes]] = {}
    allowed = {".js", ".css", ".png", ".jpg", ".jpeg", ".svg", ".ico", ".woff", ".woff2"}
    for candidate in root.rglob("*"):
        info = candidate.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ServerConfigurationError("静态资料不能包含链接目录或文件")
        if not candidate.is_file():
            continue
        relative = candidate.relative_to(root).as_posix()
        if relative != "index.html" and not (relative.startswith("assets/") and candidate.suffix in allowed):
            continue
        if info.st_size > 32 * 1024 * 1024:
            raise ServerConfigurationError("静态资料过大")
        mime = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        files["/" + relative] = (mime, candidate.read_bytes())
    if "/index.html" not in files:
        raise ServerConfigurationError("静态首页不存在")
    files["/"] = files["/index.html"]
    return files


class PortalRequestHandler(BaseHTTPRequestHandler):
    server: PortalHTTPServer
    protocol_version = "HTTP/1.1"
    _PROMOTE = re.compile(r"^/api/plugins/([^/]+)/promote$")
    _ROLLBACK = re.compile(r"^/api/plugins/([^/]+)/rollback$")
    _SNAPSHOT = re.compile(r"^/api/plugins/([^/]+)/snapshot$")
    _ICON = re.compile(r"^/api/plugins/([^/]+)/icon$")
    _DOWNLOAD_INFO = re.compile(r"^/api/plugins/([^/]+)/download-info$")
    _DOWNLOAD = re.compile(r"^/api/plugins/([^/]+)/download$")
    _DOWNLOAD_PUBLICATION_SELECT = re.compile(r"^/api/plugins/([^/]+)/download-publication/select$")
    _DOWNLOAD_PUBLICATION_UPLOAD = re.compile(r"^/api/plugins/([^/]+)/download-publication/upload$")
    _DOWNLOAD_PUBLICATION_CONFIRM = re.compile(r"^/api/plugins/([^/]+)/download-publication/confirm$")
    _PROMPTS = re.compile(r"^/api/plugins/([^/]+)/prompts$")
    _WORKFLOWS = re.compile(r"^/api/plugins/([^/]+)/workflows$")
    _PLUGIN_IMPORT_UPLOAD = "/api/uploads/plugin-import"

    def do_GET(self) -> None:  # noqa: N802
        if not self._same_origin():
            self._send_error(HTTPStatus.FORBIDDEN, "cross_origin", "不允许跨来源访问")
            return
        path = urlsplit(self.path).path
        if path == "/api/access":
            self._send_json(
                HTTPStatus.OK,
                {
                    "readOnly": self.server.read_only,
                    "fileSelectionMode": self.server.file_selection_mode,
                },
            )
            return
        if path == "/api/plugins":
            self._call_api(self.server.api.list_plugins)
            return
        match = self._SNAPSHOT.fullmatch(path)
        if match:
            self._call_api(lambda: self.server.api.get_snapshot(unquote(match.group(1))))
            return
        match = self._ICON.fullmatch(path)
        if match:
            try:
                content_type, payload = self.server.api.get_plugin_icon(unquote(match.group(1)))
            except ApiError as error:
                self._send_api_error(error)
                return
            self._send_bytes(HTTPStatus.OK, payload, content_type)
            return
        match = self._DOWNLOAD_INFO.fullmatch(path)
        if match:
            self._call_api(lambda: self._download_info(unquote(match.group(1))))
            return
        match = self._DOWNLOAD.fullmatch(path)
        if match and self.server.external_mode:
            self._download(unquote(match.group(1)))
            return
        for pattern, operation in (
            (self._PROMPTS, self.server.api.get_prompts),
            (self._WORKFLOWS, self.server.api.get_workflows),
        ):
            match = pattern.fullmatch(path)
            if match:
                plugin_key = unquote(match.group(1))
                def read_document(operation=operation):
                    if self.server.read_only:
                        self.server.api.get_snapshot(plugin_key)
                    return operation(plugin_key)
                self._call_api(read_document)
                return
        self._serve_static(path)

    def do_HEAD(self) -> None:  # noqa: N802
        if self.server.external_mode:
            self.do_GET()
            return
        if not self._same_origin():
            self._send_error(HTTPStatus.FORBIDDEN, "cross_origin", "不允许跨来源访问")
            return
        self._serve_static(urlsplit(self.path).path, send_body=False)

    def do_POST(self) -> None:  # noqa: N802
        if self.server.read_only:
            self._deny_write()
            return
        if not self._same_origin():
            self._send_error(HTTPStatus.FORBIDDEN, "cross_origin", "不允许跨来源访问")
            return
        path = urlsplit(self.path).path
        if path == self._PLUGIN_IMPORT_UPLOAD:
            if self.server.access_mode != "remote-management":
                self.close_connection = True
                self._send_error(HTTPStatus.NOT_FOUND, "not_found", "页面不存在")
                return
            self._upload_archive("plugin-import")
            return
        match = self._DOWNLOAD_PUBLICATION_UPLOAD.fullmatch(path)
        if match:
            if self.server.access_mode != "remote-management":
                self.close_connection = True
                self._send_error(HTTPStatus.NOT_FOUND, "not_found", "页面不存在")
                return
            self._upload_archive("download-publication", unquote(match.group(1)))
            return
        try:
            body = self._read_json_body()
        except ApiError as error:
            self._send_api_error(error)
            return
        if path == "/api/session":
            if body != {}:
                self._send_error(HTTPStatus.BAD_REQUEST, "invalid_request", "会话请求结构无效")
                return
            self._send_json(HTTPStatus.CREATED, self.server.api.create_session())
            return

        token = self.headers.get("X-Portal-Session", "")
        if path == "/api/plugins/import/select-directory":
            self._call_api(lambda: self.server.api.select_plugin_directory(token, body))
            return
        if path == "/api/plugins/import/preview":
            self._call_api(lambda: self.server.api.preview_import(token, body), status=HTTPStatus.CREATED)
            return
        match = self._DOWNLOAD_PUBLICATION_SELECT.fullmatch(path)
        if match:
            plugin_key = unquote(match.group(1))
            self._call_api(
                lambda: self.server.api.select_download_candidate(token, plugin_key, body),
                status=HTTPStatus.CREATED,
            )
            return
        match = self._DOWNLOAD_PUBLICATION_CONFIRM.fullmatch(path)
        if match:
            plugin_key = unquote(match.group(1))
            self._call_api(lambda: self.server.api.confirm_download_publication(token, plugin_key, body))
            return
        for pattern, operation in (
            (self._PROMOTE, self.server.api.promote),
            (self._ROLLBACK, self.server.api.rollback),
            (self._PROMPTS, self.server.api.save_prompts),
            (self._WORKFLOWS, self.server.api.save_workflows),
        ):
            match = pattern.fullmatch(path)
            if match:
                plugin_key = unquote(match.group(1))
                self._call_api(lambda operation=operation: operation(token, plugin_key, body))
                return
        self._send_error(HTTPStatus.NOT_FOUND, "not_found", "页面不存在")

    def _upload_archive(self, kind: str, plugin_key: str | None = None) -> None:
        try:
            file_name, content_length = self._upload_headers()
            token = self.headers.get("X-Portal-Session", "")
            if kind == "plugin-import":
                value = self.server.api.stage_upload(token, kind, file_name, self.rfile, content_length)
            elif kind == "download-publication" and plugin_key is not None:
                value = self.server.api.upload_download_candidate(
                    token,
                    plugin_key,
                    file_name,
                    self.rfile,
                    content_length,
                )
            else:
                raise ApiError("上传要求无效", code="invalid_upload")
        except ApiError as error:
            self.close_connection = True
            self._send_api_error(error)
            return
        self._send_json(HTTPStatus.CREATED, value)

    def _upload_headers(self) -> tuple[str, int]:
        content_types = self.headers.get_all("Content-Type")
        dispositions = self.headers.get_all("Content-Disposition")
        lengths = self.headers.get_all("Content-Length")
        if self.headers.get_all("Transfer-Encoding") is not None:
            raise ApiError("上传不支持 Transfer-Encoding", code="invalid_upload")
        if content_types is None or len(content_types) != 1 or content_types[0].strip().lower() != "application/zip":
            raise ApiError("上传 Content-Type 必须是 application/zip", code="invalid_upload")
        if dispositions is None or len(dispositions) != 1:
            raise ApiError("上传缺少有效的 Content-Disposition", code="invalid_upload")
        message = Message()
        message["Content-Disposition"] = dispositions[0]
        try:
            file_name = message.get_filename()
        except (LookupError, UnicodeError, ValueError):
            file_name = None
        if message.get_content_disposition() != "attachment" or not isinstance(file_name, str) or not file_name:
            raise ApiError("上传缺少有效的 ZIP 文件名", code="invalid_upload")
        if lengths is None or len(lengths) != 1:
            raise ApiError("上传缺少有效的 Content-Length", code="invalid_upload")
        try:
            content_length = int(lengths[0])
        except (TypeError, ValueError):
            raise ApiError("上传 Content-Length 无效", code="invalid_upload") from None
        return file_name, content_length

    def _same_origin(self) -> bool:
        if self.server.external_mode:
            expected_host = (urlsplit(self.server.https_origin).netloc if self.server.https_origin else
                             f"{self.server.server_address[0]}:{self.server.server_address[1]}")
            if self.headers.get_all("Host") != [expected_host]:
                return False
        origins = self.headers.get_all("Origin")
        if origins is None:
            return True
        expected_origin = self.server.https_origin or f"http://{self.headers.get('Host', '')}"
        return origins == [expected_origin]

    def _deny_write(self) -> None:
        self._discard_request_body()
        self.close_connection = True
        self._send_error(HTTPStatus.FORBIDDEN, "read_only", "局域网 Portal 仅供阅读，请在本机管理资料")

    def _discard_request_body(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return
        if 0 < length <= 1024 * 1024:
            self.rfile.read(length)

    def do_PUT(self) -> None:  # noqa: N802
        self._deny_write() if self.server.read_only else self._send_error(405, "method_not_allowed", "不支持此操作")

    do_PATCH = do_PUT
    do_DELETE = do_PUT

    def _download_info(self, plugin_key: str) -> dict[str, Any]:
        info = self.server.api.get_download_info(plugin_key)
        if self.server.external_mode and info["available"]:
            info["href"] = f"/api/plugins/{quote(plugin_key, safe='')}/download"
        return info

    def _download(self, plugin_key: str) -> None:
        try:
            info = self.server.api.get_download_info(plugin_key)
            if not info["available"]:
                raise ApiError("该插件未提供可下载版本", status=404, code="download_unavailable")
            payload, length = read_download(info["href"], head_only=self.command == "HEAD")
        except ApiError as error:
            self._send_api_error(error)
            return
        except (OSError, ValueError, http.client.HTTPException):
            self._send_error(502, "download_unavailable", "下载服务暂时不可用")
            return
        filename = urlsplit(info["href"]).path.rsplit("/", 1)[-1]
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Length", str(length))
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _read_json_body(self) -> object:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ApiError("Content-Length 无效") from None
        if length < 0 or length > 1024 * 1024:
            raise ApiError("请求资料过大", status=413, code="payload_too_large")
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError("请求 JSON 无效") from None

    def _call_api(self, operation, *, status: HTTPStatus = HTTPStatus.OK) -> None:
        try:
            value = operation()
        except ApiError as error:
            self._send_api_error(error)
            return
        self._send_json(status, value)

    def _serve_static(self, request_path: str, *, send_body: bool = True) -> None:
        if self.server.external_mode:
            asset = self.server.public_files.get(request_path)
            if asset is None:
                self._send_error(404, "not_found", "页面不存在")
                return
            self._send_bytes(200, asset[1], asset[0])
            return
        decoded = unquote(request_path)
        relative = "index.html" if decoded == "/" else decoded.lstrip("/")
        path = PurePosixPath(relative)
        if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
            self._send_error(HTTPStatus.NOT_FOUND, "not_found", "页面不存在")
            return
        candidate = self.server.web_root.joinpath(*path.parts)
        try:
            info = os.lstat(candidate)
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise OSError
            payload = candidate.read_bytes()
        except OSError:
            self._send_error(HTTPStatus.NOT_FOUND, "not_found", "页面不存在")
            return
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8" if content_type.startswith("text/") else content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if send_body:
            self.wfile.write(payload)

    def _send_api_error(self, error: ApiError) -> None:
        self._send_error(error.status, error.code, str(error))

    def _send_error(self, status: int | HTTPStatus, code: str, message: str) -> None:
        self._send_json(status, {"error": {"code": code, "message": message}})

    def _send_json(self, status: int | HTTPStatus, value: Any) -> None:
        payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _send_bytes(self, status: int | HTTPStatus, payload: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def log_message(self, format: str, *args: object) -> None:
        return


def _default_download_root() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
    return base / "project-delivery-hub-share" / "downloads"
