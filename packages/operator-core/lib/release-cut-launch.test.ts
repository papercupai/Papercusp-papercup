/**
 * release-cut-launch.test.ts — the LOCAL desktop-release cutter's PURE primitives
 * (desktop-update-center-and-release-tooling P-5 Unit B). No real cut; dependency-marker
 * cases exercise the canonical reader against temporary files. Other branches use injected deps,
 * per RELEASE-RUNBOOK D-007
 * (no claim of "verified" rests on a live VM/build run that did not happen).
 *
 * Run: cd packages/operator-core && npx vitest run lib/release-cut-launch.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
const readOperatorDbEnvLocalMock = vi.hoisted(() => vi.fn(() => ({} as Record<string, string>)));
vi.mock('@papercusp/db-org/operator-db-env', async () => ({
  ...await vi.importActual('@papercusp/db-org/operator-db-env'),
  readOperatorDbEnvLocal: readOperatorDbEnvLocalMock,
}));
import {
  isValidVersion,
  isValidChannel,
  isValidSourceSha,
  buildCutEnv,
  buildCutArgv,
  checkReleaseHostEnvFile,
  launchDetachedCut,
  type SpawnLike,
  orchestratorNeedsStagingSyncLock,
  wrapWithStagingSyncLock,
  STAGING_SYNC_LOCK,
  STAGING_SYNC_LOCK_TIMEOUT_EXIT,
  parseCutStartedMarker,
  readCutStatus,
  collectHandoff,
  preflightCut,
  preflightCutAsync,
  runProbeSpecAsync,
  parseRemoteTagSha,
  SOURCE_IDENTITY_GUARDS,
  type ProbeSpec,
  type SmokeTargetProbe,
  desktopReleaseTag,
  DOGFOOD_CANONICAL_REMOTE,
  isReleaseArtifact,
  isUpdaterArtifact,
  CUT_UNIT,
  CUT_DONE,
  CUT_LOG,
  CUT_STARTED,
  PLATFORMS,
  cutUnitFor,
  cutUnitForTask,
  cutLogFor,
  cutDoneFor,
  cutStartedFor,
  legsForPlatform,
  abortLeg,
  deriveBuildSha,
  gatePath,
  readOrCreateGate,
  releaseToolingDrift,
  RELEASE_TOOLING_REFERENCE_BRANCH,
  RELEASE_TOOLING_SUBTREE,
  type GitRunner,
  type ReleaseToolingDrift,
} from './release-cut-launch';

describe('detached cut database credentials', () => {
  it.each(['canonical', 'explicit-admin', 'explicit-database'] as const)('transports %s DB pins without exposing secrets', async (mode) => {
    const configuredUrl = 'postgres://fixture:configured-secret@localhost/configured';
    const explicitUrl = 'postgres://fixture:explicit-secret@localhost/explicit';
    readOperatorDbEnvLocalMock.mockReturnValue({ HARNESS_ADMIN_DATABASE_URL: configuredUrl });
    const explicit = mode === 'canonical' ? {} : mode === 'explicit-admin'
      ? { HARNESS_ADMIN_DATABASE_URL: explicitUrl } : { DATABASE_URL: explicitUrl };
    let credentialPath = '';
    let received: Record<string, string> = {};
    const spawnMock = vi.fn((_binary: string, argv: string[]) => {
      expect(argv.join(' ')).not.toContain('configured-secret');
      expect(argv.join(' ')).not.toContain('explicit-secret');
      credentialPath = argv.find((arg) => arg.startsWith('--property=LoadCredential='))!.split(':').slice(1).join(':');
      received = Object.fromEntries(fs.readFileSync(credentialPath, 'utf8').split('\0').filter(Boolean)
        .map((record) => [record.slice(0, record.indexOf('=')), record.slice(record.indexOf('=') + 1)]));
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    try {
      const result = await launchDetachedCut({ version: '0.0.27', channel: 'alpha', expectedSourceSha: 'a'.repeat(40),
        root: '/isolated/papercusp-desktop', runtime: { ownerName: 'Fixture', canonicalDesktopRoot: '/canonical/papercusp-desktop' } },
      spawnMock as unknown as SpawnLike, { PATH: '/usr/bin', HOME: '/fixture', ...explicit,
        PAPERCUSP_TRANSFORMERS_MODEL_CACHE: "/fixture/model cache's pack",
        PRIVATE_PROVIDER_KEY: 'do-not-forward' });
      expect(result.launched).toBe(true);
      expect(readOperatorDbEnvLocalMock).toHaveBeenCalledWith('/canonical/apps/operator/.env.local');
      const selectedUrl = mode === 'canonical' ? configuredUrl : explicitUrl;
      expect(received).toEqual({ PATH: '/usr/bin', HOME: '/fixture', HARNESS_ADMIN_DATABASE_URL: selectedUrl, DATABASE_URL: selectedUrl,
        PAPERCUSP_TRANSFORMERS_MODEL_CACHE: "/fixture/model cache's pack" });
      expect(fs.existsSync(credentialPath)).toBe(false);
      expect(result.argv.join(' ')).not.toContain('do-not-forward');
    } finally {
      readOperatorDbEnvLocalMock.mockReturnValue({});
    }
  });

  it('releases the credential when systemd admission throws', async () => {
    let credentialPath = '';
    const spawnMock = vi.fn((_binary: string, argv: string[]) => {
      credentialPath = argv.find((arg) => arg.startsWith('--property=LoadCredential='))!.split(':').slice(1).join(':');
      expect(fs.existsSync(credentialPath)).toBe(true);
      throw new Error('fixture admission failure');
    });
    const result = await launchDetachedCut({ version: '0.0.27', channel: 'alpha', expectedSourceSha: 'a'.repeat(40),
      root: '/isolated/papercusp-desktop', runtime: { ownerName: 'Fixture', canonicalDesktopRoot: '/canonical/papercusp-desktop' } },
    spawnMock as unknown as SpawnLike, { PATH: '/usr/bin' });
    expect(result).toMatchObject({ launched: false, reason: 'fixture admission failure' });
    expect(fs.existsSync(credentialPath)).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')('preserves the new unit notify socket through the real credential runner', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-notify-env-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    // Observe the workload environment without running the cutter or touching
    // its shared lock/sentinels. The generated wrapper and env runner are real.
    fs.writeFileSync(path.join(bin, 'bash'), `#!${process.execPath}\n` +
      'process.stdout.write(JSON.stringify({ notify: process.env.NOTIFY_SOCKET, ' +
      'database: process.env.DATABASE_URL, provider: process.env.PRIVATE_PROVIDER_KEY }));\n', { mode: 0o755 });
    const unitSocket = "@fixture unit's notify socket";
    const database = 'postgres://fixture:secret@localhost/fixture';
    let observed: Record<string, string> = {};
    const spawnMock = vi.fn((_binary: string, argv: string[]) => {
      const credential = argv.find((arg) => arg.startsWith('--property=LoadCredential='))!
        .slice('--property=LoadCredential='.length);
      const separator = credential.indexOf(':');
      fs.copyFileSync(credential.slice(separator + 1), path.join(dir, credential.slice(0, separator)));
      const payloadIndex = argv.findIndex((arg) => !arg.startsWith('--'));
      const program = argv[payloadIndex];
      // systemd resolves the service executable independently of the payload's
      // PATH and unescapes $$ before executing each ExecStart argument.
      const result = spawnSync(program === 'bash' ? '/bin/bash' : program,
        argv.slice(payloadIndex + 1).map((arg) => arg.replaceAll('$$', '$')), {
          env: { PATH: '/usr/bin:/bin', CREDENTIALS_DIRECTORY: dir,
            NOTIFY_SOCKET: unitSocket, PRIVATE_PROVIDER_KEY: 'manager-only-secret' },
          encoding: 'utf8', timeout: 10_000,
        });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      observed = JSON.parse(result.stdout);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', result.status));
      return child;
    });
    try {
      const result = await launchDetachedCut({ version: '0.0.27', channel: 'alpha', expectedSourceSha: 'a'.repeat(40),
        root: '/isolated/papercusp-desktop', runtime: { ownerName: 'Fixture', canonicalDesktopRoot: '/canonical/papercusp-desktop' } },
      spawnMock as unknown as SpawnLike, { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, DATABASE_URL: database,
        NOTIFY_SOCKET: '@wrong-operator-socket', PRIVATE_PROVIDER_KEY: 'operator-only-secret' });
      expect(result.launched).toBe(true);
      expect(observed).toEqual({ notify: unitSocket, database });
      expect(result.argv.join(' ')).not.toContain('@wrong-operator-socket');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('version / channel validation', () => {
  it('accepts X.Y.Z and X.Y.Z-prerelease, rejects junk', () => {
    expect(isValidVersion('0.0.8')).toBe(true);
    expect(isValidVersion('1.2.3-rc.1')).toBe(true);
    expect(isValidVersion('10.20.30-alpha.2')).toBe(true);
    expect(isValidVersion('v1.2.3')).toBe(false);
    expect(isValidVersion('1.2')).toBe(false);
    expect(isValidVersion('')).toBe(false);
    expect(isValidVersion('1.2.3; rm -rf /')).toBe(false);
  });
  it('accepts only the three channels', () => {
    expect(isValidChannel('stable')).toBe(true);
    expect(isValidChannel('beta')).toBe(true);
    expect(isValidChannel('alpha')).toBe(true);
    expect(isValidChannel('nightly')).toBe(false);
  });
  it('accepts only an exact lowercase 40-char source SHA', () => {
    expect(isValidSourceSha('1feac8dd867c6566af834445a58b5a2e43b14649')).toBe(true);
    expect(isValidSourceSha('1feac8dd')).toBe(false);
    expect(isValidSourceSha('1FEAC8DD867C6566AF834445A58B5A2E43B14649')).toBe(false);
  });
});

describe('buildCutEnv — LOCAL-only enforced', () => {
  it('transports D166 private inputs as a fresh full read-only source cut, with no cached seed', () => {
    const seedUuidIdempotency = { plansPath: '/private/row plans.json', plansSha256: 'a'.repeat(64), sourceStoreDir: '/private/frozen source',
      censusPath: "/private/census's config.json", censusSha256: 'b'.repeat(64) };
    expect(buildCutEnv({}, sourceSha, { ownerName: 'Avi', fullHistory: true, seedUuidIdempotency }))
      .toMatchObject({ PAPERCUSP_SEED_UUID_PLAN_PATH: seedUuidIdempotency.plansPath,
        PAPERCUSP_SEED_UUID_PLAN_SHA256: seedUuidIdempotency.plansSha256,
        PAPERCUSP_SEED_UUID_CENSUS_PATH: seedUuidIdempotency.censusPath,
        PAPERCUSP_SEED_UUID_CENSUS_SHA256: seedUuidIdempotency.censusSha256,
        PAPERCUSP_SEED_STORE_DIR: seedUuidIdempotency.sourceStoreDir, PAPERCUSP_SEED_REUSE_CORESTORE: '0',
        PAPERCUSP_SEED_FORCE: '1', PAPERCUSP_SEED_CORESTORE: '1', PAPERCUSP_SEED_SPARSE: '0',
        PAPERCUSP_SEED_SNAPSHOT_DIR: '', PAPERCUSP_SEED_DEPTH: '' });
    for (const bad of [{ reuseSeed: true }, { seedless: true },
      { seedUuidIdempotency: { ...seedUuidIdempotency, plansSha256: 'bad' } },
      { seedUuidIdempotency: { ...seedUuidIdempotency, censusSha256: 'bad' } },
      { seedUuidIdempotency: { ...seedUuidIdempotency, censusPath: 'relative' } },
      { seedUuidIdempotency: { ...seedUuidIdempotency, censusPath: undefined as never } },
      { seedUuidIdempotency: { ...seedUuidIdempotency, sourceStoreDir: 'relative' } }]) {
      expect(() => buildCutEnv({}, sourceSha, { ownerName: 'Avi', seedUuidIdempotency, ...bad })).toThrow();
    }
  });

  it('passes only the explicitly supplied private seed finding proof to the detached cut', () => {
    const source = 'a'.repeat(40);
    expect(buildCutEnv({}, source, { ownerName: 'Avi' }))
      .not.toHaveProperty('PAPERCUSP_RELEASE_SEED_FINDING_PROOF');
    expect(buildCutEnv({}, source, { ownerName: 'Avi', seedFindingProof: '/private/proof.json' }))
      .toHaveProperty('PAPERCUSP_RELEASE_SEED_FINDING_PROOF', '/private/proof.json');
  });
  const sourceSha = '1feac8dd867c6566af834445a58b5a2e43b14649';
  const runtime = { ownerName: 'Avi' };
  it('binds focused proof to the task harness and never treats all-scope as a harness', () => {
    expect(buildCutEnv({}, sourceSha, { ...runtime, harnessSlug: ' customer-app ' }))
      .toHaveProperty('PAPERCUSP_TEST_RUN_HARNESS', 'customer-app');
    for (const harnessSlug of [undefined, null, '', ' ', '*', 'all']) {
      expect(buildCutEnv({}, sourceSha, { ...runtime, harnessSlug }))
        .not.toHaveProperty('PAPERCUSP_TEST_RUN_HARNESS');
    }
  });
  it('always disables GitHub publish; adds only requested legs', () => {
    expect(buildCutEnv({}, sourceSha, runtime)).toEqual({
      PAPERCUSP_PUBLISH_GITHUB: '0',
      PAPERCUSP_RELEASE_DEFER_TAG: '0',
      PAPERCUSP_EXPECTED_SOURCE_SHA: sourceSha,
      PAPERCUSP_RELEASE_OWNER_NAME: 'Avi',
      DEPENDENCY_GENERATION_FORCE_COPY: '1',
      PAPERCUSP_SKIP_DEP_GENERATION: '1',
      PAPERCUSP_SKIP_MOBILE: '1',
    });
    expect(buildCutEnv({ mac: true, windows: true, arm64: true }, sourceSha, runtime)).toEqual({
      PAPERCUSP_PUBLISH_GITHUB: '0',
      PAPERCUSP_RELEASE_DEFER_TAG: '0',
      PAPERCUSP_EXPECTED_SOURCE_SHA: sourceSha,
      PAPERCUSP_RELEASE_OWNER_NAME: 'Avi',
      DEPENDENCY_GENERATION_FORCE_COPY: '1',
      PAPERCUSP_SKIP_DEP_GENERATION: '1',
      PAPERCUSP_SKIP_MOBILE: '1',
      WITH_MAC: '1',
      WITH_WINDOWS: '1',
      WITH_ARM64: '1',
    });
    // A false/undefined leg is not injected.
    expect(buildCutEnv({ mac: false }, sourceSha, { ownerName: ' Avi ', ownerEmail: ' owner@example.test ', reuseSeed: true })).toEqual({
      PAPERCUSP_PUBLISH_GITHUB: '0',
      PAPERCUSP_RELEASE_DEFER_TAG: '0',
      PAPERCUSP_EXPECTED_SOURCE_SHA: sourceSha,
      PAPERCUSP_RELEASE_OWNER_NAME: 'Avi',
      PAPERCUSP_RELEASE_OWNER_EMAIL: 'owner@example.test',
      DEPENDENCY_GENERATION_FORCE_COPY: '1',
      PAPERCUSP_SKIP_DEP_GENERATION: '1',
      PAPERCUSP_SKIP_SEED_CUT: '1',
      PAPERCUSP_SKIP_MOBILE: '1',
    });
    expect(buildCutEnv({}, sourceSha, { ownerName: 'Avi', seedless: true }))
      .toHaveProperty('PAPERCUSP_SKIP_SEED_CUT', '1');
    expect(() => buildCutEnv({}, sourceSha, { ownerName: 'Avi', reuseSeed: true, seedless: true }))
      .toThrow(/seed_mode_conflict/);
  });

  it('explicit seedless passes the real audited Server guard and records its source-bound reason', () => {
    const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-cut-seedless-'));
    const guard = fileURLToPath(new URL('../../../papercusp-desktop/bin/lib/release-seed-guard.sh', import.meta.url));
    try {
      for (const mode of [{}, { reuseSeed: true }, { seedless: true }]) {
        const env = buildCutEnv({}, sourceSha, { ownerName: 'Avi', ...mode });
        const result = spawnSync('bash', ['-c',
          'source "$1"; release_seed_guard "gui server" dogfood "$2"; result=$?; printf "status=%s reason=%s\\n" "$PROVENANCE_SEED_STATUS" "$PROVENANCE_SEED_REASON"; exit "$result"',
          'test', guard, seedDir], {
          encoding: 'utf8',
          env: { ...process.env, PAPERCUSP_RELEASE_AUDIT: '1',
            PAPERCUSP_ALLOW_SEEDLESS_RELEASE: '0', PAPERCUSP_ALLOW_SEEDLESS_REASON: '', ...env },
        });
        expect(result.error).toBeUndefined();
        if ('seedless' in mode) {
          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toContain('status=absent-allowed');
          expect(result.stdout).toContain(`seedless:true source=${sourceSha}`);
        } else {
          expect(result.status).toBe(1);
          expect(result.stdout).toContain('status=refused');
          expect(env).not.toHaveProperty('PAPERCUSP_ALLOW_SEEDLESS_RELEASE');
        }
      }
    } finally {
      fs.rmSync(seedDir, { recursive: true, force: true });
    }
  });

  it('defers tags only by explicit opt-in while keeping publish disabled and exact source binding', () => {
    const env = buildCutEnv({}, sourceSha, { ...runtime, deferTag: true });
    expect(env).toMatchObject({ PAPERCUSP_RELEASE_DEFER_TAG: '1', PAPERCUSP_PUBLISH_GITHUB: '0',
      PAPERCUSP_EXPECTED_SOURCE_SHA: sourceSha });
    for (const deferTag of [undefined, false]) {
      expect(buildCutEnv({}, sourceSha, { ...runtime, deferTag })).toHaveProperty('PAPERCUSP_RELEASE_DEFER_TAG', '0');
    }
  });

  it('renders full-history as a present-empty seed depth and rejects modes that skip the seed cut', () => {
    expect(buildCutEnv({}, sourceSha, { ownerName: 'Avi', fullHistory: true })).toHaveProperty(
      'PAPERCUSP_SEED_DEPTH',
      '',
    );
    expect(buildCutEnv({}, sourceSha, runtime)).not.toHaveProperty('PAPERCUSP_SEED_DEPTH');
    expect(() => buildCutEnv({}, sourceSha, { ownerName: 'Avi', fullHistory: true, reuseSeed: true })).toThrow(
      /seed_history_mode_conflict/,
    );
    expect(() => buildCutEnv({}, sourceSha, { ownerName: 'Avi', fullHistory: true, seedless: true })).toThrow(
      /seed_history_mode_conflict/,
    );
  });

  // EI-23917342543376581. The env below is an explicit ALLOWLIST rendered onto a
  // systemd-run command, so a name that is not forwarded here is silently dropped — which
  // is how `release:cut` lost a lever that a manual bin/release-local.sh run has always
  // had. Without it, a head-snapshot scan overrun offers only a FULL seed or an operator
  // quiesce (a fleet-affecting outage). These assert the forwarding AND that a malformed
  // override is ignored rather than fatal: cut-seed-cli refuses a bad value, and killing a
  // ~45-minute release cut over a stray env var would be worse than the derived deadline.
  it('forwards a valid head-snapshot timeout override, and ignores a malformed one', () => {
    expect(
      buildCutEnv({}, sourceSha, { ownerName: 'Avi', headSnapshotTimeoutMs: 5_400_000 }),
    ).toMatchObject({ PAPERCUSP_HEAD_SNAPSHOT_TIMEOUT_MS: '5400000' });

    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(
        buildCutEnv({}, sourceSha, { ownerName: 'Avi', headSnapshotTimeoutMs: bad }),
      ).not.toHaveProperty('PAPERCUSP_HEAD_SNAPSHOT_TIMEOUT_MS');
    }

    // Omitting it entirely must leave the env byte-identical to the baseline, so the
    // default path keeps deriving the deadline from the corpus length.
    expect(buildCutEnv({}, sourceSha, runtime)).not.toHaveProperty(
      'PAPERCUSP_HEAD_SNAPSHOT_TIMEOUT_MS',
    );
  });

  // WI-6554700010029602: release-host.sh reads PAPERCUSP_RELEASE_HOST_ENV, but the cut env
  // is an explicit allowlist, so a host-migration candidate could only bake the canonical
  // (permanent, legacy) file. Unlike the timeout, a bad value must be FATAL: a silent
  // fallback bakes the old update source with nothing red.
  it('forwards an explicit release-host env file, and refuses a non-absolute one', () => {
    const file = '/home/owner/.papercusp/release-host-gcs.env';
    expect(buildCutEnv({}, sourceSha, { ...runtime, releaseHostEnv: file })).toMatchObject({
      PAPERCUSP_RELEASE_HOST_ENV: file,
    });
    expect(buildCutEnv({}, sourceSha, runtime)).not.toHaveProperty('PAPERCUSP_RELEASE_HOST_ENV');
    for (const bad of ['', '   ', 'release-host-gcs.env', '~/.papercusp/release-host-gcs.env']) {
      expect(() => buildCutEnv({}, sourceSha, { ...runtime, releaseHostEnv: bad })).toThrow(
        /release_host_env_invalid/,
      );
    }
    const argv = buildCutArgv('/r/papercusp-desktop', '0.0.30', 'alpha', {}, sourceSha, '/usr/bin', {
      ...runtime,
      releaseHostEnv: file,
    });
    expect(argv.at(-1)).toContain(`PAPERCUSP_RELEASE_HOST_ENV='${file}'`);
  });

  describe('checkReleaseHostEnvFile', () => {
    const home = '/home/owner';
    const file = '/home/owner/.papercusp/release-host-gcs.env';
    const secret = 'https://cupboard.example.test/releases/SECRETPATHSEGMENT';
    const reader = (text: string) => (p: string) => {
      if (p !== file) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      return text;
    };

    it('accepts a file that defines an https host, in every shell assignment form', () => {
      for (const text of [
        `PAPERCUSP_RELEASE_HOST=${secret}\n`,
        `# comment\nexport PAPERCUSP_RELEASE_HOST="${secret}"\nPAPERCUSP_UPDATE_BASE_URL=${secret}\n`,
        `PAPERCUSP_RELEASE_HOST='${secret}'\r\n`,
      ]) {
        expect(checkReleaseHostEnvFile(file, home, reader(text))).toBeNull();
      }
      expect(checkReleaseHostEnvFile('/home/owner/.papercusp/release-host.env', home, () => `PAPERCUSP_RELEASE_HOST=${secret}`)).toBeNull();
    });

    it('refuses paths outside ~/.papercusp or with a non-release-host name', () => {
      for (const bad of [
        '/tmp/release-host-gcs.env',
        '/home/owner/.papercusp/sub/release-host-gcs.env',
        '/home/owner/.papercusp/../.papercusp/release-host-gcs.env',
        'release-host-gcs.env',
      ]) {
        expect(checkReleaseHostEnvFile(bad, home, reader(''))).toMatch(/^release_host_env_invalid/);
      }
      for (const name of ['r2.env', 'release-storage.env', 'release-host-gcs.env.bak', 'release-host-.env']) {
        expect(checkReleaseHostEnvFile(`/home/owner/.papercusp/${name}`, home, reader(''))).toMatch(
          /^release_host_env_invalid/,
        );
      }
    });

    it('refuses a missing file, an empty or commented host, and a non-https host', () => {
      expect(checkReleaseHostEnvFile(file, home, () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      })).toMatch(/^release_host_env_unreadable .*ENOENT/);
      for (const text of ['', 'PAPERCUSP_RELEASE_HOST=\n', `# PAPERCUSP_RELEASE_HOST=${secret}\n`, 'PAPERCUSP_RELEASE_HOST=""']) {
        expect(checkReleaseHostEnvFile(file, home, reader(text))).toMatch(/^release_host_env_no_host/);
      }
      // Last assignment wins, exactly as `set -a; . file` would export it.
      expect(checkReleaseHostEnvFile(file, home, reader(`PAPERCUSP_RELEASE_HOST=${secret}\nPAPERCUSP_RELEASE_HOST=\n`)))
        .toMatch(/^release_host_env_no_host/);
      const insecure = 'http://cupboard.example.test/releases/SECRETPATHSEGMENT';
      const reason = checkReleaseHostEnvFile(file, home, reader(`PAPERCUSP_RELEASE_HOST=${insecure}\n`));
      expect(reason).toMatch(/without an https:\/\/ scheme/);
      // The host's path segment is the shared secret: refusals must never carry it.
      expect(reason).not.toContain('SECRETPATHSEGMENT');
    });
  });

  it('only forwards a migration smoke bypass backed by matching exact-source proof', () => {
    const migrationBootSmokeOverride = {
      sourceSha,
      proofRef: 'WI-10003146#exact-source-pass',
      reason: 'Frozen source has the old aggregate Vitest deadline',
    };
    expect(buildCutEnv({}, sourceSha, { ownerName: 'Avi', migrationBootSmokeOverride }))
      .toHaveProperty('PAPERCUSP_SKIP_MIGRATION_BOOTSMOKE', '1');
    expect(buildCutEnv({}, sourceSha, runtime)).not.toHaveProperty('PAPERCUSP_SKIP_MIGRATION_BOOTSMOKE');
    expect(() => buildCutEnv({}, sourceSha, {
      ownerName: 'Avi',
      migrationBootSmokeOverride: { ...migrationBootSmokeOverride, sourceSha: 'a'.repeat(40) },
    })).toThrow(/source_mismatch/);
    expect(() => buildCutEnv({}, sourceSha, {
      ownerName: 'Avi',
      migrationBootSmokeOverride: { ...migrationBootSmokeOverride, proofRef: ' ' },
    })).toThrow(/evidence_required/);
  });

  it('refuses a missing runtime owner identity before constructing a cut command', () => {
    expect(() => buildCutEnv({}, sourceSha, { ownerName: '   ' })).toThrow(/release_owner_name_required/);
  });
});

describe('buildCutArgv', () => {
  const sourceSha = '1feac8dd867c6566af834445a58b5a2e43b14649';
  const root = '/root/papercusp-desktop';
  const rootLog = cutLogFor(undefined, root);
  const rootDone = cutDoneFor(undefined, root);
  const rootStarted = cutStartedFor(undefined, root);
  const argv = buildCutArgv(
    root,
    '0.0.8',
    'alpha',
    { mac: true },
    sourceSha,
    '/usr/bin:/bin',
    { ownerName: "Avi O'Neil" },
    undefined,
    '/current/papercusp-desktop',
  );
  const inner = argv[argv.length - 1];

  it('targets the dedicated detached unit + desktop working dir', () => {
    expect(argv).toContain(`--unit=${CUT_UNIT}`);
    expect(argv).toContain('--working-directory=/root/papercusp-desktop');
    expect(argv).toContain('--setenv=PATH=/usr/bin:/bin');
  });
  it.each([undefined, ...PLATFORMS])('accepts the readiness child for platform %s', (platform) => {
    for (const releaseTaskId of [undefined, 'readinesstask']) {
      const readinessArgv = buildCutArgv(
        root,
        '0.0.8',
        'alpha',
        {},
        sourceSha,
        '/usr/bin:/bin',
        {
          ownerName: 'Avi',
          releaseTaskId,
          releaseOperationId: releaseTaskId ? 'readiness-operation' : undefined,
        },
        platform,
      );
      // systemd defaults Type=notify to NotifyAccess=main, which rejects the
      // systemd-notify child and times out even after the cutter has started.
      expect(readinessArgv).toContain('--property=Type=notify');
      expect(readinessArgv).toContain('--property=NotifyAccess=all');
      const command = readinessArgv.at(-1)!;
      const notifyAt = command.indexOf('systemd-notify --ready || exit $?;');
      expect(notifyAt).toBeGreaterThan(command.indexOf(`> ${cutStartedFor(platform, root)}`));
      expect(notifyAt).toBeGreaterThan(command.indexOf('flock -n 9'));
      expect(notifyAt).toBeLessThan(command.indexOf('PAPERCUSP_PUBLISH_GITHUB='));
    }
  });
  it('runs the cutter LOCAL-only, clears the stale sentinel, records the exit code', () => {
    expect(inner).toContain(`rm -f ${rootDone}`);
    expect(inner).toContain(`> ${rootStarted}`);
    expect(inner).toContain(`ln -sfn '${rootLog}' '${CUT_LOG}'`);
    expect(inner).toContain(`ln -sfn '${rootDone}' '${CUT_DONE}'`);
    expect(inner).toContain(`ln -sfn '${rootStarted}' '${CUT_STARTED}'`);
    expect(inner).toContain("PAPERCUSP_PUBLISH_GITHUB='0'");
    expect(inner).toContain(`PAPERCUSP_EXPECTED_SOURCE_SHA='${sourceSha}'`);
    expect(inner).toContain(`PAPERCUSP_RELEASE_OWNER_NAME='Avi O'\"'\"'Neil'`);
    expect(inner).toContain("DEPENDENCY_GENERATION_FORCE_COPY='1'");
    expect(inner).toContain("PAPERCUSP_SKIP_DEP_GENERATION='1'");
    expect(inner).toContain("PAPERCUSP_SKIP_MOBILE='1'");
    expect(inner).toContain("WITH_MAC='1'");
    expect(inner).toContain(`bash -c 'source "$1" "$2" "$3"'`);
    expect(inner).toContain("'/root/papercusp-desktop/bin/release-local.sh'");
    expect(inner).toContain("'/current/papercusp-desktop/bin/release-local.sh' '0.0.8' 'alpha'");
    expect(inner).toContain(`> ${rootLog} 2>&1`);
    expect(inner).toContain(`echo "DONE:$?" > ${rootDone}`);
  });
  it('never pushes a tag or creates a GitHub release', () => {
    expect(inner).not.toMatch(/gh release/);
    expect(inner).not.toMatch(/push origin/);
    expect(inner).not.toContain('PAPERCUSP_PUBLISH_GITHUB=1');
  });
  it('seedless skips seed cutting without applying retry-only version restoration', () => {
    const seedlessArgv = buildCutArgv(
      '/root/papercusp-desktop',
      '0.0.8',
      'alpha',
      {},
      sourceSha,
      '/usr/bin:/bin',
      { ownerName: 'Avi', seedless: true },
    );
    const seedlessInner = seedlessArgv[seedlessArgv.length - 1];
    expect(seedlessInner).toContain("PAPERCUSP_SKIP_SEED_CUT='1'");
    expect(seedlessInner).toContain("PAPERCUSP_ALLOW_SEEDLESS_RELEASE='1'");
    expect(seedlessInner).toContain(`PAPERCUSP_ALLOW_SEEDLESS_REASON='release:cut seedless:true source=${sourceSha};`);
    expect(seedlessInner).not.toContain('git restore -- package.json');
  });
  it('full-history is rendered into the detached command as a present-empty value', () => {
    const fullHistoryArgv = buildCutArgv('/root/papercusp-desktop', '0.0.8', 'alpha', {}, sourceSha, '/usr/bin:/bin', {
      ownerName: 'Avi',
      fullHistory: true,
    });
    expect(fullHistoryArgv[fullHistoryArgv.length - 1]).toContain("PAPERCUSP_SEED_DEPTH=''");
  });
});

describe('readCutStatus', () => {
  const noFiles = { existsSync: () => false, readFileSync: () => '', isUnitActive: () => false };

  it('running while the unit is active (no exit code yet)', () => {
    const s = readCutStatus({ ...noFiles, isUnitActive: () => true });
    expect(s.state).toBe('running');
    expect(s.running).toBe(true);
    expect(s.exitCode).toBeNull();
  });
  it('done on DONE:0 once the unit is inactive', () => {
    const s = readCutStatus({
      isUnitActive: () => false,
      existsSync: (p) => p === CUT_DONE,
      readFileSync: () => 'DONE:0\n',
    });
    expect(s.state).toBe('done');
    expect(s.exitCode).toBe(0);
  });
  it('failed on a non-zero exit code', () => {
    const s = readCutStatus({
      isUnitActive: () => false,
      existsSync: (p) => p === CUT_DONE,
      readFileSync: () => 'DONE:1',
    });
    expect(s.state).toBe('failed');
    expect(s.exitCode).toBe(1);
  });
  it('idle when nothing is running and no sentinel exists', () => {
    expect(readCutStatus(noFiles).state).toBe('idle');
  });
  it('interrupted when a launched unit stops before writing its DONE sentinel', () => {
    const s = readCutStatus({
      isUnitActive: () => false,
      existsSync: (p) => p === CUT_STARTED,
      readFileSync: () => 'STARTED:1723708996',
    });
    expect(s.state).toBe('interrupted');
    expect(s.running).toBe(false);
    expect(s.exitCode).toBeNull();
  });
  it('surfaces the last log lines when a log exists', () => {
    const log = Array.from({ length: 60 }, (_, i) => `line${i}`).join('\n');
    const s = readCutStatus({
      isUnitActive: () => true,
      existsSync: (p) => p === CUT_LOG,
      readFileSync: () => log,
    });
    expect(s.logTail).toContain('line59');
    expect(s.logTail).not.toContain('line0\n'); // trimmed to the tail
  });
  it('skips the build log when reconciling bounded terminal-marker evidence', () => {
    const root = '/tmp/desktop-root';
    const started = cutStartedFor('linux', root);
    const done = cutDoneFor('linux', root);
    const log = cutLogFor('linux', root);
    const reads: string[] = [];
    const s = readCutStatus({
      root,
      platform: 'linux',
      includeLogTail: false,
      isUnitActive: () => false,
      existsSync: (p) => p === started || p === done || p === log,
      readFileSync: (p) => {
        reads.push(p);
        if (p === started) return 'STARTED:1\nOPERATION:op-1\nTASK:task1\n';
        if (p === done) return 'DONE:1';
        return 'large build log';
      },
    });
    expect(s.state).toBe('failed');
    expect(s.operation).toMatchObject({ taskId: 'task1', operationId: 'op-1' });
    expect(s.logTail).toBeNull();
    expect(reads).toEqual([started, done]);
    expect(reads).not.toContain(log);
  });
});

describe('isReleaseArtifact', () => {
  it('matches installer/updater extensions across platforms', () => {
    for (const n of [
      'papercusp-gui_0.0.8_amd64.AppImage',
      'papercusp-gui_0.0.8_amd64.deb',
      'Papercusp GUI_0.0.8_universal.app.tar.gz',
      'Papercusp GUI_0.0.8_x64-setup.exe',
      'Papercusp Server_0.0.8_x64-setup-1.bin', // Inno disk-spanning payload slice (WI-4243)
      'Papercusp Server_0.0.8_x64-setup-12.bin',
    ]) {
      expect(isReleaseArtifact(n)).toBe(true);
    }
    expect(isReleaseArtifact('serve.mjs')).toBe(false);
    expect(isReleaseArtifact('build-provenance.json')).toBe(false);
    expect(isReleaseArtifact('random.bin')).toBe(false); // only -setup-N.bin slices, not any .bin
  });
});

describe('isUpdaterArtifact', () => {
  it('only the updater-feed types require a .sig; native installers do not', () => {
    expect(isUpdaterArtifact('Papercusp GUI.app.tar.gz')).toBe(true);
    expect(isUpdaterArtifact('papercusp-gui_0.0.8_amd64.AppImage')).toBe(true);
    expect(isUpdaterArtifact('app_0.0.8_x64.nsis.zip')).toBe(true);
    expect(isUpdaterArtifact('Papercusp GUI_0.0.8_universal-apple-darwin.dmg')).toBe(false);
    expect(isUpdaterArtifact('Papercusp Server_0.0.8_x64-setup.exe')).toBe(false);
    expect(isUpdaterArtifact('Papercusp Server_0.0.8_x64-setup-1.bin')).toBe(false);
    expect(isUpdaterArtifact('papercusp-gui_0.0.8_amd64.deb')).toBe(false);
  });
});

describe('collectHandoff', () => {
  const root = '/fake/desktop';
  const targetRoot = `${root}/src-tauri/target`;
  const bundle = `${targetRoot}/release/bundle`;
  const appimage = `${bundle}/appimage/papercusp-gui_0.0.8_amd64.AppImage`;
  const deb = `${bundle}/deb/papercusp-gui_0.0.8_amd64.deb`;
  const tree = [
    appimage,
    `${appimage}.sig`,
    deb, // deb has NO .sig → unsigned (informational — deb is not an updater artifact)
    `${bundle}/appimage/papercusp-gui_0.0.7_amd64.AppImage`, // OLD version → excluded
    `${targetRoot}/release/latest.json`,
    `${bundle}/appimage/build-provenance.json`,
    `${targetRoot}/release/deps/papercusp-gui_0.0.8_amd64.AppImage`, // not in a bundle/ dir → excluded
    `${targetRoot}/release/serve.mjs`, // not an artifact
  ];
  // Single-root deps: no relocated cargo target dir, provenance unreadable (walk-only).
  const deps = {
    exists: (p: string) => p === targetRoot || tree.includes(p),
    listFiles: () => tree,
    fileSize: () => 1024,
    sha256: (p: string) => `sha(${p})`,
    readFile: () => '{}',
    cargoTargetRoot: () => null,
    realpath: (p: string) => p,
  };

  it('collects only version-scoped, in-bundle artifacts + their sig/manifest/provenance', () => {
    const h = collectHandoff('0.0.8', { root }, deps);
    expect(h.found).toBe(true);
    expect(h.scannedRoots).toEqual([targetRoot]);
    const names = h.artifacts.map((a) => a.name).sort();
    expect(names).toEqual(['papercusp-gui_0.0.8_amd64.AppImage', 'papercusp-gui_0.0.8_amd64.deb']);
    // old version + non-bundle + serve.mjs are all excluded
    expect(names).not.toContain('papercusp-gui_0.0.7_amd64.AppImage');
    expect(h.manifests).toEqual([`${targetRoot}/release/latest.json`]);
    expect(h.provenance).toEqual([`${bundle}/appimage/build-provenance.json`]);
  });
  it('an unsigned NON-updater artifact (deb) is informational, not a blocker (WI-4243)', () => {
    const h = collectHandoff('0.0.8', { root }, deps);
    const appEntry = h.artifacts.find((a) => a.name.endsWith('.AppImage'))!;
    const debEntry = h.artifacts.find((a) => a.name.endsWith('.deb'))!;
    expect(appEntry.signed).toBe(true);
    expect(debEntry.signed).toBe(false);
    expect(h.unsignedNames).toEqual([]); // deb is not an updater artifact → no blocker
    expect(h.unsignedInfoNames).toEqual(['papercusp-gui_0.0.8_amd64.deb']);
    expect(appEntry.sha256).toBe(`sha(${appimage})`);
  });
  it('an unsigned UPDATER artifact (AppImage) IS a blocker', () => {
    const noSig = tree.filter((f) => f !== `${appimage}.sig`);
    const h = collectHandoff('0.0.8', { root }, { ...deps, exists: (p) => p === targetRoot || noSig.includes(p), listFiles: () => noSig });
    expect(h.unsignedNames).toEqual(['papercusp-gui_0.0.8_amd64.AppImage']);
    expect(h.unsignedInfoNames).toEqual(['papercusp-gui_0.0.8_amd64.deb']);
  });
  it('found:false when no scannable root exists', () => {
    const h = collectHandoff('0.0.8', { root }, { ...deps, exists: () => false });
    expect(h.found).toBe(false);
    expect(h.scannedRoots).toEqual([]);
    expect(h.artifacts).toEqual([]);
  });

  it('collects the windows Inno setup.exe AND its -setup-N.bin payload slices; their missing sigs are informational (WI-4243)', () => {
    const inno = `${targetRoot}/windows-vm/bundle/inno`;
    const winTree = [
      `${inno}/Papercusp GUI_0.0.8_x64-setup.exe`,
      `${inno}/Papercusp Server_0.0.8_x64-setup.exe`,
      `${inno}/Papercusp Server_0.0.8_x64-setup-1.bin`,
      `${inno}/Papercusp Server_0.0.8_x64-setup-2.bin`,
    ];
    const h = collectHandoff('0.0.8', { root }, { ...deps, exists: (p) => p === targetRoot || winTree.includes(p), listFiles: () => winTree });
    expect(h.artifacts.map((a) => a.name).sort()).toEqual([
      'Papercusp GUI_0.0.8_x64-setup.exe',
      'Papercusp Server_0.0.8_x64-setup-1.bin',
      'Papercusp Server_0.0.8_x64-setup-2.bin',
      'Papercusp Server_0.0.8_x64-setup.exe',
    ]);
    expect(h.unsignedNames).toEqual([]); // none of these are updater artifacts
    expect(h.unsignedInfoNames).toHaveLength(4);
  });

  it('provenance pass catches the VERSIONLESS mac .app.tar.gz updater tarballs (subpath names, WI-4243)', () => {
    const macBundle = `${targetRoot}/universal-apple-darwin/release/bundle`;
    const dmg = `${macBundle}/dmg/Papercusp GUI_0.0.8_universal-apple-darwin.dmg`;
    const tgz = `${macBundle}/macos/Papercusp GUI.app.tar.gz`;
    const prov = `${macBundle}/build-provenance.json`;
    const macTree = [dmg, tgz, `${tgz}.sig`, prov];
    const provJson = JSON.stringify({
      version: '0.0.8',
      artifacts: [
        { name: 'dmg/Papercusp GUI_0.0.8_universal-apple-darwin.dmg', sig: false },
        { name: 'macos/Papercusp GUI.app.tar.gz', sig: true },
      ],
    });
    const h = collectHandoff('0.0.8', { root }, {
      ...deps,
      exists: (p) => p === targetRoot || macTree.includes(p),
      listFiles: () => macTree,
      readFile: (p) => (p === prov ? provJson : '{}'),
    });
    const names = h.artifacts.map((a) => a.name).sort();
    // dmg via the walk (version in name); the versionless tarball ONLY via provenance.
    expect(names).toEqual(['Papercusp GUI_0.0.8_universal-apple-darwin.dmg', 'macos/Papercusp GUI.app.tar.gz']);
    const tgzEntry = h.artifacts.find((a) => a.name.endsWith('.app.tar.gz'))!;
    expect(tgzEntry.path).toBe(tgz);
    expect(tgzEntry.signed).toBe(true);
    expect(h.unsignedNames).toEqual([]); // dmg unsigned is informational
    expect(h.unsignedInfoNames).toEqual(['Papercusp GUI_0.0.8_universal-apple-darwin.dmg']);
  });

  it('provenance pass resolves PRE-fix basename-only names via a unique basename match under the provenance dir', () => {
    const macBundle = `${targetRoot}/universal-apple-darwin/release/bundle`;
    const tgz = `${macBundle}/macos/Papercusp GUI.app.tar.gz`;
    const prov = `${macBundle}/build-provenance.json`;
    const macTree = [tgz, `${tgz}.sig`, prov];
    const provJson = JSON.stringify({ version: '0.0.8', artifacts: [{ name: 'Papercusp GUI.app.tar.gz' }] });
    const h = collectHandoff('0.0.8', { root }, {
      ...deps,
      exists: (p) => p === targetRoot || macTree.includes(p),
      listFiles: () => macTree,
      readFile: (p) => (p === prov ? provJson : '{}'),
    });
    expect(h.artifacts).toHaveLength(1);
    expect(h.artifacts[0]!.path).toBe(tgz);
    expect(h.artifacts[0]!.signed).toBe(true);
  });

  it('a provenance for a DIFFERENT version contributes nothing', () => {
    const macBundle = `${targetRoot}/universal-apple-darwin/release/bundle`;
    const tgz = `${macBundle}/macos/Papercusp GUI.app.tar.gz`;
    const prov = `${macBundle}/build-provenance.json`;
    const macTree = [tgz, prov];
    const provJson = JSON.stringify({ version: '0.0.7', artifacts: [{ name: 'macos/Papercusp GUI.app.tar.gz' }] });
    const h = collectHandoff('0.0.8', { root }, {
      ...deps,
      exists: (p) => p === targetRoot || macTree.includes(p),
      listFiles: () => macTree,
      readFile: (p) => (p === prov ? provJson : '{}'),
    });
    expect(h.found).toBe(false);
    expect(h.artifacts).toEqual([]);
  });

  it('scans the relocated cargo target_directory as a SECOND root (the linux leg, WI-4243)', () => {
    const cargoRoot = '/fake/cargo-target';
    const linuxDeb = `${cargoRoot}/release/bundle/deb/papercusp-gui_0.0.8_amd64.deb`;
    const linuxTree = [linuxDeb, `${linuxDeb}.sig`];
    const h = collectHandoff('0.0.8', { root }, {
      ...deps,
      cargoTargetRoot: () => cargoRoot,
      exists: (p) => p === targetRoot || p === cargoRoot || tree.includes(p) || linuxTree.includes(p),
      listFiles: (d) => (d === cargoRoot ? linuxTree : tree),
    });
    expect(h.scannedRoots).toEqual([targetRoot, cargoRoot]);
    expect(h.artifacts.some((a) => a.path === linuxDeb)).toBe(true);
    const linuxEntry = h.artifacts.find((a) => a.path === linuxDeb)!;
    expect(linuxEntry.signed).toBe(true);
  });

  it('de-dupes the cargo root when it is the SAME tree as src-tauri/target (realpath)', () => {
    let listCalls = 0;
    const h = collectHandoff('0.0.8', { root }, {
      ...deps,
      cargoTargetRoot: () => '/fake/cargo-target',
      exists: (p) => p === targetRoot || p === '/fake/cargo-target' || tree.includes(p),
      realpath: () => '/real/shared-target', // both roots resolve to one tree
      listFiles: () => {
        listCalls++;
        return tree;
      },
    });
    expect(h.scannedRoots).toHaveLength(1);
    expect(listCalls).toBe(1);
    expect(h.artifacts).toHaveLength(2); // no duplicated artifacts
  });
});

const dependencySource = 'a'.repeat(64);
const dependencyReady = {
  readDependencyGeneration: () => `v1-${dependencySource}`,
  runModelCachePreflight: () => ({ exitCode: 0, output: 'fixture model cache ready' }),
  runSourceIdentityPreflight: () => ({ exitCode: 0, output: 'fixture source identity clean' }),
  runWindowsInputPreflight: () => ({ exitCode: 0, output: 'fixture Windows inputs ready' }),
};

describe('Windows input readiness (EI-27527354796036349)', () => {
  const root = '/frozen/papercusp-desktop';
  const orchestratorRoot = '/current/papercusp-desktop';
  const deps = { ...dependencyReady, home: '/home/tester', exists: () => true, isUnitActive: () => false };

  it.each([1, null])('blocks on verifier exit %s before a Windows cut can launch', (exitCode) => {
    const runWindowsInputPreflight = vi.fn(() => ({ exitCode, output: 'stamp has no bunArchiveSha256' }));
    const result = preflightCut({ windows: true }, { root, orchestratorRoot }, { ...deps, runWindowsInputPreflight });
    expect(runWindowsInputPreflight).toHaveBeenCalledExactlyOnceWith(`${orchestratorRoot}/bin/lib/wsl-rootfs-preflight.sh`, root);
    expect(result.go).toBe(false);
    expect(result.blockers.join('\n')).toMatch(/windows-inputs: .*bunArchiveSha256/);
  });

  it('admits verified Windows inputs and skips the probe for non-Windows cuts', () => {
    const runWindowsInputPreflight = vi.fn(dependencyReady.runWindowsInputPreflight);
    expect(preflightCut({ windows: true }, { root }, { ...deps, runWindowsInputPreflight }).go).toBe(true);
    runWindowsInputPreflight.mockClear();
    expect(preflightCut({ mac: true }, { root }, { ...deps, runWindowsInputPreflight }).go).toBe(true);
    expect(runWindowsInputPreflight).not.toHaveBeenCalled();
  });

  it('uses the async runner for the read-only Windows probe and fails closed on rejection', async () => {
    const specs: ProbeSpec[] = [];
    const result = await preflightCutAsync({ windows: true }, { root, orchestratorRoot }, {
      ...deps, runWindowsInputPreflight: undefined, runSmokeTargetPreflight: () => ({ exitCode: 0, output: 'ready' }),
    }, async (spec) => { specs.push(spec); throw new Error('Windows probe failed'); });
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ command: 'bash', timeoutMs: 120_000 });
    expect(specs[0]!.args).toContain(`${orchestratorRoot}/bin/lib/wsl-rootfs-preflight.sh`);
    expect(specs[0]!.args).toContain(root);
    expect(specs[0]!.args.join(' ')).toContain('--read-only');
    expect(result.go).toBe(false);
    expect(result.blockers.join('\n')).toContain('Windows probe failed');
  });

  it('refuses an old orchestrator helper before it can ignore read-only and hydrate the target', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'release-old-wsl-helper-'));
    const lib = path.join(ws, 'bin', 'lib');
    fs.mkdirSync(lib, { recursive: true });
    const marker = path.join(ws, 'hydrated');
    fs.writeFileSync(path.join(lib, 'wsl-rootfs-preflight.sh'), 'papercusp_wsl_rootfs_preflight() { touch "$1/hydrated"; }\n');
    try {
      const result = await preflightCutAsync({ windows: true }, { root: ws, orchestratorRoot: ws }, {
        ...deps, runWindowsInputPreflight: undefined, runSmokeTargetPreflight: () => ({ exitCode: 0, output: 'ready' }),
      });
      expect(result.go).toBe(false);
      expect(result.blockers.join('\n')).toContain('does not support read-only readiness');
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('refuses a real frozen-style stamp without changing the selected resources', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'release-windows-readiness-'));
    const target = path.join(ws, 'target', 'papercusp-desktop');
    const res = path.join(target, 'src-tauri', 'resources');
    fs.mkdirSync(res, { recursive: true });
    const stamp = JSON.stringify({ rootfsSha256: 'a'.repeat(64), recipeSha256: 'b'.repeat(64) });
    fs.writeFileSync(path.join(res, '.rootfs-build-stamp'), stamp);
    fs.writeFileSync(path.join(res, 'papercup-runtime.tar.gz'), 'frozen rootfs');
    const current = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../papercusp-desktop');
    try {
      const before = fs.readdirSync(res);
      const result = await preflightCutAsync({ windows: true }, { root: target, orchestratorRoot: current }, {
        ...deps, runWindowsInputPreflight: undefined, runSmokeTargetPreflight: () => ({ exitCode: 0, output: 'ready' }),
      });
      expect(result.go).toBe(false);
      expect(result.blockers.join('\n')).toMatch(/windows-inputs: .*has no bunArchiveSha256/);
      expect(fs.readdirSync(res)).toEqual(before);
      expect(fs.readFileSync(path.join(res, '.rootfs-build-stamp'), 'utf8')).toBe(stamp);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

// EI-27109514509838099: the release:cut handler ran preflightCut's spawnSync probes on the
// operator's main thread (three source-identity guards measured 21.6s back to back), and
// the event-loop sentinel SIGKILLed the host at its 20s wedge limit mid-call.
describe('preflightCutAsync (event-loop-safe preflight, EI-27109514509838099)', () => {
  const root = '/root/papercusp-desktop';
  const workspace = '/root';
  const { runSourceIdentityPreflight: _identity, runModelCachePreflight: _model, ...asyncReady } = dependencyReady;
  const deps = { ...asyncReady, home: '/home/tester', exists: () => true, isUnitActive: () => false };
  const spinner = () => {
    const state = { ticks: 0, spinning: true };
    const spin = (): void => {
      if (!state.spinning) return;
      state.ticks++;
      setImmediate(spin);
    };
    setImmediate(spin);
    return state;
  };

  it('routes every source-identity and model probe through the async runner and reports its results', async () => {
    const specs: ProbeSpec[] = [];
    const run = (spec: ProbeSpec): Promise<SmokeTargetProbe> => {
      specs.push(spec);
      const label = spec.command === 'bash' ? 'model' : path.basename(spec.args[0]!);
      return new Promise((resolve) => setTimeout(() => resolve({ exitCode: 0, output: `async:${label}` }), 20));
    };
    const r = await preflightCutAsync({}, { root }, deps, run);
    const identity = specs.filter((s) => s.command === process.execPath);
    expect(identity.map((s) => s.args[0])).toEqual(SOURCE_IDENTITY_GUARDS.map((g) => path.join(workspace, 'scripts', g)));
    expect(identity.every((s) => s.cwd === workspace && s.timeoutMs === 30_000)).toBe(true);
    expect(specs.filter((s) => s.command === 'bash')).toHaveLength(1);
    for (const guard of SOURCE_IDENTITY_GUARDS) {
      expect(r.checks.find((c) => c.name === `source-identity:${guard}`)).toMatchObject({ ok: true, detail: `async:${guard}` });
    }
    expect(r.checks.find((c) => c.name === 'embedding-models')).toMatchObject({ ok: true, detail: 'async:model' });
  });

  it('surfaces an async probe failure as the same hard blocker the sync path reports', async () => {
    const run = async (spec: ProbeSpec): Promise<SmokeTargetProbe> =>
      spec.args[0]?.endsWith('check-no-box-identity.mjs')
        ? { exitCode: 1, output: 'box identity leaked' }
        : { exitCode: 0, output: 'clean' };
    const r = await preflightCutAsync({}, { root }, deps, run);
    expect(r.go).toBe(false);
    expect(r.blockers.join('\n')).toMatch(/source-identity:check-no-box-identity\.mjs: .*exit 1.*box identity leaked/);
  });

  it('runProbeSpecAsync keeps the event loop serving while the child runs, and reports exit, timeout and spawn failure like spawnSync', async () => {
    const loop = spinner();
    const done = await runProbeSpecAsync({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => { console.log("probe-out"); process.exit(3); }, 300)'],
      timeoutMs: 10_000,
    });
    loop.spinning = false;
    expect(done.exitCode).toBe(3);
    expect(done.output).toContain('probe-out');
    // spawnSync would have starved the loop for the whole 300ms child.
    expect(loop.ticks).toBeGreaterThan(10);

    const timedOut = await runProbeSpecAsync({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'], timeoutMs: 200 });
    expect(timedOut.exitCode).toBeNull();
    expect(timedOut.output).toMatch(/timed out after 200ms/);

    const missing = await runProbeSpecAsync({ command: '/nonexistent/papercusp-probe-binary', args: [], timeoutMs: 1_000 });
    expect(missing.exitCode).toBeNull();
  });

  describe('release-tag network probe (20s ls-remote bound = the sentinel limit)', () => {
    const sourceSha = 'b'.repeat(40);
    const release = { version: '0.0.32', channel: 'alpha' as const, sourceSha };
    const tag = 'desktop-v0.0.32-alpha';
    const tagRun = (answer: SmokeTargetProbe, specs: ProbeSpec[] = []) =>
      async (spec: ProbeSpec): Promise<SmokeTargetProbe> => {
        specs.push(spec);
        return spec.command === 'git' ? answer : { exitCode: 0, output: 'clean' };
      };

    it('prefetches git ls-remote through the async runner and passes a tag at sourceSha', async () => {
      const specs: ProbeSpec[] = [];
      const r = await preflightCutAsync({}, { root, release }, deps,
        tagRun({ exitCode: 0, output: `warning: redirecting to elsewhere\n${sourceSha}\trefs/tags/${tag}\n` }, specs));
      const git = specs.filter((s) => s.command === 'git');
      expect(git).toHaveLength(1);
      expect(git[0]!.args).toEqual(['-C', workspace, 'ls-remote', '--refs', '--tags', DOGFOOD_CANONICAL_REMOTE, `refs/tags/${tag}`]);
      expect(git[0]!.timeoutMs).toBe(20_000);
      expect(r.checks.find((c) => c.name === 'release-tag')).toMatchObject({ ok: true });
    });

    it('a remote that answered without the tag is the hard missing-tag blocker', async () => {
      const r = await preflightCutAsync({}, { root, release }, deps, tagRun({ exitCode: 0, output: '' }));
      expect(r.go).toBe(false);
      expect(r.blockers.join('\n')).toMatch(/release-tag: .*desktop-v0\.0\.32-alpha is missing .*prepare-tag/);
    });

    it.each([128, null])('a failed or timed-out probe (exit %s) is WARN-only UNMEASURED, never "missing"', async (exitCode) => {
      const r = await preflightCutAsync({}, { root, release }, deps,
        tagRun({ exitCode, output: 'fatal: unable to access remote' }));
      const check = r.checks.find((c) => c.name === 'release-tag')!;
      expect(check).toMatchObject({ ok: false, warnOnly: true });
      expect(check.detail).toMatch(/could NOT read .*UNMEASURED/);
      expect(r.blockers.some((b) => b.startsWith('release-tag'))).toBe(false);
    });

    it('a deferred tag never probes the network', async () => {
      const specs: ProbeSpec[] = [];
      await preflightCutAsync({}, { root, release, deferTag: true }, deps, tagRun({ exitCode: 0, output: '' }, specs));
      expect(specs.some((s) => s.command === 'git')).toBe(false);
    });

    it('parseRemoteTagSha only accepts a full-sha line naming the exact tag', () => {
      expect(parseRemoteTagSha({ exitCode: 0, output: `${'c'.repeat(40)}\trefs/tags/${tag}-rc\n` }, tag)).toBeNull();
      expect(parseRemoteTagSha({ exitCode: 0, output: `deadbeef\trefs/tags/${tag}\n` }, tag)).toBeNull();
      expect(parseRemoteTagSha({ exitCode: 0, output: `${'c'.repeat(40)}\trefs/tags/${tag}\n` }, tag)).toBe('c'.repeat(40));
      expect(() => parseRemoteTagSha({ exitCode: null, output: 'probe timed out after 20000ms' }, tag)).toThrow(/unmeasured.*timed out/);
    });
  });

  it('the release:cut tool handler never calls the synchronous preflightCut', () => {
    const handler = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent-tools', 'release', 'cut.ts'), 'utf8');
    expect(handler).not.toMatch(/\bpreflightCut\s*\(/);
    expect(handler).toMatch(/await preflightCutAsync\(/);
  });
});

describe('preflightCut', () => {
  const root = '/root/papercusp-desktop';
  const home = '/home/tester';
  const key = `${home}/.papercusp/signing/papercusp.key`;
  const cutter = `${root}/bin/release-local.sh`;
  const scripts = [
    `${root}/bin/verify-provenance.sh`,
    `${root}/bin/vm-preflight.sh`,
    `${root}/bin/install-and-relaunch-verify.sh`,
  ];
  const migrationLintEntrypoint = '/root/node_modules/@papercusp/operator-core/lib/util/cli-entry.ts';
  const allPresent = new Set([key, cutter, migrationLintEntrypoint, ...scripts]);

  it('go:true when key + cutter + scripts present and no cut in flight', () => {
    const r = preflightCut({}, { root }, { ...dependencyReady, home, exists: (p) => allPresent.has(p), isUnitActive: () => false });
    expect(r.go).toBe(true);
    expect(r.blockers).toEqual([]);
  });
  it('a missing cutter or signing key is a HARD blocker', () => {
    const noCutter = preflightCut({}, { root }, { ...dependencyReady, home, exists: (p) => allPresent.has(p) && p !== cutter, isUnitActive: () => false });
    expect(noCutter.go).toBe(false);
    expect(noCutter.blockers.join()).toMatch(/cutter/);

    const noKey = preflightCut({}, { root }, { ...dependencyReady, home, exists: (p) => allPresent.has(p) && p !== key, isUnitActive: () => false });
    expect(noKey.go).toBe(false);
    expect(noKey.blockers.join()).toMatch(/signing-key/);
  });
  it('a source-only checkout missing the migration-lint runtime is a HARD blocker', () => {
    const r = preflightCut({}, { root }, {
      ...dependencyReady,
      home,
      exists: (p) => allPresent.has(p) && p !== migrationLintEntrypoint,
      isUnitActive: () => false,
    });
    expect(r.go).toBe(false);
    expect(r.blockers.join()).toMatch(/migration-lint-dependencies/);
    expect(r.checks.find((c) => c.name === 'migration-lint-dependencies')!.detail).toContain(
      'before dependency preparation',
    );
  });
  it.each([1, null])('blocks an unavailable model cache (probe exit %s)', (exitCode) => {
    const result = preflightCut({}, { root }, { ...dependencyReady, home,
      exists: (p) => allPresent.has(p), isUnitActive: () => false,
      runModelCachePreflight: () => ({ exitCode, output: 'required embedding models missing' }),
    });
    expect(result.go).toBe(false);
    expect(result.blockers.join()).toContain('embedding-models');
    expect(result.checks.find((c) => c.name === 'embedding-models')?.warnOnly).toBeUndefined();
  });
  it('uses the real model helper to reject absent and partial weights before admitting a complete cache', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-model-cache-'));
    const desktop = path.join(workspace, 'papercusp-desktop');
    const helper = path.join(desktop, 'bin', 'lib', 'transformers-models.sh');
    const cache = path.join(workspace, "model cache's pack");
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.copyFileSync(fileURLToPath(new URL('../../../papercusp-desktop/bin/lib/transformers-models.sh', import.meta.url)), helper);
    vi.stubEnv('PAPERCUSP_TRANSFORMERS_MODEL_CACHE', cache);
    const check = () => preflightCut({}, { root: desktop }, {
      ...dependencyReady, runModelCachePreflight: undefined, home,
      exists: () => true, isUnitActive: () => false,
      releaseToolingDrift: () => ({ state: 'current', staleFiles: [] }),
    });
    try {
      expect(check().blockers.join()).toContain('embedding-models');
      const names = spawnSync('bash', [helper, 'names'], { encoding: 'utf8' }).stdout.trim().split('\n');
      for (const name of names) {
        const weights = path.join(cache, 'onnx-community', name, 'onnx');
        fs.mkdirSync(weights, { recursive: true });
        fs.writeFileSync(path.join(weights, 'model.onnx'), 'fixture header');
        fs.writeFileSync(path.join(weights, 'model.onnx_data.part'), 'partial');
      }
      expect(check().blockers.join()).toContain('embedding-models');
      for (const name of names) fs.writeFileSync(path.join(cache, 'onnx-community', name, 'onnx', 'model.onnx_data'), 'complete');
      expect(check().go).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
  it('a missing verify script is WARN-only (cut can still run)', () => {
    const r = preflightCut({}, { root }, { ...dependencyReady, home, exists: (p) => allPresent.has(p) && p !== scripts[0], isUnitActive: () => false });
    expect(r.go).toBe(true); // warnOnly does not block
    expect(r.checks.find((c) => c.name.includes('verify-provenance'))!.ok).toBe(false);
  });
  describe('mandatory selected-source identity gate', () => {
    const guards = [
      'check-no-owner-name-tags.mjs',
      'check-no-box-identity.mjs',
      'check-no-identity-literals.mjs',
    ];
    const base = { ...dependencyReady, home, exists: () => true, isUnitActive: () => false,
      releaseToolingDrift: () => ({ state: 'current' as const, staleFiles: [] }),
    };
    it.each(guards.flatMap((script) => [1, null].map((exitCode) => [script, exitCode] as const)))(
      'blocks %s exit %s and still measures every guard', (failedScript, exitCode) => {
        const runSourceIdentityPreflight = vi.fn((scriptPath: string) => ({
          exitCode: path.basename(scriptPath) === failedScript ? exitCode : 0,
          output: 'selected target scan',
        }));
        const result = preflightCut({}, { root, orchestratorRoot: '/current/papercusp-desktop' }, {
          ...base, runSourceIdentityPreflight,
        });
        expect(result.go).toBe(false);
        expect(result.blockers.join()).toContain(`source-identity:${failedScript}`);
        expect(result.checks.find((c) => c.name === `source-identity:${failedScript}`)?.warnOnly).toBeUndefined();
        expect(runSourceIdentityPreflight.mock.calls).toEqual(guards.map((script) => [
          path.join('/root', 'scripts', script), '/root',
        ]));
      },
    );
    it('reports every guard even when the runner throws', () => {
      const runSourceIdentityPreflight = vi.fn(() => { throw new Error('guard spawn unavailable'); });
      const result = preflightCut({}, { root }, { ...base, runSourceIdentityPreflight });
      expect(result.go).toBe(false);
      expect(result.blockers.filter((c) => c.includes('source-identity:'))).toHaveLength(3);
      expect(runSourceIdentityPreflight).toHaveBeenCalledTimes(3);
      expect(result.checks.find((c) => c.name === `source-identity:${guards[0]}`)?.detail).toContain('guard spawn unavailable');
    });
    it('executes only the selected target guards in its workspace and refuses missing scripts', () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cut identity's target-"));
      const desktop = path.join(workspace, 'papercusp-desktop');
      const orchestrator = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-identity-current-'));
      const leak = path.join(workspace, 'source-leak.txt');
      for (const dir of [workspace, orchestrator]) fs.mkdirSync(path.join(dir, 'scripts'));
      const check = () => preflightCut({}, {
        root: desktop, orchestratorRoot: path.join(orchestrator, 'papercusp-desktop'),
      }, { ...base, runSourceIdentityPreflight: undefined });
      try {
        for (const script of guards) {
          fs.writeFileSync(path.join(workspace, 'scripts', script),
            "import fs from 'node:fs'; console.log(process.cwd()); process.exitCode = fs.existsSync('source-leak.txt') ? 1 : 0;\n");
          fs.writeFileSync(path.join(orchestrator, 'scripts', script), 'process.exit(0);\n');
        }
        fs.writeFileSync(leak, 'selected source still carries a leak');
        const blocked = check();
        expect(blocked.go).toBe(false);
        expect(blocked.blockers.filter((c) => c.includes('source-identity:'))).toHaveLength(3);
        expect(blocked.checks.find((c) => c.name === `source-identity:${guards[1]}`)?.detail).toContain(workspace);
        fs.unlinkSync(leak);
        expect(check().go).toBe(true);
        fs.unlinkSync(path.join(workspace, 'scripts', guards[1]));
        const missing = check();
        expect(missing.go).toBe(false);
        expect(missing.blockers.join()).toContain(`source-identity:${guards[1]}`);
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(orchestrator, { recursive: true, force: true });
      }
    });
  });
  describe('exact release tag (EI-24611322499942803)', () => {
    const sourceSha = 'b'.repeat(40);
    const release = { version: '0.0.25', channel: 'alpha' as const, sourceSha };
    const base = { ...dependencyReady, home, exists: (p: string) => allPresent.has(p), isUnitActive: () => false };

    it('names the exact tag the cutter verifies', () => {
      expect(desktopReleaseTag('0.0.25', 'alpha')).toBe('desktop-v0.0.25-alpha');
      expect(desktopReleaseTag('1.2.3', 'stable')).toBe('desktop-v1.2.3');
    });
    it('a MISSING remote tag is a HARD blocker that names prepare-tag', () => {
      const calls: Array<[string, string, string]> = [];
      const r = preflightCut({}, { root, release }, {
        ...base,
        remoteTagSha: (monorepo, tag, remote) => {
          calls.push([monorepo, tag, remote]);
          return null;
        },
      });
      expect(calls).toEqual([['/root', 'desktop-v0.0.25-alpha', DOGFOOD_CANONICAL_REMOTE]]);
      expect(r.go).toBe(false);
      expect(r.blockers.join()).toMatch(/release-tag: .*desktop-v0\.0\.25-alpha is missing .*prepare-tag/);
    });
    it('approved tag deferral never probes refs and retains signing and in-flight blockers', () => {
      const remoteTagSha = vi.fn(() => { throw new Error('must not probe deferred refs'); });
      const r = preflightCut({}, { root, release, deferTag: true }, { ...base, remoteTagSha });
      expect(r.go).toBe(true);
      expect(remoteTagSha).not.toHaveBeenCalled();
      expect(r.checks.find((c) => c.name === 'release-tag')?.detail).toContain('Candidate/GO/publication remain blocked');
      const blocked = preflightCut({}, { root, release, deferTag: true }, {
        ...base, remoteTagSha, exists: (p) => allPresent.has(p) && p !== key, isUnitActive: () => true,
      });
      expect(blocked.go).toBe(false);
      expect(blocked.blockers.join()).toMatch(/signing-key/);
      expect(blocked.blockers.join()).toMatch(/no-cut-in-flight/);
      expect(remoteTagSha).not.toHaveBeenCalled();
    });
    it('a tag pointing at another commit is a HARD blocker', () => {
      const r = preflightCut({}, { root, release }, { ...base, remoteTagSha: () => 'c'.repeat(40) });
      expect(r.go).toBe(false);
      expect(r.blockers.join()).toMatch(/release-tag: .*points at cccccccccccc, not sourceSha bbbbbbbbbbbb/);
    });
    it('a tag at sourceSha passes', () => {
      const r = preflightCut({}, { root, release }, { ...base, remoteTagSha: () => sourceSha });
      expect(r.go).toBe(true);
      expect(r.checks.find((c) => c.name === 'release-tag')).toMatchObject({ ok: true });
    });
    it('an unreadable remote is WARN-only and says UNMEASURED', () => {
      const r = preflightCut({}, { root, release }, {
        ...base,
        remoteTagSha: () => {
          throw new Error('fatal: unable to access');
        },
      });
      expect(r.go).toBe(true);
      const check = r.checks.find((c) => c.name === 'release-tag')!;
      expect(check).toMatchObject({ ok: false, warnOnly: true });
      expect(check.detail).toContain('UNMEASURED');
    });
    it('without a release subject the remote is never read', () => {
      let called = false;
      const r = preflightCut({}, { root }, { ...base, remoteTagSha: () => { called = true; return null; } });
      expect(called).toBe(false);
      expect(r.checks.some((c) => c.name === 'release-tag')).toBe(false);
    });
    it('release-local.sh checks the same remote BEFORE the precheck exit and the first manifest write', () => {
      const cutter = fs.readFileSync(
        fileURLToPath(new URL('../../../papercusp-desktop/bin/release-local.sh', import.meta.url)),
        'utf8',
      );
      expect(cutter).toContain(`PAPERCUP_DOGFOOD_CANONICAL_REMOTE="${DOGFOOD_CANONICAL_REMOTE}"`);
      const precondition = cutter.indexOf('_dogfood_pin_remote_sha="$(release_tag_remote_sha');
      const precheckExit = cutter.indexOf('if [[ "${PAPERCUSP_RELEASE_PRECHECK_ONLY:-0}" == "1" ]]; then');
      const firstBump = cutter.indexOf('bump_version_manifests "$ROOT"');
      expect(precondition).toBeGreaterThan(-1);
      expect(precheckExit).toBeGreaterThan(precondition);
      expect(firstBump).toBeGreaterThan(precheckExit);
    });
  });
  it('a cut already in flight is a HARD blocker', () => {
    const r = preflightCut({}, { root }, { ...dependencyReady, home, exists: (p) => allPresent.has(p), isUnitActive: (u) => u === CUT_UNIT });
    expect(r.go).toBe(false);
    expect(r.blockers.join()).toMatch(/no-cut-in-flight/);
  });
  it('requested mac/windows legs add an informational VM reminder', () => {
    const r = preflightCut({ mac: true, windows: true }, { root }, { ...dependencyReady, home, exists: (p) => allPresent.has(p), isUnitActive: () => false });
    expect(r.go).toBe(true);
    expect(r.checks.some((c) => c.name === 'leg:mac')).toBe(true);
    expect(r.checks.some((c) => c.name === 'leg:windows')).toBe(true);
  });
  describe('native smoke targets (WI-10004346)', () => {
    const orchestratorRoot = '/orch/papercusp-desktop';
    const detector = `${orchestratorRoot}/bin/smoke-target-preflight.sh`;
    const withDetector = (p: string) => allPresent.has(p) || p === detector;
    const run = (legs: { mac?: boolean; windows?: boolean }, probes: Record<string, { exitCode: number | null; output: string }>) => {
      const calls: string[] = [];
      const r = preflightCut(legs, { root, orchestratorRoot }, {
        ...dependencyReady,
        home,
        exists: withDetector,
        isUnitActive: () => false,
        runSmokeTargetPreflight: (script, platform) => {
          expect(script).toBe(detector);
          calls.push(platform);
          return probes[platform];
        },
      });
      return { r, calls };
    };
    it('probes only the requested legs, and READY is ok', () => {
      const { r, calls } = run({ mac: true }, { mac: { exitCode: 0, output: 'SMOKE_TARGET_READY mac' } });
      expect(calls).toEqual(['mac']);
      expect(r.checks.find((c) => c.name === 'smoke-target:mac')!.ok).toBe(true);
      expect(r.checks.some((c) => c.name === 'smoke-target:windows')).toBe(false);
    });
    it('NOT-READY / STOPPED / unmeasured are surfaced as warnings, never blockers', () => {
      const { r } = run({ mac: true, windows: true }, {
        mac: { exitCode: 2, output: 'SMOKE_TARGET_BLOCKER baseline-missing: no 0.0.27 GUI\nSMOKE_TARGET_NOT_READY mac' },
        windows: { exitCode: 3, output: 'windows VM stopped\nboot: systemctl --user start windows-vm.service' },
      });
      expect(r.go).toBe(true);
      const mac = r.checks.find((c) => c.name === 'smoke-target:mac')!;
      expect(mac).toMatchObject({ ok: false, warnOnly: true });
      expect(mac.detail).toMatch(/NOT-READY.*baseline-missing/);
      const win = r.checks.find((c) => c.name === 'smoke-target:windows')!;
      expect(win).toMatchObject({ ok: false, warnOnly: true });
      expect(win.detail).toMatch(/STOPPED.*systemctl --user start windows-vm/);

      const timedOut = run({ mac: true }, { mac: { exitCode: null, output: '' } }).r;
      expect(timedOut.checks.find((c) => c.name === 'smoke-target:mac')!.detail).toMatch(/UNMEASURED/);
      expect(timedOut.go).toBe(true);
    });
    it('a missing detector is reported as unmeasured, not READY, and nothing is run', () => {
      const r = preflightCut({ windows: true }, { root, orchestratorRoot }, {
        ...dependencyReady,
        home,
        exists: (p) => allPresent.has(p),
        isUnitActive: () => false,
        runSmokeTargetPreflight: () => { throw new Error('must not run'); },
      });
      const c = r.checks.find((x) => x.name === 'smoke-target:windows')!;
      expect(c).toMatchObject({ ok: false, warnOnly: true });
      expect(c.detail).toMatch(/UNMEASURED/);
    });
  });
  it('a per-leg in-flight check looks at that platform\'s OWN unit, not the whole-cut one', () => {
    // The whole-cut unit is active, but we're preflighting the 'mac' LEG — a distinct unit —
    // so this must NOT be blocked by an unrelated whole-cut run.
    const r = preflightCut({}, { root, platform: 'mac' }, { ...dependencyReady, home, exists: (p) => allPresent.has(p), isUnitActive: (u) => u === CUT_UNIT });
    expect(r.go).toBe(true);
    expect(r.checks.find((c) => c.name === 'no-cut-in-flight')!.detail).toContain('no cut in flight');

    // Conversely, the mac leg's OWN unit being active DOES block it.
    const blocked = preflightCut({}, { root, platform: 'mac' }, { ...dependencyReady, home, exists: (p) => allPresent.has(p), isUnitActive: (u) => u === cutUnitFor('mac') });
    expect(blocked.go).toBe(false);
    expect(blocked.blockers.join()).toMatch(/no-cut-in-flight/);
  });
});

describe('preflight dependency-generation contract', () => {
  const validMarker = `identity=v1-${dependencySource}\nsource=${dependencySource}\n`;
  const orchestratorRoot = fileURLToPath(new URL('../../../papercusp-desktop', import.meta.url));

  it.each([
    ['missing', undefined, false],
    ['empty', '', false],
    ['malformed', 'identity=v1-invalid\nsource=invalid\n', false],
    ['mismatched', `identity=v1-${'b'.repeat(64)}\nsource=${dependencySource}\n`, false],
    ['duplicate identity', `${validMarker}identity=v1-${dependencySource}\n`, false],
    ['duplicate source', `${validMarker}source=${dependencySource}\n`, false],
    ['valid', validMarker, true],
    ['valid CRLF', validMarker.replaceAll('\n', '\r\n'), true],
  ] as const)('%s marker is checked before launching a cut', (_label, marker, expectedGo) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-dependency-marker-'));
    try {
      if (marker !== undefined) {
        fs.mkdirSync(path.join(workspace, 'node_modules'));
        fs.writeFileSync(path.join(workspace, 'node_modules', '.papercusp-dependency-generation'), marker);
      }
      const result = preflightCut({}, { root: path.join(workspace, 'papercusp-desktop'), orchestratorRoot }, {
        runModelCachePreflight: dependencyReady.runModelCachePreflight,
        runSourceIdentityPreflight: dependencyReady.runSourceIdentityPreflight,
        exists: () => true,
        isUnitActive: () => false,
        releaseToolingDrift: () => ({ state: 'current', staleFiles: [] }),
      });
      expect(result.go).toBe(expectedGo);
      const check = result.checks.find((entry) => entry.name === 'dependency-generation');
      expect(check?.ok).toBe(expectedGo);
      expect(check?.warnOnly).toBeUndefined();
      if (expectedGo) {
        expect(check?.detail).toContain(`v1-${dependencySource}`);
        expect(result.blockers).toEqual([]);
      } else {
        expect(result.blockers).toHaveLength(1);
        expect(check?.detail).toContain('--prepare-existing --node-modules force --node-modules-copy copy --node-modules-generation required');
        expect(check?.detail).toContain(workspace);
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

// ─── Per-leg (fleet-split) support — WI-4233 ───────────────────────────────────

describe('cutUnitFor / cutLogFor / cutDoneFor', () => {
  it('platform omitted ⇒ the legacy whole-cut triple, unchanged', () => {
    expect(cutUnitFor()).toBe(CUT_UNIT);
    expect(cutLogFor()).toBe(CUT_LOG);
    expect(cutDoneFor()).toBe(CUT_DONE);
  });
  it('each platform gets its own distinct unit/log/done', () => {
    const seen = new Set<string>();
    for (const p of PLATFORMS) {
      const unit = cutUnitFor(p);
      expect(unit).toBe(`${CUT_UNIT}-${p}`);
      expect(cutLogFor(p)).toBe(`/tmp/${unit}.log`);
      expect(cutDoneFor(p)).toBe(`/tmp/${unit}.done`);
      expect(seen.has(unit)).toBe(false);
      seen.add(unit);
    }
  });
  it('keeps explicit roots in distinct stable status paths while rootless helpers remain host-wide', () => {
    const rootA = '/mnt/data/offload/root-a/papercusp-desktop';
    const rootB = '/mnt/data/offload/root-b/papercusp-desktop';
    expect(cutLogFor(undefined, rootA)).toMatch(/^\/tmp\/papercup-release-cut-[a-f0-9]{24}\.log$/);
    expect(cutDoneFor('mac', rootA)).not.toBe(cutDoneFor('mac', rootB));
    expect(cutStartedFor(undefined, rootA)).not.toBe(cutStartedFor(undefined, rootB));
    expect(cutLogFor()).toBe(CUT_LOG);
    expect(cutDoneFor()).toBe(CUT_DONE);
  });
});

describe('legsForPlatform', () => {
  it('maps each platform to exactly its own WITH_* flag (linux needs none)', () => {
    expect(legsForPlatform('linux')).toEqual({});
    expect(legsForPlatform('mac')).toEqual({ mac: true });
    expect(legsForPlatform('windows')).toEqual({ windows: true });
    expect(legsForPlatform('arm64')).toEqual({ arm64: true });
  });
});

// WI-10003515: a cut fired through :3170 sources its orchestration from the staging
// checkout, which papercup-staging-sync re-clones IN PLACE on every staging advance. The
// 0.0.22 mac leg died sourcing bin/lib/source-roots.sh during one such re-clone.
describe('buildCutArgv — a staging-checkout orchestrator holds the staging-sync lock', () => {
  const sourceSha = '1feac8dd867c6566af834445a58b5a2e43b14649';
  const innerFor = (orchestrator: string): string => {
    const argv = buildCutArgv(
      '/ws/papercusp-relcut-0022/papercusp-desktop',
      '0.0.22',
      'alpha',
      { mac: true },
      sourceSha,
      '/usr/bin:/bin',
      { ownerName: 'Avi' },
      undefined,
      orchestrator,
    );
    return argv[argv.length - 1];
  };

  it('recognises only the staging checkouts as re-cloned orchestrator roots', () => {
    expect(orchestratorNeedsStagingSyncLock('/ws/papercusp-staging/papercusp-desktop')).toBe(true);
    expect(orchestratorNeedsStagingSyncLock('/ws/papercup-staging/papercusp-desktop')).toBe(true);
    expect(orchestratorNeedsStagingSyncLock('/ws/papercusp/papercusp-desktop')).toBe(false);
    expect(orchestratorNeedsStagingSyncLock('/ws/papercusp-relcut-0022/papercusp-desktop')).toBe(false);
  });

  it('wraps the cutter in a SHARED, fd-closing, bounded flock on the staging-sync lock', () => {
    const inner = innerFor('/ws/papercusp-staging/papercusp-desktop');
    expect(inner).toContain(
      `flock --shared --close --verbose --timeout 1200 --conflict-exit-code ${STAGING_SYNC_LOCK_TIMEOUT_EXIT} '${STAGING_SYNC_LOCK}' bash -c 'source "$1" "$2" "$3"'`,
    );
    // The root-scoped DONE sentinel still records the wrapped cutter's exit code.
    expect(inner).toContain(`echo "DONE:$?" > ${cutDoneFor(undefined, '/ws/papercusp-relcut-0022/papercusp-desktop')}`);
  });

  it('omits the staging-sync wrapper but retains the logical cut-slot lock for other orchestrators', () => {
    const inner = innerFor('/ws/papercusp/papercusp-desktop');
    expect(inner).not.toContain('flock --shared --close');
    expect(inner).not.toContain(STAGING_SYNC_LOCK);
    expect(inner).toContain(`exec 9>'/tmp/${CUT_UNIT}.lock'; flock -n 9`);
    expect(inner).toContain(`bash -c 'source "$1" "$2" "$3"'`);
  });
});

// Behavioural: run the real wrapper with the real flock(1) against a private lock file, and
// check the three properties the fix depends on, using the exact lock shapes
// sync-staging-checkout.sh (exclusive, non-blocking) and :3170's ExecStartPre (shared) take.
describe.skipIf(process.platform !== 'linux')('wrapWithStagingSyncLock — real flock semantics', () => {
  // Runs one cut under `wrap`, returning what staging-sync / a staging restart observed while
  // it ran and after it exited. A daemon the cut spawned is still alive at the end.
  function runCutScenario(wrap: (command: string, lockPath: string) => string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-staging-lock-'));
    const lock = path.join(dir, 'staging-sync.lock');
    const holding = path.join(dir, 'holding');
    const release = path.join(dir, 'release');
    const daemonPidFile = path.join(dir, 'daemon.pid');
    const trySync = () => spawnSync('bash', ['-c', `exec 9>'${lock}'; flock -n 9`]).status;
    const tryRestart = () => spawnSync('flock', ['-s', '-n', lock, 'true']).status;
    // The "cut": spawn a detached long-lived daemon (as sccache would), signal that the
    // lock is held, then wait for the test to release it.
    const cut =
      // `\$!` survives the OUTER shell's double quotes so the inner cut expands it.
      `sleep 300 </dev/null >/dev/null 2>&1 & echo \\$! > '${daemonPidFile}'; ` +
      `touch '${holding}'; while [ ! -e '${release}' ]; do sleep 0.05; done`;
    const child = spawnSync('bash', ['-c', `${wrap(`bash -c "${cut}"`, lock)} & ` +
      `while [ ! -e '${holding}' ]; do sleep 0.05; done; ` +
      // While the cut runs: staging-sync's exclusive try-lock must fail, a shared restart must pass.
      `exec 9>'${lock}'; if flock -n 9; then echo SYNC=acquired; else echo SYNC=blocked; fi; exec 9>&-; ` +
      `if flock -s -n '${lock}' true; then echo RESTART=ok; else echo RESTART=blocked; fi; ` +
      `touch '${release}'; wait`], { encoding: 'utf8', timeout: 20_000 });
    let daemonPid = 0;
    try {
      daemonPid = Number(fs.readFileSync(daemonPidFile, 'utf8').trim());
      let daemonAlive = true;
      try {
        process.kill(daemonPid, 0);
      } catch {
        daemonAlive = false;
      }
      return { stdout: child.stdout, daemonAlive, syncAfter: trySync(), restartAfter: tryRestart() };
    } finally {
      if (daemonPid > 0) {
        try {
          // Re-verify identity before killing a pid read from a file (pid reuse).
          const cmdline = fs.readFileSync(`/proc/${daemonPid}/cmdline`, 'utf8');
          if (cmdline.split('\x00').slice(0, 2).join(' ') === 'sleep 300') process.kill(daemonPid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('blocks staging-sync, admits a staging restart, and never leaks the lock to a spawned daemon', () => {
    const r = runCutScenario((command, lockPath) => wrapWithStagingSyncLock(command, lockPath, 5));
    expect(r.stdout).toContain('SYNC=blocked');
    expect(r.stdout).toContain('RESTART=ok');
    // The daemon outlived the cut, yet staging-sync can take the lock the moment the cut exits.
    expect(r.daemonAlive).toBe(true);
    expect(r.syncAfter).toBe(0);
    expect(r.restartAfter).toBe(0);
  });

  it('blocks synchronization and coordinated restart during a bounded exclusive window without leaking the lock', () => {
    const r = runCutScenario((command, lockPath) =>
      wrapWithStagingSyncLock(command, lockPath, 1, { mode: 'exclusive', timeoutSec: 5 }));
    expect(r.stdout).toContain('SYNC=blocked');
    expect(r.stdout).toContain('RESTART=blocked');
    expect(r.daemonAlive).toBe(true);
    expect(r.syncAfter).toBe(0);
    expect(r.restartAfter).toBe(0);
  });

  it('expires an exclusive window and releases it before another shared restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-staging-lock-'));
    const lock = path.join(dir, 'staging-sync.lock');
    const holding = path.join(dir, 'holding');
    try {
      const command = wrapWithStagingSyncLock(`sh -c 'touch "${holding}"; sleep 300'`, lock, 1,
        { mode: 'exclusive', timeoutSec: 1 });
      const r = spawnSync('bash', ['-c', `${command} & holder=$!; ` +
        `while [ ! -e '${holding}' ]; do sleep 0.01; done; ` +
        `if flock -s -n '${lock}' true; then echo RESTART=ok; else echo RESTART=blocked; fi; ` +
        'wait "$holder"; status=$?; echo EXIT=$status; ' +
        `if flock -s -n '${lock}' true; then echo AFTER=ok; else echo AFTER=blocked; fi`],
      { encoding: 'utf8', timeout: 20_000 });
      expect(r.error).toBeUndefined();
      expect(r.stdout).toContain('RESTART=blocked');
      expect(r.stdout).toContain('EXIT=124');
      expect(r.stdout).toContain('AFTER=ok');
      expect(spawnSync('flock', ['-n', lock, 'true']).status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('releases an exclusive window when its command fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-staging-lock-'));
    const lock = path.join(dir, 'staging-sync.lock');
    try {
      const command = wrapWithStagingSyncLock('false', lock, 1, { mode: 'exclusive', timeoutSec: 5 });
      expect(spawnSync('bash', ['-c', command]).status).toBe(1);
      expect(spawnSync('flock', ['-n', lock, 'true']).status).toBe(0);
      expect(spawnSync('flock', ['-s', '-n', lock, 'true']).status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([0, -1, 1.5, Infinity, NaN])('refuses an unbounded or invalid exclusive deadline: %s', timeoutSec => {
    expect(() => wrapWithStagingSyncLock('true', '/unused', 1, { mode: 'exclusive', timeoutSec }))
      .toThrow('positive integer timeoutSec');
  });

  it('control: the same scenario DETECTS a wrapper that lets the spawned daemon inherit the lock', () => {
    // Calibrates the instrument above: without --close the daemon keeps staging frozen after
    // the cut exits, and this scenario must be able to see that.
    const leaky = (command: string, lockPath: string) =>
      wrapWithStagingSyncLock(command, lockPath, 5).replace('--close ', '');
    expect(leaky('true', '/x')).not.toContain('--close');
    const r = runCutScenario(leaky);
    expect(r.stdout).toContain('SYNC=blocked');
    expect(r.daemonAlive).toBe(true);
    expect(r.syncAfter).not.toBe(0);
  });

  it('exits with the distinct timeout code when staging-sync holds the lock past the wait', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-staging-lock-'));
    const lock = path.join(dir, 'staging-sync.lock');
    try {
      const r = spawnSync(
        'bash',
        ['-c', `exec 9>'${lock}'; flock -n 9 || exit 99; ${wrapWithStagingSyncLock('true', lock, 1)} 9>&-`],
        { encoding: 'utf8', timeout: 20_000 },
      );
      expect(r.status).toBe(STAGING_SYNC_LOCK_TIMEOUT_EXIT);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildCutArgv with a platform', () => {
  it('targets the per-leg unit + log + done, not the whole-cut ones', () => {
    const root = '/root/papercusp-desktop';
    const argv = buildCutArgv(
      root,
      '0.0.8',
      'alpha',
      { mac: true },
      '1feac8dd867c6566af834445a58b5a2e43b14649',
      '/usr/bin:/bin',
      { ownerName: 'Avi' },
      'mac',
      '/current/papercusp-desktop',
    );
    const inner = argv[argv.length - 1]!;
    const unit = cutUnitFor('mac');
    expect(argv).toContain(`--unit=${unit}`);
    expect(inner).toContain(`rm -f ${cutDoneFor('mac', root)}`);
    expect(inner).toContain(`> ${cutLogFor('mac', root)} 2>&1`);
    expect(inner).toContain(`echo "DONE:$?" > ${cutDoneFor('mac', root)}`);
    expect(inner).not.toContain(CUT_DONE); // sanity: not the bare whole-cut done-file path
  });

  it('reuses verified Linux salvage for a non-Linux leg instead of rebuilding Linux', () => {
    const argv = buildCutArgv(
      '/root/papercusp-desktop',
      '0.0.8',
      'alpha',
      { windows: true },
      '1feac8dd867c6566af834445a58b5a2e43b14649',
      '/usr/bin:/bin',
      { ownerName: 'Avi' },
      'windows',
      '/current/papercusp-desktop',
    );
    const inner = argv[argv.length - 1]!;

    // release-local.sh validates the same-version build-provenance.json before
    // honoring this flag, so this is a verified salvage path rather than a blind
    // skip. The requested Windows leg remains enabled independently.
    expect(inner).toContain("PAPERCUSP_REUSE_LINUX='1'");
    expect(inner).toContain("WITH_WINDOWS='1'");
  });
});

describe('readCutStatus with a platform', () => {
  it('reads that leg\'s own unit/log/done, independent of the whole-cut ones', () => {
    const macDone = cutDoneFor('mac');
    const macLog = cutLogFor('mac');
    const s = readCutStatus({
      platform: 'mac',
      isUnitActive: (u) => u === cutUnitFor('mac'),
      existsSync: (p) => p === macDone || p === macLog,
      readFileSync: (p) => (p === macDone ? 'DONE:0' : 'mac build log'),
    });
    // running:true because isUnitActive matches the mac unit — precedence over the DONE sentinel.
    expect(s.state).toBe('running');
    expect(s.logPath).toBe(macLog);
    expect(s.donePath).toBe(macDone);
    expect(cutStartedFor('mac')).toBe('/tmp/papercup-release-cut-mac.started');
  });
  it('two legs are fully independent — one done, the other still running', () => {
    const done = new Set([cutDoneFor('mac')]);
    const active = new Set([cutUnitFor('windows')]);
    const mac = readCutStatus({
      platform: 'mac',
      isUnitActive: (u) => active.has(u),
      existsSync: (p) => done.has(p),
      readFileSync: () => 'DONE:0',
    });
    const windows = readCutStatus({
      platform: 'windows',
      isUnitActive: (u) => active.has(u),
      existsSync: (p) => done.has(p),
      readFileSync: () => 'DONE:0',
    });
    expect(mac.state).toBe('done');
    expect(windows.state).toBe('running');
  });
  it('reads distinct root-scoped markers so one root cannot report another root\'s active cut', () => {
    const rootA = '/mnt/data/offload/root-a/papercusp-desktop';
    const rootB = '/mnt/data/offload/root-b/papercusp-desktop';
    const startedA = cutStartedFor('linux', rootA);
    const doneA = cutDoneFor('linux', rootA);
    const logA = cutLogFor('linux', rootA);
    const startedB = cutStartedFor('linux', rootB);
    const logB = cutLogFor('linux', rootB);
    const files = new Map<string, string>([
      [startedA, 'STARTED:1\nOPERATION:op-a\nTASK:taska001\n'],
      [doneA, 'DONE:0'],
      [logA, 'root A finished'],
      [startedB, 'STARTED:2\nOPERATION:op-b\nTASK:taskb001\n'],
      [logB, 'root B running'],
    ]);
    const read = (root: string) => readCutStatus({
      root,
      platform: 'linux',
      existsSync: (p) => files.has(p),
      readFileSync: (p) => files.get(p) ?? '',
      isUnitActive: (unit) => unit === cutUnitForTask('taskb001'),
    });

    expect(read(rootA)).toMatchObject({ state: 'done', logPath: logA, donePath: doneA });
    expect(read(rootB)).toMatchObject({ state: 'running', logPath: logB, donePath: cutDoneFor('linux', rootB) });
  });
});

describe('abortLeg', () => {
  it('stops the platform\'s own unit and reports success', () => {
    const stopped: string[] = [];
    const r = abortLeg('windows', { stopUnit: (u) => stopped.push(u) });
    expect(r.stopped).toBe(true);
    expect(r.unit).toBe(cutUnitFor('windows'));
    expect(stopped).toEqual([cutUnitFor('windows')]);
  });
  it('a failing stop (e.g. unit already inactive) reports stopped:false with the reason, not a throw', () => {
    const r = abortLeg('mac', {
      stopUnit: () => {
        throw new Error('Unit papercup-release-cut-mac.service not loaded.');
      },
    });
    expect(r.stopped).toBe(false);
    expect(r.reason).toMatch(/not loaded/);
  });
});

describe('deriveBuildSha', () => {
  it('a clean tree reports the bare short sha, not dirty', () => {
    const info = deriveBuildSha('/root/papercusp-desktop', { gitShortHead: () => 'abc1234', gitDirty: () => false });
    expect(info).toEqual({ sha: 'abc1234', dirty: false });
  });
  it('dirty in EITHER the desktop root or its parent (the superproject) marks the whole thing dirty', () => {
    const dirtyChild = deriveBuildSha('/root/papercusp-desktop', {
      gitShortHead: () => 'abc1234',
      gitDirty: (r) => r === '/root/papercusp-desktop',
    });
    expect(dirtyChild.dirty).toBe(true);
    const dirtyParent = deriveBuildSha('/root/papercusp-desktop', {
      gitShortHead: () => 'abc1234',
      gitDirty: (r) => r === '/root',
    });
    expect(dirtyParent.dirty).toBe(true);
  });
});

describe('gatePath', () => {
  it('is scoped per (version, channel) so different releases never collide', () => {
    expect(gatePath('0.0.8', 'alpha')).toBe('/tmp/papercup-release-gate-0.0.8-alpha.json');
    expect(gatePath('0.0.8', 'alpha')).not.toBe(gatePath('0.0.9', 'alpha'));
    expect(gatePath('0.0.8', 'alpha')).not.toBe(gatePath('0.0.8', 'beta'));
  });
});

describe('readOrCreateGate', () => {
  it('the first caller derives + writes the gate and gets created:true', () => {
    const written: Record<string, string> = {};
    const { gate, created } = readOrCreateGate('0.0.8', 'alpha', 'su-first', {
      exists: (p) => Object.prototype.hasOwnProperty.call(written, p),
      readFileSync: (p) => written[p]!,
      writeFileSyncExclusive: (p, data) => {
        written[p] = data;
      },
      derive: () => ({ sha: 'abc1234', dirty: false }),
    });
    expect(created).toBe(true);
    expect(gate).toMatchObject({ version: '0.0.8', channel: 'alpha', buildSha: 'abc1234', dirty: false, derivedBy: 'su-first' });
    expect(gate.derivedAt).toBeTruthy();
  });
  it('a later caller reads back the SAME gate instead of re-deriving — created:false', () => {
    const existing = {
      version: '0.0.8',
      channel: 'alpha' as const,
      buildSha: 'abc1234',
      dirty: false,
      derivedAt: '2026-07-11T00:00:00.000Z',
      derivedBy: 'su-first',
    };
    const { gate, created } = readOrCreateGate('0.0.8', 'alpha', 'su-second', {
      exists: () => true,
      readFileSync: () => JSON.stringify(existing),
      // If this were called, the test should fail — a later caller must NOT re-derive.
      derive: () => ({ sha: 'DIFFERENT-SHA-would-be-a-bug', dirty: false }),
    });
    expect(created).toBe(false);
    expect(gate).toEqual(existing);
  });
  it('a create race (two first-callers) converges on ONE writer — the loser reads back the winner\'s gate', () => {
    let writeCount = 0;
    const winnerGate = {
      version: '0.0.8',
      channel: 'alpha' as const,
      buildSha: 'winner-sha',
      dirty: false,
      derivedAt: '2026-07-11T00:00:01.000Z',
      derivedBy: 'su-winner',
    };
    const { gate, created } = readOrCreateGate('0.0.8', 'alpha', 'su-loser', {
      exists: () => false, // the loser's own check sees "absent" (race window)...
      readFileSync: () => JSON.stringify(winnerGate),
      writeFileSyncExclusive: () => {
        writeCount++;
        throw new Error('EEXIST: file already exists'); // ...but the exclusive create loses the race
      },
      derive: () => ({ sha: 'loser-sha-would-be-wrong', dirty: false }),
    });
    expect(writeCount).toBe(1);
    expect(created).toBe(false);
    expect(gate.buildSha).toBe('winner-sha'); // reads back the WINNER's sha, not its own derivation
  });
});

/**
 * WI-10002449 — preflight used to check only that release scripts EXIST, never what they
 * CONTAINED, so a cut root frozen weeks ago with superseded tooling returned go:true.
 * Measured on the real paused 0.0.22 root: 187 commits behind, with bin/upload-release.sh
 * at the PRE-fix blob of the stale-artifact bug (EI-23963309971611146). Preflight said go.
 *
 * The check must separate two things a cut tree mixes: product source (pinned on purpose,
 * drift is correct) from release machinery (must be current, drift re-executes old bugs).
 */
