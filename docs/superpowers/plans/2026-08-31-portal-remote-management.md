# Portal Cross-Network Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable every Portal management action on HTTPS 9135 and replace server-host file pickers with safe browser ZIP uploads for plugin inclusion and audited download publication.

**Architecture:** Add an explicit `remote-management` server mode behind the existing HTTPS proxy, while retaining local and read-only modes. A bounded upload registry streams ZIPs to private temporary storage; plugin ZIPs are safely extracted into frozen public snapshots and snapshot-bound icons, while download ZIPs remain immutable until Plugin Release audits and publishes them.

**Tech Stack:** Python 3.12 standard library (`http.server`, `tempfile`, `zipfile`), React 19, TypeScript 7, Vitest 4, Playwright 1.62, PowerShell, Caddy HTTPS reverse proxy.

**Spec:** `docs/superpowers/specs/2026-08-31-portal-remote-management-design.md`

## Global Constraints

- Work only in the existing isolated worktree `feat/plugin-release-download-publishing`; preserve every pre-existing uncommitted change.
- Do not create another worktree, commit, push, publish, restart 9134/9135/9137, or operate on 9136 without separate authorization.
- 9135 has no login, user role, or IP allowlist; any routed client can manage Portal data.
- Retain exact Host/Origin checks, session tokens, revision checks, plugin identity checks, the 128 MiB compressed upload ceiling, and existing Plugin Release audit/readback gates.
- Do not accept arbitrary server, UNC, or SMB paths from remote clients; do not execute, import, install, or enable uploaded plugin code.
- `remote-management` must serve only the frozen `index.html` and `assets/` static whitelist.
- Keep local 9137 server pickers and explicit read-only mode working.
- Persist uploaded plugin icons by snapshot without changing public snapshot, Prompt, workflow, plugin route, or download metadata schemas.
- Use Python standard library only; add no runtime npm or Python dependency.
- Every implementation task follows RED → focused GREEN → regression. Record review checkpoints with `git diff --check`; do not commit in this authorized batch.

---

### Task 1: Explicit access modes and remote HTTPS backend contract

**Files:**
- Modify: `plugin_portal/server.py`
- Modify: `plugin_portal/__main__.py`
- Modify: `tests/test_server.py`
- Modify: `tests/test_lan_server.py`
- Modify: `tests/test_https_proxy.py`

**Interfaces:**
- Produces: `create_server(..., read_only: bool = False, remote_management: bool = False, https_origin: str | None = None)`.
- Produces: `PortalHTTPServer.access_mode` with values `local-management`, `remote-management`, or `read-only`.
- Produces: `GET /api/access -> {"readOnly": bool, "fileSelectionMode": "server-picker" | "browser-upload" | "none"}`.
- Preserves: `PortalHTTPServer.read_only` as the write-denial predicate used by existing routes.
- Production remote mode accepts only a private-IPv4 HTTPS origin on port 9135; `test_only=True` additionally accepts a loopback HTTPS origin on an injected temporary port for isolated Caddy tests.

- [ ] **Step 1: Add failing server-mode tests**

```python
def test_reports_local_and_remote_file_selection_modes(self):
    self.assertEqual(self.json_request(self.server, "/api/access"), {
        "readOnly": False,
        "fileSelectionMode": "server-picker",
    })
    remote = create_server(
        host="127.0.0.1", port=0, test_only=True,
        data_root=self.root / "remote-data", web_root=self.web_root,
        remote_management=True,
        https_origin="https://192.168.7.125:9135",
    )
    self.addCleanup(remote.server_close)
    self.assertEqual(remote.access_mode, "remote-management")
    self.assertEqual(remote.file_selection_mode, "browser-upload")
```

Add rejection cases for `read_only=True` with `remote_management=True`, remote management without an HTTPS origin, non-loopback binding, public origin IP, wrong port outside test mode, and duplicate/wrong Host headers. Add one positive test-only loopback HTTPS-origin case. Assert remote mode creates sessions while read-only mode still rejects writes before parsing a body.

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```powershell
python -m unittest tests.test_server tests.test_lan_server tests.test_https_proxy -v
```

Expected: failures because `remote_management` and `fileSelectionMode` do not exist and proxy mode still requires read-only.

- [ ] **Step 3: Implement the access-mode state machine**

Use one internal mode derivation rather than scattered booleans:

