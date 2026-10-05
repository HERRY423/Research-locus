import { createHash } from 'node:crypto';
import { adaptBioNexus } from './adapters/bionexus.js';

export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
export interface ReceiptFile { path: string; contentBase64: string }
export interface ArtifactReference { path?: string; sha256?: string }
export interface ReceiptFailure { stage: string; message: string }
export interface GenericReceiptManifest {
  schema: 'locus.computational-receipt.v1'; tool: { name: string; version: string };
  status: 'succeeded' | 'failed' | 'partial' | 'unknown'; code: ArtifactReference;
  inputs: ArtifactReference[]; outputs: ArtifactReference[]; failures: ReceiptFailure[]; summary?: string;
}
export interface ComputationalReceiptInput {
  format: 'generic' | 'bionexus-de'; files: ReceiptFile[];
  manifest?: GenericReceiptManifest; executionReceiptPath?: string;
}
export interface HashBinding {
  path: string | null; sha256: string | null; verification: 'MATCHED' | 'NOT_PROVIDED';
}
export interface ReceiptArtifact {
  path: string; sha256: string; bytes: number; mediaType: string; preview?: string;
}
export interface ComputationalReceipt {
  schema: 'locus.computational-evidence.v1'; format: ComputationalReceiptInput['format'];
  tool: { name: string; version: string }; status: GenericReceiptManifest['status']; summary: string;
  artifacts: ReceiptArtifact[];
  binding: { sha256: string; status: 'COMPLETE_BYTES' | 'INCOMPLETE'; code: HashBinding; inputs: HashBinding[]; outputs: HashBinding[] };
  verification: { artifactByteIntegrity: 'CHECKED'; execution: 'NOT_VERIFIED'; producer: 'NOT_VERIFIED'; scientific: 'NOT_ASSESSED' };
  failures: ReceiptFailure[]; limitations: string[];
  bundle?: {
    schema: 'bionexus.de-shadow-bundle.v1'; integrityStatus: 'CONSISTENT' | 'LEGACY_LIMITED';
    manifestSha256: string; auditStatus: string; dataOrigin: string;
    audit: Record<string, unknown>; executionReceipt?: Record<string, unknown>;
    executionReceiptBinding: 'MANIFEST_BOUND' | 'UPLOADER_ASSOCIATED' | 'NOT_PROVIDED';
  };
}
export class ReceiptError extends Error {
  readonly code = 'INVALID_COMPUTATIONAL_RECEIPT';
}
export const receiptFail = (message: string): never => { throw new ReceiptError(message); };
export function object(value: unknown, allowed?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return receiptFail('Expected a receipt object.');
  if (allowed && Object.keys(value).some(key => !allowed.includes(key))) return receiptFail('Unexpected receipt field.');
  return value as Record<string, unknown>;
}
export function boundedText(value: unknown, max = 2000): string {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : receiptFail('Receipt text is missing or too long.');
}
export function safePath(value: unknown): string {
  const path = boundedText(value, 240);
  if (path !== value || /[\\:\x00-\x1f]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' '))) return receiptFail('Use unambiguous relative artifact paths without traversal.');
  return path;
}
export const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');
export function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value) || /^0{64}$/.test(value)) return receiptFail('Expected a nonzero lowercase SHA-256 digest.');
  return value;
}

// A small strict JSON reader keeps duplicate keys, nonfinite numbers and extreme
// nesting from changing the meaning of producer records after transport.
export function strictJson(bytes: Uint8Array, name: string): Record<string, unknown> {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
  catch { return receiptFail(`${name}: expected UTF-8 JSON.`); }
  let at = 0;
  const ws = () => { while (/[ \t\r\n]/.test(text[at] ?? '') && at < text.length) at++; };
  const readString = (): string => {
    const start = at++;
    while (at < text.length) {
      const character = text[at++];
      if (character === '\\') { at++; continue; }
      if (character === '"') { try { return JSON.parse(text.slice(start, at)) as string; } catch { break; } }
    }
    return receiptFail(`${name}: malformed JSON string.`);
  };
  const value = (depth: number): unknown => {
    if (depth > 80) return receiptFail(`${name}: JSON nesting exceeds the limit.`);
    ws(); const char = text[at];
    if (char === '"') return readString();
    if (char === '{') {
      at++; ws(); const result: Record<string, unknown> = Object.create(null); const keys = new Set<string>();
      if (text[at] === '}') { at++; return result; }
      while (at < text.length) {
        ws(); if (text[at] !== '"') return receiptFail(`${name}: malformed JSON object.`);
        const key = readString(); if (keys.has(key)) return receiptFail(`${name}: duplicate JSON key ${key}.`); keys.add(key);
        ws(); if (text[at++] !== ':') return receiptFail(`${name}: malformed JSON object.`);
        result[key] = value(depth + 1); ws(); const delimiter = text[at++];
        if (delimiter === '}') return result; if (delimiter !== ',') return receiptFail(`${name}: malformed JSON object.`);
      }
    } else if (char === '[') {
      at++; ws(); const result: unknown[] = [];
      if (text[at] === ']') { at++; return result; }
      while (at < text.length) { result.push(value(depth + 1)); ws(); const delimiter = text[at++]; if (delimiter === ']') return result; if (delimiter !== ',') return receiptFail(`${name}: malformed JSON array.`); }
    } else {
      const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
      if (match) { at += match[0].length; const parsed: unknown = JSON.parse(match[0]); if (typeof parsed === 'number' && !Number.isFinite(parsed)) return receiptFail(`${name}: nonfinite JSON number.`); return parsed; }
    }
    return receiptFail(`${name}: malformed JSON.`);
  };
  const result = value(0); ws(); if (at !== text.length) return receiptFail(`${name}: trailing JSON content.`);
  return object(result);
}

