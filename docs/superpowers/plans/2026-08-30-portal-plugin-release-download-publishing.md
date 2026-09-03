# Portal Plugin Release Download Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让本机 Portal 通过 Plugin Release 只读审计现成候选 ZIP，并在二次确认后原子发布到现有 9134 下载目录。

**Architecture:** Python 新增一个单一下载发布模块，封装 Windows ZIP 选择、Plugin Release JSON 诊断、会话候选和同目录原子激活；现有 Portal API 只增加两个插件作用域端点。React 在 Hub 条目旁提供一个本机专用发布对话框，9135 继续由既有只读门禁隐藏并拒绝写入。

**Tech Stack:** Python 3.12 标准库、React 19、TypeScript、Vitest、unittest、Playwright。

**Spec:** `docs/superpowers/specs/2026-08-30-portal-plugin-release-download-publishing-design.md`

## Global Constraints

- 不生成候选、不修改市场源码、不安装插件，不重启或配置 9134、9135。
- 只接受当前活动快照完全相同的 `target/pluginId/version`。
- ZIP 上限固定 128 MiB；同名正式文件拒绝覆盖。
- 候选绝对路径、原始命令输出和异常细节不得进入浏览器回应或发布回执。
- Plugin Release 非零退出或候选检查失败时阻断；成功的 `issues_found` 只转为警告。
- 9135 不显示入口，且在执行选择器或审计器前拒绝发布 POST。
- 未取得另行授权前不 commit、不 push、不发布运行服务。

---

### Task 1: 候选选择与 Plugin Release 审计 RED→GREEN

**Files:**

- Create: `plugin_portal/download_publication.py`
- Modify: `plugin_portal/directory_picker.py`
- Create: `tests/test_download_publication.py`
- Modify: `tests/test_directory_picker.py`

**Interfaces:**

- Produces: `choose_plugin_archive() -> Path | None`
- Produces: `PluginReleaseAuditor.audit(path: Path, plugin_id: str, target: str, expected_sha256: str) -> PluginReleaseAudit`
- Produces: `DownloadPublisher.preview(path: Path, plugin_key: str, expected_version: str) -> PublicationCandidate`

- [x] **Step 1: Write the failing archive-picker tests**

  Add tests proving cancellation returns `None`, a selected ordinary `.zip` is returned, and non-ZIP/reparse selections are rejected without exposing subprocess stderr.

- [x] **Step 2: Run the picker tests and verify RED**

  Run: `python -B -m unittest tests.test_directory_picker -v`

  Expected: FAIL because `choose_plugin_archive` does not exist.

- [x] **Step 3: Implement the minimal Windows file picker**

  Reuse the existing hidden STA PowerShell runner, but use `OpenFileDialog`, a ZIP filter and ordinary-file validation. Do not add a browser-supplied path API.

- [x] **Step 4: Write failing real-boundary audit tests**

  Create temporary `codex` and `release.py` executables that emit literal Plugin Release 1.0.1 JSON. Assert that the production auditor:

  ```python
  audit = auditor.audit(candidate, "sample-plugin", "company-dev", "a" * 64)
  self.assertEqual(audit.plugin_id, "sample-plugin")
  self.assertEqual(audit.version, "1.2.3")
  self.assertEqual(audit.warnings, ("市场源码与候选不一致",))
  ```

  Also assert nonzero exit, malformed JSON, wrong schema/tool/operation, digest mismatch and failed candidate check are rejected.

- [x] **Step 5: Run the audit tests and verify RED**

  Run: `python -B -m unittest tests.test_download_publication.PluginReleaseAuditorTests -v`

  Expected: FAIL because the audit module does not exist.

- [x] **Step 6: Implement the minimal auditor and preview model**

  Discover only the enabled `plugin-release@company-dev` version from native JSON, validate its installed-cache script and manifest, invoke `diagnose` with the Portal-computed digest, and map only closed public fields into immutable dataclasses.

- [x] **Step 7: Run focused Python tests and keep them GREEN**

  Run: `python -B -m unittest tests.test_directory_picker tests.test_download_publication.PluginReleaseAuditorTests -v`

### Task 2: 原子发布与恢复 RED→GREEN

**Files:**

- Modify: `plugin_portal/download_publication.py`
- Modify: `tests/test_download_publication.py`

**Interfaces:**

- Consumes: `PublicationCandidate`
- Produces: `DownloadPublisher.publish(candidate: PublicationCandidate) -> PublicationReceipt`

- [x] **Step 1: Write failing publication tests**

  Use real temporary files and directories. Cover literal outcomes for: successful same-directory activation, source digest change, 128 MiB overflow, destination exists, staged hash mismatch, HEAD/GET readback mismatch, and post-activation quarantine.

- [x] **Step 2: Run tests and verify RED**

  Run: `python -B -m unittest tests.test_download_publication.DownloadPublisherTests -v`

  Expected: FAIL because `publish` is absent.

