# Plugin Portal MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan.

**Goal:** 建立一个个人本机使用、公开源码、固定界面且按插件隔离资料的多插件只读 Portal，首批支持人工纳入研发助手插件与昱勝 Inc。

**Architecture:** React/TypeScript/Vite 负责固定页面、插件切换和表单交互；Python 标准库服务只绑定 loopback，负责安全读取插件公开文件、生成不可变快照及原子维护 Portal 自有 JSON。浏览器永远只接触封闭 API 数据，不接触插件绝对路径，也不执行插件代码。

**Tech Stack:** React 19、TypeScript、Vite、Vitest、Testing Library、Playwright、Python 3 标准库、`unittest`。

**Approved spec:** `docs/superpowers/specs/2026-08-25-plugin-portal-design.md`

**Global constraints:**

- 固定菜单为鸟瞰全景、Skills、Prompts、MCP、扩展工具、工程规范、版本沿革。
- 插件身份使用 `target/pluginId`，所有 Portal 自有数据按完整身份隔离。
- 只人工纳入、人工刷新；导入预览不得改变活动快照。
- 插件只提供只读公开资料；Prompts 和鸟瞰全景流程由 Portal 用户拥有。
- 工程规范只接受人工批准的相对 Markdown 路径，不推导层级或类别。
- 流程配置只包含 Tab、区域、步骤与显式 `next`；禁止 CSS、HTML 和脚本。
- 本地数据位于仓库外；仓库、日志、API 与浏览器不得泄露插件绝对路径或私密值。
- 开发验证只使用 OS 临时数据目录与 test-only loopback 临时端口；在明确部署前不占用 9137。

---

### Task 1: 建立可运行的 Portal 外壳

**Files:**

- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/main.tsx`
- Create: `src/App.tsx`
- Create: `src/App.test.tsx`
- Create: `src/portal/routes.ts`
- Create: `src/portal/routes.test.ts`
- Create: `src/styles.css`

**Step 1: Write the failing route and shell tests**

Lock the fixed menu, plugin-scoped route normalization, page-specific empty copy, and the absence of plugin-derived components. The core route API is:

```ts
export type PortalPage =
  | "overview"
  | "skills"
  | "prompts"
  | "mcp"
  | "extensions"
  | "rules"
  | "releases";

export function parsePortalRoute(hash: string, pluginIds: string[]): PortalRoute;
export function portalHref(pluginId: string, page: PortalPage): string;
```

**Step 2: Run tests to verify RED**

Run: `npm test -- --run src/portal/routes.test.ts src/App.test.tsx`

Expected: FAIL because the application and route parser do not exist.

**Step 3: Implement the minimal fixed shell**

Render one product header, plugin selector, seven fixed navigation items, and page-specific empty states from Portal-owned constants. Do not add plugin adapters or infer menu visibility.

**Step 4: Run focused and type checks**

Run: `npm test -- --run src/portal/routes.test.ts src/App.test.tsx`

Run: `npm run typecheck`

Expected: PASS.

**Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts index.html src
git commit -m "feat: establish plugin portal shell"
```

### Task 2: 建立封闭模型与仓库外原子存储

**Files:**

- Create: `plugin_portal/__init__.py`
- Create: `plugin_portal/models.py`
- Create: `plugin_portal/storage.py`
- Create: `tests/test_models.py`
- Create: `tests/test_storage.py`

**Step 1: Write failing model and storage tests**

Cover exact plugin identity, closed JSON shapes, monotonic revision, atomic replace, stale revision rejection, failed-write preservation, immutable snapshot names, and separation of two plugin keys.

```python
class RevisionConflict(ValueError):
    pass

class PortalStore:
    def read_document(self, name: str) -> dict: ...
    def write_document(self, name: str, value: dict, expected_revision: int) -> dict: ...
    def put_snapshot(self, plugin_key: str, snapshot: dict) -> str: ...
```

**Step 2: Run tests to verify RED**

Run: `python -m unittest tests.test_models tests.test_storage -v`

Expected: FAIL because the package does not exist.

**Step 3: Implement validation and atomic writes**

Use `tempfile` in the destination directory, flush plus `os.fsync`, `os.replace`, and a directory-local lock. Reject unknown keys instead of silently dropping them. Snapshot IDs are SHA-256 of canonical UTF-8 JSON bytes.

**Step 4: Run focused tests**

Run: `python -m unittest tests.test_models tests.test_storage -v`

Expected: PASS.

