/**
 * release:checkpoint-run — the manual GATE-run verb (WI-1320 follow-up). Mocks the detached
 * launch primitive so the handler's role-gate + reply shape are asserted without firing a suite.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/release/checkpoint-run.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

vi.mock('../../release/gate-action-receipt', () => ({
  executeWithGateActionReceipt: vi.fn(async (input: {
    run: () => Promise<unknown>; ownerId: string;
  }) => ({ ok: true, receiptId: 'test-gate-action-receipt',
    ownership: { certainty: 'claim-row-locked-through-effect', workItem: 'WI-gate',
      holder: input.ownerId, takenAt: '2026-09-26T18:00:00.000Z' },
    effect: await input.run() })),
}));

vi.mock('../../release/checkpoint-serializer-authority', () => ({
  readCheckpointSerializerAuthority: vi.fn(async () => ({ status: 'none', reason: 'routine-not-paused' })),
  armPausedCheckpointTransition: vi.fn(async () => ({ status: 'unreadable', error: 'not configured in this test' })),
}));

// EI-21456558908416090: the manual-run authority read fails CLOSED (it is about to spend a
// ~55min suite), so without a hermetic default every handler case here refuses on the absent
// test DB. Spread the real module so only this one read is stubbed. Cases that exercise the
// withheld branch override `manualRunAdmission` per-test.
vi.mock('../../release-checkpoint-config', async (importActual) => ({
  ...(await importActual<typeof import('../../release-checkpoint-config')>()),
  readManualRunAdmission: vi.fn(async () => ({ status: 'clear' })),
  readQualificationAdmission: vi.fn(async () => ({ status: 'clear' })),
}));

const qualificationMocks = vi.hoisted(() => ({
  read: vi.fn(),
  begin: vi.fn(),
  wait: vi.fn(),
  reserve: vi.fn(),
  eligibility: vi.fn(),
  recover: vi.fn(),
}));
const routingMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
}));
const livenessMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
}));
vi.mock('../../release/checkpoint-qualification-transaction', async (orig) => ({
  ...(await orig<typeof import('../../release/checkpoint-qualification-transaction')>()),
  readStoredQualification: (...a: unknown[]) => qualificationMocks.read(...a),
  recoverStoredQualificationHistoricalPreSuiteError: (...a: unknown[]) => qualificationMocks.recover(...a),
  beginStoredQualification: (...a: unknown[]) => qualificationMocks.begin(...a),
  waitStoredQualification: (...a: unknown[]) => qualificationMocks.wait(...a),
  reserveStoredQualificationRunner: (...a: unknown[]) => qualificationMocks.reserve(...a),
  recordStoredQualificationEligibility: (...a: unknown[]) => qualificationMocks.eligibility(...a),
}));
vi.mock('../../harness/routines/hive-release-env', () => ({
  resolveCheckpointRouting: (...a: unknown[]) => routingMocks.resolve(...a),
}));

function qualificationTransaction(input: Record<string, unknown>, phase = 'ready') {
  return {
    schemaVersion: 1 as const,
    attemptId: String(input.attemptId),
    createdAtMs: 1,
    updatedAtMs: 1,
    requiredAncestorSha: input.requiredAncestorSha ?? null,
    candidatePolicy: { kind: 'quiet-cut' as const, declaredPaths: input.declaredPaths ?? [] },
    candidate: input.candidate ?? null,
    phase,
    outcome: { kind: 'pending' as const },
    blockers: [],
    waitGeneration: 0,
    currentPhysicalRunner: null,
    evidenceRefs: [],
    previousAttemptId: null,
  };
}

const MAKE_CTX = (role = 'operator', overrides: Record<string, unknown> = {}) =>
  ({ log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), role, ...overrides }) as never;

function mockAutomaticTransferTarget(targetOwnerId: string, known = true) {
  livenessMocks.resolve.mockResolvedValue(
    known
      ? new Map([
          [
            targetOwnerId,
            {
              ownerId: targetOwnerId,
              sessionState: 'live',
              wakeable: true,
              liveTurn: true,
              confirmLiveness: false,
              heartbeatFresh: true,
            },
          ],
        ])
      : new Map(),
  );
  vi.doMock('../coordination/liveness-oracle', async () => {
    const actual = await vi.importActual<typeof import('../coordination/liveness-oracle')>(
      '../coordination/liveness-oracle',
    );
    return {
      ...actual,
      resolveSessionStates: (...args: unknown[]) => livenessMocks.resolve(...args),
    };
  });
}

function parse(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

/**
 * P-004: the handler now also asks whether the judged candidate CONTAINS the caller's
 * files. That read really shells out to git against the live repo — un-stubbed it made
 * these unit tests depend on whatever this box happened to have uncommitted (it did:
 * the assertion below started failing with a list of the author's own in-flight files).
 * Stub it to "nothing to report" so each case exercises only the branch it names; the
 * containment logic itself is tested in candidate-contains.test.ts and
 * release-checkpoint-launch.test.ts.
 */
/**
 * EI-20025784115349280 — the pre-launch exclusion gate, pinned OPEN. Its real implementation
 * forks git + systemctl against the live repo, so any test that passes `paths` and does not
 * inject this is testing whatever the fleet happened to commit in the last four minutes.
 * A test that wants the gate to FIRE supplies its own verdict instead of this one.
 */
const PRELAUNCH_OPEN = vi.fn(async () => ({
  refuse: false,
  proceedReason: 'no-declared-paths' as const,
  candidate: null,
  tip: null,
  quietCutSec: null,
  blockedPaths: [],
  waitSec: null,
}));

const NO_CONTAINMENT = vi.fn(async () => ({
  candidateSha: null,
  tipSha: null,
  source: 'caller-supplied' as const,
  included: [],
  missing: [],
  unknown: [],
  paths: [],
  excludedCommitsTouchingYourFiles: [],
  testImplSplitRisk: { detected: false, includedTests: [], missingImpl: [] },
  warning: null,
}));

beforeEach(() => {
  vi.resetModules();
  NO_CONTAINMENT.mockClear();
  routingMocks.resolve.mockReset();
  routingMocks.resolve.mockResolvedValue({ root: '/test-tooling-root', extraEnv: {}, clearEnv: [] });
  qualificationMocks.read.mockReset();
  qualificationMocks.begin.mockReset();
  qualificationMocks.wait.mockReset();
  qualificationMocks.reserve.mockReset();
  qualificationMocks.eligibility.mockReset();
  qualificationMocks.recover.mockReset();
  qualificationMocks.recover.mockResolvedValue({ status: 'unreadable', error: 'recovery not configured' });
  livenessMocks.resolve.mockReset();
  qualificationMocks.read.mockResolvedValue({ status: 'none' });
  qualificationMocks.begin.mockImplementation(async (_target: unknown, input: Record<string, unknown>) => ({
    status: 'updated',
    transaction: qualificationTransaction(input),
  }));
  qualificationMocks.wait.mockImplementation(async (_target: unknown, input: Record<string, unknown>) => ({
    status: 'updated',
    transaction: qualificationTransaction(input, 'waiting'),
  }));
  qualificationMocks.reserve.mockImplementation(async (_target: unknown, input: Record<string, unknown>) => ({
    status: 'updated',
    transaction: qualificationTransaction(input, 'running'),
  }));
  qualificationMocks.eligibility.mockImplementation(async (_target: unknown, input: Record<string, unknown>) => ({
    status: 'updated',
    transaction: qualificationTransaction(input),
  }));
  // afterEach removes per-case authority overrides; reinstall the ordinary
  // no-serializer baseline before every import so later tests never open live PG.
  vi.doMock('../../release/checkpoint-serializer-authority', () => ({
    readCheckpointSerializerAuthority: vi.fn(async () => ({ status: 'none', reason: 'routine-not-paused' })),
    armPausedCheckpointTransition: vi.fn(async () => ({ status: 'unreadable', error: 'not configured in this test' })),
  }));
  // Keep the broad handler suite hermetic: queue-specific cases below opt into the real
  // helper after installing their routine/DB mocks.
  vi.doMock('../../release/checkpoint-required-ancestor', async () => {
    const actual = await vi.importActual<typeof import('../../release/checkpoint-required-ancestor')>(
      '../../release/checkpoint-required-ancestor',
    );
    return {
      ...actual,
      assessFrozenRepairQueuePreflight: vi.fn(async () => ({
        proceed: true,
        reason: 'clear' as const,
        candidate: null,
        candidateSource: 'unresolved' as const,
        repairQueue: null,
        frozenLineageIdentity: null,
        queueDecision: 'run-normal-gate' as const,
        nextAttempt: null,
        fixerSpawnId: null,
        fixerAlive: null,
      })),
    };
  });
});
afterEach(() => {
  vi.doUnmock('../../release-checkpoint-launch');
  vi.doUnmock('../../release/in-flight-retriage');
  vi.doUnmock('../../release/in-flight-candidate');
  vi.doUnmock('../../coord/gate-ownership');
  vi.doUnmock('../coordination/inbox-wake');
  vi.doUnmock('../coordination/identity');
  vi.doUnmock('../../workspace-registry');
  vi.doUnmock('../../harness/operator-home-harness');
  vi.doUnmock('../../harness/routines/release-actions');
  vi.doUnmock('@papercusp/db-org');
  vi.doUnmock('../../release/checkpoint-required-ancestor');
  vi.doUnmock('../../release/checkpoint-serializer-authority');
  vi.doUnmock('../../work-items');
  vi.doUnmock('../work_items/release-force-guard');
  vi.doUnmock('../coordination/liveness-oracle');
});

/**
 * EI-19343516395023183 — the cron-held in-flight shape these refire cases share. A run that
 * auto-refires keeps this EXACT envelope (`started_at`/pid belong to the outer frame and never
 * move across the in-process recursion), which is precisely why the reply needs the marker: the
 * refusal payload alone cannot distinguish "wedged" from "mid-rescue".
 */
const CRON_HELD_RUN = {
  active: true,
  unit: 'papercup-green-checkpoint-manual-1fxzuva (idle — a DIFFERENT process holds the shared run-lock, likely the hourly cron)',
  candidate: 'stale00checkout00head',
  current_head: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
  current_candidate: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
  candidate_stale: false,
  started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
  elapsed_sec: 1800,
  eta_sec: 1500,
  held_externally: true,
};

/** Stub ONLY the PG read; `describeRefireBudget`/`attributeRetriageToRun` stay real, so these
 *  cases exercise the genuine budget + attribution logic rather than a restatement of it. */
async function mockRefire(
  marker: Record<string, unknown> | null,
  alreadyRunning: Record<string, unknown> = CRON_HELD_RUN,
) {
  vi.doMock('../../release/in-flight-retriage', async (orig) => ({
    ...(await orig()),
    readInFlightRetriage: vi.fn(async () => marker),
  }));
  vi.doMock('../../release-checkpoint-launch', async (orig) => ({
    ...(await orig()),
    checkpointCandidateContainment: NO_CONTAINMENT,
    launchDetachedCheckpoint: vi.fn(async () => ({
      launched: false,
      unit: 'papercup-green-checkpoint-manual-1fxzuva',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual-1fxzuva.log',
      reason: 'already_running',
      alreadyRunning,
    })),
  }));
  const { default: tool } = await import('./checkpoint-run');
  return parse((await tool.handler({}, MAKE_CTX())) as never);
}

/**
 * EI-19343516395023183. The gate publishes `gate_health.inFlightRetriage` the instant it decides to
 * auto-refire, and every OTHER agent-facing surface already read it — coord:orient, dev:pipeline_position,
 * /admin/git. Not this one: the single verb whose misuse does damage, because firing it inside the
 * re-triage window DISCARDS the rescue and costs a full ~55min suite (green-checkpoint.ts:2566).
 * On 2026-08-02 that gap cost three agents a morning and produced a near-miss recommendation to
 * fire exactly this verb into a live rescue.
 */
describe('EI-19343516395023183: an in-flight auto-refire is surfaced on the already_running refusal', () => {
  const MARKER = {
    fromCandidate: '6f4181447486a33e4b471b82dee3ed0893c3efa6',
    refiringCandidate: '16dbb52a7849320e27832500bf2157f00b1db1c3',
    refireAttempt: 1,
    maxRefires: 2,
    failingFiles: ['hygiene.test.ts', 'release-actions.test.ts'],
    observedAtMs: Date.now() - 60_000, // after CRON_HELD_RUN started ⇒ attributable to it
    charged: true,
    totalRefires: 1,
    absoluteCeiling: 6,
  };

  it('⭐ leads the note with a STAND DOWN and names both candidates', async () => {
    const b = await mockRefire(MARKER);
    expect(String(b.note)).toMatch(/^🚨 AUTO-REFIRE IN FLIGHT — STAND DOWN/);
    expect(String(b.note)).toContain('16dbb52a7849'); // the sha being judged NOW
    expect(String(b.note)).toContain('6f4181447486'); // the one already discarded
    expect(String(b.note)).toMatch(/Do NOT fire a manual run/);
    expect(b).toMatchObject({
      in_flight_retriage: {
        from_candidate: '6f4181447486',
        refiring_candidate: '16dbb52a7849',
        at_cap: false,
        belongs_to_this_run: true,
        charged: true,
      },
    });
  });

  it('⭐ tells the caller not to go fix the files the abandoned red named — they already passed at tip', async () => {
    const b = await mockRefire(MARKER);
    expect(String(b.note)).toMatch(/already PASSED at tip — do not go fix them/);
    expect(String(b.note)).toContain('hygiene.test.ts');
  });

  /** The marker is the run's own published observation; `candidate` on the cron path is the
   *  checkpoint checkout's live HEAD — an inference that changes between reads. */
  it('⭐ containment is checked against the MARKER candidate, not the probed checkout HEAD', async () => {
    await mockRefire(MARKER);
    expect(NO_CONTAINMENT).toHaveBeenCalledWith(expect.objectContaining({ candidateSha: MARKER.refiringCandidate }));
  });

  it('warns that a red will STICK once the absolute ceiling is reached, even with the charged budget untouched', async () => {
    const b = await mockRefire({ ...MARKER, refireAttempt: 0, charged: false, totalRefires: 6 });
    expect(String(b.note)).toMatch(/LAST refire/);
    expect((b.in_flight_retriage as Record<string, unknown>).at_cap).toBe(true);
  });

  /** The run-lock is a singleton, so a marker predating this run's start is an EARLIER run's.
   *  Reporting it would silence a genuinely new red with a stale rescue. */
  it('⭐ does NOT stand the caller down on a marker written BEFORE this run started', async () => {
    const b = await mockRefire({ ...MARKER, observedAtMs: Date.parse(CRON_HELD_RUN.started_at) - 60_000 });
    expect(b.in_flight_retriage).toBeNull();
    expect(String(b.note)).not.toMatch(/STAND DOWN/);
    expect(String(b.note)).toMatch(/DIFFERENT process/); // falls through to the pre-existing branch
  });

  it("says so plainly when attribution is UNCONFIRMED rather than asserting the marker is this run's", async () => {
    const b = await mockRefire(MARKER, { ...CRON_HELD_RUN, started_at: null });
    expect(String(b.note)).toMatch(/STAND DOWN/);
    expect(String(b.note)).toMatch(/Attribution UNCONFIRMED/);
    expect((b.in_flight_retriage as Record<string, unknown>).belongs_to_this_run).toBeNull();
  });

  it('no marker ⇒ the pre-existing refusal is untouched (null means "no refire", not "unknown")', async () => {
    const b = await mockRefire(null);
    expect(b.in_flight_retriage).toBeNull();
    expect(String(b.note)).toMatch(/DIFFERENT process/);
    expect(String(b.note)).not.toMatch(/AUTO-REFIRE/);
  });
});

