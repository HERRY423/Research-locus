# 本地工程验收记录

验收日期：2026-10-05（America/Los_Angeles）。环境：Windows 本机。范围：Research Locus 0.1.0 原型的领域约束、MCP 接口、本地工作台及打包产物。以下交互使用合成案例和自建演示文本，不是真实科研裁决。

后续黑白界面改版的截图、浏览器检查和更新后 UI 摘要见 [ui-refresh.md](ui-refresh.md)。下文保留首次原型验收记录，旧 UI 摘要不代表改版后的构建。

最新独立首页、项目／会话隔离、34 项测试和最终构建摘要见 [standalone-home.md](standalone-home.md#本地验收)。以下是较早的原型验收快照。

随后新增回放剧场，最新 42 项测试、浏览器回放检查与 UI 构建摘要见 [replay-theater.md](replay-theater.md#验证)。

## 已完成检查

| 检查 | 结果 | 证据范围 |
| --- | --- | --- |
| `npm run check` | PASS；23/23 测试通过 | TypeScript 类型检查、自动化测试、构建全部完成；只构成本地工程证据。 |
| `node scripts/smoke-stdio.mjs` | PASS | 独立临时 state；发现 11 个工具；重启后 revision 为 1；stderr 为空。 |
| 本机浏览器工作台 | PASS，下列操作已实际完成 | 本地 HTTP 页面交互；不代表原生 ChatGPT 宿主接入通过。 |

浏览器中已完成：

- 对合成案例提出异议并记录理由。
- 修改论断文字，确认旧意见和旧决定转为过期。
- 通过真实 filechooser 导入自建 `examples/research-note.md`，并查看文本预览。
- 重新运行规则检查；暂停和恢复审查。
- 新建无证据论断，保留证据未评估状态。
- 在 480 px 窄屏下检查页面：`document.clientWidth = document.scrollWidth = 465`，未观察到页面横向溢出。

导出已通过实际浏览器下载核验：点击后产生 `research-locus-rev-8.json`，回读得到 4 个论断、2 份资源、1 条决定、9 个事件，snapshotHash 与持久化状态一致；所有论断仍为 `NOT_ASSESSED`，科学授权仍为 `NONE`。留存副本见 [browser-export-rev-8.json](../artifacts/browser-export-rev-8.json)。最初 Blob 下载未获内嵌浏览器确认，已改用服务器附件响应并重新验证；HTTP 测试同时检查文件内容及旧版本导出返回 409。

桌面 1440 px 布局检查的 clientWidth 与 scrollWidth 均为 1425，未观察到页面横向溢出。最终截图见 [workbench-desktop.png](../artifacts/workbench-desktop.png)。截图和导出均含明确标记的工程验收操作。

## 构建产物

| 产物 | SHA-256 |
| --- | --- |
| `dist/server.js` | `1cbad93aedb19246f165a02beb4f8ca4053b11809f123b6fcf7836e410eb6f96` |
| `dist/app.html` | `696ee4064b4ef5eaf50dfbc05857b3e954844fa8a0542b84a7325375a64f0fbf` |

摘要只绑定对应文件字节；不证明宿主执行、身份真实性或科学有效性。产物改变后须重新记录摘要。

## 未完成与不支持的范围

| 项目 | 状态 | 含义 |
| --- | --- | --- |
| 原生 ChatGPT 安装与宿主验收 | `NOT_RUN` | 未验证真实侧栏入口、文件入口、资源选择和上下文联动在原生宿主中的完整行为。 |
| 真实文献引用、数值重算、图表核验 | `NOT_IMPLEMENTED` | 当前规则检查仅检查声明的元数据；未执行科研分析或内容真实性验证。 |
| 科学有效性 | `NOT_ASSESSED` | 合成案例、规则命中及工程测试不能确立真实科研结论。 |
| 研究者身份 | `DECLARED_NOT_AUTHENTICATED` | 记录的是本地交互渠道中的身份声明；未独立认证真实人员身份。 |
| 科学授权 | `NONE` | 人工选择、导入证据和规则检查均不自动提升科学证据等级。 |

首次在沙箱内连接本机 loopback 时出现访问拒绝；随后通过授权的本机监听测试完成验证。最初的拒绝是运行环境权限限制，不作为产品故障。

本次未使用付费 API。上述结果不构成生产就绪、独立科学验证、真实研究者收益或优于其他产品的证明。
