import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { assertDoiVerification, normalizeDoi, parseDoiVerificationInput, verifyDoi, type DoiFetch } from '../src/doi-verification.js';

const doi = '10.1234/fixture';
const expected = { title: 'A donor-aware study', year: 2024, authors: ['Ana García', 'Bo Li'] };
const now = () => new Date('2026-10-05T12:00:00.000Z');
const crossref = (extra: Record<string, unknown> = {}) => ({ message: { DOI: doi, title: [expected.title], author: [{ given: 'Ana', family: 'García' }, { given: 'Bo', family: 'Li' }], published: { 'date-parts': [[2024, 2, 10]] }, ...extra } });
const datacite = (extra: Record<string, unknown> = {}) => ({ data: { id: doi, type: 'dois', attributes: { doi, titles: [{title: expected.title}], creators: [{ givenName: 'Ana', familyName: 'García', name: 'García, Ana' }, { givenName: 'Bo', familyName: 'Li', name: 'Li, Bo' }], publicationYear: 2024, ...extra } } });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const missing = () => json({ error: 'not found' }, 404);
function routes(cr: () => Response = () => json(crossref()), dc: () => Response = missing): DoiFetch { return async url => url.startsWith('https://api.crossref.org/') ? cr() : dc(); }

test('DOI format checks and syntax-only mode never claim registry or scientific verification', async () => {
  let requests = 0;
  const fetchImpl: DoiFetch = async () => { requests++; throw new Error('unexpected'); };
  for (const input of ['not a DOI', 'https://evil.example/10.1234/a', 'https://doi.org@evil.example/10.1234/a', 'https://doi.org/10.1234/a?token=private', '10.1234/a b', 'https://doi.org:8443/10.1234/a']) {
    const result = await verifyDoi({ doi: input }, { fetchImpl, now });
    assert.equal(result.syntax, 'invalid'); assert.equal(result.existence, 'not_checked'); assert.equal(result.metadata, 'not_checked');
    assert.deepEqual(result.actualLayers, ['syntax']); assertDoiVerification(result);
  }
  const result = await verifyDoi({ doi: ' https://doi.org/10.1234/FIXTURE ', mode: 'syntax_only', expected }, { fetchImpl, now });
  assert.equal(result.normalizedDoi, doi); assert.equal(result.syntax, 'valid'); assert.equal(result.existence, 'not_checked');
  assert.equal(result.contentSupport, 'not_checked'); assert.equal(result.scientificValidity, 'not_checked'); assert.equal(requests, 0); assertDoiVerification(result);
  assert.equal(normalizeDoi('DOI: 10.1234/FIXTURE'), doi); assert.equal(normalizeDoi('https://dx.doi.org/10.1234/abc%28d%29'), '10.1234/abc(d)');
});

test('successful registry receipts bind raw response bytes, actual layers and expected fields without transmitting metadata', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const raw = JSON.stringify(crossref());
  const fetchImpl: DoiFetch = async (url, init) => { calls.push({url, init}); return url.includes('crossref') ? new Response(raw) : missing(); };
  const result = await verifyDoi({ doi, expected }, { fetchImpl, now });
  assert.equal(result.existence, 'found'); assert.equal(result.metadata, 'match');
  assert.deepEqual(result.actualLayers, ['syntax', 'registry_lookup', 'bibliographic_comparison']);
  assert.equal(result.sources[0].responseSha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(result.sources[1].status, 'not_found'); assert.equal(result.checkedAt, now().toISOString());
  assert.equal(calls.length, 2);
  for (const {url, init} of calls) {
    assert.equal(new URL(url).search, ''); assert.ok(url.endsWith(encodeURIComponent(doi))); assert.ok(!url.includes('donor'));
    assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit'); assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    assert.ok(init.signal instanceof AbortSignal);
  }
  assertDoiVerification(result);
});

