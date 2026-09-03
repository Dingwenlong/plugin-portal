from __future__ import annotations

import json
import hashlib
import http.client
import os
import re
import stat
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Protocol

from .models import ModelValidationError, canonical_json_bytes, parse_plugin_key


_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_VERSION = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
_REPARSE_POINT = 0x400
_MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
_WARNING_MESSAGES = {
    "marketplace-source": "市场源码与候选不一致",
    "installed-candidate-parity": "本机已安装字节与候选不一致",
    "native-readback": "Codex 插件状态回读失败",
}
_DIAGNOSE_ERROR_MESSAGES = {
    "private_material_detected": "候选包含私有资料",
}
_DOWNLOAD_FILE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*\.zip$")


class DownloadPublicationError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class PluginReleaseAudit:
    plugin_id: str
    target: str
    version: str
    candidate_sha256: str
    file_set_sha256: str
    file_count: int
    archive_bytes: int
    tool_version: str
    status: str
    warnings: tuple[str, ...]


class CandidateAuditor(Protocol):
    def audit(
        self,
        path: Path,
        *,
        plugin_id: str,
        target: str,
        expected_sha256: str,
    ) -> PluginReleaseAudit: ...


@dataclass(frozen=True)
class PublicationCandidate:
    plugin_key: str
    target: str
    plugin_id: str
    expected_version: str
    source_path: Path
    source_name: str
    source_identity: tuple[int, int, int, int]
    destination_file_name: str
    audit: PluginReleaseAudit

    def public_preview(self) -> dict[str, Any]:
        return {
            "pluginKey": self.plugin_key,
            "version": self.audit.version,
            "fileName": self.source_name,
            "destinationFileName": self.destination_file_name,
            "candidateSha256": self.audit.candidate_sha256,
            "fileSetSha256": self.audit.file_set_sha256,
            "fileCount": self.audit.file_count,
            "archiveBytes": self.audit.archive_bytes,
            "auditToolVersion": self.audit.tool_version,
            "warnings": list(self.audit.warnings),
        }


@dataclass(frozen=True)
class PublicationReceipt:
    plugin_key: str
    version: str
    file_name: str
    candidate_sha256: str
    archive_bytes: int
    published_at_utc: str

    def public_result(self) -> dict[str, Any]:
        return {
            "pluginKey": self.plugin_key,
            "version": self.version,
            "fileName": self.file_name,
            "candidateSha256": self.candidate_sha256,
            "archiveBytes": self.archive_bytes,
            "publishedAtUtc": self.published_at_utc,
        }


