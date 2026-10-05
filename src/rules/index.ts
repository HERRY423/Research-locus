import { designRule } from './design.js';
import { causalRule } from './causal.js';
import { sourceRule } from './source.js';
import { multiplicityRule } from './multiplicity.js';
import { sampleSizeRule } from './sample-size.js';
import { batchRule } from './batch.js';
import { correlationRule } from './correlation.js';
import { thresholdRule } from './threshold.js';
import { leakageRule } from './leakage.js';
import type { RuleDefinition, RuleCheck } from './types.js';
import type { Claim } from '../domain.js';
export const rules: readonly RuleDefinition[] = [designRule,causalRule,sourceRule,multiplicityRule,sampleSizeRule,batchRule,correlationRule,thresholdRule,leakageRule];
export function evaluateRules(claim: Claim, registry: readonly RuleDefinition[] = rules): RuleCheck[] {
  if (new Set(registry.map(rule => rule.id)).size !== registry.length) throw new Error('Duplicate rule IDs');
  return registry.map(rule => {
    const check = rule.evaluate(claim);
    return { ...check, claimId: claim.id, ruleId: rule.id, ruleVersion: rule.version, title: rule.title, severity: rule.severity, category: rule.category, disciplines: [...rule.disciplines], limitation: rule.limitation, declared: structuredClone(claim.metadata), declarationStatus: check.missingFields.length ? 'NOT_DECLARED' : 'DECLARED' };
  });
}
