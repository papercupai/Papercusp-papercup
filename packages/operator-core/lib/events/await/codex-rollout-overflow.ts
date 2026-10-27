import { closeSync, fstatSync, openSync, readdirSync, readSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

/**
 * Codex context-window overflow detector for host-less wake resumes
 * (WI-6554700010008894).
 *
 * A Codex thread that is woken with `codex exec resume <id> <wake>` persists every
 * wake's prompt into its rollout, even when the turn fails. A wake loop that keeps
 * failing therefore grows the thread until its history no longer fits the model
 * window. Measured on 2026-10-12: one thread gained ~1.78M tokens over 1,491 aborted
 * wakes against an 828,400-token window. At that point neither a resume nor Codex's
 * own (remote) compaction can fit the history, so every later wake fails the same
 * way. Only a relaunch onto a fresh thread recovers it.
 *
 * This module reads the persisted rollout and counts how many of the most recent
 * turns ended in a context-window overflow, so the wake executor can quarantine the
 * incarnation instead of re-firing it forever.
 */

/** Trailing overflowed turns on the persisted rollout that quarantine a Codex thread. */
export const CODEX_CONTEXT_OVERFLOW_POISON_TURNS = 2;

/** Bounded tail read: the wake hot path must never load a multi-megabyte rollout whole. */
export const CODEX_ROLLOUT_TAIL_BYTES = 2 * 1024 * 1024;

const OVERFLOW_RE = /context_length_exceeded|exceeds the context window/i;
// A usage-limit wall says nothing about whether the thread fits. It is transient
// (the account resets) and the outcome classifier already backs it off, so it
// neither counts toward nor breaks an overflow streak.
const USAGE_LIMIT_RE = /usage_limit_exceeded|hit your usage limit/i;
const CODEX_SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CodexRolloutOverflowAnalysis {
  /** Most recent turns that ended in a context-window overflow, usage-limit turns skipped. */
  trailingContextOverflowTurns: number;
  /** Rollout timestamp of the newest overflowed turn, when there is one. */
  lastOverflowAt: string | null;
  /** The window Codex reported on the newest `task_started`, when present. */
  modelContextWindow: number | null;
  /**
   * How the turn opened by the newest `task_started` ended (WI-6554700010029533).
   * Null while that turn is still running, or when the text holds no turn start.
   * A consult answer session is judged by this: a first turn that ended on a
   * usage limit is a walled account, not a responder that is still thinking.
   */
  currentTurnOutcome: 'ok' | 'context-overflow' | 'usage-limit' | 'error' | 'aborted' | null;
  /** Bounded provider error text of that ending, when it carried one. */
  currentTurnErrorEvidence: string | null;
}

type TurnTerminal =
  | { kind: 'ok' }
  | { kind: 'overflow'; at: string | null; evidence: string }
  | { kind: 'usage-limit'; evidence: string }
  | { kind: 'error'; evidence: string }
  | { kind: 'aborted' };

const ERROR_EVIDENCE_MAX_CHARS = 200;

/** The provider's own message when the error carries one, else its serialized form; bounded. */
function errorEvidence(error: unknown, serialized: string): string {
  const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : null;
  const text = typeof message === 'string' && message.trim() ? message.trim() : serialized;
  return text.slice(0, ERROR_EVIDENCE_MAX_CHARS);
}

interface RolloutRecord {
  timestamp?: unknown;
  type?: unknown;
  payload?: { type?: unknown; error?: unknown; model_context_window?: unknown } | null;
}

function classifyTaskComplete(record: RolloutRecord): TurnTerminal {
  const error = record.payload?.error;
  if (error == null) return { kind: 'ok' };
  const text = typeof error === 'string' ? error : JSON.stringify(error);
  const evidence = errorEvidence(error, text);
  if (OVERFLOW_RE.test(text)) {
    return { kind: 'overflow', at: typeof record.timestamp === 'string' ? record.timestamp : null, evidence };
  }
  if (USAGE_LIMIT_RE.test(text)) return { kind: 'usage-limit', evidence };
  return { kind: 'error', evidence };
}

const CURRENT_TURN_OUTCOME: Record<TurnTerminal['kind'], NonNullable<CodexRolloutOverflowAnalysis['currentTurnOutcome']>> = {
  ok: 'ok',
  overflow: 'context-overflow',
  'usage-limit': 'usage-limit',
  error: 'error',
  aborted: 'aborted',
};

/**
 * Analyse rollout JSONL text (possibly a tail that starts mid-line). Pure.
 *
 * Turn terminals are `task_complete` (with or without `error`) and `turn_aborted`.
 * Walking back from the newest terminal: overflow counts, a usage-limit failure is
 * skipped, and anything else (a completed turn, an abort, another error) ends the
 * streak, because it is not evidence that the thread is too large.
 */
export function analyzeCodexRolloutText(text: string): CodexRolloutOverflowAnalysis {
  const terminals: TurnTerminal[] = [];
  let modelContextWindow: number | null = null;
  let currentTurnStart: number | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record: RolloutRecord;
    try {
      record = JSON.parse(line) as RolloutRecord;
    } catch {
      continue; // a bounded tail can begin in the middle of a record
    }
    if (record?.type !== 'event_msg' || !record.payload) continue;
    const kind = record.payload.type;
    if (kind === 'task_started') {
      // The newest turn's ending is the first terminal recorded after it starts.
      currentTurnStart = terminals.length;
      const window = record.payload.model_context_window;
      if (typeof window === 'number' && Number.isFinite(window) && window > 0) modelContextWindow = window;
    } else if (kind === 'task_complete') {
      terminals.push(classifyTaskComplete(record));
    } else if (kind === 'turn_aborted') {
      terminals.push({ kind: 'aborted' });
    }
  }

  let trailing = 0;
  let lastOverflowAt: string | null = null;
  for (let i = terminals.length - 1; i >= 0; i -= 1) {
    const terminal = terminals[i];
    if (terminal.kind === 'usage-limit') continue;
    if (terminal.kind !== 'overflow') break;
    trailing += 1;
    if (lastOverflowAt == null) lastOverflowAt = terminal.at;
  }
  const current = currentTurnStart === null ? undefined : terminals[currentTurnStart];
  return {
    trailingContextOverflowTurns: trailing,
    lastOverflowAt,
    modelContextWindow,
    currentTurnOutcome: current ? CURRENT_TURN_OUTCOME[current.kind] : null,
    currentTurnErrorEvidence: current && 'evidence' in current ? current.evidence : null,
  };
}

/** Analyse the tail of a rollout file; null when it cannot be read. */
export function analyzeCodexRolloutFile(
  path: string,
  tailBytes: number = CODEX_ROLLOUT_TAIL_BYTES,
): CodexRolloutOverflowAnalysis | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const total = fstatSync(fd).size;
    const size = Math.max(0, Math.min(total, tailBytes));
    const buf = Buffer.alloc(size);
    if (size > 0) readSync(fd, buf, 0, size, total - size);
    return analyzeCodexRolloutText(buf.toString('utf8'));
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        // best-effort close on a read-only diagnostic path
      }
    }
  }
}

/**
 * The rollout `<codexHome>/sessions/**​/rollout-*-<sessionId>.jsonl` for one native
 * session id, or null. When several match (should not happen), the last one in
 * directory order wins.
 */
export function findCodexRolloutPath(codexHome: string, sessionId: string): string | null {
  if (!CODEX_SESSION_UUID_RE.test(sessionId)) return null;
  const suffix = `-${sessionId.toLowerCase()}.jsonl`;
  let found: string | null = null;
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.startsWith('rollout-') && entry.name.toLowerCase().endsWith(suffix)) found = path;
    }
  };
  walk(join(codexHome, 'sessions'));
  return found;
}
