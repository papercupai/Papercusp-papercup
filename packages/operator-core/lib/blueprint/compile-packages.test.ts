import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  compileAgentSpecification, loadBlueprintFromFile, pinPackageInput,
  pinnedOperationProgramBlueprint, pinnedOperationRubricPackage,
  replayAgentSpecification, resolveBlueprint,
  type ResolvedPackageInput,
} from '@papercusp/orchestrator/blueprint';
import {
  compileBlueprintWithPackages, provisionBlueprintPackages,
  resolveBlueprintPackageInputs as resolveCurrentBlueprintPackageInputs, resolveLocalBlueprintPackage,
} from './compile-packages';
vi.mock('../memory/hive-scope', () => ({ resolvePotSlugsForHarnesses: vi.fn(async () => ['parent-pot']) }));
vi.mock('../hive-settings-store', () => ({ getHiveSetting: vi.fn(async () => ({ value: ['research'] })) }));

// Reuse the standard copy-out mutation probe without changing the shared compiler.
const resolveBlueprintPackageInputs: typeof resolveCurrentBlueprintPackageInputs = process.env.PAPERCUSP_MUTATION_PROBE_SOURCE
  ? (await import(pathToFileURL(process.env.PAPERCUSP_MUTATION_PROBE_SOURCE).href)).resolveBlueprintPackageInputs
  : resolveCurrentBlueprintPackageInputs;

const pin = (ref: string, packageKind: 'recipe' | 'rubric' | 'knowledge-pack' = 'recipe') => pinPackageInput({
  packageKind, ref, revision: '1.0.0', files: [{ path: 'manifest.json', bytes: ref }],
  // A recipe carries the shape readRecipeDir emits; compile refuses anything less.
  value: packageKind === 'recipe'
    ? { id: ref, title: ref, description: '', script: 'return 1', toolsUsed: [], tags: [] }
    : { id: ref, script: 'return 1', criteria: [{ id: 'correct' }] },
});
const reference = ({ packageKind, ref, revision, contentHash }: ResolvedPackageInput) =>
  ({ packageKind, ref, revision, contentHash });
const blueprint = (bundles: { kind: string; ref: string; version?: string }[]) => resolveBlueprint({
  id: 'bundle-fixture', bundles,
  workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } },
  knobs: { aiBackend: { default: { engine: 'loop', model: 'fixture-model' } } },
});

