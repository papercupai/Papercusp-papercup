/** Real request-worker alarm lifecycle in the maintained private operator profile. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { readProcessIdentity } from '../lib/process-identity';
import { buildPrivateOperatorApiBundle, privateBundleRuntimeEnv, waitForPrivateOperator } from './private-http-workspace-preflight';
import { writeSharedSnapshot } from '../lib/derived-reads/shared-snapshot';
import { createPrivateHealthSnapshot } from './private-http-workspace-preflight';
import type { AgentStrandHealth } from '../lib/system-health/agent-strand-census';
import type { CoordinationHealth, InfraHealth } from '../lib/system-health/types';

let host: ChildProcess | undefined;
let hostIdentity: ReturnType<typeof readProcessIdentity>;
async function stopHost() {
  if (!host) return;
  if (host.exitCode === null && host.signalCode === null) {
    const closed = new Promise<void>(done => host!.once('close', () => done()));
    host.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([closed, new Promise<void>(done => { timer = setTimeout(done, 5_000); })]);
    clearTimeout(timer);
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
    await closed;
  }
  assert.notEqual(readProcessIdentity(host.pid!), hostIdentity, 'private alarm host survived cleanup');
}

async function main() {
  const e = process.env;
  const requested = e.LIVENESS_ALARM_HTTP_SUBJECT;
  const signal = ['hosted-control-plane-degraded', 'hosted-reverse-connector-lost',
    'platform-lifecycle-budget-exceeded'].includes(requested ?? '') ? requested! : 'agents-wedged';
  const hostedSubject = signal !== 'agents-wedged';
  const threshold = hostedSubject ? 1 : 10;
  const workspace = e.PAPERCUSP_WORKSPACE_ID!;
  const base = e.PAPERCUSP_OPERATOR_URL!;
  assert.match(workspace, /^test-runtime-/);
  assert.equal(e.PAPERCUSP_POT_HOME_SLUG, workspace);
  assert.equal(e.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(e.PAPERCUSP_DBOS_ENABLE, '0');
  assert.equal(e.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
  assert.notEqual(e.PAPERCUSP_PG_PORT, '5432');
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(![3070, 3170, 3271].includes(Number(new URL(base).port)));
  const root = resolve(import.meta.dirname, '../../..');
  const evidenceDir = e.LIVENESS_ALARM_HTTP_EVIDENCE_DIR!;
  assert.ok(evidenceDir, 'retained evidence directory required');
  const sources = ['packages/operator-core/lib/system-health/liveness-alarm.ts',
    'packages/operator-core/lib/system-health/agent-strand-census.ts',
    'packages/operator-core/lib/system-health/compute.ts',
    'packages/operator-core/lib/derived-reads/shared-snapshot.ts',
    'packages/operator-core/lib/agent-tools/coordination/escalations.ts',
    'packages/operator-core/lib/workspace-host/observability-store.ts',
    'packages/operator-core/lib/severe-event-owner.ts',
    'apps/operator/bin/hono-host.ts'];
  const fingerprint = () => Object.fromEntries(sources.map(path => [path,
    createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
  const sourceBefore = fingerprint();
  console.log('LIVENESS_ALARM_HTTP_PHASE bundle-start');
  // The outer execution budget is 480s. Reserve 60s for startup and assertions;
  // only distinct successful build steps can extend the original 240s checkpoint.
  const { path: bundle } = await buildPrivateOperatorApiBundle(root, evidenceDir, { timeoutMs: 240_000, maxMs: 420_000 });
  const bytes = readFileSync(bundle);
  assert.ok(bytes.includes(Buffer.from('system-health/liveness-alarm.ts')), 'alarm missing from executed artifact');
  assert.ok(bytes.includes(Buffer.from('agentStrandObservation')), 'runtime observation missing from executed artifact');
  if (hostedSubject) assert.ok(bytes.includes(Buffer.from('hostedControlPlaneObservation')), 'hosted observation missing from executed artifact');
  assert.deepEqual(fingerprint(), sourceBefore, 'source moved while building the tested artifact');
  const bundleSha256 = createHash('sha256').update(bytes).digest('hex');
  const headers = { origin: base, 'x-papercusp-workspace': workspace };
  // Only the existing interval knob changes: dedup and production dependencies
  // remain default. The supervisor owns a private DB, HOME, workspace and ports.
  const intervalMs = 500;
  async function startHost() {
    const hostEnv = privateBundleRuntimeEnv({ ...e,
      TELEMETRY_ENABLED: '0', PAPERCUSP_CLOUD_MONITORING_ENVIRONMENT: 'test',
      PAPERCUSP_INFRA_LIVENESS_ALARM: '1', PAPERCUSP_INFRA_LIVENESS_ALARM_MS: String(intervalMs) });
    host = spawn(process.execPath, [bundle], { cwd: root,
      env: hostEnv,
      stdio: ['ignore', 'pipe', 'pipe'] });
    host.stdout!.on('data', chunk => process.stdout.write(chunk));
    host.stderr!.on('data', chunk => process.stderr.write(chunk));
    hostIdentity = readProcessIdentity(host.pid!);
    assert.ok(hostIdentity, 'private host kernel identity required');
    const health = await waitForPrivateOperator({ host, base, headers, evidenceDir, hostIdentity, environment: hostEnv });
    assert.ok(health.sha, 'loaded bundle identity is required');
    return { pid: host.pid!, identity: hostIdentity, health };
  }
  const { sql } = getOrgPg();
  async function snapshot(wedged: number | null) {
    const at = Date.now();
    const health = createPrivateHealthSnapshot(workspace, false, at);
    const strand: AgentStrandHealth = { checked: wedged ?? 0, wedged: wedged ?? 0,
      wedgedByClass: { 'auth-blocked': 0, 'quota-blocked': wedged ?? 0, 'unbound-successor': 0, 'pending-turn-stuck': 0 },
      wedgedSample: [], stranded: 0, strandedSample: [], wedgedUnreadable: wedged === null, strandedUnreadable: false };
    health.panels.coordination.status = 'warn';
    health.panels.coordination.data = { agentStrand: strand } as CoordinationHealth;
    if (hostedSubject) {
      health.panels.coordination.status = 'unknown';
      health.panels.coordination.data = null;
      health.panels.infra.status = wedged === null ? 'unknown' : wedged > 0 ? 'crit' : 'ok';
      health.panels.infra.data = {
        hostedControlPlane: wedged === null ? null : {
          observedAt: at, windowMs: 3_600_000, lifecycle: null, api: null,
          hosts: { expectedRunning: 1, unhealthy: wedged, unobserved: 0, platformOwnedRunning: 1 },
          providerConnections: { connected: 1, degraded: 0 },
          reverseConnectors: { active: 1, lost: signal === 'hosted-reverse-connector-lost' ? wedged : 0 },
          ownedCost: { estimatedUsdCents: 2400, estimates: 1, unpriced: 0,
            breachedBudgets: signal === 'platform-lifecycle-budget-exceeded' ? wedged : 0 },
        },
      } as InfraHealth;
      if (wedged !== null && signal !== 'hosted-control-plane-degraded') {
        (health.panels.infra.data as InfraHealth).hostedControlPlane!.hosts!.unhealthy = 0;
      }
    }
    await writeSharedSnapshot('system.health', workspace, health, 1);
    return at;
  }
  const raises = async () => (await sql`SELECT body FROM harness_shared.coord_event_log
    WHERE workspace_id = ${workspace} AND surface = 'escalations'
      AND body->>'from' = 'system:infra-liveness-alarm' AND body->>'livenessSignature' = ${signal}
    ORDER BY ts`).map(row => row.body);
  const resolutions = async (id: string) => (await sql`SELECT body FROM harness_shared.coord_event_log
    WHERE workspace_id = ${workspace} AND surface = 'escalations'
      AND body->>'kind' = 'escalation_resolved' AND body->>'related_msg_id' = ${id}
    ORDER BY ts`).map(row => row.body);
  async function until<T>(name: string, read: () => Promise<T>, ready: (value: T) => boolean) {
    const deadline = Date.now() + 30_000;
    let value: T;
    do {
      assert.equal(host!.exitCode, null, 'alarm worker exited during ' + name);
      value = await read();
      if (ready(value)) return value;
      await new Promise(done => setTimeout(done, intervalMs));
    } while (Date.now() < deadline);
    throw new Error(name + ' did not converge: ' + JSON.stringify(value!));
  }
  async function standing(id: string) {
    const rows = await sql`SELECT body FROM harness_shared.coord_open_escalations
      WHERE workspace_id = ${workspace} AND body->>'msg_id' = ${id}`;
    assert.equal(rows.length, 1, 'threshold alarm must remain durably open');
    assert.equal((await resolutions(id)).length, 0, 'absence of evidence cannot resolve a standing alarm');
    assert.equal((await raises()).length, 1, 'one threshold episode must have one alarm');
  }
  const thresholdAt = await snapshot(threshold);
  const first = await startHost();
  console.log('LIVENESS_ALARM_HTTP_PHASE threshold-worker-ready');
  const raised = (await until('threshold alarm', raises, rows => rows.length === 1))[0];
  assert.ok(raised.body.includes('Signal: ' + signal));
  const observation = hostedSubject ? raised.hostedControlPlaneObservation : raised.agentStrandObservation;
  assert.equal(observation.snapshotAtMs, thresholdAt);
  assert.equal(observation.runtime.pid, first.pid);
  assert.equal(observation.runtime.sha, first.health.sha);
  if (hostedSubject) {
    if (signal === 'hosted-control-plane-degraded') assert.equal(observation.reading.hosts.unhealthy, 1);
    if (signal === 'hosted-reverse-connector-lost') assert.equal(observation.reading.reverseConnectors.lost, 1);
    if (signal === 'platform-lifecycle-budget-exceeded') assert.equal(observation.reading.ownedCost.breachedBudgets, 1);
    assert.equal(observation.responder.ownerSelector, '@role:mug');
    assert.equal(raised.needsHumanRoute, false);
    // The specific alarm owns this fault; the Infra panel must not double-page it.
    const duplicates = await sql`SELECT body FROM harness_shared.coord_event_log
      WHERE workspace_id = ${workspace} AND surface = 'escalations'
        AND body->>'from' = 'system:infra-liveness-alarm' AND body->>'livenessSignature' = 'panel:infra'`;
    assert.equal(duplicates.length, 0);
  } else {
    assert.equal(observation.wedged, 10);
    assert.equal(observation.thresholds.wedged, 10);
  }
  await new Promise(done => setTimeout(done, intervalMs * 4));
  await standing(raised.msg_id);
  await stopHost();
  const second = await startHost();
  assert.notEqual(second.identity, first.identity, 'restart must exercise a new worker lifetime');
  await new Promise(done => setTimeout(done, intervalMs * 4));
  await standing(raised.msg_id);
  console.log('LIVENESS_ALARM_HTTP_PHASE restart-dedup-verified');
  await snapshot(null);
  await new Promise(done => setTimeout(done, intervalMs * 4));
  await standing(raised.msg_id);
  await snapshot(threshold - 1);
  const recovered = (await until('measured below-threshold recovery', () => resolutions(raised.msg_id), rows => rows.length === 1))[0];
  assert.equal(recovered.choice, 'auto-resolved');
  if (signal === 'hosted-control-plane-degraded') {
    assert.match(recovered.note, /freshly unhealthy hosts 0/);
    assert.match(recovered.note, /degraded provider connections 0/);
  } else if (signal === 'agents-wedged') {
    assert.match(recovered.note, /wedged=9/);
    assert.match(recovered.note, /alarm threshold >= 10/);
  } else {
    assert.match(recovered.note, /heartbeat lost 0, platform budget breaches 0/);
  }
  assert.doesNotMatch(recovered.note, /no per-signature evidence/);
  assert.equal((await raises()).length, 1);
  assert.deepEqual(fingerprint(), sourceBefore, 'source changed during the live journey');
  await stopHost();
  console.log('LIVENESS_ALARM_HTTP_RECEIPT ' + JSON.stringify({ workspace, hostStopped: true,
    signal, threshold, belowThreshold: threshold - 1, alarmCount: 1, restartDedupCount: 1,
    unknownPreserved: true, sourceUnchanged: true, sourceFingerprints: sourceBefore,
    bundleSha256, intervalMs, first, second, raised, recovered }));
}

try { await main(); }
catch (error) {
  const assertion = error as { message?: string; stack?: string; actual?: unknown; expected?: unknown };
  console.error('LIVENESS_ALARM_HTTP_FAILURE ' + JSON.stringify({ message: assertion.message ?? String(error),
    stack: assertion.stack, actual: assertion.actual, expected: assertion.expected }));
  process.exitCode = 1;
} finally {
  await stopHost();
  await getOrgPg().sql.end({ timeout: 1 });
}
