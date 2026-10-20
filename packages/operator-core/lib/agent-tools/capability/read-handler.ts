/**
 * capability:read — read a file, mirroring the native Read tool's ergonomics
 * (offset/limit line windowing, cat -n line numbers, long-line truncation).
 * `raw:true` opts into exact undecorated text for a line window, for callers
 * that will pass the result to a write rather than only inspect it.
 * Read-only, so it takes no file lock. Part of P-010
 * (`agent-capability-confinement-2026-06-13`).
 */

import { createReadStream, existsSync } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import type { PhaseTracker } from '@papercusp/tooldef';
import { resolveCapabilityBaseDir, resolveCapabilityIntegrationRoot } from './base-dir';
import { CHARS_PER_TOKEN_ESTIMATE, computeTurnDoors } from '../../context-doors';
import { selectUnambiguousEvidenceRoot } from '../../evidence-root-selection';
import { SCRATCH_SCHEME, safeScratchFilesystemPath } from '../../scratch-uri';
import { findMistypedScratchSpill, type RecoveredScratchSpill } from '../../scratch-path-recovery';
import {
  QUERY_DEFAULT_CONTEXT,
  QUERY_DEFAULT_MAX_MATCHES,
  QUERY_MAX_CONTEXT,
  QUERY_MAX_MATCHES,
  VIEW_DEFAULT_LIMIT,
  VIEW_MAX_LIMIT,
  querySavedResult,
  readSavedResultLines,
} from './read-query';
import { redactSensitiveText } from '../../sensitive-text';
import {
  SCRATCH_REFERENCE_MAGIC,
  authorizeScratchReference,
  isDurableScratchReferenceUri,
  isVolatileScratchReferenceUri,
  parseScratchReference,
  readDurableScratchReference,
  readVolatileScratchReference,
  ScratchReferenceError,
  type ScratchReferenceManifest,
} from '../../scratch-reference';
import { OUTPUT_EVIDENCE_CLASSES } from '../../output-envelope';
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';

/**
 * Exported so the bash-substitution audit can PIN its model to it
 * (`pairs/model-drift.test.ts`, WI-6157/D-015). `pairs/file-read.ts` scores
 * `head`/`cat` coverage against a hand-copied `READ_DEFAULT_LIMIT`; if this
 * default changes and the copy does not, the audit emits `capability:read`
 * expressions that silently read a different number of lines than the bash
 * they claim to replace.
 */
export const DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
export const MAX_FILE_BYTES = 50 * 1024 * 1024; // refuse unbounded reads outright
export const MAX_BYTE_PAGE = 4_096;

const LINE_WINDOW_EXCLUSIVITY =
  'Mutually exclusive with byte windows (byte_offset, byte_limit), content_indexes, and evidence_class.';
const BYTE_WINDOW_EXCLUSIVITY =
  'Mutually exclusive with line windows (offset, limit, tail), content_indexes, and evidence_class.';
const CONTENT_INDEX_EXCLUSIVITY =
  'Mutually exclusive with line windows (offset, limit, tail), byte windows (byte_offset, byte_limit), and evidence_class.';
const EVIDENCE_CLASS_EXCLUSIVITY =
  'Text or Markdown scratch spills do not support evidence selection; read them with line or byte windows. Mutually exclusive with content_indexes, line windows (offset, limit, tail), and byte windows (byte_offset, byte_limit).';
const SCRATCH_LINE_WINDOW_SIZE_NOTE =
  'Scratch-reference line windows can be refused when selected text exceeds the response-size limit; reduce limit/tail or use byte_offset+byte_limit for exact large text.';

const CAPABILITY_READ_SEE_ALSO = [
  'capability:edit (exact-string edit)',
  'capability:write (overwrite / create)',
  'capability:bash (grep / rg to search across files)',
] as const;

/**
 * Config/auth files are useful diagnostics but are not safe exact-read inputs:
 * Codex's config.toml carries the per-session MCP bearer, and the other names
 * below commonly carry credentials or server headers as well. Keep ordinary
 * line reads useful by redacting their values, while refusing raw/byte/structured
 * modes so a caller cannot bypass the redaction boundary (or write a redacted
 * placeholder back through the raw-read → edit/write flow).
 */
function isCredentialBearingConfigPath(absPath: string): boolean {
  const normalized = absPath.replaceAll('\\', '/').toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (
    basename === 'config.toml' ||
    basename === 'auth.json' ||
    basename === 'credential.json' ||
    basename === 'credentials.json' ||
    basename === 'oauth.json' ||
    basename === '.mcp.json' ||
    basename === '.env' ||
    basename.startsWith('.env.')
  ) return true;
  return basename === 'settings.json' &&
    (normalized.includes('/.claude/') || normalized.includes('/.codex/') || normalized.includes('/su-codex-homes/'));
}

/**
 * Machine-oriented read modes promise an exact or structured payload. Appending
 * human guidance to those results corrupts raw JSON recovered from a result-door
 * spill and base64/selection envelopes alike. Keep cross-links on the ordinary
 * human-readable line view only.
 */
export function capabilityReadSeeAlso(
  _result: unknown,
  args: unknown,
): readonly string[] {
  // ToolGuidance.seeAlso deliberately passes `args: unknown`; narrowing the callback
  // parameter itself makes defineTool's role-tool overload inapplicable and TypeScript
  // falls through to the unrelated route overload (EI-21534077294118083). Keep the public
  // callback broad and narrow defensively inside it.
  const readArgs = args && typeof args === 'object' && !Array.isArray(args)
    ? args as {
        raw?: boolean;
        byte_offset?: number;
        byte_limit?: number;
        content_indexes?: number[];
        evidence_class?: string;
      }
    : {};
  if (
    readArgs.raw ||
    readArgs.byte_offset !== undefined ||
    readArgs.byte_limit !== undefined ||
    readArgs.content_indexes !== undefined ||
    readArgs.evidence_class !== undefined
  ) return [];
  return CAPABILITY_READ_SEE_ALSO;
}

/** base64 encodes 3 bytes as 4 chars, padded up to the next multiple of 4. */
function base64Chars(byteCount: number): number {
  return Math.ceil(byteCount / 3) * 4;
}

/** Slack for JSON escaping inside `file_path` and for door-budget arithmetic we
 *  do not want to depend on to the last character. */
const DOOR_MARGIN_CHARS = 256;

/** The normal minimum page size for a caller that asks for a full-sized window.
 *  Explicitly smaller requests remain valid when the path can fit them. */
export const MIN_PAGE_BYTES = 512;

/**
 * WI-39670: the largest page whose base64 payload PLUS this response's own
 * envelope still fits the `resultEach` door.
 *
 * Every tool result passes that door, and an over-budget result is projected —
 * for this tool that means `data` is truncated MID-BASE64. Decoding the result
 * then yields a valid plaintext prefix followed by `invalid input`, i.e. silent
 * corruption of the byte-window recovery path, with `ok:true`, `eof:false` and a
 * well-formed `next_cursor` all still looking healthy. `MAX_BYTE_PAGE` (4096)
 * alone is 5464 chars of base64 — already over the 6000-char door once the
 * envelope is counted, so the maximum page the schema ADVERTISES could never be
 * returned intact.
 *
 * The envelope is measured, not guessed, because `file_path` is absolute and
 * appears TWICE (top level and again in `next_cursor.args`) — a deep scratch path
 * moves this by hundreds of chars, which is why a fixed smaller constant would
 * only move the cliff rather than remove it. Clamping is lossless: `byte_length`
 * and `next_cursor` describe the page actually returned, so paging simply takes
 * more steps.
 *
 * May return LESS than MIN_PAGE_BYTES (including 0) for a pathological path. An
 * explicitly small caller request may still use that smaller fitted page; the
 * handler refuses only when no positive page fits, or when a normal-sized
 * request would be silently reduced below the efficiency floor. Clamping up to
 * a floor would re-emit an over-budget response and reintroduce the silent
 * truncation this exists to prevent.
 */
