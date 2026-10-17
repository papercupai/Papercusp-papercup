/**
 * Codex rollout-persistence watchdog (WI-4663).
 *
 * Codex 0.144+ can keep accepting prompts in a managed CODEX_HOME while
 * updating history.jsonl but stop appending the rollout JSONL. That leaves the
 * live session invisible to session search and makes turn provenance
 * unverifiable. This process-level watchdog compares the two files while the
 * recorded Codex process is alive and raises one deduplicated escalation per
 * affected session.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { codexHomeForSessionKey } from '@papercusp/orchestrator/session-launch-dirs';
import { coordScopeReady, coordScopeWorkspace } from '../agent-tools/coordination/log';
import { MESSAGE_GC_RETENTION_DAYS } from '../agent-tools/coordination/message-log-gc';
import { broadcastSevereEvent } from '../severe-event-broadcast';
import { resolveAlarm, type AlarmAttentionDeps } from '../alarm-attention';

const DEFAULT_HISTORY_FRESH_MS = 5 * 60_000;
const DEFAULT_ROLLOUT_LAG_MS = 15 * 60_000;
const DEFAULT_WATCHDOG_INTERVAL_MS = 5 * 60_000;
const DEFAULT_PROVIDER_FAILURE_CONSECUTIVE = 3;
// The condition reconciler treats 120 minutes without a new signal as quiet.
// Do not keep re-opening alarms from an old, still-present rollout tail after it quiets.
const DEFAULT_PROVIDER_FAILURE_FRESH_MS = 2 * 60 * 60_000;
export const CODEX_PROVIDER_ERROR_TAIL_BYTES = 512 * 1024;
const PHASE_PREFIX = 'codex-rollout-stall:';
const PROVIDER_FAILURE_PHASE_PREFIX = 'codex-provider-failure:';
const CODEX_ROLLOUT_CONDITION_PREFIX = 'alarm:codex-rollout-';
const PROVIDER_ERROR_EVIDENCE_LIMIT = 6;
const PROVIDER_ERROR_TEXT_LIMIT = 500;

export type CodexProviderErrorSource = 'event_msg:error' | 'event_msg:task_complete';

export interface CodexProviderError {
  source: CodexProviderErrorSource;
  code: string;
  rawCode: string;
  message: string | null;
  retryAt: string | null;
  account: string | null;
  timestamp: string | null;
  turnKey: string | null;
}

export interface CodexProviderFailureRecurrence {
  consecutiveFailures: number;
  threshold: number;
  dead: boolean;
  latest: CodexProviderError | null;
  failures: CodexProviderError[];
  /** Only the latest terminal can prove recovery; no terminal is not success. */
  latestSuccessAtMs?: number | null;
}

export type CodexProviderFailureDisposition = 'backoff' | 'park' | 'carry_recovery';

/**
 * Provider failure recurrence is an observation, not a lifecycle authority.
 * These dispositions tell the owning loop what kind of recovery is appropriate;
 * none of them ends the tracked adv session or releases its work.
 */
export function providerFailureDisposition(error: CodexProviderError): CodexProviderFailureDisposition {
  const text = `${error.code} ${error.rawCode} ${error.message ?? ''}`.toLowerCase();
  if (/context|prompt.{0,20}(?:long|too|exceed)|token.{0,20}(?:limit|window)/i.test(text)) {
    return 'carry_recovery';
  }
  if (/auth|unauthor|forbidden|credential|token.{0,20}(?:invalid|expired)|quota|usage|limit/i.test(text)) {
    return 'park';
  }
  return 'backoff';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function textFromUnknown(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  const record = asRecord(value);
  if (!record) return null;
  return firstString(
    record.message,
    record.detail,
    record.reason,
    record.description,
    textFromUnknown(record.error),
  );
}

function codeFromUnknown(...values: unknown[]): string | null {
  for (const value of values) {
    const direct = firstString(value);
    if (direct) return direct;
    const record = asRecord(value);
    if (!record) continue;
    const nested = firstString(
      record.codex_error_info,
      record.error_code,
      record.code,
      record.kind,
      record.type,
    );
    if (nested) return nested;
  }
  return null;
}

function clipProviderText(value: string | null): string | null {
  if (!value) return null;
  return value.length <= PROVIDER_ERROR_TEXT_LIMIT
    ? value
    : value.slice(0, PROVIDER_ERROR_TEXT_LIMIT) + '…';
}

function normalizeProviderErrorCode(rawCode: string): string {
  const normalized = rawCode
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[.\s-]+/g, '_')
    .toLowerCase();
  if (normalized === 'usagelimitexceeded') return 'usage_limit_exceeded';
  if (normalized === 'ratelimitexceeded') return 'rate_limit_exceeded';
  return normalized || 'provider_error';
}

function retryAtFromMessage(message: string | null): string | null {
  if (!message) return null;
  const match = message.match(/\b(?:try again|retry|resets?|reset)\s+(?:again\s+)?(?:at|on)?\s*([^.!?\n]{2,160})/i);
  return match?.[1]?.trim() || null;
}

/**
 * Classify the native Codex terminal records that the session-ingest text
 * parser intentionally skips. A task_complete error is one failed turn even
 * when an earlier event_msg:error described the same failure.
 */
export function classifyCodexProviderError(line: string): CodexProviderError | null {
  const record = parseEventMsgLine(line);
  return record ? classifyCodexProviderRecord(record) : null;
}

/**
 * Parse a rollout line only when it can be a terminal record. Both terminal
 * classifiers require `type: 'event_msg'`, and nearly every rollout line is a
 * `response_item` (often a large tool output), so the substring prefilter skips
 * their JSON.parse entirely. Codex writes serde_json, which never \u-escapes
 * ASCII, so a real event_msg record always carries the literal `"event_msg"`.
 * Each line is parsed at most once (WI-6554700010008587: the recurrence scan
 * used to parse every line twice, ~2.7% of bg-host main thread).
 */
