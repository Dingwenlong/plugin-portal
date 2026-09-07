from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from plugin_portal.audit_config import ConfiguredPluginReleaseAuditor, tree_digest
from plugin_portal.download_publication import DownloadPublicationError
from plugin_portal.server import create_server


class AuditConfigTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.release = self.root / "release"
        (self.release / ".codex-plugin").mkdir(parents=True)
        (self.release / "scripts").mkdir()
        self.manifest = self.release / ".codex-plugin/plugin.json"
        self.manifest.write_text(json.dumps({"name": "plugin-release", "version": "1.1.0"}))
        self.script = self.release / "scripts/release.py"
        self.script.write_text("# pinned audit entrypoint")
        self.codex = self.root / "codex.exe"
        self.codex.write_bytes(b"fake codex, never executed")
        self.python = self.root / "python.exe"
        self.python.write_bytes(b"fake python, never executed")
        digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
        self.payload = {
            "schemaVersion": "1.0.0", "codexHome": str(self.root),
            "codex": {"path": str(self.codex), "sha256": digest(self.codex)},
            "python": {"path": str(self.python), "sha256": digest(self.python)},
            "pluginRelease": {"root": str(self.release), "version": "1.1.0",
                              "manifestSha256": digest(self.manifest), "scriptSha256": digest(self.script),
                              "treeSha256": tree_digest(self.release)},
        }
        self.config = self.root / "audit.json"
        self.save()

    def save(self):
        self.config.write_text(json.dumps(self.payload), encoding="utf-8")

    def reject(self, config=None):
        auditor = ConfiguredPluginReleaseAuditor(config or self.config)
        with patch("plugin_portal.download_publication.subprocess.run") as run:
            with self.assertRaises(DownloadPublicationError) as failure:
                auditor.audit(self.root / "candidate.zip", plugin_id="demo", target="codex", expected_sha256="a" * 64)
            self.assertEqual("plugin_release_unavailable", failure.exception.code)
            self.assertNotIn(str(self.root), str(failure.exception))
            run.assert_not_called()

    def test_missing_config_constructs_but_audit_fails_closed(self):
        self.reject(self.root / "missing.json")

    def test_missing_optional_dependencies_do_not_block_basic_site(self):
        web = self.root / "web"
        web.mkdir()
        (web / "index.html").write_text("portal")
        with patch.dict(os.environ, {"PORTAL_AUDIT_CONFIG": str(self.root / "missing.json")}):
            server = create_server(host="127.0.0.1", port=0, data_root=self.root / "data", web_root=web, test_only=True)
            self.addCleanup(server.server_close)
            self.assertIsNotNone(server.api.list_plugins())

    def test_missing_codex_blocks_before_execution(self):
        self.codex.unlink()
        self.reject()

    def test_missing_release_blocks_before_execution(self):
        self.script.unlink()
        self.reject()

    def test_changed_python_blocks_before_execution(self):
        self.python.write_bytes(b"changed")
        self.reject()

    def test_changed_release_dependency_blocks_before_execution(self):
        (self.release / "scripts/helper.py").write_text("unexpected helper")
        self.reject()

    def test_manifest_version_must_match_pin(self):
        self.payload["pluginRelease"]["version"] = "1.2.0"
        self.save()
        self.reject()

    def test_no_implicit_path_or_schema_fields(self):
        self.payload["codex"]["path"] = "codex"
        self.save()
        self.reject()
        self.payload["skipAudit"] = True
        self.save()
        self.reject()

    def test_exact_pins_use_explicit_path_no_cache_discovery(self):
        delegate = ConfiguredPluginReleaseAuditor(self.config)._configured_delegate()
        installed = {"installed": [{"pluginId": "plugin-release@company-dev", "name": "plugin-release",
                                  "marketplaceName": "company-dev", "version": "1.1.0", "installed": True, "enabled": True}]}
        with patch.object(delegate, "_run", return_value=subprocess.CompletedProcess([], 0, json.dumps(installed), "")) as run:
            self.assertEqual(("1.1.0", self.script), delegate._resolve_script())
        self.assertEqual(str(self.codex), run.call_args.args[0][0])
        installed["installed"][0]["version"] = "9.9.9"
        with patch.object(delegate, "_run", return_value=subprocess.CompletedProcess([], 0, json.dumps(installed), "")):
            with self.assertRaises(DownloadPublicationError):
                delegate._resolve_script()

    def configure_inspector(self):
        self.manifest.write_text(json.dumps({"name": "plugin-inspector", "version": "1.0.0"}))
        inspector = self.payload.pop("pluginRelease")
        inspector.update(version="1.0.0", manifestSha256=hashlib.sha256(self.manifest.read_bytes()).hexdigest(),
                         treeSha256=tree_digest(self.release))
        self.payload["pluginInspector"] = inspector
        self.save()

    def test_inspector_requires_the_explicit_installed_identity(self):
        self.configure_inspector()
        delegate = ConfiguredPluginReleaseAuditor(self.config)._configured_delegate()
        installed = {"installed": [{"pluginId": "plugin-inspector@company-dev", "name": "plugin-inspector",
                                  "marketplaceName": "company-dev", "version": "1.0.0", "installed": True, "enabled": True}]}
        with patch.object(delegate, "_run", return_value=subprocess.CompletedProcess([], 0, json.dumps(installed), "")):
            self.assertEqual(("1.0.0", self.script), delegate._resolve_script())
        for field, value in (("pluginId", "plugin-release@company-dev"), ("version", "9.9.9"), ("enabled", False)):
            changed = json.loads(json.dumps(installed))
            changed["installed"][0][field] = value
            with self.subTest(field=field), patch.object(delegate, "_run", return_value=subprocess.CompletedProcess([], 0, json.dumps(changed), "")):
                with self.assertRaises(DownloadPublicationError):
                    delegate._resolve_script()

    def test_inspector_audit_accepts_only_matching_tool_output(self):
        self.configure_inspector()
        delegate = ConfiguredPluginReleaseAuditor(self.config)._configured_delegate()
        report = {"schemaVersion": "1.0.0", "tool": "plugin-inspector", "toolVersion": "1.0.0",
                  "operation": "diagnose", "status": "audited", "pluginId": "demo", "target": "company-dev",
                  "releaseKey": "company-dev/demo", "writesPerformed": False,
                  "candidate": {"pluginId": "demo", "version": "1.2.3", "candidateSha256": "a" * 64,
                                "fileSetSha256": "b" * 64, "fileCount": 5, "archiveBytes": 100},
                  "checks": [{"name": "candidate", "status": "passed"}]}
        for tool_name in ("plugin-inspector", "plugin-release", "unknown"):
            report["tool"] = tool_name
            with self.subTest(tool=tool_name), patch.object(delegate, "_resolve_script", return_value=("1.0.0", self.script)), patch.object(delegate, "_run", return_value=subprocess.CompletedProcess([], 0, json.dumps(report), "")):
                if tool_name == "plugin-inspector":
                    audit = delegate.audit(self.root / "candidate.zip", plugin_id="demo", target="company-dev", expected_sha256="a" * 64)
                    self.assertEqual("1.2.3", audit.version)
                else:
                    with self.assertRaises(DownloadPublicationError) as failure:
                        delegate.audit(self.root / "candidate.zip", plugin_id="demo", target="company-dev", expected_sha256="a" * 64)
                    self.assertEqual("audit_contract_invalid", failure.exception.code)

    def test_two_audit_identities_cannot_be_configured_together(self):
        self.configure_inspector()
        self.payload["pluginRelease"] = self.payload["pluginInspector"]
        self.save()
        self.reject()

    def test_inspector_manifest_cannot_claim_old_identity(self):
        self.configure_inspector()
        self.manifest.write_text(json.dumps({"name": "plugin-release", "version": "1.0.0"}))
        self.payload["pluginInspector"]["manifestSha256"] = hashlib.sha256(self.manifest.read_bytes()).hexdigest()
        self.payload["pluginInspector"]["treeSha256"] = tree_digest(self.release)
        self.save()
        self.reject()

    def test_config_is_reread_and_recovers_only_after_explicit_restoration(self):
        auditor = ConfiguredPluginReleaseAuditor(self.config)
        self.assertIsNotNone(auditor._configured_delegate())
        self.config.write_text("invalid")
        with self.assertRaises(DownloadPublicationError):
            auditor._configured_delegate()
        self.save()
        self.assertIsNotNone(auditor._configured_delegate())

    def test_nested_codex_resolution_and_python_environment_are_pinned(self):
        delegate = ConfiguredPluginReleaseAuditor(self.config)._configured_delegate()
        with patch("plugin_portal.audit_config.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "{}", "")) as run:
            delegate._run([str(self.python), "-B", str(self.script)], timeout=1)
        self.assertEqual("-I", run.call_args.args[0][1])
        self.assertEqual(str(self.codex.parent), run.call_args.kwargs["env"]["PATH"].split(os.pathsep)[0])
        self.script.write_text("changed after configuration load")
        with patch("plugin_portal.audit_config.subprocess.run") as run:
            with self.assertRaises(DownloadPublicationError):
                delegate._run([str(self.python)], timeout=1)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
