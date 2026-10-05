import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { DomainError, ReviewStore, verifyState, type Actor, type ReviewState } from '../src/domain.js';
import { proposalAvailability } from '../src/revision-proposals.js';
import { evidencePlan } from '../src/evidence-plan.js';
import { currentMetadataReview } from '../src/metadata-review.js';
import { ReviewRuns } from '../src/review-runs.js';

const researcher: Actor = { kind: 'researcher', id: 'researcher:closure-test' };
const agent: Actor = { kind: 'agent', id: 'agent:closure-test' };
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
const act = (store: ReviewStore, action: unknown, actor = researcher) => store.act(action, store.getState().revision, actor);
function workspace(count = 4) {
  const store = new ReviewStore({ initial: { projectId: 'synthetic-closure-test', title: 'Synthetic co-improvement test' } });
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const state = act(store, { type: 'create_claim', text: `Synthetic claim ${index}`, scope: 'population', rationale: 'Synthetic review scenario' });
    ids.push(state.claims.at(-1)!.id);
  }
  return { store, ids };
}
function link(store: ReviewStore, sourceClaimId: string, targetClaimId: string, kind = 'depends_on') {
  return act(store, { type: 'add_claim_relation', sourceClaimId, targetClaimId, kind, rationale: 'Researcher declares this logical relationship.' });
}
function finding(store: ReviewStore, claimId: string, revisionProposal?: unknown) {
  const state = store.getState();
  return act(store, {
    type: 'add_finding', claimId, title: 'Synthetic reviewer finding', rationale: 'Evidence does not yet justify this scope.',
    severity: 'warning', category: 'claim_scope', snapshotHash: state.snapshotHash, resourceIds: [],
    ...(revisionProposal ? { revisionProposal } : {}),
  }, agent);
}
function pending(state: ReviewState) {
  return [...new Set((state.reReview ?? []).filter(item => item.status === 'pending').map(item => item.claimId))].sort();
}
function acknowledgeAll(store: ReviewStore) {
  for (const claimId of pending(store.getState())) act(store, { type: 'acknowledge_re_review', claimId, rationale: 'Checked the declared dependency context.' });
}
const revisionProposal = {
  text: 'The measured samples show an exploratory association.', scope: 'sample',
  evidenceNeeds: [
    { id: 'independent-replicates', category: 'replication', description: 'Collect independent biological replicates.' },
    { id: 'analysis-report', category: 'analysis', description: 'Provide donor-level estimates and uncertainty.' },
  ],
};

test('dependency propagation follows a directed diamond once and excludes support, contradiction and disconnected claims', () => {
  const { store, ids: [a, b, c, d, support, contradiction, unrelated] } = workspace(7);
  link(store, a, b); link(store, a, c); link(store, b, d); link(store, c, d);
  link(store, a, support, 'supports'); link(store, a, contradiction, 'contradicts');
  acknowledgeAll(store);
  for (const id of [a, b, c, d, support, contradiction, unrelated]) finding(store, id);
  const before = store.getState();
  for (const item of before.findings) act(store, { type: 'intervene', findingId: item.id, decision: 'defer', rationale: 'Await the planned evidence.' });
  const state = act(store, { type: 'set_claim_disposition', claimId: a, disposition: 'rejected', rationale: 'The premise is not supported.' });
  assert.deepEqual(pending(state), [b, c, d].sort());
  assert.equal(state.reReview!.filter(item => item.status === 'pending' && item.claimId === d).length, 1, 'a diamond produces one downstream review request');
  assert.ok(state.findings.filter(item => [a, b, c, d].includes(item.claimId)).every(item => item.status === 'stale'));
  assert.ok(state.findings.filter(item => [support, contradiction, unrelated].includes(item.claimId)).every(item => item.status === 'active'));
  assert.ok(state.decisions.filter(item => [support, contradiction, unrelated].includes(item.claimId)).every(item => item.status === 'current'));
  assert.ok(state.claims.every(item => item.evidenceCeiling === 'NOT_ASSESSED'));
  assert.equal(state.scientificAuthorization, 'NONE');
  verifyState(state);
});

test('narrowing is local and acknowledging a downstream review does not promote its evidence', () => {
  const { store, ids: [a, b, c, unrelated] } = workspace();
  link(store, a, b); link(store, b, c); acknowledgeAll(store);
  finding(store, unrelated);
  const old = store.getState();
  let state = act(store, { type: 'revise_claim', claimId: a, text: old.claims[0]!.text, scope: 'sample', rationale: 'Restrict interpretation to the measured material.' });
  assert.deepEqual(pending(state), [b, c].sort());
  assert.equal(state.findings[0]!.status, 'active');
  state = act(store, { type: 'intervene', findingId: state.findings[0]!.id, decision: 'defer', rationale: 'Unrelated finding remains usable.' });
  assert.equal(state.decisions.at(-1)!.status, 'current');
  assert.throws(() => act(store, { type: 'acknowledge_re_review', claimId: b, rationale: 'Agent cannot acknowledge for a researcher.' }, agent), code('RESEARCHER_REQUIRED'));
  state = act(store, { type: 'acknowledge_re_review', claimId: b, rationale: 'Checked the narrowed premise; more evidence is still needed.' });
  assert.deepEqual(pending(state), [c]);
  assert.equal(state.claims.find(item => item.id === b)!.evidenceCeiling, 'NOT_ASSESSED');
  assert.ok(state.reReview!.some(item => item.claimId === b && item.status === 'acknowledged' && item.resolvedRevision === state.revision));
});

test('dismissing a finding does not reject its claim or invalidate dependent claims', () => {
  const { store, ids: [a, b] } = workspace(2);
  link(store, a, b); acknowledgeAll(store);
  let state = finding(store, a);
  const snapshotHash = state.snapshotHash;
  state = act(store, { type: 'intervene', findingId: state.findings[0]!.id, decision: 'dismiss', rationale: 'This particular reviewer objection is mistaken.' });
  assert.equal(state.snapshotHash, snapshotHash);
  assert.deepEqual(pending(state), []);
  assert.notEqual(state.claims[0]!.disposition, 'rejected');
  state = act(store, { type: 'set_claim_disposition', claimId: a, disposition: 'rejected', rationale: 'Separately reject the premise itself.' });
  assert.deepEqual(pending(state), [b]);
});

test('dependency graph rejects cycles, duplicates, self links and foreign references atomically', () => {
  const { store, ids: [a, b, c] } = workspace(3);
  link(store, a, b); link(store, b, c);
  for (const [sourceClaimId, targetClaimId] of [[a, a], [a, b], [c, a], ['foreign-claim', b]]) {
    const before = store.getState();
    assert.throws(() => link(store, sourceClaimId, targetClaimId));
    assert.deepEqual(store.getState(), before);
  }
  const before = store.getState();
  assert.throws(() => act(store, { type: 'add_claim_relation', sourceClaimId: a, targetClaimId: c, kind: 'depends_on', rationale: 'Agent writes a relationship.' }, agent), code('RESEARCHER_REQUIRED'));
  assert.deepEqual(store.getState(), before);
  const state = link(store, c, a, 'contradicts');
  assert.equal(state.claimRelations!.length, 3, 'a contradiction is not a dependency cycle');
  assert.throws(() => link(store, a, c, 'contradicts'), code('INVALID_RELATION'), 'reverse contradiction is still the same declared relationship');
  assert.deepEqual(store.getState(), state);
});

test('removing a dependency reopens only its target and descendants, and breaks later upstream propagation', () => {
  const { store, ids: [a, b, c, unrelated] } = workspace();
  link(store, a, b); link(store, b, c); acknowledgeAll(store);
  const relationId = store.getState().claimRelations!.find(item => item.sourceClaimId === a)!.id;
  let state = act(store, { type: 'remove_claim_relation', relationId, rationale: 'This premise is no longer required.' });
  assert.deepEqual(pending(state), [b, c].sort());
  assert.ok(!pending(state).includes(unrelated));
  acknowledgeAll(store);
  state = act(store, { type: 'set_claim_disposition', claimId: a, disposition: 'rejected', rationale: 'Reject the now-independent premise.' });
  assert.deepEqual(pending(state), []);
  assert.throws(() => act(store, { type: 'remove_claim_relation', relationId, rationale: 'Duplicate removal.' }));
});

