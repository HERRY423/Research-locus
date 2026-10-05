import { undeclared } from '../design-fields.js';
import { result, type RuleDefinition } from './types.js';
export const designRule: RuleDefinition = {
  id: 'META-DESIGN-001', version: 3, title: '分析单位与外推范围', disciplines: ['实验生物学', '组学', '人群研究'], severity: 'critical', category: 'design',
  limitation: '仅比较声明的单位与范围；不重算统计，不评估层级模型、独立性或功效。',
  evaluate({ scope, metadata: m }) {
    if (!['cohort','population'].includes(scope)) return result('not_applicable','当前范围不是队列或人群外推。');
    const missing = (['analysisUnit','biologicalReplicates'] as const).filter(key => undeclared(m[key]));
    if (m.analysisUnit === 'cell' || (typeof m.biologicalReplicates === 'number' && m.biologicalReplicates < 2)) return result('flagged','声明以细胞为分析单位或独立生物重复少于 2，却作队列或人群结论；需要核对设计。','说明独立重复、聚合或层级模型；必要时缩小外推。',missing);
    if (missing.length || m.analysisUnit === 'other') return result('needs_input','分析单位或重复设计尚不能判定。','补充独立实验单位和生物重复数；其他单位需要说明及方法复核。',missing);
    return result('no_signal','已填声明未触发单位／重复风险。','继续核对独立性和不确定性。');
  },
};
