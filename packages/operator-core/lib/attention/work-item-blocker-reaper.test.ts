import { describe, expect, it, vi } from 'vitest';

// The production follow-up's transport ends (event-wait-settlement-2026-10-20 P-003):
// spied, so a sweep tick can be observed refreshing claimable views and messaging/waking.
const followUp = vi.hoisted(() => ({
  notifySyncInvalidate: vi.fn(async () => undefined),
  sendMessage: vi.fn(async () => ({})),
  wakeRecipients: vi.fn(async () => ({})),
}));
vi.mock('../sync-sse', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sync-sse')>()),
  notifySyncInvalidate: followUp.notifySyncInvalidate,
}));
vi.mock('../agent-tools/coordination/messages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-tools/coordination/messages')>()),
  sendMessage: followUp.sendMessage,
}));
vi.mock('../agent-tools/coordination/inbox-wake', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-tools/coordination/inbox-wake')>()),
  wakeRecipients: followUp.wakeRecipients,
}));
vi.mock('../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace-registry')>()),
  activeWorkspaceId: () => 'ws-reaper-test',
}));

import * as eventStore from '../events/await/store';
import type { AwaitRow, KeyFireRow } from '../events/await/types';
import {
  applyBlockerDefaultToHistory,
  decideBlockerDefault,
  ownerAskDefaultDisclosure,
  readExternalBlockers,
  updateExternalBlockerHistory,
  type ExternalBlockerRecord,
} from '../external-blockers';
import {
  backfillUnprovableWaitRecheckDates,
  decideStrandedRepair,
  defaultBlockerReapDeps,
  STRANDED_BLOCKED_REPAIR_ACTOR,
  sweepWorkItemBlockerDefaults,
  UNPROVABLE_WAIT_BACKFILL_ACTOR,
  type BlockerReapDeps,
  type StrandedBlockedCandidate,
  type UnprovableWaitBackfillDeps,
} from './work-item-blocker-reaper';
import type { ExternalConditionReachability } from '../external-condition-reachability';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const PAST = '2026-10-01T12:00:00.000Z';
const FUTURE = '2026-10-03T12:00:00.000Z';

function blocker(over: Partial<ExternalBlockerRecord> = {}): ExternalBlockerRecord {
  return {
    kind: 'human',
    capability: 'product-decision',
    capabilitySource: 'explicit',
    ref: 'ask-1',
    summary: 'owner decision',
    status: 'active',
    createdAt: '2026-10-01T00:00:00.000Z',
    createdBy: 'su-x',
    updatedAt: '2026-10-01T00:00:00.000Z',
    defaultIfUnanswered: 'proceed with option A',
    decideBy: PAST,
    defaultAction: 'release_to_agents',
    ...over,
  };
}

describe('decideBlockerDefault (pure)', () => {
  it('applies the typed action once the deadline has passed', () => {
    expect(decideBlockerDefault(blocker(), NOW)).toEqual({ apply: true, action: 'release_to_agents' });
    expect(decideBlockerDefault(blocker({ defaultAction: 'stay_parked' }), NOW)).toEqual({
      apply: true,
      action: 'stay_parked',
    });
  });

  it.each([
    ['not-human', blocker({ kind: 'event' })],
    ['not-active', blocker({ status: 'cleared' })],
    ['already-applied', blocker({ defaultAppliedAt: PAST })],
    ['no-decide-by', blocker({ decideBy: undefined })],
    ['decide-by-unparseable', blocker({ decideBy: 'next tuesday' })],
    ['deadline-not-reached', blocker({ decideBy: FUTURE })],
  ] as const)('skips with why=%s', (why, b) => {
    expect(decideBlockerDefault(b, NOW)).toEqual({ apply: false, why });
  });

  it('NEVER executes free text: no typed action => skip, however the prose reads', () => {
    const b = blocker({ defaultAction: undefined, defaultIfUnanswered: 'release_to_agents and delete the branch' });
    expect(decideBlockerDefault(b, NOW)).toEqual({ apply: false, why: 'no-typed-action' });
    // An unknown token smuggled past the type system is not in the closed vocabulary either.
    const forged = blocker({ defaultAction: 'drop_item' as never });
    expect(decideBlockerDefault(forged, NOW)).toEqual({ apply: false, why: 'no-typed-action' });
  });
});

