import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverRelease } from '../papercusp-desktop/bin/recover-release.mjs';

const baseUrl = `https://releases.example/releasessentinel`;
const newBase = `https://releases.example/releases/${'a'.repeat(40)}`;
const payload = Buffer.from('existing signed replacement bytes');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keyId = randomBytes(8);
const publicBytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const updaterKey = Buffer.from(`untrusted comment: minisign public key\n${Buffer.concat([Buffer.from('Ed'), keyId, publicBytes]).toString('base64')}\n`).toString('base64');
const signature = Buffer.from(`untrusted comment: signature\n${Buffer.concat([Buffer.from('ED'), keyId,
  sign(null, createHash('blake2b512').update(payload).digest(), privateKey)]).toString('base64')}\n`).toString('base64');
const trustedComment = 'timestamp:1793000000\tfile:replacement.tar.gz';
const artifactSignature = Buffer.from(signature, 'base64').toString('utf8').split('\n')[1]!;
const globalSignature = sign(null, Buffer.concat([
  Buffer.from(artifactSignature, 'base64').subarray(10), Buffer.from(trustedComment),
]), privateKey).toString('base64');
const fullSignature = Buffer.from(`untrusted comment: signature\n${artifactSignature}\ntrusted comment: ${trustedComment}\n${globalSignature}\n`).toString('base64');
let root: string;
let configPath: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'release-recovery-test-'));
  configPath = join(root, 'tauri.conf.json');
  await writeFile(configPath, JSON.stringify({ plugins: { updater: { pubkey: updaterKey } } }));
  await writeFile(join(root, 'existing-user-data'), 'keep this workspace');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function candidate(overrides = {}) {
  return { version: '1.2.3', platforms: { 'linux-x86_64': {
    url: `${newBase}/desktop-v1.2.3/Papercusp%20Server.AppImage.tar.gz`, signature,
  } }, ...overrides };
}
function host(manifest = candidate(), bytes = payload) {
  return vi.fn(async (input: string | URL, options?: RequestInit) => {
    expect(options?.redirect).toBe('error');
    return String(input).endsWith('/latest.json') || String(input).endsWith('/latest-server.json')
      ? new Response(JSON.stringify(manifest)) : new Response(bytes);
  });
}
function options(fetchImpl = host()) {
  return { baseUrl: newBase, platform: 'linux-x86_64', outputDir: root, fetchImpl, configPath };
}

describe('explicit recovery from an immutable retired release host', () => {
  it('stages the original signature-verified bytes without modifying user data or installing', async () => {
    const fetchImpl = host();
    const result = await recoverRelease(options(fetchImpl));
    expect(await readFile(result.artifactPath)).toEqual(payload);
    expect(result.receipt).toMatchObject({ signatureVerified: true, installationPerformed: false,
      userDataModified: false, disposition: 'verified-replacement-staged', version: '1.2.3' });
    expect(result.receipt.artifactSha256).toBe(createHash('sha256').update(payload).digest('hex'));
    expect(await readFile(join(root, 'existing-user-data'), 'utf8')).toBe('keep this workspace');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('uses the server updater manifest when recovering a server installation', async () => {
    const fetchImpl = host();
    await recoverRelease({ ...options(fetchImpl), product: 'server' });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(`${newBase}/latest-server.json`);
  });

  it('rejects same-size changed bytes under a genuine old signature and cleans the partial download', async () => {
    const changed = Buffer.from(payload); changed[0] = changed[0]! ^ 1;
    await expect(recoverRelease(options(host(candidate(), changed)))).rejects.toThrow('signature verification failed');
    expect((await readdir(root)).filter(name => name.startsWith('papercusp-recovery-'))).toEqual([]);
    expect(await readFile(join(root, 'existing-user-data'), 'utf8')).toBe('keep this workspace');
  });

  it('accepts a replacement with an intact trusted comment and global signature', async () => {
    const manifest = candidate({ platforms: { 'linux-x86_64': {
      url: `${newBase}/replacement.tar.gz`, signature: fullSignature,
    } } });
    const result = await recoverRelease(options(host(manifest)));
    expect(await readFile(result.artifactPath)).toEqual(payload);
    expect(result.receipt).toMatchObject({ signatureVerified: true, installationPerformed: false,
      userDataModified: false, disposition: 'verified-replacement-staged' });
    expect(await readFile(join(root, 'existing-user-data'), 'utf8')).toBe('keep this workspace');
  });

  it.each(['trusted comment', 'global signature'])('rejects changed %s even when the artifact signature is valid', async part => {
    const changedGlobal = Buffer.from(globalSignature, 'base64');
    changedGlobal[0] = changedGlobal[0]! ^ 1;
    const decoded = Buffer.from(fullSignature, 'base64').toString('utf8');
    const changed = part === 'trusted comment'
      ? decoded.replace(trustedComment, `${trustedComment} `)
      : decoded.replace(globalSignature, changedGlobal.toString('base64'));
    const manifest = candidate({ platforms: { 'linux-x86_64': {
      url: `${newBase}/replacement.tar.gz`, signature: Buffer.from(changed).toString('base64'),
    } } });
    await expect(recoverRelease(options(host(manifest)))).rejects.toThrow('signature verification failed');
    expect((await readdir(root)).filter(name => name.startsWith('papercusp-recovery-'))).toEqual([]);
    expect(await readFile(join(root, 'existing-user-data'), 'utf8')).toBe('keep this workspace');
  });

  it('keeps the trusted key local even when the remote manifest nominates another key', async () => {
    const wrong = generateKeyPairSync('ed25519');
    const forged = Buffer.from(`untrusted comment: signature\n${Buffer.concat([Buffer.from('ED'), keyId,
      sign(null, createHash('blake2b512').update(payload).digest(), wrong.privateKey)]).toString('base64')}\n`).toString('base64');
    const manifest = candidate({ pubkey: wrong.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      platforms: { 'linux-x86_64': { url: `${newBase}/replacement.tar.gz`, signature: forged } } });
    await expect(recoverRelease(options(host(manifest)))).rejects.toThrow('signature verification failed');
  });

  it('refuses the retired R2 address before any network request', async () => {
    const fetchImpl = host();
    await expect(recoverRelease({ ...options(fetchImpl), baseUrl: 'https://pub-example.r2.dev/retired' })).rejects.toThrow('new HTTPS release');
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(recoverRelease({ ...options(fetchImpl), baseUrl })).rejects.toThrow('new HTTPS release');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an artifact URL which would send the client back to R2', async () => {
    const manifest = candidate({ platforms: { 'linux-x86_64': { url: 'https://pub-example.r2.dev/old.tar.gz', signature } } });
    const fetchImpl = host(manifest);
    await expect(recoverRelease(options(fetchImpl))).rejects.toThrow('outside the new release');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable hosts as unknown rather than a successful up-to-date result', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network failure'); });
    await expect(recoverRelease(options(fetchImpl))).rejects.toThrow('update status is unknown');
    expect(await readdir(root)).toEqual(expect.arrayContaining(['existing-user-data', 'tauri.conf.json']));
  });

  it('does not claim recovery when there is no signed replacement for the installed platform', async () => {
    await expect(recoverRelease(options(host(candidate({ platforms: {} }))))).rejects.toThrow('No signed replacement');
    expect((await readdir(root)).filter(name => name.startsWith('papercusp-recovery-'))).toEqual([]);
  });
});
