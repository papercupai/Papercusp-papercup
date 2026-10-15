import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UnifiedToolContext } from '@papercusp/agent-mcp';

// The store's Postgres seam. Mocked so these are true unit tests: the invariants below are
// about KEYING and EXPIRY, neither of which needs a database to be wrong.
const pgState: { payload: unknown } = { payload: {} };
vi.mock('../operator-state-pg', () => ({
  readOperatorState: vi.fn(async () => pgState.payload),
  writeOperatorState: vi.fn(async (_table: string, next: unknown) => {
    pgState.payload = next;
  }),
  updateOperatorState: vi.fn(async (_table: string, fallback: unknown, mutate: (current: unknown) => unknown) => {
    pgState.payload = mutate(pgState.payload ?? fallback); return pgState.payload;
  }),
}));
// Arming a real timer in a unit test would leak into the suite.
vi.mock('@papercusp/scheduled-registry', () => ({ managedSetInterval: vi.fn() }));

import { SUPERUSER_FALLBACK_CLIENT_ID } from '../agent-tools/coordination/identity';
import { directedImplementerConfinement } from './session-confinement';
import { checkSessionConfinement, hasSessionConfinementResolver, sessionAllowsAmbientContext } from './session-confinement-port';
import {
  __markSessionConfinementsPrimedForTest,
  __setSessionConfinementCacheForTest,
  declareSessionConfinement,
  refreshSessionConfinements,
  releaseSessionConfinement,
  sessionConfinementFor,
  readSessionConfinement,
  type StoredSessionConfinement,
} from './session-confinement-store';

const CONFINEMENT = directedImplementerConfinement({
  directorSid: 'su-director-1',
  scope: 'WI-1234',
});

const IMPLEMENTER_OWNER = 'su-implementer-abc123';

function stored(overrides: Partial<StoredSessionConfinement> = {}): StoredSessionConfinement {
  return {
    confinement: CONFINEMENT,
    declaredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  pgState.payload = {};
  __setSessionConfinementCacheForTest({});
  __markSessionConfinementsPrimedForTest();
});

// ── D-017 §5: installation is bound to the import, not to a boot step ─────────────
describe('session-confinement store — installation', () => {
  it('installs the resolver merely by being imported', () => {
    // This gate fails SILENTLY when unresolved: no resolver means every session is
    // unconfined, with nothing thrown and nothing logged. So "did anything install it"
    // is itself an invariant worth a test.
    expect(hasSessionConfinementResolver()).toBe(true);
  });
});

