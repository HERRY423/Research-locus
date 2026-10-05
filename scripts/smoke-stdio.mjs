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
    for (const name of ['locus.open', 'locus.panel', 'locus.file', 'locus.state', 'locus.review', 'locus.submit_finding', 'locus.ui_action', 'search_mentions']) assert.ok(tools.some(tool => tool.name === name), name);
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
    assert.equal(resumedSession.structuredContent.state.revision, 1);
    const resource = await client.readResource({ uri: 'locus://resource/fixture-notes' });
    assert.equal(JSON.parse(resource.contents[0].text).id, 'fixture-notes');
  });
  assert.equal(stderr.join('').trim(), '', 'Unexpected child-process stderr');
  assert.ok(existsSync(statePath), 'Launcher honors LOCUS_DATA_DIR.');
  console.log(JSON.stringify({ status: 'PASS', scope: 'Packaged launcher, stdio protocol, catalog/session routing and restart persistence; not native ChatGPT host acceptance', tools: first.tools, persistedRevision: first.revision, persistedSessions: 2, launcherSha256: createHash('sha256').update(readFileSync(entry)).digest('hex'), artifactSha256: createHash('sha256').update(readFileSync(join(pluginRoot, 'dist', 'server.js'))).digest('hex'), isolatedState: true, stderrEmpty: true }, null, 2));
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
