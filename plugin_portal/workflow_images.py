"""Portal-owned raster assets. Staging is private; workflows are the read authority."""
from __future__ import annotations

import hashlib
import io
import math
import os
import re
import stat
import threading
import time
import warnings
from copy import deepcopy

from .models import parse_plugin_key
from .storage import PortalStore, StorageError

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_PIXELS = 20_000_000
MAX_STORED_BYTES = 40 * 1024 * 1024
MAX_STAGED_BYTES = 256 * 1024 * 1024
RETENTION_SECONDS = 24 * 60 * 60
INDEX = "workflow-images"
ASSET_ID = re.compile(r"^[0-9a-f]{64}$")
MIMES = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}
EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
_PROCESSING = threading.BoundedSemaphore(2)


class WorkflowImageError(ValueError):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.status = status


def load_pillow():
    # Lazy import: image processing is not a prerequisite for ordinary browsing.
    try:
        import PIL
        from PIL import Image, ImageOps
        if PIL.__version__ != "12.3.0":
            raise ImportError
        return Image, ImageOps
    except ImportError:
        raise WorkflowImageError("image_processing_unavailable", "图片处理不可用，请管理员检查图片依赖", 503) from None


def encode_image(payload: bytes, content_type: str):
    Image, ImageOps = load_pillow()
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(payload), formats=list(MIMES)) as header:
                fmt = header.format
                if MIMES.get(fmt) != content_type:
                    raise ValueError
                if header.width * header.height > MAX_PIXELS:
                    raise WorkflowImageError("image_too_large", "图片不得超过 2000 万像素", 413)
                header.verify()  # Decoding alone does not validate PNG chunk checksums.
            with Image.open(io.BytesIO(payload), formats=list(MIMES)) as source:
                if getattr(source, "n_frames", 1) != 1:
                    raise ValueError
                source.load()  # Do not accept a valid header with truncated pixel data.
                with ImageOps.exif_transpose(source) as oriented, oriented.convert("RGB" if fmt == "JPEG" else "RGBA") as clean:
                    clean.info.clear()
                    full = io.BytesIO()
                    clean.save(full, format=fmt, **({"quality": 95} if fmt == "JPEG" else {"lossless": True} if fmt == "WEBP" else {}))
                    with clean.copy() as thumbnail:
                        thumbnail.thumbnail((320, 320), Image.Resampling.LANCZOS)
                        thumb = io.BytesIO()
                        thumbnail.save(thumb, format="WEBP", lossless=True)
                    size = clean.size
    except WorkflowImageError:
        raise
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise WorkflowImageError("image_invalid", "仅支持完整的静态 PNG、JPEG 或 WebP 图片") from None
    if len(full.getvalue()) > MAX_STORED_BYTES:
        raise WorkflowImageError("image_too_large", "图片处理后过大，请缩小图片后重试", 413)
    return full.getvalue(), thumb.getvalue(), size


def references(plugins: dict) -> set[tuple[str, str]]:
    from .workflows import validate_workflow
    result = set()
    for key, workflow in plugins.items():
        validate_workflow(workflow, expected_plugin_key=key)
        for tab in workflow["tabs"]:
            for section in tab["sections"]:
                for step in section["steps"]:
                    result.update((key, image["assetId"]) for image in step.get("images", []))
    return result


