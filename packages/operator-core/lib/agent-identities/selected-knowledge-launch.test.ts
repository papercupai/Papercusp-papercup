import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyMergeRule,
  mergeRuleFor,
  RECALL_CORPORA,
  RecallSchema,
  replayAgentSpecification,
} from '@papercusp/orchestrator/blueprint';
import { compileLaunchSpecificationArtifact, provisionLaunchIdentityResources } from '../role-launch-spec';
import * as recallStats from '../memory/recall-stats';
import * as corpusRecallIo from '../memory/corpus-recall-io';
import * as recallStaleness from '../memory/recall-staleness';
import { buildMemoryContextBlock } from '../memory/injection';
import { setSessionConfinementResolver } from '../capability-envelope/session-confinement-port';
import { _resetForTests as resetSurfacedForTests } from '../memory/bump-last-surfaced';
import { identityRecallPolicy, type IdentityRecallPolicy } from './identity-recall';

const memory = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; text: string; scope: string; metadata: Record<string, unknown> }>,
  /** Recallable rows, in relevance order; the fake honours scope and the shared limit like the hybrid backend. */
  recallRows: [] as Array<{ id: string; text: string; scope: string }>,
  searches: [] as Array<{ scopes: string[]; limit: number | undefined }>,
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: async () => [] }),
}));
vi.mock('../memory/hive-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../memory/hive-scope')>()),
  resolvePotSlugsForHarnesses: vi.fn(async () => ['sales']),
}));
vi.mock('../memory/backend', () => ({
  getMemoryBackend: () => ({
    name: 'fake',
    available: async () => ({ ok: true }),
    list: async ({ scope }: { scope: string }) => memory.rows.filter((row) => row.scope === scope),
    search: async (_query: string, opts: { scope: string | readonly string[]; limit?: number }) => {
      const scopes = typeof opts.scope === 'string' ? [opts.scope] : [...opts.scope];
      memory.searches.push({ scopes, limit: opts.limit });
      const hits = memory.recallRows.filter((row) => scopes.includes(row.scope));
      return opts.limit ? hits.slice(0, opts.limit) : hits;
    },
    remember: async (text: string, options: { scope: string; metadata: Record<string, unknown> }) => {
      const id = `memory-${memory.rows.length + 1}`;
      memory.rows.push({ id, text, scope: options.scope, metadata: options.metadata });
      return { ids: [id] };
    },
    forget: async (id: string) => {
      memory.rows = memory.rows.filter((row) => row.id !== id);
    },
  }),
}));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));
vi.mock('../memory/jev-settings', () => ({
  JEV_MEMORY_TIMEOUT_MS: 800,
  getJevMode: vi.fn(async () => 'off'),
  resolveJevMemoryInjection: vi.fn(async () => ({ mode: 'off', keyPresent: false, effective: 'off' })),
  ensureJevDecisionClient: vi.fn(),
}));
// Coverage unknown ⇒ the corpus gate fails open, exactly as with no coverage surface.
vi.mock('../search/coverage-gate', () => ({
  loadCoverageSnapshotCached: vi.fn(async () => new Map()),
  assessSearchCoverage: vi.fn(() => {
    throw new Error('coverage not stubbed');
  }),
}));

