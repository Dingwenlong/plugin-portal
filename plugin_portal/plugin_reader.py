from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from .models import canonical_json_bytes
from .public_text import (
    PublicTextError,
    require_https_url,
    require_public_text,
    require_safe_markdown,
)


class PluginReadError(RuntimeError):
    """Raised when plugin public data cannot be safely projected."""


_IDENTIFIER = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
_REPARSE_POINT = 0x400
_MAX_PUBLIC_FILE_BYTES = 2 * 1024 * 1024
_TOOL_FIELDS = {"id", "name", "purpose", "url"}
_MARKDOWN_H1 = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)
_CJK_TEXT = re.compile(r"[\u3400-\u9fff]")
_ICON_TYPES = {
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}


def preview_plugin(
    plugin_root: Path | str,
    *,
    target: str,
    approved_rule_paths: list[str],
    extension_tools: list[dict[str, Any]],
    imported_at: str | None = None,
    expected_plugin_id: str | None = None,
) -> dict[str, Any]:
    root = _validated_root(Path(plugin_root))
    manifest = _read_json(root, ".codex-plugin/plugin.json")

    try:
        plugin_id = _identifier(manifest.get("name"), "插件 ID")
        target_id = _identifier(target, "target")
        version = require_public_text(manifest.get("version"), "插件版本", single_line=True)
        interface = manifest.get("interface", {})
        if not isinstance(interface, dict):
            raise PluginReadError("插件界面资料无效")
        display_name = require_public_text(interface.get("displayName", plugin_id), "插件显示名称", single_line=True)
        summary = require_public_text(
            interface.get("shortDescription", manifest.get("description")),
            "插件说明",
        )
    except PublicTextError as error:
        raise PluginReadError(str(error)) from error

    if expected_plugin_id is not None and plugin_id != expected_plugin_id:
        raise PluginReadError("插件身份不一致")

    skills = _read_skills(root)
    mcp = _read_mcp(root)
    tools = _validate_extension_tools(extension_tools)
    rules = _read_rules(root, approved_rule_paths)
    projected = {
        "schemaVersion": "1.0.0",
        "plugin": {
            "target": target_id,
            "id": plugin_id,
            "name": display_name,
            "version": version,
            "summary": summary,
        },
        "skills": skills,
        "mcp": mcp,
        "extensionTools": tools,
        "engineeringRules": rules,
    }
    digest = hashlib.sha256(canonical_json_bytes(projected)).hexdigest()
    timestamp = imported_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    try:
        timestamp = require_public_text(timestamp, "导入时间", single_line=True)
    except PublicTextError as error:
        raise PluginReadError(str(error)) from error
    return {
        **projected,
        "provenance": {
            "packageDigest": f"sha256:{digest}",
            "adapterVersion": "1.0.0",
            "importedAt": timestamp,
        },
    }


def _validated_root(root: Path) -> Path:
    try:
        root = root.expanduser().absolute()
        info = os.lstat(root)
    except OSError as error:
        raise PluginReadError("插件目录不存在") from error
    if not stat.S_ISDIR(info.st_mode) or _is_link_or_reparse(info):
        raise PluginReadError("插件目录必须是一般目录")
    return root


def _safe_relative_path(value: str, *, suffix: str | None = None) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\\" in value:
        raise PluginReadError("插件相对路径无效")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise PluginReadError("插件相对路径无效")
    if suffix is not None and path.suffix.lower() != suffix:
        raise PluginReadError("插件文件类型不允许")
    return path


def _read_public_file(root: Path, relative: str, *, suffix: str | None = None) -> str:
    path = _safe_relative_path(relative, suffix=suffix)
    candidate = root
    try:
        for part in path.parts:
            candidate = candidate / part
            info = os.lstat(candidate)
            if _is_link_or_reparse(info):
                raise PluginReadError("插件路径包含链接或 reparse point")
        if not stat.S_ISREG(info.st_mode):
            raise PluginReadError("插件路径不是一般文件")
        if info.st_size > _MAX_PUBLIC_FILE_BYTES:
            raise PluginReadError("插件公开文件过大")

        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(candidate, flags)
        try:
            opened = os.fstat(descriptor)
            if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                raise PluginReadError("插件文件在读取期间发生变化")
            payload = bytearray()
            while True:
                block = os.read(descriptor, min(65536, _MAX_PUBLIC_FILE_BYTES + 1 - len(payload)))
                if not block:
                    break
                payload.extend(block)
                if len(payload) > _MAX_PUBLIC_FILE_BYTES:
                    raise PluginReadError("插件公开文件过大")
        finally:
            os.close(descriptor)
    except PluginReadError:
        raise
    except OSError as error:
        raise PluginReadError("无法安全读取插件文件") from error

    try:
        return bytes(payload).decode("utf-8")
    except UnicodeDecodeError as error:
        raise PluginReadError("插件公开文件必须是 UTF-8") from error


