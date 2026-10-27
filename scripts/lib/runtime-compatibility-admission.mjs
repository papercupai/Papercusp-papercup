/** Actual admission-ledger operations against an explicitly identified test DB.
 * This is a source baseline, not global background-owner or candidate proof.
 */
import postgres from 'postgres';

export async function perform() {
  const url = new URL(process.env.PAPERCUSP_PROBE_PG_URL ?? '');
  const nonce = process.env.PAPERCUSP_PROBE_NONCE;
  const attempt = process.env.PAPERCUSP_PROBE_ATTEMPT;
  const action = process.env.PAPERCUSP_PROBE_ACTION;
  const nowMs = Number(process.env.PAPERCUSP_PROBE_NOW);
  if (!/^runtime_admission_[a-f0-9]{12}$/.test(url.pathname.slice(1))
      || !nonce || !attempt || !Number.isFinite(nowMs)
      || !['enqueue', 'lease', 'hold', 'stale', 'complete', 'gateway'].includes(action)) {
    throw new Error('An isolated runtime_admission database and explicit fixture identity are required');
  }
  const sql = postgres(url.href, { prepare: false, max: 2, connect_timeout: 5,
    connection: { statement_timeout: 15_000 }, onnotice: () => {} });
  try {
    const [guard] = await sql`SELECT nonce FROM runtime_probe.guard WHERE nonce=${nonce}`;
    if (!guard) throw new Error('Runtime admission fixture identity mismatch');
    const load = async path => {
      const source = new URL('../../packages/operator-core/lib/resource-governor/' + path, import.meta.url);
      return process.versions.bun ? import(source.href)
        : (await import('tsx/esm/api')).tsImport(source.href, import.meta.url);
    };
    const [{ PgAdmissionLedgerQueueStore }, { WorkItemAdmissionQueueDriver }, { Governor }] =
      await Promise.all([load('admission-ledger-store.ts'), load('queue.ts'), load('admission.ts')]);
    const store = new PgAdmissionLedgerQueueStore({ sql, workspaceId: 'runtime-admission',
      // Expiry, rather than the ambient session registry, drives recovery here.
      resolveSessionStatesFn: async subjects => new Map(subjects.map(({ ownerId }) =>
        [ownerId, { sessionState: 'live' }])) });
    const driver = new WorkItemAdmissionQueueDriver(store, {
      namespace: 'runtime-admission', now: () => nowMs, leaseIdFactory: () => attempt,
    });
    await sql`INSERT INTO runtime_probe.attempts (attempt, pid) VALUES (${attempt}, ${process.pid})`;
    if (action === 'gateway') {
      const role = process.env.PAPERCUSP_PROBE_ROLE;
      if (!['winner', 'loser'].includes(role)) throw new Error('An explicit gateway barrier role is required');
      const waitFor = async (phase, count) => {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const rows = await sql`SELECT attempt FROM runtime_probe.gateway_barrier WHERE phase=${phase}`;
          if (rows.length === count) return;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw new Error(`Gateway barrier timed out: ${phase}`);
      };
      // Both facade callers must observe the queued receipt before either can
      // lease it. Then let the loser run only after the winner is running.
      const enqueue = store.enqueue.bind(store);
      store.enqueue = async (...args) => {
        const result = await enqueue(...args);
        await sql`INSERT INTO runtime_probe.gateway_barrier VALUES (${attempt}, 'enqueued')`;
        await waitFor('enqueued', 2);
        if (role === 'loser') await waitFor('running', 1);
        return result;
      };
      const { createDurableGatewayAdmissionGovernor } = await load('../inference-gateway/durable-admission.ts');
      const governor = createDurableGatewayAdmissionGovernor({ store, namespace: 'runtime-admission', owner: attempt,
        now: () => nowMs, leaseIdFactory: () => attempt });
      let outcome;
      try {
        outcome = await governor.admit({ idempotencyKey: 'same-request', admissionClass: 'inference',
          demand: { providerRequests: 1 } });
      } catch (error) {
        await sql`INSERT INTO runtime_probe.gateway_barrier VALUES (${attempt}, 'rejected')`;
        return { admitted: false, error: error.name };
      }
      if (outcome.kind !== 'admitted') throw new Error('Gateway did not return an admitted receipt');
      await sql`INSERT INTO runtime_probe.effects (attempt, pid) VALUES (${attempt}, ${process.pid})`;
      await sql`INSERT INTO runtime_probe.gateway_barrier VALUES (${attempt}, 'running')`;
      await waitFor('rejected', 1);
      const status = await governor.status('same-request');
      const released = await governor.release(outcome.context);
      return { admitted: true, stateAfterCompetitor: status.state, released: released.released };
    }
    if (action === 'enqueue') {
      const result = await new Governor(driver, { now: () => nowMs }).admit({
        idempotencyKey: 'same-request', admissionClass: 'process', demand: { cpuWeight: 1 },
      });
      return { queued: result.kind === 'queued' };
    }
    const receiptId = process.env.PAPERCUSP_PROBE_RECEIPT;
    const oldLease = process.env.PAPERCUSP_PROBE_OLD_LEASE;
    if (!receiptId) throw new Error('A target receipt is required');
    if (action === 'stale') {
      if (!oldLease) throw new Error('A stale lease token is required');
      return {
        running: (await driver.markRunning(receiptId, oldLease))?.changed ?? false,
        completed: (await driver.complete(receiptId, oldLease, 'stale-result'))?.changed ?? false,
      };
    }
    if (action === 'complete') {
      if (!oldLease) throw new Error('The current lease token is required');
      return { completed: (await driver.complete(receiptId, oldLease, 'runtime-result'))?.changed ?? false };
    }
    const claim = await driver.leaseReceipt({ receiptId, owner: attempt, ttlMs: 1_000 });
    const running = claim
      ? (await driver.markRunning(receiptId, claim.lease.leaseId))?.changed === true : false;
    if (running) await sql`INSERT INTO runtime_probe.effects (attempt, pid) VALUES (${attempt}, ${process.pid})`;
    // The parent kills this exact detached child only after observing its
    // persisted running lease/effect. No completion receipt can precede death.
    if (action === 'hold' && running) await new Promise(() => setInterval(() => {}, 1_000));
    return { leased: Boolean(claim), running };
  } finally { await sql.end({ timeout: 2 }); }
}