describe('exact native launch ceilings', () => {
  it('accepts the same ceiling after JSONB reorders object keys but still refuses policy changes', async () => {
    const confinement = { denyTools: [], denyOutside: ['work_items:get'],
      denyWorkItemsOutside: { id: 'F-own', harness: 'bench', checkout: '/private/assignment' },
      denyAmbientContext: true as const, reason: 'assignment', imposedBy: 'host' };
    expect(await declareSessionConfinement({ ownerId: IMPLEMENTER_OWNER, confinement })).toMatchObject({ ok: true });
    // JSONB preserves values and array order, but not object insertion order.
    // The mock normally returns the original object, masking this round trip.
    const reordered = { imposedBy: 'host', reason: 'assignment', denyAmbientContext: true as const,
      denyWorkItemsOutside: { checkout: '/private/assignment', harness: 'bench', id: 'F-own' },
      denyOutside: ['work_items:get'], denyTools: [] };
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(confinement));
    pgState.payload = { sessions: { [IMPLEMENTER_OWNER]: stored({ confinement: reordered }) } };
    expect(await declareSessionConfinement({ ownerId: IMPLEMENTER_OWNER, confinement })).toMatchObject({ ok: true });
    await expect(declareSessionConfinement({ ownerId: IMPLEMENTER_OWNER,
      confinement: { ...confinement, denyOutside: ['work_items:get', 'work_items:complete'] } }))
      .rejects.toThrow(/cannot be replaced/);
    await expect(declareSessionConfinement({ ownerId: IMPLEMENTER_OWNER,
      confinement: { ...confinement, denyWorkItemsOutside: { ...confinement.denyWorkItemsOutside, id: 'F-other' } } }))
      .rejects.toThrow(/cannot be replaced/);
    expect(await readSessionConfinement(IMPLEMENTER_OWNER)).toEqual(confinement);
  });
  it('snapshots nominated product reads, refuses broad replacement, and fails closed on corrupt stored selectors', async () => {
    const reads = { harness: 'papercusp', docsHarness: 'engineering', docsSlugs: ['agent-insights/product-guide'], testFiles: ['lib/probe.test.ts'] };
    const confinement = { denyTools: [], denyOutside: ['docs:get', 'testing:runs'], denyProductReadsOutside: reads,
      reason: 'blind product reads', imposedBy: 'host' };
    expect(await declareSessionConfinement({ ownerId: IMPLEMENTER_OWNER, confinement })).toMatchObject({ ok: true });
    reads.docsSlugs.push('other-guide');
    reads.testFiles.push('lib/other.test.ts');
    expect((await readSessionConfinement(IMPLEMENTER_OWNER))?.denyProductReadsOutside).toEqual({
      harness: 'papercusp', docsHarness: 'engineering', docsSlugs: ['agent-insights/product-guide'], testFiles: ['lib/probe.test.ts'],
    });
    expect(await checkSessionConfinement({ toolName: 'docs:get', args: { harness: 'engineering', slugs: ['other-guide'] },
      ctx: { isSuperuser: true, workspaceId: 'papercusp-workspace', uiClientId: IMPLEMENTER_OWNER } as UnifiedToolContext,
    })).toMatchObject({ decision: 'deny' });
    await expect(declareSessionConfinement({ ownerId: IMPLEMENTER_OWNER, confinement })).rejects.toThrow(/cannot be replaced/);
    const malformed = { ...confinement, denyProductReadsOutside: { ...reads, testFiles: ['../outside.test.ts'] } };
    expect(await declareSessionConfinement({ ownerId: 'su-other', confinement: malformed })).toMatchObject({ ok: false });
    pgState.payload = { sessions: { [IMPLEMENTER_OWNER]: stored({ confinement: malformed }) } };
    await expect(readSessionConfinement(IMPLEMENTER_OWNER)).rejects.toThrow(/malformed/);
    expect(await declareSessionConfinement({ ownerId: 'su-other', confinement: {
      ...confinement, denyProductReadsOutside: { ...reads, docsSlugs: null } as never,
    } })).toMatchObject({ ok: false });
  });

  it('snapshots the exact assignment, refuses retargeting, and rejects malformed stored scope', async () => {
    const boundary = { id: 'F-own', harness: 'bench', checkout: '/private/assignment' };
    const confined = { denyTools: [], denyOutside: ['work_items:get'], denyWorkItemsOutside: boundary, reason: 'assignment', imposedBy: 'host' };
    expect(await declareSessionConfinement({ ownerId: IMPLEMENTER_OWNER, confinement: confined })).toMatchObject({ ok: true });
    boundary.id = 'F-other';
    expect((await readSessionConfinement(IMPLEMENTER_OWNER))?.denyWorkItemsOutside).toEqual({ id: 'F-own', harness: 'bench', checkout: '/private/assignment' });
    await expect(declareSessionConfinement({ ownerId: IMPLEMENTER_OWNER, confinement: confined })).rejects.toThrow(/cannot be replaced/);
    const malformed = { ...confined, denyWorkItemsOutside: { id: 'F-own', harness: '../other', checkout: '/private/assignment' } };
    expect(await declareSessionConfinement({ ownerId: 'su-other', confinement: malformed })).toMatchObject({ ok: false });
    pgState.payload = { sessions: { [IMPLEMENTER_OWNER]: stored({ confinement: malformed }) } };
    await expect(readSessionConfinement(IMPLEMENTER_OWNER)).rejects.toThrow(/malformed/);
  });
  it('persists frozen context policy, keeps it after expiry, and refuses to remove it', async () => {
    const frozen = { denyTools: [], denyOutside: ['coord:whoami'], denyAmbientContext: true as const,
      reason: 'frozen benchmark', imposedBy: 'host' };
    expect(await declareSessionConfinement({ ownerId: IMPLEMENTER_OWNER, workspaceId: 'private', confinement: frozen })).toMatchObject({ ok: true });
    expect(await sessionAllowsAmbientContext({ ownerId: IMPLEMENTER_OWNER, workspaceId: 'private' })).toBe(false);
    const payload = pgState.payload as { sessions: Record<string, StoredSessionConfinement> };
    payload.sessions[IMPLEMENTER_OWNER] = { ...payload.sessions[IMPLEMENTER_OWNER], expiresAt: new Date(0).toISOString() };
    expect(await sessionAllowsAmbientContext({ ownerId: IMPLEMENTER_OWNER, workspaceId: 'private' })).toBe(false);
    const { denyAmbientContext: _denied, ...widened } = frozen;
    await expect(declareSessionConfinement({ ownerId: IMPLEMENTER_OWNER, workspaceId: 'private', confinement: widened })).rejects.toThrow(/cannot be replaced/);
  });
  it('fails closed on a malformed stored ambient policy and refuses invalid writes', async () => {
    const malformed = { denyTools: [], denyOutside: ['coord:whoami'], denyAmbientContext: false,
      reason: 'frozen benchmark', imposedBy: 'host' };
    pgState.payload = { sessions: { [IMPLEMENTER_OWNER]: stored({ confinement: malformed as never }) } };
    await expect(readSessionConfinement(IMPLEMENTER_OWNER, 'private')).rejects.toThrow(/malformed/);
    expect(await sessionAllowsAmbientContext({ ownerId: IMPLEMENTER_OWNER, workspaceId: 'private' })).toBe(false);
    expect(await declareSessionConfinement({ ownerId: IMPLEMENTER_OWNER, workspaceId: 'private', confinement: malformed as never })).toMatchObject({ ok: false });
  });
  const confinement = { denyTools: [], denyOutside: ['coord:whoami', 'work_items:get'],
    reason: 'metered native gateway', imposedBy: 'benchmark-host' };
  it.each(['double-encoded JSONB', 'invalid population'])('rejects %s as unreadable authority', async kind => {
    pgState.payload = kind === 'double-encoded JSONB' ? JSON.stringify({ sessions: {} }) : { sessions: [] };
    await expect(readSessionConfinement(IMPLEMENTER_OWNER, 'bench-private')).rejects.toThrow(/population is malformed/);
  });
  it('reads a declaration written by another host even with an empty warm cache', async () => {
    pgState.payload = { sessions: { [IMPLEMENTER_OWNER]: stored({ confinement }) } };
    expect(await readSessionConfinement(IMPLEMENTER_OWNER, 'bench-private')).toEqual(confinement);
    expect(await checkSessionConfinement({ toolName: 'capability:bash', ctx: {
      isSuperuser: true, workspaceId: 'bench-private', uiClientId: IMPLEMENTER_OWNER,
    } as UnifiedToolContext })).toMatchObject({ decision: 'deny' });
  });
  it('fails closed after expiry and retains the strict row across refresh/pruning', async () => {
    pgState.payload = { sessions: { [IMPLEMENTER_OWNER]: stored({ confinement, expiresAt: 'invalid' }) } };
    await refreshSessionConfinements();
    expect(sessionConfinementFor(IMPLEMENTER_OWNER)?.denyOutside).toEqual([]);
    await declareSessionConfinement({ ownerId: 'su-another', confinement: CONFINEMENT });
    expect((pgState.payload as { sessions: Record<string, unknown> }).sessions[IMPLEMENTER_OWNER]).toBeDefined();
    expect((await readSessionConfinement(IMPLEMENTER_OWNER))?.denyOutside).toEqual([]);
  });
  it('snapshots the declaration and refuses a wider replacement', async () => {
    const ceiling = ['coord:whoami'];
    await declareSessionConfinement({ ownerId: IMPLEMENTER_OWNER, confinement: { ...confinement, denyOutside: ceiling } });
    ceiling.push('capability:bash');
    expect((await readSessionConfinement(IMPLEMENTER_OWNER))?.denyOutside).toEqual(['coord:whoami']);
    await expect(declareSessionConfinement({ ownerId: IMPLEMENTER_OWNER, confinement }))
      .rejects.toThrow(/cannot be replaced/);
  });
  it('denies an authoritative store failure instead of using an unconfined cache miss', async () => {
    const pg = await import('../operator-state-pg');
    vi.mocked(pg.readOperatorState).mockRejectedValueOnce(new Error('store down'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await checkSessionConfinement({ toolName: 'capability:bash', ctx: {
      isSuperuser: true, workspaceId: 'bench-private', uiClientId: IMPLEMENTER_OWNER,
    } as UnifiedToolContext })).toMatchObject({ decision: 'deny' });
    log.mockRestore();
  });
});

