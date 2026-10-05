import { conditionalRule } from './conditional.js';
export const thresholdRule = conditionalRule({
  id: 'META-THRESHOLD-001', version: 1, title: '阈值选择时点', disciplines: ['分组比较', '生物标志物研究', '预测建模'], severity: 'warning', category: 'design',
  limitation: '数据驱动阈值可用于探索；本规则不等同于认定不当行为，也不验证独立验证集。',
  applies: 'thresholdUsed', question: 'thresholdAfterGrouping', riskyValue: true,
  risk: '声明看过分组结果后才确定阈值，存在选择偏倚风险。', next: '标注探索性、记录阈值选择过程，并用预设阈值或独立数据检验。',
});
