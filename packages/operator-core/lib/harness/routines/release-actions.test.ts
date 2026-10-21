/**
 * Release-gating system actions — the wiring half of the release gate
 * (release-gate-ready-branch-2026-06-04 Phase 1; AUTO-SERVE since
 * staging-branch-pipeline-2026-06-06). Covers:
 *   - register-system-actions side-effect import populates the registry with
 *     BOTH `green-checkpoint` and `release-trigger`.
 *   - release-trigger's noop-gating + scripted auto-deploy: a deploy plan with
 *     noop:true (or unparseable stdout) must NOT deploy; a real noop:false plan
 *     runs `deploy-cli --execute` directly and logs a `deploy` pipeline event.
 *
 * runScript shells out via node:child_process.spawn — mocked with a small
 * EventEmitter spawn-fake. pipeline-events is mocked so no PG is touched. No
 * subprocess, no network.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach, afterAll } from 'vitest';
import { describeGateRedOwnership } from '../../release/gate-red-ownership';
import { buildCandidateSnapshot } from '../../release/candidate-snapshot';
import { resolveIntegrationRoot, integrationRootEvidence, CHECKPOINT_SCOPE_RUNTIME_MAX_SEC } from './release-actions';
import { GREEN_CHECKPOINT_RESULT_MARKER } from '../../release/checkpoint-log-tags';
import { pipelineName } from '../../release/pipeline-name';
import { evaluateGateReuseAuditWindow } from '../../release/gate-fire-ledger';
import { buildTestPassReuseHealth } from '../../release/test-pass-reuse-report';
import { captureGateSuiteVerdictReplay } from '../../release/gate-hygiene-split';
import { readLastGateSuiteVerdictReplay } from './release-actions';
import { auditDraw, formatTestReuseLine, formatTestReuseTotalLine } from '../../../../../scripts/lib/test-pass-reuse.mjs';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- mocks (hoisted) ---------------------------------------------------------
const spawnMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...a: unknown[]) => spawnMock(...a) };
});

const appendPipelineEvent = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../git-sync/pipeline-events', () => ({
  appendPipelineEvent: (...a: unknown[]) => appendPipelineEvent(...a),
}));

const emitAwaitedEvent = vi.fn(async (..._a: unknown[]) => ({}));
vi.mock('../../events/await/engine', () => ({
  emitAwaitedEvent: (...a: unknown[]) => emitAwaitedEvent(...a),
}));

const recordStoredQualificationVerdict = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]): Promise<{ status: string; transaction?: Record<string, unknown> }> => ({
    status: 'missing',
  })),
);
const recordStoredQualificationScheduledTerminalRecovery = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]): Promise<{ status: string; transaction?: Record<string, unknown> }> => ({
    status: 'missing',
  })),
);
const readStoredQualification = vi.hoisted(() =>
  vi.fn(
    async (
      ..._a: unknown[]
    ): Promise<{ status: string; transaction?: { phase: string; attemptId: string; currentPhysicalRunner?: unknown; outcome?: unknown; requiredAncestorSha?: string | null } }> => ({ status: 'none' }),
  ),
);
const beginStoredQualification = vi.hoisted(() => vi.fn());
const recordStoredQualificationScheduledFire = vi.hoisted(() => vi.fn());
const reserveStoredQualificationRunner = vi.hoisted(() => vi.fn());
const probeRunnerLiveness = vi.hoisted(() => vi.fn());
vi.mock('../../release/checkpoint-qualification-transaction', async (orig) => ({
  ...(await orig<typeof import('../../release/checkpoint-qualification-transaction')>()),
  recordStoredQualificationVerdict: (...a: unknown[]) => recordStoredQualificationVerdict(...a),
  recordStoredQualificationScheduledTerminalRecovery: (...a: unknown[]) => recordStoredQualificationScheduledTerminalRecovery(...a),
  readStoredQualification: (...a: unknown[]) => readStoredQualification(...a),
  beginStoredQualification: (...a: unknown[]) => beginStoredQualification(...a),
  recordStoredQualificationScheduledFire: (...a: unknown[]) => recordStoredQualificationScheduledFire(...a),
  reserveStoredQualificationRunner: (...a: unknown[]) => reserveStoredQualificationRunner(...a),
  probeRunnerLiveness: (...a: unknown[]) => probeRunnerLiveness(...a),
}));

const readLiveReleaseCertification = vi.hoisted(() => vi.fn());
vi.mock('../../release/live-release-certification', async (orig) => ({
  ...(await orig<typeof import('../../release/live-release-certification')>()),
  readLiveReleaseCertification: (...args: unknown[]) => readLiveReleaseCertification(...args),
}));

// EI-21363817573800034: drive the scheduled gate's ADMISSION check. Only the reader is
// replaced — releaseCheckpointConfig() and the rest of the module stay REAL, so this cannot
// mask a regression in the thresholds the same module owns.
const qualificationAdmission = vi.fn(async (): Promise<QualificationAdmission> => ({ status: 'clear' }));
vi.mock('../../release-checkpoint-config', async (orig) => ({
  ...(await orig<typeof import('../../release-checkpoint-config')>()),
  readQualificationAdmission: () => qualificationAdmission(),
}));

// The production action's memory admission is mocked open for the historical tests below.
// Keep an explicit override so the recurrence test can exercise the real over-budget branch
// without depending on whatever checkpoint scopes happen to be live on the test host.
type MemoryAdmissionStub = {
  admit: boolean;
  reason: string;
  requestG: number;
  committedG: number;
  budgetG: number;
  scopes: number;
  unbounded: number;
  detail: string;
};
const memoryAdmissionOverride = vi.hoisted(() => ({ value: null as MemoryAdmissionStub | null }));

// EI-10158: the green-checkpoint action's fail-safe stall-tracking + flake-history
// (trackGateStall / trackFlakeHistory) and release-trigger's back-off read reach
// @papercusp/db-org DIRECTLY (getOrgPg().sql.unsafe) — not through appendPipelineEvent.
// Left unmocked, this UNIT test reaches out to real Postgres: it happens to pass when the
// dev box's native :5432 is up, but in CI / embedded-PG / during an operator restart the
// connection is REFUSED, the fail-safe `.catch` logs `console.warn(...ECONNREFUSED...)`, and
// vitest-fail-on-console reds the test (the "failed 4× in 6h" env-dependent flake). Stub the
// SQL boundary so the suite is deterministic regardless of PG reachability. The fake returns
// an empty result with a numeric `.count` (postgres.js Result shape) so every caller —
// rows[0]?.gh (→ {}), cleared.count (→ 0, no stall-clear warn), shouldBackOff(null) (→ false,
// same as the fail-open path) — behaves as the no-prior-state happy path.
// postgres.js `sql` is a CALLABLE tagged template that CARRIES `.unsafe`/`.begin` as
// properties — it is not a plain object holding those two keys. A non-callable double is
// therefore LOWER FIDELITY than the real client: every production site reaching the
// template-tag form (`sql`…``) dies with `TypeError: sql is not a function` instead of
// taking the no-prior-state happy path this stub exists to provide. That is not a corner
// case — operator-core has ~1.5k template-tag call sites against ~28 `.unsafe` ones on
// this module alone, so the object-shaped double failed 24 of this file's 235 tests while
// the other 211 (which happen to reach only `.unsafe`) passed and hid it. Shape the double
// like the real thing: a tag function with the two members hung off it.
const fakeSqlTag = vi.fn(async (..._a: unknown[]) => Object.assign([] as unknown[], { count: 0 }));
const fakeSql = Object.assign(fakeSqlTag, {
  unsafe: vi.fn(async (..._a: unknown[]) => Object.assign([] as unknown[], { count: 0 })),
  // The retire path uses a short transaction so the routine-row lock, liveness sample, and
  // identity CAS are one lifecycle cut. Keep the fake transactional rather than silently
  // falling back to a non-atomic test path.
  begin: vi.fn(),
});
fakeSql.begin.mockImplementation(async (callback: (tx: typeof fakeSql) => Promise<unknown>) => callback(fakeSql));
// The postgres.js Result shape `fakeSql.unsafe` resolves to: the rows PLUS a numeric `.count`.
// Build mock resolutions through this so a stubbed query keeps the real result's shape — a bare
// array is not assignable to it, and casting the difference away (`as never`) is exactly the
// mock-cast escape `scripts/check-mock-cast-escape.mjs` ratchets down.
const sqlRows = (rows: unknown[]) => Object.assign(rows, { count: rows.length });
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fakeSql }),
}));

// EI-13723: dispatchReleaseFixer's actual fire step (dynamic-imported, so it's invisible to a
// plain function-level mock) — stubbed so the EI-13723 dispatch-convergence tests below can
// assert the fire was ATTEMPTED without touching the real blueprint-launch machinery.
const fireLaunchBlueprintForEvent = vi.fn(async (..._a: unknown[]): Promise<unknown> => null);
vi.mock('../../blueprint/launch-blueprint', () => ({
  fireLaunchBlueprintForEvent: (...a: unknown[]) => fireLaunchBlueprintForEvent(...a),
}));
// EI-13723: dispatchReleaseFixer's best-effort flake annotation (testFlakeRollup) reaches
// @papercusp/db-org's `sql` template-tag directly (not sql.unsafe) — the fakeSql stub above only
// implements `.unsafe`, so left unmocked this throws (non-fatally, caught) but still trips
// vitest-fail-on-console via its own warn. Stub it out to an empty rollup for a clean fire test.
vi.mock('../../dev-data', async (orig) => ({
  ...(await orig<typeof import('../../dev-data')>()),
  testFlakeRollup: async () => ({ entries: [] }),
}));
// EI-13723: dispatchReleaseFixer's notify step (notifyAttention) reaches the real SSE
// invalidation bus (notifySyncInvalidate → pg-adapter's `sql` template-tag), which the fakeSql
// stub above doesn't implement — left unmocked this throws, and the bus's own onError handler
// logs via a raw `console.error` (not caught by notifyAttention's try/catch before it fires),
// tripping vitest-fail-on-console. Stub the module boundary like every other test that exercises
// a dispatch path (deploy.test.ts, green-stall-watchdog.test.ts, ...).
// notifyAttentionOnce too: the replay-safe variant is reached both by release-actions.ts itself
// and, statically at import, through register-system-actions → connected-apps/alert-sweep. A
// hand-listed factory that omits it fails the whole file at collection.
const notifyAttention = vi.fn(async (..._a: unknown[]) => {});
const notifyAttentionOnce = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../../attention-notify', () => ({
  notifyAttention: (...a: unknown[]) => notifyAttention(...a),
  notifyAttentionOnce: (...a: unknown[]) => notifyAttentionOnce(...a),
}));

// WI-2141541: the green-checkpoint action calls admitCheckpointMemory({ requestG }) before it
// spawns the suite (release-actions.ts, just above the spawn), and the DEFAULT probe scans the
// REAL /proc + /sys/fs/cgroup tree for live green-checkpoint scopes and sums their memory.max.
// That is host state, not a unit-test input: with three checkpoint runs live on the box the
// action deferred every tick here (`skip my-harness: checkpoint-memory: DEFERRING 16 GiB — 120.0
// GiB already committed by 3 live scope(s)`), spawnMock was never called, and 16 assertions
// failed — 14 of them via vitest-fail-on-console on that very warn. Seen on the gate at
// 2026-08-31 18:38Z and 2026-09-02 11:26Z with unchanged code, passing alone minutes later.
// Stub the admission to admit; the admission logic keeps its own probe-injected test in
// release/checkpoint-memory-admission.test.ts. No test here asserts the memory-budget path.
vi.mock('../../release/checkpoint-memory-admission', async (orig) => ({
  ...(await orig<typeof import('../../release/checkpoint-memory-admission')>()),
  admitCheckpointMemory: (opts: { requestG: number }) =>
    memoryAdmissionOverride.value ?? {
      admit: true,
      reason: 'admitted-sole-run' as const,
      requestG: opts.requestG,
      committedG: 0,
      budgetG: 125,
      scopes: 0,
      unbounded: 0,
      detail: `checkpoint-memory: TEST STUB — admitting ${opts.requestG} GiB (host scope census is not a unit-test input)`,
    },
}));

// WI-6554700010018575: the scheduled action reads THIS root's run lock before the memory
// admission. The default reads the REAL lock directory, which a live gate run on this host
// holds — host state, not a test input (the same leak WI-2141541 describes above). Stub
// not-held; a test that needs a held lock sets runLockOverride.value.
const runLockOverride = vi.hoisted(() => ({
  value: null as null | { held: boolean; pid?: number; elapsedSec: number | null },
  // WI-6554700010019013: which (root, logDir) the pre-admission probe asked about.
  calls: [] as Array<{ root: string; logDir: unknown }>,
}));
vi.mock('../../release-checkpoint-lock', async (orig) => ({
  ...(await orig<typeof import('../../release-checkpoint-lock')>()),
  isCheckpointRunLockHeldCheap: (root: string, ...rest: unknown[]) => {
    runLockOverride.calls.push({ root, logDir: rest[3] });
    return runLockOverride.value ?? { held: false, elapsedSec: null };
  },
}));

// per-hive-git-and-release-gate P-010: the handlers now resolve the operator-home slug to
// route per-hive (green-checkpoint) / guard leg-3 (release-trigger). Make the fixture's
// `my-harness` BE the operator-home so these tests exercise the home (default) path; other
// exports are preserved.
vi.mock('../operator-home-harness', async (orig) => ({
  ...(await orig<typeof import('../operator-home-harness')>()),
  operatorHomeHarnessSlug: () => 'my-harness',
}));

// EI-20709645463022690: the SUBJECT-hive gate run is what the DSN fix is about, and the
// fixture slug above IS the operator home — so the subject path is unreachable through the
// real resolver here. Override the ROUTING only (never the env construction, which
// hive-release-env.integration.test.ts pins directly): the test below is about what
// release-actions DOES with a routing that carries clearEnv, i.e. the child's actual env.
// Null override → the real resolver, so every other test in this file is untouched.
// A PATCH over the real routing, not a replacement: `root` stays whatever the real resolver
// produced (the tooling-availability guard runs against it, and a hand-invented root would
// skip the suite instead of spawning it). Null → untouched real behavior for every other test.
let routingPatch: Partial<import('./hive-release-env').CheckpointRouting> | null = null;
vi.mock('./hive-release-env', async (orig) => {
  const actual = await orig<typeof import('./hive-release-env')>();
  return {
    ...actual,
    resolveCheckpointRouting: async (...a: Parameters<typeof actual.resolveCheckpointRouting>) => {
      const real = await actual.resolveCheckpointRouting(...a);
      return routingPatch ? { ...real, ...routingPatch } : real;
    },
  };
});

// importing register-system-actions runs every side-effect import (git-sync,
// blueprint, release-actions) so the registry is populated as in production.
import '../git-sync/git-sync-action';
import '../../blueprint/blueprint-run-action';
import './release-actions';
import './frozen-candidate-drift-sweep-action';
import {
  buildIsolatedScopeArgv,
  shouldAutoServe,
  shouldBackOff,
  gateStallEscalationBody,
  decideReleaseFixerDispatch,
  classifyFrozenRepairFixerSuccession,
  FIXER_SUCCESSION_STALL_MS,
  isProvenStaleCandidate,
  shouldDispatchReleaseFixer,
  frozenRepairHasNoMeasuredFailures,
  isStaleReleaseFixerCandidate,
  checkReleaseFixerCandidateStale,
  checkpointFallbackStatus,
  classifyGateStallStatus,
  gateStallRecordOnlyLogMessage,
  gateStallNoopLogMessage,
  shouldWarnOnStallClearMiss,
  annotateFailingTestsWithFlakeStats,
  releaseToolingStatus,
  publishSignedGateVerdicts,
  publishSignedGateVerdictsWithDeadline,
  DEFAULT_GREEN_CHECKPOINT_DB_POOL_MAX,
  resolveGreenCheckpointDbPoolMax,
  RELEASE_FIXER_DEDUP_MS,
  recordCheckpointVerdict,
  recordPendingCheckpointVerdict,
  trackGateStall,
  TRANSIENT_ABORT_REQUEUE_MINS,
  buildCheckpointDetail,
  verdictQualificationAttemptId,
  buildReleaseFixerKickoff,
  dispatchReleaseFixer,
  buildScheduledCheckpointShell,
  checkpointRunLogPaths,
  checkpointTerminalHasOomKill,
  parseScheduledCheckpointTerminal,
  resolveCheckpointResultFromLogs,
  reconcileScheduledCheckpointTerminals,
  readFrozenCandidateRepairQueue,
  readFrozenCandidateRepairQueueState,
  retireFrozenCandidateRepairQueue,
  reserveFrozenCandidateRepairFixer,
  renewFrozenCandidateRepairFixerReservation,
  finalizeFrozenCandidateRepairFixer,
  writeFrozenCandidateRepairQueue,
  applyFrozenCandidateRepairQueueTransition,
  FrozenRepairQueueWriteConflictError,
  type AutoServePlan,
  type DeployEventRow,
  type ReleaseFixerRecord,
  type GitCheckRunner,
} from './release-actions';
import { getSystemAction, listSystemActions, type SystemActionCtx } from './system-actions';
// EI-21462211894072863: the abort-advice table is the SURFACING half of the no-verdict split —
// recording a crash that no reader can be advised about would leave the fix half-landed.
import {
  isRecordedInconclusiveStatus,
  classifyGateAbort,
  gateAbortRefireClause,
  gateAbortLever,
} from '../../release/gate-abort-status';
import type { QualificationAdmission } from '../../release-checkpoint-config';
import type { FlakeSuspect } from '../../dev-data';
import {
  FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
  type FrozenCandidateRepairQueue,
} from '../../release/frozen-candidate-repair-queue';
import {
  CHECKPOINT_QUALIFICATION_ATTEMPT_ENV,
  CHECKPOINT_SCHEDULED_RUN_ENV,
} from '../../release/checkpoint-qualification-transaction';

describe('gateStallEscalationBody (P-003 silent-stall escalation)', () => {
  it('builds a green-checkpoint-stall body with streak, age, capped candidate + failing tests', () => {
    const body = JSON.parse(
      gateStallEscalationBody({
        installSlug: 'papercup',
        consecutiveReds: 4,
        heldHrs: 7,
        candidate: 'abcdef1234567890',
        failingTests: Array.from({ length: 25 }, (_, i) => `t${i}`),
        nowMs: 1_700_000_000_000,
      }),
    );
    expect(body.kind).toBe('green-checkpoint-stall');
    expect(body.harness_slug).toBe('papercup');
    expect(body.consecutiveReds).toBe(4);
    expect(body.heldHrs).toBe(7);
    expect(body.candidate).toBe('abcdef123456'); // 12-char cap
    expect(body.failingTests).toHaveLength(20); // capped at 20
    expect(body.emitted_at).toBe(1_700_000_000_000);
    expect(body.detail).toContain('4 checkpoint(s)');
    expect(body.detail).toContain('~7h');
    expect(body.detail).toContain('Failing: t0, t1, t2, t3, t4 (+15 more)');
  });

  it('omits the age + failing-test clauses when there is no green history / no tests', () => {
    const body = JSON.parse(gateStallEscalationBody({ installSlug: 'x', consecutiveReds: 3, heldHrs: null, nowMs: 1 }));
    expect(body.heldHrs).toBeNull();
    expect(body.candidate).toBeNull();
    expect(body.failingTests).toEqual([]);
    expect(body.detail).not.toContain('since the last green');
    expect(body.detail).not.toContain('Failing:');
  });

  /**
   * EI-18672078222841101 — the escalation must say WHO owns the red, because three agents
   * each read a red alert with no ownership field and each correctly-but-redundantly took
   * the gate. Ownership is optional here so an unwired caller renders exactly as before.
   */
  it('carries the ownership verdict, so a responder can tell "covered" from "yours to take"', () => {
    const owned = JSON.parse(
      gateStallEscalationBody({
        installSlug: 'x',
        consecutiveReds: 3,
        heldHrs: 2,
        nowMs: 1,
        ownership: describeGateRedOwnership({
          ownerSignature: 'a.test.ts',
          currentSignature: 'a.test.ts',
          spawnId: 'spawn-9',
          dispatchedAtMs: 1_000,
          fixerAlive: true,
          nowMs: 61_000,
        }),
      }),
    );
    expect(owned.ownership).toMatchObject({ state: 'owned-live', covered: true, spawnId: 'spawn-9' });
    expect(owned.detail).toContain('OWNED');
    expect(owned.detail).toContain('Do NOT start a parallel diagnosis');

    const gone = JSON.parse(
      gateStallEscalationBody({
        installSlug: 'x',
        consecutiveReds: 3,
        heldHrs: 2,
        nowMs: 1,
        ownership: describeGateRedOwnership({
          ownerSignature: 'a.test.ts',
          currentSignature: 'a.test.ts',
          spawnId: 'spawn-dead',
          dispatchedAtMs: 1_000,
          fixerAlive: false,
          nowMs: 61_000,
        }),
      }),
    );
    // The specific regression: the old body asserted "A release-fixer is on it"
    // unconditionally, which is FALSE here and leaves the gate unowned.
    expect(gone.ownership).toMatchObject({ state: 'owner-gone', covered: false });
    expect(gone.detail).toContain('UNOWNED');
    expect(gone.detail).toContain('CONFIRMED GONE');
  });

  it('renders ownership as null (and identically to before) when no owner was resolved', () => {
    const body = JSON.parse(gateStallEscalationBody({ installSlug: 'x', consecutiveReds: 3, heldHrs: null, nowMs: 1 }));
    expect(body.ownership).toBeNull();
    expect(body.detail).not.toContain('OWNED');
    expect(body.detail).not.toContain('UNOWNED');
  });
});

describe('shouldWarnOnStallClearMiss (WI-2825: harden the silent 0-row clear no-op)', () => {
  it('warns when an escalation was believed active but the clear matched nothing', () => {
    expect(shouldWarnOnStallClearMiss(true, 0)).toBe(true);
  });

  it('stays silent on the everyday case: no prior escalation, nothing to clear', () => {
    expect(shouldWarnOnStallClearMiss(false, 0)).toBe(false);
  });

  it('stays silent when the clear genuinely matched a row (the expected happy path)', () => {
    expect(shouldWarnOnStallClearMiss(true, 1)).toBe(false);
  });

  it('stays silent for a stallAlerted=false clear that unexpectedly matched a row (nothing suspicious about a stray match)', () => {
    expect(shouldWarnOnStallClearMiss(false, 1)).toBe(false);
  });
});

describe('classifyGateStallStatus (EI-2615: skipped-locked must not fake a red streak)', () => {
  it('a real green verdict resets', () => {
    expect(classifyGateStallStatus('advanced', false)).toBe('reset');
    expect(classifyGateStallStatus('up-to-date', false)).toBe('reset');
    expect(classifyGateStallStatus('advanced-prefix', false)).toBe('reset');
  });

  it('a moved pin resets even on a non-green status (green-checkpoint-lock-starvation-2026-07-02)', () => {
    expect(classifyGateStallStatus('skipped-locked', true)).toBe('reset');
    expect(classifyGateStallStatus('not-green', true)).toBe('reset');
  });

  it('skipped-locked with NO pin movement is a no-op, not a red — the EI-2615 fix', () => {
    // Before the fix this counted as a red, so a healthy tick colliding with a
    // still-in-flight green run could clobber the eventual green reset with a
    // stale/incremented consecutiveReds — exactly the "gate shows RED ~25h after
    // main just went green" symptom EI-2615 reported. The wedge case this was also
    // trying to catch is covered separately by `fireStale` (last-fire/last-green age).
    expect(classifyGateStallStatus('skipped-locked', false)).toBe('noop');
  });

  it('EI-18757975681519069: migrations-pending is a NON-VERDICT, not a red', () => {
    // The gate aborted BEFORE running the suite because the dev PG is known to be
    // behind the candidate, so this tick said nothing about the code. Counting a
    // non-verdict toward the red streak is the identical false-increment bug
    // EI-2615 fixed for lock contention — and it would be self-reinforcing here:
    // a stale schema would inflate consecutiveReds, which escalates as a broken
    // build, sending agents after test failures that are really a missing column.
    // The genuine "migration never applies" case is covered by a backstop — but
    // NOT `fireStale`, as this comment used to say (EI-19321275470651356):
    // `fireStale` keys on last_fired_at, which a noop tick still refreshes, so it
    // reads FRESH. The detector that actually fires is `checkMainBehindStaging`
    // (>20 commits + >1h + no advance in 2h), with `verdictStale` (no green in 12h)
    // as the deep backstop — both in release/green-stall-watchdog.ts.
    expect(classifyGateStallStatus('migrations-pending', false)).toBe('noop');
    // …and a moved pin still wins, exactly as for every other status.
    expect(classifyGateStallStatus('migrations-pending', true)).toBe('reset');
  });

  it('WI-10004108: a missing configured integration branch is recorded as not-applicable without counting a stall', () => {
    expect(classifyGateStallStatus('not-applicable', false)).toBe('noop');
    expect(classifyGateStallStatus('not-applicable', true)).toBe('reset');
    expect(
      gateStallNoopLogMessage(
        'not-applicable',
        'Configured integration branch "staging" is absent',
      ),
    ).toContain('not-applicable');
  });

  it('EI-20767792192323374: infra-inconclusive is a NON-VERDICT, not a red', () => {
    // One step LATER in the run than migrations-pending: the suite really executed, but the
    // gate's own vite-node module cache was deleted underneath it mid-run, so its failures are
    // a HOST fault and say nothing about the code IN EITHER DIRECTION (measured 2026-08-18:
    // 4,789 of 5,505 files failed on candidate 1c64cd9f, and red #20 went on the streak that
    // freezes `main`). Same disposition, and same backstops: this leaves `lastGreenAt` stale on
    // purpose so checkMainBehindStaging / evaluateGreenStall still escalate a frozen `main` —
    // only the MISLABELLING stops.
    expect(classifyGateStallStatus('infra-inconclusive', false)).toBe('noop');
    // …and a moved pin still wins, exactly as for every other status.
    expect(classifyGateStallStatus('infra-inconclusive', true)).toBe('reset');
  });

  it('EI-22642378999251872: persistent disk-headroom is a counted NON-VERDICT, not a red', () => {
    expect(classifyGateStallStatus('disk-headroom', false)).toBe('no-verdict');
    expect(classifyGateStallStatus('disk-headroom', true)).toBe('reset');
  });

  // WI-39841 (Defect 2): the discriminator itself. A crash and a deadline-kill are BYTE-
  // IDENTICAL downstream — non-zero exit, no parseable marker — so the whole fix rests on
  // `RunResult.timedOut` being carried out of the timer that does the killing. If this
  // mapping ever collapses, the classifier tests below still pass while the gate never
  // produces a 'deadline-exceeded' status at all, and the fix is silently inert.
  it('WI-39841: a killed run maps to deadline-exceeded; a crash still maps to error', () => {
    expect(checkpointFallbackStatus(true)).toBe('deadline-exceeded');
    expect(checkpointFallbackStatus(false)).toBe('error');
    // Absent (an older RunResult, or a path that never set it) must degrade to the
    // pre-WI-39841 behaviour — a red — never to a free pass.
    expect(checkpointFallbackStatus(undefined)).toBe('error');
  });

  it('EI-21103236147949832: external SIGTERM/exit 143 is cancelled, while the own deadline wins', () => {
    expect(checkpointFallbackStatus(false, 143, null)).toBe('cancelled');
    expect(checkpointFallbackStatus(false, 1, 'SIGTERM')).toBe('cancelled');
    expect(checkpointFallbackStatus(true, 143, 'SIGTERM')).toBe('deadline-exceeded');
    expect(checkpointFallbackStatus(false, 1, null)).toBe('error');
  });

  it('EI-22642378999251872: exit 137 uses cgroup kill counters instead of guessing OOM from the code', () => {
    const oom = {
      killed: false,
      memoryEvents: {
        subtree: { oomKill: 1, oomGroupKill: 0 },
        local: { oomKill: 0, oomGroupKill: 0 },
      },
    };
    const notOom = {
      killed: false,
      memoryEvents: {
        subtree: { oomKill: 0, oomGroupKill: 0 },
        local: null,
      },
    };
    expect(checkpointTerminalHasOomKill(oom)).toBe(true);
    expect(checkpointTerminalHasOomKill(notOom)).toBe(false);
    expect(checkpointFallbackStatus(false, 137, null, oom)).toBe('infra-inconclusive');
    expect(checkpointFallbackStatus(false, 137, null, notOom)).toBe('cancelled');
  });

  it('WI-39841: deadline-exceeded is a NON-VERDICT, not a red', () => {
    // One phase later again, and arrived at from the opposite end: migrations-pending and
    // infra-inconclusive abort BEFORE judging, while this run was killed DURING/AFTER judging
    // and could not report. Measured 2026-08-18: the 17:15:04Z run was SIGTERM'd at its 120m
    // cap and banked red #27 carrying `failingTests:[]` / `observedCandidate:null` — a red
    // that names nothing to fix, yet drives the held-gate alarm and the release-fixer
    // dispatch. Same backstops (lastGreenAt is left stale on purpose), so a gate that keeps
    // dying at its deadline still reaches a human — as an abort naming its own cause.
    expect(classifyGateStallStatus('deadline-exceeded', false)).toBe('noop');
    // …and a moved pin still wins, exactly as for every other status.
    expect(classifyGateStallStatus('deadline-exceeded', true)).toBe('reset');
  });

  it('EI-21103236147949832: an externally cancelled run is a NON-VERDICT, not a red', () => {
    expect(classifyGateStallStatus('cancelled', false)).toBe('noop');
    expect(classifyGateStallStatus('cancelled', true)).toBe('reset');
  });

  it('WI-39944: serialized repair waits are NON-VERDICTS, not reds', () => {
    expect(classifyGateStallStatus('repair-in-progress', false)).toBe('noop');
    expect(classifyGateStallStatus('repair-staging-mismatch', false)).toBe('noop');
    expect(classifyGateStallStatus('repair-in-progress', true)).toBe('reset');
    expect(classifyGateStallStatus('repair-staging-mismatch', true)).toBe('reset');
  });

  it('every other non-green verdict still counts as a red (not-green / create-failed / etc.)', () => {
    // EI-21462211894072863 removed 'error' from this list — it is a NON-VERDICT and now has its
    // own class. The statuses left here all describe a run that reached a real conclusion about
    // the tree, which is what makes them reds.
    for (const status of ['not-green', 'create-failed', 'not-fast-forward']) {
      expect(classifyGateStallStatus(status, false)).toBe('red');
    }
  });

  /**
   * CONTROL — inherited from WI-39841's Defect 2 and STRENGTHENED, not relaxed, by
   * EI-21462211894072863.
   *
   * WI-39841 pinned `'error' === 'red'`. The property it was protecting was never "a crash is a
   * red" — it was "a genuinely CRASHING gate must not go SILENT", because 'error' is the
   * unknown-cause bucket and silence there is how `main` freezes with nobody told. That property
   * is unchanged and still guarded here.
   *
   * What changed is that the old test could only express it by conflating two claims. A tick with
   * no parseable result marker judged NO code, so calling it a red asserts a broken build on no
   * evidence — and hands the reader a failing-test list that some older run named. Measured
   * 2026-08-25: `consecutiveReds` reached 42 while the last real verdict predated the last fire by
   * 5.7h, so a WEDGED gate read as a merely-red one and agents were dispatched at tests nothing
   * had named.
   *
   * So the control now pins BOTH failure directions at once, which is stronger than the single
   * assertion it replaces:
   *   · NOT 'noop'  — the silence regression WI-39841 feared. A crash must still be counted.
   *   · NOT 'red'   — the false-verdict regression EI-21462211894072863 fixed.
   * The counting itself lives in `consecutiveNoVerdict` and escalates on the same threshold; see
   * the gate-health suite for the assertion that a crash tick leaves `consecutiveReds` alone.
   */
  it('control: a genuine CRASH is a NON-VERDICT that still counts — neither a red nor a silent noop', () => {
    expect(classifyGateStallStatus('error', false)).toBe('no-verdict');
    // The two directions this class sits between, stated explicitly so neither collapse is
    // reachable without failing here.
    expect(classifyGateStallStatus('error', false)).not.toBe('red');
    expect(classifyGateStallStatus('error', false)).not.toBe('noop');
    // Unchanged neighbour: a deadline-kill remains a true noop (a peer/backstop owns it).
    expect(classifyGateStallStatus('deadline-exceeded', false)).toBe('noop');
    // …and a moved pin still wins over everything, exactly as for every other status.
    expect(classifyGateStallStatus('error', true)).toBe('reset');
  });

  /**
   * EI-21462211894072863 — the SURFACING half. Counting a crash correctly is only half the fix;
   * a reader also has to be able to see it. 'error' must therefore be a status the abort-advice
   * table knows about, or it records a tick nobody can be advised about.
   *
   * Its kind is deliberately 'unknown': a run that died without saying why gives no evidence
   * either way about whether a re-fire hits the same wall, and gate-abort-status.ts exists
   * precisely to stop that gap being filled with a confident guess in either direction.
   */
  /**
   * FALSIFIABILITY CONTROL for the two tests above (repo convention: for a MODULE you import,
   * keep a deliberately-wrong implementation permanently in the test file rather than mutating
   * the shared tree — a mutation probe here would hold a real source file modified for the life
   * of the run, which git-sync's whole-tree sweep can commit even when nothing goes wrong).
   *
   * `preFixClassify` is the classifier AS IT BEHAVED before EI-21462211894072863: 'error' had no
   * arm of its own and fell through to 'red'. Asserting it FAILS the property the real classifier
   * satisfies is what proves that property is load-bearing rather than vacuously true.
   *
   * ⚠ The calibration loop is the half that makes this control meaningful. A stand-in that
   * diverged everywhere would fail the property for reasons unrelated to the fix, and would keep
   * "passing" this test if the real classifier were later broken in some other way. Pinning
   * agreement on the untouched statuses first is what makes the single divergence attributable.
   */
  it('CONTROL: the pre-fix classifier FAILS the property the fixed one satisfies', () => {
    const preFixClassify = (status: string): string => {
      if (status === 'advanced' || status === 'up-to-date' || status === 'advanced-prefix') return 'reset';
      if (
        [
          'skipped-locked',
          'migrations-pending',
          'infra-inconclusive',
          'disk-headroom',
          'deadline-exceeded',
          'cancelled',
          'repair-in-progress',
          'repair-staging-mismatch',
        ].includes(status)
      )
        return 'noop';
      return 'red';
    };

    // CALIBRATION — the control must agree with the real classifier everywhere the fix did not
    // touch, or the divergence below is not attributable to this change.
    for (const status of [
      'advanced',
      'up-to-date',
      'not-green',
      'create-failed',
      'not-fast-forward',
      'skipped-locked',
      'deadline-exceeded',
      'cancelled',
      'migrations-pending',
      'infra-inconclusive',
    ]) {
      expect(preFixClassify(status)).toBe(classifyGateStallStatus(status, false));
    }

    // …and diverges at EXACTLY the defect: the old code called a verdict-less tick a red.
    expect(preFixClassify('error')).toBe('red');
    expect(classifyGateStallStatus('error', false)).toBe('no-verdict');
  });

  it('EI-21462211894072863: a crash is a RECORDED abort, classified transient (nothing latched)', () => {
    expect(isRecordedInconclusiveStatus('error')).toBe(true);
    /**
     * 'transient' matches `infra-inconclusive`, whose operator message states outright that its
     * mechanism is unclassified. What makes an abort transient here is not that the cause is
     * KNOWN — a crash's cause is unrecorded by definition — but that nothing is LATCHED, which is
     * what separates it from `migrations-pending`, where a named blocker really does persist.
     *
     * ⚠ 'unknown' is the tempting answer and is the one value forbidden: it is the DEFAULTED
     * sentinel, and gate-abort-status.test.ts enumerates the recorded set against it precisely so
     * a status cannot inherit advice instead of being routed by decision. I tried 'unknown' first
     * and that guard caught it — this assertion records the correction so it is not re-attempted.
     */
    expect(classifyGateAbort('error')).toBe('transient');
    expect(classifyGateAbort('error')).not.toBe('unknown');
    // Both halves must agree — this module exists because a lever and the sentence beside it
    // drifted twice in the same direction. Neither may claim a latch a crash does not have…
    expect(gateAbortRefireClause('error')).not.toMatch(/aborts the same way/);
    expect(gateAbortLever('error')).not.toMatch(/aborts the same way/);
    // …nor send the reader at a failing-test list this tick never produced, which is the exact
    // response the whole no-verdict split exists to prevent.
    expect(gateAbortLever('error')).toMatch(/do NOT triage/i);
  });

  describe('WI-39450: a PROVEN-STALE pass is a non-verdict, not a red', () => {
    // Measured 2026-08-17, twice: a run classified its own candidate `stale-candidate` and STILL
    // drove consecutiveReds 10 -> 11, naming 7 operator-core memory/*.test.ts files that had all
    // been modified in the 23 commits since that candidate and passed 52/0 at tip; and again
    // 13 -> 14 on candidate 67c66f70, whose 4 named files passed 156/0 at tip. Same shape as
    // EI-2615 / EI-18757975681519069: a pass that judged an already-superseded tree said nothing
    // about the code.
    //
    // `stale-candidate` comes from exactly ONE branch of green-checkpoint's triageRed — the one
    // whose detail reads "N failing file(s) PASS at tip". So it is an EVIDENCE claim, and the
    // classification alone earns the non-verdict. `autoRefire`/`refireBlockedBy` are clock-and-
    // budget facts about whether a rescue was SCHEDULED; keying the streak on them made this
    // guard dead code (autoRefire was false in 18 of 18 re-triaging runs sampled 08-15..17), and
    // the deadline-blocked shape it excluded is precisely the one that froze `main` for ~40h.

    it('stale-candidate is record-only on the CLASSIFICATION alone — no refire required', () => {
      expect(classifyGateStallStatus('not-green', false, { classification: 'stale-candidate' })).toBe('record-only');
      expect(
        classifyGateStallStatus('not-green', false, {
          classification: 'stale-candidate',
          autoRefire: true,
        }),
      ).toBe('record-only');
    });

    it('the REGRESSION shape: stale-candidate blocked by deadline is record-only, not a red', () => {
      // The live 12:36:47Z run (candidate 7a040c5c): the gate re-ran all 4 failing files at tip,
      // watched them pass, then declined to refire because a second suite would outrun the run
      // budget — and banked the red anyway. A clock is not evidence about the code.
      expect(
        classifyGateStallStatus('not-green', false, {
          classification: 'stale-candidate',
          autoRefire: false,
          refireBlockedBy: 'deadline',
        }),
      ).toBe('record-only');
    });

    it('a non-evidentiary refire blocker never makes a proven-stale pass a red', () => {
      // `cap-disabled` is a feature switch and `absolute-ceiling`'s own operator text says
      // "every individual red WAS rescued ... NOT to debug the files named above".
      for (const blockedBy of ['cap-disabled', 'absolute-ceiling', 'deadline'] as const) {
        expect(
          classifyGateStallStatus('not-green', false, {
            classification: 'stale-candidate',
            autoRefire: false,
            refireBlockedBy: blockedBy,
          }),
        ).toBe('record-only');
      }
    });

    it('is NOT classified noop — noop would delete the diagnostics EI-13288 persists', () => {
      // The distinction is load-bearing, not cosmetic: trackGateStall's 'noop' branch returns
      // early and leaves gate_health entirely untouched, which would drop the
      // retriageClassification EI-13288 deliberately writes for exactly this case.
      expect(
        classifyGateStallStatus('not-green', false, {
          classification: 'stale-candidate',
          refireBlockedBy: 'deadline',
        }),
      ).not.toBe('noop');
    });

    // The guards below are the whole safety argument. Get any wrong and this silences a real red.

    it('charged-budget is the ONE preserved red — the same breakage survived every rescue', () => {
      // green-checkpoint.ts:2609-2611 calls this the loop guard "that must survive: it is what
      // converges a genuinely-broken tip to a held gate and a human". Unlike the other three
      // blockers, it is evidentiary — it reports that the rescue itself kept failing.
      expect(
        classifyGateStallStatus('not-green', false, {
          classification: 'stale-candidate',
          autoRefire: false,
          refireBlockedBy: 'charged-budget',
        }),
      ).toBe('red');
    });

    it('a REAL red still counts, refire or not — only a STALE candidate is a non-verdict', () => {
      for (const classification of ['real-red', 'unknown'] as const) {
        expect(classifyGateStallStatus('not-green', false, { classification, autoRefire: true })).toBe('red');
        expect(classifyGateStallStatus('not-green', false, { classification })).toBe('red');
      }
    });

    it('no retriage at all is unchanged — a plain not-green is still a red', () => {
      expect(classifyGateStallStatus('not-green', false, undefined)).toBe('red');
      expect(classifyGateStallStatus('not-green', false, null)).toBe('red');
      expect(classifyGateStallStatus('not-green', false, {})).toBe('red');
    });

    it('a green verdict still resets even if a refire was in play (green wins first)', () => {
      expect(
        classifyGateStallStatus('advanced', false, {
          classification: 'stale-candidate',
          autoRefire: true,
        }),
      ).toBe('reset');
    });
  });
});

