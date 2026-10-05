import type { Claim, ReviewSnapshot, ReviewState } from './domain.js';

export type ClaimRelationKind = 'supports' | 'depends_on' | 'contradicts';
/** Arrows always run from a premise to the claim it supports, constrains or contradicts. */
export interface ClaimRelation { id: string; sourceClaimId: string; targetClaimId: string; kind: ClaimRelationKind; rationale: string }
export interface ReReviewFlag { claimId: string; sourceClaimId: string; reason: string; createdRevision: number; status: 'pending' | 'acknowledged'; resolvedRevision?: number; rationale?: string }
type Inputs = Pick<ReviewState, 'claims' | 'claimRelations'> & { resources?: ReviewState['resources']; resourceRefs?: ReviewSnapshot['resourceRefs'] };

export function dependencyDescendants(relations: readonly ClaimRelation[], sourceClaimId: string): string[] {
  const seen = new Set<string>(); const queue = [sourceClaimId];
  while (queue.length) {
    const source = queue.shift()!;
    for (const relation of relations) if (relation.kind === 'depends_on' && relation.sourceClaimId === source && !seen.has(relation.targetClaimId)) {
      seen.add(relation.targetClaimId); queue.push(relation.targetClaimId);
    }
  }
  seen.delete(sourceClaimId); return [...seen].sort();
}
export function dependencyAncestors(relations: readonly ClaimRelation[], claimId: string): string[] {
  return dependencyDescendants(relations.map(item => ({ ...item, sourceClaimId: item.targetClaimId, targetClaimId: item.sourceClaimId })), claimId);
}
export function validateClaimRelations(relations: readonly ClaimRelation[], claims: readonly Claim[]): void {
  const ids = new Set(claims.map(item => item.id)); const keys = new Set<string>(); const relationIds = new Set<string>();
  for (const relation of relations) {
    if (!relation || typeof relation.id !== 'string' || !relation.id || relationIds.has(relation.id) || !ids.has(relation.sourceClaimId) || !ids.has(relation.targetClaimId) || relation.sourceClaimId === relation.targetClaimId || !['supports','depends_on','contradicts'].includes(relation.kind) || typeof relation.rationale !== 'string' || !relation.rationale.trim()) throw new Error('Invalid claim relation.');
    // Contradiction is symmetric; two reverse arrows do not create two distinct contradictions.
    const endpoints = relation.kind === 'contradicts' ? [relation.sourceClaimId,relation.targetClaimId].sort() : [relation.sourceClaimId,relation.targetClaimId];
    const key = JSON.stringify([relation.kind,...endpoints]);
    if (keys.has(key)) throw new Error('Duplicate claim relation.');
    keys.add(key); relationIds.add(relation.id);
    if (relation.kind === 'depends_on' && dependencyDescendants(relations.filter(item => item.id !== relation.id),relation.targetClaimId).includes(relation.sourceClaimId)) throw new Error('Dependency cycles are not allowed.');
  }
}
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
}
/** Planning items are not scientific inputs. Preserve scope validity across unrelated dossier edits. */
export function claimInputSignature(source: Inputs, claimId: string): string | null {
  const relations = source.claimRelations ?? [];
  const relevant = new Set([claimId,...dependencyAncestors(relations,claimId)]);
  if (!source.claims.some(item => item.id === claimId)) return null;
  const resources = source.resourceRefs ?? source.resources ?? [];
  const claims = source.claims.filter(item => relevant.has(item.id)).sort((a,b) => a.id.localeCompare(b.id)).map(item => ({
    id: item.id, text: item.text, scope: item.scope, metadata: item.metadata, disposition: item.disposition ?? 'active',
    resources: item.resourceIds.map(id => { const resource = resources.find(entry => entry.id === id); if (!resource) return { id, missing: true }; const { content: _content, ...ref } = resource as ReviewState['resources'][number]; return ref; }).sort((a,b) => a.id.localeCompare(b.id)),
  }));
  return stable({ claims, dependencies: relations.filter(item => item.kind === 'depends_on' && relevant.has(item.targetClaimId)).map(({sourceClaimId,targetClaimId}) => ({sourceClaimId,targetClaimId})).sort((a,b) => `${a.sourceClaimId}:${a.targetClaimId}`.localeCompare(`${b.sourceClaimId}:${b.targetClaimId}`)) });
}
export function isClaimSnapshotCurrent(state: ReviewState, claimId: string, snapshotHash: string, sinceRevision?: number): boolean {
  const preserved = state.snapshots.find(item => item.hash === snapshotHash);
  const previous = preserved && claimInputSignature(preserved,claimId);
  if (!preserved || previous == null || previous !== claimInputSignature(state,claimId)) return false;
  if (sinceRevision === undefined) return true;
  if (!Number.isSafeInteger(sinceRevision) || sinceRevision < 0 || sinceRevision > state.revision) return false;
  const relevant = new Set([claimId,...dependencyAncestors(preserved.claimRelations ?? [],claimId),...dependencyAncestors(state.claimRelations ?? [],claimId)]);
  for (const event of state.events) {
    if (event.revision <= sinceRevision) continue;
    if (event.beforeSnapshotHash !== undefined || event.afterSnapshotHash !== undefined) {
      const before = state.snapshots.find(item => item.hash === event.beforeSnapshotHash);
      const after = state.snapshots.find(item => item.hash === event.afterSnapshotHash);
      if (!before || !after || claimInputSignature(before,claimId) !== claimInputSignature(after,claimId)) return false;
      continue;
    }
    // Older dossiers did not retain per-event input pointers. Fail closed for
    // relevant material actions, while preserving unrelated work and reads.
    const action = event.action;
    if (['revise_claim','attach_evidence','set_claim_disposition'].includes(action.type) && 'claimId' in action && relevant.has(action.claimId)) return false;
    if (action.type === 'confirm_design' && action.selectedFields.length && state.designProposals?.some(item => item.id === action.proposalId && relevant.has(item.claimId))) return false;
    if (action.type === 'apply_revision_proposal' && (action.acceptText || action.acceptScope) && state.findings.some(item => item.id === action.findingId && relevant.has(item.claimId))) return false;
    if (action.type === 'add_claim_relation' && action.kind === 'depends_on' && relevant.has(action.targetClaimId)) return false;
    if (action.type === 'remove_claim_relation' && state.snapshots.some(item => item.claimRelations?.some(relation => relation.id === action.relationId && relation.kind === 'depends_on' && relevant.has(relation.targetClaimId)))) return false;
  }
  return true;
}
