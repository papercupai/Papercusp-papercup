/**
 * federation-scope.test.ts — the workspace shared-Hive default-scope resolver
 * (cross-machine-coord-parity-and-trust-2026-07-01 P-001). Pure over injected
 * deps. Pins:
 *   • exactly one shared Hive → { kind:'one', homeSlug } (owned-published OR joined);
 *   • private / un-published owned hives are NEVER a scope (no DHT leak);
 *   • zero / several shared → none / many (ambiguity never guessed);
 *   • resolution errors fail SOFT to none (a scope lookup never breaks a send);
 *   • TTL cache: second call within the window does not re-read; fresh bypasses.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/federation-scope.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveWorkspaceHiveScope,
  resolveSharedHiveDisambiguation,
  resetFederationScopeCache,
  type FederationScopeDeps,
  type WorkspaceHiveScope,
} from './federation-scope';

function makeDeps(over?: Partial<FederationScopeDeps>): FederationScopeDeps {
  return {
    listHives: vi.fn(async () => [{ homeSlug: 'hive-a' }]),
    loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
    getOwnedHiveMeta: vi.fn(async () => ({ visibility: 'public' })),
    ...over,
  };
}

beforeEach(() => {
  resetFederationScopeCache();
});

describe('resolveWorkspaceHiveScope', () => {
  it('exactly one owned PUBLISHED hive → one', async () => {
    const deps = makeDeps();
    const r = await resolveWorkspaceHiveScope('ws1', { deps });
    expect(r).toEqual({ kind: 'one', homeSlug: 'hive-a' });
  });

  it('a JOINED remote_hive view counts as shared without owned meta', async () => {
    const deps = makeDeps({
      loadHarnessRegistry: vi.fn(async () => ({
        projects: [{ slug: 'hive-a', remote_hive: true }],
      })),
      getOwnedHiveMeta: vi.fn(async () => null),
    });
    const r = await resolveWorkspaceHiveScope('ws1', { deps });
    expect(r).toEqual({ kind: 'one', homeSlug: 'hive-a' });
    expect(deps.getOwnedHiveMeta).not.toHaveBeenCalled(); // joined ⇒ meta not consulted
  });

  it('an invite-LINK join (joined_via_link, no remote_hive view) counts as shared', async () => {
    // The canonical link join writes the cloned harness with joined_via_link and no
    // remote_hive view; before this, a link-joined member never saw its own hive as
    // shared, so seat offers were skipped `hive_not_shared` (measured on the P-202 rig).
    const deps = makeDeps({
      loadHarnessRegistry: vi.fn(async () => ({
        projects: [{ slug: 'hive-a', joined_via_link: true }],
      })),
      getOwnedHiveMeta: vi.fn(async () => null),
    });
    const r = await resolveWorkspaceHiveScope('ws1', { deps });
    expect(r).toEqual({ kind: 'one', homeSlug: 'hive-a' });
    expect(deps.getOwnedHiveMeta).not.toHaveBeenCalled();
  });

  it('a plain local entry with no join marker and no published meta is not shared', async () => {
    const deps = makeDeps({
      loadHarnessRegistry: vi.fn(async () => ({ projects: [{ slug: 'hive-a' }] })),
      getOwnedHiveMeta: vi.fn(async () => null),
    });
    const r = await resolveWorkspaceHiveScope('ws1', { deps });
    expect(r).toEqual({ kind: 'none' });
  });

  it('a PRIVATE owned hive is never a scope (no DHT leak)', async () => {
    const deps = makeDeps({ getOwnedHiveMeta: vi.fn(async () => ({ visibility: 'private' })) });
    expect(await resolveWorkspaceHiveScope('ws1', { deps })).toEqual({ kind: 'none' });
  });

  it('an UN-PUBLISHED owned hive (no meta) is never a scope', async () => {
    const deps = makeDeps({ getOwnedHiveMeta: vi.fn(async () => null) });
    expect(await resolveWorkspaceHiveScope('ws1', { deps })).toEqual({ kind: 'none' });
  });

  it('no hives at all → none (registry never read)', async () => {
    const deps = makeDeps({ listHives: vi.fn(async () => []) });
    expect(await resolveWorkspaceHiveScope('ws1', { deps })).toEqual({ kind: 'none' });
    expect(deps.loadHarnessRegistry).not.toHaveBeenCalled();
  });

  it('several shared hives → many with sorted candidates (never guessed)', async () => {
    const deps = makeDeps({
      listHives: vi.fn(async () => [{ homeSlug: 'hive-b' }, { homeSlug: 'hive-a' }]),
    });
    expect(await resolveWorkspaceHiveScope('ws1', { deps })).toEqual({
      kind: 'many',
      candidates: ['hive-a', 'hive-b'],
    });
  });

  it('mixed: one published + one private → the published one wins alone', async () => {
    const deps = makeDeps({
      listHives: vi.fn(async () => [{ homeSlug: 'pub' }, { homeSlug: 'priv' }]),
      getOwnedHiveMeta: vi.fn(async (home: string) =>
        home === 'pub' ? { visibility: 'invite' } : { visibility: 'private' },
      ),
    });
    expect(await resolveWorkspaceHiveScope('ws1', { deps })).toEqual({
      kind: 'one',
      homeSlug: 'pub',
    });
  });

  it('a resolution error fails SOFT to none — a scope lookup never breaks a send', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = makeDeps({
        listHives: vi.fn(async () => {
          throw new Error('pg down');
        }),
      });
      expect(await resolveWorkspaceHiveScope('ws1', { deps })).toEqual({ kind: 'none' });
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('caches per workspace within the TTL; { fresh:true } bypasses', async () => {
    const deps = makeDeps();
    await resolveWorkspaceHiveScope('ws1', { deps });
    await resolveWorkspaceHiveScope('ws1', { deps });
    expect(deps.listHives).toHaveBeenCalledTimes(1); // second hit served from cache
    await resolveWorkspaceHiveScope('ws1', { deps, fresh: true });
    expect(deps.listHives).toHaveBeenCalledTimes(2);
    // a different workspace is its own cache key
    await resolveWorkspaceHiveScope('ws2', { deps });
    expect(deps.listHives).toHaveBeenCalledTimes(3);
  });
});

describe('resolveSharedHiveDisambiguation (WI-5211 / EI-16673)', () => {
  const one: WorkspaceHiveScope = { kind: 'one', homeSlug: 'papercusp' };
  const many: WorkspaceHiveScope = { kind: 'many', candidates: ['other-hive', 'papercusp'] };
  const none: WorkspaceHiveScope = { kind: 'none' };

  it('exactly one shared hive resolves alone, with or without an explicit hive matching it', () => {
    expect(resolveSharedHiveDisambiguation(one, undefined, null)).toEqual({
      ok: true,
      homeSlug: 'papercusp',
      candidates: ['papercusp'],
    });
    expect(resolveSharedHiveDisambiguation(one, 'papercusp', null)).toEqual({
      ok: true,
      homeSlug: 'papercusp',
      candidates: ['papercusp'],
    });
  });

  it('many shared hives + an explicit matching hive resolves to it', () => {
    expect(resolveSharedHiveDisambiguation(many, 'papercusp', null)).toEqual({
      ok: true,
      homeSlug: 'papercusp',
      candidates: ['other-hive', 'papercusp'],
    });
  });

  it('many shared hives + no explicit hive but a fallback that names a shared one resolves to it', () => {
    expect(resolveSharedHiveDisambiguation(many, undefined, 'papercusp')).toEqual({
      ok: true,
      homeSlug: 'papercusp',
      candidates: ['other-hive', 'papercusp'],
    });
  });

  it('many shared hives + no explicit hive + no matching fallback → ambiguous, with candidates surfaced (never guessed)', () => {
    const res = resolveSharedHiveDisambiguation(many, undefined, 'not-a-hive');
    expect(res.ok).toBe(false);
    expect(res.candidates).toEqual(['other-hive', 'papercusp']);
    if (!res.ok) expect(res.error).toMatch(/2 shared hives/);
  });

  it('an explicit hive NOT in the shared set is refused, never silently accepted', () => {
    const res = resolveSharedHiveDisambiguation(many, 'private-hive', 'papercusp');
    expect(res.ok).toBe(false);
    expect(res.candidates).toEqual(['other-hive', 'papercusp']);
    if (!res.ok) expect(res.error).toMatch(/private-hive.*not one of/);
  });

  it('no shared hive at all → refused with empty candidates regardless of explicit hive', () => {
    const res = resolveSharedHiveDisambiguation(none, 'papercusp', 'papercusp');
    expect(res).toEqual({
      ok: false,
      candidates: [],
      error: expect.stringMatching(/NO shared hive/),
    });
  });

  it('an explicit hive naming a DORMANT joined view is honoured; implicit is refused and names it', () => {
    const dormantOnly: WorkspaceHiveScope = { kind: 'none', dormant: ['hive-dead'] };
    expect(resolveSharedHiveDisambiguation(dormantOnly, 'hive-dead', null)).toEqual({
      ok: true,
      homeSlug: 'hive-dead',
      candidates: [],
    });
    const implicit = resolveSharedHiveDisambiguation(dormantOnly, undefined, null);
    expect(implicit.ok).toBe(false);
    expect(implicit.ok === false && implicit.error).toMatch(/dormant joined views.*hive-dead/);
  });
});

// WI-6554700010030876: a dead joined view (shared-hive-test-hive-2: 120k outbound coord
// rows, zero ever received) was the lone implicit default and absorbed every unscoped send.
describe('resolveWorkspaceHiveScope — dormant joined views', () => {
  const OLD = Date.now() - 60 * 24 * 60 * 60 * 1000; // pot row 60 days old
  const joinedDeps = (over?: Partial<FederationScopeDeps>) =>
    makeDeps({
      listHives: vi.fn(async () => [{ homeSlug: 'hive-dead', createdAt: OLD }]),
      loadHarnessRegistry: vi.fn(async () => ({ projects: [{ slug: 'hive-dead', remote_hive: true }] })),
      getOwnedHiveMeta: vi.fn(async () => null),
      ...over,
    });

  it('an old joined view with no remote activity in the window is dormant, never the default', async () => {
    const probe = vi.fn(async () => false);
    const r = await resolveWorkspaceHiveScope('ws1', { deps: joinedDeps({ hasRecentRemoteActivity: probe }), fresh: true });
    expect(r).toEqual({ kind: 'none', dormant: ['hive-dead'] });
    expect(probe).toHaveBeenCalledWith('hive-dead', 'ws1', expect.any(Number));
  });

  it('a dormant view does not shadow a live owned-published hive (it stays the lone default)', async () => {
    const deps = joinedDeps({
      listHives: vi.fn(async () => [{ homeSlug: 'hive-dead', createdAt: OLD }, { homeSlug: 'hive-live' }]),
      getOwnedHiveMeta: vi.fn(async () => ({ visibility: 'public' })),
      hasRecentRemoteActivity: vi.fn(async () => false),
    });
    const r = await resolveWorkspaceHiveScope('ws1', { deps, fresh: true });
    expect(r).toEqual({ kind: 'one', homeSlug: 'hive-live', dormant: ['hive-dead'] });
  });

  it('an old joined view that HAS heard from a peer stays shared', async () => {
    const r = await resolveWorkspaceHiveScope('ws1', {
      deps: joinedDeps({ hasRecentRemoteActivity: vi.fn(async () => true) }),
      fresh: true,
    });
    expect(r).toEqual({ kind: 'one', homeSlug: 'hive-dead' });
  });

  it('a FRESH join (pot row inside the window) stays shared without probing', async () => {
    const probe = vi.fn(async () => false);
    const r = await resolveWorkspaceHiveScope('ws1', {
      deps: joinedDeps({
        listHives: vi.fn(async () => [{ homeSlug: 'hive-dead', createdAt: Date.now() - 1000 }]),
        hasRecentRemoteActivity: probe,
      }),
      fresh: true,
    });
    expect(r).toEqual({ kind: 'one', homeSlug: 'hive-dead' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('a probe ERROR fails soft to the pre-guard behaviour (counted as shared)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await resolveWorkspaceHiveScope('ws1', {
      deps: joinedDeps({ hasRecentRemoteActivity: vi.fn(async () => { throw new Error('pg down'); }) }),
      fresh: true,
    });
    expect(r).toEqual({ kind: 'one', homeSlug: 'hive-dead' });
    warn.mockRestore();
  });
});
