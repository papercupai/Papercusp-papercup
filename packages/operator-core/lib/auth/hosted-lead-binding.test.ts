import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { HostedLeadBindingChallengeCodec, MAX_LEAD_BINDING_CHALLENGE_MS } from './hosted-lead-binding';

const secret = 'a'.repeat(32);
const codec = new HostedLeadBindingChallengeCodec(secret);
const scope = { graphWorkspaceId: 'workspace-a', personRef: 'PER-a', environment: 'production' as const };
const claim = { ...scope, challengeId: '12345678-1234-4234-8234-123456789abc', issuerRef: 'operator-a',
  issuedAt: 1000, expiresAt: 1000 + MAX_LEAD_BINDING_CHALLENGE_MS };
const token = codec.encode(claim);

describe('hosted lead binding challenge', () => {
  it('authenticates the exact workspace, person and environment at the half-open validity interval', () => {
    expect(codec.decode(token, scope, claim.issuedAt)).toEqual(claim);
    expect(codec.decode(token, scope, claim.expiresAt - 1)).toEqual(claim);
    expect(codec.decode(token, scope, claim.expiresAt)).toBeNull();
    expect(codec.decode(token, scope, claim.issuedAt - 1)).toBeNull();
  });
  it.each([
    { ...scope, graphWorkspaceId: 'other-workspace' },
    { ...scope, personRef: 'PER-other' },
    { ...scope, environment: 'staging' as const },
  ])('refuses an unexpected binding scope %j', expected => {
    expect(codec.decode(token, expected, 2000)).toBeNull();
  });
  it('refuses tampering, a different secret and session-cookie protocol reuse', () => {
    const [purpose, payload, signature] = token.split('.');
    const altered = Buffer.from(JSON.stringify({ ...claim, personRef: 'PER-other' })).toString('base64url');
    expect(codec.decode(`${purpose}.${altered}.${signature}`, scope, 2000)).toBeNull();
    expect(codec.decode(`v1.${payload}.${signature}`, scope, 2000)).toBeNull();
    expect(new HostedLeadBindingChallengeCodec('b'.repeat(32)).decode(token, scope, 2000)).toBeNull();
  });
  it('rejects unknown fields even in an otherwise valid signed payload', () => {
    const payload = Buffer.from(JSON.stringify({ ...claim, consent: true })).toString('base64url');
    const signed = `hosted-lead-binding-v1.${payload}`;
    const signedToken = `${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`;
    expect(codec.decode(signedToken, scope, 2000)).toBeNull();
  });
  it.each([null, '', 'invalid', 'x'.repeat(4097), token + '=', token + '.extra'])('fails closed on malformed token %j', value => {
    expect(codec.decode(value, scope, 2000)).toBeNull();
  });
  it('refuses broad, unbounded, empty and reversed claims before signing', () => {
    for (const patch of [
      { graphWorkspaceId: '*' }, { personRef: 'ada@example.com' }, { issuerRef: '' },
      { expiresAt: claim.issuedAt }, { expiresAt: claim.expiresAt + 1 },
    ]) expect(() => codec.encode({ ...claim, ...patch })).toThrow();
    expect(() => new HostedLeadBindingChallengeCodec('short')).toThrow('lead_binding_secret_invalid');
    expect(codec.decode(token, scope, NaN)).toBeNull();
  });
});
