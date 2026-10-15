/**
 * desktop-headroom.test.ts — P-004 / D-007 headroom admission
 * (agent-multi-desktops-grid-2026-10-06, AUTO-BAR-R-3-P-004).
 *
 * Every measurement is injected, so these run without /proc, cgroups or Postgres.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_FOOTPRINT_FLOOR_BYTES,
  DESKTOP_HOST_RESERVE_MIN_BYTES,
  admissionRefusal,
  admitNewDesktop,
  decideDesktopAdmission,
  desktopAdmissionOverridesFromEnv,
  hostReserveBytes,
  measureDesktopFootprintBytes,
  medianBytes,
  outermostCgroups,
} from './desktop-headroom';
import type { DesktopSessionRecord } from '../../desktop/desktop-session-registry';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

describe('decideDesktopAdmission (pure)', () => {
  const base = { totalBytes: 16 * GiB, liveCount: 0, softCap: null } as const;

  it('admits when MemAvailable covers footprint + reserve', () => {
    const v = decideDesktopAdmission({ ...base, availableBytes: 8 * GiB, footprints: [] });
    expect(v).toMatchObject({ admit: true, footprintSource: 'floor', footprintBytes: DESKTOP_FOOTPRINT_FLOOR_BYTES });
  });

  it('refuses with desktop_headroom_exhausted when available minus the footprint falls below the reserve', () => {
    // reserve = max(2 GiB, 10% of 16 GiB = 1.6 GiB) = 2 GiB; measured footprint 700 MiB.
    const v = decideDesktopAdmission({ ...base, availableBytes: 2 * GiB + 600 * MiB, footprints: [600 * MiB, 700 * MiB, 900 * MiB] });
    expect(v.admit).toBe(false);
    expect(v.code).toBe('desktop_headroom_exhausted');
    expect(v.footprintSource).toBe('measured');
    expect(v.footprintBytes).toBe(700 * MiB); // the median, not the mean or the max
    expect(v.neededBytes).toBe(700 * MiB + 2 * GiB);
  });

  it('uses the MEASURED median once any desktop is measured, so a small footprint admits where the floor would not', () => {
    const avail = 2 * GiB + 500 * MiB;
    expect(decideDesktopAdmission({ ...base, availableBytes: avail, footprints: [] }).admit).toBe(false); // floor 1 GiB
    expect(decideDesktopAdmission({ ...base, availableBytes: avail, footprints: [300 * MiB] }).admit).toBe(true);
  });

  it('enforces the optional soft cap before memory', () => {
    const v = decideDesktopAdmission({ ...base, availableBytes: 64 * GiB, footprints: [], liveCount: 4, softCap: 4 });
    expect(v).toMatchObject({ admit: false, code: 'desktop_soft_cap_reached', softCap: 4, liveCount: 4 });
  });

  it('admits but flags unmeasured when MemAvailable is unreadable', () => {
    expect(decideDesktopAdmission({ ...base, availableBytes: null, footprints: [] })).toMatchObject({ admit: true, unmeasured: true });
  });

  it('host reserve is the larger of 2 GiB and 10% of MemTotal, overridable', () => {
    expect(hostReserveBytes(8 * GiB)).toBe(DESKTOP_HOST_RESERVE_MIN_BYTES);
    expect(hostReserveBytes(64 * GiB)).toBe(Math.round(6.4 * GiB));
    expect(hostReserveBytes(null)).toBe(DESKTOP_HOST_RESERVE_MIN_BYTES);
    expect(hostReserveBytes(64 * GiB, 1 * GiB)).toBe(1 * GiB);
  });

  it('median ignores non-positive samples', () => {
    expect(medianBytes([])).toBeNull();
    expect(medianBytes([0, -1])).toBeNull();
    expect(medianBytes([4, 0, 2])).toBe(3);
  });

  it('env knobs parse numbers and ignore junk', () => {
    expect(desktopAdmissionOverridesFromEnv({ PAPERCUSP_DESKTOP_SOFT_CAP: '6.9', PAPERCUSP_DESKTOP_HOST_RESERVE_BYTES: '1000' })).toEqual({ softCap: 6, reserveBytes: 1000 });
    expect(desktopAdmissionOverridesFromEnv({ PAPERCUSP_DESKTOP_SOFT_CAP: 'lots' })).toEqual({ softCap: null, reserveBytes: null });
  });
});

describe('measured footprint = the desktop task subtree\'s cgroup memory', () => {
  it('sums the subtree, counting a nested cgroup once', async () => {
    const mem: Record<string, number | null> = { '/u/a.scope': 500 * MiB, '/u/a.scope/child': 100 * MiB, '/u/wm.scope': 50 * MiB, '/u/gone.scope': null };
    const bytes = await measureDesktopFootprintBytes(
      { taskId: 'root-1' },
      { listSubtreeCgroups: async () => Object.keys(mem), memoryBytes: (p) => mem[p] ?? null },
    );
    expect(bytes).toBe(550 * MiB);
  });

  it('is null for an unenrolled desktop or one whose cgroups are all gone', async () => {
    const deps = { listSubtreeCgroups: vi.fn(async () => ['/u/x.scope']), memoryBytes: () => null };
    expect(await measureDesktopFootprintBytes({ taskId: null }, deps)).toBeNull();
    expect(deps.listSubtreeCgroups).not.toHaveBeenCalled();
    expect(await measureDesktopFootprintBytes({ taskId: 't' }, deps)).toBeNull();
  });

  it('outermostCgroups keeps siblings, drops descendants and prefix look-alikes stay distinct', () => {
    expect(outermostCgroups(['/a/b', '/a', '/ab', '/a/b/c', '/a'])).toEqual(['/a', '/ab']);
  });
});

describe('admitNewDesktop', () => {
  const row = (over: Partial<DesktopSessionRecord>): DesktopSessionRecord =>
    ({ id: 'r', scope: 'agent', scopeRef: 'agent-a', name: 'desktop-1', state: 'ready', taskId: 't', lastActiveAt: null, ...over }) as DesktopSessionRecord;

  it("on refusal lists ONLY the caller's own idle/frozen desktops as releasable", async () => {
    const live = [
      row({ id: 'a1', name: 'desktop-1', state: 'idle' }),
      row({ id: 'a2', name: 'desktop-2', state: 'ready' }),
      row({ id: 'a3', name: 'desktop-3', state: 'frozen' }),
      row({ id: 'b1', scopeRef: 'agent-b', state: 'idle' }),
      row({ id: 'p1', scope: 'pot', scopeRef: 'pot-1', name: null, state: 'idle' }),
    ];
    const res = await admitNewDesktop(
      { workspaceId: 'ws', ownerId: 'agent-a' },
      {
        listLive: async () => live,
        measure: async () => 800 * MiB,
        availableBytes: () => 1 * GiB,
        totalBytes: () => 16 * GiB,
        overrides: () => ({ softCap: null, reserveBytes: null }),
      },
    );
    expect(res.verdict).toMatchObject({ admit: false, code: 'desktop_headroom_exhausted', measuredDesktops: 5, liveCount: 5 });
    expect(res.releasable.map((r) => r.desktopSessionId)).toEqual(['a1', 'a3']);
    const payload = admissionRefusal(res);
    expect(payload).toMatchObject({ ok: false, error: 'desktop_headroom_exhausted', liveDesktops: 5 });
    expect(String(payload.next)).toContain('computer:release_desktop');
  });

  it('degrades to the floor footprint when the registry or a measurement fails', async () => {
    const res = await admitNewDesktop(
      { workspaceId: 'ws', ownerId: 'agent-a' },
      {
        listLive: async () => {
          throw new Error('pg down');
        },
        measure: async () => {
          throw new Error('unreachable');
        },
        availableBytes: () => 64 * GiB,
        totalBytes: () => 64 * GiB,
        overrides: () => ({ softCap: null, reserveBytes: null }),
      },
    );
    expect(res.verdict).toMatchObject({ admit: true, footprintSource: 'floor', liveCount: 0 });
    expect(res.releasable).toEqual([]);
  });
});
