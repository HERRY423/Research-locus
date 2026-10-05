import { DomainError, parseMetadata, type ReviewState } from './domain.js';
import { designKeys, NOT_DECLARED, type ClaimMetadata, type DesignField } from './design-fields.js';
import { quoteInSelectedResource } from './resource-text.js';
export interface DesignCandidate {
  field: DesignField; value: NonNullable<ClaimMetadata[DesignField]>; rationale: string;
  evidence: Array<{ resourceId: string; quote: string; locator: string }>;
}
export interface DesignProposal {
  id: string; runId: string; claimId: string; snapshotHash: string; resourceIds: string[];
  candidates: DesignCandidate[]; status: 'proposed' | 'confirmed' | 'rejected' | 'stale';
  createdRevision: number; createdAt: string; selectedFields?: DesignField[]; resolvedRevision?: number;
}
const fail = (message: string): never => { throw new DomainError('INVALID_DESIGN', message); };
function record(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Expected candidate object.');
  if (Object.keys(value).some(key => !allowed.includes(key))) return fail('Unexpected candidate field.');
  return value as Record<string,unknown>;
}
const string = (value: unknown, max: number) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : fail('Candidate text is missing or too long.');
export function parseCandidates(value: unknown): DesignCandidate[] {
  if (!Array.isArray(value) || !value.length || value.length > designKeys.length) return fail('Provide 1–16 unique field candidates.');
  const seen = new Set<string>();
  return value.map(item => {
    const row = record(item,['field','value','rationale','evidence']);
    const field = string(row.field,80) as DesignField;
    if (!designKeys.includes(field) || seen.has(field)) return fail('Unknown or duplicated design field.');
    seen.add(field);
    const parsed = parseMetadata({ [field]: row.value });
    if (parsed[field] === undefined) return fail('Use NOT_DECLARED for unknown candidates.');
    if (!Array.isArray(row.evidence) || row.evidence.length > 5) return fail('Invalid evidence list.');
    const evidence = row.evidence.map(item => {
      const e = record(item,['resourceId','quote','locator']);
      return { resourceId: string(e.resourceId,200), quote: string(e.quote,2000), locator: string(e.locator,500) };
    });
    if (parsed[field] !== NOT_DECLARED && !evidence.length) return fail('Known values need a verbatim quote from selected evidence.');
    return { field, value: parsed[field]!, rationale: string(row.rationale,2000), evidence };
  });
}
export function validateProposalEvidence(state: ReviewState, proposal: Pick<DesignProposal,'claimId'|'snapshotHash'|'resourceIds'|'candidates'>) {
  const snapshot = state.snapshots.find(item => item.hash === proposal.snapshotHash);
  const claim = snapshot?.claims.find(item => item.id === proposal.claimId);
  if (!claim || !proposal.resourceIds.length || new Set(proposal.resourceIds).size !== proposal.resourceIds.length || proposal.resourceIds.some(id => !claim.resourceIds.includes(id))) return fail('Extraction must use selected resources belonging to this claim and snapshot.');
  for (const candidate of parseCandidates(proposal.candidates)) for (const cite of candidate.evidence) {
    const resource = state.resources.find(item => item.id === cite.resourceId);
    if (!proposal.resourceIds.includes(cite.resourceId) || !resource || !quoteInSelectedResource(resource,cite.quote,cite.locator)) return fail('Candidate quote is not present verbatim in the selected evidence. Computational receipts require the exact artifact locator from evidenceText.');
  }
}
