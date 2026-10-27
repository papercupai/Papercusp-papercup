/**
 * thresholds.test — the green/yellow/red status model (system-health-tab-2026-06-15
 * P-006 / Phase 4). Pure boundary tests: no DB, no IO. Pins the load-bearing
 * boundaries (Queen stall, opus paused, dead routine, sync-lag, escalation aging)
 * + the worst-of roll-up's fail-soft (unknown never reds the system).
 */
import { describe, it, expect } from 'vitest';
import {
  queenStatus,
  beesStatus,
  workItemsStatus,
  workFeedStatus,
  tokensStatus,
  watchdogStatus,
  deployStatus,
  plansStatus,
  escalationsStatus,
  autonomyStatus,
  overwatchStatus,
  worstStatus,
  deriveQueenAlive,
  infraStatus,
  infraSummary,
  infraMcpProxyMetric,
  infraCritAmbientOnly,
  evaluateHostPressure,
  statusSeverity,
  ackCovers,
  reconcilePausedQueen,
  loopsStatus,
  coordinationStatus,
  memoryStatus,
  classifyInjectionClient,
  worstInjectionVerdict,
  contextInjectionStatus,
  QUEEN_STALL_MS,
  SYNC_LAG_WARN_MS,
  DEPLOY_BEHIND_WARN,
  BG_HOST_STALE_CODE_GRACE_MS,
  GIT_SYNC_PUSH_FAIL_CRIT,
  POOL_PROJECTION_STALE_WARN_MS,
  POOL_PROJECTION_STALE_CRIT_MS,
  MCP_PROXY_HARD_FAIL_CRIT,
  MCP_PROXY_CRITICAL_CONTINUATION_WAIT_CRIT_MS,
  DISK_USED_WARN_PCT,
  DISK_USED_CRIT_PCT,
  diskBandWithHysteresis,
  BACKUP_STALE_MS,
  UNANSWERED_DIRECTED_WARN_MS,
  isReaperWedged,
  HOST_PRESSURE_MAX_AGE_MS,
  HOST_PRESSURE_CPU_PSI_WARN_PCT,
  HOST_PRESSURE_MEMORY_PSI_FULL_CRIT_PCT,
  HOST_PRESSURE_RUNNABLE_WARN_PER_CORE,
} from './thresholds';
import type {
  QueenHealth,
  BeesHealth,
  WorkItemsHealth,
  WorkFeedHealth,
  TokensHealth,
  WatchdogHealth,
  DeployHealth,
  PanelStatus,
  PlansHealth,
  EscalationsHealth,
  AutonomyHealth,
  OverwatchPanelHealth,
  InfraHealth,
  McpProxyHealth,
  LoopsHealth,
  CoordinationHealth,
  MemoryPanelHealth,
  ContextInjectionHealth,
  ContextInjectionClientRow,
  HostPressureSample,
} from './types';

const queen = (o: Partial<QueenHealth> = {}): QueenHealth => ({
  potSlug: 'h', started: true, stalled: false, midTurn: false, armed: true,
  lastWakeAt: 0, staleForMs: 60_000, nextFireAt: 0, cadenceOk: true,
  watchdogFires24h: 0, demand: { todoItems: 0, startedPlans: 0 },
  decisionsWindow: { total: 0, auto: 0, gated: 0 }, workingTracked: 0, ...o,
});

describe('queenStatus', () => {
  it('crit when stalled (the origin failure mode)', () => {
    expect(queenStatus(queen({ stalled: true }))).toBe('crit');
  });
  it('warn when paused (not started) with nothing queued — idle by choice', () => {
    expect(queenStatus(queen({ started: false }))).toBe('warn');
  });
  it('crit when paused with demand queued — silent outage (P-003)', () => {
    expect(queenStatus(queen({ started: false, demand: { todoItems: 2, startedPlans: 0 } }))).toBe('crit');
    expect(queenStatus(queen({ started: false, demand: { todoItems: 0, startedPlans: 1 } }))).toBe('crit');
  });
  it('warn when started + no wake armed + demand queued', () => {
    expect(queenStatus(queen({ armed: false, demand: { todoItems: 3, startedPlans: 0 } }))).toBe('warn');
  });
  it('ok when started + no wake armed but no demand (nothing to do)', () => {
    expect(queenStatus(queen({ armed: false, demand: { todoItems: 0, startedPlans: 0 } }))).toBe('ok');
  });
  it('warn when the watchdog has fired repeatedly (prompt bug)', () => {
    expect(queenStatus(queen({ watchdogFires24h: 3 }))).toBe('warn');
  });
  it('ok when looping with cadence', () => {
    expect(queenStatus(queen())).toBe('ok');
  });
});

describe('deriveQueenAlive — liveness-only, kept DISTINCT from stalled (EI-623)', () => {
  it('alive when looping with cadence (started + armed + not stalled)', () => {
    expect(deriveQueenAlive(queen())).toBe(true);
  });
  it('alive when started + ARMED even if stalled (re-armable → flows to queen-stalled, NOT queen-dark)', () => {
    expect(deriveQueenAlive(queen({ stalled: true, armed: true }))).toBe(true);
  });
  it('DARK when started + NOT armed + stalled (no next wake AND stale = the loop is gone)', () => {
    expect(deriveQueenAlive(queen({ stalled: true, armed: false }))).toBe(false);
  });
  it('alive when started + not armed but not stalled (between wakes, not dead)', () => {
    expect(deriveQueenAlive(queen({ stalled: false, armed: false }))).toBe(true);
  });
  it('alive when paused (not started) — intentional, never a false dark alarm', () => {
    expect(deriveQueenAlive(queen({ started: false, armed: false, stalled: false }))).toBe(true);
  });
  it('alive when the queen panel is unreadable (null) — conservative, never false-dark', () => {
    expect(deriveQueenAlive(null)).toBe(true);
  });
});

describe('beesStatus', () => {
  const bees = (o: Partial<BeesHealth> = {}): BeesHealth => ({
    running: 2, alive: 2, stale: 0, orphanedClaims: 0, totalLoad: 2, invalidModelFailures: 0,
    placements: { recovering: 0, cursed: 0, stranded: 0, workingTracked: 2 }, ...o,
  });
  it('crit on a cursed placement', () => {
    expect(beesStatus(bees({ placements: { recovering: 0, cursed: 1, stranded: 0, workingTracked: 0 } }))).toBe('crit');
  });
  it('warn on orphaned claims', () => {
    expect(beesStatus(bees({ orphanedClaims: 1 }))).toBe('warn');
  });
  it('warn on invalid selected-model spawn failures', () => {
    expect(beesStatus(bees({ invalidModelFailures: 1 }))).toBe('warn');
  });
  it('warn on stranded/recovering placements', () => {
    expect(beesStatus(bees({ placements: { recovering: 0, cursed: 0, stranded: 2, workingTracked: 0 } }))).toBe('warn');
  });
  it('ok with healthy bees', () => {
    expect(beesStatus(bees())).toBe('ok');
  });
});

describe('workItemsStatus', () => {
  const wi = (o: Partial<WorkItemsHealth> = {}): WorkItemsHealth => ({
    total: 10, byState: {}, todo: 4, inProgress: 3, blocked: 2, needsHuman: 0, done: 1, ...o,
  });
  it('warn when items need a human', () => {
    expect(workItemsStatus(wi({ needsHuman: 1 }))).toBe('warn');
  });
  it('ok otherwise (backlog alone is not unhealthy)', () => {
    expect(workItemsStatus(wi({ blocked: 50 }))).toBe('ok');
  });
  it('crit when a settled completion remains proposed (authority upgrade failed/reverted)', () => {
    expect(workItemsStatus(wi({ settlementAuthorityFailures: 1 }))).toBe('crit');
  });
  // Stuck-items recovery (work-queue-stuck-item-recovery P-008 / P-009), as
  // RECALIBRATED by fleet-lead-instrumentation-audit-2026-08-09 D-010 / P-016.
  it('crit when the reaper is WEDGED (recorded but aged-out) AND rows are actually rotting', () => {
    expect(workItemsStatus(wi({ reaperStale: true, reaperAgeSec: 600, deadHeldClaims: 3 }))).toBe('crit');
  });
  // P-016 INVERTS the original P-009 expectation here (it asserted 'crit' on the
  // clock alone). Deliberate: measured 2026-08-09 against the release checkout,
  // the live crit fired every tick with stuckTotal === 0 and never resolved —
  // the alarm text carried no ", N stuck" segment while shouting REAPER WEDGED.
  // A reaper with nothing stuck has nothing it failed to do. The condition stays
  // visible via the plain `reaperStale` warn leg; it just stops paging.
  it('warn (NOT crit) when the reaper is aged-out but the recovery backlog is EMPTY', () => {
    expect(workItemsStatus(wi({ reaperStale: true, reaperAgeSec: 600 }))).toBe('warn');
  });
  it('warn (not crit) when the reaper has NEVER recorded a run (null age — fresh boot, no backlog)', () => {
    expect(workItemsStatus(wi({ reaperStale: true, reaperAgeSec: null }))).toBe('warn');
  });
  // EI-2534 (reclaim-lane-not-firing): a never-recorded reaper (un-armed/dark sweep)
  // WHILE a real dead-held backlog is stranded must escalate to crit — NOT the passive
  // warn that let 7 P1 claims sit ~3h. The boot-blip warn above only applies with no backlog.
  it('crit when the reaper has NEVER recorded a run AND a dead-held backlog is stranded (un-armed sweep)', () => {
    expect(workItemsStatus(wi({ reaperStale: true, reaperAgeSec: null, deadHeldClaims: 7 }))).toBe('crit');
  });
  it('crit on a never-recorded reaper with any stranded recovery backlog (stuck / dead-assigned / dead-held reservations)', () => {
    expect(workItemsStatus(wi({ reaperStale: true, reaperAgeSec: null, stuckFeatures: 1 }))).toBe('crit');
    expect(workItemsStatus(wi({ reaperStale: true, reaperAgeSec: null, deadAssignedIssues: 2 }))).toBe('crit');
    expect(workItemsStatus(wi({ reaperStale: true, reaperAgeSec: null, deadHeldAssignments: 3 }))).toBe('crit');
  });
  it('a dead-held backlog with a LIVE (fresh) reaper stays warn — it is actively being cleared, not stranded', () => {
    expect(workItemsStatus(wi({ reaperStale: false, reaperAgeSec: 30, deadHeldClaims: 7 }))).toBe('warn');
  });
  it('warn when any feature is freed-but-non-dispatchable (stuck)', () => {
    expect(workItemsStatus(wi({ stuckFeatures: 1 }))).toBe('warn');
  });
  it('warn on a dead-held claim backlog or a dead-assigned issue', () => {
    expect(workItemsStatus(wi({ deadHeldClaims: 3 }))).toBe('warn');
    expect(workItemsStatus(wi({ deadAssignedIssues: 2 }))).toBe('warn');
  });
  it('ok when recovery fields are healthy (reaper fresh, nothing stuck)', () => {
    expect(workItemsStatus(wi({ reaperStale: false, reaperAgeSec: 30, stuckFeatures: 0, deadHeldClaims: 0 }))).toBe('ok');
  });
});

