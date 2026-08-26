# Plugin Portal 独立多插件只读门户设计

日期：2026-08-25

状态：用户已确认

## 1. 目标

建立一个与任何插件无隶属关系的个人本地 Portal。Portal 使用固定的信息架构，人工纳入一个或多个插件，只展示插件的只读公开资料，并允许用户为每个插件分别维护 Prompts 和鸟瞰全景流程图。

首批纳入对象为：

- `company-dev/project-delivery-hub`，显示名称为“研发助手插件”。
- `company-dev/yusheng-inc`，显示名称为“昱勝 Inc”。

Portal、研发助手插件和昱勝 Inc 是三个独立产品：源码、版本、发布、数据和运行状态互不借用。插件升级不会自动改变 Portal；Portal 发布也不会修改插件。

## 2. 明确不做

- 不自动发现本机安装的全部插件。
- 不执行插件中的 Python、JavaScript、PowerShell 或其他程序。
- 不读取或展示 token、cookie、密码、环境变量、连接配置、VMP 问题、待办、企业微信记录或工作区状态。
- 不要求插件实现 Portal 接口；插件可选提供只含 MCP 公开说明的 `.mcp.public.json`。
- 不保留研发助手专属的六领域、规则包、层级和条款投影。
- 不为插件推断或发明工程规范分类。
- 不提供拖拽流程画布、自定义 CSS、自定义 HTML 或自定义脚本。
- 不建设账号系统、中央数据库、多人同步或公司共享站点。

## 3. 运行与发布边界

Portal 源码位于独立公开仓库 `Dingwenlong/plugin-portal`。运行时仅供仓库所有者个人使用，默认绑定 `127.0.0.1:9137`，不监听外部网卡。

Portal 使用自己的版本、构建、测试和本地启动流程。Portal 的源码发布、构建和重启不需要任何插件发布者批准。插件仍由各自发布者独立管理。

公开仓库不得包含个人 Prompts、流程配置、插件绝对路径、导入快照、凭证或本机运行资料。

## 4. 插件身份与路由

插件的唯一身份为 `target + pluginId`：

```text
company-dev/project-delivery-hub
company-dev/yusheng-inc
```

插件身份进入 URL，页面可刷新、收藏和直接访问：

```text
/#/plugins/project-delivery-hub/overview
/#/plugins/project-delivery-hub/skills
/#/plugins/project-delivery-hub/prompts
/#/plugins/yusheng-inc/overview
/#/plugins/yusheng-inc/prompts
```

根地址跳转到上次选择的插件；没有历史选择时打开目录中的第一个启用插件。未知插件或未知页面归一到对应插件的概览页，不猜测相近 ID。

## 5. 固定页面

每个插件都显示相同菜单：

1. 鸟瞰全景
2. Skills
3. Prompts
4. MCP
5. 扩展工具
6. 工程规范
7. 版本沿革

页面来源与空状态如下：

| 页面 | 内容所有者 | 无内容时 |
|---|---|---|
| 鸟瞰全景 | Portal 用户 | 显示“尚未配置鸟瞰全景流程” |
| Skills | 插件公开资料快照 | 显示“该插件未提供 Skills” |
| Prompts | Portal 用户 | 显示空列表和新增入口 |
| MCP | 插件公开资料快照 | 显示“该插件未提供 MCP” |
| 扩展工具 | Portal 人工纳入配置 | 显示“该插件未配置扩展工具” |
| 工程规范 | Portal 人工批准的插件内相对路径 | 显示“该插件未提供公开工程规范” |
| 版本沿革 | Portal 导入快照记录 | 至少显示当前纳入版本 |

菜单始终保留，空状态根据内容所有者分别表达，不使用一条通用文案。

## 6. 人工纳入与刷新

Portal 只纳入用户明确选择的插件目录。流程为：