export function doorSafePageBytes(
  absPath: string,
  requestedBytes: number,
  reference?: ScratchReferenceManifest,
): number {
  const envelopeChars = JSON.stringify({
    ok: true,
    file_path: absPath,
    encoding: 'base64',
    byte_offset: Number.MAX_SAFE_INTEGER,
    byte_length: Number.MAX_SAFE_INTEGER,
    total_bytes: Number.MAX_SAFE_INTEGER,
    ...(reference ? { reference } : {}),
    eof: false,
    data: '',
    next_cursor: {
      tool: 'capability:read',
      args: { file_path: absPath, byte_offset: Number.MAX_SAFE_INTEGER, byte_limit: MAX_BYTE_PAGE },
    },
  }).length;
  // Mirrors how RESULT_DOOR_TOKENS is derived (result-door.ts): the BAKED floor
  // door. A session configured with a WIDER door just gets smaller pages than it
  // strictly needs, which is safe; sizing to a wider door would not be.
  const budgetChars = computeTurnDoors(0).resultEach * CHARS_PER_TOKEN_ESTIMATE;
  const room = budgetChars - envelopeChars - DOOR_MARGIN_CHARS;
  const fits = Math.floor(Math.max(0, room) / 4) * 3;
  return Math.min(requestedBytes, fits);
}

/** Scratch references are returned unchanged by tools:invoke, so an oversized
 * line view would spill into another scratch reference and repeat the same read.
 * Leave the same envelope slack used by byte pages before allowing a text window. */
function scratchLineWindowExceedsDoor(text: string): boolean {
  const budgetBytes = computeTurnDoors(0).resultEach * CHARS_PER_TOKEN_ESTIMATE;
  return Buffer.byteLength(text, 'utf8') > budgetBytes - DOOR_MARGIN_CHARS;
}

/**
 * Numbered scratch-reference reads must never turn a recoverable JSON/text line
 * into an apparently complete prefix. Ordinary source-file reads retain the
 * native `[line truncated]` display, but a result-door spill is the recovery
 * container the caller was told to parse. A long selected line therefore needs
 * the explicit byte-page route even when the shortened display would fit the
 * result door.
 */
function scratchLineWindowHasLongLine(lines: readonly string[]): boolean {
  return lines.some((line) => line.length > MAX_LINE_CHARS);
}

/** A scratch-reference read returns stored tool output verbatim. Markers such
 * as `textTruncated` inside that stored payload describe its original producer,
 * not a truncation performed by this read; the result door uses this metadata
 * to avoid wrapping the same disclosure in another recursively unreadable
 * reference envelope. */
function markScratchReferenceRead<T>(result: T, reference?: ScratchReferenceManifest): T {
  if (!reference || result === null || typeof result !== 'object') return result;
  const row = result as Record<string, unknown>;
  const metadata = row._meta !== null && typeof row._meta === 'object' && !Array.isArray(row._meta)
    ? row._meta as Record<string, unknown>
    : {};
  const capabilityReadMetadata = metadata.capabilityRead !== null && typeof metadata.capabilityRead === 'object' && !Array.isArray(metadata.capabilityRead)
    ? metadata.capabilityRead as Record<string, unknown>
    : {};
  return {
    ...row,
    _meta: {
      ...metadata,
      capabilityRead: { ...capabilityReadMetadata, source: 'scratch-reference' },
    },
  } as T;
}

const readPathArgs = {
  file_path: z.string().min(1).optional().describe('Absolute path, ~/-relative, or relative to the project dir.'),
  uri: z.string().min(1).optional().describe('A papercusp://scratch URI alias for file_path, as emitted by result-door cursors.'),
};

const QUERY_EXCLUSIVITY =
  'Mutually exclusive with line windows (offset, limit, tail), byte windows (byte_offset, byte_limit), content_indexes, and evidence_class.';
/** Present on every non-query branch so a stray `query` is rejected instead of silently stripped. */
const notQuery = {
  query: z.never().optional().describe(`Only valid for a saved-result query. ${QUERY_EXCLUSIVITY}`),
};
/** Present on every branch but the view window, for the same reason (WI-6554700010008917). */
const notView = {
  view_lines: z.never().optional().describe('Only valid alone: reads lines of the searched view.'),
};

const lineWindowArgs = z.object({
  ...readPathArgs,
  ...notQuery,
  ...notView,
  offset: z.number().int().nonnegative().optional().describe(
    `1-based line to start from. ${SCRATCH_LINE_WINDOW_SIZE_NOTE} ${LINE_WINDOW_EXCLUSIVITY}`,
  ),
  limit: z.number().int().positive().optional().describe(
    `Max lines to read (default ${DEFAULT_LIMIT}). ${SCRATCH_LINE_WINDOW_SIZE_NOTE} ${LINE_WINDOW_EXCLUSIVITY}`,
  ),
  tail: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Read the LAST N lines instead of reading forward — the \`tail -n N\` equivalent. Ignores offset. ${SCRATCH_LINE_WINDOW_SIZE_NOTE} ${LINE_WINDOW_EXCLUSIVITY}`,
    ),
  raw: z
    .boolean()
    .optional()
    .describe('Return the selected text window without the path header, line-number prefixes, or paging footer. Use when the result will be written back. Raw text windows are mutually exclusive with byte windows (byte_offset, byte_limit).'),
  byte_offset: z.never().optional().describe(`Only valid for byte windows. ${BYTE_WINDOW_EXCLUSIVITY}`),
  byte_limit: z.never().optional().describe(`Only valid for byte windows. ${BYTE_WINDOW_EXCLUSIVITY}`),
  content_indexes: z.never().optional().describe(`Only valid for content-index selection. ${CONTENT_INDEX_EXCLUSIVITY}`),
  evidence_class: z.never().optional().describe(`Only valid for evidence-class selection. ${EVIDENCE_CLASS_EXCLUSIVITY}`),
});

const byteWindowArgs = z.object({
  ...readPathArgs,
  ...notQuery,
  ...notView,
  offset: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  limit: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  tail: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  // Keep this field parseable so callers that accidentally combine modes reach
  // the handler's explicit `mixed_window_modes` diagnostic instead of Zod's
  // opaque `expected never` error at the transport boundary.
  raw: z.boolean().optional().describe('Raw text windows are mutually exclusive with byte windows (byte_offset, byte_limit).'),
  byte_offset: z.number().int().nonnegative().describe(`0-based byte offset for an exact base64 page. Use with byte_limit. ${BYTE_WINDOW_EXCLUSIVITY}`),
  byte_limit: z
    .number()
    .int()
    .positive()
    .max(MAX_BYTE_PAGE)
    .describe(
      `Bytes to return as base64 (max ${MAX_BYTE_PAGE}), an UPPER BOUND — the page is clamped to ` +
        `fit the result door, so read byte_length and follow next_cursor. Use with byte_offset. ${BYTE_WINDOW_EXCLUSIVITY}`,
    ),
  content_indexes: z.never().optional().describe(`Only valid for content-index selection. ${CONTENT_INDEX_EXCLUSIVITY}`),
  evidence_class: z.never().optional().describe(`Only valid for evidence-class selection. ${EVIDENCE_CLASS_EXCLUSIVITY}`),
});

const contentIndexArgs = z.object({
  ...readPathArgs,
  ...notQuery,
  ...notView,
  offset: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  limit: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  tail: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  raw: z.boolean().optional().describe('Return the selected content items without altering the stable reference selection.'),
  byte_offset: z.never().optional().describe(`Only valid for byte windows. ${BYTE_WINDOW_EXCLUSIVITY}`),
  byte_limit: z.never().optional().describe(`Only valid for byte windows. ${BYTE_WINDOW_EXCLUSIVITY}`),
  content_indexes: z
    .array(z.number().int().nonnegative())
    .min(1)
    .max(64)
    .describe(`For a stable result-door reference whose payload contains an MCP content array, return only these item indexes under the response's content field. A dispatch-level projection sees the capability:read response (for example, content[].text); it does not parse JSON serialized inside a selected text item's text. Use evidence_class when the reference supplies indexed JSON pointers. ${CONTENT_INDEX_EXCLUSIVITY}`),
  evidence_class: z.never().optional().describe(`Only valid for evidence-class selection. ${EVIDENCE_CLASS_EXCLUSIVITY}`),
});

