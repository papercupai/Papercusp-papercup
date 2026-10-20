/**
 * `sync-batch-delta-check-deps.ts` — the IO binding for the pure sync-batch delta
 * check (`./sync-batch-delta-check.ts`, gate-verdict-liveness P-012).
 *
 * Same split as `frozen-candidate-drift-sweep.ts` / its action: every DECISION is
 * pure and unit-tested in the sibling module against `SyncBatchDeltaDeps` fakes;
 * this module is the one place those seams touch git, the runner scripts, the
 * routine's own metadata row and the work-item store. Keep logic OUT of here —
 * a lambda that decides something in this file is invisible to the tests
 * (EI-21559794492221235).
 *
 * Every subprocess is bounded (an execFile timeout) and every failure resolves to
 * the deps contract's "could not measure" value (`null` / `ok:false`), never to a
 * fake green — the pure runner treats those as skip-and-hold-cursor.
 *
 * ⛔ EVERY subprocess leg here MUST stay async — never `spawnSync`/`execFileSync`
 * (WI-10001771). This module runs inside bg-host, which also serves :3271 and the
 * DBOS routine engine on the SAME event loop. `spawnSync` pumps its child on a
 * NESTED uv loop, so the main thread parks in one `epoll_pwait` for the child's
 * whole lifetime: the outer loop's timers stop, the listening socket is never
 * polled, and :3271 answers nothing. Bounding the CHILD's lifetime does not help —
 * that was the original (wrong) reasoning here. Measured 2026-09-17: the
 * `runAffected` leg's 25-minute budget became a 25-minute `epoll_pwait` timeout
 * (strace arg `0x16e1ae` = 1,499,566 ms), bg-host served :3271 for ~4s per boot,
 * its own watchdog SIGKILLed it at 184s, and the restart re-derived the same
 * commit and blocked again — a self-perpetuating loop that took the routine engine
 * down fleet-wide (~108 routines overdue) until the routine was deactivated.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { getOrgPg } from '@papercusp/db-org';
import { createOneWorkItem } from '../agent-tools/work_items/_create-core';
import { getMessageById, sendMessage } from '../agent-tools/coordination/messages';
import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';
import { getWorkItem } from '../work-items';
import {
  isScopeLaunchFailure,
  reservedCapacityArgv,
  parseAffectedProbe,
  parseFailingFilesLine,
  parseLoadavg1,
  parseSyncBatches,
  parseTscFailingFiles,
  SYNC_DELTA_MAX_LISTED_COMMITS,
  SYNC_DELTA_TIMEOUTS_MS,
  type ConfirmVerdict,
  type EditorHit,
  type LoadReading,
  type AffectedProbe,
  type RedFinding,
  type SyncBatch,
  type SyncBatchDeltaDeps,
  type SyncDeltaCursor,
  type SubprocessDiagnostic,
} from './sync-batch-delta-check';

/** The `harness_shared.routines.name` whose metadata row carries the durable cursor
 *  (`metadata.sync_delta`) — the same row the seed script upserts. */
export const SYNC_DELTA_ROUTINE_NAME = 'sync-batch-delta-check';

/** Per-leg subprocess budgets: defined in the logic module, which derives admission and the
 *  slot-credit deadline from them (green-main-ratchet-convergence-2026-10-17#D-031), and
 *  re-exported here for the call sites below and existing importers. */
export { SYNC_DELTA_TIMEOUTS_MS };

/** SGR escapes, built without a raw control byte in source (`lint:no-control-bytes`
 *  is a green-checkpoint leg — EI-19478121013052934). */
