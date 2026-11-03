import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// WI-4632 (GYM-2, generalized across roles): mocks for the impure async sweep tests below —
// the pure selectChronicFailures/isStaleWatermark/etc. tests above need none of these.
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: vi.fn() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-test') }));
vi.mock('../../pot/watchdog', () => ({
  recentWatchdogFires: vi.fn(),
  claimWatchdogFire: vi.fn(),
}));
vi.mock('../improvements/capture-core', () => ({ captureImprovement: vi.fn() }));
vi.mock('../../overwatch/wake-bridge', () => ({ requestOverwatchWake: vi.fn() }));
vi.mock('../../pot/wake', () => ({
  // Mirrors the real resolvePotHomeSlug's '*'-is-not-concrete rule (pot/wake.ts) without its
  // env-fallback / canonicalization plumbing — this test only needs the shape the sweep depends on.
  resolvePotHomeSlug: vi.fn((explicit?: string | null) => {
    const t = explicit?.trim();
    return t && t !== '*' ? t : null;
  }),
}));

import {
  selectChronicFailures,
  chronicErrorThreshold,
  staleWindowMs,
  isStaleWatermark,
  isLoopArmOwnerLoop,
  isLoopArmOwnerRole,
  isRedQueenDrillRow,
  autoloopRowIdentity,
  autoloopChronicFailureSweep,
  shouldLogChronicOutcome,
  silentStopThresholdMs,
  selectSilentlyStoppedRoles,
  autoloopSilentStopSweep,
  type AutoloopStateRow,
} from './autoloop-chronic-failure';
import { SANDBOX_HARNESS_SLUG } from '../../red-queen/types';
import { getOrgPg } from '@papercusp/db-org';
import { recentWatchdogFires, claimWatchdogFire } from '../../pot/watchdog';
import { captureImprovement } from '../improvements/capture-core';
import { requestOverwatchWake } from '../../overwatch/wake-bridge';
import { mockOrgPgSql } from '../../testing/mock-org-pg';

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 3, 12, 0, 0); // 2026-07-03T12:00:00Z

describe('chronicErrorThreshold', () => {
  it('defaults to 6', () => {
    const prev = process.env.PAPERCUSP_AUTOLOOP_CHRONIC_THRESHOLD;
    delete process.env.PAPERCUSP_AUTOLOOP_CHRONIC_THRESHOLD;
    expect(chronicErrorThreshold()).toBe(6);
    if (prev !== undefined) process.env.PAPERCUSP_AUTOLOOP_CHRONIC_THRESHOLD = prev;
  });
});

