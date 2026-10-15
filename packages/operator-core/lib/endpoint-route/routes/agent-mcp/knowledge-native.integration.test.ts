import { fork } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdir, symlink, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type {} from '../../../../test/knowledge-native-fixture';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../../../..');
const options = isolatedWorkerOptions(480_000);

it('delivers real plan, procedure and Report excerpts through native Codex turn-start and mid-turn ports in a private operator', async context => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/endpoint-route/routes/agent-mcp/knowledge-native.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/knowledge-native-fixture.ts',
      'apps/operator/bin/hono-host.ts', 'apps/operator/scripts/hooks/inject/core.mjs',
      'apps/operator/scripts/hooks/inject/adapters/codex.mjs',
      'packages/operator-core/lib/endpoint-route/routes/agent-mcp/turn-start-memory.ts',
      'packages/operator-core/lib/endpoint-route/routes/agent-mcp/mid-turn-context.ts',
      'packages/operator-core/lib/memory/injection.ts', 'packages/operator-core/lib/memory/corpus-recall-io.ts',
      'packages/operator-core/lib/memory/corpus-recall.ts', 'packages/operator-core/lib/agent-tools/search/report-source.ts',
      'packages/operator-core/lib/agent-tools/search/knowledge-sources.ts',
      'packages/operator-core/lib/search/doc-embed-sync.ts', 'packages/operator-core/lib/search/chunks/tick.ts',
      'packages/operator-core/lib/search/chunks/registry.ts'],
    execute: async (observe, evidenceDir) => {
      await mkdir(join(evidenceDir, 'tmp'));
      // Maintained host bundles externalize native/large dependencies. Resolve
      // them from the evidence artifact's location before paying private PG boot.
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      expect(createRequire(join(evidenceDir, 'hono-host.mjs')).resolve('mingo')).toBeTruthy();
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        KNOWLEDGE_NATIVE_EVIDENCE_DIR: evidenceDir, TMPDIR: join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      // Resolve the fixture's complete native ESM import graph before starting
      // private PostgreSQL. Vitest aliases can hide a stale submodule export.
      const preflightDir = join(evidenceDir, 'import-preflight');
      await mkdir(preflightDir);
      const preflight = fork(join(root, 'packages/operator-core/test/knowledge-native-fixture.ts'),
        ['--import-preflight'], { cwd: root, detached: true, env,
          execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      const imports = await captureIsolatedWorker(preflight, preflightDir, isolatedWorkerOptions(60_000));
      expect(imports, imports.output).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      expect(imports.output).toContain('KNOWLEDGE_NATIVE_IMPORTS_OK');
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/knowledge-native-fixture.ts')],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      child.stdout!.on('data', chunk => {
        for (const line of String(chunk).split('\n')) if (line.startsWith('KNOWLEDGE_NATIVE_PHASE ')) console.info(line);
      });
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      // PG cleanup can emit more bytes than startup. Preserve errors from the
      // owned host instead of selecting only the final teardown observations.
      const failureLines = result.output.split('\n').filter(line =>
        /KNOWLEDGE_NATIVE_FAILURE |Error|AssertionError|operator-api preflight failed/.test(line));
      expect(result, failureLines.join('\n') || result.output.slice(-4_000)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('KNOWLEDGE_NATIVE_RECEIPT '));
      expect(line, result.output.slice(-8_000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('KNOWLEDGE_NATIVE_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
        turnStart: true, midTurn: true, nativeClient: 'codex', hostStopped: true,
        corpusReceiptIds: [expect.any(Number), expect.any(Number)],
        stalledReceiptIds: [expect.any(Number), expect.any(Number)],
        stalledSource: 'plan', healthySourcesRetained: ['doc', 'report'],
        bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/), requests: expect.any(Array) });
      expect(receipt.requests.map((r: { status: number }) => r.status)).toEqual([200, 200, 200, 200]);
      expect(receipt.knowledge).toEqual([
        { planSlug: 'native-zephyrquartz-plan', docSlug: 'native-zephyrquartz-procedure' },
        { planSlug: 'native-cobaltquartz-plan', docSlug: 'native-cobaltquartz-procedure' },
        { planSlug: 'native-amberquartz-plan', docSlug: 'native-amberquartz-procedure' },
        { planSlug: 'native-jadequartz-plan', docSlug: 'native-jadequartz-procedure' },
      ]);
      console.info('KNOWLEDGE_NATIVE_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, options.testTimeoutMs);
