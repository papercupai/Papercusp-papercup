/**
 * remember-shareable-fed-slug.test.ts — EI-10432: a `shareable: true` memory must
 * carry the federation ROUTING KEY, or be refused.
 *
 * Before this fix, `shareable: true` was accepted and federated NOTHING: the row
 * landed with memory_canonical.harness_slug NULL, the capture trigger enqueued the
 * op under a NULL slug, and the drain (`WHERE harness_slug = $slug`) can never
 * match NULL — so the op was captured, stranded, and eventually GC'd, with no
 * error anywhere. The two halves of the fix, both asserted here:
 *
 *   1. a shareable write that CANNOT be routed is REFUSED (loudly, like assertFact)
 *      rather than silently stranded — and refused BEFORE journalPendingWrite, so
 *      the drain cannot resurrect it (the same ordering the pause gate depends on);
 *   2. a routable one carries the resolved hive-home slug on
 *      `metadata.fed_harness_slug`, which mig 587's trigger stamps onto the row's
 *      harness_slug column (mem0's insert writes only `payload` — see the
 *      integration test for the DB half).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/memory/remember-shareable-fed-slug.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// WI-39811: detached imports are now enrolled in trackDetached and DRAINED before the
// environment tears down, so this best-effort side effect — previously a floating
// `void import(...)` that never finished inside the test — now really runs and logs its
// diagnostic for a dependency this unit test never configures. Mock the collaborator
// rather than silencing console, so the diagnostic stays meaningful in production.
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

vi.mock('../../memory/write-journal', () => ({
  journalPendingWrite: vi.fn(async () => null),
  markJournalCommitted: vi.fn(async () => {}),
}));
vi.mock('../../memory/backend', () => ({
  getMemoryBackend: vi.fn(),
  MemoryUnavailableError: class MemoryUnavailableError extends Error {},
}));
vi.mock('../../auth', () => ({ getSessionUserOrDefault: vi.fn() }));
// Spread the real module so pure exports survive the mock — a minimal stub
// breaks at collection when a transitive import derefs them (EI-14928; AGENT_ROLES
// in testing/run.ts did exactly that across this directory on 2026-08-17).
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
}));
// Spread the real module so pure exports (e.g. `generated`) survive the mock —
// a minimal stub breaks at collection when a transitive import derefs them (EI-14928).
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(),
}));
vi.mock('../../memory/memory-pause', () => ({
  isMemoryPaused: vi.fn(async () => false),
  MEMORY_PAUSED_REFUSAL: { ok: false },
}));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
// The unit under test is the GUARD, not the registry lookup: the resolver has its
// own semantics (member harness → its hive HOME slug) and its own tests.
vi.mock('../../agent-facts/store', () => ({
  resolveFactFederationSlug: vi.fn(async () => null),
}));
// P-012 / D-006: the shared-pool seal reads the disclosure ledger through
// getOrgPg, which this file stubs out. Sealing has its own real-PG suite
// (shared-store-seal.integration.test.ts); here the writer holds no disclosure.
vi.mock('../../personal-vault/shared-store-seal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../personal-vault/shared-store-seal')>()),
  sealSharedText: vi.fn(async (_sql: unknown, params: { text: string }) => ({ sealed: false, text: params.text })),
}));

import remember from './remember';
import { getMemoryBackend } from '../../memory/backend';
import { getSessionUserOrDefault } from '../../auth';
import { journalPendingWrite } from '../../memory/write-journal';
import { resolveFactFederationSlug } from '../../agent-facts/store';
import { getFlag } from '@papercusp/flags/server';

type Handler = { handler: (args: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }> }> };
const call = (args: Record<string, unknown>) =>
  (remember as unknown as Handler).handler(args, { principal: { workspaceId: 'ws-1' } });
const parse = (res: { content: Array<{ text: string }> }) => JSON.parse(res.content[0].text);

const fakeBackend = () => ({
  name: 'fake',
  available: vi.fn(async () => ({ ok: true })),
  remember: vi.fn(async () => ({ ids: ['m1'] })),
  search: vi.fn(async () => []),
});

let backend: ReturnType<typeof fakeBackend>;

beforeEach(() => {
  vi.clearAllMocks();
  backend = fakeBackend();
  vi.mocked(getSessionUserOrDefault).mockResolvedValue({ id: 'user-1', display_name: 'Test' } as never);
  vi.mocked(getMemoryBackend).mockReturnValue(backend as never);
  vi.mocked(resolveFactFederationSlug).mockResolvedValue(null);
  vi.mocked(getFlag).mockResolvedValue(true);
});

/** The metadata the handler actually handed the store. */
const metadataOf = (): Record<string, unknown> | undefined => {
  // The fake's `remember` is declared with no params, so its `mock.calls` type is
  // an empty tuple — read the recorded args through the real call signature.
  const calls = backend.remember.mock.calls as unknown as Array<
    [string, { metadata?: Record<string, unknown> }]
  >;
  return calls[0]?.[1]?.metadata;
};

