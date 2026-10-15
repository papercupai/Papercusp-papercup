/**
 * `sync-batch-lint-guards-deps.ts` — the IO binding for the per-sync lint-guard leg
 * (`./sync-batch-lint-guards.ts`, green-main-cycle-time-2026-10-08 P-028).
 *
 * Reuses the delta check's binding (`buildSyncBatchDeltaDeps`) for every seam the two
 * share — host load, gate detection, git, the work-item filer and the edit-attribution
 * lookup — so a red from either routine is filed and routed by the same code. Adds only
 * the guard state (on this routine's own `routines` row) and the guard runner.
 *
 * ⛔ Async by contract, like its sibling: this runs inside bg-host, whose event loop also
 * serves :3271 and the DBOS routine engine (WI-10001771). Every guard is an argv spawn at
 * idle CPU + IO priority with a hard timeout.
 */
import { getOrgPg } from '@papercusp/db-org';
import { getWorkItem } from '../work-items';
import { getMessageById, sendMessage } from '../agent-tools/coordination/messages';
import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';
import { idlePriorityArgv } from './sync-batch-delta-check';
import {
  buildSyncBatchDeltaDeps,
  runBoundedArgv,
  stripSgr,
  type SyncBatchDeltaDepsConfig,
} from './sync-batch-delta-check-deps';
import type { GuardRun, SyncLintGuardDeps, SyncLintGuardScript, SyncLintGuardState } from './sync-batch-lint-guards';

/** The `harness_shared.routines.name` whose metadata carries the guard state. */
export const SYNC_LINT_GUARDS_ROUTINE_NAME = 'sync-batch-lint-guards';
/** The system identity guard findings are filed under. */
export const SYNC_LINT_GUARDS_FILED_BY = 'system:sync-batch-lint-guards';
/** One guard's budget. The gate measured these at 1.3-16.1s on a quiet box; under a load
 *  of ~340 on 128 cores they took 9-550s at idle priority (2026-10-13). A guard past this
 *  budget is undetermined, never red. */
export const SYNC_LINT_GUARD_TIMEOUT_MS = 10 * 60_000;

export function buildSyncLintGuardDeps(cfg: Omit<SyncBatchDeltaDepsConfig, 'filedBy'>): SyncLintGuardDeps {
  const base = buildSyncBatchDeltaDeps({ ...cfg, filedBy: SYNC_LINT_GUARDS_FILED_BY });
  const exec = cfg.exec ?? runBoundedArgv;
  return {
    hostLoad: () => base.hostLoad(),
    greenCheckpointRunning: () => base.greenCheckpointRunning(),
    headSha: () => base.headSha(),
    listBatches: (sinceSha) => base.listBatches(sinceSha),
    async fileRed(finding) {
      const result = await base.fileRed(finding);
      if (!result.ok || !result.id || !finding.assignee) return result;
      // Keep the filed/assigned red on a delivery miss. The pure tick holds this
      // offender out of its baseline and retries the SAME condition next tick.
      // An adopted item may have another holder: wake the actual owner only.
      let filedAssignee: string | null | undefined;
      try {
        const item = await getWorkItem(result.id, cfg.installSlug);
        filedAssignee = item?.assignee ?? null;
        if (!filedAssignee) throw new Error('filed red has no readable assignee');
        const target = filedAssignee;
        const msgId = `sync-lint-red:${cfg.workspaceId}:${result.id}`;
        const summary = `${result.id}: ${finding.title}`;
        if (!await getMessageById(msgId)) {
          await sendMessage({ ownerId: SYNC_LINT_GUARDS_FILED_BY, ownerLabel: SYNC_LINT_GUARDS_FILED_BY,
            source: 'principal', workspaceId: cfg.workspaceId, userId: null }, {
            to: [target], msgId, summary, body: finding.body,
            files: finding.paths, harnessSlug: cfg.installSlug,
            extra: { expects: 'action', workItemId: result.id },
          });
        }
        const wake = await wakeRecipients([target], {
          summary, payload: { workItemId: result.id, conditionKey: finding.conditionKey, msg_id: msgId },
          source: SYNC_LINT_GUARDS_FILED_BY, workspaceId: cfg.workspaceId, requiredWake: true,
        });
        if ((wake.queued ?? wake.woken) < 1) {
          throw new Error(`wake not queued for ${target} (staged=${wake.staged}, timedOut=${wake.timedOutTargets.length})`);
        }
        return { ...result, assignee: filedAssignee };
      } catch (error) {
        const notificationError = error instanceof Error ? error.message : String(error);
        base.log(`[sync-lint-guards] ${result.id} remains filed; notification pending: ${notificationError}`);
        return { ...result, ...(filedAssignee === undefined ? {} : { assignee: filedAssignee }), notificationError };
      }
    },
    lookupEditors: (files, sinceMs) => base.lookupEditors!(files, sinceMs),
    now: () => base.now(),
    log: (message) => base.log(message),
    repoRoot: cfg.root,

    async readGuardState(): Promise<SyncLintGuardState | null> {
      const { sql } = getOrgPg();
      const rows = await sql`
        SELECT metadata->'sync_lint_guards' AS state
          FROM harness_shared.routines
         WHERE install_slug = ${cfg.installSlug} AND name = ${SYNC_LINT_GUARDS_ROUTINE_NAME}
         LIMIT 1`;
      const raw: unknown = rows[0]?.state;
      if (!raw || typeof raw !== 'object') return null;
      const s = raw as Partial<SyncLintGuardState>;
      if (typeof s.sha !== 'string' || s.sha.length === 0 || !s.guards || typeof s.guards !== 'object') return null;
      return s as SyncLintGuardState;
    },

    async writeGuardState(next: SyncLintGuardState): Promise<void> {
      // Scoped merge: the whole `sync_lint_guards` object is this leg's state; sibling
      // metadata keys (health, last_skip_reason, ...) are left alone.
      const { sql } = getOrgPg();
      await sql`
        UPDATE harness_shared.routines
           SET metadata = COALESCE(metadata, '{}'::jsonb)
                          || jsonb_build_object('sync_lint_guards', ${JSON.stringify(next)}::text::jsonb)
         WHERE install_slug = ${cfg.installSlug} AND name = ${SYNC_LINT_GUARDS_ROUTINE_NAME}`;
    },

    async runGuard(script: SyncLintGuardScript): Promise<GuardRun> {
      const argv = idlePriorityArgv('npm', ['run', '--silent', script]);
      const r = await exec(argv.cmd, argv.args, { cwd: cfg.root, timeoutMs: SYNC_LINT_GUARD_TIMEOUT_MS });
      if (!r) return { exitCode: null, output: '', diagnostic: { outcome: 'spawn-error', durationMs: null, exitCode: null } };
      const output = stripSgr(`${r.stdout}\n${r.stderr}`);
      if (r.failureKind) {
        return { exitCode: null, output, diagnostic: { outcome: r.failureKind, durationMs: r.durationMs ?? null, exitCode: null } };
      }
      return {
        exitCode: r.status,
        output,
        diagnostic: {
          outcome: r.status === 0 ? 'completed' : 'nonzero-exit',
          durationMs: r.durationMs ?? null,
          exitCode: r.status,
        },
      };
    },
  };
}
