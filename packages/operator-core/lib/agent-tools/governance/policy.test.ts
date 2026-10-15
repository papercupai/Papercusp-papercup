/**
 * policy.test.ts — the governance:policy TOOL (papercusp-enterprise-readiness-roadmap-2026-10-09
 * P-005, WI-10007900). The operations themselves are pinned in governance-policy/control.test.ts;
 * this pins the DOOR: the anti-lockout name, the write-role gate, workspace defaulting,
 * request normalization and actor attribution.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../governance-policy/control', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../governance-policy/control')>();
  return {
    ...real,
    getGovernancePolicyState: vi.fn(async (workspaceId: string) => ({ workspaceId, load: 'none' })),
    explainGovernancePolicy: vi.fn(async (workspaceId: string, request: unknown) => ({ workspaceId, request })),
    simulateGovernancePolicy: vi.fn(async () => ({ cases: [] })),
    setGovernancePolicyLayer: vi.fn(async () => ({ ok: true, revision: 'ws-a@v1' })),
    addGovernancePolicyException: vi.fn(async () => ({ ok: true, revision: 'org-a@v2' })),
    prepareGovernancePolicyChange: vi.fn(async () => ({ ok: true, request: { requestId: 'sar-1' } })),
    applyGovernancePolicyChange: vi.fn(async () => ({ ok: true, revision: 'dept-a@v3' })),
    readGovernanceAuthority: vi.fn(async () => ({ delegations: [], requests: [] })),
  };
});

import {
  addGovernancePolicyException,
  applyGovernancePolicyChange,
  explainGovernancePolicy,
  getGovernancePolicyState,
  prepareGovernancePolicyChange,
  readGovernanceAuthority,
  setGovernancePolicyLayer,
} from '../../governance-policy/control';
import { GOVERNANCE_ADMIN_TOOLS } from '../../governance-policy/enforce';

const tool = (await import('./policy')).default;

type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);
const call = (args: unknown, ctx: Record<string, unknown>) => tool.handler(args as never, ctx as never);

const LAYER = {
  layerId: 'ws-a',
  level: 'workspace' as const,
  scopeRef: 'papercusp-workspace',
  parentLayerId: 'org-a',
  rules: { tools: { deny: ['capability:bash'] } },
};

beforeEach(() => vi.clearAllMocks());

describe('governance:policy tool', () => {
  it('its name is exactly the one the enforcement seat exempts (anti-lockout drift guard)', () => {
    expect(GOVERNANCE_ADMIN_TOOLS.has(tool.name)).toBe(true);
  });

  it('set and add-exception refuse a role without operator-config write, and write nothing', async () => {
    await expect(call({ op: 'set', ...LAYER, reason: 'x' }, { role: 'worker', ownerId: 'w-1' })).rejects.toThrow(
      /requires operator/,
    );
    await expect(
      call(
        { op: 'add-exception', layerId: 'org-a', reason: 'x', exception: { category: 'tools', pattern: 'x', reason: 'y', expiresAt: '2026-10-20T00:00:00Z' } },
        { role: 'worker' },
      ),
    ).rejects.toThrow(/requires operator/);
    expect(setGovernancePolicyLayer).not.toHaveBeenCalled();
    expect(addGovernancePolicyException).not.toHaveBeenCalled();
  });

  it('set attributes the write to the calling owner and passes no op field through', async () => {
    const b = body(await call({ op: 'set', ...LAYER, reason: 'tighten', expectedVersion: 0 }, { role: 'operator', ownerId: 'su-1' }));
    expect(b).toEqual({ ok: true, revision: 'ws-a@v1' });
    const [req, actor] = vi.mocked(setGovernancePolicyLayer).mock.calls[0]!;
    expect(actor).toBe('su-1');
    expect(req).not.toHaveProperty('op');
    expect(req).toMatchObject({ layerId: 'ws-a', reason: 'tighten', expectedVersion: 0 });
  });

  it('get defaults to the session workspace; an explicit workspaceId wins', async () => {
    await call({ op: 'get' }, { role: 'su', workspaceId: 'ws-session' });
    await call({ op: 'get', workspaceId: 'ws-explicit' }, { role: 'su', workspaceId: 'ws-session' });
    expect(vi.mocked(getGovernancePolicyState).mock.calls.map((c) => c[0])).toEqual(['ws-session', 'ws-explicit']);
  });

  it('read ops refuse when there is no workspace to judge', async () => {
    await expect(call({ op: 'get' }, { role: 'su' })).rejects.toThrow(/pass workspaceId/);
  });

  it('explain normalizes the request (trims, drops blanks) before judging', async () => {
    await call({ op: 'explain', request: { tools: [' coord:send ', ''] } }, { role: 'su', workspaceId: 'w' });
    expect(vi.mocked(explainGovernancePolicy).mock.calls[0]!.slice(0, 2)).toEqual(['w', { tools: ['coord:send'] }]);
  });
});

describe('governance:policy tool — sensitive changes (P-006, D-015)', () => {
  const DEPT = { layerId: 'dept-a', level: 'department' as const, scopeRef: 'eng', parentLayerId: 'org-a', rules: { tools: { deny: ['x'] } } };

  it('prepare and apply refuse a role without operator-config write, and do nothing', async () => {
    await expect(call({ op: 'prepare', ...DEPT, workspaceId: 'w', reason: 'r' }, { role: 'worker', ownerId: 'w-1' })).rejects.toThrow(
      /requires operator/,
    );
    await expect(call({ op: 'apply', requestId: 'sar-1' }, { role: 'worker' })).rejects.toThrow(/requires operator/);
    expect(prepareGovernancePolicyChange).not.toHaveBeenCalled();
    expect(applyGovernancePolicyChange).not.toHaveBeenCalled();
  });

  it('prepare attributes the request to the calling agent and normalizes its simulation requests', async () => {
    const b = body(
      await call(
        { op: 'prepare', ...DEPT, workspaceId: 'w', reason: 'tighten', requests: [{ tools: [' x ', ''] }] },
        { role: 'operator', ownerId: 'su-1' },
      ),
    );
    expect(b).toEqual({ ok: true, request: { requestId: 'sar-1' } });
    const [req, actor] = vi.mocked(prepareGovernancePolicyChange).mock.calls[0]!;
    expect(actor).toBe('su-1');
    expect(req).not.toHaveProperty('op');
    expect(req).toMatchObject({ layerId: 'dept-a', workspaceId: 'w', reason: 'tighten', requests: [{ tools: ['x'] }] });
  });

  it('apply forwards the request id and payload hash with the agent as executor', async () => {
    const hash = 'a'.repeat(64);
    await call({ op: 'apply', requestId: 'sar-1', expectedPayloadHash: hash }, { role: 'operator', ownerId: 'su-1' });
    expect(vi.mocked(applyGovernancePolicyChange).mock.calls[0]!.slice(0, 2)).toEqual([{ requestId: 'sar-1', expectedPayloadHash: hash }, 'su-1']);
  });

  it('has no decide or delegate op: an agent is a service identity and never approves', async () => {
    expect(tool.args.safeParse({ op: 'decide', requestId: 'sar-1', decision: 'approve', reason: 'r' }).success).toBe(false);
    expect(tool.args.safeParse({ op: 'delegate', principal: 'su-2', layerId: 'org-a', capabilities: ['prepare'], reason: 'r', expiresAt: '2026-10-20T00:00:00Z' }).success).toBe(false);
  });

  it('authority is a read that defaults to the session workspace', async () => {
    await call({ op: 'authority' }, { role: 'worker', workspaceId: 'ws-session' });
    expect(vi.mocked(readGovernanceAuthority).mock.calls[0]![0]).toEqual({ workspaceId: 'ws-session' });
  });
});
