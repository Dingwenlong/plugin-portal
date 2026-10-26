import hashlib
import json
import os
import stat
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from plugin_portal.archive_audit import PortalArchiveAuditor
from plugin_portal.download_publication import DownloadPublicationError
from plugin_portal.server import create_server


def core_files():
    return {
        "sample-plugin/.codex-plugin/plugin.json": json.dumps({
            "name": "sample-plugin", "version": "1.2.3", "description": "Example",
            "author": {"name": "Example"}, "skills": "./skills/",
        }).encode(),
        "sample-plugin/skills/example/SKILL.md": b"---\nname: example\ndescription: Example\n---\n# Example\n",
        "sample-plugin/scripts/never_run.py": b"raise RuntimeError('Plugin code must not execute')\n",
    }


def file_set(files):
    hashes = {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}
    return hashlib.sha256((json.dumps(hashes, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()).hexdigest()


class PortalArchiveAuditTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = self.root / "candidate.zip"

    def write(self, files=None, compression=zipfile.ZIP_STORED):
        with zipfile.ZipFile(self.path, "w", compression) as archive:
            for name, data in (core_files() if files is None else files).items():
                archive.writestr(name, data)

    def audit(self, **kwargs):
        values = dict(plugin_id="sample-plugin", target="company-dev",
                      expected_sha256=hashlib.sha256(self.path.read_bytes()).hexdigest())
        values.update(kwargs)
        return PortalArchiveAuditor().audit(self.path, **values)

    def test_core_hash_parity_without_codex_cache_configuration_or_subprocesses(self):
        for wrapped in (True, False):
            with self.subTest(wrapped=wrapped):
                files = core_files()
                if not wrapped:
                    files = {name.removeprefix("sample-plugin/"): data for name, data in files.items()}
                self.write(files)
                with patch.dict(os.environ, {"CODEX_HOME": str(self.root / "missing-home"),
                                             "PORTAL_AUDIT_CONFIG": str(self.root / "missing.json")}), \
                        patch("subprocess.run", side_effect=AssertionError("No external tools allowed")) as run:
                    audit = self.audit()
                run.assert_not_called()
                self.assertEqual(audit.tool_name, "portal-archive")
                self.assertEqual(audit.status, "audited")
                self.assertEqual(audit.file_count, len(files))
                self.assertEqual(audit.file_set_sha256, file_set({
                    name.removeprefix("sample-plugin/"): data for name, data in files.items()}))
                self.assertEqual(list(self.root.iterdir()), [self.path])

    def test_rejects_manifest_identity_version_resources_and_duplicate_json(self):
        key = "sample-plugin/.codex-plugin/plugin.json"
        changes = [
            {"name": "different"}, {"version": "1.2.3-01"}, {"version": "1.02.3"},
            {"author": None}, {"description": ""}, {"skills": "./missing"},
            {"skills": "./../escape"}, {"interface": {"logo": "./missing.png"}},
        ]
        for change in changes:
            with self.subTest(change=change):
                files = core_files()
                files[key] = json.dumps({**json.loads(files[key]), **change}).encode()
                self.write(files)
                with self.assertRaises(DownloadPublicationError):
                    self.audit()
        self.write({**core_files(), key: b'{"name":"sample-plugin","name":"sample-plugin"}'})
        with self.assertRaises(DownloadPublicationError):
            self.audit()
        self.write({name.replace("sample-plugin/", "wrong-wrapper/", 1): data for name, data in core_files().items()})
        with self.assertRaises(DownloadPublicationError):
            self.audit()

    def test_rejects_unsafe_zip_paths_links_compression_and_case_collisions(self):
        for name in ("../escape", "/absolute", "sample-plugin/CON.txt", "sample-plugin/a:stream",
                     "sample-plugin/trailing.", "sample-plugin/.codex-plugin/PLUGIN.JSON"):
            with self.subTest(name=name):
                self.write({**core_files(), name: b"unsafe"})
                with self.assertRaises(DownloadPublicationError):
                    self.audit()
        self.write()
        with zipfile.ZipFile(self.path, "a") as archive:
            link = zipfile.ZipInfo("sample-plugin/link")
            link.create_system = 3
            link.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(link, "outside")
        with self.assertRaises(DownloadPublicationError):
            self.audit()
        self.write({**core_files(), "sample-plugin/bomb.txt": b"x" * 100_000}, zipfile.ZIP_DEFLATED)
        with self.assertRaises(DownloadPublicationError):
            self.audit()
        self.write()
        with patch("plugin_portal.plugin_archive.MAX_ARCHIVE_ENTRIES", 2):
            with self.assertRaises(DownloadPublicationError):
                self.audit()
        with patch("plugin_portal.archive_audit.MAX_OPAQUE_ZIP_BYTES", 16):
            with self.assertRaises(DownloadPublicationError):
                self.audit()

    def test_rejects_corrupt_file_crc(self):
        self.write()
        raw = self.path.read_bytes()
        self.path.write_bytes(raw.replace(b"# Example", b"# Changed", 1))
        with self.assertRaises(DownloadPublicationError):
            self.audit()

    def test_keeps_private_material_checks_including_chunk_boundaries(self):
        samples = {
            "credentials.json": b"{}", "secret.key": b"key", ".env.local": b"A=1",
            ".env.example": b"TOKEN=nonempty", ".env.template": b"\xff",
            "readme.txt": b"x" * (64 * 1024 - 5) + b"github_pat_" + b"x" * 30,
        }
        for name, data in samples.items():
            with self.subTest(name=name):
                self.write({**core_files(), "sample-plugin/" + name: data})
                with self.assertRaises(DownloadPublicationError) as error:
                    self.audit()
                self.assertEqual(str(error.exception), "候选包含私有资料")
                self.assertNotIn(str(self.root), str(error.exception))
        self.write({**core_files(), "sample-plugin/.env.example": b"# Template\nTOKEN=\nexport API_KEY=\"\"\n"})
        self.audit()

    def test_digest_mismatch_and_source_change_during_validation_are_rejected(self):
        self.write()
        with self.assertRaises(DownloadPublicationError) as error:
            self.audit(expected_sha256="0" * 64)
        self.assertEqual(error.exception.code, "candidate_changed")
        original_inspect = PortalArchiveAuditor._inspect

        def changed(*args):
            self.path.write_bytes(b"changed after frozen snapshot")
            return original_inspect(*args)

        with patch.object(PortalArchiveAuditor, "_inspect", side_effect=changed):
            with self.assertRaises(DownloadPublicationError) as error:
                self.audit()
        self.assertEqual(error.exception.code, "candidate_changed")

    def test_bundle_checks_every_original_file_and_marketplace_identity(self):
        files = {name.replace("sample-plugin/", "marketplace/p/", 1): data for name, data in core_files().items()}
        files.update({
            "marketplace/.agents/plugins/marketplace.json": json.dumps({
                "name": "company-dev", "plugins": [{"name": "sample-plugin",
                "source": {"source": "local", "path": "./p"}}],
            }).encode(),
            "README.md": b"Original distribution", "release-assets/data.zip": b"opaque data",
        })
        self.write(files)
        audit = self.audit()
        self.assertEqual(audit.file_count, len(files))
        self.assertEqual(audit.file_set_sha256, file_set(files))
        with self.assertRaises(DownloadPublicationError) as error:
            self.audit(target="company-internal")
        self.assertEqual(error.exception.code, "candidate_identity_mismatch")
        self.write({**files, "credentials.json": b"{}"})
        with self.assertRaises(DownloadPublicationError) as error:
            self.audit()
        self.assertEqual(str(error.exception), "候选包含私有资料")

    def test_standard_server_import_publishes_original_bytes_despite_stale_desktop_config(self):
        web = self.root / "web"
        web.mkdir()
        (web / "index.html").write_text("<title>Portal</title>")
        downloads = self.root / "downloads"
        downloads.mkdir()
        data = self.root / "data"
        data.mkdir()
        stale_config = self.root / "audit-config.json"
        stale_config.write_text('{"schemaVersion":"broken","pluginInspector":{"version":"missing"}}')
        self.write()
        original = self.path.read_bytes()

        def readback(name):
            payload = (downloads / name).read_bytes()
            return len(payload), hashlib.sha256(payload).hexdigest()

        with patch.dict(os.environ, {"CODEX_HOME": str(self.root / "missing-home"), "PORTAL_AUDIT_CONFIG": str(stale_config)}), \
                patch("subprocess.run", side_effect=AssertionError("Desktop tool called")), \
                patch("plugin_portal.server._default_download_root", return_value=downloads), \
                patch("plugin_portal.server.read_9134_download", side_effect=readback):
            server = create_server(host="127.0.0.1", port=0, test_only=True, remote_management=True,
                                   https_origin="https://127.0.0.1:9443", data_root=data, web_root=web)
            try:
                api = server.api
                token = api.create_session()["token"]
                with self.path.open("rb") as stream:
                    uploaded = api.stage_upload(token, "plugin-import", self.path.name, stream, len(original))
                preview = api.preview_import(token, {"source": {"kind": "upload", "uploadId": uploaded["uploadId"]},
                    "target": "company-dev", "expectedPluginId": "sample-plugin", "approvedRulePaths": [], "extensionTools": []})
                self.assertEqual(api.list_plugins()["revision"], 0)
                result = api.promote(token, preview["pluginKey"], {"candidateId": preview["candidateId"], "expectedRevision": 0})
                self.assertEqual(result["revision"], 1)
                self.assertEqual(api.get_snapshot(preview["pluginKey"])["plugin"]["version"], "1.2.3")
            finally:
                server.server_close()
        self.assertEqual((downloads / "sample-plugin-1.2.3-company-dev.zip").read_bytes(), original)
        receipt = json.loads(next((data / "download-publications").glob("*.json")).read_text())
        self.assertEqual(receipt["auditTool"], "portal-archive")
        self.assertEqual(receipt["candidateSha256"], hashlib.sha256(original).hexdigest())
        self.assertFalse((self.root / "missing-home").exists())


if __name__ == "__main__":
    unittest.main()
