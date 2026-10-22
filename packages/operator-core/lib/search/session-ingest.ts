/**
 * Session-transcript ingest — the episodic verbatim index feeder
 * (session-search-scope-2026-07-05 P-003 / D-003; compaction-context-loss
 * D-001 "index, don't summarize harder").
 *
 * ONE `harness_shared.session_turns` table fed by an ADAPTER REGISTRY:
 *   * `claude`      — Claude Code JSONL (~/.claude/projects/** and the psu
 *                     isolation dirs ~/.papercusp/session-claude/<owner>/projects/**)
 *   * `omp`         — OMP JSONL (~/.omp/agent/sessions/<munged-cwd>/*.jsonl)
 *   * `codex`       — Codex rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
 *   * `agent_chat`  — harness_shared.agent_chats_consolidated transcript JSONB
 *
 * Design invariants:
 *   * INCREMENTAL: per-file (source_kind, file_path) → byte_offset bookkeeping
 *     in session_ingest_state; JSONL is append-only so tailing is cheap. Only
 *     COMPLETE lines are consumed (a partially-flushed last line waits for the
 *     next tick).
 *   * BOUNDED per tick: file/turn/byte caps below — the corpus is ~23k files /
 *     ~10 GB on a mature box, so a tick NEVER tries to swallow history in one
 *     go; the tailer converges across ticks (newest-mtime first, so recent
 *     sessions — the ones agents actually search — index first).
 *   * TEXT TURNS ONLY (v1): user + assistant text parts. Tool results /
 *     thinking blocks are bulk noise for recall (tool calls already live in
 *     tool_invocations); the full source line remains on disk for
 *     sessions:read.
 *   * TRUNCATED + REDACTED at ingest: 8k chars/turn; common secret shapes
 *     scrubbed. The index is for recall, not archival — the PERMANENT copy is
 *     `harness_shared.session_archives` (session-db-archive-retire-dirs
 *     -2026-07-10 D-001): a LIVE session's JSONL is on disk; an ENDED
 *     session's files are archived-then-deleted (exit hook + hourly
 *     reconciler), and sessions:read falls through to the archive
 *     (session-archive-read.ts) with this same cap+redaction re-applied.
 *   * COMPACTION-SAFE by construction: compaction never deletes the JSONL
 *     (archive-at-death only deletes AFTER a sha-verified archive of the
 *     whole file), so the index can never lose pre-compaction turns;
 *     `ingestFileNow` gives the read-time freshness guarantee (self
 *     live-tail) client-neutrally (compaction-context-loss D-002 — hooks are
 *     optimizations, not dependencies). The end-of-session hook also runs a
 *     FINAL ingestFileNow before archiving, so the index captures the tail.
 *   * Embeddings are NOT computed here — the embed-backfill sweep
 *     (search/embed-backfill.ts, bench admission lane) fills
 *     `text_embedding` asynchronously; ingest must never block on network.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { listAllProjectedTools } from '@papercusp/tooldef';
import { papercuspPath } from '@papercusp/host-platform/home';
import { PAPERCUSP_MCP_SERVER_NAMES } from '../papercusp-mcp-servers';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { cooperativeYield } from '../event-loop-lag-monitor';
import { blockPayloadText, codexToolCallArgsRaw, CLAUDE_OWNER_DIALOG_RESULT_PREFIXES, dialogAnswerText, claudeDialogProvenanceAttachment } from '../transcript-wire';
import { classifyRecordedTurn } from '../turn-provenance/turn-ref';
import { closeTruncatedWholePaste } from '../turn-provenance/envelope-grammar';
import {
  MACHINE_SURFACE_CATALOGUE_VERSION,
  CLASSIFY_HEAD_CHARS,
} from '../turn-provenance/machine-surface-catalogue';
import {
  addResultBytes,
  addToolUse,
  dayOf,
  extractLineUsage,
  rollupRows,
  type LineUsage,
  type UsageRollup,
} from '../bash-substitution/usage-rollup';
import { getSubstitutionRows } from '../bash-substitution/registry';
import type { SubstitutionRow } from '../bash-substitution/match';
import { activeWorkspaceId } from '../workspace-registry';
import { pinModuleState } from '@papercusp/module-singleton';
import { redactKeyDirectedSecrets, redactSelfIdentifyingSecrets } from '../sensitive-text';
import { capWithMarker, partTextCapFor } from '../transcript-text-caps';

// Backward-compatible export for the session-part security tests and archive readers.
export { redactKeyDirectedSecrets as redactPartSecrets } from '../sensitive-text';
import { SESSION_TURN_PART_RETENTION_DAYS, SESSION_TURN_RETENTION_DAYS } from './session-retention';

/** How far back a source file's mtime may be and still get ingested. */
const INGEST_WINDOW_DAYS = 45;
/** Retention for indexed turns (the JSONL remains the archive past this).
 *  Shared with the storage-growth alarm's retention-lag leg. */
const RETENTION_DAYS = SESSION_TURN_RETENTION_DAYS;
/** Per-tick caps — the tailer converges across ticks, never gulps. */
const MAX_FILES_PER_TICK = 200;
const MAX_TURNS_PER_TICK = 4000;
const MAX_BYTES_PER_FILE_PER_TICK = 5 * 1024 * 1024;
const MAX_CHATS_PER_TICK = 50;
/** WI-5218: cooperative-yield granularity for the per-line parse loop in
 * readNewLines — large enough that a quiet host pays only a handful of
 * macrotask hops per file (not thousands), small enough that even a single
 * MAX_BYTES_PER_FILE_PER_TICK-sized file can no longer block the main thread
 * for tens of milliseconds straight. */
const LINE_YIELD_EVERY = 1000;
/** Historical EI-9970 counter repair caps. The cursor persists across ticks. */
const MAX_COUNT_BACKFILL_FILES_PER_TICK = 25;
const MAX_COUNT_BACKFILL_BYTES_PER_TICK = 50 * 1024 * 1024;
/** Historical P-001 faithful-part repair caps. The cursor persists across ticks. */
const MAX_PART_BACKFILL_FILES_PER_TICK = 25;
const MAX_PART_BACKFILL_BYTES_PER_TICK = 50 * 1024 * 1024;
/** Per-turn text cap (chars). */
export const SESSION_TURN_TEXT_CAP = 8000;
const TEXT_CAP = SESSION_TURN_TEXT_CAP;
/** Short assistant acknowledgements are recall noise; short USER decisions are not. */
const MIN_TEXT_LEN = 3;
/**
 * Per-PART text caps (chars) — session_turn_parts, the faithful-render
 * companion (session-turn-storage-2026-07-28 D-002). These are now DERIVED
 * from the render budget rather than hardcoded here; see
 * `../transcript-text-caps` for why (this file used to carry a flat 2,000
 * justified by a comment claiming the pane capped there too — it caps at
 * 8,000, so the store was 4x tighter than the surface reading it and 16.9% of
 * all stored parts were truncated below what the pane would have shown).
 *
 * Prose (`text`/`thinking`) is stored to the full render budget. Tool payloads
 * keep the tighter volume cap — tool_result alone is 218 MB raw against text's
 * 21 MB over 7 days — and stay recoverable from the session file, which the
 * stream route prefers whenever a stored part was truncated.
 */
export { PART_TEXT_CAP_PROSE, PART_TEXT_CAP_TOOL, partTextCapFor } from '../transcript-text-caps';
/** Retention for faithful parts — SHORTER than RETENTION_DAYS by design
 * (D-002): recent sessions render faithfully, older ones degrade to the text
 * turns in session_turns, older still to session_archives. Shared with the
 * storage-growth alarm's retention-lag leg. */
const PART_RETENTION_DAYS = SESSION_TURN_PART_RETENTION_DAYS;

export type SourceKind = 'claude' | 'omp' | 'codex' | 'agent_chat';

/**
 * Native, non-semantic evidence about an assistant response.  `delivered`
 * means the client recorded its final-answer boundary; it never means a text
 * fragment merely happened to follow a prompt.  `interrupted` deliberately
 * does NOT settle the request that was being served.
 */
export type ParsedResponseDisposition = 'progress' | 'delivered' | 'interrupted';

export interface ParsedTurn {
  ts: Date | null;
  speaker: 'user' | 'assistant';
  text: string;
  cwd?: string | null;
  sessionId?: string | null;
  /** SHA-256 of the raw, normalized prompt before cap/redaction. Claude only;
   *  used to correlate the hook-authenticated OWNER stamp at insert time. */
  promptHash?: string | null;
  /** Native logical turn/request id when the client writes one on both sides
   *  of the exchange (Codex today).  Other clients are correlated through the
   *  message-parent chain below by the bounded transcript-tail reader. */
  requestId?: string | null;
  /** Native message graph identity.  These fields stay out of session_turns;
   *  the carry tail uses them in-memory to connect final delivery to the owner
   *  request it actually belongs to. */
  messageId?: string | null;
  parentMessageId?: string | null;
  /** Mechanically derived from the client wire: Claude end_turn, Codex
   *  final_answer, or OMP stop.  Missing/unknown is intentionally not success. */
  responseDisposition?: ParsedResponseDisposition | null;
}

/** The faithful-render part kinds stored in session_turn_parts. Mirrors the
 *  AgentTimelineEntry kinds the thinking pane renders, minus 'status' (which
 *  the render path derives from part_kind rather than storing). */
export type PartKind = 'text' | 'thinking' | 'tool_use' | 'tool_result';

/**
 * ONE content part of a transcript line (session-turn-storage-2026-07-28
 * P-001). A single JSONL line commonly yields SEVERAL of these — an assistant
 * line with a thinking block plus three tool_use blocks is four parts, in
 * content order — which is precisely the fidelity `session_turns` throws away
 * by design (it reduces the whole line to its joined text or nothing at all).
 */
export interface ParsedPart {
  ts: Date | null;
  speaker: 'user' | 'assistant';
  partKind: PartKind;
  /** tool_use / tool_result only. */
  toolName?: string | null;
  text: string;
  sessionId?: string | null;
}

/**
 * Per-line classification signal (EI-9970) — computed for EVERY raw
 * transcript line, not just the ones parseXLine turns into a stored
 * session_turns row. Feeds the real cost/effort-audit counters
 * (prompt_count / response_count / tool_call_count) that session_turns'
 * row count structurally cannot: that table is TEXT TURNS ONLY (tool_use /
 * tool_result / thinking-only content is never stored there by design), so
 * a bare count(*) over it was being misread as "how many turns did this
 * session take" when it only ever counted a filtered subset.
 */
export interface LineSignal {
  /** A non-empty user prompt, including one-character decisions; the origin
   *  classifier separately establishes whether its authorship is authenticated. */
  isPrompt: boolean;
  /** This line carries genuine model-response payload (real text and/or a
   *  tool call) — a candidate RESPONSE boundary, as opposed to a pure
   *  thinking-only placeholder line some clients (Claude) emit as a
   *  separate JSONL record ahead of the actual output. */
  isResponsePayload: boolean;
  /** The id tying this response-payload line to the one model call it
   *  belongs to (Claude: message.id/requestId; OMP/Codex: the record's own
   *  id) — null when the adapter has no such id (that line is always
   *  counted as its own distinct response, never deduped). ONLY set when
   *  isResponsePayload is true. A single model turn can legitimately span
   *  MULTIPLE raw JSONL 'assistant' lines sharing one id (a thinking-only
   *  stub, one line per tool_use block, then the text line) — counting raw
   *  lines instead of distinct ids reproduces the exact "matches nothing
   *  intuitive" bug this signal exists to fix.
   */
  inferenceId: string | null;
  /** Real tool invocations carried on this line (Claude tool_use content
   *  blocks; OMP toolCall content items; Codex counts as 0|1 since its
   *  tool calls are their own separate response_item line). */
  toolCallCount: number;
}

const NULL_SIGNAL: LineSignal = { isPrompt: false, isResponsePayload: false, inferenceId: null, toolCallCount: 0 };

export interface IngestStats {
  filesScanned: number;
  filesIngested: number;
  turnsInserted: number;
  /** P-001: faithful session_turn_parts rows written this sweep. */
  partsInserted?: number;
  chatsIngested: number;
  /** Historical session_ingest_state rows whose EI-9970 counters advanced. */
  countBackfillFiles: number;
  /** Historical session_ingest_state rows whose P-001 parts advanced. */
  partsBackfillFiles: number;
  errors: number;
  /** First few error messages of the sweep — diagnosis without log spam. */
  errorSample?: string[];
  durationMs: number;
  /** Exclusive wall-time buckets, including await/scheduling time, not CPU time.
   * `other` covers sweep bookkeeping outside the measured operations. */
  phaseMs?: Record<'setup' | 'history' | 'discovery' | 'state' | 'metadata' | 'decode' | 'writes' | 'metadataBackfill' | 'chats' | 'other', number>;
  /** One receipt per nonempty adapter/repair operation, not per file or row.
   * Wall spans include database and scheduling waits; they do not measure CPU.
   * Counts/spans and input hashes identify the operation without retaining
   * session IDs, owner IDs or SQL. */
  metadataBackfills?: Array<{
    sourceKind: SourceKind;
    operation: 'sessionOwners' | 'partOwners' | 'codexAdvSessions';
    requested: number;
    /** Owner repair: SHA-256 of JSON.stringify([sessionIds, owners]) in the
     * exact UNNEST parameter order. Captured before execution, even on failure;
     * a fingerprint supports comparison but cannot reconstruct the values. */
    inputSha256?: string;
    updated?: number;
    startedAtMs: number;
    durationMs: number;
    status: 'completed' | 'failed';
  }>;
  skipped?: string;
}

/** Keep slow, empty sweeps observable as well as useful or failed sweeps. */
export function sessionIngestLogLine(stats: IngestStats): string | null {
  const parts = stats.partsInserted ?? 0;
  if (stats.skipped || (stats.turnsInserted === 0 && parts === 0 && stats.errors === 0 && stats.durationMs < 5000)) {
    return null;
  }
  return `[session-ingest] +${stats.turnsInserted} turn(s) +${parts} part(s) from ${stats.filesIngested} file(s) ` +
    `+ ${stats.chatsIngested} chat turn(s) (${stats.filesScanned} scanned, ${stats.errors} error(s), ${stats.durationMs}ms)` +
    (stats.phaseMs ? ` phases=${JSON.stringify(stats.phaseMs)}` : '') +
    (stats.metadataBackfills?.length ? ` metadataBackfills=${JSON.stringify(stats.metadataBackfills)}` : '');
}

/** Injected boilerplate prefixes that would pollute recall — not real speech. */
const BOILERPLATE_PREFIXES = [
  '<system-reminder',
  '<local-command',
  '<command-name',
  '<user_instructions>',
  '<permissions instructions>',
  '<environment_context>',
  'Caveat: The messages below',
];

/** Re-exported for back-compat — the definition moved to transcript-wire.ts
 *  (EI-22171324436610992) so turn-provenance/turn-ref.ts can share it too
 *  without a circular import (this module already imports FROM turn-ref.ts).
 *  Re-exporting the IMPORTED binding (not `export … from`) so it's also
 *  bound locally for use inside this file's own parseClaudeLine, below. */
export { CLAUDE_OWNER_DIALOG_RESULT_PREFIXES };

/** Exported for the archive reader (session-archive-read.ts, P-009): archived
 *  bytes are VERBATIM, so anything surfaced to agents must retain the same
 *  secret redaction as the index, with an opt-in to recover past its cap. */
export interface TurnTextParseOptions {
  /** Return all parsed turn text while retaining the normal secret redaction. */
  fullSource?: boolean;
  /** False only while replaying a legacy prefix whose accepted turn indexes are fixed. */
  retainShortUserTurns?: boolean;
}

export function cleanTurnText(raw: string, options: TurnTextParseOptions = {}): string | null {
  const t = raw.trim();
  if (t.length < (options.retainShortUserTurns ? 1 : MIN_TEXT_LEN)) return null;
  for (const p of BOILERPLATE_PREFIXES) if (t.startsWith(p)) return null;
  if (options.fullSource || t.length <= TEXT_CAP) return redactSelfIdentifyingSecrets(t);
  // The cap cuts a whole-prompt paste's closing tag, so a PTY-typed machine
  // kickoff over the cap would lose the evidence that it is ONE paste and fall
  // to the unenrolled residual (WI-6554700010009878). Re-close it from the raw
  // end HERE, in the stored text itself, so insert-time stamping and every
  // later head+tail re-derivation (rederiveProvenanceWindow) see the same
  // whole paste. Owner words before or after the paste still fail the test.
  return redactSelfIdentifyingSecrets(
    closeTruncatedWholePaste(t.slice(0, TEXT_CAP), t.slice(-PROVENANCE_PASTE_TAIL_CHARS)),
  );
}

function cleanMessageText(raw: string, speaker: string, options: TurnTextParseOptions = {}): string | null {
  return cleanTurnText(raw, {
    ...options,
    retainShortUserTurns: speaker === 'user' && options.retainShortUserTurns !== false,
  });
}

/**
 * The parts analog of cleanTurnText — cap + BOTH redaction passes, and
 * deliberately NO boilerplate/min-length filtering: this store exists to
 * render a transcript faithfully, so a `<system-reminder>` block or a
 * two-character tool result is real content here even though it is noise for
 * recall.
 *
 * Redact BEFORE capping so a secret straddling the cap boundary cannot be
 * half-preserved, and cap after so the stored bytes stay bounded.
 *
 * The cap is PER KIND (`partTextCapFor`): prose keeps everything the pane can
 * render, tool payloads keep the tighter volume cap. `kind` defaults to prose
 * because that is the safe direction to be wrong in — an over-wide store costs
 * bytes, an over-narrow one destroys a reader's content irrecoverably.
 */
export function cleanPartText(raw: string, kind: PartKind = 'text'): string {
  const redacted = redactKeyDirectedSecrets(redactSelfIdentifyingSecrets(raw));
  return capWithMarker(redacted, partTextCapFor(kind));
}

/** Join the text parts of a message content (string or parts array). */
export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    const part = p as { type?: string; text?: string };
    if (typeof part.text !== 'string') continue;
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
      parts.push(part.text);
    }
  }
  return parts.join('\n');
}

function parseTs(v: unknown): Date | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Lockstep with UserPromptSubmit's Python normalize/sha256_hex helpers. */
export function promptOriginHash(raw: string): string {
  return createHash('sha256').update(raw.replace(/\r\n?/g, '\n').trim(), 'utf8').digest('hex');
}

/**
 * Claude Code records a prompt sent while a turn is running as a top-level
 * `attachment` line rather than a normal `user` message. Only the
 * human-authored prompt variant belongs in the recall index: other queued
 * commands are client plumbing and must keep the existing skip behavior.
 */
function parseClaudeQueuedCommand(
  obj: Record<string, unknown>,
  options: TurnTextParseOptions = {},
): ParsedTurn | null {
  if (obj.type !== 'attachment') return null;
  const attachment = obj.attachment as {
    type?: unknown;
    commandMode?: unknown;
    origin?: { kind?: unknown };
    prompt?: unknown;
    timestamp?: unknown;
  } | undefined;
  if (
    !attachment ||
    attachment.type !== 'queued_command' ||
    attachment.commandMode !== 'prompt' ||
    attachment.origin?.kind !== 'human' ||
    typeof attachment.prompt !== 'string'
  ) {
    return null;
  }
  const text = cleanMessageText(attachment.prompt, 'user', options);
  if (!text) return null;
  return {
    ts: parseTs(attachment.timestamp) ?? parseTs(obj.timestamp),
    speaker: 'user',
    text,
    cwd: typeof obj.cwd === 'string' ? obj.cwd : null,
    sessionId:
      typeof obj.sessionId === 'string'
        ? obj.sessionId
        : typeof obj.session_id === 'string'
          ? obj.session_id
          : null,
    promptHash: promptOriginHash(attachment.prompt),
  };
}

/* ------------------------------------------------------------------ */
/* Per-client line parsers (exported for unit tests)                    */
/* ------------------------------------------------------------------ */

/** Claude Code line → turn. Lines include normal user/assistant messages and
 * the narrowly gated human `attachment.type='queued_command'` prompt shape. */
export function parseClaudeLine(line: string, options: TurnTextParseOptions = {}): ParsedTurn | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const dialogProvenance = claudeDialogProvenanceAttachment(obj);
  if (dialogProvenance) {
    const text = cleanMessageText(dialogProvenance, 'user', options);
    if (!text) return null;
    return {
      ts: parseTs(obj.timestamp), speaker: 'user', text,
      cwd: typeof obj.cwd === 'string' ? obj.cwd : null,
      sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : null,
    };
  }
  const queuedCommand = parseClaudeQueuedCommand(obj, options);
  if (queuedCommand) return queuedCommand;
  if (obj.type !== 'user' && obj.type !== 'assistant') return null;
  const message = obj.message as { role?: string; content?: unknown; stop_reason?: unknown } | undefined;
  if (!message) return null;
  const speaker = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : null;
  if (!speaker) return null;
  let rawText = textFromContent(message.content);
  // EI-20772173866687919: AskUserQuestion answers are owner speech delivered
  // inside a synthetic `tool_result` user line. General tool results are a
  // 218 MB/week corpus and deliberately stay out of session_turns; promote
  // only Claude's stable owner-dialog result shape so sessions:search can find
  // the decision without flooding recall with tool output.
  if (!rawText && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue;
      const part = block as { type?: string; content?: unknown };
      if (part.type !== 'tool_result') continue;
      const payload = partPayloadText(part.content).trim();
      if (!CLAUDE_OWNER_DIALOG_RESULT_PREFIXES.some((prefix) => payload.startsWith(prefix))) continue;
      rawText = dialogAnswerText(payload);
      break;
    }
  }
  const text = cleanMessageText(rawText, speaker, options);
  if (!text) return null;
  const messageId = typeof obj.uuid === 'string' ? obj.uuid : null;
  const parentMessageId = typeof obj.parentUuid === 'string' ? obj.parentUuid : null;
  const stopReason = typeof message.stop_reason === 'string' ? message.stop_reason : null;
  const responseDisposition: ParsedResponseDisposition | null =
    speaker !== 'assistant'
      ? null
      : stopReason === 'end_turn'
        ? 'delivered'
        : stopReason === 'tool_use'
          ? 'progress'
          : obj.isApiErrorMessage === true || obj.error != null || stopReason === 'stop_sequence'
            ? 'interrupted'
            : null;
  return {
    ts: parseTs(obj.timestamp),
    speaker,
    text,
    cwd: typeof obj.cwd === 'string' ? obj.cwd : null,
    sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : null,
    promptHash: speaker === 'user' ? promptOriginHash(rawText) : null,
    requestId: speaker === 'user' ? messageId : null,
    messageId,
    parentMessageId,
    responseDisposition,
  };
}

/** Render a tool_use `input` / tool_result `content` payload as display text.
 *  A string passes through; anything structured is JSON — the pane shows the
 *  argument object, which is what makes a tool call readable at all. */
/**
 * Claude tool_result content is usually [{type:'text',text}] — prefer the text
 * parts, and fall back to JSON for image/structured blocks.
 *
 * WI-41498: this is now the SHARED implementation in transcript-wire, imported
 * rather than kept here. The live-timeline parser had its own, weaker copy of
 * the same idea (`JSON.stringify` of anything non-string) and fell behind the
 * wire while this one stayed correct — with nothing to fail when they diverged.
 * The local alias is kept so this module's call sites read unchanged.
 */
const partPayloadText = blockPayloadText;

/**
 * Claude Code line → FAITHFUL parts (session-turn-storage-2026-07-28 P-001).
 *
 * The counterpart to parseClaudeLine, which stores at most one joined-text row
 * per line. This walks the content array in order and emits every renderable
 * block: text, thinking, tool_use (name + input), tool_result (payload).
 *
 * Exported for unit tests, same convention as the parseX/classifyX family.
 */
export function parseClaudeParts(line: string): ParsedPart[] {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (obj.type !== 'user' && obj.type !== 'assistant') return [];
  const message = obj.message as { role?: string; content?: unknown } | undefined;
  if (!message) return [];
  const speaker = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : null;
  if (!speaker) return [];
  const ts = parseTs(obj.timestamp);
  const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId : null;
  const out: ParsedPart[] = [];
  const push = (partKind: PartKind, raw: string, toolName?: string | null) => {
    const text = cleanPartText(raw, partKind);
    // A tool_use is worth a row on its NAME alone (an argument-less call is
    // still a real event in the transcript); every other kind needs content.
    if (!text.trim() && partKind !== 'tool_use') return;
    out.push({ ts, speaker, partKind, toolName: toolName ?? null, text, sessionId });
  };

  const content = message.content;
  if (typeof content === 'string') {
    push('text', content);
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    const part = p as {
      type?: string; text?: string; thinking?: string;
      name?: string; input?: unknown; content?: unknown;
    };
    switch (part.type) {
      case 'text':
      case 'input_text':
      case 'output_text':
        push('text', typeof part.text === 'string' ? part.text : '');
        break;
      case 'thinking':
        // ⚠ In PRACTICE this stores nothing today, and that is deliberate —
        // do not "fix" it by widening the push() guard without reading D-007.
        //
        // Claude Code writes signature-only thinking records: the block is
        // {type,thinking,signature} with thinking === ''. Verified over the
        // real 7 d corpus (1,193 files / 6.4 M lines, both roots): 58,362 raw
        // `"type":"thinking"` blocks in the JSONL, ZERO thinking parts emitted
        // here — every one is dropped by the empty-text guard in push() above.
        //
        // That is the right outcome (an empty `[thinking]` entry is render
        // noise, and 58k content-free rows/week buy a reader nothing), and it
        // does NOT disturb ordering: part_idx is assigned over EMITTED parts,
        // so the parts that do render keep their relative order.
        //
        // The call stays because a build that DOES emit reasoning text — an
        // older transcript in this same corpus carries 1.5k thinking parts
        // with real prose — then flows through with no schema change.
        //
        // An earlier revision of this comment (and D-003) claimed thinking was
        // "stored so the part ORDER stays faithful". It never was. Corrected
        // 2026-07-28; see session-turn-storage-2026-07-28 D-007.
        push('thinking', typeof part.thinking === 'string' ? part.thinking : '');
        break;
      case 'tool_use':
        push('tool_use', partPayloadText(part.input), typeof part.name === 'string' ? part.name : null);
        break;
      case 'tool_result':
        push('tool_result', partPayloadText(part.content));
        break;
      default:
        break;
    }
  }
  return out;
}

/** OMP line → turn. Lines: {type:'message', timestamp, message:{role, content:[{type:'text',text}]}}. */
export function parseOmpLine(line: string, options: TurnTextParseOptions = {}): ParsedTurn | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj.type !== 'message') return null;
  const message = obj.message as {
    role?: string;
    content?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
  } | undefined;
  if (!message) return null;
  const speaker = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : null;
  if (!speaker) return null;
  const rawText = textFromContent(message.content);
  const text = cleanMessageText(rawText, speaker, options);
  if (!text) return null;
  const messageId = typeof obj.id === 'string' ? obj.id : null;
  const parentMessageId = typeof obj.parentId === 'string' ? obj.parentId : null;
  const stopReason = typeof message.stopReason === 'string' ? message.stopReason : null;
  const responseDisposition: ParsedResponseDisposition | null =
    speaker !== 'assistant'
      ? null
      : stopReason === 'stop'
        ? 'delivered'
        : stopReason === 'toolUse'
          ? 'progress'
          : stopReason === 'aborted' || stopReason === 'error' || message.errorMessage != null
            ? 'interrupted'
            : null;
  return {
    ts: parseTs(obj.timestamp),
    speaker,
    text,
    requestId: speaker === 'user' ? messageId : null,
    messageId,
    parentMessageId,
    responseDisposition,
    promptHash: speaker === 'user' ? promptOriginHash(rawText) : null,
  };
}

/** Codex rollout line → turn. Lines: {timestamp, type:'response_item', payload:{type:'message', role, content:[{type:'input_text'|'output_text', text}]}}. */
export function parseCodexLine(line: string, options: TurnTextParseOptions = {}): ParsedTurn | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  // Fallback prompt history: {session_id, ts(seconds), text}. Current Codex
  // builds can emit this while leaving the rollout path unmaterialized.
  if (
    typeof obj.session_id === 'string' &&
    typeof obj.text === 'string' &&
    (typeof obj.ts === 'number' || typeof obj.ts === 'string')
  ) {
    const text = cleanMessageText(obj.text, 'user', options);
    if (!text) return null;
    const rawTs = obj.ts;
    const ts = typeof rawTs === 'number' && rawTs < 10_000_000_000
      ? new Date(rawTs * 1000)
      : parseTs(rawTs);
    return { ts, speaker: 'user', text, sessionId: obj.session_id, promptHash: promptOriginHash(obj.text) };
  }
  if (obj.type !== 'response_item') return null;
  const payload = obj.payload as {
    type?: string;
    role?: string;
    content?: unknown;
    id?: unknown;
    phase?: unknown;
    internal_chat_message_metadata_passthrough?: unknown;
  } | undefined;
  if (!payload || payload.type !== 'message') return null;
  const speaker = payload.role === 'user' ? 'user' : payload.role === 'assistant' ? 'assistant' : null;
  if (!speaker) return null; // 'developer'/'system' = injected instructions, skip
  const rawText = textFromContent(payload.content);
  const text = cleanMessageText(rawText, speaker, options);
  if (!text) return null;
  const metadata =
    payload.internal_chat_message_metadata_passthrough != null &&
    typeof payload.internal_chat_message_metadata_passthrough === 'object' &&
    !Array.isArray(payload.internal_chat_message_metadata_passthrough)
      ? payload.internal_chat_message_metadata_passthrough as Record<string, unknown>
      : null;
  const requestId = typeof metadata?.turn_id === 'string' ? metadata.turn_id : null;
  const phase = typeof payload.phase === 'string' ? payload.phase : null;
  const responseDisposition: ParsedResponseDisposition | null =
    speaker !== 'assistant'
      ? null
      : phase === 'final_answer'
        ? 'delivered'
        : phase === 'commentary'
          ? 'progress'
          : null;
  return {
    ts: parseTs(obj.timestamp),
    speaker,
    text,
    requestId,
    messageId: typeof payload.id === 'string' ? payload.id : null,
    parentMessageId: null,
    responseDisposition,
    // Correlate the hook's original prompt, before display cleanup/truncation.
    promptHash: speaker === 'user' ? promptOriginHash(rawText) : null,
  };
}

/**
 * Codex rollout line → FAITHFUL parts.
 *
 * Codex writes each renderable item as its own `response_item`: message text,
 * tool calls, tool results, and readable reasoning summaries.  The turn parser
 * above deliberately keeps only message text for recall; this companion keeps
 * the full renderable stream for `session_turn_parts`, matching the Claude
 * adapter's separation contract.
 *
 * `event_msg/agent_message` is intentionally ignored because it duplicates the
 * canonical `response_item/message` record in current Codex rollouts.  Storing
 * both would double every assistant message and make freshness appear newer
 * than the actual model turn.
 */
export function parseCodexParts(line: string): ParsedPart[] {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (obj.type !== 'response_item') return [];

  const payload = obj.payload as {
    type?: string;
    role?: string;
    content?: unknown;
    name?: unknown;
    namespace?: unknown;
    arguments?: unknown;
    input?: unknown;
    query?: unknown;
    output?: unknown;
    summary?: unknown;
  } | undefined;
  if (!payload || typeof payload.type !== 'string') return [];

  const ts = parseTs(obj.timestamp);
  const out: ParsedPart[] = [];
  const push = (
    speaker: 'user' | 'assistant',
    partKind: PartKind,
    raw: string,
    toolName?: string | null,
  ) => {
    const text = cleanPartText(raw, partKind);
    // Preserve an argument-less tool call: its name is still a real event.
    if (!text.trim() && partKind !== 'tool_use') return;
    out.push({ ts, speaker, partKind, toolName: toolName ?? null, text });
  };

  if (payload.type === 'message') {
    const speaker = payload.role === 'user'
      ? 'user'
      : payload.role === 'assistant'
        ? 'assistant'
        : null;
    if (!speaker) return [];
    if (typeof payload.content === 'string') {
      push(speaker, 'text', payload.content);
      return out;
    }
    if (!Array.isArray(payload.content)) return out;
    for (const block of payload.content) {
      if (!block || typeof block !== 'object') continue;
      const part = block as { type?: string; text?: unknown };
      if (
        (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') &&
        typeof part.text === 'string'
      ) {
        push(speaker, 'text', part.text);
      }
    }
    return out;
  }

  if (
    payload.type === 'function_call' ||
    payload.type === 'custom_tool_call' ||
    payload.type === 'tool_search_call'
  ) {
    const namespace = typeof payload.namespace === 'string' && payload.namespace
      ? `${payload.namespace}.`
      : '';
    const name = typeof payload.name === 'string' && payload.name
      ? payload.name
      : payload.type;
    push(
      'assistant',
      'tool_use',
      // WI-41498: field list shared with the live-timeline parser
      // (transcript-wire) rather than spelled out twice.
      partPayloadText(codexToolCallArgsRaw(payload)),
      `${namespace}${name}`,
    );
    return out;
  }

  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    push('user', 'tool_result', partPayloadText(payload.output));
    return out;
  }

  if (payload.type === 'reasoning' && Array.isArray(payload.summary)) {
    const summary = (payload.summary as Array<{ text?: unknown } | string>)
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join(' ');
    push('assistant', 'thinking', summary);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Per-client line CLASSIFIERS (EI-9970) — every raw line, not just the  */
/* ones parseXLine turns into a stored session_turns row.                */
/* ------------------------------------------------------------------ */

/** Claude Code line → signal. tool_use blocks live in assistant content
 * arrays; tool_result blocks arrive as synthetic 'user'-role lines (not a
 * real prompt — excluded from isPrompt exactly like parseClaudeLine
 * already excludes them via the text-content shape, but tool_result
 * carriers pass textFromContent as empty since it only joins 'text' /
 * 'input_text' / 'output_text' parts, so no extra filtering is needed
 * there; the explicit check below is for clarity + a stable test pin). */
export function classifyClaudeLine(line: string): LineSignal | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parseClaudeQueuedCommand(obj)) return { ...NULL_SIGNAL, isPrompt: true };
  if (obj.type !== 'user' && obj.type !== 'assistant') return null;
  const message = obj.message as { role?: string; content?: unknown; id?: string } | undefined;
  if (!message) return null;

  if (message.role === 'user') {
    const content = message.content;
    const isToolResultCarrier =
      Array.isArray(content) &&
      content.some((p) => p && typeof p === 'object' && (p as { type?: string }).type === 'tool_result');
    if (isToolResultCarrier) return NULL_SIGNAL;
    const text = cleanMessageText(textFromContent(content), 'user');
    return text ? { ...NULL_SIGNAL, isPrompt: true } : NULL_SIGNAL;
  }

  if (message.role === 'assistant') {
    const content = message.content;
    let hasText = false;
    let toolCallCount = 0;
    if (Array.isArray(content)) {
      for (const p of content) {
        if (!p || typeof p !== 'object') continue;
        const part = p as { type?: string; text?: string };
        if (part.type === 'tool_use') toolCallCount += 1;
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim().length >= MIN_TEXT_LEN) {
          hasText = true;
        }
      }
    } else if (typeof content === 'string' && content.trim().length >= MIN_TEXT_LEN) {
      hasText = true;
    }
    const isResponsePayload = hasText || toolCallCount > 0; // excludes pure-thinking-only stub lines
    const inferenceId = isResponsePayload
      ? (typeof message.id === 'string' ? message.id : (typeof obj.requestId === 'string' ? (obj.requestId as string) : null))
      : null;
    return { isPrompt: false, isResponsePayload, inferenceId, toolCallCount };
  }

  return null;
}

/** OMP line → signal. Tool calls are 'assistant'-role content items of
 * type 'toolCall'; tool results arrive as their OWN role ('toolResult'),
 * distinct from Claude's synthetic-user-line convention. */
export function classifyOmpLine(line: string): LineSignal | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj.type !== 'message') return null;
  const message = obj.message as { role?: string; content?: unknown } | undefined;
  if (!message) return null;

  if (message.role === 'user') {
    const text = cleanMessageText(textFromContent(message.content), 'user');
    return text ? { ...NULL_SIGNAL, isPrompt: true } : NULL_SIGNAL;
  }
  if (message.role === 'toolResult') return NULL_SIGNAL;

  if (message.role === 'assistant') {
    const content = message.content;
    let hasText = false;
    let toolCallCount = 0;
    if (Array.isArray(content)) {
      for (const p of content) {
        if (!p || typeof p !== 'object') continue;
        const part = p as { type?: string; text?: string };
        if (part.type === 'toolCall') toolCallCount += 1;
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim().length >= MIN_TEXT_LEN) {
          hasText = true;
        }
      }
    } else if (typeof content === 'string' && content.trim().length >= MIN_TEXT_LEN) {
      hasText = true;
    }
    const isResponsePayload = hasText || toolCallCount > 0;
    const inferenceId = isResponsePayload && typeof obj.id === 'string' ? obj.id : null;
    return { isPrompt: false, isResponsePayload, inferenceId, toolCallCount };
  }

  return null;
}

/** Codex rollout line → signal. Tool calls are their OWN response_item
 * (payload.type 'function_call' | 'custom_tool_call'), never nested inside
 * a message's content — so unlike Claude/OMP, a codex assistant 'message'
 * payload is already atomic (one payload.id = one real response). */
export function classifyCodexLine(line: string): LineSignal | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof obj.session_id === 'string' && typeof obj.text === 'string') {
    return cleanMessageText(obj.text, 'user') ? { ...NULL_SIGNAL, isPrompt: true } : NULL_SIGNAL;
  }
  if (obj.type !== 'response_item') return null;
  const payload = obj.payload as { type?: string; role?: string; content?: unknown; id?: string } | undefined;
  if (!payload) return null;

  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    return { ...NULL_SIGNAL, toolCallCount: 1 };
  }
  if (payload.type !== 'message') return null;

  if (payload.role === 'user') {
    const text = cleanMessageText(textFromContent(payload.content), 'user');
    return text ? { ...NULL_SIGNAL, isPrompt: true } : NULL_SIGNAL;
  }
  if (payload.role === 'assistant') {
    const inferenceId = typeof payload.id === 'string' ? payload.id : null;
    return { isPrompt: false, isResponsePayload: true, inferenceId, toolCallCount: 0 };
  }
  return null; // 'developer'/'system' = injected instructions, same as parseCodexLine
}

/* ------------------------------------------------------------------ */
/* Adapter registry                                                     */
/* ------------------------------------------------------------------ */

/** A transcript root + how many DIRECTORY levels sit between it and the
 * .jsonl files. Depth-bounded traversal is load-bearing: a blind
 * `readdir({recursive:true})` over ~/.papercusp/session-claude descends into
 * 15k+ per-session Claude-config clones (statsig caches, todos, …) — millions
 * of dentries, observed HANGING the sweep for minutes (2026-07-05). The
 * transcript layouts are fixed-shape, so we only walk the known levels. */
interface RootSpec {
  root: string;
  dirDepth: number;
  /** Optional per-level descend filter (1-based dir level under root). Lets a
   *  FAT root walk only its known layout — su-codex-homes holds ~20 subdirs
   *  per home but only <home>/sessions/YYYY/MM/DD carries transcripts;
   *  enumerating everything is the 2026-07-05 sweep-hang class. */
  descend?: (dirName: string, level: number) => boolean;
}

interface FileAdapter {
  sourceKind: Exclude<SourceKind, 'agent_chat'>;
  roots: () => RootSpec[];
  parseLine: (line: string, options?: TurnTextParseOptions) => ParsedTurn | null;
  /** EI-9970: classifies EVERY line for prompt/response/tool-call
   *  counting — a superset of parseLine's TEXT-TURNS-ONLY scope. */
  classifyLine: (line: string) => LineSignal | null;
  /**
   * P-001 (session-turn-storage-2026-07-28): every renderable content part of
   * the line, in order, for the FAITHFUL `session_turn_parts` companion store.
   * A strict superset of parseLine's scope.
   *
   * Optional: Claude and Codex implement it today. An adapter without it simply
   * contributes no parts — its pane keeps reading the file, exactly as before,
   * with no behavior change and no empty-render risk.
   */
  parseParts?: (line: string) => ParsedPart[];
  /** Best-effort provenance derived from the file path. */
  meta: (filePath: string) => {
    sessionId: string;
    owner: string | null;
    /** Managed OMP homes encode the adv_sessions row id in their path. */
    advSessionId?: number | null;
  };
  /**
   * P-002: per-TOOL / per-VERB usage extracted from the same pass, for the
   * bash→tool substitution metric.
   *
   * Optional because the shape is client-specific and only the Claude adapter
   * implements it today. `classifyLine` already sees every `tool_use` block but
   * deliberately reduces them to a COUNT — the substitution metric needs the
   * tool's NAME (and, for the shell tool, the command's verbs), which is a
   * strictly larger signal than the EI-9970 counters wanted.
   *
   * Extracted HERE, inside the existing incremental walk, rather than by a
   * second scanner: a standalone 7d sweep measures ~95s over 10.5M lines, and
   * transcripts roll off, so counting as we ingest is the only way the number
   * survives its own window (see `bash-substitution/usage-rollup.ts`).
   */
  usageOf?: (line: string) => LineUsage;
}

/** Resolve Codex rollout identity from its filename plus the per-session
 * CODEX_HOME diagnostics stamp. Shared ~/.codex rollouts intentionally have
 * no coordination owner; only managed su-codex-homes carry lockOwnerSid. */
export function codexTranscriptMeta(filePath: string): { sessionId: string; owner: string | null } {
  const stem = basename(filePath, '.jsonl');
  const sessionMatch = stem.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i);
  const homeMatch = filePath.match(/^(.*\/su-codex-homes\/session-[^/]+)\/sessions\//);
  let owner: string | null = null;
  if (homeMatch) {
    try {
      const diagnostics = JSON.parse(
        readFileSync(join(homeMatch[1], 'papercusp-diagnostics.json'), 'utf8'),
      ) as { lockOwnerSid?: unknown };
      if (typeof diagnostics.lockOwnerSid === 'string' && diagnostics.lockOwnerSid.trim()) {
        owner = diagnostics.lockOwnerSid;
      }
    } catch {
      // A legacy/raced home has no trustworthy owner stamp; leave it unowned.
    }
  }
  return { sessionId: sessionMatch ? sessionMatch[1] : stem, owner };
}

/**
 * Resolve OMP transcript identity from its filename and, when present, the
 * managed per-session home. Shared ~/.omp transcripts intentionally have no
 * coordination owner. A psu-launched OMP home is named
 * `su-omp-homes/session-<advSessionId>/...`; the numeric directory is the
 * durable join key to adv_sessions, while the filename suffix is OMP's native
 * thread/session id.
 */
export function ompTranscriptMeta(filePath: string): {
  sessionId: string;
  owner: string | null;
  advSessionId: number | null;
} {
  const stem = basename(filePath, '.jsonl');
  const us = stem.indexOf('_');
  const sessionId = us >= 0 ? stem.slice(us + 1) : stem;
  const managed = filePath.match(/(?:^|\/)su-omp-homes\/session-(\d+)\/agent\/sessions(?:\/|$)/);
  if (!managed) return { sessionId, owner: null, advSessionId: null };
  const advSessionId = Number(managed[1]);
  return Number.isSafeInteger(advSessionId) && advSessionId > 0
    ? { sessionId, owner: null, advSessionId }
    : { sessionId, owner: null, advSessionId: null };
}

/** Metadata that can be recovered from a managed Codex transcript without
 * reading any conversational content. The numeric home key is the
 * adv_sessions row id; the rollout filename is Codex's native session id. */
export interface CodexAdvSessionMetadata {
  advSessionId: number;
  sessionId: string;
  model: string | null;
  effort: string | null;
}

