/**
 * P-011 (plan verification-system-improvements-2026-10-10): every test run recorded in the
 * ledger carries the configuration its MEASURED process ran under, in
 * test_runs.configuration_snapshot (migration 1448). A bar that declares a production
 * configuration is judged against that snapshot, so a recorded run without one can never
 * prove such a bar.
 *
 * Integration, not unit, on purpose: the snapshot is captured inside the Vitest reporter of
 * the CHILD process the router spawns, then written over a real Postgres connection. Unit
 * tests pin each half (the reporter's insert shape, the store's INSERT params); only a real
 * run establishes that the child's environment is what reaches the stored row. Each case
 * plants a one-off PAPERCUSP_FLAG_* value in the environment the child inherits and checks
 * that exact value comes back out of the stored, fingerprint-verified snapshot.
 *
 *   SPEC-P-011-RUNNER-CAPTURE   — testing:run records a fingerprint on every row it records.
 *   SPEC-P-011-MUTATION-CAPTURE — a mutation-probe row (source='mutation-probe', written by the
 *                                 same router + reporter the probe drives) carries one too.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { _resetForTests, getOrgPg } from '@papercusp/db-org';
import { readConfigurationSnapshot } from '@papercusp/test-config/configuration-snapshot';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { _resetHarnessAdminUrlCacheForTests } from '../../embedded-pg-discovery';
import { REPO_ROOT } from '../docs/_repo-paths';
import runTool from './run';

const execFileAsync = promisify(execFile);

/** A small, stable, DB-free suite with a tiny import closure. */
const SUITE = 'packages/operator-core/lib/testing-flakiness.test.ts';
/** Recorded raw by captureConfigurationSnapshot (CONFIGURATION_SNAPSHOT_RAW_ENV_KEY). */
const MARKER = 'PAPERCUSP_FLAG_P011_CAPTURE_PROBE';

const ENV_KEYS = [
  'HARNESS_DATABASE_URL', 'HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL',
  'PAPERCUSP_PGBOUNCER', 'PAPERCUSP_SKIP_PG_DISCOVERY', MARKER,
] as const;
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

let org: OrgTestDb | undefined;

function callTestingRun(args: Record<string, unknown>, ctx: Record<string, unknown>) {
  return (runTool as unknown as { handler: (a: unknown, c: unknown) => Promise<unknown> }).handler(args, ctx);
}

type RunResult = { ok: boolean; runId?: string; testRunIds?: number[] };

/** testing:run returns its result as `data` or as an MCP-style text envelope. */
function unwrap(raw: unknown): RunResult {
  const envelope = raw as { data?: unknown; content?: Array<{ text?: string }> } | null;
  if (envelope?.data !== undefined) return envelope.data as RunResult;
  const text = envelope?.content?.[0]?.text;
  if (typeof text === 'string') return JSON.parse(text) as RunResult;
  throw new Error(`unrecognised testing:run result shape: ${JSON.stringify(raw)?.slice(0, 200)}`);
}

type LedgerRow = { id: string; source: string; phase: string | null; configuration_snapshot: unknown };

beforeAll(async () => {
  // Every nested router and its reporter write to this suite's disposable migrated database.
  org = await createOrgTestDb();
  process.env.HARNESS_DATABASE_URL = org.appDsn;
  process.env.HARNESS_ADMIN_DATABASE_URL = org.adminDsn;
  process.env.DATABASE_URL = org.adminDsn;
  process.env.PAPERCUSP_PGBOUNCER = '0';
  process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
  _resetHarnessAdminUrlCacheForTests();
  await _resetForTests();
}, 120_000);

afterEach(() => {
  delete process.env[MARKER];
});

