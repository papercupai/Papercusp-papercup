/**
 * desktop-multi.test.ts — an agent owning MANY desktops
 * (agent-multi-desktops-grid-2026-10-06 P-002; D-003, D-005, D-006, D-012, D-013).
 *
 * Covers the three layers in one file because they share one registry mock:
 *  - desktop-names / desktop-ownership: the pure rules;
 *  - desktop-lease: scope-key keying, per-key in-flight coalescing, release by id/name,
 *    and that reconcile/reap see agent leases (the D-012 hosted-reconcile hazard);
 *  - the three computer:*_desktop tools: the agent door, the ownership refusals.
 *
 * The provisioner and the registry are both faked, so no X server or Postgres runs.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({
  registerDesktopSession: vi.fn(async (input: { scope: string; scopeRef: string; name?: string | null }) => ({
    id: randomUUID(),
    ...input,
  })),
  markDesktopReady: vi.fn(async () => undefined),
  closeDesktopSession: vi.fn(async () => true),
  resolveDesktopForScope: vi.fn(async (): Promise<unknown> => undefined),
  getDesktopSession: vi.fn(async (): Promise<unknown> => undefined),
  listDesktopSessions: vi.fn(async (): Promise<unknown[]> => []),
  DEFAULT_CAPTURE_GEOMETRY: { width: 1024, height: 768 },
}));
vi.mock('../../desktop/desktop-session-registry', () => registry);
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-multi' }));
const killTask = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../task-manager/control', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../task-manager/control')>()),
  killTask,
}));
// P-004: admission measures the real host; here it is a controllable seam. The real
// refusal formatter is kept so the refusal payload under test is the shipped one.
const admit = vi.hoisted(() =>
  vi.fn(async (): Promise<unknown> => ({ verdict: { admit: true }, releasable: [] })),
);
vi.mock('./desktop-headroom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./desktop-headroom')>()),
  admitNewDesktop: admit,
}));

import {
  __resetProvisioner,
  __setProvisionerForTests,
  desktopSessionIdFor,
  ensureDesktop,
  ensureHiveDesktop,
  leasedDesktop,
  leasedDesktopSessionIds,
  leasedHiveDesktops,
  listDesktopLeases,
  reapDeadDesktops,
  reapDeadHiveDesktops,
  releaseAllDesktops,
  releaseDesktop,
  releaseDesktopBySessionId,
  type DesktopLeaseTarget,
} from './desktop-lease';
import { agentLeaseKey, isValidDesktopName, nextDefaultDesktopName, potLeaseKey } from './desktop-names';
import { desktopAccess, desktopCallerFromCtx } from './desktop-ownership';
import type { ProvisionOptions, SandboxDesktop } from './desktop-provisioner';
import { NO_GL_STRATEGY } from '../../desktop/gl-strategy';
import provisionTool from './provision-desktop';
import releaseTool from './release-desktop';
import listTool from './list-desktops';

type Tool = { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> };
const provision = provisionTool as unknown as Tool;
const release = releaseTool as unknown as Tool;
const list = listTool as unknown as Tool;
const parse = (r: { content: Array<{ text: string }> }): Record<string, unknown> => JSON.parse(r.content[0].text);

/** A worker (role cup) whose identity resolves through the verified-spawn branch. */
const cupCtx = (ownerId: string, pot = 'pot-1') => ({ uiClientId: ownerId, sigVerifiedSpawn: true, role: 'cup', harnessSlug: pot });

let displayNo = 300;
const alive = new Map<string, boolean>();
function fakeProvisioner() {
  const seen: ProvisionOptions[] = [];
  const provisioner = vi.fn(async (opts?: ProvisionOptions): Promise<SandboxDesktop> => {
    seen.push(opts ?? {});
    const display = `:${displayNo++}`;
    alive.set(display, true);
    return {
      display,
      number: Number(display.slice(1)),
      width: opts?.width ?? 1024,
      height: opts?.height ?? 768,
      gl: NO_GL_STRATEGY,
      glProbeSandboxed: false,
      appDiagnostics: () => [],
      xServer: 'xvfb',
      taskId: null,
      isAlive: () => alive.get(display) !== false,
      release: async () => {
        alive.set(display, false);
      },
    };
  });
  __setProvisionerForTests(provisioner);
  return { seen, provisioner };
}

afterEach(async () => {
  await releaseAllDesktops();
  __resetProvisioner();
  vi.clearAllMocks();
});

describe('AUTO-BAR-R-1: two agents, five desktops, through the tool doors', () => {
  it('A starts 3 and B starts 2: distinct ids + displays, list shows all 5 with owners, releasing one leaves 4, the pot desktop still works', async () => {
    fakeProvisioner();
    const started: Array<{ owner: string; id: string; display: string; name: string }> = [];
    for (const [owner, n] of [['agent-a', 3], ['agent-b', 2]] as const) {
      for (let i = 0; i < n; i++) {
        const r = parse(await provision.handler({}, cupCtx(owner)));
        expect(r.ok).toBe(true);
        expect(r.scope).toBe('agent');
        started.push({ owner, id: r.desktopSessionId as string, display: r.display as string, name: r.name as string });
      }
    }
    expect(new Set(started.map((s) => s.id)).size).toBe(5);
    expect(new Set(started.map((s) => s.display)).size).toBe(5);
    expect(started.filter((s) => s.owner === 'agent-a').map((s) => s.name)).toEqual(['desktop-1', 'desktop-2', 'desktop-3']);
    expect(admit).toHaveBeenCalledTimes(5); // every NEW desktop asked for headroom

    const pot = await ensureHiveDesktop('pot-1'); // the pot-shared desktop beside them

    const listed = parse(await list.handler({ filter: 'all' }, cupCtx('agent-a')));
    const agentRows = (listed.desktops as Array<{ scope: string; ownerId: string | null; id: string | null }>).filter((d) => d.scope === 'agent');
    expect(agentRows).toHaveLength(5);
    expect(agentRows.filter((d) => d.ownerId === 'agent-a')).toHaveLength(3);
    expect(agentRows.filter((d) => d.ownerId === 'agent-b')).toHaveLength(2);

    const victim = started[1]!;
    const rel = parse(await release.handler({ desktop: victim.id }, cupCtx('agent-a')));
    expect(rel.ok).toBe(true);
    const after = parse(await list.handler({ filter: 'all' }, cupCtx('agent-a')));
    const live = (after.desktops as Array<{ scope: string; id: string | null }>).filter((d) => d.scope === 'agent');
    expect(live.map((d) => d.id).sort()).toEqual(started.filter((s) => s !== victim).map((s) => s.id).sort());
    expect(leasedHiveDesktops()).toEqual(['pot-1']);
    expect(pot.isAlive?.()).toBe(true);
  });
});

describe('P-004 headroom admission at the provision door (D-007)', () => {
  it('refuses a NEW desktop with the measured numbers and the caller\'s idle desktops, provisioning nothing', async () => {
    const { provisioner } = fakeProvisioner();
    admit.mockResolvedValueOnce({
      verdict: {
        admit: false,
        code: 'desktop_headroom_exhausted',
        availableBytes: 1 * 1024 ** 3,
        neededBytes: 3 * 1024 ** 3,
        reserveBytes: 2 * 1024 ** 3,
        footprintBytes: 1 * 1024 ** 3,
        footprintSource: 'measured',
        measuredDesktops: 2,
        liveCount: 2,
        softCap: null,
      },
      releasable: [{ name: 'desktop-2', desktopSessionId: 'row-2', state: 'idle', lastActiveAt: null }],
    });
    const r = await provision.handler({}, cupCtx('agent-a'));
    const body = parse(r);
    expect(r.isError).toBe(true);
    expect(body).toMatchObject({ ok: false, error: 'desktop_headroom_exhausted', availableBytes: 1 * 1024 ** 3, neededBytes: 3 * 1024 ** 3 });
    expect(body.releasable).toEqual([expect.objectContaining({ name: 'desktop-2' })]);
    expect(String(body.reason)).toContain('1024 MiB available, 3072 MiB needed');
    expect(provisioner).not.toHaveBeenCalled();
    expect(admit).toHaveBeenCalledWith({ workspaceId: 'ws-multi', ownerId: 'agent-a' });
  });

  it('never asks for headroom when the name is already leased (reuse is free)', async () => {
    fakeProvisioner();
    await provision.handler({ name: 'work' }, cupCtx('agent-a'));
    admit.mockClear();
    const again = parse(await provision.handler({ name: 'work' }, cupCtx('agent-a')));
    expect(again.reused).toBe(true);
    expect(admit).not.toHaveBeenCalled();
  });
});

