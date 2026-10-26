"""Lossless, temporary single-plugin view for the pinned external ZIP auditor.

This is not a distribution artifact. Every original file is copied once, unchanged;
the original ZIP remains the only downloadable candidate. Nested ZIPs stay opaque.
"""
from __future__ import annotations

import hashlib
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path

from .models import canonical_json_bytes
from .plugin_archive import MAX_OPAQUE_ZIP_BYTES, PluginArchiveError, has_marketplace_catalog, validate_archive


_ATTACHMENTS = ".portal-distribution"
_CHUNK_BYTES = 64 * 1024


def file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _set_sha256(value: dict) -> str:
    # Same canonical file-map representation used by the pinned ZIP auditor.
    return hashlib.sha256(canonical_json_bytes(value) + b"\n").hexdigest()


@dataclass(frozen=True)
class BundleInspection:
    plugin_root: str
    source_sha256: str
    source_bytes: int
    source_file_set_sha256: str
    inspection_sha256: str
    inspection_bytes: int
    inspection_file_set_sha256: str
    file_count: int
    mapping_sha256: str

    def evidence(self) -> dict:
        return {
            "schemaVersion": "1.0.0",
            "mapping": "plugin-root-and-opaque-attachments-v1",
            "pluginRoot": self.plugin_root,
            "attachmentPrefix": _ATTACHMENTS,
            "sourceSha256": self.source_sha256,
            "sourceBytes": self.source_bytes,
            "sourceFileSetSha256": self.source_file_set_sha256,
            "inspectionSha256": self.inspection_sha256,
            "inspectionBytes": self.inspection_bytes,
            "inspectionFileSetSha256": self.inspection_file_set_sha256,
            "fileCount": self.file_count,
            "mappingSha256": self.mapping_sha256,
        }


def build_bundle_inspection(path: Path, view_path: Path, *, plugin_id: str) -> BundleInspection | None:
    """Return None for legacy ZIPs; malformed bundles never fall back to legacy."""
    try:
        archive = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        # Keep the legacy auditor's existing invalid-ZIP error contract.
        return None
    with archive:
        if not has_marketplace_catalog(archive):
            return None
    # Hash the very bytes later parsed, not a separate path read while a ZIP handle
    # may still refer to an older, replaced file. This snapshot is never published.
    with tempfile.TemporaryFile(dir=view_path.parent) as frozen, path.open("rb") as source:
        digest = hashlib.sha256()
        copied = 0
        while chunk := source.read(_CHUNK_BYTES):
            copied += len(chunk)
            if copied > MAX_OPAQUE_ZIP_BYTES:
                raise PluginArchiveError("archive_unsafe", "完整发行包超过 128 MiB")
            frozen.write(chunk)
            digest.update(chunk)
        frozen.seek(0)
        with zipfile.ZipFile(frozen) as archive:
            return _build_view(archive, view_path, plugin_id=plugin_id, source_sha256=digest.hexdigest(), source_bytes=copied)


def _build_view(
    archive: zipfile.ZipFile, view_path: Path, *, plugin_id: str, source_sha256: str, source_bytes: int,
) -> BundleInspection:
    layout = validate_archive(archive)
    if layout.plugin_id != plugin_id:
        raise PluginArchiveError("archive_invalid", "发行包与当前插件身份不一致")
    original_files: dict[str, str] = {}
    inspected_files: dict[str, str] = {}
    mapping: dict[str, str] = {}
    # Reserve the adapter namespace even when a particular outer path does not collide.
    for entry in layout.entries:
        relative = entry.parts[len(layout.plugin_parts):]
        if layout.contains_plugin_entry(entry) and relative and relative[0].casefold() == _ATTACHMENTS:
            raise PluginArchiveError("archive_invalid", "发行包包含保留的审计目录")
    with zipfile.ZipFile(view_path, "x", zipfile.ZIP_STORED) as view:
        for entry in sorted(layout.entries, key=lambda entry: entry.parts):
            if entry.is_directory:
                continue  # Validated empty directory metadata is not a file or audit payload.
            original_name = "/".join(entry.parts)
            relative_name = (
                "/".join(entry.parts[len(layout.plugin_parts):])
                if layout.contains_plugin_entry(entry) else f"{_ATTACHMENTS}/{original_name}"
            )
            digest = hashlib.sha256()
            copied = 0
            with archive.open(entry.info) as source, view.open(f"{plugin_id}/{relative_name}", "w") as target:
                while chunk := source.read(_CHUNK_BYTES):
                    copied += len(chunk)
                    if copied > entry.info.file_size:
                        raise PluginArchiveError("archive_invalid", "发行包条目大小不一致")
                    target.write(chunk)
                    digest.update(chunk)
            if copied != entry.info.file_size:
                raise PluginArchiveError("archive_invalid", "发行包条目大小不一致")
            original_files[original_name] = digest.hexdigest()
            inspected_files[relative_name] = digest.hexdigest()
            mapping[original_name] = relative_name
    return BundleInspection(
        plugin_root="/".join(layout.plugin_parts), source_sha256=source_sha256,
        source_bytes=source_bytes, source_file_set_sha256=_set_sha256(original_files),
        inspection_sha256=file_sha256(view_path), inspection_bytes=view_path.stat().st_size,
        inspection_file_set_sha256=_set_sha256(inspected_files), file_count=len(original_files),
        mapping_sha256=_set_sha256(mapping),
    )
