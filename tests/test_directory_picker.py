from __future__ import annotations

import importlib
import subprocess
import tempfile
import unittest
from pathlib import Path


class DirectoryPickerTests(unittest.TestCase):
    def picker_module(self):
        try:
            return importlib.import_module("plugin_portal.directory_picker")
        except ModuleNotFoundError:
            self.fail("directory picker module is missing")

    def test_returns_a_selected_local_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            selected = Path(temporary_directory)
            runner = lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, f"{selected}\n", "")

            self.assertEqual(self.picker_module().choose_plugin_directory(runner=runner), selected)

    def test_cancel_returns_none(self) -> None:
        runner = lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, "\n", "")

        self.assertIsNone(self.picker_module().choose_plugin_directory(runner=runner))

    def test_process_failure_does_not_expose_stderr(self) -> None:
        runner = lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 1, "", "private path")

        with self.assertRaisesRegex(RuntimeError, "无法打开插件目录选择器") as error:
            self.picker_module().choose_plugin_directory(runner=runner)
        self.assertNotIn("private path", str(error.exception))


if __name__ == "__main__":
    unittest.main()
