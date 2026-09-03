from __future__ import annotations

import os
import secrets
import stat
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Callable


MAX_UPLOAD_BYTES = 128 * 1024 * 1024
MAX_ACTIVE_UPLOADS = 16
UPLOAD_TTL_SECONDS = 15 * 60
_CHUNK_BYTES = 64 * 1024
_REPARSE_POINT = 0x400
_UPLOAD_KINDS = frozenset({"plugin-import", "download-publication"})


class UploadError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class StagedUpload:
    upload_id: str
    session_token: str
    kind: str
    file_name: str
    path: Path
    size: int
    created_at: float


class UploadRegistry:
    def __init__(self, *, root: Path | str | None = None, clock: Callable[[], float] = time.monotonic):
        self._temporary = tempfile.TemporaryDirectory(prefix="plugin-portal-uploads-") if root is None else None
        self.root = Path(self._temporary.name if self._temporary is not None else root).absolute()
        self.root.mkdir(parents=True, exist_ok=True)
        info = os.lstat(self.root)
        if (
            not stat.S_ISDIR(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or bool(getattr(info, "st_file_attributes", 0) & _REPARSE_POINT)
        ):
            if self._temporary is not None:
                self._temporary.cleanup()
            raise UploadError("upload_storage_failed", "上傳暫存目錄無效")
        self._clock = clock
        self._uploads: dict[str, StagedUpload] = {}
        self._owners: dict[tuple[str, str], str] = {}
        self._lock = threading.RLock()
        self._closed = False

    def stage(
        self,
        session_token: str,
        kind: str,
        file_name: str,
        source: BinaryIO,
        content_length: int,
    ) -> StagedUpload:
        self._validate_request(session_token, kind, file_name, content_length)
        with self._lock:
            self._ensure_open()
            self._prune_locked()
            owner = (session_token, kind)
            previous_id = self._owners.get(owner)
            if previous_id is None and len(self._uploads) >= MAX_ACTIVE_UPLOADS:
                raise UploadError("upload_busy", "上傳暫存區目前已滿")

            upload_id = secrets.token_urlsafe(24)
            path = self.root / f"{upload_id}.zip"
            try:
                self._write_exact(path, source, content_length)
            except UploadError:
                self._unlink(path)
                raise
            except (OSError, TypeError, ValueError):
                self._unlink(path)
                raise UploadError("upload_storage_failed", "無法暫存上傳檔案") from None

            upload = StagedUpload(
                upload_id=upload_id,
                session_token=session_token,
                kind=kind,
                file_name=file_name,
                path=path,
                size=content_length,
                created_at=self._clock(),
            )
            if previous_id is not None:
                previous = self._uploads.get(previous_id)
                if previous is not None:
                    self._remove_locked(previous)
            self._uploads[upload_id] = upload
            self._owners[owner] = upload_id
            return upload

    def require(self, session_token: str, kind: str, upload_id: str) -> StagedUpload:
        with self._lock:
            self._ensure_open()
            self._prune_locked()
            upload = self._uploads.get(upload_id)
            if (
                upload is None
                or upload.session_token != session_token
                or upload.kind != kind
                or not self._is_owned_file(upload)
            ):
                if upload is not None and not self._is_owned_file(upload):
                    self._remove_locked(upload)
                raise UploadError("upload_not_found", "上傳檔案不存在或已失效")
            return upload

    def consume(self, session_token: str, kind: str, upload_id: str) -> StagedUpload:
        with self._lock:
            upload = self.require(session_token, kind, upload_id)
            self._remove_locked(upload)
            return upload

    def discard(self, session_token: str, kind: str, upload_id: str) -> None:
        with self._lock:
            upload = self.require(session_token, kind, upload_id)
            self._remove_locked(upload)

    def prune(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._prune_locked()

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            for upload in tuple(self._uploads.values()):
                self._remove_locked(upload)
            self._closed = True
            temporary = self._temporary
            self._temporary = None
        if temporary is not None:
            temporary.cleanup()

    def _validate_request(self, session_token: str, kind: str, file_name: str, content_length: int) -> None:
        if not isinstance(session_token, str) or not session_token or kind not in _UPLOAD_KINDS:
            raise UploadError("invalid_upload", "上傳要求無效")
        if (
            not isinstance(file_name, str)
            or not file_name
            or file_name != file_name.strip()
            or file_name in {".zip", ".."}
            or not file_name.lower().endswith(".zip")
            or "/" in file_name
            or "\\" in file_name
            or ":" in file_name
            or any(ord(character) < 32 or ord(character) == 127 for character in file_name)
            or len(file_name.encode("utf-8")) > 240
        ):
            raise UploadError("invalid_upload", "上傳檔名無效")
        if isinstance(content_length, bool) or not isinstance(content_length, int) or content_length <= 0:
            raise UploadError("invalid_upload", "Content-Length 無效")
        if content_length > MAX_UPLOAD_BYTES:
            raise UploadError("payload_too_large", "上傳檔案超過 128 MiB")

    def _write_exact(self, path: Path, source: BinaryIO, content_length: int) -> None:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_BINARY"):
            flags |= os.O_BINARY
        descriptor = os.open(path, flags, 0o600)
        remaining = content_length
        try:
            with os.fdopen(descriptor, "wb") as destination:
                while remaining:
                    chunk = source.read(min(_CHUNK_BYTES, remaining))
                    if not isinstance(chunk, (bytes, bytearray, memoryview)):
                        raise UploadError("upload_incomplete", "上傳資料未完整送達")
                    if not chunk:
                        raise UploadError("upload_incomplete", "上傳資料未完整送達")
                    if len(chunk) > remaining:
                        chunk = chunk[:remaining]
                    destination.write(chunk)
                    remaining -= len(chunk)
                destination.flush()
                os.fsync(destination.fileno())
        except BaseException:
            try:
                os.close(descriptor)
            except OSError:
                pass
            raise
        info = os.lstat(path)
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or bool(getattr(info, "st_file_attributes", 0) & _REPARSE_POINT)
            or info.st_size != content_length
        ):
            raise UploadError("upload_storage_failed", "上傳暫存檔案無效")

    def _prune_locked(self) -> None:
        cutoff = self._clock() - UPLOAD_TTL_SECONDS
        for upload in tuple(self._uploads.values()):
            if upload.created_at <= cutoff:
                self._remove_locked(upload)

    def _remove_locked(self, upload: StagedUpload) -> None:
        self._uploads.pop(upload.upload_id, None)
        owner = (upload.session_token, upload.kind)
        if self._owners.get(owner) == upload.upload_id:
            self._owners.pop(owner, None)
        self._unlink(upload.path)

    def _is_owned_file(self, upload: StagedUpload) -> bool:
        try:
            info = os.lstat(upload.path)
        except OSError:
            return False
        return (
            upload.path.parent == self.root
            and stat.S_ISREG(info.st_mode)
            and not stat.S_ISLNK(info.st_mode)
            and not bool(getattr(info, "st_file_attributes", 0) & _REPARSE_POINT)
            and info.st_size == upload.size
        )

    def _ensure_open(self) -> None:
        if self._closed:
            raise UploadError("upload_unavailable", "上傳暫存區已關閉")

    @staticmethod
    def _unlink(path: Path) -> None:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass
