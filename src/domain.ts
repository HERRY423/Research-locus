import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type Actor = { kind: 'researcher' | 'agent'; id: string };
export type ClaimScope = 'sample' | 'cohort' | 'population' | 'causal';
export type DecisionKind = 'challenge' | 'dismiss' | 'defer' | 'accept_with_limits';
export interface Claim {
  id: string;
  text: string;
  scope: ClaimScope;
  resourceIds: string[];
  metadata: { biologicalReplicates?: number; analysisUnit?: 'cell' | 'donor'; perturbation?: boolean; figureSourceMatched?: boolean };
  evidenceCeiling: 'NOT_ASSESSED';
}
export interface Resource {
  id: string;
  name: string;
  mediaType: string;
  content: string;
  sha256: string;
  sourceKind: 'synthetic_fixture' | 'user_upload' | 'host_resource';
  sourceUri?: string;
}
export interface Finding {
  id: string;
  claimId: string;
  title: string;
  rationale: string;
  severity: 'info' | 'warning' | 'critical';
  category: 'design' | 'claim_scope' | 'provenance' | 'other';
  source: 'deterministic_check' | 'agent_suggestion';
  snapshotHash: string;
  status: 'active' | 'stale';
  resourceIds: string[];
  ruleId?: string;
}
export interface HumanDecision {
  id: string;
  findingId: string;
  claimId: string;
  decision: DecisionKind;
  rationale: string;
  conditions: string[];
  actorId: string;
  actorOrigin: 'researcher';
  identityVerification: 'DECLARED_NOT_AUTHENTICATED';
  at: string;
  snapshotHash: string;
  status: 'current' | 'stale';
}
export type ReviewAction =
  | { type: 'pause' | 'resume' | 'run_review' }
  | { type: 'add_finding'; claimId: string; title: string; rationale: string; severity: Finding['severity']; category: Finding['category']; snapshotHash: string; resourceIds: string[] }
  | { type: 'intervene'; findingId: string; decision: DecisionKind; rationale: string; conditions?: string[] }
  | { type: 'revise_claim'; claimId: string; text: string; scope?: ClaimScope; rationale: string }
  | { type: 'create_claim'; text: string; scope: ClaimScope; rationale: string }
  | { type: 'attach_evidence'; claimId: string; name: string; mediaType: string; content: string; sourceKind?: 'user_upload' | 'host_resource'; sourceUri?: string };
export interface AuditEvent {
  id: string;
  revision: number;
  at: string;
  actor: Actor;
  action: ReviewAction | { type: 'fixture_created' | 'workspace_created' };
  previousHash: string | null;
  stateHash: string;
  hash: string;
}
export interface ReviewSnapshot {
  hash: string;
  projectId: string;
  rulesVersion: 'metadata-checks.v1';
  claims: Claim[];
  resourceRefs: Array<Omit<Resource, 'content'>>;
}
export interface ReviewState {
  schemaVersion: 'research-locus.review.v1';
  projectId: string;
  title: string;
  fixture: boolean;
  fixtureNotice: string;
  revision: number;
  reviewStatus: 'active' | 'paused';
  snapshotHash: string;
  claims: Claim[];
  resources: Resource[];
  snapshots: ReviewSnapshot[];
  findings: Finding[];
  decisions: HumanDecision[];
  events: AuditEvent[];
  scientificAuthorization: 'NONE';
}