describe('EI-210830: serialized repair holds are visible without incrementing the red streak', () => {
  it.each(['repair-in-progress', 'repair-staging-mismatch'])(
    'records %s under gate_health.inconclusive only',
    async (status) => {
      fakeSql.unsafe.mockClear();

      await trackGateStall(
        { workspaceId: 'ws-42', installSlug: 'my-harness' },
        status,
        'abc123def456789',
        [],
        '28a3a3d50258',
        undefined,
        `${status} detail`,
      );

      const update = fakeSql.unsafe.mock.calls.find(([query]) =>
        String(query).includes("'{gate_health,inconclusive}'"),
      );
      expect(update).toBeDefined();
      const payload = JSON.parse(String((update![1] as unknown[])[1]));
      expect(payload).toMatchObject({
        status,
        candidate: 'abc123def456',
        detail: `${status} detail`,
      });
      expect(fakeSql.unsafe.mock.calls.some(([query]) => String(query).includes("'{gate_health}'"))).toBe(false);
    },
  );

  it('EI-21393982931638628: trackGateStall threads the measured infra cause to both log and metadata', async () => {
    fakeSql.unsafe.mockClear();
    const detail = 'pc-heavy --exclusive-all-slots refused materialization after 900s; live holders: 1990073, 3015730';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await trackGateStall(
        { workspaceId: 'ws-42', installSlug: 'my-harness' },
        'infra-inconclusive',
        'abc123def456789',
        [],
        '28a3a3d50258',
        undefined,
        detail,
      );

      expect(log).toHaveBeenCalledWith(expect.stringContaining(detail));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('runner admission/materialisation'));
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining('module cache disappeared'));

      const update = fakeSql.unsafe.mock.calls.find(([query]) =>
        String(query).includes("'{gate_health,inconclusive}'"),
      );
      expect(update).toBeDefined();
      expect(JSON.parse(String((update![1] as unknown[])[1]))).toMatchObject({
        status: 'infra-inconclusive',
        candidate: 'abc123def456',
        detail,
      });
    } finally {
      log.mockRestore();
    }
  });

  it('persists a canonical candidate snapshot on a no-verdict abort with valid nested jsonb_set SQL', async () => {
    fakeSql.unsafe.mockClear();
    const candidate = 'a'.repeat(40);
    await trackGateStall(
      { workspaceId: 'ws-42', installSlug: 'my-harness' },
      'error',
      candidate,
      ['lib/red.test.ts'],
      'b'.repeat(40),
      undefined,
      'crashed before publishing a verdict',
    );

    const update = fakeSql.unsafe.mock.calls.find(([query]) =>
      String(query).includes("'{gate_health,candidateSnapshot}'"),
    );
    expect(update).toBeDefined();
    const query = String(update![0]);
    expectBalancedNestedJsonbSet(query, 3);
    expect(query).toMatch(
      /'\{gate_health,candidateSnapshot\}'\s*,\s*\$3::jsonb\s*,\s*true\s*\)\s*,\s*updated_at\s*=\s*now\(\)/,
    );
    const snapshot = JSON.parse(String((update![1] as unknown[])[2])) as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      candidate,
      failureSignature: 'lib/red.test.ts',
      failingTests: ['lib/red.test.ts'],
      failingTestsMeasured: false,
    });
  });

  /**
   * WI-10000844: the tick-legs branch of the same write carried FIVE nested jsonb_set layers
   * but opened only FOUR calls, so its `'{gate_health,candidateSnapshot}', $6::jsonb, true)`
   * tail dangled outside any call. Postgres rejected it (`syntax error at or near
   * "'{gate_health,candidateSnapshot}'"`) on every repair tick for four days: the snapshot,
   * repairTickLegs and refreshed failingTests were never persisted, the next fire found "no
   * fresh candidate snapshot", skipped fixer dispatch, and the gate treadmilled with no
   * verdict. A substring regex cannot see that shape — count the structure instead.
   */
  function expectBalancedNestedJsonbSet(query: string, layers: number): void {
    const opens = (query.match(/\(/g) ?? []).length;
    const closes = (query.match(/\)/g) ?? []).length;
    expect(closes, `unbalanced parentheses: ${opens} open vs ${closes} close`).toBe(opens);
    const calls = (query.match(/jsonb_set\(/g) ?? []).length;
    const paths = (query.match(/'\{gate_health,[A-Za-z]+\}'/g) ?? []).length;
    expect(calls, 'one jsonb_set( per layer').toBe(layers);
    expect(paths, 'one gate_health path literal per layer').toBe(layers);
    // Every layer opens BEFORE the innermost COALESCE(metadata …) — a layer opened later
    // (or never) is the dangling-tail shape Postgres refuses.
    expect(query).toMatch(new RegExp(`SET metadata = ${'jsonb_set\\(\\s*'.repeat(layers)}COALESCE\\(metadata`));
  }

  it('WI-10000844: the repair-tick (tick-legs) snapshot write is balanced five-layer nested jsonb_set SQL', async () => {
    fakeSql.unsafe.mockClear();
    const candidate = 'a'.repeat(40);
    await trackGateStall(
      { workspaceId: 'ws-42', installSlug: 'my-harness' },
      'repair-in-progress',
      candidate,
      ['lib/red.test.ts'],
      'b'.repeat(40),
      undefined,
      'the serialized frozen-candidate repair queue owns this candidate',
      undefined,
      {
        repairTickLegs: {
          head: 'd'.repeat(40),
          atMs: 5,
          ok: false,
          failingSignatures: ['lint:tsc'],
          legs: [{ id: 'lint:tsc', status: 'fail', durationMs: 7, outputTail: 'x' }],
        },
      },
    );

    const update = fakeSql.unsafe.mock.calls.find(([query]) =>
      String(query).includes("'{gate_health,repairTickLegs}'"),
    );
    expect(update).toBeDefined();
    const query = String(update![0]);
    expectBalancedNestedJsonbSet(query, 5);
    expect(query).toMatch(
      /'\{gate_health,candidateSnapshot\}'\s*,\s*\$6::jsonb\s*,\s*true\s*\)\s*,\s*updated_at\s*=\s*now\(\)/,
    );
    const params = update![1] as unknown[];
    expect(params).toHaveLength(7);
    expect(JSON.parse(String(params[2]))).toMatchObject({ head: 'd'.repeat(12), ok: false, failingSignatures: ['lint:tsc'] });
    expect(JSON.parse(String(params[5]))).toMatchObject({ schemaVersion: 1, candidate, failingTestsMeasured: true });
  });
});

describe('P-002 (gate-verdict-liveness): a recorded TRANSIENT abort requeues promptly, never waits out the cron hour', () => {
  const requeueCall = () =>
    fakeSql.unsafe.mock.calls.find(([query]) => String(query).includes('next_fire_at = now() + make_interval'));

  it.each(['error', 'cancelled', 'deadline-exceeded', 'infra-inconclusive'])(
    'a transient abort (%s) pulls next_fire_at forward by TRANSIENT_ABORT_REQUEUE_MINS',
    async (status) => {
      fakeSql.unsafe.mockClear();
      await trackGateStall(
        { workspaceId: 'ws-42', installSlug: 'my-harness' },
        status,
        'abc123def456789',
        [],
        '28a3a3d50258',
        undefined,
        `${status} detail`,
      );
      const update = requeueCall();
      expect(update).toBeDefined();
      expect(update![1]).toEqual(['my-harness', TRANSIENT_ABORT_REQUEUE_MINS]);
      const query = String(update![0]);
      // The three load-bearing guards: forward-only, pause-aware, active-only. Losing any one
      // regresses to delaying a sooner fire / fighting P-004's pause TTL / requeueing a dead row.
      expect(query).toContain("metadata->'pause' IS NULL");
      expect(query).toContain('active = true');
      expect(query).toContain('next_fire_at IS NULL OR next_fire_at > now() + make_interval');
    },
  );

  it.each(['migrations-pending', 'repair-staging-mismatch', 'dependency-prewarm-missing', 'dependency-generation-unusable'])(
    'a STANDING-condition abort (%s) does NOT requeue — the condition persists until its producer clears it',
    async (status) => {
      fakeSql.unsafe.mockClear();
      await trackGateStall(
        { workspaceId: 'ws-42', installSlug: 'my-harness' },
        status,
        'abc123def456789',
        [],
        '28a3a3d50258',
        undefined,
        `${status} detail`,
      );
      expect(requeueCall()).toBeUndefined();
    },
  );

  it('a peer-owned hold (repair-in-progress) does NOT requeue — the repair owns progress', async () => {
    fakeSql.unsafe.mockClear();
    await trackGateStall(
      { workspaceId: 'ws-42', installSlug: 'my-harness' },
      'repair-in-progress',
      'abc123def456789',
      [],
      '28a3a3d50258',
      undefined,
      'repair detail',
    );
    expect(requeueCall()).toBeUndefined();
  });

  it('a requeue failure is fail-safe: warns and degrades to the hourly cron, never throws', async () => {
    fakeSql.unsafe.mockClear();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      fakeSql.unsafe.mockImplementation(async (query: unknown) => {
        if (String(query).includes('next_fire_at = now() + make_interval')) throw new Error('pg down');
        return Object.assign([] as unknown[], { count: 0 });
      });
      await expect(
        trackGateStall(
          { workspaceId: 'ws-42', installSlug: 'my-harness' },
          'cancelled',
          'abc123def456789',
          [],
          '28a3a3d50258',
          undefined,
          'killed externally',
        ),
      ).resolves.not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('transient-abort prompt requeue failed'));
    } finally {
      warn.mockRestore();
      fakeSql.unsafe.mockImplementation(async (..._a: unknown[]) => Object.assign([] as unknown[], { count: 0 }));
    }
  });
});

describe('gateStallNoopLogMessage (EI-19321275470651356: one class, two opposite operator advices)', () => {
  // These statuses all classify as 'noop', so none moves the red-streak counters. Some also
  // publish a path-scoped gate_health.inconclusive observation. What differs is what the READER
  // should do next, and the single shared message used to give the wrong answer for one of them.

  it('skipped-locked keeps the peer-lock wording — a peer run IS in flight', () => {
    const msg = gateStallNoopLogMessage('skipped-locked');
    expect(msg).toContain('an active peer run holds the lock');
    expect(msg).toContain('skipped-locked');
  });

  it('WI-39450: a proven-stale pass gets its OWN wording — not the peer-lock one', () => {
    // No peer run holds the lock here, so that wording is factually false. It must also say the
    // failing files it named are STALE — that list is exactly what sends agents at already-fixed
    // tests — and that the streak did not move, which a reader would otherwise have to infer.
    const msg = gateStallRecordOnlyLogMessage('not-green');
    expect(msg).not.toContain('an active peer run holds the lock');
    expect(msg).toContain('STALE');
    expect(msg).toContain('streak NOT');
  });

  it('does NOT promise a refire that may never come — the deadline-blocked case records nothing', () => {
    // The original wording said this pass "handed off to an auto-refire, which will record the
    // real verdict". That is false whenever the refire was blocked (`deadline` in the live
    // 12:36:47Z freeze), and it is the worst thing to tell a reader who is asking why `main` is
    // stuck: it says WAIT for a verdict that is not coming. Instead the message must point at
    // the detectors that really do cover a frozen `main`.
    const msg = gateStallRecordOnlyLogMessage('not-green');
    expect(msg).not.toContain('which will record the real verdict');
    expect(msg).toContain('checkMainBehindStaging');
  });

  it('migrations-pending must NOT claim a peer run holds the lock — nobody is coming', () => {
    // The regression: this message is one of the first things read when `main` stops
    // advancing. "an active peer run holds the lock" tells the reader to WAIT, which is
    // correct for a lock collision and actively wrong here — the run aborted at the
    // migration preflight and no verdict is coming until the migration applies.
    const msg = gateStallNoopLogMessage('migrations-pending');
    expect(msg).not.toContain('an active peer run holds the lock');
    expect(msg).toContain('migration preflight');
    expect(msg).toContain('NO peer run is in flight');
  });

  it('EI-210512: disk-headroom names the real unblock and never claims a peer lock', () => {
    const msg = gateStallNoopLogMessage('disk-headroom');
    expect(msg).not.toContain('an active peer run holds the lock');
    expect(msg).toContain('before checkout setup or tests');
    expect(msg).toContain('do not re-fire until space is reclaimed');
    expect(msg).toContain('No peer run is in flight');
    expect(msg).toContain('consecutiveNoVerdict');
    expect(msg).toContain('WEDGED');
  });

  it('EI-23424266636870803: disk-headroom never calls it "the temp filesystem"', () => {
    // That wording routes the responder into emptying /tmp. The breaching path is only
    // where the shortage was SAMPLED — free space belongs to the filesystem behind it,
    // which other mounts can share (here /tmp, /mnt/data and /var/lib/systemd/coredump
    // are one 7.3 TiB device, of which /tmp holds ~104 GiB). Clearing /tmp destroys
    // peers' preserved artifacts to reach a target ~24 GiB reclaimed anywhere on the
    // device already satisfies, and the message is what makes that the obvious move.
    const msg = gateStallNoopLogMessage('disk-headroom');
    expect(msg).not.toContain('temp filesystem');
    expect(msg).toContain('a watched filesystem');
    expect(msg).toMatch(/anywhere\s+on that filesystem/);
    expect(msg).toContain('SAMPLED');
  });

  it('names the detector that DOES cover the freeze, so the reader is not left thinking nothing watches it', () => {
    // Leaving gate_health untouched reads like "unmonitored" unless the message says
    // otherwise; the freeze is caught by checkMainBehindStaging, not by this counter.
    expect(gateStallNoopLogMessage('migrations-pending')).toContain('checkMainBehindStaging');
  });

  it('EI-21393982931638628: pc-heavy refusal reports measured admission failure, never the old cache incident', () => {
    // Nobody holds a lock (so "wait, it resolves itself" is wrong) and no migration is pending
    // (so pointing at the migration list is wrong). The load-bearing instruction is the one no
    // other noop message needs: the files this run failed are INNOCENT and must not be triaged.
    // Without it a reader does exactly what the incident produced — agents sent at ~4,800 files
    // that were never broken.
    const detail = 'pc-heavy --exclusive-all-slots refused materialization after 900s; live holders: 1990073, 3015730';
    const msg = gateStallNoopLogMessage('infra-inconclusive', detail);
    expect(msg).not.toContain('an active peer run holds the lock');
    expect(msg).not.toContain('migration preflight');
    expect(msg).not.toContain('module cache disappeared');
    expect(msg).toContain('runner admission/materialisation');
    expect(msg).toContain(detail);
    expect(msg).toContain('DO NOT TRIAGE');
    expect(msg).toContain('No peer green-checkpoint run is in flight');
    // Same "something still watches the freeze" guarantee the other two carry.
    expect(msg).toContain('checkMainBehindStaging');
  });

  it('EI-20767792192323374: a measured vite-node cache loss keeps its specific host-fault narration', () => {
    const detail = 'ERR_MODULE_NOT_FOUND: vite-node module cache was deleted mid-run';
    const msg = gateStallNoopLogMessage('infra-inconclusive', detail);

    expect(msg).toContain('vite-node module cache disappeared');
    expect(msg).toContain(detail);
    expect(msg).not.toContain('pc-heavy capacity');
    expect(msg).toContain('DO NOT TRIAGE');
  });

  it('WI-41252 / D-066: dependency snapshot drift names the pre-suite phase and suppresses historical blame', () => {
    const detail =
      'dependency-generation.sh exited 75: live node_modules changed during generation build; refusing a torn snapshot';
    const msg = gateStallNoopLogMessage('infra-inconclusive', detail);

    expect(msg).toContain('pinning its immutable dependency snapshot');
    expect(msg).toContain('refused the torn generation before any suite verdict');
    expect(msg).toContain(detail);
    expect(msg).toContain('DO NOT TRIAGE');
    expect(msg).not.toContain('pc-heavy capacity');
    expect(msg).not.toContain('module cache disappeared');
    expect(msg).not.toContain('mechanism is unclassified');
  });

  it('EI-21393982931638628: missing or unfamiliar detail stays unclassified instead of inventing a mechanism', () => {
    const missing = gateStallNoopLogMessage('infra-inconclusive');
    const unfamiliar = gateStallNoopLogMessage('infra-inconclusive', 'child exited before publishing diagnostics');

    for (const msg of [missing, unfamiliar]) {
      expect(msg).toContain('mechanism is unclassified');
      expect(msg).toContain('no vite-cache or capacity cause is inferred');
      expect(msg).not.toContain('module cache disappeared');
      expect(msg).not.toContain('pc-heavy capacity and aborted');
    }
    expect(unfamiliar).toContain('child exited before publishing diagnostics');
  });

  it('EI-20767792192323374: the three noop wordings are mutually distinct', () => {
    // The regression this whole describe exists to prevent is a SHARED message across
    // conditions whose correct operator response differs. Assert the property directly rather
    // than only per-message, so a future fourth condition cannot quietly reuse an existing arm.
    const msgs = ['skipped-locked', 'migrations-pending', 'infra-inconclusive'].map((s) => gateStallNoopLogMessage(s));
    expect(new Set(msgs).size).toBe(3);
  });

  it('WI-39944: repair no-ops name their serialized wait instead of claiming a peer gate run', () => {
    const inProgress = gateStallNoopLogMessage('repair-in-progress');
    const stagingMismatch = gateStallNoopLogMessage('repair-staging-mismatch');

    expect(inProgress).toContain('serialized frozen-candidate repair queue');
    expect(inProgress).toContain('ran no suite');
    expect(inProgress).toContain('gate_health.inconclusive');
    expect(inProgress).not.toContain('an active peer run holds the lock');
    expect(stagingMismatch).toContain('not yet observable on canonical staging');
    expect(stagingMismatch).toContain('spent no suite');
    expect(stagingMismatch).toContain('gate_health.inconclusive');
    expect(stagingMismatch).not.toContain('an active peer run holds the lock');
    expect(inProgress).not.toBe(stagingMismatch);
  });

  it('an unknown noop-class status falls back to the peer-lock wording rather than throwing', () => {
    expect(gateStallNoopLogMessage('some-future-status')).toContain('some-future-status');
  });
});

/** Must match DEPLOY_PLAN_MARKER in deploy-cli.ts / release-actions.ts (P-008). */
const DEPLOY_PLAN_MARKER = '__DEPLOY_PLAN__';

/**
 * A spawn() fake: returns a child whose stdout emits `stdout`, then closes with
 * `code`. The release-actions runScript subscribes to stdout/stderr 'data' and the
 * 'close' event; emit on the next tick so the subscriptions are in place first.
 */
function fakeSpawn(
  stdout: string,
  code = 0,
): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', code);
  });
  return child;
}

const ctx: SystemActionCtx = {
  installSlug: 'my-harness',
  workspaceId: 'ws-42',
  triggerConfig: {},
  payloadTemplate: null,
};

function planJson(noop: boolean, targetSha = 'deadbeef'): string {
  // shape: { mode, config, plan } — release-trigger reads the plan through
  // shouldAutoServe (forward-only). noop:false here models a REAL forward
  // fast-forward (release behind green main with new commits); noop:true models
  // the checkout already at green main.
  const plan: AutoServePlan = noop
    ? { targetSha, currentReleaseSha: targetSha, isFastForward: true, commits: [], noop: true }
    : { targetSha, currentReleaseSha: 'cafef00d', isFastForward: true, commits: ['c1', 'c2'], noop: false };
  // The CLI prints the pretty block AND the P-008 marker line; release-trigger parses the
  // marker. Emit both so the fake mirrors the real deploy-cli output.
  return (
    JSON.stringify({ mode: 'plan', config: { releaseRef: 'main' }, plan }, null, 2) +
    `\n${DEPLOY_PLAN_MARKER} ${JSON.stringify({ mode: 'plan', plan })}\n`
  );
}

/** A plan in the redeploy-storm shape: the detached release checkout sits AHEAD
 *  of green main — SHAs differ (noop:false) but there are ZERO new commits and
 *  it is not a fast-forward. The forward-only gate must NOT deploy this. */
function aheadOfMainPlanJson(): string {
  const plan: AutoServePlan = {
    targetSha: 'deadbeef',
    currentReleaseSha: 'ahead123', // a git-sync auto-commit ahead of main
    isFastForward: false,
    commits: [],
    noop: false,
  };
  return (
    JSON.stringify({ mode: 'plan', config: { releaseRef: 'main' }, plan }, null, 2) +
    `\n${DEPLOY_PLAN_MARKER} ${JSON.stringify({ mode: 'plan', plan })}\n`
  );
}

// EI-8397: the scope-isolation tests below exercise runScript's DEFAULT root
// resolution (integrationRoot() in release-actions.ts), which falls back to
// `path.resolve(process.cwd(), '..', '..')` when PAPERCUSP_INTEGRATION_ROOT is
// unset — an ambient-cwd-dependent path that only happens to land on the repo
// root (where node_modules/.bin/tsx actually exists) when vitest is invoked
// with cwd 2 levels below the repo root (e.g. from packages/operator-core, as
// `npm run test:affected` does per-workspace). Invoking vitest directly from
// the repo root itself (cwd = repo root) instead resolves 2 levels ABOVE the
// repo — landing outside it entirely ("missing_tsx at /home/…") — a real,
// repeatable false-red (the watchdog's 3x-in-6h signal), not a code defect.
// Fix the TEST, not the ambient-cwd-dependent resolution: pin
// PAPERCUSP_INTEGRATION_ROOT explicitly to the real repo root, computed from
// THIS file's own location (import.meta.url), independent of process.cwd().
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

// EI-20981232855780375 follow-up: the `pipeline` stamped on gate-verdict events is the
// SANITIZED BASENAME of REPO_ROOT (pipeline-name.ts), so it is whatever this checkout
// happens to be called. Hardcoding the literal 'papercusp' asserts the directory name of
// ONE checkout, not the behaviour: it passes in the staging tree (basename `papercusp`)
// and can NEVER pass in the green-checkpoint's own tree (`papercusp-checkpoint`) or in a
// gate repair worktree (`green-candidate-…`). That is a test that reds the gate forever
// while looking green to every developer who runs it locally — measured: the two
// checkpoint runs after this test landed both failed here with
// `green-checkpoint:red:papercusp-checkpoint`.
//
// Derive the expectation from the SAME input the emitter uses. The structural claim the
// test exists for — a bare key PLUS a `<key>:<pipeline>` sibling, with `pipeline` stamped
// consistently across key, summary and payload — is asserted exactly as before, and is now
// checked wherever the suite runs rather than only in a directory literally named
// `papercusp`.
const EXPECTED_PIPELINE = pipelineName(REPO_ROOT);
const ORIGINAL_CHECKPOINT_LOG_DIR = process.env.PAPERCUSP_CHECKPOINT_LOG_DIR;
let ACTION_CHECKPOINT_LOG_DIR = '';

beforeAll(() => {
  process.env.PAPERCUSP_INTEGRATION_ROOT = REPO_ROOT;
  ACTION_CHECKPOINT_LOG_DIR = mkdtempSync(join(tmpdir(), 'papercusp-release-actions-test-logs-'));
  process.env.PAPERCUSP_CHECKPOINT_LOG_DIR = ACTION_CHECKPOINT_LOG_DIR;
});

