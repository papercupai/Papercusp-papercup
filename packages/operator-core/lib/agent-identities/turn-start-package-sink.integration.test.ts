/** portable-identity-packages P-010 / PORTABLE-P-010@1 — the turn-start sink
 * invocation over REAL control-anchor rows, the REAL identity source catalog, the
 * REAL capability-class registry and the REAL output validator. Only the final
 * read-only tool dispatch is replaced (there is no projected tool to run here).
 *
 * Normal case: every due contribution of every worn identity shares ONE sink
 * budget and ONE per-turn ceiling. Counterexample (the falsifier): adding
 * providers never multiplies the allowance, a result evaluated against an
 * attachment the wearer has left never renders, and a provider that cannot
 * resolve is a visible omission, never silence. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { Sql } from 'postgres';
import { layerContentHash } from '@papercusp/orchestrator/blueprint';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { ProjectedTool, WrapDispatch } from '@papercusp/tooldef';
import type { SavedRecipeAdapter } from '../agent-tools/orchestration/saved-recipe-adapter';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { DEFAULT_SINK_HOST_LIMITS, resetSinkEvaluatorForTests } from './sink-evaluator';
import { projectPackageOrientationRows } from './package-orientation-classes';
import { inspectIdentityRecipeClassProvider } from './recipe-provider-conformance';
import { identityWearerRole } from './wearer-authority';
import {
  PACKAGE_SINK_SPAWN_ID,
  defaultTurnStartPackageSinkDeps,
  evaluateTurnStartPackageSink,
  packageSinkReceipt,
  resolvePackageSinkRecipeWearer,
} from './turn-start-package-sink';

const pg = vi.hoisted(() => ({ sql: null as Sql | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: pg.sql }),
}));
const dispatch = vi.hoisted(() => ({
  calls: [] as Array<{ tool: string; env: { role: string; spawnId: string; signal?: AbortSignal } }>,
  impl: null as null | ((tool: string) => Promise<unknown>),
}));
vi.mock('../events/await/predicate-watch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../events/await/predicate-watch')>()),
  dispatchReadOnlyTool: async (tool: string, _args: unknown, env: { role: string; spawnId: string; signal?: AbortSignal }) => {
    dispatch.calls.push({ tool, env });
    return dispatch.impl!(tool);
  },
}));

const WS = 'pkg-sink-ws';
const POT = 'pkg-sink-pot';
const NOTES_SCHEMA = {
  type: 'object', properties: { notes: { type: 'string' } }, required: ['notes'], additionalProperties: false,
};
const APPLIED = { specificationRevision: 'spec-1', stateRevision: 'state-1' };
// The default TOKEN budgets, with a wall clock that cold module loads and fleet
// load cannot hit: these cases measure allocation and fencing, not the deadline
// (sink-evaluator.integration.test.ts owns the deadline cases).
const LIMITS = {
  ...DEFAULT_SINK_HOST_LIMITS,
  sinkBudget: { tokens: DEFAULT_SINK_HOST_LIMITS.sinkBudget.tokens, wallClockMs: 15_000 },
  turnCeiling: { tokens: DEFAULT_SINK_HOST_LIMITS.turnCeiling.tokens, wallClockMs: 30_000 },
};

// A real read-only tool and a saved recipe over it. The recipe provider's
// evidence comes from the canonical inspector, never hand-written.
const RECIPE_REVISION = 'a'.repeat(64);
const readNotes = vi.fn(async () => ({ notes: 'from the recipe' }));
const notesTool: ProjectedTool = { pluginName: 'notes-plugin', description: 'read notes', effect: 'read',
  expose: { mcp: { name: 'notes:read' } }, capabilities: ['notes:read'], inputSchema: {},
  fn: readNotes as unknown as ProjectedTool['fn'] };
const recipes: SavedRecipeAdapter = { inspect: vi.fn(async () => ({ ok: true as const,
  recipe: { id: 'notes-recipe:read', script: 'return tools.notes.read({});' },
  continuation: { id: 'notes-recipe:read', revision: RECIPE_REVISION, authority: { version: 1 as const,
    revision: RECIPE_REVISION, refs: { workspaces: [], fleets: [], plans: [], harnesses: [], items: [], resources: [] },
    requiresContext: false, runnable: true } } })), run: vi.fn(), search: vi.fn() };
const recipeCalls: UnifiedToolContext[] = [];
const recordCall: WrapDispatch = (_tool, _name, _args, ctx, next) => { recipeCalls.push(ctx); return next(ctx); };

describe('turn-start package sink (real anchor + catalog + class registry)', () => {
  let db: OrgTestDb;
  let root: string;

  async function inspectRecipe(id: string) {
    const context: UnifiedToolContext = { workspaceId: WS, harnessSlug: POT, role: 'su',
      principal: { slug: 'publisher', workspaceId: WS, capabilities: new Set(['*']) },
      signal: new AbortController().signal, runId: 'run', spawnId: 'spawn', parentSpawnId: null,
      featureId: null, chunkId: null, uiClientId: null, profile: 'engineer', transport: 'in_process',
      tx: db.adminSql as UnifiedToolContext['tx'], log: () => {}, progress: () => {}, emit: () => {} };
    const report = await inspectIdentityRecipeClassProvider({
      capabilityClass: { ref: `${id}@1.0.0`, behavioralSuiteRef: null,
        interfaceVerbs: { read: { inputSchema: { type: 'object' }, outputSchema: NOTES_SCHEMA } } },
      providerPackage: 'notes-recipe', providerVersion: '1.0.0', registryRevision: 'registry-1',
      recipes: { read: { recipe: { id: 'notes-recipe:read', revision: RECIPE_REVISION }, outputSchema: NOTES_SCHEMA } },
      declaredNeeds: ['notes:read'], capabilityCeiling: new Set(['*']), context,
    }, { tools: [notesTool], recipes });
    expect(report.recipes.read).toMatchObject({ ok: true, requiredCapabilities: ['notes:read'] });
    return report;
  }

  /** The production sink deps with the recipe runtime's tool surface and the ceiling pinned. */
  const recipeSinkDeps = (ceiling: { ceilings: Array<{ denyCapabilities?: string[] }>; protectedAdditions: string[] } =
    { ceilings: [], protectedAdditions: [] }) => defaultTurnStartPackageSinkDeps({
    runtime: { tools: [notesTool], recipes, dispatchDeps: {}, wrapDispatch: recordCall },
    readCeiling: async () => ceiling,
  });

  async function registerClass(id: string, provider: string | null, kind: 'tool' | 'recipe' = 'tool') {
    const sql = db.adminSql;
    await sql`
      INSERT INTO harness_shared.capability_class_registry (workspace_id, id, version, title, description, interface_verbs)
      VALUES (${WS}, ${id}, '1.0.0', ${id}, 'sink fixture',
        ${JSON.stringify({ read: { inputSchema: { type: 'object' }, outputSchema: NOTES_SCHEMA } })}::jsonb)`;
    if (!provider) return;
    const run = `run-${id}`;
    // A recipe row carries the inspected evidence class-provider.ts requires to admit it.
    const report = kind === 'recipe' ? JSON.parse(JSON.stringify(await inspectRecipe(id))) : {};
    await sql`
      INSERT INTO harness_shared.capability_class_conformance_runs
        (id, workspace_id, class_id, class_version, provider_package, provider_version, registry_revision,
         verb_bindings, structural_passed, report, provider_kind, latency_class)
      VALUES (${run}, ${WS}, ${id}, '1.0.0', ${provider}, '1.0.0', 'registry-1',
        ${sql.json({ read: `${provider}:read` })}, true, ${sql.json(report)}, ${kind}, 'sync')`;
    await sql`
      INSERT INTO harness_shared.capability_class_provider_bindings
        (workspace_id, class_id, class_version, provider_package, provider_version, conformance_run_id,
         provider_kind, latency_class)
      VALUES (${WS}, ${id}, '1.0.0', ${provider}, '1.0.0', ${run}, ${kind}, 'sync')`;
    await sql`
      INSERT INTO harness_shared.pot_capability_class_bindings
        (workspace_id, pot_slug, class_id, class_version, provider_package, provider_version, provider_kind, latency_class)
      VALUES (${WS}, ${POT}, ${id}, '1.0.0', ${provider}, '1.0.0', ${kind}, 'sync')`;
  }

  const due = (id: string, ref: string, priority: number, tokenBudget: number, trigger: unknown = 'every-turn') => ({
    id, purpose: 'resource', source: 'provider', refresh: trigger === 'on-demand' ? 'on-demand' : 'turn',
    inputKind: 'capability-provider', ref, verb: 'read', producerRef: ref, availability: 'optional',
    injection: { sinks: ['turn-start'], trigger, tokenBudget, priority, overBudget: 'truncate' },
  });

  function writeIdentity(identityId: string, contributions: Array<Record<string, unknown>>) {
    const dir = join(root, 'home', 'blueprints', identityId);
    mkdirSync(join(dir, 'prompts'), { recursive: true });
    const identity = { id: identityId, extends: 'base', version: '1.0.0', slots: [{ slot: 'domain' }], contributions };
    writeFileSync(join(dir, 'blueprint.yaml'), stringifyYaml({
      ...identity, attestation: { contentHash: layerContentHash(identity), signedBy: 'approved-publisher' },
    }));
  }

  async function wear(ownerId: string, stack: string[], applied: typeof APPLIED = APPLIED) {
    await db.adminSql`
      INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, control_generation, control_state)
      VALUES (${ownerId}, ${WS}, 1, ${db.adminSql.json({ stack, scope: { harness: POT }, activation: { applied } })})
      ON CONFLICT (owner_id) DO UPDATE SET control_state = EXCLUDED.control_state`;
  }

  beforeAll(async () => {
    db = await createOrgTestDb();
    pg.sql = db.adminSql;
    root = mkdtempSync(join(tmpdir(), 'pkg-sink-'));
    vi.stubEnv('PAPERCUSP_HOME', join(root, 'home'));
    await registerClass('context.notes', 'notes-tool');
    await registerClass('context.unbound', null);
    await registerClass('context.recipe', 'notes-recipe', 'recipe');
    // Two identities, three due contributions, each asking for most of the sink.
    writeIdentity('pkg-a', [due('brief', 'context.notes@1', 90, 300)]);
    writeIdentity('pkg-b', [
      due('digest', 'context.notes@1', 50, 300),
      due('extra', 'context.notes@1', 10, 300),
      // Declared, but not due at turn start: never evaluated here.
      due('later', 'context.notes@1', 99, 300, 'on-demand'),
    ]);
    writeIdentity('pkg-unbound', [due('ghost', 'context.unbound@1', 40, 100)]);
    writeIdentity('pkg-recipe', [due('pinned', 'context.recipe@1', 40, 300)]);
  }, 180_000);

  beforeEach(() => {
    resetSinkEvaluatorForTests();
    dispatch.calls = [];
    dispatch.impl = async () => ({ notes: 'x'.repeat(4_000) });
    recipeCalls.length = 0;
    readNotes.mockClear();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    pg.sql = null;
    if (root) rmSync(root, { recursive: true, force: true });
    await db?.cleanup();
  });

  it('shares ONE aggregate budget across every worn identity, in priority order, and renders it', async () => {
    await wear('owner-agg', ['domain:pkg-a', 'domain:pkg-b']);
    const sink = await evaluateTurnStartPackageSink({ ownerId: 'owner-agg', workspaceId: WS, deps: { limits: LIMITS }, turnId:'t1' });
    const result = sink.result!;
    expect(result.budget.tokens).toBe(DEFAULT_SINK_HOST_LIMITS.sinkBudget.tokens);
    // Three requests of 300 against a 400 pool: allocation never exceeds the pool.
    expect(result.allocation).toEqual([
      { identityId: 'pkg-a', contributionId: 'brief', allowance: 300 },
      { identityId: 'pkg-b', contributionId: 'digest', allowance: 100 },
      { identityId: 'pkg-b', contributionId: 'extra', allowance: 0 },
    ]);
    expect(result.allocation.reduce((sum, row) => sum + row.allowance, 0)).toBeLessThanOrEqual(400);
    expect(result.deliveredTokens).toBeLessThanOrEqual(400);
    expect(result.omissions).toEqual([expect.objectContaining({
      identityId: 'pkg-b', contributionId: 'extra', reason: 'budget-exhausted',
    })]);
    // The contribution granted nothing was never started — no provider call for it.
    expect(result.started).toBe(2);
    expect(dispatch.calls.map((call) => call.tool)).toEqual(['notes-tool:read', 'notes-tool:read']);
    expect(dispatch.calls.every((call) => call.env.role === 'su' && call.env.spawnId === 'identity-sink:turn-start'
      && call.env.signal instanceof AbortSignal)).toBe(true);
    // Output passed the pinned contract schema and carries the provider's provenance.
    const brief = result.deliveries.find((row) => row.contributionId === 'brief')!;
    expect(brief.truncated).toBe(true);
    expect(brief.text).toContain('"classRef":"context.notes@1.0.0"');
    expect(brief.text).toContain('"providerRef":"notes-tool@1.0.0"');
    // Rendered: a disjoint package class id per contribution, the omission visible.
    const rows = projectPackageOrientationRows(sink.classes, 'turn-start').map((row) => row.text);
    expect(sink.classes.map((cls) => cls.id)).toEqual([
      'package:pkg-a/brief', 'package:pkg-b/digest', 'package:pkg-b/extra',
    ]);
    expect(rows.some((text) => text.includes('pkg-b/extra omitted: budget-exhausted'))).toBe(true);
    // The persisted receipt names every allowance and hashes what it delivered.
    const receipt = packageSinkReceipt(sink)!;
    expect(receipt).toMatchObject({ status: 'rendered', turnId: 't1', attachmentRevision: 'spec-1:state-1' });
    expect(receipt.deliveries).toContainEqual(expect.objectContaining({
      contributionId: 'brief', outputRevision: createHash('sha256').update(brief.text).digest('hex'),
    }));
  }, 120_000);

  it('adding providers never multiplies the sink, and the turn ceiling caps a second invocation', async () => {
    await wear('owner-one', ['domain:pkg-a']);
    const alone = (await evaluateTurnStartPackageSink({ ownerId: 'owner-one', workspaceId: WS, deps: { limits: LIMITS }, turnId:'solo' })).result!;
    await wear('owner-many', ['domain:pkg-a', 'domain:pkg-b', 'domain:pkg-unbound']);
    const many = (await evaluateTurnStartPackageSink({ ownerId: 'owner-many', workspaceId: WS, deps: { limits: LIMITS }, turnId:'m1' })).result!;
    expect(many.budget.tokens).toBe(alone.budget.tokens);
    expect(many.allocation.reduce((sum, row) => sum + row.allowance, 0)).toBeLessThanOrEqual(many.budget.tokens);
    // Same session, same turn: the second sink invocation gets only what the ceiling has left.
    const again = (await evaluateTurnStartPackageSink({ ownerId: 'owner-many', workspaceId: WS, deps: { limits: LIMITS }, turnId:'m1' })).result!;
    expect(again.budget.tokens).toBe(Math.min(
      DEFAULT_SINK_HOST_LIMITS.sinkBudget.tokens,
      DEFAULT_SINK_HOST_LIMITS.turnCeiling.tokens - many.deliveredTokens,
    ));
    expect(many.deliveredTokens + again.deliveredTokens).toBeLessThanOrEqual(DEFAULT_SINK_HOST_LIMITS.turnCeiling.tokens);
  }, 120_000);

  it('never renders a result the wearer left mid-invocation (generation fence)', async () => {
    await wear('owner-fence', ['domain:pkg-a']);
    dispatch.impl = async () => {
      // The wearer re-attaches while the provider is running.
      await wear('owner-fence', ['domain:pkg-a'], { specificationRevision: 'spec-2', stateRevision: 'state-2' });
      return { notes: 'late' };
    };
    const sink = await evaluateTurnStartPackageSink({ ownerId: 'owner-fence', workspaceId: WS, deps: { limits: LIMITS }, turnId:'f1' });
    expect(sink.result?.invocation.attachmentRevision).toBe('spec-1:state-1');
    expect(sink.classes).toEqual([]);
    expect(packageSinkReceipt(sink)).toMatchObject({ status: 'fenced' });
  }, 120_000);

  it('renders an unresolvable provider as a visible omission, never silence', async () => {
    await wear('owner-unbound', ['domain:pkg-unbound']);
    const sink = await evaluateTurnStartPackageSink({ ownerId: 'owner-unbound', workspaceId: WS, deps: { limits: LIMITS }, turnId:'u1' });
    expect(dispatch.calls).toEqual([]);
    expect(sink.result!.omissions).toEqual([expect.objectContaining({
      contributionId: 'ghost', reason: 'provider-error', detail: 'capability-class:class-unbound',
    })]);
    const rows = projectPackageOrientationRows(sink.classes, 'turn-start').map((row) => row.text);
    expect(rows).toEqual(['- ⟦pkg-unbound/ghost omitted: provider-error⟧']);
  }, 120_000);

  it('runs an inspected recipe binding as the live wearer, never a system principal (P-018 D-020, D-031)', async () => {
    await wear('owner-recipe', ['domain:pkg-recipe']);
    const sink = await evaluateTurnStartPackageSink({
      ownerId: 'owner-recipe', workspaceId: WS, deps: { ...recipeSinkDeps(), limits: LIMITS }, turnId: 'r1',
    });
    // The recipe path never reaches the tool-provider dispatcher.
    expect(dispatch.calls).toEqual([]);
    expect(sink.result!.omissions).toEqual([]);
    const pinned = sink.result!.deliveries.find((row) => row.contributionId === 'pinned')!;
    expect(pinned.text).toContain('from the recipe');
    expect(pinned.text).toContain('"providerRef":"notes-recipe@1.0.0"');
    expect(readNotes).toHaveBeenCalledTimes(1);
    // The one call the recipe made ran as the wearer: no bypass, no superuser, only
    // the inspected requirement the ceiling admitted.
    expect(recipeCalls).toHaveLength(1);
    expect(recipeCalls[0]).toMatchObject({
      role: 'su', harnessSlug: POT, uiClientId: 'owner-recipe', spawnId: PACKAGE_SINK_SPAWN_ID,
      isSuperuser: false, gateBypass: undefined,
    });
    expect(recipeCalls[0]!.principal).toMatchObject({ slug: 'owner-recipe', workspaceId: WS });
    expect([...recipeCalls[0]!.principal!.capabilities]).toEqual(['notes:read']);
    expect(sink.classes.map((cls) => cls.id)).toEqual(['package:pkg-recipe/pinned']);
  }, 120_000);

  it('omits a recipe whose requirement the live pot/role ceiling refuses, before it makes any call', async () => {
    await wear('owner-recipe', ['domain:pkg-recipe']);
    const sink = await evaluateTurnStartPackageSink({
      ownerId: 'owner-recipe', workspaceId: WS, turnId: 'r2',
      deps: { ...recipeSinkDeps({ ceilings: [{ denyCapabilities: ['notes:*'] }], protectedAdditions: [] }), limits: LIMITS },
    });
    expect(readNotes).not.toHaveBeenCalled();
    expect(recipeCalls).toEqual([]);
    expect(sink.result!.omissions).toEqual([expect.objectContaining({
      contributionId: 'pinned', reason: 'provider-error', detail: 'capability-class:recipe-capability-denied',
    })]);
    const rows = projectPackageOrientationRows(sink.classes, 'turn-start').map((row) => row.text);
    expect(rows).toEqual(['- ⟦pkg-recipe/pinned omitted: provider-error⟧']);
  }, 120_000);

  it('resolves the recipe wearer from the live anchor on every call and refuses one that no longer wears the identity', async () => {
    const readCeiling = vi.fn(async () => ({ ceilings: [{ allowCapabilities: ['notes:*'] }], protectedAdditions: [] }));
    const resolve = (stack: string[] | null, potSlug: string | null = POT) => resolvePackageSinkRecipeWearer({
      ownerId: 'owner-live', workspaceId: WS, identityId: 'pkg-recipe',
      requiredCapabilities: ['notes:read', 'status:read'], signal: new AbortController().signal,
    }, { readWearer: async () => (stack ? { stack, attachmentRevision: 'r', potSlug } : null), readCeiling });
    const wearer = await resolve(['domain:pkg-recipe']);
    // Outside the ceiling means absent, so re-inspection refuses a recipe that needs it.
    expect([...wearer.capabilityCeiling]).toEqual(['notes:read']);
    expect([...wearer.context.principal!.capabilities]).toEqual(['notes:read']);
    expect(readCeiling).toHaveBeenCalledWith({ workspaceId: WS, harnessSlug: POT, role: 'su' });
    await expect(resolve(['domain:pkg-other'])).rejects.toThrow('capability-class:recipe-wearer-detached');
    await expect(resolve(null)).rejects.toThrow('capability-class:recipe-wearer-detached');
    await expect(resolve(['domain:pkg-recipe'], null)).rejects.toThrow('capability-class:recipe-wearer-unscoped');
  });

  it('is a no-op for a wearer that declares nothing due, and for an unknown session', async () => {
    await wear('owner-builtin', ['autonomy:su.mode-auto']);
    const builtin = await evaluateTurnStartPackageSink({ ownerId: 'owner-builtin', workspaceId: WS, deps: { limits: LIMITS }, turnId:'n1' });
    // The fixture anchor names an applied revision with no stored artifact, so the
    // worn-rule half reports it visibly instead of reading it as "wears nothing".
    expect(builtin).toEqual({ result: null, classes: [], rulesError: 'applied identity artifact unreadable' });
    expect(await evaluateTurnStartPackageSink({ ownerId: 'owner-nobody', workspaceId: WS, deps: { limits: LIMITS }, turnId:'n2' }))
      .toEqual({ result: null, classes: [] });
    expect(dispatch.calls).toEqual([]);
  }, 120_000);

  // identity-system-everything-migration-2026-10-18 P-003 (AUTO-BAR-R-1-P-003): a non-su
  // wearer's identity work runs at the role its identity-bearing launch record names,
  // never at su. The role is read from the REAL adv_sessions launch record.
  describe('non-su wearer (P-003)', () => {
    async function launchRecord(ownerId: string, role: string | null, stack: string[]) {
      await db.adminSql`
        INSERT INTO harness_shared.adv_sessions (workspace_id, mode, coord_owner_id, launch_spec)
        VALUES (${WS}, 'console', ${ownerId},
          ${db.adminSql.json({ v: 1, workspaceId: WS, harnessSlug: POT, stack, ...(role ? { role } : {}) })})`;
    }
    /** A pot/role ceiling that refuses the recipe's `notes:*` requirement for judges only. */
    const roleKeyedSinkDeps = (rolesRead: string[]) => defaultTurnStartPackageSinkDeps({
      runtime: { tools: [notesTool], recipes, dispatchDeps: {}, wrapDispatch: recordCall },
      readCeiling: async ({ role }) => {
        rolesRead.push(role);
        return { potSlug: POT, ceilings: role === 'judge' ? [{ denyCapabilities: ['notes:*'] }] : [], protectedAdditions: [] };
      },
    });

    it('dispatches a judge wearer\'s tool provider as the judge role', async () => {
      await wear('owner-judge-tool', ['domain:pkg-a']);
      await launchRecord('owner-judge-tool', 'judge', ['domain:pkg-a']);
      const sink = await evaluateTurnStartPackageSink({
        ownerId: 'owner-judge-tool', workspaceId: WS, deps: { limits: LIMITS }, turnId: 'j1',
      });
      expect(sink.result!.omissions).toEqual([]);
      expect(dispatch.calls).toHaveLength(1);
      expect(dispatch.calls[0]!.env).toMatchObject({ role: 'judge', onBehalfOf: 'owner-judge-tool' });
    }, 120_000);

    it('narrows a judge wearer\'s recipe to the judge ceiling, while an SU record keeps the su ceiling', async () => {
      await wear('owner-judge-recipe', ['domain:pkg-recipe']);
      await launchRecord('owner-judge-recipe', 'judge', ['domain:pkg-recipe']);
      const judgeRoles: string[] = [];
      const judged = await evaluateTurnStartPackageSink({
        ownerId: 'owner-judge-recipe', workspaceId: WS, turnId: 'j2',
        deps: { ...roleKeyedSinkDeps(judgeRoles), limits: LIMITS },
      });
      expect(judgeRoles).toEqual(['judge']);
      expect(readNotes).not.toHaveBeenCalled();
      expect(recipeCalls).toEqual([]);
      expect(judged.result!.omissions).toEqual([expect.objectContaining({
        contributionId: 'pinned', reason: 'provider-error', detail: 'capability-class:recipe-capability-denied',
      })]);

      // Same pot, same ceiling reader: a role-less (SU) launch record is judged at su.
      await wear('owner-su-recipe', ['domain:pkg-recipe']);
      await launchRecord('owner-su-recipe', null, ['domain:pkg-recipe']);
      const suRoles: string[] = [];
      const su = await evaluateTurnStartPackageSink({
        ownerId: 'owner-su-recipe', workspaceId: WS, turnId: 'j3',
        deps: { ...roleKeyedSinkDeps(suRoles), limits: LIMITS },
      });
      expect(suRoles).toEqual(['su']);
      expect(su.result!.omissions).toEqual([]);
      expect(recipeCalls).toHaveLength(1);
      expect(recipeCalls[0]).toMatchObject({ role: 'su', uiClientId: 'owner-su-recipe' });
    }, 120_000);

    it('reads the newest launch record, so a relaunch as judge is judged as judge', async () => {
      await wear('owner-relaunch', ['domain:pkg-recipe']);
      await launchRecord('owner-relaunch', null, ['domain:pkg-recipe']);
      await db.adminSql`UPDATE harness_shared.adv_sessions SET started_at = now() - interval '1 hour'
        WHERE coord_owner_id = 'owner-relaunch'`;
      await launchRecord('owner-relaunch', 'judge', ['domain:pkg-recipe']);
      const wearer = await defaultTurnStartPackageSinkDeps().readWearer('owner-relaunch', WS);
      expect(identityWearerRole(wearer!.launchRecord)).toBe('judge');
    }, 120_000);
  });
});