describe('release:checkpoint-run', () => {
  it('EI-212098: force/replaceStale/waitForEligibility cannot bypass an exclusive D-016 serializer', async () => {
    vi.doMock('../../release/checkpoint-serializer-authority', () => ({
      readCheckpointSerializerAuthority: vi.fn(async () => ({
        status: 'held',
        itemId: 'WI-40086',
        ownerId: 'su-serializer',
        pauseReason: 'D-012/D-013 live quiescence hold under WI-40086: writers active',
        holdReason: 'D-016 sole serializer hold: exact admission sequence',
      })),
    }));
    vi.doMock('../coordination/identity', () => ({
      resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-other', workspaceId: 'papercusp-workspace' })),
    }));
    const launchSpy = vi.fn(async () => ({ launched: true, unit: 'x', argv: [], logPath: '/tmp/x.log' }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const metadata = vi.fn();
    const ctx = {
      log: vi.fn(),
      signal: new AbortController().signal,
      progress: vi.fn(),
      role: 'operator',
      uiClientId: 'su-other',
      metadata,
    } as never;
    const b = parse(
      (await tool.handler(
        { force: true, replaceStale: true, waitForEligibility: true, reason: 'promote unrelated fix' },
        ctx,
      )) as never,
    );

    expect(launchSpy).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: false,
      launched: false,
      reason: 'serializer_authority_held',
      work_item: 'WI-40086',
      taken_by: 'su-serializer',
    });
    expect(String(b.note)).toMatch(/force:true, replaceStale:true, and waitForEligibility:true cannot bypass/);
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({
      standDown: 'serializer_authority_held',
      standDownWorkItem: 'WI-40086',
      standDownTakenBy: 'su-serializer',
      fireReason: 'promote unrelated fix',
    }));
  });

  it('EI-212098: the named serializer can still launch through its own fence', async () => {
    vi.doMock('../../release/checkpoint-serializer-authority', () => ({
      readCheckpointSerializerAuthority: vi.fn(async () => ({
        status: 'held',
        itemId: 'WI-40086',
        ownerId: 'su-serializer',
        pauseReason: 'D-012/D-013 live quiescence hold under WI-40086: ready',
        holdReason: 'D-016 sole serializer hold: exact admission sequence',
      })),
    }));
    vi.doMock('../coordination/identity', () => ({
      resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-serializer', workspaceId: 'papercusp-workspace' })),
    }));
    // Hermetic ownership baseline: a live workspace claim must not make this serializer-fence
    // unit test branch on whichever incident the shared test host happens to be running.
    vi.doMock('../../coord/gate-ownership', async (orig) => ({
      ...(await orig<typeof import('../../coord/gate-ownership')>()),
      readGateOwnership: vi.fn(async () => ({
        eventKey: 'gate-red-streak:papercusp',
        workItem: null,
        claimState: 'no-object',
        unknown: null,
        takenBy: null,
        takenAt: null,
        lastProgressAt: null,
        expiresAt: null,
        holderSessionState: null,
        duplicates: [],
        thread: { recent: [], total: 0 },
      })),
    }));
    const launchSpy = vi.fn(async () => ({ launched: true, unit: 'x', argv: [], logPath: '/tmp/x.log' }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const ctx = {
      log: vi.fn(),
      signal: new AbortController().signal,
      progress: vi.fn(),
      role: 'operator',
      uiClientId: 'su-serializer',
    } as never;
    const b = parse((await tool.handler({}, ctx)) as never);

    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(b).toMatchObject({ ok: true, launched: true });
  });

  it('EI-212098: an unreadable serializer authority fails closed before launch', async () => {
    vi.doMock('../../release/checkpoint-serializer-authority', () => ({
      readCheckpointSerializerAuthority: vi.fn(async () => ({ status: 'unreadable', error: 'pg unavailable' })),
    }));
    const launchSpy = vi.fn(async () => ({ launched: true, unit: 'x', argv: [], logPath: '/tmp/x.log' }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ force: true }, MAKE_CTX())) as never);

    expect(launchSpy).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: false,
      launched: false,
      reason: 'serializer_authority_unreadable',
      error: 'pg unavailable',
    });
    expect(b.refusal_provenance).toEqual(
      expect.objectContaining({
        serving_host: expect.any(String),
        serving_process_id: expect.anything(),
        serving_build_sha: expect.anything(),
        runner_code_freshness: expect.objectContaining({
          verdict: expect.stringMatching(/^(stale|fresh|unknown)$/),
        }),
      }),
    );
  });

  it('launches the detached checkpoint and reports it (operator role)', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: true,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual.log',
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const metadata = vi.fn();
    const result = await tool.handler({}, MAKE_CTX('operator', { metadata }));

    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(parse(result as never)).toMatchObject({
      ok: true,
      launched: true,
      unit: 'papercup-green-checkpoint-manual',
    });
    expect(metadata).toHaveBeenLastCalledWith(expect.objectContaining({
      gateActionReceipt: expect.objectContaining({
        action: 'checkpoint-run',
        effect: expect.objectContaining({
          status: 'detached-launch-accepted',
          unit: 'papercup-green-checkpoint-manual',
          publishedVerdict: 'unknown',
        }),
      }),
    }));
  });

  it('routes a subject-harness manual fire through its tooling root, subject root, env, and verdict target', async () => {
    const route = {
      root: '/papercusp-tooling',
      extraEnv: {
        PAPERCUSP_INTEGRATION_ROOT: '/portal-subject',
        PAPERCUSP_RELEASE_SLUG: 'portal',
      },
      clearEnv: ['DATABASE_URL'],
    };
    routingMocks.resolve.mockResolvedValueOnce(route);
    const launchSpy = vi.fn(async () => ({
      launched: true,
      unit: 'portal-checkpoint',
      argv: [],
      logPath: '/tmp/portal-checkpoint.log',
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const result = parse(
      (await tool.handler(
        {},
        MAKE_CTX('operator', { harnessSlug: 'portal', workspaceId: 'portal-workspace' }),
      )) as never,
    );

    expect(routingMocks.resolve).toHaveBeenCalledWith(
      { installSlug: 'portal', workspaceId: 'portal-workspace' },
      expect.any(String),
    );
    expect(launchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        root: '/papercusp-tooling',
        integrationRoot: '/portal-subject',
        extraEnv: route.extraEnv,
        clearEnv: ['DATABASE_URL'],
        target: { workspaceId: 'portal-workspace', installSlug: 'portal' },
      }),
    );
    expect(result).toMatchObject({ ok: true, launched: true });
    const { assessFrozenRepairQueuePreflight } = await import('../../release/checkpoint-required-ancestor');
    expect(assessFrozenRepairQueuePreflight).toHaveBeenCalledWith(
      null, '/portal-subject', { workspaceId: 'portal-workspace', installSlug: 'portal' },
    );
  });

  it('WI-5124: warns loudly in `note` when the quiet-cut excluded fresh commits (the "my fix was silently excluded" trap)', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: true,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual.log',
      willJudge: {
        candidate: 'aaaaaaa',
        tip: 'fffffff',
        quietCutApplied: true,
        quietCutSec: 240,
        excludedCommits: ['fffffff my just-landed fix'],
      },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({}, MAKE_CTX())) as never);
    expect(b.ok).toBe(true);
    // EI-18759622667757826: still warns, but as a PREDICTION — the assertion used to demand the
    // settled-fact wording ("EXCLUDED 1 commit"), which is the defect, not the contract.
    expect(String(b.note)).toMatch(/predicted exclusion: 1 commit/i);
    expect(String(b.note)).toContain('my just-landed fix');
  });

  // WI-10003521: a launcher whose env declares no capacity contract silently runs the suite at
  // SHARED capacity. The launch result carries the warning; the reply's note must render it.
  it('WI-10003521: renders the launcher capacity warning in `note` and passes `capacity` through', async () => {
    const warning = '⚠ CAPACITY: the launching process declares no PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE';
    const launchSpy = vi.fn(async () => ({
      launched: true,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual.log',
      capacity: { mode: 'shared', source: 'default', declared: null, warning },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({}, MAKE_CTX())) as never);
    expect(b.ok).toBe(true);
    expect(String(b.note)).toContain(warning);
    expect(b.capacity).toMatchObject({ mode: 'shared', source: 'default' });
  });

  it('WI-10003521: a declared contract adds nothing to `note`', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: true,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual.log',
      capacity: { mode: 'reserved', source: 'process-env', declared: 'reserved', warning: null },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({}, MAKE_CTX())) as never);
    expect(b.ok).toBe(true);
    expect(String(b.note)).not.toMatch(/CAPACITY/);
  });

  // EI-18759622667757826: `excludedCommits` is resolved ~1-2s BEFORE the detached run re-resolves
  // its own candidate, and the quiet cut is a pure age test — so a commit seconds short of the
  // window ages in and IS judged. Reported as flat fact, that reading told the filer an expensive
  // healthy run was worthless, and the only lever that looks like a fix is killing it. The reply
  // must lead with the aging number and name waiting as the correct move.
  it('EI-18759622667757826: an exclusion about to age in is reported as a probably-pessimistic PREDICTION, not as fact', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: true,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual.log',
      willJudge: {
        candidate: 'aaaaaaa',
        tip: 'fffffff',
        quietCutApplied: true,
        quietCutSec: 240,
        excludedCommits: ['fffffff my just-landed fix'],
        excludedPaths: ['packages/operator-core/lib/x.ts'],
        excludedEligibility: [{ sha: 'fffffff', subject: 'my just-landed fix', eligibleInSec: 2 }],
        soonestEligibleInSec: 2,
      },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const note = String(parse((await tool.handler({}, MAKE_CTX())) as never).note);

    expect(note).toMatch(/prediction only/i);
    expect(note).toMatch(/pessimistic/i);
    // The load-bearing correction: it says the run will very likely judge it after all.
    expect(note).toMatch(/very likely judge them after all/i);
    // …and never leaves "kill the run" as the reader's inference.
    expect(note).toMatch(/do not kill the run/i);
    expect(note).toMatch(/checkpoint:await/);
    // The old settled-fact grammar must not come back: it asserted an unmade decision.
    expect(note).not.toMatch(/they get the NEXT run/i);
  });

  it('EI-18759622667757826: an exclusion far from eligibility still reads as a prediction and never recommends killing', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: true,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual.log',
      willJudge: {
        candidate: 'aaaaaaa',
        tip: 'fffffff',
        quietCutApplied: true,
        quietCutSec: 240,
        excludedCommits: ['fffffff someone elses commit'],
        excludedPaths: ['apps/operator/x.ts'],
        excludedEligibility: [{ sha: 'fffffff', subject: 'someone elses commit', eligibleInSec: 180 }],
        soonestEligibleInSec: 180,
      },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const note = String(parse((await tool.handler({}, MAKE_CTX())) as never).note);

    expect(note).toMatch(/predicted exclusion/i);
    expect(note).toMatch(/~180s/);
    expect(note).toMatch(/killing a live run is never the recovery/i);
    expect(note).not.toMatch(/prediction only/i);
  });

  it('WI-5124: no exclusion warning in `note` when the quiet-cut judged the tip directly', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: true,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual.log',
      willJudge: {
        candidate: 'aaaaaaa',
        tip: 'aaaaaaa',
        quietCutApplied: false,
        quietCutSec: 240,
        excludedCommits: [],
      },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({}, MAKE_CTX())) as never);
    expect(b.ok).toBe(true);
    expect(String(b.note)).not.toMatch(/EXCLUDED/i);
  });

  it('reports ok:false with the reason when the launch is refused', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: false,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual.log',
      reason: 'systemd-run exited 1 (a manual checkpoint may already be running)',
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({}, MAKE_CTX())) as never);
    expect(b.ok).toBe(false);
    expect(String(b.note)).toMatch(/already running|not launched/i);
  });

  // EI-7426: firing the green verdict is verification-only + self-locked, and the persona tells
  // ANY red-fixing agent to fire it ("fix the reds → release:checkpoint-run → release:deploy").
  // It used to copy checkpoint-config's operator-config-write gate (correct there — it mutates
  // config; wrong here — this mutates nothing), so pipeline roles that greened the reds hit a
  // recurring structural tool-error. There is now no in-handler role gate; the invoke allowlist
  // (SU_ROLES + bee/release-fixer/release-manager) is the access control.
  it.each(['worker', 'debugger', 'cup', 'release-fixer'])(
    'fires the verdict for a non-operator red-fixing role (%s) — no operator-config-write gate (EI-7426)',
    async (role) => {
      const launchSpy = vi.fn(async () => ({
        launched: true,
        unit: 'papercup-green-checkpoint-manual',
        argv: [],
        logPath: '/tmp/papercup-green-checkpoint-manual.log',
      }));
      vi.doMock('../../release-checkpoint-launch', async (orig) => ({
        ...(await orig()),
        launchDetachedCheckpoint: launchSpy,
        checkpointCandidateContainment: NO_CONTAINMENT,
      }));

      const { default: tool } = await import('./checkpoint-run');
      const b = parse((await tool.handler({}, MAKE_CTX(role))) as never);

      expect(launchSpy).toHaveBeenCalledTimes(1);
      expect(b).toMatchObject({ ok: true, launched: true });
    },
  );

  it('advertises the invoke allowlist to the red-fix cohort (mirrors release:deploy safe ops)', async () => {
    const { default: tool } = await import('./checkpoint-run');
    const roles = (tool as { agentRoles?: readonly string[] }).agentRoles ?? [];
    // The specific pipeline roles the watchdog observed hitting the structural error, plus the
    // wider red-fix cohort, must be invoke-allowed (EI-7426).
    for (const r of [
      'worker',
      'scoper',
      'validator',
      'reviewer',
      'debugger',
      'cup',
      'release-fixer',
      'release-manager',
    ]) {
      expect(roles).toContain(r);
    }
  });

  // WI-1562: the refuse-when-active path returns a STRUCTURED already_running reply instead of
  // a bare reason string, so a concurrent caller can tell "wait for it" from "try again".
  it('reports a structured already_running reply when a run is already active (WI-1562)', async () => {
    const launchSpy = vi.fn(async (opts: { force?: boolean }) => ({
      launched: false,
      unit: 'papercup-green-checkpoint-manual-1fxzuva',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual-1fxzuva.log',
      reason: 'already_running',
      alreadyRunning: {
        active: true,
        unit: 'papercup-green-checkpoint-manual-1fxzuva',
        candidate: '98817077fd79af9dfee00076a1c6e90445d268af',
        current_head: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
        current_candidate: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
        candidate_stale: true,
        quiet_cut_sec: 240,
        started_at: '2026-07-02T10:44:43Z',
        elapsed_sec: 8700, // OLD run — the EI-9672 wedged case (the launcher, mocked here, makes the decision)
        progress_at: '2026-07-02T11:00:00Z',
        current_phase: 'suite',
        eta_sec: 2100,
        eta_basis: 'full-suite',
      },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const metadata = vi.fn();
    const b = parse((await tool.handler({}, MAKE_CTX('operator', { metadata })) as never));

    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({
      gateActionReceipt: expect.objectContaining({
        action: 'checkpoint-run',
        effect: expect.objectContaining({ status: 'not-launched', reason: 'already_running' }),
      }),
    }));

    expect(launchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        force: undefined,
        logicalAttemptId: expect.any(String),
      }),
    );
    expect(b).toMatchObject({
      ok: false,
      already_running: true,
      unit: 'papercup-green-checkpoint-manual-1fxzuva',
      candidate: '98817077fd79af9dfee00076a1c6e90445d268af',
      current_head: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
      current_candidate: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
      candidate_stale: true,
      quiet_cut_sec: 240,
      started_at: '2026-07-02T10:44:43Z',
      elapsed_sec: 8700,
      progress_at: '2026-07-02T11:00:00Z',
      current_phase: 'suite',
      eta_sec: 2100,
      eta_basis: 'full-suite',
    });
    expect(String(b.note)).toMatch(/replaceStale:true/);
  });

  // EI-11667 recurrence guard: a YOUNG stale run's note must NOT recommend replaceStale —
  // that recommendation is exactly what induced the 2026-07-13 fleet replace-storm (four sus
  // serially killing each other's runs; no verdict for 2h). Young-stale is NORMAL, not wedged.
  it('a YOUNG stale run gets a wait-for-verdict note, never a replaceStale recommendation (EI-11667)', async () => {
    // Capture the fixture clock before the dynamic import/handler work. Under a queued heavy
    // lane that work can exceed a minute, so comparing the fixture's progress_at against a
    // later Date.now() turns this healthy freshness assertion into a load-sensitive flake.
    const fixtureNow = Date.now();
    const launchSpy = vi.fn(async () => ({
      launched: false,
      unit: 'papercup-green-checkpoint-manual-1fxzuva',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual-1fxzuva.log',
      reason: 'already_running',
      alreadyRunning: {
        active: true,
        unit: 'papercup-green-checkpoint-manual-1fxzuva',
        candidate: '98817077fd79af9dfee00076a1c6e90445d268af',
        current_head: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
        current_candidate: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
        candidate_stale: true,
        quiet_cut_sec: 240,
        started_at: new Date(fixtureNow - 5 * 60_000).toISOString(),
        elapsed_sec: 300, // 5 min — a healthy in-progress run on a busy tree
        progress_at: new Date(fixtureNow - 5_000).toISOString(),
        current_phase: 'suite',
        eta_sec: 10500,
        eta_basis: 'full-suite',
        replace_refused_progressing: true,
      },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ replaceStale: true }, MAKE_CTX())) as never);

    expect(b).toMatchObject({
      ok: false,
      already_running: true,
      candidate_stale: true,
      replace_refused_progressing: true,
      elapsed_sec: 300,
      current_phase: 'suite',
      eta_basis: 'full-suite',
    });
    expect(Date.parse(String(b.progress_at))).toBeGreaterThan(fixtureNow - 60_000);
    expect(String(b.note)).not.toMatch(/Pass replaceStale:true/);
    expect(String(b.note)).toMatch(/Do NOT replace/i);
    expect(String(b.note)).toMatch(/current_phase \+ progress_at/);
    expect(String(b.note)).toMatch(/not a measured time-to-verdict/);
  });

  // EI-18757736867106199 — the ADVICE must not recommend what the ENFORCEMENT refuses.
  //
  // classifyReplaceRequest already refuses to stop a `delivering` run at any age
  // (EI-18757156963245979), but this tool's `note` was still computed from age ALONE. So for
  // an OLD + stale + delivering run — a run whose suite is done and which is re-triaging a
  // stale red, i.e. the gate self-healing — the tool said "Pass replaceStale:true to stop it"
  // while the launch path would refuse to do it. Observed 2026-07-27: told by the tool that
  // killing it was correct, a caller read the refusal as an obstacle and killed the run
  // out-of-band instead, discarding an auto-refire that was working.
  //
  // Pinned here: at ANY age, a delivering run's note must steer to waiting, never to
  // replaceStale — and the reply must expose WHY, so the refusal is self-explaining.
  it('EI-18757736867106199: an OLD delivering run is never told to replaceStale — the note matches the policy', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: false,
      unit: 'papercup-green-checkpoint-manual-1fxzuva',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual-1fxzuva.log',
      reason: 'already_running',
      alreadyRunning: {
        active: true,
        unit: 'papercup-green-checkpoint-manual-1fxzuva',
        candidate: '98817077fd79af9dfee00076a1c6e90445d268af',
        current_head: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
        current_candidate: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
        candidate_stale: true,
        quiet_cut_sec: 240,
        started_at: new Date(Date.now() - 25 * 60_000).toISOString(),
        // Past the age line (the e4a93f8b shape: suite ran 1180s vs a 1200s threshold) — an
        // age-only rule calls this wedged and recommends the kill.
        elapsed_sec: 25 * 60,
        eta_sec: null,
        eta_basis: 'delivery-phase',
        delivering: true,
        replace_refused_delivering: true,
      },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ replaceStale: true }, MAKE_CTX())) as never);

    expect(b).toMatchObject({
      ok: false,
      already_running: true,
      candidate_stale: true,
      delivering: true,
      eta_sec: null,
      eta_basis: 'delivery-phase',
      replace_refused_delivering: true,
      // The policy verdict itself is now part of the reply, so the note can be checked
      // against it rather than the two drifting apart again.
      replace_allowed: false,
      replace_refused_reason: 'delivering',
    });
    // The regression: age said "wedged", so this string used to be the replaceStale nudge.
    expect(String(b.note)).not.toMatch(/Pass replaceStale:true/);
    expect(String(b.note)).toMatch(/delivering/);
    expect(String(b.note)).toMatch(/self-healing|SUITE IS DONE/i);
    expect(String(b.note)).toContain('checkpoint:await');
  });

  // WI-5685: the manual unit can be idle while the hourly CRON tick still holds the shared
  // run-lock — this is the class that used to sail past the pre-launch check entirely
  // (launched:true, then a silent skipped-locked inside the detached process a moment later).
  // The reply's `note` must clearly say force/replaceStale cannot help, unlike the manual-vs-
  // manual collision notes above.
  it('WI-5685: a run held by the cron (not the manual unit) gets a distinct held_externally note that steers away from force/replaceStale', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: false,
      unit: 'papercup-green-checkpoint-manual-1fxzuva (idle — a DIFFERENT process holds the shared run-lock, likely the hourly cron)',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual-1fxzuva.log',
      reason: 'already_running',
      alreadyRunning: {
        active: true,
        unit: 'papercup-green-checkpoint-manual-1fxzuva (idle — a DIFFERENT process holds the shared run-lock, likely the hourly cron)',
        candidate: null,
        current_head: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
        current_candidate: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
        candidate_stale: false,
        started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        elapsed_sec: 300,
        eta_sec: 10500,
        held_externally: true,
      },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({}, MAKE_CTX())) as never);

    expect(b).toMatchObject({ ok: false, already_running: true, held_externally: true, candidate: null });
    expect(String(b.note)).toMatch(/DIFFERENT process/);
    expect(String(b.note)).toMatch(/cannot free this slot/i);
    expect(String(b.note)).toContain('checkpoint:await');
    expect(String(b.note)).not.toMatch(/Pass replaceStale:true/);
    // EI-18695275971973546: candidate unresolved ⇒ the note must say so explicitly, rather
    // than silently letting the reader assume it matches current_candidate.
    expect(String(b.note)).toMatch(/could not be resolved/i);
  });

  // EI-18695275971973546: a wrong "this run can go green" broadcast happened because
  // `current_candidate` (a HYPOTHETICAL fresh-launch value) was misread as the in-flight run's
  // actual candidate while `candidate` sat null. Once `candidate` resolves (from the checkpoint
  // checkout's own HEAD), the note must name it explicitly and tell the reader to trust IT.
  it('EI-18695275971973546: a resolved held_externally candidate is named explicitly in the note, distinct from current_candidate', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: false,
      unit: 'papercup-green-checkpoint-manual-1fxzuva (idle — a DIFFERENT process holds the shared run-lock, likely the hourly cron)',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual-1fxzuva.log',
      reason: 'already_running',
      alreadyRunning: {
        active: true,
        unit: 'papercup-green-checkpoint-manual-1fxzuva (idle — a DIFFERENT process holds the shared run-lock, likely the hourly cron)',
        candidate: 'a0d9300182aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        current_head: '6ea7bdad60bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        current_candidate: '6ea7bdad60bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        candidate_stale: false,
        started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        elapsed_sec: 300,
        eta_sec: 10500,
        held_externally: true,
      },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({}, MAKE_CTX())) as never);

    expect(b).toMatchObject({
      ok: false,
      already_running: true,
      held_externally: true,
      candidate: 'a0d9300182aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(String(b.note)).toContain('a0d9300182aa');
    expect(String(b.note)).toMatch(/verify your fix against THAT sha/i);
    expect(String(b.note)).not.toMatch(/Pass replaceStale:true/);
  });

  it('passes force:true through to the launch primitive', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: true,
      unit: 'papercup-green-checkpoint-manual-1fxzuva',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual-1fxzuva.log',
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

    const { default: tool } = await import('./checkpoint-run');
    await tool.handler({ force: true }, MAKE_CTX());

    expect(launchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        force: true,
        logicalAttemptId: expect.any(String),
      }),
    );
  });

  /* ----------------------------------------------------------------------- *
   * P-004 (EI-18752644493166307) — the containment answer, in the reply.
   *
   * The filer burned two gate runs judging candidates without their fix, and had
   * restated the correct rule to the owner an hour earlier. That is the evidence
   * that prose is the wrong layer: a rule you must recall at exactly the right
   * instant only fires for someone who already knows. It has to be in the return
   * value, at the moment of the mistake.
   * ----------------------------------------------------------------------- */
  const LAUNCHED = {
    launched: true,
    unit: 'papercup-green-checkpoint-manual',
    argv: [],
    logPath: '/tmp/papercup-green-checkpoint-manual.log',
    willJudge: {
      candidate: 'aaaaaaa',
      tip: 'fffffff',
      quietCutApplied: true,
      quietCutSec: 240,
      excludedCommits: ['fffffff my just-landed fix'],
      excludedPaths: ['packages/operator-core/lib/mine.ts'],
    },
  };

  const mockWith = (containment: unknown) => {
    const launchSpy = vi.fn(async () => LAUNCHED);
    const containmentSpy = vi.fn(async () => containment);
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: containmentSpy,
      // EI-20025784115349280: the pre-launch gate calls the REAL containment (an internal
      // module binding a doMock cannot reach), so without this a `paths` test forks git and
      // systemctl against the live repo — non-deterministic, and the verdict would depend on
      // whatever the fleet had just committed. These cases are about the POST-launch warning;
      // pin the gate open so they keep testing exactly that.
      assessPreLaunchExclusion: PRELAUNCH_OPEN,
    }));
    return { launchSpy, containmentSpy };
  };

  it('reports callerEditsInCandidate and leads the note with the hard warning', async () => {
    const { containmentSpy } = mockWith({
      candidateSha: 'aaaaaaa',
      tipSha: 'fffffff',
      source: 'caller-supplied',
      included: [],
      missing: ['packages/operator-core/lib/mine.ts'],
      unknown: [],
      paths: [],
      excludedCommitsTouchingYourFiles: [],
      testImplSplitRisk: { detected: false, includedTests: [], missingImpl: [] },
      warning: '⚠ THIS RUN WILL NOT SEE 1 of your file(s). A RED from it is NOT evidence your change failed.',
    });

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ paths: ['packages/operator-core/lib/mine.ts'] }, MAKE_CTX())) as never);

    // The caller's declared paths reach the check against the commit that will be judged.
    expect(containmentSpy).toHaveBeenCalledWith({
      candidateSha: 'aaaaaaa',
      tipSha: 'fffffff',
      paths: ['packages/operator-core/lib/mine.ts'],
      root: '/test-tooling-root',
    });
    expect(b.callerEditsInCandidate).toMatchObject({
      missing: ['packages/operator-core/lib/mine.ts'],
      candidateReliability: 'exact-transported',
      verifiedAgainstActualWriter: true,
    });
    expect(b.candidateBinding).toMatchObject({ status: 'exact-transported', actualCandidate: 'aaaaaaa' });
    expect(String(b.note)).toMatch(/TRANSPORTED CANDIDATE/);
    expect(String(b.note)).toMatch(/not evidence your change failed/i);
  });

  /**
   * The old warning ended at "if your fix is among them" and listed SHAS — the one space
   * the reader has no information about. When containment cannot resolve it, the fallback
   * must at least answer in PATH space, which the caller CAN match against its own edits.
   */
  it('falls back to naming the FILES the excluded commits touch, not just the shas', async () => {
    mockWith({
      candidateSha: 'aaaaaaa',
      tipSha: 'fffffff',
      source: 'inferred-uncommitted',
      included: [],
      missing: [],
      unknown: [],
      paths: [],
      excludedCommitsTouchingYourFiles: [],
      testImplSplitRisk: { detected: false, includedTests: [], missingImpl: [] },
      warning: null,
    });

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({}, MAKE_CTX())) as never);
    expect(String(b.note)).toMatch(/Those commits touch: packages\/operator-core\/lib\/mine\.ts/);
    expect(String(b.note)).toMatch(/not evidence your change failed/i);
    expect(String(b.note)).not.toMatch(/if your fix is among them/);
  });

  it('confirms containment positively when the candidate DOES carry the files', async () => {
    mockWith({
      candidateSha: 'aaaaaaa',
      tipSha: 'aaaaaaa',
      source: 'caller-supplied',
      included: ['packages/operator-core/lib/mine.ts'],
      missing: [],
      unknown: [],
      paths: [],
      excludedCommitsTouchingYourFiles: [],
      testImplSplitRisk: { detected: false, includedTests: [], missingImpl: [] },
      warning: null,
    });

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ paths: ['packages/operator-core/lib/mine.ts'] }, MAKE_CTX())) as never);
    expect(String(b.note)).toMatch(/exact transported candidate/i);
    expect(String(b.note)).not.toMatch(/real verdict on your change/);
    expect(b.callerEditsInCandidate).toMatchObject({
      candidateReliability: 'exact-transported',
      verifiedAgainstActualWriter: true,
    });
    expect(b.candidateBinding).toMatchObject({ status: 'exact-transported', actualCandidate: 'aaaaaaa' });
    // The generic exclusion notice is kept but DOWNGRADED — it is provably not about the
    // caller's files, so it must not read as a warning that shadows the positive answer.
    expect(String(b.note)).toMatch(/none of the files you named/);
    // The only warning is the new binding rail; the positive containment itself stays positive.
    expect(String(b.note)).toMatch(/CANDIDATE BINDING EXACT/);
    expect(String(b.note)).not.toMatch(/TRANSPORTED CANDIDATE lacks/);
  });

  it('answers containment on the already_running path too — that verdict is the one landing', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: false,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/x.log',
      reason: 'already_running',
      alreadyRunning: { active: true, unit: 'u', candidate: 'inflight1', current_head: 'tip1' },
    }));
    const containmentSpy = vi.fn(async () => ({
      candidateSha: 'inflight1',
      tipSha: 'tip1',
      source: 'caller-supplied' as const,
      included: [],
      missing: ['mine.ts'],
      unknown: [],
      paths: [],
      excludedCommitsTouchingYourFiles: [],
      testImplSplitRisk: { detected: false, includedTests: [], missingImpl: [] },
      warning: '⚠ the in-flight run cannot see mine.ts',
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: containmentSpy,
      assessPreLaunchExclusion: PRELAUNCH_OPEN,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ paths: ['mine.ts'] }, MAKE_CTX())) as never);
    // Checked against the IN-FLIGHT candidate, never the hypothetical fresh one.
    expect(containmentSpy).toHaveBeenCalledWith({
      candidateSha: 'inflight1',
      tipSha: 'tip1',
      paths: ['mine.ts'],
      root: '/test-tooling-root',
    });
    expect(b.containment_warning).toMatch(/cannot see mine\.ts/);
  });

  /**
   * EI-21044758600216699 — regression guard. Before the fix, an ORDINARY (non-refiring,
   * cron-held) run's `already_running` reply had no way to read `gate_health.inFlightCandidate`
   * (published on EVERY invocation, including a run's first candidate — unlike
   * `inFlightRetriage`, which exists only after a refire) and fell straight to the checkout-HEAD
   * inference (`a.candidate`). `mapCheckpointRunInFlight` (dev:pipeline_position's
   * `checkpointRunInFlight` leg) already preferred that marker, so the two tools reported
   * DIFFERENT candidates for the SAME live run — measured live as a receipt naming one sha
   * `active` while a `dev:pipeline_position` call seconds later named a different one.
   */
  it('EI-21044758600216699: an ordinary cron-held run reports its OWN published candidate marker, not the checkout-HEAD inference', async () => {
    const MARKER_CANDIDATE = 'markercandidate11111111111111111111111111';
    const launchSpy = vi.fn(async () => ({
      launched: false,
      unit: 'papercup-green-checkpoint-manual-1fxzuva (idle — a DIFFERENT process holds the shared run-lock, likely the hourly cron)',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual-1fxzuva.log',
      reason: 'already_running',
      alreadyRunning: {
        active: true,
        unit: 'papercup-green-checkpoint-manual-1fxzuva (idle — a DIFFERENT process holds the shared run-lock, likely the hourly cron)',
        // The checkout-HEAD inference — deliberately DIFFERENT from the marker's candidate below,
        // so a pre-fix run of this test asserts the WRONG sha and fails.
        candidate: 'staleinferredcheckouthead00000000000000000',
        current_head: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
        current_candidate: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
        candidate_stale: false,
        started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        elapsed_sec: 300,
        eta_sec: 10500,
        held_externally: true,
      },
    }));
    const containmentSpy = vi.fn(async () => ({
      candidateSha: MARKER_CANDIDATE,
      tipSha: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
      source: 'caller-supplied' as const,
      included: ['mine.ts'],
      missing: [],
      unknown: [],
      paths: [],
      excludedCommitsTouchingYourFiles: [],
      testImplSplitRisk: { detected: false, includedTests: [], missingImpl: [] },
      warning: null,
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: containmentSpy,
      assessPreLaunchExclusion: PRELAUNCH_OPEN,
    }));
    vi.doMock('../../release/in-flight-candidate', async (orig) => ({
      ...(await orig()),
      readInFlightCandidate: vi.fn(async () => ({
        candidate: MARKER_CANDIDATE,
        base: null,
        selectedAtMs: Date.now() - 1000,
        quietCutApplied: false,
        tipAtSelection: null,
        refireDepth: 0,
        pid: 12345,
        observedAtMs: Date.now() - 500,
      })),
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ paths: ['mine.ts'] }, MAKE_CTX())) as never);

    // The reply's own `candidate` field names the run's PUBLISHED marker, not the inference —
    // the exact field that used to disagree with dev:pipeline_position.
    expect(b.candidate).toBe(MARKER_CANDIDATE);
    // No longer an inference, so containment must be COMPUTED (never refused) against the
    // marker's candidate.
    expect(containmentSpy).toHaveBeenCalledWith({
      candidateSha: MARKER_CANDIDATE,
      tipSha: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
      paths: ['mine.ts'],
      root: '/test-tooling-root',
    });
    expect(b.callerEditsInCandidate).toMatchObject({ included: ['mine.ts'] });
    // A candidate resolved from the run's own marker is an OBSERVATION, not an inference — no
    // reliability caveat should ride along.
    expect(b._fieldReliability).toBeUndefined();
  });
});

