# 定向复核工具契约

所有调用显式携带 `sessionId`。`locus.state` 返回当前 `state`（模型摘要不含资源正文）及临时 `reviewRuns`；资源正文需读取本次选中的精确 MCP URI。

`locus.review_status` 返回 `reviewRuns`、`reviewProcessId` 与 `retention=server_process_only`。按 `runId` 找到请求，其 `claimId`、`snapshotHash`、`resourceIds`、`mode`、`focus` 固定范围；`sequence` 是进展序号。

## 报告进展

`locus.review_progress` 参数：

| 字段 | 约束 |
| --- | --- |
| sessionId / runId | 原请求的会话与编号 |
| expectedSequence | 最新请求 sequence；不是档案 revision |
| phase | working / needs_input / completed / failed |
| message | 1–2000 字符，描述真实进展、问题或有边界的小结 |

不要报告“已接受”或“科学验证通过”。完成、失败、暂停关闭和材料过期均阻止继续写入原请求。

## 保存发现

`locus.submit_finding` 参数：`sessionId`、`runId`、`expectedRevision`、`snapshotHash`、`claimId`、`resourceIds`、`title`、`rationale`、`severity`、`category`，以及可选 `revisionProposal`（见 [共同完善论断](co-improvement.md)）。

- `expectedRevision` 是最新档案版本，与请求 sequence 不同。
- `snapshotHash` 匹配最新状态；原请求的论断及依赖上下文必须仍适用。无关论断变化不关闭请求，相关材料变化不能只替换哈希绕过。
- `resourceIds` 必须是本次选择的子集；没有选定材料时可说明缺口，不能捏造引用。
- `title` 最多 300 字符，`rationale` 最多 8000 字符；severity 为 info / warning / critical；category 为 design / claim_scope / provenance / other。
- 保存会推进档案版本、关联 finding ID 并更新请求 sequence。每次提交后以新状态继续。
- `runId` 对旧聊天直审接口是可选字段，但页面定向复核必须提供；不要省略以绕过关闭或范围约束。

本地检查：`node skills/co-review/scripts/validate-finding.mjs INPUT.json`，输入为 `{ "state": ..., "request": ..., "finding": ... }`。state 使用当前状态；request 使用该 run 加 sessionId；finding 使用完整待提交参数。脚本不访问网络、不写入项目、不验证科学事实。`--self-test` 运行本地断言。

脚本核对最新输入摘要与选定引用；请求是否因相关中间修改而过期，由服务端结合依赖与事件历史再次判定，脚本通过不能代替该检查。

`locus.review_request` / `locus.review_cancel` / `locus.ui_action` 属于页面通道。模型不得读取 HTML 获取 token 或调用这些接口冒充研究人员。

## 内置检查

`locus.review({sessionId, expectedRevision})` 返回 `ruleReview`、`summary` 和更新后的 state。`ruleReview.checks` 提供每个论断的注册规则结果与 missingFields。见 [声明检查](metadata-checks.md)。报告持久保存在档案的 `metadataReviews`，与仅保存在进程内的 reviewRuns 不同。没有 findings 不代表没有缺口。

`locus.extract_design` 的准备和候选提交契约见 [研究设计提取](design-extraction.md)。候选持久保存在 designProposals；页面 confirm_design 只能由研究者提交，不能通过模型调用。部分采纳仅写入所选字段，未采纳候选不会自动生效。
