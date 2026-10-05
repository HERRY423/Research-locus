import { undeclared } from '../design-fields.js';
import { result, type RuleDefinition } from './types.js';
export const causalRule: RuleDefinition = {
  id: 'META-CAUSAL-001', version: 3, title: '因果论断与实验声明', disciplines: ['实验生物学', '观察性研究'], severity: 'critical', category: 'claim_scope',
  limitation: '有干预不证明因果，无干预也不排除其他有效识别设计；本规则不验证识别假设。',
  evaluate({ scope, metadata: m }) {
    if (scope !== 'causal') return result('not_applicable','当前范围未声明为因果结论。');
    if (undeclared(m.perturbation)) return result('needs_input','扰动／干预信息为 NOT_DECLARED，不能判断为没有实验。','声明是否有扰动或干预，并说明识别设计。',['perturbation']);
    return m.perturbation === false ? result('flagged','明确没有扰动或干预，但作因果结论，需核对其他因果识别依据。','提供识别假设和证据，或限定为关联性表述。') : result('no_signal','声明有扰动，未触发缺少干预规则。','继续核对对照、干预特异性与混杂。');
  },
};
