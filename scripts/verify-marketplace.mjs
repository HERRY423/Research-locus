// Exercise exactly the committed plugin from an isolated directory with no dependencies.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parent = realpathSync(dirname(root));
const temp = mkdtempSync(join(parent, 'locus-isolated-'));
const plugin = join(temp, 'Plugin with spaces');
const market = JSON.parse(readFileSync(join(root, '.agents/plugins/marketplace.json'), 'utf8'));
let child, stopped;
try {
  assert.equal(market.plugins[0].source.path, './plugins/research-locus');
  cpSync(join(root, market.plugins[0].source.path), plugin, { recursive: true });
  assert.equal(existsSync(join(plugin, 'node_modules')), false);
  assert.equal(existsSync(join(plugin, '.locus')), false);
  const config = JSON.parse(readFileSync(join(plugin, 'mcp.json'), 'utf8'));
  assert.deepEqual(config.mcpServers['research-locus'].args, ['${PLUGIN_ROOT}/scripts/launch.mjs']);
  const build = JSON.parse(readFileSync(join(plugin, 'BUILD.json'), 'utf8'));
  for (const [path, expected] of Object.entries(build.sha256)) assert.equal(createHash('sha256').update(readFileSync(join(plugin,path))).digest('hex'), expected);
  const smoke = spawnSync(process.execPath, [join(root, 'scripts/smoke-stdio.mjs')], { cwd: root, env: { ...process.env, LOCUS_PLUGIN_ROOT: plugin }, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(smoke.status, 0, smoke.stderr);
  const stdio = JSON.parse(smoke.stdout);
  const probe = createServer();
  await new Promise((yes,no) => { probe.once('error',no); probe.listen(0,'127.0.0.1',yes); });
  const port = probe.address().port;
  await new Promise(yes => probe.close(yes));
  child = spawn(process.execPath, [join(plugin,'scripts/launch.mjs'),'--http'], { cwd: plugin, env: { ...process.env, NODE_PATH: '', LOCUS_STATE_PATH: '', LOCUS_CATALOG_DIR: '', LOCUS_DATA_DIR: join(temp,'data'), PORT: String(port) }, stdio: ['ignore','pipe','pipe'], windowsHide: true });
  stopped = new Promise(yes => child.once('close',yes));
  let stderr=''; child.stderr.on('data',chunk=>stderr+=chunk);
  let response;
  for(let i=0;i<50;i++) { try { response=await fetch(`http://127.0.0.1:${port}/api/catalog`); if(response.ok)break; } catch {} await new Promise(yes=>setTimeout(yes,100)); }
  assert.ok(response?.ok, stderr);
  assert.equal((await response.json()).sessions.length,1);
  const html=await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const normalize=text=>text.replace(/name="locus-ui-token" content="[^"]+"/,'name="locus-ui-token" content="TOKEN"');
  assert.equal(normalize(html),normalize(readFileSync(join(plugin,'dist/app.html'),'utf8')));
  const report={status:'PASS',version:build.version,stdio,http:'PASS',noNodeModules:true,pathWithSpaces:true,marketplaceManifest:'PASS',buildHashes:'PASS',nativeHostAcceptance:'NOT_RUN'};
  mkdirSync(join(root,'artifacts'),{recursive:true});
  writeFileSync(join(root,'artifacts/marketplace-verification.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {
  if(child) {child.kill();await stopped;}
  const target=realpathSync(temp);
  assert.equal(dirname(target).toLowerCase(),parent.toLowerCase());
  assert.ok(basename(target).startsWith('locus-isolated-'));
  rmSync(target,{recursive:true});
}
