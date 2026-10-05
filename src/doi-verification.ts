import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export type DoiProvider = 'crossref' | 'datacite';
export type MetadataStatus = 'match' | 'mismatch' | 'incomplete' | 'not_checked';
export interface DoiExpectedMetadata { title?: string; year?: number; authors?: string[] }
export interface DoiVerificationInput { doi: string; mode?: 'syntax_only' | 'registry'; expected?: DoiExpectedMetadata }
export interface DoiRegistryRecord { doi: string; titles: string[]; authors: string[]; authorsComplete: boolean; years: number[] }
export interface DoiSourceResult {
  provider: DoiProvider;
  url: string;
  httpStatus: number | null;
  status: 'found' | 'not_found' | 'unknown';
  /** SHA-256 of the complete response body bytes exposed by fetch, before JSON parsing. */
  responseSha256: string | null;
  record?: DoiRegistryRecord;
  error?: string;
}
export interface DoiFieldCheck {
  status: MetadataStatus;
  expected?: string | number | string[];
  results: Array<{ provider: DoiProvider; status: MetadataStatus; actual?: string | number | string[]; reason?: string }>;
}
export interface DoiVerification {
  schemaVersion: 'locus.doi-verification.v1';
  doi: string;
  normalizedDoi: string | null;
  mode: 'syntax_only' | 'registry';
  expected: DoiExpectedMetadata;
  checkedAt: string;
  syntax: 'valid' | 'invalid';
  existence: 'found' | 'not_found' | 'unknown' | 'not_checked';
  existenceScope: 'queried_public_registries_only';
  metadata: MetadataStatus;
  fieldChecks: Record<'title' | 'year' | 'authors', DoiFieldCheck>;
  sources: DoiSourceResult[];
  actualLayers: Array<'syntax' | 'registry_lookup' | 'bibliographic_comparison'>;
  contentSupport: 'not_checked';
  scientificValidity: 'not_checked';
  limitations: string[];
}
export type DoiFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface DoiVerificationOptions {
  fetchImpl?: DoiFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => Date;
}

const fields = ['title', 'year', 'authors'] as const;
const providers: DoiProvider[] = ['crossref', 'datacite'];
const limits = [
  '格式检查只识别本工具支持的 DOI 写法，不证明 DOI 已注册。',
  '存在性仅覆盖实际查询的 Crossref 与 DataCite 公共记录；未找到不等于 DOI 在全球不存在。DataCite 公共接口不返回所有已注册记录。',
  '标题仅归一化 Unicode、大小写和空白后精确比较；作者按登记姓名和顺序精确比较，不把姓氏、缩写或 et al. 自动扩展成完整作者列表。多个出版年份需要人工核对。',
  '登记元数据可能不完整或有误；一致性不证明论文内容、引用支持关系、同行评审状态或科学有效性。',
];

/** Narrow parsing, never a resolver: caller text can never become a request host. */
export function normalizeDoi(input: string): string | null {
  if (typeof input !== 'string' || input.length > 2048) return null;
  let value = input.trim();
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (!['doi.org', 'dx.doi.org'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port || url.search || url.hash) return null;
      value = decodeURIComponent(url.pathname.slice(1));
    } catch { return null; }
  } else value = value.replace(/^doi:\s*/i, '');
  if (!/^10\.\d{4,9}\/[^\s<>\u0000-\u001f\u007f]+$/u.test(value)) return null;
  return value.toLowerCase();
}

