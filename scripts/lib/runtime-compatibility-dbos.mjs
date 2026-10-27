/** Actual SDK queue/replay baseline against a caller-owned private database.
 * This intentionally does not import the production bootstrap or start its jobs.
 */
import postgres from 'postgres';

export async function perform() {
  const url = new URL(process.env.PAPERCUSP_PROBE_PG_URL ?? '');
  const nonce = process.env.PAPERCUSP_PROBE_NONCE;
  const attempt = process.env.PAPERCUSP_PROBE_ATTEMPT;
  const action = process.env.PAPERCUSP_PROBE_ACTION;
  const workflowId = process.env.PAPERCUSP_PROBE_WORKFLOW;
  const executorId = process.env.PAPERCUSP_PROBE_EXECUTOR;
  if (!/^runtime_dbos_[a-f0-9]{12}$/.test(url.pathname.slice(1)) || !nonce || !attempt || !executorId
      || !['initialize', 'run', 'recover'].includes(action) || (action !== 'initialize' && !workflowId)) {
    throw new Error('An isolated runtime_dbos database and explicit fixture identity are required');
  }
  const sql = postgres(url.href, { prepare: false, max: 2, connect_timeout: 5,
    connection: { statement_timeout: 15_000 }, onnotice: () => {} });
  let DBOS;
  let tracing;
  let registration;
  try {
    const [guard] = await sql`SELECT nonce FROM runtime_probe.guard WHERE nonce = ${nonce}`;
    if (!guard) throw new Error('Runtime DBOS fixture identity mismatch');
    // Match host-bootstrap's provider-before-DBOS ordering. Reuse its actual
    // maintained provider without configuring the network exporter or host jobs.
    const source = new URL('../../packages/operator-core/lib/observability/tracing.ts', import.meta.url);
    const { createTracing } = process.versions.bun ? await import(source.href)
      : await (await import('tsx/esm/api')).tsImport(source.href, import.meta.url);
    tracing = createTracing({ service: 'runtime-compatibility-dbos' });
    registration = tracing.register();
    if (!registration.registered) throw new Error('Runtime DBOS fixture provider was not registered');
    const sdk = await import('@dbos-inc/dbos-sdk');
    DBOS = sdk.DBOS;
    DBOS.setConfig({ name: 'runtime-compatibility-dbos', systemDatabaseUrl: url.href,
      systemDatabaseSchemaName: 'dbos', applicationVersion: 'runtime-source-v1',
      executorID: executorId, runAdminServer: false, tracingEnabled: true, logLevel: 'warn' });
    new sdk.WorkflowQueue('runtime-probe', { concurrency: 1 });
    const workflow = DBOS.registerWorkflow(async (id) => {
      await DBOS.runStep(async () => {
        await sql`INSERT INTO runtime_probe.effects (workflow_id, phase, attempt)
          VALUES (${id}, 'before', ${attempt})`;
      }, { name: 'first-effect' });
      // Killing here tests replay of an already checkpointed earlier effect.
      // No claim is made about a crash between an external effect and its receipt.
      await DBOS.runStep(async () => {
        await sql`INSERT INTO runtime_probe.checkpoints (workflow_id, attempt, pid)
          VALUES (${id}, ${attempt}, ${process.pid})`;
        const deadline = Date.now() + 45_000;
        while (Date.now() < deadline) {
          const [gate] = await sql`SELECT released FROM runtime_probe.gates WHERE workflow_id = ${id}`;
          if (gate?.released) return;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error('Runtime DBOS fixture gate did not open');
      }, { name: 'fixture-gate', retriesAllowed: false });
      return DBOS.runStep(async () => {
        await sql`INSERT INTO runtime_probe.effects (workflow_id, phase, attempt)
          VALUES (${id}, 'after', ${attempt})`;
        return { value: 42 };
      }, { name: 'last-effect' });
    }, { name: 'runtimeCompatibilityDelivery' });
    await DBOS.launch();
    if (action === 'initialize') return { initialized: true };
    if (action === 'run') {
      await sql`INSERT INTO runtime_probe.ready (workflow_id, attempt) VALUES (${workflowId}, ${attempt})`;
      const peers = Number(process.env.PAPERCUSP_PROBE_PEERS ?? '1');
      const deadline = Date.now() + 20_000;
      while (true) {
        const rows = await sql`SELECT attempt FROM runtime_probe.ready WHERE workflow_id = ${workflowId}`;
        if (rows.length >= peers) break;
        if (Date.now() >= deadline) throw new Error('DBOS peer readiness barrier did not fill');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    const handle = action === 'recover' ? DBOS.retrieveWorkflow(workflowId)
      : await DBOS.startWorkflow(workflow, { workflowID: workflowId, queueName: 'runtime-probe' })(workflowId);
    return { result: await handle.getResult() };
  } finally {
    try { await DBOS?.shutdown(); } finally {
      registration?.disable();
      try { await tracing?.shutdown(); } finally { await sql.end({ timeout: 2 }); }
    }
  }
}
