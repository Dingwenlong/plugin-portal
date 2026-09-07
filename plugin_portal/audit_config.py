"""Explicit, fail-closed publication audit dependencies, independent of site startup."""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

from .download_publication import DownloadPublicationError, PluginReleaseAuditor


_DIGEST = re.compile(r"^[0-9a-f]{64}$")
_VERSION = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$")


def _unavailable() -> DownloadPublicationError:
    # Public errors must not disclose executable paths or local configuration.
    return DownloadPublicationError("plugin_release_unavailable", "发布审计工具未配置或不可用，请管理员检查配置")


def _plain_path(value: object, *, directory: bool = False) -> Path:
    if not isinstance(value, str) or not value or not Path(value).is_absolute():
        raise _unavailable()
    path = Path(value)
    if ".." in path.parts or not (path.is_dir() if directory else path.is_file()):
        raise _unavailable()
    for entry in (path, *path.parents):
        info = entry.lstat()
        if entry.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400:
            raise _unavailable()
    return path


def _file_digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def tree_digest(root: Path) -> str:
    """SHA256 of ordinal-sorted UTF-8 relative/path:lowercase-sha256 lines, no final LF."""
    lines = []
    for path in root.rglob("*"):
        _plain_path(str(path), directory=path.is_dir())
        if path.is_file():
            lines.append(f"{path.relative_to(root).as_posix()}:{_file_digest(path)}")
    # Match .NET StringComparer.Ordinal, including non-BMP filenames.
    return hashlib.sha256("\n".join(sorted(lines, key=lambda line: line.encode("utf-16-be"))).encode("utf-8")).hexdigest()


def _pin(path: Path, expected: object, *, tree: bool = False) -> None:
    if not isinstance(expected, str) or not _DIGEST.fullmatch(expected):
        raise _unavailable()
    actual = tree_digest(path) if tree else _file_digest(path)
    if actual != expected:
        raise _unavailable()


class ConfiguredPluginReleaseAuditor(PluginReleaseAuditor):
    """Construction is deliberately lazy; no optional dependency gates basic browsing.

    Each audit rereads explicit configuration and pins before executing anything.
    There is no PATH search, cache-version discovery, installation, or fallback.
    """

    def __init__(self, config_path: Path | str | None = None):
        self.config_path = config_path if config_path is not None else os.environ.get("PORTAL_AUDIT_CONFIG")

    def audit(self, path: Path, **kwargs):
        # One short-lived delegate per request avoids sharing mutable config state
        # between ThreadingHTTPServer request threads.
        delegate = self._configured_delegate()
        return delegate.audit(path, **kwargs)

    def _configured_delegate(self) -> PluginReleaseAuditor:
        try:
            config = _plain_path(str(self.config_path)) if self.config_path is not None else None
            if config is None:
                raise _unavailable()
            payload = json.loads(config.read_text(encoding="utf-8-sig"))
            common_fields = {"schemaVersion", "codexHome", "codex", "python"}
            if not isinstance(payload, dict) or set(payload) not in (
                common_fields | {"pluginRelease"}, common_fields | {"pluginInspector"}
            ) or payload["schemaVersion"] != "1.0.0":
                raise _unavailable()
            tool_name = "plugin-inspector" if "pluginInspector" in payload else "plugin-release"
            home = _plain_path(payload["codexHome"], directory=True)
            binaries = {}
            for name in ("codex", "python"):
                value = payload[name]
                if not isinstance(value, dict) or set(value) != {"path", "sha256"}:
                    raise _unavailable()
                binaries[name] = _plain_path(value["path"])
                _pin(binaries[name], value["sha256"])
            if binaries["codex"].name.lower() not in {"codex.exe", "codex"}:
                raise _unavailable()
            release = payload["pluginInspector" if tool_name == "plugin-inspector" else "pluginRelease"]
            if not isinstance(release, dict) or set(release) != {
                "root", "version", "manifestSha256", "scriptSha256", "treeSha256"
            } or not isinstance(release["version"], str) or not _VERSION.fullmatch(release["version"]):
                raise _unavailable()
            root = _plain_path(release["root"], directory=True)
            manifest = _plain_path(str(root / ".codex-plugin" / "plugin.json"))
            script = _plain_path(str(root / "scripts" / "release.py"))
            _pin(manifest, release["manifestSha256"])
            _pin(script, release["scriptSha256"])
            _pin(root, release["treeSha256"], tree=True)
            metadata = json.loads(manifest.read_text(encoding="utf-8-sig"))
            if not isinstance(metadata, dict) or metadata.get("name") != tool_name or metadata.get("version") != release["version"]:
                raise _unavailable()
            return _PinnedAuditor(
                version=release["version"], script=script, codex_home=home, tool_name=tool_name,
                codex_command=(str(binaries["codex"]),), python_executable=str(binaries["python"]),
                pins=((binaries["codex"], payload["codex"]["sha256"], False),
                      (binaries["python"], payload["python"]["sha256"], False),
                      (root, release["treeSha256"], True)),
            )
        except (OSError, ValueError, TypeError, KeyError):
            raise _unavailable() from None


class _PinnedAuditor(PluginReleaseAuditor):
    def __init__(self, *, version: str, script: Path, pins: tuple, **kwargs):
        super().__init__(**kwargs)
        self.version = version
        self.script = script
        self.pins = pins

    def _run(self, command: list[str], *, timeout: int) -> subprocess.CompletedProcess[str]:
        try:
            for path, digest, tree in self.pins:
                _plain_path(str(path), directory=tree)
                _pin(path, digest, tree=tree)
            if command[0] == self.python_executable:
                command = [command[0], "-I", *command[1:]]
            environment = dict(os.environ)
            environment["CODEX_HOME"] = str(self.codex_home)
            environment["PYTHONDONTWRITEBYTECODE"] = "1"
            # The audit tool also calls Codex internally. Pin its PATH resolution
            # to this executable rather than inheriting a desktop cache version.
            environment["PATH"] = str(Path(self.codex_command[0]).parent) + os.pathsep + os.defpath
            return subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="strict",
                                  timeout=timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                                  check=False, env=environment)
        except (OSError, ValueError, subprocess.SubprocessError, UnicodeError):
            raise _unavailable() from None

    def _resolve_script(self) -> tuple[str, Path]:
        completed = self._run(
            [*self.codex_command, "plugin", "list", "--marketplace", "company-dev", "--json"], timeout=30,
        )
        if completed.returncode != 0:
            raise _unavailable()
        payload = self._json_object(completed.stdout, "plugin_release_unavailable")
        installed = payload.get("installed")
        if not isinstance(installed, list):
            raise _unavailable()
        matches = [item for item in installed if isinstance(item, dict)
                   and item.get("pluginId") == f"{self.tool_name}@company-dev"]
        if len(matches) != 1 or matches[0].get("installed") is not True or matches[0].get("enabled") is not True or any(matches[0].get(key) != value for key, value in {
            "name": self.tool_name, "marketplaceName": "company-dev", "version": self.version,
        }.items()):
            raise _unavailable()
        return self.version, self.script
