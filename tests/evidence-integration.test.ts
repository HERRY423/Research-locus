import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DomainError, ReviewStore, verifyState, type ReviewState } from '../src/domain.js';
import { WorkspaceCatalog } from '../src/catalog.js';
import { createHttpWorkbench } from '../src/server.js';
import { createMcpServer } from '../src/mcp.js';
import { assertDoiVerification, type DoiFetch, type DoiVerification } from '../src/doi-verification.js';
import { sha256, type ComputationalReceiptInput } from '../src/computational-receipts.js';
import { selectedEvidenceText, quoteInSelectedResource, MAX_SELECTED_TEXT_CHARS, MAX_ARTIFACT_TEXT_CHARS } from '../src/resource-text.js';

const human = {kind:'researcher' as const,id:'synthetic-evidence-test'};
const doi='10.1234/integration-fixture';
const expected={title:'Synthetic multi-donor analysis',year:2024,authors:['Ana Example']};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function fixtureFetch(onRequest:()=>void=()=>undefined):DoiFetch {
  return async url=>{onRequest();return url.includes('api.crossref.org')?json({message:{DOI:doi,title:[expected.title],published:{'date-parts':[[2024]]},author:[{given:'Ana',family:'Example'}]}}):json({error:'not found'},404);};
}
function setup(filePath?:string) {
  const store=new ReviewStore({initial:{projectId:'synthetic-evidence-integration',title:'Synthetic evidence intake'},...(filePath?{filePath}:{})});
  const state=store.act({type:'create_claim',text:'Synthetic multi-donor effect',scope:'population',rationale:'Integration fixture'},0,human);
  return {store,claimId:state.claims[0].id,state};
}
const errorCode=(code:string)=>(error:unknown)=>error instanceof DomainError && error.code===code;

test('server-owned DOI lookup attaches a persisted receipt, audit event and changed snapshot without promoting evidence ceiling',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'locus-doi-integration-'));
  try {
    const filePath=join(directory,'state.json');
    const {store,claimId,state:before}=setup(filePath);
    let requests=0;
    const state=await store.verifyDoi(claimId,{doi,expected},before.revision,{fetchImpl:fixtureFetch(()=>requests++)});
    assert.equal(requests,2);assert.equal(state.revision,before.revision+1);assert.notEqual(state.snapshotHash,before.snapshotHash);
    const resource=state.resources.at(-1)!;
    assert.equal(resource.evidenceKind,'doi_verification');assert.equal(resource.sourceKind,'host_resource');
    assert.ok(state.claims[0].resourceIds.includes(resource.id));assert.equal(state.claims[0].evidenceCeiling,'NOT_ASSESSED');
    assert.deepEqual(JSON.parse(resource.content),resource.doiVerification);assertDoiVerification(resource.doiVerification);
    assert.equal(resource.doiVerification!.metadata,'match');assert.equal(resource.doiVerification!.existence,'found');
    const event=state.events.at(-1)!;
    assert.equal(event.action.type,'record_doi_verification');assert.equal(event.actor.id,'system:doi-registry');
    if(event.action.type==='record_doi_verification')assert.deepEqual(event.action.input,{doi,expected});
    verifyState(state);
    const restored=new ReviewStore({filePath,requireExisting:true}).getState();assert.deepEqual(restored,state);
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));
    rmSync(directory,{recursive:true,force:true});
  }
});