describe('workFeedStatus', () => {
  const wf = (o: Partial<WorkFeedHealth> = {}): WorkFeedHealth => ({
    frontier: 5, frontierBlocked: 1, startedPlans: 2, autoEligibleStuck: 0, deadRoutines: 0, deadRoutineNames: [], ...o,
  });
  it('crit on a dead routine (EI-584 — starves the feed)', () => {
    expect(workFeedStatus(wf({ deadRoutines: 1, deadRoutineNames: ['hive-wake'] }))).toBe('crit');
  });
  it('warn when auto-eligible work is stuck at attempts:0 (ready work not flowing)', () => {
    expect(workFeedStatus(wf({ autoEligibleStuck: 3 }))).toBe('warn');
  });
  it('crit (dead routine) dominates auto-stuck', () => {
    expect(workFeedStatus(wf({ autoEligibleStuck: 3, deadRoutines: 1, deadRoutineNames: ['x'] }))).toBe('crit');
  });
  it('ok with a healthy feed (frontier depth alone is fine)', () => {
    expect(workFeedStatus(wf({ frontier: 500 }))).toBe('ok');
  });
  // WI-5839 / EI-18654017982759582 items 2+3: stale-paused routines.
  it('crit on a stale-paused RELEASE-CRITICAL routine (paused deploy pipeline)', () => {
    expect(
      workFeedStatus(wf({ stalePausedRoutines: 1, stalePausedRoutineNames: ['release-trigger'], stalePausedCriticalRoutines: 1 })),
    ).toBe('crit');
  });
  it('warn on a stale-paused NON-critical routine', () => {
    expect(workFeedStatus(wf({ stalePausedRoutines: 1, stalePausedRoutineNames: ['scout-cycle'] }))).toBe('warn');
  });
  it('a stale-paused critical routine dominates auto-stuck and general stale-paused', () => {
    expect(
      workFeedStatus(wf({ autoEligibleStuck: 2, stalePausedRoutines: 1, stalePausedCriticalRoutines: 1 })),
    ).toBe('crit');
  });
  it('dead routines still dominate a stale-paused critical routine', () => {
    expect(
      workFeedStatus(wf({ deadRoutines: 1, deadRoutineNames: ['x'], stalePausedRoutines: 1, stalePausedCriticalRoutines: 1 })),
    ).toBe('crit');
  });
});

describe('tokensStatus', () => {
  const tk = (o: Partial<TokensHealth> = {}): TokensHealth => ({
    gatewayEnabled: false, gatewayReachable: null, pausedBuckets: 0, totalBuckets: 4,
    fleetInFlight: 1, fleetCap: 8, spendUsd: 1, windowMs: 3_600_000,
    accountsTotal: 3, accountsAvailable: 3, accountsPaused: 0, gateway: null,
    gatewayDb: null, poolProjectionFreshestAgeMs: null, ...o,
  });
  it('crit when all accounts paused (starved)', () => {
    expect(tokensStatus(tk({ accountsAvailable: 0 }))).toBe('crit');
  });
  it('crit when gateway is in the path but unreachable', () => {
    expect(tokensStatus(tk({ gatewayEnabled: true, gatewayReachable: false }))).toBe('crit');
  });
  it('warn on a paused bucket (RPM pacing)', () => {
    expect(tokensStatus(tk({ pausedBuckets: 1 }))).toBe('warn');
  });
  it('warn on a paused account (but others available)', () => {
    expect(tokensStatus(tk({ accountsPaused: 1, accountsAvailable: 2 }))).toBe('warn');
  });
  it('does not crit on zero accounts configured (single bound credential)', () => {
    expect(tokensStatus(tk({ accountsTotal: 0, accountsAvailable: 0 }))).toBe('ok');
  });
  // ── Gateway wedge / throttle (B-GW-5) ──
  const gw = (o: Partial<NonNullable<TokensHealth['gateway']>> = {}): NonNullable<TokensHealth['gateway']> => ({
    inFlight: 3, queueDepth: 0, maxConcurrent: 24, concurrencyCap: 24, shed429: 0, shedAllThrottled: 0,
    failovers: 0, upstream429: 0, utilizationPct: 40, aimdEffective: 24, aimdCap: 24,
    wedge: false, saturated: false, sustainedThrottle: false, slotLeak: false,
    admissionStarvationRisk: false, admissionStarved: false, reasons: [], ...o,
  });
  it('crit when the gateway is WEDGED', () => {
    expect(tokensStatus(tk({ gateway: gw({ wedge: true, saturated: true }) }))).toBe('crit');
  });
  it('warn when the gateway is saturated (wedge-risk, not yet frozen)', () => {
    expect(tokensStatus(tk({ gateway: gw({ saturated: true }) }))).toBe('warn');
  });
  it('warn when the gateway is sustained-throttling', () => {
    expect(tokensStatus(tk({ gateway: gw({ sustainedThrottle: true }) }))).toBe('warn');
  });
  it('warn on a slot-leak (P-005/W3): a leaked slot the valve cannot reclaim, before it wedges', () => {
    expect(tokensStatus(tk({ gateway: gw({ slotLeak: true }) }))).toBe('warn');
  });

  // ── Gateway DB loss (EI-19303809952284205) — the detector that was missing entirely ──
  //
  // The 2026-08-01 incident: the gateway kept serving traffic and reporting ok:true on /healthz for
  // HOURS while its Postgres was unreachable, so every account usage-window write was dropped, the
  // pool could not reload (collapsing to ONE synthetic credential, healthyAccounts: 0), and the
  // owner's Accounts tab silently froze. It was found by a human noticing a stale UI panel.
  it('crit when the gateway reports its own DB is gone — the fast leg (~3min)', () => {
    expect(
      tokensStatus(tk({ gatewayDb: { ok: false, connectionLevel: true, failingOps: ['pool-reload'], unhealthyForMs: 180_000, lastError: 'ECONNREFUSED 127.0.0.1:20216' } })),
    ).toBe('crit');
  });
  it('a HEALTHY gatewayDb report does not itself change the verdict', () => {
    expect(
      tokensStatus(tk({ gatewayDb: { ok: true, connectionLevel: false, failingOps: [], unhealthyForMs: null, lastError: null } })),
    ).toBe('ok');
  });
  it('an ABSENT gatewayDb (deploy-skew / gateway too old to report) is unknown, not a fault', () => {
    // A long-lived gateway is EXACTLY the process this condition afflicts (the incident's had been
    // up 13.7 days), so null must never read as healthy — but it must not red the panel either.
    // That is precisely why the independent projection leg below exists.
    expect(tokensStatus(tk({ gatewayDb: null }))).toBe('ok');
  });
  it('crit when NO usage-window write has landed for hours despite real fleet spend — the independent leg', () => {
    expect(tokensStatus(tk({ spendUsd: 12.5, poolProjectionFreshestAgeMs: POOL_PROJECTION_STALE_CRIT_MS }))).toBe('crit');
  });
  it('warn at the earlier projection-stall floor', () => {
    expect(tokensStatus(tk({ spendUsd: 12.5, poolProjectionFreshestAgeMs: POOL_PROJECTION_STALE_WARN_MS }))).toBe('warn');
  });
  it('an IDLE box is never alarmed: no spend means there were no responses to observe', () => {
    // Alarming on a quiet box is how a detector teaches its reader to ignore it.
    expect(tokensStatus(tk({ spendUsd: 0, poolProjectionFreshestAgeMs: 24 * 60 * 60_000 }))).toBe('ok');
  });
  it('a never-observed pool is not a fault', () => {
    expect(tokensStatus(tk({ spendUsd: 12.5, poolProjectionFreshestAgeMs: null }))).toBe('ok');
  });
  it('a projection just under the warn floor stays ok', () => {
    expect(tokensStatus(tk({ spendUsd: 12.5, poolProjectionFreshestAgeMs: POOL_PROJECTION_STALE_WARN_MS - 1 }))).toBe('ok');
  });
  it('the DB-loss crit outranks the wedge crit but both are crit — order cannot silently downgrade', () => {
    expect(
      tokensStatus(tk({
        gateway: gw({ wedge: true }),
        gatewayDb: { ok: false, connectionLevel: true, failingOps: ['pool-reload'], unhealthyForMs: 600_000, lastError: 'ECONNREFUSED' },
      })),
    ).toBe('crit');
  });
  it('ok with a healthy gateway sub-panel', () => {
    expect(tokensStatus(tk({ gateway: gw() }))).toBe('ok');
  });
  // ── WI-3565: admission starvation (deep queue BELOW the ceiling, idle healthy accounts unused) ──
  it('crit when admission is confirmed-starved AND idle accounts exceed the threshold', () => {
    expect(
      tokensStatus(tk({ accountsAvailable: 5, gateway: gw({ admissionStarved: true, queueDepth: 24, maxConcurrent: 2 }) })),
    ).toBe('crit');
  });
  it('NOT crit when confirmed-starved but idle accounts are at/below the threshold (no spare capacity to use)', () => {
    expect(
      tokensStatus(tk({ accountsAvailable: 2, gateway: gw({ admissionStarved: true, queueDepth: 24, maxConcurrent: 2 }) })),
    ).not.toBe('crit');
  });
  it('warn on an unconfirmed starvation RISK (not yet sustained 5min)', () => {
    expect(tokensStatus(tk({ gateway: gw({ admissionStarvationRisk: true }) }))).toBe('warn');
  });
  it('ok when healthy', () => {
    expect(tokensStatus(tk())).toBe('ok');
  });
});

describe('watchdogStatus', () => {
  const wd = (o: Partial<WatchdogHealth> = {}): WatchdogHealth => ({
    fires24h: 0, livenessArmed: true, staleForMs: 1000, recentErrors: 0, ...o,
  });
  it('warn when firing repeatedly', () => {
    expect(watchdogStatus(wd({ fires24h: 3 }))).toBe('warn');
  });
  it('ok when quiet (the watchdog firing is never itself crit)', () => {
    expect(watchdogStatus(wd({ fires24h: 1 }))).toBe('ok');
  });
});

