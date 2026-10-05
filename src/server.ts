import { createServer, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ReviewStore, DomainError } from './domain.js';
import { createMcpServer, catalogActionSchema } from './mcp.js';
import { WorkspaceCatalog } from './catalog.js';
import type { verifyDoi, DoiVerificationInput } from './doi-verification.js';

export function createHttpWorkbench(store: ReviewStore, template: string, token = randomBytes(32).toString('hex'), catalog = new WorkspaceCatalog({ legacyStore: store }), doiOptions?: Parameters<typeof verifyDoi>[1]) {
  const html = template.replaceAll('__LOCUS_UI_TOKEN__', token);
  const listeners = new Map<ServerResponse, { sessionId: string; revision: number; integrityError: boolean }>();
  const publish = () => {
    for (const [response, subscription] of listeners) {
      try {
        const state = catalog.getStore(subscription.sessionId).getState(); subscription.integrityError = false;
        if (state.revision === subscription.revision) continue;
        subscription.revision = state.revision;
        response.write(`data: ${JSON.stringify(state)}\n\n`);
      } catch {
        if (subscription.integrityError) continue;
        subscription.integrityError = true;
        response.write(`event: integrity-error\ndata: ${JSON.stringify({ sessionId: subscription.sessionId, message: '存储完整性检查失败；已停止广播。请保留原文件并检查档案，勿继续提交决定。' })}\n\n`);
      }
    }
  };
  const interval = setInterval(publish, 750); interval.unref();
  const server = createServer(async (req, res) => {
    const port = (server.address() as {port: number} | null)?.port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const origin = req.headers.origin;
    const send = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
    if (!hosts.includes(req.headers.host || '')) { send(403, { error: 'Invalid host' }); return; }
    if (origin && !hosts.some(host => origin === `http://${host}`)) { send(403, { error: 'Cross-origin access denied' }); return; }
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://localhost'); }
    catch { send(400, { error: 'Invalid request target' }); return; }
    const path = url.pathname;
    const requestedSessionId = url.searchParams.get('sessionId') ?? undefined;
    const selectedStore = (bodySessionId?: unknown) => {
      if (bodySessionId !== undefined && (typeof bodySessionId !== 'string' || !bodySessionId)) throw new DomainError('INVALID_SESSION', 'sessionId must be a nonempty string.');
      if (requestedSessionId !== undefined && bodySessionId !== undefined && requestedSessionId !== bodySessionId) throw new DomainError('SESSION_MISMATCH', 'Query and body session IDs do not match.');
      return catalog.getStore((bodySessionId as string | undefined) ?? requestedSessionId ?? catalog.defaultSessionId);
    };
    try {
      if (path === '/mcp') {
        if (req.method !== 'POST') { send(405, { error: 'Use MCP POST transport' }); return; }
        const mcp = createMcpServer(store, html, token, catalog, doiOptions);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await mcp.connect(transport);
        res.on('close', () => { void transport.close(); void mcp.close(); publish(); });
        await transport.handleRequest(req, res); return;
      }
      if (req.method === 'GET' && path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'" }); res.end(html); return;
      }
      if (req.method === 'GET' && path === '/api/catalog') { send(200, catalog.list()); return; }
      if (req.method === 'GET' && path === '/api/state') { send(200, selectedStore().getState()); return; }
      if (req.method === 'GET' && path === '/api/export') {
        const state = selectedStore().getState();
        const revision = url.searchParams.get('revision');
        if (revision !== String(state.revision)) { send(409, { error: '档案已更新，请刷新后重新导出。' }); return; }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="research-locus-rev-${state.revision}.json"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(JSON.stringify(state, null, 2)); return;
      }
      if (req.method === 'GET' && path === '/api/dossier') { send(200, selectedStore().dossier()); return; }
      if (req.method === 'GET' && path === '/api/events') {
        const state = selectedStore().getState();
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(state)}\n\n`); listeners.set(res, { sessionId: requestedSessionId ?? catalog.defaultSessionId, revision: state.revision, integrityError: false }); req.on('close', () => listeners.delete(res)); return;
      }
      if (req.method === 'POST' && (path === '/api/action' || path === '/api/catalog/action' || path === '/api/verify-doi')) {
        const supplied = req.headers['x-locus-ui'];
        if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) { send(403, { error: 'UI channel token required' }); return; }
        if (!req.headers['content-type']?.startsWith('application/json')) { send(415, { error: 'JSON required' }); return; }
        const chunks: Buffer[] = []; let size = 0;
        const bodyLimit=path==='/api/action'?16*1024*1024:1_100_000;
        for await (const chunk of req) { size += chunk.length; if (size > bodyLimit) { send(413, { error: 'Payload too large' }); return; } chunks.push(chunk); }
        let input: Record<string, unknown>;
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { send(400, { error: 'Invalid JSON' }); return; }
        if (!input || typeof input !== 'object' || Array.isArray(input)) { send(400, { error: 'JSON object required' }); return; }
        if (path==='/api/verify-doi') {
          if (Object.keys(input).some(key=>!['input','claimId','sessionId','expectedRevision'].includes(key)) || typeof input.claimId!=='string' || !Number.isInteger(input.expectedRevision)) {send(400,{error:'Expected DOI input, claimId, expectedRevision and optional sessionId only'});return;}
          const state=await selectedStore(input.sessionId).verifyDoi(input.claimId,input.input as DoiVerificationInput,input.expectedRevision as number,doiOptions);
          publish();send(200,state);return;
        }
        if (path === '/api/catalog/action') {
          if (Object.keys(input).some(key => key !== 'action')) { send(400, { error: 'Expected catalog action only' }); return; }
          const action = catalogActionSchema.parse(input.action);
          if (action.type === 'create_project') send(200, catalog.createProject(action.title));
          else send(200, catalog.createSession(action.projectId, action.title));
          return;
        }
        if (Object.keys(input).some(key => !['action', 'expectedRevision', 'sessionId'].includes(key)) || !Number.isInteger(input.expectedRevision)) { send(400, { error: 'Expected action, optional sessionId, and integer expectedRevision only' }); return; }
        const state = selectedStore(input.sessionId).act(input.action, input.expectedRevision as number, { kind: 'researcher', id: 'local-ui-unverified' });
        publish(); send(200, state); return;
      }
      send(404, { error: 'Not found' });
    } catch (error) {
      if (error instanceof DomainError) send(error.status, { error: error.message, code: error.code });
      else send(400, { error: error instanceof Error ? error.message : 'Request failed' });
    }
  });
  server.on('close', () => { clearInterval(interval); for (const response of listeners.keys()) response.end(); });
  return server;
}

async function main() {
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(sourceDir, '..');
  const htmlPath = resolve(root, 'dist/app.html');
  if (!existsSync(htmlPath)) throw new Error('Run npm run build before starting the workbench.');
  const template = readFileSync(htmlPath, 'utf8');
  const statePath = process.env.LOCUS_STATE_PATH || resolve(root, '.locus/state.json');
  const store = new ReviewStore({ filePath: statePath });
  const catalog = new WorkspaceCatalog({ directory: process.env.LOCUS_CATALOG_DIR || resolve(dirname(statePath), 'catalog'), legacyStore: store });
  const token = randomBytes(32).toString('hex');
  if (process.argv.includes('--http')) {
    const port = Number(process.env.PORT || 4317);
    const http = createHttpWorkbench(store, template, token, catalog);
    http.listen(port, '127.0.0.1', () => console.error(`Research Locus: http://127.0.0.1:${port} · local prototype · MCP /mcp`));
    process.on('SIGINT', () => http.close());
  } else {
    const mcp = createMcpServer(store, template.replaceAll('__LOCUS_UI_TOKEN__', token), token, catalog);
    await mcp.connect(new StdioServerTransport());
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