const evidenceClassArgs = z.object({
  ...readPathArgs,
  ...notQuery,
  ...notView,
  offset: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  limit: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  tail: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  raw: z.boolean().optional().describe('Return the selected evidence values without altering the stable reference selection.'),
  byte_offset: z.never().optional().describe(`Only valid for byte windows. ${BYTE_WINDOW_EXCLUSIVITY}`),
  byte_limit: z.never().optional().describe(`Only valid for byte windows. ${BYTE_WINDOW_EXCLUSIVITY}`),
  content_indexes: z.never().optional().describe(`Only valid for content-index selection. ${CONTENT_INDEX_EXCLUSIVITY}`),
  evidence_class: z.enum(OUTPUT_EVIDENCE_CLASSES).describe(
    `For a stable result-door reference with a JSON MCP content envelope, resolve only the values indexed for this evidence class. ${EVIDENCE_CLASS_EXCLUSIVITY}`,
  ),
});

/**
 * Keep the mutually exclusive read modes in the published JSON Schema as well
 * as in runtime validation. A single optional object plus superRefine only
 * describes the conflict in prose; callers then discover it after dispatch.
 * The `z.never().optional()` fields emit the `not` constraints that make each
 * anyOf branch reject the other window modes.
 */
/**
 * Saved-result query (token-efficiency-prompts-cache-and-behavior-2026-10-11 P-005): search the
 * whole retained body of a spill (or any readable file) for lines containing every term, instead
 * of paging base64. Same authorization/expiry gate as every other mode.
 */
const queryArgs = z.object({
  ...readPathArgs,
  ...notView,
  query: z.string().trim().min(1).max(200).describe(
    `Search the whole saved result for lines containing EVERY whitespace-separated term (case-insensitive, literal) and return only those lines with line numbers, context and coverage. JSON is searched pretty-printed, multi-line strings expanded between """ fences. Read around a hit with view_lines. ${QUERY_EXCLUSIVITY}`,
  ),
  query_context: z.number().int().nonnegative().max(QUERY_MAX_CONTEXT).optional().describe(`Context lines around each match (default ${QUERY_DEFAULT_CONTEXT}).`),
  query_max_matches: z.number().int().positive().max(QUERY_MAX_MATCHES).optional().describe(`Max matches returned (default ${QUERY_DEFAULT_MAX_MATCHES}); matchCount still counts all.`),
  query_from_line: z.number().int().positive().optional().describe('Resume from this line of the searched view (use next_cursor).'),
  offset: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  limit: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  tail: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  raw: z.never().optional().describe(`Not valid for a query. ${QUERY_EXCLUSIVITY}`),
  byte_offset: z.never().optional().describe(`Only valid for byte windows. ${BYTE_WINDOW_EXCLUSIVITY}`),
  byte_limit: z.never().optional().describe(`Only valid for byte windows. ${BYTE_WINDOW_EXCLUSIVITY}`),
  content_indexes: z.never().optional().describe(`Only valid for content-index selection. ${CONTENT_INDEX_EXCLUSIVITY}`),
  evidence_class: z.never().optional().describe(`Only valid for evidence-class selection. ${EVIDENCE_CLASS_EXCLUSIVITY}`),
});

/**
 * Searched-view window (WI-6554700010008917): read lines of the SAME view a query searched, so a
 * hit's `line` can be read in context. Raw offset/limit address the spill file's physical lines,
 * a different coordinate space for a one-line JSON body.
 */
const viewWindowArgs = z.object({
  ...readPathArgs,
  ...notQuery,
  view_lines: z
    .object({
      offset: z.number().int().positive().describe('1-based line of the searched view (a query match.line).'),
      limit: z.number().int().positive().max(VIEW_MAX_LIMIT).optional().describe(`Lines to read (default ${VIEW_DEFAULT_LIMIT}).`),
    })
    .describe('Read lines of the view a query searches (pretty JSON, multi-line strings expanded); use after query. Alone only.'),
  offset: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  limit: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  tail: z.never().optional().describe(`Only valid for line windows. ${LINE_WINDOW_EXCLUSIVITY}`),
  raw: z.never().optional().describe('Not valid for view_lines.'),
  byte_offset: z.never().optional().describe(`Only valid for byte windows. ${BYTE_WINDOW_EXCLUSIVITY}`),
  byte_limit: z.never().optional().describe(`Only valid for byte windows. ${BYTE_WINDOW_EXCLUSIVITY}`),
  content_indexes: z.never().optional().describe(`Only valid for content-index selection. ${CONTENT_INDEX_EXCLUSIVITY}`),
  evidence_class: z.never().optional().describe(`Only valid for evidence-class selection. ${EVIDENCE_CLASS_EXCLUSIVITY}`),
});

const readArgs = z.union([lineWindowArgs, byteWindowArgs, contentIndexArgs, evidenceClassArgs, queryArgs, viewWindowArgs]);

/**
 * The handler has two intentional response paths: human-readable MCP text and a
 * code-mode structured twin. The twin is heterogeneous because the same tool
 * also pages bytes and selects content/evidence from scratch references. Keep
 * every branch's stable root field optional and leave room for branch-specific
 * diagnostics; a closed schema would reject a truthful mode-specific result.
 * `body` is deliberately the code-mode text field (not `content`/`text`, which
 * are reserved for the MCP envelope and caused the original facade mismatch).
 */
const capabilityReadResultSchema = z
  .object({
    ok: z.boolean(),
    file_path: z.string().optional(),
    body: z.string().optional(),
    total_lines: z.number().int().nonnegative().optional(),
    start_line: z.number().int().positive().nullable().optional(),
    end_line: z.number().int().positive().nullable().optional(),
    has_more: z.boolean().optional(),
    encoding: z.string().optional(),
    byte_offset: z.number().int().nonnegative().optional(),
    byte_length: z.number().int().nonnegative().optional(),
    total_bytes: z.number().int().nonnegative().optional(),
    data: z.string().optional(),
    sha256: z.string().optional(),
    fallback_uri: z.string().optional(),
    eof: z.boolean().optional(),
    next_cursor: z
      .object({
        tool: z.string(),
        args: z.record(z.string(), z.unknown()),
      })
      .passthrough()
      .nullable()
      .optional(),
    reference: z.record(z.string(), z.unknown()).optional(),
    evidence_class: z.string().optional(),
    evidence: z.array(z.unknown()).optional(),
    selected_indexes: z.array(z.number().int().nonnegative()).optional(),
    total_content_items: z.number().int().nonnegative().optional(),
    content: z.array(z.unknown()).optional(),
    isError: z.boolean().optional(),
    reason: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

type LineReadArgs = {
  offset?: number;
  limit?: number;
  tail?: number;
  raw?: boolean;
};

type ByteReadArgs = LineReadArgs & {
  byte_offset?: number;
  byte_limit?: number;
};

type ReadContext = {
  codeMode?: boolean;
  transport?: string;
  requestedStructured?: boolean;
  projectDir?: string;
  phases?: PhaseTracker;
  uiClientId?: string | null;
  isSuperuser?: boolean;
  isPowerUser?: boolean;
  workspaceId?: string | null;
  userId?: string | null;
  principal?: { kind?: string; slug: string; workspaceId: string } | null;
  harnessSlug?: string | null;
  sigVerifiedSpawn?: boolean;
  spawnId?: string | null;
};

type SelectedLine = { line: string; index: number };

type LargeLineWindow = {
  slice: SelectedLine[];
  start: number;
  totalLines: number;
  endedWithNewline: boolean;
};

/**
 * Large logs must not be loaded into one Buffer just to answer a bounded read.
 * Keep only the requested line window while counting the source lines needed by
 * the existing numbered/header/footer response contract.
 */
async function readLargeLineWindow(
  abs: string,
  args: LineReadArgs,
  credentialBearingConfig: boolean,
): Promise<LargeLineWindow> {
  const limit = args.limit ?? DEFAULT_LIMIT;
  const tailLimit = args.tail === undefined ? undefined : Math.min(args.tail, limit);
  const offset = args.offset && args.offset > 0 ? args.offset - 1 : 0;
  const selected: SelectedLine[] = [];
  let pending = '';
  let totalLines = 0;
  let sawBytes = false;

  const consumeLine = (sourceLine: string) => {
    const line = credentialBearingConfig ? redactSensitiveText(sourceLine) : sourceLine;
    const index = totalLines;
    totalLines += 1;
    if (tailLimit !== undefined) {
      selected.push({ line, index });
      if (selected.length > tailLimit) selected.shift();
      return;
    }
    if (index >= offset && index < offset + limit) selected.push({ line, index });
  };

  const decoder = new StringDecoder('utf8');
  const stream = createReadStream(abs);
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sawBytes = sawBytes || buffer.length > 0;
      const parts = (pending + decoder.write(buffer)).split('\n');
      pending = parts.pop() ?? '';
      for (const line of parts) consumeLine(line);
    }
    pending += decoder.end();
  } finally {
    stream.destroy();
  }

  if (pending.length > 0) consumeLine(pending);

  const start = tailLimit === undefined
    ? offset
    : Math.max(0, totalLines - tailLimit);
  return {
    slice: selected,
    start,
    totalLines,
    endedWithNewline: sawBytes && pending.length === 0,
  };
}

