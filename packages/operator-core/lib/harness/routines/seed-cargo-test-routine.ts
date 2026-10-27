/**
 * Seed the `cargo-test` routine (production-test-readiness-2026-07-06 P-009 /
 * WI-3206) — `system:cargo-test` → `cargo-test-action.ts`, which runs the desktop
 * shell's Rust/cargo native suite via `scripts/report-cargo-tests.mjs` and records
 * results into `harness_shared.test_runs` (framework='cargo').
 *
 * Hourly, offset from green-checkpoint (:15) and the doc-anchor reconcile /
 * session-dir-gc slots so it never contends with them for the same tick minute.
 *
 * Seeded ACTIVE by default: the action is read-only w.r.t. the repo (it only runs
 * `cargo test`, never mutates source) and self-gates to the operator-home
 * installSlug (a stray per-hive routine cleanly no-ops), so an active routine is
 * safe from the moment it exists — finished work never ships dark (CLAUDE.md).
 * `--inactive` seeds it off for an explicit dark launch.
 *
 *   tsx seed-cargo-test-routine.ts              # seed ACTIVE
 *   tsx seed-cargo-test-routine.ts --inactive    # seed off
 */
import { runRoutineSeed } from './seed-routine-main';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.CARGO_TEST_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Hourly at :45 — offset from green-checkpoint (:15) and session-dir-gc/doc-anchor
 *  reconcile so this never contends with them for the same tick minute. */
const CRON = '0 45 * * * *';

void runRoutineSeed({
  scriptTag: 'seed-cargo-test-routine',
  prepare: () => {
    const active = !process.argv.includes('--inactive');
    const name = 'cargo-test';
    return {
      installSlug: SLUG,
      name: name,
      active,
      triggerConfig: JSON.stringify({ cron: CRON }),
      targetRole: 'system:cargo-test',
      replaceActive: true,
    };
  },
  afterSeed: async ({ active, id, workspaceId: ws, sql, name }) => {
    console.log(
        `[seed-cargo-test-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
          `hourly (:45) cargo test run of papercusp-desktop/src-tauri, recorded as framework=cargo. ` +
          (active ? 'Cadence LIVE.' : 'Inactive — enable with --active or the routines admin.'),
      );
    await sql.end({ timeout: 5 });
  },
});
