import type { Claim, Finding, ReviewState } from '../domain.js';

export const METADATA_RULES_VERSION = 'metadata-checks.v2' as const;
export interface ClaimMetadata {
  biologicalReplicates?: number;
  analysisUnit?: 'cell' | 'donor' | 'sample' | 'other';
  perturbation?: boolean;
  figureApplicable?: boolean;
  figureSourceMatched?: boolean;
  basis?: string;
}
export type RuleOutcome = 'flagged' | 'needs_input' | 'no_signal' | 'not_applicable';
export interface RuleCheck {
  claimId: string;
  ruleId: 'META-DESIGN-001' | 'META-CAUSAL-001' | 'META-SOURCE-001';
  outcome: RuleOutcome;
  title: string;
  rationale: string;
  nextStep: string;
  missingFields: Array<keyof ClaimMetadata>;
  declared: ClaimMetadata;
  severity: Finding['severity'];
  category: Finding['category'];
}
export interface MetadataReview {
  rulesVersion: typeof METADATA_RULES_VERSION;
  snapshotHash: string;
  revision: number;
  checkedAt: string;
  checks: RuleCheck[];
}
export const metadataLabels: Record<keyof ClaimMetadata, string> = {
  analysisUnit: '统计分析单位', biologicalReplicates: '独立生物重复数', perturbation: '是否有扰动或干预实验',
  figureApplicable: '是否涉及图表与源数据对应', figureSourceMatched: '图表与源数据是否匹配', basis: '信息依据与定位',
};

/** Deterministic declared-input checks. Missing is never coerced to false. */
export function assessClaimV2(claim: { id: string; scope: string; metadata: ClaimMetadata }): RuleCheck[] {
  const m = claim.metadata;
  const base = { claimId: claim.id, declared: structuredClone(m), missingFields: [] as Array<keyof ClaimMetadata>, nextStep: '', outcome: 'not_applicable' as RuleOutcome };
  const design: RuleCheck = { ...base, ruleId: 'META-DESIGN-001', title: '分析单位与外推范围', rationale: '当前声明的范围不是队列或人群外推，本规则不适用。', severity: 'critical', category: 'design' };
  if (['population', 'cohort'].includes(claim.scope)) {
    design.missingFields = (['analysisUnit', 'biologicalReplicates'] as const).filter(key => m[key] === undefined);
    if (m.analysisUnit === 'cell') {
      Object.assign(design, { outcome: 'flagged', rationale: '声明以细胞为统计分析单位，却作队列或人群层面的结论。需要核对独立重复及嵌套结构；本规则未重算统计，也不直接认定伪重复。', nextStep: '说明供体／个体层级的独立性、聚合或层级模型；必要时缩小外推范围。' });
    } else if (m.biologicalReplicates !== undefined && m.biologicalReplicates < 2) {
      Object.assign(design, { outcome: 'flagged', rationale: '声明的独立生物重复数小于 2，却作队列或人群外推。需核对设计与结论边界；这不是样本量或统计功效的完整评估。', nextStep: '确认计数是否正确，并说明跨个体外推的依据或将结论限定为本样本。' });
    } else if (design.missingFields.length || m.analysisUnit === 'other') {
      Object.assign(design, { outcome: 'needs_input', rationale: '尚不能判断分析单位与外推范围是否匹配。', nextStep: m.analysisUnit === 'other' ? '请在依据中说明实际分析单位；本规则不能自动评估其他单位，需要定向方法复核。' : '补充统计分析单位和独立生物重复数；不能用细胞数或技术重复数代替。' });
    } else {
      Object.assign(design, { outcome: 'no_signal', rationale: '已填信息未触发本条单位／重复风险规则；未核验独立性、混杂或统计功效。', nextStep: '结合所选材料进一步核对设计和不确定性。' });
    }
  }
  const causal: RuleCheck = { ...base, ruleId: 'META-CAUSAL-001', title: '因果论断与实验声明', rationale: '当前范围未声明为因果结论，本规则不适用；未自动分析文字中的因果措辞。', severity: 'critical', category: 'claim_scope' };
  if (claim.scope === 'causal') {
    if (m.perturbation === undefined) Object.assign(causal, { outcome: 'needs_input', missingFields: ['perturbation'], rationale: '尚未填写扰动／干预信息，不能判断为“没有实验”。', nextStep: '明确是否有扰动或干预实验，并在依据中说明实验或其他因果识别设计。' });
    else if (!m.perturbation) Object.assign(causal, { outcome: 'flagged', rationale: '研究者明确声明没有扰动或干预实验，却作因果结论。需提供其他因果识别依据或限定措辞；本规则不排除其他有效设计。', nextStep: '补充因果识别假设和验证依据，或改为关联性论断。' });
    else Object.assign(causal, { outcome: 'no_signal', rationale: '声明有扰动或干预，未触发“缺少扰动声明”规则；并不证明实验充分或因果结论成立。', nextStep: '继续核对对照、混杂、干预特异性与适用范围。' });
  }
  const source: RuleCheck = { ...base, ruleId: 'META-SOURCE-001', title: '图表与源数据对应', rationale: '研究者声明此论断不涉及图表与源数据对应，本规则不适用。', severity: 'warning', category: 'provenance' };
  if (m.figureApplicable !== false) {
    if (m.figureSourceMatched === false) Object.assign(source, { outcome: 'flagged', rationale: '研究者明确声明图表与源数据不匹配。需核对图、表和生成流程；未进行图像分析或文件内容比对。', nextStep: '定位图表编号、源文件和生成步骤，修正对应关系后重新检查。' });
    else if (m.figureSourceMatched === true) Object.assign(source, { outcome: 'no_signal', rationale: '研究者声明图表与源数据匹配，未触发不匹配规则；这一声明尚未独立验证。', nextStep: '保留图表编号、源文件与生成步骤，必要时独立复核。' });
    else Object.assign(source, { outcome: 'needs_input', missingFields: [m.figureApplicable === true ? 'figureSourceMatched' : 'figureApplicable'], rationale: '图表适用性或对应情况尚不明确，不能当作来源一致。', nextStep: m.figureApplicable === true ? '填写图表与源数据是否匹配；不确定时保留未知并定位待核对材料。' : '先说明本论断是否涉及图表与源数据对应；不涉及可明确选择“不涉及”。' });
  }
  return [design, causal, source];
}
