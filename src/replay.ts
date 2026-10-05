import type { Actor, AuditEvent, Claim, ReviewSnapshot, ReviewState } from './domain.js';
import { metadataLabels, summarizeChecks, type ClaimMetadata } from './metadata-review.js';
import { describeValue, designKeys, NOT_DECLARED } from './design-fields.js';

export interface ReplayChange {
  label: string;
  /** Empty string means known absence; null means unavailable, never an invented old value. */
  before: string | null;
  after: string | null;
}
export interface ReplayStep {
  id: string;
  revision: number;
  at: string;
  actor: Actor;
  title: string;
  target: string;
  summary: string;
  changes: ReplayChange[];
  availability: 'complete' | 'summary_only';
}
export interface DiffLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
  beforeLine: number | null;
  afterLine: number | null;
}
export interface LineDiff { lines: DiffLine[]; truncated: boolean }

// Exact, stable input fingerprint produced by domain.ts createDemoState() for
// metadata-checks.v1 / research-locus.review.v1. It identifies only this shipped
// synthetic baseline, not scientific correctness. Unknown fixture versions are
// summarized instead of guessing their initial text. No domain runtime import.
const SHIPPED_FIXTURE_SNAPSHOT = '91c80edec997993b9fb86d1bd968e41143d6ee71be396904f7c0e28f78839fa4';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}
function payload(snapshot: ReviewSnapshot): Omit<ReviewSnapshot, 'hash'> {
  const { hash: _hash, ...value } = snapshot;
  return value;
}
function same(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }
function unique<T>(values: T[]): T | undefined { return values.length === 1 ? values[0] : undefined; }
function describeMetadata(metadata: ClaimMetadata): string {
  return [...designKeys.map(key => `${metadataLabels[key]}：${describeValue(key,metadata[key])}`), `${metadataLabels.basis}：${metadata.basis ?? '未填写'}`].join('\n');
}
function describeDecision(action: Extract<AuditEvent['action'], { type: 'intervene' }>): string {
  const labels = { challenge: '提出异议', dismiss: '不采纳意见', defer: '暂缓判断', accept_with_limits: '带限制接受' };
  return `${labels[action.decision]}\n理由：${action.rationale}${action.conditions?.length ? `\n条件：${action.conditions.join('\n')}` : ''}`;
}

