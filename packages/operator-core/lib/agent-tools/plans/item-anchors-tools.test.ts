import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushSnapshot, SnapshotSymbol } from '../../code-intelligence/push-snapshot';
import addTool from './add-item';
import editTool from './edit';

const fixture = vi.hoisted(() => ({
  body: '', profile: 'code' as 'code' | 'general', root: '',
  snapshot: null as PushSnapshot | null, links: new Map<string, unknown>(),
}));
const scope = { workspaceId: 'unit-anchor-workspace', harnessSlug: 'unit-anchor-harness' };

// Keep the real handler, parser, edit evaluator and filesystem resolver. Only
// the transaction/registry and post-write delivery boundaries are substituted.
vi.mock('./with-plan-lock', async importOriginal => ({
  ...await importOriginal<typeof import('./with-plan-lock')>(),
  withPlanLock: async (_ctx: unknown, options: {
    slug: string;
    inTransaction?: (tx: never, body: string, lockedScope: typeof scope, value: unknown) => Promise<void>;
  }, mutate: (body: string, meta: { verificationProfile: string }) =>
    Promise<{ newBody: string | null; value: { ok: boolean } }>) => {
    const result = await mutate(fixture.body, { verificationProfile: fixture.profile });
    if (result.newBody !== null && result.value.ok) {
      // The resync binding queries linked work items in the same transaction.
      // This unit fixture has no linked work items; real persistence is covered
      // by item-anchors.integration.test.ts.
      await options.inTransaction?.((async () => []) as never, result.newBody, scope, result.value);
      fixture.body = result.newBody;
    }
    return { kind: 'ok', value: result.value, filePath: 'plan://unit/' + options.slug, version: 2 };
  },
}));
vi.mock('./source', async importOriginal => ({
  ...await importOriginal<typeof import('./source')>(),
  resolvePlanScope: async () => scope,
}));
vi.mock('../../plan-items/anchors', async importOriginal => {
  const actual = await importOriginal<typeof import('../../plan-items/anchors')>();
  return { ...actual, resolveHarnessAnchors: async (_ws: string, _harness: string,
    inputs: import('../../plan-items/anchors').AnchorInput[]) =>
    actual.resolvePlanItemAnchors(inputs, { root: fixture.root, snapshot: fixture.snapshot, budgetMs: 5000 }) };
});
vi.mock('../../plan-items/anchor-store', async importOriginal => ({
  ...await importOriginal<typeof import('../../plan-items/anchor-store')>(),
  writePlanItemAnchors: async (_tx: unknown, _scope: unknown, write: { itemId: string; anchors: unknown }) => {
    fixture.links.set(write.itemId, structuredClone(write.anchors));
  },
}));
vi.mock('./revisions', async importOriginal => ({
  ...await importOriginal<typeof import('./revisions')>(),
  planRevisionCapture: () => ({ afterWrite: async () => {}, recorded: { current: null } }),
}));
vi.mock('../coordination/plan-events', async importOriginal => ({
  ...await importOriginal<typeof import('../coordination/plan-events')>(),
  emitPlanEventForCaller: async () => {},
}));
vi.mock('../../sync-sse', async importOriginal => ({
  ...await importOriginal<typeof import('../../sync-sse')>(),
  notifySyncInvalidate: async () => {},
}));

const slug = 'unit-plan-code-links';
const source = 'export function linked() { return 1; }\n';
const caller = "import { linked } from './code';\nlinked();\n";
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const ctx = () => ({
  signal: new AbortController().signal, role: 'su', ...scope,
  log: () => {}, progress: () => {}, metadata: () => {},
  principal: { kind: 'agent', slug: 'unit-anchor-agent', workspaceId: scope.workspaceId },
}) as never;
function data(result: unknown): any {
  const envelope = result as { data?: unknown; content?: { type: string; text?: string }[] };
  if (envelope.data !== undefined) return envelope.data;
  const text = envelope.content?.find(c => c.type === 'text' && c.text?.startsWith('{'))?.text;
  if (!text) throw new Error('Expected a JSON tool response');
  return JSON.parse(text);
}
const add = (extra: Record<string, unknown> = {}) => addTool.handler({
  slug, harness: scope.harnessSlug, phase: 'Phase 1 — Work',
  text: 'Added item', importance: 'normal', ...extra,
} as never, ctx());

