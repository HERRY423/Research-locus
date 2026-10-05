import { undeclared, type DesignField } from '../design-fields.js';
import { result, type RuleDefinition } from './types.js';
export function conditionalRule(config: Omit<RuleDefinition,'evaluate'> & { applies: DesignField; question: DesignField; riskyValue: boolean; risk: string; next: string }): RuleDefinition {
  return { ...config, evaluate({ metadata }) {
    if (metadata[config.applies] === false) return result('not_applicable','研究者明确声明此场景不适用。');
    if (undeclared(metadata[config.applies])) return result('needs_input','适用性为 NOT_DECLARED，尚不能跳过此规则。',config.next,[config.applies]);
    if (undeclared(metadata[config.question])) return result('needs_input','关键设计信息为 NOT_DECLARED。',config.next,[config.question]);
    return metadata[config.question] === config.riskyValue ? result('flagged',config.risk,config.next) : result('no_signal','已填声明未触发此规则；声明与方法仍需核验。',config.next);
  } };
}
