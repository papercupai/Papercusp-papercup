import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const sourceRoot = resolve(__dirname, '../../..');
const installerPath = 'apps/operator/scripts/systemd/deploy-hosted-control-plane.sh';
const templatePath = 'apps/operator/scripts/systemd/papercusp-hosted-control-plane.service.in';
const freshnessPath = 'apps/operator/bin/bundle-host-freshness.mjs';
let temp: string;
let repo: string;
let green: string;
let env: NodeJS.ProcessEnv;

function git(...args: string[]) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function install(args: string[] = ['--install-only'], sha = green) {
  return spawnSync('bash', [join(repo, installerPath), ...args, '--production-release', sha], {
    encoding: 'utf8', env, timeout: 15_000,
  });
}

function stamp(root = repo) {
  execFileSync(process.execPath, [join(root, freshnessPath), 'stamp',
    '--repo-root', root, '--entry', join(root, 'apps/operator/bin/serve.ts'),
    '--outfile', join(root, 'apps/operator/dist-hosted-control-plane/serve.mjs'),
    '--manifest', join(root, 'apps/operator/dist-hosted-control-plane/.bundle-fresh.json'),
  ], { stdio: 'pipe' });
}

async function runAsync(args: string[]) {
  try {
    const result = await promisify(execFile)('bash', [join(repo, installerPath), ...args, '--production-release', green],
      { env, timeout: 15_000, encoding: 'utf8' });
    return { status: 0, ...result };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return { status: result.code, stdout: result.stdout, stderr: result.stderr };
  }
}

