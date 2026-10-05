import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { WorkspaceCatalog } from '../src/catalog.js';
import { DomainError, ReviewStore } from '../src/domain.js';

const researcher = { kind: 'researcher' as const, id: 'local-user-unverified' };
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
function temp(): string { return mkdtempSync(join(process.cwd(), '.catalog-test-')); }
function cleanup(directory: string): void {
  assert.ok(resolve(directory).startsWith(`${resolve(process.cwd())}${sep}.catalog-test-`));
  rmSync(directory, { recursive: true, force: true });
}

test('existing review is registered once without fabricating conversation history', () => {
  const legacyStore = new ReviewStore();
  legacyStore.act({ type: 'pause' }, 0, researcher);
  legacyStore.act({ type: 'resume' }, 1, researcher);
  const original = legacyStore.getState();
  const catalog = new WorkspaceCatalog({ legacyStore });
  const state = catalog.list();
  assert.equal(state.projects.length, 1);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0]!.revision, 2);
  assert.equal(state.sessions[0]!.id, catalog.defaultSessionId);
  assert.equal(state.sessions[0]!.createdAt, original.events[0]!.at);
  assert.equal(state.sessions[0]!.updatedAt, original.events.at(-1)!.at);
  assert.strictEqual(catalog.getStore(catalog.defaultSessionId), legacyStore);
  assert.deepEqual(legacyStore.getState(), original);
});

test('new projects and sessions are real empty isolated workspaces', () => {
  const catalog = new WorkspaceCatalog({ legacyStore: new ReviewStore() });
  const projects = catalog.createProject('  Research project  ');
  const project = projects.projects.at(-1)!;
  assert.equal(project.title, 'Research project');
  assert.equal(project.sessionCount, 0);
  const first = catalog.createSession(project.id, 'First review');
  const second = catalog.createSession(project.id, 'Second review');
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(first.state.fixture, false);
  assert.deepEqual(first.state.claims, []);
  assert.deepEqual(first.state.resources, []);
  assert.deepEqual(first.state.findings, []);
  assert.deepEqual(first.state.decisions, []);
  assert.equal(first.state.events.length, 1);
  assert.equal(first.state.events[0]!.action.type, 'workspace_created');
  assert.equal(first.state.scientificAuthorization, 'NONE');
  const store = catalog.getStore(first.sessionId);
  store.act({ type: 'create_claim', text: 'Researcher supplied claim', scope: 'cohort', rationale: 'Start a review' }, 0, researcher);
  assert.equal(catalog.getStore(second.sessionId).getState().revision, 0);
  assert.equal(catalog.getStore(second.sessionId).getState().claims.length, 0);
  const listed = catalog.list();
  assert.equal(listed.projects.find(item => item.id === project.id)!.sessionCount, 2);
  assert.equal(listed.sessions.find(item => item.id === first.sessionId)!.claimCount, 1);
  assert.equal(listed.sessions.find(item => item.id === first.sessionId)!.revision, 1);
  const unchangedRevision = listed.revision;
  assert.equal(catalog.list().revision, unchangedRevision);
  listed.projects[0]!.title = 'Outside mutation';
  assert.notEqual(catalog.list().projects[0]!.title, 'Outside mutation');
});

