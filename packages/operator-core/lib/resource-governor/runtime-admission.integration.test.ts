/** Mixed-interpreter source baseline using the actual PG admission ledger.
 * Set PAPERCUSP_PROBE_BUN to include Bun; its absence never proves Bun parity.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { applyAdmissionLedgerFixture, truncateAdmissionLedgerFixture } from '../../test/_admission-ledger-fixture';
import { measureRuntime, runCapability } from '../../../../scripts/lib/runtime-compatibility.mjs';

const probePath = fileURLToPath(new URL('../../../../scripts/lib/runtime-compatibility-admission.mjs', import.meta.url));
const candidate = { sourceSha: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
  configurationSha256: 'c'.repeat(64), dependencyGeneration: 'admission-source-fixture' };
const executables = [process.execPath, ...(process.env.PAPERCUSP_PROBE_BUN ? [process.env.PAPERCUSP_PROBE_BUN] : [])];
const sources = ['scripts/lib/runtime-compatibility-admission.mjs', 'scripts/lib/runtime-compatibility.mjs',
  'packages/operator-core/lib/resource-governor/runtime-admission.integration.test.ts',
  'packages/operator-core/lib/resource-governor/admission-ledger-store.ts',
  'packages/operator-core/lib/resource-governor/admission.ts', 'packages/operator-core/lib/resource-governor/queue.ts',
  'packages/operator-core/lib/inference-gateway/durable-admission.ts',
  'packages/operator-core/test/_admission-ledger-fixture.ts',
  'libs/papercusp/libs/db/sql/1062-resource-governor-admission-ledger.sql'];
const root = new URL('../../../../', import.meta.url);
const sourceHashes = () => Object.fromEntries(sources.map(path => [path,
  createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex')]));
const receipts: Awaited<ReturnType<typeof runCapability>>[] = [];
let beforeHashes: ReturnType<typeof sourceHashes>;
let db: FreshPgDb;
let runtimes: Awaited<ReturnType<typeof measureRuntime>>[];
const nonce = randomUUID();

beforeAll(async () => {
  beforeHashes = sourceHashes();
  db = await createFreshPgDb('runtime_admission');
  await applyAdmissionLedgerFixture(db.sql);
  await db.sql.unsafe(`CREATE SCHEMA runtime_probe;
    CREATE TABLE runtime_probe.guard (nonce text PRIMARY KEY);
    CREATE TABLE runtime_probe.attempts (attempt text PRIMARY KEY, pid int NOT NULL);
    CREATE TABLE runtime_probe.effects (attempt text PRIMARY KEY, pid int NOT NULL);
    CREATE TABLE runtime_probe.gateway_barrier (attempt text NOT NULL, phase text NOT NULL,
      PRIMARY KEY (attempt, phase));`).simple();
  await db.sql`INSERT INTO runtime_probe.guard (nonce) VALUES (${nonce})`;
  runtimes = await Promise.all(executables.map(executable => measureRuntime(executable)));
}, 90_000);

afterAll(async () => {
  try {
    if (process.env.PAPERCUSP_RUNTIME_ADMISSION_RECEIPTS) writeFileSync(process.env.PAPERCUSP_RUNTIME_ADMISSION_RECEIPTS,
      JSON.stringify({ candidateAcceptance: false, closureAccepted: false, beforeHashes,
        afterHashes: sourceHashes(), runtimes, receipts,
        limitations: ['synthetic candidate identity', 'local source baseline',
          'liveness oracle held live; takeover is expiry based', 'fixture effects are not provider/DBOS delivery',
          'named source hashes do not census transitive child imports', 'no global background-owner proof'] }, null, 2));
  } finally { await db?.cleanup(); }
});
beforeEach(async () => {
  await truncateAdmissionLedgerFixture(db.sql);
  await db.sql`TRUNCATE runtime_probe.attempts, runtime_probe.effects, runtime_probe.gateway_barrier`;
});

function launch(runtime: typeof runtimes[number], attempt: string, action: string,
  expected: unknown, extra: Record<string, string> = {}) {
  return runCapability({ capabilityId: `admission-${action}`, expected, runtime, candidate, probePath }, {
    timeoutMs: 35_000, env: { PAPERCUSP_PROBE_PG_URL: db.url, PAPERCUSP_PROBE_NONCE: nonce,
      PAPERCUSP_PROBE_ATTEMPT: attempt, PAPERCUSP_PROBE_ACTION: action, PAPERCUSP_PROBE_NOW: '10000', ...extra },
  }).then(receipt => { receipts.push(receipt); return receipt; });
}
function passed(receipt: typeof receipts[number]) {
  expect({ status: receipt.status, reasons: receipt.reasons, stderr: receipt.observation.stderr })
    .toMatchObject({ status: 'passed', reasons: [] });
}
async function waitFor(table: 'attempts' | 'effects', count: number) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const rows = await db.sql.unsafe(`SELECT attempt, pid FROM runtime_probe.${table}`);
    if (rows.length === count) return rows;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Admission processes did not reach ${table} before deadline`);
}
async function enqueue(runtime = runtimes[0], attempt = 'producer') {
  passed(await launch(runtime, attempt, 'enqueue', { queued: true }));
  const [row] = await db.sql`SELECT receipt_id FROM harness_shared.resource_governor_admissions`;
  return row.receipt_id as string;
}

describe('admission ledger interpreter baseline', () => {
  it('preserves the gateway winner when a competing facade loses its targeted lease in both runtime directions', async () => {
    for (const [index, runtime] of runtimes.entries()) {
      await truncateAdmissionLedgerFixture(db.sql);
      await db.sql`TRUNCATE runtime_probe.attempts, runtime_probe.effects, runtime_probe.gateway_barrier`;
      const results = await Promise.all([
        launch(runtime, `gateway-winner-${index}`, 'gateway',
          { admitted: true, stateAfterCompetitor: 'running', released: true }, { PAPERCUSP_PROBE_ROLE: 'winner' }),
        launch(runtimes[(index + 1) % runtimes.length], `gateway-loser-${index}`, 'gateway',
          { admitted: false, error: 'AdmissionPersistenceError' }, { PAPERCUSP_PROBE_ROLE: 'loser' }),
      ]);
      results.forEach(passed);
      expect(await db.sql`SELECT attempt FROM runtime_probe.effects`).toEqual([{ attempt: `gateway-winner-${index}` }]);
      const [receipt] = await db.sql`SELECT state, record FROM harness_shared.resource_governor_admissions`;
      expect(receipt.state).toBe('completed');
      expect(receipt.record.lease).toBeUndefined();
      expect(await db.sql`SELECT * FROM harness_shared.work_items`).toHaveLength(0);
    }
  }, 120_000);

  it('converges same-key cross-process enqueues on one persisted receipt', async () => {
    let pending: ReturnType<typeof launch>[] = [];
    try {
      await db.sql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(
          'resource-governor:runtime-admission:runtime-admission:id:same-request', 0))`;
        pending = [runtimes[0], runtimes.at(-1)!].map((runtime, index) =>
          launch(runtime, `enqueue-${index}`, 'enqueue', { queued: true }));
        await waitFor('attempts', 2);
      });
      (await Promise.all(pending)).forEach(passed);
      expect(await db.sql`SELECT state FROM harness_shared.resource_governor_admissions`).toEqual([{ state: 'queued' }]);
      expect(await db.sql`SELECT * FROM harness_shared.work_items`).toHaveLength(0);
    } finally { await Promise.all(pending); }
  }, 60_000);

  it('grants one running lease to simultaneous interpreters on the same row', async () => {
    const receiptId = await enqueue();
    await db.sql`TRUNCATE runtime_probe.attempts`;
    let pending: ReturnType<typeof launch>[] = [];
    try {
      await db.sql.begin(async tx => {
        await tx`SELECT receipt_id FROM harness_shared.resource_governor_admissions WHERE receipt_id=${receiptId} FOR UPDATE`;
        pending = [runtimes[0], runtimes.at(-1)!].map((runtime, index) => launch(runtime,
          `lease-${index}`, 'lease', { leased: true, running: true }, { PAPERCUSP_PROBE_RECEIPT: receiptId }));
        await waitFor('attempts', 2);
      });
      const results = await Promise.all(pending);
      const winner = results.find(r => r.status === 'passed');
      const loser = results.find(r => r.status === 'failed');
      expect(winner).toBeDefined();
      expect(loser).toBeDefined();
      passed(winner!);
      expect(loser!.reasons).toEqual(['incorrect-result']);
      expect(loser!.actual).toEqual({ leased: false, running: false });
      expect(await db.sql`SELECT * FROM runtime_probe.effects`).toHaveLength(1);
    } finally { await Promise.all(pending); }
  }, 60_000);

  it('recovers expired killed owners in both runtime directions and fences their stale tokens', async () => {
    for (const [index, runtime] of runtimes.entries()) {
      await truncateAdmissionLedgerFixture(db.sql);
      await db.sql`TRUNCATE runtime_probe.attempts, runtime_probe.effects`;
      const receiptId = await enqueue(runtime, `producer-${index}`);
      const oldLease = `killed-${index}`;
      const pending = launch(runtime, oldLease, 'hold', { leased: true, running: true },
        { PAPERCUSP_PROBE_RECEIPT: receiptId });
      try {
        const [effect] = await waitFor('effects', 1);
        expect(effect.attempt).toBe(oldLease);
        process.kill(-Number(effect.pid), 'SIGKILL');
        const killed = await pending;
        expect(killed.observation).toMatchObject({ signal: 'SIGKILL', timedOut: false, receipts: [] });
        expect(killed.reasons).toEqual(['abnormal-exit', 'missing-or-duplicate-completion']);
        const replacement = runtimes[(index + 1) % runtimes.length];
        const replacementLease = `replacement-${index}`;
        const extra = { PAPERCUSP_PROBE_RECEIPT: receiptId, PAPERCUSP_PROBE_NOW: '11001' };
        passed(await launch(replacement, replacementLease, 'lease', { leased: true, running: true }, extra));
        passed(await launch(runtime, `stale-${index}`, 'stale', { running: false, completed: false },
          { ...extra, PAPERCUSP_PROBE_OLD_LEASE: oldLease }));
        const [running] = await db.sql`SELECT state, record FROM harness_shared.resource_governor_admissions`;
        expect(running.state).toBe('running');
        expect(running.record.lease.leaseId).toBe(replacementLease);
        expect(running.record.lease.generation).toBeGreaterThan(1);
        passed(await launch(replacement, `complete-${index}`, 'complete', { completed: true },
          { ...extra, PAPERCUSP_PROBE_OLD_LEASE: replacementLease }));
        const [completed] = await db.sql`SELECT state, record FROM harness_shared.resource_governor_admissions`;
        expect(completed.state).toBe('completed');
        expect(completed.record.resultRef).toBe('runtime-result');
        expect(completed.record.lease).toBeUndefined();
      } finally { await pending; }
    }
    expect(sourceHashes()).toEqual(beforeHashes);
  }, 180_000);
});
