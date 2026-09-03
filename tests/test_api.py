import json
import io
import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path

from plugin_portal.api import ApiError, PortalApi
from plugin_portal.download_publication import DownloadPublicationError
from plugin_portal.storage import PortalStore
from plugin_portal.uploads import UploadError, UploadRegistry


class StubPublicationCandidate:
    def __init__(self, plugin_key: str, source_path: Path | None = None):
        self.plugin_key = plugin_key
        self.source_path = source_path

    def public_preview(self) -> dict:
        return {
            "pluginKey": self.plugin_key,
            "version": "1.2.3",
            "fileName": "sample-plugin.zip",
            "destinationFileName": "sample-plugin-1.2.3-company-dev.zip",
            "candidateSha256": "a" * 64,
            "fileSetSha256": "b" * 64,
            "fileCount": 3,
            "archiveBytes": 25,
            "auditToolVersion": "1.0.1",
            "warnings": [],
        }


class StubPublicationReceipt:
    def public_result(self) -> dict:
        return {
            "pluginKey": "company-dev/sample-plugin",
            "version": "1.2.3",
            "fileName": "sample-plugin-1.2.3-company-dev.zip",
            "candidateSha256": "a" * 64,
            "archiveBytes": 25,
            "publishedAtUtc": "2026-08-30T00:00:00Z",
        }


class RecordingDownloadPublisher:
    def __init__(self):
        self.previews: list[tuple[Path, str, str]] = []
        self.published: list[StubPublicationCandidate] = []

    def preview(self, path: Path, *, plugin_key: str, expected_version: str):
        self.previews.append((path, plugin_key, expected_version))
        return StubPublicationCandidate(plugin_key, path)

    def publish(self, candidate: StubPublicationCandidate):
        self.published.append(candidate)
        return StubPublicationReceipt()


class RetryableDownloadPublisher(RecordingDownloadPublisher):
    def __init__(self):
        super().__init__()
        self.fail_next_publish = True

    def publish(self, candidate: StubPublicationCandidate):
        if self.fail_next_publish:
            self.fail_next_publish = False
            raise DownloadPublicationError("publication_failed", "暂时无法发布下载文件")
        return super().publish(candidate)


class RejectingDownloadPublisher(RecordingDownloadPublisher):
    def __init__(self, code: str = "candidate_rejected"):
        super().__init__()
        self.code = code

    def preview(self, path: Path, *, plugin_key: str, expected_version: str):
        self.previews.append((path, plugin_key, expected_version))
        message = "Plugin Release 未安装或未启用" if self.code == "plugin_release_unavailable" else "候选未通过审计"
        raise DownloadPublicationError(self.code, message)


class PortalApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_directory.cleanup)
        self.root = Path(self.temp_directory.name)
        fixture = Path(__file__).parent / "fixtures" / "plugins" / "minimal"
        self.plugin_root = self.root / "source" / "sample-plugin"
        shutil.copytree(fixture, self.plugin_root)
        self.store = PortalStore(self.root / "data")
        self.api = PortalApi(self.store)
        self.token = self.api.create_session()["token"]

    def preview(self) -> dict:
        return self.api.preview_import(
            self.token,
            {
                "source": {"kind": "server-directory", "path": str(self.plugin_root)},
                "target": "company-dev",
                "expectedPluginId": "sample-plugin",
                "approvedRulePaths": ["rules/public.md"],
                "extensionTools": [],
            },
        )

    def set_icon(self, payload: bytes, *, name: str = "logo.png") -> None:
        assets = self.plugin_root / "assets"
        assets.mkdir(exist_ok=True)
        (assets / name).write_bytes(payload)
        manifest_path = self.plugin_root / ".codex-plugin" / "plugin.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["interface"]["logo"] = f"./assets/{name}"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")

    def plugin_zip(self) -> Path:
        archive_path = self.root / "sample-plugin.zip"
        with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(self.plugin_root.rglob("*")):
                if path.is_file():
                    archive.write(path, f"sample-plugin/{path.relative_to(self.plugin_root).as_posix()}")
        return archive_path

    def test_preview_does_not_change_persisted_catalog_or_leak_source_path(self) -> None:
        preview = self.preview()

        self.assertEqual(self.store.read_document("catalog"), {"revision": 0, "data": {}})
        self.assertEqual(preview["pluginKey"], "company-dev/sample-plugin")
        self.assertIn("candidateId", preview)
        self.assertNotIn(str(self.plugin_root), json.dumps(preview, ensure_ascii=False))

    def test_promote_switches_active_snapshot_and_returns_new_revision(self) -> None:
        preview = self.preview()

        promoted = self.api.promote(
            self.token,
            "company-dev/sample-plugin",
            {"candidateId": preview["candidateId"], "expectedRevision": 0},
        )

        self.assertEqual(promoted["revision"], 1)
        plugins = self.api.list_plugins()
        self.assertEqual(plugins["revision"], 1)
        self.assertEqual(plugins["items"][0]["pluginKey"], "company-dev/sample-plugin")
        self.assertEqual(plugins["items"][0]["version"], "1.2.3")
        snapshot = self.api.get_snapshot("company-dev/sample-plugin")
        self.assertEqual(snapshot["plugin"]["id"], "sample-plugin")

    def test_download_info_uses_the_active_public_identity_and_fails_closed(self) -> None:
        probed: list[str] = []
        api = PortalApi(
            self.store,
            download_probe=lambda url: probed.append(url) is None,
        )
        token = api.create_session()["token"]
        preview = api.preview_import(
            token,
            {
                "source": {"kind": "server-directory", "path": str(self.plugin_root)},
                "target": "company-dev",
                "expectedPluginId": "sample-plugin",
                "approvedRulePaths": ["rules/public.md"],
                "extensionTools": [],
            },
        )
        api.promote(
            token,
            "company-dev/sample-plugin",
            {"candidateId": preview["candidateId"], "expectedRevision": 0},
        )

        self.assertEqual(
            api.get_download_info("company-dev/sample-plugin"),
            {
                "available": True,
                "version": "1.2.3",
                "href": "http://127.0.0.1:9134/downloads/sample-plugin-1.2.3-company-dev.zip",
            },
        )
        self.assertEqual(
            probed,
            ["http://127.0.0.1:9134/downloads/sample-plugin-1.2.3-company-dev.zip"],
        )

        unavailable = PortalApi(self.store, download_probe=lambda _url: False)
        self.assertEqual(
            unavailable.get_download_info("company-dev/sample-plugin"),
            {"available": False, "version": "1.2.3", "href": None},
        )

    def test_plugin_icon_uses_a_generic_image_when_the_plugin_has_no_public_logo(self) -> None:
        preview = self.preview()
        self.api.promote(
            self.token,
            "company-dev/sample-plugin",
            {"candidateId": preview["candidateId"], "expectedRevision": 0},
        )

        content_type, payload = self.api.get_plugin_icon("company-dev/sample-plugin")

        self.assertEqual(content_type, "image/svg+xml")
        self.assertIn(b"<svg", payload)

    def test_promoted_source_icon_is_frozen_without_an_installed_cache(self) -> None:
        icon = b"\x89PNG\r\n\x1a\nsource-icon"
        self.set_icon(icon)
        preview = self.preview()
        self.assertNotIn("icon", preview)
        shutil.rmtree(self.plugin_root)
        self.api.plugin_cache_root = self.root / "missing-cache"

        self.api.promote(
            self.token,
            "company-dev/sample-plugin",
            {"candidateId": preview["candidateId"], "expectedRevision": 0},
        )

        self.assertEqual(
            self.api.get_plugin_icon("company-dev/sample-plugin"),
            ("image/png", icon),
        )

    def test_rollback_selects_the_icon_bound_to_the_previous_snapshot(self) -> None:
        first_icon = b"\x89PNG\r\n\x1a\nfirst"
        second_icon = b"\x89PNG\r\n\x1a\nsecond"
        self.set_icon(first_icon)
        first = self.preview()
        self.api.promote(
            self.token,
            "company-dev/sample-plugin",
            {"candidateId": first["candidateId"], "expectedRevision": 0},
        )
        manifest_path = self.plugin_root / ".codex-plugin" / "plugin.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["version"] = "1.2.4"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        self.set_icon(second_icon)
        second = self.preview()
        self.api.promote(
            self.token,
            "company-dev/sample-plugin",
            {"candidateId": second["candidateId"], "expectedRevision": 1},
        )
        self.assertEqual(self.api.get_plugin_icon("company-dev/sample-plugin"), ("image/png", second_icon))

        self.api.rollback(
            self.token,
            "company-dev/sample-plugin",
            {"expectedRevision": 2},
        )

        self.assertEqual(self.api.get_plugin_icon("company-dev/sample-plugin"), ("image/png", first_icon))

    def test_declared_unsafe_icon_fails_preview_instead_of_becoming_generic(self) -> None:
        manifest_path = self.plugin_root / ".codex-plugin" / "plugin.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["interface"]["logo"] = "../outside.png"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")

        with self.assertRaises(ApiError) as unsafe:
            self.preview()

        self.assertEqual(unsafe.exception.code, "plugin_preview_failed")

    def test_remote_upload_preview_retries_projection_and_consumes_on_success(self) -> None:
        upload_root = self.root / "uploads"
        registry = UploadRegistry(root=upload_root)
        remote = PortalApi(self.store, access_mode="remote-management", upload_registry=registry)
        self.addCleanup(remote.close)
        token = remote.create_session()["token"]
        archive = self.plugin_zip()
        with archive.open("rb") as source:
            uploaded = remote.stage_upload(
                token, "plugin-import", archive.name, source, archive.stat().st_size,
            )
        self.assertEqual(set(uploaded), {"uploadId", "fileName", "archiveBytes"})
        self.assertNotIn(str(upload_root), json.dumps(uploaded, ensure_ascii=False))
        source_payload = {"kind": "upload", "uploadId": uploaded["uploadId"]}

        with self.assertRaises(ApiError) as invalid_projection:
            remote.preview_import(token, {
                "source": source_payload,
                "target": "company-dev",
                "expectedPluginId": "sample-plugin",
                "approvedRulePaths": ["rules/missing.md"],
                "extensionTools": [],
            })
        self.assertEqual(invalid_projection.exception.code, "plugin_preview_failed")
        self.assertTrue(registry.require(token, "plugin-import", uploaded["uploadId"]).path.exists())

        preview = remote.preview_import(token, {
            "source": source_payload,
            "target": "company-dev",
            "expectedPluginId": "sample-plugin",
            "approvedRulePaths": ["rules/public.md"],
            "extensionTools": [],
        })

        public_preview = json.dumps(preview, ensure_ascii=False)
        self.assertNotIn(str(upload_root), public_preview)
        self.assertNotIn(uploaded["uploadId"], public_preview)
        self.assertNotIn('"source"', public_preview)
        with self.assertRaises(UploadError):
            registry.require(token, "plugin-import", uploaded["uploadId"])
        self.assertEqual(list(upload_root.glob("*-extracted")), [])

    def test_upload_source_is_session_scoped_and_mode_restricted(self) -> None:
        registry = UploadRegistry(root=self.root / "uploads")
        remote = PortalApi(self.store, access_mode="remote-management", upload_registry=registry)
        self.addCleanup(remote.close)
        owner = remote.create_session()["token"]
        other = remote.create_session()["token"]
        archive = self.plugin_zip()
        with archive.open("rb") as source:
            uploaded = remote.stage_upload(owner, "plugin-import", archive.name, source, archive.stat().st_size)

        with self.assertRaises(ApiError) as cross_session:
            remote.preview_import(other, {
                "source": {"kind": "upload", "uploadId": uploaded["uploadId"]},
                "target": "company-dev", "expectedPluginId": "sample-plugin",
                "approvedRulePaths": ["rules/public.md"], "extensionTools": [],
            })
        self.assertEqual(cross_session.exception.code, "upload_not_found")
        with self.assertRaises(ApiError) as remote_directory:
            remote.preview_import(owner, {
                "source": {"kind": "server-directory", "path": str(self.plugin_root)},
                "target": "company-dev", "expectedPluginId": "sample-plugin",
                "approvedRulePaths": ["rules/public.md"], "extensionTools": [],
            })
        self.assertEqual(remote_directory.exception.code, "source_mode_invalid")
        with self.assertRaises(ApiError) as local_upload:
            self.api.preview_import(self.token, {
                "source": {"kind": "upload", "uploadId": uploaded["uploadId"]},
                "target": "company-dev", "expectedPluginId": "sample-plugin",
                "approvedRulePaths": ["rules/public.md"], "extensionTools": [],
            })
        self.assertEqual(local_upload.exception.code, "source_mode_invalid")

    def test_invalid_session_is_rejected_before_upload_body_is_read(self) -> None:
        registry = UploadRegistry(root=self.root / "uploads")
        remote = PortalApi(self.store, access_mode="remote-management", upload_registry=registry)
        self.addCleanup(remote.close)

        class Unreadable:
            def read(self, _size):
                raise AssertionError("body was read")

        with self.assertRaises(ApiError) as invalid_session:
            remote.stage_upload("invalid", "plugin-import", "plugin.zip", Unreadable(), 10)
        self.assertEqual(invalid_session.exception.code, "invalid_session")

    def test_refresh_and_rollback_are_revision_guarded(self) -> None:
        first = self.preview()
        self.api.promote(
            self.token,
            "company-dev/sample-plugin",
            {"candidateId": first["candidateId"], "expectedRevision": 0},
        )
        manifest_path = self.plugin_root / ".codex-plugin" / "plugin.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["version"] = "1.2.4"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        second = self.preview()
        self.api.promote(
            self.token,
            "company-dev/sample-plugin",
            {"candidateId": second["candidateId"], "expectedRevision": 1},
        )

        with self.assertRaisesRegex(ApiError, "资料已更新"):
            self.api.rollback(
                self.token,
                "company-dev/sample-plugin",
                {"expectedRevision": 1},
            )

        rolled_back = self.api.rollback(
            self.token,
            "company-dev/sample-plugin",
            {"expectedRevision": 2},
        )
        self.assertEqual(rolled_back["revision"], 3)
        self.assertEqual(self.api.get_snapshot("company-dev/sample-plugin")["plugin"]["version"], "1.2.3")

    def test_promote_uses_frozen_candidate_after_source_disappears(self) -> None:
        preview = self.preview()
        shutil.rmtree(self.plugin_root)

        promoted = self.api.promote(
            self.token,
            "company-dev/sample-plugin",
            {"candidateId": preview["candidateId"], "expectedRevision": 0},
        )

        self.assertEqual(promoted["revision"], 1)

    def test_rejects_wrong_session_candidate_or_plugin_identity(self) -> None:
        preview = self.preview()
        another_token = self.api.create_session()["token"]

        with self.assertRaisesRegex(ApiError, "候选不存在"):
            self.api.promote(
                another_token,
                "company-dev/sample-plugin",
                {"candidateId": preview["candidateId"], "expectedRevision": 0},
            )
        with self.assertRaisesRegex(ApiError, "插件身份不一致"):
            self.api.promote(
                self.token,
                "company-dev/another-plugin",
                {"candidateId": preview["candidateId"], "expectedRevision": 0},
            )

    def test_errors_do_not_echo_plugin_source_path(self) -> None:
        missing = self.root / "private" / "missing-plugin"

        with self.assertRaises(ApiError) as caught:
            self.api.preview_import(
                self.token,
                {
                    "source": {"kind": "server-directory", "path": str(missing)},
                    "target": "company-dev",
                    "expectedPluginId": "missing-plugin",
                    "approvedRulePaths": [],
                    "extensionTools": [],
                },
            )

        self.assertNotIn(str(missing), str(caught.exception))

    def test_prompts_and_workflows_are_available_through_the_same_session_api(self) -> None:
        plugin_key = "company-dev/sample-plugin"
        prompts = self.api.save_prompts(
            self.token,
            plugin_key,
            {
                "expectedRevision": 0,
                "items": [{"id": "check", "scenario": "检查", "content": "检查内容", "createdAt": "2026-08-26T00:00:00Z"}],
            },
        )
        self.assertEqual(prompts["revision"], 1)
        self.assertEqual(self.api.get_prompts(plugin_key)["items"][0]["id"], "check")
        self.assertEqual(self.api.get_prompts("company-dev/yusheng-inc")["items"], [])

        workflow = {
            "pluginKey": plugin_key,
            "tabs": [
                {
                    "id": "installation",
                    "title": "插件安装",
                    "sections": [
                        {
                            "id": "first",
                            "title": "首次安装",
                            "steps": [
                                {
                                    "id": "prepare",
                                    "label": "准备",
                                    "title": "取得插件包",
                                    "description": "",
                                    "next": [],
                                }
                            ],
                        }
                    ],
                }
            ],
        }
        saved = self.api.save_workflows(
            self.token,
            plugin_key,
            {"expectedRevision": 0, "workflow": workflow},
        )
        self.assertEqual(saved["revision"], 1)
        self.assertEqual(self.api.get_workflows(plugin_key)["tabs"][0]["id"], "installation")

        with self.assertRaisesRegex(ApiError, "会话无效"):
            self.api.save_prompts("wrong-token", plugin_key, {"expectedRevision": 1, "items": []})

    def test_download_publication_is_bound_to_the_active_plugin_and_session(self) -> None:
        archive = self.root / "sample-plugin.zip"
        archive.write_bytes(b"candidate")
        publisher = RecordingDownloadPublisher()
        api = PortalApi(
            self.store,
            archive_picker=lambda: archive,
            download_publisher=publisher,
        )
        token = api.create_session()["token"]
        preview = api.preview_import(token, {
            "source": {"kind": "server-directory", "path": str(self.plugin_root)},
            "target": "company-dev",
            "expectedPluginId": "sample-plugin",
            "approvedRulePaths": ["rules/public.md"],
            "extensionTools": [],
        })
        api.promote(token, "company-dev/sample-plugin", {
            "candidateId": preview["candidateId"], "expectedRevision": 0,
        })

        selected = api.select_download_candidate(token, "company-dev/sample-plugin", {})

        self.assertTrue(selected["selected"])
        self.assertIn("publicationId", selected)
        self.assertEqual(selected["preview"]["destinationFileName"], "sample-plugin-1.2.3-company-dev.zip")
        self.assertNotIn(str(archive), json.dumps(selected, ensure_ascii=False))
        self.assertEqual(publisher.previews, [(archive, "company-dev/sample-plugin", "1.2.3")])

        another_token = api.create_session()["token"]
        with self.assertRaises(ApiError) as cross_session:
            api.confirm_download_publication(another_token, "company-dev/sample-plugin", {
                "publicationId": selected["publicationId"],
            })
        self.assertEqual(cross_session.exception.code, "publication_not_found")
        with self.assertRaises(ApiError) as wrong_plugin:
            api.confirm_download_publication(token, "company-dev/another-plugin", {
                "publicationId": selected["publicationId"],
            })
        self.assertEqual(wrong_plugin.exception.code, "plugin_identity_mismatch")

        result = api.confirm_download_publication(token, "company-dev/sample-plugin", {
            "publicationId": selected["publicationId"],
        })
        self.assertEqual(result["fileName"], "sample-plugin-1.2.3-company-dev.zip")
        self.assertEqual(len(publisher.published), 1)
        with self.assertRaises(ApiError) as consumed:
            api.confirm_download_publication(token, "company-dev/sample-plugin", {
                "publicationId": selected["publicationId"],
            })
        self.assertEqual(consumed.exception.code, "publication_not_found")

    def test_download_publication_cancel_does_not_call_the_publisher(self) -> None:
        publisher = RecordingDownloadPublisher()
        api = PortalApi(self.store, archive_picker=lambda: None, download_publisher=publisher)
        token = api.create_session()["token"]
        preview = api.preview_import(token, {
            "source": {"kind": "server-directory", "path": str(self.plugin_root)},
            "target": "company-dev",
            "expectedPluginId": "sample-plugin",
            "approvedRulePaths": ["rules/public.md"],
            "extensionTools": [],
        })
        api.promote(token, "company-dev/sample-plugin", {
            "candidateId": preview["candidateId"], "expectedRevision": 0,
        })

        self.assertEqual(
            api.select_download_candidate(token, "company-dev/sample-plugin", {}),
            {"selected": False},
        )
        self.assertEqual(publisher.previews, [])

    def test_remote_download_upload_audits_then_confirms_the_same_staged_file(self) -> None:
        imported = self.preview()
        self.api.promote(self.token, "company-dev/sample-plugin", {
            "candidateId": imported["candidateId"], "expectedRevision": 0,
        })
        registry = UploadRegistry(root=self.root / "remote-download-uploads")
        publisher = RecordingDownloadPublisher()
        remote = PortalApi(
            self.store,
            access_mode="remote-management",
            upload_registry=registry,
            download_publisher=publisher,
        )
        self.addCleanup(remote.close)
        token = remote.create_session()["token"]
        payload = b"PK\x05\x06" + b"\0" * 18 + b"candidate"

        selected = remote.upload_download_candidate(
            token,
            "company-dev/sample-plugin",
            "candidate.zip",
            io.BytesIO(payload),
            len(payload),
        )

        self.assertTrue(selected["selected"])
        self.assertEqual(set(selected), {"selected", "publicationId", "preview"})
        staged_path = publisher.previews[0][0]
        self.assertEqual(staged_path.read_bytes(), payload)
        self.assertNotIn(str(staged_path), json.dumps(selected, ensure_ascii=False))

        result = remote.confirm_download_publication(token, "company-dev/sample-plugin", {
            "publicationId": selected["publicationId"],
        })

        self.assertEqual(result["candidateSha256"], selected["preview"]["candidateSha256"])
        self.assertFalse(staged_path.exists())
        self.assertEqual(len(publisher.published), 1)

    def test_remote_download_replacement_expiry_and_retry_keep_only_safe_candidates(self) -> None:
        imported = self.preview()
        self.api.promote(self.token, "company-dev/sample-plugin", {
            "candidateId": imported["candidateId"], "expectedRevision": 0,
        })
        now = [100.0]
        registry = UploadRegistry(root=self.root / "retry-download-uploads", clock=lambda: now[0])
        publisher = RetryableDownloadPublisher()
        remote = PortalApi(
            self.store,
            access_mode="remote-management",
            upload_registry=registry,
            download_publisher=publisher,
        )
        self.addCleanup(remote.close)
        token = remote.create_session()["token"]

        first = remote.upload_download_candidate(
            token, "company-dev/sample-plugin", "first.zip", io.BytesIO(b"first"), 5,
        )
        first_path = publisher.previews[-1][0]
        second = remote.upload_download_candidate(
            token, "company-dev/sample-plugin", "second.zip", io.BytesIO(b"second"), 6,
        )
        second_path = publisher.previews[-1][0]
        self.assertFalse(first_path.exists())
        self.assertTrue(second_path.exists())
        with self.assertRaises(ApiError) as replaced:
            remote.confirm_download_publication(token, "company-dev/sample-plugin", {
                "publicationId": first["publicationId"],
            })
        self.assertEqual(replaced.exception.code, "publication_not_found")

        with self.assertRaises(ApiError) as retryable:
            remote.confirm_download_publication(token, "company-dev/sample-plugin", {
                "publicationId": second["publicationId"],
            })
        self.assertEqual(retryable.exception.code, "publication_failed")
        self.assertTrue(second_path.exists())
        remote.confirm_download_publication(token, "company-dev/sample-plugin", {
            "publicationId": second["publicationId"],
        })
        self.assertFalse(second_path.exists())

        expired = remote.upload_download_candidate(
            token, "company-dev/sample-plugin", "expired.zip", io.BytesIO(b"expired"), 7,
        )
        expired_path = publisher.previews[-1][0]
        now[0] += 15 * 60 + 1
        with self.assertRaises(ApiError) as stale:
            remote.confirm_download_publication(token, "company-dev/sample-plugin", {
                "publicationId": expired["publicationId"],
            })
        self.assertEqual(stale.exception.code, "publication_not_found")
        self.assertFalse(expired_path.exists())

    def test_remote_download_rejects_picker_and_cleans_failed_audit(self) -> None:
        imported = self.preview()
        self.api.promote(self.token, "company-dev/sample-plugin", {
            "candidateId": imported["candidateId"], "expectedRevision": 0,
        })
        for code, expected_status in (("candidate_rejected", 400), ("plugin_release_unavailable", 503)):
            with self.subTest(code=code):
                upload_root = self.root / f"rejected-{code}"
                remote = PortalApi(
                    self.store,
                    access_mode="remote-management",
                    upload_registry=UploadRegistry(root=upload_root),
                    download_publisher=RejectingDownloadPublisher(code),
                    archive_picker=lambda: self.fail("remote mode called the host picker"),
                )
                token = remote.create_session()["token"]
                with self.assertRaises(ApiError) as rejected:
                    remote.upload_download_candidate(
                        token, "company-dev/sample-plugin", "candidate.zip", io.BytesIO(b"candidate"), 9,
                    )
                self.assertEqual((rejected.exception.code, rejected.exception.status), (code, expected_status))
                self.assertEqual(list(upload_root.glob("*.zip")), [])
                with self.assertRaises(ApiError) as picker:
                    remote.select_download_candidate(token, "company-dev/sample-plugin", {})
                self.assertEqual(picker.exception.code, "source_mode_invalid")
                remote.close()


if __name__ == "__main__":
    unittest.main()