const CODEX_NATIVE_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse the two root-level Codex settings we use for launch attribution.
 * This is intentionally a tiny, fail-soft reader rather than a general TOML
 * parser: config.toml is generated by Codex, and these values are always
 * quoted root keys. Keeping the parser narrow also prevents a profile/table
 * override from being mistaken for the session's effective default. */
export function parseCodexEffectiveConfig(configText: string): {
  model: string | null;
  effort: string | null;
} {
  let model: string | null = null;
  let effort: string | null = null;
  let inTable = false;
  for (const line of configText.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      inTable = true;
      continue;
    }
    if (inTable) continue;
    const match = line.match(/^\s*(model|model_reasoning_effort)\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/);
    if (!match) continue;
    if (match[1] === 'model') model = match[2];
    else effort = match[2];
  }
  return { model, effort };
}

/** Resolve the adv-session id from a per-session Codex home. Shared
 * `~/.codex` files and temporary port homes are deliberately excluded: they
 * do not contain an authoritative adv_sessions row key. */
function codexAdvSessionHome(filePath: string): { advSessionId: number; home: string } | null {
  const match = filePath.match(/(?:^|\/)(su-codex-homes\/session-(\d+))(?:\/|$)/);
  if (!match) return null;
  const advSessionId = Number(match[2]);
  if (!Number.isSafeInteger(advSessionId) || advSessionId <= 0) return null;
  const marker = `/${match[1]}`;
  const markerAt = filePath.indexOf(marker);
  return {
    advSessionId,
    home: markerAt >= 0 ? filePath.slice(0, markerAt + marker.length) : '',
  };
}

/** Read Codex's effective model/effort and native id for one managed rollout.
 * Missing config is expected after archive/reaper cleanup: native-id repair
 * still proceeds, while model/effort remain null until a live config is seen. */
export function codexAdvSessionMetadata(
  filePath: string,
  sessionIdOverride?: string | null,
): CodexAdvSessionMetadata | null {
  const home = codexAdvSessionHome(filePath);
  if (!home) return null;
  const sessionId = sessionIdOverride?.trim() || codexTranscriptMeta(filePath).sessionId;
  if (!CODEX_NATIVE_SESSION_ID_RE.test(sessionId)) return null;
  let model: string | null = null;
  let effort: string | null = null;
  try {
    const config = parseCodexEffectiveConfig(readFileSync(join(home.home, 'config.toml'), 'utf8'));
    model = config.model;
    effort = config.effort;
  } catch {
    // The home can be reaped immediately after the rollout is discovered.
  }
  return { advSessionId: home.advSessionId, sessionId, model, effort };
}

const HOME = homedir();

/** psu homes created before workspace-scoped state remain live across upgrades. */
function managedTranscriptRoots(directory: string): string[] {
  return [...new Set([papercuspPath(directory), join(HOME, '.papercusp', directory)])];
}

export const FILE_ADAPTERS: FileAdapter[] = [
  {
    sourceKind: 'claude',
    usageOf: extractLineUsage,
    roots: () => [
      // ~/.claude/projects/<munged-cwd>/<uuid>.jsonl
      { root: join(HOME, '.claude', 'projects'), dirDepth: 1 },
      // ~/.papercusp/session-claude/<ownerId>/projects/<munged-cwd>/<uuid>.jsonl
      ...managedTranscriptRoots('session-claude').map((root) => ({ root, dirDepth: 3 })),
    ],
    parseLine: parseClaudeLine,
    classifyLine: classifyClaudeLine,
    parseParts: parseClaudeParts,
    meta: (filePath) => {
      // psu isolation dir carries the launching session's owner dir:
      // ~/.papercusp/session-claude/<ownerDir>/projects/<munged-cwd>/<uuid>.jsonl
      const m = filePath.match(/\/session-claude\/([^/]+)\//);
      return { sessionId: basename(filePath, '.jsonl'), owner: m ? m[1] : null };
    },
  },
  {
    sourceKind: 'omp',
    roots: () => [
      // ~/.omp/agent/sessions/<munged-cwd>/<ts>_<uuid>.jsonl
      { root: join(HOME, '.omp', 'agent', 'sessions'), dirDepth: 1 },
      // psu isolation dir — a psu-launched OMP agent gets a PER-SESSION omp home and
      // never writes to ~/.omp, so without this root every psu OMP transcript is
      // invisible to the index (EI-20212281439039808). The claude adapter above has
      // carried its psu root for a while; this pair must not drift again — guarded by
      // session-ingest-psu-roots.test.ts.
      // ~/.papercusp/su-omp-homes/session-<advSessionId>/agent/sessions/<munged-cwd>/<ts>_<uuid>.jsonl
      ...managedTranscriptRoots('su-omp-homes').map((root) => ({ root, dirDepth: 4 })),
    ],
    parseLine: parseOmpLine,
    classifyLine: classifyOmpLine,
    meta: ompTranscriptMeta,
  },
  {
    sourceKind: 'codex',
    // ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
    roots: () => [
      { root: join(HOME, '.codex', 'sessions'), dirDepth: 3 },
      // Per-session CODEX_HOMEs: <home>/sessions/YYYY/MM/DD/rollout-*.jsonl.
      // session-db-archive-retire-dirs-2026-07-10 P-005: fleet codex sessions
      // previously had ZERO session_turns rows — only the shared ~/.codex was
      // walked. descend pins level 2 to 'sessions' so the walk never
      // enumerates the ~20 unrelated subdirs of every home.
      ...managedTranscriptRoots('su-codex-homes').map((root) => ({
        root,
        dirDepth: 5,
        descend: (name: string, level: number) => (level === 2 ? name === 'sessions' : true),
      })),
    ],
    parseLine: parseCodexLine,
    classifyLine: classifyCodexLine,
    parseParts: parseCodexParts,
    meta: codexTranscriptMeta,
  },
];

/** Collect *.jsonl exactly `dirDepth` directory levels under `root` (BFS,
 * never descending past the known layout — see RootSpec). Exported for the
 * walker's own tests (P-005 descend-filter contract). */
export async function jsonlAtDepth(
  root: string,
  dirDepth: number,
  descend?: (dirName: string, level: number) => boolean,
): Promise<string[]> {
  let dirs = [root];
  for (let d = 0; d < dirDepth; d += 1) {
    const next: string[] = [];
    for (const dir of dirs) {
      try {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          if (descend && !descend(e.name, d + 1)) continue;
          next.push(join(dir, e.name));
        }
      } catch { /* absent / raced — skip */ }
    }
    dirs = next;
    if (!dirs.length) return [];
  }
  const files: string[] = [];
  for (const dir of dirs) {
    try {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.jsonl')) files.push(join(dir, e.name));
      }
    } catch { /* skip */ }
  }
  return files;
}

/* ------------------------------------------------------------------ */
/* Tailer                                                               */
/* ------------------------------------------------------------------ */

interface TurnRow {
  workspace_id: string;
  source_kind: string;
  session_id: string;
  turn_idx: number;
  /** ISO string — postgres-js's sql(rows) bulk-insert helper rejects Date values. */
  ts: string | null;
  owner: string | null;
  harness_slug: string | null;
  cwd: string | null;
  speaker: string;
  text: string;
  /** Provenance, stamped at insert by `stampTurnProvenance` — never by the
   *  adapters. Optional on the way in, always set on the way out. */
  turn_origin?: string | null;
  turn_origin_verdict?: string | null;
  turn_origin_classifier_version?: number | null;
  /** Insert-only correlation material; never persisted on session_turns. */
  prompt_hash?: string | null;
}

/**
 * A file-backed CLI row without an enrollment envelope has no trustworthy
 * authorship signal.  Keep that uncertainty explicit in the persisted
 * verdict instead of allowing `owner-typed` (the catalogue's residual) to
 * assert that the owner wrote it.
 *
 * This is intentionally an ingest-only verdict.  `classifyRecordedTurn`
 * remains the shared text classifier used by owner-facing surfaces, where
 * known machine markers still have a useful, bounded display decision.
 */
export const UNENROLLED_ORIGIN_VERDICT = 'unenrolled-origin';

/** Durable identity of a successful exact hook-receipt correlation. Unlike
 * the old owner-typed text residual, this survives receipt expiry and lets
 * the classifier backfill preserve positive evidence without guessing. */
export const HOOK_AUTHENTICATED_PROMPT_ORIGIN = 'hook-authenticated-prompt';

/**
 * Source kinds whose `speaker='user'` rows may arrive without an enrollment
 * envelope, and whose uncorrelated `owner-typed` residual is therefore
 * downgraded to `UNENROLLED_ORIGIN_VERDICT` below. A matching
 * hook-authenticated prompt-origin stamp can promote the exact row back to
 * `owner-typed` during insertion (the current query reads Claude stamps).
 *
 * EXPORTED because that downgrade has a consequence a READER must be told
 * about: the residual can remain `unenrolled-origin`, so a provenance-filtered
 * search over a CLI session may return a sparse or zero result that looks
 * exactly like "the owner never said it". `sessions:search` derives its
 * zero-hit caveat from this set and describes the correlation exception rather
 * than restating an impossible structural claim in prose.
 */
export const FILE_BACKED_SOURCE_KINDS = new Set<SourceKind>(['claude', 'omp', 'codex']);

/** Tight enough to distinguish repeated prompts, wide enough for a delayed
 * ingest tick. The durable stamp itself expires after ten minutes. */
export const PROMPT_ORIGIN_MATCH_WINDOW_MS = 2 * 60 * 1000;

export interface PromptOriginStamp {
  source_kind: string;
  session_id: string;
  prompt_hash: string;
  submitted_at: Date | string;
  /** Validity is anchored to the TURN it authenticates, never to ingest time
   *  (WI-10006568): a stamp vouches for a prompt typed before it expired. */
  expires_at?: Date | string | null;
}

export interface CorrelatePromptOriginOptions {
  /** Rows that must keep a stamp before any other row may take one. Replay
   *  (WI-10008183) passes the already-promoted rows here: each consumed a
   *  stamp when it was promoted, and a nearer candidate must not take it. */
  priority?: ReadonlySet<TurnRow>;
}

/** Upgrade only the exact v5 uncertainty state. An authenticated stamp can
 * never override an envelope or catalogue machine verdict.
 *
 * Each stamp vouches for at most one turn and each turn takes at most one
 * stamp. Rows and stamps are matched per (source, session, prompt hash)
 * cluster, because only identical prompts can compete for a stamp. Inside a
 * cluster the matching is chosen by time, never by the order rows arrive in
 * (WI-10008184: an earlier identical turn took the stamp of a later one). The
 * chosen matching maximises, in this order: priority rows matched, rows
 * matched, then closeness (smallest total |turn − stamp| delta).
 *
 * The search is over order-preserving matchings of the time-sorted rows and
 * stamps. For a distance cost with a symmetric window that loses nothing: any
 * crossing pair can be uncrossed without leaving the window or adding
 * distance. Expiry is a per-pair check against the turn's own time. */
export function correlatePromptOriginStamps(
  rows: TurnRow[],
  stamps: PromptOriginStamp[],
  options: CorrelatePromptOriginOptions = {},
): number {
  const clusterKey = (sourceKind: string, sessionId: string, hash: string) =>
    [sourceKind, sessionId, hash].join('\u0000');
  const rowsByCluster = new Map<string, Array<{ row: TurnRow; ms: number }>>();
  for (const row of rows) {
    if (
      row.turn_origin_classifier_version !== MACHINE_SURFACE_CATALOGUE_VERSION ||
      row.turn_origin_verdict !== UNENROLLED_ORIGIN_VERDICT ||
      !row.prompt_hash ||
      !row.ts
    ) continue;
    const ms = Date.parse(row.ts);
    if (!Number.isFinite(ms)) continue;
    const key = clusterKey(row.source_kind, row.session_id, row.prompt_hash);
    rowsByCluster.set(key, [...(rowsByCluster.get(key) ?? []), { row, ms }]);
  }
  if (!rowsByCluster.size) return 0;
  const stampsByCluster = new Map<string, Array<{ ms: number; expiresMs: number | null }>>();
  for (const stamp of stamps) {
    const key = clusterKey(stamp.source_kind, stamp.session_id, stamp.prompt_hash);
    if (!rowsByCluster.has(key)) continue;
    const ms = new Date(stamp.submitted_at).getTime();
    if (!Number.isFinite(ms)) continue;
    const expiresMs = stamp.expires_at == null ? null : new Date(stamp.expires_at).getTime();
    stampsByCluster.set(key, [...(stampsByCluster.get(key) ?? []), { ms, expiresMs }]);
  }
  const priority = options.priority;
  let matched = 0;
  for (const [key, clusterRows] of rowsByCluster) {
    const clusterStamps = stampsByCluster.get(key);
    if (!clusterStamps?.length) continue;
    clusterRows.sort((a, b) => a.ms - b.ms);
    clusterStamps.sort((a, b) => a.ms - b.ms);
    const deltaOf = (r: { ms: number }, s: { ms: number; expiresMs: number | null }): number | null => {
      // An expired stamp cannot vouch for a prompt typed after it expired. It
      // is compared with the TURN's own time, not with now(): measuring it
      // against ingest time lost every owner turn ingested more than one TTL
      // late (WI-10006568, 58 rows measured). A NaN expiry fails closed.
      if (s.expiresMs != null && !(s.expiresMs > r.ms)) return null;
      const delta = Math.abs(r.ms - s.ms);
      return delta <= PROMPT_ORIGIN_MATCH_WINDOW_MS ? delta : null;
    };
    // No pair can span a gap wider than the window, so each run of events
    // between such gaps is matched on its own. That keeps the table small for
    // a prompt repeated all session long ("continue").
    for (const [rowSlice, stampSlice] of splitAtWindowGaps(clusterRows, clusterStamps)) {
      for (const index of matchCluster(rowSlice, stampSlice, deltaOf, (r) => priority?.has(r.row) ?? false)) {
        const row = rowSlice[index].row;
        row.turn_origin = HOOK_AUTHENTICATED_PROMPT_ORIGIN;
        row.turn_origin_verdict = 'owner-typed';
        matched += 1;
      }
    }
  }
  return matched;
}

/** Split time-sorted rows and stamps wherever consecutive events (of either
 * kind) are more than the match window apart. Segments without both a row and
 * a stamp are dropped. */
function splitAtWindowGaps<R extends { ms: number }, S extends { ms: number }>(rows: R[], stamps: S[]): Array<[R[], S[]]> {
  const segments: Array<[R[], S[]]> = [];
  let current: [R[], S[]] = [[], []];
  let lastMs = Number.NEGATIVE_INFINITY;
  let i = 0;
  let j = 0;
  while (i < rows.length || j < stamps.length) {
    const takeRow = j >= stamps.length || (i < rows.length && rows[i].ms <= stamps[j].ms);
    const ms = takeRow ? rows[i].ms : stamps[j].ms;
    if (ms - lastMs > PROMPT_ORIGIN_MATCH_WINDOW_MS) {
      if (current[0].length && current[1].length) segments.push(current);
      current = [[], []];
    }
    if (takeRow) current[0].push(rows[i++]);
    else current[1].push(stamps[j++]);
    lastMs = ms;
  }
  if (current[0].length && current[1].length) segments.push(current);
  return segments;
}

/** Order-preserving matching of time-sorted rows to time-sorted stamps by
 * dynamic programming over prefixes. Returns the indices of matched rows.
 * Score compared lexicographically: priority matched, matched, −total delta.
 * Ties keep the earlier row, which is what the row-order rule used to do. */
function matchCluster<R, S>(
  rows: R[],
  stamps: S[],
  deltaOf: (row: R, stamp: S) => number | null,
  isPriority: (row: R) => boolean,
): number[] {
  const n = rows.length;
  const m = stamps.length;
  const width = m + 1;
  const cells = (n + 1) * width;
  const prio = new Int32Array(cells);
  const count = new Int32Array(cells);
  const cost = new Float64Array(cells);
  // 0 = skip row, 1 = skip stamp, 2 = match row with stamp
  const step = new Uint8Array(cells);
  const better = (p: number, c: number, d: number, at: number) =>
    p !== prio[at] ? p > prio[at] : c !== count[at] ? c > count[at] : d < cost[at];
  const set = (at: number, from: number, move: number) => {
    prio[at] = prio[from]; count[at] = count[from]; cost[at] = cost[from]; step[at] = move;
  };
  for (let j = 1; j <= m; j += 1) step[j] = 1;
  for (let i = 1; i <= n; i += 1) {
    const priority = isPriority(rows[i - 1]) ? 1 : 0;
    for (let j = 1; j <= m; j += 1) {
      const at = i * width + j;
      set(at, (i - 1) * width + j, 0);
      const skipStamp = i * width + j - 1;
      if (better(prio[skipStamp], count[skipStamp], cost[skipStamp], at)) set(at, skipStamp, 1);
      const delta = deltaOf(rows[i - 1], stamps[j - 1]);
      if (delta != null) {
        const prev = (i - 1) * width + j - 1;
        const p = prio[prev] + priority;
        const c = count[prev] + 1;
        const d = cost[prev] + delta;
        if (better(p, c, d, at)) { prio[at] = p; count[at] = c; cost[at] = d; step[at] = 2; }
      }
    }
  }
  const matchedRows: number[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const move = step[i * width + j];
    if (move === 2) { matchedRows.push(i - 1); i -= 1; j -= 1; }
    else if (move === 1) j -= 1;
    else i -= 1;
  }
  return matchedRows;
}

function isUnenrolledFileRow(row: Pick<TurnRow, 'source_kind' | 'speaker'>): boolean {
  return row.speaker === 'user' && FILE_BACKED_SOURCE_KINDS.has(row.source_kind as SourceKind);
}

async function listCandidateFiles(
  adapter: FileAdapter,
  sinceMs: number,
): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const spec of adapter.roots()) {
    const paths = await jsonlAtDepth(spec.root, spec.dirDepth, spec.descend);
    for (const p of paths) {
      try {
        const s = await stat(p);
        if (!s.isFile() || s.mtimeMs < sinceMs || s.size === 0) continue;
        out.push({ path: p, size: s.size, mtimeMs: s.mtimeMs });
      } catch {
        /* raced deletion — skip */
      }
    }
  }
  return out;
}

/** A managed fork can leave a seed copy with the source session's native id in
 * the fork owner's directory, including after the original file is archived.
 * Resolve path owners from psu's first-write-wins birth index before decoding
 * or repairing indexed turns. An absent index preserves the path fallback. */
async function indexedClaudeOwnersForCandidates(
  adapter: FileAdapter,
  candidates: ReadonlyArray<{ path: string }>,
): Promise<Map<string, string>> {
  const sessionIds = new Set<string>();
  for (const candidate of candidates) {
    const { sessionId, owner } = adapter.meta(candidate.path);
    if (owner) sessionIds.add(sessionId);
  }
  const resolved = new Map<string, string>();
  const ids = [...sessionIds];
  for (let start = 0; start < ids.length; start += 32) {
    await Promise.all(ids.slice(start, start + 32).map(async (sessionId) => {
      const indexed = await indexedClaudeOwner(sessionId);
      if (indexed) resolved.set(sessionId, indexed);
    }));
  }
  return resolved;
}

const indexedClaudeOwnerCache = pinModuleState<Map<string, { owner: string | null; at: number }>>(
  '@papercusp/operator-core.indexedClaudeOwners', () => new Map(),
);

async function indexedClaudeOwner(sessionId: string): Promise<string | null> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) return null;
  const cached = indexedClaudeOwnerCache.get(sessionId);
  if (cached && (cached.owner || Date.now() - cached.at < 60_000)) return cached.owner;
  let owner: string | null = null;
  try {
    const indexed = JSON.parse(await readFile(
      papercuspPath('psu-session-owners', sessionId), 'utf8',
    )) as { ownerId?: unknown };
    owner = typeof indexed.ownerId === 'string' && indexed.ownerId ? indexed.ownerId : null;
  } catch { /* older/untracked sessions have no birth index */ }
  indexedClaudeOwnerCache.delete(sessionId);
  indexedClaudeOwnerCache.set(sessionId, { owner, at: Date.now() });
  if (indexedClaudeOwnerCache.size > 20_000) {
    const oldest = indexedClaudeOwnerCache.keys().next().value;
    if (oldest) indexedClaudeOwnerCache.delete(oldest);
  }
  return owner;
}

/** Read complete lines from `filePath` starting at `offset`, bounded. Returns
 * the parsed-turn list + the new offset (end of last complete line), plus
 * (EI-9970) the prompt/response/tool-call deltas classifyLine finds across
 * the SAME line window — a superset of parseLine's stored-row scope.
 * `lastInferenceId` carries the previous tick's dedup cursor in, so a model
 * response split across a tick boundary is never double-counted. Exported
 * for its own fixture test (EI-9970 recurrence guard — the split-response
 * dedup contract), same convention as jsonlAtDepth. */
