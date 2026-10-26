"""Frozen, session-scoped Markdown choices for explicit public rule selection."""
from __future__ import annotations

import os
import re
from pathlib import Path

from .plugin_reader import PluginReadError, _is_link_or_reparse, _read_rules, _validated_root
from .public_text import PublicTextError, require_public_text

MAX_RULE_CHOICES = 1024
MAX_RULE_BYTES = 8 * 1024 * 1024
_SKIP_DIRECTORIES = {".git", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache"}
_HEADING = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)


def discover_import_rules(plugin_root: Path) -> dict:
    root = _validated_root(plugin_root)
    paths: list[str] = []
    truncated = False
    visited = 0
    for directory, directories, files in os.walk(root, followlinks=False):
        visited += 1
        if visited > 4096:
            truncated = True
            break
        safe_directories = []
        for name in sorted(directories):
            try:
                if name not in _SKIP_DIRECTORIES and not _is_link_or_reparse((Path(directory) / name).lstat()):
                    safe_directories.append(name)
            except OSError:
                continue
        directories[:] = safe_directories
        for name in sorted(files):
            if not name.lower().endswith(".md"):
                continue
            relative = (Path(directory) / name).relative_to(root).as_posix()
            try:
                require_public_text(relative, "规范文件路径", single_line=True)
            except PublicTextError:
                continue
            if len(paths) == MAX_RULE_CHOICES:
                truncated = True
                break
            paths.append(relative)
        if truncated:
            break
    paths.sort(key=lambda path: (not any(word in path.lower() for word in ("rules", "standard", "规范")), path.casefold()))
    choices, documents = [], {}
    remaining = MAX_RULE_BYTES
    for path in paths:
        choice = {"path": path, "title": Path(path).stem, "available": False, "reason": None}
        try:
            size = (root / path).lstat().st_size
            if size > remaining:
                raise PluginReadError("本次规范预览总量已达 8 MiB")
            remaining -= size
            rule = _read_rules(root, [path])[0]
            match = _HEADING.search(rule["bodyMarkdown"])
            if match:
                try:
                    choice["title"] = require_public_text(match.group(1), "规范标题", single_line=True)
                except PublicTextError:
                    pass
            choice["available"] = True
            documents[path] = rule["bodyMarkdown"]
        except (PluginReadError, OSError) as error:
            choice["reason"] = str(error) if isinstance(error, PluginReadError) else "无法安全读取该文件"
        choices.append(choice)
    return {"choices": choices, "documents": documents, "truncated": truncated}