describe('deployStatus', () => {
  const now = 1_000_000_000_000;
  const dp = (o: Partial<DeployHealth> = {}): DeployHealth => ({
    deployedShortSha: 'abcd1234', deployedBehindStaging: 2, greenPinBehindStaging: 0,
    deployedBehindGreenPin: 2, greenPinAtStagingHead: true, deployedAtMs: now - 1000,
    lastCommitAtMs: now - 60_000, errors: [],
    gitSyncStatus: 'synced', gitSyncConsecutiveErrorTicks: 0,
    gitSyncPushBacklog: null, gitSyncLastSyncedAtMs: now - 60_000, gitSyncOversizedCount: 0,
    gitSyncWorstInstallSlug: null, gitSyncFailingLeg: null,
    // Healthy default: bg-host (re)started AFTER the deploy, so it is running the
    // deployed code. Keeps every pre-existing case below exercising its own signal.
    bgHostStartedAtMs: now - 500, bgHostCodeStale: false, ...o,
  });
  it('unknown when no refs resolved (a box without the release checkout)', () => {
    expect(deployStatus(dp({ deployedShortSha: null, lastCommitAtMs: null }), now)).toBe('unknown');
  });
  it('warn when git-sync has lagged past the threshold', () => {
    expect(deployStatus(dp({ lastCommitAtMs: now - SYNC_LAG_WARN_MS - 1 }), now)).toBe('warn');
  });
  it('warn when the live host is far behind staging', () => {
    expect(deployStatus(dp({ deployedBehindStaging: DEPLOY_BEHIND_WARN + 1 }), now)).toBe('warn');
  });
  it('ok when fresh + caught up', () => {
    expect(deployStatus(dp(), now)).toBe('ok');
  });
  // EI-18 git-sync UPSTREAM-delivery signal (F3/P-032): a failing push is the deploy
  // panel's ONLY crit path — local commits silently not reaching origin.
  it('crit when git-sync push has failed >= the escalation threshold (commits not reaching origin)', () => {
    expect(deployStatus(dp({ gitSyncStatus: 'error', gitSyncConsecutiveErrorTicks: GIT_SYNC_PUSH_FAIL_CRIT }), now)).toBe('crit');
  });
  it('warns, not crit, when a live git check proves the push-failure counter is stale', () => {
    expect(deployStatus(dp({ gitSyncStatus: 'error', gitSyncConsecutiveErrorTicks: GIT_SYNC_PUSH_FAIL_CRIT + 20, gitSyncPushBacklog: 0 }), now)).toBe('warn');
  });
  it('keeps crit when the live git check still sees commits waiting to reach origin', () => {
    expect(deployStatus(dp({ gitSyncStatus: 'error', gitSyncConsecutiveErrorTicks: GIT_SYNC_PUSH_FAIL_CRIT, gitSyncPushBacklog: 2 }), now)).toBe('crit');
  });
  it('crit on push-failure even with no release refs (push-fail outranks unknown)', () => {
    expect(deployStatus(dp({ deployedShortSha: null, lastCommitAtMs: null, gitSyncStatus: 'error', gitSyncConsecutiveErrorTicks: GIT_SYNC_PUSH_FAIL_CRIT + 2 }), now)).toBe('crit');
  });

  // WI-1258129 RUNNING-CODE freshness. Every other case in this describe keys on a
  // GIT position; these key on whether the long-lived process is actually executing
  // the deployed code. The motivating incident: bg-host ran 175-minute-stale code
  // with every ref healthy and this panel reading 'ok', so a reconciler whose every
  // write was reverted looked identical to one that worked.
  it('warn when bg-host still runs PRE-DEPLOY code past the grace window', () => {
    expect(deployStatus(dp({
      deployedAtMs: now - BG_HOST_STALE_CODE_GRACE_MS - 1,
      bgHostStartedAtMs: now - BG_HOST_STALE_CODE_GRACE_MS - 60_000,
      bgHostCodeStale: true,
    }), now)).toBe('warn');
  });
  it('stays ok inside the grace window (a restart still in flight is not a fault)', () => {
    expect(deployStatus(dp({
      deployedAtMs: now - 1000,
      bgHostStartedAtMs: now - 60_000,
      bgHostCodeStale: true,
    }), now)).toBe('ok');
  });
  // The false-all-clear guard. `null` means the host was UNREADABLE, not fresh — and
  // a truthiness test (`if (d.bgHostCodeStale)`) would pass this case by accident,
  // so this asserts the distinction that keeps `null` from ever reading as proof.
  it('does not warn when host freshness is UNKNOWN (null is not-proven, not stale)', () => {
    expect(deployStatus(dp({
      deployedAtMs: now - BG_HOST_STALE_CODE_GRACE_MS - 1,
      bgHostStartedAtMs: null,
      bgHostCodeStale: null,
    }), now)).toBe('ok');
  });
  it('ok once bg-host has restarted onto the deployed code', () => {
    expect(deployStatus(dp({
      deployedAtMs: now - BG_HOST_STALE_CODE_GRACE_MS - 1,
      bgHostStartedAtMs: now - 1000,
      bgHostCodeStale: false,
    }), now)).toBe('ok');
  });

  // ── Falsifiability control (repo rule: a module you import gets a permanent
  // in-test control, never an in-tree mutation). `preFix` is deployStatus's body
  // as it stood BEFORE the running-code clause. Without it these assertions would
  // pass just as happily against a deployStatus that ignores bgHostCodeStale
  // entirely — which is the only way to know the tests above test anything.
  const preFix = (d: DeployHealth, at: number): PanelStatus => {
    if (d.gitSyncConsecutiveErrorTicks >= GIT_SYNC_PUSH_FAIL_CRIT && d.gitSyncPushBacklog !== 0) return 'crit';
    if (d.deployedShortSha === null && d.lastCommitAtMs === null) return 'unknown';
    if (d.gitSyncStatus === 'error' || d.gitSyncStatus === 'degraded' || d.gitSyncOversizedCount > 0) return 'warn';
    if (d.lastCommitAtMs !== null && at - d.lastCommitAtMs > SYNC_LAG_WARN_MS) return 'warn';
    if (d.deployedBehindStaging !== null && d.deployedBehindStaging > DEPLOY_BEHIND_WARN) return 'warn';
    return 'ok';
  };
  const staleHostCase = () => dp({
    deployedAtMs: now - BG_HOST_STALE_CODE_GRACE_MS - 1,
    bgHostStartedAtMs: now - BG_HOST_STALE_CODE_GRACE_MS - 60_000,
    bgHostCodeStale: true,
  });
  // CALIBRATION — the control must agree with the real function everywhere the
  // clause does not apply. If this drifts, `preFix` has stopped being a faithful
  // pre-change implementation and the divergence assertion below proves nothing.
  it('control calibration: preFix matches deployStatus on the pre-existing signals', () => {
    for (const c of [dp(), dp({ lastCommitAtMs: now - SYNC_LAG_WARN_MS - 1 }),
      dp({ deployedBehindStaging: DEPLOY_BEHIND_WARN + 1 }),
      dp({ deployedShortSha: null, lastCommitAtMs: null }),
      dp({ gitSyncStatus: 'error', gitSyncConsecutiveErrorTicks: GIT_SYNC_PUSH_FAIL_CRIT })]) {
      expect(preFix(c, now)).toBe(deployStatus(c, now));
    }
  });
  it('control divergence: the stale-host case is EXACTLY what the new clause adds', () => {
    expect(preFix(staleHostCase(), now)).toBe('ok');
    expect(deployStatus(staleHostCase(), now)).toBe('warn');
  });
  it('warn (not crit) on a single git-sync error tick below the threshold', () => {
    expect(deployStatus(dp({ gitSyncStatus: 'error', gitSyncConsecutiveErrorTicks: 1 }), now)).toBe('warn');
  });
  it('warns when the read-time freshness verdict degrades a raw synced outcome', () => {
    expect(deployStatus(dp({ gitSyncStatus: 'degraded' }), now)).toBe('warn');
  });
  it('warns when git-sync committed a partial result with content-quarantined files', () => {
    expect(deployStatus(dp({ gitSyncStatus: 'quarantined' }), now)).toBe('warn');
  });
  it('warn when git-sync excluded an oversized blob (it will never push)', () => {
    expect(deployStatus(dp({ gitSyncOversizedCount: 1 }), now)).toBe('warn');
  });
});

describe('plansStatus', () => {
  const pl = (o: Partial<PlansHealth> = {}): PlansHealth => ({
    active: 2, started: 1, shipped: 5, draft: 1, itemsDone: 3, itemsTotal: 8, stalledPlans: 0, startedDraft: 0, ...o,
  });
  it('warn on a stalled started plan', () => {
    expect(plansStatus(pl({ stalledPlans: 1 }))).toBe('warn');
  });
  it('ok otherwise', () => {
    expect(plansStatus(pl())).toBe('ok');
  });
});

describe('escalationsStatus — keys on NEW aging, not standing backlog (health-tab-v2 P-003)', () => {
  const es = (o: Partial<EscalationsHealth> = {}): EscalationsHealth => ({
    open: 0, oldestAgeMs: null, bySeverity: {}, aging: 0, agingNew: 0, ...o,
  });
  it('warn on an open blocker', () => {
    expect(escalationsStatus(es({ open: 1, bySeverity: { blocker: 1 } }))).toBe('warn');
  });
  it('warn on a NEWLY-aging escalation (crossed the threshold in the last 24h)', () => {
    expect(escalationsStatus(es({ open: 1, aging: 1, agingNew: 1, bySeverity: { warning: 1 } }))).toBe('warn');
  });
  it('STANDING aging alone does NOT warn — a month-old backlog is a muted metric, not a fresh alarm (P-003)', () => {
    expect(escalationsStatus(es({ open: 3, aging: 3, agingNew: 0, bySeverity: { warning: 3 } }))).toBe('ok');
  });
  it('ok when no open escalations', () => {
    expect(escalationsStatus(es())).toBe('ok');
  });
  it('ok on a fresh non-blocker escalation', () => {
    expect(escalationsStatus(es({ open: 1, bySeverity: { info: 1 } }))).toBe('ok');
  });
});

describe('autonomyStatus', () => {
  const au = (o: Partial<AutonomyHealth> = {}): AutonomyHealth => ({
    categories: 13, locked: 13, byCeiling: { 'never-auto': 13 },
    tripwiresArmed: 0, tripwiresTripped: 0, tripwiresReverted: 0, ...o,
  });
  it('warn on a tripped tripwire', () => {
    expect(autonomyStatus(au({ tripwiresTripped: 1 }))).toBe('warn');
  });
  it('ok when only armed (locked categories are intentional config)', () => {
    expect(autonomyStatus(au({ tripwiresArmed: 4 }))).toBe('ok');
  });
});

describe('overwatchStatus — the who-watches-the-watcher panel (#15, D-004)', () => {
  const ow = (o: Partial<OverwatchPanelHealth> = {}): OverwatchPanelHealth => ({
    flagEnabled: true, started: true, alive: true, armed: true, cadenceSec: 600,
    lastWakeAt: 0, nextFireAt: 0, staleForMs: 60_000, watchdogFires24h: 0,
    scorecardEmission: null, scorecardSkipped: false, ...o,
  });
  it('unknown (greyed) when the flag is off — the intended default-off state, NOT a failure', () => {
    expect(overwatchStatus(ow({ flagEnabled: false, started: false }))).toBe('unknown');
  });
  it('unknown when pre-armed (flag off but started bit set, awaiting B-12)', () => {
    expect(overwatchStatus(ow({ flagEnabled: false, started: true }))).toBe('unknown');
  });
  it('unknown when proven-but-paused by the owner (flag on, not started)', () => {
    expect(overwatchStatus(ow({ started: false }))).toBe('unknown');
  });
  it('crit when live but DARK — the supervisor loop itself died (the D-004 failure)', () => {
    expect(overwatchStatus(ow({ alive: false }))).toBe('crit');
  });
  it('warn when the overwatch watchdog has fired repeatedly (forgot-to-declare bug)', () => {
    expect(overwatchStatus(ow({ watchdogFires24h: 3 }))).toBe('warn');
  });
  it('ok when live + looping (flag on, started, alive, quiet watchdog)', () => {
    expect(overwatchStatus(ow())).toBe('ok');
  });
  it('alive=null (uncomputable) is NOT crit — a started loop with unknown liveness stays ok', () => {
    expect(overwatchStatus(ow({ alive: null }))).toBe('ok');
  });
});

describe('worstStatus — the fail-soft roll-up', () => {
  it('crit dominates', () => {
    expect(worstStatus(['ok', 'warn', 'crit', 'unknown'])).toBe('crit');
  });
  it('warn over ok', () => {
    expect(worstStatus(['ok', 'warn', 'unknown'])).toBe('warn');
  });
  it('unknown NEVER reds the system — ok wins over a greyed panel', () => {
    expect(worstStatus(['ok', 'unknown', 'unknown'])).toBe('ok');
  });
  it('all-unknown rolls up to unknown', () => {
    expect(worstStatus(['unknown', 'unknown'])).toBe('unknown');
  });
  it('empty rolls up to unknown', () => {
    expect(worstStatus([])).toBe('unknown');
  });
});

