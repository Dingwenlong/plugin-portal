import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from plugin_portal.__main__ import build_parser
from plugin_portal.server import ServerConfigurationError, create_server
from plugin_portal.storage import PortalStore


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

    def request(self, method="GET", headers=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        try:
            connection.request(method, "/api/access", headers=headers or {"Host": self.authority})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_https_proxy_keeps_read_only_and_get_head_parity(self):
        self.start()
        status, headers, body = self.request(headers={"Host": self.authority, "Origin": self.origin})
        self.assertEqual((status, json.loads(body)), (200, {"readOnly": True}))
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

    def test_proxy_mode_requires_read_only_loopback_and_fixed_port(self):
        for values in (
            {"read_only": False}, {"host": "0.0.0.0"}, {"host": "192.168.7.125"},
            {"test_only": False, "port": 9137}, {"test_only": False, "port": 9445},
        ):
            with self.subTest(values=values), self.assertRaises(ServerConfigurationError):
                self.create(**values)
        with patch("plugin_portal.server.PortalHTTPServer") as server:
            self.create(test_only=False, port=9135)
            self.assertEqual(server.call_args.args[0], ("127.0.0.1", 9135))
            self.assertTrue(server.call_args.kwargs["read_only"])

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


if __name__ == "__main__":
    unittest.main()
