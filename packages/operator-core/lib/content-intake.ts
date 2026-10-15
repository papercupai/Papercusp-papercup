/// <reference path="./pdfjs-worker.d.ts" />
// The reference carries the pdf.worker.mjs module shim into EVERY program that compiles
// this file. The scripts and operator typecheck programs reach content-intake by import,
// not through operator-core's include glob, so a bare sibling .d.ts is invisible to
// them (TS7016 on the worker import below).
import { createHash } from 'node:crypto';
import { labelExternalContent, type ExternalProvenance } from './external-content';
import { readableHtmlText } from './html-to-text';

/** Already obtained bytes/text, or a reference resolved under the caller's existing ACL. */
export type ProvidedContentInput =
  | { kind: 'text' | 'selection'; text: string; ref?: string; title?: string; partial?: boolean }
  | { kind: 'html'; html: string; ref?: string; title?: string; partial?: boolean }
  | { kind: 'pdf'; bytes: Uint8Array; ref?: string; title?: string; partial?: boolean };
export type ContentInput = ProvidedContentInput
  | { kind: 'collection'; sources: ProvidedContentInput[]; ref?: string; title?: string; partial?: boolean }
  | { kind: 'reference'; ref: string };

export interface ContentReaderContext { workspaceId: string; readerId: string; signal?: AbortSignal }
export interface ContentIntakeDeps {
  /** Must use the existing source ACL/grant. Runs before load or extraction. */
  authorize(input: ContentInput, context: ContentReaderContext): Promise<boolean>;
  load?(ref: string, context: ContentReaderContext): Promise<Exclude<ContentInput, { kind: 'reference' }>>;
}
export interface ContentLimits { maxChars: number; maxInputBytes: number; maxPdfPages: number }
export const CONTENT_LIMITS: Readonly<ContentLimits> = { maxChars: 1_000_000, maxInputBytes: 20 * 1024 * 1024, maxPdfPages: 200 };
export interface ReadableContent {
  text: string;
  format: 'text' | 'selection' | 'html' | 'pdf';
  title?: string;
  sourceRefs: string[];
  provenance: ExternalProvenance;
  access: { workspaceId: string; readerId: string };
  digest: string;
  coverage: { complete: boolean; warnings: string[]; pages?: { total: number; read: number; unreadable: number[] } };
}
export class ContentIntakeError extends Error {
  constructor(readonly code: 'unauthorized' | 'unreadable' | 'input-too-large' | 'unsupported' | 'cancelled', message: string) {
    super(message); this.name = 'ContentIntakeError';
  }
}
function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ContentIntakeError('cancelled', 'Content reading was cancelled.');
}
function normalizedText(text: string): string { return text.replace(/\r\n?/g, '\n'); }
function boundedText(text: string, maxChars: number): string {
  const end = Math.min(text.length, maxChars);
  // A boundary inside a UTF-16 surrogate pair must not corrupt the final character.
  return text.slice(0, end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!) ? end - 1 : end);
}