export async function readNewLines(
  filePath: string,
  offset: number,
  parseLine: (l: string, options?: TurnTextParseOptions) => ParsedTurn | null,
  classifyLine: (l: string) => LineSignal | null,
  lastInferenceId: string | null,
  usageOf?: (l: string) => LineUsage,
  substitutionRows: SubstitutionRow[] = [],
  parseParts?: (l: string) => ParsedPart[],
  parseOptions: TurnTextParseOptions = {},
): Promise<{
  turns: ParsedTurn[];
  /** P-001 faithful parts — empty when the adapter has no `parseParts`. */
  parts: ParsedPart[];
  newOffset: number;
  promptCount: number;
  responseCount: number;
  toolCallCount: number;
  lastInferenceId: string | null;
  /** P-002 per-tool/per-verb usage; empty when the adapter has no extractor. */
  usage: UsageRollup;
}> {
  // Declared up front so every early return reports the same (empty) shape —
  // a caller must never have to distinguish "no usage extractor" from "this
  // tick read nothing".
  const usage: UsageRollup = new Map();
  const fh = await open(filePath, 'r');
  try {
    const s = await fh.stat();
    if (s.size <= offset) {
      return { turns: [], parts: [], newOffset: offset, promptCount: 0, responseCount: 0, toolCallCount: 0, lastInferenceId, usage };
    }
    const toRead = Math.min(s.size - offset, MAX_BYTES_PER_FILE_PER_TICK);
    const buf = Buffer.alloc(toRead);
    await fh.read(buf, 0, toRead, offset);
    const chunk = buf.toString('utf8');
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl < 0) {
      // A single Codex record can exceed the 5 MiB tick window (for example a
      // tool result carrying a screenshot or a very large command response).
      // Returning the same offset wedges this file forever: every later tick
      // rereads the same prefix and again finds no newline. Scan forward with
      // bounded memory and skip that one unindexable record once it is
      // complete; subsequent normal turns remain searchable. If the record is
      // still being written and has no newline yet, retain the offset so a
      // partial record is never mistaken for complete data.
      const scanSize = 1024 * 1024;
      let cursor = offset + toRead;
      while (cursor < s.size) {
        const size = Math.min(scanSize, s.size - cursor);
        const scan = Buffer.alloc(size);
        await fh.read(scan, 0, size, cursor);
        const nl = scan.indexOf(0x0a);
        if (nl >= 0) {
          return {
            turns: [],
            parts: [],
            newOffset: cursor + nl + 1,
            promptCount: 0,
            responseCount: 0,
            toolCallCount: 0,
            lastInferenceId,
            usage,
          };
        }
        cursor += size;
      }
      return { turns: [], parts: [], newOffset: offset, promptCount: 0, responseCount: 0, toolCallCount: 0, lastInferenceId, usage };
    }
    const usable = chunk.slice(0, lastNl + 1);
    const turns: ParsedTurn[] = [];
    const parts: ParsedPart[] = [];
    let promptCount = 0;
    let responseCount = 0;
    let toolCallCount = 0;
    let cursor = lastInferenceId;
    // WI-5218: this loop does per-line JSON.parse (parseLine + classifyLine)
    // fully synchronously with zero await points — on a large transcript file
    // (up to MAX_BYTES_PER_FILE_PER_TICK = 5 MiB, tens of thousands of lines)
    // that blocks the main thread long enough to starve the routine ticker
    // (measured: 10-50 loop-governor "event loop recovered" recoveries/h,
    // blender scout recombine timeouts, outbox-drain pass-timeouts — root
    // cause confirmed via journal correlation, session-ingest pass durations
    // trending to 20-30s as scanned-file count grew). Cooperative-yield every
    // LINE_YIELD_EVERY lines: cheap on a quiet host (a handful of macrotask
    // hops per file), aggressive under real pressure (cooperativeYield yields
    // on every call once loopPressure() is already elevated) — same fix class
    // as the WI-2344 precedent (plugin-host boot warm-up).
    let yielded = 0;
    for (const line of usable.split('\n')) {
      if (line.trim()) {
        const t = parseLine(line, parseOptions);
        if (t) turns.push(t);
        if (parseParts) {
          // P-001. Same pass as parseLine/classifyLine — the per-line
          // JSON.parse is the expensive thing (WI-5218), so a second walk to
          // extract parts would add a third full parse of every line.
          // Fail-soft per line: a malformed part must never cost the TURN.
          try {
            for (const p of parseParts(line)) parts.push(p);
          } catch { /* one bad line, not the file */ }
        }
        const sig = classifyLine(line);
        if (sig) {
          if (sig.isPrompt) promptCount += 1;
          toolCallCount += sig.toolCallCount;
          if (sig.isResponsePayload) {
            // A null id is never deduped (no basis to compare); a stable id only
            // counts as a NEW response when it differs from the immediately
            // preceding response line's id (a multi-line split shares one id).
            if (sig.inferenceId === null || sig.inferenceId !== cursor) responseCount += 1;
            cursor = sig.inferenceId;
          }
        }
        if (usageOf) {
          // P-002. Folded into the SAME pass — the per-line JSON.parse is
          // already the expensive thing here (WI-5218), so a second walk just
          // to count tools would double the cost of the hot loop.
          // Undated records are dropped rather than dated "now": the metric is
          // read as a ts-window, and defaulting would inflate whichever window
          // happened to be running.
          try {
            const u = usageOf(line);
            for (const obs of u.toolUses) addToolUse(usage, obs, null, substitutionRows);
            if (u.resultBytes > 0) addResultBytes(usage, u.resultBytes, dayOf(u.ts));
          } catch {
            // A metric must never cost an ingest. Skip this line's counts.
          }
        }
      }
      yielded = await cooperativeYield(yielded, LINE_YIELD_EVERY);
    }
    return {
      turns,
      parts,
      newOffset: offset + Buffer.byteLength(usable, 'utf8'),
      promptCount,
      responseCount,
      toolCallCount,
      lastInferenceId: cursor,
      usage,
    };
  } finally {
    await fh.close();
  }
}

/**
 * Persist one tick's per-tool/per-verb counts (P-002).
 *
 * BEST-EFFORT BY CONTRACT, and called AFTER the offset has advanced. The
 * tradeoff is deliberate and worth stating: if this write fails, that tick's
 * counts are lost for good (those bytes will not be re-read). The alternative —
 * writing the rollup before the offset so a failure retries — would let a
 * persistently failing metric WEDGE transcript ingestion for the whole fleet.
 * A metric is never allowed to damage the pipeline it measures, so it loses
 * rather than blocks, and the caller only counts the error.
 *
 * Idempotent per (workspace, source, session, day, tool, verb, intent_label):
 * counts are ADDED on conflict, since each call carries only the delta this
 * tick read. The conflict target MUST stay in lockstep with the table's primary
 * key (migration 674 widened it with intent_label) — a narrower target would
 * fold a bucket row into the per-call row and corrupt the headline count.
 */
async function writeUsageRollup(
  sql: Sql,
  sourceKind: string,
  sessionId: string,
  usage: UsageRollup,
): Promise<void> {
  const rows = rollupRows(usage);
  if (!rows.length) return;
  const days = rows.map((r) => r.day);
  const tools = rows.map((r) => r.toolName);
  const verbs = rows.map((r) => r.verb ?? '');
  const intents = rows.map((r) => r.intentLabel ?? '');
  const calls = rows.map((r) => r.calls);
  const atoms = rows.map((r) => r.atoms);
  const bytes = rows.map((r) => r.resultBytes);
  await sql`
    INSERT INTO harness_shared.tool_usage_rollup
      (workspace_id, source_kind, session_id, day, tool_name, verb, intent_label, calls, atoms, result_bytes)
    SELECT 'default', ${sourceKind}, ${sessionId}, d::date, t, v, i, c, a, b
      FROM UNNEST(
        ${sql.array(days)}::text[], ${sql.array(tools)}::text[], ${sql.array(verbs)}::text[],
        ${sql.array(intents)}::text[],
        ${sql.array(calls)}::bigint[], ${sql.array(atoms)}::bigint[], ${sql.array(bytes)}::bigint[]
      ) AS u(d, t, v, i, c, a, b)
    ON CONFLICT (workspace_id, source_kind, session_id, day, tool_name, verb, intent_label) DO UPDATE
      SET calls        = harness_shared.tool_usage_rollup.calls + EXCLUDED.calls,
          atoms        = harness_shared.tool_usage_rollup.atoms + EXCLUDED.atoms,
          result_bytes = harness_shared.tool_usage_rollup.result_bytes + EXCLUDED.result_bytes,
          updated_at   = now()
  `;
}

/**
 * Stamp owner-vs-machine provenance onto a row, in place.
 *
 * WHY HERE AND NOT IN THE ADAPTERS. This is the single choke point every
 * adapter's rows funnel through, so stamping here covers claude/omp/codex/
 * agent_chat by construction — a new adapter cannot forget to do it, which is
 * the failure mode that produced four divergent private classifiers in the
 * first place (plan owner-visibility-provenance-2026-08-11 D-013).
 *
 * WHY ONLY `user` TURNS GET CLASSIFIED. `classifyRecordedTurn` answers "is this
 * recorded USER turn owner-typed", and it reaches `owner-typed` as the RESIDUAL
 * — no rule matched. Assistant turns never carry an envelope and never match a
 * machine-surface pattern, so applying it unguarded would stamp `owner-typed`
 * on every one of them (25,198 in a measured 3-day window would have
 * qualified). They get the explicit `not-user-turn` verdict instead, which is
 * also what keeps NULL meaning exactly one thing — see below.
 *
 * NULL vs 'unknown' IS LOAD-BEARING. Every row written here gets a non-NULL
 * verdict AND version, so a NULL verdict means precisely "ingested before this
 * feature, never classified" and nothing else. 'unknown' is reserved for
 * classified-but-undeterminable. Collapsing the two re-creates the
 * EI-13472/WI-37419 failure — a real owner directive that simply is not
 * turn-stamped being read as fabricated — with database authority behind it.
 */
export function stampTurnProvenance(row: TurnRow): void {
  row.turn_origin_classifier_version = MACHINE_SURFACE_CATALOGUE_VERSION;

  if (row.speaker !== 'user') {
    row.turn_origin = null;
    row.turn_origin_verdict = 'not-user-turn';
    return;
  }

  // Head-anchored by construction: the classifier and its predicates apply
  // their own CLASSIFY_HEAD_CHARS bound, so passing the full text cannot widen
  // the match onto an owner's mid-body quote of an envelope.
  const { verdict, origin } = classifyRecordedTurn(row.text);
  // Keep historical dialog decisions discoverable in owner-candidate searches,
  // without affirming human authorship from the client's answer wording.
  if (verdict === 'unknown' && origin === 'unverified-dialog') {
    row.turn_origin = origin;
    row.turn_origin_verdict = UNENROLLED_ORIGIN_VERDICT;
    return;
  }
  // Native CLI file surfaces cannot enroll their own user rows.  A clean row
  // therefore proves neither owner authorship nor machine authorship: the
  // classifier's owner-typed residual is an unsafe database assertion here.
  // Preserve explicit envelope and catalogue verdicts, which have their own
  // authored/curated evidence, and make only the residual honest uncertainty.
  if (isUnenrolledFileRow(row) && verdict === 'owner-typed') {
    row.turn_origin = null;
    row.turn_origin_verdict = UNENROLLED_ORIGIN_VERDICT;
    return;
  }
  row.turn_origin = origin;
  row.turn_origin_verdict = verdict;
}

export async function insertTurns(sql: Sql, rows: TurnRow[]): Promise<number> {
  if (!rows.length) return 0;
  for (const row of rows) stampTurnProvenance(row);
  const candidates = rows.filter((row) => row.prompt_hash && row.ts && row.turn_origin_verdict === UNENROLLED_ORIGIN_VERDICT);
  if (candidates.length) {
    const sourceKinds = [...new Set(candidates.map((row) => row.source_kind))];
    const sessionIds = [...new Set(candidates.map((row) => row.session_id))];
    const promptHashes = [...new Set(candidates.map((row) => row.prompt_hash!))];
    const times = candidates.map((row) => Date.parse(row.ts!)).filter(Number.isFinite);
    if (times.length) {
      const from = new Date(Math.min(...times) - PROMPT_ORIGIN_MATCH_WINDOW_MS);
      const to = new Date(Math.max(...times) + PROMPT_ORIGIN_MATCH_WINDOW_MS);
      const stamps = await sql<PromptOriginStamp[]>`
        SELECT source_kind, session_id, prompt_hash, submitted_at, expires_at
          FROM harness_shared.session_prompt_origin_stamps
         WHERE workspace_id = ${activeWorkspaceId()}
           AND source_kind = ANY(${sql.array(sourceKinds)}::text[])
           AND session_id = ANY(${sql.array(sessionIds)}::text[])
           AND prompt_hash = ANY(${sql.array(promptHashes)}::text[])
           AND submitted_at BETWEEN ${from} AND ${to}
      `;
      // Expiry is checked per row inside correlatePromptOriginStamps, against
      // the turn's own timestamp. An `expires_at > now()` filter here made
      // the verdict depend on ingest lag (WI-10006568).
      correlatePromptOriginStamps(rows, stamps);
    }
  }
  // ON CONFLICT DO NOTHING: idempotent re-ingest (e.g. a reset offset) can
  // never duplicate — the PK is (workspace_id, source_kind, session_id, turn_idx).
  const r = await sql`
    INSERT INTO harness_shared.session_turns ${sql(
      rows as unknown as Record<string, unknown>[],
      'workspace_id', 'source_kind', 'session_id', 'turn_idx', 'ts',
      'owner', 'harness_slug', 'cwd', 'speaker', 'text',
      'turn_origin', 'turn_origin_verdict', 'turn_origin_classifier_version',
    )}
    ON CONFLICT DO NOTHING
  `;
  return r.count ?? rows.length;
}

interface PartRow {
  workspace_id: string;
  source_kind: string;
  session_id: string;
  part_idx: number;
  ts: string | null;
  owner: string | null;
  speaker: string;
  part_kind: string;
  tool_name: string | null;
  text: string;
}

/** The small projected-tool shape needed to resolve transcript tool names.
 * Keep this structural so pure tests can inject a catalog without importing
 * the agent-tools barrel (which has process-wide boot side effects). */
export interface SessionPartToolCatalogEntry {
  expose?: { mcp?: { name?: unknown } | null };
}

/**
 * Add one client spelling to the catalog-backed alias map. A separator
 * spelling can be ambiguous when two canonical names differ only by a
 * separator (for example `foo:bar_baz` and `foo_bar:baz`). In that case the
 * safe result is to leave the raw transcript name untouched rather than
 * silently attributing it to the wrong tool.
 */
function addSessionPartToolAlias(
  aliases: Map<string, string>,
  ambiguous: Set<string>,
  alias: string,
  canonical: string,
): void {
  if (ambiguous.has(alias)) return;
  const prior = aliases.get(alias);
  if (prior === undefined) {
    aliases.set(alias, canonical);
  } else if (prior !== canonical) {
    aliases.delete(alias);
    ambiguous.add(alias);
  }
}

/**
 * Resolve the client-mangled Papercusp MCP spellings persisted by Codex and
 * Claude (one each per server name in `PAPERCUSP_MCP_SERVER_NAMES`) to the
 * live projected catalog's canonical `group:verb` name.
 *
 * This is intentionally NOT `normalizeMcpName`: that helper is tolerant for
 * dispatch and can turn an unknown or separator-ambiguous transcript value
 * into a guessed tool. Session history is an evidence store, so only exact
 * aliases derived from currently projected tools are safe to rewrite. Native
 * names (`Bash`, `Read`), unknown wrappers, and ambiguous aliases remain
 * byte-for-byte unchanged.
 *
 * The optional catalog is a pure-test seam. Production callers omit it and
 * read the current process-global projected catalog at the write boundary so
 * newly installed tools do not require a second static allowlist.
 */
export function canonicalSessionPartToolName(
  name: string,
  catalog: readonly SessionPartToolCatalogEntry[] = listAllProjectedTools(),
): string {
  if (!name) return name;

  return sessionPartToolAliases(catalog).get(name) ?? name;
}

/** Build the aliases once per ingest chunk rather than once per part. */
function sessionPartToolAliases(
  catalog: readonly SessionPartToolCatalogEntry[],
): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const entry of catalog) {
    const canonical = entry.expose?.mcp?.name;
    // Plugin projections use their own namespaced forms; the aliases this
    // repair covers are the core `group:verb` MCP projections only.
    if (typeof canonical !== 'string' || !canonical.includes(':')) continue;

    // One Claude and one Codex spelling per server name the writers register
    // under (`papercusp` for spawned agents, `papercusp-su` for interactive su).
    // Claude's mcp wrapper removes `:` but preserves `-` in both server and
    // tool; Codex's sanitizer turns `-` into `_` in both before
    // parseCodexParts joins namespace and function with a dot.
    for (const server of PAPERCUSP_MCP_SERVER_NAMES) {
      addSessionPartToolAlias(
        aliases,
        ambiguous,
        `mcp__${server}__${canonical.replace(/:/g, '_')}`,
        canonical,
      );
      addSessionPartToolAlias(
        aliases,
        ambiguous,
        `mcp__${server.replace(/-/g, '_')}.${canonical.replace(/[:-]/g, '_')}`,
        canonical,
      );
    }
  }
  return aliases;
}

/** Build the session_turn_parts rows for one tick's parts, numbering them from
 *  the file's persisted part cursor. Pure — exported for tests. */
export function partRowsFrom(
  parts: ParsedPart[],
  base: { sourceKind: string; sessionId: string; owner: string | null; partCount: number },
  catalog?: readonly SessionPartToolCatalogEntry[],
): PartRow[] {
  const aliases = sessionPartToolAliases(catalog ?? listAllProjectedTools());
  return parts.map((p, i) => ({
    workspace_id: 'default',
    source_kind: base.sourceKind,
    session_id: p.sessionId ?? base.sessionId,
    part_idx: base.partCount + i,
    ts: p.ts ? p.ts.toISOString() : null,
    owner: base.owner,
    speaker: p.speaker,
    part_kind: p.partKind,
    tool_name: p.toolName == null ? null : aliases.get(p.toolName) ?? p.toolName,
    text: p.text,
  }));
}

/**
 * P-001 faithful-parts writer. Same ON CONFLICT DO NOTHING idempotency
 * contract as insertTurns (the PK is (workspace_id, source_kind, session_id,
 * part_idx)), so a reset offset re-ingests without duplicating.
 *
 * BEST-EFFORT BY CONTRACT, and that asymmetry is deliberate: the parts store
 * is a RENDER convenience, the turns store is the recall index. A parts write
 * that fails must cost the pane its fidelity for that window, never the
 * search corpus — so the caller catches and counts rather than aborting the
 * turn insert or holding back the byte_offset.
 */
async function insertParts(sql: Sql, rows: PartRow[]): Promise<number> {
  if (!rows.length) return 0;
  const r = await sql`
    INSERT INTO harness_shared.session_turn_parts ${sql(
      rows as unknown as Record<string, unknown>[],
      'workspace_id', 'source_kind', 'session_id', 'part_idx', 'ts',
      'owner', 'speaker', 'part_kind', 'tool_name', 'text',
    )}
    ON CONFLICT DO NOTHING
  `;
  return r.count ?? rows.length;
}

/** Repair rows ingested before a managed Codex home's owner stamp was wired
 * into the adapter. One bulk UPDATE per sweep avoids the historical
 * per-transcript-query trap while making owner-filtered session reads correct
 * without waiting for another turn to be appended. */
async function backfillSessionOwners(
  sql: Sql,
  sourceKind: SourceKind,
  ownersBySession: Map<string, string>,
  onInput: (inputSha256: string) => void,
): Promise<number> {
  if (!ownersBySession.size) return 0;
  const sessionIds = [...ownersBySession.keys()];
  const owners = sessionIds.map((sessionId) => ownersBySession.get(sessionId)!);
  onInput(createHash('sha256').update(JSON.stringify([sessionIds, owners])).digest('hex'));
  const repaired = await sql`
    UPDATE harness_shared.session_turns AS turns
       SET owner = resolved.owner
      FROM UNNEST(${sql.array(sessionIds)}::text[], ${sql.array(owners)}::text[])
           AS resolved(session_id, owner)
     WHERE turns.workspace_id = 'default'
       AND turns.source_kind = ${sourceKind}
       AND turns.session_id = resolved.session_id
       AND turns.owner IS DISTINCT FROM resolved.owner
  `;
  return repaired.count ?? 0;
}

/** Repair faithful-part owner stamps only for Claude ids whose candidate path
 * conflicts with the launcher's birth index. Most sessions never enter this
 * UPDATE, preserving the existing no-op cost for ordinary sweeps. */
async function backfillClaudePartOwners(
  sql: Sql,
  ownersBySession: Map<string, string>,
  onInput: (inputSha256: string) => void,
): Promise<number> {
  if (!ownersBySession.size) return 0;
  const sessionIds = [...ownersBySession.keys()];
  const owners = sessionIds.map((sessionId) => ownersBySession.get(sessionId)!);
  onInput(createHash('sha256').update(JSON.stringify([sessionIds, owners])).digest('hex'));
  const repaired = await sql`
    UPDATE harness_shared.session_turn_parts AS parts
       SET owner = resolved.owner
      FROM UNNEST(${sql.array(sessionIds)}::text[], ${sql.array(owners)}::text[])
           AS resolved(session_id, owner)
     WHERE parts.workspace_id = 'default'
       AND parts.source_kind = 'claude'
       AND parts.session_id = resolved.session_id
       AND parts.owner IS DISTINCT FROM resolved.owner
  `;
  return repaired.count ?? 0;
}

/**
 * Resolve managed OMP transcript homes to coordination owners in one query per
 * adapter sweep. The path's adv_sessions id is authoritative; joining by the
 * native OMP thread id would miss the period before lazy thread-linking runs.
 * Shared ~/.omp files never enter this map and remain deliberately unowned.
 */
