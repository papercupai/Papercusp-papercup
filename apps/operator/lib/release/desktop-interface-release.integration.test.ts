import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertPublicDesktopArtifacts, desktopInterfaceIdentity } from '../../../../papercusp-desktop/bin/lib/spa-freshness.js';
import { generateSite, run, scanArtifacts } from './record-release-cli';
import { verifyReleasePublication } from './finalize-release-publication';
import { renderHistoryJson } from './release-history-page';
import type { ReleaseRow } from './release-registry';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const bin = path.join(repo, 'papercusp-desktop/bin');
const scratch: string[] = [];
const savedInterface = process.env.PAPERCUSP_DESKTOP_INTERFACE;
const savedOwner = process.env.PAPERCUSP_RELEASE_OWNER_NAME;
afterEach(() => {
  for (const file of scratch.splice(0)) fs.rmSync(file, { recursive: true, force: true });
  if (savedInterface === undefined) delete process.env.PAPERCUSP_DESKTOP_INTERFACE;
  else process.env.PAPERCUSP_DESKTOP_INTERFACE = savedInterface;
  if (savedOwner === undefined) delete process.env.PAPERCUSP_RELEASE_OWNER_NAME;
  else process.env.PAPERCUSP_RELEASE_OWNER_NAME = savedOwner;
});

