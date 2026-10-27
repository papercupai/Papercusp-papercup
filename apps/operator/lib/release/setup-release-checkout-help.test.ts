/**
 * Regression coverage for setup-release-checkout.sh's `--help` path
 * (EI-24760202132078287).
 *
 * `--help` used to fall through the arg parser to `unknown arg: --help` and exit 2,
 * so an operator had no safe way to discover the CLI without reading its parser.
 * Locked here: `-h`/`--help` exits 0, prints the header's usage block, and touches
 * nothing — the release root is never created, even when it is the only arg that
 * would otherwise be acted on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const SCRIPT_PATH =
  process.env.PROBE_SCRIPT ?? join(__dirname, '../../bin/release/setup-release-checkout.sh');

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'setup-release-help-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function run(...args: string[]) {
  const releaseRoot = join(scratch, 'release');
  const r = spawnSync('bash', [SCRIPT_PATH, ...args, '--release', releaseRoot], {
    cwd: scratch,
    encoding: 'utf8',
    // A non-repo integration root: any path past usage handling would fail on it.
    env: { ...process.env, PAPERCUSP_INTEGRATION_ROOT: scratch },
  });
  return { ...r, releaseRoot };
}

describe('setup-release-checkout.sh --help', () => {
  it.each(['--help', '-h'])('%s prints usage, exits 0 and touches nothing', (flag) => {
    const r = run(flag);
    expect(r.stderr).not.toContain('unknown arg');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
    expect(r.stdout).toContain('setup-release-checkout.sh [--ref <commit-ish>]');
    expect(r.stdout).toContain('--source-integrity allow-live-tree|object-sourced');
    expect(r.stdout).toContain('Env overrides: PAPERCUSP_INTEGRATION_ROOT, PAPERCUSP_RELEASE_ROOT.');
    expect(r.stdout).not.toContain('[setup-release]');
    expect(existsSync(r.releaseRoot)).toBe(false);
  });

  it('documents every flag the parser accepts', () => {
    const r = run('--help');
    for (const flag of [
      '--ref', '--node-modules', '--node-modules-copy', '--node-modules-generation',
      '--node-modules-generation-id', '--node-modules-generation-token',
      '--node-modules-workspace-dir', '--dependency-generation-root', '--source-integrity',
      '--integration', '--release', '--build-spa', '--prepare-existing', '--source-only',
      '--dependencies-only',
    ]) {
      expect(r.stdout).toContain(`[${flag}`);
    }
  });

  it('still rejects a genuinely unknown arg with exit 2', () => {
    const r = run('--bogus');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown arg: --bogus');
  });
});

describe('setup-release-checkout.sh execution source', () => {
  it('finishes the original pinned clone after its script is rewritten during allocation wait', async () => {
    const integration = join(scratch, 'integration');
    const release = join(scratch, 'release');
    const fixtureScript = join(scratch, 'setup-release-checkout.sh');
    mkdirSync(integration);
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'source-read-test', GIT_COMMITTER_NAME: 'source-read-test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_EMAIL: 'test@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    };
    function git(...args: string[]) {
      const result = spawnSync('git', ['-C', integration, ...args], { encoding: 'utf8', env: gitEnv });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    }
    git('init', '-q');
    writeFileSync(join(integration, 'pinned.txt'), 'immutable source\n');
    git('add', 'pinned.txt');
    git('commit', '-qm', 'source fixture');
    const pin = git('rev-parse', 'HEAD');
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    writeFileSync(fixtureScript, source);
    // Replace only resource arbitration with a handshake. The shipped script
    // still performs its real preflight, clone and exact-HEAD/source-only checks.
    writeFileSync(join(scratch, 'dependency-generation.sh'), [
      'dependency_generation_record_reserve_fs() { :; }',
      'dependency_generation_check_headroom() { :; }',
      'dependency_generation_release_selector_lease() { :; }',
      'dependency_generation_acquire_copy_lock() {',
      '  printf "FIXTURE_COPY_LOCK_WAIT\\n"',
      '  IFS= read -r _fixture_release',
      '}',
    ].join('\n'));
    const child = spawn('bash', [fixtureScript, '--integration', integration,
      '--release', release, '--ref', pin, '--source-only', '--source-root-mode', 'clone',
      '--source-integrity', 'object-sourced'], { env: gitEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let rewritten = false;
    let rewriteError: unknown;
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (!rewritten && stdout.includes('FIXTURE_COPY_LOCK_WAIT\n')) {
        rewritten = true;
        try {
          // Overwrite the SAME inode, across every possible buffered read offset.
          // An unguarded Bash reader resumes in these bytes and cannot finish.
          writeFileSync(fixtureScript, 'exit 97\n'.repeat(source.length));
          child.stdin.end('continue\n');
        } catch (error) {
          rewriteError = error;
          child.kill('SIGKILL');
        }
      }
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try {
      const status = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      expect(rewriteError).toBeUndefined();
      expect(rewritten, stdout + stderr).toBe(true);
      expect(status, stdout + stderr).toBe(0);
      expect(stdout).toContain(`SETUP_RELEASE_SOURCE_ONLY ref=${pin} sha=${pin} status=ready`);
      expect(readFileSync(join(release, 'pinned.txt'), 'utf8')).toBe('immutable source\n');
      const head = spawnSync('git', ['-C', release, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: gitEnv });
      expect(head.status, head.stderr).toBe(0);
      expect(head.stdout.trim()).toBe(pin);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 20_000);
});
