/**
 * gate-canary-sweep-action.test.ts — WI-5977: the `system:gate-canary-sweep`
 * scheduled counterpart of the on-demand `gates:canary-check` tool. Pins:
 * fact-assert-every-tick, the healthy vs gate-broken classification, and the
 * EI-11574 "non-federated target is indeterminate, never a false gate-broken
 * alarm" guard.
 *
 * WI-6005 widened both the action and this test file: (a) a canary alarm now
 * fires a REAL escalation (notifyAttention + a durable harness_escalations
 * one-shot/recovery-clear row, mirroring release-actions.ts's GATE_STALL_PHASE
 * / green-stall-watchdog.ts's WATCHDOG_PHASE convention) instead of only a log
 * line + fact, and (b) the green-checkpoint result-parser canary (shelled out
 * to a standalone CLI, apps/operator tier) now sweeps on every tick,
 * independent of federation status — so most tests below now expect TWO fact
 * asserts (one per canary) instead of one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const assertFactMock = vi.fn(async (_arg: Record<string, unknown>) => ({}) as never);
const isRegisteredHiveMock = vi.fn(async (_ws: string, _slug: string) => true);
const insertProbeMock = vi.fn(async (_stamped: unknown) => ({}) as Record<string, unknown>);
const notifyAttentionMock = vi.fn(async (_arg: Record<string, unknown>) => undefined);
const broadcastMock = vi.fn(async () => true);
const resolveMock = vi.fn(async () => true);

vi.mock('../severe-event-broadcast', () => ({ broadcastSevereEvent: () => broadcastMock() }));
vi.mock('../alarm-attention', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../alarm-attention')>()),
  resolveAlarm: () => resolveMock(),
}));

vi.mock('../agent-facts/store', () => ({
  assertFact: (arg: Record<string, unknown>) => assertFactMock(arg),
}));
vi.mock('../harness-registry', () => ({
  isRegisteredHive: (ws: string, slug: string) => isRegisteredHiveMock(ws, slug),
}));
vi.mock('../sync/pot-git/federation-probe-store', () => ({
  insertProbe: (stamped: unknown) => insertProbeMock(stamped),
}));
vi.mock('../attention-notify', () => ({
  notifyAttention: (arg: Record<string, unknown>) => notifyAttentionMock(arg),
}));

// Capturing fake `sql.unsafe` for harness_escalations — mirrors the pattern in
// release-actions.gate-health.test.ts. Keyed per-phase so the two canaries'
// escalations dedup/recover independently, exactly like the live DB rows would.
type UnsafeCall = { query: string; params: unknown[] };
const unsafeCalls: UnsafeCall[] = [];
let escalationRows: Record<string, { escalation: string | null } | undefined> = {};

const fakeSql = {
  unsafe: (query: string, params: unknown[] = []) => {
    unsafeCalls.push({ query, params });
    if (/SELECT\s+escalation\s+FROM\s+harness_shared\.harness_escalations/i.test(query)) {
      const phase = params[1] as string;
      const row = escalationRows[phase];
      return Promise.resolve(row ? [row] : []);
    }
    if (/INSERT INTO\s+harness_shared\.harness_escalations/i.test(query)) {
      const phase = params[1] as string;
      escalationRows[phase] = { escalation: params[2] as string };
      return Promise.resolve({ count: 1 });
    }
    if (/UPDATE\s+harness_shared\.harness_escalations\s+SET\s+escalation\s*=\s*NULL/i.test(query)) {
      const phase = params[1] as string;
      const existed = !!escalationRows[phase]?.escalation;
      if (escalationRows[phase]) escalationRows[phase]!.escalation = null;
      return Promise.resolve({ count: existed ? 1 : 0 });
    }
    return Promise.resolve({ count: 0 });
  },
};

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fakeSql }),
}));

import './gate-canary-sweep-action';
import {
  GATE_CANARY_SWEEP_FACT_KEY,
  GREEN_CHECKPOINT_PARSER_CANARY_FACT_KEY,
  setGreenCheckpointCanaryRunner,
} from './gate-canary-sweep-action';
import { getSystemAction, type SystemActionCtx } from '../harness/routines/system-actions';

function ctx(): SystemActionCtx {
  return { installSlug: 'a-federated-harness', workspaceId: 'ws-test', triggerConfig: {}, payloadTemplate: null };
}

/** A healthy green-checkpoint-parser CLI run (the default for most tests — keeps
 *  that canary's own escalation/fact path out of the way of tests targeting the
 *  federation-probe canary). */
