import io
import tempfile
import unittest
from pathlib import Path

from plugin_portal.uploads import (
    MAX_ACTIVE_UPLOADS,
    MAX_UPLOAD_BYTES,
    UPLOAD_TTL_SECONDS,
    UploadError,
    UploadRegistry,
)


class ChunkedSource:
    def __init__(self, payload: bytes, chunk_size: int):
        self.payload = payload
        self.chunk_size = chunk_size
        self.offset = 0
        self.read_sizes: list[int] = []

    def read(self, size: int) -> bytes:
        self.read_sizes.append(size)
        end = min(self.offset + self.chunk_size, self.offset + size, len(self.payload))
        chunk = self.payload[self.offset:end]
        self.offset = end
        return chunk


class UploadRegistryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.now = 100.0
        self.registry = UploadRegistry(root=self.root, clock=lambda: self.now)
        self.addCleanup(self.registry.close)

    def stage(self, session: str, kind: str = "plugin-import", name: str = "plugin.zip", payload: bytes = b"PK\x03\x04data"):
        return self.registry.stage(session, kind, name, io.BytesIO(payload), len(payload))

    def test_stage_replaces_same_session_kind_and_isolates_sessions(self):
        first = self.stage("session-a", name="one.zip")
        second = self.stage("session-a", name="two.zip")

        self.assertFalse(first.path.exists())
        self.assertEqual(self.registry.require("session-a", "plugin-import", second.upload_id), second)
        with self.assertRaises(UploadError) as other_session:
            self.registry.require("session-b", "plugin-import", second.upload_id)
        self.assertEqual(other_session.exception.code, "upload_not_found")

    def test_stage_streams_the_declared_body_without_buffering_it_as_one_read(self):
        payload = b"PK\x03\x04" + b"x" * 29
        source = ChunkedSource(payload, chunk_size=3)

        upload = self.registry.stage("session-a", "plugin-import", "plugin.zip", source, len(payload))

        self.assertEqual(upload.size, len(payload))
        self.assertEqual(upload.path.read_bytes(), payload)
        self.assertGreater(len(source.read_sizes), 3)
        self.assertLess(max(source.read_sizes), MAX_UPLOAD_BYTES)

    def test_rejects_invalid_name_or_content_length_without_retaining_a_file(self):
        for name in ("", ".zip", "../plugin.zip", "folder/plugin.zip", "folder\\plugin.zip",
                     "plugin.txt", " plugin.zip", "plugin.zip ", "plugin\x00.zip"):
            with self.subTest(name=name), self.assertRaises(UploadError) as invalid_name:
                self.registry.stage("session-a", "plugin-import", name, io.BytesIO(b"x"), 1)
            self.assertEqual(invalid_name.exception.code, "invalid_upload")

        for length in (True, 0, -1, "1", MAX_UPLOAD_BYTES + 1):
            with self.subTest(length=length), self.assertRaises(UploadError) as invalid_length:
                self.registry.stage("session-a", "plugin-import", "plugin.zip", io.BytesIO(b"x"), length)
            self.assertEqual(
                invalid_length.exception.code,
                "payload_too_large" if length == MAX_UPLOAD_BYTES + 1 else "invalid_upload",
            )
        self.assertEqual(list(self.root.iterdir()), [])

    def test_short_body_is_rejected_and_partial_file_is_removed(self):
        with self.assertRaises(UploadError) as short_body:
            self.registry.stage("session-a", "plugin-import", "plugin.zip", io.BytesIO(b"short"), 12)

        self.assertEqual(short_body.exception.code, "upload_incomplete")
        self.assertEqual(list(self.root.iterdir()), [])

    def test_global_capacity_rejects_a_new_owner_but_allows_replacement(self):
        uploads = [self.stage(f"session-{index}") for index in range(MAX_ACTIVE_UPLOADS)]

        with self.assertRaises(UploadError) as busy:
            self.stage("overflow")
        self.assertEqual(busy.exception.code, "upload_busy")
        replacement = self.stage("session-0", name="replacement.zip")
        self.assertFalse(uploads[0].path.exists())
        self.assertTrue(replacement.path.exists())

    def test_prune_removes_uploads_after_fifteen_minutes(self):
        upload = self.stage("session-a")
        self.now += UPLOAD_TTL_SECONDS - 1
        self.assertEqual(self.registry.require("session-a", "plugin-import", upload.upload_id), upload)
        self.now += 1

        self.registry.prune()

        self.assertFalse(upload.path.exists())
        with self.assertRaises(UploadError) as expired:
            self.registry.require("session-a", "plugin-import", upload.upload_id)
        self.assertEqual(expired.exception.code, "upload_not_found")

    def test_discard_consume_and_close_remove_owned_files_only(self):
        unrelated = self.root / "unrelated.txt"
        unrelated.write_text("keep", encoding="utf-8")
        discarded = self.stage("session-a", "plugin-import", "plugin.zip")
        consumed = self.stage("session-a", "download-publication", "release.zip")

        self.registry.discard("session-a", "plugin-import", discarded.upload_id)
        returned = self.registry.consume("session-a", "download-publication", consumed.upload_id)

        self.assertEqual(returned, consumed)
        self.assertFalse(discarded.path.exists())
        self.assertFalse(consumed.path.exists())
        remaining = self.stage("session-b")
        self.registry.close()
        self.registry.close()
        self.assertFalse(remaining.path.exists())
        self.assertEqual(unrelated.read_text(encoding="utf-8"), "keep")

    def test_rejects_unknown_kind_and_missing_upload(self):
        with self.assertRaises(UploadError) as invalid_kind:
            self.registry.stage("session-a", "other", "plugin.zip", io.BytesIO(b"x"), 1)
        self.assertEqual(invalid_kind.exception.code, "invalid_upload")
        with self.assertRaises(UploadError) as missing:
            self.registry.require("session-a", "plugin-import", "missing")
        self.assertEqual(missing.exception.code, "upload_not_found")


if __name__ == "__main__":
    unittest.main()
