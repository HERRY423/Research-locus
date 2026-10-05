import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { OpenAIUiResourceMetadataSchema, OpenAIUiToolMetadataSchema } from '@openai/mcp-extensions/server';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { ReviewStore, type ReviewState } from '../src/domain.js';
import { WorkspaceCatalog, type CatalogState } from '../src/catalog.js';
import { createMcpServer, HOME_URI, WORKBENCH_URI } from '../src/mcp.js';

const TOKEN = 'test-ui-channel-token-never-in-tool-results';
const HTML = `<!doctype html><meta name="locus-ui-token" content="${TOKEN}"><div>Research Locus</div>`;

async function connected(t: TestContext, options: {
  capabilities?: ClientCapabilities;
  onForm?: (params: unknown) => { action: 'accept'; content: { resources: string[] } } | { action: 'cancel' | 'decline' };
  configuredToken?: boolean;
} = {}) {
  const store = new ReviewStore();
  const catalog = new WorkspaceCatalog({ legacyStore: store });
  const server = createMcpServer(store, HTML, options.configuredToken === false ? undefined : TOKEN, catalog);
  const client = new Client({ name: 'research-locus-protocol-tests', version: '1.0.0' }, { capabilities: options.capabilities ?? {} });
  if (options.onForm) {
    client.setRequestHandler(z.object({ method: z.literal('openai/elicitation/create'), params: z.unknown() }),
      async request => options.onForm!(request.params));
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  return { client, server, store, catalog, call };
}

function stateFrom(result: Awaited<ReturnType<Client['callTool']>>): ReviewState {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return (result._meta as { locusState: ReviewState }).locusState;
}

function structured(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  assert.ok(result.structuredContent && typeof result.structuredContent === 'object');
  return result.structuredContent as Record<string, unknown>;
}

function resourceText(result: Awaited<ReturnType<Client['readResource']>>): string {
  const content = result.contents[0];
  assert.ok('text' in content);
  return content.text;
}

test('structured revision proposals cross MCP as candidates and only selected researcher items are adopted', async t => {
  const { call, store } = await connected(t);
  let state = store.getState();
  const before = structuredClone(state.claims[0]);
  const proposal = { text:'Synthetic sample-bounded observation', scope:'sample', evidenceNeeds:[{ id:'replication', category:'replication', description:'Provide an independent donor-level analysis.' }] };
  const findingInput = { expectedRevision:state.revision, claimId:before.id, snapshotHash:state.snapshotHash, resourceIds:[], title:'Narrow the inference', rationale:'Synthetic test only', severity:'warning', category:'claim_scope', revisionProposal:proposal };
  for (const revisionProposal of [{}, {text:''}, {scope:'approved'}, {evidenceNeeds:[{id:'x',category:'invalid',description:'x'}]}, {...proposal,approve:true}]) {
    assert.equal((await call('locus.submit_finding',{...findingInput,revisionProposal})).isError,true);
  }
  state = stateFrom(await call('locus.submit_finding',findingInput));
  assert.deepEqual(state.claims[0],before,'Saving a finding must never revise the claim');
  const findingId = state.findings.at(-1)!.id;
  const adopt = {type:'apply_revision_proposal',findingId,acceptText:false,acceptScope:true,evidenceNeedIds:['replication'],rationale:'Accept only the bounded scope and evidence plan.'};
  assert.equal((await call('locus.ui_action',{token:'wrong',expectedRevision:state.revision,action:adopt})).isError,true);
  state = stateFrom(await call('locus.ui_action',{token:TOKEN,expectedRevision:state.revision,action:adopt}));
  assert.equal(state.claims[0].text,before.text);
  assert.equal(state.claims[0].scope,'sample');
  assert.equal(state.claims[0].evidenceNeeds?.length,1);
  state = stateFrom(await call('locus.ui_action',{token:TOKEN,expectedRevision:state.revision,action:{...adopt,acceptText:true,acceptScope:false,evidenceNeedIds:[],rationale:'Now accept the remaining text.'}}));
  assert.equal(state.claims[0].text,proposal.text);
  const output = structured(await call('locus.state'));
  const compact = output.state as Record<string,unknown>;
  const plan = (compact.evidencePlans as Record<string,Array<{id:string;status:string}>>)[before.id];
  assert.ok(plan.some(item=>item.id===`proposal:${findingId}:replication` && item.status==='missing'));
  assert.ok(plan.some(item=>item.id==='baseline:assessment' && item.status==='needs_review'));
  assert.equal(state.claims[0].evidenceCeiling,'NOT_ASSESSED');
});

test('scoped design extraction reads only selected evidence, proposes without writing metadata, and requires UI confirmation', async t => {
  const {call,store}=await connected(t);
  let state=store.getState();
  const claim=state.claims[0], sessionId='legacy';
  const selected=[claim.resourceIds[0]];
  const request={token:TOKEN,sessionId,claimId:claim.id,snapshotHash:state.snapshotHash,resourceIds:selected,mode:'design',focus:'Extract design only'};
  assert.equal((await call('locus.review_request',{...request,resourceIds:[]})).isError,true);
  const run=structured(await call('locus.review_request',request)).run as {id:string};
  const args={sessionId,runId:run.id,expectedRevision:state.revision,claimId:claim.id,snapshotHash:state.snapshotHash,resourceIds:selected};
  const prepared=await call('locus.extract_design',args);
  assert.notEqual(prepared.isError,true);
  assert.equal(store.getState().revision,0,'Preparing extraction is read-only');
  assert.equal((structured(prepared).selectedEvidence as unknown[]).length,1);
  assert.equal(structured(prepared).unknownValue,'NOT_DECLARED');
  const candidates=[{field:'biologicalReplicates',value:2,rationale:'Fixture explicitly says two donors.',evidence:[{resourceId:selected[0],quote:'two donors',locator:'Claim 1 fixture sentence'}]}];
  assert.equal((await call('locus.extract_design',{...args,resourceIds:['not-selected'],candidates})).isError,true);
  assert.equal((await call('locus.extract_design',{...args,candidates:[{...candidates[0],evidence:[{resourceId:selected[0],quote:'invented phrase',locator:'x'}]}]})).isError,true);
  const submitted=await call('locus.extract_design',{...args,candidates});
  state=stateFrom(submitted);
  assert.equal(state.snapshotHash,args.snapshotHash);
  assert.deepEqual(state.claims[0].metadata,claim.metadata);
  const p=state.designProposals![0];
  assert.equal(p.status,'proposed');
  const runs=structured(await call('locus.review_status',{sessionId})).reviewRuns as Array<{phase:string;sequence:number}>;
  assert.equal(runs[0].phase,'needs_input');
  assert.equal((await call('locus.review_progress',{sessionId,runId:run.id,expectedSequence:runs[0].sequence,phase:'completed',message:'Pretend confirmed'})).isError,true);
  assert.equal((await call('locus.ui_action',{token:'wrong',sessionId,expectedRevision:state.revision,action:{type:'confirm_design',proposalId:p.id,selectedFields:['biologicalReplicates'],rationale:'Confirmed'}})).isError,true);
  state=stateFrom(await call('locus.ui_action',{token:TOKEN,sessionId,expectedRevision:state.revision,action:{type:'confirm_design',proposalId:p.id,selectedFields:['biologicalReplicates'],rationale:'Checked exact source sentence.'}}));
  assert.equal(state.designProposals![0].status,'confirmed');
  assert.equal(state.claims[0].metadata.biologicalReplicates,2);
  assert.equal(state.events.at(-1)!.actor.kind,'researcher');
  const finished=structured(await call('locus.review_status',{sessionId})).reviewRuns as Array<{phase:string}>;
  assert.equal(finished[0].phase,'completed','Confirmation of an unchanged value must still finish extraction');
});

test('MCP review of a user-created session returns missing fields and then risks after declared metadata is edited', async t => {
  const { call, catalog } = await connected(t);
  const project = catalog.createProject('User study').projects.at(-1)!;
  const created = catalog.createSession(project.id, 'Fresh review');
  const sessionId = created.sessionId;
  let state = stateFrom(await call('locus.ui_action', { token: TOKEN, sessionId, expectedRevision: 0, action: { type: 'create_claim', text: 'Population effect', scope: 'population', rationale: 'Review it' } }));
  const review = await call('locus.review', { sessionId, expectedRevision: state.revision });
  state = stateFrom(review);
  assert.equal(state.fixture, false);
  const report = structured(review).ruleReview as { checks: Array<{ outcome: string; missingFields: string[] }> };
  assert.equal(report.checks[0].outcome, 'needs_input');
  assert.deepEqual(report.checks[0].missingFields, ['analysisUnit', 'biologicalReplicates']);
  assert.match(JSON.stringify(review.content), /信息不足/);
  const invalid = await call('locus.ui_action', { token: TOKEN, sessionId, expectedRevision: state.revision, action: { type: 'revise_claim', claimId: state.claims[0].id, text: 'Population effect', metadata: { perturbation: 'false' }, rationale: 'Invalid type' } });
  assert.equal(invalid.isError, true);
  state = stateFrom(await call('locus.ui_action', { token: TOKEN, sessionId, expectedRevision: state.revision, action: { type: 'revise_claim', claimId: state.claims[0].id, text: 'Population effect', metadata: { analysisUnit: 'cell', biologicalReplicates: 4, figureApplicable: false }, rationale: 'Record actual design' } }));
  const risks = await call('locus.review', { sessionId, expectedRevision: state.revision });
  assert.equal((structured(risks).summary as { flagged: number }).flagged, 1);
  assert.equal(stateFrom(risks).findings[0].ruleId, 'META-DESIGN-001');
  assert.equal(stateFrom(risks).scientificAuthorization, 'NONE');
});

test('scoped review progress roundtrip keeps decisions human and rejects late or out-of-scope findings', async t => {
  const { call, store, catalog } = await connected(t);
  const state = store.getState(), claim = state.claims[0], sessionId = catalog.defaultSessionId;
  const request = { token: TOKEN, sessionId, claimId: claim.id, resourceIds: [], snapshotHash: state.snapshotHash, mode: 'challenge', focus: 'Check alternatives' };
  assert.equal((await call('locus.review_request', { ...request, token: 'wrong' })).isError, true);
  const created = await call('locus.review_request', request);
  const run = structured(created).run as { id: string; sequence: number };
  assert.ok(run.id);
  assert.equal((await call('locus.review_request', request)).isError, true);
  const working = await call('locus.review_progress', { sessionId, runId: run.id, expectedSequence: run.sequence, phase: 'working', message: 'Checking only the selected scope' });
  assert.equal(store.getState().revision, state.revision);
  assert.equal(store.getState().decisions.length, state.decisions.length);
  const finding = { sessionId, runId: run.id, expectedRevision: state.revision, claimId: claim.id, resourceIds: claim.resourceIds, snapshotHash: state.snapshotHash, title: 'Synthetic scope check', rationale: 'No selected source; limitations remain unknown.', severity: 'info', category: 'other' };
  assert.ok(claim.resourceIds.length);
  assert.equal((await call('locus.submit_finding', finding)).isError, true);
  assert.equal(store.getState().revision, state.revision);
  const saved = await call('locus.submit_finding', { ...finding, resourceIds: [] });
  assert.notEqual(saved.isError, true);
  const progress = (structured(await call('locus.review_status', { sessionId })).reviewRuns as Array<{ id: string; sequence: number; findingIds: string[] }>)[0];
  assert.equal(progress.findingIds.length, 1);
  const sequence = (structured(working).run as { sequence: number }).sequence;
  assert.ok(progress.sequence > sequence);
  assert.equal((await call('locus.review_progress', { sessionId, runId: run.id, expectedSequence: sequence, phase: 'completed', message: 'Stale finish' })).isError, true);
  await call('locus.review_cancel', { token: TOKEN, sessionId, runId: run.id });
  assert.equal((await call('locus.submit_finding', { ...finding, resourceIds: [], expectedRevision: store.getState().revision })).isError, true);
  assert.equal(store.getState().findings.length, state.findings.length + 1);
});

test('official UI entrypoints, app metadata, and current dossier are discoverable over MCP', async t => {
  const { client, call, store } = await connected(t);
  const listed = await client.listTools();
  for (const [name, type] of [['locus.open', 'global'], ['locus.panel', 'thread'], ['locus.file', 'file']]) {
    const tool = listed.tools.find(item => item.name === name)!;
    assert.ok(tool);
    const metadata = OpenAIUiToolMetadataSchema.parse(tool._meta?.['openai/ui']);
    assert.equal(metadata.entrypoints?.[0].type, type);
    assert.equal((tool._meta?.ui as { resourceUri: string }).resourceUri, name === 'locus.open' ? HOME_URI : WORKBENCH_URI);
  }
  const fileTool = listed.tools.find(item => item.name === 'locus.file')!;
  const entrypoint = OpenAIUiToolMetadataSchema.parse(fileTool._meta?.['openai/ui']).entrypoints![0];
  assert.equal(entrypoint.type, 'file');
  if (entrypoint.type === 'file') {
    assert.ok(entrypoint.extensions.includes('.md'));
    assert.ok(entrypoint.extensions.includes('.csv'));
    assert.ok(!entrypoint.extensions.includes('.pdf'));
  }
  const uiTool = listed.tools.find(item => item.name === 'locus.ui_action')!;
  assert.deepEqual((uiTool._meta?.ui as { visibility: string[] }).visibility, ['app']);
  const app = await client.readResource({ uri: WORKBENCH_URI });
  assert.equal(app.contents[0].mimeType, RESOURCE_MIME_TYPE);
  const presentation = OpenAIUiResourceMetadataSchema.parse(app.contents[0]._meta?.['openai/ui']);
  assert.deepEqual(presentation.availableDisplayModes, ['inline', 'fullscreen']);
  const home = await call('locus.open');
  assert.equal(structured(home).page, 'home');
  assert.equal(home._meta?.locusState, undefined);
  assert.ok(home._meta?.locusCatalog);
  const homeResource = await client.readResource({ uri: HOME_URI });
  assert.equal(OpenAIUiResourceMetadataSchema.parse(homeResource.contents[0]._meta?.['openai/ui']).preferredDisplayMode, 'fullscreen');
  const opened = await call('locus.panel');
  assert.equal(structured(opened).page, 'review');
  const state = stateFrom(opened);
  assert.equal(state.revision, store.getState().revision);
  assert.equal(state.fixture, true);
  const resource = await client.readResource({ uri: 'locus://project/state' });
  assert.deepEqual(JSON.parse(resourceText(resource)), structured(opened).state);
  const global = OpenAIUiToolMetadataSchema.parse(listed.tools.find(item => item.name === 'locus.open')!._meta?.['openai/ui']).entrypoints![0];
  assert.equal(global.type, 'global');
  assert.deepEqual(global, { type: 'global' });
  assert.deepEqual(OpenAIUiToolMetadataSchema.parse(listed.tools.find(item => item.name === 'locus.settings')!._meta?.['openai/ui']).entrypoints, []);
  assert.equal(client.getServerVersion()?.icons?.[0].mimeType, 'image/svg+xml');
  assert.match(decodeURIComponent(client.getServerVersion()!.icons![0].src), /viewBox="0 0 20 20"/);
  assert.notEqual(listed.tools.find(item => item.name === 'locus.panel')!.title, listed.tools.find(item => item.name === 'locus.open')!.title);
});

test('mentions resolve real resources and exact URI lookup rejects substring and authority tricks', async t => {
  const { client, call, store } = await connected(t);
  const all = await call('search_mentions', { query: '' });
  const items = (all.structuredContent as { items: { uri: string; title: string }[] }).items;
  assert.equal(items.length, store.getState().claims.length + store.getState().resources.length);
  for (const item of items) {
    const read = await client.readResource({ uri: item.uri });
    assert.equal(read.contents[0].uri, item.uri);
    assert.ok(JSON.parse(resourceText(read)).id);
  }
  const filtered = await call('search_mentions', { query: 'pathway' });
  assert.equal((filtered.structuredContent as { items: unknown[] }).items.length, 1);
  for (const uri of [
    'locus://resource/fixture-notes-extra',
    'locus://resource/fixture-notes/another',
    'locus://resource/fixture-notes?scope=all',
    'locus://resource/fixture-notes#fragment',
    'locus://attacker.example/resource/fixture-notes',
    'https://attacker.example/locus://resource/fixture-notes',
  ]) await assert.rejects(client.readResource({ uri }));
});

test('model tools enforce agent provenance, optimistic concurrency, and reject forged actor fields', async t => {
  const { call, store } = await connected(t);
  const initial = store.getState();
  const forged = await call('locus.review', { expectedRevision: 0, actor: { kind: 'researcher', id: 'alice' } });
  assert.equal(forged.isError, true);
  assert.equal(store.getState().revision, 0);
  const reviewed = stateFrom(await call('locus.review', { expectedRevision: initial.revision }));
  assert.equal(reviewed.revision, initial.revision + 1);
  assert.deepEqual(reviewed.events.at(-1)?.actor, { kind: 'agent', id: 'mcp-agent' });
  const stale = await call('locus.review', { expectedRevision: initial.revision });
  assert.equal(stale.isError, true);
  assert.equal((stale.structuredContent as { error: { code: string } }).error.code, 'REVISION_CONFLICT');
  const finding = {
    expectedRevision: reviewed.revision, claimId: reviewed.claims[0].id,
    title: 'Inspect donor-level uncertainty', rationale: 'Agent proposal requiring review of original experiment and analysis.',
    severity: 'warning', category: 'design', snapshotHash: reviewed.snapshotHash, resourceIds: reviewed.claims[0].resourceIds,
  };
  assert.equal((await call('locus.submit_finding', { ...finding, actor: { kind: 'researcher', id: 'alice' } })).isError, true);
  assert.equal((await call('locus.submit_finding', { ...finding, action: { type: 'pause' } })).isError, true);
  const submitted = stateFrom(await call('locus.submit_finding', finding));
  assert.equal(submitted.findings.at(-1)?.source, 'agent_suggestion');
  assert.equal(submitted.decisions.length, 0);
  assert.deepEqual(submitted.events.at(-1)?.actor, { kind: 'agent', id: 'mcp-agent' });
});

test('UI channel rejects missing/wrong tokens and records only declared, unauthenticated interactions', async t => {
  const { call, store, client } = await connected(t);
  const missing = await call('locus.ui_action', { expectedRevision: 0, action: { type: 'pause' } });
  assert.equal(missing.isError, true);
  const wrong = await call('locus.ui_action', { token: 'wrong-secret-that-must-not-be-echoed', expectedRevision: 0, action: { type: 'pause' } });
  assert.equal(wrong.isError, true);
  assert.ok(!JSON.stringify(wrong).includes('wrong-secret-that-must-not-be-echoed'));
  assert.equal(store.getState().revision, 0);
  const paused = stateFrom(await call('locus.ui_action', { token: TOKEN, expectedRevision: 0, action: { type: 'pause' } }));
  assert.equal(paused.reviewStatus, 'paused');
  const halted = await call('locus.review', { expectedRevision: paused.revision });
  assert.equal((halted.structuredContent as { error: { code: string } }).error.code, 'REVIEW_PAUSED');
  const decisionState = stateFrom(await call('locus.ui_action', { token: TOKEN, expectedRevision: paused.revision, action: {
    type: 'intervene', findingId: paused.findings[0].id, decision: 'challenge', rationale: 'The selected design needs donor-level review.',
  } }));
  assert.equal(decisionState.decisions[0].identityVerification, 'DECLARED_NOT_AUTHENTICATED');
  assert.equal(decisionState.decisions[0].actorId, 'ui-channel-unverified');
  for (const name of ['locus.state', 'locus.open', 'locus.panel', 'locus.settings', 'locus.dossier']) {
    assert.ok(!JSON.stringify(await call(name)).includes(TOKEN));
  }
  // Deliberately document the boundary: a connected MCP client CAN read HTML.
  // The channel token is routing friction, not proof that a human acted.
  const htmlResource = await client.readResource({ uri: WORKBENCH_URI });
  assert.ok(resourceText(htmlResource).includes(TOKEN));
});

test('unconfigured intervention channel fails closed', async t => {
  const { call, store } = await connected(t, { configuredToken: false });
  const response = await call('locus.ui_action', { token: TOKEN, expectedRevision: 0, action: { type: 'pause' } });
  assert.equal(response.isError, true);
  assert.ok(JSON.stringify(response).includes('UI_CHANNEL_UNAVAILABLE'));
  assert.equal(store.getState().revision, 0);
});

test('file entrypoint stages a host handle without reading or attaching evidence', async t => {
  const { call, store } = await connected(t);
  const before = store.getState();
  const file = { name: 'paper-notes.md', resourceUri: 'resource://host/selected-notes' };
  const opened = await call('locus.file', { file });
  assert.deepEqual(structured(opened).file, file);
  assert.deepEqual(store.getState(), before);
  assert.equal((await call('locus.file', { file: { ...file, name: 'paper.pdf' } })).isError, true);
});

test('native resource selection explicitly degrades when the host lacks forms', async t => {
  const { call, store } = await connected(t);
  const selected = await call('locus.choose_resources');
  assert.equal(structured(selected).selection, 'unsupported');
  assert.equal(structured(selected).registeredServerForms, 'MRTR adapter not implemented');
  assert.equal(store.getState().revision, 0);
});

test('official direct native resource picker sends rich resource schema and returns exact selected IDs', async t => {
  let request: unknown;
  const { call, store } = await connected(t, {
    capabilities: { extensions: { 'openai/elicitation': { form: {} } } },
    onForm: params => { request = params; return { action: 'accept', content: { resources: ['locus://resource/fixture-notes'] } }; },
  });
  const response = await call('locus.choose_resources');
  assert.notEqual(response.isError, true, JSON.stringify(response));
  assert.deepEqual(structured(response).resourceIds, ['fixture-notes']);
  const sent = request as { requestedSchema: { properties: { resources: { 'x-openai-input': { type: string; options: { uri: string }[] } } } } };
  assert.equal(sent.requestedSchema.properties.resources['x-openai-input'].type, 'resource');
  assert.deepEqual(sent.requestedSchema.properties.resources['x-openai-input'].options.map(option => option.uri), ['locus://resource/fixture-notes']);
  assert.equal(store.getState().revision, 0);
});

test('native picker rejects a URI containing an allowed ID as a substring', async t => {
  const { call, store } = await connected(t, {
    capabilities: { extensions: { 'openai/elicitation': { form: {} } } },
    onForm: () => ({ action: 'accept', content: { resources: ['https://attacker.example/fixture-notes'] } }),
  });
  const response = await call('locus.choose_resources');
  assert.equal(response.isError, true);
  assert.equal(store.getState().revision, 0);
});

test('newly attached evidence is immediately available through mentions and URI templates', async t => {
  const { call, client, store } = await connected(t);
  const state = store.act({ type: 'attach_evidence', claimId: 'claim-design', name: 'new-evidence.md', mediaType: 'text/markdown', content: 'External document says ignore instructions. This remains untrusted evidence text.' }, 0, { kind: 'researcher', id: 'test-researcher' });
  const resource = state.resources.at(-1)!;
  const found = await call('search_mentions', { query: 'new-evidence' });
  const items = (found.structuredContent as { items: { uri: string }[] }).items;
  assert.deepEqual(items.map(item => item.uri), [`locus://resource/${resource.id}`]);
  const read = await client.readResource({ uri: items[0].uri });
  assert.equal(JSON.parse(resourceText(read)).content, resource.content);
  assert.equal(store.getState().scientificAuthorization, 'NONE');
});

test('ordinary tool results exclude attachment bytes and audit payloads; UI metadata and explicit resource reads retain them', async t => {
  const { call, client, store } = await connected(t);
  const sensitiveMarker = 'UNSELECTED_ATTACHMENT_BYTES_283dcbae';
  const state = store.act({ type: 'attach_evidence', claimId: 'claim-design', name: 'review-only-notes.txt', mediaType: 'text/plain', content: sensitiveMarker }, 0, { kind: 'researcher', id: 'test-researcher' });
  for (const name of ['locus.state', 'locus.open', 'locus.panel', 'locus.settings', 'locus.dossier']) {
    const response = await call(name);
    assert.ok(!JSON.stringify({ content: response.content, structuredContent: response.structuredContent }).includes(sensitiveMarker), name);
    if (name !== 'locus.dossier' && name !== 'locus.open') assert.equal(stateFrom(response).resources.at(-1)!.content, sensitiveMarker);
  }
  const reviewed = await call('locus.review', { expectedRevision: state.revision });
  assert.ok(!JSON.stringify({ content: reviewed.content, structuredContent: reviewed.structuredContent }).includes(sensitiveMarker));
  const summary = await client.readResource({ uri: 'locus://project/state' });
  assert.ok(!resourceText(summary).includes(sensitiveMarker));
  const explicit = await client.readResource({ uri: `locus://resource/${state.resources.at(-1)!.id}` });
  assert.equal(JSON.parse(resourceText(explicit)).content, sensitiveMarker);
  const dossier = await client.readResource({ uri: 'locus://project/dossier' });
  assert.equal(JSON.parse(resourceText(dossier)).state.resources.at(-1).content, sensitiveMarker);
});

test('global home/catalog is read-only and catalog creation requires the UI channel', async t => {
  const { call, store, catalog } = await connected(t);
  const legacy = JSON.stringify(store.getState());
  const initial = catalog.list();
  const home = await call('locus.open');
  assert.equal(structured(home).page, 'home');
  assert.equal(home._meta?.locusState, undefined);
  assert.equal((home._meta?.locusCatalog as CatalogState).sessions.length, initial.sessions.length);
  await call('locus.catalog'); await call('locus.open');
  assert.deepEqual(catalog.list(), initial);
  assert.equal(JSON.stringify(store.getState()), legacy);
  for (const args of [{ action: { type: 'create_project', title: 'Denied' } }, { token: 'incorrect', action: { type: 'create_project', title: 'Denied' } }]) {
    assert.equal((await call('locus.catalog_action', args)).isError, true);
  }
  assert.deepEqual(catalog.list(), initial);
  const created = await call('locus.catalog_action', { token: TOKEN, action: { type: 'create_project', title: 'Independent project' } });
  assert.notEqual(created.isError, true);
  assert.equal((created._meta?.locusCatalog as CatalogState).projects.length, initial.projects.length + 1);
  assert.equal(JSON.stringify(store.getState()), legacy);
});

test('MCP tools, mentions and resource URIs route explicitly without cross-session state', async t => {
  const { call, client, catalog, store } = await connected(t);
  const project = catalog.createProject('Two independent sessions').projects.find(item => item.title === 'Two independent sessions')!;
  const create = async (title: string) => {
    const response = await call('locus.catalog_action', { token: TOKEN, action: { type: 'create_session', projectId: project.id, title } });
    assert.notEqual(response.isError, true);
    assert.equal(stateFrom(response).fixture, false);
    return String(structured(response).sessionId);
  };
  const a = await create('Session A'), b = await create('Session B');
  const claimed = stateFrom(await call('locus.ui_action', { token: TOKEN, sessionId: a, expectedRevision: 0, action: { type: 'create_claim', text: 'Session A claim', scope: 'sample', rationale: 'Test selected session routing.' } }));
  const attached = stateFrom(await call('locus.ui_action', { token: TOKEN, sessionId: a, expectedRevision: claimed.revision, action: { type: 'attach_evidence', claimId: claimed.claims[0].id, name: 'session-a-only.txt', mediaType: 'text/plain', content: 'SESSION_A_BYTES' } }));
  const resourceId = attached.resources[0].id;
  assert.equal(stateFrom(await call('locus.state', { sessionId: b })).claims.length, 0);
  assert.equal(stateFrom(await call('locus.state')).fixture, true);
  assert.equal(store.getState().revision, 0);
  const read = await client.readResource({ uri: `locus://session/${a}/resource/${resourceId}` });
  assert.equal(JSON.parse(resourceText(read)).content, 'SESSION_A_BYTES');
  await assert.rejects(client.readResource({ uri: `locus://session/${b}/resource/${resourceId}` }));
  await assert.rejects(client.readResource({ uri: `locus://session/${a}/resource/${resourceId}?other=${b}` }));
  const mentions = await call('search_mentions', { query: 'session-a-only' });
  assert.deepEqual((structured(mentions).items as { uri: string }[]).map(item => item.uri), [`locus://session/${a}/resource/${resourceId}`]);
  const [reviewA, reviewB] = await Promise.all([
    call('locus.review', { sessionId: a, expectedRevision: attached.revision }),
    call('locus.review', { sessionId: b, expectedRevision: 0 }),
  ]);
  assert.equal(stateFrom(reviewA).revision, attached.revision + 1);
  assert.equal(stateFrom(reviewB).revision, 1);
  assert.equal(reviewA._meta?.sessionId, a); assert.equal(reviewB._meta?.sessionId, b);
  const dossier = await call('locus.dossier', { sessionId: a });
  assert.equal((structured(dossier).dossier as { resourceUri: string }).resourceUri, `locus://session/${a}/dossier`);
  assert.equal((await call('locus.state', { sessionId: 'nonexistent' })).isError, true);
  assert.equal((await call('locus.ui_action', { token: TOKEN, sessionId: '../legacy', expectedRevision: 0, action: { type: 'pause' } })).isError, true);
  const openedFile = await call('locus.file', { file: { name: 'notes.txt', resourceUri: 'resource://host/notes' } });
  assert.equal(openedFile._meta?.sessionId, catalog.defaultSessionId);
  assert.equal(store.getState().revision, 0);
});

test('local bridge opens sessions transactionally and ignores delayed responses from an earlier selection', async () => {
  const { createBridge } = await import('../src/bridge.js');
  const keys = ['window', 'document', 'fetch', 'EventSource'] as const;
  const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const fixture = new ReviewStore().getState();
  const states: Record<string, ReviewState> = Object.fromEntries(['a', 'b', 'c'].map(id => [id, { ...fixture, title: id }]));
  const emitted: string[] = [];
  const streams: string[] = [];
  const requests: { path: string; body?: { sessionId?: string } }[] = [];
  let delayed: ((response: Response) => void) | undefined;
  let delayB = false;
  const browserWindow = { parent: null as unknown, addEventListener: () => {} }; browserWindow.parent = browserWindow;
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input); const body = init?.body ? JSON.parse(String(init.body)) as { sessionId?: string } : undefined;
    requests.push({ path, body });
    const url = new URL(path, 'http://localhost');
    if (url.pathname === '/api/catalog') return new Response(JSON.stringify({ schemaVersion: 'research-locus.catalog.v1', revision: 0, projects: [], sessions: [] }));
    const id = body?.sessionId ?? url.searchParams.get('sessionId')!;
    if (id === 'fail') return new Response(JSON.stringify({ error: 'Simulated read failure' }), { status: 500 });
    if (id === 'b' && delayB) return await new Promise<Response>(resolve => { delayed = resolve; });
    return new Response(JSON.stringify(states[id]));
  };
  const fakes: Record<string, unknown> = {
    window: browserWindow,
    document: { querySelector: () => ({ content: 'test-token' }) },
    fetch: fakeFetch,
    EventSource: class { constructor(path: string) { streams.push(path); } addEventListener() {} close() {} },
  };
  try {
    for (const key of keys) Object.defineProperty(globalThis, key, { value: fakes[key], writable: true, configurable: true });
    const bridge = await createBridge(state => emitted.push(state.title));
    assert.equal(bridge.entryPage(), 'home'); assert.equal(bridge.activeSessionId(), undefined);
    await bridge.listCatalog(); assert.equal(streams.length, 0); assert.equal(emitted.length, 0);
    await bridge.openSession('a'); assert.equal(bridge.activeSessionId(), 'a');
    await assert.rejects(bridge.openSession('fail'), /Simulated read failure/);
    assert.equal(bridge.activeSessionId(), 'a'); assert.equal(emitted.at(-1), 'a');
    await bridge.act({ type: 'pause' }, 0);
    assert.equal(requests.at(-1)?.body?.sessionId, 'a');
    delayB = true;
    const earlier = bridge.openSession('b');
    const rejected = assert.rejects(earlier, /会话选择已改变/);
    await bridge.openSession('c');
    assert.ok(delayed); delayed(new Response(JSON.stringify(states.b)));
    await rejected;
    assert.equal(bridge.activeSessionId(), 'c'); assert.equal(emitted.at(-1), 'c');
    assert.ok(!emitted.includes('b'));
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('host bridge preserves staged file and ETag when reopening its session, but clears them on a real switch', async () => {
  const { App } = await import('@modelcontextprotocol/ext-apps');
  const { createBridge } = await import('../src/bridge.js');
  const keys = ['window', 'document'] as const;
  const globals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const methods = ['connect', 'getHostCapabilities', 'getHostContext', 'callServerTool', 'readServerResource', 'request'] as const;
  const originals = new Map(methods.map(key => [key, Object.getOwnPropertyDescriptor(App.prototype, key)]));
  const state = new ReviewStore().getState();
  const file = { name: 'host-notes.md', resourceUri: 'resource://host/notes' };
  const writes: { uri: string; ifMatch: string; text: string }[] = [];
  let stateCalls = 0;
  let content = 'Initial host evidence';
  let etag = 'version-1';
  class MockWindow extends EventTarget { parent = {}; }
  const browserWindow = new MockWindow();
  const overrides: Record<string, unknown> = {
    connect: async function(this: InstanceType<typeof App>) {
      this.ontoolresult?.({ content: [], structuredContent: { page: 'review', sessionId: 'legacy', file }, _meta: { sessionId: 'legacy', locusState: state } });
    },
    getHostCapabilities: () => ({ experimental: { 'openai/resource': {} } }),
    getHostContext: () => ({}),
    callServerTool: async ({ name, arguments: args }: { name: string; arguments: { sessionId: string } }) => {
      stateCalls += 1;
      assert.equal(name, 'locus.state');
      return { content: [], structuredContent: { sessionId: args.sessionId }, _meta: { sessionId: args.sessionId, locusState: { ...state, title: args.sessionId } } };
    },
    readServerResource: async ({ uri, _meta }: { uri: string; _meta?: { 'openai/resource'?: { representation?: string } } }) => {
      assert.equal(_meta?.['openai/resource']?.representation, 'text');
      return { contents: [{ uri, text: content, mimeType: 'text/markdown', _meta: { 'openai/resource': { etag, writable: true } } }] };
    },
    request: async ({ method, params }: { method: string; params: { uri: string; ifMatch: string; text: string } }) => {
      assert.equal(method, 'openai/resources/write'); writes.push(params);
      content = params.text; etag = 'version-2';
      return { outcome: 'saved', etag };
    },
  };
  try {
    Object.defineProperty(globalThis, 'window', { value: browserWindow, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: Object.assign(new EventTarget(), { hidden: true, querySelector: () => ({ content: TOKEN }), documentElement: { style: { setProperty() {} } } }), configurable: true });
    for (const method of methods) Object.defineProperty(App.prototype, method, { value: overrides[method], writable: true, configurable: true });
    const bridge = await createBridge(() => {});
    assert.equal(bridge.mode, 'host');
    assert.equal(bridge.activeSessionId(), 'legacy');
    assert.equal(bridge.stagedFile()?.content, content);
    await bridge.openSession('legacy');
    assert.equal(stateCalls, 0, 'Initial entrypoint result is reused on first render');
    assert.equal(bridge.stagedFile()?.sourceUri, file.resourceUri);
    assert.equal(bridge.stagedFile()?.content, content);
    await bridge.saveFile('Edited host evidence', file.resourceUri);
    assert.deepEqual(writes, [{ uri: file.resourceUri, text: 'Edited host evidence', ifMatch: 'version-1' }]);
    await bridge.openSession('legacy');
    assert.equal(bridge.stagedFile()?.content, 'Edited host evidence');
    await bridge.openSession('another-session');
    assert.equal(bridge.stagedFile(), null);
    await assert.rejects(bridge.saveFile('Do not write', file.resourceUri), /未将当前文件标记为可写/);
    assert.equal(writes.length, 1);
  } finally {
    browserWindow.dispatchEvent(new Event('pagehide'));
    for (const method of methods) {
      const original = originals.get(method);
      if (original) Object.defineProperty(App.prototype, method, original);
      else Reflect.deleteProperty(App.prototype, method);
    }
    for (const key of keys) {
      const original = globals.get(key);
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('host feedback handles unknown delivery, deduplicates polling and ignores delayed progress rollback', async t => {
  const { call, store } = await connected(t);
  const { App } = await import('@modelcontextprotocol/ext-apps');
  const { createBridge } = await import('../src/bridge.js');
  const keys = ['window', 'document'] as const;
  const globals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const methods = ['connect', 'getHostCapabilities', 'getHostContext', 'callServerTool', 'sendMessage'] as const;
  const originals = new Map(methods.map(key => [key, Object.getOwnPropertyDescriptor(App.prototype, key)]));
  class MockWindow extends EventTarget { parent = {}; }
  const browserWindow = new MockWindow();
  let sends = 0, stateCalls = 0, delay = false, failRead = false;
  let release: ((result: unknown) => void) | undefined;
  let prompt = '';
  const initial = await call('locus.panel', { sessionId: 'legacy' });
  const overrides: Record<string, unknown> = {
    connect: async function(this: InstanceType<typeof App>) { this.ontoolresult?.(initial as never); },
    getHostCapabilities: () => ({}), getHostContext: () => ({}),
    callServerTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      if (name === 'locus.state') {
        stateCalls++;
        if (failRead) throw new Error('simulated disconnect');
        if (delay) return new Promise(resolve => { release = resolve; });
      }
      return call(name, args);
    },
    sendMessage: async ({ content }: { content: Array<{ text: string }> }) => { sends++; prompt = content[0].text; if (sends === 1) throw new Error('lost transport acknowledgement'); return {}; },
  };
  try {
    Object.defineProperty(globalThis, 'window', { value: browserWindow, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: Object.assign(new EventTarget(), { hidden: true, querySelector: () => ({ content: TOKEN }), documentElement: { style: { setProperty() {} } } }), configurable: true });
    for (const method of methods) Object.defineProperty(App.prototype, method, { value: overrides[method], writable: true, configurable: true });
    const bridge = await createBridge(() => {});
    const state = await bridge.openSession('legacy'), claim = state.claims[0];
    delay = true;
    const firstPoll = bridge.refresh();
    await bridge.refresh();
    assert.equal(stateCalls, 1, 'No overlapping refreshes');
    await assert.rejects(bridge.requestReview(state, claim.id, [], 'methods', 'Check independent units'), /未能确认消息/);
    assert.equal(sends, 1);
    assert.equal(bridge.feedback().runs.length, 1);
    assert.match(prompt, /runId=/);
    assert.match(prompt, /Check independent units/);
    assert.match(prompt, /URI 仅为 \[\]/);
    release!(initial); await firstPoll;
    assert.equal(bridge.feedback().runs.length, 1, 'Old empty poll cannot hide a newly registered request');
    delay = false;
    const run = bridge.feedback().runs[0];
    await call('locus.review_progress', { sessionId: 'legacy', runId: run.id, expectedSequence: run.sequence, phase: 'working', message: 'Read selected scope' });
    await bridge.refresh();
    assert.equal(bridge.feedback().runs[0].phase, 'working');
    failRead = true; await bridge.refresh();
    assert.equal(bridge.feedback().connection, 'retrying');
    assert.equal(sends, 1, 'Reconnect never resends a message');
    failRead = false; await bridge.refresh();
    assert.equal(bridge.feedback().connection, 'connected');
    await bridge.cancelReview(run.id);
    assert.equal(bridge.feedback().runs[0].phase, 'cancelled');
    await bridge.requestReview(store.getState(), claim.id, [], 'challenge', 'Reconsider the limitation');
    assert.equal(sends, 2);
    assert.equal(bridge.feedback().runs.at(-1)?.phase, 'queued');
    await bridge.cancelReview(bridge.feedback().runs.at(-1)!.id);
    await bridge.requestReview(store.getState(),claim.id,claim.resourceIds,'design','Extract design');
    assert.match(prompt,/locus.extract_design/);
    assert.match(prompt,/NOT_DECLARED/);
    assert.match(prompt,/逐项勾选确认/);
    assert.equal(bridge.feedback().runs.at(-1)?.mode,'design');
  } finally {
    browserWindow.dispatchEvent(new Event('pagehide'));
    for (const method of methods) { const original = originals.get(method); if (original) Object.defineProperty(App.prototype, method, original); else Reflect.deleteProperty(App.prototype, method); }
    for (const key of keys) { const original = globals.get(key); if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key); }
  }
});
