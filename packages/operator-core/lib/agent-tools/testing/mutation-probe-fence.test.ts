import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync,mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { terminateSpawnTree } from '@papercusp/backup/hook';

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, fork: vi.fn(actual.fork) };
});
vi.mock('@papercusp/backup/hook', async original => {
  const actual = await original<typeof import('@papercusp/backup/hook')>();
  return { ...actual, terminateSpawnTree: vi.fn(actual.terminateSpawnTree) };
});

// runTestFilesCore also consults the restricted-write fence (WI-10005634), which reads the
// disclosure ledger through getOrgPg and fails CLOSED without it. This suite has no Postgres
// and is about the mutation fence; restricted-hold-fence.test.ts covers that fence.
vi.mock('./restricted-hold-fence', () => ({ restrictedHoldRefusal: async () => null }));
vi.mock('../locks/su-lock-store', () => ({
  ensureBootstrap: vi.fn(async () => undefined),
  getTxPool: vi.fn(() => ({})),
  readQueue: vi.fn(),
}));

import { readQueue } from '../locks/su-lock-store';
import { runTestFilesCore } from './run';
import { mutationProbeRefusal, testImportClosures } from './mutation-probe-fence';

const readQueueMock = vi.mocked(readQueue);
let root: string;
let admissionBase = '';
let previousAdmissionBase: string | undefined;

it('keeps concurrent closure workers independent of an active caller compiler', async () => {
  const dir = makeRoot();
  writeFileSync(join(dir, 'subject.ts'), 'export const value = 1;');
  writeFileSync(join(dir, 'entry.ts'), 'export { value } from "./subject.ts";');
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const parentBuild = build({ stdin: { contents: 'export const parent = 1;' }, write: false,
    plugins: [{ name: 'held-parent-compiler', setup(api) { api.onStart(async () => { started(); await gate; }); } }] });
  // Attach rejection handling immediately: killing the caller's service is the
  // counterexample, and must be reported here rather than as an unhandled rejection.
  const parentOutcome = parentBuild.then(result => ({ result }), error => ({ error }));
  try {
    await ready;
    const results = await Promise.all([testImportClosures(dir, [join(dir, 'entry.ts')]),
      testImportClosures(dir, [join(dir, 'entry.ts')])]);
    for (const result of results) {
      expect(result.status).toBe('complete');
      if (result.status === 'complete') expect(result.files.get(join(dir, 'entry.ts'))).toContain(join(dir, 'subject.ts'));
    }
  } finally { release(); }
  expect(await parentOutcome).toHaveProperty('result.outputFiles');
}, 20_000);

