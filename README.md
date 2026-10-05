# Research Locus · 科研共审台

当前本地改进：[计算回执、BioNexus 多供体差异表达与 DOI 分层核验](docs/computational-evidence.md)；[论断依赖图、修订提案与补证闭环](docs/co-improvement.md)。

黑白界面的科研 MCP Extension：项目与会话首页、论断与证据共审、研究者实时介入，以及逐步回放。借鉴 BioNexus 的证据约束设计，研究人员可以质疑、驳回、暂缓或修订建议，并保留理由。

**0.1.1 本地研究预览版。运行包已构建并随仓库提供，只需 Node.js 22+；不需要 npm install、编译或额外模型 API key。原生宿主界面仍待实际验收。**

## 在“添加插件市场”中填写

| 字段 | 内容 |
| --- | --- |
| 来源 | `HERRY423/Research-locus` |
| Git 引用 | `main` |
| 稀疏路径 | 留空 |

添加后在 **Research Locus** 市场中安装并启用同名插件，重启客户端并新建聊天。需要支持 Git 插件市场、本地 stdio MCP 和 OpenAI MCP Extensions 的桌面宿主；受客户端版本、账户和组织策略约束。

安装后 `locus.open` 的 `global` 入口用于从宿主主侧边栏打开项目首页，`locus.panel` 用于会话面板。插件提供入口声明与黑白图标；宿主决定显示位置和固定菜单，不承诺自动固定到任意客户端。

**[完整安装、侧栏与科研使用教程](docs/install-and-use.zh-CN.md)** · [规范核对](docs/spec-audit-2026-10-05.md) · [原生宿主验收清单](docs/host-acceptance.md)

## 使用

最新本地改进：[研究设计卡、候选提取与九条模块化规则](docs/design-card.md)。设计卡必须核对，未知保留 NOT_DECLARED；locus.extract_design 仅保存带证据的候选，经研究者逐项确认后写入。

本地改进：定向复核提供证据核对、研究设计与方法、异议与替代解释三种方式，并显示等待确认、复核中、需要补充和结束状态。参见 [反馈与共审技能改进记录](docs/interaction-feedback.md)。此记录描述本地工作副本，不代表 GitHub 或已安装插件自动更新。

内置检查已接通用户新建／修订论断的审查信息，并固定返回每条规则的覆盖结果。未知字段会列出补充项；只改审查信息也会使旧意见过期。详见 [内置检查修复与验收](docs/metadata-review.md)。

1. 打开 Research Locus，创建项目与空白会话。
2. 新建论断，填写已知审查信息，添加 Markdown、TXT、CSV、JSON 文本证据。
3. 运行元数据检查，按报告补充信息后重查；需要内容核验时明确请求宿主 Agent 审阅所选材料。
4. 在研究者判断区域记录异议、决定与理由；修订后重新审查。
5. 在「回放剧场」逐步查看已保存的变更；从更多操作导出 JSON 快照。

需要计算来源时，可在「证据文件」导入 BioNexus bundle 或绑定代码、输入、输出原始字节的计算回执，查看工具版本、失败记录与实际核验边界。DOI 核验由显式操作触发，分别报告格式、公开注册记录与元数据一致性；不会把格式正确当作引用已核验。操作见 [计算证据说明](docs/computational-evidence.md)。

本插件不内置独立模型。内置 reviewer 检查九条声明规则，不重算统计或核验图像。计算回执导入不执行代码，DOI 核验不判断正文是否支持论断；宿主 Agent 的意见仍需独立核验。回放仅覆盖本会话实际保存的操作，不录制宿主所有文件修改或模型内部过程。

## 本地浏览器预览

下载或克隆仓库，在仓库根目录运行：

```powershell
node plugins/research-locus/scripts/launch.mjs --http
```

打开 `http://127.0.0.1:4317`。预览与插件默认共用用户数据目录，同一目录只运行一个服务进程；多实例请设置不同 `LOCUS_DATA_DIR`。本仓库不是远程 MCP 服务，GitHub Pages 不能运行这个 stdio 后端。

## 开发与分发

```powershell
npm ci --ignore-scripts
npm run check
npm run build:marketplace
npm run smoke:marketplace
```

源码在 `src/`，安装清单在 `.agents/plugins/marketplace.json`，可安装成品在 `plugins/research-locus/`。构建脚本将运行依赖打包到服务器文件并保留第三方许可；发布前更新版本并重新构建。`BUILD.json` 记录产物摘要。没有安装时静默下载依赖或执行模型调用。

默认档案位于 Windows `%LOCALAPPDATA%\ResearchLocus\`、macOS `~/Library/Application Support/ResearchLocus/` 或 Linux `$XDG_DATA_HOME/ResearchLocus/`（未设置时 `~/.local/share/ResearchLocus/`）。仓库不含开发者档案。更新前备份数据；卸载代码不应被当成删除数据。

遵循 [OpenAI 插件打包文档](https://developers.openai.com/plugins/build/plugins) 与 [MCP Extensions 规范](https://github.com/openai/mcp-extensions/blob/ca16cb3bc015baaa1b849082d8755bbef18770cb/docs/spec.md)。本地 Git 市场分发不等于进入 OpenAI 公共目录。软件使用现有 Apache-2.0 许可证；第三方代码遵守各自许可。
