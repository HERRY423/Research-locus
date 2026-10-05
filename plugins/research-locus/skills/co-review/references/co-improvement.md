# 共同完善论断

读取当前 state 与选定证据。`state.claimRelations` 的箭头由上游前提指向下游结论；`depends_on` 才触发局部重审，`supports` 和 `contradicts` 记录上下文，不自动传播失效。研究者添加的关系不是经过验证的科学支持。

在需要修改的 `locus.submit_finding` 中可加入 `revisionProposal`：

```json
{
  "text": "建议的新论断文字，保留不确定性",
  "scope": "sample",
  "evidenceNeeds": [
    {"id":"independent-units","category":"replication","description":"补充独立实验单位上的效应估计及区间，并核对外推范围。"}
  ]
}
```

text、scope、evidenceNeeds 可独立省略，但提案不可为空。不要为了完整而编造替代文字或科学范围。scope 仅允许 sample/cohort/population/causal；补证类别允许 source/design/analysis/replication/causal/provenance/validation/other。每项 ID 为 1–80 位字母、数字、下划线或连字符，同一提案不能重复；最多 20 项，每项 description 最多 2000 字符。

在 finding.rationale 说明：证据支持了什么，哪里仍未知，为什么提出这个修订、什么新证据可能改变判断。拟开展的实验与分析是计划，不是已获得的证据，也不代表执行授权。

研究者在页面逐项采纳，可以分次处理同一提案。未选项不会自动生效。相关论断或其依赖被其他操作修改后，旧提案必须重新审查。Agent 不调用 UI 通道、不直接修改论断、不记录研究者采纳。

`state.evidencePlans[claimId]` 是派生缺口清单，综合范围要求、声明规则、已采纳的建议和上游变更。missing=待补、declared=仅声明、provided=已关联材料但未核验、needs_review=需复核。这些状态都不是科学通过。基础评估项保留，NOT_ASSESSED 不会自动升级。

发现依赖变更时，说明具体受影响的结论和需核对的前提；不把全项目无关论断宣布失效。完成复核后由研究者在页面记录处理理由。驳回某条审查建议与驳回论断是不同动作。