function artifactFixture(kind: 'legacy' | 'portal-candidate') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-interface-release-'));
  scratch.push(root);
  const bundle = path.join(root, 'bundle');
  fs.mkdirSync(path.join(bundle, 'deb'), { recursive: true });
  const version = `999.0.${Date.now()}`;
  const file = path.join(bundle, 'deb', `Papercusp_${version}_amd64.deb`);
  const bytes = Buffer.alloc(8 * 1024 * 1024, 65);
  fs.writeFileSync(file, bytes);
  const identity = desktopInterfaceIdentity(`<html><meta name="papercusp-desktop-interface" content="${kind}"><script src="/assets/index-AAAAAAAA.js"></script></html>`);
  fs.writeFileSync(path.join(bundle, 'build-provenance.json'), JSON.stringify({
    desktopInterface: identity,
    artifacts: [{ name: `deb/${path.basename(file)}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }],
  }));
  return { root, bundle, file, version, identity };
}

describe('public desktop interface hold at real release entrypoints', () => {
  it('rejects candidate-marked installer bytes even when the caller requests legacy', () => {
    process.env.PAPERCUSP_DESKTOP_INTERFACE = 'legacy';
    const f = artifactFixture('portal-candidate');
    expect(() => scanArtifacts([f.bundle], f.version, 'isolated', { publicRelease: true })).toThrow(/PUBLIC DESKTOP INTERFACE HOLD/);
    expect(() => assertPublicDesktopArtifacts([f.file], {})).toThrow(/PUBLIC DESKTOP INTERFACE HOLD/);
  });

  it('accepts the same public scanner and preflight with measured legacy artifact bytes', () => {
    process.env.PAPERCUSP_DESKTOP_INTERFACE = 'legacy';
    const f = artifactFixture('legacy');
    const rows = scanArtifacts([f.bundle], f.version, 'isolated', { publicRelease: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].desktopInterface).toEqual(f.identity);
    expect(assertPublicDesktopArtifacts([f.file], {})).toEqual([f.identity]);
  });

  it('refuses candidate upload before any installer, signature or feed write', () => {
    const f = artifactFixture('portal-candidate');
    const version = `${f.version}-${randomUUID()}`;
    const tag = `desktop-v${version}-alpha`;
    const latest = `/tmp/papercusp-latest-${tag}.json`;
    const manifest = `/tmp/papercusp-artifacts-${tag}.txt`;
    scratch.push(latest, manifest);
    fs.writeFileSync(latest, '{}');
    fs.writeFileSync(manifest, `${f.file}\n`);
    const home = path.join(f.root, 'home');
    const tools = path.join(f.root, 'tools');
    fs.mkdirSync(path.join(home, '.papercusp'), { recursive: true });
    fs.mkdirSync(tools);
    fs.writeFileSync(path.join(home, '.papercusp/release-host.env'), 'PAPERCUSP_UPDATE_BASE_URL=https://downloads.example.test/test-prefix\n');
    fs.writeFileSync(path.join(home, '.papercusp/r2.env'), 'R2_ACCOUNT_ID=fixture\nR2_BUCKET=fixture\nAWS_ACCESS_KEY_ID=fixture\nAWS_SECRET_ACCESS_KEY=fixture\n');
    const writes = path.join(f.root, 'outward-calls');
    fs.writeFileSync(path.join(tools, 'aws'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$OUTWARD_CALLS"\nexit 99\n', { mode: 0o755 });
    const result = spawnSync('bash', [path.join(bin, 'upload-release.sh'), version, 'alpha'], {
      env: { ...process.env, HOME: home, PATH: `${tools}:${process.env.PATH}`, OUTWARD_CALLS: writes, PAPERCUSP_DESKTOP_INTERFACE: 'legacy', DRY_RUN: '1' },
      encoding: 'utf8', timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(4);
    expect(result.stderr).toMatch(/PUBLIC DESKTOP INTERFACE HOLD/);
    expect(fs.existsSync(writes)).toBe(false);
  });

  it.each(['build-desktop-sidecar.sh', 'build-mac-cross.sh', 'build-windows-cross.sh', 'publish-release-history.sh'])('%s refuses candidate requests before output or public I/O', (entry) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-interface-entry-'));
    scratch.push(root);
    const result = spawnSync('bash', [path.join(bin, entry), '999.0.0'], {
      env: { ...process.env, HOME: root, PAPERCUSP_DESKTOP_INTERFACE: 'portal-candidate', DRY_RUN: '1' },
      encoding: 'utf8', timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(4);
    expect(result.stderr).toMatch(/PUBLIC DESKTOP INTERFACE HOLD/);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('recorder and shared page renderer refuse before database or filesystem work', async () => {
    process.env.PAPERCUSP_DESKTOP_INTERFACE = 'portal-candidate';
    const sql = new Proxy(function () {}, { apply: () => { throw new Error('unexpected database work'); } });
    await expect(run({} as never)).rejects.toThrow(/PUBLIC DESKTOP INTERFACE HOLD/);
    await expect(generateSite(sql as never, { workspaceId: 'fixture', harnessSlug: 'papercusp' }, '/nonexistent-candidate-output')).rejects.toThrow(/PUBLIC DESKTOP INTERFACE HOLD/);
    process.env.PAPERCUSP_DESKTOP_INTERFACE = 'legacy';
    process.env.PAPERCUSP_RELEASE_OWNER_NAME = 'Fixture Name';
    await expect(generateSite(sql as never, { workspaceId: 'fixture', harnessSlug: 'papercusp' }, '/nonexistent-candidate-output')).rejects.toThrow('unexpected database work');
  });

  it('finalizer refuses a candidate registry record before any public request', async () => {
    process.env.PAPERCUSP_DESKTOP_INTERFACE = 'legacy';
    const f = artifactFixture('portal-candidate');
    const row = {
      version: f.version, channel: 'alpha', artifacts: [{ product: 'gui', name: 'candidate.deb', platform: 'linux-x86_64', url: 'candidate.deb', size: 8, sha256: 'a'.repeat(64), desktopInterface: f.identity }],
    } as ReleaseRow;
    const calls: string[] = [];
    await expect(verifyReleasePublication(row, 'https://downloads.example.test', async (url) => {
      calls.push(url); return { status: 200, contentLength: 8 };
    })).rejects.toThrow(/PUBLIC DESKTOP INTERFACE HOLD/);
    expect(calls).toEqual([]);
    row.artifacts[0].desktopInterface = { ...f.identity, kind: 'legacy' };
    await expect(verifyReleasePublication(row, 'https://downloads.example.test', async (url) => {
      calls.push(url); return { status: 200, contentLength: 8 };
    })).resolves.toMatchObject({ artifactCount: 1 });
    expect(calls).toHaveLength(2);
  });

  it('retained candidate page/feed bytes refuse publication with legacy caller settings', () => {
    const f = artifactFixture('portal-candidate');
    const site = path.join(f.root, 'site');
    fs.mkdirSync(site);
    const row = {
      version: f.version, channel: 'alpha', publishedAt: null, cutAt: new Date(0), changelogMd: '',
      artifacts: [{ product: 'gui', name: 'candidate.deb', platform: 'linux-x86_64', url: 'candidate.deb', size: 8, sha256: 'a'.repeat(64), desktopInterface: f.identity }],
    };
    const history = renderHistoryJson([{ row, items: [], plans: [], internalCount: 0 }] as never, { generatedAt: new Date(0), redact: [] } as never);
    expect(JSON.parse(history).releases[0].artifacts[0].desktopInterface).toEqual(f.identity);
    fs.writeFileSync(path.join(site, 'history.json'), history);
    fs.writeFileSync(path.join(site, 'index.html'), '<html>isolated download-page fixture</html>');
    const publish = () => spawnSync('bash', [path.join(bin, 'publish-release-history.sh'), f.version], {
      env: { ...process.env, HOME: f.root, PAPERCUSP_RELEASE_SITE_DIR: site, PAPERCUSP_DESKTOP_INTERFACE: 'legacy', DRY_RUN: '1' },
      encoding: 'utf8', timeout: 30_000,
    });
    const candidate = publish();
    expect(candidate.status, candidate.stderr).toBe(4);
    expect(candidate.stderr).toMatch(/PUBLIC DESKTOP INTERFACE HOLD/);
    expect(fs.readFileSync(path.join(site, 'history.json'), 'utf8')).toBe(history);
    row.artifacts[0].desktopInterface = { ...f.identity, kind: 'legacy' };
    fs.writeFileSync(path.join(site, 'history.json'), renderHistoryJson([{ row, items: [], plans: [], internalCount: 0 }] as never, { generatedAt: new Date(0), redact: [] } as never));
    const legacy = publish();
    expect(legacy.status, legacy.stderr).toBe(1);
    expect(legacy.stderr).toMatch(/no generated work-item pages/);
    expect(legacy.stderr).not.toMatch(/PUBLIC DESKTOP INTERFACE HOLD/);
  });
});