describe('desktop names and lease keys (pure)', () => {
  it('accepts short lowercase slugs and rejects everything else', () => {
    for (const ok of ['desktop-1', 'checkout', 'a', 'x.y_z-9']) expect(isValidDesktopName(ok)).toBe(true);
    for (const bad of ['', 'Desktop', '-lead', 'has space', 'a/b', 'x'.repeat(64)]) expect(isValidDesktopName(bad)).toBe(false);
  });

  it('picks the first free desktop-<n>, reusing a released number', () => {
    expect(nextDefaultDesktopName([])).toBe('desktop-1');
    expect(nextDefaultDesktopName(['desktop-1', 'desktop-2'])).toBe('desktop-3');
    expect(nextDefaultDesktopName(['desktop-1', 'desktop-3', 'checkout'])).toBe('desktop-2');
  });

  it('keeps pot and agent keys in disjoint namespaces', () => {
    expect(potLeaseKey('alpha')).not.toBe(agentLeaseKey('alpha', 'alpha'));
    expect(agentLeaseKey('a1', 'd1')).not.toBe(agentLeaseKey('a1', 'd2'));
  });
});

describe('ownership rule (D-005)', () => {
  const cup = desktopCallerFromCtx(cupCtx('agent-a'));
  const su = desktopCallerFromCtx({ isSuperuser: true, uiClientId: 'su-1' });

  it('lets an agent act on its own desktops only', () => {
    expect(desktopAccess({ scope: 'agent', scopeRef: 'agent-a' }, cup, 'release').ok).toBe(true);
    const other = desktopAccess({ scope: 'agent', scopeRef: 'agent-b' }, cup, 'drive');
    expect(other).toEqual(expect.objectContaining({ ok: false, code: 'desktop_not_owned' }));
  });

  it('lets a worker drive its own pot desktop but not release it or touch another pot', () => {
    expect(desktopAccess({ scope: 'pot', scopeRef: 'pot-1' }, cup, 'drive').ok).toBe(true);
    expect(desktopAccess({ scope: 'pot', scopeRef: 'pot-1' }, cup, 'release').ok).toBe(false);
    expect(desktopAccess({ scope: 'pot', scopeRef: 'pot-2' }, cup, 'drive').ok).toBe(false);
  });

  it('lets an operator session act on any desktop, and nobody else on the workspace desktop', () => {
    expect(su.isOperator).toBe(true);
    expect(desktopAccess({ scope: 'agent', scopeRef: 'agent-b' }, su, 'release').ok).toBe(true);
    expect(desktopAccess({ scope: 'workspace', scopeRef: 'ws' }, cup, 'drive').ok).toBe(false);
  });
});

