import { execFileSync, spawn, spawnSync as nativeSpawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTextCollector } from '@papercusp/operator-core/lib/child-output';

// EI-21475576623166605: these tests launch several real shells and copy/hardlink/prune
// filesystem trees. Under fleet I/O contention they have measured 7–53s, so Vitest's
// 5s unit-test default fabricates a red before their product assertions run. Keep the
// larger budget local to those native-I/O cases; pure tests retain the default detector.
const NATIVE_SHELL_TIMEOUT_MS = 120_000;

const REPO_ROOT = resolve(__dirname, '../../../..');
// Overridable so a mutation probe can point the suite at a COPY of the script
// outside the tree; mutating the tracked file in place would race git-sync's
// whole-tree sweep and can commit the mutant.
const SCRIPT =
  process.env.DEPENDENCY_GENERATION_SCRIPT ??
  join(REPO_ROOT, 'apps/operator/bin/release/dependency-generation.sh');

const roots: string[] = [];

// A synchronous child blocks Vitest's worker and its case-timeout callback.
// Emit directly to the worker's stderr before entering that child so the file
// watchdog can identify the exact case/phase even when the child never returns.
function spawnSync(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding = { encoding: 'utf8' },
) {
  const started = Date.now();
  const subject = {
    test: expect.getState().currentTestName,
    command,
    args: args.map((arg) => arg.slice(0, 240)),
  };
  const emit = (phase: string, fields: Record<string, unknown>) => {
    const line = `DEPENDENCY_GENERATION_SHELL_${phase} ${JSON.stringify(fields)}\n`;
    // The router buffers stderr until finalization. A task-level kill can end
    // the router too, so an explicitly requested diagnostic file must be
    // written synchronously before the child starts, outside that buffer.
    const traceFile = process.env.DEPENDENCY_GENERATION_SHELL_TRACE_FILE;
    if (traceFile) appendFileSync(traceFile, line);
    writeSync(2, line);
  };
  emit('START', subject);
  const result = nativeSpawnSync(command, args, {
    ...options,
    timeout: options.timeout ?? NATIVE_SHELL_TIMEOUT_MS,
    killSignal: options.killSignal ?? 'SIGKILL',
  });
  emit('END', {
    ...subject,
    durationMs: Date.now() - started,
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
  });
  return result;
}

interface ShellResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

type TelemetryRecord = Record<string, string>;

function telemetryRecords(
  stderr: string,
  kind: 'PHASE' | 'SUMMARY' | 'INCREMENTAL',
): TelemetryRecord[] {
  const prefix = `[dependency-generation] ${kind} `;
  return stderr
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) =>
      Object.fromEntries(
        line
          .slice(prefix.length)
          .trim()
          .split(/\s+/)
          .map((field) => {
            const separator = field.indexOf('=');
            if (separator < 1)
              throw new Error(`malformed telemetry field: ${field}`);
            return [field.slice(0, separator), field.slice(separator + 1)];
          }),
      ),
    );
}

function lastSummary(result: ShellResult): TelemetryRecord {
  const summaries = telemetryRecords(result.stderr, 'SUMMARY');
  const summary = summaries.at(-1);
  if (!summary)
    throw new Error(
      `missing dependency-generation summary in: ${result.stderr}`,
    );
  return summary;
}

function makeIntegration(): string {
  // Retention intentionally imports DIRECT sibling checkout markers. Put each
  // fixture under a private parent so that contract scans only this test's
  // siblings instead of every concurrently-active directory in the shared
  // /tmp/pcv root (which made five tiny publishes take ~59s and the full file
  // exceed the workspace's 300s watchdog).
  const parent = mkdtempSync(join(tmpdir(), 'dependency-generation-suite-'));
  const root = join(parent, 'integration');
  mkdirSync(root, { recursive: true });
  roots.push(parent);
  mkdirSync(join(root, 'node_modules/pkg'), { recursive: true });
  mkdirSync(join(root, 'packages/a/node_modules/local'), { recursive: true });
  mkdirSync(join(root, 'packages/b/node_modules/other'), { recursive: true });
  mkdirSync(
    join(root, '.papercusp/worktrees/repair/node_modules/foreign'),
    { recursive: true },
  );
  writeFileSync(join(root, 'node_modules/pkg/index.js'), 'root-v1\n');
  // A real install: the publish-time lock-vs-tree audit (WI-6554700010008514) requires
  // every locked package to carry package.json at its locked version (PKG below locks 1.0.0).
  writeFileSync(join(root, 'node_modules/pkg/package.json'), '{"name":"pkg","version":"1.0.0"}\n');
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {
      'node_modules/pkg': { version: '1.0.0' },
      'packages/a/node_modules/local': { version: '1.0.0' },
      // The incremental-removal cases deliberately omit this optional tree.
      'packages/b/node_modules/other': { version: '1.0.0', optional: true },
    } }) + '\n',
  );
  writeFileSync(
    join(root, 'packages/a/node_modules/local/index.js'),
    'local-v1\n',
  );
  writeFileSync(join(root, 'packages/a/package.json'), '{"name":"a"}\n');
  writeFileSync(join(root, 'packages/a/node_modules/local/package.json'), '{"name":"local","version":"1.0.0"}\n');
  writeFileSync(
    join(root, 'packages/b/node_modules/other/index.js'),
    'other-v1\n',
  );
  writeFileSync(join(root, 'packages/b/package.json'), '{"name":"b"}\n');
  writeFileSync(join(root, 'packages/b/node_modules/other/package.json'), '{"name":"other","version":"1.0.0"}\n');
  writeFileSync(
    join(root, '.papercusp/worktrees/repair/node_modules/foreign/index.js'),
    'must-not-copy\n',
  );
  return root;
}

function lockFixturePackage(integration: string, path: string, optional = false) {
  const file = join(integration, 'package-lock.json');
  const lock = JSON.parse(readFileSync(file, 'utf8'));
  lock.packages[path] = { version: '1.0.0', ...(optional ? { optional: true } : {}) };
  writeFileSync(file, JSON.stringify(lock) + '\n');
  writeFileSync(join(integration, path, 'package.json'), JSON.stringify({
    name: path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length), version: '1.0.0',
  }) + '\n');
}

function publish(
  integration: string,
  env: NodeJS.ProcessEnv = {},
  generationRoot?: string,
  workspaceDirs: string[] = [],
): ShellResult {
  const args = [SCRIPT, '--integration', integration];
  if (generationRoot) args.push('--generation-root', generationRoot);
  for (const workspaceDir of workspaceDirs) {
    args.push('--workspace-dir', workspaceDir);
  }
  const result = spawnSync('bash', args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function publishedPath(stdout: string): string {
  const match = stdout.match(/\bpath=([^\n]+)$/m);
  if (!match) throw new Error(`missing generation path in: ${stdout}`);
  return match[1];
}

function publishedIdentity(stdout: string): string {
  const match = stdout.match(/\bidentity=(v1-[0-9a-f]{64})\b/);
  if (!match) throw new Error(`missing generation identity in: ${stdout}`);
  return match[1];
}

function publishedToken(stdout: string): string {
  const match = stdout.match(/\btoken=([^\s]+)/);
  if (!match) throw new Error(`missing generation token in: ${stdout}`);
  return match[1];
}

function selectPrewarmed(
  generationRoot: string,
  inputRoot: string,
  env: NodeJS.ProcessEnv = {},
  leaseOwnerPid?: number,
): ShellResult {
  const args = [
    SCRIPT,
    '--integration',
    inputRoot,
    '--generation-root',
    generationRoot,
    '--select-inputs-from',
    inputRoot,
  ];
  if (leaseOwnerPid !== undefined) {
    args.push('--lease-owner-pid', String(leaseOwnerPid));
  }
  const result = spawnSync(
    'bash',
    args,
    {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    },
  );
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function ensureRef(
  integration: string,
  ref: string,
  env: NodeJS.ProcessEnv = {},
  generationRoot?: string,
  extraArgs: string[] = [],
): ShellResult {
  const args = [SCRIPT, '--integration', integration];
  if (generationRoot) args.push('--generation-root', generationRoot);
  args.push('--ensure-ref', ref, ...extraArgs);
  const result = spawnSync(
    'bash',
    args,
    {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    },
  );
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function fingerprintRef(
  integration: string,
  ref: string,
  env: NodeJS.ProcessEnv = process.env,
): ShellResult {
  const result = spawnSync(
    'bash',
    [SCRIPT, '--integration', integration, '--fingerprint-ref', ref],
    { encoding: 'utf8', env },
  );
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function publishedInputFingerprint(stdout: string): string {
  const match = stdout.match(/\binput=([0-9a-f]{64})\b/);
  if (!match) throw new Error(`missing dependency input fingerprint in: ${stdout}`);
  return match[1];
}

function commitFixture(integration: string, message: string): string {
  if (!existsSync(join(integration, '.git'))) {
    execFileSync('git', ['init', '-q', '-b', 'staging'], { cwd: integration });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], {
      cwd: integration,
    });
    execFileSync('git', ['config', 'user.name', 'fixture'], {
      cwd: integration,
    });
  }
  execFileSync(
    'git',
    [
      'add',
      'package-lock.json',
      'packages/a/package.json',
      'packages/b/package.json',
    ],
    { cwd: integration },
  );
  execFileSync('git', ['commit', '-qm', message], { cwd: integration });
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: integration,
    encoding: 'utf8',
  }).trim();
}

function selectGeneration(
  generationRoot: string,
  identity: string,
): ShellResult {
  const wrapper = [
    'set -euo pipefail',
    'source "$SCRIPT"',
    'dependency_generation_select "$GENERATION_ROOT" "$GENERATION_ID"',
    'printf "SELECTED identity=%s source=%s path=%s\\n" "$DEPENDENCY_GENERATION_ID" "$DEPENDENCY_GENERATION_SOURCE_FINGERPRINT" "$DEPENDENCY_GENERATION_PATH"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', wrapper], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SCRIPT,
      GENERATION_ROOT: generationRoot,
      GENERATION_ID: identity,
    },
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function deepAuditGeneration(generation: string): ShellResult {
  const wrapper = [
    'set -euo pipefail',
    'source "$SCRIPT"',
    'dependency_generation_deep_audit "$GENERATION"',
    'printf "DEEP_AUDIT_OK\\n"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', wrapper], {
    encoding: 'utf8',
    env: { ...process.env, SCRIPT, GENERATION: generation },
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function invalidatePublicationToken(generation: string): void {
  const marker = join(generation, '.papercusp-dependency-generation');
  chmodSync(marker, 0o644);
  writeFileSync(
    marker,
    readFileSync(marker, 'utf8').replace(
      /^publication_token=.*$/m,
      `publication_token=v2:${'0'.repeat(64)}`,
    ),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// Commit EVERYTHING in the fixture. commitFixture() above hardcodes its `git add`
// paths, so it cannot stage a patches/ file; this guard needs the whole tree.
function commitAllFixture(integration: string, message: string): string {
  if (!existsSync(join(integration, '.git'))) {
    execFileSync('git', ['init', '-q', '-b', 'staging'], { cwd: integration });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], {
      cwd: integration,
    });
    execFileSync('git', ['config', 'user.name', 'fixture'], { cwd: integration });
  }
  execFileSync('git', ['add', '-A'], { cwd: integration });
  execFileSync('git', ['commit', '-qm', message], { cwd: integration });
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: integration,
    encoding: 'utf8',
  }).trim();
}

describe('dependency source checkout boundaries', () => {
  it('bounds a blocked synchronous child and preserves its diagnostic phase outside router buffers', () => {
    const integration = makeIntegration();
    const trace = join(dirname(integration), 'shell-trace.log');
    const previous = process.env.DEPENDENCY_GENERATION_SHELL_TRACE_FILE;
    process.env.DEPENDENCY_GENERATION_SHELL_TRACE_FILE = trace;
    try {
      const result = spawnSync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        encoding: 'utf8', timeout: 100,
      });
      expect(result.error).toMatchObject({ code: 'ETIMEDOUT' });
      expect(result.signal).toBe('SIGKILL');
      const records = readFileSync(trace, 'utf8').trim().split('\n');
      expect(records).toHaveLength(2);
      expect(records[0]).toContain('DEPENDENCY_GENERATION_SHELL_START');
      expect(records[0]).toContain('bounds a blocked synchronous child');
      expect(records[1]).toContain('DEPENDENCY_GENERATION_SHELL_END');
      expect(records[1]).toContain('ETIMEDOUT');
    } finally {
      if (previous === undefined) delete process.env.DEPENDENCY_GENERATION_SHELL_TRACE_FILE;
      else process.env.DEPENDENCY_GENERATION_SHELL_TRACE_FILE = previous;
    }
  });

  it('preserves the termination signal selected by a bounded-child caller', () => {
    const result = spawnSync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      encoding: 'utf8', timeout: 100, killSignal: 'SIGTERM',
    });
    expect(result.error).toMatchObject({ code: 'ETIMEDOUT' });
    expect(result.signal).toBe('SIGTERM');
  });

  it('excludes generated Next standalone outputs from full and selected captures', () => {
    const integration = makeIntegration();
    const sourceCommit = commitFixture(integration, 'seed source inputs');
    const generated = join(integration, 'apps/web/.next/standalone');
    for (const rel of ['node_modules/copied', 'apps/web/node_modules/copied']) {
      mkdirSync(join(generated, rel), { recursive: true });
      writeFileSync(join(generated, rel, 'index.js'), 'generated-v1\n');
    }
    writeFileSync(join(generated, 'package-lock.json'), '{"name":"generated","lockfileVersion":3,"packages":{}}\n');
    writeFileSync(join(generated, 'apps/web/package.json'), '{"name":"generated-web"}\n');
    const walk = spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'source "$SCRIPT"',
      'dependency_generation_input_manifest "$INTEGRATION"',
      'printf "LIVE_INPUT="; dependency_generation_input_fingerprint "$INTEGRATION"',
      'dependency_generation_enumerate_node_modules "$INTEGRATION"',
      'DEPENDENCY_GENERATION_SCOPE_MODE=selected',
      'DEPENDENCY_GENERATION_WORKSPACE_DIRS=(packages/a apps/web/.next/standalone/apps/web)',
      'dependency_generation_enumerate_node_modules "$INTEGRATION"',
    ].join('\n')], { encoding: 'utf8', env: { ...process.env, SCRIPT, INTEGRATION: integration } });
    expect(walk.status, walk.stderr).toBe(0);
    expect(walk.stdout).not.toContain('.next');
    expect(walk.stdout.match(/packages\/a\/node_modules/g)).toHaveLength(2);
    const exact = fingerprintRef(integration, sourceCommit);
    expect(exact.status, exact.stderr).toBe(0);
    expect(walk.stdout).toContain(`LIVE_INPUT=${publishedInputFingerprint(exact.stdout)}`);
    const result = publish(integration, {
      NEXT_OUTPUT: join(generated, 'node_modules/copied/index.js'),
      DEPENDENCY_GENERATION_AFTER_COPY_HOOK: 'printf "generated-v2\\n" > "$NEXT_OUTPUT"',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(publishedPath(result.stdout), 'tree/apps/web/.next'))).toBe(false);
    expect(readFileSync(join(generated, 'node_modules/copied/index.js'), 'utf8')).toBe('generated-v2\n');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('excludes captured verifier driver dependencies from full and selected source installs', () => {
    const integration = makeIntegration();
    const generated = 'apps/operator/dist-verify/runtime/driver';
    const ordinary = 'packages/verifier-source';
    for (const path of [generated, ordinary]) {
      mkdirSync(join(integration, path, 'node_modules/fixture'), { recursive: true });
      writeFileSync(join(integration, path, 'node_modules/fixture/index.js'), 'measured bytes\n');
    }
    const walk = spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'source "$SCRIPT"',
      'dependency_generation_enumerate_node_modules "$INTEGRATION"',
      'DEPENDENCY_GENERATION_SCOPE_MODE=selected',
      'DEPENDENCY_GENERATION_WORKSPACE_DIRS=(packages/a packages/verifier-source apps/operator/dist-verify/runtime/driver)',
      'dependency_generation_enumerate_node_modules "$INTEGRATION"',
    ].join('\n')], { encoding: 'utf8', env: { ...process.env, SCRIPT, INTEGRATION: integration } });
    expect(walk.status, walk.stderr).toBe(0);
    expect(walk.stdout).not.toContain('apps/operator/dist-verify');
    expect(walk.stdout.match(/packages\/a\/node_modules/g)).toHaveLength(2);
    expect(walk.stdout.match(/packages\/verifier-source\/node_modules/g)).toHaveLength(2);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('excludes unrelated nested checkouts while retaining tracked submodule inputs and trees', () => {
    const integration = makeIntegration();
    commitFixture(integration, 'seed source repository');
    const vendor = join(integration, 'libs/vendor');
    mkdirSync(join(vendor, 'node_modules/vendor'), { recursive: true });
    writeFileSync(join(vendor, 'node_modules/vendor/index.js'), 'vendor\n');
    writeFileSync(join(vendor, 'package-lock.json'), '{"name":"vendor","lockfileVersion":3,"packages":{}}\n');
    const vendorCommit = commitAllFixture(vendor, 'seed submodule inputs');
    writeFileSync(join(integration, '.gitmodules'), '[submodule "vendor"]\n\tpath = libs/vendor\n\turl = ./vendor\n');
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${vendorCommit},libs/vendor`], { cwd: integration });
    const sourceCommit = commitAllFixture(integration, 'record submodule');

    const foreign = join(integration, 'apps/unrelated-checkpoint');
    mkdirSync(join(foreign, 'node_modules/foreign'), { recursive: true });
    writeFileSync(join(foreign, 'node_modules/foreign/index.js'), 'unrelated\n');
    writeFileSync(join(foreign, 'package-lock.json'), '{"name":"foreign","lockfileVersion":3,"packages":{}}\n');
    commitAllFixture(foreign, 'separate checkout');
    const result = spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'source "$SCRIPT"',
      'dependency_generation_input_manifest "$INTEGRATION"',
      'printf "LIVE_INPUT="; dependency_generation_input_fingerprint "$INTEGRATION"',
      'dependency_generation_enumerate_node_modules "$INTEGRATION"',
      'DEPENDENCY_GENERATION_SCOPE_MODE=selected',
      'DEPENDENCY_GENERATION_WORKSPACE_DIRS=(libs/vendor apps/unrelated-checkpoint)',
      'dependency_generation_enumerate_node_modules "$INTEGRATION"',
    ].join('\n')], {
      encoding: 'utf8',
      env: { ...process.env, SCRIPT, INTEGRATION: integration },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('libs/vendor/package-lock.json');
    expect(result.stdout).toContain('packages/a/node_modules');
    expect(result.stdout.match(/libs\/vendor\/node_modules/g)).toHaveLength(2);
    expect(result.stdout).not.toContain('unrelated-checkpoint');
    const exact = fingerprintRef(integration, sourceCommit);
    expect(exact.status, exact.stderr).toBe(0);
    expect(result.stdout).toContain(`LIVE_INPUT=${publishedInputFingerprint(exact.stdout)}`);
    expect(readFileSync(join(foreign, 'node_modules/foreign/index.js'), 'utf8')).toBe('unrelated\n');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('EI-27267673632472358: filters 98 install candidates in one Node process and rechecks ancestor locks on the next census', () => {
    const integration = makeIntegration();
    const lockPath = join(integration, 'package-lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    const dirs = Array.from({ length: 95 }, (_, i) => `packages/census-${i}`);
    for (const [i, dir] of dirs.entries()) {
      mkdirSync(join(integration, dir, 'node_modules/local'), { recursive: true });
      writeFileSync(join(integration, dir, 'package.json'), '{"private":true}\n');
      if (i < 50) lock.packages[`${dir}/node_modules/local`] = { version: '1.0.0' };
    }
    writeFileSync(lockPath, JSON.stringify(lock));
    writeFileSync(join(integration, '.gitignore'), 'node_modules/\n/packages/*/package-lock.json\n');
    commitAllFixture(integration, 'record ancestor install custody');
    for (const dir of dirs) writeFileSync(join(integration, dir, 'package-lock.json'), '{"packages":{}}');
    const counter = join(integration, '.node-launches');
    const wrapper = join(integration, '.count-node');
    writeFileSync(wrapper, '#!/bin/bash\nprintf "launch\\n" >> "$CENSUS_NODE_COUNTER"\nexec "$CENSUS_REAL_NODE" "$@"\n');
    chmodSync(wrapper, 0o755);
    const enumerate = (selected = false) => spawnSync('bash', ['-c', [
      'set -euo pipefail', 'source "$SCRIPT"',
      ...(selected ? ['DEPENDENCY_GENERATION_SCOPE_MODE=selected',
        'for dir in packages/*; do DEPENDENCY_GENERATION_WORKSPACE_DIRS+=("$dir"); done'] : []),
      'dependency_generation_enumerate_node_modules "$INTEGRATION"',
    ].join('\n')], { cwd: integration, encoding: 'utf8', env: { ...process.env, SCRIPT,
      INTEGRATION: integration, DEPENDENCY_GENERATION_NODE: wrapper,
      CENSUS_NODE_COUNTER: counter, CENSUS_REAL_NODE: process.execPath } });
    const population = (result: ReturnType<typeof enumerate>) => {
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim().split('\n').sort();
    };
    const expected = ['node_modules', 'packages/a/node_modules', 'packages/b/node_modules',
      ...dirs.slice(0, 50).map(dir => `${dir}/node_modules`)].map(dir => join(integration, dir)).sort();
    expect(population(enumerate())).toEqual(expected);
    expect(readFileSync(counter, 'utf8')).toBe('launch\n');
    expect(population(enumerate(true))).toEqual(expected);
    expect(readFileSync(counter, 'utf8')).toBe('launch\nlaunch\n');
    const relativeRoot = spawnSync('bash', ['-c', 'source "$SCRIPT"; dependency_generation_enumerate_node_modules .'],
      { cwd: integration, encoding: 'utf8', env: { ...process.env, SCRIPT } });
    expect(population(relativeRoot)).toEqual(expected.map(path => './' + path.slice(integration.length + 1)));

    // No cache crosses census calls, even when a lock changes to equal-length bytes.
    const before = readFileSync(lockPath, 'utf8');
    const changed = before.replace('packages/census-0/node_modules/local', 'packages/census-X/node_modules/local');
    expect(changed.length).toBe(before.length);
    writeFileSync(lockPath, changed);
    expect(population(enumerate())).toEqual(expected.filter(path => path !== join(integration, dirs[0], 'node_modules')));
    // Malformed enclosing custody keeps the tree visible; it cannot authorize omission.
    writeFileSync(lockPath, '{broken');
    expect(population(enumerate())).toHaveLength(98);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it.each(['full', 'selected'])('EI-27267673632472358: propagates install filter failure (%s)', mode => {
    const integration = makeIntegration();
    const wrapper = join(integration, '.failed-node');
    writeFileSync(wrapper, '#!/bin/bash\nexit 17\n');
    chmodSync(wrapper, 0o755);
    const result = spawnSync('bash', ['-c', [
      'source "$SCRIPT"', `DEPENDENCY_GENERATION_SCOPE_MODE=${mode}`,
      'DEPENDENCY_GENERATION_WORKSPACE_DIRS=(packages/a)',
      'dependency_generation_enumerate_node_modules "$INTEGRATION"',
    ].join('\n')], { encoding: 'utf8', env: { ...process.env, SCRIPT, INTEGRATION: integration,
      DEPENDENCY_GENERATION_NODE: wrapper } });
    expect(result.status).toBe(17);
    expect(result.stdout).toBe('');
  });

  it.each(['audit', 'serial', 'parallel', 'fingerprint'])('fails closed on a partial installed-tree census (%s)', operation => {
    const integration = makeIntegration();
    const result = spawnSync('bash', ['-c', [
      'source "$SCRIPT"',
      'dependency_generation_enumerate_node_modules() { printf "%s\\n" "$INTEGRATION/node_modules"; return 17; }',
      ...(operation === 'audit' ? ['dependency_generation_audit_lock_tree "$INTEGRATION" "$INTEGRATION"']
        : operation === 'serial' ? ['dependency_generation_set_manifest_serial "$INTEGRATION"']
          : operation === 'parallel' ? ['DEPENDENCY_GENERATION_WALK_JOBS=2', 'dependency_generation_set_manifest "$INTEGRATION"']
            : ['dependency_generation_set_fingerprint "$INTEGRATION"']),
    ].join('\n')], { encoding: 'utf8', env: { ...process.env, SCRIPT, INTEGRATION: integration } });
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.stderr).not.toContain('LOCK_TREE_AUDIT');
    if (operation === 'audit') expect(result.stderr).toContain('installed-tree enumeration failed');
  });

  it('WI-6554700010018380: an ignored install-generated lockfile is not a live input, so the live key still matches the exact ref', () => {
    const integration = makeIntegration();
    commitFixture(integration, 'seed source repository');
    // A submodule that ignores the lockfile its nested kit's install writes.
    const vendor = join(integration, 'libs/vendor');
    mkdirSync(join(vendor, 'kit'), { recursive: true });
    writeFileSync(join(vendor, 'package-lock.json'), '{"name":"vendor","lockfileVersion":3,"packages":{}}\n');
    writeFileSync(join(vendor, 'kit/package.json'), '{"name":"kit","private":true}\n');
    writeFileSync(join(vendor, '.gitignore'), '/kit/package-lock.json\n');
    const vendorCommit = commitAllFixture(vendor, 'seed submodule inputs');
    writeFileSync(join(integration, '.gitmodules'), '[submodule "vendor"]\n\tpath = libs/vendor\n\turl = ./vendor\n');
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${vendorCommit},libs/vendor`], { cwd: integration });
    // The superproject ignores one too.
    mkdirSync(join(integration, 'tools'), { recursive: true });
    writeFileSync(join(integration, '.gitignore'), '/tools/package-lock.json\n/packages/a/package-lock.json\n');
    writeFileSync(join(integration, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
      'packages/a/node_modules/local': { version: '1.0.0' },
    } }) + '\n');
    const sourceCommit = commitAllFixture(integration, 'record submodule and ignore rules');

    // Install artifacts the commits can never carry.
    writeFileSync(join(vendor, 'kit/package-lock.json'), '{"name":"kit","lockfileVersion":3,"packages":{}}\n');
    writeFileSync(join(integration, 'tools/package-lock.json'), '{"name":"tools","lockfileVersion":3,"packages":{}}\n');
    for (const dir of ['libs/vendor/kit', 'tools']) {
      mkdirSync(join(integration, dir, 'node_modules/unbound'), { recursive: true });
      writeFileSync(join(integration, dir, 'node_modules/unbound/package.json'), '{"name":"unbound","version":"1.0.0"}\n');
    }
    const enumerateTrees = () => spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'source "$SCRIPT"',
      'dependency_generation_enumerate_node_modules "$INTEGRATION"',
      'DEPENDENCY_GENERATION_SCOPE_MODE=selected',
      'DEPENDENCY_GENERATION_WORKSPACE_DIRS=(packages/a libs/vendor/kit tools)',
      'dependency_generation_enumerate_node_modules "$INTEGRATION"',
    ].join('\n')], { encoding: 'utf8', env: { ...process.env, SCRIPT, INTEGRATION: integration } });
    const trees = enumerateTrees();
    expect(trees.status, trees.stderr).toBe(0);
    expect(trees.stdout.match(/packages\/a\/node_modules/g)).toHaveLength(2);
    expect(trees.stdout).not.toContain('libs/vendor/kit/node_modules');
    expect(trees.stdout).not.toContain('tools/node_modules');
    expect(existsSync(join(vendor, 'kit/node_modules/unbound/package.json'))).toBe(true);
    const live = () => spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'source "$SCRIPT"',
      'dependency_generation_input_manifest "$INTEGRATION"',
      'printf "LIVE_INPUT="; dependency_generation_input_fingerprint "$INTEGRATION"',
    ].join('\n')], { encoding: 'utf8', env: { ...process.env, SCRIPT, INTEGRATION: integration } });

    const result = live();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('libs/vendor/package-lock.json');
    expect(result.stdout).not.toContain('libs/vendor/kit/package-lock.json');
    expect(result.stdout).not.toContain('tools/package-lock.json');
    const exact = fingerprintRef(integration, sourceCommit);
    expect(exact.status, exact.stderr).toBe(0);
    expect(result.stdout).toContain(`LIVE_INPUT=${publishedInputFingerprint(exact.stdout)}`);

    // A cleaned-up ignored lock must not readmit its leftover private tree.
    rmSync(join(vendor, 'kit/package-lock.json'));
    rmSync(join(integration, 'tools/package-lock.json'));
    const withoutLocks = enumerateTrees();
    expect(withoutLocks.status, withoutLocks.stderr).toBe(0);
    expect(withoutLocks.stdout).toBe(trees.stdout);

    // An untracked lockfile that is NOT ignored is still a live input: it could be
    // committed, so the comparison must keep refusing until it is.
    mkdirSync(join(integration, 'packages/c'), { recursive: true });
    writeFileSync(join(integration, 'packages/c/package-lock.json'), '{"name":"c","lockfileVersion":3,"packages":{}}\n');
    const withUntracked = live();
    expect(withUntracked.status, withUntracked.stderr).toBe(0);
    expect(withUntracked.stdout).toContain('packages/c/package-lock.json');
    expect(withUntracked.stdout).not.toContain(`LIVE_INPUT=${publishedInputFingerprint(exact.stdout)}`);
  }, NATIVE_SHELL_TIMEOUT_MS);
});

describe('WI-10002299: patch-package patches are dependency inputs', () => {
  // The root package.json postinstall runs `patch-package`, so a patches/*.patch
  // change alters the produced node_modules closure exactly as a lockfile change
  // does. While only lockfiles keyed the fingerprint, a patch fix could never
  // invalidate a cached generation: measured 2026-09-22, the release gate reused
  // one generation for >2 days across a patch-only commit, which stranded the
  // frozen repair queue ~46h on a lint:tsc red that was unfixable by construction.
  it(
    'moves the input fingerprint when ONLY a patches/*.patch file changes',
    () => {
      const integration = makeIntegration();
      const patchPath = join(integration, 'patches/fixture-pkg+1.0.0.patch');
      mkdirSync(dirname(patchPath), { recursive: true });
      writeFileSync(patchPath, 'diff --git a/i.js b/i.js\n-old\n+new\n');
      const before = commitAllFixture(integration, 'seed with a patch');

      writeFileSync(patchPath, 'diff --git a/i.js b/i.js\n-old\n+CHANGED\n');
      const afterPatch = commitAllFixture(integration, 'change ONLY the patch');

      // Calibration control: a file that is neither a lockfile nor a patch must
      // NOT move the key. Without this, a fingerprint that merely tracked the
      // commit sha would satisfy the assertion above vacuously.
      writeFileSync(join(integration, 'README.md'), 'unrelated\n');
      const afterUnrelated = commitAllFixture(
        integration,
        'change an unrelated file',
      );

      const fp = (ref: string): string => {
        const result = fingerprintRef(integration, ref);
        expect(result.status).toBe(0);
        return publishedInputFingerprint(result.stdout);
      };

      const baseline = fp(before);
      expect(fp(afterPatch)).not.toBe(baseline);
      expect(fp(afterUnrelated)).toBe(fp(afterPatch));
    },
    NATIVE_SHELL_TIMEOUT_MS,
  );
});

