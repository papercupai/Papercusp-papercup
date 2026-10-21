/**
 * R-14: a plan keeps the type revisions it activated with
 * (plan-item-types-registry-cupboard-2026-10-20 P-005, D-006).
 *
 * Against an isolated integration PG, through the real plan writes and doors:
 * - activation pins the plan type and every item type the plan resolves, keyed by id, revision
 *   and content hash;
 * - after revision 2 of the item type (a smaller module set and a different completion schema)
 *   and of the plan type (a non-code default item type) are defined, the activated plan's start
 *   door, ship door, completion code-ness check, completion-fields check (work_items:complete's
 *   R-10 schema) and plans:get item-type checklist judge it exactly as before, while a plan
 *   activated after revision 2 is judged under revision 2;
 * - re-running migration 1545's backfill on a plan activated without pins pins it to the
 *   first-party revision, and never moves a pin a plan already holds.
 *
 * The completion-fields and checklist legs arrived with P-004, which added those checks
 * (plan-item-types-registry-cupboard-2026-10-20#D-007).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { dispatchProjectedTool, lookupByMcpName } from '@papercusp/agent-mcp';

// The fixture harness has no registered source root, so plans:audit would refuse with
// harness_repo_unresolved before judging any item. Root SELECTION is configuration, not the
// subject: point it at the canonical repo root through the function's own no-harness branch, as
// general-plan-ship.integration.test.ts does. Item judgement against the pins stays real.
vi.mock('../../../plan-audits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../plan-audits')>();
  return {
    ...actual,
    repoCitationContextForHarness: (_harnessSlug: unknown, citations?: Parameters<typeof actual.repoCitationContextForHarness>[1]) =>
      actual.repoCitationContextForHarness(null, citations),
  };
});

type Resolved = { code: boolean; modules: string[] };
const probe = vi.hoisted(() => ({
  itemType: '',
  seen: [] as Array<{ planSlug: string; item: { code: boolean; modules: string[] }; planDefault: { code: boolean; modules: string[] } }>,
}));

// Observes, never alters: records what the resolver a door installed through
// withPinnedPlanTypes answers while that door runs, then runs the door unchanged.
vi.mock('../../../plan-types/pins', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../plan-types/pins')>();
  const { resolveVerification } = await import('../../../plan-verification-profile');
  return {
    ...actual,
    withPinnedPlanTypes: <T>(
      scope: { workspaceId?: string; harnessSlug?: string; planSlug: string },
      fn: () => Promise<T>,
    ): Promise<T> =>
      actual.withPinnedPlanTypes(scope, async () => {
        const item = resolveVerification({ verificationProfile: 'general' }, { deliverable: probe.itemType });
        const planDefault = resolveVerification({ verificationProfile: 'general' }, {});
        probe.seen.push({
          planSlug: scope.planSlug,
          item: { code: item.codeDeliverable, modules: [...item.modules] },
          planDefault: { code: planDefault.codeDeliverable, modules: [...planDefault.modules] },
        });
        return fn();
      }),
  };
});

import '../define';
import '../../plans/new';
import '../../plans/add-item';
import '../../plans/set-content';
import '../../plans/set-status';
import '../../plans/set-plan-status';
import '../../plans/get';
import '../../plans/audit';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { runWithWorkspace } from '../../../workspace-als';
import { definitionContentHash } from '../../../plan-types/content-hash';
import { loadTypeRegistry } from '../../../plan-types/registry';
import { readCloseDeliverablesAreNonCode } from '../../../plan-verification-escape';
import { readCloseItemTypeFieldsRefusal, type TypeFieldsRefusal } from '../../../plan-types/item-type-contract';
import { withPlanLock } from '../../plans/with-plan-lock';
import { hashPlanContent } from '../../plans/content-hash';
import { checkPlanStartable } from '../../plans/plan-start-gate';
import { setupPlanPgFixture, cleanupPlans, registerHarnessProject, type PlanPgFixture } from '../../plans/__tests__/_pg-tool-fixture';
import { brief, expectOk, makeCaller } from './_tool-call';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-ptpin-${RUN}`;
const WS = DEFAULT_WORKSPACE_ID;
const NS = `zzz-ptpin-${Math.random().toString(36).slice(2, 8)}`;
const ITEM = `${NS}/clause`; // P-001's declared item type
const STEP = `${NS}/build-step`; // the plan type's revision-1 default item type (P-002)
const PLAN_TYPE = `${NS}/build`;
const PARENT = `${NS}/parent-clause`; // reached only through CHILD's `extends`
const CHILD = `${NS}/child-clause`;
const RUBRIC_GATE_ENV = 'PAPERCUSP_FLAG_PAPERCUSP_ACCEPTANCE_RUBRIC_COMPLETION_GATE';

const MIGRATION_1545 = fileURLToPath(
  new URL('../../../../../../libs/papercusp/libs/db/sql/1545-plan-type-pins.sql', import.meta.url),
);

const call = makeCaller(HARNESS, 'plan-types-revision-pinning');
let fx: PlanPgFixture;
let admin: postgres.Sql;

const itemV1 = {
  schemaVersion: 1,
  id: ITEM,
  revision: 1,
  title: 'Contract clause',
  modules: ['code', 'generic-core'],
  completion: { schema: { type: 'object', required: ['clauseRef'], properties: { clauseRef: { type: 'string' } } } },
};
// Revision 2: a smaller module set and a different completion schema.
const itemV2 = {
  ...itemV1,
  revision: 2,
  modules: ['generic-core'],
  completion: { schema: { type: 'object', required: ['memoRef'], properties: { memoRef: { type: 'string' } } } },
};
const stepV1 = { schemaVersion: 1, id: STEP, revision: 1, title: 'Build step', modules: ['code', 'generic-core'] };
const planTypeV1 = {
  schemaVersion: 1,
  id: PLAN_TYPE,
  revision: 1,
  title: 'Build plan',
  base: 'general',
  classes: ['plan-class-feature-ship'],
  defaultItemType: { id: STEP },
  itemTypes: [{ id: ITEM }, { id: STEP }, { id: 'papercusp/doc' }],
};
// Revision 2: items that declare no type default to a document, so the plan resolves fewer modules.
const planTypeV2 = { ...planTypeV1, revision: 2, defaultItemType: { id: 'papercusp/doc' } };

const DECLARATIONS =
  '\n## Existing infrastructure reused\n\n```reuse\n' +
  '{"searched":[],"reused":[],"newSurfaces":[],"notApplicable":"Test fixture; no code surface."}\n```\n' +
  '\n## Third-party libraries\n\n```libraries\n{"needs":[],"notApplicable":"Test fixture; no library need."}\n```\n';

/** Content hash plan-types:define returned for each stored `${id}@${revision}`. */
const definedHash = new Map<string, string>();

