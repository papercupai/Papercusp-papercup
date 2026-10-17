/** P024 HTTP/daemon proof with synthetic vendor responses; never vendor live acceptance. */
import { fork } from 'node:child_process';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../../..');
const FIXTURE = 'packages/operator-core/test/blog-post-http-fixture.ts';
const options = isolatedWorkerOptions(600_000);

it.runIf(process.env.PAPERCUSP_TEST_BLOG_POST_HTTP === '1')(
  'stores blog credentials through Settings and drafts through the actual HTTP tool and installed daemons', async context => {
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/providers/blog/blog-post-live.e2e.test.ts',
      retainedArtifacts: ['phases/execute/vendor-requests.jsonl'],
      sourcePaths: ['scripts/with-test-pg.mjs', FIXTURE, 'packages/operator-core/test/isolated-integration-proof.ts',
        'packages/operator-core/test/blog-post-http-host.mjs',
        'packages/operator-core/test/private-http-workspace-preflight.ts',
        ...['devto', 'hashnode'].flatMap(id => ['papercusp.json', 'index.cjs', 'daemon.cjs'].map(file => `libs/papercusp/plugins/${id}/${file}`)),
        'packages/operator-core/lib/agent-tools/blog/post.ts', 'packages/operator-core/lib/capability-verbs/blog.ts',
        'packages/operator-core/lib/capability-verbs/provider-dispatch.ts',
        'packages/operator-core/lib/integrations/host-fetch.ts', 'packages/operator-core/lib/integrations/source-host-fetch.ts',
        'packages/operator-core/lib/integrations/provider-credentials.ts',
        'packages/operator-core/lib/endpoint-route/routes/user/provider-credentials.ts',
        'packages/operator-core/lib/endpoint-route/routes/agent-mcp/run-tool.ts',
        'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh', 'apps/operator/bin/hono-host.ts'],
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        await mkdir(join(evidenceDir, 'tmp'));
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0', BLOG_POST_EVIDENCE_DIR: evidenceDir,
          TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
        delete env.PC_HEAVY_PREEMPT_READY_FILE;
        delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
          process.execPath, '--import', 'tsx', join(root, FIXTURE)],
          { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        child.stdout!.on('data', chunk => {
          for (const line of String(chunk).split('\n')) if (line.startsWith('BLOG_POST_PHASE ')) console.info(line);
        });
        let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
        try { result = await captureIsolatedWorker(child, evidenceDir, options); }
        finally { await rm(join(evidenceDir, 'node_modules')); }
        expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
          timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
        const line = result.output.split('\n').find(row => row.startsWith('BLOG_POST_RECEIPT '));
        expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
        const receipt = JSON.parse(line!.slice('BLOG_POST_RECEIPT '.length));
        expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), hostStopped: true,
          bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/), health: { service: 'papercusp-operator' },
          vendorTransport: 'synthetic', drafts: 2, withheld: 2, refused: 5 });
        expect(receipt.vendorRequests).toHaveLength(2);
        expect(receipt.vendorRequests.map((row: any) => row.provider).sort()).toEqual(['devto', 'hashnode']);
        expect(Object.keys(receipt.installedFiles)).toHaveLength(6);
        console.info('BLOG_POST_HTTP_VERIFIED ' + JSON.stringify({ vendorTransport: receipt.vendorTransport,
          drafts: receipt.drafts, withheld: receipt.withheld, refused: receipt.refused }));
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('BLOG_POST_HTTP_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);
