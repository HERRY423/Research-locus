import type { ClaimScope, Finding, ReviewState } from './domain.js';
import { claimInputSignature, dependencyAncestors, isClaimSnapshotCurrent } from './claim-graph.js';

export const evidenceNeedCategories = ['source','design','analysis','replication','causal','provenance','validation','other'] as const;
export interface EvidenceNeed { id: string; category: typeof evidenceNeedCategories[number]; description: string }
export interface AcceptedEvidenceNeed extends EvidenceNeed { findingId: string }
export interface RevisionProposal { text?: string; scope?: ClaimScope; evidenceNeeds?: EvidenceNeed[] }
export interface RevisionAdoption { id: string; findingId: string; acceptText: boolean; acceptScope: boolean; evidenceNeedIds: string[]; rationale: string; revision: number; snapshotHash: string }
export interface EvidenceLink { claimId: string; requirementId: string; resourceIds: string[]; rationale: string; revision: number; snapshotHash: string }
function validText(value: unknown, max: number): value is string { return typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\0'); }
export function parseRevisionProposal(value: unknown, fail: (message: string) => never = message => { throw new Error(message); }): RevisionProposal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('A revision proposal must be an object.');
  const input = value as Record<string,unknown>; const result: RevisionProposal = {};
  if (Object.keys(input).some(key => !['text','scope','evidenceNeeds'].includes(key))) fail('Unknown revision proposal field.');
  if (input.text !== undefined) { if (!validText(input.text,16000)) fail('Invalid proposed claim text.'); result.text = input.text; }
  if (input.scope !== undefined) { if (!['sample','cohort','population','causal'].includes(input.scope as string)) fail('Invalid proposed scope.'); result.scope = input.scope as ClaimScope; }
  if (input.evidenceNeeds !== undefined) {
    if (!Array.isArray(input.evidenceNeeds) || input.evidenceNeeds.length > 20) fail('Evidence needs must contain at most 20 items.');
    const seen = new Set<string>();
    result.evidenceNeeds = input.evidenceNeeds.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid evidence need.');
      const item = value as Record<string,unknown>;
      if (Object.keys(item).some(key => !['id','category','description'].includes(key)) || !validText(item.id,80) || !/^[A-Za-z0-9_-]{1,80}$/.test(item.id as string) || seen.has(item.id) || !evidenceNeedCategories.includes(item.category as EvidenceNeed['category']) || !validText(item.description,2000)) fail('Invalid or duplicate evidence need.');
      seen.add(item.id); return { id: item.id, category: item.category as EvidenceNeed['category'], description: item.description };
    });
  }
  if (result.text === undefined && result.scope === undefined && !result.evidenceNeeds?.length) fail('A proposal must include text, scope or at least one evidence need.');
  return result;
}

/** A previous partial adoption is the only permitted cause of source-finding staleness. */
export function proposalAvailability(state: ReviewState, finding: Finding): { available: boolean; text: boolean; scope: boolean; evidenceNeedIds: string[]; reason?: string } {
  const proposal = finding.revisionProposal;
  const adoptions = (state.revisionAdoptions ?? []).filter(item => item.findingId === finding.id);
  const selected = new Set(adoptions.flatMap(item => item.evidenceNeedIds));
  const remaining = { text: proposal?.text !== undefined && !adoptions.some(item => item.acceptText), scope: proposal?.scope !== undefined && !adoptions.some(item => item.acceptScope), evidenceNeedIds: (proposal?.evidenceNeeds ?? []).filter(item => !selected.has(item.id)).map(item => item.id) };
  const fail = (reason: string) => ({ ...remaining, available: false, reason });
  if (!proposal) return fail('该审查意见没有修订提案。');
  if (state.reviewStatus === 'paused') return fail('共同审查已暂停。');
  if (!remaining.text && !remaining.scope && !remaining.evidenceNeedIds.length) return fail('所有提案项目均已采纳。');
  if (!adoptions.length) return finding.status === 'active' && isClaimSnapshotCurrent(state,finding.claimId,finding.snapshotHash) ? { ...remaining, available: true } : fail('论断或依赖证据已改变，需要重新提出建议。');
  const preserved = state.snapshots.find(item => item.hash === finding.snapshotHash);
  if (!preserved) return fail('缺少提案原始快照。');
  const expected = structuredClone(preserved); const target = expected.claims.find(item => item.id === finding.claimId)!;
  if (adoptions.some(item => item.acceptText)) target.text = proposal.text!;
  if (adoptions.some(item => item.acceptScope)) target.scope = proposal.scope!;
  if (claimInputSignature(expected,finding.claimId) !== claimInputSignature(state,finding.claimId)) return fail('提案以外的相关内容已改变，需要重新审查。');
  const relevant = new Set([finding.claimId,...dependencyAncestors(state.claimRelations ?? [],finding.claimId)]);
  for (const event of state.events.filter(item => item.revision > adoptions[0]!.revision)) {
    const action = event.action;
    if (action.type === 'apply_revision_proposal' && action.findingId === finding.id) continue;
    if (event.beforeSnapshotHash !== undefined || event.afterSnapshotHash !== undefined) {
      const before = state.snapshots.find(item => item.hash === event.beforeSnapshotHash);
      const after = state.snapshots.find(item => item.hash === event.afterSnapshotHash);
      if (!before || !after || claimInputSignature(before,finding.claimId) !== claimInputSignature(after,finding.claimId)) return fail('提案以外的相关内容曾发生变化，需要重新提出建议。');
      continue;
    }
    // Conservative fallback for history predating retained event snapshots.
    if (['revise_claim','attach_evidence','set_claim_disposition'].includes(action.type) && 'claimId' in action && relevant.has(action.claimId)) return fail('发生了其他相关修订，需要重新提出建议。');
    if (action.type === 'confirm_design' && state.designProposals?.some(item => item.id === action.proposalId && item.status === 'confirmed' && relevant.has(item.claimId))) return fail('研究设计已改变，需要重新提出建议。');
    if (action.type === 'apply_revision_proposal' && action.findingId !== finding.id && state.findings.some(item => item.id === action.findingId && relevant.has(item.claimId))) return fail('已采用另一项相关提案，需要重新审查。');
    if (action.type === 'add_claim_relation' && action.kind === 'depends_on' && relevant.has(action.targetClaimId)) return fail('依赖关系已改变，需要重新审查。');
    if (action.type === 'remove_claim_relation') {
      const relation = preserved.claimRelations?.find(item => item.id === action.relationId);
      if (relation?.kind === 'depends_on' && relevant.has(relation.targetClaimId)) return fail('依赖关系已改变，需要重新审查。');
    }
  }
  return { ...remaining, available: true };
}
