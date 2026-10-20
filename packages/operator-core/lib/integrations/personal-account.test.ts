/**
 * Personal (consumer) provider accounts (provider-adapters-to-packages-2026-10-11 D-036; the
 * account rule is D-039 of the Google migration, owner directive #1822: a personal mail account
 * stays out of the relationship graph / CRM). The rule must fail CLOSED: an account the host
 * cannot prove is outside the declared personal domains counts as personal.
 */
import { describe, expect, it } from 'vitest';
import type { ProviderDescriptor } from '@papercusp/plugin-sdk';
import {
  canonicalSourceAccountId,
  isPersonalProviderAccount,
  isProvisionalProviderAccountId,
  type SourceAccountIdentity,
} from './personal-account';

const GOOGLE: Pick<ProviderDescriptor, 'oauth'> = {
  oauth: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    personalAccountDomains: ['gmail.com', 'googlemail.com'],
  },
};
const UNDECLARED: Pick<ProviderDescriptor, 'oauth'> = {
  oauth: { authorizeUrl: 'https://auth.example.test/a', tokenUrl: 'https://auth.example.test/t', scopes: ['read'] },
};

const source = (
  providerAccountId: string | null,
  cursor: Record<string, unknown> = {},
  config: Record<string, unknown> = {},
): SourceAccountIdentity => ({ providerAccountId, cursor, config });

describe('isProvisionalProviderAccountId', () => {
  it.each([
    [null, true],
    ['', true],
    ['   ', true],
    ['provider:google:owner-slot', true],
    ['legacy-owner:abc', true],
    ['owner@example.com', false],
    ['1234567890', false],
  ])('%j -> %s', (value, expected) => {
    expect(isProvisionalProviderAccountId(value)).toBe(expected);
  });
});

describe('isPersonalProviderAccount', () => {
  it('treats an address in a declared personal domain as personal, case-insensitively', () => {
    expect(isPersonalProviderAccount(GOOGLE, 'someone@gmail.com')).toBe(true);
    expect(isPersonalProviderAccount(GOOGLE, ' Someone@GoogleMail.COM ')).toBe(true);
  });

  it('treats a workspace (non-personal-domain) address as not personal', () => {
    expect(isPersonalProviderAccount(GOOGLE, 'super@papercusp.com')).toBe(false);
    // A subdomain is a different domain, not a personal one.
    expect(isPersonalProviderAccount(GOOGLE, 'a@mail.gmail.com.example')).toBe(false);
  });

  it('fails closed for a declared provider whose identity is unknown or provisional', () => {
    expect(isPersonalProviderAccount(GOOGLE, null)).toBe(true);
    expect(isPersonalProviderAccount(GOOGLE, '')).toBe(true);
    expect(isPersonalProviderAccount(GOOGLE, 'provider:google:owner-slot')).toBe(true);
    expect(isPersonalProviderAccount(GOOGLE, 'legacy-owner:x')).toBe(true);
  });

  it('is not personal when the identity is not an address at all', () => {
    expect(isPersonalProviderAccount(GOOGLE, 'calendar-id-without-at')).toBe(false);
    expect(isPersonalProviderAccount(GOOGLE, '@gmail.com')).toBe(false);
  });

  it('never applies to a provider that declares no personal domains', () => {
    expect(isPersonalProviderAccount(UNDECLARED, 'someone@gmail.com')).toBe(false);
    expect(isPersonalProviderAccount(UNDECLARED, null)).toBe(false);
    expect(isPersonalProviderAccount({}, 'someone@gmail.com')).toBe(false);
  });
});

describe('canonicalSourceAccountId', () => {
  it('returns a canonical account id unchanged', () => {
    expect(canonicalSourceAccountId(source('owner@example.com', { emailAddress: 'other@example.com' }))).toBe('owner@example.com');
  });

  it('returns null for a source with no account id', () => {
    expect(canonicalSourceAccountId(source(null))).toBeNull();
    expect(canonicalSourceAccountId(source('  '))).toBeNull();
  });

  it('adopts the mailbox a sibling with the SAME provisional id recorded (cursor before config)', () => {
    const gcal = source('provider:google:owner');
    const gmail = source('provider:google:owner', { emailAddress: 'Owner@Example.com' }, { emailAddress: 'config@example.com' });
    expect(canonicalSourceAccountId(gcal, [gcal, gmail])).toBe('owner@example.com');
  });

  it('reads the snake_case and config spellings when the cursor has none', () => {
    expect(canonicalSourceAccountId(source('provider:google:a', { email_address: 'snake@example.com' }))).toBe('snake@example.com');
    expect(canonicalSourceAccountId(source('provider:google:a', {}, { email_address: 'cfg@example.com' }))).toBe('cfg@example.com');
  });

  it('never borrows an identity from a sibling with a DIFFERENT provisional id', () => {
    const mine = source('provider:google:mine');
    const other = source('provider:google:other', { emailAddress: 'other@example.com' });
    expect(canonicalSourceAccountId(mine, [mine, other])).toBe('provider:google:mine');
  });

  it('ignores a recorded value that is not an address', () => {
    expect(canonicalSourceAccountId(source('provider:google:a', { emailAddress: 'not-an-address' }))).toBe('provider:google:a');
  });
});
