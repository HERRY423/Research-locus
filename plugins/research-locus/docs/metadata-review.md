# 用户自建论断的内置检查修复

这是 v2 阶段记录；当前研究设计卡、候选提取与九条规则见 [v3 更新](design-card.md)。

2026-10-05，本地工作副本，基于 0.1.1。未发布到 GitHub，未替换宿主已安装包，原生 ChatGPT 验收仍为 NOT_RUN。

## 问题与修复

原先 create_claim 与 revise_claim 没有 metadata 输入，普通用户无法填写规则所需信息；缺失信息与未触发也没有覆盖报告。现在新建、修订、严格校验、快照、持久档案、规则检查、MCP 返回和回放使用同一份声明数据。新建与修订页面均提供审查表单，报告中可直接打开补充入口。

每个论断固定产生三项检查结果，不再只返回风险 finding：

| 结果 | 表示什么 |
| --- | --- |
| 发现风险 flagged | 声明触发规则，生成可回应的 finding |
| 信息不足 needs_input | 无法判定，展开缺失字段及下一步 |
| 未触发 no_signal | 已填信息未触发此条规则，未验证科学结论 |
| 不适用 not_applicable | 按声明范围或图表适用性不适用，未自动核对正文措辞 |

规则只检查声明。不会阅读上传正文、做图像比对、重算统计、验证独立性或自动抽取研究事实。Agent 只能提出有依据的建议，研究者通过页面保存声明。没有干预是复核因果识别设计的提示，不是宣称所有无干预设计都不能识别因果。

## 数据契约

create_claim / revise_claim 增加可选 metadata 对象：

| 字段 | 值 |
| --- | --- |
| analysisUnit | cell / donor / sample / other |
| biologicalReplicates | 0–1000000 的整数；独立生物重复，非细胞数 |
| perturbation | true / false；未知省略 |
| figureApplicable | true / false；未知省略 |
| figureSourceMatched | true / false；未知省略 |
| basis | 可选、非空、至多 2000 字符的依据定位说明 |

不进行字符串到布尔值或数值的宽松转换；未知不能写成 null 或空字符串。拒绝额外字段、负数、分数、非有限值及“不涉及图表但同时声明匹配结果”的矛盾组合。页面会把空表单值转换为省略字段；选择不涉及会清空并禁用匹配项。

修订时省略 metadata 保留原声明；传入对象是完整替换，`{}` 明确清空为未知。已有调用继续兼容。metadata 仅允许研究者页面通道写入，未新增 Agent 代填权限。

只有 cohort/population 进入单位与重复数检查；只有 causal 进入干预声明检查。other 单位需要人工解释，确定性规则保留信息不足。已有旧数据只填 figureSourceMatched 的情况仍可触发对应规则，避免破坏旧档案兼容性。

## 持久报告与历史

`locus.review({sessionId, expectedRevision})` 返回 `ruleReview` 和 `summary`；报告含每项 outcome、missingFields、declared、rationale、nextStep，并与检查 revision、snapshotHash、checkedAt、rulesVersion 绑定。summary 包括 claims、flagged、needsInput、noSignal、notApplicable 和缺失字段出现次数 missingFields。已触发项也可能仍有缺失字段，应查看明细。

报告保存在 state.metadataReviews；空会话也有明确的零论断报告。重复检查保留执行记录，但不会在同一快照和规则版本下重复生成 finding。只修改 metadata 也会改变输入快照，使旧意见和决定过期。回放显示真实前后声明以及当轮报告的中文说明，不用当前内容补造旧记录。

旧档案读入保持原字节，不静默迁移。执行新检查时，旧版本的确定性 finding 及其决定转为过期，保留历史。原始输入快照封装中的 metadata-checks.v1 标签继续保留以验证旧摘要；实际执行规则明确记录为报告及 finding 上的 metadata-checks.v2。后续更改规则语义必须处理版本兼容，不能悄悄改变已保存报告的解释。

## 本地验证

完整检查通过 54 项测试，包含真实空白会话而非仅预置示例：未知与 false 区分、三条规则触发、非法输入原子拒绝、Agent 禁止代填、仅修改 metadata 后历史过期、清空与省略的区别、持久重载、旧档案原样读入、报告篡改拒绝、MCP 结构化报告及历史回放。

浏览器通过普通页面创建两个合成验收论断：

1. 人群论断未填信息，得到 0 风险、2 信息不足、1 不适用；补充细胞单位与图表不匹配，得到两项风险。
2. 新建因果论断时明确没有干预、不涉及图表，触发第三条规则，两个论断合计三项风险。
3. 仅将干预改为“有”，旧意见过期，新报告为未触发；再清空为未知，显示信息不足并自动展开具体问题。
4. 刷新后声明仍在；回放保留前后字段与当时的报告，不随当前声明改写。

隔离安装包的 stdio 验证也从空白会话创建两个带 metadata 的论断，检查六项覆盖结果、三项风险，并在服务重启后确认报告和意见持久存在。构建校验记录在本地 artifacts/marketplace-verification.json；它验证本地打包产物，不证明原生宿主已安装或科学有效。

共审技能的入口、references、scripts、assets 随本地安装包一起构建。新增 references/metadata-checks.md 要求读取明确的覆盖结果、提问补充未知项，禁止用 findings 为空替代审查结论。
