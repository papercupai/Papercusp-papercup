/**
 * Recurrence guard for EI-19450431506682666 — a mutation probe must never
 * leave the SHARED tree mutated.
 *
 * The incident: the hand-rolled idiom `cp bak; mutate; test; cp back` was run
 * as one foreground Bash call, hit the 2-min deadline partway through, and the
 * trailing restore never ran. git-sync then committed the mutant
 * (db6d7b02b1) — a version of scripts/verify-tauri-headless.sh in which the
 * fix's function was DEFINED but never CALLED. Inert, `bash -n`-clean, and
 * shaped exactly like a finished change.
 *
 * These tests pin the two properties that make `scripts/mutation-probe.sh`
 * safe, and they are written so that neither can pass on dead code:
 *
 *   - COPY-OUT never touches the tracked file (asserted by content identity,
 *     never by `git status` — on a swept tree a clean status means the sweep
 *     ran, not that the file is unmodified).
 *   - IN-TREE restores PROMPTLY on SIGTERM. The timing is the whole assertion:
 *     the pre-fix foreground form also restored eventually, just deferred
 *     until its child exited (measured: 23s), which is indistinguishable from
 *     "works" unless the deadline is pinned. Bash will not run a trap while
 *     waiting on a FOREGROUND child, and the harness follows SIGTERM with
 *     SIGKILL — so a deferred handler is frequently never a handler at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn as spawnProcess, spawnSync as spawnProcessSync, type SpawnOptions, type SpawnSyncOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createTextCollector } from './child-output';

/**
 * The subject under test, overridable by path. This is the tier-2 pattern the
 * script itself exists to enable: a guard that reads its subject from a
 * REDIRECTABLE path can be falsified against a mutated COPY, so proving this
 * suite is falsifiable never requires dirtying the tracked file. Without the
 * override the only way to falsify it would be an in-tree mutation — i.e. the
 * exact hazard EI-19450431506682666 was filed for.
 */
const SCRIPT = process.env.MUTATION_PROBE_SCRIPT ?? resolve(__dirname, '../../../scripts/mutation-probe.sh');
const OVERLAY = resolve(__dirname, '../../../scripts/testing-run-probe-overlay.sh');
const ORIGINAL = 'alpha\nbeta\ngamma\n';

let dir: string;
let subject: string;
let admissionBase: string;
let previousAdmissionBase: string | undefined;

/**
 * These children execute disposable fixture code, including uncommitted CJS
 * guards and intentionally mutated ES modules. Inheriting the launcher's
 * committed-source loader either refuses those guards or substitutes HEAD for
 * the mutant before the probe can judge it. Reuse the loader suite's cleanEnv
 * boundary: copy the child environment, leaving the parent runner's enforcement
 * and environment intact. Explicit argv loaders remain explicit.
 */
function fixtureChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child = { ...env };
  delete child.NODE_OPTIONS;
  return child;
}

// Keep one environment boundary for synchronous and asynchronous fixture
// children, including the fake ptool and the overlay's guard descendants.
const spawn = ((command: string, args: string[], options: SpawnOptions = {}) =>
  spawnProcess(command, args, { ...options, env: fixtureChildEnv(options.env) })) as typeof spawnProcess;
const spawnSync = ((command: string, args: string[], options: SpawnSyncOptions = {}) =>
  spawnProcessSync(command, args, { ...options, env: fixtureChildEnv(options.env) })) as typeof spawnProcessSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mutation-probe-test-'));
  subject = join(dir, 'subject.txt');
  writeFileSync(subject, ORIGINAL);
  previousAdmissionBase = process.env.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT;
  admissionBase = mkdtempSync(join(tmpdir(), 'mutation-probe-admission-test-'));
  process.env.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT = admissionBase;
});

afterEach(() => {
  // In-tree refusal cases intentionally leave their manifest in place. Each test
  // has an isolated external admission base, removed after the child has exited.
  if (admissionBase) rmSync(admissionBase, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
  if (previousAdmissionBase === undefined) delete process.env.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT;
  else process.env.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT = previousAdmissionBase;
});

function admissionDirFor(root: string): string {
  const key = createHash('sha256').update(root).digest('hex');
  return join(admissionBase, 'papercusp-mutation-probe-' + process.getuid!() + '-' + key);
}

/** Run the probe to completion and return its exit code. */
function runProbe(args: string[]): number {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000 });
  return r.status ?? -1;
}

/** Run the probe and return its exit code AND combined output (for asserting guidance text). */
function runProbeIO(args: string[], env: NodeJS.ProcessEnv = process.env, cwd?: string): { code: number; out: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000, env, cwd });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const read = () => readFileSync(subject, 'utf8');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function git(repo: string, args: string[]): string {
  const r = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  }
  return (r.stdout ?? '').trim();
}

/** A tiny real Git history lets historical-mode tests exercise git show/rev-list, not mocks. */
function makeHistoricalRepo(): { repo: string; file: string; oldSha: string } {
  const repo = join(dir, 'historical-repo');
  mkdirSync(repo);
  const file = join(repo, 'subject.txt');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'mutation-probe-test@example.invalid']);
  git(repo, ['config', 'user.name', 'mutation-probe-test']);
  writeFileSync(file, 'stable-control\nlegacy-path\n');
  git(repo, ['add', 'subject.txt']);
  git(repo, ['commit', '-qm', 'historical source']);
  const oldSha = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(file, 'stable-control\nNEW_GUARD\n');
  git(repo, ['add', 'subject.txt']);
  git(repo, ['commit', '-qm', 'fix source']);
  // Leave the current source uncommitted: the probe must freeze it before any
  // guard command runs, just as git-sync can commit a real working tree mid-run.
  writeFileSync(file, 'stable-control\nNEW_GUARD\ncurrent-edit\n');
  return { repo, file, oldSha };
}

/**
 * Like makeHistoricalRepo, but the subject is a TYPESCRIPT file — the shape
 * EI-23362664002917898 broke. The bodies carry `as const` so the content only
 * parses once types are stripped, which is decided purely by file EXTENSION.
 */
function makeHistoricalTsRepo(): { repo: string; file: string; oldSha: string } {
  const repo = join(dir, 'historical-ts-repo');
  mkdirSync(repo);
  const file = join(repo, 'subject.ts');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'mutation-probe-test@example.invalid']);
  git(repo, ['config', 'user.name', 'mutation-probe-test']);
  writeFileSync(file, '// stable-control\nexport const V = 1 as const;\n');
  git(repo, ['add', 'subject.ts']);
  git(repo, ['commit', '-qm', 'historical ts source']);
  const oldSha = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(file, '// stable-control\nexport const V = 1 as const;\nexport const NEW_GUARD = 2 as const;\n');
  git(repo, ['add', 'subject.ts']);
  git(repo, ['commit', '-qm', 'fix ts source']);
  return { repo, file, oldSha };
}