**Step 5: Commit**

```bash
git add plugin_portal tests/test_models.py tests/test_storage.py
git commit -m "feat: add atomic portal storage"
```

### Task 3: 实现安全的通用插件预览与快照

**Files:**

- Create: `plugin_portal/plugin_reader.py`
- Create: `plugin_portal/public_text.py`
- Create: `tests/test_plugin_reader.py`
- Create: `tests/fixtures/plugins/minimal/.codex-plugin/plugin.json`
- Create: `tests/fixtures/plugins/minimal/skills/sample/SKILL.md`
- Create: `tests/fixtures/plugins/minimal/.mcp.json`

**Step 1: Write failing importer tests**

Cover plugin identity, version and public summary; Skill name/description only; MCP service ID only; manually approved extension links and rule paths; absolute path, `..`, symlink/reparse, non-Markdown, embedded HTML, unsafe link, secret assignment and private path rejection. Assert `command`, `args`, `env` and source root never occur in serialized snapshots.

```python
def preview_plugin(
    plugin_root: Path,
    *,
    target: str,
    approved_rule_paths: list[str],
    extension_tools: list[dict],
) -> dict: ...
```

**Step 2: Run tests to verify RED**

Run: `python -m unittest tests.test_plugin_reader -v`

Expected: FAIL because the reader does not exist.

**Step 3: Implement no-follow relative reads and public projection**

Resolve and validate every path component before reading. Parse only the small public front matter subset needed for names and descriptions. Never import a plugin module or execute a plugin file.

**Step 4: Run focused tests and a repository secret/path scan**

Run: `python -m unittest tests.test_plugin_reader -v`

Run: `rg -n "C:\\\\Users|token\s*=|password\s*=|cookie\s*=" --glob "!package-lock.json" .`

Expected: tests PASS; scan has no product-data hit.

**Step 5: Commit**

```bash
git add plugin_portal tests
git commit -m "feat: project public plugin snapshots"
```

### Task 4: 提供 loopback API、会话令牌与预览提升流程

**Files:**

- Create: `plugin_portal/server.py`
- Create: `plugin_portal/api.py`
- Create: `tests/test_api.py`
- Create: `tests/test_server.py`

**Step 1: Write failing API tests**

Cover loopback-only host validation, disabled CORS, session token, expected revision, preview without mutation, explicit promote, rollback, source disappearance after import, plugin-ID mismatch, and redacted error responses.

```python
def create_server(*, host: str, port: int, data_root: Path, web_root: Path): ...
```

Production mode accepts only `127.0.0.1:9137`; tests explicitly opt into `port=0`. Static file serving must be no-follow and must not expose directory listings.

**Step 2: Run tests to verify RED**

Run: `python -m unittest tests.test_api tests.test_server -v`

Expected: FAIL because the server does not exist.

**Step 3: Implement minimal JSON API and static server**

Keep preview candidates session-scoped. Promote only a candidate generated by the same session and matching current revision. Return public error codes and Chinese messages without raw exception text.

**Step 4: Run focused tests**

Run: `python -m unittest tests.test_api tests.test_server -v`

Expected: PASS.

**Step 5: Commit**

```bash
git add plugin_portal tests/test_api.py tests/test_server.py
git commit -m "feat: add loopback portal api"
```

### Task 5: 实现按插件隔离的 Prompts 与流程配置

**Files:**

- Create: `plugin_portal/prompts.py`
- Create: `plugin_portal/workflows.py`
- Create: `tests/test_prompts.py`
- Create: `tests/test_workflows.py`

**Step 1: Write failing domain tests**

Prompts tests cover CRUD, full plugin-key isolation, hidden-plugin preservation, revision conflicts and closed shape. Workflow tests cover Tab/section/step ordering, duplicate IDs, unknown edges, no entry, unreachable nodes, cycles, valid serial flow, valid fork and merge.

```python
def validate_workflow(document: dict, *, expected_plugin_key: str) -> dict: ...
```

**Step 2: Run tests to verify RED**

Run: `python -m unittest tests.test_prompts tests.test_workflows -v`

Expected: FAIL because the domain modules do not exist.

**Step 3: Implement closed validators and store adapters**

Reject any CSS, HTML or script keys. Preserve explicit order from JSON arrays. Validate the graph with deterministic entry, reachability and cycle checks.

**Step 4: Run focused tests**

Run: `python -m unittest tests.test_prompts tests.test_workflows -v`

Expected: PASS.

