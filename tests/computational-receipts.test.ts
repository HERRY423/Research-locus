import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { parseComputationalReceipt, parseReceiptFiles, ReceiptError, sha256, strictJson, MAX_RECEIPT_BYTES, type ComputationalReceiptInput, type GenericReceiptManifest } from '../src/computational-receipts.js';
import { ReviewStore, verifyState } from '../src/domain.js';

const upload = (path: string, content: string | Buffer) => ({ path, contentBase64: Buffer.from(content).toString('base64') });
function generic(): ComputationalReceiptInput {
  const content = { 'analysis.R': '# synthetic demonstration; never executed\n', 'counts.csv': 'donor,condition,count\na,A,2\nb,B,3\n', 'de.csv': 'gene,log2FoldChange,padj\nX,0.7,0.04\n' };
  const ref = (path: keyof typeof content) => ({ path, sha256: sha256(content[path]) });
  return { format: 'generic', files: Object.entries(content).map(([path, value]) => upload(path, value)), manifest: {
    schema: 'locus.computational-receipt.v1', tool: { name: 'synthetic-DE', version: 'test-1' }, status: 'succeeded',
    code: ref('analysis.R'), inputs: [ref('counts.csv')], outputs: [ref('de.csv')], failures: [], summary: 'Synthetic transport test only.',
  } };
}
function bundle(legacy = false): ComputationalReceiptInput {
  const native = generic(); const manifest = native.manifest!;
  const execution = { method: 'pydeseq2', method_version: '0.5.2', statistical_unit: 'donor', fit_status: 'COMPLETE', design: '~ condition', design_matrix_columns: ['Intercept', 'conditionB'], n_donors: 2, donor_ids: ['a', 'b'], result_sha256: manifest.outputs[0]!.sha256, sample_metadata_sha256: manifest.inputs[0]!.sha256, warnings: ['Synthetic fixture, not executed.'] };
  const audit = { overall_status: 'NEEDS_DATA', passed: false, cohort_summary: { n_donors: 2 }, checks: [{ check_id: 'input_count_type', status: 'MISSING_EVIDENCE' }], findings: [], claim_boundary: { overall_maturity: 'NOT_ASSESSED' } };
  const auditText = JSON.stringify(audit); const executionText = JSON.stringify(execution); const full = '# Synthetic full audit\n'; const review = '# Synthetic review\n';
  const producerManifest = { schema: 'bionexus.de-shadow-bundle.v1', bionexus_version: '1.0.0-rc.8', scientific_authorization: 'NONE', data_origin: 'SYNTHETIC_DEMO', audit_sha256: sha256(auditText), inputs: {
    analysis_code: { name: 'analysis.R', sha256: manifest.code.sha256 }, sample_sheet: { name: 'counts.csv', sha256: manifest.inputs[0]!.sha256 }, de_table: { name: 'de.csv', sha256: manifest.outputs[0]!.sha256 }, execution_record: { name: 'receipt.json', sha256: sha256(executionText) },
  }, ...(!legacy ? { integrity_profile: 'bionexus.de-shadow-integrity.v1', immutable_artifacts: { 'audit.json': sha256(auditText), 'audit-full.md': sha256(full), 'REVIEW.md': sha256(review) } } : {}) };
  return { format: 'bionexus-de', files: [...native.files, upload('manifest.json', JSON.stringify(producerManifest)), upload('audit.json', auditText), upload('audit-full.md', full), upload('REVIEW.md', review), upload('receipt.json', executionText)] };
}
const bad = (fn: () => unknown) => assert.throws(fn, ReceiptError);
test('valid files at the 10 MiB limit do not exhaust the base64 parser stack',()=>{
  const bytes=Buffer.alloc(MAX_RECEIPT_BYTES,97);
  const files=parseReceiptFiles([upload('at-limit.bin',bytes)]);
  assert.equal(files.get('at-limit.bin')!.length,MAX_RECEIPT_BYTES);
  assert.equal(sha256(files.get('at-limit.bin')!),sha256(bytes));
  for(const invalid of ['AAAA====','AA=A','AB==','AAA=AAAA'])bad(()=>parseReceiptFiles([{path:'bad.bin',contentBase64:invalid}]));
});
function replaceJson(input: ComputationalReceiptInput, path: string, change: (value: Record<string, unknown>) => void) {
  const file = input.files.find(file => file.path === path)!; const value = JSON.parse(Buffer.from(file.contentBase64, 'base64').toString('utf8')) as Record<string, unknown>; change(value); file.contentBase64 = Buffer.from(JSON.stringify(value)).toString('base64');
}

