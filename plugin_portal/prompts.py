from __future__ import annotations

import re
from copy import deepcopy
from typing import Any

from .models import ModelValidationError, parse_plugin_key
from .storage import PortalStore, StorageError


class PromptValidationError(ValueError):
    """Raised when Portal-owned Prompt data is not closed and valid."""


_PROMPT_ID = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")


def validate_prompts(value: object, *, expected_plugin_key: str) -> dict[str, Any]:
    _require_plugin_key(expected_plugin_key)
    if not isinstance(value, dict) or set(value) != {"pluginKey", "items"}:
        raise PromptValidationError("Prompts 资料结构无效")
    if value["pluginKey"] != expected_plugin_key:
        raise PromptValidationError("Prompts 插件身份不一致")
    if not isinstance(value["items"], list):
        raise PromptValidationError("Prompts items 必须是列表")

    seen: set[str] = set()
    for item in value["items"]:
        if not isinstance(item, dict) or set(item) != {"id", "title", "content"}:
            raise PromptValidationError("Prompt 结构无效")
        prompt_id = item["id"]
        if not isinstance(prompt_id, str) or not _PROMPT_ID.fullmatch(prompt_id) or prompt_id in seen:
            raise PromptValidationError("Prompt ID 无效或重复")
        seen.add(prompt_id)
        _require_text(item["title"], "Prompt 标题", maximum=200, single_line=True)
        _require_text(item["content"], "Prompt 内容", maximum=100_000)
    return value


class PromptRepository:
    def __init__(self, store: PortalStore):
        self.store = store

    def get(self, plugin_key: str) -> dict[str, Any]:
        _require_plugin_key(plugin_key)
        document = self.store.read_document("prompts")
        plugins = _stored_plugins(document["data"])
        items = deepcopy(plugins.get(plugin_key, {"items": []})["items"])
        value = {"pluginKey": plugin_key, "items": items}
        validate_prompts(value, expected_plugin_key=plugin_key)
        return {"revision": document["revision"], **value}

    def save(
        self,
        plugin_key: str,
        items: list[dict[str, str]],
        *,
        expected_revision: int,
    ) -> dict[str, Any]:
        value = {"pluginKey": plugin_key, "items": items}
        validate_prompts(value, expected_plugin_key=plugin_key)
        current = self.store.read_document("prompts")
        plugins = deepcopy(_stored_plugins(current["data"]))
        plugins[plugin_key] = {"items": deepcopy(items)}
        written = self.store.write_document("prompts", {"plugins": plugins}, expected_revision)
        return {"revision": written["revision"], **deepcopy(value)}


def _stored_plugins(data: object) -> dict[str, Any]:
    if data == {}:
        return {}
    if not isinstance(data, dict) or set(data) != {"plugins"} or not isinstance(data["plugins"], dict):
        raise StorageError("Prompts 存储结构无效")
    for plugin_key, value in data["plugins"].items():
        validate_prompts(
            {"pluginKey": plugin_key, "items": value.get("items") if isinstance(value, dict) else None},
            expected_plugin_key=plugin_key,
        )
        if set(value) != {"items"}:
            raise StorageError("Prompts 存储结构无效")
    return data["plugins"]


def _require_plugin_key(plugin_key: str) -> None:
    try:
        parse_plugin_key(plugin_key)
    except ModelValidationError:
        raise PromptValidationError("Prompts 插件身份无效") from None


def _require_text(value: object, field: str, *, maximum: int, single_line: bool = False) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or "\x00" in value:
        raise PromptValidationError(f"{field} 无效")
    if single_line and ("\r" in value or "\n" in value):
        raise PromptValidationError(f"{field} 必须是单行文字")
    return value
