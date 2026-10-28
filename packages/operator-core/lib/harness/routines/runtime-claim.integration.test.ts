/** Cross-process runtime baseline for the real claim primitive, with real PG.
 * Node controls always run. Set PAPERCUSP_PROBE_BUN to an absolute interpreter
 * to also measure mixed Node/Bun races; absence is not Bun acceptance.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { measureRuntime, runCapability } from '../../../../../scripts/lib/runtime-compatibility.mjs';

const probePath = fileURLToPath(new URL('../../../../../scripts/lib/runtime-compatibility-claims.mjs', import.meta.url));
const candidate = { sourceSha: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
  configurationSha256: 'c'.repeat(64), dependencyGeneration: 'routine-claim-source-fixture' };
const executables = [process.execPath, ...(process.env.PAPERCUSP_PROBE_BUN ? [process.env.PAPERCUSP_PROBE_BUN] : [])];
let db: FreshPgDb;
let runtimes: Awaited<ReturnType<typeof measureRuntime>>[];
const nonce = randomUUID();

beforeAll(async () => {
  db = await createFreshPgDb('runtime_claim');
  // Same minimal routine projection used by claim.integration.test.ts. There
  // are no plan-schedule or pure-loop rows here, so their ancillary stores are
  // outside this baseline. The actual claim and dispatch SQL run unchanged.
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.routines (
      id text PRIMARY KEY, install_slug text NOT NULL, name text NOT NULL,
      trigger_kind text NOT NULL, trigger_config jsonb NOT NULL, target_role text NOT NULL,
      active boolean NOT NULL DEFAULT true, last_fired_at timestamptz, next_fire_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(), workspace_id text NOT NULL,
      reschedule_interval_sec integer
    );
    CREATE SCHEMA runtime_probe;
    CREATE TABLE runtime_probe.guard (nonce text PRIMARY KEY);
    CREATE TABLE runtime_probe.attempts (attempt text PRIMARY KEY);
    CREATE TABLE runtime_probe.effects (attempt text PRIMARY KEY);
  `).simple();
  await db.sql`INSERT INTO runtime_probe.guard (nonce) VALUES (${nonce})`;
  runtimes = await Promise.all(executables.map(executable => measureRuntime(executable)));
}, 90_000);

afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.routines, runtime_probe.attempts, runtime_probe.effects`;
});

async function insertRoutine(id: string, recurring = true) {
  await db.sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, workspace_id, next_fire_at)
    VALUES (${id}, 'runtime-fixture', ${id}, 'schedule',
            ${JSON.stringify(recurring ? { cron: '0 0 * * *' } : {})}::text::jsonb,
            'runtime-fixture', 'runtime-fixture', now() - interval '1 minute')`;
}

function launch(runtime: typeof runtimes[number], id: string, attempt: string,
  expected: { claimed: boolean | null; allowed: boolean }, action = 'claim') {
  return runCapability({ capabilityId: `routine-${action}`, expected, runtime, candidate, probePath }, {
    timeoutMs: 25_000,
    env: { PAPERCUSP_PROBE_PG_URL: db.url, PAPERCUSP_PROBE_NONCE: nonce,
      PAPERCUSP_PROBE_ROUTINE_ID: id, PAPERCUSP_PROBE_ATTEMPT: attempt, PAPERCUSP_PROBE_ACTION: action },
  });
}

async function captured(count: number) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const [row] = await db.sql`SELECT count(*)::int AS count FROM runtime_probe.attempts`;
    if (row.count === count) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Claim processes did not capture their snapshots before the deadline');
}

function assertPassed(receipt: Awaited<ReturnType<typeof runCapability>>) {
  expect({ status: receipt.status, reasons: receipt.reasons, stderr: receipt.observation.stderr })
    .toMatchObject({ status: 'passed', reasons: [] });
}

describe('routine claim interpreter baseline', () => {
  it.each([true, false])('selects one winner and one persisted fixture effect (recurring=%s)', async recurring => {
    await insertRoutine('race', recurring);
    // Each contender receives the same captured timestamp while blocked on
    // this row, so a sequential second snapshot cannot make the test pass.
    let pending: ReturnType<typeof launch>[] = [];
    try {
      await db.sql.begin(async tx => {
        await tx`SELECT id FROM harness_shared.routines WHERE id = 'race' FOR UPDATE`;
        pending = [runtimes[0], runtimes.at(-1)!].map((runtime, index) =>
          launch(runtime, 'race', `race-${index}`, { claimed: true, allowed: true }));
        await captured(2);
      });
      const receipts = await Promise.all(pending);
      // Which contender wins is deliberately unspecified; re-evaluate only
      // its expected semantic value, retaining the actual identity/exit proof.
      const winner = receipts.find(r => r.status === 'passed');
      const loser = receipts.find(r => r.status === 'failed');
      expect(winner).toBeDefined();
      expect(loser).toBeDefined();
      assertPassed(winner!);
      expect(loser!.reasons).toEqual(['incorrect-result']);
      expect(loser!.actual).toEqual({ claimed: false, allowed: false });
      const [effects] = await db.sql`SELECT count(*)::int AS count FROM runtime_probe.effects`;
      expect(effects.count).toBe(1);
      const [row] = await db.sql`SELECT active, next_fire_at > now() AS advanced FROM harness_shared.routines WHERE id='race'`;
      expect(row.active).toBe(recurring);
      expect(row.advanced).toBe(recurring ? true : null);
    } finally { await Promise.all(pending); }
  }, 45_000);

  it('rejects captured timestamps after a retune, with no fixture effect', async () => {
    await insertRoutine('retune');
    let pending: ReturnType<typeof launch>[] = [];
    try {
      await db.sql.begin(async tx => {
        await tx`SELECT id FROM harness_shared.routines WHERE id='retune' FOR UPDATE`;
        pending = runtimes.map((runtime, index) => launch(runtime, 'retune', `retune-${index}`,
          { claimed: false, allowed: false }));
        await captured(pending.length);
        // Still due, but not the timestamp either child captured.
        await tx`UPDATE harness_shared.routines SET next_fire_at=now()-interval '2 minutes' WHERE id='retune'`;
      });
      (await Promise.all(pending)).forEach(assertPassed);
      expect((await db.sql`SELECT attempt FROM runtime_probe.effects`).length).toBe(0);
    } finally { await Promise.all(pending); }
  }, 45_000);

  it('preserves the recurring pause fence and the claimed one-shot exception', async () => {
    for (const [index, runtime] of runtimes.entries()) {
      await insertRoutine(`paused-${index}`);
      await db.sql`UPDATE harness_shared.routines SET active=false WHERE id=${`paused-${index}`}`;
      assertPassed(await launch(runtime, `paused-${index}`, `paused-${index}`,
        { claimed: null, allowed: false }, 'dispatch'));
      await insertRoutine(`oneshot-${index}`, false);
      assertPassed(await launch(runtime, `oneshot-${index}`, `oneshot-${index}`,
        { claimed: true, allowed: true }));
      assertPassed(await launch(runtime, `oneshot-${index}`, `oneshot-dispatch-${index}`,
        { claimed: null, allowed: true }, 'dispatch'));
    }
  }, 60_000);
});
