import io
import json
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen
from unittest.mock import patch

from PIL import Image, PngImagePlugin

from plugin_portal.api import ApiError, PortalApi
from plugin_portal.storage import PortalStore, StorageError
from plugin_portal.server import create_server
from plugin_portal.workflow_images import WorkflowImageError, WorkflowImageStore
from plugin_portal.workflows import WorkflowValidationError, validate_workflow

KEY = "company-dev/sample-plugin"
OTHER = "company-dev/other-plugin"


def picture(fmt="PNG", color="red", **kwargs):
    output = io.BytesIO()
    Image.new("RGB", (80, 40), color).save(output, format=fmt, **kwargs)
    return output.getvalue()


def document(images):
    return {"pluginKey": KEY, "tabs": [{"id": "tab", "title": "Install", "sections": [
        {"id": "section", "title": "First", "steps": [{"id": "step", "label": "1",
         "title": "Prepare", "description": "Keep text", "next": [], "images": images}]}]}]}


class WorkflowImageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = PortalStore(self.temp.name)
        self.api = PortalApi(self.store)
        self.store.write_document("catalog", {"plugins": {
            key: {"plugin": {"version": "1.0.0"}} for key in (KEY, OTHER)
        }}, 0)
        self.token = self.api.create_session()["token"]

    def upload(self, payload=None, mime="image/png", key=KEY):
        payload = picture() if payload is None else payload
        return self.api.upload_workflow_image(self.token, key, mime, io.BytesIO(payload), len(payload))

    def save(self, images, revision=0):
        return self.api.save_workflows(self.token, KEY, {"expectedRevision": revision, "workflow": document(images)})

    def test_stage_save_read_restart_and_remove(self):
        receipt = self.upload()
        image = {"assetId": receipt["assetId"], "alt": "Example"}
        with self.assertRaises(ApiError) as hidden:
            self.api.get_workflow_image(KEY, image["assetId"], "full")
        self.assertEqual(hidden.exception.status, 404)
        saved = self.save([image])
        self.assertEqual(saved["tabs"][0]["sections"][0]["steps"][0]["images"], [image])
        restarted = PortalApi(PortalStore(self.temp.name))
        for variant in ("full", "thumb"):
            mime, content = restarted.get_workflow_image(KEY, image["assetId"], variant)
            self.assertTrue(mime.startswith("image/"))
            with Image.open(io.BytesIO(content)) as decoded:
                decoded.load()
                self.assertEqual(decoded.width / decoded.height, 2)
        self.save([], saved["revision"])
        with self.assertRaises(ApiError):
            self.api.get_workflow_image(KEY, image["assetId"], "full")

    def test_text_edit_does_not_rewrite_unchanged_image_index(self):
        receipt = self.upload()
        image = {"assetId": receipt["assetId"], "alt": "Saved image"}
        saved = self.save([image])
        before = self.store.read_document("workflow-images")
        value = document([image]); value["tabs"][0]["title"] = "Changed title"
        with patch.object(self.store, "_atomic_write_json", wraps=self.store._atomic_write_json) as write:
            self.api.save_workflows(self.token, KEY, {"expectedRevision": saved["revision"], "workflow": value})
        self.assertEqual([call.args[0].name for call in write.call_args_list], ["workflows.json"])
        self.assertEqual(self.store.read_document("workflow-images"), before)
        self.assertEqual(self.api.get_workflows(KEY)["tabs"], value["tabs"])

    def test_formats_metadata_and_idempotent_upload(self):
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("private-note", "should not be served")
        receipt = self.upload(picture(pnginfo=metadata))
        self.assertEqual(receipt, self.upload(picture(pnginfo=metadata)))
        self.save([{"assetId": receipt["assetId"], "alt": ""}])
        _, body = self.api.get_workflow_image(KEY, receipt["assetId"], "full")
        with Image.open(io.BytesIO(body)) as image:
            self.assertNotIn("private-note", image.info)
        for fmt, mime in (("JPEG", "image/jpeg"), ("WEBP", "image/webp")):
            self.assertEqual(self.upload(picture(fmt), mime)["width"], 80)

    def test_individual_substep_titles_descriptions_and_order_survive_save(self):
        first = self.upload()
        second = self.upload(picture(color="blue"))
        images = [{"assetId": first["assetId"], "title": "打开面板", "alt": "发送打开面板指令"},
                  {"assetId": second["assetId"], "title": "选择任务", "alt": "选择需要处理的任务"}]
        saved = self.save(images)
        images.reverse()
        saved = self.save(images, saved["revision"])
        self.assertEqual(PortalApi(PortalStore(self.temp.name)).get_workflows(KEY)["tabs"][0]["sections"][0]["steps"][0]["images"], images)
        for title in (42, "x" * 201, "bad\nheading", "bad\0heading"):
            with self.subTest(title=title), self.assertRaises(WorkflowValidationError):
                validate_workflow(document([{**images[0], "title": title}]), expected_plugin_key=KEY)
        self.assertEqual(self.api.get_workflows(KEY), saved)

    def test_six_unlinked_cards_and_staged_images_survive_restart_and_save(self):
        receipt = self.upload()
        image = {"assetId": receipt["assetId"], "alt": "Screenshot"}
        value = document([image])
        steps = value["tabs"][0]["sections"][0]["steps"]
        for index in range(2, 7):
            steps.append({"id": f"step-{index}", "label": str(index), "title": f"Step {index}",
                          "description": "Draft", "next": [], "images": [image]})
        restarted = PortalApi(PortalStore(self.temp.name))
        token = restarted.create_session()["token"]
        saved = restarted.save_workflows(token, KEY, {"expectedRevision": 0, "workflow": value})
        self.assertEqual(saved["tabs"], value["tabs"])
        self.assertEqual(restarted.get_workflows(KEY)["tabs"], value["tabs"])
        self.assertTrue(restarted.get_workflow_image(KEY, receipt["assetId"], "full")[1])

    def test_rejects_invalid_oversized_animated_and_cross_plugin_references(self):
        for payload, mime in ((b"<svg/>", "image/svg+xml"), (b"<html/>", "image/png"),
                              (picture()[:30], "image/png"), (picture(), "image/jpeg")):
            with self.subTest(mime=mime, size=len(payload)), self.assertRaises(ApiError):
                self.upload(payload, mime)
        animated = io.BytesIO()
        Image.new("RGB", (4, 4), "red").save(animated, "PNG", save_all=True,
            append_images=[Image.new("RGB", (4, 4), "blue")], duration=100)
        with self.assertRaises(ApiError):
            self.upload(animated.getvalue())
        with self.assertRaises(ApiError):
            self.api.upload_workflow_image(self.token, KEY, "image/png", io.BytesIO(), 10 * 1024 * 1024 + 1)
        with patch("plugin_portal.workflow_images.MAX_PIXELS", 10):
            with self.assertRaises(ApiError):
                self.upload()
        receipt = self.upload(key=OTHER)
        with self.assertRaises(ApiError):
            self.save([{"assetId": receipt["assetId"], "alt": ""}])
        for images in ([{"assetId": "../escape", "alt": ""}],
                       [{"assetId": "a" * 64, "alt": ""}] * 7):
            with self.assertRaises(WorkflowValidationError):
                validate_workflow(document(images), expected_plugin_key=KEY)

    def test_rejects_a_png_with_a_corrupted_pixel_chunk_checksum(self):
        payload = bytearray(picture())
        position = 8
        while position < len(payload):
            size = int.from_bytes(payload[position:position + 4], "big")
            if payload[position + 4:position + 8] == b"IDAT":
                payload[position + 8 + size] ^= 1
                break
            position += size + 12
        with self.assertRaises(ApiError) as broken:
            self.upload(bytes(payload))
        self.assertEqual(broken.exception.code, "image_invalid")

    def test_conflict_preserves_saved_images_and_expiry_never_deletes_references(self):
        receipt = self.upload()
        ref = {"assetId": receipt["assetId"], "alt": ""}
        self.save([ref])
        with self.assertRaises(ApiError) as conflict:
            self.save([], 0)
        self.assertEqual(conflict.exception.code, "revision_conflict")
        images = WorkflowImageStore(self.store)
        with patch("plugin_portal.workflow_images.time.time", return_value=4_000_000_000):
            images.cleanup()
        self.api.get_workflow_image(KEY, receipt["assetId"], "full")
        self.save([], 1)
        with patch("plugin_portal.workflow_images.time.time", return_value=4_000_000_000):
            images.cleanup()
        with self.assertRaises(WorkflowImageError):
            images.require(KEY, receipt["assetId"])

    def test_missing_dependency_session_and_readonly_do_not_break_plain_reads(self):
        with patch("plugin_portal.workflow_images.load_pillow", side_effect=WorkflowImageError(
                "image_processing_unavailable", "Unavailable", 503)):
            self.assertEqual(self.api.get_workflows(KEY)["tabs"], [])
            with self.assertRaises(ApiError) as missing:
                self.upload()
            self.assertEqual(missing.exception.code, "image_processing_unavailable")
        with self.assertRaises(ApiError) as session:
            self.api.upload_workflow_image("expired", KEY, "image/png", io.BytesIO(picture()), len(picture()))
        self.assertEqual(session.exception.code, "invalid_session")
        self.api.access_mode = "read-only"
        with self.assertRaises(ApiError) as readonly:
            self.upload()
        self.assertEqual(readonly.exception.status, 403)

    def test_failed_stage_can_retry_without_overwriting_existing_bytes(self):
        write = self.store._atomic_write_bytes
        def fail_thumb(path, payload):
            if path.name == "thumb.webp":
                raise StorageError("disk full")
            write(path, payload)
        with patch.object(self.store, "_atomic_write_bytes", side_effect=fail_thumb):
            with self.assertRaises(ApiError):
                self.upload()
        receipt = self.upload()
        ref = {"assetId": receipt["assetId"], "alt": ""}
        self.save([ref])
        directory = WorkflowImageStore(self.store)._directory(KEY, receipt["assetId"])
        (directory / "full.png").write_bytes(b"different bytes")
        with self.assertRaises(ApiError):
            self.upload()
        self.assertEqual((directory / "full.png").read_bytes(), b"different bytes")

    def test_staging_capacity_and_processing_concurrency_have_identifiable_errors(self):
        with patch("plugin_portal.workflow_images.MAX_STAGED_BYTES", 1):
            with self.assertRaises(ApiError) as full:
                self.upload()
            self.assertEqual(full.exception.code, "image_staging_full")
        busy = threading.BoundedSemaphore(2)
        busy.acquire(); busy.acquire()
        with patch("plugin_portal.workflow_images._PROCESSING", busy):
            with self.assertRaises(ApiError) as processing:
                self.upload()
            self.assertEqual(processing.exception.code, "image_busy")
            busy.release()
            self.upload()
            self.assertTrue(busy.acquire(blocking=False), "upload must release its processing slot")

    def test_expiry_grace_and_cleanup_on_next_save(self):
        images = WorkflowImageStore(self.store)
        start = time.time()
        with patch("plugin_portal.workflow_images.time.time", return_value=start):
            first = self.upload()
        with patch("plugin_portal.workflow_images.time.time", return_value=start + 86399):
            images.cleanup()
            images.require(KEY, first["assetId"])
        with patch("plugin_portal.workflow_images.time.time", return_value=start + 86401):
            self.save([])
        with self.assertRaises(WorkflowImageError):
            images.require(KEY, first["assetId"])
        self.assertEqual(self.store.read_document("workflow-images")["data"], {})

    def test_failed_reference_commit_keeps_previous_workflow_and_staging_private(self):
        old = {"assetId": self.upload()["assetId"], "alt": "old"}
        self.save([old])
        new = {"assetId": self.upload(picture(color="blue"))["assetId"], "alt": "new"}
        write = self.store._atomic_write_json
        def fail_index(path, payload):
            if path.name == "workflow-images.json":
                raise StorageError("disk full")
            write(path, payload)
        with patch.object(self.store, "_atomic_write_json", side_effect=fail_index):
            with self.assertRaises(ApiError):
                self.save([new], 1)
        self.assertEqual(self.api.get_workflows(KEY)["tabs"][0]["sections"][0]["steps"][0]["images"], [old])
        self.api.get_workflow_image(KEY, old["assetId"], "full")
        with self.assertRaises(ApiError):
            self.api.get_workflow_image(KEY, new["assetId"], "full")

    def test_invalid_references_and_unknown_owned_files_fail_closed(self):
        image = {"assetId": self.upload()["assetId"], "alt": ""}
        for refs in ([image, image], [{**image, "alt": "a" * 201}], [{**image, "href": "/secret"}],
                     [{**image, "assetId": "a" * 64, "alt": "\x00"}]):
            with self.assertRaises(WorkflowValidationError):
                validate_workflow(document(refs), expected_plugin_key=KEY)
        directory = WorkflowImageStore(self.store)._directory(KEY, image["assetId"])
        unknown = directory / "unrelated.txt"
        unknown.write_text("keep", encoding="utf-8")
        with patch("plugin_portal.workflow_images.time.time", return_value=time.time() + 90000):
            with self.assertRaises(StorageError):
                WorkflowImageStore(self.store).cleanup()
        self.assertTrue(unknown.exists())

    def test_malformed_saved_references_block_cleanup_with_an_identifiable_error(self):
        self.store.write_document("workflows", {"plugins": {KEY: {"unrecognized": True}}}, 0)
        with self.assertRaises(ApiError) as rejected:
            self.upload()
        self.assertEqual(rejected.exception.code, "image_storage_failed")
        self.assertEqual(rejected.exception.status, 500)

    def test_http_upload_origin_session_binary_reads_and_readonly(self):
        web = self.store.root / "web"
        web.mkdir()
        (web / "index.html").write_text("<!doctype html><title>Test</title>", encoding="utf-8")
        server = create_server(host="127.0.0.1", port=0, data_root=self.store.root, web_root=web, test_only=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            origin = f"http://127.0.0.1:{server.server_address[1]}"
            endpoint = f"{origin}/api/plugins/{quote(KEY, safe='')}/workflows/images"
            token = server.api.create_session()["token"]
            def upload(headers):
                return urlopen(Request(endpoint, data=picture(), headers={"Content-Type": "image/png", **headers}), timeout=5)
            for headers, status in (({}, 401), ({"X-Portal-Session": token, "Origin": "https://other.example"}, 403)):
                with self.assertRaises(HTTPError) as rejected:
                    upload(headers)
                self.assertEqual(rejected.exception.code, status)
            with upload({"X-Portal-Session": token, "Origin": origin}) as response:
                self.assertEqual(response.status, 201)
                receipt = json.load(response)
            url = f"{endpoint}/{receipt['assetId']}/full"
            with self.assertRaises(HTTPError) as private:
                urlopen(url, timeout=5)
            self.assertEqual(private.exception.code, 404)
            self.save([{"assetId": receipt["assetId"], "alt": ""}])
            for method in ("GET", "HEAD"):
                with urlopen(Request(url, method=method), timeout=5) as response:
                    self.assertEqual(response.headers["Content-Type"], "image/png")
                    self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
                    self.assertEqual(response.headers["Cache-Control"], "no-store")
                    self.assertGreater(int(response.headers["Content-Length"]), 0)
                    self.assertEqual(bool(response.read()), method == "GET")
            server.read_only = True
            with self.assertRaises(HTTPError) as readonly:
                upload({"X-Portal-Session": token})
            self.assertEqual(readonly.exception.code, 403)
            with urlopen(url, timeout=5) as response:
                self.assertEqual(response.status, 200)
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
