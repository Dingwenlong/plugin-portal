# Plugin Portal Legacy Migration and Plugin Shell Implementation Plan

> **For agentic workers:** Execute in this worktree with test-driven development. Do not modify the running 9137 data until source verification is complete.

**Goal:** 一次性迁移研发助手旧 Portal 资料，并把插件站点收敛为无切换、无管理入口的单插件阅读空间。

**Architecture:** Python 迁移器只从 loopback 旧 Portal 读取并转换为当前封闭模型；所有候选先校验再写入 Portal 自有存储。React 保持固定插件页面，由 Hub 承担插件管理，Prompt 与流程编辑统一使用可访问模态框。封面使用经过网络来源与许可核对的 XorDev Blackhole shader，本地适配并随构建打包，不产生运行时远端依赖。

**Approved spec:** `docs/superpowers/specs/2026-08-26-plugin-portal-legacy-migration-and-plugin-shell.md`

### Task 1: 锁定模型升级与迁移 RED

**Files:**

- Modify: `plugin_portal/prompts.py`
- Create: `plugin_portal/legacy_migration.py`
- Modify: `plugin_portal/plugin_reader.py`
- Modify: `plugin_portal/storage.py`
- Modify: `plugin_portal/__main__.py`
- Modify: `tests/test_prompts.py`
- Create: `tests/test_legacy_migration.py`
- Modify: `tests/test_plugin_reader.py`
- Modify: `tests/test_storage.py`

1. 先写 Prompt `scenario/content/createdAt` closed-shape RED。
2. 用本地 fixture HTTP server 写 5 Prompt、4 Tab、7 工具、Skill 白名单转换 RED。
3. 锁定非 loopback、超限、结构漂移、目标冲突、重复应用与失败保留。
4. 实现最小迁移器、原子存储和 CLI preview/apply。
5. 运行 focused Python tests。

### Task 2: 锁定插件站点导航 RED

**Files:**

- Modify: `src/portal/PortalShell.tsx`
- Modify: `src/portal/PortalShell.test.tsx`
- Modify: `src/portal/routes.ts`
- Modify: `src/portal/routes.test.ts`
- Modify: `src/styles.css`
- Modify: `e2e/portal.spec.ts`

1. 先断言插件页没有 selector、技术 ID 和管理按钮。
2. 断言插件名链接概览、菜单不含鸟瞰全景、Hub 管理入口仍存在。
3. 最小修改 Shell 与样式。
4. 运行 focused Vitest 和 typecheck。

### Task 3: Prompt 模态框 RED→GREEN

**Files:**

- Modify: `src/portal/types.ts`
- Modify: `src/portal/api.ts`
- Modify: `src/portal/api.test.ts`
- Modify: `src/portal/views/PortalViews.tsx`
- Modify: `src/portal/views/PortalViews.test.tsx`
- Modify: `src/styles.css`
- Modify: `e2e/portal.spec.ts`

1. 锁定旧版四列表格和新增/编辑模态框。
2. 锁定新增时间、编辑保留时间、删除、Escape、焦点恢复和错误显示。
3. 最小实现并保持插件隔离。
4. 运行 focused Vitest 和 typecheck。

### Task 4: 流程三级级联模态框 RED→GREEN

**Files:**

- Modify: `src/portal/PortalShell.tsx`
- Modify: `src/portal/workflows/WorkflowEditor.tsx`
- Modify: `src/portal/workflows/WorkflowEditor.test.tsx`
- Modify: `src/styles.css`
- Modify: `e2e/portal.spec.ts`

1. 锁定模态框、Tab/区域/步骤三级单路径显示。
2. 锁定新增、删除、排序、连线、预览、保存与取消。
3. 保留既有 workflow JSON 与服务端图校验。
4. 运行 focused Vitest 和 typecheck。

### Task 5: 网络来源封面 RED→GREEN

**Files:**

- Modify: `src/hub/CoverAccretionFieldShader.ts`
- Modify: `src/hub/CoverAccretionFieldShader.test.ts`
- Create: `THIRD_PARTY-NOTICE-XorDev-blackhole.txt`
- Modify: `README.md`
- Modify: `e2e/portal.spec.ts`

1. 锁定作者、来源 URL、CC BY-NC-SA 4.0 与适配说明。
2. 用 XorDev Blackhole 原始表达式建立 WebGL 1 本地适配，不复制远端运行时依赖。
3. 锁定 `/#/` canvas 就绪、Start 转场不变、页面不发起远端请求。
4. 真实浏览器检查视觉结果、离线运行和 WebGL 降级。

### Task 6: 完整验证与本机迁移

1. `python -m unittest discover -s tests -v`
2. `npm test -- --run`
3. `npm run typecheck`
4. `npm run build`
5. 在 OS 临时 data root 运行迁移 preview/apply/repeat，并检查数量与摘要。
6. `npx playwright test --workers=1`
7. `git diff --check` 与敏感资料/绝对路径扫描。
8. 提交源码候选并合并 main。
9. 对真实 data root 先 preview，再 apply；回读 5 Prompt、4 Tab、7 工具和技能可见性。
10. 重启 9137，真实浏览器回读 Hub、两个插件、Prompt 和流程页面。