beforeAll(async () => {
  fixture.root = await mkdtemp(join(tmpdir(), 'plan-anchor-tools-unit-'));
  await writeFile(join(fixture.root, 'code.ts'), source);
  await writeFile(join(fixture.root, 'flow.test.ts'), caller);
  const symbol: SnapshotSymbol = {
    id: 'fixture:linked', name: 'linked', path: 'code.ts', line: 1, column: 17,
    signature: 'linked()', sha256: sha(source), aliases: [],
    callers: [{ path: 'flow.test.ts', line: 2, column: 1, sha256: sha(caller), spelling: 'linked' }],
  };
  fixture.snapshot = {
    commit: 'fixture', generatedAt: new Date().toISOString(), generatedMs: Date.now(),
    hashes: new Map(), importers: new Map(), symbols: new Map([['linked', [symbol]]]),
  };
});
beforeEach(() => {
  fixture.profile = 'code';
  fixture.links.clear();
  const tick = String.fromCharCode(96);
  fixture.body = [
    '---', 'title: Unit anchor plan', 'slug: ' + slug, 'status: active',
    'created: 2026-10-22', 'updated: 2026-10-22', '---', '# Unit anchor plan',
    '', '## Now', '', '**State:** Fixture.', '', '**Next:** Check links.',
    '', '## Phase 1 — Work', '', '- **P-001** ' + tick + 'todo' + tick + ' Existing item',
    '', '## Decisions', '',
  ].join('\n');
});
afterAll(async () => { if (fixture.root) await rm(fixture.root, { recursive: true, force: true }); });

describe('plan anchor handler unit contracts', () => {
  it('adds an unlinked code item and returns its explicit no-links warning', async () => {
    const result = data(await add());
    expect(result.ok).toBe(true);
    expect(result.results[0]).toMatchObject({
      ok: true, itemId: 'P-002',
      warnings: ['This code plan item has no code links; add symbols or paths as anchors.'],
    });
    expect(fixture.body).toContain('Added item');
    expect(fixture.links.size).toBe(0);
  });

  it('adds an unlinked general item without a code-link warning', async () => {
    fixture.profile = 'general';
    const result = data(await add());
    expect(result.ok).toBe(true);
    expect(result.results[0]).toMatchObject({ ok: true, itemId: 'P-002' });
    expect(result.results[0]).not.toHaveProperty('warnings');
    expect(fixture.body).toContain('Added item');
    expect(fixture.links.size).toBe(0);
  });

  it('item-edit and add preserve the same resolved symbol metadata at the storage boundary', async () => {
    const edited = data(await editTool.handler({
      slug, harness: scope.harnessSlug, itemId: 'P-001', anchors: [{ symbol: 'linked' }],
    } as never, ctx()));
    expect(edited.ok, JSON.stringify(edited)).toBe(true);
    const added = data(await add({ anchors: [{ symbol: 'linked' }] })).results[0];
    expect(added.ok).toBe(true);
    const expected = {
      symbolId: 'fixture:linked', symbolName: 'linked', path: 'code.ts',
      signature: 'linked()', contentHash: sha('export function linked() { return 1; }'),
      consumers: [{ path: 'flow.test.ts', line: 2 }], consumersTotal: 1,
      tests: ['flow.test.ts'], resolution: 'resolved',
    };
    expect(edited.anchors).toEqual([expect.objectContaining(expected)]);
    expect(added.anchors).toEqual([expect.objectContaining(expected)]);
    expect(fixture.links.get('P-001')).toEqual(edited.anchors);
    expect(fixture.links.get(added.itemId)).toEqual(edited.anchors);
  });
});