describe('EI-21047439235631660: required ancestor is checked against the frozen-queue candidate before launch', () => {
  const REQUIRED = '65b369adb8a9eb3fd7a2e3a93ab4eaedcad7c35e';
  const QUEUE_HEAD = '7490aaa814f1e2f6513bb8467e13acccf1ccace6';
  const CURRENT = 'b8360abde13b0000000000000000000000000000';
  const QUEUE_CANDIDATE = 'ed20de6dcb05c0c780437990f7f1070c3a92c853';
  const QUEUE_REVISION = 1_788_820_000_000;

  function mockQueue(queue: Record<string, unknown> | null | 'throws', fixerAlive: boolean | null = true) {
    vi.doMock('../../release/checkpoint-required-ancestor', async () =>
      vi.importActual<typeof import('../../release/checkpoint-required-ancestor')>(
        '../../release/checkpoint-required-ancestor',
      ),
    );
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'papercusp-workspace' }));
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
    vi.doMock('@papercusp/db-org', async (orig) => ({
      ...(await orig()),
      getOrgPg: () => ({ sql: Symbol('test-sql') }),
    }));
    vi.doMock('../../harness/routines/release-actions', () => ({
      readFrozenCandidateRepairQueue: vi.fn(async () => {
        if (queue === 'throws') throw new Error('queue read unavailable');
        return queue;
      }),
      releaseFixerSpawnAlive: vi.fn(async () => fixerAlive),
    }));
  }

  function awaitingFixerQueue(overrides: Record<string, unknown> = {}) {
    const now = Date.now();
    return {
      schemaVersion: 2,
      phase: 'awaiting-fixer',
      candidate: 'ed20de6dcb05c0c780437990f7f1070c3a92c853',
      base: null,
      repairHead: QUEUE_HEAD,
      affectedTestProofGroup: null,
      worktreePath: '/tmp/release-fixer',
      attempts: 3,
      openedAtMs: now - 60_000,
      updatedAtMs: now - 30_000,
      fixerSpawnId: 's-owner-gone',
      failingTests: ['lint:tsc'],
      ...overrides,
    };
  }

  // WI-10002334: a `queue-origin-unknown` refusal must NAME its remedy. The queue is well-formed
  // and merely carries no stamped origin (schema v3 permits a NULL qualificationAttemptId), so the
  // ONLY way forward is pinning the never-judged repairHead via requiredAncestorSha. Measured
  // 2026-09-22: without that hint the refusal reads as a POLICY WALL, and the caller's next move is
  // to escalate — suspend a safety rule, retire the queue, force a deploy — rather than pass one
  // argument. A frozen queue sat unjudged through exactly that chain until the pin was supplied.
  it('a blocked queue-origin-unknown reconciliation names requiredAncestorSha as the remedy', async () => {
    qualificationMocks.begin.mockImplementationOnce(async (_target: unknown, input: Record<string, unknown>) => ({
      status: 'conflict',
      transaction: qualificationTransaction(input),
      repairQueueReconciliation: {
        status: 'blocked',
        reason: 'queue-origin-unknown',
        predecessorAttemptId: 'attempt-old',
        successorAttemptId: String(input.attemptId),
        candidate: QUEUE_HEAD,
      },
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ force: true }, MAKE_CTX())) as never);

    expect(b).toMatchObject({ ok: false, launched: false, reason: 'qualification_transaction_conflict' });
    expect(String(b.note)).toMatch(/REMEDY/);
    expect(String(b.note)).toMatch(/requiredAncestorSha/);
    expect(String(b.note)).toMatch(/repairQueue\.repairHead/);
  });

  // CONTROL, and the point of the pair: the remedy must be SPECIFIC to queue-origin-unknown, not
  // pasted onto every refusal. Without this case the assertion above would still pass if the hint
  // were unconditional, which would make a wrong remedy look authoritative on unrelated refusals.
  it('does NOT advertise the requiredAncestorSha remedy for a different blocked reason', async () => {
    qualificationMocks.begin.mockImplementationOnce(async (_target: unknown, input: Record<string, unknown>) => ({
      status: 'conflict',
      transaction: qualificationTransaction(input),
      repairQueueReconciliation: {
        status: 'blocked',
        reason: 'queue-not-safe-unstarted',
        predecessorAttemptId: 'attempt-old',
        successorAttemptId: String(input.attemptId),
        candidate: QUEUE_HEAD,
      },
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ force: true }, MAKE_CTX())) as never);

    expect(String(b.note)).toMatch(/NOT launched/);
    expect(String(b.note)).not.toMatch(/requiredAncestorSha/);
  });

  it('EI-214151 begins successor reconciliation before reading the queue-selected candidate', async () => {
    const order: string[] = [];
    qualificationMocks.begin.mockImplementationOnce(async (_target: unknown, input: Record<string, unknown>) => {
      order.push('begin-successor');
      return {
        status: 'updated',
        transaction: qualificationTransaction(input),
        repairQueueReconciliation: {
          status: 'retired',
          reason: 'exact-safe-unstarted',
          predecessorAttemptId: 'attempt-old',
          successorAttemptId: String(input.attemptId),
          candidate: QUEUE_HEAD,
        },
      };
    });
    vi.doMock('../../release/checkpoint-required-ancestor', async (orig) => ({
      ...(await orig()),
      assessFrozenRepairQueuePreflight: vi.fn(async () => {
        order.push('read-queue-policy');
        return {
          proceed: true,
          reason: 'clear' as const,
          candidate: CURRENT,
          candidateSource: 'current-quiet-cut' as const,
          repairQueue: null,
          frozenLineageIdentity: null,
          queueDecision: 'run-normal-gate' as const,
          nextAttempt: null,
          fixerSpawnId: null,
          fixerAlive: null,
        };
      }),
    }));
    const launchSpy = vi.fn(async () => ({
      launched: true,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/x.log',
      willJudge: {
        candidate: CURRENT,
        tip: CURRENT,
        quietCutApplied: false,
        quietCutSec: 240,
        excludedCommits: [],
        excludedPaths: [],
        excludedEligibility: [],
        soonestEligibleInSec: null,
      },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      assessPreLaunchExclusion: vi.fn(async () => ({
        ...(await PRELAUNCH_OPEN()),
        candidate: CURRENT,
        tip: CURRENT,
      })),
      checkpointCandidateContainment: NO_CONTAINMENT,
      launchDetachedCheckpoint: launchSpy,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const result = parse((await tool.handler({}, MAKE_CTX())) as never);

    expect(order).toEqual([
      'begin-successor',
      'read-queue-policy',
      // FC-GUARD-P004-LAUNCH: selection first, then a second live read after the
      // physical-runner reservation and immediately before spawn.
      'read-queue-policy',
    ]);
    expect(qualificationMocks.begin).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ candidate: CURRENT }),
      { reconcileTerminalRepairQueueForSuccessor: true },
    );
    expect(launchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ candidate: CURRENT, candidateSource: 'current-quiet-cut' }),
    );
    expect(result).toMatchObject({
      ok: true,
      willJudge: { candidate: CURRENT, candidateSource: 'current-quiet-cut' },
    });
  });

  it('EI-21137440735672596: refuses an ordinary launch when the queue would dispatch a fixer', async () => {
    mockQueue({
      ...awaitingFixerQueue({ attempts: 2, fixerSpawnId: null }),
      repairHead: QUEUE_HEAD,
    });
    const launchSpy = vi.fn(async () => ({ launched: true, unit: 'must-not-launch', argv: [], logPath: '/tmp/x' }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      assessPreLaunchExclusion: PRELAUNCH_OPEN,
      checkpointCandidateContainment: NO_CONTAINMENT,
      launchDetachedCheckpoint: launchSpy,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ force: true }, MAKE_CTX())) as never);

    expect(launchSpy).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: false,
      launched: false,
      reason: 'repair-in-progress',
      candidate: QUEUE_HEAD,
      repair_candidate: QUEUE_HEAD,
      queue_decision: 'dispatch-fixer',
      fixer_spawn_id: null,
      fixer_alive: null,
      next_attempt: 3,
      repair_queue: { phase: 'awaiting-fixer', attempts: 2, repairHead: QUEUE_HEAD },
    });
    expect(String(b.note)).toMatch(/without running a suite/);
    expect(String(b.note)).toMatch(/force:true does not bypass/);
  });

  it('allows ordinary launch to invoke detached dead-fixer recovery at the frozen repair head', async () => {
    mockQueue(awaitingFixerQueue(), false);
    const launchSpy = vi.fn(async () => ({
      launched: true,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/x.log',
      willJudge: {
        candidate: CURRENT,
        tip: CURRENT,
        quietCutApplied: false,
        quietCutSec: 240,
        excludedCommits: [],
        excludedPaths: [],
        excludedEligibility: [],
        soonestEligibleInSec: null,
      },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      assessPreLaunchExclusion: PRELAUNCH_OPEN,
      checkpointCandidateContainment: NO_CONTAINMENT,
      launchDetachedCheckpoint: launchSpy,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({}, MAKE_CTX())) as never);

    expect(launchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: QUEUE_HEAD,
        candidateSource: 'frozen-repair-queue',
        logicalAttemptId: expect.any(String),
      }),
    );
    expect(b).toMatchObject({
      ok: true,
      willJudge: {
        candidate: QUEUE_HEAD,
        candidateSource: 'frozen-repair-queue',
      },
      candidateBinding: {
        status: 'exact-transported',
        transportedCandidate: QUEUE_HEAD,
        actualCandidate: QUEUE_HEAD,
      },
    });
  });

  it('EI-211596: preserves the ordinary frozen-repair source on the transported receipt', async () => {
    vi.doMock('../../release/checkpoint-required-ancestor', async (orig) => ({
      ...(await orig()),
      assessFrozenRepairQueuePreflight: vi.fn(async () => ({
        proceed: true,
        reason: 'clear' as const,
        candidate: QUEUE_HEAD,
        candidateSource: 'frozen-repair-queue' as const,
        repairQueue: {
          candidate: QUEUE_CANDIDATE,
          repairHead: QUEUE_HEAD,
          updatedAtMs: QUEUE_REVISION,
          phase: 'ready-to-verify',
        },
        frozenLineageIdentity: {
          candidate: QUEUE_CANDIDATE,
          repairHead: QUEUE_HEAD,
          queueRevision: QUEUE_REVISION,
        },
        queueDecision: 'verify-repair' as const,
        nextAttempt: null,
        fixerSpawnId: null,
        fixerAlive: false,
      })),
    }));
    const launchSpy = vi.fn(async () => ({
      launched: true,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/x.log',
      willJudge: {
        candidate: CURRENT,
        tip: CURRENT,
        quietCutApplied: false,
        quietCutSec: 240,
        excludedCommits: [],
        excludedPaths: [],
        excludedEligibility: [],
        soonestEligibleInSec: null,
      },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      assessPreLaunchExclusion: PRELAUNCH_OPEN,
      checkpointCandidateContainment: NO_CONTAINMENT,
      launchDetachedCheckpoint: launchSpy,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({}, MAKE_CTX())) as never);

    expect(launchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: QUEUE_HEAD,
        candidateSource: 'frozen-repair-queue',
        logicalAttemptId: expect.any(String),
      }),
    );
    expect(b).toMatchObject({
      ok: true,
      willJudge: {
        candidate: QUEUE_HEAD,
        candidateSource: 'frozen-repair-queue',
      },
      candidateBinding: {
        status: 'exact-transported',
        transportedCandidate: QUEUE_HEAD,
        actualCandidate: QUEUE_HEAD,
        frozenLineageIdentity: {
          candidate: QUEUE_CANDIDATE,
          repairHead: QUEUE_HEAD,
          queueRevision: QUEUE_REVISION,
        },
        queueCas: 'repair-head-match',
      },
      frozenLineageIdentity: {
        candidate: QUEUE_CANDIDATE,
        repairHead: QUEUE_HEAD,
        queueRevision: QUEUE_REVISION,
      },
    });
  });

  it.each([
    ['candidate', { candidate: 'd'.repeat(40) }],
    ['repairHead', { repairHead: 'e'.repeat(40) }],
    ['queueRevision', { queueRevision: QUEUE_REVISION + 1 }],
  ] as const)(
    'FC-GUARD-P004-LAUNCH: refuses before spawn when the second queue read changes %s',
    async (field, change) => {
      const expectedIdentity = {
        candidate: QUEUE_CANDIDATE,
        repairHead: QUEUE_HEAD,
        queueRevision: QUEUE_REVISION,
      };
      const liveIdentity = { ...expectedIdentity, ...change };
      const queueReads = vi.fn()
        .mockResolvedValueOnce({
          proceed: true,
          reason: 'clear' as const,
          candidate: QUEUE_HEAD,
          candidateSource: 'frozen-repair-queue' as const,
          repairQueue: {
            candidate: expectedIdentity.candidate,
            repairHead: expectedIdentity.repairHead,
            updatedAtMs: expectedIdentity.queueRevision,
            phase: 'ready-to-verify',
          },
          frozenLineageIdentity: expectedIdentity,
          queueDecision: 'verify-repair' as const,
          nextAttempt: null,
          fixerSpawnId: null,
          fixerAlive: false,
        })
        .mockResolvedValueOnce({
          proceed: true,
          reason: 'clear' as const,
          candidate: liveIdentity.repairHead,
          candidateSource: 'frozen-repair-queue' as const,
          repairQueue: {
            candidate: liveIdentity.candidate,
            repairHead: liveIdentity.repairHead,
            updatedAtMs: liveIdentity.queueRevision,
            phase: 'ready-to-verify',
          },
          frozenLineageIdentity: liveIdentity,
          queueDecision: 'verify-repair' as const,
          nextAttempt: null,
          fixerSpawnId: null,
          fixerAlive: false,
        });
      vi.doMock('../../release/checkpoint-required-ancestor', async (orig) => ({
        ...(await orig()),
        assessFrozenRepairQueuePreflight: queueReads,
      }));
      const launchSpy = vi.fn();
      vi.doMock('../../release-checkpoint-launch', async (orig) => ({
        ...(await orig()),
        assessPreLaunchExclusion: PRELAUNCH_OPEN,
        checkpointCandidateContainment: NO_CONTAINMENT,
        launchDetachedCheckpoint: launchSpy,
      }));

      const { default: tool } = await import('./checkpoint-run');
      const b = parse((await tool.handler({}, MAKE_CTX())) as never);

      expect(queueReads).toHaveBeenCalledTimes(2);
      expect(launchSpy).not.toHaveBeenCalled();
      expect(b).toMatchObject({
        ok: false,
        launched: false,
        reason: 'frozen_lineage_identity_changed',
        error: 'frozen_candidate_lineage_violation',
        selection_source: 'live-repair-head',
        expectedIdentity,
        liveIdentity,
        checkoutHead: QUEUE_HEAD,
        mismatchedIdentityFields: [field],
        sanctionedRoute: expect.stringContaining("release:repair-queue { op:'admit'"),
      });
      expect(String(b.note)).toContain(`candidate=${liveIdentity.candidate}`);
      expect(String(b.note)).toContain(`repairHead=${liveIdentity.repairHead}`);
      expect(String(b.note)).toContain(`queueRevision=${liveIdentity.queueRevision}`);
    },
  );

  it('fails closed with the live fixer identity when the queue is waiting for a fixer', async () => {
    mockQueue(awaitingFixerQueue({ fixerSpawnId: 's-live' }), true);
    const launchSpy = vi.fn();
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      assessPreLaunchExclusion: PRELAUNCH_OPEN,
      checkpointCandidateContainment: NO_CONTAINMENT,
      launchDetachedCheckpoint: launchSpy,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({}, MAKE_CTX())) as never);

    expect(launchSpy).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: false,
      launched: false,
      reason: 'repair-in-progress',
      repair_candidate: QUEUE_HEAD,
      queue_decision: 'wait-for-fixer',
      fixer_spawn_id: 's-live',
      fixer_alive: true,
      repair_queue: { fixerSpawnId: 's-live', repairHead: QUEUE_HEAD },
    });
  });

  // P-007 / D-004: this case USED to assert a fall back to a current quiet-cut when the
  // repair patch was not observable on canonical staging. That fallback was deliberately
  // removed (see resolveRunnableCandidate's `verify-repair` branch): falling back to a cut
  // at the moving tip inverted the freeze precisely on a lineage that is deliberately not
  // yet folded into staging. A repair head is judged AT ITS OWN SHA, and P-008 folds a
  // PROMOTED lineage back into staging afterwards. The scenario is still pinned here — only
  // the expected candidate moved, from the quiet cut to the frozen repair head.
  it('judges a ready repair head at its OWN sha even when its patch is not observable on staging (P-007/D-004)', async () => {
    mockQueue({
      phase: 'ready-to-verify',
      candidate: 'ed20de6dcb05c0c780437990f7f1070c3a92c853',
      repairHead: QUEUE_HEAD,
      fixerSpawnId: null,
    });
    const launchSpy = vi.fn(async () => ({ launched: true, unit: 'should-not-launch', argv: [], logPath: '/tmp/x' }));
    const ancestrySpy = vi.fn(() => ({
      ok: false,
      reason: 'not-ancestor' as const,
      requiredAncestor: REQUIRED,
      candidate: QUEUE_HEAD,
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      assessPreLaunchExclusion: PRELAUNCH_OPEN,
      currentCheckpointCandidate: vi.fn(() => ({
        current_head: CURRENT,
        current_candidate: CURRENT,
        quiet_cut_sec: 240,
      })),
      checkpointCandidateContainsAncestor: ancestrySpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
      launchDetachedCheckpoint: launchSpy,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ requiredAncestorSha: REQUIRED, force: true }, MAKE_CTX())) as never);

    expect(launchSpy).not.toHaveBeenCalled();
    expect(ancestrySpy).toHaveBeenCalledWith(expect.any(String), REQUIRED, QUEUE_HEAD, expect.any(Function));
    expect(b).toMatchObject({
      ok: false,
      launched: false,
      reason: 'required_ancestor_missing',
      required_ancestor: REQUIRED,
      candidate: QUEUE_HEAD,
      candidate_source: 'frozen-repair-queue',
      repair_queue: { phase: 'ready-to-verify', repairHead: QUEUE_HEAD },
    });
    expect(String(b.note)).toMatch(/NOT launched/);
    // The note no longer advertises a quiet-cut candidate on this path (P-007/D-004);
    // assert the frozen-lineage wording instead so the note stays pinned to the contract.
    expect(String(b.note)).not.toMatch(/fresh current-quiet-cut candidate/i);
  });

  it('attempts=3 + owner gone recovers the dead fixer before reapplying exhaustion and refuses without checking a fresh tip', async () => {
    mockQueue(awaitingFixerQueue(), false);
    const launchSpy = vi.fn(async () => ({
      launched: true,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/x.log',
      willJudge: {
        candidate: CURRENT,
        tip: CURRENT,
        quietCutApplied: false,
        quietCutSec: 240,
        excludedCommits: [],
        excludedPaths: [],
        excludedEligibility: [],
        soonestEligibleInSec: null,
      },
    }));
    const ancestrySpy = vi.fn((_root: string, _required: string, candidate: string) => ({
      ok: candidate === CURRENT,
      reason: candidate === CURRENT ? ('contained' as const) : ('not-ancestor' as const),
      requiredAncestor: REQUIRED,
      candidate,
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      assessPreLaunchExclusion: vi.fn(async () => ({ ...(await PRELAUNCH_OPEN()), candidate: CURRENT })),
      currentCheckpointCandidate: vi.fn(() => ({
        current_head: CURRENT,
        current_candidate: CURRENT,
        quiet_cut_sec: 240,
      })),
      checkpointCandidateContainsAncestor: ancestrySpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
      launchDetachedCheckpoint: launchSpy,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ requiredAncestorSha: REQUIRED }, MAKE_CTX())) as never);

    expect(ancestrySpy).not.toHaveBeenCalled();
    expect(launchSpy).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: false,
      launched: false,
      reason: 'required_ancestor_unverifiable',
      required_ancestor: REQUIRED,
      candidate: null,
      candidate_source: 'unresolved',
      queue_decision: 'recover-dead-fixer',
      fixer_alive: false,
      repair_queue: {
        candidate: 'ed20de6dcb05c0c780437990f7f1070c3a92c853',
        repairHead: QUEUE_HEAD,
        attempts: 3,
      },
    });
    expect(String(b.note)).toMatch(/queue-not-runnable/);
    expect(String(b.note)).toMatch(/recover-dead-fixer/);
  });

  it('attempts=3 + liveness unknown preserves wait-for-fixer and fails closed without ancestry check or spawn', async () => {
    mockQueue(awaitingFixerQueue({ fixerSpawnId: 's-liveness-unknown' }), null);
    const launchSpy = vi.fn();
    const ancestrySpy = vi.fn();
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      assessPreLaunchExclusion: vi.fn(async () => ({ ...(await PRELAUNCH_OPEN()), candidate: CURRENT })),
      currentCheckpointCandidate: vi.fn(() => ({
        current_head: CURRENT,
        current_candidate: CURRENT,
        quiet_cut_sec: 240,
      })),
      checkpointCandidateContainsAncestor: ancestrySpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
      launchDetachedCheckpoint: launchSpy,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ requiredAncestorSha: REQUIRED }, MAKE_CTX())) as never);

    expect(ancestrySpy).not.toHaveBeenCalled();
    expect(launchSpy).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: false,
      launched: false,
      reason: 'required_ancestor_unverifiable',
      candidate: null,
      candidate_source: 'unresolved',
      queue_decision: 'wait-for-fixer',
      fixer_alive: null,
      repair_queue: {
        phase: 'awaiting-fixer',
        attempts: 3,
        fixerSpawnId: 's-liveness-unknown',
      },
    });
    expect(String(b.note)).toMatch(/queue-not-runnable/);
    expect(String(b.note)).toMatch(/wait-for-fixer/);
  });

  it('fails closed without spawning when the persisted queue cannot be read', async () => {
    mockQueue('throws');
    const launchSpy = vi.fn();
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      assessPreLaunchExclusion: PRELAUNCH_OPEN,
      currentCheckpointCandidate: vi.fn(() => ({
        current_head: CURRENT,
        current_candidate: CURRENT,
        quiet_cut_sec: 240,
      })),
      checkpointCandidateContainsAncestor: vi.fn(),
      checkpointCandidateContainment: NO_CONTAINMENT,
      launchDetachedCheckpoint: launchSpy,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ requiredAncestorSha: REQUIRED }, MAKE_CTX())) as never);

    expect(launchSpy).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: false,
      launched: false,
      reason: 'required_ancestor_unverifiable',
      candidate_source: 'unresolved',
    });
    expect(String(b.note)).toMatch(/UNKNOWN refuses/);
  });

  it('passes the queue-aware guard and transports the exact binding into the detached CLI', async () => {
    mockQueue(null);
    const launchSpy = vi.fn(async () => ({
      launched: true,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/x.log',
      willJudge: {
        candidate: 'older-prediction',
        tip: CURRENT,
        quietCutApplied: false,
        quietCutSec: 240,
        excludedCommits: [],
        excludedPaths: [],
        excludedEligibility: [],
        soonestEligibleInSec: null,
      },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      assessPreLaunchExclusion: PRELAUNCH_OPEN,
      currentCheckpointCandidate: vi.fn(() => ({
        current_head: CURRENT,
        current_candidate: CURRENT,
        quiet_cut_sec: 240,
      })),
      checkpointCandidateContainsAncestor: vi.fn(() => ({
        ok: true,
        reason: 'contained' as const,
        requiredAncestor: REQUIRED,
        candidate: CURRENT,
      })),
      checkpointCandidateContainment: vi.fn(async () => ({
        candidateSha: CURRENT,
        tipSha: CURRENT,
        source: 'caller-supplied' as const,
        included: ['packages/operator-core/lib/mine.ts'],
        missing: [],
        unknown: [],
        paths: [],
        excludedCommitsTouchingYourFiles: [],
        testImplSplitRisk: { detected: false, includedTests: [], missingImpl: [] },
        warning: null,
      })),
      launchDetachedCheckpoint: launchSpy,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse(
      (await tool.handler(
        {
          requiredAncestorSha: REQUIRED,
          paths: ['packages/operator-core/lib/mine.ts'],
        },
        MAKE_CTX(),
      )) as never,
    );

    expect(launchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: CURRENT,
        candidateSource: 'current-quiet-cut',
        logicalAttemptId: expect.any(String),
      }),
    );
    expect(b).toMatchObject({
      ok: true,
      candidateBinding: {
        status: 'exact-transported',
        transportedCandidate: CURRENT,
        actualCandidate: CURRENT,
      },
      requiredAncestor: {
        requiredSha: REQUIRED,
        candidate: CURRENT,
        candidateSource: 'current-quiet-cut',
        containedAtPreflight: true,
      },
      callerEditsInCandidate: {
        candidateSha: CURRENT,
        candidateReliability: 'exact-transported',
        verifiedAgainstActualWriter: true,
      },
    });
    expect(String(b.note)).toMatch(/CANDIDATE BINDING EXACT/);
  });
});

