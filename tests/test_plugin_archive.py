import stat
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path
from unittest.mock import patch

from plugin_portal.plugin_archive import (
    MAX_ARCHIVE_ENTRIES,
    MAX_ENTRY_BYTES,
    PluginArchiveError,
    extract_plugin_archive,
)


def write_zip(path: Path, entries: dict[str, bytes], *, compression: int = zipfile.ZIP_DEFLATED) -> None:
    with zipfile.ZipFile(path, "w", compression) as archive:
        for name, payload in entries.items():
            archive.writestr(name, payload)


def set_encrypted_flag(path: Path) -> None:
    payload = bytearray(path.read_bytes())
    local = payload.index(b"PK\x03\x04")
    central = payload.index(b"PK\x01\x02")
    payload[local + 6:local + 8] = (1).to_bytes(2, "little")
    payload[central + 8:central + 10] = (1).to_bytes(2, "little")
    path.write_bytes(payload)


def write_zip_with_raw_name(path: Path, name: str) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("sample/.codex-plugin/plugin.json", b"{}")
        info = zipfile.ZipInfo("placeholder")
        info.filename = name
        info.orig_filename = name
        archive.writestr(info, b"unsafe")


class PluginArchiveTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.archive = self.root / "plugin.zip"
        self.destination = self.root / "extracted"
        self.sibling = self.root / "keep.txt"
        self.sibling.write_text("keep", encoding="utf-8")

    def assert_rejected(self, code: str = "archive_unsafe") -> PluginArchiveError:
        with self.assertRaises(PluginArchiveError) as rejected:
            extract_plugin_archive(self.archive, self.destination)
        self.assertEqual(rejected.exception.code, code)
        self.assertFalse(self.destination.exists())
        self.assertEqual(self.sibling.read_text(encoding="utf-8"), "keep")
        return rejected.exception

    def test_accepts_root_or_single_wrapper_and_finds_one_plugin_root(self):
        entries = {
            ".codex-plugin/plugin.json": b'{"name":"sample"}',
            "skills/example/SKILL.md": b"---\nname: example\ndescription: x\n---\n# Example\n",
        }
        write_zip(self.archive, entries)
        root = extract_plugin_archive(self.archive, self.destination)
        self.assertEqual(root, self.destination)
        self.assertEqual((root / ".codex-plugin/plugin.json").read_bytes(), entries[".codex-plugin/plugin.json"])

        second_archive = self.root / "wrapped.zip"
        second_destination = self.root / "wrapped"
        write_zip(second_archive, {f"sample/{name}": payload for name, payload in entries.items()})
        wrapped_root = extract_plugin_archive(second_archive, second_destination)
        self.assertEqual(wrapped_root, second_destination / "sample")

    def test_rejects_traversal_absolute_backslash_drive_and_dot_segments(self):
        for name in (
            "../escape.txt",
            "/absolute.txt",
            "//server/share.txt",
            "C:/drive.txt",
            "sample\\escape.txt",
            "sample//empty.txt",
            "sample/./dot.txt",
            "sample/../escape.txt",
        ):
            with self.subTest(name=name):
                if "\\" in name:
                    write_zip_with_raw_name(self.archive, name)
                else:
                    write_zip(self.archive, {
                        "sample/.codex-plugin/plugin.json": b"{}",
                        name: b"unsafe",
                    })
                self.assert_rejected()

    def test_rejects_duplicate_and_case_folded_collisions(self):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(self.archive, "w", zipfile.ZIP_STORED) as archive:
                archive.writestr("sample/.codex-plugin/plugin.json", b"{}")
                archive.writestr("sample/duplicate.txt", b"one")
                archive.writestr("sample/duplicate.txt", b"two")
        self.assert_rejected()

        write_zip(self.archive, {
            "sample/.codex-plugin/plugin.json": b"{}",
            "sample/Readme.md": b"one",
            "sample/README.md": b"two",
        })
        self.assert_rejected()

    def test_rejects_encrypted_symlink_and_unsupported_compression_entries(self):
        write_zip(self.archive, {"sample/.codex-plugin/plugin.json": b"{}"})
        set_encrypted_flag(self.archive)
        self.assert_rejected()

        link = zipfile.ZipInfo("sample/link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(self.archive, "w", zipfile.ZIP_STORED) as archive:
            archive.writestr("sample/.codex-plugin/plugin.json", b"{}")
            archive.writestr(link, b"../../escape")
        self.assert_rejected()

        write_zip(
            self.archive,
            {"sample/.codex-plugin/plugin.json": b"{}"},
            compression=zipfile.ZIP_BZIP2,
        )
        self.assert_rejected()

    def test_rejects_entry_count_file_total_and_compression_ratio_limits(self):
        with zipfile.ZipFile(self.archive, "w", zipfile.ZIP_STORED) as archive:
            archive.writestr(".codex-plugin/plugin.json", b"{}")
            for index in range(MAX_ARCHIVE_ENTRIES):
                archive.writestr(f"entries/{index}.txt", b"")
        self.assert_rejected()

        write_zip(self.archive, {
            ".codex-plugin/plugin.json": b"{}",
            "large.bin": b"x" * (MAX_ENTRY_BYTES + 1),
        }, compression=zipfile.ZIP_STORED)
        self.assert_rejected()

        write_zip(self.archive, {
            ".codex-plugin/plugin.json": b"{}",
            "one.bin": b"1234",
            "two.bin": b"5678",
        }, compression=zipfile.ZIP_STORED)
        with patch("plugin_portal.plugin_archive.MAX_TOTAL_BYTES", 7):
            self.assert_rejected()

        write_zip(self.archive, {
            ".codex-plugin/plugin.json": b"{}",
            "compressible.bin": b"0" * (1024 * 1024),
        })
        self.assert_rejected()

    def test_rejects_corrupt_archive_and_zero_or_two_plugin_roots(self):
        self.archive.write_bytes(b"not a zip")
        self.assert_rejected("archive_invalid")

        write_zip(self.archive, {"README.md": b"missing"})
        self.assert_rejected("archive_invalid")

        write_zip(self.archive, {
            "one/.codex-plugin/plugin.json": b"{}",
            "two/.codex-plugin/plugin.json": b"{}",
        })
        self.assert_rejected("archive_invalid")

    def test_rejects_nested_wrapper_and_files_outside_the_single_wrapper(self):
        write_zip(self.archive, {"outer/inner/.codex-plugin/plugin.json": b"{}"})
        self.assert_rejected("archive_invalid")

        write_zip(self.archive, {
            "sample/.codex-plugin/plugin.json": b"{}",
            "outside.txt": b"extra",
        })
        self.assert_rejected("archive_invalid")


if __name__ == "__main__":
    unittest.main()
