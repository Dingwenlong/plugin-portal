from __future__ import annotations

import re
from copy import deepcopy
from typing import Any

from .models import ModelValidationError, parse_plugin_key
from .storage import PortalStore, StorageError
from .workflow_images import ASSET_ID, INDEX, WorkflowImageStore


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
    for raw_step in steps:
        fields = {"id", "label", "title", "description", "next"}
        _require_closed(raw_step, fields | ({"images"} if isinstance(raw_step, dict) and "images" in raw_step else set()), "流程步骤")
        step = raw_step
        images = step.get("images", [])
        if not isinstance(images, list) or len(images) > 6:
            raise WorkflowValidationError("每个步骤最多 6 张图片")
        seen_images = set()
        for image in images:
            _require_closed(image, {"assetId", "alt"} | ({"title"} if isinstance(image, dict) and "title" in image else set()), "步骤图片")
            if "title" in image and (not isinstance(image["title"], str) or len(image["title"]) > 200
                    or any(char in image["title"] for char in ("\x00", "\r", "\n"))):
                raise WorkflowValidationError("子步骤标题无效")
            if (not isinstance(image["assetId"], str) or not ASSET_ID.fullmatch(image["assetId"])
                    or image["assetId"] in seen_images or not isinstance(image["alt"], str)
                    or len(image["alt"]) > 200 or "\x00" in image["alt"]):
                raise WorkflowValidationError("步骤图片引用或说明无效")
            seen_images.add(image["assetId"])
        _register_id(step["id"], all_ids, "流程步骤 ID")
        _require_text(step["label"], "流程步骤角标", maximum=80, single_line=True)
        _require_text(step["title"], "流程步骤标题", maximum=200, single_line=True)
        if not isinstance(step["description"], str) or len(step["description"]) > 2_000 or "\x00" in step["description"]:
            raise WorkflowValidationError("流程步骤说明无效")
        if not isinstance(step["next"], list) or any(not isinstance(item, str) for item in step["next"]):
            raise WorkflowValidationError("流程步骤 next 必须是 ID 列表")
        if len(set(step["next"])) != len(step["next"]):
            raise WorkflowValidationError("流程步骤 next 重复")

    # The ordered steps array is authoritative. Legacy next links remain readable
    # for compatibility, but are no longer editable or used to validate ordering.


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
        with self.store._lock:
            current = self.store.read_document("workflows")
            plugins = deepcopy(_stored_plugins(current["data"]))
            plugins[plugin_key] = deepcopy(value)
            images = WorkflowImageStore(self.store)
            images.cleanup()
            assets, asset_revision = images.prepare_save(plugins, plugin_key)
            if self.store.read_document(INDEX)["data"] == assets:
                # Text edits and reordering do not change image ownership. Avoid a
                # second durable write while retaining all image validation above.
                written = self.store.write_document("workflows", {"plugins": plugins}, expected_revision)
            else:
                written = self.store.write_documents_batch({
                    "workflows": ({"plugins": plugins}, expected_revision),
                    INDEX: (assets, asset_revision),
                })["workflows"]
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