describe('WI-41490: request-side launch never applies ambient migrations', () => {
  const SOURCE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), './checkpoint-run.ts');

  it('leaves candidate-exact migration application to the detached checkpoint runner', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    expect(source).not.toContain('applyPendingMigrationsNow');
    expect(source).not.toContain("from '../../db-boot-migrate'");
  });
});

// EI-18773280958875269: a doc/prompt that quotes this tool's emitted wording has NO
// drift guard of its own — release-fixer.md told agents to look for a
// `⚠ quiet-cut EXCLUDED` banner this file stopped emitting (EI-18759622667757826 reworded
// it to `⚠ PREDICTED exclusion: …` / `⚠ PREDICTION ONLY — …`). A stale quote reads as
// "nothing was excluded" to a release-fixer agent following the prompt literally, on the
// release-gate path. This is the POSITIVE-assertion counterpart of the vacuous-negative
// lint's own motivating case (scripts/check-vacuous-negative-assertions.mjs) — pin the
// prompt's quoted banner prefixes against the literals this file actually builds them
// from, so rewording one without the other fails loudly instead of drifting silently.
describe('release-fixer.md prompt banners stay in sync with this file', () => {
  const PROMPT_PATH = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../libs/papercusp/packages/harness/blueprints/base/prompts/release-fixer.md',
  );
  const BLUEPRINT_PATH = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../libs/papercusp/packages/harness/blueprints/release-fix/blueprint.yaml',
  );

  it('declares every catalog tool required by the release-fixer prompt', () => {
    const prompt = readFileSync(PROMPT_PATH, 'utf8');
    const blueprint = parseYaml(readFileSync(BLUEPRINT_PATH, 'utf8')) as {
      dependencies?: { tools?: unknown };
    };
    const requiredTools = [
      'checkpoint:await',
      'coord:escalate',
      'plans:get',
      'release:checkpoint-run',
      'release:trace',
      'sessions:search',
      'work_items:list',
    ];
    const declaredTools = new Set((blueprint.dependencies?.tools as string[] | undefined) ?? []);

    for (const tool of requiredTools) {
      expect(prompt, `release-fixer prompt must reference ${tool}`).toContain(`\`${tool}\``);
      expect(declaredTools, `release-fix blueprint must declare ${tool}`).toContain(tool);
    }
  });

  it('quotes the current PREDICTED-exclusion banner prefixes, not a retired one', () => {
    const prompt = readFileSync(PROMPT_PATH, 'utf8');
    // The two live prefixes checkpoint-run.ts builds the warning from (see the
    // ` ⚠ PREDICTION ONLY — …` / ` ⚠ PREDICTED exclusion: …` template literals above).
    expect(prompt).toContain('⚠ PREDICTED exclusion:');
    expect(prompt).toContain('⚠ PREDICTION ONLY — and this one is probably PESSIMISTIC');
    // The retired banner this class was filed over must not have crept back in — a
    // literal reappearance here means someone quoted the OLD wording again.
    expect(prompt).not.toMatch(/⚠ quiet-cut EXCLUDED/);
  });

  it('requires the release-fixer to use an exact run-bound log, never global mtime selection', () => {
    const prompt = readFileSync(PROMPT_PATH, 'utf8');

    // EI-218328: concurrent harness checkpoint runs share the log directory. The old
    // "newest log" instruction could hand a fixer another harness's failure, even though
    // the dispatch already knew the producing run's candidate, runId, and logPath.
    expect(prompt).toMatch(/exact `logPath` supplied in the\s+release-fixer context/);
    expect(prompt).toMatch(/supplied `runId`, candidate SHA, and integration\s+root/);
    expect(prompt).toMatch(/Never choose a log by\s+global mtime or by "newest" alone/);
    expect(prompt).not.toContain('Read the newest `~/.papercusp/checkpoint-logs/*.log`');
  });
});