async function readPdf(bytes: Uint8Array, limits: ContentLimits, signal?: AbortSignal) {
  // PDF.js installs its in-process handler on globalThis. Keep the import explicit
  // so esbuild includes it in hosts/sidecars instead of resolving a sibling file.
  await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  checkCancelled(signal);
  // pdfjs-dist 6 removed the eval-based font path (and its `isEvalSupported` switch).
  const task = getDocument({ data: bytes.slice(), disableFontFace: true, useWorkerFetch: false, stopAtErrors: true, verbosity: 0 });
  const abort = () => { void task.destroy(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const doc = await task.promise;
    const pages = { total: doc.numPages, read: 0, unreadable: [] as number[] };
    const warnings: string[] = [];
    const text: string[] = [];
    let chars = 0;
    if (doc.numPages > limits.maxPdfPages) warnings.push('page-limit');
    for (let pageNumber = 1; pageNumber <= Math.min(doc.numPages, limits.maxPdfPages); pageNumber++) {
      checkCancelled(signal);
      let page: Awaited<ReturnType<typeof doc.getPage>> | undefined;
      try {
        page = await doc.getPage(pageNumber);
        const content = await page.getTextContent();
        checkCancelled(signal);
        const pageText = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
        pages.read++;
        if (!pageText) pages.unreadable.push(pageNumber);
        text.push(pageText);
        chars += pageText.length + 2;
        if (chars > limits.maxChars && pageNumber < doc.numPages) { warnings.push('character-limit'); break; }
      } catch (error) {
        checkCancelled(signal);
        pages.unreadable.push(pageNumber);
        warnings.push('page-extraction-failed');
      } finally { page?.cleanup(); }
    }
    if (pages.unreadable.length) warnings.push('pages-without-readable-text');
    return { text: text.join('\n\n'), pages, warnings };
  } catch (error) {
    checkCancelled(signal);
    throw new ContentIntakeError('unreadable', error instanceof Error && error.name === 'PasswordException' ? 'This PDF requires a password; no text was read.' : 'The PDF could not be read; no complete text is available.');
  } finally {
    signal?.removeEventListener('abort', abort);
    await task.destroy();
  }
}

/** One content contract for original narration and explicit summarization. Never fetches on its own. */
export async function readContent(
  request: ContentInput,
  context: ContentReaderContext,
  deps: ContentIntakeDeps,
  options: Partial<ContentLimits> = {},
): Promise<ReadableContent> {
  const limits = { ...CONTENT_LIMITS, ...options };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Content limits must be positive safe integers.');
  checkCancelled(context.signal);
  if (!context.workspaceId.trim() || !context.readerId.trim() || !await deps.authorize(request, context)) {
    throw new ContentIntakeError('unauthorized', 'This source is outside your current access boundary.');
  }
  checkCancelled(context.signal);
  let input: Exclude<ContentInput, { kind: 'reference' }>;
  if (request.kind === 'reference') {
    if (!deps.load) throw new ContentIntakeError('unsupported', 'This source reference has no authorized reader. Supply readable text from an existing reader.');
    input = await deps.load(request.ref, context);
    checkCancelled(context.signal);
    if (input.ref !== request.ref || !await deps.authorize(input, context)) throw new ContentIntakeError('unauthorized', 'The resolved source does not match the authorized reference.');
  } else { input = request; }
  checkCancelled(context.signal);
  if (input.kind === 'collection') {
    if (!input.sources.length || input.sources.length > 20) throw new ContentIntakeError('unsupported', 'Supply between 1 and 20 provided sources.');
    const inputBytes = input.sources.reduce((total, member) => total + (member.kind === 'pdf' ? member.bytes.byteLength : Buffer.byteLength(member.kind === 'html' ? member.html : member.text, 'utf8')), 0);
    if (inputBytes > limits.maxInputBytes) throw new ContentIntakeError('input-too-large', `Sources exceed the ${limits.maxInputBytes}-byte intake limit; no complete collection was read.`);
    const members: ReadableContent[] = [];
    for (const member of input.sources) members.push(await readContent(member, context, deps, limits));
    const combined = members.map(member => member.text).join('\n\n');
    const text = boundedText(combined, limits.maxChars);
    const warnings = [...new Set([
      ...(input.partial ? ['source-partial'] : []), ...members.flatMap(member => member.coverage.warnings),
      ...(combined.length > limits.maxChars ? ['character-limit'] : []),
    ])];
    return {
      text, format: 'text', ...(input.title ? { title: input.title } : {}),
      sourceRefs: [...new Set([...(input.ref ? [input.ref] : []), ...members.flatMap(member => member.sourceRefs)])],
      provenance: labelExternalContent({ kind: 'other', label: input.ref ?? 'collection:provided' }),
      access: { workspaceId: context.workspaceId, readerId: context.readerId },
      digest: createHash('sha256').update(text).digest('hex'),
      coverage: { complete: warnings.length === 0, warnings },
    };
  }
  const raw = input.kind === 'pdf' ? input.bytes : input.kind === 'html' ? input.html : input.text;
  if ((typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength) > limits.maxInputBytes) {
    throw new ContentIntakeError('input-too-large', `Source exceeds the ${limits.maxInputBytes}-byte intake limit; no complete source was read.`);
  }
  let text: string;
  let title = input.title;
  let pages: ReadableContent['coverage']['pages'];
  const warnings: string[] = input.partial ? ['source-partial'] : [];
  if (input.kind === 'html') {
    const extracted = readableHtmlText(input.html);
    text = extracted.text; title ??= extracted.title;
  } else if (input.kind === 'pdf') {
    const extracted = await readPdf(input.bytes, limits, context.signal);
    text = extracted.text; pages = extracted.pages; warnings.push(...extracted.warnings);
  } else { text = input.text; }
  checkCancelled(context.signal);
  text = normalizedText(text);
  if (!text.trim()) throw new ContentIntakeError('unreadable', 'This source has no readable text. Scanned PDFs need OCR before they can be read or summarized.');
  if (text.length > limits.maxChars) { text = boundedText(text, limits.maxChars); warnings.push('character-limit'); }
  const sourceRefs = input.ref ? [input.ref] : [];
  return {
    text, format: input.kind, ...(title ? { title } : {}), sourceRefs,
    provenance: labelExternalContent({ kind: 'other', label: input.ref ?? `${input.kind}:provided` }),
    access: { workspaceId: context.workspaceId, readerId: context.readerId },
    digest: createHash('sha256').update(text).digest('hex'),
    coverage: { complete: warnings.length === 0, warnings: [...new Set(warnings)], ...(pages ? { pages } : {}) },
  };
}
