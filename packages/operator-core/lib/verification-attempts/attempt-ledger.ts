/**
 * attempt-ledger.ts — every slow verification attempt, recorded against its work item.
 *
 * expensive-verification-loops-2026-09-29 P-001 (R-1). REUSE, no new table: every
 * ledgered launch (capability:bash background jobs, release cuts, drills run through
 * either) already lands in harness_shared.task_ledger with its work_item_id, argv,
 * start/end, exit code and log path. What was missing is the attempt-shaped reading of
 * that row: its OUTCOME and a FAILURE FINGERPRINT that the loop detector (P-002) can
 * compare across attempts. This module adds both:
 *
 *  - `recordAttemptOnClose` runs when `closeTask` closes a row. For a row with a work
 *    item that ran at least SLOW_ATTEMPT_MIN_MS, it reads the log tail, fingerprints a
 *    failure, and stamps `detail.verificationAttempt` on the row. Fail-soft and silent:
 *    a provenance write can never break the close it rides on.
 *  - `recordStructuredAttemptResult` lets a conforming harness (P-003) replace the
 *    parsed fingerprint with its own phase / step / reason code.
 *  - `listWorkItemAttempts` reads a work item's attempts back, oldest first.
 */
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { redactSensitiveText } from '../sensitive-text';
import { readSuperuserToken } from '../superuser-token';
import { failureFingerprint, type StructuredFailure } from './failure-fingerprint';

/** An attempt shorter than this is not "slow" and is not recorded as an attempt. */
export const SLOW_ATTEMPT_MIN_MS = 120_000;
/** Bytes of log read from the end to fingerprint a failure. */
export const ATTEMPT_LOG_TAIL_BYTES = 64 * 1024;
/** Maximum redacted source excerpt retained for a failed slow attempt. */
export const ATTEMPT_EVIDENCE_MAX_CHARS = 4_000;

export type AttemptOutcome = 'pass' | 'fail' | 'cancelled' | 'unknown';

export interface VerificationAttemptStamp {
  schemaVersion: 1;
  outcome: AttemptOutcome;
  fingerprint: string | null;
  label: string | null;
  source: 'structured' | 'log' | 'exit' | null;
  structured: StructuredFailure | null;
  /** Redacted tail of the source log, retained so later audits can inspect the cause. */
  evidenceExcerpt: string | null;
  evidenceExcerptTruncated: boolean;
  commandFingerprint: string;
  durationMs: number;
  recordedAt: string;
}

export interface ClosedTaskForAttempt {
  taskId: string;
  workItemId: string | null;
  state: string;
  exitCode: number | null;
  exitReason: string | null;
  logPath: string | null;
  argv: readonly string[];
  startedAt: Date | string;
  endedAt: Date | string;
}

export interface WorkItemAttempt {
  taskId: string;
  taskClass: string;
  title: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  outcome: AttemptOutcome | 'running';
  fingerprint: string | null;
  label: string | null;
  source: VerificationAttemptStamp['source'];
  evidenceExcerpt?: string | null;
  evidenceExcerptTruncated?: boolean;
  commandFingerprint: string | null;
  /** The harness's own phase / step / reason code, when the attempt reported one. */
  structured?: StructuredFailure | null;
}

function sqlOf(inject?: Sql): Sql {
  return inject ?? (getOrgPg().sql as unknown as Sql);
}

function ms(v: Date | string): number {
  return v instanceof Date ? v.getTime() : Date.parse(v);
}

/** Terminal task state + exit code → attempt outcome. A strand never observed an exit. */
export function attemptOutcome(state: string, exitCode: number | null): AttemptOutcome {
  if (state === 'exited') return exitCode === 0 ? 'pass' : exitCode == null ? 'unknown' : 'fail';
  if (state === 'timed_out') return 'fail';
  if (state === 'killed') return exitCode === 137 || exitCode === 143 || exitCode == null ? 'cancelled' : 'fail';
  return 'unknown';
}

