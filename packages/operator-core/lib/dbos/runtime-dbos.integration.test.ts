/** Local source baseline, with real SDK migrations, queue admission and replay.
 * PAPERCUSP_PROBE_BUN opts Bun into the measured runtime population; Node alone
 * never establishes Bun compatibility or production-bootstrap acceptance.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { measureRuntime, runCapability } from '../../../../scripts/lib/runtime-compatibility.mjs';

const root = new URL('../../../../', import.meta.url);
const probePath = fileURLToPath(new URL('scripts/lib/runtime-compatibility-dbos.mjs', root));
const candidate = { sourceSha: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
  configurationSha256: 'c'.repeat(64), dependencyGeneration: 'dbos-source-fixture' };
const sources = ['scripts/lib/runtime-compatibility-dbos.mjs', 'scripts/lib/runtime-compatibility.mjs',
  'packages/operator-core/lib/dbos/runtime-dbos.integration.test.ts',
  'packages/operator-core/lib/observability/tracing.ts',
  'node_modules/@dbos-inc/dbos-sdk/package.json',
  'node_modules/@dbos-inc/dbos-sdk/dist/src/system_database.js',
  'node_modules/@dbos-inc/dbos-sdk/dist/src/dbos-executor.js',
  'node_modules/@dbos-inc/dbos-sdk/dist/src/debugpoint.js',
  'patches/@dbos-inc+dbos-sdk+4.27.6.patch'];
const sourceHashes = () => Object.fromEntries(sources.map(path => [path,
  createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex')]));
const receipts: Awaited<ReturnType<typeof runCapability>>[] = [];
let beforeHashes: ReturnType<typeof sourceHashes>;
let db: FreshPgDb;
let runtimes: Awaited<ReturnType<typeof measureRuntime>>[];
const nonce = randomUUID();

beforeAll(async () => {
  beforeHashes = sourceHashes();
  db = await createFreshPgDb('runtime_dbos');
  await db.sql.unsafe(`CREATE SCHEMA runtime_probe;
    CREATE TABLE runtime_probe.guard (nonce text PRIMARY KEY);
    CREATE TABLE runtime_probe.gates (workflow_id text PRIMARY KEY, released boolean NOT NULL);
    CREATE TABLE runtime_probe.ready (workflow_id text NOT NULL, attempt text NOT NULL,
      PRIMARY KEY (workflow_id, attempt));
    CREATE TABLE runtime_probe.checkpoints (workflow_id text NOT NULL, attempt text NOT NULL, pid int NOT NULL);
    CREATE TABLE runtime_probe.effects (workflow_id text NOT NULL, phase text NOT NULL, attempt text NOT NULL);`).simple();
  await db.sql`INSERT INTO runtime_probe.guard (nonce) VALUES (${nonce})`;
  const executables = [process.execPath, ...(process.env.PAPERCUSP_PROBE_BUN ? [process.env.PAPERCUSP_PROBE_BUN] : [])];
  runtimes = await Promise.all(executables.map(executable => measureRuntime(executable)));
  passed(await launch(runtimes[0], 'initialize', 'initialize', undefined, 'initializer', { initialized: true }));
}, 90_000);

afterAll(async () => {
  try {
    if (process.env.PAPERCUSP_RUNTIME_DBOS_RECEIPTS) writeFileSync(process.env.PAPERCUSP_RUNTIME_DBOS_RECEIPTS,
      JSON.stringify({ candidateAcceptance: false, closureAccepted: false, beforeHashes,
        afterHashes: sourceHashes(), runtimes, receipts, limitations: ['synthetic candidate identity',
          'local SDK source baseline; production bootstrap and transitive dependencies not censused',
          'crash occurs after first step checkpoint; not atomic external-effect delivery',
          'no global background-owner, provider, platform, deployed or rollback proof'] }, null, 2));
  } finally { await db?.cleanup(); }
});

function launch(runtime: typeof runtimes[number], attempt: string, action: string,
  workflow: string | undefined, executor: string, expected: unknown = { result: { value: 42 } }, peers = 1) {
  return runCapability({ capabilityId: `dbos-${action}`, expected, runtime, candidate, probePath }, {
    timeoutMs: 60_000, env: { PAPERCUSP_PROBE_PG_URL: db.url, PAPERCUSP_PROBE_NONCE: nonce,
      PAPERCUSP_PROBE_ATTEMPT: attempt, PAPERCUSP_PROBE_ACTION: action, PAPERCUSP_PROBE_EXECUTOR: executor,
      ...(workflow ? { PAPERCUSP_PROBE_WORKFLOW: workflow } : {}), PAPERCUSP_PROBE_PEERS: String(peers) },
  }).then(receipt => { receipts.push(receipt); return receipt; });
}
function passed(receipt: typeof receipts[number]) {
  expect({ status: receipt.status, reasons: receipt.reasons, stderr: receipt.observation.stderr })
    .toMatchObject({ status: 'passed', reasons: [] });
}
async function effects(workflow: string) {
  return db.sql`SELECT phase, count(*)::int AS count FROM runtime_probe.effects
    WHERE workflow_id = ${workflow} GROUP BY phase ORDER BY phase`;
}
async function checkpoint(workflow: string) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const [row] = await db.sql`SELECT attempt, pid FROM runtime_probe.checkpoints WHERE workflow_id = ${workflow}`;
    if (row) return row;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('DBOS owner did not reach the post-checkpoint gate');
}

describe('DBOS mixed interpreter source baseline', () => {
  it('executes one queued workflow with simultaneous Node/Bun executors', async () => {
    const workflow = 'runtime-dbos-race';
    await db.sql`INSERT INTO runtime_probe.gates (workflow_id, released) VALUES (${workflow}, true)`;
    const results = await Promise.all([runtimes[0], runtimes.at(-1)!].map((runtime, index) =>
      launch(runtime, `race-${index}`, 'run', workflow, `race-executor-${index}`, undefined, 2)));
    results.forEach(passed);
    expect(await effects(workflow)).toEqual([{ phase: 'after', count: 1 }, { phase: 'before', count: 1 }]);
    expect(await db.sql`SELECT status FROM dbos.workflow_status WHERE workflow_uuid = ${workflow}`)
      .toEqual([{ status: 'SUCCESS' }]);
  }, 150_000);

  it('keeps a distinct workflow queued while another executor holds the single queue slot', async () => {
    const first = 'runtime-dbos-slot-first';
    const second = 'runtime-dbos-slot-second';
    await db.sql`INSERT INTO runtime_probe.gates (workflow_id, released)
      VALUES (${first}, false), (${second}, true)`;
    const pending = [launch(runtimes[0], 'slot-holder', 'run', first, 'slot-holder-executor')];
    try {
      await checkpoint(first);
      pending.push(launch(runtimes.at(-1)!, 'slot-waiter', 'run', second, 'slot-waiter-executor'));
      const deadline = Date.now() + 25_000;
      let admitted = false;
      while (Date.now() < deadline) {
        const [row] = await db.sql`SELECT status FROM dbos.workflow_status WHERE workflow_uuid = ${second}`;
        if (row) { expect(row.status).toBe('ENQUEUED'); admitted = true; break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(admitted).toBe(true);
      // The SDK poller has multiple chances to claim the waiting distinct ID.
      // Workflow-ID deduplication cannot account for this exclusion.
      await new Promise(resolve => setTimeout(resolve, 2_500));
      expect(await effects(second)).toEqual([]);
      expect(await db.sql`SELECT status FROM dbos.workflow_status WHERE workflow_uuid = ${second}`)
        .toEqual([{ status: 'ENQUEUED' }]);
      await db.sql`UPDATE runtime_probe.gates SET released = true WHERE workflow_id = ${first}`;
      (await Promise.all(pending)).forEach(passed);
      for (const workflow of [first, second]) {
        expect(await effects(workflow)).toEqual([{ phase: 'after', count: 1 }, { phase: 'before', count: 1 }]);
      }
    } finally {
      await db.sql`UPDATE runtime_probe.gates SET released = true WHERE workflow_id = ${first}`;
      await Promise.all(pending);
    }
  }, 150_000);

  it('replays checkpointed work after SIGKILL in both interpreter directions', async () => {
    for (const [index, runtime] of runtimes.entries()) {
      const workflow = `runtime-dbos-recovery-${index}`;
      const executor = `runtime-recovery-executor-${index}`;
      await db.sql`INSERT INTO runtime_probe.gates (workflow_id, released) VALUES (${workflow}, false)`;
      const pending = launch(runtime, `killed-${index}`, 'run', workflow, executor);
      try {
        const owner = await checkpoint(workflow);
        expect(owner.attempt).toBe(`killed-${index}`);
        const [row] = await db.sql`SELECT status, executor_id FROM dbos.workflow_status WHERE workflow_uuid = ${workflow}`;
        expect(row).toEqual({ status: 'PENDING', executor_id: executor });
        process.kill(-Number(owner.pid), 'SIGKILL');
        const killed = await pending;
        expect(killed.observation).toMatchObject({ signal: 'SIGKILL', timedOut: false, receipts: [] });
        expect(killed.reasons).toEqual(['abnormal-exit', 'missing-or-duplicate-completion']);
        await db.sql`UPDATE runtime_probe.gates SET released = true WHERE workflow_id = ${workflow}`;
        passed(await launch(runtimes[(index + 1) % runtimes.length], `replacement-${index}`, 'recover', workflow, executor));
        expect(await effects(workflow)).toEqual([{ phase: 'after', count: 1 }, { phase: 'before', count: 1 }]);
        const [done] = await db.sql`SELECT status, recovery_attempts FROM dbos.workflow_status WHERE workflow_uuid = ${workflow}`;
        expect(done.status).toBe('SUCCESS');
        expect(Number(done.recovery_attempts)).toBeGreaterThan(1);
      } finally { await pending; }
    }
    expect(sourceHashes()).toEqual(beforeHashes);
  }, 240_000);
});
