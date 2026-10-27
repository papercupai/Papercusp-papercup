/**
 * burn-alert.test.ts — WI-41147 leg c: the stated wall at the observation WRITE seam.
 *
 * The wrapper must (i) alarm on the TRANSITION edge only (fact + severe-event), (ii) keep the
 * standing fact refreshed on every burning observation, (iii) retract + resolve on recovery,
 * and (iv) stay completely silent for a healthy account. The pool store, facts store and
 * severe-event rail are mocked; `recordAccountWindow`/`accountBurnTransition` run REAL, so
 * these tests exercise the true verdict math end to end.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAccount, type AccountPool } from '../deployment/account-pool';
import { recordAccountWindowWithBurnAlert } from './burn-alert';

const h = vi.hoisted(() => ({
  state: { pool: { accounts: [] } as unknown },
  assertFact: vi.fn(async (_input: unknown) => ({})),
  retractFact: vi.fn(async (_input: unknown) => true),
  broadcastSevereEvent: vi.fn(async (_ev: unknown) => true),
  broadcastSevereEventResolved: vi.fn(async (_res: unknown) => true),
  openEscalations: [] as Array<Record<string, unknown>>,
  openEscalation: vi.fn(async (_identity: unknown, _input: unknown) => ({})),
  sendMessage: vi.fn(async (_identity: unknown, _input: unknown) => ({})),
}));

vi.mock('../agent-tools/coordination/escalations', () => ({
  listEscalations: async () => h.openEscalations,
  openEscalation: h.openEscalation,
}));
vi.mock('../agent-tools/coordination/messages', () => ({
  sendMessage: h.sendMessage,
}));

vi.mock('../deployment/account-pool-store', () => ({
  updateAccountPool: async (mutator: (p: AccountPool) => AccountPool) => {
    h.state.pool = mutator(h.state.pool as AccountPool);
    return h.state.pool;
  },
}));
vi.mock('../agent-facts/store', () => ({
  assertFact: h.assertFact,
  retractFact: h.retractFact,
}));
vi.mock('../severe-event-broadcast', () => ({
  broadcastSevereEvent: h.broadcastSevereEvent,
  broadcastSevereEventResolved: h.broadcastSevereEventResolved,
}));

const T0 = 1_800_000_000_000;
const HR = 3_600_000;
const RESET = { windowResetAt7d: T0 + 24 * HR };

// WI-6554700010029499: five Codex accounts dropped Pro -> Plus and nothing noticed for ~2 days.
describe('recordAccountWindowWithBurnAlert — plan downgrade alarm', () => {
  beforeEach(() => {
    h.state.pool = registerAccount({ accounts: [] }, { id: 'a1', credentialRef: 'cred-a1' }, T0 - HR);
    h.openEscalations = [];
    h.openEscalation.mockClear();
    h.sendMessage.mockClear();
  });
  const observe = (planType: string, at: number) =>
    recordAccountWindowWithBurnAlert('a1', { utilization: 0.1, planType }, at);

  it('stores the tier on the first reading without alarming', async () => {
    const { planTransition } = await observe('pro', T0);
    const rate = (h.state.pool as AccountPool).accounts[0]!.rate;
    expect(rate.planType).toBe('pro');
    expect(rate.planObservedAt).toBe(T0);
    expect(planTransition).toBeNull();
    expect(h.openEscalation).not.toHaveBeenCalled();
  });

  it('opens ONE blocker escalation and ONE broadcast on the pro -> plus edge, then stays quiet', async () => {
    await observe('pro', T0);
    const { planTransition } = await observe('plus', T0 + 60_000);
    expect(planTransition).toEqual({ accountId: 'a1', from: 'pro', to: 'plus', direction: 'downgrade' });
    expect(h.openEscalation).toHaveBeenCalledTimes(1);
    expect(h.openEscalation.mock.calls[0]![1]).toEqual(expect.objectContaining({
      severity: 'blocker',
      meta: expect.objectContaining({ source: 'account-plan-health', planAccountId: 'a1', fromPlan: 'pro', toPlan: 'plus' }),
    }));
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    await observe('plus', T0 + 120_000);
    expect(h.openEscalation).toHaveBeenCalledTimes(1);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not re-open while an escalation for the account is still open', async () => {
    h.openEscalations = [{ source: 'account-plan-health', planAccountId: 'a1' }];
    await observe('pro', T0);
    await observe('plus', T0 + 60_000);
    expect(h.openEscalation).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('an upgrade does not alarm and re-arms the next downgrade', async () => {
    await observe('plus', T0);
    const up = await observe('pro', T0 + 60_000);
    expect(up.planTransition?.direction).toBe('upgrade');
    expect(h.openEscalation).not.toHaveBeenCalled();
    await observe('plus', T0 + 120_000);
    expect(h.openEscalation).toHaveBeenCalledTimes(1);
  });

  it('an unrecognised tier never alarms', async () => {
    await observe('pro', T0);
    const { planTransition } = await observe('mystery-tier', T0 + 60_000);
    expect(planTransition).toBeNull();
    expect(h.openEscalation).not.toHaveBeenCalled();
  });
});

describe('recordAccountWindowWithBurnAlert (leg c)', () => {
  beforeEach(() => {
    h.state.pool = registerAccount({ accounts: [] }, { id: 'a1', credentialRef: 'cred-a1' }, T0 - HR);
    h.assertFact.mockClear();
    h.retractFact.mockClear();
    h.broadcastSevereEvent.mockClear();
    h.broadcastSevereEventResolved.mockClear();
  });

  it('healthy observation: writes the window, states NOTHING', async () => {
    const { transition } = await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.4, ...RESET }, T0);
    expect(transition).toBeNull();
    expect((h.state.pool as AccountPool).accounts[0]!.rate.utilization7d).toBe(0.4);
    expect(h.assertFact).not.toHaveBeenCalled();
    expect(h.broadcastSevereEvent).not.toHaveBeenCalled();
    expect(h.retractFact).not.toHaveBeenCalled();
    expect(h.broadcastSevereEventResolved).not.toHaveBeenCalled();
  });

  it('escalation edge: asserts the fact AND broadcasts once, condition-keyed', async () => {
    await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.4, ...RESET }, T0);
    const { transition } = await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.7 }, T0 + HR);
    expect(transition).toEqual(expect.objectContaining({ from: 'none', to: 'shed' }));
    expect(h.assertFact).toHaveBeenCalledTimes(1);
    // The FACT is the pool-wide aggregate key — NOT `account-burn:a1`. The broadcast below is
    // still per-account; only the continuously-rewritten fact was collapsed.
    expect(h.assertFact.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ scope: 'workspace', key: 'account-burn' }),
    );
    expect(h.broadcastSevereEvent).toHaveBeenCalledTimes(1);
    expect(h.broadcastSevereEvent.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ conditionKey: 'account-burn:a1', oneShot: true }),
    );
    expect(h.broadcastSevereEventResolved).not.toHaveBeenCalled();
  });

  it('steady burning: refreshes the fact each observation, but does NOT re-broadcast', async () => {
    await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.4, ...RESET }, T0);
    await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.7 }, T0 + HR); // edge: fact 1 + broadcast 1
    const { transition } = await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.9 }, T0 + 2 * HR);
    expect(transition).toBeNull(); // shed → shed
    expect(h.assertFact).toHaveBeenCalledTimes(2); // refreshed (TTL keeps the standing fact alive)
    expect(h.broadcastSevereEvent).toHaveBeenCalledTimes(1); // edge-only
  });

  it('recovery edge: retracts the fact and broadcasts resolved', async () => {
    await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.4, ...RESET }, T0);
    await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.7 }, T0 + HR); // shed
    await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.9 }, T0 + 2 * HR); // still shed
    const { transition } = await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.3 }, T0 + 3 * HR);
    expect(transition).toEqual(expect.objectContaining({ from: 'shed', to: 'none' }));
    expect(h.retractFact).toHaveBeenCalledTimes(1);
    expect(h.retractFact.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ scope: 'workspace', key: 'account-burn' }),
    );
    expect(h.broadcastSevereEventResolved).toHaveBeenCalledTimes(1);
    expect(h.broadcastSevereEventResolved.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ conditionKey: 'account-burn:a1' }),
    );
    expect(h.assertFact).toHaveBeenCalledTimes(2); // no refresh on the recovery write
  });

  it('a facts-store failure never breaks the observation write (fail-soft)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.assertFact.mockRejectedValueOnce(new Error('pg down'));
      await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.4, ...RESET }, T0);
      const { pool, transition } = await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.7 }, T0 + HR);
      expect(transition).toEqual(expect.objectContaining({ to: 'shed' }));
      expect(pool.accounts[0]!.rate.utilization7d).toBe(0.7); // the durable half landed
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('fact assert failed'));
    } finally {
      warn.mockRestore();
    }
  });

  // ── P-001: every stated surface carries the DISPOSITION ────────────────────

  it('pacing projection: the fact and the broadcast both state it is NOT a measured wall', async () => {
    await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.4, ...RESET }, T0);
    await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.7 }, T0 + HR);

    // The FACT is folded into every agent's orient — it is the highest-leverage string here.
    // It is now the POOL AGGREGATE, so it groups by disposition and names the accounts rather
    // than rendering one account's verdict label; the invariant under test is unchanged — a
    // pacing projection must never be readable as a measured capacity wall.
    const factBody = String((h.assertFact.mock.calls[0]![0] as { body: string }).body);
    expect(factBody).toContain('PACING PROJECTION');
    expect(factBody).toContain('NOT A PROVIDER WALL');
    expect(factBody).toContain('do not remedy it by throttling the fleet');
    expect(factBody).toContain('a1'); // the burning account is still named
    expect(factBody).not.toContain('MEASURED WALL');
    expect(factBody).not.toContain("provider's own 7d meter is exhausted");

    const ev = h.broadcastSevereEvent.mock.calls[0]![0] as { summary: string; body: string };
    expect(ev.summary).toContain('pacing projection, not a measured wall');
    expect(ev.summary).toContain('(was none)');
    expect(ev.body).toContain('PACING POLICY, NOT A MEASURED WALL');
    expect(ev.body).not.toContain("provider's own rolling 7-day meter reads exhausted");
  });

  it('measured wall: the fact and the broadcast state a MEASUREMENT, never a projection', async () => {
    await recordAccountWindowWithBurnAlert('a1', { utilization7d: 1.0, ...RESET }, T0);

    const factBody = String((h.assertFact.mock.calls[0]![0] as { body: string }).body);
    expect(factBody).toContain('MEASURED WALL');
    expect(factBody).toContain("provider's own 7d meter is exhausted");
    expect(factBody).toContain('a1');
    expect(factBody).not.toContain('PACING PROJECTION');

    const ev = h.broadcastSevereEvent.mock.calls[0]![0] as { summary: string; body: string };
    expect(ev.summary).toContain('USAGE-WALLED (measured; util7d 1.00)');
    expect(ev.body).toContain("provider's own rolling 7-day meter reads exhausted");
    expect(ev.body).not.toContain('PACING POLICY');
  });

  // ── P-001 of memory-fold-pollution-and-cap-eviction-2026-09-02: ONE fold line ─────────────

  it('many burning accounts collapse to ONE fact key, grouped by disposition', async () => {
    h.state.pool = registerAccount(h.state.pool as AccountPool, { id: 'a2', credentialRef: 'cred-a2' }, T0 - HR);
    h.state.pool = registerAccount(h.state.pool as AccountPool, { id: 'a3', credentialRef: 'cred-a3' }, T0 - HR);
    for (const id of ['a1', 'a2', 'a3']) {
      await recordAccountWindowWithBurnAlert(id, { utilization7d: 0.4, ...RESET }, T0);
    }

    await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.7 }, T0 + HR); // pacing projection
    await recordAccountWindowWithBurnAlert('a2', { utilization7d: 1.0 }, T0 + HR); // measured wall

    // THE POINT OF THE ITEM: every assert targets the SAME single key, so N burning accounts
    // cost one fold slot and one cap seat rather than N. A regression to per-account keys
    // fails here first.
    const keys = new Set(h.assertFact.mock.calls.map((c) => (c[0] as { key: string }).key));
    expect([...keys]).toEqual(['account-burn']);

    const latest = String((h.assertFact.mock.calls.at(-1)![0] as { body: string }).body);
    expect(latest).toContain('2 of 3 accounts burning');
    // The two dispositions are stated SEPARATELY and name different accounts — never summed
    // into one count, which would erase the distinction the disposition contract protects.
    // Segment the body rather than regex across it: each section contains sentence periods.
    const measuredAt = latest.indexOf('MEASURED WALL');
    const pacingAt = latest.indexOf('PACING PROJECTION');
    expect(measuredAt).toBeGreaterThan(-1);
    expect(pacingAt).toBeGreaterThan(measuredAt);
    const measuredSection = latest.slice(measuredAt, pacingAt);
    const pacingSection = latest.slice(pacingAt);
    expect(measuredSection).toContain('a2');
    expect(measuredSection).not.toContain('a1');
    expect(pacingSection).toContain('a1');
    expect(pacingSection).not.toContain('a2');
  });

  it('the aggregate retracts only when the LAST burning account recovers', async () => {
    h.state.pool = registerAccount(h.state.pool as AccountPool, { id: 'a2', credentialRef: 'cred-a2' }, T0 - HR);
    await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.4, ...RESET }, T0);
    await recordAccountWindowWithBurnAlert('a2', { utilization7d: 0.4, ...RESET }, T0);
    await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.7 }, T0 + HR); // both burning
    await recordAccountWindowWithBurnAlert('a2', { utilization7d: 0.7 }, T0 + HR);

    // a1 recovers, a2 is STILL burning — the shared line must stay up.
    await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.3 }, T0 + 2 * HR);
    expect(h.retractFact).not.toHaveBeenCalled();

    // a2 recovers — now the last wall is gone and the line comes down.
    await recordAccountWindowWithBurnAlert('a2', { utilization7d: 0.3 }, T0 + 3 * HR);
    expect(h.retractFact).toHaveBeenCalledTimes(1);
    expect(h.retractFact.mock.calls[0]![0]).toEqual(expect.objectContaining({ key: 'account-burn' }));
  });

  it('unknown account id: no-op write, nothing stated', async () => {
    const { transition } = await recordAccountWindowWithBurnAlert('ghost', { utilization7d: 0.9 }, T0);
    expect(transition).toBeNull();
    expect(h.assertFact).not.toHaveBeenCalled();
    expect(h.broadcastSevereEvent).not.toHaveBeenCalled();
  });
});
