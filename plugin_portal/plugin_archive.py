from __future__ import annotations

import os
import json
import re
import shutil
import stat
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath


MAX_ARCHIVE_ENTRIES = 4096
MAX_TOTAL_BYTES = 256 * 1024 * 1024
MAX_ENTRY_BYTES = 32 * 1024 * 1024
MAX_OPAQUE_ZIP_BYTES = 128 * 1024 * 1024
MAX_COMPRESSION_RATIO = 100
_CHUNK_BYTES = 64 * 1024
_REPARSE_POINT = 0x400
_SUPPORTED_COMPRESSION = frozenset({zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED})
_WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:")
_WINDOWS_RESERVED = re.compile(r"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", re.IGNORECASE)
_CATALOG_SUFFIX = (".agents", "plugins", "marketplace.json")


class PluginArchiveError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class _Entry:
    info: zipfile.ZipInfo
    parts: tuple[str, ...]
    is_directory: bool


@dataclass(frozen=True)
class ArchiveLayout:
    entries: tuple[_Entry, ...]
    plugin_parts: tuple[str, ...]
    bundle: bool = False
    plugin_id: str | None = None
    marketplace: str | None = None

    def contains_plugin_entry(self, entry: _Entry) -> bool:
        return entry.parts[:len(self.plugin_parts)] == self.plugin_parts


def extract_plugin_archive(archive_path: Path, destination: Path) -> Path:
    return extract_plugin_archive_details(archive_path, destination)[0]


def extract_plugin_archive_details(archive_path: Path, destination: Path) -> tuple[Path, str | None]:
    archive_path = Path(archive_path).absolute()
    destination = Path(destination).absolute()
    _validate_endpoints(archive_path, destination)
    created_destination = False
    try:
        with zipfile.ZipFile(archive_path, "r") as archive:
            layout = validate_archive(archive)
            destination.mkdir(mode=0o700)
            created_destination = True
            # Distribution attachments are not preview content and are never unpacked.
            entries = [entry for entry in layout.entries if layout.contains_plugin_entry(entry)]
            _extract_entries(archive, entries, destination)
        return destination.joinpath(*layout.plugin_parts), layout.marketplace
    except PluginArchiveError:
        if created_destination:
            _cleanup(destination)
        raise
    except (OSError, RuntimeError, EOFError, NotImplementedError, zipfile.BadZipFile, zipfile.LargeZipFile):
        if created_destination:
            _cleanup(destination)
        raise PluginArchiveError("archive_invalid", "插件 ZIP 無法讀取") from None


def _validate_endpoints(archive_path: Path, destination: Path) -> None:
    try:
        archive_info = os.lstat(archive_path)
        parent_info = os.lstat(destination.parent)
    except OSError:
        raise PluginArchiveError("archive_invalid", "插件 ZIP 或暫存目錄不存在") from None
    if (
        not stat.S_ISREG(archive_info.st_mode)
        or stat.S_ISLNK(archive_info.st_mode)
        or bool(getattr(archive_info, "st_file_attributes", 0) & _REPARSE_POINT)
    ):
        raise PluginArchiveError("archive_unsafe", "插件 ZIP 檔案類型不安全")
    if (
        not destination.name
        or destination.exists()
        or not stat.S_ISDIR(parent_info.st_mode)
        or stat.S_ISLNK(parent_info.st_mode)
        or bool(getattr(parent_info, "st_file_attributes", 0) & _REPARSE_POINT)
    ):
        raise PluginArchiveError("archive_invalid", "解壓暫存目錄無效")


def has_marketplace_catalog(archive: zipfile.ZipFile) -> bool:
    return any(tuple(info.filename.split("/"))[-3:] == _CATALOG_SUFFIX for info in archive.infolist())


