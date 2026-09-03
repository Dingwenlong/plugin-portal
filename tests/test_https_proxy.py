import http.client
import io
import json
import tempfile
import threading
import unittest
import zipfile
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

from plugin_portal.__main__ import build_parser
from plugin_portal.server import ServerConfigurationError, create_server
from plugin_portal.storage import PortalStore
from plugin_portal.uploads import MAX_UPLOAD_BYTES


class HttpsProxyTests(unittest.TestCase):
    origin = "https://192.168.7.125:9135"
    authority = "192.168.7.125:9135"

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.web = self.root / "web"
        self.web.mkdir()
        (self.web / "index.html").write_text("<!doctype html><title>Portal</title>", encoding="utf-8")
        self.store = PortalStore(self.root / "data")
        buffer = io.BytesIO()
        fixture = Path(__file__).parent / "fixtures" / "plugins" / "minimal"
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(fixture.rglob("*")):
                if path.is_file():
                    archive.write(path, f"sample-plugin/{path.relative_to(fixture).as_posix()}")
        self.plugin_zip = buffer.getvalue()

    def create(self, **kwargs):
        values = dict(host="127.0.0.1", port=0, test_only=True, read_only=True,
                      https_origin=self.origin, data_root=self.store.root, web_root=self.web)
        values.update(kwargs)
        return create_server(**values)

    def start(self):
        self.server = self.create()
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (self.server.shutdown(), self.server.server_close(), thread.join(5)))

    def request(self, method="GET", headers=None, path="/api/access", body=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers or {"Host": self.authority})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_https_proxy_keeps_read_only_and_get_head_parity(self):
        self.start()
        status, headers, body = self.request(headers={"Host": self.authority, "Origin": self.origin})
        self.assertEqual(
            (status, json.loads(body)),
            (200, {"readOnly": True, "fileSelectionMode": "none"}),
        )
        head_status, head_headers, head_body = self.request("HEAD")
        self.assertEqual((head_status, head_headers["Content-Length"], head_body),
                         (200, headers["Content-Length"], b""))
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            self.assertEqual(self.request(method)[0], 403)

    def test_public_origin_is_fixed_not_inferred_from_forwarded_headers(self):
        self.start()
        for headers in (
            {"Host": self.authority, "Origin": self.origin.replace("https:", "http:")},
            {"Host": self.authority, "Origin": "https://example.test"},
            {"Host": self.authority, "Origin": "null"},
            {"Host": "127.0.0.1:9135"},
            {"Host": "example.test", "X-Forwarded-Host": self.authority, "X-Forwarded-Proto": "https"},
            {"Host": self.authority, "Origin": "http://example.test", "X-Forwarded-Proto": "https"},
        ):
            with self.subTest(headers=headers):
                self.assertEqual(self.request(headers=headers)[0], 403)
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        try:
            connection.putrequest("GET", "/api/access", skip_host=True)
            connection.putheader("Host", self.authority)
            connection.putheader("Origin", self.origin)
            connection.putheader("Origin", "https://example.test")
            connection.endheaders()
            response = connection.getresponse()
            self.assertEqual(response.status, 403)
            response.read()
        finally:
            connection.close()

        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        try:
            connection.putrequest("GET", "/api/access", skip_host=True)
            connection.putheader("Host", self.authority)
            connection.putheader("Host", "example.test")
            connection.endheaders()
            response = connection.getresponse()
            self.assertEqual(response.status, 403)
            response.read()
        finally:
            connection.close()

    def test_external_modes_require_loopback_backend_and_fixed_production_port(self):
        for values in (
            {"read_only": False},
            {"read_only": True, "remote_management": True},
            {"read_only": False, "remote_management": True, "https_origin": None},
            {"host": "0.0.0.0"}, {"host": "192.168.7.125"},
            {"test_only": False, "port": 9137}, {"test_only": False, "port": 9445},
        ):
            with self.subTest(values=values), self.assertRaises(ServerConfigurationError):
                self.create(**values)
        with patch("plugin_portal.server.PortalHTTPServer") as server:
            self.create(test_only=False, port=9135)
            self.assertEqual(server.call_args.args[0], ("127.0.0.1", 9135))
            self.assertTrue(server.call_args.kwargs["read_only"])

        with patch("plugin_portal.server.PortalHTTPServer") as server:
            self.create(test_only=False, port=9135, read_only=False, remote_management=True)
            self.assertEqual(server.call_args.args[0], ("127.0.0.1", 9135))
            self.assertFalse(server.call_args.kwargs["read_only"])
            self.assertEqual(server.call_args.kwargs["access_mode"], "remote-management")
            server.call_args.args[1].close()

    def test_remote_management_allows_sessions_and_uses_browser_upload(self):
        self.server = self.create(read_only=False, remote_management=True)
        original_index = (self.web / "index.html").read_bytes()
        (self.web / "index.html").write_text("changed after startup", encoding="utf-8")
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (self.server.shutdown(), self.server.server_close(), thread.join(5)))
        status, _, body = self.request(headers={"Host": self.authority, "Origin": self.origin})
        self.assertEqual(
            (status, json.loads(body)),
            (200, {"readOnly": False, "fileSelectionMode": "browser-upload"}),
        )
        status, _, body = self.request(
            "POST",
            {"Host": self.authority, "Origin": self.origin, "Content-Type": "application/json"},
            "/api/session",
            b"{}",
        )
        self.assertEqual(status, 201)
        self.assertRegex(json.loads(body)["token"], r"^[A-Za-z0-9_-]{32,}$")
        self.assertEqual(self.request(path="/")[2], original_index)

    def start_remote(self):
        self.server = self.create(read_only=False, remote_management=True)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (self.server.shutdown(), self.server.server_close(), thread.join(5)))

    def test_test_only_remote_management_accepts_exact_loopback_https_origin(self):
        origin = "https://127.0.0.1:9443"
        self.server = self.create(
            read_only=False,
            remote_management=True,
            https_origin=origin,
        )
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (self.server.shutdown(), self.server.server_close(), thread.join(5)))
        self.authority = "127.0.0.1:9443"
        self.origin = origin
        self.assertEqual(self.request(headers={"Host": self.authority, "Origin": origin})[0], 200)

    def test_remote_server_close_removes_staged_uploads_and_is_idempotent(self):
        server = self.create(read_only=False, remote_management=True)
        upload = server.api.uploads.stage(
            "session-a", "plugin-import", "plugin.zip", io.BytesIO(b"PK\x03\x04data"), 8,
        )

        server.server_close()
        server.server_close()

        self.assertFalse(upload.path.exists())

    def test_remote_upload_previews_and_promotes_without_exposing_a_path(self):
        self.start_remote()
        common = {"Host": self.authority, "Origin": self.origin}
        status, _, body = self.request(
            "POST", {**common, "Content-Type": "application/json"}, "/api/session", b"{}",
        )
        self.assertEqual(status, 201)
        token = json.loads(body)["token"]
        status, _, body = self.request(
            "POST",
            {
                **common,
                "Content-Type": "application/zip",
                "Content-Disposition": "attachment; filename*=UTF-8''sample-plugin.zip",
                "X-Portal-Session": token,
            },
            "/api/uploads/plugin-import",
            self.plugin_zip,
        )
        self.assertEqual(status, 201)
        uploaded = json.loads(body)
        self.assertEqual(set(uploaded), {"uploadId", "fileName", "archiveBytes"})
        self.assertEqual(uploaded["fileName"], "sample-plugin.zip")
        payload = json.dumps({
            "source": {"kind": "upload", "uploadId": uploaded["uploadId"]},
            "target": "company-dev",
            "expectedPluginId": "sample-plugin",
            "approvedRulePaths": ["rules/public.md"],
            "extensionTools": [],
        }).encode("utf-8")
        status, _, body = self.request(
            "POST",
            {**common, "Content-Type": "application/json", "X-Portal-Session": token},
            "/api/plugins/import/preview",
            payload,
        )
        self.assertEqual(status, 201)
        candidate = json.loads(body)
        public_candidate = json.dumps(candidate)
        self.assertNotIn(str(self.server.api.uploads.root), public_candidate)
        self.assertNotIn(uploaded["uploadId"], public_candidate)
        self.assertNotIn('"source"', public_candidate)
        promote = json.dumps({"candidateId": candidate["candidateId"], "expectedRevision": 0}).encode("utf-8")
        status, _, _ = self.request(
            "POST",
            {**common, "Content-Type": "application/json", "X-Portal-Session": token},
            "/api/plugins/company-dev%2Fsample-plugin/promote",
            promote,
        )
        self.assertEqual(status, 200)

        class Candidate:
            def __init__(self, source_path):
                self.source_path = source_path

            @staticmethod
            def public_preview():
                return {
                    "pluginKey": "company-dev/sample-plugin",
                    "version": "1.2.3",
                    "fileName": "candidate.zip",
                    "destinationFileName": "sample-plugin-1.2.3-company-dev.zip",
                    "candidateSha256": "a" * 64,
                }

        class Receipt:
            @staticmethod
            def public_result():
                return {
                    "pluginKey": "company-dev/sample-plugin",
                    "version": "1.2.3",
                    "fileName": "sample-plugin-1.2.3-company-dev.zip",
                    "candidateSha256": "a" * 64,
                    "archiveBytes": len(self.plugin_zip),
                    "publishedAtUtc": "2026-08-31T00:00:00Z",
                }

        class Publisher:
            @staticmethod
            def preview(path, *, plugin_key, expected_version):
                self.assertEqual((plugin_key, expected_version), ("company-dev/sample-plugin", "1.2.3"))
                return Candidate(path)

            @staticmethod
            def publish(candidate):
                self.assertTrue(candidate.source_path.exists())
                return Receipt()

        self.server.api.download_publisher = Publisher()
        status, _, body = self.request(
            "POST",
            {
                **common,
                "Content-Type": "application/zip",
                "Content-Disposition": 'attachment; filename="candidate.zip"',
                "X-Portal-Session": token,
            },
            "/api/plugins/company-dev%2Fsample-plugin/download-publication/upload",
            self.plugin_zip,
        )
        self.assertEqual(status, 201)
        publication = json.loads(body)
        self.assertTrue(publication["selected"])
        status, _, body = self.request(
            "POST",
            {**common, "Content-Type": "application/json", "X-Portal-Session": token},
            "/api/plugins/company-dev%2Fsample-plugin/download-publication/confirm",
            json.dumps({"publicationId": publication["publicationId"]}).encode("utf-8"),
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["candidateSha256"], publication["preview"]["candidateSha256"])

        status, _, body = self.request(
            "POST",
            {**common, "Content-Type": "application/json", "X-Portal-Session": token},
            "/api/plugins/company-dev%2Fsample-plugin/download-publication/select",
            b"{}",
        )
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"]["code"], "source_mode_invalid")

    def test_remote_upload_rejects_wrong_mode_headers_size_session_and_origin(self):
        self.start_remote()
        common = {"Host": self.authority, "Origin": self.origin}
        status, _, body = self.request(
            "POST", {**common, "Content-Type": "application/json"}, "/api/session", b"{}",
        )
        self.assertEqual(status, 201)
        token = json.loads(body)["token"]
        valid = {
            **common,
            "Content-Type": "application/zip",
            "Content-Disposition": 'attachment; filename="sample-plugin.zip"',
            "X-Portal-Session": token,
        }
        for headers, expected in (
            ({**valid, "Content-Type": "application/octet-stream"}, 400),
            ({key: value for key, value in valid.items() if key != "Content-Disposition"}, 400),
            ({**valid, "X-Portal-Session": "invalid"}, 401),
            ({**valid, "Host": "example.test"}, 403),
            ({**valid, "Origin": "https://example.test"}, 403),
        ):
            with self.subTest(headers=headers):
                self.assertEqual(
                    self.request("POST", headers, "/api/uploads/plugin-import", self.plugin_zip)[0],
                    expected,
                )

        oversized = {**valid, "Content-Length": str(MAX_UPLOAD_BYTES + 1)}
        self.assertEqual(self.request("POST", oversized, "/api/uploads/plugin-import")[0], 413)

        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        try:
            connection.putrequest("POST", "/api/uploads/plugin-import", skip_host=True)
            for name, value in valid.items():
                if name != "Content-Length":
                    connection.putheader(name, value)
            connection.endheaders()
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            response.read()
        finally:
            connection.close()

        server_directory = json.dumps({
            "source": {"kind": "server-directory", "path": str(self.root)},
            "target": "company-dev", "expectedPluginId": "sample-plugin",
            "approvedRulePaths": ["rules/public.md"], "extensionTools": [],
        }).encode("utf-8")
        status, _, body = self.request(
            "POST",
            {**common, "Content-Type": "application/json", "X-Portal-Session": token},
            "/api/plugins/import/preview",
            server_directory,
        )
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"]["code"], "source_mode_invalid")

    def test_rejects_noncanonical_or_nonprivate_https_origins(self):
        for origin in (
            "http://192.168.7.125:9135", "https://8.8.8.8:9135", "https://127.0.0.1:9135",
            "https://localhost:9135", "https://192.168.7.125:9137", "https://192.168.7.125",
            "https://192.168.7.125:9135/", "https://192.168.7.125:9135?x=1",
            "https://192.168.7.125:9135#x", "https://user@192.168.7.125:9135",
            "https://[::1]:9135", "https://192.168.7.125:bad", "",
        ):
            with self.subTest(origin=origin), self.assertRaises(ServerConfigurationError):
                self.create(https_origin=origin)

    def test_cli_exposes_explicit_https_proxy_origin(self):
        args = build_parser().parse_args([
            "serve", "--read-only", "--host", "127.0.0.1", "--port", "9135",
            "--https-origin", self.origin, "--data-root", str(self.store.root), "--web-root", str(self.web),
        ])
        self.assertEqual(args.https_origin, self.origin)

    def test_cli_exposes_mutually_exclusive_remote_management_mode(self):
        args = build_parser().parse_args([
            "serve", "--remote-management", "--host", "127.0.0.1", "--port", "9135",
            "--https-origin", self.origin, "--data-root", str(self.store.root), "--web-root", str(self.web),
        ])
        self.assertTrue(args.remote_management)
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            build_parser().parse_args([
                "serve", "--read-only", "--remote-management",
                "--data-root", str(self.store.root), "--web-root", str(self.web),
            ])


if __name__ == "__main__":
    unittest.main()