describe('mutation-probe.sh — copy-out mode (the default)', () => {
  it('refuses a CommonJS npm guard that propagates the committed loader before starting its baseline', () => {
    const repo = join(dir, 'cjs-npm-guard');
    mkdirSync(repo);
    const modulePath = join(repo, 'subject.cjs');
    const marker = join(repo, 'guard-started');
    writeFileSync(modulePath, 'module.exports = 1;\n');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: {
      'test:file': `NODE_OPTIONS="--import=./scripts/lib/committed-source-loader.mjs" node -e "require('node:fs').writeFileSync('${marker}', 'started')"`,
    } }));
    const { code, out } = runProbeIO([
      '--file', modulePath, '--mutate', 's/module.exports = 1;/module.exports = 2;/',
      '--test', 'test -f {} && npm run test:file -- provider.test.ts',
    ], process.env, repo);
    expect(code, out).toBe(2);
    expect(out).toContain('reason=commonjs-committed-loader');
    expect(out).toContain('node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs');
    expect(out).not.toContain('running baseline guard');
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(modulePath, 'utf8')).toBe('module.exports = 1;\n');
  });

  it('runs the CommonJS mutant in a child while keeping an explicit loader on its committed launcher', () => {
    const repo = join(dir, 'cjs-launcher-only');
    mkdirSync(repo);
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'mutation-probe-test@example.invalid']);
    git(repo, ['config', 'user.name', 'mutation-probe-test']);
    const modulePath = join(repo, 'subject.cjs');
    writeFileSync(modulePath, 'module.exports = 1;\n');
    const launcher = join(repo, 'launcher.mjs');
    writeFileSync(launcher, [
      "import { spawnSync } from 'node:child_process';",
      'const child = spawnSync(process.execPath, [\'-e\', "require(\'node:assert/strict\').equal(require(process.argv[1]), 1)", process.argv[2]], { stdio: \'inherit\' });',
      'process.exit(child.status ?? 2);',
    ].join('\n'));
    git(repo, ['add', 'subject.cjs', 'launcher.mjs']);
    git(repo, ['commit', '-qm', 'committed guarded launcher']);
    const loader = resolve(__dirname, '../../../scripts/lib/committed-source-loader.mjs');
    const { code, out } = runProbeIO([
      '--file', modulePath, '--mutate', 's/module.exports = 1;/module.exports = 2;/',
      '--test', `node --import ${JSON.stringify(loader)} ${JSON.stringify(launcher)} {}`,
    ], process.env, repo);
    expect(code, out).toBe(0);
    expect(out).toContain('verdict=caught');
    expect(out).toContain('AssertionError');
    expect(out).not.toContain('COMMITTED_SOURCE refused');
    expect(readFileSync(modulePath, 'utf8')).toBe('module.exports = 1;\n');
  });

  it('runs disposable CJS guards without substituting source or changing parent loader custody', () => {
    const repo = join(dir, 'loader-custody-repo');
    mkdirSync(repo);
    git(repo, ['init', '-q']);
    const modulePath = join(repo, 'subject.cjs');
    writeFileSync(modulePath, 'module.exports = 1;\n');
    const loader = resolve(__dirname, '../../../scripts/lib/committed-source-loader.mjs');
    const parentOptions = process.env.NODE_OPTIONS;
    const inherited = { ...process.env, NODE_OPTIONS: `--import=${loader}` };
    const { code, out } = runProbeIO([
      '--file', modulePath, '--mutate', 's/module.exports = 1;/module.exports = 2;/',
      '--test', 'node -e "if (require(process.argv[1]) !== 1) process.exit(1)" {}',
    ], inherited);
    expect(code, out).toBe(0);
    expect(out).toMatch(/verdict=caught/);
    expect(out).not.toContain('COMMITTED_SOURCE refused');
    expect(out).not.toContain('COMMITTED_SOURCE substituted');
    expect(readFileSync(modulePath, 'utf8')).toBe('module.exports = 1;\n');
    expect(inherited.NODE_OPTIONS).toBe(`--import=${loader}`);
    expect(process.env.NODE_OPTIONS).toBe(parentOptions);
  });

  it.each([
    ['invalid syntax', 's/beta/'],
    ['undeclared replacement state', 's/beta/$undefined_thing/'],
    ['no match', 's/nosuchtext/x/'],
    ['whitespace only', 's/beta/ beta /'],
  ])('refuses %s before launching any baseline guard', (_label, mutation) => {
    const marker = join(dir, 'guard-launched');
    const { code, out } = runProbeIO([
      '--file', subject, '--mutate', mutation,
      '--test', `printf '%s\\n' "$PAPERCUSP_MUTATION_PHASE" >> ${JSON.stringify(marker)}; grep -q '^beta$' {}`,
    ]);
    expect(code, out).toBe(2);
    expect(existsSync(marker)).toBe(false);
    expect(out).not.toContain('running baseline guard');
    expect(read()).toBe(ORIGINAL);
  });

  it('runs both baselines and the mutant guard after a valid preflight', () => {
    const marker = join(dir, 'guard-phases');
    const args = [
      '--file', subject, '--mutate', 's/beta/BETA/',
      '--test', `printf '%s\\n' "$PAPERCUSP_MUTATION_PHASE" >> ${JSON.stringify(marker)}; grep -q '^beta$' {}`,
    ];
    const { code, out } = runProbeIO(args);
    expect(code, out).toBe(0);
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual(['baseline', 'copy-baseline', 'mutant']);
    expect(read()).toBe(ORIGINAL);

    const evidenceLine = out.match(/^MUTATION_PROBE_EVIDENCE_JSON=(.+)$/m)?.[1];
    expect(evidenceLine).toBeTruthy();
    expect(JSON.parse(evidenceLine!)).toMatchObject({
      schemaVersion: 1,
      runnerPath: 'scripts/mutation-probe.sh',
      runnerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      runnerCommit: expect.stringMatching(/^[a-f0-9]{40}$/),
      cwd: 'packages/operator-core',
      argv: args,
      result: {
        verdict: 'caught',
        expected: 'caught',
        target: 'copy-out',
        baselineExit: 0,
        guardExit: 1,
      },
    });
  });

  it('EI-26470881603162340: disables pc-heavy coalescing on every guard leg, even when the caller enabled it', () => {
    // A leg's identity reaches the guard by ENV (PAPERCUSP_MUTATION_PHASE, the
    // descriptor, the receipt file). pc-heavy coalesces on cwd + argv, so a
    // pc-heavy-wrapped guard with the same argv as an earlier leg replays that
    // leg's output and no reporter runs: 6 of 9 cupboard probes on 2026-10-20
    // recorded baseline_ledger=none, and spec-test-adequacy could not link their
    // mutants to a baseline. Each leg is a measurement, so none may be replayed.
    const marker = join(dir, 'guard-coalesce');
    const { code, out } = runProbeIO([
      '--file', subject, '--mutate', 's/beta/BETA/',
      '--test', `printf '%s=%s\\n' "$PAPERCUSP_MUTATION_PHASE" "\${PC_HEAVY_COALESCE:-unset}" >> ${JSON.stringify(marker)}; grep -q '^beta$' {}`,
    ], { ...process.env, PC_HEAVY_COALESCE: '1' });
    expect(code, out).toBe(0);
    expect(readFileSync(marker, 'utf8').trim().split('\n'))
      .toEqual(['baseline=0', 'copy-baseline=0', 'mutant=0']);
    expect(read()).toBe(ORIGINAL);
  });

  it('replays descriptor export settings even when the next caller disables export', () => {
    const args = ['--file', subject, '--mutate', 's/beta/BETA/', '--test', "grep -q '^beta$' {}"];
    const env = { ...process.env,
      PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'always',
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL: 'http://127.0.0.1:3170/api/health',
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO: join(dir, 'reader-é-東京'),
      PAPERCUSP_TEST_RUN_HARNESS: 'papercusp',
      UNRELATED_REPLAY_SECRET: 'must-not-enter-the-receipt',
    };
    const first = runProbeIO(args, env);
    expect(first.code, first.out).toBe(0);
    const record = JSON.parse(first.out.match(/^MUTATION_PROBE_EVIDENCE_JSON=(.+)$/m)![1]!);
    expect(record.environment).toEqual({
      PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'always',
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL: env.PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL,
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO: env.PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO,
      PAPERCUSP_TEST_RUN_HARNESS: 'papercusp',
    });
    const replay = runProbeIO(record.argv, { ...env, PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'never',
      ...record.environment });
    expect(replay.code, replay.out).toBe(0);
    expect(replay.out).toContain('mutation descriptor forced on');
    expect(replay.out).not.toContain('must-not-enter-the-receipt');
    expect(read()).toBe(ORIGINAL);
  });

  it('records effective automatic export when the caller leaves it unset', () => {
    const result = runProbeIO(['--file', subject, '--mutate', 's/beta/BETA/', '--test', "grep -q '^beta$' {}"],
      { ...process.env, PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: undefined,
        PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL: 'http://127.0.0.1:1/api/health' });
    expect(result.code, result.out).toBe(0);
    const record = JSON.parse(result.out.match(/^MUTATION_PROBE_EVIDENCE_JSON=(.+)$/m)![1]!);
    expect(record.environment.PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT).toBe('auto');
    expect(record.environment.PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO).toBe(resolve(__dirname, '../../..'));
  });

  it('preserves UTF-8 guard arguments in the exact replay receipt', () => {
    const unicodeSubject = join(dir, 'subject-é-東京-🧪.txt');
    writeFileSync(unicodeSubject, ORIGINAL);
    const args = [
      '--file', unicodeSubject, '--mutate', 's/beta/BETA/',
      '--test', "printf '%s\\n' 'codex → codex / café / 東京 / 🧪' >/dev/null; grep -q '^beta$' {}",
    ];
    const { code, out } = runProbeIO(args);
    expect(code, out).toBe(0);
    const evidenceLine = out.match(/^MUTATION_PROBE_EVIDENCE_JSON=(.+)$/m)?.[1];
    expect(evidenceLine).toBeTruthy();
    expect(JSON.parse(evidenceLine!).argv).toEqual(args);
    expect(readFileSync(unicodeSubject, 'utf8')).toBe(ORIGINAL);
  });

  it('runs from a frozen source when the launched script is rewritten during baseline', async () => {
    const launched = join(dir, 'mutable-probe.sh');
    const marker = join(dir, 'baseline-started');
    writeFileSync(launched, readFileSync(SCRIPT));
    const env = { ...process.env };
    delete env.MUTATION_PROBE_FROZEN_SOURCE;
    // This fixture launches a copied script outside the repository, so supply
    // the supported explicit sink instead of requiring its source-tree resolver.
    env.PAPERCUSP_TEST_RUNS_DB_URL = 'postgresql://ledger.example:5444/papercusp';
    const guard = `test -f "$MUTATION_PROBE_FROZEN_SOURCE" && bash -n "$MUTATION_PROBE_FROZEN_SOURCE" && if [ "$PAPERCUSP_MUTATION_PHASE" = baseline ]; then touch ${JSON.stringify(marker)}; sleep 1; fi; grep -q '^beta$' {}`;
    const child = spawn('bash', [launched, '--file', subject, '--mutate', 's/beta/BETA/', '--test', guard], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Merged stdout+stderr capture, decoded boundary-safely (WI-6728).
    const output = createTextCollector();
    output.attach(child.stdout);
    output.attach(child.stderr);
    const closed = new Promise<number>((resolve) => child.once('close', (code) => resolve(code ?? -1)));
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(marker) && Date.now() < deadline) await sleep(25);
      expect(existsSync(marker), output.peek()).toBe(true);
      writeFileSync(launched, '#!/usr/bin/env bash\ninvalid shell ) fragment\n');
      const code = await closed;
      expect(code, output.text()).toBe(0);
      expect(output.text()).toMatch(/MUTANT CAUGHT/);
      expect(read()).toBe(ORIGINAL);
    } finally {
      child.kill('SIGTERM');
    }
  });

  it('propagates available legacy scope aliases to canonical test-run variables', () => {
    const env = { ...process.env };
    delete env.PAPERCUSP_TEST_RUN_HARNESS;
    delete env.PAPERCUSP_HARNESS_SLUG;
    delete env.PAPERCUSP_WORKSPACE_ID;
    env.HARNESS_SLUG = 'probe-harness';
    env.PAPERCUSP_WORKSPACE = 'probe-workspace';
    const { code, out } = runProbeIO(
      [
        '--file',
        subject,
        '--mutate',
        's/beta/BETA/',
        '--test',
        'test "$PAPERCUSP_TEST_RUN_HARNESS" = probe-harness && test "$PAPERCUSP_WORKSPACE_ID" = probe-workspace && test -f {} && if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then exit 1; fi',
      ],
      env,
    );
    expect(code).toBe(0);
    expect(out).toMatch(/MUTANT CAUGHT/);
    expect(read()).toBe(ORIGINAL);
  });

  it.each(['PAPERCUSP_WORKSPACE_ID', 'PAPERCUSP_WORKSPACE'] as const)(
    'pins the ledger workspace before an isolated guard rebinds %s',
    (workspaceKey) => {
      const env = { ...process.env };
      delete env.PAPERCUSP_TEST_RUN_WORKSPACE;
      delete env.PAPERCUSP_WORKSPACE_ID;
      delete env.PAPERCUSP_WORKSPACE;
      env[workspaceKey] = 'probe-workspace';
      const { code, out } = runProbeIO([
        '--file', subject, '--mutate', 's/beta/BETA/',
        '--test', [
          'test "$PAPERCUSP_TEST_RUN_WORKSPACE" = probe-workspace || exit 3',
          'PAPERCUSP_WORKSPACE_ID=private-guard-workspace',
          'test "$PAPERCUSP_TEST_RUN_WORKSPACE" = probe-workspace || exit 3',
          'test -f {} || exit 3',
          'if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then exit 1; fi',
        ].join('; '),
      ], env);
      expect(code, out).toBe(0);
      expect(out).toMatch(/MUTANT CAUGHT/);
      expect(read()).toBe(ORIGINAL);
    },
  );

  it('preserves an explicit ledger workspace independently of the product workspace', () => {
    const { code, out } = runProbeIO([
      '--file', subject, '--mutate', 's/beta/BETA/',
      '--test', [
        'test "$PAPERCUSP_WORKSPACE_ID" = product-workspace || exit 3',
        'test "$PAPERCUSP_TEST_RUN_WORKSPACE" = ledger-workspace || exit 3',
        'PAPERCUSP_WORKSPACE_ID=private-guard-workspace',
        'test "$PAPERCUSP_TEST_RUN_WORKSPACE" = ledger-workspace || exit 3',
        'test -f {} || exit 3',
        'if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then exit 1; fi',
      ].join('; '),
    ], {
      ...process.env,
      PAPERCUSP_WORKSPACE_ID: 'product-workspace',
      PAPERCUSP_TEST_RUN_WORKSPACE: 'ledger-workspace',
    });
    expect(code, out).toBe(0);
    expect(out).toMatch(/MUTANT CAUGHT/);
    expect(read()).toBe(ORIGINAL);
  });

  describe('test-run ledger sink routing', () => {
    const resolvedSink = 'postgresql://ledger.example:5444/papercusp';

    it.each([
      ['port', 'unset', '6543', undefined, undefined],
      ['port', 'blank', '6543', undefined, ' \t '],
      ['both', 'unset', '6543', '1', undefined],
      ['both', 'blank', '6543', '1', ' \t '],
    ] as const)('refuses an inferred disposable reporter sink with %s isolation and %s caller value', (_isolation, _label, port, discovery, supplied) => {
      const marker = join(dir, 'guard-ran');
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PROBE_TEST_GUARD_MARKER: marker,
      };
      env.PAPERCUSP_PG_PORT = port;
      if (discovery === undefined) delete env.PAPERCUSP_SKIP_PG_DISCOVERY;
      else env.PAPERCUSP_SKIP_PG_DISCOVERY = discovery;
      delete env.HARNESS_ADMIN_DATABASE_URL;
      if (supplied === undefined) delete env.PAPERCUSP_TEST_RUNS_DB_URL;
      else env.PAPERCUSP_TEST_RUNS_DB_URL = supplied;

      const { code, out } = runProbeIO([
        '--file', subject,
        '--mutate', 's/beta/BETA/',
        '--test', 'touch "$PROBE_TEST_GUARD_MARKER"; grep -q "^beta$" {}',
      ], env);

      expect(code, out).toBe(2);
      expect(out).toContain('verdict=harness-error phase=preflight reason=private-ledger-sink-required');
      expect(out).toContain('PAPERCUSP_TEST_RUNS_DB_URL is required');
      expect(existsSync(marker)).toBe(false);
      expect(read()).toBe(ORIGINAL);
    });

    it.each([
      ['unset', 'enabled', undefined, undefined],
      ['blank', 'enabled', ' \t ', undefined],
      ['unset', 'disabled', undefined, '1'],
      ['blank', 'disabled', ' \t ', '1'],
    ] as const)('resolves the ordinary reporter sink with %s caller value and discovery %s when no private port exists', (_label, _discovery, supplied, discovery) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HARNESS_ADMIN_DATABASE_URL: resolvedSink,
        EXPECTED_TEST_RUNS_DB_URL: resolvedSink,
      };
      delete env.PAPERCUSP_PG_PORT;
      if (discovery === undefined) delete env.PAPERCUSP_SKIP_PG_DISCOVERY;
      else env.PAPERCUSP_SKIP_PG_DISCOVERY = discovery;
      if (supplied === undefined) delete env.PAPERCUSP_TEST_RUNS_DB_URL;
      else env.PAPERCUSP_TEST_RUNS_DB_URL = supplied;
      const { code, out } = runProbeIO([
        '--file', subject,
        '--mutate', 's/beta/BETA/',
        '--test', 'test "$PAPERCUSP_TEST_RUNS_DB_URL" = "$EXPECTED_TEST_RUNS_DB_URL" && grep -q "^beta$" {}',
      ], env);
      expect(code, out).toBe(0);
      expect(out).toContain('verdict=caught');
      expect(read()).toBe(ORIGINAL);
    });

    it('preserves a caller-supplied nonblank reporter sink', () => {
      const explicitSink = 'postgresql://ledger.example:5444/papercusp';
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PAPERCUSP_PG_PORT: '6543',
        PAPERCUSP_SKIP_PG_DISCOVERY: '1',
        PAPERCUSP_TEST_RUNS_DB_URL: explicitSink,
        EXPECTED_TEST_RUNS_DB_URL: explicitSink,
      };
      delete env.HARNESS_ADMIN_DATABASE_URL;

      const { code, out } = runProbeIO([
        '--file', subject,
        '--mutate', 's/beta/BETA/',
        '--test', 'test "$PAPERCUSP_TEST_RUNS_DB_URL" = "$EXPECTED_TEST_RUNS_DB_URL" && grep -q "^beta$" {}',
      ], env);

      expect(code, out).toBe(0);
      expect(out).toContain('verdict=caught');
      expect(read()).toBe(ORIGINAL);
    });
  });

  describe('mutant_ledger: whether the mutant test_runs row exists (WI-10006245)', () => {
    /** A guard that plays the ledger reporter: append receipt lines per phase, then judge the subject. */
    const guardWritingReceipts = (byPhase: Record<string, readonly object[]>) => {
      const writes = Object.entries(byPhase)
        .map(([phase, lines]) => {
          // printf reuses its format for every argument: one JSON line per argument.
          const args = lines.map((line) => `'${JSON.stringify(line).replace(/'/g, "'\\''")}'`).join(' ');
          return `if [ "$PAPERCUSP_MUTATION_PHASE" = ${phase} ]; then printf '%s\\n' ${args} >> "$PAPERCUSP_TEST_RUN_RECEIPT_FILE"; fi`;
        })
        .join('; ');
      return `test -n "$PAPERCUSP_TEST_RUN_RECEIPT_FILE" || exit 3; ${writes}${writes ? '; ' : ''}grep -q '^beta$' {}`;
    };
    const resultOf = (out: string) => {
      const line = out.match(/^MUTATION_PROBE_RESULT .+$/m)?.[0] ?? '';
      const evidence = out.match(/^MUTATION_PROBE_EVIDENCE_JSON=(.+)$/m)?.[1];
      const result = evidence ? JSON.parse(evidence).result : undefined;
      return { line, ledger: result?.mutantLedger, result };
    };

    it('reports a caught mutant whose row never landed as missing, with the reason', () => {
      const { code, out } = runProbeIO([
        '--file', subject, '--mutate', 's/beta/BETA/',
        '--test', guardWritingReceipts({
          mutant: [{ filePath: 'a.test.ts', status: 'fail', outcome: 'failed', reason: 'pg_unavailable' }],
        }),
      ]);
      expect(code, out).toBe(0);
      const { line, ledger } = resultOf(out);
      expect(line).toMatch(/verdict=caught .* mutant_ledger=missing:failed_pg_unavailable$/);
      expect(ledger).toBe('missing:failed_pg_unavailable');
      expect(out).toMatch(/mutant ledger: missing:failed_pg_unavailable/);
      expect(read()).toBe(ORIGINAL);
    });

    it('preserves a lost baseline receipt while preferring the mutant late insert over its earlier timeout', () => {
      const { code, out } = runProbeIO([
        '--file', subject, '--mutate', 's/beta/BETA/',
        '--test', guardWritingReceipts({
          baseline: [{ filePath: 'a.test.ts', status: 'pass', outcome: 'failed', reason: 'pg_unavailable' }],
          mutant: [
            { filePath: 'a.test.ts', status: 'fail', outcome: 'timeout', reason: 'flush_budget_30000ms' },
            { filePath: 'a.test.ts', status: 'fail', outcome: 'inserted', id: '4242' },
          ],
        }),
      ]);
      expect(code, out).toBe(0);
      expect(resultOf(out).line).toMatch(/ mutant_ledger=test_runs:4242$/);
      expect(resultOf(out).ledger).toBe('test_runs:4242');
      expect(resultOf(out).line).toContain('baseline_ledger=missing:failed_pg_unavailable');
      expect(resultOf(out).result.baselineLedger).toBe('missing:failed_pg_unavailable');
      expect(out).toContain('baseline ledger: missing:failed_pg_unavailable');
      expect(out).not.toMatch(/mutant ledger: /);
    });

    it('preserves an unresolved copy baseline separately from the landed original and mutant receipts', () => {
      const { code, out } = runProbeIO([
        '--file', subject, '--mutate', 's/beta/BETA/',
        '--test', guardWritingReceipts({
          baseline: [{ filePath: 'a.test.ts', status: 'pass', outcome: 'inserted', id: '11' }],
          'copy-baseline': [{ filePath: 'a.test.ts', status: 'pass', outcome: 'timeout', reason: 'pg_insert_timeout_15000ms' }],
          mutant: [{ filePath: 'a.test.ts', status: 'fail', outcome: 'inserted', id: '42' }],
        }),
      ]);
      expect(code, out).toBe(0);
      expect(resultOf(out).line).toContain('baseline_ledger=test_runs:11 copy_baseline_ledger=unconfirmed:timeout_pg_insert_timeout_15000ms mutant_ledger=test_runs:42');
      expect(resultOf(out).result).toMatchObject({
        baselineLedger: 'test_runs:11',
        copyBaselineLedger: 'unconfirmed:timeout_pg_insert_timeout_15000ms',
        mutantLedger: 'test_runs:42',
      });
      expect(out).toContain('copy-baseline ledger: unconfirmed:timeout_pg_insert_timeout_15000ms');
      expect(read()).toBe(ORIGINAL);
    });

    it('reports partial when only some mutant rows landed', () => {
      const { out } = runProbeIO([
        '--file', subject, '--mutate', 's/beta/BETA/',
        '--test', guardWritingReceipts({
          mutant: [
            { filePath: 'a.test.ts', status: 'fail', outcome: 'inserted', id: '7' },
            { filePath: 'b.test.ts', status: 'fail', outcome: 'timeout', reason: 'pg_insert_timeout_15000ms' },
          ],
        }),
      ]);
      expect(resultOf(out).ledger).toBe('partial:7;unconfirmed:1:timeout_pg_insert_timeout_15000ms');
    });

    it('reports a timed-out mutant INSERT as unconfirmed and asks for reconciliation before replay', () => {
      const { code, out } = runProbeIO([
        '--file', subject, '--mutate', 's/beta/BETA/',
        '--test', guardWritingReceipts({
          mutant: [{ filePath: 'a.test.ts', status: 'fail', outcome: 'timeout', reason: 'pg_insert_timeout_15000ms' }],
        }),
      ]);
      expect(code, out).toBe(0);
      expect(resultOf(out).ledger).toBe('unconfirmed:timeout_pg_insert_timeout_15000ms');
      expect(out).toContain('A timed-out INSERT may still have landed');
      expect(out).toContain('reconcile the exact run group in the ledger before replaying');
      expect(out).not.toContain('There is no mutant FAIL row');
      expect(read()).toBe(ORIGINAL);
    });

    it('prefers a late rejected INSERT over its earlier timeout', () => {
      const { code, out } = runProbeIO([
        '--file', subject, '--mutate', 's/beta/BETA/',
        '--test', guardWritingReceipts({
          mutant: [
            { filePath: 'a.test.ts', status: 'fail', outcome: 'timeout', reason: 'pg_insert_timeout_15000ms' },
            { filePath: 'a.test.ts', status: 'fail', outcome: 'failed', reason: 'connection_closed' },
          ],
        }),
      ]);
      expect(code, out).toBe(0);
      expect(resultOf(out).ledger).toBe('missing:failed_connection_closed');
      expect(read()).toBe(ORIGINAL);
    });

    it('says none when no ledger writer ran in the guard', () => {
      const { code, out } = runProbeIO([
        '--file', subject, '--mutate', 's/beta/BETA/', '--test', guardWritingReceipts({}),
      ]);
      expect(code, out).toBe(0);
      expect(resultOf(out).line).toMatch(/ mutant_ledger=none$/);
    });

    describe('diagnostic retention (EI-26074153873782928)', () => {
      const retainedPath = (out: string): string => {
        const record = out.match(/^MUTATION_PROBE_DIAGNOSTICS_JSON=(.+)$/m)?.[1];
        expect(record, out).toBeTruthy();
        return JSON.parse(record!).path;
      };
      const diagnosticEnv = () => ({ ...process.env, PAPERCUSP_SCRATCH_ROOT: join(dir, 'diagnostics') });

      it('retains the full failing phase after a harness error and removes its temporary mirror', () => {
        const temporary = join(dir, 'private-pg-tmp');
        mkdirSync(temporary);
        const { code, out } = runProbeIO([
          '--file', subject, '--mutate', 's/beta/BETA/',
          '--test', 'if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then echo assertion-before-receipt-failure; exit 2; fi; grep -q "^beta$" {}',
        ], { ...diagnosticEnv(), TMPDIR: temporary });
        expect(code, out).toBe(2);
        const retained = retainedPath(out);
        expect(readFileSync(join(retained, 'mutant.log'), 'utf8')).toContain('assertion-before-receipt-failure');
        expect(JSON.parse(readFileSync(join(retained, 'diagnostics.json'), 'utf8'))).toMatchObject({
          exitCode: 2, subject, sourceBlob: git(dir, ['hash-object', subject]),
        });
        expect(readdirSync(temporary).filter(name => name.startsWith('mutation-probe.'))).toEqual([]);
        // The enclosing private-PG cleanup must not remove the diagnostic copy.
        rmSync(temporary, { recursive: true, force: true });
        expect(readFileSync(join(retained, 'mutant.log'), 'utf8')).toContain('assertion-before-receipt-failure');
        expect(read()).toBe(ORIGINAL);
      });

      it.each(['baseline', 'copy-baseline', 'mutant'])('retains exact %s receipts despite a successful assertion verdict', (phase) => {
        const receipt = {
          receiptId: 'unresolved-insert', attempt: 0, filePath: 'a.test.ts', status: 'fail',
          outcome: 'timeout', reason: 'pg_insert_timeout_25000ms', row: { runGroupId: 'original-run' },
        };
        const { code, out } = runProbeIO([
          '--file', subject, '--mutate', 's/beta/BETA/',
          '--test', guardWritingReceipts({ [phase]: [receipt] }),
        ], diagnosticEnv());
        expect(code, out).toBe(0);
        const retained = retainedPath(out);
        expect(JSON.parse(readFileSync(join(retained, `test-run-receipts.${phase}.jsonl`), 'utf8'))).toEqual(receipt);
        expect(existsSync(join(retained, `${phase}.log`))).toBe(true);
        expect(resultOf(out).line).toContain('verdict=caught');
        expect(read()).toBe(ORIGINAL);
      });

      it('does not archive a successful probe with complete ledger receipts', () => {
        const { code, out } = runProbeIO([
          '--file', subject, '--mutate', 's/beta/BETA/',
          '--test', guardWritingReceipts(Object.fromEntries(['baseline', 'copy-baseline', 'mutant'].map(phase => [phase, [
            { filePath: 'a.test.ts', outcome: 'inserted', id: phase },
          ]]))),
        ], diagnosticEnv());
        expect(code, out).toBe(0);
        expect(out).not.toContain('MUTATION_PROBE_DIAGNOSTICS_JSON=');
        expect(existsSync(join(dir, 'diagnostics'))).toBe(false);
        expect(read()).toBe(ORIGINAL);
      });

      it('keeps the original logs and receipts when archival itself fails', () => {
        const blockedRoot = join(dir, 'blocked-diagnostics');
        writeFileSync(blockedRoot, 'a file cannot contain the archive directory');
        const temporary = join(dir, 'probe-tmp');
        mkdirSync(temporary);
        const receipt = { filePath: 'a.test.ts', outcome: 'timeout', reason: 'unresolved-insert' };
        const { code, out } = runProbeIO([
          '--file', subject, '--mutate', 's/beta/BETA/',
          '--test', guardWritingReceipts({ mutant: [receipt] }),
        ], { ...process.env, TMPDIR: temporary, PAPERCUSP_SCRATCH_ROOT: blockedRoot });
        expect(code, out).toBe(0);
        expect(out).toContain('diagnostic archival failed; preserving original phase logs and receipts at ');
        const scratch = join(temporary, readdirSync(temporary).find(name => name.startsWith('mutation-probe.'))!);
        expect(existsSync(join(scratch, 'mutant.log'))).toBe(true);
        expect(JSON.parse(readFileSync(join(scratch, 'test-run-receipts.mutant.jsonl'), 'utf8'))).toEqual(receipt);
        expect(read()).toBe(ORIGINAL);
      });
    });
  });

  it('does not invent scope for an explicitly unscoped caller', () => {
    const env = { ...process.env };
    for (const key of [
      'PAPERCUSP_TEST_RUN_HARNESS',
      'HARNESS_SLUG',
      'PAPERCUSP_HARNESS_SLUG',
      'PAPERCUSP_TEST_RUN_WORKSPACE',
      'PAPERCUSP_WORKSPACE_ID',
      'PAPERCUSP_WORKSPACE',
    ] as const) {
      delete env[key];
    }
    const { code, out } = runProbeIO(
      [
        '--file',
        subject,
        '--mutate',
        's/beta/BETA/',
        '--test',
        'test -z "${PAPERCUSP_TEST_RUN_HARNESS:-}" && test -z "${PAPERCUSP_TEST_RUN_WORKSPACE:-}" && test -z "${PAPERCUSP_WORKSPACE_ID:-}" && test -f {} && if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then exit 1; fi',
      ],
      env,
    );
    expect(code).toBe(0);
    expect(out).toMatch(/MUTANT CAUGHT/);
    expect(read()).toBe(ORIGINAL);
  });

  describe('scratch failure classification (EI-25433151376112553)', () => {
    it.skipIf(!existsSync('/dev/full'))('reports an unmeasured digest as a harness error when its scratch write gets ENOSPC', () => {
      const scratchRoot = join(dir, 'scratch');
      mkdirSync(scratchRoot);
      const { code, out } = runProbeIO([
        '--file', subject, '--mutate', 's/beta/BETA/', '--relocation', 'mirror',
        '--test', 'for probe in "$PROBE_TEST_SCRATCH_ROOT"/mutation-probe.*; do ln -sf /dev/full "$probe/current.sha"; done; grep -q "^beta$" {}',
      ], { ...process.env, TMPDIR: scratchRoot, PROBE_TEST_SCRATCH_ROOT: scratchRoot });
      expect(code, out).toBe(2);
      expect(out).toContain('status=integrity-unverified');
      expect(out).not.toContain('external-change-preserved');
      expect(out).not.toContain('current_sha=MISSING');
      expect(out.lastIndexOf('verdict=harness-error')).toBeGreaterThan(out.lastIndexOf('verdict=caught'));
      expect(read()).toBe(ORIGINAL);
    });

    it('reports a failed hash command without inventing an external source change', () => {
      const bin = join(dir, 'bin');
      const marker = join(dir, 'guard-ran');
      const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
      mkdirSync(bin);
      writeFileSync(join(bin, 'git'), `#!/usr/bin/env bash
if [ "$1" = hash-object ] && [ -f "$PROBE_TEST_GUARD_MARKER" ]; then
  printf 'fatal: source digest unavailable\\n' >&2
  exit 128
fi
exec "$PROBE_TEST_REAL_GIT" "$@"
`, { mode: 0o755 });
      const { code, out } = runProbeIO([
        '--file', subject, '--mutate', 's/beta/BETA/', '--relocation', 'mirror',
        '--test', 'touch "$PROBE_TEST_GUARD_MARKER"; grep -q "^beta$" {}',
      ], { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROBE_TEST_REAL_GIT: realGit, PROBE_TEST_GUARD_MARKER: marker });
      expect(code, out).toBe(2);
      expect(out).toContain('status=integrity-unverified');
      expect(out).not.toContain('external-change-preserved');
      expect(read()).toBe(ORIGINAL);
    });

    it('checks the independent fs-mutex root before starting a managed guard', () => {
      const bin = join(dir, 'bin');
      const marker = join(dir, 'guard-ran');
      const badLockRoot = join(dir, 'not-a-directory');
      mkdirSync(bin);
      writeFileSync(badLockRoot, 'occupied');
      writeFileSync(join(bin, 'npm'), '#!/usr/bin/env bash\ntouch "$PROBE_TEST_GUARD_MARKER"\ngrep -q "^beta$" "$1"\n', { mode: 0o755 });
      const { code, out } = runProbeIO([
        '--file', subject, '--mutate', 's/beta/BETA/', '--relocation', 'mirror', '--test', 'npm {}',
      ], { ...process.env, PATH: `${bin}:${process.env.PATH}`, PAPERCUSP_FS_MUTEX_LOCK_DIR: badLockRoot, PAPERCUSP_DISABLE_FS_MUTEX: '0', PROBE_TEST_GUARD_MARKER: marker });
      expect(code, out).toBe(2);
      expect(out).toContain('phase=preflight reason=scratch-unavailable root=fs-mutex');
      expect(existsSync(marker)).toBe(false);
      expect(read()).toBe(ORIGINAL);
    });
  });

  it('leaves the subject file byte-identical while still exercising the guard', () => {
    const code = runProbe(['--file', subject, '--mutate', 's/beta/BETA/', '--test', 'grep -q "^beta$" {}']);
    // The guard fails on the mutant => the mutant was CAUGHT => probe exits 0.
    expect(code).toBe(0);
    expect(read()).toBe(ORIGINAL);
  });

  it('preserves a source edit made during copy-out and reports the measured snapshot', () => {
    // The edit comes from a real OUT-OF-PROCESS peer, never from the guard command. Under the
    // overlay relocation (EI-24799401310241778) the guard runs in a private mount namespace in
    // which the subject's own path IS the scratch mutant, so a write from inside the guard lands
    // in the mutant and never reaches the tree (pinned by the overlay containment test below).
    // A peer outside the probe writes the host file, which is the edit that must be preserved
    // under every relocation. The guard holds the mutant phase open until the peer has written.
    const sourceSha = spawnSync('git', ['hash-object', subject], { encoding: 'utf8' }).stdout?.trim();
    const started = join(dir, 'mutant-phase-started');
    const edited = join(dir, 'peer-edit-written');
    const peer = spawn(
      'bash',
      [
        '-c',
        'for i in $(seq 1 200); do [ -f "$1" ] && break; sleep 0.05; done; [ -f "$1" ] && printf "peer-edit\\n" > "$2"; touch "$3"',
        '_', started, subject, edited,
      ],
      { stdio: 'ignore' },
    );
    const testCommand = `if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then touch ${JSON.stringify(started)}; for i in $(seq 1 200); do [ -f ${JSON.stringify(edited)} ] && break; sleep 0.05; done; fi; grep -q "^beta$" {}`;

    let result: { code: number; out: string };
    try {
      result = runProbeIO(['--file', subject, '--mutate', 's/beta/BETA/', '--test', testCommand]);
    } finally {
      peer.kill('SIGKILL');
    }
    const currentSha = spawnSync('git', ['hash-object', subject], { encoding: 'utf8' }).stdout?.trim();

    expect(result.code).toBe(0);
    expect(read()).toBe('peer-edit\n');
    expect(result.out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(sourceSha).toMatch(/^[0-9a-f]{40,64}$/);
    expect(currentSha).toMatch(/^[0-9a-f]{40,64}$/);
    expect(result.out).toContain(`MUTATION_PROBE_TREE_RESULT status=external-change-preserved target=copy-out source_sha=${sourceSha} current_sha=${currentSha}`);
    expect(result.out).not.toContain('TREE INTEGRITY FAILURE');
    expect(result.out).not.toContain('Restore it NOW:');
  });

  it('runs concurrent copy-out probes on ONE subject with no cross-talk (P-011: probes run in parallel)', async () => {
    // P-011 / P-018 (review-system-rework-reduction-2026-09-23): re-proving a BAR took ~1 min
    // per mutation probe because probes were run one after another in the shared tree. Copy-out
    // mode gives each probe a private mkdtemp scratch copy, so N probes can run at once. This pins
    // that property: overlapping probes on the SAME subject each reach their OWN verdict (a shared
    // scratch path or copy would hand one probe another's mutant) and the subject stays untouched.
    const probe = (mutate: string) =>
      new Promise<number>((resolveExit) => {
        // The sleep makes the guard runs overlap in time, which is the only way a shared-state
        // defect could show up; without it the probes could finish one after another.
        const child = spawn('bash', [SCRIPT, '--file', subject, '--mutate', mutate, '--test', 'sleep 0.4; grep -q "^beta$" {}'], {
          stdio: 'ignore',
        });
        child.on('close', (code) => resolveExit(code ?? -1));
      });
    // Interleaved verdicts: if any probe read another's scratch copy, a survivor would be
    // scored caught (or the reverse) and this array would not match.
    const codes = await Promise.all([
      probe('s/beta/BETA/'), // caught
      probe('s/gamma/GAMMA/'), // survives
      probe('s/^beta$/b3ta/'), // caught
      probe('s/alpha/ALPHA/'), // survives
    ]);
    expect(codes).toEqual([0, 1, 0, 1]);
    expect(read()).toBe(ORIGINAL);
  }, 60_000);

  it('reports a WEAK guard (exit 1) when the mutant survives, rather than passing quietly', () => {
    // The guard only checks "beta", so mutating "gamma" must slip past it.
    const code = runProbe(['--file', subject, '--mutate', 's/gamma/GAMMA/', '--test', 'grep -q "^beta$" {}']);
    expect(code).toBe(1);
    expect(read()).toBe(ORIGINAL);
  });

  it('refuses a false survived verdict when a symlinked test resolves to the original module', () => {
    const repo = join(dir, 'symlink-test-repo');
    mkdirSync(repo);
    git(repo, ['init', '-q']);
    const modulePath = join(repo, 'subject.cjs');
    writeFileSync(modulePath, 'module.exports = 1;\n');
    writeFileSync(join(repo, 'guard.cjs'), "if (require('./subject.cjs') !== 1) process.exit(1);\n");
    // The mirror symlinks guard.cjs to the real tree. Node (like Vite) resolves
    // that symlink before loading its relative import, bypassing the mutant.
    // Pinned to the mirror: that is the relocation this control guards. The
    // overlay has no such route (see the EI-24799401310241778 block below).
    const { code, out } = runProbeIO([
      '--file', modulePath,
      '--relocation', 'mirror',
      '--mutate', 's/module.exports = 1;/module.exports = 2;/',
      '--test', 'node "$(dirname {})/guard.cjs"',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/verdict=harness-error/);
    expect(out).toMatch(/mutated module.*not loaded|target.*not loaded/i);
    expect(out).not.toMatch(/verdict=survived/);
    expect(readFileSync(modulePath, 'utf8')).toBe('module.exports = 1;\n');
  });

  it('allows an actual surviving module mutant after proving the mirrored module loads', () => {
    const repo = join(dir, 'loaded-module-repo');
    mkdirSync(repo);
    git(repo, ['init', '-q']);
    const modulePath = join(repo, 'subject.cjs');
    writeFileSync(modulePath, 'module.exports = 1;\n');
    // This guard exercises the actual {} module, but only asserts that it
    // exports a number; the semantic mutation legitimately survives.
    const { code, out } = runProbeIO([
      '--file', modulePath,
      '--mutate', 's/module.exports = 1;/module.exports = 2;/',
      '--test', 'node -e "if (typeof require(process.argv[1]) !== \'number\') process.exit(1)" {}',
      '--expect', 'survived',
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/verdict=survived/);
    expect(readFileSync(modulePath, 'utf8')).toBe('module.exports = 1;\n');
  });

  it('reports a baseline harness failure as an error, never as a caught mutant', () => {
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      "bash -c 'exit 2' {}",
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/BASELINE FAILED/i);
    expect(out).toMatch(/verdict=harness-error/);
    expect(out).not.toMatch(/MUTANT CAUGHT/);
    expect(read()).toBe(ORIGINAL);
  });

  it('reports a mutant harness crash as an error, not as falsifiability evidence', () => {
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      "bash -c 'if [ \"$PAPERCUSP_MUTATION_PHASE\" = mutant ]; then exit 2; fi' _ {}",
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/HARNESS ERROR/i);
    expect(out).toMatch(/verdict=harness-error/);
    expect(out).not.toMatch(/MUTANT CAUGHT/);
    expect(read()).toBe(ORIGINAL);
  });

  it('marks every supervised guard phase (baseline, copy-baseline, mutant) so deliberate results stay out of health evidence', () => {
    const markerLog = join(dir, 'marker.log');
    const { code } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      `printf '%s=%s\\n' "$PAPERCUSP_MUTATION_PHASE" "$PAPERCUSP_MUTATION_PROBE" >> "${markerLog}"; if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then exit 1; fi; test -f {}`,
    ]);
    expect(code).toBe(0);
    expect(readFileSync(markerLog, 'utf8').trim().split('\n').sort()).toEqual([
      'baseline=1',
      'copy-baseline=1',
      'mutant=1',
    ]);
    expect(read()).toBe(ORIGINAL);
  });

  it('retries ONCE on a transient pc-heavy after-ready-marker EEXIST, then still reaches a genuine verdict (EI-22133917471532652)', () => {
    // Simulates the observed harness noise: a --test wrapping `npm run
    // test:file` can rarely fail with TEST_FILE_ROUTE_ERROR (EEXIST on the
    // pc-heavy after-ready marker) before a single test runs, because pc-heavy
    // allocates that marker with a fresh `mktemp` path per invocation and a
    // rare clash on the shared /tmp marker directory is harness noise, not a
    // test result. A fresh invocation gets a brand-new random marker path, so
    // the probe's own bounded retry should absorb exactly one such failure per
    // guard phase (baseline, copy-baseline, mutant) and still reach the
    // correct MUTANT CAUGHT verdict — never mis-scoring it as a harness error.
    const attemptDir = join(dir, 'attempts');
    mkdirSync(attemptDir);
    const cmd = [
      `f="${attemptDir}/$PAPERCUSP_MUTATION_PHASE"`,
      `n=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 ))`,
      `echo "$n" > "$f"`,
      `if [ "$n" -eq 1 ]; then echo "TEST_FILE_ROUTE_ERROR refusing execution phase: could not publish the pc-heavy after-ready marker: EEXIST: file already exists, open '/tmp/pc-heavy-ready/ready.FAKE01'" >&2; exit 75; fi`,
      `grep -q "^beta$" {}`,
    ].join('; ');
    const { code, out } = runProbeIO(['--file', subject, '--mutate', 's/beta/BETA/', '--test', cmd]);
    expect(code).toBe(0);
    expect(out).toMatch(/retrying once with a fresh marker path/);
    expect(out).not.toMatch(/verdict=harness-error/);
    expect(read()).toBe(ORIGINAL);
  });

  it('REFUSES a mutation that changed nothing (exit 2) instead of reporting a false weakness', () => {
    // A no-op mutation is the quiet killer of this technique: the "mutant" is
    // identical to the original, so any guard passes and the probe would
    // otherwise report "your guard did not catch it" — a false verdict from a
    // probe that never mutated anything.
    const code = runProbe(['--file', subject, '--mutate', 's/nosuchtext/x/', '--test', 'grep -q "^beta$" {}']);
    expect(code).toBe(2);
    expect(read()).toBe(ORIGINAL);
  });

  it('REFUSES a whitespace-only mutation before any guard runs', () => {
    const phases = join(dir, 'phases.log');
    const { code, out } = runProbeIO([
      '--file',
      subject,
      // This applies, but only adds indentation; the non-whitespace content
      // is identical and the subject's behavior is unchanged.
      '--mutate',
      's/^/ /',
      '--test',
      `printf '%s\\n' "$PAPERCUSP_MUTATION_PHASE" >> "${phases}"; grep -q beta {}`,
    ]);
    expect(code).toBe(2);
    expect(out).not.toContain('running baseline guard');
    expect(out).toMatch(/ONLY WHITESPACE/i);
    // Semantic-no-op validation needs no guard or relocation evidence.
    expect(existsSync(phases)).toBe(false);
    expect(read()).toBe(ORIGINAL);
  });

  it('explains the PERL-metacharacter cause when an unescaped source mutation matches nothing', () => {
    // EI-19460105590596381. --mutate is applied with `perl -pi -e`, so on the PATTERN side
    // ( ) { } are regex metacharacters. That bites hardest on this script's normal use —
    // mutating source code — because the natural mutation of a conditional reads as correct
    // and matches NOTHING: `if (x > 0) {` parses as a capture group plus a quantifier, so it
    // searches for `if x > 0 ` and misses. The refusal was already correct (exit 2, never a
    // false weakness verdict), but it named only the symptom, leaving the reader to guess at
    // their own pattern rather than at their metacharacters.
    writeFileSync(subject, 'if (x > 0) {\n');
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's|if (x > 0) {|if (false) {|',
      '--test',
      'test -s {}',
    ]);
    expect(code).toBe(2);
    // The cause, not just "changed NOTHING".
    expect(out).toMatch(/PERL/i);
    // And the fix, spelled out — the escaped pattern form.
    expect(out).toContain('\\(x > 0\\)');
    expect(read()).toBe('if (x > 0) {\n');
  });

  it('the ESCAPED form of that same mutation does apply — so the guidance is correct, not folklore', () => {
    // Calibration for the test above: without this, "unescaped matches nothing" could equally
    // mean the probe is broken for this subject entirely, and the advice would be untested.
    writeFileSync(subject, 'if (x > 0) {\n');
    // The guard asserts the ORIGINAL line is present. If the mutation applied, that line is
    // gone, the guard FAILS on the mutant, and the probe reports CAUGHT (exit 0). Reaching
    // exit 0 here is therefore proof the escaped pattern matched — the exact thing the
    // unescaped form above failed to do.
    const code = runProbe([
      '--file',
      subject,
      '--mutate',
      's|if \\(x > 0\\) \\{|if (false) {|',
      '--test',
      'grep -q "^if (x > 0) {$" {}',
    ]);
    expect(code).toBe(0);
    expect(read()).toBe('if (x > 0) {\n');
  });

  it('refuses a --test with no {} placeholder, so the probe cannot silently target the wrong file', () => {
    const code = runProbe(['--file', subject, '--mutate', 's/beta/BETA/', '--test', 'true']);
    expect(code).toBe(2);
  });

  /**
   * EI-25654051948437355 — a Playwright CLI --reporter replaces the configured
   * reporters, including the test_runs ledger reporter, so the probe printed a
   * verdict but `mutant_ledger=none` and left no row to bind. Refuse up front.
   */
  it.each([
    ['equals form', 'npx playwright test --reporter=list {}'],
    ['space form', 'npx playwright test {} --reporter list'],
  ])('refuses a Playwright --test that overrides reporters (%s) before any guard runs', (_label, cmd) => {
    const { code, out } = runProbeIO(['--file', subject, '--mutate', 's/beta/BETA/', '--test', cmd]);
    expect(code, out).toBe(2);
    expect(out).toContain('test_runs ledger reporter');
    expect(out).not.toContain('running baseline guard');
    expect(read()).toBe(ORIGINAL);
  });

  it('lets an explicit MUTATION_PROBE_ALLOW_REPORTER_OVERRIDE=1 through to a genuine verdict (calibration)', () => {
    const { code, out } = runProbeIO(
      ['--file', subject, '--mutate', 's/beta/BETA/', '--test', 'true playwright --reporter=list; grep -q "^beta$" {}'],
      { ...process.env, MUTATION_PROBE_ALLOW_REPORTER_OVERRIDE: '1' },
    );
    expect(code, out).toBe(0);
    expect(read()).toBe(ORIGINAL);
  });

  /**
   * EI-21882388979504012 — a test runner that cannot COLLECT its subject exits
   * nonzero for MISUSE (vitest's "No test files found, exiting with code 1" is
   * the reproduced case: copy-out mode moves the mutant under a scratch dir a
   * project's include globs cannot reach), and that nonzero was previously
   * indistinguishable by exit code alone from a genuine assertion failure —
   * the probe scored it "MUTANT CAUGHT" while nothing was ever tested.
   */
  it('reports a RUNNER-MISUSE guard exit (e.g. "no test files found") as harness-error, never as a caught mutant', () => {
    // Baseline (PAPERCUSP_MUTATION_PHASE=baseline) runs against the ORIGINAL
    // file path directly (not {}), so the genuine grep succeeds there. Only
    // the mutant phase hits the simulated runner-misuse branch — this is the
    // exact shape of a runner that can collect the tracked path but not the
    // scratch-dir copy.
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      'if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then echo "No test files found, exiting with code 1"; exit 1; fi; grep -q "^beta$" {}',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/RUNNER-MISUSE/i);
    expect(out).toMatch(/No test files found/);
    expect(out).toMatch(/verdict=harness-error/);
    // The MUTATION_PROBE_RESULT line joins multi-token hits with commas
    // (spaces would break its key=value parsing).
    expect(out).toMatch(/runner_misuse=No,test,files,found/);
    expect(out).not.toMatch(/MUTANT CAUGHT/);
    expect(read()).toBe(ORIGINAL);
  });

  // WI-10006604 — `npm run test:file` blocks on npm-install-safe's fs-mutex while a peer
  // installs; on timeout it exits 1 having run ZERO tests. That exit was scored as a catch.
  it('reports an npm-install-safe mutex timeout in the mutant phase as harness-error, never as a caught mutant', () => {
    // Built from parts so the contiguous marker never appears in THIS source: vitest's failure
    // code-frame prints these lines, and a probe of mutation-probe.sh would otherwise read its
    // own guard's code-frame as runner misuse (a self-match that hides a real catch).
    const marker = ['NPM_INSTALL_SAFE', 'ERROR'].join('_');
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      `if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then echo "${marker} Timed out after 180000ms waiting for fs-mutex writer"; exit 1; fi; grep -q "^beta$" {}`,
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/verdict=harness-error/);
    expect(out).toContain(`runner_misuse=${marker}`);
    expect(out).not.toMatch(/MUTANT CAUGHT/);
    expect(read()).toBe(ORIGINAL);
  });

  it('calibration: a GENUINE mutant-phase assertion failure (no misuse marker in the output) is still scored CAUGHT', () => {
    // Same shape as the misuse test above but the mutant branch fails via a
    // real assertion, not a misuse string — proving the new detector does not
    // over-trigger and swallow a legitimate catch.
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      'if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then grep -q "^beta$" {}; else true; fi',
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/MUTANT CAUGHT/);
    expect(out).not.toMatch(/RUNNER-MISUSE/i);
  });
});

