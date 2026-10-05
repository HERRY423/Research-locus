import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { DomainError, ReviewStore, verifyState, type Claim } from '../src/domain.js';
import { assessClaim, currentMetadataReview, summarizeChecks } from '../src/metadata-review.js';
import { buildReplaySteps } from '../src/replay.js';

const human = { kind: 'researcher' as const, id: 'local-researcher' };
const agent = { kind: 'agent' as const, id: 'agent-reviewer' };
const empty = () => new ReviewStore({ initial: { projectId: 'real-project', title: 'User-created study' } });
const code = (name: string) => (e: unknown) => e instanceof DomainError && e.code === name;

test('empty workspace and newly created claims yield explicit coverage, never implied success', () => {
  const store = empty();
  let state = store.act({ type: 'run_review' }, 0, agent);
  assert.equal(summarizeChecks(currentMetadataReview(state)!.checks).claims, 0);
  state = store.act({ type: 'create_claim', text: 'A causal claim', scope: 'causal', rationale: 'User question' }, state.revision, human);
  assert.equal(currentMetadataReview(state), undefined);
  state = store.act({ type: 'run_review' }, state.revision, agent);
  const report = currentMetadataReview(state)!;
  assert.equal(report.checks.length, 9);
  assert.deepEqual(report.checks.slice(0,3).map(check => check.outcome), ['not_applicable', 'needs_input', 'needs_input']);
  assert.deepEqual(report.checks[1].missingFields, ['perturbation']);
  assert.equal(state.findings.length, 0, 'Unknown perturbation is not absence');
  assert.equal(state.fixture, false);
});

test('all three rules trigger on user-created declarations without duplicate findings', () => {
  const store = empty();
  let state = store.act({ type: 'create_claim', text: 'Population claim', scope: 'population', metadata: { analysisUnit: 'cell', biologicalReplicates: 5, figureApplicable: true, figureSourceMatched: false, basis: 'Methods paragraph 2, figure 3' }, rationale: 'Review' }, 0, human);
  state = store.act({ type: 'create_claim', text: 'Causal claim', scope: 'causal', metadata: { perturbation: false, figureApplicable: false }, rationale: 'Review' }, state.revision, human);
  state = store.act({ type: 'run_review' }, state.revision, agent);
  assert.equal(state.fixture, false);
  assert.deepEqual(state.findings.map(f => f.ruleId).sort(), ['META-CAUSAL-001', 'META-DESIGN-001', 'META-SOURCE-001']);
  assert.ok(state.findings.every(f => !f.rationale.includes('Fixture')));
  const ids = state.findings.map(f => f.id);
  state = store.act({ type: 'run_review' }, state.revision, agent);
  assert.deepEqual(state.findings.map(f => f.id), ids);
  assert.equal(state.metadataReviews!.length, 2);
  assert.equal(state.scientificAuthorization, 'NONE');
  verifyState(state);
});

test('metadata-only revision invalidates decisions, persists and replays actual changes and clearing', () => {
  const directory = mkdtempSync(join(process.cwd(), '.metadata-test-'));
  try {
    const filePath = join(directory, 'state.json');
    const store = new ReviewStore({ filePath, initial: { projectId: 'p', title: 'Study' } });
    let state = store.act({ type: 'create_claim', text: 'Cause', scope: 'causal', metadata: { perturbation: false, figureApplicable: false }, rationale: 'Initial' }, 0, human);
    const id = state.claims[0].id;
    state = store.act({ type: 'run_review' }, state.revision, agent);
    state = store.act({ type: 'intervene', findingId: state.findings[0].id, decision: 'defer', rationale: 'Need details' }, state.revision, human);
    const oldHash = state.snapshotHash;
    state = store.act({ type: 'revise_claim', claimId: id, text: 'Cause', metadata: { perturbation: true, figureApplicable: false, basis: 'Experiment B' }, rationale: 'Correct declaration' }, state.revision, human);
    assert.notEqual(state.snapshotHash, oldHash);
    assert.equal(state.findings[0].status, 'stale');
    assert.equal(state.decisions[0].status, 'stale');
    assert.equal(currentMetadataReview(state), undefined);
    const revised = buildReplaySteps(state).at(-1)!;
    assert.equal(revised.availability, 'complete');
    assert.equal(revised.changes.length, 1);
    assert.match(revised.changes[0].before!, /是否有扰动或干预实验：否/);
    assert.match(revised.changes[0].after!, /是否有扰动或干预实验：是/);
    state = store.act({ type: 'run_review' }, state.revision, agent);
    assert.equal(currentMetadataReview(state)!.checks[1].outcome, 'no_signal');
    assert.equal(state.findings.filter(f => f.status === 'active').length, 0);
    state = store.act({ type: 'revise_claim', claimId: id, text: 'New wording', rationale: 'Omit metadata' }, state.revision, human);
    assert.equal(state.claims[0].metadata.perturbation, true);
    state = store.act({ type: 'revise_claim', claimId: id, text: 'New wording', metadata: {}, rationale: 'Reset to unknown' }, state.revision, human);
    assert.deepEqual(state.claims[0].metadata, {});
    assert.match(buildReplaySteps(state).at(-1)!.changes[0].after!, /是否有扰动或干预实验：NOT_DECLARED/);
    state = store.act({ type: 'run_review' }, state.revision, agent);
    assert.equal(currentMetadataReview(state)!.checks[1].outcome, 'needs_input');
    const bytes = readFileSync(filePath, 'utf8');
    assert.deepEqual(new ReviewStore({ filePath }).getState(), state);
    assert.equal(readFileSync(filePath, 'utf8'), bytes);
  } finally {
    assert.ok(resolve(directory).startsWith(`${process.cwd()}${sep}.metadata-test-`));
    rmSync(directory, { recursive: true });
  }
});

