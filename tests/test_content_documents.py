import json
import http.client
import shutil
import tempfile
import threading
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from plugin_portal.api import ApiError, PortalApi
from plugin_portal.content_documents import ContentValidationError, validate_content
from plugin_portal.server import create_server
from plugin_portal.storage import PortalStore, StorageError


class ContentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        shutil.copytree(Path(__file__).parent / "fixtures/plugins/minimal", self.source)
        self.store = PortalStore(self.root / "data")
        self.api = PortalApi(self.store)
        self.token = self.api.create_session()["token"]
        self.key = "company-dev/sample-plugin"
        self.import_plugin("company-dev", 0)
        self.import_plugin("company-internal", 1)

    def import_plugin(self, target, revision):
        candidate = self.api.preview_import(self.token, {
            "source": {"kind": "server-directory", "path": str(self.source)}, "target": target,
            "expectedPluginId": "sample-plugin", "approvedRulePaths": [], "extensionTools": [],
        })
        return self.api.promote(self.token, candidate["pluginKey"], {"candidateId": candidate["candidateId"], "expectedRevision": revision})

    def doc(self, kind="mcp", key=None):
        result = self.api.download_content(key or self.key, kind, True)
        if kind == "mcp":
            result["services"] = [{"id": "sample-mcp", "name": "示例服务", "tools": [{
                "id": "check", "name": "检查", "purpose": "检查插件内容", "scenarios": ["插件更新后核对"],
            }]}]
        else:
            result["releases"][0].update(summary="版本说明", changes=[{"type": "fixed", "text": "修复导入"}])
        return result

    def preview(self, doc, kind="mcp", key=None, token=None):
        return self.api.preview_content(token or self.token, key or self.key, kind, doc)

    def confirm(self, preview, kind="mcp", key=None, token=None):
        return self.api.confirm_content(token or self.token, key or self.key, kind, {
            "candidateId": preview["candidateId"], "expectedRevision": preview["revision"],
        })

    def test_both_templates_preview_cancel_replace_export_and_reimport(self):
        for kind in ("mcp", "releases"):
            with self.subTest(kind=kind):
                before = self.api.get_content(self.key, kind)
                preview = self.preview(self.doc(kind), kind)
                self.assertEqual(self.api.get_content(self.key, kind), before)
                self.assertNotIn("_instructions", preview["document"])
                saved = self.confirm(preview, kind)
                self.assertEqual(saved, self.api.get_content(self.key, kind))
                exported = self.api.download_content(self.key, kind)
                self.assertEqual(exported, saved["document"])
                again = self.preview(exported, kind)
                self.assertEqual(again["diff"]["items"], [])
                self.assertEqual(self.confirm(again, kind)["revision"], saved["revision"] + 1)

    def test_errors_locate_fields_and_do_not_save(self):
        valid = self.doc()
        bad_values = [([], "JSON"), ({**valid, "pluginKey": "company-internal/sample-plugin"}, "pluginKey"),
                      ({**valid, "documentType": "releases"}, "documentType"), ({**valid, "services": {}}, "services"),
                      ({**valid, "schemaVersion": "2"}, "schemaVersion")]
        duplicate = deepcopy(valid)
        duplicate["services"][0]["tools"] *= 2
        bad_values.append((duplicate, "services[0].tools[1].id"))
        empty = deepcopy(valid)
        empty["services"][0]["tools"][0]["purpose"] = ""
        bad_values.append((empty, "services[0].tools[0].purpose"))
        for doc, path in bad_values:
            with self.subTest(path=path), self.assertRaises(ApiError) as error:
                self.preview(doc)
            self.assertIn(path, str(error.exception))
        self.assertIsNone(self.api.get_content(self.key, "mcp")["document"])

    def test_release_dates_duplicate_versions_and_change_types(self):
        valid = self.doc("releases")
        for stamp in ("2026-02-30", "2026-1-1", 42, []):
            doc = deepcopy(valid); doc["releases"][0]["releasedAt"] = stamp
            with self.subTest(stamp=stamp), self.assertRaisesRegex(ContentValidationError, "releasedAt"):
                validate_content(doc, self.key, "releases")
        doc = deepcopy(valid); doc["releases"] *= 2
        with self.assertRaisesRegex(ContentValidationError, "version"):
            validate_content(doc, self.key, "releases")
        doc = deepcopy(valid); doc["releases"][0]["changes"][0]["type"] = {}
        with self.assertRaisesRegex(ContentValidationError, "type"):
            validate_content(doc, self.key, "releases")
        valid["releases"][0]["releasedAt"] = "2024-02-29"
        validate_content(valid, self.key, "releases")

    def test_clear_previews_removals_and_preserves_other_identity(self):
        other = "company-internal/sample-plugin"
        self.confirm(self.preview(self.doc()))
        self.confirm(self.preview(self.doc(key=other), key=other), key=other)
        other_before = self.api.get_content(other, "mcp")["document"]
        clear = self.doc(); clear["services"] = []
        preview = self.preview(clear)
        self.assertEqual(preview["diff"]["removed"], 2)
        self.confirm(preview)
        self.assertEqual(self.api.get_content(self.key, "mcp")["document"]["services"], [])
        self.assertEqual(self.api.get_content(other, "mcp")["document"], other_before)

    def test_concurrent_preview_conflicts_and_repreview_preserves_candidate(self):
        first = self.preview(self.doc())
        other_token = self.api.create_session()["token"]
        second_doc = self.doc(); second_doc["services"][0]["name"] = "另一份说明"
        second = self.preview(second_doc, token=other_token)
        self.confirm(second, token=other_token)
        with self.assertRaises(ApiError) as error:
            self.confirm(first)
        self.assertEqual(error.exception.code, "revision_conflict")
        refreshed = self.preview(first["document"])
        self.assertEqual(refreshed["diff"]["changed"], 1)
        self.assertEqual(self.confirm(refreshed)["document"], first["document"])

    def test_candidates_are_session_identity_and_page_bound_and_idempotent(self):
        preview = self.preview(self.doc())
        for options in ({"token": self.api.create_session()["token"]}, {"key": "company-internal/sample-plugin"}, {"kind": "releases"}):
            with self.subTest(options=options), self.assertRaises(ApiError):
                self.confirm(preview, **options)
        saved = self.confirm(preview)
        self.assertEqual(self.confirm(preview), saved)
        self.assertEqual(self.api.get_content(self.key, "mcp"), saved)

    def test_import_upgrade_retains_docs_and_snapshot_version_is_independent(self):
        doc = self.confirm(self.preview(self.doc()))["document"]
        path = self.source / ".codex-plugin/plugin.json"
        manifest = json.loads(path.read_text(encoding="utf-8")); manifest["version"] = "9.0.0"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        self.import_plugin("company-dev", 2)
        self.assertEqual(self.api.get_content(self.key, "mcp")["document"], doc)
        self.assertEqual(self.api.get_snapshot(self.key)["plugin"]["version"], "9.0.0")

    def test_failed_atomic_save_preserves_previous_document(self):
        saved = self.confirm(self.preview(self.doc()))
        doc = self.doc(); doc["services"] = []
        preview = self.preview(doc)
        with patch.object(self.store, "_atomic_write_json", side_effect=StorageError("test failure")):
            with self.assertRaises(ApiError):
                self.confirm(preview)
        self.assertEqual(self.api.get_content(self.key, "mcp"), saved)

    def test_http_download_upload_limit_session_origin_and_readonly(self):
        web = self.root / "web"; web.mkdir(); (web / "index.html").write_text("<!doctype html>", encoding="utf-8")
        server = create_server(host="127.0.0.1", port=0, data_root=self.store.root, web_root=web, test_only=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        base = f"http://127.0.0.1:{server.server_address[1]}"
        path = "/api/plugins/company-dev%2Fsample-plugin/content/mcp"
        def request(suffix="", data=None, headers=None):
            payload = data if isinstance(data, bytes) else None if data is None else json.dumps(data).encode()
            return urlopen(Request(base + path + suffix, data=payload, headers=headers or {}), timeout=5)
        try:
            with request("/template") as response:
                self.assertIn("attachment", response.headers["Content-Disposition"])
                self.assertEqual(json.load(response)["pluginKey"], self.key)
            token = server.api.create_session()["token"]
            headers = {"Content-Type": "application/json", "X-Portal-Session": token}
            with request("/preview", self.doc(), headers) as response:
                preview = json.load(response)
            with request("/confirm", {"candidateId": preview["candidateId"], "expectedRevision": preview["revision"]}, headers):
                pass
            with request("/export") as response:
                self.assertNotIn("_instructions", json.load(response))
            # Oversized bodies are rejected from their declared length. Do not race
            # a 1 MiB upload against the early response and TCP close on Windows.
            oversized = http.client.HTTPConnection(*server.server_address, timeout=5)
            try:
                oversized.request("POST", path + "/preview", headers={**headers, "Content-Length": str(1024 * 1024 + 1)})
                response = oversized.getresponse()
                self.assertEqual(response.status, 413)
                self.assertEqual(json.loads(response.read())["error"]["code"], "payload_too_large")
            finally:
                oversized.close()
            for data, sent_headers, code in ((b"{", headers, 400),
                    (self.doc(), {}, 401), (self.doc(), {**headers, "Origin": "https://example.com"}, 403)):
                with self.subTest(code=code):
                    with self.assertRaises(HTTPError) as error:
                        request("/preview", data, sent_headers)
                    self.assertEqual(error.exception.code, code)
            server.read_only = True
            with request() as response:
                self.assertIsNotNone(json.load(response)["document"])
            with self.assertRaises(HTTPError) as error:
                request("/preview", self.doc(), headers)
            self.assertEqual(error.exception.code, 403)
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=5)
