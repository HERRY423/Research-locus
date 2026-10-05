import type { Resource } from './domain.js';
import type { DoiVerification } from './doi-verification.js';
import type { ComputationalReceipt, HashBinding } from './computational-receipts.js';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
export type IntakeFileGroups = Record<string, File[]>;

export function evidenceIntakeForms(claimId: string, busy: boolean) {
  return `<section class="evidence-intake" aria-label="导入计算回执与核验引用"><h3>计算回执与引用核验</h3><p class="form-help">计算回执保留已经完成或失败的运行材料；导入不会启动计算，也不会自动提升 NOT_ASSESSED。</p>
  <details data-details-key="receipt-generic:${esc(claimId)}"><summary>把 CSV／notebook 输出登记为计算回执</summary><form id="receipt-generic-form" data-draft-key="receipt-generic:${esc(claimId)}"><fieldset ${busy ? 'disabled' : ''}><div class="intake-grid"><label>工具名称<input name="toolName" required maxlength="200" placeholder="例如：DESeq2／分析 notebook"></label><label>工具版本<input name="toolVersion" required maxlength="200" placeholder="填写实际版本；不清楚则写 unknown"></label></div><label>运行结果<select name="executionStatus" required><option value="unknown">未知／尚未核对</option><option value="succeeded">已完成（导入者声明）</option><option value="failed">失败</option><option value="partial">部分完成</option></select></label>
  <label>代码文件<input type="file" name="receiptCode" accept=".py,.r,.R,.ipynb,.jl,.js,.ts,.sh,.txt,.json"><small data-files-label="receiptCode">尚未选择</small></label><label>输入文件（可多选）<input type="file" name="receiptInputs" multiple><small data-files-label="receiptInputs">尚未选择</small></label><label>输出文件（CSV、notebook 等，可多选）<input type="file" name="receiptOutputs" multiple><small data-files-label="receiptOutputs">尚未选择</small></label><p class="form-help">对选中的原始字节计算 SHA-256，绑定代码、输入与输出。合计最多 10 MiB。notebook 仅作文本查看，代码、HTML 和脚本均不执行；字节一致不证明这些输出确实由该代码产生。</p><label>运行摘要<textarea name="summary" rows="2" maxlength="4000" placeholder="说明比较、分析单位、供体及主要输出。"></textarea></label><label>失败／未完成记录（每行一项）<textarea name="failures" rows="2" maxlength="4000" placeholder="失败或部分完成时，请记录实际失败环节与原因。"></textarea></label><label>纳入理由<textarea name="rationale" required rows="2" maxlength="5000"></textarea></label><button class="button" type="submit">校验并导入计算回执</button></fieldset></form></details>
  <details data-details-key="receipt-bionexus:${esc(claimId)}"><summary>导入 BioNexus 多供体差异表达 bundle</summary><form id="receipt-bionexus-form" data-draft-key="receipt-bionexus:${esc(claimId)}"><fieldset ${busy ? 'disabled' : ''}><p class="form-help">选择 bundle 文件夹，保留 manifest、审查记录及其引用的输入与输出。也可导入已封装的计算回执 JSON；两者只选一种。所有材料按原始字节核对。</p><label>BioNexus bundle 文件夹<input type="file" name="bionexusFiles" webkitdirectory multiple><small data-files-label="bionexusFiles">尚未选择</small></label><label>或：已封装的计算回执 JSON<input type="file" name="receiptPackage" accept=".json"><small data-files-label="receiptPackage">尚未选择</small></label><label>执行回执相对路径（可选）<input name="executionReceiptPath" maxlength="500" placeholder="例如：execution-receipt.json"></label><p class="form-help">仅导入 BioNexus 审查 bundle 时，不会被标记为实际执行了差异表达；执行与科学有效性分别显示。</p><label>纳入理由<textarea name="rationale" required rows="2" maxlength="5000"></textarea></label><button class="button" type="submit">读取并校验 bundle</button></fieldset></form></details>
  <details data-details-key="doi:${esc(claimId)}"><summary>核验 DOI 与引用元数据</summary><form id="doi-verification-form" data-draft-key="doi:${esc(claimId)}"><fieldset ${busy ? 'disabled' : ''}><label>DOI<input name="doi" required maxlength="2000" placeholder="10.xxxx/… 或 https://doi.org/…"></label><label>预期标题（可选）<textarea name="expectedTitle" rows="2" maxlength="3000"></textarea></label><div class="intake-grid"><label>预期发表年（可选）<input name="expectedYear" type="number" min="1000" max="3000" step="1"></label><label>核验方式<select name="verificationMode"><option value="registry">查询公开注册元数据</option><option value="syntax_only">仅检查格式，不联网</option></select></label></div><label>预期作者（可选，每行一个，完整且有序）<textarea name="expectedAuthors" rows="2" maxlength="6000" placeholder="不要用 et al. 代替作者名单。"></textarea></label><p class="form-help">公开查询仅发送 DOI 至 Crossref／DataCite；标题、作者和会话材料不发送。结果分别报告格式、注册记录与字段一致性，不核验论文内容是否支持论断。</p><button class="button" type="submit">执行所选 DOI 核验并保存记录</button></fieldset></form></details></section>`;
}

