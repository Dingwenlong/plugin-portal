"""Portal-owned, read-only publication checks. No installed tools or plugin code run."""
from __future__ import annotations

import hashlib
import re
import stat
import tempfile
import zipfile
from pathlib import Path

from .download_publication import DownloadPublicationError, PluginReleaseAudit
from .models import ModelValidationError, canonical_json_bytes, parse_plugin_key
from .plugin_archive import (
    MAX_OPAQUE_ZIP_BYTES, PluginArchiveError, _read_json, _safe_parts, validate_archive,
)


AUDIT_VERSION = "1.0.0"
_SHA256 = re.compile(r"[0-9a-f]{64}")
_NUMBER = r"(?:0|[1-9][0-9]*)"
_PRERELEASE = r"(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
_VERSION = re.compile(rf"{_NUMBER}\.{_NUMBER}\.{_NUMBER}(?:-{_PRERELEASE}(?:\.{_PRERELEASE})*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?")
_PRIVATE_NAMES = {".env", "auth.json", "credentials.json", "secrets.json", "id_rsa", "id_ed25519"}
_PRIVATE_SUFFIXES = (".key", ".p12", ".pfx")
_ENV_TEMPLATE_NAMES = {".env.example", ".env.template"}
_EMPTY_ENV = re.compile(r"(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:\"\"|'')?\s*(?:#.*)?")
_SECRET_PATTERNS = (
    re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(rb"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(rb"gh[opsu]_[A-Za-z0-9]{20,}"),
    re.compile(rb"sk-[A-Za-z0-9]{20,}"),
)
_CHUNK_BYTES = 64 * 1024


def _reject(message: str) -> None:
    raise DownloadPublicationError("candidate_rejected", message)


def _hash_entry(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> str:
    # Inspect all outer files, including distribution attachments, without expanding
    # nested archives. A short overlap also detects secrets across read boundaries.
    name = info.filename.rsplit("/", 1)[-1].casefold()
    template = name in _ENV_TEMPLATE_NAMES
    if not template and (name in _PRIVATE_NAMES or name.startswith(".env.") or name.endswith(_PRIVATE_SUFFIXES)):
        _reject("候选包含私有资料")
    digest = hashlib.sha256()
    copied = 0
    tail = b""
    template_data = bytearray()
    with archive.open(info) as source:
        while chunk := source.read(_CHUNK_BYTES):
            copied += len(chunk)
            if copied > info.file_size:
                _reject("插件 ZIP 条目大小不一致")
            scanned = tail + chunk
            if any(pattern.search(scanned) for pattern in _SECRET_PATTERNS):
                _reject("候选包含私有资料")
            tail = scanned[-128:]
            digest.update(chunk)
            if template:
                template_data.extend(chunk)
    if copied != info.file_size:
        _reject("插件 ZIP 条目大小不一致")
    if template:
        try:
            lines = template_data.decode("utf-8-sig").splitlines()
        except UnicodeError:
            _reject("候选包含私有资料")
        if any(line.strip() and not line.lstrip().startswith("#") and not _EMPTY_ENV.fullmatch(line.strip()) for line in lines):
            _reject("候选包含私有资料")
    return digest.hexdigest()


def _validate_resources(manifest: dict, files: dict[str, str]) -> None:
    def resource(value: object, *, directory: bool = False) -> None:
        if not isinstance(value, str) or not value:
            _reject("插件清单资源路径无效")
        if directory and value in {".", "./"}:
            return
        parts, _ = _safe_parts(value.removeprefix("./"))
        relative = "/".join(parts)
        if relative not in files and not (directory and any(name.startswith(relative + "/") for name in files)):
            _reject("插件清单声明的资源不在 ZIP 中")

    if "skills" in manifest:
        resource(manifest["skills"], directory=True)
    interface = manifest.get("interface", {})
    if not isinstance(interface, dict):
        _reject("插件清单 interface 必须是对象")
    for field in ("composerIcon", "logo", "logoDark"):
        if field in interface:
            resource(interface[field])


class PortalArchiveAuditor:
    """Audit a frozen copy of the original ZIP with Portal's bounded ZIP reader.

    Core file-set hashes use paths relative to the plugin root. Distribution hashes
    cover every original archive file, including the catalog and opaque attachments.
    These are format/privacy checks, not publisher signatures or code execution tests.
    """

    def audit(self, path: Path, *, plugin_id: str, target: str, expected_sha256: str) -> PluginReleaseAudit:
        if not isinstance(expected_sha256, str) or not _SHA256.fullmatch(expected_sha256):
            raise DownloadPublicationError("audit_contract_invalid", "候选摘要无效")
        try:
            parse_plugin_key(f"{target}/{plugin_id}")
        except ModelValidationError:
            raise DownloadPublicationError("candidate_identity_mismatch", "插件身份无效") from None
        path = Path(path).absolute()
        try:
            for component in (path, *path.parents):
                info = component.lstat()
                if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                    _reject("插件 ZIP 路径包含链接")
            if not stat.S_ISREG(path.lstat().st_mode):
                _reject("插件 ZIP 文件类型不安全")
            with path.open("rb") as source, tempfile.TemporaryFile() as frozen:
                digest = hashlib.sha256()
                size = 0
                while chunk := source.read(_CHUNK_BYTES):
                    size += len(chunk)
                    if size > MAX_OPAQUE_ZIP_BYTES:
                        _reject("候选 ZIP 超过 128 MiB")
                    digest.update(chunk)
                    frozen.write(chunk)
                if digest.hexdigest() != expected_sha256:
                    raise DownloadPublicationError("candidate_changed", "候选在校验前已改变")
                frozen.seek(0)
                with zipfile.ZipFile(frozen) as archive:
                    audit = self._inspect(archive, plugin_id, target, expected_sha256, size)
            # Publication rechecks identity and hash again before exposing any bytes.
            with path.open("rb") as source:
                if hashlib.file_digest(source, "sha256").hexdigest() != expected_sha256:
                    raise DownloadPublicationError("candidate_changed", "候选在校验期间已改变")
            return audit
        except PluginArchiveError as error:
            _reject(str(error))
        except (OSError, RuntimeError, EOFError, ValueError, NotImplementedError, zipfile.BadZipFile, zipfile.LargeZipFile) as error:
            if isinstance(error, DownloadPublicationError):
                raise
            _reject("插件 ZIP 无法读取或校验")

    @staticmethod
    def _inspect(archive: zipfile.ZipFile, plugin_id: str, target: str, digest: str, size: int) -> PluginReleaseAudit:
        layout = validate_archive(archive)
        manifest_path = "/".join((*layout.plugin_parts, ".codex-plugin", "plugin.json"))
        manifest = _read_json(archive, manifest_path)
        if manifest.get("name") != plugin_id or (not layout.bundle and layout.plugin_parts not in {(), (plugin_id,)}):
            raise DownloadPublicationError("candidate_identity_mismatch", "候选与当前插件身份不一致")
        version = manifest.get("version")
        if not isinstance(version, str) or not _VERSION.fullmatch(version):
            _reject("插件版本不是严格 SemVer")
        author = manifest.get("author")
        if (not isinstance(manifest.get("description"), str) or not manifest["description"].strip()
                or not isinstance(author, dict) or not isinstance(author.get("name"), str) or not author["name"].strip()):
            _reject("插件清单缺少描述或作者")
        if layout.bundle:
            catalog = next(entry for entry in layout.entries if entry.parts[-3:] == (".agents", "plugins", "marketplace.json") and not entry.is_directory)
            if _read_json(archive, catalog.info.filename).get("name") != target:
                raise DownloadPublicationError("candidate_identity_mismatch", "发行包市场与纳入目标不一致")
        all_files: dict[str, str] = {}
        plugin_files: dict[str, str] = {}
        for entry in layout.entries:
            if entry.is_directory:
                continue
            file_digest = _hash_entry(archive, entry.info)
            all_files["/".join(entry.parts)] = file_digest
            if layout.contains_plugin_entry(entry):
                plugin_files["/".join(entry.parts[len(layout.plugin_parts):])] = file_digest
        _validate_resources(manifest, plugin_files)
        files = all_files if layout.bundle else plugin_files
        return PluginReleaseAudit(
            plugin_id=plugin_id, target=target, version=version, candidate_sha256=digest,
            file_set_sha256=hashlib.sha256(canonical_json_bytes(files) + b"\n").hexdigest(),
            file_count=len(files), archive_bytes=size, tool_version=AUDIT_VERSION,
            status="audited", warnings=(), tool_name="portal-archive",
        )