const mcpProxy = (o: Partial<McpProxyHealth> = {}): McpProxyHealth => ({
  windowMs: 60 * 60_000, total: 0, hardFailures: 0, softBeatFailures: 0, recovered: 0, otherNon2xx: 0, benign: 0, nonInstance: 0, handshakeStalls: 0, shed: 0, criticalContinuationQueueStalls: 0, criticalContinuationQueueMaxWaitMs: 0, byKind: {}, newestAt: null, ...o,
});
const infra = (o: Partial<InfraHealth> = {}): InfraHealth => ({
  pg: { version: '16', total: 10, active: 2, idle: 8, postmasterStartMs: null }, gatewayReachable: true, perf: null, mcpProxy: null, ...o,
});

const hostPressureSample = (o: Partial<HostPressureSample> = {}): HostPressureSample => ({
  sampledAtMs: 10_000,
  effectiveCores: 128,
  cpuPsiSomePct: 0,
  memoryPsiSomePct: 0,
  memoryPsiFullPct: 0,
  runnableCount: 0,
  blockedCount: 0,
  ...o,
});

describe('evaluateHostPressure — fresh resource-governor host evidence', () => {
  it('reports healthy pressure only when every required reading is fresh and valid', () => {
    const health = evaluateHostPressure(hostPressureSample(), 20_000);

    expect(health.status).toBe('ok');
    expect(health.ageMs).toBe(10_000);
    expect(health.runnablePerCore).toBe(0);
    expect(health.blockedPerCore).toBe(0);
    expect(health.unknown).toEqual([]);
    expect(health.summary).toContain('host pressure normal');
  });

  it('normalizes scheduler counts by effective cores instead of absolute host size', () => {
    const small = evaluateHostPressure(hostPressureSample({ effectiveCores: 2, runnableCount: 3 }), 20_000);
    const large = evaluateHostPressure(hostPressureSample({ effectiveCores: 128, runnableCount: 192 }), 20_000);

    expect(small.runnablePerCore).toBe(1.5);
    expect(large.runnablePerCore).toBe(1.5);
    expect(small.status).toBe('warn');
    expect(large.status).toBe('warn');
    expect(small.summary).toContain(`${HOST_PRESSURE_RUNNABLE_WARN_PER_CORE}`);
  });

  it('reports crit for measured CPU, memory, and scheduler pressure', () => {
    const health = evaluateHostPressure(
      hostPressureSample({
        cpuPsiSomePct: 90,
        memoryPsiFullPct: HOST_PRESSURE_MEMORY_PSI_FULL_CRIT_PCT,
        runnableCount: 384,
        blockedCount: 128,
      }),
      20_000,
    );

    expect(health.status).toBe('crit');
    expect(health.reasons).toHaveLength(4);
    expect(health.summary).toContain('HOST PRESSURE:');
    expect(health.summary).toContain('CPU PSI some');
    expect(health.summary).toContain('memory PSI full');
    expect(health.summary).toContain('scheduler runnable');
    expect(health.summary).toContain('scheduler blocked');
  });

  it('never thresholds stale or future snapshots, even when their values are severe', () => {
    const stale = evaluateHostPressure(
      hostPressureSample({ sampledAtMs: 10_000, cpuPsiSomePct: 99, runnableCount: 999 }),
      10_000 + HOST_PRESSURE_MAX_AGE_MS + 1,
    );
    const future = evaluateHostPressure(hostPressureSample({ sampledAtMs: 30_000, cpuPsiSomePct: 99 }), 20_000);

    expect(stale.status).toBe('unknown');
    expect(stale.reasons).toEqual([]);
    expect(stale.unknown[0]).toContain('beyond');
    expect(future.status).toBe('unknown');
    expect(future.reasons).toEqual([]);
    expect(future.unknown).toContain('live-health snapshot is from the future');
  });

  it('keeps missing/invalid readings explicit instead of fabricating a healthy zero', () => {
    const missing = evaluateHostPressure(hostPressureSample({ memoryPsiFullPct: null }), 20_000);
    const invalid = evaluateHostPressure(hostPressureSample({ blockedCount: -1 }), 20_000);

    expect(missing.status).toBe('unknown');
    expect(missing.unknown).toContain('memory.psiFullPct is unavailable');
    expect(invalid.status).toBe('unknown');
    expect(invalid.unknown).toContain('scheduler.blockedCount is invalid');
  });

  it('preserves a measured warning when another corroborating leg is unavailable', () => {
    const health = evaluateHostPressure(
      hostPressureSample({ cpuPsiSomePct: HOST_PRESSURE_CPU_PSI_WARN_PCT, memoryPsiFullPct: null }),
      20_000,
    );

    expect(health.status).toBe('warn');
    expect(health.reasons).toHaveLength(1);
    expect(health.unknown).toContain('memory.psiFullPct is unavailable');
  });
});

describe('infraStatus — PG + gateway + perf + MCP-proxy SLO (W8/P-008)', () => {
  it('surfaces a witnessed hosted failure with its responder independently of PostHog and PG', () => {
    const hostedControlPlane: NonNullable<InfraHealth['hostedControlPlane']> = {
      observedAt: 1_000_000, windowMs: 3_600_000, lifecycle: null, api: null,
      hosts: { expectedRunning: 2, unhealthy: 1, unobserved: 0, platformOwnedRunning: 1 },
      providerConnections: { connected: 1, degraded: 0 },
    };
    const failed = infra({ pg: null, hostedControlPlane });
    expect(infraStatus(failed)).toBe('crit');
    expect(infraSummary(failed, false)).toContain('Responder: workspace-host controller');
    expect(infraStatus(infra({ hostedControlPlane: { ...hostedControlPlane,
      hosts: { ...hostedControlPlane.hosts!, unhealthy: 0 },
    } }))).toBe('ok');
  });
  it('ok when PG healthy, gateway up, no perf/mcp signal', () => {
    expect(infraStatus(infra())).toBe('ok');
  });
  it('unknown when PG is unreadable (greyed leg) and nothing else reds it', () => {
    expect(infraStatus(infra({ pg: null }))).toBe('unknown');
  });
  it('crit when the gateway is enabled-but-unreachable (spine down)', () => {
    expect(infraStatus(infra({ gatewayReachable: false }))).toBe('crit');
  });
  it('crit on a per-thread perf WEDGE (operator_degraded)', () => {
    // A minimal PerfVerdict-shaped object — only `status` is read by infraStatus.
    expect(infraStatus(infra({ perf: { status: 'crit' } as InfraHealth['perf'] }))).toBe('crit');
  });
  it('crit on a measured host-pressure incident, even when PG is unreadable', () => {
    const hostPressure = evaluateHostPressure(hostPressureSample({ cpuPsiSomePct: 90 }), 20_000);
    expect(infraStatus(infra({ pg: null, hostPressure }))).toBe('crit');
  });

  // ── MCP tool-call transport SLO (W8/P-008) ──────────────────────────────────
  it('ok when the MCP proxy reports zero hard failures (healthy transport)', () => {
    expect(infraStatus(infra({ mcpProxy: mcpProxy({ hardFailures: 0, recovered: 5 }) }))).toBe('ok');
  });
  it('warn on ANY MCP-proxy hard failure — ends the "transient is normal" culture (visible, sub-page)', () => {
    expect(infraStatus(infra({ mcpProxy: mcpProxy({ hardFailures: 1, total: 1 }) }))).toBe('warn');
  });
  it('warns and names valid MCP admission sheds without treating one as a page', () => {
    const shed = infra({ mcpProxy: mcpProxy({
      shed: 2,
      byKind: { shed_max_in_flight: 1, shed_ordinary_queue_full: 1 },
    }) });
    expect(infraStatus(shed)).toBe('warn');
    expect(infraSummary(shed, false)).toContain(
      'MCP PROXY ADMISSION SHEDDING: 2 valid agent request(s) refused before forwarding/1h (max-in-flight=1, ordinary-queue-full=1)',
    );
    expect(infraMcpProxyMetric(shed.mcpProxy)).toEqual({ value: '2 shed/1h', tone: 'warn' });
  });
  it('keeps admission sheds visible when PG is unreadable and below critical severity at high counts', () => {
    const shed = infra({ pg: null, mcpProxy: mcpProxy({ shed: 99 }) });
    expect(infraStatus(shed)).toBe('warn');
    expect(infraSummary(shed, false)).toContain('PG unreadable; MCP PROXY ADMISSION SHEDDING: 99');
    expect(infraMcpProxyMetric(shed.mcpProxy)).toEqual({ value: '99 shed/1h', tone: 'warn' });
  });
  it('keeps all independently actionable MCP counts in the Infra metric', () => {
    expect(infraMcpProxyMetric(mcpProxy({
      hardFailures: 1,
      shed: 2,
      criticalContinuationQueueStalls: 1,
      criticalContinuationQueueMaxWaitMs: 600_000,
    }))).toEqual({
      value: '1 critical continuation wait(s) ≥5m observed in the last hour (max 600s), 1 fail/1h, 2 shed/1h',
      tone: 'crit',
    });
  });
  it('crit at/above MCP_PROXY_HARD_FAIL_CRIT hard failures — a regression that pages', () => {
    expect(infraStatus(infra({ mcpProxy: mcpProxy({ hardFailures: MCP_PROXY_HARD_FAIL_CRIT }) }))).toBe('crit');
  });
  it('crits on a sustained critical-continuation wait, while sub-five-minute queueing stays quiet', () => {
    expect(MCP_PROXY_CRITICAL_CONTINUATION_WAIT_CRIT_MS).toBe(5 * 60_000);
    expect(infraStatus(infra({ mcpProxy: mcpProxy({ criticalContinuationQueueMaxWaitMs: 61_800 }) }))).toBe('ok');
    const stalled = infra({ mcpProxy: mcpProxy({ criticalContinuationQueueStalls: 1, criticalContinuationQueueMaxWaitMs: 701_000 }) });
    expect(infraStatus(stalled)).toBe('crit');
    expect(infraSummary(stalled, true)).toContain('MCP PROXY CRITICAL CONTINUATION QUEUE WAIT');
    expect(infraSummary(stalled, true)).toContain('in the last hour');
    expect(infraStatus(infra({ pg: null, mcpProxy: mcpProxy({ criticalContinuationQueueStalls: 1, criticalContinuationQueueMaxWaitMs: 701_000 }) }))).toBe('crit');
  });
  it('a crit MCP-proxy SLO breach OUTRANKS a greyed (null) PG leg — a real failure beats unknown', () => {
    expect(infraStatus(infra({ pg: null, mcpProxy: mcpProxy({ hardFailures: MCP_PROXY_HARD_FAIL_CRIT }) }))).toBe('crit');
  });

  // ── tool HANDLER failure rate (EI-18798264517111160) ────────────────────────
  // The gap this closes: the transport was fine and PG was fine for the whole
  // 2026-07-27 facts:assert outage. Only the tool's own handler was failing.
  const tf = (o: Partial<NonNullable<InfraHealth['toolFailures']>> = {}): InfraHealth['toolFailures'] => ({
    rating: 'healthy', evidence: '', brokenTools: [], windowMin: 15, worstPct: null, totalCalls: 100, ...o,
  });
  it('ok when tools are healthy', () => {
    expect(infraStatus(infra({ toolFailures: tf() }))).toBe('ok');
  });
  it('crit when a tool handler is failing fleet-wide — the signal that was missing for ~3h', () => {
    expect(
      infraStatus(infra({ toolFailures: tf({ rating: 'broken', brokenTools: ['facts:assert'], worstPct: 100 }) })),
    ).toBe('crit');
  });
  it('warn on a partial/ramping handler failure (visible, sub-page)', () => {
    expect(infraStatus(infra({ toolFailures: tf({ rating: 'degraded', worstPct: 40 }) }))).toBe('warn');
  });
  it('a broken tool OUTRANKS a greyed PG leg — an unreadable PG tick must not mask a write-path outage', () => {
    expect(
      infraStatus(infra({ pg: null, toolFailures: tf({ rating: 'broken', brokenTools: ['facts:assert'] }) })),
    ).toBe('crit');
  });
  it("a quiet window ('unknown') never reds or yellows the panel — no traffic is not a fault", () => {
    expect(infraStatus(infra({ toolFailures: tf({ rating: 'unknown', totalCalls: 0 }) }))).toBe('ok');
  });
  it('an absent leg (older projection / unreadable) contributes nothing — fail-soft', () => {
    expect(infraStatus(infra({ toolFailures: null }))).toBe('ok');
    expect(infraStatus(infra({ toolFailures: undefined }))).toBe('ok');
  });
  it('a null mcpProxy leg (ledger unreadable) contributes nothing — fail-soft', () => {
    expect(infraStatus(infra({ mcpProxy: null }))).toBe('ok');
  });
  it('a perf crit still dominates an MCP-proxy warn', () => {
    expect(infraStatus(infra({ perf: { status: 'crit' } as InfraHealth['perf'], mcpProxy: mcpProxy({ hardFailures: 1 }) }))).toBe('crit');
  });
  it('a critical PG-pool band warns — the routinesTick freeze mode (P-006/W4)', () => {
    expect(infraStatus(infra({ pool: { probeMs: 5000, band: 'critical' } }))).toBe('warn');
  });
  it('an elevated / ok / absent PG-pool band does not raise infra on its own (P-006/W4)', () => {
    expect(infraStatus(infra({ pool: { probeMs: 1800, band: 'elevated' } }))).toBe('ok');
    expect(infraStatus(infra({ pool: { probeMs: 40, band: 'ok' } }))).toBe('ok');
    expect(infraStatus(infra({ pool: undefined }))).toBe('ok'); // deploy-skew: field absent
  });
  it('a perf crit still dominates a PG-pool warn', () => {
    expect(infraStatus(infra({ perf: { status: 'crit' } as InfraHealth['perf'], pool: { probeMs: 5000, band: 'critical' } }))).toBe('crit');
  });
});

