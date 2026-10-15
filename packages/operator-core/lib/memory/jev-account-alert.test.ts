import { afterEach, describe, expect, it, vi } from 'vitest';
import { toDecisionLedgerEntry, type DecisionCallRecord, type DecisionOutcome } from '@papercusp/decision-model';
import {
  __resetJevAccountAlertForTest,
  alertOwnerOnJevAccountRefusal,
  jevAccountAlertFor,
  type JevAccountAlertDeps,
} from './jev-account-alert';

const NOW = Date.parse('2026-10-02T21:31:17Z');

function rec(outcome: DecisionOutcome): DecisionCallRecord {
  return {
    provider: 'typesafe',
    requestedModel: 'jev-1.13.0',
    request: { state: 's', questions: {} },
    outcome,
    startedAt: new Date(NOW),
    consumer: 'memory-injection',
    surface: 'mid-turn',
    subjectIds: [],
    hostLoad: null,
  } as unknown as DecisionCallRecord;
}

const refused402 = rec({ kind: 'inconclusive', reason: 'payment-required', status: 402, latencyMs: 110, attempts: 1 });
const suspended = rec({ kind: 'inconclusive', reason: 'payment-required', latencyMs: 0, attempts: 0 });
const refused401 = rec({ kind: 'inconclusive', reason: 'unauthorized', status: 401, latencyMs: 90, attempts: 1 });
const timedOut = rec({ kind: 'inconclusive', reason: 'timeout', latencyMs: 800, attempts: 1 });
const http500 = rec({ kind: 'inconclusive', reason: 'http-error', status: 500, latencyMs: 90, attempts: 1 });

afterEach(() => __resetJevAccountAlertForTest());

describe('jevAccountAlertFor (WI-10005694)', () => {
  it('a real 402 calls for one alert per workspace, reason and UTC day, naming the billing console', () => {
    const a = jevAccountAlertFor(refused402, 'ws-1', NOW);
    expect(a).toMatchObject({ reason: 'payment-required', dedupeKey: 'jev-account-refusal:ws-1:payment-required:2026-10-02' });
    expect(a!.body).toContain('console.typesafe.ai/settings/billing');
    expect(a!.body).toContain('HTTP 402');
    expect(jevAccountAlertFor(refused402, 'ws-1', NOW + 86_400_000)!.dedupeKey).toContain('2026-10-03');
  });

  it('a rejected key alerts with its own key and remedy', () => {
    const a = jevAccountAlertFor(refused401, 'ws-1', NOW);
    expect(a).toMatchObject({ reason: 'unauthorized', dedupeKey: 'jev-account-refusal:ws-1:unauthorized:2026-10-02' });
    expect(a!.body).toContain('API key');
  });

  it('builds the same refusal alert from the sanitized worker ledger entry', () => {
    const entry = toDecisionLedgerEntry(refused402);
    expect(jevAccountAlertFor(entry, 'ws-1', NOW)).toMatchObject({
      reason: 'payment-required',
      dedupeKey: 'jev-account-refusal:ws-1:payment-required:2026-10-02',
    });
  });

  it('no alert for a suspended no-send call, a timeout, a 5xx, or an answer', () => {
    expect(jevAccountAlertFor(suspended, 'ws-1', NOW)).toBeNull();
    expect(jevAccountAlertFor(timedOut, 'ws-1', NOW)).toBeNull();
    expect(jevAccountAlertFor(http500, 'ws-1', NOW)).toBeNull();
    const answered = rec({ kind: 'answered', model: 'jev-1.13.0', answers: {}, latencyMs: 150, attempts: 1 } as unknown as DecisionOutcome);
    expect(jevAccountAlertFor(answered, 'ws-1', NOW)).toBeNull();
  });
});

describe('alertOwnerOnJevAccountRefusal', () => {
  type Notify = JevAccountAlertDeps['notify'];
  const deps = (notify: Notify): JevAccountAlertDeps => ({ notify, workspaceId: () => 'ws-1', now: () => NOW });

  it('notifies once for a storm of 402s, high importance, replay-safe key', async () => {
    const notify = vi.fn<Notify>().mockResolvedValue({});
    for (let i = 0; i < 50; i += 1) await alertOwnerOnJevAccountRefusal(refused402, deps(notify));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({
      workspaceId: 'ws-1',
      kind: 'intervention',
      importance: 'high',
      dedupeKey: 'jev-account-refusal:ws-1:payment-required:2026-10-02',
    });
  });

  it('a failed delivery is not memoised, so the next refusal retries', async () => {
    const notify = vi.fn<Notify>().mockRejectedValueOnce(new Error('pg down')).mockResolvedValue({});
    await expect(alertOwnerOnJevAccountRefusal(refused402, deps(notify))).rejects.toThrow('pg down');
    await expect(alertOwnerOnJevAccountRefusal(refused402, deps(notify))).resolves.toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('sends nothing for outcomes that are not account refusals', async () => {
    const notify = vi.fn<Notify>().mockResolvedValue({});
    for (const r of [suspended, timedOut, http500]) await alertOwnerOnJevAccountRefusal(r, deps(notify));
    expect(notify).not.toHaveBeenCalled();
  });
});
