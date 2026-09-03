# Portal 下载包审计发布设计

## 目标与边界

本设计让本机管理 Portal（`127.0.0.1:9137`）可以把一个已经由目标插件自身流程生成的候选 ZIP 发布到现有 9134 下载目录。Portal 不生成候选、不修改插件市场源码、不安装插件，也不重启或配置 9134、9135。局域网 HTTPS Portal（9135）继续保持只读，不展示发布入口且拒绝所有写请求。

Plugin Release 只承担候选 ZIP 的只读审计。目标插件继续拥有版本、候选生成、Git、PR 和正式市场发布职责；Portal 只是把用户明确选择并确认的现成字节复制到下载分发目录。

## 最小交互

本机 Hub 的每个插件条目增加“发布下载”按钮。点击后打开一个独立对话框：

1. 用户通过 Windows 文件选择器选择一个 ZIP，浏览器不能提交任意本机路径。
2. 后端立即计算 SHA-256，并调用当前已安装且启用的 Plugin Release `diagnose`。
3. 页面只显示文件名、目标文件名、插件 ID、版本、大小、候选摘要、文件集摘要和审计警告，不返回候选绝对路径。
4. 只有候选结构有效且身份、版本与 Portal 当前活动快照完全一致时，才显示“确认发布”。
5. 用户二次确认后，后端重新核对同一源文件和摘要，再执行原子发布与 9134 回读。

发布成功后保留结果供用户核对；关闭对话框不会改动插件目录或公开快照。9135 不渲染该按钮；直接调用发布 API 时，服务器只丢弃受既有大小上限约束的原始请求体，不解析 JSON，并在执行文件选择器或审计器之前拒绝。

人工纳入或刷新插件成功时，Portal 重读目录并递增目录修订号。Hub 与插件 Header 的图标请求把该修订号作为缓存键；即使 React 复用既有插件条目，先前失败或已缓存的图标也会重新读取，不使用整页重载。

## Plugin Release 联动契约

Portal 通过 `codex plugin list --marketplace company-dev --json` 解析当前启用的 `plugin-release@company-dev` 版本，只执行对应安装缓存中的 `scripts/release.py diagnose`。运行参数固定包含：

```text
--candidate <selected.zip>
--plugin-id <active plugin id>
--target <active target>
--expected-candidate-sha256 <portal-computed sha256>
```

只接受 `schemaVersion=1.0.0`、`tool=plugin-release`、`operation=diagnose` 的 JSON。退出码非零、输出不可解析、候选检查未通过、候选摘要不一致或身份不一致均为硬失败。

Plugin Release 的整体 `status=issues_found` 不自动阻断下载发布：该状态也用于表达市场源码、本机安装或原生回读与候选不一致。只要命令成功、候选检查通过且候选摘要与身份完全一致，其他检查转换为页面警告，由用户在二次确认前看到。这样既使用 Plugin Release 的候选安全审计，又不把本机安装状态误当成目标插件的发布门禁。

现有 9134 文件不做追溯重审。已经可下载的包继续可用；同一包以后重新走发布流程时必须通过当前审计。现场验证发现现有 `project-delivery-hub-3.7.17-company-dev.zip` 会被 Plugin Release 以 `private_material_detected` 拒绝，因此该字节不能通过新的发布入口重新发布，除非目标插件候选或审计误报另行修正。

## 原子发布与恢复

发布文件名固定为：

```text
<pluginId>-<version>-<target>.zip
```

候选与下载代理统一使用 128 MiB 上限。下载目录必须已经存在、是普通目录且不是链接或 reparse point；Portal 不创建或重配 9134 根目录。同名最终文件一律拒绝覆盖，避免改变已经公开的不可变版本字节。

确认发布时，后端重新打开候选并核对文件身份、长度和 SHA-256。随后在下载目录内创建唯一 `.partial` 文件，分块复制、同步文件内容并核对暂存摘要，再使用同目录硬链接完成无覆盖原子激活并删除暂存名。激活后通过 `127.0.0.1:9134` 执行 HEAD 和分块 GET，验证状态、MIME、长度及 SHA-256。

若激活后的回读失败，只移动本次精确新文件到同目录不可下载扩展名的随机隔离文件，并再次确认正式 URL 不可用；不删除旧包、不触碰其他文件。成功回读后，在 Portal 私有数据目录写入不可变审计回执，记录插件键、版本、目标文件名、候选摘要、文件集摘要、字节数、Plugin Release 版本和发布时间，不记录候选绝对路径或命令输出。

## 会话与错误边界

候选路径、文件身份和完整审计结果只保存在当前内存会话，以随机 `publicationId` 绑定。确认 API 必须使用创建候选的同一 `X-Portal-Session`，并再次核对路由插件键。会话失效、服务重启或确认成功后，候选都不能复用。

浏览器只接收封闭 JSON。Plugin Release 的原始 stdout、stderr、绝对路径和异常细节不返回页面；候选拒绝只公开经过映射的错误代码和安全消息。所有发布 POST 继续受同源检查、1 MiB 请求体上限和本机 9137 绑定约束。

## 验证

- Python 单测覆盖选择取消、Plugin Release 成功/拒绝/畸形输出、`issues_found` 警告、身份版本不符、128 MiB 上限、会话隔离、确认前源文件变化、同名拒绝、原子激活、9134 回读和失败隔离。
- React 测试覆盖本机发布入口、9135 隐藏、候选预览、二次确认、错误与成功状态、Escape 和焦点恢复。
- Playwright 使用测试服务中的受控候选和审计器，验证真实 Hub 操作、无路径泄露、只读拒绝以及成功后下载按钮可用。
- 完整运行 Python、Vitest、TypeScript、隔离 Vite build 和 Playwright，并执行 `git diff --check`、绝对路径和敏感资料扫描。
