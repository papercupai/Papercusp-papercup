/**
 * The registry seed changes no existing verdict (plan-item-types-registry-cupboard-2026-10-20
 * P-001, requirement R-3).
 *
 * Seeds a fixture population of existing plan shapes into the integration-tier baseline PG and
 * runs the real ship, start and completion gates over it twice: once under the legacy resolver
 * and once under the registry (`createRegistryVerificationResolver` over a snapshot read from
 * PG). Falsifiers, each a case below:
 *   (1) a changed ship, start or completion verdict;
 *   (2) fewer plans compared than the population holds, or an error row;
 *   (3) a census with the code module removed from the code item type reports no change;
 *   (4) a built-in definition differs from today's module mapping.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { DEFAULT_WORKSPACE_ID } from '../workspace-registry';
import {
  setupPlanPgFixture,
  cleanupPlans,
  registerHarnessProject,
  seedPlan,
  type PlanPgFixture,
} from '../agent-tools/plans/__tests__/_pg-tool-fixture';
import {
  DELIVERABLE_KINDS,
  PROFILE_DEFAULT_DELIVERABLE,
  VERIFICATION_PROFILES,
  modulesFor,
  resolveVerification,
  resolveVerificationLegacy,
  withVerificationResolver,
} from '../plan-verification-profile';
import { PLAN_CLASSES_BY_PROFILE, PLAN_CLASS_RUBRIC_REFS } from '../plan-class-refs';
import { BUILTIN_CATALOG, builtinItemTypeId, type TypeCatalog } from './builtin-catalog';
import { loadTypeRegistry } from './registry';
import { createRegistryVerificationResolver, STRICTEST_MODULES } from './resolve-verification';
import {
  LEGACY_VERIFICATION_RESOLVER,
  diffPlanVerdictCensus,
  enumerateResolverInputs,
  enumerateUnregisteredTypeInputs,
  listCensusPopulation,
  runPlanVerdictCensus,
} from './census';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-ptcensus-${RUN}`;
const WS = DEFAULT_WORKSPACE_ID;

interface Shape {
  slug: string;
  status: string;
  profile: string | null;
  items: Array<{ id: string; deliverable: string | null; status: string }>;
  audit?: Array<{ itemId: string; verdict: string; citations: unknown[] }>;
}

const doc = { kind: 'doc', path: 'docs/readme.md' };
const none = { kind: 'none', reason: 'fixture: no code deliverable' };

/** Existing plan shapes: each varies one input the resolver reads. */
const SHAPES: Shape[] = [
  { slug: `ptc-empty-${RUN}`, status: 'draft', profile: null, items: [] },
  {
    slug: `ptc-unstamped-${RUN}`, status: 'active', profile: null,
    items: [{ id: 'P-001', deliverable: null, status: 'todo' }, { id: 'P-002', deliverable: null, status: 'done' }],
  },
  {
    slug: `ptc-coding-declared-${RUN}`, status: 'active', profile: 'coding',
    items: [
      { id: 'P-001', deliverable: 'code', status: 'done' },
      { id: 'P-002', deliverable: 'doc', status: 'done' },
      { id: 'P-003', deliverable: 'research', status: 'todo' },
    ],
    audit: [
      { itemId: 'P-001', verdict: 'implemented', citations: [doc] },
      { itemId: 'P-002', verdict: 'implemented', citations: [doc] },
    ],
  },
  {
    slug: `ptc-general-${RUN}`, status: 'awaiting-acceptance', profile: 'general',
    items: [{ id: 'P-001', deliverable: null, status: 'done' }, { id: 'P-002', deliverable: 'code', status: 'done' }],
    audit: [
      { itemId: 'P-001', verdict: 'not-code', citations: [none] },
      { itemId: 'P-002', verdict: 'implemented', citations: [doc] },
    ],
  },
  {
    slug: `ptc-shipped-${RUN}`, status: 'shipped', profile: 'coding',
    items: [{ id: 'P-001', deliverable: null, status: 'done' }, { id: 'P-002', deliverable: 'operation', status: 'done' }],
    audit: [
      { itemId: 'P-001', verdict: 'implemented', citations: [doc] },
      { itemId: 'P-002', verdict: 'not-code', citations: [none] },
    ],
  },
  {
    slug: `ptc-every-kind-${RUN}`, status: 'ready', profile: 'general',
    items: DELIVERABLE_KINDS.map((kind, index) => ({ id: `P-00${index + 1}`, deliverable: kind, status: 'todo' })),
  },
];