describe('desktop-lease with many desktops per agent', () => {
  const a1: DesktopLeaseTarget = { scope: 'agent', ownerId: 'agent-a', name: 'desktop-1' };
  const a2: DesktopLeaseTarget = { scope: 'agent', ownerId: 'agent-a', name: 'desktop-2' };

  it('provisions two names of one agent independently, beside a pot desktop', async () => {
    const { provisioner } = fakeProvisioner();
    const [d1, d2, pot] = await Promise.all([ensureDesktop(a1), ensureDesktop(a2), ensureHiveDesktop('pot-1')]);
    expect(provisioner).toHaveBeenCalledTimes(3);
    expect(new Set([d1.display, d2.display, pot.display]).size).toBe(3);
    expect(leasedHiveDesktops()).toEqual(['pot-1']); // agent leases never masquerade as hives
    expect(listDesktopLeases().filter((l) => l.scope === 'agent').map((l) => l.name).sort()).toEqual(['desktop-1', 'desktop-2']);
  });

  it('coalesces concurrent ensures of ONE name onto one provision', async () => {
    const { provisioner } = fakeProvisioner();
    const [x, y, z] = await Promise.all([ensureDesktop(a1), ensureDesktop(a1), ensureDesktop(a1)]);
    expect(provisioner).toHaveBeenCalledTimes(1);
    expect(x).toBe(y);
    expect(y).toBe(z);
  });

  it('records an agent desktop as scope agent + name, held by its owner', async () => {
    fakeProvisioner();
    await ensureDesktop({ ...a1, harnessSlug: 'pot-1' });
    expect(registry.registerDesktopSession).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'agent', scopeRef: 'agent-a', name: 'desktop-1', leaseHolder: 'agent-a', harnessSlug: 'pot-1' }),
    );
    expect(desktopSessionIdFor(a1)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('releases by session id, leaving the agent\'s other desktop running', async () => {
    fakeProvisioner();
    await ensureDesktop(a1);
    const keep = await ensureDesktop(a2);
    const id = desktopSessionIdFor(a1) as string;
    expect(await releaseDesktopBySessionId(id)).toEqual({ released: true, via: 'local' });
    expect(leasedDesktop(a1)).toBeUndefined();
    expect(leasedDesktop(a2)).toBe(keep);
    expect(registry.closeDesktopSession).toHaveBeenCalledWith(id, 'released');
  });

  it('falls back to the registry row (by name) for a desktop a sibling process holds', async () => {
    registry.resolveDesktopForScope.mockResolvedValueOnce({ id: 'row-1', taskId: 'task-9', scope: 'agent', scopeRef: 'agent-a' });
    expect(await releaseDesktop(a2)).toEqual({ released: true, via: 'registry' });
    expect(registry.resolveDesktopForScope).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'agent', scopeRef: 'agent-a', name: 'desktop-2' }),
    );
    expect(killTask).toHaveBeenCalledWith('task-9', { includeSubtree: true });
  });

  it('vouches for EVERY live lease in reconcile, agent desktops included (D-012)', async () => {
    fakeProvisioner();
    await ensureDesktop(a1);
    await ensureHiveDesktop('pot-1');
    const ids = leasedDesktopSessionIds();
    expect(ids).toHaveLength(2);
    expect(ids).toContain(desktopSessionIdFor(a1));
  });

  it('reaps dead agent and pot leases; the per-hive wrapper reports only the pot', async () => {
    fakeProvisioner();
    const dead = await ensureDesktop(a1);
    const deadPot = await ensureHiveDesktop('pot-dead');
    await ensureDesktop(a2);
    alive.set(dead.display, false);
    alive.set(deadPot.display, false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await reapDeadHiveDesktops()).toEqual(['pot-dead']);
    expect(warn).toHaveBeenCalledTimes(2); // one "the desktop is gone" line per reaped lease
    // Journal labels stay human-greppable: `pot=<slug>` for pots (unchanged), and the
    // owner + desktop name for agent leases — never the opaque compound lease key.
    const lines = warn.mock.calls.map(([line]) => String(line)).sort();
    expect(lines[0]).toMatch(/^\[desktop-lease\] agent=agent-a name=desktop-1 display=:\d+: the desktop is gone/);
    expect(lines[1]).toMatch(/^\[desktop-lease\] pot=pot-dead display=:\d+: the desktop is gone/);
    warn.mockRestore();
    expect(leasedDesktop(a1)).toBeUndefined(); // reaped too, though not reported by the hive wrapper
    expect(leasedDesktop(a2)).toBeDefined();
    expect(await reapDeadDesktops()).toEqual([]);
  });
});