class DownloadPublisher:
    def __init__(
        self,
        *,
        download_root: Path | str,
        receipt_root: Path | str,
        auditor: CandidateAuditor,
        download_reader: Callable[[str], tuple[int, str]],
    ):
        self.download_root = Path(download_root).absolute()
        self.receipt_root = Path(receipt_root).absolute()
        self.auditor = auditor
        self.download_reader = download_reader

    def preview(
        self,
        path: Path | str,
        *,
        plugin_key: str,
        expected_version: str,
    ) -> PublicationCandidate:
        source = Path(path).absolute()
        try:
            target, plugin_id = parse_plugin_key(plugin_key)
        except ModelValidationError:
            raise DownloadPublicationError("candidate_identity_mismatch", "插件身份无效") from None
        if not isinstance(expected_version, str) or _VERSION.fullmatch(expected_version) is None:
            raise DownloadPublicationError("candidate_identity_mismatch", "插件版本无效")
        if source.suffix.lower() != ".zip":
            raise DownloadPublicationError("candidate_invalid", "请选择 ZIP 候选")
        info = self._ordinary_file_info(source)
        if info is None or info.st_size <= 0:
            raise DownloadPublicationError("candidate_invalid", "候选 ZIP 不存在或无效")
        if info.st_size > _MAX_ARCHIVE_BYTES:
            raise DownloadPublicationError("candidate_too_large", "候选 ZIP 超过 128 MiB")
        digest = self._sha256(source)
        audit = self.auditor.audit(
            source,
            plugin_id=plugin_id,
            target=target,
            expected_sha256=digest,
        )
        if (
            audit.plugin_id != plugin_id
            or audit.target != target
            or audit.version != expected_version
            or audit.candidate_sha256 != digest
            or audit.archive_bytes != info.st_size
        ):
            raise DownloadPublicationError("candidate_identity_mismatch", "候选与当前插件身份或版本不一致")
        return PublicationCandidate(
            plugin_key=plugin_key,
            target=target,
            plugin_id=plugin_id,
            expected_version=expected_version,
            source_path=source,
            source_name=source.name,
            source_identity=self._identity(info),
            destination_file_name=f"{plugin_id}-{expected_version}-{target}.zip",
            audit=audit,
        )

    def publish(self, candidate: PublicationCandidate) -> PublicationReceipt:
        if not isinstance(candidate, PublicationCandidate):
            raise DownloadPublicationError("publication_invalid", "发布候选无效")
        if self._ordinary_directory_info(self.download_root) is None:
            raise DownloadPublicationError("download_root_unavailable", "下载目录不可用")
        destination = self.download_root / candidate.destination_file_name
        if destination.exists() or os.path.lexists(destination):
            raise DownloadPublicationError("destination_exists", "相同版本的下载文件已存在")

        source_info = self._ordinary_file_info(candidate.source_path)
        if source_info is None or self._identity(source_info) != candidate.source_identity:
            raise DownloadPublicationError("candidate_changed", "候选在确认前已改变")

        stage: Path | None = None
        try:
            with candidate.source_path.open("rb") as source, tempfile.NamedTemporaryFile(
                mode="wb",
                dir=self.download_root,
                prefix=f".{candidate.plugin_id}.",
                suffix=".partial",
                delete=False,
            ) as temporary:
                stage = Path(temporary.name)
                if self._identity(os.fstat(source.fileno())) != candidate.source_identity:
                    raise DownloadPublicationError("candidate_changed", "候选在确认前已改变")
                digest = hashlib.sha256()
                copied = 0
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    temporary.write(chunk)
                    digest.update(chunk)
                    copied += len(chunk)
                temporary.flush()
                os.fsync(temporary.fileno())

            source_info = self._ordinary_file_info(candidate.source_path)
            if (
                source_info is None
                or self._identity(source_info) != candidate.source_identity
                or copied != candidate.audit.archive_bytes
                or digest.hexdigest() != candidate.audit.candidate_sha256
            ):
                raise DownloadPublicationError("candidate_changed", "候选在确认前已改变")

            try:
                os.link(stage, destination)
            except FileExistsError:
                raise DownloadPublicationError("destination_exists", "相同版本的下载文件已存在") from None
            except OSError:
                raise DownloadPublicationError("publication_failed", "无法原子发布下载文件") from None
            stage.unlink(missing_ok=True)
            stage = None

            try:
                readback_bytes, readback_sha256 = self.download_reader(candidate.destination_file_name)
            except Exception:
                self._quarantine_and_confirm(destination, candidate.destination_file_name)
                raise DownloadPublicationError("download_readback_failed", "9134 下载回读失败") from None
            if (
                readback_bytes != candidate.audit.archive_bytes
                or readback_sha256 != candidate.audit.candidate_sha256
            ):
                self._quarantine_and_confirm(destination, candidate.destination_file_name)
                raise DownloadPublicationError("download_readback_failed", "9134 下载回读与候选不一致")

            published_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            receipt = PublicationReceipt(
                plugin_key=candidate.plugin_key,
                version=candidate.audit.version,
                file_name=candidate.destination_file_name,
                candidate_sha256=candidate.audit.candidate_sha256,
                archive_bytes=candidate.audit.archive_bytes,
                published_at_utc=published_at,
            )
            try:
                self._write_receipt(candidate, receipt)
            except OSError:
                self._quarantine_and_confirm(destination, candidate.destination_file_name)
                raise DownloadPublicationError("publication_receipt_failed", "发布回执写入失败") from None
            return receipt
        finally:
            if stage is not None:
                stage.unlink(missing_ok=True)

    def _write_receipt(self, candidate: PublicationCandidate, receipt: PublicationReceipt) -> None:
        self.receipt_root.mkdir(parents=True, exist_ok=True)
        if self._ordinary_directory_info(self.receipt_root) is None:
            raise OSError("receipt root is not an ordinary directory")
        payload = {
            "schemaVersion": "1.0.0",
            "status": "published",
            "pluginKey": candidate.plugin_key,
            "target": candidate.target,
            "pluginId": candidate.plugin_id,
            "version": candidate.audit.version,
            "fileName": candidate.destination_file_name,
            "candidateSha256": candidate.audit.candidate_sha256,
            "fileSetSha256": candidate.audit.file_set_sha256,
            "fileCount": candidate.audit.file_count,
            "archiveBytes": candidate.audit.archive_bytes,
            "auditToolVersion": candidate.audit.tool_version,
            "auditStatus": candidate.audit.status,
            "warnings": list(candidate.audit.warnings),
            "publishedAtUtc": receipt.published_at_utc,
        }
        path = self.receipt_root / f"{uuid.uuid4().hex}.json"
        try:
            with path.open("xb") as stream:
                stream.write(canonical_json_bytes(payload) + b"\n")
                stream.flush()
                os.fsync(stream.fileno())
        except OSError:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
            raise

    def _quarantine_and_confirm(self, destination: Path, file_name: str) -> None:
        self._quarantine(destination)
        try:
            self.download_reader(file_name)
        except Exception:
            return
        raise DownloadPublicationError("download_quarantine_failed", "无法隔离失败的下载文件")

    def _quarantine(self, destination: Path) -> None:
        quarantine = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.quarantine")
        try:
            os.replace(destination, quarantine)
        except OSError:
            try:
                destination.unlink(missing_ok=True)
            except OSError:
                raise DownloadPublicationError("download_quarantine_failed", "无法隔离失败的下载文件") from None
        if destination.exists() or os.path.lexists(destination):
            raise DownloadPublicationError("download_quarantine_failed", "无法隔离失败的下载文件")

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        try:
            with path.open("rb") as stream:
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
        except OSError:
            raise DownloadPublicationError("candidate_invalid", "无法读取候选 ZIP") from None
        return digest.hexdigest()

    @staticmethod
    def _identity(info: os.stat_result) -> tuple[int, int, int, int]:
        return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns

    @staticmethod
    def _ordinary_file_info(path: Path) -> os.stat_result | None:
        try:
            info = os.lstat(path)
        except OSError:
            return None
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or (
            getattr(info, "st_file_attributes", 0) & _REPARSE_POINT
        ):
            return None
        return info

    @staticmethod
    def _ordinary_directory_info(path: Path) -> os.stat_result | None:
        try:
            info = os.lstat(path)
        except OSError:
            return None
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or (
            getattr(info, "st_file_attributes", 0) & _REPARSE_POINT
        ):
            return None
        return info