describe('memory:remember — shareable memories need a federation routing key (EI-10432)', () => {
  it('REFUSES shareable writes before journaling when the federation flag is OFF', async () => {
    vi.mocked(getFlag).mockResolvedValue(false);
    const out = parse(await call({
      content: 'a shareable project convention',
      kind: 'project',
      hive_slug: 'my-pot',
      shareable: true,
    }));

    expect(out).toMatchObject({
      ok: false,
      stored: false,
      reason: 'mem0_federation_disabled',
    });
    expect(journalPendingWrite).not.toHaveBeenCalled();
    expect(backend.remember).not.toHaveBeenCalled();
  });

  it('fails closed when the federation flag cannot be resolved', async () => {
    vi.mocked(getFlag).mockRejectedValue(new Error('flag store unavailable'));
    const out = parse(await call({
      content: 'a shareable project convention',
      kind: 'project',
      hive_slug: 'my-pot',
      shareable: true,
    }));

    expect(out.reason).toBe('mem0_federation_disabled');
    expect(journalPendingWrite).not.toHaveBeenCalled();
    expect(backend.remember).not.toHaveBeenCalled();
  });

  it('REFUSES a shareable PERSONAL memory — it has no hive to federate to', async () => {
    const out = parse(await call({ content: 'my dog is Rex', kind: 'user', shareable: true }));
    expect(out).toMatchObject({
      ok: false,
      stored: false,
      reason: 'shareable_memory_needs_federation_scope',
    });
    // The refusal must tell the agent how to fix it, not fail opaquely.
    expect(out.message).toMatch(/hive_slug|harness_slug/);
  });

  it('does NOT journal a refused shareable write — the drain must not resurrect it', async () => {
    await call({ content: 'my dog is Rex', kind: 'user', shareable: true });
    expect(journalPendingWrite).not.toHaveBeenCalled();
    expect(backend.remember).not.toHaveBeenCalled();
  });

  it('REFUSES a shareable harness memory whose harness resolves to no hive home', async () => {
    vi.mocked(resolveFactFederationSlug).mockResolvedValue(null); // un-hived / standalone-unresolvable
    const out = parse(await call({ content: 'x', kind: 'project', harness_slug: 'orphan', shareable: true }));
    expect(out.reason).toBe('shareable_memory_needs_federation_scope');
    expect(resolveFactFederationSlug).toHaveBeenCalledWith('orphan');
  });

  it('a harness-scoped shareable memory rides its HIVE HOME slug, not the harness slug', async () => {
    // The whole point of the resolver: a MEMBER harness federates under the home
    // slug its peers' projection is bound to.
    vi.mocked(resolveFactFederationSlug).mockResolvedValue('the-hive-home');
    const out = parse(await call({ content: 'x', kind: 'project', harness_slug: 'member-harness', shareable: true }));
    expect(out.reason).not.toBe('shareable_memory_needs_federation_scope');
    expect(metadataOf()).toMatchObject({ fed_harness_slug: 'the-hive-home' });
    expect(journalPendingWrite).toHaveBeenCalledWith(expect.objectContaining({ shareable: true }));
  });

  it('a hive-scoped shareable memory rides that hive directly (no registry hop)', async () => {
    await call({ content: 'x', kind: 'project', hive_slug: 'my-pot', shareable: true });
    expect(metadataOf()).toMatchObject({ fed_harness_slug: 'my-pot' });
    expect(resolveFactFederationSlug).not.toHaveBeenCalled();
  });

  it('a PRIVATE memory is untouched — no routing key, no refusal, no resolver hop', async () => {
    // The default path must stay inert: federation is opt-in (D-006).
    const out = parse(await call({ content: 'my dog is Rex', kind: 'user' }));
    expect(out.reason).not.toBe('shareable_memory_needs_federation_scope');
    expect(metadataOf()).not.toHaveProperty('fed_harness_slug');
    expect(resolveFactFederationSlug).not.toHaveBeenCalled();
    expect(getFlag).not.toHaveBeenCalled();
    expect(backend.remember).toHaveBeenCalled();
  });

  it('shareable:false is not a federation request either', async () => {
    await call({ content: 'x', kind: 'user', shareable: false });
    expect(metadataOf()).not.toHaveProperty('fed_harness_slug');
    expect(resolveFactFederationSlug).not.toHaveBeenCalled();
    expect(getFlag).not.toHaveBeenCalled();
    expect(journalPendingWrite).toHaveBeenCalledWith(expect.objectContaining({ shareable: false }));
  });
});
