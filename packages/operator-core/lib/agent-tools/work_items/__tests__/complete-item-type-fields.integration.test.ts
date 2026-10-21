/**
 * R-10 (plan-item-types-registry-cupboard-2026-10-20 P-004), on real Postgres:
 * `work_items:complete` validates `completion.typeFields` against the completion schema of the
 * linked plan item's registry item type. The schema is given inline, or by a datatype reference
 * resolved through the workspace datatype registry. A reference that does not resolve, or a
 * schema that cannot compile, refuses the close. Every refusal happens before any completion
 * write, so the stored work item keeps its pre-close state.
 *
 * Each case dispatches the real tool handler. Plans and plan items are seeded as rows, and the
 * item types are stored through the same authoring path `plan-types:define` uses.
 */
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../../../test/_org-test-db';

const fixture = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));

vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: fixture.sql }),
  withWorkspace: async <T>(workspaceId: string, callback: (sql: postgres.Sql) => Promise<T>): Promise<T> =>
    fixture.sql.begin(async (transaction) => {
      await transaction`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return callback(transaction as unknown as postgres.Sql);
    }) as Promise<T>,
}));

vi.mock('../../../work-item-lock-release', () => ({
  releaseReclaimedWorkItemLocks: async () => ({ releases: [], failures: 0, skipped: null }),
}));

const { createOrgTestDb } = await import('../../../../test/_org-test-db');
const { activeWorkspaceId } = await import('../../../workspace-registry');
const { createWorkItem, getWorkItem } = await import('../../../work-items');
const { drainDetached } = await import('../../../detached-imports');
const { upsertDatatype } = await import('../../../datatype-registry-store');
const { defineTypeDefinition } = await import('../../../plan-types/authoring');
const { default: complete } = await import('../complete');

const OWNER = 'su-complete-item-type-fields-fixture';
const HARNESS = 'papercusp';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const NS = `zzz-itf-${RUN}`;

const MEMO_DATATYPE = `zzz-itf-review-${RUN}`;
const BROKEN_DATATYPE = `zzz-itf-broken-${RUN}`;
const MISSING_DATATYPE = `zzz-itf-missing-${RUN}`;

/** Inline completion schema: the close must name the memo it produced. */
const INLINE = `${NS}/memo`;
/** Completion schema by datatype reference: the close must name a reviewer. */
const BY_REF = `${NS}/reviewed-memo`;
/** A datatype reference nothing in the workspace installs. */
const DANGLING = `${NS}/dangling`;
/** A datatype reference whose payload schema cannot compile. */
const BROKEN = `${NS}/broken`;

function itemType(id: string, completion: Record<string, unknown>) {
  return { schemaVersion: 1, id, revision: 1, title: id, modules: ['generic-core'], completion };
}

type Result = {
  ok?: boolean;
  error?: unknown;
  completionAuthority?: string;
  itemTypeFieldsRefusal?: { code?: string; itemId?: string; itemType?: string; revision?: number; planSlug?: string; errors?: string[] };
};

let db: OrgTestDb;
let planSeq = 0;

async function seedPlanItem(deliverable: string | null): Promise<string> {
  planSeq += 1;
  const slug = `zzz-item-type-fields-${RUN}-${planSeq}`;
  const content = `# Item type fields fixture ${planSeq}\n\n## Items\n\n- [ ] **P-001** Write the decision memo.\n`;
  await db.adminSql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
       created, updated, owner, archived, template, origin,
       verification_profile, verification_profile_source)
    VALUES (${activeWorkspaceId()}, ${HARNESS}, ${slug}, ${content}, md5(${content}), 1,
            ${`Item type fields fixture ${planSeq}`}, 'active', '2026-10-21', '2026-10-21',
            ${OWNER}, false, NULL, 'local', 'general', 'declared')`;
  await db.adminSql`
    INSERT INTO harness_shared.plan_items
      (workspace_id, harness_slug, plan_slug, item_id, seq, item_text, status, deliverable)
    VALUES (${activeWorkspaceId()}, ${HARNESS}, ${slug}, 'P-001', 1, 'Write the decision memo.',
            'wip', ${deliverable})`;
  return slug;
}

/** Close a fresh work item linked to `planSlug#P-001`, sending `typeFields` when given. */
async function close(planSlug: string, typeFields?: Record<string, unknown>): Promise<{ result: Result; storedState: string | undefined }> {
  const item = await createWorkItem({
    kind: 'task',
    title: `Item type fields fixture for ${planSlug}`,
    harness: HARNESS,
    workspaceId: activeWorkspaceId(),
    createdBy: OWNER,
    assignee: OWNER,
    sourcePlanSlug: planSlug,
    sourcePlanItemIds: ['P-001'],
  });
  // Parsed through the tool's own input schema, so a schema that dropped typeFields would fail here.
  const args = complete.args.parse({
    id: item.id,
    harness: HARNESS,
    state: 'done',
    assumptions: 'none',
    completion: {
      summary: 'Wrote the decision memo and had it reviewed.',
      verifiedHow: 'manual',
      filesChanged: [],
      ...(typeFields ? { typeFields } : {}),
    },
    changeKinds: ['no-code-change'],
    changeKindReason: 'item-type fields fixture close; the deliverable is a memo',
  });
  expect((args.completion as { typeFields?: unknown } | undefined)?.typeFields).toEqual(typeFields);
  const response = await complete.handler(args as never, {
    uiClientId: OWNER,
    isSuperuser: true,
    workspaceId: activeWorkspaceId(),
    harnessSlug: HARNESS,
    runId: `complete-item-type-fields-${RUN}`,
    log: () => {},
  } as never);
  await drainDetached();
  const result = (response as { data?: { results?: Result[] } }).data?.results?.[0];
  expect(result, JSON.stringify(response)).toBeDefined();
  const stored = await getWorkItem(item.id, HARNESS);
  return { result: result!, storedState: stored?.state };
}

beforeAll(async () => {
  db = await createOrgTestDb();
  fixture.sql = db.adminSql;
  const workspaceId = activeWorkspaceId();
  await upsertDatatype(db.adminSql, {
    id: MEMO_DATATYPE,
    workspaceId,
    title: 'Reviewed memo',
    description: 'a memo with the name of its reviewer',
    tier: 'generic-kind',
    nature: 'work',
    audience: 'agent',
    payloadSchema: { type: 'object', required: ['reviewer'], properties: { reviewer: { type: 'string', minLength: 1 } } },
  });
  await upsertDatatype(db.adminSql, {
    id: BROKEN_DATATYPE,
    workspaceId,
    title: 'Broken schema',
    description: 'a datatype whose payload schema is not valid JSON Schema',
    tier: 'generic-kind',
    nature: 'work',
    audience: 'agent',
    payloadSchema: { type: 'not-a-json-type' },
  });
  const definitions = [
    itemType(INLINE, { schema: { type: 'object', required: ['memoRef'], properties: { memoRef: { type: 'string' } } } }),
    itemType(BY_REF, { datatypeRef: MEMO_DATATYPE }),
    itemType(DANGLING, { datatypeRef: MISSING_DATATYPE }),
    itemType(BROKEN, { datatypeRef: BROKEN_DATATYPE }),
  ];
  for (const definition of definitions) {
    const stored = await defineTypeDefinition(db.adminSql, { workspaceId, kind: 'item-type', definition, createdBy: OWNER });
    expect(stored, JSON.stringify(stored)).toMatchObject({ ok: true, typeId: definition.id, revision: 1 });
  }
}, 180_000);

afterAll(async () => {
  await drainDetached();
  await db?.cleanup();
});

describe('R-10: work_items:complete validates completion.typeFields against the linked item type', () => {
  it('refuses a close missing a field the inline completion schema requires, before any write', async () => {
    const slug = await seedPlanItem(INLINE);
    const { result, storedState } = await close(slug, { reviewer: 'someone' });
    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(result.itemTypeFieldsRefusal, JSON.stringify(result)).toMatchObject({
      code: 'item_type_fields_invalid',
      planSlug: slug,
      itemId: 'P-001',
      itemType: INLINE,
      revision: 1,
    });
    expect(result.itemTypeFieldsRefusal?.errors?.join(' '), JSON.stringify(result)).toMatch(/memoRef/);
    expect(storedState).not.toBe('done');
  });

  it('accepts the same close when typeFields satisfy the inline schema', async () => {
    const { result, storedState } = await close(await seedPlanItem(INLINE), { memoRef: 'docs/decisions/memo-7.md' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.itemTypeFieldsRefusal).toBeUndefined();
    expect(storedState).toBe('done');
  });

  it('SPEC-P-004: refuses a datatype-referenced field with the wrong value type, before any write', async () => {
    const { result, storedState } = await close(await seedPlanItem(BY_REF), { reviewer: 42 });
    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(result.itemTypeFieldsRefusal, JSON.stringify(result)).toMatchObject({
      code: 'item_type_fields_invalid',
      itemId: 'P-001',
      itemType: BY_REF,
      revision: 1,
    });
    expect(result.itemTypeFieldsRefusal?.errors?.join(' '), JSON.stringify(result)).toMatch(/reviewer.*string|string.*reviewer/);
    expect(storedState).not.toBe('done');
  });

  it('checks a datatype-referenced schema: a violation refuses and a conforming close is accepted', async () => {
    const refused = await close(await seedPlanItem(BY_REF), { reviewer: '' });
    expect(refused.result.ok, JSON.stringify(refused.result)).toBe(false);
    expect(refused.result.itemTypeFieldsRefusal, JSON.stringify(refused.result)).toMatchObject({
      code: 'item_type_fields_invalid',
      itemType: BY_REF,
    });
    expect(refused.storedState).not.toBe('done');

    const accepted = await close(await seedPlanItem(BY_REF), { reviewer: 'reviewer-1' });
    expect(accepted.result.ok, JSON.stringify(accepted.result)).toBe(true);
    expect(accepted.storedState).toBe('done');
  });

  it('refuses a close whose item type references a datatype the workspace does not install', async () => {
    const { result, storedState } = await close(await seedPlanItem(DANGLING), { reviewer: 'reviewer-1' });
    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(result.itemTypeFieldsRefusal, JSON.stringify(result)).toMatchObject({
      code: 'item_type_datatype_unresolved',
      itemType: DANGLING,
    });
    expect(result.itemTypeFieldsRefusal?.errors?.join(' '), JSON.stringify(result)).toContain(MISSING_DATATYPE);
    expect(storedState).not.toBe('done');
  });

  it('refuses a close whose referenced completion schema cannot compile', async () => {
    const { result, storedState } = await close(await seedPlanItem(BROKEN), { reviewer: 'reviewer-1' });
    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(result.itemTypeFieldsRefusal, JSON.stringify(result)).toMatchObject({
      code: 'item_type_completion_schema_invalid',
      itemType: BROKEN,
    });
    expect(storedState).not.toBe('done');
  });

  it('control: an item with no registry item type closes without typeFields', async () => {
    const { result, storedState } = await close(await seedPlanItem(null));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.itemTypeFieldsRefusal).toBeUndefined();
    expect(storedState).toBe('done');
  });
});