def validate_archive(archive: zipfile.ZipFile) -> ArchiveLayout:
    infos = archive.infolist()
    if not infos or len(infos) > MAX_ARCHIVE_ENTRIES:
        raise PluginArchiveError("archive_unsafe", "插件 ZIP 條目數量不安全")

    entries: list[_Entry] = []
    paths: dict[str, bool] = {}
    total_size = 0
    for info in infos:
        raw_name = info.orig_filename if isinstance(info.orig_filename, str) else info.filename
        parts, is_directory = _safe_parts(raw_name)
        key = "/".join(parts).casefold()
        if key in paths:
            raise PluginArchiveError("archive_unsafe", "插件 ZIP 包含重複路徑")
        paths[key] = is_directory
        # Defer the ordinary 32 MiB limit until the catalog identifies the plugin.
        _validate_entry_metadata(info, is_directory, max_bytes=MAX_OPAQUE_ZIP_BYTES)
        if not is_directory:
            total_size += info.file_size
            if total_size > MAX_TOTAL_BYTES:
                raise PluginArchiveError("archive_unsafe", "插件 ZIP 解壓大小過大")
        entries.append(_Entry(info=info, parts=parts, is_directory=is_directory))

    _validate_file_directory_conflicts(entries, paths)
    plugin_roots = {
        entry.parts[:-2]
        for entry in entries
        if not entry.is_directory and entry.parts[-2:] == (".codex-plugin", "plugin.json")
    }
    if len(plugin_roots) != 1:
        raise PluginArchiveError("archive_invalid", "插件 ZIP 必須包含唯一的插件根目錄")
    plugin_parts = next(iter(plugin_roots))
    catalogs = [entry for entry in entries if not entry.is_directory and entry.parts[-3:] == _CATALOG_SUFFIX]
    plugin_id = None
    marketplace = None
    asset_parts = ()
    if catalogs:
        if len(catalogs) != 1:
            raise PluginArchiveError("archive_invalid", "发行包必须包含唯一的市场配置")
        catalog = catalogs[0]
        plugin_id = _validate_catalog(archive, catalog, plugin_parts)
        marketplace = _read_json(archive, catalog.info.filename).get("name")
        if not isinstance(marketplace, str) or re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?", marketplace) is None:
            raise PluginArchiveError("archive_invalid", "发行包市场名称无效")
        # The supported distribution layout keeps opaque assets beside marketplace/.
        asset_parts = (*catalog.parts[:-4], "release-assets")
    else:
        if len(plugin_parts) > 1:
            raise PluginArchiveError("archive_invalid", "插件 ZIP 只能使用單一頂層包裝目錄")
        if plugin_parts and any(entry.parts[0] != plugin_parts[0] for entry in entries):
            raise PluginArchiveError("archive_invalid", "插件 ZIP 包裝目錄外包含額外檔案")
    layout = ArchiveLayout(tuple(entries), plugin_parts, bool(catalogs), plugin_id, marketplace)
    for entry in entries:
        if entry.info.file_size <= MAX_ENTRY_BYTES:
            continue
        opaque_asset = (
            layout.bundle and not layout.contains_plugin_entry(entry)
            and entry.parts[:-1] == asset_parts and entry.parts[-1].lower().endswith(".zip")
        )
        if not opaque_asset:
            raise PluginArchiveError("archive_unsafe", "插件 ZIP 單一檔案過大")
        # Check the attachment container, not its contents. Never extract or execute it.
        with archive.open(entry.info) as stream:
            if not zipfile.is_zipfile(stream):
                raise PluginArchiveError("archive_invalid", "发行包 ZIP 附件无效")
    return layout


def _read_json(archive: zipfile.ZipFile, name: str) -> dict:
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    try:
        info = archive.getinfo(name)
        if info.file_size > 1024 * 1024:
            raise ValueError("metadata too large")
        value = json.loads(archive.read(info).decode("utf-8-sig"), object_pairs_hook=unique_object)
        if not isinstance(value, dict):
            raise ValueError("not an object")
        return value
    except (KeyError, UnicodeError, ValueError, RecursionError):
        raise PluginArchiveError("archive_invalid", "发行包市场配置或插件清单无效") from None


def _validate_catalog(archive: zipfile.ZipFile, catalog: _Entry, plugin_parts: tuple[str, ...]) -> str:
    metadata = _read_json(archive, catalog.info.filename)
    plugins = metadata.get("plugins")
    if not isinstance(plugins, list) or len(plugins) != 1 or not isinstance(plugins[0], dict):
        raise PluginArchiveError("archive_invalid", "当前仅支持包含一个插件的完整发行包")
    item = plugins[0]
    source = item.get("source")
    if not isinstance(source, dict) or source.get("source") != "local":
        raise PluginArchiveError("archive_invalid", "发行包必须引用包内的本地插件")
    path = source.get("path")
    if not isinstance(path, str) or not path.startswith("./"):
        raise PluginArchiveError("archive_invalid", "市场插件路径必须以 ./ 开头")
    relative = () if path == "./" else _safe_parts(path[2:])[0]
    if (*catalog.parts[:-3], *relative) != plugin_parts:
        raise PluginArchiveError("archive_invalid", "市场配置与包内插件根目录不一致")
    manifest = _read_json(archive, "/".join((*plugin_parts, ".codex-plugin", "plugin.json")))
    plugin_id = item.get("name")
    if not isinstance(plugin_id, str) or manifest.get("name") != plugin_id:
        raise PluginArchiveError("archive_invalid", "市场配置与插件清单身份不一致")
    return plugin_id