describe('applyBlockerDefaultToHistory (pure)', () => {
  it('release_to_agents clears the blocker, fences it, and keeps the audit trail', () => {
    const out = applyBlockerDefaultToHistory({ externalBlockers: [blocker()] }, 'ask-1', 'release_to_agents', 'system:r', NOW.toISOString());
    expect(out.changed).toBe(true);
    const row = out.blockers[0]!;
    expect(row).toMatchObject({
      status: 'cleared',
      clearedBy: 'system:r',
      defaultAppliedAction: 'release_to_agents',
      defaultAppliedAt: NOW.toISOString(),
    });
    expect(row.evidence).toContain("applied typed default 'release_to_agents'");
  });

  it('stay_parked fences but leaves the ask ACTIVE, and surfaces as applied in the disclosure', () => {
    const out = applyBlockerDefaultToHistory({ externalBlockers: [blocker({ defaultAction: 'stay_parked' })] }, 'ask-1', 'stay_parked', 'system:r', NOW.toISOString());
    expect(out.blockers[0]!.status).toBe('active');
    expect(ownerAskDefaultDisclosure({ externalBlockers: out.blockers })).toContain('Default APPLIED');
  });

  it('is exactly-once: a second application against the fenced history is a no-op', () => {
    const first = applyBlockerDefaultToHistory({ externalBlockers: [blocker({ defaultAction: 'stay_parked' })] }, 'ask-1', 'stay_parked', 'system:r');
    const second = applyBlockerDefaultToHistory({ externalBlockers: first.blockers }, 'ask-1', 'stay_parked', 'system:r');
    expect(second.changed).toBe(false);
  });

  it('re-declaring decideBy/defaultAction re-arms (drops the fence) so the NEW contract applies once', () => {
    const applied = applyBlockerDefaultToHistory({ externalBlockers: [blocker({ defaultAction: 'stay_parked' })] }, 'ask-1', 'stay_parked', 'system:r').blockers;
    const rearmed = updateExternalBlockerHistory(
      { externalBlockers: applied },
      { kind: 'human', ref: 'ask-1', decideBy: FUTURE, defaultAction: 'release_to_agents' },
      'su-y',
    );
    const row = readExternalBlockers({ externalBlockers: rearmed.blockers })[0]!;
    expect(row.defaultAppliedAt).toBeUndefined();
    expect(row.defaultAction).toBe('release_to_agents');
  });
});

function fakeDeps(payloads: Record<string, unknown>) {
  const writes: Array<{ id: string; blockers: ExternalBlockerRecord[] }> = [];
  const restores: string[] = [];
  const deps: BlockerReapDeps = {
    listCandidates: async () => Object.entries(payloads).map(([id, payload]) => ({ id, harness: 'h', payload })),
    readPayload: async (id) => ({ payload: payloads[id], family: 'issue', state: 'needs-human' }),
    writeBlockers: async (id, _h, blockers) => {
      writes.push({ id, blockers });
      payloads[id] = { externalBlockers: blockers };
      return true;
    },
    restoreLifecycle: async ({ id }) => {
      restores.push(id);
    },
  };
  return { deps, writes, restores };
}