describe('selectChronicFailures', () => {
  function row(over: Partial<AutoloopStateRow>): AutoloopStateRow {
    return { harness_slug: 'papercusp', role: 'loop-su-x', consecutive_errors: 7, last_status: 'loop-stuck-backstop', routine_active: null, ...over };
  }

  it('breaches only rows at/over the threshold, highest streak first', () => {
    const rows = [row({ role: 'a', consecutive_errors: 6 }), row({ role: 'b', consecutive_errors: 9 }), row({ role: 'c', consecutive_errors: 5 })];
    expect(selectChronicFailures(rows, 6).map((r) => r.role)).toEqual(['b', 'a']);
  });

  it('threshold <= 0 disables the sweep entirely', () => {
    expect(selectChronicFailures([row({})], 0)).toEqual([]);
    expect(selectChronicFailures([row({})], -1)).toEqual([]);
  });

  it("EI-6760/6761/6762 real shape: a routine already auto-paused (active:false) is NOT re-escalated as a live chronic failure", () => {
    const rows = [row({ role: 'loop-su-0f81d996-9f81-4f13-b56f-2962aa7eedfa', consecutive_errors: 7, routine_active: false })];
    expect(selectChronicFailures(rows, 6)).toEqual([]);
  });

  it("EI-6753 real shape: an auto-terminated loop (last_status loop-terminal-unreachable, active:false) is NOT re-escalated as a live chronic failure", () => {
    // EI-6753 (loop-su-30633068…): the pinned su session died, so the reconcile
    // unreachable-terminal guard auto-paused the routine (active:false) recording
    // last_status 'loop-terminal-unreachable' at a high streak (19). Its stale-red
    // autoloop_state row must NOT re-file a chronic-failure ticket — the routine
    // engine already resolved the condition. Pins the exact real-world shape
    // (terminal-unreachable status + paused routine) the routine_active guard drops,
    // regardless of last_status text.
    const rows = [
      row({
        role: 'loop-su-30633068-a395-4c76-a1d7-7bc5c3c3095d',
        consecutive_errors: 19,
        last_status: 'loop-terminal-unreachable',
        routine_active: false,
      }),
    ];
    expect(selectChronicFailures(rows, 6)).toEqual([]);
  });

  it("EI-6753 defense-in-depth: even if the terminated routine row is GC'd (routine_active null) the frozen watermark is still suppressed by the staleness guard", () => {
    // If the auto-paused routine row is later reaped (leaving routine_active null →
    // fail-open on the routine_active axis), the row is a FROZEN watermark: it last
    // fired at termination and can never fire (or reset) again. The staleness guard
    // (EI-6765) must still suppress it so a reaped-routine terminal loop cannot
    // re-escalate in perpetuity.
    const rows = [
      row({
        role: 'loop-su-30633068-a395-4c76-a1d7-7bc5c3c3095d',
        consecutive_errors: 19,
        last_status: 'loop-terminal-unreachable',
        routine_active: null,
        last_fired_at: new Date(NOW - 7 * HOUR_MS).toISOString(), // last fired at termination, >6h stale
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it("EI-6769 boundary: a paused routine at EXACTLY the threshold (streak == threshold) is still skipped, not escalated", () => {
    // EI-6769 (loop-su-cea4c674…) was auto-filed at streak==6 (the exact threshold)
    // while its routine was already active:false, ~15min before the routine_active
    // skip-filter landed. Pin the threshold-boundary so a >= vs > slip can never
    // re-open that pre-fix escalation of an already-resolved (paused) condition.
    const rows = [row({ role: 'loop-su-cea4c674-d05a-49df-9748-62a6702753d3', consecutive_errors: 6, routine_active: false })];
    expect(selectChronicFailures(rows, 6)).toEqual([]);
  });

  it("EI-6730 real shape: a high-streak (36) stuck-backstop loop, routine paused AND >6h stale, is NOT re-escalated", () => {
    // EI-6730 (loop-su-1a5c2d41…): the pinned su session died, the loop climbed to
    // consecutive_errors=36 (last_status 'loop-stuck-backstop'), then the routine was
    // paused (active:false) and its last fire froze ~3 days ago. Both resolution guards
    // apply (routine_active:false AND a >6h-stale frozen watermark), so its stale-red
    // autoloop_state row must NOT re-file a chronic-failure ticket. Confirmed live via
    // hive_watchdog_fires: no autoloop-chronic fire for this row since the guards landed.
    // Pins the HIGHEST-streak real shape yet (existing pins cap at 19) so a future change
    // that gated the routine_active/stale guard below some streak ceiling would fail here.
    const rows = [
      row({
        role: 'loop-su-1a5c2d41-f3f2-483b-92a0-c86c6af002c8',
        harness_slug: '*',
        consecutive_errors: 36,
        last_status: 'loop-stuck-backstop',
        routine_active: false,
        last_fired_at: new Date(NOW - 3 * 24 * HOUR_MS).toISOString(), // ~3 days stale
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it('EI-6698 real shape: a loop:arm owner loop deactivated via a NON-terminal path (active:false, last_status still loop-stuck-backstop) at a record streak (175) is NOT re-escalated', () => {
    // EI-6698 (loop-su-5bd1ad27…@*): the pinned su session died; the loop stuck-backstopped
    // 175 consecutive times (10-min interval, ~29h) before its routine went active:false —
    // but via a NON-terminal path (metadata last_error_source: dbos-executor-reaper), so
    // next_fire_at stayed at the parked 'infinity' sentinel and last_status stayed
    // 'loop-stuck-backstop' rather than the WI-1399 terminal marker 'loop-terminal-unreachable'.
    // Every prior all-3-axes pin (EI-6718) carries the terminal marker; this one proves the
    // suppression is INDEPENDENT of last_status text — it hits the loop:arm-owner AND
    // routine_active:false AND staleness axes at once regardless of HOW the routine was paused.
    // Guards against a future change that (wrongly) gated the paused/loop-arm skip on the exact
    // terminal-marker string, which would re-open this record-streak escalation flood. Highest
    // real-world streak pin in the file (prior stuck-backstop max was 36).
    const rows = [
      row({
        harness_slug: '*',
        role: 'loop-su-5bd1ad27-2015-4f78-b2c6-c91f2a1d4ea2',
        consecutive_errors: 175,
        last_status: 'loop-stuck-backstop', // NON-terminal — routine deactivated by a different path
        routine_active: false,
        routine_target_owner_id: 'su-5bd1ad27-2015-4f78-b2c6-c91f2a1d4ea2',
        last_fired_at: new Date(NOW - 3 * 24 * HOUR_MS).toISOString(), // ~3 days stale frozen watermark
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it('EI-6694 real shape: a dead loop:arm owner loop, all three axes, at the HIGHEST real streak (220) is NOT re-escalated', () => {
    // EI-6694 (loop-su-9e3ca906-101d-4933-a3e1-3ab4034a4fce@*): the pinned su session ended
    // cleanly (exit 0) 2026-06-21; the loop then stuck-backstopped 220 consecutive times (5-min
    // interval) before its routine went active:false, its last fire freezing 2026-07-01 (~3 days
    // stale). All three exclusion axes apply at once — loop:arm OWNER loop (target_owner_id
    // non-null, its own dead-owner escalation), routine auto-paused (active:false), and a >6h-stale
    // frozen watermark. This is the HIGHEST real-world streak pinned in this file (prior max was
    // EI-6698 at 175), so it guards against a future change that (wrongly) gated any of the three
    // guards below some streak ceiling — which would re-open this exact escalation.
    const rows = [
      row({
        harness_slug: '*',
        role: 'loop-su-9e3ca906-101d-4933-a3e1-3ab4034a4fce',
        consecutive_errors: 220,
        last_status: 'loop-stuck-backstop',
        routine_active: false,
        routine_target_owner_id: 'su-9e3ca906-101d-4933-a3e1-3ab4034a4fce',
        last_fired_at: new Date(NOW - 3 * 24 * HOUR_MS).toISOString(), // ~3 days stale frozen watermark
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it('EI-6692 real shape: a dead loop:arm owner loop reaped via a NON-terminal path, at the HIGHEST real streak (221), is NOT re-escalated', () => {
    // EI-6692 (loop-su-34db408d-fe89-4c3b-b6aa-c3e4651a5e0a@*): the pinned su session
    // (adv_sessions 6767, started 2026-06-24) died WITHOUT a clean end marker — ended_at
    // stayed NULL (a stale-active orphan, the dbos-executor-reaper non-terminal path from
    // EI-6698), so last_status stayed the non-terminal 'loop-stuck-backstop' rather than the
    // WI-1399 marker. The loop stuck-backstopped 221 consecutive times before its routine went
    // active:false, its last fire freezing 2026-07-01 (~3 days stale). All three exclusion axes
    // still apply — loop:arm OWNER loop (target_owner_id non-null), routine auto-paused
    // (active:false), AND a >6h-stale frozen watermark — so the collector reads only
    // autoloop_state + routines (never adv_sessions), and the NULL ended_at is irrelevant to
    // suppression. This is the HIGHEST real-world streak pinned in this file (prior max was
    // EI-6694 at 220) and re-confirms suppression is INDEPENDENT of both last_status text and
    // the owner-session end-marker state. Live proof it stays suppressed: hive_watchdog_fires
    // shows exactly ONE autoloop-chronic fire for this row (2026-07-02, the one that filed
    // EI-6692) and none since, despite the row still carrying 221 errors.
    const rows = [
      row({
        harness_slug: '*',
        role: 'loop-su-34db408d-fe89-4c3b-b6aa-c3e4651a5e0a',
        consecutive_errors: 221,
        last_status: 'loop-stuck-backstop',
        routine_active: false,
        routine_target_owner_id: 'su-34db408d-fe89-4c3b-b6aa-c3e4651a5e0a',
        last_fired_at: new Date(NOW - 3 * 24 * HOUR_MS).toISOString(), // ~3 days stale frozen watermark
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it('EI-6690 real shape: a dead loop-role-* owner loop (role-* owner, not su-*) at the HIGHEST real streak (226) is NOT re-escalated', () => {
    // EI-6690 (loop-role-da950389-8866-4f33-bfd9-74db3e832f6c@*): the FIRST real-world
    // `loop-role-*` shape pinned in this file — every prior pin is a `loop-su-<uuid>` owner
    // loop whose routine.target_owner_id is `su-<uuid>`. This loop:arm loop is ROLE-owned:
    // role `loop-role-<uuid>`, routine target_owner_id `role-<uuid>` (prefix `role-`, not
    // `su-`). The pinned owner died; the loop stuck-backstopped 226 consecutive times before
    // its routine went active:false, its last fire freezing 2026-07-01 (~3 days stale). All
    // three exclusion axes apply — loop:arm OWNER loop (target_owner_id non-null), routine
    // auto-paused (active:false), AND a >6h-stale frozen watermark. Critically, this proves
    // `isLoopArmOwnerLoop` is PREFIX-AGNOSTIC — it keys on target_owner_id being non-null, NOT
    // on the `su-`/`role-` owner prefix — so a future change that (wrongly) gated the loop:arm
    // guard on the `su-` prefix would re-open this class. Also the HIGHEST real streak pinned
    // here (prior max was EI-6692 at 221). Live proof it stays suppressed: hive_watchdog_fires
    // shows exactly ONE autoloop-chronic fire for this row (2026-07-02, which filed EI-6690)
    // and none since, despite the row still carrying 226 errors.
    const rows = [
      row({
        harness_slug: '*',
        role: 'loop-role-da950389-8866-4f33-bfd9-74db3e832f6c',
        consecutive_errors: 226,
        last_status: 'loop-stuck-backstop',
        routine_active: false,
        routine_target_owner_id: 'role-da950389-8866-4f33-bfd9-74db3e832f6c',
        last_fired_at: new Date(NOW - 3 * 24 * HOUR_MS).toISOString(), // ~3 days stale frozen watermark
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it('a FIXED SYSTEM role still active (armed, still trying+failing) IS escalated', () => {
    // Was `loop-su-still-live` (EI-7220): a `loop-`-prefixed role is now recognized as a
    // loop:arm OWNER loop by its ROLE NAME alone (join-independent), so it is ALWAYS suppressed
    // — an active loop:arm loop is owner-witnessed, never the sweep's concern. This test's real
    // intent is the routine_active axis for the sweep's ACTUAL scope: a witness-less fixed
    // system role (gym-cycle) that is still armed and failing must escalate.
    const rows = [row({ role: 'gym-cycle', consecutive_errors: 7, routine_active: true })];
    expect(selectChronicFailures(rows, 6)).toHaveLength(1);
  });

  it('EI-7220 root shape: an ORPHANED loop:arm row (routine GC\'d → owner-id null, recently fired) is NOT escalated by its ROLE NAME', () => {
    // EI-7220 (loop-su-c2b2ece8-…@*, red 7 consecutive fires): the dead su session's
    // loop:arm routine was reaped while its stale-red autoloop_state row lingered. With the
    // routine row gone, the LEFT JOIN yields routine_target_owner_id = NULL (and
    // routine_active = NULL), so BOTH the owner-id marker AND the routine_active guard fail
    // OPEN — and it fired recently enough that the staleness guard doesn't catch it either.
    // Pre-fix it escalated as if a witness-less fixed system role. The role-NAME marker
    // (`loop-su-…` begins with `loop-`) is join-independent and suppresses it regardless.
    const rows = [
      row({
        harness_slug: '*',
        role: 'loop-su-c2b2ece8-d18f-4246-9ce2-d5bc0fdb4050',
        consecutive_errors: 7,
        last_status: 'loop-stuck-backstop',
        routine_active: null, // routine GC'd — no matching routines row
        routine_target_owner_id: null, // JOIN yielded null — the fragile owner-id marker fails open
        last_fired_at: new Date(NOW - 60 * 1000).toISOString(), // fired 1min ago — not stale
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it('EI-7220: an orphaned loop-role-* row (role-owner, routine GC\'d) is also suppressed by its role name', () => {
    // The role marker is prefix-agnostic on the owner (su-/role-/bare-uuid): every loop:arm
    // role is `loop-${ownerId}`, so `loop-role-<uuid>` begins with `loop-` too.
    const rows = [
      row({
        harness_slug: '*',
        role: 'loop-role-da950389-8866-4f33-bfd9-74db3e832f6c',
        consecutive_errors: 12,
        routine_active: null,
        routine_target_owner_id: null,
        last_fired_at: new Date(NOW - 60 * 1000).toISOString(),
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it("EI-7299 real shape: an orphaned loop-su-* row at EXACTLY the threshold (6, routine GC'd → owner-id null) is suppressed by its role name", () => {
    // EI-7299 (loop-su-cd477d93-e068-4b84-97d9-24f8554f8775@*, red 6 consecutive fires): filed
    // 2026-07-04, BEFORE the EI-7220 role-name guard (`isLoopArmOwnerRole`) landed 2026-07-05.
    // The dead su session's loop:arm routine was reaped while its stale-red autoloop_state row
    // lingered, so the LEFT JOIN yields BOTH routine_active = NULL and routine_target_owner_id =
    // NULL (the fragile owner-id marker fails open), and it fired recently enough that the
    // staleness guard doesn't catch it either. It is the SAME class as EI-7220 (loop-su-c2b2ece8…)
    // but pinned at EXACTLY the chronic threshold (6, vs EI-7220's 7) — a boundary pin against a
    // future `> threshold` slip re-opening the loop-su-* flood for a row sitting on the threshold.
    // The role-NAME marker (`loop-su-…` begins with `loop-`) is join-independent and suppresses it.
    const rows = [
      row({
        harness_slug: '*',
        role: 'loop-su-cd477d93-e068-4b84-97d9-24f8554f8775',
        consecutive_errors: 6, // exactly the threshold — "red 6 consecutive fires"
        last_status: 'loop-stuck-backstop',
        routine_active: null, // routine GC'd — no matching routines row
        routine_target_owner_id: null, // JOIN yielded null — the fragile owner-id marker fails open
        last_fired_at: new Date(NOW - 60 * 1000).toISOString(), // fired 1min ago — not stale
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it("EI-7297 real shape: an orphaned loop-su-* row at EXACTLY the threshold (6, routine GC'd → owner-id null) is suppressed by its role name", () => {
    // EI-7297 (loop-su-91ee2629-23c8-46f6-89ad-ada8b13bf44c@*, red 6 consecutive fires): filed
    // 2026-07-04, BEFORE the EI-7220 role-name guard (`isLoopArmOwnerRole`) landed 2026-07-05.
    // Byte-for-byte the SAME class as EI-7299 (loop-su-cd477d93…) and EI-7220 (loop-su-c2b2ece8…):
    // the dead su session's loop:arm routine was reaped while its stale-red autoloop_state row
    // lingered, so the LEFT JOIN yields BOTH routine_active = NULL and routine_target_owner_id =
    // NULL (the fragile owner-id marker fails open), and it fired recently enough that the
    // staleness guard doesn't catch it either. Pre-fix (owner-id marker only) it would escalate as
    // if a witness-less fixed system role; the role-NAME marker (`loop-su-…` begins with `loop-`)
    // is join-independent and suppresses it. A distinct real-incident pin at the exact chronic
    // threshold (6) guarding against a `> threshold` slip re-opening this loop-su-* flood.
    const rows = [
      row({
        harness_slug: '*',
        role: 'loop-su-91ee2629-23c8-46f6-89ad-ada8b13bf44c',
        consecutive_errors: 6, // exactly the threshold — "red 6 consecutive fires"
        last_status: 'loop-stuck-backstop',
        routine_active: null, // routine GC'd — no matching routines row
        routine_target_owner_id: null, // JOIN yielded null — the fragile owner-id marker fails open
        last_fired_at: new Date(NOW - 60 * 1000).toISOString(), // fired 1min ago — not stale
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it("EI-7312 real shape: an orphaned loop-su-* row at EXACTLY the threshold (6, routine GC'd → owner-id null) is suppressed by its role name", () => {
    // EI-7312 (loop-su-9ff27e79-8f34-40c9-b0db-3db3f8a727d4@*, red 6 consecutive fires): filed
    // 2026-07-04 05:41, over a day BEFORE the EI-7220 role-name guard (`isLoopArmOwnerRole`) landed
    // 2026-07-05 12:10 (commit 34ab1dc348). Byte-for-byte the SAME class as EI-7297 (loop-su-91ee2629…)
    // and EI-7299 (loop-su-cd477d93…): the dead su session's loop:arm routine was reaped while its
    // stale-red autoloop_state row lingered, so the LEFT JOIN yields BOTH routine_active = NULL and
    // routine_target_owner_id = NULL (the fragile owner-id marker fails open), and it fired recently
    // enough that the staleness guard doesn't catch it either. Pre-fix (owner-id marker only) it would
    // escalate as if a witness-less fixed system role; the role-NAME marker (`loop-su-…` begins with
    // `loop-`) is join-independent and suppresses it. Verified live at resolution: the 9ff27e79
    // autoloop_state row is now fully GC'd (0 rows), its routine is active=false, and no coord_presence
    // row remains — the live condition is gone AND the deployed guard would suppress it. A distinct
    // real-incident pin at the exact chronic threshold (6) guarding against a `> threshold` slip
    // re-opening this loop-su-* flood.
    const rows = [
      row({
        harness_slug: '*',
        role: 'loop-su-9ff27e79-8f34-40c9-b0db-3db3f8a727d4',
        consecutive_errors: 6, // exactly the threshold — "red 6 consecutive fires"
        last_status: 'loop-stuck-backstop',
        routine_active: null, // routine GC'd — no matching routines row
        routine_target_owner_id: null, // JOIN yielded null — the fragile owner-id marker fails open
        last_fired_at: new Date(NOW - 60 * 1000).toISOString(), // fired 1min ago — not stale
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it("EI-7294 real shape: an orphaned loop-su-* row at EXACTLY the threshold (6, routine GC'd → owner-id null) is suppressed by its role name", () => {
    // EI-7294 (loop-su-caab983b-d805-477d-b173-92e13b69dc18@*, red 6 consecutive fires): filed
    // 2026-07-04 03:47, over a day BEFORE the EI-7220 role-name guard (`isLoopArmOwnerRole`) landed
    // 2026-07-05 12:10 (commit 34ab1dc348). Byte-for-byte the SAME class as EI-7312 (loop-su-9ff27e79…),
    // EI-7297 (loop-su-91ee2629…) and EI-7299 (loop-su-cd477d93…): the dead su session's loop:arm
    // routine was reaped while its stale-red autoloop_state row lingered, so the LEFT JOIN yields BOTH
    // routine_active = NULL and routine_target_owner_id = NULL (the fragile owner-id marker fails open),
    // and it fired recently enough that the staleness guard doesn't catch it either. Pre-fix (owner-id
    // marker only) it would escalate as if a witness-less fixed system role; the role-NAME marker
    // (`loop-su-…` begins with `loop-`) is join-independent and suppresses it. Verified live at
    // resolution: the caab983b autoloop_state row is now fully GC'd (0 rows) and its routine is
    // active=false (target_owner_id non-null) — the live condition is gone AND the deployed guard would
    // suppress it. A distinct real-incident pin at the exact chronic threshold (6) guarding against a
    // `> threshold` slip re-opening this loop-su-* flood.
    const rows = [
      row({
        harness_slug: '*',
        role: 'loop-su-caab983b-d805-477d-b173-92e13b69dc18',
        consecutive_errors: 6, // exactly the threshold — "red 6 consecutive fires"
        last_status: 'loop-stuck-backstop',
        routine_active: null, // routine GC'd — no matching routines row
        routine_target_owner_id: null, // JOIN yielded null — the fragile owner-id marker fails open
        last_fired_at: new Date(NOW - 60 * 1000).toISOString(), // fired 1min ago — not stale
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it("EI-7293 real shape: an orphaned loop-su-* row at EXACTLY the threshold (6) is suppressed by its role name", () => {
    // EI-7293 (loop-su-c267121c-9987-4abd-a5af-d1193b355713@*, red 6 consecutive fires): filed
    // 2026-07-04 03:47 (same batch as EI-7294 loop-su-caab983b…), over a day BEFORE the EI-7220
    // role-name guard (`isLoopArmOwnerRole`) landed 2026-07-05 12:10 (commit 34ab1dc348).
    // Byte-for-byte the SAME class as EI-7294 / EI-7312 (loop-su-9ff27e79…) / EI-7297 (loop-su-91ee2629…)
    // / EI-7299 (loop-su-cd477d93…): a dead su session's loop:arm loop whose stale-red autoloop_state
    // row outlived its owner. Pre-fix (owner-id marker only) it would escalate as if a witness-less
    // fixed system role; the role-NAME marker (`loop-su-…` begins with `loop-`) is join-independent and
    // suppresses it regardless of the LEFT JOIN. This pin models the WORST case (routine GC'd →
    // routine_active NULL and routine_target_owner_id NULL, fired recently so the staleness guard also
    // misses) so ONLY the role-name marker can catch it — the strongest guard for the actual fix.
    // Verified live at resolution: the c267121c autoloop_state row is fully GC'd (0 rows) and its
    // routine is active=false (target_owner_id non-null, target_role system:loop-wake) — the live
    // condition is gone AND the deployed guard would suppress it. A distinct real-incident pin at the
    // exact chronic threshold (6) guarding against a `> threshold` slip re-opening this loop-su-* flood.
    const rows = [
      row({
        harness_slug: '*',
        role: 'loop-su-c267121c-9987-4abd-a5af-d1193b355713',
        consecutive_errors: 6, // exactly the threshold — "red 6 consecutive fires"
        last_status: 'loop-stuck-backstop',
        routine_active: null, // worst case: routine GC'd — no matching routines row
        routine_target_owner_id: null, // JOIN yielded null — the fragile owner-id marker fails open
        last_fired_at: new Date(NOW - 60 * 1000).toISOString(), // fired 1min ago — not stale
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it("EI-6727 real shape: a LIVE (routine active, recently fired) loop:arm owner loop is NOT escalated — pre-pause window", () => {
    // EI-6727 (loop-su-dad90f05…) and 27 siblings: a dead su session's loop:arm loop climbs
    // past the chronic threshold (6) and the sweep escalates it in the WINDOW before the
    // reconcile dead-owner guard circuit-opens (≥8) and pauses the routine. At escalation time
    // the row looks live (routine_active:true, recent fire) so neither the routine_active nor
    // the staleness guard catches it — only the target_owner_id marker (a loop:arm OWNER loop,
    // which has its OWN dead-owner escalation) does. Must NOT re-file a chronic-failure ticket.
    const rows = [
      row({
        harness_slug: '*',
        role: 'loop-su-dad90f05-580b-4cb0-b81e-8cb951756c59',
        consecutive_errors: 7,
        last_status: 'loop-stuck-backstop',
        routine_active: true,
        routine_target_owner_id: 'su-dad90f05-580b-4cb0-b81e-8cb951756c59',
        last_fired_at: new Date(NOW - 60 * 1000).toISOString(), // fired 1min ago — not stale
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it('EI-6718 real shape: a dead loop:arm owner loop already auto-paused AND stale is NOT re-escalated', () => {
    // EI-6718 (loop-su-7e812a66…@*): a pre-fix chronic-failure ticket filed 2026-07-02, before
    // the EI-6727 loop:arm guard landed. The live row now hits ALL THREE exclusion axes at once —
    // the reconcile dead-owner guard has auto-paused the routine (active:false), it is a loop:arm
    // OWNER loop (target_owner_id non-null, with its own escalation), and its last fire is a stale
    // frozen watermark. Any one axis suffices; together they pin that this class stays suppressed.
    const rows = [
      row({
        harness_slug: '*',
        role: 'loop-su-7e812a66-7d3d-4f41-a73d-9f523209f666',
        consecutive_errors: 54,
        last_status: 'loop-terminal-unreachable',
        routine_active: false,
        routine_target_owner_id: 'su-7e812a66-7d3d-4f41-a73d-9f523209f666',
        last_fired_at: new Date(NOW - 30 * HOUR_MS).toISOString(), // last fired > staleness window ago
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it('EI-6727: a fixed SYSTEM role (no target_owner_id) still escalates — the suppression is loop:arm-only', () => {
    // Regression guard against over-suppression: gym-cycle/director/overwatch/scout-cycle are
    // witness-less fixed system roles with NO target_owner_id and no other escalation path —
    // they remain the sweep's whole point and MUST still escalate.
    const rows = [
      row({ role: 'gym-cycle', consecutive_errors: 8, routine_active: true, routine_target_owner_id: null }),
    ];
    expect(selectChronicFailures(rows, 6).map((r) => r.role)).toEqual(['gym-cycle']);
  });

  it('EI-6727: a loop:arm owner loop is dropped even at a very high streak while its routine is still active', () => {
    // Some dead loops reach streaks of 55+ before the reconcile tick pauses them (the guard
    // needs looksDeadOrStuck + a reconcile pass). A high streak must NOT re-open escalation of
    // a loop:arm owner loop — the guard owns its escalation regardless of streak.
    const rows = [
      row({
        role: 'loop-su-45001f87-6b30-43f6-b37f-1899adad537f',
        consecutive_errors: 58,
        routine_active: true,
        routine_target_owner_id: 'su-45001f87-6b30-43f6-b37f-1899adad537f',
        last_fired_at: new Date(NOW - 60 * 1000).toISOString(),
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it('EI-6727 mixed batch: loop:arm owner loops drop, fixed system roles still breach in order', () => {
    const rows = [
      row({ role: 'gym-cycle', consecutive_errors: 10, routine_active: true, routine_target_owner_id: null }),
      row({ role: 'loop-su-a', consecutive_errors: 30, routine_active: true, routine_target_owner_id: 'su-a' }),
      row({ role: 'scout-cycle', consecutive_errors: 8, routine_active: null, routine_target_owner_id: null }),
      row({ role: 'loop-su-b', consecutive_errors: 99, routine_active: true, routine_target_owner_id: 'su-b' }),
    ];
    expect(selectChronicFailures(rows, 6).map((r) => r.role)).toEqual(['gym-cycle', 'scout-cycle']);
  });

  it('a role with NO matching routines row (routine_active: null — director/gym-cycle/overwatch/scout-cycle) fails OPEN and is still escalated', () => {
    const rows = [row({ role: 'gym-cycle', consecutive_errors: 8, routine_active: null })];
    expect(selectChronicFailures(rows, 6)).toHaveLength(1);
  });

  it('mixed batch: only the explicitly-paused row is dropped, the rest still breach in order', () => {
    const rows = [
      row({ role: 'live-high', consecutive_errors: 10, routine_active: true }),
      row({ role: 'paused', consecutive_errors: 9, routine_active: false }),
      row({ role: 'no-routine', consecutive_errors: 8, routine_active: null }),
    ];
    expect(selectChronicFailures(rows, 6).map((r) => r.role)).toEqual(['live-high', 'no-routine']);
  });

  it('EI-6765 real shape: an orphaned overwatch@papercup row (6 errors, last fired 8 days ago) is a frozen watermark, NOT escalated', () => {
    // The active overwatch loop moved to the `papercusp` home slug (which is `ok`),
    // leaving `papercup` frozen at 6 errors with a stale "180000ms" last_status. It
    // never fires again, so its streak can never reset — it must NOT re-escalate.
    const rows = [
      row({
        harness_slug: 'papercup',
        role: 'kettle',
        consecutive_errors: 6,
        routine_active: null, // overwatch is a fixed system role — no matching routines row
        last_status: 'error: no complete scorecard within 180000ms launch deadline; backstop synthesized',
        last_fired_at: new Date(NOW - 8 * 24 * HOUR_MS).toISOString(), // 8 days stale
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it('a still-firing loop (last fired within the staleness window) IS escalated despite fail-open null routine', () => {
    const rows = [
      row({
        role: 'gym-cycle',
        consecutive_errors: 8,
        routine_active: null,
        last_fired_at: new Date(NOW - 30 * 60 * 1000).toISOString(), // 30min ago — well within window
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toHaveLength(1);
  });

  it('null/absent last_fired_at fails OPEN — an unknown fire time never silently suppresses escalation', () => {
    const rows = [
      row({ role: 'null-fired', consecutive_errors: 7, last_fired_at: null }),
      row({ role: 'absent-fired', consecutive_errors: 7 }), // last_fired_at undefined
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS }).map((r) => r.role)).toEqual([
      'null-fired',
      'absent-fired',
    ]);
  });

  it('staleMs <= 0 disables the staleness guard entirely (fail-open — even an ancient row escalates)', () => {
    const rows = [
      row({ role: 'ancient', consecutive_errors: 9, last_fired_at: new Date(NOW - 100 * 24 * HOUR_MS).toISOString() }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 0 })).toHaveLength(1);
  });

  it('EI-12429 real shape: the planted red-queen-sandbox drill row is NOT escalated as a chronic failure', () => {
    // EI-12429 (red-queen-drill-worker@red-queen-sandbox, red 7 consecutive fires): the Red Queen
    // vaccination harness plants a synthetic autoloop_state row (drill-classes.ts circuitOpenDrill —
    // harness_slug 'red-queen-sandbox', role 'red-queen-drill-worker', consecutive_errors 7,
    // last_status '…synthetic consecutive fire errors (planted, origin=drill)') to exercise the
    // fire-circuit-open collector, then detects/heals/cleans it itself. This sweep's SELECT is NOT
    // workspace-scoped, so it saw the transient planted row and (pre-fix) escalated it as a real
    // chronic failure that re-fired every 24h. The row looks live on every OTHER axis — not a
    // loop:arm loop, routine_active null (fail-open), fired now (not stale) — so ONLY the sandbox
    // harness-slug guard (isRedQueenDrillRow) can suppress it.
    const rows = [
      row({
        harness_slug: SANDBOX_HARNESS_SLUG, // 'red-queen-sandbox'
        role: 'red-queen-drill-worker',
        consecutive_errors: 7,
        last_status: 'red-queen drill: synthetic consecutive fire errors (planted, origin=drill)',
        routine_active: null, // no matching routines row — fail-open on the routine_active axis
        routine_target_owner_id: null, // not a loop:arm loop
        last_fired_at: new Date(NOW - 60 * 1000).toISOString(), // fired 1min ago — not stale
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it('EI-12429 mixed batch: a red-queen drill row drops while a witness-less fixed system role still escalates', () => {
    const rows = [
      row({
        harness_slug: SANDBOX_HARNESS_SLUG,
        role: 'red-queen-drill-worker',
        consecutive_errors: 12,
        last_status: 'red-queen drill: synthetic consecutive fire errors (planted, origin=drill)',
        routine_active: null,
        last_fired_at: new Date(NOW - 60 * 1000).toISOString(),
      }),
      row({ role: 'gym-cycle', consecutive_errors: 8, routine_active: true, routine_target_owner_id: null, last_fired_at: new Date(NOW - 30 * 60 * 1000).toISOString() }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS }).map((r) => r.role)).toEqual(['gym-cycle']);
  });
});

describe('staleWindowMs', () => {
  it('defaults to 6 hours', () => {
    const prev = process.env.PAPERCUSP_AUTOLOOP_STALE_MS;
    delete process.env.PAPERCUSP_AUTOLOOP_STALE_MS;
    expect(staleWindowMs()).toBe(6 * HOUR_MS);
    if (prev !== undefined) process.env.PAPERCUSP_AUTOLOOP_STALE_MS = prev;
  });

  it('is env-overridable', () => {
    const prev = process.env.PAPERCUSP_AUTOLOOP_STALE_MS;
    process.env.PAPERCUSP_AUTOLOOP_STALE_MS = '90000';
    expect(staleWindowMs()).toBe(90000);
    if (prev !== undefined) process.env.PAPERCUSP_AUTOLOOP_STALE_MS = prev;
    else delete process.env.PAPERCUSP_AUTOLOOP_STALE_MS;
  });
});

describe('isStaleWatermark', () => {
  it('true when last fire is older than the window', () => {
    expect(isStaleWatermark({ last_fired_at: new Date(NOW - 7 * HOUR_MS).toISOString() }, NOW, 6 * HOUR_MS)).toBe(true);
  });
  it('false when last fire is within the window', () => {
    expect(isStaleWatermark({ last_fired_at: new Date(NOW - 5 * HOUR_MS).toISOString() }, NOW, 6 * HOUR_MS)).toBe(false);
  });
  it('accepts a Date as well as an ISO string', () => {
    expect(isStaleWatermark({ last_fired_at: new Date(NOW - 7 * HOUR_MS) }, NOW, 6 * HOUR_MS)).toBe(true);
  });
  it('fails OPEN (false) on null, undefined, or an unparseable value', () => {
    expect(isStaleWatermark({ last_fired_at: null }, NOW, 6 * HOUR_MS)).toBe(false);
    expect(isStaleWatermark({ last_fired_at: undefined }, NOW, 6 * HOUR_MS)).toBe(false);
    expect(isStaleWatermark({ last_fired_at: 'not-a-date' }, NOW, 6 * HOUR_MS)).toBe(false);
  });
  it('staleMs <= 0 disables (never stale)', () => {
    expect(isStaleWatermark({ last_fired_at: new Date(NOW - 100 * HOUR_MS).toISOString() }, NOW, 0)).toBe(false);
  });
});

describe('isLoopArmOwnerLoop (EI-6727)', () => {
  it('non-null, non-empty target_owner_id → loop:arm owner loop (true)', () => {
    expect(isLoopArmOwnerLoop({ routine_target_owner_id: 'su-dad90f05-580b-4cb0-b81e-8cb951756c59' })).toBe(true);
  });
  it('EI-6690: prefix-agnostic — a `role-<uuid>` owner (not `su-`) is still a loop:arm owner loop (true)', () => {
    // The guard keys on target_owner_id being present, NOT the owner prefix: a `loop-role-*`
    // loop is owned by `role-<uuid>`, and must be suppressed exactly like a `loop-su-*` loop.
    expect(isLoopArmOwnerLoop({ routine_target_owner_id: 'role-da950389-8866-4f33-bfd9-74db3e832f6c' })).toBe(true);
  });
  it('null / undefined / empty → fixed system role, fail-open (false)', () => {
    expect(isLoopArmOwnerLoop({ routine_target_owner_id: null })).toBe(false);
    expect(isLoopArmOwnerLoop({ routine_target_owner_id: undefined })).toBe(false);
    expect(isLoopArmOwnerLoop({ routine_target_owner_id: '' })).toBe(false);
  });
  it('EI-7220: null owner-id BUT a `loop-`-prefixed role → still a loop:arm owner loop (true)', () => {
    // The orphaned-routine shape: the JOIN yielded no owner-id, but the role name proves it.
    expect(
      isLoopArmOwnerLoop({ routine_target_owner_id: null, role: 'loop-su-c2b2ece8-d18f-4246-9ce2-d5bc0fdb4050' }),
    ).toBe(true);
    expect(isLoopArmOwnerLoop({ routine_target_owner_id: '', role: 'loop-role-da950389' })).toBe(true);
    expect(isLoopArmOwnerLoop({ routine_target_owner_id: null, role: 'loop-28dbf719-6c0e' })).toBe(true);
  });
  it('EI-7220: null owner-id AND a non-`loop-` (fixed system) role → fail-open (false)', () => {
    expect(isLoopArmOwnerLoop({ routine_target_owner_id: null, role: 'gym-cycle' })).toBe(false);
    expect(isLoopArmOwnerLoop({ routine_target_owner_id: null, role: 'kettle' })).toBe(false);
    expect(isLoopArmOwnerLoop({ routine_target_owner_id: null })).toBe(false); // role absent
  });
});

describe('isLoopArmOwnerRole (EI-7220)', () => {
  it('a `loop-`-prefixed role (loop-su-*, loop-role-*, loop-<uuid>) → true (join-independent marker)', () => {
    expect(isLoopArmOwnerRole('loop-su-c2b2ece8-d18f-4246-9ce2-d5bc0fdb4050')).toBe(true);
    expect(isLoopArmOwnerRole('loop-role-da950389-8866-4f33-bfd9-74db3e832f6c')).toBe(true);
    expect(isLoopArmOwnerRole('loop-28dbf719-6c0e-4f42-a0d2-56d6be156634')).toBe(true);
  });
  it('a fixed system role (director/gym-cycle/overwatch/scout-cycle) → false (no `loop-` prefix)', () => {
    expect(isLoopArmOwnerRole('director')).toBe(false);
    expect(isLoopArmOwnerRole('gym-cycle')).toBe(false);
    expect(isLoopArmOwnerRole('kettle')).toBe(false);
    expect(isLoopArmOwnerRole('scout-cycle')).toBe(false);
  });
  it('null / undefined / non-string → false', () => {
    expect(isLoopArmOwnerRole(null)).toBe(false);
    expect(isLoopArmOwnerRole(undefined)).toBe(false);
  });
});

describe('isRedQueenDrillRow (EI-12429)', () => {
  it('a row in the red-queen sandbox harness → drill row (true), regardless of role', () => {
    expect(isRedQueenDrillRow({ harness_slug: SANDBOX_HARNESS_SLUG })).toBe(true);
    expect(isRedQueenDrillRow({ harness_slug: 'red-queen-sandbox' })).toBe(true);
    // keyed on the sandbox slug, NOT the role — a future drill class planting a different role
    // in the sandbox is suppressed too.
    expect(isRedQueenDrillRow({ harness_slug: SANDBOX_HARNESS_SLUG })).toBe(true);
  });
  it('a real harness slug → not a drill row (false)', () => {
    expect(isRedQueenDrillRow({ harness_slug: 'papercusp' })).toBe(false);
    expect(isRedQueenDrillRow({ harness_slug: 'papercup' })).toBe(false);
    expect(isRedQueenDrillRow({ harness_slug: '*' })).toBe(false);
    // the role, not the harness, is the drill worker — but a real harness never carries it, and
    // the guard keys on the harness anyway, so a stray same-named role in a real harness is fine.
    expect(isRedQueenDrillRow({ harness_slug: 'some-real-harness' })).toBe(false);
  });
});

describe('silentStopThresholdMs', () => {
  it('defaults to 24 hours', () => {
    const prev = process.env.PAPERCUSP_AUTOLOOP_SILENT_STOP_MS;
    delete process.env.PAPERCUSP_AUTOLOOP_SILENT_STOP_MS;
    expect(silentStopThresholdMs()).toBe(24 * HOUR_MS);
    if (prev !== undefined) process.env.PAPERCUSP_AUTOLOOP_SILENT_STOP_MS = prev;
  });

  it('is env-overridable', () => {
    const prev = process.env.PAPERCUSP_AUTOLOOP_SILENT_STOP_MS;
    process.env.PAPERCUSP_AUTOLOOP_SILENT_STOP_MS = '90000';
    expect(silentStopThresholdMs()).toBe(90000);
    if (prev !== undefined) process.env.PAPERCUSP_AUTOLOOP_SILENT_STOP_MS = prev;
    else delete process.env.PAPERCUSP_AUTOLOOP_SILENT_STOP_MS;
  });
});

describe('selectSilentlyStoppedRoles (EI-19281872822982156)', () => {
  function row(over: Partial<AutoloopStateRow>): AutoloopStateRow {
    return {
      harness_slug: 'papercusp',
      role: 'kettle',
      consecutive_errors: 0,
      last_status: 'ok',
      routine_active: null,
      last_fired_at: new Date(NOW - 7 * 24 * HOUR_MS).toISOString(), // 7d stale, like the reported kettle incident
      ...over,
    };
  }

  it('the motivating case: 0 errors + 7d silent → caught, invisible to consecutive_errors alone', () => {
    const rows = [row({})];
    expect(selectSilentlyStoppedRoles(rows, 6, { now: NOW, silentStopMs: 24 * HOUR_MS }).map((r) => r.role)).toEqual(['kettle']);
  });

  it('a row that fired recently is never caught, regardless of error count', () => {
    const rows = [row({ last_fired_at: new Date(NOW - 1 * HOUR_MS).toISOString() })];
    expect(selectSilentlyStoppedRoles(rows, 6, { now: NOW, silentStopMs: 24 * HOUR_MS })).toEqual([]);
  });

  it('a row the chronic sweep WILL ACTUALLY escalate (breaching AND not frozen) is EXCLUDED — never double-escalated here', () => {
    // 2h silent: past a 1h silent-stop window, but still INSIDE the 6h chronic
    // staleness window, so selectChronicFailures genuinely does escalate it.
    const rows = [row({ consecutive_errors: 9, last_fired_at: new Date(NOW - 2 * HOUR_MS).toISOString() })];
    expect(
      selectSilentlyStoppedRoles(rows, 6, { now: NOW, silentStopMs: 1 * HOUR_MS, chronicStaleMs: 6 * HOUR_MS }),
    ).toEqual([]);
  });

  it('a stale gym-cycle watermark is not a silent stop without a matching eligible gym autoloop', () => {
    expect(
      selectSilentlyStoppedRoles([row({ role: 'gym-cycle', gym_cycle_eligible: false })], 6, {
        now: NOW,
        silentStopMs: 24 * HOUR_MS,
      }),
    ).toEqual([]);
    expect(
      selectSilentlyStoppedRoles([row({ role: 'gym-cycle', gym_cycle_eligible: true })], 6, {
        now: NOW,
        silentStopMs: 24 * HOUR_MS,
      }).map((r) => r.role),
    ).toEqual(['gym-cycle']);
  });

  it('EI-19908775413647773 — a breaching row the chronic sweep SUPPRESSES as a frozen watermark IS caught here', () => {
    // 9 errors + 7d silent: over threshold, but far past the 6h chronic staleness
    // window, so selectChronicFailures drops it as `skipped-stale`. Deferring on
    // the chronic sweep's SCOPE rather than its OUTPUT left this escalated by nobody.
    const rows = [row({ consecutive_errors: 9 })];
    expect(
      selectSilentlyStoppedRoles(rows, 6, { now: NOW, silentStopMs: 24 * HOUR_MS, chronicStaleMs: 6 * HOUR_MS }).map((r) => r.role),
    ).toEqual(['kettle']);
  });

  it('EI-19908775413647773 — at EXACTLY the threshold too (the boundary papercup::kettle sat on for 44d)', () => {
    const rows = [row({ consecutive_errors: 6, last_fired_at: new Date(NOW - 44 * 24 * HOUR_MS).toISOString() })];
    expect(
      selectSilentlyStoppedRoles(rows, 6, { now: NOW, silentStopMs: 24 * HOUR_MS, chronicStaleMs: 6 * HOUR_MS }).map((r) => r.role),
    ).toEqual(['kettle']);
  });

  it('a Red Queen drill row is excluded', () => {
    const rows = [row({ harness_slug: SANDBOX_HARNESS_SLUG })];
    expect(selectSilentlyStoppedRoles(rows, 6, { now: NOW, silentStopMs: 24 * HOUR_MS })).toEqual([]);
  });

  it('a loop:arm owner loop is excluded', () => {
    const rows = [row({ role: 'loop-su-deadbeef-0000-0000-0000-000000000000', routine_target_owner_id: 'su-deadbeef' })];
    expect(selectSilentlyStoppedRoles(rows, 6, { now: NOW, silentStopMs: 24 * HOUR_MS })).toEqual([]);
  });

  it('an already explicitly-paused routine (routine_active:false) is excluded — that alarm is stale-paused-routines\' job', () => {
    const rows = [row({ routine_active: false })];
    expect(selectSilentlyStoppedRoles(rows, 6, { now: NOW, silentStopMs: 24 * HOUR_MS })).toEqual([]);
  });

  it('routine_active: null (no matching routines row — a fixed system role) is NOT excluded — fail-open', () => {
    const rows = [row({ routine_active: null })];
    expect(selectSilentlyStoppedRoles(rows, 6, { now: NOW, silentStopMs: 24 * HOUR_MS }).map((r) => r.role)).toEqual(['kettle']);
  });

  it('the non-dispatched in-process sweep arm-state sentinel is not treated as a fired autoloop role', () => {
    // `in-process:sweep` is the target_role on per-check arm-state rows; it is never fired by
    // the routine executor. A stale autoloop_state row under that sentinel cannot measure timer liveness.
    expect(
      selectSilentlyStoppedRoles([row({ role: 'in-process:sweep', consecutive_errors: 1, routine_active: null })], 6, {
        now: NOW,
        silentStopMs: 24 * HOUR_MS,
      }),
    ).toEqual([]);
    expect(
      selectChronicFailures(
        [row({ role: 'in-process:sweep', consecutive_errors: 9, routine_active: null, last_fired_at: new Date(NOW - HOUR_MS).toISOString() })],
        6,
        { now: NOW, staleMs: 6 * HOUR_MS },
      ),
    ).toEqual([]);
  });

  it('null last_fired_at never matches (nothing to measure a silence from)', () => {
    const rows = [row({ last_fired_at: null })];
    expect(selectSilentlyStoppedRoles(rows, 6, { now: NOW, silentStopMs: 24 * HOUR_MS })).toEqual([]);
  });

  it('silentStopMs <= 0 disables entirely', () => {
    expect(selectSilentlyStoppedRoles([row({})], 6, { now: NOW, silentStopMs: 0 })).toEqual([]);
  });

  it('sorts most-overdue (oldest last-fire) first', () => {
    const rows = [
      row({ role: 'a', last_fired_at: new Date(NOW - 25 * HOUR_MS).toISOString() }),
      row({ role: 'b', last_fired_at: new Date(NOW - 200 * HOUR_MS).toISOString() }),
      row({ role: 'c', last_fired_at: new Date(NOW - 30 * HOUR_MS).toISOString() }),
    ];
    expect(selectSilentlyStoppedRoles(rows, 6, { now: NOW, silentStopMs: 24 * HOUR_MS }).map((r) => r.role)).toEqual(['b', 'c', 'a']);
  });
});

describe('autoloopChronicFailureSweep — WI-4632: escalation ALSO wakes overwatch (GYM-2, generalized across roles)', () => {
  function mockRows(rows: AutoloopStateRow[]): void {
    const sql = vi.fn(() => Promise.resolve(rows));
    mockOrgPgSql(vi.mocked(getOrgPg), sql);
  }

  beforeEach(() => {
    vi.mocked(recentWatchdogFires).mockResolvedValue(0);
    vi.mocked(claimWatchdogFire).mockResolvedValue(true);
    vi.mocked(captureImprovement).mockResolvedValue({} as never);
    vi.mocked(requestOverwatchWake).mockResolvedValue({ wired: true, result: { fired: true } });
  });
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.PAPERCUSP_AUTOLOOP_CHRONIC_THRESHOLD;
  });

  it('SYNTHETIC error-streak on a fixed system role (streak over threshold): files the observation AND wakes overwatch', async () => {
    mockRows([
      {
        harness_slug: 'papercusp',
        role: 'gym-cycle',
        consecutive_errors: 9,
        last_status: 'synthetic: injected for WI-4632 escalation test',
        routine_active: true,
        last_fired_at: new Date().toISOString(),
      },
    ]);

    const results = await autoloopChronicFailureSweep();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      harnessSlug: 'papercusp',
      role: 'gym-cycle',
      outcome: 'escalated',
      overwatchWaked: true,
    });
    // the observation (D-002's captureImprovement, kind:'bug') is filed exactly once —
    expect(captureImprovement).toHaveBeenCalledTimes(1);
    expect(captureImprovement).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'bug', title: expect.stringContaining('gym-cycle@papercusp') }),
    );
    // — AND the overwatch is woken with the same evidence, through the B-07↔B-04 seam.
    expect(requestOverwatchWake).toHaveBeenCalledTimes(1);
    expect(requestOverwatchWake).toHaveBeenCalledWith(
      expect.objectContaining({
        harness: 'papercusp',
        workspaceId: 'ws-test',
        reason: expect.stringContaining('gym-cycle@papercusp'),
      }),
    );
  });

  it('a loop:arm owner-loop breach is suppressed entirely — never files, never wakes (it owns its own dead-owner escalation)', async () => {
    mockRows([
      {
        harness_slug: '*',
        role: 'loop-su-deadbeef-0000-0000-0000-000000000000',
        consecutive_errors: 30,
        last_status: 'loop-stuck-backstop',
        routine_active: true,
        routine_target_owner_id: 'su-deadbeef-0000-0000-0000-000000000000',
        last_fired_at: new Date().toISOString(),
      },
    ]);

    const results = await autoloopChronicFailureSweep();

    expect(results.map((r) => r.outcome)).toEqual(['skipped-loop-arm']);
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(requestOverwatchWake).not.toHaveBeenCalled();
  });

  it('a wildcard-scoped row with no resolvable pot-home harness: observation still files, wake is a no-op (overwatchWaked:false) — never blocked', async () => {
    mockRows([
      {
        harness_slug: '*', // no concrete pot-home harness for the wake target (resolvePotHomeSlug → null)
        role: 'director',
        consecutive_errors: 7,
        last_status: 'synthetic',
        routine_active: null,
        last_fired_at: new Date().toISOString(),
      },
    ]);

    const results = await autoloopChronicFailureSweep();

    expect(results[0]).toMatchObject({ outcome: 'escalated', overwatchWaked: false });
    expect(captureImprovement).toHaveBeenCalledTimes(1);
    expect(requestOverwatchWake).not.toHaveBeenCalled();
  });

  it('debounced (already fired within 24h): never re-files AND never re-wakes overwatch', async () => {
    vi.mocked(recentWatchdogFires).mockResolvedValue(1);
    mockRows([
      {
        harness_slug: 'papercusp',
        role: 'gym-cycle',
        consecutive_errors: 9,
        last_status: 'x',
        routine_active: true,
        last_fired_at: new Date().toISOString(),
      },
    ]);

    const results = await autoloopChronicFailureSweep();

    expect(results[0].outcome).toBe('debounced');
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(requestOverwatchWake).not.toHaveBeenCalled();
  });

  it('requestOverwatchWake throwing is swallowed: the already-filed observation is NOT undone and the sweep still reports escalated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(requestOverwatchWake).mockRejectedValue(new Error('boom'));
    mockRows([
      {
        harness_slug: 'papercusp',
        role: 'gym-cycle',
        consecutive_errors: 9,
        last_status: 'x',
        routine_active: true,
        last_fired_at: new Date().toISOString(),
      },
    ]);

    const results = await autoloopChronicFailureSweep();

    expect(results[0]).toMatchObject({ outcome: 'escalated', overwatchWaked: false });
    expect(captureImprovement).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('overwatch wake failed'));
    warn.mockRestore();
  });

  it('requestOverwatchWake resolving wired:true but with an error field counts as NOT waked (overwatchWaked:false)', async () => {
    vi.mocked(requestOverwatchWake).mockResolvedValue({ wired: true, error: 'launch failed' });
    mockRows([
      {
        harness_slug: 'papercusp',
        role: 'gym-cycle',
        consecutive_errors: 9,
        last_status: 'x',
        routine_active: true,
        last_fired_at: new Date().toISOString(),
      },
    ]);

    const results = await autoloopChronicFailureSweep();

    expect(results[0]).toMatchObject({ outcome: 'escalated', overwatchWaked: false });
  });
});

describe('autoloopSilentStopSweep (EI-19281872822982156) — the error-count-independent liveness sweep', () => {
  function mockRows(rows: AutoloopStateRow[]): void {
    const sql = vi.fn(() => Promise.resolve(rows));
    mockOrgPgSql(vi.mocked(getOrgPg), sql);
  }

  beforeEach(() => {
    vi.mocked(recentWatchdogFires).mockResolvedValue(0);
    vi.mocked(claimWatchdogFire).mockResolvedValue(true);
    vi.mocked(captureImprovement).mockResolvedValue({} as never);
    vi.mocked(requestOverwatchWake).mockResolvedValue({ wired: true, result: { fired: true } });
  });
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.PAPERCUSP_AUTOLOOP_SILENT_STOP_MS;
  });

  it('the motivating case: kettle, 0 errors, last_status ok, 7d silent — files the observation AND wakes overwatch', async () => {
    mockRows([
      {
        harness_slug: 'papercusp',
        role: 'kettle',
        consecutive_errors: 0,
        last_status: 'ok',
        routine_active: null,
        last_fired_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ]);

    const results = await autoloopSilentStopSweep();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ harnessSlug: 'papercusp', role: 'kettle', outcome: 'escalated', overwatchWaked: true });
    expect(captureImprovement).toHaveBeenCalledTimes(1);
    expect(captureImprovement).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'bug', title: expect.stringContaining('kettle@papercusp') }),
    );
    expect(requestOverwatchWake).toHaveBeenCalledTimes(1);
  });

  it('a scheduled gym-cycle tick with no eligible budgeted config does not escalate its stale per-harness watermark', async () => {
    mockRows([
      {
        harness_slug: 'papercusp',
        role: 'gym-cycle',
        consecutive_errors: 1,
        last_status: 'gym-cycle:dispatch',
        routine_active: true,
        last_fired_at: new Date(Date.now() - 943 * 60 * 60 * 1000).toISOString(),
        gym_autoloop_enabled: true,
        gym_autoloop_status: 'idle',
        gym_autoloop_budget_usd: null,
        gym_autoloop_spent_usd: 0,
      },
    ]);

    const results = await autoloopSilentStopSweep();

    expect(results).toEqual([]);
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(requestOverwatchWake).not.toHaveBeenCalled();
  });

  it('a row the chronic sweep WILL ACTUALLY escalate (breaching AND not yet frozen) never double-escalates here', async () => {
    // Discriminating ONLY when silentStopMs < staleWindowMs() (6h): at 2h silent
    // the row is past a 1h silent-stop window but is NOT yet a frozen watermark,
    // so the chronic sweep still genuinely owns it and we must stand down.
    // Under the shipped constants (24h > 6h) this case is unreachable, which is
    // precisely why deferring on SCOPE instead of OUTPUT was pure hole.
    process.env.PAPERCUSP_AUTOLOOP_SILENT_STOP_MS = String(60 * 60 * 1000);
    mockRows([
      {
        harness_slug: 'papercusp',
        role: 'gym-cycle',
        consecutive_errors: 30,
        last_status: 'x',
        routine_active: true,
        last_fired_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      },
    ]);

    const results = await autoloopSilentStopSweep();

    expect(results).toEqual([]);
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  // EI-19908775413647773 — THE SEAM. These two are the control the 85-test suite
  // lacked: before the fix both returned [], because the sweep deferred to the
  // chronic sweep's SCOPE while the chronic sweep was suppressing the same row as
  // a frozen watermark. Nothing escalated them. Measured live: papercup::kettle,
  // exactly at threshold, 44d dead, 52 `skipped-stale` records and 0 alarms.
  it('THE SEAM, at the boundary: a breaching row the chronic sweep SUPPRESSES as a frozen watermark IS escalated here', async () => {
    mockRows([
      {
        harness_slug: 'papercup',
        role: 'kettle',
        // EXACTLY chronicErrorThreshold() — `>= threshold` fell through, `< threshold` excluded it.
        consecutive_errors: 6,
        last_status: 'error: HTTP 404 — {"error":"unknown project"}',
        routine_active: null,
        last_fired_at: new Date(Date.now() - 44 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ]);

    const results = await autoloopSilentStopSweep();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ harnessSlug: 'papercup', role: 'kettle', outcome: 'escalated' });
    expect(captureImprovement).toHaveBeenCalledTimes(1);
  });

  it('THE SEAM, well above the boundary: 30 errors + 7d frozen also escalates (it is the suppression, not the count, that decides)', async () => {
    mockRows([
      {
        harness_slug: 'papercusp',
        role: 'gym-cycle',
        consecutive_errors: 30,
        last_status: 'x',
        routine_active: true,
        last_fired_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        gym_autoloop_enabled: true,
        gym_autoloop_status: 'idle',
        gym_autoloop_budget_usd: 50,
        gym_autoloop_spent_usd: 0,
      },
    ]);

    const results = await autoloopSilentStopSweep();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ role: 'gym-cycle', outcome: 'escalated' });
  });

  it('an explicitly-paused routine (routine_active:false) is left to the stale-paused-routines alarm', async () => {
    mockRows([
      {
        harness_slug: 'papercusp',
        role: 'bp-singleton-scout-0',
        consecutive_errors: 0,
        last_status: 'ok',
        routine_active: false,
        last_fired_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ]);

    const results = await autoloopSilentStopSweep();

    expect(results).toEqual([]);
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('debounced (already fired within 24h): never re-files AND never re-wakes overwatch', async () => {
    vi.mocked(recentWatchdogFires).mockResolvedValue(1);
    mockRows([
      {
        harness_slug: 'papercusp',
        role: 'kettle',
        consecutive_errors: 0,
        last_status: 'ok',
        routine_active: null,
        last_fired_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ]);

    const results = await autoloopSilentStopSweep();

    expect(results[0].outcome).toBe('debounced');
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(requestOverwatchWake).not.toHaveBeenCalled();
  });

  it('PAPERCUSP_AUTOLOOP_SILENT_STOP_MS <= 0 disables the sweep entirely (independent kill switch)', async () => {
    process.env.PAPERCUSP_AUTOLOOP_SILENT_STOP_MS = '0';
    mockRows([
      {
        harness_slug: 'papercusp',
        role: 'kettle',
        consecutive_errors: 0,
        last_status: 'ok',
        routine_active: null,
        last_fired_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ]);

    const results = await autoloopSilentStopSweep();

    expect(results).toEqual([]);
    expect(getOrgPg).not.toHaveBeenCalled();
  });
});

describe('shouldLogChronicOutcome — EI-12968 (rate-limit the skip-family LOG LINE, not the decision)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a non-skip outcome (escalated/error) is NEVER rate-limited — always logs, never touches claimWatchdogFire', async () => {
    expect(await shouldLogChronicOutcome({ harnessSlug: 'papercusp', role: 'gym-cycle', outcome: 'escalated' })).toBe(true);
    expect(await shouldLogChronicOutcome({ harnessSlug: 'papercusp', role: 'gym-cycle', outcome: 'error' })).toBe(true);
    expect(claimWatchdogFire).not.toHaveBeenCalled();
  });

  it('a skip-family outcome defers to claimWatchdogFire\'s atomic claim (true = first this window, log it)', async () => {
    vi.mocked(claimWatchdogFire).mockResolvedValue(true);
    const ok = await shouldLogChronicOutcome({ harnessSlug: 'papercup', role: 'kettle', outcome: 'skipped-stale' });
    expect(ok).toBe(true);
    expect(claimWatchdogFire).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-test',
        installSlug: 'skipped-stale::papercup::kettle',
        source: 'autoloop-chronic-skip-log',
        windowHours: 1,
      }),
    );
  });

  it('a skip-family outcome already claimed within the window ⇒ false (suppress the duplicate log line)', async () => {
    vi.mocked(claimWatchdogFire).mockResolvedValue(false);
    const ok = await shouldLogChronicOutcome({ harnessSlug: 'papercup', role: 'kettle', outcome: 'skipped-stale' });
    expect(ok).toBe(false);
  });

  it('every skip-family outcome (paused/drill/loop-arm) is covered, each keyed distinctly by outcome', async () => {
    vi.mocked(claimWatchdogFire).mockResolvedValue(true);
    for (const outcome of ['skipped-paused', 'skipped-drill', 'skipped-loop-arm'] as const) {
      await shouldLogChronicOutcome({ harnessSlug: 'h', role: 'r', outcome });
      expect(claimWatchdogFire).toHaveBeenLastCalledWith(
        expect.objectContaining({ installSlug: `${outcome}::h::r` }),
      );
    }
  });

  it('a custom windowHours overrides the 1h default', async () => {
    vi.mocked(claimWatchdogFire).mockResolvedValue(true);
    await shouldLogChronicOutcome({ harnessSlug: 'h', role: 'r', outcome: 'skipped-stale' }, { windowHours: 4 });
    expect(claimWatchdogFire).toHaveBeenCalledWith(expect.objectContaining({ windowHours: 4 }));
  });
});

describe("workspace scoping (EI-19372306666296664) — a foreign tenant's row must never be reported", () => {
  /**
   * A `sql` mock that HONORS the `s.workspace_id = ${...}` predicate instead of ignoring the
   * query the way the other suites' `mockRows` does.
   *
   * This is the whole point of the suite. The pre-existing helper is `vi.fn(() => rows)` — it
   * returns the fixture no matter what SQL it is handed, so a test built on it passes
   * IDENTICALLY with and without the workspace predicate and can therefore never catch its
   * removal. A regression test that cannot fail before the fix is not a regression test.
   *
   * The mock is a faithful mini-interpreter of exactly the one predicate under test: the tagged
   * template hands us (strings, ...values), so the chunk immediately preceding a bound value
   * ends with `s.workspace_id =` precisely when the query filters on it. No predicate in the
   * query => every fixture row is returned, which is exactly what the unscoped SELECT did.
   */
  function mockDb(rows: Array<AutoloopStateRow & { workspace_id: string }>): { sql: ReturnType<typeof vi.fn> } {
    const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      let scoped: string | undefined;
      for (let i = 0; i < values.length; i += 1) {
        if (String(strings[i]).trimEnd().endsWith('s.workspace_id =')) scoped = String(values[i]);
      }
      const visible = scoped == null ? rows : rows.filter((r) => r.workspace_id === scoped);
      return Promise.resolve(visible.map(({ workspace_id: _w, ...rest }) => rest));
    });
    mockOrgPgSql(vi.mocked(getOrgPg), sql);
    return { sql };
  }

  beforeEach(() => {
    vi.mocked(recentWatchdogFires).mockResolvedValue(0);
    vi.mocked(claimWatchdogFire).mockResolvedValue(true);
    vi.mocked(captureImprovement).mockResolvedValue({} as never);
    vi.mocked(requestOverwatchWake).mockResolvedValue({ wired: true, result: { fired: true } });
  });
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.PAPERCUSP_AUTOLOOP_CHRONIC_THRESHOLD;
    delete process.env.PAPERCUSP_AUTOLOOP_SILENT_STOP_MS;
  });

  // The exact live false alarm: EI-19370235414830628 filed "SILENTLY STOPPED autoloop role:
  // director@papercusp — no fire in 2228h" from a `workspace_id='default'` row for a role retired
  // 93 days earlier. `harness_slug='papercusp'` exists in BOTH workspaces, so the alert text was
  // indistinguishable from a live papercusp incident.
  it('the reproducing case: a `default`-workspace `director@papercusp` row is NOT reported as silently stopped', async () => {
    mockDb([
      {
        workspace_id: 'default', // the legacy partition — NOT the active workspace
        harness_slug: 'papercusp', // same slug as the live tenant: this is what made it undiagnosable
        role: 'director',
        consecutive_errors: 2,
        last_status: 'ok',
        routine_active: null,
        last_fired_at: new Date(Date.now() - 2228 * HOUR_MS).toISOString(),
      },
    ]);

    const results = await autoloopSilentStopSweep();

    expect(results).toEqual([]);
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(requestOverwatchWake).not.toHaveBeenCalled();
  });

  it('a foreign-workspace chronic row is NOT escalated, while a live one in the SAME sweep still is', async () => {
    mockDb([
      {
        workspace_id: 'default',
        harness_slug: 'papercusp',
        role: 'director',
        consecutive_errors: 9,
        last_status: 'dead legacy tenant row',
        routine_active: null,
        last_fired_at: new Date().toISOString(),
      },
      {
        workspace_id: 'ws-test', // the active workspace (mocked activeWorkspaceId)
        harness_slug: 'papercusp',
        role: 'gym-cycle',
        consecutive_errors: 9,
        last_status: 'genuinely failing',
        routine_active: true,
        last_fired_at: new Date().toISOString(),
      },
    ]);

    const results = await autoloopChronicFailureSweep();

    // the live row still escalates — scoping must not suppress a real alert
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ role: 'gym-cycle', outcome: 'escalated' });
    expect(captureImprovement).toHaveBeenCalledTimes(1);
    // ...and the foreign tenant's row is absent from the filed artifact entirely
    const title = String(vi.mocked(captureImprovement).mock.calls[0]?.[0]?.title ?? '');
    expect(title).toContain('gym-cycle@papercusp');
    expect(title).not.toContain('director');
  });

  // The write-side consequence, which is what makes this a correctness bug and not just noise:
  // `workspaceId` was ALREADY resolved and handed to claimWatchdogFire/recentWatchdogFires, so an
  // unscoped row consumed the ACTIVE workspace's 24h debounce slot for its (harness, role) — able
  // to suppress a genuine alert for the same pair.
  it("a foreign row never consumes the active workspace's debounce slot", async () => {
    mockDb([
      {
        workspace_id: 'default',
        harness_slug: 'papercusp',
        role: 'director',
        consecutive_errors: 9,
        last_status: 'dead legacy tenant row',
        routine_active: null,
        last_fired_at: new Date().toISOString(),
      },
    ]);

    await autoloopChronicFailureSweep();

    expect(claimWatchdogFire).not.toHaveBeenCalled();
  });

  it('both sweeps bind the active workspace into the SELECT', async () => {
    const { sql } = mockDb([]);
    await autoloopChronicFailureSweep();
    await autoloopSilentStopSweep();

    expect(sql).toHaveBeenCalledTimes(2);
    for (const call of sql.mock.calls) {
      const [strings, ...values] = call as unknown as [TemplateStringsArray, ...unknown[]];
      expect(strings.join('?')).toContain('s.workspace_id =');
      expect(values).toContain('ws-test');
    }
  });

  // EI-12429's guard keys on harness_slug, an axis independent of workspace_id. It is retained
  // deliberately: activeWorkspaceId() honors a PAPERCUSP_WORKSPACE_ID env pin, so a process pinned
  // to the sandbox workspace would surface the planted drill row with only the scope guard.
  it('the red-queen drill guard still suppresses a planted row even when it IS in the active workspace', async () => {
    mockDb([
      {
        workspace_id: 'ws-test',
        harness_slug: SANDBOX_HARNESS_SLUG,
        role: 'red-queen-drill-worker',
        consecutive_errors: 7,
        last_status: 'red-queen drill: synthetic consecutive fire errors (planted, origin=drill)',
        routine_active: true,
        last_fired_at: new Date().toISOString(),
      },
    ]);

    const results = await autoloopChronicFailureSweep();

    expect(results.map((r) => r.outcome)).toEqual(['skipped-drill']);
    expect(captureImprovement).not.toHaveBeenCalled();
  });
});

describe('autoloopRowIdentity (EI-19372306666296664)', () => {
  it('renders role@harness [workspace] so a cross-tenant row can never masquerade as a live one', () => {
    expect(autoloopRowIdentity({ role: 'director', harness_slug: 'papercusp' }, 'default')).toBe(
      'director@papercusp [default]',
    );
    // the two rows that were textually identical before the workspace was printed
    expect(autoloopRowIdentity({ role: 'director', harness_slug: 'papercusp' }, 'papercusp-workspace')).not.toBe(
      autoloopRowIdentity({ role: 'director', harness_slug: 'papercusp' }, 'default'),
    );
  });

  it('is what the escalation title actually renders', async () => {
    const sql = vi.fn(() =>
      Promise.resolve([
        {
          harness_slug: 'papercusp',
          role: 'gym-cycle',
          consecutive_errors: 9,
          last_status: 'x',
          routine_active: true,
          last_fired_at: new Date().toISOString(),
        },
      ]),
    );
    mockOrgPgSql(vi.mocked(getOrgPg), sql);
    vi.mocked(recentWatchdogFires).mockResolvedValue(0);
    vi.mocked(claimWatchdogFire).mockResolvedValue(true);
    vi.mocked(captureImprovement).mockResolvedValue({} as never);
    vi.mocked(requestOverwatchWake).mockResolvedValue({ wired: true, result: { fired: true } });

    await autoloopChronicFailureSweep();

    expect(captureImprovement).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('gym-cycle@papercusp [ws-test]') }),
    );
    vi.clearAllMocks();
  });
});