afterAll(() => {
  delete process.env.PAPERCUSP_INTEGRATION_ROOT;
  if (ORIGINAL_CHECKPOINT_LOG_DIR === undefined) delete process.env.PAPERCUSP_CHECKPOINT_LOG_DIR;
  else process.env.PAPERCUSP_CHECKPOINT_LOG_DIR = ORIGINAL_CHECKPOINT_LOG_DIR;
  rmSync(ACTION_CHECKPOINT_LOG_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  spawnMock.mockReset();
  appendPipelineEvent.mockClear();
  emitAwaitedEvent.mockClear();
  fakeSql.unsafe.mockClear();
  recordStoredQualificationVerdict.mockClear();
  recordStoredQualificationVerdict.mockResolvedValue({ status: 'missing' });
  recordStoredQualificationScheduledTerminalRecovery.mockReset();
  recordStoredQualificationScheduledTerminalRecovery.mockResolvedValue({ status: 'missing' });
  readStoredQualification.mockClear();
  readStoredQualification.mockResolvedValue({ status: 'none' });
  beginStoredQualification.mockReset();
  beginStoredQualification.mockResolvedValue({
    status: 'updated', transaction: { attemptId: 'scheduled-attempt', phase: 'ready', currentPhysicalRunner: null, outcome: { kind: 'pending' } },
  });
  recordStoredQualificationScheduledFire.mockReset();
  recordStoredQualificationScheduledFire.mockResolvedValue({
    status: 'updated', transaction: { attemptId: 'scheduled-attempt', phase: 'ready', currentPhysicalRunner: null, outcome: { kind: 'pending' } },
  });
  reserveStoredQualificationRunner.mockReset();
  reserveStoredQualificationRunner.mockResolvedValue({ status: 'updated' });
  probeRunnerLiveness.mockReset();
  probeRunnerLiveness.mockReturnValue('unknown');
  // EI-21363817573800034: admission defaults to CLEAR for every test, so the guard is invisible
  // to the ~136 cases that predate it. Reset globally (not just in the admission describe): a
  // held/unknown value leaking forward silently stops the suite from spawning, which surfaces as
  // a dozen unrelated "expected spawn to be called" failures rather than as a mock-hygiene bug.
  qualificationAdmission.mockReset();
  qualificationAdmission.mockResolvedValue({ status: 'clear' });
  memoryAdmissionOverride.value = null;
  runLockOverride.value = null;
  readLiveReleaseCertification.mockReset();
  readLiveReleaseCertification.mockImplementation(async (targetSha: string) => ({
    status: 'certified',
    targetSha,
    certified: true,
    reason: 'exact source certified',
    bankPath: '/tmp/verdicts.jsonl',
    evidence: null,
    invalidLines: 0,
  }));
});

describe('register-system-actions — registry population', () => {
  it('registers BOTH green-checkpoint and release-trigger', () => {
    const names = listSystemActions();
    expect(names).toContain('green-checkpoint');
    expect(names).toContain('release-trigger');
    expect(getSystemAction('green-checkpoint')).toBeTypeOf('function');
    expect(getSystemAction('release-trigger')).toBeTypeOf('function');
  });

  // P-008 of frozen-candidate-compliance-enforcement-2026-08-30. The sweep is only a
  // STANDING mechanism (D-001: not an opt-in diagnostic) if register-system-actions
  // actually pulls it in. Importing the action module here proves it registers; it does
  // NOT prove production runs it, so the source of register-system-actions is asserted
  // too — deleting that one side-effect import is otherwise invisible to every test.
  it('registers frozen-candidate-drift-sweep, and register-system-actions imports it', () => {
    expect(listSystemActions()).toContain('frozen-candidate-drift-sweep');
    expect(getSystemAction('frozen-candidate-drift-sweep')).toBeTypeOf('function');

    // Subject path is overridable so falsifiability can be proven against a COPY
    // outside the tree (mutation-probe tier 2) instead of mutating this shared checkout.
    const registrarPath: string | URL =
      process.env.PROBE_REGISTRAR_PATH ?? new URL('./register-system-actions.ts', import.meta.url);
    const registrar = readFileSync(registrarPath, 'utf8');
    // positive control: the registrar must still be the real file that pulls in a
    // known-registered sibling, so a gutted/renamed registrar cannot pass vacuously.
    expect(registrar).toContain("import './release-actions'");
    expect(registrar).toContain("import './frozen-candidate-drift-sweep-action'");
  });
});

describe('releaseToolingStatus — packaged sidecar guard', () => {
  it('rejects a packaged .app Contents root that has no dev tsx binary', () => {
    const root = '/Applications/Papercusp Server.app/Contents';
    const script = 'apps/operator/lib/release/green-checkpoint.ts';
    const exists = (p: string) => p.endsWith(script);

    expect(releaseToolingStatus(root, script, exists)).toEqual({
      ok: false,
      reason: 'missing_tsx',
      root,
      tsx: `${root}/node_modules/.bin/tsx`,
      script: `${root}/${script}`,
    });
  });
});

describe('release-trigger — noop gating + detached auto-deploy', () => {
  it('skips without spawning when the packaged host has no release tooling', async () => {
    const oldRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;
    process.env.PAPERCUSP_INTEGRATION_ROOT = '/Applications/Papercusp Server.app/Contents';
    const action = getSystemAction('release-trigger')!;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await action(ctx);
    } finally {
      if (oldRoot == null) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
      else process.env.PAPERCUSP_INTEGRATION_ROOT = oldRoot;
      warn.mockRestore();
    }

    expect(spawnMock).not.toHaveBeenCalled();
    expect(appendPipelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        installSlug: 'my-harness',
        kind: 'deploy',
        status: 'skipped-no-tooling',
        detail: expect.objectContaining({ reason: 'missing_tsx' }),
      }),
    );
  });

  it('does NOT deploy when the deploy plan is noop:true', async () => {
    spawnMock.mockImplementation(() => fakeSpawn(planJson(true), 0));
    const action = getSystemAction('release-trigger')!;

    await action(ctx);

    // the plan was gathered (one spawn for deploy-cli) but --execute never ran
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(appendPipelineEvent).not.toHaveBeenCalled();
  });

  it('does NOT deploy when the release checkout is AHEAD of main (0 new commits) — the redeploy-storm regression', async () => {
    // The 2026-06-07 storm: noop:false (SHAs differ) but commits:[] + not-FF, so
    // deploying would revert the checkout backward and git-sync re-advances it →
    // an infinite redeploy loop that hard-restarts :3070. Forward-only gate skips it.
    spawnMock.mockImplementation(() => fakeSpawn(aheadOfMainPlanJson(), 0));
    const action = getSystemAction('release-trigger')!;

    await action(ctx);

    // plan gathered (1 spawn) but --execute / systemd-run NEVER ran (no 2nd spawn)
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(appendPipelineEvent).not.toHaveBeenCalled();
  });

  it('does NOT deploy when the deploy plan stdout is unparseable (safe skip)', async () => {
    spawnMock.mockImplementation(() => fakeSpawn('not json at all — gibberish', 0));
    const action = getSystemAction('release-trigger')!;
    // the safe-skip path logs a warn — expected; mock it out and assert it fired
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(appendPipelineEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not parse deploy plan'));
    warn.mockRestore();
  });

  it('launches the deploy as a DETACHED systemd-run unit when the plan is noop:false', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeSpawn(planJson(false), 0)) // plan gather (tsx)
      .mockImplementationOnce(() => fakeSpawn('', 0)); // systemd-run launch
    const action = getSystemAction('release-trigger')!;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await action(ctx);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    // The second spawn must be the DETACHED transient unit (the deploy restarts
    // this host — a child deploy-cli dies at its own restart step), not a
    // direct tsx child.
    const [cmd, args] = spawnMock.mock.calls[1] as [string, string[]];
    expect(cmd).toBe('systemd-run');
    expect(args).toContain('--user');
    expect(args).toContain('--unit=papercup-auto-deploy');
    const sh = args[args.length - 1];
    expect(sh).toContain('deploy-cli.ts --execute');
    expect(sh).toContain('PAPERCUSP_ALLOW_DEV_RESTART=1');
    expect(sh).toContain('/tmp/papercup-auto-deploy.terminal.json');
    expect(sh).toContain('trap _papercusp_write_deploy_terminal EXIT');

    // The deploy outcome event is recorded by deploy.ts (the surviving
    // process), never by this routine.
    expect(appendPipelineEvent).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('P-010: launches exact-pin live certification instead of deploying an uncertified green', async () => {
    readLiveReleaseCertification.mockImplementation(async (targetSha: string) => ({
      status: 'missing',
      targetSha,
      certified: false,
      reason: 'no exact-source verdict',
      bankPath: '/tmp/verdicts.jsonl',
      evidence: null,
      invalidLines: 0,
    }));
    spawnMock
      .mockImplementationOnce(() => fakeSpawn(planJson(false, 'a'.repeat(40)), 0))
      .mockImplementationOnce(() => fakeSpawn('', 0));
    const action = getSystemAction('release-trigger')!;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const [cmd, args] = spawnMock.mock.calls[1] as [string, string[]];
    expect(cmd).toBe('systemd-run');
    expect(args).toContain('--unit=papercup-live-release-certification');
    const shell = args.at(-1)!;
    expect(shell).toContain('setup-release-checkout.sh');
    expect(shell).toContain('GATE_CERTIFICATION_TARGET_SHA');
    expect(shell).toContain('live-federation-gate.sh');
    expect(shell).not.toContain('deploy-cli.ts --execute');
    expect(appendPipelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'deploy', status: 'certification-launched' }),
    );
    warn.mockRestore();
  });

  it('P-010: does not auto-rerun a current exact-source live RED', async () => {
    readLiveReleaseCertification.mockImplementation(async (targetSha: string) => ({
      status: 'failed',
      targetSha,
      certified: false,
      reason: 'exact-source live verdict is RED',
      bankPath: '/tmp/verdicts.jsonl',
      evidence: null,
      invalidLines: 0,
    }));
    spawnMock.mockImplementationOnce(() => fakeSpawn(planJson(false), 0));
    const action = getSystemAction('release-trigger')!;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(appendPipelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'deploy', status: 'certification-failed' }),
    );
    warn.mockRestore();
  });

  it('warns (does not throw) when the detached unit cannot launch — e.g. a deploy already running', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeSpawn(planJson(false), 0))
      .mockImplementationOnce(() => fakeSpawn('', 1)); // systemd-run refuses (unit exists)
    const action = getSystemAction('release-trigger')!;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await action(ctx);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('deploy already running'));
    expect(appendPipelineEvent).not.toHaveBeenCalled();
    warn.mockRestore();
    log.mockRestore();
  });
});

describe('shouldAutoServe — forward-only auto-serve policy', () => {
  const base: AutoServePlan = {
    targetSha: 't',
    currentReleaseSha: 'r',
    isFastForward: true,
    commits: ['c1'],
    noop: false,
  };

  it('deploys a genuine forward fast-forward bringing ≥1 new commit', () => {
    expect(shouldAutoServe({ ...base, isFastForward: true, commits: ['c1', 'c2'] })).toBe(true);
  });

  it('deploys the first deploy (release checkout not set up: currentReleaseSha=null)', () => {
    expect(shouldAutoServe({ ...base, currentReleaseSha: null, commits: ['c1'] })).toBe(true);
  });

  it('SKIPS a true noop (release checkout already at green main)', () => {
    expect(shouldAutoServe({ ...base, noop: true, commits: [] })).toBe(false);
  });

  it('SKIPS when the checkout is AHEAD of main: SHAs differ, 0 commits, not a FF (the storm)', () => {
    expect(shouldAutoServe({ ...base, noop: false, isFastForward: false, commits: [] })).toBe(false);
  });

  it('SKIPS a non-fast-forward even with new commits (diverged → needs review, not auto-serve)', () => {
    expect(shouldAutoServe({ ...base, isFastForward: false, commits: ['c1'] })).toBe(false);
  });

  it('SKIPS a fast-forward that somehow carries 0 commits (nothing to apply)', () => {
    expect(shouldAutoServe({ ...base, isFastForward: true, commits: [] })).toBe(false);
  });

  it('SKIPS a malformed plan missing currentReleaseSha (conservative)', () => {
    expect(shouldAutoServe({ targetSha: 't', isFastForward: true, commits: ['c1'], noop: false })).toBe(false);
  });

  it('SKIPS a desktop-only pointer bump (papercusp-desktop gitlink only — D-003)', () => {
    // A green FF bringing ≥1 new commit that would otherwise deploy, but the only
    // changed path is the desktop submodule → must NOT bounce the :3070 operator.
    expect(shouldAutoServe({ ...base, desktopOnly: true })).toBe(false);
  });

  it('still deploys when desktopOnly is false or absent (real operator change)', () => {
    expect(shouldAutoServe({ ...base, desktopOnly: false })).toBe(true);
    expect(shouldAutoServe({ ...base })).toBe(true); // absent → not skipped
  });
});

describe('shouldBackOff — P-013 deploy-failure back-off', () => {
  const now = 1_700_000_000_000;
  // deploy events store targetSha sliced(0,12); the plan's targetSha is the full sha.
  const stored = 'deadbeefcafe';
  const full = 'deadbeefcafe1234567890abcdef000011112222';
  const evt = (status: string, targetSha: string, agoMs: number, detailAsString = false): DeployEventRow => {
    const detail = { targetSha };
    return { status, detail: detailAsString ? JSON.stringify(detail) : detail, created_at: new Date(now - agoMs) };
  };

  it('backs off a rolled-back deploy of the SAME target within the window', () => {
    expect(shouldBackOff(evt('rolled-back', stored, 5 * 60_000), full, now)).toBe(true);
  });
  it('backs off a failed deploy of the same target within the window', () => {
    expect(shouldBackOff(evt('failed', stored, 5 * 60_000), full, now)).toBe(true);
  });
  it('does NOT back off when the latest deploy SUCCEEDED', () => {
    expect(shouldBackOff(evt('ok', stored, 5 * 60_000), full, now)).toBe(false);
  });
  it('does NOT back off when there is no prior deploy event', () => {
    expect(shouldBackOff(null, full, now)).toBe(false);
  });
  it('does NOT back off a failure of a DIFFERENT target (a new green is free to deploy)', () => {
    expect(shouldBackOff(evt('rolled-back', '0000beefcafe', 5 * 60_000), full, now)).toBe(false);
  });
  it('does NOT back off once the window has elapsed (retry after cooldown)', () => {
    expect(shouldBackOff(evt('rolled-back', stored, 90 * 60_000), full, now)).toBe(false);
  });
  it('tolerates a double-encoded JSON detail string', () => {
    expect(shouldBackOff(evt('failed', stored, 5 * 60_000, true), full, now)).toBe(true);
  });
});

describe('annotateFailingTestsWithFlakeStats (EI-7443)', () => {
  function suspect(over: Partial<FlakeSuspect> & { file_path: string }): FlakeSuspect {
    return {
      file_path: over.file_path,
      fails: over.fails ?? 10,
      passes: over.passes ?? 50,
      both_status_shas: over.both_status_shas ?? 3,
      flake_rate: over.flake_rate ?? 0.167,
      last_fail: over.last_fail ?? null,
      last_pass: over.last_pass ?? null,
      reason: over.reason ?? 'flake-shaped',
    };
  }

  it('returns undefined when there are no failing tests', () => {
    expect(annotateFailingTestsWithFlakeStats(undefined, [suspect({ file_path: 'a.test.ts' })])).toBeUndefined();
    expect(annotateFailingTestsWithFlakeStats([], [suspect({ file_path: 'a.test.ts' })])).toBeUndefined();
  });

  it('returns undefined when there are no flagged suspects at all', () => {
    expect(annotateFailingTestsWithFlakeStats(['a.test.ts'], [])).toBeUndefined();
  });

  it('returns undefined when the failing files do not overlap any flagged suspect (a real regression)', () => {
    expect(
      annotateFailingTestsWithFlakeStats(['regression.test.ts'], [suspect({ file_path: 'unrelated.test.ts' })]),
    ).toBeUndefined();
  });

  it('annotates ONLY the failing files that match a flagged suspect, ignoring the rest', () => {
    const out = annotateFailingTestsWithFlakeStats(
      ['flaky.test.ts', 'regression.test.ts'],
      [suspect({ file_path: 'flaky.test.ts', fails: 12, passes: 53, both_status_shas: 4, flake_rate: 0.185 })],
    );
    expect(out).toContain('EI-7443');
    expect(out).toContain('flaky.test.ts: 12F/53P over 7d, 4 commit(s)');
    expect(out).toContain('flake_rate=0.185');
    expect(out).not.toContain('regression.test.ts');
  });
});

describe('shouldDispatchReleaseFixer (EI-8740: no fixer for a held gate with nothing to fix)', () => {
  it('dispatches on not-green with real failing tests', () => {
    expect(shouldDispatchReleaseFixer('not-green', 'cafe1234', ['a.test.ts'], undefined)).toBe(true);
  });

  it('dispatches on advanced-prefix with real failing tests (P-016 red-tip case)', () => {
    expect(shouldDispatchReleaseFixer('advanced-prefix', 'cafe1234', ['@papercusp/operator-vite'], undefined)).toBe(
      true,
    );
  });

  it('does NOT dispatch on not-green with EMPTY failingTests (the EI-8740 no-op-churn case)', () => {
    expect(shouldDispatchReleaseFixer('not-green', 'cafe1234', [], undefined)).toBe(false);
  });

  it('does NOT dispatch when failingTests is undefined', () => {
    expect(shouldDispatchReleaseFixer('not-green', 'cafe1234', undefined, undefined)).toBe(false);
  });

  it('does NOT dispatch without a candidate', () => {
    expect(shouldDispatchReleaseFixer('not-green', undefined, ['a.test.ts'], undefined)).toBe(false);
  });

  it('does NOT dispatch on other statuses (advanced, up-to-date, error, ...) even with failing tests', () => {
    for (const status of [
      'advanced',
      'up-to-date',
      'error',
      'create-failed',
      'not-fast-forward',
      'skipped-locked',
      'infra-inconclusive',
    ]) {
      expect(shouldDispatchReleaseFixer(status, 'cafe1234', ['a.test.ts'], undefined)).toBe(false);
    }
  });
});

describe('shouldDispatchReleaseFixer — proven-stale reds do not spend a fixer (EI-20029143927692821)', () => {
  const RED = ['packages/operator-core/lib/endpoint-route/__tests__/bootstrap-role.test.ts'];

  // The reported case: the verdict carried its OWN re-triage proving these exact files pass at
  // tip (the reader-side `verdictStaleReasonCode: 'retriage-proven'`), and a fixer was dispatched
  // anyway — one full agent spent re-deriving a conclusion the verdict already held.
  it.each(['deadline', 'absolute-ceiling', 'cap-disabled'] as const)(
    'does NOT dispatch when the run re-ran the named files at tip and they PASSED (refireBlockedBy=%s)',
    (refireBlockedBy) => {
      expect(
        shouldDispatchReleaseFixer('not-green', 'ee4e3c80', RED, {
          classification: 'stale-candidate',
          autoRefire: false,
          refireBlockedBy,
        }),
      ).toBe(false);
    },
  );

  // THE CARVE-OUT. A blanket "suppress on proven staleness" would swallow this case, and it is
  // exactly the one where the operator text says "the tip is genuinely broken: a human is needed".
  // If this ever flips to false, the guard has become the outage it was meant to prevent.
  it('DOES dispatch when refireBlockedBy is charged-budget (same breakage survived every rescue)', () => {
    expect(
      shouldDispatchReleaseFixer('not-green', 'ee4e3c80', RED, {
        classification: 'stale-candidate',
        autoRefire: false,
        refireBlockedBy: 'charged-budget',
      }),
    ).toBe(true);
  });

  it('DOES dispatch for a real-red re-triage (failures reproduce at tip)', () => {
    expect(
      shouldDispatchReleaseFixer('not-green', 'ee4e3c80', RED, {
        classification: 'real-red',
        autoRefire: false,
        refireBlockedBy: null,
      }),
    ).toBe(true);
  });

  // Fail-open: absent evidence must never suppress. An old CLI payload carries no re-triage, and
  // an unproven red still deserves its fixer — the failure this guard must not introduce.
  it.each([
    ['undefined retriage (old CLI payload)', undefined],
    ['null retriage', null],
    ['unknown classification (could not localize)', { classification: 'unknown' as const }],
    ['stale-candidate with no refire fields at all', { classification: 'unknown' as const, autoRefire: false }],
  ])('DOES dispatch with %s', (_label, retriage) => {
    expect(shouldDispatchReleaseFixer('not-green', 'ee4e3c80', RED, retriage)).toBe(true);
  });

  // The suppression must not resurrect a dispatch the OTHER guards already refused.
  it('still refuses an empty failing set even when the re-triage says real-red', () => {
    expect(
      shouldDispatchReleaseFixer('not-green', 'ee4e3c80', [], { classification: 'real-red' }),
    ).toBe(false);
  });

  // ONE definition of "proven stale" governs both the streak decision and the spend decision.
  // Pinned so the two cannot drift into disagreeing about the same evidence.
  it('agrees with isProvenStaleCandidate, the same predicate the streak classifier uses', () => {
    for (const refireBlockedBy of ['deadline', 'absolute-ceiling', 'cap-disabled', 'charged-budget'] as const) {
      const retriage = { classification: 'stale-candidate' as const, autoRefire: false, refireBlockedBy };
      expect(shouldDispatchReleaseFixer('not-green', 'ee4e3c80', RED, retriage)).toBe(
        !isProvenStaleCandidate(retriage),
      );
    }
  });
});

describe('decideReleaseFixerDispatch — liveness-aware dedup (P-014 / D-009)', () => {
  const now = 1_700_000_000_000;
  const SIG = 'a.test.ts,b.test.ts';
  const rec = (over: Partial<ReleaseFixerRecord> = {}): ReleaseFixerRecord => ({
    signature: SIG,
    candidate: 'cafe',
    at: now - 30 * 60_000, // 30 min ago (inside the 2h window)
    spawnId: 's-fixer-1',
    ...over,
  });

  it('FRESH: no prior record → dispatch + notify', () => {
    const d = decideReleaseFixerDispatch({ lf: null, signature: SIG, now, fixerAlive: null });
    expect(d).toEqual({ dispatch: true, notify: true, reason: 'fresh' });
  });

  it('FRESH: a DIFFERENT signature within the window → dispatch + notify (a new red)', () => {
    const d = decideReleaseFixerDispatch({
      lf: rec({ signature: 'other.test.ts' }),
      signature: SIG,
      now,
      fixerAlive: true,
    });
    expect(d).toMatchObject({ dispatch: true, reason: 'fresh' });
  });

  it('FRESH: same signature but the record AGED OUT past the window → dispatch + notify', () => {
    const d = decideReleaseFixerDispatch({
      lf: rec({ at: now - 3 * 60 * 60_000 }),
      signature: SIG,
      now,
      fixerAlive: false,
    });
    expect(d).toMatchObject({ dispatch: true, reason: 'fresh' });
  });

  it('COVERED: same signature, fixer ALIVE → skip (the good dedup — do not pile on)', () => {
    const d = decideReleaseFixerDispatch({ lf: rec(), signature: SIG, now, fixerAlive: true });
    expect(d).toEqual({ dispatch: false, notify: false, reason: 'covered' });
  });

  it('COVERED: same signature, liveness UNKNOWN (null — durable/legacy record) → skip, no regression', () => {
    const d = decideReleaseFixerDispatch({ lf: rec({ spawnId: null }), signature: SIG, now, fixerAlive: null });
    expect(d).toEqual({ dispatch: false, notify: false, reason: 'covered' });
  });

  it('RETRY: a failed fire with unknown liveness is not treated as a durable fixer', () => {
    const d = decideReleaseFixerDispatch({
      lf: rec({ spawnId: null, dispatchStatus: 'failed' }),
      signature: SIG,
      now,
      fixerAlive: null,
    });
    expect(d).toEqual({ dispatch: true, notify: true, reason: 'dispatch-retry' });
  });

  it('SELF-HEAL: same signature, fixer DEAD → re-dispatch (the incident fix — was a 2h gap)', () => {
    const d = decideReleaseFixerDispatch({
      lf: rec({ notifiedAt: now - 30 * 60_000 }),
      signature: SIG,
      now,
      fixerAlive: false,
    });
    expect(d.dispatch).toBe(true);
    expect(d.reason).toBe('self-heal');
  });

  it('SELF-HEAL: re-dispatch NOTIFY is rate-limited — notified recently → re-dispatch but suppress notify', () => {
    const d = decideReleaseFixerDispatch({
      lf: rec({ notifiedAt: now - 10 * 60_000 }),
      signature: SIG,
      now,
      fixerAlive: false,
    });
    expect(d.dispatch).toBe(true);
    expect(d.notify).toBe(false); // last notify 10 min ago < 2h cooldown
  });

  it('SELF-HEAL: re-dispatch DOES notify once the notify cooldown elapses', () => {
    const d = decideReleaseFixerDispatch({
      lf: rec({ at: now - 30 * 60_000, notifiedAt: now - 3 * 60 * 60_000 }),
      signature: SIG,
      now,
      fixerAlive: false,
      notifyCooldownMs: 2 * 60 * 60_000,
    });
    expect(d).toMatchObject({ dispatch: true, notify: true, reason: 'self-heal' });
  });

  it('the 2h dedup window is the documented default', () => {
    expect(RELEASE_FIXER_DEDUP_MS).toBe(2 * 60 * 60_000);
  });
});

describe('P-003: classifyFrozenRepairFixerSuccession', () => {
  const NOW = 1_800_000_000_000;
  const queue = (over: Partial<FrozenCandidateRepairQueue> = {}): FrozenCandidateRepairQueue => ({
    schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
    phase: 'awaiting-fixer',
    candidate: 'a'.repeat(40),
    base: 'b'.repeat(40),
    repairHead: 'c'.repeat(40),
    attempts: 1,
    openedAtMs: NOW - 2 * FIXER_SUCCESSION_STALL_MS,
    updatedAtMs: NOW - FIXER_SUCCESSION_STALL_MS,
    fixerSpawnId: 'fixer-dead',
    failingTests: ['lib/broken.test.ts'],
    signature: [],
    ...over,
  });

  it('classifies a confirmed-dead awaiting-fixer spawn with attempt-scoped age/identity', () => {
    const result = classifyFrozenRepairFixerSuccession(queue(), false, NOW);
    expect(result).toMatchObject({
      state: 'dead',
      ageMs: FIXER_SUCCESSION_STALL_MS,
      spawnId: 'fixer-dead',
      attempts: 1,
    });
    expect(result?.key).toContain('fixer-dead');
    expect(result?.key).toContain(String(NOW - FIXER_SUCCESSION_STALL_MS));
  });

  it('classifies a missing fixer only after the queue has no active launch reservation', () => {
    const absent = queue({ fixerSpawnId: null, attempts: 0 });
    expect(classifyFrozenRepairFixerSuccession(absent, undefined, NOW)).toMatchObject({
      state: 'absent',
      spawnId: null,
      attempts: 0,
    });
    expect(
      classifyFrozenRepairFixerSuccession(
        queue({
          fixerSpawnId: null,
          dispatchReservation: {
            token: 'launch-owner',
            claimedAtMs: NOW - 1_000,
            expiresAtMs: NOW + 60_000,
          },
        }),
        undefined,
        NOW,
      ),
    ).toBeNull();
  });

  it('never guesses death from live or unknown liveness, and ignores non-awaiting phases', () => {
    expect(classifyFrozenRepairFixerSuccession(queue(), true, NOW)).toBeNull();
    expect(classifyFrozenRepairFixerSuccession(queue(), null, NOW)).toBeNull();
    expect(classifyFrozenRepairFixerSuccession(queue({ phase: 'ready-to-verify' }), false, NOW)).toBeNull();
  });

  it('changes identity for a successor attempt so its first ladder rung is not suppressed', () => {
    const first = classifyFrozenRepairFixerSuccession(queue(), false, NOW);
    const successor = classifyFrozenRepairFixerSuccession(
      queue({ attempts: 2, updatedAtMs: NOW - FIXER_SUCCESSION_STALL_MS, fixerSpawnId: 'fixer-2' }),
      false,
      NOW,
    );
    expect(first?.key).not.toBe(successor?.key);
  });
});

describe('isStaleReleaseFixerCandidate (EI-8718: no fixer for a superseded/self-healed candidate)', () => {
  it('a valid, not-yet-promoted candidate is NOT stale — the legitimate-dispatch case', () => {
    expect(isStaleReleaseFixerCandidate({ candidateExists: true, candidatePromoted: false })).toBe(false);
  });

  it("a candidate whose object no longer exists (superseded + GC'd) IS stale", () => {
    expect(isStaleReleaseFixerCandidate({ candidateExists: false, candidatePromoted: false })).toBe(true);
  });

  it('a candidate already reachable from origin/main (self-healed to green) IS stale', () => {
    expect(isStaleReleaseFixerCandidate({ candidateExists: true, candidatePromoted: true })).toBe(true);
  });
});

describe('frozenRepairHasNoMeasuredFailures (WI-2140605: no reproduce-fixer with nothing to reproduce)', () => {
  const repairQueue = (over: Partial<FrozenCandidateRepairQueue> = {}): FrozenCandidateRepairQueue => ({
    schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
    phase: 'awaiting-fixer',
    candidate: 'a'.repeat(40),
    base: 'b'.repeat(40),
    repairHead: 'c'.repeat(40),
    attempts: 1,
    openedAtMs: 1_800_000_000_000,
    updatedAtMs: 1_800_000_000_000,
    fixerSpawnId: null,
    failingTests: ['lib/broken.test.ts'],
    signature: [],
    ...over,
  });

  // THE GUARD AGAINST OVER-SUPPRESSION. A frozen red with real measured failures is the
  // legitimate-dispatch case and must stay dispatchable — freezing the fixer path on an
  // actually-red gate is the one outcome this predicate must never cause.
  it('a frozen repair with measured failing tests still dispatches', () => {
    expect(frozenRepairHasNoMeasuredFailures(repairQueue(), ['lib/broken.test.ts'])).toBe(false);
  });

  // The measured 2026-09-01 deadlock: failingTests=[] on candidate edaf692e, three
  // consecutive fixers parked/died at "reproduce" with no target.
  it('a frozen repair with an EMPTY failing set does not dispatch', () => {
    expect(frozenRepairHasNoMeasuredFailures(repairQueue({ failingTests: [] }), [])).toBe(true);
  });

  it('an unmeasured (undefined) failing set is treated the same as empty', () => {
    expect(frozenRepairHasNoMeasuredFailures(repairQueue({ failingTests: [] }), undefined)).toBe(true);
  });

  // SCOPE. The ordinary fresh-verdict dispatch path passes no repair queue, and its
  // behaviour is deliberately untouched — an unextracted failure set there is a different
  // question, so this predicate must not claim it.
  it('a non-frozen (fresh-verdict) dispatch is out of scope even with no failing tests', () => {
    expect(frozenRepairHasNoMeasuredFailures(undefined, [])).toBe(false);
    expect(frozenRepairHasNoMeasuredFailures(undefined, undefined)).toBe(false);
  });

  // EI-22216541327801093: candidate 5fdc2b24b770 — a plain inconclusive hold tick (no
  // repairTickLegs data) stamps failingTestsMeasured:false while leaving the PRIOR tick's
  // (non-empty) failingTests names untouched, so the array-only check above sees "names
  // present" and dispatches anyway. Three release-fixer attempts found nothing to fix.
  describe('the failingTestsMeasured axis (EI-22216541327801093: non-empty but unmeasured)', () => {
    it('a NON-empty failing set with failingTestsMeasured:false does NOT dispatch', () => {
      expect(
        frozenRepairHasNoMeasuredFailures(repairQueue(), ['lint:design-primitives', 'lint:plane-integrity'], false),
      ).toBe(true);
    });

    it('a NON-empty failing set with failingTestsMeasured:true still dispatches (unaffected)', () => {
      expect(frozenRepairHasNoMeasuredFailures(repairQueue(), ['lib/broken.test.ts'], true)).toBe(false);
    });

    it('a NON-empty failing set with failingTestsMeasured omitted (undefined) preserves prior behaviour', () => {
      expect(frozenRepairHasNoMeasuredFailures(repairQueue(), ['lib/broken.test.ts'], undefined)).toBe(false);
    });

    it('a NON-empty failing set with failingTestsMeasured:null (genuinely unknown) also preserves prior behaviour', () => {
      expect(frozenRepairHasNoMeasuredFailures(repairQueue(), ['lib/broken.test.ts'], null)).toBe(false);
    });

    it('an EMPTY failing set still does not dispatch regardless of the measured flag', () => {
      expect(frozenRepairHasNoMeasuredFailures(repairQueue({ failingTests: [] }), [], true)).toBe(true);
    });

    it('failingTestsMeasured:false is out of scope with no repair queue, same as the array axis', () => {
      expect(frozenRepairHasNoMeasuredFailures(undefined, ['lib/broken.test.ts'], false)).toBe(false);
    });
  });
});

describe('checkReleaseFixerCandidateStale — live re-verify (EI-8718)', () => {
  const fakeRunner = (impl: (args: string[]) => { ok: boolean; stdout: string }): GitCheckRunner => {
    return async (_root: string, args: string[]) => impl(args);
  };

  it('object missing → candidateExists:false, candidatePromoted:false, and skips the ancestor check', async () => {
    const calls: string[][] = [];
    const runner = fakeRunner((args) => {
      calls.push(args);
      return { ok: false, stdout: '' }; // cat-file -e fails
    });
    const r = await checkReleaseFixerCandidateStale('/repo', 'deadbeef', runner);
    expect(r).toEqual({ candidateExists: false, candidatePromoted: false });
    expect(calls).toHaveLength(1); // never ran the rev-list check
  });

  it('object exists, origin/main does NOT yet contain it → not promoted (genuinely red)', async () => {
    const runner = fakeRunner((args) =>
      args[0] === 'cat-file' ? { ok: true, stdout: '' } : { ok: true, stdout: '3' },
    );
    const r = await checkReleaseFixerCandidateStale('/repo', 'cafe1234', runner);
    expect(r).toEqual({ candidateExists: true, candidatePromoted: false });
  });

  it('object exists, origin/main ALREADY contains it (count 0) → promoted (self-healed to green)', async () => {
    const runner = fakeRunner((args) =>
      args[0] === 'cat-file' ? { ok: true, stdout: '' } : { ok: true, stdout: '0' },
    );
    const r = await checkReleaseFixerCandidateStale('/repo', 'cafe1234', runner);
    expect(r).toEqual({ candidateExists: true, candidatePromoted: true });
  });

  it('uses the target gate release ref instead of the operator home main ref', async () => {
    const calls: string[][] = [];
    const runner = fakeRunner((args) => {
      calls.push(args);
      return args[0] === 'cat-file' ? { ok: true, stdout: '' } : { ok: true, stdout: '0' };
    });
    const r = await checkReleaseFixerCandidateStale('/repo', 'cafe1234', runner, 'refs/heads/release-candidate');
    expect(r).toEqual({ candidateExists: true, candidatePromoted: true });
    expect(calls[1]).toEqual(['rev-list', '--count', 'origin/release-candidate..cafe1234']);
  });

  it('a transient git error on the ancestor check fails CLOSED to not-promoted, not stale', async () => {
    const runner = fakeRunner((args) =>
      args[0] === 'cat-file' ? { ok: true, stdout: '' } : { ok: false, stdout: '' },
    );
    const r = await checkReleaseFixerCandidateStale('/repo', 'cafe1234', runner);
    expect(r).toEqual({ candidateExists: true, candidatePromoted: false });
  });
});