test('revision proposals allow separate evidence, text and scope adoption while preserving unselected work', () => {
  const { store, ids: [claimId, downstream] } = workspace(2);
  link(store, claimId, downstream); acknowledgeAll(store);
  let state = finding(store, claimId, revisionProposal);
  const findingId = state.findings[0]!.id;
  const apply = (acceptText: boolean, acceptScope: boolean, evidenceNeedIds: string[]) => ({ type: 'apply_revision_proposal', findingId, acceptText, acceptScope, evidenceNeedIds, rationale: 'Researcher checks and accepts only these selected changes.' });
  state = act(store, apply(false, false, ['independent-replicates']));
  assert.equal(state.claims[0]!.text, 'Synthetic claim 0');
  assert.equal(state.claims[0]!.scope, 'population');
  assert.deepEqual(state.claims[0]!.evidenceNeeds!.map(item => item.id), ['independent-replicates']);
  assert.equal(state.claims[0]!.evidenceNeeds![0]!.findingId, findingId);
  assert.equal(proposalAvailability(state, state.findings[0]!).available, true);
  state = act(store, apply(true, false, []));
  assert.equal(state.claims[0]!.text, revisionProposal.text);
  assert.equal(state.claims[0]!.scope, 'population');
  assert.deepEqual(pending(state), [downstream]);
  state = act(store, apply(false, true, ['analysis-report']));
  assert.equal(state.claims[0]!.scope, 'sample');
  assert.equal(state.claims[0]!.evidenceNeeds!.length, 2);
  assert.equal(state.revisionAdoptions!.length, 3);
  assert.equal(proposalAvailability(state, state.findings[0]!).available, false);
  assert.equal(state.findings[0]!.revisionProposal!.text, revisionProposal.text, 'the original proposal is immutable history');
  assert.equal(state.claims[0]!.evidenceCeiling, 'NOT_ASSESSED');
  verifyState(state);
});

test('proposal acceptance cannot be forged, repeated, overselected or resumed after a relevant external edit', () => {
  const { store, ids: [claimId, unrelated] } = workspace(2);
  let state = finding(store, claimId, revisionProposal);
  const findingId = state.findings[0]!.id;
  const accept = { type: 'apply_revision_proposal', findingId, acceptText: false, acceptScope: false, evidenceNeedIds: ['independent-replicates'], rationale: 'Reviewed proposal.' };
  assert.throws(() => act(store, accept, agent), code('RESEARCHER_REQUIRED'));
  for (const invalid of [
    { ...accept, acceptText: true, evidenceNeedIds: ['invented'] },
    { ...accept, evidenceNeedIds: ['independent-replicates', 'independent-replicates'] },
    { ...accept, text: 'Injected replacement not in proposal' },
    { ...accept, acceptText: false, acceptScope: false, evidenceNeedIds: [] },
  ]) {
    const before = store.getState();
    assert.throws(() => act(store, invalid));
    assert.deepEqual(store.getState(), before);
  }
  state = act(store, accept);
  assert.throws(() => act(store, accept), code('INVALID_PROPOSAL'));
  act(store, { type: 'revise_claim', claimId: unrelated, text: 'An unrelated correction', rationale: 'Does not affect this proposal.' });
  state = act(store, { ...accept, acceptText: true, evidenceNeedIds: [] });
  assert.equal(state.claims[0]!.text, revisionProposal.text);
  act(store, { type: 'attach_evidence', claimId, name: 'new-evidence.txt', mediaType: 'text/plain', content: 'New context requires a fresh reviewer proposal.' });
  const before = store.getState();
  assert.throws(() => act(store, { ...accept, acceptScope: true, evidenceNeedIds: [] }), code('STALE_PROPOSAL'));
  assert.deepEqual(store.getState(), before);
});