**Step 5: Commit**

```bash
git add plugin_portal tests/test_prompts.py tests/test_workflows.py
git commit -m "feat: isolate prompts and workflows"
```

### Task 6: 接入真实数据页面与表单编辑器

**Files:**

- Create: `src/portal/types.ts`
- Create: `src/portal/api.ts`
- Create: `src/portal/api.test.ts`
- Create: `src/portal/PortalShell.tsx`
- Create: `src/portal/PortalShell.test.tsx`
- Create: `src/portal/views/OverviewView.tsx`
- Create: `src/portal/views/SkillsView.tsx`
- Create: `src/portal/views/PromptsView.tsx`
- Create: `src/portal/views/McpView.tsx`
- Create: `src/portal/views/ExtensionsView.tsx`
- Create: `src/portal/views/RulesView.tsx`
- Create: `src/portal/views/ReleasesView.tsx`
- Create: `src/portal/views/PortalViews.test.tsx`
- Create: `src/portal/workflows/WorkflowEditor.tsx`
- Create: `src/portal/workflows/WorkflowGraph.tsx`
- Create: `src/portal/workflows/WorkflowEditor.test.tsx`

**Step 1: Write failing UI tests**

Cover two-plugin switching, URL isolation, page-specific empty states, snapshot data, Prompt CRUD with revision, safe rule body rendering, workflow Tab/section/step editing, explicit next selection, preview, validation messages and no plugin-provided markup execution.

**Step 2: Run tests to verify RED**

Run: `npm test -- --run src/portal`

Expected: FAIL because the data views do not exist.

**Step 3: Implement API-backed views**

The frontend validates closed response shapes but does not duplicate plugin-specific IDs or maps. Use text nodes for public copy. Render the approved Markdown subset without raw HTML.

**Step 4: Run frontend tests and type checks**

Run: `npm test -- --run`

Run: `npm run typecheck`

Expected: PASS.

**Step 5: Commit**

```bash
git add src
git commit -m "feat: render isolated plugin content"
```

### Task 7: 完成端到端、安全与启动契约

**Files:**

- Create: `playwright.config.ts`
- Create: `e2e/portal.spec.ts`
- Create: `scripts/start.ps1`
- Create: `tests/test_public_repository.py`
- Modify: `README.md`

**Step 1: Write failing browser and hygiene tests**

Use OS-temp data and a test-only `port=0` server. Cover manual import preview/promote/rollback, two-plugin URL switching, prompts/workflows isolation, all fixed menus, empty states, keyboard navigation, 768/1120/1600 widths, no horizontal overflow, no console errors, and repository exclusion of personal/runtime data.

**Step 2: Run tests to verify RED**

Run: `npm run test:e2e`

Run: `python -m unittest tests.test_public_repository -v`

Expected: FAIL before the harness and documented start contract exist.

**Step 3: Implement the local start contract and user documentation**

`scripts/start.ps1` may start only `127.0.0.1:9137`, fails closed when occupied, verifies built assets and data root, and prints a public readiness message without absolute plugin paths. Do not register a service, task, IIS binding or firewall rule.

**Step 4: Run the complete verification matrix**

Run: `python -m unittest discover -s tests -v`

Run: `npm test -- --run`

Run: `npm run typecheck`

Run: `npm run build`

Run: `npm run test:e2e`

Run: `git diff --check`

Expected: all PASS, with no listener left on 9137 and no generated runtime data tracked by Git.

**Step 5: Commit**

```bash
git add README.md playwright.config.ts e2e scripts tests/test_public_repository.py
git commit -m "test: verify plugin portal mvp"
```

### Task 8: Final source review and delivery

**Files:**

- Verify all files changed from `main`

**Step 1: Inspect the complete branch**

Run: `git diff --stat main...HEAD`

Run: `git diff --check main...HEAD`

Run: `git status --short`

Expected: only planned source/test/docs paths, no runtime data, clean worktree.

**Step 2: Re-run focused security probes**

Mutate fixtures with traversal, absolute paths, symlinks/reparse points, MCP command/env, secrets, stale revisions, invalid workflow edges and plugin identity mismatches. Confirm every case fails closed without leaking source paths.

**Step 3: Push the feature branch and read it back**

```bash
git push -u origin feature/plugin-portal-mvp
git ls-remote origin refs/heads/feature/plugin-portal-mvp
```

Expected: remote SHA equals local immutable HEAD. Do not merge or create a release without separate user authorization.