test('a provider 404 does not imply global nonexistence; failure stays unknown and both404 are explicitly scoped', async () => {
  const mixed = await verifyDoi({ doi }, { fetchImpl: routes(missing, () => json(datacite())) });
  assert.equal(mixed.existence, 'found'); assert.equal(mixed.metadata, 'not_checked'); assert.deepEqual(mixed.actualLayers, ['syntax', 'registry_lookup']); assertDoiVerification(mixed);
  const failed = await verifyDoi({ doi, expected }, { fetchImpl: routes(missing, () => json({error:'unavailable'}, 503)) });
  assert.equal(failed.existence, 'unknown'); assert.equal(failed.metadata, 'not_checked'); assert.equal(failed.sources[1].error, 'http_error'); assertDoiVerification(failed);
  const absent = await verifyDoi({ doi }, { fetchImpl: routes(missing, missing) });
  assert.equal(absent.existence, 'not_found'); assert.equal(absent.existenceScope, 'queried_public_registries_only');
  assert.ok(absent.limitations.some(text => text.includes('不等于 DOI 在全球不存在'))); assertDoiVerification(absent);
});

test('wrong DOI, malformed JSON, malformed records and network exceptions do not manufacture found results', async () => {
  for (const [response, error] of [
    [() => json(crossref({DOI:'10.1234/other'})), 'doi_mismatch'],
    [() => new Response('<html>upstream error</html>'), 'invalid_json'],
    [() => json({message:'not a work'}), 'invalid_record'],
    [() => {throw new Error('secret-proxy-path-and-token');}, 'network_error'],
  ] as const) {
    const result = await verifyDoi({doi, expected}, {fetchImpl:routes(response, missing)});
    assert.equal(result.existence, 'unknown'); assert.equal(result.sources[0].error, error); assert.equal(result.sources[0].record, undefined);
    assert.ok(!JSON.stringify(result).includes('secret-proxy')); assertDoiVerification(result);
  }
  const conflictingId = datacite(); conflictingId.data.id = '10.1234/wrong';
  const result = await verifyDoi({doi}, {fetchImpl:routes(missing, () => json(conflictingId))});
  assert.equal(result.sources[1].error, 'invalid_record'); assert.equal(result.existence, 'unknown');
});

test('metadata comparisons preserve title meaning and full ordered author identities', async () => {
  const normalized = await verifyDoi({doi, expected:{...expected,title:'  A  DONOR-AWARE\nSTUDY ', authors:['Ana Garci\u0301a','BO LI']}}, {fetchImpl:routes()});
  assert.equal(normalized.metadata,'match');
  for (const changed of [
    {...expected,title:'A donor aware study'},
    {...expected,authors:['García','Li']},
    {...expected,authors:['Ana García']},
    {...expected,authors:['Bo Li','Ana García']},
    {...expected,authors:['Ana García et al.']},
    {...expected,year:2023},
  ]) {
    const result = await verifyDoi({doi,expected:changed},{fetchImpl:routes()}); assert.equal(result.metadata,'mismatch'); assertDoiVerification(result);
  }
  const incomplete = await verifyDoi({doi,expected:{authors:['García','Li']}},{fetchImpl:routes(()=>json(crossref({author:[{family:'García'},{family:'Li'}]})))});
  assert.equal(incomplete.fieldChecks.authors.status,'incomplete'); assertDoiVerification(incomplete);
});

test('missing fields and online/print year ambiguity remain incomplete; unrequested fields remain not_checked', async () => {
  const missingFields = await verifyDoi({doi,expected},{fetchImpl:routes(()=>json(crossref({title:[],author:[],published:null})))});
  assert.equal(missingFields.metadata,'incomplete'); assert.ok(Object.values(missingFields.fieldChecks).every(check=>check.status==='incomplete')); assertDoiVerification(missingFields);
  const ambiguous = await verifyDoi({doi,expected:{year:2024}},{fetchImpl:routes(()=>json(crossref({'published-online':{'date-parts':[[2023]]}})))});
  assert.equal(ambiguous.fieldChecks.year.status,'incomplete'); assert.equal(ambiguous.fieldChecks.title.status,'not_checked'); assert.equal(ambiguous.metadata,'incomplete'); assertDoiVerification(ambiguous);
});

