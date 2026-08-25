# Plugin Portal

面向个人本机使用的多插件只读门户。Portal 拥有固定页面与独立发布周期，人工纳入插件并生成经过校验的公开资料快照；插件不依赖 Portal，Portal 也不修改或执行插件代码。

当前 MVP 已提供固定七页、多插件切换、只读公开快照、按插件隔离的 Prompts 与鸟瞰全景流程配置。已确认的架构见：

- [多插件只读 Portal 设计](docs/superpowers/specs/2026-08-25-plugin-portal-design.md)

本仓库公开，但个人 Prompts、流程配置、插件路径、插件快照和其他本机资料不得提交。

## 本机运行

需要 Node.js、npm、Python 3.11 或更新版本。先构建，再启动：

```powershell
npm ci
npm run build
.\scripts\start.ps1
```

启动脚本只允许监听 `127.0.0.1:9137`。如果端口已占用会直接停止，不会自动换端口；脚本在独立 GET/HEAD 回读和首页哈希比对通过后才报告就绪。运行资料默认写入 `%LOCALAPPDATA%\plugin-portal\data`，不会写进仓库。

打开 [http://127.0.0.1:9137/](http://127.0.0.1:9137/)。

## 资料边界

- 插件必须由用户人工纳入或人工刷新，不做目录扫描和在线状态推断。
- 浏览器只读取 Portal 已提升的不可变公开快照，不直接访问插件目录。
- Skills 只显示公开名称与说明；MCP 只显示服务 ID；不会保存 command、args、env 或凭证。
- 工程规范只读取用户批准的插件内相对 Markdown 路径，并在 Portal 内以纯文本安全渲染。
- Prompts 与鸟瞰全景流程归 Portal 用户所有，按完整插件身份隔离。
- 插件导入候选、个人 Prompts、流程和服务日志只位于本机数据目录。

页面右上角的“管理插件”用于预览刷新、确认切换和回滚；尚无插件时，首页直接显示人工纳入表单。所有变更仍通过同一套本机 loopback API、会话令牌与 revision 门禁完成。
