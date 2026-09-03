from __future__ import annotations

import json
import hashlib
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch


class StaticAuditor:
    def __init__(self, *, version: str = "1.2.3"):
        self.version = version

    def audit(self, path: Path, *, plugin_id: str, target: str, expected_sha256: str):
        from plugin_portal.download_publication import PluginReleaseAudit

        return PluginReleaseAudit(
            plugin_id=plugin_id,
            target=target,
            version=self.version,
            candidate_sha256=expected_sha256,
            file_set_sha256="b" * 64,
            file_count=3,
            archive_bytes=path.stat().st_size,
            tool_version="1.0.1",
            status="audited",
            warnings=(),
        )


class PluginReleaseAuditorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)
        self.codex_home = self.root / "codex-home"
        self.candidate = self.root / "sample-plugin.zip"
        self.candidate.write_bytes(b"candidate bytes")
        self.sha256 = "a" * 64
        self.release_root = self.codex_home / "plugins" / "cache" / "company-dev" / "plugin-release" / "1.0.1"
        (self.release_root / "scripts").mkdir(parents=True)
        (self.release_root / ".codex-plugin").mkdir()
        (self.release_root / ".codex-plugin" / "plugin.json").write_text(
            json.dumps({"name": "plugin-release", "version": "1.0.1"}),
            encoding="utf-8",
        )
        self.codex_script = self.root / "fake_codex.py"
        self.codex_script.write_text(
            "import json\nprint(json.dumps({\"installed\":[{\"pluginId\":\"plugin-release@company-dev\",\"name\":\"plugin-release\",\"marketplaceName\":\"company-dev\",\"version\":\"1.0.1\",\"installed\":True,\"enabled\":True}],\"available\":[]}))\n",
            encoding="utf-8",
        )

    def payload(self, *, status: str = "issues_found") -> dict:
        return {
            "schemaVersion": "1.0.0",
            "tool": "plugin-release",
            "toolVersion": "1.0.1",
            "operation": "diagnose",
            "status": status,
            "releaseKey": "company-dev/sample-plugin",
            "target": "company-dev",
            "pluginId": "sample-plugin",
            "candidate": {
                "path": str(self.candidate),
                "pluginId": "sample-plugin",
                "version": "1.2.3",
                "candidateSha256": self.sha256,
                "fileSetSha256": "b" * 64,
                "fileCount": 12,
                "archiveBytes": 15,
            },
            "checks": [
                {"name": "candidate", "status": "passed"},
                {"name": "marketplace-source", "status": "failed", "matchesCandidate": False},
                {"name": "installed-candidate-parity", "status": "not_run", "reason": "candidate-version-not-installed"},
                {"name": "native-readback", "status": "passed", "error": None},
            ],
            "installation": {"configured": True, "enabled": True},
            "suggestions": [],
            "writesPerformed": False,
        }

    def write_release(self, output: object, *, exit_code: int = 0, stderr: bool = False) -> None:
        encoded = json.dumps(output, ensure_ascii=False) if not isinstance(output, str) else output
        script = textwrap.dedent(
            f"""
            import argparse
            import sys

            parser = argparse.ArgumentParser()
            parser.add_argument("command")
            parser.add_argument("--candidate")
            parser.add_argument("--plugin-id")
            parser.add_argument("--target")
            parser.add_argument("--codex-home")
            parser.add_argument("--expected-candidate-sha256")
            args = parser.parse_args()
            assert args.command == "diagnose"
            assert args.plugin_id == "sample-plugin"
            assert args.target == "company-dev"
            assert args.expected_candidate_sha256 == "{self.sha256}"
            print({encoded!r}, file=sys.stderr if {stderr!r} else sys.stdout)
            raise SystemExit({exit_code})
            """
        ).strip()
        (self.release_root / "scripts" / "release.py").write_text(script + "\n", encoding="utf-8")

    def auditor(self):
        from plugin_portal.download_publication import PluginReleaseAuditor

        return PluginReleaseAuditor(
            codex_home=self.codex_home,
            codex_command=(sys.executable, str(self.codex_script)),
            python_executable=sys.executable,
        )

    def test_accepts_audited_candidate_and_maps_environment_mismatch_to_warning(self) -> None:
        self.write_release(self.payload())

        audit = self.auditor().audit(
            self.candidate,
            plugin_id="sample-plugin",
            target="company-dev",
            expected_sha256=self.sha256,
        )

        self.assertEqual(audit.plugin_id, "sample-plugin")
        self.assertEqual(audit.version, "1.2.3")
        self.assertEqual(audit.candidate_sha256, self.sha256)
        self.assertEqual(audit.file_set_sha256, "b" * 64)
        self.assertEqual(audit.archive_bytes, 15)
        self.assertEqual(audit.tool_version, "1.0.1")
        self.assertEqual(audit.status, "issues_found")
        self.assertEqual(audit.warnings, ("市场源码与候选不一致",))
        self.assertNotIn(str(self.candidate), repr(audit))

    def test_rejects_nonzero_diagnose_without_leaking_details(self) -> None:
        self.write_release(
            {
                "schemaVersion": "1.0.0",
                "tool": "plugin-release",
                "status": "failed",
                "error": {
                    "code": "private_material_detected",
                    "message": "候选包含私有资料",
                    "details": {"path": str(self.candidate)},
                },
            },
            exit_code=2,
            stderr=True,
        )

        from plugin_portal.download_publication import DownloadPublicationError

        with self.assertRaises(DownloadPublicationError) as caught:
            self.auditor().audit(
                self.candidate,
                plugin_id="sample-plugin",
                target="company-dev",
                expected_sha256=self.sha256,
            )

        self.assertEqual(caught.exception.code, "candidate_rejected")
        self.assertEqual(str(caught.exception), "候选包含私有资料")
        self.assertNotIn(str(self.candidate), str(caught.exception))

    def test_maps_unknown_error_and_check_details_without_exposing_paths(self) -> None:
        payload = self.payload()
        payload["checks"] = [
            *payload["checks"],
            {"name": r"C:\private\internal-check", "status": "failed"},
        ]
        self.write_release(payload)

        audit = self.auditor().audit(
            self.candidate,
            plugin_id="sample-plugin",
            target="company-dev",
            expected_sha256=self.sha256,
        )

        self.assertIn("Plugin Release 还有其他检查未通过", audit.warnings)
        self.assertNotIn(r"C:\private", repr(audit.warnings))

        self.write_release(
            {
                "error": {
                    "code": "unexpected_failure",
                    "message": r"读取 C:\private\audit.json 失败",
                },
            },
            exit_code=2,
            stderr=True,
        )
        from plugin_portal.download_publication import DownloadPublicationError

        with self.assertRaises(DownloadPublicationError) as caught:
            self.auditor().audit(
                self.candidate,
                plugin_id="sample-plugin",
                target="company-dev",
                expected_sha256=self.sha256,
            )
        self.assertEqual(str(caught.exception), "Plugin Release 拒绝候选 ZIP")
        self.assertNotIn(r"C:\private", str(caught.exception))

    def test_rejects_malformed_or_mismatched_success_contracts(self) -> None:
        cases: list[tuple[str, object]] = [
            ("not-json", "not-json"),
            ("wrong-schema", {**self.payload(), "schemaVersion": "2.0.0"}),
            ("wrong-tool", {**self.payload(), "tool": "another-tool"}),
            ("wrong-operation", {**self.payload(), "operation": "update"}),
            (
                "wrong-digest",
                {**self.payload(), "candidate": {**self.payload()["candidate"], "candidateSha256": "c" * 64}},
            ),
            (
                "candidate-failed",
                {**self.payload(), "checks": [{"name": "candidate", "status": "failed"}]},
            ),
        ]
        from plugin_portal.download_publication import DownloadPublicationError

        for name, payload in cases:
            with self.subTest(name=name):
                self.write_release(payload)
                with self.assertRaises(DownloadPublicationError) as caught:
                    self.auditor().audit(
                        self.candidate,
                        plugin_id="sample-plugin",
                        target="company-dev",
                        expected_sha256=self.sha256,
                    )
                self.assertEqual(caught.exception.code, "audit_contract_invalid")

    def test_requires_an_enabled_installed_plugin_release(self) -> None:
        self.codex_script.write_text(
            "import json\nprint(json.dumps({\"installed\":[],\"available\":[]}))\n",
            encoding="utf-8",
        )
        self.write_release(self.payload())

        from plugin_portal.download_publication import DownloadPublicationError

        with self.assertRaises(DownloadPublicationError) as caught:
            self.auditor().audit(
                self.candidate,
                plugin_id="sample-plugin",
                target="company-dev",
                expected_sha256=self.sha256,
            )

        self.assertEqual(caught.exception.code, "plugin_release_unavailable")


class DownloadPublisherTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)
        self.download_root = self.root / "downloads"
        self.receipt_root = self.root / "data" / "download-publications"
        self.download_root.mkdir()
        self.candidate_path = self.root / "sample-plugin.zip"
        self.candidate_bytes = b"PK\x05\x06" + b"\0" * 18 + b"candidate"
        self.candidate_path.write_bytes(self.candidate_bytes)

    def publisher(self, *, auditor=None, reader=None):
        from plugin_portal.download_publication import DownloadPublisher

        def readback(file_name: str) -> tuple[int, str]:
            payload = (self.download_root / file_name).read_bytes()
            return len(payload), hashlib.sha256(payload).hexdigest()

        return DownloadPublisher(
            download_root=self.download_root,
            receipt_root=self.receipt_root,
            auditor=auditor or StaticAuditor(),
            download_reader=reader or readback,
        )

    def test_previews_only_the_active_identity_without_leaking_source_path(self) -> None:
        candidate = self.publisher().preview(
            self.candidate_path,
            plugin_key="company-dev/sample-plugin",
            expected_version="1.2.3",
        )

        preview = candidate.public_preview()
        self.assertEqual(preview["pluginKey"], "company-dev/sample-plugin")
        self.assertEqual(preview["fileName"], "sample-plugin.zip")
        self.assertEqual(preview["destinationFileName"], "sample-plugin-1.2.3-company-dev.zip")
        self.assertEqual(preview["candidateSha256"], hashlib.sha256(self.candidate_bytes).hexdigest())
        self.assertEqual(preview["fileSetSha256"], "b" * 64)
        self.assertEqual(preview["archiveBytes"], len(self.candidate_bytes))
        self.assertNotIn(str(self.candidate_path), json.dumps(preview, ensure_ascii=False))

    def test_rejects_candidate_version_mismatch_and_archive_over_128_mib(self) -> None:
        from plugin_portal.download_publication import DownloadPublicationError

        with self.assertRaises(DownloadPublicationError) as mismatch:
            self.publisher(auditor=StaticAuditor(version="1.2.4")).preview(
                self.candidate_path,
                plugin_key="company-dev/sample-plugin",
                expected_version="1.2.3",
            )
        self.assertEqual(mismatch.exception.code, "candidate_identity_mismatch")

        large = self.root / "large.zip"
        with large.open("wb") as stream:
            stream.truncate(128 * 1024 * 1024 + 1)
        with self.assertRaises(DownloadPublicationError) as oversized:
            self.publisher().preview(
                large,
                plugin_key="company-dev/sample-plugin",
                expected_version="1.2.3",
            )
        self.assertEqual(oversized.exception.code, "candidate_too_large")

    def test_publishes_an_immutable_file_and_path_free_receipt(self) -> None:
        publisher = self.publisher()
        candidate = publisher.preview(
            self.candidate_path,
            plugin_key="company-dev/sample-plugin",
            expected_version="1.2.3",
        )

        receipt = publisher.publish(candidate)

        destination = self.download_root / "sample-plugin-1.2.3-company-dev.zip"
        self.assertEqual(destination.read_bytes(), self.candidate_bytes)
        self.assertEqual(receipt.file_name, destination.name)
        receipt_files = list(self.receipt_root.glob("*.json"))
        self.assertEqual(len(receipt_files), 1)
        receipt_text = receipt_files[0].read_text(encoding="utf-8")
        self.assertNotIn(str(self.candidate_path), receipt_text)
        self.assertNotIn(str(self.download_root), receipt_text)
        self.assertEqual(list(self.download_root.glob("*.partial")), [])

    def test_refuses_to_replace_an_existing_public_version(self) -> None:
        destination = self.download_root / "sample-plugin-1.2.3-company-dev.zip"
        destination.write_bytes(b"existing")
        publisher = self.publisher()
        candidate = publisher.preview(
            self.candidate_path,
            plugin_key="company-dev/sample-plugin",
            expected_version="1.2.3",
        )

        from plugin_portal.download_publication import DownloadPublicationError

        with self.assertRaises(DownloadPublicationError) as caught:
            publisher.publish(candidate)
        self.assertEqual(caught.exception.code, "destination_exists")
        self.assertEqual(destination.read_bytes(), b"existing")

    def test_rejects_a_source_changed_after_preview_without_activating_it(self) -> None:
        publisher = self.publisher()
        candidate = publisher.preview(
            self.candidate_path,
            plugin_key="company-dev/sample-plugin",
            expected_version="1.2.3",
        )
        self.candidate_path.write_bytes(b"changed after preview")

        from plugin_portal.download_publication import DownloadPublicationError

        with self.assertRaises(DownloadPublicationError) as caught:
            publisher.publish(candidate)
        self.assertEqual(caught.exception.code, "candidate_changed")
        self.assertFalse((self.download_root / "sample-plugin-1.2.3-company-dev.zip").exists())
        self.assertEqual(list(self.download_root.glob("*.partial")), [])

    def test_quarantines_only_the_new_file_when_9134_readback_mismatches(self) -> None:
        readback_calls: list[str] = []

        def mismatched_readback(file_name: str) -> tuple[int, str]:
            readback_calls.append(file_name)
            payload = (self.download_root / file_name).read_bytes()
            return len(payload), "0" * 64

        publisher = self.publisher(reader=mismatched_readback)
        candidate = publisher.preview(
            self.candidate_path,
            plugin_key="company-dev/sample-plugin",
            expected_version="1.2.3",
        )

        from plugin_portal.download_publication import DownloadPublicationError

        with self.assertRaises(DownloadPublicationError) as caught:
            publisher.publish(candidate)
        self.assertEqual(caught.exception.code, "download_readback_failed")
        self.assertFalse((self.download_root / "sample-plugin-1.2.3-company-dev.zip").exists())
        quarantined = list(self.download_root.glob("*.quarantine"))
        self.assertEqual(len(quarantined), 1)
        self.assertEqual(quarantined[0].read_bytes(), self.candidate_bytes)
        self.assertEqual(list(self.download_root.glob("*.partial")), [])
        self.assertEqual(readback_calls, [candidate.destination_file_name, candidate.destination_file_name])

    def test_removes_partial_receipt_and_quarantines_when_receipt_sync_fails(self) -> None:
        publisher = self.publisher()
        candidate = publisher.preview(
            self.candidate_path,
            plugin_key="company-dev/sample-plugin",
            expected_version="1.2.3",
        )
        real_fsync = __import__("os").fsync
        calls = 0

        def fail_receipt_sync(descriptor: int) -> None:
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("receipt sync failed")
            real_fsync(descriptor)

        from plugin_portal.download_publication import DownloadPublicationError

        with patch("plugin_portal.download_publication.os.fsync", side_effect=fail_receipt_sync):
            with self.assertRaises(DownloadPublicationError) as caught:
                publisher.publish(candidate)

        self.assertEqual(caught.exception.code, "publication_receipt_failed")
        self.assertFalse((self.download_root / candidate.destination_file_name).exists())
        self.assertEqual(len(list(self.download_root.glob("*.quarantine"))), 1)
        self.assertEqual(list(self.receipt_root.glob("*.json")), [])


if __name__ == "__main__":
    unittest.main()
