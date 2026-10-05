import { conditionalRule } from './conditional.js';
export const multiplicityRule = conditionalRule({
  id: 'META-MULTIPLE-001', version: 1, title: '多重检验与错误率控制', disciplines: ['组学', '多终点定量研究'], severity: 'warning', category: 'design',
  limitation: '不重算校正、不自动确定检验族；预先定义的层级检验等设计需人工复核。',
  applies: 'multipleTesting', question: 'multiplicityControlled', riskyValue: false,
  risk: '声明涉及多重检验，却没有控制多重检验错误率。', next: '说明检验族、校正或预先确定的控制策略，区分探索性与确认性结论。',
});