describe('sweepWorkItemBlockerDefaults', () => {
  it.each([
    { kind: 'gate' as const, ref: 'plan:acceptance:grading-plan', clearsBlocker: false, announced: false },
    // The bare deploy key binds no sha, so its fire proves nothing about one deploy.
    { kind: 'event' as const, ref: 'release:deployed', clearsBlocker: false, announced: false },
    // event-wait-settlement-2026-10-20 D-005: the per-sha deploy key names one deploy and
    // proves it landed, so its fire clears the blocker even unannounced.
    { kind: 'event' as const, ref: 'release:deployed:abc123', clearsBlocker: true, announced: false },
    // event-wait-settlement-2026-10-20 R-1: a fired CHANGE notification about one subject
    // names that subject but proves nothing about the condition — the blocker stays.
    { kind: 'event' as const, ref: 'work-item:status:WI-ready', clearsBlocker: false, announced: false },
    { kind: 'event' as const, ref: 'work-item:claimed:WI-ready', clearsBlocker: false, announced: false },
    { kind: 'event' as const, ref: 'work-item:blocked:WI-ready', clearsBlocker: false, announced: false },
    { kind: 'event' as const, ref: 'work-item:unblocked:WI-ready', clearsBlocker: false, announced: false },
    // ...and stays even when its producer declared it: a declaration binds no new meaning.
    { kind: 'event' as const, ref: 'work-item:status:WI-ready', clearsBlocker: false, announced: true },
    // A completion family on the same subject is the proof the change keys are not.
    { kind: 'event' as const, ref: 'work-item:done:WI-ready', clearsBlocker: true, announced: false },
    { kind: 'gate' as const, ref: 'reaper:declared-ready', clearsBlocker: true, announced: true },
  ])('production resolver clears $ref (announced=$announced) only when the fire proves its condition', async ({ kind, ref, clearsBlocker, announced }) => {
    const firedAt = '2026-09-30T12:00:00.000Z';
    // Element-level casts to the REAL row types (overlap-checked: a renamed/removed field
    // fails to compile) — the outer value then type-checks against inspectEventKey's
    // actual return, with no blanket cast over the whole fixture.
    const inspect = vi.spyOn(eventStore, 'inspectEventKey').mockResolvedValue({
      announcements: announced
        ? [{ firedAt, firedReason: 'event', supersededAt: null, cancelledAt: null, expiresTs: null } as AwaitRow]
        : [],
      waiters: [], deliveries: [], composedRoot: null,
      fireLatch: { lastFiredAt: firedAt } as KeyFireRow,
    });
    try {
      const due = blocker({ kind, ref, capability: 'live-dependency',
        decideBy: undefined, defaultAction: undefined, recheckAt: PAST });
      const { deps, writes, restores } = fakeDeps({ 'WI-condition': { externalBlockers: [due] } });
      deps.resolveCondition = defaultBlockerReapDeps.resolveCondition;
      deps.escalate = vi.fn(async () => undefined);

      const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps });

      expect(out.rechecked).toEqual({ cleared: clearsBlocker ? 1 : 0, escalated: clearsBlocker ? 0 : 1 });
      expect(writes[0]?.blockers[0]?.status).toBe(clearsBlocker ? 'cleared' : 'active');
      expect(restores).toHaveLength(clearsBlocker ? 1 : 0);
      if (clearsBlocker) {
        expect(deps.escalate).not.toHaveBeenCalled();
      } else {
        expect(deps.escalate).toHaveBeenCalledOnce();
        expect(writes[0]?.blockers[0]?.reachability).toMatchObject({
          verdict: 'unknown', authoritative: false,
        });
      }
    } finally {
      inspect.mockRestore();
    }
  });

  it('clears only a proved fired event at its re-check date and preserves history', async () => {
    const event = blocker({ kind: 'event', capability: 'live-dependency', ref: 'event:ready',
      decideBy: undefined, defaultAction: undefined, recheckAt: PAST });
    const { deps, writes, restores } = fakeDeps({ 'WI-event': { externalBlockers: [event] } });
    deps.resolveCondition = async () => ({ verdict: 'reachable', basis: 'fired', authoritative: true,
      evidence: 'current generation fired', checkedAt: NOW.toISOString() });
    deps.escalate = vi.fn(async () => undefined);
    const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps });
    expect(out.rechecked).toEqual({ cleared: 1, escalated: 0 });
    expect(writes[0]?.blockers[0]).toMatchObject({ status: 'cleared', recheckDisposition: 'cleared',
      recheckedAt: NOW.toISOString(), evidence: 'current generation fired' });
    expect(restores).toHaveLength(1);
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it.each(['event', 'runtime', 'human'] as const)('escalates a due %s condition without treating expiry as clearance', async (kind) => {
    const due = blocker({ kind, decideBy: undefined, defaultAction: undefined, recheckAt: PAST });
    const { deps, writes, restores } = fakeDeps({ 'WI-due': { externalBlockers: [due] } });
    deps.resolveCondition = async () => ({ verdict: 'reachable', basis: kind === 'event' ? 'live-resolver' : 'fired',
      authoritative: true, evidence: 'still requires named action', checkedAt: NOW.toISOString() });
    deps.escalate = vi.fn(async () => undefined);
    const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps });
    expect(out.rechecked).toEqual({ cleared: 0, escalated: 1 });
    expect(writes[0]?.blockers[0]).toMatchObject({ status: 'active', recheckDisposition: 'escalated', recheckAt: '2026-10-03T12:00:00.000Z' });
    expect(restores).toHaveLength(0);
    expect(deps.escalate).toHaveBeenCalledOnce();
  });

  it('does not escalate or restore when a concurrent blocker writer wins the history fence', async () => {
    const { deps } = fakeDeps({ 'WI-race': { externalBlockers: [blocker({ decideBy: undefined, recheckAt: PAST })] } });
    deps.writeBlockers = vi.fn(async () => false);
    deps.escalate = vi.fn(async () => undefined);
    deps.restoreLifecycle = vi.fn(async () => undefined);
    const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps });
    expect(out.skipped['lost-race']).toBe(1);
    expect(deps.escalate).not.toHaveBeenCalled();
    expect(deps.restoreLifecycle).not.toHaveBeenCalled();
  });

  it('keeps a failed escalation due until delivery succeeds', async () => {
    const { deps } = fakeDeps({ 'WI-retry': { externalBlockers: [blocker({ decideBy: undefined, recheckAt: PAST })] } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    deps.escalate = vi.fn().mockRejectedValueOnce(new Error('delivery unavailable')).mockResolvedValue(undefined);
    const first = await sweepWorkItemBlockerDefaults({ now: NOW, deps });
    expect(first.skipped['read-failed']).toBe(1);
    const pending = readExternalBlockers((await deps.readPayload('WI-retry', 'h'))?.payload)[0];
    expect(pending?.recheckAt).toBe(PAST);
    expect(pending?.recheckDisposition).toBeUndefined();
    const second = await sweepWorkItemBlockerDefaults({ now: NOW, deps });
    expect(second.rechecked.escalated).toBe(1);
    expect(readExternalBlockers((await deps.readPayload('WI-retry', 'h'))?.payload)[0]?.recheckAt).toBe(FUTURE);
    warn.mockRestore();
  });

  it('applies a past-deadline typed default exactly once across repeated sweeps and restores the lifecycle', async () => {
    const { deps, writes, restores } = fakeDeps({ 'WI-1': { externalBlockers: [blocker()] } });
    const first = await sweepWorkItemBlockerDefaults({ now: NOW, deps });
    const second = await sweepWorkItemBlockerDefaults({ now: NOW, deps });
    expect(first.applied).toEqual({ stay_parked: 0, release_to_agents: 1 });
    expect(second.applied).toEqual({ stay_parked: 0, release_to_agents: 0 });
    expect(writes).toHaveLength(1);
    expect(restores).toEqual(['WI-1']);
  });

  it('stay_parked writes the fence but does not touch the lifecycle', async () => {
    const { deps, writes, restores } = fakeDeps({ 'WI-2': { externalBlockers: [blocker({ defaultAction: 'stay_parked' })] } });
    const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps });
    expect(out.applied.stay_parked).toBe(1);
    expect(writes).toHaveLength(1);
    expect(restores).toEqual([]);
  });

  it('leaves a not-yet-due ask alone and surfaces a typed-less/unparseable one instead of acting', async () => {
    const { deps, writes } = fakeDeps({
      'WI-3': { externalBlockers: [blocker({ decideBy: FUTURE })] },
      'WI-4': { externalBlockers: [blocker({ defaultAction: undefined })] },
    });
    const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps });
    expect(writes).toHaveLength(0);
    expect(out.skipped['no-typed-action']).toBe(1);
  });

  it('dryRun counts what WOULD apply without writing', async () => {
    const { deps, writes } = fakeDeps({ 'WI-5': { externalBlockers: [blocker()] } });
    const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps, dryRun: true });
    expect(out.applied.release_to_agents).toBe(1);
    expect(writes).toHaveLength(0);
  });

  it('a lost race (history changed between list and apply) is a no-op, not an overwrite', async () => {
    const deps: BlockerReapDeps = {
      listCandidates: async () => [{ id: 'WI-6', harness: 'h', payload: { externalBlockers: [blocker()] } }],
      readPayload: async () => ({ payload: { externalBlockers: [blocker({ status: 'cleared' })] } }),
      writeBlockers: vi.fn(async () => true),
      restoreLifecycle: vi.fn(async () => undefined),
    };
    const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps });
    expect(out.skipped['lost-race']).toBe(1);
    expect(deps.writeBlockers).not.toHaveBeenCalled();
  });

  it('one failing item does not strand the rest of the batch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ok = fakeDeps({ 'WI-8': { externalBlockers: [blocker()] } });
    const deps: BlockerReapDeps = {
      ...ok.deps,
      listCandidates: async () => [
        { id: 'WI-7', harness: 'h', payload: { externalBlockers: [blocker()] } },
        { id: 'WI-8', harness: 'h', payload: { externalBlockers: [blocker()] } },
      ],
      readPayload: async (id, h) => {
        if (id === 'WI-7') throw new Error('boom');
        return ok.deps.readPayload(id, h);
      },
    };
    const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps });
    expect(out.skipped['read-failed']).toBe(1);
    expect(out.applied.release_to_agents).toBe(1);
  });
});

