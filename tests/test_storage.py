import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from plugin_portal.storage import PortalStore, RevisionConflict, StorageError


class PortalStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_directory.cleanup)
        self.root = Path(self.temp_directory.name)
        self.store = PortalStore(self.root)

    def test_missing_document_starts_at_revision_zero(self) -> None:
        self.assertEqual(self.store.read_document("catalog"), {"revision": 0, "data": {}})

    def test_write_increments_revision_and_persists_utf8_json(self) -> None:
        written = self.store.write_document(
            "catalog",
            {"plugin": "昱勝 Inc"},
            expected_revision=0,
        )

        self.assertEqual(written, {"revision": 1, "data": {"plugin": "昱勝 Inc"}})
        self.assertEqual(self.store.read_document("catalog"), written)
        self.assertIn("昱勝 Inc", (self.root / "catalog.json").read_text(encoding="utf-8"))

    def test_stale_revision_cannot_overwrite_current_data(self) -> None:
        self.store.write_document("prompts", {"items": ["first"]}, expected_revision=0)

        with self.assertRaises(RevisionConflict):
            self.store.write_document("prompts", {"items": ["stale"]}, expected_revision=0)

        self.assertEqual(
            self.store.read_document("prompts"),
            {"revision": 1, "data": {"items": ["first"]}},
        )

    def test_failed_replace_preserves_previous_document(self) -> None:
        original = self.store.write_document("workflows", {"tabs": []}, expected_revision=0)

        with patch("plugin_portal.storage.os.replace", side_effect=OSError("replace failed")):
            with self.assertRaises(StorageError):
                self.store.write_document(
                    "workflows",
                    {"tabs": [{"id": "changed"}]},
                    expected_revision=1,
                )

        self.assertEqual(self.store.read_document("workflows"), original)
        self.assertEqual(list(self.root.glob(".workflows.*.tmp")), [])

    def test_document_name_cannot_escape_data_root(self) -> None:
        for name in ("../catalog", "nested/catalog", "C:private"):
            with self.subTest(name=name):
                with self.assertRaises(StorageError):
                    self.store.read_document(name)

    def test_snapshot_is_immutable_and_scoped_by_plugin_identity(self) -> None:
        snapshot = {"schemaVersion": "1.0.0", "plugin": {"id": "shared"}}

        first = self.store.put_snapshot("company-dev/project-delivery-hub", snapshot)
        second = self.store.put_snapshot("company-dev/project-delivery-hub", snapshot)
        other = self.store.put_snapshot("company-dev/yusheng-inc", snapshot)

        self.assertEqual(first, second)
        self.assertEqual(first, other)
        files = sorted(path.relative_to(self.root).as_posix() for path in self.root.rglob("*.json"))
        self.assertEqual(
            files,
            [
                f"snapshots/company-dev/project-delivery-hub/{first}.json",
                f"snapshots/company-dev/yusheng-inc/{other}.json",
            ],
        )
        stored = json.loads(
            (self.root / "snapshots" / "company-dev" / "project-delivery-hub" / f"{first}.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(stored, snapshot)


if __name__ == "__main__":
    unittest.main()
