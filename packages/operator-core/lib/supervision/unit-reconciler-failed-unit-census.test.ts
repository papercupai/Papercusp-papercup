/**
 * reboot-residue-service-repairs-2026-10-03 D-004 / R-004 — host-scoped failed-unit census.
 *
 * After the 2026-10-02 reboot, agenticmail.service and llama-ornith.service sat `failed` for days
 * with nothing reporting them, because the reconciler only checked the static SUPERVISED_PROCESSES
 * registry. These tests pin the census that closes that gap: failed, non-transient user units the
 * registry does not cover are announced once per failure episode; registry units and run-scoped
 * transient units are never announced; a census that cannot run never fails the tick.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  selectUnregisteredFailedUnits,
  censusUnregisteredFailedUnits,
  _resetFailedUnitCensusForTests,
  _resetReconcilerState,
  reconcileTick,
  type ReconcilerDeps,
  type SystemctlUnitStatus,
} from './unit-reconciler';
import type { SupervisionEntry } from '../service-health';

const failed = (unit: string, description = ''): SystemctlUnitStatus => ({
  unit,
  load: 'loaded',
  active: 'failed',
  sub: 'failed',
  description,
});

/** The measured dev-box shape, 2026-10-06: real residues beside run-scoped transient failures. */
const FAILED_LIST = [
  'agenticmail.service                 loaded failed failed AgenticMail API Server (v0.5.54)',
  'llama-ornith.service                loaded failed failed llama-server serving ornith-35b IQ3_M',
  'papercusp-dev-api.service           loaded failed failed registry-owned operator',
  'pc-0muw4835z8hks3y1dv8.service      loaded failed failed /usr/bin/node /tmp/task.mjs',
  'p012-chain12-20261005t2137z.service loaded failed failed /bin/bash -c chain',
].join('\n');

const TRANSIENT: Record<string, string> = {
  'agenticmail.service': 'no',
  'llama-ornith.service': 'no',
  'papercusp-dev-api.service': 'no',
  'pc-0muw4835z8hks3y1dv8.service': 'yes',
  'p012-chain12-20261005t2137z.service': 'yes',
};

const REGISTRY: SupervisionEntry[] = [
  { name: 'operator', layer: 'systemd-user', unit: 'papercusp-dev-api', criticality: 'critical', autoRestart: false },
];

/** A `systemctl --user` fake that answers the census's two calls from mutable state. */
function fakeSystemctl(state: {
  list: string;
  transient: Record<string, string>;
  /** Per-unit LoadState; defaults to `loaded` (the unit still exists when `show` runs). */
  loadState?: Record<string, string>;
}) {
  return vi.fn(async (args: string[]) => {
    if (args[0] === 'list-units' && args.includes('--plain')) return state.list;
    if (args[0] === 'show') {
      const units = args.slice(1).filter((a, i, all) => a !== '-p' && all[i] !== '-p' && all[i - 1] !== '-p');
      return units
        .map((u) => `Id=${u}\nLoadState=${state.loadState?.[u] ?? 'loaded'}\nTransient=${state.transient[u] ?? ''}`)
        .join('\n\n');
    }
    throw new Error(`unexpected systemctl call: ${args.join(' ')}`);
  });
}

describe('selectUnregisteredFailedUnits (pure)', () => {
  it('keeps only failed, non-transient units that no registry entry covers', () => {
    const units = [
      failed('agenticmail.service'),
      failed('papercusp-dev-api.service'),
      failed('pc-0muw4835z8hks3y1dv8.service'),
    ];
    const selected = selectUnregisteredFailedUnits(units, REGISTRY, new Map(Object.entries(TRANSIENT)));
    expect(selected.map((u) => u.unit)).toEqual(['agenticmail.service']);
  });

  it('matches registry units with or without the .service suffix', () => {
    const registry = [{ unit: 'agenticmail.service' }, { unit: 'llama-ornith' }];
    const selected = selectUnregisteredFailedUnits(
      [failed('agenticmail.service'), failed('llama-ornith.service')],
      registry,
      new Map(Object.entries(TRANSIENT)),
    );
    expect(selected).toEqual([]);
  });

  it('an UNKNOWN transience is not evidence of a host service — the unit is not selected', () => {
    const selected = selectUnregisteredFailedUnits([failed('mystery.service')], REGISTRY, new Map());
    expect(selected).toEqual([]);
  });
});