describe('exact-ref dependency record filtering', () => {
  it('filters the immutable tree listing before the Bash manifest loop', () => {
    const integration = makeIntegration();
    const candidate = commitFixture(integration, 'candidate with ordinary dependency inputs');
    const shimDir = join(integration, 'grep-shim');
    const traceFile = join(integration, 'grep-filter.trace');
    mkdirSync(shimDir);
    const realGrep = execFileSync('bash', ['-lc', 'command -v grep'], {
      encoding: 'utf8',
    }).trim();
    writeFileSync(
      join(shimDir, 'grep'),
      '#!/bin/sh\nif [ "$1" = "-zE" ]; then printf filtered >> "$DEPENDENCY_GENERATION_FILTER_TRACE"; fi\nexec "$DEPENDENCY_GENERATION_REAL_GREP" "$@"\n',
      { mode: 0o755 },
    );

    const result = fingerprintRef(integration, candidate, {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      DEPENDENCY_GENERATION_FILTER_TRACE: traceFile,
      DEPENDENCY_GENERATION_REAL_GREP: realGrep,
    });

    expect(result.status, result.stderr).toBe(0);
    const lockDigest = createHash('sha256')
      .update(readFileSync(join(integration, 'package-lock.json')))
      .digest('hex');
    const expected = createHash('sha256')
      .update(`schema\t1\npackage-lock.json\t${lockDigest}\n`)
      .digest('hex');
    expect(publishedInputFingerprint(result.stdout)).toBe(expected);
    expect(readFileSync(traceFile, 'utf8')).toContain('filtered');
  });

  it('EI-26287122280182495: reuses immutable submodule manifests and invalidates them when the gitlink changes', () => {
    const integration = makeIntegration();
    commitFixture(integration, 'seed repository');
    const vendor = join(integration, 'libs/vendor');
    mkdirSync(vendor, { recursive: true });
    const initialLock = '{"name":"vendor","lockfileVersion":3,"packages":{}}\n';
    writeFileSync(join(vendor, 'package-lock.json'), initialLock);
    const vendorRef = commitAllFixture(vendor, 'first vendor inputs');
    const oldBlob = execFileSync('git', ['rev-parse', `${vendorRef}:package-lock.json`], { cwd: vendor, encoding: 'utf8' }).trim();
    writeFileSync(join(integration, '.gitmodules'), '[submodule "vendor"]\n\tpath = libs/vendor\n\turl = ./vendor\n');
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${vendorRef},libs/vendor`], { cwd: integration });
    const first = commitAllFixture(integration, 'record first gitlink');
    writeFileSync(join(integration, 'README.md'), 'source-only change\n');
    const second = commitAllFixture(integration, 'same dependency subtree');
    const nextLock = '{"name":"vendor-changed","lockfileVersion":3,"packages":{}}\n';
    writeFileSync(join(vendor, 'package-lock.json'), nextLock);
    const nextVendor = commitAllFixture(vendor, 'changed vendor inputs');
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${nextVendor},libs/vendor`], { cwd: integration });
    const third = commitAllFixture(integration, 'record changed gitlink');
    const shim = join(dirname(integration), 'manifest-git-bin');
    const trace = join(dirname(integration), 'manifest-blob-reads');
    const cache = join(dirname(integration), 'manifest-cache');
    mkdirSync(shim);
    const realGit = execFileSync('bash', ['-lc', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(shim, 'git'), `#!/bin/bash
if [ "$1" = '-C' ] && [ "$2" = "$TEST_VENDOR" ] && [ "$3" = 'cat-file' ] && [ "$4" = 'blob' ]; then
  printf '%s\\n' "$5" >> "$TEST_MANIFEST_TRACE"
fi
exec "$TEST_REAL_GIT" "$@"
`, { mode: 0o755 });
    const result = spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'source "$SCRIPT"',
      'dependency_generation_input_manifest_ref "$INTEGRATION" "$FIRST" "" "" "$CACHE" > "$OUT/first"',
      'dependency_generation_input_manifest_ref "$INTEGRATION" "$SECOND" "" "" "$CACHE" > "$OUT/second"',
      'dependency_generation_input_manifest_ref "$INTEGRATION" "$THIRD" "" "" "$CACHE" > "$OUT/third"',
    ].join('\n')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, SCRIPT, INTEGRATION: integration,
        FIRST: first, SECOND: second, THIRD: third, CACHE: cache, OUT: dirname(integration),
        TEST_VENDOR: vendor, TEST_MANIFEST_TRACE: trace, TEST_REAL_GIT: realGit },
    });
    expect(result.status, result.stderr).toBe(0);
    const before = readFileSync(join(dirname(integration), 'first'), 'utf8');
    expect(readFileSync(join(dirname(integration), 'second'), 'utf8')).toBe(before);
    const oldDigest = createHash('sha256').update(initialLock).digest('hex');
    const nextDigest = createHash('sha256').update(nextLock).digest('hex');
    expect(before).toContain(`libs/vendor/package-lock.json\t${oldDigest}`);
    expect(readFileSync(join(dirname(integration), 'third'), 'utf8')).toContain(`libs/vendor/package-lock.json\t${nextDigest}`);
    const reads = readFileSync(trace, 'utf8').trim().split('\n');
    expect(reads.filter(blob => blob === oldBlob)).toHaveLength(1);
    expect(reads).toHaveLength(2);
  }, NATIVE_SHELL_TIMEOUT_MS);
});

