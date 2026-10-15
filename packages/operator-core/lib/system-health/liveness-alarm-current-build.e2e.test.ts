import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it, type TestContext } from 'vitest';
import {
  captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof,
} from '../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../..');
const options = isolatedWorkerOptions(480_000);

// R-12 needs a real request worker and durable ledger, independently of the unit
// alarm seam. Reuse the maintained private operator profile and lifetime proof.
async function verifyAlarm(subject: 'agents-wedged' | 'hosted-control-plane-degraded' |
  'hosted-reverse-connector-lost' | 'platform-lifecycle-budget-exceeded', context: TestContext) {
  const runId = await recordIsolatedIntegrationProof({
    root,
    filePath: 'packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts',
    sourcePaths: [
      'packages/operator-core/test/liveness-alarm-http-fixture.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'scripts/with-test-pg.mjs',
      'apps/operator/bin/hono-host.ts',
      'apps/operator/bin/bundle-host.sh',
      'packages/operator-core/lib/system-health/agent-strand-census.ts',
      'packages/operator-core/lib/system-health/liveness-alarm.ts',
      'packages/operator-core/lib/system-health/compute.ts',
      'packages/operator-core/lib/workspace-host/observability-store.ts',
      'packages/operator-core/lib/severe-event-owner.ts',
      'packages/operator-core/lib/derived-reads/shared-snapshot.ts',
      'packages/operator-core/lib/agent-tools/coordination/escalations.ts',
      'packages/operator-core/lib/build-info.ts',
    ],
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        LIVENESS_ALARM_HTTP_EVIDENCE_DIR: evidenceDir, LIVENESS_ALARM_HTTP_SUBJECT: subject,
        TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/liveness-alarm-http-fixture.ts')],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      const events: Array<Record<string, unknown>> = [];
      child.on('message', message => {
        if (message && typeof message === 'object') events.push(message as Record<string, unknown>);
      });
      child.stdout!.on('data', chunk => {
        for (const line of String(chunk).split('\n')) if (line.startsWith('LIVENESS_ALARM_HTTP_PHASE ')) console.info(line);
      });
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('LIVENESS_ALARM_HTTP_RECEIPT '));
      expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('LIVENESS_ALARM_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), hostStopped: true,
        signal: subject, threshold: subject === 'agents-wedged' ? 10 : 1,
        alarmCount: 1, restartDedupCount: 1, belowThreshold: subject === 'agents-wedged' ? 9 : 0,
        unknownPreserved: true, sourceUnchanged: true,
        bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        raised: { from: 'system:infra-liveness-alarm', livenessSignature: subject },
        recovered: { choice: 'auto-resolved', note: expect.stringContaining(subject === 'agents-wedged'
          ? 'wedged=9' : subject === 'hosted-control-plane-degraded'
            ? 'freshly unhealthy hosts 0' : 'heartbeat lost 0, platform budget breaches 0') },
      });
      if (subject === 'agents-wedged') expect(receipt.raised.agentStrandObservation)
        .toMatchObject({ wedged: 10, thresholds: { wedged: 10 } });
      else if (subject === 'hosted-control-plane-degraded') expect(receipt.raised.hostedControlPlaneObservation)
        .toMatchObject({ responder: { ownerSelector: '@role:mug' }, reading: { hosts: { unhealthy: 1 } } });
      else {
        expect(receipt.raised.hostedControlPlaneObservation.responder).toMatchObject({ ownerSelector: '@role:mug' });
        const reading = receipt.raised.hostedControlPlaneObservation.reading;
        expect(subject === 'hosted-reverse-connector-lost' ? reading.reverseConnectors.lost
          : reading.ownedCost.breachedBudgets).toBe(1);
        expect(reading.hosts.unhealthy).toBe(0);
      }
      expect(receipt.recovered.note).not.toContain('no per-signature evidence');
      const start = events.find(event => event.kind === 'isolated-runtime-start');
      const end = events.find(event => event.kind === 'isolated-runtime-end');
      expect(start).toMatchObject({ root, workspace: receipt.workspace });
      expect(start!.pgPort).not.toBe(5432);
      expect(end).toMatchObject({ exitCode: 0, signal: null, runtimeRemoved: true, pgDataRemoved: true });
      expect(existsSync(String(start!.runtimeRoot))).toBe(false);
      expect(existsSync(String(start!.dataDir))).toBe(false);
      console.info('LIVENESS_ALARM_HTTP_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('LIVENESS_ALARM_HTTP_PROOF_RUN ' + runId);
}

it('keeps a request-worker wedged alarm standing across restart and resolves only a measured recovery',
  context => verifyAlarm('agents-wedged', context), options.testTimeoutMs);
it('keeps one accountable hosted reliability alarm across restart and unknown evidence, then resolves witnessed recovery',
  context => verifyAlarm('hosted-control-plane-degraded', context), options.testTimeoutMs);
it('delivers one connector-loss alarm and resolves reconnection across restart and unknown evidence',
  context => verifyAlarm('hosted-reverse-connector-lost', context), options.testTimeoutMs);
it('delivers one Papercusp-owned spend alarm and resolves a measured budget recovery',
  context => verifyAlarm('platform-lifecycle-budget-exceeded', context), options.testTimeoutMs);
