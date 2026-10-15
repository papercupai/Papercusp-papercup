/**
 * provision-workflow.integration.test.ts — plan dbos-durable-flows-adoption
 * P-001 / P-009: the provision workflow's exactly-once + dedup-mutex guarantees,
 * proven against a REAL DBOS runtime (the property that REPLACES the hand-rolled
 * operator-claims advisory lock can only be shown with a live DBOS instance).
 *
 * `startProvisionWorkflow` enqueues with `deduplicationID =
 * provision:<ws>:<harness>:<plugin>:<phase>` (the per-target mutex) and a
 * per-request `workflowID`. While one provision of a target is in-flight, a
 * concurrent second is the dedup loser (`DBOSQueueDuplicatedError`, code 28) →
 * mapped to a claim-conflict result. Once the first completes, the dedup slot
 * frees, so a SEQUENTIAL re-provision runs again — exactly the operator-claims
 * semantics (block true concurrency, allow sequential).
 *
 * Boots DBOS on a throwaway DB on the shared testcontainer (mirrors
 * orchestrator-dedup.integration.test.ts) and injects a counting stub executor —
 * so the dedup/queue mechanics are proven WITHOUT spawning provision sandboxes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, teardownTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import type { DBOS as DBOSType } from '@dbos-inc/dbos-sdk';
import type { ProvisionPhase, ProvisionRunInputs, ProvisionRunResult } from '../provision/runner';

let DBOS: typeof DBOSType;
let startProvisionWorkflow: typeof import('./provision-workflow').startProvisionWorkflow;
let setProvisionExecutor: typeof import('./provision-workflow').setProvisionExecutor;
let adminUri: string;
let dbName: string;

// plugin → number of times the (stub) executor actually ran. One provision = one.
const execCount: Record<string, number> = {};

const inputs = (plugin: string): ProvisionRunInputs =>
  ({
    harness: 'sheets',
    plugin,
    publisher: 'acme',
    pluginVersion: '1.0.0',
    pluginDir: '/x',
    config: {},
    provision: { setup: { path: 'setup.sh' } },
    consentConfirmed: true,
  }) as unknown as ProvisionRunInputs;

const nonce = () => randomBytes(6).toString('hex');

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `dbos_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;

  ({ DBOS } = await import('@dbos-inc/dbos-sdk'));
  DBOS.setConfig({
    name: 'papercusp-test',
    systemDatabaseUrl: u.toString(),
    systemDatabaseSchemaName: 'dbos',
    applicationVersion: 'test-v1',
    runAdminServer: false,
  });

  const wf = await import('./provision-workflow');
  startProvisionWorkflow = wf.startProvisionWorkflow;
  setProvisionExecutor = wf.setProvisionExecutor;
  // Stub executor: count the run, hold briefly so a concurrent second enqueue
  // observes the in-flight dedup slot, then succeed. No sandbox, no PG state.
  setProvisionExecutor(async (phase: ProvisionPhase, i: ProvisionRunInputs): Promise<ProvisionRunResult> => {
    execCount[i.plugin] = (execCount[i.plugin] ?? 0) + 1;
    await new Promise((r) => setTimeout(r, 300));
    return { ok: true, phase, decision: 'fresh', durationMs: 1, runId: 'dbos-stub' };
  });

  await DBOS.launch();
}, 90_000);

afterAll(async () => {
  try {
    await DBOS.shutdown();
  } catch {
    /* best-effort */
  }
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await admin.end({ timeout: 5 });
  }
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

beforeEach(() => {
  for (const k of Object.keys(execCount)) delete execCount[k];
});

describe('DBOS provision workflow — dedup mutex + sequential re-run (P-001)', () => {
  it('awaits the durable result on the happy path (route keeps its sync contract)', async () => {
    const r = await startProvisionWorkflow('ws-1', 'setup', inputs('happy'), nonce());
    expect(r.ok).toBe(true);
    expect(execCount['happy']).toBe(1);
  }, 30_000);

  it('two concurrent provisions of the same target → ONE runs, the other gets a claim-conflict', async () => {
    const [a, b] = await Promise.all([
      startProvisionWorkflow('ws-1', 'setup', inputs('concur'), nonce()),
      startProvisionWorkflow('ws-1', 'setup', inputs('concur'), nonce()),
    ]);
    const oks = [a, b].filter((r) => r.ok);
    const conflicts = [a, b].filter((r) => !r.ok && /claim conflict/i.test(r.error ?? ''));
    expect(oks).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    // The decisive assertion: the executor ran exactly once (the mutex held).
    expect(execCount['concur']).toBe(1);
  }, 30_000);

  it('a SEQUENTIAL re-provision (after the first completes) runs again — dedup slot freed', async () => {
    const r1 = await startProvisionWorkflow('ws-1', 'setup', inputs('seq'), nonce());
    expect(r1.ok).toBe(true);
    const r2 = await startProvisionWorkflow('ws-1', 'setup', inputs('seq'), nonce());
    expect(r2.ok).toBe(true);
    expect(execCount['seq']).toBe(2); // two sequential provisions → two runs
  }, 30_000);

  it('distinct targets do not share the mutex (different plugins run concurrently)', async () => {
    const [a, b] = await Promise.all([
      startProvisionWorkflow('ws-1', 'setup', inputs('plugA'), nonce()),
      startProvisionWorkflow('ws-1', 'setup', inputs('plugB'), nonce()),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(execCount['plugA']).toBe(1);
    expect(execCount['plugB']).toBe(1);
  }, 30_000);
});
