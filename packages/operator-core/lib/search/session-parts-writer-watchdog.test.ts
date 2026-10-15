/**
 * session-parts-writer-watchdog.test.ts — the guard for the failure that
 * session-turn-storage-2026-07-28 actually shipped with, and that its sibling
 * lag watchdog structurally could not see (D-008).
 *
 * The incident: bg-host ran a module-cached build predating the parts writer,
 * so it consumed every transcript byte on schedule, wrote text turns, and wrote
 * ZERO parts for ~7h. `behindFiles` was 0 the whole time, so the lag sweep
 * reported "fully caught up" on every tick. Nothing alarmed.
 *
 * These tests pin the two properties that make this guard worth having AND
 * safe to have: it FIRES on work-without-output, and it stays SILENT on the
 * three legitimate zero-parts shapes (no parts adapter, quiet adapter, healthy
 * writer). The silence half is the load-bearing half — "part_count is 0" is the
 * correct steady state for three of four adapters, so a naive check here would
 * alarm forever and train everyone to ignore it (the D-006 fatigue trap).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  evaluatePartsWriter,
  partsWriterWindowSec,
  sessionPartsWriterSweep,
  type PartsWriterObservation,
} from './session-ingest-lag-watchdog';

const obs = (o: Partial<PartsWriterObservation> = {}): PartsWriterObservation => ({
  sourceKind: 'claude',
  expectsParts: true,
  turnsInWindow: 100,
  partsInWindow: 400,
  ...o,
});

describe('evaluatePartsWriter — the pure decider', () => {
  it('FIRES when the adapter did work and produced nothing (the D-008 incident)', () => {
    const v = evaluatePartsWriter(obs({ turnsInWindow: 39, partsInWindow: 0 }));
    expect(v.degraded).toBe(true);
    expect(v.reason).toMatch(/SILENTLY DEAD/);
    // The alert must say the loss is permanent — that is the whole reason this
    // guard outranks its sibling in severity, and an operator who reads
    // "backlog" semantics into it will wrongly deprioritise it.
    expect(v.reason).toMatch(/PERMANENT/);
  });

  it('is SILENT for an adapter with no parseParts — zero parts is its correct state', () => {
    for (const sourceKind of ['codex', 'omp', 'agent_chat']) {
      const v = evaluatePartsWriter(obs({ sourceKind, expectsParts: false, partsInWindow: 0 }));
      expect(v.degraded, sourceKind).toBe(false);
      expect(v.reason).toMatch(/CORRECT steady state/);
    }
  });

  it('is SILENT for a quiet adapter — no turns consumed means the writer cannot be judged', () => {
    const v = evaluatePartsWriter(obs({ turnsInWindow: 0, partsInWindow: 0 }));
    expect(v.degraded).toBe(false);
    expect(v.reason).toMatch(/no turns ingested/);
  });

  it('is SILENT when the writer is producing, however little', () => {
    const v = evaluatePartsWriter(obs({ turnsInWindow: 5_000, partsInWindow: 1 }));
    expect(v.degraded).toBe(false);
    expect(v.reason).toMatch(/writer healthy/);
  });

  it('deliberately applies NO ratio test — one part for a huge turn count is healthy', () => {
    // A ratio test would need a model of parts-per-turn, which varies wildly by
    // session shape (tool-heavy vs chat). Modelling it wrong produces exactly
    // the false alarms D-006 forbids, so the decider only ever asks the
    // unambiguous question. This test exists to stop a future "improvement"
    // from quietly adding a threshold here.
    expect(evaluatePartsWriter(obs({ turnsInWindow: 100_000, partsInWindow: 1 })).degraded).toBe(false);
  });

  it('the ONLY firing shape is expectsParts && turns>0 && parts===0', () => {
    const fires = (o: Partial<PartsWriterObservation>) => evaluatePartsWriter(obs(o)).degraded;
    expect(fires({ expectsParts: true, turnsInWindow: 1, partsInWindow: 0 })).toBe(true);
    expect(fires({ expectsParts: false, turnsInWindow: 1, partsInWindow: 0 })).toBe(false);
    expect(fires({ expectsParts: true, turnsInWindow: 0, partsInWindow: 0 })).toBe(false);
    expect(fires({ expectsParts: true, turnsInWindow: 1, partsInWindow: 1 })).toBe(false);
  });
});

describe('partsWriterWindowSec', () => {
  const saved = process.env.PAPERCUSP_PARTS_WRITER_WINDOW_SEC;
  afterEach(() => {
    if (saved === undefined) delete process.env.PAPERCUSP_PARTS_WRITER_WINDOW_SEC;
    else process.env.PAPERCUSP_PARTS_WRITER_WINDOW_SEC = saved;
  });

  it('defaults to 1h', () => {
    delete process.env.PAPERCUSP_PARTS_WRITER_WINDOW_SEC;
    expect(partsWriterWindowSec()).toBe(3_600);
  });

  it('falls back to the default on a non-numeric value rather than disabling itself', () => {
    // A guard that silently turns itself OFF on a typo'd env var is worse than
    // one that ignores the typo.
    process.env.PAPERCUSP_PARTS_WRITER_WINDOW_SEC = 'not-a-number';
    expect(partsWriterWindowSec()).toBe(3_600);
  });
});

describe('sessionPartsWriterSweep', () => {
  const saved = process.env.PAPERCUSP_PARTS_WRITER_WINDOW_SEC;
  beforeEach(() => {
    process.env.PAPERCUSP_PARTS_WRITER_WINDOW_SEC = '3600';
    // The alerting path warns by design; stub it so the repo's fail-on-console
    // guard sees an expected, asserted warning (same pattern as the sibling
    // lag-watchdog suite).
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PAPERCUSP_PARTS_WRITER_WINDOW_SEC;
    else process.env.PAPERCUSP_PARTS_WRITER_WINDOW_SEC = saved;
    vi.restoreAllMocks();
  });

  const deps = (observations: PartsWriterObservation[], fires = 0) => ({
    rail: { broadcast: vi.fn(async () => true), resolve: vi.fn(async () => true) },
    observe: async (_windowMs: number) => observations,
    recentWatchdogFires: vi.fn(
      // `_hours` MUST be optional to match typeof recentWatchdogFires — a
      // required param here is assignment-incompatible and vitest will not
      // catch it (it does not typecheck), so it only surfaces at lint:tsc.
      async (_ws: string, _slug: string, _hours?: number, _source?: unknown, _scopeKey?: string) => fires,
    ),
    recordFire: vi.fn(async () => ({}) as never),
    openEscalation: vi.fn(async () => ({}) as never),
  });

  it('alerts + records + escalates once on a dead writer', async () => {
    const d = deps([obs({ turnsInWindow: 39, partsInWindow: 0 })]);
    const res = await sessionPartsWriterSweep({}, d);
    expect(res).toHaveLength(1);
    expect(res[0].outcome).toBe('alerted');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[session-parts-writer] ALERT'));
    expect(d.recordFire).toHaveBeenCalledTimes(1);
    expect(d.openEscalation).toHaveBeenCalledTimes(1);
    // Escalation must point at the RIGHT lever. The whole cost of this incident
    // was reaching for a deploy, which could never have fixed it.
    const body = (d.openEscalation.mock.calls[0] as unknown as [unknown, { body: string }])[1].body;
    expect(body).toContain('papercusp-bg-host.service');
    expect(body).not.toContain('papercup-bg-host');
    expect(body).toMatch(/DEPLOY DOES NOT FIX THIS/);
    expect(body).toMatch(/bg-host/);
  });

  it('carries the urgency in the BODY, since the severity vocabulary has no middle rung', async () => {
    // blocker | question | advisory are the only values. 'blocker' would be a
    // lie (this loses data but blocks nobody), so severity stays 'advisory' and
    // the body must lead with the permanence — otherwise a reader triages this
    // identically to the recoverable lag alert, which is the whole mistake.
    const d = deps([obs({ turnsInWindow: 39, partsInWindow: 0 })]);
    await sessionPartsWriterSweep({}, d);
    const arg = (d.openEscalation.mock.calls[0] as unknown as [unknown, { severity: string; body: string }])[1];
    expect(arg.severity).toBe('advisory');
    expect(arg.body).toMatch(/PERMANENT/);
  });

  it('debounces through the shared fires ledger', async () => {
    const d = deps([obs({ turnsInWindow: 39, partsInWindow: 0 })], 1);
    const res = await sessionPartsWriterSweep({}, d);
    expect(res[0].outcome).toBe('debounced');
    expect(d.recordFire).not.toHaveBeenCalled();
    expect(d.openEscalation).not.toHaveBeenCalled();
  });

  it('reports healthy adapters without alerting', async () => {
    const d = deps([
      obs({ sourceKind: 'claude', turnsInWindow: 39, partsInWindow: 162 }),
      obs({ sourceKind: 'codex', expectsParts: false, turnsInWindow: 4, partsInWindow: 0 }),
    ]);
    const res = await sessionPartsWriterSweep({}, d);
    expect(res.map((r) => r.outcome)).toEqual(['healthy', 'healthy']);
    expect(d.openEscalation).not.toHaveBeenCalled();
  });

  it('honours the kill switch', async () => {
    process.env.PAPERCUSP_PARTS_WRITER_WINDOW_SEC = '0';
    const d = deps([obs({ turnsInWindow: 39, partsInWindow: 0 })]);
    const res = await sessionPartsWriterSweep({}, d);
    expect(res).toEqual([{ sourceKind: '*', outcome: 'skipped', reason: 'kill switch' }]);
    expect(d.openEscalation).not.toHaveBeenCalled();
  });

  it('is fail-soft per adapter — one thrower cannot suppress the rest', async () => {
    const d = deps([
      obs({ sourceKind: 'claude', turnsInWindow: 39, partsInWindow: 0 }),
      obs({ sourceKind: 'omp', expectsParts: false }),
    ]);
    d.recentWatchdogFires.mockRejectedValueOnce(new Error('ledger down'));
    const res = await sessionPartsWriterSweep({}, d);
    expect(res[0]).toMatchObject({ sourceKind: 'claude', outcome: 'error' });
    expect(res[1]).toMatchObject({ sourceKind: 'omp', outcome: 'healthy' });
  });

  it('is fail-soft overall — an observe failure returns a result, never throws', async () => {
    const res = await sessionPartsWriterSweep({}, {
      observe: async () => { throw new Error('db gone'); },
    });
    expect(res).toEqual([{ sourceKind: '*', outcome: 'error', reason: 'db gone' }]);
  });
});
