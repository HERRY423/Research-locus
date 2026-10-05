import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createHttpWorkbench } from '../src/server.js';
import { ReviewStore } from '../src/domain.js';
import { WorkspaceCatalog } from '../src/catalog.js';

test('HTTP local UI round-trip, durable revision semantics and origin boundary', async () => {
  const store = new ReviewStore();
  const server = createHttpWorkbench(store, '<html>__LOCUS_UI_TOKEN__</html>', 'test-channel-token');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const before = await (await fetch(`${base}/api/state`)).json();
    assert.equal(before.scientificAuthorization, 'NONE');
    const request = (body: unknown, headers: Record<string,string> = {}) => fetch(`${base}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Locus-UI': 'test-channel-token', ...headers }, body: JSON.stringify(body) });
    const body = { action: {type:'pause'}, expectedRevision: before.revision };
    assert.equal((await request(body, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await request(body, { 'X-Locus-UI': 'wrong' })).status, 403);
    assert.equal((await request({...body, actor: {kind:'researcher'}})).status, 400);
    const ok = await request(body); assert.equal(ok.status, 200);
    const after = await ok.json(); assert.equal(after.reviewStatus, 'paused');
    assert.equal((await request(body)).status, 409);
    assert.equal((await fetch(`${base}/api/dossier`)).status, 200);
    const exported = await fetch(`${base}/api/export?revision=${after.revision}`);
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition')!, /attachment; filename="research-locus-rev-1.json"/);
    assert.deepEqual(await exported.json(), after);
    assert.equal((await fetch(`${base}/api/export?revision=${before.revision}`)).status, 409);
    const wrongHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${base}/api/state`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    assert.equal(wrongHostStatus, 403);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('SSE publishes a real new revision after a separate UI action', async () => {
  const store = new ReviewStore();
  const server = createHttpWorkbench(store, '<html></html>', 'sse-token');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.ok(initial.includes('"revision":0'));
    const mutation = await fetch(`${base}/api/action`, { method:'POST', headers:{'Content-Type':'application/json','X-Locus-UI':'sse-token'}, body:JSON.stringify({action:{type:'pause'},expectedRevision:0}) });
    assert.equal(mutation.status,200);
    const update = new TextDecoder().decode((await reader.read()).value);
    assert.ok(update.includes('"revision":1'));
    assert.ok(update.includes('"reviewStatus":"paused"'));
    await reader.cancel();
  } finally { clearTimeout(deadline); controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('HTTP catalog writes require UI token and session queries isolate state, actions, export and SSE', async () => {
  const store = new ReviewStore();
  const catalog = new WorkspaceCatalog({ legacyStore: store });
  const server = createHttpWorkbench(store, '<html></html>', 'catalog-token', catalog);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 6000);
  const post = (path: string, body: unknown, token = 'catalog-token') => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Locus-UI': token }, body: JSON.stringify(body) });
  try {
    const legacy = JSON.stringify(store.getState());
    const before = await (await fetch(`${base}/api/catalog`)).json();
    await fetch(`${base}/api/catalog`);
    assert.equal(JSON.stringify(store.getState()), legacy);
    assert.equal((await post('/api/catalog/action', { action: { type: 'create_project', title: 'Denied' } }, 'wrong')).status, 403);
    const projects = await (await post('/api/catalog/action', { action: { type: 'create_project', title: 'HTTP project' } })).json();
    assert.equal(projects.projects.length, before.projects.length + 1);
    const projectId = projects.projects.find((item: { title: string }) => item.title === 'HTTP project').id;
    const a = await (await post('/api/catalog/action', { action: { type: 'create_session', projectId, title: 'A' } })).json();
    const b = await (await post('/api/catalog/action', { action: { type: 'create_session', projectId, title: 'B' } })).json();
    assert.equal(a.state.fixture, false); assert.equal(b.state.fixture, false);
    const response = await fetch(`${base}/api/events?sessionId=${a.sessionId}`, { signal: controller.signal });
    const reader = response.body!.getReader();
    assert.ok(new TextDecoder().decode((await reader.read()).value).includes('"revision":0'));
    assert.equal((await post('/api/action', { sessionId: b.sessionId, expectedRevision: 0, action: { type: 'pause' } })).status, 200);
    const changedA = await (await post(`/api/action?sessionId=${a.sessionId}`, { expectedRevision: 0, action: { type: 'create_claim', text: 'Only session A', scope: 'sample', rationale: 'Selected session only.' } })).json();
    const event = new TextDecoder().decode((await reader.read()).value);
    assert.ok(event.includes('Only session A')); assert.ok(!event.includes('"reviewStatus":"paused"'));
    assert.equal((await (await fetch(`${base}/api/state?sessionId=${b.sessionId}`)).json()).claims.length, 0);
    assert.equal((await post(`/api/action?sessionId=${a.sessionId}`, { sessionId: b.sessionId, expectedRevision: 1, action: { type: 'resume' } })).status, 400);
    const exported = await fetch(`${base}/api/export?sessionId=${a.sessionId}&revision=${changedA.revision}`);
    assert.equal(exported.status, 200); assert.deepEqual(await exported.json(), changedA);
    const dossier = await (await fetch(`${base}/api/dossier?sessionId=${b.sessionId}`)).json();
    assert.equal(dossier.state.reviewStatus, 'paused'); assert.equal(dossier.state.claims.length, 0);
    assert.equal((await fetch(`${base}/api/state?sessionId=unknown`)).status, 400);
    assert.equal(JSON.stringify(store.getState()), legacy);
    await reader.cancel();
  } finally { clearTimeout(deadline); controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
