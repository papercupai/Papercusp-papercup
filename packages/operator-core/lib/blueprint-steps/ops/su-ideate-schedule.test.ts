import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuIdeateScheduleDeps } from '../../scout/su-ideate-schedule';
import { setSuIdeateScheduleDeps, suIdeateScheduleOp } from './su-ideate-schedule';

function refuseLaunch(): SuIdeateScheduleDeps {
  return {
    listHarnesses: async () => ['eligible'],
    readLastPass: async () => ({ lastPassMs: null, lastLens: null }),
    learningEnabled: async () => true,
    countObservationsSince: async () => 10,
    readIdeaQueue: async () => ({ total: 0, pending: 0 }),
    listLaunches: async () => [],
    launch: async () => ({ ok: false, error: 'governor admission refused' }),
  };
}

afterEach(() => {
  setSuIdeateScheduleDeps(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('scheduled su ideate decision diagnostics', () => {
  it('exposes the actual launch refusal when the scheduled context has no logger', async () => {
    vi.stubEnv('PAPERCUSP_SU_IDEATE_OBS_THRESHOLD', '10');
    setSuIdeateScheduleDeps(refuseLaunch());
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const output = await suIdeateScheduleOp.run({}, { workspaceId: 'ws' } as never);

    expect(output.decisions).toEqual([{
      harnessSlug: 'eligible', disposition: 'launch-failed',
      observationsSince: 10, error: 'governor admission refused',
    }]);
    expect(log).toHaveBeenCalledTimes(1);
    const diagnostic = JSON.parse(String(log.mock.calls[0][0]).slice('su-ideate:schedule '.length));
    expect(diagnostic).toEqual(output);
    expect(diagnostic.decisions[0].error).toBe('governor admission refused');
  });

  it('uses a supplied program logger without a second console emission', async () => {
    vi.stubEnv('PAPERCUSP_SU_IDEATE_OBS_THRESHOLD', '10');
    setSuIdeateScheduleDeps(refuseLaunch());
    const fallback = vi.spyOn(console, 'info').mockImplementation(() => {});
    const log = vi.fn();
    await suIdeateScheduleOp.run({}, { workspaceId: 'ws', log } as never);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('governor admission refused'));
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves a late eligible outcome after sixty quiet harnesses (launched=%s)', async (launched) => {
    vi.stubEnv('PAPERCUSP_SU_IDEATE_OBS_THRESHOLD', '10');
    const quiet = Array.from({ length: 60 }, (_, i) => `a-${String(i).padStart(2, '0')}`);
    setSuIdeateScheduleDeps({
      ...refuseLaunch(),
      listHarnesses: async () => [...quiet, 'z-eligible'],
      countObservationsSince: async (_workspace, harness) => harness === 'z-eligible' ? 10 : 0,
      readIdeaQueue: async (_workspace, harness) => harness === 'z-eligible' ? { total: 0, pending: 0 } : { total: 1, pending: 1 },
      launch: async () => launched ? { ok: true } : { ok: false, error: 'governor admission refused' },
    });
    const log = vi.fn();
    const output = await suIdeateScheduleOp.run({}, { workspaceId: 'ws', log } as never);

    expect(output.decisionCount).toBe(61);
    expect(output.decisions).toHaveLength(50);
    expect(output.decisionsOmitted).toBe(11);
    expect(output.decisionCounts).toEqual({ 'not-overdue': 60, [launched ? 'launched' : 'launch-failed']: 1 });
    expect(output.decisions[0]).toMatchObject({ harnessSlug: 'z-eligible', disposition: launched ? 'launched' : 'launch-failed' });
    expect(JSON.parse(String(log.mock.calls[0][0]).slice('su-ideate:schedule '.length))).toEqual(output);
    expect(suIdeateScheduleOp.resultSchema.parse(output)).toEqual(output);
  });

  it('keeps the final launch visible when more than fifty preceding scope refusals fill the detail budget', async () => {
    vi.stubEnv('PAPERCUSP_SU_IDEATE_OBS_THRESHOLD', '10');
    const denied = Array.from({ length: 60 }, (_, i) => `a-${String(i).padStart(2, '0')}`);
    setSuIdeateScheduleDeps({
      ...refuseLaunch(),
      listHarnesses: async () => [...denied, 'z-eligible'],
      launch: async (request) => request.harnessSlug === 'z-eligible'
        ? { ok: true } : { ok: false, error: 'scope_denied: outside workspace policy' },
    });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const output = await suIdeateScheduleOp.run({}, { workspaceId: 'ws' } as never);

    expect(output.launchedHarness).toBe('z-eligible');
    expect(output.decisions[0]).toMatchObject({ harnessSlug: 'z-eligible', disposition: 'launched' });
    expect(output.decisionCounts).toEqual({ 'launch-failed': 60, launched: 1 });
    expect(output.decisionCount).toBe(61);
    expect(output.decisionsOmitted).toBe(11);
    expect(output.decisions).toHaveLength(50);
  });
});
