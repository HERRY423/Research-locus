# MCP Extensions 规范核对与朋友分发

核对日期：2026-10-05。基准是用户指定的 [OpenAI spec.md](https://github.com/openai/mcp-extensions/blob/ca16cb3bc015baaa1b849082d8755bbef18770cb/docs/spec.md)，上游 main 当时固定到 `ca16cb3bc015baaa1b849082d8755bbef18770cb`。本地 SDK 是 `@openai/mcp-extensions@0.1.0`、MCP SDK 1.29.0、ext-apps 1.7.5；SDK 接受某个旧字段不等于当前 main 仍列出它。

## 逐项核对

| 项目 | 当前实现与证据 | 结论 |
| --- | --- | --- |
| 静态入口 | `locus.open` global 接受 `{}`；`locus.panel` thread 的 sessionId 可省略；`locus.file` 使用官方 FileInput schema | 协议测试通过 |
| 设置 | 已移除原先 `type: settings` 第四入口，保留 `locus.settings` 普通应用工具及工作台「项目与边界」页 | 不宣称实现新的 structured settings read/update capability |
| Global schema | 删除旧 quickAction 属性，只广告 `type: global` | 与当前条目一致 |
| 图标 | 服务器图标采用透明、currentColor、20×20、1.33 描边 | 当前 MCP SDK 高层注册器不发出 tool.icons，使用规范允许的服务器图标回退；未达到优先提供每工具图标的 SHOULD 建议 |
| 首次显示 | 首页优先读取首次 tool result 中的目录；会话首次显示复用已有状态 | 已补充初始结果复用断言，不重复调用入口工具 |
| UI 资源 | 独立 home 和 workbench 资源，MCP Apps HTML MIME；资源 `_meta[openai/ui]` 声明模式 | fullscreen 是偏好提示，最终布局由宿主决定 |
| 文件格式与读取 | 扩展名均以点开头，FileInput 的 opaque resourceUri 经宿主资源 API 读取；本次补上 representation=text | 不将 URI 当本地路径；仅文本，1 MB 上限 |
| 文件写入 | 检查 writable 和 ETag，使用 ifMatch；处理 conflict 和 too-large | Mock 覆盖；没有原生宿主写回验收；写回后读回失败不证明之前未保存 |
| 文件订阅 | 目前未订阅宿主外部文件更新 | 不宣称自动同步外部修改；需重新打开／导入 |
| mentions | SDK 注册 app-visible search_mentions，query 返回资源链接，URI 精确验证 | 协议测试通过，原生 composer 入口未验收 |
| model context | 传递明确选择的 session/project/revision/hash/IDs；接收宿主 context 更新 | 实现存在，原生双向行为未验收 |
| 消息 | 显式操作调用 ui/message 定向审阅；使用 active/send 默认行为 | 请求不等于审阅完成 |
| 资源选择表单 | 支持 direct MCP 的 legacy form；不支持时返回工作台选择降级 | 注册服务所需 MRTR 未实现，不能声明可公开注册后完整使用 |
| deep links | 目前仅支持应用相对 `/claims/<id>` 选择；本地 hash 是本地路由 | 没有为分发插件承诺跨平台／跨会话完整深链 |
| onboarding / structured settings / local-file opener | 没有广告对应完整能力 | 不属于已实现功能 |
| 平台与安装 | 优先桌面本地 stdio；Web/手机不等于桌面文件功能；classic ChatGPT 不在该支持表内 | 必须按朋友实际宿主验收 |

上述条目为对照检查，不是官方认证。没有将所有可选扩展都实现，也没有把工程通过说成原生安装通过。

## 分发处理

按照 [官方打包指南](https://developers.openai.com/plugins/build/plugins) 准备市场根目录、相对插件路径、安装策略与类别。采用 root portable manifest，保留官方支持的 `.codex-plugin/plugin.json` 兼容展示信息。未伪造 `.app.json` 注册应用 ID，也未更改用户已有插件配置。

新增 `scripts/launch.mjs`，将默认档案位置放到当前用户数据目录。插件缓存被更新时，默认研究数据不与代码一起替换。启动器兼容 `LOCUS_DATA_DIR` 以及已有 state/catalog 环境变量；构建时不执行启动器，不迁移现有开发档案。

`scripts/package-friend-kit.mjs` 使用白名单打包代码、静态资源与锁定版本的生产依赖。排除 `.locus`、本机配置、验收导出和日志。附合成初始化逻辑，不附开发者的研究档案。

## 验证边界

- 类型检查、42 项本地测试及构建通过。新增断言覆盖当前三类入口、旧入口移除、图标回退、文本读取参数与首次状态复用。
- Codex CLI 的 `plugin marketplace add --help` 确认本机有该命令；未替用户执行安装或登记市场。
- 安装包的独立解压与 stdio 验证结果见 `artifacts/friend-kit-verification.json`（开发目录留存）。
- 原生客户端安装、全局／thread 页面、文件入口、真实资源写回和跨客户端可用性仍为 `NOT_RUN`。朋友按安装说明测试这些功能。
- 官方区分服务连接、完整插件安装及公开发布；参见 [连接与测试](https://developers.openai.com/plugins/deploy/connect-chatgpt)。此包只供本地测试，不是公共目录发布物。

本次 AgentMuxer 仅免费搜索发现能力；没有调用目录中的付费 API。规范和安装文档直接读取官方公开来源。
