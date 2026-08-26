from __future__ import annotations

import hashlib
import http.cookiejar
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from .models import canonical_json_bytes, parse_plugin_key
from .prompts import PromptValidationError, validate_prompts
from .public_text import PublicTextError, require_https_url, require_public_text
from .storage import PortalStore, RevisionConflict, StorageError
from .workflows import WorkflowValidationError, validate_workflow


class LegacyMigrationError(RuntimeError):
    """Raised when legacy Portal data cannot be migrated as one closed candidate."""


_ID = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
_PROMPT_LIMIT = 2 * 1024 * 1024
_PORTAL_LIMIT = 16 * 1024 * 1024
_SOURCE_TIMEOUT_SECONDS = 30


def validate_legacy_source_url(value: str) -> str:
    if not isinstance(value, str):
        raise LegacyMigrationError("旧 Portal 地址无效")
    parsed = urllib.parse.urlsplit(value.rstrip("/"))
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost"}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise LegacyMigrationError("旧 Portal 只允许无凭证的本机 HTTP 地址")
    if parsed.port is None:
        raise LegacyMigrationError("旧 Portal 地址必须包含端口")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


def fetch_legacy_source(source_url: str) -> tuple[dict[str, Any], dict[str, Any]]:
    base = validate_legacy_source_url(source_url)
    parsed = urllib.parse.urlsplit(base)
    origin = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
    cookies = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))
    try:
        _read_json(opener, f"{origin}/api/prompts/session", _PROMPT_LIMIT)
        prompts = _read_json(opener, f"{origin}/api/prompts", _PROMPT_LIMIT)
        portal_data = _read_json(opener, f"{base}/portal-data.json", _PORTAL_LIMIT)
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as error:
        raise LegacyMigrationError("无法读取旧 Portal 资料") from error
    return portal_data, prompts


def build_legacy_candidate(
    *,
    portal_data: object,
    prompt_payload: object,
    current_snapshot: object,
    plugin_key: str,
    source_url: str,
    migrated_at: str | None = None,
) -> dict[str, Any]:
    validate_legacy_source_url(source_url)
    target, plugin_id = parse_plugin_key(plugin_key)
    if not isinstance(portal_data, dict) or not isinstance(prompt_payload, dict) or not isinstance(current_snapshot, dict):
        raise LegacyMigrationError("旧 Portal 资料结构无效")
    plugin = current_snapshot.get("plugin")
    if not isinstance(plugin, dict) or plugin.get("target") != target or plugin.get("id") != plugin_id:
        raise LegacyMigrationError("迁移目标插件身份不一致")

    timestamp = migrated_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    prompts = _project_prompts(prompt_payload, plugin_key)
    workflow = _project_workflow(portal_data, plugin_key)
    snapshot = _project_snapshot(portal_data, current_snapshot, timestamp)
    try:
        validate_prompts(prompts, expected_plugin_key=plugin_key)
        validate_workflow(workflow, expected_plugin_key=plugin_key)
    except (PromptValidationError, WorkflowValidationError) as error:
        raise LegacyMigrationError(str(error)) from error

    counts = {
        "prompts": len(prompts["items"]),
        "tabs": len(workflow["tabs"]),
        "extensionTools": len(snapshot["extensionTools"]),
        "skills": len(snapshot["skills"]),
    }
    fingerprint_snapshot = deepcopy(snapshot)
    fingerprint_snapshot["provenance"] = {
        key: value
        for key, value in snapshot["provenance"].items()
        if key != "importedAt"
    }
    fingerprint = hashlib.sha256(canonical_json_bytes({
        "pluginKey": plugin_key,
        "prompts": prompts,
        "workflow": workflow,
        "snapshot": fingerprint_snapshot,
    })).hexdigest()
    return {
        "pluginKey": plugin_key,
        "sourceUrl": validate_legacy_source_url(source_url),
        "migratedAt": timestamp,
        "fingerprint": fingerprint,
        "counts": counts,
        "prompts": prompts,
        "workflow": workflow,
        "snapshot": snapshot,
    }