```python
def _access_mode(*, read_only: bool, remote_management: bool) -> str:
    if read_only and remote_management:
        raise ServerConfigurationError("访问模式不能同时为只读和远端管理")
    if read_only:
        return "read-only"
    if remote_management:
        return "remote-management"
    return "local-management"
```

Make `PortalHTTPServer` freeze `_public_static_files(web_root)` for both external modes. Validate `remote-management` as loopback backend port 9135 with a strict private-IPv4 HTTPS origin. Update `_same_origin()` to validate exact Host for both external modes. Add mutually exclusive CLI flags `--read-only` and `--remote-management`.

- [ ] **Step 4: Run focused tests and regression**

```powershell
python -m unittest tests.test_server tests.test_lan_server tests.test_https_proxy -v
python -m unittest discover -s tests -v
git diff --check
```

Expected: all current Python tests pass; no live listener changes.

---

### Task 2: Bounded upload staging and lifecycle cleanup

**Files:**
- Create: `plugin_portal/uploads.py`
- Create: `tests/test_uploads.py`
- Modify: `plugin_portal/server.py`

**Interfaces:**
- Produces: `UploadError(code: str, message: str)`.
- Produces: immutable `StagedUpload(upload_id: str, session_token: str, kind: str, file_name: str, path: Path, size: int, created_at: float)`.
- Produces: `UploadRegistry.stage(session_token, kind, file_name, source, content_length) -> StagedUpload`.
- Produces: `UploadRegistry.require(session_token, kind, upload_id) -> StagedUpload`, `consume(session_token, kind, upload_id) -> StagedUpload`, `discard(session_token, kind, upload_id) -> None`, `prune() -> None`, and `close() -> None`.
- Limit constants: 128 MiB compressed body, one upload per `(session, kind)`, 16 global active uploads, 15-minute lifetime.

- [ ] **Step 1: Write failing registry tests**

```python
def test_stage_replaces_same_session_kind_and_isolates_sessions(self):
    registry = UploadRegistry(root=self.root, clock=self.clock)
    first = registry.stage("session-a", "plugin-import", "one.zip", io.BytesIO(b"PK\x03\x04one"), 7)
    second = registry.stage("session-a", "plugin-import", "two.zip", io.BytesIO(b"PK\x03\x04two"), 7)
    self.assertFalse(first.path.exists())
    self.assertEqual(registry.require("session-a", "plugin-import", second.upload_id), second)
    with self.assertRaises(UploadError) as other_session:
        registry.require("session-b", "plugin-import", second.upload_id)
    self.assertEqual(other_session.exception.code, "upload_not_found")
```

Add tests for streaming in small chunks, invalid filename/content length, short body, 128 MiB+ rejection without retaining a file, global capacity, 15-minute prune, explicit discard/consume, replacement, and `close()` cleanup.

- [ ] **Step 2: Run focused test and confirm RED**

```powershell
python -m unittest tests.test_uploads -v
```

Expected: import failure because `plugin_portal.uploads` does not exist.

- [ ] **Step 3: Implement minimal streaming registry**

Create the registry around a process-private `TemporaryDirectory` or an injected plain test root. Use `secrets.token_urlsafe(24)`, `time.monotonic`, `os.fsync`, exact content-length accounting, ordinary-file `lstat`, and atomic ownership in a lock. Sanitize the decoded upload name to one `.zip` basename; never return `path` in an API response.

Add `PortalHTTPServer.server_close()` cleanup by calling `self.api.close()` before the base implementation; repeated close must be safe.

- [ ] **Step 4: Run focused and full Python tests**

```powershell
python -m unittest tests.test_uploads -v
python -m unittest discover -s tests -v
git diff --check
```

Expected: registry tests and existing server shutdown tests pass without leftover files.

---

### Task 3: Safe plugin ZIP extraction

**Files:**
- Create: `plugin_portal/plugin_archive.py`
- Create: `tests/test_plugin_archive.py`

**Interfaces:**
- Produces: `PluginArchiveError(code: str, message: str)` where code is `archive_invalid` or `archive_unsafe`.
- Produces: `extract_plugin_archive(archive_path: Path, destination: Path) -> Path`, returning the unique plugin root.
- Consumes: staged ordinary ZIP from Task 2.
- Constants: 4096 entries, 256 MiB total uncompressed, 32 MiB per entry, 100:1 maximum per-entry compression ratio.

- [ ] **Step 1: Write a ZIP fixture helper and failing safety tests**