test('computational receipt binds exact code, input and output bytes without claiming execution', () => {
  const input = generic(); const receipt = parseComputationalReceipt(input);
  assert.equal(receipt.binding.status, 'COMPLETE_BYTES');
  assert.ok([receipt.binding.code, ...receipt.binding.inputs, ...receipt.binding.outputs].every(item => item.verification === 'MATCHED'));
  assert.equal(receipt.verification.execution, 'NOT_VERIFIED'); assert.equal(receipt.verification.scientific, 'NOT_ASSESSED');
  assert.match(receipt.artifacts.find(item => item.path === 'de.csv')!.preview!, /log2FoldChange/);
  assert.equal(receipt.artifacts.find(item => item.path === 'counts.csv')!.preview, undefined);
  assert.ok(!JSON.stringify(receipt).includes('contentBase64'));
  assert.deepEqual(parseComputationalReceipt(JSON.parse(JSON.stringify(input))), receipt);
  const updated = generic(); updated.manifest!.tool.version = 'test-2'; assert.equal(parseComputationalReceipt(updated).tool.version, 'test-2');
  updated.manifest!.code.sha256 = sha256('changed code'); bad(() => parseComputationalReceipt(updated));
});

test('missing bytes or missing declarations remain NOT_PROVIDED and failures are retained', () => {
  const input = generic(); input.files = input.files.filter(item => item.path !== 'analysis.R');
  let receipt = parseComputationalReceipt(input); assert.equal(receipt.binding.code.verification, 'NOT_PROVIDED'); assert.equal(receipt.binding.status, 'INCOMPLETE');
  input.manifest!.code = {}; input.manifest!.status = 'failed'; input.manifest!.outputs = []; input.manifest!.failures = [{ stage: 'fit', message: 'Model did not converge.' }];
  receipt = parseComputationalReceipt(input); assert.equal(receipt.status, 'failed'); assert.equal(receipt.binding.code.sha256, null); assert.equal(receipt.failures[0]!.message, 'Model did not converge.');
});

test('unknown envelope fields, unsafe paths, duplicate paths, bad base64 and oversized uploads fail', () => {
  bad(() => parseComputationalReceipt({ ...generic(), filesystemPath: 'C:/private' }));
  for (const path of ['../evil.csv', '/abs.csv', 'C:/abs.csv', 'a\\b.csv', 'a/./b.csv', 'trailing.']) { const input = generic(); input.files[0]!.path = path; bad(() => parseComputationalReceipt(input)); }
  let input = generic(); input.files.push({ ...input.files[0]!, path: 'ANALYSIS.R' }); bad(() => parseComputationalReceipt(input));
  input = generic(); input.files[0]!.contentBase64 = 'a=== '; bad(() => parseComputationalReceipt(input));
  input = generic(); input.files = [upload('huge.csv', Buffer.alloc(MAX_RECEIPT_BYTES + 1))]; bad(() => parseComputationalReceipt(input));
  input = generic(); (input.manifest as unknown as Record<string, unknown>).scientificApproval = true; bad(() => parseComputationalReceipt(input));
});

