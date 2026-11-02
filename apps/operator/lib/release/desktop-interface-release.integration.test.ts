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

// Run the maintained shell entrypoints with only their outward transports replaced.
// Copying the scripts and helpers keeps a regressed incremental collector inside
// this fixture's bundle tree rather than the shared desktop build directory.
function isolatedPublisher(kind: 'legacy' | 'portal-candidate') {
  const fixture = artifactFixture(kind);
  const desktop = path.join(fixture.root, 'desktop');
  const scripts = path.join(desktop, 'bin');
  fs.mkdirSync(scripts, { recursive: true });
  fs.cpSync(path.join(bin, 'lib'), path.join(scripts, 'lib'), { recursive: true });
  for (const entry of ['publish-platform-incremental.sh', 'restore-release-page.sh', 'publish-release-history.sh']) {
    fs.copyFileSync(path.join(bin, entry), path.join(scripts, entry));
  }
  const bundle = path.join(desktop, 'src-tauri/target/release/bundle');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.cpSync(fixture.bundle, bundle, { recursive: true });
  const home = path.join(fixture.root, 'home');
  const tools = path.join(fixture.root, 'tools');
  fs.mkdirSync(home);
  fs.mkdirSync(tools);
  const calls = path.join(fixture.root, 'outward-calls');
  for (const tool of ['curl', 'gcloud', 'aws', 'npx']) {
    fs.writeFileSync(path.join(tools, tool), `#!/bin/sh\nprintf '%s %s\\n' '${tool}' "$*" >> "$OUTWARD_CALLS"\nexit 97\n`, { mode: 0o755 });
  }
  const protectedRoot = path.join(fixture.root, 'public');
  const feeds = spawnSync('bash', ['-c', '. "$1"; for channel in alpha beta stable nightly; do desktop_channel_feed_paths "$channel" latest.json; desktop_channel_feed_paths "$channel" latest-server.json; done', 'feeds', path.join(bin, 'lib/gen-latest-manifest.sh')], { encoding: 'utf8' });
  expect(feeds.status, feeds.stderr).toBe(0);
  const targets = [...new Set([
    ...feeds.stdout.trim().split('\n'), 'index.html',
    ...fs.readdirSync(path.join(bundle, 'deb')).flatMap(name => [name, `${name}.sig`]),
  ])];
  for (const target of targets) {
    const file = path.join(protectedRoot, target);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `existing-public-object:${target}`);
  }
  const protectedBytes = () => Object.fromEntries(targets.map(target => [target,
    createHash('sha256').update(fs.readFileSync(path.join(protectedRoot, target))).digest('hex'),
  ]));
  const before = protectedBytes();
  const run = (entry: string, channel: string, selection: string) => {
    const tag = `desktop-v${fixture.version}${channel === 'stable' ? '' : `-${channel}`}`;
    scratch.push(`/tmp/papercusp-cut-start-${tag}.txt`, `/tmp/papercusp-artifacts-${tag}.txt`);
    return spawnSync('bash', [path.join(scripts, entry), fixture.version, channel, 'linux'], {
      encoding: 'utf8', timeout: 30_000,
      env: {
        ...process.env, HOME: home, PATH: `${tools}:${process.env.PATH}`, OUTWARD_CALLS: calls,
        PAPERCUSP_DESKTOP_INTERFACE: selection, PAPERCUSP_UPDATE_BASE_URL: '', PAPERCUSP_RELEASE_HOST: '',
        PAPERCUSP_RELEASE_STORAGE_ENV: path.join(home, 'no-storage.env'), PAPERCUSP_RELEASE_GCS_BUCKET: '',
        PAPERCUSP_SKIP_PLATFORM_SMOKE: '0', PAPERCUSP_RELEASE_CUT_START_NS: '', PAPERCUSP_RELEASE_TAG: '',
        CARGO_TARGET_DIR: path.join(fixture.root, 'cargo-target'),
        DRY_RUN: '0',
      },
    });
  };
  const configureHost = () => {
    fs.mkdirSync(path.join(home, '.papercusp'), { recursive: true });
    fs.writeFileSync(path.join(home, '.papercusp/release-host.env'), 'PAPERCUSP_UPDATE_BASE_URL=https://downloads.example.test/test-prefix\n');
  };
  return { ...fixture, home, calls, run, before, protectedBytes, configureHost };
}