```python
def write_zip(path: Path, entries: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, payload in entries.items():
            archive.writestr(name, payload)

def test_accepts_root_or_single_wrapper_and_finds_one_plugin_root(self):
    write_zip(self.archive, {
        "sample/.codex-plugin/plugin.json": b'{"name":"sample"}',
        "sample/skills/example/SKILL.md": b"---\nname: example\ndescription: x\n---\n# Example\n",
    })
    root = extract_plugin_archive(self.archive, self.destination)
    self.assertEqual(root, self.destination / "sample")
```

Add separate rejection tests for `../`, absolute paths, backslashes, empty/dot segments, case-fold collisions, duplicate names, encrypted flags, symlink external attributes, unsupported compression, excessive entry count, per-file/total size, compression ratio, corrupt ZIP, zero plugin roots, and two plugin roots. Assert failure removes the destination contents.

- [ ] **Step 2: Run the focused suite and confirm RED**

```powershell
python -m unittest tests.test_plugin_archive -v
```

Expected: import failure for the missing archive module.

- [ ] **Step 3: Implement validation before extraction**

Normalize every `ZipInfo.filename` with `PurePosixPath`, reject Windows-drive and UNC forms, and build a case-folded path set before creating files. Inspect `flag_bits`, `external_attr`, compression type, compressed size, file size, and aggregate limits. Create parent directories deliberately, open output files with exclusive creation, copy in bounded chunks, and verify the copied byte count.

On any exception, recursively remove only the exact injected `destination`; never delete its parent or an unresolved path.

- [ ] **Step 4: Run focused and regression tests**

```powershell
python -m unittest tests.test_plugin_archive -v
python -m unittest tests.test_plugin_reader tests.test_public_repository -v
git diff --check
```

Expected: all archive attacks fail closed and ordinary plugin reading is unchanged.

---

### Task 4: Snapshot-bound plugin icons

**Files:**
- Modify: `plugin_portal/storage.py`
- Modify: `plugin_portal/api.py`
- Modify: `tests/test_storage.py`
- Modify: `tests/test_api.py`
- Modify: `tests/test_server.py`

**Interfaces:**
- Produces: `PortalStore.put_snapshot_icon(plugin_key, snapshot_id, content_type, payload) -> None`.
- Produces: `PortalStore.read_snapshot_icon(plugin_key, snapshot_id) -> tuple[str, bytes]`.
- Candidate internal shape adds optional `icon: tuple[str, bytes]`; the public `PluginImportCandidate` response remains unchanged.
- `PortalApi.get_plugin_icon()` resolves snapshot asset → exact installed-cache version → generic SVG.

- [ ] **Step 1: Add failing atomic icon tests**

```python
def test_snapshot_icon_round_trip_is_immutable(self):
    self.store.put_snapshot_icon("company-dev/sample-plugin", "a" * 64, "image/png", b"png")
    self.assertEqual(
        self.store.read_snapshot_icon("company-dev/sample-plugin", "a" * 64),
        ("image/png", b"png"),
    )
    with self.assertRaises(StorageError):
        self.store.put_snapshot_icon("company-dev/sample-plugin", "a" * 64, "image/png", b"changed")
```

Add tests for allowed MIME types, 2 MiB maximum, invalid plugin/snapshot IDs, atomic cleanup on write failure, uploaded icon served without installed cache, old snapshot cache fallback, generic fallback, and rollback selecting the previous snapshot icon.

- [ ] **Step 2: Run focused tests and confirm RED**

```powershell
python -m unittest tests.test_storage tests.test_api tests.test_server -v
```

Expected: missing icon storage methods and uploaded icon assertions fail.

- [ ] **Step 3: Implement immutable icon assets**

Store assets below `data_root/snapshot-assets/<target>/<pluginId>/<snapshotId>/icon.<ext>` with a closed `metadata.json` containing only content type and byte length. Add `_atomic_write_bytes()` alongside the JSON writer. Verify existing bytes and metadata on duplicate writes; do not overwrite a digest collision.

During preview, call `read_plugin_icon(root)` and freeze a defensive byte copy; treat “no public icon” as absent, but propagate unsafe/corrupt icon errors. During promote, write snapshot, then icon, then catalog. An orphaned immutable asset after a catalog revision conflict is harmless and reusable.

- [ ] **Step 4: Run focused and full Python tests**

