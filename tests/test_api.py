import json
import shutil
import tempfile
import unittest
from pathlib import Path

from plugin_portal.api import ApiError, PortalApi
from plugin_portal.storage import PortalStore


class PortalApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_directory.cleanup)
        self.root = Path(self.temp_directory.name)
        fixture = Path(__file__).parent / "fixtures" / "plugins" / "minimal"
        self.plugin_root = self.root / "source" / "sample-plugin"
        shutil.copytree(fixture, self.plugin_root)
        self.store = PortalStore(self.root / "data")
        self.api = PortalApi(self.store)
        self.token = self.api.create_session()["token"]

    def preview(self) -> dict:
        return self.api.preview_import(
            self.token,
            {
                "pluginRoot": str(self.plugin_root),
                "target": "company-dev",
                "expectedPluginId": "sample-plugin",
                "approvedRulePaths": ["rules/public.md"],
                "extensionTools": [],
            },
        )

    def test_preview_does_not_change_persisted_catalog_or_leak_source_path(self) -> None:
        preview = self.preview()

        self.assertEqual(self.store.read_document("catalog"), {"revision": 0, "data": {}})
        self.assertEqual(preview["pluginKey"], "company-dev/sample-plugin")
        self.assertIn("candidateId", preview)
        self.assertNotIn(str(self.plugin_root), json.dumps(preview, ensure_ascii=False))

    def test_promote_switches_active_snapshot_and_returns_new_revision(self) -> None:
        preview = self.preview()

        promoted = self.api.promote(
            self.token,
            "company-dev/sample-plugin",
            {"candidateId": preview["candidateId"], "expectedRevision": 0},
        )

        self.assertEqual(promoted["revision"], 1)
        plugins = self.api.list_plugins()
        self.assertEqual(plugins["revision"], 1)
        self.assertEqual(plugins["items"][0]["pluginKey"], "company-dev/sample-plugin")
        self.assertEqual(plugins["items"][0]["version"], "1.2.3")
        snapshot = self.api.get_snapshot("company-dev/sample-plugin")
        self.assertEqual(snapshot["plugin"]["id"], "sample-plugin")

    def test_refresh_and_rollback_are_revision_guarded(self) -> None:
        first = self.preview()
        self.api.promote(
            self.token,
            "company-dev/sample-plugin",
            {"candidateId": first["candidateId"], "expectedRevision": 0},
        )
        manifest_path = self.plugin_root / ".codex-plugin" / "plugin.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["version"] = "1.2.4"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        second = self.preview()
        self.api.promote(
            self.token,
            "company-dev/sample-plugin",
            {"candidateId": second["candidateId"], "expectedRevision": 1},
        )

        with self.assertRaisesRegex(ApiError, "资料已更新"):
            self.api.rollback(
                self.token,
                "company-dev/sample-plugin",
                {"expectedRevision": 1},
            )

        rolled_back = self.api.rollback(
            self.token,
            "company-dev/sample-plugin",
            {"expectedRevision": 2},
        )
        self.assertEqual(rolled_back["revision"], 3)
        self.assertEqual(self.api.get_snapshot("company-dev/sample-plugin")["plugin"]["version"], "1.2.3")

    def test_promote_uses_frozen_candidate_after_source_disappears(self) -> None:
        preview = self.preview()
        shutil.rmtree(self.plugin_root)

        promoted = self.api.promote(
            self.token,
            "company-dev/sample-plugin",
            {"candidateId": preview["candidateId"], "expectedRevision": 0},
        )

        self.assertEqual(promoted["revision"], 1)

    def test_rejects_wrong_session_candidate_or_plugin_identity(self) -> None:
        preview = self.preview()
        another_token = self.api.create_session()["token"]

        with self.assertRaisesRegex(ApiError, "候选不存在"):
            self.api.promote(
                another_token,
                "company-dev/sample-plugin",
                {"candidateId": preview["candidateId"], "expectedRevision": 0},
            )
        with self.assertRaisesRegex(ApiError, "插件身份不一致"):
            self.api.promote(
                self.token,
                "company-dev/another-plugin",
                {"candidateId": preview["candidateId"], "expectedRevision": 0},
            )

    def test_errors_do_not_echo_plugin_source_path(self) -> None:
        missing = self.root / "private" / "missing-plugin"

        with self.assertRaises(ApiError) as caught:
            self.api.preview_import(
                self.token,
                {
                    "pluginRoot": str(missing),
                    "target": "company-dev",
                    "expectedPluginId": "missing-plugin",
                    "approvedRulePaths": [],
                    "extensionTools": [],
                },
            )

        self.assertNotIn(str(missing), str(caught.exception))

    def test_prompts_and_workflows_are_available_through_the_same_session_api(self) -> None:
        plugin_key = "company-dev/sample-plugin"
        prompts = self.api.save_prompts(
            self.token,
            plugin_key,
            {
                "expectedRevision": 0,
                "items": [{"id": "check", "scenario": "检查", "content": "检查内容", "createdAt": "2026-08-26T00:00:00Z"}],
            },
        )
        self.assertEqual(prompts["revision"], 1)
        self.assertEqual(self.api.get_prompts(plugin_key)["items"][0]["id"], "check")
        self.assertEqual(self.api.get_prompts("company-dev/yusheng-inc")["items"], [])

        workflow = {
            "pluginKey": plugin_key,
            "tabs": [
                {
                    "id": "installation",
                    "title": "插件安装",
                    "sections": [
                        {
                            "id": "first",
                            "title": "首次安装",
                            "steps": [
                                {
                                    "id": "prepare",
                                    "label": "准备",
                                    "title": "取得插件包",
                                    "description": "",
                                    "next": [],
                                }
                            ],
                        }
                    ],
                }
            ],
        }
        saved = self.api.save_workflows(
            self.token,
            plugin_key,
            {"expectedRevision": 0, "workflow": workflow},
        )
        self.assertEqual(saved["revision"], 1)
        self.assertEqual(self.api.get_workflows(plugin_key)["tabs"][0]["id"], "installation")

        with self.assertRaisesRegex(ApiError, "会话无效"):
            self.api.save_prompts("wrong-token", plugin_key, {"expectedRevision": 1, "items": []})


if __name__ == "__main__":
    unittest.main()