let fx: PlanPgFixture;
let admin: postgres.Sql;

function body(shape: Shape): string {
  const lines = shape.items.map((item) => `- **${item.id}** \`${item.status}\` Item ${item.id}`);
  return `---\ntitle: ${shape.slug}\nslug: ${shape.slug}\nstatus: ${shape.status}\n---\n\n# ${shape.slug}\n\n## Work\n${lines.join('\n')}\n`;
}

async function seedShape(shape: Shape): Promise<void> {
  if (shape.status === 'shipped') {
    // Inserted with its status: the shipment-receipt trigger guards an UPDATE, not an insert.
    await registerHarnessProject(admin, WS, HARNESS);
    await admin`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, content, content_hash, version, origin, status)
      VALUES (${WS}, ${HARNESS}, ${shape.slug}, ${body(shape)}, md5(${body(shape)}), 1, 'local', 'shipped')`;
  } else {
    await seedPlan(admin, WS, HARNESS, shape.slug, body(shape));
    await admin`UPDATE harness_shared.harness_plans SET status = ${shape.status}
                 WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${shape.slug}`;
  }
  if (shape.profile) {
    await admin`UPDATE harness_shared.harness_plans
                   SET verification_profile = ${shape.profile}, verification_profile_source = 'declared'
                 WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${shape.slug}`;
  }
  for (const [seq, item] of shape.items.entries()) {
    await admin`
      INSERT INTO harness_shared.plan_items (workspace_id, harness_slug, plan_slug, item_id, seq, item_text, status, deliverable)
      VALUES (${WS}, ${HARNESS}, ${shape.slug}, ${item.id}, ${seq + 1}, ${`Item ${item.id}`}, ${item.status}, ${item.deliverable})`;
  }
  if (shape.audit) {
    await admin`
      INSERT INTO harness_shared.plan_audits (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind, items)
      VALUES (${WS}, ${HARNESS}, ${shape.slug}, 1, 'ptc-test', 'completion', ${admin.json(shape.audit as never)})`;
  }
}

/** The catalog with the code module removed from papercusp/code: the R-3 positive control. */
function catalogWithoutCode(): TypeCatalog {
  return {
    planTypes: BUILTIN_CATALOG.planTypes,
    itemTypes: BUILTIN_CATALOG.itemTypes.map((def) =>
      def.id === builtinItemTypeId('code') ? { ...def, modules: def.modules.filter((m) => m !== 'code') } : def),
  };
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  for (const shape of SHAPES) await seedShape(shape);
}, 180_000);