describe('EI-21363817573800034: a scheduled tick declines while a qualification hold is active', () => {
  // The recurrence this pins: on 2026-08-24 the hourly wrapper twice took the run-lock while an
  // owner-directed serializer hold forbade any qualification (D-025 18:16Z, D-031 19:20Z). Both
  // runs had to be hand-stopped at the systemd scope and marked permanently non-qualifying,
  // because the hold bound humans and agents but was invisible to the scheduler.
  const GREEN_MARKER = '__GREEN_CHECKPOINT_RESULT__';
  const okStdout = `${GREEN_MARKER} ${JSON.stringify({ reason: 'up-to-date', green: true })}\n`;

  beforeEach(() => {
    qualificationAdmission.mockReset();
    qualificationAdmission.mockResolvedValue({ status: 'clear' });
  });

  it('HELD: never spawns the suite — so the run-lock is never acquired — and records skipped-held with the governing ref', async () => {
    qualificationAdmission.mockResolvedValue({
      status: 'held',
      hold: {
        governingRef: 'stable-candidate-related-gate-2026-08-23#D-028',
        blockingItems: ['EI-21345855843068720'],
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await getSystemAction('green-checkpoint')!(ctx);
    // THE property, asserted behaviourally rather than by field name: the run-lock is taken by
    // the CHILD process, so "no spawn at all" is exactly "cannot acquire the run-lock".
    expect(spawnMock).not.toHaveBeenCalled();
    // …and the decline is attributable — a skip with no governing ref would be indistinguishable
    // from the gate silently breaking, which is the failure mode this whole item is about.
    expect(appendPipelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'green_checkpoint',
        status: 'skipped-held',
        detail: expect.objectContaining({
          governingRef: 'stable-candidate-related-gate-2026-08-23#D-028',
          blockingItems: ['EI-21345855843068720'],
        }),
      }),
    );
    warn.mockRestore();
  });

  it('CLEAR: resumes after the hold lifts — the suite spawns exactly as it did before the guard existed', async () => {
    qualificationAdmission.mockResolvedValue({ status: 'clear' });
    spawnMock.mockImplementationOnce(() => fakeSpawn(okStdout, 0));
    await getSystemAction('green-checkpoint')!(ctx);
    expect(spawnMock).toHaveBeenCalled();
    expect(appendPipelineEvent).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped-held' }));
  });

  it('UNKNOWN is not permission: an unreadable admission also declines, rather than failing open', async () => {
    // Fail-open here would defeat the entire guard, since an unreachable DB is precisely when a
    // supervisor is least able to notice an unauthorized run. It skips THIS tick only.
    qualificationAdmission.mockResolvedValue({ status: 'unknown', reason: 'connection refused' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await getSystemAction('green-checkpoint')!(ctx);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(appendPipelineEvent).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped-admission-unknown' }));
    warn.mockRestore();
  });
});

describe('green-checkpoint scope isolation (2026-07-01 bg-host OOM blast-radius)', () => {
  const GREEN_MARKER = '__GREEN_CHECKPOINT_RESULT__';
  const okStdout = `${GREEN_MARKER} ${JSON.stringify({ reason: 'up-to-date', green: true })}\n`;

  /** fakeSpawn with stderr + configurable exit code (scope-launch-failure shape). */
  function fakeSpawnFail(stderr: string, code = 1): ReturnType<typeof fakeSpawn> {
    const child = new EventEmitter() as ReturnType<typeof fakeSpawn>;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    });
    return child;
  }

  const savedScopeEnv = process.env.PAPERCUSP_CHECKPOINT_SCOPE;
  afterEach(() => {
    if (savedScopeEnv === undefined) delete process.env.PAPERCUSP_CHECKPOINT_SCOPE;
    else process.env.PAPERCUSP_CHECKPOINT_SCOPE = savedScopeEnv;
  });

  it('EI-10158: a green tick tracks the stall streak through the MOCKED sql — no real PG, no ECONNREFUSED console.warn', async () => {
    // Regression guard for the env-dependent flake: trackGateStall reaches
    // @papercusp/db-org directly. With the db-org mock in place the green-checkpoint
    // action must query gate_health via the fake sql (never a real :5432 connect) and
    // its fail-safe .catch must NOT fire a stall-tracking warn. Before the mock this
    // console.warn'd ECONNREFUSED whenever PG was unreachable (CI / operator restart),
    // which vitest-fail-on-console turns red.
    delete process.env.PAPERCUSP_CHECKPOINT_SCOPE;
    spawnMock.mockImplementationOnce(() => fakeSpawn(okStdout, 0));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await getSystemAction('green-checkpoint')!(ctx);
    // The stall-tracking SELECT ran against the fake sql, scoped to the install slug.
    expect(fakeSql.unsafe).toHaveBeenCalledWith(expect.stringContaining('gate_health'), ['my-harness', 'ws-42']);
    // …so the fail-safe catch never logged a stall-tracking failure (the flake's warn).
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('stall tracking failed'));
    warn.mockRestore();
  });

  it('buildIsolatedScopeArgv wraps worker payloads in a memory-capped transient user SCOPE', () => {
    const argv = buildIsolatedScopeArgv(['/x/tsx', '/x/suite.ts'], 16);
    expect(argv[0]).toBe('systemd-run');
    expect(argv).toContain('--user');
    expect(argv).toContain('--scope'); // scope (child stays OURS: stdio/env/pgid) — never --unit
    expect(argv).toContain('--collect');
    expect(argv).toContain('--property=CollectMode=inactive-or-failed');
    expect(argv).toContain('--property=MemoryMax=16G');
    // WI-41206: worker scopes page at their cap instead of being OOM-killed when the host
    // has free swap. The deny policy remains an explicit opt-in for known thrashers.
    expect(argv).not.toContain('--property=MemorySwapMax=0');
    expect(buildIsolatedScopeArgv(['/x/tsx', '/x/suite.ts'], 16, 'deny')).toContain('--property=MemorySwapMax=0');
    // Payload appended verbatim, in order, at the end.
    expect(argv.slice(-2)).toEqual(['/x/tsx', '/x/suite.ts']);
  });

  // ── EI-22129539141207312: the systemd-enforced outer wall ──────────────────
  // A crashed run sat resident 29h with zombie children and no terminal marker,
  // having outlived its own 180m self-watchdog, because every bound on it lived in
  // a process that could die (or wedge) before firing. systemd owns none of those
  // failure modes, which is why the wall belongs on the scope.
  it('a scoped checkpoint run carries a systemd RuntimeMaxSec wall, above the whole in-band chain', () => {
    const argv = buildIsolatedScopeArgv(['/x/tsx', '/x/suite.ts'], 16, 'allow', CHECKPOINT_SCOPE_RUNTIME_MAX_SEC);
    expect(argv).toContain(`--property=RuntimeMaxSec=${CHECKPOINT_SCOPE_RUNTIME_MAX_SEC}`);

    // ORDERING IS THE SAFETY PROPERTY, not the presence of the flag. A wall at or
    // below the in-band chain would kill healthy slow suites pre-verdict — the exact
    // regression the 55m→115m timeout bump was made to stop — so assert the wall sits
    // STRICTLY above every bound green-checkpoint.ts documents.
    const SUITE_TIMEOUT_SEC = 115 * 60;
    const SELF_WATCHDOG_SEC = 180 * 60;
    const LOCK_STALE_SEC = 190 * 60; // CHECKPOINT_LOCK_STALE_MS
    expect(CHECKPOINT_SCOPE_RUNTIME_MAX_SEC).toBeGreaterThan(SUITE_TIMEOUT_SEC);
    expect(CHECKPOINT_SCOPE_RUNTIME_MAX_SEC).toBeGreaterThan(SELF_WATCHDOG_SEC);
    expect(CHECKPOINT_SCOPE_RUNTIME_MAX_SEC).toBeGreaterThan(LOCK_STALE_SEC);
  });

  it('the wall is OPT-IN: a caller with its own supervision is unchanged (no RuntimeMaxSec)', () => {
    // Deliberately-wrong control. If the default ever became a bound, the two other
    // production callers (substrate sidecar, orchestrator runner) would silently
    // acquire a kill deadline nobody chose for them — so pin the omission, not just
    // the presence above.
    for (const argv of [buildIsolatedScopeArgv(['/bin/false'], 6), buildIsolatedScopeArgv(['/bin/false'], 6, 'deny')]) {
      expect(argv.some((a) => a.startsWith('--property=RuntimeMaxSec='))).toBe(false);
    }
  });

  describe('scheduled checkpoint evidence wrapper', () => {
    it('writes normal stdout and an attributable terminal record after a successful child', () => {
      const dir = mkdtempSync(join(tmpdir(), 'papercusp-scheduled-checkpoint-'));
      const paths = checkpointRunLogPaths(dir, 'normal-run', new Date('2026-08-24T15:00:00.000Z'));
      try {
        const output = execFileSync(
          '/bin/bash',
          [
            '-c',
            buildScheduledCheckpointShell(
              [
                process.execPath,
                '-e',
                "process.stdout.write('normal stdout\\n'); process.stderr.write('normal stderr\\n')",
              ],
              paths,
              {
                workspaceId: 'ws-terminal',
                installSlug: 'papercusp',
                qualificationAttemptId: 'attempt-terminal',
                gateFireId: 'fire-terminal',
              },
            ),
          ],
          { encoding: 'utf8' },
        );

        expect(output).toContain('normal stdout');
        const log = readFileSync(paths.logPath, 'utf8');
        expect(log).toMatchObject(expect.stringContaining('normal stdout'));
        expect(log).toContain('normal stderr');
        expect(log).toContain('GREEN_CHECKPOINT_MEMORY_EVENTS ');
        const terminal = JSON.parse(readFileSync(paths.terminalPath, 'utf8')) as {
          runId: string;
          logPath: string;
          exitCode: number;
          memoryEvents: null | {
            subtree: {
              low: number;
              high: number;
              max: number;
              oom: number;
              oomKill: number;
              oomGroupKill: number;
            };
            local: Record<string, number> | null;
            peakBytes: number | null;
          };
        };
        expect(terminal).toMatchObject({
          schemaVersion: 1,
          runId: 'normal-run',
          logPath: paths.logPath,
          exitCode: 0,
          workspaceId: 'ws-terminal',
          installSlug: 'papercusp',
          qualificationAttemptId: 'attempt-terminal',
          gateFireId: 'fire-terminal',
        });
        expect(terminal).toHaveProperty('memoryEvents');
        if (terminal.memoryEvents !== null) {
          expect(terminal.memoryEvents.subtree).toMatchObject({
            low: expect.any(Number),
            high: expect.any(Number),
            max: expect.any(Number),
            oom: expect.any(Number),
            oomKill: expect.any(Number),
            oomGroupKill: expect.any(Number),
          });
          expect(
            terminal.memoryEvents.peakBytes === null ||
              typeof terminal.memoryEvents.peakBytes === 'number',
          ).toBe(true);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('writes terminal evidence when the child exits abnormally without a verdict marker', () => {
      const dir = mkdtempSync(join(tmpdir(), 'papercusp-scheduled-checkpoint-'));
      const paths = checkpointRunLogPaths(dir, 'abnormal-run', new Date('2026-08-24T15:01:00.000Z'));
      try {
        let thrown: { status?: number } | undefined;
        try {
          execFileSync(
            '/bin/bash',
            [
              '-c',
              buildScheduledCheckpointShell(
                [process.execPath, '-e', "process.stderr.write('abnormal stderr\\n'); process.exit(17)"],
                paths,
              ),
            ],
            { encoding: 'utf8' },
          );
        } catch (error) {
          thrown = error as { status?: number };
        }

        expect(thrown?.status).toBe(17);
        expect(readFileSync(paths.logPath, 'utf8')).toContain('abnormal stderr');
        expect(JSON.parse(readFileSync(paths.terminalPath, 'utf8'))).toMatchObject({
          runId: 'abnormal-run',
          logPath: paths.logPath,
          exitCode: 17,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('keeps the durable log and child alive when the live stdout mirror loses its reader', () => {
      const dir = mkdtempSync(join(tmpdir(), 'papercusp-scheduled-checkpoint-'));
      const paths = checkpointRunLogPaths(dir, 'mirror-loss-run', new Date('2026-08-24T15:01:30.000Z'));
      const wrapperPath = join(dir, 'wrapper.sh');
      try {
        writeFileSync(
          wrapperPath,
          buildScheduledCheckpointShell(
            [
              process.execPath,
              '-e',
              [
                "process.stdout.write('before mirror loss\\n')",
                "setTimeout(() => process.stdout.write('after mirror loss\\n'), 100)",
                'setTimeout(() => process.exit(0), 200)',
              ].join('; '),
            ],
            paths,
          ),
          { mode: 0o700 },
        );

        // `head` exits after the first line, closing the wrapper's live stdout reader while
        // the child is still running. The append-only file sink must remain writable and the
        // wrapper must still observe the child's real exit instead of manufacturing exit 1.
        execFileSync('/bin/bash', ['-c', `/bin/bash ${JSON.stringify(wrapperPath)} | head -n 1 >/dev/null`], {
          encoding: 'utf8',
        });

        expect(readFileSync(paths.logPath, 'utf8')).toContain('after mirror loss');
        expect(JSON.parse(readFileSync(paths.terminalPath, 'utf8'))).toMatchObject({
          runId: 'mirror-loss-run',
          logPath: paths.logPath,
          exitCode: 0,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does not report a clean exit when the wrapper is SIGTERMed mid-child', () => {
      const dir = mkdtempSync(join(tmpdir(), 'papercusp-scheduled-checkpoint-'));
      const paths = checkpointRunLogPaths(dir, 'killed-run', new Date('2026-08-24T15:02:00.000Z'));
      const wrapperPath = join(dir, 'wrapper.sh');
      const killerPath = join(dir, 'kill-wrapper.sh');
      try {
        writeFileSync(wrapperPath, buildScheduledCheckpointShell(['/bin/bash', '-c', 'sleep 30'], paths), {
          mode: 0o700,
        });
        // Run the wrapper in its own process group, matching systemd's cgroup-level
        // stop closely enough to exercise the EXIT trap while leaving no sleeper behind.
        writeFileSync(
          killerPath,
          [
            '#!/bin/bash',
            'set -u',
            `wrapper=${JSON.stringify(wrapperPath)}`,
            'setsid /bin/bash "$wrapper" &',
            'pid=$!',
            'sleep 0.2',
            'kill -TERM -- "-$pid" 2>/dev/null || :',
            'wait "$pid" 2>/dev/null || :',
          ].join('\n') + '\n',
          { mode: 0o700 },
        );
        execFileSync('/bin/bash', [killerPath], { encoding: 'utf8' });

        expect(JSON.parse(readFileSync(paths.terminalPath, 'utf8'))).toMatchObject({
          runId: 'killed-run',
          logPath: paths.logPath,
          exitCode: null,
          killed: true,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('CAS-settles an OOM-killed logical attempt before rename and safely replays after a rename failure', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'papercusp-scheduled-checkpoint-reconcile-'));
      const paths = checkpointRunLogPaths(dir, 'oom-run', new Date('2026-09-07T15:02:00.000Z'));
      try {
        writeFileSync(paths.logPath, '# wrapper died before publishing a verdict marker\n');
        writeFileSync(
          paths.terminalPath,
          JSON.stringify({
            schemaVersion: 1,
            runId: paths.runId,
            logPath: paths.logPath,
            exitCode: 137,
            killed: false,
            memoryEvents: {
              subtree: { oomKill: 1, oomGroupKill: 0 },
              local: { oomKill: 0, oomGroupKill: 0 },
            },
            finishedAt: '2026-09-07T15:03:00Z',
            workspaceId: 'ws-42',
            installSlug: 'my-harness',
            qualificationAttemptId: 'attempt-oom',
            gateFireId: 'fire-oom',
          }),
        );
       recordStoredQualificationVerdict.mockResolvedValueOnce({
         status: 'updated',
         transaction: {},
       });
        recordStoredQualificationVerdict.mockResolvedValueOnce({
          status: 'idempotent',
          transaction: {},
        });
        let moveAttempts = 0;
        const move = async (from: string, to: string) => {
          moveAttempts++;
          if (moveAttempts === 1) throw new Error('simulated post-DB rename interruption');
          renameSync(from, to);
        };

        const first = await reconcileScheduledCheckpointTerminals(ctx, { dir, move });
        expect(first).toEqual([
          expect.objectContaining({ status: 'settled', reason: 'infra-inconclusive', markerRetained: true }),
        ]);
       expect(recordStoredQualificationVerdict).toHaveBeenCalledTimes(1);
        expect(recordStoredQualificationVerdict).toHaveBeenCalledWith(
          expect.objectContaining({ workspaceId: 'ws-42', installSlug: 'my-harness' }),
          expect.objectContaining({
            attemptId: 'attempt-oom',
            reason: 'infra-inconclusive',
            evidenceRefs: expect.arrayContaining(['checkpoint-terminal:oom-run', 'gate-fire:fire-oom']),
          }),
        );
        expect(existsSync(paths.terminalPath)).toBe(true);

        const second = await reconcileScheduledCheckpointTerminals(ctx, { dir, move });
        expect(second).toEqual([expect.objectContaining({ status: 'already-settled', markerRetained: false })]);
        expect(recordStoredQualificationVerdict).toHaveBeenCalledTimes(2);
        expect(existsSync(paths.terminalPath)).toBe(false);
        expect(existsSync(`${paths.terminalPath}.reconciled`)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('never lets an unscoped or copied terminal marker settle the current attempt', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'papercusp-scheduled-checkpoint-wrong-target-'));
      const paths = checkpointRunLogPaths(dir, 'other-run', new Date('2026-09-07T15:04:00.000Z'));
      try {
        writeFileSync(paths.logPath, '');
        writeFileSync(
          paths.terminalPath,
          JSON.stringify({
            schemaVersion: 1,
            runId: paths.runId,
            logPath: paths.logPath,
            exitCode: 137,
            killed: false,
            memoryEvents: null,
            finishedAt: '2026-09-07T15:05:00Z',
            workspaceId: 'different-workspace',
            installSlug: 'my-harness',
            qualificationAttemptId: 'attempt-other',
            gateFireId: null,
          }),
        );
        const parsed = parseScheduledCheckpointTerminal(
          JSON.parse(readFileSync(paths.terminalPath, 'utf8')),
          paths.terminalPath,
        );
        expect(parsed?.qualificationAttemptId).toBe('attempt-other');

        const result = await reconcileScheduledCheckpointTerminals(ctx, { dir });
        expect(result).toEqual([expect.objectContaining({ status: 'ignored-other-target' })]);
        expect(recordStoredQualificationVerdict).not.toHaveBeenCalled();
        expect(existsSync(paths.terminalPath)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('replays one exact-candidate red wake after parent death without waking twice', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'papercusp-scheduled-checkpoint-red-replay-'));
      const paths = checkpointRunLogPaths(dir, 'red-replay', new Date('2026-09-24T07:20:00.000Z'));
      const candidate = 'abc123def456789';
      try {
        writeFileSync(paths.logPath, `__GREEN_CHECKPOINT_RESULT__ ${JSON.stringify({
          reason: 'not-green', green: false, candidate, runId: paths.runId,
        })}\n`);
        writeFileSync(paths.terminalPath, JSON.stringify({
          schemaVersion: 1, runId: paths.runId, logPath: paths.logPath,
          exitCode: 0, killed: false, memoryEvents: null,
          finishedAt: '2026-09-24T07:21:00Z', workspaceId: 'ws-42', installSlug: 'my-harness',
          qualificationAttemptId: 'attempt-red', gateFireId: 'fire-red', integrationRoot: REPO_ROOT,
        }));
        recordStoredQualificationVerdict.mockResolvedValueOnce({ status: 'updated' });
        recordStoredQualificationVerdict.mockResolvedValueOnce({ status: 'terminal' });
        const move = async () => { throw new Error('simulated rename interruption'); };

        expect(await reconcileScheduledCheckpointTerminals(ctx, { dir, move }))
          .toEqual([expect.objectContaining({ status: 'settled', markerRetained: true })]);
        expect(emitAwaitedEvent.mock.calls.map(([args]) => (args as { payload: { sha: string } }).payload.sha))
          .toEqual([candidate, candidate]);
        expect(await reconcileScheduledCheckpointTerminals(ctx, { dir, move }))
          .toEqual([expect.objectContaining({ status: 'already-settled', markerRetained: true })]);
        expect(emitAwaitedEvent).toHaveBeenCalledTimes(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('retains a same-attempt candidate-mismatch marker until exact runner recovery, then replays safely', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'papercusp-scheduled-checkpoint-mismatch-'));
      const paths = checkpointRunLogPaths(dir, 'wrapper-run', new Date('2026-09-24T07:12:00.000Z'));
      try {
        writeFileSync(paths.logPath, `__GREEN_CHECKPOINT_RESULT__ ${JSON.stringify({
          reason: 'skipped-locked', candidate: 'candidate-new', runId: 'wrapper-run',
        })}\n`);
        writeFileSync(paths.terminalPath, JSON.stringify({
          schemaVersion: 1, runId: paths.runId, logPath: paths.logPath,
          exitCode: 0, killed: false, memoryEvents: null,
          finishedAt: '2026-09-24T07:13:00Z', workspaceId: 'ws-42', installSlug: 'my-harness',
          qualificationAttemptId: 'attempt-current', gateFireId: 'fire-current',
        }));
        recordStoredQualificationVerdict.mockResolvedValue({
          status: 'conflict', transaction: { attemptId: 'attempt-current', candidate: 'candidate-old' },
        });
        recordStoredQualificationScheduledTerminalRecovery.mockResolvedValueOnce({ status: 'conflict' });
        const refused = await reconcileScheduledCheckpointTerminals(ctx, { dir });
        expect(refused).toEqual([expect.objectContaining({ status: 'retry', markerRetained: true })]);
        expect(existsSync(paths.terminalPath)).toBe(true);

        recordStoredQualificationScheduledTerminalRecovery.mockResolvedValueOnce({ status: 'updated' });
        const recovered = await reconcileScheduledCheckpointTerminals(ctx, {
          dir, move: async () => { throw new Error('post-CAS rename interruption'); },
        });
        expect(recovered).toEqual([expect.objectContaining({ status: 'settled', markerRetained: true })]);
        expect(recordStoredQualificationScheduledTerminalRecovery).toHaveBeenLastCalledWith(
          expect.objectContaining({ workspaceId: 'ws-42', installSlug: 'my-harness' }),
          expect.objectContaining({
            attemptId: 'attempt-current', runnerId: 'fire-current', runId: 'wrapper-run',
            reason: 'skipped-locked', evidenceRefs: expect.arrayContaining([
              'checkpoint-terminal:wrapper-run', 'gate-fire:fire-current',
            ]),
          }),
        );
        recordStoredQualificationScheduledTerminalRecovery.mockResolvedValueOnce({ status: 'terminal' });
        const replay = await reconcileScheduledCheckpointTerminals(ctx, { dir });
        expect(replay).toEqual([expect.objectContaining({ status: 'already-settled', markerRetained: false })]);
        expect(existsSync(paths.terminalPath)).toBe(false);
        expect(existsSync(`${paths.terminalPath}.reconciled`)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('the PERIODIC gate launches the suite under systemd-run --scope (own cgroup, stdout marker still parsed)', async () => {
    delete process.env.PAPERCUSP_CHECKPOINT_SCOPE;
    spawnMock.mockImplementationOnce(() => fakeSpawn(okStdout, 0));
    await getSystemAction('green-checkpoint')!(ctx);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('systemd-run');
    expect(args).toContain('--scope');
    const reservedRunner = reserveStoredQualificationRunner.mock.calls[0]?.[1] as { runnerId?: string; unit?: string };
    expect(reservedRunner?.unit).toBe(`papercusp-checkpoint-${reservedRunner.runnerId}.scope`);
    expect(args).toContain(`--unit=${reservedRunner.unit}`);
    expect(args.some((a) => /^--property=MemoryMax=\d+G$/.test(a))).toBe(true);
    expect(args.join(' ')).toContain('green-checkpoint.ts');
    expect(args.at(-1)).toContain('trap _papercusp_write_checkpoint_terminal EXIT');
    const childEnv = spawnMock.mock.calls[0]![2] as { env?: Record<string, string> };
    const sharedRunId = childEnv.env?.PAPERCUSP_CHECKPOINT_SCHEDULED_RUN;
    expect(sharedRunId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i);
    expect(args.at(-1)).toContain(sharedRunId);
    // The verdict still lands as a pipeline event (stdout was piped through the scope).
    expect(appendPipelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'green_checkpoint', status: 'up-to-date' }),
    );
  });

  it('settles a markerless scheduled child exit instead of leaving a PID-less runner reservation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    spawnMock.mockImplementationOnce(() => fakeSpawn('', 1));
    recordStoredQualificationVerdict.mockResolvedValueOnce({ status: 'updated' });

    await getSystemAction('green-checkpoint')!(ctx);

    const options = spawnMock.mock.calls[0]![2] as { env?: Record<string, string> };
    const runId = options.env?.[CHECKPOINT_SCHEDULED_RUN_ENV];
    expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i);
    expect(recordStoredQualificationVerdict).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-42', installSlug: 'my-harness' }),
      expect.objectContaining({
        attemptId: 'scheduled-attempt', runId, reason: 'error',
        terminalEvent: expect.objectContaining({ status: 'error' }),
      }),
    );
    expect(appendPipelineEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      kind: 'green_checkpoint', status: 'error',
    }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exited 1'));
  });

  it('EI-22642378999251872: the periodic launcher snapshots one exact logical attempt into env and terminal evidence', async () => {
    readStoredQualification.mockResolvedValueOnce({
      status: 'present',
      transaction: { phase: 'running', attemptId: 'attempt-transported' },
    });
    recordStoredQualificationScheduledFire.mockResolvedValueOnce({
      status: 'updated',
      transaction: { phase: 'running', attemptId: 'attempt-transported', currentPhysicalRunner: null, outcome: { kind: 'pending' } },
    });
    spawnMock.mockImplementationOnce(() => fakeSpawn(okStdout, 0));

    await getSystemAction('green-checkpoint')!(ctx);

    expect(readStoredQualification).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-42', installSlug: 'my-harness' }),
    );
    const [, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env?: Record<string, string> },
    ];
    expect(options.env?.[CHECKPOINT_QUALIFICATION_ATTEMPT_ENV]).toBe('attempt-transported');
    expect(options.env?.[CHECKPOINT_SCHEDULED_RUN_ENV]).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i);
    expect(args.at(-1)).toContain(options.env?.[CHECKPOINT_SCHEDULED_RUN_ENV]);
    expect(reserveStoredQualificationRunner).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-42', installSlug: 'my-harness' }),
      expect.objectContaining({ attemptId: 'attempt-transported', started: false }),
    );
    expect(args.at(-1)).toContain('attempt-transported');
    expect(args.at(-1)).toContain('ws-42');
    expect(args.at(-1)).toContain('my-harness');
    // WI-10007497: the routine's non-atomic fallback verdict names the attempt it bound the run to.
    expect(appendPipelineEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'green_checkpoint', status: 'up-to-date',
      detail: expect.objectContaining({ attemptId: 'attempt-transported' }),
    }));
  });

  it('joins one live qualification runner without spawning another gate suite', async () => {
    const transaction = {
      phase: 'running', attemptId: 'attempt-live', candidate: 'candidate-live', repairHead: 'repair-live',
      runId: 'run-live', outcome: { kind: 'pending' }, currentPhysicalRunner: { id: 'runner-live', unit: 'unit-live' },
    };
    readStoredQualification.mockResolvedValueOnce({ status: 'present', transaction });
    beginStoredQualification.mockResolvedValueOnce({ status: 'idempotent', transaction });
    recordStoredQualificationScheduledFire.mockResolvedValueOnce({ status: 'updated', transaction });
    probeRunnerLiveness.mockReturnValueOnce('live');

    await getSystemAction('green-checkpoint')!(ctx);

    expect(beginStoredQualification).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-42', installSlug: 'my-harness' }),
      expect.objectContaining({ attemptId: 'attempt-live', evidenceRefs: expect.arrayContaining([expect.stringMatching(/^gate-fire:/)]) }),
      { reconcileTerminalRepairQueueForSuccessor: true },
    );
    expect(reserveStoredQualificationRunner).not.toHaveBeenCalled();
    expect(recordStoredQualificationScheduledFire).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-42', installSlug: 'my-harness' }), 'attempt-live',
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(appendPipelineEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'green_checkpoint', status: 'skipped-joined-attempt',
      detail: expect.objectContaining({ attemptId: 'attempt-live', runnerId: 'runner-live' }),
    }));
  });

  it('pins only the exact repairHead for a null-origin unassigned awaiting-fixer successor', async () => {
    const repairHead = 'c'.repeat(40);
    const queueFor = (qualificationAttemptId: string | null): FrozenCandidateRepairQueue => ({
      schemaVersion: 1,
      phase: 'awaiting-fixer',
      candidate: 'a'.repeat(40),
      qualificationAttemptId,
      base: 'b'.repeat(40),
      repairHead,
      attempts: 0,
      openedAtMs: 1,
      updatedAtMs: 2,
      fixerSpawnId: null,
      failingTests: ['packages/operator-core/lib/example.test.ts'],
      signature: [],
    });
    const runScheduledSuccessor = async (qualificationAttemptId: string | null) => {
      fakeSql.unsafe.mockResolvedValueOnce(sqlRows([{ repair_queue: queueFor(qualificationAttemptId) }]));
      readStoredQualification.mockResolvedValueOnce({
        status: 'present',
        transaction: { phase: 'terminal', attemptId: 'terminal-predecessor', requiredAncestorSha: null },
      });
      spawnMock.mockImplementationOnce(() => fakeSpawn(okStdout, 0));
      await getSystemAction('green-checkpoint')!(ctx);
      return beginStoredQualification.mock.calls.at(-1)![1] as Record<string, unknown>;
    };

    const eligible = await runScheduledSuccessor(null);
    expect(eligible).toMatchObject({ requiredAncestorSha: repairHead });

    const knownOrigin = await runScheduledSuccessor('another-attempt');
    expect(knownOrigin).not.toHaveProperty('requiredAncestorSha');
  });

  it('records exact begin-conflict identities and a safe next action without spawning a suite', async () => {
    beginStoredQualification.mockResolvedValueOnce({
      status: 'conflict', transaction: {
        attemptId: 'incumbent-attempt', phase: 'running', candidate: 'incumbent-candidate',
        repairHead: 'incumbent-repair', runId: 'incumbent-run',
        currentPhysicalRunner: { id: 'incumbent-runner', leaseExpiresAtMs: 1234, heartbeatAtMs: 1200 },
      },
      repairQueueReconciliation: { status: 'blocked', reason: 'queue-not-safe-unstarted' },
    });
    await getSystemAction('green-checkpoint')!(ctx);
    const event = appendPipelineEvent.mock.calls.map((c) => c[0] as { status: string; detail: unknown })
      .find((e) => e.status === 'skipped-qualification-conflict');
    expect(event?.detail).toMatchObject({
      reason: 'conflict', stage: 'begin',
      repairQueueReconciliation: { status: 'blocked', reason: 'queue-not-safe-unstarted' },
      requestedAttemptId: beginStoredQualification.mock.calls[0][1].attemptId,
      observedAttemptId: 'incumbent-attempt', observedRunnerId: 'incumbent-runner',
      candidate: 'incumbent-candidate', repairHead: 'incumbent-repair', runId: 'incumbent-run',
      runnerLiveness: 'unknown', safeNextAction: { code: 'read-release-control' },
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('records the requested runner separately from the incumbent when reservation conflicts', async () => {
    reserveStoredQualificationRunner.mockResolvedValueOnce({
      status: 'conflict', transaction: {
        attemptId: 'scheduled-attempt', phase: 'running', candidate: 'candidate',
        currentPhysicalRunner: { id: 'other-runner', leaseExpiresAtMs: 1234 },
      },
    });
    await getSystemAction('green-checkpoint')!(ctx);
    const event = appendPipelineEvent.mock.calls.map((c) => c[0] as { status: string; detail: unknown })
      .find((e) => e.status === 'skipped-qualification-conflict');
    expect(event?.detail).toMatchObject({
      stage: 'reserve-runner', requestedAttemptId: 'scheduled-attempt',
      requestedRunnerId: reserveStoredQualificationRunner.mock.calls[0][1].runnerId,
      observedRunnerId: 'other-runner', runnerLiveness: 'unknown',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('WI-4310: checkpoint child receives a bounded dedicated DB pool override', async () => {
    delete process.env.PAPERCUSP_CHECKPOINT_DB_POOL_MAX;
    spawnMock.mockImplementationOnce(() => fakeSpawn(okStdout, 0));
    await getSystemAction('green-checkpoint')!(ctx);
    const opts = spawnMock.mock.calls[0]![2] as { env?: Record<string, string> };
    expect(opts.env?.PAPERCUSP_DB_POOL_MAX).toBe(String(DEFAULT_GREEN_CHECKPOINT_DB_POOL_MAX));
  });

  it('WI-4310: checkpoint pool cap is hot-tunable and clamped to one connection', () => {
    process.env.PAPERCUSP_CHECKPOINT_DB_POOL_MAX = '3.9';
    expect(resolveGreenCheckpointDbPoolMax()).toBe(3);
    process.env.PAPERCUSP_CHECKPOINT_DB_POOL_MAX = '0';
    expect(resolveGreenCheckpointDbPoolMax()).toBe(DEFAULT_GREEN_CHECKPOINT_DB_POOL_MAX);
    process.env.PAPERCUSP_CHECKPOINT_DB_POOL_MAX = '-2';
    expect(resolveGreenCheckpointDbPoolMax()).toBe(DEFAULT_GREEN_CHECKPOINT_DB_POOL_MAX);
    delete process.env.PAPERCUSP_CHECKPOINT_DB_POOL_MAX;
  });

  it('P-002: an over-budget memory skip requeues the same routine promptly with the guard intact', async () => {
    memoryAdmissionOverride.value = {
      admit: false,
      reason: 'over-budget',
      requestG: 40,
      committedG: 120,
      budgetG: 125,
      scopes: 3,
      unbounded: 0,
      detail: 'checkpoint-memory: DEFERRING 40 GiB — 120.0 GiB already committed by 3 live scope(s); 160.0 GiB would exceed the 125 GiB budget',
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await getSystemAction('green-checkpoint')!(ctx);

      // The admission still refuses the unsafe launch; this is not a kill-switch or a
      // smaller-scope workaround.
      expect(spawnMock).not.toHaveBeenCalled();
      expect(appendPipelineEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'green_checkpoint',
          status: 'skipped-memory-budget',
          detail: expect.objectContaining({
            reason: 'over-budget',
            committedG: 120,
            requestG: 40,
            budgetG: 125,
            scopes: 3,
          }),
        }),
      );

      // Reuse the same forward-only, active-row, pause-aware retry contract as transient
      // aborts. Once a scope drains, the frozen candidate gets a fresh ordinary attempt
      // within minutes instead of waiting for the next hourly cron tick.
      const update = fakeSql.unsafe.mock.calls.find(([query]) =>
        String(query).includes('next_fire_at = now() + make_interval'),
      );
      expect(update).toBeDefined();
      expect(update![1]).toEqual(['my-harness', TRANSIENT_ABORT_REQUEUE_MINS]);
      const query = String(update![0]);
      expect(query).toContain('active = true');
      expect(query).toContain("metadata->'pause' IS NULL");
      expect(query).toContain('next_fire_at IS NULL OR next_fire_at > now() + make_interval');
    } finally {
      warn.mockRestore();
    }
  });

  describe('WI-6554700010018575: a fire against this root\'s own live run is not a memory-budget skip', () => {
    // Measured 2026-10-20 22:09-23:05Z: 7 papercusp fires were recorded as skipped-memory-budget
    // while papercusp's own run held one of the 3 counted scopes; each armed the 10-minute requeue.
    const overBudget = {
      admit: false,
      reason: 'over-budget' as const,
      requestG: 40,
      committedG: 86,
      budgetG: 125,
      scopes: 3,
      unbounded: 0,
      detail: 'checkpoint-memory: DEFERRING 40 GiB — 86.0 GiB already committed by 3 live scope(s); 126.0 GiB would exceed the 125 GiB budget',
    };
    const liveTransaction = {
      phase: 'running', attemptId: 'attempt-live', candidate: 'candidate-live', repairHead: 'repair-live',
      runId: 'run-live', outcome: { kind: 'pending' }, currentPhysicalRunner: { id: 'runner-live', unit: 'unit-live' },
    };
    const requeueCalls = () =>
      fakeSql.unsafe.mock.calls.filter(([query]) => String(query).includes('next_fire_at = now() + make_interval'));
    const statuses = () =>
      appendPipelineEvent.mock.calls
        .map(([event]) => event as { kind?: string; status?: string })
        .filter((event) => event.kind === 'green_checkpoint')
        .map((event) => event.status);

    it('records a live join (exempt from the non-verdict count), not skipped-memory-budget, and arms no requeue', async () => {
      memoryAdmissionOverride.value = overBudget;
      readStoredQualification.mockResolvedValueOnce({ status: 'present', transaction: liveTransaction });
      beginStoredQualification.mockResolvedValueOnce({ status: 'idempotent', transaction: liveTransaction });
      recordStoredQualificationScheduledFire.mockResolvedValueOnce({ status: 'updated', transaction: liveTransaction });
      probeRunnerLiveness.mockReturnValueOnce('live');

      await getSystemAction('green-checkpoint')!(ctx);

      expect(statuses()).toEqual(['skipped-joined-attempt']);
      expect(appendPipelineEvent).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'green_checkpoint', status: 'skipped-joined-attempt',
        detail: expect.objectContaining({ attemptId: 'attempt-live', runnerId: 'runner-live', runnerLiveness: 'live' }),
      }));
      // One fire, one liveness probe: the pre-admission measurement is reused for the same runner.
      expect(probeRunnerLiveness).toHaveBeenCalledTimes(1);
      expect(requeueCalls()).toHaveLength(0);
      expect(spawnMock).not.toHaveBeenCalled();
      expect(reserveStoredQualificationRunner).not.toHaveBeenCalled();
    });

    it('records skipped-locked when the root\'s run lock is live but no attempt is joinable, without a new attempt or a requeue', async () => {
      memoryAdmissionOverride.value = overBudget;
      runLockOverride.value = { held: true, pid: 4242, elapsedSec: 5400 };
      readStoredQualification.mockResolvedValueOnce({
        status: 'present',
        transaction: { ...liveTransaction, phase: 'terminal', outcome: { kind: 'verdict', verdict: 'not-green' } },
      });

      await getSystemAction('green-checkpoint')!(ctx);

      expect(statuses()).toEqual(['skipped-locked']);
      expect(appendPipelineEvent).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'green_checkpoint', status: 'skipped-locked',
        detail: expect.objectContaining({ stage: 'pre-admission', holderPid: 4242, holderElapsedSec: 5400, attemptId: 'attempt-live' }),
      }));
      expect(beginStoredQualification).not.toHaveBeenCalled();
      expect(requeueCalls()).toHaveLength(0);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('WI-6554700010019013: a hive install probes ITS OWN lock (integration root + hive log dir), not the tooling root', async () => {
      // Measured 2026-10-21 08:38Z: papercusp-pr-drill-20261014's fire probed the canonical tree's
      // lock (routing.root = the tooling root) and skipped while the CANONICAL gate's suite ran.
      runLockOverride.calls.length = 0;
      // Held, so the action stops at the probe (skipped-locked) instead of launching a child.
      runLockOverride.value = { held: true, pid: 4242, elapsedSec: 60 };
      routingPatch = {
        extraEnv: {
          PAPERCUSP_INTEGRATION_ROOT: '/clones/hive-under-test',
          PAPERCUSP_CHECKPOINT_LOG_DIR: '/logs/checkpoint-logs/hive-under-test',
        },
      };
      try {
        readStoredQualification.mockResolvedValueOnce({
          status: 'present',
          transaction: { ...liveTransaction, phase: 'terminal', outcome: { kind: 'verdict', verdict: 'not-green' } },
        });

        await getSystemAction('green-checkpoint')!(ctx);

        expect(runLockOverride.calls[0]).toEqual({
          root: '/clones/hive-under-test',
          logDir: '/logs/checkpoint-logs/hive-under-test',
        });
        expect(statuses()).toEqual(['skipped-locked']);
      } finally {
        routingPatch = null;
        runLockOverride.value = null;
      }
    });

    it('still owes the admission when the expected join becomes a launch at the locked classification', async () => {
      memoryAdmissionOverride.value = overBudget;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        readStoredQualification.mockResolvedValueOnce({ status: 'present', transaction: liveTransaction });
        const settled = { ...liveTransaction, phase: 'waiting', currentPhysicalRunner: null };
        beginStoredQualification.mockResolvedValueOnce({ status: 'updated', transaction: settled });
        recordStoredQualificationScheduledFire.mockResolvedValueOnce({ status: 'updated', transaction: settled });
        probeRunnerLiveness.mockReturnValueOnce('live');

        await getSystemAction('green-checkpoint')!(ctx);

        expect(statuses()).toEqual(['skipped-memory-budget']);
        expect(reserveStoredQualificationRunner).not.toHaveBeenCalled();
        expect(spawnMock).not.toHaveBeenCalled();
        expect(requeueCalls()).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });
  });

  it('falls back to a DIRECT spawn when the scope cannot launch (no user bus) — the gate never red-pins on infra', async () => {
    delete process.env.PAPERCUSP_CHECKPOINT_SCOPE;
    spawnMock
      .mockImplementationOnce(() => fakeSpawnFail('Failed to connect to bus: No such file or directory', 1))
      .mockImplementationOnce(() => fakeSpawn(okStdout, 0));
    await getSystemAction('green-checkpoint')!(ctx);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const [cmd2, args2] = spawnMock.mock.calls[1] as [string, string[]];
    expect(cmd2).toBe('/bin/bash'); // direct wrapper, without a systemd scope
    expect(args2.join(' ')).toContain('green-checkpoint.ts');
    expect(args2.at(-1)).toContain('trap _papercusp_write_checkpoint_terminal EXIT');
    expect(appendPipelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'green_checkpoint', status: 'up-to-date' }),
    );
  });

  it('a PAYLOAD failure inside a healthy scope does NOT retry (one suite run per tick)', async () => {
    delete process.env.PAPERCUSP_CHECKPOINT_SCOPE;
    // Non-zero exit but no scope-launch-shaped stderr → the suite itself failed; no fallback.
    spawnMock.mockImplementationOnce(() => fakeSpawnFail('vitest: 3 tests failed', 1));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await getSystemAction('green-checkpoint')!(ctx);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exited 1'));
    warn.mockRestore();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(appendPipelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'green_checkpoint', status: 'error' }),
    );
  });

  it('PAPERCUSP_CHECKPOINT_SCOPE=0 kill-switch runs the pre-isolation direct spawn', async () => {
    process.env.PAPERCUSP_CHECKPOINT_SCOPE = '0';
    spawnMock.mockImplementationOnce(() => fakeSpawn(okStdout, 0));
    await getSystemAction('green-checkpoint')!(ctx);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).not.toBe('systemd-run');
    expect(cmd).toContain('tsx');
  });
});

/**
 * EI-20709645463022690 — what the gate CHILD actually inherits.
 *
 * The bug was invisible at every layer that reads source or resolver output: the env
 * construction looked right and the suite it broke lived in another repo. It is only
 * observable in the env handed to `spawn`, so that is what these assert — the spawn OPTIONS,
 * never the source text. (Part 2 of this same item shipped a source-regex pin AND a
 * behavioural one precisely because the regex alone proved nothing about the artifact.)
 */
describe('green-checkpoint child env — subject-hive DSN isolation (EI-20709645463022690)', () => {
  const GREEN_MARKER = '__GREEN_CHECKPOINT_RESULT__';
  const okStdout = `${GREEN_MARKER} ${JSON.stringify({ reason: 'up-to-date', green: true })}\n`;
  const AMBIENT_OPERATOR_DSN = 'postgres://operator:pw@127.0.0.1:5432/papercusp_operator_test';
  const PAPERCUSP_ADMIN_DSN = 'postgres://operator:pw@127.0.0.1:5432/papercusp_admin_channel';
  const TOUCHED = ['PAPERCUSP_CHECKPOINT_SCOPE', 'DATABASE_URL', 'PGHOST', 'HARNESS_ADMIN_DATABASE_URL'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
    // Direct spawn (no systemd-run wrapper) so call[0] is the payload itself — the env is
    // identical either way, but this keeps the assertion pointed at one unambiguous call.
    process.env.PAPERCUSP_CHECKPOINT_SCOPE = '0';
    // The operator's ambient DSN, exactly as the routine host carries it into the fire.
    process.env.DATABASE_URL = AMBIENT_OPERATOR_DSN;
    process.env.PGHOST = '127.0.0.1';
  });
  afterEach(() => {
    routingPatch = null;
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  });

  function childEnv(): NodeJS.ProcessEnv {
    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    return opts.env;
  }

  it('a SUBJECT hive: the child loses the ambient DATABASE_URL/PG* and gains the namespaced one', async () => {
    routingPatch = {
      extraEnv: { PAPERCUSP_RELEASE_SLUG: 'sidestage', HARNESS_ADMIN_DATABASE_URL: PAPERCUSP_ADMIN_DSN },
      clearEnv: ['DATABASE_URL', 'PGHOST'],
    };
    spawnMock.mockImplementationOnce(() => fakeSpawn(okStdout, 0));
    await getSystemAction('green-checkpoint')!(ctx);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const env = childEnv();
    // THE BUG: before the fix these two were present and the pot's suite dialed papercusp.
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.PGHOST).toBeUndefined();
    // …and the half that keeps the gate's OWN bookkeeping working after the clear.
    expect(env.HARNESS_ADMIN_DATABASE_URL).toBe(PAPERCUSP_ADMIN_DSN);
    // Scoped deletion, not a wiped env: the rest of the inherited environment is intact
    // (without this control, an env cleared to `{}` would also satisfy the two asserts above).
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.PAPERCUSP_RELEASE_SLUG).toBe('sidestage');
  });

  it('an overlay entry naming a CLEARED key still wins — deletions apply to the inherited env only', async () => {
    // The ordering that makes the fix expressible at all: clear the inherited DATABASE_URL,
    // then let an explicit overlay value (a hive that genuinely supplies its own DSN) land.
    // If the deletion ran AFTER the overlay, this key would come back undefined.
    routingPatch = { extraEnv: { DATABASE_URL: 'postgres://pot-own/db' }, clearEnv: ['DATABASE_URL'] };
    spawnMock.mockImplementationOnce(() => fakeSpawn(okStdout, 0));
    await getSystemAction('green-checkpoint')!(ctx);
    expect(childEnv().DATABASE_URL).toBe('postgres://pot-own/db');
  });

  it("operator-home (clearEnv []) keeps its inherited DSN — papercusp's own pipeline is byte-identical (D-007)", async () => {
    routingPatch = null; // the real resolver: ctx.installSlug IS the mocked operator home
    spawnMock.mockImplementationOnce(() => fakeSpawn(okStdout, 0));
    await getSystemAction('green-checkpoint')!(ctx);
    const env = childEnv();
    expect(env.DATABASE_URL).toBe(AMBIENT_OPERATOR_DSN);
    expect(env.PGHOST).toBe('127.0.0.1');
  });
});

/**
 * EI-17065 — a gate that stops being ROUTABLE must not orphan its
 * green-checkpoint-stall / green-checkpoint-watchdog escalation forever.
 * `trackGateStall` (the only OTHER code that clears GATE_STALL_PHASE) fires only from a
 * real green VERDICT, and a `routing.skip` tick returns before that ever runs — so an
 * escalation open at disable-time could never self-clear on its own. Distinct from
 * EI-8396's dead-install guard in `collectEscalationSignals` (watchdog.ts), which only
 * suppresses the WATCHDOG COLLECTOR when the routine ROW itself is missing/inactive:
 * here the routine is active and firing on schedule, it simply never reaches
 * `trackGateStall` because `resolveCheckpointRouting` returns `skip` first.
 */
describe('green-checkpoint routing skip — EI-17065 escalation auto-clear', () => {
  afterEach(() => {
    routingPatch = null;
  });

  it('WI-10006317: records a misconfigured gate as skipped-misconfigured, not skipped-disabled, and runs no suite', async () => {
    routingPatch = {
      skip: { reason: "integration-equals-release: integration branch 'main' is the release ref itself", misconfigured: true },
    };

    await getSystemAction('green-checkpoint')!(ctx);

    expect(spawnMock).not.toHaveBeenCalled();
    const statuses = appendPipelineEvent.mock.calls
      .map(([event]) => event as Record<string, unknown>)
      .filter((event) => event.kind === 'green_checkpoint')
      .map((event) => event.status);
    expect(statuses).toEqual(['skipped-misconfigured']);
  });

  it('clears BOTH green-checkpoint escalation phases when the gate is not routable (gate_disabled)', async () => {
    routingPatch = { skip: { reason: 'gate_disabled' } };

    await getSystemAction('green-checkpoint')!(ctx);

    // never reaches the suite — that's the whole point of `skip`.
    expect(spawnMock).not.toHaveBeenCalled();
    const events = appendPipelineEvent.mock.calls.map(([event]) => event as Record<string, unknown>);
    const anchor = events.find((event) => event.kind === 'green_checkpoint_fire');
    const outcome = events.find((event) => event.kind === 'green_checkpoint' && event.status === 'skipped-disabled');
    expect(anchor).toMatchObject({
      workspaceId: 'ws-42',
      installSlug: 'my-harness',
      kind: 'green_checkpoint_fire',
      status: 'fired',
      detail: { gateFireId: expect.any(String) },
    });
    expect(outcome).toMatchObject({
      workspaceId: 'ws-42',
      installSlug: 'my-harness',
      kind: 'green_checkpoint',
      status: 'skipped-disabled',
      detail: {
        reason: 'gate_disabled',
        gateFireId: (anchor?.detail as { gateFireId?: string })?.gateFireId,
      },
    });
    expect(fakeSql.unsafe).toHaveBeenCalledWith(
      expect.stringContaining('harness_escalations'),
      [
        'ws-42',
        'my-harness',
        expect.any(Number),
        expect.stringContaining('gate_disabled'),
        ['green-checkpoint-stall', 'green-checkpoint-watchdog'],
      ],
    );
  });

  it('fans out to every skip reason — not_found / no_blueprint / no_repo also mean "no verdict is ever coming"', async () => {
    routingPatch = { skip: { reason: 'not_found' } };

    await getSystemAction('green-checkpoint')!(ctx);

    expect(fakeSql.unsafe).toHaveBeenCalledWith(
      expect.stringContaining('harness_escalations'),
      expect.arrayContaining(['ws-42', 'my-harness', ['green-checkpoint-stall', 'green-checkpoint-watchdog']]),
    );
  });

  it('is best-effort — a DB failure on the clear warns but never throws or blocks the tick', async () => {
    routingPatch = { skip: { reason: 'no_repo' } };
    fakeSql.unsafe.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(getSystemAction('green-checkpoint')!(ctx)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('skipped-disabled escalation clear failed'),
      );
      // the pipeline event still records — the best-effort clear failing must not
      // swallow the (unrelated) skip bookkeeping that already happened first.
      expect(appendPipelineEvent).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'skipped-disabled' }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * WI-4494 — THE RUN THAT PRODUCES A VERDICT IS THE RUN THAT RECORDS IT.
 *
 * Before this, `gate_health` + the pipeline event were written ONLY by the routine that parsed the
 * CLI's stdout. A detached manual run (`release:checkpoint-run`) therefore ran the full suite,
 * computed a real green/red — and threw it away, while HOLDING the run-lock that forced the hourly
 * routine (the only recorder) to log `skipped-locked` and record nothing either. Live 2026-07-12:
 * three consecutive fires skipped, gate_health frozen on a stale red, release pin unmoved ~10h, and
 * the WI-4486 memory-blackout fix unable to ship on a green pin. Our own code had named the root
 * cause ten days earlier — "only ROUTINE-invoked runs write pipeline events / gate_health" — and
 * both prior attempts reconciled the wrong value instead of removing the wrongness.
 */
describe('P-014 durable replay history', () => {
  const target = { workspaceId: 'replay-workspace', installSlug: 'replay-harness' };
  const snapshot = () => captureGateSuiteVerdictReplay({ candidate: 'a'.repeat(40), runId: 'prior', measuredAtMs: 1 }, {
    green: false, infraFault: false, failures: Array.from({ length: 25 }, (_, i) => `product-${i}.test.ts`),
    rootScripts: {}, failingCasesByFile: null,
  });

  it('stores full replay inputs separately from the bounded display signature', () => {
    const replay = snapshot();
    const detail = buildCheckpointDetail({ reason: 'not-green', green: false,
      failingTests: replay.input.failures, suiteVerdictReplay: replay });
    expect((detail.failingTests as string[])).toHaveLength(20);
    expect(detail.suiteVerdictReplay).toEqual(replay);
  });

  it('loads scoped terminal history and retains the exact measured candidate', async () => {
    fakeSql.unsafe.mockResolvedValueOnce(Object.assign([{ replay: snapshot() }], { count: 1 }));
    expect(await readLastGateSuiteVerdictReplay(target)).toEqual(snapshot());
    const [query, values] = fakeSql.unsafe.mock.calls.at(-1)!;
    expect(values).toEqual(['replay-workspace', 'replay-harness']);
    expect(String(query)).toContain("status <> 'decision-pending'");
    expect(String(query)).toContain("candidateSource");
    expect(String(query)).toContain('LIMIT 1');
  });

  it('bootstraps only when no captured row exists', async () => {
    fakeSql.unsafe.mockResolvedValueOnce(Object.assign([], { count: 0 }));
    expect(await readLastGateSuiteVerdictReplay(target)).toBeNull();
  });

  it('refuses corrupt or unsupported latest history instead of falling back to an older success', async () => {
    fakeSql.unsafe.mockResolvedValueOnce(Object.assign([{ replay: { version: 2 } }], { count: 1 }));
    await expect(readLastGateSuiteVerdictReplay(target)).rejects.toThrow(/malformed|unsupported/);
  });

  it('reports failed history reads rather than inventing a missing baseline', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeSql.unsafe.mockRejectedValueOnce(new Error('read failed'));
    try {
      await expect(readLastGateSuiteVerdictReplay(target)).rejects.toThrow(/unavailable/);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('gate-suite-replay-history failed: read failed'));
    } finally { warning.mockRestore(); }
  });
});

describe('WI-4494: recordCheckpointVerdict — the producer records', () => {
  beforeEach(() => {
    appendPipelineEvent.mockClear();
    fakeSql.unsafe.mockClear();
  });

  it('⭐ a lock collision records NOTHING — the run holding the lock has the real verdict', () => {
    // This is the fix's load-bearing asymmetry. A colliding run must stay silent (it observed
    // nothing), while the run that WON the lock records. If a `skipped-locked` could record, it
    // would clobber a real verdict with a non-observation — the same bug, mirrored.
    return recordCheckpointVerdict(
      { workspaceId: 'ws-42', installSlug: 'my-harness' },
      { reason: 'skipped-locked' },
    ).then((recorded) => {
      expect(recorded).toBe(false);
      expect(appendPipelineEvent).not.toHaveBeenCalled();
      expect(fakeSql.unsafe).not.toHaveBeenCalled(); // gate_health untouched
    });
  });

  it('P-003: a non-recordable pre-suite outcome still returns the exact logical attempt to waiting', async () => {
    process.env[CHECKPOINT_QUALIFICATION_ATTEMPT_ENV] = 'attempt-1';
    try {
      const recorded = await recordCheckpointVerdict(
        { workspaceId: 'ws-42', installSlug: 'my-harness' },
        { reason: 'skipped-locked', candidate: 'abc123', runId: 'run-1' },
      );

      expect(recorded).toBe(false);
      expect(recordStoredQualificationVerdict).toHaveBeenCalledWith(
        { workspaceId: 'ws-42', installSlug: 'my-harness' },
        {
          attemptId: 'attempt-1',
          reason: 'skipped-locked',
          green: undefined,
          candidate: 'abc123',
          runId: 'run-1',
          evidenceRefs: ['checkpoint-run:run-1', 'candidate:abc123'],
        },
      );
      expect(appendPipelineEvent).not.toHaveBeenCalled();
    } finally {
      delete process.env[CHECKPOINT_QUALIFICATION_ATTEMPT_ENV];
    }
  });

  it('commits a modern terminal event through qualification once and skips duplicate history on replay', async () => {
    process.env[CHECKPOINT_QUALIFICATION_ATTEMPT_ENV] = 'attempt-1';
    const target = { workspaceId: 'ws-42', installSlug: 'my-harness' };
    const verdict = { reason: 'up-to-date' as const, green: true, candidate: 'abc123def456789', runId: 'run-1' };
    try {
      recordStoredQualificationVerdict.mockResolvedValueOnce({ status: 'updated' });
      expect(await recordCheckpointVerdict(target, verdict)).toBe(true);
      expect(recordStoredQualificationVerdict).toHaveBeenCalledWith(target, expect.objectContaining({
        attemptId: 'attempt-1', runId: 'run-1', terminalEvent: {
          status: 'up-to-date', detail: expect.objectContaining({ runId: 'run-1', candidate: 'abc123def456' }),
        },
      }));
      expect(appendPipelineEvent).not.toHaveBeenCalled();

      fakeSql.unsafe.mockClear();
      recordStoredQualificationVerdict.mockResolvedValueOnce({ status: 'terminal' });
      expect(await recordCheckpointVerdict(target, verdict)).toBe(true);
      expect(appendPipelineEvent).not.toHaveBeenCalled();
      expect(fakeSql.unsafe).not.toHaveBeenCalled();
    } finally {
      delete process.env[CHECKPOINT_QUALIFICATION_ATTEMPT_ENV];
    }
  });

  // WI-10007497: a verdict event that does not name its logical attempt cannot be joined to the
  // attempt's begin/join rows, so attempt-to-verdict latency is unmeasurable by construction.
  it('WI-10007497: the non-atomic append names the attempt the settlement bound (scheduled path, no env)', async () => {
    const target = { workspaceId: 'ws-42', installSlug: 'my-harness' };
    recordStoredQualificationVerdict.mockResolvedValueOnce({ status: 'updated', transaction: { attemptId: 'attempt-global' } });
    expect(await recordCheckpointVerdict(target, { reason: 'not-green', green: false, candidate: 'abc123def456789' })).toBe(true);
    expect(appendPipelineEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'green_checkpoint', status: 'not-green',
      detail: expect.objectContaining({ attemptId: 'attempt-global' }),
    }));
  });

  it('WI-10007497: a conflicting settlement is another attempt\'s row, so its id is never cited', async () => {
    const target = { workspaceId: 'ws-42', installSlug: 'my-harness' };
    recordStoredQualificationVerdict.mockResolvedValueOnce({ status: 'conflict', transaction: { attemptId: 'attempt-other' } });
    expect(await recordCheckpointVerdict(target, { reason: 'not-green', green: false, candidate: 'abc123def456789' })).toBe(true);
    const detail = (appendPipelineEvent.mock.calls[0]?.[0] as { detail: Record<string, unknown> }).detail;
    expect(detail).not.toHaveProperty('attemptId');
  });

  it('WI-10007497: decision-pending carries the transported attempt id', async () => {
    process.env[CHECKPOINT_QUALIFICATION_ATTEMPT_ENV] = 'attempt-pending';
    try {
      expect(await recordPendingCheckpointVerdict(
        { workspaceId: 'ws-42', installSlug: 'my-harness' },
        { reason: 'not-green', green: false, candidate: 'abc123def456789', promotionPending: true, runId: 'run-p' },
      )).toBe(true);
      expect(appendPipelineEvent).toHaveBeenCalledWith(expect.objectContaining({
        status: 'decision-pending', detail: expect.objectContaining({ attemptId: 'attempt-pending' }),
      }));
    } finally {
      delete process.env[CHECKPOINT_QUALIFICATION_ATTEMPT_ENV];
    }
  });

  it('WI-10007497: verdictQualificationAttemptId — env wins; only a binding settlement names an attempt', () => {
    expect(verdictQualificationAttemptId('attempt-env', { status: 'conflict', transaction: { attemptId: 'x' } })).toBe('attempt-env');
    expect(verdictQualificationAttemptId(undefined, { status: 'updated', transaction: { attemptId: 'a' } })).toBe('a');
    expect(verdictQualificationAttemptId(undefined, { status: 'idempotent', transaction: { attemptId: 'b' } })).toBe('b');
    expect(verdictQualificationAttemptId(undefined, { status: 'terminal', transaction: { attemptId: 'c' } })).toBeUndefined();
    expect(verdictQualificationAttemptId(undefined, { status: 'missing' })).toBeUndefined();
    expect(verdictQualificationAttemptId(undefined, null)).toBeUndefined();
  });

  it('⭐ a RED from ANY runner lands in gate_health + the pipeline history', async () => {
    const recorded = await recordCheckpointVerdict(
      { workspaceId: 'ws-42', installSlug: 'my-harness' },
      {
        reason: 'not-green',
        green: false,
        candidate: 'abc123def456789',
        from: '28a3a3d50258',
        failingTests: ['lib/x.test.ts'],
      },
    );
    expect(recorded).toBe(true);
    expect(appendPipelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-42',
        installSlug: 'my-harness',
        kind: 'green_checkpoint',
        status: 'not-green',
        detail: expect.objectContaining({ green: false, candidate: 'abc123def456', failingTests: ['lib/x.test.ts'] }),
      }),
    );
    // …and the gate_health blob was read + written for that harness (the streak now moves).
    expect(fakeSql.unsafe).toHaveBeenCalledWith(expect.stringContaining('gate_health'), ['my-harness', 'ws-42']);
  });

  it.each([
    { candidateSource: 'pinned' as const },
    { diagnostic: 'candidate-pinned' as const },
    {
      candidateSource: 'tip' as const,
      diagnostic: 'candidate-pinned' as const,
    },
  ])(
    'EI-213458: a pinned diagnostic keeps pipeline history but never mutates gate_health ($candidateSource$diagnostic)',
    async (provenance) => {
      const recorded = await recordCheckpointVerdict(
        { workspaceId: 'ws-42', installSlug: 'my-harness' },
        {
          reason: 'not-green',
          green: false,
          candidate: 'abc123def456789',
          failingTests: ['lib/x.test.ts'],
          ...provenance,
        },
      );

      expect(recorded).toBe(true);
      expect(appendPipelineEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'not-green',
          detail: expect.objectContaining({
            green: false,
            candidateSource: 'pinned',
            failingTests: ['lib/x.test.ts'],
          }),
        }),
      );
      expect(recordStoredQualificationVerdict).not.toHaveBeenCalled();
      expect(fakeSql.unsafe).not.toHaveBeenCalled();
    },
  );

  it('EI-213458: a pending pinned diagnostic is history-only too', async () => {
    const recorded = await recordPendingCheckpointVerdict(
      { workspaceId: 'ws-42', installSlug: 'my-harness' },
      {
        reason: 'not-green',
        green: false,
        candidate: 'abc123def456789',
        candidateSource: 'pinned',
        promotionPending: true,
        runId: 'pinned-pending-1',
      },
    );

    expect(recorded).toBe(true);
    expect(appendPipelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'decision-pending',
        detail: expect.objectContaining({ candidateSource: 'pinned' }),
      }),
    );
    expect(fakeSql.unsafe).not.toHaveBeenCalled();
  });

  it('EI-20810521712303819: decision-pending records the red once, then finalizes without double-counting', async () => {
    const target = { workspaceId: 'ws-42', installSlug: 'my-harness' };
    const pendingRecorded = await recordPendingCheckpointVerdict(target, {
      reason: 'not-green',
      green: false,
      candidate: 'abc123def456789',
      from: '28a3a3d50258',
      failingTests: [],
      promotionPending: true,
      runId: 'run-pending-1',
    });

    expect(pendingRecorded).toBe(true);
    expect(appendPipelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'decision-pending',
        detail: expect.objectContaining({
          green: false,
          candidate: 'abc123def456',
          promotionPending: true,
          runId: 'run-pending-1',
        }),
      }),
    );
    const pendingWrite = [...fakeSql.unsafe.mock.calls]
      .reverse()
      .find(([query]) => /UPDATE\s+harness_shared\.routines/i.test(String(query)));
    expect(pendingWrite).toBeDefined();
    const pendingArgs = pendingWrite![1] as unknown[];
    const pendingPayload = JSON.parse(String(pendingArgs[1])) as { gate_health: Record<string, unknown> };
    expect(pendingPayload.gate_health).toMatchObject({
      consecutiveReds: 1,
      lastVerdict: 'decision-pending',
      pendingRunId: 'run-pending-1',
    });

    // Feed the early write back into the final recorder. The same run must finalize
    // the marker while preserving the already-counted streak.
    fakeSql.unsafe.mockResolvedValueOnce(
      Object.assign([{ gh: pendingPayload.gate_health, lf: null }] as unknown[], { count: 1 }),
    );
    const finalRecorded = await recordCheckpointVerdict(target, {
      reason: 'not-green',
      green: false,
      candidate: 'abc123def456789',
      from: '28a3a3d50258',
      failingTests: [],
      runId: 'run-pending-1',
    });

    expect(finalRecorded).toBe(true);
    const finalWrite = [...fakeSql.unsafe.mock.calls]
      .reverse()
      .find(([query]) => /UPDATE\s+harness_shared\.routines/i.test(String(query)));
    expect(finalWrite).toBeDefined();
    const finalArgs = finalWrite![1] as unknown[];
    const finalPayload = JSON.parse(String(finalArgs[1])) as { gate_health: Record<string, unknown> };
    expect(finalPayload.gate_health).toMatchObject({
      consecutiveReds: 1,
      lastVerdict: 'not-green',
      pendingRunId: null,
    });
  });

  it('a GREEN from any runner records too — that is what resets a frozen streak', async () => {
    expect(
      await recordCheckpointVerdict(
        { workspaceId: 'ws-42', installSlug: 'my-harness' },
        { reason: 'advanced', green: true, candidate: 'deadbeefcafe' },
      ),
    ).toBe(true);
    expect(appendPipelineEvent).toHaveBeenCalledWith(expect.objectContaining({ status: 'advanced' }));
  });

  it('buildCheckpointDetail truncates shas to 12 and caps the lists (parity with the routine it replaced)', () => {
    const d = buildCheckpointDetail({
      reason: 'advanced-prefix',
      green: false,
      candidate: 'a'.repeat(40),
      from: 'b'.repeat(40),
      advancedTo: 'c'.repeat(40),
      failingTests: Array.from({ length: 30 }, (_, i) => `t${i}.test.ts`),
    });
    expect(d.candidate).toBe('a'.repeat(12));
    expect(d.from).toBe('b'.repeat(12));
    expect(d.advancedTo).toBe('c'.repeat(12));
    expect((d.failingTests as string[]).length).toBe(20);
  });

  it('green-main-cycle-time P-012: buildCheckpointDetail records the freeze cut and the R1 red legs per candidate', () => {
    const d = buildCheckpointDetail({
      reason: 'not-green',
      green: false,
      candidate: 'a'.repeat(40),
      freezeCut: {
        source: 'known-good',
        reason: 'known-good-selected',
        candidate: 'a'.repeat(40),
        tip: 'b'.repeat(40),
        knownGood: 'a'.repeat(40),
      },
      redLegsAtR1: { candidate: 'a'.repeat(40), source: 'known-good', legs: ['suite', 'lint-tsc'] },
    });
    expect(d.freezeCut).toEqual({
      source: 'known-good',
      reason: 'known-good-selected',
      candidate: 'a'.repeat(12),
      tip: 'b'.repeat(12),
      knownGood: 'a'.repeat(12),
    });
    expect(d.redLegsAtR1).toEqual({ candidate: 'a'.repeat(12), source: 'known-good', legs: ['suite', 'lint-tsc'] });

    // A run with no fresh cut (frozen lineage, explicit candidate) carries neither field.
    const plain = buildCheckpointDetail({ reason: 'advanced', green: true, candidate: 'c'.repeat(40) });
    expect(plain).not.toHaveProperty('freezeCut');
    expect(plain).not.toHaveProperty('redLegsAtR1');
  });

  it('P-013: buildCheckpointDetail keeps a compact per-round reuse record, and drops a malformed one', () => {
    const testPassReuse = {
      judgedSha: 'c58655490ce1a3be734de61df08aa7f8159122d4',
      recordedAtMs: 1_790_530_000_000,
      invocations: 2,
      candidates: 40,
      reused: 31,
      minSavedTestMs: 120_000,
      unmeasured: 1,
      alarms: [{ ws: '@papercusp/web', file: 'a.test.ts', proof: 'abc' }],
      offReasons: [],
      recorder: null,
      headline: 'per-file reuse: 31 of 40 candidate file(s) reused',
    };
    const d = buildCheckpointDetail({ reason: 'advanced', green: true, testPassReuse });
    expect(d.testPassReuse).toEqual({
      judgedSha: 'c58655490ce1',
      candidates: 40,
      reused: 31,
      minSavedTestMs: 120_000,
      unmeasured: 1,
      alarms: 1,
    });
    const bad = buildCheckpointDetail({
      reason: 'advanced',
      green: true,
      testPassReuse: { ...testPassReuse, reused: -1 },
    });
    expect('testPassReuse' in bad).toBe(false);
    const audit = { auditRate: 0.05, audited: 2, eligible: 33, pureReused: 20, alarmCount: 23 };
    const measured = buildCheckpointDetail({
      reason: 'advanced', green: true, testPassReuse: { ...testPassReuse, audit },
    });
    expect(measured.testPassReuse).toMatchObject({
      audit: { ...audit, judgedSha: testPassReuse.judgedSha, recordedAtMs: testPassReuse.recordedAtMs },
    });
    // The archive keeps the whole identity and alarm count even after the display list is capped.
    expect((measured.testPassReuse as { audit: { judgedSha: string } }).audit.judgedSha).toHaveLength(40);
    const auditedFiles = Array.from({ length: 23 }, (_, i) => ({
      invocation: 0, ws: 'core::test', file: `lib/${i}.test.ts`, verdict: 'pass' as const,
      evidenceRef: `suite-output:line:${i}`, judgedSha: testPassReuse.judgedSha,
      runnerIdentity: 'vitest:core', runContext: 'green-checkpoint', runGroupId: null, dirty: false,
    }));
    const named = buildCheckpointDetail({ reason: 'advanced', green: true,
      testPassReuse: { ...testPassReuse, audit, auditedFiles } });
    expect((named.testPassReuse as { auditedFiles: unknown[] }).auditedFiles).toEqual(auditedFiles);
    const suite = { command: 'npm run test:affected', runGroupId: 'run-1',
      startedAtMs: testPassReuse.recordedAtMs - 20, completedAtMs: testPassReuse.recordedAtMs - 10 };
    const scoped = buildCheckpointDetail({ reason: 'advanced', green: true,
      testPassReuse: { ...testPassReuse, audit, auditedFiles, suite } });
    expect(scoped.testPassReuse).toMatchObject({ suite });
    const badScope = buildCheckpointDetail({ reason: 'advanced', green: true,
      testPassReuse: { ...testPassReuse, suite: { ...suite, completedAtMs: suite.startedAtMs - 1 } } });
    expect(badScope.testPassReuse).toMatchObject({ suite: null });
    const badNamed = buildCheckpointDetail({ reason: 'advanced', green: true,
      testPassReuse: { ...testPassReuse, auditedFiles: [{ ...auditedFiles[0], evidenceRef: '' }] } });
    expect((badNamed.testPassReuse as { auditedFiles: unknown }).auditedFiles).toBeNull();
    const malformed = buildCheckpointDetail({
      reason: 'advanced', green: true,
      testPassReuse: { ...testPassReuse, audit: { ...audit, audited: -1 } },
    });
    expect(malformed.testPassReuse).not.toHaveProperty('audit');
  });

  it('P-013: buildCheckpointDetail carries the round phase breakdown whole, and drops a malformed one', () => {
    const roundPhases = {
      totalMs: 90_000,
      phases: [
        { phase: 'candidate-suite', ms: 60_000 },
        { phase: 'other', ms: 30_000 },
      ],
      breakdown: 'total 1m 30s: candidate-suite 1m 00s (67%), other 30s (33%)',
    };
    expect(buildCheckpointDetail({ reason: 'advanced', green: true, roundPhases }).roundPhases).toEqual(roundPhases);
    const bad = buildCheckpointDetail({ reason: 'advanced', green: true, roundPhases: { ...roundPhases, totalMs: 0 } });
    expect('roundPhases' in bad).toBe(false);
  });

  it('round-trips a judged repair head through the real archive writer and reuse audit reader', () => {
    const sha = 'c58655490ce1a3be734de61df08aa7f8159122d4';
    const ws = 'core::test:unit:pure';
    const file = Array.from({ length: 500 }, (_, i) => `lib/audit-${i}.test.ts`)
      .find((name) => auditDraw(name, sha) < 0.05)!;
    const output = [formatTestReuseLine(ws, { candidates: 20, reused: 19, audited: 1, expiredClean: 0 },
      ' auditRate=0.05 lane=pure'),
      formatTestReuseTotalLine({ tasks: 1, summaries: [{ candidates: 20, reused: 19, audited: 1, expiredClean: 0 }],
        savedMs: 100, unmeasured: 0 }),
      'TEST_PASS_REUSE_AUDIT_RESULT ' + JSON.stringify({ version: 1, ws, file, verdict: 'pass',
        judgedSha: sha, runnerIdentity: 'proof-v2 node25 linux x64', runContext: 'green-checkpoint',
        runGroupId: 'repair-run', dirty: false })].join('\n');
    const testPassReuse = buildTestPassReuseHealth(output, sha, 120)!;
    const detail = buildCheckpointDetail({ reason: 'not-green', green: false, candidate: sha,
      gateFireId: 'repair-fire', runId: 'repair-run', testPassReuse, repairQueue: {
        schemaVersion: 1, phase: 'ready-to-verify', candidate: 'b'.repeat(40), base: 'd'.repeat(40),
        repairHead: sha, attempts: 1, openedAtMs: 1, updatedAtMs: 2, fixerSpawnId: null,
        failingTests: ['lib/red.test.ts'], signature: [],
        convergenceRounds: [{ round: 1, head: sha, failingCount: 1, atMs: 120 }],
      } as unknown as FrozenCandidateRepairQueue });
    expect(detail.candidate).toBe('b'.repeat(12));
    expect(detail.testPassReuse).toMatchObject({ audit: { judgedSha: sha } });
    const read = { status: 'complete' as const, windowStartMs: 100, windowEndMs: 200,
      total: 2, reason: null, rows: [
        { id: 'repair-anchor', kind: 'green_checkpoint_fire' as const, status: 'fired', createdAtMs: 110,
          detail: { gateFireId: 'repair-fire' } },
        { id: 'repair-outcome', kind: 'green_checkpoint' as const, status: 'not-green', createdAtMs: 130, detail },
      ] };
    expect(evaluateGateReuseAuditWindow(read)).toMatchObject({ verdict: 'pass', audited: 1,
      runIds: ['repair-run'] });
    (detail.verdictProvenance as Record<string, unknown>).repairHeadVerdict = 'not-judged';
    expect(evaluateGateReuseAuditWindow(read).verdict).toBe('unknown');
  });

  it('P-001: buildCheckpointDetail preserves the producer gate-fire identity or a valid fallback', () => {
    const direct = buildCheckpointDetail(
      { reason: 'advanced', green: true, gateFireId: 'producer-fire' },
      'launcher-fire',
    );
    expect(direct.gateFireId).toBe('producer-fire');

    const fallback = buildCheckpointDetail({ reason: 'advanced', green: true }, 'launcher-fire');
    expect(fallback.gateFireId).toBe('launcher-fire');

    const invalid = buildCheckpointDetail({ reason: 'advanced', green: true }, "bad'; touch /tmp/pwned; '");
    expect(invalid.gateFireId).toBeUndefined();
    expect(JSON.stringify(invalid)).not.toContain('touch /tmp/pwned');
  });

  it('EI-218328: buildCheckpointDetail persists only bounded run-bound checkpoint evidence', () => {
    const d = buildCheckpointDetail({
      reason: 'not-green',
      green: false,
      checkpointEvidence: {
        logPath: '/var/lib/papercusp/checkpoint-logs/oddsmith-run.log',
        runId: 'run-oddsmith-1',
        integrationRoot: '/srv/oddsmith',
      },
    });

    expect(d.checkpointEvidence).toEqual({
      logPath: '/var/lib/papercusp/checkpoint-logs/oddsmith-run.log',
      runId: 'run-oddsmith-1',
      integrationRoot: '/srv/oddsmith',
    });
    expect(Object.keys(d.checkpointEvidence as object).sort()).toEqual(['integrationRoot', 'logPath', 'runId']);
  });

  it('P-009: buildCheckpointDetail persists the repair-tick legs measurement bounded, with leg names', () => {
    const d = buildCheckpointDetail({
      reason: 'repair-in-progress',
      green: null,
      candidate: 'a'.repeat(40),
      repairTickLegs: {
        head: 'd'.repeat(40),
        atMs: 5,
        ok: false,
        failingSignatures: ['lint:tsc'],
        legs: [{ id: 'lint:tsc', status: 'fail', durationMs: 7.9, outputTail: 'x'.repeat(600) }],
      },
    });
    // The hold tick's ledger row must carry the LEG NAMES (test_runs structurally cannot),
    // bounded exactly like every sibling detail block.
    expect(d.repairTickLegs).toMatchObject({
      head: 'd'.repeat(12),
      atMs: 5,
      ok: false,
      failingSignatures: ['lint:tsc'],
    });
    const legs = (d.repairTickLegs as { legs: Array<Record<string, unknown>> }).legs;
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ id: 'lint:tsc', status: 'fail', durationMs: 7 });
    expect((legs[0].outputTail as string).length).toBe(500);
  });

  it('WI-39944: buildCheckpointDetail preserves the bounded repair-queue identity needed by durable readers', () => {
    const d = buildCheckpointDetail({
      reason: 'not-green',
      green: false,
      repairQueue: {
        schemaVersion: 1,
        phase: 'awaiting-fixer',
        candidate: 'a'.repeat(40),
        base: 'b'.repeat(40),
        repairHead: 'c'.repeat(40),
        affectedTestProofGroup: 'initial-proof-run',
        attempts: 2,
        openedAtMs: 1,
        updatedAtMs: 2,
        fixerSpawnId: 'fixer-2',
        failingTests: ['lib/broken.test.ts'],
    signature: [],
      },
    });

    expect(d.repairQueue).toEqual({
      phase: 'awaiting-fixer',
      candidate: 'a'.repeat(12),
      repairHead: 'c'.repeat(12),
      affectedTestProofGroup: 'initial-proof-run',
      attempts: 2,
      fixerSpawnId: 'fixer-2',
    });
  });

  it('P-003: durable checkpoint detail separates frozenCandidate from a mutable no-suite repairHead', () => {
    const d = buildCheckpointDetail({
      reason: 'not-green',
      green: false,
      // A no-suite verdict may carry the repair head in the legacy candidate field. The
      // serialized status must replace that compatibility value with the immutable pin.
      candidate: 'c'.repeat(40),
      repairQueue: {
        schemaVersion: 1,
        phase: 'awaiting-fixer',
        candidate: 'a'.repeat(40),
        base: 'b'.repeat(40),
        repairHead: 'c'.repeat(40),
        attempts: 1,
        openedAtMs: 1,
        updatedAtMs: 2,
        fixerSpawnId: 'fixer-2',
        failingTests: ['lib/red.test.ts'],
    signature: [],
      },
    });

    expect(d).toMatchObject({
      candidate: 'a'.repeat(12),
      frozenCandidate: 'a'.repeat(12),
      repairHead: 'c'.repeat(12),
      verdictProvenance: {
        frozenCandidate: 'a'.repeat(12),
        repairHead: 'c'.repeat(12),
        phase: 'awaiting-fixer',
        frozenCandidateVerdict: 'full-gate-red',
        repairHeadVerdict: 'not-judged',
      },
    });
  });

  it('EI-203121: buildCheckpointDetail persists bounded per-leg execution identity beside repairQueue', () => {
    const d = buildCheckpointDetail({
      reason: 'not-green',
      green: false,
      repairQueue: {
        schemaVersion: 1,
        phase: 'awaiting-fixer',
        candidate: 'a'.repeat(40),
        base: 'b'.repeat(40),
        repairHead: 'c'.repeat(40),
        attempts: 1,
        openedAtMs: 1,
        updatedAtMs: 2,
        fixerSpawnId: 'fixer-1',
        failingTests: ['lib/broken.test.ts'],
    signature: [],
      },
      postSuiteLegs: Array.from({ length: 35 }, (_, index) => ({
        id: `leg-${index}-${'i'.repeat(200)}`,
        status: 'failed' as const,
        durationMs: 12.9,
        skipReason: 's'.repeat(700),
        executionIdentity: {
          runId: 'r'.repeat(200),
          candidate: 'c'.repeat(80),
          treeDir: '/tree/'.padEnd(1200, 't'),
          cwd: '/cwd/'.padEnd(1200, 'w'),
          headAtStart: 'h'.repeat(80),
          dependencies: {
            nodeModules: {
              hash: 'd'.repeat(200),
              inode: 42,
              source: '/deps/'.padEnd(1200, 'd'),
            },
          },
          setup: { identity: 'u'.repeat(300), output: 'o'.repeat(1500) },
          result: {
            status: 'failed' as const,
            exit: 'completed' as const,
            exitCode: 1,
            output: 'x'.repeat(2500),
          },
        },
      })),
    });

    type SerializedLeg = {
      id: string;
      durationMs: number;
      skipReason: string;
      executionIdentity: {
        runId: string;
        candidate: string;
        treeDir: string;
        cwd: string;
        headAtStart: string;
        dependencies: { nodeModules: { hash: string; source: string } };
        setup: { identity: string; output: string };
        result: { output: string };
      };
    };
    const legs = d.postSuiteLegs as SerializedLeg[];
    expect(legs).toHaveLength(32);
    expect(legs[0].id).toHaveLength(128);
    expect(legs[0].durationMs).toBe(12);
    expect(legs[0].skipReason).toHaveLength(500);
    expect(legs[0].executionIdentity).toMatchObject({
      runId: 'r'.repeat(128),
      candidate: 'c'.repeat(64),
      headAtStart: 'h'.repeat(64),
      result: { status: 'failed', exit: 'completed', exitCode: 1 },
    });
    expect(legs[0].executionIdentity.treeDir).toHaveLength(1000);
    expect(legs[0].executionIdentity.cwd).toHaveLength(1000);
    expect(legs[0].executionIdentity.dependencies.nodeModules.hash).toHaveLength(128);
    expect(legs[0].executionIdentity.dependencies.nodeModules.source).toHaveLength(1000);
    expect(legs[0].executionIdentity.setup.identity).toHaveLength(200);
    expect(legs[0].executionIdentity.setup.output).toHaveLength(1000);
    expect(legs[0].executionIdentity.result.output).toHaveLength(2000);
    expect(d.repairQueue).toMatchObject({ phase: 'awaiting-fixer', fixerSpawnId: 'fixer-1' });
  });

  it("EI-15849: buildCheckpointDetail persists isolationNote even when the gate is NOT absorbed (red) — the absorber's reasoning must survive past the truncated console log", () => {
    const d = buildCheckpointDetail({
      reason: 'not-green',
      green: false,
      candidate: 'a'.repeat(40),
      isolationNote: 'isolation: 1 file(s) STILL FAILED in isolation — real break, gate stays red: @p/core::a.test.ts',
    });
    expect(d.isolationNote).toBe(
      'isolation: 1 file(s) STILL FAILED in isolation — real break, gate stays red: @p/core::a.test.ts',
    );
  });

  // EI-18685042025868279: the durable record is where "was this green clean?" has to be
  // answerable. If the retry accounting stops at the broadcast, /admin/git and every gate
  // history reader still cannot tell a retry-absorbed green from a clean one — which IS the
  // defect, merely moved one layer down.
  it('P036: persists structured failing paths independently from bounded output tails', () => {
    const paths = ['packages/core/first.ts', 'packages/core/second.ts'];
    const detail = buildCheckpointDetail({ reason: 'not-green', green: false,
      postSuiteLegs: [{ id: 'lint:tsc', status: 'failed', durationMs: 1, subjectPaths: paths }],
      repairTickLegs: { head: 'a'.repeat(40), atMs: 1, ok: false, failingSignatures: ['lint:tsc'],
        legs: [{ id: 'lint:tsc', status: 'fail', durationMs: 1, subjectPaths: paths, outputTail: 'first/file.ts ' + 'x'.repeat(2000) }],
      },
    });
    expect(detail.postSuiteLegs).toEqual([expect.objectContaining({ subjectPaths: paths })]);
    expect(detail.repairTickLegs).toMatchObject({ legs: [expect.objectContaining({ subjectPaths: paths, outputTail: expect.stringMatching(/^first\/file.ts/) })] });
  });

  it('EI-18685042025868279: buildCheckpointDetail persists cleanGreen:FALSE — the one value a truthiness check would silently drop', () => {
    const d = buildCheckpointDetail({
      reason: 'advanced',
      green: true,
      candidate: 'a'.repeat(40),
      cleanGreen: false,
      retriedTests: [
        { name: '@p/core::flaky.test.ts', attempts: 3, outcome: 'passed-on-rerun', via: 'load-flake-isolation' },
      ],
    });
    // `if (v.cleanGreen)` would drop this and leave a retry-absorbed green recorded exactly
    // like a clean one. Asserting the FALSE case is the whole point of the test.
    expect(d.cleanGreen).toBe(false);
    expect(d.retriedTests).toEqual([
      { name: '@p/core::flaky.test.ts', attempts: 3, outcome: 'passed-on-rerun', via: 'load-flake-isolation' },
    ]);
  });

  it('EI-18685042025868279: an ABSENT cleanGreen stays absent — unknown is never recorded as false', () => {
    // An older CLI does not report it. Recording `false` there would fabricate a "not
    // clean" claim from no evidence at all.
    const d = buildCheckpointDetail({ reason: 'advanced', green: true, candidate: 'a'.repeat(40) });
    expect('cleanGreen' in d).toBe(false);
    expect('retriedTests' in d).toBe(false);
  });

  it('EI-15849: buildCheckpointDetail caps an oversized isolationNote at 2000 chars', () => {
    const d = buildCheckpointDetail({ reason: 'not-green', green: false, isolationNote: 'x'.repeat(5000) });
    expect((d.isolationNote as string).length).toBe(2000);
  });

  it('EI-20702428259478130: a CRASHED verdict is distinguishable from a real red in the durable record', () => {
    // The defect this guards: `summary` and `crashed` were the only CheckpointVerdict fields
    // buildCheckpointDetail never copied, so an infra death and a genuine test failure both
    // landed as status='not-green' + {green:false, runId, candidate} and NOTHING else. Observed
    // 2026-08-17 on oddsmith: four consecutive not-green verdicts whose suite passed 4460/4460,
    // indistinguishable in the ledger from a real red.
    const crashed = buildCheckpointDetail({
      reason: 'not-green',
      green: false,
      candidate: 'a'.repeat(40),
      runId: 'run-1',
      crashed: true,
      summary: 'Error: does not provide an export named X',
    });
    const realRed = buildCheckpointDetail({
      reason: 'not-green',
      green: false,
      candidate: 'a'.repeat(40),
      runId: 'run-2',
      failingTests: ['@p/core::broken.test.ts'],
    });

    // The whole point: these two must NOT serialize to the same shape.
    expect(crashed.crashed).toBe(true);
    expect(crashed.summary).toBe('Error: does not provide an export named X');
    expect('crashed' in realRed).toBe(false);
    expect(realRed.failingTests).toEqual(['@p/core::broken.test.ts']);
    expect('failingTests' in crashed).toBe(false);
  });

  it('EI-20702428259478130: an ABSENT crashed stays absent — a clean exit is never fabricated', () => {
    // `detail.crashed = v.crashed` (or a truthiness-free copy) would write `crashed: false` on
    // every ordinary verdict, asserting a clean exit that nobody measured — the same failure
    // mode the cleanGreen tests above guard, one field over.
    const d = buildCheckpointDetail({ reason: 'not-green', green: false, candidate: 'a'.repeat(40) });
    expect('crashed' in d).toBe(false);
    expect('summary' in d).toBe(false);
  });

  it('EI-20702428259478130: buildCheckpointDetail caps an oversized summary at 2000 chars', () => {
    const d = buildCheckpointDetail({ reason: 'not-green', green: false, summary: 'x'.repeat(5000) });
    expect((d.summary as string).length).toBe(2000);
  });

  it('EI-18685041726970077: buildCheckpointDetail persists the gate lineage (candidate/tip truncated to 12, list capped)', () => {
    const d = buildCheckpointDetail({
      reason: 'not-green',
      green: false,
      candidate: 'a'.repeat(40),
      lineage: {
        candidate: 'a'.repeat(40),
        tip: 'b'.repeat(40),
        commitsBehind: 5,
        failingFilesChangedInRange: Array.from({ length: 30 }, (_, i) => `t${i}.test.ts`),
      },
    });
    expect(d.lineage).toEqual({
      candidate: 'a'.repeat(12),
      tip: 'b'.repeat(12),
      commitsBehind: 5,
      failingFilesChangedInRange: Array.from({ length: 20 }, (_, i) => `t${i}.test.ts`),
    });
  });

  it('EI-20215068298600724: buildCheckpointDetail persists unmatched failing files (capped)', () => {
    const d = buildCheckpointDetail({
      reason: 'not-green',
      green: false,
      candidate: 'a'.repeat(40),
      lineage: {
        candidate: 'a'.repeat(40),
        tip: 'b'.repeat(40),
        commitsBehind: 5,
        failingFilesChangedInRange: ['packages/operator-core/lib/a.test.ts'],
        failingFilesUnchangedInRange: Array.from({ length: 30 }, (_, i) => `lib/u${i}.test.ts`),
      },
    });
    expect((d.lineage as Record<string, unknown>).failingFilesUnchangedInRange).toEqual(
      Array.from({ length: 20 }, (_, i) => `lib/u${i}.test.ts`),
    );
  });

  it('buildCheckpointDetail omits lineage entirely when absent (no lineage read this run)', () => {
    const d = buildCheckpointDetail({ reason: 'not-green', green: false, candidate: 'a'.repeat(40) });
    expect(d.lineage).toBeUndefined();
  });

  /*
   * EI-20063423357086565. Every OTHER leg of this record is derived from commits, so a
   * durable row can show "candidate IS the tip, 0 behind, nothing changed in range" — three
   * true commit-based facts that together read as a confirmed real red — while the fix sat
   * uncommitted on disk the whole time. That is the row a later reader does archaeology
   * against, so the non-commit leg has to survive into it.
   */
  it('EI-20063423357086565: buildCheckpointDetail persists failingFilesDirtyUncommitted (capped), so the durable row cannot re-state the false confidence', () => {
    const d = buildCheckpointDetail({
      reason: 'not-green',
      green: false,
      candidate: 'a'.repeat(40),
      lineage: {
        candidate: 'a'.repeat(40),
        tip: 'a'.repeat(40), // candidate IS the tip — the confident, and here WRONG, shape
        commitsBehind: 0,
        failingFilesChangedInRange: [],
        failingFilesDirtyUncommitted: Array.from({ length: 30 }, (_, i) => `d${i}.test.ts`),
      },
    });
    expect((d.lineage as Record<string, unknown>).failingFilesDirtyUncommitted).toEqual(
      Array.from({ length: 20 }, (_, i) => `d${i}.test.ts`),
    );
  });

  it('EI-20063423357086565: an EMPTY dirty list is omitted rather than written as a measured []', () => {
    // CONTROL for the test above — proves that assertion is driven by the field's value and
    // not by the key being written unconditionally. An empty array persisted here would read
    // as "we checked and the tree was clean", a claim this leg is not entitled to make.
    const d = buildCheckpointDetail({
      reason: 'not-green',
      green: false,
      candidate: 'a'.repeat(40),
      lineage: {
        candidate: 'a'.repeat(40),
        tip: 'b'.repeat(40),
        commitsBehind: 2,
        failingFilesChangedInRange: [],
        failingFilesDirtyUncommitted: [],
      },
    });
    expect((d.lineage as Record<string, unknown>).failingFilesDirtyUncommitted).toBeUndefined();
  });

  /**
   * WI-7290. The durable record carried the WEAK proxy (lineage: "a failing file was modified
   * somewhere in the range") but not the DIRECT measurement (retriage: "we re-ran those exact
   * files at tip"). Three filings in one night each re-derived the latter from raw logs because
   * an absent field reads identically to "the gate never checked".
   */
  describe('WI-7290: the re-triage verdict reaches the DURABLE record, not just gate_health', () => {
    it('⭐ persists a real-red-at-tip re-triage — the finding gate_health deliberately drops', () => {
      // gate_health keeps only the stale-candidate case (retriageStaleTip/retriageDetail are
      // paired + cleared so a stale note cannot outlive its verdict). That is correct there, and
      // it is exactly why THIS verdict — "we re-ran them at tip and they still fail" — has to
      // survive here instead: it is the single most decision-relevant fact about a red.
      const d = buildCheckpointDetail({
        reason: 'not-green',
        green: false,
        candidate: 'a'.repeat(40),
        retriage: {
          classification: 'real-red',
          tip: 'b'.repeat(40),
          tipObservedAtMs: 1_775_000_000_000,
          detail: '6 failing file(s) REPRODUCE at tip bbbbbbbb',
        },
      });
      expect(d.retriage).toEqual({
        classification: 'real-red',
        tip: 'b'.repeat(12),
        tipObservedAtMs: 1_775_000_000_000,
        detail: '6 failing file(s) REPRODUCE at tip bbbbbbbb',
      });
    });

    it('⭐ persists an `unknown` re-triage WITH its skip reason — "never measured" must not read as "measured and real"', () => {
      const d = buildCheckpointDetail({
        reason: 'not-green',
        green: false,
        candidate: 'a'.repeat(40),
        retriage: {
          classification: 'unknown',
          tip: 'b'.repeat(40),
          detail: 'tip re-run SKIPPED: none of the 2 failing entries could be turned into something re-runnable',
        },
      });
      expect((d.retriage as { classification: string }).classification).toBe('unknown');
      expect((d.retriage as { detail: string }).detail).toContain('SKIPPED');
    });

    it('caps an oversized detail at 500 chars and tolerates a null tip', () => {
      const d = buildCheckpointDetail({
        reason: 'not-green',
        green: false,
        retriage: { classification: 'unknown', tip: null, detail: 'x'.repeat(2000) },
      });
      expect((d.retriage as { detail: string }).detail).toHaveLength(500);
      expect((d.retriage as { tip: string | null }).tip).toBeNull();
      expect((d.retriage as { tipObservedAtMs: number | null }).tipObservedAtMs).toBeNull();
    });

    it('omits retriage entirely when the run produced none (a green tick records no verdict about staleness)', () => {
      const d = buildCheckpointDetail({ reason: 'advanced', green: true, candidate: 'a'.repeat(40) });
      expect(d.retriage).toBeUndefined();
    });
  });
});

