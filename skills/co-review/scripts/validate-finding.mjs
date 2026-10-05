import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

export function validate({ state, request, finding } = {}) {
  const errors = [];
  if (!state || !request || !finding) return ['state, request and finding are required'];
  if (state.reviewStatus !== 'active') errors.push('review is paused');
  if (!['queued', 'working', 'needs_input'].includes(request.phase)) errors.push('request is closed');
  if (!request.sessionId || finding.sessionId !== request.sessionId || finding.runId !== request.id) errors.push('request/session mismatch');
  if (finding.expectedRevision !== state.revision) errors.push('revision mismatch');
  // Requests may survive unrelated edits; the server validates their retained
  // claim/dependency history. This standalone helper checks the latest input
  // hash and selected references, never grants callback admission by itself.
  if (!/^[a-f0-9]{64}$/.test(finding.snapshotHash ?? '') || finding.snapshotHash !== state.snapshotHash) errors.push('snapshot mismatch');
  const claim = state.claims?.find(c => c.id === finding.claimId);
  if (!claim || finding.claimId !== request.claimId) errors.push('claim mismatch');
  if (!Array.isArray(finding.resourceIds) || finding.resourceIds.length > 100 || new Set(finding.resourceIds).size !== finding.resourceIds.length || finding.resourceIds.some(id => !request.resourceIds?.includes(id) || !claim?.resourceIds?.includes(id))) errors.push('resources outside selection or duplicated');
  for (const [key, max] of [['title', 300], ['rationale', 8000]]) if (typeof finding[key] !== 'string' || !finding[key].trim() || finding[key].length > max || finding[key].includes('\0')) errors.push(`invalid ${key}`);
  if (!['info', 'warning', 'critical'].includes(finding.severity)) errors.push('invalid severity');
  if (!['design', 'claim_scope', 'provenance', 'other'].includes(finding.category)) errors.push('invalid category');
  const proposal = finding.revisionProposal;
  if (proposal !== undefined) {
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) errors.push('invalid revisionProposal');
    else {
      if (Object.keys(proposal).some(key => !['text','scope','evidenceNeeds'].includes(key))) errors.push('unexpected proposal fields');
      if (proposal.text !== undefined && (typeof proposal.text !== 'string' || !proposal.text.trim() || proposal.text.length > 16000 || proposal.text.includes('\0'))) errors.push('invalid proposal text');
      if (proposal.scope !== undefined && !['sample','cohort','population','causal'].includes(proposal.scope)) errors.push('invalid proposal scope');
      if (proposal.evidenceNeeds !== undefined && (!Array.isArray(proposal.evidenceNeeds) || proposal.evidenceNeeds.length > 20 || new Set(proposal.evidenceNeeds.map(need => need?.id)).size !== proposal.evidenceNeeds.length || proposal.evidenceNeeds.some(need => !need || typeof need !== 'object' || Object.keys(need).some(key => !['id','category','description'].includes(key)) || !/^[A-Za-z0-9_-]{1,80}$/.test(need.id ?? '') || !['source','design','analysis','replication','causal','provenance','validation','other'].includes(need.category) || typeof need.description !== 'string' || !need.description.trim() || need.description.length > 2000 || need.description.includes('\0')))) errors.push('invalid proposal evidenceNeeds');
      if (proposal.text === undefined && proposal.scope === undefined && !proposal.evidenceNeeds?.length) errors.push('empty revisionProposal');
    }
  }
  const allowed = new Set(['sessionId', 'runId', 'expectedRevision', 'snapshotHash', 'claimId', 'resourceIds', 'title', 'rationale', 'severity', 'category', 'revisionProposal']);
  if (Object.keys(finding).some(key => !allowed.has(key))) errors.push('unexpected finding fields');
  return errors;
}

function selfTest() {
  const hash = 'a'.repeat(64);
  const input = { state: { revision: 2, snapshotHash: hash, reviewStatus: 'active', claims: [{ id: 'c', resourceIds: ['r', 'unselected'] }] }, request: { id: 'request', sessionId: 'session', claimId: 'c', snapshotHash: hash, resourceIds: ['r'], phase: 'working' }, finding: { sessionId: 'session', runId: 'request', expectedRevision: 2, snapshotHash: hash, claimId: 'c', resourceIds: ['r'], title: 'Synthetic check', rationale: 'Provided synthetic text only; no scientific inference.', severity: 'info', category: 'other' } };
  assert.deepEqual(validate(input), []);
  assert.deepEqual(validate({ ...input, finding: { ...input.finding, revisionProposal: { text:'Scoped synthetic hypothesis', scope:'sample', evidenceNeeds:[{id:'independent',category:'replication',description:'Collect independent units before broader inference'}] } } }), []);
  for (const revisionProposal of [{}, {text:''}, {scope:'approved'}, {evidenceNeeds:[{id:'n',category:'fake',description:'x'}]}, {authority:'approved'}]) assert.ok(validate({...input,finding:{...input.finding,revisionProposal}}).length);
  for (const patch of [{ expectedRevision: 1 }, { resourceIds: ['unselected'] }, { sessionId: 'other' }, { snapshotHash: 'b'.repeat(64) }, { title: ' ' }, { approval: true }]) assert.ok(validate({ ...input, finding: { ...input.finding, ...patch } }).length);
  assert.ok(validate({ ...input, request: { ...input.request, phase: 'cancelled' } }).length);
  assert.ok(validate({ ...input, state: { ...input.state, reviewStatus: 'paused' } }).length);
  console.log('Structure/scope self-test passed; scientific validity is not assessed.');
}
try {
  if (process.argv[2] === '--self-test') selfTest();
  else {
    if (!process.argv[2]) throw new Error('Usage: node validate-finding.mjs INPUT.json | --self-test');
    const errors = validate(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    console.log(JSON.stringify({ valid: errors.length === 0, scope: 'structure_and_selected_references_only', errors }, null, 2));
    process.exitCode = errors.length ? 1 : 0;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
