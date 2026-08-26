from __future__ import annotations

import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from plugin_portal.legacy_migration import (
    LegacyMigrationError,
    apply_legacy_candidate,
    build_legacy_candidate,
    validate_legacy_source_url,
)
from plugin_portal.storage import PortalStore, StorageError


PLUGIN_KEY = "company-dev/project-delivery-hub"


def sample_snapshot() -> dict:
    return {
        "schemaVersion": "1.0.0",
        "plugin": {
            "target": "company-dev",
            "id": "project-delivery-hub",
            "name": "研发助手插件",
            "version": "3.7.17",
            "summary": "公开说明",
        },
        "skills": [
            {"id": "code-development", "name": "业务代码开发", "description": "开发。"},
            {"id": "code-style-reviewer", "name": "历史审查", "description": "迁移诊断。"},
        ],
        "mcp": [{"id": "project-delivery-hub-enterprise"}],
        "extensionTools": [],
        "engineeringRules": [],
        "provenance": {
            "packageDigest": f"sha256:{'a' * 64}",
            "adapterVersion": "1.0.0",
            "importedAt": "2026-08-25T00:00:00Z",
        },
    }


def sample_portal_data() -> dict:
    return {
        "skills": [
            {
                "skillId": "code-development",
                "displayName": "业务代码开发",
            }
        ],
        "extensions": {
            "categories": [
                {
                    "id": "plugins",
                    "items": [
                        {
                            "id": "sonarqube",
                            "name": "SonarQube",
                            "description": "检查代码质量与安全问题。",
                            "website": "https://www.sonarsource.com",
                        }
                    ],
                }
            ]
        },
        "guide": {
            "installationWorkflows": [
                {
                    "id": "first-install",
                    "title": "首次安装并配置",
                    "workflow": [
                        {"id": "package", "kind": "common", "step": "准备", "title": "取得正式插件包", "detail": "取得插件包。"},
                        {
                            "id": "client-install",
                            "kind": "platform-branch",
                            "title": "客户端安装",
                            "branches": [
                                {"platform": "codex", "step": "Codex", "title": "安装到 Codex", "detail": "安装。"},
                                {"platform": "claude-code", "step": "Claude Code", "title": "安装到 Claude Code", "detail": "安装。"},
                            ],
                        },
                        {"id": "verify", "kind": "common", "step": "验证", "title": "确认安装可用", "detail": "确认。"},
                    ],
                }
            ],
            "designWorkflows": [
                {"id": "new-feature", "title": "新功能设计交付", "workflow": [{"step": "资料", "title": "建立引用单元快照", "detail": "建立快照。", "gate": "缺少资料时停止。"}]}
            ],
            "workflow": [
                {"id": "intake", "title": "需求确认", "description": "确认目标。", "skill": {"id": "delivery-hub-navigator", "title": "交付导航", "description": "导航。"}, "evidence": []}
            ],
            "issueBoardWorkflow": [
                {"step": "调查", "title": "读取看板问题", "detail": "读取问题。", "gate": "资料不足时停止。"}
            ],
        },
    }


def sample_prompts() -> dict:
    return {
        "schemaVersion": "1.0.0",
        "data": {
            "revision": 5,
            "items": [
                {
                    "id": "prompt-1",
                    "scenario": "我自主规划，AI完成后",
                    "prompt": "关于当前情况，我最大的遗漏是什么？",
                    "createdAt": "2026-08-12T07:38:30.798Z",
                }
            ],
        },
    }


class LegacyMigrationProjectionTests(unittest.TestCase):
    def test_builds_closed_prompt_workflow_tool_and_skill_candidate(self) -> None:
        candidate = build_legacy_candidate(
            portal_data=sample_portal_data(),
            prompt_payload=sample_prompts(),
            current_snapshot=sample_snapshot(),
            plugin_key=PLUGIN_KEY,
            source_url="http://127.0.0.1:9136/project-delivery-hub",
            migrated_at="2026-08-26T00:00:00Z",
        )

        self.assertEqual(candidate["prompts"]["items"], [{
            "id": "prompt-1",
            "scenario": "我自主规划，AI完成后",
            "content": "关于当前情况，我最大的遗漏是什么？",
            "createdAt": "2026-08-12T07:38:30.798Z",
        }])
        self.assertEqual([tab["title"] for tab in candidate["workflow"]["tabs"]], ["插件安装", "设计交付", "代码交付", "看板闭环"])
        install_steps = candidate["workflow"]["tabs"][0]["sections"][0]["steps"]
        self.assertEqual(install_steps[0]["next"], ["first-install-client-install-codex", "first-install-client-install-claude-code"])
        self.assertEqual(install_steps[1]["next"], ["first-install-verify"])
        self.assertEqual(install_steps[2]["next"], ["first-install-verify"])
        self.assertEqual(candidate["snapshot"]["skills"], [sample_snapshot()["skills"][0]])
        self.assertEqual(candidate["snapshot"]["extensionTools"], [{
            "id": "sonarqube",
            "name": "SonarQube",
            "purpose": "检查代码质量与安全问题。",
            "url": "https://www.sonarsource.com",
        }])
        self.assertEqual(candidate["counts"], {"prompts": 1, "tabs": 4, "extensionTools": 1, "skills": 1})

    def test_fingerprint_is_stable_across_preview_and_apply_times(self) -> None:
        first = build_legacy_candidate(
            portal_data=sample_portal_data(),
            prompt_payload=sample_prompts(),
            current_snapshot=sample_snapshot(),
            plugin_key=PLUGIN_KEY,
            source_url="http://127.0.0.1:9136/project-delivery-hub",
            migrated_at="2026-08-26T00:00:00Z",
        )
        second = build_legacy_candidate(
            portal_data=sample_portal_data(),
            prompt_payload=sample_prompts(),
            current_snapshot=sample_snapshot(),
            plugin_key=PLUGIN_KEY,
            source_url="http://127.0.0.1:9136/project-delivery-hub",
            migrated_at="2026-08-26T00:01:00Z",
        )

        self.assertEqual(first["fingerprint"], second["fingerprint"])

    def test_rejects_external_or_credentialed_source_urls(self) -> None:
        for value in (
            "https://127.0.0.1:9136",
            "http://example.com:9136",
            "http://user:pass@127.0.0.1:9136",
            "http://127.0.0.1:9136/path?token=secret",
        ):
            with self.subTest(value=value), self.assertRaises(LegacyMigrationError):
                validate_legacy_source_url(value)


class LegacyMigrationApplyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_directory.cleanup)
        self.store = PortalStore(Path(self.temp_directory.name))
        snapshot = sample_snapshot()
        snapshot_id = self.store.put_snapshot(PLUGIN_KEY, snapshot)
        self.store.write_document("catalog", {"plugins": {PLUGIN_KEY: {
            "activeSnapshot": snapshot_id,
            "history": [snapshot_id],
            "plugin": deepcopy(snapshot["plugin"]),
        }}}, expected_revision=0)

    def test_applies_once_and_keeps_other_plugins_isolated(self) -> None:
        candidate = build_legacy_candidate(
            portal_data=sample_portal_data(),
            prompt_payload=sample_prompts(),
            current_snapshot=sample_snapshot(),
            plugin_key=PLUGIN_KEY,
            source_url="http://127.0.0.1:9136/project-delivery-hub",
            migrated_at="2026-08-26T00:00:00Z",
        )
        receipt = apply_legacy_candidate(self.store, candidate)

        self.assertFalse(receipt["alreadyApplied"])
        self.assertEqual(self.store.read_document("prompts")["data"]["plugins"][PLUGIN_KEY]["items"][0]["scenario"], "我自主规划，AI完成后")
        self.assertNotIn("company-dev/yusheng-inc", self.store.read_document("workflows")["data"]["plugins"])
        repeat = apply_legacy_candidate(self.store, candidate)
        self.assertTrue(repeat["alreadyApplied"])

    def test_rejects_non_default_target_without_overwriting(self) -> None:
        self.store.write_document("prompts", {"plugins": {PLUGIN_KEY: {"items": [{
            "id": "existing",
            "scenario": "保留",
            "content": "既有资料",
            "createdAt": "2026-08-26T00:00:00Z",
        }]}}}, expected_revision=0)
        candidate = build_legacy_candidate(
            portal_data=sample_portal_data(),
            prompt_payload=sample_prompts(),
            current_snapshot=sample_snapshot(),
            plugin_key=PLUGIN_KEY,
            source_url="http://127.0.0.1:9136/project-delivery-hub",
            migrated_at="2026-08-26T00:00:00Z",
        )

        with self.assertRaisesRegex(LegacyMigrationError, "目标 Prompts 已有资料"):
            apply_legacy_candidate(self.store, candidate)
        self.assertEqual(self.store.read_document("prompts")["revision"], 1)

    def test_restores_every_document_when_batch_application_fails(self) -> None:
        candidate = build_legacy_candidate(
            portal_data=sample_portal_data(),
            prompt_payload=sample_prompts(),
            current_snapshot=sample_snapshot(),
            plugin_key=PLUGIN_KEY,
            source_url="http://127.0.0.1:9136/project-delivery-hub",
            migrated_at="2026-08-26T00:00:00Z",
        )
        original_write = self.store._atomic_write_json
        failed = False

        def fail_workflow_once(path: Path, value: object) -> None:
            nonlocal failed
            if path.name == "workflows.json" and not failed:
                failed = True
                raise StorageError("模拟批次写入失败")
            original_write(path, value)

        with patch.object(self.store, "_atomic_write_json", side_effect=fail_workflow_once):
            with self.assertRaisesRegex(LegacyMigrationError, "迁移资料写入失败"):
                apply_legacy_candidate(self.store, candidate)

        self.assertEqual(self.store.read_document("prompts"), {"revision": 0, "data": {}})
        self.assertEqual(self.store.read_document("workflows"), {"revision": 0, "data": {}})
        self.assertEqual(self.store.read_document("catalog")["revision"], 1)
        self.assertEqual(self.store.read_document("legacy-migrations"), {"revision": 0, "data": {}})


if __name__ == "__main__":
    unittest.main()
