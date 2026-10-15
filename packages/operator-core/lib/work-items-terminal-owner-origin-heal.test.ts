import { describe, expect, it, vi } from 'vitest';
import { createBranchedSqlMock } from './testing/sql-mock';

import {
  decideTerminalOwnerOriginHeal,
  selfHealTerminalOwnerOriginIfStranded,
} from './work-items-terminal-owner-origin-heal';

/**
 * EI-22189521072988065 — a locally-closed row that federates to `origin:'remote'`
 * could never be upgraded from `completionAuthority:'proposed'`, because the
 * existing self-heal (`selfHealAuthorOriginIfStranded`) exempts only the row's
 * `created_by`, not the different peer who actually claimed and CLOSED it
 * (`terminal_owner`).
 *
 * Mirrors `work-items-orphan-author.test.ts`'s shape: the pure policy is tested
 * directly (no database), and each SAFETY case is asserted explicitly so a future
 * edit that widens the hatch fails loudly here first.
 */
describe('decideTerminalOwnerOriginHeal', () => {
  const CALLER = 'su-4a6e2255-f324-4774-a05e-c3bc87e643ac';

  it('permits when the caller is the row\'s recorded terminal_owner on an already-settled remote row', () => {
    expect(
      decideTerminalOwnerOriginHeal({
        origin: 'remote',
        wasAlreadySettled: true,
        terminalOwner: CALLER,
        callerOwnerId: CALLER,
      }),
    ).toEqual({ permit: true, reason: 'terminal-owner-match' });
  });

  it('leaves a local-origin row untouched by this policy', () => {
    expect(
      decideTerminalOwnerOriginHeal({
        origin: 'local',
        wasAlreadySettled: true,
        terminalOwner: CALLER,
        callerOwnerId: CALLER,
      }),
    ).toEqual({ permit: false, reason: 'not-remote' });
  });

  it('SCOPING: refuses a fresh (not-yet-settled) completion — this is never a fresh-completion bypass', () => {
    // The whole point of the guard is to re-affirm evidence on a row that was
    // ALREADY terminal before this call. A row still becoming terminal in THIS
    // call must go through the ordinary completion path, not this hatch.
    expect(
      decideTerminalOwnerOriginHeal({
        origin: 'remote',
        wasAlreadySettled: false,
        terminalOwner: CALLER,
        callerOwnerId: CALLER,
      }),
    ).toEqual({ permit: false, reason: 'not-already-settled' });
  });

  it('a row with no recorded terminal_owner is not provably re-closeable by anyone', () => {
    for (const terminalOwner of [null, undefined, '']) {
      expect(
        decideTerminalOwnerOriginHeal({
          origin: 'remote',
          wasAlreadySettled: true,
          terminalOwner,
          callerOwnerId: CALLER,
        }),
      ).toEqual({ permit: false, reason: 'no-recorded-terminal-owner' });
    }
  });

  it('SAFETY: refuses when the caller is neither the creator nor the recorded terminal_owner', () => {
    // The failure this guards against: opening the hatch to ANY caller on an
    // already-settled remote row would let a stranger re-write evidence on work
    // a different peer actually did. Only the row's OWN recorded closer qualifies.
    expect(
      decideTerminalOwnerOriginHeal({
        origin: 'remote',
        wasAlreadySettled: true,
        terminalOwner: CALLER,
        callerOwnerId: 'su-some-other-peer',
      }),
    ).toEqual({ permit: false, reason: 'caller-not-terminal-owner' });
  });

  it('SAFETY: an absent caller identity is refused, never treated as a match', () => {
    for (const callerOwnerId of [null, undefined, '']) {
      expect(
        decideTerminalOwnerOriginHeal({
          origin: 'remote',
          wasAlreadySettled: true,
          terminalOwner: CALLER,
          callerOwnerId,
        }),
      ).toEqual({ permit: false, reason: 'caller-not-terminal-owner' });
    }
  });
});

