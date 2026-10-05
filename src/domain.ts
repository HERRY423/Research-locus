import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { assessClaim, METADATA_RULES_VERSION, type ClaimMetadata, type MetadataReview } from './metadata-review.js';
import { designKeys, designFields, NOT_DECLARED, type DesignField } from './design-fields.js';
import { assessClaimV2 } from './legacy/metadata-v2.js';
import { parseCandidates, validateProposalEvidence, type DesignCandidate, type DesignProposal } from './design-proposals.js';
import { claimInputSignature, dependencyDescendants, isClaimSnapshotCurrent, validateClaimRelations, type ClaimRelation, type ClaimRelationKind, type ReReviewFlag } from './claim-graph.js';
import { parseRevisionProposal, proposalAvailability, type AcceptedEvidenceNeed, type EvidenceLink, type RevisionAdoption, type RevisionProposal } from './revision-proposals.js';
import { evidencePlan } from './evidence-plan.js';
import { parseComputationalReceipt, type ComputationalReceipt } from './computational-receipts.js';
import { verifyDoi, parseDoiVerificationInput, assertDoiVerification, type DoiVerification, type DoiVerificationInput } from './doi-verification.js';
export { dependencyDescendants, isClaimSnapshotCurrent } from './claim-graph.js';
export type { ClaimRelation, ClaimRelationKind, ReReviewFlag } from './claim-graph.js';
export type { EvidenceNeed, AcceptedEvidenceNeed, EvidenceLink, RevisionAdoption, RevisionProposal } from './revision-proposals.js';

