/** Shared by the private PG journey and its cheap compiler-only preflight. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { buildSyncBatchDeltaDeps, runBoundedArgv, type RunResult } from '../lib/release/sync-batch-delta-check-deps';

export const SYNC_LINT_TYPE_ERROR_FILE = 'src/type-error.ts';

export async function prepareSyncLintPrivateCompiler(root: string, fixtureRoot: string) {
  await mkdir(join(fixtureRoot, 'src'), { recursive: true });
  await mkdir(join(fixtureRoot, 'scripts'), { recursive: true });
  await writeFile(join(fixtureRoot, SYNC_LINT_TYPE_ERROR_FILE), 'export const value: number = "wrong";\n');
  await writeFile(join(fixtureRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true }, include: [SYNC_LINT_TYPE_ERROR_FILE],
  }));
  const compiler = join(root, 'node_modules/typescript/lib/tsc.js');
  const script = join(fixtureRoot, 'scripts/lint-tsc.mjs');
  await writeFile(script,
    `import { appendFileSync } from 'node:fs';\n` +
    `const started = Date.now();\n` +
    `const stage = (stage, extra = {}) => console.error('SYNC_LINT_COMPILER_STAGE ' + JSON.stringify({ stage, elapsedMs: Date.now() - started, pid: process.pid, ...extra }));\n` +
    `appendFileSync(${JSON.stringify(join(fixtureRoot, 'compiler-pids'))}, process.pid + '\\n');\n` +
    `stage('wrapper-entry');\n` +
    `process.once('exit', code => stage('exit', { code, cpuUsage: process.cpuUsage(), resourceUsage: process.resourceUsage() }));\n` +
    `process.argv = [process.execPath, ${JSON.stringify(compiler)}, '--project', 'tsconfig.json', '--pretty', 'false'];\n` +
    `stage('compiler-import');\n` +
    `await import(${JSON.stringify(pathToFileURL(compiler).href)});\n` +
    `stage('compiler-returned');\n`);
  return script;
}

/** Fail before allocating private PG if the exact fixture/compiler is unusable. */
export async function preflightSyncLintPrivateCompiler(root: string,
  options: { exec?: typeof runBoundedArgv } = {}) {
  const fixture = await mkdtemp(join(tmpdir(), 'p037-compiler-'));
  const invocations: { phase: 'red' | 'green'; command: string; args: string[]; timeoutMs: number;
    pendingStage: string; samples: { at: string; pid: number; runtimeNs: string; waitNs: string;
      slices: string; state: string }[]; result: RunResult | null }[] = [];
  try {
    await prepareSyncLintPrivateCompiler(root, fixture);
    const deps = buildSyncBatchDeltaDeps({ installSlug: 'compiler-preflight',
      workspaceId: 'test-runtime-compiler-preflight', root: fixture, branch: 'staging',
      exec: async (cmd, args, opts) => {
        const timeoutMs = 10_000;
        const samples: (typeof invocations)[number]['samples'] = [];
        let done = false;
        const observe = async () => {
          while (!done) {
            await delay(250);
            if (done || process.platform !== 'linux') continue;
            try {
              const pid = Number((await readFile(join(fixture, 'compiler-pids'), 'utf8')).trim().split('\n').at(-1));
              const [sched, stat] = await Promise.all([readFile(`/proc/${pid}/schedstat`, 'utf8'),
                readFile(`/proc/${pid}/stat`, 'utf8')]);
              const [runtimeNs, waitNs, slices] = sched.trim().split(/\s+/);
              if (samples.length < 80) samples.push({ at: new Date().toISOString(), pid, runtimeNs, waitNs,
                slices, state: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
        };
        const observation = observe();
        let result: RunResult | null;
        try { result = await (options.exec ?? runBoundedArgv)(cmd, args, { ...opts, timeoutMs }); }
        finally { done = true; await observation; }
        const stages = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`.split('\n')
          .filter(line => line.startsWith('SYNC_LINT_COMPILER_STAGE '))
          .map(line => JSON.parse(line.slice('SYNC_LINT_COMPILER_STAGE '.length)) as { stage: string });
        invocations.push({ phase: invocations.length === 0 ? 'red' : 'green', command: cmd, args,
          timeoutMs, pendingStage: stages.at(-1)?.stage ?? 'spawned', samples, result: result && { ...result,
            stdout: result.stdout.slice(-8000), stderr: result.stderr.slice(-8000) } });
        return result;
      } });
    const red = await deps.runTsc([SYNC_LINT_TYPE_ERROR_FILE]);
    assert.equal(red.ok, false, JSON.stringify(red));
    assert.deepEqual(red.failing, [SYNC_LINT_TYPE_ERROR_FILE], JSON.stringify(red));
    assert.equal(red.diagnostic?.exitCode, 2);
    await writeFile(join(fixture, SYNC_LINT_TYPE_ERROR_FILE), 'export const value: number = 1;\n');
    const green = await deps.runTsc([SYNC_LINT_TYPE_ERROR_FILE]);
    assert.equal(green.ok, true, JSON.stringify(green));
    assert.equal(green.diagnostic?.exitCode, 0);
    return { red: red.diagnostic, green: green.diagnostic, invocations, privatePgAllocated: false };
  } catch (error) {
    // runTsc deliberately reduces timeout results to an undetermined verdict.
    // Retain its original child evidence before that reduction hides the stage.
    console.info('SYNC_LINT_COMPILER_PREFLIGHT_FAILURE ' + JSON.stringify({ invocations, privatePgAllocated: false }));
    throw error;
  } finally { await rm(fixture, { recursive: true, force: true }); }
}
