/**
 * WI-6554700010018409: lookupDriftCauseWorkItems windows on the COMMIT time, not the time the
 * row was recorded. Migration 1540 added `committed_at`; `ts` is the record time and lagged
 * the commit by up to 85h during the WI-6554700010018197 outage. Rows recorded before 1540
 * have no `committed_at` and fall back to `ts`. Real PG with the real migrations, because
 * the window is enforced in SQL.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ db: null as FreshPgDb | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.db!.sql }),
}));
const { lookupDriftCauseWorkItems, recordEditAttribution } = await import('./edit-attribution');

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY_MS);

beforeAll(async () => {
  h.db = await createFreshPgDb('edit-attr-drift');
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
    ],
    { runtimeTables: ['harness_shared.git_sync_commit_attribution'] },
  );
}, 120_000);
afterAll(async () => {
  await h.db?.cleanup();
});
beforeEach(async () => {
  await h.db!.sql.unsafe('TRUNCATE harness_shared.git_sync_commit_attribution');
});

async function insertRow(row: {
  file: string;
  workItemId: string;
  ts: Date;
  committedAt: Date | null;
  harnessSlug?: string;
}): Promise<void> {
  const sql = h.db!.sql;
  await sql`
    INSERT INTO harness_shared.git_sync_commit_attribution
      (workspace_id, harness_slug, repo, commit_sha, file, work_item_id, ts, committed_at)
    VALUES ('ws', ${row.harnessSlug ?? 'papercusp'}, 'superproject', ${'c'.repeat(40)}, ${row.file},
            ${row.workItemId}, ${row.ts}, ${row.committedAt})`;
}

describe('lookupDriftCauseWorkItems windowing (real PG, migrations 363 + 1540)', () => {
  it('windows on commit time: an old commit recorded late is outside the default 14 days', async () => {
    // Committed 30 days ago, recorded just now: a ts-only window would wrongly include it.
    await insertRow({ file: 'src/late.ts', workItemId: 'WI-LATE', ts: daysAgo(0), committedAt: daysAgo(30) });
    // Committed and recorded 2 days ago.
    await insertRow({ file: 'src/recent.ts', workItemId: 'WI-RECENT', ts: daysAgo(2), committedAt: daysAgo(2) });

    const out = await lookupDriftCauseWorkItems(['src/late.ts', 'src/recent.ts']);

    expect(Object.fromEntries(out)).toEqual({ 'src/recent.ts': ['WI-RECENT'] });
  });

  it('falls back to the record time for rows written before committed_at existed', async () => {
    await insertRow({ file: 'src/legacy-new.ts', workItemId: 'WI-LEGACY-NEW', ts: daysAgo(3), committedAt: null });
    await insertRow({ file: 'src/legacy-old.ts', workItemId: 'WI-LEGACY-OLD', ts: daysAgo(30), committedAt: null });

    const out = await lookupDriftCauseWorkItems(['src/legacy-new.ts', 'src/legacy-old.ts']);

    expect(Object.fromEntries(out)).toEqual({ 'src/legacy-new.ts': ['WI-LEGACY-NEW'] });
  });

  it('honours lookbackHours on the commit time', async () => {
    await insertRow({ file: 'src/late.ts', workItemId: 'WI-LATE', ts: daysAgo(0), committedAt: daysAgo(30) });

    expect(Object.fromEntries(await lookupDriftCauseWorkItems(['src/late.ts'], { lookbackHours: 24 * 60 }))).toEqual({
      'src/late.ts': ['WI-LATE'],
    });
    expect((await lookupDriftCauseWorkItems(['src/late.ts'], { lookbackHours: 24 * 29 })).size).toBe(0);
  });

  it('scopes to harnessSlug when given', async () => {
    await insertRow({ file: 'src/a.ts', workItemId: 'WI-HERE', ts: daysAgo(1), committedAt: daysAgo(1) });
    await insertRow({
      file: 'src/a.ts',
      workItemId: 'WI-THERE',
      ts: daysAgo(1),
      committedAt: daysAgo(1),
      harnessSlug: 'papercusp/libs/papercusp',
    });

    expect(Object.fromEntries(await lookupDriftCauseWorkItems(['src/a.ts'], { harnessSlug: 'papercusp' }))).toEqual({
      'src/a.ts': ['WI-HERE'],
    });
  });
});

/**
 * code-intel-delivery-and-outcomes-2026-10-26 P-007: the writer stamps the enclosing
 * function/class names of an edit on its ledger row (migration 1584). Real git, because
 * the changed lines come from diffing the file on disk against its committed HEAD blob;
 * real PG, because the fill is an UPDATE ... RETURNING on the row the INSERT just wrote.
 */
describe('recordEditAttribution symbols capture (real PG + real git, migration 1584)', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  const BASE = [
    "import { readFileSync } from 'node:fs';",
    '',
    'export function alpha(n: number): number {',
    '  return n + 1;',
    '}',
    '',
    'export function beta(n: number): number {',
    '  return n * 2;',
    '}',
    '',
  ].join('\n');

  /** A temp repo whose HEAD holds `committed`; the global hooks path is disabled. */
  function repoWith(committed: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'edit-attr-symbols-'));
    roots.push(root);
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-C', root, '-c', 'user.email=test@example.invalid', '-c', 'user.name=test',
          '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
        { stdio: 'pipe' },
      );
    git('init', '-q');
    for (const [file, text] of Object.entries(committed)) writeFileSync(join(root, file), text);
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    return root;
  }

  async function record(root: string, file: string): Promise<string[] | null> {
    await recordEditAttribution({ repoRoot: root, files: [file], agentId: 'agent-p007' }, { awaitSymbols: true });
    const rows = await h.db!.sql<{ symbols: string[] | null }[]>`
      SELECT symbols FROM harness_shared.edit_attribution_ledger WHERE repo_root = ${root} AND file = ${file}`;
    expect(rows).toHaveLength(1);
    return rows[0]!.symbols;
  }

  it('stores only the function whose body the edit changed in a multi-function file', async () => {
    const root = repoWith({ 'mod.ts': BASE });
    writeFileSync(join(root, 'mod.ts'), BASE.replace('return n * 2;', 'return n * 3;'));

    expect(await record(root, 'mod.ts')).toEqual(['beta']);
  });

  it('stores a measured empty list, not unknown, for an edit outside every symbol', async () => {
    const root = repoWith({ 'mod.ts': BASE });
    writeFileSync(join(root, 'mod.ts'), BASE.replace('readFileSync', 'readFileSync, writeFileSync'));

    expect(await record(root, 'mod.ts')).toEqual([]);
  });

  it('attributes every symbol of a file that is not in HEAD yet', async () => {
    const root = repoWith({ 'README.md': '# base\n' });
    writeFileSync(join(root, 'fresh.ts'), BASE);

    expect(await record(root, 'fresh.ts')).toEqual(['alpha', 'beta']);
  });

  it('leaves symbols NULL (unknown) for a non-TS/JS file', async () => {
    const root = repoWith({ 'notes.md': '# base\n' });
    writeFileSync(join(root, 'notes.md'), '# base\nchanged\n');

    expect(await record(root, 'notes.md')).toBeNull();
  });
});