test('syntax-only, invalid DOI and registry failure store their actual limited layers',async()=>{
  const {store,claimId}=setup();let requests=0;
  const syntax=await store.verifyDoi(claimId,{doi,mode:'syntax_only',expected},store.getState().revision,{fetchImpl:fixtureFetch(()=>requests++)});
  assert.equal(requests,0);assert.equal(syntax.resources.at(-1)!.doiVerification!.syntax,'valid');
  assert.equal(syntax.resources.at(-1)!.doiVerification!.existence,'not_checked');assert.equal(syntax.resources.at(-1)!.doiVerification!.metadata,'not_checked');
  const invalid=await store.verifyDoi(claimId,{doi:'not-a-doi'},store.getState().revision,{fetchImpl:fixtureFetch(()=>requests++)});
  assert.equal(requests,0);assert.equal(invalid.resources.at(-1)!.doiVerification!.syntax,'invalid');
  const failed=await store.verifyDoi(claimId,{doi,expected},store.getState().revision,{fetchImpl:async()=>{requests++;throw new Error('private diagnostic must not escape');}});
  const result=failed.resources.at(-1)!.doiVerification!;
  assert.equal(requests,2);assert.equal(result.existence,'unknown');assert.equal(result.metadata,'not_checked');
  assert.deepEqual(result.actualLayers,['syntax','registry_lookup']);assert.ok(result.sources.every(source=>source.error==='network_error'));
  assert.equal(result.contentSupport,'not_checked');assert.equal(result.scientificValidity,'not_checked');assert.ok(!JSON.stringify(failed).includes('private diagnostic'));
  verifyState(failed);
});

test('supplied DOI reports cannot cross action boundary even with a claimed server actor',async()=>{
  const {store,claimId}=setup();
  const completed=await store.verifyDoi(claimId,{doi,mode:'syntax_only'},store.getState().revision,{fetchImpl:fixtureFetch()});
  const result=completed.resources.at(-1)!.doiVerification!;
  const action={type:'record_doi_verification',claimId,input:{doi,mode:'syntax_only'},result};
  for(const actor of [human,{kind:'agent' as const,id:'system:doi-registry'}])assert.throws(()=>store.act(action,completed.revision,actor),errorCode('SERVER_VERIFICATION_REQUIRED'));
  assert.deepEqual(store.getState(),completed);
});

test('DOI preflight rejects stale, missing, paused and malformed requests before any network call',async()=>{
  const {store,claimId,state}=setup();let requests=0;
  const options={fetchImpl:fixtureFetch(()=>requests++)};
  await assert.rejects(store.verifyDoi(claimId,{doi},0,options),errorCode('REVISION_CONFLICT'));
  await assert.rejects(store.verifyDoi('not-present',{doi},state.revision,options),errorCode('NOT_FOUND'));
  await assert.rejects(store.verifyDoi(claimId,{doi,expected:{year:'2024'} as never},state.revision,options),/DOI_YEAR_INVALID/);
  store.act({type:'pause'},state.revision,human);
  await assert.rejects(store.verifyDoi(claimId,{doi},store.getState().revision,options),errorCode('REVIEW_PAUSED'));
  assert.equal(requests,0);assert.equal(store.getState().resources.length,0);
});

test('concurrent revision change while registry calls are pending does not attach results to stale material',async()=>{
  const {store,claimId,state}=setup();let release!:()=>void,started!:()=>void,requests=0;
  const gate=new Promise<void>(resolve=>release=resolve),entered=new Promise<void>(resolve=>started=resolve);
  const baseFetch=fixtureFetch();
  const lookup=store.verifyDoi(claimId,{doi,expected},state.revision,{fetchImpl:async(url,init)=>{if(++requests===2)started();await gate;return baseFetch(url,init);}});
  await entered;
  const revised=store.act({type:'revise_claim',claimId,text:'Synthetic narrowed donor claim',scope:'sample',rationale:'Changed during lookup'},state.revision,human);
  release();await assert.rejects(lookup,errorCode('REVISION_CONFLICT'));
  assert.deepEqual(store.getState(),revised);assert.equal(store.getState().resources.length,0);
});