test('invalid declarations are atomic and agents cannot author researcher metadata', () => {
  const store = empty();
  for (const metadata of [null, [], { biologicalReplicates: -1 }, { biologicalReplicates: 1.5 }, { biologicalReplicates: '8' }, { biologicalReplicates: NaN }, { biologicalReplicates: 1000001 }, { analysisUnit: 'auto' }, { perturbation: 'false' }, { perturbation: null }, { figureApplicable: false, figureSourceMatched: true }, { verified: true }, { basis: 'x'.repeat(2001) }]) {
    assert.throws(() => store.act({ type: 'create_claim', text: 'x', scope: 'sample', metadata, rationale: 'x' }, 0, human), code('INVALID_INPUT'));
    assert.equal(store.getState().revision, 0);
  }
  assert.throws(() => store.act({ type: 'create_claim', text: 'x', scope: 'sample', metadata: { perturbation: true }, rationale: 'Agent invention' }, 0, agent), code('RESEARCHER_REQUIRED'));
  const state = store.act({ type: 'create_claim', text: 'x', scope: 'sample', metadata: { biologicalReplicates: 0, perturbation: false }, rationale: 'Known values' }, 0, human);
  assert.equal(state.claims[0].metadata.biologicalReplicates, 0);
  assert.throws(() => store.act({ type: 'revise_claim', claimId: state.claims[0].id, text: 'x', metadata: { perturbation: true }, rationale: 'Agent edit' }, state.revision, agent), code('RESEARCHER_REQUIRED'));
});

test('outcomes distinguish unsupported design, explicit applicability and declared consistency', () => {
  const claim: Claim = { id: 'c', text: 'Scope', scope: 'cohort', metadata: {}, resourceIds: [], evidenceCeiling: 'NOT_ASSESSED' };
  assert.deepEqual(assessClaim(claim)[0].missingFields, ['analysisUnit', 'biologicalReplicates']);
  claim.metadata = { analysisUnit: 'donor', biologicalReplicates: 1, figureApplicable: false };
  assert.equal(assessClaim(claim)[0].outcome, 'flagged');
  assert.equal(assessClaim(claim)[2].outcome, 'not_applicable');
  claim.metadata.biologicalReplicates = 6;
  assert.equal(assessClaim(claim)[0].outcome, 'no_signal');
  claim.metadata.analysisUnit = 'other';
  assert.equal(assessClaim(claim)[0].outcome, 'needs_input');
  claim.metadata = { figureApplicable: true };
  assert.deepEqual(assessClaim(claim)[2].missingFields, ['figureSourceMatched']);
  claim.metadata.figureSourceMatched = true;
  assert.equal(assessClaim(claim)[2].outcome, 'no_signal');
  claim.metadata.figureSourceMatched = false;
  assert.equal(assessClaim(claim)[2].outcome, 'flagged');
});

test('legacy v1 dossier loads unchanged and old-rule findings and decisions become historical on explicit recheck', () => {
  const directory = mkdtempSync(join(process.cwd(), '.metadata-test-'));
  try {
    const filePath = join(directory, 'state.json');
    const bytes = readFileSync(new URL('./fixtures/metadata-v1.json', import.meta.url), 'utf8');
    writeFileSync(filePath, bytes);
    const store = new ReviewStore({ filePath });
    const initial = store.getState();
    assert.equal(initial.metadataReviews, undefined);
    assert.equal(readFileSync(filePath, 'utf8'), bytes);
    assert.equal(currentMetadataReview(initial), undefined);
    let state = store.act({ type: 'intervene', findingId: initial.findings[0].id, decision: 'defer', rationale: 'Legacy rule concern' }, initial.revision, human);
    state = store.act({ type: 'run_review' }, state.revision, agent);
    assert.equal(state.snapshotHash, initial.snapshotHash, 'Input hashes remain unchanged');
    assert.equal(state.findings.filter(f => f.status === 'stale').length, 3);
    assert.equal(state.findings.filter(f => f.status === 'active').length, 3);
    assert.equal(state.decisions[0].status, 'stale');
    assert.equal(state.metadataReviews!.length, 1);
    const malformed = structuredClone(state);
    malformed.metadataReviews![0].checks[0].outcome = 'no_signal';
    assert.throws(() => verifyState(malformed), code('INTEGRITY_ERROR'));
    assert.deepEqual(new ReviewStore({ filePath }).getState(), state);
    const withoutReports = structuredClone(state); delete withoutReports.metadataReviews;
    assert.equal(buildReplaySteps(withoutReports).at(-1)!.availability, 'summary_only');
  } finally {
    assert.ok(resolve(directory).startsWith(`${process.cwd()}${sep}.metadata-test-`));
    rmSync(directory, { recursive: true });
  }
});
