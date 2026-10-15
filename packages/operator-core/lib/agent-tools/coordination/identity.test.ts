/**
 * Unit tests for resolveAgentIdentity — the coordination identity primitive (L1).
 *
 * THE UMBILICAL (voice-gap fix): the `fleet-spawn` branch is the load-bearing case
 * here. A cup:spawn bee connects over a SIGNED MCP URL — NOT superuser, NOT
 * power-user, NO bearer principal — carrying its operator-assigned `s-…` spawnId as
 * the `client=` param (→ ctx.uiClientId). Before that branch existed the resolver
 * threw "cannot be attributed" and every coord:send / plans:set-status /
 * improvements:capture from a bee failed (the "MUTE bee"): file edits landed, but
 * the child could not speak on coord. These tests pin that the bee now resolves a
 * stable coord owner, AND that a truly unattributable ctx still hard-errors.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveAgentIdentity,
  SUPERUSER_FALLBACK_CLIENT_ID,
  isEphemeralMcpCallIdentity,
  isTransportOnlyIdentity,
} from './identity';

describe('resolveAgentIdentity — cup:spawn child (THE UMBILICAL)', () => {
  it('attributes a role-gated signed spawn ctx to its `s-…` client id (was: threw → MUTE bee)', () => {
    // The shape the MCP handler builds for a cup:spawn bee: a VERIFIED signed
    // spawn ctx (sigVerifiedSpawn = the HMAC checked, covering the client=
    // param), no superuser/power-user/principal, `client=s-…` → uiClientId.
    const id = resolveAgentIdentity({
      uiClientId: 's-1780000000000-deadbeef',
      sigVerifiedSpawn: true,
      isSuperuser: false,
      isPowerUser: false,
      workspaceId: 'ws-1',
    });
    expect(id.ownerId).toBe('s-1780000000000-deadbeef');
    expect(id.source).toBe('fleet-spawn');
    expect(id.workspaceId).toBe('ws-1');
    expect(id.ownerLabel).toMatch(/^bee · /);
  });

  it('EI-318: a bare UNVERIFIED client= (the public HTTP catch-all) is NOT an identity — it hard-errors', () => {
    // The exact forge vector: a loopback `curl /api/agent-tools/...?client=<id>`
    // reaches the resolver with uiClientId set but sigVerifiedSpawn unset (the
    // HTTP catch-all never verifies the spawn HMAC). Trusting it let a degraded
    // bee attribute claims to its run-id (EI-311). Now it is rejected, so the
    // write fails loud instead of impersonating an agent.
    expect(() =>
      resolveAgentIdentity({ uiClientId: 'opspawn-1781159617676-c9a28a', workspaceId: 'ws-1' }),
    ).toThrow(/cannot be attributed/);
    // Explicit false is rejected the same as absent.
    expect(() =>
      resolveAgentIdentity({ uiClientId: 's-forged', sigVerifiedSpawn: false }),
    ).toThrow(/cannot be attributed/);
  });

  it('a superuser ctx still wins over the fleet-spawn fallback', () => {
    const id = resolveAgentIdentity({
      isSuperuser: true,
      uiClientId: 'su-abc123',
      workspaceId: 'ws-1',
    });
    expect(id.ownerId).toBe('su-abc123');
    expect(id.source).toBe('omp-hook-session');
  });

  it('a principal-gated caller still wins over the fleet-spawn fallback', () => {
    const id = resolveAgentIdentity({
      principal: { kind: 'system', slug: 'autoloop', workspaceId: 'ws-2' },
    });
    expect(id.ownerId).toBe('autoloop');
    expect(id.source).toBe('principal');
  });

  it('keeps a trusted spawn role principal on its accepted session owner', () => {
    const ownerId = 'su-2342c61e-5b1d-4f29-9016-d0692cc241ae';
    const principal = { kind: 'harness', slug: 'system:researcher', workspaceId: 'ws-1',
      authMethod: 'spawn-url', trust: 'trusted' };
    const id = resolveAgentIdentity({ principal, uiClientId: ownerId, sigVerifiedSpawn: true });
    // The applied adv-session receipt, claim and coord sender must share one id.
    expect(id.ownerId).toBe(ownerId);
    expect(id.workspaceId).toBe('ws-1');
    expect(id.source).toBe('principal');
    expect(principal).toEqual({ kind: 'harness', slug: 'system:researcher', workspaceId: 'ws-1',
      authMethod: 'spawn-url', trust: 'trusted' });
  });

  it.each([
    { authMethod: 'bearer', trust: 'trusted' },
    { authMethod: 'spawn-url', trust: 'untrusted' },
  ])('does not adopt an unverified bearer client (%s)', (proof) => {
    const ownerId = 'su-2342c61e-5b1d-4f29-9016-d0692cc241ae';
    const id = resolveAgentIdentity({ uiClientId: ownerId,
      principal: { kind: 'harness', slug: 'system:researcher', workspaceId: 'ws-1', ...proof } });
    expect(id.ownerId).toBe(`system:researcher/${ownerId}`);
    expect(id.source).toBe('principal');
  });

  it('still hard-errors when the ctx carries NO attributable identity at all', () => {
    expect(() => resolveAgentIdentity({})).toThrow(/cannot be attributed/);
    // An empty-string client is not an identity either.
    expect(() => resolveAgentIdentity({ uiClientId: '' })).toThrow(/cannot be attributed/);
  });
});

describe('resolveAgentIdentity — event-reaction principals', () => {
  it('keeps a first-party reaction attributable to its trigger agent', () => {
    const id = resolveAgentIdentity({
      uiClientId: 'agent-1',
      reactionCause: {},
      principal: { kind: 'system', slug: 'system:event-reaction', workspaceId: 'ws-1' },
    });
    expect(id.ownerId).toBe('agent-1');
    expect(id.source).toBe('event-reaction');
    expect(id.workspaceId).toBe('ws-1');
  });

  it('classifies a capability-scoped reaction principal the same way', () => {
    const id = resolveAgentIdentity({
      uiClientId: 'agent-1',
      reactionCause: {},
      principal: {
        kind: 'system',
        slug: 'plugin:event-reaction:plugin:foo:emit',
        workspaceId: 'ws-1',
      },
    });
    expect(id.ownerId).toBe('agent-1');
    expect(id.source).toBe('event-reaction');
  });

  it('does not broaden the ordinary principal exemption', () => {
    const id = resolveAgentIdentity({
      uiClientId: 'agent-1',
      principal: { kind: 'system', slug: 'system:autoloop', workspaceId: 'ws-1' },
    });
    expect(id.source).toBe('principal');
  });

  it('does not trust a reaction-named bearer without an internal reaction cause', () => {
    const id = resolveAgentIdentity({
      uiClientId: 'agent-1',
      principal: { kind: 'system', slug: 'system:event-reaction', workspaceId: 'ws-1' },
    });
    expect(id.ownerId).toBe('system:event-reaction/agent-1');
    expect(id.source).toBe('principal');
  });
});

describe('resolveAgentIdentity — verified signed spawn without client= (invoke-route agents, D-002 option c)', () => {
  it('attributes a VERIFIED signed spawn with no client= to the stable harness slug', () => {
    // The shape the MCP handler builds for an invoke-route agent (promote/
    // scoper/expert): sig verified, harness present, NO client= → no uiClientId.
    const id = resolveAgentIdentity({
      sigVerifiedSpawn: true,
      harnessSlug: 'restart',
      workspaceId: 'ws-1',
    });
    expect(id.ownerId).toBe('harness:restart');
    expect(id.ownerLabel).toBe('harness · restart');
    expect(id.source).toBe('signed-spawn');
    expect(id.workspaceId).toBe('ws-1');
    expect(id.userId).toBeNull();
  });

  it('grants NOTHING to an unverified spawn ctx — unsigned soft-allow still hard-errors', () => {
    expect(() =>
      resolveAgentIdentity({ harnessSlug: 'restart', workspaceId: 'ws-1' }),
    ).toThrow(/cannot be attributed/);
    expect(() =>
      resolveAgentIdentity({ sigVerifiedSpawn: false, harnessSlug: 'restart' }),
    ).toThrow(/cannot be attributed/);
  });

  it('never mints an identity for the unscoped `*` harness session', () => {
    expect(() =>
      resolveAgentIdentity({ sigVerifiedSpawn: true, harnessSlug: '*' }),
    ).toThrow(/cannot be attributed/);
  });

  it('a client=-carrying cup:spawn child still wins over the harness attribution', () => {
    const id = resolveAgentIdentity({
      uiClientId: 's-1780000000000-deadbeef',
      sigVerifiedSpawn: true,
      harnessSlug: 'papercup',
    });
    expect(id.ownerId).toBe('s-1780000000000-deadbeef');
    expect(id.source).toBe('fleet-spawn');
  });

  it('EI-2127: an admitted superuser with NO uiClientId resolves the stable fallback id (was: threw → db:next-migration / coord:whoami / coord:send all failed)', () => {
    // The client-less superuser ctx the loopback HTTP bridge / in-process
    // superuser MCP call builds: isSuperuser true (admission already cleared the
    // loopback + bearer gate), but no Mcp-Session-Id and no ?client= → no
    // uiClientId. This used to throw "superuser context is missing uiClientId",
    // which deterministically broke every identity-resolving tool.
    const id = resolveAgentIdentity({ isSuperuser: true, workspaceId: 'ws-1' });
    expect(id.ownerId).toBe(SUPERUSER_FALLBACK_CLIENT_ID);
    expect(id.source).toBe('omp-hook-session');
    expect(id.workspaceId).toBe('ws-1');
    expect(id.ownerLabel).toMatch(/^su · /);
  });

  it('EI-2127: an explicit superuser uiClientId still wins over the fallback', () => {
    // The fallback is the no-client case ONLY — a real per-session id always wins.
    const id = resolveAgentIdentity({ isSuperuser: true, uiClientId: 'su-abc123' });
    expect(id.ownerId).toBe('su-abc123');
    expect(id.ownerId).not.toBe(SUPERUSER_FALLBACK_CLIENT_ID);
    expect(id.source).toBe('omp-hook-session');
  });

  it('su / power / principal branches are unchanged by the new fields (no escalation)', () => {
    const su = resolveAgentIdentity({
      isSuperuser: true,
      uiClientId: 'su-x',
      sigVerifiedSpawn: true,
      harnessSlug: 'papercup',
    });
    expect(su.source).toBe('omp-hook-session');
    expect(su.ownerId).toBe('su-x');
    const pr = resolveAgentIdentity({
      principal: { kind: 'system', slug: 'autoloop', workspaceId: 'w' },
      sigVerifiedSpawn: true,
      harnessSlug: 'papercup',
    });
    expect(pr.source).toBe('principal');
    expect(pr.ownerId).toBe('autoloop');
  });
});

// EI-8509: scripts/mcp-call.mjs mints `mcp-call-${process.pid}` when the caller
// passes no --client of its own — a one-shot process with no liveness behind it.
// It resolves through the ordinary superuser branch (indistinguishable in shape
// from a real su session), so isEphemeralMcpCallIdentity is the only signal.
describe('isEphemeralMcpCallIdentity (EI-8509)', () => {
  it('flags the exact auto-generated mcp-call.mjs shape', () => {
    expect(isEphemeralMcpCallIdentity('mcp-call-12345')).toBe(true);
    expect(isEphemeralMcpCallIdentity('mcp-call-1')).toBe(true);
  });

  it('does NOT flag a real su/spawn identity, an explicit --client, or the su-loopback fallback', () => {
    expect(isEphemeralMcpCallIdentity('su-abc123')).toBe(false);
    expect(isEphemeralMcpCallIdentity('s-1780000000000-deadbeef')).toBe(false);
    expect(isEphemeralMcpCallIdentity(SUPERUSER_FALLBACK_CLIENT_ID)).toBe(false);
    expect(isEphemeralMcpCallIdentity('mcp-call-su-1234')).toBe(false); // a real --client value someone chose
    expect(isEphemeralMcpCallIdentity('mcp-call-')).toBe(false);
  });

  it('handles null/undefined/empty without throwing', () => {
    expect(isEphemeralMcpCallIdentity(null)).toBe(false);
    expect(isEphemeralMcpCallIdentity(undefined)).toBe(false);
    expect(isEphemeralMcpCallIdentity('')).toBe(false);
  });

  it('resolveAgentIdentity resolves the mcp-call.mjs default shape through the ordinary superuser branch', () => {
    // This is exactly what the transport sees when mcp-call.mjs is invoked with
    // no --client: ?superuser=1&client=mcp-call-<pid>.
    const id = resolveAgentIdentity({ isSuperuser: true, uiClientId: 'mcp-call-99887' });
    expect(id.ownerId).toBe('mcp-call-99887');
    expect(id.source).toBe('omp-hook-session');
    expect(isEphemeralMcpCallIdentity(id.ownerId)).toBe(true);
  });
});

describe('isTransportOnlyIdentity — terminal completion attribution', () => {
  it('flags the shared client-less fallback and mcp-call.mjs auto-generated identity', () => {
    expect(isTransportOnlyIdentity(SUPERUSER_FALLBACK_CLIENT_ID)).toBe(true);
    expect(isTransportOnlyIdentity('mcp-call-12345')).toBe(true);
  });

  it('does not flag a real per-session or spawn owner', () => {
    expect(isTransportOnlyIdentity('su-abc123')).toBe(false);
    expect(isTransportOnlyIdentity('s-1780000000000-deadbeef')).toBe(false);
    expect(isTransportOnlyIdentity(null)).toBe(false);
  });
});