test('notebook outputs expose only text and error summaries; rich output is never executed', () => {
  const input = generic(); const notebook = JSON.stringify({ nbformat: 4, cells: [{ cell_type: 'code', source: ['throw new Error("never execute")'], outputs: [
    { output_type: 'display_data', data: { 'text/html': '<script>globalThis.pwned=true</script>', 'application/javascript': 'globalThis.pwned=true', 'text/plain': ['X: ', '0.7'] } },
    { output_type: 'error', ename: 'FitError', evalue: 'not converged' },
  ] }] });
  input.files.push(upload('result.ipynb', notebook)); input.manifest!.outputs.push({ path: 'result.ipynb', sha256: sha256(notebook) });
  const receipt = parseComputationalReceipt(input); const preview = receipt.artifacts.find(item => item.path === 'result.ipynb')!.preview!;
  assert.match(preview, /X: 0.7/); assert.match(preview, /FitError/); assert.doesNotMatch(preview, /script|pwned|never execute/);
  input.files.find(file => file.path === 'result.ipynb')!.contentBase64 = Buffer.from('{"nbformat":3,"cells":[]}').toString('base64'); input.manifest!.outputs.pop(); bad(() => parseComputationalReceipt(input));
});

test('native BioNexus integrity and multi-donor receipt survive without promoting scientific status', () => {
  const receipt = parseComputationalReceipt(bundle());
  assert.equal(receipt.bundle!.integrityStatus, 'CONSISTENT'); assert.equal(receipt.bundle!.executionReceiptBinding, 'MANIFEST_BOUND');
  assert.equal(receipt.bundle!.auditStatus, 'NEEDS_DATA'); assert.equal(receipt.status, 'succeeded'); assert.equal(receipt.binding.status, 'COMPLETE_BYTES');
  assert.equal(receipt.bundle!.executionReceipt!.n_donors, 2); assert.equal(receipt.tool.version, '1.0.0-rc.8');
  assert.equal((receipt.bundle!.audit.checks as Array<Record<string, unknown>>)[0]!.status, 'MISSING_EVIDENCE');
  assert.equal(receipt.verification.execution, 'NOT_VERIFIED'); assert.equal(parseComputationalReceipt(bundle(true)).bundle!.integrityStatus, 'LEGACY_LIMITED');
});

test('BioNexus missing artifacts stay unknown; report or cross-receipt tampering is rejected', () => {
  let input = bundle(); input.files = input.files.filter(item => !['analysis.R', 'counts.csv', 'de.csv', 'receipt.json'].includes(item.path));
  const receipt = parseComputationalReceipt(input); assert.equal(receipt.status, 'unknown'); assert.equal(receipt.binding.status, 'INCOMPLETE'); assert.equal(receipt.bundle!.executionReceiptBinding, 'NOT_PROVIDED');
  input = bundle(); input.files.find(item => item.path === 'REVIEW.md')!.contentBase64 = Buffer.from('tampered').toString('base64'); bad(() => parseComputationalReceipt(input));
  input = bundle(); replaceJson(input, 'manifest.json', value => { value.schema = 'bionexus.de-shadow-bundle.v999'; }); bad(() => parseComputationalReceipt(input));
  input = bundle(); replaceJson(input, 'manifest.json', value => { value.scientific_authorization = 'APPROVED'; }); bad(() => parseComputationalReceipt(input));
  input = bundle(); replaceJson(input, 'receipt.json', value => { value.result_sha256 = sha256('different output'); });
  const modified = input.files.find(item => item.path === 'receipt.json')!;
  replaceJson(input, 'manifest.json', value => { ((value.inputs as Record<string, { sha256: string }>).execution_record!).sha256 = sha256(Buffer.from(modified.contentBase64, 'base64')); });
  bad(() => parseComputationalReceipt(input));
});

test('BioNexus failed and separately associated execution receipts retain limits and failure records', () => {
  const input = bundle();
  replaceJson(input, 'receipt.json', value => { value.fit_status = 'FAILED'; value.errors = ['Singular model matrix']; value.failures = [{ stage: 'fit', message: 'No usable coefficients.' }]; });
  replaceJson(input, 'manifest.json', value => { delete (value.inputs as Record<string, unknown>).execution_record; });
  input.executionReceiptPath = 'receipt.json';
  const receipt = parseComputationalReceipt(input);
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.bundle!.executionReceiptBinding, 'UPLOADER_ASSOCIATED');
  assert.equal(receipt.failures.length, 2); assert.ok(receipt.limitations.some(text => text.includes('associated by the uploader')));
  assert.equal(receipt.verification.execution, 'NOT_VERIFIED');
});

