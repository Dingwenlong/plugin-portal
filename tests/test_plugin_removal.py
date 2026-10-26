import hashlib
import http.client
import json
import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from plugin_portal.api import ApiError, PortalApi
from plugin_portal.server import create_server
from plugin_portal.storage import PortalStore, RevisionConflict, StorageError


class PluginRemovalTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "source"
        shutil.copytree(Path(__file__).parent / "fixtures/plugins/minimal", self.source)
        self.store = PortalStore(self.root / "data")
        self.api = PortalApi(self.store)
        self.token = self.api.create_session()["token"]
        self.key = "company-dev/sample-plugin"
        self.other = "company-internal/sample-plugin"
        self.include("company-dev", 0)
        self.include("company-internal", 1)

    def include(self, target, revision):
        candidate = self.api.preview_import(self.token, {
            "source": {"kind": "server-directory", "path": str(self.source)},
            "target": target, "expectedPluginId": "sample-plugin", "approvedRulePaths": [], "extensionTools": [],
        })
        self.api.promote(self.token, candidate["pluginKey"], {
            "candidateId": candidate["candidateId"], "expectedRevision": revision,
        })

    def hashes(self):
        return {str(p.relative_to(self.store.root)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in self.store.root.rglob("*") if p.is_file()}

    def test_removes_only_selected_identity_and_retains_content_after_reimport(self):
        self.api.save_prompts(self.token, self.key, {"expectedRevision": 0, "items": [
            {"id": "p1", "scenario": "检查", "content": "检查插件", "createdAt": "2026-09-10T00:00:00Z"},
        ]})
        self.api.save_workflows(self.token, self.key, {"expectedRevision": 0, "workflow": {
            "pluginKey": self.key, "tabs": [{"id": "start", "title": "开始", "sections": []}],
        }})
        for kind in ("mcp", "releases"):
            doc = self.api.download_content(self.key, kind, True)
            preview = self.api.preview_content(self.token, self.key, kind, doc)
            self.api.confirm_content(self.token, self.key, kind, {
                "candidateId": preview["candidateId"], "expectedRevision": preview["revision"],
            })
        other_record = self.store.read_document("catalog")["data"]["plugins"][self.other]
        before = self.hashes()
        result = self.api.remove_plugin(self.token, self.key, {"expectedRevision": 2})
        self.assertEqual(result, {"revision": 3, "pluginKey": self.key})
        self.assertEqual([item["pluginKey"] for item in self.api.list_plugins()["items"]], [self.other])
        self.assertEqual(self.store.read_document("catalog")["data"]["plugins"][self.other], other_record)
        with self.assertRaises(ApiError) as missing:
            self.api.get_snapshot(self.key)
        self.assertEqual(missing.exception.code, "plugin_not_found")
        after = self.hashes()
        self.assertNotEqual(before.pop("catalog.json"), after.pop("catalog.json"))
        self.assertEqual(after, before)
        self.include("company-dev", 3)
        self.assertEqual(self.api.get_prompts(self.key)["items"][0]["id"], "p1")
        self.assertEqual(self.api.get_workflows(self.key)["tabs"][0]["id"], "start")
        for kind in ("mcp", "releases"):
            self.assertIsNotNone(self.api.get_content(self.key, kind)["document"])

    def test_stale_selection_and_repeat_cannot_remove_reimported_entry(self):
        self.api.remove_plugin(self.token, self.key, {"expectedRevision": 2})
        self.include("company-dev", 3)
        before = self.hashes()
        with self.assertRaises(ApiError) as conflict:
            self.api.remove_plugin(self.token, self.key, {"expectedRevision": 2})
        self.assertEqual((conflict.exception.status, conflict.exception.code), (409, "revision_conflict"))
        self.assertEqual(self.hashes(), before)

    def test_requires_full_identity_valid_revision_session_and_write_mode(self):
        before = self.hashes()
        for key, body in [("sample-plugin", {"expectedRevision": 2}), (self.key, {}),
                          (self.key, {"expectedRevision": True}), (self.key, {"expectedRevision": -1}),
                          (self.key, {"expectedRevision": 2, "allSources": True})]:
            with self.subTest(key=key, body=body), self.assertRaises(ApiError):
                self.api.remove_plugin(self.token, key, body)
        with self.assertRaises(ApiError) as invalid:
            self.api.remove_plugin("invalid", self.key, {"expectedRevision": 2})
        self.assertEqual(invalid.exception.status, 401)
        self.api.access_mode = "read-only"
        with self.assertRaises(ApiError) as readonly:
            self.api.remove_plugin(self.token, self.key, {"expectedRevision": 2})
        self.assertEqual(readonly.exception.code, "read_only")
        self.assertEqual(self.hashes(), before)

    def test_last_entry_can_be_removed_and_missing_entry_does_not_bump_revision(self):
        self.api.remove_plugin(self.token, self.key, {"expectedRevision": 2})
        self.api.remove_plugin(self.token, self.other, {"expectedRevision": 3})
        self.assertEqual(self.api.list_plugins(), {"revision": 4, "items": []})
        with self.assertRaises(ApiError) as missing:
            self.api.remove_plugin(self.token, self.other, {"expectedRevision": 4})
        self.assertEqual(missing.exception.status, 404)
        self.assertEqual(self.api.list_plugins()["revision"], 4)

    def test_atomic_storage_failures_and_late_revision_conflicts_preserve_catalog(self):
        before = self.hashes()
        for error, code in [(StorageError("failed"), "storage_failed"),
                            (RevisionConflict("changed"), "revision_conflict")]:
            with self.subTest(code=code), patch.object(self.store, "write_document", side_effect=error):
                with self.assertRaises(ApiError) as failure:
                    self.api.remove_plugin(self.token, self.key, {"expectedRevision": 2})
                self.assertEqual(failure.exception.code, code)
            self.assertEqual(self.hashes(), before)

    def test_http_route_uses_same_origin_and_session_checks(self):
        web = self.root / "web"
        web.mkdir()
        (web / "index.html").write_text("<!doctype html><title>Portal</title>")
        server = create_server(host="127.0.0.1", port=0, data_root=self.store.root, web_root=web, test_only=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close(), thread.join(5)))
        token = server.api.create_session()["token"]

        def request(headers):
            connection = http.client.HTTPConnection(*server.server_address, timeout=5)
            try:
                connection.request("POST", "/api/plugins/company-dev%2Fsample-plugin/remove",
                                   body=json.dumps({"expectedRevision": 2}),
                                   headers={"Content-Type": "application/json", **headers})
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()

        self.assertEqual(request({})[0], 401)
        self.assertEqual(request({"X-Portal-Session": token, "Origin": "https://untrusted.example"})[0], 403)
        self.assertEqual(self.api.list_plugins()["revision"], 2)
        self.assertEqual(request({"X-Portal-Session": token}), (200, {"revision": 3, "pluginKey": self.key}))