async function loadOmpSessionOwners(
  sql: Sql,
  advSessionIds: Iterable<number>,
): Promise<Map<number, string>> {
  const ids = [...new Set([...advSessionIds].filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return new Map();
  const rows = await sql<Array<{ id: string | number; coord_owner_id: string | null }>>`
    SELECT id, coord_owner_id
      FROM harness_shared.adv_sessions
     WHERE workspace_id = ${activeWorkspaceId()}
       AND mode = 'omp'
       AND coord_owner_id IS NOT NULL
       AND id = ANY(${sql.array(ids)}::bigint[])
  `;
  return new Map(
    rows
      .filter((row) => typeof row.coord_owner_id === 'string' && row.coord_owner_id.trim())
      .map((row) => [Number(row.id), row.coord_owner_id!.trim()]),
  );
}

/** Repair the launch identity that Codex cannot provide at bootstrap time.
 * `writeSuCodexHome` creates the isolated home before Codex creates its native
 * rollout UUID, so the durable join is discovered later from
 * `<home>/sessions/.../rollout-...-<uuid>.jsonl`. This update deliberately
 * changes metadata only: ended/started/exit fields are lifecycle evidence and
 * must remain untouched for paused-session interval queries. */
async function backfillCodexAdvSessions(
  sql: Sql,
  metadataByAdvSession: Map<number, CodexAdvSessionMetadata>,
): Promise<number> {
  if (!metadataByAdvSession.size) return 0;
  const metadata = [...metadataByAdvSession.values()];
  const ids = metadata.map((m) => String(m.advSessionId));
  const sessionIds = metadata.map((m) => m.sessionId);
  // Empty strings become NULL in the CTE so a missing/reaped config never
  // overwrites a launch-time explicit value (or manufactures a blank value).
  const models = metadata.map((m) => m.model ?? '');
  const efforts = metadata.map((m) => m.effort ?? '');
  const rows = await sql<{ id: number }[]>`
    WITH resolved (id, session_id, model, effort) AS (
      SELECT id, session_id, NULLIF(model, ''), NULLIF(effort, '')
        FROM UNNEST(
          ${sql.array(ids)}::bigint[],
          ${sql.array(sessionIds)}::text[],
          ${sql.array(models)}::text[],
          ${sql.array(efforts)}::text[]
        ) AS candidate(id, session_id, model, effort)
    )
    UPDATE harness_shared.adv_sessions AS sessions
       SET session_id = COALESCE(sessions.session_id, resolved.session_id),
           launch_spec = CASE
             WHEN sessions.launch_spec IS NULL
              AND resolved.model IS NULL
              AND resolved.effort IS NULL
             THEN NULL
             ELSE COALESCE(sessions.launch_spec, '{}'::jsonb)
               || CASE
                    WHEN resolved.model IS NOT NULL
                     AND sessions.launch_spec->>'model' IS NULL
                    THEN jsonb_build_object('model', resolved.model)
                    ELSE '{}'::jsonb
                  END
               || CASE
                    WHEN resolved.effort IS NOT NULL
                     AND sessions.launch_spec->>'effort' IS NULL
                    THEN jsonb_build_object('effort', resolved.effort)
                    ELSE '{}'::jsonb
                  END
           END
      FROM resolved
     WHERE sessions.workspace_id = ${activeWorkspaceId()}
       AND sessions.id = resolved.id
       AND (
         sessions.session_id IS NULL
         OR (resolved.model IS NOT NULL AND sessions.launch_spec->>'model' IS NULL)
         OR (resolved.effort IS NOT NULL AND sessions.launch_spec->>'effort' IS NULL)
       )
    RETURNING sessions.id
  `;
  return rows.length;
}

/**
 * Most rows rewritten per statement. This is what bounds how long the pass
 * holds row locks (WI-10006752).
 *
 * Since migration 1405 none of the columns this pass writes is indexed
 * (WI-10006788), so a rewrite whose new tuple fits on the same heap page is a
 * HOT update and touches no index. When the page is full Postgres falls back to
 * a non-HOT update, which re-inserts into every session_turns index, the
 * 5.5 GB HNSW included. Measured 2026-10-06 while every update was non-HOT:
 * 100-row statements averaged 84.6 s (~700 shared blocks read per row), and
 * 5,000-row statements averaged 124.7 s with a 711 s maximum. This cap keeps
 * that fallback bounded.
 */
export const PROVENANCE_BACKFILL_BATCH = 100;

/**
 * Heap pages one window examines. The pass walks session_turns in physical
 * order with a TID range scan, so a window reads at most this many pages,
 * whatever the backlog looks like.
 */
export const PROVENANCE_LAP_WINDOW_PAGES = 64;

/**
 * Most heap pages one call walks while looking for stale rows. A call stops at
 * the first window that yields rows, so this only bounds the clean stretches.
 */
export const PROVENANCE_PASS_PAGE_BUDGET = 1_024;

/**
 * How long a lap that found nothing stale stays authoritative. Rows are stamped
 * at insert (migration 794), so new staleness only appears when
 * MACHINE_SURFACE_CATALOGUE_VERSION changes, and that restarts the lap. The
 * daily re-walk is a backstop for an insert path that skips the stamp.
 */
export const PROVENANCE_CLEAN_LAP_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Progress of one walk over the session_turns heap ("lap").
 */
export interface ProvenanceLap {
  /** Catalogue version this lap re-derives to; a different one restarts it. */
  version: number | null;
  /** First heap page not yet walked. */
  nextPage: number;
  /** Relation size in pages when the lap started. */
  endPage: number;
  /** Rows found needing a new verdict so far this lap, written or not. */
  needed: number;
  /** When a whole lap found nothing to change; null while a lap is in progress. */
  cleanAt: number | null;
}

export function newProvenanceLap(): ProvenanceLap {
  return { version: null, nextPage: 0, endPage: 0, needed: 0, cleanAt: null };
}

/**
 * This process's lap. It lives in memory on purpose: it is a progress hint
 * that nothing depends on for correctness. The cost of losing it is one lap per
 * restart: a sequential read of the heap (~190,000 pages, ~1.5 GB on
 * 2026-10-06) plus re-classifying the rows below the current version, spread
 * over ~15 ticks. Two hosts walking at once only duplicate that work, because
 * every write is claimed SKIP LOCKED and guarded on the values it read.
 */
const processProvenanceLap = pinModuleState<ProvenanceLap>(
  '@papercusp/operator-core.session-ingest.provenance-lap',
  newProvenanceLap,
);

export interface ProvenanceBackfillResult {
  scanned: number;
  updated: number;
  /** True until a whole lap over the heap claims nothing. The caller can keep
   *  sweeping, or simply wait for the next tick. */
  more: boolean;
}

/**
 * Re-derive `turn_origin*` for rows the CURRENT catalogue has not classified.
 *
 * TWO POPULATIONS, ONE QUERY (migration 794):
 *   * version IS NULL — ingested before this feature existed.
 *   * version < CURRENT — classified by an older catalogue, i.e. possibly
 *     stamped `owner-typed` only because the pattern that would have caught it
 *     had not been written yet.
 *
 * The second is the one that makes this sweep permanent rather than a one-off
 * migration chore. `owner-typed` is the RESIDUAL of a versioned deny-list, so
 * every pattern added to the catalogue silently invalidates some past verdicts;
 * without a re-derivation lane those rows keep asserting the owner said
 * something he did not, with a stored column's authority behind it. Bumping
 * MACHINE_SURFACE_CATALOGUE_VERSION is what makes them findable here.
 *
 * Only the HEAD is fetched — the classifier bounds itself to
 * CLASSIFY_HEAD_CHARS anyway, so pulling whole turn bodies (up to 8k each)
 * would be pure bandwidth.
 *
 * FIND THE BACKLOG BY WALKING THE HEAP, NOT BY AN INDEX (WI-10006788). The
 * pass used to take `ORDER BY turn_origin_classifier_version ... LIMIT n` off
 * an index on that column. That index is what made every rewrite non-HOT:
 * Postgres can only update a row in place when no indexed column changes, so
 * each rewritten row inserted a new entry into all session_turns indexes,
 * the 5.5 GB HNSW included (measured 2026-10-06: ~700 shared blocks read per
 * row, 84.6 s per 100-row statement, 0.3% of updates HOT). Migration 1405
 * dropped the index. The pass now walks the heap in physical order, one window
 * of PROVENANCE_LAP_WINDOW_PAGES pages at a time, with a TID range scan, and
 * keeps its place in a ProvenanceLap. Every page is visited once per lap, so
 * NULL rows and stale-version rows are both reached in a bounded time and
 * neither population can starve the other. (The old ORDER BY existed because
 * a plain LIMIT had served 20,000 NULL rows while 2,435 stale-version rows
 * waited.) A lap that finds nothing to change marks the table clean, and the
 * pass then idles until the catalogue version changes or
 * PROVENANCE_CLEAN_LAP_TTL_MS passes.
 *
 * WRITE ONLY WHAT CHANGES (WI-10006788). Every stale row in a window is
 * re-classified, but a row is rewritten only when its verdict or origin
 * actually changes, or when it has never been classified (version NULL).
 * Measured 2026-10-06 on a 5,069-row sample of the 1,347,175 rows below
 * catalogue 7: 11 (0.22%) re-derive to a different verdict. Rewriting the
 * other 99.8% only to bump the version cost one full-index row rewrite each.
 * So turn_origin_classifier_version records the catalogue that last WROTE the
 * verdict, and a row a newer catalogue left unchanged keeps its older number.
 * Such rows are re-classified, without being written, on every lap.
 *
 * CLAIM, DON'T QUEUE (WI-10006752). Rows to rewrite are claimed with
 * `FOR NO KEY UPDATE SKIP LOCKED`, guarded on the exact values that were
 * classified, and rewritten in the same statement. A concurrent run of this
 * pass (an overlapping tick, a second host) or any other writer holding one of
 * these rows is stepped around, never waited on, and a row that changed since
 * it was read is left for the next lap. Without the claim the second of two
 * runs queued behind the first one's row locks until lock_timeout aborted it:
 * measured 2026-10-06, every one of 25 sampled session_turns lock waits was
 * this UPDATE waiting on itself. A skipped row still counts as needed, so that
 * lap is not clean and the next one picks the row up.
 *
 * `lap` defaults to this process's lap. Tests pass their own
 * (`newProvenanceLap()`) to start from page 0 regardless of earlier calls.
 */
export async function backfillTurnProvenanceOnce(
  sql: Sql,
  limit = PROVENANCE_BACKFILL_BATCH,
  lap: ProvenanceLap = processProvenanceLap,
  now: () => number = Date.now,
): Promise<ProvenanceBackfillResult> {
  const version = MACHINE_SURFACE_CATALOGUE_VERSION;
  if (lap.version !== version) Object.assign(lap, newProvenanceLap(), { version });
  if (lap.cleanAt !== null) {
    if (now() - lap.cleanAt < PROVENANCE_CLEAN_LAP_TTL_MS) return { scanned: 0, updated: 0, more: false };
    Object.assign(lap, newProvenanceLap(), { version });
  }

  let pagesWalked = 0;
  while (pagesWalked < PROVENANCE_PASS_PAGE_BUDGET) {
    if (lap.nextPage >= lap.endPage) {
      // A lap just ended (or none has started). A lap that found nothing to
      // change proves the table clean. One that found rows is walked again,
      // because a row it had to skip (held by another writer, or changed after
      // it was read) still carries its old verdict.
      if (lap.endPage > 0 && lap.needed === 0) {
        lap.cleanAt = now();
        return { scanned: 0, updated: 0, more: false };
      }
      lap.nextPage = 0;
      lap.needed = 0;
      lap.endPage = await sessionTurnsHeapPages(sql);
      if (lap.endPage === 0) {
        lap.cleanAt = now();
        return { scanned: 0, updated: 0, more: false };
      }
    }
    const fromPage = lap.nextPage;
    const toPage = Math.min(fromPage + PROVENANCE_LAP_WINDOW_PAGES, lap.endPage);
    const window = await rederiveProvenanceWindow(sql, limit, fromPage, toPage);
    lap.needed += window.needed;
    lap.nextPage = toPage;
    pagesWalked += toPage - fromPage;
    if (window.examined > 0) return { scanned: window.examined, updated: window.updated, more: true };
  }
  return { scanned: 0, updated: 0, more: true };
}

/** Pages in session_turns' main fork: where a lap ends. */
async function sessionTurnsHeapPages(sql: Sql): Promise<number> {
  const [row] = await sql<Array<{ pages: number }>>`
    SELECT (pg_relation_size('harness_shared.session_turns')
            / current_setting('block_size')::int)::int AS pages
  `;
  return row?.pages ?? 0;
}

/**
 * Re-classify every stale row on heap pages [fromPage, toPage) and rewrite the
 * ones whose verdict changes, `limit` rows per statement. The read takes no
 * locks; only the rewrite claims rows (see writeProvenanceChanges).
 */
/** Enough of a turn's END to see a whole-prompt paste's closing tag (the id
 * is at most 64 chars) plus trailing whitespace. Mirrors TURN_ORIGIN_TAIL_CHARS. */
export const PROVENANCE_PASTE_TAIL_CHARS = 256;

async function rederiveProvenanceWindow(
  sql: Sql,
  limit: number,
  fromPage: number,
  toPage: number,
): Promise<{ examined: number; needed: number; updated: number }> {
  const rows = await sql<
    Array<{
      workspace_id: string;
      source_kind: string;
      session_id: string;
      turn_idx: number;
      speaker: string;
      head: string | null;
      tail: string | null;
      turn_origin: string | null;
      turn_origin_verdict: string | null;
      version: number | null;
    }>
  >`
    SELECT workspace_id, source_kind, session_id, turn_idx, speaker,
           left(text, ${CLASSIFY_HEAD_CHARS}) AS head,
           right(text, ${PROVENANCE_PASTE_TAIL_CHARS}) AS tail,
           turn_origin, turn_origin_verdict,
           turn_origin_classifier_version AS version
      FROM harness_shared.session_turns
     -- A TID range scan: reads exactly the pages [fromPage, toPage).
     WHERE ctid >= ${`(${fromPage},0)`}::tid
       AND ctid < ${`(${toPage},0)`}::tid
       AND (turn_origin_classifier_version IS NULL
            OR turn_origin_classifier_version < ${MACHINE_SURFACE_CATALOGUE_VERSION})
  `;
  if (!rows.length) return { examined: 0, needed: 0, updated: 0 };

  const changes: ProvenanceChange[] = [];
  for (const r of rows) {
    // Reuse the ONE stamp path rather than re-deriving the rules here — a
    // second copy of this logic is how the four divergent classifiers arose.
    // The head alone cuts off a long paste's closing tag, so a paste-wrapped
    // machine envelope (every PTY-typed kickoff/wake) fell to the owner-typed
    // residual and was stored `unenrolled-origin` (WI-6554700010009707). The
    // tail lets the shared helper restore a WHOLE-prompt paste exactly as the
    // full-text ingest path sees it; owner words around a paste still fail it.
    const staged = {
      source_kind: r.source_kind,
      speaker: r.speaker,
      text: closeTruncatedWholePaste(r.head ?? '', r.tail),
    } as TurnRow;
    stampTurnProvenance(staged);

    // Only the insert-time exact hook correlation writes this identity.
    // Preserve that positive evidence after ephemeral receipt expiry, but
    // let every current machine/envelope/speaker verdict win. Untagged old
    // owner-typed residuals still downgrade, so this cannot retroactively
    // authenticate historical rows from clean text alone.
    if (
      staged.turn_origin_verdict === UNENROLLED_ORIGIN_VERDICT &&
      r.turn_origin_verdict === 'owner-typed' &&
      r.turn_origin === HOOK_AUTHENTICATED_PROMPT_ORIGIN
    ) {
      staged.turn_origin = HOOK_AUTHENTICATED_PROMPT_ORIGIN;
      staged.turn_origin_verdict = 'owner-typed';
    }

    const origin = staged.turn_origin ?? null;
    const verdict = staged.turn_origin_verdict!;
    // An unchanged verdict is not written (see the docstring above
    // backfillTurnProvenanceOnce). A NULL version always is: that row has never
    // been classified, and writing it is what takes it out of the backlog.
    if (r.version !== null && origin === (r.turn_origin ?? null) && verdict === r.turn_origin_verdict) {
      continue;
    }
    changes.push({
      workspace_id: r.workspace_id,
      source_kind: r.source_kind,
      session_id: r.session_id,
      turn_idx: r.turn_idx,
      old_origin: r.turn_origin ?? null,
      old_verdict: r.turn_origin_verdict ?? null,
      old_version: r.version,
      turn_origin: origin,
      turn_origin_verdict: verdict,
    });
  }

  let updated = 0;
  for (let i = 0; i < changes.length; i += limit) {
    updated += await writeProvenanceChanges(sql, changes.slice(i, i + limit));
  }
  return { examined: rows.length, needed: changes.length, updated };
}

interface ProvenanceChange {
  workspace_id: string;
  source_kind: string;
  session_id: string;
  turn_idx: number;
  old_origin: string | null;
  old_verdict: string | null;
  old_version: number | null;
  turn_origin: string | null;
  turn_origin_verdict: string;
}

/**
 * Rewrite `changes` in one statement. Each row is claimed
 * `FOR NO KEY UPDATE SKIP LOCKED` and only if it still holds the values it was
 * classified from, so a row another writer holds or has changed is skipped,
 * never waited on and never overwritten. Returns the number of rows written.
 */
async function writeProvenanceChanges(sql: Sql, changes: ProvenanceChange[]): Promise<number> {
  const col = <K extends keyof ProvenanceChange>(k: K) => changes.map((c) => c[k]);
  const res = await sql`
    WITH wanted AS (
      SELECT * FROM UNNEST(
        ${sql.array(col('workspace_id'))}::text[], ${sql.array(col('source_kind'))}::text[],
        ${sql.array(col('session_id'))}::text[], ${sql.array(col('turn_idx'))}::int[],
        ${sql.array(col('old_origin') as string[])}::text[],
        ${sql.array(col('old_verdict') as string[])}::text[],
        ${sql.array(col('old_version') as number[])}::int[],
        ${sql.array(col('turn_origin') as string[])}::text[],
        ${sql.array(col('turn_origin_verdict'))}::text[]
      ) AS w(workspace_id, source_kind, session_id, turn_idx, old_origin, old_verdict,
             old_version, turn_origin, turn_origin_verdict)
    ), claimed AS (
      SELECT t.workspace_id, t.source_kind, t.session_id, t.turn_idx,
             w.turn_origin, w.turn_origin_verdict
        FROM harness_shared.session_turns AS t
        JOIN wanted AS w
          ON t.workspace_id = w.workspace_id AND t.source_kind = w.source_kind
         AND t.session_id = w.session_id AND t.turn_idx = w.turn_idx
       WHERE t.turn_origin IS NOT DISTINCT FROM w.old_origin
         AND t.turn_origin_verdict IS NOT DISTINCT FROM w.old_verdict
         AND t.turn_origin_classifier_version IS NOT DISTINCT FROM w.old_version
         FOR NO KEY UPDATE OF t SKIP LOCKED
    )
    UPDATE harness_shared.session_turns AS turns
       SET turn_origin = claimed.turn_origin,
           turn_origin_verdict = claimed.turn_origin_verdict,
           turn_origin_classifier_version = ${MACHINE_SURFACE_CATALOGUE_VERSION}
      FROM claimed
     WHERE turns.workspace_id = claimed.workspace_id
       AND turns.source_kind = claimed.source_kind
       AND turns.session_id = claimed.session_id
       AND turns.turn_idx = claimed.turn_idx
  `;
  return res.count ?? 0;
}

/**
 * Upper bound on sweep passes per tick. One pass is PROVENANCE_BACKFILL_BATCH
 * rows, so this caps a tick's write volume at 20,000 rows, the same as the old
 * 4 × 5,000, while each statement stays short.
 */
export const PROVENANCE_BACKFILL_PASSES_PER_TICK = 200;

/**
 * Wall-clock budget for one tick's passes (WI-10006752). The tick fires every
 * 5 minutes; a tick that outlives its interval overlaps the next one, which
 * doubles the write load on a table whose every update is non-HOT. Measured
 * 2026-10-06 at 4 × 5,000 rows: one statement alone averaged 124.7 s, so a
 * tick routinely ran past the next fire. The budget is checked between passes,
 * so a tick ends at most one (short) pass after it.
 */
export const PROVENANCE_BACKFILL_TICK_BUDGET_MS = 120_000;

/**
 * Run `pass` until the backlog is drained, `maxPasses` is reached, or
 * `budgetMs` has elapsed (checked between passes). Exported for tests.
 */
export async function runProvenancePasses(
  pass: () => Promise<ProvenanceBackfillResult>,
  opts: { maxPasses: number; budgetMs: number; now?: () => number },
): Promise<ProvenanceBackfillResult & { passes: number }> {
  const now = opts.now ?? Date.now;
  const started = now();
  let scanned = 0;
  let updated = 0;
  let more = false;
  let passes = 0;
  while (passes < opts.maxPasses) {
    const r = await pass();
    passes += 1;
    scanned += r.scanned;
    updated += r.updated;
    more = r.more;
    if (!r.more || now() - started >= opts.budgetMs) break;
  }
  return { scanned, updated, more, passes };
}

/**
 * Run the provenance re-derivation lane for one tick.
 *
 * WHY THIS NO-ARG WRAPPER EXISTS. `backfillTurnProvenanceOnce` takes a `sql`
 * handle and does exactly one batch, which makes it testable but not directly
 * schedulable. It sat EXPORTED AND UNCALLED — zero production call sites — so
 * the re-derivation lane its own docstring describes as "permanent rather than
 * a one-off migration chore" never ran at all, and every
 * MACHINE_SURFACE_CATALOGUE_VERSION bump silently STRANDED rows instead of
 * repairing them (WI-38135). This is the schedulable entry point; keep the tick
 * pointed at it and `no-uncalled-provenance-backfill.test.ts` will hold the
 * call site in place.
 */
export async function runTurnProvenanceBackfillOnce(): Promise<ProvenanceBackfillResult> {
  const { sql } = getOrgPg();
  const { scanned, updated, more } = await runProvenancePasses(
    () => backfillTurnProvenanceOnce(sql),
    { maxPasses: PROVENANCE_BACKFILL_PASSES_PER_TICK, budgetMs: PROVENANCE_BACKFILL_TICK_BUDGET_MS },
  );
  // After the re-derivation above, so rows it just moved to the current
  // catalogue version are eligible for their hook stamp in the same tick.
  const recorrelated = await recorrelatePromptOriginStampsOnce(sql);
  return {
    scanned: scanned + recorrelated.scanned,
    updated: updated + recorrelated.promoted,
    more: more || recorrelated.more,
  };
}

/**
 * Stamp/turn pairs examined per recorrelation tick. Separate from
 * PROVENANCE_BACKFILL_BATCH since WI-10006752 shrank that one to 100: this pass
 * runs once per tick and only rewrites the rows it promotes, so it can take a
 * larger window, but its UPDATE still holds row locks on every promoted
 * non-HOT row until it commits, so it stays bounded.
 */
export const PROMPT_ORIGIN_RECORRELATE_BATCH = 500;

export interface PromptOriginRecorrelationResult {
  /** Distinct unenrolled rows the prefilter paired with a stamp. */
  scanned: number;
  /** Rows the shared correlation rule upgraded to owner-typed. */
  promoted: number;
  more: boolean;
}

/**
 * Re-apply the hook-stamp correlation to rows ALREADY stored as
 * `unenrolled-origin` (WI-10006568).
 *
 * insertTurns correlates once, at insert, and writes ON CONFLICT DO NOTHING,
 * so a row that missed its stamp was never revisited: ingest that ran before
 * the hook's stamp landed, ingest that ran more than one stamp TTL late (the
 * old `expires_at > now()` filter), and every row ingested before correlation
 * shipped. Measured 2026-10-06: 1,508 owner turns in 648 sessions, including
 * owner directive #1459, which then failed plans:audit's owner-provenance check.
 *
 * The SQL is a PREFILTER only. Its normalised-text hash keeps permanent
 * non-matches out of the LIMIT window so they cannot starve real matches.
 * correlatePromptOriginStamps, the same function insertTurns uses, decides
 * every upgrade: same session, same hash, ±PROMPT_ORIGIN_MATCH_WINDOW_MS,
 * turn-anchored expiry, one row per stamp. The hash is recomputed from the
 * STORED text, so a row whose stored text differs from the raw prompt (for
 * example a truncated body) stays unmatched. This pass can miss a row; it
 * cannot attribute text the owner did not type.
 *
 * OLDER-VERSION ROWS ARE ELIGIBLE (WI-10008182). The provenance backfill does
 * not rewrite a row whose verdict a newer catalogue leaves unchanged
 * (WI-10006788), so an `unenrolled-origin` row keeps the version that first
 * wrote it, indefinitely. Requiring version == current here stranded every such
 * owner turn: owner directive #1594 sat at v6 and failed plans:audit. Each
 * candidate is therefore re-derived with the CURRENT catalogue
 * (stampTurnProvenance) before correlation, so a row the current catalogue
 * calls machine or agent output is never promoted, and a promoted row is
 * written at the current version. Rows a NEWER catalogue wrote are left to a
 * build that carries it.
 */
export async function recorrelatePromptOriginStampsOnce(
  sql: Sql,
  limit = PROMPT_ORIGIN_RECORRELATE_BATCH,
): Promise<PromptOriginRecorrelationResult> {
  const workspace = activeWorkspaceId();
  const windowMs = PROMPT_ORIGIN_MATCH_WINDOW_MS;
  const pairs = await sql<
    Array<{
      workspace_id: string;
      source_kind: string;
      session_id: string;
      turn_idx: number;
      ts: Date | string;
      speaker: string;
      text: string;
      version: number;
      prompt_hash: string;
      submitted_at: Date | string;
      expires_at: Date | string;
    }>
  >`
    SELECT turns.workspace_id, turns.source_kind, turns.session_id, turns.turn_idx,
           turns.ts, turns.speaker, turns.text,
           turns.turn_origin_classifier_version AS version,
           stamps.prompt_hash, stamps.submitted_at, stamps.expires_at
      FROM harness_shared.session_prompt_origin_stamps AS stamps
      JOIN harness_shared.session_turns AS turns
        ON turns.workspace_id IN ('default', ${workspace})
       AND turns.source_kind = stamps.source_kind
       AND turns.session_id = stamps.session_id
       AND turns.ts BETWEEN stamps.submitted_at - (${windowMs}::int * interval '1 millisecond')
                        AND stamps.submitted_at + (${windowMs}::int * interval '1 millisecond')
     WHERE stamps.workspace_id = ${workspace}
       AND turns.speaker = 'user'
       AND turns.turn_origin_verdict = ${UNENROLLED_ORIGIN_VERDICT}
       -- Older versions included: the verdict is re-derived below (WI-10008182).
       AND turns.turn_origin_classifier_version <= ${MACHINE_SURFACE_CATALOGUE_VERSION}
       -- Mirrors promptOriginHash (CRLF -> LF, trim). Prefilter only; a drift
       -- between the two makes rows MISS, which the integration test catches.
       AND encode(sha256(convert_to(
             regexp_replace(regexp_replace(turns.text, E'\\r\\n?', E'\\n', 'g'), '^\\s+|\\s+$', '', 'g'),
             'UTF8')), 'hex') = stamps.prompt_hash
       -- A stamp already spent on a hook-authenticated row stays spent. A
       -- promoted row spends only the stamp NEAREST to it (WI-10008183): an
       -- identical prompt the owner repeated within the window has its own
       -- stamp, which the earlier promoted turn must not mask. Prefilter only;
       -- replayPromptOriginClusters decides.
       AND NOT EXISTS (
         SELECT 1
           FROM harness_shared.session_turns AS spent
          WHERE spent.workspace_id = turns.workspace_id
            AND spent.source_kind = stamps.source_kind
            AND spent.session_id = stamps.session_id
            AND spent.turn_origin = ${HOOK_AUTHENTICATED_PROMPT_ORIGIN}
            AND spent.ts BETWEEN stamps.submitted_at - (${windowMs}::int * interval '1 millisecond')
                             AND stamps.submitted_at + (${windowMs}::int * interval '1 millisecond')
            AND encode(sha256(convert_to(
                  regexp_replace(regexp_replace(spent.text, E'\\r\\n?', E'\\n', 'g'), '^\\s+|\\s+$', '', 'g'),
                  'UTF8')), 'hex') = stamps.prompt_hash
            AND NOT EXISTS (
              SELECT 1
                FROM harness_shared.session_prompt_origin_stamps AS closer
               WHERE closer.workspace_id = stamps.workspace_id
                 AND closer.source_kind = stamps.source_kind
                 AND closer.session_id = stamps.session_id
                 AND closer.prompt_hash = stamps.prompt_hash
                 AND abs(extract(epoch FROM (spent.ts - closer.submitted_at)))
                     < abs(extract(epoch FROM (spent.ts - stamps.submitted_at)))
            )
       )
     ORDER BY turns.ts, turns.session_id, turns.turn_idx
     LIMIT ${limit}
  `;
  if (!pairs.length) return { scanned: 0, promoted: 0, more: false };

  const rowsByKey = new Map<string, TurnRow>();
  const storedVersion = new Map<TurnRow, number>();
  for (const p of pairs) {
    const rowKey = [p.workspace_id, p.source_kind, p.session_id, p.turn_idx].join('\u0000');
    if (!rowsByKey.has(rowKey)) {
      const row: TurnRow = {
        workspace_id: p.workspace_id,
        source_kind: p.source_kind,
        session_id: p.session_id,
        turn_idx: Number(p.turn_idx),
        ts: new Date(p.ts).toISOString(),
        owner: null,
        harness_slug: null,
        cwd: null,
        speaker: p.speaker,
        text: p.text,
        prompt_hash: promptOriginHash(p.text),
      };
      // The stored verdict may come from an older catalogue. Judge the row with
      // the current one; correlation then only considers it if the current
      // catalogue still finds no machine or agent origin.
      stampTurnProvenance(row);
      rowsByKey.set(rowKey, row);
      storedVersion.set(row, Number(p.version));
    }
  }
  const rows = [...rowsByKey.values()];
  await replayPromptOriginClusters(sql, workspace, rows);
  const promoted = rows.filter((row) => row.turn_origin === HOOK_AUTHENTICATED_PROMPT_ORIGIN);
  if (promoted.length) {
    await sql`
      UPDATE harness_shared.session_turns AS turns
         SET turn_origin = ${HOOK_AUTHENTICATED_PROMPT_ORIGIN},
             turn_origin_verdict = 'owner-typed',
             turn_origin_classifier_version = ${MACHINE_SURFACE_CATALOGUE_VERSION}
        FROM UNNEST(
               ${sql.array(promoted.map((row) => row.workspace_id))}::text[],
               ${sql.array(promoted.map((row) => row.source_kind))}::text[],
               ${sql.array(promoted.map((row) => row.session_id))}::text[],
               ${sql.array(promoted.map((row) => row.turn_idx))}::int[],
               ${sql.array(promoted.map((row) => storedVersion.get(row)!))}::int[]
             ) AS hit(workspace_id, source_kind, session_id, turn_idx, version)
       WHERE turns.workspace_id = hit.workspace_id
         AND turns.source_kind = hit.source_kind
         AND turns.session_id = hit.session_id
         AND turns.turn_idx = hit.turn_idx
         -- Only the exact state that was judged: a row another writer
         -- re-derived in the meantime is left for the next tick.
         AND turns.turn_origin_verdict = ${UNENROLLED_ORIGIN_VERDICT}
         AND turns.turn_origin_classifier_version = hit.version
    `;
  }
  return { scanned: rows.length, promoted: promoted.length, more: pairs.length === limit };
}

/**
 * Decide recorrelation per (source, session, prompt hash) cluster
 * (WI-10008183).
 *
 * The SQL prefilter cannot know which stamp an already-promoted row consumed,
 * so it can pass a candidate whose only stamp really belongs to a promoted
 * sibling. Here the cluster is replayed through correlatePromptOriginStamps,
 * the same one-row-per-stamp rule insertTurns uses, with the already-promoted
 * rows passed as `priority`: they keep stamps first, and candidates receive
 * only stamps the promoted rows can do without. If
 * the promoted rows alone already over-subscribe the cluster's stamps, no
 * candidate in it is promoted. The pass may still miss a row; it never
 * promotes more rows in a cluster than the hook stamped.
 *
 * Mutates `rows`: a candidate that loses keeps its unenrolled verdict.
 */
async function replayPromptOriginClusters(sql: Sql, workspace: string, rows: TurnRow[]): Promise<void> {
  const clusterKey = (sourceKind: string, sessionId: string, hash: string) =>
    [sourceKind, sessionId, hash].join('\u0000');
  const candidatesByCluster = new Map<string, TurnRow[]>();
  for (const row of rows) {
    if (row.turn_origin_verdict !== UNENROLLED_ORIGIN_VERDICT || !row.prompt_hash) continue;
    const key = clusterKey(row.source_kind, row.session_id, row.prompt_hash);
    const list = candidatesByCluster.get(key) ?? [];
    list.push(row);
    candidatesByCluster.set(key, list);
  }
  if (!candidatesByCluster.size) return;
  const clusters = [...candidatesByCluster.values()].map((list) => list[0]);
  const kinds = sql.array(clusters.map((row) => row.source_kind));
  const sessions = sql.array(clusters.map((row) => row.session_id));
  const hashes = sql.array(clusters.map((row) => row.prompt_hash!));
  const windowMs = PROMPT_ORIGIN_MATCH_WINDOW_MS;
  const stamps = await sql<PromptOriginStamp[]>`
    SELECT s.source_kind, s.session_id, s.prompt_hash, s.submitted_at, s.expires_at
      FROM UNNEST(${kinds}::text[], ${sessions}::text[], ${hashes}::text[]) AS c(source_kind, session_id, prompt_hash)
      JOIN harness_shared.session_prompt_origin_stamps AS s
        ON s.workspace_id = ${workspace}
       AND s.source_kind = c.source_kind AND s.session_id = c.session_id AND s.prompt_hash = c.prompt_hash
  `;
  const spent = await sql<Array<{ source_kind: string; session_id: string; turn_idx: number; ts: Date | string; prompt_hash: string }>>`
    SELECT DISTINCT t.source_kind, t.session_id, t.turn_idx, t.ts, c.prompt_hash
      FROM UNNEST(${kinds}::text[], ${sessions}::text[], ${hashes}::text[]) AS c(source_kind, session_id, prompt_hash)
      JOIN harness_shared.session_prompt_origin_stamps AS s
        ON s.workspace_id = ${workspace}
       AND s.source_kind = c.source_kind AND s.session_id = c.session_id AND s.prompt_hash = c.prompt_hash
      JOIN harness_shared.session_turns AS t
        ON t.workspace_id IN ('default', ${workspace})
       AND t.source_kind = c.source_kind AND t.session_id = c.session_id
       AND t.ts BETWEEN s.submitted_at - (${windowMs}::int * interval '1 millisecond')
                    AND s.submitted_at + (${windowMs}::int * interval '1 millisecond')
     WHERE t.speaker = 'user'
       AND t.turn_origin = ${HOOK_AUTHENTICATED_PROMPT_ORIGIN}
       AND encode(sha256(convert_to(
             regexp_replace(regexp_replace(t.text, E'\\r\\n?', E'\\n', 'g'), '^\\s+|\\s+$', '', 'g'),
             'UTF8')), 'hex') = c.prompt_hash
  `;
  const stampsByCluster = new Map<string, PromptOriginStamp[]>();
  for (const stamp of stamps) {
    const key = clusterKey(stamp.source_kind, stamp.session_id, stamp.prompt_hash);
    stampsByCluster.set(key, [...(stampsByCluster.get(key) ?? []), stamp]);
  }
  const spentByCluster = new Map<string, TurnRow[]>();
  for (const s of spent) {
    const key = clusterKey(s.source_kind, s.session_id, s.prompt_hash);
    // A stand-in in the exact state correlation accepts, so it can claim the
    // stamp it consumed when it was promoted.
    const standIn: TurnRow = {
      workspace_id: workspace, source_kind: s.source_kind, session_id: s.session_id,
      turn_idx: Number(s.turn_idx), ts: new Date(s.ts).toISOString(),
      owner: null, harness_slug: null, cwd: null, speaker: 'user', text: '',
      turn_origin: null, turn_origin_verdict: UNENROLLED_ORIGIN_VERDICT,
      turn_origin_classifier_version: MACHINE_SURFACE_CATALOGUE_VERSION, prompt_hash: s.prompt_hash,
    };
    spentByCluster.set(key, [...(spentByCluster.get(key) ?? []), standIn]);
  }
  for (const [key, candidates] of candidatesByCluster) {
    const already = (spentByCluster.get(key) ?? []).sort((a, b) => Date.parse(a.ts!) - Date.parse(b.ts!));
    correlatePromptOriginStamps([...already, ...candidates], stampsByCluster.get(key) ?? [], {
      priority: new Set(already),
    });
    if (already.some((row) => row.turn_origin !== HOOK_AUTHENTICATED_PROMPT_ORIGIN)) {
      for (const row of candidates) {
        row.turn_origin = null;
        row.turn_origin_verdict = UNENROLLED_ORIGIN_VERDICT;
      }
    }
  }
}

interface IngestState {
  byte_offset: number;
  turn_count: number;
  /** P-001: the session_turn_parts cursor — the parts analog of turn_count,
   *  carried on the SAME bookkeeping row so one writeState advances both. */
  part_count: number;
  /** EI-9970: cumulative real-prompt / distinct-model-response / tool-call
   *  counts for this file, and the dedup cursor for the response count. */
  prompt_count: number;
  response_count: number;
  tool_call_count: number;
  last_inference_id: string | null;
  counts_backfill_offset: number;
  counts_backfill_last_inference_id: string | null;
  counts_backfilled_at: string | null;
  /** P-001: independent cursor for repairing rows whose file cursor already
   * reached EOF before session_turn_parts existed or was wired. */
  parts_backfill_offset?: number;
  parts_backfilled_at?: string | null;
  /** First byte parsed with short user decisions retained; legacy prefix indexes never move. */
  short_user_turns_offset?: number | null;
}

const EMPTY_STATE: IngestState = {
  byte_offset: 0,
  turn_count: 0,
  part_count: 0,
  prompt_count: 0,
  response_count: 0,
  tool_call_count: 0,
  last_inference_id: null,
  counts_backfill_offset: 0,
  counts_backfill_last_inference_id: null,
  counts_backfilled_at: null,
  parts_backfill_offset: 0,
  parts_backfilled_at: null,
  short_user_turns_offset: null,
};

async function readState(sql: Sql, sourceKind: string, filePath: string): Promise<IngestState> {
  const rows = await sql<Array<{
    byte_offset: string | number; turn_count: number; part_count: number | null;
    prompt_count: number; response_count: number; tool_call_count: number; last_inference_id: string | null;
    counts_backfill_offset: string | number; counts_backfill_last_inference_id: string | null;
    counts_backfilled_at: string | null;
    parts_backfill_offset: string | number; parts_backfilled_at: string | null;
    short_user_turns_offset: string | number | null;
  }>>`
    SELECT byte_offset, turn_count, part_count, prompt_count, response_count, tool_call_count, last_inference_id,
           counts_backfill_offset, counts_backfill_last_inference_id, counts_backfilled_at
           , parts_backfill_offset, parts_backfilled_at, short_user_turns_offset
      FROM harness_shared.session_ingest_state
     WHERE source_kind = ${sourceKind} AND file_path = ${filePath}
  `;
  if (!rows.length) return { ...EMPTY_STATE };
  const r = rows[0];
  return {
    byte_offset: Number(r.byte_offset),
    turn_count: r.turn_count,
    part_count: r.part_count ?? 0,
    prompt_count: r.prompt_count ?? 0,
    response_count: r.response_count ?? 0,
    tool_call_count: r.tool_call_count ?? 0,
    last_inference_id: r.last_inference_id ?? null,
    counts_backfill_offset: Number(r.counts_backfill_offset ?? 0),
    counts_backfill_last_inference_id: r.counts_backfill_last_inference_id ?? null,
    counts_backfilled_at: r.counts_backfilled_at ?? null,
    parts_backfill_offset: Number(r.parts_backfill_offset ?? 0),
    parts_backfilled_at: r.parts_backfilled_at ?? null,
    short_user_turns_offset: r.short_user_turns_offset == null ? null : Number(r.short_user_turns_offset),
  };
}

async function writeState(
  sql: Sql,
  sourceKind: string,
  filePath: string,
  st: Pick<IngestState, 'byte_offset' | 'turn_count'> &
    Partial<Pick<IngestState, 'part_count' | 'prompt_count' | 'response_count' | 'tool_call_count' | 'last_inference_id' | 'counts_backfill_offset' | 'counts_backfill_last_inference_id' | 'counts_backfilled_at'>> &
    Partial<Pick<IngestState, 'parts_backfill_offset' | 'parts_backfilled_at' | 'short_user_turns_offset'>> &
    { sessionId?: string | null; mtimeMs?: number; lastError?: string | null },
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.session_ingest_state
      (source_kind, file_path, byte_offset, turn_count, part_count, prompt_count, response_count,
       tool_call_count, last_inference_id, counts_backfill_offset, counts_backfill_last_inference_id, counts_backfilled_at,
       parts_backfill_offset, parts_backfilled_at, short_user_turns_offset, session_id, mtime_ms, last_error, updated_at)
    VALUES (${sourceKind}, ${filePath}, ${st.byte_offset}, ${st.turn_count}, ${st.part_count ?? 0},
            ${st.prompt_count ?? 0}, ${st.response_count ?? 0}, ${st.tool_call_count ?? 0}, ${st.last_inference_id ?? null},
            ${st.counts_backfill_offset ?? st.byte_offset}, ${st.counts_backfill_last_inference_id ?? null}, ${st.counts_backfilled_at ?? null},
            ${st.parts_backfill_offset ?? 0}, ${st.parts_backfilled_at ?? null}, ${st.short_user_turns_offset ?? null},
            ${st.sessionId ?? null}, ${st.mtimeMs != null ? Math.round(st.mtimeMs) : null}, ${st.lastError ?? null}, now())
    ON CONFLICT (source_kind, file_path) DO UPDATE SET
      byte_offset       = EXCLUDED.byte_offset,
      turn_count        = EXCLUDED.turn_count,
      -- P-001: PRESERVE on omission, don't zero. Several callers write this row
      -- without knowing the parts cursor at all (the counts backfill, the
      -- agent_chat sync, the CHAT_HWM row) — with plain EXCLUDED semantics each
      -- of those ticks would silently reset part_count to 0 and the next real
      -- ingest would renumber parts from 0, colliding with existing part_idx
      -- values and losing the whole tail to ON CONFLICT DO NOTHING. Passing an
      -- explicit 0 still resets it, which is what a deliberate re-ingest wants.
      part_count        = COALESCE(${st.part_count ?? null}, harness_shared.session_ingest_state.part_count),
      prompt_count      = EXCLUDED.prompt_count,
      response_count    = EXCLUDED.response_count,
      tool_call_count   = EXCLUDED.tool_call_count,
      last_inference_id = EXCLUDED.last_inference_id,
      counts_backfill_offset = EXCLUDED.counts_backfill_offset,
      counts_backfill_last_inference_id = COALESCE(EXCLUDED.counts_backfill_last_inference_id, harness_shared.session_ingest_state.counts_backfill_last_inference_id),
      counts_backfilled_at = COALESCE(EXCLUDED.counts_backfilled_at, harness_shared.session_ingest_state.counts_backfilled_at),
      parts_backfill_offset = COALESCE(${st.parts_backfill_offset ?? null}, harness_shared.session_ingest_state.parts_backfill_offset),
      parts_backfilled_at = COALESCE(${st.parts_backfilled_at ?? null}, harness_shared.session_ingest_state.parts_backfilled_at),
      short_user_turns_offset = COALESCE(harness_shared.session_ingest_state.short_user_turns_offset, EXCLUDED.short_user_turns_offset),
      session_id        = COALESCE(EXCLUDED.session_id, harness_shared.session_ingest_state.session_id),
      mtime_ms          = EXCLUDED.mtime_ms,
      last_error        = EXCLUDED.last_error,
      updated_at        = now()
  `;
}

interface CountBackfillBudget {
  files: number;
  bytes: number;
}

interface CountBackfillStateRow extends IngestState {
  file_path: string;
  session_id: string | null;
}

/** Replay only the counter signal for one historical file. The indexed-turn
 * byte_offset/turn_count remain untouched; counts_backfill_offset is the
 * independent resumable cursor. */
async function backfillFileCounts(
  sql: Sql,
  adapter: FileAdapter,
  row: CountBackfillStateRow,
  budget: CountBackfillBudget,
): Promise<boolean> {
  if (budget.files <= 0 || budget.bytes <= 0) return false;
  const meta = adapter.meta(row.file_path);
  let sourceSize: number;
  try {
    const source = await stat(row.file_path);
    if (!source.isFile()) throw new Error('not a file');
    sourceSize = source.size;
  } catch {
    // The transcript may have been archived/deleted after its index state was
    // written. Mark it terminally unavailable so a missing source cannot wake
    // the same repair forever; the archive remains the authoritative payload.
    await writeState(sql, adapter.sourceKind, row.file_path, {
      byte_offset: row.byte_offset,
      turn_count: row.turn_count,
      prompt_count: row.prompt_count,
      response_count: row.response_count,
      tool_call_count: row.tool_call_count,
      last_inference_id: row.last_inference_id,
      counts_backfill_offset: row.counts_backfill_offset,
      counts_backfill_last_inference_id: row.counts_backfill_last_inference_id,
      counts_backfilled_at: new Date().toISOString(),
      sessionId: row.session_id ?? meta.sessionId,
      lastError: 'counts_backfill_source_missing',
    });
    budget.files -= 1;
    return true;
  }

  let cursor = Math.min(row.counts_backfill_offset, sourceSize);
  let promptCount = row.prompt_count;
  let responseCount = row.response_count;
  let toolCallCount = row.tool_call_count;
  let lastInferenceId = row.counts_backfill_last_inference_id;
  let progressed = false;
  while (cursor < sourceSize && budget.bytes > 0) {
    const result = await readNewLines(
      row.file_path,
      cursor,
      adapter.parseLine,
      adapter.classifyLine,
      lastInferenceId,
    );
    if (result.newOffset === cursor) break;
    const advanced = result.newOffset - cursor;
    cursor = result.newOffset;
    promptCount += result.promptCount;
    responseCount += result.responseCount;
    toolCallCount += result.toolCallCount;
    lastInferenceId = result.lastInferenceId;
    budget.bytes -= advanced;
    progressed = true;
  }

  const complete = cursor >= sourceSize;
  if (progressed || complete) {
    await writeState(sql, adapter.sourceKind, row.file_path, {
      byte_offset: row.byte_offset,
      turn_count: row.turn_count,
      prompt_count: promptCount,
      response_count: responseCount,
      tool_call_count: toolCallCount,
      last_inference_id: lastInferenceId,
      counts_backfill_offset: cursor,
      counts_backfill_last_inference_id: lastInferenceId,
      counts_backfilled_at: complete ? new Date().toISOString() : null,
      sessionId: row.session_id ?? meta.sessionId,
    });
  }
  if (progressed || complete) budget.files -= 1;
  return progressed || complete;
}

interface PartsBackfillStateRow {
  file_path: string;
  byte_offset: number;
  turn_count: number;
  part_count: number;
  parts_backfill_offset: number;
  parts_backfilled_at: string | null;
  session_id: string | null;
}

/** Replay only the faithful-part signal for one historical file. The live
 * byte_offset/turn_count cursors remain untouched: this is specifically for
 * rows that reached EOF before the P-001 writer existed or completed. A
 * separate cursor makes the repair resumable without replaying text turns. */
async function backfillFileParts(
  sql: Sql,
  adapter: FileAdapter,
  row: PartsBackfillStateRow,
  budget: CountBackfillBudget,
): Promise<boolean> {
  if (budget.files <= 0 || budget.bytes <= 0 || !adapter.parseParts) return false;
  const meta = adapter.meta(row.file_path);
  const owner = adapter.sourceKind === 'claude'
    ? await indexedClaudeOwner(meta.sessionId) ?? meta.owner
    : meta.owner;
  let sourceSize: number;
  try {
    const source = await stat(row.file_path);
    if (!source.isFile()) throw new Error('not a file');
    sourceSize = source.size;
  } catch {
    // Archive cleanup can win the race after indexing. Do not leave a missing
    // source eligible forever; the archive reader remains the recovery surface
    // for sessions whose bytes are no longer on disk.
    await writeState(sql, adapter.sourceKind, row.file_path, {
      byte_offset: row.byte_offset,
      turn_count: row.turn_count,
      part_count: row.part_count,
      parts_backfill_offset: row.parts_backfill_offset,
      parts_backfilled_at: new Date().toISOString(),
      sessionId: row.session_id ?? meta.sessionId,
      lastError: 'parts_backfill_source_missing',
    });
    budget.files -= 1;
    return true;
  }

  // A replaced/truncated source cannot honor an old independent cursor. Start
  // from zero so the part index is rebuilt from the bytes that exist now.
  let cursor = row.parts_backfill_offset > sourceSize ? 0 : row.parts_backfill_offset;
  let partCount = row.part_count;
  let progressed = false;
  while (cursor < sourceSize && budget.bytes > 0) {
    const result = await readNewLines(
      row.file_path,
      cursor,
      adapter.parseLine,
      adapter.classifyLine,
      null,
      undefined,
      [],
      adapter.parseParts,
    );
    if (result.newOffset === cursor) break;

    // If this write fails, leave the cursor at the last successful chunk so a
    // later sweep retries the same parts instead of declaring them repaired.
    await insertParts(sql, partRowsFrom(result.parts, {
      sourceKind: adapter.sourceKind,
      sessionId: row.session_id ?? meta.sessionId,
      owner,
      partCount,
    }));

    const advanced = result.newOffset - cursor;
    cursor = result.newOffset;
    partCount += result.parts.length;
    budget.bytes -= advanced;
    progressed = true;
    await writeState(sql, adapter.sourceKind, row.file_path, {
      byte_offset: row.byte_offset,
      turn_count: row.turn_count,
      part_count: partCount,
      parts_backfill_offset: cursor,
      parts_backfilled_at: null,
      sessionId: row.session_id ?? meta.sessionId,
    });
  }

  const complete = cursor >= sourceSize;
  if (complete) {
    await writeState(sql, adapter.sourceKind, row.file_path, {
      byte_offset: row.byte_offset,
      turn_count: row.turn_count,
      part_count: partCount,
      parts_backfill_offset: cursor,
      parts_backfilled_at: new Date().toISOString(),
      sessionId: row.session_id ?? meta.sessionId,
    });
  }
  if (progressed || complete) budget.files -= 1;
  return progressed || complete;
}

/** Backfill faithful parts for pre-P-001 rows in bounded, resumable slices.
 * Only file adapters with parseParts participate; agent_chat and OMP retain
 * their prior zero-parts semantics. */
async function backfillHistoricalParts(sql: Sql): Promise<number> {
  const budget: CountBackfillBudget = {
    files: MAX_PART_BACKFILL_FILES_PER_TICK,
    bytes: MAX_PART_BACKFILL_BYTES_PER_TICK,
  };
  let progressed = 0;
  for (const adapter of FILE_ADAPTERS) {
    if (budget.files <= 0 || budget.bytes <= 0 || !adapter.parseParts) break;
    const rows = await sql<Array<{
      file_path: string;
      byte_offset: string | number;
      turn_count: number;
      part_count: number | null;
      parts_backfill_offset: string | number;
      parts_backfilled_at: string | null;
      session_id: string | null;
    }>>`
      SELECT file_path, byte_offset, turn_count, part_count,
             parts_backfill_offset, parts_backfilled_at, session_id
        FROM harness_shared.session_ingest_state
       WHERE source_kind = ${adapter.sourceKind}
         AND byte_offset > 0
         AND parts_backfilled_at IS NULL
         AND (part_count = 0 OR parts_backfill_offset > 0)
       ORDER BY updated_at ASC, file_path ASC
       LIMIT ${MAX_PART_BACKFILL_FILES_PER_TICK}
    `;
    for (const r of rows) {
      if (budget.files <= 0 || budget.bytes <= 0) break;
      const changed = await backfillFileParts(sql, adapter, {
        file_path: r.file_path,
        byte_offset: Number(r.byte_offset),
        turn_count: r.turn_count,
        part_count: r.part_count ?? 0,
        parts_backfill_offset: Number(r.parts_backfill_offset ?? 0),
        parts_backfilled_at: r.parts_backfilled_at ?? null,
        session_id: r.session_id ?? null,
      }, budget);
      if (changed) progressed += 1;
    }
  }
  return progressed;
}

/** Backfill pre-579 file and agent-chat rows in small resumable slices. This
 * deliberately runs before the ordinary newest-first tail so historical rows
 * converge even when they are older than INGEST_WINDOW_DAYS. */
async function backfillHistoricalCounts(sql: Sql): Promise<number> {
  const budget: CountBackfillBudget = {
    files: MAX_COUNT_BACKFILL_FILES_PER_TICK,
    bytes: MAX_COUNT_BACKFILL_BYTES_PER_TICK,
  };
  let progressed = 0;
  for (const adapter of FILE_ADAPTERS) {
    if (budget.files <= 0 || budget.bytes <= 0) break;
    const rows = await sql<Array<{
      file_path: string;
      byte_offset: string | number;
      turn_count: number;
      part_count: number | null;
      prompt_count: number;
      response_count: number;
      tool_call_count: number;
      last_inference_id: string | null;
      counts_backfill_offset: string | number;
      counts_backfill_last_inference_id: string | null;
      counts_backfilled_at: string | null;
      session_id: string | null;
    }>>`
      SELECT file_path, byte_offset, turn_count, part_count, prompt_count, response_count,
             tool_call_count, last_inference_id, counts_backfill_offset,
             counts_backfill_last_inference_id, counts_backfilled_at, session_id
        FROM harness_shared.session_ingest_state
       WHERE source_kind = ${adapter.sourceKind}
         AND counts_backfilled_at IS NULL
       ORDER BY updated_at ASC, file_path ASC
       LIMIT ${MAX_COUNT_BACKFILL_FILES_PER_TICK}
    `;
    for (const r of rows) {
      if (budget.files <= 0 || budget.bytes <= 0) break;
      const changed = await backfillFileCounts(sql, adapter, {
        file_path: r.file_path,
        byte_offset: Number(r.byte_offset),
        turn_count: r.turn_count,
        part_count: r.part_count ?? 0,
        prompt_count: r.prompt_count ?? 0,
        response_count: r.response_count ?? 0,
        tool_call_count: r.tool_call_count ?? 0,
        last_inference_id: r.last_inference_id ?? null,
        counts_backfill_offset: Number(r.counts_backfill_offset ?? 0),
        counts_backfill_last_inference_id: r.counts_backfill_last_inference_id ?? null,
        counts_backfilled_at: r.counts_backfilled_at ?? null,
        session_id: r.session_id ?? null,
      }, budget);
      if (changed) progressed += 1;
    }
  }

  if (budget.files > 0) {
    const chats = await sql<Array<{
      file_path: string;
      byte_offset: string | number;
      turn_count: number;
      prompt_count: number;
      response_count: number;
      tool_call_count: number;
      last_inference_id: string | null;
      counts_backfill_offset: string | number;
      session_id: string | null;
      transcript: Array<{ role?: string; content?: unknown }> | null;
    }>>`
      SELECT st.file_path, st.byte_offset, st.turn_count, st.prompt_count,
             st.response_count, st.tool_call_count, st.last_inference_id,
             st.counts_backfill_offset, st.session_id, c.transcript
        FROM harness_shared.session_ingest_state AS st
        JOIN harness_shared.agent_chats_consolidated AS c
          ON st.file_path = ('chat:' || c.workspace_id || ':' || c.harness_slug || ':' || c.id)
       WHERE st.source_kind = 'agent_chat'
         AND st.file_path <> ${CHAT_HWM_PATH}
         AND st.counts_backfilled_at IS NULL
       ORDER BY st.updated_at ASC, st.file_path ASC
       LIMIT ${MAX_CHATS_PER_TICK}
    `;
    for (const chat of chats) {
      if (budget.files <= 0) break;
      const transcript = Array.isArray(chat.transcript) ? chat.transcript : [];
      let prompts = chat.prompt_count ?? 0;
      let responses = chat.response_count ?? 0;
      for (const turn of transcript) {
        if (turn.role === 'user') prompts += 1;
        else if (turn.role === 'assistant') responses += 1;
      }
      await writeState(sql, 'agent_chat', chat.file_path, {
        byte_offset: Number(chat.byte_offset),
        turn_count: chat.turn_count,
        prompt_count: prompts,
        response_count: responses,
        tool_call_count: chat.tool_call_count ?? 0,
        last_inference_id: chat.last_inference_id ?? null,
        counts_backfill_offset: transcript.length,
        counts_backfill_last_inference_id: null,
        counts_backfilled_at: new Date().toISOString(),
        sessionId: chat.session_id,
      });
      budget.files -= 1;
      progressed += 1;
    }
  }
  return progressed;
}

/** Tail ONE file now (bounded, incremental). The read-time freshness lever:
 * sessions:search { session:'self' } and the post-compaction orient call this
 * on the caller's own transcript so the last few minutes are never a blind
 * spot — client-neutral (compaction-context-loss D-002). */
export async function ingestFileNow(
  filePath: string,
  opts: { owner?: string | null; sessionId?: string | null } = {},
): Promise<{ inserted: number }> {
  const adapter = FILE_ADAPTERS.find((a) => a.roots().some((r) => filePath.startsWith(r.root)));
  if (!adapter) return { inserted: 0 };
  const { sql } = getOrgPg();
  let inserted = 0;
  const meta = adapter.meta(filePath);
  const owner = opts.owner ?? (adapter.sourceKind === 'claude'
    ? await indexedClaudeOwner(meta.sessionId) ?? meta.owner
    : meta.owner);
  if (adapter.sourceKind === 'codex') {
    // Run this even when the file has no new bytes: read-time freshness is
    // also the repair path for a paused session whose process interval still
    // overlaps the caller's query window.
    try {
      const codexMeta = codexAdvSessionMetadata(filePath, opts.sessionId?.trim() || meta.sessionId);
      if (codexMeta) await backfillCodexAdvSessions(sql, new Map([[codexMeta.advSessionId, codexMeta]]));
    } catch (err) {
      process.stderr.write(`[session-ingest] codex adv metadata backfill skipped: ${(err as Error).message}\n`);
    }
  }
  // A single file can exceed the per-call byte cap — loop until drained (bounded
  // by the file size; this is one file, not the fleet).
  for (let guard = 0; guard < 32; guard += 1) {
    const st = await readState(sql, adapter.sourceKind, filePath);
    const { turns, parts, newOffset, promptCount, responseCount, toolCallCount, lastInferenceId } =
      await readNewLines(
        filePath, st.byte_offset, adapter.parseLine, adapter.classifyLine, st.last_inference_id,
        undefined, [], adapter.parseParts,
      );
    if (newOffset === st.byte_offset) break;
    const rows: TurnRow[] = turns.map((t, i) => ({
      workspace_id: 'default',
      source_kind: adapter.sourceKind,
      session_id: t.sessionId ?? opts.sessionId ?? meta.sessionId,
      turn_idx: st.turn_count + i,
      ts: t.ts ? t.ts.toISOString() : null,
      owner,
      harness_slug: null,
      cwd: t.cwd ?? null,
      speaker: t.speaker,
      text: t.text,
      prompt_hash: t.promptHash ?? null,
    }));
    inserted += await insertTurns(sql, rows);
    // Best-effort by contract (see insertParts): the render store must never
    // block the recall index or hold back the offset.
    try {
      await insertParts(sql, partRowsFrom(parts, {
        sourceKind: adapter.sourceKind,
        sessionId: opts.sessionId ?? meta.sessionId,
        owner,
        partCount: st.part_count,
      }));
    } catch (err) {
      console.warn(`[session-ingest] parts write skipped (non-fatal): ${(err as Error).message}`);
    }
    await writeState(sql, adapter.sourceKind, filePath, {
      byte_offset: newOffset,
      turn_count: st.turn_count + turns.length,
      part_count: st.part_count + parts.length,
      short_user_turns_offset: st.short_user_turns_offset ?? st.byte_offset,
      prompt_count: st.prompt_count + promptCount,
      response_count: st.response_count + responseCount,
      tool_call_count: st.tool_call_count + toolCallCount,
      last_inference_id: lastInferenceId,
      counts_backfill_offset: newOffset,
      counts_backfill_last_inference_id: lastInferenceId,
      counts_backfilled_at: new Date().toISOString(),
      sessionId: opts.sessionId ?? meta.sessionId,
    });
  }
  return { inserted };
}

/* ------------------------------------------------------------------ */
/* agent_chat sync (PG → PG; transcript JSONB → turns)                  */
/* ------------------------------------------------------------------ */

const CHAT_HWM_PATH = '__hwm__';

async function syncAgentChats(sql: Sql, budget: { turns: number }): Promise<number> {
  const hwmRows = await sql<Array<{ mtime_ms: string | number | null }>>`
    SELECT mtime_ms FROM harness_shared.session_ingest_state
     WHERE source_kind = 'agent_chat' AND file_path = ${CHAT_HWM_PATH}
  `;
  const hwm = hwmRows.length ? Number(hwmRows[0].mtime_ms ?? 0) : 0;

  const chats = await sql<
    Array<{
      workspace_id: string;
      harness_slug: string;
      id: string;
      transcript: Array<{ ts?: string; role?: string; content?: unknown }> | null;
      updated_at: string | number;
    }>
  >`
    SELECT workspace_id, harness_slug, id, transcript, updated_at
      FROM harness_shared.agent_chats_consolidated
     WHERE updated_at > ${hwm} AND transcript IS NOT NULL
     ORDER BY updated_at ASC
     LIMIT ${MAX_CHATS_PER_TICK}
  `;
  if (!chats.length) return 0;

  let ingested = 0;
  let maxUpdated = hwm;
  for (const chat of chats) {
    // Budget check BEFORE advancing the high-water mark — a chat skipped for
    // budget must be re-fetched next tick, so the hwm may only cover chats we
    // actually processed.
    if (budget.turns <= 0) break;
    const transcript = Array.isArray(chat.transcript) ? chat.transcript : [];
    const key = `chat:${chat.workspace_id}:${chat.harness_slug}:${chat.id}`;
    const st = await readState(sql, 'agent_chat', key);
    if (transcript.length <= st.turn_count) {
      maxUpdated = Math.max(maxUpdated, Number(chat.updated_at)); // processed: nothing new
      continue;
    }
    const rows: TurnRow[] = [];
    let promptDelta = 0;
    let responseDelta = 0;
    for (let i = st.turn_count; i < transcript.length; i += 1) {
      const t = transcript[i];
      const speaker = t.role === 'user' ? 'user' : t.role === 'assistant' ? 'assistant' : null;
      if (!speaker) continue;
      const text = cleanTurnText(typeof t.content === 'string' ? t.content : textFromContent(t.content));
      if (!text) continue;
      // EI-9970: agent_chats_consolidated is already one JSONB entry per real
      // turn (no thinking-only/tool-only sub-line splitting like the file
      // adapters), so a plain per-speaker count is exact here — no dedup
      // cursor needed. tool_call_count stays 0: this transcript shape carries
      // no tool-call signal (documented limitation, sessions:list note).
      if (speaker === 'user') promptDelta += 1;
      else responseDelta += 1;
      rows.push({
        workspace_id: chat.workspace_id,
        source_kind: 'agent_chat',
        session_id: chat.id,
        turn_idx: i,
        ts: parseTs(t.ts)?.toISOString() ?? null,
        owner: null,
        harness_slug: chat.harness_slug,
        cwd: null,
        speaker,
        text,
      });
    }
    ingested += await insertTurns(sql, rows);
    await writeState(sql, 'agent_chat', key, {
      byte_offset: 0,
      turn_count: transcript.length,
      prompt_count: st.prompt_count + promptDelta,
      response_count: st.response_count + responseDelta,
      tool_call_count: st.tool_call_count,
      counts_backfill_offset: transcript.length,
      counts_backfill_last_inference_id: null,
      counts_backfilled_at: new Date().toISOString(),
      sessionId: chat.id,
    });
    budget.turns -= rows.length;
    maxUpdated = Math.max(maxUpdated, Number(chat.updated_at)); // processed
  }
  await writeState(sql, 'agent_chat', CHAT_HWM_PATH, {
    byte_offset: 0,
    turn_count: 0,
    counts_backfilled_at: new Date().toISOString(),
    mtimeMs: maxUpdated,
  });
  return ingested;
}

/* ------------------------------------------------------------------ */
/* Retention                                                            */
/* ------------------------------------------------------------------ */

/** Rows per retention DELETE statement. Each statement stays short, so the
 * daily tick never holds one long lock over the bulkiest tables. */
const PRUNE_BATCH_ROWS = 5000;
/** Wall-clock budget per table per tick. This REPLACES a fixed 40-batch
 * ceiling (40 x 5000 = 200k rows/run): session_turn_parts takes ~470k rows/day
 * (sampled 2026-10-13, ingest days 10-01..10-12), so that ceiling deleted
 * exactly 200k every day and the 14-day window was never reached — 1.37M rows
 * past it accumulated while the workflow reported SUCCESS (WI-6554700010009718).
 * A budget bounds the tick's duration without bounding its throughput below
 * the inflow. */
const PRUNE_TABLE_BUDGET_MS = 10 * 60_000;

/** What one table's prune did. `exhausted` = the budget ran out while batches
 * were still full, i.e. rows past the window REMAIN — the signal a capped
 * prune never gave. */
export interface PruneTableReport {
  deleted: number;
  batches: number;
  exhausted: boolean;
}

/** One table's two-pass prune. `tailDeleted` = rows only the exact,
 * seq-scanning tail pass removed. It is normally the handful ingested late; a
 * large value means the indexed bulk pass stopped short and the slow pass did
 * its work. */
export interface PrunePassesReport extends PruneTableReport {
  tailDeleted: number;
}

export interface SessionTurnsPruneReport {
  deleted: number;
  partsDeleted: number;
  turns: PrunePassesReport;
  parts: PrunePassesReport;
}

export interface PruneSessionTurnsOptions {
  batchRows?: number;
  budgetMs?: number;
  now?: () => number;
}

/** Run `deleteBatch` until a short batch proves nothing is left, or the
 * deadline passes. Never stops on an iteration count. */
export async function drainInBatches(
  deleteBatch: (limit: number) => Promise<number>,
  opts: { batchRows: number; deadline: number; now: () => number },
): Promise<PruneTableReport> {
  let deleted = 0;
  let batches = 0;
  for (;;) {
    if (opts.now() >= opts.deadline) return { deleted, batches, exhausted: true };
    const n = await deleteBatch(opts.batchRows);
    deleted += n;
    batches += 1;
    if (n < opts.batchRows) return { deleted, batches, exhausted: false };
  }
}

/** Two passes against one table, sharing one deadline:
 *  1. BULK, through the table's `ingested_at` btree. `COALESCE(ts, ingested_at)`
 *     cannot use an index, so the old single pass seq-scanned for every batch
 *     (measured 2026-10-13: 1,219 ms per 5,000-row candidate scan on
 *     session_turn_parts, 17 s mean on session_turns; the indexed form is 15 ms
 *     and 42 ms). The exact predicate is kept as a filter, so this pass only
 *     ever deletes rows the contract says are expired.
 *  2. TAIL, the exact predicate alone: rows ingested recently whose own `ts`
 *     is already past the window (2,338 of 1.37M when measured). One seq scan,
 *     normally a single short batch. Together the passes delete exactly
 *     `COALESCE(ts, ingested_at) < now() - window`. */
async function prunePastWindow(
  bulk: (limit: number) => Promise<number>,
  tail: (limit: number) => Promise<number>,
  opts: { batchRows: number; budgetMs: number; now: () => number },
): Promise<PrunePassesReport> {
  const deadline = opts.now() + opts.budgetMs;
  const first = await drainInBatches(bulk, { ...opts, deadline });
  if (first.exhausted) return { ...first, tailDeleted: 0 };
  const second = await drainInBatches(tail, { ...opts, deadline });
  return {
    deleted: first.deleted + second.deleted,
    batches: first.batches + second.batches,
    exhausted: second.exhausted,
    tailDeleted: second.deleted,
  };
}

/** Batched retention prune — the index stays bounded; the JSONL stays the
 * archive. Called from the daily retention tick (periodic-workflows.ts). */
export async function pruneSessionTurnsOnce(
  options: PruneSessionTurnsOptions = {},
): Promise<SessionTurnsPruneReport> {
  const { sql } = getOrgPg();
  const opts = {
    batchRows: options.batchRows ?? PRUNE_BATCH_ROWS,
    budgetMs: options.budgetMs ?? PRUNE_TABLE_BUDGET_MS,
    now: options.now ?? Date.now,
  };
  const turns = await prunePastWindow(
    async (limit) => (await sql`
      DELETE FROM harness_shared.session_turns
       WHERE ctid IN (
         SELECT ctid FROM harness_shared.session_turns
          WHERE ingested_at < now() - make_interval(days => ${RETENTION_DAYS})
            AND COALESCE(ts, ingested_at) < now() - make_interval(days => ${RETENTION_DAYS})
          ORDER BY ingested_at
          LIMIT ${limit}
       )
    `).count ?? 0,
    async (limit) => (await sql`
      DELETE FROM harness_shared.session_turns
       WHERE ctid IN (
         SELECT ctid FROM harness_shared.session_turns
          WHERE COALESCE(ts, ingested_at) < now() - make_interval(days => ${RETENTION_DAYS})
          LIMIT ${limit}
       )
    `).count ?? 0,
    opts,
  );
  // Bookkeeping rows for files idle past the window are dead weight.
  await sql`
    DELETE FROM harness_shared.session_ingest_state
     WHERE updated_at < now() - make_interval(days => ${RETENTION_DAYS * 2})
       AND file_path <> ${CHAT_HWM_PATH}
  `;
  // The per-turn journal (P-012) rides the same retention window — it is a
  // bounded surface over the same transcripts, not an archive.
  await sql`
    DELETE FROM harness_shared.session_turn_journal
     WHERE created_at < now() - make_interval(days => ${RETENTION_DAYS})
  `;
  // P-001/D-002: the faithful parts store rides a SHORTER window than the
  // turns index (14 d vs 45 d). Measured at ~134 MB/7 d against session_turns'
  // 472 MB heap for 45 d, so an equal window would have made the render
  // convenience three times the size of the recall corpus it serves. Beyond
  // this window the pane degrades to text turns, then to session_archives —
  // each tier strictly cheaper and lossier, and none of them a dead click.
  // Batched exactly like the turns prune above: one unbounded DELETE over the
  // bulkiest table in the corpus is a long lock on the daily tick. Its own
  // budget, so a slow session_turns pass can never starve this one.
  const parts = await prunePastWindow(
    async (limit) => (await sql`
      DELETE FROM harness_shared.session_turn_parts
       WHERE ctid IN (
         SELECT ctid FROM harness_shared.session_turn_parts
          WHERE ingested_at < now() - make_interval(days => ${PART_RETENTION_DAYS})
            AND COALESCE(ts, ingested_at) < now() - make_interval(days => ${PART_RETENTION_DAYS})
          ORDER BY ingested_at
          LIMIT ${limit}
       )
    `).count ?? 0,
    async (limit) => (await sql`
      DELETE FROM harness_shared.session_turn_parts
       WHERE ctid IN (
         SELECT ctid FROM harness_shared.session_turn_parts
          WHERE COALESCE(ts, ingested_at) < now() - make_interval(days => ${PART_RETENTION_DAYS})
          LIMIT ${limit}
       )
    `).count ?? 0,
    opts,
  );
  return { deleted: turns.deleted, partsDeleted: parts.deleted, turns, parts };
}

/* ------------------------------------------------------------------ */
/* The periodic tick                                                    */
/* ------------------------------------------------------------------ */

// Single-flight realm-pinned (perf rule A18): tsx/dual-path imports can
// instantiate this module twice; a module-scoped flag would not dedupe.
// Pinned through @papercusp/module-singleton rather than a hand-rolled
// `globalThis[Symbol.for(...)]` pair, so the pin stays visible to
// listModuleDuplications() (EI-19479108855357092).
interface SweepState { running: boolean; last: IngestStats | null }
const __sweep = pinModuleState<SweepState>(
  '@papercusp/operator-core.sessionIngestState',
  () => ({ running: false, last: null }),
);

export function getLastSessionIngestStats(): IngestStats | null {
  return __sweep.last;
}

/** One bounded ingest sweep across every adapter. Never throws. */
export async function runSessionIngestOnce(): Promise<IngestStats> {
  const started = performance.now();
  const stats: IngestStats = {
    filesScanned: 0, filesIngested: 0, turnsInserted: 0, chatsIngested: 0, countBackfillFiles: 0,
    partsBackfillFiles: 0,
    errors: 0, durationMs: 0,
  };
  if (__sweep.running) return { ...stats, skipped: 'already_running' };
  const phaseMs: NonNullable<IngestStats['phaseMs']> = {
    setup: 0, history: 0, discovery: 0, state: 0, metadata: 0,
    decode: 0, writes: 0, metadataBackfill: 0, chats: 0, other: 0,
  };
  // Measure at existing operation boundaries: no new timer or per-file async hop.
  // finally retains the cost of failed work without changing its error contract.
  async function measure<T>(phase: keyof typeof phaseMs, work: () => Promise<T>): Promise<T> {
    const began = performance.now();
    try { return await work(); }
    finally { phaseMs[phase] += performance.now() - began; }
  }
  async function measureMetadataBackfill(
    sourceKind: SourceKind,
    operation: NonNullable<IngestStats['metadataBackfills']>[number]['operation'],
    requested: number,
    work: (receipt: NonNullable<IngestStats['metadataBackfills']>[number]) => Promise<number>,
  ): Promise<void> {
    if (!requested) return;
    const startedAtMs = Date.now();
    const began = performance.now();
    const receipt: NonNullable<IngestStats['metadataBackfills']>[number] = {
      sourceKind, operation, requested, startedAtMs, durationMs: 0, status: 'failed',
    };
    try {
      receipt.updated = await measure('metadataBackfill', () => work(receipt));
      receipt.status = 'completed';
    } catch (err) {
      // Metadata repair must not discard successful tail/offset progress or
      // prevent the other repair. Report it and retry the still-needed repair
      // on the next ordinary sweep, including unchanged transcripts.
      stats.errors += 1;
      if ((stats.errorSample ??= []).length < 3) {
        const label = operation === 'sessionOwners' ? 'owner backfill'
          : operation === 'partOwners' ? 'part owner backfill' : 'adv metadata';
        stats.errorSample.push(`${sourceKind} ${label}: ${(err as Error).message.slice(0, 200)}`);
      }
    } finally {
      receipt.durationMs = Math.round((performance.now() - began) * 10) / 10;
      (stats.metadataBackfills ??= []).push(receipt);
    }
  }
  __sweep.running = true;
  try {
    let enabled = true;
    try {
      enabled = await measure('setup', () => getFlag(FLAGS.SESSION_SEARCH, 'system:session-ingest'));
    } catch {
      /* fail-open: flag default is ON */
    }
    if (!enabled) return { ...stats, skipped: 'flag_off' };

    const { sql } = getOrgPg();
    try {
      stats.partsBackfillFiles = await measure('history', () => backfillHistoricalParts(sql));
    } catch (err) {
      stats.errors += 1;
      console.warn(`[session-ingest] historical parts backfill skipped (non-fatal): ${(err as Error).message}`);
    }
    try {
      stats.countBackfillFiles = await measure('history', () => backfillHistoricalCounts(sql));
    } catch (err) {
      stats.errors += 1;
      console.warn(`[session-ingest] historical count backfill skipped (non-fatal): ${(err as Error).message}`);
    }
    const sinceMs = Date.now() - INGEST_WINDOW_DAYS * 24 * 3600 * 1000;
    const budget = { turns: MAX_TURNS_PER_TICK };

    // P-002 / migration 674 — the substitution registry, fetched ONCE per sweep
    // and matched per Bash command to attribute an intent bucket at ingest.
    //
    // ⚠ TWO DIFFERENT `workspace_id`s, and they are NOT interchangeable. The
    // rollup (like session_turns) is written under the literal 'default' — the
    // session-transcript CORPUS namespace, which is not a tenant. The registry
    // rows live under the REAL tenant (activeWorkspaceId(), 'papercusp-workspace'
    // here), the same id locks:check_command resolves. Reading the registry with
    // 'default' returns zero rows and silently disables every bucket count while
    // the ingest still looks perfectly healthy — so resolve the tenant, and let
    // an empty result be loud rather than assumed (the counts simply do not
    // appear, which the report's own emptyRegistry flag surfaces).
    //
    // Fail-soft: a registry read failure costs bucket attribution for this
    // sweep, never the ingest (same contract as writeUsageRollup).
    let substitutionRows: SubstitutionRow[] = [];
    try {
      substitutionRows = await measure('setup', () => getSubstitutionRows(activeWorkspaceId()));
    } catch (err) {
      stats.errors += 1;
      console.warn(`[session-ingest] substitution registry read failed (buckets skipped): ${(err as Error).message}`);
    }

    for (const adapter of FILE_ADAPTERS) {
      if (budget.turns <= 0) break;
      let candidates: Array<{ path: string; size: number; mtimeMs: number }> = [];
      try {
        candidates = await measure('discovery', () => listCandidateFiles(adapter, sinceMs));
      } catch (err) {
        stats.errors += 1;
        console.warn(`[session-ingest] ${adapter.sourceKind} enumerate failed: ${(err as Error).message}`);
        continue;
      }
      // Newest first: recent sessions index first; history back-fills over ticks.
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (candidates.length === 0) continue;
      // Bulk-load this adapter's ingest state ONCE — a per-file SELECT at ~23k
      // candidate files was minutes of serial round-trips (perf anti-pattern
      // A1: per-item queries in a loop; observed live 2026-07-05).
      // Only discovered files can consume these cursors. Reading the adapter's
      // entire history returned 123k rows per sweep (WI-10008237), including
      // archived and removed files. Historical repair has separate bounded reads.
      const stateRows = await measure('state', () => sql<Array<{
        file_path: string; byte_offset: string | number; turn_count: number; part_count: number | null;
        prompt_count: number; response_count: number; tool_call_count: number; last_inference_id: string | null;
        counts_backfill_offset: string | number; counts_backfill_last_inference_id: string | null;
        counts_backfilled_at: string | null;
        short_user_turns_offset: string | number | null;
      }>>`
        SELECT file_path, byte_offset, turn_count, part_count, prompt_count, response_count, tool_call_count, last_inference_id,
               counts_backfill_offset, counts_backfill_last_inference_id, counts_backfilled_at, short_user_turns_offset
          FROM harness_shared.session_ingest_state
         WHERE source_kind = ${adapter.sourceKind}
           AND file_path = ANY(${sql.array(candidates.map((candidate) => candidate.path))}::text[])
      `);
      const stateMap = new Map<string, IngestState>(
        stateRows.map((r) => [r.file_path, {
          byte_offset: Number(r.byte_offset),
          turn_count: r.turn_count,
          part_count: r.part_count ?? 0,
          prompt_count: r.prompt_count ?? 0,
          response_count: r.response_count ?? 0,
          tool_call_count: r.tool_call_count ?? 0,
          last_inference_id: r.last_inference_id ?? null,
          counts_backfill_offset: Number(r.counts_backfill_offset ?? r.byte_offset),
          counts_backfill_last_inference_id: r.counts_backfill_last_inference_id ?? null,
          counts_backfilled_at: r.counts_backfilled_at ?? null,
          short_user_turns_offset: r.short_user_turns_offset == null ? null : Number(r.short_user_turns_offset),
        }]),
      );
      let filesThisAdapter = 0;
      const ownerBackfill = new Map<string, string>();
      const indexedClaudeOwners = adapter.sourceKind === 'claude'
        ? await measure('state', () => indexedClaudeOwnersForCandidates(adapter, candidates))
        : new Map<string, string>();
      const conflictingClaudePartOwners = new Map<string, string>();
      if (adapter.sourceKind === 'claude') {
        for (const candidate of candidates) {
          const { sessionId, owner } = adapter.meta(candidate.path);
          const indexed = indexedClaudeOwners.get(sessionId);
          // The turn budget can stop the ingest loop before it visits every
          // candidate. Build the repair map from the complete discovery set so
          // a partial sweep cannot revert owners repaired by a full sweep.
          const selected = indexed ?? owner;
          if (selected) ownerBackfill.set(sessionId, selected);
          if (owner && indexed && owner !== indexed) conflictingClaudePartOwners.set(sessionId, indexed);
        }
      }
      const codexMetadataBackfill = new Map<number, CodexAdvSessionMetadata>();
      let ompOwnersByAdvSession = new Map<number, string>();
      if (adapter.sourceKind === 'omp') {
        const managedIds = candidates
          .map((candidate) => adapter.meta(candidate.path).advSessionId)
          .filter((id): id is number => id != null);
        try {
          ompOwnersByAdvSession = await measure('state', () => loadOmpSessionOwners(sql, managedIds));
        } catch (err) {
          stats.errors += 1;
          if ((stats.errorSample ??= []).length < 3) {
            stats.errorSample.push(`omp owner lookup: ${(err as Error).message.slice(0, 200)}`);
          }
        }
      }
      for (const cand of candidates) {
        if (budget.turns <= 0 || filesThisAdapter >= MAX_FILES_PER_TICK) break;
        stats.filesScanned += 1;
        try {
          const metadataStarted = performance.now();
          const st = stateMap.get(cand.path) ?? { ...EMPTY_STATE };
          const meta = adapter.meta(cand.path);
          const owner = indexedClaudeOwners.get(meta.sessionId) ?? meta.owner ?? (
            adapter.sourceKind === 'omp' && meta.advSessionId != null
              ? ompOwnersByAdvSession.get(meta.advSessionId) ?? null
              : null
          );
          if (owner && adapter.sourceKind !== 'claude') ownerBackfill.set(meta.sessionId, owner);
          // Collect metadata BEFORE the byte-offset short circuit. A paused
          // session commonly has no late transcript turn, but its already
          // indexed rollout still carries the native id/config needed to repair
          // the adv row used by interval-overlap readers.
          if (adapter.sourceKind === 'codex') {
            const home = codexAdvSessionHome(cand.path);
            // Candidates are newest first; only the first valid rollout's
            // config can contribute to this adv row. Avoid reading configs
            // whose metadata would be discarded. This map lasts one sweep,
            // so later sweeps and single-file repairs still read fresh config.
            if (home && !codexMetadataBackfill.has(home.advSessionId)) {
              const codexMeta = codexAdvSessionMetadata(cand.path, meta.sessionId);
              if (codexMeta) codexMetadataBackfill.set(home.advSessionId, codexMeta);
            }
          }
          phaseMs.metadata += performance.now() - metadataStarted;
          if (cand.size <= st.byte_offset) continue; // nothing new
          filesThisAdapter += 1;
          const { turns, parts, newOffset, promptCount, responseCount, toolCallCount, lastInferenceId, usage } =
            await measure('decode', () => readNewLines(
              cand.path, st.byte_offset, adapter.parseLine, adapter.classifyLine, st.last_inference_id, adapter.usageOf,
              substitutionRows, adapter.parseParts,
            ));
          if (newOffset === st.byte_offset) continue;
          const rows: TurnRow[] = turns.map((t, i) => ({
            workspace_id: 'default',
            source_kind: adapter.sourceKind,
            session_id: t.sessionId ?? meta.sessionId,
            turn_idx: st.turn_count + i,
            ts: t.ts ? t.ts.toISOString() : null,
            owner,
            harness_slug: null,
            cwd: t.cwd ?? null,
            speaker: t.speaker,
            text: t.text,
            prompt_hash: t.promptHash ?? null,
          }));
          stats.turnsInserted += await measure('writes', () => insertTurns(sql, rows));
          // P-001 faithful parts — best-effort by contract (see insertParts):
          // a parts failure costs the render pane its fidelity for this window,
          // never the recall index and never the offset.
          try {
            stats.partsInserted = (stats.partsInserted ?? 0) + await measure('writes', () => insertParts(sql, partRowsFrom(parts, {
              sourceKind: adapter.sourceKind,
              sessionId: meta.sessionId,
              owner,
              partCount: st.part_count,
            })));
          } catch (err) {
            if ((stats.errorSample ??= []).length < 3) {
              stats.errorSample.push(`parts ${meta.sessionId}: ${(err as Error).message.slice(0, 160)}`);
            }
          }
          await measure('writes', () => writeState(sql, adapter.sourceKind, cand.path, {
            byte_offset: newOffset,
            turn_count: st.turn_count + turns.length,
            part_count: st.part_count + parts.length,
            short_user_turns_offset: st.short_user_turns_offset ?? st.byte_offset,
            prompt_count: st.prompt_count + promptCount,
            response_count: st.response_count + responseCount,
            tool_call_count: st.tool_call_count + toolCallCount,
            last_inference_id: lastInferenceId,
            counts_backfill_offset: newOffset,
            counts_backfill_last_inference_id: lastInferenceId,
            counts_backfilled_at: new Date().toISOString(),
            sessionId: meta.sessionId,
            mtimeMs: cand.mtimeMs,
          }));
          // P-002 — deliberately AFTER writeState and independently caught: the
          // substitution metric must never fail, retry, or wedge an ingest.
          try {
            await measure('writes', () => writeUsageRollup(sql, adapter.sourceKind, meta.sessionId, usage));
          } catch (err) {
            if ((stats.errorSample ??= []).length < 3) {
              stats.errorSample.push(`usage-rollup ${meta.sessionId}: ${(err as Error).message.slice(0, 160)}`);
            }
          }
          stats.filesIngested += 1;
          budget.turns -= turns.length;
        } catch (err) {
          stats.errors += 1;
          if ((stats.errorSample ??= []).length < 3) {
            stats.errorSample.push(`${cand.path.split('/').pop()}: ${(err as Error).message.slice(0, 200)}`);
          }
          // Record the error WITHOUT touching offsets — resetting byte_offset/
          // turn_count on a transient failure would restart turn_idx at 0 and
          // silently drop every subsequent turn to ON CONFLICT DO NOTHING.
          try {
            await measure('writes', () => sql`
              UPDATE harness_shared.session_ingest_state
                 SET last_error = ${(err as Error).message.slice(0, 300)}, updated_at = now()
               WHERE source_kind = ${adapter.sourceKind} AND file_path = ${cand.path}
            `);
          } catch { /* bookkeeping best-effort */ }
        }
      }
      await measureMetadataBackfill(adapter.sourceKind, 'sessionOwners', ownerBackfill.size,
        (receipt) => backfillSessionOwners(sql, adapter.sourceKind, ownerBackfill,
          (inputSha256) => { receipt.inputSha256 = inputSha256; }));
      if (adapter.sourceKind === 'claude') {
        await measureMetadataBackfill(adapter.sourceKind, 'partOwners', conflictingClaudePartOwners.size,
          (receipt) => backfillClaudePartOwners(sql, conflictingClaudePartOwners,
            (inputSha256) => { receipt.inputSha256 = inputSha256; }));
      }
      if (adapter.sourceKind === 'codex') {
        await measureMetadataBackfill(adapter.sourceKind, 'codexAdvSessions', codexMetadataBackfill.size,
          () => backfillCodexAdvSessions(sql, codexMetadataBackfill));
      }
    }

    if (budget.turns > 0) {
      try {
        stats.chatsIngested = await measure('chats', () => syncAgentChats(sql, budget));
      } catch (err) {
        stats.errors += 1;
        console.warn(`[session-ingest] agent_chat sync failed: ${(err as Error).message}`);
      }
    }

    const durationMs = performance.now() - started;
    phaseMs.other = Math.max(0, durationMs - Object.values(phaseMs).reduce((sum, ms) => sum + ms, 0));
    stats.phaseMs = Object.fromEntries(
      Object.entries(phaseMs).map(([phase, ms]) => [phase, Math.round(ms * 10) / 10]),
    ) as typeof phaseMs;
    stats.durationMs = Math.round(durationMs);
    __sweep.last = stats;
    return stats;
  } finally {
    __sweep.running = false;
  }
}
