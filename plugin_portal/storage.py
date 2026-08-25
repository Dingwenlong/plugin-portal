from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Any

from .models import (
    ModelValidationError,
    canonical_json_bytes,
    parse_plugin_key,
    validate_revisioned_document,
)


class StorageError(RuntimeError):
    """Raised when local Portal data cannot be safely read or written."""


class RevisionConflict(StorageError):
    """Raised when a stale page attempts to overwrite newer data."""


_DOCUMENT_NAME = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
_SNAPSHOT_ID = re.compile(r"^[0-9a-f]{64}$")
_LOCKS_GUARD = threading.Lock()
_LOCKS: dict[str, threading.RLock] = {}


def _lock_for(root: Path) -> threading.RLock:
    key = os.path.normcase(str(root))
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.RLock())


class PortalStore:
    def __init__(self, data_root: Path | str):
        self.root = Path(data_root).expanduser().absolute()
        self.root.mkdir(parents=True, exist_ok=True)
        if self.root.is_symlink() or not self.root.is_dir():
            raise StorageError("Portal 数据目录无效")
        self._lock = _lock_for(self.root)

    def _document_path(self, name: str) -> Path:
        if not isinstance(name, str) or not _DOCUMENT_NAME.fullmatch(name):
            raise StorageError("资料文件名称无效")
        return self.root / f"{name}.json"

    def read_document(self, name: str) -> dict[str, Any]:
        path = self._document_path(name)
        with self._lock:
            if not path.exists():
                return {"revision": 0, "data": {}}
            try:
                document = json.loads(path.read_text(encoding="utf-8"))
                return validate_revisioned_document(document)
            except (OSError, UnicodeError, json.JSONDecodeError, ModelValidationError) as error:
                raise StorageError("Portal 资料文件无效") from error

    def write_document(
        self,
        name: str,
        value: dict[str, Any],
        expected_revision: int,
    ) -> dict[str, Any]:
        if isinstance(expected_revision, bool) or not isinstance(expected_revision, int):
            raise StorageError("expected_revision 必须是整数")
        if not isinstance(value, dict):
            raise StorageError("Portal 资料必须是对象")

        path = self._document_path(name)
        with self._lock:
            current = self.read_document(name)
            if current["revision"] != expected_revision:
                raise RevisionConflict("资料已更新，请刷新后重试")
            document = {"revision": expected_revision + 1, "data": value}
            canonical_json_bytes(document)
            self._atomic_write_json(path, document)
            return document

    def put_snapshot(self, plugin_key: str, snapshot: dict[str, Any]) -> str:
        if not isinstance(snapshot, dict):
            raise StorageError("插件快照必须是对象")
        target, plugin_id = parse_plugin_key(plugin_key)
        payload = canonical_json_bytes(snapshot)
        digest = hashlib.sha256(payload).hexdigest()
        path = self.root / "snapshots" / target / plugin_id / f"{digest}.json"

        with self._lock:
            if path.exists():
                try:
                    existing = path.read_bytes().rstrip(b"\r\n")
                except OSError as error:
                    raise StorageError("无法读取既有插件快照") from error
                if existing != payload:
                    raise StorageError("插件快照摘要冲突")
                return digest
            self._atomic_write_json(path, snapshot)
        return digest

    def read_snapshot(self, plugin_key: str, snapshot_id: str) -> dict[str, Any]:
        target, plugin_id = parse_plugin_key(plugin_key)
        if not isinstance(snapshot_id, str) or not _SNAPSHOT_ID.fullmatch(snapshot_id):
            raise StorageError("插件快照 ID 无效")
        path = self.root / "snapshots" / target / plugin_id / f"{snapshot_id}.json"
        with self._lock:
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError) as error:
                raise StorageError("插件快照不存在或已损坏") from error
        if not isinstance(value, dict) or hashlib.sha256(canonical_json_bytes(value)).hexdigest() != snapshot_id:
            raise StorageError("插件快照内容与摘要不一致")
        return value

    def _atomic_write_json(self, path: Path, value: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = canonical_json_bytes(value) + b"\n"
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                dir=path.parent,
                prefix=f".{path.stem}.",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary_path = Path(temporary.name)
                temporary.write(payload)
                temporary.flush()
                os.fsync(temporary.fileno())
            os.replace(temporary_path, path)
        except OSError as error:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
            raise StorageError("Portal 资料写入失败") from error