describe('the re-check sweep follows up every clear (event-wait-settlement-2026-10-20 P-003)', () => {
  const fired = async () => ({ verdict: 'reachable' as const, basis: 'fired' as const, authoritative: true,
    evidence: 'current event generation fired', checkedAt: NOW.toISOString() });
  const due = (ref: string, over: Partial<ExternalBlockerRecord> = {}) =>
    blocker({ kind: 'event', capability: 'live-dependency', ref, decideBy: undefined, defaultAction: undefined, ...over });

  /** fakeDeps + the PRODUCTION follow-up, a feature held by su-holder, and a restore that
   *  reports what the production restore sets for a feature whose last blocker cleared. */
  function sweepDeps(blockers: ExternalBlockerRecord[]) {
    const fake = fakeDeps({ 'WI-held': { externalBlockers: blockers } });
    const read = fake.deps.readPayload;
    fake.deps.readPayload = async (id, h) => ({ ...(await read(id, h))!, family: 'feature', state: 'blocked', holder: 'su-holder' });
    fake.deps.restoreLifecycle = async ({ remaining }) => (remaining.length === 0 ? 'open' : 'blocked');
    fake.deps.resolveCondition = fired;
    fake.deps.escalate = vi.fn(async () => undefined);
    fake.deps.followUp = defaultBlockerReapDeps.followUp;
    for (const spy of Object.values(followUp)) spy.mockClear();
    return fake.deps;
  }

  it('SPEC-P-003: a sweep tick that clears the last blocker invalidates the claimable sync queries', async () => {
    const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps: sweepDeps([due('event:ready', { recheckAt: PAST })]) });

    expect(out.rechecked).toEqual({ cleared: 1, escalated: 0 });
    const invalidated = followUp.notifySyncInvalidate.mock.calls.map((call) => (call as unknown[])[0]);
    expect(invalidated).toEqual(expect.arrayContaining(['workItems.byHarness', 'workItems.summary']));
  });

  it('AUTO-BAR-R-5-P-003: the holder gets a message and a wake when the sweep clears the last blocker', async () => {
    await sweepWorkItemBlockerDefaults({ now: NOW, deps: sweepDeps([due('event:ready', { recheckAt: PAST })]) });

    expect(followUp.sendMessage).toHaveBeenCalledTimes(1);
    const [identity, opts] = followUp.sendMessage.mock.calls[0] as unknown as [
      { ownerId: string; workspaceId: string },
      { to: string[]; summary: string; body: string; harnessSlug: string },
    ];
    expect(identity).toMatchObject({ ownerId: 'system:blocker-auto-clear', workspaceId: 'ws-reaper-test' });
    expect(opts).toMatchObject({ to: ['su-holder'], harnessSlug: 'h' });
    expect(opts.summary).toContain('WI-held');
    expect(opts.summary).toContain('event:ready');
    expect(opts.body).toContain('clearedBy system:blocker-default-reaper');
    expect(opts.body).toContain('No active blocker remains on WI-held.');
    expect(followUp.wakeRecipients).toHaveBeenCalledWith(['su-holder'],
      expect.objectContaining({ summary: opts.summary, workspaceId: 'ws-reaper-test' }));
  });

  it('a partial clear still tells the holder but does not refresh claimable views', async () => {
    const out = await sweepWorkItemBlockerDefaults({ now: NOW,
      deps: sweepDeps([due('event:ready', { recheckAt: PAST }), due('event:later', { recheckAt: FUTURE })]) });

    expect(out.rechecked).toEqual({ cleared: 1, escalated: 0 });
    expect(followUp.notifySyncInvalidate).not.toHaveBeenCalled();
    expect(followUp.sendMessage).toHaveBeenCalledTimes(1);
    const opts = (followUp.sendMessage.mock.calls[0] as unknown as [unknown, { body: string }])[1];
    expect(opts.body).toContain('1 other active blocker(s) still hold WI-held');
  });

  it('an escalation is not a clear: no follow-up', async () => {
    const deps = sweepDeps([due('event:ready', { recheckAt: PAST })]);
    deps.resolveCondition = async () => ({ verdict: 'unknown', basis: 'unmeasured', authoritative: false,
      evidence: 'not fired', checkedAt: NOW.toISOString() });
    const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps });

    expect(out.rechecked).toEqual({ cleared: 0, escalated: 1 });
    expect(followUp.notifySyncInvalidate).not.toHaveBeenCalled();
    expect(followUp.sendMessage).not.toHaveBeenCalled();
  });

  it('a failing follow-up never changes what the sweep counted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const deps = sweepDeps([due('event:ready', { recheckAt: PAST })]);
      deps.followUp = async () => { throw new Error('coord down'); };
      const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps });
      expect(out.rechecked).toEqual({ cleared: 1, escalated: 0 });
      expect(out.skipped).toEqual({});
    } finally {
      warn.mockRestore();
    }
  });
});

