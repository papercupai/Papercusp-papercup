/**
 * WI-10007010 — an APP harness's own worker role (declared in its pot blueprint's
 * fleet.workerRoles, e.g. calendar's calendar-prep-worker) has no system_principals
 * row and no static BLUEPRINT_ROLE_CAPS entry. Before this fix its synthesized
 * principal carried only agent_tools:read, so a placed accepted-operation worker was
 * refused memory:read / work_items:write by the capability gate even after the
 * identity kernel admitted the call. These cases pin both halves: the declared list
 * reaches the principal, and it can never widen a provisioned or platform role.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Sql } from 'postgres';
import { ROLE_ENVELOPES } from '../../../capability-envelope/policy';

const seams = vi.hoisted(() => ({
  potHome: vi.fn(async (_ws: string, _harness: string): Promise<string | null> => 'calendar'),
  paths: vi.fn(async (slug: string, _ws: string) => ({
    projectDir: `/fake/${slug}`, stateDir: `/fake/${slug}/.papercusp`,
  })),
  declared: vi.fn((_stateDir: string, _role: string): readonly string[] | undefined => undefined),
}));
vi.mock('../../../hive-federation', () => ({ potHomeSlugForHarness: seams.potHome }));
vi.mock('../../../resolve-harness-paths', () => ({ resolveHarnessPaths: seams.paths }));
vi.mock('../../../capability-envelope/blueprint-envelopes', () => ({
  blueprintWorkerRoleCapabilities: seams.declared,
}));

const { loadRoleCapabilities, synthesizeDispatchPrincipal } = await import('./role-principal-caps.js');

const CALENDAR_WORKER_CAPS = ['personal:calendar:read', 'work_items:read', 'work_items:write', 'memory:read'];

function fakeTx(rows: Array<{ capabilities: unknown }>): Sql {
  return (() => Promise.resolve(rows)) as unknown as Sql;
}

beforeEach(() => {
  seams.potHome.mockClear();
  seams.paths.mockClear();
  seams.declared.mockReset();
  seams.declared.mockImplementation((stateDir, role) =>
    stateDir === '/fake/calendar/.papercusp' ? (role === 'calendar-prep-worker' ? CALENDAR_WORKER_CAPS : ['plans:write']) : undefined);
});

describe('app-declared worker role capabilities (WI-10007010)', () => {
  test('the registered researcher gets only its research workflow principal, never app-provided elevation', async () => {
    seams.declared.mockImplementation(() => ['plans:write', 'capability:bash', 'capability:fs-write']);
    const principal = await synthesizeDispatchPrincipal(fakeTx([]), {
      workspaceId: 'ws', role: 'researcher', harnessSlug: 'morning-ai-intelligence',
    });
    expect([...principal.capabilities].sort()).toEqual([
      'agent_tools:read', 'capability:fs-read', 'capability:net', 'coord:write',
      'plans:read', 'reports:read', 'reports:write', 'work_items:read', 'work_items:write',
    ]);
    expect(seams.declared).not.toHaveBeenCalled();
  });

  test('an app worker role gets exactly the capabilities its pot blueprint declares', async () => {
    const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'calendar-prep-worker', 'calendar');
    for (const capability of CALENDAR_WORKER_CAPS) expect(caps.has(capability), capability).toBe(true);
    expect(caps.has('plans:write')).toBe(false);
    expect(seams.declared).toHaveBeenCalledWith('/fake/calendar/.papercusp', 'calendar-prep-worker');
  });

  test('the dispatch principal carries them when the spawn context names the harness', async () => {
    const principal = await synthesizeDispatchPrincipal(fakeTx([]), {
      workspaceId: 'ws', role: 'calendar-prep-worker', harnessSlug: 'calendar',
    });
    expect(principal.slug).toBe('system:calendar-prep-worker');
    expect(principal.capabilities.has('memory:read')).toBe(true);
    expect(principal.capabilities.has('work_items:write')).toBe(true);
  });

  test.each([undefined, '*'])('no concrete harness (%s) means no blueprint lookup and no grant', async (harness) => {
    const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'calendar-prep-worker', harness);
    expect(caps.has('memory:read')).toBe(false);
    expect(seams.declared).not.toHaveBeenCalled();
  });

  test('a provisioned role is never widened by a harness blueprint', async () => {
    const caps = await loadRoleCapabilities(
      fakeTx([{ capabilities: ['coord:read'] }]), 'ws', 'calendar-prep-worker', 'calendar');
    expect([...caps].sort()).toEqual(['agent_tools:read', 'coord:read']);
    expect(seams.declared).not.toHaveBeenCalled();
  });

  test('a platform role known to ROLE_ENVELOPES is never widened, even if a blueprint declares it', async () => {
    const platformRole = Object.keys(ROLE_ENVELOPES)[0]!;
    seams.declared.mockImplementation(() => ['plans:write', 'memory:write']);
    const caps = await loadRoleCapabilities(fakeTx([]), 'ws', platformRole, 'calendar');
    expect(caps.has('memory:write')).toBe(false);
    expect(seams.declared).not.toHaveBeenCalled();
  });

  test('a resolution failure grants nothing and never blocks capability resolution', async () => {
    seams.potHome.mockRejectedValueOnce(new Error('registry unreachable'));
    const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'calendar-prep-worker', 'calendar');
    expect([...caps]).toEqual(['agent_tools:read']);
  });
});
