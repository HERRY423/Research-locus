import { randomUUID } from 'node:crypto';
import { DomainError, type ReviewState, type ReviewStore } from './domain.js';
import { isClaimSnapshotCurrent } from './claim-graph.js';

export type ReviewMode = 'evidence' | 'methods' | 'challenge' | 'design';
export type ReviewPhase = 'queued' | 'working' | 'needs_input' | 'completed' | 'failed' | 'cancelled' | 'stale';
export interface ReviewRun {
  id: string;
  claimId: string;
  snapshotHash: string;
  startedRevision: number;
  resourceIds: string[];
  mode: ReviewMode;
  focus: string;
  phase: ReviewPhase;
  message: string;
  updatedAt: string;
  sequence: number;
  findingIds: string[];
  history: Array<{ phase: ReviewPhase; message: string; at: string }>;
}
export const isPendingReview = (run: ReviewRun) => ['queued', 'working', 'needs_input'].includes(run.phase);

/** Process-local coordination, separate from the durable scientific audit log. */
export class ReviewRuns {
  readonly processId = randomUUID();
  private runs: ReviewRun[] = [];
  private change(run: ReviewRun, phase: ReviewPhase, message: string) {
    Object.assign(run, { phase, message, updatedAt: new Date().toISOString(), sequence: run.sequence + 1 });
    run.history.push({ phase, message, at: run.updatedAt });
    run.history = run.history.slice(-12);
  }
  list(state: ReviewState): ReviewRun[] {
    for (const run of this.runs) {
      const resolved = run.mode === 'design' && state.designProposals?.find(p => p.runId === run.id && ['confirmed','rejected'].includes(p.status));
      if (resolved && (isPendingReview(run) || run.phase === 'completed')) {
        if (run.phase !== 'completed') this.change(run,'completed',resolved.status === 'confirmed' ? '研究者已确认所选设计候选；请基于更新后的研究设计卡运行检查。' : '研究者已驳回设计候选，原声明保持不变。');
        continue;
      }
      if (!isClaimSnapshotCurrent(state, run.claimId, run.snapshotHash, run.startedRevision) && run.phase !== 'stale') this.change(run, 'stale', '本论断或其上游依赖已修改，请基于新快照重新复核。');
      else if (isPendingReview(run) && (state.reviewStatus === 'paused' || state.events.some(event => event.revision > run.startedRevision && event.action.type === 'pause'))) this.change(run, 'cancelled', '共审已暂停；不再接收本次复核结果。已发送的对话不会自动取消。');
    }
    return structuredClone(this.runs);
  }
  create(state: ReviewState, input: { claimId: string; snapshotHash: string; resourceIds: string[]; mode: ReviewMode; focus: string }): ReviewRun {
    this.list(state);
    if (state.reviewStatus === 'paused') throw new DomainError('REVIEW_PAUSED', '请先恢复共审。');
    if (input.snapshotHash !== state.snapshotHash) throw new DomainError('STALE_SNAPSHOT', '材料已更新，请刷新后发起复核。');
    const claim = state.claims.find(c => c.id === input.claimId);
    if (!claim || input.resourceIds.some(id => !claim.resourceIds.includes(id))) throw new DomainError('INVALID_SCOPE', '所选证据不属于当前论断。');
    if (input.mode === 'design' && !input.resourceIds.length) throw new DomainError('EVIDENCE_REQUIRED','请先选择用于提取设计的证据。');
    if (input.mode === 'design' && input.resourceIds.length > 30) throw new DomainError('EVIDENCE_LIMIT','每次设计提取最多选择 30 份证据。');
    if (this.runs.some(run => run.claimId === input.claimId && isPendingReview(run))) throw new DomainError('REVIEW_PENDING', '此论断已有待处理请求，请先查看进展或结束等待。');
    if (this.runs.length >= 50) {
      const index = this.runs.findIndex(run => !isPendingReview(run));
      if (index < 0) throw new DomainError('REVIEW_CAPACITY', '待处理复核过多，请先结束已有请求。');
      this.runs.splice(index, 1);
    }
    const run: ReviewRun = { ...input, startedRevision: state.revision, resourceIds: [...new Set(input.resourceIds)], id: randomUUID(), phase: 'queued', message: '', updatedAt: '', sequence: 0, findingIds: [], history: [] };
    this.change(run, 'queued', '请求已登记，等待 ChatGPT 确认处理。');
    this.runs.push(run);
    return structuredClone(run);
  }
  private get(state: ReviewState, id: string): ReviewRun {
    this.list(state);
    const run = this.runs.find(item => item.id === id);
    if (!run) throw new DomainError('REVIEW_NOT_FOUND', '请求不存在或服务已重启；请核对聊天记录和已保存的发现。');
    return run;
  }
  assertWritable(state: ReviewState, id: string, claimId?: string, resourceIds: string[] = []): ReviewRun {
    const run = this.get(state, id);
    if (!isPendingReview(run)) throw new DomainError('REVIEW_CLOSED', '本次复核已结束或过期，请勿继续提交。');
    if ((claimId && claimId !== run.claimId) || resourceIds.some(r => !run.resourceIds.includes(r))) throw new DomainError('REVIEW_SCOPE_MISMATCH', '发现超出本次选定的论断或证据范围。');
    return run;
  }
  progress(state: ReviewState, id: string, sequence: number, phase: 'working' | 'needs_input' | 'completed' | 'failed', message: string): ReviewRun {
    const run = this.get(state, id);
    if (run.mode === 'design' && phase === 'completed' && !state.designProposals?.some(p => p.runId === id && ['confirmed','rejected'].includes(p.status))) throw new DomainError('DESIGN_CONFIRMATION_REQUIRED','设计提取需等待研究者确认或驳回；请报告 needs_input。');
    // An exact replay is safe, including a lost completion response.
    if (run.sequence === sequence + 1 && run.phase === phase && run.message === message) return structuredClone(run);
    this.assertWritable(state, id);
    if (run.sequence !== sequence) throw new DomainError('REVIEW_CONFLICT', '进展已更新，请重读 locus.review_status 后再提交。');
    this.change(run, phase, message);
    return structuredClone(run);
  }
  recordFinding(state: ReviewState, id: string, findingId: string) {
    const run = this.assertWritable(state, id);
    run.findingIds.push(findingId);
    this.change(run, 'working', `已保存 ${run.findingIds.length} 项审查发现，等待本次复核小结。`);
  }
  cancel(state: ReviewState, id: string): ReviewRun {
    const run = this.get(state, id);
    if (isPendingReview(run)) this.change(run, 'cancelled', '已结束等待，不再接收本次请求的结果；这不会取消 ChatGPT 对话。');
    return structuredClone(run);
  }
}

// Shared by short-lived HTTP MCP servers using the same dossier store.
const runsByStore = new WeakMap<ReviewStore, ReviewRuns>();
export function reviewRuns(store: ReviewStore): ReviewRuns {
  let runs = runsByStore.get(store);
  if (!runs) { runs = new ReviewRuns(); runsByStore.set(store, runs); }
  return runs;
}
