import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from plugin_portal.api import ApiError, _probe_local_download
from plugin_portal.server import create_server


class RecoveryHttpTests(unittest.TestCase):
    def test_unsafe_download_url_is_an_error_without_network_access(self):
        with patch("plugin_portal.api.http.client.HTTPConnection") as connect:
            with self.assertRaises(ApiError) as failure:
                _probe_local_download("https://untrusted.example/download.zip")
        self.assertEqual(failure.exception.code, "download_probe_failed")
        connect.assert_not_called()

    def test_restart_preserves_documents_but_invalidates_old_sessions_and_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            web = root / "web"
            web.mkdir()
            (web / "index.html").write_text("Portal", encoding="utf-8")
            server = None
            thread = None

            def start():
                nonlocal server, thread
                server = create_server(host="127.0.0.1", port=0, data_root=root / "data", web_root=web, test_only=True)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()

            def stop():
                if server:
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=5)

            def request(path, body=None, token=None):
                connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
                try:
                    connection.request("GET" if body is None else "POST", path,
                                       body=None if body is None else json.dumps(body),
                                       headers={"Content-Type": "application/json", **({"X-Portal-Session": token} if token else {})})
                    response = connection.getresponse()
                    return response.status, json.loads(response.read())
                finally:
                    connection.close()

            try:
                start()
                _, session = request("/api/session", {})
                old_token = session["token"]
                _, candidate = request("/api/plugins/import/preview", {
                    "source": {"kind": "server-directory", "path": str(Path(__file__).parent / "fixtures/plugins/minimal")},
                    "target": "company-dev", "expectedPluginId": "sample-plugin",
                    "approvedRulePaths": [], "extensionTools": [],
                }, old_token)
                base = "/api/plugins/company-dev%2Fsample-plugin"
                self.assertEqual(request(base + "/promote", {"expectedRevision": 0, "candidateId": candidate["candidateId"]}, old_token)[0], 200)
                item = {"id": "one", "scenario": "restart", "content": "saved", "createdAt": "2026-09-07T00:00:00Z"}
                self.assertEqual(request(base + "/prompts", {"expectedRevision": 0, "items": [item]}, old_token)[0], 200)
                stop()
                start()
                status, document = request(base + "/prompts")
                self.assertEqual((status, document["revision"], document["items"]), (200, 1, [item]))
                frozen = {"expectedRevision": 1, "items": [{**item, "content": "after restart"}]}
                status, error = request(base + "/prompts", frozen, old_token)
                self.assertEqual((status, error["error"]["code"]), (401, "invalid_session"))
                _, session = request("/api/session", {})
                status, saved = request(base + "/prompts", frozen, session["token"])
                self.assertEqual((status, saved["revision"], saved["items"]), (200, 2, frozen["items"]))
                status, error = request(base + "/promote", {"expectedRevision": 1, "candidateId": candidate["candidateId"]}, session["token"])
                self.assertEqual((status, error["error"]["code"]), (404, "candidate_not_found"))
            finally:
                stop()


if __name__ == "__main__":
    unittest.main()
