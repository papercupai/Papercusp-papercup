/**
 * P-003 / D-005 — which desktop a computer verb drives, and who may drive it.
 * Pure over injected registry seams: no Postgres, no X.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DesktopSessionRecord } from '../../desktop/desktop-session-registry';
import { DesktopTargetError, prepareDesktopForDrive, resolveAgentDesktop, type DesktopTargetDeps } from './desktop-target';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function row(over: Partial<DesktopSessionRecord>): DesktopSessionRecord {
  return {
    id: ID(1),
    workspaceId: 'ws',
    harnessSlug: 'pot-1',
    kind: 'kasmvnc',
    scope: 'agent',
    scopeRef: 'agent-a',
    name: 'desktop-1',
    hostRef: null,
    ownerPid: null,
    ownerBootId: null,
    display: ':120',
    displayGeometry: { width: 1280, height: 800, depth: 24 },
    captureGeometry: { width: 1024, height: 640 },
    state: 'ready',
    leaseHolder: 'agent-a',
    viewerMode: 'none',
    viewerActor: null,
    capabilities: {} as DesktopSessionRecord['capabilities'],
    ttlSec: null,
    taskId: 'task-1',
    idleAfterSec: null,
    frozenAt: null,
    createdAt: new Date('2026-10-06T00:00:00Z'),
    lastActiveAt: new Date('2026-10-06T00:00:00Z'),
    releasedAt: null,
    ...over,
  } as DesktopSessionRecord;
}

const d1 = row({ id: ID(1), name: 'desktop-1', display: ':120', lastActiveAt: new Date('2026-10-06T01:00:00Z') });
const d2 = row({ id: ID(2), name: 'desktop-2', display: ':121', lastActiveAt: new Date('2026-10-06T02:00:00Z') });
const frameRow = row({ id: ID(3), name: null, display: ':99' }); // deployed-frame allocator row: no name
const otherAgent = row({ id: ID(4), scopeRef: 'agent-b', leaseHolder: 'agent-b', name: 'desktop-1', display: ':122' });
const potRow = row({ id: ID(5), scope: 'pot', scopeRef: 'pot-1', name: null, display: ':110' });
const otherPot = row({ id: ID(6), scope: 'pot', scopeRef: 'pot-2', name: null, display: ':111' });
const all = [d1, d2, frameRow, otherAgent, potRow, otherPot];

function deps(): DesktopTargetDeps {
  return {
    workspaceId: () => 'ws',
    getSession: vi.fn(async ({ id }: { id: string }) => all.find((r) => r.id === id)) as unknown as DesktopTargetDeps['getSession'],
    listSessions: vi.fn(async (f: { scope?: string; scopeRef?: string }) =>
      all.filter((r) => (!f.scope || r.scope === f.scope) && (!f.scopeRef || r.scopeRef === f.scopeRef)),
    ) as unknown as DesktopTargetDeps['listSessions'],
  };
}

// Same identity shape desktop-multi.test.ts uses: a signed-spawn cup resolves its ownerId from uiClientId.
const cup = (ownerId: string, pot = 'pot-1') => ({ uiClientId: ownerId, sigVerifiedSpawn: true, role: 'cup', harnessSlug: pot });
const agentA = cup('agent-a');
const agentC = cup('agent-c');
const operator = { uiClientId: 'su-x', isSuperuser: true, harnessSlug: null };

describe('resolveAgentDesktop (D-005)', () => {
  it('picks the most recently used of several agent desktops and ignores nameless frame rows', async () => {
    const r = await resolveAgentDesktop(agentA as never, undefined, deps());
    expect(r?.session.id).toBe(d2.id);
    expect(r?.via).toBe('most-recent-agent-desktop');
  });

  it('returns null for a caller with no agent desktops, handing back to the pot/env chain', async () => {
    expect(await resolveAgentDesktop(agentC as never, undefined, deps())).toBeNull();
  });

  it('resolves an explicit desktop by the caller\'s own name, or by id', async () => {
    expect((await resolveAgentDesktop(agentA as never, 'desktop-1', deps()))?.session.id).toBe(d1.id);
    expect((await resolveAgentDesktop(agentA as never, ID(2), deps()))?.via).toBe('explicit');
  });

  it("refuses another agent's desktop by id with desktop_not_owned, before anything is driven", async () => {
    await expect(resolveAgentDesktop(agentA as never, otherAgent.id, deps())).rejects.toMatchObject({ code: 'desktop_not_owned' });
  });

  it("never resolves a name against another agent's desktops", async () => {
    // agent-b also has a desktop called desktop-1; agent-c asking for it gets not-found, not agent-b's.
    await expect(resolveAgentDesktop(agentC as never, 'desktop-1', deps())).rejects.toMatchObject({ code: 'desktop_not_found' });
  });

  it("lets a caller drive its own pot's shared desktop by id, but not another pot's", async () => {
    expect((await resolveAgentDesktop(agentA as never, potRow.id, deps()))?.session.display).toBe(':110');
    await expect(resolveAgentDesktop(agentA as never, otherPot.id, deps())).rejects.toBeInstanceOf(DesktopTargetError);
  });

  it('lets an operator session drive any desktop by explicit id', async () => {
    expect((await resolveAgentDesktop(operator as never, otherAgent.id, deps()))?.session.id).toBe(otherAgent.id);
  });

  it('reports an unknown id as desktop_not_found, with the error code leading the message', async () => {
    await expect(resolveAgentDesktop(agentA as never, ID(99), deps())).rejects.toThrow(/^desktop_not_found: /);
  });
});

describe('prepareDesktopForDrive', () => {
  it('thaws a frozen desktop before touching it', async () => {
    const order: string[] = [];
    await prepareDesktopForDrive(row({ state: 'frozen', taskId: 'task-9' }), {
      thaw: async (t) => void order.push(`thaw:${t}`),
      markThawed: (async () => void order.push('markThawed')) as unknown as DesktopTargetDeps['markThawed'],
      touch: (async () => void order.push('touch')) as unknown as DesktopTargetDeps['touch'],
    });
    expect(order).toEqual(['thaw:task-9', 'markThawed', 'touch']);
  });

  it('only touches a desktop that is not frozen, and swallows a failed touch', async () => {
    const thaw = vi.fn();
    await prepareDesktopForDrive(row({ state: 'idle' }), {
      thaw,
      touch: (async () => {
        throw new Error('pg down');
      }) as unknown as DesktopTargetDeps['touch'],
    });
    expect(thaw).not.toHaveBeenCalled();
  });
});