async function define(
  kind: 'item-type' | 'plan-type',
  definition: { id: string; revision: number } & Record<string, unknown>,
): Promise<void> {
  const defined = expectOk(await call('plan-types:define', { kind, definition }));
  expect(defined.revision).toBe(definition.revision);
  expect(defined.contentHash).toBe(definitionContentHash(definition));
  definedHash.set(`${definition.id}@${definition.revision}`, defined.contentHash as string);
}

function first(payload: Record<string, unknown> | null): Record<string, unknown> {
  const results = payload?.results as Array<Record<string, unknown>> | undefined;
  return results?.[0] ?? payload ?? {};
}

async function planContent(slug: string): Promise<string> {
  const [row] = await admin<{ content: string }[]>`
    SELECT content FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
  expect(row, `plan ${slug} must exist`).toBeTruthy();
  return row!.content;
}

async function recordAudit(slug: string, kind: 'activation' | 'completion', seq: number): Promise<void> {
  const body = await planContent(slug);
  const activation = kind === 'activation'
    ? JSON.stringify({ sourceRanges: [], mappings: [], repairedOmissions: [], rejectedOrSuperseded: [], unresolvedBlockers: [] })
    : null;
  // Generic evidence only: an external snapshot, no code or test citation.
  const items = kind === 'completion'
    ? JSON.stringify(['P-001', 'P-002'].map((itemId) => ({
        itemId,
        verdict: 'implemented',
        note: 'R-14 fixture: generic evidence only',
        auditedAt: new Date().toISOString(),
        citations: [{ kind: 'external', url: 'https://example.com/r14-runbook', snapshotHash: 'a'.repeat(64) }],
      })))
    : '[]';
  const revisionRef = kind === 'activation' ? seq : null;
  await admin`
    INSERT INTO harness_shared.plan_audits
      (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind,
       activation, audited_plan_revision_id, audited_plan_revision_seq,
       audited_plan_content_hash, items, findings)
    VALUES
      (${WS}, ${HARNESS}, ${slug}, ${seq}, 'su-test', ${kind},
       ${activation}::text::jsonb, ${revisionRef}, ${revisionRef},
       ${hashPlanContent(body)}, ${items}::text::jsonb, '[]'::jsonb)`;
}

/**
 * A plan of type PLAN_TYPE whose P-001 declares ITEM and whose P-002 takes the plan type's
 * default, activated (draft -> ready) through the real plan write, which pins what it resolves.
 */
async function activatedPlan(name: string, opts: { typed?: boolean; deliverable?: string } = { typed: true }): Promise<string> {
  const slug = `r14-${name}-${RUN}-2026-01-01`;
  expectOk(await call('plans:new', {
    slug,
    title: `R-14 ${name}`,
    verificationProfile: 'general',
    force: true,
    content: `## Phase 1\n${DECLARATIONS}`,
  }));
  if (opts.typed !== false) {
    const content = (await planContent(slug)).replace(/^(slug: .*)$/m, `$1\ntype: ${PLAN_TYPE}`);
    expectOk(await call('plans:set-content', { slug, content }));
  }
  expectOk(await call('plans:add-item', {
    slug,
    phase: 'Phase 1',
    importance: 'normal',
    items: opts.typed !== false
      ? [{ text: 'Draft the clause', deliverable: ITEM }, { text: 'Build the step' }]
      : [{ text: 'Write the summary', ...(opts.deliverable ? { deliverable: opts.deliverable } : {}) }],
  }));
  await recordAudit(slug, 'activation', 1);
  const flipped = await runWithWorkspace(WS, () => withPlanLock<{ ok: true }>(
    {} as never,
    { slug, harnessSlug: HARNESS, workspaceId: WS, intent: 'R-14 activation' },
    async (current) => ({ newBody: current!.replace(/^status: draft$/m, 'status: ready'), value: { ok: true } }),
  ));
  expect(flipped, brief(flipped)).toMatchObject({ kind: 'applied', value: { ok: true } });
  expect(await planContent(slug)).toMatch(/^status: ready$/m);
  return slug;
}

