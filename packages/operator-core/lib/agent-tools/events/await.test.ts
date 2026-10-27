/**
 * await.test.ts — events:await wrapper defaults (GAP 16).
 *
 * Mirrors watch.test.ts's tool-mock rig. events:await is the one-shot WAKE sugar
 * — asserts registerAwait is called with policy:'wake', timeoutBehavior:'wake'
 * by default, timeoutSec = the shared AWAIT_DEFAULT_TIMEOUT_SEC (1800 = 30min) by
 * default, that overrides flow through, and that the response carries
 * await_id/expires_ts/wake_handle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
  SU_ROLES: ['operator'],
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-awaiter', ownerLabel: 'a', source: 'static-client', workspaceId: 'ws-x', userId: null }),
}));
vi.mock('../../acceptance-runtime-wait-guard', () => ({
  acceptancePlaneAdvisoryForWait: vi.fn(async () => null),
  mainWaitAdvisoryForWait: vi.fn(async () => null),
  mainWaitPlanReviewForWait: vi.fn(async () => null),
}));
// EI-20268841604319803: the service-up EDGE advisory reads live health at arm
// time. Stub ONLY the probe so the real predicate (./service-up-edge) and the
// real handler wiring both execute. Defaults to "no probe result" ⇒ no
// advisory, so every pre-existing test above is unaffected.
const serviceHealthMock = vi.hoisted(() => ({ probeNamedService: vi.fn(async (_name: string) => null as unknown) }));
vi.mock('../../service-health', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../service-health')>()),
  probeNamedService: serviceHealthMock.probeNamedService,
}));
vi.mock('../../events/await/handle', () => ({
  captureWakeHandleForOwner: vi.fn(async () => ({ handle: { kind: 'adv-session', advSessionId: 1, agent: 'claude', sessionId: 's', ompThreadId: null, cwd: '/r', pid: 1 }, note: 'resumable' })),
}));
vi.mock('../../events/await/predicate-watch', () => ({
  getPredicateWatch: vi.fn(async () => null),
}));
vi.mock('../../events/await/store', () => ({
  registerAwait: vi.fn(async (i: Record<string, unknown>) => ({ id: 99, eventKey: i.eventKey, expiresTs: '2030-01-01', timeoutBehavior: i.timeoutBehavior })),
  // EI-21124063749265204: the post-registration egress-latch reconciliation
  // cancels only when this atomic pending-row guard wins the race.
  cancelAwait: vi.fn(async () => false),
  // EI-14225: the supersede-prior-await-on-registration retirement. Defaults to
  // "nothing to retire" so every pre-existing test above is unaffected; overridden
  // per-test below to exercise the supersede path.
  cancelAwaitsForSubscribersOnKeys: vi.fn(async () => 0),
  FLEET_BENCH_NOTE_PREFIX: '[fleet:bench] ',
  // EI-18676056143796303: the orphan guard now asks the fire latch whether this key
  // (or a sibling in its family) has ever ACTUALLY fired before claiming no emitter
  // exists. Defaults to "no evidence", so every pre-existing case above still warns
  // exactly as it did; overridden per-test below to exercise the suppression path.
  probeKeyFireEvidence: vi.fn(async (eventKey: string) => ({
    prefix: eventKey.split(':').slice(0, 2).join(':'),
    exact: false,
    distinctKeys: 0,
    fires: 0,
    lastFiredAt: null,
  })),
  // EI-18701276960172209: the announced-gate latch/no-known-emitter checks read
  // these — default to "no announcement, no near-miss" so every PRE-EXISTING test
  // above is unaffected (previously this silently threw and was swallowed by the
  // handler's own try/catch; mocking explicitly is just more honest about it).
  // Overridden per-test below to exercise the announced-gate path.
  findAnnouncementsForKey: vi.fn(async () => [] as unknown[]),
  findNearMissKeys: vi.fn(async () => [] as unknown[]),
  // EI-19332682533219755: a PATTERN registration now discloses which concrete keys
  // its glob really covers (the `release:green:*` cross-pipeline incident).
  // Defaults to "no observed keys" ⇒ no advisory, so every pre-existing pattern
  // test above is unaffected; overridden per-test below to exercise the warning.
  probePatternMatchScope: vi.fn(async () => ({ prefix: '', matchedKeys: [], truncated: false })),
  hasLiveExactAwaitForSubscriberKey: vi.fn(async () => false),
}));
vi.mock('../../harness/routines/monitor-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../harness/routines/monitor-policy')>()),
  hasActiveMonitorForOwnerPredicate: vi.fn(async () => false),
}));
vi.mock('../../events/await/engine', () => ({ startAwaitSweeper: vi.fn() }));
vi.mock('./producer-health', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./producer-health')>()),
  resolveProducerHealthCertificate: vi.fn(async () => ({
    version: 1,
    producer: { kind: 'green-checkpoint', id: 'run-1' },
    owner: { ownerId: 'su-awaiter', workItemId: null },
    issuedAtMs: 1,
    lastProgressAtMs: 1,
    lastFireAtMs: null,
    expectedCadenceMs: 90_000,
    verificationDeadlineMs: 90_001,
    details: { pipeline: 'papercusp' },
  })),
  resolveProgressLeaseCertificate: vi.fn(async () => ({
    version: 1,
    producer: { kind: 'delegated-progress', id: 'lease-1' },
    owner: { ownerId: 'su-worker', workItemId: 'WI-1' },
    issuedAtMs: 1, lastProgressAtMs: 1, lastFireAtMs: null,
    expectedCadenceMs: 60_000, verificationDeadlineMs: 60_001,
    progressLease: { leaseId: 'lease-1' },
  })),
}));
vi.mock('./status', () => ({
  // Keep the await wrapper hermetic; ownership behavior is supplied by the
  // focused tests below instead of querying the liveness/role stores.
  resolveAnnouncementOwnership: vi.fn(async () => new Map()),
}));
vi.mock('../coordination/messages', () => ({ getMessageById: vi.fn() }));
// EI-10870: the orphan-key guard reads the INSTALLED tier to avoid false-warning on a
// pack-declared key. Default: no installed packs ⇒ the builtin catalog decides.
vi.mock('../../events/await/installed-events', () => ({
  readInstalledUnitEvents: vi.fn(async () => []),
}));
// EI-13095/P-006: the done/unblocked registration latches probe the live item —
// mocked so the rig stays hermetic (the real module pulls db-org). Defaults
// ('live'/a real blocking edge) make every existing case register exactly as before.
vi.mock('../../work-items-events', () => ({
  liveSettledProbe: vi.fn(async () => ({ verdict: 'live' as const, itemState: 'wip' })),
  liveBlockedState: vi.fn(async () => ({
    verdict: 'blocked' as const,
    lifecycleState: 'open',
    dependencyState: 'blocked' as const,
  })),
  // EI-18731480441007330: the self-await deadlock guard's probe. Defaults to
  // 'live' with no assignee (never equal to the caller's own ownerId,
  // 'su-awaiter'), so every PRE-EXISTING test above still registers exactly
  // as before; overridden per-test below to exercise the refusal path.
  liveAssigneeProbe: vi.fn(async () => ({ verdict: 'live' as const, assignee: null as string | null })),
  // EI-21565976517547834: registration-time claimable-level reconciliation.
  // No live payload by default, so every pre-existing await still registers.
  liveWorkItemClaimableEventPayload: vi.fn(async () => null as Record<string, unknown> | null),
}));
// EI-383: the claim-lease-extension side-call also pulls db-org (via claims.ts +
// resolvePlanScope) — mocked so the rig stays hermetic, same reasoning as the
// work-items-events mock above.
vi.mock('../../plan-items/claims', () => ({
  extendOwnerClaimsForAwait: vi.fn(async () => [] as string[]),
}));
vi.mock('../plans/source', () => ({
  resolvePlanScope: vi.fn(async () => ({ workspaceId: 'ws-x', harnessSlug: 'papercup' })),
}));
// EI-18734910825871393: the plan-item:done:<slug>:<id> registration latch's live-status
// probe. Defaults to null (undeterminable) so every PRE-EXISTING test above is unaffected;
// overridden per-test below to exercise the already_done short-circuit.
vi.mock('../../plan-items/assignments', () => ({
  planItemEffectiveStatus: vi.fn(async () => null as string | null),
}));
// EI-13846: the claim-spec read behind the `work-item:claimable` payload_filter
// default. Defaults to 'default' (no spec) so every PRE-EXISTING test above (none
// of which awaits 'work-item:claimable') is unaffected; overridden per-test below.
vi.mock('../../scheduler/claim-spec-store', () => ({
  getClaimSpecRecord: vi.fn(async () => ({ source: 'default' as const, spec: null, revision: null, updatedBy: null, updatedAt: null })),
}));
vi.mock('../../scheduler/get-next', () => ({
  readIssueClaimability: vi.fn(async () => ({ rows: [] })),
}));

import awaitTool from './await';
import { getClaimSpecRecord, type ClaimSpecRecord } from '../../scheduler/claim-spec-store';
import { registerAwait, cancelAwait, cancelAwaitsForSubscribersOnKeys, probeKeyFireEvidence, findAnnouncementsForKey, probePatternMatchScope } from '../../events/await/store';
import type { AwaitRow } from '../../events/await/types';
// Namespace view of the SAME mocked module — the coverage guard at the bottom of this
// file checks its key set against production's import list.
import * as storeMock from '../../events/await/store';
import { mockImplementationTyped } from '../../testing/typed-mock';
import { assertMockCoversImports } from '../../testing/mock-import-coverage';
import { getMessageById } from '../coordination/messages';
import { captureWakeHandleForOwner } from '../../events/await/handle';
import { getPredicateWatch } from '../../events/await/predicate-watch';
import { startAwaitSweeper } from '../../events/await/engine';
import { readInstalledUnitEvents } from '../../events/await/installed-events';
import { liveBlockedState, liveSettledProbe, liveAssigneeProbe, liveWorkItemClaimableEventPayload } from '../../work-items-events';
import { planItemEffectiveStatus } from '../../plan-items/assignments';
import { AWAIT_DEFAULT_TIMEOUT_SEC } from '../../events/await/types';
import { extendOwnerClaimsForAwait } from '../../plan-items/claims';
import { readIssueClaimability } from '../../scheduler/get-next';
import { mockResolvedTyped } from '../../testing/typed-mock';
import {
  progressLeaseInputSchema,
  resolveProducerHealthCertificate,
  resolveProgressLeaseCertificate,
} from './producer-health';
import { resolveAnnouncementOwnership } from './status';
import { hasActiveMonitorForOwnerPredicate } from '../../harness/routines/monitor-policy';
import { mainWaitAdvisoryForWait, mainWaitPlanReviewForWait } from '../../acceptance-runtime-wait-guard';

const ctx = { workspaceId: 'ws-x' } as unknown as Parameters<typeof awaitTool.handler>[1];
const call = async (args: Record<string, unknown>) => {
  const res = (await awaitTool.handler(args as never, ctx)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasActiveMonitorForOwnerPredicate).mockResolvedValue(false);
});

describe('events:await wrapper defaults', () => {
  it('refuses a plan-wide main wait before retiring or registering an await', async () => {
    vi.mocked(mainWaitPlanReviewForWait).mockResolvedValueOnce({
      plan: 'plan-a', allowWait: false, code: 'plan_main_wait_review_required',
      readyItems: ['P-002'], downstreamItems: [], waitRoots: ['P-001'], reasonAccepted: false,
      message: 'Continue P-002 on staging',
    });
    const out = await call({ event: 'release:green:papercusp' });
    expect(out).toMatchObject({ ok: false, error: 'plan_main_wait_review_required', readyItems: ['P-002'] });
    expect(cancelAwaitsForSubscribersOnKeys).not.toHaveBeenCalled();
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it('attaches the main-wait advisory when the presence-plan review had nothing to say (WI-6554700010014960)', async () => {
    vi.mocked(mainWaitAdvisoryForWait).mockResolvedValueOnce('MAIN-WAIT ADVISORY: do every step that does not need green main first.');
    const out = await call({ event: 'release:green:papercusp', note: 'carry WI-10007221' });
    expect(out).toMatchObject({ ok: true, main_wait_advisory: expect.stringContaining('MAIN-WAIT ADVISORY') });
    expect(mainWaitAdvisoryForWait).toHaveBeenCalledWith({
      ownerId: 'su-awaiter',
      event: 'release:green:papercusp',
      note: 'carry WI-10007221',
    });
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it('does not add the generic advisory on top of an allowed presence-plan review', async () => {
    vi.mocked(mainWaitPlanReviewForWait).mockResolvedValueOnce({
      plan: 'plan-a', allowWait: true, code: 'plan_main_wait_review_required',
      readyItems: [], downstreamItems: [], waitRoots: ['P-001'], reasonAccepted: true,
      message: 'Plan plan-a still has 1 open item(s).',
    });
    const out = await call({ event: 'release:green:papercusp' });
    expect(out).toMatchObject({ ok: true, main_wait_plan_review: { plan: 'plan-a' } });
    expect(out).not.toHaveProperty('main_wait_advisory');
    expect(mainWaitAdvisoryForWait).not.toHaveBeenCalled();
  });

  it('refuses an exact await when the owner already has the same active monitor, before mutation', async () => {
    vi.mocked(hasActiveMonitorForOwnerPredicate).mockResolvedValueOnce(true);
    const out = await call({ event: 'release:green:papercusp' });
    expect(out).toMatchObject({
      ok: false,
      error: 'monitor_exact_await_duplicate',
      predicateKey: 'release:green:papercusp',
      conflictingKind: 'monitor',
    });
    expect(registerAwait).not.toHaveBeenCalled();
    expect(cancelAwaitsForSubscribersOnKeys).not.toHaveBeenCalled();
  });
  it('keeps registering when the optional monitor-dedup read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(hasActiveMonitorForOwnerPredicate).mockRejectedValueOnce(new Error('db-call-deadline: acquire(admin)'));

    const out = await call({ event: 'work-item:done:WI-2146348' });

    expect(out).toMatchObject({ ok: true, event: 'work-item:done:WI-2146348', await_id: 99 });
    expect(registerAwait).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('events-await:monitorPredicateDedup'));
    warn.mockRestore();
  });
  it('guidance warns before registration that self-assignee status/done awaits are refused', () => {
    const guidance = awaitTool.guidance;
    expect(guidance).toBeDefined();
    expect(guidance!.when).toMatch(/work-item:status:<id>.*work-item:done:<id>.*claim:released:<id>/);
    expect(guidance!.when).toMatch(/unsatisfiable self-deadlock/);
    expect(guidance!.when).toMatch(/before registration/);
  });

  it('documents producer_health compatibility with the await selector', () => {
    expect(awaitTool.args.shape.producer_health.description).toMatch(
      /requires `event` or `fromMsg` and is rejected with a composed `spec`/,
    );
  });

  it('documents progress lease wake/remedy sequencing and rejects wake-owner as a remedy kind', () => {
    const progressLeaseDescription = awaitTool.args.shape.progress_lease.description;
    expect(progressLeaseDescription).toMatch(/automatically wakes owner_id on the first cadence miss/);
    expect(progressLeaseDescription).toMatch(
      /spec-widen, outside-lane-placement, leader-claim, or create-unblock-item/,
    );
    expect(progressLeaseDescription).toMatch(/wake-owner is not a valid remedy kind/);
    expect(progressLeaseInputSchema.shape.remedy.description).toMatch(
      /first cadence miss automatically wakes owner_id/,
    );
    expect(progressLeaseInputSchema.shape.remedy.description).toMatch(/wake-owner is not a remedy kind/);

    const valid = {
      source_kind: 'checkpoint-revision',
      tool: 'work_items:get',
      args: { id: 'WI-1' },
      path: 'results.0.checkpoint.revision',
      units: 'revision',
      expected_cadence_sec: 60,
      owner_id: 'su-worker',
      remedy: { kind: 'leader-claim', workItemId: 'WI-1' },
    };
    expect(progressLeaseInputSchema.safeParse(valid).success).toBe(true);
    expect(
      progressLeaseInputSchema.safeParse({
        ...valid,
        remedy: { kind: 'wake-owner', after_misses: 1 },
      }).success,
    ).toBe(false);
  });

  it('defaults: policy:wake, timeoutBehavior:wake, timeoutSec:AWAIT_DEFAULT_TIMEOUT_SEC (1800 = 30min), and the sweeper starts', async () => {
    await call({ event: 'lock:grant:t1' });
    expect(startAwaitSweeper).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg).toMatchObject({
      subscriberId: 'su-awaiter',
      eventKey: 'lock:grant:t1',
      policy: 'wake',
      timeoutBehavior: 'wake',
      timeoutSec: AWAIT_DEFAULT_TIMEOUT_SEC,
      note: null,
    });
    // WI-3575: registerAwait no longer takes workspaceId (events:await is
    // single-workspace by design — see store.ts).
    expect(arg).not.toHaveProperty('workspaceId');
  });

  it('retries a transient statement timeout while registering instead of stranding the caller', async () => {
    vi.useFakeTimers();
    try {
      const contention = Object.assign(new Error('canceling statement due to statement timeout'), {
        code: '57014',
      });
      vi.mocked(registerAwait)
        .mockRejectedValueOnce(contention)
        .mockResolvedValueOnce({
          id: 100,
          eventKey: 'lock:grant:retry-me',
          expiresTs: '2030-01-01',
          timeoutBehavior: 'wake',
        } as AwaitRow);

      const pending = call({ event: 'lock:grant:retry-me' });
      await vi.advanceTimersByTimeAsync(500);
      const out = await pending;

      expect(out).toMatchObject({
        ok: true,
        await_id: 100,
        event: 'lock:grant:retry-me',
      });
      expect(registerAwait).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('registers an exact work-item:claimed await without binding it to a harness or loop lineage', async () => {
    await call({
      event: 'work-item:claimed:WI-41252',
      note: 'EI-21388471167237888 cross-harness claim transition',
    });

    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg).toMatchObject({
      subscriberId: 'su-awaiter',
      eventKey: 'work-item:claimed:WI-41252',
      policy: 'wake',
      note: 'EI-21388471167237888 cross-harness claim transition',
    });
    // A workspace work-item event may name the item's harness in its PAYLOAD,
    // but registration is owner-scoped and must remain deliverable when that
    // owner's active loop is bound to another harness.
    expect(arg).not.toHaveProperty('workspaceId');
    expect(arg).not.toHaveProperty('harnessSlug');
  });

  it('captures the wake handle NOW and stamps it onto the registration', async () => {
    await call({ event: 'k', plan_run_id: 5 });
    expect(captureWakeHandleForOwner).toHaveBeenCalledWith('su-awaiter', { planRunId: 5 });
    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg.wakeHandle).toMatchObject({ kind: 'adv-session' });
  });

  it('overrides: on_timeout=expire, timeout_sec, and note flow through', async () => {
    await call({ event: 'k', on_timeout: 'expire', timeout_sec: 30, note: 'why' });
    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg).toMatchObject({ timeoutBehavior: 'expire', timeoutSec: 30, note: 'why' });
  });

  it('verified mode attaches an authoritative producer certificate and derives the first deadline from cadence', async () => {
    const producerHealth = { kind: 'green-checkpoint', pipeline: 'papercusp', expected_cadence_sec: 90 };
    await call({ event: 'release:green:papercusp', producer_health: producerHealth });
    expect(resolveProducerHealthCertificate).toHaveBeenCalledWith({
      producerHealth,
      subscriberId: 'su-awaiter',
      timeoutSec: undefined,
    });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({
      timeoutBehavior: 'wake',
      timeoutSec: 90,
      producerHealthCertificate: expect.objectContaining({ producer: { kind: 'green-checkpoint', id: 'run-1' } }),
    });
  });

  it('verified mode refuses silent expiry and composed waits without changing their legacy paths', async () => {
    const producer_health = { kind: 'green-checkpoint', pipeline: 'papercusp', expected_cadence_sec: 90 };
    await expect(call({ event: 'k', producer_health, on_timeout: 'expire' })).rejects.toThrow(/requires on_timeout/);
    await expect(call({ spec: { any: [{ event: 'a' }] }, producer_health })).rejects.toThrow(/not a composed spec/);
    expect(resolveProducerHealthCertificate).not.toHaveBeenCalled();
  });

  it('registers a delegated progress lease with its cadence and authoritative certificate', async () => {
    const progressLease = {
      source_kind: 'checkpoint-revision', tool: 'work_items:get', args: { id: 'WI-1' },
      path: 'results.0.checkpoint.revision', units: 'revision', expected_cadence_sec: 60,
      owner_id: 'su-worker', remedy: { kind: 'leader-claim', workItemId: 'WI-1' },
    };
    await call({ event: 'work-item:done:WI-1', progress_lease: progressLease });
    expect(resolveProgressLeaseCertificate).toHaveBeenCalledWith(expect.objectContaining({
      progressLease, subscriberId: 'su-awaiter', workspaceId: 'ws-x', role: 'su',
    }));
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({
      timeoutSec: 60,
      producerHealthCertificate: expect.objectContaining({ producer: { kind: 'delegated-progress', id: 'lease-1' } }),
    });
  });

  it('response carries await_id / event / expires_ts / on_timeout / wake_handle', async () => {
    const out = await call({ event: 'plan-run:finished:9' });
    expect(out).toMatchObject({
      ok: true,
      await_id: 99,
      event: 'plan-run:finished:9',
      expires_ts: '2030-01-01',
      on_timeout: 'wake',
      wake_handle: 'resumable',
    });
  });

  it('P-010: a pending one-shot wake registration carries an await-wait operational brief', async () => {
    const pending: AwaitRow = {
      id: 77,
      workspaceId: 'ws',
      subscriberId: 'su-caller',
      eventKey: 'plan-run:finished:9',
      policy: 'wake',
      note: null,
      wakeHandle: null,
      timeoutBehavior: 'wake',
      expiresTs: '2099-01-01T00:00:00.000Z',
      createdAt: '2026-09-22T00:00:00.000Z',
      firedAt: null,
      firedReason: null,
      cancelledAt: null,
      cancelReason: null,
      once: true,
      minSleepSec: null,
      urgency: false,
      payloadFilter: null,
      scopeKind: null,
      scopeRef: null,
    };
    vi.mocked(registerAwait).mockResolvedValueOnce(pending);
    const out = await call({ event: 'plan-run:finished:9' });
    expect(out.operational_brief).toMatchObject({
      schemaVersion: 'operational-brief-v1',
      surface: 'await-wait',
      subject: 'plan-run:finished:9',
      deadline: { status: 'known', value: '2099-01-01T00:00:00.000Z' },
      facts: { awaitId: 77, onTimeout: 'wake', retract: 'events:cancel { await_id: 77 }' },
    });
    expect(out.operational_brief.nextAction.status).toBe('known');
  });

  // ── EI-14225: re-registration retires the caller's own prior pending await
  // on the SAME exact key (idle-park loops re-await the same key every wake). ──
  describe('EI-14225: supersede-on-registration', () => {
    it('retires the callers own prior pending await(s) on this EXACT key before registering the new one', async () => {
      await call({ event: 'work-item:claimable' });
      expect(cancelAwaitsForSubscribersOnKeys).toHaveBeenCalledWith(
        ['su-awaiter'],
        ['work-item:claimable'],
        { excludeNotePrefix: '[fleet:bench] ', onceOnly: true },
      );
      // Ordering: the retirement must run BEFORE the new row is registered (both
      // mocks recorded on the same shared timeline via invocationCallOrder).
      const supersedeOrder = vi.mocked(cancelAwaitsForSubscribersOnKeys).mock.invocationCallOrder[0];
      const registerOrder = vi.mocked(registerAwait).mock.invocationCallOrder[0];
      expect(supersedeOrder).toBeLessThan(registerOrder);
    });

    it('when a prior await was retired, the response reports `superseded` with an advice line', async () => {
      vi.mocked(cancelAwaitsForSubscribersOnKeys).mockResolvedValueOnce(2);
      const out = await call({ event: 'work-item:claimable' });
      expect(out).toMatchObject({ superseded: 2 });
      expect(out.superseded_advice).toContain('2');
    });

    it('when nothing was retired, the response omits `superseded` entirely', async () => {
      const out = await call({ event: 'lock:grant:t1' });
      expect(out).not.toHaveProperty('superseded');
      expect(out).not.toHaveProperty('superseded_advice');
    });

    it('a failed retirement is best-effort — registration still proceeds', async () => {
      vi.mocked(cancelAwaitsForSubscribersOnKeys).mockRejectedValueOnce(new Error('db hiccup'));
      const out = await call({ event: 'k' });
      expect(out).toMatchObject({ ok: true, await_id: 99 });
      expect(registerAwait).toHaveBeenCalledTimes(1);
    });
  });

  // ── P-201: pattern / macro awaits ────────────────────────────────────────
  it('a raw glob is stored as-is and flagged pattern:true in the response', async () => {
    const out = await call({ event: 'work-item:done:*' });
    expect(vi.mocked(registerAwait).mock.calls[0][0].eventKey).toBe('work-item:done:*');
    expect(out).toMatchObject({ ok: true, event: 'work-item:done:*', pattern: true });
    expect(out.advice).toContain('PATTERN');
  });

  it('@plan:<slug> expands to the plan-item glob before registering', async () => {
    await call({ event: '@plan:my-plan-2026' });
    expect(vi.mocked(registerAwait).mock.calls[0][0].eventKey).toBe('plan-item:done:my-plan-2026:*');
  });

  it('@fleet:<slug> expands to the fleet glob before registering', async () => {
    await call({ event: '@fleet:red-team' });
    expect(vi.mocked(registerAwait).mock.calls[0][0].eventKey).toBe('fleet:*:red-team');
  });

  it('an exact key is NOT flagged as a pattern', async () => {
    const out = await call({ event: 'lock:grant:t1' });
    expect(out.pattern).toBeUndefined();
  });

  // ── EI-19332682533219755: the CROSS-SCOPE PATTERN disclosure ──────────────
  // `release:green:*` reads as "MY gate went green" but the pipeline is a key
  // SEGMENT, so on a multi-pipeline host the glob silently subscribes to other
  // projects — and the foreign wake still arrives as satisfied:true.
  describe('EI-19332682533219755 — a glob that spans multiple concrete keys', () => {
    it('DISCLOSES the foreign pipeline when the glob really spans several keys', async () => {
      vi.mocked(probePatternMatchScope).mockResolvedValueOnce({
        prefix: 'release:green',
        matchedKeys: ['release:green:papercusp', 'release:green:oddsmith'],
        truncated: false,
      });
      const out = await call({ event: 'release:green:*' });

      expect(out.pattern_spans_multiple_keys).toBe(true);
      expect(out.pattern_matched_keys).toEqual(['release:green:papercusp', 'release:green:oddsmith']);
      // The advisory must NAME the foreign key — naming it is the whole fix, since
      // the incident was caught only by hand-checking a sha against the repo.
      expect(out.pattern_spans_multiple_keys_advice).toContain('release:green:oddsmith');
      expect(out.pattern_spans_multiple_keys_advice).toContain('payload_filter');
    });

    it('WARNS but still REGISTERS — cross-scope monitors are legitimate, so it never refuses', async () => {
      vi.mocked(probePatternMatchScope).mockResolvedValueOnce({
        prefix: 'release:green',
        matchedKeys: ['release:green:papercusp', 'release:green:oddsmith'],
        truncated: false,
      });
      const out = await call({ event: 'release:green:*' });

      expect(out.ok).toBe(true);
      expect(out.await_id).toBe(99);
      expect(vi.mocked(registerAwait).mock.calls[0][0].eventKey).toBe('release:green:*');
      expect(out.pattern_spans_multiple_keys_advice).toContain('not a refusal');
    });

    it('stays SILENT on a glob that covers only ONE observed key — that is what its author expected', async () => {
      vi.mocked(probePatternMatchScope).mockResolvedValueOnce({
        prefix: 'release:green',
        matchedKeys: ['release:green:papercusp'],
        truncated: false,
      });
      const out = await call({ event: 'release:green:*' });
      expect(out.pattern_spans_multiple_keys).toBeUndefined();
    });

    it('is never consulted for an EXACT key — the scoped form is the recommended fix, and must stay quiet', async () => {
      const out = await call({ event: 'release:green:papercusp' });
      expect(vi.mocked(probePatternMatchScope)).not.toHaveBeenCalled();
      expect(out.pattern_spans_multiple_keys).toBeUndefined();
    });

    it('is FAIL-SOFT: a probe that throws still registers the await', async () => {
      // withBoundedTimeout logs the degrade — expected here, so assert it rather
      // than letting vitest-fail-on-console flag it.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(probePatternMatchScope).mockRejectedValueOnce(new Error('pg down'));
      const out = await call({ event: 'release:green:*' });
      expect(out.ok).toBe(true);
      expect(out.await_id).toBe(99);
      expect(registerAwait).toHaveBeenCalledTimes(1);
      expect(out.pattern_spans_multiple_keys).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('events-await:patternScope'));
      warn.mockRestore();
    });

    it('marks a capped scan so the count reads as a floor, not a total', async () => {
      vi.mocked(probePatternMatchScope).mockResolvedValueOnce({
        prefix: 'work-item:done',
        matchedKeys: ['work-item:done:WI-1', 'work-item:done:WI-2'],
        truncated: true,
      });
      const out = await call({ event: 'work-item:done:*' });
      expect(out.pattern_spans_multiple_keys_advice).toContain('2+');
    });
  });

  it('rejects an unknown macro and a too-broad pattern (never registers)', async () => {
    await expect(call({ event: '@bogus:x' })).rejects.toThrow(/unknown pattern macro/);
    await expect(call({ event: '*' })).rejects.toThrow(/too broad/);
    expect(registerAwait).not.toHaveBeenCalled();
  });

  // ── EI-8998: predicate/payload watches ────────────────────────────────────
  it('payload_filter flows through to registerAwait; omitted defaults to null', async () => {
    const filter = { severity: { gte: 3 } };
    await call({ event: 'alert:raised', payload_filter: filter });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({ payloadFilter: filter });

    vi.clearAllMocks();
    await call({ event: 'alert:raised' });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({ payloadFilter: null });
  });

  // ── coord-authority-hardening P-006: fromMsg — resolve the gate key OFF the
  //    declaring message so the awaiter never re-types it ─────────────────────
  describe('fromMsg (P-006)', () => {
    it('resolves the single gateRef off the message and registers on that EXACT key', async () => {
      vi.mocked(getMessageById).mockResolvedValue({
        msg_id: 'm-1',
        gateRefs: [{ key: 'fleet:p2p-git:phase1-green', status: 'declared' }],
      } as never);
      const out = await call({ fromMsg: 'm-1' });
      expect(out.ok).toBe(true);
      expect(out.resolved_from_msg).toBe('m-1');
      expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({
        eventKey: 'fleet:p2p-git:phase1-green',
      });
    });

    it('msg_not_found is a loud error — nothing registered', async () => {
      vi.mocked(getMessageById).mockResolvedValue(null as never);
      const out = await call({ fromMsg: 'm-nope' });
      expect(out).toMatchObject({ ok: false, error: 'msg_not_found' });
      expect(registerAwait).not.toHaveBeenCalled();
    });

    it('a message with no gateRefs stamp is a loud no_gate_refs_on_msg', async () => {
      mockResolvedTyped(vi.mocked(getMessageById), {
        ts: '2026-01-01T00:00:00.000Z',
        msg_id: 'm-2',
        from: 'su-origin',
        to: ['su-awaiter'],
        kind: 'message',
        summary: 'prose only',
      });
      const out = await call({ fromMsg: 'm-2' });
      expect(out).toMatchObject({ ok: false, error: 'no_gate_refs_on_msg' });
      expect(registerAwait).not.toHaveBeenCalled();
    });

    it('distinguishes a coord:send expectEffect directive from a missing gateRef', async () => {
      mockResolvedTyped(vi.mocked(getMessageById), {
        ts: '2026-01-01T00:00:00.000Z',
        msg_id: 'm-effect',
        from: 'su-origin',
        to: ['su-awaiter'],
        kind: 'message',
        summary: 'checkpoint directive',
        expectEffect: { kind: 'checkpoint', itemId: 'WI-40086' },
      });
      const out = await call({ fromMsg: 'm-effect' });
      expect(out).toMatchObject({ ok: false, error: 'no_gate_refs_on_msg' });
      expect(out.advice).toContain('expectEffect directive');
      expect(out.advice).toContain('fromMsg resolves gateRefs only');
      expect(out.advice).toContain('fleet:leader-brief');
      expect(registerAwait).not.toHaveBeenCalled();
    });

    it('multiple gateRefs is ambiguous — the keys are listed for an explicit `event` await', async () => {
      vi.mocked(getMessageById).mockResolvedValue({
        msg_id: 'm-3',
        gateRefs: [
          { key: 'g-one', status: 'declared' },
          { key: 'g-two', status: 'declared' },
        ],
      } as never);
      const out = await call({ fromMsg: 'm-3' });
      expect(out).toMatchObject({ ok: false, error: 'ambiguous_gate_refs', gate_refs: ['g-one', 'g-two'] });
      expect(registerAwait).not.toHaveBeenCalled();
    });

    it('schema: event/spec/fromMsg are mutually exclusive (exactly one)', () => {
      const schema = (awaitTool as unknown as { args: { safeParse: (v: unknown) => { success: boolean } } }).args;
      expect(schema.safeParse({ event: 'k', fromMsg: 'm-1' }).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ fromMsg: 'm-1' }).success).toBe(true);
    });
  });
});

describe('P-004/D-002 — the ZERO-PARAM-FAMILY-WITH-A-SUFFIX guard', () => {
  // keyMatchesCatalog answers true for any `<family-prefix>:<anything>`, and the EI-10870
  // guard above consumes that as PROOF an emitter exists. For a family declaring NO params
  // nothing ever fires a suffixed form, so the orphan guard stayed silent on a structurally
  // dead key: 42 awaits from 6 agents, 100% timeout, ZERO real fires ever.
  it('WARNS on a suffixed key for a no-param family — and still REGISTERS it (warn, never reject)', async () => {
    const out = await call({ event: 'work-item:claimable:p2p-release-verify-lane' });

    expect(out.zero_param_family_suffix).toBe(true);
    expect(out.zero_param_family_suffix_advice).toMatch(/declares NO key params/);
    expect(out.zero_param_family_suffix_advice).toMatch(/can only TIME OUT/);
    // This family IS payloadFiltered, so the advice must name the ACTUAL fix — scope in
    // the payload, not the key. That is the mistake these six agents made.
    expect(out.zero_param_family_suffix_advice).toMatch(/payload_filter/);

    expect(out.ok).toBe(true);
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it('WARNS on the PATTERN form too — the case EVERY other registration guard skips', async () => {
    // requiredParamPrefixMismatch / the orphan probe / the announced-gate probe / the
    // done-latch are all gated on `!patternAwait`, so for a glob the ABSENCE of a warning
    // was never evidence of anything. This one is decidable from the literal head.
    const out = await call({ event: 'work-item:claimable:*' });
    expect(out.zero_param_family_suffix).toBe(true);
    expect(out.ok).toBe(true);
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it('stays SILENT on the canonical bare key (1913 awaits / 1221 real fires — the healthy path)', async () => {
    const out = await call({ event: 'work-item:claimable' });
    expect(out.zero_param_family_suffix).toBeUndefined();
    expect(out.zero_param_family_suffix_advice).toBeUndefined();
  });

  it('stays SILENT on an OPTIONAL-param family suffix — release:green:<pipeline> is a real key', async () => {
    // The plan item assumed the wildcard was itself the defect; it is not. This family
    // genuinely emits a scoped form, so neither the concrete nor the glob key is dead.
    for (const event of ['release:green:papercusp', 'release:green:*']) {
      vi.clearAllMocks();
      const out = await call({ event });
      expect(out.zero_param_family_suffix, event).toBeUndefined();
    }
  });
});

describe('EI-10870 — the ORPHAN-AWAIT guard (a key nothing emits can only ever time out)', () => {
  it('WARNS on a key with no registered emitter — and still REGISTERS it (warn, never reject)', async () => {
    // The real orphan: 14 settled awaits, 0 fires ever, appears nowhere in the tree.
    const out = await call({ event: 'overwatch:surface-landed' });

    expect(out.unknown_event_key).toBe(true);
    expect(out.unknown_event_key_advice).toMatch(/NO KNOWN EMITTER/);
    // EI-18676056143796303: the verdict must now REST on the fire history it
    // actually checked, not on an unsupportable claim about every emitter that
    // could ever exist. It says "has EVER fired" (a fact it read) and hedges the
    // consequence ("most likely only TIME OUT") — see the softening test below.
    expect(out.unknown_event_key_advice).toMatch(/has EVER fired/);
    expect(out.unknown_event_key_advice).toMatch(/most likely only TIME OUT/);
    expect(out.unknown_event_key_advice).not.toMatch(/nothing in this system will ever fire it/);

    // Fail-open: the await is still registered. A hard reject would break the
    // legitimate not-yet-catalogued cases (hand-minted pair keys, announced gates).
    expect(out.ok).toBe(true);
    expect(out.await_id).toBe(99);
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it('recognizes an active predicate-watch row as the emitter for its synthetic key', async () => {
    const event = 'predicate:watch-123';
    vi.mocked(getPredicateWatch).mockResolvedValueOnce({ eventKey: event, active: true } as never);
    vi.mocked(registerAwait).mockResolvedValueOnce({
      id: 101,
      eventKey: event,
      policy: 'wake',
      once: true,
      firedAt: null,
      cancelledAt: null,
      expiresTs: '2099-01-01T00:00:00.000Z',
      createdAt: '2026-09-22T00:00:00.000Z',
      wakeHandle: null,
      timeoutBehavior: 'wake',
    } as AwaitRow);

    const out = await call({ event });

    expect(getPredicateWatch).toHaveBeenCalledWith('watch-123');
    expect(out.unknown_event_key).toBeUndefined();
    expect(out.uncatalogued_event_key).toBeUndefined();
    expect(probeKeyFireEvidence).not.toHaveBeenCalled();
    expect(out.operational_brief.owner).toEqual({
      status: 'known',
      value: 'watch:create predicate poller',
      source: 'predicate_watches',
    });
    expect(out.operational_brief.nextAction.value).toContain('check that watch:create predicate poller is progressing');
  });

  it('does not accept a retired predicate-watch row as a live emitter', async () => {
    const event = 'predicate:watch-retired';
    vi.mocked(getPredicateWatch).mockResolvedValueOnce({ eventKey: event, active: false } as never);

    const out = await call({ event });

    expect(out.unknown_event_key).toBe(true);
    expect(probeKeyFireEvidence).toHaveBeenCalledWith(event);
  });

  it('keeps an unavailable predicate-watch registry inconclusive instead of warning orphaned', async () => {
    const event = 'predicate:watch-unreadable';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(getPredicateWatch).mockRejectedValueOnce(new Error('predicate registry unavailable'));
    vi.mocked(registerAwait).mockResolvedValueOnce({
      id: 102,
      eventKey: event,
      policy: 'wake',
      once: true,
      firedAt: null,
      cancelledAt: null,
      expiresTs: '2099-01-01T00:00:00.000Z',
      createdAt: '2026-09-22T00:00:00.000Z',
      wakeHandle: null,
      timeoutBehavior: 'wake',
    } as AwaitRow);

    const out = await call({ event });

    expect(out.unknown_event_key).toBeUndefined();
    expect(probeKeyFireEvidence).not.toHaveBeenCalled();
    expect(out.operational_brief.owner).toEqual({
      status: 'unknown',
      reason: 'predicate_watches probe error while this await was registered; emitter presence and owner are unknown',
    });
    expect(out.operational_brief.nextAction.value).toContain('do not treat this as proof that the key has no emitter');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('events-await:predicateWatchEmitter'));
    warn.mockRestore();
  });

  it('recognizes consult reply park keys as catalogued emitter-backed awaits', async () => {
    const out = await call({ event: 'consult:reply:consult-123' });

    expect(out.ok).toBe(true);
    expect(out.await_id).toBe(99);
    expect(out.unknown_event_key).toBeUndefined();
    expect(out.uncatalogued_event_key).toBeUndefined();
    expect(probeKeyFireEvidence).not.toHaveBeenCalled();
  });

  describe('EI-18676056143796303 — fire-history evidence overrides the membership verdict', () => {
    it('SUPPRESSES the orphan warning when a SIBLING key in the family has fired (the coord:inbox-wake case)', async () => {
      // The incident: an agent was woken BY coord:inbox-wake:<self>, re-registered
      // the same key to park again, and was told "nothing in this system will ever
      // fire it and this await can only TIME OUT". Believing that breaks the
      // always-armed inbox-wake — the mechanism that rescues a stranded agent.
      // Simulated here as a key the catalog does not know (a fresh owner id has no
      // exact latch row) whose FAMILY has demonstrably fired.
      vi.mocked(probeKeyFireEvidence).mockResolvedValueOnce({
        prefix: 'not-catalogued:family',
        exact: false,
        distinctKeys: 118,
        fires: 8989,
        lastFiredAt: '2026-07-25T23:28:37Z',
      });
      const out = await call({ event: 'not-catalogued:family:su-brand-new' });

      expect(out.unknown_event_key).toBeUndefined();
      expect(out.unknown_event_key_advice).toBeUndefined();
      // …and says the useful thing instead: the await is fine, the CATALOG is the bug.
      expect(out.uncatalogued_event_key).toBe(true);
      expect(out.uncatalogued_event_key_advice).toMatch(/do NOT cancel it/);
      expect(out.uncatalogued_event_key_advice).toMatch(/118 key\(s\) in its family/);
      expect(out.emitter_evidence).toMatchObject({ fires: 8989, distinctKeys: 118 });
      expect(out.await_id).toBe(99);
    });

    it('suppresses on an EXACT prior fire of this very key, and says so', async () => {
      vi.mocked(probeKeyFireEvidence).mockResolvedValueOnce({
        prefix: 'not-catalogued:thing',
        exact: true,
        distinctKeys: 1,
        fires: 3,
        lastFiredAt: '2026-07-25T23:00:00Z',
      });
      const out = await call({ event: 'not-catalogued:thing' });
      expect(out.unknown_event_key).toBeUndefined();
      expect(out.uncatalogued_event_key).toBe(true);
      expect(out.uncatalogued_event_key_advice).toMatch(/this exact key has fired/);
    });

    it('still WARNS on a genuine orphan — zero fire history keeps EI-10870 doing its job', async () => {
      // fires:0 is the mock default; assert the guard is not simply disabled.
      const out = await call({ event: 'overwatch:surface-landed' });
      expect(out.unknown_event_key).toBe(true);
      expect(out.uncatalogued_event_key).toBeUndefined();
      expect(out.emitter_evidence).toBeUndefined();
    });

    it('keeps fire-history probe failure distinct from an empty history', async () => {
      // withBoundedTimeout logs the degrade — expected here, so assert it rather
      // than letting vitest-fail-on-console flag it.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(probeKeyFireEvidence).mockRejectedValueOnce(new Error('pg down'));
      const out = await call({ event: 'overwatch:surface-landed' });
      expect(out.unknown_event_key).toBe(true);
      expect(out.fire_history_probe).toEqual({ status: 'unknown', reason: 'error' });
      expect(out.unknown_event_key_advice).toMatch(/prior fire history could not be checked/i);
      expect(out.unknown_event_key_advice).not.toMatch(/has EVER fired/i);
      expect(out.ok).toBe(true);
      expect(registerAwait).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('events-await:keyFireEvidence'));
      warn.mockRestore();
    });

    it('does not even probe the latch for a CATALOGUED key (no cost on the happy path)', async () => {
      vi.mocked(probeKeyFireEvidence).mockClear();
      await call({ event: 'coord:inbox-wake:su-someone' });
      expect(probeKeyFireEvidence).not.toHaveBeenCalled();
    });
  });

  it('stays SILENT on a real catalogued key — no false alarm on the happy path', async () => {
    const out = await call({ event: 'release:green:papercusp' });
    expect(out.unknown_event_key).toBeUndefined();
    expect(out.unknown_event_key_advice).toBeUndefined();
    expect(out.await_id).toBe(99);
  });

  it('keeps a catalog probe failure distinct from confirmed absence in the pending wait brief', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(readInstalledUnitEvents).mockRejectedValueOnce(new Error('catalog read failed'));
    vi.mocked(registerAwait).mockResolvedValueOnce({
      id: 99,
      workspaceId: 'ws-x',
      subscriberId: 'su-awaiter',
      eventKey: 'release:green:papercusp',
      policy: 'wake',
      note: null,
      wakeHandle: { kind: 'adv-session', advSessionId: 1, agent: 'claude', sessionId: 's', ompThreadId: null, cwd: '/r', pid: 1 },
      timeoutBehavior: 'wake',
      expiresTs: '2030-01-01T00:00:00.000Z',
      createdAt: '2026-09-22T00:00:00.000Z',
      firedAt: null,
      firedReason: null,
      cancelledAt: null,
      cancelReason: null,
      once: true,
      minSleepSec: null,
      urgency: false,
      payloadFilter: null,
      scopeKind: null,
      scopeRef: null,
    } as AwaitRow);

    const out = await call({ event: 'release:green:papercusp' });

    expect(out.ok).toBe(true);
    expect(out.await_id).toBe(99);
    expect(out.unknown_event_key).toBeUndefined();
    expect(out.unknown_event_key_advice).toBeUndefined();
    expect(out.operational_brief.owner).toEqual({
      status: 'unknown',
      reason: 'events:catalog probe error while this await was registered; emitter presence and owner are unknown',
    });
    expect(out.operational_brief.blockers.value).toContain('events:catalog probe error; emitter presence is unverified');
    expect(out.operational_brief.nextAction.value).toContain(
      'do not treat this as proof that the key has no emitter',
    );
    expect(out.operational_brief.nextAction.value).not.toMatch(/^Nothing is known to fire/);
    expect(registerAwait).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('events-await:orphanKey'));
    warn.mockRestore();
  });

  it('stays silent on a PATTERN await (a glob is not a key and has no single emitter)', async () => {
    const out = await call({ event: 'work-item:done:*' });
    expect(out.pattern).toBe(true);
    expect(out.unknown_event_key).toBeUndefined();
  });

  it('does NOT warn on a key declared by an INSTALLED pack (the false-positive that would train the warning out)', async () => {
    vi.mocked(readInstalledUnitEvents).mockResolvedValueOnce([
      {
        unit: 'my-pack',
        events: [
          {
            family: 'my-pack',
            keyTemplate: 'my-pack:thing-happened:<id>',
            params: [{ name: 'id', required: true }],
            describe: 'a pack-declared event',
            emitter: 'my-pack',
          },
        ],
      },
    ] as never);

    const out = await call({ event: 'my-pack:thing-happened:42' });
    expect(out.unknown_event_key).toBeUndefined();
  });

  it('stays SILENT when the installed tier cannot be confirmed — an unverifiable claim is worse than no warning', async () => {
    // Discovery throws ⇒ withBoundedTimeout degrades to the null fallback ⇒ we cannot
    // prove the key is an orphan ⇒ say nothing (and never break the registration).
    // The degradation IS logged (a cold plugin host should be visible in the logs) —
    // assert that explicitly rather than let it leak past fail-on-console.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(readInstalledUnitEvents).mockRejectedValueOnce(new Error('plugin host cold'));

    const out = await call({ event: 'overwatch:surface-landed' });
    expect(out.unknown_event_key).toBeUndefined();
    expect(out.ok).toBe(true);
    expect(out.await_id).toBe(99); // the await still registers — the guard is advisory
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('events-await:orphanKey'));
    warn.mockRestore();
  });
});

describe('WI-1632193 — a DECLARED announced gate is legitimate even when no catalog family matches', () => {
  // The gap this closes is narrow and exact. `announcedGate` (await.ts) is set only
  // from an UNFIRED, non-superseded declaration, so a key whose declarations have all
  // been superseded — or fired for a reason other than 'event' — falls through to the
  // orphan guard and is told "NO KNOWN EMITTER". Since WI-1632193 the catalog no
  // longer MATCHES `plan:<slug>:<gate>` either (the announcedShape row is documented,
  // never matched), so without this check a real declared plan gate would be warned
  // about — the EI-21666331086562886 failure, in a louder form.
  // A COMPLETE AwaitRow with a Partial override seam, so the fixture genuinely
  // typechecks against the real store signature rather than being cast past it —
  // a stale `as never` fixture goes red at the fleet green-checkpoint, in a file
  // whoever is waiting on that deploy never touched.
  const supersededRow = (overrides: Partial<AwaitRow> = {}): AwaitRow => ({
    id: 7,
    workspaceId: 'default',
    subscriberId: 'su-declarer',
    eventKey: 'plan:my-plan:sidecar-released',
    policy: 'announce',
    note: null,
    wakeHandle: null,
    timeoutBehavior: 'expire',
    expiresTs: null,
    createdAt: '2026-08-30T00:00:00.000Z',
    firedAt: '2026-08-30T00:00:00.000Z',
    firedReason: 'superseded', // NOT 'event' ⇒ not a latch, and not unfired ⇒ not announcedGate
    cancelledAt: null,
    cancelReason: null,
    once: true,
    minSleepSec: null,
    urgency: false,
    payloadFilter: null,
    scopeKind: 'plan',
    scopeRef: 'my-plan',
    causalGeneration: 1,
    ...overrides,
  });

  /** Only the includeSuperseded read sees history — exactly how the real store behaves. */
  const withDeclarationHistory = (rows: AwaitRow[]) =>
    mockImplementationTyped(vi.mocked(findAnnouncementsForKey), async (_key, opts) =>
      opts?.includeSuperseded ? rows : [],
    );

  // A persistent mockImplementation SURVIVES the suite-level vi.clearAllMocks() (that
  // clears calls, not implementations), unlike the mockResolvedValueOnce the
  // neighbouring describes use — so without this it leaks into every later test in the
  // file and breaks them somewhere the failure looks unrelated.
  afterEach(() => {
    mockImplementationTyped(vi.mocked(findAnnouncementsForKey), async () => []);
  });

  it('clears the orphan warning and says the gate is DECLARED', async () => {
    withDeclarationHistory([supersededRow()]);
    const out = await call({ event: 'plan:my-plan:sidecar-released' });

    expect(out.unknown_event_key).toBeUndefined();
    expect(out.unknown_event_key_advice).toBeUndefined();
    expect(out.declared_announced_gate).toBe(true);
    expect(out.declared_announced_gate_advice).toMatch(/HAS been declared/);
    // It must NOT masquerade as the uncatalogued-but-firing case: there is no catalog
    // gap to file for a runtime-minted key, and telling an agent to file one is noise.
    expect(out.uncatalogued_event_key).toBeUndefined();
    expect(out.ok).toBe(true);
  });

  it('prior fire evidence does not outrank a fired fleet announcement (EI-22729480686353796)', async () => {
    const eventKey = 'fleet:nonp2p-bug-drain-luna-max-50:owner-resume';
    withDeclarationHistory([
      supersededRow({
        eventKey,
        scopeKind: 'fleet',
        scopeRef: 'nonp2p-bug-drain-luna-max-50',
        firedAt: '2026-09-08T22:03:34.810Z',
        firedReason: 'event',
        supersededAt: '2026-09-09T00:00:00.000Z',
      }),
    ]);
    const out = await call({ event: eventKey });

    expect(out).toMatchObject({ ok: true, declared_announced_gate: true });
    expect(out.declared_announced_gate_advice).toMatch(/previous generation has already fired/);
    expect(out.unknown_event_key).toBeUndefined();
    expect(out.uncatalogued_event_key).toBeUndefined();
    expect(out.emitter_evidence).toBeUndefined();
    expect(probeKeyFireEvidence).not.toHaveBeenCalled();
  });

  it('THE POINT — a TYPO of a sibling family is still warned about, because it was never declared', async () => {
    // `plan:draft-redy:x` is a typo of `plan-draft-ready` (`plan:draft-ready:<slug>`).
    // It is structurally identical to the real gate above — same namespace, same
    // segment count — so nothing but the declaration registry can tell them apart.
    // This is the assertion WI-1632193 exists for; it FAILED while the `plan-event`
    // family still matched, because the catalog answered "yes, catalogued" for it.
    withDeclarationHistory([]); // nothing was ever declared under this key
    const out = await call({ event: 'plan:draft-redy:x' });

    expect(out.declared_announced_gate).toBeUndefined();
    expect(out.unknown_event_key).toBe(true);
    expect(out.unknown_event_key_advice).toMatch(/NO KNOWN EMITTER/);
    expect(out.ok).toBe(true); // warn, never reject
  });

  it('FAIL-SOFT — an unavailable declaration read leaves the warning exactly as it was', async () => {
    // Every probe in this handler is fail-soft on purpose: an unreadable source must
    // never manufacture a reassurance, which would be the orphan guard going quiet
    // for the one reason nobody can see.
    mockImplementationTyped(vi.mocked(findAnnouncementsForKey), async (_key, opts) => {
      if (opts?.includeSuperseded) throw new Error('store unavailable');
      return [];
    });
    // withBoundedTimeout reports the swallowed rejection; assert it rather than
    // silencing it, so "fail-soft" cannot quietly become "fails silently".
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await call({ event: 'plan:my-plan:sidecar-released' });
    expect(out.declared_announced_gate).toBeUndefined();
    expect(out.unknown_event_key).toBe(true);
    expect(out.ok).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('EI-18701276960172209 — a self-declared gate with no known emitter is not automatically legitimate', () => {
  const declaredRow = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    subscriberId: 'su-declarer',
    eventKey: 'green-gate-verdict',
    firedAt: null,
    firedReason: null,
    causalGeneration: 1,
    expectedCondition: null,
    note: 'waiting on green-checkpoint',
    ...overrides,
  });

  it('the live incident: an announced gate matching no catalog family AND never fired gets no_known_emitter + a catalog near-miss suggestion', async () => {
    vi.mocked(findAnnouncementsForKey).mockResolvedValueOnce([declaredRow()] as never);
    // probeKeyFireEvidence default mock already returns fires:0 (no evidence).
    const out = await call({ event: 'green-gate-verdict' });

    expect(out.announced_gate).toMatchObject({ announcedBy: 'su-declarer' });
    expect(out.no_known_emitter).toBe(true);
    expect(out.no_known_emitter_advice).toMatch(/does NOT guarantee anything ever will/);
    expect(out.catalog_near_miss).toEqual(expect.arrayContaining(['release:green', 'green-checkpoint:red']));
    expect(out.no_known_emitter_advice).toMatch(/release:green/);

    // Still registers — advisory only, never a refusal.
    expect(out.ok).toBe(true);
    expect(out.await_id).toBe(99);
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it('does NOT warn when the announced key genuinely matches a catalog family (a legitimate pair-emit gate on a real key)', async () => {
    vi.mocked(findAnnouncementsForKey).mockResolvedValueOnce([
      declaredRow({ eventKey: 'release:green:my-pipeline' }),
    ] as never);
    const out = await call({ event: 'release:green:my-pipeline' });
    expect(out.no_known_emitter).toBeUndefined();
    expect(out.catalog_near_miss).toBeUndefined();
  });

  it('does NOT warn when the announced key has real fire history even though it is uncatalogued (EI-18676056143796303 evidence still wins)', async () => {
    vi.mocked(findAnnouncementsForKey).mockResolvedValueOnce([declaredRow()] as never);
    vi.mocked(probeKeyFireEvidence).mockResolvedValueOnce({
      prefix: 'green-gate-verdict',
      exact: true,
      distinctKeys: 1,
      fires: 2,
      lastFiredAt: '2026-07-25T00:00:00Z',
    });
    const out = await call({ event: 'green-gate-verdict' });
    expect(out.no_known_emitter).toBeUndefined();
  });

  it('does NOT warn when the current declaration still has a live owner, even without catalog or fire evidence', async () => {
    vi.mocked(findAnnouncementsForKey).mockResolvedValueOnce([
      declaredRow({ boundTo: { kind: 'role', ref: 'release-fixer' } }),
    ] as never);
    vi.mocked(resolveAnnouncementOwnership).mockResolvedValueOnce(
      new Map([
        [1, { declaredByLiveness: 'live', liveSuccessorIds: [], staleOwner: false }],
      ]),
    );

    const out = await call({ event: 'green-gate-verdict' });

    expect(out.no_known_emitter).toBeUndefined();
    expect(out.announced_gate_ownership).toEqual({
      declared_by_liveness: 'live',
      live_successor_ids: [],
    });
    expect(out.ok).toBe(true);
    expect(out.await_id).toBe(99);
  });

  it('does NOT warn when a stale declarer has a live bound successor', async () => {
    vi.mocked(findAnnouncementsForKey).mockResolvedValueOnce([
      declaredRow({ boundTo: { kind: 'fleet-leadership', ref: 'release-fleet' } }),
    ] as never);
    vi.mocked(resolveAnnouncementOwnership).mockResolvedValueOnce(
      new Map([
        [1, { declaredByLiveness: 'ended', liveSuccessorIds: ['su-successor'], staleOwner: false }],
      ]),
    );

    const out = await call({ event: 'green-gate-verdict' });

    expect(out.no_known_emitter).toBeUndefined();
    expect(out.announced_gate_ownership).toEqual({
      declared_by_liveness: 'ended',
      live_successor_ids: ['su-successor'],
    });
    expect(out.ok).toBe(true);
    expect(out.await_id).toBe(99);
  });

  it('does NOT call a current declaration an unknown emitter when a superseded generation fired', async () => {
    vi.mocked(findAnnouncementsForKey)
      .mockResolvedValueOnce([declaredRow({ causalGeneration: 2 })] as never)
      .mockResolvedValueOnce([
        declaredRow({ causalGeneration: 2 }),
        declaredRow({ causalGeneration: 1, firedAt: '2026-08-15T04:21:58.341Z', firedReason: 'event' }),
      ] as never);
    // Simulate the filed incident's missing/empty unconditional fire-latch evidence.
    vi.mocked(probeKeyFireEvidence).mockResolvedValueOnce({
      prefix: 'green-gate-verdict',
      exact: false,
      distinctKeys: 0,
      fires: 0,
      lastFiredAt: null,
    });

    const out = await call({ event: 'green-gate-verdict' });

    expect(out.announced_gate).toMatchObject({ generation: 2 });
    expect(out.already_fired).toBeUndefined();
    expect(out.no_known_emitter).toBeUndefined();
    expect(out.ok).toBe(true);
    expect(out.await_id).toBe(99);
  });

  it('does NOT warn on an ALREADY-FIRED gate (that path returns already_fired and never reaches this check)', async () => {
    vi.mocked(findAnnouncementsForKey).mockResolvedValueOnce([
      declaredRow({ firedAt: '2026-07-26T09:53:00Z', firedReason: 'event' }),
    ] as never);
    const out = await call({ event: 'green-gate-verdict' });
    expect(out.already_fired).toBe(true);
    expect(out.no_known_emitter).toBeUndefined();
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it('is advisory-only, never blocking — still registers when there is no catalog near-miss at all', async () => {
    vi.mocked(findAnnouncementsForKey).mockResolvedValueOnce([
      declaredRow({ eventKey: 'totally-invented-key-xyz' }),
    ] as never);
    const out = await call({ event: 'totally-invented-key-xyz' });
    expect(out.no_known_emitter).toBe(true);
    expect(out.catalog_near_miss).toBeUndefined();
    expect(out.no_known_emitter_advice).not.toMatch(/Possible near-miss/);
    expect(out.ok).toBe(true);
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it('is fail-soft: a discovery timeout leaves no_known_emitter unset rather than a false claim', async () => {
    vi.mocked(findAnnouncementsForKey).mockResolvedValueOnce([declaredRow()] as never);
    vi.mocked(readInstalledUnitEvents).mockRejectedValueOnce(new Error('plugin host cold'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await call({ event: 'green-gate-verdict' });
    expect(out.no_known_emitter).toBeUndefined();
    expect(out.ok).toBe(true);
    warn.mockRestore();
  });

  it('passes the authenticated announcement generation into registerAwait', async () => {
    const eventKey = 'release:green:my-pipeline';
    vi.mocked(findAnnouncementsForKey).mockResolvedValueOnce([
      declaredRow({ eventKey, causalGeneration: 2 }),
    ] as never);

    const out = await call({ event: eventKey, after_generation: 2 });

    expect(out).toMatchObject({ ok: true, await_id: 99 });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({
      eventKey,
      expectedGeneration: 2,
    });
  });

  it('returns already_fired when the authenticated generation fires during registration', async () => {
    const eventKey = 'release:green:my-pipeline';
    vi.mocked(findAnnouncementsForKey).mockResolvedValueOnce([
      declaredRow({ eventKey, causalGeneration: 2 }),
    ] as never);
    vi.mocked(registerAwait).mockRejectedValueOnce(
      Object.assign(new Error('generation fired during registration'), {
        code: 'await_generation_mismatch',
        eventKey,
        expectedGeneration: 2,
        currentGeneration: 2,
        currentState: 'fired',
        firedAt: '2026-08-25T20:30:00.000Z',
      }),
    );

    const out = await call({ event: eventKey, after_generation: 2 });

    expect(out).toMatchObject({
      ok: true,
      already_fired: true,
      event: eventKey,
      generation: 2,
      fired_at: '2026-08-25T20:30:00.000Z',
    });
    expect(out.error).toBeUndefined();
  });

  it('returns a structured resync when registration observes a different generation', async () => {
    const eventKey = 'release:green:my-pipeline';
    vi.mocked(findAnnouncementsForKey).mockResolvedValueOnce([
      declaredRow({ eventKey, causalGeneration: 2 }),
    ] as never);
    vi.mocked(registerAwait).mockRejectedValueOnce(
      Object.assign(new Error('generation replaced during registration'), {
        code: 'await_generation_mismatch',
        eventKey,
        expectedGeneration: 2,
        currentGeneration: 3,
        currentState: 'declared',
      }),
    );

    const out = await call({ event: eventKey, after_generation: 2 });

    expect(out).toMatchObject({
      ok: false,
      error: 'await_generation_mismatch',
      event: eventKey,
      expected_generation: 2,
      current_generation: 3,
      current_state: 'declared',
      resync: {
        required: true,
        reason: 'consumer_behind',
        authoritative_generation: 3,
      },
    });
    expect(out.already_fired).toBeUndefined();
  });

  it('preserves a cancelled generation in the stale-pin response and requires a fresh declaration', async () => {
    const eventKey = 'fleet:nonp2p-bug-drain-luna-max-50:owner-resume';
    vi.mocked(findAnnouncementsForKey).mockResolvedValueOnce([
      {
        eventKey,
        causalGeneration: 2,
        firedAt: null,
        firedReason: null,
        cancelledAt: '2026-09-08T22:03:00.000Z',
        supersededAt: null,
      },
    ] as never);

    const out = await call({ event: eventKey, after_generation: 2 });

    expect(findAnnouncementsForKey).toHaveBeenCalledWith(eventKey, { includeCancelled: true });
    expect(out).toMatchObject({
      ok: false,
      error: 'await_generation_mismatch',
      event: eventKey,
      expected_generation: 2,
      current_generation: 2,
      current_state: 'cancelled',
      resync: {
        required: true,
        reason: 'current_not_waitable',
        authoritative_generation: 2,
        next_verb: `events:status { event: "${eventKey}" }`,
      },
    });
    expect(out.advice).toMatch(/cancelled and is not waitable/);
    expect(out.advice).toMatch(/fresh declared generation/);
    expect(registerAwait).not.toHaveBeenCalled();
  });
});

describe('EI-13089 — the FAMILY-PREFIX-MISSING-REQUIRED-PARAM guard', () => {
  it('WARNS on a bare family prefix whose required param was dropped — and still REGISTERS it (warn, never reject)', async () => {
    // work-item:done:<id> — id is REQUIRED; nothing ever fires the bare 'work-item:done'.
    const out = await call({ event: 'work-item:done' });

    expect(out.family_prefix_missing_param).toBe(true);
    expect(out.family_prefix_missing_param_advice).toMatch(/FAMILY PREFIX for 'work-item-done'/);
    expect(out.family_prefix_missing_param_advice).toMatch(/can only TIME OUT/);
    expect(out.family_prefix_missing_param_advice).toMatch(/work-item:done:\*/);

    // Fail-open: still registers, same policy as the orphan-key guard.
    expect(out.ok).toBe(true);
    expect(out.await_id).toBe(99);
    expect(registerAwait).toHaveBeenCalledTimes(1);
    // The false-positive orphan warning must NOT ALSO fire — keyMatchesCatalog still
    // reports this key as "known" (it's a real family prefix), just not fireable bare.
    expect(out.unknown_event_key).toBeUndefined();
  });

  it('stays SILENT on an OPTIONAL-param family bare prefix — that key really does fire (buildKey collapse rule)', async () => {
    const out = await call({ event: 'release:deployed' });
    expect(out.family_prefix_missing_param).toBeUndefined();
    expect(out.family_prefix_missing_param_advice).toBeUndefined();
  });

  it('stays SILENT on the fully-interpolated concrete key', async () => {
    const out = await call({ event: 'work-item:done:WI-4528' });
    expect(out.family_prefix_missing_param).toBeUndefined();
  });

  it('stays silent on a PATTERN await (a glob already covers "any instance")', async () => {
    const out = await call({ event: 'work-item:done:*' });
    expect(out.family_prefix_missing_param).toBeUndefined();
  });
});

describe('the done-key registration LATCH (EI-13095 — the WI-5075 stranded-await incident)', () => {
  it('awaiting work-item:done:<id> for an ALREADY-settled item answers already_done and registers NOTHING', async () => {
    vi.mocked(liveSettledProbe).mockResolvedValueOnce({ verdict: 'settled', itemState: 'resolved' });
    const out = await call({ event: 'work-item:done:WI-5075' });
    expect(out).toMatchObject({ ok: true, already_done: true, event: 'work-item:done:WI-5075', item_state: 'resolved' });
    expect(out.advice).toContain('Do not wait');
    expect(registerAwait).not.toHaveBeenCalled();
    expect(liveSettledProbe).toHaveBeenCalledWith('WI-5075');
  });

  it('reconciles a completion that races the await registration', async () => {
    vi.mocked(liveSettledProbe)
      .mockResolvedValueOnce({ verdict: 'live', itemState: 'wip' })
      .mockResolvedValueOnce({ verdict: 'settled', itemState: 'resolved' });
    vi.mocked(cancelAwait).mockResolvedValueOnce(true);
    const out = await call({ event: 'work-item:done:WI-race' });
    expect(out).toMatchObject({ ok: true, already_done: true, event: 'work-item:done:WI-race' });
    expect(registerAwait).toHaveBeenCalledTimes(1);
    expect(cancelAwait).toHaveBeenCalledWith({ awaitId: 99, subscriberId: 'su-awaiter' });
  });

  it('a LIVE item registers exactly as before (the latch only answers on settled)', async () => {
    const out = await call({ event: 'work-item:done:WI-42' });
    expect(out.already_done).toBeUndefined();
    expect(out.await_id).toBe(99);
    expect(vi.mocked(registerAwait).mock.calls[0][0].eventKey).toBe('work-item:done:WI-42');
  });

  it('an UNKNOWN probe (unreadable/ambiguous id) fails OPEN — the registration proceeds', async () => {
    vi.mocked(liveSettledProbe).mockResolvedValueOnce({ verdict: 'unknown' });
    const out = await call({ event: 'work-item:done:WI-404' });
    expect(out.already_done).toBeUndefined();
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it('a PATTERN await (work-item:done:*) never probes — patterns can always match a future key', async () => {
    const out = await call({ event: 'work-item:done:*' });
    expect(liveSettledProbe).not.toHaveBeenCalled();
    expect(out.pattern).toBe(true);
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it('non-done keys never probe (no per-registration tax on unrelated awaits)', async () => {
    await call({ event: 'lock:grant:t9' });
    expect(liveSettledProbe).not.toHaveBeenCalled();
  });
});

describe('the unblocked-key registration LATCH (P-006 / EI-21581161723225407)', () => {
  it('REFUSES a lifecycle-blocked target with no dependency edges because the edge-only key cannot fire', async () => {
    vi.mocked(liveBlockedState).mockResolvedValueOnce({
      verdict: 'blocked',
      lifecycleState: 'blocked',
      dependencyState: 'unblocked',
    });

    const out = await call({ event: 'work-item:unblocked:WI-42218' });

    expect(out).toMatchObject({
      ok: false,
      error: 'unfirable_work_item_unblocked',
      firable: false,
      event: 'work-item:unblocked:WI-42218',
      work_item_id: 'WI-42218',
      item_state: 'blocked',
      lifecycle_state: 'blocked',
      dependency_state: 'unblocked',
    });
    expect(out.advice).toContain('NO live blocker dependency edge');
    expect(out.advice).toContain('nothing was registered');
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it('still registers when a live blocker dependency edge can fire the key', async () => {
    vi.mocked(liveBlockedState).mockResolvedValueOnce({
      verdict: 'blocked',
      lifecycleState: 'open',
      dependencyState: 'blocked',
    });

    const out = await call({ event: 'work-item:unblocked:WI-42218' });

    expect(out).toMatchObject({
      ok: true,
      await_id: 99,
      event: 'work-item:unblocked:WI-42218',
      item_state: 'open',
      lifecycle_state: 'open',
      dependency_state: 'blocked',
    });
    expect(out.error).toBeUndefined();
    expect(vi.mocked(registerAwait).mock.calls[0][0].eventKey).toBe('work-item:unblocked:WI-42218');
  });
});

describe('the plan-item-done registration LATCH (EI-18734910825871393 — the 76s-late-registration race)', () => {
  it('awaiting plan-item:done:<slug>:<id> for an ALREADY-done item answers already_done and registers NOTHING', async () => {
    vi.mocked(planItemEffectiveStatus).mockResolvedValueOnce('done');
    const out = await call({ event: 'plan-item:done:retire-work-item-mail-surface-2026-07-26:P-008' });
    expect(out).toMatchObject({
      ok: true,
      already_done: true,
      event: 'plan-item:done:retire-work-item-mail-surface-2026-07-26:P-008',
      item_state: 'done',
    });
    expect(out.advice).toContain('Do not wait');
    expect(registerAwait).not.toHaveBeenCalled();
    expect(planItemEffectiveStatus).toHaveBeenCalledWith('papercup', 'retire-work-item-mail-surface-2026-07-26', 'P-008');
  });

  it('reconciles a plan item done edge that races its registration', async () => {
    vi.mocked(planItemEffectiveStatus).mockResolvedValueOnce('wip').mockResolvedValueOnce('done');
    vi.mocked(cancelAwait).mockResolvedValueOnce(true);
    const out = await call({ event: 'plan-item:done:my-plan:P-3' });
    expect(out).toMatchObject({ ok: true, already_done: true, event: 'plan-item:done:my-plan:P-3' });
    expect(cancelAwait).toHaveBeenCalledWith({ awaitId: 99, subscriberId: 'su-awaiter' });
  });

  it('a TODO/WIP item registers exactly as before (the latch only answers on done)', async () => {
    vi.mocked(planItemEffectiveStatus).mockResolvedValueOnce('wip');
    const out = await call({ event: 'plan-item:done:my-plan:P-3' });
    expect(out.already_done).toBeUndefined();
    expect(out.await_id).toBe(99);
    expect(vi.mocked(registerAwait).mock.calls[0][0].eventKey).toBe('plan-item:done:my-plan:P-3');
  });

  it('a DROPPED item is NOT treated as already_done (the done-event never fires for it, so it must keep waiting to the timeout)', async () => {
    vi.mocked(planItemEffectiveStatus).mockResolvedValueOnce('dropped');
    const out = await call({ event: 'plan-item:done:my-plan:P-4' });
    expect(out.already_done).toBeUndefined();
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it('an UNDETERMINABLE probe (null — missing plan/item) fails OPEN — the registration proceeds', async () => {
    vi.mocked(planItemEffectiveStatus).mockResolvedValueOnce(null);
    const out = await call({ event: 'plan-item:done:my-plan:P-404' });
    expect(out.already_done).toBeUndefined();
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it('a PATTERN await (plan-item:done:my-plan:*) never probes — patterns can always match a future key', async () => {
    const out = await call({ event: 'plan-item:done:my-plan:*' });
    expect(planItemEffectiveStatus).not.toHaveBeenCalled();
    expect(out.pattern).toBe(true);
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it('non-plan-item-done keys never probe (no per-registration tax on unrelated awaits)', async () => {
    await call({ event: 'lock:grant:t9' });
    expect(planItemEffectiveStatus).not.toHaveBeenCalled();
  });
});

describe('the SELF-AWAIT guard (EI-18731480441007330 — the WI-6095 unbreakable self-deadlock incident)', () => {
  it('REFUSES a work-item:status:<id> await when the caller is the item\'s own current assignee', async () => {
    vi.mocked(liveAssigneeProbe).mockResolvedValueOnce({ verdict: 'live', assignee: 'su-awaiter' });
    const out = await call({ event: 'work-item:status:WI-6095' });
    expect(out).toMatchObject({ ok: false, error: 'self_await_deadlock', event: 'work-item:status:WI-6095', work_item_id: 'WI-6095' });
    expect(out.advice).toContain('CURRENT ASSIGNEE');
    expect(registerAwait).not.toHaveBeenCalled();
    expect(liveAssigneeProbe).toHaveBeenCalledWith('WI-6095');
  });

  it('REFUSES a work-item:done:<id> await when the caller is the item\'s own current assignee', async () => {
    vi.mocked(liveAssigneeProbe).mockResolvedValueOnce({ verdict: 'live', assignee: 'su-awaiter' });
    const out = await call({ event: 'work-item:done:WI-6095' });
    expect(out).toMatchObject({ ok: false, error: 'self_await_deadlock', event: 'work-item:done:WI-6095', work_item_id: 'WI-6095' });
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it('REFUSES a claim:released:<id> await when the caller still holds the item claim', async () => {
    vi.mocked(liveAssigneeProbe).mockResolvedValueOnce({ verdict: 'live', assignee: 'su-awaiter' });
    const out = await call({ event: 'claim:released:WI-6095' });
    expect(out).toMatchObject({ ok: false, error: 'self_await_deadlock', event: 'claim:released:WI-6095', work_item_id: 'WI-6095' });
    expect(out.advice).toContain('CURRENT ASSIGNEE');
    expect(registerAwait).not.toHaveBeenCalled();
    expect(liveAssigneeProbe).toHaveBeenCalledWith('WI-6095');
  });

  it('a DIFFERENT assignee (a legitimate wait on a peer\'s work) registers exactly as before', async () => {
    vi.mocked(liveAssigneeProbe).mockResolvedValueOnce({ verdict: 'live', assignee: 'su-someone-else' });
    const out = await call({ event: 'work-item:status:WI-6095' });
    expect(out.error).toBeUndefined();
    expect(out.await_id).toBe(99);
    expect(vi.mocked(registerAwait).mock.calls[0][0].eventKey).toBe('work-item:status:WI-6095');
  });

  it('an already-SETTLED item never refuses (no deadlock risk — the key already fired or never will)', async () => {
    vi.mocked(liveAssigneeProbe).mockResolvedValueOnce({ verdict: 'settled', assignee: 'su-awaiter' });
    const out = await call({ event: 'work-item:status:WI-6095' });
    expect(out.error).toBeUndefined();
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it('an UNKNOWN probe (unreadable/ambiguous id) fails OPEN — the registration proceeds', async () => {
    vi.mocked(liveAssigneeProbe).mockResolvedValueOnce({ verdict: 'unknown' });
    const out = await call({ event: 'work-item:status:WI-9999' });
    expect(out.error).toBeUndefined();
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it('a PATTERN await never probes (no single id to check)', async () => {
    const out = await call({ event: 'work-item:status:*' });
    expect(liveAssigneeProbe).not.toHaveBeenCalled();
    expect(out.pattern).toBe(true);
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it('unrelated keys never probe (no per-registration tax on non-work-item awaits)', async () => {
    await call({ event: 'lock:grant:t9' });
    expect(liveAssigneeProbe).not.toHaveBeenCalled();
  });
});

describe('EI-383 — extend the caller\'s plan-item claim leases to survive the sleep', () => {
  it('an ACTUAL registration extends claims sized to the resolved timeout_sec', async () => {
    await call({ event: 'lock:grant:t9', timeout_sec: 3600 });
    expect(extendOwnerClaimsForAwait).toHaveBeenCalledTimes(1);
    expect(extendOwnerClaimsForAwait).toHaveBeenCalledWith('ws-x', 'su-awaiter', 3600);
  });

  it('no timeout_sec passed → extends using the shared default', async () => {
    await call({ event: 'lock:grant:t9' });
    expect(extendOwnerClaimsForAwait).toHaveBeenCalledWith('ws-x', 'su-awaiter', AWAIT_DEFAULT_TIMEOUT_SEC);
  });

  it('an already-settled/no-sleep short-circuit does NOT extend anything (no real sleep happens)', async () => {
    vi.mocked(liveSettledProbe).mockResolvedValueOnce({ verdict: 'settled', itemState: 'resolved' });
    const out = await call({ event: 'work-item:done:WI-5075' });
    expect(out.already_done).toBe(true);
    expect(extendOwnerClaimsForAwait).not.toHaveBeenCalled();
  });

  it('a claim-extension failure never blocks or fails the await registration (best-effort)', async () => {
    vi.mocked(extendOwnerClaimsForAwait).mockRejectedValueOnce(new Error('db unreachable'));
    const out = await call({ event: 'lock:grant:t9' });
    expect(out.ok).toBe(true);
    expect(out.await_id).toBe(99);
  });
});

describe('EI-13846 — default the `work-item:claimable` payload_filter to the caller\'s own claim spec', () => {
  it('an explicit payload_filter always wins — the claim-spec lookup is reconciliation-only, never auto-scopes over it', async () => {
    const filter = { kind: { equals: 'feature' } };
    await call({ event: 'work-item:claimable', payload_filter: filter });
    expect(getClaimSpecRecord).toHaveBeenCalledWith({ cupId: 'su-awaiter', workspaceId: 'ws-x' });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({ payloadFilter: filter });
  });

  it('a fleet-scoped caller with a narrowable spec gets it auto-applied as the default payload_filter', async () => {
    vi.mocked(getClaimSpecRecord).mockResolvedValueOnce({
      source: 'fleet',
      spec: { specId: 'bug-drain-200k', revision: 2, view: { filter: { field: 'kind', op: '=', value: 'bug' } } } as never,
      revision: 2,
      updatedBy: 'su-leader',
      updatedAt: '2026-07-19T00:00:00Z',
      harnessSlug: 'papercusp',
      fleetSlug: 'bug-drain-200k',
    });
    const out = await call({ event: 'work-item:claimable' });
    expect(getClaimSpecRecord).toHaveBeenCalledWith({ cupId: 'su-awaiter', workspaceId: 'ws-x' });
    // EI-18674502503888023: the filter-tree derivation alone can never carry `harness` (it is
    // not spec vocabulary — see claim-spec.ts ITEM_FIELDS), so the record's own harnessSlug
    // column must be ANDed in explicitly, or a same-kind item from ANY OTHER harness in the
    // workspace would satisfy this "scoped" await.
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({
      payloadFilter: { all: [{ kind: { equals: 'bug' } }, { harness: { equals: 'papercusp' } }] },
    });
    expect(out.auto_scoped_payload_filter).toBe(true);
    expect(out.payload_filter_source).toMatchObject({ source: 'fleet', specId: 'bug-drain-200k', revision: 2 });
    expect(out.unscoped_claimable_await).toBeUndefined();
  });

  it('warns that an auto-scoped payload filter is a claimability hint, not a floor guarantee', async () => {
    vi.mocked(getClaimSpecRecord).mockResolvedValueOnce({
      source: 'fleet',
      spec: { specId: 'bug-drain-200k', revision: 2, view: { filter: { field: 'kind', op: '=', value: 'bug' } } } as never,
      revision: 2,
      updatedBy: 'su-leader',
      updatedAt: '2026-07-19T00:00:00Z',
      harnessSlug: 'papercusp',
      fleetSlug: 'bug-drain-200k',
    });

    const out = await call({ event: 'work-item:claimable' });
    const advice = String(out.auto_scoped_payload_filter_advice);

    expect(advice).toMatch(/items matching the claim-spec payload filter/i);
    expect(advice).toMatch(/claimability floors/i);
    expect(advice).toMatch(/scheduler:get_next/i);
    expect(advice).not.toMatch(/only on claimable items your spec could actually admit/i);
  });

  it('no spec at all (source: default) registers UNSCOPED but WARNS instead of silently thrashing', async () => {
    vi.mocked(getClaimSpecRecord).mockResolvedValueOnce({
      source: 'default',
      spec: null as never,
      revision: null,
      updatedBy: null,
      updatedAt: null,
    });
    const out = await call({ event: 'work-item:claimable' });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({ payloadFilter: null });
    expect(out.unscoped_claimable_await).toBe(true);
    expect(out.unscoped_claimable_advice).toMatch(/UNSCOPED/);
    expect(out.auto_scoped_payload_filter).toBeUndefined();
  });

  it("a spec that exists but doesn't narrow over the payload's fields also WARNS unscoped (never silently drops the narrowing) when it ALSO carries no harness scope", async () => {
    vi.mocked(getClaimSpecRecord).mockResolvedValueOnce({
      source: 'cup',
      spec: { specId: 's1', revision: 1, view: { filter: { field: 'priority', op: '>', value: 5 } } } as never,
      revision: 1,
      updatedBy: 'su-x',
      updatedAt: '2026-07-19T00:00:00Z',
      harnessSlug: null,
    });
    const out = await call({ event: 'work-item:claimable' });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({ payloadFilter: null });
    expect(out.unscoped_claimable_await).toBe(true);
  });

  it('EI-18674502503888023 regression: a spec whose filter tree narrows on nothing payload-relevant but whose record IS harness-bound still scopes on harness alone, instead of falling through to fully unscoped', async () => {
    vi.mocked(getClaimSpecRecord).mockResolvedValueOnce({
      source: 'cup',
      spec: { specId: 's1', revision: 1, view: { filter: { field: 'priority', op: '>', value: 5 } } } as never,
      revision: 1,
      updatedBy: 'su-x',
      updatedAt: '2026-07-19T00:00:00Z',
      harnessSlug: 'papercusp',
    });
    const out = await call({ event: 'work-item:claimable' });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({ payloadFilter: { harness: { equals: 'papercusp' } } });
    expect(out.auto_scoped_payload_filter).toBe(true);
    expect(out.unscoped_claimable_await).toBeUndefined();
  });

  it('a claim-spec read failure/timeout never blocks registration — falls back to unscoped', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(getClaimSpecRecord).mockRejectedValueOnce(new Error('db unreachable'));
    const out = await call({ event: 'work-item:claimable' });
    expect(out.ok).toBe(true);
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({ payloadFilter: null });
    warnSpy.mockRestore();
  });

  it('never auto-scopes a DIFFERENT event key or a pattern — only the exact "work-item:claimable" key', async () => {
    await call({ event: 'work-item:done:*' });
    expect(getClaimSpecRecord).not.toHaveBeenCalled();
    await call({ event: 'lock:grant:t1' });
    expect(getClaimSpecRecord).not.toHaveBeenCalled();
  });
});

describe('EI-21565976517547834 — reconcile an already-claimable level after await registration', () => {
  const fleetRecord = {
    source: 'fleet' as const,
    spec: {
      specId: 'byoc-plan-drain',
      revision: 36,
      view: { filter: { field: 'plan', op: '=', value: 'byoc-plan' } },
      rank: { mode: 'lexicographic', terms: [] },
      states: ['open'],
    },
    revision: 36,
    updatedBy: 'su-leader',
    updatedAt: '2026-08-27T00:50:00Z',
    harnessSlug: 'papercusp',
    fleetSlug: 'nonp2p-bug-drain',
  };

  it('retires the pending await and returns already_claimable when a matching row is live after registration', async () => {
    vi.mocked(getClaimSpecRecord).mockResolvedValueOnce(fleetRecord as unknown as ClaimSpecRecord);
    vi.mocked(readIssueClaimability).mockResolvedValueOnce({ rows: [{ id: 'WI-42252' }] } as never);
    vi.mocked(liveWorkItemClaimableEventPayload).mockResolvedValueOnce({
      id: 'WI-42252',
      kind: 'task',
      harness: 'papercusp',
      plan: 'byoc-plan',
      state: 'open',
    });
    vi.mocked(cancelAwait).mockResolvedValueOnce(true);

    const out = await call({
      event: 'work-item:claimable',
      payload_filter: { all: [{ harness: { equals: 'papercusp' } }, { plan: { equals: 'byoc-plan' } }] },
    });

    expect(registerAwait).toHaveBeenCalledTimes(1);
    expect(cancelAwait).toHaveBeenCalledWith({ awaitId: 99, subscriberId: 'su-awaiter' });
    expect(out).toMatchObject({
      ok: true,
      already_claimable: true,
      event: 'work-item:claimable',
      item: { id: 'WI-42252', state: 'open' },
    });
    expect(out.advice).toMatch(/Re-run scheduler:get_next now/);
    expect(extendOwnerClaimsForAwait).not.toHaveBeenCalled();
  });

  it('lets a concurrently-fired durable delivery win when the pending-row cancellation loses', async () => {
    vi.mocked(getClaimSpecRecord).mockResolvedValueOnce(fleetRecord as unknown as ClaimSpecRecord);
    vi.mocked(readIssueClaimability).mockResolvedValueOnce({ rows: [{ id: 'WI-42252' }] } as never);
    vi.mocked(liveWorkItemClaimableEventPayload).mockResolvedValueOnce({
      id: 'WI-42252', kind: 'task', harness: 'papercusp', plan: 'byoc-plan', state: 'open',
    });
    vi.mocked(cancelAwait).mockResolvedValueOnce(false);

    const out = await call({ event: 'work-item:claimable' });

    expect(cancelAwait).toHaveBeenCalledWith({ awaitId: 99, subscriberId: 'su-awaiter' });
    expect(out).toMatchObject({ ok: true, await_id: 99, event: 'work-item:claimable' });
    expect(out.already_claimable).toBeUndefined();
  });

  it('keeps the ordinary edge await when the current oracle has no matching survivor', async () => {
    vi.mocked(getClaimSpecRecord).mockResolvedValueOnce(fleetRecord as unknown as ClaimSpecRecord);
    vi.mocked(readIssueClaimability).mockResolvedValueOnce({ rows: [] } as never);

    const out = await call({ event: 'work-item:claimable' });

    expect(out).toMatchObject({ ok: true, await_id: 99 });
    expect(cancelAwait).not.toHaveBeenCalled();
    expect(liveWorkItemClaimableEventPayload).not.toHaveBeenCalled();
  });

  it('fails soft when the bounded current-level oracle cannot answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(getClaimSpecRecord).mockResolvedValueOnce(fleetRecord as unknown as ClaimSpecRecord);
    vi.mocked(readIssueClaimability).mockRejectedValueOnce(new Error('claimability read timed out'));

    const out = await call({ event: 'work-item:claimable' });

    expect(out).toMatchObject({ ok: true, await_id: 99 });
    expect(cancelAwait).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('events-await:claimableLevelAfterRegister'));
    warn.mockRestore();
  });
});

/**
 * EI-19344528739076339 — the gate-verdict keys are emitted GLOBALLY by every co-hosted
 * pipeline (~13 on this box), so awaiting one BARE subscribes you to strangers' gates. Twice
 * in one day that produced a confident, wrong "the gate is green" — once woken by oddsmith's
 * advance while papercusp had no verdict at all, once while papercusp was RED with its refire
 * still in flight. The prior fix put a `[pipeline]` prefix on the wake SUMMARY, which only
 * helps an agent that reads the banner — not one whose wake was parked and redelivered across
 * a carry-respawn. The trap is the KEY CHOICE, so it is closed at registration.
 */
describe('EI-19344528739076339 — auto-scope a bare multi-pipeline gate key to THIS pipeline', () => {
  const ORIGINAL_ROOT = process.env.PAPERCUSP_INTEGRATION_ROOT;
  beforeEach(() => {
    process.env.PAPERCUSP_INTEGRATION_ROOT = '/home/x/papercupai-workspace/papercusp';
  });
  afterEach(() => {
    if (ORIGINAL_ROOT === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
    else process.env.PAPERCUSP_INTEGRATION_ROOT = ORIGINAL_ROOT;
  });

  it('⭐ narrows a bare `release:green` await to { pipeline } derived from THIS integration root', async () => {
    const out = await call({ event: 'release:green' });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({
      payloadFilter: { pipeline: { equals: 'papercusp' } },
    });
    expect(out.auto_scoped_payload_filter).toBe(true);
    expect(out.payload_filter_source).toMatchObject({ source: 'pipeline', pipeline: 'papercusp' });
  });

  it('⭐ narrows a bare `green-checkpoint:red` await the same way', async () => {
    await call({ event: 'green-checkpoint:red' });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({
      payloadFilter: { pipeline: { equals: 'papercusp' } },
    });
  });

  it('narrows a bare `green-checkpoint:inconclusive` await so a foreign pipeline cannot wake it', async () => {
    const out = await call({ event: 'green-checkpoint:inconclusive' });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({
      payloadFilter: { pipeline: { equals: 'papercusp' } },
    });
    expect(out.auto_scoped_payload_filter).toBe(true);
    expect(out.payload_filter_source).toMatchObject({ source: 'pipeline', pipeline: 'papercusp' });
  });

  /** Even a correctly pipeline-scoped release:green fires for a PARTIAL advance (longest
   *  green prefix; the tip is still RED) — so "green" alone is not "deployable". */
  it('⭐ warns that release:green also fires for a PARTIAL advance', async () => {
    const out = await call({ event: 'release:green' });
    expect(String(out.auto_scoped_payload_filter_advice)).toMatch(/partial/i);
    expect(String(out.auto_scoped_payload_filter_advice)).toMatch(/redTip/);
  });

  it('an explicit payload_filter always wins — never silently replaced', async () => {
    const filter = { pipeline: { equals: 'oddsmith' } };
    const out = await call({ event: 'release:green', payload_filter: filter });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({ payloadFilter: filter });
    expect(out.auto_scoped_payload_filter).toBeUndefined();
  });

  it('an ALREADY pipeline-scoped key is left completely alone', async () => {
    const out = await call({ event: 'release:green:papercusp' });
    expect(out.auto_scoped_payload_filter).toBeUndefined();
    expect(out.unscoped_gate_key_await).toBeUndefined();
  });

  /**
   * The safety property — and the reason this is NOT scoped on the caller's harness slug.
   * `pipeline` is the sanitized basename of the integration root, not a slug; that the two
   * agree for all four emitting pipelines today is naming convention, not construction. A
   * filter narrowed on a value that never appears in any payload yields an await that can
   * NEVER fire: a silent hang, strictly worse than the wrong-pipeline wake being fixed. So
   * an unresolvable pipeline must WARN, never narrow.
   */
  it('⭐ WARNS instead of narrowing when this process\'s own pipeline cannot be resolved', async () => {
    process.env.PAPERCUSP_INTEGRATION_ROOT = '/';
    const out = await call({ event: 'release:green' });
    expect(out.auto_scoped_payload_filter).toBeUndefined();
    expect(out.unscoped_gate_key_await).toBe(true);
    expect(String(out.unscoped_gate_key_advice)).toMatch(/never match|silent hang|can never/i);
  });
});

/**
 * EI-24719187042784648 — `git-sync:committed` / `git-sync:egressed` fire once per git-sync
 * INSTALL (every harness, and every separately-synced submodule install). Measured
 * 2026-09-30 20:14Z: a bare `events:await { event: 'git-sync:committed' }` meant as "the
 * papercusp superproject committed" was consumed by a papercusp/libs/generic/search
 * submodule commit. The git-sync:await sugar already scoped and refused; the raw door did not.
 */
describe('EI-24719187042784648 — git-sync global keys are bound to the caller install', () => {
  const callAs = async (args: Record<string, unknown>, harnessSlug?: string) => {
    const scopedCtx = { workspaceId: 'ws-x', ...(harnessSlug ? { harnessSlug } : {}) } as unknown as Parameters<
      typeof awaitTool.handler
    >[1];
    const res = (await awaitTool.handler(args as never, scopedCtx)) as { content: Array<{ text: string }>; isError?: boolean };
    return { out: JSON.parse(res.content[0].text), isError: res.isError === true };
  };
  const fullSha = 'b'.repeat(40);

  it('⭐ narrows a bare git-sync:committed wait to the caller install, with a freshness boundary', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const { out } = await callAs({ event: 'git-sync:committed' }, 'papercusp');
      expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({
        payloadFilter: { installSlug: 'papercusp', workspaceId: 'ws-x', committedAtMs: { gt: 1_700_000_000_000 } },
      });
      expect(out.auto_scoped_payload_filter).toBe(true);
      expect(out.payload_filter_source).toMatchObject({ source: 'harness', installSlug: 'papercusp' });
    } finally {
      now.mockRestore();
    }
  });

  it('narrows git-sync:egressed WITHOUT committedAtMs, which egress payloads never carry', async () => {
    await callAs({ event: 'git-sync:egressed' }, 'papercusp');
    expect(vi.mocked(registerAwait).mock.calls[0][0].payloadFilter).toEqual({
      installSlug: 'papercusp',
      workspaceId: 'ws-x',
    });
  });

  it('narrows the sha glob the same way, since it also matches every install', async () => {
    await callAs({ event: 'git-sync:committed:*' }, 'papercusp');
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({
      payloadFilter: { installSlug: 'papercusp', workspaceId: 'ws-x' },
    });
  });

  it('⭐ REFUSES a bare global wait when no concrete harness resolves, before any mutation', async () => {
    for (const harnessSlug of [undefined, '*']) {
      vi.clearAllMocks();
      const { out, isError } = await callAs({ event: 'git-sync:committed' }, harnessSlug);
      expect(isError).toBe(true);
      expect(out).toMatchObject({ ok: false, error: 'harness_required', tool: 'events:await' });
      expect(String(out.detail)).toMatch(/submodule/);
      expect(registerAwait).not.toHaveBeenCalled();
      expect(cancelAwaitsForSubscribersOnKeys).not.toHaveBeenCalled();
    }
  });

  it('an explicit payload_filter always wins, even without a harness', async () => {
    const filter = { installSlug: 'portal' };
    const { out } = await callAs({ event: 'git-sync:committed', payload_filter: filter });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({ payloadFilter: filter });
    expect(out.auto_scoped_payload_filter).toBeUndefined();
  });

  it('leaves a full-sha key alone: the commit identity is already in the key', async () => {
    const { out } = await callAs({ event: `git-sync:committed:${fullSha}` });
    expect(registerAwait).toHaveBeenCalledTimes(1);
    expect(vi.mocked(registerAwait).mock.calls[0][0].payloadFilter ?? null).toBeNull();
    expect(out.auto_scoped_payload_filter).toBeUndefined();
  });

  it('⭐ refuses a key that can never fire: a harness name or a short sha in the sha slot', async () => {
    for (const [event, reason] of [
      ['git-sync:committed:papercusp', /per-install/],
      ['git-sync:egressed:abc1234', /short sha/],
    ] as const) {
      vi.clearAllMocks();
      const { out, isError } = await callAs({ event }, 'papercusp');
      expect(isError).toBe(true);
      expect(out).toMatchObject({ ok: false, error: 'git_sync_key_never_fires', event });
      expect(String(out.detail)).toMatch(reason);
      expect(registerAwait).not.toHaveBeenCalled();
      expect(probeKeyFireEvidence).not.toHaveBeenCalled();
    }
  });
});

describe('EI-21102428145156397 — dynamic git-sync egress exact-key latch', () => {
  const egressKey = `git-sync:egressed:${'a'.repeat(40)}`;

  it('answers already_fired for an exact SHA whose egress fire is already latched', async () => {
    vi.mocked(probeKeyFireEvidence).mockResolvedValueOnce({
      prefix: 'git-sync:egressed',
      exact: true,
      distinctKeys: 1,
      fires: 1,
      lastFiredAt: '2026-08-21T22:13:00.000Z',
    });

    const out = await call({ event: egressKey });

    expect(out).toMatchObject({
      ok: true,
      already_fired: true,
      event: egressKey,
      fired_at: '2026-08-21T22:13:00.000Z',
    });
    expect(out.advice).toMatch(/origin\/staging has already contained this commit/);
    expect(registerAwait).not.toHaveBeenCalled();
    expect(probeKeyFireEvidence).toHaveBeenCalledWith(egressKey);
  });

  it('does not treat a sibling SHA fire as satisfaction for this exact key', async () => {
    vi.mocked(probeKeyFireEvidence).mockResolvedValueOnce({
      prefix: 'git-sync:egressed',
      exact: false,
      distinctKeys: 2,
      fires: 2,
      lastFiredAt: '2026-08-21T22:13:00.000Z',
    });

    const out = await call({ event: egressKey });

    expect(out.already_fired).toBeUndefined();
    expect(out.await_id).toBe(99);
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it('does not apply the exact-key latch to the recurring global egress stream', async () => {
    vi.mocked(probeKeyFireEvidence).mockClear();

    // An explicit scope: a harness-less bare global git-sync wait is refused
    // (EI-24719187042784648), which is not the property this test pins.
    const out = await call({ event: 'git-sync:egressed', payload_filter: { installSlug: 'papercusp' } });

    expect(out.already_fired).toBeUndefined();
    expect(registerAwait).toHaveBeenCalledTimes(1);
    expect(probeKeyFireEvidence).not.toHaveBeenCalled();
  });

  it('reconciles a fire that lands after the preflight probe while the new row is still pending', async () => {
    vi.mocked(probeKeyFireEvidence)
      .mockResolvedValueOnce({
        prefix: 'git-sync:egressed',
        exact: false,
        distinctKeys: 0,
        fires: 0,
        lastFiredAt: null,
      })
      .mockResolvedValueOnce({
        prefix: 'git-sync:egressed',
        exact: true,
        distinctKeys: 1,
        fires: 1,
        lastFiredAt: '2026-08-23T02:14:00.000Z',
      });
    vi.mocked(cancelAwait).mockResolvedValueOnce(true);

    const out = await call({ event: egressKey });

    expect(out).toMatchObject({
      ok: true,
      already_fired: true,
      event: egressKey,
      fired_at: '2026-08-23T02:14:00.000Z',
    });
    expect(out.advice).toMatch(/during registration/);
    expect(cancelAwait).toHaveBeenCalledWith({ awaitId: 99, subscriberId: 'su-awaiter' });
    expect(registerAwait).toHaveBeenCalledTimes(1);
    const registerOrder = vi.mocked(registerAwait).mock.invocationCallOrder[0];
    const probeOrders = vi.mocked(probeKeyFireEvidence).mock.invocationCallOrder;
    expect(registerOrder).toBeLessThan(probeOrders[probeOrders.length - 1]);
  });

  it('leaves a row alone when the event already claimed it before reconciliation', async () => {
    vi.mocked(probeKeyFireEvidence)
      .mockResolvedValueOnce({
        prefix: 'git-sync:egressed',
        exact: false,
        distinctKeys: 0,
        fires: 0,
        lastFiredAt: null,
      })
      .mockResolvedValueOnce({
        prefix: 'git-sync:egressed',
        exact: true,
        distinctKeys: 1,
        fires: 1,
        lastFiredAt: '2026-08-23T02:15:00.000Z',
      });

    const out = await call({ event: egressKey });

    expect(out).toMatchObject({ ok: true, await_id: 99, event: egressKey });
    expect(out.already_fired).toBeUndefined();
    expect(cancelAwait).toHaveBeenCalledWith({ awaitId: 99, subscriberId: 'su-awaiter' });
  });
});

describe('EI-25418020058852136 — coordination receipt exact-key latch', () => {
  const receiptKey = 'coord:receipt:coord-send-read-once';
  const firedAt = '2026-10-08T13:13:40.328Z';
  const noFire = {
    prefix: 'coord:receipt', exact: false, distinctKeys: 0, fires: 0, lastFiredAt: null,
  };
  const exactFire = {
    prefix: 'coord:receipt', exact: true, distinctKeys: 1, fires: 1, lastFiredAt: firedAt,
  };

  beforeEach(() => {
    vi.mocked(probeKeyFireEvidence).mockReset().mockResolvedValue(noFire);
    vi.mocked(cancelAwait).mockReset().mockResolvedValue(false);
  });

  it('returns the prior receipt instead of waiting for a second receipt edge', async () => {
    vi.mocked(probeKeyFireEvidence).mockResolvedValue(exactFire);

    const out = await call({ event: receiptKey });

    expect(out).toMatchObject({ ok: true, already_fired: true, event: receiptKey, fired_at: firedAt });
    expect(out.advice).toMatch(/receipt/i);
    expect(out.advice).toMatch(/does not prove.*action/i);
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it('does not accept a receipt for a different message', async () => {
    vi.mocked(probeKeyFireEvidence).mockResolvedValue({ ...exactFire, exact: false });

    const out = await call({ event: receiptKey });

    expect(out.already_fired).toBeUndefined();
    expect(out.await_id).toBe(99);
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it('retires the pending wait when the receipt fires during registration', async () => {
    vi.mocked(probeKeyFireEvidence)
      .mockResolvedValueOnce(noFire)
      .mockResolvedValueOnce(exactFire);
    vi.mocked(cancelAwait).mockResolvedValueOnce(true);

    const out = await call({ event: receiptKey });

    expect(out).toMatchObject({ ok: true, already_fired: true, event: receiptKey, fired_at: firedAt });
    expect(out.advice).toMatch(/receipt.*during registration/i);
    expect(cancelAwait).toHaveBeenCalledWith({ awaitId: 99, subscriberId: 'su-awaiter' });
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it('preserves the delivery when the emitter already claimed the registered wait', async () => {
    vi.mocked(probeKeyFireEvidence)
      .mockResolvedValueOnce(noFire)
      .mockResolvedValueOnce(exactFire);

    const out = await call({ event: receiptKey });

    expect(out).toMatchObject({ ok: true, await_id: 99, event: receiptKey });
    expect(out.already_fired).toBeUndefined();
    expect(cancelAwait).toHaveBeenCalledWith({ awaitId: 99, subscriberId: 'su-awaiter' });
  });

  it('keeps bare and pattern receipt streams edge-triggered', async () => {
    await call({ event: 'coord:receipt' });
    await call({ event: 'coord:receipt:*' });

    expect(registerAwait).toHaveBeenCalledTimes(2);
    expect(probeKeyFireEvidence).not.toHaveBeenCalled();
  });

  it('does not use an unqualified fire to satisfy a payload-filtered receipt wait', async () => {
    vi.mocked(probeKeyFireEvidence).mockResolvedValue(exactFire);

    const out = await call({ event: receiptKey, payload_filter: { read: true } });

    expect(out.already_fired).toBeUndefined();
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });
});

describe('EI-23156083757639548 — task terminal exact-key latch', () => {
  const terminalKey = 'task:terminal:0mtzw7ug42uhzvubiux';

  it('answers already_fired when one concrete task reached terminal state before registration', async () => {
    vi.mocked(probeKeyFireEvidence).mockResolvedValueOnce({
      prefix: 'task:terminal',
      exact: true,
      distinctKeys: 1,
      fires: 1,
      lastFiredAt: '2026-09-13T14:13:22.614Z',
    });

    const out = await call({ event: terminalKey });

    expect(out).toMatchObject({
      ok: true,
      already_fired: true,
      event: terminalKey,
      fired_at: '2026-09-13T14:13:22.614Z',
    });
    expect(out.advice).toMatch(/first authoritative terminal ledger state/);
    expect(registerAwait).not.toHaveBeenCalled();
    expect(probeKeyFireEvidence).toHaveBeenCalledWith(terminalKey);
  });

  it('reconciles a task terminal fire that lands during registration', async () => {
    vi.mocked(probeKeyFireEvidence)
      .mockResolvedValueOnce({
        prefix: 'task:terminal',
        exact: false,
        distinctKeys: 0,
        fires: 0,
        lastFiredAt: null,
      })
      .mockResolvedValueOnce({
        prefix: 'task:terminal',
        exact: true,
        distinctKeys: 1,
        fires: 1,
        lastFiredAt: '2026-09-13T14:13:22.614Z',
      });
    vi.mocked(cancelAwait).mockResolvedValueOnce(true);

    const out = await call({ event: terminalKey });

    expect(out).toMatchObject({
      ok: true,
      already_fired: true,
      event: terminalKey,
      fired_at: '2026-09-13T14:13:22.614Z',
    });
    expect(out.advice).toMatch(/fired during registration/);
    expect(cancelAwait).toHaveBeenCalledWith({ awaitId: 99, subscriberId: 'su-awaiter' });
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it('keeps bare and pattern task-terminal streams edge-triggered', async () => {
    await call({ event: 'task:terminal' });
    await call({ event: 'task:terminal:*' });

    expect(registerAwait).toHaveBeenCalledTimes(2);
    expect(probeKeyFireEvidence).not.toHaveBeenCalled();
  });
});

/**
 * EI-19928976726540168 — the SAME auto-narrow as EI-19344528739076339 above, for the GLOB form
 * of a gate-verdict key. The exact-key auto-narrow requires `!patternAwait`, so it never ran
 * for `release:green:*` / `green-checkpoint:red:*` / `green-checkpoint:inconclusive:*` — the
 * shape an agent reaches for when they actually want "any verdict for my pipeline". Live
 * incident: a caller parked on `green-checkpoint:red:*` and was woken by a foreign pipeline's
 * verdict, payload-shape-identical to its own.
 */
describe('EI-19928976726540168 — auto-scope a GLOB multi-pipeline gate key to THIS pipeline', () => {
  const ORIGINAL_ROOT = process.env.PAPERCUSP_INTEGRATION_ROOT;
  beforeEach(() => {
    process.env.PAPERCUSP_INTEGRATION_ROOT = '/home/x/papercupai-workspace/papercusp';
  });
  afterEach(() => {
    if (ORIGINAL_ROOT === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
    else process.env.PAPERCUSP_INTEGRATION_ROOT = ORIGINAL_ROOT;
  });

  it('⭐ narrows a `release:green:*` pattern await to { pipeline } derived from THIS integration root', async () => {
    const out = await call({ event: 'release:green:*' });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({
      payloadFilter: { pipeline: { equals: 'papercusp' } },
    });
    expect(out.auto_scoped_payload_filter).toBe(true);
    expect(out.payload_filter_source).toMatchObject({ source: 'pipeline', pipeline: 'papercusp' });
  });

  it('⭐ narrows `green-checkpoint:red:*` and `green-checkpoint:inconclusive:*` the same way', async () => {
    await call({ event: 'green-checkpoint:red:*' });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({
      payloadFilter: { pipeline: { equals: 'papercusp' } },
    });
    vi.clearAllMocks();
    await call({ event: 'green-checkpoint:inconclusive:*' });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({
      payloadFilter: { pipeline: { equals: 'papercusp' } },
    });
  });

  /** The advice must compute the concrete scoped key by REPLACING the trailing `:*`, never
   *  appending — appending onto the shared `autoScopedPipeline` var would render malformed
   *  (`release:green:*:papercusp`), which is exactly why this uses separate variables. */
  it('⭐ advice names the concrete pipeline-scoped key correctly (no malformed `:*:pipeline`)', async () => {
    const out = await call({ event: 'green-checkpoint:red:*' });
    expect(String(out.auto_scoped_payload_filter_advice)).toContain('green-checkpoint:red:papercusp');
    expect(String(out.auto_scoped_payload_filter_advice)).not.toContain(':*:papercusp');
  });

  it('an explicit payload_filter always wins — never silently replaced', async () => {
    const filter = { pipeline: { equals: 'oddsmith' } };
    const out = await call({ event: 'release:green:*', payload_filter: filter });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({ payloadFilter: filter });
    expect(out.auto_scoped_payload_filter).toBeUndefined();
  });

  it('⭐ WARNS instead of narrowing when this process\'s own pipeline cannot be resolved', async () => {
    process.env.PAPERCUSP_INTEGRATION_ROOT = '/';
    const out = await call({ event: 'green-checkpoint:red:*' });
    expect(out.auto_scoped_payload_filter).toBeUndefined();
    expect(out.unscoped_gate_key_await).toBe(true);
    expect(String(out.unscoped_gate_key_advice)).toMatch(/never match|silent hang|can never/i);
  });

  it('does not fire for an unrelated glob', async () => {
    const out = await call({ event: 'work-item:*' });
    expect(out.auto_scoped_payload_filter).toBeUndefined();
    expect(out.unscoped_gate_key_await).toBeUndefined();
  });
});

// EI-20268841604319803: a real gateway restart slept through a 6h
// `service:up:inference-gateway` await because that key fires on an
// unhealthy→healthy TRANSITION and the restart completed between health ticks.
// These drive the REAL handler (the pure predicate is covered separately in
// service-up-edge.test.ts) — the gap that produced the incident was precisely a
// correct rule that one surface never called, so the wiring is the thing worth
// asserting here.
describe('service-up edge advisory (EI-20268841604319803)', () => {
  it('warns when the service is already healthy, and still REGISTERS the await', async () => {
    serviceHealthMock.probeNamedService.mockResolvedValueOnce({
      name: 'inference-gateway',
      up: true,
      status: 200,
      latencyMs: 3,
    });
    const out = await call({ event: 'service:up:inference-gateway' });
    expect(out.service_up_edge_already_healthy).toBe(true);
    expect(out.service_up_edge_advice).toContain('CANNOT confirm a restart');
    expect(out.service_up_edge_advice).toContain('service:await-up');
    // Advisory, NOT a refusal: the await must still exist, or an agent arming it
    // before deliberately taking the service down would silently lose its wake.
    expect(out.ok).toBe(true);
    expect(out.await_id).toBeDefined();
  });

  it('names the structural damping reason for a flap-damped service', async () => {
    serviceHealthMock.probeNamedService.mockResolvedValueOnce({
      name: 'staging-api',
      up: true,
      status: 200,
      latencyMs: 3,
    });
    const out = await call({ event: 'service:up:staging-api' });
    expect(out.service_up_edge_advice).toContain('flap-damped');
  });

  it('stays SILENT when the service is currently down — the await is then correct', async () => {
    serviceHealthMock.probeNamedService.mockResolvedValueOnce({
      name: 'inference-gateway',
      up: false,
      status: null,
      latencyMs: 1,
    });
    const out = await call({ event: 'service:up:inference-gateway' });
    expect(out.service_up_edge_already_healthy).toBeUndefined();
    expect(out.service_up_edge_advice).toBeUndefined();
  });

  it('stays SILENT when health is unreadable — an unavailable probe must not manufacture a warning', async () => {
    serviceHealthMock.probeNamedService.mockRejectedValueOnce(new Error('unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await call({ event: 'service:up:inference-gateway' });
      expect(out.service_up_edge_already_healthy).toBeUndefined();
      expect(out.ok).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not probe at all for a pattern await or an unrelated key', async () => {
    await call({ event: 'service:up:*' });
    await call({ event: 'work-item:done:WI-1' });
    expect(serviceHealthMock.probeNamedService).not.toHaveBeenCalled();
  });
});

// This suite DRIVES the real await.ts handler through a PARTIAL mock of
// events/await/store, so its factory stands in for that module's whole used surface
// and must track production's import list. See testing/mock-import-coverage.ts for
// why that promise silently rots and what it costs downstream.
describe('events/await/store mock coverage', () => {
  it('mocks every store export the handler under test imports', () => {
    assertMockCoversImports(storeMock, {
      importerUrl: import.meta.url,
      sources: ['./await.ts'],
      moduleSpecifier: 'events/await/store',
      expectNames: ['probePatternMatchScope'],
    });
  });
});
