import tempfile
import unittest
from pathlib import Path

from plugin_portal.prompts import PromptRepository, PromptValidationError, validate_prompts
from plugin_portal.storage import PortalStore, RevisionConflict


class PromptValidationTests(unittest.TestCase):
    def test_accepts_closed_prompt_document(self) -> None:
        document = {
            "pluginKey": "company-dev/project-delivery-hub",
            "items": [
                {
                    "id": "check-design",
                    "scenario": "检查接口设计",
                    "content": "检查字段、回应码和资料来源。",
                    "createdAt": "2026-08-26T00:00:00Z",
                }
            ],
        }
        self.assertEqual(validate_prompts(document, expected_plugin_key=document["pluginKey"]), document)

    def test_rejects_duplicate_ids_unknown_fields_and_wrong_plugin(self) -> None:
        invalid_documents = (
            {
                "pluginKey": "company-dev/project-delivery-hub",
                "items": [
                    {"id": "same", "scenario": "一", "content": "一", "createdAt": "2026-08-26T00:00:00Z"},
                    {"id": "same", "scenario": "二", "content": "二", "createdAt": "2026-08-26T00:00:00Z"},
                ],
            },
            {
                "pluginKey": "company-dev/project-delivery-hub",
                "items": [{"id": "one", "scenario": "一", "content": "一", "createdAt": "2026-08-26T00:00:00Z", "shared": True}],
            },
            {"pluginKey": "company-dev/yusheng-inc", "items": []},
        )
        for document in invalid_documents:
            with self.subTest(document=document):
                with self.assertRaises(PromptValidationError):
                    validate_prompts(document, expected_plugin_key="company-dev/project-delivery-hub")


class PromptRepositoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_directory.cleanup)
        self.repository = PromptRepository(PortalStore(Path(self.temp_directory.name)))

    def test_plugins_have_isolated_prompt_lists(self) -> None:
        first = self.repository.save(
            "company-dev/project-delivery-hub",
            [{"id": "pdh", "scenario": "研发", "content": "研发内容", "createdAt": "2026-08-26T00:00:00Z"}],
            expected_revision=0,
        )
        second = self.repository.save(
            "company-dev/yusheng-inc",
            [{"id": "ys", "scenario": "昱勝", "content": "昱勝内容", "createdAt": "2026-08-26T00:00:00Z"}],
            expected_revision=first["revision"],
        )

        self.assertEqual(self.repository.get("company-dev/project-delivery-hub")["items"][0]["id"], "pdh")
        self.assertEqual(self.repository.get("company-dev/yusheng-inc")["items"][0]["id"], "ys")
        self.assertEqual(second["revision"], 2)

    def test_stale_prompt_save_is_rejected(self) -> None:
        self.repository.save("company-dev/project-delivery-hub", [], expected_revision=0)
        with self.assertRaises(RevisionConflict):
            self.repository.save("company-dev/project-delivery-hub", [], expected_revision=0)


if __name__ == "__main__":
    unittest.main()
