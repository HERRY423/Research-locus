import { undeclared } from '../design-fields.js';
import { result, type RuleDefinition } from './types.js';
export const sampleSizeRule: RuleDefinition = {
  id: 'META-SAMPLE-001', version: 1, title: '样本量与计数单位报告', disciplines: ['定量实证研究'], severity: 'warning', category: 'design',
  limitation: '报告样本量不证明功效足够；未在选定材料中找到不等于全文没有报告。',
  evaluate({ metadata: m }) {
    if (undeclared(m.sampleSizeReported)) return result('needs_input','样本量报告状态为 NOT_DECLARED。','说明是否报告各组样本量与计数单位。',['sampleSizeReported']);
    return m.sampleSizeReported === false ? result('flagged','明确声明没有报告样本量及其计数单位。','补充每组独立单位数、排除项与重复层级。') : result('no_signal','声明已报告样本量与计数单位。','核对样本数和独立性；不据此声称功效充分。');
  },
};