describe('decideStrandedRepair (pure, event-wait-settlement-2026-10-20 P-005)', () => {
  const cleared = (clearedAt: string, over: Record<string, unknown> = {}) =>
    ({ ...blocker({ kind: 'event', ref: 'event:x', decideBy: undefined, defaultAction: undefined }),
      status: 'cleared', clearedAt, ...over });

  it('repairs an item that was already blocked when its last blocker was cleared', () => {
    expect(decideStrandedRepair({ stateChangedAt: '2026-10-01T00:00:00.000Z',
      blockers: [cleared('2026-10-01T06:00:00.000Z'), cleared('2026-10-01T09:00:00.000Z')] }))
      .toEqual({ repair: true, lastClearedAt: '2026-10-01T09:00:00.000Z' });
  });

  it('leaves an item that was moved into blocked AFTER its last clear', () => {
    expect(decideStrandedRepair({ stateChangedAt: '2026-10-02T00:00:00.000Z',
      blockers: [cleared('2026-10-01T09:00:00.000Z')] })).toEqual({ repair: false, why: 'reblocked-after-clear' });
  });

  it.each([
    { name: 'an active blocker remains', blockers: [cleared('2026-10-01T09:00:00.000Z'), blocker()], why: 'active-blocker' },
    { name: 'no blocker at all', blockers: [], why: 'no-blocker' },
    { name: 'a non-array history', blockers: { status: 'cleared' }, why: 'no-blocker' },
    { name: 'no parseable clear time', blockers: [cleared('not-a-date', { updatedAt: 'nope' })], why: 'no-clear-time' },
  ])('leaves it when $name', ({ blockers, why }) => {
    expect(decideStrandedRepair({ stateChangedAt: '2026-10-01T00:00:00.000Z', blockers })).toEqual({ repair: false, why });
  });

  it('leaves it when the state-change time is unknown', () => {
    expect(decideStrandedRepair({ stateChangedAt: null, blockers: [cleared('2026-10-01T09:00:00.000Z')] }))
      .toEqual({ repair: false, why: 'no-state-time' });
  });

  it('falls back to updatedAt for a non-active record without clearedAt', () => {
    expect(decideStrandedRepair({ stateChangedAt: '2026-10-01T00:00:00.000Z',
      blockers: [cleared(undefined as unknown as string, { status: 'superseded', updatedAt: '2026-10-01T03:00:00.000Z' })] }))
      .toEqual({ repair: true, lastClearedAt: '2026-10-01T03:00:00.000Z' });
  });
});