// WI-38356 follow-on, measured live 2026-08-13T02:17Z: `replaceStale`'s own ARG DESCRIPTION
// hardcoded "≥20 min old" while the enforced floor (REPLACE_STALE_MIN_AGE_SEC) had moved to
// 120 min — off by 6×. The refusal note already derived the number from the constant, so only
// the half an agent reads BEFORE calling was wrong; I fired replaceStale on a 21-minute run on
// the strength of it and got refused as `young`. Same class as the prompt-banner guard above,
// one layer in: a hand-typed number in guidance that no test pinned to the value it describes.
// WI-6554700010042457: the floor is now SILENCE (REPLACE_STALE_MIN_SILENCE_SEC), DERIVED from the
// run's own idle budget rather than written as `<N> * 60`, so the guard reads the real value.
describe('replaceStale guidance stays in sync with the enforced silence floor', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SOURCE_PATH = resolve(HERE, './checkpoint-run.ts');
  const LAUNCH_PATH = resolve(HERE, '../../release-checkpoint-launch.ts');

  /** importActual, not import: this file vi.doMocks `release-checkpoint-launch` in most of its
   *  tests, and the guard must read the value the launcher actually enforces. */
  const enforcedFloorMin = async (): Promise<number> => {
    const actual = await vi.importActual<typeof import('../../release-checkpoint-launch')>(
      '../../release-checkpoint-launch',
    );
    return Math.round(actual.REPLACE_STALE_MIN_SILENCE_SEC / 60);
  };

  it('states the ENFORCED floor, derived from the constant rather than hand-typed', async () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    const enforcedMin = await enforcedFloorMin();
    // The description must DERIVE the figure. Asserting on the rendered schema instead would
    // pass just as happily against a hardcoded literal that currently agrees by luck, which is
    // exactly the state this guard exists to reject.
    expect(source).toMatch(/≥\$\{Math\.round\(REPLACE_STALE_MIN_SILENCE_SEC \/ 60\)\} min/);
    // And no stale hand-typed minute-figure may sit in a `≥N min` position anywhere in this
    // file: every such claim about the floor has to come from the constant.
    for (const m of source.matchAll(/≥(\d+) min/g)) {
      expect(Number(m[1])).toBe(enforcedMin);
    }
    // The launcher derives the floor from the idle budget — no literal to drift.
    expect(readFileSync(LAUNCH_PATH, 'utf8')).toMatch(
      /REPLACE_STALE_MIN_SILENCE_SEC\s*=\s*Math\.ceil\(MANUAL_CHECKPOINT_WATCHDOG_MS \/ 1000\)/,
    );
  });

  it('CONTROL: the pre-fix literal would be caught — the guard is not vacuous', async () => {
    // The exact string this file carried until 2026-08-13 02:17Z. Held here permanently rather
    // than mutated into the shared tree (module-level subject, per the falsifiability discipline).
    const preFix = 'reply) AND ≥20 min old (EI-11667: a YOUNG stale run is normal';
    expect([...preFix.matchAll(/≥(\d+) min/g)].map((m) => Number(m[1]))).toEqual([20]);
    // 20 is not the enforced floor, so the loop above genuinely fails on the old text.
    expect(20).not.toBe(await enforcedFloorMin());
  });
});

/**
 * state-plane-adoption-2026-08-02 P-002 / D-001. This verb's `candidate` is the most
 * drift-prone value in the repo — a run re-candidates onto tip mid-flight — so a reply
 * that means "a verdict is coming" must point at the plane for a RE-READ rather than
 * leaving the caller to transcribe the field.
 */
