import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectChildOutput } from '@papercusp/operator-core/lib/child-output';

const WRAPPER = resolve(__dirname, '..', 'systemd', 'papercusp-script-snapshot.sh');
const DB_UNIT = resolve(__dirname, '..', 'systemd', 'papercusp-db-backup.service');
const HEALTH_UNIT = resolve(__dirname, '..', 'systemd', 'papercup-backup-health.service');
const STAGING_DROPIN = resolve(__dirname, '..', 'systemd', 'papercup-staging-sync.service.d', '50-script-snapshot.conf');

async function writeExecutable(path: string, body: string) {
  await writeFile(path, body);
  await chmod(path, 0o755);
}

async function runWrapper(cwd: string, args: string[], extraEnv: Record<string, string> = {}, unset: string[] = []) {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: cwd, ...extraEnv };
  delete env.PAPERCUSP_SCRIPT_SNAPSHOT_SELF_COPIED;
  delete env.PAPERCUSP_SCRIPT_SNAPSHOT_SELF_DIR;
  for (const name of unset) delete env[name];

  return await new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolveResult, reject) => {
      const child = spawn('bash', [WRAPPER, ...args], { cwd, env });
      const output = collectChildOutput(child);
      child.once('error', reject);
      child.once('close', (status) =>
        resolveResult({ status, stdout: output.stdout.text(), stderr: output.stderr.text() }),
      );
    },
  );
}

// A wall-clock deadline, not an attempt count: 100 x 10ms gave a nested bash
// ~1s to start, which the gate's loaded host missed (verify 079f459e, 8c666117).
async function waitForFile(path: string, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolveResult) => setTimeout(resolveResult, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

// A PATH shim that counts sha256sum launches. `perturbFirstBatch` corrupts the first
// multi-file call's output, which is what a helper edited mid-copy looks like to the batch.
async function sha256Shim(root: string, perturbFirstBatch = false) {
  const shim = join(root, 'shim');
  await mkdir(shim);
  const log = join(root, 'sha256sum.log');
  const real = spawnSync('bash', ['-c', 'command -v sha256sum'], { encoding: 'utf8' }).stdout.trim();
  expect(real).not.toBe('');
  const perturb = perturbFirstBatch
    ? `if [ "$#" -gt 2 ] && [ ! -e "${log}.perturbed" ]; then : > "${log}.perturbed"; "${real}" "$@"; echo changed; exit 0; fi\n`
    : '';
  await writeExecutable(join(shim, 'sha256sum'), `#!/usr/bin/env bash\necho "$#" >> "${log}"\n${perturb}exec "${real}" "$@"\n`);
  return { env: { PATH: `${shim}:${process.env.PATH}` }, launches: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).length };
}

async function helperFixture(root: string) {
  const bin = join(root, 'bin');
  await mkdir(join(bin, 'lib'), { recursive: true });
  for (let i = 0; i < 40; i++) await writeFile(join(bin, `helper-${i}.sh`), `echo helper-${i}\n`);
  for (let i = 0; i < 10; i++) await writeFile(join(bin, 'lib', `lib-${i}.sh`), `echo lib-${i}\n`);
  const target = join(bin, 'target.sh');
  await writeExecutable(
    target,
    '#!/usr/bin/env bash\nhere="$(dirname "${BASH_SOURCE[0]}")"\ncase "$here" in */bin) echo UNSNAPSHOTTED; exit 9;; esac\nsource "$here/helper-0.sh"\nsource "$here/helper-39.sh"\nsource "$here/lib/lib-9.sh"\n',
  );
  return target;
}

