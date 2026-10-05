import type { Claim, Finding } from '../domain.js';
import type { ClaimMetadata, DesignField } from '../design-fields.js';
export type RuleOutcome = 'flagged' | 'needs_input' | 'no_signal' | 'not_applicable';
export interface RuleResult { outcome: RuleOutcome; rationale: string; nextStep: string; missingFields: DesignField[] }
export interface RuleDefinition {
  id: string; version: number; title: string; disciplines: string[]; limitation: string;
  severity: Finding['severity']; category: Finding['category']; evaluate(claim: Claim): RuleResult;
}
export interface RuleCheck extends RuleResult {
  claimId: string; ruleId: string; title: string; declared: ClaimMetadata; severity: Finding['severity']; category: Finding['category'];
  ruleVersion?: number; disciplines?: string[]; limitation?: string; declarationStatus?: 'DECLARED' | 'NOT_DECLARED';
}
export const result = (outcome: RuleOutcome, rationale: string, nextStep = '', missingFields: DesignField[] = []): RuleResult => ({ outcome, rationale, nextStep, missingFields });