export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = 'DomainError';
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new DomainError('INVALID_VALUE', 'Undefined values cannot be recorded.');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}
function hash(value: unknown): string { return createHash('sha256').update(canonical(value), 'utf8').digest('hex'); }
function contentHash(content: string): string { return createHash('sha256').update(content, 'utf8').digest('hex'); }
function copy<T>(value: T): T { return structuredClone(value); }
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('INVALID_INPUT', `${name} must be an object.`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
  if (unexpected.length) throw new DomainError('INVALID_INPUT', `Unexpected fields: ${unexpected.join(', ')}.`);
}
function text(value: unknown, name: string, max = 8000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\u0000/.test(value)) {
    throw new DomainError('INVALID_INPUT', `${name} must be a nonempty string of at most ${max} characters, without NUL.`);
  }
  return value;
}
function choice<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new DomainError('INVALID_INPUT', `Invalid ${name}.`);
  return value as T;
}
function strings(value: unknown, name: string, maxItems = 100): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new DomainError('INVALID_INPUT', `${name} must be an array of at most ${maxItems} strings.`);
  const result = value.map(item => text(item, name, 2000));
  if (new Set(result).size !== result.length) throw new DomainError('INVALID_INPUT', `${name} contains duplicate values.`);
  return result;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new DomainError('INVALID_INPUT', 'snapshotHash must be a SHA-256 digest.');
  return value;
}
function parseActor(value: unknown): Actor {
  const actor = object(value, 'actor');
  keys(actor, ['kind', 'id']);
  const kind = choice(actor.kind, ['researcher', 'agent'] as const, 'actor kind');
  const id = text(actor.id, 'actor id', 200);
  if (kind === 'researcher' && /^(agent:|ai:|model:)|^(chatgpt|gpt|bionexus)$/i.test(id.trim())) {
    throw new DomainError('ACTOR_NOT_RESEARCHER', 'An automated identity cannot record a researcher intervention.', 403);
  }
  return { kind, id };
}
export function parseAction(value: unknown): ReviewAction {
  const action = object(value, 'action');
  switch (action.type) {
    case 'pause': case 'resume': case 'run_review':
      keys(action, ['type']);
      return { type: action.type };
    case 'add_finding':
      keys(action, ['type', 'claimId', 'title', 'rationale', 'severity', 'category', 'snapshotHash', 'resourceIds']);
      return { type: 'add_finding', claimId: text(action.claimId, 'claimId', 200), title: text(action.title, 'title', 300), rationale: text(action.rationale, 'rationale'), severity: choice(action.severity, ['info', 'warning', 'critical'] as const, 'severity'), category: choice(action.category, ['design', 'claim_scope', 'provenance', 'other'] as const, 'category'), snapshotHash: digest(action.snapshotHash), resourceIds: strings(action.resourceIds, 'resourceIds') };
    case 'intervene': {
      keys(action, ['type', 'findingId', 'decision', 'rationale', 'conditions']);
      const conditions = action.conditions === undefined ? [] : strings(action.conditions, 'conditions', 20);
      const decision = choice(action.decision, ['challenge', 'dismiss', 'defer', 'accept_with_limits'] as const, 'decision');
      if (decision === 'accept_with_limits' && conditions.length === 0) throw new DomainError('CONDITIONS_REQUIRED', 'Acceptance with limits requires at least one explicit condition.');
      return { type: 'intervene', findingId: text(action.findingId, 'findingId', 200), decision, rationale: text(action.rationale, 'rationale'), conditions };
    }
    case 'create_claim': {
      keys(action, ['type', 'text', 'scope', 'rationale']);
      return { type: 'create_claim', text: text(action.text, 'claim text', 16000), scope: choice(action.scope, ['sample', 'cohort', 'population', 'causal'] as const, 'scope'), rationale: text(action.rationale, 'rationale') };
    }
    case 'revise_claim': {
      keys(action, ['type', 'claimId', 'text', 'scope', 'rationale']);
      const result: ReviewAction = { type: 'revise_claim', claimId: text(action.claimId, 'claimId', 200), text: text(action.text, 'claim text', 16000), rationale: text(action.rationale, 'rationale') };
      if (action.scope !== undefined) result.scope = choice(action.scope, ['sample', 'cohort', 'population', 'causal'] as const, 'scope');
      return result;
    }
    case 'attach_evidence': {
      keys(action, ['type', 'claimId', 'name', 'mediaType', 'content', 'sourceKind', 'sourceUri']);
      const name = text(action.name, 'name', 240);
      if (/[\\/]/.test(name) || name === '.' || name === '..') throw new DomainError('INVALID_INPUT', 'Resource name must be a filename, without path separators.');
      const mediaType = text(action.mediaType, 'mediaType', 100);
      if (!/^(text\/[a-z0-9.+-]+|application\/(json|csv|xml))$/i.test(mediaType)) throw new DomainError('UNSUPPORTED_MEDIA', 'This prototype accepts UTF-8 text, CSV, JSON, and XML resources only.');
      const result: ReviewAction = { type: 'attach_evidence', claimId: text(action.claimId, 'claimId', 200), name, mediaType, content: text(action.content, 'content', 1_000_000), sourceKind: action.sourceKind === undefined ? 'user_upload' : choice(action.sourceKind, ['user_upload', 'host_resource'] as const, 'sourceKind') };
      if (action.sourceUri !== undefined) {
        const uri = text(action.sourceUri, 'sourceUri', 2000);
        const scheme = /^([a-z][a-z0-9+.-]*):[^\s\u0000]+$/i.exec(uri)?.[1]?.toLowerCase();
        if (!scheme || ['http', 'javascript', 'vbscript', 'data', 'command', 'powershell', 'shell'].includes(scheme)) throw new DomainError('INVALID_INPUT', 'sourceUri must be a host resource URI or HTTPS reference. Executable/data/insecure HTTP schemes are not accepted; references are recorded and never fetched.');
        result.sourceUri = uri;
      }
      return result;
    }
    default: throw new DomainError('UNKNOWN_ACTION', 'Unknown review action.');
  }
}