export function parseDoiVerificationInput(value: unknown): DoiVerificationInput {
  if (!object(value) || Object.keys(value).some(key => !['doi', 'mode', 'expected'].includes(key)) || typeof value.doi !== 'string' || !value.doi.trim() || value.doi.length > 2048) throw new Error('DOI_INPUT_INVALID');
  if (value.mode !== undefined && value.mode !== 'syntax_only' && value.mode !== 'registry') throw new Error('DOI_MODE_INVALID');
  const input: DoiVerificationInput = { doi: value.doi, ...(value.mode ? { mode: value.mode } : {}) };
  if (value.expected !== undefined) {
    const expected = value.expected;
    if (!object(expected) || Object.keys(expected).some(key => !fields.includes(key as typeof fields[number]))) throw new Error('DOI_EXPECTED_INVALID');
    if (expected.title !== undefined && (typeof expected.title !== 'string' || !expected.title.trim() || expected.title.length > 4000)) throw new Error('DOI_TITLE_INVALID');
    if (expected.year !== undefined && (!Number.isInteger(expected.year) || Number(expected.year) < 1000 || Number(expected.year) > 3000)) throw new Error('DOI_YEAR_INVALID');
    if (expected.authors !== undefined && (!Array.isArray(expected.authors) || !expected.authors.length || expected.authors.length > 1000 || expected.authors.some(author => typeof author !== 'string' || !author.trim() || author.length > 500))) throw new Error('DOI_AUTHORS_INVALID');
    input.expected = structuredClone(expected) as DoiExpectedMetadata;
  }
  return input;
}

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function year(value: unknown): number | undefined { const n = typeof value === 'string' && /^\d{4}$/.test(value) ? Number(value) : value; return typeof n === 'number' && Number.isInteger(n) && n >= 1000 && n <= 3000 ? n : undefined; }
function clean(values: Array<string | undefined>): string[] { return values.filter((value): value is string => value !== undefined); }
function dateYear(value: unknown): number | undefined { return object(value) ? year(array(array(value['date-parts'])[0])[0]) : undefined; }
function name(value: unknown, givenKey: string, familyKey: string): string | undefined {
  if (!object(value)) return undefined;
  const given = text(value[givenKey]), family = text(value[familyKey]);
  return given && family ? `${given} ${family}` : text(value.name) ?? family ?? given;
}
function completeName(value: unknown, givenKey: string, familyKey: string): boolean { return object(value) && Boolean(text(value.name) || (text(value[givenKey]) && text(value[familyKey]))); }
function registryRecord(provider: DoiProvider, value: unknown): DoiRegistryRecord | null {
  if (!object(value)) return null;
  if (provider === 'crossref') {
    const record = value.message;
    if (!object(record) || typeof record.DOI !== 'string') return null;
    return { doi: record.DOI, titles: clean(array(record.title).map(text)), authors: clean(array(record.author).map(item => name(item, 'given', 'family'))), authorsComplete: array(record.author).length > 0 && array(record.author).every(item => completeName(item, 'given', 'family')), years: [...new Set([dateYear(record.published), dateYear(record['published-print']), dateYear(record['published-online']), dateYear(record.issued)].filter((n): n is number => n !== undefined))] };
  }
  const data = value.data;
  if (!object(data) || !object(data.attributes)) return null;
  const record = data.attributes;
  const doi = text(record.doi) ?? text(data.id);
  if (!doi || (text(data.id) && normalizeDoi(String(data.id)) !== normalizeDoi(doi))) return null;
  return { doi, titles: clean(array(record.titles).map(item => object(item) ? text(item.title) : undefined)), authors: clean(array(record.creators).map(item => name(item, 'givenName', 'familyName'))), authorsComplete: array(record.creators).length > 0 && array(record.creators).every(item => completeName(item, 'givenName', 'familyName')), years: [year(record.publicationYear)].filter((n): n is number => n !== undefined) };
}

async function bodyBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > maxBytes) { await response.body?.cancel().catch(() => undefined); throw new Error('response_too_large'); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      count += next.value.byteLength;
      if (count > maxBytes) throw new Error('response_too_large');
      chunks.push(next.value);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function query(provider: DoiProvider, doi: string, fetchImpl: DoiFetch, timeoutMs: number, maxBytes: number): Promise<DoiSourceResult> {
  const url = `${provider === 'crossref' ? 'https://api.crossref.org/works/' : 'https://api.datacite.org/dois/'}${encodeURIComponent(doi)}`;
  const source: DoiSourceResult = { provider, url, httpStatus: null, status: 'unknown', responseSha256: null };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs); });
  try {
    await Promise.race([timeout, (async () => {
      const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': 'Research-Locus/0.1.1 DOI-metadata-check' } });
      source.httpStatus = response.status;
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => undefined); throw new Error('redirect_refused'); }
      if (response.url && response.url !== url) { await response.body?.cancel().catch(() => undefined); throw new Error('unexpected_response_url'); }
      const bytes = await bodyBytes(response, maxBytes);
      source.responseSha256 = createHash('sha256').update(bytes).digest('hex');
      if (response.status === 404) { source.status = 'not_found'; return; }
      if (response.status !== 200) throw new Error('http_error');
      let json: unknown;
      try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('invalid_json'); }
      const record = registryRecord(provider, json);
      if (!record) throw new Error('invalid_record');
      if (normalizeDoi(record.doi) !== doi) throw new Error('doi_mismatch');
      source.status = 'found';
      source.record = { ...record, doi };
    })()]);
  } catch (error) {
    source.status = 'unknown';
    delete source.record;
    const message = error instanceof Error ? error.message : '';
    source.error = ['timeout', 'redirect_refused', 'unexpected_response_url', 'response_too_large', 'http_error', 'invalid_json', 'invalid_record', 'doi_mismatch'].includes(message) ? message : controller.signal.aborted ? 'timeout' : 'network_error';
  } finally { if (timer !== undefined) clearTimeout(timer); }
  // Even a test/custom fetch that ignores abort cannot mutate an already returned receipt.
  return structuredClone(source);
}

