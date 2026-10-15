import { describe, expect, it, vi } from 'vitest';
import {
  defineAgentObligation,
  evaluateAgentObligations,
  type AgentObligation,
  type AgentObligationAgenda,
} from './agent-obligations';
import {
  AGENT_OBLIGATION_REMINDER_BINDING_KIND,
  AGENT_OBLIGATION_REMINDER_MIN_SLEEP_SEC,
  AGENT_OBLIGATION_UNEVALUATED_RETENTION_MS,
  reconcileAgentObligationReminders,
  type AgentObligationReminderDeps,
} from './agent-obligation-reminders';
import type { AwaitRow } from './events/await/types';
import { AWAIT_SUPERSEDED_BY_REGISTRATION } from './events/await/store';

const NOW = Date.parse('2026-09-06T01:00:00.000Z');
const DEADLINE = '2026-09-06T01:10:00.000Z';

function obligation(over: Partial<AgentObligation> = {}): AgentObligation {
  return defineAgentObligation({
    ruleId: 'goal-owner-report',
    ruleRevision: 'v1',
    family: 'owner-report',
    title: 'Owner report becomes due',
    scope: { workspaceId: 'ws', ownerId: 'su-owner', goalId: 'goal-1' },
    responsibleOwnerId: 'su-owner',
    episode: 'reported:2026-09-06T00:10:00.000Z',
    status: 'due',
    authority: { kind: 'policy', sourceRef: 'report-writer', revision: 'v1' },
    reason: 'report cadence applies',
    priority: 'high',
    causalRank: 1,
    applicableDemand: 1,
    sourceGeneration: 'generation-a',
    evidence: [],
    action: { kind: 'report', summary: 'report now' },
    clearsWhen: {
      id: 'delivered-report',
      summary: 'a report is delivered',
      evidenceKind: 'delivery',
      sourceRef: 'report-writer',
    },
    changeSignal: {
      event: 'goal:owner-report:goal-1',
      nextDeadlineAt: DEADLINE,
      cancellationRef: 'goal:goal-1',
    },
    ...over,
  });
}

function agenda(...entries: AgentObligation[]): AgentObligationAgenda {
  return evaluateAgentObligations(entries, new Date(NOW).toISOString());
}

function fakeStore(seed: AwaitRow[] = []) {
  let nextId = 10;
  const rows = [...seed];
  const captureHandle = vi.fn(async () => ({
    handle: {
      kind: 'adv-session' as const,
      advSessionId: 7,
      agent: 'codex',
      sessionId: 'session-1',
      ompThreadId: null,
      cwd: '/repo',
      pid: 42,
    },
    note: 'resumable',
  }));
  const register = vi.fn(async (input: Parameters<AgentObligationReminderDeps['register']>[0]) => {
    // Mirror registerAwait's exact-one-shot transaction: concurrent/repeated
    // registration leaves one newest pending subscriber/key row.
    for (const row of rows) {
      if (
        row.subscriberId === input.subscriberId &&
        row.eventKey === input.eventKey &&
        row.once &&
        row.firedAt == null &&
        row.cancelledAt == null
      ) {
        row.cancelledAt = new Date(NOW).toISOString();
        row.cancelReason = AWAIT_SUPERSEDED_BY_REGISTRATION;
      }
    }
    const row = {
      id: nextId++,
      subscriberId: input.subscriberId,
      eventKey: input.eventKey,
      policy: input.policy ?? 'wake',
      note: input.note ?? null,
      wakeHandle: input.wakeHandle ?? null,
      timeoutBehavior: input.timeoutBehavior ?? 'wake',
      expiresTs: input.timeoutSec == null ? null : new Date(NOW + input.timeoutSec * 1_000).toISOString(),
      createdAt: new Date(NOW).toISOString(),
      firedAt: null,
      firedReason: null,
      cancelledAt: null,
      cancelReason: null,
      once: input.once ?? true,
      minSleepSec: input.minSleepSec ?? null,
      urgency: input.urgency ?? false,
      payloadFilter: input.payloadFilter ?? null,
      boundTo: input.boundTo ?? null,
      supersededAt: null,
    } as AwaitRow;
    rows.push(row);
    return row;
  });
  const cancel = vi.fn(async ({ awaitId, reason }: { awaitId: number; subscriberId: string; reason?: string }) => {
    const row = rows.find((candidate) => candidate.id === awaitId && candidate.cancelledAt == null);
    if (!row || row.firedAt != null) return false;
    row.cancelledAt = new Date(NOW).toISOString();
    row.cancelReason = reason ?? null;
    return true;
  });
  const deps: AgentObligationReminderDeps = {
    captureHandle,
    listHistory: vi.fn(async () => rows),
    register: register as AgentObligationReminderDeps['register'],
    cancel: cancel as AgentObligationReminderDeps['cancel'],
  };
  return { rows, deps, register, cancel };
}

