import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReviewStore } from '../src/domain.js';
import { reviewRuns } from '../src/review-runs.js';

function fixture() {
  const store = new ReviewStore(), state = store.getState(), runs = reviewRuns(store);
  const input = { claimId: state.claims[0].id, resourceIds: state.claims[0].resourceIds, snapshotHash: state.snapshotHash, mode: 'evidence' as const, focus: 'Check selected evidence' };
  return { store, state, runs, input };
}
test('requests are scoped, suppress duplicates, and progress does not modify the scientific dossier', () => {
  const { store, state, runs, input } = fixture();
  const run = runs.create(state, input);
  assert.equal(run.phase, 'queued');
  assert.throws(() => runs.create(state, input), /已有待处理/);
  assert.throws(() => runs.assertWritable(state, run.id, input.claimId, ['unselected']), /范围/);
  const working = runs.progress(state, run.id, run.sequence, 'working', 'Read selected source');
  assert.throws(() => runs.progress(state, run.id, run.sequence, 'completed', 'Old response'), /进展已更新/);
  const done = runs.progress(state, run.id, working.sequence, 'completed', 'Source text checked; statistics not recalculated');
  assert.deepEqual(runs.progress(state, run.id, working.sequence, 'completed', done.message), done);
  assert.throws(() => runs.assertWritable(state, run.id), /已结束/);
  assert.deepEqual(store.getState(), state);
});
test('revising evidence invalidates a run and pause remains effective after resume', () => {
  const { store, state, runs, input } = fixture();
  const run = runs.create(state, input);
  let next = store.act({ type: 'pause' }, state.revision, { kind: 'researcher', id: 'fixture-user' });
  next = store.act({ type: 'resume' }, next.revision, { kind: 'researcher', id: 'fixture-user' });
  assert.equal(runs.list(next)[0].phase, 'cancelled');
  assert.throws(() => runs.assertWritable(next, run.id), /已结束/);
  const second = runs.create(next, input);
  next = store.act({ type: 'revise_claim', claimId: input.claimId, text: 'Narrowed synthetic claim', rationale: 'Fixture revision' }, next.revision, { kind: 'researcher', id: 'fixture-user' });
  assert.equal(runs.list(next).find(r => r.id === second.id)?.phase, 'stale');
  assert.throws(() => runs.progress(next, second.id, second.sequence, 'completed', 'Cannot complete'), /已结束/);
});
test('stores isolate requests and end waiting rejects late results', () => {
  const { state, runs, input } = fixture();
  const run = runs.create(state, input);
  const other = fixture();
  assert.deepEqual(other.runs.list(other.state), []);
  assert.throws(() => other.runs.assertWritable(other.state, run.id), /请求不存在/);
  runs.cancel(state, run.id);
  assert.throws(() => runs.assertWritable(state, run.id), /已结束/);
  assert.notEqual(runs.create(state, input).id, run.id);
});