describe('P-006 operator package adapter', () => {
  it('pins an external operation program from the installed blueprint resolver', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'operation-program-'));
    const file = join(dir, 'blueprint.yaml');
    try {
      writeFileSync(file, [
        'id: external-program', 'version: 1.0.0', 'workItem:', '  kind: feature',
        'spine:', '  steps:', '    - id: aggregate', '      op: vote:aggregate',
        '      args:', '        posts: []', '',
      ].join('\n'));
      const external = loadBlueprintFromFile(file);
      const owner = resolveBlueprint({
        id: 'program-owner', version: '1.0.0', workItem: { kind: 'feature' },
        spine: { steps: [{ id: 'aggregate', op: 'vote:aggregate', args: { posts: [] } }] },
        operations: [{
          id: 'run', version: '1.0.0', target: { kind: 'work-item', itemKind: 'feature' },
          execution: { kind: 'program', blueprint: { kind: 'blueprint',
            ref: external.blueprint.id, revision: external.blueprint.version,
            contentHash: external.contentHash } },
          inputSchema: { type: 'object' }, acceptance: { resultSchema: { type: 'object' } },
        }],
      });
      expect(() => compileAgentSpecification({ source: owner }))
        .toThrow('external program blueprint has no retained package');
      const artifact = await compileBlueprintWithPackages(owner, {
        workspaceId: 'workspace-a', harnessSlug: 'harness-a',
        resolve: (id) => id === external.blueprint.id ? file : null,
      });
      const operation = artifact.configuration.operations?.[0];
      expect(operation).toBeDefined();
      expect(pinnedOperationProgramBlueprint(operation!, artifact.inputs)).toEqual(external.blueprint);
      expect(replayAgentSpecification(artifact).specificationRevision).toBe(artifact.specificationRevision);
      const pin = artifact.inputs.find((entry) => entry.kind === 'package' &&
        entry.packageKind === 'blueprint' && entry.ref === 'operation:external-program');
      expect(pin).toMatchObject({ revision: '1.0.0', value: { id: 'external-program' } });

      writeFileSync(file, [
        'id: external-program', 'version: 2.0.0', 'workItem:', '  kind: feature',
        'spine:', '  steps:', '    - id: changed', '      op: vote:aggregate',
        '      args:', '        posts: []', '',
      ].join('\n'));
      expect(pinnedOperationProgramBlueprint(operation!, artifact.inputs)).toEqual(external.blueprint);
      await expect(compileBlueprintWithPackages(owner, {
        workspaceId: 'workspace-a', harnessSlug: 'harness-a',
        resolve: (id) => id === external.blueprint.id ? file : null,
      })).rejects.toThrow('differs from its declared version or resolved content hash');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves an operation acceptance rubric into the same immutable closure', async () => {
    const rubric = pinPackageInput({
      packageKind: 'rubric', ref: 'judge', revision: '1.0.0', files: [], dependencies: [],
      value: { rubricId: 'judge', characteristic: 'quality', description: 'review',
        methodRef: null, ratingScale: ['pass', 'fail'], criteria: [{ key: 'complete',
          title: 'Complete', model: 'All required work is present', method: 'Review output', driftMarkers: 'Missing work' }] },
    });
    const source = resolveBlueprint({
      id: 'rubric-owner', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } },
      roles: [{ id: 'worker' }],
      operations: [{
        id: 'review', version: '1', target: { kind: 'work-item', itemKind: 'feature' },
        execution: { kind: 'agent', role: 'worker' },
        policy: { identity: {
          kind: 'identity', ref: 'rubric-worker', revision: '1.0.0', contentHash: 'b'.repeat(64),
        } },
        inputSchema: { type: 'object' }, acceptance: { resultSchema: { type: 'object' }, rubric: {
          kind: 'rubric', ref: 'judge', revision: rubric.revision, contentHash: rubric.contentHash,
        } },
      }],
    });
    const resolvePackage = vi.fn(async ({ ref }: { ref: string }) => ref === 'judge' ? rubric : null);
    const specification = await compileBlueprintWithPackages(source, {
      workspaceId: 'workspace-a', harnessSlug: 'harness-a', resolvePackage,
    });
    expect(resolvePackage).toHaveBeenCalledTimes(1);
    expect(specification.configuration.operations![0].policy.identity)
      .toMatchObject({ ref: 'rubric-worker', revision: '1.0.0', contentHash: 'b'.repeat(64) });
    expect(pinnedOperationRubricPackage(specification.configuration.operations![0], specification.inputs))
      .toMatchObject({ ref: 'judge', contentHash: rubric.contentHash });
    expect(replayAgentSpecification(specification).specificationRevision).toBe(specification.specificationRevision);
    await expect(compileBlueprintWithPackages(source, {
      workspaceId: 'workspace-a', harnessSlug: 'harness-a', resolvePackage: async () =>
        pinPackageInput({ packageKind: 'rubric', ref: 'judge', revision: '1.0.0', files: [], dependencies: [],
          value: { ...rubric.value as Record<string, unknown>, description: 'changed' } }),
    })).rejects.toThrow('rubric differs from its declared version or content hash');
  });

  it('resolves a transitive diamond once and retains every exact content pin', async () => {
    const leaf = pin('leaf');
    const parent = pinPackageInput({ packageKind: 'rubric', ref: 'parent', revision: '1', files: [], dependencies: [reference(leaf)] });
    const resolver = vi.fn(async ({ ref }: { ref: string }) => ref === 'leaf' ? leaf : parent);
    const inputs = await resolveBlueprintPackageInputs([
      { kind: 'rubric', ref: 'parent' }, { kind: 'recipe', ref: 'leaf' },
    ], resolver);
    expect(inputs).toEqual([leaf, parent]);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it('refuses cross-root cycles without waiting on another root promise', async () => {
    const a = pinPackageInput({ packageKind: 'recipe', ref: 'a', revision: '1', files: [],
      dependencies: [{ packageKind: 'recipe', ref: 'b', revision: '1', contentHash: 'b'.repeat(64) }] });
    const b = pinPackageInput({ packageKind: 'recipe', ref: 'b', revision: '1', files: [],
      dependencies: [{ packageKind: 'recipe', ref: 'a', revision: '1', contentHash: 'a'.repeat(64) }] });
    await expect(resolveBlueprintPackageInputs([{ kind: 'recipe', ref: 'a' }, { kind: 'recipe', ref: 'b' }],
      async ({ ref }) => ref === 'a' ? a : b)).rejects.toThrow(/cyclic package dependency/);
  });

  it('rejects a version mismatch, absent package and resolver substitution', async () => {
    await expect(resolveBlueprintPackageInputs([{ kind: 'recipe', ref: 'same', version: '2' }],
      async () => pin('same'))).rejects.toThrow(/requires 2, selected 1.0.0/);
    await expect(resolveBlueprintPackageInputs([{ kind: 'recipe', ref: 'absent' }],
      async () => null)).rejects.toThrow(/package-missing/);
    await expect(resolveBlueprintPackageInputs([{ kind: 'recipe', ref: 'wanted' }],
      async () => pin('different'))).rejects.toThrow(/different package/);
  });

  it('compiles scoped bundle assets and leaves engine defaults and mutable mode inputs distinct', async () => {
    const bundles = [{ kind: 'recipe', ref: 'job' }, { kind: 'knowledge-pack', ref: 'facts' }, { kind: 'rubric', ref: 'judge' }];
    const loaded = blueprint(bundles);
    const artifact = await compileBlueprintWithPackages(loaded, {
      workspaceId: 'workspace-a', harnessSlug: 'harness-a',
      resolvePackage: async ({ ref, kind }) => pin(ref, kind as 'recipe' | 'knowledge-pack' | 'rubric'),
      input: { mutableState: { ref: 'mode', revision: 6, value: { auto: false } } },
    });
    expect(artifact.configuration.knobs?.aiBackend?.default?.engine).toBe('loop');
    expect(artifact.inputs).toContainEqual({ kind: 'setting', ref: 'mode', revision: '6', value: { auto: false } });
    expect(artifact.inputs).toContainEqual({ kind: 'setting', ref: 'bundle-scope', revision: '1',
      value: { workspaceId: 'workspace-a', harnessSlug: 'harness-a', memoryTarget: { kind: 'hive', slug: 'parent-pot' },
        knowledgeSelection: { shapes: [], domains: ['research'] } } });
    expect(artifact.inputs.find((entry) => entry.kind === 'package' && entry.packageKind === 'rubric')).toHaveProperty('value.criteria');
    const recipe = vi.fn(async () => {});
    const rubric = vi.fn(async () => {});
    const knowledge = vi.fn(async () => {});
    await provisionBlueprintPackages(artifact, { recipe, rubric, knowledge });
    expect(recipe).toHaveBeenCalledWith(expect.objectContaining({ ref: 'job' }), expect.objectContaining({ workspaceId: 'workspace-a', harnessSlug: 'harness-a' }));
    expect(rubric).toHaveBeenCalledWith(expect.objectContaining({ ref: 'judge' }), expect.objectContaining({ workspaceId: 'workspace-a', harnessSlug: 'harness-a' }));
    expect(knowledge).toHaveBeenCalledWith(expect.objectContaining({ ref: 'facts' }), {
      workspaceId: 'workspace-a', harnessSlug: 'harness-a', memoryTarget: { kind: 'hive', slug: 'parent-pot' },
      knowledgeSelection: { shapes: [], domains: ['research'] },
    });

    const corrupt = JSON.parse(JSON.stringify(artifact));
    corrupt.inputs.find((entry: { kind: string; ref: string }) => entry.kind === 'package' && entry.ref === 'job').value.script = 'corrupt';
    recipe.mockClear(); rubric.mockClear(); knowledge.mockClear();
    await expect(provisionBlueprintPackages(corrupt, { recipe, rubric, knowledge })).rejects.toThrow(/package-hash-mismatch/);
    expect(recipe).not.toHaveBeenCalled();
    expect(rubric).not.toHaveBeenCalled();
    expect(knowledge).not.toHaveBeenCalled();
  });

  it('pins exact pot capability providers and makes rebinding change the specification revision', async () => {
    const loaded = resolveBlueprint({
      id: 'capability-fixture',
      slots: [{ slot: 'domain' }],
      grants: {
        requires: ['crm.email@1.0.0'],
        optional: ['calendar.read@1.0.0'],
      },
      workItem: { kind: 'feature' },
      spine: { edges: { DONE: { to: 'done' } } },
    });
    const binding = (providerVersion: string) => ({
      classRef: 'crm.email@1.0.0',
      providerPackage: 'acme-crm',
      providerVersion,
      verbBindings: { send: 'acme:send-email' },
      conformanceRunId: 'run-' + providerVersion,
      conformanceStatus: 'passed' as const,
      behavioralStatus: 'not-required',
      behavioralRunRef: null,
      registryRevision: 'registry-r1',
      status: 'active',
      updatedAt: '2026-09-07T00:00:00.000Z',
    });
    const compile = (providerVersion: string) => compileBlueprintWithPackages(loaded, {
      workspaceId: 'workspace-a',
      harnessSlug: 'harness-a',
      readGrantCeiling: null,
      resolveCapabilityProvider: async (classRef, potSlug) => {
        expect(potSlug).toBe('parent-pot');
        return classRef === 'crm.email@1.0.0' ? binding(providerVersion) : null;
      },
    });

    const first = await compile('2.0.0');
    expect(first.inputs).toContainEqual({
      kind: 'capability-provider',
      ref: 'crm.email@1.0.0',
      providerPackage: 'acme-crm',
      providerVersion: '2.0.0',
      conformanceRunId: 'run-2.0.0',
      registryRevision: 'registry-r1',
      verbBindings: { send: 'acme:send-email' },
    });
    expect(first.inputs.some(
      (entry) => entry.kind === 'capability-provider' && entry.ref === 'calendar.read@1.0.0',
    )).toBe(false);
    expect((await compile('2.1.0')).specificationRevision).not.toBe(first.specificationRevision);

    await expect(compileBlueprintWithPackages(loaded, {
      workspaceId: 'workspace-a',
      harnessSlug: 'harness-a',
      resolveCapabilityProvider: async () => null,
    })).rejects.toThrow(/required capability class has no active pot provider binding/);
  });

  // P-012 / D-040(d), D-041: a required grant whose tool reach the current pot/role
  // ceiling excludes refuses the launch compile; an optional one, an unreadable
  // ceiling and an empty ceiling set never do (the per-call kernel still denies).
  it('refuses a required grant above the pot/role ceiling and nothing else', async () => {
    const loaded = resolveBlueprint({
      id: 'ceiling-fixture', slots: [{ slot: 'domain' }],
      grants: { requires: ['crm.email@1.0.0'], optional: ['calendar.read@1.0.0'] },
      workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } },
    });
    const binding = (classRef: string, verbBindings: Record<string, string>) => ({
      classRef, providerPackage: 'acme', providerVersion: '1.0.0', verbBindings,
      conformanceRunId: 'run-1', conformanceStatus: 'passed' as const, behavioralStatus: 'not-required',
      behavioralRunRef: null, registryRevision: 'registry-r1', status: 'active', updatedAt: '2026-09-30T00:00:00.000Z',
    });
    const bindings: Record<string, ReturnType<typeof binding>> = {
      'crm.email@1.0.0': binding('crm.email@1.0.0', { send: 'acme:send-email' }),
      'calendar.read@1.0.0': binding('calendar.read@1.0.0', { read: 'acme:read-calendar' }),
    };
    const tools = new Map([['acme:send-email', ['email:send']], ['acme:read-calendar', ['calendar:read']]]);
    const policy = (allowCapabilities: string[]) => ({ ceilings: [{ allowCapabilities }], tools, protectedAdditions: [] });
    const compile = (readGrantCeiling: NonNullable<Parameters<typeof compileBlueprintWithPackages>[1]['readGrantCeiling']>) =>
      compileBlueprintWithPackages(loaded, {
        workspaceId: 'workspace-a', harnessSlug: 'harness-a', role: 'worker', readGrantCeiling,
        resolveCapabilityProvider: async (classRef) => bindings[classRef] ?? null,
      });

    const outside = vi.fn(async () => policy(['calendar:*']));
    await expect(compile(outside)).rejects.toThrow(
      'required capability class exceeds the pot/role ceiling: acme:send-email is outside-ceiling');
    // Only required classes are evaluated, against the launching role's ceiling.
    expect(outside).toHaveBeenCalledWith({
      workspaceId: 'workspace-a', harnessSlug: 'harness-a', role: 'worker', classRefs: ['crm.email@1.0.0'],
    });
    await expect(compile(async () => ({ ...policy(['email:*']), tools: new Map() })))
      .rejects.toThrow('acme:send-email is tool-unavailable');

    // The optional class sits outside this ceiling; it grants nothing but never refuses.
    const artifact = await compile(async () => policy(['email:*']));
    expect(artifact.inputs).toContainEqual(expect.objectContaining({ kind: 'capability-provider', ref: 'crm.email@1.0.0' }));
    await expect(compile(async () => { throw new Error('identity grant target role is ambiguous'); })).resolves.toBeDefined();
    await expect(compile(async () => ({ ceilings: [], tools, protectedAdditions: [] }))).resolves.toBeDefined();
  });

  // P-011 / D-023: a worn sync context rule binds through the contribution
  // resolver and has no optional form — a provider that cannot serve it inline
  // refuses the compile instead of omitting on every turn.
  it('binds a sync context rule provider and refuses one that cannot run inline', async () => {
    const loaded = blueprint([{ kind: 'rule', ref: 'recall-at-turn' }]);
    const context = { ref: 'memory.recall@1', verb: 'recall', tokenBudget: 400, priority: 10, overBudget: 'truncate' };
    const resolvePackage = async () => pinPackageInput({
      packageKind: 'rule', ref: 'recall-at-turn', revision: '1.0.0', files: [{ path: 'rule.json', bytes: 'r' }],
      value: { id: 'recall-at-turn', delivery: 'sync', sink: 'turn-start', context },
    });
    const resolution = (providerKind: string, latencyClass: string) => ({
      ok: true as const, requestedClassRef: 'memory.recall@1', classRef: 'memory.recall@1.2.0', verb: 'recall',
      contract: { inputSchema: {}, outputSchema: { type: 'object' } },
      provider: {
        classRef: 'memory.recall@1.2.0', providerPackage: 'acme-recall', providerVersion: '1.0.0',
        verbBindings: { recall: 'acme:recall' }, conformanceRunId: 'run-1', registryRevision: 'registry-r1',
        providerKind, latencyClass,
      },
    }) as never;
    const compile = (resolveContextCapability: Parameters<typeof compileBlueprintWithPackages>[1]['resolveContextCapability']) =>
      compileBlueprintWithPackages(loaded, { workspaceId: 'workspace-a', harnessSlug: 'harness-a', resolvePackage, resolveContextCapability });

    const requests: unknown[] = [];
    const artifact = await compile(async (request) => { requests.push(request); return resolution('tool', 'sync'); });
    expect(requests).toEqual([{ potSlug: 'parent-pot', classRef: 'memory.recall@1', verb: 'recall' }]);
    expect(artifact.inputs).toContainEqual(expect.objectContaining({
      kind: 'capability-provider', ref: 'memory.recall@1.2.0', providerPackage: 'acme-recall',
      context: expect.objectContaining({ requestedRef: 'memory.recall@1', verb: 'recall', latencyClass: 'sync' }),
    }));

    await expect(compile(async () => resolution('operation', 'sync'))).rejects.toThrow(/synchronous tool or recipe/);
    await expect(compile(async () => resolution('tool', 'async'))).rejects.toThrow(/synchronous tool or recipe/);
    await expect(compile(async () => ({ ok: false, requestedClassRef: 'memory.recall@1', code: 'class-unbound' })))
      .rejects.toThrow('sync rule recall-at-turn context memory.recall@1#recall cannot bind: class-unbound');
  });

  it('pins and provisions the existing seed-pack declaration with explicit replayable selection', async () => {
    const loaded = resolveBlueprint({ id: 'seed-fixture', knowledge: { pack: 'facts' },
      workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } });
    const compile = (domains: string[]) => compileBlueprintWithPackages(loaded, { workspaceId: 'w', harnessSlug: 'h',
      memoryTarget: { kind: 'harness', slug: 'h' }, knowledgeSelection: { shapes: ['ui'], domains },
      resolvePackage: async () => pin('facts', 'knowledge-pack') });
    const artifact = await compile(['research']);
    const root = artifact.inputs.find((entry) => entry.kind === 'package' && entry.ref === 'seed-fixture');
    expect(root).toHaveProperty('dependencies', [expect.objectContaining({ packageKind: 'knowledge-pack', ref: 'facts' })]);
    const knowledge = vi.fn(async () => {});
    await provisionBlueprintPackages(artifact, { recipe: vi.fn(), rubric: vi.fn(), knowledge });
    expect(knowledge).toHaveBeenCalledWith(expect.objectContaining({ ref: 'facts' }), expect.objectContaining({
      memoryTarget: { kind: 'harness', slug: 'h' }, knowledgeSelection: { shapes: ['ui'], domains: ['research'] },
    }));
    expect((await compile([])).specificationRevision).not.toBe(artifact.specificationRevision);
  });

  it('refuses schema-valid bundle kinds that have no installed consumer instead of only naming them', async () => {
    for (const kind of ['plan', 'goal', 'datatype'] as const) {
      const source = { id: `unsupported-${kind}`, slots: [{ slot: 'domain' }],
        bundles: [{ kind, ref: `selected-${kind}` }] };
      await expect(compileBlueprintWithPackages(source, {
        workspaceId: 'workspace-a', harnessSlug: 'harness-a',
      })).rejects.toThrow(`no installed content resolver for package kind ${kind}`);
    }
  });

  it('uses the default local stores and preserves precedence, exact files and version errors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'blueprint-local-packages-'));
    const put = (relative: string, bytes: string) => {
      const path = join(root, relative);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, bytes);
    };
    vi.stubEnv('PAPERCUSP_HOME', join(root, 'home'));
    vi.stubEnv('PAPERCUSP_RECIPES_DIR', join(root, 'recipes'));
    vi.stubEnv('PAPERCUSP_RUBRICS_DIR', join(root, 'rubrics'));
    vi.stubEnv('PAPERCUSP_HARNESS_DIR', join(root, 'harness'));
    try {
      put('recipes/p006-recipe/recipe.json', JSON.stringify({ id: 'p006-recipe', title: 'Bundled', script: 'return 0' }));
      put('home/recipes/p006-recipe/recipe.json', JSON.stringify({ id: 'p006-recipe', title: 'Installed', script: 'return 1' }));
      put('home/recipes/p006-recipe/listing.json', JSON.stringify({ version: '2.0.0' }));
      put('rubrics/p006-rubric/rubric.json', JSON.stringify({ rubricId: 'p006-rubric', title: 'Rubric', version: '1.0.0',
        characteristic: 'correctness', ratingScale: ['fail', 'pass'],
        criteria: [{ key: 'correct', title: 'Correct', model: 'binary', method: 'check', driftMarkers: 'changed' }] }));
      put('harness/knowledge-packs/p006-facts/manifest.yaml', 'id: p006-facts\ntitle: Facts\ndescription: fixture\nversion: 1.0.0\n');
      put('harness/knowledge-packs/p006-facts/fact.md', '---\nid: fact\ntitle: Fact\n---\nPinned knowledge.\n');
      const requests = [{ kind: 'recipe', ref: 'p006-recipe', version: '2.0.0' },
        { kind: 'rubric', ref: 'p006-rubric' }, { kind: 'knowledge-pack', ref: 'p006-facts' }];
      const inputs = await resolveBlueprintPackageInputs(requests);
      const recipe = inputs.find((entry) => entry.packageKind === 'recipe')!;
      expect(recipe.value).toMatchObject({ title: 'Installed', script: 'return 1' });
      expect(inputs.find((entry) => entry.packageKind === 'rubric')?.value).toHaveProperty('criteria');
      const knowledge = inputs.find((entry) => entry.packageKind === 'knowledge-pack')!;
      expect(knowledge.files.map((file) => file.path)).toContain('fact.md');
      expect(knowledge.value).toHaveProperty('items.0.text', 'Pinned knowledge.');
      expect(inputs.every((entry) => entry.dependencies.length === 0)).toBe(true);
      put('home/recipes/p006-recipe/notes.md', 'content beyond the manifest');
      expect((await resolveLocalBlueprintPackage(requests[0]!))?.contentHash).not.toBe(recipe.contentHash);
      await expect(resolveBlueprintPackageInputs([{ ...requests[0]!, version: '3.0.0' }])).rejects.toThrow(/requires 3.0.0/);
      expect(await resolveLocalBlueprintPackage({ kind: 'recipe', ref: 'p006-absent' })).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
