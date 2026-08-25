from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .server import ServerConfigurationError, create_server


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="plugin-portal", description="Plugin Portal 本机服务")
    subparsers = parser.add_subparsers(dest="command", required=True)
    serve = subparsers.add_parser("serve", help="启动本机 Portal")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=9137)
    serve.add_argument("--data-root", type=Path, required=True)
    serve.add_argument("--web-root", type=Path, required=True)
    return parser


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    arguments = build_parser().parse_args()
    if arguments.command != "serve":
        return 2
    try:
        server = create_server(
            host=arguments.host,
            port=arguments.port,
            data_root=arguments.data_root,
            web_root=arguments.web_root,
        )
    except (OSError, ServerConfigurationError) as error:
        print(f"Plugin Portal 启动失败：{error}")
        return 1

    print(f"Plugin Portal 已监听 http://127.0.0.1:{server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
