import { describe, expect, it } from 'vitest';
import { DEFAULT_DELEGATED_SEAT_POLICY, evaluateDelegatedSeatPolicy, loadDelegatedSeatPolicy } from './delegated-seat-policy';

const base = {
  policy: DEFAULT_DELEGATED_SEAT_POLICY,
  workspaceId: 'ws-1',
  credentialRoute: 'default' as const,
  requestedSeats: 1,
  activeSeats: 0,
  requestedAtMs: 1_000,
  nowMs: 2_000,
};

describe('delegated seat policy (P-516/F5)', () => {
  it('labels the default path as trusted host-agent delegation and exposes stop/spend semantics', () => {
    const result = evaluateDelegatedSeatPolicy(base);
    expect(result).toEqual({
      ok: true,
      audit: {
        trustLabel: 'trusted-host-agent-delegation',
        sandbox: 'host-agent-envelope',
        spendVisibility: 'unmetered-v1',
        stopControl: 'resource:delegate remove + fleet stop',
      },
    });
  });

  it('refuses an untrusted public mode instead of pretending the host envelope is a sandbox', () => {
    const result = evaluateDelegatedSeatPolicy({ ...base, policy: { ...DEFAULT_DELEGATED_SEAT_POLICY, trustMode: 'untrusted-public' } });
    expect(result).toMatchObject({ ok: false, code: 'untrusted_public_requires_os_sandbox' });
  });

  it('enforces workspace, credential, concurrency, duration, and spend ceilings', () => {
    const policy = { ...DEFAULT_DELEGATED_SEAT_POLICY, allowedWorkspaceIds: ['allowed'], allowedCredentialRoutes: ['pinned'] as const, maxConcurrentSeats: 2, maxDurationMs: 100, maxSpendMicros: 5 };
    expect(evaluateDelegatedSeatPolicy({ ...base, policy, workspaceId: 'ws-1' })).toMatchObject({ code: 'workspace_not_allowed' });
    expect(evaluateDelegatedSeatPolicy({ ...base, policy, workspaceId: 'allowed', credentialRoute: 'default' })).toMatchObject({ code: 'credential_route_not_allowed' });
    expect(evaluateDelegatedSeatPolicy({ ...base, policy, workspaceId: 'allowed', credentialRoute: 'pinned', activeSeats: 2 })).toMatchObject({ code: 'delegated_concurrency_cap' });
    expect(evaluateDelegatedSeatPolicy({ ...base, policy, workspaceId: 'allowed', credentialRoute: 'pinned', nowMs: 2_000 })).toMatchObject({ code: 'delegated_duration_cap' });
    expect(evaluateDelegatedSeatPolicy({ ...base, policy, workspaceId: 'allowed', credentialRoute: 'pinned', requestedAtMs: 2_000, nowMs: 2_050 })).toMatchObject({ code: 'spend_estimate_unavailable' });
    expect(evaluateDelegatedSeatPolicy({ ...base, policy, workspaceId: 'allowed', credentialRoute: 'pinned', requestedAtMs: 2_000, nowMs: 2_050, estimatedSpendMicros: 6 })).toMatchObject({ code: 'delegated_spend_cap' });
  });

  // WI-10005197: an allowlist refusal must say what would lift it. A refusal that
  // names only the state ("is outside the allowlist") leaves the requester guessing
  // whether to retry, re-send, or ask a host operator to edit PAPERCUSP_DELEGATED_SEAT_POLICY.
  describe('allowlist refusals carry a lift contract (WI-10005197)', () => {
    const refusalOf = (result: ReturnType<typeof evaluateDelegatedSeatPolicy>) => {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable: asserted ok:false above');
      return result.refusal;
    };

    it('workspace_not_allowed names the host lever and what was compared', () => {
      const policy = { ...DEFAULT_DELEGATED_SEAT_POLICY, allowedWorkspaceIds: ['allowed-a', 'allowed-b'] };
      const refusal = refusalOf(evaluateDelegatedSeatPolicy({ ...base, policy, workspaceId: 'ws-1' }));
      expect(refusal?.observed).toEqual({ workspaceId: 'ws-1', allowlistSize: '2' });
      expect(refusal?.liftsWhen).toMatch(/allowedWorkspaceIds/);
      expect(refusal?.liftsWhen).toMatch(/PAPERCUSP_DELEGATED_SEAT_POLICY/);
      expect(refusal?.whoCanMakeItTrue).toEqual(['host', 'owner']);
    });

    it('repo_not_allowed names the host lever and the offending repo', () => {
      const policy = { ...DEFAULT_DELEGATED_SEAT_POLICY, allowedRepoIds: ['repo-ok'] };
      const refusal = refusalOf(evaluateDelegatedSeatPolicy({ ...base, policy, repoId: 'repo-x' }));
      expect(refusal?.observed).toEqual({ repoId: 'repo-x', allowlistSize: '1' });
      expect(refusal?.liftsWhen).toMatch(/allowedRepoIds/);
      expect(refusal?.whoCanMakeItTrue).toEqual(['host', 'owner']);
    });

    it('tools_not_allowed distinguishes an undeclared tool set from a declared-but-outside one', () => {
      const policy = { ...DEFAULT_DELEGATED_SEAT_POLICY, allowedTools: ['read', 'write'] };
      const undeclared = refusalOf(evaluateDelegatedSeatPolicy({ ...base, policy, requestedTools: null }));
      expect(undeclared?.observed).toEqual({ requestedTools: null, toolsOutsideAllowlist: null, allowlistSize: '2' });
      const outside = refusalOf(evaluateDelegatedSeatPolicy({ ...base, policy, requestedTools: ['read', 'shell', 'net'] }));
      expect(outside?.observed).toEqual({ requestedTools: '3', toolsOutsideAllowlist: 'shell,net', allowlistSize: '2' });
      // A requester can fix this on its own side by re-sending an explicit subset.
      expect(outside?.whoCanMakeItTrue).toContain('another-agent');
      expect(outside?.liftsWhen).toMatch(/requestedTools/);
    });

    it('credential_route_not_allowed lists the routes the host does allow', () => {
      const policy = { ...DEFAULT_DELEGATED_SEAT_POLICY, allowedCredentialRoutes: ['pinned', 'auto'] as const };
      const refusal = refusalOf(evaluateDelegatedSeatPolicy({ ...base, policy, credentialRoute: 'default' }));
      expect(refusal?.observed).toEqual({ credentialRoute: 'default', allowedRoutes: 'pinned,auto' });
      expect(refusal?.liftsWhen).toMatch(/allowedCredentialRoutes/);
      expect(refusal?.whoCanMakeItTrue).toContain('host');
    });

    it('does NOT attach a host-lever contract to request-side caps (nothing a host edit lifts)', () => {
      const policy = { ...DEFAULT_DELEGATED_SEAT_POLICY, maxConcurrentSeats: 2 };
      const capped = evaluateDelegatedSeatPolicy({ ...base, policy, activeSeats: 2 });
      expect(capped).toMatchObject({ ok: false, code: 'delegated_concurrency_cap' });
      expect((capped as { refusal?: unknown }).refusal).toBeUndefined();
    });
  });

  it('fails closed on malformed host policy overrides', () => {
    expect(loadDelegatedSeatPolicy({ PAPERCUSP_DELEGATED_SEAT_POLICY: '{"maxConcurrentSeats":0}' })).toMatchObject({ ok: false, code: 'delegated_seat_policy_invalid' });
    expect(loadDelegatedSeatPolicy({})).toEqual({ ok: true, policy: DEFAULT_DELEGATED_SEAT_POLICY });
  });
});
