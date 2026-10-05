import type { ReviewState } from './domain.js';
import { isClaimSnapshotCurrent } from './claim-graph.js';
import { evaluateRules } from './rules/index.js';
import { undeclared } from './design-fields.js';

export type EvidenceCategory = 'source' | 'design' | 'analysis' | 'replication' | 'causal' | 'provenance' | 'validation' | 'other';
export interface EvidencePlanItem {
  id: string; category: EvidenceCategory; title: string; description: string;
  status: 'missing' | 'declared' | 'provided' | 'needs_review';
  resourceIds: string[]; origin: 'baseline' | 'rule' | 'proposal' | 'dependency' | 'receipt'; linkable: boolean;
}

/** A planning checklist, not an evidence score or an automatic scientific assessment. */
export function evidencePlan(state: ReviewState, claimId: string): EvidencePlanItem[] {
  const claim = state.claims.find(item => item.id === claimId);
  if (!claim) return [];
  const m = claim.metadata;
  const resources=state.resources.filter(resource=>claim.resourceIds.includes(resource.id));
  const primaryResources=resources.filter(resource=>resource.evidenceKind!=='doi_verification');
  const items: EvidencePlanItem[] = [
    { id: 'baseline:source', category: 'source', title: '可追溯的原始证据', description: '关联直接支撑本论断的数据、结果表或原文，并保留来源、样本与版本。已上传只表示材料可读，内容仍待核验；DOI 登记查询不是原始研究证据。', status: primaryResources.length ? 'provided' : 'missing', resourceIds: primaryResources.map(resource=>resource.id), origin: 'baseline', linkable: true },
    { id: 'baseline:design', category: 'design', title: '研究设计与样本说明', description: '提供分析单位、独立生物重复、样本纳排和分组方法的原始记录；设计卡中的声明需要材料支撑。', status: !undeclared(m.analysisUnit) && !undeclared(m.biologicalReplicates) ? 'declared' : 'missing', resourceIds: [], origin: 'baseline', linkable: true },
    { id: 'baseline:analysis', category: 'analysis', title: '可复核的分析与不确定性', description: '提供分析方法、参数、效应量和不确定性；按研究设计核对多重检验、批次和敏感性分析。仅勾选设计卡不能证明分析有效。', status: 'missing', resourceIds: [], origin: 'baseline', linkable: true },
  ];
  for(const resource of resources) {
    const receipt=resource.computationReceipt;
    if(receipt) {
      items.push({id:`receipt:${resource.id}:binding`,category:'provenance',title:'计算回执的代码、输入和输出绑定',description:receipt.binding.status==='COMPLETE_BYTES'?'三类文件已逐一核对所提供字节的 SHA-256，绑定摘要已保存；这不证明代码实际产生了这些输出。':'补充缺少的代码、输入或输出原件及其 SHA-256；只有声明摘要而无对应文件时仍为 NOT_PROVIDED。',status:receipt.binding.status==='COMPLETE_BYTES'?'provided':'missing',resourceIds:[resource.id],origin:'receipt',linkable:false});
      items.push({id:`receipt:${resource.id}:execution`,category:'analysis',title:'复核计算状态、失败记录与分析适用性',description:`${receipt.tool.name} ${receipt.tool.version} 声明状态 ${receipt.status}，保留 ${receipt.failures.length} 条失败记录。核对执行记录与本次输入输出是否对应，并复核供体设计、参数和结果；字节一致不替代执行认证或科学评估。`,status:'needs_review',resourceIds:[resource.id],origin:'receipt',linkable:false});
    }
    const doi=resource.doiVerification;
    if(doi) items.push({id:`receipt:${resource.id}:citation`,category:'provenance',title:'引用存在性与登记元数据',description:`实际层级：${doi.actualLayers.join('、')}；存在性 ${doi.existence}；元数据 ${doi.metadata}。${doi.metadata==='not_checked'?'尚未比对题名、年份或作者；请提供待比对字段。':'逐项核对所请求字段及来源差异。'} 此记录不回答论文内容是否支持论断。`,status:doi.existence==='found'&&doi.metadata==='match'?'provided':doi.metadata==='mismatch'?'needs_review':'missing',resourceIds:[resource.id],origin:'receipt',linkable:false});
  }
  if (['cohort', 'population'].includes(claim.scope)) items.push({ id: 'baseline:replication', category: 'replication', title: '独立重复与外推依据', description: claim.scope === 'population' ? '提供供体或独立实验单位层面的复核，以及代表性、外部队列或其他足以支持目标人群外推的证据。' : '提供队列构成、独立重复和聚合或层级分析，明确结论可覆盖的队列边界。', status: typeof m.biologicalReplicates === 'number' ? 'declared' : 'missing', resourceIds: [], origin: 'baseline', linkable: true });
  if (claim.scope === 'causal' || m.causalLanguage === true) items.push({ id: 'baseline:causal', category: 'causal', title: '因果识别与替代解释', description: '提供适用的干预、扰动或明确的因果识别设计，说明对照、混杂与替代解释。观察性研究并非一律不能推断因果，但需要可检验的假设与识别依据。', status: m.perturbation === true ? 'declared' : 'missing', resourceIds: [], origin: 'baseline', linkable: true });
  for (const check of evaluateRules(claim)) {
    if (!['flagged', 'needs_input'].includes(check.outcome)) continue;
    const category: EvidenceCategory = check.category === 'provenance' ? 'provenance' : check.ruleId === 'META-LEAKAGE-001' ? 'validation' : check.ruleId === 'META-DESIGN-001' || check.ruleId === 'META-SAMPLE-001' ? 'design' : check.ruleId === 'META-CAUSAL-001' || check.ruleId === 'META-CORRELATION-001' ? 'causal' : 'analysis';
    items.push({ id: `rule:${check.ruleId}`, category, title: check.title, description: `${check.rationale} ${check.nextStep}`, status: check.outcome === 'flagged' ? 'needs_review' : 'missing', resourceIds: [], origin: 'rule', linkable: true });
  }
  for (const need of claim.evidenceNeeds ?? []) items.push({ id: `proposal:${need.findingId}:${need.id}`, category: need.category, title: '已采纳的补证计划', description: need.description, status: 'missing', resourceIds: [], origin: 'proposal', linkable: true });
  for (const sourceClaimId of new Set((state.reReview ?? []).filter(item => item.claimId === claimId && item.status === 'pending').map(item => item.sourceClaimId))) {
    const source = state.claims.find(item => item.id === sourceClaimId);
    items.push({ id: `dependency:${sourceClaimId}`, category: 'other', title: '重新核对上游依赖', description: `上游论断发生变化：${source?.text ?? sourceClaimId}。重新检查本论断是否仍依赖它，以及已有证据是否仍适用。`, status: 'needs_review', resourceIds: [], origin: 'dependency', linkable: false });
  }
  items.push({ id: 'baseline:assessment', category: 'other', title: '明确范围的科学证据评估', description: '材料补齐后仍须由合适的研究人员评估支持程度、适用范围与剩余不确定性。本版本记录补证进展，证据上限保持 NOT_ASSESSED；不因上传、声明或采纳建议自动升级。', status: 'needs_review', resourceIds: [], origin: 'baseline', linkable: false });
  for (const item of items) {
    if (!item.linkable) continue;
    const link = state.evidenceLinks?.slice().reverse().find(link => link.claimId === claimId && link.requirementId === item.id);
    if (!link || !link.resourceIds.length) continue;
    item.resourceIds = link.resourceIds.filter(id => claim.resourceIds.includes(id));
    item.status = isClaimSnapshotCurrent(state, claimId, link.snapshotHash, link.revision) ? 'provided' : 'needs_review';
    if (item.status === 'needs_review') item.description += ' 已关联材料，但论断或依赖已变化，需要重新确认材料对应关系。';
  }
  return items;
}