describe('selfHealTerminalOwnerOriginIfStranded', () => {
  const CALLER = 'su-4a6e2255-f324-4774-a05e-c3bc87e643ac';

  it('no-ops without touching the database when the policy refuses', async () => {
    const sql = vi.fn(async () => [] as { feature_id: string }[]);
    vi.doMock('@papercusp/db-org', async (orig) => ({
      ...(await orig<typeof import('@papercusp/db-org')>()),
      getOrgPg: () => ({ sql }),
    }));
    vi.resetModules();
    const { selfHealTerminalOwnerOriginIfStranded: heal } = await import(
      './work-items-terminal-owner-origin-heal'
    );
    const healed = await heal('EI-1', 'su-not-the-owner', {
      origin: 'remote',
      wasAlreadySettled: true,
      terminalOwner: CALLER,
    });
    expect(healed).toBe(false);
    expect(sql).not.toHaveBeenCalled();
    vi.doUnmock('@papercusp/db-org');
    vi.resetModules();
  });

  it('returns false without a call when `id` is falsy, even for an otherwise-permitted caller', async () => {
    const healed = await selfHealTerminalOwnerOriginIfStranded('', CALLER, {
      origin: 'remote',
      wasAlreadySettled: true,
      terminalOwner: CALLER,
    });
    expect(healed).toBe(false);
  });

  it.each([
    { matched: true, harnessSlug: undefined },
    { matched: false, harnessSlug: undefined },
    { matched: true, harnessSlug: 'papercusp' },
    { matched: false, harnessSlug: 'papercusp' },
  ])('scopes one UPDATE to identity/owner and optional tenant: matched=$matched harness=$harnessSlug', async ({ matched, harnessSlug }) => {
    // A tag call can construct a fragment without executing a statement. Reuse
    // the strict recorder and count the actual UPDATE rather than all tag calls.
    const write = vi.fn((query: string, args: unknown[]) => {
      const values = args.slice(1);
      expect(query).toMatch(/WHERE\s+feature_id\s*=/);
      expect(query).toContain("AND origin = 'remote'");
      expect(query).toMatch(/AND\s+terminal_owner\s*=/);
      expect(query).toContain('RETURNING feature_id');
      expect(values[0]).toBe('EI-1');
      expect(values.at(-1)).toBe(CALLER);
      return matched ? [{ feature_id: 'EI-1' }] : [];
    });
    const branches = createBranchedSqlMock([
      {
        label: 'optional tenant fragment',
        match: (query) => query.trim() === '' || query.trim() === 'AND harness_slug =',
        respond: (query, args) => {
          expect(query.trim()).toBe(harnessSlug ? 'AND harness_slug =' : '');
          expect(args.slice(1)).toEqual(harnessSlug ? [harnessSlug] : []);
          return [];
        },
      },
      { label: 'origin heal UPDATE', match: (query) => query.includes('UPDATE harness_shared.work_items'), respond: write },
    ]);
    const sql = vi.fn(branches.handler);
    vi.doMock('@papercusp/db-org', async (orig) => ({
      ...(await orig<typeof import('@papercusp/db-org')>()),
      getOrgPg: () => ({ sql }),
    }));
    vi.resetModules();
    try {
      const { selfHealTerminalOwnerOriginIfStranded: heal } = await import('./work-items-terminal-owner-origin-heal');
      expect(await heal('EI-1', CALLER, {
        origin: 'remote', wasAlreadySettled: true, terminalOwner: CALLER, harnessSlug,
      })).toBe(matched);
      expect(write).toHaveBeenCalledTimes(1);
      branches.assertAllMatched();
      expect(branches.capturedQueries.find((query) => query.sql.includes('UPDATE harness_shared.work_items')))
        .toMatchObject({ composed: true, fragmentArgs: 1 });
    } finally {
      vi.doUnmock('@papercusp/db-org');
      vi.resetModules();
    }
  });
});
