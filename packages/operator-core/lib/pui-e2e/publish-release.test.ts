import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../..');
// Overridable so scripts/mutation-probe.sh can point the suite at a mutated COPY of the
// publisher (copy-out tier) instead of mutating the shared tree.
const PUBLISH = process.env.PUI_PUBLISH_SCRIPT || join(REPO_ROOT, 'apps/tui/scripts/publish-release.sh');
const roots: string[] = [];

// The publisher resolves its host as PAPERCUSP_UPDATE_BASE_URL ?? PAPERCUSP_RELEASE_HOST AFTER
// sourcing the release-host env file, so an AMBIENT value wins over the fixture file. testing:run
// spawns vitest from the operator process, whose environment carries the real release host, and
// the suite then asserted production keys against fixture expectations (4 reds, run 5e50b3df,
// 2026-09-27). Every spawn therefore starts from an env with the release-host, storage and
// Portal-link variables removed; each test supplies exactly the ones it means to.
const INHERITED_RELEASE_ENV = /^(PAPERCUSP_UPDATE_BASE_URL|PAPERCUSP_RELEASE_HOST|PUI_.*|R2_.*|AWS_.*|NEXT_PUBLIC_PORTAL_.*)$/;
function hermeticEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!INHERITED_RELEASE_ENV.test(key)) env[key] = value;
  }
  return { ...env, ...overrides };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function candidate(target = 'linux-x86_64', sourceSha = 'a'.repeat(40)) {
  const platform = target === 'macos-aarch64' ? 'macOS arm64'
    : target === 'macos-x86_64' ? 'macOS x86_64' : 'Linux x86_64';
  const root = mkdtempSync(join(tmpdir(), 'pui-publish-test-'));
  roots.push(root);
  const unitName = `pui-0.1.0-${target}`;
  const unit = join(root, unitName);
  mkdirSync(unit);
  writeFileSync(join(unit, 'PROVENANCE.json'), JSON.stringify({
    schemaVersion: 1,
    name: 'pui',
    version: '0.1.0',
    target,
    source: { commit: sourceSha },
  }));
  writeFileSync(join(unit, 'README.md'), 'fixture\n');
  const archive = join(root, `${unitName}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', root, unitName]);
  const digest = sha256(archive);
  writeFileSync(join(root, 'SHA256SUMS'), `${digest}  ${unitName}.tar.gz\n`);
  const acceptance = `${archive}.acceptance.json`;
  writeFileSync(acceptance, JSON.stringify({
    schemaVersion: 1,
    ok: true,
    candidate: { archiveSha256: digest, sourceSha, advertise: [{ platform, backend: 'Claude' }] },
    refusals: [],
    runner: {
      platform,
      stockMachines: [{ image: 'ubuntu:24.04', status: 0 }, { image: 'debian:stable-slim', status: 0 }],
      cloudDeviceStart: { ok: true, status: 200 },
      legs: [{ engine: 'scripted', status: 0 }, { engine: 'claude', status: 0 }],
      suiteProvenance: [{ candidateBlob: 'b'.repeat(40), runBlob: 'b'.repeat(40) }],
    },
  }));
  const hostEnv = join(root, 'release-host.env');
  writeFileSync(hostEnv, 'PAPERCUSP_RELEASE_HOST=https://pub.example.test/unguessable-prefix\n');
  return { root, archive, acceptance, hostEnv, digest };
}

function run(files: ReturnType<typeof candidate>, previous?: unknown) {
  const work = join(files.root, 'work');
  const args = [PUBLISH, '--archive', files.archive, '--work', work];
  if (previous) {
    const previousPath = join(files.root, 'previous.json');
    writeFileSync(previousPath, JSON.stringify(previous));
    args.push('--previous', previousPath);
  }
  const result = spawnSync('bash', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: hermeticEnv({ DRY_RUN: '1', PUI_RELEASE_HOST_ENV: files.hostEnv }),
  });
  return { result, work };
}

// Exercise the real publisher's write path with a local object store. Neither
// adapter can reach the network or inherit production storage credentials.
function publication(files: ReturnType<typeof candidate>, options: {
  headFailure?: boolean;
  corruptPublicArchive?: boolean;
  existingArchive?: 'identical-without-metadata' | 'different';
  legacyArchive?: ReturnType<typeof candidate>;
  previousManifest?: unknown;
  previousReadFailure?: boolean;
} = {}) {
  const bin = join(files.root, 'bin');
  mkdirSync(bin);
  const state = join(files.root, 'objects.json');
  const events = join(files.root, 'events.jsonl');
  const archiveKey = `unguessable-prefix/pui/0.1.0/${files.digest}/pui-0.1.0-linux-x86_64.tar.gz`;
  const legacyArchiveKey = 'unguessable-prefix/pui/0.1.0/pui-0.1.0-linux-x86_64.tar.gz';
  writeFileSync(state, JSON.stringify({ ...(options.existingArchive ? {
    [archiveKey]: { body: (options.existingArchive === 'different'
      ? Buffer.from('previous release') : readFileSync(files.archive)).toString('base64') },
  } : {}), ...(options.legacyArchive ? {
    [legacyArchiveKey]: { body: readFileSync(options.legacyArchive.archive).toString('base64') },
  } : {}), ...(options.previousManifest ? {
    'unguessable-prefix/pui/latest.json': { body: Buffer.from(JSON.stringify(options.previousManifest)).toString('base64') },
  } : {}) }));
  writeFileSync(events, '');
  const adapter = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const store = JSON.parse(fs.readFileSync(process.env.MOCK_STORE, 'utf8'));
const arg = (name) => args[args.indexOf(name) + 1];
const log = (op, key) => fs.appendFileSync(process.env.MOCK_EVENTS, JSON.stringify({op,key}) + '\\n');
if (path.basename(process.argv[1]) === 'curl') {
  const url = new URL(args.find((value) => value.startsWith('https://')));
  const key = url.pathname.slice(1);
  log('public-get', key);
  if (!store[key]) process.exit(22);
  const body = process.env.MOCK_CORRUPT === '1' && key.endsWith('.tar.gz')
    ? Buffer.from('corrupt download') : Buffer.from(store[key].body, 'base64');
  fs.writeFileSync(arg('-o'), body);
} else if (args.includes('head-object')) {
  const key = arg('--key');
  log('head', key);
  if (process.env.MOCK_HEAD_FAILURE === '1') {
    console.error('An error occurred (AccessDenied) when calling HeadObject'); process.exit(1);
  }
  if (!store[key]) {
    console.error('An error occurred (404) when calling HeadObject'); process.exit(1);
  }
  console.log(store[key].sha || 'None');
} else if (args.includes('get-object')) {
  const key = arg('--key');
  log('authenticated-get', key);
  if (process.env.MOCK_PREVIOUS_FAILURE === '1' && key.endsWith('/latest.json')) {
    console.error('An error occurred (AccessDenied) when calling GetObject'); process.exit(1);
  }
  if (!store[key]) {
    console.error('An error occurred (NoSuchKey) when calling GetObject'); process.exit(1);
  }
  fs.writeFileSync(args.at(-1), Buffer.from(store[key].body, 'base64'));
} else if (args.includes('cp')) {
  const index = args.indexOf('cp');
  const key = new URL(args[index + 2]).pathname.slice(1);
  log('put', key);
  store[key] = { body: fs.readFileSync(args[index + 1]).toString('base64'),
    ...(args.includes('--metadata') ? {sha: arg('--metadata').slice('sha256='.length)} : {}) };
  fs.writeFileSync(process.env.MOCK_STORE, JSON.stringify(store));
} else { console.error('unexpected mock invocation'); process.exit(2); }
`;
  for (const name of ['aws', 'curl']) writeFileSync(join(bin, name), adapter, { mode: 0o755 });
  const r2Env = join(files.root, 'r2.env');
  writeFileSync(r2Env, 'R2_ACCOUNT_ID=fixture\nR2_BUCKET=fixture\nAWS_ACCESS_KEY_ID=fixture\nAWS_SECRET_ACCESS_KEY=fixture\n');
  const portalEnv = join(files.root, 'portal-public-links.env');
  const work = join(files.root, 'published');
  const result = spawnSync('bash', [PUBLISH, '--archive', files.archive, '--work', work], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: hermeticEnv({ PATH: `${bin}:${process.env.PATH}`, DRY_RUN: '0',
      PUI_RELEASE_HOST_ENV: files.hostEnv, PUI_R2_ENV: r2Env,
      PUI_PORTAL_LINKS_ENV: portalEnv, PUI_SKIP_PORTAL_CONFIG: '0',
      MOCK_STORE: state, MOCK_EVENTS: events,
      MOCK_HEAD_FAILURE: options.headFailure ? '1' : '0',
      MOCK_PREVIOUS_FAILURE: options.previousReadFailure ? '1' : '0',
      MOCK_CORRUPT: options.corruptPublicArchive ? '1' : '0' }),
  });
  return { result, portalEnv, work, archiveKey, legacyArchiveKey,
    objects: JSON.parse(readFileSync(state, 'utf8')) as Record<string, { body: string; sha?: string }>,
    events: readFileSync(events, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { op: string; key: string }) };
}