/** Read-only event playback. stateHash is a full-state integrity hash, never an input snapshot ID. */
export function buildReplaySteps(state: ReviewState): ReplayStep[] {
  const snapshots = state.snapshots.filter(item => item.projectId === state.projectId && item.rulesVersion === 'metadata-checks.v1');
  const byPayload = new Map<string, ReviewSnapshot[]>();
  const bySize = new Map<string, ReviewSnapshot[]>();
  for (const item of snapshots) {
    const key = canonical(payload(item));
    byPayload.set(key, [...(byPayload.get(key) ?? []), item]);
    const size = `${item.claims.length}:${item.resourceRefs.length}`;
    bySize.set(size, [...(bySize.get(size) ?? []), item]);
  }
  const exact = (value: Omit<ReviewSnapshot, 'hash'>): ReviewSnapshot | undefined => unique(byPayload.get(canonical(value)) ?? []);
  const steps: ReplayStep[] = [];
  const previousDecisions = new Map<string, string>();
  let current: ReviewSnapshot | undefined;
  let status: 'active' | 'paused' | undefined;
  let previousRevision = -1;
  let decisionHistoryComplete = false;

  for (const event of state.events) {
    const contiguous = event.revision === previousRevision + 1;
    if (!contiguous) { current = undefined; status = undefined; previousDecisions.clear(); decisionHistoryComplete = false; }
    previousRevision = event.revision;
    const step: ReplayStep = {
      id: event.id, revision: event.revision, at: event.at, actor: { ...event.actor },
      title: '历史操作', target: '', summary: '', changes: [], availability: 'summary_only',
    };
    const action = event.action;
    // New events bind both exact input snapshots; legacy events retain the
    // conservative reconstruction path below without rewriting their hashes.
    if (event.beforeSnapshotHash) current = unique(snapshots.filter(item => item.hash === event.beforeSnapshotHash));
    switch (action.type) {
      case 'add_claim_relation': case 'remove_claim_relation': {
        const relation = action.type === 'add_claim_relation' ? action : current?.claimRelations?.find(item => item.id === action.relationId);
        const label = relation ? ({ supports:'支持',depends_on:'依赖',contradicts:'矛盾' }[relation.kind]) : '';
        step.title = action.type === 'add_claim_relation' ? '建立论断关系' : '移除论断关系';
        step.target = relation ? `${relation.sourceClaimId} → ${relation.targetClaimId}` : action.type === 'remove_claim_relation' ? action.relationId : '';
        step.summary = action.rationale;
        if (relation) { step.changes = [{ label:'论断关系', before:action.type === 'add_claim_relation' ? '' : label, after:action.type === 'add_claim_relation' ? label : '' }]; step.availability = 'complete'; }
        break;
      }
      case 'set_claim_disposition': {
        step.title = action.disposition === 'rejected' ? '驳回论断' : '重新启用论断'; step.target = action.claimId; step.summary = action.rationale;
        const before = current?.claims.find(item=>item.id===action.claimId);
        if (before) { step.changes=[{label:'论断处理状态',before:before.disposition??'active',after:action.disposition}]; step.availability='complete'; }
        break;
      }
      case 'acknowledge_re_review':
        step.title = '确认已处理局部重审'; step.target=action.claimId; step.summary=`${action.rationale}；这是复核记录，不提升证据等级。`; step.availability='complete'; break;
      case 'link_evidence_requirement': {
        step.title='关联补证材料'; step.target=action.claimId; step.summary=action.rationale;
        const previous=state.evidenceLinks?.filter(item=>item.claimId===action.claimId && item.requirementId===action.requirementId && item.revision<event.revision).at(-1);
        step.changes=[{label:action.requirementId,before:previous?.resourceIds.join('\n')??'',after:action.resourceIds.join('\n')}]; step.availability='complete'; break;
      }
      case 'apply_revision_proposal': {
        const finding=state.findings.find(item=>item.id===action.findingId), proposal=finding?.revisionProposal;
        step.title='逐项采纳修订提案'; step.target=finding?.claimId??action.findingId; step.summary=action.rationale;
        const before=current?.claims.find(item=>item.id===finding?.claimId);
        if (proposal && before) {
          if (action.acceptText) step.changes.push({label:'论断内容',before:before.text,after:proposal.text??null});
          if (action.acceptScope) step.changes.push({label:'论断范围',before:before.scope,after:proposal.scope??null});
          for (const need of proposal.evidenceNeeds??[]) if (action.evidenceNeedIds.includes(need.id)) step.changes.push({label:`补证计划 · ${need.category}`,before:'',after:need.description});
          step.availability='complete';
        }
        break;
      }
      case 'propose_design': {
        step.title = '提取研究设计候选'; step.target = action.claimId;
        step.summary = 'Agent 候选尚未写入研究设计卡，等待研究者确认。';
        step.changes = action.candidates.map(candidate => ({ label: metadataLabels[candidate.field], before:'', after:`候选：${describeValue(candidate.field,candidate.value)}\n解释：${candidate.rationale}\n${candidate.evidence.map(e => `${e.resourceId} · ${e.locator}\n${e.quote}`).join('\n')}` }));
        step.availability = 'complete'; break;
      }
      case 'confirm_design': {
        const proposal = state.designProposals?.find(p => p.id === action.proposalId && p.resolvedRevision === event.revision);
        step.title = action.selectedFields.length ? '确认研究设计候选' : '驳回研究设计候选'; step.summary = action.rationale;
        const before = current?.claims.find(c => c.id === proposal?.claimId);
        if (proposal && before && current) {
          step.target = before.id;
          if (!action.selectedFields.length) { step.availability = 'complete'; break; }
          const metadata: Record<string,unknown> = { ...before.metadata };
          for (const candidate of proposal.candidates) if (action.selectedFields.includes(candidate.field)) metadata[candidate.field] = candidate.value;
          if (metadata.figureApplicable === false && !action.selectedFields.includes('figureSourceMatched')) metadata.figureSourceMatched = NOT_DECLARED;
          const after = exact({ ...payload(current), claims: current.claims.map(c => c.id === before.id ? { ...c,metadata:metadata as ClaimMetadata } : c) });
          if (after) { step.changes = [{ label:'研究者确认的设计声明',before:describeMetadata(before.metadata),after:describeMetadata(metadata as ClaimMetadata) }]; step.availability = 'complete'; }
          current = after;
        } else current = undefined;
        break;
      }
      case 'fixture_created': case 'workspace_created': {
        const first = steps.length === 0 && event.revision === 0;
        decisionHistoryComplete = first;
        current = first ? unique(snapshots.filter(item => action.type === 'fixture_created'
          ? item.hash === SHIPPED_FIXTURE_SNAPSHOT
          : item.claims.length === 0 && item.resourceRefs.length === 0)) : undefined;
        status = first ? 'active' : undefined;
        step.title = action.type === 'fixture_created' ? '载入合成示例' : '创建空白会话';
        step.target = state.title;
        step.summary = current
          ? `保留的初始快照：${current.claims.length} 条论断，${current.resourceRefs.length} 个资源。没有生成聊天记录或科学批准。`
          : '无法确定完整初始输入快照；仅保留真实初始化事件，不推测旧内容。';
        step.availability = current ? 'complete' : 'summary_only';
        break;
      }
      case 'revise_claim': {
        step.title = '修改论断'; step.target = action.claimId; step.summary = action.rationale;
        const before = current?.claims.find(claim => claim.id === action.claimId);
        const expected = current && before ? {
          ...payload(current),
          claims: current.claims.map(claim => claim.id === action.claimId ? { ...claim, text: action.text, ...(action.scope === undefined ? {} : { scope: action.scope }), ...(action.metadata === undefined ? {} : { metadata: action.metadata }) } : claim),
        } : undefined;
        const afterSnapshot = expected ? exact(expected) : undefined;
        const after = afterSnapshot?.claims.find(claim => claim.id === action.claimId);
        if (before && after) {
          if (before.text !== after.text) step.changes.push({ label: '论断内容', before: before.text, after: after.text });
          if (before.scope !== after.scope) step.changes.push({ label: '论断范围', before: before.scope, after: after.scope });
          if (!same(before.metadata, after.metadata)) step.changes.push({ label: '审查信息（研究者声明）', before: describeMetadata(before.metadata), after: describeMetadata(after.metadata) });
          step.availability = 'complete';
          if (!step.changes.length) step.summary += '（内容、范围与审查信息未变化）';
        }
        current = afterSnapshot;
        break;
      }
      case 'create_claim': {
        step.title = '新建论断'; step.summary = action.rationale;
        const before = current;
        const candidates = before ? (bySize.get(`${before.claims.length + 1}:${before.resourceRefs.length}`) ?? []).filter(candidate => {
          if (event.afterSnapshotHash && candidate.hash !== event.afterSnapshotHash) return false;
          if (!same(candidate.claimRelations, before.claimRelations)) return false;
          if (!same(candidate.resourceRefs, before.resourceRefs) || !same(candidate.claims.slice(0, -1), before.claims)) return false;
          const added = candidate.claims.at(-1)!;
          const expected: Claim = { id: added.id, text: action.text, scope: action.scope, resourceIds: [], metadata: action.metadata ?? {}, evidenceCeiling: 'NOT_ASSESSED' };
          return !before.claims.some(claim => claim.id === added.id) && same(added, expected);
        }) : [];
        current = unique(candidates);
        const added = current?.claims.at(-1);
        if (added) {
          step.target = added.id;
          step.changes = [{ label: '论断内容', before: '', after: added.text }, { label: '论断范围', before: '', after: added.scope }];
          if (Object.keys(added.metadata).length) step.changes.push({ label: '审查信息（研究者声明）', before: '', after: describeMetadata(added.metadata) });
          step.availability = 'complete';
        }
        break;
      }
      case 'import_computational_receipt': case 'record_doi_verification': {
        const receipt=action.type==='import_computational_receipt';
        step.title=receipt?'导入计算回执':'记录 DOI 核验'; step.target=action.claimId;
        step.summary=receipt?`${action.rationale}；保留已选文件和哈希绑定，不证明执行或科学有效性。`:`实际完成：${action.result.actualLayers.join('、')}；存在性 ${action.result.existence}，元数据 ${action.result.metadata}；未核验内容支持与科学有效性。`;
        const before=current;
        const after=event.afterSnapshotHash?unique(snapshots.filter(item=>item.hash===event.afterSnapshotHash)):undefined;
        const added=after?.resourceRefs.at(-1);
        const resource=added?state.resources.find(item=>item.id===added.id):undefined;
        if(before && after && resource && added && !before.resourceRefs.some(item=>item.id===added.id) && same(after.resourceRefs.slice(0,-1),before.resourceRefs) && same(after.claimRelations,before.claimRelations) && same(after.claims,before.claims.map(claim=>claim.id===action.claimId?{...claim,resourceIds:[...claim.resourceIds,added.id]}:claim)) && resource.content===JSON.stringify(receipt?action.receipt:action.result)) {
          step.changes=[{label:receipt?'计算回执与字节绑定':'DOI 分层核验记录',before:'',after:JSON.stringify(receipt?resource.computationReceipt:resource.doiVerification,null,2)}];
          step.availability='complete';
        }
        current=after; break;
      }
      case 'attach_evidence': {
        step.title = '导入证据文本'; step.target = action.claimId;
        step.summary = `记录文件 ${action.name}；导入不等于内容验证。`;
        const before = current;
        const candidates = before ? (bySize.get(`${before.claims.length}:${before.resourceRefs.length + 1}`) ?? []).filter(candidate => {
          if (event.afterSnapshotHash && candidate.hash !== event.afterSnapshotHash) return false;
          if (!same(candidate.claimRelations, before.claimRelations)) return false;
          if (!same(candidate.resourceRefs.slice(0, -1), before.resourceRefs)) return false;
          const added = candidate.resourceRefs.at(-1)!;
          const resource = state.resources.find(item => item.id === added.id);
          if (!resource || resource.content !== action.content || resource.sha256 !== added.sha256 || before.resourceRefs.some(item => item.id === added.id)) return false;
          const { content: _content, ...reference } = resource;
          if (!same(added, reference) || added.name !== action.name || added.mediaType !== action.mediaType || added.sourceKind !== (action.sourceKind ?? 'user_upload') || added.sourceUri !== action.sourceUri) return false;
          if (!before.claims.some(claim => claim.id === action.claimId)) return false;
          const claims = before.claims.map(claim => claim.id === action.claimId ? { ...claim, resourceIds: [...claim.resourceIds, added.id] } : claim);
          return same(candidate.claims, claims);
        }) : [];
        current = unique(candidates);
        const added = current?.resourceRefs.at(-1);
        if (added) {
          step.target = `${action.claimId} · ${added.name}`;
          step.changes = [{ label: `${added.name} · 文本`, before: '', after: action.content }];
          step.availability = 'complete';
        }
        break;
      }
      case 'pause': case 'resume': {
        const nextStatus = action.type === 'pause' ? 'paused' : 'active';
        step.title = action.type === 'pause' ? '暂停审查' : '恢复审查';
        step.summary = '实际记录的审查状态操作。';
        step.changes = [{ label: '审查状态', before: status ?? null, after: nextStatus }];
        step.availability = status === undefined ? 'summary_only' : 'complete';
        status = nextStatus;
        break;
      }
      case 'run_review': {
        step.title = '运行元数据规则检查';
        step.summary = '事件记录了规则检查操作，未单独记录本轮新增意见清单；不推测检查结果，也不表示科学验证。';
        const report = state.metadataReviews?.find(item => item.revision === event.revision);
        const anchored = report && unique(snapshots.filter(item => item.hash === report.snapshotHash));
        if (report && anchored) {
          current = anchored;
          const counts = summarizeChecks(report.checks);
          step.summary = `本轮保存了 ${counts.claims} 个论断的报告：${counts.flagged} 项风险，${counts.needsInput} 项信息不足，${counts.noSignal} 项未触发，${counts.notApplicable} 项不适用。规则 ${report.rulesVersion}；不是科学确认。`;
          const outcomes = { flagged: '发现风险', needs_input: '信息不足', no_signal: '未触发本规则', not_applicable: '不适用' };
          const description = anchored.claims.map(claim => [
            `论断：${claim.text}`, describeMetadata(claim.metadata),
            ...report.checks.filter(check => check.claimId === claim.id).map(check => [
              `${check.title}：${outcomes[check.outcome]}`, check.rationale,
              ...(check.missingFields.length ? [`待补充：${check.missingFields.map(key => metadataLabels[key]).join('、')}`] : []),
              ...(check.nextStep ? [`下一步：${check.nextStep}`] : []),
            ].join('\n')),
          ].join('\n')).join('\n\n');
          step.changes = [{ label: '本轮规则检查报告', before: '', after: description || '暂无论断可检查。' }];
          step.availability = 'complete';
        }
        break;
      }
      case 'add_finding': {
        step.title = '提交审阅建议'; step.target = action.claimId;
        step.summary = `${action.title}；建议来源为 Agent，未转成人工决定。`;
        // This action explicitly carries an input snapshot ID; it can restore
        // an otherwise unavailable replay anchor without abusing stateHash.
        const anchored = unique(snapshots.filter(item => item.hash === action.snapshotHash));
        if (anchored && (!current || current.hash === anchored.hash) && anchored.claims.some(claim => claim.id === action.claimId)) {
          current = anchored;
          step.changes = [{ label: '建议标题', before: '', after: action.title }, { label: '建议依据', before: '', after: action.rationale }];
          if (action.revisionProposal) step.changes.push({label:'未采纳的修订提案',before:'',after:JSON.stringify(action.revisionProposal,null,2)});
          step.availability = 'complete';
        }
        break;
      }
      case 'intervene': {
        const finding = state.findings.find(item => item.id === action.findingId);
        const description = describeDecision(action);
        step.title = '记录研究者处理'; step.target = finding?.claimId ?? action.findingId;
        step.summary = `${action.rationale}；渠道身份为声明，未独立认证；证据等级不因选择而提升。`;
        if (current && finding?.snapshotHash === current.hash) {
          const before = previousDecisions.get(action.findingId) ?? (decisionHistoryComplete ? '' : null);
          step.changes = [{ label: '研究者处理', before, after: description }];
          step.availability = before === null ? 'summary_only' : 'complete';
        }
        // The actual event still establishes the most recent stated choice,
        // even when its earlier snapshot or predecessor is unavailable.
        previousDecisions.set(action.findingId, description);
        break;
      }
      default:
        step.summary = '当前回放器不支持此事件类型，未推断内容变化。';
        current = undefined;
    }
    if (event.afterSnapshotHash) current = unique(snapshots.filter(item => item.hash === event.afterSnapshotHash));
    if (['revise_claim', 'create_claim', 'attach_evidence'].includes(action.type) && step.availability === 'summary_only') {
      step.summary += ' 未保留可唯一匹配的前后输入快照；不推测旧文本或新对象 ID。';
    }
    if (!contiguous) step.summary += ' 事件版本不连续，之前的回放锚点已丢弃。';
    steps.push(step);
  }
  return steps;
}

