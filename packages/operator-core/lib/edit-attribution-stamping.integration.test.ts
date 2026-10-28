/**
 * P-005 / R-4 (change-provenance-and-admission-throughput-2026-10-27): an edit is stamped
 * with the work item its editor HOLDS (work_items.taken_by), not a short-lived claim lease.
 * One held item stamps it; several are disambiguated by the lock intent, then the declared
 * presence intent; otherwise the row stays unstamped and records the candidates. Every row
 * records HOW it was chosen. R-5: the editing session id persists on the row.
 * Real Postgres with the real ledger migrations; the writer is the production function.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({
  db: null as FreshPgDb | null,
  presence: null as { currentPlanSlug: string | null; intent: string | null } | null,
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.db!.sql }),
}));
vi.mock('./agent-tools/coordination/presence', () => ({ getPresence: async () => h.presence }));

const { recordEditAttribution } = await import('./edit-attribution');

const WS = 'ws-stamping';
const AGENT = 'su-stamping';
let root: string;

beforeAll(async () => {
  h.db = await createFreshPgDb('edit-attr-stamping');
  await applyMigrationsForTest(
    h.db.sql,
    [
      '363-commit-attribution-ledger.sql',
      '364-edit-attribution-ledger-repo-root.sql',
      '784-edit-attribution-acquired-via.sql',
      '1367-edit-attribution-dispatch-call-id.sql',
      '1540-git-sync-commit-attribution-repo-committed-at.sql',
      '1584-edit-attribution-symbols.sql',
      '1587-edit-attribution-signal-eligibility.sql',
      '1599-edit-attribution-work-item-resolution.sql',
    ],
    { runtimeTables: ['harness_shared.git_sync_commit_attribution'] },
  );
  // Only the columns the held-set read touches.
  await h.db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.work_items (
      workspace_id text NOT NULL,
      harness_slug text,
      feature_id   text NOT NULL,
      taken_by     text,
      status       text NOT NULL,
      lane         text
    )`);
  root = mkdtempSync(join(tmpdir(), 'edit-attr-stamping-'));
  writeFileSync(join(root, 'tool.ts'), 'export const x = 1;\n');
}, 120_000);
afterAll(async () => {
  await h.db?.cleanup();
  if (root) rmSync(root, { recursive: true, force: true });
});
beforeEach(async () => {
  h.presence = null;
  await h.db!.sql.unsafe('TRUNCATE harness_shared.edit_attribution_ledger, harness_shared.work_items');
  // Never candidates: a finished item and an observation-lane reflection.
  await hold('WI-done', 'done');
  await hold('EI-observation', 'open', 'observation');
});

async function hold(id: string, status = 'open', lane: string | null = null) {
  await h.db!.sql`
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, taken_by, status, lane)
    VALUES (${WS}, 'papercusp', ${id}, ${AGENT}, ${status}, ${lane})`;
}

async function edit(intent: string, sessionId?: string) {
  await recordEditAttribution(
    { repoRoot: root, files: ['tool.ts'], agentId: AGENT, workspaceId: WS, intent, sessionId },
    { strict: true },
  );
  const rows = await h.db!.sql<Array<{
    work_item_id: string | null;
    harness_slug: string | null;
    work_item_resolution: string | null;
    work_item_candidates: string[] | null;
    session_id: string | null;
  }>>`
    SELECT work_item_id, harness_slug, work_item_resolution, work_item_candidates, session_id
      FROM harness_shared.edit_attribution_ledger
     WHERE agent_id = ${AGENT}`;
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe('edit stamping from the editor held set', () => {
  it('records none when the editor holds no open work item', async () => {
    const row = await edit('PreToolUse:Edit');
    expect(row).toMatchObject({ work_item_id: null, work_item_resolution: 'none', work_item_candidates: null });
  });

  it('stamps the single held item', async () => {
    await hold('WI-A');
    const row = await edit('PreToolUse:Edit');
    expect(row).toMatchObject({ work_item_id: 'WI-A', harness_slug: 'papercusp', work_item_resolution: 'single-holder' });
  });

  it('picks the held item the lock intent names when several are held', async () => {
    await hold('WI-A');
    await hold('WI-B');
    const row = await edit('fixing WI-B stamping');
    expect(row).toMatchObject({ work_item_id: 'WI-B', work_item_resolution: 'lock-intent' });
  });

  it('falls back to the declared presence intent', async () => {
    await hold('WI-A');
    await hold('WI-B');
    h.presence = { currentPlanSlug: null, intent: 'working WI-A now' };
    const row = await edit('PreToolUse:Edit');
    expect(row).toMatchObject({ work_item_id: 'WI-A', work_item_resolution: 'declared-intent' });
  });

  it('leaves the row unstamped with candidates when nothing singles one out', async () => {
    await hold('WI-A');
    await hold('WI-B');
    const row = await edit('PreToolUse:Edit');
    expect(row.work_item_id).toBeNull();
    expect(row.work_item_resolution).toBe('ambiguous');
    expect(row.work_item_candidates).toEqual(['WI-A', 'WI-B']);
  });

  it('persists the editing session id (R-5)', async () => {
    await hold('WI-A');
    const row = await edit('PreToolUse:Edit', 'native-session-123');
    expect(row).toMatchObject({ work_item_id: 'WI-A', session_id: 'native-session-123' });
  });
});