describe('the re-check sweep recovers missed fires and stranded items (event-wait-settlement-2026-10-20 P-005)', () => {
  function passDeps() {
    const fake = fakeDeps({});
    const settledKeys: string[] = [];
    const repairedIds: string[] = [];
    const followUps: unknown[] = [];
    const stranded: StrandedBlockedCandidate[] = [];
    fake.deps.listMissedFireKeys = vi.fn(async () => ({ keys: ['release:deployed:abc123', 'work-item:done:WI-1'], truncatedByLimit: false }));
    fake.deps.settleFiredKey = vi.fn(async (key: string) => { settledKeys.push(key); return 2; });
    fake.deps.listStrandedBlocked = vi.fn(async () => stranded);
    fake.deps.repairStranded = vi.fn(async (c: StrandedBlockedCandidate) => { repairedIds.push(c.id); return 'cleared' as const; });
    fake.deps.followUp = vi.fn(async (items) => { followUps.push(...items); });
    return { deps: fake.deps, settledKeys, repairedIds, followUps, stranded };
  }
  const strandedItem = (id: string, over: Partial<StrandedBlockedCandidate> = {}): StrandedBlockedCandidate => ({
    id, harness: 'h', family: 'feature', holder: 'su-holder', stateChangedAt: '2026-10-01T00:00:00.000Z',
    blockers: [{ kind: 'event', ref: 'event:x', status: 'cleared', clearedAt: '2026-10-01T09:00:00.000Z' }], ...over,
  });

  it('AUTO-BAR-R-9-P-005: settles every key whose fire the emit missed, once per key', async () => {
    const t = passDeps();
    const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps: t.deps });
    expect(t.settledKeys).toEqual(['release:deployed:abc123', 'work-item:done:WI-1']);
    expect(out.recovered).toEqual({ keys: 2, settled: 4, failed: 0, truncatedByLimit: false });
  });

  it('a key that fails to settle is counted and the pass continues', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const t = passDeps();
      t.deps.settleFiredKey = vi.fn(async (key: string) => {
        if (key === 'release:deployed:abc123') throw new Error('lock timeout');
        return 1;
      });
      const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps: t.deps });
      expect(out.recovered).toEqual({ keys: 2, settled: 1, failed: 1, truncatedByLimit: false });
    } finally {
      warn.mockRestore();
    }
  });

  it('a dry run lists missed fires and stranded items but settles and repairs nothing', async () => {
    const t = passDeps();
    t.stranded.push(strandedItem('WI-stranded'));
    const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps: t.deps, dryRun: true });
    expect(out.recovered.keys).toBe(2);
    expect(t.settledKeys).toEqual([]);
    expect(out.repaired).toMatchObject({ examined: 1, reopened: 1 });
    expect(t.repairedIds).toEqual([]);
  });

  it('AUTO-BAR-R-10-P-005: reopens a stranded item and tells its holder through the shared follow-up', async () => {
    const t = passDeps();
    t.stranded.push(strandedItem('WI-stranded'));
    const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps: t.deps });
    expect(t.repairedIds).toEqual(['WI-stranded']);
    expect(out.repaired).toEqual({ examined: 1, reopened: 1, skipped: {}, truncatedByLimit: false });
    expect(t.followUps).toEqual([expect.objectContaining({
      featureId: 'WI-stranded', status: 'open', holder: 'su-holder', restored: true, activeRemaining: 0,
      cleared: [], clearedBy: STRANDED_BLOCKED_REPAIR_ACTOR,
    })]);
  });

  it('only decides-eligible items reach the restore, and each refusal is counted by its reason', async () => {
    const t = passDeps();
    t.stranded.push(
      strandedItem('WI-reblocked', { stateChangedAt: '2026-10-02T00:00:00.000Z' }),
      strandedItem('WI-dependency'),
      strandedItem('WI-ok'),
    );
    t.deps.repairStranded = vi.fn(async (c: StrandedBlockedCandidate) => {
      t.repairedIds.push(c.id);
      return c.id === 'WI-dependency' ? 'live-dependency' as const : 'cleared' as const;
    });
    const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps: t.deps });
    expect(t.repairedIds).toEqual(['WI-dependency', 'WI-ok']);
    expect(out.repaired).toEqual({ examined: 3, reopened: 1,
      skipped: { 'reblocked-after-clear': 1, 'live-dependency': 1 }, truncatedByLimit: false });
    expect(t.followUps).toHaveLength(1);
  });

  it('the production follow-up messages the holder about a repair without inventing a cleared blocker', async () => {
    const t = passDeps();
    t.stranded.push(strandedItem('WI-stranded'));
    t.deps.followUp = defaultBlockerReapDeps.followUp;
    for (const spy of Object.values(followUp)) spy.mockClear();
    await sweepWorkItemBlockerDefaults({ now: NOW, deps: t.deps });
    expect(followUp.sendMessage).toHaveBeenCalledTimes(1);
    const opts = (followUp.sendMessage.mock.calls[0] as unknown as [unknown, { to: string[]; summary: string; body: string }])[1];
    expect(opts.to).toEqual(['su-holder']);
    expect(opts.summary).toBe('Returned to open: WI-stranded was still blocked with no active blocker');
    expect(opts.body).toContain(`clearedBy ${STRANDED_BLOCKED_REPAIR_ACTOR}`);
  });

  it('a pass whose deps are absent is skipped, so a fake sweep stays inert', async () => {
    const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps: fakeDeps({}).deps });
    expect(out.recovered).toEqual({ keys: 0, settled: 0, failed: 0, truncatedByLimit: false });
    expect(out.repaired).toEqual({ examined: 0, reopened: 0, skipped: {}, truncatedByLimit: false });
    expect(out.malformed).toEqual({ count: 0, sample: [], truncatedByLimit: false, failed: false });
  });
});

// WI-6554700010030445: items parked by an active blocker row the typed parser drops.
describe('the sweep names items parked by a malformed active blocker row', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `WI-bad-${String(i).padStart(2, '0')}`);

  it('counts the listed items, samples ten, and marks a listing past the limit as a floor', async () => {
    const { deps } = fakeDeps({});
    const asked: number[] = [];
    deps.listMalformedActiveBlockers = async (limit) => {
      asked.push(limit);
      return ids(13).map((id) => ({ id, harness: 'h' }));
    };
    const out = await sweepWorkItemBlockerDefaults({ now: NOW, limit: 12, deps });
    expect(asked).toEqual([13]);
    expect(out.malformed).toEqual({
      count: 12, truncatedByLimit: true, failed: false, sample: ids(10).map((id) => `h/${id}`),
    });
  });

  it('a listing within the limit is a full count', async () => {
    const { deps } = fakeDeps({});
    deps.listMalformedActiveBlockers = async () => ids(2).map((id) => ({ id, harness: 'h' }));
    const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps });
    expect(out.malformed).toEqual({ count: 2, truncatedByLimit: false, failed: false, sample: ['h/WI-bad-00', 'h/WI-bad-01'] });
  });

  it('a failed listing reads as failed rather than as zero, and the sweep still returns its other passes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { deps } = fakeDeps({ 'WI-1': { externalBlockers: [blocker()] } });
      deps.listMalformedActiveBlockers = async () => {
        throw new Error('pg unavailable');
      };
      const out = await sweepWorkItemBlockerDefaults({ now: NOW, deps });
      expect(out.malformed).toEqual({ count: 0, sample: [], truncatedByLimit: false, failed: true });
      expect(out.examined).toBe(1);
      expect(warn).toHaveBeenCalledWith('[blocker-recheck] ! malformed-blocker listing: pg unavailable');
    } finally {
      warn.mockRestore();
    }
  });
});

