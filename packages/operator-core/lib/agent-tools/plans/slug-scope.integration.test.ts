/**
 * Plan scope-unique-identifiers-2026-07-26 P-006, against real Postgres.
 *
 * A plan slug is unique per (workspace, harness), not per workspace, so one
 * slug can name two different plans. A slug-only lookup used to resolve such a
 * slug to the most recently updated copy (reads) or refuse it (writes, through
 * a wrapper each caller had to remember). Now every slug-only path refuses and
 * names the candidates; a unique slug still resolves without a harness.
 *
 * The positive control (a unique slug in the same workspace) proves the
 * instrument: an ambiguous refusal only means something if the same path
 * resolves a slug that is NOT ambiguous.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  withWorkspace: async <T>(workspace: string, fn: (sql: Sql) => Promise<T>) =>
    h.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspace}, true)`;
      return fn(tx as unknown as Sql);
    }),
}));

import getTool from './get';
import { planHarnessesForSlugs, resolvePlanHarness, resolvePlanHarnessSlug } from './source';
import { recoverHarnessFromSlugs } from './slug-scope';

const WS = 'slug-scope-ws';
const OTHER_WS = 'slug-scope-other-ws';
const DUP = 'shared-slug-plan';
const UNIQUE = 'unique-slug-plan';

let db: OrgTestDb;

async function seedPlan(workspace: string, harness: string, slug: string, updatedAt: string) {
  const content = `---\nslug: ${slug}\ntitle: ${harness} ${slug}\nstatus: ready\n---\n\n## Now\n\nReady.\n`;
  await db.adminSql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, status, updated_at)
    VALUES (${workspace}, ${harness}, ${slug}, ${content}, md5(${content}), 'ready', ${updatedAt}::timestamptz)`;
}

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.appSql;
  // 'email' is the most recently updated copy: the one the old rule picked.
  await seedPlan(WS, 'papercusp', DUP, '2026-10-01T00:00:00Z');
  await seedPlan(WS, 'email', DUP, '2026-10-05T00:00:00Z');
  await seedPlan(WS, 'papercusp', UNIQUE, '2026-10-02T00:00:00Z');
  // The same slug in ANOTHER workspace must not count toward ambiguity here.
  await seedPlan(OTHER_WS, 'calendar', UNIQUE, '2026-10-03T00:00:00Z');
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('slug-only plan lookups refuse an ambiguous slug (P-006)', () => {
  it('the index sees both holders of the duplicated slug, newest first', async () => {
    const map = await planHarnessesForSlugs(WS, [DUP, UNIQUE]);
    expect(map.get(DUP)).toEqual(['email', 'papercusp']);
    expect(map.get(UNIQUE)).toEqual(['papercusp']);
  });

  it('recoverHarnessFromSlugs refuses the duplicated slug and names both harnesses', async () => {
    const d = await recoverHarnessFromSlugs({ workspaceId: WS }, [DUP]);
    expect(d).toEqual({ status: 'ambiguous', candidates: { [DUP]: ['email', 'papercusp'] }, workspaceId: WS });
  });

  it('positive control: a unique slug resolves without a harness', async () => {
    const d = await recoverHarnessFromSlugs({ workspaceId: WS }, [UNIQUE]);
    expect(d).toEqual({ status: 'resolved', harnessSlug: 'papercusp', bySlug: { [UNIQUE]: 'papercusp' } });
  });

  it('resolvePlanHarness types the outcome; resolvePlanHarnessSlug never guesses', async () => {
    await expect(resolvePlanHarness(WS, DUP)).resolves.toEqual({
      status: 'ambiguous',
      candidates: ['email', 'papercusp'],
    });
    await expect(resolvePlanHarness(WS, UNIQUE)).resolves.toEqual({ status: 'resolved', harnessSlug: 'papercusp' });
    await expect(resolvePlanHarness(WS, 'no-such-plan')).resolves.toEqual({ status: 'missing' });
    // The old rule returned 'email' here (newest updated_at).
    await expect(resolvePlanHarnessSlug(WS, DUP)).resolves.toBeNull();
    await expect(resolvePlanHarnessSlug(WS, UNIQUE)).resolves.toBe('papercusp');
  });

  it('plans:get with no harness refuses the duplicated slug with plan_slug_ambiguous_across_harnesses', async () => {
    const result = (await getTool.handler({ slug: DUP } as never, { workspaceId: WS, harnessSlug: '*' } as never)) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      tool: 'plans:get',
      error: 'plan_slug_ambiguous_across_harnesses',
      candidates: { [DUP]: ['email', 'papercusp'] },
      workspaceId: WS,
    });
    expect(body.detail).toContain('explicit `harness`');
  });
});