export function parseReceiptFiles(value: unknown): Map<string, Buffer> {
  if (!Array.isArray(value) || !value.length || value.length > 64) return receiptFail('Supply 1–64 explicitly selected artifact files.');
  const result = new Map<string, Buffer>(); const seen = new Set<string>(); let total = 0;
  for (const item of value) {
    const row = object(item, ['path', 'contentBase64']); const path = safePath(row.path);
    if (seen.has(path.toLowerCase())) return receiptFail('Duplicate or case-ambiguous artifact path.'); seen.add(path.toLowerCase());
    // Alphabet/length plus an encode round-trip verifies canonical padding;
    // repeating four-character regexp groups can overflow on valid 10 MiB files.
    if (typeof row.contentBase64 !== 'string' || row.contentBase64.length > Math.ceil(MAX_RECEIPT_BYTES / 3) * 4 || row.contentBase64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(row.contentBase64)) return receiptFail('Expected bounded canonical base64 artifact bytes.');
    const bytes = Buffer.from(row.contentBase64, 'base64'); if (bytes.toString('base64') !== row.contentBase64) return receiptFail('Artifact base64 is not canonical.');
    total += bytes.length; if (total > MAX_RECEIPT_BYTES) return receiptFail('Selected receipt files exceed 10 MiB.'); result.set(path, bytes);
  }
  return result;
}
export function parseReference(value: unknown): ArtifactReference {
  const item = object(value, ['path', 'sha256']);
  return { ...(item.path !== undefined ? { path: safePath(item.path) } : {}), ...(item.sha256 !== undefined ? { sha256: digest(item.sha256) } : {}) };
}
export function bindReference(reference: ArtifactReference, files: Map<string, Buffer>): HashBinding {
  const bytes = reference.path ? files.get(reference.path) : undefined;
  if (bytes && reference.sha256 && sha256(bytes) !== reference.sha256) return receiptFail(`${reference.path}: SHA-256 mismatch.`);
  return { path: reference.path ?? null, sha256: reference.sha256 ?? null, verification: bytes && reference.sha256 ? 'MATCHED' : 'NOT_PROVIDED' };
}
export function makeBinding(code: HashBinding, inputs: HashBinding[], outputs: HashBinding[]): ComputationalReceipt['binding'] {
  const descriptor = { code, inputs, outputs };
  return { sha256: sha256(JSON.stringify(descriptor)), status: code.verification === 'MATCHED' && inputs.length > 0 && outputs.length > 0 && [...inputs, ...outputs].every(item => item.verification === 'MATCHED') ? 'COMPLETE_BYTES' : 'INCOMPLETE', ...descriptor };
}
export const receiptVerification: ComputationalReceipt['verification'] = { artifactByteIntegrity: 'CHECKED', execution: 'NOT_VERIFIED', producer: 'NOT_VERIFIED', scientific: 'NOT_ASSESSED' };
export const receiptLimitations = [
  'Hashes bind the supplied bytes and declared code/input/output association only; they do not prove that this code produced these outputs.',
  'No code or notebook is executed. Producer identity, execution, biological validity and independent replication are not verified.',
  'Tool versions, run status and failure records are producer declarations, not independently authenticated execution logs.',
];
export function receiptArtifacts(files: Map<string, Buffer>, previewPaths = new Set<string>()): ReceiptArtifact[] {
  return [...files].map(([path, bytes]) => {
    const lower = path.toLowerCase(); const mediaType = lower.endsWith('.ipynb') ? 'application/x-ipynb+json' : lower.endsWith('.csv') ? 'text/csv' : lower.endsWith('.tsv') ? 'text/tab-separated-values' : lower.endsWith('.json') ? 'application/json' : 'text/plain';
    const artifact: ReceiptArtifact = { path, sha256: sha256(bytes), bytes: bytes.length, mediaType };
    if (lower.endsWith('.ipynb')) {
      const notebook = strictJson(bytes, path);
      if (notebook.nbformat !== 4 || !Array.isArray(notebook.cells)) return receiptFail(`${path}: expected a version 4 notebook.`);
      const chunks: string[] = [];
      for (const [index, raw] of notebook.cells.entries()) {
        const cell = object(raw); if (cell.cell_type !== 'code' || !Array.isArray(cell.outputs)) continue;
        for (const rawOutput of cell.outputs) {
          const output = object(rawOutput);
          const textValue = output.output_type === 'stream' ? output.text : output.output_type === 'error' ? `${String(output.ename ?? '')}: ${String(output.evalue ?? '')}` : output.data && typeof output.data === 'object' ? (output.data as Record<string, unknown>)['text/plain'] : undefined;
          const plain = typeof textValue === 'string' ? textValue : Array.isArray(textValue) && textValue.every(x => typeof x === 'string') ? textValue.join('') : '';
          if (plain) chunks.push(`Cell ${index + 1}: ${plain}`);
          if (chunks.join('\n').length > 4000) break;
        }
        if (chunks.join('\n').length > 4000) break;
      }
      if (previewPaths.has(path)) artifact.preview = chunks.join('\n').slice(0, 4000) || 'No text/plain outputs; rich HTML, JavaScript and images are not rendered.';
    } else if (previewPaths.has(path) && (mediaType === 'text/csv' || mediaType === 'text/tab-separated-values')) {
      try { artifact.preview = new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, 4000); } catch { return receiptFail(`${path}: tabular output must be UTF-8.`); }
    }
    return artifact;
  });
}
export function parseComputationalReceipt(input: unknown): ComputationalReceipt {
  const row = object(input, ['format', 'files', 'manifest', 'executionReceiptPath']); const files = parseReceiptFiles(row.files);
  if (row.format === 'bionexus-de') {
    if (row.manifest !== undefined) return receiptFail('BioNexus uses the original uploaded manifest.json bytes.');
    return adaptBioNexus(files, row.executionReceiptPath === undefined ? undefined : safePath(row.executionReceiptPath));
  }
  if (row.format !== 'generic' || row.executionReceiptPath !== undefined) return receiptFail('Unknown receipt format or unexpected execution receipt selector.');
  const manifest = object(row.manifest, ['schema', 'tool', 'status', 'code', 'inputs', 'outputs', 'failures', 'summary']);
  if (manifest.schema !== 'locus.computational-receipt.v1') return receiptFail('Unsupported computational receipt schema.');
  const tool = object(manifest.tool, ['name', 'version']); const status = manifest.status;
  if (!['succeeded', 'failed', 'partial', 'unknown'].includes(String(status))) return receiptFail('Unknown computation status.');
  const list = (value: unknown): HashBinding[] => {
    if (!Array.isArray(value) || value.length > 32) return receiptFail('Expected at most 32 artifact references per role.');
    const refs = value.map(parseReference); const paths = refs.filter(r => r.path).map(r => r.path); if (new Set(paths).size !== paths.length) return receiptFail('Duplicate artifact reference within role.');
    return refs.map(ref => bindReference(ref, files));
  };
  if (!Array.isArray(manifest.failures) || manifest.failures.length > 100) return receiptFail('Expected at most 100 failure records.');
  const failures = manifest.failures.map(item => { const f = object(item, ['stage', 'message']); return { stage: boundedText(f.stage, 200), message: boundedText(f.message, 4000) }; });
  const code = bindReference(parseReference(manifest.code), files); const inputs = list(manifest.inputs); const outputs = list(manifest.outputs);
  return {
    schema: 'locus.computational-evidence.v1', format: 'generic', tool: { name: boundedText(tool.name, 200), version: boundedText(tool.version, 200) },
    status: status as GenericReceiptManifest['status'], summary: manifest.summary === undefined ? '' : boundedText(manifest.summary, 4000),
    artifacts: receiptArtifacts(files, new Set(outputs.flatMap(item => item.path ? [item.path] : []))), binding: makeBinding(code, inputs, outputs),
    verification: { ...receiptVerification }, failures, limitations: [...receiptLimitations],
  };
}
