import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildWorkspace, captureClosure } from '../../bin/release/dependency-generation-verifier.mjs';
import { nativeVerifierEnv } from '../../../../scripts/lib/verify-tauri-native-env.mjs';
import { bindFrozenDependencyGeneration } from '../../../../packages/operator-core/lib/dependency-generation-proof';
import { runVerifierCommand, selectVerifierDependencySnapshot } from '../../../../scripts/source-preview.mjs';

const repo = resolve(__dirname, '../../../..');
const script = join(repo, 'apps/operator/bin/release/dependency-generation.sh');
const helper = join(repo, 'papercusp-desktop/bin/lib/pinned-deps.sh');
const roots: string[] = [];
function write(root: string, path: string, body: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}
function fixture(workspace = 'packages/cli') {
  const root = mkdtempSync(join(tmpdir(), 'native-generation-closure-')); roots.push(root);
  const donor = join(root, 'source'), dest = join(root, 'selected'), store = join(root, 'store');
  // Freeze the current implementation as committed fixture tooling. The
  // production source loader must remain enabled; otherwise a shell child can
  // silently substitute the previous committed helper for the code under test.
  const tooling = join(root, 'tooling');
  cpSync(dirname(script), join(tooling, 'apps/operator/bin/release'), { recursive: true });
  // The lock-tree auditor's source-only CLI guard is a runtime dependency,
  // including when the shell fixture runs before any npm installation.
  const cliEntry = 'packages/operator-core/lib/util/cli-entry.ts';
  write(tooling, cliEntry, readFileSync(join(repo, cliEntry), 'utf8'));
  write(tooling, 'papercusp-desktop/bin/lib/pinned-deps.sh', readFileSync(helper, 'utf8'));
  execFileSync('git', ['init', '-q'], { cwd: tooling });
  execFileSync('git', ['add', '.'], { cwd: tooling });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'current generation tooling under test'], { cwd: tooling });
  const generationScript = join(tooling, 'apps/operator/bin/release/dependency-generation.sh');
  const snapshotHelper = join(tooling, 'papercusp-desktop/bin/lib/pinned-deps.sh');
  write(donor, '.gitignore', 'node_modules/\ndist/\n');
  write(donor, 'package.json', '{"name":"native-generation-fixture","private":true}');
  write(donor, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
    'node_modules/pkg': { version: '1.0.0' },
  } }));
  write(donor, workspace + '/package.json', '{"name":"probe","bin":{"probe":"dist/cli.cjs"},"scripts":{"build":"node build.cjs"}}');
  write(donor, workspace + '/src/cli.cjs', 'console.log("frozen-workspace");\n');
  write(donor, workspace + '/build.cjs', `
const fs = require('node:fs'), path = require('node:path');
if (process.env.NATIVE_BUILD_PARENT) {
  const relative = path.relative(process.env.NATIVE_BUILD_PARENT, process.cwd());
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('native rebuild left the immutable store filesystem');
  fs.writeFileSync(process.env.NATIVE_BUILD_RECEIPT, process.cwd());
}
fs.mkdirSync('dist');fs.copyFileSync('src/cli.cjs','dist/cli.cjs');
`);
  // Any attempted canonical reader is an immediate test failure.
  write(donor, 'scripts/npm-install-safe.mjs', 'process.stderr.write("DONOR_READ_FORBIDDEN");process.exit(93);');
  write(donor, 'papercusp-desktop/package.json', '{"name":"desktop"}');
  write(donor, 'papercusp-desktop/package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
    'node_modules/@tauri-apps/cli': { version: '2.0.0' },
  } }));
  cpSync(join(tooling, 'apps'), join(donor, 'apps'), { recursive: true });
  write(donor, cliEntry, readFileSync(join(tooling, cliEntry), 'utf8'));
  write(donor, 'papercusp-desktop/bin/lib/pinned-deps.sh', readFileSync(snapshotHelper, 'utf8'));
  execFileSync('git', ['init', '-q'], { cwd: donor });
  execFileSync('git', ['add', '.'], { cwd: donor });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'source for generated workspace output'], { cwd: donor });
  cpSync(donor, dest, { recursive: true });
  write(dest, '.verifier-source.json', JSON.stringify({ files: [{ path: workspace + '/package.json' }] }));
  write(donor, 'node_modules/pkg/package.json', '{"name":"pkg","version":"1.0.0"}');
  write(donor, 'node_modules/pkg/index.js', 'published dependency');
  mkdirSync(join(donor, 'node_modules/.bin'));
  symlinkSync('../../' + workspace + '/dist/cli.cjs', join(donor, 'node_modules/.bin/probe'));
  write(donor, 'papercusp-desktop/node_modules/@tauri-apps/cli/package.json', '{"name":"@tauri-apps/cli","version":"2.0.0"}');
  write(donor, 'papercusp-desktop/node_modules/@tauri-apps/cli/tauri.js', '#!/usr/bin/env node\n');
  chmodSync(join(donor, 'papercusp-desktop/node_modules/@tauri-apps/cli/tauri.js'), 0o755);
  mkdirSync(join(donor, 'papercusp-desktop/node_modules/.bin'));
  symlinkSync('../@tauri-apps/cli/tauri.js', join(donor, 'papercusp-desktop/node_modules/.bin/tauri'));
  buildWorkspace(donor, workspace, [process.execPath, 'build.cjs']);
  const env = { ...process.env, PAPERCUSP_DEPENDENCY_GENERATION_ROOT: store,
    DEPENDENCY_GENERATION_COPY_LOCK_FILE: join(root, 'copy.lock'), DEPENDENCY_GENERATION_FORCE_COPY: '1' };
  const shell = (file: string, args: string[], extra = {}) => spawnSync('bash', [file, ...args],
    { env: { ...env, ...extra }, encoding: 'utf8', timeout: 90_000 });
  const publish = () => {
    const result = shell(generationScript, ['--integration', donor, '--generation-root', store]);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.match(/\bpath=([^\n]+)$/m)![1]!;
  };
  return { root, donor, dest, store, env, shell, publish, snapshotHelper, generationScript };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('D012 native generation closure', () => {
  it.each(['source-stale', 'incomplete'])('rebuilds a %s exact-ref native closure with unchanged locks, then reuses it', async defect => {
    const f = fixture();
    if (defect === 'incomplete') rmSync(join(f.donor, 'packages/cli/dist/.papercusp-workspace-build.json'));
    const before = f.publish();
    const oldClosure = readFileSync(join(before, '.verifier-closure.json'), 'utf8');
    // Only source changes; the lock/patch key still selects the old generation.
    write(f.dest, 'packages/cli/src/cli.cjs', 'console.log("new-exact-source");\n');
    execFileSync('git', ['add', 'packages/cli/src/cli.cjs'], { cwd: f.dest });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'new exact source with unchanged dependencies'], { cwd: f.dest });
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.dest, encoding: 'utf8' }).trim();
    // The donor knows the commit but its working source remains at the old ref.
    execFileSync('git', ['fetch', f.dest, ref], { cwd: f.donor });
    const stale = f.shell(f.snapshotHelper, ['preflight-generation', f.dest, f.dest]);
    expect(stale.status).toBe(74);
    expect(stale.stderr).toContain(defect === 'incomplete' ? 'incomplete-closure' : 'stale-build-input');

    const args = ['--integration', f.donor, '--generation-root', f.store,
      '--ensure-ref', ref, '--verifier-source', f.dest, '--retain-as', 'native-exact-test'];
    const buildReceipt = join(f.root, 'native-build-root');
    const rebuilt = f.shell(f.generationScript, args, {
      NATIVE_BUILD_PARENT: f.store, NATIVE_BUILD_RECEIPT: buildReceipt,
    });
    expect(rebuilt.status, rebuilt.stderr).toBe(0);
    expect(readFileSync(buildReceipt, 'utf8')
      .startsWith(join(f.store, '.papercusp/dependency-exact-ref/native-'))).toBe(true);
    expect(rebuilt.stdout).toContain('reused=false');
    const after = rebuilt.stdout.match(/\bpath=([^\n]+)$/m)![1]!;
    expect(after).not.toBe(before);
    expect(readFileSync(join(after, 'tree/packages/cli/dist/cli.cjs'), 'utf8')).toContain('new-exact-source');
    expect(readFileSync(join(before, '.verifier-closure.json'), 'utf8')).toBe(oldClosure);
    if (defect === 'source-stale')
      expect(readFileSync(join(before, 'tree/packages/cli/dist/cli.cjs'), 'utf8')).toContain('frozen-workspace');
    expect(existsSync(join(f.dest, 'node_modules'))).toBe(false);
    expect(existsSync(join(f.dest, 'packages/cli/dist'))).toBe(false);
    expect(readdirSync(join(f.donor, '.papercusp/dependency-exact-ref'))).toEqual([]);
    expect(readdirSync(join(f.store, '.papercusp/dependency-exact-ref'))).toEqual([]);
    expect(existsSync(join(f.store, '.leases')) ? readdirSync(join(f.store, '.leases')) : []).toEqual([]);
    const compatible = f.shell(f.snapshotHelper, ['preflight-generation', f.dest, f.dest]);
    expect(compatible.status, compatible.stderr).toBe(0);
    // Another source with the same locks can republish its dependency selector
    // without invalidating this frozen native source's closure or proof.
    expect(f.publish()).toBe(before);
    const republished = f.shell(f.snapshotHelper, ['preflight-generation', f.dest, f.dest]);
    expect(republished.status, republished.stderr).toBe(0);
    const reused = f.shell(f.generationScript, args);
    expect(reused.status, reused.stderr).toBe(0);
    expect(reused.stdout).toContain('reused=true');
    expect(reused.stdout).toContain('path=' + after);
    const materialized = f.shell(f.snapshotHelper, ['snapshot-generation-locked', f.donor, f.dest]);
    expect(materialized.status, materialized.stderr).toBe(0);
    expect(spawnSync(process.execPath, [join(f.dest, 'node_modules/.bin/probe')], { encoding: 'utf8' }).stdout)
      .toBe('new-exact-source\n');
    expect(readFileSync(join(f.dest, '.papercusp-pinned-deps'), 'utf8')).toMatch(/selector=native-[0-9a-f]{64}/);
    vi.stubEnv('PAPERCUSP_DEPENDENCY_GENERATION_ROOT', f.store);
    try {
      const binding = await bindFrozenDependencyGeneration(f.dest, ref);
      expect(binding.identity.dependencyGeneration).toBe(after.split('/').pop());
      await binding.assertUnchanged();
    } finally { vi.unstubAllEnvs(); }
  }, 120_000);

  it('refuses a corrupt native selector instead of falling back to a valid dependency selector', () => {
    const f = fixture();
    f.publish();
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.dest, encoding: 'utf8' }).trim();
    const args = ['--integration', f.donor, '--generation-root', f.store,
      '--ensure-ref', ref, '--verifier-source', f.dest];
    const indexed = f.shell(f.generationScript, args);
    expect(indexed.status, indexed.stderr).toBe(0);
    const key = readdirSync(join(f.store, '.inputs')).find(name => name.startsWith('native-'))!;
    expect(key).toMatch(/^native-[0-9a-f]{64}$/);
    const selector = join(f.store, '.inputs', key);
    writeFileSync(selector, readFileSync(selector, 'utf8').replace(/^token=.*$/m, 'token=v3:' + '0'.repeat(64)));
    for (const [file, argv] of [[f.generationScript, args],
      [f.snapshotHelper, ['preflight-generation', f.dest, f.dest]],
      [f.snapshotHelper, ['snapshot-generation-locked', f.donor, f.dest]]] as const) {
      const refused = f.shell(file, [...argv]);
      expect(refused.status, refused.stderr).toBe(74);
    }
    expect(existsSync(join(f.dest, 'node_modules'))).toBe(false);
    expect(existsSync(join(f.dest, '.papercusp-pinned-deps'))).toBe(false);
  }, 120_000);

  it('refuses dirty native source before publishing or changing the existing selector', () => {
    const f = fixture(), generation = f.publish();
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.dest, encoding: 'utf8' }).trim();
    write(f.dest, 'packages/cli/src/cli.cjs', 'dirty source');
    const result = f.shell(f.generationScript, ['--integration', f.donor, '--generation-root', f.store,
      '--ensure-ref', ref, '--verifier-source', f.dest]);
    expect(result.status).toBe(74);
    expect(result.stderr).toContain('dirty-verifier-source');
    expect(f.publish()).toBe(generation);
    expect(existsSync(join(f.dest, 'node_modules'))).toBe(false);
  }, 120_000);

  it('runs the source-preview command from a generation without a physical dependency donor', async () => {
    const workspace = 'packages/omp-plugin';
    const f = fixture(workspace);
    write(f.donor, '.gitignore', 'node_modules/\ndist/\n/.papercusp/scratch/\n');
    // The fixture CLI has no TypeScript imports. Its private loader package is
    // still resolved through the real --import tsx preparation path.
    write(f.donor, 'scripts/source-preview.mjs',
      'console.log(process.argv.includes("verifier-measure") ? "4096" : "inputs-ok");\n');
    const lock = JSON.parse(readFileSync(join(f.donor, 'package-lock.json'), 'utf8'));
    lock.packages['node_modules/tsx'] = { version: '4.0.0' };
    write(f.donor, 'package-lock.json', JSON.stringify(lock));
    write(f.donor, 'node_modules/tsx/package.json',
      '{"name":"tsx","version":"4.0.0","type":"module","exports":"./index.mjs"}');
    write(f.donor, 'node_modules/tsx/index.mjs', 'export {};\n');
    execFileSync('git', ['add', '.gitignore', 'package-lock.json', 'scripts/source-preview.mjs'], { cwd: f.donor });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'source-preview generation command inputs'], { cwd: f.donor });
    buildWorkspace(f.donor, workspace, [process.execPath, 'build.cjs']);
    const generation = f.publish();
    for (const path of ['node_modules', workspace + '/dist', 'papercusp-desktop/node_modules'])
      rmSync(join(f.donor, path), { recursive: true });
    const receiptPath = join(f.root, 'command.json');
    const env = { ...f.env, NODE_OPTIONS: '', NODE_PATH: '',
      PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(Date.now() + 300_000) };
    const code = await runVerifierCommand({ repo: f.donor, ref: 'HEAD', receiptPath,
      inputs: ['scripts/source-preview.mjs'], env,
      command: [process.execPath, 'node_modules/.bin/probe'],
      prepareChildEnv: async ({ sourceRoot }) => {
        for (const path of ['node_modules/pkg/index.js', workspace + '/dist/cli.cjs',
          'papercusp-desktop/node_modules/@tauri-apps/cli/tauri.js'])
          expect(statSync(join(sourceRoot, path)).ino).not.toBe(statSync(join(generation, 'tree', path)).ino);
        return {};
      } });
    expect(code).toBe(0);
    const phases = readFileSync(receiptPath + '.phases.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(phases.find(row => row.phase === 'deps.snapshot' && row.event === 'started').snapshotSelection)
      .toMatchObject({ explicitGeneration: true, command: 'snapshot-generation-locked' });
    expect(phases.filter(row => row.event === 'completed').map(row => row.phase))
      .toEqual(expect.arrayContaining(['source.freeze', 'deps.snapshot', 'deps.inputs', 'deps.measure',
        'deps.census', 'child.run', 'deps.postverify', 'source.postverify', 'cleanup']));
    expect(JSON.parse(readFileSync(receiptPath + '.dependencies.after.json', 'utf8')))
      .toEqual(JSON.parse(readFileSync(receiptPath + '.dependencies.json', 'utf8')));
    const task = JSON.parse(readFileSync(receiptPath + '.task.json', 'utf8'));
    expect(task.cleanup).toBe('completed');
    expect(existsSync(task.ownedRoot)).toBe(false);
    expect(existsSync(join(f.store, '.leases')) ? readdirSync(join(f.store, '.leases')) : []).toEqual([]);
  }, 120_000);

  it('consumes leased workspace and exact desktop closures with donor reads refused and private inodes', async () => {
    const f = fixture(), generation = f.publish();
    rmSync(join(f.donor, 'node_modules'), { recursive: true });
    rmSync(join(f.donor, 'packages/cli/dist'), { recursive: true });
    rmSync(join(f.donor, 'papercusp-desktop/node_modules'), { recursive: true });
    const preflight = f.shell(f.snapshotHelper, ['preflight-generation', f.dest, f.dest]);
    expect(preflight.status, preflight.stderr).toBe(0);
    const child = nativeVerifierEnv(f.env, { repoRoot: f.dest });
    expect(child.PAPERCUSP_REPO_DIR).toBe(f.dest);
    expect(child.VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE).toBe('copy');
    expect(selectVerifierDependencySnapshot('hardlink', true, true).command).toBe('snapshot-generation-locked');
    expect(() => selectVerifierDependencySnapshot('hardlink', false, true)).toThrow('does not support');
    const shellSource = readFileSync(join(repo, 'scripts/verify-tauri-headless.sh'), 'utf8');
    const cliCheck = shellSource.match(/^preflight_desktop_tauri_cli\(\) \{[\s\S]*?^\}/m)![0];
    const earlyCheck = spawnSync('bash', ['-c', cliCheck + '\npreflight_desktop_tauri_cli'], {
      env: { ...f.env, REPO_DIR: f.dest, DESKTOP_DIR: join(f.dest, 'papercusp-desktop'),
        VERIFY_TAURI_SOURCE_REF: child.VERIFY_TAURI_SOURCE_REF }, encoding: 'utf8', timeout: 30_000,
    });
    expect(earlyCheck.status, earlyCheck.stderr).toBe(0);
    const size = f.shell(f.snapshotHelper, ['preflight-generation', f.dest, f.dest, 'size']);
    expect(size.status, size.stderr).toBe(0);
    expect(Number(size.stdout.trim())).toBeGreaterThan(0);
    const result = f.shell(f.snapshotHelper, ['snapshot-generation-locked', f.donor, f.dest]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('DONOR_READ_FORBIDDEN');
    const launched = spawnSync(process.execPath, [join(f.dest, 'node_modules/.bin/probe')], { encoding: 'utf8' });
    expect(launched.status, launched.stderr).toBe(0);
    expect(launched.stdout).toBe('frozen-workspace\n');
    for (const path of ['node_modules/pkg/index.js', 'packages/cli/dist/cli.cjs',
      'papercusp-desktop/node_modules/@tauri-apps/cli/tauri.js'])
      expect(statSync(join(f.dest, path)).ino).not.toBe(statSync(join(generation, 'tree', path)).ino);
    expect(readFileSync(join(f.dest, '.papercusp-pinned-deps'), 'utf8')).toContain('mode=generation-copy');
    expect(existsSync(join(f.store, '.leases')) ? readdirSync(join(f.store, '.leases')) : []).toEqual([]);
    vi.stubEnv('PAPERCUSP_DEPENDENCY_GENERATION_ROOT', f.store);
    try {
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.dest, encoding: 'utf8' }).trim();
      const binding = await bindFrozenDependencyGeneration(f.dest, commit);
      await binding.assertUnchanged();
      const output = join(f.dest, 'packages/cli/dist/cli.cjs');
      chmodSync(output, 0o644); writeFileSync(output, 'tampered materialized output');
      await expect(binding.assertUnchanged()).rejects.toThrow('stale-workspace-output');
      await expect(bindFrozenDependencyGeneration(f.dest, commit)).rejects.toThrow('stale-workspace-output');
    } finally { vi.unstubAllEnvs(); }
  }, 120_000);

  it.each(['source', 'added-source', 'output', 'receipt', 'desktop-lock', 'missing-desktop', 'publication'])(
    'refuses %s custody before copying dependencies', defect => {
      const f = fixture(), generation = f.publish();
      if (defect === 'source') write(f.dest, 'packages/cli/src/cli.cjs', 'changed selected source');
      if (defect === 'added-source') write(f.dest, 'packages/cli/src/new.cjs', 'new source');
      if (defect === 'desktop-lock') write(f.dest, 'papercusp-desktop/package-lock.json', '{}');
      if (defect === 'output') {
        const path = join(generation, 'tree/packages/cli/dist/cli.cjs'); chmodSync(path, 0o644); writeFileSync(path, 'changed output');
      }
      if (defect === 'receipt') rmSync(join(generation, '.verifier-closure.json'));
      if (defect === 'missing-desktop') rmSync(join(generation, 'tree/papercusp-desktop/node_modules'), { recursive: true });
      if (defect === 'publication') {
        const path = join(generation, '.papercusp-dependency-generation'); chmodSync(path, 0o644);
        writeFileSync(path, readFileSync(path, 'utf8').replace(/^publication_token=.*$/m, 'publication_token=v3:' + '0'.repeat(64)));
      }
      const preflight = f.shell(f.snapshotHelper, ['preflight-generation', f.dest, f.dest]);
      expect(preflight.status, preflight.stderr).not.toBe(0);
      expect(() => nativeVerifierEnv(f.env, { repoRoot: f.dest })).toThrow('generation preflight failed');
      const result = f.shell(f.snapshotHelper, ['snapshot-generation-locked', f.donor, f.dest]);
      expect(result.status, result.stderr).not.toBe(0);
      expect(existsSync(join(f.dest, '.papercusp-pinned-deps'))).toBe(false);
      expect(existsSync(join(f.dest, 'node_modules'))).toBe(false);
      expect(result.stderr).not.toContain('DONOR_READ_FORBIDDEN');
      expect(existsSync(join(f.store, '.leases')) ? readdirSync(join(f.store, '.leases')) : []).toEqual([]);
    }, 120_000);

  it('refuses a newly required dist bin with the same locks and a legitimately empty workspace receipt', () => {
    const f = fixture();
    write(f.donor, 'packages/cli/package.json', '{"name":"probe","bin":{"probe":"src/cli.cjs"}}');
    // No package/lock dependency changed; the selected source still needs the
    // generated dist bin which was absent from the producer's requirements.
    const generation = f.publish();
    expect(JSON.parse(readFileSync(join(generation, '.verifier-closure.json'), 'utf8')))
      .toMatchObject({ complete: true, workspaces: [] });
    const result = f.shell(f.snapshotHelper, ['snapshot-generation-locked', f.donor, f.dest]);
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain('workspace-requirements-mismatch');
    expect(existsSync(join(f.dest, 'node_modules'))).toBe(false);
    expect(existsSync(join(f.dest, '.papercusp-pinned-deps'))).toBe(false);
  }, 120_000);

  it('never blesses old output with new source hashes, and rebuilds under a new identity', () => {
    const f = fixture(), before = f.publish();
    write(f.donor, 'packages/cli/src/cli.cjs', 'console.log("rebuilt");\n');
    expect(captureClosure(f.donor)).toMatchObject({ complete: false, reason: expect.stringContaining('stale-build-input') });
    buildWorkspace(f.donor, 'packages/cli', [process.execPath, 'build.cjs']);
    expect(captureClosure(f.donor)).toMatchObject({ complete: true });
    expect(f.publish()).not.toBe(before);
  }, 120_000);

  it('rejects a failed or drifting producer without leaving a success receipt', () => {
    const f = fixture();
    expect(() => buildWorkspace(f.donor, 'packages/cli', [process.execPath, '-e', 'process.exit(2)'])).toThrow('build-failed');
    expect(existsSync(join(f.donor, 'packages/cli/dist/.papercusp-workspace-build.json'))).toBe(false);
    expect(() => buildWorkspace(f.donor, 'packages/cli', [process.execPath, '-e',
      'require("node:fs").writeFileSync("src/new.cjs","changed");'])).toThrow('source-changed-during-build');
  });
});