```powershell
python -m unittest tests.test_storage tests.test_api tests.test_server -v
python -m unittest discover -s tests -v
git diff --check
```

Expected: uploaded icon and rollback behavior pass with no public snapshot schema change.

---

### Task 5: Remote plugin upload and preview flow

**Files:**
- Modify: `plugin_portal/api.py`
- Modify: `plugin_portal/server.py`
- Modify: `tests/test_api.py`
- Modify: `tests/test_server.py`
- Modify: `tests/test_https_proxy.py`

**Interfaces:**
- Consumes: `UploadRegistry` and `extract_plugin_archive()` from Tasks 2–3.
- Produces: `POST /api/uploads/plugin-import` accepting `application/zip`, standards-compliant `Content-Disposition`, `X-Portal-Session`, and exact `Content-Length`.
- Produces: `{uploadId: string, fileName: string, archiveBytes: number}`.
- Changes `preview_import` source to a closed union:

```json
{"source":{"kind":"server-directory","path":"C:\\..."},"target":"company-dev","expectedPluginId":"","approvedRulePaths":[],"extensionTools":[]}
```

or

```json
{"source":{"kind":"upload","uploadId":"..."},"target":"company-dev","expectedPluginId":"","approvedRulePaths":[],"extensionTools":[]}
```

- [ ] **Step 1: Add failing API and HTTP tests**

```python
def test_remote_upload_previews_and_promotes_without_exposing_a_path(self):
    token = self.create_session()
    uploaded = self.binary_request(
        "/api/uploads/plugin-import", self.plugin_zip,
        headers={"X-Portal-Session": token, "Content-Disposition": "attachment; filename*=UTF-8''sample.zip"},
    )
    self.assertEqual(set(uploaded), {"uploadId", "fileName", "archiveBytes"})
    candidate = self.json_post("/api/plugins/import/preview", {
        "source": {"kind": "upload", "uploadId": uploaded["uploadId"]},
        "target": "company-dev", "expectedPluginId": "",
        "approvedRulePaths": ["rules/public.md"], "extensionTools": [],
    }, token=token)
    self.assertNotIn("path", json.dumps(candidate))
```

Add tests for wrong mode (local cannot upload; remote cannot submit `server-directory`), wrong content type, invalid/missing filename, missing/oversized length, invalid session before body consumption, cross-session upload ID, retry after a public-projection error, cleanup after successful preview, and exact Host/Origin enforcement through proxy mode.

- [ ] **Step 2: Run focused tests and confirm RED**

```powershell
python -m unittest tests.test_api tests.test_server tests.test_https_proxy -v
```

Expected: upload route returns 404 and the new source union is rejected.

- [ ] **Step 3: Implement binary routing and source resolution**

Branch binary upload routes before `_read_json_body()`. Require exact `application/zip`, a standards-compliant `Content-Disposition` filename decoded to one ZIP basename, and a valid session before streaming. Map `UploadError`/`PluginArchiveError` to the design error codes without paths.

Resolve `server-directory` only in local mode and `upload` only in remote mode. Extract uploads into the staged private directory, generate the snapshot and icon, then consume all upload files after a successful preview. Keep a safely staged upload after projection-only failure so advanced fields can be corrected.

- [ ] **Step 4: Run focused and full Python tests**

```powershell
python -m unittest tests.test_api tests.test_server tests.test_https_proxy -v
python -m unittest discover -s tests -v
git diff --check
```

Expected: remote upload/promote works; local picker and read-only denial remain green.

---

### Task 6: Remote audited download publication upload

**Files:**
- Modify: `plugin_portal/api.py`
- Modify: `plugin_portal/server.py`
- Modify: `plugin_portal/download_publication.py`
- Modify: `tests/test_api.py`
- Modify: `tests/test_server.py`
- Modify: `tests/test_download_publication.py`

**Interfaces:**
- Produces: `POST /api/plugins/{pluginKey}/download-publication/upload` with the same binary upload headers as Task 5.
- Produces: the existing closed `DownloadCandidateSelection` response.
- Preserves: local `/download-publication/select` host picker and existing `/confirm` endpoint.
- Candidate ownership binds session token, plugin key, active version, source file identity, digest, and 15-minute upload lifetime.

- [ ] **Step 1: Add failing remote publication tests**

