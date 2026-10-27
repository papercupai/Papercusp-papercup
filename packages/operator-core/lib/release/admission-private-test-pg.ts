/** Keep the queue worker on its control database; only test children receive this fixture. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ensurePapercuspTmpdir, tmpdirHasCriticalHeadroom, tmpdirNeedsOverride } from '@papercusp/test-config/tmpdir-guard';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { processGroupLifetime } from '../fleet/process-group-lifetime';

export const ADMISSION_TEST_ENVIRONMENT = 'pinned-private-pg-test-mode-v4';
const CLEARED_DATABASE_PINS = ['HARNESS_ADMIN_DATABASE_URL', 'HARNESS_DATABASE_URL', 'DATABASE_URL', 'PAPERCUSP_PG_URL'];

export interface AdmissionTestEnvironment {
  env: NodeJS.ProcessEnv;
  assertRunning(): void;
  stop(): Promise<void>;
}

/** Uses the candidate's maintained wrapper, including its storage guard and unconditional cleanup. */
export async function startAdmissionTestEnvironment(root: string, options: {
  env?: NodeJS.ProcessEnv;
  testRunsDbUrl?: string;
  log?: (line: string) => void;
  onOutput?: () => void;
  timeoutMs?: number;
  stopTimeoutMs?: number;
  scratchRoot?: string;
} = {}): Promise<AdmissionTestEnvironment> {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== '@papercupai/papercusp-monorepo') {
    return { env: {}, assertRunning() {}, async stop() {} };
  }
  const wrapper = join(root, 'scripts/with-test-pg.mjs');
  if (!existsSync(wrapper)) throw new Error('pinned Papercusp admission has no maintained private-PG wrapper');
  const marker = 'ADMISSION_PRIVATE_PG_' + randomUUID() + ':';
  // An ordinary wrapper already supports a long-lived stdin child. No newer CLI
  // option or mutable tooling script is required in the frozen candidate.
  const childCode = `process.stdout.write(${JSON.stringify(marker)} + JSON.stringify({
    PAPERCUSP_TEST_PG_ADMIN_URL: process.env.PAPERCUSP_TEST_PG_ADMIN_URL,
    PAPERCUSP_PG_PORT: process.env.PAPERCUSP_PG_PORT,
    PAPERCUSP_SKIP_PG_DISCOVERY: process.env.PAPERCUSP_SKIP_PG_DISCOVERY,
    PAPERCUSP_ADMISSION_TMPDIR: process.env.TMPDIR
  }) + '\\n'); process.stdin.resume();`;
  const env = { ...(options.env ?? process.env) };
  const testRunsDbUrl = options.testRunsDbUrl ?? env.PAPERCUSP_TEST_RUNS_DB_URL ?? env.HARNESS_ADMIN_DATABASE_URL;
  if (!testRunsDbUrl?.trim()) throw new Error('private-PG admission requires a durable reporter-only database URL');
  const sink = new URL(testRunsDbUrl);
  if (!['postgres:', 'postgresql:'].includes(sink.protocol)) throw new Error('invalid reporter-only database protocol');
  env.PAPERCUSP_TEST_RUNS_DB_URL = sink.toString();
  // The supervisor is loaded from the pinned candidate too. An ambient host
  // loader can otherwise admit/transform its imports against a different HEAD.
  delete env.NODE_OPTIONS;
  for (const key of CLEARED_DATABASE_PINS) delete env[key];
  // Frozen wrappers allocate PG beneath TMPDIR. Keep that directory outside
  // shared age-only test sweeps and the checkpoint tree recreated per group.
  let scratchRoot = options.scratchRoot;
  if (!scratchRoot) {
    const scratchEnv = { ...env, TMPDIR: undefined };
    const maintainedTmp = ensurePapercuspTmpdir(scratchEnv);
    if (!maintainedTmp || tmpdirNeedsOverride(maintainedTmp) ||
        !tmpdirHasCriticalHeadroom(maintainedTmp, scratchEnv)) {
      throw new Error('private-PG admission has no compatible temporary volume');
    }
    // A product HOME can have a repository ancestor, which the pinned launcher
    // rejects. Use the maintained volume, beside its age-swept test namespace.
    scratchRoot = join(dirname(realpathSync(maintainedTmp)), 'papercusp-admission-test-environments');
  }
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const fixtureTmp = mkdtempSync(join(scratchRoot, 'pg-'));
  if (tmpdirNeedsOverride(fixtureTmp) || !tmpdirHasCriticalHeadroom(fixtureTmp, env)) {
    rmSync(fixtureTmp, { recursive: true, force: true });
    throw new Error('private-PG admission owned scratch would be relocated by the pinned launcher');
  }
  env.TMPDIR = env.TMP = env.TEMP = fixtureTmp;
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath,
    [wrapper, '--', process.execPath, '-e', childCode],
    { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const lifetime = processGroupLifetime(child, line => options.log?.(line));
  let closed = false;
  let exitCode: number | null = null;
  let failure: Error | undefined;
  let resolveClosed!: () => void;
  const exited = new Promise<void>(resolve => { resolveClosed = resolve; });
  let readyResolve!: (env: NodeJS.ProcessEnv) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<NodeJS.ProcessEnv>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const onLine = (line: string) => {
    options.onOutput?.();
    if (!line.startsWith(marker)) {
      options.log?.(line);
      if (line.includes('postgres exited unexpectedly')) {
        failure ??= new Error('private-PG postmaster exited unexpectedly');
        // A disposable proof fixture cannot recover by replacing its database
        // underneath an in-flight test. End its owned group and preserve failure.
        lifetime.signal('SIGTERM');
        readyReject(failure);
      }
      return;
    }
    try {
      const value = JSON.parse(line.slice(marker.length));
      const url = new URL(value.PAPERCUSP_TEST_PG_ADMIN_URL);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
          !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
          !url.port || url.port !== value.PAPERCUSP_PG_PORT ||
          value.PAPERCUSP_SKIP_PG_DISCOVERY !== '1' ||
          value.PAPERCUSP_ADMISSION_TMPDIR !== fixtureTmp) throw new Error('invalid owned private-PG endpoint or scratch root');
      readyResolve({ ...Object.fromEntries(CLEARED_DATABASE_PINS.map(key => [key, undefined])),
        PAPERCUSP_TEST_PG_ADMIN_URL: url.toString(), PAPERCUSP_PG_PORT: url.port,
        PAPERCUSP_TEST_RUNS_DB_URL: sink.toString(),
        PAPERCUSP_SKIP_PG_DISCOVERY: '1' });
    } catch { readyReject(new Error('private-PG wrapper returned an invalid environment receipt')); }
  };
  const stdout = createInterface({ input: child.stdout });
  const stderr = createInterface({ input: child.stderr });
  stdout.on('line', onLine);
  // Only stdout carries the private receipt; stderr is ordinary durable diagnostics.
  stderr.on('line', line => { options.onOutput?.(); options.log?.(line); });
  child.once('error', error => { failure = error; readyReject(error); });
  child.once('close', (code, signal) => {
    closed = true; exitCode = code;
    failure ??= new Error(`private-PG wrapper exited (code ${code}, signal ${signal})`);
    readyReject(failure); resolveClosed(); stdout.close(); stderr.close();
  });
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    const wasClosed = closed;
    // EOF exits the wrapper's owned child normally; its existing finally stops
    // the postmaster and removes only the directory it allocated.
    child.stdin.on('error', () => {});
    child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let groupExited = false;
    try {
      if (!closed) await Promise.race([exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          lifetime.signal('SIGTERM');
          escalation = setTimeout(() => { lifetime.signal('SIGKILL'); reject(new Error('private-PG cleanup deadline expired')); }, 10_000);
        }, options.stopTimeoutMs ?? 30_000);
      })]);
      await lifetime.waitForExit({ timeoutMs: 10_000 });
      groupExited = true;
      if (exitCode !== 0) throw failure ?? new Error('private-PG cleanup was not successful');
      if (wasClosed) throw failure ?? new Error('private-PG wrapper exited before release');
    } finally {
      clearTimeout(timer); clearTimeout(escalation);
      if (groupExited) rmSync(fixtureTmp, { recursive: true, force: true });
    }
  })();
  const timer = setTimeout(() => readyReject(new Error('private-PG bootstrap deadline expired')), options.timeoutMs ?? 20 * 60_000);
  try {
    const fixtureEnv = await ready;
    if (closed) throw failure;
    return { env: fixtureEnv, assertRunning() { if (failure || closed) throw failure; }, stop };
  } catch (error) {
    try { await stop(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError],
      `private-PG bootstrap and cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
    throw error;
  } finally { clearTimeout(timer); }
}