test('strict producer JSON rejects duplicate fields, nonfinite numbers and trailing content', () => {
  for (const content of ['{"x":1,"x":2}', '{"x":1e999}', '{"x":NaN}', '{} {}', '{"x":[1,]}']) bad(() => strictJson(Buffer.from(content), 'test.json'));
  assert.equal(strictJson(Buffer.from('\uFEFF{"safe":{"value":"quoted \\\" text"}}'), 'test.json').safe !== undefined, true);
});

test('stored receipt import is atomic, researcher-bound and reproducibly verified after restart', () => {
  const directory = mkdtempSync(join(process.cwd(), '.receipt-test-')); const researcher = { kind: 'researcher' as const, id: 'test' };
  try {
    const filePath = join(directory, 'state.json');
    const store = new ReviewStore({ filePath, initial: { projectId: 'receipt-test', title: 'Synthetic receipts' } });
    store.act({ type: 'create_claim', text: 'Synthetic DE association.', scope: 'cohort', rationale: 'Synthetic test.' }, 0, researcher);
    const claimId = store.getState().claims[0]!.id;
    const action = { type: 'import_computational_receipt' as const, claimId, receipt: generic(), rationale: 'Synthetic transport verification.' };
    const before = JSON.stringify(store.getState());
    assert.throws(() => store.act(action, 1, { kind: 'agent', id: 'agent-test' })); assert.equal(JSON.stringify(store.getState()), before);
    const invalid = generic(); invalid.files[0]!.contentBase64 = Buffer.from('changed').toString('base64'); assert.throws(() => store.act({ ...action, receipt: invalid }, 1, researcher)); assert.equal(JSON.stringify(store.getState()), before);
    store.act(action, 1, researcher); const saved = store.getState(); const resource = saved.resources.find(item => item.evidenceKind === 'computational_receipt')!;
    assert.equal(resource.computationReceipt!.binding.status, 'COMPLETE_BYTES');
    const restored = new ReviewStore({ filePath }); assert.deepEqual(restored.getState(), saved); verifyState(restored.getState());
    const damaged = structuredClone(saved); damaged.resources.find(item => item.id === resource.id)!.computationReceipt!.verification.execution = 'VERIFIED' as never;
    assert.throws(() => verifyState(damaged)); assert.ok(readFileSync(join(directory, 'state.json'), 'utf8').includes('computational_receipt'));
  } finally { assert.ok(resolve(directory).startsWith(`${resolve(process.cwd())}${sep}.receipt-test-`)); rmSync(directory, { recursive: true, force: true }); }
});

test('portable package helper reads selected files only and refuses overwrite', () => {
  const directory = mkdtempSync(join(process.cwd(), '.receipt-package-test-'));
  try {
    const original = bundle(); const nativeDir = join(directory, 'native'); mkdirSync(nativeDir);
    for (const file of original.files) writeFileSync(join(nativeDir, file.path), Buffer.from(file.contentBase64, 'base64'));
    writeFileSync(join(nativeDir, 'not-selected.txt'), 'Must not be uploaded automatically.');
    const output = join(directory, 'package.json');
    const args = ['scripts/package-computational-receipt.mjs', '--bundle', nativeDir, '--out', output];
    const packaged = spawnSync(process.execPath, args, { encoding: 'utf8' }); assert.equal(packaged.status, 0, packaged.stderr);
    const input = JSON.parse(readFileSync(output, 'utf8')) as ComputationalReceiptInput;
    assert.equal(input.files.length, 4); assert.ok(!input.files.some(file => file.path === 'not-selected.txt'));
    assert.equal(parseComputationalReceipt(input).bundle!.integrityStatus, 'CONSISTENT');
    assert.equal(parseComputationalReceipt(input).binding.status, 'INCOMPLETE');
    const before = readFileSync(output); const repeated = spawnSync(process.execPath, args, { encoding: 'utf8' }); assert.notEqual(repeated.status, 0); assert.deepEqual(readFileSync(output), before);
  } finally { assert.ok(resolve(directory).startsWith(`${resolve(process.cwd())}${sep}.receipt-package-test-`)); rmSync(directory, { recursive: true, force: true }); }
});