```python
def test_remote_download_upload_audits_then_confirms_the_same_bytes(self):
    selected = self.binary_request(
        f"/api/plugins/{self.encoded_key}/download-publication/upload",
        self.candidate_zip,
        headers={"X-Portal-Session": self.token, "Content-Disposition": "attachment; filename*=UTF-8''candidate.zip"},
    )
    self.assertTrue(selected["selected"])
    receipt = self.json_post(
        f"/api/plugins/{self.encoded_key}/download-publication/confirm",
        {"publicationId": selected["publicationId"]}, token=self.token,
    )
    self.assertEqual(receipt["candidateSha256"], selected["preview"]["candidateSha256"])
```

Add tests for disabled remote use of the host picker, replacement cleaning the old file, cross-session/plugin/version rejection, expired upload, failed audit cleanup, publish failure retaining a retryable unchanged candidate, successful confirmation cleanup, and Plugin Release unavailable returning 503.

- [ ] **Step 2: Run focused tests and confirm RED**

```powershell
python -m unittest tests.test_download_publication tests.test_api tests.test_server -v
```

Expected: remote publication route is missing.

- [ ] **Step 3: Reuse the upload registry without weakening publisher checks**

Stage the original candidate ZIP; call `DownloadPublisher.preview()` on that private ordinary file. Keep the `StagedUpload` reference beside the publication candidate. Confirm must call `require()` again before `publish()` and must not reconstruct a path from client data. Consume after successful publication; retain only safe unchanged candidates after retryable publication errors.

- [ ] **Step 4: Run focused and full Python tests**

```powershell
python -m unittest tests.test_download_publication tests.test_api tests.test_server -v
python -m unittest discover -s tests -v
git diff --check
```

Expected: both local picker and remote upload publication flows pass with identical audit/readback gates.

---

### Task 7: Typed browser-upload client

**Files:**
- Modify: `src/portal/types.ts`
- Modify: `src/portal/api.ts`
- Modify: `src/portal/api.test.ts`
- Modify: `src/portal/PortalShell.tsx`
- Modify: `src/portal/PortalShell.test.tsx`

**Interfaces:**
- Produces: `PortalAccess = { readOnly: boolean; fileSelectionMode: "server-picker" | "browser-upload" | "none" }`.
- Produces: `PluginImportSource = { kind: "server-directory"; path: string } | { kind: "upload"; uploadId: string }`.
- Produces: `PluginUploadReceipt = { uploadId: string; fileName: string; archiveBytes: number }`.
- Produces: `PortalClient.uploadPluginArchive(file: File) -> Promise<PluginUploadReceipt>`.
- Produces: `PortalClient.uploadDownloadCandidate(pluginKey: string, file: File) -> Promise<DownloadCandidateSelection>`.
- `PortalShell` passes the full `PortalAccess` to Hub management components; page action visibility remains derived from `readOnly`.

- [ ] **Step 1: Add failing closed-response and raw-upload tests**

```typescript
it("uploads ZIP bytes with the shared management session", async () => {
  const file = new File([new Uint8Array([0x50, 0x4b])], "sample.zip", { type: "application/zip" });
  const receipt = await client.uploadPluginArchive(file);
  expect(calls.at(-1)).toMatchObject({
    input: "/api/uploads/plugin-import",
    init: {
      method: "POST",
      body: file,
      headers: expect.objectContaining({
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent("sample.zip")}`,
      }),
    },
  });
  expect(receipt.fileName).toBe("sample.zip");
});
```

Add response-validator tests for all three file-selection modes, extra/missing access fields, invalid upload receipts, invalid publication previews, reused session token, and surfaced structured API errors.

- [ ] **Step 2: Run Vitest and confirm RED**

```powershell
npm test -- --run src/portal/api.test.ts src/portal/PortalShell.test.tsx
```

Expected: missing access field/types and upload methods.

- [ ] **Step 3: Implement typed upload requests**

Add a `mutateBinary(path, file)` helper that reuses `getSessionToken()`, sends the raw `File`, and validates JSON responses through the existing request/error path. Do not set `Content-Length` in browser code. Update `previewImport` to serialize the discriminated `source` union exactly.

Store one `PortalAccess` object in `PortalShell` instead of separate inferred hostname logic. Do not reload the page or recreate the client when access mode resolves.

- [ ] **Step 4: Run focused Vitest and TypeScript**

```powershell
npm test -- --run src/portal/api.test.ts src/portal/PortalShell.test.tsx
npm run typecheck
git diff --check
```

Expected: closed contracts and TypeScript compile pass.

---

### Task 8: Remote file controls and immediate catalog/icon refresh

**Files:**
- Modify: `src/portal/PluginManager.tsx`
- Modify: `src/portal/PluginManager.test.tsx`
- Modify: `src/portal/DownloadPublisher.tsx`
- Modify: `src/portal/DownloadPublisher.test.tsx`
- Modify: `src/hub/HubEntry.tsx`
- Modify: `src/hub/HubEntry.test.tsx`
- Modify: `src/portal/PortalShell.tsx`
- Modify: `src/portal/PortalShell.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `PortalAccess`, upload methods, and local picker methods from Task 7.
- `PluginManager` receives `fileSelectionMode` and uses exactly one source control.
- `DownloadPublisherDialog` receives `fileSelectionMode` and uses browser file input only in remote mode.
- Successful promote/refresh/rollback calls the existing `onCatalogChanged()` and closes only after refreshed catalog resolution.