async function withProbe(body: (path: string) => unknown, run: () => Promise<void>) {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body(request.url!)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP address');
  env.PAPERCUSP_HOSTED_CP_PORT = String(address.port);
  env.PAPERCUSP_HOSTED_CP_HEALTH_ATTEMPTS = '1';
  try { await run(); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

function configureActivation() {
  writeFileSync(join(temp, 'production.env'), [
    'PAPERCUSP_HOSTED_PUBLIC_ORIGIN=https://production.example.test',
    'PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID=production-test',
    'WORKOS_CLIENT_ID=client_test',
    ...['PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF', 'WORKOS_API_KEY_REF', 'WORKOS_COOKIE_PASSWORD_REF', 'WORKOS_WEBHOOK_SECRET_REF']
      .map(name => `${name}=env:TEST_REFERENCE`),
  ].join('\n'));
  // Configuration dereferencing is covered by the existing configuration
  // suite; this seam isolates release activation from the encrypted DB store.
  const bin = join(temp, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  env.PATH = `${bin}:${process.env.PATH}`;
  env.TEST_UNIT_FILE = join(temp, 'units/hosted-production.service');
  env.TEST_SERVING_SHA = join(temp, 'serving-sha');
  writeFileSync(env.PAPERCUSP_HOSTED_CP_SYSTEMCTL!, `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_SYSTEMCTL_LOG"
case "$*" in
  '--user is-active --quiet '* ) test -f "$TEST_SERVING_SHA" ;;
  '--user restart '* )
    sha=$(sed -n 's/^ExecStartPre=.* --production-release \\([0-9a-f]*\\)$/\\1/p' "$TEST_UNIT_FILE")
    [ "$sha" != "$TEST_FAIL_START_SHA" ] || exit 1
    printf '%s' "$sha" > "$TEST_SERVING_SHA" ;;
  '--user stop '* ) rm -f "$TEST_SERVING_SHA" ;;
esac
`, { mode: 0o755 });
}

function servingProbe(path: string) {
  const sha = existsSync(env.TEST_SERVING_SHA!) ? readFileSync(env.TEST_SERVING_SHA!, 'utf8') : null;
  return path === '/api/health'
    ? { ok: true, service: 'papercusp-operator', sha }
    : { ok: sha !== null && sha !== env.TEST_NOT_READY_SHA, ready: sha !== null && sha !== env.TEST_NOT_READY_SHA };
}

function installPreviousRelease() {
  const previousRoot = join(temp, 'previous');
  cpSync(repo, previousRoot, { recursive: true });
  stamp(previousRoot);
  const previousSha = green;
  const result = spawnSync('bash', [join(repo, installerPath), '--install-only', '--production-release', previousSha], {
    encoding: 'utf8', env: { ...env, PAPERCUSP_HOSTED_CP_REPO_ROOT: previousRoot,
      PAPERCUSP_HOSTED_CP_TEMPLATE: join(previousRoot, templatePath) },
  });
  expect(result.status, result.stderr).toBe(0);
  const previousUnit = readFileSync(env.TEST_UNIT_FILE!, 'utf8');
  writeFileSync(env.TEST_SERVING_SHA!, previousSha);
  git('checkout', '-q', 'main');
  writeFileSync(join(repo, 'new-release.txt'), 'candidate\n');
  git('add', 'new-release.txt');
  git('commit', '--no-verify', '-qm', 'next green fixture');
  green = git('rev-parse', 'HEAD');
  git('checkout', '--detach', '-q', green);
  stamp();
  rmSync(join(temp, 'systemctl.log'));
  return { previousSha, previousUnit, previousRoot };
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'hosted-release-'));
  repo = join(temp, 'release');
  mkdirSync(repo);
  for (const path of [installerPath, templatePath, freshnessPath]) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    copyFileSync(join(sourceRoot, path), join(repo, path));
  }
  writeFileSync(join(repo, '.gitignore'), 'apps/operator/dist-hosted-control-plane/\n');
  writeFileSync(join(repo, 'apps/operator/bin/serve.ts'), '// pinned entry\n');
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release@example.test');
  git('config', 'commit.gpgsign', 'false');
  git('add', '.');
  git('commit', '--no-verify', '-qm', 'green fixture');
  green = git('rev-parse', 'HEAD');
  git('checkout', '--detach', '-q', green);
  mkdirSync(join(repo, 'apps/operator/dist-hosted-control-plane'));
  writeFileSync(join(repo, 'apps/operator/dist-hosted-control-plane/serve.mjs'), '// built bundle\n');
  stamp();
  const systemctl = join(temp, 'systemctl');
  writeFileSync(systemctl, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_SYSTEMCTL_LOG"\n', { mode: 0o755 });
  env = { ...process.env,
    PAPERCUSP_DEPLOYMENT_ENVIRONMENT: 'production',
    PAPERCUSP_HOSTED_CP_REPO_ROOT: repo,
    PAPERCUSP_HOSTED_CP_TEMPLATE: join(repo, templatePath),
    PAPERCUSP_HOSTED_CP_NODE: process.execPath,
    PAPERCUSP_HOSTED_CP_ENV_FILE: join(temp, 'production.env'),
    PAPERCUSP_HOSTED_CP_UNIT_DIR: join(temp, 'units'),
    PAPERCUSP_HOSTED_CP_UNIT: 'hosted-production.service',
    PAPERCUSP_HOSTED_CP_SYSTEMCTL: systemctl,
    PAPERCUSP_HOSTED_CP_SYSTEMD_ANALYZE: '/bin/true',
    TEST_SYSTEMCTL_LOG: join(temp, 'systemctl.log'),
  };
});

afterEach(() => rmSync(temp, { recursive: true, force: true }));

function expectRefused(reason: RegExp, sha = green) {
  const result = install(['--install-only'], sha);
  expect(result.status, result.stderr).not.toBe(0);
  expect(result.stderr).toMatch(reason);
  expect(existsSync(join(temp, 'units'))).toBe(false);
  expect(existsSync(join(temp, 'systemctl.log'))).toBe(false);
}