describe('papercusp-script-snapshot.sh', () => {
  it('copies many adjacent helpers with a bounded number of hash processes (WI-10006358)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'script-snapshot-batch-'));
    try {
      const shim = await sha256Shim(root);
      const result = await runWrapper(root, [await helperFixture(root)], shim.env);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('helper-0\nhelper-39\nlib-9\n');
      // Per-file copying launched 3 hashes per helper (150 for these 50). Batching keeps the
      // count constant: 3 for the launcher self-copy, 3 for the target, 1 for its identity,
      // and 3 per helper directory.
      expect(await shim.launches()).toBeLessThanOrEqual(13);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to per-file copying when a batch hash disagrees, still snapshotting every helper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'script-snapshot-batch-fallback-'));
    try {
      const shim = await sha256Shim(root, true);
      const result = await runWrapper(root, [await helperFixture(root)], shim.env);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('helper-0\nhelper-39\nlib-9\n');
      // The perturbed directory was re-copied file by file (3 hashes each for 40 helpers).
      expect(await shim.launches()).toBeGreaterThan(120);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('routes staging sync and its mutable setup script through the shared snapshot launcher', async () => {
    const dropin = await readFile(STAGING_DROPIN, 'utf8');
    expect(dropin).toContain('ExecStart=\nExecStart=/usr/bin/bash ');
    expect(dropin).toMatch(/ExecStart=.*papercusp-script-snapshot\.sh .*sync-staging-checkout\.sh/);
    const script = await readFile(resolve(__dirname, '../../bin/release/sync-staging-checkout.sh'), 'utf8');
    expect(script).toMatch(/snapshot_script="\$INTEGRATION_ROOT\/apps\/operator\/scripts\/systemd\/papercusp-script-snapshot\.sh"/);
    expect(script).toMatch(/setup_script="\$INTEGRATION_ROOT\/apps\/operator\/bin\/release\/setup-release-checkout\.sh"/);
    expect(script).toMatch(/\bbash "\$snapshot_script" "\$setup_script"/);
    // setup-release-checkout must never be exec'd directly, bypassing the snapshot.
    expect(script).not.toMatch(/^\s*(?:bash\s+)?"\$setup_script"/m);
  });

  it.each([false, true])('distinguishes lazy source mutation with snapshot=%s', async (snapshot) => {
    const dir = await mkdtemp(join(tmpdir(), 'staging-script-live-edit-'));
    try {
      const target = join(dir, 'sync.sh');
      const ready = join(dir, 'ready');
      const release = join(dir, 'release');
      expect(spawnSync('mkfifo', [release]).status).toBe(0);
      await writeExecutable(target, [
        '#!/usr/bin/env bash',
        'printf ready > "$READY_FILE"',
        'read -r token < "$RELEASE_PIPE"',
        '# padding beyond the parser buffer\n'.repeat(10000),
        'echo ORIGINAL',
      ].join('\n'));
      const child = spawn('bash', snapshot ? [WRAPPER, target] : [target], {
        cwd: dir, env: { ...process.env, TMPDIR: dir, READY_FILE: ready, RELEASE_PIPE: release },
      });
      const output = collectChildOutput(child);
      const finished = new Promise<number | null>((done, reject) => {
        child.once('error', reject);
        child.once('close', done);
      });
      try {
        await waitForFile(ready);
        await writeExecutable(target, '#!/usr/bin/env bash\necho MUTATED\n');
        await writeFile(release, 'resume\n');
        const status = await finished;
        if (snapshot) {
          expect(status).toBe(0);
          expect(output.stdout.text().trim()).toBe('ORIGINAL');
        } else {
          expect(output.stdout.text()).not.toContain('ORIGINAL');
        }
      } finally {
        child.kill('SIGKILL');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the systemd ExecStart wrapper executable', async () => {
    expect((await stat(WRAPPER)).mode & 0o111).toBe(0o111);
  });

  it('passes bash syntax validation', () => {
    const result = spawnSync('bash', ['-n', WRAPPER], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toBe('');
  });

  it('keeps a sourced adjacent helper available and frozen during a long setup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'papercusp-adjacent-helper-'));
    try {
      const target = join(dir, 'setup-release-checkout.sh');
      const helper = join(dir, 'dependency-generation.sh');
      const ready = join(dir, 'ready');
      const release = join(dir, 'release');
      expect(spawnSync('mkfifo', [release]).status).toBe(0);
      await writeExecutable(helper, 'SNAPSHOT_VALUE=ORIGINAL\n');
      await writeExecutable(target, [
        '#!/usr/bin/env bash',
        'printf ready > "$READY_FILE"',
        'read -r token < "$RELEASE_PIPE"',
        'source "$(dirname "${BASH_SOURCE[0]}")/dependency-generation.sh"',
        'printf "%s\\n" "$SNAPSHOT_VALUE"',
      ].join('\n'));
      const run = runWrapper(dir, [target], { READY_FILE: ready, RELEASE_PIPE: release });
      await waitForFile(ready);
      await writeExecutable(helper, 'SNAPSHOT_VALUE=MUTATED\n');
      await writeFile(release, 'resume\n');
      const result = await run;
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('ORIGINAL');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps an adjacent .mjs helper available and frozen during a long setup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'papercusp-adjacent-mjs-helper-'));
    try {
      const target = join(dir, 'setup-release-checkout.sh');
      const helper = join(dir, 'pinned-lock-deps.mjs');
      const ready = join(dir, 'mjs.ready');
      const release = join(dir, 'release');
      expect(spawnSync('mkfifo', [release]).status).toBe(0);
      await writeFile(helper, 'console.log("MJS_ORIGINAL")\n');
      await writeExecutable(target, [
        '#!/usr/bin/env bash',
        'set -u',
        'printf ready > "$READY_FILE"',
        'read -r token < "$RELEASE_PIPE"',
        'node "$(dirname "${BASH_SOURCE[0]}")/pinned-lock-deps.mjs"',
      ].join('\n'));

      const run = runWrapper(dir, [target], { READY_FILE: ready, RELEASE_PIPE: release });
      await waitForFile(ready);
      await writeFile(helper, 'console.log("MJS_MUTATED")\n');
      await writeFile(release, 'resume\n');

      const result = await run;
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('MJS_ORIGINAL');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps a long-running target on the pre-edit byte snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'papercusp-script-snapshot-test-'));
    try {
      const target = join(dir, 'target.sh');
      const ready = join(dir, 'target.ready');
      await writeExecutable(
        target,
        `#!/usr/bin/env bash
set -u
printf ready > "$READY_FILE"
sleep 0.2
grep -q ORIGINAL "$0" && echo ORIGINAL || echo MUTATED
`,
      );

      const run = runWrapper(dir, [target], { READY_FILE: ready });
      await waitForFile(ready);
      await writeExecutable(
        target,
        `#!/usr/bin/env bash
set -u
echo MUTATED
`,
      );

      const result = await run;
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('ORIGINAL');
      expect(await readFile(target, 'utf8')).toContain('MUTATED');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exports the primary source path and hash of the exact target snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'papercusp-script-snapshot-identity-'));
    try {
      const target = join(dir, 'target.sh');
      const body = [
        '#!/usr/bin/env bash',
        'set -u',
        'printf "source=%s\\n" "$PAPERCUSP_SCRIPT_SNAPSHOT_SOURCE_PATH"',
        'printf "hash=%s\\n" "$PAPERCUSP_SCRIPT_SNAPSHOT_SOURCE_SHA256"',
        'sha256sum -- "$0" | awk \'{print "executed_sha=" $1}\'',
        '',
      ].join('\n');
      await writeExecutable(target, body);
      const expectedSha = createHash('sha256').update(body).digest('hex');

      const result = await runWrapper(
        dir,
        [target],
        {
          PAPERCUSP_SCRIPT_SNAPSHOT_SOURCE_PATH: '/stale/inherited-source.sh',
          PAPERCUSP_SCRIPT_SNAPSHOT_SOURCE_SHA256: 'stale-inherited-hash',
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('source=' + target);
      expect(result.stdout).toContain('hash=' + expectedSha);
      expect(result.stdout).toContain('executed_sha=' + expectedSha);
      expect(result.stderr).toContain('[script-snapshot] target source=' + target + ' sha256=' + expectedSha);
      expect(result.stdout).not.toContain('stale/inherited-source.sh');
      expect(result.stdout).not.toContain('stale-inherited-hash');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rewrites nested shell arguments instead of passing mutable source paths through', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'papercusp-script-snapshot-nested-'));
    try {
      const guard = join(dir, 'guard.sh');
      const nested = join(dir, 'nested.sh');
      await writeExecutable(
        guard,
        `#!/usr/bin/env bash
set -u
[ "$1" = "--" ] || exit 64
shift
bash "$1"
`,
      );
      await writeExecutable(
        nested,
        `#!/usr/bin/env bash
set -u
printf ready > "$READY_FILE"
sleep 0.2
grep -q NESTED_ORIGINAL "$0" && echo NESTED_ORIGINAL || echo NESTED_MUTATED
`,
      );

      const ready = join(dir, 'nested.ready');
      const run = runWrapper(dir, [guard, '--', nested], { READY_FILE: ready });
      await waitForFile(ready);
      await writeExecutable(
        nested,
        `#!/usr/bin/env bash
set -u
echo NESTED_MUTATED
`,
      );

      const result = await run;
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('NESTED_ORIGINAL');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves adjacent lib shell sidecars for scripts that source them via BASH_SOURCE', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'papercusp-script-snapshot-sidecar-'));
    try {
      const sourceDir = join(dir, 'source');
      const libDir = join(sourceDir, 'lib');
      const target = join(sourceDir, 'health.sh');
      await mkdir(libDir, { recursive: true });
      await writeExecutable(
        join(libDir, 'red-marker.sh'),
        `MARKER_VALUE=SIDECAR_ORIGINAL
`,
      );
      await writeExecutable(
        target,
        `#!/usr/bin/env bash
set -u
. "$(dirname "$0")/lib/red-marker.sh"
printf ready > "$READY_FILE"
sleep 0.2
printf '%s\\n' "$MARKER_VALUE"
`,
      );

      const ready = join(dir, 'sidecar.ready');
      const run = runWrapper(dir, [target], { READY_FILE: ready });
      await waitForFile(ready);
      await writeExecutable(join(libDir, 'red-marker.sh'), 'MARKER_VALUE=SIDECAR_MUTATED\n');

      const result = await run;
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('SIDECAR_ORIGINAL');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * EI-25898717052240161: with PAPERCUSP_SCRIPT_SNAPSHOT_GIT_REF the target and its helpers
   * come from the commit, so an uncommitted edit never goes live in a unit that deploys
   * committed code (staging-sync froze :3170 for 2.5 h on 2026-10-13 that way).
   */
  describe('committed-source mode (EI-25898717052240161)', () => {
    const GIT_UNSET = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR'];
    const git = (cwd: string, ...args: string[]) => {
      const env = { ...process.env };
      for (const name of GIT_UNSET) delete env[name];
      const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd, env, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };

    /** A repo whose committed target/helpers print COMMITTED, then edited in the working tree. */
    async function editedRepo(dir: string) {
      const repo = join(dir, 'repo');
      const sourceDir = join(repo, 'bin');
      await mkdir(join(sourceDir, 'lib'), { recursive: true });
      const target = join(sourceDir, 'deploy.sh');
      const body = (tag: string) => `#!/usr/bin/env bash
set -u
. "$(dirname "$0")/lib/marker.sh"
. "$(dirname "$0")/helper.sh"
printf '%s %s %s\\n' "${tag}" "$LIB_MARKER" "$HELPER_MARKER"
`;
      await writeExecutable(target, body('COMMITTED'));
      await writeExecutable(join(sourceDir, 'lib', 'marker.sh'), 'LIB_MARKER=LIB_COMMITTED\n');
      await writeExecutable(join(sourceDir, 'helper.sh'), 'HELPER_MARKER=HELPER_COMMITTED\n');
      git(dir, 'init', '-q', '-b', 'staging', repo);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'base');
      await writeExecutable(target, body('WORKTREE'));
      await writeExecutable(join(sourceDir, 'lib', 'marker.sh'), 'LIB_MARKER=LIB_WORKTREE\n');
      await writeExecutable(join(sourceDir, 'helper.sh'), 'HELPER_MARKER=HELPER_WORKTREE\n');
      return { repo, target };
    }

    it('runs the committed target, adjacent helper and lib sidecar instead of the edited working tree', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'papercusp-script-snapshot-gitref-'));
      try {
        const { target } = await editedRepo(dir);
        const result = await runWrapper(dir, [target], { PAPERCUSP_SCRIPT_SNAPSHOT_GIT_REF: 'staging' }, GIT_UNSET);
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe('COMMITTED LIB_COMMITTED HELPER_COMMITTED');
        expect(result.stderr).toMatch(/bin\/deploy\.sh: working tree differs from staging@[0-9a-f]{10}; running the committed version/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('CONTROL: without the opt-in the working-tree edit is what runs', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'papercusp-script-snapshot-gitref-'));
      try {
        const { target } = await editedRepo(dir);
        const result = await runWrapper(dir, [target], {}, [...GIT_UNSET, 'PAPERCUSP_SCRIPT_SNAPSHOT_GIT_REF']);
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe('WORKTREE LIB_WORKTREE HELPER_WORKTREE');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('falls back to the working-tree copy, with a log line, when the target is not in the ref', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'papercusp-script-snapshot-gitref-'));
      try {
        const { repo } = await editedRepo(dir);
        const fresh = join(repo, 'bin', 'fresh.sh');
        await writeExecutable(fresh, '#!/usr/bin/env bash\necho UNCOMMITTED_NEW_SCRIPT\n');
        const result = await runWrapper(dir, [fresh], { PAPERCUSP_SCRIPT_SNAPSHOT_GIT_REF: 'staging' }, GIT_UNSET);
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe('UNCOMMITTED_NEW_SCRIPT');
        expect(result.stderr).toMatch(/bin\/fresh\.sh is not in staging@[0-9a-f]{10}; using the working-tree copy/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('does not pass the opt-in to the target, so nested launches keep their own behaviour', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'papercusp-script-snapshot-gitref-'));
      try {
        const { repo } = await editedRepo(dir);
        const probe = join(repo, 'bin', 'env-probe.sh');
        await writeExecutable(probe, '#!/usr/bin/env bash\nprintf "ref=[%s]\\n" "${PAPERCUSP_SCRIPT_SNAPSHOT_GIT_REF:-}"\n');
        git(repo, 'add', '-A');
        git(repo, 'commit', '-q', '-m', 'probe');
        const result = await runWrapper(dir, [probe], { PAPERCUSP_SCRIPT_SNAPSHOT_GIT_REF: 'staging' }, GIT_UNSET);
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe('ref=[]');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('opts the staging-sync unit in to the committed staging lineage', async () => {
      const dropin = await readFile(STAGING_DROPIN, 'utf8');
      expect(dropin).toMatch(/^Environment=PAPERCUSP_SCRIPT_SNAPSHOT_GIT_REF=staging$/m);
    });
  });

  it('routes both backup units through the snapshot wrapper, including the DB guard target', async () => {
    const dbUnit = await readFile(DB_UNIT, 'utf8');
    const healthUnit = await readFile(HEALTH_UNIT, 'utf8');

    expect(dbUnit).toMatch(
      /^ExecStart=.*papercusp-script-snapshot\.sh .*kopia-backup-guard\.sh .*-- .*papercusp-db-backup\.sh$/m,
    );
    expect(healthUnit).toMatch(
      /^ExecStart=.*papercusp-script-snapshot\.sh .*papercup-backup-health-check\.sh$/m,
    );
    expect(healthUnit).not.toContain('kopia-backup-guard.sh');
  });
});

// ── Census (WI-10006315) ─────────────────────────────────────────────────────
// The per-unit assertions above cover only the units their authors hit. This census
// covers the CLASS: every tracked unit Exec* line that runs a shell script out of the
// shared tree (an absolute %h/papercupai-workspace/papercusp/… path, or a relative one
// under a shared-tree WorkingDirectory) must go through papercusp-script-snapshot.sh,
// because bash reads scripts lazily and an agent's edit landing mid-run changes the
// program being executed. Installed copies (/usr/local, /etc, ~/.config/kopia) and the
// separate papercusp-staging.current checkout are not exposed, so they are not counted.
//
// UNWRAPPED_ALLOWLIST is SHRINK-ONLY: a new unwrapped unit fails the census, and
// wrapping an allowlisted one fails the stale-entry check until its entry is deleted.

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const SHARED_TREE_PREFIX = '%h/papercupai-workspace/papercusp/';
const LAUNCHER_REL = 'apps/operator/scripts/systemd/papercusp-script-snapshot.sh';

// Empty since WI-10006398 wrapped the two bundle-host.sh units. Keep it empty: add an entry
// only with a reason the script cannot run from a snapshot, and a work-item to fix that.
const UNWRAPPED_ALLOWLIST: Record<string, string> = {};

type ExecFinding = { key: string; wrapped: boolean; scripts: string[] };

const EXEC_LINE = /^(Exec(?:Start|StartPre|StartPost|Stop|StopPost|Reload|Condition))=(.*)$/;
const SHELL_TOKEN = /[^\s'"=;]+\.sh\b/g;

function workingDirectoryOf(text: string): string | undefined {
  let dir: string | undefined;
  for (const line of text.split('\n')) {
    const match = /^WorkingDirectory=-?(.*)$/.exec(line.trim());
    if (match) dir = match[1].trim();
  }
  return dir;
}

function sharedTreeRel(token: string, workDir: string | undefined): string | null {
  const path = token.replace(/^[-@:+!|]+/, '');
  if (path.startsWith(SHARED_TREE_PREFIX)) return posix.normalize(path.slice(SHARED_TREE_PREFIX.length));
  if (/^[/%$]/.test(path)) return null; // installed copy, another checkout, or an unexpanded variable
  const base = workDir ? workDir.replace(/\/+$/, '') + '/' : '';
  if (!base.startsWith(SHARED_TREE_PREFIX)) return null;
  return posix.normalize(posix.join(base.slice(SHARED_TREE_PREFIX.length), path));
}

function classifyUnitExecLines(unitPath: string, text: string, inheritedWorkDir?: string): ExecFinding[] {
  const workDir = workingDirectoryOf(text) ?? inheritedWorkDir;
  const findings: ExecFinding[] = [];
  for (const line of text.replace(/\\\n/g, ' ').split('\n')) {
    const match = EXEC_LINE.exec(line.trim());
    if (!match || !match[2].trim()) continue;
    const rels = [...match[2].matchAll(SHELL_TOKEN)]
      .map((token) => sharedTreeRel(token[0], workDir))
      .filter((rel): rel is string => rel !== null);
    const script = rels.find((rel) => rel !== LAUNCHER_REL);
    if (!script) continue;
    const launcherAt = rels.indexOf(LAUNCHER_REL);
    findings.push({
      key: `${unitPath} ${match[1]} ${script}`,
      wrapped: launcherAt !== -1 && launcherAt < rels.indexOf(script),
      scripts: rels.filter((rel) => rel !== LAUNCHER_REL),
    });
  }
  return findings;
}

async function censusTrackedUnits(): Promise<ExecFinding[]> {
  const listed = spawnSync('git', ['ls-files', '-z', '--', '*.service', '*.service.tmpl', '*.service.d/*.conf'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  expect(listed.status, listed.stderr).toBe(0);
  const units = listed.stdout.split('\0').filter(Boolean);
  // Enumeration control: an empty or truncated listing must not read as "no unwrapped units".
  expect(units.length).toBeGreaterThan(50);
  const findings: ExecFinding[] = [];
  for (const unit of units) {
    const text = await readFile(join(REPO_ROOT, unit), 'utf8').catch(() => null);
    if (text === null) continue; // tracked but deleted in this working tree
    const dropIn = /^(.*\.service)\.d\/[^/]+\.conf$/.exec(unit);
    const inherited = dropIn
      ? workingDirectoryOf(await readFile(join(REPO_ROOT, dropIn[1]), 'utf8').catch(() => ''))
      : undefined;
    findings.push(...classifyUnitExecLines(unit, text, inherited));
  }
  return findings;
}

describe('systemd unit census: shared-tree scripts run from a snapshot (WI-10006315)', () => {
  it('classifies unit exec lines (calibration for the census below)', () => {
    const launcher = SHARED_TREE_PREFIX + LAUNCHER_REL;
    const unit = [
      '[Service]',
      '# ExecStart=%h/papercupai-workspace/papercusp/bin/commented-out.sh',
      `ExecStart=${SHARED_TREE_PREFIX}bin/direct.sh --flag`,
      `ExecStartPre=-${launcher} ${SHARED_TREE_PREFIX}bin/wrapped.sh`,
      'ExecStart=/usr/local/lib/papercusp/installed.sh',
      'ExecStart=%h/.config/kopia/healthcheck.sh',
      'ExecStartPost=/usr/bin/bash %h/papercupai-workspace/papercusp-staging.current/x.sh',
      'ExecStop=',
    ].join('\n');
    expect(classifyUnitExecLines('u.service', unit)).toEqual([
      { key: 'u.service ExecStart bin/direct.sh', wrapped: false, scripts: ['bin/direct.sh'] },
      { key: 'u.service ExecStartPre bin/wrapped.sh', wrapped: true, scripts: ['bin/wrapped.sh'] },
    ]);
    // Every shared-tree script on the line is recorded, so a target behind a wrapper prefix
    // (pc-heavy.sh -- … gate.sh) is still visible to the self-climb check below.
    const prefixed = `ExecStart=${launcher} ${SHARED_TREE_PREFIX}scripts/pc-heavy.sh -- /usr/bin/env bash bin/gate.sh`;
    expect(classifyUnitExecLines('p.service', prefixed, SHARED_TREE_PREFIX + 'papercusp-desktop')).toEqual([
      {
        key: 'p.service ExecStart scripts/pc-heavy.sh',
        wrapped: true,
        scripts: ['scripts/pc-heavy.sh', 'papercusp-desktop/bin/gate.sh'],
      },
    ]);
    // A relative script counts only under a shared-tree WorkingDirectory (its own or the base unit's).
    const relative = "ExecStartPre=/usr/bin/bash -c 'exec bin/bundle.sh'";
    expect(classifyUnitExecLines('r.service', relative, SHARED_TREE_PREFIX + 'apps/operator')).toEqual([
      { key: 'r.service ExecStartPre apps/operator/bin/bundle.sh', wrapped: false, scripts: ['apps/operator/bin/bundle.sh'] },
    ]);
    expect(classifyUnitExecLines('r.service', relative, '%h/windows-vm')).toEqual([]);
    // The launcher must PRECEDE the script; naming it after the target wraps nothing.
    expect(classifyUnitExecLines('a.service', `ExecStart=${SHARED_TREE_PREFIX}bin/t.sh ${launcher}`)).toEqual([
      { key: 'a.service ExecStart bin/t.sh', wrapped: false, scripts: ['bin/t.sh'] },
    ]);
  });

  it('routes every tracked shared-tree script through the launcher, or allowlists it with a reason', async () => {
    const findings = await censusTrackedUnits();
    // Positive control: units known to be wrapped must be seen as wrapped, or a broken
    // classifier that finds nothing would pass the checks below vacuously.
    expect(findings.filter((f) => f.wrapped).map((f) => f.key)).toEqual(
      expect.arrayContaining([
        'apps/operator/scripts/systemd/papercusp-db-backup.service ExecStart apps/operator/scripts/systemd/kopia-backup-guard.sh',
        'infra/estate-backup/pc-estate-mirror.service ExecStart infra/estate-backup/pc-estate-mirror.sh',
        'infra/estate-backup/pc-mirror-restore-drill.service ExecStart infra/estate-backup/pc-mirror-restore-drill.sh',
      ]),
    );
    const unwrapped = findings.filter((f) => !f.wrapped).map((f) => f.key);
    expect(
      unwrapped.filter((key) => !(key in UNWRAPPED_ALLOWLIST)),
      'these units run a shared-tree .sh directly: wrap them with papercusp-script-snapshot.sh, after checking the script for non-.sh/.mjs files it reads beside itself',
    ).toEqual([]);
    expect(
      Object.keys(UNWRAPPED_ALLOWLIST).filter((key) => !unwrapped.includes(key)),
      'allowlist entries no longer measured: delete them (the allowlist is shrink-only)',
    ).toEqual([]);
    for (const [key, reason] of Object.entries(UNWRAPPED_ALLOWLIST)) expect(reason.length, key).toBeGreaterThan(40);
  });
});

// ── Wrapped scripts must not find the checkout from their own path (WI-10006358) ──
// The launcher runs a COPY under $TMPDIR, so a path climbed out of the script's own
// directory (BASH_SOURCE / $0 / SELF_DIR / _HERE + "/..") lands in the temp dir, not the
// checkout: the script runs, finds nothing beside it, and fails or silently no-ops.
// Wrapping is only correct when every such climb is the fallback of a ${NAME:-…}
// override whose NAME the unit pins with Environment=NAME=…. SELF_CLIMB_ALLOWLIST is
// shrink-only, like the census allowlist above.

const SELF_CLIMB = /(BASH_SOURCE|\$0\b|\b_HERE\b|SELF_DIR|SCRIPT_DIR)[^#]*\/\.\.(?![.\w])/;

const SELF_CLIMB_ALLOWLIST: Record<string, string> = {
  'apps/operator/scripts/systemd/papercup-staging-sync.service.d/50-script-snapshot.conf apps/operator/bin/release/sync-staging-checkout.sh':
    '_REPO_DEFAULT is only the fallback of ${PAPERCUSP_INTEGRATION_ROOT:-…}; the installed base unit papercup-staging-sync.service is generated outside this tree and pins that variable to the canonical checkout.',
};

function isSelfClimb(line: string): boolean {
  return !line.trimStart().startsWith('#') && SELF_CLIMB.test(line);
}

function pinnedEnvironment(...unitTexts: string[]): Set<string> {
  const names = new Set<string>();
  for (const text of unitTexts) {
    for (const line of text.split('\n')) {
      const value = /^Environment=(.*)$/.exec(line.trim())?.[1];
      if (value) for (const m of value.matchAll(/(?:^|\s)"?([A-Za-z_]\w*)=/g)) names.add(m[1]);
    }
  }
  return names;
}

function unpinnedSelfClimbs(script: string, pinned: ReadonlySet<string>): string[] {
  return script
    .split('\n')
    .filter(isSelfClimb)
    .filter((line) => ![...line.matchAll(/\$\{([A-Za-z_]\w*):-/g)].some((m) => pinned.has(m[1])))
    .map((line) => line.trim());
}

describe('wrapped scripts pin their checkout instead of climbing out of the snapshot (WI-10006358)', () => {
  it('flags a self-located climb unless a unit-pinned override guards it (calibration)', () => {
    const script = [
      '# R="$(dirname "${BASH_SOURCE[0]}")/.." in a comment is not a climb',
      'A="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"',
      'B="${PINNED:-$(cd "$SELF_DIR/.." && pwd)}"',
      'C="${UNPINNED:-$_HERE/../x}"',
      'D="$(dirname "${BASH_SOURCE[0]}")/lib/helper.sh"',
      'echo "usage: $0 [ARG ...]"',
    ].join('\n');
    const pinned = pinnedEnvironment('[Service]\nEnvironment=PATH=/usr/bin PINNED=%h/x');
    expect([...pinned].sort()).toEqual(['PATH', 'PINNED']);
    expect(unpinnedSelfClimbs(script, pinned)).toEqual([
      'A="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"',
      'C="${UNPINNED:-$_HERE/../x}"',
    ]);
  });

  it('every wrapped unit pins the checkout its script would otherwise derive from the snapshot path', async () => {
    const violations: string[] = [];
    const climbing: string[] = [];
    for (const { key, scripts } of (await censusTrackedUnits()).filter((f) => f.wrapped)) {
      const unit = key.split(' ')[0];
      const unitTexts = [await readFile(join(REPO_ROOT, unit), 'utf8')];
      const base = /^(.*\.service)\.d\/[^/]+\.conf$/.exec(unit);
      if (base) unitTexts.push(await readFile(join(REPO_ROOT, base[1]), 'utf8').catch(() => ''));
      const pinned = pinnedEnvironment(...unitTexts);
      for (const script of scripts) {
        const text = await readFile(join(REPO_ROOT, script), 'utf8').catch(() => null);
        if (text === null) continue;
        if (text.split('\n').some(isSelfClimb)) climbing.push(script);
        if (unpinnedSelfClimbs(text, pinned).length > 0) violations.push(`${unit} ${script}`);
      }
    }
    // Positive control: these wrapped scripts DO climb (each behind a pinned override), so a
    // detector that matched nothing would pass the checks below vacuously.
    expect(climbing).toEqual(
      expect.arrayContaining([
        'bin/reap-stale-testvms.sh',
        'apps/operator/scripts/papercup-dht-liveness-check.sh',
        'infra/estate-backup/pc-estate-mirror-alert.sh',
        'papercusp-desktop/bin/live-federation-gate.sh',
        'apps/operator/bin/bundle-host.sh',
      ]),
    );
    expect(
      violations.filter((key) => !(key in SELF_CLIMB_ALLOWLIST)),
      'these wrapped scripts locate the checkout from their own (snapshot) path: make the climb the default of a ${NAME:-…} override and pin NAME with Environment= in the unit',
    ).toEqual([]);
    expect(
      Object.keys(SELF_CLIMB_ALLOWLIST).filter((key) => !violations.includes(key)),
      'allowlist entries no longer measured: delete them (the allowlist is shrink-only)',
    ).toEqual([]);
    for (const [key, reason] of Object.entries(SELF_CLIMB_ALLOWLIST)) expect(reason.length, key).toBeGreaterThan(40);
  });
});

// ── bundle-host.sh honours its checkout pin ONLY from a snapshot (WI-10006398) ──
// bg-host pins BUNDLE_HOST_OPERATOR_DIR with Environment=, and that value reaches every process
// bg-host spawns — including deploy-cli, which runs papercup-release's copy of bundle-host.sh IN
// PLACE. An in-place run that honoured the inherited value would bundle the staging tree into a
// release. These cases execute the script's REAL resolution block (extracted between its
// markers) — directly, and through the real launcher.

// Overridable so scripts/mutation-probe.sh can point these cases at a mutated COPY.
const BUNDLE_HOST = process.env.BUNDLE_HOST_PIN_PROBE_SCRIPT ?? join(REPO_ROOT, 'apps', 'operator', 'bin', 'bundle-host.sh');
const PIN_ENV = ['BUNDLE_HOST_OPERATOR_DIR', 'PAPERCUSP_SCRIPT_SNAPSHOT_ROOT'];

async function operatorDirBlock(): Promise<string> {
  const text = await readFile(BUNDLE_HOST, 'utf8');
  const match = /^# >>> operator-dir resolution.*\n([\s\S]*?)^# <<< operator-dir resolution$/m.exec(text);
  expect(match, 'bundle-host.sh lost its "# >>> / # <<< operator-dir resolution" markers').not.toBeNull();
  // Calibration: the block must still be the code under test, not an emptied shell.
  expect(match![1]).toContain('BUNDLE_HOST_OPERATOR_DIR');
  expect(match![1]).toContain('PAPERCUSP_SCRIPT_SNAPSHOT_ROOT');
  return match![1];
}

// Same shell options as bundle-host.sh, and SCRIPT_DIR computed the same way it computes it.
function probeScript(block: string): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    block,
    'printf "%s" "$OPERATOR_DIR"',
    '',
  ].join('\n');
}

describe('bundle-host.sh checkout pin is honoured only from a snapshot (WI-10006398)', () => {
  it('ignores an inherited pin in place, honours it from a snapshot, and refuses a snapshot without one', async () => {
    const block = await operatorDirBlock();
    const root = await mkdtemp(join(tmpdir(), 'bundle-host-pin-'));
    try {
      const checkoutOperator = join(root, 'checkout', 'apps', 'operator');
      const pinned = join(root, 'pinned', 'apps', 'operator');
      const snapRoot = join(root, 'snap');
      await mkdir(join(checkoutOperator, 'bin'), { recursive: true });
      await mkdir(pinned, { recursive: true });
      await mkdir(join(snapRoot, 'script-1'), { recursive: true });
      await mkdir(join(root, 'snap-sibling', 'script-1'), { recursive: true });
      const body = probeScript(block);
      for (const dir of [join(checkoutOperator, 'bin'), join(snapRoot, 'script-1'), join(root, 'snap-sibling', 'script-1')]) {
        await writeExecutable(join(dir, 'probe.sh'), body);
      }
      const run = (script: string, env: Record<string, string>) => {
        const childEnv: NodeJS.ProcessEnv = { ...process.env };
        for (const name of PIN_ENV) delete childEnv[name];
        return spawnSync('bash', [script], { encoding: 'utf8', env: { ...childEnv, ...env } });
      };

      // In place with an inherited pin (the deploy-cli case): the pin is ignored.
      const inPlace = run(join(checkoutOperator, 'bin', 'probe.sh'), { BUNDLE_HOST_OPERATOR_DIR: pinned });
      expect([inPlace.status, inPlace.stdout, inPlace.stderr]).toEqual([0, checkoutOperator, '']);
      // ...even when an unrelated snapshot root is inherited too.
      const inPlaceWithRoot = run(join(checkoutOperator, 'bin', 'probe.sh'), {
        BUNDLE_HOST_OPERATOR_DIR: pinned,
        PAPERCUSP_SCRIPT_SNAPSHOT_ROOT: snapRoot,
      });
      expect([inPlaceWithRoot.status, inPlaceWithRoot.stdout]).toEqual([0, checkoutOperator]);
      // A directory that merely shares the root's string prefix is not inside it.
      const sibling = run(join(root, 'snap-sibling', 'script-1', 'probe.sh'), {
        BUNDLE_HOST_OPERATOR_DIR: pinned,
        PAPERCUSP_SCRIPT_SNAPSHOT_ROOT: snapRoot,
      });
      expect([sibling.status, sibling.stdout]).toEqual([0, join(root, 'snap-sibling')]);
      // From a snapshot: the pin is honoured...
      const snap = run(join(snapRoot, 'script-1', 'probe.sh'), {
        BUNDLE_HOST_OPERATOR_DIR: pinned,
        PAPERCUSP_SCRIPT_SNAPSHOT_ROOT: snapRoot,
      });
      expect([snap.status, snap.stdout]).toEqual([0, pinned]);
      // ...and required: a snapshot must never fall back to locating itself in a temp dir.
      const unpinned = run(join(snapRoot, 'script-1', 'probe.sh'), { PAPERCUSP_SCRIPT_SNAPSHOT_ROOT: snapRoot });
      expect(unpinned.status).toBe(78);
      expect(unpinned.stdout).toBe('');
      expect(unpinned.stderr).toContain('BUNDLE_HOST_OPERATOR_DIR');
      // A pin naming a missing directory refuses rather than resolving to an empty path.
      const missing = run(join(snapRoot, 'script-1', 'probe.sh'), {
        BUNDLE_HOST_OPERATOR_DIR: join(root, 'absent'),
        PAPERCUSP_SCRIPT_SNAPSHOT_ROOT: snapRoot,
      });
      expect([missing.status, missing.stdout]).toEqual([78, '']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('the real launcher marks its snapshot so the pin is honoured end to end', async () => {
    const block = await operatorDirBlock();
    const root = await mkdtemp(join(tmpdir(), 'bundle-host-launch-'));
    try {
      const bin = join(root, 'checkout', 'apps', 'operator', 'bin');
      const pinned = join(root, 'pinned', 'apps', 'operator');
      await mkdir(bin, { recursive: true });
      await mkdir(pinned, { recursive: true });
      const probe = join(bin, 'probe.sh');
      await writeExecutable(probe, probeScript(block));

      const viaLauncher = await runWrapper(root, [probe], { BUNDLE_HOST_OPERATOR_DIR: pinned }, PIN_ENV.slice(1));
      const probeSha = createHash('sha256').update(await readFile(probe)).digest('hex');
      expect([viaLauncher.status, viaLauncher.stdout]).toEqual([0, pinned]);
      expect(viaLauncher.stderr).toContain(
        '[script-snapshot] target source=' + probe + ' sha256=' + probeSha,
      );
      const unpinned = await runWrapper(root, [probe], {}, PIN_ENV);
      expect(unpinned.status).toBe(78);
      expect(unpinned.stderr).toContain('running from a script snapshot');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
