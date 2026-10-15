/**
 * Unit tests for the write-time Pot-membership resolver (pot-membership-enforcement
 * -2026-07-20, P-005). Pure over an injected {@link PotLookup} — no PG.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  resolveWorkItemPot,
  isWorkspaceGlobalLabel,
  canonicalPotSlug,
  PotMembershipError,
  PLATFORM_POT_SLUG,
  pgPotLookup,
  classifyPotLookupError,
  type PotLookup,
} from './pot-membership';

/** A lookup whose real Pots are `realPots` and whose platform Pot is `platform` (or null). */
function fakeLookup(opts: { realPots?: string[]; platform?: string | null }): PotLookup {
  const real = new Set(opts.realPots ?? []);
  return {
    async resolveRealPot(rawSlug) {
      const canon = canonicalPotSlug(rawSlug.trim());
      return real.has(canon) ? canon : null;
    },
    async platformPot() {
      return opts.platform ?? null;
    },
  };
}

const WS = 'papercusp-workspace';
const potted = { realPots: ['papercusp', 'oddsmith-hive'], platform: PLATFORM_POT_SLUG };

describe('isWorkspaceGlobalLabel', () => {
  it('treats null / blank / operator scopes as workspace-global', () => {
    expect(isWorkspaceGlobalLabel(null, WS)).toBe(true);
    expect(isWorkspaceGlobalLabel(undefined, WS)).toBe(true);
    expect(isWorkspaceGlobalLabel('   ', WS)).toBe(true);
    expect(isWorkspaceGlobalLabel('operator', WS)).toBe(true);
    expect(isWorkspaceGlobalLabel('operator:papercusp-workspace', WS)).toBe(true);
    expect(isWorkspaceGlobalLabel('*', WS)).toBe(true);
    expect(isWorkspaceGlobalLabel('@singleton', WS)).toBe(true);
    expect(isWorkspaceGlobalLabel('all', WS)).toBe(true);
    expect(isWorkspaceGlobalLabel('hive-canary', WS)).toBe(true);
  });
  it('treats the bare workspace id as a non-Pot partition label', () => {
    expect(isWorkspaceGlobalLabel('papercusp-workspace', WS)).toBe(true);
  });
  it('treats a concrete Pot slug as NOT workspace-global', () => {
    expect(isWorkspaceGlobalLabel('papercusp', WS)).toBe(false);
    expect(isWorkspaceGlobalLabel('oddsmith-hive', WS)).toBe(false);
  });
});

describe('canonicalPotSlug', () => {
  it('folds the legacy dogfood repo name to the platform Pot', () => {
    expect(canonicalPotSlug('papercup')).toBe('papercusp');
    expect(canonicalPotSlug('papercup-hive')).toBe('papercusp');
  });
  it('leaves any other slug unchanged', () => {
    expect(canonicalPotSlug('oddsmith-hive')).toBe('oddsmith-hive');
    expect(canonicalPotSlug('papercusp')).toBe('papercusp');
  });
});

