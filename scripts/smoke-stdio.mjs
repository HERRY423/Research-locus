// Run after npm run build. Uses an isolated temporary state, never the preview dossier.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = process.env.LOCUS_PLUGIN_ROOT ? resolve(process.env.LOCUS_PLUGIN_ROOT) : root;
const entry = join(pluginRoot, 'scripts', 'launch.mjs');
assert.ok(existsSync(join(pluginRoot, 'dist', 'server.js')), 'Build the plugin before the stdio smoke check.');
// A workspace-local temp directory also works in Windows sandbox subprocesses.
const directory = mkdtempSync(join(root, '.stdio-smoke-'));
const statePath = join(directory, 'state.json');
const stderr = [];

async function session(operation) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: pluginRoot,
    env: { ...getDefaultEnvironment(), LOCUS_DATA_DIR: directory },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', chunk => stderr.push(String(chunk)));
  const client = new Client({ name: 'research-locus-built-stdio-smoke', version: '0.1.0' });
  try { await client.connect(transport); return await operation(client); }
  finally { await client.close(); }
}

try {
  const first = await session(async client => {
    const tools = (await client.listTools()).tools;
    const open = tools.find(tool => tool.name === 'locus.open');
    assert.equal(open.title, 'Research Locus');
    assert.deepEqual(open._meta['openai/ui'].entrypoints, [{ type: 'global' }]);
    assert.equal(open._meta.ui.resourceUri, 'ui://research-locus/home');
    assert.ok(client.getServerVersion().icons.length, 'Server provides a sidebar fallback icon.');
    for (const name of ['locus.open', 'locus.panel', 'locus.file', 'locus.state', 'locus.review', 'locus.extract_design', 'locus.verify_doi', 'locus.submit_finding', 'locus.ui_action', 'search_mentions']) assert.ok(tools.some(tool => tool.name === name), name);
    const home = await client.callTool({ name: 'locus.open', arguments: {} });
    assert.equal(home.structuredContent.page, 'home');
    assert.equal(home._meta.locusState, undefined);
    assert.ok(home._meta.locusCatalog);
    const initial = await client.callTool({ name: 'locus.state', arguments: {} });
    assert.equal(initial.structuredContent.state.revision, 0);
    assert.equal(initial._meta.locusState.fixture, true);
    assert.equal(initial.structuredContent.state.resources[0].content, undefined);
    const forged = await client.callTool({ name: 'locus.ui_action', arguments: { token: 'untrusted-channel-token', expectedRevision: 0, action: { type: 'pause' } } });
    assert.equal(forged.isError, true);
    const reviewed = await client.callTool({ name: 'locus.review', arguments: { expectedRevision: 0 } });
    assert.notEqual(reviewed.isError, true);
    assert.equal(reviewed.structuredContent.state.revision, 1);
    assert.equal(reviewed._meta.locusState.events.at(-1).actor.kind, 'agent');
    const homeResource = await client.readResource({ uri: 'ui://research-locus/home' });
    const token = homeResource.contents[0].text.match(/name="locus-ui-token" content="([^"]+)"/)?.[1];
    assert.ok(token, 'App resource includes a UI routing token; this does not authenticate a human.');
    const project = await client.callTool({ name: 'locus.catalog_action', arguments: { token, action: { type: 'create_project', title: 'Isolated smoke project' } } });
    const projectId = project._meta.locusCatalog.projects.find(item => item.title === 'Isolated smoke project').id;
    const created = await client.callTool({ name: 'locus.catalog_action', arguments: { token, action: { type: 'create_session', projectId, title: 'Isolated smoke session' } } });
    const sessionId = created.structuredContent.sessionId;
    assert.equal(created._meta.locusState.fixture, false);
    const sessionReview = await client.callTool({ name: 'locus.review', arguments: { sessionId, expectedRevision: 0 } });
    assert.equal(sessionReview.structuredContent.state.revision, 1);
    assert.equal(sessionReview.structuredContent.summary.claims, 0);
    // Synthetic UI-channel integration harness; never run against user dossiers.
    const population = await client.callTool({ name: 'locus.ui_action', arguments: { token, sessionId, expectedRevision: 1, action: { type: 'create_claim', text: 'Synthetic population claim', scope: 'population', metadata: { analysisUnit: 'cell', biologicalReplicates: 4, figureApplicable: true, figureSourceMatched: false }, rationale: 'Isolated packaged test' } } });
    assert.notEqual(population.isError, true);
    const causal = await client.callTool({ name: 'locus.ui_action', arguments: { token, sessionId, expectedRevision: 2, action: { type: 'create_claim', text: 'Synthetic causal claim', scope: 'causal', metadata: { perturbation: false, figureApplicable: false }, rationale: 'Isolated packaged test' } } });
    assert.notEqual(causal.isError, true);
    const realChecks = await client.callTool({ name: 'locus.review', arguments: { sessionId, expectedRevision: 3 } });
    assert.notEqual(realChecks.isError, true);
    assert.equal(realChecks.structuredContent.ruleReview.rulesVersion, 'metadata-checks.v3');
    assert.equal(realChecks.structuredContent.ruleReview.checks.length, 18);
    assert.equal(realChecks.structuredContent.summary.flagged, 3);
    assert.equal(realChecks.structuredContent.summary.needsInput, 12);
    assert.equal(realChecks._meta.locusState.findings.length, 3);
    const claimId = realChecks._meta.locusState.claims[0].id;
    const attached = await client.callTool({ name:'locus.ui_action', arguments:{token,sessionId,expectedRevision:4,action:{type:'attach_evidence',claimId,name:'synthetic-methods.txt',mediaType:'text/plain',content:'Synthetic test only. Sample sizes are reported per group.'}} });
    assert.notEqual(attached.isError,true);
    const input = attached._meta.locusState;
    const resourceIds = [input.resources[0].id];
    const request = await client.callTool({name:'locus.review_request',arguments:{token,sessionId,claimId,snapshotHash:input.snapshotHash,resourceIds,mode:'design',focus:'Synthetic packaged extraction'}});
    assert.notEqual(request.isError,true);
    const runId = request.structuredContent.run.id;
    const args = {sessionId,runId,claimId,resourceIds,snapshotHash:input.snapshotHash,expectedRevision:5};
    const preparation = await client.callTool({name:'locus.extract_design',arguments:args});
    assert.equal(preparation.structuredContent.selectedEvidence.length,1);
    const proposed = await client.callTool({name:'locus.extract_design',arguments:{...args,candidates:[{field:'sampleSizeReported',value:true,rationale:'Explicit sentence in synthetic fixture.',evidence:[{resourceId:resourceIds[0],quote:'Sample sizes are reported per group.',locator:'Sentence 2'}]}]}});
    assert.notEqual(proposed.isError,true);
    assert.equal(proposed._meta.locusState.claims[0].metadata.sampleSizeReported,undefined);
    const confirmed = await client.callTool({name:'locus.ui_action',arguments:{token,sessionId,expectedRevision:6,action:{type:'confirm_design',proposalId:proposed.structuredContent.proposal.id,selectedFields:['sampleSizeReported'],rationale:'Isolated UI-channel confirmation test'}}});
    assert.notEqual(confirmed.isError,true);
    assert.equal(confirmed._meta.locusState.claims[0].metadata.sampleSizeReported,true);
    let closure = confirmed._meta.locusState;
    const uiAction = async action => {
      const output = await client.callTool({name:'locus.ui_action',arguments:{token,sessionId,expectedRevision:closure.revision,action}});
      assert.notEqual(output.isError,true,JSON.stringify(output)); closure=output._meta.locusState; return closure;
    };
    await uiAction({type:'add_claim_relation',sourceClaimId:claimId,targetClaimId:closure.claims[1].id,kind:'depends_on',rationale:'Synthetic dependency for packaged integration'});
    const suggestion = await client.callTool({name:'locus.submit_finding',arguments:{sessionId,expectedRevision:closure.revision,claimId,title:'Synthetic bounded revision',rationale:'Packaged protocol fixture, not model inference',severity:'warning',category:'claim_scope',snapshotHash:closure.snapshotHash,resourceIds,revisionProposal:{text:'Synthetic sample-bounded observation',scope:'sample',evidenceNeeds:[{id:'independent',category:'replication',description:'Provide an independent unit analysis.'}]}}});
    assert.notEqual(suggestion.isError,true,JSON.stringify(suggestion)); closure=suggestion._meta.locusState;
    const findingId=closure.findings.at(-1).id;
    await uiAction({type:'apply_revision_proposal',findingId,acceptText:false,acceptScope:true,evidenceNeedIds:['independent'],rationale:'Accept scope and plan only'});
    assert.equal(closure.claims[0].text,'Synthetic population claim');
    assert.ok(closure.reReview.some(item=>item.claimId===closure.claims[1].id && item.status==='pending'));
    await uiAction({type:'apply_revision_proposal',findingId,acceptText:true,acceptScope:false,evidenceNeedIds:[],rationale:'Accept remaining text'});
    await uiAction({type:'link_evidence_requirement',claimId,requirementId:`proposal:${findingId}:independent`,resourceIds,rationale:'Synthetic source link is not scientific assessment'});
    await uiAction({type:'acknowledge_re_review',claimId:closure.claims[1].id,rationale:'Synthetic review record'});
    assert.equal(closure.claims[0].evidenceCeiling,'NOT_ASSESSED');
    assert.equal(closure.revisionAdoptions.length,2);
    assert.equal(closure.evidenceLinks.length,1);
    const receiptFiles={'code.txt':'# synthetic code, never executed','input.csv':'donor,count\na,1\nb,2\n','output.csv':'gene,effect\nX,1\n'};
    const ref=path=>({path,sha256:createHash('sha256').update(receiptFiles[path]).digest('hex')});
    await uiAction({type:'import_computational_receipt',claimId,rationale:'Isolated package transport test',receipt:{format:'generic',files:Object.entries(receiptFiles).map(([path,bytes])=>({path,contentBase64:Buffer.from(bytes).toString('base64')})),manifest:{schema:'locus.computational-receipt.v1',tool:{name:'Synthetic fixture',version:'test'},status:'unknown',code:ref('code.txt'),inputs:[ref('input.csv')],outputs:[ref('output.csv')],failures:[]}}});
    assert.equal(closure.resources.at(-1).computationReceipt.binding.status,'COMPLETE_BYTES');
    const citation=await client.callTool({name:'locus.verify_doi',arguments:{sessionId,claimId,expectedRevision:closure.revision,doi:'10.1234/synthetic-package-test',mode:'syntax_only'}});
    assert.notEqual(citation.isError,true,JSON.stringify(citation));closure=citation._meta.locusState;
    assert.deepEqual(citation.structuredContent.verification.actualLayers,['syntax']);
    assert.equal(citation.structuredContent.verification.existence,'not_checked');
    assert.equal(citation.structuredContent.state.resources.at(-2).content,undefined);
    assert.equal(citation.structuredContent.state.resources.at(-2).computationReceipt.verification.execution,'NOT_VERIFIED');
    return { tools: tools.length, revision: reviewed.structuredContent.state.revision, sessionId };
  });
  await session(async client => {
    const reopened = await client.callTool({ name: 'locus.state', arguments: {} });
    assert.equal(reopened.structuredContent.state.revision, first.revision);
    assert.equal(reopened._meta.locusState.events.at(-1).actor.id, 'mcp-agent');
    const catalog = await client.callTool({ name: 'locus.catalog', arguments: {} });
    assert.ok(catalog._meta.locusCatalog.sessions.some(item => item.id === first.sessionId));
    const resumedSession = await client.callTool({ name: 'locus.state', arguments: { sessionId: first.sessionId } });
    assert.equal(resumedSession._meta.locusState.fixture, false);
    assert.equal(resumedSession.structuredContent.state.revision, 15);
    assert.equal(resumedSession._meta.locusState.metadataReviews.at(-1).checks.length, 18);
    assert.equal(resumedSession._meta.locusState.findings.length, 4);
    assert.equal(resumedSession._meta.locusState.designProposals[0].status,'confirmed');
    assert.equal(resumedSession._meta.locusState.claims[0].metadata.sampleSizeReported,true);
    assert.equal(resumedSession._meta.locusState.claims[0].text,'Synthetic sample-bounded observation');
    assert.equal(resumedSession._meta.locusState.claims[0].scope,'sample');
    assert.equal(resumedSession._meta.locusState.claimRelations.length,1);
    assert.equal(resumedSession._meta.locusState.revisionAdoptions.length,2);
    assert.equal(resumedSession._meta.locusState.evidenceLinks.length,1);
    assert.ok(resumedSession._meta.locusState.reReview.some(item=>item.status==='pending'));
    assert.equal(resumedSession._meta.locusState.resources.at(-2).computationReceipt.binding.status,'COMPLETE_BYTES');
    assert.equal(resumedSession._meta.locusState.resources.at(-1).doiVerification.existence,'not_checked');
    const resource = await client.readResource({ uri: 'locus://resource/fixture-notes' });
    assert.equal(JSON.parse(resource.contents[0].text).id, 'fixture-notes');
  });
  assert.equal(stderr.join('').trim(), '', 'Unexpected child-process stderr');
  assert.ok(existsSync(statePath), 'Launcher honors LOCUS_DATA_DIR.');
  console.log(JSON.stringify({ status: 'PASS', scope: 'Packaged launcher, stdio protocol, catalog/session routing and restart persistence; not native ChatGPT host acceptance', tools: first.tools, persistedRevision: first.revision, persistedSessions: 2, designExtraction: 'PASS', coImprovement: 'PASS', closureRevision:15, computationalReceipt: 'PASS', doiSyntaxOnly: 'PASS', rulesPerClaim: 9, launcherSha256: createHash('sha256').update(readFileSync(entry)).digest('hex'), artifactSha256: createHash('sha256').update(readFileSync(join(pluginRoot, 'dist', 'server.js'))).digest('hex'), isolatedState: true, stderrEmpty: true }, null, 2));
} catch (error) {
  if (stderr.length) console.error(stderr.join(''));
  throw error;
} finally {
  // Verify the absolute deletion target is the freshly created workspace child.
  const target = realpathSync(directory);
  assert.equal(dirname(target).toLowerCase(), realpathSync(root).toLowerCase());
  assert.ok(basename(target).startsWith('.stdio-smoke-'));
  rmSync(target, { recursive: true });
}
