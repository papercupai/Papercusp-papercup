import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { installIdentityFixture, prepareIdentityFixture, readNativeHostHealth, selectIdentityFixtureActor } from '../../../scripts/fixtures/dao-workbench-identity.mjs';
import { createDeviceAttestationBody } from '../../../packages/operator-core/lib/identity/attest';
import { verifyEd25519 } from '../../../packages/operator-core/lib/identity/ed25519';
import { invalidateLocalGithubIdentityCache, resolveLocalGithubIdentity } from '../../../packages/operator-core/lib/identity/resolve-local-github-identity';
import { clearOctokitCache } from '../../../packages/operator-core/lib/identity/octokit-client';

let cleanup = () => {};
afterEach(() => cleanup());
describe('native DAO synthetic identity isolation', () => {
  it('refuses installation outside explicit isolated verification', () => {
    expect(() => installIdentityFixture({ kind: 'dao-workbench-synthetic-identity-v1' }, {})).toThrow('isolated');
  });
  it('uses generated private fixtures, intercepts keychain and rejects outbound GitHub operations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dao-fixture-test-'));
    const path = prepareIdentityFixture(dir), fixture = JSON.parse(readFileSync(path, 'utf8'));
    const restore = installIdentityFixture(fixture, { PAPERCUSP_VERIFY_TAURI_ISOLATED: '1' });
    cleanup = () => { restore(); rmSync(dir, { recursive: true, force: true }); };
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const exec = promisify(childProcess.execFile);
    expect((await exec('secret-tool', ['lookup', 'service', 'papercusp-device-keypair', 'account', fixture.keychainId])).stdout).toBe(fixture.device.privateKeyDer);
    await expect(exec('secret-tool', ['store', 'service', 'papercusp-device-keypair', 'account', 'real-owner'])).rejects.toThrow('writes');
    await expect(exec('security', ['find-generic-password'])).rejects.toThrow('writes');
    await expect(exec('gh', ['gist', 'create'])).rejects.toThrow('refuses');
    const token = (await exec('gh', ['auth', 'token'])).stdout.trim();
    const user = await fetch('https://api.github.com/user', { headers: { authorization: 'token ' + token } });
    expect(await user.json()).toEqual({ id: fixture.githubUserId, login: fixture.githubLogin });
    await expect(fetch('https://api.github.com/gists', { method: 'POST' })).rejects.toThrow('outbound');
    await expect(fetch('https://api.github.com/user', { headers: { authorization: 'token real-credential' } })).rejects.toThrow('real GitHub credentials');
  });
  it('rotates two admins and a candidate through the real cached resolver, verified emails and device signatures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dao-hr-actors-test-'));
    const path = prepareIdentityFixture(dir), fixture = JSON.parse(readFileSync(path, 'utf8'));
    const env = { PAPERCUSP_VERIFY_TAURI_ISOLATED: '1', DAO_WORKBENCH_IDENTITY_FIXTURE: path };
    invalidateLocalGithubIdentityCache(); clearOctokitCache();
    const restore = installIdentityFixture(fixture, env);
    cleanup = () => { restore(); invalidateLocalGithubIdentityCache(); clearOctokitCache(); rmSync(dir, { recursive: true, force: true }); };
    const identities = [], publicKeys = new Set<string>(), tokens = new Set<string>();
    // Returning to admin also proves that no stale candidate token/identity leaks.
    for (const name of ['admin', 'approver', 'candidate', 'admin']) {
      selectIdentityFixtureActor(path, name, env);
      const actor = fixture.actors[name];
      const identity = await resolveLocalGithubIdentity();
      expect(identity).toEqual({ kind: 'ok', token: actor.token, githubUserId: actor.githubUserId, githubLogin: actor.githubLogin });
      if (identity.kind !== 'ok') throw new Error('Fixture identity did not resolve');
      const emails = await fetch('https://api.github.com/user/emails', { headers: { Authorization: 'Bearer ' + identity.token } });
      expect(await emails.json()).toEqual([{ email: actor.email, verified: true, primary: true, visibility: 'private' }]);
      const announce = JSON.parse(readFileSync(join(dir, 'announce.json'), 'utf8'));
      expect(announce).toMatchObject({ githubUserId: actor.githubUserId, keychainId: actor.keychainId, devicePubkeyBase64: actor.device.publicKey });
      expect(statSync(join(dir, 'announce.json')).mode & 0o777).toBe(0o600);
      const body = await createDeviceAttestationBody({ keychainId: actor.keychainId, pubkeyBase64: actor.device.publicKey,
        deviceLabel: 'Isolated HR actor', githubUserId: actor.githubUserId, githubLogin: actor.githubLogin });
      const { signature_by_device, ...payload } = body;
      const signature = Buffer.from(signature_by_device, 'base64');
      expect(verifyEd25519(Buffer.from(JSON.stringify(payload)), actor.device.publicKey, signature)).toBe(true);
      const other = fixture.actors[name === 'admin' ? 'candidate' : 'admin'];
      expect(verifyEd25519(Buffer.from(JSON.stringify(payload)), other.device.publicKey, signature)).toBe(false);
      identities.push(identity); publicKeys.add(actor.device.publicKey); tokens.add(actor.token);
    }
    expect(new Set(identities.map(identity => identity.githubUserId)).size).toBe(3);
    expect(publicKeys.size).toBe(3); expect(tokens.size).toBe(3);
    const before = readFileSync(join(dir, 'announce.json'), 'utf8');
    expect(() => selectIdentityFixtureActor(path, 'candidate', {})).toThrow('isolated');
    expect(() => selectIdentityFixtureActor(path, 'unknown', env)).toThrow('Unknown');
    expect(readFileSync(join(dir, 'announce.json'), 'utf8')).toBe(before);
    await expect(fetch(new Request('https://api.github.com/user/emails', { method: 'POST',
      headers: { authorization: 'Bearer ' + fixture.actors.candidate.token } }))).rejects.toThrow('outbound');
  });
  it('signs the canonical binding with the isolated device and rejects altered metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dao-attestation-test-'));
    const fixture = JSON.parse(readFileSync(prepareIdentityFixture(dir), 'utf8'));
    const restore = installIdentityFixture(fixture, { PAPERCUSP_VERIFY_TAURI_ISOLATED: '1' });
    cleanup = () => { restore(); rmSync(dir, { recursive: true, force: true }); };
    const body = await createDeviceAttestationBody({ keychainId: fixture.keychainId,
      pubkeyBase64: fixture.device.publicKey, deviceLabel: 'Isolated native fixture',
      githubUserId: fixture.githubUserId, githubLogin: fixture.githubLogin });
    const { signature_by_device, ...payload } = body;
    const signature = Buffer.from(signature_by_device, 'base64');
    expect(payload).toEqual({ version: 1, device_pubkey: fixture.device.publicKey,
      device_label: 'Isolated native fixture', github_user_id: fixture.githubUserId,
      github_login: fixture.githubLogin, created_at: expect.any(Number) });
    expect(verifyEd25519(Buffer.from(JSON.stringify(payload)), fixture.device.publicKey, signature)).toBe(true);
    expect(verifyEd25519(Buffer.from(JSON.stringify({ ...payload, device_label: 'altered' })), fixture.device.publicKey, signature)).toBe(false);
    expect(verifyEd25519(Buffer.from(JSON.stringify(payload)), fixture.hive.publicKey, signature)).toBe(false);
  });
  it('keeps consecutive fixture keys distinct despite the production keychain cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dao-keychain-cache-test-'));
    let restore = () => {};
    cleanup = () => { restore(); rmSync(dir, { recursive: true, force: true }); };
    const first = JSON.parse(readFileSync(prepareIdentityFixture(join(dir, 'first')), 'utf8'));
    const second = JSON.parse(readFileSync(prepareIdentityFixture(join(dir, 'second')), 'utf8'));
    expect(second.keychainId).not.toBe(first.keychainId);
    for (const fixture of [first, second]) {
      restore = installIdentityFixture(fixture, { PAPERCUSP_VERIFY_TAURI_ISOLATED: '1' });
      try {
        const body = await createDeviceAttestationBody({ keychainId: fixture.keychainId, pubkeyBase64: fixture.device.publicKey,
          deviceLabel: 'Repeated fixture', githubUserId: fixture.githubUserId, githubLogin: fixture.githubLogin });
        const { signature_by_device, ...payload } = body;
        expect(verifyEd25519(Buffer.from(JSON.stringify(payload)), fixture.device.publicKey, Buffer.from(signature_by_device, 'base64'))).toBe(true);
      } finally { restore(); restore = () => {}; }
    }
  });
});

