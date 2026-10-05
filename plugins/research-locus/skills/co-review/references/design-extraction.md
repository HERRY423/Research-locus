# 研究设计候选：提取而不代确认

仅处理页面发出的 mode=design 请求。参数里的 sessionId、runId、claimId、snapshotHash、resourceIds 固定本次范围；未选中的论文、附录或同会话其他文件不自动纳入。

1. 简短回应研究者并用 `locus.review_progress` 报告 working。读取最新 state/review_status。
2. 调用 `locus.extract_design`，携带 sessionId、runId、claimId、snapshotHash、expectedRevision、resourceIds，不带 candidates。它返回字段契约和选定证据 URI；此调用不修改档案。
3. 显式读取选定 URI。从材料形成候选，区分作者明确报告与自己的推断。缺失、歧义或相互矛盾时保留 `NOT_DECLARED`，用 rationale 解释缺口或冲突；“未找到”不能转换为 false。特别注意供体数、样本数和细胞数不是可互换的单位。
4. 提交前重读状态；快照变化则停止原请求，版本变化则核对新增记录。再次调用 `locus.extract_design` 并携带 candidates。每个字段最多一个候选；重复或冲突不要任意选一个值。
5. 工具保存候选并将页面进展更新为 needs_input。告知研究者在「研究设计卡」核对原文，逐项勾选采纳，写理由后确认；不勾选可全部驳回。不要将提取完成说成设计已确认。研究者确认或驳回后请求自动结束。

## 候选格式

`{ field, value, rationale, evidence: [{ resourceId, quote, locator }] }`

- field 使用工具契约里的字段名。value 为对应布尔值、整数、分析单位枚举，或 NOT_DECLARED。
- 每个已知值必须有至少一条来自所选证据的逐字摘录和位置说明。quote 至多 2000 字符，locator 至多 500 字符，rationale 至多 2000 字符，每字段至多 5 条引用。
- NOT_DECLARED 可无摘录；有冲突时保留冲突摘录并解释。不要用删节号或翻译伪装逐字引用。
- 服务端验证引用所属和原文字节存在，不验证摘录是否支持解读。研究者应核对含义，不能把工具成功解释成事实认证。
- 干预、批次、校正、阈值与验证字段必须按问题语义提取。列出做了多重检验不等于控制了错误率；存在验证集不等于没有泄漏。

每个 runId 只保存一组候选。结果未知时先读 state.designProposals 按 runId 查找，不能重发另一组候选。关闭、取消、暂停或过期请求拒收提交。候选不会修改 metadata，也不会扩大科学执行权限。禁止读取 UI token 或调用 confirm_design 代替研究者确认。