/** Read one exact byte page without materializing the rest of a large file. */
async function readBytePage(abs: string, offset: number, limit: number): Promise<Buffer> {
  const fd = await open(abs, 'r');
  try {
    const page = Buffer.alloc(limit);
    let bytesRead = 0;
    while (bytesRead < limit) {
      const { bytesRead: count } = await fd.read(page, bytesRead, limit - bytesRead, offset + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    return page.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}

/**
 * A large scratch reference cannot be authorized by loading its whole payload.
 * Detect its magic prefix and fail closed before a streaming line read could
 * expose an owner/workspace-scoped payload as ordinary text.
 */
async function startsWithScratchReference(abs: string): Promise<boolean> {
  const magic = Buffer.from(SCRATCH_REFERENCE_MAGIC, 'utf8');
  try {
    const fd = await open(abs, 'r');
    try {
      const prefix = Buffer.alloc(magic.length);
      const { bytesRead } = await fd.read(prefix, 0, magic.length, 0);
      return bytesRead === magic.length && prefix.equals(magic);
    } finally {
      await fd.close();
    }
  } catch {
    return false;
  }
}

async function renderByteWindow(
  abs: string,
  args: ByteReadArgs,
  totalBytes: number,
  readPage: (offset: number, limit: number) => Buffer | Promise<Buffer>,
  reference?: ScratchReferenceManifest,
) {
  const effectiveLimit = doorSafePageBytes(abs, args.byte_limit!, reference);
  // A caller asking for a deliberately small page (for example, 256 bytes
  // from a result-door cursor) has already accepted the extra hops. Do not
  // reject it merely because the absolute scratch path leaves less than the
  // normal efficiency floor. Keep refusing a normal-sized request whose fitted
  // page would be sub-floor, and always refuse when no byte fits.
  const noPositivePageFits = effectiveLimit <= 0;
  const normalRequestWouldBeSubFloor = args.byte_limit! >= MIN_PAGE_BYTES && effectiveLimit < MIN_PAGE_BYTES;
  if (noPositivePageFits || normalRequestWouldBeSubFloor) {
    return err(
      'path_too_long_for_byte_window',
      `${abs} is too long a path to page by bytes: its envelope leaves room for only ` +
      `${Math.max(0, effectiveLimit)} bytes per response. Read it by lines (offset/limit/tail), ` +
      `or reach it via a shorter path.`,
    );
  }
  const start = Math.min(args.byte_offset!, totalBytes);
  const page = await readPage(start, effectiveLimit);
  const nextOffset = start + page.length;
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        ok: true,
        file_path: abs,
        encoding: 'base64',
        byte_offset: start,
        byte_length: page.length,
        total_bytes: totalBytes,
        ...(reference ? { reference } : {}),
        eof: nextOffset >= totalBytes,
        data: page.toString('base64'),
        next_cursor: nextOffset < totalBytes
          ? { tool: 'capability:read', args: { file_path: abs, byte_offset: nextOffset, byte_limit: effectiveLimit } }
          : null,
      }),
    }],
  };
}