describe('release:checkpoint-run routes to the state plane (P-002)', () => {
  // Same per-test dynamic import every other test here uses (vi.resetModules/doMock).
  const load = async () => {
    const { default: tool } = await import('./checkpoint-run');
    const { resolveSeeAlso } = await import('@papercusp/agent-mcp');
    const ptrs = (text: string, ctx: unknown = { harnessSlug: 'papercusp', role: 'su' }) =>
      resolveSeeAlso(tool.guidance?.seeAlso, { content: [{ type: 'text' as const, text }] } as never, {}, ctx);
    const cells = (text: string) =>
      ptrs(text)
        .filter((p) => p.tool.startsWith('state:'))
        .map((p) => `${p.tool} ${p.selector ?? ''}`);
    return { ptrs, cells };
  };

  it('points at the candidate cell + the verdict subscription when a run is already in flight', async () => {
    const { cells } = await load();
    const p = cells(JSON.stringify({ ok: false, already_running: true, candidate: 'abc123' }));
    expect(p.some((s) => s.startsWith('state:read') && s.includes('gate.greenCheckpoint.candidate'))).toBe(true);
    expect(p.some((s) => s.startsWith('state:subscribe') && s.includes('gate.greenCheckpoint.verdict'))).toBe(true);
  });

  it('does the same when THIS call launched the run', async () => {
    const { cells } = await load();
    expect(cells(JSON.stringify({ ok: true, launched: true }))).toHaveLength(2);
  });

  /** No verdict coming ⇒ no re-read advice; the pointer must not become unconditional noise. */
  it('stays silent when nothing was launched and nothing is running', async () => {
    const { cells } = await load();
    expect(cells(JSON.stringify({ ok: false, launched: false, reason: 'migrations-pending' }))).toHaveLength(0);
  });

  /** The silent-no-op trap: a JSON-only gate never fires on a TOON-rendered envelope. */
  it('still fires when the envelope is TOON, not JSON', async () => {
    const { cells } = await load();
    expect(cells('already_running: true\ncandidate: abc123')).toHaveLength(2);
  });

  it('keeps the pre-existing deploy/config pointers', async () => {
    const { ptrs } = await load();
    const tools = ptrs(JSON.stringify({ launched: true })).map((x) => x.tool);
    for (const name of ['release:deploy', 'release:checkpoint-config']) {
      expect(tools.some((t) => t.startsWith(name))).toBe(true);
    }
  });

  it('routes a live condition_claimed refusal to current status, the exact work item, and its holder', async () => {
    const { ptrs } = await load();
    const p = ptrs(
      JSON.stringify({
        ok: false,
        launched: false,
        reason: 'condition_claimed',
        work_item: 'WI-38026',
        taken_by: 'su-live-holder',
      }),
    );

    expect(p.some((x) => x.tool === 'release:deploy' && x.selector?.includes("op: 'status'"))).toBe(true);
    expect(p.some((x) => x.tool === 'state:read' && x.selector?.includes('gate.greenCheckpoint.ownership'))).toBe(true);
    expect(p.find((x) => x.tool === 'work_items:get')?.selector).toBe("{ id: 'WI-38026' }");
    const handoff = p.find((x) => x.tool === 'coord:send');
    expect(handoff?.selector).toContain("to: ['su-live-holder']");
    expect(handoff?.selector).toContain("expects: 'answer'");
    expect(handoff?.selector).toContain("wake: 'required'");
  });

  it('keeps the direct holder pointer when the condition_claimed refusal is TOON-rendered', async () => {
    const { ptrs } = await load();
    const p = ptrs(
      'ok: false\nlaunched: false\nreason: condition_claimed_liveness_confirmed\nwork_item: WI-38026\ntaken_by: su-ambiguous-holder',
    );
    expect(p.find((x) => x.tool === 'work_items:get')?.selector).toBe("{ id: 'WI-38026' }");
    expect(p.find((x) => x.tool === 'coord:send')?.selector).toContain("to: ['su-ambiguous-holder']");
  });

  it('does not invent a direct selector when a claimed refusal omits its identifiers', async () => {
    const { ptrs } = await load();
    const p = ptrs(JSON.stringify({ ok: false, launched: false, reason: 'condition_claimed' }));
    expect(p.some((x) => x.tool === 'work_items:get' || x.tool === 'coord:send')).toBe(false);
  });

  it('does not emit harness-scoped cell handles to an unscoped caller', async () => {
    const { ptrs } = await load();
    const contexts = [{}, { harnessSlug: '*' }, { harnessSlug: 'all', role: 'su' }, { harnessSlug: 'other-harness' }];

    for (const ctx of contexts) {
      const launched = ptrs(JSON.stringify({ ok: true, launched: true }), ctx);
      expect(launched.filter((x) => x.tool.startsWith('state:'))).toEqual([]);

      const claimed = ptrs(
        JSON.stringify({ ok: false, launched: false, reason: 'condition_claimed', work_item: 'WI-38026' }),
        ctx,
      );
      expect(claimed.filter((x) => x.tool.startsWith('state:'))).toEqual([]);
      expect(claimed.some((x) => x.tool === 'release:deploy')).toBe(true);
    }
  });
});

/**
 * EI-20025784115349280 — the gate must be proved by the SPAWN, not by the reply.
 *
 * A tool that returns a refusal payload while still creating the systemd unit has fixed
 * nothing: the ~55min suite is running either way, and the caller is merely better informed
 * about a slot it can no longer get back. So the load-bearing assertion in every case below
 * is whether `launchDetachedCheckpoint` — the only path to a unit — was called at all.
 */
