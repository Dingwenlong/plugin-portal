from __future__ import annotations

import re
from copy import deepcopy
from typing import Any

from .models import ModelValidationError, parse_plugin_key
from .storage import PortalStore, StorageError


class WorkflowValidationError(ValueError):
    """Raised when a Portal-owned workflow is not closed and valid."""


_ID = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")


def validate_workflow(value: object, *, expected_plugin_key: str) -> dict[str, Any]:
    _require_plugin_key(expected_plugin_key)
    if not isinstance(value, dict) or set(value) != {"pluginKey", "tabs"}:
        raise WorkflowValidationError("流程资料结构无效")
    if value["pluginKey"] != expected_plugin_key:
        raise WorkflowValidationError("流程插件身份不一致")
    if not isinstance(value["tabs"], list):
        raise WorkflowValidationError("流程 tabs 必须是列表")

    all_ids: set[str] = set()
    for tab in value["tabs"]:
        _require_closed(tab, {"id", "title", "sections"}, "Tab")
        _register_id(tab["id"], all_ids, "Tab ID")
        _require_text(tab["title"], "Tab 标题", maximum=200, single_line=True)
        if not isinstance(tab["sections"], list):
            raise WorkflowValidationError("流程 sections 必须是列表")
        for section in tab["sections"]:
            _require_closed(section, {"id", "title", "steps"}, "流程区域")
            _register_id(section["id"], all_ids, "流程区域 ID")
            _require_text(section["title"], "流程区域标题", maximum=200, single_line=True)
            if not isinstance(section["steps"], list):
                raise WorkflowValidationError("流程 steps 必须是列表")
            _validate_steps(section["steps"], all_ids)
    return value


def _validate_steps(steps: list[object], all_ids: set[str]) -> None:
    by_id: dict[str, dict[str, Any]] = {}
    for raw_step in steps:
        _require_closed(raw_step, {"id", "label", "title", "description", "next"}, "流程步骤")
        step = raw_step
        step_id = _register_id(step["id"], all_ids, "流程步骤 ID")
        _require_text(step["label"], "流程步骤角标", maximum=80, single_line=True)
        _require_text(step["title"], "流程步骤标题", maximum=200, single_line=True)
        if not isinstance(step["description"], str) or len(step["description"]) > 2_000 or "\x00" in step["description"]:
            raise WorkflowValidationError("流程步骤说明无效")
        if not isinstance(step["next"], list) or any(not isinstance(item, str) for item in step["next"]):
            raise WorkflowValidationError("流程步骤 next 必须是 ID 列表")
        if len(set(step["next"])) != len(step["next"]):
            raise WorkflowValidationError("流程步骤 next 重复")
        by_id[step_id] = step

    if not by_id:
        return
    incoming = {step_id: 0 for step_id in by_id}
    for item in by_id.values():
        for next_id in item["next"]:
            if next_id not in by_id:
                raise WorkflowValidationError("流程包含未知连接")
            incoming[next_id] += 1
    entries = [step_id for step_id, count in incoming.items() if count == 0]
    if len(entries) != 1:
        raise WorkflowValidationError("流程必须有且只有一个入口")

    visited: set[str] = set()
    visiting: set[str] = set()

    def visit(step_id: str) -> None:
        if step_id in visiting:
            raise WorkflowValidationError("流程不能包含循环")
        if step_id in visited:
            return
        visiting.add(step_id)
        for next_id in by_id[step_id]["next"]:
            visit(next_id)
        visiting.remove(step_id)
        visited.add(step_id)

    visit(entries[0])
    if visited != set(by_id):
        raise WorkflowValidationError("流程包含无法到达的步骤")


class WorkflowRepository:
    def __init__(self, store: PortalStore):
        self.store = store

    def get(self, plugin_key: str) -> dict[str, Any]:
        _require_plugin_key(plugin_key)
        document = self.store.read_document("workflows")
        plugins = _stored_plugins(document["data"])
        value = deepcopy(plugins.get(plugin_key, {"pluginKey": plugin_key, "tabs": []}))
        validate_workflow(value, expected_plugin_key=plugin_key)
        return {"revision": document["revision"], **value}

    def save(self, plugin_key: str, value: dict[str, Any], *, expected_revision: int) -> dict[str, Any]:
        validate_workflow(value, expected_plugin_key=plugin_key)
        current = self.store.read_document("workflows")
        plugins = deepcopy(_stored_plugins(current["data"]))
        plugins[plugin_key] = deepcopy(value)
        written = self.store.write_document("workflows", {"plugins": plugins}, expected_revision)
        return {"revision": written["revision"], **deepcopy(value)}


def _stored_plugins(data: object) -> dict[str, Any]:
    if data == {}:
        return {}
    if not isinstance(data, dict) or set(data) != {"plugins"} or not isinstance(data["plugins"], dict):
        raise StorageError("流程存储结构无效")
    for plugin_key, workflow in data["plugins"].items():
        validate_workflow(workflow, expected_plugin_key=plugin_key)
    return data["plugins"]


def _require_plugin_key(plugin_key: str) -> None:
    try:
        parse_plugin_key(plugin_key)
    except ModelValidationError:
        raise WorkflowValidationError("流程插件身份无效") from None


def _require_closed(value: object, fields: set[str], label: str) -> None:
    if not isinstance(value, dict) or set(value) != fields:
        raise WorkflowValidationError(f"{label} 结构无效")


def _register_id(value: object, seen: set[str], field: str) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value) or value in seen:
        raise WorkflowValidationError(f"{field} 无效或重复")
    seen.add(value)
    return value


def _require_text(value: object, field: str, *, maximum: int, single_line: bool = False) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or "\x00" in value:
        raise WorkflowValidationError(f"{field} 无效")
    if single_line and ("\r" in value or "\n" in value):
        raise WorkflowValidationError(f"{field} 必须是单行文字")
    return value
