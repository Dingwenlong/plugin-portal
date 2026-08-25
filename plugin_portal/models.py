from __future__ import annotations

import json
import re
from typing import Any


class ModelValidationError(ValueError):
    """Raised when a public or locally persisted model is not closed and valid."""


_IDENTIFIER = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")


def parse_plugin_key(plugin_key: str) -> tuple[str, str]:
    if not isinstance(plugin_key, str):
        raise ModelValidationError("插件身份必须是字符串")

    parts = plugin_key.split("/")
    if len(parts) != 2 or not all(_IDENTIFIER.fullmatch(part) for part in parts):
        raise ModelValidationError("插件身份必须使用 target/pluginId")
    return parts[0], parts[1]


def canonical_json_bytes(value: Any) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ModelValidationError("资料不是有效 JSON") from error


def validate_revisioned_document(value: object) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"revision", "data"}:
        raise ModelValidationError("资料文件结构无效")

    revision = value["revision"]
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
        raise ModelValidationError("revision 必须是非负整数")
    if not isinstance(value["data"], dict):
        raise ModelValidationError("data 必须是对象")
    return value
