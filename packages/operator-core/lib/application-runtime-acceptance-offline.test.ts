import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (n: number) => String(n).repeat(64);
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = Buffer.from('1234567890abcdef', 'hex');
  const raw = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
  return { privateKey, keyId, key: Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64') };
}
function signed(bytes: Buffer, key: ReturnType<typeof keypair>) {
  const sig = sign(null, createHash('blake2b512').update(bytes).digest(), key.privateKey);
  const block = Buffer.concat([Buffer.from('ED'), key.keyId, sig]).toString('base64');
  const comment = 'runtime eligibility';
  const global = sign(null, Buffer.concat([sig, Buffer.from(comment)]), key.privateKey).toString('base64');
  return Buffer.from(`untrusted comment: fixture\n${block}\ntrusted comment: ${comment}\n${global}\n`).toString('base64');
}
function fixture(options: { unpinned?: boolean; expired?: boolean; attacker?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-offline-'));
  roots.push(root);
  const sidecar = join(root, 'sidecar'); mkdirSync(sidecar);
  writeFileSync(join(sidecar, 'frozen-package'), 'immutable signed bytes');
  const releaseKey = keypair();
  const request = { harnessSlug: 'papercusp', evidenceRef: 'candidate.json', role: 'host', candidate: {
    candidateSha256: sha(1), sourceSha: 'a'.repeat(40), entrypoint: '/package/serve.mjs', entrypointSha256: sha(2), roles: ['host'],
    node: { name: 'node', executable: '/package/node', binarySha256: sha(3), version: '24.18.1', platform: 'linux', arch: 'x64' },
    bun: { name: 'bun', executable: '/package/bun', binarySha256: sha(4), version: '1.4.4', platform: 'linux', arch: 'x64' },
  } };
  const envelope = Buffer.from(JSON.stringify({ schemaVersion: 'application-runtime-acceptance/v1',
    planSlug: 'node-to-bun-staged-migration-2026-10-22', harnessSlug: 'papercusp', canonicalSnapshotHash: sha(9),
    issuedAt: Date.now() - 2000, acceptance: { verdict: 'accepted', evidenceRef: request.evidenceRef,
      candidateSha256: sha(1), sourceSha: 'a'.repeat(40), role: 'host', binarySha256: sha(4),
      nodeBinarySha256: sha(3), entrypointSha256: sha(2), validUntil: Date.now() + (options.expired ? -1000 : 60000) } }));
  const signer = options.attacker ? keypair() : releaseKey;
  const input = join(root, 'detached.json'); writeFileSync(input, envelope);
  writeFileSync(input + '.sig', signed(envelope, signer));
  const runner = join(root, 'verify.mjs');
  const subject = fileURLToPath(new URL('./application-runtime-acceptance-offline.ts', import.meta.url));
  const built = buildSync({ entryPoints: [subject], outfile: runner, bundle: true, platform: 'node', format: 'esm',
    metafile: true, logLevel: 'silent', define: options.unpinned ? {} : {
      __PAPERCUSP_RUNTIME_ACCEPTANCE_PUBLIC_KEY__: JSON.stringify(releaseKey.key),
    } });
  const args = join(root, 'request.json'); writeFileSync(args, JSON.stringify(request));
  const run = (operation = 'read') => spawnSync(process.execPath, ['--input-type=module', '-e', `
    import * as subject from ${JSON.stringify('file://' + runner)};
    import { readFileSync } from 'node:fs';
    try {
      const request = JSON.parse(readFileSync(process.argv[1], 'utf8'));
      const result = ${operation === 'install' ? 'await subject.installApplicationRuntimeAcceptance(process.argv[3], process.argv[3]+".sig", process.argv[2])'
        : 'await subject.readInstalledApplicationRuntimeAcceptance(request, process.argv[2])'};
      console.log(JSON.stringify(result));
    } catch (e) { console.error(e.message); process.exitCode = 42; }
  `, args, sidecar, input], { encoding: 'utf8', timeout: 10000, env: {
    // These plausible runtime overrides must have no authority.
    PAPERCUSP_RUNTIME_ACCEPTANCE_PUBLIC_KEY: signer.key,
    DATABASE_URL: 'postgres://unreachable:1/no-database',
  } });
  return { root, sidecar, input, args, request, run, inputs: Object.keys(built.metafile!.inputs) };
}

describe('compiled detached eligibility at installed boot', () => {
  it('installs outside frozen bytes and verifies in a fresh process without a PG dependency', () => {
    const f = fixture();
    const installed = f.run('install'); expect(installed.status, installed.stderr).toBe(0);
    expect(JSON.parse(installed.stdout)).toMatchObject({ candidateSha256: sha(1) });
    expect(readFileSync(join(f.sidecar, 'frozen-package'), 'utf8')).toBe('immutable signed bytes');
    expect(existsSync(join(f.root, 'runtime-acceptance', sha(1) + '.json'))).toBe(true);
    const result = f.run(); expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ verdict: 'accepted', candidateSha256: sha(1) });
    expect(f.inputs.some(path => /acceptance-bar-contract|spec-evidence-store|org-pg|postgres|pg-pool/.test(path))).toBe(false);
  });
  it.each(['unpinned', 'attacker', 'expired'] as const)('refuses %s installation despite runtime key env', kind => {
    const f = fixture({ [kind]: true });
    const result = f.run('install'); expect(result.status, result.stderr).toBe(42);
    expect(result.stderr).toContain('signature, trust root or expiry refused');
    expect(existsSync(join(f.root, 'runtime-acceptance'))).toBe(false);
    expect(JSON.parse(f.run().stdout)).toBeNull();
  });
  it.each(['missing', 'corrupt-envelope', 'corrupt-signature', 'wrong-candidate', 'wrong-entrypoint', 'oversized', 'directory'])('refuses %s at boot', kind => {
    const f = fixture();
    if (kind !== 'missing') expect(f.run('install').status).toBe(0);
    const base = join(f.root, 'runtime-acceptance', sha(1));
    if (kind === 'corrupt-envelope') writeFileSync(base + '.json', 'forged');
    if (kind === 'corrupt-signature') writeFileSync(base + '.json.sig', 'forged');
    if (kind === 'oversized') writeFileSync(base + '.json', Buffer.alloc(64 * 1024 + 1));
    if (kind === 'directory') { rmSync(base + '.json'); mkdirSync(base + '.json'); }
    if (kind === 'wrong-candidate') f.request.candidate.candidateSha256 = sha(8);
    if (kind === 'wrong-entrypoint') f.request.candidate.entrypointSha256 = sha(8);
    writeFileSync(f.args, JSON.stringify(f.request));
    const result = f.run(); expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toBeNull();
  });
});
