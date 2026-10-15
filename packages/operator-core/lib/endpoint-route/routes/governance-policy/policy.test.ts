import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-active' }));
vi.mock('../../../governance-policy/control', async (importOriginal) => {
  // Keep the real schemas and request parser; only the operations are replaced.
  const original = await importOriginal<typeof import('../../../governance-policy/control')>();
  return {
    ...original,
    explainGovernancePolicy: vi.fn(),
    simulateGovernancePolicy: vi.fn(),
    setGovernancePolicyLayer: vi.fn(),
    addGovernancePolicyException: vi.fn(),
    prepareGovernancePolicyChange: vi.fn(),
    decideGovernancePolicyChange: vi.fn(),
    applyGovernancePolicyChange: vi.fn(),
    delegateGovernanceAuthority: vi.fn(),
    revokeGovernanceAuthority: vi.fn(),
    readGovernanceAuthority: vi.fn(),
  };
});

import {
  addGovernancePolicyException,
  applyGovernancePolicyChange,
  decideGovernancePolicyChange,
  delegateGovernanceAuthority,
  explainGovernancePolicy,
  prepareGovernancePolicyChange,
  readGovernanceAuthority,
  revokeGovernanceAuthority,
  setGovernancePolicyLayer,
  simulateGovernancePolicy,
} from '../../../governance-policy/control';
import type { SensitiveActionErrorCode } from '../../../governance-policy/sensitive-action';
import routes, { GOVERNANCE_POLICY_CHANGE_STATUS } from './policy';

const [explainRoute, simulateRoute, setRoute, addExceptionRoute, prepareRoute, decideRoute, applyRoute, delegateRoute, revokeRoute, authorityRoute] =
  routes;

const FORBIDDEN_REFUSAL = {
  observed: { authorization: 'not satisfied' },
  liftsWhen: 'the actor has the required governance authority for the target layer',
  whoCanMakeItTrue: ['owner', 'host'],
} as const;

function ctxFor(input: Record<string, unknown>, slug: string | null = 'tester') {
  return { input, principal: slug ? { slug } : null } as never;
}

async function call(route: (typeof routes)[number], input: Record<string, unknown>, slug?: string | null) {
  const res = (await route.handler(new Request('http://127.0.0.1/api/governance-policy'), ctxFor(input, slug))) as Response;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const LAYER = {
  layerId: 'ws-a',
  level: 'workspace',
  scopeRef: 'ws-a',
  parentLayerId: 'dept-eng',
  rules: { tools: { deny: ['plans:*'] } },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(explainGovernancePolicy).mockReset();
  vi.mocked(simulateGovernancePolicy).mockReset();
  vi.mocked(setGovernancePolicyLayer).mockReset();
  vi.mocked(addGovernancePolicyException).mockReset();
});

