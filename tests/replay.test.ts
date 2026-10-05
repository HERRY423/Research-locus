import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewStore } from '../src/domain.js';
import { buildReplaySteps, diffLines } from '../src/replay.js';

const researcher = { kind: 'researcher' as const, id: 'local-ui-unverified' };
const agent = { kind: 'agent' as const, id: 'agent:reviewer' };

test('replay reconstructs actual creation, revision, and attachment without mutating state', () => {
  const store = new ReviewStore({ initial: { projectId: 'project', title: 'Review' } });
  let state = store.act({ type: 'create_claim', text: 'First line\nSecond line', scope: 'sample', rationale: 'Initial statement' }, 0, researcher);
  const claimId = state.claims[0]!.id;
  state = store.act({ type: 'revise_claim', claimId, text: 'First line\nCorrected line', scope: 'cohort', rationale: 'Correction' }, state.revision, researcher);
  state = store.act({ type: 'attach_evidence', claimId, name: 'source.txt', mediaType: 'text/plain', content: 'Source line one\nSource line two' }, state.revision, researcher);
  const original = structuredClone(state);
  const steps = buildReplaySteps(state);
  assert.equal(steps.length, 4);
  assert.equal(steps[1]!.target, claimId);
  assert.deepEqual(steps[1]!.changes[0], { label: '论断内容', before: '', after: 'First line\nSecond line' });
  assert.deepEqual(steps[2]!.changes, [{ label: '论断内容', before: 'First line\nSecond line', after: 'First line\nCorrected line' }, { label: '论断范围', before: 'sample', after: 'cohort' }]);
  assert.equal(steps[3]!.changes[0]!.after, state.resources[0]!.content);
  assert.ok(steps.every(step => step.availability === 'complete'));
  assert.notEqual(state.events[1]!.stateHash, state.snapshots[1]!.hash);
  assert.deepEqual(state, original);
});

test('replay supports returning A to B to A and a real no-op without inventing snapshots', () => {
  const store = new ReviewStore();
  let state = store.getState();
  const claim = state.claims[0]!;
  state = store.act({ type: 'revise_claim', claimId: claim.id, text: 'B', rationale: 'Revise' }, state.revision, researcher);
  state = store.act({ type: 'revise_claim', claimId: claim.id, text: claim.text, rationale: 'Restore actual old text' }, state.revision, researcher);
  state = store.act({ type: 'revise_claim', claimId: claim.id, text: claim.text, rationale: 'No text change' }, state.revision, researcher);
  assert.equal(state.snapshots.length, 2);
  const steps = buildReplaySteps(state);
  assert.equal(steps[1]!.changes[0]!.before, claim.text);
  assert.equal(steps[1]!.changes[0]!.after, 'B');
  assert.equal(steps[2]!.changes[0]!.before, 'B');
  assert.equal(steps[2]!.changes[0]!.after, claim.text);
  assert.deepEqual(steps[3]!.changes, []);
  assert.ok(steps.every(step => step.availability === 'complete'));
});

test('identical creations and attachments use distinct actual IDs, not guessed names', () => {
  const store = new ReviewStore({ initial: { projectId: 'project', title: 'Review' } });
  let state = store.getState();
  for (let i = 0; i < 2; i += 1) state = store.act({ type: 'create_claim', text: 'Identical statement', scope: 'sample', rationale: 'Separate claim' }, state.revision, researcher);
  const claimId = state.claims[0]!.id;
  for (let i = 0; i < 2; i += 1) state = store.act({ type: 'attach_evidence', claimId, name: 'same.txt', mediaType: 'text/plain', content: 'Same text' }, state.revision, researcher);
  const steps = buildReplaySteps(state);
  assert.equal(steps[1]!.target, state.claims[0]!.id);
  assert.equal(steps[2]!.target, state.claims[1]!.id);
  assert.notEqual(steps[1]!.target, steps[2]!.target);
  assert.ok(steps.every(step => step.availability === 'complete'));
  assert.notEqual(state.resources[0]!.id, state.resources[1]!.id);
});