def _is_link_or_reparse(info: os.stat_result) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & _REPARSE_POINT)


def _read_json(root: Path, relative: str) -> dict[str, Any]:
    text = _read_public_file(root, relative)
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        raise PluginReadError("插件 JSON 无效") from error
    if not isinstance(value, dict):
        raise PluginReadError("插件 JSON 必须是对象")
    return value


def _identifier(value: object, field: str) -> str:
    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
        raise PluginReadError(f"{field} 无效")
    return value


def _read_skills(root: Path) -> list[dict[str, str]]:
    skills_root = root / "skills"
    if not skills_root.exists():
        return []
    try:
        skills_info = os.lstat(skills_root)
    except OSError as error:
        raise PluginReadError("无法读取 Skills 目录") from error
    if not stat.S_ISDIR(skills_info.st_mode) or _is_link_or_reparse(skills_info):
        raise PluginReadError("Skills 目录无效")

    projected: list[dict[str, str]] = []
    try:
        names = sorted(entry.name for entry in os.scandir(skills_root))
    except OSError as error:
        raise PluginReadError("无法列出 Skills") from error
    for directory_name in names:
        _identifier(directory_name, "Skill 目录")
        markdown = _read_public_file(root, f"skills/{directory_name}/SKILL.md", suffix=".md")
        front_matter = _front_matter(markdown)
        try:
            skill_id = _identifier(front_matter.get("name"), "Skill ID")
            skill_name = require_public_text(
                _skill_display_name(root, directory_name, markdown),
                "Skill 名称",
                single_line=True,
            )
            description = require_public_text(front_matter.get("description"), "Skill 说明")
        except PublicTextError as error:
            raise PluginReadError(str(error)) from error
        if skill_id != directory_name:
            raise PluginReadError("Skill 身份与目录不一致")
        projected.append({"id": skill_id, "name": skill_name, "description": description})
    return projected


def _skill_title(markdown: str) -> str:
    match = _MARKDOWN_H1.search(markdown)
    if match is None:
        raise PluginReadError("Skill 缺少公开名称")
    return match.group(1)


def _skill_display_name(root: Path, directory_name: str, markdown: str) -> str:
    relative = f"skills/{directory_name}/skill.contract.json"
    try:
        os.lstat(root / "skills" / directory_name / "skill.contract.json")
    except FileNotFoundError:
        return _skill_title(markdown)
    except OSError as error:
        raise PluginReadError("无法读取 Skill 公开合约") from error
    contract = _read_json(root, relative)
    portal = contract.get("portal")
    if portal is None:
        return _skill_title(markdown)
    if not isinstance(portal, dict):
        raise PluginReadError("Skill 公开合约无效")
    display_name = portal.get("displayName")
    if display_name is None:
        return _skill_title(markdown)
    if not isinstance(display_name, str):
        raise PluginReadError("Skill 公开合约名称无效")
    return display_name if _CJK_TEXT.search(display_name) else _skill_title(markdown)


def read_plugin_icon(plugin_root: Path | str) -> tuple[str, bytes]:
    root = _validated_root(Path(plugin_root))
    manifest = _read_json(root, ".codex-plugin/plugin.json")
    interface = manifest.get("interface")
    if not isinstance(interface, dict) or not isinstance(interface.get("logo"), str):
        raise PluginReadError("插件未提供公开图标")
    relative = _safe_relative_path(interface["logo"])
    content_type = _ICON_TYPES.get(relative.suffix.lower())
    if content_type is None:
        raise PluginReadError("插件图标文件类型不允许")
    return content_type, _read_public_bytes(root, relative)