function snapshotPayload(state: ReviewState): Omit<ReviewSnapshot, 'hash'> {
  return {
    projectId: state.projectId, claims: copy(state.claims), rulesVersion: 'metadata-checks.v1',
    resourceRefs: state.resources.map(({ content: _content, ...reference }) => copy(reference)),
  };
}
function snapshot(state: ReviewState): string {
  return hash(snapshotPayload(state));
}
function preserveSnapshot(state: ReviewState): void {
  if (!state.snapshots.some(item => item.hash === state.snapshotHash)) {
    state.snapshots.push({ ...snapshotPayload(state), hash: state.snapshotHash });
  }
}
function stateDigest(state: ReviewState): string {
  const { events: _events, ...body } = state;
  return hash(body);
}
function appendEvent(state: ReviewState, action: AuditEvent['action'], actor: Actor): void {
  const unsigned = { id: randomUUID(), revision: state.revision, at: new Date().toISOString(), actor: copy(actor), action: copy(action), previousHash: state.events.at(-1)?.hash ?? null, stateHash: stateDigest(state) };
  state.events.push({ ...unsigned, hash: hash(unsigned) });
}
function review(state: ReviewState): void {
  if (state.reviewStatus === 'paused') throw new DomainError('REVIEW_PAUSED', 'Resume review before running checks or admitting reviewer suggestions.', 409);
  const findings: Array<Omit<Finding, 'id' | 'snapshotHash' | 'status' | 'source'>> = [];
  for (const claim of state.claims) {
    if (claim.metadata.analysisUnit === 'cell' && ['population', 'cohort'].includes(claim.scope)) {
      findings.push({ claimId: claim.id, title: 'Biological replicate structure needs review', rationale: 'Declared metadata uses cells as the analysis unit for a cohort/population claim. Inspect donor-level design and uncertainty. This metadata check does not recompute statistics or establish pseudoreplication.', severity: 'critical', category: 'design', resourceIds: [...claim.resourceIds], ruleId: 'META-DESIGN-001' });
    }
    if (claim.scope === 'causal' && claim.metadata.perturbation !== true) {
      findings.push({ claimId: claim.id, title: 'Causal claim exceeds the declared experiment', rationale: 'No perturbation is declared in the selected metadata. Supply causal identification evidence or narrow the claim; this check cannot establish whether an unreported experiment exists.', severity: 'critical', category: 'claim_scope', resourceIds: [...claim.resourceIds], ruleId: 'META-CAUSAL-001' });
    }
    if (claim.metadata.figureSourceMatched === false) {
      findings.push({ claimId: claim.id, title: 'Figure and source binding require reconciliation', rationale: 'Fixture metadata explicitly declares that the figure source does not match. Review the original table/figure mapping. No image analysis was performed.', severity: 'warning', category: 'provenance', resourceIds: [...claim.resourceIds], ruleId: 'META-SOURCE-001' });
    }
  }
  for (const finding of findings) {
    const existing = state.findings.some(item => item.status === 'active' && item.snapshotHash === state.snapshotHash && item.claimId === finding.claimId && item.ruleId === finding.ruleId);
    if (!existing) state.findings.push({ ...finding, id: randomUUID(), source: 'deterministic_check', snapshotHash: state.snapshotHash, status: 'active' });
  }
}