function renderLargeLineWindow(
  abs: string,
  args: LineReadArgs,
  ctx: ReadContext,
  window: LargeLineWindow,
) {
  const { slice, start, totalLines } = window;
  if (args.raw) {
    const end = start + slice.length;
    const rawWindow = {
      total_lines: totalLines,
      start_line: slice.length === 0 ? null : start + 1,
      end_line: slice.length === 0 ? null : end,
      has_more: end < totalLines,
    };
    if (slice.length === 0) {
      return {
        content: [{ type: 'text' as const, text: '' }],
        ...(ctx.codeMode || (ctx.transport === 'mcp' && ctx.requestedStructured)
          ? { structuredContent: { ok: true, file_path: abs, body: '', ...rawWindow } }
          : {}),
      };
    }
    const rawBody = slice.map(({ line }) => line).join('\n') +
      (end < totalLines || (end === totalLines && window.endedWithNewline) ? '\n' : '');
    return {
      content: [{ type: 'text' as const, text: rawBody }],
      ...(ctx.codeMode || (ctx.transport === 'mcp' && ctx.requestedStructured)
        ? { structuredContent: { ok: true, file_path: abs, body: rawBody, ...rawWindow } }
        : {}),
    };
  }

  const numbered = slice
    .map(({ line, index }) => {
      const truncated = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]` : line;
      return `${String(index + 1).padStart(6)}\t${truncated}`;
    })
    .join('\n');
  const more = start + slice.length < totalLines;
  const footer = more
    ? `\n\n… [${totalLines - (start + slice.length)} more lines — re-read with offset=${start + slice.length + 1}]`
    : '';
  const head = `${abs} (${totalLines} lines${start > 0 || more ? `, showing ${start + 1}–${start + slice.length}` : ''})\n`;
  return {
    content: [{ type: 'text' as const, text: slice.length === 0 ? `${head}(empty)` : head + numbered + footer }],
    ...(ctx.codeMode || (ctx.transport === 'mcp' && ctx.requestedStructured)
      ? {
          structuredContent: {
            ok: true,
            file_path: abs,
            body: slice.map(({ line }) => line).join('\n'),
            total_lines: totalLines,
            start_line: slice.length === 0 ? null : start + 1,
            end_line: slice.length === 0 ? null : start + slice.length,
            has_more: more,
          },
        }
      : {}),
  };
}

/**
 * The handler implementation is kept separate from the `defineTool` wrapper.
 * Fresh-process recovery probes can import this module without loading the
 * agent-mcp catalog/bootstrap graph (which otherwise consumes most of the
 * probe's spawnSync budget before the handler is exercised).
 */
export const capabilityReadDefinition = {
  name: 'capability:read',
  description:
    'Read a file with line-numbered text windows, exact undecorated text windows (raw:true), or exact resumable byte pages. offset/limit window lines; tail:N reads the last N lines. byte_offset+byte_limit returns base64 bytes with a next cursor, including for a single very long line. query searches a saved result (spill) for lines holding every term; view_lines reads around a hit. Credential-bearing config/auth files are redacted for ordinary line reads and refuse exact/raw/byte/structured modes. Path is absolute, ~/-relative, relative to the project dir, a papercusp://scratch URI, or a short-lived in-memory scratch fallback URI.',
  guidance: {
    when: 'Read a source/text file before editing it, or inspect content. Use offset+limit for line pages, tail:N for a log tail, raw:true when passing text to capability:write/edit, and byte_offset+byte_limit when exact resumable bytes matter or the file may be one long line. For a truncated tool result (spill), search it with query, then read around a hit with view_lines.',
    notWhen: 'To run a command, use capability:bash. To search across files, use capability:bash with grep/rg.',
    chaining: 'capability:read → capability:edit (exact string replace) or capability:write (overwrite). Spill: query → view_lines (follow read_around).',
    returns:
      'Across line/raw, byte-page, content/evidence-selection, and error branches: { ok, file_path?, body?, total_lines?, start_line?, end_line?, has_more?, encoding?, byte_offset?, byte_length?, total_bytes?, data?, eof?, next_cursor?, reference?, evidence_class?, evidence?, selected_indexes?, total_content_items?, content?, isError?, reason?, message? }. In code mode, line/raw reads put undecorated text in `body` (not MCP envelope `content`/`text`); byte pages put exact base64 in `data` and expose `next_cursor`. query returns { matches[{line,text}], matchCount, coverage, read_around, next_cursor, note? }; view_lines returns numbered text or view_window_out_of_range.',
    seeAlso: capabilityReadSeeAlso,
  },
  capability: 'capability:fs-read',
  requirePrincipal: false as const,
  args: readArgs,
  result: capabilityReadResultSchema,
  async handler(args: z.infer<typeof readArgs>, ctx: ReadContext) {
    const filePath = args.file_path ?? args.uri;
    if (!filePath) return err('missing_path', 'file_path or uri must be supplied.');

    // Result-door scratch references get a bounded set of nested timings so a slow
    // raw line read can be localized without adding phases to ordinary file reads.
    const scratchPathPattern = /(?:^|[\\/])\.papercusp[\\/]scratch[\\/]/;
    let scratchReferencePath = scratchPathPattern.test(filePath);
    if (!scratchReferencePath && filePath.startsWith(`${SCRATCH_SCHEME}/`)) {
      try {
        safeScratchFilesystemPath(filePath);
        scratchReferencePath = true;
      } catch {
        // Keep the normal path resolver responsible for returning the URI error.
      }
    }
    const trackScratchAsync = <T>(phase: string, work: () => Promise<T>): Promise<T> => {
      if (!scratchReferencePath || !ctx.phases) return work();
      return ctx.phases.track(`capability:read:scratch:${phase}`, work);
    };
    const trackScratchSync = <T>(phase: string, work: () => T): T => {
      if (!scratchReferencePath || !ctx.phases) return work();
      const startedAt = Date.now();
      try {
        return work();
      } finally {
        ctx.phases.addCompleted(`capability:read:scratch:${phase}`, startedAt, Date.now() - startedAt);
      }
    };

    if (isDurableScratchReferenceUri(filePath)) {
      if (args.byte_offset === undefined || args.byte_limit === undefined) {
        return err(
          'durable_reference_requires_byte_window',
          'Durable scratch references support exact byte pages only; supply byte_offset and byte_limit from the cursor.',
        );
      }
      if (
        args.offset !== undefined || args.limit !== undefined || args.tail !== undefined ||
        args.raw === true || args.content_indexes !== undefined || args.evidence_class !== undefined ||
        args.query !== undefined || args.view_lines !== undefined
      ) {
        return err('mixed_window_modes', 'Durable scratch reference byte pages cannot be combined with other read modes.');
      }
      let ownerId: string | null = null;
      try {
        const identityCtx = ctx as ResolveIdentityCtx;
        ownerId = resolveAgentIdentity(
          identityCtx.sigVerifiedSpawn &&
          !identityCtx.isSuperuser &&
          !identityCtx.isPowerUser &&
          identityCtx.uiClientId
            ? { ...identityCtx, principal: undefined }
            : identityCtx,
        ).ownerId;
      } catch {
        ownerId = null;
      }
      try {
        const reference = await readDurableScratchReference(filePath, {
          workspaceId: ctx.workspaceId ?? ctx.principal?.workspaceId ?? null,
          ownerId,
        });
        return renderByteWindow(
          filePath,
          args as ByteReadArgs,
          reference.manifest.byteCount,
          (offset, limit) => reference.payload.subarray(offset, offset + limit),
          reference.manifest,
        );
      } catch (e: unknown) {
        if (e instanceof ScratchReferenceError) return err(e.code, e.message);
        return err('read_failed', e instanceof Error ? e.message : String(e));
      }
    }

    if (isVolatileScratchReferenceUri(filePath)) {
      if (args.byte_offset === undefined || args.byte_limit === undefined) {
        return err(
          'volatile_reference_requires_byte_window',
          'In-memory scratch fallbacks support exact byte pages only; supply byte_offset and byte_limit from the cursor.',
        );
      }
      if (
        args.offset !== undefined || args.limit !== undefined || args.tail !== undefined ||
        args.raw === true || args.content_indexes !== undefined || args.evidence_class !== undefined ||
        args.query !== undefined || args.view_lines !== undefined
      ) {
        return err('mixed_window_modes', 'In-memory scratch fallback byte pages cannot be combined with other read modes.');
      }
      let ownerId: string | null = null;
      try {
        // Use the same signed-spawn identity rule as filesystem scratch references.
        const identityCtx = ctx as ResolveIdentityCtx;
        ownerId = resolveAgentIdentity(
          identityCtx.sigVerifiedSpawn &&
          !identityCtx.isSuperuser &&
          !identityCtx.isPowerUser &&
          identityCtx.uiClientId
            ? { ...identityCtx, principal: undefined }
            : identityCtx,
        ).ownerId;
      } catch {
        ownerId = null;
      }
      try {
        const fallback = readVolatileScratchReference(filePath, {
          workspaceId: ctx.workspaceId ?? ctx.principal?.workspaceId ?? null,
          ownerId,
        });
        return renderByteWindow(
          filePath,
          args as ByteReadArgs,
          fallback.manifest.byteCount,
          (offset, limit) => fallback.payload.subarray(offset, offset + limit),
          fallback.manifest,
        );
      } catch (e: unknown) {
        if (e instanceof ScratchReferenceError) return err(e.code, e.message);
        return err('invalid_reference', e instanceof Error ? e.message : String(e));
      }
    }


    let abs: string;
    try {
      const baseDir = selectCapabilityReadBaseDir(filePath, resolveCapabilityBaseDir(ctx));
      abs = resolveReadPath(filePath, baseDir);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return err('invalid_path', msg);
    }

    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await trackScratchAsync('stat', () => stat(abs));
      if (fileStat.isDirectory()) return err('is_a_directory', `${abs} is a directory. List it with capability:list.`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if ((e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        // A missing result-door spill is usually a cursor retyped by hand; point
        // the caller at the one real spill instead of a bare ENOENT (R-8, D-008).
        const recovered = await trackScratchAsync('mistyped-path-recovery', async () =>
          (await findMistypedScratchSpill(filePath)) ?? (abs !== filePath ? await findMistypedScratchSpill(abs) : null));
        if (recovered) return mistypedScratchPathErr(args, filePath, recovered);
      }
      return err('read_failed', msg);
    }

    const credentialBearingConfig = isCredentialBearingConfigPath(abs);
    const exactReadRequested =
      args.raw === true ||
      args.byte_offset !== undefined ||
      args.byte_limit !== undefined ||
      args.content_indexes !== undefined ||
      args.evidence_class !== undefined;
    if (credentialBearingConfig && exactReadRequested) {
      return err(
        'sensitive_file',
        'exact, raw, byte, and structured reads are refused for credential-bearing config files; use an ordinary line read, which redacts secret values.',
      );
    }

    const byteMode = args.byte_offset !== undefined || args.byte_limit !== undefined;
    const boundedLineRead = args.offset !== undefined || args.limit !== undefined || args.tail !== undefined;
    if (fileStat.size > MAX_FILE_BYTES) {
      if (await trackScratchAsync('large-reference-check', () => startsWithScratchReference(abs))) {
        return err(
          'too_large',
          `${abs} is a large scratch reference; use its emitted reference cursor instead of reading the container as a plain file.`,
        );
      }
      try {
        if (byteMode) {
          if (args.byte_offset === undefined || args.byte_limit === undefined) {
            return err('invalid_byte_window', 'byte_offset and byte_limit must be supplied together.');
          }
          if (args.offset !== undefined || args.limit !== undefined || args.tail !== undefined) {
            return err('mixed_window_modes', 'byte_offset/byte_limit cannot be combined with offset/limit/tail.');
          }
          if (args.raw) {
            return err('mixed_window_modes', 'raw text windows cannot be combined with byte_offset/byte_limit; byte windows already return exact bytes.');
          }
          return await renderByteWindow(
            abs,
            args as ByteReadArgs,
            fileStat.size,
            (offset, limit) => readBytePage(abs, offset, limit),
          );
        }
        if (boundedLineRead) {
          const largeLineRead = await trackScratchAsync(
            'large-line-read',
            () => readLargeLineWindow(abs, args as LineReadArgs, credentialBearingConfig),
          );
          return trackScratchSync('large-line-render', () => renderLargeLineWindow(
            abs,
            args as LineReadArgs,
            ctx as ReadContext,
            largeLineRead,
          ));
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return err('read_failed', msg);
      }
      return err('too_large', `${abs} is ${fileStat.size} bytes (> ${MAX_FILE_BYTES}). Read a bounded slice with capability:read (offset/limit/tail) or capability:bash.`);
    }

    let bytes: Buffer;
    try {
      bytes = await trackScratchAsync('file-read', () => readFile(abs));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return err('read_failed', msg);
    }

    let reference: ScratchReferenceManifest | undefined;
    try {
      const parsed = trackScratchSync('scratch-reference-parse', () => parseScratchReference(bytes));
      if (parsed) {
        reference = parsed.manifest;
        let ownerId: string | null = null;
        if (reference.audience === 'owner') {
          try {
            // The result door writes signed role-session spills under the
            // HMAC-verified client id. Tool dispatch can subsequently install
            // a synthesized role principal (system:judge, etc.); resolving
            // that principal here would name a different owner and reject the
            // creator's own spill. Only a verified signed spawn may bypass
            // the synthesized principal, never an unsigned client id.
            const identityCtx = ctx as ResolveIdentityCtx;
            ownerId = resolveAgentIdentity(
              identityCtx.sigVerifiedSpawn &&
              !identityCtx.isSuperuser &&
              !identityCtx.isPowerUser &&
              identityCtx.uiClientId
                ? { ...identityCtx, principal: undefined }
                : identityCtx,
            ).ownerId;
          } catch {
            ownerId = null;
          }
        }
        trackScratchSync('scratch-reference-authorize', () => authorizeScratchReference(reference!, {
          workspaceId: ctx.workspaceId ?? ctx.principal?.workspaceId ?? null,
          ownerId,
        }));
        bytes = parsed.payload;
      }
    } catch (e: unknown) {
      if (e instanceof ScratchReferenceError) {
        return err(e.code, e.message);
      }
      return err('invalid_reference', e instanceof Error ? e.message : String(e));
    }

    if (args.view_lines) {
      const v = args as z.infer<typeof viewWindowArgs>;
      if (typeof args.query === 'string' || args.content_indexes || args.evidence_class || args.byte_offset !== undefined || args.byte_limit !== undefined || args.offset !== undefined || args.limit !== undefined || args.tail !== undefined || args.raw !== undefined) {
        return err('mixed_window_modes', 'view_lines cannot be combined with query, line, byte, content or evidence selection.');
      }
      const r = readSavedResultLines(bytes, {
        offset: v.view_lines.offset,
        limit: v.view_lines.limit,
        bodyOffset: reference?.bodyOffsetInPayload,
      });
      if (!r.ok) return err(r.reason, r.message);
      const cursorKey = args.uri ? 'uri' : 'file_path';
      const cursorPath = args.uri ?? args.file_path ?? abs;
      const footer = r.nextOffset === null
        ? ''
        : `\n… more: capability:read { ${cursorKey}, view_lines: { offset: ${r.nextOffset}, limit: ${v.view_lines.limit ?? VIEW_DEFAULT_LIMIT} } }`;
      return markScratchReferenceRead({ content: [{ type: 'text' as const, text:
        `${cursorPath} — searched ${r.view} view, lines ${r.startLine}–${r.endLine} of ${r.totalLines}` +
        `${r.clippedLines > 0 ? ` (${r.clippedLines} long line(s) clipped)` : ''}\n${r.lines.join('\n')}${footer}`,
      }] }, reference);
    }

    if (typeof args.query === 'string') {
      const q = args as z.infer<typeof queryArgs>;
      if (args.content_indexes || args.evidence_class || args.byte_offset !== undefined || args.byte_limit !== undefined || args.offset !== undefined || args.limit !== undefined || args.tail !== undefined || args.raw !== undefined) {
        return err('mixed_window_modes', 'query cannot be combined with line, byte, content or evidence selection.');
      }
      const result = querySavedResult(bytes, {
        query: q.query,
        context: q.query_context,
        maxMatches: q.query_max_matches,
        fromLine: q.query_from_line,
        bodyOffset: reference?.bodyOffsetInPayload,
      });
      const cursorPath = args.uri ?? args.file_path ?? abs;
      return markScratchReferenceRead({ content: [{ type: 'text' as const, text: JSON.stringify({
        ok: true,
        file_path: abs,
        query: q.query,
        ...result,
        ...(reference ? { reference: { sha256: reference.sha256, expiresAt: reference.expiresAt, byteCount: reference.byteCount } } : {}),
        next_cursor: result.nextFromLine === null ? null : {
          tool: 'capability:read',
          args: { [args.uri ? 'uri' : 'file_path']: cursorPath, query: q.query, query_from_line: result.nextFromLine },
        },
        read_around: result.matches.length === 0 ? undefined : {
          tool: 'capability:read',
          args: { [args.uri ? 'uri' : 'file_path']: cursorPath, view_lines: { offset: Math.max(1, result.matches[0].line - 3), limit: 40 } },
        },
        note: result.matchCount === 0
          ? `No line in the searched ${result.view} view (${result.coverage.searchedLines} lines from line ${result.coverage.fromLine}, ${result.coverage.payloadBytes} bytes) contains every term. That is a complete negative for THIS retained body${result.coverage.upstreamPartialMarkers > 0 ? `, but the body itself carries ${result.coverage.upstreamPartialMarkers} upstream truncation marker(s) — the original tool output was partial` : ''}.`
          : undefined,
      }) }] }, reference);
    }

    if (args.evidence_class) {
      if (args.content_indexes || args.byte_offset !== undefined || args.byte_limit !== undefined || args.offset !== undefined || args.limit !== undefined || args.tail !== undefined) {
        return err('mixed_window_modes', 'evidence_class cannot be combined with content, line, or byte windows.');
      }
      if (!reference) return err('not_a_reference', 'evidence_class requires a stable scratch reference.');
      const selectors = (reference.evidence ?? []).filter((entry) => entry.evidenceClass === args.evidence_class);
      if (selectors.length === 0) return err('evidence_class_not_found', `scratch reference has no ${args.evidence_class} evidence.`);
      let selectionBytes = bytes;
      if (reference.bodyOffsetInPayload !== undefined) {
        const bodyOffset = reference.bodyOffsetInPayload;
        if (!Number.isSafeInteger(bodyOffset) || bodyOffset < 0 || bodyOffset >= bytes.length) {
          return err('evidence_not_selectable', 'scratch reference has an invalid declared JSON body offset.');
        }
        selectionBytes = bytes.subarray(bodyOffset);
      }
      let decoded: unknown;
      try { decoded = JSON.parse(selectionBytes.toString('utf8')); }
      catch {
        return err(
          'evidence_not_selectable',
          'scratch reference JSON body is not valid JSON. Use line or byte windows for text or Markdown spills.',
        );
      }
      const row = decoded && typeof decoded === 'object' ? decoded as Record<string, unknown> : null;
      const content = row?.content;
      const isMcpContentEnvelope = Array.isArray(content) && content.some((item) =>
        item && typeof item === 'object' && (item as { type?: unknown }).type === 'text' &&
        typeof (item as { text?: unknown }).text === 'string');
      const resolvePointer = (value: unknown, pointer: string): unknown => pointer.split('/').slice(1).reduce<unknown>((cursor, segment) => {
        if (cursor === null || typeof cursor !== 'object') return undefined;
        return (cursor as Record<string, unknown>)[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
      }, value);
      let evidence: Array<{ contentIndex: number; jsonPointer: string; value: unknown }>;
      if (isMcpContentEnvelope) {
        evidence = selectors.flatMap((selector) => {
          const item = content[selector.contentIndex] as { text?: unknown } | undefined;
          if (!item || typeof item.text !== 'string') return [];
          let parsed: unknown;
          try { parsed = JSON.parse(item.text); } catch { return []; }
          return selector.jsonPointers.map((jsonPointer) => ({
            contentIndex: selector.contentIndex,
            jsonPointer,
            value: resolvePointer(parsed, jsonPointer),
          }));
        });
      } else if (reference.bodyOffsetInPayload !== undefined) {
        // Ordinary JSON spills store the selected JSON body directly after the
        // human-readable prefix. Their selectors still refer to original MCP
        // content indexes, so accept this shape only when all indexed evidence
        // came from one text block; otherwise the raw body cannot disambiguate it.
        const evidenceIndexes = new Set((reference.evidence ?? []).map((entry) => entry.contentIndex));
        if (evidenceIndexes.size !== 1 || !selectors.every((entry) => entry.contentIndex === [...evidenceIndexes][0])) {
          return err('evidence_not_selectable', 'raw JSON spill evidence spans multiple MCP content items.');
        }
        const contentIndex = [...evidenceIndexes][0];
        if (!reference.content.some((entry) => entry.index === contentIndex && entry.type === 'text')) {
          return err('evidence_not_selectable', 'raw JSON spill selector does not point to a text content item.');
        }
        evidence = selectors.flatMap((selector) => selector.jsonPointers.map((jsonPointer) => ({
          contentIndex: selector.contentIndex,
          jsonPointer,
          value: resolvePointer(decoded, jsonPointer),
        })));
        if (evidence.length === 0 || evidence.some((entry) => entry.value === undefined)) {
          return err('evidence_not_selectable', 'raw JSON spill does not contain every indexed evidence value.');
        }
      } else {
        return err('evidence_not_selectable', 'scratch reference payload has no MCP content array or declared JSON body.');
      }
      return markScratchReferenceRead({ content: [{ type: 'text' as const, text: JSON.stringify({
        ok: true, file_path: abs, reference, evidence_class: args.evidence_class, evidence,
      }) }] }, reference);
    }

    if (args.content_indexes) {
      if (args.byte_offset !== undefined || args.byte_limit !== undefined || args.offset !== undefined || args.limit !== undefined || args.tail !== undefined) {
        return err('mixed_window_modes', 'content_indexes cannot be combined with line or byte windows.');
      }
      if (!reference) return err('not_a_reference', 'content_indexes requires a stable scratch reference.');
      let selectionBytes = bytes;
      if (reference.bodyOffsetInPayload !== undefined) {
        const bodyOffset = reference.bodyOffsetInPayload;
        if (!Number.isSafeInteger(bodyOffset) || bodyOffset < 0 || bodyOffset >= bytes.length) {
          return err('content_not_selectable', 'scratch reference has an invalid declared JSON body offset.');
        }
        selectionBytes = bytes.subarray(bodyOffset);
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(selectionBytes.toString('utf8'));
      } catch {
        decoded = undefined;
      }
      const row = decoded && typeof decoded === 'object' ? decoded as Record<string, unknown> : null;
      const envelopeContent = row?.content;
      let content: unknown[];
      if (Array.isArray(envelopeContent)) {
        content = envelopeContent;
      } else {
        // Text result-door spills retain the selected text body plus a manifest
        // describing the original MCP content items, rather than serializing a
        // second `{content:[...]}` envelope. Reconstruct that contract here so
        // the advertised content_indexes mode remains usable for those spills.
        const metadata = reference.content ?? [];
        if (metadata.length === 0 || metadata.some((entry) => entry.type !== 'text')) {
          return err('content_not_selectable', 'scratch reference payload has no MCP content array.');
        }
        const bodyText = selectionBytes.toString('utf8');
        let advisoryTexts: string[] = [];
        if (reference.bodyOffsetInPayload !== undefined) {
          const prefix = bytes.subarray(0, reference.bodyOffsetInPayload).toString('utf8');
          const advisoryLine = prefix.match(/^# advisory-text-items-json: (.+)$/m)?.[1];
          if (advisoryLine) {
            try {
              const parsedAdvisories = JSON.parse(advisoryLine) as unknown;
              if (Array.isArray(parsedAdvisories) && parsedAdvisories.every((item) => typeof item === 'string')) {
                advisoryTexts = [...parsedAdvisories];
              }
            } catch {
              // A malformed advisory prefix does not make the body unreadable;
              // the selected JSON/text item remains available below.
            }
          }
        }
        const bodyBytes = Buffer.byteLength(bodyText, 'utf8');
        const bodyIndex = metadata.findIndex((entry) => entry.byteCount === bodyBytes);
        const selectedBodyIndex = bodyIndex >= 0 ? bodyIndex : 0;
        content = metadata.map((entry, index) => ({
          type: entry.type,
          ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
          text: index === selectedBodyIndex ? bodyText : advisoryTexts.shift() ?? '',
        }));
      }
      const unique = [...new Set(args.content_indexes)];
      const invalid = unique.filter((index) => index >= content.length);
      if (invalid.length > 0) {
        return err('content_index_out_of_range', `content index(es) ${invalid.join(', ')} exceed ${content.length - 1}.`);
      }
      return markScratchReferenceRead({
        content: [{ type: 'text' as const, text: JSON.stringify({
          ok: true,
          file_path: abs,
          reference,
          selected_indexes: unique,
          total_content_items: content.length,
          content: unique.map((index) => content[index]),
          ...(row?.isError !== undefined ? { isError: row.isError } : {}),
        }) }],
      }, reference);
    }

    if (byteMode) {
      if (args.byte_offset === undefined || args.byte_limit === undefined) {
        return err('invalid_byte_window', 'byte_offset and byte_limit must be supplied together.');
      }
      if (args.offset !== undefined || args.limit !== undefined || args.tail !== undefined) {
        return err('mixed_window_modes', 'byte_offset/byte_limit cannot be combined with offset/limit/tail.');
      }
      if (args.raw) {
        return err('mixed_window_modes', 'raw text windows cannot be combined with byte_offset/byte_limit; byte windows already return exact bytes.');
      }
      return markScratchReferenceRead(await renderByteWindow(
        abs,
        args as ByteReadArgs,
        bytes.length,
        (offset, limit) => bytes.subarray(offset, Math.min(bytes.length, offset + limit)),
        reference,
      ), reference);
    }

    const decodedLines = trackScratchSync('text-decode-and-line-split', () => {
      const sourceText = bytes.toString('utf8');
      // Redact the complete source before selecting a line window. A secret near
      // a window boundary must not survive merely because the caller requested a
      // narrow diagnostic slice.
      const text = credentialBearingConfig ? redactSensitiveText(sourceText) : sourceText;
      const allLines = text.split('\n');
      // A trailing newline yields a final empty element; drop it so line counts match the file.
      if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();
      return { text, allLines };
    });
    const { text, allLines } = decodedLines;

    const selectedWindow = trackScratchSync('line-window-select', () => {
      const limit = args.limit ?? DEFAULT_LIMIT;
      // `tail` addresses the END of the file, which offset (anchored at line 1)
      // cannot reach without first knowing the line count. The 2026-07-26 bash
      // audit found this was the single largest un-substitutable file read:
      // 1,752 `tail -n N FILE` atoms across 63 sessions had no tool form at all.
      const start = args.tail
        ? Math.max(0, allLines.length - args.tail)
        : args.offset && args.offset > 0
          ? args.offset - 1
          : 0;
      const slice = allLines.slice(start, start + (args.tail ? Math.min(args.tail, limit) : limit));
      return { limit, start, slice };
    });
    const { limit, start, slice } = selectedWindow;

    if (args.raw) {
      const end = start + slice.length;
      const rawWindow = {
        total_lines: allLines.length,
        start_line: slice.length === 0 ? null : start + 1,
        end_line: slice.length === 0 ? null : end,
        has_more: end < allLines.length,
      };
      if (slice.length === 0) {
        return markScratchReferenceRead({
          content: [{ type: 'text' as const, text: '' }],
          // EI-22044192752243601: ordinary/raw text reads return a plain string
          // `text` body, not JSON — unwrapToolResult's JSON.parse throws on it and
          // hands a code:run script the raw STRING primitive. A primitive is not a
          // container, so run-script.ts's field-miss Proxy never wraps it either:
          // `.content` / `.text` property access on that string silently resolves
          // to `undefined`, with NO fieldMiss diagnostic and NO thrown error — the
          // exact silent-clobber shape this bug report is about. Attach the same
          // data as a real object for code-mode, same pattern as capability:bash.
          // `body` (never `content`/`text`) deliberately avoids run-script.ts's
          // ROOT_ENVELOPE_FIELDS — those two names are reserved to make a script's
          // envelope-shaped guess THROW a loud structured_result_shape error
          // instead of returning undefined; reusing either name here would let
          // that exact guess silently "succeed" against the wrong field again.
          ...(ctx.codeMode || (ctx.transport === 'mcp' && ctx.requestedStructured)
            ? { structuredContent: { ok: true, file_path: abs, body: '', ...rawWindow } }
            : {}),
        }, reference);
      }

      // Reconstruct the exact source span rather than joining a normalized
      // array. This preserves the source's trailing newline (or lack of one)
      // while still honoring offset/limit/tail line windows.
      const rawBody = trackScratchSync('raw-window-build', () => {
        const startOffset = allLines
          .slice(0, start)
          .reduce((offset, line) => offset + line.length + 1, 0);
        const selected = slice.join('\n');
        const endOffset = startOffset + selected.length;
        const hasSourceNewline = text[endOffset] === '\n';
        return text.slice(startOffset, endOffset + (hasSourceNewline ? 1 : 0));
      });
      if (reference && scratchLineWindowExceedsDoor(rawBody)) {
        return err(
          'scratch_line_window_too_large',
          'This scratch-reference line window is too large for one result. Use a smaller offset/limit/tail window, or byte_offset+byte_limit when a single line is too large.',
        );
      }
      return trackScratchSync('raw-window-result', () => markScratchReferenceRead({
        content: [{
          type: 'text' as const,
          text: rawBody,
        }],
        // EI-22044192752243601 — see the empty-slice branch above for why.
        ...(ctx.codeMode || (ctx.transport === 'mcp' && ctx.requestedStructured)
          ? { structuredContent: { ok: true, file_path: abs, body: rawBody, ...rawWindow } }
          : {}),
      }, reference));
    }

    if (reference && scratchLineWindowHasLongLine(slice)) {
      return err(
        'scratch_line_window_too_large',
        'This scratch-reference line window contains a long line that numbered output would truncate. ' +
        'Use a smaller offset/limit/tail window for adjacent lines, or byte_offset+byte_limit for exact bytes.',
      );
    }

    const numbered = slice
      .map((line, i) => {
        const n = start + i + 1;
        const truncated = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]` : line;
        return `${String(n).padStart(6)}\t${truncated}`;
      })
      .join('\n');

    const more = start + slice.length < allLines.length;
    const footer = more
      ? `\n\n… [${allLines.length - (start + slice.length)} more lines — re-read with offset=${start + slice.length + 1}]`
      : '';
    const head = `${abs} (${allLines.length} lines${start > 0 || more ? `, showing ${start + 1}–${start + slice.length}` : ''})\n`;
    const displayText = slice.length === 0 ? `${head}(empty)` : head + numbered + footer;
    if (reference && scratchLineWindowExceedsDoor(displayText)) {
      return err(
        'scratch_line_window_too_large',
        'This scratch-reference line window is too large for one result. Use a smaller offset/limit/tail window, or byte_offset+byte_limit when a single line is too large.',
      );
    }

    return markScratchReferenceRead({
      content: [{ type: 'text' as const, text: displayText }],
      // EI-22044192752243601: same silent-primitive-fallback bug as the raw branch
      // above — the ordinary cat -n view is human/model-readable text, not JSON, so
      // a code:run script reading `.content`/`.text` off it got `undefined` with no
      // diagnostic. `body` carries the UNDECORATED text (no line-number prefixes,
      // no header/footer) since that is what a script processing file content
      // wants, not the display formatting. Field names avoid `content`/`text`
      // (run-script.ts ROOT_ENVELOPE_FIELDS) for the same reason as the raw branch.
      ...(ctx.codeMode || (ctx.transport === 'mcp' && ctx.requestedStructured)
        ? {
            structuredContent: {
              ok: true,
              file_path: abs,
              body: slice.join('\n'),
              total_lines: allLines.length,
              start_line: slice.length === 0 ? null : start + 1,
              end_line: slice.length === 0 ? null : start + slice.length,
              has_more: more,
            },
          }
        : {}),
    }, reference);
  },
};

