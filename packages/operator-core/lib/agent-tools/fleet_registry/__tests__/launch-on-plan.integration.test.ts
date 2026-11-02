import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { persistFreshFleetLaunchProfile } from '../launch-on-plan';

// Exercise the production launch-on-plan persistence seam with the real store.
// Terminal creation is covered separately; this oracle reads the database,
// independently of the function's return value and without a mocked setter.
let db: OrgTestDb;
const workspaceId = 'fleet-recovery-defaults';
beforeAll(async () => { db = await createOrgTestDb(); }, 180_000);
afterAll(async () => { await db?.cleanup(); });

async function seed(slug: string, supervise?: boolean) {
  const config = supervise == null ? null : { plan: 'existing-plan', harness: 'papercusp',
    agent: 'codex', account: 'original-account', headless: false, supervise };
  await db.adminSql`INSERT INTO harness_shared.agent_fleets
    (workspace_id, fleet_slug, created_at, updated_at, headcount_target, headcount_config)
    VALUES (${workspaceId}, ${slug}, ${Date.now()}, ${Date.now()},
      ${config ? 2 : null}, ${config ? JSON.stringify(config) : null}::text::jsonb)`;
}

async function stored(slug: string) {
  const [row] = await db.adminSql`SELECT headcount_target, headcount_config
    FROM harness_shared.agent_fleets WHERE workspace_id = ${workspaceId} AND fleet_slug = ${slug}`;
  return row;
}

describe('launch-on-plan durable supervision defaults', () => {
  it.each([
    { label: 'omitted', requested: undefined, expected: true },
    { label: 'explicit opt-out', requested: false, expected: false },
    { label: 'explicit grant', requested: true, expected: true },
  ])('persists a new fleet with $label', async ({ label, requested, expected }) => {
    const slug = label.replaceAll(' ', '-');
    await seed(slug);
    await persistFreshFleetLaunchProfile({ freshFleetCreated: true, workspaceId, fleetSlug: slug,
      target: 3, config: { plan: 'approved-plan', harness: 'papercusp', agent: 'codex',
        headless: true, ...(requested == null ? {} : { supervise: requested }) } }, db.adminSql);
    expect(await stored(slug)).toEqual({ headcount_target: 3, headcount_config: {
      plan: 'approved-plan', harness: 'papercusp', agent: 'codex', headless: true, supervise: expected,
    } });
  });

  it.each([false, true])('preserves the entire existing supervise:%s recipe on a top-up', async supervise => {
    const slug = `existing-${supervise}`;
    await seed(slug, supervise);
    const before = await stored(slug);
    await persistFreshFleetLaunchProfile({ freshFleetCreated: false, workspaceId, fleetSlug: slug,
      target: 9, config: { plan: 'new-plan', harness: 'papercusp', agent: 'claude', headless: true } }, db.adminSql);
    expect(await stored(slug)).toEqual(before);
    expect(before.headcount_config.supervise).toBe(supervise);
  });
});