1. 用户选择插件目录。
2. 服务端确认目录内存在 `.codex-plugin/plugin.json`。
3. 读取插件 ID、显示名称、版本和公开说明。
4. 读取 `skills/*/SKILL.md` 中允许公开的名称和说明。
5. 读取 `.mcp.json` 的服务 ID；若存在可选 `.mcp.public.json`，按服务 ID 补充名称、用途、能力和是否包含写入操作；不把 command、args、env 或其他启动细节写入快照。
6. 读取用户批准的扩展工具链接。
7. 读取用户批准的工程规范 Markdown 相对路径。
8. 在临时候选中完成结构、安全和公开文案检查。
9. 展示相对当前快照的差异预览。
10. 用户确认后原子切换活动快照。

插件升级后不会自动刷新。刷新仍执行相同步骤。导入失败时继续使用原快照；成功快照不可变，并保留上一版用于回滚。

插件 ID 与既有目录记录不一致时拒绝刷新。插件源目录后来消失时，已生成快照仍可阅读。移除插件时先从目录隐藏，Prompts、流程配置和旧快照默认保留；永久删除必须单独确认。

## 7. 只读快照

浏览器不访问插件目录，只读取 Portal 生成的封闭快照。快照至少包含：

```json
{
  "schemaVersion": "1.0.0",
  "plugin": {
    "target": "company-dev",
    "id": "project-delivery-hub",
    "name": "研发助手插件",
    "version": "3.7.17",
    "summary": "公开说明"
  },
  "skills": [],
  "mcp": [],
  "extensionTools": [],
  "engineeringRules": [],
  "provenance": {
    "packageDigest": "sha256:...",
    "adapterVersion": "1.0.0",
    "importedAt": "2026-08-25T00:00:00Z"
  }
}
```

快照是构建结果，不是人工维护的第二份业务权威。首版使用一个通用插件读取器，不建立研发助手和昱勝 Inc 专属适配器。只有通用读取无法满足经确认的真实需求时，才另行设计适配器扩展。

快照不会包含插件绝对路径。来源只记录插件身份、版本、内容摘要和相对路径。

可选 `.mcp.public.json` 使用 `.mcp.json` 已声明的服务 ID 作为键，每项必须封闭包含 `name`、`purpose`、非空 `capabilities` 与布尔值 `writeEnabled`。说明引用未知服务、包含额外或缺失字段、重复能力、私密赋值、本机路径或原始异常时，整个候选导入失败；未提供说明的服务维持 ID-only 投影。

## 8. 工程规范

Portal 不推导层级、类别、领域、规则包或条款。用户在纳入或刷新插件时，仅选择允许公开的插件内 Markdown 相对路径。

页面列表只显示相对路径。点击路径后，Portal 在页面内只读渲染经过安全处理的 Markdown 正文。

读取要求：

- 路径必须相对插件根目录。
- 拒绝绝对路径、`..`、目录越界、符号链接、junction、reparse point 和非普通文件。
- 只允许 `.md` 文件。
- 拒绝凭证、私密值、内部绝对路径、不安全链接和原始异常信息。
- Markdown 不允许脚本、内嵌 HTML、远端活动内容或任意协议链接。

## 9. Prompts

Prompts 由 Portal 用户创建，不从插件包读取。数据按完整插件身份隔离：

```json
{
  "pluginKey": "company-dev/project-delivery-hub",
  "items": [
    {
      "id": "prompt-1",
      "title": "检查接口设计",
      "content": "检查字段、回应码和资料来源。"
    }
  ]
}
```

切换插件时只显示当前插件的 Prompts。插件升级、快照回滚或从目录隐藏不会删除 Prompts。首版不提供跨插件共享 Prompt。

## 10. 鸟瞰全景流程配置

鸟瞰全景由 Portal 用户按插件独立维护，不从插件包读取，也不随插件升级变化。

配置层级为 Tab、流程区域和步骤：

```json
{
  "pluginKey": "company-dev/project-delivery-hub",
  "tabs": [
    {
      "id": "plugin-installation",
      "title": "插件安装",
      "sections": [
        {
          "id": "first-install",
          "title": "首次安装并配置",
          "steps": [
            {
              "id": "package",
              "label": "准备",
              "title": "取得正式插件包",
              "description": "",
              "next": ["unpack"]
            }
          ]
        }
      ]
    }
  ]
}
```

Portal 提供简单表单编辑器：