describe('release-tooling staleness', () => {
  // Real topology (measured on the paused 0.0.22 root): the cut root is a linked
  // worktree sharing the canonical .git, its submodule is a STANDALONE clone lacking the
  // newer pin, and the shared modules store holds both pins.
  const SUPER = '/cut';
  const SUBJECT = '/cut/papercusp-desktop';
  const COMMON = '/canonical/.git';
  const STORE = '/canonical/.git/modules/papercusp-desktop';
  const SUBJECT_PIN = 'b396279eae52d2b7e96623ee48058423f0e3c9bb';
  const REFERENCE_PIN = '867b7ddf94475461710870d6aa3421bfce73202f';

  /** Keys are `<repo>::<argv joined>`; anything unlisted fails, like a real git would. */
  function fakeGit(table: Record<string, { ok: boolean; stdout: string }>, calls: string[][] = []): GitRunner {
    return (repo, args) => {
      calls.push([repo, ...args]);
      return table[`${repo}::${args.join(' ')}`] ?? { ok: false, stdout: '' };
    };
  }

  const okv = (stdout = '') => ({ ok: true, stdout });
  const FAIL = { ok: false, stdout: '' };

  function behindTable(staleFiles: string[], branch = 'main') {
    return {
      [`${SUBJECT}::rev-parse HEAD`]: okv(`${SUBJECT_PIN}\n`),
      [`${SUPER}::rev-parse ${branch}:papercusp-desktop`]: okv(`${REFERENCE_PIN}\n`),
      [`${SUPER}::rev-parse --path-format=absolute --git-common-dir`]: okv(`${COMMON}\n`),
      [`${STORE}::cat-file -e ${SUBJECT_PIN}^{commit}`]: okv(),
      [`${STORE}::cat-file -e ${REFERENCE_PIN}^{commit}`]: okv(),
      [`${STORE}::diff --name-only ${SUBJECT_PIN} ${REFERENCE_PIN} -- ${RELEASE_TOOLING_SUBTREE}`]:
        okv(staleFiles.join('\n') + (staleFiles.length ? '\n' : '')),
      [`${STORE}::merge-base --is-ancestor ${SUBJECT_PIN} ${REFERENCE_PIN}`]: okv(),
    };
  }
  const drift = (table: Record<string, { ok: boolean; stdout: string }>, calls?: string[][], referenceBranch?: string) =>
    releaseToolingDrift({ subjectDesktopRoot: SUBJECT, referenceBranch, git: fakeGit(table, calls) });

  describe('releaseToolingDrift', () => {
    it('reads the reference from the GREEN BRANCH pin by default, never from a checkout path', () => {
      // Regression for the vacuous version: a checkout-path reference resolved to the
      // :3070 release checkout at the last DEPLOYED green sha — the same sha as a stale
      // cut root — so stale-vs-stale read 'current'. The reference must be a branch ref.
      const calls: string[][] = [];
      const r = drift(behindTable(['bin/upload-release.sh']), calls);
      expect(RELEASE_TOOLING_REFERENCE_BRANCH).toBe('main');
      expect(calls).toContainEqual([SUPER, 'rev-parse', 'main:papercusp-desktop']);
      expect(calls.some((c) => c.includes('staging:papercusp-desktop'))).toBe(false);
      expect(calls.some((c) => c[0] !== SUBJECT && c[1] === 'rev-parse' && c[2] === 'HEAD')).toBe(false);
      expect(r.state).toBe('behind');
    });

    it('a root pinned at the latest green pin is CURRENT however far the integration tip has moved (EI-24294628776810491)', () => {
      // The treadmill: staging's pin moved (a test-rig script edit) after the root was cut
      // from green main. Measuring against staging refused every exact-source cut; the
      // green pin is the reference, so staging's pin must never even be consulted.
      const calls: string[][] = [];
      const r = drift(
        {
          [`${SUBJECT}::rev-parse HEAD`]: okv(`${SUBJECT_PIN}\n`),
          [`${SUPER}::rev-parse main:papercusp-desktop`]: okv(`${SUBJECT_PIN}\n`),
          [`${SUPER}::rev-parse staging:papercusp-desktop`]: okv(`${REFERENCE_PIN}\n`),
        },
        calls,
      );
      expect(r.state).toBe('current');
      expect(r.staleFiles).toEqual([]);
      expect(calls.some((c) => c.includes('staging:papercusp-desktop'))).toBe(false);
    });

    it('honours an explicit reference branch', () => {
      const r = drift(behindTable(['bin/release-local.sh'], 'trunk'), undefined, 'trunk');
      expect(r.state).toBe('behind');
    });

    it('identical pins are current', () => {
      const r = drift({
        [`${SUBJECT}::rev-parse HEAD`]: okv(`${SUBJECT_PIN}\n`),
        [`${SUPER}::rev-parse main:papercusp-desktop`]: okv(`${SUBJECT_PIN}\n`),
      });
      expect(r.state).toBe('current');
      expect(r.staleFiles).toEqual([]);
    });

    it('an ancestor pin with differing bin/ files reads BEHIND, with the files sorted', () => {
      const r = drift(behindTable(['bin/upload-release.sh', 'bin/lib/release-artifacts.sh']));
      expect(r.state).toBe('behind');
      expect(r.staleFiles).toEqual(['bin/lib/release-artifacts.sh', 'bin/upload-release.sh']);
      expect(r.subjectPin).toBe(SUBJECT_PIN);
      expect(r.referencePin).toBe(REFERENCE_PIN);
    });

    it('scopes the diff to the release-machinery subtree, not the whole tree', () => {
      const calls: string[][] = [];
      drift(behindTable(['bin/release-local.sh']), calls);
      const diffCall = calls.find((c) => c.includes('diff'));
      expect(diffCall).toBeDefined();
      // Without the pathspec this would report product-source churn as stale machinery.
      expect(diffCall!.slice(-2)).toEqual(['--', RELEASE_TOOLING_SUBTREE]);
    });

    it('a non-ancestor pin reads DIVERGED, not behind — a deliberate pin may be ahead', () => {
      const table = behindTable(['bin/release-local.sh']);
      table[`${STORE}::merge-base --is-ancestor ${SUBJECT_PIN} ${REFERENCE_PIN}`] = FAIL;
      const r = drift(table);
      expect(r.state).toBe('diverged');
      expect(r.staleFiles).toEqual(['bin/release-local.sh']);
    });

    it('falls back to the subject clone when the shared store lacks a pin', () => {
      const table: Record<string, { ok: boolean; stdout: string }> = {
        ...behindTable([]),
        [`${STORE}::cat-file -e ${REFERENCE_PIN}^{commit}`]: FAIL,
        [`${SUBJECT}::cat-file -e ${SUBJECT_PIN}^{commit}`]: okv(),
        [`${SUBJECT}::cat-file -e ${REFERENCE_PIN}^{commit}`]: okv(),
        [`${SUBJECT}::diff --name-only ${SUBJECT_PIN} ${REFERENCE_PIN} -- ${RELEASE_TOOLING_SUBTREE}`]: okv('bin/upload-release.sh\n'),
        [`${SUBJECT}::merge-base --is-ancestor ${SUBJECT_PIN} ${REFERENCE_PIN}`]: okv(),
      };
      const r = drift(table);
      expect(r.state).toBe('behind');
      expect(r.staleFiles).toEqual(['bin/upload-release.sh']);
    });

    it('no store holding BOTH pins is unknown — it must never read as clean', () => {
      // The trap: git diff against an unresolvable object yields an EMPTY file list,
      // byte-identical to "nothing drifted". The real cut-root submodule is a standalone
      // clone lacking the newer pin, so this is the default outcome without the store.
      const table = behindTable(['bin/upload-release.sh']);
      table[`${STORE}::cat-file -e ${REFERENCE_PIN}^{commit}`] = FAIL;
      const r = drift(table);
      expect(r.state).toBe('unknown');
      expect(r.detail).toMatch(/no object store holds both/);
    });

    it('an unresolvable subject HEAD or branch pin is unknown, naming what failed', () => {
      expect(drift({}).detail).toContain(SUBJECT);
      const noBranch = drift({ [`${SUBJECT}::rev-parse HEAD`]: okv(`${SUBJECT_PIN}\n`) });
      expect(noBranch.state).toBe('unknown');
      expect(noBranch.detail).toMatch(/main branch's pin of papercusp-desktop/);
    });
  });

  describe('preflight check: release-tooling-current', () => {
    const root = '/root/papercusp-desktop';
    const home = '/home/tester';
    const present = new Set([
      `${home}/.papercusp/signing/papercusp.key`,
      `${root}/bin/release-local.sh`,
      '/root/node_modules/@papercusp/operator-core/lib/util/cli-entry.ts',
      `${root}/bin/verify-provenance.sh`,
      `${root}/bin/vm-preflight.sh`,
      `${root}/bin/install-and-relaunch-verify.sh`,
    ]);
    const base = { ...dependencyReady, home, exists: (p: string) => present.has(p), isUnitActive: () => false };
    const withDrift = (d: Partial<ReleaseToolingDrift>, currentCutter = '') =>
      preflightCut(
        {},
        { root },
        {
          ...base,
          releaseToolingDrift: () => ({ state: 'current', staleFiles: [], ...d }) as ReleaseToolingDrift,
          readOrchestratorScript: () => currentCutter,
        },
      );
    const check = (r: ReturnType<typeof preflightCut>) =>
      r.checks.find((c) => c.name === 'release-tooling-current')!;

    it('BEHIND with stale machinery is a HARD blocker that names the files and the remedy', () => {
      const r = withDrift({
        state: 'behind',
        staleFiles: ['bin/lib/release-artifacts.sh', 'bin/upload-release.sh'],
        subjectPin: SUBJECT_PIN,
        referencePin: REFERENCE_PIN,
      });
      expect(r.go).toBe(false);
      expect(r.blockers.join()).toMatch(/release-tooling-current/);
      expect(check(r).detail).toContain('bin/upload-release.sh');
      expect(check(r).detail).toMatch(/setup-release-checkout/); // remedy, not just a complaint
      expect(check(r).warnOnly).toBeUndefined();
    });

    it('BEHIND with product-source drift ONLY is not a blocker — an isolated pin is meant to lag', () => {
      const r = withDrift({ state: 'behind', staleFiles: [] });
      expect(r.go).toBe(true);
      expect(check(r).ok).toBe(true);
      expect(check(r).detail).toMatch(/product-source drift only/);
    });

    it('exact-source cut accepts known frozen scripts only when the current cutter does not execute them', () => {
      const staleFiles = [
        'bin/build-desktop-sidecar.sh',
        'bin/install-and-relaunch-verify.sh',
        'bin/lib/federation-asserts.selftest.sh',
        'bin/live-federation-gate.sh',
        'bin/release-local.sh',
        'bin/vm-rig/boot-headless-current.sh',
      ];
      const current = withDrift(
        { state: 'behind', staleFiles },
        'PAPERCUSP_DESKTOP_TARGET_ROOT="$ROOT" bash "$ORCHESTRATOR_HERE/build-desktop-sidecar.sh"\n',
      );
      expect(current.go).toBe(true);
      expect(check(current).detail).toMatch(/no direct target-tree invocation of these files/);

      const frozen = withDrift({ state: 'behind', staleFiles }, 'bash "$ROOT/bin/build-desktop-sidecar.sh"\n');
      expect(frozen.go).toBe(false);
      expect(frozen.blockers.join()).toContain('bin/build-desktop-sidecar.sh');
    });

    it('cannot waive a frozen script when the current cutter source is unreadable', () => {
      const r = preflightCut(
        {},
        { root },
        {
          ...base,
          releaseToolingDrift: () => ({ state: 'behind', staleFiles: ['bin/build-desktop-sidecar.sh'] }),
          readOrchestratorScript: () => {
            throw new Error('unreadable');
          },
        },
      );
      expect(r.go).toBe(false);
      expect(r.blockers.join()).toContain('bin/build-desktop-sidecar.sh');
    });

    it('DIVERGED is warn-only, so a deliberate pin is surfaced without being refused', () => {
      const r = withDrift({ state: 'diverged', staleFiles: ['bin/release-local.sh'] });
      expect(r.go).toBe(true);
      expect(check(r).ok).toBe(false);
      expect(check(r).warnOnly).toBe(true);
    });

    it('UNKNOWN is surfaced as unmeasured rather than passed off as clean', () => {
      const r = withDrift({ state: 'unknown', detail: 'git diff failed' });
      expect(check(r).ok).toBe(false);
      expect(check(r).warnOnly).toBe(true);
      expect(check(r).detail).toMatch(/UNMEASURED/);
      expect(r.go).toBe(true); // unmeasured must not wedge a cut
    });

    it('CURRENT machinery leaves preflight green', () => {
      const r = withDrift({ state: 'current', subjectPin: REFERENCE_PIN });
      expect(r.go).toBe(true);
      expect(check(r).ok).toBe(true);
    });

    it('a root that is not a git checkout is unmeasured, and never silently clean', () => {
      // No releaseToolingDrift injected: the default path runs, and `exists` reports no
      // .git, so it must decline to answer instead of shelling out or assuming current.
      const r = preflightCut({}, { root }, base);
      expect(check(r).ok).toBe(false);
      expect(check(r).detail).toMatch(/UNMEASURED/);
      expect(r.go).toBe(true);
    });
  });
});

// ─── Managed-release journal identity (P-001) ──────────────────────────────────
// The manual cut path minted no operation id, so release-local.sh's journal never ran
// and an interrupted cut had nothing to resume from. These cover the threading and,
// more importantly, the refusals that keep a half-configured or foreign cut from
// reading as a good one.

describe('buildCutEnv — managed-release journal identity', () => {
  const sourceSha = '1feac8dd867c6566af834445a58b5a2e43b14649';

  it('threads BOTH ids so release-local.sh enables its phase journal', () => {
    const env = buildCutEnv({}, sourceSha, {
      ownerName: 'Avi',
      releaseTaskId: 'task1',
      releaseOperationId: 'op-1',
      enqueuedAtMs: 1_700_000_000_000,
    });
    expect(env.PAPERCUSP_RELEASE_TASK_ID).toBe('task1');
    expect(env.PAPERCUSP_RELEASE_OPERATION_ID).toBe('op-1');
    expect(env.PAPERCUSP_RELEASE_ENQUEUED_AT_MS).toBe('1700000000000');
  });

  it('emits NEITHER id for an unmanaged cut — unchanged pre-P-001 behavior', () => {
    const env = buildCutEnv({}, sourceSha, { ownerName: 'Avi' });
    expect(env).not.toHaveProperty('PAPERCUSP_RELEASE_TASK_ID');
    expect(env).not.toHaveProperty('PAPERCUSP_RELEASE_OPERATION_ID');
    expect(env).not.toHaveProperty('PAPERCUSP_RELEASE_ENQUEUED_AT_MS');
  });

  it('REFUSES a half-set pair at build time instead of failing inside the detached unit', () => {
    // release_task_journal_configure() exits 2 on this, but only after the cut is away —
    // so the caller would see launched:true and learn nothing until it read the log.
    expect(() =>
      buildCutEnv({}, sourceSha, { ownerName: 'Avi', releaseTaskId: 'task1' }),
    ).toThrow(/release_journal_identity_incomplete/);
    expect(() =>
      buildCutEnv({}, sourceSha, { ownerName: 'Avi', releaseOperationId: 'op-1' }),
    ).toThrow(/release_journal_identity_incomplete/);
  });

  it('treats a blank id as absent, so whitespace cannot produce a half-set pair', () => {
    expect(() =>
      buildCutEnv({}, sourceSha, { ownerName: 'Avi', releaseTaskId: '  ', releaseOperationId: 'op-1' }),
    ).toThrow(/release_journal_identity_incomplete/);
    expect(
      buildCutEnv({}, sourceSha, { ownerName: 'Avi', releaseTaskId: '  ', releaseOperationId: '  ' }),
    ).not.toHaveProperty('PAPERCUSP_RELEASE_TASK_ID');
  });

  it('drops a malformed enqueue stamp rather than failing the cut over it', () => {
    for (const bad of [0, -1, Number.NaN, 1.5]) {
      const env = buildCutEnv({}, sourceSha, {
        ownerName: 'Avi',
        releaseTaskId: 'task1',
        releaseOperationId: 'op-1',
        enqueuedAtMs: bad,
      });
      expect(env).not.toHaveProperty('PAPERCUSP_RELEASE_ENQUEUED_AT_MS');
      expect(env.PAPERCUSP_RELEASE_OPERATION_ID).toBe('op-1');
    }
  });
});

describe('managed manual cut reuse evidence', () => {
  const cutter = fs.readFileSync(fileURLToPath(new URL('../../../papercusp-desktop/bin/release-local.sh', import.meta.url)), 'utf8');
  const from = cutter.indexOf('release_task_audit_reuse_expiry() {');
  const to = cutter.indexOf('\nrelease_task_json_field()', from);

  it.each(['fresh', 'expired', 'missing'] as const)('checks %s scan evidence with the actual manual launch environment', (state) => {
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-cut-expiry-'));
    const passedAtUtc = new Date(Date.now() - (state === 'expired' ? 2 * 86_400_000 : 60_000)).toISOString();
    try {
      if (state !== 'missing') {
        const sidecar = path.join(root, 'src-tauri', 'sidecar');
        fs.mkdirSync(sidecar, { recursive: true });
        fs.writeFileSync(path.join(sidecar, '.sidecar-build-stamp'), JSON.stringify({
          releaseIdentityAudit: { schemaVersion: 1, passed: true, scanner: 'audit-release-bundle.py --scan-dir', passedAtUtc },
        }));
      }
      const env = buildCutEnv({}, '1'.repeat(40), { ownerName: 'Test Owner', releaseTaskId: 'test-task', releaseOperationId: 'test-op' });
      const result = spawnSync('bash', ['-c', `set -euo pipefail\nROOT="$1"\n${cutter.slice(from, to)}\nrelease_task_audit_reuse_expiry`, 'test', root], {
        encoding: 'utf8',
        env: { ...process.env, ...env, PAPERCUSP_RELEASE_REUSE_MAX_AGE_SEC: env.PAPERCUSP_RELEASE_REUSE_MAX_AGE_SEC ?? '' },
      });
      if (state === 'fresh') {
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(new Date(Date.parse(passedAtUtc) + 86_400_000).toISOString());
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(state === 'expired' ? /identity scan expired/ : /ENOENT/);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('buildCutArgv — the started marker carries the operation identity', () => {
  const sourceSha = '1feac8dd867c6566af834445a58b5a2e43b14649';
  function inner(runtime: Parameters<typeof buildCutArgv>[6]): string {
    const argv = buildCutArgv('/root/papercusp-desktop', '0.0.8', 'alpha', {}, sourceSha, '/bin', runtime);
    return argv[argv.length - 1];
  }

  it('stamps OPERATION + TASK into the marker a managed cut writes', () => {
    const cmd = inner({ ownerName: 'Avi', releaseTaskId: 'task1', releaseOperationId: 'op-1' });
    expect(cmd).toContain("printf 'STARTED:%s\\nOPERATION:%s\\nTASK:%s\\n'");
    expect(cmd).toContain("'op-1'");
    expect(cmd).toContain("'task1'");
    expect(cmd).toContain(`> ${cutStartedFor(undefined, '/root/papercusp-desktop')}`);
  });

  it('writes the plain timestamp-only marker for an unmanaged cut', () => {
    const cmd = inner({ ownerName: 'Avi' });
    expect(cmd).toContain("printf 'STARTED:%s\\n'");
    expect(cmd).not.toContain('OPERATION:');
  });

  it('single-quotes the ids so a hostile id cannot break out of the wrapper', () => {
    const cmd = inner({ ownerName: 'Avi', releaseTaskId: 'task1', releaseOperationId: "o'p" });
    expect(cmd).toContain(`'o'\"'\"'p'`);
  });
});

describe('parseCutStartedMarker', () => {
  it('reads the identified marker', () => {
    expect(parseCutStartedMarker('STARTED:1700000000\nOPERATION:op-1\nTASK:task1\n')).toEqual({
      operationId: 'op-1',
      taskId: 'task1',
      startedAtSec: 1_700_000_000,
    });
  });

  it('accepts the pre-P-001 timestamp-only marker with null ids, rather than failing', () => {
    // An in-flight cut launched by the older wrapper must stay readable across the upgrade.
    expect(parseCutStartedMarker('STARTED:1700000000\n')).toEqual({
      operationId: null,
      taskId: null,
      startedAtSec: 1_700_000_000,
    });
  });

  it('reports nulls for an unparseable marker instead of throwing', () => {
    expect(parseCutStartedMarker('garbage')).toEqual({
      operationId: null,
      taskId: null,
      startedAtSec: null,
    });
  });
});

describe('readCutStatus — operation marker', () => {
  it('surfaces the identity of the cut that owns the sentinels', () => {
    const s = readCutStatus({
      existsSync: (p: string) => p === CUT_STARTED,
      readFileSync: () => 'STARTED:1700000000\nOPERATION:op-1\nTASK:task1\n',
      isUnitActive: () => false,
    });
    expect(s.state).toBe('interrupted');
    expect(s.operation).toEqual({ operationId: 'op-1', taskId: 'task1', startedAtSec: 1_700_000_000 });
  });

  it('reports a null operation when no cut has started on this host', () => {
    expect(readCutStatus({ existsSync: () => false, isUnitActive: () => false }).operation).toBeNull();
  });

  it('keeps the interrupted verdict when the marker exists but cannot be read', () => {
    // The marker's EXISTENCE is the evidence a cut started; only its identity degrades.
    const s = readCutStatus({
      existsSync: (p: string) => p === CUT_STARTED,
      readFileSync: () => {
        throw new Error('EACCES');
      },
      isUnitActive: () => false,
    });
    expect(s.state).toBe('interrupted');
    expect(s.operation).toEqual({ operationId: null, taskId: null, startedAtSec: null });
  });
});