class WorkflowImageStore:
    def __init__(self, store: PortalStore):
        self.store = store

    def _index(self):
        index = self.store.read_document(INDEX)
        entries = index["data"]
        if not isinstance(entries, dict):
            raise StorageError("图片索引无效")
        fields = {"pluginKey", "assetId", "contentType", "width", "height", "fullBytes", "thumbBytes", "thumbSha256", "unreferencedAt"}
        for key, entry in entries.items():
            if not isinstance(entry, dict) or set(entry) != fields:
                raise StorageError("图片索引无效")
            try:
                parse_plugin_key(entry["pluginKey"])
                valid = (ASSET_ID.fullmatch(entry["assetId"]) and ASSET_ID.fullmatch(entry["thumbSha256"])
                         and key == self._key(entry["pluginKey"], entry["assetId"])
                         and entry["contentType"] in EXTENSIONS
                         and all(type(entry[name]) is int and entry[name] > 0 for name in ("width", "height", "fullBytes", "thumbBytes"))
                         and entry["width"] * entry["height"] <= MAX_PIXELS
                         and entry["fullBytes"] <= MAX_STORED_BYTES and entry["thumbBytes"] <= MAX_STORED_BYTES
                         and (entry["unreferencedAt"] is None or type(entry["unreferencedAt"]) in (int, float)
                              and math.isfinite(entry["unreferencedAt"]) and entry["unreferencedAt"] >= 0))
            except (TypeError, ValueError):
                valid = False
            if not valid:
                raise StorageError("图片索引无效")
        return index

    @staticmethod
    def _key(plugin_key, asset_id):
        return f"{plugin_key}:{asset_id}"

    def _directory(self, plugin_key, asset_id, *, create=False):
        target, plugin_id = parse_plugin_key(plugin_key)
        if not isinstance(asset_id, str) or not ASSET_ID.fullmatch(asset_id):
            raise WorkflowImageError("image_not_found", "图片不存在", 404)
        path = self.store.root
        for part in (None, "workflow-images", target, plugin_id, asset_id):
            if part is not None:
                path = path / part
            if create:
                path.mkdir(exist_ok=True)
            try:
                info = os.lstat(path)
                if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                    raise OSError
            except OSError:
                raise StorageError("图片资产目录不可用") from None
        return path

    def require(self, plugin_key, asset_id):
        entry = self._index()["data"].get(self._key(plugin_key, asset_id))
        if entry is None:
            raise WorkflowImageError("image_not_found", "图片不存在或暂存已过期，请重新上传", 404)
        for variant in ("full", "thumb"):
            self._read(entry, variant)
        return entry

    def _read(self, entry, variant):
        if variant not in ("full", "thumb"):
            raise WorkflowImageError("image_not_found", "图片不存在", 404)
        mime = entry["contentType"] if variant == "full" else "image/webp"
        path = self._directory(entry["pluginKey"], entry["assetId"]) / f"{variant}.{EXTENSIONS[mime]}"
        try:
            info = os.lstat(path)
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400 or info.st_size != entry[f"{variant}Bytes"]:
                raise OSError
            payload = path.read_bytes()
        except OSError:
            raise StorageError("图片资产不存在或已损坏") from None
        digest = entry["assetId"] if variant == "full" else entry["thumbSha256"]
        if hashlib.sha256(payload).hexdigest() != digest:
            raise StorageError("图片资产校验失败")
        return mime, payload

    def stage(self, plugin_key, content_type, source, content_length):
        if content_type not in MIMES.values():
            raise WorkflowImageError("image_invalid", "仅支持 PNG、JPEG 或 WebP 图片")
        if type(content_length) is not int or not 0 < content_length <= MAX_UPLOAD_BYTES:
            raise WorkflowImageError("image_too_large", "单张图片不得超过 10 MiB", 413)
        if not _PROCESSING.acquire(blocking=False):
            raise WorkflowImageError("image_busy", "图片处理繁忙，请稍后重试", 429)
        try:
            payload = source.read(content_length)
            if len(payload) != content_length:
                raise WorkflowImageError("image_invalid", "图片上传不完整，请重试")
            full, thumb, (width, height) = encode_image(payload, content_type)
            asset_id = hashlib.sha256(full).hexdigest()
            with self.store._lock:
                self.cleanup()
                index = self._index()
                key = self._key(plugin_key, asset_id)
                if key in index["data"]:
                    existing = index["data"][key]
                    # A failed/ interrupted stage can leave a reserved entry and only
                    # one variant. Repair missing bytes, never overwrite different bytes.
                    directory = self._directory(plugin_key, asset_id, create=True)
                    for variant, data, mime in (("full", full, content_type), ("thumb", thumb, "image/webp")):
                        path = directory / f"{variant}.{EXTENSIONS[mime]}"
                        if not os.path.lexists(path):
                            digest = asset_id if variant == "full" else existing["thumbSha256"]
                            if hashlib.sha256(data).hexdigest() != digest or len(data) != existing[f"{variant}Bytes"]:
                                raise StorageError("图片资产校验失败")
                            self.store._atomic_write_bytes(path, data)
                        self._read(existing, variant)
                    if existing["unreferencedAt"] is not None:
                        index["data"][key]["unreferencedAt"] = time.time()
                        self.store.write_document(INDEX, index["data"], index["revision"])
                    return {"assetId": asset_id, "width": width, "height": height}
                used = sum(item["fullBytes"] + item["thumbBytes"] for item in index["data"].values() if item["unreferencedAt"] is not None)
                if used + len(full) + len(thumb) > MAX_STAGED_BYTES:
                    raise WorkflowImageError("image_staging_full", "图片暂存空间不足，请稍后重试", 429)
                entry = {"pluginKey": plugin_key, "assetId": asset_id, "contentType": content_type,
                         "width": width, "height": height, "fullBytes": len(full), "thumbBytes": len(thumb),
                         "thumbSha256": hashlib.sha256(thumb).hexdigest(), "unreferencedAt": time.time()}
                # Reserve before writing files: an interrupted upload remains tracked for cleanup.
                index["data"][key] = entry
                self.store.write_document(INDEX, index["data"], index["revision"])
                directory = self._directory(plugin_key, asset_id, create=True)
                self.store._atomic_write_bytes(directory / f"full.{EXTENSIONS[content_type]}", full)
                self.store._atomic_write_bytes(directory / "thumb.webp", thumb)
                self.require(plugin_key, asset_id)
                return {"assetId": asset_id, "width": width, "height": height}
        finally:
            _PROCESSING.release()

    def prepare_save(self, plugins, plugin_key):
        index = self._index()
        active = references(plugins)
        for key, asset_id in active:
            if key == plugin_key:
                self.require(key, asset_id)
        updated = deepcopy(index["data"])
        for entry in updated.values():
            if (entry["pluginKey"], entry["assetId"]) in active:
                entry["unreferencedAt"] = None
            elif entry["unreferencedAt"] is None:
                entry["unreferencedAt"] = time.time()
        return updated, index["revision"]

    def read_public(self, plugin_key, asset_id, variant):
        with self.store._lock:
            active = self._references()
            if (plugin_key, asset_id) not in active:
                raise WorkflowImageError("image_not_found", "图片不存在或尚未保存", 404)
            entry = self._index()["data"].get(self._key(plugin_key, asset_id))
            if entry is None:
                raise WorkflowImageError("image_not_found", "图片不存在", 404)
            return self._read(entry, variant)

    def _references(self):
        from .workflows import _stored_plugins
        return references(_stored_plugins(self.store.read_document("workflows")["data"]))

    def cleanup(self):
        with self.store._lock:
            index = self._index()
            active = self._references()
            changed = False
            for key, entry in list(index["data"].items()):
                if (entry["pluginKey"], entry["assetId"]) in active:
                    continue
                if entry["unreferencedAt"] is None:
                    entry["unreferencedAt"] = time.time()
                    changed = True
                elif time.time() - entry["unreferencedAt"] >= RETENTION_SECONDS:
                    # Never follow filesystem links, including on Windows. Delete only owned files.
                    directory = self.store.root / "workflow-images" / entry["pluginKey"] / entry["assetId"]
                    if directory.exists():
                        directory = self._directory(entry["pluginKey"], entry["assetId"])
                        expected = {f"full.{EXTENSIONS[entry['contentType']]}", "thumb.webp"}
                        for child in directory.iterdir():
                            info = os.lstat(child)
                            if child.name not in expected or not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                                raise StorageError("图片资产目录包含未知内容")
                        for child in directory.iterdir():
                            child.unlink()
                        directory.rmdir()
                    del index["data"][key]
                    changed = True
            if changed:
                self.store.write_document(INDEX, index["data"], index["revision"])