describe('P-303: signed gate-verdict producer', () => {
  const candidate = 'a'.repeat(40);
  const target = { workspaceId: 'ws-42', installSlug: 'my-harness' };

  it('WI-10003241: a stalled optional shard publisher releases the gate tail at its deadline', async () => {
    vi.useFakeTimers();
    try {
      const logs: string[] = [];
      const running = publishSignedGateVerdictsWithDeadline(
        () => new Promise(() => {}),
        (line) => logs.push(line),
        30,
      );
      await vi.advanceTimersByTimeAsync(30);
      expect(await running).toEqual({ published: 0, skipped: 0, reason: 'deadline-exceeded' });
      expect(logs).toEqual([
        'signed gate shard publication started (deadline 30ms)',
        'signed gate shard publication deadline-exceeded in 30ms',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('WI-10003241: a completed shard publication retains its result and clears the deadline', async () => {
    vi.useFakeTimers();
    try {
      const logs: string[] = [];
      expect(await publishSignedGateVerdictsWithDeadline(
        async () => ({ published: 2, skipped: 1 }),
        (line) => logs.push(line),
        30,
      )).toEqual({ published: 2, skipped: 1 });
      expect(logs[1]).toBe('signed gate shard publication completed in 0ms');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('WI-6554700010009547: a zero budget never starts the publisher (the self-watchdog record path)', async () => {
    const logs: string[] = [];
    const publish = vi.fn(async () => ({ published: 1, skipped: 0 }));
    expect(await publishSignedGateVerdictsWithDeadline(publish, (line) => logs.push(line), 0))
      .toEqual({ published: 0, skipped: 0, reason: 'skipped-no-budget' });
    expect(publish).not.toHaveBeenCalled();
    expect(logs).toEqual(['signed gate shard publication skipped (no time budget)']);
  });

  function signedVerdictDeps(overrides: Partial<import('./release-actions').SignedGateVerdictPublishDeps> = {}) {
    const inserted: Array<{ target: typeof target; hiveHomeSlug: string | null; signed: import('../../sync/pot-git/gate/verdicts').GateVerdict; verdictId: string }> = [];
    const base: import('./release-actions').SignedGateVerdictPublishDeps = {
      loadHarnessRegistry: async () => ({
        projects: [{ slug: 'my-harness', path: '/tmp/my-harness', harness_kind: 'hive', pot_repo_key: 'repo-pin' }],
      }),
      buildShardManifestAtSha: async () => ({
        manifest: {
          shards: [
            { shardId: '@p/core::unit', workspaceDir: 'packages/core', layer: 'unit' },
            { shardId: '@p/core::integration', workspaceDir: 'packages/core', layer: 'integration' },
          ],
        },
        inputsHashByShardId: {
          '@p/core::unit': '1'.repeat(64),
          '@p/core::integration': '2'.repeat(64),
        },
      }),
      readTestRuns: async () => [
        {
          file_path: 'packages/core/src/core.test.ts',
          status: 'pass',
          duration_ms: 12,
          finished_at: '2026-09-01T00:00:01.000Z',
        },
        {
          file_path: 'packages/core/integration/core.integration.test.ts',
          status: 'fail',
          duration_ms: 9,
          finished_at: '2026-09-01T00:00:02.000Z',
        },
      ],
      resolveLocalGithubIdentity: async () => ({ kind: 'ok', githubUserId: 7 }),
      resolveDeviceKeychainId: (id) => `github:${id}`,
      loadOrGenerateDeviceKeypair: async () => ({ pubkeyBase64: Buffer.alloc(32).toString('base64') }),
      signWithDeviceKey: async () => Buffer.from('signature'),
      insertGateVerdict: async (row) => {
        inserted.push(row);
      },
      ...overrides,
    };
    return { base, inserted };
  }

  it('fails closed before any dependency work when run identity is incomplete', async () => {
    const { base, inserted } = signedVerdictDeps();
    const result = await publishSignedGateVerdicts(target, { reason: 'up-to-date', candidate: 'short', runId: 'run-1' }, base);
    expect(result).toEqual({ published: 0, skipped: 0, reason: 'missing-run-identity' });
    expect(inserted).toHaveLength(0);
  });

  it('publishes one signed fact per evidenced shard with measured outcome and duration', async () => {
    const { base, inserted } = signedVerdictDeps();
    const result = await publishSignedGateVerdicts(
      target,
      { reason: 'up-to-date', green: true, candidate, runId: 'run-1' },
      base,
    );
    expect(result).toEqual({ published: 2, skipped: 0 });
    expect(inserted).toHaveLength(2);
    expect(inserted.map((r) => [r.hiveHomeSlug, r.signed.repo_key, r.signed.staging_sha, r.signed.shard_id, r.signed.verdict, r.signed.duration_ms])).toEqual([
      ['my-harness', 'repo-pin', candidate, '@p/core::unit', 'pass', 12],
      ['my-harness', 'repo-pin', candidate, '@p/core::integration', 'fail', 9],
    ]);
    expect(inserted.map((r) => r.signed.ts)).toEqual([
      Date.parse('2026-09-01T00:00:01.000Z'),
      Date.parse('2026-09-01T00:00:02.000Z'),
    ]);
    expect(inserted[0].verdictId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('retries with the same evidence-addressed verdict ids instead of publishing another fact set', async () => {
    const attemptedIds: string[] = [];
    const attemptedTimestamps: number[] = [];
    const persistedIds = new Set<string>();
    const { base } = signedVerdictDeps({
      insertGateVerdict: async (row) => {
        attemptedIds.push(row.verdictId);
        attemptedTimestamps.push(row.signed.ts);
        // Mirrors INSERT ... ON CONFLICT (workspace_id, verdict_id) DO NOTHING.
        persistedIds.add(row.verdictId);
      },
    });

    await publishSignedGateVerdicts(
      target,
      { reason: 'up-to-date', green: true, candidate, runId: 'run-1' },
      base,
    );
    await publishSignedGateVerdicts(
      target,
      { reason: 'up-to-date', green: true, candidate, runId: 'run-1' },
      base,
    );

    expect(attemptedIds.slice(2)).toEqual(attemptedIds.slice(0, 2));
    expect(attemptedTimestamps.slice(2)).toEqual(attemptedTimestamps.slice(0, 2));
    expect(persistedIds.size).toBe(2);
  });

  it('uses the final attempt per file so a later pass supersedes a historical failure', async () => {
    const { base, inserted } = signedVerdictDeps({
      readTestRuns: async () => [
        {
          id: 41,
          file_path: 'packages/core/src/retried.test.ts',
          status: 'fail',
          duration_ms: 30,
          finished_at: '2026-09-01T00:00:00.000Z',
        },
        {
          id: 42,
          file_path: 'packages/core/src/retried.test.ts',
          status: 'pass',
          duration_ms: 7,
          finished_at: '2026-09-01T00:00:01.000Z',
        },
      ],
    });

    const result = await publishSignedGateVerdicts(
      target,
      { reason: 'up-to-date', green: true, candidate, runId: 'run-1' },
      base,
    );

    expect(result).toEqual({ published: 1, skipped: 1 });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].signed).toMatchObject({
      shard_id: '@p/core::unit',
      verdict: 'pass',
      duration_ms: 7,
    });
  });

  it('does not turn skipped or cancelled rows into a signed pass', async () => {
    const { base, inserted } = signedVerdictDeps({
      readTestRuns: async () => [{
        file_path: 'packages/core/src/core.test.ts',
        status: 'skip',
        duration_ms: 12,
        finished_at: '2026-09-01T00:00:01.000Z',
      }],
    });
    const result = await publishSignedGateVerdicts(target, { reason: 'up-to-date', candidate, runId: 'run-1' }, base);
    expect(result).toEqual({ published: 0, skipped: 1, reason: 'no-test-rows' });
    expect(inserted).toHaveLength(0);
  });

  it('fails closed rather than substituting a wall-clock timestamp for incomplete evidence', async () => {
    const { base, inserted } = signedVerdictDeps({
      readTestRuns: async () => [{ file_path: 'packages/core/src/core.test.ts', status: 'pass', duration_ms: 12 }],
    });
    const result = await publishSignedGateVerdicts(target, { reason: 'up-to-date', candidate, runId: 'run-1' }, base);
    expect(result).toEqual({ published: 0, skipped: 1, reason: 'no-test-rows' });
    expect(inserted).toHaveLength(0);
  });
});

describe('WI-39944: the repair queue persists on the existing routine metadata row', () => {
  const target = { workspaceId: 'ws-42', installSlug: 'my-harness' };
  const queue: FrozenCandidateRepairQueue = {
    schemaVersion: 1,
    phase: 'ready-to-verify',
    candidate: 'a'.repeat(40),
    base: 'b'.repeat(40),
    repairHead: 'c'.repeat(40),
    affectedTestProofGroup: 'initial-proof-run',
    attempts: 1,
    openedAtMs: 1,
    updatedAtMs: 2,
    fixerSpawnId: 'fixer-1',
    failingTests: ['lib/broken.test.ts'],
    signature: [],
  };

  it.each(['current', 'foreign', 'missing'] as const)('P036: writer admits only %s-head lint path evidence', async (kind) => {
    const lintQueue = { ...queue, failingTests: ['lint:tsc'], signature: [{ id: 'lint:tsc', kind: 'lint-leg' as const,
      recipe: 'npm run lint:tsc', admittedRound: 1, measuredHead: queue.repairHead }] };
    fakeSql.unsafe.mockResolvedValueOnce(sqlRows([{ legs: {
      ...(kind === 'missing' ? {} : { head: kind === 'current' ? queue.repairHead.slice(0, 12) : 'f'.repeat(12) }),
      legs: [{ id: 'lint:tsc', status: 'fail', subjectPaths: ['packages/core/violating.ts'], outputTail: 'generic trailer' }],
    } }])).mockResolvedValueOnce(sqlRows([{ written: true }]));
    await writeFrozenCandidateRepairQueue(target, lintQueue, { expectedUpdatedAtMs: lintQueue.updatedAtMs });
    const write = fakeSql.unsafe.mock.calls.find(([query]) => /metadata = jsonb_set/.test(String(query)));
    expect(write).toBeDefined();
    const params = write?.[1];
    if (!Array.isArray(params)) throw new Error('queue write must carry positional SQL parameters');
    const persisted = JSON.parse(String(params[2])).repair_queue;
    const row = persisted.manifest.rows.find((entry: { legId: string }) => entry.legId === 'lint:tsc');
    expect(row.subjectPaths).toEqual(kind === 'current' ? ['packages/core/violating.ts'] : []);
    expect(row.admitCommand !== null).toBe(kind === 'current');
  });

  it('P-025: returns explicit unreadable state and makes the legacy reader throw on schema skew', async () => {
    const newer = {
      ...queue,
      schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION + 1,
    };
    fakeSql.unsafe.mockResolvedValueOnce(sqlRows([{ repair_queue: newer }]));
    await expect(readFrozenCandidateRepairQueueState(target)).resolves.toEqual({
      status: 'unreadable',
      reason: 'schema-newer-than-reader',
      schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION + 1,
      // Best-effort identity from the raw row (frozen-candidate-repair-queue.ts): a newer
      // writer's row is unreadable, but its stable coordinates still say WHICH frozen queue
      // was preserved instead of collapsing it to "none".
      candidate: queue.candidate,
      repairHead: queue.repairHead,
      phase: queue.phase,
    });

    fakeSql.unsafe.mockResolvedValueOnce(sqlRows([{ repair_queue: newer }]));
    await expect(readFrozenCandidateRepairQueue(target)).rejects.toThrow(
      /refusing to treat a persisted row as absent/,
    );
  });

  it('round-trips the queue and scopes every read/write/clear to its workspace routine row', async () => {
    fakeSql.unsafe.mockResolvedValueOnce(sqlRows([{ repair_queue: queue }]));

    await expect(readFrozenCandidateRepairQueue(target)).resolves.toEqual({
      ...queue,
      schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
      // Schema v3 added qualificationAttemptId. The parser deliberately materializes it as an
      // explicit null for a legacy (v1) row rather than leaving it absent, because retirement
      // of an unstarted queue matches on the exact predecessor id — a missing key and a null
      // must both read as "no qualification", keeping a legacy queue fail-closed.
      qualificationAttemptId: null,
      // P-006: a legacy row persisted with no typed signature gets one DERIVED from its flat
      // list on read (schema 4), stamped with the row's repair head and round 1, so an older
      // build's row reads as a complete v4 row rather than an empty signature.
      signature: [
        {
          kind: 'test-file',
          id: 'lib/broken.test.ts',
          recipe: 'npm run test:file -- lib/broken.test.ts',
          admittedRound: 1,
          measuredHead: 'c'.repeat(40),
        },
      ],
      // Current readers fail closed when legacy rows predate the selective
      // coverage field, so absence materializes as blocked rather than green.
      selectiveCoverageBlocked: true,
    });
    expect(fakeSql.unsafe).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(
        /WHERE workspace_id = \$1\s+AND install_slug = \$2\s+AND target_role = 'system:green-checkpoint'/,
      ),
      ['ws-42', 'my-harness'],
    );

    fakeSql.unsafe
      .mockResolvedValueOnce(sqlRows([]))
      .mockResolvedValueOnce(sqlRows([{ written: true }]));
    await writeFrozenCandidateRepairQueue(target, queue, {
      expectedUpdatedAtMs: queue.updatedAtMs,
    });
    // P-021 (D-007 #1): the write path derives the repair manifest FIRST, and the only evidence
    // of a lint leg's subject paths is the last repair tick's per-leg output — read raw from the
    // same routine row, scoped exactly like the queue read above.
    expect(fakeSql.unsafe).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(
        /SELECT metadata->'gate_health'->'repairTickLegs'[\s\S]*WHERE workspace_id = \$1 AND install_slug = \$2 AND target_role = 'system:green-checkpoint'/,
      ),
      ['ws-42', 'my-harness'],
    );
    // P-013 / D-007: the queue write and the `gate_health.convergence` projection are ONE
    // statement, so the stored shrink figures can never describe a previous round. That is why
    // this asserts a 4-arg `jsonb_set(... || $3, '{gate_health}', ... || $4)` shape rather than
    // the plain `metadata || $3` this test originally pinned — splitting them back into two
    // writes would reintroduce exactly the lag window D-007 closed, and must fail here.
    //
    // `$4` embeds `observedAtMs: Date.now()`, so it is matched structurally rather than by
    // exact string: the fields pinned below (candidate, repairHead, phase) are the ones that
    // make the projection describe THIS cycle, and a projection carrying another candidate's
    // identity is the failure the assertion exists to catch.
    expect(fakeSql.unsafe).toHaveBeenNthCalledWith(
      3,
      expect.stringMatching(
        /metadata = jsonb_set\(\s*COALESCE\(metadata, '\{\}'::jsonb\) \|\| \$3::jsonb,\s*'\{gate_health\}',\s*COALESCE\(metadata->'gate_health', '\{\}'::jsonb\) \|\| \$4::jsonb,\s*true\s*\)[\s\S]+WHERE workspace_id = \$1\s+AND install_slug = \$2\s+AND target_role = 'system:green-checkpoint'/,
      ),
      [
        'ws-42',
        'my-harness',
        // P-021: the persisted row is the caller's queue PLUS the manifest derived from it in this
        // same call — every queue field byte-for-byte, then `manifest` describing THIS candidate.
        expect.stringMatching(
          new RegExp(
            '^' +
              `\\{"repair_queue":${JSON.stringify(queue).slice(0, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` +
              `,"manifest":\\{"schemaVersion":1,"candidate":"a{40}","repairHead":"c{40}"`,
          ),
        ),
        expect.stringMatching(
          /^\{"convergence":\{[\s\S]*"candidate":"a{40}","repairHead":"c{40}","phase":"ready-to-verify","observedAtMs":\d+\}\}$/,
        ),
        String(queue.updatedAtMs),
      ],
    );
    // P-021: a first write is a signature change, so the manifest is published to the gate-red
    // condition work-item(s) — looked up by condition key on the SAME workspace + install.
    expect(fakeSql.unsafe).toHaveBeenNthCalledWith(
      4,
      expect.stringMatching(
        /FROM harness_shared\.work_items[\s\S]*condition_key LIKE 'gate-red-streak:%'[\s\S]*condition_key LIKE 'frozen-repair-convergence:%'/,
      ),
      ['ws-42', 'my-harness', expect.any(Array)],
    );

    fakeSql.unsafe.mockResolvedValueOnce(sqlRows([{ written: true }]));
    await writeFrozenCandidateRepairQueue(target, null, {
      expectedUpdatedAtMs: queue.updatedAtMs,
    });
    expect(fakeSql.unsafe).toHaveBeenNthCalledWith(
      5,
      // Retiring the cycle must ALSO clear the convergence projection (D-007). Leaving it
      // behind strands shrink figures for a candidate that no longer exists next to a gate that
      // has moved on, and every field stays individually plausible — so a reader cannot tell it
      // describes a dead cycle. The `#- '{gate_health,convergence}'` leg is therefore pinned
      // here, not merely allowed: dropping it is a silent false-baseline regression.
      expect.stringMatching(
        /metadata = \(CASE[\s\S]+gate_health,inconclusive,status[\s\S]+repair-in-progress[\s\S]+repair-staging-mismatch[\s\S]+#- '\{gate_health,inconclusive\}'[\s\S]+END\)\s*#- '\{gate_health,convergence\}'[\s\S]+WHERE workspace_id = \$1\s+AND install_slug = \$2\s+AND target_role = 'system:green-checkpoint'/,
      ),
      ['ws-42', 'my-harness', String(queue.updatedAtMs)],
    );
  });

  it('P-027 (D-014): every write requires an explicit expected version or absence; a miss throws the FRESH row instead of overwriting it', async () => {
    fakeSql.unsafe.mockClear();
    const advanced = { ...queue, repairHead: 'd'.repeat(40), updatedAtMs: 9 };
    fakeSql.unsafe
      .mockResolvedValueOnce(sqlRows([])) // 1: repairTickLegs read (manifest derivation)
      .mockResolvedValueOnce(sqlRows([])) // 2: the guarded UPDATE matches NO row (a peer moved it)
      .mockResolvedValueOnce(sqlRows([{ repair_queue: advanced }])); // 3: fresh re-read for the error
    await expect(
      writeFrozenCandidateRepairQueue(target, queue, { expectedUpdatedAtMs: queue.updatedAtMs }),
    ).rejects.toMatchObject({
      code: 'frozen-repair-queue-write-conflict',
      expectedUpdatedAtMs: queue.updatedAtMs,
      fresh: { status: 'value', queue: expect.objectContaining({ repairHead: 'd'.repeat(40), updatedAtMs: 9 }) },
    });
    // The predicate is on the row version the caller read, as TEXT, positioned after the
    // statement's own four parameters, and the statement RETURNS so a miss is observable.
    expect(fakeSql.unsafe).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(
        /AND target_role = 'system:green-checkpoint'\s+AND metadata->'repair_queue'->>'updatedAtMs' = \$5::text\s+RETURNING true AS written/,
      ),
      ['ws-42', 'my-harness', expect.any(String), expect.any(String), String(queue.updatedAtMs)],
    );
    // No manifest publish after a refused write: the row was never ours to describe.
    expect(fakeSql.unsafe).toHaveBeenCalledTimes(3);

    // A hit resolves; the create path asserts ABSENCE with no extra parameter; the retire path
    // takes the same guard at its own position.
    fakeSql.unsafe.mockClear();
    fakeSql.unsafe.mockResolvedValueOnce(sqlRows([])).mockResolvedValueOnce(sqlRows([{ written: true }]));
    await expect(
      writeFrozenCandidateRepairQueue(target, queue, { expectedUpdatedAtMs: queue.updatedAtMs }),
    ).resolves.toBeUndefined();
    fakeSql.unsafe.mockClear();
    fakeSql.unsafe.mockResolvedValueOnce(sqlRows([])).mockResolvedValueOnce(sqlRows([{ written: true }]));
    await writeFrozenCandidateRepairQueue(target, queue, { expectedUpdatedAtMs: null });
    expect(fakeSql.unsafe).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/AND metadata->'repair_queue' IS NULL\s+RETURNING true AS written/),
      ['ws-42', 'my-harness', expect.any(String), expect.any(String)],
    );
    fakeSql.unsafe.mockClear();
    fakeSql.unsafe.mockResolvedValueOnce(sqlRows([]));
    fakeSql.unsafe.mockResolvedValueOnce(sqlRows([{ repair_queue: advanced }]));
    await expect(writeFrozenCandidateRepairQueue(target, null, { expectedUpdatedAtMs: 2 })).rejects.toBeInstanceOf(
      FrozenRepairQueueWriteConflictError,
    );
    expect(fakeSql.unsafe).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/AND metadata->'repair_queue'->>'updatedAtMs' = \$3::text\s+RETURNING true AS written/),
      ['ws-42', 'my-harness', '2'],
    );

    fakeSql.unsafe.mockClear();
    await expect(
      writeFrozenCandidateRepairQueue(target, queue, undefined as never),
    ).rejects.toThrow(/requires an explicit expectedUpdatedAtMs/);
    expect(fakeSql.unsafe).not.toHaveBeenCalled();
  });

  it('P-027 (D-014): applyFrozenCandidateRepairQueueTransition reduces the FRESH row (not the caller\'s copy), bumps the version, absorbs a CAS miss by re-reading, and writes nothing for an identity or an absent row', async () => {
    const fresh = { ...queue, repairHead: 'd'.repeat(40), updatedAtMs: 10 };
    let rowNow: unknown = fresh;
    let updateMisses = 1;
    const updates: Array<{ sql: string; params: unknown[] }> = [];
    fakeSql.unsafe.mockClear();
    fakeSql.unsafe.mockImplementation(async (sqlText: unknown, params?: unknown) => {
      const s = String(sqlText);
      if (/SELECT metadata->'repair_queue' AS repair_queue/.test(s)) {
        return sqlRows(rowNow === null ? [] : [{ repair_queue: rowNow }]);
      }
      if (/repairTickLegs/.test(s)) return sqlRows([]);
      if (/UPDATE harness_shared\.routines/.test(s) && /RETURNING true AS written/.test(s)) {
        updates.push({ sql: s, params: params as unknown[] });
        if (updateMisses > 0) {
          updateMisses -= 1;
          return sqlRows([]);
        }
        rowNow = JSON.parse((params as string[])[2]).repair_queue;
        return sqlRows([{ written: true }]);
      }
      return sqlRows([]);
    });
    try {
      // The caller's snapshot (`queue`, repairHead c…, updatedAtMs 2) is NOT what the reducer
      // sees: it is applied to the row as it stands (repairHead d…, updatedAtMs 10). The reducer
      // does not move the version, so the writer bumps it; the first CAS misses and is re-read.
      let reductions = 0;
      const outcome = await applyFrozenCandidateRepairQueueTransition(target, async (row) => {
        reductions += 1;
        await Promise.resolve();
        return {
          ...row,
          phase: 'ready-to-verify' as const,
        };
      });
      expect(outcome).toMatchObject({ status: 'written', retries: 1 });
      expect(outcome.queue).toMatchObject({ repairHead: 'd'.repeat(40), phase: 'ready-to-verify', updatedAtMs: 11 });
      expect(updates).toHaveLength(2);
      expect(reductions).toBe(2);
      for (const u of updates) expect(u.params[4]).toBe('10');
      expect((rowNow as { repairHead: string; updatedAtMs: number }).repairHead).toBe('d'.repeat(40));
      expect((rowNow as { updatedAtMs: number }).updatedAtMs).toBe(11);

      // Identity: the reducer returns the fresh row itself — nothing to persist, no UPDATE.
      const same = await applyFrozenCandidateRepairQueueTransition(target, (row) => row);
      expect(same.status).toBe('unchanged');
      expect(same.queue).toMatchObject({ updatedAtMs: 11 });
      expect(updates).toHaveLength(2);

      // Absent: the row was retired under us — never resurrected from a snapshot.
      rowNow = null;
      const gone = await applyFrozenCandidateRepairQueueTransition(target, (row) => ({ ...row, attempts: 99 }));
      expect(gone).toMatchObject({ status: 'absent', queue: null, fresh: null });
      expect(updates).toHaveLength(2);

      // Exhausted: a writer that keeps moving the row surfaces as the conflict, never a silent clobber.
      rowNow = fresh;
      updateMisses = 99;
      await expect(
        applyFrozenCandidateRepairQueueTransition(target, (row) => ({ ...row, attempts: 1 }), { maxAttempts: 2 }),
      ).rejects.toBeInstanceOf(FrozenRepairQueueWriteConflictError);
      expect(updates).toHaveLength(4);
    } finally {
      fakeSql.unsafe.mockImplementation(async (..._a: unknown[]) => Object.assign([] as unknown[], { count: 0 }));
    }
  });

  it('retires only the exact inspected queue and returns the replacement on a CAS miss', async () => {
    const retirableQueue = { ...queue, phase: 'awaiting-fixer' as const };
    fakeSql.unsafe
      .mockResolvedValueOnce(sqlRows([{ metadata: { repair_queue: retirableQueue } }]))
      .mockResolvedValueOnce(sqlRows([]))
      .mockResolvedValueOnce(sqlRows([{ retired: true }]));
    await expect(retireFrozenCandidateRepairQueue(target, retirableQueue)).resolves.toEqual({
      retired: true,
      current: null,
    });
    expect(fakeSql.unsafe).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/SELECT metadata[\s\S]+target_role = 'system:green-checkpoint'[\s\S]+FOR UPDATE/),
      ['ws-42', 'my-harness'],
    );
    expect(fakeSql.unsafe).toHaveBeenNthCalledWith(
      3,
      expect.stringMatching(
        /metadata->'repair_queue'->>'candidate' = \$3::text[\s\S]+metadata->'repair_queue'->>'repairHead' = \$4::text[\s\S]+metadata->'repair_queue'->'updatedAtMs' = to_jsonb\(\$5::bigint\)[\s\S]+metadata->'repair_queue'->>'fixerSpawnId'[\s\S]+RETURNING true AS retired/,
      ),
      // P-010: the 7th param is the pending carry; a queue that admitted nothing carries nothing.
      ['ws-42', 'my-harness', retirableQueue.candidate, retirableQueue.repairHead, retirableQueue.updatedAtMs, retirableQueue.fixerSpawnId, null],
    );

    const replacement = { ...retirableQueue, updatedAtMs: 3, repairHead: 'd'.repeat(40) };
    fakeSql.unsafe
      .mockResolvedValueOnce(sqlRows([{ metadata: { repair_queue: replacement } }]))
      .mockResolvedValueOnce(sqlRows([{ repair_queue: replacement }]));
    await expect(retireFrozenCandidateRepairQueue(target, retirableQueue)).resolves.toMatchObject({
      retired: false,
      current: { updatedAtMs: replacement.updatedAtMs, repairHead: replacement.repairHead },
    });
  });

  it('matches retirement on stable identity when the stored queue has additive fields', async () => {
    const newerQueue = {
      ...queue,
      phase: 'awaiting-fixer' as const,
      convergenceRounds: [{ round: 1, head: queue.repairHead, failingCount: 1, atMs: 3 }],
      newerCheckpointField: { writtenBy: 'a-newer-build' },
    } as FrozenCandidateRepairQueue & { newerCheckpointField: unknown };
    fakeSql.unsafe
      .mockResolvedValueOnce(sqlRows([{ metadata: { repair_queue: newerQueue } }]))
      .mockResolvedValueOnce(sqlRows([]))
      .mockResolvedValueOnce(sqlRows([{ retired: true }]));

    await expect(retireFrozenCandidateRepairQueue(target, newerQueue)).resolves.toEqual({
      retired: true,
      current: null,
    });
    expect(fakeSql.unsafe).toHaveBeenCalledWith(
      expect.stringMatching(
        /metadata->'repair_queue'->>'candidate' = \$3::text[\s\S]+metadata->'repair_queue'->>'repairHead' = \$4::text[\s\S]+metadata->'repair_queue'->'updatedAtMs' = to_jsonb\(\$5::bigint\)[\s\S]+metadata->'repair_queue'->>'fixerSpawnId'[\s\S]+RETURNING true AS retired/,
      ),
      ['ws-42', 'my-harness', newerQueue.candidate, newerQueue.repairHead, newerQueue.updatedAtMs, newerQueue.fixerSpawnId, null],
    );
  });

  it('reserves an unassigned fixer with a version-tolerant identity CAS and merge-write', async () => {
    const awaitingQueue: FrozenCandidateRepairQueue = {
      ...queue,
      schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
      phase: 'awaiting-fixer',
      repairHead: queue.candidate,
      attempts: 0,
      fixerSpawnId: null,
    };
    fakeSql.unsafe.mockImplementationOnce(async (_query: unknown, params: unknown) => {
      const reservedQueue = JSON.parse((params as unknown[])[2] as string) as FrozenCandidateRepairQueue;
      return sqlRows([{ repair_queue: reservedQueue }]);
    });

    const reserved = await reserveFrozenCandidateRepairFixer(target, awaitingQueue, { nowMs: 100 });

    expect(reserved).toMatchObject({
      phase: 'awaiting-fixer',
      attempts: 0,
      fixerSpawnId: null,
      dispatchReservation: {
        claimedAtMs: 100,
        expiresAtMs: 300_100,
      },
    });
    const [statement, params] = fakeSql.unsafe.mock.calls.at(-1)!;
    // P-008 / EI-21813295393334986: identity CAS (never whole-row jsonb equality) plus a MERGE
    // over the stored row, so a build-skewed peer's unknown fields neither break the match nor
    // get dropped by the write.
    expect(statement).toContain(
      "COALESCE(NULLIF(metadata->'repair_queue', 'null'::jsonb), '{}'::jsonb) || $3::jsonb",
    );
    expect(statement).toContain("metadata->'repair_queue'->>'candidate' = $4");
    expect(statement).toContain("metadata->'repair_queue'->>'repairHead' = $5");
    expect(statement).toContain("metadata->'repair_queue'->>'updatedAtMs' = $6");
    expect(statement).not.toContain("- 'dispatchReservation' = ");
    expect((params as unknown[]).slice(3)).toEqual([
      awaitingQueue.candidate,
      awaitingQueue.repairHead,
      String(awaitingQueue.updatedAtMs),
      100,
    ]);
  });

  it('reserve CAS matches on identity even when the queue carries additive unknown fields', async () => {
    const skewedQueue = {
      ...queue,
      schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
      phase: 'awaiting-fixer' as const,
      repairHead: queue.candidate,
      attempts: 0,
      fixerSpawnId: null,
      freeRetries: 2,
      newerBuildField: { writtenBy: 'a-newer-build' },
    } as FrozenCandidateRepairQueue & { newerBuildField: unknown };
    fakeSql.unsafe.mockImplementationOnce(async (_query: unknown, params: unknown) => {
      const reservedQueue = JSON.parse((params as unknown[])[2] as string) as FrozenCandidateRepairQueue;
      return sqlRows([{ repair_queue: reservedQueue }]);
    });

    const reserved = await reserveFrozenCandidateRepairFixer(target, skewedQueue, { nowMs: 100 });

    expect(reserved?.dispatchReservation).toMatchObject({ claimedAtMs: 100 });
    const [, params] = fakeSql.unsafe.mock.calls.at(-1)!;
    // The CAS params are exactly the three identity fields — the unknown field is not part of
    // the match, so a build that has never heard of it can still take (and exit) the queue.
    expect((params as unknown[]).slice(3, 6)).toEqual([
      skewedQueue.candidate,
      skewedQueue.repairHead,
      String(skewedQueue.updatedAtMs),
    ]);
  });

  it('renews only the exact token-bearing reservation', async () => {
    const reservedQueue: FrozenCandidateRepairQueue = {
      ...queue,
      schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
      phase: 'awaiting-fixer',
      repairHead: queue.candidate,
      attempts: 0,
      fixerSpawnId: null,
      dispatchReservation: {
        token: 'owner-token',
        claimedAtMs: 100,
        expiresAtMs: 300_100,
      },
    };
    fakeSql.unsafe.mockImplementationOnce(async (_query: unknown, params: unknown) => {
      const renewedQueue = JSON.parse((params as unknown[])[2] as string) as FrozenCandidateRepairQueue;
      return sqlRows([{ repair_queue: renewedQueue }]);
    });

    const renewed = await renewFrozenCandidateRepairFixerReservation(target, reservedQueue, 250_000);

    expect(renewed?.dispatchReservation).toEqual({
      token: 'owner-token',
      claimedAtMs: 100,
      expiresAtMs: 550_000,
    });
    const [statement, params] = fakeSql.unsafe.mock.calls.at(-1)!;
    // P-008: token stays the lease authority; identity fields pin the queue generation. The
    // whole-row equality this replaced could not survive writer/reader build skew.
    expect(statement).toContain("metadata->'repair_queue'->'dispatchReservation'->>'token' = $7");
    expect(statement).toContain("metadata->'repair_queue'->>'candidate' = $4");
    expect(statement).toContain(
      "COALESCE(NULLIF(metadata->'repair_queue', 'null'::jsonb), '{}'::jsonb) || $3::jsonb",
    );
    expect(statement).not.toContain("metadata->'repair_queue' = $4::jsonb");
    expect((params as unknown[]).slice(3)).toEqual([
      reservedQueue.candidate,
      reservedQueue.repairHead,
      String(reservedQueue.updatedAtMs),
      'owner-token',
    ]);
  });

  it('finalize removes only the reservation via an identity+token CAS merge-write', async () => {
    const reservedQueue: FrozenCandidateRepairQueue = {
      ...queue,
      schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
      phase: 'awaiting-fixer',
      repairHead: queue.candidate,
      attempts: 0,
      fixerSpawnId: null,
      dispatchReservation: { token: 'owner-token', claimedAtMs: 100, expiresAtMs: 300_100 },
    };
    fakeSql.unsafe.mockImplementationOnce(async (_query: unknown, params: unknown) => {
      const finalized = JSON.parse((params as unknown[])[2] as string) as FrozenCandidateRepairQueue;
      return sqlRows([{ repair_queue: finalized }]);
    });

    const finalized = await finalizeFrozenCandidateRepairFixer(target, reservedQueue, null, 250_000);

    expect(finalized?.dispatchReservation).toBeUndefined();
    expect(finalized?.updatedAtMs).toBe(250_000);
    const [statement, params] = fakeSql.unsafe.mock.calls.at(-1)!;
    // The serialized payload carries no reservation key, and a jsonb merge cannot delete a
    // key — the statement must remove it explicitly after the merge.
    expect(statement).toContain("- 'dispatchReservation'");
    expect(statement).toContain("metadata->'repair_queue'->'dispatchReservation'->>'token' = $7");
    const serialized = JSON.parse((params as unknown[])[2] as string) as Record<string, unknown>;
    expect('dispatchReservation' in serialized).toBe(false);
    expect((params as unknown[]).slice(3)).toEqual([
      reservedQueue.candidate,
      reservedQueue.repairHead,
      String(reservedQueue.updatedAtMs),
      'owner-token',
    ]);
  });
});

describe('WI-4494: the routine defers to a run that already recorded (no double-counted reds)', () => {
  const GREEN_MARKER = '__GREEN_CHECKPOINT_RESULT__';

  beforeEach(() => {
    appendPipelineEvent.mockClear();
    fakeSql.unsafe.mockClear();
  });

  it('⭐ recorded:true ⇒ the routine records NOTHING — a second trackGateStall would count one red twice', async () => {
    const stdout = `${GREEN_MARKER} ${JSON.stringify({ reason: 'not-green', green: false, candidate: 'abc123', recorded: true })}\n`;
    spawnMock.mockImplementationOnce(() => fakeSpawn(stdout, 0));
    await getSystemAction('green-checkpoint')!(ctx);
    // P-001 (gate-verdict-liveness): the tick's FIRE ANCHOR (kind='green_checkpoint_fire') is
    // the ONE permitted append — it marks the fire itself at entry, rides a separate kind no
    // outcome consumer reads, and fires on EVERY tick by design. What this test forbids is a
    // second OUTCOME row (kind='green_checkpoint') double-counting the run's own verdict.
    const outcomeAppends = appendPipelineEvent.mock.calls.filter(
      ([ev]) => (ev as { kind?: string }).kind !== 'green_checkpoint_fire',
    );
    expect(outcomeAppends).toEqual([]);
    const anchors = appendPipelineEvent.mock.calls.filter(
      ([ev]) => (ev as { kind?: string }).kind === 'green_checkpoint_fire',
    );
    expect(anchors).toHaveLength(1);
    expect(anchors[0]![0]).toMatchObject({
      kind: 'green_checkpoint_fire',
      status: 'fired',
      workspaceId: 'ws-42',
      installSlug: 'my-harness',
      detail: expect.objectContaining({ route: 'scheduled' }),
    });
    // The decisive one: no gate_health read-modify-write, so the streak moves exactly once per
    // verdict — by the run that produced it.
    expect(fakeSql.unsafe).not.toHaveBeenCalledWith(expect.stringContaining('gate_health'), expect.anything());
  });

  it('⭐ no `recorded` flag (an OLD CLI — the deployed routine drives the integration tree) ⇒ the routine STILL records', async () => {
    // The version-skew safety valve. This is why the change cannot blind the gate: absent the flag
    // we fall straight back to pre-WI-4494 behaviour.
    const stdout = `${GREEN_MARKER} ${JSON.stringify({ reason: 'not-green', green: false, candidate: 'abc123' })}\n`;
    spawnMock.mockImplementationOnce(() => fakeSpawn(stdout, 0));
    await getSystemAction('green-checkpoint')!(ctx);
    expect(appendPipelineEvent).toHaveBeenCalledWith(expect.objectContaining({ status: 'not-green' }));
    expect(fakeSql.unsafe).toHaveBeenCalledWith(expect.stringContaining('gate_health'), ['my-harness', 'ws-42']);
  });

  it('EI-213458: a pinned old-CLI fallback retains history but emits no red wake and mutates no gate health', async () => {
    emitAwaitedEvent.mockClear();
    const stdout = `${GREEN_MARKER} ${JSON.stringify({
      reason: 'not-green',
      green: false,
      candidate: 'abc123def456789',
      candidateSource: 'pinned',
      diagnostic: 'candidate-pinned',
      failingTests: ['lib/x.test.ts'],
    })}\n`;
    spawnMock.mockImplementationOnce(() => fakeSpawn(stdout, 0));

    await getSystemAction('green-checkpoint')!(ctx);

    expect(appendPipelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'not-green',
        detail: expect.objectContaining({ candidateSource: 'pinned' }),
      }),
    );
    expect(fakeSql.unsafe).not.toHaveBeenCalledWith(expect.stringContaining('gate_health'), expect.anything());
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
  });

  it('EI-20981232855780375: an OLD CLI red fallback emits global + pipeline-scoped await keys', async () => {
    const stdout = `${GREEN_MARKER} ${JSON.stringify({
      reason: 'not-green',
      green: false,
      candidate: 'abc123def456789',
      from: 'fedcba987654321',
      summary: 'lint:identity-leak',
      failingTests: [],
      logPath: '/tmp/green-checkpoint.log',
      runId: 'legacy-run-1',
    })}\n`;
    spawnMock.mockImplementationOnce(() => fakeSpawn(stdout, 0));

    await getSystemAction('green-checkpoint')!(ctx);

    expect(emitAwaitedEvent).toHaveBeenCalledTimes(2);
    const calls = emitAwaitedEvent.mock.calls.map(([args]) => args as Record<string, unknown>);
    expect(calls.map((args) => args.key)).toEqual([
      'green-checkpoint:red',
      `green-checkpoint:red:${EXPECTED_PIPELINE}`,
    ]);
    for (const args of calls) {
      expect(args).toMatchObject({
        source: 'green-checkpoint',
        // EI-22240267519750098: the ref inside the claim is pipeline-qualified, so a
        // foreign pot's red on the GLOBAL key cannot read as the awaiter's own gate.
        // Written literally, not via `pipelineRef`, to stay an independent restatement.
        summary: `[pipeline:${EXPECTED_PIPELINE}] green-checkpoint: abc123de not green — ${EXPECTED_PIPELINE}:main held`,
        cancelSiblingKeysFor: ['release:green', `release:green:${EXPECTED_PIPELINE}`],
        payload: {
          sha: 'abc123def456789',
          from: 'fedcba987654321',
          pipeline: EXPECTED_PIPELINE,
          summary: 'lint:identity-leak',
          failingTests: [],
          logPath: '/tmp/green-checkpoint.log',
          runId: 'legacy-run-1',
          lineage: null,
        },
      });
    }
  });

  it('wakes the exact red candidate after the scheduled fallback commits its terminal event', async () => {
    const candidate = 'abc123def456789';
    spawnMock.mockImplementationOnce(() => fakeSpawn(`${GREEN_MARKER} ${JSON.stringify({
      reason: 'not-green', green: false, candidate, runId: 'legacy-run-atomic',
    })}\n`, 0));
    recordStoredQualificationVerdict.mockResolvedValueOnce({ status: 'updated' });

    await getSystemAction('green-checkpoint')!(ctx);

    expect(recordStoredQualificationVerdict).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      reason: 'not-green', candidate, terminalEvent: expect.objectContaining({ status: 'not-green' }),
    }));
    expect(appendPipelineEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      kind: 'green_checkpoint', status: 'not-green',
    }));
    expect(emitAwaitedEvent.mock.calls.map(([args]) => (args as { payload: { sha: string } }).payload.sha))
      .toEqual([candidate, candidate]);
  });

  it('⭐ hands the CLI the record target — without this env the run cannot know whose gate it judges', async () => {
    const stdout = `${GREEN_MARKER} ${JSON.stringify({ reason: 'up-to-date', green: true, recorded: true })}\n`;
    spawnMock.mockImplementationOnce(() => fakeSpawn(stdout, 0));
    await getSystemAction('green-checkpoint')!({
      ...ctx,
      routineId: 'rt_my_harness_green_checkpoint',
      workflowId: 'routine-fire-workflow-42',
    });
    const opts = spawnMock.mock.calls[0]![2] as { env?: Record<string, string> };
    expect(opts.env?.PAPERCUSP_GATE_VERDICT_WORKSPACE).toBe('ws-42');
    expect(opts.env?.PAPERCUSP_GATE_VERDICT_HARNESS).toBe('my-harness');
    expect(opts.env?.PAPERCUSP_ROUTINE_FIRE_ROUTINE_ID).toBe('rt_my_harness_green_checkpoint');
    expect(opts.env?.PAPERCUSP_ROUTINE_FIRE_WORKFLOW_ID).toBe('routine-fire-workflow-42');
    const anchor = appendPipelineEvent.mock.calls
      .map(([event]) => event as Record<string, unknown>)
      .find((event) => event.kind === 'green_checkpoint_fire');
    expect(opts.env?.PAPERCUSP_GATE_FIRE_ID).toMatch(/^[a-f0-9-]{36}$/);
    expect((anchor?.detail as { gateFireId?: string })?.gateFireId).toBe(opts.env?.PAPERCUSP_GATE_FIRE_ID);
  });
});