it.skipIf(process.platform !== 'linux')('terminates a deadline-expired compiler and its real esbuild child', async () => {
  const dir = makeRoot(), marker = join(dir, 'service.json'), worker = join(dir, 'blocked.mjs');
  const esbuild = pathToFileURL(createRequire(import.meta.url).resolve('esbuild')).href;
  writeFileSync(worker, `import { build } from ${JSON.stringify(esbuild)};
    import { readFileSync, writeFileSync } from 'node:fs';
    const input = await new Promise(resolve => process.once('message', resolve));
    await build({ stdin: { contents: 'export const blocked = 1' }, write: false,
      plugins: [{ name: 'blocked-build', setup(api) { api.onStart(async () => {
        // Synchronous thread-self reads select this worker's OS thread. A
        // process-wide census would include the caller service we must preserve.
        const children = readFileSync('/proc/thread-self/children', 'utf8').trim().split(/\\s+/).filter(Boolean)
          .filter(pid => { try { return readFileSync('/proc/' + pid + '/cmdline', 'utf8').includes('--service='); } catch { return false; } });
        writeFileSync(input.root + '/service.json', JSON.stringify(children.map(Number)));
        await new Promise(() => {});
      }); } }] });`);
  const result = await testImportClosures(dir, [], { workerPath: worker, budgetMs: 1500 });
  expect(result).toEqual({ status: 'incomplete', reason: 'closure exceeded 1500ms' });
  expect(existsSync(marker), 'The compiler must have started before the deadline; startup alone is not a cancellation test.').toBe(true);
  const children: number[] = JSON.parse(readFileSync(marker, 'utf8'));
  expect(children.length).toBeGreaterThan(0);
  const deadline = Date.now() + 3000;
  while (children.some(pid => existsSync('/proc/' + pid)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  expect(children.filter(pid => existsSync('/proc/' + pid))).toEqual([]);
}, 6000);

it('fails closed when the owned compiler worker errors or exits without evidence', async () => {
  const dir = makeRoot(), worker = join(dir, 'broken.mjs');
  writeFileSync(worker, 'throw new Error("compiler-fixture-error");');
  const failure = await testImportClosures(dir, [], { workerPath: worker });
  expect(failure.status).toBe('incomplete');
  if (failure.status === 'incomplete') expect(failure.reason).toContain('compiler-fixture-error');
  writeFileSync(worker, 'process.exit(0);');
  await expect(testImportClosures(dir, [], { workerPath: worker })).resolves.toMatchObject({ status: 'incomplete', reason: 'compiler worker exited before returning a closure (0)' });
});

function failedTransport(pid?: number) {
  const child = Object.assign(new EventEmitter(), {
    pid, exitCode: null as number | null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough(),
    send: vi.fn(() => queueMicrotask(() => child.emit('error', new Error('compiler IPC failed')))),
  });
  vi.mocked(fork).mockReturnValueOnce(child as unknown as ChildProcess);
  return child;
}

it('waits for a spawned compiler to exit after an IPC error before returning or closing its streams', async () => {
  const child = failedTransport(2_147_483_647);
  let terminated!: () => void;
  const cleanupStarted = new Promise<void>(resolve => { terminated = resolve; });
  // No real process is signalled: this transport fixture controls exit independently.
  vi.mocked(terminateSpawnTree).mockImplementationOnce(() => terminated());
  let settled = false;
  const outcome = testImportClosures(makeRoot(), []).then(result => { settled = true; return result; });
  try {
    await cleanupStarted;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled, 'IPC failure does not mean the owned worker has exited').toBe(false);
    expect(child.stdout.destroyed).toBe(false);
    expect(child.stderr.destroyed).toBe(false);
    child.exitCode = 1;
    child.emit('exit', 1, null);
    await expect(outcome).resolves.toEqual({ status: 'incomplete', reason: 'compiler IPC failed' });
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  } finally {
    child.emit('exit', 1, null);
    await outcome;
  }
});

it('returns promptly when a compiler fails to spawn and emits no exit event', async () => {
  const child = failedTransport();
  vi.mocked(terminateSpawnTree).mockImplementationOnce(() => undefined);
  const outcome = testImportClosures(makeRoot(), [], { budgetMs: 50 });
  await expect(outcome).resolves.toEqual({ status: 'incomplete', reason: 'compiler IPC failed' });
  expect(child.stdout.destroyed).toBe(true);
  expect(child.stderr.destroyed).toBe(true);
}, 1000);

beforeEach(() => {
  previousAdmissionBase = process.env.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT;
  admissionBase = mkdtempSync(join(tmpdir(), 'testing-run-mutation-probe-admission-'));
  process.env.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT = admissionBase;
});

afterEach(() => {
  readQueueMock.mockReset();
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
  if (admissionBase) rmSync(admissionBase, { recursive: true, force: true });
  if (previousAdmissionBase === undefined) delete process.env.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT;
  else process.env.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT = previousAdmissionBase;
});

function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'testing-run-mutation-probe-fence-'));
  return root;
}

function admissionDirFor(dir: string): string {
  const key = createHash('sha256').update(realpathSync(dir)).digest('hex');
  return join(admissionBase, `papercusp-mutation-probe-${process.getuid?.() ?? 0}-${key}`);
}

it('refuses the run before root discovery when the checkout has an active mutation-probe lock', async () => {
  readQueueMock.mockResolvedValue({
    active_locks: [{
      lock_id: 'probe-lock',
      path: 'src/subject.ts',
      owner: 'peer',
      owner_label: 'Peer',
      intent: ' mutation probe ',
      goal_ref: null,
      acquired_ts: new Date('2026-09-24T07:00:00.000Z'),
      expires_ts: new Date('2026-09-24T08:00:00.000Z'),
      coordination_domain: '/repo',
    }],
    waiting: [],
  });

  const checkout = makeRoot();
  const result = await runTestFilesCore({ root: checkout, files: ['tests/subject.test.ts'] });

  expect(result).toMatchObject({ ok: false, error: 'mutation_probe_active' });
  expect("hint" in result ? result.hint : undefined).toContain('src/subject.ts');
  expect(readQueueMock).toHaveBeenCalledWith(expect.anything(), { coordinationDomain: checkout });
});

