# Plugin Portal

面向个人与可信局域网使用的多插件门户。Portal 拥有固定页面与独立发布周期，人工纳入插件并生成经过校验的公开资料快照；插件不依赖 Portal，Portal 也不修改或执行插件代码。

当前 MVP 已提供固定七页、多插件目录与单插件阅读空间、只读公开快照、按插件隔离的 Prompts 与鸟瞰全景流程配置。已确认的架构见：

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

## 局域网访问模式

本机管理仍只监听 `127.0.0.1:9137`。可信局域网需要跨网段纳入插件、编辑 Prompt、配置流程或发布下载时，可以另启 9135 远程管理模式。它不提供登录验证，也不按来源 IP 做应用层授权；必须只在受控内网和防火墙边界内开放，禁止映射到公网。

远程管理不接收服务器文件路径。插件纳入和下载候选均使用浏览器上传 ZIP，后端只处理当前浏览器会话上传的临时文件，并继续执行大小、ZIP 结构、版本、Plugin Release 审计和发布回读门禁。

```powershell
# 先只读确认现有 Caddy、构建和数据目录，再启动 loopback 后端。
.\scripts\start-remote-management.ps1 -Address <本机局域网IPv4> -CheckOnly
.\scripts\start-remote-management.ps1 -Address <本机局域网IPv4>

# 等价的后端命令；生产环境仍应由脚本完成 PID、哈希和访问模式回读。
python -m plugin_portal serve --remote-management --host 127.0.0.1 --port 9135 --https-origin https://<本机局域网IPv4>:9135 --data-root <资料目录> --web-root <构建目录>
```

- 胶囊与 Hub 的管理按钮在远程管理模式全部开放；目录选择改为浏览器文件选择，不泄露服务端路径。
- 服务只信任精确的 HTTPS Origin 与 Host；跨 Origin 请求、转发头伪造和非预期 Host 均拒绝。
- 启动脚本只启动它自己的 Python loopback 后端，不修改或停止 Caddy，不修改防火墙、系统服务、开机任务，也不操作 9134、9136、9137。
- Caddy 必须继续只监听明确的内网 IPv4、关闭管理端口，并反向代理到 `127.0.0.1:9135`。若现有只读配置含以下写入阻断器，启用远程管理前只移除这两行；其余 TLS、Host 与兜底拒绝规则保留：

```caddyfile
@writes not method GET HEAD
respond @writes 403
```

没有企业证书时可使用 Caddy 内部 CA；访问设备需人工信任公开根证书。CA 私钥只保存在受限的运行目录，不进入仓库、静态目录或共享包。生产切换必须先在非生效端口验证证书链、GET/HEAD、首页哈希、访问模式、上传及回滚路径，再按独立发布授权切换。

### 可选只读模式

只需分享内容时，仍可使用 `--read-only` 或 `scripts/start-lan.ps1`。该模式隐藏纳入、编辑、流程配置与发布入口，并在后端拒绝所有写请求：

```powershell
.\scripts\start-lan.ps1 -Address <本机局域网IPv4> -CheckOnly
.\scripts\start-lan.ps1 -Address <本机局域网IPv4>
```

只读和远程管理是互斥的显式模式；不得同时传入 `--read-only` 与 `--remote-management`。

## 资料边界

- 插件必须由用户人工纳入或人工刷新，不做目录扫描和在线状态推断。
- 浏览器只读取 Portal 已提升的不可变公开快照，不直接访问插件目录。
- Skills 只显示公开名称与说明；MCP 默认只显示服务 ID，也可读取插件提供的可选 `.mcp.public.json`，展示名称、用途、能力和是否包含写入操作；不会保存 command、args、env 或凭证。
- 工程规范只读取用户批准的插件内相对 Markdown 路径，并在 Portal 内以纯文本安全渲染。
- Prompts 与鸟瞰全景流程归 Portal 用户所有，按完整插件身份隔离。
- 插件导入候选、个人 Prompts、流程和服务日志只位于本机数据目录。

插件需要补充 MCP 公开说明时，可在插件根目录加入：

```json
{
  "mcpServers": {
    "vmp-mcp": {
      "name": "VMP 工单服务",
      "purpose": "查询问题单、分析记录与关联待办。",
      "capabilities": ["查询问题资料", "读取关联待办", "更新处理状态"],
      "writeEnabled": true
    }
  }
}
```

文件中的服务 ID 必须已存在于 `.mcp.json`。Portal 只导入上述封闭字段；文件缺失或某个服务没有对应说明时，该服务继续只显示 ID。

根地址保留背景与 Start 入口，进入 `/#/hub` 后可纳入、刷新或回滚插件。插件站点只显示当前插件内容，不提供插件切换或管理入口。点击“选择插件目录”会打开 Windows 目录选择窗口，并从插件清单自动识别名称、ID 与版本；发布者、规范路径和扩展工具位于可选的高级区域。所有变更仍通过同一套本机 loopback API、会话令牌与 revision 门禁完成。

纳入或刷新成功后，Hub 目录会立即重读；插件图标 URL 同步绑定新的目录修订号，因此既有条目也会重新读取图标，无需手动刷新页面。

## 发布下载包

本机 Hub 的插件条目提供“发布下载”。它只分发现成候选，不替插件生成 ZIP：

1. 先按目标插件自身的发布流程生成候选 ZIP，并保证版本与 Portal 当前活动快照一致。
2. 点击“发布下载”并选择候选。浏览器不会取得或提交本机绝对路径。
3. Portal 通过当前已安装且启用的 `plugin-release@company-dev` 执行只读 `diagnose`，页面仅显示封闭的摘要、大小和警告。
4. 人工确认后，Portal 才把同一候选原子发布为 `<pluginId>-<version>-<target>.zip`，并从 9134 回读验证字节。

下载目录沿用现有 `%LOCALAPPDATA%\project-delivery-hub-share\downloads`，必须事先存在并由现有 9134 服务读取；Portal 不创建、配置或重启 9134。候选上限为 128 MiB，同名公开版本绝不覆盖。确认前候选变化、Plugin Release 拒绝、写入失败或 9134 回读不一致都会停止；已激活但回读失败的新文件会被隔离，既有下载不受影响。发布回执位于 Portal 私有数据目录，不记录候选绝对路径或原始命令输出。

远程管理模式通过浏览器上传同一候选 ZIP，完成 Plugin Release 审计后才能确认发布；只读模式不显示发布入口，并在读取或解析候选前拒绝写请求。

封面液态玻璃效果复用了 LerSent001 orb 的 MIT 许可实现，完整许可见 [THIRD_PARTY-LICENSE-LerSent001-orb.txt](THIRD_PARTY-LICENSE-LerSent001-orb.txt)。背景使用 jcponcemath 的 “Accretion by Xor” 原作 GLSL 和固定版本 p5.js 1.11.8；背景及接入修改单独遵守 CC BY-NC-SA 3.0，保留 XorDev 署名，见 [来源与修改说明](THIRD_PARTY-NOTICE-Accretion.txt) 和 [p5.js 许可](THIRD_PARTY-LICENSE-p5.txt)。仅封面按需加载本地构建资源，不使用远端 iframe、声音模块或平台脚本。原作限非商业使用，局域网部署本身不代表满足非商业条件。
