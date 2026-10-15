import { describe, expect, it } from 'vitest';
import {
  validateDirectoryBinding,
  activeSupportAccessBanner,
  assertGovernancePayloadSafe,
  normalizeHostedLocale,
  normalizeHostedTimeZone,
  supportAccessState,
  validateSupportAccessGrant,
} from './governance';

const NOW = new Date('2026-08-23T12:00:00.000Z');

describe('hosted governance core', () => {
  it('normalizes explicit immutable directory references and bounds group mappings', () => {
    const input = { organizationId: 'org', userId: 'user', externalOrganizationId: 'workos-org',
      directoryId: 'dir', directoryUserId: 'dsync-user', authorizedGroupIds: [' b ', 'a', 'b'], purpose: 'Directory setup' };
    expect(validateDirectoryBinding(input).authorizedGroupIds).toEqual(['a', 'b']);
    for (const field of ['directoryId', 'directoryUserId', 'externalOrganizationId', 'purpose'] as const) {
      expect(() => validateDirectoryBinding({ ...input, [field]: '' })).toThrow(/directory_binding_invalid/);
    }
    expect(() => validateDirectoryBinding({ ...input, authorizedGroupIds: Array(101).fill('a') })).toThrow(/authorizedGroupIds/);
    expect(() => validateDirectoryBinding({ ...input, purpose: 'Bearer abcdefghijklmnopqrstuvwxyz' })).toThrow(/credential-like/);
  });
  it('rejects secret-bearing keys and values at any payload depth', () => {
    expect(() => assertGovernancePayloadSafe({ nested: { refresh_token: 'redacted' } }))
      .toThrow(/forbidden governance field/);
    expect(() => assertGovernancePayloadSafe({ headers: ['Bearer abcdefghijklmnopqrstuvwxyz'] }))
      .toThrow(/credential-like material/);
    expect(() => assertGovernancePayloadSafe({ channel: 'email', digest: { enabled: true } }))
      .not.toThrow();
  });

  // P-007b (plan papercusp-enterprise-readiness-roadmap-2026-10-09, R-4 data clause): a secret
  // canary inside organization audit metadata never reaches the audit log path. It is refused at
  // every depth, and the refusal names only the PATH, never the secret, so logging the error
  // cannot leak the canary either. The canary shapes are assembled at runtime from fragments so
  // this file never holds a literal credential-shaped token (the tree secrets guard scans it).
  it('P-007b canary: refuses a secret canary in organization audit metadata without echoing it', () => {
    const suffix = 'CANARYP007B0123456789abcdef';
    const pem = ['-----', 'BEGIN', ' RSA ', 'PRIVATE', ' KEY', '-----'].join('');
    const canaries = [
      ['s', 'k', '-'].join('') + suffix,
      ['g', 'h', 'p', '_'].join('') + suffix,
      ['Bea', 'rer '].join('') + suffix,
      `${pem}\n${suffix}`,
    ];
    for (const secret of canaries) {
      const audit = {
        action: 'data-source.permission.revoked',
        organizationId: 'org-p007b',
        metadata: { source: 'slack', sourceRef: 'T1:CRESTRICTED', notes: [{ text: `rotated ${secret}` }] },
      };
      let refusal: unknown;
      try {
        assertGovernancePayloadSafe(audit);
      } catch (err) {
        refusal = err;
      }
      expect(refusal, secret.slice(0, 4)).toBeInstanceOf(Error);
      expect((refusal as Error).message).toMatch(/payload\.metadata\.notes\[0\]\.text contains credential-like material/);
      expect((refusal as Error).message).not.toContain(suffix);
    }
  });

  it('P-007b canary: permits organization audit metadata that carries only non-secret references', () => {
    expect(() => assertGovernancePayloadSafe({
      action: 'data-source.permission.revoked',
      organizationId: 'org-p007b',
      metadata: { source: 'slack', sourceRef: 'T1:CRESTRICTED', removedMembers: 1, revokedBy: 'owner' },
    })).not.toThrow();
  });

  it('normalizes locale/timezone preferences and rejects invalid values', () => {
    expect(normalizeHostedLocale('en_US')).toBe('en-US');
    expect(normalizeHostedTimeZone('America/New_York')).toBe('America/New_York');
    expect(() => normalizeHostedLocale('not a locale')).toThrow(/invalid locale/);
    expect(() => normalizeHostedTimeZone('Moon/Sea_of_Tranquility')).toThrow(/invalid timeZone/);
  });

  it('requires bounded, purpose-scoped, non-wildcard support access', () => {
    const input = {
      organizationId: '11111111-1111-4111-8111-111111111111',
      staffPrincipalId: 'staff:case-42',
      grantedByUserId: '22222222-2222-4222-8222-222222222222',
      purpose: 'Diagnose workspace boot failure',
      scopes: ['workspace:read', 'logs:read', 'logs:read'],
      bannerMessage: 'Papercusp support has temporary access for case 42.',
      startsAt: new Date('2026-08-23T11:00:00.000Z'),
      expiresAt: new Date('2026-08-23T13:00:00.000Z'),
    };

    expect(validateSupportAccessGrant(input).scopes).toEqual(['workspace:read', 'logs:read']);
    expect(() => validateSupportAccessGrant({ ...input, scopes: ['*'] })).toThrow(/wildcard/);
    expect(() => validateSupportAccessGrant({ ...input, expiresAt: input.startsAt })).toThrow(/expire after/);
  });

  it('derives banner visibility from the grant window and revocation', () => {
    const grant = {
      startsAt: new Date('2026-08-23T11:00:00.000Z'),
      expiresAt: new Date('2026-08-23T13:00:00.000Z'),
      bannerMessage: 'Support access is active.',
    };

    expect(supportAccessState(grant, new Date('2026-08-23T10:59:59.000Z'))).toBe('pending');
    expect(supportAccessState(grant, NOW)).toBe('active');
    expect(activeSupportAccessBanner(grant, NOW)).toBe('Support access is active.');
    expect(supportAccessState(grant, grant.expiresAt)).toBe('expired');
    expect(activeSupportAccessBanner({ ...grant, revokedAt: NOW }, NOW)).toBeNull();
  });
});