describe('infraCritAmbientOnly — EI-21025158485847408 (ambient-host infra crit vs a genuine operator defect)', () => {
  const ambientPerf = {
    status: 'crit',
    critAttribution: { operatorDefect: [], ambientHost: ['PSI memory full avg60 10.13 ≥ 5 — all tasks stalled on memory reclaim/swap'] },
  } as unknown as InfraHealth['perf'];
  const mixedPerf = {
    status: 'crit',
    critAttribution: {
      operatorDefect: ['event-loop lag p95 1200ms ≥ 1000ms'],
      ambientHost: ['PSI memory full avg60 10.13 ≥ 5 — all tasks stalled on memory reclaim/swap'],
    },
  } as unknown as InfraHealth['perf'];

  it('true when perf crit is caused ONLY by ambient-host attribution and no other leg is crit', () => {
    expect(infraCritAmbientOnly(infra({ perf: ambientPerf }))).toBe(true);
  });
  it('does not downgrade a witnessed hosted fault when ambient host pressure is also present', () => {
    expect(infraCritAmbientOnly(infra({ perf: ambientPerf, hostedControlPlane: {
      observedAt: 1_000_000, windowMs: 3_600_000, lifecycle: null, hosts: null, api: null,
      providerConnections: { connected: 0, degraded: 1 },
    } }))).toBe(false);
  });
  it('false when perf is not crit at all', () => {
    expect(infraCritAmbientOnly(infra({ perf: null }))).toBe(false);
    expect(infraCritAmbientOnly(infra({ perf: { status: 'warn' } as InfraHealth['perf'] }))).toBe(false);
  });
  it('false when the perf crit carries an operator-defect leg too', () => {
    expect(infraCritAmbientOnly(infra({ perf: mixedPerf }))).toBe(false);
  });
  it('FAIL-SAFE: false when critAttribution is entirely absent (older projection / hand-built fixture)', () => {
    expect(infraCritAmbientOnly(infra({ perf: { status: 'crit' } as InfraHealth['perf'] }))).toBe(false);
  });
  it('false when a broken tool handler is ALSO crit, even with an ambient-only perf reason', () => {
    expect(
      infraCritAmbientOnly(
        infra({
          perf: ambientPerf,
          toolFailures: { rating: 'broken', evidence: 'facts:assert 100% (500)', brokenTools: ['facts:assert'], windowMin: 15, worstPct: 100, totalCalls: 20 },
        }),
      ),
    ).toBe(false);
  });
  it('false when an MCP-proxy hard-failure SLO breach is ALSO crit', () => {
    expect(
      infraCritAmbientOnly(infra({ perf: ambientPerf, mcpProxy: mcpProxy({ hardFailures: MCP_PROXY_HARD_FAIL_CRIT }) })),
    ).toBe(false);
  });
  it('false when a critical continuation queue stall is ALSO crit, even with an ambient-only perf reason', () => {
    expect(
      infraCritAmbientOnly(infra({ perf: ambientPerf, mcpProxy: mcpProxy({ criticalContinuationQueueStalls: 1 }) })),
    ).toBe(false);
  });
  it('false when disk is ALSO crit', () => {
    expect(
      infraCritAmbientOnly(infra({ perf: ambientPerf, disk: [{ path: '/', usedPct: DISK_USED_CRIT_PCT }] })),
    ).toBe(false);
  });
  it('false when the gateway is ALSO down (PG readable)', () => {
    expect(infraCritAmbientOnly(infra({ perf: ambientPerf, gatewayReachable: false }))).toBe(false);
  });
  it('true even when PG is unreadable — the gatewayReachable leg only applies when PG is readable', () => {
    expect(infraCritAmbientOnly(infra({ perf: ambientPerf, pg: null, gatewayReachable: false }))).toBe(true);
  });
});

describe('infraSummary — every crit must NAME its cause (the escalation body)', () => {
  const critDisk = [{ path: '/home/agent/.papercusp', usedPct: 96 }];
  /** "Named nothing" = the healthy-looking PG connection line, verbatim. */
  const BARE_PG_LINE = /^PG \d+ active \/ \d+ conns, gateway up$/;

  // ── the defect this pair of functions was split apart to prevent ────────────
  it('names DISK on a disk-pressure crit — it used to render as a healthy PG line', () => {
    const d = infra({ disk: critDisk });
    expect(infraStatus(d)).toBe('crit');
    const s = infraSummary(d, true);
    expect(s).toContain('DISK 96%');
    expect(s).toContain('/home/agent/.papercusp');
    // The regression: the crit fell through to the PG branch, so the page a human
    // got named PG + gateway (both healthy) and never mentioned disk at all.
    expect(s).not.toContain('PG 2 active');
    expect(s).not.toContain('gateway up');
  });

  it('CONTROL: the SAME shape one point below the threshold keeps the PG line — the disk branch is gated, not always-on', () => {
    const d = infra({ disk: [{ path: '/home/agent/.papercusp', usedPct: 94 }] });
    expect(infraStatus(d)).toBe('warn'); // >= DISK_USED_WARN_PCT, < DISK_USED_CRIT_PCT
    const s = infraSummary(d, true);
    expect(s).not.toContain('DISK 94%');
    expect(s).toContain('PG 2 active');
    // ...but the leading indicator still reaches the reader, inline.
    expect(s).toContain(', disk 94%');
  });

  it('reports the WORST volume, not the first one collected', () => {
    const d = infra({ disk: [{ path: '/small', usedPct: 12 }, { path: '/full', usedPct: 97 }] });
    expect(infraSummary(d, true)).toContain('DISK 97% used on /full');
  });

  it('names host PSI memory separately from an operator per-thread wedge while preserving precedence', () => {
    const d = infra({ perf: { status: 'crit', reasons: ['PSI memory full avg60 13.29 ≥ 5'] } as InfraHealth['perf'], disk: critDisk });
    const s = infraSummary(d, true);
    expect(s).toContain('HOST MEMORY PRESSURE: PSI memory full');
    expect(s).not.toContain('PER-THREAD WEDGE');
    expect(s).not.toContain('DISK 96%');
  });

  it.each([
    'event-loop lag p95 900ms ≥ 750ms',
    ':3070 CLOSE_WAIT 80 ≥ 64 (event-loop peg)',
  ])('keeps operator-local perf crits classified as PER-THREAD WEDGE: %s', (reason) => {
    const s = infraSummary(infra({ perf: { status: 'crit', reasons: [reason] } as InfraHealth['perf'] }), true);
    expect(s).toBe(`PER-THREAD WEDGE: ${reason}`);
  });

  it('a healthy box still renders the PG line, with no disk note at all', () => {
    const s = infraSummary(infra({ disk: [{ path: '/', usedPct: 40 }] }), true);
    expect(s).toBe('PG 2 active / 10 conns, gateway up');
  });

  /**
   * The CLASS guard. `infraStatus` gained a crit branch (disk) that this summary
   * chain never got, and the mismatch was invisible for as long as nobody read an
   * escalation body next to the predicate. This walks every crit-producing shape
   * and asserts the summary names something actionable — so the next crit branch
   * added to `infraStatus` without a summary branch fails HERE, not in a page.
   */
  it('infra-summary-names-every-crit: no crit renders the generic PG line', () => {
    const critShapes: Array<[string, InfraHealth]> = [
      ['toolFailures broken', infra({ toolFailures: { rating: 'broken', evidence: 'facts:assert 100% fail' } as InfraHealth['toolFailures'] })],
      ['mcp proxy breach', infra({ mcpProxy: mcpProxy({ hardFailures: MCP_PROXY_HARD_FAIL_CRIT }) })],
      ['mcp critical continuation queue stall', infra({ mcpProxy: mcpProxy({ criticalContinuationQueueStalls: 1, criticalContinuationQueueMaxWaitMs: 701_000 }) })],
      ['perf wedge', infra({ perf: { status: 'crit', reasons: ['operator degraded'] } as InfraHealth['perf'] })],
      ['host pressure', infra({ hostPressure: evaluateHostPressure(hostPressureSample({ cpuPsiSomePct: 90 }), 20_000) })],
      ['disk pressure', infra({ disk: critDisk })],
      ['gateway down', infra({ gatewayReachable: false })],
    ];
    for (const [label, d] of critShapes) {
      expect(infraStatus(d), `${label} should be crit`).toBe('crit');
      const s = infraSummary(d, true);
      // "Names its cause" = it is not merely the healthy-looking PG connection line.
      // `gateway down` satisfies this by appending to that line, which is why the
      // assertion is on the RENDERED cause and not on the branch taken.
      const isBarePgLine = BARE_PG_LINE.test(s);
      expect(isBarePgLine, `${label} rendered an unnamed summary: ${s}`).toBe(false);
    }
  });

  /**
   * CONTROL — proves the guard above can FAIL, without mutating the shared tree
   * (the repo's tier-1 falsifiability pattern: keep the deliberately-wrong
   * implementation here, permanently, instead of racing git-sync with a probe).
   * `legacySummary` is the chain exactly as it shipped before the disk branch
   * existed. A guard that has never failed is a guard nobody has tested.
   */
  it('CONTROL: the guard FAILS against the pre-fix chain (disk branch removed)', () => {
    const legacySummary = (d: InfraHealth): string => {
      if (d.toolFailures?.rating === 'broken') return `TOOL FAILING FLEET-WIDE: ${d.toolFailures.evidence}`;
      const mcpHard = d.mcpProxy?.hardFailures ?? 0;
      if (mcpHard >= MCP_PROXY_HARD_FAIL_CRIT) return `MCP PROXY FAILING: ${mcpHard} hard tool-call failure(s)/1h`;
      if (d.perf?.status === 'crit') return `PER-THREAD WEDGE: ${d.perf.reasons[0] ?? 'operator degraded'}`;
      if (!d.pg) return 'PG unreadable';
      return `PG ${d.pg.active} active / ${d.pg.total} conns, gateway ${d.gatewayReachable ? 'up' : 'down'}`;
    };
    const diskCritShape = infra({ disk: critDisk });
    expect(infraStatus(diskCritShape)).toBe('crit');
    // The exact production symptom, reproduced: a disk crit rendering as a line
    // that names PG and the gateway — both healthy — and never mentions disk.
    expect(legacySummary(diskCritShape)).toBe('PG 2 active / 10 conns, gateway up');
    expect(BARE_PG_LINE.test(legacySummary(diskCritShape))).toBe(true); // guard would fire
    // ...and it is specifically the disk leg that regressed — the other crits
    // were always named, so a blunter guard would have passed the buggy chain.
    for (const d of [
      infra({ perf: { status: 'crit', reasons: ['x'] } as InfraHealth['perf'] }),
      infra({ mcpProxy: mcpProxy({ hardFailures: MCP_PROXY_HARD_FAIL_CRIT }) }),
    ]) {
      expect(BARE_PG_LINE.test(legacySummary(d))).toBe(false);
    }
  });
});

