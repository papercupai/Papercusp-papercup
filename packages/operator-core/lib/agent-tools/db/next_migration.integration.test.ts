/**
 * next_migration.integration.test.ts
 *
 * handoff-coordination-dx-followups-2026-06-04 §A1 — automated coverage for the
 * migration-number allocator (`db:next-migration`).
 *
 * Plan acceptance: "two concurrent allocations never collide". The allocator
 * hands out GREATEST(max-on-disk, max-reserved, max-applied) + 1 under a pg advisory lock
 * (pg_advisory_xact_lock), recorded in harness_shared.migration_reservations
 * (the `num` PK is the last-line-of-defence). This proves, against a REAL
 * Postgres (testcontainer) with migration 135 applied:
 *
 *   1. CONCURRENCY — N parallel handler calls on a pooled (max>1) connection
 *      return N DISTINCT, sequential numbers (the advisory lock serialises the
 *      read-compute-insert across connections, so no two callers see the same
 *      MAX(num)). This is the headline anti-collision invariant.
 *   2. RESERVATION-MAX — a single allocation after the run is max(reserved)+1.
 *   3. FILESYSTEM-MAX — an UNRESERVED on-disk `NNN-*.sql` higher than any
 *      reservation is still respected (the tool folds in the fs max), so a peer
 *      who wrote a file without reserving cannot be clobbered.
 *   4. APPLIED-MAX (EI-353) — a number recorded applied in schema_migrations is
 *      taken even when its file is in no scanned tree and was never reserved.
 *   5. CANONICAL-TREE (EI-353) — a file in the PAPERCUSP_INTEGRATION_ROOT tree's
 *      sql dir is respected even when the serving checkout's dir lags it.
 *
 * Mirrors the testcontainer + vi.mock('@papercusp/db-org') setup of
 * harness-issues.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../../libs/papercusp/libs/db/sql');
// Strip psql metacommands exactly like the migration runner so the real 135
// file applies via postgres-js .simple().
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line))
    .join('\n');

// Holders the hoisted vi.mock factories reach (assigned in beforeAll — avoids TDZ).
const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  sqlDir: '' as string,
}));

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
// The tool reads the filesystem max from resolveSqlDir(); point it at a temp
// dir we control so fsMax is deterministic (independent of the real sql/ tree).
vi.mock('../../migration-drift', async () => {
  const actual = await vi.importActual<typeof import('../../migration-drift')>('../../migration-drift');
  return { ...actual, resolveSqlDir: () => h.sqlDir };
});

// Imported AFTER the mocks are registered (vi.mock is hoisted).
const { default: tool, ALLOC_ADVISORY_KEY } = await import('./next_migration');

// Superuser ctx so resolveAgentIdentity attributes the reservation without mocking.
const CTX = { isSuperuser: true, uiClientId: 'a1-alloc-test-client' } as never;

let rootSql: postgres.Sql;
let dbName: string;

type AllocateArgs = {
  harness?: string;
  name?: string;
  intent?: string;
  by?: string;
  force?: boolean;
};

async function allocate(args: AllocateArgs = {}): Promise<{
  ok: boolean;
  number?: number;
  path?: string;
  arm_path?: string;
  arm_command?: string;
  requested_from_harness?: string;
  note?: string;
  error?: string;
}> {
  // These calls intentionally exercise the allocator's repeated-number
  // sequence. WI-38353's default dedup guard is covered explicitly below;
  // force is required here so the sequence assertions do not get mistaken
  // for multiple agents proposing the same migration work.
  const res = (await tool.handler(
    { name: 'integration-allocation', force: true, ...args } as never,
    CTX,
  )) as { content: { text: string }[] };
  return JSON.parse(res.content[0]!.text);
}

beforeAll(async () => {
  const adminUri = await getTestPg();
  dbName = `nm_${randomBytes(5).toString('hex')}`;
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
  // The real migration that creates the allocator ledger.
  await rootSql.unsafe(readMigration('135-migration-reservations.sql')).simple();
  // The applied-migrations tracker the runner creates on boot (the allocator's
  // third GREATEST input since EI-353) — same shape as the real one.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now(),
      sha256     text NOT NULL
    )`);
  // The canonical-tree leg reads both environment overrides at call time —
  // keep them inert (dev boxes export them) until the canonical-tree test
  // points PAPERCUSP_INTEGRATION_ROOT at a controlled temp root, so fsMax stays
  // deterministic.
  vi.stubEnv('PAPERCUSP_CANONICAL_TREE', '');
  vi.stubEnv('PAPERCUSP_INTEGRATION_ROOT', '');

  // A POOLED connection (max>1) so concurrent sql.begin() calls in the handler
  // actually run on separate connections — that is what makes the advisory-lock
  // serialisation a real test rather than connection-level serialisation.
  h.sql = postgres(u.toString(), { max: 12, onnotice: () => {} });

  // Temp sql dir with an on-disk max of 137 → first allocation is 138.
  h.sqlDir = mkdtempSync(join(tmpdir(), 'a1-nm-'));
  writeFileSync(join(h.sqlDir, '100-foo.sql'), '-- x');
  writeFileSync(join(h.sqlDir, '137-bar.sql'), '-- x');
}, 90_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await h.sql?.end({ timeout: 5 });
  await rootSql?.end({ timeout: 5 });
});

describe('db:next-migration allocator (§A1)', () => {
  it('rejects missing or slug-empty names before touching the reservation ledger', async () => {
    expect(tool.args.safeParse({ force: true }).success).toBe(false);
    expect(tool.args.safeParse({ name: '!!!', force: true }).success).toBe(false);
    expect(tool.args.safeParse({ name: 'valid-migration', force: true }).success).toBe(true);

    const before = await rootSql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM harness_shared.migration_reservations`;
    for (const args of [{ force: true }, { name: '   ', force: true }, { name: '!!!', force: true }]) {
      const res = (await tool.handler(args as never, CTX)) as { content: { text: string }[] };
      expect(JSON.parse(res.content[0]!.text)).toMatchObject({ ok: false, error: 'invalid_name' });
    }
    const after = await rootSql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM harness_shared.migration_reservations`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('two+ CONCURRENT allocations never collide — N parallel calls → N distinct sequential numbers', async () => {
    const N = 12;
    const results = await Promise.all(Array.from({ length: N }, () => allocate()));
    expect(results.every((r) => r.ok)).toBe(true);

    const numbers = results.map((r) => r.number!);
    // All distinct — the core anti-collision guarantee.
    expect(new Set(numbers).size).toBe(N);
    // Contiguous block starting at fsMax+1 (138) — the advisory lock means each
    // caller sees the previous insert, so there are no gaps or repeats.
    expect([...numbers].sort((a, b) => a - b)).toEqual(
      Array.from({ length: N }, (_, i) => 138 + i),
    );

    // And the ledger has exactly N rows, all unique (the `num` PK held).
    const rows = await rootSql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM harness_shared.migration_reservations`;
    expect(rows[0]!.n).toBe(N);
  });

  it('reservation-max wins: the next single allocation is max(reserved)+1', async () => {
    const r = await allocate();
    expect(r.ok).toBe(true);
    expect(r.number).toBe(150); // GREATEST(fsMax 137, reserved 149) + 1
  });

  it('EI-20213083520776566: accepts a harness-scoped coding call without partitioning the workspace-global allocation', async () => {
    const res = (await tool.handler(
      { harness: 'papercusp', name: 'scoped-call', force: true } as never,
      CTX,
    )) as { content: { text: string }[] };
    const out = JSON.parse(res.content[0]!.text) as {
      ok: boolean;
      number?: number;
      requested_from_harness?: string;
    };
    expect(out.ok).toBe(true);
    expect(out.number).toBe(151); // same global reservation sequence, not a per-harness counter
    expect(out.requested_from_harness).toBe('papercusp');
  });

  it('accepts the CLI-documented by attribution on the MCP door', async () => {
    const res = (await tool.handler(
      { name: 'compatible-by', by: 'su-explicit-label', force: true } as never,
      CTX,
    )) as { content: { text: string }[] };
    const out = JSON.parse(res.content[0]!.text) as { ok: boolean; reserved_by?: string };
    expect(out).toMatchObject({ ok: true, reserved_by: 'su-explicit-label' });
    const [row] = await rootSql<{ reserved_by: string }[]>`
      SELECT reserved_by FROM harness_shared.migration_reservations ORDER BY num DESC LIMIT 1`;
    expect(row?.reserved_by).toBe('su-explicit-label');
  });

  it('filesystem-max is respected: an unreserved on-disk NNN-*.sql higher than any reservation bumps the number', async () => {
    writeFileSync(join(h.sqlDir, '300-baz.sql'), '-- a peer wrote this without reserving');
    const r = await allocate();
    expect(r.ok).toBe(true);
    expect(r.number).toBe(301); // GREATEST(fsMax 300, reserved 150) + 1
  });

  it('applied-max is respected (EI-353): a schema_migrations row with no file and no reservation still takes its number', async () => {
    await rootSql`
      INSERT INTO harness_shared.schema_migrations (filename, sha256)
      VALUES ('400-applied-elsewhere.sql', 'test-sha')`;
    const r = await allocate();
    expect(r.ok).toBe(true);
    expect(r.number).toBe(401); // GREATEST(fsMax 300, reserved 301, applied 400) + 1
  });

  it('canonical-tree files are respected (EI-353): PAPERCUSP_INTEGRATION_ROOT sql dir is scanned alongside the serving dir', async () => {
    // Simulate the deployed shape: the serving checkout (h.sqlDir) lags the
    // canonical staging tree, where a peer just wrote 500-*.sql.
    const integrationRoot = mkdtempSync(join(tmpdir(), 'a1-nm-canon-'));
    const canonSqlDir = join(integrationRoot, 'libs/papercusp/libs/db/sql');
    mkdirSync(canonSqlDir, { recursive: true });
    writeFileSync(join(canonSqlDir, '500-staging-only.sql'), '-- only in the canonical tree');
    vi.stubEnv('PAPERCUSP_INTEGRATION_ROOT', integrationRoot);
    const r = await allocate();
    expect(r.ok).toBe(true);
    expect(r.number).toBe(501); // GREATEST(fsMax 500 via canonical, reserved 401, applied 400) + 1
  });

  it('EI-2127: succeeds from a client-less superuser ctx (no uiClientId) — resolveAgentIdentity falls back instead of throwing', async () => {
    // The exact failing shape the watchdog flagged: a superuser MCP call with no
    // ?client= / Mcp-Session-Id. Before the resolver fix this threw
    // "superuser context is missing uiClientId" and the allocation failed; now
    // it resolves the stable su fallback and the reservation lands. Run last so
    // it does not perturb the sequential reservation counter the tests above pin.
    const clientlessSu = { isSuperuser: true } as never;
    const res = (await tool.handler(
      { name: 'clientless-superuser', force: true } as never,
      clientlessSu,
    )) as { content: { text: string }[] };
    const out = JSON.parse(res.content[0]!.text) as {
      ok: boolean;
      number?: number;
      reserved_by?: string;
    };
    expect(out.ok).toBe(true);
    expect(typeof out.number).toBe('number');
    // Attributed to the superuser fallback identity, not an anonymous/empty owner.
    expect(out.reserved_by).toMatch(/^su · /);
  });

  it('EI-19366138707071397: hands back a `.DRAFT`-suffixed write target, not the bare `.sql` name a peer editing it could race the boot auto-apply on', async () => {
    const r = await allocate();
    expect(r.ok).toBe(true);
    expect(r.path).toMatch(/\.sql\.DRAFT$/);
    expect(r.path?.endsWith('.sql')).toBe(false);
    expect(r.arm_path).toMatch(/\.sql$/);
    expect(r.arm_command).toBe("npx tsx scripts/next-migration.mjs --arm '" + r.path + "'");
    expect(r.note).toContain(r.arm_command);
  });

  it('EI-6852: the filesystem max is read INSIDE the advisory lock — a peer file written DURING the lock window is still respected (no stale-fsMax TOCTOU collision)', async () => {
    // Reproduce the reported race: a concurrent agent writes a higher-numbered
    // NNN-*.sql AFTER this call would have read its fsMax but BEFORE it inserts
    // its reservation. We force that window by holding the allocator's advisory
    // lock on a side connection while the tool is mid-call, writing a late file,
    // then releasing.
    //   Pre-fix: fsMax was read synchronously BEFORE `sql.begin` (before the
    //   lock), so it was stale by the time the reservation landed and the tool
    //   handed out an already-used-on-disk number (503 here — missing the 900).
    //   Post-fix: fsMax is scanned UNDER the lock, immediately before the
    //   insert, so the late 900 file is folded in → 901.
    let releaseLock!: () => void;
    const lockReleased = new Promise<void>((r) => {
      releaseLock = r;
    });
    let markAcquired!: () => void;
    const lockAcquired = new Promise<void>((r) => {
      markAcquired = r;
    });
    // Hold the allocator advisory lock on a side connection — a stand-in for a
    // peer allocation that is mid-reservation. The xact lock is held until the
    // begin() callback resolves (i.e. until we release it below).
    const holderDone = rootSql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${ALLOC_ADVISORY_KEY})`;
      markAcquired();
      await lockReleased;
    });
    await lockAcquired;

    // Start the allocation — it blocks on the advisory lock. (Pre-fix it has
    // already captured its stale fsMax synchronously before this point.)
    const toolPromise = allocate();
    // Give the tool time to reach and block on the lock.
    await new Promise((r) => setTimeout(r, 150));

    // A peer writes a much-higher-numbered migration DURING the lock window —
    // after the tool started, before its reservation lands.
    writeFileSync(join(h.sqlDir, '900-written-during-lock.sql'), '-- late peer file');

    // Release the held lock → the tool proceeds and must now observe the 900 file.
    releaseLock();
    await holderDone;

    const r = await toolPromise;
    expect(r.ok).toBe(true);
    expect(r.number).toBe(901); // GREATEST(fsMax 900 via the late file, reserved 502, applied 400) + 1
  });

  it('WI-38353: refuses a near-identical recent reservation unless forced', async () => {
    const name = `dedup-guard-${randomBytes(6).toString('hex')}`;
    const first = await allocate({ name });
    expect(first.ok).toBe(true);

    const duplicate = await allocate({ name, force: false });
    expect(duplicate).toMatchObject({ ok: false, error: 'redundant_migration' });
  });
});
