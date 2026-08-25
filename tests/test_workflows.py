import tempfile
import unittest
from pathlib import Path

from plugin_portal.storage import PortalStore
from plugin_portal.workflows import WorkflowRepository, WorkflowValidationError, validate_workflow


PLUGIN_KEY = "company-dev/project-delivery-hub"


def workflow(steps: list[dict], **section_overrides: object) -> dict:
    section = {"id": "installation", "title": "首次安装并配置", "steps": steps, **section_overrides}
    return {
        "pluginKey": PLUGIN_KEY,
        "tabs": [{"id": "plugin-installation", "title": "插件安装", "sections": [section]}],
    }


def step(step_id: str, next_ids: list[str]) -> dict:
    return {
        "id": step_id,
        "label": step_id,
        "title": f"步骤 {step_id}",
        "description": "",
        "next": next_ids,
    }


class WorkflowValidationTests(unittest.TestCase):
    def test_accepts_serial_flow(self) -> None:
        document = workflow([step("prepare", ["unpack"]), step("unpack", ["verify"]), step("verify", [])])
        self.assertEqual(validate_workflow(document, expected_plugin_key=PLUGIN_KEY), document)

    def test_accepts_fork_and_merge(self) -> None:
        document = workflow(
            [
                step("prepare", ["codex", "claude"]),
                step("codex", ["finish"]),
                step("claude", ["finish"]),
                step("finish", []),
            ]
        )
        self.assertEqual(validate_workflow(document, expected_plugin_key=PLUGIN_KEY), document)

    def test_rejects_duplicate_unknown_cycle_and_unreachable_steps(self) -> None:
        invalid_steps = (
            [step("same", []), step("same", [])],
            [step("first", ["missing"])],
            [step("first", ["second"]), step("second", ["first"])],
            [step("first", []), step("orphan", [])],
        )
        for steps in invalid_steps:
            with self.subTest(steps=steps):
                with self.assertRaises(WorkflowValidationError):
                    validate_workflow(workflow(steps), expected_plugin_key=PLUGIN_KEY)

    def test_rejects_custom_presentation_or_wrong_plugin(self) -> None:
        invalid = workflow([step("only", [])], css=".card { display: none }")
        with self.assertRaises(WorkflowValidationError):
            validate_workflow(invalid, expected_plugin_key=PLUGIN_KEY)
        with self.assertRaises(WorkflowValidationError):
            validate_workflow(workflow([step("only", [])]), expected_plugin_key="company-dev/yusheng-inc")


class WorkflowRepositoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_directory.cleanup)
        self.repository = WorkflowRepository(PortalStore(Path(self.temp_directory.name)))

    def test_workflows_are_isolated_by_plugin(self) -> None:
        first = self.repository.save(PLUGIN_KEY, workflow([step("pdh", [])]), expected_revision=0)
        yusheng_key = "company-dev/yusheng-inc"
        yusheng = {"pluginKey": yusheng_key, "tabs": []}
        self.repository.save(yusheng_key, yusheng, expected_revision=first["revision"])

        self.assertEqual(self.repository.get(PLUGIN_KEY)["tabs"][0]["sections"][0]["steps"][0]["id"], "pdh")
        self.assertEqual(self.repository.get(yusheng_key)["tabs"], [])


if __name__ == "__main__":
    unittest.main()
