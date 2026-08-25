from __future__ import annotations

import secrets
import threading
from copy import deepcopy
from pathlib import Path
from typing import Any

from .models import ModelValidationError, parse_plugin_key
from .plugin_reader import PluginReadError, preview_plugin
from .storage import PortalStore, RevisionConflict, StorageError


class ApiError(RuntimeError):
    def __init__(self, message: str, *, status: int = 400, code: str = "invalid_request"):
        super().__init__(message)
        self.status = status
        self.code = code


class PortalApi:
    def __init__(self, store: PortalStore):
        self.store = store
        self._sessions: dict[str, dict[str, dict[str, Any]]] = {}
        self._lock = threading.RLock()

    def create_session(self) -> dict[str, str]:
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._sessions[token] = {}
        return {"token": token}

    def preview_import(self, token: str, payload: object) -> dict[str, Any]:
        candidates = self._require_session(token)
        required = {
            "pluginRoot",
            "target",
            "expectedPluginId",
            "approvedRulePaths",
            "extensionTools",
        }
        if not isinstance(payload, dict) or set(payload) != required:
            raise ApiError("导入资料结构无效")
        if not isinstance(payload["pluginRoot"], str):
            raise ApiError("插件目录无效")
        try:
            snapshot = preview_plugin(
                Path(payload["pluginRoot"]),
                target=payload["target"],
                expected_plugin_id=payload["expectedPluginId"],
                approved_rule_paths=payload["approvedRulePaths"],
                extension_tools=payload["extensionTools"],
            )
        except (PluginReadError, TypeError) as error:
            raise ApiError(str(error), code="plugin_preview_failed") from None

        plugin_key = f"{snapshot['plugin']['target']}/{snapshot['plugin']['id']}"
        candidate_id = secrets.token_urlsafe(24)
        with self._lock:
            candidates[candidate_id] = {"pluginKey": plugin_key, "snapshot": deepcopy(snapshot)}
        return {"candidateId": candidate_id, "pluginKey": plugin_key, "snapshot": snapshot}

    def promote(self, token: str, plugin_key: str, payload: object) -> dict[str, Any]:
        candidates = self._require_session(token)
        body = self._mutation_body(payload, with_candidate=True)
        candidate = candidates.get(body["candidateId"])
        if candidate is None:
            raise ApiError("导入候选不存在或已失效", status=404, code="candidate_not_found")
        self._require_plugin_key(plugin_key)
        if candidate["pluginKey"] != plugin_key:
            raise ApiError("插件身份不一致", code="plugin_identity_mismatch")

        snapshot = candidate["snapshot"]
        try:
            snapshot_id = self.store.put_snapshot(plugin_key, snapshot)
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