test('catalog and session files survive restart without rewriting legacy bytes', () => {
  const directory = temp();
  try {
    const legacyPath = join(directory, 'state.json');
    const legacyStore = new ReviewStore({ filePath: legacyPath });
    legacyStore.act({ type: 'pause' }, 0, researcher);
    const originalBytes = readFileSync(legacyPath);
    const catalogDirectory = join(directory, 'workspace');
    const first = new WorkspaceCatalog({ directory: catalogDirectory, legacyStore });
    const project = first.createProject('Persisted project').projects.at(-1)!;
    const session = first.createSession(project.id, 'Persisted review');
    const changed = first.getStore(session.sessionId).act({ type: 'create_claim', text: 'Persisted claim', scope: 'sample', rationale: 'Researcher entry' }, 0, researcher);
    first.list();
    const restarted = new WorkspaceCatalog({ directory: catalogDirectory, legacyStore: new ReviewStore({ filePath: legacyPath }) });
    assert.deepEqual(restarted.getStore(session.sessionId).getState(), changed);
    assert.equal(restarted.list().sessions.length, 2);
    assert.equal(restarted.defaultSessionId, first.defaultSessionId);
    assert.deepEqual(readFileSync(legacyPath), originalBytes);
    assert.deepEqual(readdirSync(join(catalogDirectory, 'sessions')), [`${session.sessionId}.json`]);
  } finally { cleanup(directory); }
});

test('independent catalog instances append safely and reject stale session mutations', () => {
  const directory = temp();
  try {
    const legacyStore = new ReviewStore();
    const first = new WorkspaceCatalog({ directory, legacyStore });
    const second = new WorkspaceCatalog({ directory, legacyStore });
    first.createProject('One');
    const project = second.createProject('Two').projects.at(-1)!;
    assert.equal(first.list().projects.length, 3);
    const session = first.createSession(project.id, 'Shared');
    const secondStore = second.getStore(session.sessionId);
    const stale = secondStore.getState();
    first.getStore(session.sessionId).act({ type: 'pause' }, 0, researcher);
    assert.throws(() => secondStore.act({ type: 'pause' }, stale.revision, researcher), code('REVISION_CONFLICT'));
    assert.equal(second.list().sessions.find(item => item.id === session.sessionId)!.reviewStatus, 'paused');
  } finally { cleanup(directory); }
});

test('unknown IDs, path traversal, empty titles, and forged initialization actions are rejected', () => {
  const catalog = new WorkspaceCatalog({ legacyStore: new ReviewStore() });
  for (const id of ['../state', '..\\state', 'C:\\state', 'legacy/../state', 'file://x', '%2e%2e']) assert.throws(() => catalog.getStore(id), code('INVALID_SESSION_ID'));
  assert.throws(() => catalog.getStore('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'), code('SESSION_NOT_FOUND'));
  assert.throws(() => catalog.createSession('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Unknown'), code('PROJECT_NOT_FOUND'));
  assert.throws(() => catalog.createProject(' '), code('INVALID_TITLE'));
  assert.throws(() => catalog.createProject('title\nspoof'), code('INVALID_TITLE'));
  assert.throws(() => catalog.createSession(catalog.list().projects[0]!.id, ''), code('INVALID_TITLE'));
  const empty = new ReviewStore({ initial: { projectId: 'project', title: 'Empty' } });
  assert.throws(() => empty.act({ type: 'workspace_created' }, 0, researcher), code('UNKNOWN_ACTION'));
});

test('missing session files and malformed catalog fail closed without recreating sessions', () => {
  const directory = temp();
  try {
    const legacyStore = new ReviewStore();
    const catalog = new WorkspaceCatalog({ directory, legacyStore });
    const project = catalog.createProject('Project').projects.at(-1)!;
    const session = catalog.createSession(project.id, 'Review');
    const filePath = join(directory, 'sessions', `${session.sessionId}.json`);
    unlinkSync(filePath);
    const restarted = new WorkspaceCatalog({ directory, legacyStore });
    assert.throws(() => restarted.getStore(session.sessionId), code('STORE_NOT_FOUND'));
    assert.deepEqual(readdirSync(join(directory, 'sessions')), []);
    writeFileSync(join(directory, 'catalog.json'), '{broken JSON');
    assert.throws(() => new WorkspaceCatalog({ directory, legacyStore }), code('CATALOG_INTEGRITY_ERROR'));
    assert.equal(readFileSync(join(directory, 'catalog.json'), 'utf8'), '{broken JSON');
  } finally { cleanup(directory); }
});