describe('SPEC-P-007 production green-main deploy guard', () => {
  it('production configuration preflight includes Stripe references and refuses a local delegation key', () => {
    configureActivation();
    const referenceLog = join(temp, 'reference-check.log');
    env.TEST_REFERENCE_LOG = referenceLog;
    writeFileSync(join(temp, 'bin/npx'), '#!/bin/sh\nprintf "%s\\n" "$*" > "$TEST_REFERENCE_LOG"\n', { mode: 0o755 });
    const checked = install(['--check-env']);
    expect(checked.status, checked.stderr).toBe(0);
    const argv = readFileSync(referenceLog, 'utf8');
    expect(argv).toContain('--required PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF WORKOS_API_KEY_REF WORKOS_COOKIE_PASSWORD_REF WORKOS_WEBHOOK_SECRET_REF PAPERCUSP_STRIPE_SECRET_KEY_REF PAPERCUSP_STRIPE_WEBHOOK_SECRET_REF');
    expect(argv).toContain('--optional PAPERCUSP_HOSTED_GCP_DELEGATION_SOURCE_CREDENTIALS_REF');
    env.PAPERCUSP_HOSTED_GCP_DELEGATION_SOURCE_CREDENTIALS = '/dev-box/private-key.json';
    const refused = install(['--check-env']);
    expect(refused.status).not.toBe(0);
    expect(refused.stdout).toContain('FORBIDDEN');
    expect(refused.stdout + refused.stderr).not.toContain('/dev-box/private-key.json');
  });

  it('checks the real JSON health/readiness contract and accepts the bundle writer’s short SHA', async () => {
    await withProbe(path => path === '/api/health'
      ? { ok: true, service: 'papercusp-operator', sha: green.slice(0, 10) }
      : { ok: true, ready: true }, async () => {
      const result = await runAsync(['--check-health']);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(temp, 'systemctl.log'))).toBe(false);
    });
  });

  it.each(['wrong-sha', 'stale-bundle', 'not-ready', 'wrong-service', 'missing-sha'])(
    'refuses an HTTP-200 %s listener without systemd mutations', async (failure) => {
      await withProbe(path => path === '/api/health'
        ? { ok: true, service: failure === 'wrong-service' ? 'other' : 'papercusp-operator',
          sha: failure === 'missing-sha' ? null : failure === 'wrong-sha' ? 'a'.repeat(40) : green,
          ...(failure === 'stale-bundle' ? { bundleStale: {} } : {}) }
        : { ok: true, ready: failure !== 'not-ready' }, async () => {
        const result = await runAsync(['--check-health']);
        expect(result.status, result.stderr).not.toBe(0);
        expect(existsSync(join(temp, 'systemctl.log'))).toBe(false);
      });
    });

  it('activates a proved release only after configuration and readiness pass', async () => {
    configureActivation();
    await withProbe(servingProbe, async () => {
      const result = await runAsync(['--activate-release']);
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(env.TEST_SERVING_SHA!, 'utf8')).toBe(green);
      expect(readFileSync(join(temp, 'systemctl.log'), 'utf8')).toBe(
        '--user daemon-reload\n--user restart hosted-production.service\n');
    });
  });

  it.each(['not-ready', 'start-failure'])('restores and verifies the previous release on candidate %s', async (failure) => {
    configureActivation();
    await withProbe(servingProbe, async () => {
      const { previousSha, previousUnit } = installPreviousRelease();
      env[failure === 'not-ready' ? 'TEST_NOT_READY_SHA' : 'TEST_FAIL_START_SHA'] = green;
      const result = await runAsync(['--activate-release']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`previous release restored and verified ready: ${previousSha}`);
      expect(readFileSync(env.TEST_UNIT_FILE!, 'utf8')).toBe(previousUnit);
      expect(readFileSync(env.TEST_SERVING_SHA!, 'utf8')).toBe(previousSha);
      expect(readFileSync(join(temp, 'systemctl.log'), 'utf8')).toBe(
        '--user is-active --quiet hosted-production.service\n--user daemon-reload\n' +
        '--user restart hosted-production.service\n--user stop hosted-production.service\n' +
        '--user daemon-reload\n--user restart hosted-production.service\n');
    });
  });

  it('stops and removes a failed first deployment', async () => {
    configureActivation();
    env.TEST_NOT_READY_SHA = green;
    await withProbe(servingProbe, async () => {
      const result = await runAsync(['--activate-release']);
      expect(result.status).not.toBe(0);
      expect(existsSync(env.TEST_UNIT_FILE!)).toBe(false);
      expect(existsSync(env.TEST_SERVING_SHA!)).toBe(false);
    });
  });

  it('restores an inactive predecessor without starting it on candidate failure', async () => {
    configureActivation();
    await withProbe(servingProbe, async () => {
      const { previousUnit } = installPreviousRelease();
      rmSync(env.TEST_SERVING_SHA!);
      env.TEST_NOT_READY_SHA = green;
      const result = await runAsync(['--activate-release']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('previous inactive state restored');
      expect(readFileSync(env.TEST_UNIT_FILE!, 'utf8')).toBe(previousUnit);
      expect(existsSync(env.TEST_SERVING_SHA!)).toBe(false);
      expect(readFileSync(join(temp, 'systemctl.log'), 'utf8').match(/--user restart/g)).toHaveLength(1);
    });
  });

  it('reports rollback failure without claiming the old release is ready', async () => {
    configureActivation();
    await withProbe(servingProbe, async () => {
      const { previousSha, previousUnit } = installPreviousRelease();
      env.TEST_NOT_READY_SHA = green;
      env.TEST_FAIL_START_SHA = previousSha;
      const result = await runAsync(['--activate-release']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('rollback release failed health/readiness');
      expect(result.stderr).not.toContain('restored and verified ready');
      expect(readFileSync(env.TEST_UNIT_FILE!, 'utf8')).toBe(previousUnit);
      expect(existsSync(env.TEST_SERVING_SHA!)).toBe(false);
    });
  });

  it('refuses an unrecognized previous unit before changing it', async () => {
    configureActivation();
    mkdirSync(join(temp, 'units'));
    const legacy = '[Service]\nExecStart=/usr/bin/node unrelated.mjs\n';
    writeFileSync(env.TEST_UNIT_FILE!, legacy);
    const result = await runAsync(['--activate-release']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('previous unit has no verified production release identity');
    expect(readFileSync(env.TEST_UNIT_FILE!, 'utf8')).toBe(legacy);
    expect(existsSync(join(temp, 'systemctl.log'))).toBe(false);
  });

  it('refuses incomplete configuration before installing or restarting a unit', async () => {
    configureActivation();
    writeFileSync(join(temp, 'production.env'), readFileSync(join(temp, 'production.env'), 'utf8') + '\nWORKOS_CLIENT_ID=\n');
    const result = await runAsync(['--activate-release']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('hosted configuration incomplete');
    expect(existsSync(join(temp, 'units'))).toBe(false);
    expect(existsSync(join(temp, 'systemctl.log'))).toBe(false);
  });

  it('refuses activation before mutation when the previous artifact is no longer provable', async () => {
    configureActivation();
    await withProbe(servingProbe, async () => {
      const { previousUnit, previousRoot } = installPreviousRelease();
      writeFileSync(join(previousRoot, 'apps/operator/dist-hosted-control-plane/serve.mjs'), '// tampered\n');
      const result = await runAsync(['--activate-release']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('previous release proof failed');
      expect(readFileSync(env.TEST_UNIT_FILE!, 'utf8')).toBe(previousUnit);
      expect(existsSync(join(temp, 'systemctl.log'))).toBe(false);
    });
  });

  it('installs a proved green bundle and rechecks it before each production start', () => {
    const result = install();
    expect(result.status, result.stderr).toBe(0);
    const unit = readFileSync(join(temp, 'units/hosted-production.service'), 'utf8');
    expect(unit).toContain(`--check-release --production-release ${green}`);
    expect(unit).toContain('Environment=PAPERCUSP_DEPLOYMENT_ENVIRONMENT=production');
    expect(unit).not.toContain('PAPERCUSP_BUNDLE_ALLOW_STALE_START=1');
    expect(unit).not.toContain('bundle-host.sh');
    const boot = unit.split('\n').find(line => line.startsWith('ExecStart='))!;
    expect(boot).toContain(`/usr/bin/bash -ec 'set -a; . "${temp}/production.env"`);
    expect(boot).not.toContain('.env.local');
    expect(boot).not.toContain('HARNESS_ADMIN_DATABASE_URL=');
    expect(boot).toContain('export PAPERCUSP_DEPLOYMENT_ENVIRONMENT=production');
    expect(boot).toContain('exec node dist-hosted-control-plane/serve.mjs');
    expect(readFileSync(join(temp, 'systemctl.log'), 'utf8')).toBe('--user daemon-reload\n');
    // Exercise the actual pre-start command, rather than merely inspecting its text.
    const command = unit.split('\n').find(line => line.startsWith('ExecStartPre='))!.slice('ExecStartPre='.length);
    expect(spawnSync('bash', ['-c', command], { env, encoding: 'utf8' }).status).toBe(0);
    writeFileSync(join(repo, 'apps/operator/dist-hosted-control-plane/serve.mjs'), '// replaced after install\n');
    const tampered = spawnSync('bash', ['-c', command], { env, encoding: 'utf8' });
    expect(tampered.status).not.toBe(0);
    expect(tampered.stderr).toContain('freshness proof failed');
  });

  it('rejects a staging-only/red commit before any installation side effect', () => {
    git('checkout', '-qb', 'staging');
    writeFileSync(join(repo, 'red.txt'), 'red\n');
    git('add', 'red.txt');
    git('commit', '--no-verify', '-qm', 'unpromoted fixture');
    const red = git('rev-parse', 'HEAD');
    git('checkout', '--detach', '-q', red);
    stamp();
    expectRefused(/not the green main pin/, red);
  });

  it('boots with injected production configuration even when local env tries to disable the policy', () => {
    const capture = join(temp, 'boot.json');
    const bin = join(temp, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
    writeFileSync(join(repo, 'apps/operator/dist-hosted-control-plane/serve.mjs'),
      'import {writeFileSync} from "node:fs"; writeFileSync(process.env.TEST_BOOT_CAPTURE, JSON.stringify({environment:process.env.PAPERCUSP_DEPLOYMENT_ENVIRONMENT,admin:process.env.HARNESS_ADMIN_DATABASE_URL,app:process.env.HARNESS_DATABASE_URL,profile:process.env.PAPERCUSP_DISTRIBUTION_PROFILE}));\n');
    stamp();
    writeFileSync(join(repo, 'apps/operator/.env.local'),
      'PAPERCUSP_DEPLOYMENT_ENVIRONMENT=development\nHARNESS_ADMIN_DATABASE_URL=postgres://dev@localhost/dev\n');
    writeFileSync(join(temp, 'production.env'),
      'PAPERCUSP_DEPLOYMENT_ENVIRONMENT=development\nHARNESS_ADMIN_DATABASE_URL=postgres://admin:injected-secret@10.60.0.2/papercusp_hosted\nHARNESS_DATABASE_URL=postgres://app:injected-secret@10.60.0.2/papercusp_hosted\n');
    const result = install(['--render-only']);
    expect(result.status, result.stderr).toBe(0);
    const command = result.stdout.split('\n').find(line => line.startsWith('ExecStart='))!.slice('ExecStart='.length);
    const boot = spawnSync('bash', ['-c', command], {
      cwd: join(repo, 'apps/operator'),
      env: { ...env, PATH: `${bin}:${process.env.PATH}`, TEST_BOOT_CAPTURE: capture },
      encoding: 'utf8',
    });
    expect(boot.status, boot.stderr).toBe(0);
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual({
      environment: 'production',
      admin: 'postgres://admin:injected-secret@10.60.0.2/papercusp_hosted',
      app: 'postgres://app:injected-secret@10.60.0.2/papercusp_hosted',
      profile: 'hosted-control-plane',
    });
    rmSync(join(temp, 'production.env'));
    const missing = spawnSync('bash', ['-c', command], {
      cwd: join(repo, 'apps/operator'), env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8',
    });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('production.env');
  });

  it('rejects a valid green pin when the checkout is at another commit', () => {
    writeFileSync(join(repo, 'other.txt'), 'other\n');
    git('add', 'other.txt');
    git('commit', '--no-verify', '-qm', 'other fixture');
    expectRefused(/checkout does not match/);
  });

  it('rejects the mutable main working tree even when its SHA is green', () => {
    git('checkout', '-q', 'main');
    expectRefused(/detached release checkout/);
  });

  it('rejects an absent green main authority', () => {
    git('branch', '-D', 'main');
    expectRefused(/green main pin is unavailable/);
  });

  it('rejects uncommitted tracked source changes', () => {
    writeFileSync(join(repo, 'apps/operator/bin/serve.ts'), '// changed source\n');
    expectRefused(/freshness proof failed/);
  });

  it('rejects a missing bundle proof', () => {
    rmSync(join(repo, 'apps/operator/dist-hosted-control-plane/.bundle-fresh.json'));
    expectRefused(/freshness proof failed/);
  });

  it('rejects a stale bundle even when an older freshness proof remains', () => {
    writeFileSync(join(repo, 'apps/operator/dist-hosted-control-plane/.bundle-stale.json'), '{}');
    expectRefused(/bundle is marked stale/);
  });

  it('requires an explicit full SHA and refuses branch names', () => {
    expectRefused(/full commit SHA/, 'main');
    const result = spawnSync('bash', [join(repo, installerPath), '--install-only'], { env, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('requires --production-release');
    expect(existsSync(join(temp, 'units'))).toBe(false);
  });
});