- [ ] **Step 1: Add failing component behavior tests**

```typescript
it("uses a browser ZIP in remote mode and refreshes the catalog", async () => {
  const file = new File(["zip"], "sample.zip", { type: "application/zip" });
  render(<PluginManager
    catalogRevision={3}
    client={client}
    fileSelectionMode="browser-upload"
    onChanged={onChanged}
  />);
  fireEvent.change(screen.getByLabelText("插件 ZIP"), { target: { files: [file] } });
  await waitFor(() => expect(client.uploadPluginArchive).toHaveBeenCalledWith(file));
  fireEvent.click(await screen.findByRole("button", { name: "确认纳入" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledWith("sample-plugin"));
});
```

Add tests that local mode still renders “选择插件目录”, remote mode never calls it, read-only renders neither control, download publication uploads a browser ZIP remotely, buttons are disabled during upload/audit, errors permit retry, successful catalog refresh changes icon URL revision, Escape closes, and focus returns to the trigger.

- [ ] **Step 2: Run focused components and confirm RED**

```powershell
npm test -- --run src/portal/PluginManager.test.tsx src/portal/DownloadPublisher.test.tsx src/hub/HubEntry.test.tsx src/portal/PortalShell.test.tsx
```

Expected: missing props/methods and remote file controls.

- [ ] **Step 3: Implement mode-specific controls**

Use a native visible or labelled file input; do not synthesize a server path. After upload, pass `{kind: "upload", uploadId}` to preview. “重新选择” replaces the session upload. Preserve advanced target/rule/tool fields and clear stale candidates when they change.

For download publication, remote selection calls `uploadDownloadCandidate(pluginKey, file)` while local selection calls `selectDownloadCandidate(pluginKey)`. Keep the existing Plugin Release preview and confirmation UI.

Pass `fileSelectionMode` from `PortalShell` through `HubEntry`. Keep Prompt/workflow actions controlled only by `readOnly`; remote management therefore displays every existing action.

- [ ] **Step 4: Run focused UI tests, full Vitest, and typecheck**

```powershell
npm test -- --run src/portal/PluginManager.test.tsx src/portal/DownloadPublisher.test.tsx src/hub/HubEntry.test.tsx src/portal/PortalShell.test.tsx
npm test -- --run
npm run typecheck
git diff --check
```

Expected: all UI tests pass with no hostname inference or full-page reload.

---

### Task 9: Remote-management startup, documentation, browser coverage, and full verification

**Files:**
- Create: `scripts/start-remote-management.ps1`
- Create: `e2e/remote-management.spec.ts`
- Create: `e2e/httpsProxy.ts`
- Modify: `e2e/run_test_server.py`
- Modify: `e2e/testServer.ts`
- Modify: `e2e/lan.spec.ts`
- Modify: `e2e/portal.spec.ts`
- Modify: `README.md`
- Modify: `tests/test_public_repository.py`

**Interfaces:**
- `scripts/start-remote-management.ps1 -Address <private IPv4>` starts only the loopback Python 9135 backend with `--remote-management --https-origin https://<Address>:9135`; it does not edit/start/stop Caddy or any live service.
- The script performs candidate/preflight checks, exact process ownership checks, GET/HEAD/hash, and `/api/access` capability readback.
- E2E test server gains `--remote-management` and a generated valid plugin ZIP plus audited candidate ZIP.
- `e2e/httpsProxy.ts` starts an isolated Caddy process from `PORTAL_CADDY_PATH`, using temporary ports/config/storage and no live Caddy files; Playwright connects with `ignoreHTTPSErrors` only for this private test CA.