function boundedOption(value: number | undefined, fallback: number, maximum: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.min(maximum, Math.floor(value)));
}

/**
 * Bounded linear line diff: common prefix/suffix plus explicit middle replacement.
 * Deliberately not an LCS/minimal-edit algorithm; distant edits may form one block.
 * Both input scanning and output size are capped, with omissions reported.
 */
export function diffLines(before: string, after: string, options: { maxLines?: number; maxCharacters?: number } = {}): LineDiff {
  const maxLines = boundedOption(options.maxLines, 240, 1000);
  const maxCharacters = boundedOption(options.maxCharacters, 50_000, 200_000);
  const maxInputLines = Math.min(4000, maxLines * 4);
  let truncated = before.length > maxCharacters || after.length > maxCharacters;
  const split = (input: string): string[] => {
    if (!input) return [];
    const lines = input.slice(0, maxCharacters).split('\n');
    if (lines.length > maxInputLines) truncated = true;
    return lines.slice(0, maxInputLines);
  };
  const left = split(before), right = split(after);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix += 1;
  const lines: DiffLine[] = [];
  const append = (line: DiffLine) => { if (lines.length < maxLines) lines.push(line); else truncated = true; };
  for (let i = 0; i < prefix; i += 1) append({ kind: 'context', text: left[i]!, beforeLine: i + 1, afterLine: i + 1 });
  for (let i = prefix; i < left.length - suffix; i += 1) append({ kind: 'remove', text: left[i]!, beforeLine: i + 1, afterLine: null });
  for (let i = prefix; i < right.length - suffix; i += 1) append({ kind: 'add', text: right[i]!, beforeLine: null, afterLine: i + 1 });
  for (let i = 0; i < suffix; i += 1) {
    const li = left.length - suffix + i, ri = right.length - suffix + i;
    append({ kind: 'context', text: left[li]!, beforeLine: li + 1, afterLine: ri + 1 });
  }
  return { lines, truncated };
}