describe('EI-13723: recordCheckpointVerdict also dispatches the release-fixer (not just the routine)', () => {
  beforeEach(() => {
    appendPipelineEvent.mockClear();
    fakeSql.unsafe.mockClear();
    fireLaunchBlueprintForEvent.mockClear();
    fireLaunchBlueprintForEvent.mockResolvedValue(null);
  });

  it.each([
    { measured: 'false', hasSnapshot: true, code: 'no-measured-failures', retryable: false, reason: 'no measured failing tests' },
    { measured: 'true', hasSnapshot: false, code: 'snapshot-mismatch', retryable: true, reason: 'no fresh candidate snapshot' },
  ])('reports the exact typed refusal without spawning: $code', async ({ measured, hasSnapshot, code, retryable, reason }) => {
    const candidate = 'a'.repeat(40);
    const repairQueue: FrozenCandidateRepairQueue = {
      schemaVersion: 1, phase: 'awaiting-fixer', candidate, base: 'b'.repeat(40), repairHead: candidate,
      affectedTestProofGroup: 'proof-1', attempts: 0, openedAtMs: 1, updatedAtMs: 2,
      fixerSpawnId: null, failingTests: ['lib/red.test.ts'], signature: [],
    };
    const snapshot = buildCandidateSnapshot({ candidate, failingTests: repairQueue.failingTests, repairQueue }, Date.now());
    expect(snapshot).not.toBeNull();
    fakeSql.unsafe.mockResolvedValueOnce(sqlRows([{ lf: null, ftm: measured, cs: hasSnapshot ? snapshot : null }]));
    const onSkip = vi.fn();

    const result = await dispatchReleaseFixer(
      { workspaceId: 'ws-42', installSlug: 'my-harness' }, candidate, repairQueue.failingTests, repairQueue, undefined,
      { checkCandidate: async () => ({ candidateExists: true, candidatePromoted: false }), onSkip },
    );

    expect(result).toBeNull();
    expect(onSkip).toHaveBeenCalledExactlyOnceWith({ code, retryable, reason: expect.stringContaining(reason) });
    expect(fireLaunchBlueprintForEvent).not.toHaveBeenCalled();
    expect(fakeSql.unsafe.mock.calls.some(([query]) => String(query).includes('UPDATE'))).toBe(false);
  });

  it('does not announce or suppress retries when the launch target returns no spawn', async () => {
    const candidate = 'a'.repeat(40);
    const failingTest = 'lint:identity-leak';
    const snapshot = buildCandidateSnapshot({ candidate, failingTests: [failingTest] }, Date.now());
    expect(snapshot).not.toBeNull();
    fakeSql.unsafe
      .mockResolvedValueOnce(sqlRows([{ lf: null, ftm: 'true', cs: snapshot }]))
      .mockResolvedValueOnce(sqlRows([{ written: true }]))
      .mockResolvedValueOnce(sqlRows([{ written: true }]));
    fireLaunchBlueprintForEvent.mockResolvedValueOnce({ spawn: null });
    const timeline: string[] = [];
    const broadcast = vi.fn(async () => { timeline.push('broadcast'); return true; });
    const notify = vi.fn(async () => { timeline.push('notify'); });

    const result = await dispatchReleaseFixer(
      { workspaceId: 'ws-42', installSlug: 'my-harness' },
      candidate,
      [failingTest],
      undefined,
      undefined,
      {
        checkCandidate: async () => ({ candidateExists: true, candidatePromoted: false }),
        alarm: { broadcast, notify },
      },
    );

    expect(result).toBeNull();
    expect(timeline).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    const failedWrite = fakeSql.unsafe.mock.calls.find(([query, params]) =>
      String(query).includes("metadata->'last_fixer'") &&
      String((params as unknown[])[3]).includes('"dispatchStatus":"failed"'),
    );
    expect(failedWrite).toBeDefined();
    expect(JSON.parse(String((failedWrite?.[1] as unknown[])[3])).last_fixer).toMatchObject({
      signature: failingTest,
      dispatchStatus: 'failed',
      spawnId: null,
      runId: null,
    });
    expect(appendPipelineEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'release_fixer',
      status: 'failed',
      detail: expect.objectContaining({ dispatchStatus: 'failed', recordPatched: true }),
    }));
  });

  it('announces and notifies only after the launch returns a spawn record', async () => {
    const candidate = 'b'.repeat(40);
    const failingTest = 'lint:identity-leak';
    const snapshot = buildCandidateSnapshot({ candidate, failingTests: [failingTest] }, Date.now());
    expect(snapshot).not.toBeNull();
    fakeSql.unsafe
      .mockResolvedValueOnce(sqlRows([{ lf: null, ftm: 'true', cs: snapshot }]))
      .mockResolvedValueOnce(sqlRows([{ written: true }]))
      .mockResolvedValueOnce(sqlRows([{ written: true }]))
      .mockResolvedValueOnce(sqlRows([{ written: true }]));
    const timeline: string[] = [];
    fireLaunchBlueprintForEvent.mockImplementationOnce(async () => {
      timeline.push('fire');
      return { spawn: { spawnId: 'spawn-1', runId: 'run-1', durable: false } };
    });
    const broadcast = vi.fn(async () => { timeline.push('broadcast'); return true; });
    const notify = vi.fn(async () => { timeline.push('notify'); });

    const result = await dispatchReleaseFixer(
      { workspaceId: 'ws-42', installSlug: 'my-harness' },
      candidate,
      [failingTest],
      undefined,
      undefined,
      {
        checkCandidate: async () => ({ candidateExists: true, candidatePromoted: false }),
        alarm: { broadcast, notify },
      },
    );

    expect(result).toEqual({ spawnId: 'spawn-1', runId: 'run-1' });
    expect(timeline).toEqual(['fire', 'broadcast', 'notify']);
    expect(appendPipelineEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'release_fixer',
      status: 'ok',
      detail: expect.objectContaining({ dispatchStatus: 'dispatched', recordPatched: true }),
    }));
  });

  it('builds a frozen-fixer brief that distinguishes the delegated child from the parent gate owner', () => {
    const repairQueue: FrozenCandidateRepairQueue = {
      schemaVersion: 1,
      phase: 'awaiting-fixer',
      candidate: 'a'.repeat(40),
      base: 'b'.repeat(40),
      repairHead: 'c'.repeat(40),
      affectedTestProofGroup: 'proof-1',
      attempts: 2,
      openedAtMs: 1,
      updatedAtMs: 2,
      fixerSpawnId: null,
      failingTests: ['lib/red.test.ts'],
    signature: [],
    };

    const brief = buildReleaseFixerKickoff({
      candidate: repairQueue.repairHead,
      failingTests: repairQueue.failingTests,
      repairQueue,
      flakeAnnotation: 'historical flake: none',
      checkpointEvidence: {
        logPath: '/var/lib/papercusp/checkpoint-logs/exact-run.log',
        runId: 'exact-run-42',
        integrationRoot: '/srv/papercusp',
      },
    });

    expect(brief).toContain('AUTHORIZED delegated repair child, not a second LIVE_GATE_OPS owner');
    expect(brief).toContain('parent gate owner intentionally retains the singleton hold');
    expect(brief).toContain("callerAuthorization.status='authorized-delegate'");
    expect(brief).toContain('VERIFIED signed spawn id must exactly equal repairQueue.fixerSpawnId');
    expect(brief).toContain('PAPERCUSP_SID');
    expect(brief).not.toContain('PAPERCUSP_SPAWN_ID');
    expect(brief).toContain('status is queue-unassigned');
    // P-003 / D-010: the brief names the ONE admission door and says outright that there is
    // no worktree to look for — the old brief pointed the fixer at a per-queue worktree path.
    expect(brief).toContain("release:repair-queue { op: 'admit', paths: [...] }");
    expect(brief).toContain('there is NO repair worktree');
    expect(brief).not.toMatch(/\/\.papercusp\/worktrees\//);
    expect(brief).toContain('historical flake: none');
    expect(brief).toContain(
      'Authoritative checkpoint run evidence: {"logPath":"/var/lib/papercusp/checkpoint-logs/exact-run.log","runId":"exact-run-42","integrationRoot":"/srv/papercusp"}',
    );
    expect(brief).toContain('Read this exact checkpoint artifact and use its failure tail');
  });

  it('keeps the legacy moving-tip brief free of frozen-child authorization instructions', () => {
    const brief = buildReleaseFixerKickoff({ candidate: 'a'.repeat(40), failingTests: ['lib/red.test.ts'] });
    expect(brief).toContain('failed the gate suite');
    expect(brief).not.toContain('authorized-delegate');
    expect(brief).not.toContain('repairQueue.fixerSpawnId');
  });

  // WI-10007494: a frozen queue mixing a same-head contradiction with a real red. Before the
  // fix the fixer was handed both, i.e. told to fix a leg its own repairHead had passed.
  describe('WI-10007494: same-head contradiction beside a real red', () => {
    const LANE = '@papercusp/operator-core :: test:lane-stateful';
    const RED = 'lint:design-primitives';
    const queue = (): FrozenCandidateRepairQueue => ({
      schemaVersion: 1,
      phase: 'awaiting-fixer',
      candidate: 'a'.repeat(40),
      base: 'b'.repeat(40),
      repairHead: 'c'.repeat(40),
      affectedTestProofGroup: 'proof-1',
      attempts: 1,
      openedAtMs: 1,
      updatedAtMs: 2,
      fixerSpawnId: null,
      failingTests: [LANE, RED],
      signature: [],
    });
    const tickAt = (head: string) => ({
      head: head.slice(0, 12),
      atMs: 1,
      ok: false,
      failingSignatures: [RED],
      legs: [
        { id: LANE, status: 'pass', durationMs: 1_159_339 },
        { id: RED, status: 'fail', durationMs: 4_000 },
      ],
    });
    type Fire = {
      kickoff: string;
      bodyExtra: { account: string; releaseFixerContext: { failingTests: string[]; sameHeadContradicted?: string[] } };
    };
    const dispatchWithTick = async (repairQueue: FrozenCandidateRepairQueue, tickHead: string) => {
      spawnMock.mockImplementation((_cmd: unknown, args: string[]) => {
        if (args.includes('cat-file')) return fakeSpawn('', 0);
        if (args.some((a) => typeof a === 'string' && a.startsWith('origin/main..'))) return fakeSpawn('3', 0);
        return fakeSpawn('', 0);
      });
      const snapshot = buildCandidateSnapshot(
        { candidate: repairQueue.candidate, failingTests: repairQueue.failingTests, repairQueue },
        Date.now(),
      );
      expect(snapshot).not.toBeNull();
      fakeSql.unsafe
        .mockResolvedValueOnce(sqlRows([{ lf: null, ftm: 'true', cs: snapshot, legs: tickAt(tickHead) }]))
        .mockResolvedValueOnce(sqlRows([{ written: true }]))
        // A missing spawn is now persisted as a failed attempt so the next tick retries.
        .mockResolvedValueOnce(sqlRows([{ written: true }]));
      await dispatchReleaseFixer(
        { workspaceId: 'ws-42', installSlug: 'my-harness' },
        repairQueue.repairHead,
        repairQueue.failingTests,
        repairQueue,
      );
      expect(fireLaunchBlueprintForEvent).toHaveBeenCalledTimes(1);
      const fire = fireLaunchBlueprintForEvent.mock.calls[0]![1] as Fire;
      const reservation = fakeSql.unsafe.mock.calls.find(([query]) => {
        const text = String(query);
        return text.includes("metadata->'gate_health'->'candidateSnapshot'->>'identity'") && text.includes("metadata->'last_fixer'");
      });
      expect(reservation).toBeDefined();
      const record = JSON.parse(String((reservation![1] as unknown[])[3])).last_fixer as { signature: string };
      return { fire, record };
    };

    it('hands the fixer only the real red, while the dedup signature and the queue keep both', async () => {
      const repairQueue = queue();
      const { fire, record } = await dispatchWithTick(repairQueue, repairQueue.repairHead);
      expect(fire.bodyExtra.account).toBe('auto');
      expect(fire.bodyExtra.releaseFixerContext.failingTests).toEqual([RED]);
      expect(fire.bodyExtra.releaseFixerContext.sameHeadContradicted).toEqual([LANE]);
      expect(fire.kickoff).toContain(`Fix ONLY: ${RED}. Do NOT fix: ${LANE}.`);
      // The obligation to re-measure LANE survives: the queue is untouched and the dedup
      // signature is still the full set.
      expect(record.signature).toBe([LANE, RED].sort().join(','));
      expect(repairQueue.failingTests).toEqual([LANE, RED]);
      const select = fakeSql.unsafe.mock.calls.find(([query]) => String(query).includes("AS legs"));
      expect(String(select?.[0])).toContain("metadata->'gate_health'->'repairTickLegs' AS legs");
    });

    it('control: a tick from an earlier head contradicts nothing, so the fixer gets the full set', async () => {
      const repairQueue = queue();
      const { fire } = await dispatchWithTick(repairQueue, 'f'.repeat(40));
      expect(fire.bodyExtra.releaseFixerContext.failingTests).toEqual([LANE, RED]);
      expect(fire.bodyExtra.releaseFixerContext.sameHeadContradicted).toBeUndefined();
      expect(fire.kickoff).not.toContain('Do NOT fix:');
    });
  });

  it('⭐ a manual run (release:checkpoint-run) — which self-records via recordCheckpointVerdict and never touches the routine handler — still fires the release-fixer for a fresh red', async () => {
    // The candidate must survive isStaleReleaseFixerCandidate's live re-verify: exists (cat-file -e
    // exit 0) and NOT yet promoted onto origin/main (rev-list --count > 0 ⇒ not an ancestor).
    //
    // Dispatch on ARGS, not call ORDER. Other git reads share this same `spawn` seam — since
    // EI-19329732364513693, trackGateStall measures candidate staleness (`log -1 --format=%cI`
    // and `rev-list --count <candidate>..staging`) on the same recordCheckpointVerdict path, and
    // it runs FIRST. A positional mockImplementationOnce chain therefore hands this check
    // someone else's response: cat-file silently reads as exit≠0, the candidate looks GC'd, the
    // fixer dispatch is skipped, and this test fails for a reason that has nothing to do with
    // the behaviour it guards. Matching on args is immune to any future added git call.
    spawnMock.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args.includes('cat-file')) return fakeSpawn('', 0); // <candidate>^{commit} → exists
      if (args.some((a) => typeof a === 'string' && a.startsWith('origin/main..'))) {
        return fakeSpawn('3', 0); // rev-list --count origin/main..<candidate> → not promoted
      }
      return fakeSpawn('', 0); // any other git read (staleness measurement) — value irrelevant here
    });

    const persistedSnapshot = buildCandidateSnapshot(
      { candidate: 'deadbeefcafe0123', failingTests: ['lib/y.test.ts'] },
      Date.now(),
    );
    expect(persistedSnapshot).not.toBeNull();
    // trackGateStall reads the routine row before writing the producer snapshot; the
    // dispatcher then reads that freshly persisted snapshot before its identity CAS.
    fakeSql.unsafe
      .mockResolvedValueOnce(sqlRows([{ gh: null, lf: null, rq: null }]))
      // trackGateStall's final gate_health merge update has no returned rows.
      .mockResolvedValueOnce(sqlRows([]))
      // dispatchReleaseFixer reads the snapshot written by the producer.
      .mockResolvedValueOnce(sqlRows([{ lf: null, ftm: 'true', cs: persistedSnapshot }]))
      // The exact snapshot/last_fixer CAS must report its row as written before firing.
      .mockResolvedValueOnce(sqlRows([{ written: true }]))
      // The mocked launch returns no spawn, so dispatchReleaseFixer records that failed fire.
      .mockResolvedValueOnce(sqlRows([{ written: true }]));

    const recorded = await recordCheckpointVerdict(
      { workspaceId: 'ws-42', installSlug: 'my-harness' },
      {
        reason: 'not-green',
        green: false,
        candidate: 'deadbeefcafe0123',
        failingTests: ['lib/y.test.ts'],
        checkpointEvidence: {
          logPath: '/var/lib/papercusp/checkpoint-logs/manual-red.log',
          runId: 'manual-red-run',
          integrationRoot: '/srv/papercusp',
        },
      },
    );

    expect(recorded).toBe(true);
    const producerWrite = fakeSql.unsafe.mock.calls.find(([query]) =>
      String(query).includes("'{gate_health}'"),
    );
    expect(producerWrite).toBeDefined();
    expect(JSON.parse(String((producerWrite![1] as unknown[])[1]))).toEqual(
      expect.objectContaining({ gate_health: expect.objectContaining({ candidateSnapshot: expect.any(Object) }) }),
    );
    // The bug: before EI-13723 this fire NEVER happened for a verdict recorded outside the
    // routine handler — exactly the shape a manual release:checkpoint-run self-records through.
    expect(fireLaunchBlueprintForEvent).toHaveBeenCalledWith(
      'green-checkpoint:red',
      expect.objectContaining({
        installSlug: 'my-harness',
        workspaceId: 'ws-42',
        bodyExtra: expect.objectContaining({
          account: 'auto',
          releaseFixerContext: expect.objectContaining({
            checkpointEvidence: {
              logPath: '/var/lib/papercusp/checkpoint-logs/manual-red.log',
              runId: 'manual-red-run',
              integrationRoot: '/srv/papercusp',
            },
          }),
        }),
        // EI-20978485106613438: the fixer must receive the full invoke budget; the old
        // 900_000ms value killed it at exactly 15 minutes before it could repair the gate.
        timeoutMs: 2_700_000,
      }),
    );
    const reservation = fakeSql.unsafe.mock.calls.find(([query]) => {
      const text = String(query);
      return text.includes("metadata->'gate_health'->'candidateSnapshot'->>'identity'") && text.includes("metadata->'last_fixer'");
    });
    expect(reservation).toBeDefined();
    expect(reservation![1]).toEqual(expect.arrayContaining(['my-harness', persistedSnapshot!.identity, 'null']));
  });

  it('WI-39944: a queue-owned red records its queue but never launches the legacy moving-tip fixer', async () => {
    spawnMock.mockImplementation(() => fakeSpawn('', 1));
    const repairQueue: FrozenCandidateRepairQueue = {
      schemaVersion: 1,
      phase: 'awaiting-fixer',
      candidate: 'a'.repeat(40),
      base: 'b'.repeat(40),
      repairHead: 'c'.repeat(40),
      affectedTestProofGroup: 'initial-proof-run',
      attempts: 1,
      openedAtMs: 1,
      updatedAtMs: 2,
      fixerSpawnId: 'fixer-1',
      failingTests: ['lib/y.test.ts'],
    signature: [],
    };

    const recorded = await recordCheckpointVerdict(
      { workspaceId: 'ws-42', installSlug: 'my-harness' },
      {
        reason: 'not-green',
        green: false,
        candidate: repairQueue.repairHead,
        failingTests: repairQueue.failingTests,
        repairQueue,
      },
    );

    expect(recorded).toBe(true);
    expect(appendPipelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'not-green',
        detail: expect.objectContaining({
          repairQueue: expect.objectContaining({
            candidate: 'a'.repeat(12),
            repairHead: 'c'.repeat(12),
            fixerSpawnId: 'fixer-1',
          }),
        }),
      }),
    );
    expect(fireLaunchBlueprintForEvent).not.toHaveBeenCalled();
  });

  it('does NOT double-dispatch when the routine ALSO sees a recorded:true verdict — recordCheckpointVerdict already covered it', async () => {
    const GREEN_MARKER = '__GREEN_CHECKPOINT_RESULT__';
    // Modern CLI: self-records (recorded:true) — the routine's OWN post-processing must defer
    // entirely rather than re-run (now-redundant) dispatch logic for the same verdict.
    const stdout = `${GREEN_MARKER} ${JSON.stringify({ reason: 'not-green', green: false, candidate: 'deadbeefcafe0123', failingTests: ['lib/y.test.ts'], recorded: true })}\n`;
    spawnMock.mockImplementationOnce(() => fakeSpawn(stdout, 0));
    await getSystemAction('green-checkpoint')!(ctx);
    expect(fireLaunchBlueprintForEvent).not.toHaveBeenCalled();
  });
});

