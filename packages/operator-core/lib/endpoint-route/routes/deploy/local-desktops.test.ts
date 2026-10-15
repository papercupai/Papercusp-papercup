/**
 * Roster mapping for the local-desktop live view
 * (`agent-virtual-desktops-2026-08-23` P-004).
 *
 * WHY THIS FILE EXISTS. Both filters in `toLocalDesktopRows` fail SILENTLY when
 * wrong, and neither shows up as an error anywhere near the mistake:
 *
 *   - a REMOTE row that leaks through renders a tile whose VNC session is then
 *     refused by the admission gate — so the bug surfaces as "this desktop is in
 *     the list but will not open", far from the mapper;
 *   - a display string that does not parse renders a tile with `display: NaN`,
 *     which posts `{"display": null}` and 400s.
 *
 * Neither is caught by typechecking, so they are pinned here.
 */
import { describe, expect, it, vi } from 'vitest';
import { readLocalDesktopRoster, toLocalDesktopRows } from './local-desktops';
import { rosterEntryForSession } from '../../../workspace-host/hosted-desktop-backend';
import type { DesktopSessionRecord } from '../../../desktop/desktop-session-registry';

const rec = (over: Partial<DesktopSessionRecord> = {}): DesktopSessionRecord => ({
  id: 'ds-1',
  workspaceId: 'ws',
  harnessSlug: 'alpha',
  kind: 'xvfb-local',
  scope: 'pot',
  scopeRef: 'alpha',
  name: null,
  hostRef: null,
  ownerPid: 1,
  ownerBootId: 'boot',
  display: ':110',
  displayGeometry: { width: 1280, height: 1024, depth: 24 },
  captureGeometry: { width: 1024, height: 768 },
  state: 'ready',
  leaseHolder: null,
  viewerMode: 'none',
  viewerActor: null,
  capabilities: {},
  ttlSec: null,
  taskId: null,
  idleAfterSec: null,
  frozenAt: null,
  createdAt: new Date(),
  lastActiveAt: new Date(),
  releasedAt: null,
  ...over,
});

