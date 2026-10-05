import {
  bindReference, boundedText, digest, makeBinding, object, receiptArtifacts, receiptFail,
  receiptLimitations, receiptVerification, safePath, sha256, strictJson,
  type ArtifactReference, type ComputationalReceipt, type HashBinding, type ReceiptFailure,
} from '../computational-receipts.js';

const immutableNames = ['audit.json', 'audit-full.md', 'REVIEW.md'] as const;
const auditStatuses = ['ROBUST_PASS', 'NEEDS_DATA', 'NOT_ASSESSED', 'NEEDS_REVISION', 'BLOCKER_DETECTED'];
const successStatuses = ['SUCCESS', 'SUCCEEDED', 'CONVERGED', 'COMPLETE', 'COMPLETED', 'PASS', 'PASSED', 'OK'];
const failureStatuses = ['FAILED', 'FAILURE', 'FAIL', 'ERROR', 'ABORTED', 'CANCELLED', 'CANCELED', 'NOT_CONVERGED'];
const sourceText = (value: unknown, fallback: string) => typeof value === 'string' && value.trim() ? boundedText(value, 4000) : fallback;
function required(files: Map<string, Buffer>, path: string): Buffer {
  const bytes = files.get(path) ?? receiptFail(`Missing BioNexus bundle artifact: ${path}.`);
  if (['manifest.json', ...immutableNames].includes(path) && bytes.length > 8 * 1024 * 1024) return receiptFail(`${path}: native BioNexus report exceeds 8 MiB.`);
  return bytes;
}
function check(files: Map<string, Buffer>, path: string, expected: unknown): void {
  if (sha256(required(files, path)) !== digest(expected)) receiptFail(`${path}: SHA-256 mismatch.`);
}

/** Passive adapter of BioNexus's native de-shadow-bundle.v1, not a replacement
 * producer schema. The native contract is additive: preserve unknown audit
 * fields as source records; never grant their claimed authority to Locus. */
