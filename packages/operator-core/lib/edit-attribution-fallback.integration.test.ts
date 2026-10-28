/**
 * P-010 (code-intel-delivery-and-outcomes-2026-10-26, SPEC-P-010-B): an edit made while
 * the editor holds no work item still records WHAT the session said it was doing — the
 * declared presence intent and plan slug — and provenance must not promote that fallback
 * into a work-item attribution. Real Postgres with the real ledger migrations; the
 * writer (recordEditAttribution) and the reader (readSymbolProvenance) are both the
 * production functions.
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
// No live lease and no goal pointer: the editor holds no work item.
vi.mock('./agent-tools/coordination/presence', () => ({ getPresence: async () => h.presence }));

const { recordEditAttribution } = await import('./edit-attribution');
const { readSymbolProvenance } = await import('./code-intelligence/change-history');

const WS = 'ws-fallback';
const AGENT = 'su-fallback';
let root: string;

beforeAll(async () => {
  h.db = await createFreshPgDb('edit-attr-fallback');
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
  root = mkdtempSync(join(tmpdir(), 'edit-attr-fallback-'));
  writeFileSync(join(root, 'tool.ts'), 'export function work(): number {\n  return 1;\n}\n');
}, 120_000);
afterAll(async () => {
  await h.db?.cleanup();
  if (root) rmSync(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await h.db!.sql.unsafe('TRUNCATE harness_shared.edit_attribution_ledger');
});

async function ledgerRows() {
  return h.db!.sql<Array<{ work_item_id: string | null; intent: string | null; plan_slug: string | null; acquired_via: string | null }>>`
    SELECT work_item_id, intent, plan_slug, acquired_via
      FROM harness_shared.edit_attribution_ledger
     WHERE agent_id = ${AGENT}`;
}

describe('edit with no work item — fallback attribution', () => {
  it('records the declared intent and plan slug, and no work item', async () => {
    h.presence = { currentPlanSlug: 'code-intel-delivery-and-outcomes-2026-10-26', intent: 'tidy the provenance reader' };
    await recordEditAttribution(
      { repoRoot: root, files: ['tool.ts'], agentId: AGENT, workspaceId: WS, intent: 'PreToolUse:Edit' },
      { strict: true, awaitSymbols: true },
    );
    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      work_item_id: null,
      intent: 'tidy the provenance reader',
      plan_slug: 'code-intel-delivery-and-outcomes-2026-10-26',
      // The automatic hook label is kept apart from the intent it would otherwise displace.
      acquired_via: 'PreToolUse:Edit',
    });
  });

  it('provenance keeps the fallback edit unattributed instead of naming a work item', async () => {
    h.presence = { currentPlanSlug: 'code-intel-delivery-and-outcomes-2026-10-26', intent: 'tidy the provenance reader' };
    await recordEditAttribution(
      { repoRoot: root, files: ['tool.ts'], agentId: AGENT, workspaceId: WS, intent: 'PreToolUse:Edit' },
      { strict: true, awaitSymbols: true },
    );
    const report = await readSymbolProvenance(
      { workspaceId: WS, harness: 'papercusp', root, path: 'tool.ts', name: 'work' },
      h.db!.sql,
    );
    expect(report.fileEdits).toHaveLength(1);
    expect(report.fileEdits.every((edit) => edit.workItem === null)).toBe(true);
    expect(report.symbolStatus).toBe('unknown');
    // The fallback is shown as session context beside workItem: null ...
    expect(report.fileEdits[0]!.fallback).toEqual({
      intent: 'tidy the provenance reader', planSlug: 'code-intel-delivery-and-outcomes-2026-10-26' });
    // ... and never becomes a work-item attribution or a measured history entry.
    expect(report.history.flatMap((record) => record.workItems)).toEqual([]);
    expect(report.history.every((record) => record.status === 'unknown')).toBe(true);
    expect(JSON.stringify(report.history.map((record) => record.workItems))).not.toContain('tidy the provenance reader');
  });

  it('shows no fallback on an edit that carries a work item', async () => {
    h.presence = { currentPlanSlug: 'code-intel-delivery-and-outcomes-2026-10-26', intent: 'tidy the provenance reader' };
    await h.db!.sql`
      INSERT INTO harness_shared.edit_attribution_ledger
        (workspace_id, agent_id, repo_root, file, harness_slug, work_item_id, plan_slug, intent, symbols)
      VALUES (${WS}, ${AGENT}, ${root}, 'tool.ts', 'papercusp', 'WI-attributed', 'some-plan', 'held work', ARRAY['work'])`;
    const report = await readSymbolProvenance(
      { workspaceId: WS, harness: 'papercusp', root, path: 'tool.ts', name: 'work' },
      h.db!.sql,
    );
    expect(report.fileEdits).toHaveLength(1);
    expect(report.fileEdits[0]!.workItem).toBe('WI-attributed');
    expect(report.fileEdits[0]!.fallback).toBeUndefined();
  });

  it('records an honest NULL intent when the session declared none', async () => {
    h.presence = { currentPlanSlug: null, intent: null };
    await recordEditAttribution(
      { repoRoot: root, files: ['tool.ts'], agentId: AGENT, workspaceId: WS, intent: 'PreToolUse:Write' },
      { strict: true, awaitSymbols: true },
    );
    const rows = await ledgerRows();
    expect(rows).toEqual([{ work_item_id: null, intent: null, plan_slug: null, acquired_via: 'PreToolUse:Write' }]);
  });
});