describe('computer:*_desktop tools — the agent door', () => {
  it('lets a worker start several desktops for itself, default-named and idempotent per name', async () => {
    fakeProvisioner();
    const ctx = cupCtx('agent-a');
    const one = parse(await provision.handler({}, ctx));
    const two = parse(await provision.handler({}, ctx));
    const named = parse(await provision.handler({ name: 'checkout' }, ctx));
    const again = parse(await provision.handler({ name: 'checkout', apps: [['xterm']] }, ctx));
    expect([one.name, two.name, named.name]).toEqual(['desktop-1', 'desktop-2', 'checkout']);
    expect(new Set([one.display, two.display, named.display]).size).toBe(3);
    expect(one.desktopSessionId).not.toBe(two.desktopSessionId);
    expect(again).toEqual(expect.objectContaining({ reused: true, desktopSessionId: named.desktopSessionId }));
  });

  it('returns a sibling process\'s desktop of the same name instead of starting a duplicate', async () => {
    const { provisioner } = fakeProvisioner();
    registry.listDesktopSessions.mockResolvedValueOnce([
      {
        id: 'b7c1e9a4-0000-4000-8000-000000000001',
        name: 'desktop-1',
        scope: 'agent',
        scopeRef: 'agent-a',
        display: ':120',
        displayGeometry: { width: 1024, height: 768, depth: 24 },
        captureGeometry: { width: 1024, height: 768 },
      },
    ]);
    const r = parse(await provision.handler({ name: 'desktop-1' }, cupCtx('agent-a')));
    expect(r).toEqual(expect.objectContaining({ reused: true, liveHandleInThisProcess: false, display: ':120' }));
    expect(provisioner).not.toHaveBeenCalled();
  });

  it('refuses a worker equipping its whole pot', async () => {
    fakeProvisioner();
    const r = await provision.handler({ pot: 'pot-1' }, cupCtx('agent-a'));
    expect(r.isError).toBe(true);
    expect(parse(r).error).toBe('pot_desktop_not_permitted');
  });

  it('refuses releasing another agent\'s desktop by id, and releases your own by name', async () => {
    fakeProvisioner();
    const mine = parse(await provision.handler({ name: 'mine' }, cupCtx('agent-a')));
    const theirs = parse(await provision.handler({ name: 'theirs' }, cupCtx('agent-b')));

    const refused = await release.handler({ desktop: theirs.desktopSessionId }, cupCtx('agent-a'));
    expect(refused.isError).toBe(true);
    expect(parse(refused).error).toBe('desktop_not_owned');
    expect(leasedDesktop({ scope: 'agent', ownerId: 'agent-b', name: 'theirs' })).toBeDefined();

    expect(parse(await release.handler({ desktop: 'mine' }, cupCtx('agent-a')))).toEqual(
      expect.objectContaining({ released: true }),
    );
    expect(leasedDesktop({ scope: 'agent', ownerId: 'agent-a', name: 'mine' })).toBeUndefined();
    expect(mine.desktopSessionId).toBeTruthy();
  });

  it('lets an operator release any desktop by explicit id', async () => {
    fakeProvisioner();
    const theirs = parse(await provision.handler({ name: 'theirs' }, cupCtx('agent-b')));
    const r = parse(await release.handler({ desktop: theirs.desktopSessionId }, { isSuperuser: true, uiClientId: 'su-1' }));
    expect(r.released).toBe(true);
  });

  it('lists only the caller\'s desktops under filter "mine"', async () => {
    fakeProvisioner();
    await provision.handler({ name: 'a-one' }, cupCtx('agent-a'));
    await provision.handler({ name: 'b-one' }, cupCtx('agent-b'));
    const mine = parse(await list.handler({ filter: 'mine' }, cupCtx('agent-a')));
    expect((mine.desktops as Array<{ name: string; ownerId: string }>).map((d) => [d.name, d.ownerId])).toEqual([['a-one', 'agent-a']]);
    const all = parse(await list.handler({}, cupCtx('agent-a')));
    expect(all.count).toBe(2);
  });
});
