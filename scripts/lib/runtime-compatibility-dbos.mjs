/** Actual SDK queue/replay baseline against a caller-owned private database.
 * This intentionally does not import the production bootstrap or start its jobs.
 */
import postgres from 'postgres';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export async function perform() {
  const url = new URL(process.env.PAPERCUSP_PROBE_PG_URL ?? '');
  const nonce = process.env.PAPERCUSP_PROBE_NONCE;
  const attempt = process.env.PAPERCUSP_PROBE_ATTEMPT;
  const action = process.env.PAPERCUSP_PROBE_ACTION;
  const workflowId = process.env.PAPERCUSP_PROBE_WORKFLOW;
  const executorId = process.env.PAPERCUSP_PROBE_EXECUTOR;
  if (!/^runtime_dbos_[a-f0-9]{12}$/.test(url.pathname.slice(1)) || !nonce || !attempt || !executorId
      || !['initialize', 'run', 'recover', 'baseline'].includes(action) || (action !== 'initialize' && !workflowId)) {
    throw new Error('An isolated runtime_dbos database and explicit fixture identity are required');
  }
  const sql = postgres(url.href, { prepare: false, max: 2, connect_timeout: 5,
    connection: { statement_timeout: 15_000 }, onnotice: () => {} });
  let DBOS;
  let tracing;
  let registration;
  let server;
  try {
    const [guard] = await sql`SELECT nonce FROM runtime_probe.guard WHERE nonce = ${nonce}`;
    if (!guard) throw new Error('Runtime DBOS fixture identity mismatch');
    // Match host-bootstrap's provider-before-DBOS ordering. Reuse its actual
    // maintained provider without configuring the network exporter or host jobs.
    const source = new URL('../../packages/operator-core/lib/observability/tracing.ts', import.meta.url);
    const { createTracing } = process.versions.bun ? await import(source.href)
      : await (await import('tsx/esm/api')).tsImport(source.href, import.meta.url);
    const observedSpans = [];
    tracing = createTracing({ service: 'runtime-compatibility-dbos', ...(action === 'baseline' ? {
      processor: {
        onStart() {},
        onEnd(span) {
          observedSpans.push({ name: span.name, traceId: span.spanContext().traceId,
            spanId: span.spanContext().spanId, parentSpanId: span.parentSpanContext?.spanId ?? null,
            attributes: { ...span.attributes } });
        },
        async forceFlush() {}, async shutdown() {},
      },
    } : {}) });
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
    let baseline;
    if (action === 'baseline') {
      const round = Number(process.env.PAPERCUSP_PROBE_BASELINE_ROUND);
      const receiptPath = process.env.PAPERCUSP_PROBE_BASELINE_RECEIPT;
      if (!Number.isInteger(round) || round < 0 || round >= 5 || !receiptPath || !isAbsolute(receiptPath)) {
        throw new Error('A frozen baseline round and absolute private evidence path are required');
      }
      let requests = 0;
      server = createServer((_request, response) => {
        requests++;
        response.setHeader('content-type', 'application/json');
        response.end('{"value":42}');
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const endpoint = `http://127.0.0.1:${server.address().port}`;
      const samples = [];
      const startedAt = new Date().toISOString();
      const loaded = Object.fromEntries([
        new URL(import.meta.url), source,
        new URL('../../node_modules/@dbos-inc/dbos-sdk/dist/src/dbos-executor.js', import.meta.url),
      ].map(path => [path.pathname, createHash('sha256').update(readFileSync(path)).digest('hex')]));
      baseline = DBOS.registerWorkflow(async () => {
        const sample = async (condition, warmup, index) => {
          const callId = `baseline-${round}-${warmup ? 'warmup' : 'sample'}-${condition}-${index}`;
          let workMs = 0;
          const work = async () => {
            const begin = performance.now();
            try {
              return await DBOS.runStep(async () => {
                const response = await fetch(endpoint);
                if (!response.ok || (await response.json()).value !== 42) throw new Error('fake_provider_result');
                return 42;
              }, { name: callId, retriesAllowed: false });
            } finally { workMs = performance.now() - begin; }
          };
          const begin = performance.now();
          const correlation = condition === 'on' ? tracing.begin(callId, 'vault.baseline', {
            'papercusp.call_id': callId, prompt: 'vault-private-payload-' + nonce,
          }) : undefined;
          let failure = null;
          try {
            const value = condition === 'on' ? await tracing.run(callId, work) : await work();
            if (value !== 42) throw new Error('baseline_result');
          } catch (error) { failure = error instanceof Error ? error.name : 'unknown'; }
          finally { if (condition === 'on') tracing.finish(callId, failure ? 'error' : 'ok'); }
          const journeyMs = performance.now() - begin;
          samples.push({ round, index, condition, warmup, journeyMs, workMs,
            hostMs: journeyMs - workMs, failure,
            correlation: correlation ? { traceId: correlation.traceId, spanId: correlation.spanId } : null });
        };
        // Fixed before observing timings: 100 warmups per process, then 200
        // samples per condition. Alternate the paired block order across rounds.
        for (let index = 0; index < 100; index++) await sample(index % 2 ? 'on' : 'off', true, index);
        for (const condition of round % 2 ? ['on', 'off'] : ['off', 'on']) {
          for (let index = 0; index < 200; index++) await sample(condition, false, index);
        }
        return 42;
      }, { name: 'runtimeCompatibilityBaseline' });
      await DBOS.launch();
      const handle = await DBOS.startWorkflow(baseline, { workflowID: workflowId })();
      if (await handle.getResult() !== 42) throw new Error('baseline_workflow_result');
      const flushStarted = performance.now();
      await tracing.flush();
      const flushMs = performance.now() - flushStarted;
      const [status] = await sql`SELECT status FROM dbos.workflow_status WHERE workflow_uuid=${workflowId}`;
      const on = samples.filter(sample => sample.condition === 'on');
      const correlated = on.every(sample => sample.correlation && observedSpans.some(span =>
        span.traceId === sample.correlation.traceId && span.spanId === sample.correlation.spanId)) &&
        observedSpans.some(span => span.attributes.operationUUID === workflowId ||
          span.attributes['dbos.operation.workflow_id'] === workflowId);
      writeFileSync(receiptPath, JSON.stringify({ version: 1, round, startedAt, endedAt: new Date().toISOString(),
        profile: { pid: process.pid, host: process.platform + '-' + process.arch, executable: process.execPath,
          database: url.pathname.slice(1), schema: 'dbos', queue: 'direct workflow', executorId,
          workflowId, status: status?.status, modelEndpoint: endpoint, externalExporter: false,
          configuration: 'DBOS tracing enabled in both arms; only the host operational span toggles', loaded },
        samples, observedSpans, flushMs, health: tracing.health(), requests, correlated,
        limitations: ['source SDK fixture; not the production operator bootstrap',
          'host overhead excludes the measured DBOS/provider work interval',
          'no complete source/runtime census, custody approval or shipment verdict'] }, null, 2));
      return { baselineRound: round, samples: samples.filter(sample => !sample.warmup).length,
        warmup: samples.filter(sample => sample.warmup).length, requests, correlated };
    }
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
      try { await tracing?.shutdown(); } finally {
        if (server) {
          server.closeAllConnections();
          await new Promise(resolve => server.close(resolve));
        }
        await sql.end({ timeout: 2 });
      }
    }
  }
}
