/**
 * Seed the `hosted-lifecycle-reconcile` routine — the workspace-host lifecycle recovery sweep's
 * 120s cadence (WI-2143803; handler in `hosted-lifecycle-reconcile-action.ts`, logic in
 * `workspace-host/hosted-lifecycle-store.ts`'s `reconcileHostedLifecycleJobs`).
 *
 * A bespoke `tier:'ephemeral'` seed (interval_sec, NO cron, `next_fire_at = NULL`) rather than a
 * per-install blueprint `triggers.schedule` entry — workspace-host operations are an operator-level
 * substrate concern (ONE bounded sweep serves the workspace's whole host ledger), not a
 * per-blueprint-install cadence, mirroring `seed-account-capacity-reprobe-routine.ts` and
 * `seed-consult-expiry-routine.ts`'s documented reasoning. Ephemeral rows are armed by the per-host
 * ephemeral executor (`../../dbos/ephemeral-executor.ts`) on boot — NOT a bare `setInterval`
 * (`lint:no-raw-setinterval`).
 *
 * 120s cadence, chosen against the policy the sweep itself classifies with (RECONCILIATION_POLICY
 * in hosted-lifecycle-store.ts): `stuckAfterMs` is 5min and `orphanAfterMs` is 20min, so a 2-minute
 * tick notices a stuck operation well inside its own threshold while costing one indexed SELECT of
 * the `queued`/`running` rows — a set that is empty on an idle workspace and single-digit otherwise.
 * A longer cadence would let the detection lag approach the threshold it is meant to enforce.
 *
 * ⚠ SCOPE: the row carries `workspace_id`, and `reconcileHostedLifecycleJobs` is scoped to ONE
 * workspace, so a second workspace that provisions hosts seeds its own row. That matches how the
 * ephemeral executor runs each row inside its own ALS workspace scope.
 *
 * SEEDED ACTIVE by default: without a caller the entire recovery state machine is dead code, which
 * is the defect this closes — "finished work never ships dark" (root CLAUDE.md). Its writes are
 * confined to advancing `recovery_state` on operations that have already breached their own stuck /
 * orphan / exhausted thresholds, plus a deduped intervention notice. Pass `--inactive` to seed dark.
 *
 *   tsx seed-hosted-lifecycle-reconcile-routine.ts              # seed ACTIVE (default)
 *   tsx seed-hosted-lifecycle-reconcile-routine.ts --inactive   # seed dark
 *
 * Idempotent (upsert on (install_slug, name), same key discipline as every routine in this dir).
 * A re-run does NOT live-arm a host that's already running (restart papercup-bg-host to pick up a
 * freshly-seeded row live).
 */
import { runRoutineSeed } from './seed-routine-main';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.HOSTED_LIFECYCLE_RECONCILE_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = 'hosted-lifecycle-reconcile';
const TARGET_ROLE = 'system:hosted-lifecycle-reconcile';
const DEFAULT_INTERVAL_SEC = 120;

void runRoutineSeed({
  scriptTag: 'seed-hosted-lifecycle-reconcile-routine',
  prepare: () => {
    const active = !process.argv.includes('--inactive');
    const triggerConfig = JSON.stringify({ interval_sec: DEFAULT_INTERVAL_SEC });
    return {
      installSlug: SLUG,
      name: NAME,
      active,
      triggerConfig: triggerConfig,
      targetRole: TARGET_ROLE,
      tier: 'ephemeral' as const,
      nextFire: 'null' as const,
      updateTriggerKind: true,
    };
  },
  afterSeed: async ({ active, id, workspaceId: ws, sql, triggerConfig }) => {
    console.log(
        `[seed-hosted-lifecycle-reconcile-routine] seeded "${NAME}" for "${SLUG}" (ws=${ws}, active=${active}, ` +
          `tier=ephemeral, interval=${DEFAULT_INTERVAL_SEC}s) — workspace-host lifecycle recovery sweep. ` +
          (active
            ? 'Cadence seeded ACTIVE — restart papercusp-bg-host to live-arm on a host that was already up.'
            : 'Inactive — enable via the routines admin or re-run without --inactive.'),
      );
  },
});