export function createDemoState(): ReviewState {
  const content = 'SYNTHETIC TEACHING FIXTURE — no patient or experimental data.\nClaim 1: two donors; cell-level analysis metadata.\nClaim 2: observational result without declared perturbation.\nClaim 3: deliberately mismatched source mapping.\n';
  const resource: Resource = { id: 'fixture-notes', name: 'synthetic-study-notes.txt', mediaType: 'text/plain', content, sha256: contentHash(content), sourceKind: 'synthetic_fixture' };
  const state: ReviewState = {
    schemaVersion: 'research-locus.review.v1', projectId: 'synthetic-co-review-demo', title: 'Research Locus · Synthetic co-review study', fixture: true,
    fixtureNotice: 'Synthetic illustrative workspace. Checks inspect declared metadata only, never execute statistics or an LLM. Human inputs are recorded declarations; identities are not independently authenticated. This mixed demo workspace remains synthetic after attachments.',
    revision: 0, reviewStatus: 'active', snapshotHash: '', resources: [resource],
    claims: [
      { id: 'claim-design', text: 'The treatment increases gene X expression across the patient population.', scope: 'population', resourceIds: [resource.id], metadata: { biologicalReplicates: 2, analysisUnit: 'cell' }, evidenceCeiling: 'NOT_ASSESSED' },
      { id: 'claim-causal', text: 'Pathway Y drives resistance to treatment.', scope: 'causal', resourceIds: [resource.id], metadata: { perturbation: false }, evidenceCeiling: 'NOT_ASSESSED' },
      { id: 'claim-figure', text: 'Figure 3 accurately depicts the selected differential-expression table.', scope: 'sample', resourceIds: [resource.id], metadata: { figureSourceMatched: false }, evidenceCeiling: 'NOT_ASSESSED' },
    ], snapshots: [], findings: [], decisions: [], events: [], scientificAuthorization: 'NONE',
  };
  state.snapshotHash = snapshot(state);
  preserveSnapshot(state);
  review(state);
  appendEvent(state, { type: 'fixture_created' }, { kind: 'agent', id: 'system:synthetic-fixture' });
  return state;
}

export function createEmptyState(initial: { projectId: string; title: string }): ReviewState {
  const projectId = text(initial.projectId, 'projectId', 200);
  const title = text(initial.title, 'title', 240);
  const state: ReviewState = {
    schemaVersion: 'research-locus.review.v1', projectId, title, fixture: false,
    fixtureNotice: 'Empty researcher-created review workspace. No research evidence has been assessed. Human inputs are recorded declarations; identities are not independently authenticated.',
    revision: 0, reviewStatus: 'active', snapshotHash: '', claims: [], resources: [], snapshots: [], findings: [], decisions: [], events: [], scientificAuthorization: 'NONE',
  };
  state.snapshotHash = snapshot(state);
  preserveSnapshot(state);
  appendEvent(state, { type: 'workspace_created' }, { kind: 'agent', id: 'system:workspace-initialization' });
  return state;
}

export function verifyState(state: ReviewState): void {
  try {
    if (state.schemaVersion !== 'research-locus.review.v1' || typeof state.fixture !== 'boolean' || state.scientificAuthorization !== 'NONE') throw new Error('unsupported schema or evidence boundary');
    if (!Number.isSafeInteger(state.revision) || state.revision < 0 || !['active', 'paused'].includes(state.reviewStatus)) throw new Error('invalid revision or review status');
    if (!Array.isArray(state.events) || state.events.length !== state.revision + 1) throw new Error('missing audit revisions');
    const claimIds = new Set(state.claims.map(claim => claim.id));
    const resourceIds = new Set(state.resources.map(resource => resource.id));
    if (claimIds.size !== state.claims.length || resourceIds.size !== state.resources.length) throw new Error('duplicate resource or claim ids');
    for (const resource of state.resources) if (resource.sha256 !== contentHash(resource.content)) throw new Error('resource digest mismatch');
    for (const claim of state.claims) if (claim.evidenceCeiling !== 'NOT_ASSESSED' || claim.resourceIds.some(id => !resourceIds.has(id))) throw new Error('invalid claim boundary or reference');
    if (snapshot(state) !== state.snapshotHash) throw new Error('snapshot digest mismatch');
    const snapshotHashes = new Set<string>();
    for (const preserved of state.snapshots) {
      const { hash: preservedHash, ...payload } = preserved;
      if (hash(payload) !== preservedHash || snapshotHashes.has(preservedHash)) throw new Error('historical snapshot mismatch');
      if (preserved.projectId !== state.projectId || preserved.rulesVersion !== 'metadata-checks.v1') throw new Error('invalid historical snapshot scope');
      for (const reference of preserved.resourceRefs) {
        const resource = state.resources.find(item => item.id === reference.id);
        if (!resource || resource.sha256 !== reference.sha256) throw new Error('historical snapshot resource missing');
      }
      snapshotHashes.add(preservedHash);
    }
    if (!snapshotHashes.has(state.snapshotHash)) throw new Error('current snapshot not retained');
    const findingIds = new Set(state.findings.map(finding => finding.id));
    if (findingIds.size !== state.findings.length) throw new Error('duplicate finding ids');
    for (const finding of state.findings) {
      if (!claimIds.has(finding.claimId) || finding.resourceIds.some(id => !resourceIds.has(id)) || !snapshotHashes.has(finding.snapshotHash)) throw new Error('invalid finding reference');
      if (!['active', 'stale'].includes(finding.status) || (finding.status === 'active' && finding.snapshotHash !== state.snapshotHash)) throw new Error('invalid finding snapshot');
    }
    for (const decision of state.decisions) {
      if (!findingIds.has(decision.findingId) || decision.actorOrigin !== 'researcher' || decision.identityVerification !== 'DECLARED_NOT_AUTHENTICATED') throw new Error('invalid decision');
      if (!['current', 'stale'].includes(decision.status) || (decision.status === 'current' && decision.snapshotHash !== state.snapshotHash)) throw new Error('invalid decision snapshot');
    }
    let previousHash: string | null = null;
    for (const [revision, event] of state.events.entries()) {
      const { hash: eventHash, ...unsigned } = event;
      if (event.revision !== revision || event.previousHash !== previousHash || hash(unsigned) !== eventHash) throw new Error('audit chain mismatch');
      previousHash = eventHash;
    }
    if (state.events.at(-1)?.stateHash !== stateDigest(state)) throw new Error('state digest mismatch');
  } catch (error) {
    throw new DomainError('INTEGRITY_ERROR', `Stored review state failed integrity verification: ${error instanceof Error ? error.message : 'invalid state'}.`, 500);
  }
}