describe('WI-6554700010017090: an unhydrated integration submodule is hydrated once, then fails closed', () => {
  // Local-path submodule URLs need file protocol explicitly allowed (git >= 2.38.1).
  const FILE_PROTOCOL_ENV = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'protocol.file.allow',
    GIT_CONFIG_VALUE_0: 'always',
  };
  const LOCK = '{"name":"vendor","lockfileVersion":3,"packages":{}}\n';

  // The drill clone's shape: the gitlink and .gitmodules entry are committed, but the
  // submodule directory is an empty, never-initialized directory with no
  // submodule.<name>.url in .git/config.
  function uninitializedSubmoduleFixture(useMissingRemote: boolean) {
    const integration = makeIntegration();
    commitFixture(integration, 'seed repository');
    const source = join(dirname(integration), 'vendor-source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'package-lock.json'), LOCK);
    const vendorRef = commitAllFixture(source, 'vendor inputs');
    const url = useMissingRemote ? join(dirname(integration), 'missing-vendor-source') : source;
    writeFileSync(join(integration, '.gitmodules'), `[submodule "vendor"]\n\tpath = libs/vendor\n\turl = ${url}\n`);
    mkdirSync(join(integration, 'libs/vendor'), { recursive: true });
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${vendorRef},libs/vendor`], { cwd: integration });
    const ref = commitAllFixture(integration, 'record gitlink without initializing the submodule');
    return { integration, ref, vendorRef };
  }

  function manifest(integration: string, ref: string) {
    const out = join(dirname(integration), 'manifest');
    const result = spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'source "$SCRIPT"',
      'dependency_generation_input_manifest_ref "$INTEGRATION" "$REF" "" "" "$CACHE" > "$OUT"',
    ].join('\n')], {
      encoding: 'utf8',
      env: { ...process.env, ...FILE_PROTOCOL_ENV, SCRIPT, INTEGRATION: integration, REF: ref,
        CACHE: join(dirname(integration), 'manifest-cache'), OUT: out },
    });
    return { result, out };
  }

  it('initializes the never-initialized submodule and manifests its inputs instead of refusing', () => {
    const { integration, ref, vendorRef } = uninitializedSubmoduleFixture(false);
    const { result, out } = manifest(integration, ref);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('submodule libs/vendor is not initialized');
    const digest = createHash('sha256').update(LOCK).digest('hex');
    expect(readFileSync(out, 'utf8')).toContain(`libs/vendor/package-lock.json\t${digest}`);
    const vendor = join(integration, 'libs/vendor');
    expect(execFileSync('git', ['-C', vendor, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim())
      .toBe(realpathSync(vendor));
    expect(execFileSync('git', ['-C', vendor, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(vendorRef);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('still refuses with exit 74 when the submodule remote cannot supply the pinned commit', () => {
    const { integration, ref, vendorRef } = uninitializedSubmoduleFixture(true);
    const { result } = manifest(integration, ref);
    expect(result.status, result.stderr).toBe(74);
    expect(result.stderr).toContain(`requires unavailable submodule libs/vendor@${vendorRef}`);
    expect(result.stderr).toContain('integration-checkout defect');
  }, NATIVE_SHELL_TIMEOUT_MS);
});

describe('immutable dependency generation', () => {
  it.each(['1', '2'])('rejects a nested dependency-root alias before publication (walk jobs %s)', (jobs) => {
    const integration = makeIntegration();
    // The alias can be dangling: following it is neither necessary nor safe.
    symlinkSync('/absent/other-checkout/node_modules', join(integration, 'node_modules/node_modules'));
    const result = publish(integration, { DEPENDENCY_GENERATION_WALK_JOBS: jobs });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('nested dependency-root symlink');
    expect(result.stdout).not.toMatch(/identity=v1-/);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('refuses a legacy cached generation with a nested root alias even when its publication token matches', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    const generation = publishedPath(first.stdout);
    const dependencyRoot = join(generation, 'tree/packages/a/node_modules');
    chmodSync(dependencyRoot, 0o755);
    symlinkSync(join(integration, 'node_modules'), join(dependencyRoot, 'node_modules'));
    const result = spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'source "$SCRIPT"',
      'marker="$GENERATION/.papercusp-dependency-generation"',
      'chmod u+w "$marker"',
      'body="$(sed "/^publication_token=/d" "$marker")"',
      'printf "%s\\n" "$body" > "$marker"',
      'token="$(dependency_generation_publication_token "$GENERATION" 3)"',
      'printf "publication_token=%s\\n" "$token" >> "$marker"',
      'dependency_generation_publication_is_valid "$GENERATION"',
    ].join('\n')], {
      encoding: 'utf8',
      env: { ...process.env, SCRIPT, GENERATION: generation },
    });
    expect(result.status, result.stderr).not.toBe(0);
    expect(readFileSync(join(generation, '.papercusp-dependency-generation'), 'utf8'))
      .toMatch(/publication_token=v3:[0-9a-f]{64}/);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('excludes smoke repository churn from live trees and committed dependency inputs', () => {
    const integration = makeIntegration();
    const baselineRef = commitAllFixture(integration, 'product dependencies');
    const baseline = publish(integration);
    expect(baseline.status, baseline.stderr).toBe(0);
    const smoke = join(integration, '.papercusp-smoke-snapshots/hive-fromrepo-smoke.fixture');
    mkdirSync(join(smoke, 'node_modules/temporary'), { recursive: true });
    writeFileSync(join(smoke, 'node_modules/temporary/index.js'), 'ephemeral\n');
    writeFileSync(join(smoke, 'package-lock.json'), '{"name":"temporary"}\n');
    const smokeRef = commitAllFixture(integration, 'temporary smoke repository');

    const inputBefore = fingerprintRef(integration, baselineRef);
    const inputWithSmoke = fingerprintRef(integration, smokeRef);
    expect(inputBefore.status, inputBefore.stderr).toBe(0);
    expect(inputWithSmoke.status, inputWithSmoke.stderr).toBe(0);
    expect(publishedInputFingerprint(inputWithSmoke.stdout)).toBe(
      publishedInputFingerprint(inputBefore.stdout),
    );
    const withSmoke = publish(integration);
    expect(withSmoke.status, withSmoke.stderr).toBe(0);
    expect(publishedIdentity(withSmoke.stdout)).toBe(publishedIdentity(baseline.stdout));
    expect(existsSync(join(publishedPath(withSmoke.stdout), 'tree/.papercusp-smoke-snapshots'))).toBe(false);

    rmSync(smoke, { recursive: true });
    const removed = publish(integration);
    expect(removed.status, removed.stderr).toBe(0);
    expect(publishedIdentity(removed.stdout)).toBe(publishedIdentity(baseline.stdout));
    // A real product install still changes the generation and is copied.
    writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'changed product dependency\n');
    const changed = publish(integration);
    expect(changed.status, changed.stderr).toBe(0);
    expect(publishedIdentity(changed.stdout)).not.toBe(publishedIdentity(baseline.stdout));
    expect(readFileSync(join(publishedPath(changed.stdout), 'tree/node_modules/pkg/index.js'), 'utf8'))
      .toBe('changed product dependency\n');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('WI-322485: parses the whole long-running script before executing it', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const guardOpen = source.indexOf(
      '# ── Self-read guard (WI-322485):',
    );
    const firstFunction = source.indexOf('dependency_generation_log()');
    const mainCall = source.lastIndexOf('dependency_generation_main "$@"');
    const guardClose = source.lastIndexOf(
      '}  # ── end self-read guard (WI-322485) ──',
    );

    expect(guardOpen).toBeGreaterThan(source.indexOf('#!/usr/bin/env bash'));
    expect(firstFunction).toBeGreaterThan(guardOpen);
    expect(mainCall).toBeGreaterThan(firstFunction);
    expect(guardClose).toBeGreaterThan(mainCall);
    expect(source.slice(guardClose).trim()).toBe(
      '}  # ── end self-read guard (WI-322485) ──',
    );

    const syntax = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it.each([0, 23])('does not resume reading changed source after direct main (exit=%s)', exitCode => {
    const root = mkdtempSync(join(tmpdir(), 'generation-eof-guard-')); roots.push(root);
    const file = join(root, 'generation.sh');
    const source = readFileSync(SCRIPT, 'utf8');
    const call = '  dependency_generation_main "$@"';
    const at = source.lastIndexOf(call);
    expect(at).toBeGreaterThan(0);
    // The real parsed entrypoint runs a bounded main which changes its own
    // file. Without an exit inside the guard, Bash reads the appended syntax
    // after main has already emitted a successful result.
    const main = `  dependency_generation_main() {\n    printf '\\n)\\n' >> "$0"\n    printf 'MAIN_RESULT\\n'\n    return ${exitCode}\n  }\n`;
    writeFileSync(file, source.slice(0, at) + main + source.slice(at));
    const result = spawnSync('bash', [file], { encoding: 'utf8' });
    expect(result.stdout).toContain('MAIN_RESULT');
    expect(result.status, result.stderr).toBe(exitCode);
    expect(result.stderr).not.toContain('syntax error');
    // A sourceable library must continue its caller rather than exiting it.
    writeFileSync(file, source);
    const sourced = spawnSync('bash', ['-c', 'source "$1"; printf SOURCE_OK', 'source-test', file],
      { encoding: 'utf8' });
    expect(sourced.status, sourced.stderr).toBe(0);
    expect(sourced.stdout).toBe('SOURCE_OK');
  });

  it('publishes the whole product dependency set atomically and reuses its identity', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('DEPENDENCY_GENERATION_RESULT schema=1');
    expect(first.stdout).toContain('reused=false');
    expect(first.stderr).toContain(
      'capturing live dependency manifest (before copy)',
    );
    expect(first.stderr).toContain(
      'captured live dependency manifest (after copy)',
    );
    expect(first.stderr).toContain(
      'fingerprinted immutable copied dependency snapshot',
    );

    const generation = publishedPath(first.stdout);
    expect(
      readFileSync(join(generation, 'tree/node_modules/pkg/index.js'), 'utf8'),
    ).toBe('root-v1\n');
    expect(
      readFileSync(
        join(generation, 'tree/packages/a/node_modules/local/index.js'),
        'utf8',
      ),
    ).toBe('local-v1\n');
    expect(
      existsSync(
        join(
          generation,
          'tree/.papercusp/worktrees/repair/node_modules/foreign/index.js',
        ),
      ),
    ).toBe(false);
    expect(
      statSync(join(generation, 'tree/node_modules/pkg/index.js')).mode & 0o222,
    ).toBe(0);
    expect(readFileSync(join(generation, '.papercusp-dependency-generation'), 'utf8')).toContain(
      'schema=1',
    );
    expect(
      readdirSync(join(integration, '.papercusp/dependency-generations')).filter(
        (entry) => entry.startsWith('.build-'),
      ),
    ).toEqual([]);

    const second = publish(integration);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('reused=true');
    expect(publishedPath(second.stdout)).toBe(generation);
  });

  it('does not publish release-checkout snapshot provenance as dependency content', () => {
    const integration = makeIntegration();
    const sourceMarker = join(
      integration,
      'packages/a/node_modules/.papercusp-isolated-snapshot',
    );
    writeFileSync(sourceMarker, 'generation=stale-checkpoint\n');
    chmodSync(sourceMarker, 0o444);

    const result = publish(integration);
    expect(result.status, result.stderr).toBe(0);
    const generation = publishedPath(result.stdout);

    expect(
      existsSync(
        join(
          generation,
          'tree/packages/a/node_modules/.papercusp-isolated-snapshot',
        ),
      ),
    ).toBe(false);
    expect(readFileSync(sourceMarker, 'utf8')).toBe(
      'generation=stale-checkpoint\n',
    );
  });

  it(
    'P-001: reports writer-owned phases and deterministic full/hit/one-change counters',
    () => {
      const integration = makeIntegration();

      const full = publish(integration, {
        DEPENDENCY_GENERATION_WALK_JOBS: '1',
      });
      expect(full.status, full.stderr).toBe(0);
      const fullSummary = lastSummary(full);
      expect(fullSummary).toMatchObject({
        schema: '1',
        result: 'published',
        predecessor: 'none',
        trees_total: '3',
        trees_reused: '0',
        trees_copied: '3',
        trees_removed: '0',
      });
      expect(fullSummary.source).toMatch(/^[0-9a-f]{64}$/);
      expect(fullSummary.identity).toBe(`v1-${fullSummary.source}`);
      const fullPath = publishedPath(full.stdout);
      const fullIdentity = publishedIdentity(full.stdout);
      const fullMarker = readFileSync(
        join(fullPath, '.papercusp-dependency-generation'),
        'utf8',
      );
      expect(fullMarker).toContain('tree_manifest_schema=1\n');
      expect(fullMarker).toMatch(/tree_manifest_sha256=[0-9a-f]{64}\n/);
      expect(fullMarker).toContain('predecessor=none\n');
      expect(readFileSync(join(fullPath, '.tree-manifest'), 'utf8')).toBe(
        readFileSync(join(fullPath, '.source-after'), 'utf8'),
      );
      const fullPhases = telemetryRecords(full.stderr, 'PHASE');
      expect(fullPhases.map(({ phase }) => phase)).toEqual(
        expect.arrayContaining([
          'source-manifest-before',
          'cache-validation',
          'tree-copy',
          'source-manifest-after-copy',
          'freeze',
          'snapshot-fingerprint',
          'publish',
        ]),
      );
      for (const phase of fullPhases) {
        expect(Number(phase.duration_ms)).toBeGreaterThanOrEqual(0);
      }
      expect(Number(fullSummary.total_ms)).toBeGreaterThanOrEqual(0);

      const hit = publish(integration, {
        DEPENDENCY_GENERATION_WALK_JOBS: '1',
      });
      expect(hit.status, hit.stderr).toBe(0);
      expect(lastSummary(hit)).toMatchObject({
        result: 'cache-hit',
        trees_total: '3',
        trees_reused: '3',
        trees_copied: '0',
        trees_removed: '0',
      });
      expect(
        telemetryRecords(hit.stderr, 'PHASE').map(({ phase }) => phase),
      ).toEqual([
        'source-manifest-before',
        'cache-validation',
        'lock-tree-audit',
        'source-manifest-after-cache',
      ]);

      writeFileSync(
        join(integration, 'packages/a/node_modules/local/index.js'),
        'local-v2-with-one-tree-change\n',
      );
      const oneChanged = publish(integration, {
        DEPENDENCY_GENERATION_WALK_JOBS: '1',
      });
      expect(oneChanged.status, oneChanged.stderr).toBe(0);
      const oneChangedPath = publishedPath(oneChanged.stdout);
      const oneChangedIdentity = publishedIdentity(oneChanged.stdout);
      expect(lastSummary(oneChanged)).toMatchObject({
        result: 'published',
        predecessor: fullIdentity,
        trees_total: '3',
        trees_reused: '2',
        trees_copied: '1',
        trees_removed: '0',
      });
      expect(oneChangedIdentity).not.toBe(fullIdentity);
      expect(
        statSync(join(oneChangedPath, 'tree/node_modules/pkg/index.js')).ino,
      ).not.toBe(statSync(join(fullPath, 'tree/node_modules/pkg/index.js')).ino);
      expect(
        statSync(
          join(oneChangedPath, 'tree/packages/b/node_modules/other/index.js'),
        ).ino,
      ).not.toBe(
        statSync(join(fullPath, 'tree/packages/b/node_modules/other/index.js')).ino,
      );
      expect(
        statSync(
          join(oneChangedPath, 'tree/packages/a/node_modules/local/index.js'),
        ).ino,
      ).not.toBe(
        statSync(join(fullPath, 'tree/packages/a/node_modules/local/index.js')).ino,
      );

      rmSync(join(integration, 'packages/b/node_modules'), {
        recursive: true,
        force: true,
      });
      const oneRemoved = publish(integration, {
        DEPENDENCY_GENERATION_WALK_JOBS: '1',
      });
      expect(oneRemoved.status, oneRemoved.stderr).toBe(0);
      expect(lastSummary(oneRemoved)).toMatchObject({
        result: 'published',
        predecessor: oneChangedIdentity,
        trees_total: '2',
        trees_reused: '2',
        trees_copied: '0',
        trees_removed: '1',
      });
      expect(
        existsSync(
          join(
            publishedPath(oneRemoved.stdout),
            'tree/packages/b/node_modules',
          ),
        ),
      ).toBe(false);
    },
    NATIVE_SHELL_TIMEOUT_MS,
  );

  it('P-002: rejects corrupt reuse metadata and full-rebuilds from a valid legacy generation', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    const generation = publishedPath(first.stdout);
    const identity = publishedIdentity(first.stdout);
    const generationRoot = join(
      integration,
      '.papercusp/dependency-generations',
    );
    const marker = join(generation, '.papercusp-dependency-generation');
    const manifest = join(generation, '.tree-manifest');

    chmodSync(manifest, 0o644);
    writeFileSync(manifest, `${readFileSync(manifest, 'utf8')}corrupt\tmetadata\n`);
    const corrupt = selectGeneration(generationRoot, identity);
    expect(corrupt.status).toBe(74);
    expect(corrupt.stderr).toContain('is missing or invalid');

    rmSync(manifest);
    chmodSync(marker, 0o644);
    writeFileSync(
      marker,
      readFileSync(marker, 'utf8')
        .split('\n')
        .filter(
          (line) =>
            !line.startsWith('tree_manifest_') &&
            !line.startsWith('publication_schema=') &&
            !line.startsWith('publication_token=') &&
            !line.startsWith('predecessor=') &&
            !line.startsWith('trees_'),
        )
        .join('\n'),
    );
    const legacy = selectGeneration(generationRoot, identity);
    expect(legacy.status, legacy.stderr).toBe(0);

    writeFileSync(
      join(integration, 'packages/a/node_modules/local/index.js'),
      'legacy-fallback-change\n',
    );
    const rebuilt = publish(integration, {
      DEPENDENCY_GENERATION_WALK_JOBS: '1',
    });
    expect(rebuilt.status, rebuilt.stderr).toBe(0);
    expect(lastSummary(rebuilt)).toMatchObject({
      result: 'published',
      predecessor: 'none',
      trees_total: '3',
      trees_reused: '0',
      trees_copied: '3',
      trees_removed: '0',
    });
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('WI-41491: selects a prewarmed input by immutable identity without a generation walk', () => {
    const integration = makeIntegration();
    const published = publish(integration);
    expect(published.status, published.stderr).toBe(0);
    const generationRoot = join(
      integration,
      '.papercusp/dependency-generations',
    );
    const validationTrace = join(integration, 'selection-validation.trace');

    const selected = selectPrewarmed(generationRoot, integration, {
      DEPENDENCY_GENERATION_VALIDATION_TRACE: validationTrace,
    });

    expect(selected.status, selected.stderr).toBe(0);
    expect(publishedIdentity(selected.stdout)).toBe(
      publishedIdentity(published.stdout),
    );
    expect(publishedToken(selected.stdout)).toBe(
      publishedToken(published.stdout),
    );
    expect(existsSync(validationTrace)).toBe(false);
  });

  it('WI-10005569: a publication token survives a reboot that renumbers the block device (st_dev)', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    const generation = publishedPath(first.stdout);
    // A `stat` shim that reports a different st_dev (%d) for every path, as a
    // reboot renumbering /dev/nvme1n1 from 259:0 to 259:3 does.
    const shimDir = join(integration, 'stat-shim');
    mkdirSync(shimDir, { recursive: true });
    const realStat = execFileSync('bash', ['-c', 'command -v stat'], {
      encoding: 'utf8',
    }).trim();
    writeFileSync(
      join(shimDir, 'stat'),
      [
        '#!/usr/bin/env bash',
        `out="$(${realStat} "$@")" || exit $?`,
        'if [ "$1" = -c ] && [[ "$2" == %d* ]]; then',
        `  printf '%s\\n' "$out" | awk -F: 'BEGIN{OFS=":"}{$1=$1+3; print}'`,
        'else',
        `  printf '%s\\n' "$out"`,
        'fi',
      ].join('\n'),
      { mode: 0o755 },
    );
    const run = (body: string, shim: boolean) =>
      spawnSync('bash', ['-c', `set -uo pipefail\nsource "$SCRIPT"\n${body}`], {
        encoding: 'utf8',
        env: {
          ...process.env,
          SCRIPT,
          GENERATION: generation,
          PATH: shim ? `${shimDir}:${process.env.PATH}` : process.env.PATH,
        },
      });
    // Control: the shim really changes the device, so the legacy schema-2
    // token (which binds st_dev) moves under it. Without this the assertion
    // below could pass vacuously.
    const legacy = 'dependency_generation_publication_token "$GENERATION" 2';
    const legacyBefore = run(legacy, false);
    const legacyAfter = run(legacy, true);
    expect(legacyBefore.status, legacyBefore.stderr).toBe(0);
    expect(legacyAfter.stdout.trim()).toMatch(/^v2:[0-9a-f]{64}$/);
    expect(legacyAfter.stdout.trim()).not.toBe(legacyBefore.stdout.trim());

    const valid = run(
      'dependency_generation_publication_is_valid "$GENERATION" && echo VALID',
      true,
    );
    expect(valid.stdout, valid.stderr).toContain('VALID');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('WI-10005617: the selector token of a legacy schema-2 marker is its own v2 token, not a v3 recompute', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    const generation = publishedPath(first.stdout);
    // Rewrite the marker IN PLACE (same inode) as a legacy schema-2
    // publication, the shape every generation published before WI-10005569
    // still carries on disk.
    const result = spawnSync(
      'bash',
      [
        '-c',
        [
          'set -euo pipefail',
          'source "$SCRIPT"',
          'M="$GENERATION/.papercusp-dependency-generation"',
          'chmod u+w "$M"',
          `body="$(sed '/^publication_token=/d; s/^publication_schema=.*/publication_schema=2/' "$M")"`,
          `printf '%s\\n' "$body" > "$M"`,
          'tok="$(dependency_generation_publication_token "$GENERATION" 2)"',
          `printf 'publication_token=%s\\n' "$tok" >> "$M"`,
          'echo "RECORDED=$tok"',
          'echo "SELECTOR=$(dependency_generation_selector_token "$GENERATION")"',
          'dependency_generation_publication_is_valid "$GENERATION" && echo VALID',
        ].join('\n'),
      ],
      { encoding: 'utf8', env: { ...process.env, SCRIPT, GENERATION: generation } },
    );
    expect(result.status, result.stderr).toBe(0);
    const recorded = /RECORDED=(\S+)/.exec(result.stdout)?.[1];
    const selector = /SELECTOR=(\S+)/.exec(result.stdout)?.[1];
    expect(recorded).toMatch(/^v2:[0-9a-f]{64}$/);
    expect(selector).toBe(recorded);
    expect(result.stdout).toContain('VALID');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('P-003: validates an ordinary cache hit from the v3 publication token without a generation walk', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    expect(publishedToken(first.stdout)).toMatch(/^v3:[0-9a-f]{64}$/);
    const generation = publishedPath(first.stdout);
    const marker = readFileSync(
      join(generation, '.papercusp-dependency-generation'),
      'utf8',
    );
    expect(marker).toContain('publication_schema=3\n');
    expect(marker).toContain(`publication_token=${publishedToken(first.stdout)}\n`);
    const validationTrace = join(integration, 'hot-validation.trace');

    const second = publish(integration, {
      DEPENDENCY_GENERATION_VALIDATION_TRACE: validationTrace,
    });

    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('reused=true');
    expect(publishedToken(second.stdout)).toBe(publishedToken(first.stdout));
    expect(existsSync(validationTrace)).toBe(false);
    expect(
      telemetryRecords(second.stderr, 'PHASE').find(
        ({ phase }) => phase === 'cache-validation',
      ),
    ).toMatchObject({ outcome: 'hot-hit' });
  });

  it('P-003: deep-audits but rebuilds a content-valid generation whose publication token was tampered', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    const generation = publishedPath(first.stdout);
    invalidatePublicationToken(generation);

    const deepAudit = deepAuditGeneration(generation);
    expect(deepAudit.status, deepAudit.stderr).toBe(0);
    expect(deepAudit.stdout).toContain('DEEP_AUDIT_OK');
    const unsafeSelection = selectGeneration(
      join(integration, '.papercusp/dependency-generations'),
      publishedIdentity(first.stdout),
    );
    expect(unsafeSelection.status).toBe(74);

    const repaired = publish(integration, {
      DEPENDENCY_GENERATION_WALK_JOBS: '1',
    });
    expect(repaired.status, repaired.stderr).toBe(0);
    expect(repaired.stdout).toContain('reused=false');
    expect(repaired.stderr).toContain(
      'publication token invalid for content-valid generation',
    );
    expect(lastSummary(repaired)).toMatchObject({
      result: 'published',
      trees_total: '3',
      trees_reused: '0',
      trees_copied: '3',
      trees_removed: '0',
    });
    expect(publishedToken(repaired.stdout)).toMatch(/^v3:[0-9a-f]{64}$/);
    expect(publishedToken(repaired.stdout)).not.toBe(`v2:${'0'.repeat(64)}`);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('P-003: reads a pre-token generation through the legacy deep-validation fallback', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    const generation = publishedPath(first.stdout);
    const marker = join(generation, '.papercusp-dependency-generation');
    chmodSync(marker, 0o644);
    writeFileSync(
      marker,
      readFileSync(marker, 'utf8')
        .split('\n')
        .filter(
          (line) =>
            !line.startsWith('publication_schema=') &&
            !line.startsWith('publication_token='),
        )
        .join('\n'),
    );
    const validationTrace = join(integration, 'legacy-validation.trace');

    const legacyHit = publish(integration, {
      DEPENDENCY_GENERATION_VALIDATION_TRACE: validationTrace,
    });

    expect(legacyHit.status, legacyHit.stderr).toBe(0);
    expect(legacyHit.stdout).toContain('reused=true');
    expect(readFileSync(validationTrace, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(
      telemetryRecords(legacyHit.stderr, 'PHASE').find(
        ({ phase }) => phase === 'cache-validation',
      ),
    ).toMatchObject({ outcome: 'legacy-deep-hit' });
    expect(publishedToken(legacyHit.stdout)).not.toMatch(/^v[23]:/);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('WI-41491: invalidates the selector when dependency inputs change and rewarms the new key', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    const generationRoot = join(
      integration,
      '.papercusp/dependency-generations',
    );

    writeFileSync(
      join(integration, 'package-lock.json'),
      JSON.stringify({ ...JSON.parse(readFileSync(join(integration, 'package-lock.json'), 'utf8')),
        packages: { ...JSON.parse(readFileSync(join(integration, 'package-lock.json'), 'utf8')).packages,
          'node_modules/new': { version: '1.0.0' } } }) + '\n',
    );
    const miss = selectPrewarmed(generationRoot, integration);
    expect(miss.status).toBe(74);
    expect(miss.stderr).toContain('no prewarmed dependency generation');
    // WI-10005159: the miss names the store it searched, so a wrong-store miss explains itself.
    expect(miss.stderr).toContain(`(generation_root=${generationRoot})`);

    mkdirSync(join(integration, 'node_modules/new'), { recursive: true });
    writeFileSync(
      join(integration, 'node_modules/new/package.json'),
      '{"name":"new","version":"1.0.0"}\n',
    );
    const rewarmed = publish(integration);
    expect(rewarmed.status, rewarmed.stderr).toBe(0);
    const selected = selectPrewarmed(generationRoot, integration);
    expect(selected.status, selected.stderr).toBe(0);
    expect(publishedIdentity(selected.stdout)).toBe(
      publishedIdentity(rewarmed.stdout),
    );
  });

  it('D-081: an unseen exact-ref fingerprint is published and selected before checkpoint serialization', () => {
    const integration = makeIntegration();
    const candidate = commitFixture(integration, 'candidate');

    const first = ensureRef(integration, candidate);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stderr).toContain('has unseen dependency inputs');
    expect(first.stderr).toContain('prewarming before checkpoint serialization');
    expect(first.stdout).toMatch(/\binput=[0-9a-f]{64}\b/);
    expect(first.stdout).toMatch(/\btoken=\S+/);

    // The second exact-candidate pass is the selector hit: no live generation
    // manifest walk or publication is allowed back onto the serialized path.
    const second = ensureRef(integration, candidate);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stderr).not.toContain('capturing live dependency manifest');
    expect(publishedIdentity(second.stdout)).toBe(publishedIdentity(first.stdout));
    expect(publishedToken(second.stdout)).toBe(publishedToken(first.stdout));
  });

  describe('WI-6554700010008481: --ensure-ref --retain-as ref pins', () => {
    const LABEL = 'checkpoint-candidate';
    const refPins = (generationRoot: string): string[] => {
      const pins = join(generationRoot, '.pins');
      if (!existsSync(pins)) return [];
      return readdirSync(pins).filter((entry) => entry.startsWith('ref-') && !entry.includes('.tmp.'));
    };
    const readPin = (path: string): Record<string, string> =>
      Object.fromEntries(
        readFileSync(path, 'utf8')
          .trim()
          .split('\n')
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      );

    it('pins the ensured identity once per integration and label, and refreshes it on a selector hit', () => {
      const integration = makeIntegration();
      const generationRoot = join(integration, '.papercusp/dependency-generations');
      const candidate = commitFixture(integration, 'candidate');

      const first = ensureRef(integration, candidate, {}, undefined, ['--retain-as', LABEL]);
      expect(first.status, first.stderr).toBe(0);
      const pins = refPins(generationRoot);
      expect(pins).toHaveLength(1);
      const pin = readPin(join(generationRoot, '.pins', pins[0]));
      expect(pin).toMatchObject({
        kind: 'ref',
        label: LABEL,
        identity: publishedIdentity(first.stdout),
        ref: candidate,
      });
      expect(Number(pin.expires)).toBeGreaterThan(Number(pin.updated));
      expect(readPin(join(pin.checkout, 'node_modules/.papercusp-dependency-generation')).identity)
        .toBe(pin.identity);

      const second = ensureRef(integration, candidate, {}, undefined, ['--retain-as', LABEL]);
      expect(second.status, second.stderr).toBe(0);
      expect(refPins(generationRoot)).toEqual(pins);
      expect(second.stderr).toContain(
        `retained ${publishedIdentity(second.stdout)} as ref pin '${LABEL}' for ${candidate}`,
      );
    }, NATIVE_SHELL_TIMEOUT_MS);

    it('preserves an unexpired ref pin when a pre-ref-pin checkout reader refreshes the shared store', () => {
      const integration = makeIntegration();
      const generationRoot = join(integration, '.papercusp/dependency-generations');
      const candidate = commitFixture(integration, 'candidate');
      const ensured = ensureRef(integration, candidate, {}, undefined, ['--retain-as', LABEL]);
      expect(ensured.status, ensured.stderr).toBe(0);
      const identity = publishedIdentity(ensured.stdout);
      const [pinName] = refPins(generationRoot);
      const pinPath = join(generationRoot, '.pins', pinName);

      // Frozen reader contract from the deployed helper predating 806a03bf65:
      // same-host pins survive only when checkout/node_modules has the matching
      // generation marker. It does not understand kind=ref or expires.
      const legacyRefresh = spawnSync('bash', ['-c', [
        'set -euo pipefail',
        'source "$SCRIPT"',
        'host="$(dependency_generation_host)"',
        'for pin in "$GENERATION_ROOT"/.pins/*; do',
        '  [ -f "$pin" ] || continue',
        '  pin_host="$(dependency_generation_read_field "$pin" host)"',
        '  identity="$(dependency_generation_read_field "$pin" identity)"',
        '  checkout="$(dependency_generation_read_field "$pin" checkout)"',
        '  [ -z "$pin_host" ] || [ "$pin_host" = "$host" ] || continue',
        '  marker="$checkout/node_modules/.papercusp-dependency-generation"',
        '  if [ ! -f "$marker" ] || [ "$(dependency_generation_read_field "$marker" identity)" != "$identity" ] || ! dependency_generation_marker_matches "$GENERATION_ROOT/$identity" "$identity"; then',
        '    rm -f -- "$pin"',
        '  fi',
        'done',
      ].join('\n')], {
        encoding: 'utf8',
        env: { ...process.env, SCRIPT, GENERATION_ROOT: generationRoot },
      });
      expect(legacyRefresh.status, String(legacyRefresh.stderr)).toBe(0);
      expect(existsSync(pinPath)).toBe(true);

      // A distinct input key leaves the candidate's selector intact. Publishing
      // different tree bytes under the SAME lock inputs legitimately replaces it.
      appendFileSync(join(integration, 'package-lock.json'), '\n');
      writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'newer-unpinned\n');
      const newer = publish(integration, { DEPENDENCY_GENERATION_RETAIN_COUNT: '1' });
      expect(newer.status, newer.stderr).toBe(0);
      expect(existsSync(join(generationRoot, identity))).toBe(true);
      const selected = ensureRef(integration, candidate);
      expect(selected.status, selected.stderr).toBe(0);
      expect(publishedIdentity(selected.stdout)).toBe(identity);
      expect(selected.stderr).not.toContain('prewarming before checkpoint serialization');
    }, NATIVE_SHELL_TIMEOUT_MS);

    it('keeps a ref-pinned generation through recency retention until the pin expires', () => {
      const integration = makeIntegration();
      const generationRoot = join(integration, '.papercusp/dependency-generations');
      const candidate = commitFixture(integration, 'candidate');
      const ensured = ensureRef(integration, candidate, {}, undefined, ['--retain-as', LABEL]);
      expect(ensured.status, ensured.stderr).toBe(0);
      const pinned = join(generationRoot, publishedIdentity(ensured.stdout));
      expect(existsSync(pinned)).toBe(true);

      const newer: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        writeFileSync(join(integration, 'node_modules/pkg/index.js'), `root-v${i}\n`);
        const result = publish(integration, { DEPENDENCY_GENERATION_RETAIN_COUNT: '1' });
        expect(result.status, result.stderr).toBe(0);
        newer.push(join(generationRoot, publishedIdentity(result.stdout)));
      }
      // Control: recency retention ran and kept only the newest unpinned publish.
      expect(existsSync(newer[0])).toBe(false);
      expect(existsSync(newer[1])).toBe(false);
      expect(existsSync(newer[2])).toBe(true);
      // The ensured generation is older than all three and survives only by its pin.
      expect(existsSync(pinned)).toBe(true);

      const [pinName] = refPins(generationRoot);
      const pinPath = join(generationRoot, '.pins', pinName);
      const compatibilityCheckout = readPin(pinPath).checkout;
      writeFileSync(pinPath, readFileSync(pinPath, 'utf8').replace(/^expires=\d+$/m, 'expires=1'));
      writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'root-after-expiry\n');
      const afterExpiry = publish(integration, { DEPENDENCY_GENERATION_RETAIN_COUNT: '1' });
      expect(afterExpiry.status, afterExpiry.stderr).toBe(0);
      expect(afterExpiry.stderr).toContain(`removing expired or stale ref pin ${pinName}`);
      expect(existsSync(pinPath)).toBe(false);
      expect(existsSync(pinned)).toBe(false);
      expect(existsSync(compatibilityCheckout)).toBe(false);
    }, NATIVE_SHELL_TIMEOUT_MS);

    it('refuses --retain-as without --ensure-ref or with a malformed label', () => {
      const integration = makeIntegration();
      const candidate = commitFixture(integration, 'candidate');
      const orphan = spawnSync('bash', [SCRIPT, '--integration', integration, '--retain-as', LABEL], {
        encoding: 'utf8',
        env: process.env,
      });
      expect(orphan.status).toBe(2);
      expect(String(orphan.stderr)).toContain('--retain-as requires --ensure-ref');

      const malformed = ensureRef(integration, candidate, {}, undefined, ['--retain-as', 'Bad Label']);
      expect(malformed.status).toBe(2);
      expect(malformed.stderr).toContain('--retain-as label must match');
      expect(refPins(join(integration, '.papercusp/dependency-generations'))).toEqual([]);
    });
  });

  it('WI-10003403: direct --ensure-ref honors the environment generation root unless a CLI root is explicit', () => {
    const integration = makeIntegration();
    const candidate = commitFixture(integration, 'candidate');
    const configuredRoot = join(dirname(integration), 'configured-generations');
    const env = { PAPERCUSP_DEPENDENCY_GENERATION_ROOT: configuredRoot };

    const configured = ensureRef(integration, candidate, env);
    expect(configured.status, configured.stderr).toBe(0);
    expect(publishedPath(configured.stdout).startsWith(`${configuredRoot}/`)).toBe(true);
    expect(existsSync(join(integration, '.papercusp/dependency-generations'))).toBe(false);

    const explicitRoot = join(dirname(integration), 'explicit-generations');
    const explicit = ensureRef(integration, candidate, env, explicitRoot);
    expect(explicit.status, explicit.stderr).toBe(0);
    expect(publishedPath(explicit.stdout).startsWith(`${explicitRoot}/`)).toBe(true);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('WI-10005159: an env-less caller follows the generation root a configured run recorded for the integration root', () => {
    const integration = makeIntegration();
    const candidate = commitFixture(integration, 'candidate');
    const configuredRoot = join(dirname(integration), 'recorded-generations');
    const record = join(integration, '.papercusp/dependency-generation-root');

    const configured = ensureRef(integration, candidate, {
      PAPERCUSP_DEPENDENCY_GENERATION_ROOT: configuredRoot,
    });
    expect(configured.status, configured.stderr).toBe(0);
    expect(readFileSync(record, 'utf8')).toBe(`${configuredRoot}\n`);

    // bg-host's env is absent from a manual systemd-run unit, install:safe and an
    // agent shell; an empty value is unset to bash `:-`.
    const envLess = ensureRef(integration, candidate, { PAPERCUSP_DEPENDENCY_GENERATION_ROOT: '' });
    expect(envLess.status, envLess.stderr).toBe(0);
    expect(publishedPath(envLess.stdout).startsWith(`${configuredRoot}/`)).toBe(true);
    expect(publishedIdentity(envLess.stdout)).toBe(publishedIdentity(configured.stdout));
    expect(existsSync(join(integration, '.papercusp/dependency-generations'))).toBe(false);

    const explicitRoot = join(dirname(integration), 'explicit-generations');
    const explicit = ensureRef(integration, candidate, { PAPERCUSP_DEPENDENCY_GENERATION_ROOT: '' }, explicitRoot);
    expect(explicit.status, explicit.stderr).toBe(0);
    expect(publishedPath(explicit.stdout).startsWith(`${explicitRoot}/`)).toBe(true);
    // An explicit root is a one-off; it never rewrites the record.
    expect(readFileSync(record, 'utf8')).toBe(`${configuredRoot}\n`);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('WI-10006081: once the root moves, retention sweeps the legacy tree-local store except live pins', () => {
    const integration = makeIntegration();
    const legacyRoot = join(integration, '.papercusp/dependency-generations');
    const envLess = { PAPERCUSP_DEPENDENCY_GENERATION_ROOT: '' };

    // Two generations published before any root was configured land in the
    // tree-local store; a direct sibling checkout still runs on the second one.
    const stale = publish(integration, envLess);
    expect(stale.status, stale.stderr).toBe(0);
    const stalePath = publishedPath(stale.stdout);
    expect(stalePath.startsWith(`${legacyRoot}/`)).toBe(true);
    writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'root-v2\n');
    const pinned = publish(integration, envLess);
    expect(pinned.status, pinned.stderr).toBe(0);
    const pinnedIdentity = publishedIdentity(pinned.stdout);
    const pinnedPath = publishedPath(pinned.stdout);
    const checkout = join(dirname(integration), 'checkpoint');
    mkdirSync(join(checkout, 'node_modules'), { recursive: true });
    const marker = join(checkout, 'node_modules/.papercusp-dependency-generation');
    writeFileSync(marker, `identity=${pinnedIdentity}\nsource=${pinnedIdentity.slice(3)}\n`);

    // A one-off explicit root with no env and no record is NOT a move: the
    // tree-local store is still the real one and must be left alone.
    writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'root-v3\n');
    const oneOff = publish(integration, envLess, join(dirname(integration), 'one-off'));
    expect(oneOff.status, oneOff.stderr).toBe(0);
    expect(oneOff.stderr).not.toContain('sweeping legacy tree-local generation store');
    expect(existsSync(stalePath)).toBe(true);

    // The configured run moves the root: the unpinned legacy generation goes,
    // the pinned one stays.
    const configuredRoot = join(dirname(integration), 'configured-generations');
    const moved = publish(integration, { PAPERCUSP_DEPENDENCY_GENERATION_ROOT: configuredRoot });
    expect(moved.status, moved.stderr).toBe(0);
    expect(publishedPath(moved.stdout).startsWith(`${configuredRoot}/`)).toBe(true);
    expect(moved.stderr).toContain('sweeping legacy tree-local generation store');
    expect(existsSync(stalePath)).toBe(false);
    expect(existsSync(pinnedPath)).toBe(true);

    // Once the checkout moves off it, an env-less caller following the record
    // reclaims the last legacy generation too.
    rmSync(marker);
    writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'root-v4\n');
    const followed = publish(integration, envLess);
    expect(followed.status, followed.stderr).toBe(0);
    expect(publishedPath(followed.stdout).startsWith(`${configuredRoot}/`)).toBe(true);
    expect(existsSync(pinnedPath)).toBe(false);
    expect(readdirSync(legacyRoot).filter((entry) => entry.startsWith('v1-'))).toEqual([]);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it.each([
    ['independent copy', false],
    ['internal symlink', false],
    ['internal hardlink', false],
    ['fresh pin', true],
    ['foreign pin', true],
    ['live lease', true],
    ['hardlink', true],
    ['generation symlink', true],
    ['newline symlink', true],
    ['external symlink', true],
    ['unreadable inventory', true],
  ] as const)(
    'EI-25299577060523251: legacy sweep handles an old same-filesystem %s safely',
    (protection, retained) => {
      const integration = makeIntegration();
      const legacyRoot = join(integration, '.papercusp/dependency-generations');
      const first = publish(integration, { PAPERCUSP_DEPENDENCY_GENERATION_ROOT: '' }, legacyRoot);
      expect(first.status, first.stderr).toBe(0);
      const identity = publishedIdentity(first.stdout);
      const generation = publishedPath(first.stdout);
      const checkout = join(dirname(integration), 'old-checkpoint');
      mkdirSync(join(checkout, 'node_modules/pkg'), { recursive: true });
      const independentFile = join(checkout, 'node_modules/pkg/index.js');
      writeFileSync(independentFile, 'independent checkout\n');
      const marker = join(checkout, 'node_modules/.papercusp-dependency-generation');
      writeFileSync(marker, `identity=${identity}\nsource=${identity.slice(3)}\n`);
      const retentionEnv: NodeJS.ProcessEnv = {};
      expect(statSync(checkout).dev).toBe(statSync(legacyRoot).dev);
      const aged = new Date(Date.now() - 4 * 86_400_000);
      if (protection !== 'fresh pin') utimesSync(marker, aged, aged);
      if (protection === 'foreign pin') {
        mkdirSync(join(legacyRoot, '.pins'), { recursive: true });
        writeFileSync(join(legacyRoot, '.pins/foreign'),
          `host=another-host\nidentity=${identity}\ncheckout=${checkout}\n`);
      } else if (protection === 'live lease') {
        mkdirSync(join(legacyRoot, '.leases'), { recursive: true });
        writeFileSync(join(legacyRoot, '.leases/live'),
          `host=${execFileSync('hostname', { encoding: 'utf8' }).trim()}\n` +
          `pid=${process.pid}\nidentity=${identity}\n`);
      } else if (protection === 'hardlink') {
        linkSync(join(generation, 'tree/node_modules/pkg/index.js'), join(checkout, 'shared.js'));
      } else if (protection === 'internal hardlink') {
        linkSync(join(generation, 'tree/node_modules/pkg/index.js'), join(generation, 'internal-alias.js'));
      } else if (protection === 'generation symlink') {
        symlinkSync(join(generation, 'tree/node_modules/pkg'), join(checkout, 'linked-package'));
      } else if (protection === 'newline symlink') {
        symlinkSync(join(generation, 'tree/node_modules/pkg'), join(checkout, 'linked\npackage'));
      } else if (protection === 'external symlink') {
        symlinkSync(integration, join(checkout, 'other-checkout'));
      } else if (protection === 'internal symlink') {
        symlinkSync('node_modules/pkg', join(checkout, 'linked-package'));
        symlinkSync('missing-internal-package', join(checkout, 'broken-internal-link'));
      } else if (protection === 'unreadable inventory') {
        const shimBin = join(dirname(integration), 'shim-bin');
        mkdirSync(shimBin);
        const realFind = execFileSync('sh', ['-c', 'command -v find'], { encoding: 'utf8' }).trim();
        writeFileSync(join(shimBin, 'find'),
          '#!/bin/bash\n[ "$1" != "$RETENTION_TEST_UNREADABLE_GENERATION" ] || exit 1\n' +
          `exec ${JSON.stringify(realFind)} "$@"\n`);
        chmodSync(join(shimBin, 'find'), 0o755);
        retentionEnv.PATH = `${shimBin}:${process.env.PATH}`;
        retentionEnv.RETENTION_TEST_UNREADABLE_GENERATION = generation;
      }
      // Migrate using the real publisher/retention path, then follow its record
      // without the service's env. A sibling import must not resurrect the old
      // independent pin. Its own files remain readable after the store is pruned.
      const configuredRoot = join(dirname(integration), 'persistent-generations');
      const moved = publish(integration, { ...retentionEnv, PAPERCUSP_DEPENDENCY_GENERATION_ROOT: configuredRoot });
      expect(moved.status, moved.stderr).toBe(0);
      expect(existsSync(generation)).toBe(retained);
      const followed = spawnSync('bash', [SCRIPT, '--integration', integration, '--prune-only'], {
        encoding: 'utf8', env: { ...process.env, ...retentionEnv, PAPERCUSP_DEPENDENCY_GENERATION_ROOT: '' },
      });
      expect(followed.status, followed.stderr).toBe(0);
      expect(existsSync(generation)).toBe(retained);
      expect(readFileSync(independentFile, 'utf8')).toBe('independent checkout\n');
      if (protection === 'live lease') expect(existsSync(join(legacyRoot, '.leases/live'))).toBe(true);
      if (protection === 'foreign pin') expect(existsSync(join(legacyRoot, '.pins/foreign'))).toBe(true);
    },
    NATIVE_SHELL_TIMEOUT_MS,
  );

  it('EI-25299577060523251: ordinary retention keeps an old same-filesystem checkout pin', () => {
    const integration = makeIntegration();
    const generationRoot = join(dirname(integration), 'persistent-generations');
    const env = { PAPERCUSP_DEPENDENCY_GENERATION_ROOT: generationRoot, DEPENDENCY_GENERATION_RETAIN_COUNT: '1' };
    const first = publish(integration, env);
    expect(first.status, first.stderr).toBe(0);
    const identity = publishedIdentity(first.stdout);
    const generation = publishedPath(first.stdout);
    const checkout = join(dirname(integration), 'old-checkpoint');
    mkdirSync(join(checkout, 'node_modules'), { recursive: true });
    const marker = join(checkout, 'node_modules/.papercusp-dependency-generation');
    writeFileSync(marker, `identity=${identity}\nsource=${identity.slice(3)}\n`);
    const aged = new Date(Date.now() - 4 * 86_400_000);
    utimesSync(marker, aged, aged);
    writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'new persistent generation\n');
    const next = publish(integration, env);
    expect(next.status, next.stderr).toBe(0);
    expect(publishedIdentity(next.stdout)).not.toBe(identity);
    expect(existsSync(generation)).toBe(true);
    expect(existsSync(publishedPath(next.stdout))).toBe(true);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('P-004: exposes the cheap immutable candidate/input key without reading mutable live lockfiles', () => {
    const integration = makeIntegration();
    const firstCandidate = commitFixture(integration, 'first dependency inputs');
    const first = fingerprintRef(integration, firstCandidate);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toMatch(
      new RegExp(
        `^DEPENDENCY_INPUT_FINGERPRINT schema=1 candidate=${firstCandidate} input=[0-9a-f]{64}\\n$`,
      ),
    );

    // The producer keys the immutable candidate, never the churning worktree.
    writeFileSync(
      join(integration, 'package-lock.json'),
      '{"name":"fixture","lockfileVersion":3,"packages":{"node_modules/live-drift":{}}}\n',
    );
    const stable = fingerprintRef(integration, firstCandidate);
    expect(stable.status, stable.stderr).toBe(0);
    expect(publishedInputFingerprint(stable.stdout)).toBe(
      publishedInputFingerprint(first.stdout),
    );

    const secondCandidate = commitFixture(integration, 'second dependency inputs');
    const second = fingerprintRef(integration, secondCandidate);
    expect(second.status, second.stderr).toBe(0);
    expect(publishedInputFingerprint(second.stdout)).not.toBe(
      publishedInputFingerprint(first.stdout),
    );
  });

  it('WI-313670: an unseen exact ref can bind a cache-hit generation without an unbound after-manifest', () => {
    const integration = makeIntegration();
    const candidate = commitFixture(integration, 'cache-hit candidate');
    const prewarmed = publish(integration);
    expect(prewarmed.status, prewarmed.stderr).toBe(0);
    const generationRoot = join(
      integration,
      '.papercusp/dependency-generations',
    );
    // Force only the cheap candidate-input selector to miss; the immutable
    // dependency generation itself remains a valid cache hit. This is the exact
    // main-path branch that the audited desktop build reached before set -u
    // exposed an uninitialized after_manifest.
    rmSync(join(generationRoot, '.inputs'), { recursive: true, force: true });

    const rebound = ensureRef(integration, candidate);

    expect(rebound.status, rebound.stderr).toBe(0);
    expect(rebound.stdout).toContain('reused=true');
    expect(publishedIdentity(rebound.stdout)).toBe(
      publishedIdentity(prewarmed.stdout),
    );
    expect(publishedToken(rebound.stdout)).toBe(publishedToken(prewarmed.stdout));
    expect(rebound.stderr).toContain('has unseen dependency inputs');
    expect(rebound.stderr).toContain(
      'capturing live dependency manifest (after existing-generation validation)',
    );
    expect(rebound.stderr).not.toContain('building v1-');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('D-081: exact-ref ensure fails closed when live dependency inputs no longer match the candidate', () => {
    const integration = makeIntegration();
    const candidate = commitFixture(integration, 'candidate');
    writeFileSync(
      join(integration, 'package-lock.json'),
      '{"name":"fixture","lockfileVersion":3,"packages":{"node_modules/live-only":{}}}\n',
    );

    const result = ensureRef(integration, candidate);
    expect(result.status).toBe(74);
    expect(result.stderr).toContain('no prewarmed dependency generation');
    // WI-10004151: the refusal now NAMES why the ref cannot be built from the live trees.
    expect(result.stderr).toContain('not install-equivalent');
    expect(result.stderr).toContain('node_modules/live-only');
  });

  // WI-10004151: the frozen repair queue admits package-lock.json hunk-exactly, which yields
  // a lock NO checkout ever installed. --ensure-ref used to publish from the live tree and
  // re-open by the ref's key — a permanent exit 74 that stalled verification (5955f82b).
  const lockWith = (packages: Record<string, Record<string, unknown>>) =>
    `${JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': { name: 'fixture' },
      'packages/a/node_modules/local': { version: '1.0.0' },
      'packages/b/node_modules/other': { version: '1.0.0', optional: true }, ...packages } })}\n`;
  const PKG = {
    'node_modules/pkg': {
      version: '1.0.0',
      resolved: 'https://registry.example.invalid/pkg-1.0.0.tgz',
      integrity: 'sha512-fixture',
    },
  };
  const exactScratch = (integration: string) =>
    join(integration, '.papercusp/dependency-exact-ref');

  it('WI-10004151: builds an exact ref from its own lockfiles when it differs from live only by a workspace link', () => {
    const integration = makeIntegration();
    writeFileSync(join(integration, 'package-lock.json'), lockWith(PKG));
    const candidate = commitFixture(integration, 'candidate lock without the staging-only link');
    const exact = fingerprintRef(integration, candidate);
    expect(exact.status, exact.stderr).toBe(0);
    const exactInput = publishedInputFingerprint(exact.stdout);

    // Live (staging) moved on: a new workspace link the candidate's lock does not have.
    writeFileSync(
      join(integration, 'package-lock.json'),
      lockWith({
        ...PKG,
        'node_modules/@papercusp/extra': { resolved: 'packages/b', link: true },
      }),
    );
    mkdirSync(join(integration, 'node_modules/@papercusp'), { recursive: true });
    execFileSync('ln', ['-s', '../../packages/b', join(integration, 'node_modules/@papercusp/extra')]);

    const built = ensureRef(integration, candidate);
    expect(built.status, built.stderr).toBe(0);
    expect(built.stderr).toContain("building from the ref's own lockfiles");
    expect(built.stderr).toContain('dropped live-only workspace link node_modules/@papercusp/extra');
    // Indexed under the CANDIDATE's key, not the live tree's.
    expect(publishedInputFingerprint(built.stdout)).toBe(exactInput);
    const generation = publishedPath(built.stdout);
    expect(readFileSync(join(generation, 'tree/node_modules/pkg/index.js'), 'utf8')).toBe('root-v1\n');
    expect(readFileSync(join(generation, 'tree/packages/a/node_modules/local/index.js'), 'utf8')).toBe('local-v1\n');
    expect(existsSync(join(generation, 'tree/node_modules/@papercusp/extra'))).toBe(false);
    // The live tree is untouched and the private scratch root is gone.
    expect(existsSync(join(integration, 'node_modules/@papercusp/extra'))).toBe(true);
    expect(readFileSync(join(integration, 'node_modules/pkg/index.js'), 'utf8')).toBe('root-v1\n');
    expect(readdirSync(exactScratch(integration))).toEqual([]);

    // The next exact-candidate pass is a plain selector hit on the same identity.
    const again = ensureRef(integration, candidate);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stderr).not.toContain("building from the ref's own lockfiles");
    expect(publishedIdentity(again.stdout)).toBe(publishedIdentity(built.stdout));
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('WI-10004151: refuses (74, reasons named) an exact ref that would need a real install, and leaves no scratch', () => {
    const integration = makeIntegration();
    writeFileSync(join(integration, 'package-lock.json'), lockWith(PKG));
    const candidate = commitFixture(integration, 'candidate at pkg 1.0.0');
    writeFileSync(
      join(integration, 'package-lock.json'),
      lockWith({ 'node_modules/pkg': { ...PKG['node_modules/pkg'], version: '2.0.0' } }),
    );

    const result = ensureRef(integration, candidate);
    expect(result.status).toBe(74);
    // The gate's describeRepairHeadRunnerFailure keys on this exact phrase.
    expect(result.stderr).toMatch(/no prewarmed dependency generation for input fingerprint [0-9a-f]{64}/);
    expect(result.stderr).toContain('not install-equivalent');
    expect(result.stderr).toContain('node_modules/pkg: version "1.0.0" (ref) vs "2.0.0" (live)');
    expect(result.stdout).not.toContain('DEPENDENCY_GENERATION_RESULT');
    expect(readdirSync(exactScratch(integration))).toEqual([]);
  }, NATIVE_SHELL_TIMEOUT_MS);

  // WI-10004151 part 2: release:repair-queue admit asks this BEFORE publishing a lockfile
  // admission, so a lock the gate can never build is refused at admit time, not an hour later.
  const predictRef = (integration: string, ref: string, extra: string[] = []): ShellResult => {
    const result = spawnSync('bash', [SCRIPT, '--integration', integration, '--predict-ref', ref, ...extra], {
      encoding: 'utf8',
      env: process.env,
    });
    return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  };
  const predictionOf = (stdout: string) => {
    const line = stdout.split('\n').find((l) => l.startsWith('DEPENDENCY_GENERATION_PREDICTION '));
    if (!line) throw new Error(`missing prediction line in: ${stdout}`);
    return Object.fromEntries(
      line.split(' ').slice(1).map((kv) => kv.split('=') as [string, string]),
    ) as Record<'schema' | 'ref' | 'input' | 'live' | 'verdict' | 'links', string>;
  };

  it('WI-10004151: reuses an equivalent prewarmed ancestor after live dependencies move on', () => {
    const integration = makeIntegration();
    writeFileSync(join(integration, 'package-lock.json'), lockWith(PKG));
    commitFixture(integration, 'installed baseline');
    const baseline = publish(integration);
    expect(baseline.status, baseline.stderr).toBe(0);
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    const selector = join(generationRoot, '.inputs', publishedInputFingerprint(baseline.stdout));
    const selectorBytes = readFileSync(selector);
    const candidateLock = JSON.parse(lockWith(PKG));
    candidateLock.packages[''].dependencies = { pkg: '1.0.0' };
    writeFileSync(join(integration, 'package-lock.json'), `${JSON.stringify(candidateLock)}\n`);
    const candidate = commitFixture(integration, 'declaration-only lock change');
    const input = publishedInputFingerprint(fingerprintRef(integration, candidate).stdout);
    writeFileSync(join(integration, 'package-lock.json'), lockWith({
      'node_modules/pkg': { ...PKG['node_modules/pkg'], version: '2.0.0' },
    }));
    writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'live-v2\n');
    // Same live tree and candidate: only the validated donor changes.
    rmSync(selector);
    expect(predictionOf(predictRef(integration, candidate).stdout).verdict).toBe('refused');
    writeFileSync(selector, selectorBytes);
    const prediction = predictRef(integration, candidate);
    expect(prediction.status, prediction.stderr).toBe(0);
    expect(predictionOf(prediction.stdout).verdict).toBe('buildable');
    expect(existsSync(join(generationRoot, '.inputs', input))).toBe(false);
    const built = ensureRef(integration, candidate);
    expect(built.status, built.stderr).toBe(0);
    expect(publishedInputFingerprint(built.stdout)).toBe(input);
    expect(publishedIdentity(built.stdout)).toBe(publishedIdentity(baseline.stdout));
    expect(readFileSync(join(publishedPath(built.stdout), 'tree/node_modules/pkg/index.js'), 'utf8')).toBe('root-v1\n');
    expect(readFileSync(join(integration, 'node_modules/pkg/index.js'), 'utf8')).toBe('live-v2\n');
    expect(readdirSync(exactScratch(integration))).toEqual([]);
    const leaseRoot = join(generationRoot, '.leases');
    expect(existsSync(leaseRoot) ? readdirSync(leaseRoot) : []).toEqual([]);
    expect(predictionOf(predictRef(integration, candidate).stdout).verdict).toBe('prewarmed');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('rejects an incomplete legacy ancestor even when its publication token is valid', () => {
    const integration = makeIntegration();
    for (const rel of ['node_modules', 'packages/a/node_modules', 'packages/b/node_modules']) {
      rmSync(join(integration, rel), { recursive: true });
    }
    writeFileSync(join(integration, 'package-lock.json'), JSON.stringify({
      name: 'fixture', lockfileVersion: 3, packages: {},
    }));
    const empty = publish(integration);
    expect(empty.status, empty.stderr).toBe(0);

    writeFileSync(join(integration, 'package-lock.json'), lockWith(PKG));
    const baseline = commitFixture(integration, 'legacy ancestor input');
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    const baselineInput = publishedInputFingerprint(fingerprintRef(integration, baseline).stdout);
    const selector = join(generationRoot, '.inputs', baselineInput);
    const legacySelector = `schema=1\ninput=${baselineInput}\nidentity=${publishedIdentity(empty.stdout)}\ntoken=${publishedToken(empty.stdout)}\n`;
    writeFileSync(selector, legacySelector);

    const candidateLock = JSON.parse(lockWith(PKG));
    candidateLock.packages[''].dependencies = { pkg: '1.0.0' };
    writeFileSync(join(integration, 'package-lock.json'), `${JSON.stringify(candidateLock)}\n`);
    const candidate = commitFixture(integration, 'equivalent candidate input');
    const candidateInput = publishedInputFingerprint(fingerprintRef(integration, candidate).stdout);
    writeFileSync(join(integration, 'package-lock.json'), lockWith({
      'node_modules/pkg': { ...PKG['node_modules/pkg'], version: '2.0.0' },
    }));
    mkdirSync(join(integration, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(integration, 'node_modules/pkg/package.json'), '{"name":"pkg","version":"2.0.0"}\n');

    const prediction = predictRef(integration, candidate);
    expect(prediction.status, prediction.stderr).toBe(0);
    expect(predictionOf(prediction.stdout).verdict).toBe('refused');
    expect(prediction.stderr).toContain('skipping incomplete prewarmed ancestor');
    const result = ensureRef(integration, candidate);
    expect(result.status, result.stdout + result.stderr).toBe(74);
    expect(result.stdout).not.toContain('DEPENDENCY_GENERATION_RESULT');
    expect(existsSync(join(generationRoot, '.inputs', candidateInput))).toBe(false);
    expect(readFileSync(selector, 'utf8')).toBe(legacySelector);
    expect(readdirSync(exactScratch(integration))).toEqual([]);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('EI-26287122280182495: materializes only indexed historical inputs when no donor is equivalent', () => {
    const integration = makeIntegration();
    writeFileSync(join(integration, 'package-lock.json'), lockWith(PKG));
    commitFixture(integration, 'installed baseline');
    const baseline = publish(integration);
    expect(baseline.status, baseline.stderr).toBe(0);
    let candidate = '';
    for (let revision = 0; revision < 4; revision++) {
      const lock = JSON.parse(lockWith({
        'node_modules/pkg': { ...PKG['node_modules/pkg'], version: '2.0.0' },
      }));
      lock.packages[''].revision = revision;
      writeFileSync(join(integration, 'package-lock.json'), `${JSON.stringify(lock)}\n`);
      candidate = commitFixture(integration, `unpublished input ${revision}`);
    }
    writeFileSync(join(integration, 'package-lock.json'), lockWith({
      'node_modules/pkg': { ...PKG['node_modules/pkg'], version: '3.0.0' },
    }));
    writeFileSync(join(integration, 'node_modules/pkg/package.json'), '{"name":"pkg","version":"3.0.0"}\n');
    writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'live-v3\n');
    const shim = join(dirname(integration), 'prewarm-mkdir-bin');
    const trace = join(dirname(integration), 'prewarm-materializations');
    mkdirSync(shim);
    const realMkdir = execFileSync('bash', ['-lc', 'command -v mkdir'], { encoding: 'utf8' }).trim();
    writeFileSync(join(shim, 'mkdir'), `#!/bin/bash