describe('threshold constants are sane', () => {
  it('Queen stall is 30 minutes (the failure mode the tab exists for)', () => {
    expect(QUEEN_STALL_MS).toBe(30 * 60_000);
  });
  it('MCP-proxy hard-fail crit threshold is a positive integer (the SLO page line)', () => {
    expect(MCP_PROXY_HARD_FAIL_CRIT).toBeGreaterThan(0);
    expect(Number.isInteger(MCP_PROXY_HARD_FAIL_CRIT)).toBe(true);
  });
  it('disk warn is below disk crit (health-tab-v2 P-011)', () => {
    expect(DISK_USED_WARN_PCT).toBeLessThan(DISK_USED_CRIT_PCT);
  });
  it('backup staleness threshold is 48h (cadence is ~hours)', () => {
    expect(BACKUP_STALE_MS).toBe(48 * 60 * 60_000);
  });
});

// ── health-tab-v2 (2026-07-12) additions ─────────────────────────────────────

describe('infraStatus — disk / migration-drift / backup legs (health-tab-v2 P-011)', () => {
  it('crit at >=95% used on any watched volume — writes are about to fail', () => {
    expect(infraStatus(infra({ disk: [{ path: '/', usedPct: 96 }, { path: '/data', usedPct: 40 }] }))).toBe('crit');
  });
  it('disk crit outranks a greyed PG leg (like the MCP-proxy SLO)', () => {
    expect(infraStatus(infra({ pg: null, disk: [{ path: '/', usedPct: DISK_USED_CRIT_PCT }] }))).toBe('crit');
  });
  it('warn at >=90% used', () => {
    expect(infraStatus(infra({ disk: [{ path: '/', usedPct: 91 }] }))).toBe('warn');
  });
  it('ok below the warn line; null/empty disk contributes nothing (fail-soft)', () => {
    expect(infraStatus(infra({ disk: [{ path: '/', usedPct: 72 }] }))).toBe('ok');
    expect(infraStatus(infra({ disk: null }))).toBe('ok');
    expect(infraStatus(infra({ disk: [] }))).toBe('ok');
  });
  it('warn on unapplied migrations (one restart away from surprise DDL)', () => {
    expect(infraStatus(infra({ migrationDrift: { unapplied: 2 } }))).toBe('warn');
    expect(infraStatus(infra({ migrationDrift: { unapplied: 0 } }))).toBe('ok');
  });
  it('warn when the newest OK backup is older than the staleness window', () => {
    expect(infraStatus(infra({ backup: { lastOkAtMs: 1, ageMs: BACKUP_STALE_MS + 1, lastStatus: 'ok', lastDbDumpOk: true } }))).toBe('warn');
    expect(infraStatus(infra({ backup: { lastOkAtMs: 1, ageMs: 60_000, lastStatus: 'ok', lastDbDumpOk: true } }))).toBe('ok');
    expect(infraStatus(infra({ backup: { lastOkAtMs: 1, ageMs: 60_000, lastStatus: 'degraded', lastDbDumpOk: false } }))).toBe('warn');
    // Legacy rows have no dump outcome. Unknown is fail-soft, not an
    // invented failure; the next explicit false/degraded row will warn.
    expect(infraStatus(infra({ backup: { lastOkAtMs: null, ageMs: null, lastStatus: 'ok', lastDbDumpOk: null } }))).toBe('ok');
    expect(infraStatus(infra({ backup: null }))).toBe('ok'); // leg unreadable — fail-soft
  });
});

/**
 * P-016 — the sibling miscalibration to the disk alarm below.
 *
 * "REAPER WEDGED" was derived from `reaperStale` alone, which is only
 * `age > threshold`. A clock cannot tell idle from stuck, so the crit recurred
 * every tick against a very large queue and never resolved.
 */
describe('isReaperWedged — a clock is not a cause (P-016)', () => {
  it('stale WITH rows rotting is a real wedge — the alarm still fires', () => {
    expect(isReaperWedged({ reaperStale: true, reaperAgeSec: 4000, stuckTotal: 7 })).toBe(true);
  });

  it('THE BUG: stale with a CLEAN queue is idle, not wedged', () => {
    // The reaper's job is to clear stuck rows. Nothing stuck ⇒ nothing it failed
    // to do ⇒ no crit. The plain `reaperStale` leg still surfaces this as a warn,
    // so the condition stays visible — it just stops shouting.
    expect(isReaperWedged({ reaperStale: true, reaperAgeSec: 40_000, stuckTotal: 0 })).toBe(false);
  });

  it('CONTROL: a FRESH reaper never reads as wedged, however much is stuck', () => {
    // Guards against the opposite overreach — blaming the reaper for a backlog
    // it is actively working through.
    expect(isReaperWedged({ reaperStale: false, reaperAgeSec: 10, stuckTotal: 900 })).toBe(false);
  });

  it('CONTROL: an UNREADABLE last-run time is unknown, never upgraded to a cause claim', () => {
    expect(isReaperWedged({ reaperStale: true, reaperAgeSec: null, stuckTotal: 12 })).toBe(false);
    expect(isReaperWedged({ reaperStale: true, reaperAgeSec: undefined, stuckTotal: 12 })).toBe(false);
  });

  it('CONTROL: an absent staleness leg (undefined) does not alarm', () => {
    expect(isReaperWedged({ reaperStale: undefined, reaperAgeSec: 4000, stuckTotal: 12 })).toBe(false);
  });

  /**
   * The SEVERITY must move with the wording, or the fix is cosmetic: a panel that
   * still reds on the clock is the same alarm wearing a quieter label. These pin
   * `workItemsStatus` to the same rule.
   */
  describe('workItemsStatus agrees with the wording', () => {
    const base = { total: 20_000, byState: {}, todo: 60, inProgress: 11, blocked: 120, needsHuman: 0, done: 0 };

    it('THE OBSERVED ALARM: stale reaper, CLEAN queue → warn, not crit', () => {
      // Shape taken from a live broadcast (2026-08-09): "20048 items — 60 todo,
      // 11 in-flight, 120 blocked, 55 need human — REAPER WEDGED", which carried
      // NO ", N stuck" segment — that segment renders only when stuckTotal > 0,
      // so this crit was firing against an empty backlog.
      expect(
        workItemsStatus({ ...base, needsHuman: 55, reaperAgeSec: 40_000, reaperStale: true }),
      ).toBe('warn');
    });

    it('CONTROL: stale reaper WITH a stranded backlog is still crit', () => {
      expect(
        workItemsStatus({ ...base, deadHeldClaims: 9, reaperAgeSec: 40_000, reaperStale: true }),
      ).toBe('crit');
    });

    it('CONTROL: the never-recorded-reaper branch (EI-2534) is unchanged', () => {
      expect(
        workItemsStatus({ ...base, deadHeldClaims: 3, reaperAgeSec: null, reaperStale: true }),
      ).toBe('crit');
      expect(workItemsStatus({ ...base, reaperAgeSec: null, reaperStale: true })).toBe('warn');
    });
  });
});

describe('diskBandWithHysteresis — EI-19944041837110102 (disk-alarm-flap)', () => {
  it('cold start (prevBand null) is a plain threshold check — no hysteresis to be stable against yet', () => {
    expect(diskBandWithHysteresis(96, null)).toBe('crit');
    expect(diskBandWithHysteresis(91, null)).toBe('warn');
    expect(diskBandWithHysteresis(50, null)).toBe('ok');
  });
  it('THE BUG: boundary noise around DISK_USED_CRIT_PCT (95) no longer flaps crit<->ok once crit is entered', () => {
    // measured live: 94-95% oscillation with a 118G buffer, firing + auto-resolving within
    // the same minute. A raw threshold check re-derives crit/not-crit from scratch every
    // tick and flaps on this exact input; hysteresis must not.
    expect(diskBandWithHysteresis(95, null)).toBe('crit'); // enters crit
    expect(diskBandWithHysteresis(94, 'crit')).toBe('crit'); // dips just under 95 — HOLDS crit
    expect(diskBandWithHysteresis(93, 'crit')).toBe('crit'); // still within the 3pt buffer — HOLDS
    expect(diskBandWithHysteresis(95, 'crit')).toBe('crit'); // back up — still crit, unsurprising
  });
  it('leaving crit requires dropping the full hysteresis buffer below DISK_USED_CRIT_PCT, not merely under it', () => {
    expect(diskBandWithHysteresis(92, 'crit')).toBe('crit'); // exactly at the buffer edge — still crit
    expect(diskBandWithHysteresis(91, 'crit')).toBe('warn'); // genuinely below the buffer — clears to warn
  });
  it('escalating to a WORSE band is immediate at the raw threshold — never buffered (a real fast fill must page without delay)', () => {
    expect(diskBandWithHysteresis(95, 'warn')).toBe('crit');
    expect(diskBandWithHysteresis(90, 'ok')).toBe('warn');
  });
  it('the WARN boundary (90) gets the same hysteresis treatment as CRIT', () => {
    expect(diskBandWithHysteresis(88, 'warn')).toBe('warn'); // within the buffer — holds warn
    expect(diskBandWithHysteresis(86, 'warn')).toBe('ok'); // below the buffer — clears to ok
  });
});

