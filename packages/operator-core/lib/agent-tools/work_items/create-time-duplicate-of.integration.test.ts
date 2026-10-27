/**
 * create-time-duplicate-of.integration.test.ts — the create-time duplicate verdict, driven
 * through the REAL filing path (createOneWorkItem, what work_items:create calls) against
 * a fully migrated Postgres.
 *
 * Plan: bug-inflow-one-problem-one-row-2026-10-18 (P-005, D-002; owner directive #1990:
 * "record duplicates as a FIELD that the existing duplicate gate checks").
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * work-items-lifecycle.integration.test.ts proves `stampCreateTimeDuplicate` itself writes
 * the typed verdict (duplicate_of + confidence + evidence) and counts the repeat onto the
 * canonical row. But it calls the helper DIRECTLY, so it cannot fail if the filing path
 * stops calling it, passes it the wrong candidate set, or drops the hard-band ids — and the
 * call site wraps the stamp in `.catch(() => null)`, so such a break is SILENT: the item is
 * created, no error, no verdict. This file closes that gap by filing through
 * createOneWorkItem with only the embedding classifier stubbed (findSemanticDupes is inert
 * under vitest unless deps are injected — it would lazy-load an ONNX model), so the screen →
 * hard-band merge → stamp → link → occurrence chain runs as in production.
 *
 * Real Postgres (testcontainer; Docker required). Run:
 *   npm run test:file -- packages/operator-core/lib/agent-tools/work_items/create-time-duplicate-of.integration.test.ts
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import type { SemanticDupeCandidate, SemanticDupeResult } from './semantic-dupe-guard';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..', '..', '..');
const SQL_DIR = join(REPO, 'libs', 'papercusp', 'libs', 'db', 'sql');
const RUNNER = join(REPO, 'libs', 'papercusp', 'packages', 'embedded-postgres-server', 'src', 'migration-runner.js');

const WS = 'papercusp-workspace';
const HARNESS = 'papercusp';
const OWNER = 'su-create-time-dup';

let db: MigratedTestDb;
let sql: Sql;

// What the stubbed embedding classifier answers for the NEXT filing.
const screen = vi.hoisted(() => ({ next: null as null | { hard: SemanticDupeCandidate[]; soft: SemanticDupeCandidate[] } }));

// Partial mocks: _create-core reaches its connection through getOrgPg() at call time, and
// imports real helpers from both modules that a whole-module replacement would remove.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql }),
}));
vi.mock('./semantic-dupe-guard', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findSemanticDupes: async (): Promise<SemanticDupeResult | null> =>
    screen.next ? ({ ...screen.next, thresholds: { hard: 0.9, soft: 0.8 } } as SemanticDupeResult) : null,
}));

const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

async function provision(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(BOOT_PREREQS_DDL);
    const { applyPendingMigrations } = (await import(pathToFileURL(RUNNER).href)) as {
      applyPendingMigrations: (o: { client: Sql; sqlDir: string }) => Promise<{ appliedCount: number; totalKnown: number }>;
    };
    const { appliedCount, totalKnown } = await applyPendingMigrations({ client, sqlDir: SQL_DIR });
    if (appliedCount !== totalKnown) throw new Error(`migrations incomplete: applied ${appliedCount} of ${totalKnown}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  db = await createFreshTestDb({ provision });
  sql = postgres(db.url, { max: 4, onnotice: () => {}, prepare: false });
}, 600_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

beforeEach(async () => {
  screen.next = null;
  await sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_occurrences, harness_shared.coord_links CASCADE`;
});

async function file(title: string, extra: Record<string, unknown> = {}, workspace: string = WS) {
  const { createOneWorkItem } = await import('./_create-core');
  const res = await createOneWorkItem(
    { kind: 'bug', title, harness: HARNESS, workspace, ...extra } as Parameters<typeof createOneWorkItem>[0],
    { ownerId: OWNER, workspaceId: workspace, harnessSlug: HARNESS },
  );
  if (!res.ok) throw new Error(`create refused: ${JSON.stringify(res).slice(0, 600)}`);
  return res as typeof res & { workItem: { id: string }; duplicateOf?: { id: string; confidence: number | null } };
}

function hardMatch(id: string, similarity: number): SemanticDupeCandidate {
  return { id, title: 'canonical', state: 'open', harness: HARNESS, similarity };
}

async function verdict(id: string) {
  const rows = await sql<
    { duplicate_of: string | null; duplicate_source: string | null; confidence: number | null; matched: string | null }[]
  >`
    SELECT duplicate_of, duplicate_source, duplicate_confidence AS confidence,
           duplicate_evidence->>'matchedOn' AS matched
      FROM harness_shared.work_items WHERE feature_id = ${id} AND workspace_id = ${WS}`;
  return rows[0];
}

async function occurrencesOn(canonicalId: string) {
  return sql<{ kind: string; duplicate_row: string | null; source_tool: string | null }[]>`
    SELECT report_kind AS kind, evidence->>'duplicateRow' AS duplicate_row, source_tool
      FROM harness_shared.work_item_occurrences WHERE canonical_work_item_id = ${canonicalId}`;
}

describe('work_items:create stamps the typed duplicate-of verdict at filing time (P-005, D-002)', () => {
  it('a HARD-band semantic match found while filing becomes duplicate_of on the new row, linked and counted on the canonical', async () => {
    const canonical = await file('Gateway drops SSE frames under load');
    expect(canonical.duplicateOf).toBeUndefined();
    expect((await verdict(canonical.workItem.id))?.duplicate_of).toBeNull();

    screen.next = { hard: [hardMatch(canonical.workItem.id, 0.97)], soft: [] };
    const filed = await file('SSE frames lost at the gateway when busy');

    expect(filed.duplicateOf).toEqual({ id: canonical.workItem.id, confidence: 0.97 });
    expect(await verdict(filed.workItem.id)).toEqual({
      duplicate_of: canonical.workItem.id,
      duplicate_source: 'create-match',
      confidence: 0.97,
      matched: 'semantic-hard',
    });
    // The verdict rides a typed duplicates edge (so one unlink withdraws a false match) …
    const edges = await sql<{ rel: string }[]>`
      SELECT rel FROM harness_shared.coord_links
       WHERE src_ref = ${filed.workItem.id} AND dst_ref = ${canonical.workItem.id}`;
    expect(edges.map((e) => e.rel)).toContain('duplicates');
    // … and the repeat counts onto the canonical row's occurrence ledger, once.
    expect(await occurrencesOn(canonical.workItem.id)).toEqual([
      { kind: 'duplicate', duplicate_row: filed.workItem.id, source_tool: 'work_items:create' },
    ]);
  });

  it('soft-band-only candidates, force:true and critical severity never set the verdict on the filing path', async () => {
    const canonical = await file('Plan parser drops trailing decision');
    const id = canonical.workItem.id;

    screen.next = { hard: [], soft: [hardMatch(id, 0.85)] };
    const softOnly = await file('Decision at end of plan is not parsed');
    expect(softOnly.duplicateOf).toBeUndefined();
    expect((await verdict(softOnly.workItem.id))?.duplicate_of).toBeNull();

    screen.next = { hard: [hardMatch(id, 0.96)], soft: [] };
    const forced = await file('Trailing plan decision vanishes', { force: true });
    expect(forced.duplicateOf).toBeUndefined();
    expect((await verdict(forced.workItem.id))?.duplicate_of).toBeNull();

    screen.next = { hard: [hardMatch(id, 0.96)], soft: [] };
    const critical = await file('Last plan decision missing after parse', { severity: 'critical' });
    expect(critical.duplicateOf).toBeUndefined();
    expect((await verdict(critical.workItem.id))?.duplicate_of).toBeNull();

    expect(await occurrencesOn(id)).toEqual([]);
  });

  it('a HARD-band match on a row that is not OPEN in the filing workspace never sets the verdict (SPEC-P-005 workspace control)', async () => {
    // The same problem filed in ANOTHER workspace: the screen names it, the verdict must not cross tenants.
    const foreign = await file('Gateway drops SSE frames under load', {}, 'ws-foreign-tenant');
    // Pin the fixture: the row must really live in the other tenant, whatever the create path resolved.
    await sql`UPDATE harness_shared.work_items SET workspace_id = 'ws-foreign-tenant' WHERE feature_id = ${foreign.workItem.id}`;
    const foreignRows = await sql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM harness_shared.work_items WHERE feature_id = ${foreign.workItem.id}`;
    expect(foreignRows.map((r) => r.workspace_id)).toEqual(['ws-foreign-tenant']);
    screen.next = { hard: [hardMatch(foreign.workItem.id, 0.97)], soft: [] };
    const crossTenant = await file('SSE frames lost at the gateway when busy');
    expect(crossTenant.duplicateOf).toBeUndefined();
    expect((await verdict(crossTenant.workItem.id))?.duplicate_of).toBeNull();

    // A CLOSED row of this workspace is not an open canonical either.
    const closed = await file('Plan parser drops trailing decision');
    await sql`UPDATE harness_shared.work_items SET status = 'done' WHERE feature_id = ${closed.workItem.id} AND workspace_id = ${WS}`;
    screen.next = { hard: [hardMatch(closed.workItem.id, 0.97)], soft: [] };
    const afterClose = await file('Decision at end of plan is not parsed');
    expect(afterClose.duplicateOf).toBeUndefined();
    expect((await verdict(afterClose.workItem.id))?.duplicate_of).toBeNull();

    // Positive control: the identical hard match on an OPEN row of this workspace stamps.
    const open = await file('Tray icon flickers on wake');
    screen.next = { hard: [hardMatch(open.workItem.id, 0.97)], soft: [] };
    const twin = await file('Tray icon blinks after resume');
    expect(twin.duplicateOf).toEqual({ id: open.workItem.id, confidence: 0.97 });
    expect((await verdict(twin.workItem.id))?.duplicate_source).toBe('create-match');

    expect(await occurrencesOn(foreign.workItem.id)).toEqual([]);
    expect(await occurrencesOn(closed.workItem.id)).toEqual([]);
  });

  it('keeps independent work under different explicit parents distinct despite a HARD-band match', async () => {
    const installed = await file('P536 installed composition', { kind: 'change' });
    const helper = await file('P537 maintained helper', { kind: 'change' });
    const canonical = await file('Independently author and freeze P536 installed VM-copy composition oracle', {
      kind: 'change', parent: installed.workItem.id,
    });

    // EI-26922584654907839: the real filing's measured semantic-hard score.
    screen.next = { hard: [hardMatch(canonical.workItem.id, 0.9139014158815572)], soft: [] };
    const independent = await file('Independently author and freeze P537 maintained helper oracle', {
      kind: 'change', parent: helper.workItem.id,
    });
    expect(independent.duplicateOf).toBeUndefined();
    expect((await verdict(independent.workItem.id))?.duplicate_of).toBeNull();
    const [saved] = await sql<{ candidates: unknown }[]>`
      SELECT payload->'dedupCandidates' AS candidates FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id = ${independent.workItem.id}`;
    expect(saved?.candidates).toEqual([
      { id: canonical.workItem.id, method: 'semantic-hard', similarity: 0.9139014158815572 },
    ]);
    expect(await occurrencesOn(canonical.workItem.id)).toEqual([]);
    const edges = await sql`
      SELECT rel FROM harness_shared.coord_links
       WHERE src_ref = ${independent.workItem.id} AND rel = 'duplicates'`;
    expect(edges).toHaveLength(0);

    // A real repeat within the SAME declared scope still gets the typed verdict.
    screen.next = { hard: [hardMatch(canonical.workItem.id, 0.97)], soft: [] };
    const repeat = await file('Repeat installed composition oracle', {
      kind: 'change', parent: installed.workItem.id,
    });
    expect(repeat.duplicateOf).toEqual({ id: canonical.workItem.id, confidence: 0.97 });
    expect((await verdict(repeat.workItem.id))?.duplicate_source).toBe('create-match');
  });

  it('keeps a child distinct from its top-level parent while retaining same-scope hard candidates', async () => {
    const parent = await file('Runtime composition', { kind: 'change' });
    screen.next = { hard: [hardMatch(parent.workItem.id, 0.99)], soft: [] };
    const child = await file('Runtime composition independent acceptance', {
      kind: 'change', parent: parent.workItem.id,
    });
    expect(child.duplicateOf).toBeUndefined();
    expect((await verdict(child.workItem.id))?.duplicate_of).toBeNull();
    expect(await occurrencesOn(parent.workItem.id)).toEqual([]);

    // The higher-scoring parent must not hide an eligible sibling candidate.
    screen.next = { hard: [hardMatch(parent.workItem.id, 0.99), hardMatch(child.workItem.id, 0.95)], soft: [] };
    const sibling = await file('Repeat runtime composition acceptance', {
      kind: 'change', parent: parent.workItem.id,
    });
    expect(sibling.duplicateOf).toEqual({ id: child.workItem.id, confidence: 0.95 });
  });
});
