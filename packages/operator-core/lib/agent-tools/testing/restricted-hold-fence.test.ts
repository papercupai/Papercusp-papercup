/**
 * WI-10005634 — the restricted-write fence's REACH logic, against a real temporary checkout and
 * the real import-closure worker. The census half (git-sync's restricted readers) is injected
 * here; restricted-hold-fence.integration.test.ts drives it from real Postgres.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifierGitCheckoutSync, verifierSourceFiles } from '@papercusp/test-config/verifier-source';
import type { RestrictedEditHolding } from '../../personal-vault/git-sync-hold';
import { restrictedHoldBundleRefusal, restrictedHoldRefusal, TEST_ROUTER_PATH } from './restricted-hold-fence';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

let root: string;

function put(rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const hold = (...paths: string[]) => async (): Promise<RestrictedEditHolding[]> =>
  paths.map((path) => ({ path, owner: 'su-restricted', intent: 'restricted-disclosure hold (D-006/P-014): fixture', coordinationDomain: root }));

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'restricted-hold-fence-')));
  put('src/held.ts', 'export const held = 1;\n');
  put('src/clean.ts', 'export const clean = 2;\n');
  // Production code that can spawn a process whose path it assembles at runtime.
  put('src/runner.ts', "import { spawn } from 'node:child_process';\nexport const run = () => spawn('bash', [process.env.SCRIPT ?? '']);\n");
  put('tests/imports-held.test.ts', "import { held } from '../src/held';\nexport const value = held;\n");
  put('tests/clean.test.ts', "import { clean } from '../src/clean';\nexport const value = clean;\n");
  put('tests/uses-runner.test.ts', "import { run } from '../src/runner';\nexport const value = run;\n");
  put('scripts/deploy.sh', '#!/bin/sh\necho deploy\n');
  put('vitest.config.ts', 'export default {};\n');
  put('scripts/lib/router-lib.mjs', 'export const lib = 1;\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('restrictedHoldRefusal — no held writes', () => {
  it('admits every run and builds no closure when nothing is held', async () => {
    const closures = vi.fn();
    expect(await restrictedHoldRefusal(root, ['tests/imports-held.test.ts'], { holdings: hold(), closures })).toBeNull();
    expect(closures).not.toHaveBeenCalled();
  });

  it('ignores holds in a different checkout', async () => {
    const elsewhere = async (): Promise<RestrictedEditHolding[]> => [
      { path: 'src/held.ts', owner: 'su-restricted', intent: 'restricted-disclosure hold (D-006/P-014): fixture', coordinationDomain: '/some/other/repo' },
    ];
    expect(await restrictedHoldRefusal(root, ['tests/imports-held.test.ts'], { holdings: elsewhere })).toBeNull();
  });
});

describe('restrictedHoldRefusal — reach', () => {
  it('refuses a test file that is itself a held restricted write', async () => {
    const refusal = await restrictedHoldRefusal(root, ['tests/clean.test.ts'], { holdings: hold('tests/clean.test.ts') });
    expect(refusal).toMatchObject({ error: 'restricted_write_held' });
    expect(refusal?.hint).toContain('tests/clean.test.ts is itself a held restricted write');
  });

  it('refuses a test whose import closure reaches a held source', async () => {
    const refusal = await restrictedHoldRefusal(root, ['tests/imports-held.test.ts'], { holdings: hold('src/held.ts') });
    expect(refusal).toMatchObject({ error: 'restricted_write_held' });
    expect(refusal?.hint).toMatch(/imports-held\.test\.ts may execute a held restricted write: imports .*src\/held\.ts/);
  });

  it('admits a test whose closure provably cannot reach the held source (calibration)', async () => {
    expect(await restrictedHoldRefusal(root, ['tests/clean.test.ts'], { holdings: hold('src/held.ts') })).toBeNull();
  });

  it('refuses every run while a runner-loaded file is held, whatever the test imports', async () => {
    const refusal = await restrictedHoldRefusal(root, ['tests/clean.test.ts'], { holdings: hold('vitest.config.ts') });
    expect(refusal?.hint).toContain('vitest.config.ts is loaded by the test runner itself');
  });

  it('refuses when a held script exists and the test closure can spawn a process', async () => {
    const refusal = await restrictedHoldRefusal(root, ['tests/uses-runner.test.ts'], { holdings: hold('scripts/deploy.sh') });
    expect(refusal?.hint).toMatch(/src\/runner\.ts can spawn a process and scripts\/deploy\.sh is a held restricted script/);
    // ...but a closure that cannot spawn anything cannot execute the script.
    expect(await restrictedHoldRefusal(root, ['tests/clean.test.ts'], { holdings: hold('scripts/deploy.sh') })).toBeNull();
  });

  it('refuses when the test-files router itself imports a held write', async () => {
    put(TEST_ROUTER_PATH, "import { lib } from './lib/router-lib.mjs';\nexport default lib;\n");
    try {
      const refusal = await restrictedHoldRefusal(root, ['tests/clean.test.ts'], { holdings: hold('scripts/lib/router-lib.mjs') });
      expect(refusal?.hint).toContain('the test runner imports scripts/lib/router-lib.mjs');
    } finally {
      rmSync(join(root, TEST_ROUTER_PATH), { force: true });
    }
  });
});

describe('restrictedHoldRefusal — fail closed', () => {
  it('refuses with state_unknown when the restricted census cannot be read', async () => {
    const broken = async (): Promise<RestrictedEditHolding[]> => { throw new Error('disclosure_ledger_unavailable: fixture'); };
    const refusal = await restrictedHoldRefusal(root, ['tests/clean.test.ts'], { holdings: broken });
    expect(refusal).toMatchObject({ error: 'restricted_hold_state_unknown' });
    expect(refusal?.hint).toContain('disclosure_ledger_unavailable: fixture');
  });

  it('refuses when the import closure cannot be established while writes are held', async () => {
    const closures = vi.fn(async () => ({ status: 'incomplete' as const, reason: 'fixture budget' }));
    const refusal = await restrictedHoldRefusal(root, ['tests/clean.test.ts'], { holdings: hold('src/held.ts'), closures });
    expect(refusal?.hint).toContain('the import closure could not be established (fixture budget)');
  });

  it('refuses a requested test that cannot be resolved while writes are held', async () => {
    const refusal = await restrictedHoldRefusal(root, ['tests/missing.test.ts'], { holdings: hold('src/held.ts') });
    expect(refusal?.hint).toContain('tests/missing.test.ts could not be resolved');
  });
});

// WI-10005745 — the host bundle door: an exact intersection with what the bundle consumed.
describe('restrictedHoldBundleRefusal — independent verifier archive', () => {
  let owned: string | undefined;
  afterEach(() => {
    vi.unstubAllEnvs();
    if (owned) rmSync(owned, { recursive: true, force: true });
    owned = undefined;
  });
  function archive(withSubmodule = false) {
    owned = mkdtempSync(join(tmpdir(), 'bundle-archive-'));
    const selectedRoot = join(owned, 'source');
    mkdirSync(join(selectedRoot, 'src'), { recursive: true });
    writeFileSync(join(selectedRoot, 'src/clean.ts'), 'export const clean = true;\n');
    const git = (args: string[]) => execFileSync('git', ['-C', selectedRoot, ...args], { encoding: 'utf8' }).trim();
    git(['init', '--quiet']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'parent']);
    const submodules: Array<{ path: string; sha: string }> = [];
    if (withSubmodule) {
      const path = 'vendor/library';
      const nested = join(selectedRoot, path);
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, 'clean.ts'), 'export const nested = true;\n');
      const run = (args: string[]) => execFileSync('git', ['-C', nested, ...args], { encoding: 'utf8' }).trim();
      run(['init', '--quiet']);
      run(['add', 'clean.ts']);
      run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'nested source']);
      submodules.push({ path, sha: run(['rev-parse', 'HEAD']) });
      git(['add', path]);
    }
    git(['add', 'src/clean.ts']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'source']);
    const sourceCommit = git(['rev-parse', 'HEAD']);
    const files = verifierSourceFiles(selectedRoot, { gitMetadataPaths: ['.git', ...submodules.map(row => row.path + '/.git')] });
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit,
      testedInputs: [{ path: 'src/clean.ts', sha256: files[0].sha256 }],
      submodules, gitCheckout: verifierGitCheckoutSync(selectedRoot, sourceCommit, submodules), files };
    const receiptPath = join(owned, 'receipt.json');
    writeFileSync(receiptPath, JSON.stringify(receipt));
    writeFileSync(join(selectedRoot, '.verifier-source.json'), JSON.stringify(receipt));
    vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', receiptPath);
    vi.stubEnv('VERIFY_TAURI_SOURCE_REF', receipt.sourceCommit);
    return { selectedRoot, receiptPath, receipt, file: join(selectedRoot, 'src/clean.ts') };
  }

  it('qualifies the real source census and copied directory before admitting without live PG', async () => {
    const a = archive();
    const holdings = vi.fn(async (): Promise<RestrictedEditHolding[]> => { throw new Error('live PG forbidden'); });
    expect(await restrictedHoldBundleRefusal(a.selectedRoot,
      { files: [a.file], dirs: [join(a.selectedRoot, 'src')] }, { holdings })).toBeNull();
    expect(holdings).not.toHaveBeenCalled();
  });

  it('uses verified repository boundaries without rediscovering them for each bundle source', async () => {
    const a = archive();
    vi.mocked(lstat).mockClear();
    expect(await restrictedHoldBundleRefusal(a.selectedRoot,
      { files: [a.file], dirs: [] })).toBeNull();
    const boundaryProbes = vi.mocked(lstat).mock.calls.filter(([path]) =>
      String(path).startsWith(a.selectedRoot + '/') && String(path).endsWith('/.git'));
    expect(boundaryProbes).toEqual([]);
  });

  it('resolves a verified nested repository through the parent Git pin even with a forged newer receipt', async () => {
    const a = archive(true);
    const nested = join(a.selectedRoot, 'vendor/library');
    const file = join(nested, 'clean.ts');
    const inputs = { files: [file], dirs: [] };
    expect(await restrictedHoldBundleRefusal(a.selectedRoot, inputs)).toBeNull();
    writeFileSync(file, 'export const planted = true;\n');
    const git = (args: string[]) => execFileSync('git', ['-C', nested, ...args], { encoding: 'utf8' }).trim();
    git(['add', 'clean.ts']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'unselected nested source']);
    const submodules = [{ path: 'vendor/library', sha: git(['rev-parse', 'HEAD']) }];
    const forged = { ...a.receipt, submodules,
      gitCheckout: verifierGitCheckoutSync(a.selectedRoot, a.receipt.sourceCommit, submodules),
      files: verifierSourceFiles(a.selectedRoot, { gitMetadataPaths: ['.git', 'vendor/library/.git'] }) };
    writeFileSync(a.receiptPath, JSON.stringify(forged));
    writeFileSync(join(a.selectedRoot, '.verifier-source.json'), JSON.stringify(forged));
    const refusal = await restrictedHoldBundleRefusal(a.selectedRoot, inputs);
    expect(refusal?.hint).toContain('differs from committed source: vendor/library/clean.ts');
  });

  it('retains ordered phase boundaries for an admitted archive and localizes a forged receipt refusal', async () => {
    const a = archive();
    const records: Array<{ step: string; event: string; status?: number; error?: string }> = [];
    const progress = (record: typeof records[number]) => { records.push(record); };
    const inputs = { files: [a.file], dirs: [] };
    expect(await restrictedHoldBundleRefusal(a.selectedRoot, inputs, { progress })).toBeNull();
    expect(records).toEqual([
      { step: 'restricted-hold-source-receipt', event: 'start' },
      ...['source-receipt-git-checkout', 'source-receipt-source-census'].flatMap(name => [
        { step: `restricted-hold-${name}`, event: 'start' },
        { step: `restricted-hold-${name}`, event: 'end', status: 0 },
      ]),
      { step: 'restricted-hold-source-receipt', event: 'end', status: 0 },
      ...['input-containment', 'git-origin'].flatMap(name => [
        { step: `restricted-hold-${name}`, event: 'start' },
        { step: `restricted-hold-${name}`, event: 'end', status: 0 },
      ]),
    ]);
    records.length = 0;
    writeFileSync(a.file, 'export const planted = true;');
    const forged = { ...a.receipt, files: verifierSourceFiles(a.selectedRoot, { gitMetadataPaths: ['.git'] }) };
    writeFileSync(a.receiptPath, JSON.stringify(forged));
    writeFileSync(join(a.selectedRoot, '.verifier-source.json'), JSON.stringify(forged));
    expect(await restrictedHoldBundleRefusal(a.selectedRoot, inputs, { progress }))
      .toMatchObject({ error: 'restricted_hold_state_unknown' });
    expect(records.at(-1)).toMatchObject({ step: 'restricted-hold-git-origin', event: 'end', status: 3,
      error: expect.stringContaining('differs from committed source') });
  });

  it('records receipt failure before either input traversal or Git origin begins', async () => {
    const a = archive();
    writeFileSync(a.file, 'export const planted = true;');
    const progress = vi.fn();
    expect(await restrictedHoldBundleRefusal(a.selectedRoot, { files: [a.file], dirs: [] }, { progress }))
      .toMatchObject({ error: 'restricted_hold_state_unknown' });
    expect(progress.mock.calls.map(([record]) => record)).toEqual([
      { step: 'restricted-hold-source-receipt', event: 'start' },
      { step: 'restricted-hold-source-receipt-git-checkout', event: 'start' },
      { step: 'restricted-hold-source-receipt-git-checkout', event: 'end', status: 0 },
      { step: 'restricted-hold-source-receipt-source-census', event: 'start' },
      { step: 'restricted-hold-source-receipt-source-census', event: 'end', status: 3,
        error: expect.stringContaining('tampered verification source archive') },
      { step: 'restricted-hold-source-receipt', event: 'end', status: 3,
        error: expect.stringContaining('tampered verification source archive') },
    ]);
  });

  it('refuses a marker without an independent source receipt', async () => {
    const a = archive();
    vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', '');
    const refusal = await restrictedHoldBundleRefusal(a.selectedRoot, { files: [a.file], dirs: [] });
    expect(refusal).toMatchObject({ error: 'restricted_hold_state_unknown' });
    expect(refusal?.hint).toContain('missing independent verifier source receipt');
  });

  it('refuses changed source instead of falling through to an empty census', async () => {
    const a = archive();
    writeFileSync(a.file, 'export const planted = true;');
    const holdings = vi.fn(hold());
    const refusal = await restrictedHoldBundleRefusal(a.selectedRoot, { files: [a.file], dirs: [] }, { holdings });
    expect(refusal?.hint).toContain('tampered verification source archive');
    expect(holdings).not.toHaveBeenCalled();
  });

  it('refuses an external receipt that differs from the archive marker', async () => {
    const a = archive();
    writeFileSync(a.receiptPath, '{}');
    expect(await restrictedHoldBundleRefusal(a.selectedRoot, { files: [a.file], dirs: [] }))
      .toMatchObject({ error: 'restricted_hold_state_unknown' });
  });

  it('refuses a forged matching receipt over working bytes absent from the selected Git commit', async () => {
    const a = archive();
    writeFileSync(a.file, 'export const planted = true;');
    const forged = { ...a.receipt, files: verifierSourceFiles(a.selectedRoot, { gitMetadataPaths: ['.git'] }) };
    writeFileSync(a.receiptPath, JSON.stringify(forged));
    writeFileSync(join(a.selectedRoot, '.verifier-source.json'), JSON.stringify(forged));
    const refusal = await restrictedHoldBundleRefusal(a.selectedRoot, { files: [a.file], dirs: [] });
    expect(refusal?.hint).toContain('differs from committed source');
  });

  it.each(['file', 'directory', 'dependency-symlink'] as const)('refuses a %s reaching outside the selected archive', async kind => {
    const a = archive();
    let input = a.receiptPath;
    if (kind === 'directory') input = owned!;
    if (kind === 'dependency-symlink') {
      mkdirSync(join(a.selectedRoot, 'node_modules'));
      input = join(a.selectedRoot, 'node_modules/planted.js');
      symlinkSync(a.receiptPath, input);
    }
    const refusal = await restrictedHoldBundleRefusal(a.selectedRoot,
      { files: kind === 'directory' ? [] : [input], dirs: kind === 'directory' ? [input] : [] });
    expect(refusal).toMatchObject({ error: 'restricted_hold_state_unknown' });
    expect(refusal?.hint).toContain('escapes selected archive');
  });

  it('keeps the shared-tree live census even when an archive receipt is selected', async () => {
    archive();
    const holdings = vi.fn(hold('src/held.ts'));
    expect(await restrictedHoldBundleRefusal(root, { files: [join(root, 'src/held.ts')], dirs: [] }, { holdings }))
      .toMatchObject({ error: 'restricted_write_held' });
    expect(holdings).toHaveBeenCalledOnce();
  });
});

describe('restrictedHoldBundleRefusal', () => {
  const abs = (rel: string) => join(root, rel);

  it('admits when nothing is held, or when the held write is not a bundle input (calibration)', async () => {
    const inputs = { files: [abs('src/clean.ts'), abs('src/runner.ts')], dirs: [] };
    expect(await restrictedHoldBundleRefusal(root, inputs, { holdings: hold() })).toBeNull();
    expect(await restrictedHoldBundleRefusal(root, inputs, { holdings: hold('src/held.ts') })).toBeNull();
  });

  it('refuses a held write that esbuild recorded as a bundle input', async () => {
    const refusal = await restrictedHoldBundleRefusal(root, { files: [abs('src/clean.ts'), abs('src/held.ts')], dirs: [] }, { holdings: hold('src/held.ts') });
    expect(refusal?.error).toBe('restricted_write_held');
    expect(refusal?.hint).toContain('src/held.ts is a bundle input and a held restricted write');
    expect(refusal?.hint).toContain('last-known-good');
  });

  it('refuses a held file inside a directory the bundler copies verbatim', async () => {
    const refusal = await restrictedHoldBundleRefusal(root, { files: [], dirs: [abs('scripts')] }, { holdings: hold('scripts/deploy.sh') });
    expect(refusal?.hint).toContain('scripts/deploy.sh is a bundle input');
    // A sibling directory that merely shares the prefix is not the copied directory.
    expect(await restrictedHoldBundleRefusal(root, { files: [], dirs: [abs('scr')] }, { holdings: hold('scripts/deploy.sh') })).toBeNull();
  });

  it('ignores holds in a different checkout', async () => {
    const elsewhere = async (): Promise<RestrictedEditHolding[]> => [
      { path: 'src/held.ts', owner: 'su-restricted', intent: 'restricted-disclosure hold (D-006/P-014): fixture', coordinationDomain: '/some/other/repo' },
    ];
    expect(await restrictedHoldBundleRefusal(root, { files: [abs('src/held.ts')], dirs: [] }, { holdings: elsewhere })).toBeNull();
  });

  it('fails closed when the census cannot be read', async () => {
    const broken = async (): Promise<RestrictedEditHolding[]> => {
      throw new Error('census offline');
    };
    const refusal = await restrictedHoldBundleRefusal(root, { files: [abs('src/clean.ts')], dirs: [] }, { holdings: broken });
    expect(refusal?.error).toBe('restricted_hold_state_unknown');
    expect(refusal?.hint).toContain('census offline');
  });
});