export type Actor = { kind: 'researcher' | 'agent'; id: string };
export type ClaimScope = 'sample' | 'cohort' | 'population' | 'causal';
export type DecisionKind = 'challenge' | 'dismiss' | 'defer' | 'accept_with_limits';
export interface Claim {
  id: string;
  text: string;
  scope: ClaimScope;
  resourceIds: string[];
  metadata: ClaimMetadata;
  evidenceCeiling: 'NOT_ASSESSED';
  disposition?: 'active' | 'rejected';
  evidenceNeeds?: AcceptedEvidenceNeed[];
}
export interface Resource {
  id: string;
  name: string;
  mediaType: string;
  content: string;
  sha256: string;
  sourceKind: 'synthetic_fixture' | 'user_upload' | 'host_resource';
  sourceUri?: string;
  evidenceKind?: 'computational_receipt' | 'doi_verification';
  computationReceipt?: ComputationalReceipt;
  doiVerification?: DoiVerification;
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
  rulesVersion?: string;
  revisionProposal?: RevisionProposal;
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
  | { type: 'import_computational_receipt'; claimId: string; receipt: unknown; rationale: string }
  | { type: 'record_doi_verification'; claimId: string; input: DoiVerificationInput; result: DoiVerification }
  | { type: 'propose_design'; runId: string; claimId: string; snapshotHash: string; resourceIds: string[]; candidates: DesignCandidate[] }
  | { type: 'confirm_design'; proposalId: string; selectedFields: DesignField[]; rationale: string }
  | { type: 'pause' | 'resume' | 'run_review' }
  | { type: 'add_finding'; claimId: string; title: string; rationale: string; severity: Finding['severity']; category: Finding['category']; snapshotHash: string; resourceIds: string[]; revisionProposal?: RevisionProposal }
  | { type: 'add_claim_relation'; sourceClaimId: string; targetClaimId: string; kind: ClaimRelationKind; rationale: string }
  | { type: 'remove_claim_relation'; relationId: string; rationale: string }
  | { type: 'set_claim_disposition'; claimId: string; disposition: 'active' | 'rejected'; rationale: string }
  | { type: 'acknowledge_re_review'; claimId: string; rationale: string }
  | { type: 'apply_revision_proposal'; findingId: string; acceptText: boolean; acceptScope: boolean; evidenceNeedIds: string[]; rationale: string }
  | { type: 'link_evidence_requirement'; claimId: string; requirementId: string; resourceIds: string[]; rationale: string }
  | { type: 'intervene'; findingId: string; decision: DecisionKind; rationale: string; conditions?: string[] }
  | { type: 'revise_claim'; claimId: string; text: string; scope?: ClaimScope; metadata?: ClaimMetadata; rationale: string }
  | { type: 'create_claim'; text: string; scope: ClaimScope; metadata?: ClaimMetadata; rationale: string }
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
  beforeSnapshotHash?: string;
  afterSnapshotHash?: string;
}
export interface ReviewSnapshot {
  hash: string;
  projectId: string;
  rulesVersion: 'metadata-checks.v1';
  claims: Claim[];
  resourceRefs: Array<Omit<Resource, 'content'>>;
  claimRelations?: ClaimRelation[];
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
  /** Absent on legacy dossiers. Old bytes and hashes are never migrated on read. */
  metadataReviews?: MetadataReview[];
  designProposals?: DesignProposal[];
  claimRelations?: ClaimRelation[];
  reReview?: ReReviewFlag[];
  revisionAdoptions?: RevisionAdoption[];
  evidenceLinks?: EvidenceLink[];
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
export function parseMetadata(value: unknown): ClaimMetadata {
  const input = object(value, 'metadata');
  keys(input, [...designKeys, 'basis']);
  const parsed: ClaimMetadata = {};
  for (const key of designKeys) if (input[key] === NOT_DECLARED) (parsed as Record<string,unknown>)[key] = NOT_DECLARED;
  if (input.biologicalReplicates !== undefined && input.biologicalReplicates !== NOT_DECLARED) {
    if (!Number.isSafeInteger(input.biologicalReplicates) || Number(input.biologicalReplicates) < 0 || Number(input.biologicalReplicates) > 1_000_000) throw new DomainError('INVALID_INPUT', 'biologicalReplicates must be an integer from 0 to 1000000; omit it when unknown.');
    parsed.biologicalReplicates = input.biologicalReplicates as number;
  }
  if (input.analysisUnit !== undefined && input.analysisUnit !== NOT_DECLARED) parsed.analysisUnit = choice(input.analysisUnit, ['cell', 'donor', 'sample', 'other'] as const, 'analysisUnit');
  for (const key of designKeys.filter(key => designFields[key].kind === 'boolean')) {
    if (input[key] === undefined || input[key] === NOT_DECLARED) continue;
    if (typeof input[key] !== 'boolean') throw new DomainError('INVALID_INPUT', `${key} must be true or false; omit it when unknown.`);
    (parsed as Record<string,unknown>)[key] = input[key];
  }
  if (parsed.figureApplicable === false && typeof parsed.figureSourceMatched === 'boolean') throw new DomainError('INVALID_INPUT', 'A non-applicable figure cannot also declare a matching result.');
  if (input.basis !== undefined) parsed.basis = text(input.basis, 'metadata basis', 2000);
  return parsed;
}
export function parseAction(value: unknown): ReviewAction {
  const action = object(value, 'action');
  switch (action.type) {
    case 'import_computational_receipt': {
      keys(action,['type','claimId','receipt','rationale']);
      try { parseComputationalReceipt(action.receipt); } catch(error) { throw new DomainError('INVALID_RECEIPT',error instanceof Error ? error.message : 'Invalid computational receipt.'); }
      return {type:'import_computational_receipt',claimId:text(action.claimId,'claimId',200),receipt:copy(action.receipt),rationale:text(action.rationale,'rationale')};
    }
    case 'record_doi_verification': {
      keys(action,['type','claimId','input','result']);
      return {type:'record_doi_verification',claimId:text(action.claimId,'claimId',200),input:parseDoiVerificationInput(action.input),result:copy(action.result) as DoiVerification};
    }
    case 'propose_design':
      keys(action,['type','runId','claimId','snapshotHash','resourceIds','candidates']);
      return { type: 'propose_design', runId: text(action.runId,'runId',200), claimId: text(action.claimId,'claimId',200), snapshotHash: digest(action.snapshotHash), resourceIds: strings(action.resourceIds,'resourceIds'), candidates: parseCandidates(action.candidates) };
    case 'confirm_design': {
      keys(action,['type','proposalId','selectedFields','rationale']);
      const selectedFields = strings(action.selectedFields,'selectedFields',designKeys.length) as DesignField[];
      if (new Set(selectedFields).size !== selectedFields.length || selectedFields.some(key => !designKeys.includes(key))) throw new DomainError('INVALID_DESIGN','Invalid selected fields.');
      return { type: 'confirm_design', proposalId: text(action.proposalId,'proposalId',200), selectedFields, rationale: text(action.rationale,'rationale') };
    }
    case 'pause': case 'resume': case 'run_review':
      keys(action, ['type']);
      return { type: action.type };
    case 'add_finding':
      keys(action, ['type', 'claimId', 'title', 'rationale', 'severity', 'category', 'snapshotHash', 'resourceIds', 'revisionProposal']);
      return { type: 'add_finding', claimId: text(action.claimId, 'claimId', 200), title: text(action.title, 'title', 300), rationale: text(action.rationale, 'rationale'), severity: choice(action.severity, ['info', 'warning', 'critical'] as const, 'severity'), category: choice(action.category, ['design', 'claim_scope', 'provenance', 'other'] as const, 'category'), snapshotHash: digest(action.snapshotHash), resourceIds: strings(action.resourceIds, 'resourceIds'), ...(action.revisionProposal === undefined ? {} : { revisionProposal: parseRevisionProposal(action.revisionProposal,message => { throw new DomainError('INVALID_PROPOSAL',message); }) }) };
    case 'add_claim_relation':
      keys(action,['type','sourceClaimId','targetClaimId','kind','rationale']);
      return { type: 'add_claim_relation', sourceClaimId: text(action.sourceClaimId,'sourceClaimId',200), targetClaimId: text(action.targetClaimId,'targetClaimId',200), kind: choice(action.kind,['supports','depends_on','contradicts'] as const,'relation kind'), rationale: text(action.rationale,'rationale') };
    case 'remove_claim_relation':
      keys(action,['type','relationId','rationale']);
      return { type: 'remove_claim_relation', relationId: text(action.relationId,'relationId',200), rationale: text(action.rationale,'rationale') };
    case 'set_claim_disposition':
      keys(action,['type','claimId','disposition','rationale']);
      return { type: 'set_claim_disposition', claimId: text(action.claimId,'claimId',200), disposition: choice(action.disposition,['active','rejected'] as const,'disposition'), rationale: text(action.rationale,'rationale') };
    case 'acknowledge_re_review':
      keys(action,['type','claimId','rationale']);
      return { type: 'acknowledge_re_review', claimId: text(action.claimId,'claimId',200), rationale: text(action.rationale,'rationale') };
    case 'apply_revision_proposal':
      keys(action,['type','findingId','acceptText','acceptScope','evidenceNeedIds','rationale']);
      if (typeof action.acceptText !== 'boolean' || typeof action.acceptScope !== 'boolean') throw new DomainError('INVALID_PROPOSAL','Proposal selections must be booleans.');
      return { type: 'apply_revision_proposal', findingId: text(action.findingId,'findingId',200), acceptText: action.acceptText, acceptScope: action.acceptScope, evidenceNeedIds: strings(action.evidenceNeedIds,'evidenceNeedIds',20), rationale: text(action.rationale,'rationale') };
    case 'link_evidence_requirement':
      keys(action,['type','claimId','requirementId','resourceIds','rationale']);
      return { type: 'link_evidence_requirement', claimId: text(action.claimId,'claimId',200), requirementId: text(action.requirementId,'requirementId',200), resourceIds: strings(action.resourceIds,'resourceIds',30), rationale: text(action.rationale,'rationale') };
    case 'intervene': {
      keys(action, ['type', 'findingId', 'decision', 'rationale', 'conditions']);
      const conditions = action.conditions === undefined ? [] : strings(action.conditions, 'conditions', 20);
      const decision = choice(action.decision, ['challenge', 'dismiss', 'defer', 'accept_with_limits'] as const, 'decision');
      if (decision === 'accept_with_limits' && conditions.length === 0) throw new DomainError('CONDITIONS_REQUIRED', 'Acceptance with limits requires at least one explicit condition.');
      return { type: 'intervene', findingId: text(action.findingId, 'findingId', 200), decision, rationale: text(action.rationale, 'rationale'), conditions };
    }
    case 'create_claim': {
      keys(action, ['type', 'text', 'scope', 'metadata', 'rationale']);
      return { type: 'create_claim', text: text(action.text, 'claim text', 16000), scope: choice(action.scope, ['sample', 'cohort', 'population', 'causal'] as const, 'scope'), rationale: text(action.rationale, 'rationale'), ...(action.metadata === undefined ? {} : { metadata: parseMetadata(action.metadata) }) };
    }
    case 'revise_claim': {
      keys(action, ['type', 'claimId', 'text', 'scope', 'metadata', 'rationale']);
      const result: ReviewAction = { type: 'revise_claim', claimId: text(action.claimId, 'claimId', 200), text: text(action.text, 'claim text', 16000), rationale: text(action.rationale, 'rationale') };
      if (action.scope !== undefined) result.scope = choice(action.scope, ['sample', 'cohort', 'population', 'causal'] as const, 'scope');
      if (action.metadata !== undefined) result.metadata = parseMetadata(action.metadata);
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
  // Keep the original input-envelope tag to verify legacy hashes unchanged.
  // The rule implementation actually executed is recorded per MetadataReview.
  return {
    projectId: state.projectId, claims: copy(state.claims), rulesVersion: 'metadata-checks.v1',
    resourceRefs: state.resources.map(({ content: _content, ...reference }) => copy(reference)),
    ...(state.claimRelations === undefined ? {} : { claimRelations: copy(state.claimRelations) }),
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
function appendEvent(state: ReviewState, action: AuditEvent['action'], actor: Actor, beforeSnapshotHash?: string): void {
  const unsigned = { id: randomUUID(), revision: state.revision, at: new Date().toISOString(), actor: copy(actor), action: copy(action), previousHash: state.events.at(-1)?.hash ?? null, stateHash: stateDigest(state), ...(beforeSnapshotHash === undefined ? {} : { beforeSnapshotHash, afterSnapshotHash: state.snapshotHash }) };
  state.events.push({ ...unsigned, hash: hash(unsigned) });
}

function flagDependants(state: ReviewState, sourceClaimId: string, claimIds: string[], reason: string, revision: number): void {
  for (const claimId of new Set(claimIds)) {
    if (state.reReview?.some(item => item.claimId === claimId && item.sourceClaimId === sourceClaimId && item.status === 'pending')) continue;
    (state.reReview ??= []).push({ claimId, sourceClaimId, reason, createdRevision: revision, status: 'pending' });
  }
}
function requirementExists(state: ReviewState, claim: Claim, id: string): boolean {
  return evidencePlan(state,claim.id).some(item => item.id === id && item.linkable);
}
function review(state: ReviewState, revision = state.revision): void {
  if (state.reviewStatus === 'paused') throw new DomainError('REVIEW_PAUSED', 'Resume review before running checks or admitting reviewer suggestions.', 409);
  const checks = state.claims.flatMap(assessClaim);
  for (const finding of state.findings) {
    if (finding.source === 'deterministic_check' && finding.status === 'active' && finding.rulesVersion !== METADATA_RULES_VERSION) {
      finding.status = 'stale';
      for (const decision of state.decisions) if (decision.findingId === finding.id) decision.status = 'stale';
    }
  }
  for (const check of checks.filter(item => item.outcome === 'flagged')) {
    const existing = state.findings.some(item => item.status === 'active' && isClaimSnapshotCurrent(state,item.claimId,item.snapshotHash) && item.claimId === check.claimId && item.ruleId === check.ruleId && item.rulesVersion === METADATA_RULES_VERSION);
    if (!existing) state.findings.push({ id: randomUUID(), claimId: check.claimId, title: check.title, rationale: `${check.rationale}\n建议：${check.nextStep}${check.declared.basis ? `\n研究者填写的依据（未核验）：${check.declared.basis}` : '\n未提供手填依据；如来自确认候选，请核对提取历史中的原始摘录。声明尚未独立核验。'}`, severity: check.severity, category: check.category, resourceIds: [], ruleId: check.ruleId, rulesVersion: METADATA_RULES_VERSION, source: 'deterministic_check', snapshotHash: state.snapshotHash, status: 'active' });
  }
  (state.metadataReviews ??= []).push({ rulesVersion: METADATA_RULES_VERSION, snapshotHash: state.snapshotHash, revision, checkedAt: new Date().toISOString(), checks });
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
    for (const resource of state.resources) {
      if (resource.sha256 !== contentHash(resource.content)) throw new Error('resource digest mismatch');
      if (resource.evidenceKind === 'computational_receipt') {
        if (resource.doiVerification !== undefined || canonical(parseComputationalReceipt(JSON.parse(resource.content))) !== canonical(resource.computationReceipt)) throw new Error('computational receipt differs from supplied bytes');
        if (!state.events.some(event=> { const action=event.action; return action.type==='import_computational_receipt' && event.actor.kind==='researcher' && state.claims.find(claim=>claim.id===action.claimId)?.resourceIds.includes(resource.id) && canonical(action.receipt)===canonical(JSON.parse(resource.content)); })) throw new Error('computational receipt has no import event');
      } else if (resource.evidenceKind === 'doi_verification') {
        if (resource.computationReceipt !== undefined || !resource.doiVerification || resource.doiVerification.schemaVersion !== 'locus.doi-verification.v1' || canonical(JSON.parse(resource.content)) !== canonical(resource.doiVerification)) throw new Error('invalid DOI verification resource');
        assertDoiVerification(resource.doiVerification);
        if (!state.events.some(event=> { const action=event.action; return action.type==='record_doi_verification' && event.actor.id==='system:doi-registry' && event.actor.kind==='agent' && canonical(action.result)===canonical(resource.doiVerification) && canonical({doi:action.input.doi,mode:action.input.mode??'registry',expected:action.input.expected??{}})===canonical({doi:action.result.doi,mode:action.result.mode,expected:action.result.expected}) && state.claims.find(claim=>claim.id===action.claimId)?.resourceIds.includes(resource.id); })) throw new Error('DOI check has no server lookup event');
      } else if (resource.evidenceKind !== undefined || resource.computationReceipt !== undefined || resource.doiVerification !== undefined) throw new Error('invalid evidence kind');
    }
    for (const claim of state.claims) {
      if (claim.evidenceCeiling !== 'NOT_ASSESSED' || claim.resourceIds.some(id => !resourceIds.has(id))) throw new Error('invalid claim boundary or reference');
      parseMetadata(claim.metadata);
      if (claim.disposition !== undefined && !['active','rejected'].includes(claim.disposition)) throw new Error('invalid claim disposition');
      if (claim.evidenceNeeds !== undefined) {
        if (!Array.isArray(claim.evidenceNeeds) || new Set(claim.evidenceNeeds.map(item => `${item.findingId}:${item.id}`)).size !== claim.evidenceNeeds.length) throw new Error('invalid accepted evidence needs');
        for (const need of claim.evidenceNeeds) {
          const finding = state.findings.find(item => item.id === need.findingId && item.claimId === claim.id);
          const source = finding?.revisionProposal?.evidenceNeeds?.find(item => item.id === need.id);
          if (!source || canonical(need) !== canonical({ ...source, findingId: finding!.id }) || !state.revisionAdoptions?.some(item => item.findingId === finding!.id && item.evidenceNeedIds.includes(need.id))) throw new Error('unbound accepted evidence need');
        }
      }
    }
    if (state.claimRelations !== undefined) {
      if (!Array.isArray(state.claimRelations)) throw new Error('invalid claim relations');
      validateClaimRelations(state.claimRelations,state.claims);
      for (const relation of state.claimRelations) if (!state.events.some(event => event.action.type === 'add_claim_relation' && event.action.sourceClaimId === relation.sourceClaimId && event.action.targetClaimId === relation.targetClaimId && event.action.kind === relation.kind && event.action.rationale === relation.rationale && state.snapshots.find(item => item.hash === event.afterSnapshotHash)?.claimRelations?.some(item => canonical(item) === canonical(relation)))) throw new Error('unbound claim relation');
    }
    if (snapshot(state) !== state.snapshotHash) throw new Error('snapshot digest mismatch');
    const snapshotHashes = new Set<string>();
    for (const preserved of state.snapshots) {
      const { hash: preservedHash, ...payload } = preserved;
      if (hash(payload) !== preservedHash || snapshotHashes.has(preservedHash)) throw new Error('historical snapshot mismatch');
      if (preserved.projectId !== state.projectId || preserved.rulesVersion !== 'metadata-checks.v1') throw new Error('invalid historical snapshot scope');
      if (preserved.claimRelations !== undefined) validateClaimRelations(preserved.claimRelations,preserved.claims);
      for (const reference of preserved.resourceRefs) {
        const resource = state.resources.find(item => item.id === reference.id);
        if (!resource || resource.sha256 !== reference.sha256) throw new Error('historical snapshot resource missing');
      }
      snapshotHashes.add(preservedHash);
    }
    if (!snapshotHashes.has(state.snapshotHash)) throw new Error('current snapshot not retained');
    if (state.metadataReviews !== undefined) {
      if (!Array.isArray(state.metadataReviews)) throw new Error('invalid metadata review history');
      const reviewRevisions = new Set<number>();
      for (const report of state.metadataReviews) {
        const source = state.snapshots.find(item => item.hash === report.snapshotHash);
        const event = state.events[report.revision];
        if (!['metadata-checks.v2',METADATA_RULES_VERSION].includes(report.rulesVersion) || !Number.isSafeInteger(report.revision) || reviewRevisions.has(report.revision) || !source || !event || !['fixture_created', 'run_review'].includes(event.action.type) || !Number.isFinite(Date.parse(report.checkedAt))) throw new Error('invalid metadata review binding');
        const expected = report.rulesVersion === 'metadata-checks.v2' ? source.claims.flatMap(claim => assessClaimV2(claim as Parameters<typeof assessClaimV2>[0])) : source.claims.flatMap(assessClaim);
        if (canonical(expected) !== canonical(report.checks)) throw new Error('metadata review does not match frozen declarations');
        reviewRevisions.add(report.revision);
      }
    }
    if (state.designProposals !== undefined) {
      if (!Array.isArray(state.designProposals) || new Set(state.designProposals.map(p => p.id)).size !== state.designProposals.length) throw new Error('invalid design proposals');
      for (const proposal of state.designProposals) {
        validateProposalEvidence(state,proposal);
        const event = state.events[proposal.createdRevision];
        if (!event || event.action.type !== 'propose_design' || event.action.runId !== proposal.runId || canonical(event.action.candidates) !== canonical(proposal.candidates) || event.action.snapshotHash !== proposal.snapshotHash || event.action.claimId !== proposal.claimId || canonical(event.action.resourceIds) !== canonical(proposal.resourceIds)) throw new Error('invalid proposal audit binding');
        if (!['proposed','confirmed','rejected','stale'].includes(proposal.status) || (proposal.status === 'proposed' && !isClaimSnapshotCurrent(state,proposal.claimId,proposal.snapshotHash))) throw new Error('invalid proposal status');
        if (['confirmed','rejected'].includes(proposal.status)) {
          const action = state.events[proposal.resolvedRevision!]?.action;
          if (!action || action.type !== 'confirm_design' || action.proposalId !== proposal.id || canonical(action.selectedFields) !== canonical(proposal.selectedFields) || (proposal.status === 'confirmed') !== !!action.selectedFields.length) throw new Error('invalid confirmation binding');
        }
      }
    }
    const findingIds = new Set(state.findings.map(finding => finding.id));
    if (findingIds.size !== state.findings.length) throw new Error('duplicate finding ids');
    for (const finding of state.findings) {
      if (!claimIds.has(finding.claimId) || finding.resourceIds.some(id => !resourceIds.has(id)) || !snapshotHashes.has(finding.snapshotHash)) throw new Error('invalid finding reference');
      if (!['active', 'stale'].includes(finding.status) || (finding.status === 'active' && !isClaimSnapshotCurrent(state,finding.claimId,finding.snapshotHash))) throw new Error('invalid finding snapshot');
      if (finding.revisionProposal !== undefined) {
        parseRevisionProposal(finding.revisionProposal);
        if (finding.source !== 'agent_suggestion' || !state.events.some(event => event.action.type === 'add_finding' && event.action.claimId === finding.claimId && event.action.snapshotHash === finding.snapshotHash && event.action.title === finding.title && event.action.rationale === finding.rationale && event.action.revisionProposal !== undefined && canonical(event.action.revisionProposal) === canonical(finding.revisionProposal))) throw new Error('unbound revision proposal');
      }
    }
    for (const decision of state.decisions) {
      if (!findingIds.has(decision.findingId) || decision.actorOrigin !== 'researcher' || decision.identityVerification !== 'DECLARED_NOT_AUTHENTICATED') throw new Error('invalid decision');
      const finding = state.findings.find(item => item.id === decision.findingId)!;
      if (finding.claimId !== decision.claimId || !snapshotHashes.has(decision.snapshotHash) || !['current', 'stale'].includes(decision.status) || (decision.status === 'current' && (finding.status !== 'active' || !isClaimSnapshotCurrent(state,decision.claimId,decision.snapshotHash)))) throw new Error('invalid decision snapshot');
    }
    if (state.revisionAdoptions !== undefined) {
      if (!Array.isArray(state.revisionAdoptions) || new Set(state.revisionAdoptions.map(item => item.id)).size !== state.revisionAdoptions.length || new Set(state.revisionAdoptions.map(item => item.revision)).size !== state.revisionAdoptions.length) throw new Error('invalid revision adoptions');
      const applied = new Map<string,{ text: boolean; scope: boolean; evidence: Set<string> }>();
      let previousRevision = -1;
      for (const adoption of state.revisionAdoptions) {
        const finding = state.findings.find(item => item.id === adoption.findingId); const proposal = finding?.revisionProposal;
        const event = state.events[adoption.revision]; const action = event?.action;
        if (!proposal || !event || event.actor.kind !== 'researcher' || action?.type !== 'apply_revision_proposal' || action.findingId !== adoption.findingId || action.acceptText !== adoption.acceptText || action.acceptScope !== adoption.acceptScope || action.rationale !== adoption.rationale || canonical(action.evidenceNeedIds) !== canonical(adoption.evidenceNeedIds) || !snapshotHashes.has(adoption.snapshotHash) || event.beforeSnapshotHash !== adoption.snapshotHash || adoption.revision <= previousRevision) throw new Error('invalid adoption audit binding');
        const previous = applied.get(finding!.id) ?? { text: false, scope: false, evidence: new Set<string>() };
        if ((!adoption.acceptText && !adoption.acceptScope && !adoption.evidenceNeedIds.length) || (adoption.acceptText && (previous.text || proposal.text === undefined)) || (adoption.acceptScope && (previous.scope || proposal.scope === undefined)) || new Set(adoption.evidenceNeedIds).size !== adoption.evidenceNeedIds.length || adoption.evidenceNeedIds.some(id => previous.evidence.has(id) || !proposal.evidenceNeeds?.some(need => need.id === id))) throw new Error('invalid or repeated proposal adoption');
        const before = copy(state.snapshots.find(item => item.hash === adoption.snapshotHash)!);
        const target = before.claims.find(item => item.id === finding!.claimId)!;
        if (adoption.acceptText) target.text = proposal.text!;
        if (adoption.acceptScope) target.scope = proposal.scope!;
        for (const need of proposal.evidenceNeeds ?? []) if (adoption.evidenceNeedIds.includes(need.id)) (target.evidenceNeeds ??= []).push({ ...copy(need), findingId: finding!.id });
        const { hash: _beforeHash, ...expectedPayload } = before;
        if (hash(expectedPayload) !== event.afterSnapshotHash) throw new Error('adoption does not match selected proposal fields');
        for (const id of adoption.evidenceNeedIds) {
          if (!state.claims.find(item => item.id === finding!.claimId)?.evidenceNeeds?.some(item => item.id === id && item.findingId === finding!.id)) throw new Error('accepted evidence need missing');
          previous.evidence.add(id);
        }
        previous.text ||= adoption.acceptText; previous.scope ||= adoption.acceptScope; applied.set(finding!.id,previous); previousRevision = adoption.revision;
      }
    }
    if (state.reReview !== undefined) {
      if (!Array.isArray(state.reReview)) throw new Error('invalid re-review flags');
      const pending = new Set<string>();
      for (const flag of state.reReview) {
        const event = state.events[flag.createdRevision]; const action = event?.action;
        if (!claimIds.has(flag.claimId) || !claimIds.has(flag.sourceClaimId) || flag.claimId === flag.sourceClaimId || !event || typeof flag.reason !== 'string' || !flag.reason.trim() || !['pending','acknowledged'].includes(flag.status)) throw new Error('invalid re-review flag');
        const eventSource = action?.type === 'add_claim_relation' ? action.sourceClaimId : action?.type === 'remove_claim_relation' ? state.snapshots.find(item => item.hash === event.beforeSnapshotHash)?.claimRelations?.find(item => item.id === action.relationId)?.sourceClaimId : action?.type === 'confirm_design' ? state.designProposals?.find(item => item.id === action.proposalId)?.claimId : action?.type === 'apply_revision_proposal' ? state.findings.find(item => item.id === action.findingId)?.claimId : action && 'claimId' in action ? action.claimId : undefined;
        if (eventSource !== flag.sourceClaimId) throw new Error('re-review flag source does not match audit');
        const before = state.snapshots.find(item => item.hash === event.beforeSnapshotHash); const after = state.snapshots.find(item => item.hash === event.afterSnapshotHash);
        if (!before || !after) throw new Error('missing re-review input snapshots');
        let affected: string[];
        if (action?.type === 'add_claim_relation') affected = action.kind === 'depends_on' ? [action.targetClaimId,...dependencyDescendants(after.claimRelations ?? [],action.targetClaimId)] : [];
        else if (action?.type === 'remove_claim_relation') {
          const relation = before.claimRelations?.find(item => item.id === action.relationId);
          affected = relation?.kind === 'depends_on' ? [relation.targetClaimId,...dependencyDescendants(before.claimRelations ?? [],relation.targetClaimId)] : [];
        } else affected = claimInputSignature(before,flag.sourceClaimId) !== claimInputSignature(after,flag.sourceClaimId) ? dependencyDescendants(after.claimRelations ?? [],flag.sourceClaimId) : [];
        if (!affected.includes(flag.claimId)) throw new Error('re-review flag is outside affected dependency closure');
        if (flag.status === 'pending') { const key = `${flag.claimId}:${flag.sourceClaimId}`; if (pending.has(key) || flag.resolvedRevision !== undefined) throw new Error('duplicate or resolved pending re-review'); pending.add(key); }
        else {
          const resolution = state.events[flag.resolvedRevision!];
          if (!resolution || resolution.revision <= flag.createdRevision || resolution.actor.kind !== 'researcher' || resolution.action.type !== 'acknowledge_re_review' || resolution.action.claimId !== flag.claimId || resolution.action.rationale !== flag.rationale) throw new Error('invalid re-review acknowledgement');
        }
      }
    }
    if (state.evidenceLinks !== undefined) {
      if (!Array.isArray(state.evidenceLinks) || new Set(state.evidenceLinks.map(item => item.revision)).size !== state.evidenceLinks.length) throw new Error('invalid evidence links');
      for (const link of state.evidenceLinks) {
        const event = state.events[link.revision]; const action = event?.action; const claim = state.snapshots.find(item => item.hash === link.snapshotHash)?.claims.find(item => item.id === link.claimId);
        if (!claim || !event || event.actor.kind !== 'researcher' || action?.type !== 'link_evidence_requirement' || action.claimId !== link.claimId || action.requirementId !== link.requirementId || action.rationale !== link.rationale || canonical(action.resourceIds) !== canonical(link.resourceIds) || event.beforeSnapshotHash !== link.snapshotHash || link.resourceIds.some(id => !claim.resourceIds.includes(id))) throw new Error('invalid evidence link binding');
      }
    }
    let previousHash: string | null = null;
    for (const [revision, event] of state.events.entries()) {
      const { hash: eventHash, ...unsigned } = event;
      if (event.revision !== revision || event.previousHash !== previousHash || hash(unsigned) !== eventHash) throw new Error('audit chain mismatch');
      if (event.beforeSnapshotHash !== undefined || event.afterSnapshotHash !== undefined) {
        if (!snapshotHashes.has(event.beforeSnapshotHash!) || !snapshotHashes.has(event.afterSnapshotHash!) || (revision > 0 && state.events[revision-1]!.afterSnapshotHash !== undefined && state.events[revision-1]!.afterSnapshotHash !== event.beforeSnapshotHash)) throw new Error('event snapshot binding mismatch');
      }
      previousHash = eventHash;
    }
    if (state.events.at(-1)?.afterSnapshotHash !== undefined && state.events.at(-1)!.afterSnapshotHash !== state.snapshotHash) throw new Error('latest event snapshot differs from current inputs');
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
    return this.execute(input,expectedRevision,actorInput,false);
  }
  /** Only this method may persist registry results; caller-supplied reports are never trusted. */
  async verifyDoi(claimId: string, input: DoiVerificationInput, expectedRevision: number, options?: Parameters<typeof verifyDoi>[1]): Promise<ReviewState> {
    const before=this.getState();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision!==before.revision) throw new DomainError('REVISION_CONFLICT','Read current state before verifying a citation.',409);
    if (!before.claims.some(claim=>claim.id===claimId)) throw new DomainError('NOT_FOUND','Claim does not exist.',404);
    if (before.reviewStatus==='paused') throw new DomainError('REVIEW_PAUSED','Resume review before verifying a citation.',409);
    let parsed:DoiVerificationInput;
    try {parsed=parseDoiVerificationInput(input);} catch (error) {throw new DomainError('INVALID_DOI_INPUT',String(error));}
    const result=await verifyDoi(parsed,options);
    return this.execute({type:'record_doi_verification',claimId,input:parsed,result},expectedRevision,{kind:'agent',id:'system:doi-registry'},true);
  }
  private execute(input: unknown, expectedRevision: number, actorInput: Actor, internalDoi: boolean): ReviewState {
    const action = parseAction(input);
    const actor = parseActor(actorInput);
    if (action.type==='record_doi_verification' && !internalDoi) throw new DomainError('SERVER_VERIFICATION_REQUIRED','DOI results must come from the registry verification operation; supplied reports cannot claim verification.',403);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new DomainError('INVALID_REVISION', 'expectedRevision must be a nonnegative safe integer.');
    return this.lock(() => {
      const current = this.filePath ? this.read() : this.state;
      if (current.revision !== expectedRevision) throw new DomainError('REVISION_CONFLICT', `Review changed: expected revision ${expectedRevision}, current revision ${current.revision}. Refresh before continuing.`, 409);
      if (actor.kind !== 'researcher' && !['run_review', 'add_finding', 'propose_design'].includes(action.type) && !(internalDoi && action.type==='record_doi_verification')) throw new DomainError('RESEARCHER_REQUIRED', 'This action requires a researcher interaction from the trusted UI boundary.', 403);
      const next = copy(current);
      const relationImpacts: Array<{ sourceClaimId: string; claimIds: string[]; reason: string }> = [];
      const claim = 'claimId' in action ? next.claims.find(item => item.id === action.claimId) : undefined;
      if ('claimId' in action && !claim) throw new DomainError('NOT_FOUND', 'Claim does not exist.', 404);
      switch (action.type) {
        case 'import_computational_receipt': case 'record_doi_verification': {
          if (action.type==='record_doi_verification' && next.reviewStatus==='paused') throw new DomainError('REVIEW_PAUSED','Review was paused during citation lookup.',409);
          const content=JSON.stringify(action.type==='import_computational_receipt' ? action.receipt : action.result);
          if (next.resources.length>=100 || next.resources.reduce((sum,item)=>sum+Buffer.byteLength(item.content,'utf8'),0)+Buffer.byteLength(content,'utf8')>24*1024*1024) throw new DomainError('RESOURCE_LIMIT','Workspace evidence exceeds 100 resources or 24 MiB of stored payloads.',413);
          const resource:Resource={id:randomUUID(),name:action.type==='import_computational_receipt'?'computational-receipt.json':'doi-verification.json',mediaType:'application/json',content,sha256:contentHash(content),sourceKind:action.type==='import_computational_receipt'?'user_upload':'host_resource'};
          if (action.type==='import_computational_receipt') {resource.evidenceKind='computational_receipt';resource.computationReceipt=parseComputationalReceipt(action.receipt);}
          else {resource.evidenceKind='doi_verification';resource.doiVerification=copy(action.result);}
          next.resources.push(resource); claim!.resourceIds.push(resource.id); break;
        }
        case 'propose_design': {
          if (actor.kind !== 'agent') throw new DomainError('AGENT_REQUIRED','Only the extraction channel may submit candidates.');
          if (next.reviewStatus === 'paused') throw new DomainError('REVIEW_PAUSED','Paused review does not admit candidates.',409);
          if (action.snapshotHash !== next.snapshotHash) throw new DomainError('STALE_SNAPSHOT','Extraction targets outdated materials.',409);
          if (next.designProposals?.some(item => item.runId === action.runId)) throw new DomainError('DESIGN_ALREADY_SUBMITTED','This request already has a saved proposal. Read it before retrying.',409);
          validateProposalEvidence(next,action);
          (next.designProposals ??= []).push({ id: randomUUID(), runId: action.runId, claimId: action.claimId, snapshotHash: action.snapshotHash, resourceIds: [...action.resourceIds], candidates: copy(action.candidates), status: 'proposed', createdRevision: next.revision+1, createdAt: new Date().toISOString() });
          break;
        }
        case 'confirm_design': {
          const proposal = next.designProposals?.find(item => item.id === action.proposalId);
          if (!proposal || proposal.status !== 'proposed' || !isClaimSnapshotCurrent(next,proposal.claimId,proposal.snapshotHash)) throw new DomainError('STALE_PROPOSAL','Candidate proposal is absent, resolved or stale.',409);
          if (action.selectedFields.some(key => !proposal.candidates.some(candidate => candidate.field === key))) throw new DomainError('INVALID_DESIGN','Selection includes an unproposed field.');
          const target = next.claims.find(item => item.id === proposal.claimId)!;
          const metadata: Record<string,unknown> = { ...target.metadata };
          for (const candidate of proposal.candidates) if (action.selectedFields.includes(candidate.field)) metadata[candidate.field] = candidate.value;
          if (metadata.figureApplicable === false && !action.selectedFields.includes('figureSourceMatched')) metadata.figureSourceMatched = NOT_DECLARED;
          if (action.selectedFields.length) target.metadata = parseMetadata(metadata);
          proposal.status = action.selectedFields.length ? 'confirmed' : 'rejected';
          proposal.selectedFields = [...action.selectedFields]; proposal.resolvedRevision = next.revision+1;
          break;
        }
        case 'pause': next.reviewStatus = 'paused'; break;
        case 'resume': next.reviewStatus = 'active'; break;
        case 'run_review': review(next, next.revision + 1); break;
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
          if (finding.status !== 'active' || !isClaimSnapshotCurrent(next,finding.claimId,finding.snapshotHash)) throw new DomainError('STALE_SNAPSHOT', 'This finding belongs to an older claim or dependency snapshot. Re-run review before recording a decision.', 409);
          next.decisions.push({ id: randomUUID(), findingId: finding.id, claimId: finding.claimId, decision: action.decision, rationale: action.rationale, conditions: action.conditions ?? [], actorId: actor.id, actorOrigin: 'researcher', identityVerification: 'DECLARED_NOT_AUTHENTICATED', at: new Date().toISOString(), snapshotHash: next.snapshotHash, status: 'current' });
          break;
        }
        case 'add_claim_relation': {
          const relation: ClaimRelation = { id: randomUUID(), sourceClaimId: action.sourceClaimId, targetClaimId: action.targetClaimId, kind: action.kind, rationale: action.rationale };
          try { validateClaimRelations([...(next.claimRelations ?? []),relation],next.claims); }
          catch (error) { throw new DomainError('INVALID_RELATION',error instanceof Error ? error.message : 'Invalid relation.'); }
          (next.claimRelations ??= []).push(relation);
          if (relation.kind === 'depends_on') relationImpacts.push({ sourceClaimId: relation.sourceClaimId, claimIds: [relation.targetClaimId,...dependencyDescendants(next.claimRelations,relation.targetClaimId)], reason: '依赖关系新增，请核对下游论断是否仍受上游证据支持。' });
          break;
        }
        case 'remove_claim_relation': {
          const relation = next.claimRelations?.find(item => item.id === action.relationId);
          if (!relation) throw new DomainError('NOT_FOUND','Claim relation does not exist.',404);
          if (relation.kind === 'depends_on') relationImpacts.push({ sourceClaimId: relation.sourceClaimId, claimIds: [relation.targetClaimId,...dependencyDescendants(next.claimRelations ?? [],relation.targetClaimId)], reason: '依赖关系已移除，请重审原下游论断的支持基础。' });
          next.claimRelations = next.claimRelations!.filter(item => item.id !== action.relationId);
          break;
        }
        case 'set_claim_disposition': claim!.disposition = action.disposition; break;
        case 'acknowledge_re_review': {
          const pending = next.reReview?.filter(item => item.claimId === action.claimId && item.status === 'pending') ?? [];
          if (!pending.length) throw new DomainError('NO_RE_REVIEW','This claim has no pending dependency review.',409);
          for (const flag of pending) { flag.status = 'acknowledged'; flag.resolvedRevision = next.revision+1; flag.rationale = action.rationale; }
          break;
        }
        case 'apply_revision_proposal': {
          const finding = next.findings.find(item => item.id === action.findingId);
          if (!finding?.revisionProposal) throw new DomainError('INVALID_PROPOSAL','Finding has no revision proposal.');
          const available = proposalAvailability(next,finding);
          if (!available.available) throw new DomainError('STALE_PROPOSAL',available.reason ?? 'Proposal cannot be applied.',409);
          if ((!action.acceptText && !action.acceptScope && !action.evidenceNeedIds.length) || (action.acceptText && !available.text) || (action.acceptScope && !available.scope) || action.evidenceNeedIds.some(id => !available.evidenceNeedIds.includes(id))) throw new DomainError('INVALID_PROPOSAL','Select only unapplied items from this proposal.');
          const target = next.claims.find(item => item.id === finding.claimId)!;
          if (action.acceptText) target.text = finding.revisionProposal.text!;
          if (action.acceptScope) target.scope = finding.revisionProposal.scope!;
          for (const need of finding.revisionProposal.evidenceNeeds ?? []) if (action.evidenceNeedIds.includes(need.id)) (target.evidenceNeeds ??= []).push({ ...copy(need), findingId: finding.id });
          (next.revisionAdoptions ??= []).push({ id: randomUUID(), findingId: finding.id, acceptText: action.acceptText, acceptScope: action.acceptScope, evidenceNeedIds: [...action.evidenceNeedIds], rationale: action.rationale, revision: next.revision+1, snapshotHash: next.snapshotHash });
          break;
        }
        case 'link_evidence_requirement': {
          if (!requirementExists(next,claim!,action.requirementId)) throw new DomainError('INVALID_REQUIREMENT','This requirement is not currently part of the claim evidence plan.');
          if (action.resourceIds.some(id => !claim!.resourceIds.includes(id))) throw new DomainError('INVALID_REFERENCE','Requirement resources must be attached to the selected claim.');
          (next.evidenceLinks ??= []).push({ claimId: action.claimId, requirementId: action.requirementId, resourceIds: [...action.resourceIds], rationale: action.rationale, revision: next.revision+1, snapshotHash: next.snapshotHash });
          break;
        }
        case 'revise_claim':
          claim!.text = action.text;
          if (action.scope !== undefined) claim!.scope = action.scope;
          // Omitted metadata preserves declarations; a supplied object replaces
          // them completely, so {} explicitly resets all fields to unknown.
          if (action.metadata !== undefined) claim!.metadata = copy(action.metadata);
          break;
        case 'create_claim':
          if (next.claims.length >= 100) throw new DomainError('CLAIM_LIMIT', 'This prototype supports at most 100 claims.', 413);
          next.claims.push({ id: randomUUID(), text: action.text, scope: action.scope, resourceIds: [], metadata: copy(action.metadata ?? {}), evidenceCeiling: 'NOT_ASSESSED' });
          break;
        case 'attach_evidence': {
          if (next.resources.length >= 100) throw new DomainError('RESOURCE_LIMIT', 'This prototype supports at most 100 resources.', 413);
          if (next.resources.reduce((total, item) => total + Buffer.byteLength(item.content,'utf8'), 0) + Buffer.byteLength(action.content,'utf8') > 24*1024*1024) throw new DomainError('RESOURCE_LIMIT', 'Workspace evidence exceeds the 24 MiB stored payload budget.', 413);
          const resource: Resource = { id: randomUUID(), name: action.name, mediaType: action.mediaType, content: action.content, sha256: contentHash(action.content), sourceKind: action.sourceKind ?? 'user_upload' };
          if (action.sourceUri !== undefined) resource.sourceUri = action.sourceUri;
          next.resources.push(resource);
          claim!.resourceIds.push(resource.id);
          break;
        }
      }
      const nextSnapshot = snapshot(next);
      if (nextSnapshot !== next.snapshotHash) {
        const previousSnapshot = next.snapshotHash;
        next.snapshotHash = nextSnapshot;
        preserveSnapshot(next);
        for (const finding of next.findings) if (!isClaimSnapshotCurrent(next,finding.claimId,finding.snapshotHash)) finding.status = 'stale';
        for (const decision of next.decisions) if (!isClaimSnapshotCurrent(next,decision.claimId,decision.snapshotHash)) decision.status = 'stale';
        for (const proposal of next.designProposals ?? []) if (proposal.status === 'proposed' && !isClaimSnapshotCurrent(next,proposal.claimId,proposal.snapshotHash)) proposal.status = 'stale';
        // A relation edit has its own exact target closure; do not label every
        // affected descendant as another causal source of the same change.
        if (!['add_claim_relation','remove_claim_relation'].includes(action.type)) {
          const sourceIds = action.type === 'confirm_design' ? [next.designProposals!.find(item => item.id === action.proposalId)!.claimId] : action.type === 'apply_revision_proposal' ? [next.findings.find(item => item.id === action.findingId)!.claimId] : 'claimId' in action ? [action.claimId] : [];
          for (const sourceId of sourceIds) if (!isClaimSnapshotCurrent(next,sourceId,previousSnapshot)) flagDependants(next,sourceId,dependencyDescendants(next.claimRelations ?? [],sourceId),action.type === 'set_claim_disposition' && action.disposition === 'rejected' ? '上游论断已被驳回，请重审依赖该论断的结论。' : '上游论断、范围或证据已改变，请局部重审依赖该论断的结论。',next.revision+1);
        }
      }
      for (const impact of relationImpacts) flagDependants(next,impact.sourceClaimId,impact.claimIds,impact.reason,next.revision+1);
      next.revision += 1;
      appendEvent(next, action, actor, current.snapshotHash);
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
