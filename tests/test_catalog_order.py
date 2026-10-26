import hashlib
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from plugin_portal.api import ApiError, PortalApi
from plugin_portal.storage import PortalStore, StorageError


class CatalogOrderTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "source"
        shutil.copytree(Path(__file__).parent / "fixtures/plugins/minimal", self.source)
        self.store = PortalStore(self.root / "data")
        self.api = PortalApi(self.store)
        self.token = self.api.create_session()["token"]
        self.include("alpha")
        self.include("beta")
        self.include("gamma")
        self.include("beta", target="company-internal", version="2.0.0")

    def include(self, name, target="company-dev", version="1.0.0"):
        path = self.source / ".codex-plugin/plugin.json"
        manifest = json.loads(path.read_text(encoding="utf-8"))
        manifest["name"], manifest["version"] = name, version
        path.write_text(json.dumps(manifest), encoding="utf-8")
        candidate = self.api.preview_import(self.token, {"source": {"kind": "server-directory", "path": str(self.source)},
            "target": target, "expectedPluginId": name, "approvedRulePaths": [], "extensionTools": []})
        return self.api.promote(self.token, candidate["pluginKey"], {"candidateId": candidate["candidateId"],
            "expectedRevision": self.api.list_plugins()["revision"]})

    def order(self):
        return list(dict.fromkeys(item["id"] for item in self.api.list_plugins()["items"]))

    def reorder(self, ids, revision=None):
        return self.api.reorder_plugins(self.token, {"pluginIds": ids,
            "expectedRevision": self.api.list_plugins()["revision"] if revision is None else revision})

    def test_persists_group_order_without_changing_catalog_records_or_other_files(self):
        before = self.store.read_document("catalog")["data"]
        snapshots = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in self.store.root.rglob("*.json") if p.name != "catalog.json"}
        self.assertEqual(self.reorder(["gamma", "beta", "alpha"]), {"revision": 5, "pluginIds": ["gamma", "beta", "alpha"]})
        self.assertEqual(self.order(), ["gamma", "beta", "alpha"])
        self.assertEqual(self.store.read_document("catalog")["data"], before)
        self.assertEqual([(item["id"], item["pluginKey"]) for item in self.api.list_plugins()["items"]], [
            ("gamma", "company-dev/gamma"), ("beta", "company-dev/beta"), ("beta", "company-internal/beta"), ("alpha", "company-dev/alpha")])
        reader = PortalApi(PortalStore(self.store.root), access_mode="read-only")
        self.assertEqual(reader.list_plugins(), self.api.list_plugins())
        for path, digest in snapshots.items():
            self.assertEqual(hashlib.sha256(Path(path).read_bytes()).hexdigest(), digest)

    def test_new_families_append_in_admission_order_and_upgrades_keep_position(self):
        self.reorder(["gamma", "beta", "alpha"])
        self.include("zeta")
        self.include("delta")
        self.include("beta", version="3.0.0")
        self.assertEqual(self.order(), ["gamma", "beta", "alpha", "zeta", "delta"])

    def test_deleting_one_source_keeps_family_position_and_readding_deleted_family_appends(self):
        self.reorder(["beta", "gamma", "alpha"])
        self.api.remove_plugin(self.token, "company-dev/beta", {"expectedRevision": 5})
        self.assertEqual(self.order(), ["beta", "gamma", "alpha"])
        self.api.remove_plugin(self.token, "company-internal/beta", {"expectedRevision": 6})
        self.include("beta")
        self.assertEqual(self.order(), ["gamma", "alpha", "beta"])

    def test_invalid_or_stale_order_does_not_change_any_data(self):
        before = self.store.read_document("catalog")
        for ids in (["alpha"], ["alpha", "beta", "gamma", "other"], ["alpha", "alpha", "gamma"],
                    ["company-dev/alpha", "beta", "gamma"], [True, "beta", "gamma"], "alpha"):
            with self.subTest(ids=ids), self.assertRaises(ApiError):
                self.reorder(ids)
        with self.assertRaises(ApiError) as conflict:
            self.reorder(["gamma", "beta", "alpha"], revision=3)
        self.assertEqual(conflict.exception.code, "revision_conflict")
        self.assertEqual(self.store.read_document("catalog"), before)
        self.assertEqual(self.store.read_document("catalog-order")["revision"], 0)

    def test_session_and_readonly_guards(self):
        with self.assertRaises(ApiError) as session:
            self.api.reorder_plugins("invalid", {"pluginIds": ["gamma", "beta", "alpha"], "expectedRevision": 4})
        self.assertEqual(session.exception.status, 401)
        self.api.access_mode = "read-only"
        with self.assertRaises(ApiError) as readonly:
            self.reorder(["gamma", "beta", "alpha"])
        self.assertEqual(readonly.exception.code, "read_only")

    def test_atomic_failure_restores_catalog_and_saved_order(self):
        self.reorder(["gamma", "beta", "alpha"])
        before = self.store.read_document("catalog")
        saved = self.store.read_document("catalog-order")
        original = self.store._atomic_write_json
        def fail_order(path, value):
            if path.name == "catalog-order.json":
                raise StorageError("simulated write failure")
            original(path, value)
        with patch.object(self.store, "_atomic_write_json", side_effect=fail_order):
            with self.assertRaises(ApiError):
                self.reorder(["alpha", "beta", "gamma"])
        self.assertEqual(self.store.read_document("catalog"), before)
        self.assertEqual(self.store.read_document("catalog-order"), saved)