test('malformed structured proposals never append a finding or mutate the audit chain', () => {
  const { store, ids: [claimId] } = workspace(1);
  for (const proposal of [
    {}, { text: '' }, { scope: 'universal' },
    { evidenceNeeds: [{ id: 'x', category: 'approval', description: 'Unsupported evidence category' }] },
    { evidenceNeeds: [revisionProposal.evidenceNeeds[0], revisionProposal.evidenceNeeds[0]] },
    { text: 'New claim', scientificAuthorization: 'APPROVED' },
  ]) {
    const before = store.getState();
    assert.throws(() => finding(store, claimId, proposal));
    assert.deepEqual(store.getState(), before);
  }
});

test('relations, local-review flags and partial adoption history survive reload and reject tampering', () => {
  const { store, ids: [a, b] } = workspace(2);
  link(store, a, b); acknowledgeAll(store);
  let state = finding(store, a, revisionProposal);
  state = act(store, { type: 'apply_revision_proposal', findingId: state.findings[0]!.id, acceptText: true, acceptScope: false, evidenceNeedIds: ['analysis-report'], rationale: 'Retain selected revision and evidence action.' });
  const directory = mkdtempSync(join(process.cwd(), '.closure-test-'));
  try {
    const filePath = join(directory, 'state.json');
    writeFileSync(filePath, JSON.stringify(state));
    assert.deepEqual(new ReviewStore({ filePath }).getState(), state);
    const mutations: Array<(copy: ReviewState) => void> = [
      copy => { copy.claimRelations![0]!.targetClaimId = a; },
      copy => { copy.reReview!.find(item => item.status === 'pending')!.sourceClaimId = 'forged-source'; },
      copy => { copy.revisionAdoptions![0]!.evidenceNeedIds = ['invented']; },
      copy => { copy.findings[0]!.revisionProposal!.text = 'Tampered proposal'; },
    ];
    for (const mutate of mutations) {
      const tampered = structuredClone(state); mutate(tampered);
      assert.throws(() => verifyState(tampered), code('INTEGRITY_ERROR'));
    }
  } finally {
    assert.ok(resolve(directory).startsWith(`${resolve(process.cwd())}${sep}.closure-test-`));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('old dossier bytes load unchanged before new graph fields are explicitly written', () => {
  const directory = mkdtempSync(join(process.cwd(), '.closure-test-'));
  try {
    const filePath = join(directory, 'state.json');
    const bytes = readFileSync(new URL('./fixtures/metadata-v2.json', import.meta.url), 'utf8');
    writeFileSync(filePath, bytes);
    const store = new ReviewStore({ filePath });
    const before = store.getState();
    assert.equal(readFileSync(filePath, 'utf8'), bytes);
    assert.equal(before.claimRelations, undefined);
    assert.equal(before.reReview, undefined);
    assert.equal(before.revisionAdoptions, undefined);
    const state = link(store, before.claims[0]!.id, before.claims[1]!.id);
    assert.equal(state.claimRelations!.length, 1);
    assert.deepEqual(state.snapshots[0], before.snapshots[0]);
    assert.deepEqual(new ReviewStore({ filePath }).getState(), state);
  } finally {
    assert.ok(resolve(directory).startsWith(`${resolve(process.cwd())}${sep}.closure-test-`));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('evidence checklist derives scoped gaps and preserves declaration, provision and assessment boundaries', () => {
  const { store, ids: [claimId, downstream, unrelated] } = workspace(3);
  link(store, claimId, downstream); acknowledgeAll(store);
  const original = store.getState();
  let plan = evidencePlan(original, claimId);
  assert.equal(plan.find(item => item.id === 'baseline:source')!.status, 'missing');
  assert.equal(plan.find(item => item.id === 'baseline:design')!.status, 'missing');
  assert.ok(plan.some(item => item.id === 'baseline:replication'));
  assert.ok(!plan.some(item => item.id === 'baseline:causal'));
  assert.ok(plan.some(item => item.origin === 'rule' && item.status === 'missing'));
  assert.deepEqual(store.getState(), original, 'deriving a plan is read-only');
  let state = act(store, { type: 'revise_claim', claimId, text: original.claims[0]!.text, metadata: { analysisUnit: 'donor', biologicalReplicates: 4 }, rationale: 'Declare the design without implying evidence verification.' });
  plan = evidencePlan(state, claimId);
  assert.equal(plan.find(item => item.id === 'baseline:design')!.status, 'declared');
  assert.equal(plan.find(item => item.id === 'baseline:replication')!.status, 'declared');
  state = act(store, { type: 'attach_evidence', claimId, name: 'analysis.txt', mediaType: 'text/plain', content: 'Synthetic donor-level analysis supplied for scoped evidence linking.' });
  const resourceId = state.resources.at(-1)!.id;
  const linkAction = { type: 'link_evidence_requirement', claimId, requirementId: 'baseline:analysis', resourceIds: [resourceId], rationale: 'This selected analysis addresses the planned requirement.' };
  assert.throws(() => act(store, linkAction, agent), code('RESEARCHER_REQUIRED'));
  state = act(store, linkAction);
  assert.equal(evidencePlan(state, claimId).find(item => item.id === 'baseline:analysis')!.status, 'provided');
  state = act(store, { type: 'revise_claim', claimId: unrelated, text: 'Unrelated corrected claim.', rationale: 'Keep other scoped evidence links current.' });
  assert.equal(evidencePlan(state, claimId).find(item => item.id === 'baseline:analysis')!.status, 'provided');
  state = act(store, { type: 'revise_claim', claimId, text: 'The narrowed target needs a new evidence correspondence check.', scope: 'causal', rationale: 'Changed the scientific target.' });
  plan = evidencePlan(state, claimId);
  assert.equal(plan.find(item => item.id === 'baseline:analysis')!.status, 'needs_review');
  assert.ok(plan.some(item => item.id === 'baseline:causal' && item.status === 'missing'));
  assert.ok(evidencePlan(state, downstream).some(item => item.origin === 'dependency' && item.status === 'needs_review'));
  assert.equal(plan.find(item => item.id === 'baseline:assessment')!.status, 'needs_review');
  assert.equal(plan.find(item => item.id === 'baseline:assessment')!.linkable, false);
  assert.ok(state.claims.every(item => item.evidenceCeiling === 'NOT_ASSESSED'));
  assert.equal(state.scientificAuthorization, 'NONE');
  const before = store.getState();
  for (const action of [
    { ...linkAction, requirementId: 'invented:requirement' },
    { ...linkAction, resourceIds: ['foreign-resource'] },
    { ...linkAction, requirementId: 'baseline:assessment' },
    { ...linkAction, requirementId: 'baseline:replication' },
  ]) {
    assert.throws(() => act(store, action));
    assert.deepEqual(store.getState(), before);
  }
  verifyState(state);
});

test('only adopted evidence needs become actionable checklist items and linked material remains unassessed', () => {
  const { store, ids: [claimId] } = workspace(1);
  let state = finding(store, claimId, revisionProposal);
  const findingId = state.findings[0]!.id;
  assert.ok(!evidencePlan(state, claimId).some(item => item.origin === 'proposal'));
  state = act(store, { type: 'apply_revision_proposal', findingId, acceptText: false, acceptScope: false, evidenceNeedIds: ['analysis-report'], rationale: 'Adopt one concrete analysis follow-up.' });
  let items = evidencePlan(state, claimId).filter(item => item.origin === 'proposal');
  assert.equal(items.length, 1);
  assert.equal(items[0]!.id, `proposal:${findingId}:analysis-report`);
  assert.equal(items[0]!.status, 'missing');
  state = act(store, { type: 'attach_evidence', claimId, name: 'planned-analysis.txt', mediaType: 'text/plain', content: 'Synthetic analysis evidence.' });
  state = act(store, { type: 'link_evidence_requirement', claimId, requirementId: items[0]!.id, resourceIds: [state.resources.at(-1)!.id], rationale: 'Provide the chosen next-step result.' });
  items = evidencePlan(state, claimId).filter(item => item.origin === 'proposal');
  assert.equal(items[0]!.status, 'provided');
  assert.equal(state.claims[0]!.evidenceCeiling, 'NOT_ASSESSED');
  verifyState(state);
});

test('A-to-B-to-A edits cannot revive prior reports, linked evidence or unobserved pending runs; unrelated and no-op edits preserve them', () => {
  const { store, ids: [claimId, unrelated] } = workspace(2);
  let state = act(store, { type: 'attach_evidence', claimId, name: 'analysis.txt', mediaType: 'text/plain', content: 'Synthetic evidence for the original claim.' });
  state = act(store, { type: 'link_evidence_requirement', claimId, requirementId: 'baseline:analysis', resourceIds: [state.resources[0]!.id], rationale: 'Checked this correspondence against the original claim.' });
  state = act(store, { type: 'run_review' }, agent);
  const originalText = state.claims[0]!.text;
  const runs = new ReviewRuns();
  const run = runs.create(state, { claimId, snapshotHash: state.snapshotHash, resourceIds: [state.resources[0]!.id], mode: 'methods', focus: 'Review the selected original evidence.' });
  state = act(store, { type: 'revise_claim', claimId, text: originalText, scope: state.claims[0]!.scope, metadata: state.claims[0]!.metadata, rationale: 'Save without changing any scientific input.' });
  state = act(store, { type: 'revise_claim', claimId: unrelated, text: 'An independent correction.', rationale: 'This claim has no dependency relation.' });
  assert.ok(currentMetadataReview(state, claimId));
  assert.equal(evidencePlan(state, claimId).find(item => item.id === 'baseline:analysis')!.status, 'provided');
  assert.equal(runs.list(state).find(item => item.id === run.id)!.phase, 'queued');
  act(store, { type: 'revise_claim', claimId, text: 'A materially different claim.', rationale: 'Change the target after the review began.' });
  state = act(store, { type: 'revise_claim', claimId, text: originalText, rationale: 'Restore the earlier wording without a new assessment.' });
  assert.equal(currentMetadataReview(state, claimId), undefined, 'the old report remains invalidated even after restoring its input bytes');
  assert.equal(evidencePlan(state, claimId).find(item => item.id === 'baseline:analysis')!.status, 'needs_review');
  assert.equal(runs.list(state).find(item => item.id === run.id)!.phase, 'stale', 'freshness must not depend on whether the UI polled between edits');
  assert.throws(() => runs.assertWritable(state, run.id), code('REVIEW_CLOSED'));
});

test('partial revision proposals survive no-op saves but cannot resume after material edit and restoration', () => {
  const { store, ids: [claimId] } = workspace(1);
  let state = finding(store, claimId, revisionProposal);
  const findingId = state.findings[0]!.id;
  state = act(store, { type: 'apply_revision_proposal', findingId, acceptText: true, acceptScope: false, evidenceNeedIds: [], rationale: 'Adopt wording first.' });
  state = act(store, { type: 'revise_claim', claimId, text: state.claims[0]!.text, scope: state.claims[0]!.scope, metadata: state.claims[0]!.metadata, rationale: 'Save identical scientific inputs.' });
  assert.equal(proposalAvailability(state, state.findings[0]!).available, true, 'a no-op save is not a new relevant context');
  act(store, { type: 'revise_claim', claimId, text: 'A distinct interpretation introduced outside the proposal.', rationale: 'Material external revision.' });
  state = act(store, { type: 'revise_claim', claimId, text: revisionProposal.text, rationale: 'Restore proposed wording.' });
  assert.equal(proposalAvailability(state, state.findings[0]!).available, false);
  const before = store.getState();
  assert.throws(() => act(store, { type: 'apply_revision_proposal', findingId, acceptText: false, acceptScope: true, evidenceNeedIds: [], rationale: 'Try to use the old scope suggestion.' }), code('STALE_PROPOSAL'));
  assert.deepEqual(store.getState(), before);
});