/**
 * Resolve a caller-supplied path to an absolute one.
 *
 * `~/…` must be expanded explicitly: it is a SHELL feature, so Node sees it as
 * a relative path and `resolve(baseDir, '~/x')` silently yields
 * `<projectDir>/~/x` — a file that does not exist, reported as a confusing
 * read_failed rather than as the home-relative read the caller meant. The
 * 2026-07-26 bash audit caught this against real commands (`cat ~/.papercusp/…`,
 * `head -40 ~/mac-verify-build-waiter.sh`).
 */
export function resolveReadPath(filePath: string, baseDir: string): string {
  if (filePath.startsWith(`${SCRATCH_SCHEME}/`)) return safeScratchFilesystemPath(filePath);
  if (filePath.startsWith('papercusp://')) {
    throw new Error(`unsupported URI scheme; expected ${SCRATCH_SCHEME}/…`);
  }
  if (filePath === '~') return homedir();
  if (filePath.startsWith('~/')) return resolve(homedir(), filePath.slice(2));
  return isAbsolute(filePath) ? filePath : resolve(baseDir, filePath);
}

type CapabilityReadRootSource = 'project-dir' | 'integration-root';

/**
 * Recover a project-relative read from a phantom harness root without weakening
 * the loud `read_failed` contract.
 *
 * The caller's project dir remains authoritative whenever the requested path
 * exists there. Only a path that is absent from that tree may use the explicitly
 * published canonical integration checkout, and only when the same relative path
 * exists there. Absolute, home-relative, and URI paths bypass this lattice because
 * their own addressing contract is already unambiguous.
 */