export class ReviewStore {
  private state: ReviewState;
  private readonly filePath: string | undefined;
  constructor(options: { filePath?: string; initial?: { projectId: string; title: string }; requireExisting?: boolean } = {}) {
    this.filePath = options.filePath;
    if (options.requireExisting && !options.filePath) throw new DomainError('INVALID_INPUT', 'requireExisting needs a filePath.');
    this.state = options.initial ? createEmptyState(options.initial) : createDemoState();
    if (this.filePath) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.lock(() => {
        if (existsSync(this.filePath!)) this.state = this.read();
        else if (options.requireExisting) throw new DomainError('STORE_NOT_FOUND', 'The recorded review session file is missing; no replacement workspace was created.', 404);
        else this.persist(this.state);
      });
    }
  }
  getState(): ReviewState {
    if (this.filePath) this.state = this.read();
    return copy(this.state);
  }
  act(input: unknown, expectedRevision: number, actorInput: Actor): ReviewState {
    const action = parseAction(input);
    const actor = parseActor(actorInput);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new DomainError('INVALID_REVISION', 'expectedRevision must be a nonnegative safe integer.');
    return this.lock(() => {
      const current = this.filePath ? this.read() : this.state;
      if (current.revision !== expectedRevision) throw new DomainError('REVISION_CONFLICT', `Review changed: expected revision ${expectedRevision}, current revision ${current.revision}. Refresh before continuing.`, 409);
      if (actor.kind !== 'researcher' && !['run_review', 'add_finding'].includes(action.type)) throw new DomainError('RESEARCHER_REQUIRED', 'This action requires a researcher interaction from the trusted UI boundary.', 403);
      const next = copy(current);
      const claim = 'claimId' in action ? next.claims.find(item => item.id === action.claimId) : undefined;
      if ('claimId' in action && !claim) throw new DomainError('NOT_FOUND', 'Claim does not exist.', 404);
      switch (action.type) {
        case 'pause': next.reviewStatus = 'paused'; break;
        case 'resume': next.reviewStatus = 'active'; break;
        case 'run_review': review(next); break;
        case 'add_finding': {
          if (next.reviewStatus === 'paused') throw new DomainError('REVIEW_PAUSED', 'Paused review does not admit reviewer suggestions.', 409);
          if (action.snapshotHash !== next.snapshotHash) throw new DomainError('STALE_SNAPSHOT', 'Reviewer suggestion targets an outdated evidence snapshot.', 409);
          if (action.resourceIds.some(id => !claim!.resourceIds.includes(id))) throw new DomainError('INVALID_REFERENCE', 'Reviewer resources must belong to the selected claim.');
          const { type: _type, ...finding } = action;
          next.findings.push({ ...finding, id: randomUUID(), source: 'agent_suggestion', status: 'active' });
          break;
        }
        case 'intervene': {
          const finding = next.findings.find(item => item.id === action.findingId);
          if (!finding) throw new DomainError('NOT_FOUND', 'Finding does not exist.', 404);
          if (finding.status !== 'active' || finding.snapshotHash !== next.snapshotHash) throw new DomainError('STALE_SNAPSHOT', 'This finding belongs to an older snapshot. Re-run review before recording a decision.', 409);
          next.decisions.push({ id: randomUUID(), findingId: finding.id, claimId: finding.claimId, decision: action.decision, rationale: action.rationale, conditions: action.conditions ?? [], actorId: actor.id, actorOrigin: 'researcher', identityVerification: 'DECLARED_NOT_AUTHENTICATED', at: new Date().toISOString(), snapshotHash: next.snapshotHash, status: 'current' });
          break;
        }
        case 'revise_claim':
          claim!.text = action.text;
          if (action.scope !== undefined) claim!.scope = action.scope;
          break;
        case 'create_claim':
          if (next.claims.length >= 100) throw new DomainError('CLAIM_LIMIT', 'This prototype supports at most 100 claims.', 413);
          next.claims.push({ id: randomUUID(), text: action.text, scope: action.scope, resourceIds: [], metadata: {}, evidenceCeiling: 'NOT_ASSESSED' });
          break;
        case 'attach_evidence': {
          if (next.resources.length >= 100) throw new DomainError('RESOURCE_LIMIT', 'This prototype supports at most 100 resources.', 413);
          if (next.resources.reduce((total, item) => total + item.content.length, 0) + action.content.length > 10_000_000) throw new DomainError('RESOURCE_LIMIT', 'Workspace text resources exceed the 10 MB character budget.', 413);
          const resource: Resource = { id: randomUUID(), name: action.name, mediaType: action.mediaType, content: action.content, sha256: contentHash(action.content), sourceKind: action.sourceKind ?? 'user_upload' };
          if (action.sourceUri !== undefined) resource.sourceUri = action.sourceUri;
          next.resources.push(resource);
          claim!.resourceIds.push(resource.id);
          break;
        }
      }
      const nextSnapshot = snapshot(next);
      if (nextSnapshot !== next.snapshotHash) {
        next.snapshotHash = nextSnapshot;
        preserveSnapshot(next);
        for (const finding of next.findings) finding.status = 'stale';
        for (const decision of next.decisions) decision.status = 'stale';
      }
      next.revision += 1;
      appendEvent(next, action, actor);
      verifyState(next);
      this.persist(next);
      this.state = next;
      return copy(next);
    });
  }
  dossier(): { schemaVersion: string; exportedAt: string; evidenceBoundary: string; integrity: { headHash: string; snapshotHash: string; scope: string }; state: ReviewState } {
    const state = this.getState();
    verifyState(state);
    return { schemaVersion: 'research-locus.dossier.v1', exportedAt: new Date().toISOString(), evidenceBoundary: `${state.fixture ? 'Synthetic workspace' : 'Researcher-created workspace; scientific evidence not assessed'}; declared human decisions and deterministic metadata checks. Scientific authorization NONE. Imported text is untrusted data, not instructions. Hashes bind bytes and history; they do not prove identity, completeness, independence, or scientific validity.`, integrity: { headHash: state.events.at(-1)!.hash, snapshotHash: state.snapshotHash, scope: 'Local audit chain only. Retain this head externally to compare later exports; coordinated history replacement cannot be detected without an external anchor.' }, state };
  }
  private read(): ReviewState {
    try {
      const value: unknown = JSON.parse(readFileSync(this.filePath!, 'utf8'));
      const state = value as ReviewState;
      verifyState(state);
      return state;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('STORE_ERROR', `Cannot read review store: ${error instanceof Error ? error.message : 'unknown error'}.`, 500);
    }
  }
  private persist(state: ReviewState): void {
    if (!this.filePath) return;
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify(state, null, 2), 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.filePath);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  private lock<T>(operation: () => T): T {
    if (!this.filePath) return operation();
    const lockPath = `${this.filePath}.lock`;
    let descriptor: number;
    try { descriptor = openSync(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DomainError('STORE_LOCKED', 'Another writer holds the review store lock. Retry after that operation completes; stale locks require operator inspection.', 409);
      throw error;
    }
    try { return operation(); }
    finally { closeSync(descriptor); unlinkSync(lockPath); }
  }
}