export function evidenceIntakeSummary(resources: Resource[]) {
  const receipts = resources.filter(resource => resource.evidenceKind === 'computational_receipt').length;
  const dois = resources.filter(resource => resource.evidenceKind === 'doi_verification').length;
  return `<section class="intake-summary" aria-label="计算与引用证据"><div><strong>计算与引用证据</strong><p>${receipts} 份计算回执 · ${dois} 份 DOI 核验记录</p></div><button class="button button-small" data-action="open-evidence-intake">导入／查看核验</button></section>`;
}

const metadataStatusNames = { match: '一致', mismatch: '不一致', incomplete: '信息不足／有歧义', not_checked: '未核验' };
const existenceNames = { found: '已找到注册记录', not_found: '所查注册库未找到', unknown: '未知（查询未完成）', not_checked: '未查询' };
const layerNames = { syntax: '格式', registry_lookup: '注册记录查询', bibliographic_comparison: '引用元数据比对' };
const displayMetadataValue = (value: unknown) => Array.isArray(value) ? value.join('；') : String(value ?? '未提供');
function doiRecordView(result: DoiVerification, resourceId: string) {
  const fieldLabels = { title:'标题',year:'发表年',authors:'作者' };
  return `<div class="doi-record"><p class="intake-record-title"><strong>${esc(result.normalizedDoi ?? result.doi)}</strong><span>${esc(result.checkedAt)}</span></p><dl class="verification-layers"><div><dt>格式</dt><dd>${result.syntax === 'valid' ? '符合所支持的 DOI 格式' : '不符合所支持的 DOI 格式'}</dd></div><div><dt>注册记录</dt><dd>${existenceNames[result.existence]}</dd></div><div><dt>元数据</dt><dd>${metadataStatusNames[result.metadata]}</dd></div><div><dt>论文内容支持论断</dt><dd>未核验</dd></div><div><dt>科学有效性</dt><dd>未核验</dd></div></dl><p class="actual-checks"><strong>实际执行：</strong>${result.actualLayers.map(layer => layerNames[layer]).join('、') || '无'}。查询尝试不等于查询成功。</p><div class="doi-field-checks">${(['title','year','authors'] as const).map(field => { const check = result.fieldChecks[field]; return `<details data-details-key="doi-field:${esc(resourceId)}:${field}"><summary>${fieldLabels[field]}<span>${metadataStatusNames[check.status]}</span></summary><p>预期值：${esc(displayMetadataValue(check.expected))}</p>${check.results.map(item => `<p><strong>${esc(item.provider)}</strong> · ${metadataStatusNames[item.status]}<br>返回值：${esc(displayMetadataValue(item.actual))}${item.reason ? `<br>${esc(item.reason)}` : ''}</p>`).join('') || '<p>本字段未比对。</p>'}</details>`; }).join('')}</div><details data-details-key="doi-sources:${esc(resourceId)}"><summary>查询来源、响应摘要与局限</summary>${result.sources.length ? result.sources.map(source => `<article class="doi-source"><p><strong>${esc(source.provider)}</strong> · ${existenceNames[source.status]} · HTTP ${source.httpStatus ?? '无响应'}</p><p class="receipt-path">${esc(source.url)}</p>${source.responseSha256 ? `<p>响应 SHA-256 <code>${esc(source.responseSha256)}</code></p>` : '<p>未取得可核对的响应摘要。</p>'}${source.error ? `<p>查询未完成原因：${esc(source.error)}</p>` : ''}${source.record ? `<p>登记标题：${esc(source.record.titles.join('；'))}<br>登记年份：${esc(source.record.years.join('、'))}<br>登记作者：${esc(source.record.authors.join('；'))}</p>` : ''}</article>`).join('') : '<p>本次没有发出注册库查询。</p>'}<ul>${result.limitations.map(limit => `<li>${esc(limit)}</li>`).join('')}</ul></details></div>`;
}

