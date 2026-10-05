# 内置声明检查与补充信息

`locus.review` 对会话全部论断执行当前注册的确定性检查（v3 共九条），并持久保存 `ruleReview`。这与面向选定论断、资源的 Agent 定向复核范围不同。调用时使用最新 `sessionId`、`expectedRevision`；返回的 `state.revision` 已推进。报告绑定 `snapshotHash`、执行时 `revision`、`checkedAt` 和 `rulesVersion`。

## 读取结果

每个论断返回注册规则的全部 `checks`；每项包含 `claimId`、`ruleId`、`ruleVersion`、`outcome`、`declared`、`declarationStatus`、`missingFields`、`rationale`、`nextStep`、`disciplines` 与 `limitation`。未知声明使用 NOT_DECLARED；旧档案省略字段按未知处理。

| outcome | 如何回应 |
| --- | --- |
| flagged | 有声明触发风险，已生成确定性 finding；解释风险及核验建议，不当作已证实科学错误 |
| needs_input | 无法判定，按缺失字段提出最小问题；不提交重复的风险 finding 来替代补充信息 |
| no_signal | 已填声明没有触发该规则；仍可能缺少统计、材料或独立核验 |
| not_applicable | 按声明范围或适用性不适用；未检查正文是否与范围一致 |

`summary` 汇总会话的 claims、flagged、needsInput、noSignal、notApplicable、missingFields。空白会话 claims=0 时报告“暂无论断可检查”。同一项可能既已触发风险又缺少其他字段，因此逐项检查 missingFields，不能只看 needsInput 总数。`analysisUnit=other` 需要解释及定向复核，即使字段已填也会保留 needs_input。

## 规则边界

- 分析单位与外推：仅针对 cohort/population。细胞为单位或独立生物重复少于 2 会提示风险；缺失单位或重复数时列为信息不足。供体/独立样本且重复数不少于 2 仅表示没有触发，不证明独立性、模型或功效充分。
- 因果与干预：仅针对 causal。`perturbation=false` 提示补充因果识别依据或缩小措辞；缺失不等于 false。有干预不证明因果成立，无干预也不排除其他有效识别设计。
- 图表对应：明确不涉及则不适用；已知不匹配提示风险；声明匹配仍未独立核验。适用性或对应情况未知则列出补充项。不读取图像或自动比对文件。
- 六项扩展检查：多重检验控制、样本量报告、批次处理、关联证据与因果措辞、结果知晓后的阈值选择、预测验证数据泄漏。按每项 disciplines 和 limitation 解释；不相关场景需明确声明不适用，不能靠漏填跳过。

## 由研究者更新

页面新建/修订表单提供研究设计卡，必须核对确认；未知项保留 NOT_DECLARED。basis 是研究者填写的定位说明，不是独立来源证明。需要从证据提取时使用 [候选流程](design-extraction.md)，不要自行写入。

只有研究者页面通道可以 create_claim/revise_claim。Agent 可建议字段值并注明推断依据，但不得读取 UI token、调用 UI action 代填。研究者只改 metadata 也会形成新材料快照，让旧发现与决定过期；保存后重新运行检查。重读最新 state，不能沿用原快照或原 runId 提交过期意见。

旧版档案可能没有报告；读入不会补造历史记录。需要时明确执行新检查。回放只展示当时保存的声明和检查，不将今天的规则结果归入旧事件。