test('HTTP DOI operation enforces UI channel, origin, schema and selected session boundaries',async()=>{
  const {store}=setup(),catalog=new WorkspaceCatalog({legacyStore:store});
  const project=catalog.createProject('Synthetic DOI HTTP').projects.at(-1)!;
  const a=catalog.createSession(project.id,'A'),b=catalog.createSession(project.id,'B');
  for(const sessionId of [a.sessionId,b.sessionId])catalog.getStore(sessionId).act({type:'create_claim',text:`Synthetic ${sessionId}`,scope:'sample',rationale:'Fixture'},0,human);
  const beforeA=catalog.getStore(a.sessionId).getState(),beforeB=catalog.getStore(b.sessionId).getState(),legacy=store.getState();
  let requests=0;
  const server=createHttpWorkbench(store,'<html></html>','doi-ui-token',catalog,{fetchImpl:fixtureFetch(()=>requests++)});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const body={sessionId:b.sessionId,claimId:beforeB.claims[0].id,input:{doi,expected},expectedRevision:beforeB.revision};
  const post=(value:unknown,headers:Record<string,string>={},path='/api/verify-doi')=>fetch(`${base}${path}`,{method:'POST',headers:{'Content-Type':'application/json','X-Locus-UI':'doi-ui-token',...headers},body:JSON.stringify(value)});
  try {
    assert.equal((await post(body,{'X-Locus-UI':'wrong'})).status,403);
    assert.equal((await post(body,{Origin:'https://evil.example'})).status,403);
    assert.equal((await post(body,{'Content-Type':'text/plain'})).status,415);
    assert.equal((await post({...body,result:{existence:'found'}})).status,400);
    assert.equal((await post({...body,input:{doi,url:'https://evil.example'}})).status,400);
    assert.equal((await post(body,{},`/api/verify-doi?sessionId=${a.sessionId}`)).status,400);
    assert.equal((await post({...body,sessionId:'no-such-session'})).status,400);
    assert.equal(requests,0);
    const response=await post(body);assert.equal(response.status,200);
    const after=await response.json() as ReviewState;
    assert.equal(after.resources.at(-1)!.doiVerification!.metadata,'match');assert.equal(requests,2);
    assert.deepEqual(catalog.getStore(a.sessionId).getState(),beforeA);assert.deepEqual(store.getState(),legacy);
    assert.equal((await post(body)).status,409);assert.equal(requests,2);
    const forged={type:'record_doi_verification',claimId:beforeB.claims[0].id,input:body.input,result:after.resources.at(-1)!.doiVerification};
    assert.equal((await post({sessionId:b.sessionId,expectedRevision:after.revision,action:forged},{},'/api/action')).status,403);
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('MCP DOI tool returns actual limited layers, local field comparison and compact evidence state',async t=>{
  const {store,claimId}=setup(),catalog=new WorkspaceCatalog({legacyStore:store});let requests=0;
  const server=createMcpServer(store,'<html></html>','doi-mcp-token',catalog,{fetchImpl:fixtureFetch(()=>requests++)});
  const client=new Client({name:'doi-integration-test',version:'1.0.0'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);await client.connect(clientTransport);
  t.after(async()=>{await client.close();await server.close();});
  const call=(args:Record<string,unknown>)=>client.callTool({name:'locus.verify_doi',arguments:{claimId,expectedRevision:store.getState().revision,...args}});
  const syntax=await call({doi,mode:'syntax_only',expected});assert.notEqual(syntax.isError,true);assert.equal(requests,0);
  const syntaxResult=(syntax.structuredContent as {verification:DoiVerification}).verification;
  assert.deepEqual(syntaxResult.actualLayers,['syntax']);assert.equal(syntaxResult.existence,'not_checked');
  assert.match(JSON.stringify(syntax.content),/格式正确不等于引用已核验/);
  const checked=await call({doi,expected});assert.notEqual(checked.isError,true);assert.equal(requests,2);
  const payload=checked.structuredContent as {verification:DoiVerification;state:{resources:Array<Record<string,unknown>>;events:Array<Record<string,unknown>>}};
  assert.equal(payload.verification.existence,'found');assert.equal(payload.verification.metadata,'match');assertDoiVerification(payload.verification);
  assert.ok(payload.state.resources.every(resource=>!('content' in resource) && typeof resource.resourceUri==='string'));
  assert.ok(payload.state.events.every(event=>!('action' in event)));
  assert.match(JSON.stringify(checked.content),/未核验论文全文支持性或科学有效性/);
  assert.equal((await call({doi,result:{existence:'found'}})).isError,true);assert.equal(requests,2);
});

function privateBundle(marker:string):ComputationalReceiptInput {
  const raw:Record<string,string>={
    'analysis.R':'# synthetic code; not executed',
    'counts.csv':'donor,count\na,12\nb,14\n',
    'de.csv':`gene,summary\nX,${marker}_TABLE\n`,
    'audit.json':JSON.stringify({overall_status:'NEEDS_DATA',passed:false,checks:[{note:`${marker}_AUDIT`}],findings:[],cohort_summary:{n_donors:8}}),
    'audit-full.md':`# ${marker}_FULL`,
    'REVIEW.md':`# ${marker}_REVIEW`,
    'receipt.json':JSON.stringify({fit_status:'COMPLETE',statistical_unit:'donor',n_donors:8,notes:`${marker}_EXECUTION`,errors:[`${marker}_FAILURE`]}),
  };
  const reference=(path:string)=>({name:path,sha256:sha256(raw[path])});
  raw['manifest.json']=JSON.stringify({schema:'bionexus.de-shadow-bundle.v1',bionexus_version:'fixture',scientific_authorization:'NONE',data_origin:'SYNTHETIC_DEMO',audit_sha256:sha256(raw['audit.json']),inputs:{analysis_code:reference('analysis.R'),sample_sheet:reference('counts.csv'),de_table:reference('de.csv'),execution_record:reference('receipt.json')}});
  return {format:'bionexus-de',files:Object.entries(raw).map(([path,text])=>({path,contentBase64:Buffer.from(text).toString('base64')}))};
}

test('MCP compact state and snapshot refs hide receipt text; selected reads and extraction share bounded artifact quote sources',async t=>{
  const {store,claimId}=setup();
  for(const marker of ['SELECTED_PRIVATE','UNSELECTED_PRIVATE'])store.act({type:'import_computational_receipt',claimId,receipt:privateBundle(marker),rationale:'Synthetic selection privacy test'},store.getState().revision,human);
  const original=store.getState(),selected=original.resources[0],unselected=original.resources[1];
  const catalog=new WorkspaceCatalog({legacyStore:store});
  const server=createMcpServer(store,'<html></html>','selection-token',catalog),client=new Client({name:'selected-receipt-test',version:'1.0.0'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await server.connect(serverTransport);await client.connect(clientTransport);
  t.after(async()=>{await client.close();await server.close();});
  const call=(name:string,args:Record<string,unknown>={})=>client.callTool({name,arguments:args});
  const response=await call('locus.state');
  const compact=(response.structuredContent as {state:Record<string,unknown>}).state;
  const compactText=JSON.stringify(compact);
  for(const marker of ['SELECTED_PRIVATE','UNSELECTED_PRIVATE','contentBase64','"preview"','"executionReceipt"','"audit":'])assert.ok(!compactText.includes(marker),marker);
  const summaries=compact.resources as Array<{computationReceipt:{binding:{status:string};artifactCount:number;failureSummary:{count:number};bundle:{auditCheckCount:number};explicitReadRequired:boolean}}>;
  assert.equal(summaries[0].computationReceipt.binding.status,'COMPLETE_BYTES');assert.equal(summaries[0].computationReceipt.failureSummary.count,1);
  assert.equal(summaries[0].computationReceipt.bundle.auditCheckCount,1);assert.equal(summaries[0].computationReceipt.explicitReadRequired,true);
  assert.equal((compact.snapshots as unknown[]).length,original.snapshots.length);
  const sessionRead=await client.readResource({uri:'locus://project/state'});
  assert.ok('text' in sessionRead.contents[0]);assert.ok(!sessionRead.contents[0].text.includes('UNSELECTED_PRIVATE'));
  const read=await client.readResource({uri:`locus://resource/${selected.id}`});assert.ok('text' in read.contents[0]);
  const selectedRecord=JSON.parse(read.contents[0].text) as typeof selected & {evidenceText:NonNullable<ReturnType<typeof selectedEvidenceText>>};
  assert.equal(selectedRecord.content,selected.content);assert.deepEqual(selectedRecord.computationReceipt,selected.computationReceipt);
  assert.ok(read.contents[0].text.includes('SELECTED_PRIVATE'));assert.ok(!read.contents[0].text.includes('UNSELECTED_PRIVATE'));
  assert.deepEqual(selectedRecord.evidenceText,selectedEvidenceText(selected));
  const runResult=await call('locus.review_request',{token:'selection-token',sessionId:'legacy',claimId,snapshotHash:original.snapshotHash,resourceIds:[selected.id],mode:'design',focus:'Selected receipt only'});
  assert.notEqual(runResult.isError,true);const run=(runResult.structuredContent as {run:{id:string}}).run;
  const args={sessionId:'legacy',runId:run.id,expectedRevision:original.revision,claimId,snapshotHash:original.snapshotHash,resourceIds:[selected.id]};
  const prepare=await call('locus.extract_design',args);assert.notEqual(prepare.isError,true);
  const refs=(prepare.structuredContent as {selectedEvidence:Array<{id:string;quoteSource:string}>}).selectedEvidence;
  assert.deepEqual(refs.map(ref=>ref.id),[selected.id]);assert.equal(refs[0].quoteSource,'evidenceText.chunks');
  assert.ok(!JSON.stringify(prepare.structuredContent).includes('UNSELECTED_PRIVATE'));
  const cite={resourceId:selected.id,quote:'"statistical_unit":"donor"',locator:'artifact:receipt.json'};
  assert.ok(!selected.content.includes(cite.quote),'Original receipt bytes remain an encoded package, not the quote source');
  const candidates=[{field:'analysisUnit',value:'donor',rationale:'Exact selected producer declaration; not independently verified.',evidence:[cite]}];
  assert.equal((await call('locus.extract_design',{...args,candidates:[{...candidates[0],evidence:[{...cite,locator:'artifact:de.csv'}]}]})).isError,true);
  assert.equal((await call('locus.extract_design',{...args,candidates:[{...candidates[0],evidence:[{...cite,resourceId:unselected.id}]}]})).isError,true);
  const submitted=await call('locus.extract_design',{...args,candidates});assert.notEqual(submitted.isError,true,JSON.stringify(submitted));
  const final=store.getState();assert.equal(final.designProposals?.at(-1)?.candidates[0].value,'donor');assert.equal(final.claims[0].metadata.analysisUnit,undefined);
  assert.deepEqual(final.resources,original.resources);verifyState(final);
});

test('selected receipt text is bounded with source hashes and cannot validate omitted tails or wrong artifacts',()=>{
  const {store,claimId}=setup();
  const files=Array.from({length:6},(_,i)=>({path:`output-${i}.csv`,contentBase64:Buffer.from(`${'x'.repeat(20_000)}TAIL_${i}`).toString('base64')}));
  const receipt:ComputationalReceiptInput={format:'generic',files,manifest:{schema:'locus.computational-receipt.v1',tool:{name:'fixture',version:'1'},status:'unknown',code:{},inputs:[],outputs:files.map(file=>({path:file.path,sha256:sha256(Buffer.from(file.contentBase64,'base64'))})),failures:[]}};
  const state=store.act({type:'import_computational_receipt',claimId,receipt,rationale:'Bounded view test'},store.getState().revision,human);
  const resource=state.resources[0],view=selectedEvidenceText(resource)!;
  assert.equal(view.chunks.reduce((n,chunk)=>n+chunk.text.length,0),MAX_SELECTED_TEXT_CHARS);
  assert.ok(view.chunks.every(chunk=>chunk.text.length<=MAX_ARTIFACT_TEXT_CHARS && chunk.truncated));assert.equal(view.omittedArtifacts.length,2);
  assert.equal(view.chunks[0].artifactSha256,sha256(Buffer.from(files[0].contentBase64,'base64')));
  assert.equal(quoteInSelectedResource(resource,'TAIL_0','artifact:output-0.csv'),false);
  assert.equal(quoteInSelectedResource(resource,'xxxx','artifact:output-5.csv'),false);
  assert.equal(quoteInSelectedResource(resource,'xxxx','artifact:output-0.csv'),true);
});
