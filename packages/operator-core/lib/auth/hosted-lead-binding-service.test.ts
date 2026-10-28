import { describe, expect, it, vi } from 'vitest';
import { HostedLeadBindingService, type HostedLeadBindingAuthority } from './hosted-lead-binding-service';
import { HostedLeadBindingChallengeCodec, type HostedLeadBindingChallenge, type HostedLeadBindingScope } from './hosted-lead-binding';
import { createHostedPrincipal } from './hosted-principal';

const scope = { graphWorkspaceId: 'graph-a', personRef: 'PER-a', environment: 'production' as const };
const principal = createHostedPrincipal({ workspaceId: 'control', userId: 'user-a',
  activeOrganizationId: 'org-a', sessionId: 'session-a', sessionVersion: 1 });
function fixture() {
  let allowed = true;
  let now = 1000;
  const issuer = vi.fn((_scope: HostedLeadBindingScope, _issuer: string) => allowed);
  const subject = vi.fn((_scope: HostedLeadBindingScope) => allowed);
  const authority: HostedLeadBindingAuthority = {
    async withCurrentIssuer(scope, ref, operation) { return issuer(scope, ref) ? operation() : null; },
    async withCurrentSubject(scope, operation) { return subject(scope) ? operation() : null; },
  };
  const store = { issue: vi.fn(async (_claim: HostedLeadBindingChallenge) => {}), redeem: vi.fn(async () => null),
    read: vi.fn(async () => null), revoke: vi.fn(async () => true) };
  const service = new HostedLeadBindingService(new HostedLeadBindingChallengeCodec('x'.repeat(32)),
    store, authority, 'production', () => now, () => '12345678-1234-4234-8234-123456789abc');
  return { service, store, issuer, subject, deny: () => { allowed = false; }, expire: () => { now += 900000; } };
}
describe('hosted binding host orchestration', () => {
  it('persists before returning a signed token and redeems only its verified claim', async () => {
    const f = fixture(); const token = await f.service.issue(scope, 'operator-a');
    expect(token).toBeTypeOf('string');
    await f.service.redeem(scope, token, principal);
    expect(f.store.redeem).toHaveBeenCalledWith(f.store.issue.mock.calls[0]?.[0], principal);
    expect(f.issuer).toHaveBeenLastCalledWith(scope, 'operator-a');
  });
  it('rechecks issuer/canonical authority after issue and denies storage access after revocation or merge', async () => {
    const f = fixture(); const token = await f.service.issue(scope, 'operator-a'); f.deny();
    expect(await f.service.redeem(scope, token, principal)).toBeNull();
    expect(await f.service.read(scope, principal)).toBeNull();
    expect(await f.service.revoke(scope, principal)).toBe(false);
    expect(f.store.redeem).not.toHaveBeenCalled(); expect(f.store.read).not.toHaveBeenCalled();
    expect(f.store.revoke).not.toHaveBeenCalled();
    expect(await f.service.issue(scope, 'operator-a')).toBeNull();
    expect(f.store.issue).toHaveBeenCalledTimes(1);
  });
  it('rejects altered, expired and cross-person tokens before consulting authority', async () => {
    const f = fixture(); const token = await f.service.issue(scope, 'operator-a'); f.issuer.mockClear();
    expect(await f.service.redeem(scope, token + 'x', principal)).toBeNull();
    expect(await f.service.redeem({ ...scope, personRef: 'PER-b' }, token, principal)).toBeNull();
    f.expire(); expect(await f.service.redeem(scope, token, principal)).toBeNull();
    expect(f.issuer).not.toHaveBeenCalled(); expect(f.store.redeem).not.toHaveBeenCalled();
  });
  it('never returns a usable token after persistence fails', async () => {
    const f = fixture(); f.store.issue.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(f.service.issue(scope, 'operator-a')).rejects.toThrow('database unavailable');
  });
  it('pins the deployment environment and refuses a non-hosted principal', async () => {
    const f = fixture();
    await expect(f.service.issue({ ...scope, environment: 'staging' }, 'operator-a')).rejects.toThrow('environment_mismatch');
    expect(await f.service.read(scope, { ...principal, profile: 'local' } as never)).toBeNull();
    expect(f.subject).not.toHaveBeenCalled();
  });
});
