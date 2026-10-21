/**
 * work-items-events.test.ts — settled-item event resolution, pure (injected
 * deps) (await-event-primitive-2026-06-05 P-012/P-013, D-006 #4/#5).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  emitUnblockedOnEdgeRemoved,
  emitWorkItemClaimableEvent,
  emitWorkItemSettledEvents,
  isSettledWorkItem,
  liveAssigneeProbe,
  liveBlockedState,
  liveWorkItemClaimableEventPayload,
  liveSettledProbe,
  reconcileCriticalWorkItemAlert,
  selectCriticalWorkItemAlerts,
  settleEdgeReadersFor,
  workItemClaimableUniversalFloor,
  workItemClaimableEventPayload,
  workItemEventPayload,
  workItemIdFromRef,
} from './work-items-events';
import type { WorkItem } from './work-items';

const duplicateAdmissionCheck = vi.hoisted(() => vi.fn(async () => true));
vi.mock('./work-items-admission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./work-items-admission')>()),
  isWorkItemDuplicateAdmitted: duplicateAdmissionCheck,
}));

// WI-10005020: the claimable emitter's default dependency check lazily reads
// `readUnresolvedDepBlockers`; without this partial mock every un-injected emit opens a
// real PG pool (blocked by the unit-layer guard, then swallowed by the fail-open catch),
// so those tests would never exercise the satisfied-dependency path they assume.
const unresolvedDepBlockers = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []));
vi.mock('./work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./work-items')>()),
  readUnresolvedDepBlockers: unresolvedDepBlockers,
}));

beforeEach(() => {
  duplicateAdmissionCheck.mockReset().mockResolvedValue(true);
  unresolvedDepBlockers.mockReset().mockResolvedValue([]);
});

const wi = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 'WI-1',
  kind: 'task',
  family: 'issue',
  harness: null,
  title: 'the work',
  summary: '',
  state: 'resolved',
  assignee: 'su-child',
  takenAt: null,
  lastProgressAt: null,
  assignedBy: 'su-parent',
  createdBy: null,
  // work-item-completion-integrity-2026-07-01 WI-1403: required on WorkItem.
  terminalOwner: null,
  terminalCompletionRef: null,
  terminalCompletionEvidence: null,
  // agent-protocol-authority-semantics-2026-07-26 P-004: also required on WorkItem.
  completionAuthority: null,
  severity: null,
  goalId: null, // WI-37711 — the goal a work-item was filed under; unset on this fixture.
  parent: null,
  payload: null,
  rank: null,
  rankWriter: null,
  rankUpdatedAt: null,
  priority: null,
  origin: 'local',
  auditVerdict: null,
  verifiedAuthorGithubUserId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  closedAt: null,
  ...over,
});

const edge = (srcId: string, dstId: string) => ({
  src: { kind: 'issue', ref: srcId },
  dst: { kind: 'issue', ref: dstId },
  rel: 'blocks',
});

const edgeRel = (srcId: string, dstId: string, rel: string) => ({
  src: { kind: 'issue', ref: srcId },
  dst: { kind: 'issue', ref: dstId },
  rel,
});

describe('helpers', () => {
  it('stamps lifecycle payloads with their capture time without mutating the snapshot', () => {
    const payload = { id: 'WI-OBS', state: 'open' };
    const observedAt = '2026-08-27T10:00:00.000Z';

    expect(workItemEventPayload(payload, observedAt)).toEqual({
      id: 'WI-OBS',
      state: 'open',
      payloadObservedAt: observedAt,
    });
    expect(payload).toEqual({ id: 'WI-OBS', state: 'open' });
  });

  it('isSettledWorkItem matches the per-family terminal sets', () => {
    expect(isSettledWorkItem({ family: 'issue', state: 'resolved' })).toBe(true);
    expect(isSettledWorkItem({ family: 'issue', state: 'done' })).toBe(true);
    expect(isSettledWorkItem({ family: 'issue', state: 'open' })).toBe(false);
    expect(isSettledWorkItem({ family: 'feature', state: 'passed' })).toBe(true);
    expect(isSettledWorkItem({ family: 'feature', state: 'dropped' })).toBe(true);
    expect(isSettledWorkItem({ family: 'feature', state: 'validating' })).toBe(false);
  });

  it('workItemIdFromRef inverts both ref shapes', () => {
    expect(workItemIdFromRef({ kind: 'issue', ref: 'WI-9' })).toEqual({ id: 'WI-9' });
    expect(workItemIdFromRef({ kind: 'feature', ref: 'myharness#F-012' })).toEqual({
      id: 'F-012',
      harness: 'myharness',
    });
    expect(workItemIdFromRef({ kind: 'topic', ref: 'x' })).toBeNull();
  });

  it('builds one claimable payload shape for edge emits and live registration probes', () => {
    const item = wi({
      id: 'WI-30',
      kind: 'task',
      state: 'open',
      assignee: null,
      harness: 'papercusp',
      goalId: 'goal-1',
      payload: { tags: ['byoc'] },
    });
    expect(workItemClaimableEventPayload(item, 'released')).toMatchObject({
      id: 'WI-30',
      kind: 'task',
      harness: 'papercusp',
      assignee: null,
      state: 'open',
      reason: 'released',
      goal: 'goal-1',
      tags: ['byoc'],
    });
    expect(workItemClaimableEventPayload(item)).not.toHaveProperty('reason');
  });
});

describe('critical work-item alert reconciliation (EI-20271572335296930)', () => {
  it.each(['done', 'dropped'])('resolves the exact creation alert when an item is %s', async (state) => {
    const listOpen = vi.fn(async () => [
      { msg_id: 'announce-1', subjectSignature: 'critical-wi-alert:WI-1' },
      // A settled id mentioned by a different alert is context, not its subject.
      { msg_id: 'watchdog-1', subjectSignature: 'watchdog:queue' },
    ]);
    const resolveBatch = vi.fn(async () => ({ resolved: 1 }));

    await reconcileCriticalWorkItemAlert(wi({ id: 'WI-1', state, severity: 'critical', completionAuthority: 'committed' }), {
      listOpen,
      resolveBatch,
    });

    expect(resolveBatch).toHaveBeenCalledWith([
      {
        msg_id: 'announce-1',
        choice: 'work-item-settled',
        resolver: 'system:work-item-settle',
        note: 'WI-1 settled; its creation alert is no longer an active owner-facing condition',
      },
    ]);
  });

  it.each(['critical', 'major', 'minor', 'nit', null] as const)(
    'resolves the creation alert after settlement regardless of current severity (%s)',
    async (severity) => {
      const listOpenBySubject = vi.fn(async (subject: string) => {
        expect(subject).toBe('critical-wi-alert:WI-1');
        return [{ msg_id: 'announce-1', subjectSignature: subject }];
      });
      const resolveBatch = vi.fn(async () => ({ resolved: 1 }));

      await reconcileCriticalWorkItemAlert(wi({ id: 'WI-1', state: 'done', severity, completionAuthority: 'committed' }), {
        listOpenBySubject,
        resolveBatch,
      });

      expect(listOpenBySubject).toHaveBeenCalledTimes(1);
      expect(resolveBatch).toHaveBeenCalledWith([
        {
          msg_id: 'announce-1',
          choice: 'work-item-settled',
          resolver: 'system:work-item-settle',
          note: 'WI-1 settled; its creation alert is no longer an active owner-facing condition',
        },
      ]);
    },
  );

  it('matches the subject signature, never an arbitrary mention of the item id', () => {
    expect(
      selectCriticalWorkItemAlerts(
        [
          { msg_id: 'subject', subjectSignature: 'critical-wi-alert:WI-9' },
          { msg_id: 'mention', subjectSignature: 'incident:WI-9-is-context' },
        ],
        'WI-9',
      ).map((open) => open.msg_id),
    ).toEqual(['subject']);
  });

  it('does not read or resolve for a non-terminal item or without a matching alert', async () => {
    const listOpen = vi.fn(async () => [{ msg_id: 'other', subjectSignature: 'critical-wi-alert:WI-2' }]);
    const resolveBatch = vi.fn(async () => ({ resolved: 0 }));

    await reconcileCriticalWorkItemAlert(wi({ id: 'WI-1', state: 'open', severity: 'critical' }), {
      listOpen,
      resolveBatch,
    });
    await reconcileCriticalWorkItemAlert(wi({ id: 'WI-1', state: 'done', severity: 'critical' }), {
      listOpen,
      resolveBatch,
    });

    expect(listOpen).toHaveBeenCalledOnce();
    expect(resolveBatch).not.toHaveBeenCalled();
  });

  it.each(['proposed', 'validated', 'pending_human', 'invalid', null] as const)(
    'uses terminal wording instead of settled for %s completion authority',
    async (completionAuthority) => {
      const listOpenBySubject = vi.fn(async (subject: string) => [
        { msg_id: 'announce-1', subjectSignature: subject },
      ]);
      const resolveBatch = vi.fn(async () => ({ resolved: 1 }));

      await reconcileCriticalWorkItemAlert(wi({ id: 'WI-1', state: 'done', completionAuthority }), {
        listOpenBySubject,
        resolveBatch,
      });

      expect(resolveBatch).toHaveBeenCalledWith([
        {
          msg_id: 'announce-1',
          choice: 'work-item-terminal',
          resolver: 'system:work-item-settle',
          note: `WI-1 reached terminal state with completion authority '${completionAuthority ?? 'unknown'}'; its creation alert is cleared while completion evidence remains unsettled`,
        },
      ]);
    },
  );
});

// @covers INV-19
describe('emitWorkItemSettledEvents', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('emits work-item:done to the delegator + parent claimant (deduped, never the item agent itself)', async () => {
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null, waiters: 0 }));
    const parent = wi({ id: 'WI-PARENT', assignee: 'su-grand' });
    await emitWorkItemSettledEvents(wi({ parent: 'WI-PARENT' }), {
      emit: emit as never,
      getItem: vi.fn(async (id: string) => (id === 'WI-PARENT' ? parent : null)) as never,
      listOut: vi.fn(async () => []) as never,
      listIn: vi.fn(async () => []) as never,
    });
    expect(emit).toHaveBeenCalledTimes(1);
    const arg = (emit.mock.calls[0] as unknown as [{ key: string; to: string[] }])[0];
    expect(arg.key).toBe('work-item:done:WI-1');
    expect(arg.to.sort()).toEqual(['su-grand', 'su-parent']);
  });

  it('reports terminal lifecycle state separately from proposed completion authority', async () => {
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null, waiters: 0 }));
    await emitWorkItemSettledEvents(wi({ id: 'WI-PROPOSED', state: 'done', completionAuthority: 'proposed' }), {
      emit: emit as never,
      getItem: vi.fn(async () => null) as never,
      listOut: vi.fn(async () => []) as never,
      listIn: vi.fn(async () => []) as never,
    });

    const arg = (emit.mock.calls[0] as unknown as [{ key: string; summary: string; payload: Record<string, unknown> }])[0];
    expect(arg.key).toBe('work-item:done:WI-PROPOSED');
    expect(arg.summary).toBe("WI-PROPOSED reached terminal state 'done' (completion authority: proposed): the work");
    expect(arg.summary).not.toContain('settled');
    expect(arg.payload).toMatchObject({ state: 'done', completionAuthority: 'proposed' });
  });

  it('emits targeted claim:released when terminalization clears a prior assignee without broad claimable co-fire', async () => {
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null, waiters: 0 }));
    await emitWorkItemSettledEvents(wi({ id: 'WI-TERMINAL', assignee: null, state: 'done' }), {
      emit: emit as never,
      priorAssignee: 'su-former-holder',
      listOut: vi.fn(async () => []) as never,
      listIn: vi.fn(async () => []) as never,
    });

    const keys = emit.mock.calls.map((c) => (c as unknown as [{ key: string }])[0].key);
    expect(keys).toEqual(['claim:released:WI-TERMINAL', 'work-item:done:WI-TERMINAL']);
    expect(keys).not.toContain('work-item:claimable');
  });

  it('runs critical-alert reconciliation as an independent settle leg', async () => {
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null, waiters: 0 }));
    const reconcile = vi.fn(async () => {});
    await emitWorkItemSettledEvents(wi({ severity: 'critical' }), {
      emit: emit as never,
      reconcileCriticalWorkItemAlert: reconcile,
      listOut: vi.fn(async () => []) as never,
      listIn: vi.fn(async () => []) as never,
    });
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'WI-1', severity: 'critical', state: 'resolved' }),
    );
  });

  it('fires work-item:unblocked for a dependent whose LAST blocker settled, targeted at its claimant', async () => {
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null, waiters: 0 }));
    const dependent = wi({ id: 'WI-DEP', state: 'open', assignee: 'su-claimant' });
    const otherBlockerSettled = wi({ id: 'WI-B2', state: 'closed' });
    await emitWorkItemSettledEvents(wi(), {
      emit: emit as never,
      getItem: vi.fn(async (id: string) =>
        id === 'WI-DEP' ? dependent : id === 'WI-B2' ? otherBlockerSettled : null,
      ) as never,
      listOut: vi.fn(async (_r: unknown, o?: { rel?: string }) =>
        o?.rel === 'blocks' ? [edge('WI-1', 'WI-DEP')] : [],
      ) as never,
      listIn: vi.fn(async (_r: unknown, o?: { rel?: string }) =>
        o?.rel === 'blocks' ? [edge('WI-1', 'WI-DEP'), edge('WI-B2', 'WI-DEP')] : [],
      ) as never,
    });
    const keys = emit.mock.calls.map((c) => (c as unknown as [{ key: string }])[0].key);
    expect(keys).toContain('work-item:done:WI-1');
    expect(keys).toContain('work-item:unblocked:WI-DEP');
    const unblocked = (
      emit.mock.calls.find((c) =>
        (c as unknown as [{ key: string }])[0].key.startsWith('work-item:unblocked'),
      ) as unknown as [{ to: string[]; payload: { clearedBy: string } }]
    )[0];
    expect(unblocked.to).toEqual(['su-claimant']);
    expect(unblocked.payload.clearedBy).toBe('WI-1');
  });

  it('does NOT fire unblocked while another blocker is still live, nor for an already-settled dependent', async () => {
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null, waiters: 0 }));
    const dependent = wi({ id: 'WI-DEP', state: 'open', assignee: 'su-claimant' });
    const liveBlocker = wi({ id: 'WI-B2', state: 'open' });
    const settledDep = wi({ id: 'WI-DONE-DEP', state: 'resolved' });
    await emitWorkItemSettledEvents(wi(), {
      emit: emit as never,
      getItem: vi.fn(async (id: string) =>
        id === 'WI-DEP' ? dependent : id === 'WI-B2' ? liveBlocker : id === 'WI-DONE-DEP' ? settledDep : null,
      ) as never,
      listOut: vi.fn(async (_r: unknown, o?: { rel?: string }) =>
        o?.rel === 'blocks' ? [edge('WI-1', 'WI-DEP'), edge('WI-1', 'WI-DONE-DEP')] : [],
      ) as never,
      listIn: vi.fn(async (_r: unknown, o?: { rel?: string }) =>
        o?.rel === 'blocks' ? [edge('WI-1', 'WI-DEP'), edge('WI-B2', 'WI-DEP')] : [],
      ) as never,
    });
    const keys = emit.mock.calls.map((c) => (c as unknown as [{ key: string }])[0].key);
    expect(keys).toEqual(['work-item:done:WI-1']); // no unblocked fires
  });

  it('an emit failure is swallowed (a state write must never break)', async () => {
    await expect(
      emitWorkItemSettledEvents(wi(), {
        emit: vi.fn(async () => {
          throw new Error('engine down');
        }) as never,
        getItem: vi.fn(async () => null) as never,
        listOut: vi.fn(async () => []) as never,
        listIn: vi.fn(async () => []) as never,
      }),
    ).resolves.toBeUndefined();
  });

  // P-008 (linking-notify-family-hardening) recurrence guard: the done-emit and
  // the unblocked loop are INDEPENDENT fail-soft scopes. A single shared try
  // used to drop the unblocked emits the moment the done-emit threw — so pin
  // that a throwing work-item:done STILL lets work-item:unblocked fire.
  it('a throwing work-item:done still lets the unblocked loop fire (independent fail-soft scopes)', async () => {
    const emit = vi.fn(async (opts: { key: string }) => {
      if (opts.key.startsWith('work-item:done')) throw new Error('done-emit engine down');
      return { ok: true as const, key: opts.key, woken: 0, notified: [] as string[], msgId: null, waiters: 0 };
    });
    const dependent = wi({ id: 'WI-DEP', state: 'open', assignee: 'su-claimant' });
    await expect(
      emitWorkItemSettledEvents(wi(), {
        emit: emit as never,
        getItem: vi.fn(async (id: string) => (id === 'WI-DEP' ? dependent : null)) as never,
        listOut: vi.fn(async (_r: unknown, o?: { rel?: string }) =>
          o?.rel === 'blocks' ? [edge('WI-1', 'WI-DEP')] : [],
        ) as never,
        listIn: vi.fn(async (_r: unknown, o?: { rel?: string }) =>
          o?.rel === 'blocks' ? [edge('WI-1', 'WI-DEP')] : [],
        ) as never,
      }),
    ).resolves.toBeUndefined();
    const keys = emit.mock.calls.map((c) => (c as unknown as [{ key: string }])[0].key);
    expect(keys).toContain('work-item:done:WI-1'); // the done-emit was attempted and threw…
    expect(keys).toContain('work-item:unblocked:WI-DEP'); // …yet the freed dependent was still woken
    const unblocked = (
      emit.mock.calls.find((c) =>
        (c as unknown as [{ key: string }])[0].key.startsWith('work-item:unblocked'),
      ) as unknown as [{ to: string[] }]
    )[0];
    expect(unblocked.to).toEqual(['su-claimant']);
  });
});

// WI-4034 DEFECT 1 (the unlink gap): unlinkWorkItem never re-checked whether
// the edge it just removed was the dependent's LAST live blocker, so
// work-item:unblocked never fired on an UNLINK — only on the blocker settling.
// @covers INV-19
describe('emitUnblockedOnEdgeRemoved (WI-4034)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('fires work-item:unblocked when the removed edge was the LAST live blocker', async () => {
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null, waiters: 0 }));
    const dependent = wi({ id: 'WI-DEP', state: 'open', assignee: 'su-claimant' });
    // the edge to the just-removed blocker is ALREADY gone from the store by
    // the time this runs — listIn returns only the (settled) other blocker.
    const otherBlockerSettled = wi({ id: 'WI-B2', state: 'closed' });
    await emitUnblockedOnEdgeRemoved({ kind: 'issue', ref: 'WI-DEP' }, 'WI-1', {
      emit: emit as never,
      getItem: vi.fn(async (id: string) =>
        id === 'WI-DEP' ? dependent : id === 'WI-B2' ? otherBlockerSettled : null,
      ) as never,
      listIn: vi.fn(async () => [edge('WI-B2', 'WI-DEP')]) as never,
    });
    expect(emit).toHaveBeenCalledOnce();
    const arg = (emit.mock.calls[0] as unknown as [{ key: string; to: string[]; payload: { clearedBy: string } }])[0];
    expect(arg.key).toBe('work-item:unblocked:WI-DEP');
    expect(arg.to).toEqual(['su-claimant']);
    expect(arg.payload.clearedBy).toBe('WI-1');
  });

  it('does NOT fire while another blocker is still live', async () => {
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null, waiters: 0 }));
    const dependent = wi({ id: 'WI-DEP', state: 'open', assignee: 'su-claimant' });
    const liveBlocker = wi({ id: 'WI-B2', state: 'open' });
    await emitUnblockedOnEdgeRemoved({ kind: 'issue', ref: 'WI-DEP' }, 'WI-1', {
      emit: emit as never,
      getItem: vi.fn(async (id: string) =>
        id === 'WI-DEP' ? dependent : id === 'WI-B2' ? liveBlocker : null,
      ) as never,
      listIn: vi.fn(async () => [edge('WI-B2', 'WI-DEP')]) as never,
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it('does NOT fire for an already-settled dependent', async () => {
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null, waiters: 0 }));
    const settledDependent = wi({ id: 'WI-DEP', state: 'resolved' });
    await emitUnblockedOnEdgeRemoved({ kind: 'issue', ref: 'WI-DEP' }, 'WI-1', {
      emit: emit as never,
      getItem: vi.fn(async () => settledDependent) as never,
      listIn: vi.fn(async () => []) as never,
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it('fires when there were never any other blockers at all (listIn empty)', async () => {
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null, waiters: 0 }));
    const dependent = wi({ id: 'WI-DEP', state: 'open', assignee: 'su-claimant' });
    await emitUnblockedOnEdgeRemoved({ kind: 'issue', ref: 'WI-DEP' }, 'WI-1', {
      emit: emit as never,
      getItem: vi.fn(async () => dependent) as never,
      listIn: vi.fn(async () => []) as never,
    });
    expect(emit).toHaveBeenCalledOnce();
  });

  it('an emit failure is swallowed (never throws)', async () => {
    await expect(
      emitUnblockedOnEdgeRemoved({ kind: 'issue', ref: 'WI-DEP' }, 'WI-1', {
        emit: vi.fn(async () => {
          throw new Error('engine down');
        }) as never,
        getItem: vi.fn(async () => wi({ id: 'WI-DEP', state: 'open' })) as never,
        listIn: vi.fn(async () => []) as never,
      }),
    ).resolves.toBeUndefined();
  });
});

type EmitOpts = import('./events/await/engine').EmitAwaitedEventOpts;
const typedEmit = () =>
  vi.fn(async (_opts: EmitOpts) => ({
    ok: true as const,
    key: '',
    woken: 0,
    notified: [] as string[],
    msgId: null,
    waiters: 0,
  }));

describe('emitWorkItemClaimedEvent', () => {
  it('fires work-item:claimed:<id> with the assignee in payload', async () => {
    const emit = typedEmit();
    const { emitWorkItemClaimedEvent } = await import('./work-items-events');
    emitWorkItemClaimedEvent(wi({ id: 'WI-7', title: 'claim me' }), 'su-claimant', { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0]).toMatchObject({
      key: 'work-item:claimed:WI-7',
      source: 'work-items',
      payload: expect.objectContaining({ id: 'WI-7', assignee: 'su-claimant' }),
    });
  });

  it('never rejects on an emit failure (warns instead)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { emitWorkItemClaimedEvent } = await import('./work-items-events');
    const emit = vi.fn(async () => {
      throw new Error('pg down');
    });
    expect(() => emitWorkItemClaimedEvent(wi(), 'su-x', { emit: emit as never })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('claimed-event'));
    warn.mockRestore();
  });

  // EI-6788: a fire-and-forget emit whose query outlives the Postgres pool it
  // ran on (a rig/test tearing down mid-emit) rejects with postgres.js
  // CONNECTION_ENDED — expected teardown noise, NOT a warn (else it flakes any
  // rig-based integration test via vitest-fail-on-console). Same for the partial
  // test schema ("… does not exist"). failSoft must swallow both silently.
  it.each([
    [
      'CONNECTION_ENDED by code',
      Object.assign(new Error('write CONNECTION_ENDED localhost:36195'), { code: 'CONNECTION_ENDED' }),
    ],
    ['CONNECTION_ENDED by message only', new Error('write CONNECTION_ENDED 127.0.0.1:5432')],
    ['CONNECTION_DESTROYED by code', Object.assign(new Error('boom'), { code: 'CONNECTION_DESTROYED' })],
    ['partial-schema does not exist', new Error('relation "harness_shared.work_items" does not exist')],
  ])('swallows expected fire-and-forget teardown noise WITHOUT warning: %s', async (_label, thrown) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { emitWorkItemClaimedEvent } = await import('./work-items-events');
    const emit = vi.fn(async () => {
      throw thrown;
    });
    expect(() => emitWorkItemClaimedEvent(wi(), 'su-x', { emit: emit as never })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('emitClaimReleasedEvent (P-105)', () => {
  it('fires claim:released:<id>, awaiter-only (no `to`), with the id in payload', async () => {
    const emit = typedEmit();
    const { emitClaimReleasedEvent } = await import('./work-items-events');
    emitClaimReleasedEvent(wi({ id: 'WI-9', title: 'free me' }), { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0]).toMatchObject({
      key: 'claim:released:WI-9',
      source: 'work-items',
      payload: expect.objectContaining({ id: 'WI-9', payloadObservedAt: expect.any(String) }),
    });
    const observedAt = (emit.mock.calls[0][0].payload as { payloadObservedAt: string }).payloadObservedAt;
    expect(Number.isNaN(Date.parse(observedAt))).toBe(false);
    expect(emit.mock.calls[0][0].to).toBeUndefined();
  });

  it('never rejects on an emit failure (warns instead)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { emitClaimReleasedEvent } = await import('./work-items-events');
    const emit = vi.fn(async () => {
      throw new Error('pg down');
    });
    expect(() => emitClaimReleasedEvent(wi(), { emit: emit as never })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('claim-released-event'));
    warn.mockRestore();
  });

  // EI-15019: EI-128 (a harness:null, `*p2p*`-title-glob-excluded bug) was getting
  // claimed and quarantine-released by claim-spec-store.ts's tier-3 issue fallback
  // every ~3-4min, and EACH release re-fired the broad `work-item:claimable` key —
  // waking all 7 live awaiters for a round-trip that never changed the item's
  // observable claimability (it was pool-claimable before the claim AND after the
  // release). `announceClaimable:false` is the caller's signal that this specific
  // release is exactly that internal, information-free round-trip.
  it('announceClaimable:false suppresses the work-item:claimable co-fire but still fires claim:released:<id>', async () => {
    const emit = typedEmit();
    const { emitClaimReleasedEvent } = await import('./work-items-events');
    emitClaimReleasedEvent(wi({ id: 'WI-36', state: 'open', assignee: null, harness: null }), {
      emit,
      announceClaimable: false,
    });
    await new Promise((r) => setTimeout(r, 0));
    const keys = emit.mock.calls.map((c) => c[0].key);
    expect(keys).toEqual(['claim:released:WI-36']);
    expect(keys).not.toContain('work-item:claimable');
  });

  it('announceClaimable omitted (default) still co-fires work-item:claimable — unchanged for every other caller', async () => {
    const emit = typedEmit();
    const { emitClaimReleasedEvent } = await import('./work-items-events');
    emitClaimReleasedEvent(wi({ id: 'WI-37', state: 'open', assignee: null }), { emit });
    await new Promise((r) => setTimeout(r, 0));
    const keys = emit.mock.calls.map((c) => c[0].key).sort();
    expect(keys).toEqual(['claim:released:WI-37', 'work-item:claimable']);
  });

  // EI-18146409983480148: a "wait for an external condition to clear" item (a still-stale
  // watchdog metric, a pending decay window) gets re-claimed/re-investigated/re-released by
  // a rotating cast of agents every few minutes — each release used to re-wake EVERY live
  // `work-item:claimable` awaiter for zero new information (observed: 3 broad wakes on one
  // item in <30min). The targeted claim:released:<id> key must still fire unconditionally.
  it('EI-18146409983480148: a second release of the SAME item within the throttle window suppresses the broad co-fire (claim:released:<id> still fires)', async () => {
    const { emitClaimReleasedEvent } = await import('./work-items-events');
    const emit1 = typedEmit();
    emitClaimReleasedEvent(wi({ id: 'WI-40', state: 'open', assignee: null }), { emit: emit1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit1.mock.calls.map((c) => c[0].key).sort()).toEqual(['claim:released:WI-40', 'work-item:claimable']);

    const emit2 = typedEmit();
    emitClaimReleasedEvent(wi({ id: 'WI-40', state: 'open', assignee: null }), { emit: emit2 });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit2.mock.calls.map((c) => c[0].key)).toEqual(['claim:released:WI-40']);
  });

  it('EI-18146409983480148: the release throttle is PER-ITEM — a different id still co-fires normally', async () => {
    const { emitClaimReleasedEvent } = await import('./work-items-events');
    emitClaimReleasedEvent(wi({ id: 'WI-42', state: 'open', assignee: null }), { emit: typedEmit() });
    await new Promise((r) => setTimeout(r, 0));

    const emit = typedEmit();
    emitClaimReleasedEvent(wi({ id: 'WI-43', state: 'open', assignee: null }), { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit.mock.calls.map((c) => c[0].key).sort()).toEqual(['claim:released:WI-43', 'work-item:claimable']);
  });

  it('EI-18146409983480148: __resetClaimableReleaseThrottleForTests clears the throttle so a reused id fires again', async () => {
    const { emitClaimReleasedEvent, __resetClaimableReleaseThrottleForTests } = await import('./work-items-events');
    emitClaimReleasedEvent(wi({ id: 'WI-44', state: 'open', assignee: null }), { emit: typedEmit() });
    await new Promise((r) => setTimeout(r, 0));
    __resetClaimableReleaseThrottleForTests();
    const emit = typedEmit();
    emitClaimReleasedEvent(wi({ id: 'WI-44', state: 'open', assignee: null }), { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit.mock.calls.map((c) => c[0].key).sort()).toEqual(['claim:released:WI-44', 'work-item:claimable']);
  });
});

describe('emitWorkItemBlockedEvent', () => {
  it('fires work-item:blocked:<id> notifying the delegator', async () => {
    const emit = typedEmit();
    const { emitWorkItemBlockedEvent } = await import('./work-items-events');
    emitWorkItemBlockedEvent(wi({ id: 'WI-8', state: 'blocked' }), { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0]).toMatchObject({
      key: 'work-item:blocked:WI-8',
      to: ['su-parent'],
    });
  });

  it('self-delegated items notify nobody', async () => {
    const emit = typedEmit();
    const { emitWorkItemBlockedEvent } = await import('./work-items-events');
    emitWorkItemBlockedEvent(wi({ assignedBy: 'su-child', assignee: 'su-child' }), { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit.mock.calls[0][0]).toMatchObject({ to: [] });
  });
});

describe('emitWorkItemCreatedEvent (EI-8296)', () => {
  it('fires the GLOBAL work-item:created key with id/kind/severity/harness/title in payload', async () => {
    const emit = typedEmit();
    const { emitWorkItemCreatedEvent } = await import('./work-items-events');
    emitWorkItemCreatedEvent(wi({ id: 'WI-20', kind: 'bug', severity: null, harness: 'papercusp', title: 'new bug' }), {
      emit,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0]).toMatchObject({
      key: 'work-item:created',
      source: 'work-items',
      payload: expect.objectContaining({
        id: 'WI-20',
        kind: 'bug',
        severity: null,
        harness: 'papercusp',
        title: 'new bug',
      }),
    });
  });

  it('ALSO fires the severity-scoped key when the item carries a severity (dual-emit, mirrors release:deployed)', async () => {
    const emit = typedEmit();
    const { emitWorkItemCreatedEvent } = await import('./work-items-events');
    emitWorkItemCreatedEvent(wi({ id: 'WI-21', kind: 'bug', severity: 'critical', title: 'a critical bug' }), { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledTimes(2);
    const keys = emit.mock.calls.map((c) => c[0].key).sort();
    expect(keys).toEqual(['work-item:created', 'work-item:created:critical']);
  });

  it('never rejects on an emit failure (warns instead)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { emitWorkItemCreatedEvent } = await import('./work-items-events');
    const emit = vi.fn(async () => {
      throw new Error('pg down');
    });
    expect(() => emitWorkItemCreatedEvent(wi(), { emit: emit as never })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('created-event'));
    warn.mockRestore();
  });
});

describe('emitWorkItemClaimableEvent (composable-event-awaits P-007)', () => {
  it('shares the intake-stage floor with ordinary scheduler claims while preserving reproduction validation work', async () => {
    const pending = wi({
      id: 'EI-INTAKE-PENDING',
      kind: 'bug',
      family: 'issue',
      state: 'open',
      assignee: null,
      payload: { agentReview: { status: 'pending' } },
    });
    expect(workItemClaimableUniversalFloor(pending)).toBe(false);

    const pendingEmit = typedEmit();
    emitWorkItemClaimableEvent(pending, 'released', {
      emit: pendingEmit,
      duplicateAdmissionCheck: async () => true,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(pendingEmit).not.toHaveBeenCalled();
    await expect(
      liveWorkItemClaimableEventPayload(pending.id, pending.harness ?? undefined, {
        getItem: vi.fn(async () => pending) as never,
        duplicateAdmissionCheck: async () => true,
      }),
    ).resolves.toBeNull();

    const reproduction = wi({
      id: 'EI-INTAKE-REPRO',
      kind: 'bug',
      family: 'issue',
      state: 'open',
      assignee: null,
      payload: { agentReview: { status: 'revision-requested', revisionKind: 'reproduction' } },
    });
    expect(workItemClaimableUniversalFloor(reproduction)).toBe(true);
    const reproductionEmit = typedEmit();
    emitWorkItemClaimableEvent(reproduction, 'released', {
      emit: reproductionEmit,
      duplicateAdmissionCheck: async () => true,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(reproductionEmit).toHaveBeenCalledOnce();
  });

  it.each([
    ['owner-action', { needsOwnerAction: true }],
    ['active-external-blocker', {
      externalBlockers: [{
        kind: 'event', capability: 'live-dependency', capabilitySource: 'inferred', ref: 'event:x',
        summary: 'wait', status: 'active', createdAt: '2026-01-01T00:00:00.000Z',
        createdBy: 'su-test', updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    }],
    ['federation-detector', { _ei: { created_by: 'system:replication-liveness' } }],
  ])('does not wake the broad pool for the universal %s floor', async (_name, payload) => {
    const item = wi({ id: `WI-UNIVERSAL-${_name}`, state: 'open', assignee: null, payload });
    expect(workItemClaimableUniversalFloor(item)).toBe(false);
    const emit = typedEmit();
    emitWorkItemClaimableEvent(item, 'released', { emit, duplicateAdmissionCheck: async () => true });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).not.toHaveBeenCalled();
  });

  it('does not wake loop-noise or already-completed rows that remain open', async () => {
    const loopNoise = wi({ id: 'WI-LOOP-NOISE', state: 'open', assignee: null, title: 'AUTO loop iteration: carry' });
    const completed = wi({
      id: 'WI-COMPLETED-OPEN', state: 'open', assignee: null,
      terminalOwner: 'su-closer', terminalCompletionRef: 'commit:abc',
    });
    for (const item of [loopNoise, completed]) {
      expect(workItemClaimableUniversalFloor(item)).toBe(false);
      const emit = typedEmit();
      emitWorkItemClaimableEvent(item, 'released', { emit, duplicateAdmissionCheck: async () => true });
      await new Promise((r) => setTimeout(r, 0));
      expect(emit).not.toHaveBeenCalled();
    }
  });

  it('announces a newly admitted row with the canonical claimability guard', async () => {
    const emit = typedEmit();
    emitWorkItemClaimableEvent(
      wi({ id: 'WI-admitted', state: 'open', assignee: null }),
      'admitted',
      { emit, duplicateAdmissionCheck: async () => true },
    );
    emitWorkItemClaimableEvent(
      wi({ id: 'WI-assigned', state: 'open', assignee: 'su-holder' }),
      'admitted',
      { emit, duplicateAdmissionCheck: async () => true },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0]).toMatchObject({
      key: 'work-item:claimable',
      payload: expect.objectContaining({ id: 'WI-admitted', reason: 'admitted' }),
    });
  });

  // WI-10005020 (D-008 #4b): a blocked→open restore of a row that still has an unsatisfied
  // `blocks` edge must not announce work that no claim can take.
  it('does not announce a row whose blocks dependency edges are unsatisfied', async () => {
    const emit = typedEmit();
    const unresolvedDependencyCheck = vi.fn(async () => true);
    const item = wi({ id: 'WI-edge-blocked', state: 'open', assignee: null });
    emitWorkItemClaimableEvent(item, 'unblocked', {
      emit,
      duplicateAdmissionCheck: async () => true,
      unresolvedDependencyCheck,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(unresolvedDependencyCheck).toHaveBeenCalledWith(item);
    expect(emit).not.toHaveBeenCalled();
  });

  it('announces a row whose dependency edges are all satisfied', async () => {
    const emit = typedEmit();
    emitWorkItemClaimableEvent(wi({ id: 'WI-edge-clear', state: 'open', assignee: null }), 'unblocked', {
      emit,
      duplicateAdmissionCheck: async () => true,
      unresolvedDependencyCheck: async () => false,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0]).toMatchObject({
      key: 'work-item:claimable',
      payload: expect.objectContaining({ id: 'WI-edge-clear', reason: 'unblocked' }),
    });
  });

  it('fails open when the dependency read fails (the scheduler floor stays authoritative)', async () => {
    const emit = typedEmit();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    emitWorkItemClaimableEvent(wi({ id: 'WI-edge-unknown', state: 'open', assignee: null }), 'unblocked', {
      emit,
      duplicateAdmissionCheck: async () => true,
      unresolvedDependencyCheck: async () => {
        throw new Error('pg unavailable');
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('the default dependency check consults readUnresolvedDepBlockers with the row harness', async () => {
    const emit = typedEmit();
    unresolvedDepBlockers.mockResolvedValue([{ blockerId: 'WI-upstream' }]);
    emitWorkItemClaimableEvent(
      wi({ id: 'WI-edge-default', state: 'open', assignee: null, harness: 'papercusp' }),
      'unblocked',
      { emit, duplicateAdmissionCheck: async () => true },
    );
    await vi.waitFor(() => expect(unresolvedDepBlockers).toHaveBeenCalledWith('WI-edge-default', 'papercusp'));
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).not.toHaveBeenCalled();
  });

  it('fires the GLOBAL work-item:claimable key with id/kind/severity/harness/title/state/reason/assignee', async () => {
    const emit = typedEmit();
    const { emitWorkItemClaimableEvent } = await import('./work-items-events');
    emitWorkItemClaimableEvent(
      wi({ id: 'WI-30', kind: 'task', state: 'open', assignee: null, harness: 'papercusp', title: 'fresh work' }),
      'created',
      { emit },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0]).toMatchObject({
      key: 'work-item:claimable',
      source: 'work-items',
      payload: expect.objectContaining({
        id: 'WI-30',
        kind: 'task',
        harness: 'papercusp',
        title: 'fresh work',
        state: 'open',
        reason: 'created',
        assignee: null,
      }),
    });
  });

  it('EI-22727753112811582: suppresses pending duplicate-screening rows in both emit and registration latch', async () => {
    const emit = typedEmit();
    duplicateAdmissionCheck.mockResolvedValue(false);
    const { emitWorkItemClaimableEvent } = await import('./work-items-events');
    const item = wi({ id: 'WI-ADMISSION-PENDING', state: 'open', assignee: null, harness: 'papercusp' });

    emitWorkItemClaimableEvent(item, 'created', { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(duplicateAdmissionCheck).toHaveBeenCalledWith(item.id);
    expect(emit).not.toHaveBeenCalled();

    await expect(
      liveWorkItemClaimableEventPayload(item.id, item.harness ?? undefined, {
        getItem: vi.fn(async () => item) as never,
      }),
    ).resolves.toBeNull();
    expect(duplicateAdmissionCheck).toHaveBeenLastCalledWith(item.id);
  });

  it('EI-22727753112811582: preserves claimable emit and latch for admitted rows', async () => {
    const emit = typedEmit();
    const admitted = vi.fn(async () => true);
    const { emitWorkItemClaimableEvent } = await import('./work-items-events');
    const item = wi({ id: 'WI-ADMITTED', state: 'open', assignee: null, harness: 'papercusp' });

    emitWorkItemClaimableEvent(item, 'created', { emit, duplicateAdmissionCheck: admitted });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledOnce();

    await expect(
      liveWorkItemClaimableEventPayload(item.id, item.harness ?? undefined, {
        getItem: vi.fn(async () => item) as never,
        duplicateAdmissionCheck: admitted,
      }),
    ).resolves.toMatchObject({ id: item.id, state: 'open' });
  });

  it("EI-14161: carries the item's own payload.tags so a spec's tag-based exclusion is derivable", async () => {
    const emit = typedEmit();
    const { emitWorkItemClaimableEvent } = await import('./work-items-events');
    emitWorkItemClaimableEvent(
      wi({
        id: 'EI-128',
        kind: 'bug',
        state: 'open',
        assignee: null,
        title: 'p2p-perf regression',
        payload: { tags: ['p2p', 'rig'] },
      }),
      'released',
      { emit },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(emit.mock.calls[0][0]).toMatchObject({
      payload: expect.objectContaining({ tags: ['p2p', 'rig'] }),
    });
  });

  it('EI-14161: a tag-less item carries an empty tags array (never undefined — payload_filter needs a stable shape)', async () => {
    const emit = typedEmit();
    const { emitWorkItemClaimableEvent } = await import('./work-items-events');
    emitWorkItemClaimableEvent(wi({ id: 'WI-34', state: 'open', assignee: null }), 'created', { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit.mock.calls[0][0]).toMatchObject({ payload: expect.objectContaining({ tags: [] }) });
  });

  it('the guard drops an ASSIGNED item — claimable never advertises work a pull would refuse', async () => {
    const emit = typedEmit();
    const { emitWorkItemClaimableEvent } = await import('./work-items-events');
    emitWorkItemClaimableEvent(wi({ id: 'WI-31', state: 'open', assignee: 'su-holder' }), 'created', { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).not.toHaveBeenCalled();
  });

  it('the guard drops a NON-CLAIMABLE state (wip / blocked / terminal); claimable states pass', async () => {
    const { emitWorkItemClaimableEvent } = await import('./work-items-events');
    for (const state of ['wip', 'blocked', 'resolved', 'closed']) {
      const emit = typedEmit();
      emitWorkItemClaimableEvent(wi({ id: 'WI-32', state, assignee: null }), 'released', { emit });
      await new Promise((r) => setTimeout(r, 0));
      expect(emit, `state '${state}' must not fire`).not.toHaveBeenCalled();
    }
    for (const state of ['open', 'failing']) {
      const emit = typedEmit();
      emitWorkItemClaimableEvent(wi({ id: 'WI-33', state, assignee: null }), 'released', { emit });
      await new Promise((r) => setTimeout(r, 0));
      expect(emit, `state '${state}' must fire`).toHaveBeenCalledOnce();
    }
  });

  it('EI-18128621906886568: the guard drops a claim-hold PARKED item even with no assignee — a parked row must never advertise as claimable', async () => {
    const { emitWorkItemClaimableEvent } = await import('./work-items-events');
    for (const payload of [{ _claimHold: true }, { _claimHold: 'true', held_open_by: 'su-x' }]) {
      const emit = typedEmit();
      emitWorkItemClaimableEvent(wi({ id: 'WI-38', state: 'open', assignee: null, payload }), 'released', { emit });
      await new Promise((r) => setTimeout(r, 0));
      expect(emit, `payload ${JSON.stringify(payload)} must not fire`).not.toHaveBeenCalled();
    }
    // sanity: an unparked, unassigned, claimable row still fires (the guard isn't over-broad).
    const emit = typedEmit();
    emitWorkItemClaimableEvent(
      wi({ id: 'WI-39', state: 'open', assignee: null, payload: { _claimHold: false } }),
      'released',
      { emit },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledOnce();
  });

  it('EI-266267: drops queued or screen-held admission recovery from claimable wakes', async () => {
    const { emitWorkItemClaimableEvent } = await import('./work-items-events');
    for (const state of ['queued', 'held']) {
      const emit = typedEmit();
      emitWorkItemClaimableEvent(
        wi({ id: `WI-recovery-${state}`, state: 'open', assignee: null,
          payload: { _admissionRecovery: { state } } }),
        'released',
        { emit },
      );
      await new Promise((r) => setTimeout(r, 0));
      expect(emit, `recovery state '${state}' must not fire`).not.toHaveBeenCalled();
    }
    const delivered = typedEmit();
    emitWorkItemClaimableEvent(
      wi({ id: 'WI-recovery-delivered', state: 'open', assignee: null,
        payload: { _admissionRecovery: { state: 'delivered' } } }),
      'released',
      { emit: delivered },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(delivered).toHaveBeenCalledOnce();
  });

  it('EI-22773307703217310: drops observation-lane rows from both the emit and registration latch', async () => {
    const emit = typedEmit();
    const item = wi({
      id: 'EI-OBS-CLAIMABLE',
      state: 'open',
      assignee: null,
      payload: { lane: 'observation' },
    });
    const getItem = vi.fn(async () => item);

    emitWorkItemClaimableEvent(item, 'released', { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).not.toHaveBeenCalled();

    await expect(liveWorkItemClaimableEventPayload(item.id, item.harness ?? undefined, { getItem })).resolves.toBeNull();
    expect(duplicateAdmissionCheck).not.toHaveBeenCalled();
  });

  it('keeps a non-observation lane claimable', async () => {
    const emit = typedEmit();
    const item = wi({
      id: 'WI-OBS-NOT',
      state: 'open',
      assignee: null,
      payload: { lane: 'improvement' },
    });

    emitWorkItemClaimableEvent(item, 'released', { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledOnce();
  });

  it('EI-22699169150878155: drops a plan-linked item whose plan lane is blocked', async () => {
    const emit = typedEmit();
    const planItemLaneBlockReason = vi.fn(async () => ({
      reason: 'plan-item frozen-candidate-carry-and-launch-fail-closed-2026-09-07#P-005 is effectively blocked',
      planSlug: 'frozen-candidate-carry-and-launch-fail-closed-2026-09-07',
      itemId: 'P-005',
      effectiveStatus: 'blocked',
      staleBlockedHint: null,
    }));
    const { emitWorkItemClaimableEvent } = await import('./work-items-events');
    emitWorkItemClaimableEvent(
      wi({
        id: 'WI-10000422',
        kind: 'feature',
        family: 'feature',
        state: 'open',
        assignee: null,
        harness: 'papercusp',
        sourcePlanSlug: 'frozen-candidate-carry-and-launch-fail-closed-2026-09-07',
        sourcePlanItemIds: ['P-005'],
      }),
      'released',
      { emit, planItemLaneBlockReason },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(planItemLaneBlockReason).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalled();
  });

  it('preserves a claimable event for a plan-linked item whose lane is clear', async () => {
    const emit = typedEmit();
    const planItemLaneBlockReason = vi.fn(async () => null);
    const { emitWorkItemClaimableEvent } = await import('./work-items-events');
    emitWorkItemClaimableEvent(
      wi({
        id: 'WI-10000423',
        kind: 'feature',
        family: 'feature',
        state: 'open',
        assignee: null,
        harness: 'papercusp',
        sourcePlanSlug: 'ready-plan',
        sourcePlanItemIds: ['P-001'],
      }),
      'released',
      { emit, planItemLaneBlockReason },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(planItemLaneBlockReason).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0]).toMatchObject({ key: 'work-item:claimable' });
  });

  it('CO-FIRES from the unblocked path for an unassigned claimable dependent (reason: unblocked)', async () => {
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null, waiters: 0 }));
    const dependent = wi({ id: 'WI-DEP', state: 'open', assignee: null });
    const otherBlockerSettled = wi({ id: 'WI-B2', state: 'closed' });
    await emitUnblockedOnEdgeRemoved({ kind: 'issue', ref: 'WI-DEP' }, 'WI-1', {
      emit: emit as never,
      getItem: vi.fn(async (id: string) =>
        id === 'WI-DEP' ? dependent : id === 'WI-B2' ? otherBlockerSettled : null,
      ) as never,
      listIn: vi.fn(async () => [edge('WI-B2', 'WI-DEP')]) as never,
    });
    await new Promise((r) => setTimeout(r, 0));
    const keys = emit.mock.calls.map((c) => (c as unknown as [{ key: string }])[0].key).sort();
    expect(keys).toEqual(['work-item:claimable', 'work-item:unblocked:WI-DEP']);
    const claimable = emit.mock.calls
      .map((c) => (c as unknown as [{ key: string; payload: { reason?: string } }])[0])
      .find((a) => a.key === 'work-item:claimable');
    expect(claimable?.payload.reason).toBe('unblocked');
  });

  it('direct-dispatches an unassigned agentic successor instead of advertising it to the generic pool', async () => {
    const emit = typedEmit();
    const execution = { appHarnessSlug: 'email', agentName: 'email-agent' };
    const dependent = wi({
      id: 'WI-AGENTIC-DEP',
      state: 'open',
      assignee: null,
      harness: 'email',
      payload: { plan_run: { runId: 42, execution } },
    });
    const dispatchActionable = vi.fn(async () => ({ ok: true })) as never;

    await emitUnblockedOnEdgeRemoved({ kind: 'issue', ref: dependent.id }, 'WI-ROOT', {
      emit: emit as never,
      getItem: vi.fn(async (id: string) => (id === dependent.id ? dependent : null)) as never,
      listIn: vi.fn(async () => []) as never,
      dispatchActionable,
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(dispatchActionable).toHaveBeenCalledWith({
      workItemIds: [dependent.id],
      targetAgent: 'email-agent',
      harness: 'email',
      summary: `${dependent.id} became actionable after WI-ROOT settled`,
      source: 'system:plan-run-successor-dispatch',
      // WI-10004815: the lane restore may have claimed it since the snapshot.
      wakeRetained: false,
    });
    const keys = emit.mock.calls.map((call) => call[0].key);
    expect(keys).toContain(`work-item:unblocked:${dependent.id}`);
    expect(keys).not.toContain('work-item:claimable');
    expect((dispatchActionable as any).mock.invocationCallOrder[0]).toBeLessThan(emit.mock.invocationCallOrder[0]!);
  });

  it('restores a stored blocked dependent before announcing it as unblocked and claimable', async () => {
    const emit = typedEmit();
    const dependent = wi({ id: 'WI-DEP-BLOCKED', state: 'blocked', assignee: null });
    const restored = { ...dependent, state: 'open' };
    const restoreBlockedDependent = vi.fn(async () => restored);
    await emitUnblockedOnEdgeRemoved({ kind: 'issue', ref: dependent.id }, 'WI-ROOT', {
      emit, getItem: vi.fn(async () => dependent), listIn: vi.fn(async () => []), restoreBlockedDependent,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(restoreBlockedDependent).toHaveBeenCalledWith(dependent, 'WI-ROOT');
    expect(emit.mock.calls.map(([event]) => event.key)).toEqual([
      `work-item:unblocked:${dependent.id}`, 'work-item:claimable',
    ]);
    expect(restoreBlockedDependent.mock.invocationCallOrder[0]).toBeLessThan(emit.mock.invocationCallOrder[0]!);
  });

  it('does not announce unblocked when restoration retains an independent hold', async () => {
    const emit = typedEmit();
    const dependent = wi({ id: 'WI-DEP-HELD', state: 'blocked', assignee: null });
    await emitUnblockedOnEdgeRemoved({ kind: 'issue', ref: dependent.id }, 'WI-ROOT', {
      emit, getItem: vi.fn(async () => dependent), listIn: vi.fn(async () => []),
      restoreBlockedDependent: vi.fn(async () => dependent),
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it('does not emit unblocked for an open dependent with an unsatisfied success-only prerequisite', async () => {
    const emit = typedEmit();
    const dependent = wi({ id: 'WI-SUCCESS-ONLY', state: 'open', assignee: null });
    const unresolvedDependencyCheck = vi.fn(async () => true);
    await emitUnblockedOnEdgeRemoved({ kind: 'issue', ref: dependent.id }, 'WI-DROPPED', {
      emit, getItem: vi.fn(async () => dependent), listIn: vi.fn(async () => []), unresolvedDependencyCheck,
    });
    expect(unresolvedDependencyCheck).toHaveBeenCalledWith(dependent);
    expect(emit).not.toHaveBeenCalled();
  });

  it('CO-FIRES from emitWorkItemCreatedEvent for an unclaimed-claimable create (one hook at the call site)', async () => {
    const emit = typedEmit();
    const { emitWorkItemCreatedEvent } = await import('./work-items-events');
    emitWorkItemCreatedEvent(wi({ id: 'WI-34', state: 'open', assignee: null, severity: null }), { emit });
    await new Promise((r) => setTimeout(r, 0));
    const keys = emit.mock.calls.map((c) => c[0].key).sort();
    expect(keys).toEqual(['work-item:claimable', 'work-item:created']);
  });

  it('CO-FIRES from emitClaimReleasedEvent when the row returned to a claimable state', async () => {
    const emit = typedEmit();
    const { emitClaimReleasedEvent } = await import('./work-items-events');
    emitClaimReleasedEvent(wi({ id: 'WI-35', state: 'open', assignee: null }), { emit });
    await new Promise((r) => setTimeout(r, 0));
    const keys = emit.mock.calls.map((c) => c[0].key).sort();
    expect(keys).toEqual(['claim:released:WI-35', 'work-item:claimable']);
  });

  it('never rejects on an emit failure (warns instead)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { emitWorkItemClaimableEvent } = await import('./work-items-events');
    const emit = vi.fn(async () => {
      throw new Error('pg down');
    });
    expect(() =>
      emitWorkItemClaimableEvent(wi({ state: 'open', assignee: null }), 'created', { emit: emit as never }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('claimable-event'));
    warn.mockRestore();
  });
});

describe('emitWorkItemStatusEvent (P-101 — the general per-transition key)', () => {
  it('fires work-item:status:<id> carrying prevState → state on the payload', async () => {
    const emit = typedEmit();
    const { emitWorkItemStatusEvent } = await import('./work-items-events');
    emitWorkItemStatusEvent(wi({ id: 'WI-9', state: 'wip', title: 'the work' }), 'todo', { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0]).toMatchObject({
      key: 'work-item:status:WI-9',
      source: 'work-items',
      summary: 'WI-9 todo → wip: the work',
      payload: expect.objectContaining({ id: 'WI-9', state: 'wip', prevState: 'todo' }),
    });
  });

  it('is an awaiter-only key — no `to` push (the audience is whoever awaited it)', async () => {
    const emit = typedEmit();
    const { emitWorkItemStatusEvent } = await import('./work-items-events');
    // assignedBy set, but a general status change must NOT spam the delegator —
    // only the specific done/blocked keys target the delegator.
    emitWorkItemStatusEvent(wi({ id: 'WI-10', assignedBy: 'su-parent', assignee: 'su-child' }), 'wip', { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit.mock.calls[0][0].to).toBeUndefined();
  });

  it('CO-FIRES work-item:claimable when a bare set_state ENTERS a claimable state (reason: requeued — WI-4180, the P-007 gap-(A) close)', async () => {
    const emit = typedEmit();
    const { emitWorkItemStatusEvent } = await import('./work-items-events');
    emitWorkItemStatusEvent(wi({ id: 'WI-11', state: 'open', assignee: null }), 'blocked', { emit });
    await new Promise((r) => setTimeout(r, 0));
    const keys = emit.mock.calls.map((c) => c[0].key).sort();
    expect(keys).toEqual(['work-item:claimable', 'work-item:status:WI-11']);
    const claimable = emit.mock.calls
      .map((c) => (c as unknown as [{ key: string; payload: { id?: string; state?: string; reason?: string } }])[0])
      .find((a) => a.key === 'work-item:claimable');
    expect(claimable?.payload).toMatchObject({ id: 'WI-11', state: 'open', reason: 'requeued' });
  });

  it('can suppress only the broad claimable co-fire while preserving the item-scoped status event', async () => {
    const emit = typedEmit();
    const { emitWorkItemStatusEvent } = await import('./work-items-events');
    emitWorkItemStatusEvent(wi({ id: 'WI-STABLE', state: 'open', assignee: null }), 'blocked', {
      emit,
      announceClaimable: false,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit.mock.calls.map((c) => c[0].key)).toEqual(['work-item:status:WI-STABLE']);
  });

  it('the ENTERING-EDGE guard: claimable→claimable moves and assigned/non-claimable landings do NOT re-announce', async () => {
    const { emitWorkItemStatusEvent } = await import('./work-items-events');
    const cases: Array<[string, Partial<WorkItem>, string]> = [
      [
        'open→failing (already advertised — claimable→claimable)',
        { id: 'WI-12', state: 'failing', assignee: null },
        'open',
      ],
      ['blocked→open while ASSIGNED', { id: 'WI-13', state: 'open', assignee: 'su-holder' }, 'blocked'],
      ['wip→blocked (non-claimable landing)', { id: 'WI-14', state: 'blocked', assignee: null }, 'wip'],
    ];
    for (const [label, over, prev] of cases) {
      const emit = typedEmit();
      emitWorkItemStatusEvent(wi(over), prev, { emit });
      await new Promise((r) => setTimeout(r, 0));
      const keys = emit.mock.calls.map((c) => c[0].key);
      expect(keys, label).toEqual([`work-item:status:${over.id}`]);
    }
  });

  it('never rejects on an emit failure (warns; a state write must never break)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { emitWorkItemStatusEvent } = await import('./work-items-events');
    const emit = vi.fn(async () => {
      throw new Error('engine down');
    });
    expect(() => emitWorkItemStatusEvent(wi(), 'todo', { emit: emit as never })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('status-event'));
    warn.mockRestore();
  });

  it('swallows expected teardown noise WITHOUT warning (CONNECTION_ENDED / partial schema)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { emitWorkItemStatusEvent } = await import('./work-items-events');
    const emit = vi.fn(async () => {
      throw Object.assign(new Error('write CONNECTION_ENDED'), { code: 'CONNECTION_ENDED' });
    });
    expect(() => emitWorkItemStatusEvent(wi(), 'todo', { emit: emit as never })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// P-005 (linking-notify-family-hardening): a fan-out settle reads every
// dependent's in-edges in ONE listInMany call (was: per-dst listIn +
// per-blocker getItem — N+1), and the emitter reads edges through the
// work-item-blocking seam instead of instantiating its own PgLinkStore.
describe('batched unblocked core (P-005)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('a fan-out settle makes exactly ONE listInMany call, fetches each distinct item once, and emits only for genuinely-unblocked dependents', async () => {
    const emit = typedEmit();
    const dep1 = wi({ id: 'WI-D1', state: 'open', assignee: 'su-a' });
    const dep2 = wi({ id: 'WI-D2', state: 'open', assignee: 'su-b' });
    const liveBlocker = wi({ id: 'WI-B2', state: 'open' });
    const listInMany = vi.fn(async () => [
      edge('WI-1', 'WI-D1'), // D1: only the just-settled blocker → unblocked
      edge('WI-1', 'WI-D2'),
      edge('WI-B2', 'WI-D2'), // D2: WI-B2 still live → stays blocked
    ]);
    const getItem = vi.fn(async (id: string) =>
      id === 'WI-D1' ? dep1 : id === 'WI-D2' ? dep2 : id === 'WI-B2' ? liveBlocker : null,
    );
    await emitWorkItemSettledEvents(wi(), {
      emit: emit as never,
      getItem: getItem as never,
      listOut: vi.fn(async (_r: unknown, o?: { rel?: string }) =>
        o?.rel === 'blocks' ? [edge('WI-1', 'WI-D1'), edge('WI-1', 'WI-D2')] : [],
      ) as never,
      listIn: vi.fn(async () => []) as never,
      listInMany: listInMany as never,
    });
    // THE batch pin: one query for both dependents' in-edges, never per-dst.
    expect(listInMany).toHaveBeenCalledTimes(1);
    expect(listInMany.mock.calls[0]).toEqual([
      [
        { kind: 'issue', ref: 'WI-D1' },
        { kind: 'issue', ref: 'WI-D2' },
      ],
      { rel: 'blocks' },
    ]);
    const keys = emit.mock.calls.map((c) => c[0].key);
    expect(keys).toContain('work-item:unblocked:WI-D1');
    expect(keys).not.toContain('work-item:unblocked:WI-D2');
    // Dedup pin: each involved item fetched once; the cleared blocker never is.
    expect(getItem.mock.calls.map((c) => c[0]).sort()).toEqual(['WI-B2', 'WI-D1', 'WI-D2']);
  });

  it('the emitter reads edges through the seam, never its own store (source pin)', () => {
    const src = readFileSync(fileURLToPath(new URL('./work-items-events.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/new PgLinkStore/);
    expect(src).toMatch(/blockingEdgeReader/);
  });
});

// P-006 (linking-notify-family-hardening): the events:await registration latch
// for work-item:unblocked:<id> keys probes the LIVE blocked state — an
// already-unblocked (or settled) target is told so at registration instead of
// stranding into a timeout-only wait. 'unknown' must never block registration.
describe('liveBlockedState (P-006 latch probe)', () => {
  it("returns 'blocked' while any live blocker edge remains", async () => {
    const item = wi({ id: 'WI-DEP', state: 'open' });
    const liveBlocker = wi({ id: 'WI-B1', state: 'open' });
    await expect(
      liveBlockedState('WI-DEP', {
        getItem: vi.fn(async (id: string) => (id === 'WI-DEP' ? item : id === 'WI-B1' ? liveBlocker : null)) as never,
        listIn: vi.fn(async () => [edge('WI-B1', 'WI-DEP')]) as never,
      }),
    ).resolves.toEqual({
      verdict: 'blocked',
      lifecycleState: 'open',
      dependencyState: 'blocked',
    });
  });

  it("returns 'unblocked' when every blocker is settled (or none exist)", async () => {
    const item = wi({ id: 'WI-DEP', state: 'open' });
    const settledBlocker = wi({ id: 'WI-B1', state: 'closed' });
    await expect(
      liveBlockedState('WI-DEP', {
        getItem: vi.fn(async (id: string) =>
          id === 'WI-DEP' ? item : id === 'WI-B1' ? settledBlocker : null,
        ) as never,
        listIn: vi.fn(async () => [edge('WI-B1', 'WI-DEP')]) as never,
      }),
    ).resolves.toEqual({
      verdict: 'unblocked',
      lifecycleState: 'open',
      dependencyState: 'unblocked',
    });
    await expect(
      liveBlockedState('WI-DEP', {
        getItem: vi.fn(async () => item) as never,
        listIn: vi.fn(async () => []) as never,
      }),
    ).resolves.toEqual({
      verdict: 'unblocked',
      lifecycleState: 'open',
      dependencyState: 'unblocked',
    });
  });

  it("returns 'blocked' for a lifecycle-blocked target even when no dependency edges exist", async () => {
    await expect(
      liveBlockedState('WI-DEP', {
        getItem: vi.fn(async () => wi({ id: 'WI-DEP', state: 'blocked' })) as never,
        listIn: vi.fn(async () => []) as never,
      }),
    ).resolves.toEqual({
      verdict: 'blocked',
      lifecycleState: 'blocked',
      dependencyState: 'unblocked',
    });
  });

  it("returns 'settled' for a target already in a terminal state (the key can never fire)", async () => {
    await expect(
      liveBlockedState('WI-DEP', {
        getItem: vi.fn(async () => wi({ id: 'WI-DEP', state: 'resolved' })) as never,
        listIn: vi.fn(async () => []) as never,
      }),
    ).resolves.toEqual({
      verdict: 'settled',
      lifecycleState: 'resolved',
      dependencyState: 'not-applicable',
    });
  });

  it("returns 'unknown' (never throws) when the item is unreadable — registration must proceed", async () => {
    await expect(
      liveBlockedState('WI-GONE', {
        getItem: vi.fn(async () => null) as never,
        listIn: vi.fn(async () => []) as never,
      }),
    ).resolves.toEqual({ verdict: 'unknown', dependencyState: 'unknown' });
    await expect(
      liveBlockedState('WI-DEP', {
        getItem: vi.fn(async () => wi({ id: 'WI-DEP', state: 'open' })) as never,
        listIn: vi.fn(async () => {
          throw new Error('pg down');
        }) as never,
      }),
    ).resolves.toEqual({ verdict: 'unknown', dependencyState: 'unknown' });
  });
});

describe('liveSettledProbe (EI-13095 done-key latch probe)', () => {
  it("returns 'settled' + the terminal state for an already-settled item (issue AND feature families)", async () => {
    await expect(
      liveSettledProbe('WI-5075', { getItem: vi.fn(async () => wi({ id: 'WI-5075', state: 'resolved' })) as never }),
    ).resolves.toEqual({ verdict: 'settled', itemState: 'resolved' });
    await expect(
      liveSettledProbe('F-9', {
        getItem: vi.fn(async () => wi({ id: 'F-9', family: 'feature', kind: 'feature', state: 'passed' })) as never,
      }),
    ).resolves.toEqual({ verdict: 'settled', itemState: 'passed' });
  });

  it("returns 'live' + the current state for a non-terminal item", async () => {
    await expect(
      liveSettledProbe('WI-42', { getItem: vi.fn(async () => wi({ id: 'WI-42', state: 'wip' })) as never }),
    ).resolves.toEqual({ verdict: 'live', itemState: 'wip' });
  });

  it("returns 'unknown' (never throws) for a missing or unreadable item — registration must proceed", async () => {
    await expect(liveSettledProbe('WI-GONE', { getItem: vi.fn(async () => null) as never })).resolves.toEqual({
      verdict: 'unknown',
    });
    await expect(
      liveSettledProbe('WI-ERR', {
        getItem: vi.fn(async () => {
          throw new Error('pg down');
        }) as never,
      }),
    ).resolves.toEqual({ verdict: 'unknown' });
  });

  it('reads ONLY the item row — no edge reads (lean by design)', async () => {
    const getItem = vi.fn(async () => wi({ id: 'WI-1', state: 'open' }));
    await liveSettledProbe('WI-1', { getItem: getItem as never });
    expect(getItem).toHaveBeenCalledTimes(1);
  });
});

describe('liveAssigneeProbe (EI-18731480441007330 self-await deadlock guard probe)', () => {
  it("returns 'live' + the current assignee for a non-terminal item", async () => {
    await expect(
      liveAssigneeProbe('WI-6095', {
        getItem: vi.fn(async () => wi({ id: 'WI-6095', state: 'wip', assignee: 'su-b106122a' })) as never,
      }),
    ).resolves.toEqual({ verdict: 'live', assignee: 'su-b106122a' });
  });

  it("returns 'live' + null assignee for an unclaimed item", async () => {
    await expect(
      liveAssigneeProbe('WI-7', {
        getItem: vi.fn(async () => wi({ id: 'WI-7', state: 'open', assignee: null })) as never,
      }),
    ).resolves.toEqual({ verdict: 'live', assignee: null });
  });

  it("returns 'settled' + the assignee for an already-settled item (issue AND feature families)", async () => {
    await expect(
      liveAssigneeProbe('WI-5075', {
        getItem: vi.fn(async () => wi({ id: 'WI-5075', state: 'resolved', assignee: 'su-x' })) as never,
      }),
    ).resolves.toEqual({ verdict: 'settled', assignee: 'su-x' });
    await expect(
      liveAssigneeProbe('F-9', {
        getItem: vi.fn(async () =>
          wi({ id: 'F-9', family: 'feature', kind: 'feature', state: 'passed', assignee: 'su-x' }),
        ) as never,
      }),
    ).resolves.toEqual({ verdict: 'settled', assignee: 'su-x' });
  });

  it("returns 'unknown' (never throws) for a missing or unreadable item — registration must proceed", async () => {
    await expect(liveAssigneeProbe('WI-GONE', { getItem: vi.fn(async () => null) as never })).resolves.toEqual({
      verdict: 'unknown',
    });
    await expect(
      liveAssigneeProbe('WI-ERR', {
        getItem: vi.fn(async () => {
          throw new Error('pg down');
        }) as never,
      }),
    ).resolves.toEqual({ verdict: 'unknown' });
  });

  it('reads ONLY the item row — no edge reads (lean by design)', async () => {
    const getItem = vi.fn(async () => wi({ id: 'WI-1', state: 'open' }));
    await liveAssigneeProbe('WI-1', { getItem: getItem as never });
    expect(getItem).toHaveBeenCalledTimes(1);
  });
});

// P-010 (linking-notify-family-hardening, WI-4014 Part 3 owner-fork → Option A):
// on settle, notify across fixes/duplicates edges (inject-only) — the fixed
// target's subscribers (fixes) and each duplicate-holder's assignee (duplicates).
// Option B (subscribe{followBlockers}) now rides the existing subscription/link
// stores with derived-row cleanup; this file continues to pin the inject-only
// settle-notify behavior separately.
describe('fix/duplicate settle-notify (P-010)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  const okEmit = () =>
    vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null, waiters: 0 }));

  it('fixes: notifies the fixed target subscribers (isResolution, inject-only) when the fixer settles', async () => {
    const notifySubscribers = vi.fn(async () => 1);
    const target = wi({ id: 'WI-BUG', state: 'open' });
    await emitWorkItemSettledEvents(wi({ id: 'WI-FIX', assignee: 'su-fixer' }), {
      emit: okEmit() as never,
      getItem: vi.fn(async (id: string) => (id === 'WI-BUG' ? target : null)) as never,
      listOut: vi.fn(async (_ref: unknown, opts?: { rel?: string }) =>
        opts?.rel === 'fixes' ? [edgeRel('WI-FIX', 'WI-BUG', 'fixes')] : [],
      ) as never,
      listIn: vi.fn(async () => []) as never,
      notifySubscribers: notifySubscribers as never,
    });
    expect(notifySubscribers).toHaveBeenCalledOnce();
    const [obj, ev] = notifySubscribers.mock.calls[0] as unknown as [
      { kind: string; ref: string },
      { notify_kind: string; isResolution: boolean; summary: string },
    ];
    expect(obj).toEqual({ kind: 'issue', ref: 'WI-BUG' }); // the TARGET's ref, not the fixer's
    expect(ev.notify_kind).toBe('work_item_fix_settled');
    expect(ev.isResolution).toBe(true); // mention-mode followers still receive the resolution
    expect(ev.summary).toContain('WI-FIX');
  });

  it('duplicates: notifies each distinct duplicate-holder assignee when the canonical settles', async () => {
    const emit = okEmit();
    const dup1 = wi({ id: 'WI-DUP1', state: 'open', assignee: 'su-a' });
    const dup2 = wi({ id: 'WI-DUP2', state: 'open', assignee: 'su-b' });
    await emitWorkItemSettledEvents(wi({ id: 'WI-CANON', assignee: 'su-canon' }), {
      emit: emit as never,
      getItem: vi.fn(async (id: string) => (id === 'WI-DUP1' ? dup1 : id === 'WI-DUP2' ? dup2 : null)) as never,
      listOut: vi.fn(async () => []) as never,
      listIn: vi.fn(async (_ref: unknown, opts?: { rel?: string }) =>
        opts?.rel === 'duplicates'
          ? [edgeRel('WI-DUP1', 'WI-CANON', 'duplicates'), edgeRel('WI-DUP2', 'WI-CANON', 'duplicates')]
          : [],
      ) as never,
      notifySubscribers: vi.fn(async () => 0) as never,
    });
    const dupCall = emit.mock.calls.find((c) =>
      (c as unknown as [{ key: string }])[0].key.startsWith('work-item:duplicate-settled'),
    );
    expect(dupCall).toBeDefined();
    const arg = (dupCall as unknown as [{ key: string; to: string[] }])[0];
    expect(arg.key).toBe('work-item:duplicate-settled:WI-CANON');
    expect([...arg.to].sort()).toEqual(['su-a', 'su-b']);
  });

  it('no fixes/duplicates edges → only work-item:done fires (no spurious notify)', async () => {
    const emit = okEmit();
    const notifySubscribers = vi.fn(async () => 0);
    await emitWorkItemSettledEvents(wi({ id: 'WI-1' }), {
      emit: emit as never,
      getItem: vi.fn(async () => null) as never,
      listOut: vi.fn(async () => []) as never,
      listIn: vi.fn(async () => []) as never,
      notifySubscribers: notifySubscribers as never,
    });
    expect(notifySubscribers).not.toHaveBeenCalled();
    const keys = emit.mock.calls.map((c) => (c as unknown as [{ key: string }])[0].key);
    expect(keys).toEqual(['work-item:done:WI-1']);
  });

  it('a throwing fix/dup notify is swallowed and does NOT drop the done emit (independent fail-soft scope, P-008)', async () => {
    const emit = okEmit();
    await expect(
      emitWorkItemSettledEvents(wi({ id: 'WI-FIX' }), {
        emit: emit as never,
        getItem: vi.fn(async () => wi({ id: 'WI-BUG', state: 'open' })) as never,
        listOut: vi.fn(async (_ref: unknown, opts?: { rel?: string }) =>
          opts?.rel === 'fixes' ? [edgeRel('WI-FIX', 'WI-BUG', 'fixes')] : [],
        ) as never,
        listIn: vi.fn(async () => []) as never,
        notifySubscribers: vi.fn(async () => {
          throw new Error('fanout down');
        }) as never,
      }),
    ).resolves.toBeUndefined();
    const keys = emit.mock.calls.map((c) => (c as unknown as [{ key: string }])[0].key);
    expect(keys).toContain('work-item:done:WI-FIX'); // done still fired despite fix-notify throwing
  });
});

describe('settleEdgeReadersFor (WI-10003631 one prefetch per settle)', () => {
  const me = { kind: 'issue', ref: 'WI-1' };
  const blocks = [edgeRel('WI-1', 'WI-2', 'blocks')];
  const fixes = [edgeRel('WI-1', 'WI-3', 'fixes')];
  const dups = [edgeRel('WI-4', 'WI-1', 'duplicates')];
  const setup = (read = vi.fn(async () => ({ blocksOut: blocks, fixesOut: fixes, duplicatesIn: dups }))) => {
    const fallback = { listOut: vi.fn(async () => [edgeRel('X', 'Y', 'live')]), listIn: vi.fn(async () => [edgeRel('Y', 'X', 'live')]) };
    return { read, fallback, readers: settleEdgeReadersFor(me, read as never, fallback as never) };
  };

  it('serves blocks-out, fixes-out and duplicates-in from ONE read', async () => {
    const { read, fallback, readers } = setup();
    expect(await readers.listOut(me, { rel: 'blocks' })).toBe(blocks);
    expect(await readers.listOut(me, { rel: 'fixes' })).toBe(fixes);
    expect(await readers.listIn(me, { rel: 'duplicates' })).toBe(dups);
    expect(read).toHaveBeenCalledTimes(1);
    expect(fallback.listOut).not.toHaveBeenCalled();
    expect(fallback.listIn).not.toHaveBeenCalled();
  });

  it('passes other relations and other refs to the live reader without prefetching', async () => {
    const { read, fallback, readers } = setup();
    await readers.listOut(me, { rel: 'relates' });
    await readers.listOut({ kind: 'issue', ref: 'WI-2' }, { rel: 'blocks' });
    await readers.listIn(me, { rel: 'blocks' });
    await readers.listIn({ kind: 'feature', ref: 'WI-1' }, { rel: 'duplicates' });
    expect(read).not.toHaveBeenCalled();
    expect(fallback.listOut).toHaveBeenCalledTimes(2);
    expect(fallback.listIn).toHaveBeenCalledTimes(2);
  });

  it('falls back to the live per-relation read when the prefetch fails', async () => {
    const { fallback, readers } = setup(vi.fn(async () => { throw new Error('pg down'); }));
    expect(await readers.listOut(me, { rel: 'blocks' })).toEqual([edgeRel('X', 'Y', 'live')]);
    expect(await readers.listIn(me, { rel: 'duplicates' })).toEqual([edgeRel('Y', 'X', 'live')]);
    expect(fallback.listOut).toHaveBeenCalledWith(me, { rel: 'blocks' });
    expect(fallback.listIn).toHaveBeenCalledWith(me, { rel: 'duplicates' });
  });
});

describe('detached emit tracking (WI-10003882)', () => {
  // The global afterEach drainDetached() (lib/detached-imports/setup-vitest.ts) only waits for
  // promises registered with trackDetached. An emit that escapes the registry keeps writing the
  // key-fire latch after its test ends, and deadlocked against the next test's TRUNCATE.
  it('keeps the claimable fan-out registered until its emit settles', async () => {
    const { pendingDetachedCount, drainDetached } = await import('./detached-imports');
    await drainDetached();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let emitted = false;
    const emit = vi.fn(async (_opts: EmitOpts) => {
      await gate;
      emitted = true;
      return { ok: true as const, key: '', woken: 0, notified: [] as string[], msgId: null, waiters: 0 };
    });
    emitWorkItemClaimableEvent(
      wi({ id: 'WI-DETACHED-TRACK', state: 'open', assignee: null, harness: 'papercusp' }),
      'created',
      { emit, duplicateAdmissionCheck: async () => true },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledOnce();
    expect(pendingDetachedCount()).toBeGreaterThanOrEqual(1);
    const drained = drainDetached();
    release();
    await drained;
    expect(emitted).toBe(true);
    expect(pendingDetachedCount()).toBe(0);
  });

  it('work-items.ts never tracks only the work-items-events import', () => {
    // `trackDetached(import('./work-items-events')).then(emit)` registers the import promise, not
    // the emit, so drainDetached() returns while the emit's DB write is still running. The whole
    // chain must be inside trackDetached: `trackDetached(import('./work-items-events').then(emit))`.
    const src = readFileSync(fileURLToPath(new URL('./work-items.ts', import.meta.url)), 'utf8');
    const importOnly = src.match(/trackDetached\(import\('\.\/work-items-events'\)\)\s*\.then/g) ?? [];
    expect(importOnly).toEqual([]);
    // Positive control: the tracked-chain form is present, so the regex reads the real file.
    expect(src).toMatch(/trackDetached\(import\('\.\/work-items-events'\)\s*\.then/);
  });

  it('work-items-events.ts registers every fire-and-forget emit chain', () => {
    // The emit* functions return void, so the caller cannot track their inner chain; each
    // detached chain must register itself.
    const src = readFileSync(fileURLToPath(new URL('./work-items-events.ts', import.meta.url)), 'utf8');
    expect(src.match(/void Promise\.resolve\(\)/g) ?? []).toEqual([]);
    expect(src).toMatch(/void trackDetached\(Promise\.resolve\(\)/);
  });
});