test('missing baseline or intermediate snapshot yields summaries and no invented old values', () => {
  const store = new ReviewStore();
  const initial = store.getState();
  let state = store.act({ type: 'revise_claim', claimId: initial.claims[0]!.id, text: 'Second', rationale: 'Revision' }, 0, researcher);
  state = store.act({ type: 'revise_claim', claimId: initial.claims[0]!.id, text: 'Third', rationale: 'Revision again' }, 1, researcher);
  // Legacy events have no explicit snapshot pointers; retain the conservative
  // reconstruction behavior when their intermediate inputs are unavailable.
  for (const event of state.events) { delete event.beforeSnapshotHash; delete event.afterSnapshotHash; }
  const withoutBaseline = structuredClone(state);
  withoutBaseline.snapshots.shift();
  assert.ok(buildReplaySteps(withoutBaseline).every(step => step.availability === 'summary_only' && step.changes.length === 0));
  const withoutIntermediate = structuredClone(state);
  withoutIntermediate.snapshots.splice(1, 1);
  const steps = buildReplaySteps(withoutIntermediate);
  assert.equal(steps[0]!.availability, 'complete');
  assert.deepEqual(steps.slice(1).map(step => step.availability), ['summary_only', 'summary_only']);
  assert.ok(steps.slice(1).every(step => step.changes.length === 0));
});

test('ambiguous successor snapshots and event gaps are never resolved by arbitrary selection', () => {
  const store = new ReviewStore({ initial: { projectId: 'project', title: 'Review' } });
  const state = store.act({ type: 'create_claim', text: 'Claim', scope: 'sample', rationale: 'New' }, 0, researcher);
  for (const event of state.events) { delete event.beforeSnapshotHash; delete event.afterSnapshotHash; }
  const ambiguous = structuredClone(state);
  const extra = structuredClone(ambiguous.snapshots[1]!);
  extra.hash = 'a'.repeat(64);
  extra.claims[0]!.id = 'alternative-id';
  ambiguous.snapshots.push(extra);
  assert.equal(buildReplaySteps(ambiguous)[1]!.availability, 'summary_only');
  assert.equal(buildReplaySteps(ambiguous)[1]!.target, '');
  const gap = structuredClone(state);
  gap.events[1]!.revision = 2;
  assert.equal(buildReplaySteps(gap)[1]!.availability, 'summary_only');
});

test('new bound events replay relationship, partial revision, evidence mapping and local review without guessing IDs', () => {
  const store = new ReviewStore({initial:{projectId:'closed-loop',title:'Synthetic loop'}});
  let state=store.getState();
  const act=(action:unknown, actor:typeof researcher|typeof agent=researcher)=>state=store.act(action,state.revision,actor);
  act({type:'create_claim',text:'Synthetic premise',scope:'population',rationale:'Fixture'});
  act({type:'create_claim',text:'Synthetic downstream',scope:'sample',rationale:'Fixture'});
  const [up,down]=state.claims.map(claim=>claim.id);
  act({type:'attach_evidence',claimId:up,name:'synthetic.txt',mediaType:'text/plain',content:'Synthetic source'});
  act({type:'add_claim_relation',sourceClaimId:up,targetClaimId:down,kind:'depends_on',rationale:'Fixture dependency'});
  act({type:'add_finding',claimId:up,title:'Candidate revision',rationale:'Synthetic candidate',severity:'warning',category:'claim_scope',snapshotHash:state.snapshotHash,resourceIds:[],revisionProposal:{text:'Scoped synthetic premise',scope:'sample',evidenceNeeds:[{id:'n',category:'replication',description:'Independent replication'}]}}, agent);
  const findingId=state.findings.at(-1)!.id;
  act({type:'apply_revision_proposal',findingId,acceptText:true,acceptScope:false,evidenceNeedIds:['n'],rationale:'Select text and plan'});
  act({type:'link_evidence_requirement',claimId:up,requirementId:`proposal:${findingId}:n`,resourceIds:state.claims[0].resourceIds,rationale:'Link test material only'});
  act({type:'apply_revision_proposal',findingId,acceptText:false,acceptScope:true,evidenceNeedIds:[],rationale:'Select remaining scope'});
  act({type:'set_claim_disposition',claimId:up,disposition:'rejected',rationale:'Reject premise'});
  act({type:'acknowledge_re_review',claimId:down,rationale:'Rechecked dependence'});
  act({type:'remove_claim_relation',relationId:state.claimRelations![0].id,rationale:'Remove obsolete dependency'});
  const steps=buildReplaySteps(state);
  assert.ok(steps.every(step=>step.availability==='complete'),JSON.stringify(steps.filter(step=>step.availability!=='complete')));
  assert.match(steps.find(step=>step.title==='提交审阅建议')!.changes.at(-1)!.after!,/Scoped synthetic premise/);
  const adoptions=steps.filter(step=>step.title==='逐项采纳修订提案');
  assert.deepEqual(adoptions[0].changes.map(change=>change.label),['论断内容','补证计划 · replication']);
  assert.deepEqual(adoptions[1].changes,[{label:'论断范围',before:'population',after:'sample'}]);
  assert.equal(steps.find(step=>step.title==='移除论断关系')!.changes[0].before,'依赖');
  const missing=structuredClone(state); missing.snapshots.splice(1,1);
  const recovered=buildReplaySteps(missing);
  assert.equal(recovered[1].availability,'summary_only');
  assert.equal(recovered.at(-1)!.availability,'complete','Later explicit event anchors may recover exact available inputs');
});

