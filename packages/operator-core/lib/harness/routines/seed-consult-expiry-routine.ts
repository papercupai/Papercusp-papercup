/**
 * Seed the `consult-expiry-sweep` routine — the consult lifecycle expiry sweep's
 * 300s cadence (get-feedback-relevance-consults-2026-08-16 P-005 / D-005; handler
 * in `consult-expiry-action.ts`, logic in `../../consult/consult-expiry-core.ts`).
 *
 * A bespoke `tier:'ephemeral'` seed (interval_sec, NO cron, `next_fire_at = NULL`)
 * rather than a per-install blueprint `triggers.schedule` entry — the sweep is an
 * operator-HOME-level substrate concern (ONE bounded sweep serves every
 * workspace's consult_state rows), not a per-blueprint-install cadence, mirroring
 * `seed-supervision-reconcile-routine.ts`'s documented reasoning. Ephemeral rows
 * are armed by the per-host ephemeral executor (`../../dbos/ephemeral-executor.ts`)
 * on boot — NOT a bare `setInterval` (`lint:no-raw-setinterval`).
 *
 * 300s cadence: the shortest latency contract is hard-blocked's 30m expiry, so a
 * 5-minute sweep bounds expiry-detection overshoot at ~17% of the contract — and
 * the hard-blocked park-key emit is what un-parks a requester whose responder
 * never answered, so the cadence must be well under that 30m.
 *
 * SEEDED ACTIVE by default: the sweep is bounded (LIMIT + SKIP LOCKED, partial
 * index), write-scoped to past-due open rows, and "finished work never ships
 * dark" (root CLAUDE.md). Its only wake path (the latched park-key emit) fires
 * solely for hard-blocked rows whose requester explicitly parked on that key.
 * Pass `--inactive` to seed dark instead.
 *
 *   tsx seed-consult-expiry-routine.ts              # seed ACTIVE (default)
 *   tsx seed-consult-expiry-routine.ts --inactive   # seed dark
 *
 * Idempotent (upsert on (install_slug, name), same key discipline as every
 * routine in this dir). A re-run does NOT live-arm a host that's already
 * running (restart papercup-bg-host to pick up a freshly-seeded row live).
 */
import { runRoutineSeed } from './seed-routine-main';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.CONSULT_EXPIRY_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = 'consult-expiry-sweep';
const TARGET_ROLE = 'system:consult-expiry-sweep';
const DEFAULT_INTERVAL_SEC = 300;

void runRoutineSeed({
  scriptTag: 'seed-consult-expiry-routine',
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
        `[seed-consult-expiry-routine] seeded "${NAME}" for "${SLUG}" (ws=${ws}, active=${active}, ` +
          `tier=ephemeral, interval=${DEFAULT_INTERVAL_SEC}s) — consult expiry sweep cadence. ` +
          (active
            ? 'Cadence seeded ACTIVE — restart papercusp-bg-host to live-arm on a host that was already up.'
            : 'Inactive — enable via the routines admin or re-run without --inactive.'),
      );
  },
});