export function evidenceRecordView(resource: Resource) {
  if (resource.doiVerification) return `<section class="intake-record" aria-label="DOI 分层核验记录"><h3>DOI 核验记录</h3>${doiRecordView(resource.doiVerification,resource.id)}</section>`;
  if (resource.computationReceipt) return `<section class="intake-record" aria-label="计算回执记录"><h3>计算回执 · ${resource.computationReceipt.format === 'bionexus-de' ? 'BioNexus 多供体差异表达' : 'CSV／notebook 等输出'}</h3>${computationRecordView(resource.computationReceipt,resource.id)}</section>`;
  return '';
}

function computationRecordView(receipt: ComputationalReceipt, resourceId: string) {
  const statusNames = { succeeded:'已完成（生产者声明）',failed:'失败（生产者声明）',partial:'部分完成（生产者声明）',unknown:'未知／未提供执行状态' };
  const bound = (label: string, item: HashBinding) => `<div class="receipt-bound-file"><p><strong>${label}</strong> · ${item.verification === 'MATCHED' ? '摘要与已提供字节相符' : '所需字节／摘要未提供'}</p><p class="receipt-path">${esc(item.path ?? '文件路径未提供')}</p><code>${esc(item.sha256 ?? 'SHA-256 未提供')}</code></div>`;
  const executionBindings = { MANIFEST_BOUND:'由原始 manifest 摘要绑定',UPLOADER_ASSOCIATED:'上传者关联；原始 manifest 未绑定',NOT_PROVIDED:'未提供执行回执' };
  return `<span class="receipt-origin">导入已有材料 · 本次未执行代码或 notebook</span><p><strong>${receipt.format === 'bionexus-de' ? '审查工具：' : '计算工具（声明）：'}${esc(receipt.tool.name)}</strong> · 版本 ${esc(receipt.tool.version)}</p>${receipt.bundle ? `<p>实际分析方法（执行回执声明）：${esc(typeof receipt.bundle.executionReceipt?.method === 'string' ? receipt.bundle.executionReceipt.method : 'NOT_PROVIDED')}<br>分析方法版本：${esc(typeof receipt.bundle.executionReceipt?.method_version === 'string' ? receipt.bundle.executionReceipt.method_version : 'NOT_PROVIDED')}</p>` : ''}<p>${esc(receipt.summary)}</p><dl class="verification-layers"><div><dt>运行结果</dt><dd>${statusNames[receipt.status]}</dd></div><div><dt>代码—输入—输出绑定</dt><dd>${receipt.binding.status === 'COMPLETE_BYTES' ? '三者字节摘要已完整绑定' : '绑定不完整，请补充字节／摘要'}</dd></div><div><dt>上传文件字节完整性</dt><dd>已核对</dd></div><div><dt>真实执行／生产者身份</dt><dd>均未独立核验</dd></div><div><dt>科学有效性</dt><dd>NOT_ASSESSED</dd></div>${receipt.bundle ? `<div><dt>材料来源声明</dt><dd>${esc(receipt.bundle.dataOrigin)}</dd></div>` : ''}</dl><p class="actual-checks"><strong>实际核验：</strong>提供文件的原始字节摘要与声明的绑定关系。工具版本、运行状态及失败记录保留为原始声明；不证明代码确实生成了这些输出。</p>${receipt.failures.length ? `<section class="receipt-failures"><h4>失败／未完成记录 · ${receipt.failures.length} 项</h4>${receipt.failures.map(failure => `<p><strong>${esc(failure.stage)}</strong><br>${esc(failure.message)}</p>`).join('')}</section>` : '<p>未提供失败记录；这不等于已独立确认运行成功。</p>'}<details data-details-key="receipt-binding:${esc(resourceId)}"><summary>代码、输入、输出的 SHA-256 绑定</summary><p>绑定记录摘要 <code>${esc(receipt.binding.sha256)}</code></p>${bound('代码',receipt.binding.code)}${receipt.binding.inputs.map((item,index) => bound(`输入 ${index + 1}`,item)).join('') || '<p>输入绑定未提供。</p>'}${receipt.binding.outputs.map((item,index) => bound(`输出 ${index + 1}`,item)).join('') || '<p>输出绑定未提供。</p>'}</details><details data-details-key="receipt-files:${esc(resourceId)}"><summary>查看 ${receipt.artifacts.length} 份原始材料及输出预览</summary>${receipt.artifacts.map((artifact,index) => `<details class="receipt-artifact" data-details-key="receipt-file:${esc(resourceId)}:${index}"><summary>${esc(artifact.path)} · ${artifact.bytes.toLocaleString()} 字节</summary><p>${esc(artifact.mediaType)}<br>SHA-256 <code>${esc(artifact.sha256)}</code></p>${artifact.preview !== undefined ? `<p>截取的纯文本输出；内容不会执行。</p><pre tabindex="0">${esc(artifact.preview)}</pre>` : '<p>此材料只保留原始字节与摘要，没有可显示的输出预览。</p>'}</details>`).join('')}</details>${receipt.bundle ? `<details data-details-key="receipt-bundle:${esc(resourceId)}"><summary>BioNexus 审查与执行回执的来源边界</summary><p>bundle 一致性：${receipt.bundle.integrityStatus === 'CONSISTENT' ? '已提供记录之间一致' : '旧版材料，完整性检查受限'}<br>原始审查状态：${esc(receipt.bundle.auditStatus)}<br>执行回执关联：${executionBindings[receipt.bundle.executionReceiptBinding]}</p><p>manifest SHA-256 <code>${esc(receipt.bundle.manifestSha256)}</code></p><details><summary>原始审查记录（纯文本 JSON）</summary><pre>${esc(JSON.stringify(receipt.bundle.audit,null,2))}</pre></details>${receipt.bundle.executionReceipt ? `<details><summary>原始执行回执（生产者声明）</summary><pre>${esc(JSON.stringify(receipt.bundle.executionReceipt,null,2))}</pre></details>` : ''}</details>` : ''}<details data-details-key="receipt-limits:${esc(resourceId)}"><summary>核验局限</summary><ul>${receipt.limitations.map(limit => `<li>${esc(limit)}</li>`).join('')}</ul></details>`;
}

