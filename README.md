# Plugin Portal

面向个人本机使用的多插件只读门户。Portal 拥有固定页面与独立发布周期，人工纳入插件并生成经过校验的公开资料快照；插件不依赖 Portal，Portal 也不修改或执行插件代码。

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

## 局域网只读访问

本机管理仍只监听 9137；可以另外启动 9135，供可信局域网查看同一份已纳入插件、个人 Prompts 和流程。该入口没有登录验证，因此仅在资料所有者明确同意共享后启用，不要转发到公网。

```powershell
# 在独立运行目录中完成构建，先检查再启动；地址填写本机局域网 IPv4。
.\scripts\start-lan.ps1 -Address <本机局域网IPv4> -CheckOnly
.\scripts\start-lan.ps1 -Address <本机局域网IPv4>
```

- 只读入口隐藏纳入、配置流程和 Prompt 编辑按钮；服务器拒绝所有 POST、PUT、PATCH、DELETE，包括创建管理会话。
- 仅分享已纳入插件的公开快照和对应 Prompts、流程；不会提供目录选择、文件浏览、插件源目录、未纳入资料或执行插件。
- 下载使用同站点链接，只读取现有本机下载服务中对应插件版本的 ZIP，不接受客户端传入的地址；下载服务不可用时按钮禁用或返回错误。
- 绑定明确的内网 IPv4 和固定 9135，不监听全部网卡。只读实例与本机 9137 进程、构建目录分别运行，互不重启；不操作 9136。
- 启动脚本不会修改防火墙、系统服务或开机任务。启用后，局域网可见资料随本机人工保存/刷新更新。

### 局域网 HTTPS

局域网 HTTP 不是浏览器安全上下文，WebGPU 按钮效果会使用本地 Canvas 回退。需要原版效果时，可由 Caddy 在明确的局域网地址和 9135 端口终止 TLS，将请求转发到独立的只读后台：

```powershell
python -m plugin_portal serve --read-only --host 127.0.0.1 --port 9135 --https-origin https://<本机局域网IPv4>:9135 --data-root <资料目录> --web-root <只读构建目录>
```

`--https-origin` 只接受明确的内网 IPv4、HTTPS 和 9135。代理必须保留原始 Host 与 Origin；后台不信任客户端转发头，仍拒绝管理和写入。不要把代理指向 9137。

没有企业证书时，可使用 Caddy 的内部 CA；访问设备需要人工信任其公开根证书。CA 私钥只保存在受限的本机目录，不进入仓库、静态目录或共享包。Caddy 应关闭管理端口、自动 HTTP 跳转和自动信任安装，只监听指定地址；证书续期由运行中的 Caddy 管理。配置前验证临时端口、证书链、IP 名称、GET/HEAD 哈希和只读边界，保留旧 HTTP 运行目录作为恢复来源。

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

封面液态玻璃效果复用了 LerSent001 orb 的 MIT 许可实现，完整许可见 [THIRD_PARTY-LICENSE-LerSent001-orb.txt](THIRD_PARTY-LICENSE-LerSent001-orb.txt)。背景使用 jcponcemath 的 “Accretion by Xor” 原作 GLSL 和固定版本 p5.js 1.11.8；背景及接入修改单独遵守 CC BY-NC-SA 3.0，保留 XorDev 署名，见 [来源与修改说明](THIRD_PARTY-NOTICE-Accretion.txt) 和 [p5.js 许可](THIRD_PARTY-LICENSE-p5.txt)。仅封面按需加载本地构建资源，不使用远端 iframe、声音模块或平台脚本。原作限非商业使用，局域网部署本身不代表满足非商业条件。