- 新增、重命名、排序和删除 Tab。
- 新增、重命名、排序和删除流程区域。
- 新增步骤并编辑角标、标题和说明。
- 通过多选框选择后续步骤，表达串行、并行、分叉和汇合。
- 保存前预览固定样式的流程图。

保存前拒绝重复 ID、未知连接、断裂连接、无入口、无法到达的步骤和循环。Portal 固定 Tab、卡片、连线和并行分支样式；用户配置不能包含 CSS、HTML 或脚本。

## 11. 本地存储

首版使用本地 JSON 文件和原子写入，不使用数据库。本机运行数据位于操作系统的个人应用数据目录，不位于 Git 仓库：

```text
plugin-portal/
├── catalog.json
├── active-snapshots.json
├── snapshots/
├── prompts.json
└── workflows.json
```

写入过程使用临时文件、完整校验和原子替换。写入失败时保留旧文件。快照按插件身份和内容摘要不可变存放；活动指针只在候选全部通过后切换。

## 12. 本地接口

浏览器只调用 Portal 本地服务：

```text
GET  /api/plugins
GET  /api/plugins/{pluginKey}/snapshot
POST /api/plugins/import/preview
POST /api/plugins/{pluginKey}/promote
POST /api/plugins/{pluginKey}/rollback
GET  /api/plugins/{pluginKey}/prompts
POST /api/plugins/{pluginKey}/prompts
GET  /api/plugins/{pluginKey}/workflows
POST /api/plugins/{pluginKey}/workflows
```

所有改变本地状态的请求都要求当前会话令牌和预期 revision，避免重复提交与旧页面覆盖新数据。服务只接受 loopback 请求，不启用跨域访问。

## 13. 技术边界

- 前端使用 React、TypeScript 和 Vite，迁移并精简现有 Portal 的固定视觉组件。
- 本地服务与导入器使用 Python 标准库优先实现。
- 浏览器不获得插件源目录绝对路径。
- 插件文件读取、快照生成和本地写入都由服务端完成。
- 不复制插件业务代码，不导入插件模块，不依赖插件运行时服务。

## 14. 验证

至少覆盖：

- 两个插件身份、页面和 Prompts 完全隔离。
- 未人工纳入的插件不会出现。
- 未知或缺失内容显示页面专属空状态。
- 插件目录越界、路径遍历、链接文件和私密内容全部拒绝。
- `.mcp.json` 的 command、args 和 env 不进入快照。
- 导入预览不会改变活动快照。
- 失败刷新继续使用旧快照；成功切换与回滚保持原子。
- 工程规范只能读取批准的相对 Markdown，并安全渲染。
- 流程编辑器支持 Tab、区域、步骤、串行、并行、分叉和汇合。
- 重复 ID、未知连接、循环和不可达步骤拒绝保存。
- 插件切换、直接 URL、刷新和最后选择恢复正确。
- 公开仓库扫描不包含本机路径、Prompts、快照、凭证和插件私有内容。

## 15. 迁移顺序

1. 建立独立仓库、本地服务骨架、固定 Portal 外壳和本地数据目录。
2. 实现人工纳入、通用快照、插件切换和固定页面空状态。
3. 纳入研发助手插件，迁移其用户 Prompts 与鸟瞰全景流程配置；不迁移专属六领域和规则包投影。
4. 纳入昱勝 Inc，验证与研发助手的数据隔离。
5. 完成真实浏览器、路径安全、快照回滚和公开仓库洁净验证。
6. 新 Portal 验收通过后，再由研发助手插件自己的发布流程移除旧 Portal；此前两个 Portal 可并存，避免一次切换失去回滚路径。

## 16. 验收标准

- 用户可以人工纳入研发助手和昱勝 Inc，并独立刷新或回滚各自快照。
- 固定菜单在两个插件下均可访问，缺失内容使用正确空状态。
- 用户 Prompts 和鸟瞰全景流程按插件完全隔离。
- 工程规范仅显示批准相对路径，并可在 Portal 内只读阅读正文。
- 任何插件内容都不能改变 Portal 组件、样式、路由或执行代码。
- 插件发布、Portal 发布和另一个插件发布互不阻塞。
- 本地运行资料全部位于 Git 仓库之外，公开仓库不泄露个人或插件私密资料。