function base64(bytes: Uint8Array) {
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += 16384) chunks.push(String.fromCharCode(...bytes.subarray(index, index + 16384)));
  return btoa(chunks.join(''));
}
async function readFile(file: File, path: string) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  return { path, contentBase64: base64(bytes), sha256 };
}
function checkSize(files: File[]) {
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_RECEIPT_BYTES) throw new Error('计算回执全部文件的原始字节合计不得超过 10 MiB。');
  if (files.length > 64) throw new Error('一份计算回执最多选择 64 个文件。');
}
function uniquePaths(files: { path: string }[]) {
  const paths = files.map(file => file.path.toLowerCase());
  if (new Set(paths).size !== paths.length) throw new Error('所选文件包含重复的包内路径，请分别命名后重新选择。');
}

export async function buildGenericReceipt(data: FormData, groups: IntakeFileGroups) {
  const code = groups.receiptCode ?? [], inputs = groups.receiptInputs ?? [], outputs = groups.receiptOutputs ?? [];
  const status = String(data.get('executionStatus'));
  if (code.length !== 1 || !inputs.length) throw new Error('请选择一个代码文件及至少一个输入文件。');
  if (inputs.length > 32 || outputs.length > 32) throw new Error('输入与输出分别最多选择 32 个文件。');
  if (status === 'succeeded' && !outputs.length) throw new Error('声明为已完成的运行需要至少一个输出文件。');
  const failures = String(data.get('failures') ?? '').split('\n').map(value => value.trim()).filter(Boolean).map(message => ({ stage: 'researcher_import', message }));
  if ((status === 'failed' || status === 'partial') && !failures.length) throw new Error('失败或部分完成的运行需要填写实际失败／未完成记录。');
  checkSize([...code, ...inputs, ...outputs]);
  const codeFile = await readFile(code[0], `code/${code[0].name}`);
  const inputFiles = await Promise.all(inputs.map(file => readFile(file, `inputs/${file.name}`)));
  const outputFiles = await Promise.all(outputs.map(file => readFile(file, `outputs/${file.name}`)));
  const files = [codeFile, ...inputFiles, ...outputFiles];
  uniquePaths(files);
  const ref = ({ path, sha256 }: { path: string; sha256: string }) => ({ path, sha256 });
  const summary = String(data.get('summary') ?? '').trim();
  return { format: 'generic', files: files.map(({ path, contentBase64 }) => ({ path, contentBase64 })), manifest: { schema: 'locus.computational-receipt.v1', tool: { name: String(data.get('toolName')).trim(), version: String(data.get('toolVersion')).trim() }, status, code: ref(codeFile), inputs: inputFiles.map(ref), outputs: outputFiles.map(ref), failures, ...(summary ? { summary } : {}) } };
}