const SGR_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export interface SyncBatchDeltaDepsConfig {
  /** Harness slug — the routine row's `install_slug`, and the harness reds file under. */
  installSlug: string;
  /** Workspace the filed work-items belong to. */
  workspaceId: string;
  /** Repo root the git/script legs run in. */
  root: string;
  /** Integration branch (`staging` here). */
  branch: string;
  /** System identity filed work-items carry (owner + `payload.filedBy`). Defaults to
   *  `system:sync-batch-delta-check`; the P-028 guard routine passes its own. */
  filedBy?: string;
  /** Stable prefix for the owner-notification message id. The lint guard passes
   *  `sync-lint-red` to preserve its existing dedup key; the delta leg uses
   *  `sync-delta-red` by default. */
  notificationPrefix?: string;
  /** Log label retained for the lint guard's existing retry diagnostics. */
  notificationLogLabel?: string;
  /** Process seam — defaults to the real async argv spawn below. Tests inject a
   *  recorder to assert WHICH legs run in the reserved slice without spawning anything. */
  exec?: (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<RunResult | null>;
  /** Most commits `listBatches` lists per window (`git log --max-count`). Defaults to
   *  SYNC_DELTA_MAX_LISTED_COMMITS; tests lower it to exercise the cap on a small repo. */
  maxListedCommits?: number;
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  durationMs?: number;
  failureKind?: 'timeout' | 'output-buffer-limit' | 'spawn-error';
}

// Lazy + memoized, NOT promisified at module scope (EI-10161): under a narrow
// `vi.mock('node:child_process')` `execFile` is undefined, and an eager `promisify` throws at
// IMPORT time — crashing every test file that reaches this module, even one that never calls it.
let execFileAsyncMemo: typeof execFile.__promisify__ | null = null;
const execFileAsync = ((...args: unknown[]) =>
  Reflect.apply((execFileAsyncMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;

/** argv spawn, never a shell string. ASYNC by contract — see the ⛔ note in the module
 *  header; a sync variant here wedges bg-host's shared event loop. `null` = the spawn
 *  itself could not be measured (ENOENT, timeout kill, …) — callers map that to their
 *  contract's undetermined value.
 *
 *  `execFile` REJECTS on a non-zero exit, but a non-zero exit is a MEASUREMENT here
 *  (a red), not a failure to measure. So the catch splits them the same way the old
 *  `spawnSync` branch did: a numeric `code` on a child that was not killed is a real
 *  exit status; ENOENT (string code) and a timeout/signal kill (`killed`) are `null`.
 *  Exported for the periodic full run (P-013), which runs its legs the same way. */
export async function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<RunResult | null> {
  const startedAtMs = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: opts.timeoutMs,
      killSignal: 'SIGTERM',
    });
    return { status: 0, stdout: stdout ?? '', stderr: stderr ?? '', durationMs: Math.max(0, Date.now() - startedAtMs) };
  } catch (err) {
    const e = err as { code?: number | string; killed?: boolean; signal?: string; stdout?: string; stderr?: string };
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    if (typeof e.code === 'number' && e.killed !== true) {
      return { status: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '', durationMs };
    }
    const failureKind =
      e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        ? 'output-buffer-limit'
        : e.code === 'ETIMEDOUT' || (e.killed === true && durationMs >= opts.timeoutMs - 1000)
          ? 'timeout'
          : null;
    if (failureKind) {
      return {
        status: null,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
        durationMs,
        failureKind,
      };
    }
    return null;
  }
}

export function stripSgr(s: string): string {
  return s.replace(SGR_RE, '');
}

/** The bounded async argv spawn above, for sibling bindings that run their own legs
 *  (`sync-batch-lint-guards-deps.ts`, P-028) under the same contract. */
export const runBoundedArgv = run;

type ExecFn = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<RunResult | null>;

/**
 * Run a heavy leg in the reserved `source-checks.slice` (P-009 / D-017 point 2). When the
 * SCOPE cannot start (no user bus, no systemd-run binary) the payload is re-run unwrapped
 * at normal priority and the result's stderr carries a one-line diagnostic saying so, so
 * a leg never goes unmeasured because the reservation was unavailable. A spawn that
 * could not be measured at all (`null`, e.g. ENOENT for `systemd-run`) also falls back.
 */
export async function runReservedArgv(
  exec: ExecFn,
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<RunResult | null> {
  const wrapped = reservedCapacityArgv(cmd, args);
  const reserved = await exec(wrapped.cmd, wrapped.args, opts);
  if (reserved && !isScopeLaunchFailure(reserved)) return reserved;
  const why = reserved
    ? `exit ${reserved.status}: ${reserved.stderr.trim().split(/\r?\n/)[0]?.slice(0, 200) ?? ''}`
    : 'systemd-run could not be spawned';
  const plain = await exec(cmd, args, opts);
  if (!plain) return null;
  return {
    ...plain,
    stderr: `${plain.stderr}${plain.stderr.endsWith('\n') || plain.stderr === '' ? '' : '\n'}` +
      `[source-checks] reserved slice unavailable (${why}); ran at normal priority\n`,
  };
}

/** Parse the router's terminal `TEST_FILE_RESULT … status=…` line. Contract (root
 *  CLAUDE.md + the pure module's header): an ABSENT line or `matched=0` is `null`
 *  (undetermined), never `false` — a batch/collection abort must not read as a red. */
export function parseConfirmOutput(text: string): ConfirmVerdict {
  let line: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const l = stripSgr(raw);
    if (/^\s*TEST_FILE_RESULT\s/.test(l)) line = l; // keep the LAST terminal line
  }
  if (!line) return null;
  if (/\bmatched=0\b/.test(line)) return null;
  const m = /\bstatus=([A-Za-z-]+)/.exec(line);
  if (!m?.[1]) return null;
  if (m[1] === 'passed' || m[1] === 'pass') return true;
  if (m[1] === 'failed' || m[1] === 'fail' || m[1] === 'error') return false;
  return null;
}

/** P-012: a stored known-good value counts only as a full lowercase 40-hex sha. Anything else
 *  (absent, abbreviated, a branch name) reads as no known-good point, never as a ref to resolve:
 *  resolving it would let a moving ref stand in for a commit the check actually judged. */
export function knownGoodShaOf(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) ? value : null;
}

