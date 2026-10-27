/**
 * Seed the `account-capacity-reprobe` routine — the scheduled walled-account re-probe's
 * 300s cadence (EI-21921833535413808; handler in `account-capacity-reprobe-action.ts`, logic
 * reused from `agent-tools/accounts/probe-capacity.ts`'s `runCapacityProbe`).
 *
 * A bespoke `tier:'ephemeral'` seed (interval_sec, NO cron, `next_fire_at = NULL`) rather than
 * a per-install blueprint `triggers.schedule` entry — the account pool is an operator-HOME-level
 * substrate concern (ONE bounded sweep serves every workspace's account rows), not a per-blueprint-
 * install cadence, mirroring `seed-consult-expiry-routine.ts`'s documented reasoning. Ephemeral
 * rows are armed by the per-host ephemeral executor (`../../dbos/ephemeral-executor.ts`) on boot —
 * NOT a bare `setInterval` (`lint:no-raw-setinterval`).
 *
 * 300s cadence: `walledOnly` bounds the per-tick cost to accounts already flagged full (typically
 * a handful across both providers), and each probe is "one minimal request" (a header read, not a
 * billed inference call) — so a 5-minute cadence recovers a false wall quickly without meaningfully
 * adding to upstream traffic. A genuinely-walled account is merely re-confirmed each tick (a 429
 * carries the true reset and changes nothing).
 *
 * SEEDED ACTIVE by default: the action is read-mostly (one probe request per already-walled
 * account) plus a narrowly-scoped write (the account-pool projection + gateway readmit) that only
 * ever CORRECTS a wall the account does not actually have — "finished work never ships dark" (root
 * CLAUDE.md). Pass `--inactive` to seed dark instead.
 *
 *   tsx seed-account-capacity-reprobe-routine.ts              # seed ACTIVE (default)
 *   tsx seed-account-capacity-reprobe-routine.ts --inactive   # seed dark
 *
 * Idempotent (upsert on (install_slug, name), same key discipline as every routine in this dir).
 * A re-run does NOT live-arm a host that's already running (restart papercup-bg-host to pick up a
 * freshly-seeded row live).
 */
import { runRoutineSeed } from './seed-routine-main';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.ACCOUNT_CAPACITY_REPROBE_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = 'account-capacity-reprobe';
const TARGET_ROLE = 'system:account-capacity-reprobe';
const DEFAULT_INTERVAL_SEC = 300;

void runRoutineSeed({
  scriptTag: 'seed-account-capacity-reprobe-routine',
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
        `[seed-account-capacity-reprobe-routine] seeded "${NAME}" for "${SLUG}" (ws=${ws}, active=${active}, ` +
          `tier=ephemeral, interval=${DEFAULT_INTERVAL_SEC}s) — scheduled walled-account re-probe cadence. ` +
          (active
            ? 'Cadence seeded ACTIVE — restart papercusp-bg-host to live-arm on a host that was already up.'
            : 'Inactive — enable via the routines admin or re-run without --inactive.'),
      );
  },
});
