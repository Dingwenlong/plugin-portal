"""Portal-owned, user-uploaded documentation; never executes plugin code."""
from __future__ import annotations

import re
from copy import deepcopy
from datetime import date
from typing import Any

from .storage import PortalStore, StorageError
from .public_text import PublicTextError, require_public_text


class ContentValidationError(ValueError):
    pass


KINDS = {"mcp", "releases"}
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$")
_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$")


def _object(value, fields, path):
    if not isinstance(value, dict) or set(value) != set(fields):
        raise ContentValidationError(f"{path}：字段必须为 {', '.join(fields)}")


def _text(value, path, maximum=10000, pattern=None):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or "\0" in value:
        raise ContentValidationError(f"{path}：请输入 1–{maximum} 字的文字")
    if pattern and not pattern.fullmatch(value):
        raise ContentValidationError(f"{path}：格式无效")
    try:
        require_public_text(value, path)
    except PublicTextError as error:
        raise ContentValidationError(str(error)) from None


def _list(value, path):
    if not isinstance(value, list):
        raise ContentValidationError(f"{path}：必须是数组")


def _unique(value, seen, path):
    if value in seen:
        raise ContentValidationError(f"{path}：值重复")
    seen.add(value)


def validate_content(value: object, plugin_key: str, kind: str) -> dict[str, Any]:
    if kind not in KINDS:
        raise ContentValidationError("documentType：页面类型无效")
    if not isinstance(value, dict):
        raise ContentValidationError("JSON：必须是对象")
    result = deepcopy(value)
    result.pop("_instructions", None)
    fields = ["schemaVersion", "documentType", "pluginKey"] + (
        ["pluginVersion", "services"] if kind == "mcp" else ["releases"]
    )
    _object(result, fields, "JSON")
    for field, expected in (("schemaVersion", "1.0.0"), ("documentType", kind), ("pluginKey", plugin_key)):
        if result[field] != expected:
            raise ContentValidationError(f"{field}：与当前模板不一致，请下载本页模板")
    if kind == "mcp":
        _text(result["pluginVersion"], "pluginVersion", 64, _VERSION)
        _list(result["services"], "services")
        services = set()
        for i, service in enumerate(result["services"]):
            path = f"services[{i}]"
            _object(service, ["id", "name", "tools"], path)
            _text(service["id"], f"{path}.id", 200, _ID)
            _unique(service["id"], services, f"{path}.id")
            _text(service["name"], f"{path}.name", 200)
            _list(service["tools"], f"{path}.tools")
            tools = set()
            for j, tool in enumerate(service["tools"]):
                tp = f"{path}.tools[{j}]"
                _object(tool, ["id", "name", "purpose", "scenarios"], tp)
                _text(tool["id"], f"{tp}.id", 200, _ID)
                _unique(tool["id"], tools, f"{tp}.id")
                _text(tool["name"], f"{tp}.name", 200)
                _text(tool["purpose"], f"{tp}.purpose")
                _list(tool["scenarios"], f"{tp}.scenarios")
                for k, scenario in enumerate(tool["scenarios"]):
                    _text(scenario, f"{tp}.scenarios[{k}]", 2000)
    else:
        _list(result["releases"], "releases")
        versions = set()
        for i, release in enumerate(result["releases"]):
            path = f"releases[{i}]"
            _object(release, ["version", "releasedAt", "summary", "changes"], path)
            _text(release["version"], f"{path}.version", 64, _VERSION)
            _unique(release["version"], versions, f"{path}.version")
            stamp = release["releasedAt"]
            if stamp is not None:
                try:
                    if not isinstance(stamp, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", stamp):
                        raise ValueError
                    date.fromisoformat(stamp)
                except ValueError:
                    raise ContentValidationError(f"{path}.releasedAt：应为有效 YYYY-MM-DD 日期或 null") from None
            _text(release["summary"], f"{path}.summary")
            _list(release["changes"], f"{path}.changes")
            for j, change in enumerate(release["changes"]):
                cp = f"{path}.changes[{j}]"
                _object(change, ["type", "text"], cp)
                if not isinstance(change["type"], str) or change["type"] not in {"added", "changed", "fixed", "removed"}:
                    raise ContentValidationError(f"{cp}.type：应为 added、changed、fixed 或 removed")
                _text(change["text"], f"{cp}.text")
    return result


def content_template(snapshot: dict, plugin_key: str, kind: str) -> dict:
    result = {"schemaVersion": "1.0.0", "documentType": kind, "pluginKey": plugin_key}
    instructions = [
        "请根据提供的插件资料填写本模板，输出完整 JSON 文件。保持 schemaVersion、documentType、pluginKey 不变。",
        "仅填写可确认的功能或发布记录；不得虚构、包含凭证或本机私有路径。删除示例，文字使用中文。",
        "上传确认后将替换整页内容，修改已有文档时应先导出当前 JSON。_instructions 不会保存。",
    ]
    if kind == "mcp":
        instructions.append("按实际 MCP 服务和工具列出 id、中文名称、用途和使用场景；无 MCP 时 services 为 []。pluginVersion 对应所参考插件版本。")
        result.update(pluginVersion=snapshot["plugin"]["version"], services=[
            {"id": service["id"], "name": service.get("name", service["id"]), "tools": [
                {"id": "example_tool", "name": "示例：工具中文名称", "purpose": "替换为该工具的实际用途", "scenarios": ["替换为具体使用场景"]}
            ]} for service in snapshot["mcp"]
        ])
    else:
        instructions.append("根据实际发布记录填写 releases；releasedAt 为 YYYY-MM-DD，未知填 null。changes.type 使用 added/changed/fixed/removed。")
        result["releases"] = [{"version": snapshot["plugin"]["version"], "releasedAt": None,
                               "summary": "替换为此版本摘要", "changes": [{"type": "changed", "text": "替换为实际变更"}]}]
    result["_instructions"] = instructions
    return result


def content_diff(before: dict | None, after: dict) -> dict:
    def flatten(doc):
        if doc is None:
            return {}
        if doc["documentType"] == "releases":
            return {f"v{r['version']}": r for r in doc["releases"]}
        rows = {"说明版本": doc["pluginVersion"]}
        for service in doc["services"]:
            rows[f"服务 {service['id']}"] = service["name"]
            rows.update({f"{service['id']} / {tool['id']}": tool for tool in service["tools"]})
        return rows
    old, new = flatten(before), flatten(after)
    changes = [{"type": "added" if key not in old else "removed" if key not in new else "changed", "label": key}
               for key in dict.fromkeys([*old, *new]) if key not in old or key not in new or old[key] != new[key]]
    return {"added": sum(x["type"] == "added" for x in changes),
            "changed": sum(x["type"] == "changed" for x in changes),
            "removed": sum(x["type"] == "removed" for x in changes), "items": changes}


class ContentRepository:
    def __init__(self, store: PortalStore):
        self.store = store

    def _read(self, kind):
        document = self.store.read_document(f"{kind}-documents")
        data = document["data"]
        if data == {}:
            return document, {}
        if set(data) != {"plugins"} or not isinstance(data["plugins"], dict):
            raise StorageError("页面内容存储结构无效")
        return document, data["plugins"]

    def get(self, plugin_key: str, kind: str):
        stored, plugins = self._read(kind)
        value = plugins.get(plugin_key)
        if value is not None:
            value = validate_content(value, plugin_key, kind)
        return {"revision": stored["revision"], "pluginKey": plugin_key, "documentType": kind, "document": value}

    def save(self, plugin_key: str, kind: str, value: dict, expected_revision: int):
        value = validate_content(value, plugin_key, kind)
        _, plugins = self._read(kind)
        next_plugins = deepcopy(plugins)
        next_plugins[plugin_key] = value
        written = self.store.write_document(f"{kind}-documents", {"plugins": next_plugins}, expected_revision)
        return {"revision": written["revision"], "pluginKey": plugin_key, "documentType": kind, "document": value}