afterAll(async () => {
  if (!admin) return;
  const slugs = SHAPES.map((shape) => shape.slug);
  await admin`DELETE FROM harness_shared.plan_audits WHERE workspace_id = ${WS} AND plan_slug IN ${admin(slugs)}`;
  await admin`DELETE FROM harness_shared.plan_items WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  await cleanupPlans(admin, WS, HARNESS);
  await fx.dispose();
});

describe('resolver parity', () => {
  it('the registry resolver equals the legacy resolver on every built-in input', async () => {
    const registry = createRegistryVerificationResolver(await loadTypeRegistry(admin, { workspaceId: WS }));
    const inputs = enumerateResolverInputs();
    expect(inputs.length).toBeGreaterThan(1000);
    for (const { plan, item } of inputs) {
      const resolved = registry(plan, item);
      const { itemTypeContract, ...behavior } = resolved;
      // The legacy resolver has no contract metadata; every existing resolution field must match.
      expect(behavior, JSON.stringify({ plan, item })).toEqual(resolveVerificationLegacy(plan, item));
      if (resolved.itemType) {
        expect(itemTypeContract).toMatchObject({
          id: resolved.itemType,
          revision: 1,
          contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        });
      } else {
        expect(itemTypeContract).toBeUndefined();
      }
    }
  });

  it('an unregistered namespaced item type diverges from legacy only by failing safe to the strictest set (R-6)', async () => {
    const registry = createRegistryVerificationResolver(await loadTypeRegistry(admin, { workspaceId: WS }));
    const inputs = enumerateUnregisteredTypeInputs('acme/legal-review');
    expect(inputs.length).toBeGreaterThan(100);
    for (const { plan, item } of inputs) {
      const resolved = registry(plan, item);
      const label = JSON.stringify({ plan, item });
      expect(resolved.modules, label).toEqual([...STRICTEST_MODULES]);
      expect(resolved.codeDeliverable, label).toBe(true);
      expect(resolved.deliverableSource, label).toBe('declared');
      expect(resolved.itemType, label).toBe('acme/legal-review');
      expect(resolved.deliverable, label).toBeNull();
    }
  });

  it('withVerificationResolver routes resolveVerification and nothing outside its scope', async () => {
    const strict = createRegistryVerificationResolver(await loadTypeRegistry(admin, { workspaceId: WS }, { catalog: catalogWithoutCode() }));
    const input = [{ verificationProfile: 'coding' }, { deliverable: 'code' }] as const;
    expect(resolveVerification(...input).codeDeliverable).toBe(true);
    const inside = await withVerificationResolver(strict, async () => {
      await Promise.resolve();
      return resolveVerification(...input).codeDeliverable;
    });
    expect(inside).toBe(false);
    expect(resolveVerification(...input).codeDeliverable).toBe(true);
  });
});

describe('registry census over the fixture population (R-3)', () => {
  it('ship, start and completion verdicts are unchanged for every plan, with no error row', async () => {
    const plans = await listCensusPopulation(admin, { workspaceId: WS, harnessSlug: HARNESS });
    expect(plans).toHaveLength(SHAPES.length);
    const registry = createRegistryVerificationResolver(await loadTypeRegistry(admin, { workspaceId: WS }));
    const before = await runPlanVerdictCensus({ sql: admin, plans, resolver: LEGACY_VERIFICATION_RESOLVER });
    const after = await runPlanVerdictCensus({ sql: admin, plans, resolver: registry });
    const diff = diffPlanVerdictCensus(before, after);
    expect(diff.errorRows).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.compared).toBe(plans.length);
    expect(diff.population).toBe(plans.length);
    expect(diff.zeroChange).toBe(true);
    // Non-vacuous: the population really exercises code and non-code items at completion.
    const closes = before.flatMap((row) => row.completion.items);
    expect(closes.some((entry) => entry.includes(':close=code'))).toBe(true);
    expect(closes.some((entry) => entry.includes(':close=non-code'))).toBe(true);
    expect(before.find((row) => row.plan.planSlug === SHAPES[4].slug)?.ship.skipped).not.toBe('already-shipped');
  }, 180_000);

  it('removing the code module from the code item type is caught as changed verdicts', async () => {
    const plans = await listCensusPopulation(admin, { workspaceId: WS, harnessSlug: HARNESS });
    const stripped = createRegistryVerificationResolver(
      await loadTypeRegistry(admin, { workspaceId: WS }, { catalog: catalogWithoutCode() }),
    );
    const before = await runPlanVerdictCensus({ sql: admin, plans, resolver: LEGACY_VERIFICATION_RESOLVER });
    const after = await runPlanVerdictCensus({ sql: admin, plans, resolver: stripped });
    const diff = diffPlanVerdictCensus(before, after);
    expect(diff.zeroChange).toBe(false);
    expect(diff.changed.length).toBeGreaterThan(0);
    expect(diff.changed.flatMap((change) => change.kinds)).toContain('completion');
  }, 180_000);
});

describe('first-party definitions match today’s mapping (R-3 falsifier 4)', () => {
  it('each built-in kind’s item type has exactly the modules modulesFor gives it', () => {
    for (const kind of DELIVERABLE_KINDS) {
      const def = BUILTIN_CATALOG.itemTypes.find((d) => d.id === `papercusp/${kind}`);
      expect(def?.modules, kind).toEqual(modulesFor(kind === 'code'));
    }
    expect(BUILTIN_CATALOG.itemTypes).toHaveLength(DELIVERABLE_KINDS.length);
  });

  it('each profile’s plan type has today’s default deliverable and plan classes', () => {
    for (const profile of VERIFICATION_PROFILES) {
      const def = BUILTIN_CATALOG.planTypes.find((d) => d.id === `papercusp/${profile}`);
      expect(def?.base, profile).toBe(profile);
      expect(def?.defaultItemType.id).toBe(`papercusp/${PROFILE_DEFAULT_DELIVERABLE[profile]}`);
      expect(def?.classes).toEqual([...PLAN_CLASSES_BY_PROFILE[profile]]);
    }
    expect(BUILTIN_CATALOG.planTypes.flatMap((d) => d.classes).sort()).toEqual([...PLAN_CLASS_RUBRIC_REFS].sort());
  });
});