describe('/api/governance-policy/* — the admin pane doors (P-005)', () => {
  it('declares ten loopback POST doors at the documented paths', () => {
    expect(routes.map((r) => [r.method, r.path, r.auth])).toEqual([
      ['POST', '/governance-policy/explain', 'loopback'],
      ['POST', '/governance-policy/simulate', 'loopback'],
      ['POST', '/governance-policy/set', 'loopback'],
      ['POST', '/governance-policy/add-exception', 'loopback'],
      ['POST', '/governance-policy/prepare', 'loopback'],
      ['POST', '/governance-policy/decide', 'loopback'],
      ['POST', '/governance-policy/apply', 'loopback'],
      ['POST', '/governance-policy/delegate', 'loopback'],
      ['POST', '/governance-policy/revoke-delegation', 'loopback'],
      ['POST', '/governance-policy/authority', 'loopback'],
    ]);
  });

  it('explain defaults to the request-scoped workspace and passes the parsed request', async () => {
    vi.mocked(explainGovernancePolicy).mockResolvedValue({
      workspaceId: 'ws-active',
      governed: true,
      verdict: { allow: true, trace: [] },
      explanation: 'Allowed',
      revision: 'org@v1',
    });
    const out = await call(explainRoute, { request: { tools: [' capability:bash '] } });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, op: 'explain', explanation: 'Allowed' });
    expect(explainGovernancePolicy).toHaveBeenCalledWith('ws-active', { tools: ['capability:bash'] });
  });

  it('explain honours an explicit workspaceId and refuses an unknown category with 400', async () => {
    vi.mocked(explainGovernancePolicy).mockResolvedValue({
      workspaceId: 'ws-b',
      governed: false,
      verdict: { allow: true, trace: [] },
      explanation: 'ungoverned',
      revision: null,
    });
    await call(explainRoute, { workspaceId: 'ws-b', request: { tools: ['x'] } });
    expect(explainGovernancePolicy).toHaveBeenCalledWith('ws-b', { tools: ['x'] });
    const bad = await call(explainRoute, { request: { shells: ['bash'] } });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('simulate names the first bad request and never runs the simulation', async () => {
    const out = await call(simulateRoute, { proposed: LAYER, requests: [{ tools: ['a'] }, { tools: [] }] });
    expect(out.status).toBe(400);
    expect(String(out.body.error)).toContain('requests[1]');
    expect(simulateGovernancePolicy).not.toHaveBeenCalled();
  });

  it('set forwards the layer, reason and expectedVersion with the admin actor', async () => {
    vi.mocked(setGovernancePolicyLayer).mockResolvedValue({ ok: true, layer: {} as never, revision: 'ws-a@v2' });
    const out = await call(setRoute, { ...LAYER, reason: 'lock plans', expectedVersion: 1 });
    expect(out).toMatchObject({ status: 200, body: { ok: true, op: 'set', revision: 'ws-a@v2' } });
    expect(setGovernancePolicyLayer).toHaveBeenCalledWith(
      { ...LAYER, reason: 'lock plans', expectedVersion: 1 },
      'admin:tester',
    );
  });

  it('maps write refusals to status codes, so the pane never shows a false success', async () => {
    for (const [code, status] of [['invalid', 400], ['parent', 400], ['conflict', 409], ['unavailable', 503], ['approval-required', 403], ['forbidden', 403]] as const) {
      vi.mocked(setGovernancePolicyLayer).mockResolvedValueOnce(code === 'forbidden'
        ? { ok: false, code, error: code, refusal: FORBIDDEN_REFUSAL }
        : { ok: false, code, error: code });
      const out = await call(setRoute, { ...LAYER, reason: 'r' }, null);
      expect(out).toMatchObject({ status, body: { ok: false, code } });
      if (code === 'forbidden') expect(out.body).toMatchObject({ refusal: FORBIDDEN_REFUSAL });
    }
    expect(vi.mocked(setGovernancePolicyLayer).mock.calls[0]?.[1]).toBe('admin:operator');
  });

  it('add-exception forwards the exception and actor', async () => {
    vi.mocked(addGovernancePolicyException).mockResolvedValue({ ok: true, layer: {} as never, revision: 'org@v2' });
    const exception = { category: 'tools', pattern: 'capability:bash', reason: 'incident', expiresAt: '2026-10-20T00:00:00Z' };
    const out = await call(addExceptionRoute, { layerId: 'org', exception, reason: 'incident', expectedVersion: 1 });
    expect(out).toMatchObject({ status: 200, body: { ok: true, op: 'add-exception' } });
    expect(addGovernancePolicyException).toHaveBeenCalledWith(
      { layerId: 'org', exception, reason: 'incident', expectedVersion: 1 },
      'admin:tester',
    );
  });
});