for arg in "$@"; do
  case "$arg" in */prewarm-inputs) printf 'materialized\\n' >> "$TEST_PREWARM_TRACE" ;; esac
done
exec "$TEST_REAL_MKDIR" "$@"
`, { mode: 0o755 });
    const result = spawnSync('bash', [SCRIPT, '--integration', integration, '--predict-ref', candidate], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, TEST_PREWARM_TRACE: trace, TEST_REAL_MKDIR: realMkdir },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(predictionOf(result.stdout).verdict).toBe('refused');
    // One indexed baseline is checked. The three unpublished ancestors must
    // not be written to disk before discovering that they have no selector.
    expect(readFileSync(trace, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readFileSync(join(integration, 'node_modules/pkg/index.js'), 'utf8')).toBe('live-v3\n');
    expect(readdirSync(exactScratch(integration))).toEqual([]);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('WI-10004151: leases a cached donor while copying and removes only its extra workspace link', () => {
    const integration = makeIntegration();
    writeFileSync(
      join(integration, 'package-lock.json'),
      lockWith({
        ...PKG,
        'node_modules/@papercusp/extra': { resolved: 'packages/b', link: true },
      }),
    );
    mkdirSync(join(integration, 'node_modules/@papercusp'), { recursive: true });
    symlinkSync('../../packages/b', join(integration, 'node_modules/@papercusp/extra'));
    commitFixture(integration, 'installed baseline with workspace link');
    const baseline = publish(integration);
    expect(baseline.status, baseline.stderr).toBe(0);
    const donor = publishedPath(baseline.stdout);
    const donorIdentity = publishedIdentity(baseline.stdout);
    writeFileSync(join(integration, 'package-lock.json'), lockWith(PKG));
    const candidate = commitFixture(integration, 'remove workspace link');
    const input = publishedInputFingerprint(fingerprintRef(integration, candidate).stdout);
    writeFileSync(
      join(integration, 'package-lock.json'),
      lockWith({ 'node_modules/pkg': { ...PKG['node_modules/pkg'], version: '2.0.0' } }),
    );
    writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'live-v2\n');
    const prediction = predictRef(integration, candidate);
    expect(prediction.status, prediction.stderr).toBe(0);
    expect(predictionOf(prediction.stdout)).toMatchObject({ verdict: 'buildable', links: '1' });

    const shim = join(dirname(integration), 'donor-copy-bin');
    mkdirSync(shim);
    writeFileSync(join(shim, 'cp'), `#!/bin/bash