/** A short key for "the same command", with volatile tokens masked. */
export function commandFingerprint(argv: readonly string[]): string {
  const text = argv
    .join(' ')
    .replace(/\/tmp\/[^\s'"]+/g, '<tmp>')
    .replace(/\b[0-9a-f]{8,64}\b/gi, '<hex>')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

export async function readLogTail(path: string, bytes = ATTEMPT_LOG_TAIL_BYTES): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(path, 'r');
    const { size } = await fh.stat();
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, size - length);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

export interface RecordAttemptDeps {
  sql?: Sql;
  readTail?: (path: string) => Promise<string | null>;
  now?: () => Date;
  minDurationMs?: number;
}

/**
 * Stamp `detail.verificationAttempt` on a just-closed task row. Returns the stamp,
 * or null when the row is not a slow work-item attempt. Never throws.
 */
export async function recordAttemptOnClose(
  closed: ClosedTaskForAttempt,
  deps: RecordAttemptDeps = {},
): Promise<VerificationAttemptStamp | null> {
  try {
    if (!closed.workItemId) return null;
    const durationMs = ms(closed.endedAt) - ms(closed.startedAt);
    if (!Number.isFinite(durationMs) || durationMs < (deps.minDurationMs ?? SLOW_ATTEMPT_MIN_MS)) return null;
    const outcome = attemptOutcome(closed.state, closed.exitCode);
    let fp: ReturnType<typeof failureFingerprint> | null = null;
    let evidenceExcerpt: string | null = null;
    let evidenceExcerptTruncated = false;
    // An unknown exit is unobserved, not evidence of failure. Log text can be
    // partial or harmless stderr, so only a classified failure gets a fingerprint.
    if (outcome === 'fail') {
      const logTail = closed.logPath ? await (deps.readTail ?? readLogTail)(closed.logPath) : null;
      fp = failureFingerprint({ exitCode: closed.exitCode, exitReason: closed.exitReason, logTail });
      if (logTail !== null) {
        const superuserToken = readSuperuserToken();
        const redacted = redactSensitiveText(logTail, superuserToken ? [superuserToken] : []);
        evidenceExcerptTruncated = redacted.length > ATTEMPT_EVIDENCE_MAX_CHARS;
        evidenceExcerpt = evidenceExcerptTruncated
          ? redacted.slice(-ATTEMPT_EVIDENCE_MAX_CHARS)
          : redacted;
      }
    }
    const stamp: VerificationAttemptStamp = {
      schemaVersion: 1,
      outcome,
      fingerprint: fp?.fingerprint ?? null,
      label: fp?.label ?? null,
      source: fp?.source ?? null,
      structured: fp?.structured ?? null,
      evidenceExcerpt,
      evidenceExcerptTruncated,
      commandFingerprint: commandFingerprint(closed.argv),
      durationMs,
      recordedAt: (deps.now?.() ?? new Date()).toISOString(),
    };
    const sql = sqlOf(deps.sql);
    // A structured result a harness already wrote is authoritative; never overwrite it.
    await sql`
      UPDATE harness_shared.task_ledger
         SET detail = detail || jsonb_build_object('verificationAttempt', ${JSON.stringify(stamp)}::text::jsonb),
             updated_at = now()
       WHERE task_id = ${closed.taskId}
         AND NOT (detail #>> '{verificationAttempt,source}' IS NOT DISTINCT FROM 'structured')
    `;
    return stamp;
  } catch {
    return null;
  }
}

/** A conforming harness reports its own phase / step / reason code (P-003). */
export async function recordStructuredAttemptResult(
  taskId: string,
  result: StructuredFailure,
  inject?: Sql,
): Promise<boolean> {
  const fp = failureFingerprint({ structured: result });
  const patch = { fingerprint: fp.fingerprint, label: fp.label, source: 'structured', structured: fp.structured };
  const sql = sqlOf(inject);
  const rows = await sql`
    UPDATE harness_shared.task_ledger
       SET detail = jsonb_set(
             detail,
             '{verificationAttempt}',
             COALESCE(detail->'verificationAttempt', '{}'::jsonb) || ${JSON.stringify(patch)}::text::jsonb
           ),
           updated_at = now()
     WHERE task_id = ${taskId}
    RETURNING task_id
  `;
  return rows.length > 0;
}

interface AttemptRow {
  task_id: string;
  root_task_id: string | null;
  run_id: string | null;
  run_group: string | null;
  class: string;
  title: string;
  state: string;
  exit_code: number | null;
  started_at: Date | string;
  ended_at: Date | string | null;
  attempt: VerificationAttemptStamp | null;
}

function mapAttempt(r: AttemptRow): WorkItemAttempt {
  const startedAt = new Date(r.started_at).toISOString();
  const endedAt = r.ended_at ? new Date(r.ended_at).toISOString() : null;
  return {
    taskId: r.task_id,
    taskClass: r.class,
    title: r.title,
    startedAt,
    endedAt,
    durationMs: r.attempt?.durationMs ?? (endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : null),
    outcome: endedAt ? (r.attempt?.outcome ?? attemptOutcome(r.state, r.exit_code)) : 'running',
    fingerprint: r.attempt?.fingerprint ?? null,
    label: r.attempt?.label ?? null,
    source: r.attempt?.source ?? null,
    evidenceExcerpt: r.attempt?.evidenceExcerpt ?? null,
    evidenceExcerptTruncated: r.attempt?.evidenceExcerptTruncated ?? false,
    commandFingerprint: r.attempt?.commandFingerprint ?? null,
    structured: r.attempt?.structured ?? null,
  };
}

/** testing:run names the same logical run `runId` on its detached row and `runGroup`
 * on the foreground row. Trim both spellings into one key; unrelated task rows remain
 * independent attempts. */
function logicalRunId(r: AttemptRow): string | null {
  const id = r.run_id?.trim() || r.run_group?.trim();
  return id || null;
}

/** Collapse one testing run's task rows to its root attempt. Child failures still
 * determine the run outcome, and a structured child failure is the most useful cause
 * when the wrapper has only a generic exit fingerprint. */
function collapseLogicalRun(rows: readonly AttemptRow[]): WorkItemAttempt {
  const ordered = [...rows].sort((a, b) => ms(a.started_at) - ms(b.started_at));
  const root = rows.find((r) => r.root_task_id === r.task_id) ?? ordered[0]!;
  const base = mapAttempt(root);
  const running = rows.some((r) => !r.ended_at);
  const endedAtMs = rows
    .map((r) => (r.ended_at ? ms(r.ended_at) : null))
    .filter((value): value is number => value !== null);
  const endedAt = !running && endedAtMs.length
    ? new Date(Math.max(...endedAtMs)).toISOString()
    : null;
  const failures = rows.filter((r) =>
    r.ended_at && (r.attempt?.outcome ?? attemptOutcome(r.state, r.exit_code)) === 'fail');
  const failure = failures.find((r) => r.attempt?.structured)
    ?? failures.find((r) => r.task_id === root.task_id)
    ?? failures[0];
  const cause = failure ? mapAttempt(failure) : base;

  return {
    ...base,
    endedAt,
    durationMs: endedAt ? Date.parse(endedAt) - Date.parse(base.startedAt) : base.durationMs,
    outcome: endedAt === null ? 'running' : failure ? 'fail' : base.outcome,
    fingerprint: cause.fingerprint,
    label: cause.label,
    source: cause.source,
    evidenceExcerpt: cause.evidenceExcerpt,
    evidenceExcerptTruncated: cause.evidenceExcerptTruncated,
    commandFingerprint: base.commandFingerprint ?? cause.commandFingerprint,
    structured: cause.structured,
  };
}

/**
 * A work item's slow attempts, oldest first: every stamped row, plus any still-running
 * row already past the slow threshold (so a hung attempt counts toward a time budget).
 */
export async function listWorkItemAttempts(
  input: { workspaceId: string; workItemId: string; limit?: number },
  inject?: Sql,
): Promise<WorkItemAttempt[]> {
  const sql = sqlOf(inject);
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
  const rows = await sql<AttemptRow[]>`
    SELECT task_id, root_task_id,
           detail->>'runId' AS run_id, detail->>'runGroup' AS run_group,
           class, title, state, exit_code, started_at, ended_at,
           detail->'verificationAttempt' AS attempt
      FROM harness_shared.task_ledger
     WHERE workspace_id = ${input.workspaceId}
       AND work_item_id = ${input.workItemId}
       AND (
         detail ? 'verificationAttempt'
         OR (ended_at IS NULL AND started_at < now() - make_interval(secs => ${SLOW_ATTEMPT_MIN_MS / 1000}))
       )
     ORDER BY started_at ASC
     LIMIT ${limit}
  `;
  const grouped = new Map<string, AttemptRow[]>();
  const attempts: WorkItemAttempt[] = [];
  for (const row of rows) {
    const runId = logicalRunId(row);
    if (!runId) {
      attempts.push(mapAttempt(row));
      continue;
    }
    const group = grouped.get(runId) ?? [];
    group.push(row);
    grouped.set(runId, group);
  }
  attempts.push(...[...grouped.values()].map(collapseLogicalRun));
  return attempts.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.taskId.localeCompare(b.taskId));
}