export async function buildBioNexusReceipt(data: FormData, groups: IntakeFileGroups) {
  const packages = groups.receiptPackage ?? [], files = groups.bionexusFiles ?? [];
  if ((packages.length > 0) === (files.length > 0)) throw new Error('请选择 bundle 文件夹或已封装 JSON 中的一种。');
  if (packages.length) {
    if (packages[0].size > 15 * 1024 * 1024) throw new Error('封装 JSON 超过 15 MiB，请缩小所包含的材料。');
    try { return JSON.parse(await packages[0].text()) as unknown; }
    catch { throw new Error('计算回执文件不是有效 JSON；请选择完整的回执包。'); }
  }
  checkSize(files);
  const uploaded = await Promise.all(files.map(file => {
    const relativePath = file.webkitRelativePath || file.name;
    const path = file.webkitRelativePath ? relativePath.split('/').slice(1).join('/') : relativePath;
    return readFile(file, path);
  }));
  uniquePaths(uploaded);
  const executionReceiptPath = String(data.get('executionReceiptPath') ?? '').trim();
  return { format: 'bionexus-de', files: uploaded.map(({ path, contentBase64 }) => ({ path, contentBase64 })), ...(executionReceiptPath ? { executionReceiptPath } : {}) };
}

export function buildDoiInput(data: FormData) {
  const title = String(data.get('expectedTitle') ?? '').trim();
  const year = String(data.get('expectedYear') ?? '').trim();
  const authors = String(data.get('expectedAuthors') ?? '').split('\n').map(value => value.trim()).filter(Boolean);
  if (authors.length > 1000 || authors.some(author => author.length > 500)) throw new Error('作者最多 1,000 位，每位姓名不超过 500 个字符。');
  return { doi: String(data.get('doi')).trim(), mode: String(data.get('verificationMode')) as 'syntax_only' | 'registry', ...((title || year || authors.length) ? { expected: { ...(title ? { title } : {}), ...(year ? { year: Number(year) } : {}), ...(authors.length ? { authors } : {}) } } : {}) };
}