export function selectCapabilityReadBaseDir(
  filePath: string,
  preferredBaseDir: string,
  integrationRoot = resolveCapabilityIntegrationRoot(),
): string {
  if (!isProjectRelativeReadPath(filePath) || !integrationRoot) return preferredBaseDir;

  const selected = selectUnambiguousEvidenceRoot<CapabilityReadRootSource>({
    preferred: { root: preferredBaseDir, source: 'project-dir' },
    fallback: { root: integrationRoot, source: 'integration-root' },
    resolvesEvery: (root) => existsSync(resolve(root, filePath)),
  });
  return selected?.root ?? preferredBaseDir;
}

function isProjectRelativeReadPath(filePath: string): boolean {
  return (
    !isAbsolute(filePath) &&
    filePath !== '~' &&
    !filePath.startsWith('~/') &&
    !filePath.includes('://')
  );
}

function err(reason: string, message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason, message }) }],
    isError: true,
  };
}

/**
 * Refuse a retyped scratch cursor with the exact cursor it most likely meant.
 * The caller's other arguments are carried over unchanged, under the same path
 * key (`uri` or `file_path`) the caller used. The other file is NOT read here:
 * the caller re-issues the read, so it always sees which path it is reading.
 */
function mistypedScratchPathErr(
  args: Record<string, unknown>,
  requested: string,
  recovered: RecoveredScratchSpill,
) {
  const pathKey = args.uri !== undefined && args.file_path === undefined ? 'uri' : 'file_path';
  const target = pathKey === 'uri' ? recovered.uri : recovered.path;
  const { uri: _uri, file_path: _filePath, ...rest } = args;
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        ok: false,
        reason: 'scratch_path_mistyped',
        message:
          `${requested} does not exist, but a saved result with the same name exists at ${target}. ` +
          'The path was most likely retyped by hand (a changed character in the run id, workspace or root). ' +
          'Re-run did_you_mean, which carries your arguments with the exact path. Copy cursors from the result instead of retyping them.',
        did_you_mean: { tool: 'capability:read', args: { [pathKey]: target, ...rest } },
      }),
    }],
    isError: true,
  };
}

export default capabilityReadDefinition;
