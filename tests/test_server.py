import json
import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from plugin_portal.server import ServerConfigurationError, create_server


class PortalServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_directory.cleanup)
        self.root = Path(self.temp_directory.name)
        self.web_root = self.root / "web"
        self.web_root.mkdir()
        (self.web_root / "index.html").write_text("<!doctype html><title>Plugin Portal</title>", encoding="utf-8")
        self.server = create_server(
            host="127.0.0.1",
            port=0,
            data_root=self.root / "data",
            web_root=self.web_root,
            test_only=True,
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self._stop_server)
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def _stop_server(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def request(self, path: str, *, method: str = "GET", body: dict | None = None, headers: dict | None = None):
        payload = None if body is None else json.dumps(body).encode("utf-8")
        request = Request(
            f"{self.base_url}{path}",
            data=payload,
            method=method,
            headers={"Content-Type": "application/json", **(headers or {})},
        )
        return urlopen(request, timeout=5)

    def test_serves_static_index_and_json_api_without_cors(self) -> None:
        with self.request("/") as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get_content_type(), "text/html")
            self.assertNotIn("Access-Control-Allow-Origin", response.headers)
        with self.request("/api/plugins") as response:
            self.assertEqual(json.load(response), {"revision": 0, "items": []})

    def test_head_returns_static_metadata_without_a_body(self) -> None:
        expected_length = (self.web_root / "index.html").stat().st_size

        try:
            response = self.request("/", method="HEAD")
        except HTTPError as error:
            self.fail(f"HEAD returned {error.code} instead of 200")
        with response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get_content_type(), "text/html")
            self.assertEqual(int(response.headers["Content-Length"]), expected_length)
            self.assertEqual(response.read(), b"")

    def test_creates_session_without_exposing_token_in_cookie(self) -> None:
        with self.request("/api/session", method="POST", body={}) as response:
            payload = json.load(response)
            self.assertRegex(payload["token"], r"^[A-Za-z0-9_-]{32,}$")
            self.assertIsNone(response.headers.get("Set-Cookie"))

    def test_selects_plugin_directory_without_mutating_the_catalog(self) -> None:
        selected_root = self.root / "selected-plugin"
        selected_root.mkdir()
        self.server.api.directory_picker = lambda: selected_root
        with self.request("/api/session", method="POST", body={}) as response:
            token = json.load(response)["token"]

        try:
            response = self.request(
                "/api/plugins/import/select-directory",
                method="POST",
                body={},
                headers={"X-Portal-Session": token},
            )
        except HTTPError as error:
            self.fail(f"directory picker returned {error.code} instead of 200")
        with response:
            self.assertEqual(json.load(response), {"selected": True, "path": str(selected_root)})
        with self.request("/api/plugins") as response:
            self.assertEqual(json.load(response), {"revision": 0, "items": []})

    def test_directory_selection_requires_a_valid_session(self) -> None:
        self.server.api.directory_picker = lambda: self.root
        with self.assertRaises(HTTPError) as invalid_session:
            self.request(
                "/api/plugins/import/select-directory",
                method="POST",
                body={},
                headers={"X-Portal-Session": "invalid"},
            )
        self.assertEqual(invalid_session.exception.code, 401)

    def test_rejects_cross_origin_and_directory_traversal(self) -> None:
        with self.assertRaises(HTTPError) as cross_origin:
            self.request("/api/plugins", headers={"Origin": "https://example.com"})
        self.assertEqual(cross_origin.exception.code, 403)

        with self.assertRaises(HTTPError) as traversal:
            self.request("/%2e%2e/secret.txt")
        self.assertEqual(traversal.exception.code, 404)

    def test_only_explicit_test_mode_can_use_ephemeral_port(self) -> None:
        with self.assertRaises(ServerConfigurationError):
            create_server(
                host="127.0.0.1",
                port=0,
                data_root=self.root / "another-data",
                web_root=self.web_root,
            )
        with self.assertRaises(ServerConfigurationError):
            create_server(
                host="0.0.0.0",
                port=9137,
                data_root=self.root / "another-data",
                web_root=self.web_root,
            )
        with self.assertRaises(ServerConfigurationError):
            create_server(
                host="127.0.0.1",
                port=9137,
                data_root=self.root / "another-data",
                web_root=self.web_root,
                test_only=True,
            )

    def test_serves_plugin_scoped_prompts_and_workflows(self) -> None:
        with self.request("/api/session", method="POST", body={}) as response:
            token = json.load(response)["token"]
        headers = {"X-Portal-Session": token}
        encoded_key = "company-dev%2Fsample-plugin"

        with self.request(
            f"/api/plugins/{encoded_key}/prompts",
            method="POST",
            body={
                "expectedRevision": 0,
                "items": [{"id": "one", "scenario": "一", "content": "内容", "createdAt": "2026-08-26T00:00:00Z"}],
            },
            headers=headers,
        ) as response:
            self.assertEqual(json.load(response)["revision"], 1)
        with self.request(f"/api/plugins/{encoded_key}/prompts") as response:
            self.assertEqual(json.load(response)["items"][0]["id"], "one")

        workflow = {"pluginKey": "company-dev/sample-plugin", "tabs": []}
        with self.request(
            f"/api/plugins/{encoded_key}/workflows",
            method="POST",
            body={"expectedRevision": 0, "workflow": workflow},
            headers=headers,
        ) as response:
            self.assertEqual(json.load(response)["revision"], 1)
        with self.request(f"/api/plugins/{encoded_key}/workflows") as response:
            self.assertEqual(json.load(response)["tabs"], [])

    def test_serves_only_the_active_installed_plugin_icon_and_download_metadata(self) -> None:
        source = Path(__file__).parent / "fixtures" / "plugins" / "minimal"
        cache_root = self.root / "cache"
        installed = cache_root / "company-dev" / "sample-plugin" / "1.2.3"
        shutil.copytree(source, installed)
        icon_payload = b"\x89PNG\r\n\x1a\nfixture"
        (installed / "assets").mkdir()
        (installed / "assets" / "logo.png").write_bytes(icon_payload)
        manifest_path = installed / ".codex-plugin" / "plugin.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["interface"]["logo"] = "./assets/logo.png"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        self.server.api.plugin_cache_root = cache_root
        self.server.api.download_probe = lambda _url: True

        token = self.server.api.create_session()["token"]
        candidate = self.server.api.preview_import(
            token,
            {
                "pluginRoot": str(source),
                "target": "company-dev",
                "expectedPluginId": "sample-plugin",
                "approvedRulePaths": ["rules/public.md"],
                "extensionTools": [],
            },
        )
        self.server.api.promote(
            token,
            "company-dev/sample-plugin",
            {"candidateId": candidate["candidateId"], "expectedRevision": 0},
        )
        encoded_key = "company-dev%2Fsample-plugin"

        with self.request(f"/api/plugins/{encoded_key}/icon") as response:
            self.assertEqual(response.headers.get_content_type(), "image/png")
            self.assertEqual(response.read(), icon_payload)
        with self.request(f"/api/plugins/{encoded_key}/download-info") as response:
            self.assertEqual(
                json.load(response),
                {
                    "available": True,
                    "version": "1.2.3",
                    "href": "http://127.0.0.1:9134/downloads/sample-plugin-1.2.3-company-dev.zip",
                },
            )


if __name__ == "__main__":
    unittest.main()