afterAll(async () => {
  try {
    await _resetForTests();
    await org?.cleanup();
  } finally {
    for (const key of ENV_KEYS) {
      const saved = savedEnv.get(key);
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
    _resetHarnessAdminUrlCacheForTests();
  }
});

/** Every row must hold a snapshot whose fingerprint recomputes and that saw `nonce`. */
function expectCapturedBy(rows: readonly LedgerRow[], nonce: string): void {
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    const snapshot = readConfigurationSnapshot(row.configuration_snapshot);
    expect(snapshot, `test_runs ${row.id} has no verifiable configuration_snapshot`).not.toBeNull();
    expect(snapshot!.fingerprint).toMatch(/^sha256-config-snapshot-v1:[0-9a-f]{64}$/);
    expect(snapshot!.flagEnv[MARKER], `test_runs ${row.id} snapshot is not from this run's child`).toBe(nonce);
  }
}

describe('configuration snapshot capture on recorded test runs (P-011)', () => {
  it('SPEC-P-011-RUNNER-CAPTURE: testing:run records the measured child configuration on every row it records', async () => {
    const nonce = randomUUID();
    process.env[MARKER] = nonce;
    const out = unwrap(await callTestingRun(
      { files: [SUITE], harness: 'papercusp' },
      { projectDir: REPO_ROOT, harnessSlug: '*', workspaceId: 'papercusp-workspace' },
    ));
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(typeof out.runId).toBe('string');

    const rows = await getOrgPg().sql<LedgerRow[]>`
      SELECT id::text AS id, source, execution_details->>'mutationPhase' AS phase, configuration_snapshot
        FROM harness_shared.test_runs
       WHERE run_group_id = ${out.runId!}
    `;
    // Calibration: the run really recorded the suite, so an empty row set cannot pass vacuously.
    expect(rows.length).toBeGreaterThan(0);
    expect(out.testRunIds).toEqual(expect.arrayContaining(rows.map((row) => Number(row.id))));
    expectCapturedBy(rows, nonce);
  }, 180_000);

  it('SPEC-P-011-MUTATION-CAPTURE: a mutation-probe run recorded in the ledger carries the configuration fingerprint', async () => {
    const nonce = randomUUID();
    const receiptDir = await mkdtemp(join(tmpdir(), 'p011-mutation-capture-'));
    const receiptFile = join(receiptDir, 'receipts.jsonl');
    try {
      // Exactly the child environment scripts/mutation-probe.sh run_guard exports around a
      // guard command, driving the same router a probe's --test command runs.
      // Drop the OUTER pc-heavy wrapper's per-run marker paths (PC_HEAVY_PREEMPT_READY_FILE,
      // PC_HEAVY_PSI_FINALIZATION_FILE, …): a nested router inheriting them republishes the
      // parent's unique marker and refuses with EEXIST when this file runs under test:file.
      const outerEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('PC_HEAVY_')),
      );
      await execFileAsync(process.execPath, ['scripts/test-files.mjs', SUITE], {
        cwd: REPO_ROOT,
        env: {
          ...outerEnv,
          [MARKER]: nonce,
          PAPERCUSP_MUTATION_PROBE: '1',
          PAPERCUSP_MUTATION_PHASE: 'baseline',
          PAPERCUSP_TEST_RUN_RECEIPT_FILE: receiptFile,
        },
        timeout: 150_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      const receipts = (await readFile(receiptFile, 'utf8')).trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as { outcome: string; id?: string });
      const ids = receipts.filter((receipt) => receipt.outcome === 'inserted').map((receipt) => String(receipt.id));
      expect(ids.length, JSON.stringify(receipts)).toBeGreaterThan(0);

      const rows = await getOrgPg().sql<LedgerRow[]>`
        SELECT id::text AS id, source, execution_details->>'mutationPhase' AS phase, configuration_snapshot
          FROM harness_shared.test_runs
         WHERE id::text = ANY(${ids})
      `;
      expect(rows).toHaveLength(ids.length);
      for (const row of rows) {
        expect(row.source).toBe('mutation-probe');
        expect(row.phase).toBe('baseline');
      }
      expectCapturedBy(rows, nonce);
    } finally {
      await rm(receiptDir, { recursive: true, force: true });
    }
  }, 180_000);
});
