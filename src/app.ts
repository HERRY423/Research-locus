import { createBridge, type Bridge, type PickedFile } from './bridge.js';
import type { ReviewState } from './domain.js';
import type { CatalogState } from './catalog.js';
import { buildReplaySteps, diffLines, type ReplayStep } from './replay.js';
import type { ReviewMode, ReviewRun } from './review-runs.js';
import { currentMetadataReview, metadataLabels, summarizeChecks, type ClaimMetadata, type RuleOutcome } from './metadata-review.js';
import { declaredCard, describeValue, designFields, designKeys, NOT_DECLARED, undeclared, type DesignField } from './design-fields.js';
import { evidencePlan } from './evidence-plan.js';
import { proposalAvailability } from './revision-proposals.js';
import { buildBioNexusReceipt, buildDoiInput, buildGenericReceipt, evidenceIntakeForms, evidenceIntakeSummary, evidenceRecordView, type IntakeFileGroups } from './evidence-intake-ui.js';
import './app.css';

type Section = 'review' | 'resources' | 'history' | 'replay' | 'project';
type Claim = ReviewState['claims'][number];
type Finding = ReviewState['findings'][number];
type Resource = ReviewState['resources'][number];

const icons: Record<string, string> = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  book: '<path d="M12 5c-3-3-7-3-10-1v15c3-2 7-2 10 1 3-3 7-3 10-1V4c-3-2-7-2-10 1zM12 5v15"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  replay: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m10 8 6 4-6 4zM3 7h3M3 12h3M3 17h3M18 7h3M18 12h3M18 17h3"/>',
  play: '<path d="m8 5 11 7-11 7z"/>',
  link: '<path d="m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 0) scale(.9)"/>',
  sparkle: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  shield: '<path d="m12 3 8 3v5c0 5-4 8-8 10-4-2-8-5-8-10V6z"/><path d="m8 12 3 3 5-6"/>',
};
const icon = (name: string, className = '') => `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? icons.file}</svg>`;
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const scopeNames: Record<string, string> = { sample: '样本内观察', cohort: '队列层面', population: '人群外推', causal: '因果结论' };
const categoryNames: Record<string, string> = { design: '研究设计', claim_scope: '结论边界', provenance: '来源追溯', other: '其他' };
const decisionNames: Record<string, string> = { challenge: '质疑建议', dismiss: '驳回建议', defer: '暂缓决定', accept_with_limits: '附条件采纳' };
const relationNames = { supports: '支持', depends_on: '依赖', contradicts: '矛盾' };
const evidenceCategoryNames: Record<string, string> = { source: '原始来源', design: '研究设计', analysis: '分析方法', replication: '独立重复', causal: '因果识别', provenance: '来源追溯', validation: '独立验证', other: '其他证据' };
const actionNames: Record<string, string> = { import_computational_receipt: '导入计算回执', record_doi_verification: '记录 DOI 核验', add_claim_relation: '连接论断', remove_claim_relation: '移除论断关系', set_claim_disposition: '处理论断', acknowledge_re_review: '记录局部重审', apply_revision_proposal: '采纳修订提案', link_evidence_requirement: '关联补证材料', propose_design: '提交设计候选', confirm_design: '确认设计候选', pause: '暂停共审', resume: '恢复共审', run_review: '运行规则检查', intervene: '研究者介入', revise_claim: '修订论断', attach_evidence: '添加证据', create_claim: '添加论断', fixture_created: '创建合成示例', workspace_created: '创建空白会话', add_finding: 'Agent 提交建议', created: '创建工作区', initialized: '初始化演示', review_started: '规则检查', claim_revised: '修订论断', evidence_attached: '添加证据', intervention: '研究者介入' };

let bridge: Bridge;
let state: ReviewState | null = null;
let page: 'home' | 'workbench' = 'home';
let catalog: CatalogState | null = null;
let activeSessionId = '';
let loadingSession = false;
let homeQuery = '';
let homeProjectId = '';
let homeForm: 'project' | 'session' | null = null;
let pendingLocalRoute = false;
let pendingHostPage: { page: 'home' | 'review' | 'settings'; sessionId: string } | null = null;
let section: Section = 'review';
let selectedClaimId = '';
let selectedFindingId = '';
let selectedResourceId = '';
let query = '';
let busy = false;
let busyLabel = '';
let notice: { kind: 'success' | 'error'; text: string } | null = null;
let mobileNavOpen = false;
let creatingClaim = false;
let reviewTab: 'review' | 'evidence' = 'review';
let editingResourceId = '';
let stagedFile: PickedFile | null = null;
let composing = false;
let replayCursorId = '';
let replayState: ReviewState | null = null;
let replaySteps: ReplayStep[] = [];
let replayTimer: ReturnType<typeof setInterval> | null = null;
let replayGeneration = 0;
const formDrafts = new Map<string, Record<string, string>>();
const intakeFileDrafts = new Map<string, IntakeFileGroups>();
const expandedDetails = new Map<string, boolean>();
const selectedResources = new Map<string, Set<string>>();
const root = document.querySelector<HTMLDivElement>('#app') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'app' }));
const feedbackAnnouncement = document.body.appendChild(Object.assign(document.createElement('div'), { className: 'sr-only' }));
feedbackAnnouncement.setAttribute('role', 'status');
feedbackAnnouncement.setAttribute('aria-live', 'polite');

