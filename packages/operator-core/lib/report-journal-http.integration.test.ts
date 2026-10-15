import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  recordIsolatedIntegrationProof } from '../test/isolated-integration-proof';
import { validateReportJournalRequests } from '../test/report-journal-http-scenario';

const root = resolve(import.meta.dirname, '../../..');
const options = isolatedWorkerOptions(180_000);

it('files an unpublished Reports observation through real isolated HTTP journal ingestion and preserves its controls', async context => {
  await validateReportJournalRequests();
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/report-journal-http.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/staging-first-http-fixture.ts',
      'packages/operator-core/test/report-journal-http-scenario.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/lib/agent-tools/journal/record-turn.ts',
      'packages/operator-core/lib/turn-end-tracking.ts', 'packages/operator-core/lib/turn-end-tracking-io.ts',
      'packages/operator-core/lib/turn-journal.ts', 'packages/operator-core/lib/turn-journal-store.ts',
      'packages/operator-core/lib/search/session-ingest.ts',
      'packages/operator-core/lib/agent-tools/coordination/tools/whoami.ts',
      'packages/operator-core/lib/agent-tools/coordination/identity.ts',
      'packages/operator-core/lib/agent-tools/reports/publish.ts', 'packages/operator-core/lib/report-library.ts',
      'packages/operator-core/lib/endpoint-route/routes/agent-mcp/run-tool.ts',
      'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        STAGING_FIRST_HTTP_SCENARIO: 'report-journal', STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir,
        TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts')],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      child.stdout!.on('data', chunk => {
        for (const line of String(chunk).split('\n')) if (line.startsWith('STAGING_FIRST_HTTP_PHASE ')) console.info(line);
      });
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('REPORT_JOURNAL_HTTP_RECEIPT '));
      expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('REPORT_JOURNAL_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), hostStopped: true,
        bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/), health: { service: 'papercusp-operator' },
        unpublished: { journalRows: 1, observationRows: 1 },
        deduped: true, publishedSuppressed: true, progressSuppressed: true });
      expect(receipt.requests.map((request: any) => request.name)).toEqual([
        'coord:whoami', 'journal:record-turn', 'journal:record-turn',
        'coord:whoami', 'reports:publish', 'journal:record-turn',
        'coord:whoami', 'journal:record-turn',
      ]);
      console.info('REPORT_JOURNAL_HTTP_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('REPORT_JOURNAL_HTTP_PROOF_RUN ' + runId);
}, options.testTimeoutMs);
