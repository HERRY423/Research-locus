import { conditionalRule } from './conditional.js';
export const leakageRule = conditionalRule({
  id: 'META-LEAKAGE-001', version: 1, title: '预测验证与数据泄漏', disciplines: ['机器学习', '预测模型研究'], severity: 'critical', category: 'design',
  limitation: '不审计训练代码或数据划分；嵌套验证与具体预处理策略需结合实现复核。',
  applies: 'predictiveModel', question: 'validationLeakage', riskyValue: true,
  risk: '声明验证数据参与训练、预处理拟合或调参，所报独立验证表现可能偏乐观。', next: '检查数据划分、拟合边界与调参流程；在隔离数据上重新评估。',
});
