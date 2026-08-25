from __future__ import annotations

import re
from urllib.parse import urlparse


class PublicTextError(ValueError):
    """Raised when text is unsafe for the read-only public projection."""


_WINDOWS_PATH = re.compile(r"(?i)(?:[a-z]:\\|\\\\[^\\\s]+\\)")
_UNIX_PRIVATE_PATH = re.compile(r"(?i)(?:^|[\s('`\"])/(?:users|home|etc|var|tmp|opt)/")
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b(?:access[_-]?token|api[_-]?key|password|passwd|secret|cookie|authorization)\b\s*[:=]\s*\S+"
)
_RAW_EXCEPTION = re.compile(r"(?im)^(?:traceback \(most recent call last\):|\s*at\s+\S+\([^\n]+:\d+)")
_HTML = re.compile(r"<\s*/?\s*[a-zA-Z][^>]*>")
_MARKDOWN_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_MARKDOWN_LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)]+)\)")


def require_public_text(value: object, field: str, *, single_line: bool = False) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PublicTextError(f"{field} 必须是非空文字")
    text = value.strip()
    if "\x00" in text or any(ord(character) < 32 and character not in "\r\n\t" for character in text):
        raise PublicTextError(f"{field} 包含控制字符")
    if single_line and ("\r" in text or "\n" in text):
        raise PublicTextError(f"{field} 必须是单行文字")
    if _WINDOWS_PATH.search(text) or _UNIX_PRIVATE_PATH.search(text):
        raise PublicTextError(f"{field} 包含本机路径")
    if _SECRET_ASSIGNMENT.search(text):
        raise PublicTextError(f"{field} 包含私密赋值")
    if _RAW_EXCEPTION.search(text):
        raise PublicTextError(f"{field} 包含原始异常")
    return text


def require_safe_markdown(value: object, field: str) -> str:
    text = require_public_text(value, field)
    if _HTML.search(text):
        raise PublicTextError(f"{field} 包含内嵌 HTML")
    if _MARKDOWN_IMAGE.search(text):
        raise PublicTextError(f"{field} 包含远端活动内容")
    for match in _MARKDOWN_LINK.finditer(text):
        destination = match.group(1).strip().split(maxsplit=1)[0].strip("<>")
        if destination.startswith("#"):
            continue
        require_https_url(destination, field)
    return text


def require_https_url(value: object, field: str) -> str:
    text = require_public_text(value, field, single_line=True)
    parsed = urlparse(text)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise PublicTextError(f"{field} 必须是安全 HTTPS 链接")
    return text
