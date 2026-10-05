import type { Claim, ReviewState } from './domain.js';
import { evaluateRules } from './rules/index.js';
import type { RuleCheck } from './rules/types.js';
import { isClaimSnapshotCurrent } from './claim-graph.js';
export { metadataLabels } from './design-fields.js';
export type { ClaimMetadata } from './design-fields.js';
export type { RuleOutcome, RuleCheck } from './rules/types.js';
export const METADATA_RULES_VERSION = 'metadata-checks.v3' as const;
export interface MetadataReview {
  rulesVersion: 'metadata-checks.v2' | typeof METADATA_RULES_VERSION;
  snapshotHash: string; revision: number; checkedAt: string; checks: RuleCheck[];
}
export const assessClaim = (claim: Claim): RuleCheck[] => evaluateRules(claim);
export function summarizeChecks(checks: RuleCheck[]) {
  return { claims: new Set(checks.map(check => check.claimId)).size,
    flagged: checks.filter(check => check.outcome === 'flagged').length,
    needsInput: checks.filter(check => check.outcome === 'needs_input').length,
    noSignal: checks.filter(check => check.outcome === 'no_signal').length,
    notApplicable: checks.filter(check => check.outcome === 'not_applicable').length,
    missingFields: checks.reduce((n, check) => n + check.missingFields.length, 0) };
}
export function currentMetadataReview(state: ReviewState, claimId?: string): MetadataReview | undefined {
  if (claimId) {
    const report = state.metadataReviews?.slice().reverse().find(review => review.rulesVersion === METADATA_RULES_VERSION && review.checks.some(check => check.claimId === claimId) && isClaimSnapshotCurrent(state, claimId, review.snapshotHash, review.revision));
    return report ? { ...report, checks: report.checks.filter(check => check.claimId === claimId) } : undefined;
  }
  const latestEdit = state.events.slice().reverse().find(event => ['create_claim','revise_claim','attach_evidence','confirm_design'].includes(event.action.type))?.revision ?? 0;
  return state.metadataReviews?.slice().reverse().find(review => review.snapshotHash === state.snapshotHash && review.rulesVersion === METADATA_RULES_VERSION && review.revision >= latestEdit);
}