def _safe_parts(name: str) -> tuple[tuple[str, ...], bool]:
    if (
        not isinstance(name, str)
        or not name
        or "\x00" in name
        or "\\" in name
        or name.startswith("/")
        or _WINDOWS_DRIVE.match(name)
    ):
        raise PluginArchiveError("archive_unsafe", "插件 ZIP 路徑不安全")
    is_directory = name.endswith("/")
    candidate = name[:-1] if is_directory else name
    raw_parts = candidate.split("/")
    if not candidate or any(
        part in {"", ".", ".."} or any(char in part for char in ':<>"|?*')
        or any(ord(char) < 32 for char in part) or part.endswith((".", " "))
        or _WINDOWS_RESERVED.match(part)
        for part in raw_parts
    ):
        raise PluginArchiveError("archive_unsafe", "插件 ZIP 路徑不安全")
    path = PurePosixPath(candidate)
    if path.is_absolute() or tuple(path.parts) != tuple(raw_parts):
        raise PluginArchiveError("archive_unsafe", "插件 ZIP 路徑不安全")
    return tuple(raw_parts), is_directory


def _validate_entry_metadata(info: zipfile.ZipInfo, is_directory: bool, *, max_bytes: int) -> None:
    if info.flag_bits & 0x1:
        raise PluginArchiveError("archive_unsafe", "插件 ZIP 不允許加密條目")
    if info.compress_type not in _SUPPORTED_COMPRESSION:
        raise PluginArchiveError("archive_unsafe", "插件 ZIP 使用不支援的壓縮方式")
    if info.file_size < 0 or info.compress_size < 0 or info.file_size > max_bytes:
        raise PluginArchiveError("archive_unsafe", "插件 ZIP 單一檔案過大")
    if info.file_size and (
        info.compress_size == 0 or info.file_size > info.compress_size * MAX_COMPRESSION_RATIO
    ):
        raise PluginArchiveError("archive_unsafe", "插件 ZIP 壓縮比例不安全")
    unix_mode = (info.external_attr >> 16) & 0xFFFF
    unix_type = stat.S_IFMT(unix_mode)
    if unix_type not in {0, stat.S_IFREG, stat.S_IFDIR}:
        raise PluginArchiveError("archive_unsafe", "插件 ZIP 包含連結或特殊檔案")
    if info.external_attr & _REPARSE_POINT:
        raise PluginArchiveError("archive_unsafe", "插件 ZIP 包含 reparse 條目")
    if is_directory and info.file_size != 0:
        raise PluginArchiveError("archive_unsafe", "插件 ZIP 目錄條目無效")


def _validate_file_directory_conflicts(entries: list[_Entry], paths: dict[str, bool]) -> None:
    for entry in entries:
        folded = [part.casefold() for part in entry.parts]
        for index in range(1, len(folded)):
            prefix = "/".join(folded[:index])
            if prefix in paths and not paths[prefix]:
                raise PluginArchiveError("archive_unsafe", "插件 ZIP 路徑類型衝突")
        if not entry.is_directory:
            prefix = "/".join(folded) + "/"
            if any(other.startswith(prefix) for other in paths):
                raise PluginArchiveError("archive_unsafe", "插件 ZIP 路徑類型衝突")


def _extract_entries(archive: zipfile.ZipFile, entries: list[_Entry], destination: Path) -> None:
    for entry in entries:
        output = destination.joinpath(*entry.parts)
        if entry.is_directory:
            output.mkdir(mode=0o700, parents=True, exist_ok=True)
            continue
        output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_BINARY"):
            flags |= os.O_BINARY
        descriptor = os.open(output, flags, 0o600)
        copied = 0
        try:
            with archive.open(entry.info, "r") as source, os.fdopen(descriptor, "wb") as target:
                while True:
                    chunk = source.read(_CHUNK_BYTES)
                    if not chunk:
                        break
                    copied += len(chunk)
                    if copied > entry.info.file_size:
                        raise PluginArchiveError("archive_invalid", "插件 ZIP 條目大小不一致")
                    target.write(chunk)
                target.flush()
                os.fsync(target.fileno())
        except BaseException:
            try:
                os.close(descriptor)
            except OSError:
                pass
            raise
        if copied != entry.info.file_size:
            raise PluginArchiveError("archive_invalid", "插件 ZIP 條目大小不一致")


def _cleanup(destination: Path) -> None:
    try:
        info = os.lstat(destination)
        if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
            shutil.rmtree(destination)
    except OSError:
        pass