function normalized(value: string): string { return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase(); }
function compare(field: typeof fields[number], expected: string | number | string[], record: DoiRegistryRecord): {status: MetadataStatus; actual?: string | number | string[]; reason?: string} {
  if (field === 'title') {
    if (!record.titles.length) return { status: 'incomplete', reason: 'registry_field_missing' };
    return { status: record.titles.some(title => normalized(title) === normalized(String(expected))) ? 'match' : 'mismatch', actual: record.titles };
  }
  if (field === 'year') {
    if (!record.years.length) return { status: 'incomplete', reason: 'registry_field_missing' };
    // Online and print dates can legitimately differ; do not choose whichever agrees.
    if (record.years.length > 1) return { status: 'incomplete', actual: record.years.map(String), reason: 'multiple_publication_years' };
    return { status: record.years[0] === expected ? 'match' : 'mismatch', actual: record.years[0] };
  }
  if (!record.authors.length) return { status: 'incomplete', reason: 'registry_field_missing' };
  if (!record.authorsComplete) return { status: 'incomplete', actual: record.authors, reason: 'registry_author_names_incomplete' };
  const authors = expected as string[];
  return { status: authors.length === record.authors.length && authors.every((author, index) => normalized(author) === normalized(record.authors[index])) ? 'match' : 'mismatch', actual: record.authors };
}

/** Server-owned bounded lookups. No titles/authors, local paths, credentials or document bodies leave the host. */
export async function verifyDoi(value: DoiVerificationInput, options: DoiVerificationOptions = {}): Promise<DoiVerification> {
  const input = parseDoiVerificationInput(value), doi = normalizeDoi(input.doi), expected = input.expected ?? {};
  const mode = input.mode ?? 'registry';
  const result: DoiVerification = {
    schemaVersion: 'locus.doi-verification.v1', doi: input.doi, normalizedDoi: doi, mode, expected, checkedAt: (options.now?.() ?? new Date()).toISOString(),
    syntax: doi ? 'valid' : 'invalid', existence: 'not_checked', existenceScope: 'queried_public_registries_only', metadata: 'not_checked',
    fieldChecks: emptyChecks(expected),
    sources: [], actualLayers: ['syntax'], contentSupport: 'not_checked', scientificValidity: 'not_checked', limitations: [...limits],
  };
  if (!doi || mode === 'syntax_only') return result;
  const timeoutMs = Math.max(1, Math.min(15_000, options.timeoutMs ?? 8_000)), maxBytes = Math.max(1, Math.min(1_048_576, options.maxResponseBytes ?? 524_288));
  result.sources = await Promise.all(providers.map(provider => query(provider, doi, options.fetchImpl ?? fetch, timeoutMs, maxBytes)));
  result.actualLayers.push('registry_lookup');
  const found = result.sources.filter(source => source.status === 'found');
  result.existence = found.length ? 'found' : result.sources.every(source => source.status === 'not_found') ? 'not_found' : 'unknown';
  const requested = fields.filter(field => expected[field] !== undefined);
  if (found.length && requested.length) {
    result.actualLayers.push('bibliographic_comparison');
    for (const field of requested) {
      const check = result.fieldChecks[field];
      check.results = found.map(source => ({ provider: source.provider, ...compare(field, expected[field]!, source.record!) }));
      // One registry conflict must not be hidden by a match in another registry.
      check.status = check.results.some(item => item.status === 'mismatch') ? 'mismatch' : check.results.some(item => item.status === 'incomplete') ? 'incomplete' : 'match';
    }
    result.metadata = requested.some(field => result.fieldChecks[field].status === 'mismatch') ? 'mismatch' : requested.some(field => result.fieldChecks[field].status === 'incomplete') ? 'incomplete' : 'match';
  }
  return result;
}

