/**
 * artifacts:* tool tests — bulk keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Stub ctx.tx's sql template tag and
 * verify each tool's input validation + output ENVELOPE shape + role gate via
 * dispatchProjectedTool. The handlers read ctx.tx (the host-scoped, RLS-subject
 * handle — audit P-012), NOT getOrgPg, so the stub lives on the ctx; the RLS
 * isolation itself is covered by artifacts-rls.integration.test.ts.
 *
 * Each tool now returns the house envelope
 * `{ ok, results:[{ ok, slug, rel_path, …data | error }], counts }`; the n=1
 * single-call shape (`{ slug?, rel_path, … }`) yields exactly one result. The
 * compound key is `(slug, rel_path)` — slug defaults to ctx.harnessSlug, and a
 * missing/invalid slug becomes a per-item `{ ok:false, error }` on the bulk
 * (`items`) path (vs the dispatcher `precondition_failed` on the single path).
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the ctx.tx template tag so the tool handlers don't require a live
// PG connection. It is invoked as `ctx.tx\`...\``; we intercept it and
// return whatever rows the test fixture configured.
const sqlImpl = vi.fn(async () => [] as Array<Record<string, unknown>>);
const sqlTag = (...args: unknown[]) => sqlImpl(...args);

import { lookupByMcpName, type UnifiedToolContext } from '@papercusp/tooldef';
import { dispatchProjectedTool } from '@papercusp/tooldef';

const MAKE_CTX = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'default',
  harnessSlug: 'sheets',
  role: 'architect',
  runId: 'run_T',
  spawnId: 'spw_T',
  tx: sqlTag as unknown as UnifiedToolContext['tx'],
  ...over,
});

// Unwrap the house bulk envelope from a dispatched ToolResult.
const envelopeOf = (r: { result?: { content?: unknown[] } | null }) =>
  JSON.parse((r.result!.content![0] as { text: string }).text);

// Side-effect-import the 4 tool modules once. They self-register into the
// projection registry; subsequent tests re-use the same registrations.
beforeAll(async () => {
  await import('../load');
  await import('../save');
  await import('../append');
  await import('../delete');
});

beforeEach(() => {
  sqlImpl.mockReset();
  sqlImpl.mockResolvedValue([]);
});

describe('artifacts:load', () => {
  it('returns found:false as a single result when no row matches', async () => {
    const tool = lookupByMcpName('artifacts:load')!;
    expect(tool).toBeDefined();
    expect(tool.agentRoles).toContain('worker');
    expect(tool.agentRoles).toContain('curator');

    const r = await dispatchProjectedTool(
      tool,
      'artifacts:load',
      { slug: 'test', rel_path: 'memory/raw.md' },
      MAKE_CTX(),
      {},
    );
    expect(r.ok).toBe(true);
    const env = envelopeOf(r);
    expect(env).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(env.results[0]).toEqual({
      ok: true,
      slug: 'test',
      rel_path: 'memory/raw.md',
      found: false,
      content: null,
      updated_at: null,
    });
  });

  it('returns found:true with content when row exists', async () => {
    sqlImpl.mockResolvedValueOnce([{ content: 'hello world', updated_at: '1234567' }]);
    const tool = lookupByMcpName('artifacts:load')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:load',
      { slug: 'test', rel_path: 'memory/raw.md' },
      MAKE_CTX(),
      {},
    );
    const item = envelopeOf(r).results[0];
    expect(item.found).toBe(true);
    expect(item.content).toBe('hello world');
    expect(item.updated_at).toBe(1234567);
  });

  it('allows the frozen judge to load rubric-mandated acceptance evidence', async () => {
    sqlImpl.mockResolvedValueOnce([{ content: 'acceptance evidence', updated_at: '42' }]);
    const tool = lookupByMcpName('artifacts:load')!;
    expect(tool.agentRoles).toContain('judge');

    const r = await dispatchProjectedTool(
      tool,
      'artifacts:load',
      { slug: 'test', rel_path: 'evidence/acceptance.json' },
      MAKE_CTX({ role: 'judge' }),
      {},
    );

    expect(r.ok).toBe(true);
    expect(envelopeOf(r).results[0]).toMatchObject({
      ok: true,
      slug: 'test',
      rel_path: 'evidence/acceptance.json',
      found: true,
      content: 'acceptance evidence',
    });
  });

  it('EI-21471082146021784: offset/max_chars page large content deterministically', async () => {
    const big = 'a'.repeat(5000) + 'b'.repeat(5000);
    sqlImpl.mockResolvedValueOnce([{ content: big, updated_at: '7' }]);
    const tool = lookupByMcpName('artifacts:load')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:load',
      { slug: 'test', rel_path: 'big.md', offset: 4000, max_chars: 4000 },
      MAKE_CTX(),
      {},
    );
    const item = envelopeOf(r).results[0];
    expect(item.found).toBe(true);
    expect(item.content).toBe('a'.repeat(1000) + 'b'.repeat(3000));
    expect(item.content_total_chars).toBe(10_000);
    expect(item.content_offset).toBe(4000);
    expect(item.content_truncated).toBe(true);
  });

  it('EI-21471082146021784: unpaged reads stay field-identical to the legacy shape', async () => {
    sqlImpl.mockResolvedValueOnce([{ content: 'hello world', updated_at: '9' }]);
    const tool = lookupByMcpName('artifacts:load')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:load',
      { slug: 'test', rel_path: 'small.md' },
      MAKE_CTX(),
      {},
    );
    const item = envelopeOf(r).results[0];
    expect(Object.keys(item).sort()).toEqual(
      ['content', 'found', 'ok', 'rel_path', 'slug', 'updated_at'],
    );
  });

  it('strips a leading .papercusp/ prefix from rel_path', async () => {
    const tool = lookupByMcpName('artifacts:load')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:load',
      { slug: 'test', rel_path: '.papercusp/memory/raw.md' },
      MAKE_CTX(),
      {},
    );
    expect(envelopeOf(r).results[0].rel_path).toBe('memory/raw.md');
  });

  it('falls back to ctx.harnessSlug when slug arg is omitted', async () => {
    const tool = lookupByMcpName('artifacts:load')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:load',
      { rel_path: 'memory/raw.md' },
      MAKE_CTX({ harnessSlug: 'fallback-slug' }),
      {},
    );
    expect(envelopeOf(r).results[0].slug).toBe('fallback-slug');
  });

  it('loads MANY via items:[…]; correlate by (slug, rel_path)', async () => {
    sqlImpl
      .mockResolvedValueOnce([{ content: 'A', updated_at: '10' }])
      .mockResolvedValueOnce([]);
    const tool = lookupByMcpName('artifacts:load')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:load',
      { items: [{ slug: 'test', rel_path: 'a.md' }, { slug: 'test', rel_path: 'b.md' }] },
      MAKE_CTX(),
      {},
    );
    const env = envelopeOf(r);
    expect(env.counts).toEqual({ ok: 2, failed: 0 });
    expect(env.results.map((x: { rel_path: string; found: boolean }) => [x.rel_path, x.found])).toEqual([
      ['a.md', true],
      ['b.md', false],
    ]);
  });

  it('rejects precondition_failed when neither arg slug nor ctx.harnessSlug is set (single path)', async () => {
    // The single-call slug guard stays a declarative `requires:` precondition —
    // the DISPATCHER rejects before the handler runs (adopt-event-rules-engines).
    const tool = lookupByMcpName('artifacts:load')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:load',
      { rel_path: 'memory/raw.md' },
      MAKE_CTX({ harnessSlug: undefined }),
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('precondition_failed');
    expect(r.error?.message).toMatch(/required/i);
  });

  it('rejects precondition_failed on an invalid ctx.harnessSlug (single path, valid-ctx-slug)', async () => {
    const tool = lookupByMcpName('artifacts:load')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:load',
      { rel_path: 'memory/raw.md' },
      MAKE_CTX({ harnessSlug: 'bad slug/with spaces' }),
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('precondition_failed');
    expect(r.error?.message).toMatch(/invalid harnessSlug/i);
  });

  it('on the items path, a missing-slug item fails ONLY itself (no batch reject)', async () => {
    // With items present, the declarative precondition short-circuits and the
    // handler re-asserts per-item slug presence against ctx.harnessSlug.
    const tool = lookupByMcpName('artifacts:load')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:load',
      { items: [{ rel_path: 'a.md' }] },
      MAKE_CTX({ harnessSlug: undefined }),
      {},
    );
    expect(r.ok).toBe(true);
    const env = envelopeOf(r);
    expect(env.counts).toEqual({ ok: 0, failed: 1 });
    expect(env.results[0]).toMatchObject({ ok: false, rel_path: 'a.md' });
    expect(env.results[0].error).toMatch(/slug.*required/i);
  });
});

describe('artifacts:save', () => {
  it('write roles allowlist excludes validator + reviewer', async () => {
    const tool = lookupByMcpName('artifacts:save')!;
    expect(tool.agentRoles).toContain('worker');
    expect(tool.agentRoles).toContain('architect');
    expect(tool.agentRoles).toContain('operator');
    expect(tool.agentRoles).not.toContain('validator');
    expect(tool.agentRoles).not.toContain('reviewer');
  });

  it('returns byte count + updated_at as a single result', async () => {
    const tool = lookupByMcpName('artifacts:save')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:save',
      { slug: 'test', rel_path: 'a.md', content: 'hello' },
      MAKE_CTX(),
      {},
    );
    expect(r.ok).toBe(true);
    const item = envelopeOf(r).results[0];
    expect(item.bytes).toBe(5);
    expect(item.updated_at).toEqual(expect.any(Number));
    expect(item.slug).toBe('test');
  });

  it('reports UTF-8 bytes for non-ASCII content', async () => {
    const tool = lookupByMcpName('artifacts:save')!;
    const content = 'café → 🦄';
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:save',
      { slug: 'test', rel_path: 'unicode.md', content },
      MAKE_CTX(),
      {},
    );
    expect(r.ok).toBe(true);
    const item = envelopeOf(r).results[0];
    expect(item.bytes).toBe(Buffer.byteLength(content, 'utf8'));
    expect(item.bytes).toBeGreaterThan(content.length);
  });

  it('saves MANY via items:[…]', async () => {
    const tool = lookupByMcpName('artifacts:save')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:save',
      { items: [{ slug: 'test', rel_path: 'a.md', content: 'aa' }, { slug: 'test', rel_path: 'b.md', content: 'bbb' }] },
      MAKE_CTX(),
      {},
    );
    const env = envelopeOf(r);
    expect(env.counts).toEqual({ ok: 2, failed: 0 });
    expect(env.results.map((x: { rel_path: string; bytes: number }) => [x.rel_path, x.bytes])).toEqual([
      ['a.md', 2],
      ['b.md', 3],
    ]);
  });

  it('rejects validator role via dispatcher gate', async () => {
    const tool = lookupByMcpName('artifacts:save')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:save',
      { slug: 'test', rel_path: 'a.md', content: 'x' },
      MAKE_CTX({ role: 'validator' }),
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('role_not_allowed');
  });
});

describe('artifacts:append', () => {
  it('returns appended_bytes + total_bytes from RETURNING', async () => {
    sqlImpl.mockResolvedValueOnce([{ content: 'previous + appended' }]);
    const tool = lookupByMcpName('artifacts:append')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:append',
      { slug: 'test', rel_path: 'log.md', suffix: ' + appended' },
      MAKE_CTX(),
      {},
    );
    expect(r.ok).toBe(true);
    const item = envelopeOf(r).results[0];
    expect(item.appended_bytes).toBe(' + appended'.length);
    expect(item.total_bytes).toBe('previous + appended'.length);
  });

  it('falls back to suffix when RETURNING produces no rows', async () => {
    sqlImpl.mockResolvedValueOnce([]);
    const tool = lookupByMcpName('artifacts:append')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:append',
      { slug: 'test', rel_path: 'log.md', suffix: 'new content' },
      MAKE_CTX(),
      {},
    );
    expect(envelopeOf(r).results[0].total_bytes).toBe('new content'.length);
  });
});

describe('artifacts:delete', () => {
  it('only architect/operator/curator roles allowed', async () => {
    const tool = lookupByMcpName('artifacts:delete')!;
    expect(tool.agentRoles).toEqual(['architect', 'operator', 'curator']);
  });

  it('rejects worker role via dispatcher gate', async () => {
    const tool = lookupByMcpName('artifacts:delete')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:delete',
      { slug: 'test', rel_path: 'a.md' },
      MAKE_CTX({ role: 'worker', chunkId: 'ck_T' }),
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('role_not_allowed');
  });

  it('returns deleted:true when count > 0', async () => {
    // postgres.js DELETE returns the result with a `count` property.
    sqlImpl.mockImplementationOnce(async () => {
      const arr: Array<unknown> = [];
      Object.defineProperty(arr, 'count', { value: 1, configurable: true });
      return arr as never;
    });
    const tool = lookupByMcpName('artifacts:delete')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:delete',
      { slug: 'test', rel_path: 'a.md' },
      MAKE_CTX({ role: 'architect' }),
      {},
    );
    expect(r.ok).toBe(true);
    expect(envelopeOf(r).results[0].deleted).toBe(true);
  });
});

describe('artifacts:* — slug validation', () => {
  it('rejects slug with whitespace (zod regex on the single-call slug)', async () => {
    const tool = lookupByMcpName('artifacts:load')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:load',
      { slug: 'has space', rel_path: 'a.md' },
      MAKE_CTX(),
      {},
    );
    expect(r.ok).toBe(false);
    // Schema-validation failures are caller-class `invalid_input` (EI-334).
    expect(r.error?.code).toBe('invalid_input');
    expect(r.error?.message).toMatch(/invalid_args|pattern|slug/i);
  });
});
