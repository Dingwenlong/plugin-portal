# Portal 持续启动候选

`start-persistent.ps1` 默认只验证，不注册任务、不重启服务、不修改 PATH 或证书存储。
它仅管理自己创建的 Portal 后端与 Caddy 子进程，不接管既有监听。正式端口固定为 9135。

## 两份配置

- `persistent-config.example.json`：核心运行配置。Python、Caddy、Caddyfile、公开根证书必须有明确路径和小写 SHA-256；完整运行目录也必须有摘要。证书必须已在本机系统根证书存储中受信任，LAN 地址必须已分配。配置本身的摘要由启动参数固定。
- `audit-config.example.json`：发布审计配置。Codex 路径及摘要、Python 路径及摘要、Codex 数据目录、Plugin Inspector 根目录、版本、清单/脚本/完整目录摘要均显式指定。不扫描缓存寻找最新版本，不自动安装插件。Codex 可执行文件名必须为 `codex.exe`（Windows）。配置只在审计时读取；缺失、损坏、版本不符、文件变化或工具无法运行均阻止发布，但不阻止站点启动。

审计配置用 `pluginInspector` 固定新工具身份；兼容显式使用 `pluginRelease` 的旧配置，但两者不能同时存在，不能因某个工具缺失而自动切换到另一个工具。返回结果中的工具名称也必须与所选身份一致。

示例值不能直接运行。配置须由有权维护运行环境的人在非生效位置填写并核验，不要写入仓库。运行目录只放不可变程序与构建文件，数据、日志和配置放在运行目录之外；日志目录须预先存在。审计通过 `PORTAL_AUDIT_CONFIG` 传给后端，仅改变该子进程的环境。其他启动方式也需显式设置此环境变量才能执行发布审计。

完整目录摘要算法：每个普通文件形成 `相对路径:小写SHA256` 一行，路径分隔符为 `/`，按 ordinal 排序，以 LF 连接，无末尾 LF，再计算 UTF-8 SHA-256；目录中不允许链接或 reparse point，也不排除缓存文件。请先清理候选中的缓存，再冻结摘要。

## 非生效验证

在仓库根目录执行隔离测试；测试仅使用临时目录和自己创建的短时 Python 子进程，不接触正式监听：

```powershell
python -B -m unittest discover -s tests -p 'test_audit_config.py' -v
python -B -m unittest discover -s tests -p 'test_persistent_launcher.py' -v
python -B -m unittest discover -s tests -p 'test_launcher_config.py' -v
```

针对管理员已准备的非生效候选，先在独立 PowerShell 中执行：

```powershell
.\scripts\start-persistent.ps1 -ConfigPath C:\PortalCandidate\persistent-config.json -ConfigSha256 <已冻结的配置摘要>
```

验证会先核对配置、核心文件摘要及必需的页面/模块，再由独立 Caddy 进程执行 `adapt` 解析（不执行会置备存储的 `validate`），由独立 Python 进程导入候选模块并检查解析后的代理边界，之后重新核对配置与文件摘要。各独立检查均有 20 秒超时，超时只关闭该检查自己创建的进程。代理必须只监听明确的 LAN 地址及 9135，关闭管理 API/自动跳转，只启用 h1/h2，以本机 127.0.0.1:9135 为唯一上游，并为其他 Host 返回 421；额外监听、路由、上游、请求头改写或处理器均拒绝。它不检验可选审计工具是否可用，也不绑定监听。此检查不是正式 HTTPS 启动验收。

若设置当前子进程环境的 `PORTAL_TEST_CADDY` 为明确的 Caddy 程序路径，代理配置测试还会在临时目录创建自己的 Caddyfile，真实执行一次 `adapt` 并确认没有创建证书存储；不读取正式 Caddyfile，也不启动监听。

## 后续生效边界

本次候选不包含计划任务更新或正式启停。生效前必须另行授权：将当前启动脚本、配置及任务定义备份到非交付恢复目录，核对备份内容/摘要及恢复命令；核验候选 Caddyfile 的存储与监听配置、私钥位置和权限。必须有可用恢复通道。

授权后才可向同一条命令增加 `-Run -ProbeSeconds 30` 进行短时启动测试。默认没有 `-Run` 就不会启动。Probe 从本轮 HTTPS 验证通过后开始计时，到期后关闭自己的子进程并确认离线；持续模式为 `-Run`（不指定 ProbeSeconds）。每次启动验证拥有者 PID、启动时间、程序路径、父进程和命令标记，以及实际 HTTPS 首页摘要和远端管理模式。

子进程异常退出时，先关闭本轮仍存活的自有子进程，再检查端口与核心依赖，然后按固定间隔重启整个对子；重启次数是整个监督进程的总预算，不会因短暂成功而清零。默认最多重启 2 次，配置允许 0–5 次，间隔 1–60 秒。身份或恢复检查失败立即停止，不杀死无法核实的进程；配置漂移也停止重启。日志只写入指定日志目录下本次唯一子目录。

审计配置只可由管理员更改。即使审计恢复，也不能把新的 Codex/Plugin Inspector 版本自动写成旧版本的替代品；需核验并明确更新所有固定值。站点可用、隔离过程测试通过、正式恢复完成是三项不同的验收状态。