describe('toLocalDesktopRows (P-004)', () => {
  it('maps a local session, splitting the display into a number and its raw form', () => {
    const [row] = toLocalDesktopRows([rec()]);
    expect(row).toMatchObject({
      id: 'ds-1',
      slug: 'alpha',
      kind: 'xvfb-local',
      display: 110, // what the VNC route wants
      displayRaw: ':110', // what a human reads
      state: 'ready',
      viewerMode: 'none',
    });
  });

  it('DROPS remote rows — their display belongs to another host', () => {
    const rows = toLocalDesktopRows([
      rec({ id: 'local', hostRef: null }),
      rec({ id: 'remote', hostRef: 'frame-lat-1', kind: 'frame-slot' }),
    ]);
    // Positive control in the same call: the local row DID survive, so the empty
    // remote result is a real exclusion and not a mapper that drops everything.
    expect(rows.map((r) => r.id)).toEqual(['local']);
  });

  it('drops a display that does not parse to a number', () => {
    const rows = toLocalDesktopRows([
      rec({ id: 'ok', display: ':110' }),
      rec({ id: 'wayland', display: 'wayland-0' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['ok']);
  });

  it('carries the viewer binding through so the tile can show who is watching', () => {
    const [row] = toLocalDesktopRows([rec({ viewerMode: 'takeover', viewerActor: 'user:a' })]);
    expect(row.viewerMode).toBe('takeover');
    expect(row.viewerActor).toBe('user:a');
  });

  it('carries BOTH geometries — display vs capture is the D-006 split', () => {
    const [row] = toLocalDesktopRows([rec()]);
    expect(row.displayGeometry).toEqual({ width: 1280, height: 1024, depth: 24 });
    expect(row.captureGeometry).toEqual({ width: 1024, height: 768 });
  });

  it('handles an empty registry without inventing rows', () => {
    expect(toLocalDesktopRows([])).toEqual([]);
  });
});

// ── D-015: the local grid labels tiles exactly as the cloud roster does ───────

describe('roster labels (agent-multi-desktops-grid D-015)', () => {
  it('an agent desktop carries its owner, name and the owner’s current work-item', () => {
    const [row] = toLocalDesktopRows(
      [rec({ scope: 'agent', scopeRef: 'su-abc', name: 'browser-2' })],
      new Map([['su-abc', { workItemId: 'WI-42', intent: 'fix the login flow' }]]),
    );
    expect(row).toMatchObject({
      owner: 'su-abc',
      name: 'browser-2',
      workItemId: 'WI-42',
      workItemIntent: 'fix the login flow',
    });
  });

  it('a pot desktop is owned by its pot and never borrows an agent claim', () => {
    const [row] = toLocalDesktopRows(
      [rec({ scope: 'pot', scopeRef: 'alpha' })],
      // A claim keyed by the pot slug must not label a pot desktop: claims are agent-owned.
      new Map([['alpha', { workItemId: 'WI-9', intent: 'x' }]]),
    );
    expect(row).toMatchObject({ owner: 'alpha', workItemId: null, workItemIntent: null });
  });

  it('a workspace desktop has no owner label (its scopeRef is the workspace id)', () => {
    const [row] = toLocalDesktopRows([rec({ scope: 'workspace', scopeRef: 'ws' })]);
    expect(row.owner).toBeNull();
  });

  it('labels agree with the hosted roster mapper for the same session', () => {
    const session = rec({ scope: 'agent', scopeRef: 'su-abc', name: 'n' });
    const claim = { workItemId: 'WI-1', intent: '  long intent  ' };
    const [row] = toLocalDesktopRows([session], new Map([['su-abc', claim]]));
    const hosted = rosterEntryForSession(session, claim);
    expect({ owner: row.owner, name: row.name, workItemId: row.workItemId, workItemIntent: row.workItemIntent })
      .toEqual({ owner: hosted.owner, name: hosted.name, workItemId: hosted.workItemId, workItemIntent: hosted.workItemIntent });
  });
});

describe('readLocalDesktopRoster (the read behind the route and desktops.local)', () => {
  it('lists this workspace’s sessions and looks each agent owner up once', async () => {
    const listSessions = vi.fn(async () => [
      rec({ id: 'a1', scope: 'agent', scopeRef: 'su-abc', display: ':110' }),
      rec({ id: 'a2', scope: 'agent', scopeRef: 'su-abc', display: ':111' }),
      rec({ id: 'p1', scope: 'pot', scopeRef: 'alpha', display: ':112' }),
    ]);
    const activeClaimFor = vi.fn(async (owner: string) =>
      owner === 'su-abc' ? { workItemId: 'WI-7', intent: 'work' } : null,
    );
    const rows = await readLocalDesktopRoster('ws-1', { listSessions, activeClaimFor, warn: vi.fn() });

    expect(listSessions).toHaveBeenCalledWith({ workspaceId: 'ws-1', limit: 200 });
    expect(activeClaimFor.mock.calls).toEqual([['su-abc']]);
    expect(rows.map((r) => [r.id, r.workItemId])).toEqual([
      ['a1', 'WI-7'],
      ['a2', 'WI-7'],
      ['p1', null],
    ]);
  });

  it('a failed claim lookup drops the label, never the desktop', async () => {
    const warn = vi.fn();
    const rows = await readLocalDesktopRoster('ws-1', {
      listSessions: async () => [rec({ id: 'a1', scope: 'agent', scopeRef: 'su-abc' })],
      activeClaimFor: async () => {
        throw new Error('pg down');
      },
      warn,
    });
    expect(rows.map((r) => [r.id, r.workItemId])).toEqual([['a1', null]]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('su-abc'));
  });

  it('a failed registry read throws so each caller picks its own degradation', async () => {
    await expect(
      readLocalDesktopRoster('ws-1', {
        listSessions: async () => {
          throw new Error('relation does not exist');
        },
        activeClaimFor: async () => null,
      }),
    ).rejects.toThrow(/relation does not exist/);
  });
});