def read_9134_download(file_name: str) -> tuple[int, str]:
    if not isinstance(file_name, str) or _DOWNLOAD_FILE_NAME.fullmatch(file_name) is None:
        raise ValueError("下载文件名无效")
    path = f"/downloads/{file_name}"
    expected_length = _read_9134_response(path, head_only=True)[0]
    length, digest = _read_9134_response(path, head_only=False)
    if length != expected_length or digest is None:
        raise ValueError("下载回读不一致")
    return length, digest


def _read_9134_response(path: str, *, head_only: bool) -> tuple[int, str | None]:
    connection = http.client.HTTPConnection("127.0.0.1", 9134, timeout=15)
    try:
        connection.request("HEAD" if head_only else "GET", path, headers={"Accept": "application/zip"})
        response = connection.getresponse()
        mime = response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
        raw_length = response.getheader("Content-Length", "")
        if (
            response.status != 200
            or mime not in {"application/zip", "application/x-zip-compressed"}
            or not raw_length.isascii()
            or not raw_length.isdigit()
            or not 0 < int(raw_length) <= _MAX_ARCHIVE_BYTES
            or response.getheader("Transfer-Encoding")
            or response.getheader("Content-Encoding")
        ):
            raise ValueError("下载服务回应无效")
        length = int(raw_length)
        if head_only:
            response.read()
            return length, None
        digest = hashlib.sha256()
        received = 0
        while True:
            chunk = response.read(min(1024 * 1024, length + 1 - received))
            if not chunk:
                break
            received += len(chunk)
            if received > length:
                raise ValueError("下载内容长度无效")
            digest.update(chunk)
        if received != length:
            raise ValueError("下载内容不完整")
        return length, digest.hexdigest()
    finally:
        connection.close()


