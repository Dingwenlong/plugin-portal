from __future__ import annotations

import argparse
import json
from pathlib import Path

from plugin_portal.server import create_server


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--web-root", type=Path, required=True)
    parser.add_argument("--picker-root", type=Path, required=True)
    arguments = parser.parse_args()
    server = create_server(
        host="127.0.0.1",
        port=0,
        data_root=arguments.data_root,
        web_root=arguments.web_root,
        test_only=True,
        directory_picker=lambda: arguments.picker_root,
    )
    server.api.download_probe = lambda url: "project-delivery-hub" in url
    print(json.dumps({"port": server.server_address[1]}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
