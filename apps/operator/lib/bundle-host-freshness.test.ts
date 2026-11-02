/**
 * WI-10007018 — bin/bundle-host-freshness.mjs output-tree identity.
 *
 * bundle-host.sh stamps freshness while its build-private restricted-hold gate dirs
 * (`.restricted-gate-meta.$$` esbuild metafiles, `.restricted-lkg.$$` snapshot) still sit
 * inside OUTDIR, then its EXIT trap deletes them. A stamp that hashed them could never be
 * verified (papercup-rust-mobile CI run 37543418448: "freshness manifest output-tree mismatch").
 * These tests drive the real CLI against a throwaway git repo.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { makeBgCompilerCandidate, BG_R1_BUILDER_CASES, BG_R1_PARENT_SELECTORS } from '../../../packages/operator-core/lib/source-preview.fixture';
import { prepareBgVerifierBuildRecord, verifyBgVerifierBuildRecord } from '../../../scripts/source-preview.mjs';
import { verifierResourceInventory } from '../../../packages/operator-core/lib/verifier-source';

// Overridable so scripts/mutation-probe.sh can point the suite at a mutated COPY.
const HELPER_SOURCE =
  process.env.PROBE_SCRIPT ?? resolve(fileURLToPath(new URL('.', import.meta.url)), '../bin/bundle-host-freshness.mjs');
let helperDir: string;
let HELPER: string;

beforeAll(() => {
  // Execute the exact helper under test, including a mutation-probe copy.
  // A child committed-source loader must not silently replace an edited helper.
  helperDir = mkdtempSync(join(tmpdir(), 'bundle-freshness-helper-'));
  HELPER = join(helperDir, 'freshness.mjs');
  buildSync({ entryPoints: [HELPER_SOURCE], outfile: HELPER, bundle: true,
    platform: 'node', format: 'esm' });
});
afterAll(() => { if (helperDir) rmSync(helperDir, { recursive: true, force: true }); });

let repo: string;
let outdir: string;

function run(op: 'stamp' | 'check', entry = join(repo, 'entry.ts')) {
  return spawnSync(
    process.execPath,
    [
      HELPER,
      op,
      '--repo-root',
      repo,
      '--entry',
      entry,
      '--outfile',
      join(outdir, 'hono-host.mjs'),
      '--manifest',
      join(outdir, '.bundle-fresh.json'),
    ],
    { encoding: 'utf8' },
  );
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'bundle-freshness-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(join(repo, 'entry.ts'), 'export {};\n');
  writeFileSync(join(repo, '.gitignore'), 'dist-host/\nnode_modules/\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  outdir = join(repo, 'dist-host');
  mkdirSync(outdir);
  writeFileSync(join(outdir, 'hono-host.mjs'), 'console.log(1);\n');
  writeFileSync(join(outdir, 'worker.mjs'), 'console.log(2);\n');
  mkdirSync(join(repo, 'node_modules'));
  writeFileSync(join(repo, 'node_modules/.package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

it('BG-TEARDOWN-RECONCILE preserves source compiler and boot evidence during cleanup', async () => {
  expect(run('stamp').status).toBe(0);
  const privateRoot = mkdtempSync(join(tmpdir(), 'bg-cleanup-evidence-'));
  try {
    const candidate = join(privateRoot, 'candidate'); mkdirSync(candidate);
    const retained = [join(repo, 'entry.ts'), join(repo, 'node_modules/.package-lock.json'),
      join(outdir, '.bundle-fresh.json'), join(outdir, 'hono-host.mjs')];
    for (const name of ['active', 'rollback', 'peer']) {
      const path = join(privateRoot, name); writeFileSync(path, `original ${name} sentinel`); retained.push(path);
    }
    const before = retained.map(path => ({ path, bytes: readFileSync(path), identity: statSync(path) }));
    const custody = { source: retained[0], compilerInputs: retained[1], bootEvidence: retained[2] };
    const ledger = verifierResourceInventory({ path: join(privateRoot, 'cleanup.jsonl'),
      owner: 'bundle-cleanup-fixture', custody, deadlineEpochMs: 200, now: () => 100 });
    ledger.record({ id: 'candidate', kind: 'root', path: candidate });
    before.forEach(({ path }, i) => ledger.record({ id: `retained:${i}`, kind: 'binding', path,
      retain: 'original source/compiler/boot evidence or active/rollback/peer sentinel' }));
    const prefix = readFileSync(join(privateRoot, 'cleanup.jsonl'), 'utf8');
    rmSync(candidate, { recursive: true });
    const terminal = await ledger.reconcile({ outcome: 'success', custody });
    expect(terminal).toMatchObject({ sealed: true, status: 'completed', deadlineExceeded: false, survivors: [] });
    expect(terminal.observations.filter(row => row.state === 'retained')).toHaveLength(before.length);
    for (const { path, bytes, identity } of before) {
      expect(readFileSync(path)).toEqual(bytes);
      expect(statSync(path)).toMatchObject({ dev: identity.dev, ino: identity.ino });
    }
    expect(readFileSync(join(privateRoot, 'cleanup.jsonl'), 'utf8').startsWith(prefix)).toBe(true);
    expect(run('check').status).toBe(0);
    const negative = verifierResourceInventory({ path: join(privateRoot, 'unsettled.jsonl'),
      owner: 'bundle-cleanup-fixture', custody, deadlineEpochMs: 200, now: () => 100 });
    negative.record({ id: 'original-boot-evidence', kind: 'binding', path: retained[2]!, retain: 'original boot evidence' });
    const unchanged = readFileSync(join(privateRoot, 'unsettled.jsonl'));
    writeFileSync(retained[2]!, 'replaced boot evidence');
    await expect(negative.reconcile({ outcome: 'success', custody })).rejects.toThrow('retained inventory resource changed');
    expect(readFileSync(join(privateRoot, 'unsettled.jsonl'))).toEqual(unchanged);
    expect(run('check').status).not.toBe(0);
    writeFileSync(retained[2]!, before[2]!.bytes);
    expect(await negative.reconcile({ outcome: 'success', custody })).toMatchObject({ sealed: true, status: 'completed' });
    expect(run('check').status).toBe(0);
  } finally { rmSync(privateRoot, { recursive: true, force: true }); }
});

describe('BG original builder identity', () => {
  const boundaries = ['before-build', 'before-publication'] as const;
  let serial = 0;

  async function invocationDefect(boundary: typeof boundaries[number], defect?: 'builder-configuration' | 'toolchain-identity') {
    const { prepared, dependencies } = await makeBgCompilerCandidate(join(repo, `bg-builder-${++serial}`));
    const invocation = { builder: join(prepared.root, 'apps/operator/bin/bundle-host.sh'),
      argv: ['--bundle', '--platform=node', '--target=node22'], node: process.execPath,
      compiler: join(prepared.root, 'node_modules/fixture-dependency/index.js'),
      packageManager: join(prepared.root, 'node_modules/fixture-package-manager/cli.js'),
      configuration: [join(prepared.root, 'package-lock.json')], environment: { NODE_OPTIONS: '', NODE_PATH: '', PATH: '/fixture/bin' } };
    const originalReceipt = readFileSync(join(prepared.root, '.verifier-source.json'));
    const record = prepareBgVerifierBuildRecord({ prepared, dependencies, invocation });
    const recordBytes = JSON.stringify(record);
    expect(verifyBgVerifierBuildRecord(record, invocation, boundary)).toBe(record);
    if (defect) {
      if (defect === 'builder-configuration') invocation.argv.push('--target=node23');
      else invocation.node = invocation.packageManager;
      expect(() => verifyBgVerifierBuildRecord(record, invocation, boundary))
        .toThrow('BG builder configuration or toolchain identity changed');
    }
    expect(JSON.stringify(record)).toBe(recordBytes);
    expect(readFileSync(join(prepared.root, '.verifier-source.json'))).toEqual(originalReceipt);
  }

  for (const { boundary, defect, testName } of BG_R1_BUILDER_CASES) {
    it(testName, () => invocationDefect(boundary, defect));
  }
  it(BG_R1_PARENT_SELECTORS.builder.testName, async () => {
    for (const boundary of boundaries) for (const defect of ['builder-configuration', 'toolchain-identity'] as const)
      await invocationDefect(boundary, defect);
  });
  it('preserves unchanged original builder inputs at both compiler boundaries', async () => {
    for (const boundary of boundaries) await invocationDefect(boundary);
  });
});

describe('bundle-host-freshness output-tree identity', () => {
  it('qualifies a committed shadow without npm cache reuse and rejects provenance drift', () => {
    const ordinary = join(repo, 'node_modules/.package-lock.json');
    const source = join(repo, 'node_modules/.source-package-lock.json');
    writeFileSync(source, readFileSync(ordinary));
    rmSync(ordinary);
    symlinkSync(source, join(repo, 'node_modules/.papercusp-installed-package-lock.json'));
    const stamp = run('stamp');
    expect(stamp.status, stamp.stderr).toBe(0);
    expect(run('check').status).toBe(0);
    expect(existsSync(ordinary)).toBe(false);
    writeFileSync(source, '{"lockfileVersion":3,"packages":{"sdk":{"version":"2.0.0"}}}\n');
    const check = run('check');
    expect(check.status).not.toBe(0);
    expect(check.stderr).toContain('installed-dependency mismatch');
  });

  it('verifies after bundle-host.sh EXIT trap deletes the build-private gate dirs', () => {
    const meta = join(outdir, '.restricted-gate-meta.4242');
    const lkg = join(outdir, '.restricted-lkg.4242');
    mkdirSync(meta);
    mkdirSync(join(lkg, 'files'), { recursive: true });
    writeFileSync(join(meta, 'hono-host.mjs.meta.json'), '{"inputs":{}}');
    writeFileSync(join(meta, 'copied-sources.txt'), 'a.ts\n');
    writeFileSync(join(lkg, 'files', 'old.mjs'), 'old');

    const stamp = run('stamp');
    expect(stamp.status, stamp.stderr).toBe(0);

    rmSync(meta, { recursive: true });
    rmSync(lkg, { recursive: true });

    const check = run('check');
    expect(check.stderr).not.toContain('output-tree mismatch');
    expect(check.status, check.stderr).toBe(0);
  });

  it('still refuses when a real runtime sibling changes after the stamp (control)', () => {
    expect(run('stamp').status).toBe(0);
    writeFileSync(join(outdir, 'worker.mjs'), 'console.log(3);\n');
    const check = run('check');
    expect(check.status).not.toBe(0);
    expect(check.stderr).toContain('output-tree mismatch');
  });
});

describe('host boot artifact provenance', () => {
  function stagingFixture() {
    const entry = join(repo, 'apps/operator/bin/host.ts');
    mkdirSync(join(repo, 'apps/operator/bin'), { recursive: true });
    writeFileSync(entry, 'export const trace = true;\n');
    execFileSync('git', ['-C', repo, 'add', 'apps/operator/bin/host.ts']);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'host']);
    outdir = join(repo, 'apps/operator/dist-host');
    mkdirSync(outdir, { recursive: true });
    const outfile = join(outdir, 'hono-host.mjs');
    writeFileSync(outfile, 'export const trace = true;\n');
    writeFileSync(outfile + '.meta.json', JSON.stringify({ inputs: { 'apps/operator/bin/host.ts': {} } }));
    const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    return { entry, outfile, sha };
  }

  function buildStamp(f: ReturnType<typeof stagingFixture>, reuse: '0' | '1', sourceSha = f.sha) {
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const source = readFileSync(new URL('../bin/bundle-host.sh', import.meta.url), 'utf8');
    const boundary = source.lastIndexOf('# Stamp only after the bundle');
    expect(boundary).toBeGreaterThan(0);
    const script = [
      'set -euo pipefail',
      'COMMITTED_NODE=(' + quote(process.execPath) + ')',
      'FRESHNESS_HELPER=' + quote(HELPER),
      'REPO_ROOT=' + quote(repo),
      'ENTRY=' + quote(f.entry),
      'OUTFILE=' + quote(f.outfile),
      'FRESH_MARKER=' + quote(join(outdir, '.bundle-fresh.json')),
      'SOURCE_SHA=' + quote(sourceSha),
      source.slice(boundary),
    ].join('\n');
    return spawnSync('bash', ['-c', script], {
      encoding: 'utf8', env: { ...process.env, PAPERCUSP_BUNDLE_REUSE_FRESH: reuse },
    });
  }

  function boot(f: ReturnType<typeof stagingFixture>, startedAtMs?: number) {
    const module = new URL('../../../packages/operator-core/lib/release/operator-artifact.ts', import.meta.url).href;
    const args = [f.outfile, f.sha, ...(startedAtMs === undefined ? [] : [startedAtMs])];
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval',
      'import { measureBootOperatorArtifact } from ' + JSON.stringify(module) +
      '; console.log(JSON.stringify(measureBootOperatorArtifact(...' + JSON.stringify(args) + ')));'],
    { encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout);
  }

  it.each(['0', '1'] as const)('qualifies clean host compiler inputs with freshness reuse=%s', (reuse) => {
    const f = stagingFixture();
    const built = buildSync({ absWorkingDir: repo, entryPoints: ['apps/operator/bin/host.ts'],
      outfile: f.outfile, bundle: true, platform: 'node', format: 'esm', metafile: true });
    writeFileSync(f.outfile + '.meta.json', JSON.stringify(built.metafile));
    const stamped = buildStamp(f, reuse);
    expect(stamped.status, stamped.stderr).toBe(0);
    expect(boot(f)).toMatchObject({ status: 'measured', sourceSha: f.sha });
  });

  it('keeps dirty background inputs unqualified without failing the availability build', () => {
    const f = stagingFixture();
    writeFileSync(f.entry, 'export const trace = false;\n');
    const stamped = buildStamp(f, '0');
    expect(stamped.status, stamped.stderr).toBe(0);
    expect(stamped.stderr).toContain('tracked source tree is dirty');
    expect(boot(f).status).toBe('unknown');
    expect(existsSync(join(outdir, '.bundle-fresh.json'))).toBe(false);
  });

  it('refuses a changed HEAD after the build captured its source identity', () => {
    const f = stagingFixture();
    writeFileSync(join(repo, 'entry.ts'), 'export const changed = true;\n');
    execFileSync('git', ['-C', repo, 'add', 'entry.ts']);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'move']);
    const stamped = buildStamp(f, '0');
    expect(stamped.status, stamped.stderr).toBe(0);
    expect(stamped.stderr).toContain('build source HEAD mismatch');
    expect(boot(f).status).toBe('unknown');
  });

  it('does not qualify a process that started before the artifact was produced', () => {
    const f = stagingFixture();
    expect(buildStamp(f, '0').status).toBe(0);
    expect(boot(f, 1).status).toBe('unknown');
    expect(boot(f).status).toBe('measured');
  });

  it('writes an artifact that a fresh staging process can measure at boot', () => {
    const f = stagingFixture();
    // bundle_host_esbuild runs through the cache reader at the repository root.
    // Use the actual compiler's paths so a synthetic operator-relative fixture
    // cannot hide a mismatch between the build and artifact writer.
    const built = buildSync({ absWorkingDir: repo, entryPoints: ['apps/operator/bin/host.ts'],
      outfile: f.outfile, bundle: true, platform: 'node', format: 'esm', metafile: true });
    expect(Object.keys(built.metafile!.inputs)).toContain('apps/operator/bin/host.ts');
    writeFileSync(f.outfile + '.meta.json', JSON.stringify(built.metafile));
    const stamped = run('stamp', f.entry);
    expect(stamped.status, stamped.stderr).toBe(0);
    const module = new URL('../../../packages/operator-core/lib/release/operator-artifact.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval',
      `import { measureBootOperatorArtifact } from ${JSON.stringify(module)}; console.log(JSON.stringify(measureBootOperatorArtifact(${JSON.stringify(f.outfile)}, ${JSON.stringify(f.sha)})));`],
    { encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ status: 'measured', sourceSha: f.sha,
      sourceBlobs: { 'apps/operator/bin/host.ts': expect.stringMatching(/^[a-f0-9]{40}$/) } });
    expect(run('check', f.entry).status).toBe(0);
  });

  it('refuses a staging freshness stamp without compiler input provenance', () => {
    const f = stagingFixture();
    rmSync(f.outfile + '.meta.json');
    expect(run('stamp', f.entry).status).not.toBe(0);
  });
});

describe('bundle-host-freshness installed dependencies', () => {
  function install(path: string, version: string) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'sdk', version }));
  }

  it('rejects a changed installed lock with unchanged HEAD and output bytes', () => {
    expect(run('stamp').status).toBe(0);
    writeFileSync(join(repo, 'node_modules/.package-lock.json'), '{"lockfileVersion":3,"packages":{"sdk":{"version":"2.0.0"}}}\n');
    const check = run('check');
    expect(check.status).not.toBe(0);
    expect(check.stderr).toContain('installed-dependency mismatch');
  });

  it('rejects physical package drift even when the installed lock is unchanged', () => {
    const sdk = join(repo, 'node_modules/@vendor/sdk');
    install(sdk, '3.0.0');
    expect(run('stamp').status).toBe(0);
    install(sdk, '2.0.0');
    const check = run('check');
    expect(check.status).not.toBe(0);
    expect(check.stderr).toContain('installed-dependency mismatch');
  });

  it('rejects a newly shadowing nested package with unchanged root metadata', () => {
    const sdk = join(repo, 'node_modules/sdk');
    install(sdk, '3.0.0');
    expect(run('stamp').status).toBe(0);
    install(join(sdk, 'node_modules/core'), '2.0.0');
    const check = run('check');
    expect(check.status).not.toBe(0);
    expect(check.stderr).toContain('installed-dependency mismatch');
  });

  it('pins workspace symlink resolution and terminates dependency cycles', () => {
    const first = join(repo, 'workspace-a');
    const second = join(repo, 'workspace-b');
    install(first, '1.0.0');
    install(second, '1.0.0');
    mkdirSync(join(first, 'node_modules'));
    symlinkSync(first, join(first, 'node_modules/self'));
    const link = join(repo, 'node_modules/sdk');
    symlinkSync(first, link);
    expect(run('stamp').status).toBe(0);
    expect(run('check').status).toBe(0);
    rmSync(link);
    symlinkSync(second, link);
    const check = run('check');
    expect(check.status).not.toBe(0);
    expect(check.stderr).toContain('installed-dependency mismatch');
  });

  it('refuses reusable proof without an installed lock', () => {
    expect(run('stamp').status).toBe(0);
    rmSync(join(repo, 'node_modules/.package-lock.json'));
    expect(run('check').status).not.toBe(0);
    expect(run('stamp').stderr).toContain('installed dependency lock is missing');
  });

  it('invalidates legacy proofs that never pinned installed dependencies', () => {
    expect(run('stamp').status).toBe(0);
    const path = join(outdir, '.bundle-fresh.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.schemaVersion = 'bundle-host-freshness-v1';
    delete manifest.dependencies;
    writeFileSync(path, JSON.stringify(manifest));
    const check = run('check');
    expect(check.status).not.toBe(0);
    expect(check.stderr).toContain('schema mismatch');
  });
});
