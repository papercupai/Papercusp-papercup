import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const M = vi.hoisted(() => ({ sweep: vi.fn() }));

vi.mock('../../agent-tools/plans/plan-drain-sweep', () => ({
  sweepDrainedPlanStatuses: M.sweep,
}));

import './plan-drain-sweep-action';
import { getSystemAction } from './system-actions';

const ctx = {
  installSlug: 'papercusp',
  workspaceId: 'papercusp-workspace',
  triggerConfig: {},
  payloadTemplate: null,
};

const quietTick = {
  scanned: 540,
  warranted: 0,
  applied: [],
  outcomes: [],
  deferredToNextTick: 0,
  skipped: {},
};

beforeEach(() => {
  M.sweep.mockReset();
  M.sweep.mockResolvedValue(quietTick);
});

afterEach(() => vi.restoreAllMocks());

describe('system:plan-drain-sweep', () => {
  it('registers on the canonical system-action seam', () => {
    expect(getSystemAction('plan-drain-sweep')).toBeTypeOf('function');
  });

  it('passes no cap when trigger_config carries none, so the module default applies', async () => {
    await getSystemAction('plan-drain-sweep')!(ctx);
    expect(M.sweep).toHaveBeenCalledExactlyOnceWith({});
  });

  it('forwards a configured cap, and ignores a nonsensical one', async () => {
    await getSystemAction('plan-drain-sweep')!({ ...ctx, triggerConfig: { cap: 5 } });
    expect(M.sweep).toHaveBeenCalledWith({ cap: 5 });

    for (const bad of [0, -3, 'lots', null]) {
      M.sweep.mockClear();
      await getSystemAction('plan-drain-sweep')!({ ...ctx, triggerConfig: { cap: bad } });
      expect(M.sweep).toHaveBeenCalledWith({});
    }
  });

  it('is SILENT on a no-op tick — the steady state once the backlog drains', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await getSystemAction('plan-drain-sweep')!(ctx);
    expect(log).not.toHaveBeenCalled();
  });

  it('logs every flip WITH the decision evidence sentence', async () => {
    M.sweep.mockResolvedValue({
      scanned: 540,
      warranted: 1,
      applied: [
        {
          planSlug: 'plan-a',
          harnessSlug: 'papercusp',
          from: 'active',
          to: 'awaiting-acceptance',
          reason: 'every one of 7 items is terminal (7 done, 0 dropped)',
        },
      ],
      outcomes: [
        {
          planSlug: 'plan-a',
          harnessSlug: 'papercusp',
          outcome: 'applied',
          from: 'active',
          to: 'awaiting-acceptance',
          reason: 'every one of 7 items is terminal (7 done, 0 dropped)',
        },
      ],
      deferredToNextTick: 0,
      skipped: {},
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await getSystemAction('plan-drain-sweep')!(ctx);

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('flipped 1: plan-a active→awaiting-acceptance'),
    );
    // A status change on a historical plan must never be traceable only to
    // "a sweep did it" — the evidence sentence rides along.
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        'papercusp/plan-a: applied active→awaiting-acceptance — every one of 7 items is terminal',
      ),
    );
  });

  // A cap permanently below the arrival rate is lossy in slow motion; a tick that
  // deferred work must not be able to hide inside the no-op silence above.
  it('breaks silence when work was deferred even though nothing was flipped', async () => {
    M.sweep.mockResolvedValue({ ...quietTick, warranted: 30, deferredToNextTick: 5 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await getSystemAction('plan-drain-sweep')!(ctx);

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('5 deferred to the next tick (cap reached)'),
    );
  });

  it('breaks silence when a flip was refused, naming the reason', async () => {
    M.sweep.mockResolvedValue({
      ...quietTick,
      warranted: 2,
      skipped: { busy: 1, not_found: 1 },
      outcomes: [
        { planSlug: 'plan-a', harnessSlug: 'papercusp', outcome: 'skipped', reason: 'busy' },
        { planSlug: 'plan-b', harnessSlug: 'papercusp', outcome: 'skipped', reason: 'not_found' },
      ],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await getSystemAction('plan-drain-sweep')!(ctx);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('not applied: busy×1, not_found×1'));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('papercusp/plan-a: skipped (busy)'),
    );
  });

  // CONTROL for the silence rule: a zero-valued skip counter is not "something
  // happened", so it must NOT break the quiet.
  it('stays silent when every skip counter is zero', async () => {
    M.sweep.mockResolvedValue({ ...quietTick, skipped: { busy: 0 } });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await getSystemAction('plan-drain-sweep')!(ctx);

    expect(log).not.toHaveBeenCalled();
  });
});
