"""Loopback-only, read-only serving of an already published download share.

No plugin runtime, Prompts backend, package activation or directory browsing.
IIS remains the LAN entry point; files are never written by this process.
"""
from __future__ import annotations

import argparse
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import mimetypes
import os
from pathlib import Path
import re
import shutil
import stat
from urllib.parse import unquote, urlsplit


DOWNLOAD_NAME = re.compile(
    r"[a-z0-9][a-z0-9._-]*(?:\.zip(?:\.sha256\.txt)?|\.manifest\.json(?:\.sha256\.txt)?|"
    r"-release-history-[a-z0-9-]+\.json)\Z", re.ASCII
)
STATIC_SUFFIXES = {".html", ".css", ".js", ".json", ".svg", ".png", ".jpg", ".jpeg",
                   ".webp", ".woff2", ".txt", ".md", ".docx", ".pdf"}


def assert_plain_path(path: Path) -> None:
    for entry in (path, *path.parents):
        info = entry.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & (
            stat.FILE_ATTRIBUTE_REPARSE_POINT | stat.FILE_ATTRIBUTE_ENCRYPTED
        ):
            raise ValueError("Linked or encrypted published paths are not allowed")


def validate_share(root: Path) -> Path:
    if not root.is_absolute() or root == Path(root.anchor) or ".." in root.parts or str(root).startswith("\\\\"):
        raise ValueError("An explicit local published share directory is required")
    assert_plain_path(root)
    if not root.is_dir() or not (root / "downloads").is_dir():
        raise ValueError("Published download directory is missing")
    assert_plain_path(root / "downloads")
    assert_plain_path(root / "project-delivery-hub/index.html")
    if getattr(root.stat(), "st_file_attributes", 0) & (stat.FILE_ATTRIBUTE_HIDDEN | stat.FILE_ATTRIBUTE_SYSTEM):
        raise ValueError("Published share must not be hidden")
    return root


class DownloadHandler(BaseHTTPRequestHandler):
    server_version = "PortalDownloads"
    sys_version = ""

    def __init__(self, *args, share_root: Path, **kwargs):
        self.share_root = share_root
        super().__init__(*args, **kwargs)

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, format, *args):
        # Do not retain requested paths, query strings or browser credentials.
        pass

    def reply(self, status: int, *, location: str | None = None):
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if location is not None:
            self.send_header("Location", location)
        self.end_headers()

    def public_path(self) -> Path | None:
        decoded = unquote(urlsplit(self.path).path, errors="strict")
        if not decoded.startswith("/") or any(character in decoded for character in "\\:%\x00"):
            return None
        parts = decoded[1:].split("/")
        if decoded == "/project-delivery-hub/":
            parts = ["project-delivery-hub", "index.html"]
        if any(not part or part.startswith(".") or part.endswith((".", " ")) or
               any(ord(character) < 32 for character in part) for part in parts):
            return None
        if parts[0] == "downloads":
            if len(parts) != 2 or ".." in parts[1] or not DOWNLOAD_NAME.fullmatch(parts[1]):
                return None
        elif parts[0] not in {"assets", "project-delivery-hub"} or Path(parts[-1]).suffix not in STATIC_SUFFIXES:
            return None
        path = self.share_root.joinpath(*parts)
        assert_plain_path(path)
        for entry in (path, *path.parents):
            if getattr(entry.stat(), "st_file_attributes", 0) & (stat.FILE_ATTRIBUTE_HIDDEN | stat.FILE_ATTRIBUTE_SYSTEM):
                return None
            if entry == self.share_root:
                break
        return path if path.is_file() else None

    def do_GET(self):
        response_started = False
        try:
            path_only = urlsplit(self.path).path
            if path_only in {"/", "/project-delivery-hub"}:
                self.reply(302, location="/project-delivery-hub/")
                return
            path = self.public_path()
            if path is None:
                self.reply(404)
                return
            # Open before headers; missing files are 404, other I/O failures are 503.
            with path.open("rb") as stream:
                content_type = {".js": "text/javascript", ".zip": "application/zip"}.get(
                    path.suffix, mimetypes.guess_type(str(path))[0] or "application/octet-stream"
                )
                size = os.fstat(stream.fileno()).st_size
                response_started = True
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(size))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                if self.command != "HEAD":
                    shutil.copyfileobj(stream, self.wfile, 1024 * 1024)
        except (FileNotFoundError, NotADirectoryError, ValueError, UnicodeError):
            if not response_started:
                self.reply(404)
            self.close_connection = True
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except OSError:
            if not response_started:
                self.reply(503)
            self.close_connection = True

    do_HEAD = do_GET

    def do_POST(self):
        self.reply(404 if self.path.startswith("/api/") else 405)

    do_PUT = do_POST
    do_PATCH = do_POST
    do_DELETE = do_POST
    do_OPTIONS = do_POST
    do_TRACE = do_POST


def create_server(share_root: Path, port: int) -> ThreadingHTTPServer:
    root = validate_share(share_root)
    return ThreadingHTTPServer(("127.0.0.1", port), partial(DownloadHandler, share_root=root))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--share-root", type=Path, required=True)
    parser.add_argument("--port", type=int, default=9136)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    validate_share(args.share_root)
    if args.check:
        print("Published share validated; no listener started.")
        return
    with create_server(args.share_root, args.port) as server:
        print(f"Read-only downloads ready on 127.0.0.1:{server.server_port}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
