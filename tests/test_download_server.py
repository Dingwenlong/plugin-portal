from __future__ import annotations

import http.client
import importlib.util
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / "scripts/download-server.py"


class DownloadServerTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("download_server", SOURCE)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temporary = tempfile.TemporaryDirectory(prefix="portal-download-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "share"
        (self.root / "downloads").mkdir(parents=True)
        (self.root / "project-delivery-hub/assets").mkdir(parents=True)
        (self.root / "project-delivery-hub/index.html").write_bytes(b"<html>Published</html>")
        (self.root / "project-delivery-hub/assets/app.js").write_bytes(b"console.log('public');")
        (self.root / "downloads/example-1.0.0-company-dev.zip").write_bytes(b"PK" + bytes(range(256)) * 4096)
        self.server = self.module.create_server(self.root, 0)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join(3)

    def request(self, path, method="GET"):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        try:
            connection.request(method, path)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_download_get_and_head_preserve_original_bytes(self):
        path = "/downloads/example-1.0.0-company-dev.zip"
        expected = (self.root / path[1:]).read_bytes()
        status, headers, body = self.request(path)
        self.assertEqual((200, expected), (status, body))
        self.assertEqual("application/zip", headers["Content-Type"])
        self.assertEqual(str(len(expected)), headers["Content-Length"])
        status, headers, body = self.request(path, "HEAD")
        self.assertEqual((200, b""), (status, body))
        self.assertEqual(str(len(expected)), headers["Content-Length"])
        self.assertEqual(404, self.request("/downloads/missing-1.0.zip")[0])

    def test_loopback_only_and_static_page_still_available(self):
        self.assertEqual("127.0.0.1", self.server.server_address[0])
        status, headers, body = self.request("/")
        self.assertEqual((302, "/project-delivery-hub/", b""), (status, headers["Location"], body))
        self.assertEqual(200, self.request("/project-delivery-hub/")[0])
        self.assertEqual(200, self.request("/project-delivery-hub/assets/app.js")[0])
        self.assertEqual(405, self.request("/downloads/example-1.0.0-company-dev.zip", "POST")[0])

    def test_private_api_quarantine_and_directory_listing_stay_unavailable(self):
        (self.root / "downloads/.candidate.zip.quarantine").write_bytes(b"private")
        (self.root / "downloads/secret.zip.quarantine").write_bytes(b"private")
        (self.root / "downloads/secret.json").write_bytes(b"private")
        (self.root / "private").mkdir()
        (self.root / "private/secret.txt").write_bytes(b"private")
        for path in ("/api/prompts/session", "/api/prompts/lan-access", "/api/access", "/downloads/",
                     "/downloads/.candidate.zip.quarantine", "/downloads/secret.zip.quarantine",
                     "/downloads/secret.json", "/private/secret.txt"):
            with self.subTest(path=path):
                self.assertEqual(404, self.request(path)[0])
        self.assertEqual(404, self.request("/api/prompts/session", "POST")[0])

    def test_traversal_dot_paths_and_windows_aliases_are_rejected(self):
        for path in ("/downloads/../private/secret.txt", "/downloads/%2e%2e/private/secret.txt",
                     "/downloads/%252e%252e/private/secret.txt", "/downloads/a.zip::$DATA",
                     "/downloads/a.zip%00", "/downloads/.git/config", "/downloads/a.zip.",
                     "/downloads/a.zip%20", "/downloads/a%5cb.zip"):
            with self.subTest(path=path):
                self.assertEqual(404, self.request(path)[0])

    def test_link_added_after_start_cannot_escape_the_share(self):
        outside = Path(self.temporary.name) / "secret.zip"
        outside.write_bytes(b"private")
        link = self.root / "downloads/linked.zip"
        try:
            link.symlink_to(outside)
        except OSError:
            if os.name != "nt":
                raise
            # Junction creation does not require the Windows symlink privilege.
            import subprocess
            target = Path(self.temporary.name) / "linked-assets"
            target.mkdir()
            (target / "secret.js").write_bytes(b"private")
            junction = self.root / "project-delivery-hub/assets/junction"
            result = subprocess.run(["cmd", "/c", "mklink", "/J", str(junction), str(target)],
                                    capture_output=True, check=True)
            self.assertEqual(0, result.returncode)
            self.addCleanup(junction.rmdir)
            self.assertEqual(404, self.request("/project-delivery-hub/assets/junction/secret.js")[0])
        else:
            self.assertEqual(404, self.request("/downloads/linked.zip")[0])

    @unittest.skipUnless(os.name == "nt", "Windows file attributes")
    def test_windows_hidden_and_system_files_are_not_public(self):
        import ctypes
        path = self.root / "downloads/example-1.0.0-company-dev.zip"
        original = path.stat().st_file_attributes
        try:
            for flag in (2, 4):
                self.assertTrue(ctypes.windll.kernel32.SetFileAttributesW(str(path), original | flag))
                self.assertEqual(404, self.request("/downloads/example-1.0.0-company-dev.zip")[0])
        finally:
            ctypes.windll.kernel32.SetFileAttributesW(str(path), original)

    def test_read_error_before_headers_is_503_not_missing(self):
        original = Path.open
        def deny_file(path, *args, **kwargs):
            if path.name.endswith(".zip"):
                raise PermissionError("test-only failure")
            return original(path, *args, **kwargs)
        with patch.object(Path, "open", deny_file):
            self.assertEqual(503, self.request("/downloads/example-1.0.0-company-dev.zip")[0])

    def test_interrupted_stream_never_appends_an_http_error_to_zip_bytes(self):
        def interrupt(source, destination, length):
            destination.write(b"PK")
            raise OSError("test-only interruption")
        with patch.object(self.module.shutil, "copyfileobj", interrupt):
            with self.assertRaises(http.client.IncompleteRead) as error:
                self.request("/downloads/example-1.0.0-company-dev.zip")
        self.assertEqual(b"PK", error.exception.partial)


if __name__ == "__main__":
    unittest.main()