describe('native DAO host identity target', () => {
  async function healthServer(sha: string) {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sha }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture server port');
    return { server, requests, origin: 'http://127.0.0.1:' + address.port };
  }
  async function close(server: Server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  it('reads the isolated host when the caller carries a different operator URL', async () => {
    const isolated = await healthServer('pinned-native-sha'), inherited = await healthServer('release-sha');
    try {
      const result = await readNativeHostHealth({ VERIFY_TAURI_DEV_URL: isolated.origin, PAPERCUSP_OPERATOR_URL: inherited.origin });
      expect(result).toEqual({ origin: isolated.origin, health: { sha: 'pinned-native-sha' } });
      expect(isolated.requests).toEqual(['/api/health']);
      expect(inherited.requests).toEqual([]);
    } finally { await close(isolated.server); await close(inherited.server); }
  });
  it('refuses a missing verifier origin before reading an inherited operator', async () => {
    const inherited = await healthServer('release-sha');
    try {
      await expect(readNativeHostHealth({ PAPERCUSP_OPERATOR_URL: inherited.origin })).rejects.toThrow('VERIFY_TAURI_DEV_URL');
      expect(inherited.requests).toEqual([]);
    } finally { await close(inherited.server); }
  });
});

describe('native DAO viewport launch contract', () => {
  const root = resolve(__dirname, '../../..');
  const exec = promisify(childProcess.execFile);
  async function launch(env: NodeJS.ProcessEnv) {
    try {
      const result = await exec('bash', ['scripts/tauri-surface-verify-dao-workbench.sh'], { cwd: root, env, timeout: 45_000 });
      console.info(result.stdout);
      return result;
    } catch (error) {
      const failure = error as Error & { code?: unknown; signal?: unknown; stdout?: string; stderr?: string };
      failure.message += '\nDAO viewport launcher code=' + String(failure.code) + ' signal=' + String(failure.signal)
        + '\nstdout:\n' + (failure.stdout ?? '').slice(-6000) + '\nstderr:\n' + (failure.stderr ?? '').slice(-6000);
      throw failure;
    }
  }
  function verifier(exitCode = 0, importsExitCode = 0) {
    const dir = mkdtempSync(join(tmpdir(), 'dao-native-launch-'));
    const script = join(dir, 'verifier.sh'), log = join(dir, 'boots.log');
    const imports = join(dir, 'imports.log'), scope = join(dir, 'scope.log');
    const dependencyDonor = join(dir, 'dependency-donor');
    mkdirSync(join(dependencyDonor, 'node_modules', 'fixture'), { recursive: true });
    writeFileSync(join(dependencyDonor, 'node_modules', 'fixture', 'package.json'), '{"name":"fixture","version":"1.0.0"}');
    // This unit measures shell ordering and viewport arguments. The real module
    // graph and real-PG scope are preflighted by the maintained native journey; running that graph
    // in every stubbed launch made this unit expire before its first boot.
    // Intercept only the exact import-check command; all other Node calls run.
    writeFileSync(join(dir, 'node'), '#!/usr/bin/env bash\nset -eu\n'
      + 'if [ "$#" -eq 4 ] && [ "$1" = --import ] && [ "$2" = tsx ] && [ "$3" = "$DAO_NATIVE_IMPORT_ENTRY" ] && [ "$4" = --check-imports ]; then\n'
      + '  printf "%s|%s\\n" "$3" "$4" >> "$DAO_NATIVE_IMPORT_LOG"\n  exit ' + importsExitCode + '\nfi\n'
      + 'exec "$DAO_NATIVE_REAL_NODE" "$@"\n', { mode: 0o700 });
    writeFileSync(join(dir, 'npm'), '#!/usr/bin/env bash\nset -eu\n'
      + 'if [ "$#" -ne 4 ] || [ "$1" != run ] || [ "$2" != test:file ] || [ "$3" != -- ] || [ "$4" != packages/operator-core/lib/dao-workbench-scope.integration.test.ts ]; then exit 91; fi\n'
      + 'printf "%s\\n" "$*" >> "$DAO_NATIVE_SCOPE_LOG"\n', { mode: 0o700 });
    writeFileSync(script, '#!/usr/bin/env bash\nset -eu\nprintf "%s|%s|%s|%s|%s|%s|%s|%s\\n" "$VERIFY_TAURI_WINDOW" "$DAO_WORKBENCH_VIEWPORT" "$VERIFY_TAURI_ISOLATED_DB" "$VERIFY_TAURI_ISOLATED_SEED" "$*" "$PAPERCUSP_TEST_RUN_WORKSPACE" "$PAPERCUSP_TEST_RUN_HARNESS" "$PAPERCUSP_REPO_DIR" >> "$DAO_NATIVE_BOOT_LOG"\nexit ' + exitCode + '\n', { mode: 0o700 });
    cleanup = () => rmSync(dir, { recursive: true, force: true });
    return { log, imports, scope, dependencyDonor, env: { ...process.env, TAURI_SURFACE_VERIFY_SUITE_VERIFIER: script, DAO_NATIVE_BOOT_LOG: log,
      PAPERCUSP_REPO_DIR: dependencyDonor,
      PATH: dir + ':' + process.env.PATH, DAO_NATIVE_REAL_NODE: process.execPath,
      DAO_NATIVE_IMPORT_ENTRY: join(root, 'scripts/tauri-surface-verify-dao-workbench.mts'), DAO_NATIVE_IMPORT_LOG: imports,
      DAO_NATIVE_SCOPE_LOG: scope,
      DAO_WORKBENCH_HARNESS_EVIDENCE_ROOT: join(dir, 'evidence'),
      PAPERCUSP_TEST_RUN_WORKSPACE: 'dao-native-ledger-fixture', PAPERCUSP_TEST_RUN_HARNESS: 'papercusp' } };
  }
  it('boots separate isolated desktop and narrow windows through the maintained verifier', async () => {
    const fixture = verifier();
    await launch(fixture.env);
    expect(readFileSync(fixture.scope, 'utf8').trim()).toBe('run test:file -- packages/operator-core/lib/dao-workbench-scope.integration.test.ts');
    expect(readFileSync(fixture.imports, 'utf8').trim()).toBe(fixture.env.DAO_NATIVE_IMPORT_ENTRY + '|--check-imports');
    const boots = readFileSync(fixture.log, 'utf8').trim().split('\n');
    expect(boots).toHaveLength(2);
    expect(boots[0]).toMatch(/^1440x1000\|1440x1000\|1\|ready\|/);
    expect(boots[0]).not.toContain('--viewport-only');
    expect(boots[0]).toContain('--e2e');
    expect(boots[0]).toContain('|dao-native-ledger-fixture|papercusp');
    expect(boots[1]).toMatch(/^390x844\|390x844\|1\|ready\|/);
    expect(boots[1]).toContain('--viewport-only');
    expect(boots[1]).toContain('--e2e');
    expect(boots[1]).toContain('|dao-native-ledger-fixture|papercusp');
    for (const boot of boots) expect(boot.endsWith('|' + fixture.dependencyDonor)).toBe(true);
    const manifest = JSON.parse(readFileSync(join(fixture.env.DAO_WORKBENCH_HARNESS_EVIDENCE_ROOT, 'latest/result.json'), 'utf8'));
    expect(manifest.verdict).toBe('pass');
    expect(manifest.phases.map((phase: { status: string }) => phase.status)).toEqual(['passed', 'passed', 'passed']);
  }, 50_000);
  it('rejects linked clone dependencies before imports or either native boot and names the supported donor override', async () => {
    const fixture = verifier();
    // A real package entry, not a disposable cache: pinned-deps.sh skips its
    // caches set (.cache/.astro/.vite/...) before the strict link guard, so a
    // cache-named link would pass preflight and never exercise this refusal.
    symlinkSync(join(fixture.dependencyDonor, 'node_modules', 'fixture'), join(fixture.dependencyDonor, 'node_modules', 'linked-fixture'));
    const failure = await launch(fixture.env).catch(error => error);
    expect(failure).toMatchObject({ code: 2,
      stderr: expect.stringContaining('absolute-pinned-dependency-link:node_modules/linked-fixture') });
    expect(failure).toMatchObject({
      stderr: expect.stringContaining('set PAPERCUSP_REPO_DIR to the canonical dependency donor') });
    expect(existsSync(fixture.imports)).toBe(false);
    expect(existsSync(fixture.log)).toBe(false);
  }, 50_000);
  it('stops before the narrow boot when desktop acceptance fails', async () => {
    const fixture = verifier(17);
    await expect(launch(fixture.env))
      .rejects.toMatchObject({ code: 17 });
    expect(readFileSync(fixture.log, 'utf8').trim().split('\n')).toHaveLength(1);
  }, 50_000);
  it('stops before either native boot when the maintained import check fails', async () => {
    const fixture = verifier(0, 23);
    await expect(launch(fixture.env)).rejects.toMatchObject({ code: 23 });
    expect(readFileSync(fixture.imports, 'utf8').trim()).toBe(fixture.env.DAO_NATIVE_IMPORT_ENTRY + '|--check-imports');
    expect(existsSync(fixture.log)).toBe(false);
  }, 50_000);
  it('refuses an unscoped result ledger before booting a native window', async () => {
    const fixture = verifier();
    const env = { ...fixture.env } as NodeJS.ProcessEnv;
    delete env.PAPERCUSP_TEST_RUN_WORKSPACE;
    delete env.PAPERCUSP_WORKSPACE_ID;
    delete env.PAPERCUSP_WORKSPACE;
    await expect(launch(env))
      .rejects.toMatchObject({ code: 2 });
    expect(existsSync(fixture.log)).toBe(false);
  }, 50_000);
});
