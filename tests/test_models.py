import unittest

from plugin_portal.models import (
    ModelValidationError,
    canonical_json_bytes,
    parse_plugin_key,
    validate_revisioned_document,
)


class PluginIdentityTests(unittest.TestCase):
    def test_parses_complete_plugin_identity(self) -> None:
        self.assertEqual(
            parse_plugin_key("company-dev/project-delivery-hub"),
            ("company-dev", "project-delivery-hub"),
        )

    def test_rejects_incomplete_or_path_like_identity(self) -> None:
        for value in ("project-delivery-hub", "company-dev/../secret", "/absolute"):
            with self.subTest(value=value):
                with self.assertRaises(ModelValidationError):
                    parse_plugin_key(value)


class ClosedDocumentTests(unittest.TestCase):
    def test_accepts_closed_revisioned_document(self) -> None:
        document = {"revision": 2, "data": {"enabled": True}}
        self.assertEqual(validate_revisioned_document(document), document)

    def test_rejects_unknown_keys_and_invalid_revision(self) -> None:
        for document in (
            {"revision": 0, "data": {}, "privatePath": "secret"},
            {"revision": -1, "data": {}},
            {"revision": True, "data": {}},
        ):
            with self.subTest(document=document):
                with self.assertRaises(ModelValidationError):
                    validate_revisioned_document(document)

    def test_canonical_json_is_stable_utf8(self) -> None:
        left = canonical_json_bytes({"name": "昱勝 Inc", "id": "yusheng-inc"})
        right = canonical_json_bytes({"id": "yusheng-inc", "name": "昱勝 Inc"})
        self.assertEqual(left, right)
        self.assertIn("昱勝 Inc".encode("utf-8"), left)


if __name__ == "__main__":
    unittest.main()
