from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit

from plugin_portal.download_publication import DownloadPublisher, PluginReleaseAudit
from plugin_portal.server import create_server


class DeterministicAuditor:
    def __init__(self, version: str):
        self.version = version

    def audit(self, path: Path, *, plugin_id: str, target: str, expected_sha256: str):
        payload = path.read_bytes()
        if hashlib.sha256(payload).hexdigest() != expected_sha256:
            raise RuntimeError("test candidate digest mismatch")
        return PluginReleaseAudit(
            plugin_id=plugin_id,
            target=target,
            version=self.version,
            candidate_sha256=expected_sha256,
            file_set_sha256="b" * 64,
            file_count=3,
            archive_bytes=len(payload),
            tool_version="1.0.1",
            status="audited",
            warnings=(),
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--web-root", type=Path, required=True)
    parser.add_argument("--picker-root", type=Path, required=True)
    parser.add_argument("--archive-path", type=Path, required=True)
    parser.add_argument("--download-root", type=Path, required=True)
    parser.add_argument("--candidate-version", required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--read-only", action="store_true")
    mode.add_argument("--remote-management", action="store_true")
    parser.add_argument("--https-origin")
    arguments = parser.parse_args()
    publisher = None
    if not arguments.read_only:
        def readback(file_name: str) -> tuple[int, str]:
            payload = (arguments.download_root / file_name).read_bytes()
            return len(payload), hashlib.sha256(payload).hexdigest()

        publisher = DownloadPublisher(
            download_root=arguments.download_root,
            receipt_root=arguments.data_root / "download-publications",
            auditor=DeterministicAuditor(arguments.candidate_version),
            download_reader=readback,
        )
    server = create_server(
        host="127.0.0.1",
        port=0,
        data_root=arguments.data_root,
        web_root=arguments.web_root,
        test_only=True,
        read_only=arguments.read_only,
        remote_management=arguments.remote_management,
        https_origin=arguments.https_origin,
        directory_picker=lambda: arguments.picker_root,
        archive_picker=lambda: arguments.archive_path,
        download_publisher=publisher,
    )
    server.api.download_probe = lambda url: (
        (arguments.download_root / Path(urlsplit(url).path).name).is_file()
    )
    print(json.dumps({"port": server.server_address[1]}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
