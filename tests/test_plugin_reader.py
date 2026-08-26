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
        (self.plugin_root / ".mcp.public.json").unlink()
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
                    "name": "示例技能",
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

    def test_projects_optional_public_mcp_metadata_without_runtime_configuration(self) -> None:
        (self.plugin_root / ".mcp.public.json").write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "sample-service": {
                            "name": "示例服务",
                            "purpose": "查询经过筛选的公开资料。",
                            "capabilities": ["查询公开资料", "读取处理状态"],
                            "writeEnabled": False,
                        }
                    }
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        snapshot = self.preview()

        self.assertEqual(
            snapshot["mcp"],
            [
                {
                    "id": "sample-service",
                    "name": "示例服务",
                    "purpose": "查询经过筛选的公开资料。",
                    "capabilities": ["查询公开资料", "读取处理状态"],
                    "writeEnabled": False,
                }
            ],
        )
        serialized = json.dumps(snapshot, ensure_ascii=False)
        for private_value in ("example-command", "--example", "EXAMPLE_VALUE"):
            self.assertNotIn(private_value, serialized)

    def test_rejects_public_mcp_metadata_for_unknown_services(self) -> None:
        (self.plugin_root / ".mcp.public.json").write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "unknown-service": {
                            "name": "未知服务",
                            "purpose": "不应被接受。",
                            "capabilities": ["未知能力"],
                            "writeEnabled": False,
                        }
                    }
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(PluginReadError, "MCP 公开说明引用未知服务"):
            self.preview()

    def test_rejects_partial_or_unsafe_public_mcp_metadata(self) -> None:
        invalid_values = (
            {
                "name": "示例服务",
                "purpose": "缺少能力与写入标记。",
            },
            {
                "name": "示例服务",
                "purpose": "access_token=fixture-secret",
                "capabilities": ["查询资料"],
                "writeEnabled": False,
            },
        )
        for metadata in invalid_values:
            with self.subTest(metadata=metadata):
                (self.plugin_root / ".mcp.public.json").write_text(
                    json.dumps({"mcpServers": {"sample-service": metadata}}, ensure_ascii=False),
                    encoding="utf-8",
                )
                with self.assertRaises(PluginReadError):
                    self.preview()

    def test_prefers_the_skill_contract_public_display_name_over_the_markdown_heading(self) -> None:
        contract_path = self.plugin_root / "skills" / "sample-skill" / "skill.contract.json"
        contract_path.write_text(
            json.dumps(
                {
                    "identity": {"id": "sample-skill", "name": "sample-skill"},
                    "portal": {"displayName": "合约中文名称", "category": "implementation"},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        snapshot = self.preview()

        self.assertEqual(
            snapshot["skills"][0],
            {
                "id": "sample-skill",
                "name": "合约中文名称",
                "description": "展示一个经过筛选的公开能力。",
                "category": "implementation",
            },
        )

    def test_falls_back_to_the_markdown_heading_when_the_contract_name_is_not_chinese(self) -> None:
        contract_path = self.plugin_root / "skills" / "sample-skill" / "skill.contract.json"
        contract_path.write_text(
            json.dumps(
                {
                    "identity": {"id": "sample-skill", "name": "sample-skill"},
                    "portal": {"displayName": "Sample Skill"},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        snapshot = self.preview()

        self.assertEqual(snapshot["skills"][0]["name"], "示例技能")

    def test_normalizes_public_markdown_newlines(self) -> None:
        rule = self.plugin_root / "rules" / "public.md"
        rule.write_bytes("# 公开规范\r\n\r\n只展示公开正文。\r\n".encode("utf-8"))

        snapshot = self.preview()

        self.assertEqual(
            snapshot["engineeringRules"],
            [{"path": "rules/public.md", "bodyMarkdown": "# 公开规范\n\n只展示公开正文。"}],
        )

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