describe('selected identity knowledge at launch', () => {
  it('installs exact pinned content in the existing memory pool and refuses a changed pack without review', async () => {
    const root = mkdtempSync(join(tmpdir(), 'selected-knowledge-launch-'));
    const identityId = 'knowledge-domain';
    const packId = 'selected-mail-facts';
    const identityDir = join(root, '.papercusp', 'blueprints', identityId);
    const packDir = join(root, 'home', 'knowledge-packs', packId);
    memory.rows = [];
    try {
      mkdirSync(identityDir, { recursive: true });
      mkdirSync(packDir, { recursive: true });
      vi.stubEnv('PAPERCUSP_HOME', join(root, 'home'));
      writeFileSync(join(identityDir, 'blueprint.yaml'), stringifyYaml({
        id: identityId, extends: 'base', version: '1.0.0', slots: [{ slot: 'domain' }],
        knowledge: { pack: packId },
      }));
      writeFileSync(join(packDir, 'manifest.yaml'),
        `id: ${packId}\ntitle: Selected facts\ndescription: Selected launch knowledge.\nversion: 1.0.0\n`);
      const factFile = join(packDir, 'mail.md');
      writeFileSync(factFile, '---\nid: mail\ntitle: Mail rule\nkind: reference\napplies_to: [any]\n---\n\nUse the selected mail rule.\n');

      const compile = () => compileLaunchSpecificationArtifact({
        promptText: 'Mail worker.', cwd: root, workspaceId: 'workspace-a',
        harnessSlug: 'harness-a', role: 'worker', stack: [`domain:${identityId}`],
        state: { schemaVersion: 1 },
      });
      const launch = await compile();
      expect(launch.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
        kind: 'package', packageKind: 'knowledge-pack', ref: packId,
      }));
      expect((await compile()).specificationRevision).toBe(launch.specificationRevision);
      const replayed = replayAgentSpecification(JSON.parse(JSON.stringify(launch.specificationArtifact)));
      expect(replayed.specificationRevision).toBe(launch.specificationRevision);
      expect(replayed.inputs).toContainEqual(expect.objectContaining({
        kind: 'package', packageKind: 'knowledge-pack', ref: packId,
        value: expect.objectContaining({ items: [expect.objectContaining({
          id: 'mail', text: 'Use the selected mail rule.',
        })] }),
      }));
      expect(launch.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
        kind: 'setting', ref: 'bundle-scope',
        value: expect.objectContaining({ memoryTarget: { kind: 'hive', slug: 'sales' },
          knowledgeSelection: { shapes: [], domains: [] } }),
      }));
      await provisionLaunchIdentityResources(launch, {} as never);
      expect(memory.rows).toHaveLength(1);
      expect(memory.rows[0]).toMatchObject({
        scope: 'hive:sales', text: 'Mail rule — Use the selected mail rule.',
        metadata: { workspace_id: 'workspace-a', source: 'pack', pack_id: packId,
          pack_version: '1.0.0', pack_item_id: 'mail' },
      });
      await provisionLaunchIdentityResources(launch, {} as never);
      expect(memory.rows).toHaveLength(1);

      writeFileSync(factFile, '---\nid: mail\ntitle: Mail rule\nkind: reference\napplies_to: [any]\n---\n\nChanged mail rule.\n');
      const changed = await compile();
      expect(changed.specificationRevision).not.toBe(launch.specificationRevision);
      expect(replayAgentSpecification(JSON.parse(JSON.stringify(launch.specificationArtifact))))
        .toEqual(replayed);
      await expect(provisionLaunchIdentityResources(changed, {} as never))
        .rejects.toThrow(/knowledge pack conflicts with scoped memory/);
      expect(memory.rows).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      memory.rows = [];
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * identity-system-everything-migration-2026-10-18 P-012: R-9 (budget share),
 * R-17 (memory scope) and R-18 (knowledge corpora) at turn start. The bounds
 * travel the real path: identity document → compiled launch artifact → replayed
 * configuration → the turn-start recall builder.
 */
describe('identity-declared recall bounds at turn start (P-012)', () => {
  const NOTES = ['amber', 'birch', 'cedar', 'delta', 'ember', 'fjord', 'grove', 'haven'];
  const POOLS = [['user', 'user-1'], ['harness', 'harness:harness-a'], ['hive', 'hive:sales']] as const;
  let root = '';
  let corpusInputs: corpusRecallIo.CorpusRecallInput[] = [];

  beforeEach(() => {
    // These synthetic notes have no anchor history. Keep unrelated advisory
    // staleness I/O out of the recall parity and identity-bound assertions.
    vi.stubEnv('PAPERCUSP_FLAG_PAPERCUSP_MEMORY_STALENESS_IN_RECALL', '0');
    root = mkdtempSync(join(tmpdir(), 'identity-recall-launch-'));
    setSessionConfinementResolver(() => null);
    vi.spyOn(recallStats, 'recordRecallStats').mockImplementation(async () => {});
    corpusInputs = [];
    vi.spyOn(corpusRecallIo, 'recallCorpusContext').mockImplementation(async (input) => {
      corpusInputs.push(input);
      return { outcome: 'disabled', rerank: 'nothing-to-reorder', legs: null, retrievalDepth: 0,
        hits: [], lines: [], drops: [], block: null } as unknown as corpusRecallIo.CorpusRecallResult;
    });
    resetSurfacedForTests();
    memory.searches = [];
    // Eight distinct notes per pool, interleaved so every pool ranks throughout.
    memory.recallRows = NOTES.flatMap((note, i) => POOLS.map(([pool, scope]) => ({
      id: `${pool}-${i}`, text: `Recall ${pool} note ${i} ${note}`, scope,
    })));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setSessionConfinementResolver(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  const writeIdentity = (id: string, recall?: Record<string, unknown>): void => {
    const dir = join(root, '.papercusp', 'blueprints', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'blueprint.yaml'), stringifyYaml({
      id, extends: 'base', version: '1.0.0', slots: [{ slot: 'domain' }], ...(recall ? { recall } : {}),
    }));
  };
  const compileFor = (id: string) => compileLaunchSpecificationArtifact({
    promptText: 'Recall worker.', cwd: root, workspaceId: 'workspace-a',
    harnessSlug: 'harness-a', role: 'worker', stack: [`domain:${id}`], state: { schemaVersion: 1 },
  });
  /** What a wearer of `id` recalls under: the replayed (applied) artifact's declaration. */
  const appliedRecall = async (id: string): Promise<IdentityRecallPolicy | null> => {
    const launch = await compileFor(id);
    return identityRecallPolicy(replayAgentSpecification(JSON.parse(JSON.stringify(launch.specificationArtifact)))
      .configuration as { recall?: unknown });
  };
  const turnStartRecall = (identityRecall: IdentityRecallPolicy | null) => buildMemoryContextBlock({
    userId: 'user-1', workspaceId: 'workspace-a', harnessSlugs: ['harness-a'],
    queryContext: 'which recall note applies here', identityRecall,
  });
  const recalledPools = (block: string | null): string[] =>
    [...(block ?? '').matchAll(/Recall (user|harness|hive) note \d/g)].map((match) => match[1]!);

  it('R-9/R-17/R-18: a declared share, scope and corpus bound turn-start recall; an undeclared identity recalls as before', async () => {
    writeIdentity('recall-open');
    writeIdentity('recall-scoped', { budgetShare: 0.25, memoryScopes: ['hive'], corpora: ['doc'] });
    const open = await appliedRecall('recall-open');
    const scoped = await appliedRecall('recall-scoped');
    expect(open).toBeNull();
    expect(scoped).toEqual({ budgetShare: 0.25, memoryScopes: ['hive'], corpora: ['doc'] });

    // Undeclared: the pre-P-012 recall — every pool, the full ceiling, every corpus.
    const before = await buildMemoryContextBlock({
      userId: 'user-1', workspaceId: 'workspace-a', harnessSlugs: ['harness-a'],
      queryContext: 'which recall note applies here',
    });
    const openBlock = await turnStartRecall(open);
    expect(openBlock).toBe(before);
    expect(memory.searches.at(-1)).toEqual({ scopes: ['user-1', 'harness:harness-a', 'hive:sales'], limit: 12 });
    expect(memory.searches.at(-2)).toEqual(memory.searches.at(-1));
    expect(new Set(recalledPools(openBlock))).toEqual(new Set(['user', 'harness', 'hive']));
    expect(recalledPools(openBlock).length).toBeGreaterThan(3);
    expect(corpusInputs.at(-1)?.corpora).toBeUndefined();

    // Declared: only the hive pool is searched (R-17), a quarter of the ceiling (R-9),
    // and the corpus leg is handed only the declared corpus (R-18).
    const scopedBlock = await turnStartRecall(scoped);
    expect(memory.searches.at(-1)).toEqual({ scopes: ['hive:sales'], limit: 3 });
    const scopedPools = recalledPools(scopedBlock);
    expect(scopedPools.length).toBeGreaterThan(0);
    expect(scopedPools.length).toBeLessThanOrEqual(3);
    expect(scopedPools.every((pool) => pool === 'hive')).toBe(true);
    expect(scopedBlock).not.toMatch(/Recall (user|harness) note/);
    expect(corpusInputs.at(-1)?.corpora).toEqual(['doc']);
  });

  it('keeps recall fixtures independent of unavailable advisory staleness storage', async () => {
    const lookup = vi.spyOn(recallStaleness, 'loadMemoryStaleness')
      .mockRejectedValue(new Error('staleness storage unavailable'));
    writeIdentity('recall-fixture');
    const open = await appliedRecall('recall-fixture');

    expect(await turnStartRecall(open)).toContain('Recall user note');
    expect(lookup).not.toHaveBeenCalled();

    // Positive control: the same production path reaches the unavailable
    // storage when the unrelated advisory is explicitly enabled.
    vi.stubEnv('PAPERCUSP_FLAG_PAPERCUSP_MEMORY_STALENESS_IN_RECALL', '1');
    expect(await turnStartRecall(open)).toContain('Recall user note');
    expect(lookup).toHaveBeenCalled();
  });

  it('R-18: an undeclared corpus is never selected, and the declarable set is exactly the corpus sources', () => {
    expect([...RECALL_CORPORA]).toEqual([...corpusRecallIo.CORPUS_SOURCE_NAMES]);
    expect(corpusRecallIo.corpusSourceNamesFor({})).toEqual([...corpusRecallIo.CORPUS_SOURCE_NAMES]);
    expect(corpusRecallIo.corpusSourceNamesFor({ corpora: ['doc'] })).toEqual(['doc']);
    expect(corpusRecallIo.corpusSourceNamesFor({ corpora: ['doc', 'work_item'], knowledgeSourcesAllowed: false }))
      .toEqual(['work_item']);
    expect(corpusRecallIo.corpusSourceNamesFor({ corpora: [] })).toEqual([]);
  });

  it('refuses an identity that declares the Personal Vault as a corpus (D-008)', async () => {
    expect(RecallSchema.safeParse({ corpora: ['personal-vault'] }).success).toBe(false);
    writeIdentity('recall-vault', { corpora: ['personal-vault'] });
    await expect(compileFor('recall-vault')).rejects.toThrow();
  });

  it('composes restriction-only down a stack: min share, intersected scopes and corpora', () => {
    const compose = (path: string, base: unknown, child: unknown) => applyMergeRule(mergeRuleFor(path)!, base, child, path);
    expect(compose('recall.budgetShare', 0.5, 0.25)).toBe(0.25);
    expect(compose('recall.budgetShare', 0.25, 1)).toBe(0.25);
    expect(compose('recall.memoryScopes', ['user', 'hive'], ['hive', 'harness'])).toEqual(['hive']);
    expect(compose('recall.corpora', ['doc', 'plan'], ['plan', 'report'])).toEqual(['plan']);
  });
});
