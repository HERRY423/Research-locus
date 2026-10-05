export const NOT_DECLARED = 'NOT_DECLARED' as const;
type Declared<T> = T | typeof NOT_DECLARED;
export interface ClaimMetadata {
  analysisUnit?: Declared<'cell' | 'donor' | 'sample' | 'other'>;
  biologicalReplicates?: Declared<number>;
  perturbation?: Declared<boolean>;
  figureApplicable?: Declared<boolean>;
  figureSourceMatched?: Declared<boolean>;
  multipleTesting?: Declared<boolean>;
  multiplicityControlled?: Declared<boolean>;
  sampleSizeReported?: Declared<boolean>;
  batchEffect?: Declared<boolean>;
  batchModeled?: Declared<boolean>;
  associationOnly?: Declared<boolean>;
  causalLanguage?: Declared<boolean>;
  thresholdUsed?: Declared<boolean>;
  thresholdAfterGrouping?: Declared<boolean>;
  predictiveModel?: Declared<boolean>;
  validationLeakage?: Declared<boolean>;
  basis?: string;
}
export const designFields = {
  analysisUnit: { label: '统计分析单位', kind: 'unit' },
  biologicalReplicates: { label: '独立生物重复数', kind: 'number' },
  perturbation: { label: '是否有扰动或干预实验', kind: 'boolean' },
  figureApplicable: { label: '是否涉及图表与源数据对应', kind: 'boolean' },
  figureSourceMatched: { label: '图表与源数据是否匹配', kind: 'boolean' },
  multipleTesting: { label: '是否涉及多重检验', kind: 'boolean' },
  multiplicityControlled: { label: '是否控制多重检验错误率', kind: 'boolean' },
  sampleSizeReported: { label: '是否报告样本量及其计数单位', kind: 'boolean' },
  batchEffect: { label: '是否存在批次效应或批次混杂', kind: 'boolean' },
  batchModeled: { label: '是否在模型或设计中处理批次', kind: 'boolean' },
  associationOnly: { label: '支持材料是否仅提供关联性证据', kind: 'boolean' },
  causalLanguage: { label: '论断是否使用因果措辞', kind: 'boolean' },
  thresholdUsed: { label: '是否使用分组或判定阈值', kind: 'boolean' },
  thresholdAfterGrouping: { label: '是否看过分组结果后才确定阈值', kind: 'boolean' },
  predictiveModel: { label: '是否报告预测模型的验证表现', kind: 'boolean' },
  validationLeakage: { label: '验证数据是否参与训练、预处理拟合或调参', kind: 'boolean' },
} as const;
export type DesignField = keyof typeof designFields;
export const designKeys = Object.keys(designFields) as DesignField[];
export const metadataLabels: Record<keyof ClaimMetadata, string> = { ...Object.fromEntries(designKeys.map(k => [k, designFields[k].label])) as Record<DesignField, string>, basis: '信息依据与定位' };
export const undeclared = (value: unknown) => value === undefined || value === NOT_DECLARED;
export function declaredCard(metadata: ClaimMetadata): ClaimMetadata {
  return { ...Object.fromEntries(designKeys.map(key => [key, metadata[key] ?? NOT_DECLARED])), ...(metadata.basis ? { basis: metadata.basis } : {}) };
}
export function describeValue(key: DesignField, value: unknown): string {
  if (undeclared(value)) return 'NOT_DECLARED（未声明）';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (key === 'analysisUnit') return ({ cell: '细胞', donor: '供体／个体', sample: '独立样本', other: '其他（需解释）' } as Record<string,string>)[String(value)] ?? String(value);
  return String(value);
}
