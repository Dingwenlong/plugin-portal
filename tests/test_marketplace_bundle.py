import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from plugin_portal.plugin_archive import PluginArchiveError, extract_plugin_archive
from plugin_portal.download_publication import DownloadPublicationError, DownloadPublisher, PluginReleaseAudit, PluginReleaseAuditor
from plugin_portal.api import ApiError, PortalApi
from plugin_portal.storage import PortalStore
from plugin_portal.uploads import UploadRegistry
from plugin_portal.bundle_inspection import build_bundle_inspection


def files_digest(files):
    hashes = {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}
    return hashlib.sha256((json.dumps(hashes, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n").encode()).hexdigest()


class RecordingNativeAuditor(PluginReleaseAuditor):
    """Test double for the external tool only; Portal adaptation stays real."""
    def __init__(self):
        super().__init__()
        self.seen = []
        self.reject = False
        self.mutate = None
        self.bad_file_set = False

    def _audit_archive(self, path, *, plugin_id, target, expected_sha256):
        with zipfile.ZipFile(path) as archive:
            files = {name.removeprefix(plugin_id + "/"): archive.read(name) for name in archive.namelist()}
        self.seen.append((path, files))
        if self.reject:
            raise DownloadPublicationError("candidate_rejected", "Rejected by auditor")
        if self.mutate:
            self.mutate()
        return PluginReleaseAudit(
            plugin_id, target, "4.3.1", expected_sha256,
            "0" * 64 if self.bad_file_set else files_digest(files), len(files), path.stat().st_size,
            "1.0.0", "audited", (),
        )


def bundle_files(plugin_path="p"):
    return {
        "marketplace/.agents/plugins/marketplace.json": json.dumps({
            "name": "company-internal",
            "plugins": [{"name": "sample-plugin", "source": {"source": "local", "path": f"./{plugin_path}"}}],
        }).encode(),
        f"marketplace/{plugin_path}/.codex-plugin/plugin.json": json.dumps({
            "name": "sample-plugin", "version": "4.3.1", "description": "Example",
            "author": {"name": "Example"}, "skills": "./skills/",
        }).encode(),
        f"marketplace/{plugin_path}/skills/example/SKILL.md": b"---\nname: example\ndescription: Example\n---\n# Example\n",
        "README.md": b"Complete distribution",
    }


def write_archive(path, files):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)


class BundleTestCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.archive = self.root / "bundle.zip"
        self.destination = self.root / "content"

    def reject(self, files):
        write_archive(self.archive, files)
        with self.assertRaises(PluginArchiveError):
            extract_plugin_archive(self.archive, self.destination)
        self.assertFalse(self.destination.exists())


class MarketplaceBundleTests(BundleTestCase):
    def test_catalog_locates_plugin_without_hardcoding_p_and_extracts_only_plugin(self):
        for plugin_path in ("p", "plugins/sample-plugin"):
            with self.subTest(plugin_path=plugin_path):
                files = bundle_files(plugin_path)
                write_archive(self.archive, files)
                destination = self.root / plugin_path.replace("/", "-")
                plugin = extract_plugin_archive(self.archive, destination)
                self.assertEqual((plugin / ".codex-plugin/plugin.json").read_bytes(),
                                 files[f"marketplace/{plugin_path}/.codex-plugin/plugin.json"])
                self.assertFalse((destination / "README.md").exists())
                self.assertEqual(len(list(destination.rglob("SKILL.md"))), 1)

    def test_large_opaque_release_zip_allowed_but_never_extracted(self):
        nested = io.BytesIO()
        with zipfile.ZipFile(nested, "w", zipfile.ZIP_STORED) as archive:
            archive.writestr("runtime.bin", b"x" * 2048)
        files = bundle_files()
        files["release-assets/runtime.zip"] = nested.getvalue()
        write_archive(self.archive, files)
        with patch("plugin_portal.plugin_archive.MAX_ENTRY_BYTES", 1024):
            plugin = extract_plugin_archive(self.archive, self.destination)
        self.assertTrue((plugin / ".codex-plugin/plugin.json").exists())
        self.assertFalse((self.destination / "release-assets").exists())

    def test_size_exception_does_not_allow_large_plugin_files_non_zip_or_fake_zip(self):
        for name in ("marketplace/p/runtime.zip", "release-assets/runtime.bin", "release-assets/fake.zip"):
            with self.subTest(name=name):
                with patch("plugin_portal.plugin_archive.MAX_ENTRY_BYTES", 1024):
                    self.reject({**bundle_files(), name: b"x" * 2048})

    def test_rejects_ambiguous_remote_escaping_or_mismatched_catalog(self):
        catalog_path = "marketplace/.agents/plugins/marketplace.json"
        for source in ({"source": "local", "path": "../p"},
                       {"source": "local", "path": "./../p"},
                       {"source": "local", "path": "./p/../p"},
                       {"source": "local", "path": "./missing"},
                       {"source": "git", "url": "https://example.com/plugin"}):
            with self.subTest(source=source):
                files = bundle_files()
                catalog = json.loads(files[catalog_path])
                catalog["plugins"][0]["source"] = source
                files[catalog_path] = json.dumps(catalog).encode()
                self.reject(files)
        for change in ("multiple-plugins", "multiple-catalogs", "wrong-name", "multiple-manifests"):
            with self.subTest(change=change):
                files = bundle_files()
                catalog = json.loads(files[catalog_path])
                if change == "multiple-plugins":
                    catalog["plugins"].append(catalog["plugins"][0])
                elif change == "multiple-catalogs":
                    files["another/.agents/plugins/marketplace.json"] = files[catalog_path]
                elif change == "wrong-name":
                    catalog["plugins"][0]["name"] = "different-plugin"
                else:
                    files["other/.codex-plugin/plugin.json"] = b"{}"
                files[catalog_path] = json.dumps(catalog).encode()
                self.reject(files)

    def test_bundle_does_not_relax_outer_path_validation(self):
        for name in ("../escape", "release-assets/a:stream", "release-assets/CON.txt", "release-assets/trailing."):
            with self.subTest(name=name):
                self.reject({**bundle_files(), name: b"unsafe"})


class BundleAuditTests(BundleTestCase):
    def audit(self, auditor=None):
        auditor = auditor or RecordingNativeAuditor()
        return auditor.audit(self.archive, plugin_id="sample-plugin", target="company-dev",
                             expected_sha256=hashlib.sha256(self.archive.read_bytes()).hexdigest())

    def test_every_file_reaches_auditor_and_original_zip_is_published(self):
        files = {**bundle_files(), "install.ps1": b"# installer", "release-assets/data.zip": b"opaque data"}
        write_archive(self.archive, files)
        original = self.archive.read_bytes()
        auditor = RecordingNativeAuditor()
        downloads = self.root / "downloads"
        downloads.mkdir()
        receipts = self.root / "receipts"
        def readback(name):
            data = (downloads / name).read_bytes()
            return len(data), hashlib.sha256(data).hexdigest()
        publisher = DownloadPublisher(download_root=downloads, receipt_root=receipts, auditor=auditor, download_reader=readback)
        candidate = publisher.preview(self.archive, plugin_key="company-dev/sample-plugin", expected_version="4.3.1")
        receipt = publisher.publish(candidate)
        self.assertEqual((downloads / receipt.file_name).read_bytes(), original)
        self.assertEqual(len(auditor.seen), 1)
        view_path, inspected = auditor.seen[0]
        self.assertFalse(view_path.exists())
        self.assertEqual(sorted(inspected.values()), sorted(files.values()))
        self.assertIn(".codex-plugin/plugin.json", inspected)
        self.assertEqual(candidate.audit.file_set_sha256, files_digest(files))
        stored = json.loads(next(receipts.glob("*.json")).read_text())
        evidence = stored["bundleInspection"]
        self.assertEqual(evidence["sourceSha256"], hashlib.sha256(original).hexdigest())
        self.assertNotEqual(evidence["inspectionSha256"], evidence["sourceSha256"])
        self.assertEqual(evidence["fileCount"], len(files))
        self.assertEqual(evidence["inspectionFileSetSha256"], files_digest(inspected))

    def test_audit_failure_or_file_set_mismatch_never_falls_back_and_cleans_view(self):
        for failure in ("reject", "bad_file_set"):
            with self.subTest(failure=failure):
                write_archive(self.archive, bundle_files())
                auditor = RecordingNativeAuditor()
                setattr(auditor, failure, True)
                with self.assertRaises(DownloadPublicationError):
                    self.audit(auditor)
                self.assertEqual(len(auditor.seen), 1)
                self.assertFalse(auditor.seen[0][0].exists())

    def test_original_changed_during_audit_is_rejected(self):
        write_archive(self.archive, bundle_files())
        auditor = RecordingNativeAuditor()
        auditor.mutate = lambda: self.archive.write_bytes(b"changed")
        with self.assertRaises(DownloadPublicationError) as error:
            self.audit(auditor)
        self.assertEqual(error.exception.code, "candidate_changed")

    def test_inspection_uses_the_frozen_copy_when_the_source_file_is_refreshed(self):
        from plugin_portal.bundle_inspection import _build_view
        files = bundle_files()
        write_archive(self.archive, files)
        expected_sha = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        def refreshed_source(*args, **kwargs):
            write_archive(self.archive, {**files, "README.md": b"Refreshed after snapshot"})
            return _build_view(*args, **kwargs)
        with patch("plugin_portal.bundle_inspection._build_view", side_effect=refreshed_source):
            inspection = build_bundle_inspection(self.archive, self.root / "view.zip", plugin_id="sample-plugin")
        self.assertEqual(inspection.source_sha256, expected_sha)
        self.assertEqual(inspection.source_file_set_sha256, files_digest(files))
        self.assertNotEqual(inspection.source_sha256, hashlib.sha256(self.archive.read_bytes()).hexdigest())
        with zipfile.ZipFile(self.root / "view.zip") as view:
            self.assertEqual(view.read("sample-plugin/.portal-distribution/README.md"), files["README.md"])
        self.assertEqual(sorted(path.name for path in self.root.iterdir()), ["bundle.zip", "view.zip"])

    def test_frozen_copy_limit_is_enforced_and_its_temporary_file_is_removed(self):
        write_archive(self.archive, bundle_files())
        with patch("plugin_portal.bundle_inspection.MAX_OPAQUE_ZIP_BYTES", 64):
            with self.assertRaises(PluginArchiveError):
                build_bundle_inspection(self.archive, self.root / "view.zip", plugin_id="sample-plugin")
        self.assertEqual([path.name for path in self.root.iterdir()], ["bundle.zip"])

    def test_outer_private_file_is_not_dropped_and_namespace_collision_is_rejected(self):
        files = {**bundle_files(), "credentials.json": b"private example"}
        write_archive(self.archive, files)
        auditor = RecordingNativeAuditor()
        self.audit(auditor)
        self.assertIn(".portal-distribution/credentials.json", auditor.seen[0][1])
        write_archive(self.archive, {**files, "marketplace/p/.portal-distribution/credentials.json": b"collision"})
        with self.assertRaises(DownloadPublicationError):
            self.audit()


class BundleImportFlowTests(BundleTestCase):
    def setUp(self):
        super().setUp()
        self.downloads = self.root / "downloads"
        self.downloads.mkdir()
        self.auditor = RecordingNativeAuditor()
        def readback(name):
            data = (self.downloads / name).read_bytes()
            return len(data), hashlib.sha256(data).hexdigest()
        publisher = DownloadPublisher(download_root=self.downloads, receipt_root=self.root / "receipts",
                                      auditor=self.auditor, download_reader=readback)
        self.uploads = UploadRegistry(root=self.root / "uploads")
        self.api = PortalApi(PortalStore(self.root / "data"), access_mode="remote-management",
                             upload_registry=self.uploads, download_publisher=publisher)
        self.addCleanup(self.api.close)
        self.token = self.api.create_session()["token"]

    def preview(self, files):
        write_archive(self.archive, files)
        with self.archive.open("rb") as stream:
            uploaded = self.api.stage_upload(self.token, "plugin-import", self.archive.name, stream, self.archive.stat().st_size)
        preview = self.api.preview_import(self.token, {
            "source": {"kind": "upload", "uploadId": uploaded["uploadId"]},
            "target": "company-dev", "expectedPluginId": "sample-plugin", "approvedRulePaths": [], "extensionTools": [],
        })
        return uploaded, preview

    def test_one_upload_preview_confirm_and_download_preserve_identity_and_bytes(self):
        uploaded, preview = self.preview(bundle_files())
        original = self.archive.read_bytes()
        self.assertEqual(preview["pluginKey"], "company-internal/sample-plugin")
        self.assertEqual(preview["snapshot"]["plugin"]["version"], "4.3.1")
        self.assertEqual(self.api.list_plugins()["items"], [])
        promoted = self.api.promote(self.token, preview["pluginKey"], {"candidateId": preview["candidateId"], "expectedRevision": 0})
        self.assertEqual(promoted["revision"], 1)
        self.assertEqual(self.api.get_snapshot(preview["pluginKey"])["plugin"]["version"], "4.3.1")
        self.assertEqual((self.downloads / "sample-plugin-4.3.1-company-internal.zip").read_bytes(), original)
        self.assertFalse((self.uploads.root / f'{uploaded["uploadId"]}.zip').exists())

    def test_rejected_audit_keeps_upload_and_never_activates_snapshot(self):
        uploaded, preview = self.preview(bundle_files())
        self.auditor.reject = True
        with self.assertRaises(ApiError):
            self.api.promote(self.token, preview["pluginKey"], {"candidateId": preview["candidateId"], "expectedRevision": 0})
        self.assertEqual(self.api.list_plugins()["items"], [])
        self.assertEqual(list(self.downloads.iterdir()), [])
        self.assertTrue(self.uploads.require(self.token, "plugin-import", uploaded["uploadId"]).path.exists())
        self.auditor.reject = False
        self.api.promote(self.token, preview["pluginKey"], {"candidateId": preview["candidateId"], "expectedRevision": 0})
        self.assertEqual(self.api.list_plugins()["items"][0]["version"], "4.3.1")

    def test_same_version_different_distribution_is_not_overwritten(self):
        _, first = self.preview(bundle_files())
        original = self.archive.read_bytes()
        self.api.promote(self.token, first["pluginKey"], {"candidateId": first["candidateId"], "expectedRevision": 0})
        _, second = self.preview({**bundle_files(), "README.md": b"Different distribution"})
        with self.assertRaises(ApiError):
            self.api.promote(self.token, second["pluginKey"], {"candidateId": second["candidateId"], "expectedRevision": 1})
        self.assertEqual((self.downloads / "sample-plugin-4.3.1-company-internal.zip").read_bytes(), original)
        self.assertEqual(self.api.list_plugins()["revision"], 1)


if __name__ == "__main__":
    unittest.main()
