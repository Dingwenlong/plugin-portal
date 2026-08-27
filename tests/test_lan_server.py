import hashlib
import http.client
import json
import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import quote

from plugin_portal.api import PortalApi
from plugin_portal.server import ServerConfigurationError, create_server
from plugin_portal.storage import PortalStore


class LanServerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.web = self.root / "web"
        self.web.mkdir()
        (self.web / "index.html").write_text("<!doctype html><title>Portal</title>", encoding="utf-8")
        self.store = PortalStore(self.root / "data")
        api = PortalApi(self.store)
        source = self.root / "plugin"
        shutil.copytree(Path(__file__).parent / "fixtures/plugins/minimal", source)
        token = api.create_session()["token"]
        candidate = api.preview_import(token, {
            "pluginRoot": str(source), "target": "company-dev", "expectedPluginId": "sample-plugin",
            "approvedRulePaths": ["rules/public.md"], "extensionTools": [],
        })
        self.key = candidate["pluginKey"]
        self.path = "/api/plugins/" + quote(self.key, safe="")
        api.promote(token, self.key, {"candidateId": candidate["candidateId"], "expectedRevision": 0})
        api.save_prompts(token, self.key, {"expectedRevision": 0, "items": [
            {"id": "p1", "scenario": "共享场景", "content": "共享提示词", "createdAt": "2026-08-27T00:00:00Z"},
        ]})
        api.save_workflows(token, self.key, {"expectedRevision": 0, "workflow": {
            "pluginKey": self.key, "tabs": [{"id": "first", "title": "共享流程", "sections": []}],
        }})
        self.server = create_server(host="127.0.0.1", port=0, data_root=self.store.root,
                                    web_root=self.web, test_only=True, read_only=True)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (self.server.shutdown(), self.server.server_close(), thread.join(5)))

    def request(self, path, method="GET", headers=None, body=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def hashes(self):
        return {str(p.relative_to(self.store.root)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in self.store.root.rglob("*") if p.is_file()}

    def test_reads_public_content_and_consented_personal_content_without_writes(self):
        before = self.hashes()
        self.assertEqual(json.loads(self.request("/api/access")[2]), {"readOnly": True})
        for path in ("/api/plugins", self.path + "/snapshot", self.path + "/prompts", self.path + "/workflows"):
            with self.subTest(path=path):
                status, headers, body = self.request(path)
                head_status, head_headers, head_body = self.request(path, "HEAD")
                self.assertEqual((status, head_status, head_body), (200, 200, b""))
                self.assertEqual(head_headers["Content-Length"], str(len(body)))
                self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertIn("共享提示词", self.request(self.path + "/prompts")[2].decode())
        self.assertIn("共享流程", self.request(self.path + "/workflows")[2].decode())
        self.assertEqual(self.hashes(), before)

    def test_denies_all_writes_before_session_or_picker_execution(self):
        before = self.hashes()
        token = self.server.api.create_session()["token"]
        with patch.object(self.server.api, "directory_picker", side_effect=AssertionError("picker called")):
            for method in ("POST", "PUT", "PATCH", "DELETE"):
                for path in ("/api/session", "/api/plugins/import/preview", "/api/plugins/import/select-directory",
                             self.path + "/promote", self.path + "/rollback",
                             self.path + "/prompts", self.path + "/workflows"):
                    with self.subTest(method=method, path=path):
                        status, _, body = self.request(path, method, {"X-Portal-Session": token}, b"{}")
                        self.assertEqual(status, 403)
                        self.assertEqual(json.loads(body)["error"]["code"], "read_only")
        self.assertEqual(len(self.server.api._sessions), 1)
        self.assertEqual(self.hashes(), before)

    def test_requires_exact_host_and_same_origin(self):
        for headers in ({"Host": "example.test"}, {"Host": "127.0.0.1:9137"},
                        {"Origin": "http://example.test"}, {"Origin": "null"}):
            self.assertEqual(self.request("/api/plugins", headers=headers)[0], 403)

    def test_only_reads_admitted_plugin_documents(self):
        for suffix in ("snapshot", "prompts", "workflows", "icon", "download-info", "download"):
            self.assertEqual(self.request("/api/plugins/company-dev%2Funknown/" + suffix)[0], 404)

    def test_static_public_allowlist_rejects_internal_and_traversal_paths(self):
        (self.web / "private.json").write_text('{"private":true}', encoding="utf-8")
        for path in ("/private.json", "/../data/catalog.json", "/%2e%2e/data/catalog.json",
                     "/assets/..%5c..%5cdata%5ccatalog.json", "/api/session", "/api/unknown"):
            self.assertEqual(self.request(path)[0], 404)
        status, headers, body = self.request("/")
        self.assertEqual(status, 200)
        self.assertEqual(self.request("/", "HEAD")[2], b"")
        self.assertEqual(headers["Content-Length"], str(len(body)))

    def test_download_info_uses_same_origin_plugin_bound_url(self):
        self.server.api.download_probe = lambda url: True
        info = json.loads(self.request(self.path + "/download-info")[2])
        self.assertEqual(info, {"available": True, "version": "1.2.3", "href": self.path + "/download"})

    def test_download_proxy_checks_response_and_preserves_get_head(self):
        from plugin_portal.lan_download import read_download
        self.server.api.download_probe = lambda url: True
        payload = b"PK\x03\x04sample archive"
        with patch("plugin_portal.server.read_download", return_value=(payload, len(payload))) as reader:
            status, headers, body = self.request(self.path + "/download")
            self.assertEqual((status, body), (200, payload))
            self.assertEqual(headers["Content-Type"], "application/zip")
            self.assertIn('filename="sample-plugin-1.2.3-company-dev.zip"', headers["Content-Disposition"])
            self.assertEqual(self.request(self.path + "/download", "HEAD")[2], b"")
            self.assertTrue(reader.call_args.kwargs["head_only"])
        for url in ("https://example.test/a.zip", "http://127.0.0.1:9134/admin",
                    "http://127.0.0.1:9134/downloads/../secret.zip"):
            with self.assertRaises(ValueError):
                read_download(url)

    def test_download_proxy_rejects_bad_status_mime_length_and_redirect(self):
        from plugin_portal.lan_download import read_download
        url = "http://127.0.0.1:9134/downloads/sample-plugin-1.2.3-company-dev.zip"
        with patch("plugin_portal.lan_download.http.client.HTTPConnection") as connection:
            response = connection.return_value.getresponse.return_value
            response.status = 200
            response.getheader.side_effect = lambda name, default=None: {
                "Content-Type": "application/zip", "Content-Length": "4",
            }.get(name, default)
            response.read.return_value = b"data"
            self.assertEqual(read_download(url), (b"data", 4))
            response.read.return_value = b"x"
            with self.assertRaises(ValueError):
                read_download(url)
            response.status = 302
            with self.assertRaises(ValueError):
                read_download(url)
            response.status = 200
            response.getheader.side_effect = lambda name, default=None: {
                "Content-Type": "text/html", "Content-Length": "4",
            }.get(name, default)
            with self.assertRaises(ValueError):
                read_download(url)

    def test_binding_does_not_expand_local_management_access(self):
        for host, port, read_only in (("0.0.0.0", 9135, True), ("8.8.8.8", 9135, True),
                                      ("192.168.7.125", 9137, True), ("192.168.7.125", 9135, False)):
            with self.subTest(host=host, port=port, read_only=read_only):
                with self.assertRaises(ServerConfigurationError):
                    create_server(host=host, port=port, data_root=self.store.root,
                                  web_root=self.web, read_only=read_only)


if __name__ == "__main__":
    unittest.main()
