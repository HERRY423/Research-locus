import { createHash } from 'node:crypto';
import type { Resource } from './domain.js';

export const MAX_SELECTED_TEXT_CHARS = 65_536;
export const MAX_ARTIFACT_TEXT_CHARS = 16_384;
export interface SelectedEvidenceText {
  schemaVersion: 'locus.selected-evidence-text.v1';
  resourceSha256: string;
  chunks: Array<{ locator: string; artifactPath: string; artifactSha256: string; rendering: 'utf8_source' | 'notebook_text_outputs'; text: string; truncated: boolean }>;
  omittedArtifacts: Array<{ path: string; reason: 'text_limit' | 'not_utf8' | 'no_text_output' }>;
  limits: { maxTotalCharacters: number; maxArtifactCharacters: number };
  boundary: string;
}

/** A deterministic read view, never a rewrite of source bytes or an execution of the receipt. */
export function selectedEvidenceText(resource: Resource): SelectedEvidenceText | undefined {
  if (resource.evidenceKind !== 'computational_receipt' || !resource.computationReceipt) return undefined;
  const source = JSON.parse(resource.content) as { files: Array<{ path: string; contentBase64: string }> };
  const result: SelectedEvidenceText = {
    schemaVersion: 'locus.selected-evidence-text.v1', resourceSha256: resource.sha256, chunks: [], omittedArtifacts: [],
    limits: { maxTotalCharacters: MAX_SELECTED_TEXT_CHARS, maxArtifactCharacters: MAX_ARTIFACT_TEXT_CHARS },
    boundary: 'Selected uploaded bytes only. Artifact locators and exact displayed quotes are required for receipt candidates. Notebook text is a derived output view; nothing is executed. A matching quote does not validate its interpretation.',
  };
  let remaining = MAX_SELECTED_TEXT_CHARS;
  // Upload order is preserved and therefore stable for this immutable resource.
  for (const file of source.files) {
    if (!remaining) { result.omittedArtifacts.push({path:file.path,reason:'text_limit'}); continue; }
    const bytes = Buffer.from(file.contentBase64, 'base64');
    const artifact = resource.computationReceipt.artifacts.find(item => item.path === file.path);
    let text: string;
    const notebook = file.path.toLowerCase().endsWith('.ipynb');
    if (notebook) {
      if (!artifact?.preview) { result.omittedArtifacts.push({path:file.path,reason:'no_text_output'}); continue; }
      text = artifact.preview;
    } else {
      try { text = new TextDecoder('utf-8', {fatal:true}).decode(bytes); }
      catch { result.omittedArtifacts.push({path:file.path,reason:'not_utf8'}); continue; }
    }
    const limit = Math.min(remaining, MAX_ARTIFACT_TEXT_CHARS);
    const displayed = text.slice(0, limit);
    result.chunks.push({ locator:`artifact:${file.path}`, artifactPath:file.path, artifactSha256:createHash('sha256').update(bytes).digest('hex'), rendering:notebook?'notebook_text_outputs':'utf8_source', text:displayed, truncated:text.length>limit || (notebook && text.length>=4000) });
    remaining -= displayed.length;
  }
  return result;
}

export function quoteInSelectedResource(resource: Resource, quote: string, locator: string): boolean {
  const selected = selectedEvidenceText(resource);
  return selected ? selected.chunks.some(chunk => chunk.locator === locator && chunk.text.includes(quote)) : resource.content.includes(quote);
}

export function explicitResourceRead(resource: Resource): Resource & { evidenceText?: SelectedEvidenceText } {
  const evidenceText = selectedEvidenceText(resource);
  return evidenceText ? {...resource,evidenceText} : resource;
}