describe('resolveWorkItemPot', () => {
  it('(1) keeps an explicit slug that is a real Pot', async () => {
    const got = await resolveWorkItemPot({ rawSlug: 'oddsmith-hive', workspaceId: WS, lookup: fakeLookup(potted) });
    expect(got).toBe('oddsmith-hive');
  });

  it('(1) canonicalizes a legacy dogfood slug to the platform Pot', async () => {
    const got = await resolveWorkItemPot({ rawSlug: 'papercup', workspaceId: WS, lookup: fakeLookup(potted) });
    expect(got).toBe('papercusp');
  });

  it('(2) homes an operator/global scope to the platform Pot', async () => {
    for (const raw of [null, undefined, '', 'operator', 'operator:papercusp-workspace', '*', 'papercusp-workspace']) {
      const got = await resolveWorkItemPot({ rawSlug: raw, workspaceId: WS, lookup: fakeLookup(potted) });
      expect(got).toBe('papercusp');
    }
  });

  it('(3) REJECTS an explicit, non-global slug that is not a real Pot', async () => {
    await expect(
      resolveWorkItemPot({ rawSlug: 'made-up-pot', workspaceId: WS, lookup: fakeLookup(potted) }),
    ).rejects.toBeInstanceOf(PotMembershipError);
  });

  it('(3) the reject error carries the raw slug + workspace', async () => {
    const err = await resolveWorkItemPot({
      rawSlug: 'made-up-pot',
      workspaceId: WS,
      lookup: fakeLookup(potted),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PotMembershipError);
    expect((err as PotMembershipError).code).toBe('pot_not_found');
    expect((err as PotMembershipError).rawSlug).toBe('made-up-pot');
    expect((err as PotMembershipError).workspaceId).toBe(WS);
  });

  it('(4) FAILS OPEN for a workspace with no platform Pot — keeps a made-up explicit slug', async () => {
    const got = await resolveWorkItemPot({
      rawSlug: 'test-harness',
      workspaceId: 'generic-test',
      lookup: fakeLookup({ realPots: ['some-fixture-hive'], platform: null }),
    });
    expect(got).toBe('test-harness');
  });

  it('(4) FAILS OPEN for a workspace with no platform Pot — keeps operator scope (null)', async () => {
    const got = await resolveWorkItemPot({
      rawSlug: null,
      workspaceId: 'generic-test',
      lookup: fakeLookup({ realPots: [], platform: null }),
    });
    expect(got).toBeNull();
  });

  it('does not enforce for an unscoped (*) SU workspace — returns the raw slug', async () => {
    // lookup should never be consulted; pass one that would throw if it were.
    const explodeLookup: PotLookup = {
      resolveRealPot: async () => {
        throw new Error('should not be called for unscoped SU');
      },
      platformPot: async () => {
        throw new Error('should not be called for unscoped SU');
      },
    };
    expect(await resolveWorkItemPot({ rawSlug: 'anything', workspaceId: '*', lookup: explodeLookup })).toBe('anything');
    expect(await resolveWorkItemPot({ rawSlug: null, workspaceId: '*', lookup: explodeLookup })).toBeNull();
  });

  it('resolves a real Pot even when the workspace also has a platform Pot (no false reject)', async () => {
    const got = await resolveWorkItemPot({ rawSlug: 'oddsmith-hive', workspaceId: WS, lookup: fakeLookup(potted) });
    expect(got).toBe('oddsmith-hive');
  });
});

/**
 * WI-10004845: the PG lookup used to read ANY DB error as "no such Pot". A transient
 * error on the platform-Pot check therefore homed operator-scope issues to the non-pot
 * `operator:<ws>` (14 rows in one second, 2026-09-25 20:37Z). The lookup is tri-state.
 */
describe('pgPotLookup tri-state (WI-10004845)', () => {
  const pgError = (code?: string) => Object.assign(new Error(`pg ${code ?? 'reset'}`), code ? { code } : {});
  const recordingSleep = () => {
    const delays: number[] = [];
    return { delays, sleep: async (ms: number) => void delays.push(ms) };
  };

  it('retries a transient error and answers from the measured result', async () => {
    let calls = 0;
    const { delays, sleep } = recordingSleep();
    const onUnmeasured = vi.fn();
    const lookup = pgPotLookup(WS, {
      query: async () => {
        calls += 1;
        if (calls <= 2) throw pgError('57P01');
        return true;
      },
      sleep,
      onUnmeasured,
    });
    expect(await lookup.platformPot()).toBe(PLATFORM_POT_SLUG);
    expect(calls).toBe(3);
    expect(delays).toEqual([150, 450]);
    expect(onUnmeasured).not.toHaveBeenCalled();
  });

  it('a missing pots relation (bare test schema) still fails open to "no platform Pot", without retrying', async () => {
    let calls = 0;
    const { delays, sleep } = recordingSleep();
    const onUnmeasured = vi.fn();
    const lookup = pgPotLookup(WS, {
      query: async () => {
        calls += 1;
        throw pgError('42P01');
      },
      sleep,
      onUnmeasured,
    });
    expect(await lookup.platformPot()).toBeNull();
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
    expect(onUnmeasured).not.toHaveBeenCalled();
  });

  it('an unanswered lookup homes operator scope to the platform Pot, not operator:<ws>, and reports it', async () => {
    const onUnmeasured = vi.fn();
    const lookup = pgPotLookup(WS, {
      query: async () => {
        throw pgError('ECONNRESET');
      },
      sleep: async () => {},
      onUnmeasured,
    });
    expect(await resolveWorkItemPot({ rawSlug: null, workspaceId: WS, lookup })).toBe(PLATFORM_POT_SLUG);
    expect(await resolveWorkItemPot({ rawSlug: 'operator', workspaceId: WS, lookup })).toBe(PLATFORM_POT_SLUG);
    expect(onUnmeasured).toHaveBeenCalledTimes(2);
    expect(onUnmeasured).toHaveBeenCalledWith({
      workspaceId: WS,
      slug: PLATFORM_POT_SLUG,
      attempts: 3,
      errorCode: 'ECONNRESET',
      assumed: PLATFORM_POT_SLUG,
    });
  });

  it('an unanswered lookup keeps an explicit slug instead of rejecting it as not-a-Pot', async () => {
    const onUnmeasured = vi.fn();
    const lookup = pgPotLookup(WS, {
      query: async () => {
        throw new Error('Connection terminated unexpectedly');
      },
      sleep: async () => {},
      onUnmeasured,
    });
    expect(await resolveWorkItemPot({ rawSlug: 'portal', workspaceId: WS, lookup })).toBe('portal');
    expect(onUnmeasured).toHaveBeenCalledWith(expect.objectContaining({ slug: 'portal', errorCode: null, assumed: 'portal' }));
  });

  it('a measured absence is still absence (fail open for an un-potted workspace)', async () => {
    const onUnmeasured = vi.fn();
    const lookup = pgPotLookup(WS, { query: async () => false, sleep: async () => {}, onUnmeasured });
    expect(await lookup.platformPot()).toBeNull();
    expect(await resolveWorkItemPot({ rawSlug: null, workspaceId: WS, lookup })).toBeNull();
    expect(onUnmeasured).not.toHaveBeenCalled();
  });

  it('classifies only a missing/unreadable relation as a stable absence', () => {
    for (const code of ['42P01', '3F000', '42501']) expect(classifyPotLookupError(pgError(code))).toBe('absent');
    for (const error of [pgError('57P01'), pgError('53300'), pgError('57014'), pgError('ECONNRESET'), new Error('x'), null]) {
      expect(classifyPotLookupError(error)).toBe('unknown');
    }
  });
});