describe('censusUnregisteredFailedUnits', () => {
  beforeEach(() => _resetFailedUnitCensusForTests());

  it('announces the real residues and nothing run-scoped or registry-owned', async () => {
    const execUser = fakeSystemctl({ list: FAILED_LIST, transient: TRANSIENT });
    const notify = vi.fn(async () => {});
    const result = await censusUnregisteredFailedUnits({ execUser, notify }, REGISTRY, () => {});

    expect(result).toEqual(['agenticmail.service', 'llama-ornith.service']);
    expect(notify).toHaveBeenCalledTimes(1);
    const summary = (notify.mock.calls[0] as unknown as [{ summary: string; category?: string }])[0];
    expect(summary.category).toBe('supervision');
    expect(summary.summary).toContain('agenticmail.service');
    expect(summary.summary).toContain('llama-ornith.service');
    expect(summary.summary).not.toContain('papercusp-dev-api');
    expect(summary.summary).not.toContain('pc-0muw4835z8hks3y1dv8');
    expect(summary.summary).not.toContain('p012-chain12');
  });

  it('announces once per failure episode, and again after the unit recovers and re-fails', async () => {
    const state = { list: FAILED_LIST, transient: TRANSIENT };
    const execUser = fakeSystemctl(state);
    const notify = vi.fn(async () => {});

    await censusUnregisteredFailedUnits({ execUser, notify }, REGISTRY, () => {});
    await censusUnregisteredFailedUnits({ execUser, notify }, REGISTRY, () => {});
    expect(notify).toHaveBeenCalledTimes(1);

    // agenticmail recovers; llama-ornith is still failed and must NOT be re-announced.
    state.list = FAILED_LIST.split('\n').filter((l) => !l.startsWith('agenticmail')).join('\n');
    await censusUnregisteredFailedUnits({ execUser, notify }, REGISTRY, () => {});
    expect(notify).toHaveBeenCalledTimes(1);

    // agenticmail fails again: a new episode, announced alone.
    state.list = FAILED_LIST;
    await censusUnregisteredFailedUnits({ execUser, notify }, REGISTRY, () => {});
    expect(notify).toHaveBeenCalledTimes(2);
    const second = (notify.mock.calls[1] as unknown as [{ summary: string }])[0].summary;
    expect(second).toContain('agenticmail.service');
    expect(second).not.toContain('llama-ornith.service');
  });

  it('a census that cannot list units reports nothing and never throws', async () => {
    const execUser = vi.fn(async () => {
      throw new Error('Failed to connect to bus');
    });
    const notify = vi.fn(async () => {});
    const log = vi.fn();
    await expect(censusUnregisteredFailedUnits({ execUser, notify }, REGISTRY, log)).resolves.toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('unregistered-unit census skipped'));
  });

  it('a failed transient unit that VANISHED before `show` (LoadState=not-found, Transient=no) is not announced', async () => {
    // Measured 2026-10-06 (WI-10006477): a capability:bash unit was garbage-collected between
    // `list-units --all` and `show`; systemd then answers Transient=no for the missing
    // unit, and the census announced a run-scoped unit as an unsupervised host service.
    const execUser = fakeSystemctl({
      list: [FAILED_LIST, 'pc-0muwaxirzabakc11s9b.service loaded failed failed /usr/bin/node runner'].join('\n'),
      transient: { ...TRANSIENT, 'pc-0muwaxirzabakc11s9b.service': 'no' },
      loadState: { 'pc-0muwaxirzabakc11s9b.service': 'not-found' },
    });
    const notify = vi.fn(async () => {});
    const result = await censusUnregisteredFailedUnits({ execUser, notify }, REGISTRY, () => {});
    expect(result).toEqual(['agenticmail.service', 'llama-ornith.service']);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expect.not.stringContaining('pc-0muwaxirzabakc11s9b') }),
    );
  });

  it('an unreadable Transient property reports nothing rather than guessing', async () => {
    const execUser = vi.fn(async (args: string[]) => {
      if (args[0] === 'list-units') return FAILED_LIST;
      throw new Error('show timed out');
    });
    const notify = vi.fn(async () => {});
    await expect(censusUnregisteredFailedUnits({ execUser, notify }, REGISTRY, () => {})).resolves.toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('reconcileTick wiring of the census', () => {
  beforeEach(() => {
    _resetReconcilerState();
    _resetFailedUnitCensusForTests();
  });

  function deps(overrides: Partial<ReconcilerDeps>) {
    const census = fakeSystemctl({ list: FAILED_LIST, transient: TRANSIENT });
    const execUser = vi.fn(async (args: string[]) => {
      if (args[0] === 'list-units' && args.includes('--plain')) return census(args);
      if (args[0] === 'list-units') return 'papercusp-dev-api.service loaded active running operator';
      if (args[0] === 'show' && args[1] === '-p') return census(args);
      if (args[0] === 'show') return 'Id=papercusp-dev-api.service\nResult=success\nNRestarts=0';
      return '';
    });
    const notify = vi.fn(async () => {});
    const base: ReconcilerDeps = {
      execUser,
      notify,
      now: () => 1_000_000,
      autoRestartFlagOn: async () => false,
      registry: () => REGISTRY,
      log: () => {},
      ...overrides,
    };
    return { base, execUser, notify };
  }

  it('production opt-in (failedUnitCensus:true) reports the unregistered failures on the tick result', async () => {
    const { base, notify } = deps({ failedUnitCensus: true });
    const result = await reconcileTick(base);
    expect(result.unregisteredFailed).toEqual(['agenticmail.service', 'llama-ornith.service']);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ summary: expect.stringContaining('agenticmail.service') }));
  });

  it('without the opt-in the tick keeps its registry-only systemctl call sequence', async () => {
    const { base, execUser } = deps({});
    const result = await reconcileTick(base);
    expect(result.unregisteredFailed).toBeUndefined();
    expect(execUser.mock.calls.some((c) => (c[0] as string[]).includes('--plain'))).toBe(false);
  });
});