def apply_legacy_candidate(store: PortalStore, candidate: object) -> dict[str, Any]:
    if not isinstance(candidate, dict):
        raise LegacyMigrationError("迁移候选无效")
    required = {"pluginKey", "sourceUrl", "migratedAt", "fingerprint", "counts", "prompts", "workflow", "snapshot"}
    if set(candidate) != required:
        raise LegacyMigrationError("迁移候选结构无效")
    plugin_key = candidate["pluginKey"]
    if not isinstance(plugin_key, str):
        raise LegacyMigrationError("迁移插件身份无效")
    try:
        validate_prompts(candidate["prompts"], expected_plugin_key=plugin_key)
        validate_workflow(candidate["workflow"], expected_plugin_key=plugin_key)
    except (PromptValidationError, WorkflowValidationError) as error:
        raise LegacyMigrationError(str(error)) from error

    migrations = store.read_document("legacy-migrations")
    migration_plugins = _document_plugins(migrations["data"], "迁移回执")
    previous = migration_plugins.get(plugin_key)
    if isinstance(previous, dict) and previous.get("fingerprint") == candidate["fingerprint"]:
        return {**deepcopy(previous), "alreadyApplied": True}

    prompts_document = store.read_document("prompts")
    prompt_plugins = _document_plugins(prompts_document["data"], "Prompts")
    current_prompt_items = prompt_plugins.get(plugin_key, {}).get("items", [])
    if current_prompt_items:
        raise LegacyMigrationError("目标 Prompts 已有资料")

    workflows_document = store.read_document("workflows")
    workflow_plugins = _document_plugins(workflows_document["data"], "流程")
    current_workflow = workflow_plugins.get(plugin_key)
    if current_workflow is not None and not _is_default_workflow(current_workflow, plugin_key):
        raise LegacyMigrationError("目标流程已有资料")

    catalog = store.read_document("catalog")
    catalog_plugins = _document_plugins(catalog["data"], "插件目录")
    record = catalog_plugins.get(plugin_key)
    if not isinstance(record, dict):
        raise LegacyMigrationError("迁移目标插件尚未纳入")

    next_prompts = deepcopy(prompt_plugins)
    next_prompts[plugin_key] = {"items": deepcopy(candidate["prompts"]["items"])}
    next_workflows = deepcopy(workflow_plugins)
    next_workflows[plugin_key] = deepcopy(candidate["workflow"])
    snapshot_id = store.put_snapshot(plugin_key, candidate["snapshot"])
    next_catalog = deepcopy(catalog_plugins)
    history = list(record.get("history", []))
    if snapshot_id not in history:
        history.append(snapshot_id)
    next_catalog[plugin_key] = {
        "activeSnapshot": snapshot_id,
        "history": history,
        "plugin": deepcopy(candidate["snapshot"]["plugin"]),
    }
    receipt = {
        "fingerprint": candidate["fingerprint"],
        "sourceUrl": candidate["sourceUrl"],
        "migratedAt": candidate["migratedAt"],
        "counts": deepcopy(candidate["counts"]),
        "snapshotId": snapshot_id,
    }
    next_migrations = deepcopy(migration_plugins)
    next_migrations[plugin_key] = receipt

    try:
        store.write_documents_batch({
            "prompts": ({"plugins": next_prompts}, prompts_document["revision"]),
            "workflows": ({"plugins": next_workflows}, workflows_document["revision"]),
            "catalog": ({"plugins": next_catalog}, catalog["revision"]),
            "legacy-migrations": ({"plugins": next_migrations}, migrations["revision"]),
        })
    except (RevisionConflict, StorageError) as error:
        raise LegacyMigrationError("迁移资料写入失败") from error
    return {**receipt, "alreadyApplied": False}


def _project_prompts(payload: dict[str, Any], plugin_key: str) -> dict[str, Any]:
    if set(payload) != {"schemaVersion", "data"} or not isinstance(payload["data"], dict):
        raise LegacyMigrationError("旧 Prompt 资料结构无效")
    data = payload["data"]
    if set(data) != {"revision", "items"} or not isinstance(data["items"], list):
        raise LegacyMigrationError("旧 Prompt 资料结构无效")
    items = []
    for item in data["items"]:
        if not isinstance(item, dict) or set(item) != {"id", "scenario", "prompt", "createdAt"}:
            raise LegacyMigrationError("旧 Prompt 项目结构无效")
        items.append({
            "id": item["id"],
            "scenario": item["scenario"],
            "content": item["prompt"],
            "createdAt": item["createdAt"],
        })
    return {"pluginKey": plugin_key, "items": items}


