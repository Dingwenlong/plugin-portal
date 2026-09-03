from __future__ import annotations

import http.client
import os
import re
import secrets
import stat
import threading
import tempfile
from collections.abc import Callable
from copy import deepcopy
from pathlib import Path
from typing import Any

from .download_publication import DownloadPublicationError, DownloadPublisher
from .models import ModelValidationError, parse_plugin_key
from .directory_picker import choose_plugin_archive, choose_plugin_directory
from .plugin_reader import PluginIconNotFound, PluginReadError, preview_plugin, read_plugin_icon
from .plugin_archive import PluginArchiveError, extract_plugin_archive
from .prompts import PromptRepository, PromptValidationError
from .storage import PortalStore, RevisionConflict, StorageError
from .uploads import UploadError, UploadRegistry
from .workflows import WorkflowRepository, WorkflowValidationError


class ApiError(RuntimeError):
    def __init__(self, message: str, *, status: int = 400, code: str = "invalid_request"):
        super().__init__(message)
        self.status = status
        self.code = code


_DOWNLOAD_BASE_URL = "http://127.0.0.1:9134/downloads/"
_SAFE_VERSION = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,63})$")
_REPARSE_POINT = 0x400
_GENERIC_PLUGIN_ICON = b"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#9fb3c8" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>"""


class PortalApi:
    def __init__(
        self,
        store: PortalStore,
        directory_picker: Callable[[], Path | None] = choose_plugin_directory,
        archive_picker: Callable[[], Path | None] = choose_plugin_archive,
        download_publisher: DownloadPublisher | None = None,
        download_probe: Callable[[str], bool] | None = None,
        plugin_cache_root: Path | str | None = None,
        upload_registry: UploadRegistry | None = None,
        access_mode: str = "local-management",
    ):
        if access_mode not in {"local-management", "remote-management", "read-only"}:
            raise ValueError("Portal 访问模式无效")
        self.store = store
        self.directory_picker = directory_picker
        self.archive_picker = archive_picker
        self.download_publisher = download_publisher
        self.prompts = PromptRepository(store)
        self.workflows = WorkflowRepository(store)
        self.download_probe = download_probe or _probe_local_download
        self.plugin_cache_root = Path(plugin_cache_root) if plugin_cache_root is not None else _default_plugin_cache_root()
        self.uploads = upload_registry
        self.access_mode = access_mode
        self._sessions: dict[str, dict[str, dict[str, Any]]] = {}
        self._lock = threading.RLock()

    def close(self) -> None:
        if self.uploads is not None:
            self.uploads.close()

    def create_session(self) -> dict[str, str]:
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._sessions[token] = {}
        return {"token": token}

    def stage_upload(
        self,
        token: str,
        kind: str,
        file_name: str,
        source,
        content_length: int,
    ) -> dict[str, Any]:
        self._require_session(token)
        if self.access_mode != "remote-management" or self.uploads is None:
            raise ApiError("浏览器上传不可用", status=404, code="upload_unavailable")
        try:
            upload = self.uploads.stage(token, kind, file_name, source, content_length)
        except UploadError as error:
            raise self._upload_error(error) from None
        return {
            "uploadId": upload.upload_id,
            "fileName": upload.file_name,
            "archiveBytes": upload.size,
        }

    def select_plugin_directory(self, token: str, payload: object) -> dict[str, Any]:
        self._require_session(token)
        if payload != {}:
            raise ApiError("目录选择请求结构无效")
        try:
            selected = self.directory_picker()
        except RuntimeError:
            raise ApiError(
                "无法打开插件目录选择器",
                status=500,
                code="directory_picker_failed",
            ) from None
        if selected is None:
            return {"selected": False}
        if not isinstance(selected, (Path, str)):
            raise ApiError("目录选择器回应无效", status=500, code="directory_picker_failed")
        return {"selected": True, "path": str(Path(selected).absolute())}

    def preview_import(self, token: str, payload: object) -> dict[str, Any]:
        candidates = self._require_session(token)
        required = {
            "source",
            "target",
            "expectedPluginId",
            "approvedRulePaths",
            "extensionTools",
        }
        if not isinstance(payload, dict) or set(payload) != required:
            raise ApiError("导入资料结构无效")
        if not isinstance(payload["expectedPluginId"], str):
            raise ApiError("插件目录无效")
        source = payload["source"]
        if not isinstance(source, dict) or not isinstance(source.get("kind"), str):
            raise ApiError("插件来源结构无效")

        uploaded_id: str | None = None
        if source.get("kind") == "server-directory":
            if set(source) != {"kind", "path"} or not isinstance(source.get("path"), str):
                raise ApiError("插件来源结构无效")
            if self.access_mode != "local-management":
                raise ApiError("当前模式不允许读取服务器目录", code="source_mode_invalid")
            plugin_root = Path(source["path"])
            snapshot, icon = self._project_plugin(plugin_root, payload)
        elif source.get("kind") == "upload":
            if set(source) != {"kind", "uploadId"} or not isinstance(source.get("uploadId"), str):
                raise ApiError("插件来源结构无效")
            if self.access_mode != "remote-management" or self.uploads is None:
                raise ApiError("当前模式不允许使用上传来源", code="source_mode_invalid")
            uploaded_id = source["uploadId"]
            try:
                upload = self.uploads.require(token, "plugin-import", uploaded_id)
            except UploadError as error:
                raise self._upload_error(error) from None
            try:
                with tempfile.TemporaryDirectory(
                    dir=upload.path.parent,
                    prefix=f"{upload.upload_id}-extract-",
                ) as extraction_root:
                    try:
                        plugin_root = extract_plugin_archive(upload.path, Path(extraction_root) / "content")
                    except PluginArchiveError as error:
                        self.uploads.discard(token, "plugin-import", uploaded_id)
                        raise ApiError(str(error), code=error.code) from None
                    snapshot, icon = self._project_plugin(plugin_root, payload)
            except ApiError:
                raise
            except OSError:
                raise ApiError("无法建立插件解压暂存目录", status=500, code="upload_storage_failed") from None
        else:
            raise ApiError("插件来源结构无效")

        if uploaded_id is not None:
            try:
                self.uploads.consume(token, "plugin-import", uploaded_id)
            except UploadError as error:
                raise self._upload_error(error) from None

        plugin_key = f"{snapshot['plugin']['target']}/{snapshot['plugin']['id']}"
        candidate_id = secrets.token_urlsafe(24)
        with self._lock:
            candidate = {
                "kind": "plugin-import",
                "pluginKey": plugin_key,
                "snapshot": deepcopy(snapshot),
            }
            if icon is not None:
                candidate["icon"] = icon
            candidates[candidate_id] = candidate
        return {"candidateId": candidate_id, "pluginKey": plugin_key, "snapshot": snapshot}

    def _project_plugin(self, plugin_root: Path, payload: dict[str, Any]) -> tuple[dict[str, Any], tuple[str, bytes] | None]:
        try:
            snapshot = preview_plugin(
                plugin_root,
                target=payload["target"],
                expected_plugin_id=payload["expectedPluginId"].strip() or None,
                approved_rule_paths=payload["approvedRulePaths"],
                extension_tools=payload["extensionTools"],
            )
            try:
                content_type, icon_payload = read_plugin_icon(plugin_root)
                icon = (content_type, bytes(icon_payload))
            except PluginIconNotFound:
                icon = None
        except (PluginReadError, TypeError) as error:
            raise ApiError(str(error), code="plugin_preview_failed") from None
        return snapshot, icon

    def promote(self, token: str, plugin_key: str, payload: object) -> dict[str, Any]:
        candidates = self._require_session(token)
        body = self._mutation_body(payload, with_candidate=True)
        candidate = candidates.get(body["candidateId"])
        if candidate is None or candidate.get("kind") != "plugin-import":
            raise ApiError("导入候选不存在或已失效", status=404, code="candidate_not_found")
        self._require_plugin_key(plugin_key)
        if candidate["pluginKey"] != plugin_key:
            raise ApiError("插件身份不一致", code="plugin_identity_mismatch")

        snapshot = candidate["snapshot"]
        try:
            snapshot_id = self.store.put_snapshot(plugin_key, snapshot)
            icon = candidate.get("icon")
            if icon is not None:
                self.store.put_snapshot_icon(plugin_key, snapshot_id, icon[0], icon[1])
            catalog = self._catalog()
            record = catalog["data"]["plugins"].get(plugin_key, {"activeSnapshot": None, "history": []})
            history = list(record["history"])
            if snapshot_id not in history:
                history.append(snapshot_id)
            next_data = deepcopy(catalog["data"])
            next_data["plugins"][plugin_key] = {
                "activeSnapshot": snapshot_id,
                "history": history,
                "plugin": deepcopy(snapshot["plugin"]),
            }
            written = self.store.write_document("catalog", next_data, body["expectedRevision"])
        except RevisionConflict as error:
            raise ApiError(str(error), status=409, code="revision_conflict") from None
        except StorageError:
            raise ApiError("无法切换活动插件快照", status=500, code="storage_failed") from None
        with self._lock:
            candidates.pop(body["candidateId"], None)
        return {"revision": written["revision"], "pluginKey": plugin_key, "snapshotId": snapshot_id}

    def select_download_candidate(self, token: str, plugin_key: str, payload: object) -> dict[str, Any]:
        candidates = self._require_session(token)
        self._require_plugin_key(plugin_key)
        if payload != {}:
            raise ApiError("下载发布选择请求结构无效")
        if self.access_mode != "local-management":
            raise ApiError("当前模式不允许使用服务器文件选择器", code="source_mode_invalid")
        version = self._active_plugin_version(plugin_key)
        if self.download_publisher is None:
            raise ApiError("下载发布服务不可用", status=503, code="publication_unavailable")
        try:
            selected = self.archive_picker()
        except RuntimeError:
            raise ApiError("无法打开候选 ZIP 选择器", status=500, code="archive_picker_failed") from None
        if selected is None:
            return {"selected": False}
        if not isinstance(selected, (Path, str)):
            raise ApiError("候选 ZIP 选择器回应无效", status=500, code="archive_picker_failed")
        try:
            candidate = self.download_publisher.preview(
                Path(selected),
                plugin_key=plugin_key,
                expected_version=version,
            )
        except DownloadPublicationError as error:
            raise self._publication_error(error) from None
        return self._record_download_candidate(candidates, plugin_key, version, candidate)

    def upload_download_candidate(
        self,
        token: str,
        plugin_key: str,
        file_name: str,
        source,
        content_length: int,
    ) -> dict[str, Any]:
        candidates = self._require_session(token)
        self._require_plugin_key(plugin_key)
        if self.access_mode != "remote-management" or self.uploads is None:
            raise ApiError("浏览器上传不可用", status=404, code="upload_unavailable")
        version = self._active_plugin_version(plugin_key)
        if self.download_publisher is None:
            raise ApiError("下载发布服务不可用", status=503, code="publication_unavailable")
        try:
            upload = self.uploads.stage(token, "download-publication", file_name, source, content_length)
        except UploadError as error:
            raise self._upload_error(error) from None
        self._remove_replaced_download_candidates(candidates)
        try:
            candidate = self.download_publisher.preview(
                upload.path,
                plugin_key=plugin_key,
                expected_version=version,
            )
        except DownloadPublicationError as error:
            try:
                self.uploads.discard(token, "download-publication", upload.upload_id)
            except UploadError:
                pass
            raise self._publication_error(error) from None
        return self._record_download_candidate(
            candidates,
            plugin_key,
            version,
            candidate,
            upload_id=upload.upload_id,
        )

    def _record_download_candidate(
        self,
        candidates: dict[str, dict[str, Any]],
        plugin_key: str,
        version: str,
        candidate,
        *,
        upload_id: str | None = None,
    ) -> dict[str, Any]:
        publication_id = secrets.token_urlsafe(24)
        with self._lock:
            record = {
                "kind": "download-publication",
                "pluginKey": plugin_key,
                "version": version,
                "candidate": candidate,
            }
            if upload_id is not None:
                record["uploadId"] = upload_id
            candidates[publication_id] = record
        return {
            "selected": True,
            "publicationId": publication_id,
            "preview": candidate.public_preview(),
        }

    def _remove_replaced_download_candidates(self, candidates: dict[str, dict[str, Any]]) -> None:
        with self._lock:
            stale = [
                candidate_id
                for candidate_id, candidate in candidates.items()
                if candidate.get("kind") == "download-publication" and "uploadId" in candidate
            ]
            for candidate_id in stale:
                candidates.pop(candidate_id, None)

    def confirm_download_publication(self, token: str, plugin_key: str, payload: object) -> dict[str, Any]:
        candidates = self._require_session(token)
        self._require_plugin_key(plugin_key)
        if (
            not isinstance(payload, dict)
            or set(payload) != {"publicationId"}
            or not isinstance(payload["publicationId"], str)
            or not payload["publicationId"]
        ):
            raise ApiError("下载发布确认请求结构无效")
        publication_id = payload["publicationId"]
        record = candidates.get(publication_id)
        if record is None or record.get("kind") != "download-publication":
            raise ApiError("下载发布候选不存在或已失效", status=404, code="publication_not_found")
        if record.get("pluginKey") != plugin_key:
            raise ApiError("插件身份不一致", code="plugin_identity_mismatch")
        upload_id = record.get("uploadId")
        if upload_id is not None:
            if not isinstance(upload_id, str) or self.uploads is None:
                self._remove_download_candidate(candidates, publication_id, token, upload_id)
                raise ApiError("下载发布候选不存在或已失效", status=404, code="publication_not_found")
            try:
                upload = self.uploads.require(token, "download-publication", upload_id)
            except UploadError:
                self._remove_download_candidate(candidates, publication_id, token, upload_id)
                raise ApiError("下载发布候选不存在或已失效", status=404, code="publication_not_found") from None
            if Path(record["candidate"].source_path) != upload.path:
                self._remove_download_candidate(candidates, publication_id, token, upload_id)
                raise ApiError("下载发布候选不存在或已失效", status=404, code="publication_not_found")
        if record.get("version") != self._active_plugin_version(plugin_key):
            self._remove_download_candidate(candidates, publication_id, token, upload_id)
            raise ApiError("插件活动版本已改变", status=409, code="plugin_version_changed")
        if self.download_publisher is None:
            raise ApiError("下载发布服务不可用", status=503, code="publication_unavailable")
        try:
            receipt = self.download_publisher.publish(record["candidate"])
        except DownloadPublicationError as error:
            if error.code in {"candidate_changed", "publication_invalid"}:
                self._remove_download_candidate(candidates, publication_id, token, upload_id)
            raise self._publication_error(error) from None
        self._remove_download_candidate(candidates, publication_id, token, upload_id)
        return receipt.public_result()

    def _remove_download_candidate(
        self,
        candidates: dict[str, dict[str, Any]],
        publication_id: str,
        token: str,
        upload_id: object,
    ) -> None:
        with self._lock:
            candidates.pop(publication_id, None)
        if isinstance(upload_id, str) and self.uploads is not None:
            try:
                self.uploads.consume(token, "download-publication", upload_id)
            except UploadError:
                pass

    def rollback(self, token: str, plugin_key: str, payload: object) -> dict[str, Any]:
        self._require_session(token)
        body = self._mutation_body(payload, with_candidate=False)
        self._require_plugin_key(plugin_key)
        catalog = self._catalog()
        record = catalog["data"]["plugins"].get(plugin_key)
        if record is None:
            raise ApiError("插件尚未纳入", status=404, code="plugin_not_found")
        try:
            current_index = record["history"].index(record["activeSnapshot"])
        except (ValueError, KeyError):
            raise ApiError("插件快照记录无效", status=500, code="catalog_invalid") from None
        if current_index == 0:
            raise ApiError("没有可回滚的插件快照", code="rollback_unavailable")
        previous = record["history"][current_index - 1]
        next_data = deepcopy(catalog["data"])
        next_data["plugins"][plugin_key]["activeSnapshot"] = previous
        previous_snapshot = self.store.read_snapshot(plugin_key, previous)
        next_data["plugins"][plugin_key]["plugin"] = deepcopy(previous_snapshot["plugin"])
        try:
            written = self.store.write_document("catalog", next_data, body["expectedRevision"])
        except RevisionConflict as error:
            raise ApiError(str(error), status=409, code="revision_conflict") from None
        except StorageError:
            raise ApiError("无法回滚插件快照", status=500, code="storage_failed") from None
        return {"revision": written["revision"], "pluginKey": plugin_key, "snapshotId": previous}

    def list_plugins(self) -> dict[str, Any]:
        catalog = self._catalog()
        items = []
        for plugin_key in sorted(catalog["data"]["plugins"]):
            record = catalog["data"]["plugins"][plugin_key]
            plugin = record["plugin"]
            items.append(
                {
                    "pluginKey": plugin_key,
                    "id": plugin["id"],
                    "name": plugin["name"],
                    "version": plugin["version"],
                    "summary": plugin["summary"],
                }
            )
        return {"revision": catalog["revision"], "items": items}

    def get_snapshot(self, plugin_key: str) -> dict[str, Any]:
        self._require_plugin_key(plugin_key)
        record = self._catalog()["data"]["plugins"].get(plugin_key)
        if record is None:
            raise ApiError("插件尚未纳入", status=404, code="plugin_not_found")
        try:
            return self.store.read_snapshot(plugin_key, record["activeSnapshot"])
        except StorageError:
            raise ApiError("活动插件快照不可用", status=500, code="snapshot_unavailable") from None

    def get_download_info(self, plugin_key: str) -> dict[str, Any]:
        target, plugin_id = self._plugin_identity(plugin_key)
        snapshot = self.get_snapshot(plugin_key)
        plugin = snapshot.get("plugin")
        if not isinstance(plugin, dict) or plugin.get("target") != target or plugin.get("id") != plugin_id:
            raise ApiError("活动插件身份无效", status=500, code="snapshot_invalid")
        version = plugin.get("version")
        if not isinstance(version, str) or not _SAFE_VERSION.fullmatch(version):
            raise ApiError("活动插件版本无效", status=500, code="snapshot_invalid")
        href = f"{_DOWNLOAD_BASE_URL}{plugin_id}-{version}-{target}.zip"
        try:
            available = self.download_probe(href) is True
        except Exception:
            available = False
        return {"available": available, "version": version, "href": href if available else None}

    def get_plugin_icon(self, plugin_key: str) -> tuple[str, bytes]:
        target, plugin_id = self._plugin_identity(plugin_key)
        snapshot = self.get_snapshot(plugin_key)
        plugin = snapshot.get("plugin")
        if not isinstance(plugin, dict) or plugin.get("target") != target or plugin.get("id") != plugin_id:
            raise ApiError("活动插件身份无效", status=500, code="snapshot_invalid")
        version = plugin.get("version")
        if not isinstance(version, str) or not _SAFE_VERSION.fullmatch(version):
            raise ApiError("活动插件版本无效", status=500, code="snapshot_invalid")
        record = self._catalog()["data"]["plugins"].get(plugin_key)
        snapshot_id = record.get("activeSnapshot") if isinstance(record, dict) else None
        try:
            return self.store.read_snapshot_icon(plugin_key, snapshot_id)
        except StorageError:
            pass
        try:
            root = self._installed_plugin_root(target, plugin_id, version)
            return read_plugin_icon(root)
        except (ApiError, PluginReadError):
            return "image/svg+xml", _GENERIC_PLUGIN_ICON

    def get_prompts(self, plugin_key: str) -> dict[str, Any]:
        self._require_plugin_key(plugin_key)
        try:
            return self.prompts.get(plugin_key)
        except (PromptValidationError, StorageError):
            raise ApiError("Prompts 资料不可用", status=500, code="prompts_unavailable") from None

    def save_prompts(self, token: str, plugin_key: str, payload: object) -> dict[str, Any]:
        self._require_session(token)
        self._require_plugin_key(plugin_key)
        if not isinstance(payload, dict) or set(payload) != {"expectedRevision", "items"}:
            raise ApiError("Prompts 变更结构无效")
        revision = self._revision(payload["expectedRevision"])
        try:
            return self.prompts.save(plugin_key, payload["items"], expected_revision=revision)
        except PromptValidationError as error:
            raise ApiError(str(error), code="prompts_invalid") from None
        except RevisionConflict as error:
            raise ApiError(str(error), status=409, code="revision_conflict") from None
        except StorageError:
            raise ApiError("无法保存 Prompts", status=500, code="storage_failed") from None

    def get_workflows(self, plugin_key: str) -> dict[str, Any]:
        self._require_plugin_key(plugin_key)
        try:
            return self.workflows.get(plugin_key)
        except (WorkflowValidationError, StorageError):
            raise ApiError("流程资料不可用", status=500, code="workflows_unavailable") from None

    def save_workflows(self, token: str, plugin_key: str, payload: object) -> dict[str, Any]:
        self._require_session(token)
        self._require_plugin_key(plugin_key)
        if not isinstance(payload, dict) or set(payload) != {"expectedRevision", "workflow"}:
            raise ApiError("流程变更结构无效")
        revision = self._revision(payload["expectedRevision"])
        try:
            return self.workflows.save(plugin_key, payload["workflow"], expected_revision=revision)
        except WorkflowValidationError as error:
            raise ApiError(str(error), code="workflow_invalid") from None
        except RevisionConflict as error:
            raise ApiError(str(error), status=409, code="revision_conflict") from None
        except StorageError:
            raise ApiError("无法保存流程", status=500, code="storage_failed") from None

    def _require_session(self, token: str) -> dict[str, dict[str, Any]]:
        if not isinstance(token, str):
            raise ApiError("会话无效", status=401, code="invalid_session")
        with self._lock:
            session = self._sessions.get(token)
        if session is None:
            raise ApiError("会话无效", status=401, code="invalid_session")
        return session

    def _catalog(self) -> dict[str, Any]:
        try:
            document = self.store.read_document("catalog")
        except StorageError:
            raise ApiError("插件目录资料不可用", status=500, code="catalog_unavailable") from None
        if document["data"] == {}:
            return {"revision": document["revision"], "data": {"plugins": {}}}
        if set(document["data"]) != {"plugins"} or not isinstance(document["data"]["plugins"], dict):
            raise ApiError("插件目录资料无效", status=500, code="catalog_invalid")
        return document

    def _active_plugin_version(self, plugin_key: str) -> str:
        record = self._catalog()["data"]["plugins"].get(plugin_key)
        plugin = record.get("plugin") if isinstance(record, dict) else None
        version = plugin.get("version") if isinstance(plugin, dict) else None
        if record is None:
            raise ApiError("插件尚未纳入", status=404, code="plugin_not_found")
        if not isinstance(version, str) or _SAFE_VERSION.fullmatch(version) is None:
            raise ApiError("插件活动版本无效", status=500, code="catalog_invalid")
        return version

    @staticmethod
    def _publication_error(error: DownloadPublicationError) -> ApiError:
        if error.code == "destination_exists":
            status = 409
        elif error.code in {"plugin_release_unavailable", "download_root_unavailable"}:
            status = 503
        elif error.code in {
            "publication_failed",
            "download_readback_failed",
            "download_quarantine_failed",
            "publication_receipt_failed",
        }:
            status = 500
        else:
            status = 400
        return ApiError(str(error), status=status, code=error.code)

    @staticmethod
    def _upload_error(error: UploadError) -> ApiError:
        status = {
            "upload_not_found": 404,
            "payload_too_large": 413,
            "upload_busy": 429,
            "upload_storage_failed": 500,
            "upload_unavailable": 503,
        }.get(error.code, 400)
        return ApiError(str(error), status=status, code=error.code)

    @staticmethod
    def _mutation_body(payload: object, *, with_candidate: bool) -> dict[str, Any]:
        fields = {"expectedRevision", "candidateId"} if with_candidate else {"expectedRevision"}
        if not isinstance(payload, dict) or set(payload) != fields:
            raise ApiError("变更资料结构无效")
        revision = payload["expectedRevision"]
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
            raise ApiError("expectedRevision 无效")
        if with_candidate and (not isinstance(payload["candidateId"], str) or not payload["candidateId"]):
            raise ApiError("candidateId 无效")
        return payload

    @staticmethod
    def _require_plugin_key(plugin_key: str) -> None:
        try:
            parse_plugin_key(plugin_key)
        except ModelValidationError:
            raise ApiError("插件身份无效") from None

    @staticmethod
    def _plugin_identity(plugin_key: str) -> tuple[str, str]:
        try:
            return parse_plugin_key(plugin_key)
        except ModelValidationError:
            raise ApiError("插件身份无效") from None

    def _installed_plugin_root(self, target: str, plugin_id: str, version: str) -> Path:
        candidate = self.plugin_cache_root.expanduser().absolute()
        try:
            for part in (None, target, plugin_id, version):
                if part is not None:
                    candidate = candidate / part
                info = os.lstat(candidate)
                if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or bool(
                    getattr(info, "st_file_attributes", 0) & _REPARSE_POINT
                ):
                    raise OSError
        except OSError:
            raise ApiError("该插件未提供公开图标", status=404, code="icon_not_found") from None
        return candidate

    @staticmethod
    def _revision(value: object) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ApiError("expectedRevision 无效")
        return value


def _default_plugin_cache_root() -> Path:
    codex_home = os.environ.get("CODEX_HOME")
    return (Path(codex_home) if codex_home else Path.home() / ".codex") / "plugins" / "cache"


def _probe_local_download(url: str) -> bool:
    from urllib.parse import urlsplit

    parsed = urlsplit(url)
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or parsed.port != 9134
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or not parsed.path.startswith("/downloads/")
        or not parsed.path.endswith(".zip")
    ):
        return False
    connection = http.client.HTTPConnection("127.0.0.1", 9134, timeout=1.5)
    try:
        connection.request("HEAD", parsed.path, headers={"Accept": "application/zip"})
        response = connection.getresponse()
        content_type = response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
        content_length = response.getheader("Content-Length", "")
        return response.status == 200 and content_type in {
            "application/zip",
            "application/x-zip-compressed",
        } and content_length.isdigit() and int(content_length) > 0
    except OSError:
        return False
    finally:
        connection.close()