const currentClaim = () => state?.claims.find(c => c.id === selectedClaimId);
const claimFindings = (id: string) => state?.findings.filter(f => f.claimId === id) ?? [];
const activeFindings = (id: string) => claimFindings(id).filter(f => f.status === 'active');
const currentFinding = () => state?.findings.find(f => f.id === selectedFindingId);
function checkedResources(): Set<string> {
  if (!selectedResources.has(selectedClaimId)) selectedResources.set(selectedClaimId, new Set(currentClaim()?.resourceIds ?? []));
  return selectedResources.get(selectedClaimId)!;
}
function reconcileSelection() {
  if (!state) return;
  if (!state.claims.some(c => c.id === selectedClaimId)) selectedClaimId = state.claims[0]?.id ?? '';
  const selectedFinding = claimFindings(selectedClaimId).find(f => f.id === selectedFindingId);
  if (!selectedFinding || (selectedFinding.status === 'stale' && !proposalAvailability(state,selectedFinding).available && activeFindings(selectedClaimId).length)) selectedFindingId = activeFindings(selectedClaimId)[0]?.id ?? claimFindings(selectedClaimId)[0]?.id ?? '';
  const validResources = new Set(state.resources.map(r => r.id));
  for (const set of selectedResources.values()) for (const id of set) if (!validResources.has(id)) set.delete(id);
}
function receiveState(next: ReviewState) {
  if (loadingSession) return;
  if (bridge?.activeSessionId() && activeSessionId && bridge.activeSessionId() !== activeSessionId) return;
  if (state && state.projectId === next.projectId && state.revision === next.revision && state.snapshotHash === next.snapshotHash) return;
  stopReplay();
  state = next;
  reconcileSelection();
  render();
}
function setNotice(kind: 'success' | 'error', text: string) { notice = { kind, text }; }
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
const formDraftKey = (form: HTMLFormElement) => `${form.dataset.sessionId ?? activeSessionId}::${form.dataset.draftKey}`;
function captureDrafts() {
  for (const form of root.querySelectorAll<HTMLFormElement>('form[data-draft-key]')) {
    if (form.querySelector('fieldset:disabled')) continue;
    const values: Record<string, string> = {};
    const files: IntakeFileGroups = {};
    for (const input of form.querySelectorAll<HTMLInputElement>('input[type="file"][name]')) files[input.name] = [...(input.files ?? [])];
    if (Object.keys(files).length) intakeFileDrafts.set(formDraftKey(form), files);
    for (const [key, value] of new FormData(form)) if (typeof value === 'string') values[key] = value;
    if (form.id === 'revise-form' && values.text === values.baselineText && values.scope === values.baselineScope && metadataSignature(metadataFromValues(values)) === values.baselineMetadata && !values.rationale?.trim()) { formDrafts.delete(formDraftKey(form)); continue; }
    formDrafts.set(formDraftKey(form), values);
  }
}
function restoreDrafts() {
  for (const form of root.querySelectorAll<HTMLFormElement>('form[data-draft-key]')) {
    form.dataset.sessionId = activeSessionId;
    const values = formDrafts.get(formDraftKey(form));
    const files = intakeFileDrafts.get(formDraftKey(form));
    for (const input of form.querySelectorAll<HTMLInputElement>('input[type="file"][name]')) {
      const selected = files?.[input.name] ?? [];
      if (selected.length) { const transfer = new DataTransfer(); selected.forEach(file => transfer.items.add(file)); input.files = transfer.files; }
      const label = form.querySelector<HTMLElement>(`[data-files-label="${CSS.escape(input.name)}"]`);
      if (label) label.textContent = selected.length ? `${selected.length} 个文件 · ${selected.map(file => file.name).join('、')}` : '尚未选择';
    }
    if (!values) continue;
    for (const element of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[name]')) {
      if (element instanceof HTMLInputElement && element.type === 'file') continue;
      if (element instanceof HTMLInputElement && element.type === 'checkbox') { element.checked = element.name in values; continue; }
      if (!(element.name in values)) continue;
      if (element instanceof HTMLInputElement && element.type === 'radio') element.checked = element.value === values[element.name];
      else element.value = values[element.name];
    }
    const decision = form.querySelector<HTMLInputElement>('input[name="decision"]:checked');
    const applicability = form.querySelector<HTMLSelectElement>('[name="meta_figureApplicable"]');
    const matched = form.querySelector<HTMLSelectElement>('[name="meta_figureSourceMatched"]');
    if (matched) { matched.disabled = applicability?.value === 'false'; if (matched.disabled) matched.value = NOT_DECLARED; }
    const numberInput = form.querySelector<HTMLInputElement>('[name="meta_biologicalReplicates"]');
    if (numberInput) { numberInput.disabled = values.meta_biologicalReplicates_status !== 'known'; numberInput.required = !numberInput.disabled; }
    const field = form.querySelector<HTMLElement>('#conditions-field');
    const conditions = form.querySelector<HTMLTextAreaElement>('#decision-conditions');
    if (field) field.hidden = decision?.value !== 'accept_with_limits';
    if (conditions) conditions.required = decision?.value === 'accept_with_limits';
  }
}
async function perform(label: string, task: () => Promise<void>) {
  if (busy) return;
  busy = true; busyLabel = label; notice = null; render();
  try { await task(); } catch (error) { setNotice('error', errorText(error)); }
  finally {
    busy = false; busyLabel = ''; render();
    if (pendingLocalRoute) { pendingLocalRoute = false; queueMicrotask(() => { void restoreLocalRoute(); }); }
    else if (pendingHostPage) { const requested = pendingHostPage; pendingHostPage = null; queueMicrotask(() => { void openHostPage(requested); }); }
  }
}
async function act(action: unknown, message: string) {
  if (!state) return false;
  const revision = state.revision;
  let saved = false;
  await perform('正在保存…', async () => {
    receiveState(await bridge.act(action, revision));
    saved = true;
    setNotice('success', message);
  });
  return saved;
}
function severityLabel(severity: Finding['severity']) { return severity === 'critical' ? '优先处理' : severity === 'warning' ? '需要核对' : '供参考'; }
function metadataSignature(metadata: ClaimMetadata) { return JSON.stringify(Object.fromEntries(Object.entries(declaredCard(metadata)).sort(([a], [b]) => a.localeCompare(b)))); }
function metadataFromValues(values: Record<string, string>): ClaimMetadata {
  const metadata: Record<string,unknown> = {};
  for (const key of designKeys) {
    const value = values[`meta_${key}`];
    metadata[key] = designFields[key].kind === 'number' ? (values[`meta_${key}_status`] === 'known' && value?.trim() ? Number(value) : NOT_DECLARED) : !value || value === NOT_DECLARED ? NOT_DECLARED : value === 'true' ? true : value === 'false' ? false : value;
  }
  if (metadata.figureApplicable === false) metadata.figureSourceMatched = NOT_DECLARED;
  if (values.meta_basis?.trim()) metadata.basis = values.meta_basis.trim();
  return metadata as ClaimMetadata;
}
function metadataFields(metadata: ClaimMetadata = {}, prefix: string) {
  const field = (key: DesignField) => {
    const known = !undeclared(metadata[key]);
    if (designFields[key].kind === 'number') return `<div><label for="${prefix}-${key}-status">${metadataLabels[key]} · 声明状态</label><select id="${prefix}-${key}-status" name="meta_${key}_status" required><option value="NOT_DECLARED" ${!known ? 'selected' : ''}>NOT_DECLARED（未声明）</option><option value="known" ${known ? 'selected' : ''}>已知，请填写</option></select><label for="${prefix}-${key}">${metadataLabels[key]}</label><input id="${prefix}-${key}" name="meta_${key}" type="number" min="0" max="1000000" step="1" value="${known ? esc(metadata[key]) : ''}" ${known ? 'required' : 'disabled'} placeholder="填写独立生物重复，不是细胞数"></div>`;
    const options = key === 'analysisUnit' ? [['cell','细胞'],['donor','供体／个体'],['sample','独立样本'],['other','其他（需解释）']] : [['true','是'],['false','否']];
    return `<div><label for="${prefix}-${key}">${metadataLabels[key]}</label><select id="${prefix}-${key}" name="meta_${key}" required ${key === 'figureSourceMatched' && metadata.figureApplicable === false ? 'disabled' : ''}>${[[NOT_DECLARED,'NOT_DECLARED（未声明）'],...options].map(([value,label]) => `<option value="${value}" ${String(metadata[key] ?? NOT_DECLARED) === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>`;
  };
  return `<fieldset class="metadata-fields"><legend>研究设计卡 · 必填确认</legend><p class="form-help">逐项声明已知信息；无法确认时明确保留 NOT_DECLARED。不得把“材料未提到”当成“否”。卡片必须核对，未知项仍可保存并进入补充流程。</p><div class="metadata-grid">${designKeys.slice(0,5).map(field).join('')}</div><details data-details-key="extended:${prefix}"><summary>更多设计声明 · 多重检验、批次、措辞、阈值与验证</summary><div class="metadata-grid">${designKeys.slice(5).map(field).join('')}</div></details><label for="${prefix}-basis">信息依据与定位（可选）</label><textarea id="${prefix}-basis" name="meta_basis" rows="2" maxlength="2000">${esc(metadata.basis ?? '')}</textarea><label class="design-ack"><input name="design_ack" type="checkbox" required value="checked">我已核对研究设计卡；未能确认的项目保留 NOT_DECLARED</label></fieldset>`;
}
function designCardView(claim: Claim) {
  const unknown = designKeys.filter(key => undeclared(claim.metadata[key]));
  const proposals = state?.designProposals?.filter(p => p.claimId === claim.id) ?? [];
  return `<section class="design-card" aria-label="研究设计卡"><div class="section-title"><h3>研究设计卡</h3><button class="text-button" data-action="edit-metadata">填写／修订</button></div><p>${unknown.length ? `${unknown.length} 项 NOT_DECLARED（含可能不适用的字段）；请按规则报告核对适用性与缺口。` : '各字段已声明；仍需独立核验。'}</p><dl>${designKeys.slice(0,5).map(key => `<div><dt>${metadataLabels[key]}</dt><dd>${claim.metadata.figureApplicable === false && key === 'figureSourceMatched' ? '不适用' : esc(describeValue(key,claim.metadata[key]))}</dd></div>`).join('')}</dl><button class="button" data-action="extract-design" ${busy || bridge?.mode !== 'host' || state?.reviewStatus === 'paused' || pendingRun() ? 'disabled' : ''}>从所选证据提取设计候选</button><p class="form-help">在「证据文件」中勾选材料。宿主 Agent 只提交候选；逐项确认后才写入。${bridge?.mode === 'local' ? '本地预览未连接宿主 Agent。' : ''}</p>${proposals.slice().reverse().map(p => p.status === 'proposed' ? `<form class="design-proposal" data-proposal-id="${esc(p.id)}" data-draft-key="design:${esc(p.id)}"><h4>待确认的设计候选</h4><p>摘录只核对原文是否存在，不证明解释正确。默认不采纳任何字段。</p>${p.candidates.map(candidate => `<div class="candidate"><label><input type="checkbox" name="select_${candidate.field}" value="${candidate.field}"><strong>${metadataLabels[candidate.field]}</strong>：${esc(describeValue(candidate.field,claim.metadata[candidate.field]))} → ${esc(describeValue(candidate.field,candidate.value))}</label><p>${esc(candidate.rationale)}</p>${candidate.evidence.map(cite => `<blockquote>${esc(cite.quote)}<footer>${esc(state?.resources.find(r => r.id === cite.resourceId)?.name ?? cite.resourceId)} · ${esc(cite.locator)}</footer></blockquote>`).join('') || '<p>所选材料未支持确定值；保持 NOT_DECLARED。</p>'}</div>`).join('')}<label>确认或驳回理由<textarea name="rationale" required maxlength="5000" rows="2"></textarea></label><button type="submit" class="button button-primary" ${busy ? 'disabled' : ''}>确认选中字段（不勾选则全部驳回）</button></form>` : `<details data-details-key="proposal:${esc(p.id)}"><summary>提取候选历史 · ${{ confirmed:'已确认', rejected:'已驳回', stale:'材料已变化，已过期' }[p.status]}</summary><p>当时选中：${p.selectedFields?.map(key => metadataLabels[key]).join('、') || '无'}</p>${p.candidates.map(candidate => `<div class="candidate"><p><strong>${metadataLabels[candidate.field]}</strong>：${esc(describeValue(candidate.field,candidate.value))} · ${p.selectedFields?.includes(candidate.field) ? '当时已采纳' : '未采纳'}</p><p>${esc(candidate.rationale)}</p>${candidate.evidence.map(cite => `<blockquote>${esc(cite.quote)}<footer>${esc(state?.resources.find(r => r.id === cite.resourceId)?.name ?? cite.resourceId)} · ${esc(cite.locator)}（确认时材料）</footer></blockquote>`).join('')}</div>`).join('')}</details>`).join('')}</section>`;
}
const outcomeNames: Record<RuleOutcome, string> = { flagged: '发现风险', needs_input: '信息不足', no_signal: '未触发本规则', not_applicable: '不适用' };
function metadataReviewView(claim: Claim) {
  const report = state && currentMetadataReview(state,claim.id);
  const checks = report?.checks.filter(check => check.claimId === claim.id);
  return `<section class="metadata-review" aria-label="内置规则检查报告"><div class="section-title"><h3>内置规则检查</h3><button class="text-button" data-action="edit-metadata">补充审查信息</button></div>${checks ? `<p class="form-help">依据已填声明 · 检查版本 ${report!.revision} · ${esc(report!.rulesVersion)}。未触发不等于科学通过。</p><div class="rule-check-list">${checks.map(check => `<details class="rule-check ${check.outcome}" data-details-key="rule:${report!.revision}:${esc(claim.id)}:${check.ruleId}" ${check.outcome === 'needs_input' ? 'open' : ''}><summary><strong>${esc(check.title)}</strong><span>${outcomeNames[check.outcome]}${check.declarationStatus === 'NOT_DECLARED' ? ' · NOT_DECLARED' : ''}</span></summary><p>${esc(check.rationale)}</p>${check.missingFields.length ? `<p class="rule-missing">待补充：${check.missingFields.map(key => metadataLabels[key]).join('、')}</p>` : ''}${check.nextStep ? `<p>下一步：${esc(check.nextStep)}</p>` : ''}${check.limitation ? `<p class="form-help">适用领域：${esc(check.disciplines?.join('、'))}<br>局限：${esc(check.limitation)}</p>` : ''}</details>`).join('')}</div>${claim.metadata.basis ? `<p class="metadata-basis">声明依据（未独立核验）：${esc(claim.metadata.basis)}</p>` : '<p class="form-help">手填依据未提供；如已确认提取候选，可展开「提取候选历史」查看原始摘录。</p>'}` : '<div class="muted-box">当前版本尚无有效检查报告。填写已知审查信息后点击「运行检查」；未知信息会列出具体补充项。</div>'}</section>`;
}
const phaseNames: Record<ReviewRun['phase'], string> = { queued: '等待 ChatGPT 确认', working: '正在复核', needs_input: '需要你补充', completed: '复核已结束 · 待研究者判断', failed: '复核未完成', cancelled: '已结束等待', stale: '材料已更新 · 需要重审' };
function localReviewView(claim: Claim) {
  const pending = state?.reReview?.filter(flag => flag.claimId === claim.id && flag.status === 'pending') ?? [];
  const rejected = claim.disposition === 'rejected';
  return `${rejected ? '<div class="claim-disposition-banner">研究者已驳回这项论断。它仍保留在证据与修订历史中。</div>' : ''}${pending.length ? `<section class="local-review-notice" aria-label="局部重审"><h3>需要局部重审</h3><p>以下前提发生变化；本论断需要重新核对。</p><ul>${pending.map(flag => `<li><button class="text-button" data-action="claim" data-id="${esc(flag.sourceClaimId)}">${esc(state?.claims.find(c => c.id === flag.sourceClaimId)?.text ?? flag.sourceClaimId)}</button><p>${esc(flag.reason)}</p></li>`).join('')}</ul><form id="acknowledge-review-form" data-draft-key="acknowledge:${esc(claim.id)}"><label>重审记录<textarea name="rationale" rows="2" maxlength="5000" required placeholder="说明你如何核对变化后的前提，以及剩余问题。"></textarea></label><button type="submit" class="button" ${busy ? 'disabled' : ''}>记录已重审</button></form><p class="form-help">此记录只清除待重审标记，不会把证据上限升级为科学通过。</p></section>` : ''}`;
}
function claimGraphView(claim: Claim) {
  if (!state) return '';
  const claims = state.claims;
  const relations = state.claimRelations ?? [];
  const positions = new Map(claims.map((item, index) => [item.id, { x: 18 + (index % 3) * 194, y: 22 + Math.floor(index / 3) * 110 }]));
  const short = (value: string) => [...value].length > 14 ? [...value].slice(0,14).join('') + '…' : value;
  const rows = relations.filter(relation => relation.sourceClaimId === claim.id || relation.targetClaimId === claim.id);
  const options = (selected: string) => claims.map(item => `<option value="${esc(item.id)}" ${item.id === selected ? 'selected' : ''}>${esc(item.text)}</option>`).join('');
  const paths = relations.map(relation => {
    const source = positions.get(relation.sourceClaimId), target = positions.get(relation.targetClaimId);
    if (!source || !target) return '';
    let path: string;
    if (source.y === target.y) {
      const right = target.x > source.x;
      const sx = source.x + (right ? 164 : -2), tx = target.x + (right ? -3 : 165), y = source.y + 30;
      const offset = (tx - sx) / 2;
      path = `M ${sx} ${y} C ${sx + offset} ${y}, ${tx - offset} ${y}, ${tx} ${y}`;
    } else {
      const down = target.y > source.y;
      const sx = source.x + 81, sy = source.y + (down ? 62 : -2), tx = target.x + 81, ty = target.y + (down ? -3 : 63);
      const offset = (ty - sy) / 2;
      path = `M ${sx} ${sy} C ${sx} ${sy + offset}, ${tx} ${ty - offset}, ${tx} ${ty}`;
    }
    return `<path class="graph-edge ${relation.kind}" d="${path}" marker-end="url(#claim-edge-arrow)"><title>${esc(`${claims.find(c => c.id === relation.sourceClaimId)?.text} → ${relationNames[relation.kind]} → ${claims.find(c => c.id === relation.targetClaimId)?.text}`)}</title></path>`;
  }).join('');
  const nodes = claims.map(item => {
    const position = positions.get(item.id)!;
    const pending = state?.reReview?.some(flag => flag.claimId === item.id && flag.status === 'pending');
    const status = item.disposition === 'rejected' ? '已驳回' : pending ? '需要重审' : '待独立评估';
    return `<g class="graph-node ${item.id === claim.id ? 'selected' : ''} ${pending ? 'needs-review' : ''}" transform="translate(${position.x} ${position.y})" data-action="claim" data-id="${esc(item.id)}" role="button" tabindex="0" aria-label="打开论断：${esc(item.text)}；${status}" aria-pressed="${item.id === claim.id}"><title>${esc(item.text)} · ${status}</title><rect width="162" height="60" rx="6"/><text x="10" y="23">${esc(short(item.text))}</text><text class="graph-node-status" x="10" y="44">${status}</text></g>`;
  }).join('');
  return `<section class="claim-graph-section" aria-label="论断依赖图"><details data-details-key="graph:${esc(claim.id)}" ${relations.length ? 'open' : ''}><summary><strong>论断依赖图</strong><span>${claims.length} 个论断 · ${relations.length} 条关系</span></summary><p class="form-help">箭头从前提指向下游；「依赖」表示后者依赖前者。只有依赖关系传播局部重审；支持与矛盾关系用于对照。</p><div class="graph-legend"><span class="depends_on">依赖</span><span class="supports">支持</span><span class="contradicts">矛盾</span></div><div class="claim-graph-scroll"><svg class="claim-graph" viewBox="0 0 584 ${Math.max(115,Math.ceil(claims.length / 3) * 110 + 18)}" aria-label="可点击论断关系图"><defs><marker id="claim-edge-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker></defs>${paths}${nodes}</svg></div><div class="claim-relations">${rows.length ? rows.map(relation => `<article><p><button class="text-button" data-action="claim" data-id="${esc(relation.sourceClaimId)}">${esc(claims.find(c => c.id === relation.sourceClaimId)?.text)}</button><span class="relation-arrow">→ ${relationNames[relation.kind]} →</span><button class="text-button" data-action="claim" data-id="${esc(relation.targetClaimId)}">${esc(claims.find(c => c.id === relation.targetClaimId)?.text)}</button></p><p class="form-help">${esc(relation.rationale)}</p><details data-details-key="remove-relation:${esc(relation.id)}"><summary>移除这条关系</summary><form class="remove-relation-form" data-relation-id="${esc(relation.id)}" data-draft-key="remove-relation:${esc(relation.id)}"><label>移除理由<textarea name="rationale" rows="2" required maxlength="5000"></textarea></label><button class="button button-small" type="submit" ${busy ? 'disabled' : ''}>移除关系</button></form></details></article>`).join('') : '<p class="form-help">当前论断尚未连接其他论断。</p>'}</div>${claims.length > 1 ? `<details data-details-key="add-relation:${esc(claim.id)}"><summary>连接两个论断</summary><form id="add-relation-form" data-draft-key="add-relation:${esc(claim.id)}"><div class="relation-fields"><label>前提论断<select name="sourceClaimId" required>${options(claim.id)}</select></label><label>关系<select name="kind" required><option value="depends_on">依赖：下游依赖前提</option><option value="supports">支持：前提支持下游</option><option value="contradicts">矛盾：两项论断冲突</option></select></label><label>下游论断<select name="targetClaimId" required>${options(claims.find(c => c.id !== claim.id)!.id)}</select></label></div><label>关系依据<textarea name="rationale" required rows="2" maxlength="5000" placeholder="说明为什么存在这条关系。"></textarea></label><button type="submit" class="button" ${busy ? 'disabled' : ''}>保存关系</button></form></details>` : '<p class="form-help">添加第二个论断后，即可建立关系。</p>'}</details><details class="claim-disposition" data-details-key="disposition:${esc(claim.id)}"><summary>${claim.disposition === 'rejected' ? '恢复使用这项论断' : '驳回这项论断'}</summary><p class="form-help">这是对论断本身的处理。右侧「驳回建议」只回应一条审查建议。驳回前提会让依赖它的下游论断进入待重审。</p><form id="claim-disposition-form" data-draft-key="disposition:${esc(claim.id)}"><input type="hidden" name="disposition" value="${claim.disposition === 'rejected' ? 'active' : 'rejected'}"><label>处理理由<textarea name="rationale" required maxlength="5000" rows="2"></textarea></label><button type="submit" class="button" ${busy ? 'disabled' : ''}>${claim.disposition === 'rejected' ? '恢复论断（仍待评估）' : '确认驳回论断'}</button></form></details></section>`;
}
function evidencePlanView(claim: Claim) {
  if (!state) return '';
  const items = evidencePlan(state,claim.id);
  const names = { missing: '待补充', declared: '已有声明 · 待核验', provided: '已关联材料 · 待核验', needs_review: '需要重审' };
  const origins = { baseline: '评估基础', rule: '规则提示', proposal: '已采纳提案', dependency: '依赖变化', receipt:'计算与引用回执' };
  const resources = state.resources.filter(resource => claim.resourceIds.includes(resource.id));
  const missing = items.filter(item => item.status === 'missing' || item.status === 'needs_review').length;
  return `<section class="evidence-plan" aria-label="待补证据清单"><div class="section-title"><h3>缺什么证据 <span class="count">${missing}</span></h3><button class="text-button" data-action="attach" ${busy ? 'disabled' : ''}>添加证据</button></div><p class="form-help">要从 NOT_ASSESSED 进入正式评估，先明确下列材料与分析。关联材料只记录对应关系；清单齐全不会自动升级证据上限，也不会启动实验或分析。</p><div class="evidence-plan-items">${items.map(item => `<details class="evidence-plan-item ${item.status}" data-details-key="evidence-plan:${esc(claim.id)}:${esc(item.id)}"><summary><strong>${esc(item.title)}</strong><span>${names[item.status]}</span></summary><p>${esc(item.description)}</p><p class="small-label">${esc(evidenceCategoryNames[item.category] ?? item.category)} · ${origins[item.origin]}</p>${item.resourceIds.length ? `<div class="linked-evidence">${item.resourceIds.map(id => `<button class="text-button" data-action="preview" data-id="${esc(id)}">${icon('file')}${esc(state?.resources.find(resource => resource.id === id)?.name ?? id)}</button>`).join('')}</div>` : ''}${item.linkable ? resources.length ? `<form class="evidence-link-form" data-requirement-id="${esc(item.id)}" data-draft-key="evidence-link:${esc(claim.id)}:${esc(item.id)}"><fieldset ${busy ? 'disabled' : ''}><legend>关联能回答这项问题的现有证据</legend>${resources.map((resource,index) => `<label class="evidence-link-option"><input type="checkbox" name="link_${index}" value="${esc(resource.id)}" ${item.resourceIds.includes(resource.id) ? 'checked' : ''}>${esc(resource.name)}</label>`).join('')}<label>对应说明<textarea name="rationale" required rows="2" maxlength="5000" placeholder="说明材料中的位置与适用边界；取消全部勾选可清除关联。"></textarea></label><button class="button button-small" type="submit">保存材料关联</button></fieldset></form>` : '<p class="form-help">先添加证据文件，再为这项需求建立关联。</p>' : ''}</details>`).join('')}</div></section>`;
}
function revisionProposalView(finding: Finding) {
  if (!state || !finding.revisionProposal) return '';
  const proposal = finding.revisionProposal;
  const available = proposalAvailability(state,finding);
  const adoptions = state.revisionAdoptions?.filter(adoption => adoption.findingId === finding.id) ?? [];
  const claim = state.claims.find(item => item.id === finding.claimId);
  const hasText = proposal.text !== undefined, hasScope = proposal.scope !== undefined;
  return `<section class="revision-proposal" aria-label="结构化修订提案"><h3>一起修订这项论断</h3><p>逐项采纳建议文字、范围或补证计划。默认不选中任何项。</p>${available.reason ? `<p class="inline-warning">${esc(available.reason)}</p>` : ''}<form id="revision-proposal-form" data-finding-id="${esc(finding.id)}" data-draft-key="revision-proposal:${esc(finding.id)}"><fieldset ${busy || !available.available ? 'disabled' : ''}>${hasText ? `<div class="proposal-part"><label><input type="checkbox" name="acceptText" ${!available.text ? 'disabled' : ''}><strong>采用建议文字</strong>${!available.text ? ' · 已处理或不可采纳' : ''}</label><p class="small-label">当前文字</p><p>${esc(claim?.text)}</p><p class="small-label">建议文字</p><p>${esc(proposal.text)}</p></div>` : ''}${hasScope ? `<div class="proposal-part"><label><input type="checkbox" name="acceptScope" ${!available.scope ? 'disabled' : ''}><strong>采用建议范围</strong>${!available.scope ? ' · 已处理或不可采纳' : ''}</label><p>${esc(scopeNames[claim?.scope ?? ''] ?? claim?.scope)} → ${esc(scopeNames[proposal.scope!] ?? proposal.scope)}</p></div>` : ''}${proposal.evidenceNeeds?.length ? `<div class="proposal-part"><strong>加入补证计划</strong>${proposal.evidenceNeeds.map((need,index) => `<label class="proposal-evidence-option"><input name="need_${index}" type="checkbox" value="${esc(need.id)}" ${!available.evidenceNeedIds.includes(need.id) ? 'disabled' : ''}><span>${esc(need.description)}<small>${esc(evidenceCategoryNames[need.category] ?? need.category)}${!available.evidenceNeedIds.includes(need.id) ? ' · 已处理或不可采纳' : ''}</small></span></label>`).join('')}</div>` : ''}<label>采纳理由<textarea name="rationale" rows="3" required maxlength="5000" placeholder="说明所选修改的依据与适用边界。"></textarea></label><button class="button button-primary" type="submit">采纳选中部分</button></fieldset></form><p class="form-help">未选中的项保留为候选。采纳计划不等于已获得证据；修订文字或范围后需重新审查。</p>${adoptions.length ? `<details data-details-key="adoptions:${esc(finding.id)}"><summary>已采纳记录 · ${adoptions.length} 次</summary>${adoptions.map(adoption => `<p><strong>版本 ${adoption.revision}</strong> · ${[adoption.acceptText ? '论断文字' : '',adoption.acceptScope ? '适用范围' : '',adoption.evidenceNeedIds.length ? `${adoption.evidenceNeedIds.length} 项补证计划` : ''].filter(Boolean).join('、')}</p><p>${esc(adoption.rationale)}</p>`).join('')}</details>` : ''}</section>`;
}
function selectedRun() { return bridge?.feedback().sessionId === activeSessionId ? bridge.feedback().runs.filter(run => run.claimId === selectedClaimId).at(-1) : undefined; }
const pendingRun = () => { const run = selectedRun(); return run && ['queued', 'working', 'needs_input'].includes(run.phase); };
function feedbackSummaryView() {
  if (!bridge) return '';
  const feedback = bridge.feedback(), run = selectedRun();
  return `<div class="feedback-summary"><span class="connection-dot ${feedback.connection}" aria-hidden="true"></span><span>${esc(run ? `${phaseNames[run.phase]}：${run.message}` : feedback.message)}</span>${feedback.connection === 'retrying' && run ? '<strong>连接中断，进展可能过时</strong>' : ''}<button class="text-button" data-action="show-feedback">查看进展</button></div>`;
}
function feedbackView() {
  if (!bridge) return '';
  const feedback = bridge.feedback();
  const run = selectedRun();
  const seconds = run ? Math.max(0, Math.floor((Date.now() - Date.parse(run.updatedAt)) / 1000)) : 0;
  return `<section class="review-feedback" aria-label="对话与复核进展"><div class="feedback-connection"><span class="connection-dot ${feedback.connection}" aria-hidden="true"></span><span>${esc(feedback.message)}</span><button class="text-button" data-action="refresh-feedback" ${busy ? 'disabled' : ''}>刷新</button></div>${run ? `<div class="feedback-heading"><strong>${esc(phaseNames[run.phase])}</strong><span>${seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分钟`}前更新</span></div><p>${esc(run.message)}</p><div class="feedback-meta">${run.resourceIds.length} 份选定证据 · ${run.findingIds.length} 项已保存发现</div>${pendingRun() && seconds >= 30 ? '<p class="feedback-wait">尚无新的进展报告。请查看聊天中的回复；页面不会把等待时间当作工作进度，也不会自动重发。</p>' : ''}${run.phase === 'needs_input' ? '<p class="feedback-wait">请在 ChatGPT 对话中回答上方问题。若需添加证据，请在页面添加后重新发起复核。</p>' : ''}${pendingRun() ? '<button class="text-button" data-action="cancel-review">结束等待</button>' : ''}<span class="feedback-boundary">进展由 Agent 报告；已保存的发现可在当前审查中查看。临时进展在服务重启后清空。</span>` : `<p>${bridge.mode === 'local' ? '本地预览可运行规则检查；定向复核需要在 ChatGPT 宿主中打开。' : '选择审查方式和证据后发起复核，处理进展会显示在这里。'}</p>`}</section>`;
}
function refreshFeedbackView() {
  const run = selectedRun();
  const announcement = page === 'workbench' && bridge ? `${bridge.feedback().message}${run ? `。${phaseNames[run.phase]}：${run.message}` : ''}` : '';
  if (feedbackAnnouncement.textContent !== announcement) feedbackAnnouncement.textContent = announcement;
  // Update only the status region: never replace an in-progress decision or IME input.
  for (const slot of root.querySelectorAll<HTMLElement>('[data-feedback-slot]')) {
    if (slot.contains(document.activeElement)) continue;
    const html = feedbackView();
    if (slot.innerHTML !== html) slot.innerHTML = html;
  }
  for (const slot of root.querySelectorAll<HTMLElement>('[data-feedback-summary]')) {
    if (slot.contains(document.activeElement)) continue;
    const html = feedbackSummaryView();
    if (slot.innerHTML !== html) slot.innerHTML = html;
  }
  const button = root.querySelector<HTMLButtonElement>('[data-action="request-review"]');
  if (button) button.disabled = busy || bridge?.mode !== 'host' || !currentClaim() || state?.reviewStatus === 'paused' || Boolean(pendingRun());
}
function reviewRequestView() {
  return `<div class="agent-review"><div>${icon('sparkle')}<strong>与 ChatGPT 定向复核</strong></div><p>只审阅当前论断和你选择的证据。先明确关注点，再逐项处理发现。</p><form id="review-options" data-draft-key="review-options:${esc(selectedClaimId)}"><label for="review-mode">审查方式</label><select id="review-mode" name="mode"><option value="evidence">证据核对</option><option value="methods">研究设计与方法</option><option value="challenge">异议与替代解释</option></select><label for="review-focus">这次最想核对什么？（可选）</label><textarea id="review-focus" name="focus" rows="3" maxlength="2000" placeholder="例如：供体数是否支持结论？这项建议是否忽略了反证？"></textarea><p class="form-help">当前选择 ${checkedResources().size} 份证据；可在「证据文件」中调整。</p><button type="button" class="button" data-action="request-review" ${busy || bridge?.mode !== 'host' || !currentClaim() || state?.reviewStatus === 'paused' || pendingRun() ? 'disabled' : ''}>${pendingRun() ? '本次复核正在处理中' : '发起定向复核'} ${icon('arrow')}</button></form><div data-feedback-slot>${feedbackView()}</div></div>`;
}
function evidenceLabel(resource: Resource) { return resource.evidenceKind === 'computational_receipt' ? '计算回执 · 导入材料' : resource.evidenceKind === 'doi_verification' ? 'DOI 分层核验' : resource.sourceKind === 'synthetic_fixture' ? '合成示例' : resource.sourceKind === 'host_resource' ? '宿主资源' : '研究者上传'; }
function resourceButton(resource: Resource, previewOnly = false) {
  return `<div class="resource-row ${selectedResourceId === resource.id ? 'is-previewed' : ''}">
    ${previewOnly ? '' : `<input class="resource-checkbox" type="checkbox" data-resource="${esc(resource.id)}" aria-label="将 ${esc(resource.name)} 纳入上下文" ${checkedResources().has(resource.id) ? 'checked' : ''} ${busy ? 'disabled' : ''}>`}
    <span class="file-icon">${icon('file')}</span>
    <button class="resource-name" data-action="preview" data-id="${esc(resource.id)}"><strong>${esc(resource.name)}</strong><span>${esc(evidenceLabel(resource))} · ${esc(resource.mediaType)}</span></button>
    ${icon('chevron', 'resource-chevron')}
  </div>`;
}
function relativeTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '时间未记录';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  return minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时前` : minutes < 30 * 1440 ? `${Math.floor(minutes / 1440)} 天前` : new Date(time).toLocaleDateString('zh-CN');
}
function homeView() {
  const needle = homeQuery.trim().toLocaleLowerCase();
  const projects = catalog?.projects.filter(project => !needle || project.title.toLocaleLowerCase().includes(needle)) ?? [];
  const selectedProject = catalog?.projects.find(project => project.id === homeProjectId);
  const sessions = [...(catalog?.sessions ?? [])].filter(session => (!homeProjectId || session.projectId === homeProjectId) && (!needle || `${session.title} ${catalog?.projects.find(project => project.id === session.projectId)?.title ?? ''}`.toLocaleLowerCase().includes(needle))).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  return `<main class="home-shell"><header class="home-header"><div class="home-brand"><h1>Research Locus</h1><p>科研共审 · 项目与会话</p></div><div class="home-actions"><button class="icon-button" data-action="home-search" aria-label="搜索项目和会话" title="搜索 · Ctrl K">${icon('search')}</button><button class="icon-button" data-action="home-refresh" aria-label="刷新项目列表" title="刷新">${icon('refresh')}</button><button class="button" data-action="new-project">${icon('plus')}新建项目</button></div></header>
    <label class="home-search">${icon('search')}<input id="home-search" type="search" aria-label="搜索项目和会话" placeholder="搜索项目和会话…" value="${esc(homeQuery)}">${homeQuery ? '<button class="icon-button" data-action="home-clear-search" aria-label="清除搜索">×</button>' : ''}</label>
    ${notice ? `<div class="notice ${notice.kind}" role="${notice.kind === 'error' ? 'alert' : 'status'}"><span>${esc(notice.text)}</span><button class="icon-button" data-action="dismiss-notice" aria-label="关闭消息">${icon('close')}</button></div>` : ''}
    ${busy ? `<div class="busy-message" role="status"><span class="spinner"></span>${esc(busyLabel)}</div>` : ''}
    ${homeForm ? `<form class="home-form" id="${homeForm === 'project' ? 'new-project-form' : 'new-session-form'}" data-draft-key="home-${homeForm}:${esc(homeProjectId)}"><div class="section-title"><h2>${homeForm === 'project' ? '新建项目' : `在「${esc(selectedProject?.title ?? '')}」中新建会话`}</h2><button class="icon-button" data-action="cancel-home-form" aria-label="关闭新建表单">${icon('close')}</button></div><label for="home-title">${homeForm === 'project' ? '项目名称' : '会话名称'}</label><input id="home-title" name="title" required maxlength="160" placeholder="${homeForm === 'project' ? '例如：肺组织空间转录组研究' : '例如：差异表达结果复核'}"><p>新会话从空白开始，保存各自的论断、证据与审查记录。</p><button class="button button-primary" type="submit" ${busy ? 'disabled' : ''}>${homeForm === 'project' ? '创建项目' : '创建并打开会话'}</button></form>` : ''}
    <div class="home-columns"><section class="home-section" aria-label="项目"><div class="home-section-heading"><h2>${icon('book')}项目 <span>${projects.length}</span></h2></div><div class="home-list">${projects.length ? projects.map(project => `<button class="home-project-row ${project.id === homeProjectId ? 'selected' : ''}" data-action="open-project" data-id="${esc(project.id)}" aria-pressed="${project.id === homeProjectId}"><span class="row-title">${esc(project.title)}</span><span class="row-meta">${project.sessionCount} 个会话</span><time class="row-time" datetime="${esc(project.updatedAt)}" title="${esc(project.updatedAt)}">${esc(relativeTime(project.updatedAt))}</time></button>`).join('') : `<div class="home-empty"><p>${needle ? '没有匹配的项目。' : '创建一个项目，开始整理研究。'}</p></div>`}</div>
    ${selectedProject ? `<div class="home-project-detail"><h3>${esc(selectedProject.title)}</h3><p>${selectedProject.sessionCount ? '在右侧选择会话继续工作，或开始一次新的共审。' : '这个项目还没有会话，创建后即可添加论断与文件。'}</p><button class="button button-primary" data-action="new-session">${icon('plus')}新建会话</button></div>` : '<p class="section-description">选择项目，查看其中的会话。</p>'}</section>
    <section class="home-section" aria-label="最近会话"><div class="home-section-heading"><h2>${icon('clock')}${selectedProject ? '项目会话' : '最近会话'}</h2>${selectedProject ? '<button class="text-button home-back" data-action="all-projects">查看全部</button>' : ''}</div><div class="home-list">${sessions.length ? sessions.map(session => `<button class="home-session-row" data-action="open-session" data-id="${esc(session.id)}"><span class="session-dot" aria-hidden="true"></span><div class="session-label"><strong>${esc(session.title)}</strong><span>${esc(catalog?.projects.find(project => project.id === session.projectId)?.title ?? '')}${session.fixture ? ' · 合成示例' : ''} · ${session.claimCount} 个论断${session.reviewStatus === 'paused' ? ' · 已暂停' : ''}</span></div><time class="row-time" datetime="${esc(session.updatedAt)}" title="${esc(session.updatedAt)}">${esc(relativeTime(session.updatedAt))}</time></button>`).join('') : `<div class="home-empty"><p>${needle ? '没有匹配的会话。' : selectedProject ? '还没有会话。' : '保存的共审会话会显示在这里。'}</p>${selectedProject && !needle ? '<button class="text-button" data-action="new-session">创建第一个会话 →</button>' : ''}</div>`}</div></section></div>
    <footer class="home-footer"><span>${bridge?.mode === 'host' ? 'Research Locus' : '本地工作区'} · 最近会话按最后保存时间排列</span><span>打开会话，可回看证据、版本与介入记录。</span></footer></main>`;
}
function setRoute(route: string) {
  // A browser back/forward action during a request keeps its navigation target.
  if (bridge?.mode === 'local' && !pendingLocalRoute) window.history.pushState(null, '', route ? `#${route}` : window.location.pathname);
}
async function openSavedSession(id: string, route = true) {
  stopReplay();
  await perform('正在打开会话…', async () => {
    captureDrafts(); loadingSession = true;
    try {
      const next = await bridge.openSession(id);
      captureDrafts(); root.replaceChildren();
      if (activeSessionId && activeSessionId !== id) stagedFile = bridge.stagedFile();
      activeSessionId = id; state = null;
      replayCursorId = ''; replayState = null; replaySteps = [];
      selectedClaimId = ''; selectedFindingId = ''; selectedResourceId = ''; editingResourceId = ''; query = ''; creatingClaim = false; mobileNavOpen = false;
      selectedResources.clear(); section = 'review'; reviewTab = 'review'; page = 'workbench'; homeForm = null;
      loadingSession = false; receiveState(next);
      if (route) setRoute(`session/${encodeURIComponent(id)}`);
    } finally { loadingSession = false; }
  });
}
async function openHome(route = true) {
  stopReplay();
  await perform('正在读取项目与会话…', async () => {
    catalog = await bridge.listCatalog(); page = 'home'; mobileNavOpen = false; homeForm = null;
    if (route) { homeProjectId = ''; homeQuery = ''; setRoute(''); }
  });
}
function sidebar() {
  const links: [Section, string, string, string][] = [['review', 'grid', '论断共审', String(state?.claims.length ?? 0)], ['resources', 'file', '证据资源', String(state?.resources.length ?? 0)], ['replay', 'replay', '回放剧场', ''], ['history', 'clock', '介入记录', ''], ['project', 'book', '项目与边界', '']];
  return `<aside class="sidebar ${mobileNavOpen ? 'is-open' : ''}" aria-label="工作区导航">
    <div class="sidebar-heading"><a class="brand" href="#" data-action="section" data-id="review">${icon('book')}<span>Research Locus</span></a><button class="icon-button mobile-menu" data-action="menu" aria-label="关闭导航">${icon('close')}</button></div>
    <div class="sidebar-quick-actions"><button class="nav-item" data-action="home">${icon('book')}<span>项目首页</span></button><button class="nav-item" data-action="create-claim">${icon('plus')}<span>新建论断</span></button><button class="nav-item" data-action="focus-search">${icon('search')}<span>搜索论断</span><kbd>Ctrl K</kbd></button></div>
    <nav>${links.map(([id, glyph, name, count]) => `<button class="nav-item ${section === id ? 'active' : ''}" data-action="section" data-id="${id}" ${section === id ? 'aria-current="page"' : ''}>${icon(glyph)}<span>${name}</span>${count ? `<span class="nav-count">${count}</span>` : ''}</button>`).join('')}</nav>
    ${claimList()}
    <div class="sidebar-footer"><div class="mode-line">${icon('shield')}<span>${bridge?.mode === 'host' ? 'MCP 宿主' : '本地预览'} · v0.1</span></div></div>
  </aside>`;
}
function header() {
  const names = { review: '论断共审', resources: '证据资源', replay: '回放剧场', history: '介入记录', project: '项目与边界' };
  if (section === 'replay') return `<header class="topbar"><div class="breadcrumb"><button class="mobile-menu icon-button" data-action="menu" aria-label="切换导航">${icon('grid')}</button><strong>回放剧场</strong><span class="status-pill">只读</span></div><button class="button" data-action="section" data-id="review">返回当前共审 ${icon('arrow')}</button></header>`;
  return `<header class="topbar"><div class="breadcrumb"><button class="mobile-menu icon-button" data-action="menu" aria-label="切换导航" aria-expanded="${mobileNavOpen}">${icon('grid')}</button><strong>${names[section]}</strong><span class="status-pill">${state?.reviewStatus === 'paused' ? '已暂停' : '进行中'}</span></div><div class="workspace-toolbar"><button class="button button-primary" data-action="run" ${busy || state?.reviewStatus === 'paused' ? 'disabled' : ''}>${icon('play')}运行检查</button><button class="button" data-action="attach" ${busy || !currentClaim() ? 'disabled' : ''}>${icon('plus')}添加文件</button><button class="icon-button" data-action="toggle-pause" aria-label="${state?.reviewStatus === 'paused' ? '恢复共审' : '暂停共审'}" title="${state?.reviewStatus === 'paused' ? '恢复共审' : '暂停共审'}" ${busy ? 'disabled' : ''}>${icon(state?.reviewStatus === 'paused' ? 'play' : 'pause')}</button><details class="toolbar-more" data-details-key="toolbar-more"><summary class="icon-button" aria-label="更多操作" title="更多操作">⋯</summary><div class="toolbar-menu"><button data-action="export">${icon('download')}导出快照</button><button data-action="refresh">${icon('refresh')}刷新工作区</button><button data-action="section" data-id="project">${icon('book')}项目与边界</button></div></details></div></header>`;
}
function topContent() {
  if (!state) return '';
  const active = state.findings.filter(f => f.status === 'active');
  return `<div class="session-summary"><button class="text-button" data-action="home">${icon('book')}${esc(catalog?.projects.find(project => project.id === state?.projectId)?.title ?? '项目首页')}</button><span class="neutral-badge">${state.fixture ? '合成示例' : '研究会话'}</span><span>${state.claims.length} 个论断</span><span>${active.length} 项当前发现</span><span>${state.decisions.length} 次介入</span><span class="summary-revision">版本 ${state.revision}</span></div>`;
}
function claimList() {
  if (!state) return '';
  const claims = state.claims.filter(c => {
    const findings = activeFindings(c.id);
    const match = !query || `${c.text} ${c.id} ${findings.map(f => f.title).join(' ')}`.toLowerCase().includes(query.toLowerCase());
    return match;
  });
  return `<section class="sidebar-claims" aria-label="论断队列"><label class="search-field">${icon('search')}<input id="claim-search" type="search" placeholder="搜索论断…" value="${esc(query)}" aria-label="搜索论断"></label><div class="panel-title"><h2>${query ? '搜索结果' : '研究论断'} <span>${claims.length}</span></h2></div><div class="claim-list">${claims.map(c => `<button class="side-claim ${c.id === selectedClaimId ? 'selected' : ''}" data-action="claim" data-id="${esc(c.id)}" title="${esc(c.text)}" aria-current="${c.id === selectedClaimId ? 'true' : 'false'}"><span class="side-claim-dot" aria-hidden="true">${c.disposition === 'rejected' ? '×' : state?.reReview?.some(flag => flag.claimId === c.id && flag.status === 'pending') ? '!' : activeFindings(c.id).length ? '●' : '○'}</span><span>${esc(c.text)}${c.disposition === 'rejected' ? '<em class="claim-status-label">已驳回</em>' : state?.reReview?.some(flag => flag.claimId === c.id && flag.status === 'pending') ? '<em class="claim-status-label">需要重审</em>' : ''}</span><small>${activeFindings(c.id).length || ''}</small></button>`).join('') || '<div class="empty-state compact"><p>没有匹配的论断</p><button class="text-button" data-action="clear-search">清除搜索</button></div>'}</div></section>`;
}
function findingsView(claim: Claim) {
  const active = activeFindings(claim.id);
  const historical = claimFindings(claim.id).filter(f => f.status === 'stale');
  const cards = (findings: Finding[]) => findings.map(f => `<button class="finding-card ${f.id === selectedFindingId ? 'selected' : ''} ${f.status === 'stale' ? 'stale' : ''}" data-action="finding" data-id="${esc(f.id)}" aria-pressed="${f.id === selectedFindingId}"><div class="finding-top"><span class="severity ${f.severity}">${severityLabel(f.severity)}</span><span class="finding-category">${esc(categoryNames[f.category] ?? f.category)}${f.status === 'stale' ? ' · 已过期' : ''}</span></div><h4>${esc(f.title)}</h4><p>${esc(f.rationale)}</p><div class="finding-source"><span>${f.source === 'deterministic_check' ? '规则检查' : f.revisionProposal ? 'Agent 建议 · 含修订提案' : 'Agent 建议'}</span><span>${f.id === selectedFindingId ? '正在审阅' : '审阅此项'} ${icon('arrow')}</span></div></button>`).join('');
  return `<section class="detail-section findings-section"><div class="section-title"><h3>当前发现 <span class="count">${active.length}</span></h3><span class="small-label">选择一项，在右侧回应</span></div>${active.length ? `<div class="findings-list">${cards(active)}</div>` : '<div class="empty-state compact"><strong>暂无当前发现</strong><p>请查看上方规则报告与待补充项；无发现不代表结论成立。</p></div>'}${historical.length ? `<details class="historical-findings" data-details-key="history:${esc(claim.id)}"><summary>历史发现 · ${historical.length} 项已过期</summary><div class="findings-list">${cards(historical)}</div></details>` : ''}</section>`;
}
function claimDetail() {
  const claim = currentClaim(); if (!claim || !state) return `<article class="claim-detail"><div class="empty-state"><h1>${esc(state?.title ?? '新的研究会话')}</h1><p>先添加一个需要审查的论断，再为它关联证据文件。</p><button class="button button-primary" data-action="create-claim">${icon('plus')}添加第一个论断</button></div></article>`;
  const resources = state.resources.filter(r => claim.resourceIds.includes(r.id));
  return `<article class="claim-detail"><div class="detail-heading"><span class="overline">当前论断</span><span class="neutral-badge">${esc(scopeNames[claim.scope] ?? claim.scope)}</span></div><h1 class="claim-statement">${esc(claim.text)}</h1><div class="evidence-ceiling">${icon('shield')}<span>NOT_ASSESSED · 证据尚未评估 · 科学结论待独立验证</span></div>${localReviewView(claim)}
  <div class="review-body-tabbar" role="tablist" aria-label="论断内容"><button role="tab" id="review-tab" tabindex="${reviewTab === 'review' ? 0 : -1}" aria-selected="${reviewTab === 'review'}" aria-controls="claim-tabpanel" data-action="review-tab" data-id="review">${icon('grid')}当前审查 <span>${activeFindings(claim.id).length}</span></button><button role="tab" id="evidence-tab" tabindex="${reviewTab === 'evidence' ? 0 : -1}" aria-selected="${reviewTab === 'evidence'}" aria-controls="claim-tabpanel" data-action="review-tab" data-id="evidence">${icon('file')}证据文件 <span>${resources.length}</span></button></div><div id="claim-tabpanel" role="tabpanel" aria-labelledby="${reviewTab}-tab">
  ${reviewTab === 'review' ? `<details class="revise-box" data-details-key="revise:${esc(claim.id)}"><summary>${icon('file')}修订论断<span>措辞、范围与审查信息</span>${icon('plus')}</summary><form id="revise-form" data-draft-key="revise:${esc(claim.id)}"><input type="hidden" name="baselineText" value="${esc(claim.text)}"><input type="hidden" name="baselineScope" value="${esc(claim.scope)}"><input type="hidden" name="baselineMetadata" value="${esc(metadataSignature(claim.metadata))}"><label>论断内容<textarea name="text" rows="4" required maxlength="10000">${esc(claim.text)}</textarea></label><label>适用范围<select name="scope">${Object.entries(scopeNames).map(([value, name]) => `<option value="${value}" ${claim.scope === value ? 'selected' : ''}>${name}</option>`).join('')}</select></label>${metadataFields(claim.metadata, 'revise-meta')}<label>修订理由<textarea name="rationale" rows="2" required maxlength="5000" placeholder="说明修改依据…"></textarea></label><p class="form-help">修改会使本论断及受影响的依赖下游意见过期；其他论断保留已有审查。</p><button class="button button-primary" type="submit" ${busy ? 'disabled' : ''}>保存修订</button></form></details>${evidenceIntakeSummary(resources)}${claimGraphView(claim)}${evidencePlanView(claim)}${designCardView(claim)}${metadataReviewView(claim)}${findingsView(claim)}<button class="button evidence-shortcut" data-action="review-tab" data-id="evidence">${icon('file')}查看 ${resources.length} 份关联证据 ${icon('arrow')}</button>` : `<section class="detail-section"><div class="section-title"><h3>关联证据 <span class="count">${resources.length}</span></h3><button class="text-button" data-action="attach" ${busy ? 'disabled' : ''}>${icon('plus')}添加文件</button></div><p class="section-description">勾选要提供给 Agent 的资源，再同步到对话。</p><div class="resource-list">${resources.length ? resources.map(r => resourceButton(r)).join('') : '<div class="muted-box">尚无关联证据。可通过顶部「添加文件」导入。</div>'}</div><div class="context-actions"><span><strong id="selected-resource-count">${checkedResources().size}</strong> 个资源已选择</span><button class="button button-small" data-action="sync" ${busy ? 'disabled' : ''}>${icon('link')}同步上下文</button></div>${resources.filter(resource => resource.evidenceKind).map(evidenceRecordView).join('')}${filePreview()}${evidenceIntakeForms(claim.id,busy)}</section>`}</div>
  <div class="detail-footer"><span>快照 <code>${esc(state.snapshotHash.slice(0, 12))}…</code></span><button class="text-button" data-action="refresh" ${busy ? 'disabled' : ''}>${icon('refresh')}刷新</button></div></article>`;
}
function decisionPanel() {
  const finding = currentFinding();
  const relatedDecisions = state?.decisions.filter(d => (d as unknown as Record<string, unknown>).findingId === selectedFindingId) ?? [];
  return `<aside class="decision-panel" aria-label="研究者决策"><div class="decision-title"><span class="decision-icon">${icon('sparkle')}</span><div><h2>研究者判断</h2></div></div>${finding ? `<div class="decision-target"><span class="small-label">正在回应的发现</span><strong>${esc(finding.title)}</strong><code>${esc(finding.id)}</code></div>${finding.status === 'stale' ? '<div class="inline-warning">原发现已过期，不能再提交处理决定。若下方修订提案仍有可采纳部分，可继续逐项确认。</div>' : ''}<form id="decision-form" data-draft-key="decision:${esc(finding.id)}"><fieldset ${busy || finding.status === 'stale' ? 'disabled' : ''}><legend>选择你的处理方式</legend>${[['challenge', '质疑建议', '提出反证、替代解释或方法异议'], ['dismiss', '驳回建议', '说明为什么该建议不适用'], ['defer', '暂缓决定', '保留问题，等待更多证据'], ['accept_with_limits', '附条件采纳', '明确适用边界与后续条件']].map(([value, title, subtitle], index) => `<label class="decision-option"><input type="radio" name="decision" value="${value}" ${index === 0 ? 'checked' : ''}><span><strong>${title}</strong><small>${subtitle}</small></span></label>`).join('')}<label class="rationale-label" for="decision-rationale">判断依据 <span>必填</span></label><textarea id="decision-rationale" name="rationale" rows="4" maxlength="5000" required placeholder="写下你的理由、相关证据或需要进一步核实的内容…"></textarea><div id="conditions-field" hidden><label class="rationale-label" for="decision-conditions">采纳条件 <span>必填，每行一项</span></label><textarea id="decision-conditions" name="conditions" rows="3" maxlength="5000" placeholder="例如：仅限本样本，不作人群外推"></textarea></div><button class="button button-primary decision-submit" type="submit">${icon('check')}提交研究者决定</button></fieldset></form><p class="decision-footnote">记录为界面中的研究者操作，不等同于身份认证、伦理批准或科学签署。</p>${revisionProposalView(finding)}${relatedDecisions.length ? `<div class="recent-decision"><span class="small-label">本项介入记录</span>${relatedDecisions.slice(-2).map(d => { const x = d as unknown as Record<string, unknown>; return `<div><strong>${esc(decisionNames[String(x.decision)] ?? '已记录决定')}</strong><p>${esc(x.rationale)}</p></div>`; }).join('')}</div>` : ''}` : `<div class="empty-state compact">${icon('grid')}<strong>选择一项检查发现</strong><p>你可以质疑、驳回、暂缓，或限定采纳范围。</p></div>`}${reviewRequestView()}</aside>`;
}
function filePreview() {
  const resource = state?.resources.find(r => r.id === selectedResourceId);
  if (!resource) return '';
  if (resource.evidenceKind) return `<section class="file-preview" aria-label="原始证据记录"><div><strong>${esc(resource.name)}</strong><button class="icon-button" data-action="close-preview" aria-label="关闭预览">${icon('close')}</button></div>${section === 'resources' ? evidenceRecordView(resource) : ''}<details><summary>查看原始记录 JSON（纯文本）</summary><pre tabindex="0">${esc(resource.content.slice(0,14000))}${resource.content.length > 14000 ? '\n…（预览截取前 14,000 个字符；完整内容保留在快照）' : ''}</pre></details><span class="hash-label">记录 SHA-256 <code>${esc(resource.sha256)}</code></span></section>`;
  const canEdit = bridge?.mode === 'host' && resource.sourceKind === 'host_resource' && !!resource.sourceUri;
  const editing = canEdit && editingResourceId === resource.id;
  return `<section class="file-preview" aria-label="文件预览"><div><strong>${esc(resource.name)}</strong><button class="icon-button" data-action="close-preview" aria-label="关闭预览">${icon('close')}</button></div><p>纯文本预览 · ${esc(evidenceLabel(resource))} · 内容不会作为操作指令执行</p>${editing ? `<form id="resource-edit-form" class="resource-editor" data-draft-key="resource:${esc(resource.id)}"><label for="resource-edit-content">编辑宿主文件内容</label><textarea id="resource-edit-content" name="content" rows="10" maxlength="1000000">${esc(resource.content)}</textarea><p>此操作写回当前宿主文件。必须与打开的文件 URI 相同，且宿主提供可写权限和版本标识；保存后请重新导入证据。</p><button class="button button-primary" type="submit" ${busy ? 'disabled' : ''}>保存到该宿主文件</button><button class="text-button" type="button" data-action="cancel-edit">取消编辑</button></form>` : `<pre tabindex="0">${esc(resource.content.slice(0, 14000))}${resource.content.length > 14000 ? '\n…（预览截取前 14,000 个字符）' : ''}</pre>${canEdit ? `<button class="button preview-edit-button" data-action="edit-resource">${icon('file')}编辑宿主文件</button>` : ''}`}<span class="hash-label">SHA-256 <code>${esc(resource.sha256)}</code></span>${resource.sourceUri ? `<span class="source-uri">来源：${esc(resource.sourceUri)}</span>` : ''}</section>`;
}
function resourcesView() {
  if (!state) return '';
  return `<section class="full-panel"><div class="full-panel-heading"><div><span class="overline">EVIDENCE LIBRARY</span><h2>证据资源库</h2><p>每份资源保留来源与内容摘要。选择论断后可在共审台绑定新增文件。</p></div><button class="button" data-action="attach" ${busy || !currentClaim() ? 'disabled' : ''}>${icon('plus')}添加到当前论断</button></div><div class="library-layout"><div class="resource-list">${state.resources.map(r => resourceButton(r, true)).join('') || '<div class="empty-state">尚无资源。</div>'}</div><div class="library-preview">${filePreview() || `<div class="empty-state">${icon('file')}<strong>查看证据，而不离开工作区</strong><p>选择资源，预览内容、来源与校验值。</p></div>`}</div></div></section>`;
}
function newClaimForm() {
  return `<section class="full-panel create-claim-panel"><div class="section-title"><h3>添加你要审查的论断</h3><button class="icon-button" data-action="cancel-create" aria-label="关闭新建论断">${icon('close')}</button></div><form id="new-claim-form" data-draft-key="new-claim"><label for="new-claim-text">论断内容</label><textarea id="new-claim-text" name="text" rows="3" required maxlength="8000" placeholder="准确描述需要共同审查的研究论断…"></textarea><div class="new-claim-fields"><label>外推范围<select name="scope">${Object.entries(scopeNames).map(([value, name]) => `<option value="${value}">${name}</option>`).join('')}</select></label><label>纳入理由<input type="text" name="rationale" required maxlength="5000" placeholder="为什么需要审查这项论断？"></label></div>${metadataFields({}, 'new-meta')}<div class="create-claim-actions"><p>新论断初始证据上限为「尚未评估」。</p><button class="button button-primary" type="submit" ${busy ? 'disabled' : ''}>${icon('plus')}加入共审队列</button></div></form></section>`;
}
function stagedFilePanel() {
  if (!stagedFile) return '';
  return `<section class="full-panel staged-file-panel"><div class="section-title"><h3>${icon('file')} 从宿主打开：${esc(stagedFile.name)}</h3><button class="icon-button" data-action="dismiss-staged" aria-label="关闭已打开文件预览">${icon('close')}</button></div><p class="section-description">文件已读取，尚未自动加入证据或对话上下文。你可以先查看和编辑，再主动纳入当前论断。</p><details><summary>查看文件与编辑内容</summary><form id="staged-file-form" data-draft-key="staged:${esc(stagedFile.sourceUri ?? stagedFile.name)}"><textarea name="content" rows="9" maxlength="1000000" aria-label="已打开的宿主文件内容">${esc(stagedFile.content)}</textarea>${stagedFile.sourceUri ? '<p class="form-help">保存将按宿主版本标识写回同一文件；需宿主提供可写权限。</p><button class="button" type="submit">保存当前宿主文件</button>' : ''}</form></details><div class="create-claim-actions"><span class="small-label">${esc(stagedFile.mediaType)} · ${stagedFile.content.length.toLocaleString()} 字符</span><button class="button button-primary" data-action="attach-staged" ${busy || !currentClaim() ? 'disabled' : ''}>${icon('plus')}纳入当前论断</button></div></section>`;
}
function eventRecord(event: unknown, index: number) {
  const item = event as Record<string, unknown>;
  const actionData = item.action && typeof item.action === 'object' ? item.action as Record<string, unknown> : {};
  const action = String(item.type ?? actionData.type ?? item.kind ?? 'event');
  const description = item.summary ?? actionData.rationale ?? item.description;
  const actor = item.actor && typeof item.actor === 'object' ? item.actor as Record<string, unknown> : {};
  const actorLabel = actor.kind === 'researcher' ? '研究者操作（身份未认证）' : actor.kind === 'agent' ? 'Agent' : '系统';
  const time = item.timestamp ?? item.createdAt ?? item.at;
  return `<li class="timeline-item"><span class="timeline-marker">${icon(action.includes('interven') ? 'check' : action.includes('review') ? 'sparkle' : 'file')}</span><div><div class="timeline-item-top"><strong>${esc(actionNames[action] ?? action)}</strong><code>${esc(item.id ?? `EVENT ${index + 1}`)}</code></div>${description ? `<p>${esc(description)}</p>` : ''}<div class="timeline-meta"><span>${esc(actorLabel)}</span><span>${time ? esc(String(time)) : ''}</span>${item.revision != null ? `<span>REV ${esc(item.revision)}</span>` : ''}</div><details><summary>查看完整事件</summary><pre>${esc(JSON.stringify(item, null, 2))}</pre></details></div></li>`;
}
function historyView() {
  if (!state) return '';
  return `<section class="full-panel history-panel"><div class="full-panel-heading"><div><span class="overline">REVIEW TRAIL</span><h2>每次介入，都留下依据</h2><p>按时间倒序展示当前会话记录。快照导出包含完整的决定与事件。</p></div><span class="neutral-badge">${state.events.length} 个事件</span></div><ol class="timeline">${state.events.length ? [...state.events].reverse().map((event, i) => eventRecord(event, state!.events.length - i - 1)).join('') : '<li class="empty-state">还没有记录。运行一次检查开始共审。</li>'}</ol></section>`;
}
function stopReplay() {
  if (replayTimer !== null) clearInterval(replayTimer);
  replayTimer = null; replayGeneration += 1;
}
function currentReplay() {
  if (state !== replayState) {
    replaySteps = state ? buildReplaySteps(state) : [];
    replayState = state;
  }
  let index = replaySteps.findIndex(step => step.id === replayCursorId);
  if (index < 0) { index = 0; replayCursorId = replaySteps[0]?.id ?? ''; }
  return { steps: replaySteps, index, step: replaySteps[index] };
}
function seekReplay(index: number) {
  stopReplay();
  const { steps } = currentReplay();
  replayCursorId = steps[Math.max(0, Math.min(steps.length - 1, index))]?.id ?? '';
  render();
}
function toggleReplay() {
  if (replayTimer !== null) { stopReplay(); render(); return; }
  const { steps, index } = currentReplay();
  if (steps.length < 2 || document.hidden) return;
  if (index === steps.length - 1) replayCursorId = steps[0].id;
  const session = activeSessionId;
  const generation = ++replayGeneration;
  replayTimer = setInterval(() => {
    if (generation !== replayGeneration) return;
    if (page !== 'workbench' || section !== 'replay' || session !== activeSessionId || document.hidden || busy) { stopReplay(); return; }
    const current = currentReplay();
    if (current.index < current.steps.length - 1) replayCursorId = current.steps[current.index + 1].id;
    if (current.index + 1 >= current.steps.length - 1) stopReplay();
    render();
  }, 2000);
  render();
}
function replayChange(change: ReplayStep['changes'][number]) {
  if (change.before === null || change.after === null) {
    const known = change.after ?? change.before ?? '没有可展示的内容';
    return `<section class="replay-change"><h3>${esc(change.label)}</h3><p class="replay-missing">完整前后内容未记录。以下仅为已保存的一侧${known.length > 30000 ? '（前 30000 字符）' : ''}。</p><pre class="replay-known">${esc(known.slice(0, 30000))}</pre></section>`;
  }
  const diff = diffLines(change.before, change.after, { maxLines: 300, maxCharacters: 30000 });
  const added = diff.lines.filter(line => line.kind === 'add').length;
  const removed = diff.lines.filter(line => line.kind === 'remove').length;
  return `<section class="replay-change"><header><h3>${esc(change.label)}</h3><span class="replay-diff-count">${diff.truncated ? '预览 ' : ''}+${added} / −${removed}</span></header><div class="replay-diff" tabindex="0" aria-label="${esc(change.label)} 的差异，减号为修改前，加号为修改后">${diff.lines.length ? diff.lines.map(line => `<div class="diff-line diff-${line.kind}"><span class="diff-number" aria-hidden="true">${line.beforeLine ?? ''}</span><span class="diff-number" aria-hidden="true">${line.afterLine ?? ''}</span><span class="diff-sign" aria-hidden="true">${line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span><span class="sr-only">${line.kind === 'add' ? '修改后：' : line.kind === 'remove' ? '修改前：' : ''}</span><code>${esc(line.text) || ' '}</code></div>`).join('') : '<p class="replay-missing">内容未改变。</p>'}</div>${diff.truncated ? '<p class="replay-missing">长内容仅展示有界预览；完整保存记录可从快照导出中查看。</p>' : ''}</section>`;
}
function replayView() {
  const { steps, index, step } = currentReplay();
  const playing = replayTimer !== null;
  return `<section class="replay-theater" aria-label="回放剧场"><div class="replay-heading"><div><span class="overline">REPLAY THEATER</span><h1>每一步修改，都可以回看</h1><p>${esc(state?.title)}</p></div><span class="neutral-badge">历史回放 · 不修改当前会话</span></div><div class="replay-transport" role="group" aria-label="回放控制"><div class="replay-controls"><button id="replay-first" class="button button-small" data-action="replay-first" ${index === 0 || !steps.length ? 'disabled' : ''} aria-label="第一步">|←</button><button id="replay-prev" class="button button-small" data-action="replay-prev" ${index === 0 || !steps.length ? 'disabled' : ''}>← 上一步</button><button id="replay-play" class="button button-primary button-small" data-action="replay-play" ${steps.length < 2 ? 'disabled' : ''} aria-label="${playing ? '暂停回放' : index === steps.length - 1 ? '重新播放' : '播放回放'}">${icon(playing ? 'pause' : 'play')}${playing ? '暂停' : index === steps.length - 1 && steps.length > 1 ? '重新播放' : '播放'}</button><button id="replay-next" class="button button-small" data-action="replay-next" ${index >= steps.length - 1 ? 'disabled' : ''}>下一步 →</button><button id="replay-last" class="button button-small" data-action="replay-last" ${index >= steps.length - 1 ? 'disabled' : ''} aria-label="最后一步">→|</button></div><span class="replay-counter" aria-live="polite">第 ${steps.length ? index + 1 : 0} / ${steps.length} 步</span><input id="replay-progress" type="range" min="0" max="${Math.max(0, steps.length - 1)}" step="1" value="${index}" aria-label="回放进度" aria-valuetext="第 ${steps.length ? index + 1 : 0} 步，共 ${steps.length} 步" ${steps.length < 2 ? 'disabled' : ''}></div><div class="replay-layout"><nav class="replay-timeline" aria-label="回放步骤"><div class="replay-list-heading">会话时间线 <span>${steps.length} 项</span></div>${steps.map((item, i) => `<button id="replay-step-${i}" class="replay-step ${item.id === step?.id ? 'selected' : ''}" data-action="replay-step" data-id="${esc(item.id)}" ${item.id === step?.id ? 'aria-current="step"' : ''}><span class="replay-step-number">${i + 1}</span><span><strong>${esc(item.title)}</strong><small>版本 ${item.revision} · ${item.actor.kind === 'researcher' ? '研究者' : 'Agent'}</small></span>${item.id === step?.id ? icon('chevron') : ''}</button>`).join('') || '<p class="replay-missing">尚无已保存的记录。</p>'}</nav><article class="replay-stage" aria-label="当前步骤预览">${step ? `<div class="replay-step-heading"><div><span class="overline">STEP ${index + 1} · REV ${step.revision}</span><h2>${esc(step.title)}</h2><p class="replay-target">${esc(step.target)}</p></div><span class="neutral-badge">${step.availability === 'summary_only' ? '仅摘要' : '已保存记录'}</span></div><div class="replay-meta"><span>${step.actor.kind === 'researcher' ? '研究者（声明身份）' : 'Agent'} · ${esc(step.actor.id)}</span><time datetime="${esc(step.at)}">${esc(new Date(step.at).toLocaleString('zh-CN', {hour12:false}))}</time></div><p class="replay-summary">${esc(step.summary)}</p><div class="replay-diff-legend"><span>− 修改前</span><span>+ 修改后</span><span>空白标记为未变内容</span></div>${step.changes.length ? step.changes.map(replayChange).join('') : `<div class="replay-no-diff">${icon('file')}<h3>${step.availability === 'summary_only' ? '这一事件仅有保存摘要' : '这一事件没有正文差异'}</h3><p>可查看操作和来源；未记录的历史内容不会用当前内容补齐。</p></div>`}<details class="replay-source" data-details-key="replay:${esc(activeSessionId)}:${esc(step.id)}"><summary>记录来源</summary><dl><dt>事件 ID</dt><dd><code>${esc(step.id)}</code></dd><dt>回放范围</dt><dd>本会话已保存的论断、证据与审查操作。未接入宿主全部文件编辑或 Agent 内部过程。</dd></dl></details>` : '<div class="empty-state"><h2>从第一条记录开始</h2><p>保存论断、添加证据或进行审查后，可在这里逐步回看。</p></div>'}</article></div><p class="replay-help">← / → 切换步骤 · 空格播放或暂停 · 每步 2 秒 · 离开页面自动停止</p></section>`;
}
function projectView() {
  if (!state) return '';
  return `<section class="full-panel"><div class="full-panel-heading"><div><span class="overline">PROJECT & EVIDENCE BOUNDARIES</span><h2>${esc(state.title)}</h2><p>把可运行的交互、宿主能力与科学证据分别说明。</p></div><span class="neutral-badge">${esc(state.projectId)}</span></div><div class="project-grid"><div class="project-card"><span class="project-number">01</span><h3>研究者保持决策权</h3><p>规则与 Agent 只能提出建议。研究者可修订论断、选择资源、质疑、驳回或暂缓建议，也可以暂停共审。</p><button class="button" data-action="toggle-pause" ${busy ? 'disabled' : ''}>${icon(state.reviewStatus === 'paused' ? 'play' : 'pause')}${state.reviewStatus === 'paused' ? '恢复共审' : '暂停共审'}</button></div><div class="project-card"><span class="project-number">02</span><h3>当前证据边界</h3><p>${state.fixture ? '本会话包含明确标记的合成演示材料。' : '本会话的材料与结论尚待独立核验。'}规则检查只识别结构性风险，不验证生物学机制或统计真实性。</p><span class="boundary-tag">科学执行授权：${esc(state.scientificAuthorization)}</span></div><div class="project-card"><span class="project-number">03</span><h3>宿主与上下文</h3><p>当前运行于<strong>${bridge?.mode === 'host' ? ' MCP 宿主' : '本地预览'}</strong>。文件选择、上下文同步、定向复核与导出均由显式操作触发；实际能力取决于宿主支持。</p><div class="capability-list">${(bridge?.capabilities() ?? []).map(c => `<code>${esc(c)}</code>`).join('') || '<span class="small-label">宿主尚未报告额外能力</span>'}</div></div><div class="project-card"><span class="project-number">04</span><h3>快照与来源</h3><p>修改会推进版本，并按受影响的论断及依赖关系安排局部重审。导出保留论断关系、提案、补证计划与事件；摘要用于核对内容，不能证明科学有效性。</p><button class="button" data-action="export" ${busy ? 'disabled' : ''}>${icon('download')}导出当前 JSON 快照</button></div></div><div class="project-hash"><span>完整快照摘要</span><code>${esc(state.snapshotHash)}</code></div></section>`;
}
function render() {
  if (page !== 'workbench' || section !== 'replay' || busy) stopReplay();
  if (composing) return;
  const focused = document.activeElement as HTMLElement | null;
  const oldReplayList = root.querySelector<HTMLElement>('.replay-timeline');
  const replayScroll = { top: oldReplayList?.scrollTop ?? 0, left: oldReplayList?.scrollLeft ?? 0 };
  const focusSelector = focused && root.contains(focused) ? focused.id ? `#${CSS.escape(focused.id)}` : focused.matches('input[name],textarea[name],select[name]') && focused.closest('form')?.id ? `#${CSS.escape(focused.closest('form')!.id)} [name="${CSS.escape(focused.getAttribute('name')!)}"]` : null : null;
  const selection = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? {start:focused.selectionStart,end:focused.selectionEnd} : null;
  for (const detail of root.querySelectorAll<HTMLDetailsElement>('details[data-details-key]')) expandedDetails.set(detail.dataset.detailsKey!, detail.open);
  captureDrafts();
  if (page === 'home' && catalog) {
    document.title = 'Research Locus · 项目与会话';
    root.innerHTML = homeView(); restoreDrafts();
    const nextFocus = focusSelector ? root.querySelector<HTMLElement>(focusSelector) : null;
    if (nextFocus && !nextFocus.matches(':disabled')) {
      nextFocus.focus({preventScroll:true});
      if (selection?.start != null && selection.end != null && (nextFocus instanceof HTMLInputElement || nextFocus instanceof HTMLTextAreaElement)) nextFocus.setSelectionRange(selection.start,selection.end);
    }
    return;
  }
  if (!state) {
    root.innerHTML = `<div class="boot-screen"><span class="boot-logo">RL<span>.</span></span><h1>Research Locus</h1><p>${notice?.kind === 'error' ? '工作区暂时无法连接' : '正在连接科研共审工作区…'}</p>${notice?.kind === 'error' ? `<div class="notice error" role="alert">${esc(notice.text)}</div><button class="button button-primary" data-action="reconnect">重新连接</button>` : '<span class="loading-line"></span>'}</div>`;
    return;
  }
  document.title = `Research Locus · ${section === 'replay' ? '回放剧场' : '科研共审台'}`;
  root.innerHTML = `<div class="app-shell">${sidebar()}${mobileNavOpen ? '<button class="nav-backdrop" data-action="menu" aria-label="收起导航"></button>' : ''}<div class="main-shell">${header()}<div data-feedback-summary>${feedbackSummaryView()}</div><main class="main-content">${topContent()}${notice ? `<div class="notice ${notice.kind}" role="${notice.kind === 'error' ? 'alert' : 'status'}">${icon(notice.kind === 'success' ? 'check' : 'shield')}<span>${esc(notice.text)}</span><button class="icon-button" data-action="dismiss-notice" aria-label="关闭消息">${icon('close')}</button></div>` : ''}${busy ? `<div class="busy-message" role="status"><span class="spinner"></span>${esc(busyLabel)}</div>` : ''}${section !== 'replay' && state.reviewStatus === 'paused' ? '<div class="paused-banner">已暂停检查和接收新意见；已发出的远端任务不会自动取消。<button data-action="toggle-pause">恢复共审 →</button></div>' : ''}${section !== 'replay' ? stagedFilePanel() : ''}${section !== 'replay' && creatingClaim ? newClaimForm() : ''}${section === 'replay' ? replayView() : section === 'review' ? `<div class="review-workspace">${claimDetail()}${decisionPanel()}</div>` : section === 'resources' ? resourcesView() : section === 'history' ? historyView() : projectView()}<footer class="page-footer"><span>${state.fixture ? '合成材料用于流程演示。' : ''}规则检查不构成科学确认。</span><span>研究者身份未认证</span></footer></main></div></div>`;
  restoreDrafts();
  for (const detail of root.querySelectorAll<HTMLDetailsElement>('details[data-details-key]')) detail.open = expandedDetails.get(detail.dataset.detailsKey!) ?? detail.open;
  const nextFocus = focusSelector ? root.querySelector<HTMLElement>(focusSelector) : null;
  if (nextFocus && !nextFocus.matches(':disabled')) {
    nextFocus.focus({preventScroll:true});
    if (selection?.start != null && selection.end != null && (nextFocus instanceof HTMLInputElement || nextFocus instanceof HTMLTextAreaElement)) nextFocus.setSelectionRange(selection.start,selection.end);
  }
  const replayList = root.querySelector<HTMLElement>('.replay-timeline');
  const replaySelected = replayList?.querySelector<HTMLElement>('.replay-step.selected');
  if (replayList && replaySelected) {
    replayList.scrollTop = replayScroll.top; replayList.scrollLeft = replayScroll.left;
    const listBox = replayList.getBoundingClientRect(), selectedBox = replaySelected.getBoundingClientRect();
    if (selectedBox.top < listBox.top) replayList.scrollTop -= listBox.top - selectedBox.top;
    else if (selectedBox.bottom > listBox.bottom) replayList.scrollTop += selectedBox.bottom - listBox.bottom;
    if (selectedBox.left < listBox.left) replayList.scrollLeft -= listBox.left - selectedBox.left;
    else if (selectedBox.right > listBox.right) replayList.scrollLeft += selectedBox.right - listBox.right;
  }
}

root.addEventListener('click', async event => {
  const target = (event.target as Element).closest<HTMLElement>('[data-action]');
  if (!target) return;
  event.preventDefault();
  const action = target.dataset.action;
  const id = target.dataset.id ?? '';
  const menu = target.closest<HTMLDetailsElement>('details.toolbar-more');
  if (menu) { menu.open = false; expandedDetails.set('toolbar-more',false); }
  if (action === 'menu') { mobileNavOpen = !mobileNavOpen; render(); return; }
  if (action === 'dismiss-notice') { notice = null; render(); return; }
  if (action === 'show-feedback') { section = 'review'; render(); root.querySelector<HTMLElement>('.review-feedback')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
  if (action === 'reconnect') { await connect(); return; }
  if (busy) return;
  if (action?.startsWith('replay-')) {
    if (section !== 'replay') return;
    const { steps, index } = currentReplay();
    if (action === 'replay-play') toggleReplay();
    else seekReplay(action === 'replay-first' ? 0 : action === 'replay-last' ? steps.length - 1 : action === 'replay-prev' ? index - 1 : action === 'replay-next' ? index + 1 : steps.findIndex(step => step.id === id));
    return;
  }
  if (action === 'home') { await openHome(); return; }
  if (action === 'home-refresh') { await openHome(false); return; }
  if (action === 'home-search') { root.querySelector<HTMLInputElement>('#home-search')?.focus(); return; }
  if (action === 'home-clear-search') { homeQuery = ''; render(); return; }
  if (action === 'open-project') { homeProjectId = id; homeQuery = ''; homeForm = null; setRoute(`project/${encodeURIComponent(id)}`); render(); return; }
  if (action === 'all-projects') { homeProjectId = ''; homeForm = null; setRoute(''); render(); return; }
  if (action === 'new-project' || action === 'new-session') { homeForm = action === 'new-project' ? 'project' : 'session'; render(); root.querySelector<HTMLInputElement>('#home-title')?.focus(); return; }
  if (action === 'cancel-home-form') { homeForm = null; render(); return; }
  if (action === 'open-session') { await openSavedSession(id); return; }
  if (action === 'section') { section = id as Section; mobileNavOpen = false; render(); }
  if (action === 'focus-search') { mobileNavOpen = true; render(); document.querySelector<HTMLInputElement>('#claim-search')?.focus(); return; }
  if (action === 'open-evidence-intake') { reviewTab = 'evidence'; render(); root.querySelector<HTMLElement>('.evidence-intake')?.scrollIntoView({ block:'start', behavior:'smooth' }); return; }
  if (action === 'review-tab') { reviewTab = id === 'evidence' ? 'evidence' : 'review'; render(); return; }
  if (action === 'claim') { selectedClaimId = id; selectedFindingId = ''; selectedResourceId = ''; section = 'review'; reviewTab = 'review'; mobileNavOpen = false; reconcileSelection(); render(); }
  if (action === 'finding') { selectedFindingId = id; render(); }
  if (action === 'preview') { selectedResourceId = id; reviewTab = 'evidence'; render(); }
  if (action === 'edit-resource') { editingResourceId = selectedResourceId; render(); }
  if (action === 'cancel-edit') { editingResourceId = ''; render(); }
  if (action === 'dismiss-staged') { stagedFile = null; render(); }
  if (action === 'attach-staged' && stagedFile && state) {
    const file = stagedFile;
    const edited = root.querySelector<HTMLTextAreaElement>('#staged-file-form textarea')?.value;
    if (edited !== undefined && edited !== file.content) { setNotice('error', '文件中有尚未保存的编辑。请先保存宿主文件，再将保存后的内容纳入证据。'); render(); return; }
    const revision = state.revision;
    const claimId = selectedClaimId;
    const existingIds = new Set(state.resources.map(r => r.id));
    await perform('正在将宿主文件纳入证据…', async () => {
      receiveState(await bridge.act({ type: 'attach_evidence', claimId, ...file, sourceKind: file.sourceUri ? 'host_resource' : 'user_upload' }, revision));
      const added = state!.resources.find(r => !existingIds.has(r.id));
      if (added) { selectedResourceId = added.id; checkedResources().add(added.id); }
      stagedFile = null; section = 'review'; reviewTab = 'evidence';
      setNotice('success', '宿主文件已纳入当前论断。需要时请主动同步上下文并重新运行检查。');
    });
  }
  if (action === 'close-preview') { selectedResourceId = ''; render(); }
  if (action === 'create-claim') { creatingClaim = true; section = 'review'; mobileNavOpen = false; render(); document.querySelector<HTMLTextAreaElement>('#new-claim-text')?.focus(); }
  if (action === 'cancel-create') { creatingClaim = false; render(); }
  if (action === 'clear-search') { query = ''; render(); }
  if (action === 'run') {
    const saved = await act({ type: 'run_review' }, '规则检查已完成。');
    if (saved && state) {
      const report = currentMetadataReview(state);
      if (report) {
        const counts = summarizeChecks(report.checks);
        setNotice('success', counts.claims ? `已检查 ${counts.claims} 个论断：${counts.flagged} 项风险，${counts.needsInput} 项信息不足，${counts.noSignal} 项未触发，${counts.notApplicable} 项不适用。结果仅基于声明；不等于科学通过。` : '当前没有论断可检查。请先添加论断及已知审查信息。');
        render();
      }
    }
  }
  if (action === 'edit-metadata') {
    reviewTab = 'review'; render();
    const details = root.querySelector<HTMLDetailsElement>('.revise-box');
    if (details) { details.open = true; expandedDetails.set(`revise:${selectedClaimId}`, true); }
    root.querySelector<HTMLElement>('#revise-meta-analysisUnit')?.focus();
  }
  if (action === 'extract-design' && state) {
    if (!checkedResources().size) { setNotice('error','请先在「证据文件」中勾选用于提取设计的材料。'); render(); return; }
    await perform('正在登记设计提取并发送到 ChatGPT…',async () => { setNotice('success',await bridge.requestReview(state!,selectedClaimId,[...checkedResources()],'design','从选定证据提取研究设计候选，待研究者确认。')); });
  }
  if (action === 'toggle-pause') await act({ type: state?.reviewStatus === 'paused' ? 'resume' : 'pause' }, state?.reviewStatus === 'paused' ? '已恢复共审。' : '已暂停共审。');
  if (action === 'refresh') await perform('正在刷新…', async () => { receiveState(await bridge.getState()); setNotice('success', '已载入最新工作区快照。'); });
  if (action === 'sync' && state) await perform('正在同步所选上下文…', async () => { setNotice('success', await bridge.syncContext(state!, selectedClaimId, [...checkedResources()])); });
  if (action === 'request-review' && state) {
    const options = new FormData(root.querySelector<HTMLFormElement>('#review-options')!);
    const mode = String(options.get('mode') ?? 'evidence') as ReviewMode;
    const focus = String(options.get('focus') ?? '').trim();
    await perform('正在登记请求并发送到 ChatGPT…', async () => { setNotice('success', await bridge.requestReview(state!, selectedClaimId, [...checkedResources()], mode, focus)); });
  }
  if (action === 'refresh-feedback') await perform('正在刷新进展…', async () => { await bridge.refresh(); });
  if (action === 'cancel-review') {
    const run = selectedRun();
    if (run) await perform('正在结束等待…', async () => { await bridge.cancelReview(run.id); setNotice('success', '已结束本次等待。这不会取消 ChatGPT 中已发送的消息。'); });
  }
  if (action === 'attach' && state) {
    const claimId = selectedClaimId;
    await perform('正在选择并读取文件…', async () => {
      const file = await bridge.openFile();
      if (!file) { setNotice('success', '已取消选择文件。'); return; }
      const revision = state!.revision;
      const existingIds = new Set(state!.resources.map(r => r.id));
      receiveState(await bridge.act({ type: 'attach_evidence', claimId, ...file, sourceKind: file.sourceUri ? 'host_resource' : 'user_upload' }, revision));
      const added = state!.resources.find(r => !existingIds.has(r.id));
      if (added) { selectedResourceId = added.id; checkedResources().add(added.id); }
      section = 'review'; reviewTab = 'evidence';
      setNotice('success', `已添加 ${file.name}。旧发现已过期，请重新运行检查。`);
    });
  }
  if (action === 'export' && state) {
    await perform('正在导出快照…', async () => { setNotice('success', await bridge.exportSnapshot(state!)); });
  }
});

root.addEventListener('input', event => {
  const target = event.target as HTMLInputElement;
  if (target.id === 'replay-progress') {
    stopReplay();
    target.setAttribute('aria-valuetext', `第 ${Number(target.value) + 1} 步，共 ${replaySteps.length} 步`);
    const play = root.querySelector<HTMLButtonElement>('#replay-play');
    if (play) { play.innerHTML = `${icon('play')}播放`; play.setAttribute('aria-label', '播放回放'); }
    return;
  }
  if (target.id === 'home-search') { homeQuery = target.value; if (!composing) render(); return; }
  if (target.id !== 'claim-search') return;
  query = target.value;
  if (composing) return;
  render();
});
root.addEventListener('compositionstart', () => { composing = true; });
root.addEventListener('compositionend', event => { composing = false; if ((event.target as HTMLInputElement).id === 'claim-search') query = (event.target as HTMLInputElement).value; if ((event.target as HTMLInputElement).id === 'home-search') homeQuery = (event.target as HTMLInputElement).value; render(); });
window.addEventListener('keydown', event => {
  const keyTarget = event.target as HTMLElement | null;
  const graphNode = keyTarget?.closest<SVGElement>('.graph-node[data-action="claim"]');
  if (graphNode && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault(); graphNode.dispatchEvent(new MouseEvent('click',{ bubbles:true })); return;
  }
  if (page === 'workbench' && section === 'replay' && !busy && !event.isComposing && !composing && !event.ctrlKey && !event.metaKey && !event.altKey && !keyTarget?.closest('input,textarea,select,[contenteditable="true"],summary')) {
    const { steps, index } = currentReplay();
    if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
      event.preventDefault(); seekReplay(event.key === 'Home' ? 0 : event.key === 'End' ? steps.length - 1 : index + (event.key === 'ArrowLeft' ? -1 : 1)); return;
    }
    if (event.key === ' ' && !event.repeat && !keyTarget?.closest('button,a')) { event.preventDefault(); toggleReplay(); return; }
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if(page === 'home') { root.querySelector<HTMLInputElement>('#home-search')?.focus(); } else { mobileNavOpen = true; render(); document.querySelector<HTMLInputElement>('#claim-search')?.focus(); } }
  if (event.key === 'Escape') { mobileNavOpen = false; expandedDetails.set('toolbar-more',false); const menu = root.querySelector<HTMLDetailsElement>('.toolbar-more'); if(menu) menu.open = false; render(); }
  if ((event.target as HTMLElement)?.getAttribute('role') === 'tab' && ['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) { event.preventDefault(); reviewTab = event.key === 'Home' ? 'review' : event.key === 'End' ? 'evidence' : reviewTab === 'review' ? 'evidence' : 'review'; render(); root.querySelector<HTMLElement>(`#${reviewTab}-tab`)?.focus(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden && replayTimer !== null) { stopReplay(); render(); } });
window.addEventListener('pagehide', stopReplay);
root.addEventListener('change', event => {
  const target = event.target as HTMLInputElement;
  if (target.type === 'file') {
    const label = target.closest('form')?.querySelector<HTMLElement>(`[data-files-label="${CSS.escape(target.name)}"]`);
    const files = [...(target.files ?? [])];
    if (label) label.textContent = files.length ? `${files.length} 个文件 · ${files.map(file => file.name).join('、')}` : '尚未选择';
  }
  if (target.name === 'meta_biologicalReplicates_status') {
    const numberInput = target.closest('form')?.querySelector<HTMLInputElement>('[name="meta_biologicalReplicates"]');
    if (numberInput) { numberInput.disabled = target.value !== 'known'; numberInput.required = !numberInput.disabled; if (numberInput.disabled) numberInput.value = ''; }
  }
  if (target.name === 'meta_figureApplicable') {
    const matched = target.closest('form')?.querySelector<HTMLSelectElement>('[name="meta_figureSourceMatched"]');
    if (matched) { matched.disabled = target.value === 'false'; if (matched.disabled) matched.value = NOT_DECLARED; }
  }
  if (target.id === 'replay-progress') { seekReplay(Number(target.value)); return; }
  if (target.dataset.resource) {
    if (target.checked) checkedResources().add(target.dataset.resource); else checkedResources().delete(target.dataset.resource);
    const count = document.querySelector('#selected-resource-count'); if (count) count.textContent = String(checkedResources().size);
  }
  if (target.name === 'decision') {
    const field = document.querySelector<HTMLElement>('#conditions-field');
    const input = document.querySelector<HTMLTextAreaElement>('#decision-conditions');
    if (field) field.hidden = target.value !== 'accept_with_limits';
    if (input) input.required = target.value === 'accept_with_limits';
  }
});
root.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const form = event.target as HTMLFormElement;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  if (form.classList.contains('design-proposal') && state) {
    const selectedFields = designKeys.filter(key => data.has(`select_${key}`));
    const saved = await act({ type:'confirm_design',proposalId:form.dataset.proposalId,selectedFields,rationale:String(data.get('rationale')) },selectedFields.length ? '选中候选已写入研究设计卡。请重新运行检查；旧意见与其他候选可能已过期。' : '已驳回本组候选；研究设计卡保持原值。');
    if (saved) { formDrafts.delete(formDraftKey(form)); render(); }
    return;
  }
  if (form.id === 'review-options') return;
  if (form.id === 'new-project-form') {
    const title = String(data.get('title') ?? '').trim();
    if (!title) { setNotice('error','请填写项目名称。'); render(); return; }
    await perform('正在创建项目…', async () => {
      const known = new Set(catalog?.projects.map(project => project.id));
      catalog = await bridge.createProject(title);
      homeProjectId = catalog.projects.find(project => !known.has(project.id))?.id ?? '';
      homeForm = null; homeQuery = '';
      formDrafts.delete(formDraftKey(form)); root.querySelector('#new-project-form')?.removeAttribute('data-draft-key');
      setRoute(`project/${encodeURIComponent(homeProjectId)}`);
      setNotice('success','项目已创建。新建一个会话开始共审。');
    });
    return;
  }
  if (form.id === 'new-session-form') {
    const title = String(data.get('title') ?? '').trim();
    if (!title || !homeProjectId) { setNotice('error','请选择项目并填写会话名称。'); render(); return; }
    let createdId = '';
    await perform('正在创建会话…', async () => {
      const created = await bridge.createSession(homeProjectId,title);
      catalog = created.catalog; createdId = created.sessionId; homeForm = null;
      formDrafts.delete(formDraftKey(form)); root.querySelector('#new-session-form')?.removeAttribute('data-draft-key');
    });
    if (createdId) await openSavedSession(createdId);
    return;
  }
  if (!state) return;
  if (form.id === 'receipt-generic-form' || form.id === 'receipt-bionexus-form') {
    const rationale = String(data.get('rationale') ?? '').trim();
    if (!rationale) { setNotice('error','请填写这份计算回执的纳入理由。'); render(); return; }
    const claimId = selectedClaimId, revision = state.revision, draftKey = formDraftKey(form);
    const groups: IntakeFileGroups = Object.fromEntries([...form.querySelectorAll<HTMLInputElement>('input[type="file"][name]')].map(input => [input.name,[...(input.files ?? [])]]));
    const oldIds = new Set(state.resources.map(resource => resource.id));
    const generic = form.id === 'receipt-generic-form';
    await perform('正在读取原始文件、计算摘要并核对回执…', async () => {
      const receipt = generic ? await buildGenericReceipt(data,groups) : await buildBioNexusReceipt(data,groups);
      receiveState(await bridge.act({ type:'import_computational_receipt',claimId,receipt,rationale },revision));
      formDrafts.delete(draftKey); intakeFileDrafts.delete(draftKey);
      root.querySelector(`#${form.id}`)?.removeAttribute('data-draft-key');
      const added = state!.resources.find(resource => !oldIds.has(resource.id));
      if (added) { selectedResourceId = added.id; checkedResources().add(added.id); }
      setNotice('success','计算回执已导入，校验层级与失败记录已保存。请核对本论断及依赖下游的重审事项；这次导入没有执行计算。');
    });
    return;
  }
  if (form.id === 'doi-verification-form') {
    let input: ReturnType<typeof buildDoiInput>;
    try { input = buildDoiInput(data); } catch (error) { setNotice('error',errorText(error)); render(); return; }
    const claimId = selectedClaimId, revision = state.revision;
    const oldIds = new Set(state.resources.map(resource => resource.id));
    await perform(input.mode === 'registry' ? '正在查询 DOI 注册记录并逐项比对；连接失败会明确保留为未知…' : '正在检查 DOI 格式；不会查询注册记录…', async () => {
      receiveState(await bridge.verifyDoi(input,claimId,revision));
      const added = state!.resources.find(resource => !oldIds.has(resource.id));
      if (added) { selectedResourceId = added.id; checkedResources().add(added.id); }
      setNotice('success',input.mode === 'syntax_only' ? 'DOI 格式检查已保存；存在性、元数据与内容支持均未核验。' : 'DOI 查询记录已保存。请按下面的核验层级查看找到、缺失、不一致或未知结果；引用内容支持仍未核验。');
    });
    return;
  }
  if (form.id === 'staged-file-form' && stagedFile) {
    const file = stagedFile;
    const content = String(data.get('content') ?? '');
    await perform('正在保存当前宿主文件…', async () => {
      const message = await bridge.saveFile(content, file.sourceUri);
      stagedFile = { ...file, content };
      setNotice('success', message);
    });
    return;
  }
  if (form.id === 'resource-edit-form') {
    const resource = state.resources.find(r => r.id === editingResourceId);
    if (!resource?.sourceUri) return;
    const content = String(data.get('content') ?? '');
    await perform('正在按版本标识保存宿主文件…', async () => {
      setNotice('success', await bridge.saveFile(content, resource.sourceUri));
      editingResourceId = '';
    });
    return;
  }
  const rationale = String(data.get('rationale') ?? '').trim();
  if (!rationale) { setNotice('error', '请填写具体理由，不能只有空白字符。'); render(); return; }
  const finishForm = (saved: boolean) => {
    if (!saved) return;
    const key = formDraftKey(form);
    formDrafts.delete(key);
    for (const current of root.querySelectorAll<HTMLFormElement>('form[data-draft-key]')) if (formDraftKey(current) === key) current.removeAttribute('data-draft-key');
    render();
  };
  if (form.id === 'add-relation-form') {
    const sourceClaimId = String(data.get('sourceClaimId')), targetClaimId = String(data.get('targetClaimId'));
    if (sourceClaimId === targetClaimId) { setNotice('error','请选择两个不同的论断。'); render(); return; }
    finishForm(await act({ type:'add_claim_relation',sourceClaimId,targetClaimId,kind:String(data.get('kind')),rationale },'关系已保存。依赖前提发生变化时，下游论断会进入局部重审。'));
    return;
  }
  if (form.classList.contains('remove-relation-form')) {
    finishForm(await act({ type:'remove_claim_relation',relationId:form.dataset.relationId,rationale },'关系已移除并保留历史记录。既有的待重审事项仍需核对。'));
    return;
  }
  if (form.id === 'claim-disposition-form') {
    const disposition = String(data.get('disposition'));
    finishForm(await act({ type:'set_claim_disposition',claimId:selectedClaimId,disposition,rationale },disposition === 'rejected' ? '论断已驳回；依赖它的下游论断已标记需要重审。' : '论断已恢复使用；证据上限仍待独立评估。'));
    return;
  }
  if (form.id === 'acknowledge-review-form') {
    finishForm(await act({ type:'acknowledge_re_review',claimId:selectedClaimId,rationale },'局部重审记录已保存；这不会自动确认科学结论。'));
    return;
  }
  if (form.classList.contains('evidence-link-form')) {
    const resourceIds = [...data.entries()].filter(([key]) => key.startsWith('link_')).map(([,value]) => String(value));
    finishForm(await act({ type:'link_evidence_requirement',claimId:selectedClaimId,requirementId:form.dataset.requirementId,resourceIds,rationale },resourceIds.length ? '材料已关联到这项证据需求；内容及充分性仍待核验。' : '已清除这项需求的材料关联；证据文件仍保留。'));
    return;
  }
  if (form.id === 'revision-proposal-form') {
    const acceptText = data.has('acceptText'), acceptScope = data.has('acceptScope');
    const evidenceNeedIds = [...data.entries()].filter(([key]) => key.startsWith('need_')).map(([,value]) => String(value));
    if (!acceptText && !acceptScope && !evidenceNeedIds.length) { setNotice('error','请至少选择一项要采纳的文字、范围或补证计划。'); render(); return; }
    finishForm(await act({ type:'apply_revision_proposal',findingId:form.dataset.findingId,acceptText,acceptScope,evidenceNeedIds,rationale },'选中的修改已记录。补证计划会进入清单；未选中部分仍保留为候选。'));
    return;
  }
  if (form.id === 'decision-form') {
    const decision = String(data.get('decision'));
    const conditions = String(data.get('conditions') ?? '').split('\n').map(x => x.trim()).filter(Boolean);
    if (decision === 'accept_with_limits' && !conditions.length) { setNotice('error', '附条件采纳需要至少一项明确条件。'); render(); return; }
    await act({ type: 'intervene', findingId: selectedFindingId, decision, rationale, ...(decision === 'accept_with_limits' ? { conditions } : {}) }, '你的决定与理由已记录。该操作不会自动确认科学结论。');
  }
  if (form.id === 'revise-form') {
    const text = String(data.get('text') ?? '').trim();
    if (!text) { setNotice('error', '论断内容不能为空。'); render(); return; }
    const claim = currentClaim();
    if (claim?.text !== data.get('baselineText') || claim.scope !== data.get('baselineScope') || metadataSignature(claim.metadata) !== data.get('baselineMetadata')) { setNotice('error', '这项论断或审查信息已被其他操作更新。你的草稿仍保留；请先复制草稿并刷新页面，核对新内容后再提交。'); render(); return; }
    const metadata = metadataFromValues(Object.fromEntries([...data].map(([key, value]) => [key, String(value)])));
    const saved = await act({ type: 'revise_claim', claimId: selectedClaimId, text, scope: String(data.get('scope')), metadata, rationale }, '论断与审查信息已保存。请重新运行检查以更新报告和发现。');
    if (saved) { formDrafts.delete(`${activeSessionId}::revise:${selectedClaimId}`); root.querySelector('#revise-form')?.removeAttribute('data-draft-key'); render(); }
  }
  if (form.id === 'new-claim-form') {
    const text = String(data.get('text') ?? '').trim();
    if (!text) { setNotice('error', '论断内容不能为空。'); render(); return; }
    const revision = state.revision;
    await perform('正在创建论断…', async () => {
      const metadata = metadataFromValues(Object.fromEntries([...data].map(([key, value]) => [key, String(value)])));
      receiveState(await bridge.act({ type: 'create_claim', text, scope: String(data.get('scope')), metadata, rationale }, revision));
      selectedClaimId = state!.claims[state!.claims.length - 1]?.id ?? selectedClaimId;
      selectedFindingId = ''; selectedResourceId = ''; query = ''; creatingClaim = false; reviewTab = 'review'; section = 'review';
      formDrafts.delete(`${activeSessionId}::new-claim`);
      root.querySelector('#new-claim-form')?.removeAttribute('data-draft-key');
      setNotice('success', '新论断已加入队列。请添加证据后运行规则检查。');
    });
  }
});

window.addEventListener('locus-selection', event => {
  const detail = (event as CustomEvent<{ claimId?: string; resourceIds?: string[] }>).detail;
  const claimId = detail?.claimId;
  if (!claimId || !state?.claims.some(c => c.id === claimId)) return;
  if (detail.resourceIds) selectedResources.set(claimId, new Set(detail.resourceIds));
  else if (selectedClaimId === claimId) return;
  selectedClaimId = claimId; selectedFindingId = ''; selectedResourceId = ''; section = 'review';
  reconcileSelection(); render();
});
window.addEventListener('locus-error', event => {
  const message = (event as CustomEvent<{ message?: string }>).detail?.message;
  setNotice('error', typeof message === 'string' ? message : '宿主状态校验失败，请刷新后重试。'); render();
});
window.addEventListener('locus-feedback', refreshFeedbackView);
const feedbackClock = setInterval(() => { if (!document.hidden) refreshFeedbackView(); }, 1000);
window.addEventListener('pagehide', () => clearInterval(feedbackClock), { once: true });
window.addEventListener('locus-file', event => {
  const file = (event as CustomEvent<PickedFile>).detail;
  if (!file || typeof file.name !== 'string' || typeof file.content !== 'string') return;
  stagedFile = file; page = 'workbench'; render();
});
window.addEventListener('locus-page', event => {
  const requested = (event as CustomEvent<{ page?: string }>).detail?.page;
  if (!bridge) return;
  if (requested !== 'home' && requested !== 'review' && requested !== 'settings') return;
  const target: {page:'home'|'review'|'settings';sessionId:string} = { page: requested, sessionId: bridge.activeSessionId() || 'legacy' };
  if (busy) pendingHostPage = target;
  else void openHostPage(target);
});
async function openHostPage(requested: {page:'home'|'review'|'settings';sessionId:string}) {
  if (requested.page === 'home') { await openHome(false); return; }
  await openSavedSession(requested.sessionId,false);
  if (activeSessionId === requested.sessionId && requested.page === 'settings') { section = 'project'; render(); }
}

async function restoreLocalRoute() {
  const match = /^#(session|project)\/([^/]+)$/.exec(window.location.hash);
  if (!match) { homeProjectId = ''; await openHome(false); return; }
  let id: string;
  try { id = decodeURIComponent(match[2]); } catch { await openHome(false); return; }
  if (match[1] === 'session') { await openSavedSession(id,false); }
  else { homeProjectId = catalog?.projects.some(project => project.id === id) ? id : ''; await openHome(false); }
}
window.addEventListener('popstate', () => { if (bridge?.mode === 'local') { if (busy) pendingLocalRoute = true; else void restoreLocalRoute(); } });

async function connect() {
  notice = null; render();
  try {
    bridge = await createBridge(receiveState);
    bridge.subscribe(receiveState);
    stagedFile = bridge.stagedFile();
    catalog = await bridge.listCatalog();
    const entry = bridge.entryPage();
    if (bridge.mode === 'local') { await restoreLocalRoute(); }
    else if (entry === 'home') { page = 'home'; }
    else {
      await openSavedSession(bridge.activeSessionId() || 'legacy',false);
      if (entry === 'settings') section = 'project';
    }
    render();
  } catch (error) { setNotice('error', errorText(error)); render(); }
}

void connect();