describe('infraStatus/infraSummary — disk hysteresis wiring (per-volume `band`, EI-19944041837110102)', () => {
  it('a volume`s own hysteresis `band` overrides a raw-threshold recompute of its usedPct', () => {
    // usedPct alone (93) is below DISK_USED_CRIT_PCT, but the collector already classified
    // this tick as still-crit (within the hysteresis buffer) — infraStatus must defer to it.
    expect(infraStatus(infra({ disk: [{ path: '/', usedPct: 93, band: 'crit' }] }))).toBe('crit');
  });
  it('no `band` supplied (a hand-built fixture) falls back to the plain threshold — unchanged behavior', () => {
    expect(infraStatus(infra({ disk: [{ path: '/', usedPct: 72 }] }))).toBe('ok');
    expect(infraStatus(infra({ disk: [{ path: '/', usedPct: 93 }] }))).toBe('warn'); // >= WARN_PCT, no band to say otherwise
  });
  it('worst band wins across multiple volumes, independent of which has the higher raw %', () => {
    expect(
      infraStatus(infra({ disk: [{ path: '/a', usedPct: 99, band: 'warn' }, { path: '/b', usedPct: 10, band: 'crit' }] })),
    ).toBe('crit');
  });
  it('crit summary scales wording by real headroom instead of a flat "writes are about to fail"', () => {
    const scary = infraSummary(infra({ disk: [{ path: '/x', usedPct: 95, freeGb: 118, band: 'crit' }] }), false);
    expect(scary).not.toMatch(/about to fail/);
    expect(scary).toMatch(/critically low/);
    expect(scary).toContain('118G free');
    const urgent = infraSummary(infra({ disk: [{ path: '/x', usedPct: 99, freeGb: 118, band: 'crit' }] }), false);
    expect(urgent).toMatch(/about to fail/); // >= DISK_CRIT_URGENT_PCT regardless of free space
    const tinyDisk = infraSummary(infra({ disk: [{ path: '/x', usedPct: 95, freeGb: 2, band: 'crit' }] }), false);
    expect(tinyDisk).toMatch(/about to fail/); // low absolute headroom is urgent even at a modest %
  });
  it('no freeGb (hand-built fixture) omits the free-space note without throwing', () => {
    expect(infraSummary(infra({ disk: [{ path: '/x', usedPct: 96, band: 'crit' }] }), false)).toMatch(/^DISK 96% used on \/x — /);
  });
});

describe('statusSeverity + ackCovers — ack coverage semantics (P-004 / D-A)', () => {
  it('severity ladder: crit 2, warn 1, ok/unknown 0', () => {
    expect(statusSeverity('crit')).toBe(2);
    expect(statusSeverity('warn')).toBe(1);
    expect(statusSeverity('ok')).toBe(0);
    expect(statusSeverity('unknown')).toBe(0);
  });
  const now = 1_000_000;
  it('an ack at crit covers warn AND crit', () => {
    expect(ackCovers({ status: 'crit', snoozeUntil: null }, 'crit', now)).toBe(true);
    expect(ackCovers({ status: 'crit', snoozeUntil: null }, 'warn', now)).toBe(true);
  });
  it('an ack at warn does NOT cover a later crit — escalation re-alarms', () => {
    expect(ackCovers({ status: 'warn', snoozeUntil: null }, 'crit', now)).toBe(false);
    expect(ackCovers({ status: 'warn', snoozeUntil: null }, 'warn', now)).toBe(true);
  });
  it('ok/unknown are never "covered" (the sweep clears the ack instead)', () => {
    expect(ackCovers({ status: 'crit', snoozeUntil: null }, 'ok', now)).toBe(false);
    expect(ackCovers({ status: 'crit', snoozeUntil: null }, 'unknown', now)).toBe(false);
  });
  it('an expired snooze covers nothing; a live snooze still covers', () => {
    expect(ackCovers({ status: 'warn', snoozeUntil: now - 1 }, 'warn', now)).toBe(false);
    expect(ackCovers({ status: 'warn', snoozeUntil: now + 60_000 }, 'warn', now)).toBe(true);
  });
});

describe('reconcilePausedQueen — the paused-Mug cry-wolf fix (P-001)', () => {
  const pausedQueen = (todo: number) =>
    ({ status: 'crit' as const, data: queen({ started: false, armed: false, demand: { todoItems: todo, startedPlans: 0 } }) });
  const wf = (o: Partial<WorkFeedHealth> = {}): WorkFeedHealth => ({
    frontier: 0, frontierBlocked: 0, startedPlans: 0, autoEligibleStuck: 0, deadRoutines: 0, deadRoutineNames: [], ...o,
  });
  it('paused + PLACEABLE frontier stays crit (a genuine silent outage)', () => {
    const r = reconcilePausedQueen(pausedQueen(3), { data: wf({ frontier: 2 }) });
    expect(r?.status).toBe('crit');
    expect(r?.summary).toContain('2 placeable item(s)');
  });
  it('paused + started plans (no frontier) stays crit', () => {
    const r = reconcilePausedQueen(pausedQueen(0), { data: wf({ startedPlans: 1 }) });
    expect(r?.status).toBe('crit');
    expect(r?.summary).toContain('started plan(s)');
  });
  it('paused + only STUCK frontier downgrades to warn — idle by choice, summary agrees', () => {
    const r = reconcilePausedQueen(pausedQueen(2), { data: wf({ frontier: 2, frontierStuck: 2 }) });
    expect(r?.status).toBe('warn');
    expect(r?.summary).toContain('none placeable');
  });
  it('paused + empty queue downgrades to warn (colony idle by choice)', () => {
    const r = reconcilePausedQueen(pausedQueen(0), { data: wf() });
    expect(r?.status).toBe('warn');
    expect(r?.summary).toContain('idle by choice');
  });
  it('unreadable work-feed keeps the conservative crit (returns null — no adjustment)', () => {
    expect(reconcilePausedQueen(pausedQueen(2), { data: null })).toBeNull();
  });
  // The case the `!wf` guard above did NOT cover, and the reason it went unnoticed: a
  // survey that THROWS leaves the panel present with a FABRICATED `frontier: 0`, so it
  // is byte-identical to a genuinely empty frontier — and falls through to the warn
  // downgrade, silencing a real silent-outage crit on a number nobody measured. Only
  // `frontierUnreadable` distinguishes them, which is what makes the documented
  // "fail-soft keeps the conservative crit" contract actually deliverable.
  it('a THROWN survey (frontierUnreadable, panel present) also keeps the conservative crit', () => {
    expect(reconcilePausedQueen(pausedQueen(2), { data: wf({ frontierUnreadable: true }) })).toBeNull();
  });
  it('CONTROL: the identical shape WITHOUT the flag still downgrades — so the flag is what did it', () => {
    // Pins that the test above is not passing for some incidental reason: same zeros,
    // flag absent ⇒ the old (wrong-for-an-unreadable-survey) downgrade still happens.
    const r = reconcilePausedQueen(pausedQueen(2), { data: wf() });
    expect(r?.status).toBe('warn');
  });
  it('no adjustment when not paused or not crit', () => {
    expect(reconcilePausedQueen({ status: 'crit', data: queen({ started: true, stalled: true }) }, { data: wf() })).toBeNull();
    expect(reconcilePausedQueen({ status: 'warn', data: queen({ started: false }) }, { data: wf() })).toBeNull();
    expect(reconcilePausedQueen({ status: 'crit', data: null }, { data: wf() })).toBeNull();
  });
});

describe('loopsStatus — engine self-wake loops (P-008)', () => {
  const lo = (o: Partial<LoopsHealth> = {}): LoopsHealth => ({
    armed: 2, overdue: 0, overdueNames: [], failureStreaks: 0, lastFireAt: null, ...o,
  });
  it('warn on an overdue armed loop', () => {
    expect(loopsStatus(lo({ overdue: 1, overdueNames: ['loop-su-x'] }))).toBe('warn');
  });
  it('warn on a failure streak', () => {
    expect(loopsStatus(lo({ failureStreaks: 1 }))).toBe('warn');
  });
  it('ok with healthy loops — and ok with zero armed loops (none is not a failure)', () => {
    expect(loopsStatus(lo())).toBe('ok');
    expect(loopsStatus(lo({ armed: 0 }))).toBe('ok');
  });
});

describe('coordinationStatus — WARN-max during burn-in (P-009 / D-D)', () => {
  const co = (o: Partial<CoordinationHealth> = {}): CoordinationHealth => ({
    unansweredAgents: 0, unansweredTotal: 0, unansweredOldestMs: null,
    criticalContext: 0, highContext: 0, activeAwaits: 0, staleAwaits: 0,
    leaderlessFleets: 0, liveFleets: 0,
    orphanedClaims: 0, stalledClaims: 0, coverageCollisions: 0, parkedMembers: 0,
    ...o,
  });
  it('warn on a leaderless fleet', () => {
    expect(coordinationStatus(co({ leaderlessFleets: 1, liveFleets: 2 }))).toBe('warn');
  });
  it('warn on stale (likely stranded) awaits', () => {
    expect(coordinationStatus(co({ activeAwaits: 5, staleAwaits: 1 }))).toBe('warn');
  });
  it('warn on critical context pressure', () => {
    expect(coordinationStatus(co({ criticalContext: 1, highContext: 3 }))).toBe('warn');
  });
  it('warn on an unanswered directed message past the threshold — never crit (burn-in)', () => {
    expect(coordinationStatus(co({ unansweredOldestMs: UNANSWERED_DIRECTED_WARN_MS + 1 }))).toBe('warn');
  });
  it('a fresh unanswered directed message does not warn yet', () => {
    expect(coordinationStatus(co({ unansweredTotal: 1, unansweredOldestMs: 60_000 }))).toBe('ok');
  });
  it('high (not critical) context alone is ok; ok when quiet', () => {
    expect(coordinationStatus(co({ highContext: 4 }))).toBe('ok');
    expect(coordinationStatus(co())).toBe('ok');
  });
  it('warn on an orphaned claim (dead holder — abandoned work, WI-4460)', () => {
    expect(coordinationStatus(co({ orphanedClaims: 1 }))).toBe('warn');
  });
  it('warn on a stalled claim (live holder, no progress)', () => {
    expect(coordinationStatus(co({ stalledClaims: 2 }))).toBe('warn');
  });
  it('warn on a coverage collision (EI-6074: two principals, one deliverable)', () => {
    expect(coordinationStatus(co({ coverageCollisions: 1 }))).toBe('warn');
  });
  it('benched members are idle-by-design — never affect status', () => {
    expect(coordinationStatus(co({ parkedMembers: 7 }))).toBe('ok');
  });
  it('is warn-max by construction: every alarming input together still warns', () => {
    expect(coordinationStatus(co({
      leaderlessFleets: 2, staleAwaits: 3, criticalContext: 2,
      unansweredOldestMs: 4 * UNANSWERED_DIRECTED_WARN_MS,
      orphanedClaims: 4, stalledClaims: 2, coverageCollisions: 1,
    }))).toBe('warn');
  });
});