/** Both items delivered, then one completion audit citing only generic evidence. */
async function deliver(slug: string): Promise<void> {
  for (const item of ['P-001', 'P-002']) {
    const res = await call('plans:set-status', { slug, item, status: 'done', note: 'fixture: delivered' });
    expect(first(res.payload).ok, brief({ payload: res.payload, error: res.d.error })).toBe(true);
  }
  await recordAudit(slug, 'completion', 2);
}

async function pins(slug: string): Promise<Map<string, { revision: number; hash: string }>> {
  const rows = await admin<{ kind: string; type_id: string; revision: number; content_hash: string }[]>`
    SELECT kind, type_id, revision, content_hash FROM harness_shared.plan_type_pins
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
  return new Map(rows.map((r) => [`${r.kind}:${r.type_id}`, { revision: Number(r.revision), hash: r.content_hash }]));
}

/** What the start door's pinned resolver answers for P-001 (ITEM) and for an untyped item. */
async function startDoor(slug: string): Promise<{ item: Resolved; planDefault: Resolved }> {
  probe.itemType = ITEM;
  probe.seen.length = 0;
  await runWithWorkspace(WS, () => checkPlanStartable(slug, { harnessSlug: HARNESS }, null, 'start'));
  const seen = probe.seen.filter((s) => s.planSlug === slug);
  expect(seen.length, 'the start door must judge the plan under withPinnedPlanTypes').toBeGreaterThan(0);
  return { item: seen[0]!.item, planDefault: seen[0]!.planDefault };
}

/**
 * The ship door's refusal, with every blocker it collected. The acceptance-rubric family
 * (rubric, BAR contract, vetting, grading) is profile-independent and refuses these fixture plans
 * before the code-truth checks run, so it is switched off through its env override for the call,
 * as general-plan-ship.integration.test.ts does. Every code-truth check still runs for real.
 */
async function shipDoor(slug: string): Promise<string> {
  const prev = process.env[RUBRIC_GATE_ENV];
  process.env[RUBRIC_GATE_ENV] = '0';
  try {
    const res = await call('plans:set-plan-status', { slug, status: 'shipped' });
    expect(first(res.payload).ok === true, brief(res.payload)).toBe(false);
    return JSON.stringify({ payload: res.payload, error: res.d.error });
  } finally {
    if (prev === undefined) delete process.env[RUBRIC_GATE_ENV];
    else process.env[RUBRIC_GATE_ENV] = prev;
  }
}

/**
 * The ship verdict a display shows OUTSIDE the ship door: the sync resolver behind plans:get
 * shipReadiness, derivedStatus and the UI (WI-6554700010018901). Same rubric switch as shipDoor.
 */
async function displayGate(slug: string): Promise<{ verdict: string; resolved: { item: Resolved; planDefault: Resolved } }> {
  const { resolvePlanAcceptanceGateVerdict } = await import('../../../sync-resolver/plan-acceptance-gate-verdict');
  const prev = process.env[RUBRIC_GATE_ENV];
  process.env[RUBRIC_GATE_ENV] = '0';
  probe.itemType = ITEM;
  probe.seen.length = 0;
  try {
    const rows = await runWithWorkspace(WS, () =>
      resolvePlanAcceptanceGateVerdict({ workspaceId: WS, harnessSlug: HARNESS, planSlug: slug }),
    );
    const row = rows[0] as { code: string | null; message: string | null; unavailableReason?: string | null };
    expect(row.unavailableReason ?? null, brief(row)).toBeNull();
    // The row carries only the FIRST refusal, and on these fixtures that is audit coverage, which
    // does not depend on code-ness. So the display's pinned resolution is observed directly, the
    // same way startDoor observes the start door's.
    const seen = probe.seen.filter((s) => s.planSlug === slug);
    expect(seen.length, 'the display verdict must judge the plan under withPinnedPlanTypes').toBeGreaterThan(0);
    return {
      // The first refusal plus its message, with the slug normalised so two plans compare.
      verdict: JSON.stringify({ code: row.code, message: (row.message ?? '').split(slug).join('<plan>') }),
      resolved: { item: seen[0]!.item, planDefault: seen[0]!.planDefault },
    };
  } finally {
    if (prev === undefined) delete process.env[RUBRIC_GATE_ENV];
    else process.env[RUBRIC_GATE_ENV] = prev;
  }
}

/** Whether work_items:complete would judge each item's close as non-code. */
async function completionNonCode(slug: string): Promise<{ p001: boolean; p002: boolean }> {
  const read = (itemId: string) => runWithWorkspace(WS, () => readCloseDeliverablesAreNonCode({
    workspaceId: WS, harnessSlug: HARNESS, planSlug: slug, planItemIds: [itemId],
  }));
  return { p001: await read('P-001'), p002: await read('P-002') };
}

/** work_items:complete's completion-fields check (R-10) for a close of P-001 carrying `typeFields`. */
async function closeFieldsRefusal(slug: string, typeFields: Record<string, unknown>): Promise<TypeFieldsRefusal | null> {
  return runWithWorkspace(WS, () => readCloseItemTypeFieldsRefusal({
    workspaceId: WS, harnessSlug: HARNESS, planSlug: slug, planItemIds: ['P-001'], typeFields,
  }));
}

function findKey(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  if (key in value) return (value as Record<string, unknown>)[key];
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findKey(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** P-001's entry in the item-type checklist plans:get renders (verification.itemTypes). */
async function checklistFor(slug: string): Promise<Record<string, unknown> | undefined> {
  const got = await call('plans:get', { slug });
  const verification = findKey(got.payload, 'verification') as
    | { itemTypes?: Array<Record<string, unknown>> | null }
    | undefined;
  expect(Array.isArray(verification?.itemTypes), brief(got.payload)).toBe(true);
  return verification!.itemTypes!.find((entry) => entry.itemId === 'P-001');
}

/**
 * A plans:audit completion pass marking both items implemented on generic evidence only. It is
 * dispatched with an agent principal, because plans:audit attributes its write.
 */
async function auditCompletion(slug: string): Promise<Record<string, unknown>> {
  const projected = lookupByMcpName('plans:audit');
  expect(projected, 'plans:audit must be registered in the projection registry').toBeTruthy();
  const ctx = {
    workspaceId: WS,
    harnessSlug: HARNESS,
    runId: 'plan-types-revision-pinning',
    role: 'su',
    principal: { kind: 'agent', slug: 'su-ptpin-auditor', workspaceId: WS },
    gateBypass: { role: true, capability: true, quota: true },
    transport: 'mcp',
    requestedFormat: 'json',
    requestedStructured: true,
  } as never;
  const d = await runWithWorkspace(WS, () => dispatchProjectedTool(projected!, 'plans:audit', {
    harness: HARNESS,
    slug,
    phase: 'completion',
    items: ['P-001', 'P-002'].map((itemId) => ({
      itemId,
      verdict: 'implemented',
      citations: [{ kind: 'external', url: 'https://example.com/r14-runbook', snapshotHash: 'a'.repeat(64) }],
    })),
  }, ctx, {}));
  const result = d.result as { structuredContent?: unknown; content?: Array<{ text?: string }> } | undefined;
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    return first(result.structuredContent as Record<string, unknown>);
  }
  const text = result?.content?.[0]?.text ?? '';
  try {
    return first(JSON.parse(text) as Record<string, unknown>);
  } catch {
    return { text };
  }
}

/** The items a plans:audit result refused as `implemented_without_code`. */
function withoutCode(audit: Record<string, unknown>): string[] {
  const problems = (findKey(audit, 'problems') as Array<{ itemId?: string; code?: string }> | undefined) ?? [];
  return problems.filter((p) => p.code === 'implemented_without_code').map((p) => p.itemId ?? '').sort();
}

beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  admin = fx.admin;
  await registerHarnessProject(admin, WS, HARNESS);
  await define('item-type', itemV1);
  await define('item-type', stepV1);
  await define('plan-type', planTypeV1);
}, 180_000);

afterAll(async () => {
  if (admin) {
    await admin`DELETE FROM harness_shared.plan_type_pins WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`.catch(() => {});
    await admin`DELETE FROM harness_shared.plan_audits WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`.catch(() => {});
    await admin`DELETE FROM harness_shared.plan_item_type_definitions WHERE workspace_id = ${WS} AND type_id LIKE ${`${NS}/%`}`.catch(() => {});
    await admin`DELETE FROM harness_shared.plan_type_definitions WHERE workspace_id = ${WS} AND type_id LIKE ${`${NS}/%`}`.catch(() => {});
    await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  }
  await fx?.dispose();
});

describe('R-14: a plan keeps the type revisions it activated with', () => {
  let planA = '';

  it('activation pins the plan type and every item type it resolves, by id, revision and content hash', async () => {
    planA = await activatedPlan('a');
    const pinned = await pins(planA);
    expect(pinned.get(`plan-type:${PLAN_TYPE}`)).toEqual({ revision: 1, hash: definedHash.get(`${PLAN_TYPE}@1`) });
    expect(pinned.get(`item-type:${ITEM}`)).toEqual({ revision: 1, hash: definedHash.get(`${ITEM}@1`) });
    expect(pinned.get(`item-type:${STEP}`)).toEqual({ revision: 1, hash: definedHash.get(`${STEP}@1`) });
  }, 120_000);

  it('revision 2 leaves the start, ship and completion checks on revision 1; a plan activated after it gets revision 2', async () => {
    expect(planA, 'the activation case must run first').not.toBe('');
    await deliver(planA);

    const startBefore = await startDoor(planA);
    expect(startBefore.item.code, brief(startBefore)).toBe(true);
    expect(startBefore.planDefault.code, brief(startBefore)).toBe(true);
    const shipBefore = await shipDoor(planA);
    expect(shipBefore).toContain('code_deliverable_unverified');
    const displayBefore = await displayGate(planA);
    // WI-6554700010018901: the display resolves what the start and ship doors resolve.
    expect(displayBefore.resolved, brief(displayBefore)).toEqual(startBefore);
    const closeBefore = await completionNonCode(planA);
    expect(closeBefore).toEqual({ p001: false, p002: false });
    // D-007: revision 1's completion schema asks a close of P-001 for clauseRef (revision 2 asks
    // for memoRef), and plans:get lists P-001's item type at revision 1.
    expect(await closeFieldsRefusal(planA, { clauseRef: 'clause-1' })).toBeNull();
    const fieldsBefore = await closeFieldsRefusal(planA, { memoRef: 'memo-1' });
    expect(fieldsBefore).toMatchObject({ code: 'item_type_fields_invalid', itemId: 'P-001', itemType: ITEM, revision: 1 });
    const checklistBefore = await checklistFor(planA);
    expect(checklistBefore).toMatchObject({ itemId: 'P-001', itemType: ITEM, revision: 1, completion: { kind: 'schema' } });

    // The shrink check (D-006) judges unpinned activated plans only, so a pinned plan never
    // stops a newer revision from being defined.
    await define('item-type', itemV2);
    await define('plan-type', planTypeV2);

    const pinnedAfter = await pins(planA);
    expect(pinnedAfter.get(`item-type:${ITEM}`)).toEqual({ revision: 1, hash: definedHash.get(`${ITEM}@1`) });
    expect(pinnedAfter.get(`plan-type:${PLAN_TYPE}`)).toEqual({ revision: 1, hash: definedHash.get(`${PLAN_TYPE}@1`) });

    expect(await startDoor(planA)).toEqual(startBefore);
    expect(await shipDoor(planA)).toContain('code_deliverable_unverified');
    // WI-6554700010018901: the display verdict (plans:get shipReadiness) stays on revision 1, as the
    // ship door does: the same refusal, and the same pinned code-ness and module set.
    expect(await displayGate(planA)).toEqual(displayBefore);
    expect(await completionNonCode(planA)).toEqual(closeBefore);
    expect(await closeFieldsRefusal(planA, { clauseRef: 'clause-1' })).toBeNull();
    expect(await closeFieldsRefusal(planA, { memoRef: 'memo-1' })).toEqual(fieldsBefore);
    expect(await checklistFor(planA)).toEqual(checklistBefore);
    // WI-6554700010018900: plans:audit judges planA on revision 1 too. Revision 1 requires code for P-001 and for the
    // plan type's default item type, so generic evidence alone cannot mark either implemented.
    const auditA = await auditCompletion(planA);
    expect(withoutCode(auditA), brief(auditA)).toEqual(['P-001', 'P-002']);

    // Counterfactual: the same plan activated after revision 2 resolves revision 2, so the
    // revisions differ in what every one of those checks sees.
    const planB = await activatedPlan('b');
    const pinnedB = await pins(planB);
    expect(pinnedB.get(`item-type:${ITEM}`)).toEqual({ revision: 2, hash: definedHash.get(`${ITEM}@2`) });
    expect(pinnedB.get(`plan-type:${PLAN_TYPE}`)).toEqual({ revision: 2, hash: definedHash.get(`${PLAN_TYPE}@2`) });
    await deliver(planB);
    const startB = await startDoor(planB);
    expect(startB.item.code, brief(startB)).toBe(false);
    expect(startB.planDefault.code, brief(startB)).toBe(false);
    expect(await shipDoor(planB)).not.toContain('code_deliverable_unverified');
    // The counterfactual: on revision 2 the display resolves differently, so the equality above is a
    // real check. (The first refusal itself is audit coverage for both plans, so it cannot differ.)
    const displayB = await displayGate(planB);
    expect(displayB.resolved, brief(displayB)).toEqual(startB);
    expect(displayB.resolved).not.toEqual(displayBefore.resolved);
    expect(await completionNonCode(planB)).toEqual({ p001: true, p002: true });
    expect(await closeFieldsRefusal(planB, { memoRef: 'memo-1' })).toBeNull();
    expect(await closeFieldsRefusal(planB, { clauseRef: 'clause-1' })).toMatchObject({
      code: 'item_type_fields_invalid', itemId: 'P-001', itemType: ITEM, revision: 2,
    });
    expect(await checklistFor(planB)).toMatchObject({ itemId: 'P-001', itemType: ITEM, revision: 2, completion: { kind: 'schema' } });
    const auditB = await auditCompletion(planB);
    expect(auditB.ok, brief(auditB)).toBe(true);
    expect(withoutCode(auditB)).toEqual([]);
  }, 300_000);

  it('a plan activated before the registry backfills to the first-party revision, and no held pin moves', async () => {
    expect(planA, 'the activation case must run first').not.toBe('');
    const legacy = await activatedPlan('legacy', { typed: false });
    // As a plan activated by a build that predates the registry: activated, with no pins.
    await admin`DELETE FROM harness_shared.plan_type_pins
                 WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${legacy}`;
    expect((await pins(legacy)).size).toBe(0);

    const migration = readFileSync(MIGRATION_1545, 'utf8');
    const start = migration.indexOf('INSERT INTO harness_shared.plan_type_pins');
    expect(start, 'migration 1545 must carry the legacy backfill').toBeGreaterThan(-1);
    await admin.unsafe(migration.slice(start, migration.indexOf(';', start) + 1));

    const registry = await loadTypeRegistry(admin, { workspaceId: WS });
    const firstParty = [
      ...['code', 'doc', 'decision', 'research', 'operation', 'artifact'].map((k) => ({ kind: 'item-type', id: `papercusp/${k}` })),
      ...['coding', 'general'].map((k) => ({ kind: 'plan-type', id: `papercusp/${k}` })),
    ];
    const pinnedLegacy = await pins(legacy);
    expect(pinnedLegacy.size).toBe(firstParty.length);
    for (const { kind, id } of firstParty) {
      const registered = kind === 'item-type' ? registry.itemType(id) : registry.planType(id);
      expect(registered?.origin, id).toBe('builtin');
      expect(pinnedLegacy.get(`${kind}:${id}`), id).toEqual({
        revision: 1,
        hash: definitionContentHash(registered!.definition),
      });
    }

    // Insert-if-absent: the backfill never moves a pin an activated plan already holds.
    expect((await pins(planA)).get(`item-type:${ITEM}`)).toEqual({ revision: 1, hash: definedHash.get(`${ITEM}@1`) });
  }, 180_000);

  // WI-6554700010018967 (D-006): pins.ts pins each parent reached through `extends`.
  it('activation pins each parent an item type reaches through extends, and the plan keeps that revision', async () => {
    const parentV1 = { schemaVersion: 1, id: PARENT, revision: 1, title: 'Parent clause', modules: ['code', 'generic-core'] };
    await define('item-type', parentV1);
    await define('item-type', {
      schemaVersion: 1, id: CHILD, revision: 1, title: 'Child clause', modules: ['generic-core'], extends: { id: PARENT },
    });
    const slug = await activatedPlan('extends', { typed: false, deliverable: CHILD });
    const pinned = await pins(slug);
    expect(pinned.get(`item-type:${CHILD}`), brief([...pinned])).toEqual({ revision: 1, hash: definedHash.get(`${CHILD}@1`) });
    expect(pinned.get(`item-type:${PARENT}`), brief([...pinned])).toEqual({ revision: 1, hash: definedHash.get(`${PARENT}@1`) });

    const nonCode = () => runWithWorkspace(WS, () => readCloseDeliverablesAreNonCode({
      workspaceId: WS, harnessSlug: HARNESS, planSlug: slug, planItemIds: ['P-001'],
    }));
    // The child inherits its parent's code module.
    expect(await nonCode()).toBe(false);

    // Parent revision 2 drops code. The child's own definition is unchanged, so only the parent's
    // pin keeps the plan on what it activated with.
    await define('item-type', { ...parentV1, revision: 2, modules: ['generic-core'] });
    expect((await pins(slug)).get(`item-type:${PARENT}`)).toEqual({ revision: 1, hash: definedHash.get(`${PARENT}@1`) });
    expect(await nonCode()).toBe(false);
  }, 180_000);
});