/**
 * EI-21884666893062196 (2026-08-30) — copy-out mode relocates ONLY the named
 * `--file`, never its sibling directory. A subject that imports a relative
 * sibling (the `./lib/...` house pattern under scripts/*.mjs) is broken by
 * that relocation alone: it dies on ERR_MODULE_NOT_FOUND before the guard
 * runs a single assertion. That failure is exit 1 — the SAME code the mutant
 * phase reads as "caught" — so a broken relocation used to silently report
 * "the guard is falsifiable" without the guard ever having run. These pin the
 * fix from both sides: the refusal fires (before any mutation is applied),
 * and a relocation-safe subject (one whose --test command carries its own
 * sibling along, exactly as the incident's caller-side workaround did) still
 * reaches a genuine verdict.
 */
describe('mutation-probe.sh — copy-out relocation is proven sound before scoring the mutant', () => {
  it('REFUSES (exit 2, harness-error) when the guard fails against an UNMUTATED relocated copy — never a false MUTANT CAUGHT', () => {
    const relocSubject = join(dir, 'reloc-subject.mjs');
    mkdirSync(join(dir, 'lib'));
    writeFileSync(join(dir, 'lib', 'helper.mjs'), 'export const helperValue = 1;\n');
    const ORIGINAL_RELOC = "import { helperValue } from './lib/helper.mjs';\nexport const value = helperValue;\n";
    writeFileSync(relocSubject, ORIGINAL_RELOC);

    const { code, out } = runProbeIO([
      '--file',
      relocSubject,
      // Flat relocation is the subject here; the overlay never relocates.
      '--relocation', 'mirror',
      // Any non-no-op mutation: copy-baseline runs BEFORE this is applied, so
      // the exact mutation text is irrelevant to what this test proves — the
      // refusal must fire before the mutant guard, let alone the mutation
      // itself, is ever reached.
      '--mutate',
      's/helperValue;/helperValue; \\/\\/ mutated/',
      '--test',
      // The guard REPORTS the module error rather than swallowing it. Until
      // 2026-08-31 this read `.catch(()=>process.exit(1))`, which prints
      // nothing (measured: 0 bytes, exit 1) — so the ERR_MODULE_NOT_FOUND
      // assertion below was matching the probe SCRIPT's own refusal prose,
      // where the literal appeared twice, while its comment claimed the text
      // came from Node. That made it a wording pin dressed as evidence: it
      // broke the moment the refusal was reworded, and would have passed on a
      // probe that captured nothing at all.
      'node -e "import(process.argv[1]).then(()=>process.exit(0)).catch((e)=>{console.error(e.code||e.message);process.exit(1)})" {}',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/COPY-BASELINE FAILED/i);
    expect(out).toMatch(/RELOCATION/i);
    expect(out).toMatch(/verdict=harness-error/);
    expect(out).toMatch(/copy_baseline_exit=1/);
    expect(out).not.toMatch(/MUTANT CAUGHT/);
    // The mutant guard never even ran — the subject is untouched, and this
    // ERR_MODULE_NOT_FOUND is Node's, echoed by run_guard's `cat "$output"`.
    expect(out).toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
    expect(readFileSync(relocSubject, 'utf8')).toBe(ORIGINAL_RELOC);
  });

  it('still reaches a genuine CAUGHT verdict when --test carries the sibling along (the sanctioned workaround)', () => {
    // Calibration for the refusal above: a --test command that makes the
    // relocated copy self-sufficient (mirroring the incident's caller-side
    // symlink workaround) must sail through copy-baseline and reach a real
    // mutant verdict — proving the new check does not merely refuse
    // everything, only genuinely-broken relocations.
    const relocSubject = join(dir, 'reloc-subject-ok.mjs');
    mkdirSync(join(dir, 'lib'));
    writeFileSync(join(dir, 'lib', 'helper.mjs'), 'export const helperValue = 1;\n');
    writeFileSync(relocSubject, "import { helperValue } from './lib/helper.mjs';\nexport const value = helperValue;\n");
    const wrapper = join(dir, 'import-with-sidecar.mjs');
    writeFileSync(
      wrapper,
      [
        "import { existsSync, symlinkSync } from 'node:fs';",
        "import { dirname, join } from 'node:path';",
        'const target = process.argv[2];',
        "const sidecar = join(dirname(target), 'lib');",
        `if (!existsSync(sidecar)) symlinkSync(${JSON.stringify(join(dir, 'lib'))}, sidecar, 'dir');`,
        'const mod = await import(target);',
        'process.exit(mod.value === 1 ? 0 : 1);',
      ].join('\n'),
    );

    const code = runProbe([
      '--file',
      relocSubject,
      // Flat relocation is the subject here; the overlay never relocates.
      '--relocation', 'mirror',
      '--mutate',
      's/helperValue;/helperValue + 1;/',
      '--test',
      `node ${JSON.stringify(wrapper)} {}`,
    ]);
    // Baseline (value===1, exit 0) and copy-baseline (same, via the sidecar
    // symlink) both pass; the mutation then makes value===2, the guard's
    // `mod.value === 1` check fails => exit 1 => the mutant is CAUGHT => the
    // probe itself exits 0.
    expect(code).toBe(0);
  });
});

/**
 * EI-21986396214443568 — copy-out must relocate into a MIRROR of the subject's
 * worktree, not into a flat scratch dir.
 *
 * The flat relocation broke TWO couplings and the refusal text only ever named
 * one. Sibling imports (`./lib/foo.mjs`) were named; LOCATIONAL IDENTITY — a
 * subject that derives the repo root from its own path, the shape
 * scripts/affected-tests.mjs uses — was not. Measured 2026-08-31: doing exactly
 * what the refusal prescribed (carry the sibling directory alongside the copy)
 * left an UNMUTATED copy failing 13 of 23 tests, i.e. a large failure count
 * that reads as a spectacularly falsifiable guard. That is a false verdict in
 * the dangerous direction, produced by following the tool's own advice.
 *
 * The fixture below couples to its location BOTH ways at once, so neither half
 * of the repair can pass this on its own:
 *   - it imports `./lib/sib.mjs` (siblings), and
 *   - it reads a repo-root marker via `resolve(__dirname, '../..')` (location).
 */
function makeLocationalRepo(): { repo: string; subject: string } {
  const repo = join(dir, 'locational-repo');
  mkdirSync(join(repo, 'pkg', 'tools', 'lib'), { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'mutation-probe-test@example.invalid']);
  git(repo, ['config', 'user.name', 'mutation-probe-test']);
  writeFileSync(join(repo, 'ROOT-MARKER.txt'), 'ROOT-MARKER\n');
  writeFileSync(join(repo, 'pkg', 'tools', 'lib', 'sib.mjs'), "export const SIB = 'SIB';\n");
  const subject = join(repo, 'pkg', 'tools', 'subject.mjs');
  writeFileSync(
    subject,
    [
      "import { readFileSync } from 'node:fs';",
      "import { fileURLToPath } from 'node:url';",
      "import { dirname, resolve } from 'node:path';",
      "import { SIB } from './lib/sib.mjs';",
      '',
      'const here = dirname(fileURLToPath(import.meta.url));',
      "const marker = readFileSync(resolve(here, '../..', 'ROOT-MARKER.txt'), 'utf8').trim();",
      "const VERDICT = 'OK';",
      'console.log(`${VERDICT} sib=${SIB} root=${marker}`);',
      '',
    ].join('\n'),
  );
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'locational subject']);
  return { repo, subject };
}