it('fails closed when the lock ledger cannot establish whether a probe is active', async () => {
  readQueueMock.mockRejectedValue(new Error('lock ledger unavailable'));

  const result = await runTestFilesCore({ root: makeRoot(), files: ['tests/subject.test.ts'] });

  expect(result).toMatchObject({ ok: false, error: 'mutation_probe_state_unknown' });
  expect("hint" in result ? result.hint : undefined).toContain('lock ledger unavailable');
});

it('retries a transient lock-query statement timeout before failing closed', async () => {
  readQueueMock
    .mockRejectedValueOnce(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))
    .mockResolvedValue({ active_locks: [], waiting: [] });

  const result = await mutationProbeRefusal(makeRoot(), ['tests/subject.test.ts']);

  expect(result).toBeNull();
  expect(readQueueMock).toHaveBeenCalledTimes(2);
});

it('continues to ordinary root validation when no mutation-probe lock is active', async () => {
  readQueueMock.mockResolvedValue({ active_locks: [], waiting: [] });

  const result = await runTestFilesCore({ root: makeRoot(), files: ['tests/subject.test.ts'] });

  expect(result).toMatchObject({ ok: false, error: 'invalid_root' });
});

// EI-24100872054224181 secondary: the fence used to refuse the WHOLE checkout. It now admits a
// test file only when its import closure provably cannot observe the probed source.
describe('mutationProbeRefusal narrowing', () => {
  const probe = (...paths: string[]) => ({ probePaths: async () => paths });
  function checkout(files: Record<string, string>): string {
    const dir = makeRoot();
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return dir;
  }
  const base = {
    'src/subject.ts': 'export const subject = 1;\n',
    'src/other.ts': 'export const other = 2;\n',
    'src/mid.ts': "export { subject } from './subject';\n",
    'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', main: 'index.js' }),
    'node_modules/pkg/index.js': 'exports.value = 3;\n',
  };

  it('admits a test whose closure excludes the probed source, including packages it imports', async () => {
    const dir = checkout({ ...base,
      'tests/other.test.ts': "import { other } from '../src/other';\nimport { value } from 'pkg';\nimport { join } from 'node:path';\nexport default [other, value, join];\n" });
    await expect(mutationProbeRefusal(dir, ['tests/other.test.ts'], probe('src/subject.ts'))).resolves.toBeNull();
  });

  it('admits an untraceable dynamic import only while a matching original-byte overlay is published', async () => {
    const dir = checkout({ ...base,
      'tests/dynamic.test.ts': 'export const load = (name: string) => import(name);\n',
    });
    const manifestDir = admissionDirFor(dir);
    mkdirSync(manifestDir, { mode: 0o700 });
    try {
      writeFileSync(join(manifestDir, 'original.manifest'),
        `${dir}\0${join(dir, 'src/subject.ts')}\0${join(dir, 'snapshot.ts')}\0${process.pid}\0`);
      await expect(mutationProbeRefusal(dir, ['tests/dynamic.test.ts'], probe('src/subject.ts'))).resolves.toBeNull();
      await expect(mutationProbeRefusal(dir, ['tests/dynamic.test.ts'], probe('src/other.ts')))
        .resolves.toMatchObject({ error: 'mutation_probe_active' });
    } finally {
      rmSync(manifestDir, { recursive: true, force: true });
    }
  });

  describe('a lock that outlives the dirty window (EI-24720263797874266)', () => {
    const sha = (value: string) => createHash('sha256').update(value).digest('hex');
    function recordRestore(dir: string, path: string, original: string, rootField = realpathSync(dir)): void {
      const subjectPath = join(realpathSync(dir), path);
      const records = join(admissionDirFor(dir), 'restored');
      mkdirSync(records, { recursive: true, mode: 0o700 });
      writeFileSync(join(records, sha(subjectPath)), `${rootField}\0${subjectPath}\0${sha(original)}\0`);
    }
    const importsSubject = { ...base, 'tests/subject.test.ts': "import { subject } from '../src/mid';\nexport default subject;\n" };
    let dirs: string[] = [];
    afterEach(() => {
      for (const dir of dirs) rmSync(admissionDirFor(dir), { recursive: true, force: true });
      dirs = [];
    });
    const track = (dir: string) => { dirs.push(dir); return dir; };

    it('refuses a test that reaches the locked subject when no restore was recorded (control)', async () => {
      const dir = track(checkout(importsSubject));
      await expect(mutationProbeRefusal(dir, ['tests/subject.test.ts'], probe('src/subject.ts')))
        .resolves.toMatchObject({ error: 'mutation_probe_active' });
    });

    it('admits even a test importing the subject while its bytes still match the verified restore', async () => {
      const dir = track(checkout(importsSubject));
      recordRestore(dir, 'src/subject.ts', base['src/subject.ts']);
      await expect(mutationProbeRefusal(dir, ['tests/subject.test.ts'], probe('src/subject.ts'))).resolves.toBeNull();
    });

    it('fences again the moment the subject changes after the restore (a hand mutation or later edit)', async () => {
      const dir = track(checkout(importsSubject));
      recordRestore(dir, 'src/subject.ts', base['src/subject.ts']);
      writeFileSync(join(dir, 'src/subject.ts'), 'export const subject = 2;\n');
      const refusal = await mutationProbeRefusal(dir, ['tests/subject.test.ts'], probe('src/subject.ts'));
      expect(refusal).toMatchObject({ error: 'mutation_probe_active' });
      expect(refusal!.hint).toContain('src/subject.ts');
    });

    it('ignores a record that names another checkout root', async () => {
      const dir = track(checkout(importsSubject));
      recordRestore(dir, 'src/subject.ts', base['src/subject.ts'], '/elsewhere');
      await expect(mutationProbeRefusal(dir, ['tests/subject.test.ts'], probe('src/subject.ts')))
        .resolves.toMatchObject({ error: 'mutation_probe_active' });
    });

    it('covers each lock independently and fences only the uncovered one', async () => {
      const dir = track(checkout({ ...importsSubject,
        'tests/both.test.ts': "import { subject } from '../src/subject';\nimport { other } from '../src/other';\nexport default [subject, other];\n" }));
      const realRoot = realpathSync(dir);
      mkdirSync(admissionDirFor(dir), { recursive: true, mode: 0o700 });
      writeFileSync(join(admissionDirFor(dir), 'original.manifest'),
        `${realRoot}\0${join(realRoot, 'src/subject.ts')}\0${join(realRoot, 'snapshot.ts')}\0${process.pid}\0`);
      const locks = probe('src/subject.ts', 'src/other.ts');
      const refusal = await mutationProbeRefusal(dir, ['tests/both.test.ts'], locks);
      expect(refusal).toMatchObject({ error: 'mutation_probe_active' });
      expect(refusal!.hint).toContain('mutation probe on src/other.ts and');
      expect(refusal!.hint).not.toContain('src/subject.ts,');
      recordRestore(dir, 'src/other.ts', base['src/other.ts']);
      await expect(mutationProbeRefusal(dir, ['tests/both.test.ts'], locks)).resolves.toBeNull();
    });
  });

  // WI-10004508: a lock is taken before its probe publishes a manifest, and only one in-tree
  // probe runs per checkout, so a queued subject sits locked but UNMUTATED. Observed 2026-09-30
  // 22:12Z: an unrelated fs-walking test was refused on remember.ts while the live manifest
  // named a different file. A path whose bytes equal its committed HEAD blob is covered.
  describe('a locked path that is still its committed HEAD bytes (WI-10004508)', () => {
    const gitEnv = { ...process.env };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']) delete gitEnv[key];
    function commitAll(dir: string): void {
      const git = (...args: string[]) => execFileSync('git', [
        '-C', dir, '-c', 'init.templateDir=', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
        '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args,
      ], { stdio: 'pipe', env: gitEnv });
      git('init', '-q');
      git('add', '-A');
      git('commit', '-qm', 'fixture');
    }
    // The refused test from the incident: it walks the filesystem, so the closure fence refuses it.
    const walks = { ...base,
      'tests/walk.test.ts': "import { readdirSync } from 'node:fs';\nexport default readdirSync('.');\n",
      'tests/subject.test.ts': "import { subject } from '../src/mid';\nexport default subject;\n" };

    it('refuses the fs-walking test when the checkout has no repository to prove the subject unmutated (control)', async () => {
      const dir = checkout(walks);
      const refusal = await mutationProbeRefusal(dir, ['tests/walk.test.ts'], probe('src/subject.ts'));
      expect(refusal).toMatchObject({ error: 'mutation_probe_active' });
      expect(refusal!.hint).toContain('reads the filesystem or spawns a process');
    });

    it('admits the fs-walking test, and even one importing the subject, while the locked subject is unmutated', async () => {
      const dir = checkout(walks);
      commitAll(dir);
      await expect(mutationProbeRefusal(dir, ['tests/walk.test.ts'], probe('src/subject.ts'))).resolves.toBeNull();
      await expect(mutationProbeRefusal(dir, ['tests/subject.test.ts'], probe('src/subject.ts'))).resolves.toBeNull();
    });

    it('fences again on an uncommitted change to the locked subject (a hand mutation)', async () => {
      const dir = checkout(walks);
      commitAll(dir);
      writeFileSync(join(dir, 'src/subject.ts'), 'export const subject = 0;\n');
      for (const test of ['tests/walk.test.ts', 'tests/subject.test.ts']) {
        const refusal = await mutationProbeRefusal(dir, [test], probe('src/subject.ts'));
        expect(refusal).toMatchObject({ error: 'mutation_probe_active' });
        expect(refusal!.hint).toContain('mutation probe on src/subject.ts and');
      }
    });

    it('keeps fencing a locked path that HEAD does not track', async () => {
      const dir = checkout(walks);
      commitAll(dir);
      writeFileSync(join(dir, 'src/fresh.ts'), 'export const fresh = 1;\n');
      const refusal = await mutationProbeRefusal(dir, ['tests/walk.test.ts'], probe('src/fresh.ts'));
      expect(refusal).toMatchObject({ error: 'mutation_probe_active' });
      expect(refusal!.hint).toContain('src/fresh.ts');
    });

    it('covers each locked path on its own bytes: only the changed one stays fenced', async () => {
      const dir = checkout(walks);
      commitAll(dir);
      writeFileSync(join(dir, 'src/other.ts'), 'export const other = 0;\n');
      const refusal = await mutationProbeRefusal(dir, ['tests/walk.test.ts'], probe('src/subject.ts', 'src/other.ts'));
      expect(refusal).toMatchObject({ error: 'mutation_probe_active' });
      expect(refusal!.hint).toContain('mutation probe on src/other.ts and');
    });

    // EI-24852529885337741: every operator-side fork costs ~160 ms of main-thread time and this
    // preflight runs on every testing:run while a probe lock is held (386 single-path
    // hash-object forks in 10 min on :3170, 2026-10-02). A PATH wrapper records each git argv.
    function recordGitArgv<T>(run: () => Promise<T>): Promise<{ result: T; hashObject: string[] }> {
      const bin = mkdtempSync(join(tmpdir(), 'fence-git-argv-'));
      const log = join(bin, 'argv.log');
      const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
      const savedPath = process.env.PATH;
      process.env.PATH = `${bin}:${savedPath ?? ''}`;
      return run().then((result) => {
        const lines = existsSync(log) ? readFileSync(log, 'utf8').split('\n') : [];
        return { result, hashObject: lines.filter((line) => / hash-object /.test(` ${line} `)) };
      }).finally(() => {
        process.env.PATH = savedPath;
        rmSync(bin, { recursive: true, force: true });
      });
    }

    it('proves every locked path with ONE hash-object fork', async () => {
      const dir = checkout(walks);
      commitAll(dir);
      const { result, hashObject } = await recordGitArgv(() =>
        mutationProbeRefusal(dir, ['tests/walk.test.ts'], probe('src/subject.ts', 'src/other.ts', 'src/mid.ts')));
      expect(result).toBeNull();
      expect(hashObject).toHaveLength(1);
      expect(hashObject[0]).toMatch(/hash-object -- src\/subject\.ts src\/other\.ts src\/mid\.ts$/);
    });

    it('falls back to one fork per path when the batch fails, so a missing file fences only itself', async () => {
      const dir = checkout(walks);
      commitAll(dir);
      rmSync(join(dir, 'src/other.ts'));
      const { result, hashObject } = await recordGitArgv(() =>
        mutationProbeRefusal(dir, ['tests/walk.test.ts'], probe('src/subject.ts', 'src/other.ts')));
      expect(result).toMatchObject({ error: 'mutation_probe_active' });
      expect(result!.hint).toContain('mutation probe on src/other.ts and');
      expect(result!.hint).not.toContain('src/subject.ts');
      expect(hashObject).toHaveLength(3);
    });
  });

  it('does not mistake a commented literal package import for a dynamic import', async () => {
    const dir = checkout({ ...base,
      'tests/commented.test.ts': "export const load = () => import(/* package name */ 'pkg');\n" });
    await expect(mutationProbeRefusal(dir, ['tests/commented.test.ts'], probe('src/subject.ts'))).resolves.toBeNull();
  });

  // EI-24556278753778650: the bundle-text scan refused every test reaching a module whose STRING
  // mentioned `import(...)` (a real operator-core test prose message did exactly that).
  it('does not mistake import()/require() text inside strings or comments for a call', async () => {
    const dir = checkout({ ...base,
      'src/prose.ts': "// see import(name) and require(x) below\nexport const msg = 'import(...) throws this exact V8-level message before ' + `require(${1})`;\n",
      'tests/prose.test.ts': "import { msg } from '../src/prose';\nexport default msg;\n" });
    await expect(mutationProbeRefusal(dir, ['tests/prose.test.ts'], probe('src/subject.ts'))).resolves.toBeNull();
  });

  it('does not mistake `new Set()` for a path segment named by the probe stem', async () => {
    const dir = checkout({ ...base,
      'src/other.ts': 'export const values = new Set();\n',
      'tests/other.test.ts': "import { values } from '../src/other';\nexport default values;\n" });
    await expect(mutationProbeRefusal(dir, ['tests/other.test.ts'], probe('plans/new.ts'))).resolves.toBeNull();
  });

  it('still fences a runtime-assembled path when a string literal contains the probe stem as a path segment', async () => {
    const dir = checkout({ ...base,
      'src/loader.ts': "export const target = 'plans/' + 'new' + '.ts';\n",
      'tests/loader.test.ts': "import { target } from '../src/loader';\nexport default target;\n" });
    const refusal = await mutationProbeRefusal(dir, ['tests/loader.test.ts'], probe('plans/new.ts'));
    expect(refusal).toMatchObject({ error: 'mutation_probe_active' });
    expect(refusal!.hint).toContain('loader.ts names new.ts');
  });

  it('does not treat a generic path segment as a reference to a probed source filename', async () => {
    const dir = checkout({ ...base,
      'src/loader.ts': "export const route = '/api/sessions/active';\n",
      'tests/loader.test.ts': "import { route } from '../src/loader';\nexport default route;\n" });
    await expect(mutationProbeRefusal(dir, ['tests/loader.test.ts'],
      probe('packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts'))).resolves.toBeNull();
  });

  it('does not mistake a hex fixture containing db for a reference to db.ts', async () => {
    const dir = checkout({ ...base,
      'src/merkle-log.ts': "export const vectors = ['ddb89be4', '0f8a309157f0daa35dc5b87e'];\n",
      'tests/merkle-log.test.ts': "import { vectors } from '../src/merkle-log';\nexport default vectors;\n" });
    await expect(mutationProbeRefusal(dir, ['tests/merkle-log.test.ts'],
      probe('apps/operator-public/src/db.ts'))).resolves.toBeNull();
  });

  // EI-24777609977774399: a probe on plans/runner.ts refused a test whose only `runner` token was
  // its import path '…/migration-runner.js'. The probed filename must sit at a path boundary on
  // BOTH sides: a hyphen-prefixed sibling and a longer suffix name different files. Every case
  // above uses a literal that lacks the probed filename entirely, so only this one pins the
  // boundary checks themselves; the positive control proves the same probe still fences.
  it('does not mistake a filename that merely contains the probed filename for a reference to it', async () => {
    const runner = probe('packages/operator-core/lib/agent-tools/plans/runner.ts');
    const near = checkout({ ...base,
      'src/loader.ts': "export const paths = ['../embedded-postgres-server/src/migration-runner.ts', 'plans/runner.ts.snap'];\n",
      'tests/loader.test.ts': "import { paths } from '../src/loader';\nexport default paths;\n" });
    await expect(mutationProbeRefusal(near, ['tests/loader.test.ts'], runner)).resolves.toBeNull();

    const exact = checkout({ ...base,
      'src/loader.ts': "export const paths = ['../agent-tools/plans/runner.ts'];\n",
      'tests/loader.test.ts': "import { paths } from '../src/loader';\nexport default paths;\n" });
    const refusal = await mutationProbeRefusal(exact, ['tests/loader.test.ts'], runner);
    expect(refusal).toMatchObject({ error: 'mutation_probe_active' });
    expect(refusal!.hint).toContain('loader.ts names runner.ts');
  });

  it('still fences a statically concatenated complete probed filename', async () => {
    const dir = checkout({ ...base,
      'src/loader.ts': "export const target = 'routes/adv/' + 'sessions' + '.ts';\n",
      'tests/loader.test.ts': "import { target } from '../src/loader';\nexport default target;\n" });
    const refusal = await mutationProbeRefusal(dir, ['tests/loader.test.ts'],
      probe('packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts'));
    expect(refusal).toMatchObject({ error: 'mutation_probe_active' });
    expect(refusal!.hint).toContain('loader.ts names sessions.ts');
  });

  it('still fences a complete probed filename in a statically interpolated template', async () => {
    const dir = checkout({ ...base,
      'src/loader.ts': "export const target = `routes/adv/${'sessions'}.ts`;\n",
      'tests/loader.test.ts': "import { target } from '../src/loader';\nexport default target;\n" });
    const refusal = await mutationProbeRefusal(dir, ['tests/loader.test.ts'],
      probe('packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts'));
    expect(refusal).toMatchObject({ error: 'mutation_probe_active' });
    expect(refusal!.hint).toContain('loader.ts names sessions.ts');
  });

  it('refuses a test that imports the probed source, directly or transitively', async () => {
    const dir = checkout({ ...base,
      'tests/direct.test.ts': "import { subject } from '../src/subject';\nexport default subject;\n",
      'tests/transitive.test.ts': "import { subject } from '../src/mid';\nexport default subject;\n" });
    for (const test of ['tests/direct.test.ts', 'tests/transitive.test.ts']) {
      const refusal = await mutationProbeRefusal(dir, [test], probe('src/subject.ts'));
      expect(refusal).toMatchObject({ error: 'mutation_probe_active' });
      expect(refusal!.hint).toContain(`${test} may observe it: imports`);
    }
  });

  it('refuses when any one requested test can observe the probe', async () => {
    const dir = checkout({ ...base,
      'tests/other.test.ts': "import { other } from '../src/other';\nexport default other;\n",
      'tests/direct.test.ts': "import { subject } from '../src/subject';\nexport default subject;\n" });
    const refusal = await mutationProbeRefusal(dir, ['tests/other.test.ts', 'tests/direct.test.ts'], probe('src/subject.ts'));
    expect(refusal!.hint).toContain('tests/direct.test.ts may observe it');
  });

  it('fails closed on every reach the import graph cannot see', async () => {
    const dir = checkout({ ...base,
      'src/data.sql': 'select 1;\n',
      'src/loader.ts': "import { readFileSync } from 'node:fs';\nexport const text = () => readFileSync(`src/${'subject'}.ts`, 'utf8');\n",
      'tests/dynamic.test.ts': "export const load = (name: string) => import(name);\n",
      'tests/commented-dynamic.test.ts': "export const load = (name: string) => import(/* runtime */ name);\n",
      'tests/template-dynamic.test.ts': "export const load = (name: string) => import(`../src/${name}.ts`);\n",
      'tests/named.test.ts': "import { text } from '../src/loader';\nexport default text;\n",
      'tests/walks.test.ts': "import { readdirSync } from 'node:fs';\nexport default readdirSync('src');\n",
      'tests/unresolved.test.ts': "import { gone } from '../src/gone';\nexport default gone;\n",
      'tests/other.test.ts': "import { other } from '../src/other';\nexport default other;\n" });
    const cases: Array<[string, string, string]> = [
      ['tests/dynamic.test.ts', 'src/subject.ts', 'has an import this walk cannot follow: non-literal import()'],
      ['tests/commented-dynamic.test.ts', 'src/subject.ts', 'has an import this walk cannot follow: non-literal import()'],
      ['tests/template-dynamic.test.ts', 'src/subject.ts', 'has an import this walk cannot follow: non-literal import()'],
      ['tests/named.test.ts', 'src/subject.ts', 'loader.ts names subject'],
      ['tests/walks.test.ts', 'src/subject.ts', 'reads the filesystem or spawns a process'],
      ['tests/unresolved.test.ts', 'src/subject.ts', 'import closure could not be established'],
      ['tests/missing.test.ts', 'src/subject.ts', 'could not be resolved'],
      ['tests/other.test.ts', 'src/data.sql', 'is not a code module'],
    ];
    for (const [test, probed, why] of cases) {
      const refusal = await mutationProbeRefusal(dir, [test], probe(probed));
      expect(refusal, test).toMatchObject({ error: 'mutation_probe_active' });
      expect(refusal!.hint, test).toContain(why);
    }
  });

  // EI-24556278753778650: a createRequire loader used to refuse EVERY test whose closure held the
  // text `createRequire(` — including the db connection module reached by most operator-core tests.
  describe('createRequire loaders', () => {
    const lazyNodeRequire = [
      "import { createRequire } from 'node:module';",
      'let _nodeRequire: ReturnType<typeof createRequire> | undefined;',
      'const nodeRequire = (id: string): unknown => (_nodeRequire ??= createRequire(import.meta.url))(id);',
      "export const home = () => (nodeRequire('node:os') as { homedir(): string }).homedir();",
      "export const exists = (p: string) => (nodeRequire('node:fs') as { existsSync(p: string): boolean }).existsSync(p);",
    ].join('\n');

    it('admits a test that reaches a createRequire loader of builtins only (the libs/db connection idiom)', async () => {
      const dir = checkout({ ...base,
        'src/connection.ts': `${lazyNodeRequire}\n// never \`createRequire(import.meta.url)(x)\` eagerly\n`,
        'tests/db.test.ts': "import { home } from '../src/connection';\nimport { other } from '../src/other';\nexport default [home, other];\n" });
      await expect(mutationProbeRefusal(dir, ['tests/db.test.ts'], probe('src/subject.ts'))).resolves.toBeNull();
    });

    it('follows a literal createRequire edge into the probed source and refuses', async () => {
      const dir = checkout({ ...base,
        'src/cr-loader.ts': "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nexport const mod = req('./mid');\n",
        'tests/cr.test.ts': "import { mod } from '../src/cr-loader';\nexport default mod;\n" });
      const refusal = await mutationProbeRefusal(dir, ['tests/cr.test.ts'], probe('src/subject.ts'));
      expect(refusal).toMatchObject({ error: 'mutation_probe_active' });
      // Reached through the resolved edge (cr-loader → mid → subject), not a name heuristic.
      expect(refusal!.hint).toContain(`imports ${join(dir, 'src/subject.ts')}`);
    });

    it('refuses only the tests whose closure reaches an unfollowable createRequire loader', async () => {
      const dir = checkout({ ...base,
        'src/dyn-loader.ts': "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nexport const load = (n: string) => req(n);\n",
        'tests/dyn.test.ts': "import { load } from '../src/dyn-loader';\nexport default load;\n",
        'tests/other.test.ts': "import { other } from '../src/other';\nexport default other;\n" });
      await expect(mutationProbeRefusal(dir, ['tests/other.test.ts'], probe('src/subject.ts'))).resolves.toBeNull();
      const refusal = await mutationProbeRefusal(dir, ['tests/other.test.ts', 'tests/dyn.test.ts'], probe('src/subject.ts'));
      expect(refusal).toMatchObject({ error: 'mutation_probe_active' });
      expect(refusal!.hint).toContain('tests/dyn.test.ts may observe it');
      expect(refusal!.hint).toContain('createRequire loader this walk cannot follow');
    });
  });

  it('makes no closure walk when no probe is active', async () => {
    await expect(mutationProbeRefusal(makeRoot(), ['tests/absent.test.ts'], probe())).resolves.toBeNull();
  });
});