describe('/api/governance-policy/* — sensitive-change doors (P-006, D-015)', () => {
  const DEPT = { layerId: 'dept-a', level: 'department', scopeRef: 'eng', parentLayerId: 'org', rules: { tools: { deny: ['x'] } } };

  it('prepare parses its simulation requests and records the admin as preparer', async () => {
    vi.mocked(prepareGovernancePolicyChange).mockResolvedValue({ ok: true, request: { requestId: 'sar-1' } as never });
    const out = await call(prepareRoute, { ...DEPT, workspaceId: 'ws-a', reason: 'tighten', requests: [{ tools: [' x '] }], requiredApprovals: 2 });
    expect(out).toMatchObject({ status: 200, body: { ok: true, op: 'prepare', request: { requestId: 'sar-1' } } });
    expect(prepareGovernancePolicyChange).toHaveBeenCalledWith(
      { ...DEPT, workspaceId: 'ws-a', reason: 'tighten', expectedVersion: undefined, requests: [{ tools: ['x'] }], requiredApprovals: 2 },
      'admin:tester',
    );
  });

  it('prepare refuses a bad simulation request with 400 and prepares nothing', async () => {
    const out = await call(prepareRoute, { ...DEPT, workspaceId: 'ws-a', reason: 'r', requests: [{ tools: [] }] });
    expect(out.status).toBe(400);
    expect(String(out.body.error)).toContain('requests[0]');
    expect(prepareGovernancePolicyChange).not.toHaveBeenCalled();
  });

  it('decide, apply, delegate and revoke-delegation forward their input with the admin actor', async () => {
    vi.mocked(decideGovernancePolicyChange).mockResolvedValue({ ok: true, request: {} as never });
    vi.mocked(applyGovernancePolicyChange).mockResolvedValue({ ok: true, request: {} as never, layer: { layerId: 'dept-a', version: 2 }, revision: 'dept-a@v2' });
    vi.mocked(delegateGovernanceAuthority).mockResolvedValue({ ok: true, delegation: {} as never });
    vi.mocked(revokeGovernanceAuthority).mockResolvedValue({ ok: true, delegation: {} as never });
    const decision = { requestId: 'sar-1', decision: 'approve', reason: 'ok' };
    const grant = { principal: 'user:bo', layerId: 'dept-a', capabilities: ['prepare'], reason: 'r', expiresAt: '2026-10-20T00:00:00Z' };
    expect((await call(decideRoute, decision)).body).toMatchObject({ ok: true, op: 'decide' });
    expect((await call(applyRoute, { requestId: 'sar-1' })).body).toMatchObject({ ok: true, op: 'apply', revision: 'dept-a@v2' });
    expect((await call(delegateRoute, grant)).body).toMatchObject({ ok: true, op: 'delegate' });
    expect((await call(revokeRoute, { delegationId: 'd-1', reason: 'left' })).body).toMatchObject({ ok: true, op: 'revoke-delegation' });
    expect(decideGovernancePolicyChange).toHaveBeenCalledWith(decision, 'admin:tester');
    expect(applyGovernancePolicyChange).toHaveBeenCalledWith({ requestId: 'sar-1' }, 'admin:tester');
    expect(delegateGovernanceAuthority).toHaveBeenCalledWith(grant, 'admin:tester');
    expect(revokeGovernanceAuthority).toHaveBeenCalledWith({ delegationId: 'd-1', reason: 'left' }, 'admin:tester');
  });

  it('maps every sensitive-change refusal to a status, so the pane never shows a false success', async () => {
    const expected: Record<SensitiveActionErrorCode, number> = {
      invalid: 400,
      'not-found': 404,
      forbidden: 403,
      'self-approval': 403,
      'already-decided': 409,
      'not-pending': 409,
      'not-approved': 409,
      expired: 409,
      replayed: 409,
      'payload-mismatch': 409,
      stale: 409,
    };
    for (const [code, status] of Object.entries(expected) as [SensitiveActionErrorCode, number][]) {
      expect(GOVERNANCE_POLICY_CHANGE_STATUS[code]).toBe(status);
      vi.mocked(applyGovernancePolicyChange).mockResolvedValueOnce(code === 'forbidden'
        ? { ok: false, code, error: code, refusal: FORBIDDEN_REFUSAL }
        : { ok: false, code, error: code });
      const out = await call(applyRoute, { requestId: 'sar-1' });
      expect(out).toMatchObject({ status, body: { ok: false, op: 'apply', code } });
      if (code === 'forbidden') expect(out.body).toMatchObject({ refusal: FORBIDDEN_REFUSAL });
    }
    vi.mocked(decideGovernancePolicyChange).mockResolvedValueOnce({ ok: false, code: 'self-approval', error: 'no' });
    expect((await call(decideRoute, { requestId: 'sar-1', decision: 'approve', reason: 'r' })).status).toBe(403);
  });

  it('authority reads delegations and open requests, unfiltered unless asked', async () => {
    vi.mocked(readGovernanceAuthority).mockResolvedValue({ delegations: [], requests: [] });
    const out = await call(authorityRoute, {});
    expect(out).toMatchObject({ status: 200, body: { ok: true, op: 'authority', delegations: [], requests: [] } });
    expect(readGovernanceAuthority).toHaveBeenCalledWith({});
  });
});