class PluginReleaseAuditor:
    def __init__(
        self,
        *,
        codex_home: Path | str | None = None,
        codex_command: tuple[str, ...] = ("codex",),
        python_executable: str = sys.executable,
    ):
        home = Path(codex_home) if codex_home is not None else Path(
            os.environ.get("CODEX_HOME", Path.home() / ".codex")
        )
        self.codex_home = home.expanduser().absolute()
        self.codex_command = codex_command
        self.python_executable = python_executable

    def audit(
        self,
        path: Path,
        *,
        plugin_id: str,
        target: str,
        expected_sha256: str,
    ) -> PluginReleaseAudit:
        if not _SHA256.fullmatch(expected_sha256):
            raise DownloadPublicationError("audit_contract_invalid", "候选摘要无效")
        version, script = self._resolve_script()
        command = [
            self.python_executable,
            "-X",
            "utf8",
            "-B",
            str(script),
            "diagnose",
            "--candidate",
            str(path),
            "--plugin-id",
            plugin_id,
            "--target",
            target,
            "--codex-home",
            str(self.codex_home),
            "--expected-candidate-sha256",
            expected_sha256,
        ]
        completed = self._run(command, timeout=120)
        if completed.returncode != 0:
            raise DownloadPublicationError(
                "candidate_rejected",
                self._diagnose_error_message(completed.stderr),
            )
        payload = self._json_object(completed.stdout, "audit_contract_invalid")
        return self._parse_audit(
            payload,
            plugin_id=plugin_id,
            target=target,
            expected_sha256=expected_sha256,
            expected_tool_version=version,
        )

    def _resolve_script(self) -> tuple[str, Path]:
        command = [*self.codex_command, "plugin", "list", "--marketplace", "company-dev", "--json"]
        completed = self._run(command, timeout=30)
        if completed.returncode != 0:
            raise DownloadPublicationError("plugin_release_unavailable", "无法确认 Plugin Release 状态")
        try:
            payload = self._json_object(completed.stdout, "plugin_release_unavailable")
        except DownloadPublicationError:
            raise DownloadPublicationError("plugin_release_unavailable", "无法确认 Plugin Release 状态") from None
        installed = payload.get("installed")
        if not isinstance(installed, list):
            raise DownloadPublicationError("plugin_release_unavailable", "无法确认 Plugin Release 状态")
        matches = [
            item
            for item in installed
            if isinstance(item, dict)
            and item.get("pluginId") == "plugin-release@company-dev"
            and item.get("name") == "plugin-release"
            and item.get("marketplaceName") == "company-dev"
            and item.get("installed") is True
            and item.get("enabled") is True
            and isinstance(item.get("version"), str)
            and _VERSION.fullmatch(item["version"])
        ]
        if len(matches) != 1:
            raise DownloadPublicationError("plugin_release_unavailable", "Plugin Release 未安装或未启用")
        version = matches[0]["version"]
        root = self.codex_home / "plugins" / "cache" / "company-dev" / "plugin-release" / version
        manifest = root / ".codex-plugin" / "plugin.json"
        script = root / "scripts" / "release.py"
        if not self._ordinary_directory(root) or not self._ordinary_file(manifest) or not self._ordinary_file(script):
            raise DownloadPublicationError("plugin_release_unavailable", "Plugin Release 安装缓存不可用")
        try:
            metadata = json.loads(manifest.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            raise DownloadPublicationError("plugin_release_unavailable", "Plugin Release 安装缓存无效") from None
        if not isinstance(metadata, dict) or metadata.get("name") != "plugin-release" or metadata.get("version") != version:
            raise DownloadPublicationError("plugin_release_unavailable", "Plugin Release 安装身份不一致")
        return version, script

    def _run(self, command: list[str], *, timeout: int) -> subprocess.CompletedProcess[str]:
        environment = dict(os.environ)
        environment["CODEX_HOME"] = str(self.codex_home)
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        try:
            return subprocess.run(
                command,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="strict",
                timeout=timeout,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                check=False,
                env=environment,
            )
        except (OSError, subprocess.SubprocessError, UnicodeError):
            raise DownloadPublicationError("plugin_release_unavailable", "Plugin Release 无法执行") from None

    @staticmethod
    def _json_object(value: str, code: str) -> dict[str, Any]:
        try:
            payload = json.loads(value)
        except (TypeError, json.JSONDecodeError):
            raise DownloadPublicationError(code, "Plugin Release 回应无效") from None
        if not isinstance(payload, dict):
            raise DownloadPublicationError(code, "Plugin Release 回应无效")
        return payload

    @staticmethod
    def _diagnose_error_message(stderr: str) -> str:
        try:
            payload = json.loads(stderr)
            error = payload.get("error") if isinstance(payload, dict) else None
            code = error.get("code") if isinstance(error, dict) else None
        except (TypeError, json.JSONDecodeError):
            code = None
        if not isinstance(code, str):
            code = None
        return _DIAGNOSE_ERROR_MESSAGES.get(code, "Plugin Release 拒绝候选 ZIP")

    @staticmethod
    def _parse_audit(
        payload: dict[str, Any],
        *,
        plugin_id: str,
        target: str,
        expected_sha256: str,
        expected_tool_version: str,
    ) -> PluginReleaseAudit:
        candidate = payload.get("candidate")
        checks = payload.get("checks")
        valid_header = (
            payload.get("schemaVersion") == "1.0.0"
            and payload.get("tool") == "plugin-release"
            and payload.get("toolVersion") == expected_tool_version
            and payload.get("operation") == "diagnose"
            and payload.get("status") in {"audited", "issues_found"}
            and payload.get("pluginId") == plugin_id
            and payload.get("target") == target
            and payload.get("releaseKey") == f"{target}/{plugin_id}"
            and payload.get("writesPerformed") is False
        )
        if not valid_header or not isinstance(candidate, dict) or not isinstance(checks, list):
            raise DownloadPublicationError("audit_contract_invalid", "Plugin Release 审计契约无效")
        candidate_check = [
            check for check in checks if isinstance(check, dict) and check.get("name") == "candidate"
        ]
        version = candidate.get("version")
        file_set_sha256 = candidate.get("fileSetSha256")
        file_count = candidate.get("fileCount")
        archive_bytes = candidate.get("archiveBytes")
        valid_candidate = (
            len(candidate_check) == 1
            and candidate_check[0].get("status") == "passed"
            and candidate.get("pluginId") == plugin_id
            and candidate.get("candidateSha256") == expected_sha256
            and isinstance(version, str)
            and _VERSION.fullmatch(version) is not None
            and isinstance(file_set_sha256, str)
            and _SHA256.fullmatch(file_set_sha256) is not None
            and isinstance(file_count, int)
            and not isinstance(file_count, bool)
            and file_count >= 0
            and isinstance(archive_bytes, int)
            and not isinstance(archive_bytes, bool)
            and archive_bytes > 0
        )
        if not valid_candidate:
            raise DownloadPublicationError("audit_contract_invalid", "Plugin Release 候选审计无效")
        warnings = [
            _WARNING_MESSAGES[check["name"]]
            for check in checks
            if isinstance(check, dict)
            and check.get("name") in _WARNING_MESSAGES
            and check.get("status") == "failed"
        ]
        if any(
            isinstance(check, dict)
            and check.get("name") not in {"candidate", *_WARNING_MESSAGES}
            and check.get("status") == "failed"
            for check in checks
        ):
            warnings.append("Plugin Release 还有其他检查未通过")
        return PluginReleaseAudit(
            plugin_id=plugin_id,
            target=target,
            version=version,
            candidate_sha256=expected_sha256,
            file_set_sha256=file_set_sha256,
            file_count=file_count,
            archive_bytes=archive_bytes,
            tool_version=expected_tool_version,
            status=payload["status"],
            warnings=tuple(warnings),
        )

    @staticmethod
    def _ordinary_directory(path: Path) -> bool:
        try:
            info = os.lstat(path)
        except OSError:
            return False
        return stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and not (
            getattr(info, "st_file_attributes", 0) & _REPARSE_POINT
        )

    @staticmethod
    def _ordinary_file(path: Path) -> bool:
        try:
            info = os.lstat(path)
        except OSError:
            return False
        return stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode) and not (
            getattr(info, "st_file_attributes", 0) & _REPARSE_POINT
        )