test('registry conflicts are visible and cannot be hidden by a matching provider', async () => {
  const result = await verifyDoi({doi,expected},{fetchImpl:routes(()=>json(crossref()),()=>json(datacite({titles:[{title:'A different study'}],publicationYear:2025})))});
  assert.equal(result.existence,'found'); assert.equal(result.metadata,'mismatch');
  assert.deepEqual(result.fieldChecks.title.results.map(source=>source.status),['match','mismatch']);
  assert.equal(result.fieldChecks.authors.status,'match'); assertDoiVerification(result);
});

test('redirects are refused without following arbitrary destinations and response byte limits cover streams', async () => {
  let requests = 0;
  const redirect = await verifyDoi({doi},{fetchImpl:async (_url, init)=>{requests++;assert.equal(init.redirect,'manual');return new Response(null,{status:302,headers:{Location:'http://127.0.0.1/private'}});}});
  assert.equal(requests,2); assert.ok(redirect.sources.every(source=>source.error==='redirect_refused')); assert.equal(redirect.existence,'unknown'); assertDoiVerification(redirect);
  const large = await verifyDoi({doi},{maxResponseBytes:16,fetchImpl:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(9));controller.enqueue(new Uint8Array(9));controller.close();}}))});
  assert.ok(large.sources.every(source=>source.error==='response_too_large' && source.responseSha256===null)); assertDoiVerification(large);
  const headerLarge = await verifyDoi({doi},{maxResponseBytes:16,fetchImpl:async()=>new Response('small',{headers:{'content-length':'9000000'}})});
  assert.ok(headerLarge.sources.every(source=>source.error==='response_too_large'));
});

test('timeouts cover request and body reading; delayed fetch cannot change returned result', async () => {
  const never: DoiFetch = async()=>new Promise<Response>(()=>undefined);
  const result = await verifyDoi({doi,expected},{timeoutMs:5,fetchImpl:never});
  assert.equal(result.existence,'unknown'); assert.ok(result.sources.every(source=>source.error==='timeout')); assertDoiVerification(result);
  const delayed = await verifyDoi({doi},{timeoutMs:5,fetchImpl:async()=>{await new Promise(resolve=>setTimeout(resolve,25));return json(crossref());}});
  const saved = JSON.stringify(delayed); await new Promise(resolve=>setTimeout(resolve,40)); assert.equal(JSON.stringify(delayed),saved);
  const stalled = await verifyDoi({doi},{timeoutMs:5,fetchImpl:async()=>new Response(new ReadableStream({start(){/* a bounded timeout must stop waiting */}}))});
  assert.ok(stalled.sources.every(source=>source.error==='timeout')); assertDoiVerification(stalled);
});

test('strict input and receipt sanity reject forged layers, hosts, outcomes and metadata', async () => {
  for (const input of [{doi,expected:{year:'2024'}},{doi,expected:{authors:[]}},{doi,expected:{title:''}},{doi,expected:{unknown:true}},{doi,mode:'verified'},{doi,url:'http://localhost'}]) assert.throws(()=>parseDoiVerificationInput(input));
  const result = await verifyDoi({doi,expected},{fetchImpl:routes()});
  for (const mutate of [
    (r:typeof result)=>{r.scientificValidity='verified' as never;},
    (r:typeof result)=>{r.sources[0].url='https://evil.example/';},
    (r:typeof result)=>{r.fieldChecks.year.status='mismatch';},
    (r:typeof result)=>{r.actualLayers=['syntax'];},
    (r:typeof result)=>{r.sources[0].responseSha256='made-up';},
    (r:typeof result)=>{r.sources[0].record!.doi='10.1234/other';},
    (r:typeof result)=>{r.existence='not_found';},
  ]) { const tampered=structuredClone(result);mutate(tampered);assert.throws(()=>assertDoiVerification(tampered),/DOI_VERIFICATION_INVALID/); }
});