function healthyGreenCheckpointRunner(): Promise<{ code: number; stdout: string; stderr: string }> {
  return Promise.resolve({
    code: 0,
    stdout: '__GREEN_CHECKPOINT_CANARY_RESULT__ ' + JSON.stringify({ ok: true, detail: 'known-good/known-bad classified correctly' }),
    stderr: '',
  });
}

function factCallsFor(key: string): Record<string, unknown>[] {
  return assertFactMock.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((a) => a.key === key);
}

describe('system:gate-canary-sweep', () => {
  beforeEach(() => {
    assertFactMock.mockClear();
    isRegisteredHiveMock.mockClear();
    insertProbeMock.mockClear();
    notifyAttentionMock.mockClear();
    broadcastMock.mockClear();
    resolveMock.mockClear();
    unsafeCalls.length = 0;
    escalationRows = {};
    isRegisteredHiveMock.mockResolvedValue(true);
    insertProbeMock.mockResolvedValue({});
    setGreenCheckpointCanaryRunner(healthyGreenCheckpointRunner);
  });
  afterEach(() => {
    setGreenCheckpointCanaryRunner(null);
  });

  it('runs the federation-probe canary and asserts a HEALTHY-classed fact for a federated harness', async () => {
    const action = getSystemAction('gate-canary-sweep');
    expect(action).toBeTypeOf('function');
    await action!(ctx());

    expect(insertProbeMock).toHaveBeenCalledTimes(1);
    // One fact per canary: federation-probe + green-checkpoint-parser.
    expect(assertFactMock).toHaveBeenCalledTimes(2);
    const factArg = factCallsFor(GATE_CANARY_SWEEP_FACT_KEY)[0];
    expect(factArg).toMatchObject({
      scope: 'harness',
      scopeRef: 'a-federated-harness',
      key: GATE_CANARY_SWEEP_FACT_KEY,
      workspaceId: 'ws-test',
    });
    // No systemGreen signal wired (apparatus-only sweep) — a passing canary
    // with no real verdict to bifurcate against classifies 'unknown'/alarm:'none',
    // per classifyGateCanary's own contract (never a manufactured 'healthy').
    expect(String(factArg.body)).toContain('UNKNOWN');
    expect(notifyAttentionMock).not.toHaveBeenCalled();
  });

  it('does NOT probe, and reports INDETERMINATE (never gate-broken), for a non-federated harness', async () => {
    isRegisteredHiveMock.mockResolvedValue(false);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const action = getSystemAction('gate-canary-sweep');
    await action!(ctx());

    expect(insertProbeMock).not.toHaveBeenCalled();
    // The federation-probe fact still asserts (indeterminate), and the
    // green-checkpoint-parser canary sweeps regardless (not federation-scoped).
    expect(assertFactMock).toHaveBeenCalledTimes(2);
    const factArg = factCallsFor(GATE_CANARY_SWEEP_FACT_KEY)[0];
    expect(String(factArg.body)).toContain('UNKNOWN (indeterminate)');
    expect(String(factArg.body)).not.toContain('gate-broken');
    logSpy.mockRestore();
  });

  it('reports INDETERMINATE, not gate-broken, when the federation lookup itself errors', async () => {
    isRegisteredHiveMock.mockRejectedValue(new Error('pg down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const action = getSystemAction('gate-canary-sweep');
    await expect(action!(ctx())).resolves.not.toThrow();

    expect(insertProbeMock).not.toHaveBeenCalled();
    const factArg = factCallsFor(GATE_CANARY_SWEEP_FACT_KEY).at(-1)!;
    expect(String(factArg.body)).toContain('UNKNOWN (indeterminate)');
    expect(String(factArg.body)).toContain('lookup failed');
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('warns (not just logs) when the canary alarm is not none', async () => {
    // Force the apparatus itself to fail: insertProbe rejects, which
    // buildFederationProbeCanary's run() surfaces as ok:false ("persistence failed"),
    // classifying alarm:'gate' via classifyGateCanary.
    insertProbeMock.mockRejectedValue(new Error('insert failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const action = getSystemAction('gate-canary-sweep');
    await action!(ctx());

    expect(warnSpy).toHaveBeenCalled();
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('alarm=gate');
    const factArg = factCallsFor(GATE_CANARY_SWEEP_FACT_KEY).at(-1)!;
    expect(String(factArg.body)).toContain('GATE-BROKEN');
    warnSpy.mockRestore();
  });

  it('never throws when assertFact itself rejects (non-fatal)', async () => {
    assertFactMock.mockRejectedValueOnce(new Error('db down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const action = getSystemAction('gate-canary-sweep');
    await expect(action!(ctx())).resolves.not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  describe('WI-6005: real escalation on a gate alarm', () => {
    it('fires notifyAttention + writes a durable harness_escalations row on a federation-probe alarm', async () => {
      insertProbeMock.mockRejectedValue(new Error('insert failed'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const action = getSystemAction('gate-canary-sweep');
      await action!(ctx());

      expect(notifyAttentionMock).toHaveBeenCalledTimes(1);
      expect(notifyAttentionMock.mock.calls[0][0]).toMatchObject({
        kind: 'intervention',
        importance: 'urgent',
        workspaceId: 'ws-test',
      });
      const insertCall = unsafeCalls.find((c) => /INSERT INTO\s+harness_shared\.harness_escalations/i.test(c.query));
      expect(insertCall).toBeDefined();
      expect(insertCall!.params[0]).toBe('a-federated-harness');
      expect(insertCall!.params[1]).toBe('gate-canary-sweep:federation-probe');
      warnSpy.mockRestore();
    });

    it('does NOT re-notify on a second consecutive alarm (one-shot until recovery)', async () => {
      insertProbeMock.mockRejectedValue(new Error('insert failed'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const action = getSystemAction('gate-canary-sweep');
      await action!(ctx());
      expect(notifyAttentionMock).toHaveBeenCalledTimes(1);

      notifyAttentionMock.mockClear();
      await action!(ctx());
      expect(notifyAttentionMock).not.toHaveBeenCalled();
    });

    it('clears the escalation row on recovery (alarm → none)', async () => {
      insertProbeMock.mockRejectedValue(new Error('insert failed'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const action = getSystemAction('gate-canary-sweep');
      await action!(ctx());
      expect(escalationRows['gate-canary-sweep:federation-probe']?.escalation).not.toBeNull();

      insertProbeMock.mockResolvedValue({});
      await action!(ctx());
      expect(escalationRows['gate-canary-sweep:federation-probe']?.escalation).toBeNull();
    });

    it('sweeps the green-checkpoint-parser canary via the injected CLI runner, independent of federation status', async () => {
      isRegisteredHiveMock.mockResolvedValue(false);
      setGreenCheckpointCanaryRunner(() =>
        Promise.resolve({
          code: 0,
          stdout: '__GREEN_CHECKPOINT_CANARY_RESULT__ ' + JSON.stringify({ ok: false, detail: 'known-bad output was misparsed' }),
          stderr: '',
        }),
      );
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const action = getSystemAction('gate-canary-sweep');
      await action!(ctx());

      const factArg = factCallsFor(GREEN_CHECKPOINT_PARSER_CANARY_FACT_KEY)[0];
      expect(String(factArg.body)).toContain('GATE-BROKEN');
      expect(notifyAttentionMock).toHaveBeenCalledTimes(1);
      const insertCall = unsafeCalls.find((c) => /INSERT INTO\s+harness_shared\.harness_escalations/i.test(c.query));
      expect(insertCall!.params[1]).toBe('gate-canary-sweep:green-checkpoint-parser');
      warnSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('treats an unparseable/missing CLI marker as canary-undetermined (alarm gate), never silently dropped', async () => {
      setGreenCheckpointCanaryRunner(() => Promise.resolve({ code: 1, stdout: 'garbage, no marker', stderr: 'boom' }));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const action = getSystemAction('gate-canary-sweep');
      await action!(ctx());

      const factArg = factCallsFor(GREEN_CHECKPOINT_PARSER_CANARY_FACT_KEY)[0];
      expect(String(factArg.body)).toContain('UNKNOWN');
      expect(notifyAttentionMock).toHaveBeenCalledTimes(1);
    });
  });
});