test('pause, resume, review, suggestions and interventions remain faithful action summaries', () => {
  const store = new ReviewStore();
  let state = store.getState();
  const findingId = state.findings[0]!.id;
  state = store.act({ type: 'intervene', findingId, decision: 'challenge', rationale: 'Question the design' }, state.revision, researcher);
  state = store.act({ type: 'pause' }, state.revision, researcher);
  state = store.act({ type: 'resume' }, state.revision, researcher);
  state = store.act({ type: 'run_review' }, state.revision, agent);
  state = store.act({ type: 'add_finding', claimId: state.claims[0]!.id, title: 'Proposed concern', rationale: 'Declared reasoning', severity: 'warning', category: 'design', resourceIds: [], snapshotHash: state.snapshotHash }, state.revision, agent);
  const steps = buildReplaySteps(state);
  assert.match(steps[1]!.changes[0]!.after!, /Question the design/);
  assert.deepEqual(steps[2]!.changes[0], { label: '审查状态', before: 'active', after: 'paused' });
  assert.deepEqual(steps[3]!.changes[0], { label: '审查状态', before: 'paused', after: 'active' });
  assert.equal(steps[4]!.availability, 'complete');
  assert.equal(steps[4]!.changes[0]!.label, '本轮规则检查报告');
  assert.equal(steps[5]!.availability, 'complete');
  assert.equal(steps[5]!.changes[0]!.after, 'Proposed concern');
  assert.equal(steps[5]!.actor.kind, 'agent');
  const later = store.act({ type: 'intervene', findingId, decision: 'defer', rationale: 'Wait for evidence' }, state.revision, researcher);
  const gapped = structuredClone(later);
  gapped.events = gapped.events.filter(event => event.revision !== 1);
  const finalStep = buildReplaySteps(gapped).at(-1)!;
  assert.equal(finalStep.availability, 'summary_only');
  assert.equal(finalStep.changes[0]!.before, null);
  assert.match(finalStep.changes[0]!.after!, /Wait for evidence/);
});

test('multiline diffs preserve exact lines and both line number sequences', () => {
  const before = 'same\nold\nlast\n';
  const after = 'same\nnew\nextra\nlast\n';
  const result = diffLines(before, after);
  assert.equal(result.truncated, false);
  assert.equal(result.lines.filter(line => line.kind !== 'add').map(line => line.text).join('\n'), before);
  assert.equal(result.lines.filter(line => line.kind !== 'remove').map(line => line.text).join('\n'), after);
  assert.deepEqual(result.lines.filter(line => line.beforeLine !== null).map(line => line.beforeLine), [1, 2, 3, 4]);
  assert.deepEqual(result.lines.filter(line => line.afterLine !== null).map(line => line.afterLine), [1, 2, 3, 4, 5]);
  assert.deepEqual(diffLines('', 'first\nsecond').lines.map(line => line.kind), ['add', 'add']);
  assert.deepEqual(diffLines('first', '').lines.map(line => line.kind), ['remove']);
  const newline = diffLines('first\r\nsecond', 'first\nsecond');
  assert.equal(newline.lines[0]!.text, 'first\r');
  assert.equal(newline.lines[0]!.kind, 'remove');
});

test('huge diffs cap input work and rendered output, reporting truncation', () => {
  const huge = 'a\n'.repeat(500_000);
  const result = diffLines(huge, 'b\n'.repeat(500_000), { maxLines: 50, maxCharacters: 500 });
  assert.equal(result.truncated, true);
  assert.ok(result.lines.length <= 50);
  assert.ok(result.lines.every(line => line.text.length <= 500));
  const largeLine = diffLines('x'.repeat(1_000_000), 'y'.repeat(1_000_000));
  assert.equal(largeLine.truncated, true);
  assert.ok(largeLine.lines.every(line => line.text.length <= 50_000));
  assert.ok(diffLines(huge, huge, { maxLines: Number.MAX_SAFE_INTEGER, maxCharacters: Number.MAX_SAFE_INTEGER }).lines.length <= 1000);
});
