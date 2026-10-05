import { conditionalRule } from './conditional.js';
export const batchRule = conditionalRule({
  id: 'META-BATCH-001', version: 1, title: '批次效应与建模', disciplines: ['组学', '多批次实验研究'], severity: 'warning', category: 'design',
  limitation: '不检测实际批次效应；已处理也不证明消除混杂，完全混杂可能无法统计校正。',
  applies: 'batchEffect', question: 'batchModeled', riskyValue: false,
  risk: '声明存在批次效应或批次混杂，却未在模型或设计中处理。', next: '说明批次与分组对应关系、设计控制和模型处理；核对是否完全混杂。',
});