/** P-012 (green-main-cycle-time-2026-10-08): the newest commit this check judged GREEN for
 *  `installSlug` (`metadata.sync_delta.lastPassed.sha`), or null when none is recorded. The gate's
 *  fresh cut reads it through `CheckpointDeps.resolveKnownGoodRecutTarget`. */
export async function readSyncDeltaKnownGood(installSlug: string): Promise<string | null> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT metadata->'sync_delta'->'lastPassed'->>'sha' AS sha
      FROM harness_shared.routines
     WHERE install_slug = ${installSlug} AND name = ${SYNC_DELTA_ROUTINE_NAME}
     LIMIT 1`;
  return knownGoodShaOf(rows[0]?.sha);
}

/** Bind `SyncBatchDeltaDeps` to the real box. Pure module decides; this executes. */
export function buildSyncBatchDeltaDeps(cfg: SyncBatchDeltaDepsConfig): SyncBatchDeltaDeps {
  const script = (rel: string): string => path.join(cfg.root, rel);
  const exec = cfg.exec ?? run;
  /** A HEAVY leg (radius probe, affected suites, tsc, per-file confirm) runs in the
   *  reserved `source-checks.slice` (green-main-ratchet-convergence-2026-10-17 P-009 /
   *  D-017): that, not skipping under load, is what bounds its share of the box. git and
   *  proc-guard stay unwrapped — they are millisecond reads. */
  const heavy = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) =>
    runReservedArgv(exec, cmd, args, opts);

  const filedBy = cfg.filedBy ?? 'system:sync-batch-delta-check';
  const notificationPrefix = cfg.notificationPrefix ?? 'sync-delta-red';
  const notificationLogLabel = cfg.notificationLogLabel ?? 'sync-batch-delta-check';

  return {
    async readCursor(): Promise<SyncDeltaCursor | null> {
      const { sql } = getOrgPg();
      const rows = await sql`
        SELECT metadata->'sync_delta' AS sync_delta
          FROM harness_shared.routines
         WHERE install_slug = ${cfg.installSlug} AND name = ${SYNC_DELTA_ROUTINE_NAME}
         LIMIT 1`;
      const raw: unknown = rows[0]?.sync_delta;
      if (!raw || typeof raw !== 'object') return null;
      const c = raw as Partial<SyncDeltaCursor>;
      if (typeof c.sha !== 'string' || c.sha.length === 0) return null;
      return c as SyncDeltaCursor;
    },

    async writeCursor(next: SyncDeltaCursor): Promise<void> {
      // Scoped merge that leaves sibling metadata keys alone — the
      // `dead-target-sweep.ts` stampHealth precedent, one level up (the whole
      // `sync_delta` object IS this check's state, so replacing it is correct).
      const { sql } = getOrgPg();
      const json = JSON.stringify(next);
      await sql`
        UPDATE harness_shared.routines
           SET metadata = COALESCE(metadata, '{}'::jsonb)
                          || jsonb_build_object('sync_delta', ${json}::text::jsonb)
         WHERE install_slug = ${cfg.installSlug} AND name = ${SYNC_DELTA_ROUTINE_NAME}`;
    },

    hostLoad(): LoadReading | null {
      try {
        const load1 = parseLoadavg1(readFileSync('/proc/loadavg', 'utf8'));
        if (load1 === null) return null;
        const cores = os.cpus().length;
        if (!(cores > 0)) return null;
        return { load1, cores };
      } catch {
        return null;
      }
    },

    async greenCheckpointRunning(): Promise<boolean | null> {
      // proc-guard excludes the caller's own ancestor chain, so this cannot
      // self-match (root CLAUDE.md's pattern-poll trap). exit 0 = running,
      // 1 = not running, 2/other = usage error ⇒ undetectable.
      const r = await exec('node', [script('scripts/proc-guard.mjs'), 'check', 'green-checkpoint'], {
        cwd: cfg.root,
        timeoutMs: SYNC_DELTA_TIMEOUTS_MS.procGuard,
      });
      if (!r) return null;
      if (r.status === 0) return true;
      if (r.status === 1) return false;
      return null;
    },

    async headSha(): Promise<string | null> {
      const r = await exec('git', ['-C', cfg.root, 'rev-parse', cfg.branch], {
        cwd: cfg.root,
        timeoutMs: SYNC_DELTA_TIMEOUTS_MS.git,
      });
      if (!r || r.status !== 0) return null;
      const sha = r.stdout.trim();
      return /^[0-9a-f]{7,64}$/.test(sha) ? sha : null;
    },

    async listBatches(sinceSha: string): Promise<SyncBatch[] | null> {
      // FIRST-PARENT, not `--no-merges` (WI-6554700010018028). A merged frozen lineage
      // carries repair-queue admission commits dated 2000-01-01 (ADMISSION_GIT_DATE).
      // `--no-merges` listed them, git's date order put them LAST (oldest), the
      // oldest-prefix walk judged one first and moved the cursor onto a side-lineage
      // commit. From there `cursor..staging` was ~9,800 commits. The first-parent chain
      // is the order staging actually moved in, so the cursor can only land on it. An
      // absorbing merge's own first-parent diff is listed too (--diff-merges), so no
      // content that reached staging through a merge is dropped.
      // `--max-count` bounds the listing: a cursor already OFF the first-parent chain
      // listed 110,362 commits and timed out every tick. A capped listing is planned as
      // a too-large backlog (planStaleBacklogSkip `truncated`), which re-anchors the cursor.
      const r = await exec(
        'git',
        [
          '-C',
          cfg.root,
          'log',
          `${sinceSha}..${cfg.branch}`,
          `--max-count=${cfg.maxListedCommits ?? SYNC_DELTA_MAX_LISTED_COMMITS}`,
          '--first-parent',
          '--diff-merges=first-parent',
          '--name-only',
          '--format=%x00%H %ct%n%(trailers:key=Papercusp-Agent)',
        ],
        { cwd: cfg.root, timeoutMs: SYNC_DELTA_TIMEOUTS_MS.git },
      );
      if (!r || r.status !== 0) return null;
      return parseSyncBatches(r.stdout);
    },

    async probeRadius(paths: readonly string[]): Promise<AffectedProbe | null> {
      const r = await heavy(
        'node',
        // --related: the same narrowing the real run applies, so the AFFECTED_ETA line projects
        // the run that would actually execute (green-main-ratchet-convergence-2026-10-17#D-030).
        // --related-cross-root (WI-6554700010018067): a dependent pulled in by another package's
        // change narrows to the tests that reach it, or drops when none can. Gate does not pass it.
        [
          script('scripts/affected-tests.mjs'),
          '--changed-paths',
          paths.join(','),
          '--print-affected',
          '--related',
          '--related-cross-root',
        ],
        { cwd: cfg.root, timeoutMs: SYNC_DELTA_TIMEOUTS_MS.probe },
      );
      if (!r || r.status !== 0) return null;
      return parseAffectedProbe(r.stdout);
    },

    async runAffected(
      paths: readonly string[],
    ): Promise<{
      ok: boolean;
      failing: ReturnType<typeof parseFailingFilesLine>;
      diagnostic?: SubprocessDiagnostic;
    }> {
      const r = await heavy(
        'node',
        [script('scripts/affected-tests.mjs'), '--changed-paths', paths.join(','), '--related', '--related-cross-root'],
        {
          cwd: cfg.root,
          timeoutMs: SYNC_DELTA_TIMEOUTS_MS.affected,
        },
      );
      // Unmeasurable spawn ⇒ red-with-no-break-set: the runner treats that as
      // UNDETERMINED and holds the cursor, which is the failure direction we want.
      if (!r) {
        return {
          ok: false,
          failing: null,
          diagnostic: { outcome: 'spawn-error', durationMs: null, exitCode: null },
        };
      }
      if (r.failureKind || r.status === null) {
        return {
          ok: false,
          failing: null,
          diagnostic: {
            outcome: r.failureKind ?? 'spawn-error',
            durationMs: r.durationMs ?? null,
            exitCode: r.status,
          },
        };
      }
      if (r.status === 0) {
        return {
          ok: true,
          failing: [],
          diagnostic: { outcome: 'completed', durationMs: r.durationMs ?? null, exitCode: 0 },
        };
      }
      return {
        ok: false,
        failing: parseFailingFilesLine(`${r.stdout}\n${r.stderr}`),
        diagnostic: { outcome: 'nonzero-exit', durationMs: r.durationMs ?? null, exitCode: r.status },
      };
    },

    async runTsc(files: readonly string[]): Promise<{
      ok: boolean;
      failing: string[];
      diagnostic?: SubprocessDiagnostic;
    }> {
      const r = await heavy('node', [script('scripts/lint-tsc.mjs'), `--files=${files.join(',')}`], {
        cwd: cfg.root,
        timeoutMs: SYNC_DELTA_TIMEOUTS_MS.tsc,
      });
      if (!r) {
        return {
          ok: false,
          failing: [],
          diagnostic: { outcome: 'spawn-error', durationMs: null, exitCode: null },
        };
      }
      if (r.failureKind || r.status === null) {
        return {
          ok: false,
          failing: [],
          diagnostic: {
            outcome: r.failureKind ?? 'spawn-error',
            durationMs: r.durationMs ?? null,
            exitCode: r.status,
          },
        };
      }
      if (r.status === 0) {
        return {
          ok: true,
          failing: [],
          diagnostic: { outcome: 'completed', durationMs: r.durationMs ?? null, exitCode: 0 },
        };
      }
      return {
        ok: false,
        failing: parseTscFailingFiles(`${r.stdout}\n${r.stderr}`),
        diagnostic: { outcome: 'nonzero-exit', durationMs: r.durationMs ?? null, exitCode: r.status },
      };
    },

    async confirmOne(file: string): Promise<ConfirmVerdict> {
      const r = await heavy('node', [script('scripts/test-files.mjs'), file], {
        cwd: cfg.root,
        timeoutMs: SYNC_DELTA_TIMEOUTS_MS.confirm,
      });
      if (!r) return null;
      return parseConfirmOutput(`${r.stdout}\n${r.stderr}`);
    },

    async fileRed(finding: RedFinding): Promise<{
      ok: boolean;
      id?: string;
      adopted?: boolean;
      assignee?: string | null;
      error?: string;
      notificationError?: string;
    }> {
      try {
        const res = await createOneWorkItem(
          {
            kind: 'bug',
            severity: 'major',
            harness: cfg.installSlug,
            title: finding.title,
            summary: finding.body,
            conditionKey: finding.conditionKey,
            payload: {
              paths: finding.paths,
              filedBy,
              authorSource: finding.authorSource,
            },
            // P-002 / D-002: route the fix-it to the agent whose edit broke it. Omitted
            // (not null) when unattributed, so the item lands in the open queue as before.
            ...(finding.assignee ? { assign_to: finding.assignee } : {}),
          },
          {
            ownerId: filedBy,
            workspaceId: cfg.workspaceId,
            harnessSlug: cfg.installSlug,
          },
        );
        if (res.ok) {
          const wi = res.workItem as { id?: unknown; feature_id?: unknown };
          const id =
            typeof wi.id === 'string' ? wi.id : typeof wi.feature_id === 'string' ? wi.feature_id : undefined;
          const result = {
            ok: true,
            ...(id ? { id } : {}),
            ...(res.conditionUpsert?.adopted ? { adopted: true } : {}),
          };
          if (!result.id) return result;

          // A filed/assigned red is incomplete until the actual current holder
          // receives the stable message and required wake. This lookup is also
          // required for an unattributed filing that adopted an incumbent item:
          // the incumbent's actual holder, rather than the new finding's absent
          // attribution, is the owner that must be notified.
          let filedAssignee: string | null | undefined;
          try {
            const item = await getWorkItem(result.id, cfg.installSlug);
            filedAssignee = item?.assignee ?? null;
            if (!filedAssignee) return { ...result, assignee: null };
            // Keep the red filed on any delivery miss so the next tick retries
            // the same condition and stable message id.
            const target = filedAssignee;
            const msgId = `${notificationPrefix}:${cfg.workspaceId}:${result.id}`;
            const summary = `${result.id}: ${finding.title}`;
            if (!await getMessageById(msgId)) {
              await sendMessage({ ownerId: filedBy, ownerLabel: filedBy,
                source: 'principal', workspaceId: cfg.workspaceId, userId: null }, {
                to: [target], msgId, summary, body: finding.body,
                files: finding.paths, harnessSlug: cfg.installSlug,
                extra: { expects: 'action', workItemId: result.id },
              });
            }
            const wake = await wakeRecipients([target], {
              summary, payload: { workItemId: result.id, conditionKey: finding.conditionKey, msg_id: msgId },
              source: filedBy, workspaceId: cfg.workspaceId, requiredWake: true,
            });
            if ((wake.queued ?? wake.woken) < 1) {
              throw new Error(`wake not queued for ${target} (staged=${wake.staged}, timedOut=${wake.timedOutTargets.length})`);
            }
            return { ...result, assignee: filedAssignee };
          } catch (error) {
            const notificationError = error instanceof Error ? error.message : String(error);
            console.log(`[${notificationLogLabel}] ${result.id} remains filed; notification pending: ${notificationError}`);
            return { ...result, ...(filedAssignee === undefined ? {} : { assignee: filedAssignee }), notificationError };
          }
        }
        const refusal = res as { error?: string; message?: string };
        return { ok: false, error: refusal.message ?? refusal.error ?? 'create_failed' };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async lookupEditors(files: readonly string[], sinceMs: number): Promise<EditorHit[] | null> {
      // The author signal is the per-edit attribution ledger the lock hook writes
      // (`harness_shared.edit_attribution_ledger`), NEVER git blame or a commit
      // subject — git-sync sweeps the whole tree under one identity. Newest editor
      // per file since the window opened; the pure side picks among them.
      if (files.length === 0) return [];
      const { sql } = getOrgPg();
      const rows = await sql`
        SELECT DISTINCT ON (file) file, agent_id, ts
          FROM harness_shared.edit_attribution_ledger
         WHERE workspace_id = ${cfg.workspaceId}
           AND file = ANY(${[...files]}::text[])
           AND ts >= to_timestamp(${sinceMs / 1000})
         ORDER BY file, ts DESC`;
      return rows.map((r) => ({
        file: String(r.file),
        agent: String(r.agent_id),
        tsMs: new Date(r.ts as string | Date).getTime(),
      }));
    },

    now: () => Date.now(),
    log: (message: string) => console.log(message),
  };
}
