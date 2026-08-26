from __future__ import annotations

import json
import mimetypes
import os
import re
import stat
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import unquote, urlsplit

from .api import ApiError, PortalApi
from .directory_picker import choose_plugin_directory
from .storage import PortalStore


class ServerConfigurationError(ValueError):
    """Raised when the local service would violate its loopback contract."""


class PortalHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], api: PortalApi, web_root: Path):
        self.api = api
        self.web_root = web_root
        super().__init__(address, PortalRequestHandler)


def create_server(
    *,
    host: str,
    port: int,
    data_root: Path | str,
    web_root: Path | str,
    test_only: bool = False,
    directory_picker=choose_plugin_directory,
) -> PortalHTTPServer:
    if host != "127.0.0.1":
        raise ServerConfigurationError("Portal 只允许绑定 127.0.0.1")
    if test_only:
        if port != 0:
            raise ServerConfigurationError("测试模式必须使用系统分配的临时端口")
    elif port != 9137:
        raise ServerConfigurationError("正式 Portal 端口必须是 9137")

    root = Path(web_root).expanduser().absolute()
    try:
        info = os.lstat(root)
    except OSError as error:
        raise ServerConfigurationError("Portal 静态目录不存在") from error
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise ServerConfigurationError("Portal 静态目录无效")
    return PortalHTTPServer(
        (host, port),
        PortalApi(PortalStore(data_root), directory_picker=directory_picker),
        root,
    )


class PortalRequestHandler(BaseHTTPRequestHandler):
    server: PortalHTTPServer
    protocol_version = "HTTP/1.1"
    _PROMOTE = re.compile(r"^/api/plugins/([^/]+)/promote$")
    _ROLLBACK = re.compile(r"^/api/plugins/([^/]+)/rollback$")
    _SNAPSHOT = re.compile(r"^/api/plugins/([^/]+)/snapshot$")
    _ICON = re.compile(r"^/api/plugins/([^/]+)/icon$")
    _DOWNLOAD_INFO = re.compile(r"^/api/plugins/([^/]+)/download-info$")
    _PROMPTS = re.compile(r"^/api/plugins/([^/]+)/prompts$")
    _WORKFLOWS = re.compile(r"^/api/plugins/([^/]+)/workflows$")

    def do_GET(self) -> None:  # noqa: N802
        if not self._same_origin():
            self._send_error(HTTPStatus.FORBIDDEN, "cross_origin", "不允许跨来源访问")
            return
        path = urlsplit(self.path).path
        if path == "/api/plugins":
            self._send_json(HTTPStatus.OK, self.server.api.list_plugins())
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
            self._call_api(lambda: self.server.api.get_download_info(unquote(match.group(1))))
            return
        for pattern, operation in (
            (self._PROMPTS, self.server.api.get_prompts),
            (self._WORKFLOWS, self.server.api.get_workflows),
        ):
            match = pattern.fullmatch(path)
            if match:
                plugin_key = unquote(match.group(1))
                self._call_api(lambda operation=operation: operation(plugin_key))
                return
        self._serve_static(path)

    def do_HEAD(self) -> None:  # noqa: N802
        if not self._same_origin():
            self._send_error(HTTPStatus.FORBIDDEN, "cross_origin", "不允许跨来源访问")
            return
        self._serve_static(urlsplit(self.path).path, send_body=False)

    def do_POST(self) -> None:  # noqa: N802
        if not self._same_origin():
            self._send_error(HTTPStatus.FORBIDDEN, "cross_origin", "不允许跨来源访问")
            return
        path = urlsplit(self.path).path
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

    def _same_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        return origin == f"http://{self.headers.get('Host', '')}"

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
        self.wfile.write(payload)

    def _send_bytes(self, status: int | HTTPStatus, payload: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args: object) -> None:
        return