def _project_snapshot(portal_data: dict[str, Any], current: dict[str, Any], timestamp: str) -> dict[str, Any]:
    skills = portal_data.get("skills")
    if not isinstance(skills, list):
        raise LegacyMigrationError("旧 Skills 资料结构无效")
    visible_ids: list[str] = []
    for item in skills:
        if not isinstance(item, dict) or not isinstance(item.get("skillId"), str):
            raise LegacyMigrationError("旧 Skills 资料结构无效")
        visible_ids.append(item["skillId"])
    if len(set(visible_ids)) != len(visible_ids):
        raise LegacyMigrationError("旧 Skills 清单重复")
    current_skills = current.get("skills")
    if not isinstance(current_skills, list):
        raise LegacyMigrationError("当前 Skills 快照无效")
    by_id = {item.get("id"): item for item in current_skills if isinstance(item, dict)}
    projected_skills = [deepcopy(by_id[skill_id]) for skill_id in visible_ids if skill_id in by_id]

    extensions = portal_data.get("extensions")
    if not isinstance(extensions, dict) or set(extensions) != {"categories"} or not isinstance(extensions["categories"], list):
        raise LegacyMigrationError("旧扩展工具资料结构无效")
    tools: list[dict[str, str]] = []
    seen: set[str] = set()
    try:
        for category in extensions["categories"]:
            if not isinstance(category, dict) or not isinstance(category.get("items"), list):
                raise LegacyMigrationError("旧扩展工具资料结构无效")
            for item in category["items"]:
                if not isinstance(item, dict):
                    raise LegacyMigrationError("旧扩展工具资料结构无效")
                tool_id = _require_id(item.get("id"), "扩展工具 ID")
                if tool_id in seen:
                    raise LegacyMigrationError("旧扩展工具 ID 重复")
                seen.add(tool_id)
                tools.append({
                    "id": tool_id,
                    "name": require_public_text(item.get("name"), "扩展工具名称", single_line=True),
                    "purpose": require_public_text(item.get("description"), "扩展工具用途"),
                    "url": require_https_url(item.get("website"), "扩展工具链接"),
                })
    except PublicTextError as error:
        raise LegacyMigrationError(str(error)) from error

    projected = {
        "schemaVersion": current.get("schemaVersion"),
        "plugin": deepcopy(current.get("plugin")),
        "skills": projected_skills,
        "mcp": deepcopy(current.get("mcp")),
        "extensionTools": tools,
        "engineeringRules": deepcopy(current.get("engineeringRules")),
    }
    digest = hashlib.sha256(canonical_json_bytes(projected)).hexdigest()
    return {
        **projected,
        "provenance": {
            "packageDigest": f"sha256:{digest}",
            "adapterVersion": "legacy-migration-1.0.0",
            "importedAt": timestamp,
        },
    }


def _project_workflow(portal_data: dict[str, Any], plugin_key: str) -> dict[str, Any]:
    guide = portal_data.get("guide")
    if not isinstance(guide, dict):
        raise LegacyMigrationError("旧鸟瞰全景资料结构无效")
    required = {"installationWorkflows", "designWorkflows", "workflow", "issueBoardWorkflow"}
    if not required.issubset(guide):
        raise LegacyMigrationError("旧鸟瞰全景资料不完整")
    tabs = [
        {"id": "plugin-installation", "title": "插件安装", "sections": _project_sections(guide["installationWorkflows"], branched=True)},
        {"id": "design-delivery", "title": "设计交付", "sections": _project_sections(guide["designWorkflows"], branched=False)},
        {"id": "code-delivery", "title": "代码交付", "sections": [{
            "id": "code-delivery-flow",
            "title": "研发交付流程",
            "steps": _linear_steps("code-delivery-flow", guide["workflow"]),
        }]},
        {"id": "issue-board-loop", "title": "看板闭环", "sections": [{
            "id": "issue-board-flow",
            "title": "问题处理闭环",
            "steps": _linear_steps("issue-board-flow", guide["issueBoardWorkflow"]),
        }]},
    ]
    return {"pluginKey": plugin_key, "tabs": tabs}


def _project_sections(value: object, *, branched: bool) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise LegacyMigrationError("旧流程区域结构无效")
    sections = []
    for section in value:
        if not isinstance(section, dict) or not isinstance(section.get("workflow"), list):
            raise LegacyMigrationError("旧流程区域结构无效")
        section_id = _require_id(section.get("id"), "流程区域 ID")
        title = _public_line(section.get("title"), "流程区域标题")
        steps = _branched_steps(section_id, section["workflow"]) if branched else _linear_steps(section_id, section["workflow"])
        sections.append({"id": section_id, "title": title, "steps": steps})
    return sections


