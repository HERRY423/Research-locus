// Build the committed, installable plugin without runtime npm downloads.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = join(root, 'plugins', 'research-locus');
process.chdir(root);
await import('./build.mjs');
mkdirSync(join(plugin, 'dist'), { recursive: true });
mkdirSync(join(plugin, 'scripts'), { recursive: true });
for (const item of ['plugin.json', 'mcp.json', '.codex-plugin', 'assets', 'skills', 'LICENSE']) {
  cpSync(join(root, item), join(plugin, item), { recursive: true });
}
cpSync(join(root, 'scripts/launch.mjs'), join(plugin, 'scripts/launch.mjs'));
cpSync(join(root, 'scripts/package-computational-receipt.mjs'), join(plugin, 'scripts/package-computational-receipt.mjs'));
cpSync(join(root, 'dist/app.html'), join(plugin, 'dist/app.html'));
cpSync(join(root, 'docs'), join(plugin, 'docs'), { recursive: true });
const guide = readFileSync(join(root, 'docs/install-and-use.zh-CN.md'), 'utf8');
writeFileSync(join(plugin, 'README.md'), guide.replace(/\]\((?!https?:\/\/|#)([^)]+\.md(?:#[^)]*)?)\)/g, ']'+ '(docs/$1)'));
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'research-locus', version, private: true, type: 'module', engines: { node: '>=22' }, scripts: { start: 'node scripts/launch.mjs', preview: 'node scripts/launch.mjs --http' } }, null, 2) + '\n');
const result = await build({
  entryPoints: ['src/server.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22',
  banner: { js: 'import { createRequire as __locusCreateRequire } from "node:module"; const require = __locusCreateRequire(import.meta.url);' },
  outfile: join(plugin, 'dist/server.js'), metafile: true,
});
const externals = result.metafile.outputs[join(plugin, 'dist/server.js')]?.imports ?? Object.values(result.metafile.outputs).flatMap(output => output.imports);
const builtin = await import('node:module');
for (const item of externals) {
  if (item.external && !builtin.isBuiltin(item.path)) throw new Error(`Unbundled runtime dependency: ${item.path}`);
}
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const notices = ['# Third-party notices', 'Dependency licenses retained for the bundled server and browser UI.'];
for (const [path, metadata] of Object.entries(lock.packages)) {
  if (!path || metadata.dev || metadata.devOptional) continue;
  const pkgRoot = join(root, path);
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  notices.push(`\n## ${pkg.name} ${pkg.version}\nLicense: ${pkg.license ?? 'See package notice'}`);
  const license = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'LICENSE-MIT', 'COPYING'].find(name => existsSync(join(pkgRoot, name)));
  if (!license && pkg.name !== '@cfworker/json-schema') throw new Error(`Review missing dependency license: ${pkg.name}`);
  notices.push(readFileSync(license ? join(pkgRoot, license) : join(root, 'docs/third-party/cfworker-LICENSE'), 'utf8'));
}
writeFileSync(join(plugin, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n') + '\n');
const skillFiles = (path) => readdirSync(join(plugin, path), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? skillFiles(`${path}/${entry.name}`) : [`${path}/${entry.name}`]);
const files = ['dist/server.js', 'dist/app.html', 'scripts/launch.mjs', 'scripts/package-computational-receipt.mjs', ...skillFiles('skills').sort()];
writeFileSync(join(plugin, 'BUILD.json'), JSON.stringify({ version, node: '>=22', runtimeDependencyInstallRequired: false, nativeHostAcceptance: 'NOT_RUN', sha256: Object.fromEntries(files.map(path => [path, createHash('sha256').update(readFileSync(join(plugin, path))).digest('hex')])) }, null, 2) + '\n');
console.log('Built installable marketplace plugin: plugins/research-locus');