describe('mutation-probe.sh — copy-out relocates into a mirror of the subject worktree', () => {
  it('keeps hoisted superproject dependencies for a subject inside a real submodule', () => {
    const { repo: origin } = makeLocationalRepo();
    const superproject = join(dir, 'superproject');
    mkdirSync(superproject);
    git(superproject, ['init', '-q']);
    git(superproject, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', origin, 'modules/child']);
    const dependency = join(superproject, 'node_modules', 'probe-hoisted');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({
      name: 'probe-hoisted', type: 'module', exports: './index.mjs',
    }));
    writeFileSync(join(dependency, 'index.mjs'), "export const HOISTED = 'HOISTED';\n");
    const file = join(superproject, 'modules/child/pkg/tools/subject.mjs');
    const original = readFileSync(file, 'utf8');
    const withDependency = "import { HOISTED } from 'probe-hoisted';\n" + original +
      "console.log(HOISTED);\n";
    writeFileSync(file, withDependency);
    expect(git(join(superproject, 'modules/child'), ['rev-parse', '--show-superproject-working-tree']))
      .toBe(superproject);
    const { code, out } = runProbeIO([
      '--file', file,
      '--relocation', 'mirror',
      '--mutate', "s/const VERDICT = 'OK'/const VERDICT = 'MUTATED'/",
      '--test', "node {} | grep -qx 'OK sib=SIB root=ROOT-MARKER'",
    ]);
    expect(out).not.toMatch(/COPY-BASELINE FAILED/);
    expect(out).toMatch(/verdict=caught/);
    expect(code).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(withDependency);
  });

  it('reaches a genuine CAUGHT verdict for a subject coupled to BOTH its siblings and its repo-root location', () => {
    const { subject } = makeLocationalRepo();
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--relocation', 'mirror',
      '--mutate',
      "s/const VERDICT = 'OK'/const VERDICT = 'MUTATED'/",
      '--test',
      "node {} | grep -qx 'OK sib=SIB root=ROOT-MARKER'",
    ]);
    // Both relocation-sensitive phases had to survive before a verdict was
    // reachable at all: the in-tree baseline AND the unmutated relocated copy.
    // A flat relocation dies in copy-baseline (ERR_MODULE_NOT_FOUND) and this
    // is exit 2 / harness-error instead.
    expect(out).toMatch(/relocating into a repo mirror/);
    expect(out).not.toMatch(/COPY-BASELINE FAILED/);
    expect(out).toMatch(/verdict=caught/);
    expect(code).toBe(0);
  });

  it('WI-10004898: names the ORIGIN checkout to every copy-out guard so its test_runs rows can be measured against it', () => {
    // The mirror has no .git, so the test_runs reporter cannot prove a mirror run
    // clean from the mirror. It snapshots PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT
    // instead; every phase, mutant included, must receive the origin's git root.
    const { repo, subject } = makeLocationalRepo();
    const log = join(dir, 'origin-root.log');
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--relocation', 'mirror',
      '--mutate',
      "s/const VERDICT = 'OK'/const VERDICT = 'MUTATED'/",
      '--test',
      `printf '%s=%s\\n' "$PAPERCUSP_MUTATION_PHASE" "\${PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT:-unset}" >> ${JSON.stringify(log)}; node {} | grep -qx 'OK sib=SIB root=ROOT-MARKER'`,
    ]);
    expect(out).toMatch(/verdict=caught/);
    expect(code).toBe(0);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    const phases = new Map(lines.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    expect(phases.get('mutant')).toBe(realpathSync(repo));
    for (const line of lines) expect(line.endsWith('=unset')).toBe(false);
  });

  it('mirrors the worktree WITHOUT .git, so a git-consulting subject fails loudly instead of reading a wholly dirty tree', () => {
    // A symlinked .git would make every tracked path look to Git like a
    // symlink where a blob belongs — the mirror would report the entire repo
    // as modified. That is a silent wrong answer, which is exactly the class
    // this whole relocation fix exists to remove, so .git is left out and the
    // copy-baseline gate turns it into a refusal.
    const { repo } = makeLocationalRepo();
    const gitSubject = join(repo, 'pkg', 'tools', 'git-subject.sh');
    writeFileSync(
      gitSubject,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        // Fails outright outside a worktree — the point is that the mirror
        // makes this LOUD, not that it answers wrongly.
        'root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"',
        '[ -n "$root" ] || exit 1',
        'echo MARK',
        '',
      ].join('\n'),
    );
    const { code, out } = runProbeIO([
      '--file',
      gitSubject,
      '--relocation', 'mirror',
      '--mutate',
      's/echo MARK/echo MUTATED/',
      '--test',
      'bash {} >/dev/null 2>&1',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/COPY-BASELINE FAILED/);
    // The refusal must now say WHY, naming the deliberate .git exclusion —
    // the old text only ever named sibling imports and prescribed a repair
    // that cannot fix this case.
    expect(out).toMatch(/\.git.*not mirrored|not mirrored.*\.git/is);
    expect(out).not.toMatch(/MUTANT CAUGHT/);
  });

  it('still relocates FLAT (and still refuses a broken relocation) when the subject is not inside a worktree', () => {
    // Calibration in the other direction: the mirror is keyed off
    // `git rev-parse --show-toplevel`, so a subject outside any worktree keeps
    // the original flat behaviour rather than silently mirroring something
    // else. `dir` is a bare mkdtemp, deliberately not a repo.
    const orphan = join(dir, 'orphan-subject.mjs');
    mkdirSync(join(dir, 'orphan-lib'));
    writeFileSync(join(dir, 'orphan-lib', 'helper.mjs'), 'export const v = 1;\n');
    writeFileSync(orphan, "import { v } from './orphan-lib/helper.mjs';\nexport const value = v;\n");
    const { code, out } = runProbeIO([
      '--file',
      orphan,
      '--relocation', 'mirror',
      '--mutate',
      's/export const value = v;/export const value = v + 1;/',
      '--test',
      'node -e "import(process.argv[1]).then(()=>process.exit(0)).catch(()=>process.exit(1))" {}',
    ]);
    expect(out).not.toMatch(/relocating into a repo mirror/);
    expect(out).toMatch(/COPY-BASELINE FAILED/);
    expect(code).toBe(2);
  });
});

/**
 * EI-24799401310241778 (measured 2026-10-01): the mirror symlinks every sibling
 * back to the origin, and Node/Vite REALPATH a module before resolving its
 * relative imports. A test that imports {} directly (so the module-load control
 * passes) but asserts through a SIBLING that imports `./subject` therefore
 * exercises the ORIGINAL: a false SURVIVED. Measured on credential-store.ts via
 * request-kernel.ts: copy-out SURVIVED, in-tree CAUGHT.
 *
 * The overlay binds the mutant over the subject's own path inside a private
 * mount namespace, so every route reaches it. The mirror runs below are the
 * calibration: they prove this fixture really exercises the defect, so the
 * overlay's CAUGHT is the fix and not a fixture that could never survive.
 */
const overlayWorks = (() => {
  const probeDir = mkdtempSync(join(tmpdir(), 'mutation-probe-overlay-check-'));
  try {
    const src = join(probeDir, 'src');
    const dst = join(probeDir, 'dst');
    writeFileSync(src, 'overlay\n');
    writeFileSync(dst, 'original\n');
    const r = spawnSync('bwrap', ['--dev-bind', '/', '/', '--bind', src, dst, '--', 'cat', dst], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    return r.status === 0 && r.stdout === 'overlay\n';
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
})();

/**
 * Write containment (WI-6554700010018048) needs one more capability than the subject bind: a
 * kernel overlay mounted by uid 0 of a private user namespace. Probed with the probe's own
 * shape so a host without it skips rather than fails.
 */
const containWorks = overlayWorks && (() => {
  const probeDir = mkdtempSync(join(tmpdir(), 'mutation-probe-contain-check-'));
  try {
    const lower = join(probeDir, 'lower');
    const work = join(probeDir, 'work');
    mkdirSync(lower);
    mkdirSync(work);
    const script = `mount -t tmpfs tmpfs "$2" && mkdir "$2/u" "$2/w" && mount -t overlay overlay -o "lowerdir=$1,upperdir=$2/u,workdir=$2/w" "$1" && : > "$1/canary"`;
    const r = spawnSync('bwrap', [
      '--unshare-user', '--uid', '0', '--gid', '0', '--cap-add', 'ALL', '--dev-bind', '/', '/', '--',
      'bash', '-c', script, '_', lower, work,
    ], { encoding: 'utf8', timeout: 15_000 });
    return r.status === 0 && !existsSync(join(lower, 'canary'));
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
})();

function makeSiblingRouteRepo(): { repo: string; subject: string } {
  const repo = join(dir, 'sibling-route-repo');
  mkdirSync(repo);
  git(repo, ['init', '-q']);
  const subjectPath = join(repo, 'subject.cjs');
  writeFileSync(subjectPath, 'module.exports = 1;\n');
  // The sibling reaches the subject by a RELATIVE import — the route the mirror loses.
  writeFileSync(join(repo, 'sib.cjs'), "module.exports = () => require('./subject.cjs');\n");
  return { repo, subject: subjectPath };
}

/** Loads {} directly (module-load control passes) but ASSERTS only through the sibling. */
const SIBLING_ROUTE_GUARD =
  'node -e "const p = process.argv[1]; require(p); if (require(require(\'path\').dirname(p) + \'/sib.cjs\')() !== 1) process.exit(1)" {}';

describe('mutation-probe.sh — copy-out overlay reaches the mutant through every route (EI-24799401310241778)', () => {
  it('calibration: the MIRROR false-SURVIVES when the test reaches the subject only through a sibling', () => {
    const { subject: s } = makeSiblingRouteRepo();
    const { code, out } = runProbeIO([
      '--file', s,
      '--relocation', 'mirror',
      '--mutate', 's/module.exports = 1;/module.exports = 2;/',
      '--test', SIBLING_ROUTE_GUARD,
    ]);
    expect(out).toMatch(/verdict=survived/);
    expect(out).toMatch(/relocation=mirror/);
    // A mirror survival now carries its own caveat instead of reading as a weak guard.
    expect(out).toMatch(/SIBLING module.*ORIGINAL file/);
    expect(code).toBe(1);
    expect(readFileSync(s, 'utf8')).toBe('module.exports = 1;\n');
  });

  it.skipIf(!overlayWorks)('CATCHES the same mutant under the overlay, without touching the tracked file', () => {
    const { subject: s } = makeSiblingRouteRepo();
    const { code, out } = runProbeIO([
      '--file', s,
      '--mutate', 's/module.exports = 1;/module.exports = 2;/',
      '--test', SIBLING_ROUTE_GUARD,
    ]);
    expect(out).toMatch(/overlay relocation/);
    expect(out).toMatch(/verdict=caught/);
    expect(out).toMatch(/relocation=overlay/);
    expect(code).toBe(0);
    expect(readFileSync(s, 'utf8')).toBe('module.exports = 1;\n');
  });

  it.skipIf(!overlayWorks)('a symlinked-path test that the mirror could not load reaches the mutant under the overlay', () => {
    // The mirror's module-load control refuses this fixture (see the copy-out
    // block above). Under the overlay the realpath IS the mutant, so it scores.
    const repo = join(dir, 'overlay-symlink-test-repo');
    mkdirSync(repo);
    git(repo, ['init', '-q']);
    const modulePath = join(repo, 'subject.cjs');
    writeFileSync(modulePath, 'module.exports = 1;\n');
    writeFileSync(join(repo, 'guard.cjs'), "if (require('./subject.cjs') !== 1) process.exit(1);\n");
    const { code, out } = runProbeIO([
      '--file', modulePath,
      '--mutate', 's/module.exports = 1;/module.exports = 2;/',
      '--test', 'node "$(dirname {})/guard.cjs"',
    ]);
    expect(out).toMatch(/verdict=caught/);
    expect(out).toMatch(/relocation=overlay/);
    expect(code).toBe(0);
    expect(readFileSync(modulePath, 'utf8')).toBe('module.exports = 1;\n');
  });

  it.skipIf(!overlayWorks)('keeps the baseline OUTSIDE the overlay and exempts the subject for the reporter only inside it', () => {
    const { subject: s } = makeSiblingRouteRepo();
    const log = join(dir, 'overlay-env.log');
    const { code } = runProbeIO([
      '--file', s,
      '--mutate', 's/module.exports = 1;/module.exports = 2;/',
      '--test', `printf '%s=%s\\n' "$PAPERCUSP_MUTATION_PHASE" "\${PAPERCUSP_MUTATION_PROBE_SUBJECT:-unset}" >> ${JSON.stringify(log)}; ${SIBLING_ROUTE_GUARD}`,
    ]);
    expect(code).toBe(0);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toContain('baseline=unset');
    expect(lines).toContain(`copy-baseline=${s}`);
    expect(lines).toContain(`mutant=${s}`);
  });

  it.skipIf(!overlayWorks)("contains a guard's own write to the subject path inside the overlay", () => {
    // The flip side of binding the mutant over the subject's path: inside the namespace that
    // path IS the scratch copy, so even a guard that writes to it cannot dirty the tracked file.
    // Without the overlay the same write would land on the real file, which is why the copy-out
    // "preserves a source edit" test simulates its peer from OUTSIDE the probe.
    const { code, out } = runProbeIO([
      '--file', subject,
      '--mutate', 's/beta/BETA/',
      '--test', `if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then printf 'guard-write\\n' > ${JSON.stringify(subject)}; fi; grep -q "^beta$" {}`,
    ]);
    expect(out).toMatch(/relocation=overlay/);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(code).toBe(0);
    expect(read()).toBe(ORIGINAL);
    expect(out).not.toContain('external-change-preserved');
  });

  /**
   * WI-6554700010018048 — the subject bind isolated ONE file. A guard whose build step writes
   * into the checkout (the papercusp.com site's vitest global-setup runs build.py into out/)
   * left output built FROM THE MUTANT in the real tree for the whole probe, where a peer was
   * deploying it, while tree integrity read VERIFIED. Every post-baseline overlay leg now sees
   * the checkout copy-on-write and discards its writes. The fixture "builds" by copying {} into
   * out/: the BASELINE runs outside the namespace and must land; the copy-baseline and mutant
   * builds must not. The MUTATION_PROBE_CONTAIN_WRITES=0 run is the calibration: the same
   * fixture really does leak the mutant build when containment is off.
   */
  function makeBuildOutputRepo(name: string): { repo: string; subject: string; guard: string } {
    const repo = join(dir, name);
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'out'));
    mkdirSync(join(repo, '.papercusp', 'scratch'), { recursive: true });
    git(repo, ['init', '-q']);
    const subjectPath = join(repo, 'src', 'subject.txt');
    writeFileSync(subjectPath, 'keep\n');
    writeFileSync(join(repo, 'out', 'index.html'), 'pre-probe\n');
    const q = (p: string) => JSON.stringify(p);
    const guard = [
      `cp {} ${q(join(repo, 'out', 'index.html'))}`,
      `printf x > ${q(join(repo, 'out'))}/built-by-$PAPERCUSP_MUTATION_PHASE`,
      `printf x > ${q(join(repo, '.papercusp', 'scratch'))}/evidence-$PAPERCUSP_MUTATION_PHASE`,
      `printf x > ${q(repo)}/rootlevel-$PAPERCUSP_MUTATION_PHASE`,
      'grep -q "^keep$" {}',
    ].join(' && ');
    return { repo, subject: subjectPath, guard };
  }

  it.skipIf(!containWorks)('discards the build output a guard writes into the checkout during post-baseline legs', () => {
    const { repo, subject: s, guard } = makeBuildOutputRepo('build-output-repo');
    const { code, out } = runProbeIO(['--file', s, '--mutate', 's/keep/KEEP/', '--test', guard], process.env, repo);
    expect(out).toContain('MUTATION_PROBE_CONTAINMENT status=contained overlays=1 uncovered=0 failed=0');
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(code).toBe(0);
    // The baseline's (unmutated) build is the only one the real tree ever saw.
    expect(readFileSync(join(repo, 'out', 'index.html'), 'utf8')).toBe('keep\n');
    expect(readdirSync(join(repo, 'out')).sort()).toEqual(['built-by-baseline', 'index.html']);
    expect(existsSync(join(repo, 'rootlevel-mutant'))).toBe(false);
    // Evidence written to .papercusp/scratch outlives every leg.
    expect(readdirSync(join(repo, '.papercusp', 'scratch')).sort()).toEqual([
      'evidence-baseline', 'evidence-copy-baseline', 'evidence-mutant',
    ]);
    expect(readFileSync(s, 'utf8')).toBe('keep\n');
  });

  it.skipIf(!containWorks)('splits a checkout with a mount point under it and names the root-level writes it could not contain', () => {
    const { repo, subject: s, guard } = makeBuildOutputRepo('build-output-mounted-repo');
    // A bind under the root, like the shared papercusp tree's .gitnexus: overlayfs will not take
    // the root whole from a user namespace, so the probe overlays each subtree instead.
    const empty = join(dir, 'empty-mount-source');
    mkdirSync(empty);
    mkdirSync(join(repo, 'mnt'));
    const r = spawnSync('bwrap', [
      '--dev-bind', '/', '/', '--bind', empty, join(repo, 'mnt'), '--die-with-parent', '--',
      'bash', SCRIPT, '--file', s, '--mutate', 's/keep/KEEP/', '--test', guard,
    ], { encoding: 'utf8', timeout: 60_000, cwd: repo });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out).toMatch(/MUTATION_PROBE_CONTAINMENT status=partial overlays=[1-9]\d* uncovered=\d+ failed=0/);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(r.status).toBe(0);
    // Inside a covered subtree the mutant build is still discarded...
    expect(readFileSync(join(repo, 'out', 'index.html'), 'utf8')).toBe('keep\n');
    expect(readdirSync(join(repo, 'out')).sort()).toEqual(['built-by-baseline', 'index.html']);
    // ...while each write at the uncovered root level is named, per post-baseline leg.
    expect(out).toContain(`MUTATION_PROBE_CONTAINMENT_LEAK phase=copy-baseline path=${join(repo, 'rootlevel-copy-baseline')}`);
    expect(out).toContain(`MUTATION_PROBE_CONTAINMENT_LEAK phase=mutant path=${join(repo, 'rootlevel-mutant')}`);
    expect(out).not.toContain('phase=baseline path=');
  });

  it.skipIf(!overlayWorks)('calibration: with MUTATION_PROBE_CONTAIN_WRITES=0 the same fixture leaks the mutant build', () => {
    const { repo, subject: s, guard } = makeBuildOutputRepo('build-output-uncontained-repo');
    const { code, out } = runProbeIO(
      ['--file', s, '--mutate', 's/keep/KEEP/', '--test', guard],
      { ...process.env, MUTATION_PROBE_CONTAIN_WRITES: '0' },
      repo,
    );
    expect(out).toContain('MUTATION_PROBE_CONTAINMENT status=disabled');
    expect(out).toMatch(/write containment: DISABLED .*lands in the REAL tree/);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(code).toBe(0);
    expect(readFileSync(join(repo, 'out', 'index.html'), 'utf8')).toBe('KEEP\n');
    expect(existsSync(join(repo, 'out', 'built-by-mutant'))).toBe(true);
  });

  /**
   * WI-10005682 — the THIRD arm of the `{}` asymmetry pinned by "accepts a --test with no {}
   * placeholder, which copy-out mode must still refuse".
   *
   * Copy-out demands `{}` because `auto` may fall back to the repo mirror, where `{}` is the
   * only thing naming the mutant. An EXPLICIT `--relocation overlay` has no such fallback: it
   * binds the mutant over the subject's OWN path and hard-dies rather than silently
   * downgrading, so the subject's real path already names the mutant and `{}` is the same no-op
   * it is in-tree. Demanding it anyway forced a fixed-path suite to thread a dummy `{}` that
   * nothing reads — the very friction the in-tree relaxation exists to remove.
   *
   * Deliberately split in two: the refusal is a PARSE-time check reached long before bwrap is
   * attempted, so the "does not fire" half is provable on EVERY host; only the verdict half
   * needs a working overlay.
   */
  it('does NOT demand {} under an EXPLICIT --relocation overlay, while auto and mirror still do', () => {
    const { subject: s } = makeSiblingRouteRepo();
    // No {} anywhere: the guard names the subject's own real path — the shape a suite that
    // imports its subject by a FIXED path is stuck with.
    const fixedPathGuard = `node -e "if (require('${s}') !== 1) process.exit(1)"`;
    const base = [
      '--file', s,
      '--mutate', 's/module.exports = 1;/module.exports = 2;/',
      '--test', fixedPathGuard,
    ];

    // Non-vacuousness, for BOTH fallback-capable relocations: the SAME command is still
    // refused, so this is a mode-specific relaxation and not a removed check.
    for (const reloc of ['auto', 'mirror']) {
      const refused = runProbeIO([...base, '--relocation', reloc]);
      expect(refused.code).toBe(2);
      expect(refused.out).toMatch(/--test must contain \{\}/);
    }

    // Explicit overlay: the {}-refusal does not fire. Asserted on the MESSAGE rather than the
    // exit code so it still holds on a host without bwrap — there overlay dies for THAT reason
    // instead, a different refusal which must never be conflated with this one.
    const overlay = runProbeIO([...base, '--relocation', 'overlay']);
    expect(overlay.out).not.toMatch(/--test must contain \{\}/);
    expect(readFileSync(s, 'utf8')).toBe('module.exports = 1;\n');
  });

  it.skipIf(!overlayWorks)('SCORES a fixed-path {}-less test under the explicit overlay', () => {
    // The behavioural half: not merely "not refused" but actually reaching a real verdict. The
    // overlay binds the mutant over the subject's own path, so a fixed-path guard the mirror
    // could never reach fails on the mutant and is scored CAUGHT.
    const { subject: s } = makeSiblingRouteRepo();
    const { code, out } = runProbeIO([
      '--file', s,
      '--relocation', 'overlay',
      '--mutate', 's/module.exports = 1;/module.exports = 2;/',
      '--test', `node -e "if (require('${s}') !== 1) process.exit(1)"`,
    ]);
    expect(out).toMatch(/relocation=overlay/);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(code).toBe(0);
    expect(readFileSync(s, 'utf8')).toBe('module.exports = 1;\n');
  });

  it('refuses --relocation under --in-tree, and an unknown relocation value', () => {
    const inTree = runProbeIO([
      '--file', subject, '--in-tree', '--accept-sweep-race', '--relocation', 'overlay',
      '--mutate', 's/gamma/GAMMA/', '--test', 'grep -q "^gamma$" {}',
    ]);
    expect(inTree.code).toBe(2);
    expect(inTree.out).toMatch(/--relocation only applies to copy-out/);
    const bogus = runProbeIO(['--file', subject, '--relocation', 'sideways', '--mutate', 's/gamma/GAMMA/', '--test', 'grep -q "^gamma$" {}']);
    expect(bogus.code).toBe(2);
    expect(bogus.out).toMatch(/--relocation must be/);
    expect(read()).toBe(ORIGINAL);
  });
});