def _branched_steps(prefix: str, value: list[object]) -> list[dict[str, Any]]:
    groups: list[list[dict[str, Any]]] = []
    for index, raw in enumerate(value, 1):
        if not isinstance(raw, dict):
            raise LegacyMigrationError("旧安装流程结构无效")
        node_id = _require_id(raw.get("id", f"step-{index}"), "安装步骤 ID")
        kind = raw.get("kind")
        if kind == "common":
            groups.append([_legacy_step(f"{prefix}-{node_id}", raw)])
        elif kind == "platform-branch" and isinstance(raw.get("branches"), list) and raw["branches"]:
            branch_group = []
            for branch in raw["branches"]:
                if not isinstance(branch, dict):
                    raise LegacyMigrationError("旧并行步骤结构无效")
                platform = _require_id(branch.get("platform"), "并行步骤平台")
                branch_group.append(_legacy_step(f"{prefix}-{node_id}-{platform}", branch))
            groups.append(branch_group)
        else:
            raise LegacyMigrationError("旧安装流程类型无效")
    flattened: list[dict[str, Any]] = []
    for index, group in enumerate(groups):
        targets = [item["id"] for item in groups[index + 1]] if index + 1 < len(groups) else []
        for step in group:
            step["next"] = targets
            flattened.append(step)
    return flattened


def _linear_steps(prefix: str, value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise LegacyMigrationError("旧线性流程结构无效")
    steps = []
    for index, raw in enumerate(value, 1):
        if not isinstance(raw, dict):
            raise LegacyMigrationError("旧线性步骤结构无效")
        suffix = raw.get("id", f"step-{index}")
        suffix = _require_id(suffix, "流程步骤 ID")
        steps.append(_legacy_step(f"{prefix}-{suffix}", raw))
    for index, step in enumerate(steps[:-1]):
        step["next"] = [steps[index + 1]["id"]]
    return steps


def _legacy_step(step_id: str, raw: dict[str, Any]) -> dict[str, Any]:
    detail = _public_text(raw.get("detail", raw.get("description", "")), "步骤说明", allow_empty=True)
    gate = _public_text(raw.get("gate", ""), "步骤门禁", allow_empty=True)
    description = detail if not gate else f"{detail}\n门禁：{gate}" if detail else f"门禁：{gate}"
    return {
        "id": _require_id(step_id, "流程步骤 ID"),
        "label": _public_line(raw.get("step", raw.get("title")), "流程步骤角标"),
        "title": _public_line(raw.get("title"), "流程步骤标题"),
        "description": description,
        "next": [],
    }


def _public_line(value: object, field: str) -> str:
    try:
        return require_public_text(value, field, single_line=True)
    except PublicTextError as error:
        raise LegacyMigrationError(str(error)) from error


def _public_text(value: object, field: str, *, allow_empty: bool) -> str:
    if allow_empty and value == "":
        return ""
    try:
        return require_public_text(value, field)
    except PublicTextError as error:
        raise LegacyMigrationError(str(error)) from error


def _require_id(value: object, field: str) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise LegacyMigrationError(f"{field} 无效")
    return value


def _document_plugins(data: object, field: str) -> dict[str, Any]:
    if data == {}:
        return {}
    if not isinstance(data, dict) or set(data) != {"plugins"} or not isinstance(data["plugins"], dict):
        raise LegacyMigrationError(f"{field} 存储结构无效")
    return data["plugins"]


def _is_default_workflow(value: object, plugin_key: str) -> bool:
    if value == {"pluginKey": plugin_key, "tabs": []}:
        return True
    if not isinstance(value, dict) or value.get("pluginKey") != plugin_key:
        return False
    tabs = value.get("tabs")
    return (
        isinstance(tabs, list)
        and len(tabs) == 1
        and isinstance(tabs[0], dict)
        and tabs[0].get("title") == "新 Tab"
        and tabs[0].get("sections") == []
    )


def _read_json(opener: urllib.request.OpenerDirector, url: str, maximum: int) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with opener.open(request, timeout=_SOURCE_TIMEOUT_SECONDS) as response:
        length = response.headers.get("Content-Length")
        if length is not None and int(length) > maximum:
            raise LegacyMigrationError("旧 Portal 回应过大")
        payload = response.read(maximum + 1)
    if len(payload) > maximum:
        raise LegacyMigrationError("旧 Portal 回应过大")
    value = json.loads(payload.decode("utf-8"))
    if not isinstance(value, dict):
        raise LegacyMigrationError("旧 Portal 回应必须是对象")
    return value