export function adaptBioNexus(files: Map<string, Buffer>, explicitExecutionPath?: string): ComputationalReceipt {
  const manifestBytes = required(files, 'manifest.json');
  const manifest = strictJson(manifestBytes, 'manifest.json');
  if (manifest.schema !== 'bionexus.de-shadow-bundle.v1') return receiptFail('Unsupported BioNexus bundle schema.');
  if (manifest.scientific_authorization !== 'NONE') return receiptFail('BioNexus shadow bundles cannot grant scientific authorization.');
  if (!['SYNTHETIC_DEMO', 'USER_SUPPLIED_UNVERIFIED'].includes(String(manifest.data_origin))) return receiptFail('Unknown BioNexus data origin.');
  check(files, 'audit.json', manifest.audit_sha256);
  const audit = strictJson(required(files, 'audit.json'), 'audit.json');
  if (!auditStatuses.includes(String(audit.overall_status)) || typeof audit.passed !== 'boolean' || audit.passed !== (audit.overall_status === 'ROBUST_PASS')) return receiptFail('Unknown or inconsistent BioNexus audit status.');
  if (!Array.isArray(audit.findings) || !Array.isArray(audit.checks)) return receiptFail('BioNexus audit needs findings and checks arrays.');
  const profile = manifest.integrity_profile; const hashes = manifest.immutable_artifacts;
  let integrityStatus: 'CONSISTENT' | 'LEGACY_LIMITED' = 'LEGACY_LIMITED';
  if (profile !== undefined || hashes !== undefined) {
    if (profile !== 'bionexus.de-shadow-integrity.v1' || hashes === undefined) return receiptFail('Unsupported or incomplete BioNexus integrity profile.');
    const map = object(hashes, immutableNames); if (Object.keys(map).length !== 3) return receiptFail('BioNexus integrity profile must bind exactly three immutable reports.');
    for (const name of immutableNames) check(files, name, map[name]); integrityStatus = 'CONSISTENT';
  }
  const sourceInputs = manifest.inputs === undefined ? {} : object(manifest.inputs);
  const nativeRefs = new Map<string, ArtifactReference>();
  for (const [role, raw] of Object.entries(sourceInputs)) {
    const value = object(raw); const name = safePath(value.name);
    // Native writers intentionally use basenames only, never transport paths.
    if (name.includes('/')) return receiptFail('Native BioNexus input names must be basenames.');
    const reference = { path: name, sha256: digest(value.sha256) };
    bindReference(reference, files); nativeRefs.set(role, reference);
  }
  const declaredExecution = nativeRefs.get('execution_record');
  const executionPath = explicitExecutionPath ?? declaredExecution?.path;
  if (explicitExecutionPath && declaredExecution && explicitExecutionPath !== declaredExecution.path) return receiptFail('Selected execution receipt conflicts with the native manifest.');
  const execution = executionPath && files.has(executionPath) ? strictJson(required(files, executionPath), executionPath) : undefined;
  if (explicitExecutionPath && !execution) return receiptFail('Selected execution receipt bytes were not uploaded.');
  const executionReceiptBinding = execution ? declaredExecution ? 'MANIFEST_BOUND' as const : 'UPLOADER_ASSOCIATED' as const : 'NOT_PROVIDED' as const;
  const fitStatus = typeof execution?.fit_status === 'string' ? execution.fit_status.trim().toUpperCase() : '';
  const status: ComputationalReceipt['status'] = successStatuses.includes(fitStatus) ? 'succeeded' : failureStatuses.includes(fitStatus) ? 'failed' : fitStatus === 'PARTIAL' ? 'partial' : 'unknown';
  const matchingReference = (expected: unknown): ArtifactReference => {
    const hash = digest(expected); const matching = [...files].filter(([, bytes]) => sha256(bytes) === hash);
    if (matching.length > 1) return receiptFail('Receipt digest matches multiple uploaded paths; use a package with one unambiguous artifact per digest.');
    return { ...(matching[0] ? { path: matching[0][0] } : {}), sha256: hash };
  };
  const inputRefs = [...nativeRefs].filter(([role]) => !['analysis_code', 'execution_record', 'de_table'].includes(role)).map(([, ref]) => ref);
  const outputRefs: ArtifactReference[] = nativeRefs.has('de_table') ? [nativeRefs.get('de_table')!] : [];
  if (execution?.result_sha256 !== undefined) {
    const reference = matchingReference(execution.result_sha256);
    if (outputRefs.length && outputRefs[0]!.sha256 !== reference.sha256) return receiptFail('Execution result digest conflicts with the bundle DE table.');
    if (!outputRefs.length) outputRefs.push(reference);
  }
  const receiptInputs: Array<[string, string | undefined]> = [['counts_sha256', undefined], ['sample_metadata_sha256', 'sample_sheet'], ['design_matrix_sha256', undefined]];
  for (const [key, role] of receiptInputs) if (execution?.[key] !== undefined) {
    const reference = matchingReference(execution[key]);
    if (role && nativeRefs.has(role) && nativeRefs.get(role)!.sha256 !== reference.sha256) return receiptFail('Execution metadata digest conflicts with the native bundle input.');
    if (!inputRefs.some(ref => ref.sha256 === reference.sha256)) inputRefs.push(reference);
  }
  const code = bindReference(nativeRefs.get('analysis_code') ?? {}, files);
  const uniqueBindings = (references: ArtifactReference[]): HashBinding[] => {
    const seen = new Set<string>(); return references.map(ref => bindReference(ref, files)).filter(ref => { const key = `${ref.path}:${ref.sha256}`; if (seen.has(key)) return false; seen.add(key); return true; });
  };
  const failures: ReceiptFailure[] = [];
  for (const key of ['failures', 'errors']) if (Array.isArray(execution?.[key])) {
    if ((execution![key] as unknown[]).length > 100) return receiptFail('Too many execution failure records.');
    for (const entry of execution![key] as unknown[]) {
      if (typeof entry === 'string') failures.push({ stage: key, message: boundedText(entry, 4000) });
      else { const item = object(entry); failures.push({ stage: sourceText(item.stage, key), message: sourceText(item.message ?? item.error, JSON.stringify(item)) }); }
    }
  }
  if (typeof execution?.error === 'string') failures.push({ stage: 'execution', message: boundedText(execution.error, 4000) });
  if (status === 'failed' && !failures.length) failures.push({ stage: 'fit', message: `Producer reported fit_status=${String(execution?.fit_status)}; no detailed failure record supplied.` });
  const limitations = [...receiptLimitations,
    'BioNexus CONSISTENT checks immutable report hashes and structural audit status only. ROBUST_PASS is the producer audit result, never execution or scientific validation.',
    'Original audit findings, missing checks, cohort summary and claim boundary are preserved without automatically changing the claim assessment.',
    'Input files not selected for upload remain NOT_PROVIDED. No manifest path is read from the server filesystem.',
    'No independent manifest anchor is provided; internal consistency does not detect coordinated replacement of files and their reported hashes.',
  ];
  if (integrityStatus === 'LEGACY_LIMITED') limitations.push('Legacy bundle binds audit.json only; human reports are not bound by the original manifest.');
  if (executionReceiptBinding === 'UPLOADER_ASSOCIATED') limitations.push('The separately selected execution receipt is associated by the uploader; the BioNexus bundle did not bind it.');
  if (!execution) limitations.push('No execution receipt bytes were supplied; successful audit status does not establish a successful fit.');
  return {
    schema: 'locus.computational-evidence.v1', format: 'bionexus-de',
    tool: { name: 'BioNexus', version: sourceText(manifest.bionexus_version, 'NOT_PROVIDED') },
    status, summary: `Multi-donor differential-expression bundle; producer audit status: ${String(audit.overall_status)}.`,
    artifacts: receiptArtifacts(files, new Set(outputRefs.flatMap(item => item.path ? [item.path] : []))), binding: makeBinding(code, uniqueBindings(inputRefs), uniqueBindings(outputRefs)),
    verification: { ...receiptVerification }, failures, limitations,
    bundle: {
      schema: 'bionexus.de-shadow-bundle.v1', integrityStatus, manifestSha256: sha256(manifestBytes),
      auditStatus: String(audit.overall_status), dataOrigin: String(manifest.data_origin), audit,
      ...(execution ? { executionReceipt: execution } : {}), executionReceiptBinding,
    },
  };
}
