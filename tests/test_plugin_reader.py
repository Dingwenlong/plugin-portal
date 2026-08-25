import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from plugin_portal.plugin_reader import PluginReadError, preview_plugin


class PluginReaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_directory.cleanup)
        fixture = Path(__file__).parent / "fixtures" / "plugins" / "minimal"
        self.plugin_root = Path(self.temp_directory.name) / "sample-plugin"
        shutil.copytree(fixture, self.plugin_root)

    def preview(self, **overrides: object) -> dict:
        arguments = {
            "target": "company-dev",
            "approved_rule_paths": ["rules/public.md"],
            "extension_tools": [
                {
                    "id": "allure-report",
                    "name": "Allure Report",
                    "purpose": "查看测试结果。",
                    "url": "https://allurereport.org/",
                }
            ],
            "imported_at": "2026-08-25T00:00:00Z",
        }
        arguments.update(overrides)
        return preview_plugin(self.plugin_root, **arguments)

    def test_projects_only_approved_public_fields(self) -> None:
        snapshot = self.preview()

        self.assertEqual(
            snapshot["plugin"],
            {
                "target": "company-dev",
                "id": "sample-plugin",
                "name": "示例插件",
                "version": "1.2.3",
                "summary": "公开的简短说明。",
            },
        )
        self.assertEqual(
            snapshot["skills"],
            [
                {
                    "id": "sample-skill",
                    "name": "sample-skill",
                    "description": "展示一个经过筛选的公开能力。",
                }
            ],
        )
        self.assertEqual(snapshot["mcp"], [{"id": "sample-service"}])
        self.assertEqual(
            snapshot["engineeringRules"],
            [{"path": "rules/public.md", "bodyMarkdown": "# 公开规范\n\n只展示经过人工批准的正文。"}],
        )
        self.assertRegex(snapshot["provenance"]["packageDigest"], r"^sha256:[0-9a-f]{64}$")

        serialized = json.dumps(snapshot, ensure_ascii=False)
        for private_value in ("command", "args", "env", str(self.plugin_root)):
            self.assertNotIn(private_value, serialized)

    def test_rejects_plugin_identity_mismatch(self) -> None:
        with self.assertRaisesRegex(PluginReadError, "插件身份不一致"):
            self.preview(expected_plugin_id="another-plugin")

    def test_rejects_unapproved_or_unsafe_rule_paths(self) -> None:
        outside = self.plugin_root.parent / "outside.md"
        outside.write_text("# outside", encoding="utf-8")

        for path in ("../outside.md", str(outside), "rules/public.txt"):
            with self.subTest(path=path):
                with self.assertRaises(PluginReadError):
                    self.preview(approved_rule_paths=[path])

    def test_rejects_linked_rule_file(self) -> None:
        link = self.plugin_root / "rules" / "linked.md"
        try:
            os.symlink(self.plugin_root.parent / "outside.md", link)
        except OSError as error:
            self.skipTest(f"当前平台无法建立测试链接：{error}")

        with self.assertRaises(PluginReadError):
            self.preview(approved_rule_paths=["rules/linked.md"])

    def test_rejects_private_or_active_markdown(self) -> None:
        rule = self.plugin_root / "rules" / "public.md"
        unsafe_bodies = (
            "# 规范\n\naccess_token=fixture-secret",
            "# 规范\n\nC:\\Users\\person\\private.txt",
            "# 规范\n\n<script>alert('x')</script>",
            "# 规范\n\n![remote](https://example.com/image.png)",
            "# 规范\n\n[unsafe](javascript:alert(1))",
        )
        for body in unsafe_bodies:
            with self.subTest(body=body):
                rule.write_text(body, encoding="utf-8")
                with self.assertRaises(PluginReadError):
                    self.preview()

    def test_rejects_unsafe_extension_links_and_unknown_fields(self) -> None:
        for tool in (
            {"id": "bad", "name": "Bad", "purpose": "Bad", "url": "javascript:alert(1)"},
            {
                "id": "bad",
                "name": "Bad",
                "purpose": "Bad",
                "url": "https://example.com",
                "command": "run",
            },
        ):
            with self.subTest(tool=tool):
                with self.assertRaises(PluginReadError):
                    self.preview(extension_tools=[tool])


if __name__ == "__main__":
    unittest.main()
