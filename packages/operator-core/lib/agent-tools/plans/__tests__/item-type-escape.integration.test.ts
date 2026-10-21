/**
 * R-8 anti-escape for item types and plan types
 * (plan-item-types-registry-cupboard-2026-10-20 P-003, D-005).
 *
 * After activation, a write that makes an item's RESOLVED MODULE SET lose a module is a
 * lowering, whatever the type is called. It needs a Decision that is already recorded plus an
 * activation audit covering it (plan-verification-profiles-2026-10-17#D-004/#D-008). This file
 * covers each route in three rows (no Decision; a Decision with a stale audit; a Decision and a
 * fresh audit):
 *   - an item `deliverable:` swap between two REGISTERED third-party item types;
 *   - a plan-level `type:` swap between two registered plan types whose default item types differ;
 *   - P-005's registry writes (D-005/D-006), on an activated plan that has NO pins, as a plan
 *     activated by a build that did not pin yet: retiring the revision it resolves, defining a
 *     smaller revision of a parent it reaches through `extends`, and moving its pin.
 * P-006 (same-id pack install) adds its rows here.
 *
 * Registry-write rows each use their own type ids: the shrink check judges every activated plan
 * that resolves the type, so a refused row's plan would otherwise refuse the next row too.
 *
 * The types are workspace registry rows, so the write path must resolve through the workspace
 * registry: under the built-in-only default both sides of these swaps fail safe to the full
 * catalog and no lowering is seen at all (the escape the "no Decision" rows pin).
 *
 * Every write goes through the real projected dispatch against a private (isolated) integration
 * PG; activation and audits are seeded with direct rows, as the sibling
 * verification-profile-escape test does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { dispatchProjectedTool, lookupByMcpName } from '@papercusp/agent-mcp';
import '../new';
import '../set-content';
import '../add-item';
import '../add-decision';
import '../../plan-types/define';
import '../../plan-types/retire';
import '../../plan-types/pin';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { hashPlanContent } from '../content-hash';
import { setupPlanPgFixture, cleanupPlans, registerHarnessProject, type PlanPgFixture } from './_pg-tool-fixture';
import { installTypePack } from '../../../cupboard/type-pack';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-itescape-${RUN}`;
const WS = DEFAULT_WORKSPACE_ID;
const NS = `zzz-itescape-${Math.random().toString(36).slice(2, 8)}`;
const CLAUSE = `${NS}/clause`; // code work
const MEMO = `${NS}/memo`; // not code
const BUILD_PLAN = `${NS}/build-plan`; // default item type: CLAUSE
const MEMO_PLAN = `${NS}/memo-plan`; // default item type: MEMO

let fx: PlanPgFixture;
let admin: postgres.Sql;
let auditSeq = 0;

function ctx(): never {
  return {
    workspaceId: WS,
    harnessSlug: HARNESS,
    runId: 'plans-item-type-escape',
    role: 'su',
    gateBypass: { role: true, capability: true, quota: true },
    transport: 'mcp',
    requestedFormat: 'json',
    requestedStructured: true,
  } as never;
}

type Dispatched = Awaited<ReturnType<typeof dispatchProjectedTool>>;

async function call(tool: string, args: Record<string, unknown>): Promise<{ d: Dispatched; payload: Record<string, unknown> | null }> {
  const projected = lookupByMcpName(tool);
  expect(projected, `${tool} must be registered in the projection registry`).toBeTruthy();
  const d = await dispatchProjectedTool(projected!, tool, { harness: HARNESS, ...args }, ctx(), {});
  const content = (d.result as { content?: Array<{ text?: string }> } | undefined)?.content;
  const structured = (d.result as { structuredContent?: unknown } | undefined)?.structuredContent;
  let payload: Record<string, unknown> | null = null;
  if (structured && typeof structured === 'object') payload = structured as Record<string, unknown>;
  else if (content?.[0]?.text) {
    try {
      payload = JSON.parse(content[0].text) as Record<string, unknown>;
    } catch {
      payload = { text: content[0].text };
    }
  }
  return { d, payload };
}

function brief(x: unknown): string {
  return JSON.stringify(x).slice(0, 900);
}

/** A key's value, wherever the dispatch envelope put it (depth <= 4). */
function findKey(x: unknown, key: string, depth = 0): unknown {
  if (!x || typeof x !== 'object' || depth > 4) return undefined;
  const rec = x as Record<string, unknown>;
  if (key in rec) return rec[key];
  for (const v of Object.values(rec)) {
    const hit = findKey(v, key, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

async function planContent(slug: string): Promise<string> {
  const rows = await admin<{ content: string }[]>`
    SELECT content FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
  expect(rows[0], `plan ${slug} must exist`).toBeTruthy();
  return rows[0]!.content;
}

async function setContent(slug: string, edit: (content: string) => string) {
  return call('plans:set-content', { slug, content: edit(await planContent(slug)) });
}

/** The plan's frontmatter `type:` line set to `planType`, added after `slug:` when absent. */
function withPlanType(content: string, planType: string): string {
  return /^type: .*$/m.test(content)
    ? content.replace(/^type: .*$/m, `type: ${planType}`)
    : content.replace(/^(slug: .*)$/m, `$1\ntype: ${planType}`);
}

/** A plan whose P-001 declares `deliverable: <p001>` and whose P-002 takes the default item type. */
async function makePlan(slug: string, p001: string, planType?: string): Promise<void> {
  const created = await call('plans:new', { slug, title: `Itescape ${slug}`, verificationProfile: 'general', force: true });
  expect(created.payload?.ok, brief({ payload: created.payload, error: created.d.error })).toBe(true);
  const added = await call('plans:add-item', {
    slug,
    phase: 'Phase 1',
    importance: 'normal',
    items: [{ text: 'Draft the clause', deliverable: p001 }, { text: 'Write the summary' }],
  });
  expect(added.payload?.ok, brief({ payload: added.payload, error: added.d.error })).toBe(true);
  expect(await planContent(slug)).toContain(`Draft the clause deliverable: ${p001}`);
  if (planType) {
    // A draft may set its type freely.
    const typed = await setContent(slug, (c) => withPlanType(c, planType));
    expect(typed.payload?.ok, brief({ payload: typed.payload, error: typed.d.error })).toBe(true);
    expect(await planContent(slug)).toMatch(new RegExp(`^type: ${planType}$`, 'm'));
  }
}

/** Record an activation audit over the plan's current content (activation, or a fresh audit). */
async function auditActivation(slug: string): Promise<void> {
  const body = await planContent(slug);
  auditSeq += 1;
  await admin`
    INSERT INTO harness_shared.plan_audits
      (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind,
       activation, audited_plan_revision_id, audited_plan_revision_seq,
       audited_plan_content_hash, items, findings)
    VALUES
      (${WS}, ${HARNESS}, ${slug}, ${auditSeq}, 'su-test', 'activation',
       ${JSON.stringify({ sourceRanges: [], mappings: [], repairedOmissions: [], rejectedOrSuperseded: [], unresolvedBlockers: [] })}::text::jsonb,
       ${auditSeq}, ${auditSeq}, ${hashPlanContent(body)}, '[]'::jsonb, '[]'::jsonb)`;
}

async function addDecision(slug: string, title: string, body: string): Promise<void> {
  const res = await call('plans:add-decision', { slug, title, body });
  expect(res.payload?.ok, brief({ payload: res.payload, error: res.d.error })).toBe(true);
}

function expectRefused(res: Awaited<ReturnType<typeof call>>, code: string): void {
  expect(res.payload?.ok === true, brief(res.payload)).toBe(false);
  expect(findKey(res.payload, 'code'), brief(res.payload)).toBe(code);
  expect(findKey(res.payload, 'modules'), brief(res.payload)).toEqual(['code']);
}

async function insertDefinition(table: 'plan_item_type_definitions' | 'plan_type_definitions', def: Record<string, unknown> & { id: string }) {
  await admin`
    INSERT INTO harness_shared.${admin(table)}
      (workspace_id, hive_slug, type_id, revision, definition, origin)
    VALUES (${WS}, NULL, ${def.id}, ${Number(def.revision ?? 1)}, ${admin.json(def as never)}, 'workspace')`;
}

function itemTypeDef(id: string, revision: number, modules: string[], extra: Record<string, unknown> = {}) {
  return { schemaVersion: 1, id, revision, title: id, modules, ...extra };
}

function planType(id: string, defaultItemType: string) {
  return {
    schemaVersion: 1,
    id,
    revision: 1,
    title: id,
    base: 'general',
    classes: ['plan-class-feature-ship'],
    defaultItemType: { id: defaultItemType },
    itemTypes: [{ id: CLAUSE }, { id: MEMO }],
  };
}

beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  admin = fx.admin;
  await registerHarnessProject(admin, WS, HARNESS);
  await insertDefinition('plan_item_type_definitions', { schemaVersion: 1, id: CLAUSE, revision: 1, title: 'Clause', modules: ['generic-core', 'code'] });
  await insertDefinition('plan_item_type_definitions', { schemaVersion: 1, id: MEMO, revision: 1, title: 'Memo', modules: ['generic-core'] });
  await insertDefinition('plan_type_definitions', planType(BUILD_PLAN, CLAUSE));
  await insertDefinition('plan_type_definitions', planType(MEMO_PLAN, MEMO));
}, 180_000);

afterAll(async () => {
  if (admin) {
    await admin`DELETE FROM harness_shared.plan_audits WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`.catch(() => {});
    await admin`DELETE FROM harness_shared.plan_item_type_definitions WHERE workspace_id = ${WS} AND type_id LIKE ${`${NS}/%`}`.catch(() => {});
    await admin`DELETE FROM harness_shared.plan_type_definitions WHERE workspace_id = ${WS} AND type_id LIKE ${`${NS}/%`}`.catch(() => {});
    await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  }
  await fx?.dispose();
});

const toMemo = (c: string) => c.replace(`Draft the clause deliverable: ${CLAUSE}`, `Draft the clause deliverable: ${MEMO}`);

describe('R-8: an item deliverable swap between registered item types', () => {
  it('an activated plan refuses clause -> memo with no recorded Decision', async () => {
    const slug = 'zzz-itescape-item-nodecision-2026-10-21';
    await makePlan(slug, CLAUSE);
    await auditActivation(slug);
    expectRefused(await setContent(slug, toMemo), 'verification_lowering_requires_decision');
    expect(await planContent(slug)).toContain(`Draft the clause deliverable: ${CLAUSE}`);
  });

  it('a recorded Decision is not enough while the activation audit predates it', async () => {
    const slug = 'zzz-itescape-item-staleaudit-2026-10-21';
    await makePlan(slug, CLAUSE);
    await auditActivation(slug);
    await addDecision(slug, 'P-001 is a memo', `P-001 deliverable changes from ${CLAUSE} to ${MEMO}: no code is written.`);
    expectRefused(await setContent(slug, toMemo), 'verification_lowering_requires_fresh_activation_audit');
    expect(await planContent(slug)).toContain(`Draft the clause deliverable: ${CLAUSE}`);
  });

  it('a recorded Decision plus a fresh activation audit allows it', async () => {
    const slug = 'zzz-itescape-item-allowed-2026-10-21';
    await makePlan(slug, CLAUSE);
    await auditActivation(slug);
    await addDecision(slug, 'P-001 is a memo', `P-001 deliverable changes from ${CLAUSE} to ${MEMO}: no code is written.`);
    await auditActivation(slug);
    const res = await setContent(slug, toMemo);
    expect(res.payload?.ok, brief({ payload: res.payload, error: res.d.error })).toBe(true);
    expect(await planContent(slug)).toContain(`Draft the clause deliverable: ${MEMO}`);
  });

  it('raising memo -> clause needs no Decision', async () => {
    const slug = 'zzz-itescape-item-raise-2026-10-21';
    await makePlan(slug, MEMO);
    await auditActivation(slug);
    const res = await setContent(slug, (c) => c.replace(`deliverable: ${MEMO}`, `deliverable: ${CLAUSE}`));
    expect(res.payload?.ok, brief({ payload: res.payload, error: res.d.error })).toBe(true);
  });
});

describe('R-8: a plan-level type swap between registered plan types', () => {
  // P-002 declares no deliverable, so it takes the plan type's default: CLAUSE, then MEMO.
  const toMemoPlan = (c: string) => withPlanType(c, MEMO_PLAN);

  it('an activated plan refuses build-plan -> memo-plan with no recorded Decision', async () => {
    const slug = 'zzz-itescape-type-nodecision-2026-10-21';
    await makePlan(slug, CLAUSE, BUILD_PLAN);
    await auditActivation(slug);
    expectRefused(await setContent(slug, toMemoPlan), 'verification_lowering_requires_decision');
    expect(await planContent(slug)).toMatch(new RegExp(`^type: ${BUILD_PLAN}$`, 'm'));
  });

  it('a recorded Decision is not enough while the activation audit predates it', async () => {
    const slug = 'zzz-itescape-type-staleaudit-2026-10-21';
    await makePlan(slug, CLAUSE, BUILD_PLAN);
    await auditActivation(slug);
    await addDecision(slug, 'Summary work is memo work', `The plan type changes to ${MEMO_PLAN}: the summary writes no code.`);
    expectRefused(await setContent(slug, toMemoPlan), 'verification_lowering_requires_fresh_activation_audit');
    expect(await planContent(slug)).toMatch(new RegExp(`^type: ${BUILD_PLAN}$`, 'm'));
  });

  it('a recorded Decision plus a fresh activation audit allows it', async () => {
    const slug = 'zzz-itescape-type-allowed-2026-10-21';
    await makePlan(slug, CLAUSE, BUILD_PLAN);
    await auditActivation(slug);
    await addDecision(slug, 'Summary work is memo work', `The plan type changes to ${MEMO_PLAN}: the summary writes no code.`);
    await auditActivation(slug);
    const res = await setContent(slug, toMemoPlan);
    expect(res.payload?.ok, brief({ payload: res.payload, error: res.d.error })).toBe(true);
    expect(await planContent(slug)).toMatch(new RegExp(`^type: ${MEMO_PLAN}$`, 'm'));
  });
});

type Row = 'nodecision' | 'staleaudit' | 'allowed';

/** An activated plan with no pins whose P-001 declares `deliverable`, prepared for one row. */
async function rowPlan(route: string, row: Row, deliverable: string, decision: { title: string; body: string }): Promise<string> {
  const slug = `zzz-itescape-${route}-${row}-2026-10-21`;
  await makePlan(slug, deliverable);
  await auditActivation(slug);
  if (row !== 'nodecision') await addDecision(slug, decision.title, decision.body);
  if (row === 'allowed') await auditActivation(slug);
  const [pins] = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM harness_shared.plan_type_pins
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
  expect(pins!.n, 'the plan must be unpinned, as one activated by a build that did not pin').toBe(0);
  return slug;
}

const EXPECTED: Record<Row, string | null> = {
  nodecision: 'verification_lowering_requires_decision',
  staleaudit: 'verification_lowering_requires_fresh_activation_audit',
  allowed: null,
};

async function retiredAt(id: string, revision: number): Promise<Date | null> {
  const [row] = await admin<{ retired_at: Date | null }[]>`
    SELECT retired_at FROM harness_shared.plan_item_type_definitions
     WHERE workspace_id = ${WS} AND type_id = ${id} AND revision = ${revision}`;
  return row?.retired_at ?? null;
}

describe('R-8: retiring the revision an unpinned activated plan resolves', () => {
  // Revision 2 adds the code module; retiring it falls back to revision 1, which drops it.
  for (const row of ['nodecision', 'staleaudit', 'allowed'] as const) {
    it(`${row}: ${EXPECTED[row] ?? 'allowed'}`, async () => {
      const id = `${NS}/ret-${row}`;
      await insertDefinition('plan_item_type_definitions', itemTypeDef(id, 1, ['generic-core']));
      await insertDefinition('plan_item_type_definitions', itemTypeDef(id, 2, ['generic-core', 'code']));
      await rowPlan('retire', row, id, {
        title: `Retire ${id} revision 2`,
        body: `${id} revision 2 is retired, so P-001 falls back to revision 1 and its type no longer needs the code module.`,
      });
      const res = await call('plan-types:retire', { kind: 'item-type', typeId: id, revision: 2, reason: 'escape test' });
      if (EXPECTED[row]) {
        expectRefused(res, EXPECTED[row]!);
        expect(await retiredAt(id, 2)).toBeNull();
      } else {
        expect(res.payload?.ok, brief({ payload: res.payload, error: res.d.error })).toBe(true);
        expect(await retiredAt(id, 2)).not.toBeNull();
      }
    });
  }
});

describe('R-8: defining a smaller revision of a parent reached through extends', () => {
  // The child adds nothing itself; its code module comes from the parent's revision 1.
  for (const row of ['nodecision', 'staleaudit', 'allowed'] as const) {
    it(`${row}: ${EXPECTED[row] ?? 'allowed'}`, async () => {
      const parent = `${NS}/par-${row}`;
      const child = `${NS}/kid-${row}`;
      await insertDefinition('plan_item_type_definitions', itemTypeDef(parent, 1, ['generic-core', 'code']));
      await insertDefinition('plan_item_type_definitions', itemTypeDef(child, 1, ['generic-core'], { extends: { id: parent } }));
      await rowPlan('extends', row, child, {
        title: `New revision of ${parent}`,
        body: `${parent} revision 2 drops the code module, so the type of P-001 (${child}) no longer requires code.`,
      });
      const res = await call('plan-types:define', {
        kind: 'item-type',
        definition: itemTypeDef(parent, 2, ['generic-core']),
      });
      const [stored] = await admin<{ n: number }[]>`
        SELECT count(*)::int AS n FROM harness_shared.plan_item_type_definitions
         WHERE workspace_id = ${WS} AND type_id = ${parent} AND revision = 2`;
      if (EXPECTED[row]) {
        expectRefused(res, EXPECTED[row]!);
        expect(stored!.n).toBe(0);
      } else {
        expect(res.payload?.ok, brief({ payload: res.payload, error: res.d.error })).toBe(true);
        expect(stored!.n).toBe(1);
      }
    });
  }
});

describe('R-8: moving an activated plan pin to a smaller revision', () => {
  for (const row of ['nodecision', 'staleaudit', 'allowed'] as const) {
    it(`${row}: ${EXPECTED[row] ?? 'allowed'}`, async () => {
      const id = `${NS}/pin-${row}`;
      await insertDefinition('plan_item_type_definitions', itemTypeDef(id, 1, ['generic-core', 'code']));
      const slug = await rowPlan('pin', row, id, {
        title: `Re-pin ${id}`,
        body: `P-001 moves to ${id} revision 2, whose type no longer requires the code module.`,
      });
      // Pinning to the revision the plan resolves today changes nothing, so it needs no Decision.
      const hold = await call('plan-types:pin', { slug, kind: 'item-type', typeId: id, revision: 1, reason: 'hold' });
      expect(hold.payload?.ok, brief({ payload: hold.payload, error: hold.d.error })).toBe(true);
      // A smaller revision is inert for the pinned plan, so defining it is allowed.
      const defined = await call('plan-types:define', { kind: 'item-type', definition: itemTypeDef(id, 2, ['generic-core']) });
      expect(defined.payload?.ok, brief({ payload: defined.payload, error: defined.d.error })).toBe(true);
      // The pin writes above leave the plan body alone, so the audit freshness rowPlan set holds.
      const res = await call('plan-types:pin', { slug, kind: 'item-type', typeId: id, revision: 2, reason: 'escape test' });
      const [pin] = await admin<{ revision: number }[]>`
        SELECT revision FROM harness_shared.plan_type_pins
         WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug} AND type_id = ${id}`;
      if (EXPECTED[row]) {
        expectRefused(res, EXPECTED[row]!);
        expect(Number(pin!.revision)).toBe(1);
      } else {
        expect(res.payload?.ok, brief({ payload: res.payload, error: res.d.error })).toBe(true);
        expect(Number(pin!.revision)).toBe(2);
      }
    });
  }
});

describe('R-8: a same-id Cupboard pack install of a smaller revision (P-006, D-005)', () => {
  // A type pack ships revision 2 of an item type that an unpinned activated plan resolves at
  // revision 1 with the code module. Revision 2 drops it, so installing the pack would lower the
  // plan through the 'install' registry route, which runs the same shrink check as a define.
  for (const row of ['nodecision', 'staleaudit', 'allowed'] as const) {
    it(`${row}: ${EXPECTED[row] ?? 'allowed'}`, async () => {
      const id = `${NS}/inst-${row}`;
      await insertDefinition('plan_item_type_definitions', itemTypeDef(id, 1, ['generic-core', 'code']));
      await rowPlan('install', row, id, {
        title: `Install ${id} revision 2 from a Cupboard pack`,
        body: `The pack ships ${id} revision 2, so P-001 resolves to revision 2 and its type no longer needs the code module.`,
      });
      const listingId = `${NS}-pack-${row}`;
      const result = await installTypePack(
        admin,
        {
          listing: {
            listingId,
            reviewStatus: 'approved',
            pin: { commitSha: 'c'.repeat(40), treeDigest: 'd'.repeat(64) },
            providesItemTypes: [{ id, revision: 2 }],
            providesPlanTypes: [],
          },
          manifest: { name: listingId, version: '1.0.0', typePack: { itemTypes: [itemTypeDef(id, 2, ['generic-core'])] } },
        },
        { workspaceId: WS, installedBy: 'item-type-escape-test' },
        {
          findProviders: async () => [],
          fetchPack: async () => { throw new Error('no dependency pack in this test'); },
          provisionRubric: async () => {},
        },
      );
      const revisions = await admin<{ revision: number }[]>`
        SELECT revision FROM harness_shared.plan_item_type_definitions
         WHERE workspace_id = ${WS} AND type_id = ${id} ORDER BY revision`;
      const [receipt] = await admin<{ n: number }[]>`
        SELECT count(*)::int AS n FROM harness_shared.type_pack_installations
         WHERE workspace_id = ${WS} AND listing_id = ${listingId}`;
      if (EXPECTED[row]) {
        expect(result.ok, brief(result)).toBe(false);
        expect(!result.ok && result.code).toBe('type_pack_definition_refused');
        expect(!result.ok && result.cause?.code).toBe(EXPECTED[row]);
        expect(revisions.map((r) => Number(r.revision))).toEqual([1]);
        expect(receipt!.n).toBe(0);
      } else {
        expect(result.ok, brief(result)).toBe(true);
        expect(revisions.map((r) => Number(r.revision))).toEqual([1, 2]);
        expect(receipt!.n).toBe(1);
      }
    });
  }
});
