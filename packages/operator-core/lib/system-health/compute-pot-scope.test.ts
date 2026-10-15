/**
 * resolveHealthPotScope — the pot-registry read at the top of every system-health tick.
 *
 * WI-10007007: with WORKSPACE_COORDINATION on, computeSystemHealth called listPots twice per
 * tick (once for the representative hive, again for the open-placement scope). listPots is
 * serial per pot and measured up to 100s per call under load. These tests pin one read per
 * tick, and that the open-placement panel still spans every hive.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TickLegTracker } from './tick-legs';

const { listPotsMock, getPotStartedMock, summarizeOpenPlacementsMock, coordinationOnMock } = vi.hoisted(() => ({
  listPotsMock: vi.fn(),
  getPotStartedMock: vi.fn(),
  summarizeOpenPlacementsMock: vi.fn(),
  coordinationOnMock: vi.fn(),
}));

vi.mock('../agent-tools/pot/_resolve', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listPots: listPotsMock,
}));
vi.mock('../pot/started', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPotStarted: getPotStartedMock,
}));
vi.mock('../pot/placement-watchdog', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  summarizeOpenPlacements: summarizeOpenPlacementsMock,
}));
vi.mock('../workspace-brain-scope', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isWorkspaceCoordinationOn: coordinationOnMock,
}));

import { resolveHealthPotScope } from './compute';

function recordingLegs(): TickLegTracker & { labels: string[] } {
  const labels: string[] = [];
  return {
    labels,
    leg: async (label, work) => { labels.push(label); return work(); },
    pending: () => [],
    slowest: () => [],
    idle: () => null,
  };
}

const placement = (n: number) => ({ recovering: n, cursed: 0, stranded: 2 * n, workingTracked: 10 * n });

beforeEach(() => {
  listPotsMock.mockReset().mockResolvedValue([{ slug: 'hive-a' }, { slug: 'hive-b' }]);
  getPotStartedMock.mockReset().mockResolvedValue(false);
  summarizeOpenPlacementsMock.mockReset().mockImplementation(async (_ws: string, slug: string) =>
    placement(slug === 'hive-a' ? 1 : 3));
  coordinationOnMock.mockReset().mockResolvedValue(true);
});

describe('resolveHealthPotScope', () => {
  it('reads the pot registry ONCE with coordination on, and still sums placements over every hive', async () => {
    const legs = recordingLegs();
    const scope = await resolveHealthPotScope('ws-1', legs);

    expect(listPotsMock).toHaveBeenCalledTimes(1);
    expect(listPotsMock).toHaveBeenCalledWith('ws-1');
    expect(legs.labels.filter((l) => l.startsWith('list-pots'))).toEqual(['list-pots']);
    expect(summarizeOpenPlacementsMock.mock.calls.map((c) => c[1]).sort()).toEqual(['hive-a', 'hive-b']);
    expect(scope).toEqual({
      potSlug: 'hive-a',
      started: false,
      openPlacements: { recovering: 4, cursed: 0, stranded: 8, workingTracked: 40 },
    });
  });

  it('prefers a started hive as the representative, without narrowing the placement scope', async () => {
    getPotStartedMock.mockImplementation(async (_ws: string, slug: string) => slug === 'hive-b');
    const scope = await resolveHealthPotScope('ws-1');

    expect(scope.potSlug).toBe('hive-b');
    expect(scope.started).toBe(true);
    expect(listPotsMock).toHaveBeenCalledTimes(1);
    expect(summarizeOpenPlacementsMock.mock.calls.map((c) => c[1]).sort()).toEqual(['hive-a', 'hive-b']);
  });

  it('with coordination off, scopes placements to the representative hive only', async () => {
    coordinationOnMock.mockResolvedValue(false);
    const scope = await resolveHealthPotScope('ws-1');

    expect(listPotsMock).toHaveBeenCalledTimes(1);
    expect(summarizeOpenPlacementsMock.mock.calls.map((c) => c[1])).toEqual(['hive-a']);
    expect(scope.openPlacements).toEqual(placement(1));
  });

  it('degrades to no hive when the registry is unreadable, and never throws', async () => {
    listPotsMock.mockRejectedValue(new Error('registry down'));
    const scope = await resolveHealthPotScope('ws-1');

    expect(scope).toEqual({ potSlug: null, started: false, openPlacements: null });
    expect(summarizeOpenPlacementsMock).not.toHaveBeenCalled();
  });

  it('keeps the hive but leaves placements null when a placement read fails', async () => {
    summarizeOpenPlacementsMock.mockRejectedValue(new Error('placements down'));
    const scope = await resolveHealthPotScope('ws-1');

    expect(scope.potSlug).toBe('hive-a');
    expect(scope.openPlacements).toBeNull();
  });
});

describe('computeSystemHealth pot-registry reads', () => {
  // The aggregator itself runs ~20 collectors and is not unit-testable here, so this pins the
  // other half of WI-10007007: compute.ts has exactly one listPots call site, inside
  // resolveHealthPotScope. A second call added anywhere in the tick path fails this.
  it('compute.ts calls listPots from exactly one site', () => {
    const src = readFileSync(fileURLToPath(new URL('./compute.ts', import.meta.url)), 'utf8');
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n');
    expect(code.match(/\blistPots\(/g) ?? []).toHaveLength(1);
    expect(code).toMatch(/resolveHealthPotScope\(ws, L\)/);
  });
});