describe('public desktop interface hold at real release entrypoints', () => {
  it.each(['alpha', 'beta', 'stable', 'nightly'])('incremental %s rejects candidate selection before merge outputs or outward calls', (channel) => {
    const f = isolatedPublisher('legacy');
    const result = f.run('publish-platform-incremental.sh', channel, 'portal-candidate');
    expect(result.status, result.stderr).toBe(4);
    expect(result.stderr).toMatch(/PUBLIC DESKTOP INTERFACE HOLD/);
    expect(fs.readdirSync(f.home)).toEqual([]);
    expect(fs.existsSync(f.calls)).toBe(false);
    expect(f.protectedBytes()).toEqual(f.before);
    const tag = `desktop-v${f.version}${channel === 'stable' ? '' : `-${channel}`}`;
    expect(fs.existsSync(`/tmp/papercusp-cut-start-${tag}.txt`)).toBe(false);
  });

  it('restore refuses candidate selection before invoking its recorder', () => {
    const f = isolatedPublisher('legacy');
    const result = f.run('restore-release-page.sh', 'alpha', 'portal-candidate');
    expect(result.status, result.stderr).toBe(4);
    expect(result.stderr).toMatch(/PUBLIC DESKTOP INTERFACE HOLD/);
    expect(fs.existsSync(f.calls)).toBe(false);
    expect(f.protectedBytes()).toEqual(f.before);
  });

  it.each(['alpha', 'beta', 'stable', 'nightly'])('incremental %s rejects candidate-marked artifacts with a legacy caller before smoke or live-feed reads', (channel) => {
    const f = isolatedPublisher('portal-candidate');
    f.configureHost();
    const result = f.run('publish-platform-incremental.sh', channel, 'legacy');
    expect(result.status, result.stderr).toBe(4);
    expect(result.stderr).toMatch(/PUBLIC DESKTOP INTERFACE HOLD/);
    expect(fs.existsSync(f.calls)).toBe(false);
    expect(f.protectedBytes()).toEqual(f.before);
  });

  it('the same incremental route admits legacy identity and still enforces artifact freshness', () => {
    const f = isolatedPublisher('legacy');
    f.configureHost();
    const result = f.run('publish-platform-incremental.sh', 'alpha', 'legacy');
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).not.toMatch(/PUBLIC DESKTOP INTERFACE HOLD/);
    expect(result.stderr).toMatch(/predates this cut|stale/);
    expect(fs.existsSync(f.calls)).toBe(false);
    expect(f.protectedBytes()).toEqual(f.before);
  });

  it('the same restore route admits legacy selection and invokes its recorder', () => {
    const f = isolatedPublisher('legacy');
    const result = f.run('restore-release-page.sh', 'alpha', 'legacy');
    expect(result.status, result.stderr).toBe(97);
    expect(fs.readFileSync(f.calls, 'utf8')).toMatch(/^npx tsx .*record-release-cli\.ts --restore-page\n$/);
    expect(f.protectedBytes()).toEqual(f.before);
  });

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

  it('refuses candidate upload before storage configuration or any public write', () => {
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
    const writes = path.join(f.root, 'outward-calls');
    for (const tool of ['gcloud', 'aws']) {
      fs.writeFileSync(path.join(tools, tool), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$OUTWARD_CALLS"\nexit 99\n', { mode: 0o755 });
    }
    const result = spawnSync('bash', [path.join(bin, 'upload-release.sh'), version, 'alpha'], {
      env: {
        ...process.env, HOME: home, PATH: `${tools}:${process.env.PATH}`, OUTWARD_CALLS: writes,
        PAPERCUSP_DESKTOP_INTERFACE: 'legacy', DRY_RUN: '1',
        PAPERCUSP_RELEASE_STORAGE_ENV: path.join(home, '.papercusp/release-storage.env'),
        PAPERCUSP_RELEASE_GCS_BUCKET: '',
      },
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