// ── D-017 §2: the hazard — a population id must never carry a confinement ─────────
describe('session-confinement store — refuses population-shaped ids', () => {
  it('refuses to WRITE a confinement keyed on the superuser transport fallback', async () => {
    const res = await declareSessionConfinement({
      ownerId: SUPERUSER_FALLBACK_CLIENT_ID,
      confinement: CONFINEMENT,
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toMatch(/transport-only identity/i);
    // The bad row must never exist — refusing at the write is what guarantees that.
    expect(pgState.payload).toEqual({});
  });

  it('refuses to WRITE one keyed on an ephemeral mcp-call identity', async () => {
    const res = await declareSessionConfinement({
      ownerId: 'mcp-call-48211',
      confinement: CONFINEMENT,
    });
    expect(res.ok).toBe(false);
  });

  // Defence in depth: even if a row reached the table by a path that skipped the write
  // guard, applying it would confine every client-less su session on the box — the owner's
  // own interactive session included — and silently, since a refusal looks identical
  // whether it was aimed at you or inherited from a stranger.
  it('refuses to APPLY a population-keyed row that is already in the cache', () => {
    __setSessionConfinementCacheForTest({ [SUPERUSER_FALLBACK_CLIENT_ID]: stored() });
    expect(sessionConfinementFor(SUPERUSER_FALLBACK_CLIENT_ID)).toBeNull();
  });

  it('drops a population-keyed row when refreshing from the table', async () => {
    pgState.payload = {
      sessions: {
        [SUPERUSER_FALLBACK_CLIENT_ID]: stored(),
        [IMPLEMENTER_OWNER]: stored(),
      },
    };
    await refreshSessionConfinements();
    expect(sessionConfinementFor(SUPERUSER_FALLBACK_CLIENT_ID)).toBeNull();
    expect(sessionConfinementFor(IMPLEMENTER_OWNER)).not.toBeNull();
  });
});

describe('session-confinement store — declare, resolve, release', () => {
  it('binds the declared session and only that session', async () => {
    const res = await declareSessionConfinement({
      ownerId: IMPLEMENTER_OWNER,
      confinement: CONFINEMENT,
    });
    expect(res.ok).toBe(true);
    expect(sessionConfinementFor(IMPLEMENTER_OWNER)?.denyTools).toEqual(CONFINEMENT.denyTools);
    // A different live session — the director, the owner — is untouched.
    expect(sessionConfinementFor('su-director-1')).toBeNull();
  });

  it('primes the local cache on write, so there is no window before the spawn', async () => {
    // D-017 §4: the launch writes the confinement BEFORE spawning the implementer, and the
    // write refreshes this process's cache. If that stopped happening, a freshly launched
    // implementer would run unconfined until the next 60s refresh.
    await declareSessionConfinement({ ownerId: IMPLEMENTER_OWNER, confinement: CONFINEMENT });
    expect(sessionConfinementFor(IMPLEMENTER_OWNER)).not.toBeNull();
  });

  it('releases idempotently', async () => {
    await declareSessionConfinement({ ownerId: IMPLEMENTER_OWNER, confinement: CONFINEMENT });
    await releaseSessionConfinement(IMPLEMENTER_OWNER);
    expect(sessionConfinementFor(IMPLEMENTER_OWNER)).toBeNull();
    await expect(releaseSessionConfinement(IMPLEMENTER_OWNER)).resolves.toBeUndefined();
  });

  it('rejects a confinement that denies nothing', async () => {
    const res = await declareSessionConfinement({
      ownerId: IMPLEMENTER_OWNER,
      confinement: { denyTools: [], reason: 'r', imposedBy: 'i' },
    });
    expect(res.ok).toBe(false);
  });
});

describe('session-confinement store — expiry', () => {
  it('does not bind an expired row', () => {
    __setSessionConfinementCacheForTest({
      [IMPLEMENTER_OWNER]: stored({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
    });
    expect(sessionConfinementFor(IMPLEMENTER_OWNER)).toBeNull();
  });

  it('treats an unparseable expiry as expired, not as forever', () => {
    // A confinement is a narrowing, so the conservative reading of a corrupt row is "do not
    // apply it". The alternative would confine a session permanently with no way to age out.
    __setSessionConfinementCacheForTest({
      [IMPLEMENTER_OWNER]: stored({ expiresAt: 'not-a-date' }),
    });
    expect(sessionConfinementFor(IMPLEMENTER_OWNER)).toBeNull();
  });

  it('prunes expired rows on the next write', async () => {
    pgState.payload = {
      sessions: {
        'su-stale-session': stored({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      },
    };
    await declareSessionConfinement({ ownerId: IMPLEMENTER_OWNER, confinement: CONFINEMENT });
    const sessions = (pgState.payload as { sessions: Record<string, unknown> }).sessions;
    expect(Object.keys(sessions)).toEqual([IMPLEMENTER_OWNER]);
  });

  it('is unconfined for an owner it has never seen', () => {
    expect(sessionConfinementFor('su-someone-else')).toBeNull();
    expect(sessionConfinementFor(null)).toBeNull();
    expect(sessionConfinementFor(undefined)).toBeNull();
  });
});

// ── D-016(a) / D-017 §1: the confinement is never caller-supplied ─────────────────
describe('session-confinement store — identity comes from ctx, never from the request', () => {
  it('ignores a confinement offered in the tool arguments', async () => {
    // A confinement the caller supplies is one the caller can omit. The resolver's only
    // input is ctx; this pins that no args-shaped payload can conjure — or lift — one.
    const ctx = {
      isSuperuser: true,
      uiClientId: 'su-unconfined-session',
      // Deliberate decoys, in every shape a careless implementation might have read:
      args: { confinement: CONFINEMENT },
      confinement: CONFINEMENT,
      denyTools: CONFINEMENT.denyTools,
    } as unknown as UnifiedToolContext;

    await expect(
      checkSessionConfinement({ toolName: 'work_items:complete', ctx }),
    ).resolves.toBeNull();
  });

  it('binds a session whose ctx identity matches a declared row', async () => {
    await declareSessionConfinement({ ownerId: IMPLEMENTER_OWNER, confinement: CONFINEMENT });
    const ctx = {
      isSuperuser: true,
      uiClientId: IMPLEMENTER_OWNER,
    } as unknown as UnifiedToolContext;

    const v = await checkSessionConfinement({ toolName: 'work_items:complete', ctx });
    expect(v?.decision).toBe('deny');
    expect(v?.reason).toContain('WI-1234');
  });

  it('denies the mangled MCP spelling for that same session', async () => {
    await declareSessionConfinement({ ownerId: IMPLEMENTER_OWNER, confinement: CONFINEMENT });
    const ctx = {
      isSuperuser: true,
      uiClientId: IMPLEMENTER_OWNER,
    } as unknown as UnifiedToolContext;

    const v = await checkSessionConfinement({
      toolName: 'mcp__papercusp-su__work_items_complete',
      ctx,
    });
    expect(v?.decision).toBe('deny');
  });

  it('leaves an UNATTRIBUTABLE ctx unconfined rather than throwing', async () => {
    // resolveAgentIdentity throws when a ctx carries no identity at all. Such a caller
    // cannot be the implementer, whose identity is established at spawn — and a throw here
    // would break every dispatch from a client-less context.
    const ctx = {} as unknown as UnifiedToolContext;
    await expect(
      checkSessionConfinement({ toolName: 'work_items:complete', ctx }),
    ).resolves.toBeNull();
  });
});