if [ "$1" = '-al' ]; then
  lease_found=''
  for lease in "$TEST_DONOR_LEASE_ROOT"/*; do
    if [ -f "$lease" ] && grep -q -F "identity=$TEST_DONOR_ID" "$lease"; then
      lease_found=1
    fi
  done
  [ -n "$lease_found" ] || { echo 'cached donor copied without a retention lease' >&2; exit 99; }
fi
exec /bin/cp "$@"
`, { mode: 0o755 });
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    const built = ensureRef(integration, candidate, {
      PATH: `${shim}:${process.env.PATH}`,
      TEST_DONOR_LEASE_ROOT: join(generationRoot, '.leases'),
      TEST_DONOR_ID: donorIdentity,
    });
    expect(built.status, built.stderr).toBe(0);
    expect(publishedInputFingerprint(built.stdout)).toBe(input);
    expect(publishedIdentity(built.stdout)).not.toBe(donorIdentity);
    expect(readFileSync(join(publishedPath(built.stdout), 'tree/node_modules/pkg/index.js'), 'utf8')).toBe('root-v1\n');
    expect(existsSync(join(publishedPath(built.stdout), 'tree/node_modules/@papercusp/extra'))).toBe(false);
    expect(readlinkSync(join(donor, 'tree/node_modules/@papercusp/extra'))).toBe('../../packages/b');
    expect(readFileSync(join(integration, 'node_modules/pkg/index.js'), 'utf8')).toBe('live-v2\n');
    expect(statSync(join(donor, 'tree/node_modules/pkg/index.js')).mode & 0o222).toBe(0);
    const leaseRoot = join(generationRoot, '.leases');
    expect(existsSync(leaseRoot) ? readdirSync(leaseRoot) : []).toEqual([]);
    expect(readdirSync(exactScratch(integration))).toEqual([]);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('WI-10004151: an incompatible prewarmed ancestor cannot satisfy a new installed version', () => {
    const integration = makeIntegration();
    writeFileSync(join(integration, 'package-lock.json'), lockWith(PKG));
    commitFixture(integration, 'installed baseline');
    expect(publish(integration).status).toBe(0);
    writeFileSync(join(integration, 'package-lock.json'), lockWith({
      'node_modules/pkg': { ...PKG['node_modules/pkg'], version: '2.0.0' },
    }));
    const candidate = commitFixture(integration, 'requires a new package version');
    const input = publishedInputFingerprint(fingerprintRef(integration, candidate).stdout);
    writeFileSync(join(integration, 'package-lock.json'), lockWith({
      'node_modules/pkg': { ...PKG['node_modules/pkg'], version: '3.0.0' },
    }));
    const result = ensureRef(integration, candidate);
    expect(result.status).toBe(74);
    expect(result.stderr).toContain('not install-equivalent');
    expect(existsSync(join(integration, '.papercusp/dependency-generations/.inputs', input))).toBe(false);
    expect(readdirSync(exactScratch(integration))).toEqual([]);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('WI-10004151: --predict-ref names live-match, buildable, then prewarmed, agreeing with --ensure-ref', () => {
    const integration = makeIntegration();
    writeFileSync(join(integration, 'package-lock.json'), lockWith(PKG));
    const candidate = commitFixture(integration, 'candidate lock without the staging-only link');
    const exactInput = publishedInputFingerprint(fingerprintRef(integration, candidate).stdout);

    const same = predictRef(integration, candidate);
    expect(same.status, same.stderr).toBe(0);
    expect(predictionOf(same.stdout)).toMatchObject({ verdict: 'live-match', input: exactInput, live: exactInput });

    writeFileSync(
      join(integration, 'package-lock.json'),
      lockWith({ ...PKG, 'node_modules/@papercusp/extra': { resolved: 'packages/b', link: true } }),
    );
    mkdirSync(join(integration, 'node_modules/@papercusp'), { recursive: true });
    execFileSync('ln', ['-s', '../../packages/b', join(integration, 'node_modules/@papercusp/extra')]);

    const buildable = predictRef(integration, candidate);
    expect(buildable.status, buildable.stderr).toBe(0);
    const verdict = predictionOf(buildable.stdout);
    expect(verdict).toMatchObject({ schema: '1', ref: candidate, input: exactInput, verdict: 'buildable', links: '1' });
    expect(verdict.live).not.toBe(exactInput);
    // Read-only: no generation published, no scratch left, nothing FATAL logged.
    expect(buildable.stdout).not.toContain('DEPENDENCY_GENERATION_RESULT');
    expect(buildable.stderr).not.toContain('FATAL');
    expect(readdirSync(exactScratch(integration))).toEqual([]);

    // The prediction is honoured by the real builder, after which it reads prewarmed.
    expect(ensureRef(integration, candidate).status).toBe(0);
    expect(predictionOf(predictRef(integration, candidate).stdout).verdict).toBe('prewarmed');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('rejects a legacy empty cached generation for dependency-bearing exact inputs', () => {
    const integration = makeIntegration();
    for (const rel of ['node_modules', 'packages/a/node_modules', 'packages/b/node_modules']) {
      rmSync(join(integration, rel), { recursive: true });
    }
    writeFileSync(join(integration, 'package-lock.json'), JSON.stringify({
      name: 'fixture', lockfileVersion: 3, packages: {},
    }));
    const empty = publish(integration);
    expect(empty.status, empty.stderr).toBe(0);
    writeFileSync(join(integration, 'package-lock.json'), JSON.stringify({
      name: 'fixture', lockfileVersion: 3, packages: { 'node_modules/pkg': { version: '1.0.0' } },
    }));
    const candidate = commitFixture(integration, 'legacy empty generation input');
    const fingerprint = fingerprintRef(integration, candidate);
    expect(fingerprint.status, fingerprint.stderr).toBe(0);
    const input = fingerprint.stdout.match(/\binput=([0-9a-f]{64})\b/)?.[1];
    expect(input).toBeTruthy();
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    const selector = join(generationRoot, '.inputs', input!);
    const legacySelector = `schema=1\ninput=${input}\nidentity=${publishedIdentity(empty.stdout)}\ntoken=${publishedToken(empty.stdout)}\n`;
    writeFileSync(selector, legacySelector);
    const result = ensureRef(integration, candidate);
    expect(result.status, result.stdout + result.stderr).toBe(74);
    expect(result.stderr).toContain('cached dependency generation does not realise exact-ref lockfiles');
    expect(result.stdout).not.toContain('DEPENDENCY_GENERATION_RESULT');
    expect(readFileSync(selector, 'utf8')).toBe(legacySelector);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it.each([
    ['malformed selector', 'invalid prewarmed dependency selector'],
    ['dangling generation', 'has an invalid publication token'],
    ['changed publication token', 'has an invalid publication token'],
  ])('WI-6554700010016558: prediction and ensure both reject a %s', (defect, diagnostic) => {
    const integration = makeIntegration();
    writeFileSync(join(integration, 'package-lock.json'), lockWith(PKG));
    const candidate = commitFixture(integration, 'installed exact-ref candidate');
    const published = ensureRef(integration, candidate);
    expect(published.status, published.stderr).toBe(0);
    const input = publishedInputFingerprint(published.stdout);
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    const selector = join(generationRoot, '.inputs', input);
    const healthySelector = readFileSync(selector, 'utf8');
    const healthyPrediction = predictRef(integration, candidate);
    expect(healthyPrediction.status, healthyPrediction.stderr).toBe(0);
    expect(predictionOf(healthyPrediction.stdout)).toMatchObject({ verdict: 'prewarmed', input });

    if (defect === 'malformed selector') {
      writeFileSync(selector, healthySelector.replace('schema=1\n', 'schema=99\n'));
    } else if (defect === 'dangling generation') {
      writeFileSync(selector, healthySelector.replace(publishedIdentity(published.stdout), `v1-${'f'.repeat(64)}`));
    } else {
      const marker = join(publishedPath(published.stdout), '.papercusp-dependency-generation');
      chmodSync(marker, 0o644);
      appendFileSync(marker, 'tampered=1\n');
    }
    const damagedSelector = readFileSync(selector, 'utf8');
    const generationsBefore = readdirSync(generationRoot).sort();

    // Equal input keys and an existing selector are insufficient: the builder
    // validates the referenced immutable publication before trusting the hit.
    const ensured = ensureRef(integration, candidate);
    expect(ensured.status, ensured.stderr).toBe(74);
    expect(ensured.stderr).toContain(diagnostic);
    expect(ensured.stdout).not.toContain('DEPENDENCY_GENERATION_RESULT');
    const prediction = predictRef(integration, candidate);
    expect(prediction.status, prediction.stdout).toBe(ensured.status);
    expect(prediction.stderr).toContain(diagnostic);
    expect(prediction.stdout).not.toContain('DEPENDENCY_GENERATION_PREDICTION ');
    expect(readFileSync(selector, 'utf8')).toBe(damagedSelector);
    expect(readdirSync(generationRoot).sort()).toEqual(generationsBefore);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('WI-10004151: --predict-ref reports refused with each reason, exits 0, and leaves no scratch', () => {
    const integration = makeIntegration();
    writeFileSync(join(integration, 'package-lock.json'), lockWith(PKG));
    const candidate = commitFixture(integration, 'candidate at pkg 1.0.0');
    writeFileSync(
      join(integration, 'package-lock.json'),
      lockWith({ 'node_modules/pkg': { ...PKG['node_modules/pkg'], version: '2.0.0' } }),
    );

    const result = predictRef(integration, candidate);
    expect(result.status, result.stderr).toBe(0);
    expect(predictionOf(result.stdout)).toMatchObject({ verdict: 'refused', links: '0' });
    expect(result.stdout).toContain(
      'DEPENDENCY_GENERATION_PREDICTION_REASON node_modules/pkg: version "1.0.0" (ref) vs "2.0.0" (live)',
    );
    expect(result.stderr).not.toContain('FATAL');
    expect(readdirSync(exactScratch(integration))).toEqual([]);
    // The builder agrees: the same ref is a typed exit-74 miss.
    expect(ensureRef(integration, candidate).status).toBe(74);

    const misuse = predictRef(integration, candidate, ['--ensure-ref', candidate]);
    expect(misuse.status).toBe(2);
    expect(misuse.stderr).toContain('--predict-ref cannot be combined');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('keeps a completed prewarm when live lockfiles drift mid-build, indexing the pre-build inputs', () => {
    const integration = makeIntegration();
    const candidate = commitFixture(integration, 'candidate');

    // The candidate's own git-content key: the value this generation has to end
    // up indexed under for the exact-ref re-open to bind it.
    const exact = fingerprintRef(integration, candidate);
    expect(exact.status, exact.stderr).toBe(0);
    const exactInput = /\binput=([0-9a-f]{64})\b/.exec(exact.stdout)?.[1];
    expect(exactInput).toBeTruthy();

    // A peer edits a lockfile DURING the copy. node_modules cannot move here —
    // every build caller holds npm-install-safe's --exec-under-lock reader
    // mutex — but lockfiles are ordinary tracked files that mutex does not
    // cover, so this is the drift that a live/live bracket used to read as a
    // torn build and discard a ~24-minute published generation over.
    const result = ensureRef(integration, candidate, {
      DG_TEST_LOCK: join(integration, 'package-lock.json'),
      DEPENDENCY_GENERATION_AFTER_COPY_HOOK:
        'printf \'{"name":"fixture","lockfileVersion":3,"packages":{"node_modules/peer-drift":{}}}\\n\' > "$DG_TEST_LOCK"',
    });

    // The build completed and stayed published rather than aborting rc75.
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      'live dependency inputs changed during generation prewarm',
    );
    expect(result.stderr).not.toContain('refusing a stale selector');

    // Load-bearing: indexed under the PRE-build inputs the copied trees
    // actually reflect (which here equal the candidate's), never the drifted
    // lockfile state that was never reified into them.
    expect(publishedInputFingerprint(result.stdout)).toBe(exactInput);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('WI-41491: refuses a selector whose immutable generation token changed after prewarm', () => {
    const integration = makeIntegration();
    const published = publish(integration);
    expect(published.status, published.stderr).toBe(0);
    const generation = publishedPath(published.stdout);
    const marker = join(generation, '.papercusp-dependency-generation');
    chmodSync(marker, 0o644);
    writeFileSync(marker, `${readFileSync(marker, 'utf8')}tampered=1\n`);

    const selected = selectPrewarmed(
      join(integration, '.papercusp/dependency-generations'),
      integration,
    );
    expect(selected.status).toBe(74);
    expect(selected.stderr).toContain('has an invalid publication token');
  });

  it('P-007: publishes only root plus the selected workspace closure and binds it into identity', () => {
    const integration = makeIntegration();
    const full = publish(integration);
    expect(full.status, full.stderr).toBe(0);

    const selected = publish(integration, {}, undefined, ['packages/a']);
    expect(selected.status, selected.stderr).toBe(0);
    expect(selected.stdout).toContain('scope=selected');
    expect(selected.stdout).toMatch(/\bclosure=[0-9a-f]{64}\b/);
    expect(publishedIdentity(selected.stdout)).not.toBe(
      publishedIdentity(full.stdout),
    );

    const generation = publishedPath(selected.stdout);
    expect(
      readFileSync(join(generation, 'tree/node_modules/pkg/index.js'), 'utf8'),
    ).toBe('root-v1\n');
    expect(
      readFileSync(
        join(generation, 'tree/packages/a/node_modules/local/index.js'),
        'utf8',
      ),
    ).toBe('local-v1\n');
    expect(
      existsSync(
        join(generation, 'tree/packages/b/node_modules/other/index.js'),
      ),
    ).toBe(false);

    const marker = readFileSync(
      join(generation, '.papercusp-dependency-generation'),
      'utf8',
    );
    expect(marker).toContain('scope=selected\n');
    expect(marker).toContain('workspace_dir=packages/a\n');

    const reused = publish(
      integration,
      {},
      undefined,
      ['packages/a', 'packages/a'],
    );
    expect(reused.status, reused.stderr).toBe(0);
    expect(reused.stdout).toContain('reused=true');
    expect(publishedPath(reused.stdout)).toBe(generation);
  });

  it('P-007: rejects a workspace closure that is not a safe repo-relative package directory', () => {
    const integration = makeIntegration();
    const result = publish(
      integration,
      {},
      undefined,
      ['packages/a/../a'],
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'invalid repo-relative --workspace-dir: packages/a/../a',
    );
    expect(
      existsSync(join(integration, '.papercusp/dependency-generations')),
    ).toBe(false);
  });

  it('selects an exact published identity without re-reading mutable live node_modules', () => {
    const integration = makeIntegration();
    const published = publish(integration);
    expect(published.status, published.stderr).toBe(0);
    const identity = publishedIdentity(published.stdout);
    const generationRoot = join(
      integration,
      '.papercusp/dependency-generations',
    );

    // Selection happens after the checkpoint may have waited for capacity. The
    // live source can disappear or change during that wait; the exact immutable
    // generation must remain the input.
    rmSync(join(integration, 'node_modules'), { recursive: true, force: true });
    rmSync(join(integration, 'packages/a/node_modules'), {
      recursive: true,
      force: true,
    });

    const selected = selectGeneration(generationRoot, identity);
    expect(selected.status, selected.stderr).toBe(0);
    expect(selected.stdout).toContain(`SELECTED identity=${identity}`);
    expect(selected.stdout).toContain(
      `path=${join(generationRoot, identity)}`,
    );
  });

  it('replaces a corrupt same-identity generation instead of trusting its marker', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    const generation = publishedPath(first.stdout);
    const identity = publishedIdentity(first.stdout);
    const publishedFile = join(generation, 'tree/node_modules/pkg/index.js');
    const validationTrace = join(integration, 'validation.trace');

    // A nested file edit is intentionally outside the O(1) publication-token
    // threat model, but the explicit deep audit must catch it. Once an audit (or
    // any immutable-object watcher) invalidates the token, the next publisher
    // rebuilds rather than trusting the still-matching identity/snapshot fields.
    chmodSync(publishedFile, 0o644);
    writeFileSync(publishedFile, 'corrupt\n');
    expect(deepAuditGeneration(generation).status).not.toBe(0);
    invalidatePublicationToken(generation);

    const repaired = publish(integration, {
      DEPENDENCY_GENERATION_VALIDATION_TRACE: validationTrace,
    });
    expect(repaired.status, repaired.stderr).toBe(0);
    expect(repaired.stdout).toContain('reused=false');
    expect(publishedPath(repaired.stdout)).toBe(generation);
    expect(readFileSync(publishedFile, 'utf8')).toBe('root-v1\n');
    expect(repaired.stderr).toContain('quarantined invalid generation');
    expect(repaired.stderr).toContain(
      'skipping repeat validation under publish lock',
    );
    expect(readFileSync(validationTrace, 'utf8').trim().split('\n')).toHaveLength(1);
    // WI-888766: this assertion used to require the `.invalid-*` quarantine to
    // still be SITTING THERE after the republish, which quietly codified the leak
    // as expected behaviour — it is the reason a permanently-uncollected 13 GiB
    // directory survived review for so long. Retention now finishes the quarantine
    // in the same publish, so absence is the correct expectation.
    //
    // The behaviour this test actually exists to prove — that a corrupt incumbent
    // is REPLACED rather than trusted — is not weakened by the flip: it is already
    // established independently above by `expect(repaired.stderr).toContain(
    // 'quarantined invalid generation')` plus the republished content check. That
    // asserts the quarantine HAPPENED; this now asserts it was also CLEANED UP.
    expect(
      readdirSync(join(integration, '.papercusp/dependency-generations')).some(
        (entry) => entry.startsWith(`.invalid-${identity}-`),
      ),
    ).toBe(false);

    const selected = selectGeneration(
      join(integration, '.papercusp/dependency-generations'),
      identity,
    );
    expect(selected.status, selected.stderr).toBe(0);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('fully revalidates a changed incumbent and reuses a valid concurrent winner', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    const generation = publishedPath(first.stdout);
    const identity = publishedIdentity(first.stdout);
    const generationRoot = join(
      integration,
      '.papercusp/dependency-generations',
    );
    const corruptedFile = join(generation, 'tree/node_modules/pkg/index.js');
    const winnerRoot = mkdtempSync(join(tmpdir(), 'dependency-generation-winner-'));
    roots.push(winnerRoot);
    // Build the concurrent winner through the real publisher. Copying a
    // published generation with cp -a is NOT a valid fixture: the snapshot
    // fingerprint intentionally includes inode metadata, so the copied
    // marker would (correctly) fail full validation before the race branch.
    const concurrent = publish(integration, {}, winnerRoot);
    expect(concurrent.status, concurrent.stderr).toBe(0);
    expect(publishedIdentity(concurrent.stdout)).toBe(identity);
    const winner = publishedPath(concurrent.stdout);
    chmodSync(corruptedFile, 0o644);
    writeFileSync(corruptedFile, 'corrupt\n');
    expect(deepAuditGeneration(generation).status).not.toBe(0);
    invalidatePublicationToken(generation);

    const replacement = join(generationRoot, '.concurrent-winner');
    const validationTrace = join(integration, 'validation.trace');
    const raced = publish(integration, {
      DG_GENERATION: generation,
      DG_WINNER: winner,
      DG_REPLACEMENT: replacement,
      DEPENDENCY_GENERATION_VALIDATION_TRACE: validationTrace,
      DEPENDENCY_GENERATION_AFTER_COPY_HOOK:
        'rm -rf "$DG_REPLACEMENT"; mv "$DG_WINNER" "$DG_REPLACEMENT"; rm -rf "$DG_GENERATION"; mv "$DG_REPLACEMENT" "$DG_GENERATION"',
    });

    expect(raced.status, raced.stderr).toBe(0);
    expect(raced.stdout).toContain('reused=true');
    expect(publishedPath(raced.stdout)).toBe(generation);
    expect(readFileSync(join(generation, 'tree/node_modules/pkg/index.js'), 'utf8')).toBe(
      'root-v1\n',
    );
    expect(raced.stderr).not.toContain(
      'skipping repeat validation under publish lock',
    );
    expect(readFileSync(validationTrace, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('rejects a malformed explicit identity before it can escape the generation root', () => {
    const integration = makeIntegration();
    const selected = selectGeneration(
      join(integration, '.papercusp/dependency-generations'),
      '../../node_modules',
    );

    expect(selected.status).toBe(2);
    expect(selected.stderr).toContain(
      'invalid dependency-generation identity',
    );
  });

  // WI-6554700010008514: v1-7c590a4e was published from a root missing
  // node_modules/sharp/node_modules/semver and indexed under input 8f48c4a6, so every gate
  // run sharing that key failed `npm ls`. The publish now audits the copied trees against
  // the lockfiles they were copied under and refuses (infra rc75) instead of publishing.
  it('WI-6554700010008514: refuses (rc75) a source whose trees do not realise its lockfile, and publishes nothing', () => {
    const integration = makeIntegration();
    // The fixture installs pkg@1.0.0; this lock claims 2.0.0 plus a never-installed package.
    writeFileSync(
      join(integration, 'package-lock.json'),
      `${JSON.stringify({
        name: 'fixture',
        lockfileVersion: 3,
        packages: {
          '': { name: 'fixture' },
          'node_modules/pkg': { version: '2.0.0' },
          'node_modules/never-installed': { version: '1.0.0' },
          'node_modules/optional-absent': { version: '1.0.0', optional: true },
        },
      })}\n`,
    );

    const result = publish(integration);

    expect(result.status).toBe(75);
    expect(result.stderr).toContain(
      'LOCK_TREE_DEFECT\tversion-mismatch\tnode_modules/pkg\tlocked 2.0.0 installed 1.0.0',
    );
    expect(result.stderr).toContain('LOCK_TREE_DEFECT\tmissing\tnode_modules/never-installed\tlocked 1.0.0');
    // npm skips optional packages that do not fit the platform: absence is not a defect.
    expect(result.stderr).not.toContain('optional-absent');
    expect(result.stderr).toContain('refusing to publish');
    expect(lastSummary(result)).toMatchObject({ result: 'lock-tree-incomplete' });
    expect(result.stdout).not.toContain('DEPENDENCY_GENERATION_RESULT');
    // A known-incomplete donor must refuse before spending time copying it.
    expect(telemetryRecords(result.stderr, 'PHASE')).toContainEqual(
      expect.objectContaining({ phase: 'source-lock-tree-audit', outcome: 'failed' }),
    );
    expect(telemetryRecords(result.stderr, 'PHASE').map(({ phase }) => phase)).not.toContain('tree-copy');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it.each([
    ['missing', 'node_modules/never-installed', '1.0.0'],
    ['version-mismatch', 'node_modules/pkg', '2.0.0'],
  ])('WI-6554700010008526: refuses a cache-hit selector for a %s locked dependency', (defect, path, version) => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    const marker = join(publishedPath(first.stdout), '.papercusp-dependency-generation');
    const originalMarker = readFileSync(marker, 'utf8');
    writeFileSync(
      join(integration, 'package-lock.json'),
      `${JSON.stringify({
        name: 'fixture',
        lockfileVersion: 3,
        packages: { [path]: { version } },
      })}\n`,
    );

    const result = publish(integration);

    expect(result.status, result.stderr).toBe(75);
    expect(result.stderr).toContain('outcome=hot-hit');
    expect(result.stderr).toContain(`LOCK_TREE_DEFECT\t${defect}\t${path}`);
    expect(lastSummary(result)).toMatchObject({ result: 'lock-tree-incomplete' });
    expect(result.stdout).not.toContain('DEPENDENCY_GENERATION_RESULT');
    expect(selectPrewarmed(generationRoot, integration).status).toBe(74);
    expect(readFileSync(marker, 'utf8')).toBe(originalMarker);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('WI-6554700010008526: binds a new matching lockfile to the cached tree after auditing it', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    writeFileSync(
      join(integration, 'package-lock.json'),
      JSON.stringify({ ...JSON.parse(readFileSync(join(integration, 'package-lock.json'), 'utf8')),
        name: 'fixture-with-new-input-metadata' }) + '\n',
    );

    const result = publish(integration);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('reused=true');
    expect(publishedIdentity(result.stdout)).toBe(publishedIdentity(first.stdout));
    expect(telemetryRecords(result.stderr, 'PHASE')).toContainEqual(
      expect.objectContaining({ phase: 'lock-tree-audit', outcome: 'ok' }),
    );
    const selected = selectPrewarmed(
      join(integration, '.papercusp/dependency-generations'),
      integration,
    );
    expect(selected.status, selected.stderr).toBe(0);
    expect(publishedIdentity(selected.stdout)).toBe(publishedIdentity(first.stdout));
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('refuses a torn source with rc75 and publishes no partial generation', () => {
    const integration = makeIntegration();
    const source = join(integration, 'node_modules/pkg/index.js');
    const result = publish(integration, {
      DG_TEST_SOURCE: source,
      DEPENDENCY_GENERATION_AFTER_COPY_HOOK:
        'printf "mutated\\n" >> "$DG_TEST_SOURCE"',
    });

    expect(result.status).toBe(75);
    expect(result.stderr).toContain(
      'changed input: node_modules (metadata fingerprint changed)',
    );
    expect(result.stderr).toContain('refusing a torn snapshot');
    expect(lastSummary(result)).toMatchObject({
      result: 'torn-source',
      trees_total: '3',
      trees_reused: '0',
      trees_copied: '3',
      trees_removed: '0',
    });
    const entries = readdirSync(
      join(integration, '.papercusp/dependency-generations'),
    );
    expect(entries.filter((entry) => entry.startsWith('v1-'))).toEqual([]);
    expect(entries.filter((entry) => entry.startsWith('.build-'))).toEqual([]);
  });

  it('P-002: refuses a torn incremental build and releases its predecessor lease', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    const firstIdentity = publishedIdentity(first.stdout);
    writeFileSync(
      join(integration, 'packages/a/node_modules/local/index.js'),
      'changed-before-incremental-build\n',
    );
    const source = join(integration, 'node_modules/pkg/index.js');

    const result = publish(integration, {
      DG_TEST_SOURCE: source,
      DEPENDENCY_GENERATION_AFTER_COPY_HOOK:
        'printf "mutated-during-incremental-build\\n" >> "$DG_TEST_SOURCE"',
    });

    expect(result.status).toBe(75);
    expect(result.stderr).toContain('refusing a torn snapshot');
    expect(lastSummary(result)).toMatchObject({
      result: 'torn-source',
      predecessor: firstIdentity,
      trees_total: '3',
      trees_reused: '2',
      trees_copied: '1',
      trees_removed: '0',
    });
    const generationRoot = join(
      integration,
      '.papercusp/dependency-generations',
    );
    expect(
      readdirSync(generationRoot).filter((entry) => entry.startsWith('v1-')),
    ).toEqual([firstIdentity]);
    const leases = join(generationRoot, '.leases');
    expect(!existsSync(leases) || readdirSync(leases).length === 0).toBe(true);
    expect(
      readdirSync(generationRoot).filter((entry) => entry.startsWith('.build-')),
    ).toEqual([]);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('ignores and prunes npm/Astro/Vitest/Storybook cache churn without weakening dependency drift detection', () => {
    const integration = makeIntegration();
    const npmMetadata = join(integration, 'node_modules/.package-lock.json');
    const storybookCache = join(
      integration,
      'node_modules/.cache/storybook/10.3.6/default/dev-server',
    );
    const astroCache = join(
      integration,
      'packages/a/node_modules/.astro',
    );
    const tempCache = join(
      integration,
      'packages/a/node_modules/.vite-temp',
    );
    const resultsCache = join(
      integration,
      'packages/a/node_modules/.vite/vitest/project-hash',
    );
    writeFileSync(npmMetadata, '{"before":true}\n');
    mkdirSync(storybookCache, { recursive: true });
    mkdirSync(astroCache, { recursive: true });
    mkdirSync(tempCache, { recursive: true });
    mkdirSync(resultsCache, { recursive: true });
    writeFileSync(
      join(astroCache, 'data-store.json'),
      '{"before":true}\n',
    );
    writeFileSync(
      join(storybookCache, 'storybook-before'),
      'ephemeral\n',
    );
    writeFileSync(join(tempCache, 'before.tmp'), 'ephemeral\n');
    writeFileSync(join(resultsCache, 'results.json'), '{}\n');
    const result = publish(integration, {
      DG_TEST_NPM_METADATA: npmMetadata,
      DG_TEST_STORYBOOK_CACHE: storybookCache,
      DG_TEST_ASTRO_CACHE: astroCache,
      DG_TEST_TEMP_CACHE: tempCache,
      DG_TEST_RESULTS_CACHE: resultsCache,
      DEPENDENCY_GENERATION_AFTER_COPY_HOOK:
        'printf "{\\"during\\":true}\\n" > "$DG_TEST_NPM_METADATA"; printf "churn\\n" > "$DG_TEST_STORYBOOK_CACHE/storybook-during"; printf "{\\"during\\":true}\\n" > "$DG_TEST_ASTRO_CACHE/data-store.json"; printf "churn\\n" > "$DG_TEST_TEMP_CACHE/during.tmp"; printf "{\\"updated\\":true}\\n" > "$DG_TEST_RESULTS_CACHE/results.json"',
    });

    expect(result.status, result.stderr).toBe(0);
    const generation = publishedPath(result.stdout);
    expect(
      existsSync(join(generation, 'tree/node_modules/.package-lock.json')),
    ).toBe(false);
    expect(
      existsSync(join(generation, 'tree/node_modules/.cache')),
    ).toBe(false);
    expect(
      existsSync(
        join(generation, 'tree/packages/a/node_modules/.astro'),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(generation, 'tree/packages/a/node_modules/.vite-temp'),
      ),
    ).toBe(false);
    expect(
      existsSync(join(generation, 'tree/packages/a/node_modules/.vite')),
    ).toBe(false);
  });

  it.each(['0', '1'])('ignores nested model-cache creation and removal but refuses dependency rewrites (portable=%s)', (portable) => {
    const integration = makeIntegration();
    const packageDir = join(integration, 'node_modules/@huggingface/transformers');
    const dependency = join(packageDir, 'index.js');
    const cache = join(packageDir, '.cache');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(dependency, 'dependency-v1\n');
    lockFixturePackage(integration, 'node_modules/@huggingface/transformers');
    const env = { DEPENDENCY_GENERATION_FORCE_PORTABLE_STAT: portable, DG_MODEL_PACKAGE: packageDir };
    const first = publish(integration, {
      ...env,
      DEPENDENCY_GENERATION_AFTER_COPY_HOOK:
        'mkdir -p "$DG_MODEL_PACKAGE/.cache/model/onnx"; printf "downloaded-model\\n" > "$DG_MODEL_PACKAGE/.cache/model/onnx/model.onnx_data"',
    });
    expect(first.status, first.stderr).toBe(0);
    expect(existsSync(join(publishedPath(first.stdout), 'tree/node_modules/@huggingface/transformers/.cache'))).toBe(false);

    // Removing the pruned child changes its package directory's size/mtime.
    rmSync(cache, { recursive: true, force: true });
    const second = publish(integration, env);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('reused=true');
    expect(publishedPath(second.stdout)).toBe(publishedPath(first.stdout));

    writeFileSync(dependency, 'dependency-v2\n');
    const torn = publish(integration, {
      ...env,
      DEPENDENCY_GENERATION_AFTER_COPY_HOOK: 'printf "dependency-v3\\n" > "$DG_MODEL_PACKAGE/index.js"',
    });
    expect(torn.status, torn.stderr).toBe(75);
    expect(torn.stderr).toContain('refusing a torn snapshot');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('ignores crash-left deployment swap siblings in both input and dependency manifests (WI-2144371)', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);

    const deployTmp = join(
      integration,
      'node_modules.deploy-tmp.1592326/nested/node_modules/stale-package',
    );
    const deployOld = join(
      integration,
      'packages/a/node_modules.deploy-old.1592326/nested/node_modules/stale-package',
    );
    mkdirSync(deployTmp, { recursive: true });
    mkdirSync(deployOld, { recursive: true });
    writeFileSync(join(deployTmp, 'index.js'), 'stale temp dependency\n');
    writeFileSync(join(deployOld, 'index.js'), 'stale old dependency\n');
    writeFileSync(
      join(integration, 'node_modules.deploy-tmp.1592326/package-lock.json'),
      '{"name":"runtime-debris","lockfileVersion":3,"packages":{}}\n',
    );

    const afterDebris = publish(integration);
    expect(afterDebris.status, afterDebris.stderr).toBe(0);
    expect(afterDebris.stdout).toContain('reused=true');
    expect(publishedIdentity(afterDebris.stdout)).toBe(
      publishedIdentity(first.stdout),
    );
    expect(afterDebris.stderr).not.toContain('node_modules.deploy-tmp.1592326');
    expect(afterDebris.stderr).not.toContain('node_modules.deploy-old.1592326');
  });

  it('keeps emitted desktop dependency copies out of full source generations and input keys (WI-10006855)', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    for (const output of ['sidecar', 'env-sidecars', 'resources']) {
      const dir = join(integration, 'papercusp-desktop/src-tauri', output);
      mkdirSync(join(dir, 'node_modules/copied'), { recursive: true });
      writeFileSync(join(dir, 'node_modules/copied/index.js'), 'emitted copy, no source lock binding\n');
      writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
    }
    const afterOutput = publish(integration);
    expect(afterOutput.status, afterOutput.stderr).toBe(0);
    expect(publishedIdentity(afterOutput.stdout)).toBe(publishedIdentity(first.stdout));
    expect(afterOutput.stdout).toContain('reused=true');
    expect(existsSync(join(publishedPath(afterOutput.stdout), 'tree/papercusp-desktop/src-tauri'))).toBe(false);
    for (const source of ['papercusp-desktop', 'packages/sidecar']) {
      const dir = join(integration, source);
      mkdirSync(join(dir, 'node_modules/source-package'), { recursive: true });
      writeFileSync(join(dir, 'node_modules/source-package/index.js'), 'source dependency\n');
      lockFixturePackage(integration, `${source}/node_modules/source-package`);
    }
    const afterSource = publish(integration);
    expect(afterSource.status, afterSource.stderr).toBe(0);
    expect(publishedIdentity(afterSource.stdout)).not.toBe(publishedIdentity(first.stdout));
    expect(existsSync(join(publishedPath(afterSource.stdout), 'tree/papercusp-desktop/node_modules/source-package'))).toBe(true);
    expect(existsSync(join(publishedPath(afterSource.stdout), 'tree/packages/sidecar/node_modules/source-package'))).toBe(true);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('ignores whole-directory swap siblings (<dir>.tmp.<pid> / <dir>.old.<pid>) in both manifests (WI-10005953)', () => {
    // build-desktop-sidecar.sh stages the sidecar as `sidecar.tmp.$$` and swaps the
    // previous one to `sidecar.old.$$`. Each sibling carries its own node_modules and
    // package-lock.json; counting them tore gate run 132bbb67's generation (exit 75).
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);

    const sidecarTmp = join(integration, 'packages/a/sidecar.tmp.2054494');
    const sidecarOld = join(integration, 'packages/a/sidecar.old.2054494');
    for (const dir of [sidecarTmp, sidecarOld]) {
      mkdirSync(join(dir, 'node_modules/staged-package'), { recursive: true });
      writeFileSync(join(dir, 'node_modules/staged-package/index.js'), 'staged\n');
      writeFileSync(
        join(dir, 'package-lock.json'),
        '{"name":"sidecar-staging","lockfileVersion":3,"packages":{}}\n',
      );
    }

    const afterSwap = publish(integration);
    expect(afterSwap.status, afterSwap.stderr).toBe(0);
    expect(afterSwap.stdout).toContain('reused=true');
    expect(publishedIdentity(afterSwap.stdout)).toBe(
      publishedIdentity(first.stdout),
    );
    expect(afterSwap.stderr).not.toContain('sidecar.tmp.2054494');
    expect(afterSwap.stderr).not.toContain('sidecar.old.2054494');

    // Calibration: the same tree under a non-scratch name IS a dependency input,
    // so the assertions above cannot pass because the walk ignores packages/a.
    mkdirSync(join(integration, 'packages/a/sidecar/node_modules/staged-package'), {
      recursive: true,
    });
    writeFileSync(
      join(integration, 'packages/a/sidecar/node_modules/staged-package/index.js'),
      'staged\n',
    );
    lockFixturePackage(integration, 'packages/a/sidecar/node_modules/staged-package');
    const afterReal = publish(integration);
    expect(afterReal.status, afterReal.stderr).toBe(0);
    expect(publishedIdentity(afterReal.stdout)).not.toBe(
      publishedIdentity(first.stdout),
    );
  });

  it('reclaims a same-host dead writer before publishing', () => {
    const integration = makeIntegration();
    const generationRoot = join(
      integration,
      '.papercusp/dependency-generations',
    );
    const abandoned = join(generationRoot, '.build-dead-writer');
    mkdirSync(join(abandoned, 'tree/node_modules/partial'), { recursive: true });
    writeFileSync(
      join(abandoned, '.papercusp-generation-writer'),
      `host=${execFileSync('hostname', { encoding: 'utf8' }).trim()}\npid=99999999\nstarted=1\n`,
    );

    const result = publish(integration);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(abandoned)).toBe(false);
    expect(result.stderr).toContain('removing abandoned build');
  });

  it('preserves live and freshly-created owner state during cleanup', () => {
    const integration = makeIntegration();
    const generationRoot = join(
      integration,
      '.papercusp/dependency-generations',
    );
    const live = join(generationRoot, '.build-live-writer');
    const freshWithoutMarker = join(generationRoot, '.build-fresh-no-marker');
    mkdirSync(live, { recursive: true });
    mkdirSync(freshWithoutMarker, { recursive: true });
    writeFileSync(
      join(live, '.papercusp-generation-writer'),
      `host=${execFileSync('hostname', { encoding: 'utf8' }).trim()}\npid=${process.pid}\nstarted=${Math.floor(Date.now() / 1000)}\n`,
    );

    const result = publish(integration);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(freshWithoutMarker)).toBe(true);
  });

  it('keeps a live completed build owned until its atomic publication rename (WI-2144383)', () => {
    const integration = makeIntegration();
    const generationRoot = join(
      integration,
      '.papercusp/dependency-generations',
    );
    const wrapper = [
      'set -uo pipefail',
      'source "$SCRIPT"',
      // Interpose only the under-lock concurrent-winner validation. This is the
      // exact point where the publisher used to remove its build-owner marker.
      // Age the pending directory beyond cleanup's five-minute fallback and run
      // the same cleanup a contending waiter performs on every failed mkdir.
      'eval "$(declare -f dependency_generation_is_valid | sed \'1s/dependency_generation_is_valid/dependency_generation_is_valid_original/\')"',
      'dependency_generation_is_valid() {',
      '  local pending',
      '  pending="$(find "$DG_ROOT" -maxdepth 1 -type d -name \'.build-*\' -print -quit)"',
      '  test -n "$pending"',
      '  touch -d "10 minutes ago" "$pending"',
      '  dependency_generation_cleanup_abandoned "$DG_ROOT"',
      '  if test -d "$pending"; then printf "LIVE_BUILD_SURVIVED\\n" >&2; else printf "LIVE_BUILD_DELETED\\n" >&2; fi',
      '  dependency_generation_is_valid_original "$@"',
      '}',
      'dependency_generation_configure_workspace_dirs "$ROOT"',
      'dependency_generation_ensure "$ROOT" "$DG_ROOT"',
      'printf "PUBLISHED identity=%s path=%s\\n" "$DEPENDENCY_GENERATION_ID" "$DEPENDENCY_GENERATION_PATH"',
    ].join('\n');
    const result = spawnSync('bash', ['-c', wrapper], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SCRIPT,
        ROOT: integration,
        DG_ROOT: generationRoot,
      },
    });

    expect(result.status, String(result.stderr ?? '')).toBe(0);
    expect(String(result.stderr ?? '')).toContain('LIVE_BUILD_SURVIVED');
    expect(String(result.stderr ?? '')).not.toContain('LIVE_BUILD_DELETED');
    expect(String(result.stdout ?? '')).toMatch(
      /PUBLISHED identity=v1-[0-9a-f]{64} path=/,
    );
    expect(
      readdirSync(generationRoot).some((entry) => entry.startsWith('.build-')),
    ).toBe(false);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('publishes and reuses via the BSD-compatible metadata fallback', () => {
    const integration = makeIntegration();
    const env = { DEPENDENCY_GENERATION_FORCE_PORTABLE_STAT: '1' };
    const first = publish(integration, env);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('reused=false');

    const second = publish(integration, env);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('reused=true');
    expect(publishedPath(second.stdout)).toBe(publishedPath(first.stdout));
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('materializes independent copies by default; hardlinks require an explicit opt-in', () => {
    const integration = makeIntegration();
    const result = publish(integration);
    expect(result.status, result.stderr).toBe(0);
    const generation = publishedPath(result.stdout);
    const source = join(generation, 'tree/node_modules');
    const independent = join(integration, 'materialized-independent');
    const hardlinked = join(integration, 'materialized-hardlink');
    const copied = join(integration, 'materialized-copy');
    const wrapper = [
      'set -euo pipefail',
      'source "$SCRIPT"',
      'dependency_generation_materialize_tree "$SOURCE" "$DEST"',
    ].join('\n');

    const independentResult = spawnSync('bash', ['-c', wrapper], {
      env: { ...process.env, SCRIPT, SOURCE: source, DEST: independent },
      encoding: 'utf8',
    });
    expect(independentResult.status, String(independentResult.stderr ?? '')).toBe(0);
    expect(statSync(join(independent, 'pkg/index.js')).ino).not.toBe(
      statSync(join(source, 'pkg/index.js')).ino,
    );

    const hardlinkResult = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SCRIPT,
        SOURCE: source,
        DEST: hardlinked,
        DEPENDENCY_GENERATION_ALLOW_HARDLINK: '1',
      },
      encoding: 'utf8',
    });
    expect(hardlinkResult.status, String(hardlinkResult.stderr ?? '')).toBe(0);
    expect(statSync(join(hardlinked, 'pkg/index.js')).ino).toBe(
      statSync(join(source, 'pkg/index.js')).ino,
    );

    const portable = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SCRIPT,
        SOURCE: source,
        DEST: copied,
        DEPENDENCY_GENERATION_FORCE_COPY: '1',
      },
      encoding: 'utf8',
    });
    expect(portable.status, String(portable.stderr ?? '')).toBe(0);
    expect(statSync(join(copied, 'pkg/index.js')).ino).not.toBe(
      statSync(join(source, 'pkg/index.js')).ino,
    );
    expect(readFileSync(join(copied, 'pkg/index.js'), 'utf8')).toBe('root-v1\n');
  });

  it('falls back to an independent copy when the hardlink opt-in cannot hardlink (WI-10004928)', () => {
    // The admission pre-check always opts in to hardlinks. A failing `cp -al`
    // (EXDEV, EMLINK, …) must degrade to a correct independent copy, never fail
    // the materialization.
    const integration = makeIntegration();
    const result = publish(integration);
    expect(result.status, result.stderr).toBe(0);
    const source = join(publishedPath(result.stdout), 'tree/node_modules');
    const dest = join(integration, 'materialized-fallback');
    const shim = join(integration, 'cp-shim');
    const realCp = execFileSync('bash', ['-c', 'command -v cp'], { encoding: 'utf8' }).trim();
    const wrapper = [
      'set -euo pipefail',
      'mkdir -p "$SHIM"',
      // Refuse only the hardlink form. Every other cp call passes through.
      `printf '%s\\n' '#!/usr/bin/env bash' 'for a in "$@"; do [ "$a" = -al ] && exit 1; done' 'exec "$REAL_CP" "$@"' > "$SHIM/cp"`,
      'chmod +x "$SHIM/cp"',
      'export PATH="$SHIM:$PATH"',
      'source "$SCRIPT"',
      'dependency_generation_materialize_tree "$SOURCE" "$DEST"',
      'printf "mode=%s\\n" "$DEPENDENCY_GENERATION_MATERIALIZE_MODE"',
    ].join('\n');
    const fallback = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SCRIPT,
        SOURCE: source,
        DEST: dest,
        SHIM: shim,
        REAL_CP: realCp,
        DEPENDENCY_GENERATION_ALLOW_HARDLINK: '1',
      },
      encoding: 'utf8',
    });
    expect(fallback.status, String(fallback.stderr ?? '')).toBe(0);
    expect(fallback.stdout).toContain('mode=copy');
    expect(statSync(join(dest, 'pkg/index.js')).ino).not.toBe(statSync(join(source, 'pkg/index.js')).ino);
    expect(readFileSync(join(dest, 'pkg/index.js'), 'utf8')).toBe('root-v1\n');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('does not mutate immutable generation modes during repeated hardlink cleanup', () => {
    const integration = makeIntegration();
    const published = publish(integration);
    expect(published.status, published.stderr).toBe(0);
    const generation = publishedPath(published.stdout);
    const source = join(generation, 'tree');
    const sourceFile = join(source, 'node_modules/pkg/index.js');
    const markerPath = join(generation, '.papercusp-dependency-generation');
    const initialMode = statSync(sourceFile).mode & 0o777;
    const initialMarker = readFileSync(markerPath, 'utf8');
    // Keep the disposable checkout outside the integration root: a
    // package-local node_modules there is a real source input for the next
    // publisher and would change the generation identity unrelated to this
    // cleanup regression.
    const destinationRoot = mkdtempSync(
      join(tmpdir(), 'dependency-generation-materialized-'),
    );
    roots.push(destinationRoot);
    const destination = join(destinationRoot, 'tree');
    const wrapper = [
      'set -euo pipefail',
      'source "$SCRIPT"',
      'dependency_generation_materialize_tree "$SOURCE" "$DEST"',
    ].join('\n');

    for (let pass = 0; pass < 2; pass += 1) {
      const materialized = spawnSync('bash', ['-c', wrapper], {
        env: { ...process.env, SCRIPT, SOURCE: source, DEST: destination },
        encoding: 'utf8',
      });
      expect(materialized.status, String(materialized.stderr ?? '')).toBe(0);
    }

    expect(statSync(sourceFile).mode & 0o777).toBe(initialMode);
    expect(readFileSync(markerPath, 'utf8')).toBe(initialMarker);
    const reused = publish(integration);
    expect(reused.status, reused.stderr).toBe(0);
    expect(reused.stdout).toContain('reused=true');
    expect(publishedPath(reused.stdout)).toBe(generation);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('bounds published growth to the newest set and finishes crash-left prune quarantines', () => {
    const integration = makeIntegration();
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    let newestPath = '';

    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(integration, 'node_modules/pkg/index.js'), `root-v${i}\n`);
      const result = publish(integration, {
        DEPENDENCY_GENERATION_RETAIN_COUNT: '2',
      });
      expect(result.status, result.stderr).toBe(0);
      newestPath = publishedPath(result.stdout);
    }

    expect(
      readdirSync(generationRoot).filter((entry) => entry.startsWith('v1-')),
    ).toHaveLength(2);
    expect(existsSync(newestPath)).toBe(true);

    const orphan = join(generationRoot, `.prune-v1-${'f'.repeat(64)}-stale`);
    mkdirSync(join(orphan, 'tree/pkg'), { recursive: true });
    writeFileSync(join(orphan, 'tree/pkg/index.js'), 'stale\n');
    chmodSync(join(orphan, 'tree/pkg/index.js'), 0o444);
    const reused = publish(integration, {
      DEPENDENCY_GENERATION_RETAIN_COUNT: '2',
    });
    expect(reused.status, reused.stderr).toBe(0);
    expect(existsSync(orphan)).toBe(false);
    expect(reused.stderr).toContain(`deleted prune quarantine ${orphan}`);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('reports a failed quarantine deletion even when a later deletion succeeds', () => {
    const integration = makeIntegration();
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    const failed = join(generationRoot, '.prune-a-refused');
    const removed = join(generationRoot, '.prune-z-removable');
    mkdirSync(failed, { recursive: true });
    mkdirSync(removed, { recursive: true });
    writeFileSync(join(failed, 'payload'), 'preserved after refused unlink\n');
    const result = spawnSync('bash', ['-c', [
      'set -uo pipefail',
      'source "$SCRIPT"',
      'rm() { if [ "${@: -1}" = "$FAILED" ]; then return 23; fi; command rm "$@"; }',
      'dependency_generation_main --integration "$INTEGRATION" --generation-root "$DG_ROOT" --prune-only --no-recorded-store-cascade',
    ].join('\n')], {
      encoding: 'utf8',
      env: { ...process.env, SCRIPT, INTEGRATION: integration, DG_ROOT: generationRoot, FAILED: failed },
    });
    expect(result.status, result.stderr).toBe(23);
    expect(readFileSync(join(failed, 'payload'), 'utf8')).toBe('preserved after refused unlink\n');
    expect(existsSync(removed)).toBe(false);
    expect(result.stderr).toContain(`failed prune quarantine deletion ${failed} (rc=23)`);
    expect(result.stderr).toContain(`deleted prune quarantine ${removed}`);
    expect(result.stderr).not.toContain(`deleted prune quarantine ${failed}`);
    expect(existsSync(join(generationRoot, '.publish-lock'))).toBe(false);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('removes input selectors before pruning the generation they reference (WI-2144343)', () => {
    const integration = makeIntegration();
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    const originalLockfile = readFileSync(join(integration, 'package-lock.json'), 'utf8');
    const first = publish(integration, {
      DEPENDENCY_GENERATION_RETAIN_COUNT: '1',
    });
    expect(first.status, first.stderr).toBe(0);
    const firstPath = publishedPath(first.stdout);
    const firstInput = publishedInputFingerprint(first.stdout);
    const firstSelector = join(generationRoot, '.inputs', firstInput);
    expect(existsSync(firstSelector)).toBe(true);

    writeFileSync(
      join(integration, 'package-lock.json'),
      JSON.stringify({ ...JSON.parse(originalLockfile), packages: {
        ...JSON.parse(originalLockfile).packages, 'node_modules/new-input': {},
      } }) + '\n',
    );
    // The new lock entry is installed, as a real install would leave it (lock-tree audit).
    mkdirSync(join(integration, 'node_modules/new-input'), { recursive: true });
    writeFileSync(join(integration, 'node_modules/new-input/package.json'), '{"name":"new-input"}\n');
    writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'new-generation\n');
    const second = publish(integration, {
      DEPENDENCY_GENERATION_RETAIN_COUNT: '1',
    });
    expect(second.status, second.stderr).toBe(0);
    expect(existsSync(firstPath)).toBe(false);
    expect(existsSync(firstSelector)).toBe(false);
    expect(second.stderr).toContain(
      `removed input selector ${firstInput} for pruned generation`,
    );

    // Restoring the old dependency inputs now produces a rebuildable miss. The
    // pre-fix dangling selector instead resolved the deleted identity forever
    // and failed as an invalid publication token.
    writeFileSync(join(integration, 'package-lock.json'), originalLockfile);
    const oldInput = selectPrewarmed(generationRoot, integration);
    expect(oldInput.status).toBe(74);
    expect(oldInput.stderr).toContain('no prewarmed dependency generation');
    expect(oldInput.stderr).not.toContain('invalid publication token');
  }, NATIVE_SHELL_TIMEOUT_MS);

  // WI-10003601. Retention ranks generations by publication time, but `created=`
  // is whole seconds: two publications inside one second TIED, and the identity
  // tie-break (a content hash, which varies with the temp path) decided which one
  // RETAIN_COUNT kept. The WI-2144343 case above failed whenever the OLDER identity
  // sorted higher. Built by hand so the tie and the hash order are both fixed —
  // the older generation carries the lexically GREATER identity, exactly the
  // order the seconds-only ranking got wrong — plus a legacy seconds-only marker
  // that is the newest, so the mixed-unit comparison is exercised too.
  it('keeps the NEWER of two generations published inside the same second (WI-10003601)', () => {
    const root = mkdtempSync(join(tmpdir(), 'dependency-generation-rank-'));
    roots.push(root);
    const older = `v1-${'f'.repeat(64)}`;
    const newer = `v1-${'0'.repeat(64)}`;
    const legacyNewest = `v1-${'e'.repeat(64)}`;
    const marker = (identity: string, fields: string) => {
      mkdirSync(join(root, identity), { recursive: true });
      writeFileSync(
        join(root, identity, '.papercusp-dependency-generation'),
        `schema=1\nidentity=${identity}\n${fields}`,
      );
    };
    marker(older, 'created=1790000001\ncreated_ns=1790000001100000000\n');
    marker(newer, 'created=1790000001\ncreated_ns=1790000001900000000\n');
    marker(legacyNewest, 'created=1790000002\n');
    const result = spawnSync(
      'bash',
      [
        '-c',
        [
          'set -uo pipefail',
          'source "$SCRIPT"',
          'DEPENDENCY_GENERATION_RETAIN_COUNT=2 dependency_generation_quarantine_unretained_locked "$DG_ROOT"',
        ].join('\n'),
      ],
      { encoding: 'utf8', env: { ...process.env, SCRIPT, DG_ROOT: root } },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, legacyNewest))).toBe(true);
    expect(existsSync(join(root, newer))).toBe(true);
    expect(existsSync(join(root, older))).toBe(false);
    expect(result.stderr).toContain(`quarantined unretained generation ${older}`);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('stamps created_ns on a published generation, consistent with created (WI-10003601)', () => {
    const integration = makeIntegration();
    const published = publish(integration);
    expect(published.status, published.stderr).toBe(0);
    const text = readFileSync(
      join(publishedPath(published.stdout), '.papercusp-dependency-generation'),
      'utf8',
    );
    const created = text.match(/^created=(\d+)$/m)?.[1];
    const createdNs = text.match(/^created_ns=(\d+)$/m)?.[1];
    expect(created, text).toMatch(/^\d{10}$/);
    expect(createdNs, text).toMatch(/^\d{19}$/);
    expect(createdNs!.slice(0, -9)).toBe(created);
  }, NATIVE_SHELL_TIMEOUT_MS);

  // WI-888766. The sibling case above has guarded `.prune-*` collection for a long
  // time while `.invalid-*` leaked permanently, which is precisely why the leak
  // survived: the only other `.invalid-` assertion in this file checks that the
  // quarantine is CREATED, and a create-only assertion passes just as happily when
  // nothing ever collects it. Being a dotfile, it was also invisible to the `v1-*`
  // census glob, so it never registered as a generation at all.
  //
  // Cost of the gap in production: each quarantine is a full node_modules
  // materialization (~13 GiB), three had stranded 39 GiB for 2-4 days, and the
  // resulting 95%-full root filesystem made the cargo lane's disk-headroom
  // admission REFUSE to spawn — surfacing as a red @papercusp/desktop in the gate,
  // i.e. a disk leak wearing a test failure's clothes.
  it('finishes crash-left INVALID quarantines, not just prune ones (WI-888766)', () => {
    const integration = makeIntegration();
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    const first = publish(integration, {
      DEPENDENCY_GENERATION_RETAIN_COUNT: '2',
    });
    expect(first.status, first.stderr).toBe(0);

    // Shaped exactly like a real one: `.invalid-<identity>-<epoch>.<pid>`, with a
    // read-only payload, since generations are published immutable and the
    // collector has to chmod directories before it can unlink.
    const orphan = join(
      generationRoot,
      `.invalid-v1-${'e'.repeat(64)}-1787702669.1654514`,
    );
    mkdirSync(join(orphan, 'tree/pkg'), { recursive: true });
    writeFileSync(join(orphan, 'tree/pkg/index.js'), 'stale\n');
    chmodSync(join(orphan, 'tree/pkg/index.js'), 0o444);

    const reused = publish(integration, {
      DEPENDENCY_GENERATION_RETAIN_COUNT: '2',
    });
    expect(reused.status, reused.stderr).toBe(0);
    expect(existsSync(orphan)).toBe(false);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('collects stale publish-lock quarantines after one day while preserving recent writer records (WI-10002319)', () => {
    const integration = makeIntegration();
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    const first = publish(integration, { DEPENDENCY_GENERATION_RETAIN_COUNT: '2' });
    expect(first.status, first.stderr).toBe(0);

    const now = Math.floor(Date.now() / 1000);
    const old = join(generationRoot, `.stale-publish-lock.${now - 86401}.1234`);
    const recent = join(generationRoot, `.stale-publish-lock.${now}.2345`);
    for (const path of [old, recent]) {
      mkdirSync(path);
      writeFileSync(join(path, 'writer'), 'host=prior\npid=99999999\n');
    }

    const reused = publish(integration, { DEPENDENCY_GENERATION_RETAIN_COUNT: '2' });
    expect(reused.status, reused.stderr).toBe(0);
    expect(existsSync(old)).toBe(false);
    expect(readFileSync(join(recent, 'writer'), 'utf8')).toContain('pid=99999999');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('enrolls every created quarantine prefix in the retention collector (WI-10002319)', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    const createdPrefixes = [...script.matchAll(/quarantine="\$generation_root\/(\.[a-z-]+[.-])/g)]
      .map((match) => match[1]);
    expect(createdPrefixes).toEqual(expect.arrayContaining(['.prune-', '.invalid-', '.stale-publish-lock.']));
    const collection = script.match(/for quarantine in ([^\n]+); do/)?.[1];
    expect(collection).toBeDefined();
    for (const prefix of createdPrefixes) {
      expect(collection).toContain(`"$generation_root"/${prefix}*`);
    }
  });

  it('imports direct sibling checkout pins and prunes them after their marker goes stale', () => {
    const integration = makeIntegration();
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    const first = publish(integration, {
      DEPENDENCY_GENERATION_RETAIN_COUNT: '2',
    });
    expect(first.status, first.stderr).toBe(0);
    const firstIdentity = publishedIdentity(first.stdout);
    const firstPath = publishedPath(first.stdout);
    const checkout = `${integration}-checkpoint`;
    roots.push(checkout);
    mkdirSync(join(checkout, 'node_modules'), { recursive: true });
    writeFileSync(
      join(checkout, 'node_modules/.papercusp-dependency-generation'),
      `identity=${firstIdentity}\nsource=${firstIdentity.slice(3)}\n`,
    );

    for (let i = 1; i <= 3; i += 1) {
      writeFileSync(join(integration, 'node_modules/pkg/index.js'), `new-${i}\n`);
      const result = publish(integration, {
        DEPENDENCY_GENERATION_RETAIN_COUNT: '2',
      });
      expect(result.status, result.stderr).toBe(0);
    }
    expect(existsSync(firstPath)).toBe(true);
    expect(
      readdirSync(join(generationRoot, '.pins')).some((entry) =>
        readFileSync(join(generationRoot, '.pins', entry), 'utf8').includes(
          `identity=${firstIdentity}\n`,
        ),
      ),
    ).toBe(true);

    rmSync(join(checkout, 'node_modules/.papercusp-dependency-generation'));
    writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'after-stale-pin\n');
    const after = publish(integration, {
      DEPENDENCY_GENERATION_RETAIN_COUNT: '1',
    });
    expect(after.status, after.stderr).toBe(0);
    expect(existsSync(firstPath)).toBe(false);
    expect(
      readdirSync(join(generationRoot, '.pins')).some((entry) =>
        readFileSync(join(generationRoot, '.pins', entry), 'utf8').includes(
          `identity=${firstIdentity}\n`,
        ),
      ),
    ).toBe(false);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('keeps a live cross-filesystem sibling pin but prunes one whose checkout was offloaded and went stale (WI-10003695)', () => {
    const integration = makeIntegration();
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    // The host service can set PAPERCUSP_DEPENDENCY_GENERATION_ROOT globally. Pin this
    // fixture's store to the integration tree so its device and pin assertions stay isolated.
    const first = publish(
      integration,
      { DEPENDENCY_GENERATION_RETAIN_COUNT: '1' },
      generationRoot,
    );
    expect(first.status, first.stderr).toBe(0);
    const firstIdentity = publishedIdentity(first.stdout);
    const firstPath = publishedPath(first.stdout);
    const pinsFor = (identity: string) =>
      existsSync(join(generationRoot, '.pins'))
        ? readdirSync(join(generationRoot, '.pins')).filter((entry) =>
            readFileSync(join(generationRoot, '.pins', entry), 'utf8').includes(`identity=${identity}\n`),
          )
        : [];

    // The root-offload convention: the checkout lives on another filesystem and
    // its old path, a direct sibling of the integration root, is a symlink to it.
    // WI-10005970: choose a parent on a filesystem OTHER than the store's. A hardcoded
    // /dev/shm failed this case's precondition whenever tmpdir-guard relocated TMPDIR (and so
    // the integration root and its store) onto /dev/shm itself.
    const storeDev = statSync(generationRoot).dev;
    const offloadBase =
      ['/dev/shm', '/var/tmp', '/tmp'].find((base) => {
        try {
          return statSync(base).dev !== storeDev;
        } catch {
          return false;
        }
      }) ?? '/dev/shm';
    const offloadParent = mkdtempSync(join(offloadBase, 'dependency-generation-offload-'));
    roots.push(offloadParent);
    const offloaded = join(offloadParent, 'relcut');
    mkdirSync(join(offloaded, 'node_modules'), { recursive: true });
    const marker = join(offloaded, 'node_modules/.papercusp-dependency-generation');
    writeFileSync(marker, `identity=${firstIdentity}\nsource=${firstIdentity.slice(3)}\n`);
    symlinkSync(offloaded, `${integration}-relcut`);
    expect(
      statSync(offloaded).dev,
      'fixture precondition: the offloaded checkout must be on a different filesystem than the store',
    ).not.toBe(statSync(generationRoot).dev);

    // A freshly materialized cross-filesystem checkout is live: it stays pinned.
    writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'cross-fs-live\n');
    const live = publish(integration, { DEPENDENCY_GENERATION_RETAIN_COUNT: '1' });
    expect(live.status, live.stderr).toBe(0);
    expect(existsSync(firstPath)).toBe(true);
    expect(pinsFor(firstIdentity)).toHaveLength(1);

    // Four days without a re-materialization: retired. The pin goes, the sibling
    // scan does not re-write it, and retention prunes the generation.
    const fourDaysAgo = new Date(Date.now() - 4 * 86_400_000);
    utimesSync(marker, fourDaysAgo, fourDaysAgo);
    writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'cross-fs-retired\n');
    const retired = publish(integration, { DEPENDENCY_GENERATION_RETAIN_COUNT: '1' });
    expect(retired.status, retired.stderr).toBe(0);
    expect(retired.stderr).toContain('removing retired cross-filesystem checkout pin');
    expect(pinsFor(firstIdentity)).toHaveLength(0);
    expect(existsSync(firstPath)).toBe(false);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('protects a live exact-identity selector lease and reclaims it after the reader is gone', () => {
    const integration = makeIntegration();
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    const first = publish(integration, {
      DEPENDENCY_GENERATION_RETAIN_COUNT: '1',
    });
    expect(first.status, first.stderr).toBe(0);
    const firstIdentity = publishedIdentity(first.stdout);
    const firstPath = publishedPath(first.stdout);
    const lease = join(generationRoot, '.leases/live-test');
    mkdirSync(dirname(lease), { recursive: true });
    writeFileSync(
      lease,
      `host=${execFileSync('hostname', { encoding: 'utf8' }).trim()}\n` +
        `pid=${process.pid}\nstarted=1\nidentity=${firstIdentity}\n`,
    );

    for (let i = 1; i <= 2; i += 1) {
      writeFileSync(join(integration, 'node_modules/pkg/index.js'), `leased-${i}\n`);
      const result = publish(integration, {
        DEPENDENCY_GENERATION_RETAIN_COUNT: '1',
      });
      expect(result.status, result.stderr).toBe(0);
    }
    expect(existsSync(firstPath)).toBe(true);

    rmSync(lease);
    writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'reader-gone\n');
    const after = publish(integration, {
      DEPENDENCY_GENERATION_RETAIN_COUNT: '1',
    });
    expect(after.status, after.stderr).toBe(0);
    expect(existsSync(firstPath)).toBe(false);
  });

  it('reclaims a selector lease when its PID was recycled (WI-10002317)', () => {
    const integration = makeIntegration();
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    const first = publish(integration, { DEPENDENCY_GENERATION_RETAIN_COUNT: '1' });
    expect(first.status, first.stderr).toBe(0);
    const firstIdentity = publishedIdentity(first.stdout);
    const firstPath = publishedPath(first.stdout);
    const lease = join(generationRoot, '.leases/recycled-pid');
    mkdirSync(dirname(lease), { recursive: true });
    writeFileSync(
      lease,
      `host=${execFileSync('hostname', { encoding: 'utf8' }).trim()}\n` +
        `pid=${process.pid}\nprocess_start=proc:0\nidentity=${firstIdentity}\n`,
    );
    writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'after-recycled-pid\n');
    const after = publish(integration, { DEPENDENCY_GENERATION_RETAIN_COUNT: '1' });
    expect(after.status, after.stderr).toBe(0);
    expect(existsSync(lease)).toBe(false);
    expect(existsSync(firstPath)).toBe(false);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('age-bounds legacy selector leases that lack process identity (WI-10002317)', () => {
    const integration = makeIntegration();
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    const first = publish(integration, { DEPENDENCY_GENERATION_RETAIN_COUNT: '1' });
    expect(first.status, first.stderr).toBe(0);
    const firstIdentity = publishedIdentity(first.stdout);
    const firstPath = publishedPath(first.stdout);
    const lease = join(generationRoot, '.leases/legacy-aged');
    mkdirSync(dirname(lease), { recursive: true });
    writeFileSync(
      lease,
      `host=${execFileSync('hostname', { encoding: 'utf8' }).trim()}\n` +
        `pid=${process.pid}\nidentity=${firstIdentity}\n`,
    );
    const old = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(lease, old, old);
    writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'after-legacy-age\n');
    const after = publish(integration, { DEPENDENCY_GENERATION_RETAIN_COUNT: '1' });
    expect(after.status, after.stderr).toBe(0);
    expect(existsSync(lease)).toBe(false);
    expect(existsSync(firstPath)).toBe(false);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('sweeps a quiescent store without publishing from changed inputs (WI-10002317)', () => {
    const integration = makeIntegration();
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    const first = publish(integration, { DEPENDENCY_GENERATION_RETAIN_COUNT: '1' });
    expect(first.status, first.stderr).toBe(0);
    const firstIdentity = publishedIdentity(first.stdout);
    const firstPath = publishedPath(first.stdout);
    const lease = join(generationRoot, '.leases/dead-reader');
    mkdirSync(dirname(lease), { recursive: true });
    writeFileSync(
      lease,
      `host=${execFileSync('hostname', { encoding: 'utf8' }).trim()}\n` +
        `pid=99999999\nidentity=${firstIdentity}\n`,
    );
    writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'changed-without-publish\n');
    const sweep = spawnSync('bash', [SCRIPT, '--integration', integration, '--prune-only'], {
      encoding: 'utf8', env: { ...process.env, DEPENDENCY_GENERATION_RETAIN_COUNT: '1' },
    });
    expect(sweep.status, String(sweep.stderr)).toBe(0);
    expect(existsSync(lease)).toBe(false);
    expect(existsSync(firstPath)).toBe(true);
    expect(readdirSync(generationRoot).filter((entry) => entry.startsWith('v1-'))).toEqual([firstIdentity]);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('protects the selection-to-materialization handoff with a live controller-owned lease (WI-2144343)', () => {
    const integration = makeIntegration();
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    const first = publish(integration, {
      DEPENDENCY_GENERATION_RETAIN_COUNT: '1',
    });
    expect(first.status, first.stderr).toBe(0);
    const firstIdentity = publishedIdentity(first.stdout);
    const firstPath = publishedPath(first.stdout);

    const selected = selectPrewarmed(
      generationRoot,
      integration,
      {},
      process.pid,
    );
    expect(selected.status, selected.stderr).toBe(0);
    expect(publishedIdentity(selected.stdout)).toBe(firstIdentity);
    const leaseDir = join(generationRoot, '.leases');
    const handoffLease = readdirSync(leaseDir)
      .map((entry) => join(leaseDir, entry))
      .find((lease) => {
        const body = readFileSync(lease, 'utf8');
        return (
          body.includes(`pid=${process.pid}\n`) &&
          body.includes(`identity=${firstIdentity}\n`)
        );
      });
    expect(handoffLease).toBeDefined();

    for (let i = 1; i <= 2; i += 1) {
      writeFileSync(
        join(integration, 'package-lock.json'),
        JSON.stringify({ ...JSON.parse(readFileSync(join(integration, 'package-lock.json'), 'utf8')),
          name: `fixture-${i}` }) + '\n',
      );
      writeFileSync(join(integration, 'node_modules/pkg/index.js'), `new-${i}\n`);
      const result = publish(integration, {
        DEPENDENCY_GENERATION_RETAIN_COUNT: '1',
      });
      expect(result.status, result.stderr).toBe(0);
    }
    expect(existsSync(firstPath)).toBe(true);

    rmSync(handoffLease!);
    writeFileSync(
      join(integration, 'package-lock.json'),
      JSON.stringify({ ...JSON.parse(readFileSync(join(integration, 'package-lock.json'), 'utf8')),
        name: 'fixture-after-handoff' }) + '\n',
    );
    writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'after-handoff\n');
    const after = publish(integration, {
      DEPENDENCY_GENERATION_RETAIN_COUNT: '1',
    });
    expect(after.status, after.stderr).toBe(0);
    expect(existsSync(firstPath)).toBe(false);
  }, NATIVE_SHELL_TIMEOUT_MS);

  // The manifest walk fingerprints each node_modules tree independently and
  // sorts globally, so it runs in parallel. Parallelism must remain an
  // invisible scheduling detail: if a walker ever emitted a partial or
  // out-of-order record, the manifest — and therefore the generation IDENTITY
  // derived from it — would differ run to run, and exact-id consumers would be
  // pinned against a tree that never existed. (EI-21322804786723906)
  function manifest(root: string, jobs: string): ShellResult {
    const wrapper = [
      // The publisher main runs under `set -euo pipefail`, and the serial walk
      // reports a failed tree through its pipeline status, so the walk must be
      // exercised in that same mode to be measuring the real contract.
      'set -o pipefail',
      'source "$SCRIPT"',
      'dependency_generation_set_manifest "$ROOT"',
    ].join('\n');
    const result = spawnSync('bash', ['-c', wrapper], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SCRIPT,
        ROOT: root,
        DEPENDENCY_GENERATION_WALK_JOBS: jobs,
      },
    });
    return {
      status: result.status,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
    };
  }

  it('produces a byte-identical manifest whether the walk is serial or parallel', () => {
    const integration = makeIntegration();
    // Names that punish naive word-splitting, plus enough trees that a
    // parallel pool genuinely overlaps rather than running one at a time.
    mkdirSync(join(integration, 'has space/node_modules/pkg'), {
      recursive: true,
    });
    writeFileSync(
      join(integration, 'has space/node_modules/pkg/index.js'),
      'spaced\n',
    );
    for (let i = 0; i < 24; i += 1) {
      mkdirSync(join(integration, `gen${i}/node_modules/p${i}`), {
        recursive: true,
      });
      writeFileSync(
        join(integration, `gen${i}/node_modules/p${i}/index.js`),
        `v${i}\n`,
      );
    }

    const serial = manifest(integration, '1');
    const parallel = manifest(integration, '8');

    expect(serial.status, serial.stderr).toBe(0);
    expect(parallel.status, parallel.stderr).toBe(0);
    // Calibration: without this the assertion below would also hold for two
    // empty manifests, i.e. for a walk that silently measured nothing.
    expect(serial.stdout.trimEnd().split('\n').length).toBeGreaterThan(20);
    expect(parallel.stdout).toBe(serial.stdout);
  });

  it('fails the manifest in both walk modes when a tree cannot be read', () => {
    const integration = makeIntegration();
    const unreadable = join(integration, 'blocked/node_modules');
    mkdirSync(unreadable, { recursive: true });
    chmodSync(unreadable, 0o000);
    try {
      // A truncated manifest must never reach the caller as a valid identity,
      // so a failed walker fails the whole walk under either scheduler.
      expect(manifest(integration, '1').status).not.toBe(0);
      expect(manifest(integration, '8').status).not.toBe(0);
    } finally {
      chmodSync(unreadable, 0o755);
    }
  });
});

describe('WI-42354: the generation store is born un-committable', () => {
  // The store is host-local runtime state (leases, materialized trees, and pins whose
  // only mutating field is `updated=<epoch>`) that happens to live INSIDE a git working
  // tree. While it was tracked, every run rewrote a pin heartbeat, git-sync committed
  // the churn, the pot's tip moved, and the NEXT run saw "changes" and re-materialized
  // from scratch — perpetual motion that kept ~20 hourly gates redoing full setup.
  // Untracking the 7 existing repos was the data fix; these tests guard the CLASS, so a
  // store created in a pot that does not exist yet cannot reintroduce it.

  it('writes a self-ignoring .gitignore into the store root on publish', () => {
    const integration = makeIntegration();
    expect(publish(integration).status).toBe(0);
    const ignore = join(integration, '.papercusp/dependency-generations/.gitignore');
    expect(existsSync(ignore)).toBe(true);
    // '*' also ignores the .gitignore itself — deliberate: nothing under this root
    // should ever reach git, and the marker must not depend on the enclosing repo's
    // .gitignore, which a newly-created pot will not yet have.
    expect(readFileSync(ignore, 'utf8').trim()).toBe('*');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('EI-26183925708230574: a live exact-ref scratch tree stays out of Git without enclosing ignore rules', () => {
    const integration = makeIntegration();
    const candidate = commitFixture(integration, 'exact-ref scratch fixture');
    const fingerprint = fingerprintRef(integration, candidate);
    expect(fingerprint.status, fingerprint.stderr).toBe(0);
    expect(existsSync(join(integration, '.gitignore'))).toBe(false);
    const staged = spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'source "$SCRIPT"',
      'dependency_generation_stage_exact_ref_inputs "$INTEGRATION" "$CANDIDATE" "$EXACT_INPUT"',
      'printf "%s\\n" "$DEPENDENCY_GENERATION_EXACT_SCRATCH"',
    ].join('\n')], {
      encoding: 'utf8',
      env: {
        ...process.env, SCRIPT, INTEGRATION: integration, CANDIDATE: candidate,
        EXACT_INPUT: publishedInputFingerprint(fingerprint.stdout),
      },
    });
    expect(staged.status, staged.stderr).toBe(0);
    const scratch = staged.stdout.trim();
    expect(existsSync(join(scratch, '.papercusp-exact-ref-writer'))).toBe(true);
    expect(existsSync(join(scratch, 'package-lock.json'))).toBe(true);
    const relativeScratch = scratch.slice(integration.length + 1);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: integration, encoding: 'utf8' });
    expect(git('ls-files', '--others', '--exclude-standard', '--', relativeScratch).trim()).toBe('');

    // Calibration: ordinary source still participates in the same staging pass.
    writeFileSync(join(integration, 'ordinary-source.ts'), 'export const current = true;\n');
    git('add', '-A');
    expect(git('diff', '--cached', '--name-only', '--', relativeScratch).trim()).toBe('');
    expect(git('diff', '--cached', '--name-only', '--', 'ordinary-source.ts').trim()).toBe('ordinary-source.ts');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it.each(['', 'nested/pot/'])('EI-26183925708230574: canonical ignore rules protect abandoned exact-ref inputs at %s', (prefix) => {
    const integration = makeIntegration();
    execFileSync('git', ['init', '-q'], { cwd: integration });
    writeFileSync(join(integration, '.gitignore'), readFileSync(join(REPO_ROOT, '.gitignore')));
    const path = `${prefix}.papercusp/dependency-exact-ref/abandoned/.papercusp-exact-ref-writer`;
    mkdirSync(dirname(join(integration, path)), { recursive: true });
    writeFileSync(join(integration, path), 'pid=99999999\n');
    expect(execFileSync('git', ['check-ignore', '--no-index', '--', path], { cwd: integration, encoding: 'utf8' }).trim()).toBe(path);
    writeFileSync(join(integration, 'ordinary-source.ts'), 'export {};\n');
    expect(execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'ordinary-source.ts'], { cwd: integration, encoding: 'utf8' }).trim()).toBe('ordinary-source.ts');
  });

  it('git reports NOTHING to commit for a store that has published pins', () => {
    const integration = makeIntegration();
    const git = (...args: string[]) =>
      spawnSync('git', ['-C', integration, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');

    // CALIBRATION: before the store exists, this fixture is full of untracked files, so
    // an empty `git status` would mean the probe is broken rather than the guard working.
    expect(git('status', '--porcelain').stdout.trim()).not.toBe('');
    git('add', '-A');
    git('commit', '-qm', 'fixture');
    expect(git('status', '--porcelain').stdout.trim()).toBe('');

    expect(publish(integration).status).toBe(0);
    const pins = join(integration, '.papercusp/dependency-generations/.pins');
    mkdirSync(pins, { recursive: true });
    writeFileSync(join(pins, 'checkout-deadbeef'), 'schema=1\nupdated=1787000000\n');

    // THE REGRESSION: publishing + a pin heartbeat must leave git with nothing to say.
    // Without the guard this reports `?? .papercusp/` — the exact churn that moved
    // dormant pot tips every hour and defeated the gate's up-to-date short-circuit.
    expect(git('status', '--porcelain').stdout.trim()).toBe('');
  }, NATIVE_SHELL_TIMEOUT_MS);
});

// The publish lock is documented as "short", and its waiter used to give up after a
// fixed 300 attempts (30s) and return 73 — which every one of its six call sites
// propagates as a hard failure. That combination is a BOUNDED waiter against an
// UNBOUNDED holder: acquire()'s retry loop calls cleanup_abandoned on EVERY failed
// mkdir, so a same-host lock whose writer PID is dead is reclaimed within one 0.1s
// tick. The budget is therefore never spent on an abandoned lock — it can only ever
// be reached while the holder is genuinely ALIVE, doing legitimate work (the
// full-tree validation walk on the replacement/removal race, or a retention prune),
// which on a multi-GB generation runs for minutes. Reaching it crashed the caller
// outright: green-checkpoint recorded `inconclusive: error` and never ran a suite.
describe('dependency-generation publish-lock waiter', () => {
  function publishLockScenario(
    scenario: 'dead-writer' | 'live-then-release' | 'live-holder' | 'empty-writer' | 'foreign-writer',
    env: Record<string, string> = {},
    timeoutMs?: number,
    prepareRoot?: (root: string) => void,
  ): ShellResult & { signal: NodeJS.Signals | null } {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-publish-lock-'));
    roots.push(root);
    prepareRoot?.(root);
    const wrapper = [
      'set -uo pipefail',
      'source "$SCRIPT"',
      'lock="$ROOT/.publish-lock"',
      'mkdir -p "$lock"',
      // Every background holder gets its OWN stdio. Inheriting the pipes makes an
      // orphaned holder outlive the spawnSync timeout still holding them open, so
      // the parent blocks on EOF long after the child was killed — the run then
      // takes ~40s per timeout case instead of the budget under test.
      'writer_host="$(dependency_generation_host)"',
      'case "$SCENARIO" in',
      // An impossible PID stays dead even if the host reuses PIDs rapidly.
      // This isolates stale-lock recovery from process scheduling.
      '  dead-writer) holder=99999999 ;;',
      '  live-then-release) sleep 300 </dev/null >/dev/null 2>&1 & holder=$!; ( sleep 2; rm -rf -- "$lock" ) </dev/null >/dev/null 2>&1 & ;;',
      '  live-holder) sleep 45 </dev/null >/dev/null 2>&1 & holder=$! ;;',
      '  empty-writer) holder= ;;',
      '  foreign-writer) holder=99999999; writer_host=foreign-host ;;',
      'esac',
      'if [ "$SCENARIO" = empty-writer ]; then',
      '  [ -f "$lock/writer" ] || : > "$lock/writer"',
      'else',
      '  printf "host=%s\\npid=%s\\nstarted=%s\\n" \\',
      '    "$writer_host" "$holder" "$(date +%s)" > "$lock/writer"',
      'fi',
      'if dependency_generation_acquire_publish_lock "$ROOT"; then',
      '  printf "ACQUIRED\\n"',
      'else',
      '  printf "FAILED rc=%s\\n" "$?"',
      'fi',
      'if [ -f "$lock/writer" ] && dependency_generation_writer_has_identity "$lock/writer"; then printf "OWNER_VALID\\n"; fi',
      'kill "$holder" 2>/dev/null || true',
    ].join('\n');
    const result = spawnSync('bash', ['-c', wrapper], {
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
      env: { ...process.env, SCRIPT, ROOT: root, SCENARIO: scenario, ...env },
    });
    return {
      status: result.status,
      signal: result.signal,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
    };
  }

  it('reclaims a lock whose writer PID is dead instead of waiting out the budget', () => {
    // This is the premise that makes a generous budget safe: an abandoned lock is
    // never what the waiter is waiting for. A zero-second budget proves cleanup
    // is followed by one immediate acquire before the timeout can reject it.
    const result = publishLockScenario('dead-writer', {
      DEPENDENCY_GENERATION_PUBLISH_LOCK_TIMEOUT_SEC: '0',
    });
    expect(result.stdout, result.stderr).toContain('ACQUIRED');
    expect(result.stderr).toContain('quarantined abandoned publish lock');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('reclaims an aged empty writer marker after the stale-lock grace', () => {
    const old = new Date(Date.now() - 301_000);
    const result = publishLockScenario(
      'empty-writer',
      { DEPENDENCY_GENERATION_PUBLISH_LOCK_TIMEOUT_SEC: '0' },
      undefined,
      (root) => {
        const lock = join(root, '.publish-lock');
        mkdirSync(lock);
        writeFileSync(join(lock, 'writer'), '');
        utimesSync(lock, old, old);
      },
    );
    expect(result.stdout, result.stderr).toContain('ACQUIRED');
    expect(result.stdout).toContain('OWNER_VALID');
    expect(result.stderr).toContain('quarantined abandoned publish lock');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('keeps a recent empty writer marker fail-closed and reports it as unknown', () => {
    const recent = new Date();
    const result = publishLockScenario(
      'empty-writer',
      { DEPENDENCY_GENERATION_PUBLISH_LOCK_TIMEOUT_SEC: '0' },
      undefined,
      (root) => {
        const lock = join(root, '.publish-lock');
        mkdirSync(lock);
        writeFileSync(join(lock, 'writer'), '');
        utimesSync(lock, recent, recent);
      },
    );
    expect(result.stdout).toContain('FAILED rc=73');
    expect(result.stderr).toContain('holder unknown-writer (invalid writer marker)');
    expect(result.stderr).not.toContain('quarantined abandoned publish lock');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('preserves a valid foreign-host writer instead of reclaiming it', () => {
    const result = publishLockScenario('foreign-writer', {
      DEPENDENCY_GENERATION_PUBLISH_LOCK_TIMEOUT_SEC: '0',
    });
    expect(result.stdout).toContain('FAILED rc=73');
    expect(result.stderr).toContain('holder host=foreign-host pid=99999999');
    expect(result.stderr).not.toContain('quarantined abandoned publish lock');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('waits for a LIVE holder and acquires the lock once it is released', () => {
    const result = publishLockScenario('live-then-release', {
      DEPENDENCY_GENERATION_PUBLISH_LOCK_TIMEOUT_SEC: '30',
    });
    expect(result.stdout).toContain('ACQUIRED');
    expect(result.stdout).not.toContain('FAILED');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('honours the configured budget and NAMES the live holder when it times out', () => {
    // A bare "timed out" left the reader unable to tell contention from a wedged
    // writer; the message must identify who held it and for how long.
    const result = publishLockScenario('live-holder', {
      DEPENDENCY_GENERATION_PUBLISH_LOCK_TIMEOUT_SEC: '1',
    });
    expect(result.stdout).toContain('FAILED rc=73');
    expect(result.stderr).toMatch(
      /FATAL: timed out waiting for the short dependency-generation publish lock after \d+s of 1s/,
    );
    expect(result.stderr).toMatch(/holder host=\S+ pid=\d+ held=\d+s/);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('falls back to the default budget when the override is not a number', () => {
    // A non-numeric override must not degrade to 0 attempts (an instant exit 73).
    const result = publishLockScenario(
      'live-holder',
      { DEPENDENCY_GENERATION_PUBLISH_LOCK_TIMEOUT_SEC: 'not-a-number' },
      5_000,
    );
    expect(result.stdout).not.toContain('FAILED');
    expect(result.signal).toBe('SIGTERM');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('THE REGRESSION: the default budget outlasts the old 30s hard-fail', () => {
    // Directly falsifies the pre-fix behaviour. With a live holder and no override,
    // the waiter must STILL be waiting after 30s rather than having returned 73 —
    // and its progress heartbeat must name the resolved default, so this asserts the
    // magnitude behaviourally instead of regex-matching the constant in the source.
    // 38s, not 33s: the heartbeat lands at 30s and each loop iteration also scans
    // the generation store, so a loaded box can push it out by a second or two.
    const result = publishLockScenario('live-holder', {}, 38_000);
    expect(result.stdout).not.toContain('FAILED');
    expect(result.signal).toBe('SIGTERM');
    expect(result.stderr).toMatch(
      /still waiting for the dependency-generation publish lock after 3\ds of 900s/,
    );
  }, NATIVE_SHELL_TIMEOUT_MS);
});

// WI-10004094: the gate and two bg-host prebuilds resolved ONE identity and each copied the
// ~16 GB tree into its own build dir; the three copies starved each other past the gate's
// 30m no-output budget, and the one silent cp gave the watchdog nothing to judge.
describe('WI-10004094: one build per dependency identity, with visible copy progress', () => {
  const realCp = execFileSync('bash', ['-c', 'command -v cp'], { encoding: 'utf8' }).trim();
  const host = execFileSync('hostname', { encoding: 'utf8' }).trim();

  function publishAsync(integration: string, env: NodeJS.ProcessEnv = {}): Promise<ShellResult> {
    return new Promise((resolvePublish) => {
      const child = spawn('bash', [SCRIPT, '--integration', integration], {
        env: { ...process.env, ...env },
      });
      const stdout = createTextCollector(child.stdout);
      const stderr = createTextCollector(child.stderr);
      child.on('close', (status) => resolvePublish({ status, stdout: stdout.text(), stderr: stderr.text() }));
    });
  }

  async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((settle) => setTimeout(settle, 50));
    }
    return predicate();
  }

  // A `cp` that runs SHIM_BODY first, then execs the real cp in the same pid.
  function cpShimPath(root: string, shimBody: string): string {
    const shimDir = join(root, 'shim-bin');
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, 'cp'), `#!/usr/bin/env bash\n${shimBody}\nexec ${realCp} "$@"\n`);
    chmodSync(join(shimDir, 'cp'), 0o755);
    return `${shimDir}:${process.env.PATH ?? ''}`;
  }

  it('a second publisher joins the live build of the same identity, relays its progress, and cache-hits instead of copying', async () => {
    const integration = makeIntegration();
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    const inflight = () =>
      existsSync(generationRoot) &&
      readdirSync(generationRoot).filter((name) => name.startsWith('.inflight-'));
    // Every holder cp sleeps 2s first, so its "copying" line stays current across a 1s poll.
    const holder = publishAsync(integration, { PATH: cpShimPath(dirname(integration), 'sleep 2') });
    expect(await waitFor(() => (inflight() || []).length === 1, 60_000)).toBe(true);

    const joiner = await publishAsync(integration);
    const built = await holder;

    expect(built.status, built.stderr).toBe(0);
    expect(joiner.status, joiner.stderr).toBe(0);
    expect(joiner.stderr).toMatch(
      /joining in-flight build of v1-[0-9a-f]{64} \(host=\S+ pid=\d+ held=\d+s\) instead of copying/,
    );
    expect(joiner.stderr).toMatch(/in-flight build of v1-[0-9a-f]{64}: copying dependency tree: /);
    // Every copy line the joiner printed is a relayed one: it copied nothing itself.
    expect(joiner.stderr).not.toMatch(/^\[dependency-generation\] cop(y|ied)/m);
    expect(lastSummary(joiner).result).toBe('cache-hit');
    expect(lastSummary(joiner).identity).toBe(lastSummary(built).identity);
    expect(Number(lastSummary(built).trees_copied)).toBeGreaterThan(0);
    expect(inflight()).toEqual([]);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('reclaims an in-flight lock whose same-host holder died, then publishes', () => {
    const integration = makeIntegration();
    const dead = join(
      integration,
      `.papercusp/dependency-generations/.inflight-v1-${'0'.repeat(64)}`,
    );
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, 'writer'), `host=${host}\npid=99999999\nstarted=1\n`);

    const result = publish(integration);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(dead)).toBe(false);
    expect(result.stderr).toContain(`reclaimed abandoned in-flight build lock .inflight-v1-${'0'.repeat(64)}`);
  }, NATIVE_SHELL_TIMEOUT_MS);

  function waitScenario(outcome: 'holder-finishes' | 'holder-stalls'): ShellResult {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-inflight-wait-'));
    roots.push(root);
    const wrapper = [
      'set -uo pipefail',
      'source "$SCRIPT"',
      'lock="$ROOT/.inflight-$ID"',
      'mkdir "$lock"',
      // Own stdio, so an orphaned holder cannot keep spawnSync's pipes open.
      'sleep 45 </dev/null >/dev/null 2>&1 & holder=$!',
      'printf "host=%s\\npid=%s\\nstarted=%s\\n" "$(dependency_generation_host)" "$holder" "$(date +%s)" > "$lock/writer"',
      'printf "%s copying dependency tree: node_modules\\n" "$(date +%s)" > "$lock/progress"',
      // WI-6554700010018236: the holder ends only after the waiter has relayed its
      // progress line, never after a fixed 2s timer. The waiter samples holder copy
      // I/O (a host-wide `ps -e`) before its first poll; on a loaded host that
      // outlasted 2s, so the lock vanished before any relay.
      'eval "__orig_$(declare -f dependency_generation_log)"; dependency_generation_log() { __orig_dependency_generation_log "$@"; printf "%s\\n" "$*" >> "$ROOT/log"; }',
      'if [ "$OUTCOME" = holder-finishes ]; then ( for _ in $(seq 1 600); do grep -qF ": copying dependency tree" "$ROOT/log" 2>/dev/null && break; sleep 0.1; done; rm -rf -- "$lock" ) </dev/null >/dev/null 2>&1 & fi',
      'rc=0; dependency_generation_wait_inflight "$ROOT" "$ID" || rc=$?',
      'printf "RC=%s\\n" "$rc"',
      'kill "$holder" 2>/dev/null || true',
    ].join('\n');
    const result = spawnSync('bash', ['-c', wrapper], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SCRIPT,
        ROOT: root,
        ID: `v1-${'a'.repeat(64)}`,
        OUTCOME: outcome,
        DEPENDENCY_GENERATION_INFLIGHT_STALL_SEC: outcome === 'holder-stalls' ? '2' : '30',
      },
    });
    return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  }

  it('a joined waiter relays the holder progress and asks for re-validation when the holder ends', () => {
    const result = waitScenario('holder-finishes');
    expect(result.stdout, result.stderr).toContain('RC=79');
    expect(result.stderr).toContain(`in-flight build of v1-${'a'.repeat(64)}: copying dependency tree: node_modules`);
    expect(result.stderr).toContain('ended; re-validating');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('a waiter whose live holder shows no progress fails rc73 and names the holder before any outer watchdog', () => {
    const result = waitScenario('holder-stalls');
    expect(result.stdout, result.stderr).toContain('RC=73');
    expect(result.stderr).toMatch(
      /FATAL: in-flight build of v1-a{64} showed no progress for 2s \(host=\S+ pid=\d+ held=\d+s\)/,
    );
  }, NATIVE_SHELL_TIMEOUT_MS);

  it.each(['advancing', 'idle'] as const)('uses copy writes, not static text or holder polling, for an %s joined build', (activity) => {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-inflight-copy-wait-'));
    roots.push(root);
    const wrapper = [
      'set -uo pipefail',
      'source "$SCRIPT"',
      'lock="$ROOT/.inflight-$ID"; mkdir "$lock"',
      'printf "host=%s\\npid=%s\\nstarted=0\\n" "$(dependency_generation_host)" "$$" > "$lock/writer"',
      'printf "0 copying dependency tree: node_modules\\n" > "$lock/progress"',
      'echo 0 > "$ROOT/tick"',
      // Only the clock and kernel counter seam are controlled. The production
      // waiter must outlive its stall budget on writes and reject a flat counter.
      'date() { cat "$ROOT/tick"; }',
      'dependency_generation_inflight_is_abandoned() { return 1; }',
      'dependency_generation_subtree_io() { [ "$2" = cp-written ] || return 1; if [ "$ACTIVITY" = advancing ]; then echo $((100 + $(cat "$ROOT/tick") * 1024)); else echo 100; fi; }',
      'sleep() { local tick; tick=$(( $(cat "$ROOT/tick") + 1 )); echo "$tick" > "$ROOT/tick"; if [ "$ACTIVITY" = advancing ] && [ "$tick" -ge 6 ]; then rm -rf -- "$lock"; fi; }',
      'rc=0; dependency_generation_wait_inflight "$ROOT" "$ID" || rc=$?',
      'printf "RC=%s TICK=%s\\n" "$rc" "$(cat "$ROOT/tick")"',
    ].join('\n');
    const result = spawnSync('bash', ['-c', wrapper], {
      encoding: 'utf8', timeout: NATIVE_SHELL_TIMEOUT_MS,
      env: { ...process.env, SCRIPT, ROOT: root, ID: `v1-${'b'.repeat(64)}`, ACTIVITY: activity,
        DEPENDENCY_GENERATION_COPY_PROGRESS_SEC: '1', DEPENDENCY_GENERATION_INFLIGHT_STALL_SEC: '2' },
    });
    expect(result.status, result.stderr).toBe(0);
    if (activity === 'advancing') {
      expect(result.stdout).toContain('RC=79 TICK=6');
      expect(result.stderr).toContain('copy writes advanced');
      expect(result.stderr).not.toContain('FATAL');
    } else {
      expect(result.stdout).toContain('RC=73 TICK=2');
      expect(result.stderr).not.toContain('copy writes advanced');
    }
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('measures an actual copy child while excluding holder reads and shell writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-inflight-copy-io-'));
    roots.push(root);
    const wrapper = [
      'set -euo pipefail',
      'source "$SCRIPT"',
      'printf holder-polling > "$ROOT/noise"; cat "$ROOT/noise" >/dev/null',
      'printf "IDLE=%s\\n" "$(dependency_generation_subtree_io $$ cp-written)"',
      'mkfifo "$ROOT/fifo"',
      'cp "$ROOT/fifo" "$ROOT/sink" & copier=$!',
      'trap \'kill "$copier" 2>/dev/null || true\' EXIT',
      'exec 9> "$ROOT/fifo"',
      'printf "%1048576s" "" >&9',
      'while [ "$(stat -c %s "$ROOT/sink" 2>/dev/null || echo 0)" -lt 1048576 ]; do kill -0 "$copier"; sleep 0.05; done',
      'printf "ACTIVE=%s\\n" "$(dependency_generation_subtree_io $$ cp-written)"',
      'exec 9>&-; wait "$copier"; trap - EXIT',
    ].join('\n');
    const result = spawnSync('bash', ['-c', wrapper], {
      encoding: 'utf8', timeout: NATIVE_SHELL_TIMEOUT_MS,
      env: { ...process.env, SCRIPT, ROOT: root },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^IDLE=\s*$/m);
    const written = Number(/^ACTIVE=(\d+)$/m.exec(result.stdout)?.[1]);
    expect(written).toBeGreaterThanOrEqual(1_048_576);
  }, NATIVE_SHELL_TIMEOUT_MS);

  function copyScenario(shimBody: string): ShellResult {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-copy-progress-'));
    roots.push(root);
    mkdirSync(join(root, 'src/pkg'), { recursive: true });
    writeFileSync(join(root, 'src/pkg/index.js'), 'copied\n');
    const wrapper = [
      'set -uo pipefail',
      'source "$SCRIPT"',
      'rc=0; dependency_generation_copy_independent "$ROOT/src" "$ROOT/build/tree/node_modules" || rc=$?',
      'printf "RC=%s\\n" "$rc"',
    ].join('\n');
    const result = spawnSync('bash', ['-c', wrapper], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SCRIPT,
        ROOT: root,
        PATH: cpShimPath(root, shimBody),
        DEPENDENCY_GENERATION_COPY_PROGRESS_SEC: '1',
      },
    });
    expect(readFileSync(join(root, 'build/tree/node_modules/pkg/index.js'), 'utf8')).toBe('copied\n');
    return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  }

  it('reports bytes written while a long copy keeps writing', () => {
    // The shim's own builtin writes count toward the copy pid's I/O, as cp's would.
    const result = copyScenario(
      `for i in 1 2 3; do printf '%1048576s' '' >> "$ROOT/sink"; sleep 1.2; done`,
    );
    expect(result.stdout, result.stderr).toContain('RC=0');
    expect(result.stderr).toMatch(/copy progress: node_modules written=[1-9]\d*MiB elapsed=\d+s/);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('stays silent while a copy writes nothing, so a wedged copy still reads as wedged', () => {
    const result = copyScenario('sleep 3.5');
    expect(result.stdout, result.stderr).toContain('RC=0');
    expect(result.stderr).not.toContain('copy progress');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('treats a process disappearing during /proc stat read as unmeasured without stderr noise', () => {
    const root = mkdtempSync(join(tmpdir(), 'dependency-copy-proc-stat-race-'));
    roots.push(root);
    const wrapper = [
      'set -uo pipefail',
      'source "$SCRIPT"',
      // Inject the procfs read failure that occurs when the monitored child exits
      // after the caller checked it but before Bash finishes reading /proc/PID/stat.
      'read() { if [ "$1" = -r ] && [ "$2" = stat_line ]; then printf "read: read error: 0: No such process\\n" >&2; return 1; fi; builtin read "$@"; }',
      'cp() { command sleep 0.1; }',
      'dependency_generation_copy_with_progress "$ROOT/src" "$ROOT/dest"',
      'printf "COPY_DONE\\n"',
    ].join('\n');
    const result = spawnSync('bash', ['-c', wrapper], {
      encoding: 'utf8', timeout: NATIVE_SHELL_TIMEOUT_MS,
      env: { ...process.env, SCRIPT, ROOT: root },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('COPY_DONE');
    expect(result.stderr).not.toContain('read: read error: 0: No such process');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('reports checksum reads while an independent resume verifies retained bytes without writing', () => {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-checksum-progress-'));
    roots.push(root);
    writeFileSync(join(root, 'payload'), 'x'.repeat(1_048_576));
    const wrapper = [
      'set -uo pipefail',
      'source "$SCRIPT"',
      // The worker reads using a shell builtin so the kernel counters belong
      // to the actual monitored PID, just as rsync sender checksum reads do.
      // WI-6554700010018236: the worker stays alive until the monitor has logged a
      // read sample, never for a fixed wall-clock window. Each sample walks the host
      // process table (`ps -e` in dependency_generation_subtree_io); on a loaded host
      // that took longer than the old 3.6s worker, so no sample landed and stderr was empty.
      'eval "__orig_$(declare -f dependency_generation_log)"; dependency_generation_log() { __orig_dependency_generation_log "$@"; printf "%s\\n" "$*" >> "$ROOT/log"; }',
      'rsync() { local chunk i; for i in $(seq 1 150); do IFS= read -r -N 1048576 chunk < "$ROOT/payload"; grep -qE "checksum read progress: .* read=[1-9]" "$ROOT/log" 2>/dev/null && return 0; sleep 0.2; done; return 1; }',
      'rc=0; dependency_generation_copy_with_progress "$ROOT/src" "$ROOT/dest" --rsync-checksum || rc=$?',
      'printf "RC=%s\\n" "$rc"',
    ].join('\n');
    const result = spawnSync('bash', ['-c', wrapper], {
      encoding: 'utf8', timeout: NATIVE_SHELL_TIMEOUT_MS,
      env: { ...process.env, SCRIPT, ROOT: root, DEPENDENCY_GENERATION_COPY_PROGRESS_SEC: '1' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('RC=0');
    expect(result.stderr).toMatch(/checksum read progress: .* read=[1-9]\d*MiB/);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it.each(['writes', 'checksum-reads', 'stalled', 'unmeasured'] as const)
    ('uses measured copy inactivity rather than elapsed time: %s', activity => {
      const root = mkdtempSync(join(tmpdir(), 'dependency-copy-stall-')); roots.push(root);
      const wrapper = [
        'set -uo pipefail; source "$SCRIPT"',
        'echo 0 > "$ROOT/tick"',
        'date() { cat "$ROOT/tick"; }',
        'cp() { echo "$BASHPID" > "$ROOT/child"; while [ ! -f "$ROOT/done" ]; do command sleep 0.01; done; }',
        'rsync() { cp; }',
        'dependency_generation_subtree_io() { local tick; tick=$(cat "$ROOT/tick"); if { [ "$ACTIVITY" = writes ] && [ "$2" = copy-written ]; } || { [ "$ACTIVITY" = checksum-reads ] && [ "$2" = copy-read ]; }; then echo $((tick * 1048576)); elif [ "$ACTIVITY" != unmeasured ]; then echo 0; fi; }',
        'sleep() { local tick; tick=$(( $(cat "$ROOT/tick") + 1 )); echo "$tick" > "$ROOT/tick"; if [ "$tick" -ge 6 ]; then touch "$ROOT/done"; fi; command sleep 0.03; }',
        'rc=0; dependency_generation_copy_with_progress "$ROOT/src" "$ROOT/dest" --rsync-checksum || rc=$?',
        'printf "RC=%s TICK=%s\\n" "$rc" "$(cat "$ROOT/tick")"',
        'child=$(cat "$ROOT/child"); if kill -0 "$child" 2>/dev/null; then echo CHILD_ALIVE; kill -KILL "$child"; fi',
      ].join('\n');
      const result = spawnSync('bash', ['-c', wrapper], { encoding: 'utf8', timeout: NATIVE_SHELL_TIMEOUT_MS,
        env: { ...process.env, SCRIPT, ROOT: root, ACTIVITY: activity,
          DEPENDENCY_GENERATION_COPY_PROGRESS_SEC: '1', DEPENDENCY_GENERATION_INFLIGHT_STALL_SEC: '2' } });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain('CHILD_ALIVE');
      if (activity === 'writes' || activity === 'checksum-reads') {
        expect(result.stdout).toMatch(/RC=0 TICK=[6-9]/);
        expect(result.stderr).not.toContain('COPY_STALLED');
      } else {
        expect(result.stdout).toContain('RC=73 TICK=2');
        expect(result.stderr).toMatch(/COPY_STALLED idle=2s budget=2s .*path=/);
      }
    }, NATIVE_SHELL_TIMEOUT_MS);

  it('cancels and reaps only its copy subtree while preserving the caller EXIT trap', () => {
    const root = mkdtempSync(join(tmpdir(), 'dependency-copy-cancel-')); roots.push(root);
    const wrapper = [
      'set -uo pipefail; source "$SCRIPT"',
      'trap \'echo CALLER_EXIT\' EXIT',
      'cp() { echo "$BASHPID" > "$ROOT/child"; ps -o ppid= -p "$BASHPID" > "$ROOT/supervisor"; command sleep 60 & nested=$!; echo "$nested" > "$ROOT/nested"; wait "$nested"; }',
      'dependency_generation_copy_with_progress "$ROOT/src" "$ROOT/dest" & runner=$!',
      'while [ ! -f "$ROOT/nested" ]; do sleep 0.01; done',
      // Bash backgrounds a subshell-bodied function through an extra wrapper.
      // Signal the observed copy supervisor, rather than bypassing its trap.
      'kill -TERM "$(tr -d \' \' < "$ROOT/supervisor")"; rc=0; wait "$runner" || rc=$?; echo RC=$rc',
      // A descendant killed before its parent can briefly remain as a zombie;
      // neither a running copy nor a live nested worker may survive the return.
      'for file in child nested; do pid=$(cat "$ROOT/$file"); if [ -r "/proc/$pid/stat" ]; then state=$(awk \'{print $3}\' "/proc/$pid/stat"); [ "$state" = Z ] || { echo SURVIVING_WORKER; kill -KILL "$pid"; }; fi; done',
    ].join('\n');
    const result = spawnSync('bash', ['-c', wrapper], { encoding: 'utf8', timeout: NATIVE_SHELL_TIMEOUT_MS,
      env: { ...process.env, SCRIPT, ROOT: root } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('RC=143');
    expect(result.stdout).toContain('CALLER_EXIT');
    expect(result.stdout).not.toContain('SURVIVING_WORKER');
    expect(result.stderr).toContain('COPY_CANCELLED signal=TERM');
  }, NATIVE_SHELL_TIMEOUT_MS);
});

describe('WI-10004825: scratch trees stranded by dead runs are reaped', () => {
  const parents: string[] = [];
  afterEach(() => {
    for (const p of parents.splice(0)) rmSync(p, { recursive: true, force: true });
  });

  function deadPid(): number {
    const child = spawnSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' });
    const pid = Number(child.stdout.trim());
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(existsSync(`/proc/${pid}`)).toBe(false);
    return pid;
  }

  function scratch(path: string, ageSec: number): void {
    mkdirSync(join(path, 'pkg'), { recursive: true });
    writeFileSync(join(path, 'pkg/index.js'), 'partial\n');
    const t = Date.now() / 1000 - ageSec;
    utimesSync(path, t, t);
  }

  it('removes only siblings whose pid is gone and whose mtime is past the grace window', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dependency-generation-reap-'));
    parents.push(parent);
    const dest = join(parent, 'node_modules');
    mkdirSync(dest);
    const dead = deadPid();
    const live = process.pid;
    const nestedDead = `${dest}.deploy-tmp.${dead}.generation-tmp.${dead}`;
    const oldDead = `${dest}.deploy-old.${dead}`;
    const genDead = `${dest}.generation-tmp.${dead}`;
    const liveOwned = `${dest}.deploy-tmp.${live}`;
    const recentDead = `${dest}.generation-old.${dead}`;
    scratch(nestedDead, 7200);
    scratch(oldDead, 7200);
    scratch(genDead, 7200);
    // A read-only directory inside a frozen generation copy must not block removal.
    chmodSync(join(genDead, 'pkg'), 0o555);
    scratch(liveOwned, 7200);
    scratch(recentDead, 5);

    const result = spawnSync(
      'bash',
      ['-c', 'set -euo pipefail; source "$SCRIPT"; dependency_generation_reap_dead_siblings "$DEST"; echo RC=$?'],
      {
        env: { ...process.env, SCRIPT, DEST: dest, DEPENDENCY_GENERATION_REAP_GRACE_SEC: '600' },
        encoding: 'utf8',
      },
    );
    expect(result.stdout, result.stderr).toContain('RC=0');
    expect(existsSync(nestedDead)).toBe(false);
    expect(existsSync(oldDead)).toBe(false);
    expect(existsSync(genDead)).toBe(false);
    expect(existsSync(liveOwned)).toBe(true);
    expect(existsSync(recentDead)).toBe(true);
    expect(existsSync(dest)).toBe(true);
    expect(result.stderr).toContain(`reaping orphaned scratch tree from dead pid ${dead}`);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('is a no-op when no sibling exists', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dependency-generation-reap-'));
    parents.push(parent);
    const dest = join(parent, 'node_modules');
    const result = spawnSync(
      'bash',
      ['-c', 'set -euo pipefail; source "$SCRIPT"; dependency_generation_reap_dead_siblings "$DEST"; echo RC=$?'],
      { env: { ...process.env, SCRIPT, DEST: dest }, encoding: 'utf8' },
    );
    expect(result.stdout, result.stderr).toContain('RC=0');
    expect(readdirSync(parent)).toEqual([]);
  }, NATIVE_SHELL_TIMEOUT_MS);
});

// WI-10004849: physical dependency copies are serialized host-wide and refuse to
// start without disk headroom. Exits: 76 = lock timeout, 77 = headroom.
describe('WI-10004849: dependency copy lock + headroom preflight', () => {
  function copyFixture(): { root: string; generation: string; source: string } {
    const root = mkdtempSync(join(tmpdir(), 'dependency-generation-headroom-'));
    roots.push(root);
    const generation = join(root, 'generation');
    const source = join(generation, 'tree/node_modules');
    mkdirSync(join(source, 'pkg'), { recursive: true });
    writeFileSync(join(source, 'pkg/index.js'), 'v1\n');
    return { root, generation, source };
  }

  function runShell(body: string, env: NodeJS.ProcessEnv): ShellResult {
    const wrapper = ['set -euo pipefail', 'source "$SCRIPT"', body].join('\n');
    const result = spawnSync('bash', ['-c', wrapper], {
      env: { ...process.env, SCRIPT, ...env },
      encoding: 'utf8',
    });
    return {
      status: result.status,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
    };
  }

  const fs = (avail: number) => ({
    DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES: String(avail),
    DEPENDENCY_GENERATION_HEADROOM_TOTAL_BYTES: '100000',
    DEPENDENCY_GENERATION_HEADROOM_RESERVE_PCT: '2',
    DEPENDENCY_GENERATION_HEADROOM_MARGIN_BYTES: '1000',
  });

  it('headroom_required is need + reserve + margin', () => {
    const result = runShell('dependency_generation_headroom_required 5000 2000 1000', {});
    expect(result.stdout.trim(), result.stderr).toBe('8000');
  });

  it('refuses with exit 77 when the recorded size does not fit, and copies nothing', () => {
    const { root, generation, source } = copyFixture();
    writeFileSync(join(generation, '.tree-bytes'), 'node_modules\t5000\n');
    const dest = join(root, 'out/node_modules');
    // required = 5000 + 2% of 100000 + 1000 = 8000
    const refused = runShell('dependency_generation_copy_independent "$SOURCE" "$DEST"', {
      ...fs(7999),
      SOURCE: source,
      DEST: dest,
    });
    expect(refused.status, refused.stderr).toBe(77);
    expect(refused.stderr).toContain('DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT need=5000');
    expect(refused.stderr).toContain('required=8000 size=recorded');
    expect(existsSync(dest)).toBe(false);

    const allowed = runShell('dependency_generation_copy_independent "$SOURCE" "$DEST"', {
      ...fs(8000),
      SOURCE: source,
      DEST: dest,
    });
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(readFileSync(join(dest, 'pkg/index.js'), 'utf8')).toBe('v1\n');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('an unknown size still enforces reserve + margin', () => {
    const { root, source } = copyFixture();
    const refused = runShell('dependency_generation_copy_independent "$SOURCE" "$DEST"', {
      ...fs(2999),
      SOURCE: source,
      DEST: join(root, 'out/node_modules'),
    });
    expect(refused.status, refused.stderr).toBe(77);
    expect(refused.stderr).toContain('need=0');
    expect(refused.stderr).toContain('size=unknown');
  }, NATIVE_SHELL_TIMEOUT_MS);

  describe('WI-10005931: the percentage reserve protects only the integration-root filesystem', () => {
    // reserve = 50% of 100000 = 50000 on the protected fs; capped to 3000 elsewhere.
    const scoped = (avail: number, sameFs: '0' | '1') => ({
      ...fs(avail),
      DEPENDENCY_GENERATION_HEADROOM_RESERVE_PCT: '50',
      DEPENDENCY_GENERATION_HEADROOM_OTHER_FS_RESERVE_CAP_BYTES: '3000',
      DEPENDENCY_GENERATION_HEADROOM_SAME_FS: sameFs,
    });

    it('caps the reserve off the protected filesystem and keeps the margin', () => {
      const { root, generation, source } = copyFixture();
      writeFileSync(join(generation, '.tree-bytes'), 'node_modules\t5000\n');
      const dest = join(root, 'out/node_modules');
      // other fs: required = 5000 + min(50000, 3000) + 1000 = 9000
      const refused = runShell('dependency_generation_copy_independent "$SOURCE" "$DEST"', {
        ...scoped(8999, '0'),
        SOURCE: source,
        DEST: dest,
      });
      expect(refused.status, refused.stderr).toBe(77);
      expect(refused.stderr).toContain('reserve=3000 reserve_scope=other-fs');
      expect(refused.stderr).toContain('required=9000');
      expect(existsSync(dest)).toBe(false);

      const allowed = runShell('dependency_generation_copy_independent "$SOURCE" "$DEST"', {
        ...scoped(9000, '0'),
        SOURCE: source,
        DEST: dest,
      });
      expect(allowed.status, allowed.stderr).toBe(0);
      expect(readFileSync(join(dest, 'pkg/index.js'), 'utf8')).toBe('v1\n');
    }, NATIVE_SHELL_TIMEOUT_MS);

    it('keeps the full percentage reserve on the protected filesystem', () => {
      const { root, generation, source } = copyFixture();
      writeFileSync(join(generation, '.tree-bytes'), 'node_modules\t5000\n');
      // protected fs: required = 5000 + 50000 + 1000 = 56000
      const refused = runShell('dependency_generation_copy_independent "$SOURCE" "$DEST"', {
        ...scoped(9000, '1'),
        SOURCE: source,
        DEST: join(root, 'out/node_modules'),
      });
      expect(refused.status, refused.stderr).toBe(77);
      expect(refused.stderr).toContain('reserve=50000 reserve_scope=protected-fs');
      expect(refused.stderr).toContain('required=56000');
    }, NATIVE_SHELL_TIMEOUT_MS);

    it('admits the incident copy (9.1 GB needed, 165.7 GB free on an 8 TB data disk) only off the protected fs', () => {
      // Measured on papercusp-public-site run 05385367 (2026-10-03 08:50Z):
      // need=9138462720 avail=165755830272 reserve=159988524482 (2% of total).
      const incident = (sameFs: '0' | '1') => ({
        DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES: '165755830272',
        DEPENDENCY_GENERATION_HEADROOM_TOTAL_BYTES: '7999426224100',
        DEPENDENCY_GENERATION_HEADROOM_RESERVE_PCT: '2',
        DEPENDENCY_GENERATION_HEADROOM_MARGIN_BYTES: '10737418240',
        // The 20 GiB other-fs cap is deliberately left at its default.
        DEPENDENCY_GENERATION_HEADROOM_OTHER_FS_RESERVE_CAP_BYTES: '',
        DEPENDENCY_GENERATION_HEADROOM_SAME_FS: sameFs,
      });
      const { root, generation, source } = copyFixture();
      writeFileSync(join(generation, '.tree-bytes'), 'node_modules\t9138462720\n');
      const check = 'rc=0; dependency_generation_check_headroom "$SOURCE" "$DEST" || rc=$?; echo "RC=$rc"';
      const dest = join(root, 'out/node_modules');
      mkdirSync(join(root, 'out'), { recursive: true });
      const dataDisk = runShell(check, { ...incident('0'), SOURCE: source, DEST: dest });
      expect(dataDisk.stdout, dataDisk.stderr).toContain('RC=0');
      const protectedFs = runShell(check, { ...incident('1'), SOURCE: source, DEST: dest });
      expect(protectedFs.stdout, protectedFs.stderr).toContain('RC=77');
      expect(protectedFs.stderr).toContain('reserve=159988524482 reserve_scope=protected-fs');
    }, NATIVE_SHELL_TIMEOUT_MS);

    it('compares real devices, and treats an unknown protected path as protected', () => {
      const { root } = copyFixture();
      const probe = (protectedPath: string, dir: string) =>
        runShell(
          'rc=0; dependency_generation_on_reserve_fs "$DIR" || rc=$?; echo "RC=$rc"',
          { DEPENDENCY_GENERATION_RESERVE_FS_PATH: protectedPath, DIR: dir },
        ).stdout.trim();
      expect(probe(root, join(root, 'generation'))).toBe('RC=0');
      // procfs is always a distinct device from a tmpdir.
      expect(probe(root, '/proc')).toBe('RC=1');
      expect(probe('', '/proc')).toBe('RC=0');
      expect(probe(join(root, 'does-not-exist'), '/proc')).toBe('RC=0');
    }, NATIVE_SHELL_TIMEOUT_MS);

    it('a sourced caller starts unscoped, and main records the integration root', () => {
      const { root } = copyFixture();
      const result = runShell(
        [
          'echo "BEFORE=[$DEPENDENCY_GENERATION_RESERVE_FS_PATH]"',
          'rc=0; dependency_generation_main --integration "$ROOT" --generation-root "$ROOT/no-store" --prune-only || rc=$?',
          'echo "RC=$rc AFTER=[$DEPENDENCY_GENERATION_RESERVE_FS_PATH]"',
        ].join('\n'),
        { ROOT: root, DEPENDENCY_GENERATION_RESERVE_FS_PATH: '' },
      );
      const real = realpathSync(root);
      expect(result.stdout, result.stderr).toContain('BEFORE=[]');
      expect(result.stdout, result.stderr).toContain(`RC=0 AFTER=[${real}]`);
    }, NATIVE_SHELL_TIMEOUT_MS);

    // WI-10006767: setup-release-checkout sources this script and calls
    // dependency_generation_ensure directly, so main never ran and the reserve
    // stayed fail-closed (160 GB on the 8 TB data disk) for every build.
    it('record_reserve_fs records the physical root once and stays empty for an unresolvable one', () => {
      const { root } = copyFixture();
      mkdirSync(join(root, 'real'));
      symlinkSync(join(root, 'real'), join(root, 'link'));
      const result = runShell(
        [
          'dependency_generation_record_reserve_fs "$ROOT/link"',
          'echo "FIRST=[$DEPENDENCY_GENERATION_RESERVE_FS_PATH]"',
          'dependency_generation_record_reserve_fs /proc',
          'echo "KEPT=[$DEPENDENCY_GENERATION_RESERVE_FS_PATH]"',
          'DEPENDENCY_GENERATION_RESERVE_FS_PATH=""',
          'dependency_generation_record_reserve_fs "$ROOT/missing"',
          'echo "MISSING=[$DEPENDENCY_GENERATION_RESERVE_FS_PATH]"',
        ].join('\n'),
        { ROOT: root, DEPENDENCY_GENERATION_RESERVE_FS_PATH: '' },
      );
      const real = realpathSync(join(root, 'real'));
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`FIRST=[${real}]`);
      expect(result.stdout).toContain(`KEPT=[${real}]`);
      expect(result.stdout).toContain('MISSING=[]');
    }, NATIVE_SHELL_TIMEOUT_MS);

    it('a sourced dependency_generation_ensure records the integration root (WI-10006767)', () => {
      const integration = makeIntegration();
      const result = runShell(
        [
          'echo "BEFORE=[$DEPENDENCY_GENERATION_RESERVE_FS_PATH]"',
          'dependency_generation_configure_workspace_dirs "$ROOT"',
          'dependency_generation_ensure "$ROOT" "$ROOT/.papercusp/dependency-generations"',
          'echo "AFTER=[$DEPENDENCY_GENERATION_RESERVE_FS_PATH]"',
        ].join('\n'),
        { ROOT: integration, DEPENDENCY_GENERATION_RESERVE_FS_PATH: '' },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('BEFORE=[]');
      expect(result.stdout).toContain(`AFTER=[${realpathSync(integration)}]`);
    }, NATIVE_SHELL_TIMEOUT_MS);
  });

  it('materialize_tree propagates the typed headroom exit instead of a generic mv error', () => {
    const { root, source } = copyFixture();
    const dest = join(root, 'checkout/node_modules');
    const result = runShell(
      'rc=0; dependency_generation_materialize_tree "$SOURCE" "$DEST" || rc=$?; echo "RC=$rc"',
      { ...fs(10), SOURCE: source, DEST: dest },
    );
    expect(result.stdout, result.stderr).toContain('RC=77');
    expect(existsSync(dest)).toBe(false);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('times out with exit 76 while another process holds the host copy lock', async () => {
    const { root, source } = copyFixture();
    const lock = join(root, 'copy.lock');
    writeFileSync(`${lock}.holder`, 'pid=4242 op=copy fixture since=0\n');
    // Detached: the lock is held by the open file description, which `sleep`
    // inherits from flock, so release needs the whole process group killed.
    const holder = spawn('flock', [lock, 'sleep', '30'], { stdio: 'ignore', detached: true });
    const exited = new Promise((r) => holder.once('exit', r));
    try {
      // Wait until the holder actually owns the lock.
      for (let i = 0; i < 100; i++) {
        const probe = spawnSync('flock', ['-n', lock, 'true']);
        if (probe.status !== 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const result = runShell('dependency_generation_copy_independent "$SOURCE" "$DEST"', {
        SOURCE: source,
        DEST: join(root, 'out/node_modules'),
        DEPENDENCY_GENERATION_COPY_LOCK_FILE: lock,
        DEPENDENCY_GENERATION_COPY_LOCK_TIMEOUT_SEC: '1',
      });
      expect(result.status, result.stderr).toBe(76);
      expect(result.stderr).toContain('DEPENDENCY_GENERATION_LOCK_TIMEOUT');
      expect(result.stderr).toContain('holder=pid=4242');
      expect(existsSync(join(root, 'out/node_modules'))).toBe(false);
    } finally {
      try {
        process.kill(-(holder.pid as number), 'SIGKILL');
      } catch {
        holder.kill('SIGKILL');
      }
    }
    // Once released, the same copy succeeds and records itself as the holder.
    await exited;
    for (let i = 0; i < 100; i++) {
      if (spawnSync('flock', ['-n', lock, 'true']).status === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const after = runShell('dependency_generation_copy_independent "$SOURCE" "$DEST"', {
      SOURCE: source,
      DEST: join(root, 'out/node_modules'),
      DEPENDENCY_GENERATION_COPY_LOCK_FILE: lock,
      DEPENDENCY_GENERATION_COPY_LOCK_TIMEOUT_SEC: '1',
    });
    expect(after.status, after.stderr).toBe(0);
    expect(readFileSync(`${lock}.holder`, 'utf8')).toMatch(/^pid=\d+ op=copy /);
  }, NATIVE_SHELL_TIMEOUT_MS);

  // WI-10004928 part 6: the timeout is a STALL budget. A waiter behind a holder
  // whose process subtree keeps doing I/O keeps waiting past it; a silent live
  // holder still times out, and nothing waits past the hard cap.
  async function holdLock(lock: string, workFile: string, script: string) {
    const holder = spawn(
      'flock',
      [lock, 'bash', '-c', `printf 'pid=%s op=fixture since=0\\n' "$$" > "$LOCK.holder"; ${script}`],
      { stdio: 'ignore', detached: true, env: { ...process.env, LOCK: lock, WORK: workFile } },
    );
    const exited = new Promise((r) => holder.once('exit', r));
    for (let i = 0; i < 100; i++) {
      if (spawnSync('flock', ['-n', lock, 'true']).status !== 0 && existsSync(`${lock}.holder`)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const kill = () => {
      try {
        process.kill(-(holder.pid as number), 'SIGKILL');
      } catch {
        holder.kill('SIGKILL');
      }
    };
    return { exited, kill };
  }

  const waitEnv = (lock: string, extra: Record<string, string>) => ({
    DEPENDENCY_GENERATION_COPY_LOCK_FILE: lock,
    DEPENDENCY_GENERATION_COPY_LOCK_SAMPLE_SEC: '0',
    ...extra,
  });

  it('acquires a lock released while the progress sample becomes unmeasurable', async () => {
    const { root } = copyFixture();
    const lock = join(root, 'released-during-sample.lock');
    const release = join(root, 'release-holder');
    const held = await holdLock(
      lock,
      release,
      'while [ ! -e "$WORK" ]; do sleep 0.02; done',
    );
    try {
      // The first sample starts the stall clock. The second explicitly releases
      // the holder and waits for the real lock to become free before returning
      // no measurement, as /proc does when the sampled holder has exited.
      const result = runShell(
        [
          'dependency_generation_subtree_io() {',
          '  if [ ! -e "$FIRST_SAMPLE" ]; then',
          '    touch "$FIRST_SAMPLE"',
          '    sleep 1.1',
          "    printf '0\\n'",
          '  else',
          '    touch "$WORK"',
          '    while ! flock -n "$DEPENDENCY_GENERATION_COPY_LOCK_FILE" true; do sleep 0.02; done',
          '  fi',
          '}',
          'dependency_generation_acquire_copy_lock waiter && echo ACQUIRED',
        ].join('\n'),
        waitEnv(lock, {
          WORK: release,
          FIRST_SAMPLE: join(root, 'first-sample'),
          DEPENDENCY_GENERATION_COPY_LOCK_TIMEOUT_SEC: '1',
        }),
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('ACQUIRED');
      expect(result.stderr).not.toContain('DEPENDENCY_GENERATION_LOCK_TIMEOUT');
    } finally {
      held.kill();
    }
    await held.exited;
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('keeps waiting past the stall budget while the holder is making progress', async () => {
    const { root } = copyFixture();
    const lock = join(root, 'progress.lock');
    const held = await holdLock(
      lock,
      join(root, 'work'),
      'for i in $(seq 1 60); do printf "%04096d" 0 >> "$WORK"; sleep 0.1; done',
    );
    try {
      const started = Date.now();
      // A 2s budget, not 1s: one sample of a busy host's process table can take
      // most of a second, and progress needs two samples to be seen at all.
      const result = runShell(
        'dependency_generation_acquire_copy_lock waiter && echo ACQUIRED',
        waitEnv(lock, { DEPENDENCY_GENERATION_COPY_LOCK_TIMEOUT_SEC: '2' }),
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('ACQUIRED');
      expect(result.stderr).not.toContain('DEPENDENCY_GENERATION_LOCK_TIMEOUT');
      // The holder ran ~6s, well past the 2s stall budget.
      expect(Date.now() - started).toBeGreaterThan(4000);
    } finally {
      held.kill();
    }
    await held.exited;
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('relays measured copy progress when the waiter cannot see the holder process namespace', async () => {
    const { root } = copyFixture();
    const lock = join(root, 'namespace-progress.lock');
    let holderOutput = '';
    let result: ShellResult | undefined;
    const holder = spawn('bash', ['-c', [
      'source "$LIB"',
      'dependency_generation_acquire_copy_lock fixture || exit $?',
      'trap dependency_generation_release_copy_lock EXIT',
      // Real writes in the holder remain measurable; only the waiter loses /proc visibility.
      // WI-6554700010018107: the real call is `cp -a "$src" "$dest"`, so the fake writes to its
      // LAST argument. Writing to "$2" appended to the source path `ignored` in the test's cwd
      // (apps/operator), which git-sync committed and the delta check then re-ran.
      'cp() { local dest="${!#}"; for i in $(seq 1 80); do printf "%04096d" 0 >> "$dest"; sleep 0.1; done; }',
      'dependency_generation_copy_with_progress ignored "$WORK"',
    ].join('\n')], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], detached: true, env: {
      ...process.env, LIB: SCRIPT, WORK: join(root, 'copied-bytes'),
      DEPENDENCY_GENERATION_COPY_LOCK_FILE: lock, DEPENDENCY_GENERATION_COPY_PROGRESS_SEC: '1',
    } });
    createTextCollector(holder.stderr, { retainText: false, onDecodedText: text => { holderOutput += text; } });
    const exited = new Promise(resolve => holder.once('exit', resolve));
    try {
      for (let i = 0; i < 100 && !existsSync(`${lock}.holder`); i++)
        await new Promise(resolve => setTimeout(resolve, 50));
      expect(existsSync(`${lock}.holder`)).toBe(true);
      result = runShell([
        'dependency_generation_subtree_io() { return 0; }',
        'dependency_generation_acquire_copy_lock waiter && echo ACQUIRED',
      // Four one-second sampling intervals fit inside this fixture's stall budget.
      // The writer still runs for twice the budget, so the old implementation fails.
      ].join('\n'), waitEnv(lock, { DEPENDENCY_GENERATION_COPY_LOCK_TIMEOUT_SEC: '4' }));
    } finally {
      try { process.kill(-(holder.pid as number), 'SIGKILL'); } catch { holder.kill('SIGKILL'); }
      await exited;
    }
    expect(result?.status, `${result?.stderr}\nholder:\n${holderOutput}`).toBe(0);
    expect(result?.stdout).toContain('ACQUIRED');
    expect(result?.stderr).toMatch(/copy lock progress: .* wait=\d+:\d+ advances=[1-9]/);
    // The holder's writes land in the copy destination, never beside the source in the cwd.
    expect(statSync(join(root, 'copied-bytes')).size).toBeGreaterThan(0);
    expect(existsSync(join(root, 'ignored'))).toBe(false);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('does not turn a repeated holder progress record into progress without process visibility', async () => {
    const { root } = copyFixture();
    const lock = join(root, 'namespace-stalled.lock');
    const held = await holdLock(lock, join(root, 'work'), 'echo progress=copy:1:1:1024:0 >> "$LOCK.holder"; sleep 30');
    try {
      const result = runShell([
        'dependency_generation_subtree_io() { return 0; }',
        'dependency_generation_acquire_copy_lock waiter',
      ].join('\n'), waitEnv(lock, { DEPENDENCY_GENERATION_COPY_LOCK_TIMEOUT_SEC: '1' }));
      expect(result.status, result.stderr).toBe(76);
      expect(result.stderr).toMatch(/DEPENDENCY_GENERATION_LOCK_TIMEOUT .*reason=stalled/);
    } finally {
      held.kill();
      await held.exited;
    }
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('times out reason=stalled behind a live holder that does no I/O', async () => {
    const { root } = copyFixture();
    const lock = join(root, 'stalled.lock');
    const held = await holdLock(lock, join(root, 'work'), 'sleep 30');
    try {
      const result = runShell(
        'dependency_generation_acquire_copy_lock waiter',
        waitEnv(lock, { DEPENDENCY_GENERATION_COPY_LOCK_TIMEOUT_SEC: '1' }),
      );
      expect(result.status, result.stderr).toBe(76);
      expect(result.stderr).toMatch(/DEPENDENCY_GENERATION_LOCK_TIMEOUT .*reason=stalled/);
    } finally {
      held.kill();
    }
    await held.exited;
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('never waits past the hard cap, even behind a progressing holder', async () => {
    const { root } = copyFixture();
    const lock = join(root, 'cap.lock');
    const tick = join(root, 'cap-tick');
    writeFileSync(tick, '0\n');
    const held = await holdLock(
      lock,
      join(root, 'work'),
      'sleep 30',
    );
    try {
      // Keep the actual flock held, but make each sample advance both time and
      // measured I/O. Real integer-second boundaries could spend the entire
      // one-second stall budget before the first pair of samples saw progress,
      // testing the stall branch instead of the independent hard cap. The
      // neighboring progress test exercises real holder writes and /proc reads.
      const result = runShell(
        [
          'date() { cat "$TICK"; }',
          'dependency_generation_subtree_io() { cat "$TICK"; }',
          'sleep() { local tick; tick=$(( $(cat "$TICK") + 1 )); printf "%s\\n" "$tick" > "$TICK"; }',
          'dependency_generation_acquire_copy_lock waiter',
        ].join('\n'),
        waitEnv(lock, {
          TICK: tick,
          DEPENDENCY_GENERATION_COPY_LOCK_TIMEOUT_SEC: '1',
          DEPENDENCY_GENERATION_COPY_LOCK_MAX_SEC: '2',
        }),
      );
      expect(result.status, result.stderr).toBe(76);
      expect(result.stderr).toMatch(/copy lock progress: .*advances=2/);
      expect(result.stderr).toMatch(/DEPENDENCY_GENERATION_LOCK_TIMEOUT waited=2s idle=0s .*reason=cap/);
      expect(readFileSync(tick, 'utf8')).toBe('2\n');
      expect(spawnSync('flock', ['-n', lock, 'true']).status).toBe(1);
    } finally {
      held.kill();
    }
    await held.exited;
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('the lock is re-entrant within one process', () => {
    const { root } = copyFixture();
    const result = runShell(
      [
        'dependency_generation_acquire_copy_lock outer',
        'dependency_generation_acquire_copy_lock inner',
        'dependency_generation_release_copy_lock',
        'echo "DEPTH=$DEPENDENCY_GENERATION_COPY_LOCK_DEPTH"',
        'dependency_generation_release_copy_lock',
        'echo "DEPTH=$DEPENDENCY_GENERATION_COPY_LOCK_DEPTH"',
        'flock -n "$DEPENDENCY_GENERATION_COPY_LOCK_FILE" true && echo FREE',
      ].join('\n'),
      { DEPENDENCY_GENERATION_COPY_LOCK_FILE: join(root, 'reentrant.lock') },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('DEPTH=1\nDEPTH=0\nFREE\n');
  });

  it('a published generation records every tree size in .tree-bytes', () => {
    const integration = makeIntegration();
    const result = publish(integration);
    expect(result.status, result.stderr).toBe(0);
    const generation = publishedPath(result.stdout);
    const lines = readFileSync(join(generation, '.tree-bytes'), 'utf8').trim().split('\n');
    const rels = lines.map((line) => line.split('\t')[0]).sort();
    expect(rels).toEqual(
      ['node_modules', 'packages/a/node_modules', 'packages/b/node_modules'].sort(),
    );
    for (const line of lines) expect(line).toMatch(/^[^\t]+\t[1-9]\d*$/);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('a publish refused for headroom exits 77 and publishes nothing', () => {
    const integration = makeIntegration();
    const generationRoot = join(dirname(integration), 'generations');
    const result = publish(integration, fs(10), generationRoot);
    expect(result.status, result.stderr).toBe(77);
    expect(result.stderr).toContain('DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT');
  }, NATIVE_SHELL_TIMEOUT_MS);
});

// P-012 (WI-10004927): a changed tree is rebuilt from the predecessor's copy plus
// the paths whose live source record changed, instead of one full copy.
describe('P-012: incremental copy of a changed dependency tree', () => {
  const incrementalEnv = (racyWindowSec: string): NodeJS.ProcessEnv => ({
    DEPENDENCY_GENERATION_WALK_JOBS: '1',
    DEPENDENCY_GENERATION_RACY_WINDOW_SEC: racyWindowSec,
    // The fixture filesystem may lack reflink. Plain copy seeding runs the same
    // delta and verification logic everywhere.
    DEPENDENCY_GENERATION_INCREMENTAL_SEED_REFLINK: 'auto',
  });
  const npmEpoch = new Date('1985-10-26T08:15:00Z');

  // Everything a consumer of the tree can observe, with write bits ignored
  // because a published generation freezes its files read-only.
  function treeContents(root: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (rel: string): void => {
      for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        const path = join(root, child);
        if (entry.isSymbolicLink()) {
          out[child] = `link:${readlinkSync(path)}`;
        } else if (entry.isDirectory()) {
          out[child] = `dir:${(statSync(path).mode & 0o777).toString(8)}`;
          walk(child);
        } else {
          const stat = statSync(path);
          out[child] =
            `file:${(stat.mode & 0o555).toString(8)}:${stat.mtimeMs}:` +
            readFileSync(path, 'utf8');
        }
      }
    };
    walk('');
    return out;
  }

  function sourceRecords(generation: string, rel: string) {
    const recordsDir = join(generation, '.source-records');
    const indexPath = join(recordsDir, 'index');
    const lines = readFileSync(indexPath, 'utf8').trim().split('\n');
    const row = lines.findIndex((line) => line.startsWith(`${rel}\t`));
    expect(row, `no stored records for ${rel}`).toBeGreaterThanOrEqual(0);
    const key = lines[row].split('\t')[2];
    const gz = join(recordsDir, `${key}.gz`);
    return { indexPath, lines, row, key, gz };
  }

  it(
    'copies only changed paths and catches a same-size, same-mtime rewrite by ctime',
    () => {
      const integration = makeIntegration();
      const pkg = join(integration, 'node_modules/pkg');
      for (let i = 0; i < 20; i += 1) {
        writeFileSync(join(pkg, `f${i}.js`), `v1-${i}\n`);
        utimesSync(join(pkg, `f${i}.js`), npmEpoch, npmEpoch);
      }
      symlinkSync('index.js', join(pkg, 'link.js'));
      mkdirSync(join(integration, 'node_modules/gone'));
      writeFileSync(join(integration, 'node_modules/gone/index.js'), 'gone\n');
      lockFixturePackage(integration, 'node_modules/gone', true);

      const first = publish(integration, incrementalEnv('0'));
      expect(first.status, first.stderr).toBe(0);
      const firstPath = publishedPath(first.stdout);
      expect(
        readFileSync(join(firstPath, '.source-records/index'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => line.split('\t')[0])
          .sort(),
      ).toEqual(['node_modules', 'packages/a/node_modules', 'packages/b/node_modules']);

      // npm rewrites a package file with the same size and its fixed tarball
      // mtime. Only the inode and ctime can show that the bytes changed.
      writeFileSync(join(pkg, 'f0.js'), 'v2-0\n');
      utimesSync(join(pkg, 'f0.js'), npmEpoch, npmEpoch);
      writeFileSync(join(pkg, 'new.js'), 'new\n');
      rmSync(join(integration, 'node_modules/gone'), { recursive: true });

      const second = publish(integration, incrementalEnv('0'));
      expect(second.status, second.stderr).toBe(0);
      expect(lastSummary(second)).toMatchObject({
        result: 'published',
        trees_reused: '2',
        trees_copied: '1',
        trees_incremental: '1',
      });
      expect(telemetryRecords(second.stderr, 'INCREMENTAL')).toEqual([
        {
          schema: '1',
          tree: 'node_modules',
          // 20 pkg/f*.js siblings + pkg/index.js + pkg/package.json (the locked
          // manifest makeIntegration installs so the lock-vs-tree audit passes).
          kept: '22',
          copied: '2',
          // pkg/link.js plus gone directory, index.js and locked manifest.
          removed: '4',
          copied_bytes: String('v2-0\n'.length + 'new\n'.length),
          // f0.js matched its record except for ctime and inode, so its bytes were
          // compared with the predecessor's copy, found different, and copied.
          verified: '0',
        },
      ]);
      const secondPath = publishedPath(second.stdout);
      expect(treeContents(join(secondPath, 'tree/node_modules'))).toEqual(
        treeContents(join(integration, 'node_modules')),
      );
      expect(
        readFileSync(join(secondPath, 'tree/node_modules/pkg/f0.js'), 'utf8'),
      ).toBe('v2-0\n');
      // Reused files are independent copies, never shared inodes.
      expect(statSync(join(secondPath, 'tree/node_modules/pkg/f1.js')).ino).not.toBe(
        statSync(join(firstPath, 'tree/node_modules/pkg/f1.js')).ino,
      );
      // Reused trees carry their records forward; the rebuilt tree stores new ones.
      expect(
        readFileSync(join(secondPath, '.source-records/index'), 'utf8')
          .trim()
          .split('\n'),
      ).toHaveLength(3);
    },
    NATIVE_SHELL_TIMEOUT_MS,
  );

  it(
    'never trusts a record captured within the racy window: it compares the bytes',
    () => {
      const integration = makeIntegration();
      writeFileSync(join(integration, 'node_modules/pkg/stable.js'), 'stable\n');
      writeFileSync(join(integration, 'node_modules/pkg/racy.js'), 'racy-1\n');
      const first = publish(integration, incrementalEnv('3600'));
      expect(first.status, first.stderr).toBe(0);

      // The predecessor's copy of racy.js holds other bytes of the same size, mode
      // and nanosecond mtime, so the generation still validates and its live
      // record still matches exactly. Only a byte comparison can tell.
      const seeded = join(publishedPath(first.stdout), 'tree/node_modules/pkg/racy.js');
      const timeRef = join(dirname(integration), 'racy-time-ref');
      writeFileSync(timeRef, '');
      execFileSync('touch', ['-r', seeded, timeRef]);
      const frozenMode = statSync(seeded).mode & 0o7777;
      chmodSync(seeded, 0o644);
      writeFileSync(seeded, 'racy-X\n');
      chmodSync(seeded, frozenMode);
      execFileSync('touch', ['-r', timeRef, seeded]);

      writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'root-v2\n');
      const second = publish(integration, incrementalEnv('3600'));
      expect(second.status, second.stderr).toBe(0);
      // Inside the window no record is trusted. stable.js and pkg/package.json are
      // kept because their bytes equal the predecessor's copy; racy.js is copied
      // because they differ.
      expect(telemetryRecords(second.stderr, 'INCREMENTAL')).toMatchObject([
        { tree: 'node_modules', kept: '2', copied: '2', verified: '2' },
      ]);
      const secondTree = join(publishedPath(second.stdout), 'tree/node_modules');
      expect(treeContents(secondTree)).toEqual(treeContents(join(integration, 'node_modules')));
      expect(readFileSync(join(secondTree, 'pkg/racy.js'), 'utf8')).toBe('racy-1\n');
    },
    NATIVE_SHELL_TIMEOUT_MS,
  );

  it(
    'creates a missing nested destination parent before incremental headroom measurement',
    () => {
      const integration = makeIntegration();
      const nestedPkg = join(
        integration,
        'tools/perf-test/wdio/node_modules/pkg',
      );
      mkdirSync(nestedPkg, { recursive: true });
      writeFileSync(join(nestedPkg, 'index.js'), 'v1\n');
      lockFixturePackage(integration, 'tools/perf-test/wdio/node_modules/pkg');
      const env = {
        ...incrementalEnv('0'),
        DEPENDENCY_GENERATION_HEADROOM_RESERVE_PCT: '0',
        DEPENDENCY_GENERATION_HEADROOM_MARGIN_BYTES: '0',
      };

      const first = publish(integration, env);
      expect(first.status, first.stderr).toBe(0);

      writeFileSync(join(nestedPkg, 'index.js'), 'v2\n');
      const second = publish(integration, env);
      expect(second.status, second.stderr).toBe(0);
      expect(second.stderr).not.toContain(
        'DEPENDENCY_GENERATION_HEADROOM_UNMEASURED',
      );
      expect(lastSummary(second)).toMatchObject({
        result: 'published',
        trees_incremental: '1',
      });
      expect(
        readFileSync(
          join(
            publishedPath(second.stdout),
            'tree/tools/perf-test/wdio/node_modules/pkg/index.js',
          ),
          'utf8',
        ),
      ).toBe('v2\n');
    },
    NATIVE_SHELL_TIMEOUT_MS,
  );

  it(
    'reuses files whose only change is ctime from a hard-linked sibling checkout',
    () => {
      const integration = makeIntegration();
      const pkg = join(integration, 'node_modules/pkg');
      for (let i = 0; i < 10; i += 1) {
        writeFileSync(join(pkg, `f${i}.js`), `v1-${i}\n`);
        utimesSync(join(pkg, `f${i}.js`), npmEpoch, npmEpoch);
      }
      const first = publish(integration, incrementalEnv('0'));
      expect(first.status, first.stderr).toBe(0);

      // A staging refresh hard-links every source file into a sibling checkout and
      // later removes the old links. Every ctime moves; no byte changes.
      const sibling = join(dirname(integration), 'staging-links');
      mkdirSync(sibling);
      const files = readdirSync(pkg).filter((name) => statSync(join(pkg, name)).isFile());
      for (const name of files) linkSync(join(pkg, name), join(sibling, name));
      rmSync(sibling, { recursive: true });
      // One real change, so the tree is rebuilt at all.
      writeFileSync(join(pkg, 'f9.js'), 'v2-9-longer\n');

      const second = publish(integration, incrementalEnv('0'));
      expect(second.status, second.stderr).toBe(0);
      const [record] = telemetryRecords(second.stderr, 'INCREMENTAL');
      // Before D-018 every churned file failed the exact match and was copied.
      expect(record).toMatchObject({
        tree: 'node_modules',
        kept: String(files.length - 1),
        copied: '1',
        verified: String(files.length - 1),
        copied_bytes: String('v2-9-longer\n'.length),
      });
      expect(
        treeContents(join(publishedPath(second.stdout), 'tree/node_modules')),
      ).toEqual(treeContents(join(integration, 'node_modules')));
    },
    NATIVE_SHELL_TIMEOUT_MS,
  );

  it(
    'falls back to a full copy when the incremental result does not reproduce the live tree',
    () => {
      const integration = makeIntegration();
      const first = publish(integration, incrementalEnv('0'));
      expect(first.status, first.stderr).toBe(0);
      const firstPath = publishedPath(first.stdout);

      // Forge a stored record for a directory the predecessor never copied, so
      // the delta wrongly keeps it. Only the verification step can notice.
      mkdirSync(join(integration, 'node_modules/pkg/sub'));
      const forged = execFileSync(
        'find',
        [
          '.',
          '-mindepth',
          '1',
          '-path',
          './pkg/sub',
          '-printf',
          '%P\\t%y\\t%m\\t%U\\t%G\\t%s\\t%T@\\t%i\\t%C@\\t%l\\n',
        ],
        { cwd: join(integration, 'node_modules'), encoding: 'utf8' },
        // Keep the trailing tab: the empty link-target field is the 10th field.
      ).replace(/\n$/, '');
      expect(forged.startsWith('pkg/sub\td\t')).toBe(true);
      const { indexPath, lines, row, key, gz } = sourceRecords(firstPath, 'node_modules');
      const records = gunzipSync(readFileSync(gz)).toString('utf8').split('\n').filter(Boolean);
      chmodSync(gz, 0o644);
      writeFileSync(gz, gzipSync(Buffer.from(`${[...records, forged].sort().join('\n')}\n`)));
      // Move the capture time past the forged ctime so the record is trusted.
      const futureNs = String(BigInt(Date.now() + 60_000) * 1_000_000n);
      lines[row] = [
        'node_modules',
        futureNs,
        key,
        createHash('sha256').update(readFileSync(gz)).digest('hex'),
      ].join('\t');
      writeFileSync(indexPath, `${lines.join('\n')}\n`);

      const second = publish(integration, incrementalEnv('0'));
      expect(second.status, second.stderr).toBe(0);
      expect(second.stderr).toContain(
        'incremental copy of node_modules did not reproduce the live tree',
      );
      expect(lastSummary(second)).toMatchObject({
        trees_copied: '1',
        trees_incremental: '0',
      });
      expect(
        treeContents(join(publishedPath(second.stdout), 'tree/node_modules')),
      ).toEqual(treeContents(join(integration, 'node_modules')));
    },
    NATIVE_SHELL_TIMEOUT_MS,
  );

  it(
    'ignores stored records whose digest no longer matches',
    () => {
      const integration = makeIntegration();
      const first = publish(integration, incrementalEnv('0'));
      expect(first.status, first.stderr).toBe(0);
      const { gz } = sourceRecords(publishedPath(first.stdout), 'node_modules');
      chmodSync(gz, 0o644);
      writeFileSync(gz, Buffer.concat([readFileSync(gz), Buffer.from('tampered')]));

      writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'root-v2\n');
      const second = publish(integration, incrementalEnv('0'));
      expect(second.status, second.stderr).toBe(0);
      expect(telemetryRecords(second.stderr, 'INCREMENTAL')).toEqual([]);
      expect(lastSummary(second)).toMatchObject({
        trees_copied: '1',
        trees_incremental: '0',
      });
      expect(
        readFileSync(
          join(publishedPath(second.stdout), 'tree/node_modules/pkg/index.js'),
          'utf8',
        ),
      ).toBe('root-v2\n');
    },
    NATIVE_SHELL_TIMEOUT_MS,
  );

  // D-019: every repository's gate shares one generation root, and a full-scope
  // build has the same closure fingerprint everywhere. Live, papercusp's 07:09Z
  // build picked a newer 7-tree generation from ANOTHER repository and reused
  // 0 of 95 trees while its own previous generation sat unused.
  it(
    'prefers its own layout over a newer generation from another repository in a shared root',
    () => {
      const sharedRoot = mkdtempSync(join(tmpdir(), 'dependency-generation-shared-'));
      roots.push(sharedRoot);
      const env = { ...incrementalEnv('0'), DEPENDENCY_GENERATION_RETAIN_COUNT: '10' };

      const own = makeIntegration();
      const first = publish(own, env, sharedRoot);
      expect(first.status, first.stderr).toBe(0);
      const ownIdentity = publishedPath(first.stdout).split('/').pop();

      // Another repository: only the root tree path is shared, with other bytes.
      const foreign = makeIntegration();
      rmSync(join(foreign, 'packages'), { recursive: true });
      mkdirSync(join(foreign, 'apps/other/node_modules/x'), { recursive: true });
      writeFileSync(join(foreign, 'apps/other/node_modules/x/index.js'), 'x-v1\n');
      lockFixturePackage(foreign, 'apps/other/node_modules/x');
      const foreignLock = JSON.parse(readFileSync(join(foreign, 'package-lock.json'), 'utf8'));
      delete foreignLock.packages['packages/a/node_modules/local'];
      delete foreignLock.packages['packages/b/node_modules/other'];
      writeFileSync(join(foreign, 'package-lock.json'), JSON.stringify(foreignLock) + '\n');
      writeFileSync(join(foreign, 'node_modules/pkg/index.js'), 'foreign-root\n');
      const foreignBuild = publish(foreign, env, sharedRoot);
      expect(foreignBuild.status, foreignBuild.stderr).toBe(0);
      const foreignIdentity = publishedPath(foreignBuild.stdout).split('/').pop();
      expect(foreignIdentity).not.toBe(ownIdentity);

      writeFileSync(join(own, 'packages/a/node_modules/local/index.js'), 'local-v2\n');
      const second = publish(own, env, sharedRoot);
      expect(second.status, second.stderr).toBe(0);
      expect(lastSummary(second)).toMatchObject({
        result: 'published',
        predecessor: ownIdentity,
        trees_reused: '2',
        trees_copied: '1',
      });
      expect(second.stderr).toContain(
        `selected reusable immutable predecessor ${ownIdentity} (identical_trees=2 shared_trees=3)`,
      );
    },
    NATIVE_SHELL_TIMEOUT_MS,
  );
});

// WI-10007424 (green-main-cycle-time P-003): the gate's up-front disk preflight
// asks the script itself, so a run refuses BEFORE setup with the same typed exit
// 77 the copy path uses, instead of passing the alarm's smaller floor and then
// dying mid-materialization (WI-10005705: avail 43.7G, required 51.0G).
describe('WI-10007424: --check-headroom is the copy path\'s own reserve, measured up front', () => {
  const GIB = 1024 ** 3;
  const runCheck = (integration: string, env: Record<string, string>, extra: string[] = []) =>
    spawnSync('bash', [SCRIPT, '--integration', integration, '--check-headroom', ...extra], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DEPENDENCY_GENERATION_RESERVE_FS_PATH: '',
        DEPENDENCY_GENERATION_HEADROOM_SAME_FS: '1',
        DEPENDENCY_GENERATION_HEADROOM_TOTAL_BYTES: String(1900 * GIB),
        // dependency-copy-isolation.setup-vitest.ts zeroes both for ordinary fixtures;
        // this suite measures the production reserve, so restore its defaults.
        DEPENDENCY_GENERATION_HEADROOM_RESERVE_PCT: '2',
        DEPENDENCY_GENERATION_HEADROOM_MARGIN_BYTES: String(10 * GIB),
        ...env,
      },
      timeout: NATIVE_SHELL_TIMEOUT_MS,
    });
  const freshIntegration = () => {
    const parent = mkdtempSync(join(tmpdir(), 'dependency-generation-headroom-'));
    roots.push(parent);
    const integration = join(parent, 'integration');
    mkdirSync(integration);
    return integration;
  };
  const statProbe = (parent: string) => {
    const bin = join(parent, 'fake-bin');
    const capture = join(parent, 'stat-paths');
    mkdirSync(bin);
    const fakeStat = join(bin, 'stat');
    writeFileSync(fakeStat, [
      '#!/usr/bin/env bash',
      'printf \'%s\\n\' "$4" >> "$STAT_CAPTURE"',
      'case "$3" in',
      '  \'%b %S\') printf \'8000 1073741824\\n\' ;;',
      '  \'%a %S\') printf \'60 1073741824\\n\' ;;',
      '  *) exit 2 ;;',
      'esac',
    ].join('\n'));
    chmodSync(fakeStat, 0o755);
    return { capture, env: { PATH: `${bin}:${process.env.PATH ?? ''}`, STAT_CAPTURE: capture } };
  };

  it('measures the configured generation store through its existing ancestor without creating or recording it', () => {
    const integration = freshIntegration();
    const parent = dirname(integration);
    const generationParent = join(parent, 'generation-store');
    mkdirSync(generationParent);
    const generationRoot = join(generationParent, 'new-generations');
    const probe = statProbe(parent);
    const result = runCheck(integration, {
      ...probe.env,
      PAPERCUSP_DEPENDENCY_GENERATION_ROOT: generationRoot,
      DEPENDENCY_GENERATION_HEADROOM_SAME_FS: '0',
      DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES: '',
      DEPENDENCY_GENERATION_HEADROOM_TOTAL_BYTES: '',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      `reserve=21474836480 reserve_scope=other-fs margin=10737418240 required=32212254720 size=unknown path=${generationRoot}/.dependency-generation-headroom-check`,
    );
    expect(readFileSync(probe.capture, 'utf8').trim().split('\n')).toEqual([
      generationParent,
      generationParent,
    ]);
    expect(existsSync(generationRoot)).toBe(false);
    expect(existsSync(join(integration, '.papercusp/dependency-generation-root'))).toBe(false);
    expect(readdirSync(integration)).toEqual([]);
  });

  it('follows a recorded generation store when the gate process has no environment override', () => {
    const integration = freshIntegration();
    const parent = dirname(integration);
    const generationRoot = join(parent, 'recorded-generations');
    mkdirSync(generationRoot);
    const record = join(integration, '.papercusp/dependency-generation-root');
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, `${generationRoot}\n`);
    const probe = statProbe(parent);
    const result = runCheck(integration, {
      ...probe.env,
      PAPERCUSP_DEPENDENCY_GENERATION_ROOT: '',
      DEPENDENCY_GENERATION_HEADROOM_SAME_FS: '0',
      DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES: '',
      DEPENDENCY_GENERATION_HEADROOM_TOTAL_BYTES: '',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(`path=${generationRoot}/.dependency-generation-headroom-check`);
    expect(readFileSync(probe.capture, 'utf8').trim().split('\n')).toEqual([
      generationRoot,
      generationRoot,
    ]);
    expect(readFileSync(record, 'utf8')).toBe(`${generationRoot}\n`);
    expect(readdirSync(generationRoot)).toEqual([]);
  });

  it('refuses with exit 77 in the band the gate alarm used to admit (above 2%, below 2% + margin)', () => {
    const integration = freshIntegration();
    // 45 GiB free on a 1900 GiB root: above the alarm's 38 GiB floor, below 38 + 10 GiB.
    const result = runCheck(integration, {
      DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES: String(45 * GIB),
    });
    expect(result.status).toBe(77);
    expect(result.stderr).toMatch(
      /DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT need=0 avail=\d+ reserve=\d+ reserve_scope=protected-fs margin=10737418240 required=\d+ size=unknown/,
    );
    // A pure measurement: nothing is created beside the integration root.
    expect(readdirSync(integration)).toEqual([]);
  });

  it('admits with exit 0 and reports the same numbers when free space covers reserve + margin', () => {
    const integration = freshIntegration();
    const result = runCheck(integration, {
      DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES: String(60 * GIB),
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/DEPENDENCY_GENERATION_HEADROOM_OK need=0 avail=\d+ .*required=\d+/);
    expect(readdirSync(integration)).toEqual([]);
  });

  it('never reaps: a dead copy sibling survives a refusing check', () => {
    const integration = freshIntegration();
    const sibling = join(integration, '.dependency-generation-headroom-check.deploy-tmp.99999999');
    mkdirSync(sibling);
    const result = runCheck(integration, {
      DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES: String(1 * GIB),
    });
    expect(result.status).toBe(77);
    expect(existsSync(sibling)).toBe(true);
  });

  it('cannot be combined with another mode', () => {
    const integration = freshIntegration();
    const result = runCheck(integration, {}, ['--prune-only']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--check-headroom cannot be combined');
  });
});

// green-main-cycle-time P-022: the same up-front preflight also answers the host
// dependency-copy lock, so a run that can only fail on it refuses BEFORE setup. A
// busy lock behind a HEALTHY copy is reported and never refused: the copy path waits
// behind it on a stall budget and then proceeds, so a refusal would lose a round
// that the wait would have won.
describe('P-022: --check-headroom probes the host dependency-copy lock before setup', () => {
  const GIB = 1024 ** 3;
  const holders: Array<ReturnType<typeof spawn>> = [];
  afterEach(() => {
    for (const holder of holders.splice(0)) holder.kill('SIGKILL');
  });
  const fresh = () => {
    const parent = mkdtempSync(join(tmpdir(), 'dependency-generation-lock-probe-'));
    roots.push(parent);
    const integration = join(parent, 'integration');
    mkdirSync(integration);
    return { integration, lock: join(parent, 'copy.lock') };
  };
  const runCheck = (integration: string, lock: string, env: Record<string, string> = {}) =>
    spawnSync('bash', [SCRIPT, '--integration', integration, '--check-headroom'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DEPENDENCY_GENERATION_RESERVE_FS_PATH: '',
        DEPENDENCY_GENERATION_HEADROOM_SAME_FS: '1',
        DEPENDENCY_GENERATION_HEADROOM_TOTAL_BYTES: String(1900 * GIB),
        DEPENDENCY_GENERATION_HEADROOM_RESERVE_PCT: '2',
        DEPENDENCY_GENERATION_HEADROOM_MARGIN_BYTES: String(10 * GIB),
        DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES: String(60 * GIB),
        DEPENDENCY_GENERATION_COPY_LOCK_FILE: lock,
        ...env,
      },
      timeout: NATIVE_SHELL_TIMEOUT_MS,
    });
  /** Holds the copy lock exactly the way the copy path does (flock on an append fd). */
  const holdLock = async (lock: string) => {
    const child = spawn('bash', ['-c', 'exec 9>>"$1"; flock 9; echo locked; exec sleep 120', 'hold', lock], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    holders.push(child);
    await new Promise<void>((resolveLocked, reject) => {
      child.stdout!.on('data', (chunk) => {
        if (String(chunk).includes('locked')) resolveLocked();
      });
      child.once('exit', (code) => reject(new Error(`lock holder exited early (${code})`)));
    });
  };
  const writeHolder = (lock: string, pid: number, heldSec: number) => {
    const since = Math.floor(Date.now() / 1000) - heldSec;
    writeFileSync(`${lock}.holder`, `pid=${pid} op=copy packages/a since=${since}\n`);
  };
  const deadPid = () => {
    for (let pid = 4_194_000; pid > 1_000; pid -= 7) if (!existsSync(`/proc/${pid}`)) return pid;
    throw new Error('no free pid found');
  };

  it('reports a free lock, keeps the headroom verdict, and never creates the lock file', () => {
    const { integration, lock } = fresh();
    const absent = runCheck(integration, lock);
    expect(absent.status, absent.stderr).toBe(0);
    expect(absent.stderr).toContain('DEPENDENCY_GENERATION_COPY_LOCK state=free');
    expect(absent.stderr).toMatch(/DEPENDENCY_GENERATION_HEADROOM_OK /);
    expect(existsSync(lock)).toBe(false);

    writeFileSync(lock, '');
    const existing = runCheck(integration, lock, {
      DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES: String(45 * GIB),
    });
    // A free lock never masks the headroom refusal.
    expect(existing.status).toBe(77);
    expect(existing.stderr).toContain('DEPENDENCY_GENERATION_COPY_LOCK state=free');
    expect(existsSync(`${lock}.holder`)).toBe(false);
  });

  it('a lock busy behind a live holder younger than the cap is reported, never refused', async () => {
    const { integration, lock } = fresh();
    await holdLock(lock);
    writeHolder(lock, process.pid, 30);
    const before = readFileSync(`${lock}.holder`, 'utf8');
    const result = runCheck(integration, lock);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/DEPENDENCY_GENERATION_COPY_LOCK state=busy held=\d+s max=5400s holder=pid=/);
    expect(result.stderr).toMatch(/DEPENDENCY_GENERATION_HEADROOM_OK /);
    // The probe never rewrites the holder record.
    expect(readFileSync(`${lock}.holder`, 'utf8')).toBe(before);
  });

  it('a live holder past the copy-lock cap is wedged: exit 76 before any headroom measurement', async () => {
    const { integration, lock } = fresh();
    await holdLock(lock);
    writeHolder(lock, process.pid, 6_000);
    const result = runCheck(integration, lock);
    expect(result.status, result.stderr).toBe(76);
    expect(result.stderr).toMatch(/DEPENDENCY_GENERATION_LOCK_BUSY state=wedged held=\d+s max=5400s/);
    expect(result.stderr).not.toContain('DEPENDENCY_GENERATION_HEADROOM_');

    // The cap is the waiter's own DEPENDENCY_GENERATION_COPY_LOCK_MAX_SEC.
    writeHolder(lock, process.pid, 120);
    const tuned = runCheck(integration, lock, { DEPENDENCY_GENERATION_COPY_LOCK_MAX_SEC: '60' });
    expect(tuned.status, tuned.stderr).toBe(76);
    expect(tuned.stderr).toMatch(/state=wedged held=\d+s max=60s/);
  });

  it('a stale holder record (its pid is gone) is busy with unknown age, never wedged', async () => {
    const { integration, lock } = fresh();
    await holdLock(lock);
    // Release never clears the record, so an old record names a former holder.
    writeHolder(lock, deadPid(), 100_000);
    const result = runCheck(integration, lock);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('DEPENDENCY_GENERATION_COPY_LOCK state=busy held=unknown');
  });
});