// event-wait-settlement-2026-10-20 P-006 (D-001 item 1, R-12): existing waits no fire can prove
// get a re-check date so the sweep escalates each to its holder; none is cleared.
describe('backfillUnprovableWaitRecheckDates (P-006)', () => {
  const unprovable = (reason: 'broad' | 'uncatalogued' | 'change-notification'): ExternalConditionReachability => ({
    verdict: 'unknown', basis: 'unmeasured', authoritative: false, evidence: `refused: ${reason}`,
    checkedAt: NOW.toISOString(), uncertifiedReason: reason,
  });
  const VERDICTS: Record<string, ExternalConditionReachability> = {
    'coord:inbox-wake:su-a': unprovable('broad'),
    'git-sync:committed': unprovable('broad'),
    'waiting on the vendor reply': unprovable('uncatalogued'),
    'work-item:status:WI-9': unprovable('change-notification'),
    'release:deployed:abc123def': {
      verdict: 'reachable', basis: 'live-resolver', authoritative: true, evidence: 'catalogued', checkedAt: NOW.toISOString(),
    },
    'flaky:resolver': {
      verdict: 'unknown', basis: 'unmeasured', authoritative: false, evidence: 'reachability resolver failed: boom',
      checkedAt: NOW.toISOString(),
    },
    'fleet:x:expired-gate': {
      verdict: 'impossible', basis: 'expired-registration', authoritative: true,
      evidence: 'the latest authoritative producer registration expired', checkedAt: NOW.toISOString(),
    },
    'harness:x:cancelled-gate': {
      verdict: 'impossible', basis: 'cancelled-registration', authoritative: true,
      evidence: 'the latest authoritative producer registration was cancelled', checkedAt: NOW.toISOString(),
    },
  };
  const row = (over: Partial<ExternalBlockerRecord> & { ref: string }) =>
    blocker({ kind: 'event', capability: 'live-dependency', decideBy: undefined, defaultAction: undefined,
      defaultIfUnanswered: undefined, ...over });

  function backfillDeps(payloads: Record<string, unknown>, opts: { loseRaceOn?: string } = {}) {
    const writes: Array<{ id: string; blockers: unknown; expected: unknown }> = [];
    const classify = vi.fn(async (ref: string) => VERDICTS[ref]!);
    const deps: UnprovableWaitBackfillDeps = {
      listUnstampedWaits: async () => Object.keys(payloads).map((id) => ({ id, harness: 'papercusp', payload: payloads[id] })),
      readPayload: async (id) => ({ payload: payloads[id], family: 'issue', state: 'blocked', holder: 'su-a' }),
      writeBlockers: async (id, _h, blockers, expected) => {
        if (id === opts.loseRaceOn) return false;
        writes.push({ id, blockers, expected });
        payloads[id] = { externalBlockers: blockers };
        return true;
      },
      classify,
    };
    return { deps, writes, classify };
  }

  it('AUTO-BAR-R-12-P-006: selects broad-key and free-text event/gate rows, sets recheckAt, and clears none', async () => {
    const mixed = [
      { ...row({ ref: 'coord:inbox-wake:su-a' }), legacyNote: 'kept' },
      row({ kind: 'gate', ref: 'waiting on the vendor reply' }),
      row({ ref: 'release:deployed:abc123def' }),
      row({ ref: 'git-sync:committed', recheckAt: FUTURE }),
      row({ kind: 'gate', ref: 'plan-lane:some-plan#P-001' }),
      row({ kind: 'runtime', ref: 'runtime:probe' }),
      row({ ref: 'work-item:status:WI-9', status: 'cleared' }),
    ];
    const { deps, writes } = backfillDeps({ 'WI-A': { externalBlockers: mixed } });

    const out = await backfillUnprovableWaitRecheckDates({ now: NOW, deps });

    expect(out).toMatchObject({ items: 1, examined: 3, unprovable: 2, stamped: 2, provable: 1, skipped: {} });
    expect(out.byReason).toEqual({ broad: 1, uncatalogued: 1 });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.expected).toEqual(mixed);
    const after = writes[0]!.blockers as Array<Record<string, unknown>>;
    expect(after.map((b) => b.status)).toEqual(mixed.map((b) => b.status));
    expect(after[0]).toMatchObject({
      ref: 'coord:inbox-wake:su-a', status: 'active', recheckAt: NOW.toISOString(),
      recheckSource: UNPROVABLE_WAIT_BACKFILL_ACTOR, legacyNote: 'kept',
      reachability: expect.objectContaining({ uncertifiedReason: 'broad' }),
    });
    expect(after[1]).toMatchObject({ ref: 'waiting on the vendor reply', recheckAt: NOW.toISOString() });
    expect(after[2]).not.toHaveProperty('recheckAt');
    expect(after[3]!.recheckAt).toBe(FUTURE);
    expect(after[4]).not.toHaveProperty('recheckAt');
    expect(after[5]).not.toHaveProperty('recheckAt');
    expect(after[6]).not.toHaveProperty('recheckAt');
  });

  it('the stamped rows fall due for the very next re-check sweep, which escalates them', async () => {
    const payloads: Record<string, unknown> = { 'WI-A': { externalBlockers: [row({ ref: 'coord:inbox-wake:su-a' })] } };
    await backfillUnprovableWaitRecheckDates({ now: NOW, deps: backfillDeps(payloads).deps });
    const stamped = readExternalBlockers(payloads['WI-A'])[0]!;
    expect(Date.parse(stamped.recheckAt!)).toBeLessThanOrEqual(NOW.getTime());
    expect(stamped.status).toBe('active');
  });

  it('is idempotent: a second run finds nothing left to stamp', async () => {
    const payloads: Record<string, unknown> = { 'WI-A': { externalBlockers: [row({ ref: 'git-sync:committed' })] } };
    const first = backfillDeps(payloads);
    expect((await backfillUnprovableWaitRecheckDates({ now: NOW, deps: first.deps })).stamped).toBe(1);
    const second = backfillDeps(payloads);
    const out = await backfillUnprovableWaitRecheckDates({ now: NOW, deps: second.deps });
    expect(out).toMatchObject({ examined: 0, stamped: 0 });
    expect(second.writes).toHaveLength(0);
  });

  it('a dry run counts but writes nothing; an unmeasured verdict and a lost race stamp nothing', async () => {
    const dry = backfillDeps({ 'WI-A': { externalBlockers: [row({ ref: 'coord:inbox-wake:su-a' })] } });
    expect(await backfillUnprovableWaitRecheckDates({ now: NOW, dryRun: true, deps: dry.deps })).toMatchObject({
      unprovable: 1, stamped: 0,
    });
    expect(dry.writes).toHaveLength(0);

    const flaky = backfillDeps({ 'WI-B': { externalBlockers: [row({ ref: 'flaky:resolver' })] } });
    expect(await backfillUnprovableWaitRecheckDates({ now: NOW, deps: flaky.deps })).toMatchObject({
      unprovable: 0, stamped: 0, skipped: { unmeasured: 1 },
    });
    expect(flaky.writes).toHaveLength(0);

    const raced = backfillDeps({ 'WI-C': { externalBlockers: [row({ ref: 'git-sync:committed' })] } }, { loseRaceOn: 'WI-C' });
    expect(await backfillUnprovableWaitRecheckDates({ now: NOW, deps: raced.deps })).toMatchObject({
      unprovable: 1, stamped: 0, skipped: { 'lost-race': 1 },
    });
  });

  it('AUTO-BAR-R-12-P-006: stamps an announced wait whose registration expired or was cancelled, and clears none', async () => {
    const waits = [row({ ref: 'fleet:x:expired-gate' }), row({ kind: 'gate', ref: 'harness:x:cancelled-gate' })];
    const { deps, writes } = backfillDeps({ 'WI-A': { externalBlockers: waits } });

    const out = await backfillUnprovableWaitRecheckDates({ now: NOW, deps });

    expect(out).toMatchObject({ examined: 2, unprovable: 2, stamped: 2, provable: 0, skipped: {} });
    expect(out.byReason).toEqual({ 'expired-registration': 1, 'cancelled-registration': 1 });
    const after = writes[0]!.blockers as Array<Record<string, unknown>>;
    expect(after.map((b) => [b.status, b.recheckAt])).toEqual([['active', NOW.toISOString()], ['active', NOW.toISOString()]]);
  });

  it('AUTO-BAR-R-12-P-006: retries an unmeasured classification once and stamps the row when the retry measures it', async () => {
    const payloads: Record<string, unknown> = { 'WI-A': { externalBlockers: [row({ ref: 'gate:uncatalogued:x' })] } };
    const { deps, classify } = backfillDeps(payloads);
    classify
      .mockResolvedValueOnce(VERDICTS['flaky:resolver']!)
      .mockResolvedValueOnce(VERDICTS['waiting on the vendor reply']!);

    const out = await backfillUnprovableWaitRecheckDates({ now: NOW, deps });

    expect(out).toMatchObject({ unprovable: 1, stamped: 1, skipped: {} });
    expect(classify).toHaveBeenCalledTimes(2);
    expect(readExternalBlockers(payloads['WI-A'])[0]!.recheckAt).toBe(NOW.toISOString());
  });

  it('classifies each distinct ref once per run', async () => {
    const { deps, classify } = backfillDeps({
      'WI-A': { externalBlockers: [row({ ref: 'coord:inbox-wake:su-a' })] },
      'WI-B': { externalBlockers: [row({ ref: 'coord:inbox-wake:su-a' })] },
    });
    expect((await backfillUnprovableWaitRecheckDates({ now: NOW, deps })).stamped).toBe(2);
    expect(classify).toHaveBeenCalledTimes(1);
  });
});
