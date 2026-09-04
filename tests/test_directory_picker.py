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

    def test_folder_dialog_starts_in_the_preferred_directory_when_available(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            preferred = Path(temporary_directory)

            script = self.picker_module()._folder_dialog_script(preferred)

            escaped = str(preferred.absolute()).replace("'", "''")
            self.assertIn(f"$dialog.SelectedPath = '{escaped}'", script)

    def test_folder_dialog_falls_back_when_the_preferred_directory_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            missing = Path(temporary_directory) / "missing"

            script = self.picker_module()._folder_dialog_script(missing)

            self.assertNotIn("$dialog.SelectedPath = '", script)

    def test_default_plugin_directory_is_plugins_dev(self) -> None:
        self.assertEqual(self.picker_module().DEFAULT_PLUGIN_DIRECTORY, Path(r"E:\plugins-dev"))

    def test_process_failure_does_not_expose_stderr(self) -> None:
        runner = lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 1, "", "private path")

        with self.assertRaisesRegex(RuntimeError, "无法打开插件目录选择器") as error:
            self.picker_module().choose_plugin_directory(runner=runner)
        self.assertNotIn("private path", str(error.exception))

    def test_returns_a_selected_plugin_archive(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            selected = Path(temporary_directory) / "sample-plugin.zip"
            selected.write_bytes(b"PK\x05\x06" + b"\0" * 18)
            runner = lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, f"{selected}\n", "")

            self.assertEqual(self.picker_module().choose_plugin_archive(runner=runner), selected)

    def test_archive_cancel_returns_none(self) -> None:
        runner = lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, "\n", "")

        self.assertIsNone(self.picker_module().choose_plugin_archive(runner=runner))

    def test_archive_picker_rejects_non_zip_without_exposing_stderr(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            selected = Path(temporary_directory) / "private.txt"
            selected.write_text("private", encoding="utf-8")
            runner = lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, f"{selected}\n", "secret stderr")

            with self.assertRaisesRegex(RuntimeError, "选择的插件 ZIP 无效") as error:
                self.picker_module().choose_plugin_archive(runner=runner)
            self.assertNotIn(str(selected), str(error.exception))
            self.assertNotIn("secret stderr", str(error.exception))


if __name__ == "__main__":
    unittest.main()
