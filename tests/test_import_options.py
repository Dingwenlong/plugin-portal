import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from plugin_portal.api import ApiError, PortalApi
from plugin_portal.archive_audit import PortalArchiveAuditor
from plugin_portal.download_publication import DownloadPublisher
from plugin_portal.import_rules import discover_import_rules
from plugin_portal.plugin_archive import extract_plugin_archive
from plugin_portal.storage import PortalStore
from plugin_portal.uploads import UploadRegistry
from test_marketplace_bundle import bundle_files, write_archive


class ImportOptionsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.archive = self.root / "plugin.zip"
        self.files = {**bundle_files(),
            "marketplace/p/rules/public.md": "# 开发规范\n公开正文。".encode(),
            "marketplace/p/docs/guide.md": "# 使用说明\n说明正文。".encode(),
            "marketplace/p/rules/private.md": b"# Private\npassword=private-value",
            "marketplace/p/rules/html.md": b"# HTML\n<script>alert(1)</script>",
        }
        write_archive(self.archive, self.files)
        self.downloads = self.root / "downloads"
        self.downloads.mkdir()
        def read_download(name):
            content = (self.downloads / name).read_bytes()
            return len(content), hashlib.sha256(content).hexdigest()
        self.store = PortalStore(self.root / "data")
        self.api = PortalApi(self.store, access_mode="remote-management", upload_registry=UploadRegistry(root=self.root / "uploads"),
            download_publisher=DownloadPublisher(download_root=self.downloads, receipt_root=self.root / "receipts",
                auditor=PortalArchiveAuditor(), download_reader=read_download))
        self.addCleanup(self.api.close)
        self.token = self.api.create_session()["token"]

    def preview(self, target="company-dev"):
        with self.archive.open("rb") as stream:
            uploaded = self.api.stage_upload(self.token, "plugin-import", self.archive.name, stream, self.archive.stat().st_size)
        return self.api.preview_import(self.token, {"source": {"kind": "upload", "uploadId": uploaded["uploadId"]},
            "target": target, "expectedPluginId": "", "approvedRulePaths": [], "extensionTools": []})

    def test_bundle_market_is_detected_even_when_form_default_is_different(self):
        candidate = self.preview()
        self.assertEqual(candidate["pluginKey"], "company-internal/sample-plugin")
        self.assertEqual(candidate["snapshot"]["plugin"]["target"], "company-internal")
        self.assertEqual(candidate["importOptions"]["marketplace"], "company-internal")
        self.assertEqual(candidate["importOptions"]["catalogRevision"], 0)
        self.assertIsNone(candidate["importOptions"]["currentVersion"])
        self.assertEqual(self.api.list_plugins()["items"], [])
        rules = {rule["path"]: rule for rule in candidate["importOptions"]["rules"]}
        self.assertTrue(rules["rules/public.md"]["available"])
        self.assertFalse(rules["rules/private.md"]["available"])
        self.assertFalse(rules["rules/html.md"]["available"])
        self.assertNotIn("private-value", json.dumps(candidate))
        self.assertNotIn("bodyMarkdown", json.dumps(candidate["importOptions"]))

    def test_older_version_publishes_to_its_declared_market_and_switches_only_that_source(self):
        # A valid newer package already exists for the same market.
        files = dict(self.files)
        for path in ("marketplace/p/rules/private.md", "marketplace/p/rules/html.md"):
            files.pop(path)
        manifest = json.loads(files["marketplace/p/.codex-plugin/plugin.json"])
        manifest["version"] = "4.3.6"
        files["marketplace/p/.codex-plugin/plugin.json"] = json.dumps(manifest).encode()
        write_archive(self.archive, files)
        newer = self.preview()
        self.api.promote(self.token, newer["pluginKey"], {"candidateId": newer["candidateId"], "expectedRevision": 0})
        manifest["version"] = "4.3.1"
        files["marketplace/p/.codex-plugin/plugin.json"] = json.dumps(manifest).encode()
        write_archive(self.archive, files)
        original = self.archive.read_bytes()
        older = self.preview()
        self.assertEqual(older["importOptions"]["currentVersion"], "4.3.6")
        self.assertEqual(older["importOptions"]["catalogRevision"], 1)
        result = self.api.promote(self.token, older["pluginKey"], {"candidateId": older["candidateId"], "expectedRevision": 1})
        self.assertEqual(result["revision"], 2)
        self.assertEqual(self.api.get_snapshot(older["pluginKey"])["plugin"]["version"], "4.3.1")
        self.assertEqual((self.downloads / "sample-plugin-4.3.1-company-internal.zip").read_bytes(), original)
        self.assertFalse((self.downloads / "sample-plugin-4.3.1-company-dev.zip").exists())

    def test_rules_are_frozen_selected_explicitly_and_old_confirmation_becomes_invalid(self):
        candidate = self.preview()
        key = candidate["pluginKey"]
        before = self.store.read_document("catalog")
        rule = self.api.read_import_rule(self.token, candidate["candidateId"], {"path": "rules/public.md"})
        self.assertEqual(rule["bodyMarkdown"], "# 开发规范\n公开正文。")
        self.assertEqual(candidate["snapshot"]["engineeringRules"], [])
        selected = self.api.preview_import_rules(self.token, candidate["candidateId"], {"paths": ["rules/public.md"]})
        self.assertEqual(selected["snapshot"]["engineeringRules"], [rule])
        self.assertNotEqual(candidate["snapshot"]["provenance"]["packageDigest"], selected["snapshot"]["provenance"]["packageDigest"])
        self.assertEqual(self.store.read_document("catalog"), before)
        with self.assertRaises(ApiError) as obsolete:
            self.api.promote(self.token, key, {"candidateId": candidate["candidateId"], "expectedRevision": 0})
        self.assertEqual(obsolete.exception.code, "candidate_not_found")
        empty = self.api.preview_import_rules(self.token, selected["candidateId"], {"paths": []})
        self.assertEqual(empty["snapshot"], candidate["snapshot"])

    def test_rule_choices_cannot_cross_sessions_or_read_unknown_unsafe_or_repeated_paths(self):
        candidate = self.preview()
        other = self.api.create_session()["token"]
        with self.assertRaises(ApiError) as missing:
            self.api.read_import_rule(other, candidate["candidateId"], {"path": "rules/public.md"})
        self.assertEqual(missing.exception.code, "candidate_not_found")
        for paths in [["../outside.md"], ["rules/private.md"], ["rules/html.md"], ["rules/public.md", "rules/public.md"], [0]]:
            with self.subTest(paths=paths), self.assertRaises(ApiError):
                self.api.preview_import_rules(self.token, candidate["candidateId"], {"paths": paths})
        with self.assertRaises(ApiError):
            self.api.read_import_rule(self.token, candidate["candidateId"], {"path": "rules/private.md"})

    def test_standalone_archive_keeps_manually_selected_market(self):
        files = {path.removeprefix("marketplace/p/"): data for path, data in self.files.items() if path.startswith("marketplace/p/")}
        write_archive(self.archive, files)
        candidate = self.preview("custom-market")
        self.assertEqual(candidate["pluginKey"], "custom-market/sample-plugin")
        self.assertIsNone(candidate["importOptions"]["marketplace"])

    def test_invalid_market_declaration_is_rejected_before_preview(self):
        files = dict(self.files)
        path = "marketplace/.agents/plugins/marketplace.json"
        catalog = json.loads(files[path]); catalog["name"] = "../outside"
        files[path] = json.dumps(catalog).encode()
        write_archive(self.archive, files)
        with self.assertRaises(ApiError) as rejected:
            self.preview()
        self.assertEqual(rejected.exception.code, "archive_invalid")

    def test_discovery_limits_are_visible_and_do_not_accept_over_budget_bodies(self):
        root = extract_plugin_archive(self.archive, self.root / "extracted")
        with patch("plugin_portal.import_rules.MAX_RULE_CHOICES", 2):
            discovery = discover_import_rules(root)
        self.assertTrue(discovery["truncated"])
        self.assertEqual(len(discovery["choices"]), 2)
        with patch("plugin_portal.import_rules.MAX_RULE_BYTES", 1):
            discovery = discover_import_rules(root)
        self.assertEqual(discovery["documents"], {})
        self.assertTrue(all(not choice["available"] and choice["reason"] for choice in discovery["choices"]))