def _read_public_bytes(root: Path, relative: PurePosixPath) -> bytes:
    candidate = root
    try:
        for part in relative.parts:
            candidate = candidate / part
            info = os.lstat(candidate)
            if _is_link_or_reparse(info):
                raise PluginReadError("插件路径包含链接或 reparse point")
        if not stat.S_ISREG(info.st_mode):
            raise PluginReadError("插件路径不是一般文件")
        if info.st_size > _MAX_PUBLIC_FILE_BYTES:
            raise PluginReadError("插件公开文件过大")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(candidate, flags)
        try:
            opened = os.fstat(descriptor)
            if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                raise PluginReadError("插件文件在读取期间发生变化")
            payload = bytearray()
            while True:
                block = os.read(descriptor, min(65536, _MAX_PUBLIC_FILE_BYTES + 1 - len(payload)))
                if not block:
                    break
                payload.extend(block)
                if len(payload) > _MAX_PUBLIC_FILE_BYTES:
                    raise PluginReadError("插件公开文件过大")
        finally:
            os.close(descriptor)
    except PluginReadError:
        raise
    except OSError as error:
        raise PluginReadError("无法安全读取插件文件") from error
    return bytes(payload)


def _front_matter(markdown: str) -> dict[str, str]:
    lines = markdown.splitlines()
    if not lines or lines[0].strip() != "---":
        raise PluginReadError("Skill 缺少公开 front matter")
    values: dict[str, str] = {}
    for line in lines[1:]:
        if line.strip() == "---":
            return values
        if ":" not in line:
            raise PluginReadError("Skill front matter 无效")
        key, raw_value = line.split(":", 1)
        key = key.strip()
        if key in ("name", "description"):
            if key in values:
                raise PluginReadError("Skill front matter 字段重复")
            values[key] = raw_value.strip().strip('"\'')
    raise PluginReadError("Skill front matter 未结束")


def _read_mcp(root: Path) -> list[dict[str, str]]:
    path = root / ".mcp.json"
    if not path.exists():
        return []
    value = _read_json(root, ".mcp.json")
    if set(value) != {"mcpServers"} or not isinstance(value["mcpServers"], dict):
        raise PluginReadError("MCP 公开结构无效")
    return [{"id": _identifier(server_id, "MCP 服务 ID")} for server_id in sorted(value["mcpServers"])]


def _validate_extension_tools(tools: list[dict[str, Any]]) -> list[dict[str, str]]:
    if not isinstance(tools, list):
        raise PluginReadError("扩展工具必须是列表")
    projected: list[dict[str, str]] = []
    seen: set[str] = set()
    for tool in tools:
        if not isinstance(tool, dict) or set(tool) != _TOOL_FIELDS:
            raise PluginReadError("扩展工具结构无效")
        try:
            tool_id = _identifier(tool["id"], "扩展工具 ID")
            if tool_id in seen:
                raise PluginReadError("扩展工具 ID 重复")
            seen.add(tool_id)
            projected.append(
                {
                    "id": tool_id,
                    "name": require_public_text(tool["name"], "扩展工具名称", single_line=True),
                    "purpose": require_public_text(tool["purpose"], "扩展工具用途"),
                    "url": require_https_url(tool["url"], "扩展工具链接"),
                }
            )
        except PublicTextError as error:
            raise PluginReadError(str(error)) from error
    return projected


def _read_rules(root: Path, paths: list[str]) -> list[dict[str, str]]:
    if not isinstance(paths, list):
        raise PluginReadError("工程规范路径必须是列表")
    projected: list[dict[str, str]] = []
    seen: set[str] = set()
    for value in paths:
        normalized = _safe_relative_path(value, suffix=".md").as_posix()
        if normalized in seen:
            raise PluginReadError("工程规范路径重复")
        seen.add(normalized)
        markdown = _read_public_file(root, normalized, suffix=".md").replace("\r\n", "\n").replace("\r", "\n").rstrip()
        try:
            markdown = require_safe_markdown(markdown, "工程规范正文")
        except PublicTextError as error:
            raise PluginReadError(str(error)) from error
        projected.append({"path": normalized, "bodyMarkdown": markdown})
    return projected
