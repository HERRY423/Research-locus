// Explicit allowlist: never distribute saved research records, configs or local logs.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kit = resolve(process.argv[2] || join(root, 'artifacts', 'research-locus-friend-kit'));
if (existsSync(kit)) throw new Error(`Output already exists; use a new output directory: ${kit}`);
const plugin = join(kit, 'plugins', 'research-locus');
mkdirSync(plugin, { recursive: true });
for (const path of ['plugin.json', 'mcp.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'README.md', '.codex-plugin', 'assets', 'dist', 'skills', 'src', 'tests', 'scripts']) {
  cpSync(join(root, path), join(plugin, path), { recursive: true });
}
mkdirSync(join(plugin, 'docs'), { recursive: true });
for (const path of ['friend-install.zh-CN.md', 'spec-audit-2026-10-05.md', 'host-acceptance.md', 'replay-theater.md', 'standalone-home.md', 'design.zh-CN.md', 'ui-refresh.md', 'validation.md']) {
  cpSync(join(root, 'docs', path), join(plugin, 'docs', path));
}
// Runtime dependencies only; the lockfile fixes the dependency versions. No install hooks run.
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
let packages = 0;
for (const [path, metadata] of Object.entries(lock.packages)) {
  if (!path || metadata.dev || metadata.devOptional) continue;
  if (!path.startsWith('node_modules/') || path.split('/').includes('..') || metadata.link) throw new Error(`Unsafe dependency path: ${path}`);
  if (!existsSync(join(root, path)) || lstatSync(join(root, path)).isSymbolicLink()) throw new Error(`Missing or linked runtime dependency: ${path}`);
  cpSync(join(root, path), join(plugin, path), { recursive: true });
  packages += 1;
}
const marketplace = {
  name: 'research-locus-local', interface: { displayName: 'Research Locus Local' },
  plugins: [{ name: 'research-locus', source: { source: 'local', path: './plugins/research-locus' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
};
mkdirSync(join(kit, '.agents', 'plugins'), { recursive: true });
writeFileSync(join(kit, '.agents', 'plugins', 'marketplace.json'), JSON.stringify(marketplace, null, 2) + '\n');
cpSync(join(root, 'docs', 'friend-install.zh-CN.md'), join(kit, 'INSTALL.zh-CN.md'));
writeFileSync(join(kit, 'CONTENTS.json'), JSON.stringify({
  name: 'Research Locus source preview kit', version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, runtime: 'Node.js >=22',
  runtimeDependencies: packages, containsResearchRecords: false,
  nativeHostAcceptance: 'NOT_RUN', entrypoint: 'plugins/research-locus/scripts/launch.mjs',
  specCommit: 'ca16cb3bc015baaa1b849082d8755bbef18770cb',
}, null, 2) + '\n');
console.log(JSON.stringify({ kit, plugin, runtimeDependencies: packages, status: 'PACKAGED_NOT_HOST_INSTALLED' }, null, 2));