describe('memoryStatus — degraded recall over a real store (P-010)', () => {
  const me = (o: Partial<MemoryPanelHealth> = {}): MemoryPanelHealth => ({
    totalMemories: 500, entityRows: 0, feedback30d: 10, zeroHitRate: 0.2,
    recalls7d: 500, recallTelemetryOk: true, ...o,
  });
  it('warn only when a REAL store has a ~dead recall signal', () => {
    expect(memoryStatus(me({ zeroHitRate: 0.95 }))).toBe('warn');
  });
  it('a small/new store never warns, whatever its hit rate', () => {
    expect(memoryStatus(me({ totalMemories: 50, zeroHitRate: 1 }))).toBe('ok');
  });
  it('a healthy rate over real observations is ok', () => {
    expect(memoryStatus(me())).toBe('ok');
  });

  // EI-10625 — ABSENCE OF SIGNAL IS NOT HEALTH.
  //
  // readRecallHealth computes `recalls > 0 ? zeroHit/recalls : 0`, so a recall
  // pipeline that has recorded NOTHING — or whose read threw — hands this panel a
  // 0.0 zero-hit rate: the single healthiest value in the range. The old contract
  // ("no telemetry is ok — fail-soft") took that at face value and went green,
  // which is precisely how a monitor that cannot see becomes a monitor that says
  // everything is fine. These tests exist to PROVE the detector can fire.
  describe('a blind panel must not read as a healthy one', () => {
    it('FIRES: a real store with ZERO recorded recalls in 7d — a dark pipeline, not flawless recall', () => {
      // The exact shape a dead recall-stats writer produces: rate degrades to 0.
      expect(memoryStatus(me({ recalls7d: 0, zeroHitRate: 0 }))).toBe('warn');
    });
    it('FIRES: the telemetry read FAILED — we know nothing, and nothing is not "fine"', () => {
      // readMemoryHealth swallows the error and returns all-zeros; only the flag survives.
      expect(memoryStatus(me({ recallTelemetryOk: false, recalls7d: 0, zeroHitRate: 0 }))).toBe('warn');
    });
    it('FIRES even when every other reading looks perfect (the regression this bug IS)', () => {
      // 10k memories, a busy feedback loop, and a flawless 0% zero-hit rate — all of it
      // downstream of a denominator of zero. Green here is the bug.
      expect(
        memoryStatus(me({ totalMemories: 10_491, feedback30d: 250, zeroHitRate: 0, recalls7d: 0 })),
      ).toBe('warn');
    });
    it('does NOT fire on a new/small store with no recalls yet — that zero is honest', () => {
      expect(memoryStatus(me({ totalMemories: 50, recalls7d: 0, zeroHitRate: 0 }))).toBe('ok');
    });
    it('does NOT fire when the rate is unreadable but observations EXIST (defensive field probe)', () => {
      // compute.ts's zero-hit probe is deliberately loose about field names; a null rate
      // with a live denominator means we failed to parse a value, not that we are blind.
      expect(memoryStatus(me({ zeroHitRate: null, recalls7d: 500 }))).toBe('ok');
    });
  });
});

describe('context-injection delivery — a crit REQUIRES a baseline (P-005)', () => {
  const row = (o: Partial<ContextInjectionClientRow> & { client: string }): ContextInjectionClientRow => {
    const base = {
      sessions: 0, events: 0, recalled: 0, unknownTool: 0,
      driftTools: [] as string[], everObserved: false,
      ...o,
      // These cases are about the CLIENT-level verdict, so they assert nothing
      // about ports and carry none. The per-port roll-up has its own describe
      // block below (WI-37597).
      //
      // Pinned AFTER the spread, not before: `o` is a Partial, so spreading it
      // last widens `ports` to `... | undefined` and the result stops being a
      // ContextInjectionClientRow (TS2322 — a committed standing red, since
      // vitest transpiles without typechecking and so stays green on it).
      // Same value either way; this only keeps the type honest.
      ports: o.ports ?? ([] as ContextInjectionClientRow['ports']),
    };
    return { ...base, verdict: classifyInjectionClient(base) };
  };
  const health = (clients: ContextInjectionClientRow[]): ContextInjectionHealth => ({
    windowHours: 24,
    clients,
    totalEvents: clients.reduce((a, c) => a + c.events, 0),
    recordingPathSuspect: false,
  });

  describe('classifyInjectionClient', () => {
    it('a client nobody ran is idle — never alarmed at, in either direction', () => {
      expect(classifyInjectionClient({ sessions: 0, events: 0, unknownTool: 0, everObserved: true }))
        .toBe('idle');
    });
    it('sessions + no rows + NO baseline = never-observed (a known gap, not a regression)', () => {
      expect(classifyInjectionClient({ sessions: 385, events: 0, unknownTool: 0, everObserved: false }))
        .toBe('never-observed');
    });
    it('sessions + no rows + a baseline = regressed (it worked before; it stopped)', () => {
      expect(classifyInjectionClient({ sessions: 385, events: 0, unknownTool: 0, everObserved: true }))
        .toBe('regressed');
    });
    it('delivering, but an unmapped tool = drift (the one actionable non-fatal outcome)', () => {
      expect(classifyInjectionClient({ sessions: 11, events: 3, unknownTool: 1, everObserved: true }))
        .toBe('drift');
    });
  });

  /**
   * THE REGRESSION GUARD FOR THE WHOLE DESIGN — measured production state,
   * 2026-08-09, the day this shipped:
   *   claude  385 sessions / 0 events / no baseline  (recorder not deployed on its port)
   *   omp      10 sessions / 0 events / no baseline  (same)
   *   codex    11 sessions / 3 events / baseline     (the probe rows)
   * A literal reading of P-005 ("no rows at all fires") pages for claude AND omp
   * here, with a confidently wrong cause. It must not.
   */
  it('does NOT page on the real day-one state (2 clients silent for a DEPLOY reason)', () => {
    const d = health([
      row({ client: 'claude', sessions: 385 }),
      row({ client: 'codex', sessions: 11, events: 3, recalled: 1, unknownTool: 1, driftTools: ['X'], everObserved: true }),
      row({ client: 'omp', sessions: 10 }),
    ]);
    expect(d.clients.map((c) => c.verdict)).toEqual(['never-observed', 'drift', 'never-observed']);
    expect(contextInjectionStatus(d)).toBe('warn');
    expect(contextInjectionStatus(d)).not.toBe('crit');
  });

  /**
   * CONTROL — the baseline rule must be LOAD-BEARING, not decorative. The input
   * is IDENTICAL to the test above except `everObserved`, and it must reach crit.
   * The pair pins both directions and neither does alone: collapse the rule to
   * "always regressed" and the previous test fails; collapse it to "never
   * regressed" — the tempting way to silence a noisy alarm — and THIS one fails.
   * A detector that cannot be shown to fire is not a detector.
   */
  it('DOES page once the same client has a baseline and goes silent', () => {
    const d = health([
      row({ client: 'claude', sessions: 385, everObserved: true }),
      row({ client: 'codex', sessions: 11, events: 3, everObserved: true }),
      row({ client: 'omp', sessions: 10, everObserved: true }),
    ]);
    expect(d.clients[0].verdict).toBe('regressed');
    expect(contextInjectionStatus(d)).toBe('crit');
  });

  it('a fully-working fleet is ok — the alarm is silent when it should be', () => {
    const d = health([
      row({ client: 'claude', sessions: 385, events: 900, recalled: 700, everObserved: true }),
      row({ client: 'codex', sessions: 11, events: 20, recalled: 12, everObserved: true }),
      row({ client: 'omp', sessions: 10, events: 15, recalled: 9, everObserved: true }),
    ]);
    expect(contextInjectionStatus(d)).toBe('ok');
  });
});

/**
 * The per-PORT roll-up (WI-37597).
 *
 * A client-level total cannot say "turn-start is dead but mid-turn is fine" —
 * the working port's traffic keeps `events` healthy, so the panel stays green
 * through a real outage. `worstInjectionVerdict` is what lets one dead port move
 * the panel at all, and these cases pin the two readings that must not blur:
 * a port with a baseline that went silent (pageable) versus one that has never
 * written at all (a known gap, deliberately not pageable).
 */
describe('worstInjectionVerdict — a dead port must not hide behind a healthy one', () => {
  /** A one-client panel carrying an already-rolled-up verdict. Local because the
   *  fixtures above are scoped to their own describe. */
  const panel = (
    verdict: ContextInjectionClientRow['verdict'],
    ports: ContextInjectionClientRow['ports'],
  ): ContextInjectionHealth => ({
    windowHours: 24,
    clients: [
      {
        client: 'claude', sessions: 385, events: 900, recalled: 700, unknownTool: 0,
        driftTools: [], everObserved: true, verdict, ports,
      },
    ],
    totalEvents: 900,
    recordingPathSuspect: false,
  });

  it('takes the worst, so a regressed port beats an ok one', () => {
    expect(worstInjectionVerdict(['ok', 'regressed'])).toBe('regressed');
    expect(worstInjectionVerdict(['regressed', 'ok'])).toBe('regressed');
  });

  it('ranks idle BELOW ok, so a quiet port never outvotes a working one', () => {
    // idle means "no sessions, nothing to conclude". If it outranked ok it would
    // drag a healthy client down; if it were treated as ok it would invent a
    // pass. It must simply lose to anything that actually reported.
    expect(worstInjectionVerdict(['ok', 'idle'])).toBe('ok');
    expect(worstInjectionVerdict(['idle', 'idle'])).toBe('idle');
  });

  it('ranks actionable drift above a known never-observed gap', () => {
    expect(worstInjectionVerdict(['never-observed', 'drift'])).toBe('drift');
  });

  it('an empty set is idle, NOT ok — no verdicts is no evidence', () => {
    // The same principle the baseline rule applies one level down: absence of a
    // reading must never degrade into a confident pass.
    expect(worstInjectionVerdict([])).toBe('idle');
  });

  it('THE CASE THIS EXISTS FOR: healthy mid-turn + dead turn-start still pages', () => {
    // claude's mid-turn port doing 900 events while its turn-start port has a
    // baseline and has gone completely silent. Before the roll-up this client
    // read 'ok' on the strength of the mid-turn traffic alone.
    const ports: ContextInjectionClientRow['ports'] = [
      { port: 'turn-start', events: 0, everObserved: true, verdict: 'regressed' },
      { port: 'mid-turn', events: 900, everObserved: true, verdict: 'ok' },
    ];
    const clientLevel = classifyInjectionClient({
      sessions: 385, events: 900, unknownTool: 0, everObserved: true,
    });
    expect(clientLevel).toBe('ok'); // ← the masking, reproduced
    const rolled = worstInjectionVerdict([clientLevel, ...ports.map((p) => p.verdict)]);
    expect(rolled).toBe('regressed'); // ← and defeated

    expect(contextInjectionStatus(panel(rolled, ports))).toBe('crit');
  });

  it('a never-written turn-start port warns, and does NOT page', () => {
    // The state of every client the moment the reader learned to look per-port
    // and before the new writer had recorded anything. A crit here would have
    // been a false page on the rollout of its own fix.
    const ports: ContextInjectionClientRow['ports'] = [
      { port: 'turn-start', events: 0, everObserved: false, verdict: 'never-observed' },
      { port: 'mid-turn', events: 900, everObserved: true, verdict: 'ok' },
    ];
    const rolled = worstInjectionVerdict(['ok', ...ports.map((p) => p.verdict)]);
    expect(rolled).toBe('never-observed');
    expect(contextInjectionStatus(panel(rolled, ports))).toBe('warn');
    expect(contextInjectionStatus(panel(rolled, ports))).not.toBe('crit');
  });
});