/**
 * EI-20263854732193595 — the integration root must FAIL CLOSED.
 *
 * The old fallback was `process.env.PAPERCUSP_INTEGRATION_ROOT ?? resolve(cwd,'..','..')`,
 * which is CORRECT for a normal operator and CATASTROPHIC for one running out of the
 * release checkout — and returned both without complaint. A wrong-tree gate run does not
 * error; it produces a well-formed verdict about the wrong commits, which is why this was
 * only noticed when two agents independently concluded the gate was executing the release
 * copy of green-checkpoint.ts during a 22h freeze.
 *
 * These cases are written so the guard is FALSIFIABLE in both directions: the refusals
 * must fire, AND the paths that legitimately worked before must keep working (a guard
 * that refuses everything would pass a refusal-only suite while breaking the operator).
 */
describe('EI-20263854732193595: resolveIntegrationRoot fails closed on release/checkpoint checkouts', () => {
  const WS = '/home/dev/papercupai-workspace';

  it('REFUSES the release checkout when the env var is unset (the silent-wrong-tree case)', () => {
    expect(() => resolveIntegrationRoot({}, `${WS}/papercup-release/apps/operator`)).toThrow(
      /refusing to gate .*papercup-release/,
    );
  });

  it("REFUSES the gate's own checkpoint test tree", () => {
    expect(() => resolveIntegrationRoot({}, `${WS}/papercusp-checkpoint/apps/operator`)).toThrow(
      /refusing to gate .*papercusp-checkpoint/,
    );
  });

  it('names the offending path AND the remedy — a refusal nobody can act on just moves the confusion', () => {
    let msg = '';
    try {
      resolveIntegrationRoot({}, `${WS}/papercusp-release/apps/operator`);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain(`${WS}/papercusp-release`); // the resolved path, not just the basename
    expect(msg).toContain('PAPERCUSP_INTEGRATION_ROOT'); // how to fix it
  });

  it('STILL resolves the normal staging operator via the cwd fallback (guard must not break the working path)', () => {
    expect(resolveIntegrationRoot({}, `${WS}/papercusp/apps/operator`)).toBe(`${WS}/papercusp`);
  });

  it('an EXPLICIT env root always wins — even when cwd sits inside the release checkout', () => {
    expect(
      resolveIntegrationRoot({ PAPERCUSP_INTEGRATION_ROOT: `${WS}/papercusp` }, `${WS}/papercup-release/apps/operator`),
    ).toBe(`${WS}/papercusp`);
  });

  /* ---- root-in-log evidence -------------------------------------------------
   * The guard above only refuses the KNOWN-BAD checkouts. An explicit env root
   * pointing somewhere unexpected is still silently wrong, and no guard can catch
   * that — only a human reading the log can. So the run has to SAY which tree it
   * judged, and say how it decided. */

  it('states the resolved root AND how it was decided (cwd fallback)', () => {
    const line = integrationRootEvidence({}, `${WS}/papercusp/apps/operator`);
    expect(line).toContain(`${WS}/papercusp`);
    expect(line).toContain('source=cwd-fallback');
  });

  it('distinguishes an EXPLICIT env root from the fallback — the two failure modes differ', () => {
    const line = integrationRootEvidence(
      { PAPERCUSP_INTEGRATION_ROOT: `${WS}/somewhere-else` },
      `${WS}/papercusp/apps/operator`,
    );
    expect(line).toContain(`${WS}/somewhere-else`);
    expect(line).toContain('source=PAPERCUSP_INTEGRATION_ROOT');
    // ...and must NOT claim the fallback produced it — that mislabel would send a
    // reader hunting a cwd bug when the real cause is an env var.
    expect(line).not.toContain('cwd-fallback');
  });

  it('propagates the refusal rather than logging a well-formed line about a bad tree', () => {
    expect(() => integrationRootEvidence({}, `${WS}/papercup-release/apps/operator`)).toThrow(/refusing to gate/);
  });

  /* WI-38250 — the SIBLING half of the emitter pin. apps/operator/lib/release/release-config.ts
   * exports a same-named integrationRootEvidence() with a DIFFERENT resolver and a different
   * fallback (script-repo vs this one's cwd-fallback), and both used to return a byte-identical
   * `integration root: <root> (source=<source>)` through the same orchestratorStdoutTag() prefix.
   * `source` does not separate them where it counts: production sets PAPERCUSP_INTEGRATION_ROOT
   * explicitly, so both print source=PAPERCUSP_INTEGRATION_ROOT and the log cannot attribute the
   * root to a resolver. Since the two CAN disagree, an unattributable line is worse than none.
   * The other half of this pin lives in apps/operator/lib/release/release-config.test.ts. */
  it('names its EMITTER, so the log can attribute the root to the resolver that chose it', () => {
    const line = integrationRootEvidence(
      { PAPERCUSP_INTEGRATION_ROOT: `${WS}/papercusp` },
      `${WS}/papercusp/apps/operator`,
    );
    expect(line).toContain('emitter=routine-dispatcher');
    // ...and must NOT claim the gate CLI's identity — convergence would silently lose attribution.
    expect(line).not.toContain('emitter=gate-cli');
  });

  /* Falsifiability, without mutating the shared tree: a probe that edits the real file races
   * git-sync's tree-wide sweep and can land the mutant committed even when nothing fails. A
   * permanent wrong-implementation control proves the pin bites. */
  it('the emitter pin is FALSIFIABLE — the pre-WI-38250 format fails it', () => {
    const untagged = (root: string, source: string) => `integration root: ${root} (source=${source})`;
    expect(untagged(`${WS}/papercusp`, 'PAPERCUSP_INTEGRATION_ROOT')).not.toContain('emitter=');
    // calibration — a control is only a control if the REAL subject passes the same check
    expect(
      integrationRootEvidence({ PAPERCUSP_INTEGRATION_ROOT: `${WS}/papercusp` }, `${WS}/papercusp/apps/operator`),
    ).toContain('emitter=');
  });

  /* A builder nobody calls emits no evidence, which is indistinguishable from the bug
   * this closes. Pin the CALL SITE in the checkpoint action, not just the function.
   *
   * `logsRootBeforeRouting` is kept as a pure function over source TEXT precisely so its
   * falsifiability can be shown against synthetic controls below — mutating the real file
   * to prove the guard bites would race git-sync's tree-wide sweep, which commits whatever
   * is on disk when it ticks (the probe would land committed even if nothing went wrong). */
  const logsRootBeforeRouting = (src: string): boolean => {
    // Must match a LOGGED CALL, not any occurrence of the name: a bare substring test also
    // matches the `export function integrationRootEvidence(` declaration, so it would pass
    // on a builder that is exported and never invoked — the exact regression this pins
    // against. (Caught by the synthetic controls below, not by review.)
    const logCall = /console\.log\([^\n]*integrationRootEvidence\(\)/.exec(src);
    const routingIdx = src.indexOf('await resolveCheckpointRouting(ctx');
    if (!logCall || routingIdx === -1) return false;
    return logCall.index < routingIdx;
  };

  it('is actually invoked by the green-checkpoint action (evidence must reach the run log)', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(fileURLToPath(new URL('./release-actions.ts', import.meta.url)), 'utf8');
    expect(
      logsRootBeforeRouting(src),
      'integrationRootEvidence() must be CALLED before routing — not merely exported',
    ).toBe(true);
  });

  it('...and that pin is falsifiable — it rejects the shapes it is meant to catch', () => {
    // exported but never called: the silent-no-evidence regression. This control is the
    // one that caught the first draft of the pin, which matched the declaration itself.
    expect(
      logsRootBeforeRouting('export function integrationRootEvidence() {}\nawait resolveCheckpointRouting(ctx, x);'),
    ).toBe(false);
    // called, but AFTER routing: missing from exactly the runs that fail early
    expect(
      logsRootBeforeRouting('await resolveCheckpointRouting(ctx, x);\nconsole.log(integrationRootEvidence());'),
    ).toBe(false);
    // computed but never logged: evidence that never reaches the run log is no evidence
    expect(
      logsRootBeforeRouting('const line = integrationRootEvidence();\nawait resolveCheckpointRouting(ctx, x);'),
    ).toBe(false);
    // routing site renamed away: the pin must not silently pass on a moved target
    expect(logsRootBeforeRouting('console.log(integrationRootEvidence());')).toBe(false);
    // calibration: the real shape must still pass, or the refusals above prove nothing
    expect(
      logsRootBeforeRouting(
        'console.log(`${orchestratorStdoutTag()} ${integrationRootEvidence()}`);\nawait resolveCheckpointRouting(ctx, x);',
      ),
    ).toBe(true);
  });
});

describe('WI-10004928 part 1: emitGateToolingCrashEvent', () => {
  it('emits the global and pipeline-scoped inconclusive wake with reason gate-tooling-crash', async () => {
    const { emitGateToolingCrashEvent } = await import('./release-actions');
    const emit = vi.fn(async (..._a: unknown[]) => ({}));
    await emitGateToolingCrashEvent(
      '/x/papercusp',
      { exitCode: 1, runId: 'r1', logPath: '/tmp/l.log', tail: 'Top-level await is currently not supported' },
      emit as never,
    );
    const calls = emit.mock.calls.map(([a]) => a as { key: string; payload: Record<string, unknown>; summary: string });
    expect(calls.map((c) => c.key)).toEqual(['green-checkpoint:inconclusive', 'green-checkpoint:inconclusive:papercusp']);
    for (const c of calls) {
      expect(c.payload).toMatchObject({ reason: 'gate-tooling-crash', exitCode: 1, pipeline: 'papercusp', sha: null });
      expect(c.summary).toContain('GATE TOOLING CRASHED (exit 1)');
    }
  });

  it('a failing emit on one key never throws and still tries the other', async () => {
    const { emitGateToolingCrashEvent } = await import('./release-actions');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn(async () => {
      throw new Error('db down');
    });
    await expect(
      emitGateToolingCrashEvent('/x/papercusp', { exitCode: null, runId: null, logPath: null, tail: null }, emit as never),
    ).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('WI-10004928 part 1 manual leg: sweepManualCheckpointToolingCrash', () => {
  const crashTuple = '\n__GREEN_CHECKPOINT_SYSTEMD_TERMINAL__ service_result=exit-code exit_code=exited exit_status=1\n';
  const loadCrashLog = `SyntaxError: Top-level await is currently not supported with the "cjs" output format${crashTuple}`;
  const sweep = async (log: string | null, claimed = true) => {
    const { sweepManualCheckpointToolingCrash } = await import('./release-actions');
    const emit = vi.fn(async (..._a: unknown[]) => ({}));
    const claimSentinel = vi.fn(async () => claimed);
    const result = await sweepManualCheckpointToolingCrash('/x/papercusp', {
      resolveLog: async () => '/tmp/run-1.log',
      readLog: async () => log,
      claimSentinel,
      emit: emit as never,
    });
    return { result, emit, claimSentinel };
  };

  it('alarms a load-time crash: abnormal systemd tuple, no result marker, no candidate', async () => {
    const { result, emit, claimSentinel } = await sweep(loadCrashLog);
    expect(result).toEqual({ status: 'alarmed', logPath: '/tmp/run-1.log' });
    expect(claimSentinel).toHaveBeenCalledWith('/tmp/run-1.log.tooling-crash-alarmed');
    const payloads = emit.mock.calls.map(([a]) => (a as { payload: Record<string, unknown> }).payload);
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ reason: 'gate-tooling-crash', exitCode: 1, logPath: '/tmp/run-1.log' });
  });

  it('is idempotent per run: an existing sentinel suppresses a second alarm', async () => {
    const { result, emit } = await sweep(loadCrashLog, false);
    expect(result.status).toBe('already-alarmed');
    expect(emit).not.toHaveBeenCalled();
  });

  it('does not call a killed/timed-out suite a tooling crash (it resolved a candidate first)', async () => {
    const { result, emit } = await sweep(`checkpointing candidate abc123def456${crashTuple}`);
    expect(result.status).toBe('not-a-tooling-crash');
    expect(emit).not.toHaveBeenCalled();
  });

  it('ignores a clean exit and a still-running unit (no ExecStopPost tuple yet)', async () => {
    const clean = await sweep(
      '\n__GREEN_CHECKPOINT_SYSTEMD_TERMINAL__ service_result=success exit_code=exited exit_status=0\n',
    );
    expect(clean.result.status).toBe('not-a-tooling-crash');
    const running = await sweep('booting...\n');
    expect(running.result.status).toBe('no-terminal-evidence');
    const missing = await sweep(null);
    expect(missing.result.status).toBe('no-log');
    expect(clean.emit).not.toHaveBeenCalled();
  });

  it('WI-10005994: a torn marker (begins mid-line, JSON cut) is result-marker-torn, never an alarmed crash', async () => {
    const torn = `{\n  "reason": "not-green",\n  "paths": [  __GREEN_CHECKPOINT_RESULT__ {"reason":"not-green","green":false,"repairQueue":{"adm\n  "x": 1\n}${crashTuple}`;
    const { result, emit, claimSentinel } = await sweep(torn);
    expect(result).toEqual({ status: 'result-marker-torn', logPath: '/tmp/run-1.log' });
    expect(emit).not.toHaveBeenCalled();
    expect(claimSentinel).not.toHaveBeenCalled();
  });

  it('WI-10005994: an intact marker that begins mid-line is still a rendered verdict, not a crash', async () => {
    const { result, emit } = await sweep(`tail of the stderr dump __GREEN_CHECKPOINT_RESULT__ {"reason":"not-green","green":false}${crashTuple}`);
    expect(result.status).toBe('not-a-tooling-crash');
    expect(emit).not.toHaveBeenCalled();
  });

  it('WI-10005994: checkpointResultMarkerState separates absent / parsed / torn and skips fixture lines', async () => {
    const { checkpointResultMarkerState } = await import('./release-actions');
    const { ORCHESTRATOR_STDOUT_TAG_UNDER_TEST } = await import('../../release/checkpoint-log-tags');
    expect(checkpointResultMarkerState('no verdict here\n')).toBe('absent');
    expect(checkpointResultMarkerState('__GREEN_CHECKPOINT_RESULT__ {"reason":"advanced","green":true}\n')).toBe('parsed');
    expect(checkpointResultMarkerState('x __GREEN_CHECKPOINT_RESULT__ {"reason":"adv\nanced"}\n')).toBe('torn');
    expect(
      checkpointResultMarkerState('__GREEN_CHECKPOINT_RESULT__ {"rea\n__GREEN_CHECKPOINT_RESULT__ {"reason":"advanced","green":true}\n'),
    ).toBe('parsed');
    expect(checkpointResultMarkerState(`${ORCHESTRATOR_STDOUT_TAG_UNDER_TEST} __GREEN_CHECKPOINT_RESULT__ {"rea\n`)).toBe('absent');
  });

  it('WI-10006005: restores 500 failure and flake paths from the matching terminal log result', () => {
    const runId = 'large-path-run';
    const failingTests = Array.from(
      { length: 500 },
      (_, i) => 'packages/operator-core/lib/test-fixtures/failures/failure-' + i + '.test.ts',
    );
    const flakeSuspects = Array.from(
      { length: 500 },
      (_, i) => 'packages/operator-core/lib/test-fixtures/flakes/flake-' + i + '.test.ts',
    );
    const fullResult = {
      reason: 'not-green',
      green: false,
      candidate: '0123456789abcdef',
      runId,
      failingTests,
      flakeSuspects,
    };
    const marker: Record<string, unknown> = {
      ...fullResult,
      markerCompacted: { omitted: ['failingTests', 'flakeSuspects'] },
    };
    delete marker.failingTests;
    delete marker.flakeSuspects;
    const markerLine = GREEN_CHECKPOINT_RESULT_MARKER + ' ' + JSON.stringify(marker);
    const terminalLog = JSON.stringify(fullResult, null, 2) + '\n' + markerLine + '\n';

    const resolved = resolveCheckpointResultFromLogs(markerLine + '\n', terminalLog, runId);
    expect(resolved?.failingTests).toEqual(failingTests);
    expect(resolved?.flakeSuspects).toEqual(flakeSuspects);
    expect(resolveCheckpointResultFromLogs(markerLine + '\n', terminalLog, 'another-run')?.failingTests)
      .toBeUndefined();
  });

  it('WI-10005994: the torn cause wakes inconclusive awaiters with an honest reason, not "no suite ran"', async () => {
    const { emitGateToolingCrashEvent } = await import('./release-actions');
    const emit = vi.fn(async (..._a: unknown[]) => ({}));
    await emitGateToolingCrashEvent(
      '/x/papercusp',
      { exitCode: 1, runId: 'r1', logPath: '/tmp/run-1.log', tail: null, cause: 'result-marker-torn' },
      emit as never,
    );
    const calls = emit.mock.calls.map(([a]) => a as { key: string; summary: string; payload: Record<string, unknown> });
    expect(calls).toHaveLength(2);
    expect(calls[0].payload).toMatchObject({ reason: 'result-marker-torn', logPath: '/tmp/run-1.log' });
    expect(calls[0].summary).toContain('RESULT MARKER TORN');
    expect(calls[0].summary).not.toContain('no suite ran');
  });
});