function parseEventMsgLine(line: string): Record<string, unknown> | null {
  if (!line.includes('"event_msg"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  return record && record.type === 'event_msg' ? record : null;
}

function classifyCodexProviderRecord(record: Record<string, unknown>): CodexProviderError | null {
  const payload = asRecord(record.payload);
  if (!payload) return null;
  const payloadType = typeof payload.type === 'string' ? payload.type : '';
  if (payloadType !== 'error' && payloadType !== 'task_complete') return null;
  const error = asRecord(payload.error);
  const hasError =
    payloadType === 'error' ||
    payload.error != null ||
    payload.codex_error_info != null ||
    payload.status === 'error' ||
    payload.status === 'failed' ||
    payload.status === 'failure';
  if (!hasError) return null;

  const rawCode =
    codeFromUnknown(
      payload.codex_error_info,
      error?.codex_error_info,
      payload.error_code,
      error?.code,
      payload.code,
      payload.error,
    ) ?? 'provider_error';
  const message = clipProviderText(
    firstString(
      payload.message,
      error?.message,
      error?.detail,
      textFromUnknown(payload.error),
      textFromUnknown(payload.codex_error_info),
    ),
  );
  const account = firstString(
    payload.account,
    payload.account_id,
    payload.provider_account,
    error?.account,
    error?.account_id,
  );
  const turnKey = firstString(
    payload.turn_id,
    payload.turnId,
    error?.turn_id,
    error?.turnId,
  );
  const source: CodexProviderErrorSource =
    payloadType === 'task_complete' ? 'event_msg:task_complete' : 'event_msg:error';
  return {
    source,
    code: normalizeProviderErrorCode(rawCode),
    rawCode,
    message,
    retryAt: retryAtFromMessage(message),
    account,
    timestamp: firstString(record.timestamp, payload.timestamp),
    turnKey,
  };
}

function isCodexSuccessfulTerminalRecord(record: Record<string, unknown>): boolean {
  const payload = asRecord(record.payload);
  if (!payload) return false;
  const payloadType = typeof payload.type === 'string' ? payload.type : '';
  if (payloadType !== 'task_complete' && payloadType !== 'turn_completed') return false;
  return (
    payload.error == null &&
    payload.codex_error_info == null &&
    payload.status !== 'error' &&
    payload.status !== 'failed' &&
    payload.status !== 'failure'
  );
}

/**
 * Evaluate the trailing provider-failure streak in rollout lines. Native
 * Codex commonly writes both event_msg:error and task_complete.error for one
 * failed turn; those adjacent records are collapsed so the threshold counts
 * turns, not wire records. Any successful task/turn completion resets it.
 */
export function evaluateCodexProviderFailureRecurrence(
  lines: readonly string[],
  opts: { consecutiveFailures?: number } = {},
): CodexProviderFailureRecurrence {
  const threshold = Math.max(1, Math.floor(opts.consecutiveFailures ?? DEFAULT_PROVIDER_FAILURE_CONSECUTIVE));
  type Terminal =
    | { kind: 'failure'; error: CodexProviderError; lineIndex: number }
    | { kind: 'success'; atMs: number };
  const terminals: Terminal[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const record = parseEventMsgLine(lines[lineIndex] ?? '');
    if (!record) continue;
    const error = classifyCodexProviderRecord(record);
    if (error) {
      const previous = terminals[terminals.length - 1];
      const duplicateTaskError =
        error.source === 'event_msg:task_complete' &&
        previous?.kind === 'failure' &&
        previous.error.source === 'event_msg:error' &&
        (
          (error.turnKey != null && error.turnKey === previous.error.turnKey) ||
            (
              error.turnKey == null &&
              previous.error.turnKey == null &&
              (error.code === previous.error.code ||
                error.code === 'provider_error' ||
                previous.error.code === 'provider_error') &&
              lineIndex - previous.lineIndex <= 8
            )
        );
      if (duplicateTaskError) {
        terminals[terminals.length - 1] = { kind: 'failure', error, lineIndex };
      } else {
        terminals.push({ kind: 'failure', error, lineIndex });
      }
      continue;
    }
    if (isCodexSuccessfulTerminalRecord(record)) {
      const payload = asRecord(record.payload);
      const timestamp = firstString(record.timestamp, payload?.timestamp);
      terminals.push({ kind: 'success', atMs: timestamp ? Date.parse(timestamp) : Number.NaN });
    }
  }

  const failures: CodexProviderError[] = [];
  for (let index = terminals.length - 1; index >= 0; index -= 1) {
    const terminal = terminals[index];
    if (!terminal || terminal.kind === 'success') break;
    failures.unshift(terminal.error);
  }
  return {
    consecutiveFailures: failures.length,
    threshold,
    dead: failures.length >= threshold,
    latest: failures[failures.length - 1] ?? null,
    failures,
    latestSuccessAtMs: terminals.at(-1)?.kind === 'success'
      ? (terminals.at(-1) as { kind: 'success'; atMs: number }).atMs : null,
  };
}

/** Pure bounded-tail parser seam used by the filesystem reader and tests. */
export function scanCodexProviderFailureTail(
  tailText: string,
  opts: { consecutiveFailures?: number } = {},
): CodexProviderFailureRecurrence {
  return evaluateCodexProviderFailureRecurrence(tailText.split(/\r?\n/), opts);
}

export interface CodexRolloutPersistenceThresholds {
  historyFreshMs?: number;
  rolloutLagMs?: number;
}

export interface CodexRolloutPersistenceSnapshot {
  sessionId: string;
  ownerId: string;
  pidAlive: boolean;
  historyMtimeMs: number | null;
  rolloutMtimeMs: number | null;
}

export interface CodexRolloutPersistenceVerdict {
  stalled: boolean;
  reason: string | null;
}

const mins = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

/** Pure recurrence guard: only a live process with fresh history can alarm. */
export function evaluateCodexRolloutPersistence(
  snapshot: CodexRolloutPersistenceSnapshot,
  nowMs: number,
  opts: CodexRolloutPersistenceThresholds = {},
): CodexRolloutPersistenceVerdict {
  const historyFreshMs = opts.historyFreshMs ?? DEFAULT_HISTORY_FRESH_MS;
  const rolloutLagMs = opts.rolloutLagMs ?? DEFAULT_ROLLOUT_LAG_MS;
  if (!Number.isFinite(nowMs) || nowMs < 0 || !Number.isFinite(historyFreshMs) || historyFreshMs < 0 ||
      !Number.isFinite(rolloutLagMs) || rolloutLagMs < 0 ||
      (snapshot.historyMtimeMs !== null && !measuredTime(snapshot.historyMtimeMs, nowMs)) ||
      (snapshot.rolloutMtimeMs !== null && !measuredTime(snapshot.rolloutMtimeMs, nowMs))) {
    return { stalled: false, reason: null };
  }
  if (!snapshot.pidAlive || snapshot.historyMtimeMs == null) return { stalled: false, reason: null };

  const historyAgeMs = nowMs - snapshot.historyMtimeMs;
  if (historyAgeMs > historyFreshMs) return { stalled: false, reason: null };

  const lagMs = snapshot.rolloutMtimeMs == null
    ? Number.POSITIVE_INFINITY
    : snapshot.historyMtimeMs - snapshot.rolloutMtimeMs;
  if (lagMs <= rolloutLagMs) return { stalled: false, reason: null };

  const rollout = snapshot.rolloutMtimeMs == null
    ? 'no rollout JSONL exists'
    : `rollout JSONL is ~${mins(lagMs)}m behind history.jsonl`;
  return {
    stalled: true,
    reason:
      `Codex process ${snapshot.ownerId} (session ${snapshot.sessionId}) is alive and wrote ` +
      `history.jsonl ~${mins(historyAgeMs)}m ago, but ${rollout}. ` +
      'Recent prompts may exist only in Codex process memory; relaunch or inspect the native session before it exits.',
  };
}

async function statMtime(path: string): Promise<number | null> {
  try {
    // Date.now() measures whole milliseconds; filesystem timestamps can carry
    // sub-millisecond precision. Compare both at the clock's measured precision.
    return Math.floor((await fs.stat(path)).mtimeMs);
  } catch {
    return null;
  }
}

interface LatestCodexRollout {
  path: string;
  mtimeMs: number;
}

async function latestRollout(codexHome: string): Promise<LatestCodexRollout | null> {
  return (await scanLatestRollout(codexHome)).rollout;
}

async function scanLatestRollout(codexHome: string): Promise<{ rollout: LatestCodexRollout | null; complete: boolean }> {
  const root = join(codexHome, 'sessions');
  let best: LatestCodexRollout | null = null;
  let complete = true;
  let years: string[];
  try { years = await fs.readdir(root); } catch (error) {
    return { rollout: null, complete: (error as NodeJS.ErrnoException).code === 'ENOENT' };
  }
  for (const year of years) {
    let months: string[];
    try { months = await fs.readdir(join(root, year)); } catch { complete = false; continue; }
    for (const month of months) {
      let days: string[];
      try { days = await fs.readdir(join(root, year, month)); } catch { complete = false; continue; }
      for (const day of days) {
        let files: string[];
        try { files = await fs.readdir(join(root, year, month, day)); } catch { complete = false; continue; }
        for (const file of files) {
          if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
          const path = join(root, year, month, day, file);
          const mtimeMs = await statMtime(path);
          if (mtimeMs == null || !Number.isFinite(mtimeMs) || mtimeMs < 0) complete = false;
          if (mtimeMs != null && (best == null || mtimeMs > best.mtimeMs)) {
            best = { path, mtimeMs };
          }
        }
      }
    }
  }
  return { rollout: best, complete };
}

/** Read at most `maxBytes` from the end of a rollout without loading the file. */
export async function readCodexRolloutTail(
  path: string,
  maxBytes = CODEX_PROVIDER_ERROR_TAIL_BYTES,
): Promise<string | null> {
  const limit = Number.isFinite(maxBytes)
    ? Math.max(1, Math.floor(maxBytes))
    : CODEX_PROVIDER_ERROR_TAIL_BYTES;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(path, 'r');
    const before = await handle.stat();
    const size = before.size;
    const length = Math.min(size, limit);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, size - length));
    const after = await handle.stat();
    if (bytesRead !== length || after.size !== size || after.mtimeMs !== before.mtimeMs ||
        after.ino !== before.ino || after.dev !== before.dev) return null;
    return buffer.toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * The latest Codex terminal after a loop fire, when that terminal is a structured
 * provider error. A later successful terminal clears an earlier failure; a terminal
 * with no usable timestamp also clears it because its ordering against the fire is
 * unknown. This is deliberately narrower than the watchdog's recurrence scan: the
 * loop reconciler needs the cause of this fire, not a session-wide failure streak.
 */
export function latestCodexProviderErrorAfter(
  tailText: string,
  afterMs: number,
): CodexProviderError | null {
  if (!Number.isFinite(afterMs)) return null;
  let latest: CodexProviderError | null = null;
  for (const line of tailText.split(/\r?\n/)) {
    const record = parseEventMsgLine(line);
    if (!record) continue;
    const error = classifyCodexProviderRecord(record);
    if (!error && !isCodexSuccessfulTerminalRecord(record)) continue;
    const payload = asRecord(record.payload);
    const timestamp = firstString(record.timestamp, payload?.timestamp);
    const timestampMs = timestamp ? Date.parse(timestamp) : Number.NaN;
    latest = Number.isFinite(timestampMs) && timestampMs > afterMs ? error : null;
  }
  return latest;
}

/**
 * Read the latest native Codex provider error after `afterMs` (a loop fire, or a host start).
 * `maxBytes` bounds the tail read; callers that sweep many sessions per call pass less than the
 * default, since a failed turn's terminal is the rollout's last line.
 */
export async function readCodexProviderErrorAfter(
  sessionKey: string | number,
  afterMs: number,
  maxBytes: number = CODEX_PROVIDER_ERROR_TAIL_BYTES,
): Promise<CodexProviderError | null> {
  if (!Number.isFinite(afterMs)) return null;
  const rollout = await latestRollout(codexHomeForSessionKey(sessionKey));
  if (!rollout || rollout.mtimeMs <= afterMs) return null;
  const tail = await readCodexRolloutTail(rollout.path, maxBytes);
  return tail == null ? null : latestCodexProviderErrorAfter(tail, afterMs);
}

async function readSnapshot(
  row: { id: number; owner_id: string; pid: number | null },
  pidAlive: (pid: number) => boolean,
): Promise<{ snapshot: CodexRolloutPersistenceSnapshot; rolloutPath: string | null; complete: boolean }> {
  const codexHome = codexHomeForSessionKey(row.id);
  const [historyMtimeMs, rollout] = await Promise.all([
    statMtime(join(codexHome, 'history.jsonl')),
    scanLatestRollout(codexHome),
  ]);
  return {
    snapshot: {
      sessionId: String(row.id),
      ownerId: row.owner_id,
      pidAlive: row.pid != null && pidAlive(row.pid),
      historyMtimeMs,
      rolloutMtimeMs: rollout.rollout?.mtimeMs ?? null,
    },
    rolloutPath: rollout.rollout?.path ?? null,
    complete: rollout.complete,
  };
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function escalationBody(snapshot: CodexRolloutPersistenceSnapshot, reason: string, nowMs: number): string {
  return JSON.stringify({
    kind: 'codex-rollout-persistence-watchdog',
    owner_id: snapshot.ownerId,
    session_id: snapshot.sessionId,
    emitted_at: nowMs,
    detail: reason,
  });
}

export interface CodexRolloutPersistenceWatchdogResult {
  stalledSessionIds: string[];
  alarmed: string[];
  recovered: string[];
  providerFailureSessionIds: string[];
  providerAlarmed: string[];
  providerPreservedSessionIds: string[];
  /** Compatibility field: provider recurrence never ends an adv session. */
  providerEndedSessionIds: string[];
  providerCleanupFailed: string[];
  providerRecovered: string[];
}

export interface CodexRolloutPersistenceWatchdogOptions extends CodexRolloutPersistenceThresholds {
  rail?: AlarmAttentionDeps;
  now?: () => number;
  /** Override the condition census while preserving the production reader's
   * workspace SQL client and measured clock inputs. */
  readOpenConditions?: (
    sql: Sql,
    now: number,
  ) => Promise<Array<{ conditionKey: string; openedAtMs: number }>>;
  pidAlive?: (pid: number) => boolean;
  intervalMs?: number;
  providerFailureConsecutive?: number;
  providerErrorTailBytes?: number;
  readRolloutTail?: typeof readCodexRolloutTail;
  /**
   * Per-rollout memo of the provider-failure scan, keyed by the rollout's size,
   * mtime, tail bound and threshold (WI-6554700010008587). The verdict is a pure
   * function of the tail bytes and the rollout is append-only, so an unchanged
   * (size, mtime) means an unchanged tail: the 512KB read and the parse are
   * skipped. Most open adv_sessions rows are idle or dead, so most passes hit.
   * Entries not seen in a pass are pruned. The process watchdog supplies one;
   * callers that omit it scan every rollout as before.
   */
  providerTailScanCache?: Map<string, ProviderTailScanCacheEntry>;
}

export interface ProviderTailScanCacheEntry {
  key: string;
  recurrence: CodexProviderFailureRecurrence | null;
}

async function statSizeMtime(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const st = await fs.stat(path);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

interface ProviderFailureObservation {
  advSessionId: number;
  snapshot: CodexRolloutPersistenceSnapshot;
  recurrence: CodexProviderFailureRecurrence;
  workspaceId: string | null;
}

function providerFailureReason(item: ProviderFailureObservation): string {
  const latest = item.recurrence.latest;
  const retry = latest?.retryAt ? `; retry hint: ${latest.retryAt}` : '';
  const disposition = latest ? providerFailureDisposition(latest) : 'backoff';
  return (
    `Codex process ${item.snapshot.ownerId} (session ${item.snapshot.sessionId}) has ` +
    `${item.recurrence.consecutiveFailures} consecutive provider failures ` +
    `(threshold ${item.recurrence.threshold}); latest=${latest?.code ?? 'unknown'}${retry}; ` +
    `disposition=${disposition}. The tracked session and its work are preserved; ` +
    'the owning loop must back off, park, or queue fresh-context recovery.'
  );
}

function providerEscalationBody(item: ProviderFailureObservation, nowMs: number): string {
  return JSON.stringify({
    kind: 'codex-provider-failure-watchdog',
    owner_id: item.snapshot.ownerId,
    session_id: item.snapshot.sessionId,
    emitted_at: nowMs,
    consecutive_failures: item.recurrence.consecutiveFailures,
    threshold: item.recurrence.threshold,
    detail: providerFailureReason(item),
    failures: item.recurrence.failures.slice(-PROVIDER_ERROR_EVIDENCE_LIMIT),
  });
}

export function codexRolloutConditionKey(
  kind: 'persistence' | 'provider', workspaceId: string | null, sessionId: string, ownerId: string,
): string {
  return `alarm:codex-rollout-${kind}:` + encodeURIComponent(JSON.stringify([workspaceId, sessionId, ownerId]));
}

function parseCodexRolloutConditionSession(
  conditionKey: string,
): { kind: 'persistence' | 'provider'; sessionId: string } | null {
  const kind = conditionKey.startsWith('alarm:codex-rollout-provider:')
    ? 'provider'
    : conditionKey.startsWith('alarm:codex-rollout-persistence:') ? 'persistence' : null;
  if (!kind) return null;
  try {
    const identity: unknown = JSON.parse(decodeURIComponent(
      conditionKey.slice(`alarm:codex-rollout-${kind}:`.length),
    ));
    if (!Array.isArray(identity) || identity.length !== 3 ||
        !(identity[0] === null || typeof identity[0] === 'string') ||
        typeof identity[1] !== 'string' || !/^\d+$/.test(identity[1]) ||
        typeof identity[2] !== 'string' || !identity[2].trim()) return null;
    const sessionId = Number(identity[1]);
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) return null;
    return { kind, sessionId: String(sessionId) };
  } catch {
    return null;
  }
}

function measuredTime(value: unknown, now: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= now;
}

async function readOpenCodexConditions(
  sql: Sql,
  now: number,
): Promise<Array<{ conditionKey: string; openedAtMs: number }>> {
  // The generic conditions reader is deliberately capped at the newest 25k
  // condition envelopes across every subsystem. Codex rollout alarms are
  // one-shot, so an old open key can fall out of that window without any new
  // signal to pull it back in. That made the ended-session cleanup below miss
  // durable adv_sessions end markers. Query this small family directly while
  // keeping the same 30-day horizon as message-log GC; unrelated condition
  // traffic can no longer hide a Codex episode from its lifecycle resolver.
  const sinceBound = new Date(now - MESSAGE_GC_RETENTION_DAYS * 86_400_000).toISOString();
  const keyPattern = `${CODEX_ROLLOUT_CONDITION_PREFIX}%`;
  await coordScopeReady();
  const workspaceId = coordScopeWorkspace();
  const rows = await sql<Array<{ body: unknown }>>`
    SELECT body
      FROM harness_shared.coord_event_log
     WHERE workspace_id = ${workspaceId}
       AND surface = 'messages'
       AND ts >= ${sinceBound}
       AND (body ? 'condition_key' OR body ? 'resolves_condition' OR body ? 'resolves_conditions')
       AND (
         body->>'condition_key' LIKE ${keyPattern}
         OR body->>'resolves_condition' LIKE ${keyPattern}
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(body->'resolves_conditions') = 'array'
                 THEN body->'resolves_conditions' ELSE '[]'::jsonb END
             ) AS resolved(condition_key)
            WHERE resolved.condition_key LIKE ${keyPattern}
         )
       )
     ORDER BY id ASC
  `;
  const { computeConditionStates } = await import('../agent-tools/coordination/tools/conditions');
  const envelopes = rows.map((row) =>
    (typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as Record<string, unknown>,
  );
  return computeConditionStates(envelopes)
    .filter(condition => condition.open && condition.condition_key.startsWith(CODEX_ROLLOUT_CONDITION_PREFIX))
    .map(condition => ({ conditionKey: condition.condition_key,
      openedAtMs: condition.open_since ? Date.parse(condition.open_since) : Number.NaN }));
}

/** One cross-process-safe watchdog pass. Never throws to its scheduler. */
export async function checkCodexRolloutPersistence(
  sql: Sql,
  opts: CodexRolloutPersistenceWatchdogOptions = {},
): Promise<CodexRolloutPersistenceWatchdogResult> {
  const out: CodexRolloutPersistenceWatchdogResult = {
    stalledSessionIds: [],
    alarmed: [],
    recovered: [],
    providerFailureSessionIds: [],
    providerAlarmed: [],
    providerPreservedSessionIds: [],
    providerEndedSessionIds: [],
    providerCleanupFailed: [],
    providerRecovered: [],
  };
  try {
    const rows = await sql<Array<{ id: number; owner_id: string; pid: number | null; workspace_id: string | null }>>`
      SELECT id, coord_owner_id AS owner_id, pid, workspace_id
        FROM harness_shared.adv_sessions
       WHERE agent = 'codex' AND ended_at IS NULL AND coord_owner_id IS NOT NULL
    `;
    let now = (opts.now ?? Date.now)();
    if (!measuredTime(now, now)) return out;
    let episodes: Array<{ conditionKey: string; openedAtMs: number }> = [];
    let episodesKnown = false;
    try {
      episodes = opts.readOpenConditions
        ? await opts.readOpenConditions(sql, now)
        : await readOpenCodexConditions(sql, now);
      episodesKnown = true;
    } catch { /* Unknown state cannot prove an old condition recovered. */ }
    const healthyPersistencePhases = new Set<string>();
    const healthyProviderPhases = new Set<string>();
    const activeSessionIds = new Set(rows
      .filter(row => row && Number.isSafeInteger(row.id) && row.id > 0)
      .map(row => String(row.id)));
    // These alarms are one-shot, so silence cannot establish recovery. Session
    // termination is stronger evidence: once the adv row is no longer active,
    // no future provider success can arrive to resolve its condition. Close only
    // exact Codex rollout keys whose session has a durable ended_at marker;
    // a missing row or unreadable census is not proof of termination.
    if (episodesKnown) {
      const endedCandidates = episodes
        .map(episode => ({ episode, identity: parseCodexRolloutConditionSession(episode.conditionKey) }))
        .filter(item => item.identity && !activeSessionIds.has(item.identity.sessionId));
      const candidateIds = [...new Set(endedCandidates.map(item => Number(item.identity!.sessionId)))];
      let endedSessionIds = new Set<string>();
      if (candidateIds.length > 0) {
        try {
          const endedRows = await sql<Array<{ id: number }>>`
            SELECT id
              FROM harness_shared.adv_sessions
             WHERE agent = 'codex' AND ended_at IS NOT NULL AND id = ANY(${candidateIds})
          `;
          endedSessionIds = new Set(endedRows
            .filter(row => row && Number.isSafeInteger(row.id) && row.id > 0)
            .map(row => String(row.id)));
        } catch { /* An unreadable ended-session census cannot prove recovery. */ }
      }
      for (const { episode, identity } of endedCandidates) {
        if (!identity || !endedSessionIds.has(identity.sessionId)) continue;
        if (await resolveAlarm(episode.conditionKey, 'codex-rollout-watchdog', opts.rail)) {
          if (identity.kind === 'provider') {
            healthyProviderPhases.add(PROVIDER_FAILURE_PHASE_PREFIX + identity.sessionId);
          } else {
            healthyPersistencePhases.add(PHASE_PREFIX + identity.sessionId);
          }
        }
      }
    }
    const alive = opts.pidAlive ?? defaultPidAlive;
    const stalled: Array<{
      snapshot: CodexRolloutPersistenceSnapshot;
      reason: string;
      workspaceId: string | null;
    }> = [];
    const providerFailures: ProviderFailureObservation[] = [];
    const scannedPaths = new Set<string>();
    const registrations = new Map<number, number>();
    for (const row of rows) if (row) registrations.set(row.id, (registrations.get(row.id) ?? 0) + 1);
    for (const row of rows) {
      // A malformed/ambiguous registration cannot identify an episode or prove recovery.
      if (!row || !(typeof row.id === 'number' && Number.isSafeInteger(row.id) && row.id > 0) ||
          typeof row.owner_id !== 'string' || !row.owner_id.trim() ||
          !(row.workspace_id === null || (typeof row.workspace_id === 'string' && !!row.workspace_id.trim())) ||
          !(row.pid === null || (Number.isSafeInteger(row.pid) && row.pid > 0)) ||
          registrations.get(row.id) !== 1) continue;
      const read = await readSnapshot(row, alive);
      // Snapshot reads are asynchronous. A file written during the read may be
      // newer than the sweep's start without being future evidence.
      now = (opts.now ?? Date.now)();
      if (!measuredTime(now, now)) continue;
      const snapshot = read.snapshot;
      const verdict = evaluateCodexRolloutPersistence(snapshot, now, opts);
      const persistenceKey = codexRolloutConditionKey('persistence', row.workspace_id, snapshot.sessionId, row.owner_id);
      const providerKey = codexRolloutConditionKey('provider', row.workspace_id, snapshot.sessionId, row.owner_id);
      if (read.complete && verdict.stalled && verdict.reason) {
        stalled.push({ snapshot, reason: verdict.reason, workspaceId: row.workspace_id });
      } else if (read.complete && snapshot.pidAlive && measuredTime(snapshot.historyMtimeMs, now) &&
          measuredTime(snapshot.rolloutMtimeMs, now) &&
          Number.isFinite(opts.historyFreshMs ?? DEFAULT_HISTORY_FRESH_MS) && (opts.historyFreshMs ?? DEFAULT_HISTORY_FRESH_MS) >= 0 &&
          Number.isFinite(opts.rolloutLagMs ?? DEFAULT_ROLLOUT_LAG_MS) && (opts.rolloutLagMs ?? DEFAULT_ROLLOUT_LAG_MS) >= 0 &&
          now - snapshot.historyMtimeMs <= (opts.historyFreshMs ?? DEFAULT_HISTORY_FRESH_MS) &&
          snapshot.historyMtimeMs - snapshot.rolloutMtimeMs <= (opts.rolloutLagMs ?? DEFAULT_ROLLOUT_LAG_MS) &&
          episodes.some(episode => episode.conditionKey === persistenceKey && measuredTime(episode.openedAtMs, now) &&
            snapshot.rolloutMtimeMs! >= episode.openedAtMs)) {
        if (await resolveAlarm(persistenceKey, 'codex-rollout-watchdog', opts.rail)) {
          healthyPersistencePhases.add(PHASE_PREFIX + snapshot.sessionId);
        }
      }
      // EI-22057873022417601: provider terminal records are authoritative even
      // when adv_sessions.pid is NULL. Interactive psu sessions (and their
      // carry-respawn successors) can keep one open adv row without a launcher
      // pid while the managed host and native rollout remain live. Gating this
      // scan on pidAlive made every such session invisible to the three-failure
      // cleanup: the affected successor accepted five turns, each ending in
      // task_complete.error, while the watchdog skipped its readable rollout.
      //
      // The PID gate still belongs to the rollout-persistence freshness alarm
      // above, where a dead process must not be called stalled. It is neither
      // needed nor desirable here: the query already selects non-ended Codex
      // rows, a successful terminal resets the trailing failure streak, and a
      // stale open row whose rollout ends in repeated provider failures should
      // be closed by this cleanup too.
      if (read.complete && read.rolloutPath && measuredTime(snapshot.rolloutMtimeMs, now)) {
        const tailBytes = opts.providerErrorTailBytes ?? CODEX_PROVIDER_ERROR_TAIL_BYTES;
        const cache = opts.providerTailScanCache;
        let cacheKey: string | null = null;
        let cached: ProviderTailScanCacheEntry | undefined;
        if (cache) {
          scannedPaths.add(read.rolloutPath);
          const st = await statSizeMtime(read.rolloutPath);
          if (st) {
            cacheKey = `${st.size}:${st.mtimeMs}:${tailBytes}:${opts.providerFailureConsecutive ?? ''}`;
            const hit = cache.get(read.rolloutPath);
            if (hit && hit.key === cacheKey) cached = hit;
          }
        }
        let recurrence: CodexProviderFailureRecurrence | null;
        if (cached) {
          recurrence = cached.recurrence;
        } else {
          let tail: string | null = null;
          try {
            tail = await (opts.readRolloutTail ?? readCodexRolloutTail)(read.rolloutPath, tailBytes);
          } catch (e) {
            console.warn(
              `[codex-rollout-watchdog] provider tail read failed for session ${snapshot.sessionId}: ` +
                `${e instanceof Error ? e.message : String(e)}`,
            );
          }
          recurrence = tail != null
            ? scanCodexProviderFailureTail(tail, { consecutiveFailures: opts.providerFailureConsecutive })
            : null;
          // Cache only a completed read; a failed read is retried next pass. A rollout
          // that grows between the stat and the read stores a newer verdict under the
          // older key, which the next pass's larger size invalidates.
          if (cache && cacheKey && recurrence) cache.set(read.rolloutPath, { key: cacheKey, recurrence });
        }
        const latestFailureAt = recurrence?.latest?.timestamp
          ? Date.parse(recurrence.latest.timestamp)
          : snapshot.rolloutMtimeMs;
        if (recurrence?.dead && latestFailureAt != null && measuredTime(latestFailureAt, now) &&
            now - latestFailureAt <= DEFAULT_PROVIDER_FAILURE_FRESH_MS) {
          providerFailures.push({
            advSessionId: row.id,
            snapshot,
            recurrence,
            workspaceId: row.workspace_id,
          });
        } else if (recurrence && recurrence.consecutiveFailures === 0 && measuredTime(recurrence.latestSuccessAtMs, now) &&
            episodes.some(episode => episode.conditionKey === providerKey && measuredTime(episode.openedAtMs, now) &&
              recurrence!.latestSuccessAtMs! >= episode.openedAtMs)) {
          if (await resolveAlarm(providerKey, 'codex-provider-failure-watchdog', opts.rail)) {
            healthyProviderPhases.add(PROVIDER_FAILURE_PHASE_PREFIX + snapshot.sessionId);
          }
        }
      }
    }
    if (opts.providerTailScanCache) {
      for (const path of opts.providerTailScanCache.keys()) {
        if (!scannedPaths.has(path)) opts.providerTailScanCache.delete(path);
      }
    }
    out.stalledSessionIds = stalled.map((item) => item.snapshot.sessionId);
    out.providerFailureSessionIds = providerFailures.map((item) => item.snapshot.sessionId);

    const newly: typeof stalled = [];
    for (const item of stalled) {
      try {
        const event = {
          conditionKey: codexRolloutConditionKey('persistence', item.workspaceId, item.snapshot.sessionId, item.snapshot.ownerId),
          summary: 'Codex rollout persistence stalled', body: escalationBody(item.snapshot, item.reason, now), oneShot: true,
        };
        if (opts.rail?.broadcast) await opts.rail.broadcast(event);
        else await broadcastSevereEvent(event);
      } catch { /* The owner-notification leg is independent. */ }
      const phase = PHASE_PREFIX + item.snapshot.sessionId;
      let claimed: Array<{ phase: string }> = [];
      try { claimed = await sql`
        INSERT INTO harness_shared.harness_escalations
          (harness_slug, phase, escalation, mtime_ms, workspace_id)
        VALUES ('papercusp', ${phase}, ${escalationBody(item.snapshot, item.reason, now)}, ${now}, ${item.workspaceId})
        ON CONFLICT (harness_slug, phase) DO UPDATE
          SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms, workspace_id = EXCLUDED.workspace_id
          WHERE harness_escalations.escalation IS NULL
        RETURNING phase
      `; } catch { /* A legacy write cannot suppress other keyed episodes. */ }
      if (claimed.length === 1) newly.push(item);
    }
    if (newly.length > 0) {
      out.alarmed = newly.map((item) => item.snapshot.sessionId);
      const list = newly.map((item) => `${item.snapshot.ownerId} (session ${item.snapshot.sessionId})`).join(', ');
      try {
        const { notifyAttention } = await import('../attention-notify');
        await notifyAttention({
          kind: 'intervention',
          title: 'Codex rollout persistence stalled',
          body: `Live Codex session(s) are writing history.jsonl without a fresh rollout: ${list}. ${newly[0].reason}`,
          importance: 'high',
          workspaceId: newly[0].workspaceId ?? undefined,
          data: { sessionIds: newly.map((item) => item.snapshot.sessionId), owners: newly.map((item) => item.snapshot.ownerId) },
        });
      } catch (e) {
        console.warn(`[codex-rollout-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
      }
      console.warn(`[codex-rollout-watchdog] ALARM: ${list}`);
    }

    const newlyProviderFailed: ProviderFailureObservation[] = [];
    for (const item of providerFailures) {
      const conditionKey = codexRolloutConditionKey('provider', item.workspaceId, item.snapshot.sessionId, item.snapshot.ownerId);
      const event = {
        conditionKey,
        summary: 'Codex provider failures repeated', body: providerEscalationBody(item, now), oneShot: true,
      };
      const conditionAlreadyOpen = episodes.some((episode) => episode.conditionKey === conditionKey);
      // Condition state is the canonical event-delivery ledger. Suppress the same
      // still-open episode; when that read is unavailable, the durable escalation
      // claim below decides whether this process may emit a first notification.
      if (episodesKnown && !conditionAlreadyOpen) {
        try {
          if (opts.rail?.broadcast) await opts.rail.broadcast(event);
          else await broadcastSevereEvent(event);
        } catch { /* The owner-notification leg is independent. */ }
      }
      const phase = PROVIDER_FAILURE_PHASE_PREFIX + item.snapshot.sessionId;
      let claimed: Array<{ phase: string }> = [];
      try { claimed = await sql`
        INSERT INTO harness_shared.harness_escalations
          (harness_slug, phase, escalation, mtime_ms, workspace_id)
        VALUES ('papercusp', ${phase}, ${providerEscalationBody(item, now)}, ${now}, ${item.workspaceId})
        ON CONFLICT (harness_slug, phase) DO UPDATE
          SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms, workspace_id = EXCLUDED.workspace_id
          WHERE harness_escalations.escalation IS NULL
        RETURNING phase
      `; } catch { /* A legacy write cannot suppress other keyed episodes. */ }
      if (!episodesKnown && claimed.length === 1) {
        try {
          if (opts.rail?.broadcast) await opts.rail.broadcast(event);
          else await broadcastSevereEvent(event);
        } catch { /* The durable claim and owner notification remain independent. */ }
      }
      if (claimed.length === 1) newlyProviderFailed.push(item);
    }
    if (newlyProviderFailed.length > 0) {
      out.providerAlarmed = newlyProviderFailed.map((item) => item.snapshot.sessionId);
      const list = newlyProviderFailed
        .map((item) => `${item.snapshot.ownerId} (session ${item.snapshot.sessionId})`)
        .join(', ');
      try {
        const { notifyAttention } = await import('../attention-notify');
        await notifyAttention({
          kind: 'intervention',
          title: 'Codex provider failures repeated',
          body: `Live Codex session(s) repeatedly failed at the provider: ${list}. ${providerFailureReason(newlyProviderFailed[0])}`,
          importance: 'high',
          workspaceId: newlyProviderFailed[0].workspaceId ?? undefined,
          data: {
            sessionIds: newlyProviderFailed.map((item) => item.snapshot.sessionId),
            owners: newlyProviderFailed.map((item) => item.snapshot.ownerId),
            codes: newlyProviderFailed.map((item) => item.recurrence.latest?.code ?? 'unknown'),
          },
        });
      } catch (e) {
        console.warn(`[codex-rollout-watchdog] provider notify failed: ${e instanceof Error ? e.message : e}`);
      }
      console.warn(`[codex-rollout-watchdog] PROVIDER ALARM: ${list}`);
    }

    // Provider recurrence is observational. The lifecycle-aware loop outcome
    // handler owns backoff, parking, and carry recovery; this watchdog must not
    // end the adv row or release wakes/claims merely because the provider is
    // temporarily unavailable (or because a credential/cap needs repair).
    out.providerPreservedSessionIds = providerFailures.map((item) => item.snapshot.sessionId);

    const alertedRows = await sql<Array<{ phase: string }>>`
      SELECT phase FROM harness_shared.harness_escalations
       WHERE harness_slug = 'papercusp' AND phase LIKE ${PHASE_PREFIX + '%'} AND escalation IS NOT NULL
    `;
    const toRecover = alertedRows.map((row) => row.phase).filter((phase) => healthyPersistencePhases.has(phase));
    if (toRecover.length > 0) {
      await sql`
        UPDATE harness_shared.harness_escalations
           SET escalation = NULL, mtime_ms = ${now}
         WHERE harness_slug = 'papercusp' AND phase = ANY(${toRecover}) AND escalation IS NOT NULL
      `;
      out.recovered = toRecover.map((phase) => phase.slice(PHASE_PREFIX.length));
    }

    const alertedProviderRows = await sql<Array<{ phase: string }>>`
      SELECT phase FROM harness_shared.harness_escalations
       WHERE harness_slug = 'papercusp' AND phase LIKE ${PROVIDER_FAILURE_PHASE_PREFIX + '%'} AND escalation IS NOT NULL
    `;
    const providerToRecover = alertedProviderRows
      .map((row) => row.phase)
      .filter((phase) => healthyProviderPhases.has(phase));
    if (providerToRecover.length > 0) {
      await sql`
        UPDATE harness_shared.harness_escalations
           SET escalation = NULL, mtime_ms = ${now}
         WHERE harness_slug = 'papercusp' AND phase = ANY(${providerToRecover}) AND escalation IS NOT NULL
      `;
      out.providerRecovered = providerToRecover.map((phase) => phase.slice(PROVIDER_FAILURE_PHASE_PREFIX.length));
    }
  } catch (e) {
    console.warn(`[codex-rollout-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}

let watchdogTimer: ManagedHandle | null = null;

/** Start the process-level watchdog; idempotent and kill-switchable. */
export function startCodexRolloutPersistenceWatchdog(
  sql: Sql,
  opts: CodexRolloutPersistenceWatchdogOptions = {},
): void {
  if (process.env.PAPERCUSP_CODEX_ROLLOUT_WATCHDOG === '0') return;
  const intervalMs = opts.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
  const passOpts: CodexRolloutPersistenceWatchdogOptions = {
    ...opts,
    providerTailScanCache: opts.providerTailScanCache ?? new Map(),
  };
  const run = (): void => {
    void checkCodexRolloutPersistence(sql, passOpts).then((result) => {
      if (
        result.alarmed.length > 0 ||
        result.recovered.length > 0 ||
        result.providerAlarmed.length > 0 ||
        result.providerPreservedSessionIds.length > 0 ||
        result.providerRecovered.length > 0 ||
        result.providerEndedSessionIds.length > 0
      ) {
        console.warn(
            `[codex-rollout-watchdog] alarmed=${result.alarmed.length} recovered=${result.recovered.length} ` +
            `providerAlarmed=${result.providerAlarmed.length} providerRecovered=${result.providerRecovered.length} ` +
            `providerPreserved=${result.providerPreservedSessionIds.length} providerEnded=${result.providerEndedSessionIds.length}`,
        );
      }
    });
  };
  if (watchdogTimer) watchdogTimer.stop();
  watchdogTimer = managedSetInterval('codex-rollout-persistence-watchdog', intervalMs, run, { category: 'watchdog' });
}
