import { undeclared } from '../design-fields.js';
import { result, type RuleDefinition } from './types.js';
export const sourceRule: RuleDefinition = {
  id: 'META-SOURCE-001', version: 3, title: '图表与源数据对应', disciplines: ['使用图表的定量研究'], severity: 'warning', category: 'provenance',
  limitation: '只检查对应声明，不读取图像、不比对原始数据或生成流程。',
  evaluate({ metadata: m }) {
    if (m.figureApplicable === false) return result('not_applicable','声明不涉及图表与源数据对应。');
    if (typeof m.figureSourceMatched === 'boolean') return m.figureSourceMatched ? result('no_signal','声明匹配，尚未独立核验。','保留图号、源文件及生成流程。') : result('flagged','明确声明图表与源数据不匹配。','定位图表编号、源文件和生成步骤后修正。');
    return result('needs_input','图表适用性或对应信息为 NOT_DECLARED。','先说明是否涉及；涉及时核对匹配情况。',[undeclared(m.figureApplicable) ? 'figureApplicable' : 'figureSourceMatched']);
  },
};
