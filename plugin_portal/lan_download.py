from __future__ import annotations

import http.client
import re
from urllib.parse import urlsplit


_DOWNLOAD_PATH = re.compile(r"^/downloads/[A-Za-z0-9][A-Za-z0-9._+-]*\.zip$")
_MAX_ARCHIVE_BYTES = 128 * 1024 * 1024


def read_download(url: str, *, head_only: bool = False) -> tuple[bytes, int]:
    """Read only a canonical package from the existing local download service."""
    parsed = urlsplit(url)
    if (parsed.scheme != "http" or parsed.netloc != "127.0.0.1:9134"
            or parsed.query or parsed.fragment or not _DOWNLOAD_PATH.fullmatch(parsed.path)):
        raise ValueError("下载地址无效")
    connection = http.client.HTTPConnection("127.0.0.1", 9134, timeout=15)
    try:
        connection.request("HEAD" if head_only else "GET", parsed.path, headers={"Accept": "application/zip"})
        response = connection.getresponse()
        mime = response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
        length = response.getheader("Content-Length", "")
        if (response.status != 200 or mime not in {"application/zip", "application/x-zip-compressed"}
                or not length.isascii() or not length.isdigit()
                or not 0 < int(length) <= _MAX_ARCHIVE_BYTES
                or response.getheader("Transfer-Encoding") or response.getheader("Content-Encoding")):
            raise ValueError("下载服务回应无效")
        payload = b"" if head_only else response.read(int(length) + 1)
        if not head_only and len(payload) != int(length):
            raise ValueError("下载内容不完整")
        return payload, int(length)
    finally:
        connection.close()