describe('pre-launch exclusion gate: the spawn, not the reply (EI-20025784115349280)', () => {
  const MINE = 'packages/operator-core/lib/mine.ts';
  const LAUNCHED_OK = {
    launched: true,
    unit: 'papercup-green-checkpoint-manual',
    argv: [],
    logPath: '/tmp/papercup-green-checkpoint-manual.log',
  };
  const REFUSAL = {
    refuse: true,
    proceedReason: null,
    candidate: 'aaaaaaaaaaaa',
    tip: 'ffffffffffff',
    quietCutSec: 240,
    blockedPaths: [{ path: MINE, commits: ['bbb1111 my just-landed fix'], eligibleInSec: 120 }],
    waitSec: 120,
  };

  const mockLaunch = (over: Record<string, unknown> = {}) => {
    const launchSpy = vi.fn(async () => LAUNCHED_OK);
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
      ...over,
    }));
    return launchSpy;
  };

  it('creates NO systemd unit when the run would exclude the declared paths', async () => {
    const launchSpy = mockLaunch({ assessPreLaunchExclusion: vi.fn(async () => REFUSAL) });
    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ paths: [MINE] }, MAKE_CTX())) as never);

    // THE assertion this whole change exists for: the gate slot was never taken.
    expect(launchSpy).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: false,
      launched: false,
      reason: 'would_exclude_declared_paths',
      wait_sec: 120,
      blocked_paths: [{ path: MINE, eligibleInSec: 120 }],
    });
    // A refusal without a stated way forward gets routed around rather than followed.
    expect(String(b.note)).toMatch(/waitForEligibility:true/);
    expect(String(b.note)).toMatch(/force:true/);
  });

  it('CONTROL: launches normally when the gate does not fire', async () => {
    const launchSpy = mockLaunch({
      assessPreLaunchExclusion: vi.fn(async () => ({
        ...REFUSAL,
        refuse: false,
        proceedReason: 'declared-paths-in-candidate',
      })),
    });
    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ paths: [MINE] }, MAKE_CTX())) as never);
    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(qualificationMocks.reserve).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        attemptId: expect.any(String),
        runnerId: expect.any(String),
        candidate: 'aaaaaaaaaaaa',
      }),
    );
    const reservedRunnerId = (qualificationMocks.reserve.mock.calls[0]?.[1] as { runnerId: string }).runnerId;
    expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({
      logicalAttemptId: expect.any(String),
      gateFireId: reservedRunnerId,
    }));
    expect(b.ok).toBe(true);
    expect(b.logical_attempt_id).toEqual(expect.any(String));
  });

  it('uses the store-derived repair attempt id for eligibility and the physical runner', async () => {
    const storeAttemptId = 'repair-target-attempt';
    const launchSpy = mockLaunch({ assessPreLaunchExclusion: PRELAUNCH_OPEN });
    qualificationMocks.begin.mockImplementation(async (_target: unknown, input: Record<string, unknown>) => ({
      status: 'updated',
      transaction: qualificationTransaction({ ...input, attemptId: storeAttemptId }),
    }));
    qualificationMocks.eligibility.mockImplementation(async (_target: unknown, input: Record<string, unknown>) => {
      const snapshot = input.snapshot as { attemptId: string };
      return {
        status: input.attemptId === storeAttemptId && snapshot.attemptId === storeAttemptId
          ? 'updated' : 'conflict',
        transaction: qualificationTransaction({ attemptId: storeAttemptId }),
      };
    });
    const { default: tool } = await import('./checkpoint-run');
    const result = parse((await tool.handler({ paths: [MINE] }, MAKE_CTX())) as never);

    expect(result).toMatchObject({ ok: true, logical_attempt_id: storeAttemptId });
    expect(qualificationMocks.eligibility).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        attemptId: storeAttemptId,
        snapshot: expect.objectContaining({ attemptId: storeAttemptId }),
      }),
    );
    expect(qualificationMocks.reserve).toHaveBeenCalledWith(
      expect.any(Object), expect.objectContaining({ attemptId: storeAttemptId }),
    );
    expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({ logicalAttemptId: storeAttemptId }));
  });

  it('force:true bypasses candidate preflight and launches when no peer owns the condition', async () => {
    // Deliberately NOT mocking the assessor: under `force` the real one short-circuits before
    // it touches git or systemd, so this exercises the actual wiring rather than a stand-in.
    const launchSpy = mockLaunch();
    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ paths: [MINE], force: true }, MAKE_CTX())) as never);
    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(b.ok).toBe(true);
    expect(b.reason).toBeUndefined();
  });

  it('force:true cannot launch over a live peer gate claim', async () => {
    const launchSpy = mockLaunch();
    vi.doMock('../../coord/gate-ownership', () => ({
      readGateOwnership: vi.fn(async () => ({
        claimState: 'held', workItem: 'WI-38026', takenBy: 'su-live-holder',
        holderSessionState: 'live', assessment: 'held-live', unknown: null,
      })),
      shouldStandDownForLivePeer: vi.fn(() => true),
      ownershipNeedsLivenessConfirmation: vi.fn(() => false),
      ownershipContradicted: vi.fn(() => false),
    }));
    vi.doMock('../coordination/identity', () => ({
      resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-caller', workspaceId: 'papercusp-workspace' })),
    }));
    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ force: true }, MAKE_CTX())) as never);
    expect(launchSpy).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: false, launched: false, reason: 'condition_claimed_even_with_force',
      work_item: 'WI-38026', taken_by: 'su-live-holder',
    });
  });

  it('EI-20208253097914491: stamps a condition_claimed refusal before returning', async () => {
    const launchSpy = mockLaunch();
    const ownership = {
      eventKey: 'gate-red-streak:papercusp',
      workItem: 'WI-38026',
      claimState: 'held',
      unknown: null,
      takenBy: 'su-live-holder',
      takenAt: new Date().toISOString(),
      lastProgressAt: new Date().toISOString(),
      expiresAt: null,
      holderSessionState: 'live',
      duplicates: [],
      thread: { recent: [], total: 0 },
    };
    vi.doMock('../../coord/gate-ownership', () => ({
      readGateOwnership: vi.fn(async () => ownership),
      shouldStandDownForLivePeer: vi.fn(() => true),
      ownershipNeedsLivenessConfirmation: vi.fn(() => null),
      ownershipContradicted: vi.fn(() => false),
    }));

    const { default: tool } = await import('./checkpoint-run');
    const metadata = vi.fn();
    const ctx = {
      log: vi.fn(),
      signal: new AbortController().signal,
      progress: vi.fn(),
      role: 'operator',
      uiClientId: 'su-caller',
      metadata,
    } as never;
    const b = parse((await tool.handler({ reason: 'gate red' }, ctx)) as never);

    expect(launchSpy).not.toHaveBeenCalled();
    expect(b).toMatchObject({ ok: false, launched: false, reason: 'condition_claimed' });
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({
      standDown: 'condition_claimed',
      standDownWorkItem: 'WI-38026',
      standDownTakenBy: 'su-live-holder',
      standDownHolderSessionState: 'live',
      fireReason: 'gate red',
    }));
  });

  // EI-22733985246154315 — the test that stood here ("a delivered required wake confirms an
  // ambiguous holder and prevents launch") has been REMOVED, not ported, and must not come back.
  //
  // It mocked `wakeRecipients` returning a confirmed pickup to exercise a stand-down branch in
  // checkpoint-run. No producer in the tree can return that value: a wake fan returns once the
  // wake is ENQUEUED, before the target could take a turn, so every producer returns the literal
  // false. The branch was therefore unreachable in production while this test kept it green —
  // the mock was the only thing that could ever enter it. Both are now gone, and
  // `WakeRecipientsResult.pickupConfirmed` is typed `false` so the comparison cannot return.
  //
  // The scenario itself is NOT untested: the sibling below drives the same ownership fixture
  // through the path production actually takes (a queued-but-unconfirmed wake falling through to
  // the shared force guard). Standing down for a genuinely live holder is `shouldStandDownForLivePeer`,
  // which reads the liveness oracle instead of asking the wake to vouch for itself.
  // The invariant is pinned by lib/doc-claims/wake-pickup-unconfirmable.test.ts.

  it('EI-21869737720630609: queued wake without pickup confirmation stays unconfirmed', async () => {
    const launchSpy = mockLaunch();
    const ownership = {
      eventKey: 'gate-red-streak:papercusp',
      workItem: 'WI-38026',
      claimState: 'held',
      unknown: null,
      takenBy: 'su-ambiguous-holder',
      takenAt: new Date().toISOString(),
      lastProgressAt: new Date().toISOString(),
      expiresAt: null,
      holderSessionState: 'suspect',
      duplicates: [],
      thread: { recent: [], total: 0 },
    };
    vi.doMock('../../coord/gate-ownership', () => ({
      readGateOwnership: vi.fn(async () => ownership),
      shouldStandDownForLivePeer: vi.fn(() => false),
      ownershipNeedsLivenessConfirmation: vi.fn(() => true),
      ownershipContradicted: vi.fn(() => false),
    }));
    vi.doMock('../coordination/identity', () => ({
      resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-caller', workspaceId: 'papercusp-workspace' })),
    }));
    const wakeRecipients = vi.fn(async () => ({
      targets: ['su-ambiguous-holder'],
      keys: ['coord:inbox-wake:su-ambiguous-holder'],
      woken: 1,
      pickupConfirmed: false,
      staged: 0,
      stagedTargets: [],
      fanoutCapped: [],
    }));
    vi.doMock('../coordination/inbox-wake', () => ({ wakeRecipients }));
    const assessForceRelease = vi.fn(async () => ({
      allowed: false,
      holderLiveness: {},
    }));
    vi.doMock('../work_items/release-force-guard', async () => {
      const actual = await vi.importActual<typeof import('../work_items/release-force-guard')>(
        '../work_items/release-force-guard',
      );
      return { ...actual, assessForceRelease };
    });

    const { default: tool } = await import('./checkpoint-run');
    const metadata = vi.fn();
    const ctx = {
      log: vi.fn(),
      signal: new AbortController().signal,
      progress: vi.fn(),
      role: 'operator',
      uiClientId: 'su-caller',
      workspaceId: 'papercusp-workspace',
      metadata,
    } as never;
    const b = parse((await tool.handler({ reason: 'gate red' }, ctx)) as never);

    expect(wakeRecipients).toHaveBeenCalledTimes(1);
    expect(assessForceRelease).toHaveBeenCalledTimes(1);
    expect(launchSpy).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: false,
      launched: false,
      reason: 'condition_claimed_unconfirmed',
      wake_confirmed: false,
    });
    expect(b).not.toHaveProperty('woken');
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({
      standDown: 'condition_claimed_unconfirmed',
      standDownWorkItem: 'WI-38026',
      standDownTakenBy: 'su-ambiguous-holder',
      standDownHolderSessionState: 'suspect',
      standDownWakeCount: 1,
      fireReason: 'gate red',
    }));
  });

  it('P-008: a missed required wake transfers ownership and does not launch', async () => {
    const launchSpy = mockLaunch();
    const ownership = {
      eventKey: 'gate-red-streak:papercusp',
      workItem: 'WI-38026',
      claimState: 'held',
      unknown: null,
      takenBy: 'su-ambiguous-holder',
      takenAt: new Date().toISOString(),
      lastProgressAt: new Date().toISOString(),
      expiresAt: null,
      holderSessionState: 'draining',
      duplicates: [],
      thread: { recent: [], total: 0 },
    };
    vi.doMock('../../coord/gate-ownership', () => ({
      readGateOwnership: vi.fn(async () => ownership),
      shouldStandDownForLivePeer: vi.fn(() => false),
      ownershipNeedsLivenessConfirmation: vi.fn(() => true),
      ownershipContradicted: vi.fn(() => false),
    }));
    vi.doMock('../coordination/identity', () => ({
      resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-caller', workspaceId: 'papercusp-workspace' })),
    }));
    const wakeRecipients = vi.fn(async () => ({
      targets: ['su-ambiguous-holder'],
      keys: ['coord:inbox-wake:su-ambiguous-holder'],
      woken: 0,
      staged: 0,
      stagedTargets: [],
      fanoutCapped: [],
    }));
    vi.doMock('../coordination/inbox-wake', () => ({ wakeRecipients }));
    mockAutomaticTransferTarget('su-caller');
    const claimWorkItem = vi.fn(async () => ({ id: 'WI-38026', harness: 'papercusp' }));
    vi.doMock('../../work-items', async () => {
      const actual = await vi.importActual<typeof import('../../work-items')>('../../work-items');
      return { ...actual, claimWorkItem };
    });
    const assessForceRelease = vi.fn(async () => ({
      allowed: true,
      basis: 'holder-wake-missed' as const,
      holderLiveness: {},
    }));
    const recordForceTransitionAudit = vi.fn(async () => {});
    const notifyForceTransition = vi.fn(async () => {});
    vi.doMock('../work_items/release-force-guard', async () => {
      const actual = await vi.importActual<typeof import('../work_items/release-force-guard')>(
        '../work_items/release-force-guard',
      );
      return { ...actual, assessForceRelease, recordForceTransitionAudit, notifyForceTransition };
    });

    const { default: tool } = await import('./checkpoint-run');
    const metadata = vi.fn();
    const ctx = {
      log: vi.fn(),
      signal: new AbortController().signal,
      progress: vi.fn(),
      role: 'operator',
      uiClientId: 'su-caller',
      workspaceId: 'papercusp-workspace',
      metadata,
    } as never;
    const b = parse((await tool.handler({}, ctx)) as never);

    expect(wakeRecipients).toHaveBeenCalledTimes(1);
    expect(claimWorkItem).toHaveBeenCalledWith('WI-38026', 'su-caller', {
      harness: 'papercusp',
      expectedAssignee: 'su-ambiguous-holder',
    });
    expect(launchSpy).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: true,
      launched: false,
      scheduled: false,
      ownership_transferred: true,
      reason: 'condition_ownership_transferred',
      transfer_basis: 'holder-wake-missed',
    });
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({
      standDown: 'condition_ownership_transferred',
      standDownWorkItem: 'WI-38026',
      standDownTakenBy: 'su-ambiguous-holder',
      standDownTransferBasis: 'holder-wake-missed',
      standDownWakeCount: 0,
    }));
  });

  it('reports an admission-floor refusal instead of a takeover race when the expected holder is unchanged', async () => {
    const launchSpy = mockLaunch();
    const ownership = {
      eventKey: 'gate-red-streak:papercusp',
      workItem: 'WI-38026',
      claimState: 'held',
      unknown: null,
      takenBy: 'su-ambiguous-holder',
      takenAt: new Date().toISOString(),
      lastProgressAt: new Date().toISOString(),
      expiresAt: null,
      holderSessionState: 'draining',
      duplicates: [],
      thread: { recent: [], total: 0 },
    };
    vi.doMock('../../coord/gate-ownership', () => ({
      readGateOwnership: vi.fn(async () => ownership),
      shouldStandDownForLivePeer: vi.fn(() => false),
      ownershipNeedsLivenessConfirmation: vi.fn(() => true),
      ownershipContradicted: vi.fn(() => false),
    }));
    vi.doMock('../coordination/identity', () => ({
      resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-caller', workspaceId: 'papercusp-workspace' })),
    }));
    const wakeRecipients = vi.fn(async () => ({
      targets: ['su-ambiguous-holder'],
      keys: ['coord:inbox-wake:su-ambiguous-holder'],
      woken: 0,
      staged: 0,
      stagedTargets: [],
      fanoutCapped: [],
    }));
    vi.doMock('../coordination/inbox-wake', () => ({ wakeRecipients }));
    mockAutomaticTransferTarget('su-caller');
    const claimWorkItem = vi.fn(async () => null);
    const getWorkItem = vi.fn(async () => ({
      id: 'WI-38026',
      family: 'issue',
      harness: 'papercusp',
      assignee: 'su-ambiguous-holder',
    } as never));
    const explainIssueClaimFloors = vi.fn(async () => [{
      id: 'WI-38026',
      admissible: false,
      refusedBy: 'already-taken',
      failedFloors: ['already-taken', 'admission-pending'],
      detail: 'the item remains assigned to the expected holder',
    }]);
    vi.doMock('../../work-items', async () => {
      const actual = await vi.importActual<typeof import('../../work-items')>('../../work-items');
      return { ...actual, claimWorkItem, getWorkItem, explainIssueClaimFloors };
    });
    const assessForceRelease = vi.fn(async () => ({
      allowed: true,
      basis: 'holder-wake-missed' as const,
      holderLiveness: {},
    }));
    const recordForceTransitionAudit = vi.fn(async () => {});
    const notifyForceTransition = vi.fn(async () => {});
    vi.doMock('../work_items/release-force-guard', async () => {
      const actual = await vi.importActual<typeof import('../work_items/release-force-guard')>(
        '../work_items/release-force-guard',
      );
      return { ...actual, assessForceRelease, recordForceTransitionAudit, notifyForceTransition };
    });

    const { default: tool } = await import('./checkpoint-run');
    const metadata = vi.fn();
    const b = parse((await tool.handler({}, MAKE_CTX('operator', {
      uiClientId: 'su-caller',
      workspaceId: 'papercusp-workspace',
      metadata,
    }))) as never);

    expect(claimWorkItem).toHaveBeenCalledWith('WI-38026', 'su-caller', {
      harness: 'papercusp',
      expectedAssignee: 'su-ambiguous-holder',
    });
    expect(getWorkItem).toHaveBeenCalledWith('WI-38026', 'papercusp');
    expect(explainIssueClaimFloors).toHaveBeenCalledWith('papercusp', ['WI-38026'], {
      assignee: 'su-caller',
      includeAllFloors: true,
    });
    expect(b).toMatchObject({
      ok: false,
      launched: false,
      reason: 'force_blocked_by_claim_floor',
      work_item: 'WI-38026',
      expected_holder: 'su-ambiguous-holder',
      current_holder: 'su-ambiguous-holder',
      claim_floor: {
        refused_by: 'admission-pending',
        failed_floors: ['already-taken', 'admission-pending'],
      },
    });
    expect(launchSpy).not.toHaveBeenCalled();
    expect(recordForceTransitionAudit).not.toHaveBeenCalled();
    expect(notifyForceTransition).not.toHaveBeenCalled();
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({
      standDown: 'force_blocked_by_claim_floor',
      standDownWorkItem: 'WI-38026',
      standDownTakenBy: 'su-ambiguous-holder',
      standDownClaimFloor: 'admission-pending',
    }));
  });

  it('P-008: an expired critical progress lease transfers despite a live, wakeable holder', async () => {
    const launchSpy = mockLaunch();
    const staleProgress = new Date(Date.now() - 31 * 60_000).toISOString();
    const ownership = {
      eventKey: 'gate-red-streak:papercusp',
      workItem: 'WI-38026',
      claimState: 'held',
      unknown: null,
      takenBy: 'su-live-elsewhere',
      takenAt: staleProgress,
      lastProgressAt: staleProgress,
      expiresAt: null,
      holderSessionState: 'live',
      duplicates: [],
      thread: { recent: [], total: 0 },
    };
    vi.doMock('../../coord/gate-ownership', () => ({
      readGateOwnership: vi.fn(async () => ownership),
      shouldStandDownForLivePeer: vi.fn(() => true),
      ownershipNeedsLivenessConfirmation: vi.fn(() => null),
      ownershipContradicted: vi.fn(() => false),
    }));
    vi.doMock('../coordination/identity', () => ({
      resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-caller', workspaceId: 'papercusp-workspace' })),
    }));
    const wakeRecipients = vi.fn(async () => ({
      targets: ['su-live-elsewhere'],
      keys: ['coord:inbox-wake:su-live-elsewhere'],
      woken: 1,
      staged: 0,
      stagedTargets: [],
      fanoutCapped: [],
    }));
    vi.doMock('../coordination/inbox-wake', () => ({ wakeRecipients }));
    mockAutomaticTransferTarget('su-caller');
    const claimWorkItem = vi.fn(async () => ({ id: 'WI-38026', harness: 'papercusp' }));
    vi.doMock('../../work-items', async () => {
      const actual = await vi.importActual<typeof import('../../work-items')>('../../work-items');
      return { ...actual, claimWorkItem };
    });
    const assessForceRelease = vi.fn(async () => {
      throw new Error('critical progress expiry must not depend on session liveness');
    });
    const recordForceTransitionAudit = vi.fn(async () => {});
    const notifyForceTransition = vi.fn(async () => {});
    vi.doMock('../work_items/release-force-guard', async () => {
      const actual = await vi.importActual<typeof import('../work_items/release-force-guard')>(
        '../work_items/release-force-guard',
      );
      return { ...actual, assessForceRelease, recordForceTransitionAudit, notifyForceTransition };
    });

    const { default: tool } = await import('./checkpoint-run');
    const b = parse(
      (await tool.handler(
        {},
        MAKE_CTX('operator', {
          uiClientId: 'su-caller',
          workspaceId: 'papercusp-workspace',
          metadata: vi.fn(),
        }),
      )) as never,
    );

    expect(wakeRecipients).toHaveBeenCalledTimes(1);
    expect(assessForceRelease).not.toHaveBeenCalled();
    expect(claimWorkItem).toHaveBeenCalledTimes(1);
    expect(launchSpy).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: true,
      launched: false,
      ownership_transferred: true,
      transfer_basis: 'critical-claim-progress-expired',
    });
  });

  it('EI-22993970761240432: an unknown automatic-transfer target cannot mutate ownership or launch', async () => {
    const launchSpy = mockLaunch();
    const staleProgress = new Date(Date.now() - 31 * 60_000).toISOString();
    const ownership = {
      eventKey: 'gate-red-streak:papercusp',
      workItem: 'WI-38026',
      claimState: 'held',
      unknown: null,
      takenBy: 'su-live-holder',
      takenAt: staleProgress,
      lastProgressAt: staleProgress,
      expiresAt: null,
      holderSessionState: 'live',
      duplicates: [],
      thread: { recent: [], total: 0 },
    };
    vi.doMock('../../coord/gate-ownership', () => ({
      readGateOwnership: vi.fn(async () => ownership),
      shouldStandDownForLivePeer: vi.fn(() => true),
      ownershipNeedsLivenessConfirmation: vi.fn(() => null),
      ownershipContradicted: vi.fn(() => false),
    }));
    vi.doMock('../coordination/identity', () => ({
      resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-typo-target', workspaceId: 'papercusp-workspace' })),
    }));
    const wakeRecipients = vi.fn(async () => ({
      targets: ['su-live-holder'],
      keys: ['coord:inbox-wake:su-live-holder'],
      woken: 1,
      staged: 0,
      stagedTargets: [],
      fanoutCapped: [],
    }));
    vi.doMock('../coordination/inbox-wake', () => ({ wakeRecipients }));
    mockAutomaticTransferTarget('su-typo-target', false);
    const claimWorkItem = vi.fn(async () => ({ id: 'WI-38026', harness: 'papercusp' }));
    vi.doMock('../../work-items', async () => {
      const actual = await vi.importActual<typeof import('../../work-items')>('../../work-items');
      return { ...actual, claimWorkItem };
    });

    const { default: tool } = await import('./checkpoint-run');
    const metadata = vi.fn();
    const b = parse(
      (await tool.handler(
        {},
        MAKE_CTX('operator', {
          uiClientId: 'su-typo-target',
          workspaceId: 'papercusp-workspace',
          metadata,
        }),
      )) as never,
    );

    expect(livenessMocks.resolve).toHaveBeenCalledWith(
      [{ ownerId: 'su-typo-target' }],
      { hydratePerId: true },
    );
    expect(wakeRecipients).toHaveBeenCalledTimes(1);
    expect(claimWorkItem).not.toHaveBeenCalled();
    expect(launchSpy).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: false,
      launched: false,
      reason: 'condition_transfer_target_unknown',
      work_item: 'WI-38026',
      prior_holder: 'su-live-holder',
      transfer_target: 'su-typo-target',
      transfer_basis: 'critical-claim-progress-expired',
      target_session_state: null,
    });
    expect(String(b.note)).toMatch(/su-typo-target/);
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({
      standDown: 'condition_transfer_target_unknown',
      standDownTransferTarget: 'su-typo-target',
    }));
  });

  it('P-008: terminal prerequisites atomically arm the routine and never spawn a detached duplicate', async () => {
    const launchSpy = mockLaunch();
    const armPausedCheckpointTransition = vi.fn(async () => ({
      status: 'armed' as const,
      gateWorkItemId: 'WI-40086',
      prerequisiteWorkItems: ['WI-41117'],
      armedAtMs: 123,
    }));
    vi.doMock('../../release/checkpoint-serializer-authority', () => ({
      readCheckpointSerializerAuthority: vi.fn(async () => ({ status: 'none', reason: 'pause-not-quiescence' })),
      armPausedCheckpointTransition,
    }));
    vi.doMock('../../coord/gate-ownership', () => ({
      readGateOwnership: vi.fn(async () => ({
        eventKey: 'gate-red-streak:papercusp',
        workItem: 'WI-40086',
        claimState: 'held',
        takenBy: 'su-caller',
      })),
      shouldStandDownForLivePeer: vi.fn(() => false),
      ownershipNeedsLivenessConfirmation: vi.fn(() => null),
      ownershipContradicted: vi.fn(() => false),
    }));
    vi.doMock('../coordination/identity', () => ({
      resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-caller', workspaceId: 'papercusp-workspace' })),
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse(
      (await tool.handler(
        {
          resumePausedRoutine: true,
          prerequisiteWorkItems: ['WI-41117'],
          reason: 'repairs terminal',
        },
        MAKE_CTX('operator', {
          uiClientId: 'su-caller',
          workspaceId: 'papercusp-workspace',
          metadata: vi.fn(),
        }),
      )) as never,
    );

    expect(armPausedCheckpointTransition).toHaveBeenCalledWith({
      callerOwnerId: 'su-caller',
      gateWorkItemId: 'WI-40086',
      prerequisiteWorkItems: ['WI-41117'],
      installSlug: 'papercusp',
      workspaceId: 'papercusp-workspace',
    });
    expect(launchSpy).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: true,
      launched: false,
      scheduled: true,
      reason: 'serializer_transition_armed',
      work_item: 'WI-40086',
    });
  });

  it('waitForEligibility returns a durable receipt without sleeping or spawning in the request', async () => {
    const requiredAncestorSha = '65b369adb8a9eb3fd7a2e3a93ab4eaedcad7c35e';
    const scheduleSpy = vi.fn(async () => ({
      pendingId: 'pending-1',
      workflowId: 'checkpoint-eligibility:pending-1',
      completionEvents: [
        'release:green:papercusp',
        'green-checkpoint:red:papercusp',
        'green-checkpoint:inconclusive:papercusp',
      ],
    }));
    const launchSpy = mockLaunch({
      assessPreLaunchExclusion: vi.fn(async () => REFUSAL),
      scheduleCheckpointEligibilityWait: scheduleSpy,
    });
    const { default: tool } = await import('./checkpoint-run');
    // The property is "never sleeps in the request". A request-side sleep would last the
    // refusal's wait_sec (120s here — the scheduleSpy assertion below pins waitSec: 120),
    // so the budget only has to separate "returned immediately" from "slept across
    // wait_sec". The old 1000ms literal separated it from gate-load scheduling noise
    // instead: it measured 1392ms on repairHead 128acc8c under the loaded stateful lane
    // (test_runs 19720275) after passing on the same commit an hour earlier.
    // Named + ordered per scripts/check-test-timing-budgets.mjs (WI-10003256).
    const REQUEST_SIDE_SLEEP_MS = 120_000;
    const NO_SLEEP_BUDGET_MS = 15_000;
    expect(NO_SLEEP_BUDGET_MS).toBeLessThan(REQUEST_SIDE_SLEEP_MS);
    const started = Date.now();
    const b = parse(
      (await tool.handler({ paths: [MINE], waitForEligibility: true, requiredAncestorSha }, MAKE_CTX())) as never,
    );

    expect(Date.now() - started).toBeLessThan(NO_SLEEP_BUDGET_MS);
    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: [MINE],
        waitSec: 120,
        pendingId: expect.any(String),
        logicalAttemptId: expect.any(String),
        requiredAncestorSha,
      }),
    );
    expect(qualificationMocks.wait).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        attemptId: expect.any(String),
        reason: 'would-exclude-declared-paths',
        blockers: [expect.objectContaining({ code: 'quiet-cut' })],
      }),
    );
    expect(launchSpy).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: true,
      launched: false,
      pending: true,
      reason: 'waiting_for_eligibility',
      logical_attempt_id: expect.any(String),
      pending_id: 'pending-1',
      workflow_id: 'checkpoint-eligibility:pending-1',
      completion_events: [
        'release:green:papercusp',
        'green-checkpoint:red:papercusp',
        'green-checkpoint:inconclusive:papercusp',
      ],
    });
    expect(String(b.note)).toMatch(/durable eligibility waiter/);
  });

  const recoveryProof = {
    attemptId: 'historical-attempt', runId: 'historical-run', candidate: 'a'.repeat(40),
    logPath: '/archive/historical-run.log', logSha256: 'b'.repeat(64),
  };

  it('inherits the verified distinct historical successor before reserving a runner', async () => {
    const launchSpy = mockLaunch({ assessPreLaunchExclusion: vi.fn(async () => ({ ...REFUSAL, refuse: false })) });
    vi.doMock('../../release/checkpoint-required-ancestor', async orig => ({
      ...(await orig<typeof import('../../release/checkpoint-required-ancestor')>()),
      assessRequiredAncestorPreflight: vi.fn(async () => ({
        ok: true, reason: 'contained', requiredAncestor: recoveryProof.candidate, candidate: recoveryProof.candidate,
        candidateSource: 'current-quiet-cut', repairQueue: null, frozenLineageIdentity: null,
        queueDecision: 'run-normal-gate', fixerAlive: null,
      } satisfies import('../../release/checkpoint-required-ancestor').RequiredAncestorPreflight)),
      assessFrozenRepairQueuePreflight: vi.fn(async () => ({
        proceed: true, reason: 'clear', candidate: recoveryProof.candidate,
        candidateSource: 'current-quiet-cut', repairQueue: null, frozenLineageIdentity: null,
        queueDecision: 'run-normal-gate', nextAttempt: null, fixerSpawnId: null, fixerAlive: null,
      } satisfies import('../../release/checkpoint-required-ancestor').FrozenRepairQueuePreflight)),
    }));
    const requiredAncestorSha = 'a'.repeat(40);
    const successor = qualificationTransaction({
      attemptId: 'verified-successor', requiredAncestorSha, declaredPaths: [MINE], candidate: recoveryProof.candidate,
    });
    qualificationMocks.recover.mockResolvedValue({ status: 'updated', transaction: successor });
    qualificationMocks.read.mockResolvedValue({ status: 'present', transaction: successor });
    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({
      paths: [MINE], requiredAncestorSha, historicalPreSuiteRecovery: recoveryProof,
    }, MAKE_CTX())) as never);
    expect(qualificationMocks.recover).toHaveBeenCalledWith(
      expect.any(Object), recoveryProof,
      expect.objectContaining({ requiredAncestorSha, declaredPaths: [MINE] }),
    );
    expect(qualificationMocks.begin).toHaveBeenCalledWith(expect.any(Object),
      expect.objectContaining({ attemptId: 'verified-successor', attemptIdForVerificationTarget: undefined }),
      expect.any(Object));
    expect(qualificationMocks.reserve).toHaveBeenCalledWith(expect.any(Object),
      expect.objectContaining({ attemptId: 'verified-successor' }));
    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(b.ok).toBe(true);
  });

  it.each(['conflict', 'unreadable', 'terminal'])('refuses %s archive recovery without beginning or launching', async status => {
    const launchSpy = mockLaunch({ assessPreLaunchExclusion: vi.fn(async () => ({ ...REFUSAL, refuse: false })) });
    qualificationMocks.recover.mockResolvedValue({ status });
    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ paths: [MINE], historicalPreSuiteRecovery: recoveryProof }, MAKE_CTX())) as never);
    expect(b).toMatchObject({ launched: false, reason: 'historical_pre_suite_recovery_refused', recovery_status: status });
    expect(qualificationMocks.begin).not.toHaveBeenCalled();
    expect(qualificationMocks.reserve).not.toHaveBeenCalled();
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it('does not recover historical evidence while candidate preflight refuses', async () => {
    const launchSpy = mockLaunch({ assessPreLaunchExclusion: vi.fn(async () => REFUSAL) });
    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ paths: [MINE], historicalPreSuiteRecovery: recoveryProof }, MAKE_CTX())) as never);
    expect(b).toMatchObject({ launched: false, recovery_status: 'preflight-refused' });
    expect(qualificationMocks.recover).not.toHaveBeenCalled();
    expect(launchSpy).not.toHaveBeenCalled();
  });
  it('returns the locked recovery guard and queue reason without beginning or launching', async () => {
    const launchSpy = mockLaunch({ assessPreLaunchExclusion: vi.fn(async () => ({ ...REFUSAL, refuse: false })) });
    qualificationMocks.recover.mockResolvedValue({
      status: 'conflict', refusalReason: 'repair-queue-reconciliation',
      repairQueueReconciliation: { status: 'blocked', reason: 'queue-origin-mismatch' },
    });
    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ paths: [MINE], historicalPreSuiteRecovery: recoveryProof }, MAKE_CTX())) as never);
    expect(b).toMatchObject({ launched: false, recovery_refusal_reason: 'repair-queue-reconciliation',
      recovery_queue_reason: 'queue-origin-mismatch' });
    expect(b).not.toHaveProperty('transaction');
    expect(qualificationMocks.begin).not.toHaveBeenCalled();
    expect(qualificationMocks.reserve).not.toHaveBeenCalled();
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it('does not use historical evidence to bypass another live gate owner', async () => {
    const launchSpy = mockLaunch({ assessPreLaunchExclusion: vi.fn(async () => ({ ...REFUSAL, refuse: false })) });
    vi.doMock('../../coord/gate-ownership', async orig => ({
      ...(await orig<typeof import('../../coord/gate-ownership')>()),
      readGateOwnership: vi.fn(async () => ({
        workItem: 'WI-held', takenBy: 'su-peer', takenAt: new Date().toISOString(),
        holderSessionState: 'live', thread: { total: 0, recent: [] },
      })),
      shouldStandDownForLivePeer: vi.fn(() => true),
      ownershipNeedsLivenessConfirmation: vi.fn(() => false),
      ownershipContradicted: vi.fn(() => false),
    }));
    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ paths: [MINE], historicalPreSuiteRecovery: recoveryProof }, MAKE_CTX())) as never);
    expect(b).toMatchObject({ launched: false, reason: 'condition_claimed' });
    expect(qualificationMocks.recover).not.toHaveBeenCalled();
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it('P-003: an exact terminal attempt never auto-retries a real verdict', async () => {
    const launchSpy = mockLaunch({
      assessPreLaunchExclusion: vi.fn(async () => ({
        ...REFUSAL,
        refuse: false,
        proceedReason: 'declared-paths-in-candidate',
      })),
    });
    qualificationMocks.begin.mockImplementationOnce(async (_target: unknown, input: Record<string, unknown>) => ({
      status: 'terminal',
      transaction: {
        ...qualificationTransaction(input, 'terminal'),
        outcome: { kind: 'red', reason: 'not-green' },
      },
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ paths: [MINE] }, MAKE_CTX())) as never);

    expect(launchSpy).not.toHaveBeenCalled();
    expect(qualificationMocks.reserve).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: false,
      launched: false,
      reason: 'qualification_transaction_terminal',
      logical_attempt_id: expect.any(String),
      outcome: { kind: 'red', reason: 'not-green' },
    });
  });

  it('waitForEligibility fails closed when the durable runner is unavailable, without a request-side sleep', async () => {
    const scheduleSpy = vi.fn(async () => {
      throw new Error('DBOS is not installed');
    });
    const launchSpy = mockLaunch({
      assessPreLaunchExclusion: vi.fn(async () => REFUSAL),
      scheduleCheckpointEligibilityWait: scheduleSpy,
    });
    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ paths: [MINE], waitForEligibility: true }, MAKE_CTX())) as never);

    // A busy runner can spend over a second in the mocked authority and
    // metadata path without sleeping. Inspect the exact refusal branch to
    // guard the regression this case names: a request-side delay fallback.
    const source = readFileSync(new URL('./checkpoint-run.ts', import.meta.url), 'utf8');
    const branchStart = source.indexOf('if (preflight.refuse && args.waitForEligibility)');
    const branchEnd = source.indexOf('    recordMetadata({', branchStart);
    expect(branchStart).toBeGreaterThanOrEqual(0);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branch = source.slice(branchStart, branchEnd);
    expect(branch).toContain('scheduleCheckpointEligibilityWait');
    expect(branch).not.toMatch(/\b(?:setTimeout|sleep|delay)\s*\(/);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(launchSpy).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: false,
      launched: false,
      reason: 'wait_for_eligibility_unavailable',
    });
    expect(String(b.note)).toMatch(/no MCP sleep was attempted/);
  });

  /**
   * WI-37618. The refusal above is returned to the CALLER and stored nowhere else:
   * `tool_invocations` keeps only transport metadata and `output_ref` is a reference, not a
   * body. So in the ledger a refusal looked identical to a call that spent a ~55min suite, and
   * a FALSE refusal — the one failure mode that would wedge the fleet's only manual verdict
   * lever — left nothing behind to audit.
   *
   * These assert the LEDGER STAMP specifically, not the reply. The reply is what the caller can
   * already see; the stamp is what anyone can see AFTERWARDS. `MAKE_CTX` deliberately has no
   * `metadata`, which is why the handler optional-chains it and why these build their own ctx.
   */
  const MAKE_CTX_META = () => {
    const metadata = vi.fn();
    return {
      ctx: {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        role: 'operator',
        metadata,
      } as never,
      metadata,
    };
  };

  it('stamps the REFUSAL into ctx.metadata, so a false refusal is auditable after the fact', async () => {
    const launchSpy = mockLaunch({ assessPreLaunchExclusion: vi.fn(async () => REFUSAL) });
    const { default: tool } = await import('./checkpoint-run');
    const { ctx, metadata } = MAKE_CTX_META();
    await tool.handler({ paths: [MINE] }, ctx);

    expect(launchSpy).not.toHaveBeenCalled();
    expect(metadata).toHaveBeenCalledTimes(1);
    // Enough to re-derive the decision later: which paths were held back, against which
    // candidate, and for how long. The commits themselves stay recoverable from the candidate.
    expect(metadata.mock.calls[0][0]).toMatchObject({
      preLaunchExclusion: 'refused',
      preLaunchCandidate: 'aaaaaaaaaaaa',
      preLaunchTip: 'ffffffffffff',
      preLaunchWaitSec: 120,
      preLaunchBlockedPaths: [{ path: MINE, eligibleInSec: 120 }],
      refusalProvenance: expect.objectContaining({
        serving_host: expect.any(String),
        runner_code_freshness: expect.anything(),
      }),
    });
    expect(parse((await tool.handler({ paths: [MINE] }, MAKE_CTX())) as never)).toEqual(
      expect.objectContaining({
        launched: false,
        refusal_provenance: expect.objectContaining({
          serving_host: expect.any(String),
          runner_code_freshness: expect.anything(),
        }),
      }),
    );
  });

  it('stamps a PASS with its proceedReason, so the refusal rate has a denominator', async () => {
    mockLaunch({
      assessPreLaunchExclusion: vi.fn(async () => ({
        ...REFUSAL,
        refuse: false,
        proceedReason: 'exclusion-undecidable',
      })),
    });
    const { default: tool } = await import('./checkpoint-run');
    const { ctx, metadata } = MAKE_CTX_META();
    await tool.handler({ paths: [MINE] }, ctx);

    const stamped = metadata.mock.calls[0][0] as Record<string, unknown>;
    // The defect was that these two were the SAME observation. They must never be again.
    expect(stamped.preLaunchExclusion).toBe('passed');
    // And WHICH fail-open path: "could not assess" is not "assessed and allowed", and a
    // bare `passed` would rebuild exactly the ambiguity this exists to remove.
    expect(stamped.preLaunchProceedReason).toBe('exclusion-undecidable');
    // A pass carries no blocked-path detail — that would imply a refusal that never happened.
    expect(stamped).not.toHaveProperty('preLaunchBlockedPaths');
  });

  // ─── EI-20031402866608444: `reason` is ACCEPTED and recorded ───────────────────────────────
  // It was undeclared, and the published schema is additionalProperties:false, so passing it was
  // an invalid_input that launched NOTHING: 19 of 22 rejections in 14 days (~11% of all calls to
  // this verb), 6 distinct agents on 2026-08-09 alone, every case a retry-without-it seconds
  // later, mid-incident, on the fleet's only manual verdict lever.
  //
  // ⚠ MEASURED, not assumed: this args schema is STRICT — an undeclared key is REJECTED here, at
  // safeParse, not merely stripped. (I first wrote the control below the other way round, on the
  // usual zod default of silently dropping unknown keys, and it failed: `success` came back
  // false. So the invalid_input the 19 rejections hit originates at THIS schema, not only at the
  // published additionalProperties:false contract.) That is what makes the assertions below real
  // guards rather than vacuous ones — had unknown keys been stripped instead, a bare
  // `.success === true` would pass just as happily against a schema that never declared `reason`,
  // so these still assert the parsed OUTPUT as well.

  const REASON = 'gate RED 3x / ~2h, main frozen, no run in flight';

  it('EI-20031402866608444: a `reason` SURVIVES the args schema (it used to be rejected outright)', async () => {
    const { default: tool } = await import('./checkpoint-run');
    const parsed = tool.args.safeParse({ reason: REASON });
    if (!parsed.success) throw new Error('reason was REJECTED by the args schema — the original defect');
    expect((parsed.data as { reason?: string }).reason).toBe(REASON);
  });

  it('EI-20031402866608444: CONTROL — an UNDECLARED arg is still REJECTED, reproducing the original defect', async () => {
    const { default: tool } = await import('./checkpoint-run');
    // This is the defect itself, held in place as a control: an arg this schema does not declare
    // fails to parse, which is precisely what `reason` used to do. It proves (a) the schema is
    // still strict — accepting `reason` did not quietly open the tool to anything — and (b) the
    // test above is falsifiable, since deleting the `reason` field would make it fail exactly
    // like this.
    expect(tool.args.safeParse({ definitelyNotAnArg: 'x' }).success).toBe(false);
  });

  it('EI-20031402866608444: never rejects a reason for terseness or length (softText, not hardText)', async () => {
    const { default: tool } = await import('./checkpoint-run');
    // This verb's whole defect was REJECTING callers; a length/min rule would rebuild it in
    // miniature. hardText(LIMITS.SHORT_TITLE, { min: 8 }) — the sibling release:deploy shape —
    // would fail BOTH of these.
    const terse = tool.args.safeParse({ reason: 'red' });
    expect(terse.success && (terse.data as { reason?: string }).reason).toBe('red');
    const huge = tool.args.safeParse({ reason: 'x'.repeat(5000) });
    expect(huge.success && (huge.data as { reason?: string }).reason).toHaveLength(5000);
  });

  it('EI-20031402866608444: stamps the reason as fireReason WITHOUT clobbering the exclusion keys', async () => {
    mockLaunch({ assessPreLaunchExclusion: vi.fn(async () => REFUSAL) });
    const { default: tool } = await import('./checkpoint-run');
    const { ctx, metadata } = MAKE_CTX_META();
    await tool.handler({ paths: [MINE], reason: REASON }, ctx);

    // ONE call, carrying BOTH. The seam is overwrite-not-merge (dispatch-stack.ts:550, "last
    // write wins"), so stamping the reason from a SECOND ctx.metadata() call would wipe every
    // preLaunchExclusion key WI-37618 added. This is the guard on that.
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(metadata.mock.calls[0][0]).toMatchObject({
      fireReason: REASON,
      preLaunchExclusion: 'refused',
      preLaunchCandidate: 'aaaaaaaaaaaa',
      preLaunchBlockedPaths: [{ path: MINE, eligibleInSec: 120 }],
    });
  });

  it('EI-20031402866608444: omits fireReason entirely when no reason was given, and clamps a huge one', async () => {
    mockLaunch({ assessPreLaunchExclusion: vi.fn(async () => REFUSAL) });
    const { default: tool } = await import('./checkpoint-run');

    const bare = MAKE_CTX_META();
    await tool.handler({ paths: [MINE] }, bare.ctx);
    // Absent rather than null/'' — so `metadata_json ? 'fireReason'` cleanly separates the calls
    // that actually justified themselves from the ones that did not.
    expect(bare.metadata.mock.calls[0][0]).not.toHaveProperty('fireReason');

    const big = MAKE_CTX_META();
    await tool.handler({ paths: [MINE], reason: 'y'.repeat(5000) }, big.ctx);
    // Accepted at the schema, bounded at the stamp — the softText/clampText contract.
    expect((big.metadata.mock.calls[0][0] as { fireReason: string }).fireReason).toHaveLength(1000);
  });
});