describe('reconcileAgentObligationReminders', () => {
  it('arms one lifecycle-bound await whose event and deadline race on the existing delivery plane', async () => {
    const store = fakeStore();
    const entry = obligation();
    const receipt = await reconcileAgentObligationReminders(
      { ownerId: 'su-owner', agenda: agenda(entry), now: new Date(NOW) },
      store.deps,
    );

    expect(receipt).toMatchObject({ desired: 1, registered: 1, retained: 0, alreadyDelivered: 0 });
    expect(store.register).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriberId: 'su-owner',
        eventKey: 'goal:owner-report:goal-1',
        timeoutSec: 600,
        timeoutBehavior: 'wake',
        once: true,
        minSleepSec: AGENT_OBLIGATION_REMINDER_MIN_SLEEP_SEC,
        boundTo: { kind: AGENT_OBLIGATION_REMINDER_BINDING_KIND, ref: entry.id },
      }),
    );
  });

  it('arms a deadline-only episode without requiring an external producer event', async () => {
    const store = fakeStore();
    const entry = obligation({
      changeSignal: { nextDeadlineAt: DEADLINE, cancellationRef: 'goal:goal-1' },
    });
    await reconcileAgentObligationReminders(
      { ownerId: 'su-owner', agenda: agenda(entry), now: new Date(NOW) },
      store.deps,
    );

    expect(store.register).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: `agent-obligation:deadline:${entry.id}`,
        timeoutSec: 600,
        timeoutBehavior: 'wake',
      }),
    );
  });

  it('retains an unchanged warm episode instead of duplicating its registration', async () => {
    const store = fakeStore();
    const current = agenda(obligation());
    await reconcileAgentObligationReminders({ ownerId: 'su-owner', agenda: current, now: new Date(NOW) }, store.deps);
    const second = await reconcileAgentObligationReminders(
      { ownerId: 'su-owner', agenda: current, now: new Date(NOW) },
      store.deps,
    );

    expect(store.register).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ retained: 1, registered: 0 });
  });

  it('converges concurrent cold reconciliations onto one pending delivery row', async () => {
    const store = fakeStore();
    const current = agenda(obligation());
    let readers = 0;
    let releaseReaders!: () => void;
    const bothReadersStarted = new Promise<void>((resolve) => {
      releaseReaders = resolve;
    });
    store.deps.listHistory = vi.fn(async () => {
      // Force both callers to make their registration decision from the same
      // empty snapshot. The register seam mirrors registerAwait's serialized
      // exact-one-shot retire+insert transaction.
      const snapshot = [...store.rows];
      readers += 1;
      if (readers === 2) releaseReaders();
      await bothReadersStarted;
      return snapshot;
    });

    const receipts = await Promise.all([
      reconcileAgentObligationReminders({ ownerId: 'su-owner', agenda: current, now: new Date(NOW) }, store.deps),
      reconcileAgentObligationReminders({ ownerId: 'su-owner', agenda: current, now: new Date(NOW) }, store.deps),
    ]);

    expect(receipts).toEqual([expect.objectContaining({ registered: 1 }), expect.objectContaining({ registered: 1 })]);
    expect(store.register).toHaveBeenCalledTimes(2);
    expect(store.rows.filter((row) => row.firedAt == null && row.cancelledAt == null)).toHaveLength(1);
  });

  it('uses the fired await as the cold/delayed-wake cursor and never re-arms the handled episode', async () => {
    const current = obligation();
    const store = fakeStore();
    await reconcileAgentObligationReminders(
      { ownerId: 'su-owner', agenda: agenda(current), now: new Date(NOW) },
      store.deps,
    );
    store.rows[0]!.firedAt = new Date(NOW + 1_000).toISOString();
    store.rows[0]!.firedReason = 'event';
    store.register.mockClear();

    const receipt = await reconcileAgentObligationReminders(
      { ownerId: 'su-owner', agenda: agenda(current), now: new Date(NOW + 2_000) },
      store.deps,
    );
    expect(receipt.alreadyDelivered).toBe(1);
    expect(store.register).not.toHaveBeenCalled();
  });

  it('honors explicit operator cancellation as a settled episode instead of re-arming it', async () => {
    const current = obligation();
    const store = fakeStore();
    await reconcileAgentObligationReminders(
      { ownerId: 'su-owner', agenda: agenda(current), now: new Date(NOW) },
      store.deps,
    );
    store.rows[0]!.cancelledAt = new Date(NOW + 1_000).toISOString();
    store.rows[0]!.cancelReason = 'operator';
    store.register.mockClear();

    const receipt = await reconcileAgentObligationReminders(
      { ownerId: 'su-owner', agenda: agenda(current), now: new Date(NOW + 2_000) },
      store.deps,
    );
    expect(receipt.alreadyDelivered).toBe(1);
    expect(store.register).not.toHaveBeenCalled();
  });

  it('cancels an obsolete episode and arms the new stable episode once', async () => {
    const old = obligation();
    const store = fakeStore();
    await reconcileAgentObligationReminders(
      { ownerId: 'su-owner', agenda: agenda(old), now: new Date(NOW) },
      store.deps,
    );
    const next = obligation({ episode: 'reported:2026-09-06T00:20:00.000Z', sourceGeneration: 'generation-b' });

    const receipt = await reconcileAgentObligationReminders(
      { ownerId: 'su-owner', agenda: agenda(next), now: new Date(NOW) },
      store.deps,
    );
    // The shared registerAwait transaction may retire the old same-key row
    // before the adapter's trailing stale-row pass reaches it, so the receipt's
    // explicit cancel count is race/order dependent. The invariant is one live
    // row for the new episode and a settled old row.
    expect(receipt.registered).toBe(1);
    expect(store.rows.filter((row) => row.cancelledAt == null)).toHaveLength(1);
    expect(store.rows.find((row) => row.cancelledAt == null)?.boundTo?.ref).toBe(next.id);
    // WI-10005938: a settled row always says why, so nudge delivery is measurable.
    const settledRows = store.rows.filter((row) => row.cancelledAt != null);
    expect(settledRows.length).toBeGreaterThan(0);
    expect(settledRows.every((row) => row.cancelReason != null)).toBe(true);
  });

  // WI-10005938 (P-008 W1, goal 60d3a8): 22 superseded obligation watches were
  // cancelled with no reason because the same-key registration retired them
  // before the measured classification ran. The measured reason must win.
  it('stamps the measured discharge on an old same-key episode before registering its replacement', async () => {
    const old = obligation();
    const store = fakeStore();
    await reconcileAgentObligationReminders(
      { ownerId: 'su-owner', agenda: agenda(old), now: new Date(NOW) },
      store.deps,
    );
    const oldDischarged = obligation({ status: 'not-applicable', changeSignal: undefined });
    expect(oldDischarged.id).toBe(old.id);
    const next = obligation({ episode: 'reported:2026-09-06T00:20:00.000Z', sourceGeneration: 'generation-b' });
    expect(next.id).not.toBe(old.id);

    await reconcileAgentObligationReminders(
      { ownerId: 'su-owner', agenda: agenda(oldDischarged, next), now: new Date(NOW) },
      store.deps,
    );

    const oldRow = store.rows.find((row) => row.boundTo?.ref === old.id);
    expect(oldRow?.eventKey).toBe(store.rows.find((row) => row.boundTo?.ref === next.id)?.eventKey);
    expect(oldRow?.cancelReason).toBe('obligation-discharged');
    expect(store.rows.filter((row) => row.cancelledAt == null).map((row) => row.boundTo?.ref)).toEqual([next.id]);
  });

  it('retires a reminder only when its obligation is MEASURED resolved, and does not turn a past deadline into an immediate wake loop', async () => {
    const store = fakeStore();
    const current = obligation();
    await reconcileAgentObligationReminders(
      { ownerId: 'su-owner', agenda: agenda(current), now: new Date(NOW) },
      store.deps,
    );
    const discharged = obligation({ status: 'not-applicable', changeSignal: undefined });
    expect(discharged.id).toBe(current.id);
    const pastOnly = obligation({
      episode: 'past-only',
      changeSignal: { nextDeadlineAt: new Date(NOW - 1_000).toISOString(), cancellationRef: 'goal:goal-1' },
    });
    const receipt = await reconcileAgentObligationReminders(
      { ownerId: 'su-owner', agenda: agenda(discharged, pastOnly), now: new Date(NOW) },
      store.deps,
    );

    expect(receipt.desired).toBe(0);
    expect(store.rows.filter((row) => row.cancelledAt == null)).toHaveLength(0);
    expect(store.rows.map((row) => row.cancelReason)).toEqual(['obligation-discharged']);
  });

  // P-010 (goal-holder-plans-ideation-truthful-reports-2026-10-03). Measured
  // 2026-10-02: every pending plan-acceptance, placement and planning reminder of
  // one goal holder dropped to zero on turns whose agenda did not evaluate them
  // (bounded window or degraded read), then re-armed a turn later, leaving 20-60
  // min gaps where an event was never delivered. Absence is not resolution.
  it('keeps a pending reminder across turns that do not evaluate its obligation (bounded window or degraded read)', async () => {
    const store = fakeStore();
    await reconcileAgentObligationReminders(
      { ownerId: 'su-owner', agenda: agenda(obligation()), now: new Date(NOW) },
      store.deps,
    );
    // A different obligation (another plan in the window); ids key on rule + scope, not episode.
    // Its own event key, as in production (plan:acceptance:<slug> per plan): the
    // store keeps only the newest pending one-shot per subscriber+key (migration 941).
    const other = obligation({
      scope: { workspaceId: 'ws', ownerId: 'su-owner', goalId: 'goal-other-window' },
      changeSignal: { event: 'goal:owner-report:goal-other-window', nextDeadlineAt: DEADLINE, cancellationRef: 'goal:goal-other-window' },
    });
    expect(other.id).not.toBe(obligation().id);
    for (let turn = 0; turn < 3; turn += 1) {
      const receipt = await reconcileAgentObligationReminders(
        { ownerId: 'su-owner', agenda: agenda(other), now: new Date(NOW + turn * 60_000) },
        store.deps,
      );
      expect(receipt.retainedUnevaluated).toBe(1);
    }
    expect(store.rows.filter((row) => row.cancelledAt != null)).toHaveLength(0);
    expect(store.register).toHaveBeenCalledTimes(2);
  });

  it('keeps a pending reminder when its obligation is measured unknown', async () => {
    const store = fakeStore();
    const current = obligation();
    await reconcileAgentObligationReminders(
      { ownerId: 'su-owner', agenda: agenda(current), now: new Date(NOW) },
      store.deps,
    );
    const unknown = obligation({
      status: 'unknown',
      changeSignal: undefined,
      measurementFailure: { code: 'read-failed', detail: 'portfolio read timed out', retry: 'retry the read' },
    });
    expect(unknown.id).toBe(current.id);
    const receipt = await reconcileAgentObligationReminders(
      { ownerId: 'su-owner', agenda: agenda(unknown), now: new Date(NOW) },
      store.deps,
    );
    expect(receipt.retainedUnevaluated).toBe(1);
    expect(store.rows.filter((row) => row.cancelledAt != null)).toHaveLength(0);
  });

  it('expires an unevaluated reminder after the retention horizon and stamps why', async () => {
    const store = fakeStore();
    await reconcileAgentObligationReminders(
      { ownerId: 'su-owner', agenda: agenda(obligation()), now: new Date(NOW) },
      store.deps,
    );
    const receipt = await reconcileAgentObligationReminders(
      {
        ownerId: 'su-owner',
        agenda: agenda(obligation({ scope: { workspaceId: 'ws', ownerId: 'su-owner', goalId: 'goal-later-window' }, changeSignal: undefined })),
        now: new Date(NOW + AGENT_OBLIGATION_UNEVALUATED_RETENTION_MS + 1_000),
      },
      store.deps,
    );
    expect(receipt.retainedUnevaluated).toBe(0);
    expect(store.rows[0]!.cancelReason).toBe('obligation-unevaluated-expired');
    expect(store.rows.filter((row) => row.cancelledAt != null && row.cancelReason == null)).toHaveLength(0);
  });

  it('fails soft with an explicit receipt when the await ledger is unavailable', async () => {
    const store = fakeStore();
    store.deps.listHistory = vi.fn(async () => {
      throw new Error('event_awaits unavailable');
    });
    await expect(
      reconcileAgentObligationReminders(
        { ownerId: 'su-owner', agenda: agenda(obligation()), now: new Date(NOW) },
        store.deps,
      ),
    ).resolves.toMatchObject({ registered: 0, error: 'event_awaits unavailable' });
  });
});