describe('PUI public release publisher', () => {
  it('binds the accepted source and digest, renders distinct PUI links, and masks the host prefix', () => {
    const files = candidate();
    const { result, work } = run(files);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('validation passed');
    expect(result.stdout).not.toContain('unguessable-prefix');
    const latest = JSON.parse(readFileSync(join(work, 'latest.json'), 'utf8'));
    expect(latest).toMatchObject({
      version: '0.1.0',
      target: 'linux-x86_64',
      sourceSha: 'a'.repeat(40),
      archiveSha256: files.digest,
    });
    expect(latest.archiveUrl).toBe(`https://pub.example.test/unguessable-prefix/pui/0.1.0/${files.digest}/pui-0.1.0-linux-x86_64.tar.gz`);
    const page = readFileSync(join(work, 'index.html'), 'utf8');
    expect(page).toContain(latest.archiveUrl);
    expect(page).toContain(`${files.digest}</code>`);
    expect(page).toContain('<h2>Linux</h2>');
    expect(page).toContain('<h2>macOS</h2>');
    expect(page).toContain('<h2>Windows</h2>');
    expect(page).toContain('open its Linux terminal');
    expect(page).toContain('macOS Apple Silicon download is awaiting release verification');
    expect(page).not.toContain('href="https://pub.example.test/unguessable-prefix/pui/0.1.0/pui-0.1.0-macos');
    expect(page).toContain('Launch PSU, select your cloud desktop');
    expect(page).toContain('Where should psu run?');
    expect(page).toContain('Papercusp cloud — sign in to use a hosted workspace');
    expect(page).toContain('Local — this computer');
    expect(page).toContain('href="../index.html#download-gui"');
    expect(page).toContain('PSU and PUI are already included in Desktop Server.');
    expect(page).toContain('Windows uses the same download as Linux, through WSL2.');
    expect(page).toContain('There is no separate Windows executable.');
    expect(page).not.toMatch(/(?:psu|pui) --connect/);
    expect(latest.artifacts['linux-x86_64'].archiveSha256).toBe(files.digest);
  });

  it('keeps previously published macOS downloads when publishing Linux', () => {
    const mac = run(candidate('macos-aarch64'));
    expect(mac.result.status, mac.result.stderr).toBe(0);
    const previous = JSON.parse(readFileSync(join(mac.work, 'latest.json'), 'utf8'));
    const published = publication(candidate(), { previousManifest: previous });
    expect(published.result.status, published.result.stderr).toBe(0);
    const latest = JSON.parse(readFileSync(join(published.work, 'latest.json'), 'utf8'));
    expect(Object.keys(latest.artifacts).sort()).toEqual(['linux-x86_64', 'macos-aarch64']);
    const page = readFileSync(join(published.work, 'index.html'), 'utf8');
    expect(page).toContain(previous.archiveUrl);
    expect(page).toContain(latest.archiveUrl);
    expect(latest.sumsUrl).not.toBe(previous.sumsUrl);
  });

  it('publishes a new generation at the same version without replacing the legacy archive', () => {
    const old = candidate('linux-x86_64', 'b'.repeat(40));
    const preview = run(old);
    expect(preview.result.status, preview.result.stderr).toBe(0);
    const previous = JSON.parse(readFileSync(join(preview.work, 'latest.json'), 'utf8'));
    // The already-published r14 layout had no generation segment.
    for (const key of ['archiveUrl', 'acceptanceUrl', 'sumsUrl']) {
      previous[key] = previous[key].replace(`/${old.digest}/`, '/');
    }
    delete previous.artifacts;
    const files = candidate();
    expect(files.digest).not.toBe(old.digest);
    const published = publication(files, { legacyArchive: old, previousManifest: previous });
    expect(published.result.status, published.result.stderr).toBe(0);
    const latest = JSON.parse(readFileSync(join(published.work, 'latest.json'), 'utf8'));
    expect(latest.version).toBe(previous.version);
    expect(latest.archiveUrl).not.toBe(previous.archiveUrl);
    expect(latest.archiveUrl).toContain(`/0.1.0/${files.digest}/`);
    expect(published.objects[published.legacyArchiveKey].body).toBe(readFileSync(old.archive).toString('base64'));
    expect(published.objects[published.archiveKey].body).toBe(readFileSync(files.archive).toString('base64'));
    expect(published.events).toContainEqual({ op: 'public-get', key: published.archiveKey });
    expect(published.events.some(({ op, key }) => op === 'put' && key === published.legacyArchiveKey)).toBe(false);
  });

  it('migrates a legacy single-target manifest without losing its download', () => {
    const linux = run(candidate());
    const previous = JSON.parse(readFileSync(join(linux.work, 'latest.json'), 'utf8'));
    delete previous.artifacts;
    for (const key of ['archiveUrl', 'acceptanceUrl', 'sumsUrl']) {
      previous[key] = previous[key].replace(`/${previous.archiveSha256}/`, '/');
    }
    previous.sumsUrl = 'https://pub.example.test/unguessable-prefix/pui/0.1.0/SHA256SUMS';
    const mac = run(candidate('macos-x86_64'), previous);
    expect(mac.result.status, mac.result.stderr).toBe(0);
    const latest = JSON.parse(readFileSync(join(mac.work, 'latest.json'), 'utf8'));
    expect(latest.artifacts['linux-x86_64']).toEqual(previous);
    expect(latest.artifacts['macos-x86_64'].sumsUrl).toContain('macos-x86_64.tar.gz.sha256');
  });

  it('refuses a retained generation URL whose directory names another archive digest', () => {
    const prior = run(candidate('macos-aarch64'));
    const previous = JSON.parse(readFileSync(join(prior.work, 'latest.json'), 'utf8'));
    delete previous.artifacts;
    for (const key of ['archiveUrl', 'acceptanceUrl', 'sumsUrl']) {
      previous[key] = previous[key].replace(`/${previous.archiveSha256}/`, `/${'f'.repeat(64)}/`);
    }
    const published = publication(candidate(), { previousManifest: previous });
    expect(published.result.status).not.toBe(0);
    expect(published.result.stderr).toContain('previous platform release URL does not match');
    expect(published.events.some(({ op }) => op === 'put')).toBe(false);
    expect(existsSync(published.portalEnv)).toBe(false);
  });

  it('refuses to erase platform entries when the prior manifest cannot be read', () => {
    const published = publication(candidate(), { previousReadFailure: true });
    expect(published.result.status).not.toBe(0);
    expect(published.result.stderr).toContain('refusing to erase them');
    expect(published.events.some((row) => row.op === 'put')).toBe(false);
  });

  it('refuses a previous manifest pointing at another host before uploading', () => {
    const prior = run(candidate('macos-aarch64'));
    const manifest = JSON.parse(readFileSync(join(prior.work, 'latest.json'), 'utf8'));
    manifest.artifacts['macos-aarch64'].archiveUrl = 'https://wrong.example.test/download';
    const published = publication(candidate(), { previousManifest: manifest });
    expect(published.result.status).not.toBe(0);
    expect(published.result.stderr).toContain('previous platform release URL');
    expect(published.events.some((row) => row.op === 'put')).toBe(false);
  });

  it('requires acceptance on the matching macOS host, even if all engine legs are green', () => {
    const files = candidate('macos-aarch64');
    const report = JSON.parse(readFileSync(files.acceptance, 'utf8'));
    report.runner.platform = 'Linux x86_64';
    writeFileSync(files.acceptance, JSON.stringify(report));
    const { result } = run(files);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('matching macOS host');
  });

  it('refuses a report advertising a different platform from its archive', () => {
    const files = candidate('macos-x86_64');
    const report = JSON.parse(readFileSync(files.acceptance, 'utf8'));
    report.candidate.advertise[0].platform = 'Linux x86_64';
    writeFileSync(files.acceptance, JSON.stringify(report));
    expect(run(files).result.stderr).toContain('platform/backend scope is absent or invalid');
  });

  it('refuses a green-looking report bound to different archive bytes', () => {
    const files = candidate();
    const acceptance = JSON.parse(readFileSync(files.acceptance, 'utf8'));
    acceptance.candidate.archiveSha256 = '0'.repeat(64);
    writeFileSync(files.acceptance, JSON.stringify(acceptance));
    const { result } = run(files);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('acceptance report belongs to different archive bytes');
  });

  it('omits private local paths, account details and terminal output from the public report', () => {
    const files = candidate();
    const report = JSON.parse(readFileSync(files.acceptance, 'utf8'));
    report.candidate.archive = '/fixture/private-user/candidate.tar.gz';
    report.runner.stockMachines[0].output = 'PRIVATE_OUTPUT';
    report.runner.legs[0].evidence = '/fixture/private-user/private-evidence.json';
    report.evidence = [{ account: 'PRIVATE_ACCOUNT', token: 'PRIVATE_TOKEN' }];
    writeFileSync(files.acceptance, JSON.stringify(report));
    const { result, work } = run(files);
    expect(result.status, result.stderr).toBe(0);
    const published = readFileSync(join(work, 'pui-0.1.0-linux-x86_64.tar.gz.acceptance.json'), 'utf8');
    expect(published).not.toMatch(/PRIVATE|private-user/);
    expect(JSON.parse(published).candidate.archiveSha256).toBe(files.digest);
  });

  it('requires both stock images and a real leg for the advertised engine', () => {
    const files = candidate();
    const report = JSON.parse(readFileSync(files.acceptance, 'utf8'));
    report.runner.stockMachines[1].image = 'ubuntu:24.04';
    writeFileSync(files.acceptance, JSON.stringify(report));
    expect(run(files).result.status).not.toBe(0);
    report.runner.stockMachines[1].image = 'debian:stable-slim';
    report.runner.legs.pop();
    writeFileSync(files.acceptance, JSON.stringify(report));
    expect(run(files).result.stderr).toContain('installed-product acceptance legs are absent or red');
  });

  it('refuses publication when the public cloud or stock-machine guard is absent', () => {
    const files = candidate();
    const acceptance = JSON.parse(readFileSync(files.acceptance, 'utf8'));
    acceptance.runner.cloudDeviceStart.ok = false;
    writeFileSync(files.acceptance, JSON.stringify(acceptance));
    const cloud = run(files).result;
    expect(cloud.status).not.toBe(0);
    expect(cloud.stderr).toContain('public cloud device-start guard did not pass');

    acceptance.runner.cloudDeviceStart.ok = true;
    acceptance.runner.stockMachines[1].status = 1;
    writeFileSync(files.acceptance, JSON.stringify(acceptance));
    const stock = run(files).result;
    expect(stock.status).not.toBe(0);
    expect(stock.stderr).toContain('passing Ubuntu and Debian stock-machine smoke');
  });

  it('verifies every public versioned file before advertising and installs distinct Portal links', () => {
    const files = candidate();
    const published = publication(files);
    expect(published.result.status, published.result.stderr).toBe(0);
    const { events } = published;
    const firstAdvertise = events.findIndex((row) => row.op === 'put' && row.key.endsWith('/latest.json'));
    for (const filename of ['pui-0.1.0-linux-x86_64.tar.gz', 'pui-0.1.0-linux-x86_64.tar.gz.acceptance.json', 'pui-0.1.0-linux-x86_64.tar.gz.sha256']) {
      const verified = events.findIndex((row) => row.op === 'public-get' && row.key.endsWith(`/${filename}`));
      expect(verified).toBeGreaterThan(-1);
      expect(verified).toBeLessThan(firstAdvertise);
    }
    expect(events.at(-1)).toEqual({ op: 'public-get', key: 'unguessable-prefix/pui/index.html' });
    expect(readFileSync(published.portalEnv, 'utf8')).toBe(
      'NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL=https://pub.example.test/unguessable-prefix/pui/index.html\n'
      + 'NEXT_PUBLIC_PORTAL_DESKTOP_DOWNLOAD_URL=https://pub.example.test/unguessable-prefix/index.html\n',
    );
  });

  it('fails closed on storage lookup errors without writing or configuring Portal', () => {
    const published = publication(candidate(), { headFailure: true });
    expect(published.result.status).not.toBe(0);
    expect(published.result.stderr).toContain('absence was not established');
    expect(published.events.some((row) => row.op === 'put')).toBe(false);
    expect(existsSync(published.portalEnv)).toBe(false);
  });

  it('compares existing bytes without metadata and repairs metadata only for identical content', () => {
    const published = publication(candidate(), { existingArchive: 'identical-without-metadata' });
    expect(published.result.status, published.result.stderr).toBe(0);
    expect(published.events).toContainEqual({ op: 'authenticated-get', key: published.archiveKey });
    expect(published.events).toContainEqual({ op: 'public-get', key: published.archiveKey });
  });

  it('refuses different immutable bytes before any upload', () => {
    const published = publication(candidate(), { existingArchive: 'different' });
    expect(published.result.status).not.toBe(0);
    expect(published.result.stderr).toContain('refusing to replace different bytes');
    expect(published.events.some((row) => row.op === 'put')).toBe(false);
  });

  it('never advertises or changes Portal when public archive bytes differ', () => {
    const published = publication(candidate(), { corruptPublicArchive: true });
    expect(published.result.status).not.toBe(0);
    expect(published.result.stderr).toContain('public archive bytes do not match');
    expect(published.events.filter((row) => row.op === 'put').every((row) => row.key.includes('/0.1.0/'))).toBe(true);
    expect(existsSync(published.portalEnv)).toBe(false);
  });
});
