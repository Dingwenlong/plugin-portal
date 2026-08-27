from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .legacy_migration import (
    LegacyMigrationError,
    apply_legacy_candidate,
    build_legacy_candidate,
    fetch_legacy_source,
)
from .server import ServerConfigurationError, create_server
from .storage import PortalStore, StorageError


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="plugin-portal", description="Plugin Portal 本机服务")
    subparsers = parser.add_subparsers(dest="command", required=True)
    serve = subparsers.add_parser("serve", help="启动本机 Portal")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=9137)
    serve.add_argument("--read-only", action="store_true", help="局域网只读模式，禁止管理和编辑")
    serve.add_argument("--data-root", type=Path, required=True)
    serve.add_argument("--web-root", type=Path, required=True)
    migrate = subparsers.add_parser("migrate-legacy", help="从旧版本机 Portal 一次性迁移资料")
    migrate.add_argument("--source-url", required=True)
    migrate.add_argument("--plugin-key", required=True)
    migrate.add_argument("--data-root", type=Path, required=True)
    mode = migrate.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preview", action="store_true")
    mode.add_argument("--apply", action="store_true")
    return parser


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    arguments = build_parser().parse_args()
    if arguments.command == "migrate-legacy":
        return _migrate_legacy(arguments)
    if arguments.command != "serve":
        return 2
    try:
        server = create_server(
            host=arguments.host,
            port=arguments.port,
            data_root=arguments.data_root,
            web_root=arguments.web_root,
            read_only=arguments.read_only,
        )
    except (OSError, ServerConfigurationError) as error:
        print(f"Plugin Portal 启动失败：{error}")
        return 1

    print(f"Plugin Portal 已监听 http://{server.server_address[0]}:{server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


def _migrate_legacy(arguments: argparse.Namespace) -> int:
    try:
        store = PortalStore(arguments.data_root)
        catalog = store.read_document("catalog")
        plugins = catalog["data"].get("plugins") if isinstance(catalog["data"], dict) else None
        record = plugins.get(arguments.plugin_key) if isinstance(plugins, dict) else None
        if not isinstance(record, dict) or not isinstance(record.get("activeSnapshot"), str):
            raise LegacyMigrationError("迁移目标插件尚未纳入")
        current_snapshot = store.read_snapshot(arguments.plugin_key, record["activeSnapshot"])
        portal_data, prompts = fetch_legacy_source(arguments.source_url)
        candidate = build_legacy_candidate(
            portal_data=portal_data,
            prompt_payload=prompts,
            current_snapshot=current_snapshot,
            plugin_key=arguments.plugin_key,
            source_url=arguments.source_url,
        )
        if arguments.preview:
            result = {
                "mode": "preview",
                "pluginKey": candidate["pluginKey"],
                "sourceUrl": candidate["sourceUrl"],
                "counts": candidate["counts"],
                "fingerprint": candidate["fingerprint"],
            }
        else:
            result = {"mode": "apply", "pluginKey": candidate["pluginKey"], **apply_legacy_candidate(store, candidate)}
    except (LegacyMigrationError, StorageError, OSError) as error:
        print(f"旧版资料迁移失败：{error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
