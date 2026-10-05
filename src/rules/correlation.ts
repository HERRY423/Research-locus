import { undeclared } from '../design-fields.js';
import { result, type RuleDefinition } from './types.js';
export const correlationRule: RuleDefinition = {
  id: 'META-CORRELATION-001', version: 1, title: '关联性证据与因果措辞', disciplines: ['观察性研究', '组学', '流行病学'], severity: 'critical', category: 'claim_scope',
  limitation: '因果措辞由研究者确认或 Agent 提候选；规则不自动理解正文，也不评估其他识别设计。',
  evaluate({ scope, metadata: m }) {
    if (scope !== 'causal' && undeclared(m.causalLanguage)) return result('needs_input','是否使用因果措辞为 NOT_DECLARED。','核对论断是否使用导致、驱动等因果表述。',['causalLanguage']);
    if (scope !== 'causal' && m.causalLanguage === false) return result('not_applicable','未声明因果范围或因果措辞。');
    if (undeclared(m.associationOnly)) return result('needs_input','因果表述所依据的证据类型为 NOT_DECLARED。','说明材料是否仅提供关联性证据。',['associationOnly']);
    return m.associationOnly === true ? result('flagged','声明仅有关联性证据，却使用因果范围或措辞。','补充因果识别依据，或改写为关联并重审范围。') : result('no_signal','未声明为仅关联性证据；本规则未触发。','核对超出关联性的识别依据。');
  },
};