- [ ] **Step 1: Add failing repository and E2E assertions**

```typescript
test("remote management uploads a plugin and exposes every page action", async ({ page }) => {
  const portal = await startPortal({ remoteManagement: true });
  await page.goto(`${portal.baseUrl}/#/hub`);
  await page.getByRole("button", { name: "纳入插件" }).click();
  await page.getByLabel("插件 ZIP").setInputFiles(portal.pluginArchive);
  await page.getByRole("button", { name: "确认纳入" }).click();
  await expect(page.getByRole("img", { name: /插件图标/ })).toHaveAttribute("src", /revision=/);
  await page.goto(`${portal.baseUrl}/#/plugins/sample-plugin/prompts`);
  await expect(page.getByRole("button", { name: "新增 Prompt" })).toBeVisible();
});
```

Add E2E steps for workflow configuration, Prompt save, download candidate upload/preview/confirm, refresh and rollback icon changes, 320/390/768/1120/1600 widths, cross-origin rejection, and no console errors. Run the primary remote flow through the isolated HTTPS Caddy proxy and prove POST reaches Python. Keep explicit read-only E2E proving buttons remain hidden and writes remain 403.

Add repository assertions that README no longer describes 9135 as always read-only, documents unauthenticated write scope, and gives exact remote backend plus Caddy write-pass configuration without secrets or personal paths.

- [ ] **Step 2: Run focused checks and confirm RED**

```powershell
python -m unittest tests.test_public_repository -v
npm run build
npx playwright test e2e/remote-management.spec.ts e2e/lan.spec.ts
```

Expected: missing startup script/test mode and remote flow failures.

- [ ] **Step 3: Implement startup and deterministic browser fixtures**

Generate ZIP fixtures under the E2E temporary root with Python `zipfile`; do not add binary fixtures to Git. The HTTPS helper must write its Caddyfile under the E2E temporary root, bind loopback only, use a temporary internal-CA storage root, disable the admin API, proxy every method, and terminate only the PID it started. Production validation remains strict; only `test_only=True` may accept the helper's loopback HTTPS origin and arbitrary temporary proxy port.

Make `start-remote-management.ps1` validate the runtime, web root, existing data root, private IP, free loopback 9135, expected external Caddy listener presence, and exact access response. Use `Start-Process -WindowStyle Hidden`; if readiness fails, stop only the process it started.

Document the Caddy change as removing only:

```caddyfile
@writes not method GET HEAD
respond @writes 403
```

while retaining the existing exact bind, internal TLS, catch-all 421, disabled admin, and loopback reverse proxy. State that live modification follows the separate two-stage release/rollback procedure from the spec.

- [ ] **Step 4: Run all automated verification**

```powershell
python -m unittest discover -s tests -v
npm test -- --run
npm run typecheck
$isolatedBuild = Join-Path $env:TEMP ("plugin-portal-build-" + [guid]::NewGuid())
npx vite build --outDir $isolatedBuild --emptyOutDir
$env:PORTAL_CADDY_PATH = (Get-Process -Name caddy -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Path)
npx playwright test
git diff --check
```

Expected: all Python, Vitest, TypeScript, isolated build, and Playwright checks pass. Remove `$isolatedBuild` after recording its index hash; do not alter live `dist` or services for this verification.

- [ ] **Step 5: Perform final scope and hygiene review**

```powershell
git status --short
git diff --stat
rg -n "C:\\Users\\|AppData\\Local\\plugin-portal|PRIVATE KEY|BEGIN .* KEY|token=|password=" README.md docs plugin_portal src scripts tests e2e
Get-ChildItem -Recurse -File -Include *.partial,*.quarantine,*.tmp,__pycache__ | Select-Object -ExpandProperty FullName
```

Expected: only intended source/docs/tests are changed; no credentials, personal absolute paths, upload remnants, build candidate, or Python cache is included. Preserve unrelated pre-existing worktree changes and report them separately.

---

## Completion Boundary

Implementation is complete only when all Task 9 verification commands pass and the final diff matches this spec. Completion does not authorize commit, push, live Caddy edits, service restart, publication, or deployment. A later explicit “发布” must re-read current listeners/config/build hashes and execute the two-stage activation and rollback procedure.
