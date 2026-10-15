/**
 * plan-context-for-feature.integration.test.ts — the PG provenance query behind
 * plan-context injection (harness_features_consolidated), against a real Postgres.
 *
 * The integration-worthy behavior is the SQL: workspace/harness/feature scoping,
 * the `= ANY(featureIds)` batch with `DISTINCT … IS NOT NULL LIMIT 2`, and the
 * "feature not promoted from a plan → null" branch (source_plan_slug NULL). The
 * plan FORMATTING is pure given a parsed plan, so readPlanBySlug is mocked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from "./../test/_work-items-schema";

const WS = 'ws-pctx';
const HARNESS = 'web';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, readPlanBySlug: vi.fn() }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});
vi.mock('./agent-tools/plans/source', () => ({ readPlanBySlug: (slug: string) => h.readPlanBySlug(slug) }));

const { getPlanContextForFeature, getPlanContextsForFeatures } = await import('./plan-context-for-feature');

const parsed = (slug: string, over: Record<string, unknown> = {}) => ({
  parsed: {
    frontmatter: { title: `Title of ${slug}` },
    items: [{ id: 'I-002', text: 'the source item body for the feature' }],
    now: { state: 'we are mid-build', next: 'ship it' },
    decisions: [
      { id: 'D-001', title: 'first', body: 'b1' },
      { id: 'D-002', title: 'second', body: 'b2' },
      { id: 'D-003', title: 'third', body: 'b3' },
      { id: 'D-004', title: 'fourth', body: 'b4' },
    ],
    ...over,
  },
});

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `pctx_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // P-010 unification: work_items is the base table + hfc/ei compat views.
  await rootSql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.work_items `;
  h.readPlanBySlug.mockReset();
});

async function insertFeature(featureId: string, plan: string | null, opts: { ws?: string; items?: string[] } = {}) {
  await rootSql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, title, workspace_id, source_plan_slug, source_plan_item_ids)
    VALUES (${HARNESS}, ${featureId}, 'T', ${opts.ws ?? WS}, ${plan}, ${opts.items ?? null})`;
}

describe('getPlanContextForFeature (PG provenance)', () => {
  it('returns null when the feature has no source_plan_slug (not promoted from a plan)', async () => {
    await insertFeature('feat-1', null);
    expect(await getPlanContextForFeature(HARNESS, 'feat-1')).toBeNull();
    expect(h.readPlanBySlug).not.toHaveBeenCalled(); // short-circuits before reading any plan
  });

  it('returns null when no feature row exists', async () => {
    expect(await getPlanContextForFeature(HARNESS, 'ghost')).toBeNull();
  });

  it('formats the section from the parsed plan: slug, source item, Now block, last-3 decisions newest-first', async () => {
    await insertFeature('feat-2', 'plan-x', { items: ['I-002'] });
    h.readPlanBySlug.mockResolvedValue(parsed('plan-x'));
    const res = await getPlanContextForFeature(HARNESS, 'feat-2');
    expect(res).not.toBeNull();
    expect(res!.planSlug).toBe('plan-x');
    expect(res!.truncated).toBe(false);
    expect(res!.section).toContain('**Plan:** `plan-x`');
    expect(res!.section).toContain('the source item body'); // matched item I-002
    expect(res!.section).toContain('we are mid-build'); // Now state
    expect(res!.section).toContain('**Next:** ship it');
    // last 3 decisions, most-recent first → D-004, D-003, D-002; D-001 dropped
    expect(res!.section).toContain('D-004');
    expect(res!.section).not.toContain('D-001');
    expect(res!.section.indexOf('D-004')).toBeLessThan(res!.section.indexOf('D-002'));
  });

  it('is scoped to the active workspace — a row in another workspace does not match', async () => {
    await insertFeature('feat-3', 'plan-other', { ws: 'other-ws' });
    h.readPlanBySlug.mockResolvedValue(parsed('plan-other'));
    expect(await getPlanContextForFeature(HARNESS, 'feat-3')).toBeNull(); // WS-scoped query misses other-ws
  });

  it('truncates content over the 6,000-char budget with a [truncated] marker', async () => {
    await insertFeature('feat-4', 'plan-big');
    h.readPlanBySlug.mockResolvedValue(parsed('plan-big', { now: { state: 'x'.repeat(7000), next: 'n' } }));
    const res = await getPlanContextForFeature(HARNESS, 'feat-4');
    expect(res!.truncated).toBe(true);
    expect(res!.section.endsWith('[truncated]')).toBe(true);
  });
});

describe('getPlanContextsForFeatures (batch)', () => {
  it('DISTINCT + IS NOT NULL + LIMIT 2 over a feature batch', async () => {
    await insertFeature('f1', 'plan-a');
    await insertFeature('f2', 'plan-a'); // duplicate plan
    await insertFeature('f3', null); // no plan — excluded by IS NOT NULL
    await insertFeature('f4', 'plan-b');
    await insertFeature('f5', 'plan-c');
    h.readPlanBySlug.mockImplementation((slug: string) => Promise.resolve(parsed(slug)));
    const out = await getPlanContextsForFeatures(HARNESS, ['f1', 'f2', 'f3', 'f4', 'f5']);
    expect(out).not.toBeNull();
    const planHeadings = (out!.match(/### Plan: `/g) ?? []).length;
    expect(planHeadings).toBe(2); // DISTINCT dedups plan-a; LIMIT 2 caps the count
    expect(out).toContain('## Source Plans Context');
  });

  it('returns null when none of the features have a source plan', async () => {
    await insertFeature('f1', null);
    expect(await getPlanContextsForFeatures(HARNESS, ['f1'])).toBeNull();
    expect(await getPlanContextsForFeatures(HARNESS, [])).toBeNull();
  });
});
