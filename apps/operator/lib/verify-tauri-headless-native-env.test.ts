import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const root = resolve(__dirname, '../../..');
const helper = resolve(root, 'scripts/lib/verify-tauri-native-env.mjs');
const { nativeVerifierEnv, preflightNativeVerifier, desktopPortalNativeTiming,
  desktopPortalNativeTestTimeoutMs, admitDesktopPortalNativeParent,
  verifyDesktopPortalCandidateSpa, withNativeVerifierTypeService } = await import(pathToFileURL(helper).href);
const { requestTscService } = await import(pathToFileURL(resolve(root, 'scripts/lib/tsc-service.mjs')).href);
const { admitTaskDeadline } = await import(pathToFileURL(resolve(root, 'scripts/lib/task-deadline.mjs')).href);

describe('real native verifier process boundary', () => {
  it('checks the selected source through an owned service and removes its socket after a failed check', async () => {
    const source = mkdtempSync(join(tmpdir(), 'native-types-source-'));
    let socket = '';
    try {
      mkdirSync(join(source, 'scripts'), { recursive: true });
      symlinkSync(join(root, 'scripts/tsc-service'), join(source, 'scripts/tsc-service'));
      symlinkSync(join(root, 'scripts/lib'), join(source, 'scripts/lib'));
      symlinkSync(join(root, 'node_modules'), join(source, 'node_modules'));
      writeFileSync(join(source, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, files: ['a.ts'] }));
      writeFileSync(join(source, 'a.ts'), 'export const a: number = "wrong";');
      await expect(withNativeVerifierTypeService(source, { ...process.env,
        PAPERCUSP_TSC_SERVICE_SOCKET: '/wrong/shared.sock', PAPERCUSP_TSC_SERVICE_UNIT_TEMPLATE: 'wrong' }, async env => {
        socket = env.PAPERCUSP_TSC_SERVICE_SOCKET!;
        expect(env.PAPERCUSP_TSC_SERVICE_ROOT).toBe(realpathSync(source));
        expect(env.PAPERCUSP_TSC_SERVICE_UNIT_TEMPLATE).toBe('');
        expect(env.PAPERCUSP_TSC_SERVICE_REQUIRED).toBe('1');
        const verdict = await requestTscService({ socketPath: socket, request: {
          v: 1, root: source, project: join(source, 'tsconfig.json'), files: ['a.ts'],
        } });
        expect(verdict).toMatchObject({ ok: true, errorCount: 1 });
        expect(verdict.output).toContain('TS2322');
        throw new Error('assertion failed after genuine type verdict');
      })).rejects.toThrow('assertion failed after genuine type verdict');
      expect(() => lstatSync(socket)).toThrow();
    } finally { rmSync(source, { recursive: true, force: true }); }
  }, 30_000);

  it('preserves startup failure and never starts a check without its source service', async () => {
    const source = mkdtempSync(join(tmpdir(), 'native-types-missing-'));
    const check = vi.fn();
    try {
      await expect(withNativeVerifierTypeService(source, process.env, check))
        .rejects.toThrow('Native TypeScript service exited code=1');
      expect(check).not.toHaveBeenCalled();
    } finally { rmSync(source, { recursive: true, force: true }); }
  });
  it('qualifies candidate bytes against the selected commit and copies only the declared SPA', () => {
    const directory = mkdtempSync(join(tmpdir(), 'native-candidate-spa-'));
    const source = join(directory, 'source');
    const candidate = join(directory, 'candidate');
    const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
    try {
      mkdirSync(source);
      execFileSync('git', ['init', '--quiet'], { cwd: source });
      writeFileSync(join(source, 'input'), 'selected source');
      execFileSync('git', ['add', 'input'], { cwd: source });
      execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '--quiet', '-m', 'candidate source'], { cwd: source });
      const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
      const bytes = { 'spa/index.html': '<meta content="portal-candidate">',
        'spa/assets/entry.js': 'candidate UI', 'spa/wordmark.svg': '<svg/>',
        'desktop-portal.cjs': 'candidate host' };
      for (const [path, content] of Object.entries(bytes)) {
        mkdirSync(resolve(candidate, path, '..'), { recursive: true });
        writeFileSync(join(candidate, path), content);
      }
      writeFileSync(join(candidate, 'spa/unlisted.js'), 'must never be served');
      const manifest = join(candidate, 'candidate.json');
      const receipt = { schemaVersion: 'desktop-portal-private-candidate-v1',
        desktopSource: { commitSha, worktreeDirty: false },
        environment: { PAPERCUSP_DESKTOP_INTERFACE: 'portal-candidate',
          PAPERCUSP_SPA_DIST: join(candidate, 'spa'),
          PAPERCUSP_DESKTOP_PORTAL_HOST_BUNDLE: join(candidate, 'desktop-portal.cjs') },
        files: Object.entries(bytes).map(([path, content]) => ({ path, sha256: hash(content) })) };
      const env: NodeJS.ProcessEnv = { VERIFY_TAURI_SOURCE_REF: commitSha,
        PAPERCUSP_DESKTOP_INTERFACE: 'portal-candidate', PAPERCUSP_SHARED_SPA_DIST: join(candidate, 'spa'),
        PAPERCUSP_DESKTOP_CANDIDATE_MANIFEST: manifest };
      const save = () => {
        const content = JSON.stringify(receipt);
        writeFileSync(manifest, content);
        env.VERIFY_TAURI_CANDIDATE_MANIFEST_SHA256 = hash(content);
      };
      save();
      const output = join(directory, 'frozen');
      expect(verifyDesktopPortalCandidateSpa(source, env, output)).toMatchObject({ commitSha, files: 4 });
      expect(readFileSync(join(output, 'assets/entry.js'), 'utf8')).toBe('candidate UI');
      expect(() => readFileSync(join(output, 'unlisted.js'))).toThrow();
      writeFileSync(join(candidate, 'spa/assets/entry.js'), 'later change');
      expect(() => verifyDesktopPortalCandidateSpa(source, env)).toThrow('hash mismatch');
      expect(readFileSync(join(output, 'assets/entry.js'), 'utf8')).toBe('candidate UI');
      writeFileSync(join(candidate, 'spa/assets/entry.js'), bytes['spa/assets/entry.js']);
      expect(() => verifyDesktopPortalCandidateSpa(source, { ...env,
        VERIFY_TAURI_CANDIDATE_MANIFEST_SHA256: '0'.repeat(64) })).toThrow('manifest hash');
      expect(() => verifyDesktopPortalCandidateSpa(source, { ...env,
        PAPERCUSP_SHARED_SPA_DIST: source })).toThrow('SPA selection');
      receipt.desktopSource.worktreeDirty = true; save();
      expect(() => verifyDesktopPortalCandidateSpa(source, env)).toThrow('clean selected desktop commit');
      receipt.desktopSource.worktreeDirty = false;
      receipt.desktopSource.commitSha = '0'.repeat(40); save();
      expect(() => verifyDesktopPortalCandidateSpa(source, env)).toThrow('clean selected desktop commit');
      receipt.desktopSource.commitSha = commitSha;
      receipt.files.push({ path: '../outside', sha256: hash('escape') }); save();
      expect(() => verifyDesktopPortalCandidateSpa(source, env)).toThrow('unsafe candidate path');
      receipt.files.pop(); save();
      rmSync(join(candidate, 'spa/assets/entry.js'));
      symlinkSync(join(source, 'input'), join(candidate, 'spa/assets/entry.js'));
      expect(() => verifyDesktopPortalCandidateSpa(source, env)).toThrow('symlink');
      expect(() => verifyDesktopPortalCandidateSpa(source, {
        PAPERCUSP_SHARED_SPA_DIST: join(candidate, 'spa') })).toThrow('manifest and digest');
      expect(verifyDesktopPortalCandidateSpa(source, {})).toBeNull();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('uses the physical donor while keeping a retained shadow and its acceptance source pinned', () => {
    const directory = mkdtempSync(join(tmpdir(), 'native-donor-'));
    const donor = join(directory, 'installed');
    const source = join(directory, 'retained');
    const git = (args: string[], cwd = donor) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    try {
      mkdirSync(donor);
      git(['init', '--quiet']);
      writeFileSync(join(donor, 'acceptance.txt'), 'committed source');
      git(['add', 'acceptance.txt']);
      git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'native source']);
      const sha = git(['rev-parse', 'HEAD']);
      git(['clone', '--quiet', '--local', donor, source]);
      writeFileSync(join(source, '.git/lint-as-committed-owner.json'), JSON.stringify({ sha, sourceRepoRoot: donor }));
      const metadata = 'apps/operator-public/node_modules/.mf';
      mkdirSync(join(donor, metadata), { recursive: true });
      mkdirSync(join(source, 'apps/operator-public/node_modules'), { recursive: true });
      symlinkSync(join(donor, metadata), join(source, metadata));
      mkdirSync(join(donor, 'node_modules'));
      writeFileSync(join(donor, 'acceptance.txt'), 'mutable donor source');
      const parent = { PAPERCUSP_REPO_DIR: source };
      const child = nativeVerifierEnv(parent, { repoRoot: source });
      const observed = JSON.parse(execFileSync(process.execPath, ['-e',
        'const cp=require("node:child_process");console.log(JSON.stringify({donor:process.env.PAPERCUSP_REPO_DIR,source:cp.execFileSync("git",["show",process.env.VERIFY_TAURI_SOURCE_REF+":acceptance.txt"],{encoding:"utf8"})}))'],
      { cwd: source, env: child, encoding: 'utf8' }));
      expect(observed).toEqual({ donor: realpathSync(donor), source: 'committed source' });
      expect(child.VERIFY_TAURI_SOURCE_REF).toBe(sha);
      expect(child.VERIFY_TAURI_SOURCE_INPUTS).toContain('apps/operator/bin/desktop-portal-native.test.ts');
      // The actual native21 launcher supplied only repair/config inputs. Its
      // passing receipt then lacked the product subjects required by the
      // completed-runtime certifier. Neither caller input channel may erase
      // those subjects, and caller-owned selectors must remain unchanged.
      for (const selection of [
        { VERIFY_TAURI_SOURCE_INPUTS: 'acceptance.txt,apps/operator/bin/desktop-portal-native.test.ts' },
        { VERIFY_TAURI_SOURCE_INPUTS_FILE: '/private/acceptance-inputs.txt' },
        { VERIFY_TAURI_SOURCE_INPUTS: 'acceptance.txt', VERIFY_TAURI_SOURCE_INPUTS_FILE: '/private/acceptance-inputs.txt' },
      ]) {
        const inherited = { ...parent, ...selection };
        const qualified = nativeVerifierEnv(inherited, { repoRoot: source });
        const inputs = qualified.VERIFY_TAURI_SOURCE_INPUTS!.split(',');
        expect(inputs).toEqual(expect.arrayContaining([
          'apps/operator-vite/desktop-portal-candidate.ts',
          'apps/operator-vite/desktop-portal-plugin.ts',
          'apps/operator/bin/desktop-portal-host.ts',
          'apps/operator/bin/desktop-portal-lifecycle.ts',
          'papercusp-desktop/src-tauri/src/env_switch.rs',
          'papercusp-desktop/src-tauri/src/main.rs',
          'apps/operator/bin/desktop-portal-native.test.ts',
          'apps/operator/vitest.e2e.config.ts',
          'packages/operator-core/lib/testing-native-runtime.ts',
          'scripts/lib/verify-tauri-native-env.mjs',
          'scripts/test-files.mjs',
          'scripts/verify-tauri-headless.sh',
        ]));
        expect(new Set(inputs).size).toBe(inputs.length);
        if (selection.VERIFY_TAURI_SOURCE_INPUTS) expect(inputs).toContain('acceptance.txt');
        expect(qualified.VERIFY_TAURI_SOURCE_INPUTS_FILE).toBe(selection.VERIFY_TAURI_SOURCE_INPUTS_FILE);
        expect(inherited).toEqual({ ...parent, ...selection });
      }
      expect(parent.PAPERCUSP_REPO_DIR).toBe(source);
      expect(lstatSync(join(source, metadata)).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(donor, metadata)).isDirectory()).toBe(true);
      expect(() => nativeVerifierEnv({ VERIFY_TAURI_SOURCE_REF: 'wrong' }, { repoRoot: source }))
        .toThrow('source ref must match');
      const noInstall = join(directory, 'not-installed');
      mkdirSync(noInstall);
      expect(() => nativeVerifierEnv({}, { repoRoot: noInstall })).toThrow('physical installed dependency donor');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves the rig allocation after parent setup without extending the inherited deadline', () => {
    const start = 1_000_000;
    const setupEnd = start + 115_000; // native14's measured readiness/PG setup
    const nativeMs = desktopPortalNativeTiming.nativeTimeoutMs;
    const parent = { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(start + 3_445_000) };
    const child = nativeVerifierEnv(parent, { timeoutMs: nativeMs, nowMs: setupEnd });
    expect(admitTaskDeadline({ env: child, nowMs: setupEnd, knownEstimateMs: 2_640_000 }))
      .toMatchObject({ remainingMs: nativeMs });
    expect(parent.PAPERCUSP_TASK_DEADLINE_EPOCH_MS).toBe(String(start + 3_445_000));
    const clipped = nativeVerifierEnv(parent, { timeoutMs: nativeMs, nowMs: start + 1_000_000 });
    expect(clipped.PAPERCUSP_TASK_DEADLINE_EPOCH_MS).toBe(parent.PAPERCUSP_TASK_DEADLINE_EPOCH_MS);
    expect(() => admitTaskDeadline({ env: clipped, nowMs: start + 1_000_000, knownEstimateMs: 2_640_000 }))
      .toThrow('TASK_DEADLINE_REFUSAL');
  });

  it('admits the composed parent budget and rejects an undersized parent before setup', () => {
    const start = 1_000_000;
    const total = desktopPortalNativeTestTimeoutMs();
    expect(total).toBe(desktopPortalNativeTiming.setupTimeoutMs
      + desktopPortalNativeTiming.nativeTimeoutMs + desktopPortalNativeTiming.cleanupTimeoutMs);
    const env = { PAPERCUSP_TEST_FILE_TIMEOUT_MS: String(total + 120_000),
      PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(start + total + 240_000) };
    expect(admitDesktopPortalNativeParent(env, start)).toMatchObject({ knownEstimateMs: total });
    expect(() => admitDesktopPortalNativeParent({ ...env,
      PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(start + 3_000_000) }, start)).toThrow('TASK_DEADLINE_REFUSAL');
    expect(() => admitDesktopPortalNativeParent({ ...env, PAPERCUSP_TEST_FILE_TIMEOUT_MS: '2880000' }, start))
      .toThrow('refusing before PostgreSQL or dependency copying');
  });

  it('preserves boot, assertion and cleanup reserves after the observed native19 preparation', () => {
    const start = 1_000_000;
    const child = nativeVerifierEnv({}, {
      timeoutMs: desktopPortalNativeTiming.nativeTimeoutMs, nowMs: start,
    });
    // Native19 spent 1,312,932ms preparing, then refused its remaining
    // 16-minute boot + 6-minute assertion + 2-minute cleanup forecast.
    expect(() => admitTaskDeadline({ env: child, nowMs: start + 1_312_932,
      knownEstimateMs: 1_440_000 })).not.toThrow();
  });

  it('accounts for calibrated preparation before admitting either parent clock', () => {
    const directory = mkdtempSync(join(tmpdir(), 'native-budget-calibration-'));
    try {
      const history = join(directory, 'phases.jsonl');
      writeFileSync(history, JSON.stringify({ phase: 'prepare', status: 'passed', elapsedMs: 1_745_443 }) + '\n');
      const env = { VERIFY_TAURI_BUDGET_FROM: history };
      const ordinary = desktopPortalNativeTestTimeoutMs({});
      const calibrated = desktopPortalNativeTestTimeoutMs(env);
      expect(calibrated).toBeGreaterThan(ordinary + 900_000);
      const start = 1_000_000;
      expect(() => admitDesktopPortalNativeParent({ ...env,
        PAPERCUSP_TEST_FILE_TIMEOUT_MS: String(ordinary + 120_000),
        PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(start + calibrated + 240_000),
      }, start)).toThrow('refusing before PostgreSQL or dependency copying');
      expect(() => admitDesktopPortalNativeParent({ ...env,
        PAPERCUSP_TEST_FILE_TIMEOUT_MS: String(calibrated + 120_000),
        PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(start + ordinary + 240_000),
      }, start)).toThrow('TASK_DEADLINE_REFUSAL');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('budgets configured boot retries and assertion work in the parent', () => {
    const ordinary = desktopPortalNativeTestTimeoutMs({});
    expect(desktopPortalNativeTestTimeoutMs({ VERIFY_TAURI_MAX_BOOT_ATTEMPTS: '4',
      VERIFY_TAURI_ASSERT_ESTIMATE_MS: '1800000' })).toBeGreaterThan(ordinary + 2_000_000);
  });

  it('keeps the parent unit rail active while the real child has no unit runner or fake census', () => {
    const parent = { ...process.env, PAPERCUSP_FORBID_REAL_PG: '1', VITEST: 'true',
      VITEST_WORKER_ID: '9', VITEST_POOL_ID: '2', PAPERCUSP_SID: 'test-owner',
      PAPERCUSP_RESTRICTED_HOLD_CENSUS_FILE: '/test-only-census.json',
      PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT: 'admitted-by-vitest',
      PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '123456789', PAPERCUSP_TEST_RUN_HARNESS: 'papercusp' };
    const child = nativeVerifierEnv(parent);
    const observed = JSON.parse(execFileSync(process.execPath, ['-e',
      'console.log(JSON.stringify({rail:process.env.PAPERCUSP_FORBID_REAL_PG??null,vitest:process.env.VITEST??null,owner:process.env.PAPERCUSP_SID}))'],
    { env: child, encoding: 'utf8' }));
    expect(observed).toEqual({ rail: null, vitest: null, owner: 'test-owner' });
    expect(parent.PAPERCUSP_FORBID_REAL_PG).toBe('1');
    expect(process.env.PAPERCUSP_FORBID_REAL_PG).toBe('1');
    expect(child.PAPERCUSP_RESTRICTED_HOLD_CENSUS_FILE).toBeUndefined();
    expect(child).toMatchObject({ PAPERCUSP_SID: 'test-owner',
      PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT: 'admitted-by-vitest',
      PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '123456789', PAPERCUSP_TEST_RUN_HARNESS: 'papercusp' });
  });

  it('actually runs the committed tree census even with inherited upstream admission', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: 'RESTRICTED_HOLD_PREFLIGHT {"verdict":"admit"}\n' }));
    preflightNativeVerifier(root, { VITEST: 'true', PAPERCUSP_FORBID_REAL_PG: '1',
      PAPERCUSP_WORKSPACE_ID: 'source-workspace',
      PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT: 'testing-run' }, spawn);
    expect(spawn).toHaveBeenCalledOnce();
    const [, args, options] = spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(args).toContain('--tree');
    expect(args.at(-1)).toBe(root);
    expect(args.join(' ')).toContain('committed-source-loader.mjs');
    expect(options.env.PAPERCUSP_FORBID_REAL_PG).toBeUndefined();
    expect(options.env.NODE_OPTIONS).toContain('committed-source-loader.mjs');
  });

  it.each([
    { PAPERCUSP_WORKSPACE_ID: 'explicit-source', PAPERCUSP_WORKSPACE: 'ambient-source',
      PAPERCUSP_TEST_RUN_WORKSPACE: 'ledger-source', expected: 'explicit-source' },
    { PAPERCUSP_WORKSPACE: 'ambient-source', PAPERCUSP_TEST_RUN_WORKSPACE: 'ledger-source',
      expected: 'ambient-source' },
    { PAPERCUSP_WORKSPACE_ID: ' ', PAPERCUSP_WORKSPACE: '',
      PAPERCUSP_TEST_RUN_WORKSPACE: 'ledger-source', expected: 'ledger-source' },
  ])('gives the real native child its source workspace after hermetic worker setup: %j', input => {
    const { expected, ...parent } = input;
    const child = nativeVerifierEnv(parent);
    const observed = execFileSync(process.execPath, ['-e',
      'process.stdout.write(process.env.PAPERCUSP_WORKSPACE_ID ?? "missing")'],
    { env: child, encoding: 'utf8' });
    expect(observed).toBe(expected);
    expect(parent.PAPERCUSP_WORKSPACE_ID).toBe(input.PAPERCUSP_WORKSPACE_ID);
  });

  it.each([{}, { PAPERCUSP_WORKSPACE_ID: ' ', PAPERCUSP_WORKSPACE: '',
    PAPERCUSP_TEST_RUN_WORKSPACE: '\t' }])('refuses missing workspace before the expensive census: %j', env => {
    const spawn = vi.fn(() => ({ status: 0, stdout: 'RESTRICTED_HOLD_PREFLIGHT {"verdict":"admit"}\n' }));
    expect(() => preflightNativeVerifier(root, env, spawn)).toThrow('Native verifier requires a source workspace');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    { status: 3, stdout: 'RESTRICTED_HOLD_PREFLIGHT {"verdict":"refuse","error":"restricted_write_held","hint":"held input"}\n' },
    { status: 3, stdout: 'RESTRICTED_HOLD_PREFLIGHT {"verdict":"refuse","error":"restricted_hold_state_unknown","hint":"database unavailable"}\n' },
    { status: 0, stdout: '' },
    { status: null, signal: 'SIGTERM' },
  ])('refuses native preparation on an unsafe or unavailable census: %j', result => {
    expect(() => preflightNativeVerifier(root, { PAPERCUSP_WORKSPACE_ID: 'source-workspace' }, () => result))
      .toThrow('Native verifier census is not ready');
  });

  it('checks readiness before PostgreSQL creation and uses the child environment at native launch', () => {
    const test = readFileSync(resolve(root, 'apps/operator/bin/desktop-portal-persistence.test.ts'), 'utf8');
    expect(test.indexOf("[nativeEnvHelper, '--preflight', repo]")).toBeLessThan(test.indexOf("join(pg, 'initdb')"));
    expect(test.indexOf('VERIFY_TAURI_CANDIDATE_MANIFEST_SHA256:'))
      .toBeLessThan(test.indexOf("[nativeEnvHelper, '--preflight', repo]"));
    expect(test).toContain("env: { ...nativeEnv(), VERIFY_TAURI_ISOLATED_DB: '1'");
  });
});