describe('mutation-probe.sh — historical source mode', () => {
  it('uses an explicit commit, requires controls/calibration, and keeps both snapshots frozen', () => {
    const history = makeHistoricalRepo();
    const savedSubject = JSON.stringify(history.file);
    // The command deliberately rewrites the working file between phases and
    // restores it. A live-file implementation fails the current assertion;
    // only a frozen current snapshot passes it.
    const guard =
      `printf 'stable-control\\nlegacy-path\\n' > ${savedSubject}; ` +
      `grep -q '^NEW_GUARD$' {}; rc=$?; printf 'stable-control\\nNEW_GUARD\\ncurrent-edit\\n' > ${savedSubject}; exit "$rc"`;
    const { code, out } = runProbeIO([
      '--file',
      history.file,
      '--against-commit',
      history.oldSha,
      '--must-be-absent',
      'NEW_GUARD',
      '--positive-control',
      'stable-control',
      '--calibration',
      'grep -q "^stable-control$" {}',
      '--test',
      guard,
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/mode=historical/);
    expect(out).toMatch(/HISTORICAL SOURCE CAUGHT/);
    expect(out).toMatch(/calibration_current=0 calibration_historical=0/);
    expect(out).toMatch(/absence_control=NEW_GUARD/);
    expect(readFileSync(history.file, 'utf8')).toBe('stable-control\nNEW_GUARD\ncurrent-edit\n');
  });

  it('finds the newest reachable commit whose source lacks --against-last-without', () => {
    const history = makeHistoricalRepo();
    const { code, out } = runProbeIO([
      '--file',
      history.file,
      '--against-last-without',
      'NEW_GUARD',
      '--positive-control',
      'stable-control',
      '--calibration',
      'grep -q "^stable-control$" {}',
      '--test',
      'grep -q "^NEW_GUARD$" {}',
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/mode=historical/);
    expect(out).toMatch(/absence_control=NEW_GUARD/);
    expect(out).toMatch(/positive_controls=1/);
    expect(out).toMatch(new RegExp(`against_commit=${history.oldSha}`));
  });

  /** One explicit-commit historical run whose guard is caught on the before-fix side. */
  const explicitHistoricalArgs = (file: string, oldSha: string): string[] => [
    '--file', file,
    '--against-commit', oldSha,
    '--must-be-absent', 'NEW_GUARD',
    '--positive-control', 'stable-control',
    '--calibration', 'grep -q "^stable-control$" {}',
    '--test', 'grep -q "^NEW_GUARD$" {}',
  ];

  /**
   * WI-10004910 — the tracked-file precondition used to read the INDEX
   * (`git ls-files --error-unmatch`). git-sync rewrites .git/index on every
   * sweep, and a half-written index makes ls-files exit 1 with "did not match"
   * for a tracked path, identical to a genuinely untracked one (a zero-byte
   * index exits 128). The probe then refused a tracked file with "Git has no
   * path". Trackedness now comes from HEAD's tree in the object store.
   */
  it('takes trackedness from HEAD, so a half-written or empty index cannot make a tracked --file look untracked (WI-10004910)', () => {
    const history = makeHistoricalRepo();
    const full = readFileSync(join(history.repo, '.git', 'index'));
    const broken: Record<string, Buffer> = {
      half: full.subarray(0, Math.floor(full.length / 2)),
      empty: Buffer.alloc(0),
    };
    for (const [shape, bytes] of Object.entries(broken)) {
      const index = join(dir, `${shape}.index`);
      writeFileSync(index, bytes);
      const env = { ...process.env, GIT_INDEX_FILE: index };
      // Calibration: this index really does defeat an index-based check, so the
      // pass below proves the probe ignores the index, not a harmless fixture.
      const lsFiles = spawnSync('git', ['-C', history.repo, 'ls-files', '--error-unmatch', '--', 'subject.txt'], {
        encoding: 'utf8',
        env,
        timeout: 30_000,
        killSignal: 'SIGKILL',
      });
      expect(lsFiles.status, `${shape} index must defeat ls-files`).not.toBe(0);

      const { code, out } = runProbeIO(explicitHistoricalArgs(history.file, history.oldSha), env);
      expect(out, `${shape} index`).not.toMatch(/has no path 'subject\.txt'/);
      expect(code, `${shape} index: ${out}`).toBe(0);
      expect(out).toMatch(/HISTORICAL SOURCE CAUGHT/);
    }
  });

  it('refuses a staged-but-never-committed --file by naming HEAD, not the index', () => {
    const history = makeHistoricalRepo();
    const fresh = join(history.repo, 'fresh.txt');
    writeFileSync(fresh, 'stable-control\nNEW_GUARD\n');
    git(history.repo, ['add', 'fresh.txt']);
    const { code, out } = runProbeIO(explicitHistoricalArgs(fresh, history.oldSha));
    expect(code).toBe(2);
    expect(out).toMatch(/requires a --file committed at HEAD; HEAD's tree has no path 'fresh\.txt'/);
  });

  it('reports an unreadable HEAD tree as a git read failure, never as an untracked file', () => {
    const history = makeHistoricalRepo();
    const tree = git(history.repo, ['rev-parse', 'HEAD^{tree}']);
    const looseTree = join(history.repo, '.git', 'objects', tree.slice(0, 2), tree.slice(2));
    expect(existsSync(looseTree), 'fixture: HEAD tree must be a loose object').toBe(true);
    rmSync(looseTree, { force: true });
    const { code, out } = runProbeIO(explicitHistoricalArgs(history.file, history.oldSha));
    expect(code).toBe(2);
    expect(out).toMatch(/git could not read HEAD's tree .* is UNKNOWN \(a git read failure, not an untracked file\): fatal:/);
    expect(out).not.toMatch(/requires a --file committed at HEAD/);
  });

  /**
   * EI-23362664002917898 — historical mode relocated every snapshot to an
   * EXTENSIONLESS path (`$SCRATCH/snapshot-run-N`). tsx and node decide whether
   * to STRIP TYPES by extension, so a TypeScript subject was handed to the
   * plain-JS loader and died at PARSE on BOTH legs; historical mode can only
   * score that as verdict=harness-error, so the probe could never reach a
   * verdict for ANY TypeScript subject. Copy-out mode was always sound (it
   * relocates to the repo-relative path, or the basename when the subject is
   * not in a worktree — both carry the extension), so this guard is specific to
   * historical mode's run_snapshot_command.
   */
  it('preserves the subject file extension on every relocated historical snapshot path', () => {
    const history = makeHistoricalTsRepo();
    const seen = join(dir, 'relocated-paths.txt');
    const record = `printf '%s\\n' {} >> ${JSON.stringify(seen)}; `;
    const { code, out } = runProbeIO([
      '--file',
      history.file,
      '--against-last-without',
      'NEW_GUARD',
      '--positive-control',
      'stable-control',
      '--calibration',
      `${record}grep -q 'stable-control' {}`,
      '--test',
      `${record}grep -q 'NEW_GUARD' {}`,
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/mode=historical/);
    expect(out).toMatch(/HISTORICAL SOURCE CAUGHT/);

    // Both legs of calibration + both legs of the guard each get their own
    // relocated copy, so the probe must have handed out at least four paths.
    const paths = readFileSync(seen, 'utf8').trim().split('\n').filter(Boolean);
    expect(paths.length).toBeGreaterThanOrEqual(4);
    // The discriminator: pre-fix every one of these was a bare
    // `snapshot-run-N` with no extension at all.
    expect(paths.filter((p) => p.endsWith('.ts'))).toEqual(paths);
  });

  /**
   * EI-21882388979504012 — the same runner-MISUSE shape is exposed on the
   * historical guard run, which also executes against a frozen SNAPSHOT path
   * a project-relative runner cannot always collect. PAPERCUSP_MUTATION_PHASE
   * is set to "historical" for exactly that one run (run_snapshot_command
   * historical ...), so this keys off the same marker the script observes.
   */
  it('reports a RUNNER-MISUSE historical guard exit as harness-error, never as HISTORICAL SOURCE CAUGHT', () => {
    const history = makeHistoricalRepo();
    const { code, out } = runProbeIO([
      '--file',
      history.file,
      '--against-last-without',
      'NEW_GUARD',
      '--positive-control',
      'stable-control',
      '--calibration',
      'grep -q "^stable-control$" {}',
      '--test',
      'if [ "$PAPERCUSP_MUTATION_PHASE" = historical ]; then echo "No test files found, exiting with code 1"; exit 1; fi; grep -q "^NEW_GUARD$" {}',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/mode=historical/);
    expect(out).toMatch(/RUNNER-MISUSE/i);
    expect(out).toMatch(/No test files found/);
    expect(out).toMatch(/verdict=harness-error/);
    expect(out).toMatch(/runner_misuse=No,test,files,found/);
    expect(out).not.toMatch(/HISTORICAL SOURCE CAUGHT/);
  });

  it('refuses historical mode without a positive control or calibration before running the guard', () => {
    const history = makeHistoricalRepo();
    const { code, out } = runProbeIO([
      '--file',
      history.file,
      '--against-commit',
      history.oldSha,
      '--must-be-absent',
      'NEW_GUARD',
      '--test',
      'printf ran > "' + join(dir, 'historical-ran') + '"; grep -q NEW_GUARD {}',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/requires at least one --positive-control/i);
    expect(readFileSync(history.file, 'utf8')).toContain('NEW_GUARD');
  });

  /**
   * EI-21902332137059032 — historical mode never ran --test against the
   * literal in-tree --file path, so it had no way to notice that RELOCATING a
   * snapshot (which every phase does) can itself change a subject's
   * behaviour, independent of the fixed-vs-broken content being compared.
   * --subject-must-behave is the opt-in fix: run a smoke command once
   * in-tree, once relocated, and refuse if they disagree. This fixture models
   * a subject that resolves a SIBLING file relative to its own directory (the
   * $0-relative-resolution class named in the bug report) — present next to
   * the real in-tree file, absent next to any relocated copy under scratch.
   */
  it('--subject-must-behave catches a subject whose behaviour depends on a sibling relative to its own path', () => {
    const history = makeHistoricalRepo();
    writeFileSync(join(history.repo, 'sibling-marker'), 'present');
    const subjectMustBehave = 'd=$(dirname "{}"); [ -f "$d/sibling-marker" ] && exit 1 || exit 0';
    const { code, out } = runProbeIO([
      '--file',
      history.file,
      '--against-last-without',
      'NEW_GUARD',
      '--positive-control',
      'stable-control',
      '--calibration',
      'grep -q "^stable-control$" {}',
      '--subject-must-behave',
      subjectMustBehave,
      '--test',
      'grep -q "^NEW_GUARD$" {}',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/SUBJECT-MUST-BEHAVE MISMATCH/);
    expect(out).toMatch(/subject_must_behave=mismatch/);
    expect(out).toMatch(/verdict=harness-error/);
    // Never reaches (and never falsely reports) a historical-source verdict.
    expect(out).not.toMatch(/HISTORICAL SOURCE/);
  });

  it('--subject-must-behave is a no-op (zero behaviour change) when relocation does not change the subject', () => {
    const history = makeHistoricalRepo();
    const { code, out } = runProbeIO([
      '--file',
      history.file,
      '--against-last-without',
      'NEW_GUARD',
      '--positive-control',
      'stable-control',
      '--calibration',
      'grep -q "^stable-control$" {}',
      '--subject-must-behave',
      'grep -q "^stable-control$" {}',
      '--test',
      'grep -q "^NEW_GUARD$" {}',
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/subject-must-behave: relocation-consistent/);
    expect(out).toMatch(/HISTORICAL SOURCE CAUGHT/);
  });

  /**
   * EI-26316662044073002 — --subject-must-behave was opt-in, so a caller who did not know
   * the subject resolves siblings relative to itself got a relocated program scored as
   * the fix. A snapshot that statically names its own location now REQUIRES the
   * behavioural check. The guard below writes a marker when it runs, so the refusal is
   * proven to happen before any phase executes, not merely before the verdict line.
   */
  function makeSelfLocatingRepo(token: string): { file: string; oldSha: string } {
    const repo = join(dir, 'self-locating-repo');
    mkdirSync(repo);
    const file = join(repo, 'subject.sh');
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'mutation-probe-test@example.invalid']);
    git(repo, ['config', 'user.name', 'mutation-probe-test']);
    writeFileSync(file, `# stable-control\nhere=${token}\nlegacy-path\n`);
    git(repo, ['add', 'subject.sh']);
    git(repo, ['commit', '-qm', 'historical source']);
    const oldSha = git(repo, ['rev-parse', 'HEAD']);
    writeFileSync(file, `# stable-control\nhere=${token}\nNEW_GUARD\n`);
    return { file, oldSha };
  }
  const selfLocatingArgs = (file: string, oldSha: string, ran: string): string[] => [
    '--file', file,
    '--against-commit', oldSha,
    '--must-be-absent', 'NEW_GUARD',
    '--positive-control', 'stable-control',
    '--calibration', 'grep -q "^# stable-control$" {}',
    '--test', `printf ran >> "${ran}"; grep -q "^NEW_GUARD$" {}`,
  ];

  it.each([
    ['a shell $0-relative sibling', '"$(dirname "$0")/lib"', 'dirname "$0'],
    ['BASH_SOURCE', '"${BASH_SOURCE[0]%/*}"', '${BASH_SOURCE'],
    ['node __dirname', 'require("path").join(__dirname, "lib")', '__dirname'],
    ['ESM import.meta.url', 'new URL("./lib", import.meta.url)', 'import.meta.url'],
  ])('refuses a self-locating subject (%s) without --subject-must-behave, before any phase runs', (_label, token, site) => {
    const { file, oldSha } = makeSelfLocatingRepo(token);
    const ran = join(dir, 'guard-ran');
    const { code, out } = runProbeIO(selfLocatingArgs(file, oldSha, ran));
    expect(code, out).toBe(2);
    expect(out).toMatch(/REFUSING: SELF-LOCATING SUBJECT/);
    expect(out).toContain(site);
    expect(out).toMatch(/current:2:/);
    expect(out).toMatch(/historical:2:/);
    expect(out).toContain('--subject-must-behave');
    expect(out).toContain('--relocation overlay');
    expect(out).not.toMatch(/HISTORICAL SOURCE/);
    expect(existsSync(ran)).toBe(false);
  });

  it('proceeds on a self-locating subject once --subject-must-behave proves relocation is harmless', () => {
    const { file, oldSha } = makeSelfLocatingRepo('"$(dirname "$0")/lib"');
    const ran = join(dir, 'guard-ran');
    const { code, out } = runProbeIO([
      ...selfLocatingArgs(file, oldSha, ran),
      '--subject-must-behave', 'grep -q "^# stable-control$" {}',
    ]);
    expect(code, out).toBe(0);
    expect(out).toMatch(/self-locating subject: relocation checked by --subject-must-behave/);
    expect(out).toMatch(/subject-must-behave: relocation-consistent/);
    expect(out).toMatch(/HISTORICAL SOURCE CAUGHT/);
    expect(existsSync(ran)).toBe(true);
  });

  it('does not treat $0 outside a self-location call as self-locating', () => {
    // awk's $0 and a bare "$0" in a usage string do not resolve a path from the
    // script's location; the refusal must not fire on them.
    const { file, oldSha } = makeSelfLocatingRepo(`"$(awk '{print $0}' /dev/null)"; echo "usage: $0"`);
    const ran = join(dir, 'guard-ran');
    const { code, out } = runProbeIO(selfLocatingArgs(file, oldSha, ran));
    expect(code, out).toBe(0);
    expect(out).not.toMatch(/SELF-LOCATING/);
    expect(out).toMatch(/HISTORICAL SOURCE CAUGHT/);
  });

  it('rejects --subject-must-behave outside historical mode', () => {
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      'grep -q "^beta$" {}',
      '--subject-must-behave',
      'true {}',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/--subject-must-behave only applies to historical mode/);
  });

  it('rejects --subject-must-behave without a {} placeholder', () => {
    const history = makeHistoricalRepo();
    const { code, out } = runProbeIO([
      '--file',
      history.file,
      '--against-last-without',
      'NEW_GUARD',
      '--positive-control',
      'stable-control',
      '--calibration',
      'grep -q "^stable-control$" {}',
      '--subject-must-behave',
      'true',
      '--test',
      'grep -q "^NEW_GUARD$" {}',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/--subject-must-behave must contain \{\}/);
  });
});

/**
 * `--in-tree` REFUSES to run until the caller says what it did about the git-sync sweep race
 * (`--sweep-lock-held` or `--accept-sweep-race`). Every in-tree probe below passes
 * `--accept-sweep-race`, which is the honest answer HERE and not a way around the gate: the
 * subject is a fresh file under `mkdtempSync(tmpdir())`, so it is not in the swept tree at all
 * and there is no window for a sweep tick to commit. The refusal itself is pinned separately,
 * in apps/operator/lib/mutation-probe-sweep-gate.test.ts — do not weaken it here.
 */
const ACCEPT_SWEEP = '--accept-sweep-race';

describe('mutation-probe.sh — in-tree mode restores the tracked file', () => {
  beforeEach(() => { git(dir, ['init', '-q']); });

  it("uses the host token and fails an invalid in-tree auth preflight before baseline", () => {
    const home = join(dir, "test-home");
    const hostToken = join(home, ".papercusp", "superuser-token");
    const isolatedHome = join(dir, "isolated", ".papercusp");
    const bin = join(dir, "bin");
    const ptoolLog = join(dir, "ptool-calls");
    const baselineMarker = join(dir, "baseline-started");
    mkdirSync(join(home, ".papercusp"), { recursive: true });
    mkdirSync(isolatedHome, { recursive: true });
    mkdirSync(bin);
    writeFileSync(hostToken, "host-token");
    writeFileSync(join(isolatedHome, "superuser-token"), "workspace-token");
    writeFileSync(join(bin, "ptool"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'tool=""',
      "for arg in \"$@\"; do",
      "  case \"$arg\" in coord:presence|locks:queue|locks:heartbeat) tool=\"$arg\" ;; esac",
      "done",
      "echo \"$tool|${PAPERCUSP_SID:-}|${PAPERCUSP_MCP_TOKEN_FILE:-}\" >> \"${PROBE_PTOOL_LOG}\"",
      "echo \"mcp_auth_failed: superuser_invalid_bearer\" >&2",
      "exit 1",
    ].join("\n"), { mode: 0o700 });

    const env: NodeJS.ProcessEnv = { ...process.env };
    env.PATH = bin + ":" + (process.env.PATH ?? "");
    env.HOME = home;
    env.PAPERCUSP_HOME = isolatedHome;
    env.PAPERCUSP_SID = "probe-session";
    env.PAPERCUSP_WORKSPACE = "probe-workspace";
    env.PAPERCUSP_TEST_RUN_HARNESS = "probe-harness";
    env.MUTATION_PROBE_WINDOW_MAX_SEC = "60";
    env.PROBE_PTOOL_LOG = ptoolLog;
    delete env.PAPERCUSP_MCP_TOKEN_FILE;

    const guard = 'if [ "$PAPERCUSP_MUTATION_PHASE" = baseline ]; then : > "' + baselineMarker
      + '"; fi; grep -q "^beta$" {}';
    const { code, out } = runProbeIO([
      "--in-tree",
      "--sweep-lock-held",
      "--file",
      subject,
      "--mutate",
      "s/beta/BETA/",
      "--test",
      guard,
    ], env);

    expect(code).toBe(2);
    expect(out).toContain("mcp_auth_failed: superuser_invalid_bearer");
    expect(out).toContain("could not read this session's Papercusp owner identity");
    expect(existsSync(baselineMarker)).toBe(false);
    expect(read()).toBe(ORIGINAL);
    expect(readFileSync(ptoolLog, "utf8").trim()).toBe("coord:presence|probe-session|" + hostToken);
  });

  it("prints a bounded heartbeat reply when ownership is not confirmed", () => {
    const bin = join(dir, "bin");
    const baselineMarker = join(dir, "baseline-started");
    mkdirSync(bin);
    writeFileSync(join(bin, "ptool"), [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      'const tool = args.find((arg) => ["coord:presence", "locks:queue", "locks:heartbeat"].includes(arg));',
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { input += chunk; });',
      'process.stdin.on("end", () => {',
      '  if (tool === "coord:presence") { process.stdout.write(JSON.stringify({ self: { ownerId: "probe-owner" } })); return; }',
      '  if (tool === "locks:queue") {',
      '    const { paths } = JSON.parse(input);',
      '    process.stdout.write(JSON.stringify({ active_locks: [{ path: paths[0], owner: "probe-owner", intent: "mutation probe", lock_id: "probe-lock" }] }));',
      '    return;',
      '  }',
      '  if (tool === "locks:heartbeat") { process.stdout.write(JSON.stringify({ results: [{ lock_id: "probe-lock", extended: false }], trace: "x".repeat(600) + "-TAIL-SENTINEL" })); return; }',
      '  process.exitCode = 2;',
      '});',
    ].join("\n"), { mode: 0o700 });

    const env: NodeJS.ProcessEnv = { ...process.env };
    env.PATH = bin + ":" + (process.env.PATH ?? "");
    env.PAPERCUSP_SID = "probe-session";
    env.PAPERCUSP_WORKSPACE = "probe-workspace";
    env.PAPERCUSP_TEST_RUN_HARNESS = "probe-harness";
    env.MUTATION_PROBE_WINDOW_MAX_SEC = "60";

    const guard = 'if [ "$PAPERCUSP_MUTATION_PHASE" = baseline ]; then : > "' + baselineMarker
      + '"; fi; grep -q "^beta$" {}';
    const { code, out } = runProbeIO([
      "--in-tree",
      "--sweep-lock-held",
      "--file",
      subject,
      "--mutate",
      "s/beta/BETA/",
      "--test",
      guard,
    ], env);

    expect(code).toBe(2);
    expect(out).toContain("the file-lock heartbeat did not confirm ownership");
    expect(out).toContain('"trace":"');
    expect(out).not.toContain("-TAIL-SENTINEL");
    expect(existsSync(baselineMarker)).toBe(false);
    expect(read()).toBe(ORIGINAL);
  });

  /**
   * EI-24720263797874266: the verified-restore record the testing:run fence reads, so a
   * 'mutation probe' lock that outlives the dirty window stops fencing unrelated tests.
   */
  function restoredRecord(): string[] | null {
    const root = realpathSync(dir);
    const admissionDir = admissionDirFor(root);
    const record = join(admissionDir, 'restored', createHash('sha256').update(join(root, 'subject.txt')).digest('hex'));
    return existsSync(record) ? readFileSync(record, 'utf8').split('\0') : null;
  }
  const verifiedOriginal = () => [realpathSync(dir), join(realpathSync(dir), 'subject.txt'),
    createHash('sha256').update(ORIGINAL).digest('hex'), ''];

  it('pins admitted original bytes if the snapshot pathname is unlinked before bwrap mounts it', () => {
    const root = realpathSync(dir);
    const admissionDir = admissionDirFor(root);
    const scratch = mkdtempSync(join(tmpdir(), 'mutation-probe.'));
    const snapshot = join(scratch, 'subject.txt.orig');
    const bin = join(dir, 'bin');
    const realBwrap = spawnSync('bash', ['-c', 'command -v bwrap'], { encoding: 'utf8' });
    expect(realBwrap.status).toBe(0);
    mkdirSync(admissionDir, { recursive: true });
    mkdirSync(bin);
    writeFileSync(snapshot, ORIGINAL);
    writeFileSync(subject, ORIGINAL.replace('beta', 'BETA'));
    writeFileSync(join(admissionDir, 'original.manifest'),
      [root, join(root, 'subject.txt'), snapshot, String(process.pid), ''].join('\0'));
    // The real overlay has already validated the manifest when it execs this
    // shim. Remove only this fixture's pathname, then exercise real bwrap.
    writeFileSync(join(bin, 'bwrap'), '#!/usr/bin/env bash\nset -euo pipefail\n'
      + 'rm -- "$PROBE_TEST_SNAPSHOT"\nexec "$PROBE_TEST_BWRAP" "$@"\n', { mode: 0o700 });
    try {
      const admitted = spawnSync('bash', [OVERLAY, root, '--', 'cat', subject], {
        encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROBE_TEST_SNAPSHOT: snapshot,
          PROBE_TEST_BWRAP: realBwrap.stdout.trim() },
      });
      expect(existsSync(snapshot)).toBe(false);
      expect(admitted.status, admitted.stderr).toBe(0);
      expect(admitted.stdout).toBe(ORIGINAL);
      expect(read()).toContain('BETA');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('admits a concurrent test against original bytes while the tracked subject is mutated', async () => {
    const mutantStarted = join(dir, 'mutant-started');
    const child = spawn('bash', [SCRIPT, '--in-tree', ACCEPT_SWEEP, '--file', subject,
      '--mutate', 's/beta/BETA/', '--test',
      `if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then : > "${mutantStarted}"; sleep 4; fi; grep -q "^beta$" {}`],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<number | null>((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('exit', (code) => resolveExit(code));
    });
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(mutantStarted) && Date.now() < deadline) await sleep(50);
      expect(existsSync(mutantStarted)).toBe(true);
      expect(read()).toContain('BETA');
      const admitted = spawnSync('bash', [OVERLAY, dir, '--', 'cat', subject],
        { encoding: 'utf8', timeout: 10_000 });
      expect(admitted.status, admitted.stderr).toBe(0);
      expect(admitted.stdout).toBe(ORIGINAL);
      expect(await exited).toBe(0);
      expect(read()).toBe(ORIGINAL);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
  }, 20_000);
  it('holds producer cleanup until an admitted child finishes its snapshot handoff', async () => {
    const root = realpathSync(dir);
    const admissionDir = admissionDirFor(root);
    const manifest = join(admissionDir, 'original.manifest');
    const mutantReady = join(dir, 'mutant-ready');
    const finishProducer = join(dir, 'finish-producer');
    const handoffReady = join(dir, 'handoff-ready');
    const finishHandoff = join(dir, 'finish-handoff');
    const cleanupAttempt = join(dir, 'cleanup-attempt');
    const bin = join(dir, 'handoff-bin');
    mkdirSync(bin);
    const realFlock = spawnSync('bash', ['-c', 'command -v flock'], { encoding: 'utf8' });
    const realBwrap = spawnSync('bash', ['-c', 'command -v bwrap'], { encoding: 'utf8' });
    expect(realFlock.status).toBe(0);
    expect(realBwrap.status).toBe(0);
    writeFileSync(join(bin, 'flock'), '#!/usr/bin/env bash\nset -euo pipefail\n'
      + 'if [ "$1" = -x ] && [ -e "$PROBE_TEST_FINISH_PRODUCER" ]; then : > "$PROBE_TEST_CLEANUP_ATTEMPT"; fi\n'
      + 'exec "$PROBE_TEST_FLOCK" "$@"\n', { mode: 0o700 });
    writeFileSync(join(bin, 'bwrap'), '#!/usr/bin/env bash\nset -euo pipefail\n'
      + ': > "$PROBE_TEST_HANDOFF_READY"\n'
      + 'for ((n=0; n<1000; n++)); do [ ! -e "$PROBE_TEST_FINISH_HANDOFF" ] || break; sleep 0.01; done\n'
      + '[ -e "$PROBE_TEST_FINISH_HANDOFF" ] || exit 99\n'
      + 'exec "$PROBE_TEST_BWRAP" "$@"\n', { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`,
      PROBE_TEST_FLOCK: realFlock.stdout.trim(), PROBE_TEST_BWRAP: realBwrap.stdout.trim(),
      PROBE_TEST_MUTANT_READY: mutantReady, PROBE_TEST_FINISH_PRODUCER: finishProducer,
      PROBE_TEST_HANDOFF_READY: handoffReady, PROBE_TEST_FINISH_HANDOFF: finishHandoff,
      PROBE_TEST_CLEANUP_ATTEMPT: cleanupAttempt };
    const guard = 'if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then '
      + ': > "$PROBE_TEST_MUTANT_READY"; '
      + 'for ((n=0; n<1000; n++)); do [ ! -e "$PROBE_TEST_FINISH_PRODUCER" ] || break; sleep 0.01; done; '
      + '[ -e "$PROBE_TEST_FINISH_PRODUCER" ] || exit 99; fi; grep -q "^beta$" {}';
    const producer = spawn('bash', [SCRIPT, '--in-tree', ACCEPT_SWEEP, '--file', subject,
      '--mutate', 's/beta/BETA/', '--test', guard], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const producerOutput = createTextCollector();
    producerOutput.attach(producer.stdout);
    producerOutput.attach(producer.stderr);
    const producerClosed = new Promise<number | null>((resolveExit) => producer.once('close', resolveExit));
    let admitted: ReturnType<typeof spawn> | undefined;
    let admittedClosed: Promise<number | null> | undefined;
    const admittedOutput = createTextCollector();
    const awaitMarker = async (path: string) => {
      const deadline = Date.now() + 10_000;
      while (!existsSync(path) && Date.now() < deadline) await sleep(25);
      expect(existsSync(path), producerOutput.peek() + admittedOutput.peek()).toBe(true);
    };
    try {
      await awaitMarker(mutantReady);
      const snapshot = readFileSync(manifest, 'utf8').split('\0')[2]!;
      expect(read()).toContain('BETA');
      admitted = spawn('bash', [OVERLAY, root, '--', 'cat', subject],
        { env, stdio: ['ignore', 'pipe', 'pipe'] });
      admittedOutput.attach(admitted.stdout);
      admittedOutput.attach(admitted.stderr);
      admittedClosed = new Promise<number | null>((resolveExit) => admitted!.once('close', resolveExit));
      await awaitMarker(handoffReady);
      writeFileSync(finishProducer, '');
      await awaitMarker(cleanupAttempt);
      expect(read()).toBe(ORIGINAL);
      expect(producer.exitCode).toBeNull();
      expect(existsSync(manifest)).toBe(true);
      expect(readFileSync(snapshot, 'utf8')).toBe(ORIGINAL);
      // A non-blocking exclusive acquisition proves the admitted process tree
      // still owns the shared lock while the real producer is trying to finish.
      const exclusive = spawnSync(realFlock.stdout.trim(), ['-n', '-x', join(admissionDir, 'admission.lock'), 'true']);
      expect(exclusive.status).toBe(1);
      writeFileSync(finishHandoff, '');
      expect(await admittedClosed, admittedOutput.peek()).toBe(0);
      expect(admittedOutput.text()).toBe(ORIGINAL);
      expect(await producerClosed, producerOutput.peek()).toBe(0);
      expect(existsSync(manifest)).toBe(false);
      expect(existsSync(dirname(snapshot))).toBe(false);
      expect(read()).toBe(ORIGINAL);
      expect(restoredRecord()).toEqual(verifiedOriginal());
    } finally {
      writeFileSync(finishProducer, '');
      writeFileSync(finishHandoff, '');
      if (admitted && admitted.exitCode === null && admitted.signalCode === null) admitted.kill('SIGTERM');
      if (producer.exitCode === null && producer.signalCode === null) producer.kill('SIGTERM');
      if (admittedClosed) await admittedClosed;
      await producerClosed;
    }
  }, 35_000);

  it('restores after a normal exit', () => {
    // Assert the exit code, not just the restore: without this the probe REFUSING outright
    // (exit 2, tracked file never touched) also leaves the file byte-identical, so the restore
    // assertion alone passes vacuously. That is exactly how the missing sweep-ack went unseen.
    expect(
      runProbe([
        '--in-tree',
        ACCEPT_SWEEP,
        '--file',
        subject,
        '--mutate',
        's/beta/BETA/',
        '--test',
        'grep -q "^beta$" {}',
      ]),
    ).toBe(0);
    expect(read()).toBe(ORIGINAL);
    expect(restoredRecord()).toEqual(verifiedOriginal());
  });

  it('clears its admission snapshot when an in-tree no-op is refused before baseline', () => {
    const root = realpathSync(dir);
    const admissionDir = admissionDirFor(root);
    const manifest = join(admissionDir, 'original.manifest');
    const baselineStarted = join(dir, 'baseline-started');
    const { code, out } = runProbeIO(['--in-tree', ACCEPT_SWEEP, '--file', subject,
      '--mutate', 's/nosuchtext/x/', '--test', `touch ${JSON.stringify(baselineStarted)}; grep -q '^beta$' {}`]);
    expect(code, out).toBe(2);
    expect(out).toMatch(/changed NOTHING/i);
    expect(existsSync(baselineStarted)).toBe(false);
    expect(read()).toBe(ORIGINAL);
    expect(existsSync(manifest)).toBe(false);
    expect(restoredRecord()).toEqual(verifiedOriginal());
  });

  it('preserves a concurrent edit instead of restoring the probe baseline over it', async () => {
    const mutantStarted = join(dir, 'in-tree-mutant-started');
    const command = `if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then : > ${JSON.stringify(mutantStarted)}; sleep 4; fi; grep -q "^beta$" {}`;
    const child = spawn('bash', [SCRIPT, '--in-tree', ACCEPT_SWEEP, '--file', subject,
      '--mutate', 's/beta/BETA/', '--test', command], { stdio: ['ignore', 'pipe', 'pipe'] });
    const output = createTextCollector();
    output.attach(child.stdout);
    output.attach(child.stderr);
    const closed = new Promise<number>((resolveCode) => child.once('close', (code) => resolveCode(code ?? -1)));
    try {
      const deadline = Date.now() + 15_000;
      while (!existsSync(mutantStarted) && Date.now() < deadline) await sleep(50);
      expect(existsSync(mutantStarted), output.peek()).toBe(true);
      writeFileSync(subject, 'peer-edit\n');
      expect(await closed).toBe(3);
      expect(read()).toBe('peer-edit\n');
      expect(output.text()).toContain('MUTATION_PROBE_RESULT verdict=caught');
      expect(output.text()).toContain('MUTATION_PROBE_TREE_RESULT status=concurrent-change-preserved');
      expect(output.text()).not.toContain('Restore it NOW:');
      expect(restoredRecord()).toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 20_000);

  it('restores and clears an orphaned admission manifest after the probe is killed before its trap', async () => {
    const marker = join(dir, 'guard.pid');
    const command =
      'if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then ' +
      'printf "%s\\n" "$BASHPID" > ' +
      JSON.stringify(marker) +
      '; exec sleep 20; fi; grep -q "^beta$" {}';
    const child = spawn(
      'bash',
      [SCRIPT, '--in-tree', ACCEPT_SWEEP, '--file', subject, '--mutate', 's/beta/BETA/', '--test', command],
      { stdio: 'ignore' },
    );
    const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once('close', (code, signal) => resolveExit({ code, signal }));
    });
    let guardPid = 0;
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(marker) && Date.now() < deadline) await sleep(25);
      expect(existsSync(marker)).toBe(true);
      guardPid = Number(readFileSync(marker, 'utf8').trim());
      expect(Number.isInteger(guardPid) && guardPid > 0).toBe(true);
      expect(read()).toBe('alpha\nBETA\ngamma\n');

      child.kill('SIGKILL');
      const outcome = await Promise.race([childExit, sleep(10_000).then(() => null)]);
      expect(outcome).toEqual({ code: null, signal: 'SIGKILL' });
      try { process.kill(guardPid, 'SIGKILL'); } catch { /* the probe may have reaped it first */ }

      const root = realpathSync(dir);
      const admissionDir = admissionDirFor(root);
      const manifest = join(admissionDir, 'original.manifest');
      expect(existsSync(manifest)).toBe(true);
      const fields = readFileSync(manifest, 'utf8').split('\0');
      const scratchDir = dirname(fields[2]);
      // The SIGKILLed probe never reached its own restore, so no record exists yet.
      expect(restoredRecord()).toBeNull();

      const recovered = spawnSync('bash', [OVERLAY, root, '--', 'cat', subject], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(recovered.stdout).toBe(ORIGINAL);
      expect(read()).toBe(ORIGINAL);
      expect(existsSync(manifest)).toBe(false);
      expect(existsSync(scratchDir)).toBe(false);
      expect(restoredRecord()).toEqual(verifiedOriginal());

      const secondMarker = join(dir, 'guard-direct.pid');
      const secondCommand =
        'if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then ' +
        'printf "%s\\n" "$BASHPID" > ' +
        JSON.stringify(secondMarker) +
        '; exec sleep 20; fi; grep -q "^beta$" {}';
      const secondChild = spawn(
        'bash',
        [SCRIPT, '--in-tree', ACCEPT_SWEEP, '--file', subject, '--mutate', 's/beta/BETA/', '--test', secondCommand],
        { stdio: 'ignore' },
      );
      let secondGuardPid = 0;
      const secondChildExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
        secondChild.once('close', (code, signal) => resolveExit({ code, signal }));
      });
      try {
        const secondDeadline = Date.now() + 10_000;
        while (!existsSync(secondMarker) && Date.now() < secondDeadline) await sleep(25);
        expect(existsSync(secondMarker)).toBe(true);
        secondGuardPid = Number(readFileSync(secondMarker, 'utf8').trim());
        expect(Number.isInteger(secondGuardPid) && secondGuardPid > 0).toBe(true);
        secondChild.kill('SIGKILL');
        const secondOutcome = await Promise.race([secondChildExit, sleep(10_000).then(() => null)]);
        expect(secondOutcome).toEqual({ code: null, signal: 'SIGKILL' });
        try { process.kill(secondGuardPid, 'SIGKILL'); } catch { /* the probe may have reaped it first */ }
        const secondScratchDir = dirname(readFileSync(manifest, 'utf8').split('\0')[2]);

        expect(runProbe(['--in-tree', ACCEPT_SWEEP, '--file', subject, '--mutate', 's/beta/BETA/', '--test', 'grep -q "^beta$" {}']))
          .toBe(0);
        expect(read()).toBe(ORIGINAL);
        expect(existsSync(manifest)).toBe(false);
        expect(existsSync(secondScratchDir)).toBe(false);
      } finally {
        if (secondChild.exitCode === null && secondChild.signalCode === null) secondChild.kill('SIGKILL');
        if (secondGuardPid > 0) {
          try { process.kill(secondGuardPid, 'SIGKILL'); } catch { /* already exited */ }
        }
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (guardPid > 0) {
        try { process.kill(guardPid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  }, 30_000);

  /**
   * EI-19455888914364007 — the `{}` requirement is MODE-SPECIFIC, and this pins the asymmetry
   * from BOTH sides with the SAME --test command, so neither half can be "tidied" away:
   *
   *  · in-tree  → ACCEPTED. The tracked file itself is the mutant, so the substitution is a
   *    no-op. This is the normal shape here, because in-tree mode exists precisely for subjects
   *    a suite imports by a FIXED path — such a test has nowhere to put a {} at all. Requiring
   *    it anyway forced callers to thread a dummy `PROBE_FILE={}` env var that nothing reads.
   *  · copy-out → still REFUSED (exit 2). There {} is the only thing pointing the test at the
   *    mutated copy; without it the test runs against the untouched original, every mutant
   *    "survives", and the probe reports a sound guard as weak.
   */
  it('accepts a --test with no {} placeholder, which copy-out mode must still refuse', () => {
    const testCmd = `grep -q "^beta$" ${subject}`;

    // in-tree: the mutation lands in the tracked file the command names, so the guard fails on
    // the mutant => CAUGHT => exit 0. And the file is still restored afterwards.
    expect(
      runProbe(['--in-tree', ACCEPT_SWEEP, '--file', subject, '--mutate', 's/beta/BETA/', '--test', testCmd]),
    ).toBe(0);
    expect(read()).toBe(ORIGINAL);

    // Non-vacuousness: the very same command is still rejected without --in-tree, so this is a
    // mode-specific relaxation and not a removed check.
    expect(runProbe(['--file', subject, '--mutate', 's/beta/BETA/', '--test', testCmd])).toBe(2);
    expect(read()).toBe(ORIGINAL);
  });

  it('does NOT run the extra copy-baseline phase — --in-tree never relocates the subject, so there is nothing to prove sound', () => {
    // EI-21884666893062196's fix is copy-out-specific: --in-tree mutates the
    // TRACKED file in place, so $TARGET is $FILE and a copy-baseline run
    // would just repeat the baseline verbatim. Pin the asymmetry so it can't
    // regress into an accidental extra guard invocation here too.
    const markerLog = join(dir, 'marker.log');
    const code = runProbe([
      '--in-tree',
      ACCEPT_SWEEP,
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      // The guard must FAIL once "beta" is gone (mutant phase) to be scored
      // CAUGHT — asserting the ORIGINAL text is present, not the mutated one.
      `printf '%s\\n' "$PAPERCUSP_MUTATION_PHASE" >> "${markerLog}"; grep -q "^beta$" {}`,
    ]);
    expect(code).toBe(0);
    expect(readFileSync(markerLog, 'utf8').trim().split('\n').sort()).toEqual(['baseline', 'mutant']);
    expect(read()).toBe(ORIGINAL);
  });

  it('keeps the post-mutation dirty window free of signal-unsafe command substitutions', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const mutationAt = source.indexOf('perl -pi -e "$MUTATE" "$TARGET"');
    const supervisedGuardAt = source.indexOf('run_guard mutant "mutant guard"', mutationAt);
    expect(mutationAt).toBeGreaterThan(-1);
    expect(supervisedGuardAt).toBeGreaterThan(mutationAt);

    // EI-20320511174710484 / WI-38375: SIGTERM landed inside a nested
    // post-mutation hash substitution and Bash reported an unmatched closing
    // parenthesis while entering the trap. finish() never ran, leaving BETA in
    // the subject. The dirty interval may use parameter expansion and builtins,
    // but it must contain neither modern nor legacy command substitution.
    const dirtyWindow = source.slice(mutationAt, supervisedGuardAt);
    expect(dirtyWindow).not.toContain('$(');
    expect(dirtyWindow).not.toContain(String.fromCharCode(96));
  });

  it.each([false, true])('handles SIGTERM at the completed mutation write boundary (peer edit: %s)', (peerEdit) => {
    // Signal the waiting probe before its mutation command returns. Polling
    // for dirty bytes made this boundary an occasional full-suite failure.
    const signalBin = join(dir, 'signal-bin');
    const signalMarker = join(dir, 'mutation-boundary-signalled');
    const realPerl = spawnSync('sh', ['-c', 'command -v perl'], {
      encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL',
    }).stdout.trim();
    expect(realPerl).not.toBe('');
    mkdirSync(signalBin);
    writeFileSync(join(signalBin, 'perl'), `#!/usr/bin/env bash
"$MUTATION_PROBE_REAL_PERL" "$@"
rc=$?
if [ "$1" = -pi ] && [ "$rc" -eq 0 ]; then
  : > "$MUTATION_PROBE_SIGNAL_MARKER"
  if [ "$MUTATION_PROBE_BOUNDARY_PEER_EDIT" = 1 ]; then
    printf 'peer-edit\\n' > "$MUTATION_PROBE_BOUNDARY_SUBJECT"
  fi
  kill -TERM "$PPID"
fi
exit "$rc"
`, { mode: 0o755 });
    const { code, out } = runProbeIO([
      '--in-tree', ACCEPT_SWEEP, '--file', subject,
      '--mutate', 's/beta/BETA/', '--test', 'grep -q "^beta$" {}',
    ], {
      ...process.env,
      PATH: `${signalBin}:${process.env.PATH ?? ''}`,
      MUTATION_PROBE_REAL_PERL: realPerl,
      MUTATION_PROBE_SIGNAL_MARKER: signalMarker,
      MUTATION_PROBE_BOUNDARY_PEER_EDIT: peerEdit ? '1' : '0',
      MUTATION_PROBE_BOUNDARY_SUBJECT: subject,
    });
    expect(existsSync(signalMarker), out).toBe(true);
    expect(code, out).toBe(peerEdit ? 3 : 143);
    expect(read()).toBe(peerEdit ? 'peer-edit\n' : ORIGINAL);
    if (peerEdit) {
      expect(out).toContain('MUTATION_PROBE_TREE_RESULT status=concurrent-change-preserved');
      expect(restoredRecord()).toBeNull();
    } else {
      expect(out).toContain('tree integrity: VERIFIED');
      expect(restoredRecord()).toEqual(verifiedOriginal());
    }
  });

  it('restores PROMPTLY on SIGTERM mid-probe — not merely eventually', async () => {
    // Make the cleanup-order hardening deterministic. finish() reaps
    // descendants by walking ps --ppid; on the shared host (~10k processes)
    // one scan can be slow enough that cleanup-before-restore consumes the
    // whole 5s integrity budget. Delay the FIRST scan past that budget. A
    // correct trap restores before invoking ps, so the delay affects only child
    // cleanup, never the tracked-file invariant. The separate source guard
    // above pins the observed command-substitution parse-abort root cause.
    const slowBin = join(dir, 'slow-bin');
    const slowPs = join(slowBin, 'ps');
    const slowPsMarker = join(dir, 'slow-ps-ran');
    const realPs = spawnSync('sh', ['-c', 'command -v ps'], {
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    }).stdout.trim();
    expect(realPs).not.toBe('');
    mkdirSync(slowBin);
    writeFileSync(
      slowPs,
      `#!/usr/bin/env bash
if [ ! -e "$MUTATION_PROBE_SLOW_PS_MARKER" ]; then
  : > "$MUTATION_PROBE_SLOW_PS_MARKER"
  sleep 6
fi
exec "$MUTATION_PROBE_REAL_PS" "$@"
`,
      { mode: 0o755 },
    );

    const child = spawn(
      'bash',
      [
        SCRIPT,
        '--in-tree',
        ACCEPT_SWEEP,
        '--file',
        subject,
        '--mutate',
        's/beta/BETA/',
        '--test',
        'if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then sleep 20; fi; test -f {}',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: `${slowBin}:${process.env.PATH ?? ''}`,
          MUTATION_PROBE_SLOW_PS_MARKER: slowPsMarker,
          MUTATION_PROBE_REAL_PS: realPs,
        },
      },
    );
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.stderr.on('data', (chunk: string) => { output += chunk; });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    try {
      // Wait until the probe has actually applied the mutant, so we are
      // measuring the restore path and not a race against startup. Without
      // this the test could pass having never mutated anything at all.
      const deadline = Date.now() + 15_000;
      while (read() === ORIGINAL && Date.now() < deadline) await sleep(100);
      expect(read()).not.toBe(ORIGINAL); // the tree really is dirty right now

      expect(child.kill('SIGTERM')).toBe(true);

      // 5s is deliberately far below the child's 20s runtime: the pre-fix
      // foreground form restored only when the child exited (~20s), so this
      // bound FAILS on a revert while passing comfortably on the fix.
      const restoreBy = Date.now() + 5_000;
      while (read() !== ORIGINAL && Date.now() < restoreBy) await sleep(50);
      expect(read(), `probe output before restore deadline:\n${output}`).toBe(ORIGINAL);

      // Signal delivery is part of the evidence: wait through the injected ps
      // delay and prove the trap completed normally rather than passing only
      // because an unrelated actor happened to rewrite the subject.
      const outcome = await Promise.race([exited, sleep(15_000).then(() => null)]);
      expect(outcome, `probe did not exit after SIGTERM:\n${output}`).not.toBeNull();
      expect(outcome?.code === 143 || outcome?.signal === 'SIGTERM').toBe(true);
      expect(output).toMatch(/tree integrity: VERIFIED/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 40_000);
});

/**
 * Recurrence guards for EI-20566003853444873 — the 2026-08-15 incident, in which
 * a probe of a wine-prefix reaper EXECUTED a mutant whose delete loop had been
 * widened (via silent perl replacement-half interpolation of an undefined
 * $parent) to `for d in /*`, destroying ~370GB. Two independent defenses are
 * pinned here, each from both sides (refusal fires; the sanctioned path works):
 *
 *   1. The DESTRUCTIVE-SUBJECT GATE — a subject file or --test command containing
 *      destructive primitives is REFUSED before anything executes in mutation
 *      modes, unless the caller picks --fake-destructive (PATH shims, nothing
 *      deletes) or --i-know-this-deletes --sandbox-root <dir> (bwrap, / read-only).
 *      Historical mode executes an unmutated source, so it warns instead of
 *      refusing; otherwise a real before-fix comparison is impossible for a
 *      subject that cleans up its own scratch file.
 *   2. The STRICT PRE-FLIGHT — a --mutate whose replacement references an
 *      undeclared perl variable is a hard refusal, never a silent empty.
 */
describe('mutation-probe.sh — destructive subjects are never executed unprotected', () => {
  const DESTRUCTIVE_SUBJECT = '#!/usr/bin/env bash\nrm -rf "$1"\necho cleaned\n';

  it('REFUSES (exit 2) an rm-containing subject before ANY execution, naming both sanctioned paths', () => {
    const ranMarker = join(dir, 'guard-ran');
    writeFileSync(subject, DESTRUCTIVE_SUBJECT);
    const { code, out } = runProbeIO([
      '--file', subject,
      '--mutate', 's/cleaned/CLEANED/',
      '--test', `: > ${ranMarker}; bash {} /nonexistent-victim`,
    ]);
    expect(code).toBe(2);
    // The refusal names both ways forward — the message is the interface.
    expect(out).toMatch(/--fake-destructive/);
    expect(out).toMatch(/--i-know-this-deletes/);
    expect(out).toMatch(/--sandbox-root/);
    // NOTHING executed: neither the baseline nor the mutant guard ever ran.
    expect(spawnSync('test', ['-e', ranMarker], { timeout: 5_000, killSignal: 'SIGKILL' }).status).not.toBe(0);
    expect(read()).toBe(DESTRUCTIVE_SUBJECT);
  });

  it('REFUSES a destructive --test command even when the subject itself is clean', () => {
    const { code, out } = runProbeIO([
      '--file', subject, // alpha/beta/gamma — clean
      '--mutate', 's/beta/BETA/',
      '--test', `grep -q "^beta$" {} && rm -rf ${join(dir, 'x')}`,
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/--fake-destructive/);
  });

  it('explains an unlink comment match and safely probes it through fake-destructive', () => {
    const commentOnlySubject = '# unlink appears only in this comment\nalpha\nbeta\ngamma\n';
    writeFileSync(subject, commentOnlySubject);
    const args = [
      '--file', subject,
      '--mutate', 's/beta/BETA/',
      '--test', 'grep -q "^beta$" {}',
    ];

    const refused = runProbeIO(args);
    expect(refused.code).toBe(2);
    expect(refused.out).toMatch(/this is a false positive/i);
    expect(refused.out).toMatch(/--fake-destructive is the cheap correct answer/i);
    expect(refused.out).toMatch(/\d+:# unlink appears only in this comment/);
    expect(read()).toBe(commentOnlySubject);

    const safe = runProbeIO(['--fake-destructive', ...args]);
    expect(safe.code).toBe(0);
    expect(safe.out).toMatch(/fake-destructive: shims installed/);
    expect(safe.out).toMatch(/MUTATION_PROBE_RESULT verdict=caught/);
    expect(read()).toBe(commentOnlySubject);
  });

  it('warns but allows an unmutated historical source containing rm', () => {
    const repo = join(dir, 'historical-destructive-repo');
    mkdirSync(repo);
    const file = join(repo, 'subject.sh');
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'mutation-probe-test@example.invalid']);
    git(repo, ['config', 'user.name', 'mutation-probe-test']);
    writeFileSync(file, '#!/usr/bin/env bash\nrm -f "$1"\necho stable-control\n');
    git(repo, ['add', 'subject.sh']);
    git(repo, ['commit', '-qm', 'historical source']);
    writeFileSync(
      file,
      '#!/usr/bin/env bash\nrm -f "$1"\necho stable-control\necho NEW_GUARD\n',
    );

    const { code, out } = runProbeIO([
      '--file', file,
      '--against-last-without', 'NEW_GUARD',
      '--positive-control', 'stable-control',
      '--calibration', 'bash -n {}',
      '--test', 'grep -q "echo NEW_GUARD" {}',
    ]);

    expect(code).toBe(0);
    expect(out).toMatch(/historical mode: destructive primitives detected/i);
    expect(out).toMatch(/no mutant is produced/i);
    expect(out).toMatch(/HISTORICAL SOURCE CAUGHT/);
    expect(out).toMatch(/destructive_primitives=rm/);
  });

  it('--fake-destructive runs the probe with shimmed deleters: the mutant is caught and the victim SURVIVES', () => {
    writeFileSync(subject, DESTRUCTIVE_SUBJECT);
    const victim = join(dir, 'victim');
    writeFileSync(victim, 'precious\n');
    // The guard asserts BOTH halves of the tier-0 contract: the subject's
    // output is intact AND the victim it "deleted" still exists (the shim
    // logged instead of deleting). On the mutant, the output changes => the
    // guard fails => CAUGHT (exit 0).
    const { code, out } = runProbeIO([
      '--fake-destructive',
      '--file', subject,
      '--mutate', 's/cleaned/CLEANED/',
      '--test', `[ "$(bash {} "${victim}" | tail -1)" = cleaned ] && [ -e "${victim}" ]`,
    ]);
    expect(out).toMatch(/fake-destructive: shims installed/);
    expect(code).toBe(0);
    // The real rm never ran, in either phase.
    expect(readFileSync(victim, 'utf8')).toBe('precious\n');
  });

  it('--i-know-this-deletes WITHOUT --sandbox-root is refused — acknowledgement alone saves no bytes', () => {
    writeFileSync(subject, DESTRUCTIVE_SUBJECT);
    const { code, out } = runProbeIO([
      '--i-know-this-deletes',
      '--file', subject,
      '--mutate', 's/cleaned/CLEANED/',
      '--test', 'bash {} /nonexistent-victim',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/--sandbox-root/);
  });

  it('refuses to COMBINE --fake-destructive with --i-know-this-deletes', () => {
    writeFileSync(subject, DESTRUCTIVE_SUBJECT);
    const sb = join(dir, 'sb');
    mkdirSync(sb);
    const { code, out } = runProbeIO([
      '--fake-destructive', '--i-know-this-deletes', '--sandbox-root', sb,
      '--file', subject,
      '--mutate', 's/cleaned/CLEANED/',
      '--test', 'bash {} /nonexistent-victim',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/pick ONE/i);
  });

  const bwrapWorks =
    spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--', 'true'], {
      timeout: 10_000,
    }).status === 0;

  it.skipIf(!bwrapWorks)(
    '--i-know-this-deletes --sandbox-root really walls the filesystem: a delete OUTSIDE the root fails',
    () => {
      writeFileSync(subject, '#!/usr/bin/env bash\nrm -f "$1" 2>/dev/null\necho ok\n');
      const sb = join(dir, 'sb');
      mkdirSync(sb);
      const outside = join(dir, 'outside-the-sandbox');
      writeFileSync(outside, 'still here\n');
      const { code, out } = runProbeIO([
        '--i-know-this-deletes', '--sandbox-root', sb,
        '--file', subject,
        '--mutate', 's/ok/OK/',
        '--test', `[ "$(bash {} "${outside}" | tail -1)" = ok ]`,
      ]);
      expect(out).toMatch(/sandbox: guard runs will execute under bwrap/);
      expect(code, out).toBe(0); // the probe itself still works end-to-end
      // The subject really ran `rm -f` on this path in BOTH phases — and the
      // read-only bind meant it could not remove it. Without the sandbox this
      // assertion is the one that fails.
      expect(readFileSync(outside, 'utf8')).toBe('still here\n');
    },
  );

  it.skipIf(!bwrapWorks)(
    'EI-25217198562906119: a sandboxed guard that WRITES outside the sandbox gets the read-only cause + direct-router route, not a bare BASELINE FAILED',
    () => {
      writeFileSync(subject, '#!/usr/bin/env bash\nrm -f "$1" 2>/dev/null\necho ok\n');
      const sb = join(dir, 'sb');
      mkdirSync(sb);
      // Stands in for pc-heavy's /run/user/$UID/pc-heavy-slots and npm-install-safe's
      // /tmp/pcv/fs-mutex-locks: host state outside both writable binds.
      const hostState = join(dir, 'host-state');
      mkdirSync(hostState);
      const { code, out } = runProbeIO([
        '--i-know-this-deletes', '--sandbox-root', sb,
        '--file', subject,
        '--mutate', 's/ok/OK/',
        '--test', `touch "${hostState}/slot.pid" && [ "$(bash {} /nonexistent | tail -1)" = ok ]`,
      ]);
      expect(code, out).toBe(2);
      expect(out).toMatch(/BASELINE FAILED/);
      expect(out).toMatch(/verdict=harness-error/);
      expect(out).toMatch(/SANDBOX READ-ONLY WRITE/);
      expect(out).toMatch(/Read-only file system/); // the refused write is quoted, not paraphrased
      expect(out).toMatch(/scripts\/test-files\.mjs/);
      expect(out).toMatch(/reader lease outside bwrap/);
      expect(existsSync(join(hostState, 'slot.pid'))).toBe(false);
    },
  );

  it.skipIf(!bwrapWorks)(
    'preserves the guard checkout and cwd when the sandbox takes its install reader lease',
    () => {
      const repo = join(dir, 'guard-repo');
      const cwd = join(repo, 'nested');
      const sb = join(dir, 'sb');
      mkdirSync(cwd, { recursive: true });
      mkdirSync(sb);
      git(repo, ['init', '-q']);
      writeFileSync(subject, '#!/usr/bin/env bash\necho ok\n');
      const env = { ...process.env };
      delete env.PAPERCUSP_INSTALL_MUTEX_HELD;
      const leaseModule = resolve(dirname(SCRIPT), 'lib/install-lock-name.mjs');
      const leaseCheck = `import { installLockNameForRoot, installMutexIsHeld } from ${JSON.stringify(leaseModule)}; `
        + `process.exitCode = installMutexIsHeld(installLockNameForRoot(${JSON.stringify(repo)}), process.env) ? 0 : 71;`;
      const { code, out } = runProbeIO([
        '--i-know-this-deletes', '--sandbox-root', sb,
        '--file', subject, '--mutate', 's/echo ok/echo OK/',
        '--test', `: scripts/test-files.mjs; [ "$PWD" = '${cwd}' ] && node --input-type=module -e '${leaseCheck}' && [ "$(bash {})" = ok ]`,
      ], env, cwd);
      expect(code, out).toBe(0);
      expect(out).toContain(`root=${repo}, lock=`);
      expect(out).toMatch(/verdict=caught/);
      expect(out).not.toMatch(/SANDBOX READ-ONLY WRITE/);
    },
  );

  it.skipIf(!bwrapWorks)(
    'EI-25768400647222256: the direct test router reuses the host-held install lease inside the read-only sandbox',
    () => {
      writeFileSync(subject, ['#!/usr/bin/env bash', 'echo ok', ''].join('\n'));
      const sb = join(dir, 'sb');
      mkdirSync(sb);
      // Do not let this test's own test:file lease satisfy the sandboxed child.
      // The only valid marker must come from mutation-probe acquiring the lease
      // outside bwrap for the exact router repository.
      const env = { ...process.env };
      delete env.PAPERCUSP_INSTALL_MUTEX_HELD;
      const routerLeaseProbe = [
        "node --import ./scripts/lib/committed-source-loader.mjs --input-type=module -e '",
        'import { REPO_ROOT, runTestFilesCli } from "./scripts/test-files.mjs"; ',
        'import { installLockNameForRoot, installMutexIsHeld } from "./scripts/lib/install-lock-name.mjs"; ',
        'const lock = installLockNameForRoot(REPO_ROOT); ',
        'const status = await runTestFilesCli([], { env: process.env, ',
        'acquireReadLease: async () => { throw new Error("nested lease acquisition"); }, ',
        'run: async () => installMutexIsHeld(lock, process.env) ? 0 : 71 }); ',
        'process.exitCode = status;',
        "'",
      ].join('');
      const { code, out } = runProbeIO([
        '--expect', 'survived',
        '--i-know-this-deletes', '--sandbox-root', sb,
        '--file', subject,
        '--mutate', 's/echo ok/echo OK/',
        '--test', routerLeaseProbe + ' && test -f {}',
      ], env, resolve(dirname(SCRIPT), '..'));
      expect(code, out).toBe(0);
      expect(out).toMatch(/NPM_INSTALL_SAFE (?:guarding reader|mutex already held)/);
      expect(out).toMatch(/verdict=survived/);
      expect(out).not.toMatch(/SANDBOX READ-ONLY WRITE/);
    },
  );

  it.skipIf(!bwrapWorks)(
    'EI-25217198562906119: a sandboxed guard can write its vite config temp dir (private tmpfs) and still reach a genuine verdict',
    () => {
      // vitest bundles <config> into <nearest node_modules>/.vite-temp before collecting
      // any test; under the read-only / that write died with EROFS in every baseline.
      const repo = join(dir, 'vite-repo');
      mkdirSync(join(repo, 'node_modules'), { recursive: true });
      git(repo, ['init', '-q']);
      writeFileSync(join(repo, 'vitest.config.ts'), 'export default {};\n');
      git(repo, ['add', 'vitest.config.ts']);
      const sub = join(repo, 'subject.sh');
      writeFileSync(sub, '#!/usr/bin/env bash\nrm -f "$1" 2>/dev/null\necho ok\n');
      const sb = join(dir, 'sb');
      mkdirSync(sb);
      const viteTemp = join(repo, 'node_modules', '.vite-temp');
      const { code, out } = runProbeIO([
        '--i-know-this-deletes', '--sandbox-root', sb,
        '--file', sub,
        '--mutate', 's/ok/OK/',
        '--test', `echo bundled > "${viteTemp}/vitest.config.ts.timestamp-1.mjs" && [ "$(bash {} /nonexistent | tail -1)" = ok ]`,
      ]);
      expect(out).toMatch(/private tmpfs over \d+ vite config temp dir/);
      expect(out).not.toMatch(/SANDBOX READ-ONLY WRITE/);
      expect(code, out).toBe(0); // the mutant was CAUGHT: both baselines ran and passed
      // Private: the bundler's write never reached the host directory.
      expect(readdirSync(viteTemp)).toEqual([]);
    },
  );

  it.skipIf(!bwrapWorks)(
    'WI-10007344: aliases of an external node_modules share one physical private Vite temp mount',
    () => {
      const repo = join(dir, 'vite-alias-repo');
      const modules = join(dir, 'external-node-modules');
      mkdirSync(modules);
      mkdirSync(join(repo, 'apps', 'a'), { recursive: true });
      mkdirSync(join(repo, 'apps', 'b'), { recursive: true });
      // Use real filesystem aliases, as the maintained committed-source clones do.
      for (const relative of ['', 'apps/a', 'apps/b']) {
        const link = join(repo, relative, 'node_modules');
        const result = spawnSync('ln', ['-s', modules, link], { encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
        writeFileSync(join(repo, relative, 'vitest.config.ts'), 'export default {};\n');
      }
      git(repo, ['init', '-q']);
      const sub = join(repo, 'subject.sh');
      writeFileSync(sub, '#!/usr/bin/env bash\nrm -f "$1" 2>/dev/null\necho ok\n');
      git(repo, ['add', 'subject.sh', 'vitest.config.ts', 'apps/a/vitest.config.ts', 'apps/b/vitest.config.ts']);
      const sb = join(dir, 'sb');
      mkdirSync(sb);
      const aliasedTemp = join(repo, 'apps', 'a', 'node_modules', '.vite-temp');
      const { code, out } = runProbeIO([
        '--i-know-this-deletes', '--sandbox-root', sb,
        '--file', sub, '--mutate', 's/ok/OK/',
        '--test', `echo bundled > "${aliasedTemp}/config.mjs" && [ "$(bash {} /nonexistent | tail -1)" = ok ]`,
      ], process.env, repo);
      expect(code, out).toBe(0);
      expect(out).toContain('private tmpfs over 1 vite config temp dir');
      expect(out).not.toMatch(/Can't mount tmpfs|SANDBOX READ-ONLY WRITE/);
      expect(readdirSync(join(modules, '.vite-temp'))).toEqual([]);
      expect(readFileSync(sub, 'utf8')).toContain('echo ok');
    },
  );

  it('a replacement referencing an UNDECLARED perl variable is a hard refusal, never a silent empty', () => {
    // The incident's exact trap shape: match side escaped (shell literal),
    // replacement side bare => an undefined perl var => silently "" pre-fix.
    const { code, out } = runProbeIO([
      '--file', subject,
      '--mutate', 's/beta/$undefined_thing/',
      '--test', 'grep -q "^beta$" {}',
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/use strict/i);
    expect(out).toMatch(/INTERPOLATES/);
    expect(read()).toBe(ORIGINAL);
  });

  it('calibration: an ESCAPED literal \\$name in the replacement still works — the strict gate blocks only the trap', () => {
    const code = runProbe([
      '--file', subject,
      '--mutate', 's/beta/\\$literal/',
      '--test', 'grep -q "^beta$" {}',
    ]);
    // The mutation applied (beta -> $literal), the guard failed on the mutant,
    // the probe reports CAUGHT. Reaching exit 0 proves strict did not refuse it.
    expect(code).toBe(0);
    expect(read()).toBe(ORIGINAL);
  });
});

/**
 * Recurrence guard for EI-20451290782193791 — a baseline that ran ZERO tests
 * must never be scored, because scoring it produces a FALSE `MUTANT SURVIVED`.
 *
 * The trap: the probe infers CAUGHT vs SURVIVED from the guard's EXIT CODE
 * alone. That inference is sound only while a passing exit means assertions
 * actually ran. A test filter that selects nothing breaks it — vitest reports
 * zero-selection as a PASS (`Tests  2 skipped (2)`, exit 0), so the baseline
 * looks healthy, the mutant run also exits 0, and the probe declares SURVIVED
 * about a mutation no assertion ever examined. Wrong in the expensive
 * direction: it says a guard you just wrote is worthless.
 *
 * The discriminator is the runner's own count summary, NOT the exit code: a
 * healthy baseline must report at least one PASSED test. These cases are a
 * CONTROL SET so that none can pass on dead code — the first two differ only
 * in the word "passed", so a detector that merely refused every exit-0
 * baseline would fail the second, and one that never fired would fail the
 * first. The third pins the deliberate BASELINE-ONLY scoping: a fully caught
 * mutant also prints no "passed" (`Tests  2 failed (2)`, measured), so reusing
 * this detector on the mutant log would false-flag every real catch.
 */
describe('mutation-probe.sh — child source substitutions invalidate guard evidence', () => {
  it.each([
    ['baseline', 0, 'TEST_FILE_RESULT requested=1 status=passed childSubstituted=1 skippedTests=0'],
    ['copy-baseline', 0, 'TEST_FILE_CHILD_SUBSTITUTED count=1'],
    ['mutant', 0, 'TEST_FILE_RESULT requested=1 status=passed childSubstituted=12 skippedTests=0'],
    ['mutant', 1, 'TEST_FILE_RESULT requested=1 status=failed childSubstituted=1 skippedTests=0'],
  ])('refuses %s substitution even when its guard exits %s', (phase, exitCode, notice) => {
    const guard = join(dir, 'substituted-router.sh');
    writeFileSync(guard, `#!/usr/bin/env bash
if [ "$PAPERCUSP_MUTATION_PHASE" = "${phase}" ]; then
  printf '%s\\n' '${notice}'
  exit ${exitCode}
fi
printf 'TEST_FILE_RESULT requested=1 status=passed childSubstituted=0\\n'
`);
    const { code, out } = runProbeIO([
      '--file', subject, '--mutate', 's/beta/BETA/', '--test', `bash ${guard} {}`,
    ]);
    expect(code, out).toBe(2);
    expect(out).toContain('verdict=harness-error');
    expect(out).toContain(`child_source_substituted=yes phase=${phase}`);
    expect(out).not.toContain('VERDICT: MUTANT CAUGHT');
    expect(out).not.toContain('VERDICT: MUTANT SURVIVED');
    expect(read()).toBe(ORIGINAL);
  });

  it('still catches a behavior change with unchanged child source', () => {
    const guard = join(dir, 'unchanged-router.sh');
    writeFileSync(guard, `#!/usr/bin/env bash
printf 'TEST_FILE_RESULT requested=1 childSubstituted=0 skippedTests=0\\n'
if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then
  printf 'TEST_FILE_ASSERTION_FAILURE file="fixture.test.ts" name="behavior" message="AssertionError"\\n'
  exit 1
fi
`);
    const { code, out } = runProbeIO([
      '--file', subject, '--mutate', 's/beta/BETA/', '--test', `bash ${guard} {}`,
    ]);
    expect(code, out).toBe(0);
    expect(out).toContain('verdict=caught');
    expect(out).not.toContain('child_source_substituted=yes');
    expect(read()).toBe(ORIGINAL);
  });
});

describe('mutation-probe.sh — aborted test routers cannot certify a catch', () => {
  it.each([
    'TEST_FILE_ROUTE requested=1 groups=1',
    'TEST_FILE_PROGRESS state=started cwd="packages/operator-core"',
    'TEST_FILE_PROVENANCE head=fixture testedPaths=1',
  ])('refuses a router abort after %s without assertion evidence', (marker) => {
    const guard = join(dir, 'aborted-router.sh');
    writeFileSync(guard, `#!/usr/bin/env bash
if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then
  printf '%s\\n' '${marker}' 'Error: connect ECONNREFUSED 127.0.0.1:24680'
  exit 1
fi
printf 'TEST_FILE_RESULT requested=1 executed=1 status=passed\\n'
`);
    const { code, out } = runProbeIO([
      '--file', subject, '--mutate', 's/beta/BETA/', '--test', `bash ${guard} {}`,
    ]);
    expect(code).toBe(2);
    expect(out).toContain('verdict=inconclusive');
    expect(out).toContain('assertion_evidence=test-runner-aborted-before-result');
    expect(out).not.toContain('VERDICT: MUTANT CAUGHT');
    expect(read()).toBe(ORIGINAL);
  });

  it('keeps a measured router assertion failure certifiable', () => {
    const guard = join(dir, 'assertion-router.sh');
    writeFileSync(guard, `#!/usr/bin/env bash
printf 'TEST_FILE_ROUTE requested=1 groups=1\\n'
if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then
  printf 'TEST_FILE_ASSERTION_FAILURE file="fixture.test.ts" name="behavior" message="AssertionError"\\n'
  exit 1
fi
printf 'TEST_FILE_RESULT requested=1 executed=1 status=passed\\n'
`);
    const { code, out } = runProbeIO([
      '--file', subject, '--mutate', 's/beta/BETA/', '--test', `bash ${guard} {}`,
    ]);
    expect(code).toBe(0);
    expect(out).toContain('verdict=caught');
    expect(out).toContain('assertion_evidence=test-file-assertion-failure');
    expect(read()).toBe(ORIGINAL);
  });
});

/**
 * WI-6554700010010581 — the runner-misuse markers are matched anywhere in the
 * captured output, and a failing Vitest toContain prints the WHOLE subject
 * string. A subject whose comment reads `cargo: command not found` therefore
 * turned a measured catch into harness-error. Measured assertion evidence proves
 * the runner executed assertions, so it outranks a quoted marker; an ECHOED copy
 * of the reporter record (not at column 0) must not unlock that override.
 * Markers are built from parts so this file's own code-frame never contains them.
 */
describe('mutation-probe.sh — a quoted runner-misuse marker cannot void a measured catch', () => {
  const misuse = [': command', 'not found'].join(' ');
  const record = ['TEST_FILE', 'ASSERTION_FAILURE'].join('_');
  function quotingGuard(name: string, mutantLines: string[]): string {
    const guard = join(dir, name);
    // A quoted heredoc prints each line verbatim (no shell quoting or expansion).
    writeFileSync(guard, `#!/usr/bin/env bash
if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then
  cat <<'GUARD_OUTPUT'
${mutantLines.join('\n')}
GUARD_OUTPUT
  exit 1
fi
printf 'TEST_FILE_RESULT requested=1 executed=1 status=passed\\n'
`);
    return `bash ${guard} {}`;
  }

  it('scores a reporter-measured failure CAUGHT even when its diff quotes a misuse marker', () => {
    const { code, out } = runProbeIO([
      '--file', subject, '--mutate', 's/beta/BETA/', '--test',
      quotingGuard('quoted-marker-router.sh', [
        `AssertionError: expected '#!/usr/bin/env bash' to contain 'node build.mjs'`,
        `+ # build calls with cargo${misuse}. Resolve the Rust entry point.`,
        `${record} file="fixture.test.ts" name="wiring" message="AssertionError"`,
      ]),
    ]);
    expect(code, out).toBe(0);
    expect(out).toContain('verdict=caught');
    expect(out).toContain('assertion_evidence=test-file-assertion-failure');
    expect(out).not.toMatch(/RUNNER-MISUSE/i);
    expect(read()).toBe(ORIGINAL);
  });

  it('still reports harness-error when the only reporter record is an ECHOED copy, not a real one', () => {
    const { code, out } = runProbeIO([
      '--file', subject, '--mutate', 's/beta/BETA/', '--test',
      quotingGuard('echoed-record-router.sh', [
        `bash: line 1: vitest${misuse}`,
        `+   ${record} file="fixture.test.ts" name="quoted" message="x"`,
      ]),
    ]);
    expect(code, out).toBe(2);
    expect(out).toContain('verdict=harness-error');
    expect(out).toMatch(/runner_misuse=:,command,not,found/);
    expect(out).not.toContain('verdict=caught');
    expect(read()).toBe(ORIGINAL);
  });

  it('scores a direct Vitest failed-test count CAUGHT even when its output quotes a misuse marker', () => {
    const { code, out } = runProbeIO([
      '--file', subject, '--mutate', 's/beta/BETA/', '--test',
      quotingGuard('quoted-marker-vitest.sh', [
        `- Expected: "No test files found"`,
        `+ Received: "vitest${misuse}"`,
        ' Test Files  1 failed (1)',
        '      Tests  1 failed (1)',
      ]),
    ]);
    expect(code, out).toBe(0);
    expect(out).toContain('verdict=caught');
    expect(out).toContain('assertion_evidence=vitest-failed-tests');
    expect(read()).toBe(ORIGINAL);
  });
});

describe('mutation-probe.sh — a baseline that ran zero tests is never scored', () => {
  /** Write a guard whose output/exit may differ by phase; returns the --test command. */
  function phaseGuard(body: string): string {
    const guard = join(dir, 'guard.sh');
    writeFileSync(guard, `#!/usr/bin/env bash\n${body}\n`);
    return `bash ${guard} {}`;
  }

  it('REFUSES (exit 2, harness-error) when the baseline summary reports no PASSED test', () => {
    // The measured shape of a vitest run whose -t filter matched nothing.
    // Pre-fix this reached `VERDICT: MUTANT SURVIVED` and exit 1.
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      phaseGuard(`printf '  Tests  2 skipped (2)\\n'; exit 0`),
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/BASELINE RAN ZERO TESTS/);
    expect(out).toMatch(/verdict=harness-error/);
    // The refusal quotes the runner's own summary, so a reader sees WHY rather
    // than just being told the harness is broken.
    expect(out).toMatch(/zero_selection=Tests__2_skipped_\(2\)/);
    expect(out).not.toMatch(/MUTANT SURVIVED/);
    expect(read()).toBe(ORIGINAL);
  });

  it('CALIBRATION: the same exit-0 baseline still reaches a genuine SURVIVED once the summary says "passed"', () => {
    // Differs from the case above by ONE WORD. If the detector were "refuse any
    // baseline that exits 0", this would refuse too — and the probe could no
    // longer report a real weakness at all, which is its whole job.
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      phaseGuard(`printf '  Tests  1 passed | 1 skipped (2)\\n'; exit 0`),
    ]);
    expect(code).toBe(1);
    expect(out).toMatch(/MUTANT SURVIVED/);
    expect(out).not.toMatch(/ZERO TESTS/);
    expect(out).not.toMatch(/verdict=harness-error/);
    expect(read()).toBe(ORIGINAL);
  });

  it.each([
    ['1 passed | 1 skipped (2)', 1, 'survived'],
    ['2 skipped (2)', 2, 'harness-error'],
    ['0 passed | 2 skipped (2)', 2, 'harness-error'],
  ] as const)('uses the numeric summary %s when Vitest prints a close warning afterward', (summary, expectedCode, verdict) => {
    const { code, out } = runProbeIO([
      '--file', subject,
      '--mutate', 's/beta/BETA/',
      '--test', phaseGuard(
        `printf '  Tests  ${summary}\\nTests closed successfully but something prevents Vite server from exiting\\n'; exit 0`,
      ),
    ]);
    expect(code).toBe(expectedCode);
    expect(out).toContain(`verdict=${verdict}`);
    if (expectedCode === 2) expect(out).toContain(`zero_selection=Tests__${summary.replaceAll(' ', '_')}`);
    else expect(out).not.toContain('BASELINE RAN ZERO TESTS');
    expect(read()).toBe(ORIGINAL);
  });

  it('is BASELINE-ONLY: a caught mutant printing "Tests 2 failed (2)" is still CAUGHT, never a harness error', () => {
    // A fully-caught mutant's summary also contains no "passed" (measured).
    // Reusing the detector on the mutant log would therefore convert every
    // successful catch into a harness error — the regression this pins.
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      phaseGuard(
        `if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then printf '  Tests  2 failed (2)\\n'; exit 1; fi\n` +
          `printf '  Tests  1 passed | 1 skipped (2)\\n'; exit 0`,
      ),
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/MUTANT CAUGHT/);
    expect(out).not.toMatch(/ZERO TESTS/);
    expect(out).not.toMatch(/verdict=harness-error/);
    expect(read()).toBe(ORIGINAL);
  });

  it('sees through ANSI colour — vitest colourises the summary, and a naive line anchor would miss it', () => {
    // Not cosmetic: the detector anchors on `^\s*Tests`, and vitest wraps that
    // line in escapes. Without the strip the anchor never matches, the detector
    // emits nothing, and the false SURVIVED returns silently — a failure mode
    // that looks exactly like "no bug here".
    const { code, out } = runProbeIO([
      '--file',
      subject,
      '--mutate',
      's/beta/BETA/',
      '--test',
      phaseGuard(`printf '\\033[2m  Tests\\033[22m  \\033[33m2 skipped\\033[39m (2)\\n'; exit 0`),
    ]);
    expect(code).toBe(2);
    expect(out).toMatch(/BASELINE RAN ZERO TESTS/);
    expect(out).not.toMatch(/MUTANT SURVIVED/);
    expect(read()).toBe(ORIGINAL);
  });
});
