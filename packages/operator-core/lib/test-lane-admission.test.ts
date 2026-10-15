import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  REUSE_SKIP_LIST_SCHEMA,
  executedSourceRunContext,
  executedSourceRunnerIdentity,
} from '@papercusp/test-config/test-pass-reuse-skip';
import { describe, expect, it } from 'vitest';

import {
  buildPureLaneShardArgs,
  remainingPureLaneFiles,
  resolvePureLaneShardCount,
  runPureLaneShards,
  runVitestProcess,
} from '../../../scripts/run-vitest-pure-lane.mjs';

const REPO_ROOT = resolve(__dirname, '../../..');
const PACKAGE_JSON = resolve(REPO_ROOT, 'packages/operator-core/package.json');
const PC_HEAVY = resolve(REPO_ROOT, 'scripts/pc-heavy.sh');

type PackageManifest = {
  scripts?: Record<string, string>;
};

const scripts = (JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as PackageManifest).scripts ?? {};

const laneFiles = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `lib/pure-${String(i).padStart(5, '0')}.test.ts`);

/** A schema-valid skip list on disk, stamped for THIS process the way affected-tests stamps it. */
function writeSkipList(files: string[], overrides: Partial<{ runContext: string; runnerIdentity: string }> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pure-lane-reuse-'));
  const path = join(dir, 'skip.json');
  writeFileSync(
    path,
    JSON.stringify({
      schema: REUSE_SKIP_LIST_SCHEMA,
      files,
      runContext: overrides.runContext ?? executedSourceRunContext({}),
      runnerIdentity: overrides.runnerIdentity ?? executedSourceRunnerIdentity(),
      judgedSha: 'a'.repeat(40),
    }),
  );
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function shardArgsFor(options: Parameters<typeof runPureLaneShards>[0]) {
  const calls: string[][] = [];
  const lines: string[] = [];
  const code = await runPureLaneShards({
    forwardedArgs: [],
    stderr: { write: (chunk) => { lines.push(String(chunk)); return true; } },
    run: async (args) => { calls.push(args); return 0; },
    ...options,
  });
  return { code, calls, lines };
}

describe('operator-core test-lane admission', () => {
  it.each([
    ['test:lane-pure', 'PC_TEST_LANE=pure ../../scripts/pc-heavy.sh -- node ../../scripts/run-vitest-pure-lane.mjs'],
    ['test:lane-stateful', 'PC_TEST_LANE=stateful ../../scripts/pc-heavy.sh -- vitest run --passWithNoTests'],
  ])('%s routes the full lane through pc-heavy', (scriptName, expected) => {
    const command = scripts[scriptName];

    expect(command, `${scriptName} must remain declared`).toBeTruthy();
    expect(command).toBe(expected);
  });

  it('keeps the shared wrapper executable from the workspace package directory', () => {
    expect(existsSync(PC_HEAVY)).toBe(true);
    expect(statSync(PC_HEAVY).mode & 0o111).not.toBe(0);
  });

  it('bounds each Vitest coordinator by file census independently of its worker cap', () => {
    expect(resolvePureLaneShardCount({ VITEST_MAX_WORKERS: '2' }, 3606)).toBe(5);
    expect(resolvePureLaneShardCount({ VITEST_MAX_FORKS: '1' }, 3606)).toBe(5);
    expect(resolvePureLaneShardCount({ VITEST_MAX_WORKERS: '8' }, 3606)).toBe(5);
    expect(resolvePureLaneShardCount({}, 3606)).toBe(5);
    expect(resolvePureLaneShardCount({ VITEST_MAX_WORKERS: '2' }, 7200)).toBe(10);
  });

  it('preserves caller flags while owning the final Vitest shard selector', () => {
    expect(buildPureLaneShardArgs(1, 2, ['--no-passWithNoTests', '--reporter=default'])).toEqual([
      'run',
      '--passWithNoTests',
      '--no-passWithNoTests',
      '--reporter=default',
      '--shard=1/2',
    ]);
    expect(() => buildPureLaneShardArgs(1, 2, ['--shard=2/2'])).toThrow(/owns Vitest sharding/);
  });

  it('runs shards sequentially, drains all of them, and preserves the first failure', async () => {
    const calls: string[][] = [];
    let active = 0;
    let maxActive = 0;
    const code = await runPureLaneShards({
      env: { VITEST_MAX_WORKERS: '3' },
      forwardedArgs: ['--no-passWithNoTests'],
      pureFiles: laneFiles(3606),
      reuseSkipFiles: [],
      stderr: { write: () => true },
      run: async (args) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        calls.push(args);
        await Promise.resolve();
        active -= 1;
        return calls.length === 1 ? 134 : 0;
      },
    });

    expect(maxActive).toBe(1);
    expect(calls.map((args) => args.at(-1))).toEqual([
      '--shard=1/5', '--shard=2/5', '--shard=3/5', '--shard=4/5', '--shard=5/5',
    ]);
    expect(code).toBe(134);
  });

  // gate-test-reuse-yield-2026-10-01 P-006 (D-005): the pure lane applies the pass-reuse skip list.
  describe('pass reuse', () => {
    it('sizes shards from the files left to run, not the whole lane', async () => {
      const files = laneFiles(3606);
      const { code, calls, lines } = await shardArgsFor({ pureFiles: files, reuseSkipFiles: files.slice(0, 3000) });
      expect(code).toBe(0);
      // 606 left: one fresh coordinator, so no --shard selector at all.
      expect(calls).toEqual([['run', '--passWithNoTests']]);
      expect(lines.join('')).toContain('pureFiles=606 reused=3000');
    });

    it('still bounds every coordinator when only part of the lane is reused', async () => {
      const files = laneFiles(3606);
      const { calls } = await shardArgsFor({ pureFiles: files, reuseSkipFiles: files.slice(0, 2000) });
      // 1,606 left / 750 per coordinator = 3 shards.
      expect(calls.map((a) => a.at(-1))).toEqual(['--shard=1/3', '--shard=2/3', '--shard=3/3']);
    });

    it('passes a fully reused lane without spawning vitest', async () => {
      const files = laneFiles(4);
      const { code, calls, lines } = await shardArgsFor({ pureFiles: files, reuseSkipFiles: [...files].reverse() });
      expect(code).toBe(0);
      expect(calls).toEqual([]);
      expect(lines.join('')).toContain('VITEST_PURE_LANE_SHARD state=all-reused pureFiles=4 reused=4 exitStatus=0');
    });

    it('runs the lane when even one file is not reused', async () => {
      const files = laneFiles(4);
      const { calls } = await shardArgsFor({ pureFiles: files, reuseSkipFiles: files.slice(1) });
      expect(calls).toHaveLength(1);
    });

    it('ignores skip-list entries that are not lane files', () => {
      expect(remainingPureLaneFiles(['lib/a.test.ts', './lib/b.test.ts'], ['lib/b.test.ts', 'lib/stateful.test.ts'])).toEqual([
        'lib/a.test.ts',
      ]);
    });

    it('reads the skip list through the same validating reader vitest-config applies', async () => {
      const files = laneFiles(1600);
      const list = writeSkipList(files.slice(0, 1000));
      try {
        const { calls } = await shardArgsFor({ env: { PC_TEST_REUSE_SKIP_LIST: list.path }, pureFiles: files });
        expect(calls).toEqual([['run', '--passWithNoTests']]);
      } finally {
        list.cleanup();
      }
    });

    it('shards the full lane when the reader declines the list (fail-open toward running more)', async () => {
      const files = laneFiles(1600);
      const list = writeSkipList(files, { runnerIdentity: 'proof-v2 v0.0.0 elsewhere none' });
      try {
        const { code, calls, lines } = await shardArgsFor({ env: { PC_TEST_REUSE_SKIP_LIST: list.path }, pureFiles: files });
        expect(code).toBe(0);
        expect(calls.map((a) => a.at(-1))).toEqual(['--shard=1/3', '--shard=2/3', '--shard=3/3']);
        expect(lines.join('')).toContain('VITEST_PURE_LANE_REUSE [test-pass-reuse] DECLINED');
      } finally {
        list.cleanup();
      }
    });
  });

  it('runs the real shard child inside the canonical governed execution lifetime', async () => {
    const child = new EventEmitter() as EventEmitter & { pid: number };
    child.pid = 4242;
    const attached: number[] = [];
    const lifecycle: string[] = [];
    const spawned: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    let governedOptions: Record<string, unknown> | null = null;
    const admittedEnv = {
      PAPERCUSP_WORKSPACE: 'workspace-test',
      PAPERCUSP_ADMISSION_CONTEXT: '{"receiptId":"receipt-1"}',
    };

    const result = runVitestProcess(['run', '--shard=1/2'], {
      env: { PAPERCUSP_WORKSPACE: 'workspace-test', VITEST_MAX_WORKERS: '2' },
      stderr: { write: (chunk) => { lifecycle.push(String(chunk)); return true; } },
      spawnProcess: ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        spawned.push({ command, args, env: options.env });
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
      }) as never,
      createSampler: (() => ({
        attach: (pid: number) => attached.push(pid),
        stop: () => ({ cpuWeight: 0.5, memoryBytes: 1024, diskBytes: 0, fileDescriptors: 4 }),
      })) as never,
      runGovernedTestProcess: (async (options: Record<string, unknown>, run: Function) => {
        governedOptions = options;
        const outcome = await run({ receiptId: 'receipt-1' }, admittedEnv, { inherited: false });
        lifecycle.push('governor-returned');
        return outcome;
      }) as never,
    });

    await expect(result).resolves.toBe(0);
    expect(governedOptions).toMatchObject({
      namespace: 'vitest-pure-lane-shard',
      payloadRef: 'test:lane-pure',
      workspaceId: 'workspace-test',
    });
    expect(governedOptions).toHaveProperty('settle');
    expect(attached).toEqual([4242]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toEqual(['run', '--shard=1/2']);
    expect(spawned[0].env.PAPERCUSP_ADMISSION_CONTEXT).toContain('receipt-1');
    expect(lifecycle).toEqual([
      'VITEST_PURE_LANE_CHILD state=closed exitStatus=0 signal=none\n',
      'governor-returned',
      'VITEST_PURE_LANE_GOVERNOR state=settled exitStatus=0 signal=none\n',
    ]);
  });
});