function emptyChecks(expected: DoiExpectedMetadata): DoiVerification['fieldChecks'] {
  const check = (field: typeof fields[number]): DoiFieldCheck => ({ status: 'not_checked', ...(expected[field] === undefined ? {} : { expected: expected[field] }), results: [] });
  return { title: check('title'), year: check('year'), authors: check('authors') };
}

/** Structural/audit sanity only; the response hash is not independent registry attestation. */
export function assertDoiVerification(value: unknown): asserts value is DoiVerification {
  function fail(): never { throw new Error('DOI_VERIFICATION_INVALID'); }
  if (!object(value) || value.schemaVersion !== 'locus.doi-verification.v1' || typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))) fail();
  const input = parseDoiVerificationInput({ doi: value.doi, mode: value.mode, expected: value.expected });
  const doi = normalizeDoi(input.doi);
  if (value.normalizedDoi !== doi || value.syntax !== (doi ? 'valid' : 'invalid') || value.existenceScope !== 'queried_public_registries_only' || value.contentSupport !== 'not_checked' || value.scientificValidity !== 'not_checked' || !Array.isArray(value.sources) || !Array.isArray(value.limitations) || !value.limitations.length || value.limitations.some(item => typeof item !== 'string')) fail();
  const lookup = doi !== null && input.mode === 'registry';
  const sources = value.sources as unknown[];
  if (sources.length !== (lookup ? 2 : 0)) fail();
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    const provider = providers[index];
    if (!object(source) || source.provider !== provider || source.url !== `${provider === 'crossref' ? 'https://api.crossref.org/works/' : 'https://api.datacite.org/dois/'}${encodeURIComponent(doi!)}` || !['found', 'not_found', 'unknown'].includes(String(source.status)) || (source.httpStatus !== null && (!Number.isInteger(source.httpStatus) || Number(source.httpStatus) < 100 || Number(source.httpStatus) > 599)) || (source.responseSha256 !== null && (typeof source.responseSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(source.responseSha256)))) fail();
    if (source.status === 'found') {
      const record = source.record;
      if (source.httpStatus !== 200 || typeof source.responseSha256 !== 'string' || source.error !== undefined || !object(record) || record.doi !== doi || !Array.isArray(record.titles) || record.titles.some(item => typeof item !== 'string') || !Array.isArray(record.authors) || record.authors.some(item => typeof item !== 'string') || typeof record.authorsComplete !== 'boolean' || !Array.isArray(record.years) || record.years.some(item => year(item) !== item)) fail();
    } else if (source.record !== undefined) fail();
    if (source.status === 'not_found' && (source.httpStatus !== 404 || typeof source.responseSha256 !== 'string' || source.error !== undefined)) fail();
    if (source.status === 'unknown' && (typeof source.error !== 'string' || !['timeout', 'redirect_refused', 'unexpected_response_url', 'response_too_large', 'http_error', 'invalid_json', 'invalid_record', 'doi_mismatch', 'network_error'].includes(source.error))) fail();
  }
  const typedSources = sources as DoiSourceResult[];
  const found = typedSources.filter(source => source.status === 'found');
  const existence = !lookup ? 'not_checked' : found.length ? 'found' : typedSources.every(source => source.status === 'not_found') ? 'not_found' : 'unknown';
  const expected = input.expected ?? {}, requested = fields.filter(field => expected[field] !== undefined), checks = emptyChecks(expected);
  let metadata: MetadataStatus = 'not_checked';
  const actualLayers: DoiVerification['actualLayers'] = ['syntax'];
  if (lookup) actualLayers.push('registry_lookup');
  if (found.length && requested.length) {
    actualLayers.push('bibliographic_comparison');
    for (const field of requested) {
      checks[field].results = found.map(source => ({ provider: source.provider, ...compare(field, expected[field]!, source.record!) }));
      checks[field].status = checks[field].results.some(item => item.status === 'mismatch') ? 'mismatch' : checks[field].results.some(item => item.status === 'incomplete') ? 'incomplete' : 'match';
    }
    metadata = requested.some(field => checks[field].status === 'mismatch') ? 'mismatch' : requested.some(field => checks[field].status === 'incomplete') ? 'incomplete' : 'match';
  }
  if (value.existence !== existence || value.metadata !== metadata || !isDeepStrictEqual(value.actualLayers, actualLayers) || !isDeepStrictEqual(value.fieldChecks, checks)) fail();
}
