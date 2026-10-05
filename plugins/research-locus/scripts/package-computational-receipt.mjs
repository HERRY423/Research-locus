#!/usr/bin/env node
// Passive transport helper. Explicitly selected bytes only: never run analysis,
// dereference manifest paths, follow symlinks, fetch links, or overwrite evidence.
import { readFile, lstat, realpath, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';

const usage = `Usage:
  node scripts/package-computational-receipt.mjs --bundle DIRECTORY --out NEW.json [--file NAME=FILE ...] [--execution-receipt NAME]
  node scripts/package-computational-receipt.mjs --generic-manifest MANIFEST.json --out NEW.json --file NAME=FILE [...]

The BioNexus mode selects only manifest.json, audit.json, audit-full.md and REVIEW.md.
Select original input, code and execution-receipt files explicitly with --file.
Missing referenced payloads remain NOT_PROVIDED at import. The generic manifest uses
schema locus.computational-receipt.v1. Neither mode executes code or checks science.
`;
async function main() {
  const options = new Map(); const selections = [];
  for (let index = 2; index < process.argv.length; index++) {
    const key = process.argv[index]; if (key === '--help') { console.log(usage); return; }
    if (!['--bundle', '--generic-manifest', '--out', '--file', '--execution-receipt'].includes(key)) throw new Error(`Unknown option: ${key}`);
    const value = process.argv[++index]; if (!value || value.startsWith('--')) throw new Error(`${key} needs a value.`);
    if (key === '--file') selections.push(value); else { if (options.has(key)) throw new Error(`Duplicate option: ${key}`); options.set(key, value); }
  }
  if (!options.has('--out') || options.has('--bundle') === options.has('--generic-manifest')) throw new Error(usage);
  const files = []; const names = new Set(); let total = 0;
  async function selected(name, filePath) {
    if (!name || name.length > 240 || /[\\:\x00-\x1f]/.test(name) || name.startsWith('/') || name.split('/').some(part => !part || ['.', '..'].includes(part) || part.endsWith('.') || part.endsWith(' '))) throw new Error('Use unambiguous relative uploaded names.');
    if (names.has(name.toLowerCase())) throw new Error(`Duplicate uploaded name: ${name}`);
    const path = resolve(filePath); const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (await realpath(path)).toLowerCase() !== path.toLowerCase()) throw new Error(`Selected artifact must be a regular file without symlink redirection: ${name}`);
    if (info.size > 10 * 1024 * 1024 || total + info.size > 10 * 1024 * 1024 || files.length >= 64) throw new Error('Selected bytes exceed 10 MiB or 64 files.');
    const bytes = await readFile(path); total += bytes.length; if (total > 10 * 1024 * 1024) throw new Error('Selected bytes grew beyond 10 MiB.');
    files.push({ path: name, contentBase64: bytes.toString('base64') }); names.add(name.toLowerCase());
  }
  let receipt;
  if (options.has('--bundle')) {
    const directory = resolve(options.get('--bundle'));
    for (const name of ['manifest.json', 'audit.json', 'audit-full.md', 'REVIEW.md']) {
      const path = join(directory, name); if (dirname(path) !== directory) throw new Error('Invalid bundle artifact path.');
      try { await selected(name, path); } catch (error) { if (error.code === 'ENOENT' && !['manifest.json', 'audit.json'].includes(name)) continue; throw error; }
    }
    receipt = { format: 'bionexus-de', files, ...(options.has('--execution-receipt') ? { executionReceiptPath: options.get('--execution-receipt') } : {}) };
  } else {
    if (options.has('--execution-receipt')) throw new Error('Execution receipt selector applies only to BioNexus bundles.');
    const manifestPath = resolve(options.get('--generic-manifest')); const info = await lstat(manifestPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw new Error('Generic manifest must be a regular JSON file up to 128 KiB.');
    const manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
    receipt = { format: 'generic', files, manifest };
  }
  for (const selection of selections) {
    const divider = selection.indexOf('='); if (divider < 1) throw new Error('--file uses NAME=FILE.');
    await selected(selection.slice(0, divider), selection.slice(divider + 1));
  }
  if (!files.length) throw new Error('Select at least one artifact.');
  const output = resolve(options.get('--out')); await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ output, files: files.length, bytes: total, status: 'PACKAGED_NOT_EXECUTED', validation: 'The Research Locus import parser verifies the selected bytes and contract.' }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