- [x] **Step 3: Implement the minimal two-phase publisher**

  Stream hash and copy in 1 MiB chunks, `flush` plus `os.fsync`, activate with a same-directory no-overwrite operation, then stream HEAD/GET from 9134. Store an immutable receipt under `PortalStore.root/download-publications`; never store the source path.

- [x] **Step 4: Verify GREEN and inspect leftovers**

  Run: `python -B -m unittest tests.test_download_publication -v`

  Expected: all tests pass and no `.partial` remains after any handled branch.

### Task 3: 会话 API RED→GREEN

**Files:**

- Modify: `plugin_portal/api.py`
- Modify: `plugin_portal/server.py`
- Modify: `tests/test_api.py`
- Modify: `tests/test_server.py`
- Modify: `tests/test_lan_server.py`

**Interfaces:**

- Produces: `POST /api/plugins/{pluginKey}/download-publication/select` with `{}`
- Produces: `POST /api/plugins/{pluginKey}/download-publication/confirm` with `{"publicationId":"..."}`

- [x] **Step 1: Write failing API and server tests**

  Assert selected candidates remain session-scoped, route identity/version are checked, the preview leaks no path, confirm cannot cross sessions, success consumes the candidate, and read-only mode rejects both endpoints before picker/auditor calls.

- [x] **Step 2: Run tests and verify RED**

  Run: `python -B -m unittest tests.test_api tests.test_server tests.test_lan_server -v`

- [x] **Step 3: Add the two smallest API methods and routes**

  Reuse the existing session dictionary with explicit candidate kind tags. Inject picker/publisher dependencies through `PortalApi` and `create_server`; do not add global mutable state or a second session system.

- [x] **Step 4: Run focused tests and keep them GREEN**

  Run: `python -B -m unittest tests.test_api tests.test_server tests.test_lan_server -v`

### Task 4: Hub 发布对话框 RED→GREEN

**Files:**

- Create: `src/portal/DownloadPublisher.tsx`
- Create: `src/portal/DownloadPublisher.test.tsx`
- Modify: `src/portal/types.ts`
- Modify: `src/portal/api.ts`
- Modify: `src/portal/api.test.ts`
- Modify: `src/hub/HubEntry.tsx`
- Modify: `src/hub/HubEntry.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**

- Produces: `selectDownloadCandidate(pluginKey)` and `confirmDownloadPublication(pluginKey, publicationId)` on `PortalClient`
- Produces: local-only Hub action with an accessible modal and focus restoration

- [x] **Step 1: Write failing client and component tests**

  Lock closed response validation, no path field, local-only buttons, candidate detail rendering, confirmation, safe errors, Escape close and focus restoration. Assert 9135/read-only rendering has no publication control.

- [x] **Step 2: Run tests and verify RED**

  Run: `npm test -- --run src/portal/api.test.ts src/portal/DownloadPublisher.test.tsx src/hub/HubEntry.test.tsx`

- [x] **Step 3: Implement the minimal UI**

  Convert each Hub row from a nested interactive anchor into a row containing one overview link and one local publication button. Keep the existing plugin icon, theme action and inclusion dialog unchanged.

- [x] **Step 4: Run focused tests, typecheck and build**

  Run: `npm test -- --run src/portal/api.test.ts src/portal/DownloadPublisher.test.tsx src/hub/HubEntry.test.tsx`

  Run: `npm run typecheck`

  Run: `npm run build`

### Task 5: 浏览器证据与完整验证

**Files:**

- Modify: `e2e/testServer.ts`
- Modify: `e2e/portal.spec.ts`
- Modify: `e2e/lan.spec.ts`
- Modify: `README.md`

**Interfaces:**

- Consumes: the two publication endpoints and Hub dialog
- Produces: controlled browser evidence without touching live 9134/9135/9137

- [x] **Step 1: Add failing browser coverage**

  Extend the test server with a temporary download root and deterministic auditor. Assert local publication succeeds, the exact download becomes available, no absolute path appears, and LAN still has no action and returns `403 read_only` for both endpoints.

- [x] **Step 2: Run the focused Playwright tests and verify RED**

  Run: `npx playwright test e2e/portal.spec.ts e2e/lan.spec.ts --workers=1`

- [x] **Step 3: Add only the required test-server wiring and operator documentation**

  Document that target plugins still create their own candidate ZIP, Portal refuses overwrite, and Plugin Release candidate failures must be fixed at the candidate or auditor rather than bypassed.

- [x] **Step 4: Run complete fresh verification**

  Run: `python -B -m unittest discover -s tests -v`

  Run: `npm test -- --run`

  Run: `npm run typecheck`

  Run: `npm run build`

  Run: `npx playwright test --workers=1`

  Run: `git diff --check`

  Scan tracked changes for personal absolute paths, credentials, tokens, private keys, `.partial` files and debug output. Review `git status --short` and the complete diff. Do not commit, push or publish without separate authorization.
