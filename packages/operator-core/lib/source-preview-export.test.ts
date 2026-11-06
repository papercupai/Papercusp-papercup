/**
 * scripts/source-preview.mjs export — plan dhh-source-preview-2026-09-28 R-1/R-3/R-4
 * (P-001, P-002).
 *
 * The preview must be the SAME public-safe cut the desktop installer ships
 * (sidecar/source.tar.zst), minus node_modules — not a second, hand-kept list.
 * The parity case proves that by running the shared selection library in its
 * INSTALLER mode over the same clean tree and comparing file sets, so a future
 * edit that forks the two selections fails here.
 *
 * Every case drives a synthetic superproject under tmpdir; nothing touches the
 * shared checkout.
 */
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { once } from 'node:events';
import type { Sql } from 'postgres';
import { createHash } from 'node:crypto';
import nativeFs, { chmodSync, cpSync, existsSync, fstatSync, linkSync, mkdirSync, mkdtempSync, promises as fsPromises, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ROOT as SOURCE_ROOT,
  ADDED_FILES,
  SELECTION_LIB,
  TAURI_VERIFIER_INPUTS,
  allowlistTops,
  exportSnapshot,
  loadReleaseHost,
  materializeCommit,
  measureVerifierSourceBytes,
  prepareVerifierSource,
  prepareBgVerifierSource,
  verifyBgVerifierSource,
  createBgVerifierCompilerCustody,
  prepareBgVerifierBuildRecord,
  prepareBgVerifierBuildContexts,
  prepareBgVerifierBuildTransaction,
  beginBgVerifierBuildTransaction,
  expandBgVerifierAssetTrees,
  stageBgVerifierAssetCopies,
  qualifyBgVerifierBuildOutputSet,
  verifyBgVerifierBuildOutputSet,
  qualifyBgVerifierLogicalOutputSet,
  verifyBgVerifierLogicalOutputSet,
  publishBgVerifierLogicalOutputSet,
  verifyBgVerifierPublication,
  runBgVerifierBuildRecipe,
  verifyBgVerifierBuildRecord,
  compileBgVerifierInvocation,
  qualifyBgVerifierOutput,
  verifyBgVerifierOutputRecord,
  prepareVerifierDependencies,
  runVerifierDependencyCommand,
  captureVerifierDependencies,
  runVerifierCommand,
  verifierPhaseRunner,
  verifierCommandAdmissionEnv,
  readVerifierPhaseMeasurements,
  estimateVerifierCommandBudget,
  admitVerifierCommandBudget,
  validateVerifierInputs,
  runCli,
  verifyVerifierSource,
  verifierSourceChildEnv,
  releasesPageUrl,
  sourceYear,
} from '../../../scripts/source-preview.mjs';
import { BG_INPUTS, DROPPED, INTERNAL_DOC_CONTENTS, SHIPPED, childEnv, git, makeBgCandidate, makeBgCompilerCandidate, makeSuperproject, write, type Superproject } from './source-preview.fixture';
import { BG_R1_CASE_REGISTRY, BG_R1_SOURCE_CASES, BG_R1_MEMBER_CASES, BG_R1_PARENT_SELECTORS } from './source-preview.fixture';
import r1Manifest from './source-preview.r1-cases.fixture.json';
import { BG_R4_CASE_REGISTRY, BG_R4_CUSTODY_CASES, BG_R4_TEARDOWN_CASES } from './source-preview.fixture';
import r4Manifest from './source-preview.r4-cases.fixture.json';
import { captureTestSourceSnapshot } from './testing-worktree';
import { measureBootOperatorArtifact } from './release/operator-artifact';
import { cleanupEndedVerifierDirectories, verifierResourceInventory, verifierSourceFiles, writeVerifierTaskReceipt } from './verifier-source';
import { readProcessIdentity } from './process-identity';
import { bindFrozenDependencyGeneration } from './dependency-generation-proof';
import { closeTask } from './task-manager/store';
import type { TaskRow } from './task-manager/types';

let tmp: string;
let fx: Superproject;
let out: string;

describe('BG teardown resource inventory source controls', () => {
  const roots: string[] = [];
  afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'bg-teardown-ledger-'));
    roots.push(root);
    const owned = join(root, 'owned'), peer = join(root, 'peer');
    mkdirSync(owned); writeFileSync(peer, 'original peer sentinel');
    const custody = { 'parent-fire24': { subject: 'original-parent', fire: 24 }, owner: 'original-owner',
      origin: 'original-origin', 'error-history': ['original failure'], 'evidence-reference': ['original-proof'] };
    let at = 100;
    const options = { path: join(root, 'resources.jsonl'), owner: 'fixture-owned-attempt',
      deadlineEpochMs: 200, custody, now: () => at };
    const ledger = verifierResourceInventory(options);
    ledger.record({ id: 'candidate', kind: 'root', path: owned });
    ledger.record({ id: 'peer', kind: 'binding', path: peer, retain: 'peer sentinel' });
    return { root, owned, peer, custody, options, ledger, advance: (value: number) => { at = value; } };
  }

  async function helperTree(ledger: ReturnType<typeof verifierResourceInventory>) {
    const child = spawn(process.execPath, ['-e',
      'const {spawn}=require("node:child_process"); const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); console.log(c.pid); setInterval(()=>{},1000);'],
    { detached: true, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    let stdout = '', stderr = '', launchError: string | undefined;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
    child.on('error', error => { launchError = String(error); });
    const stop = async () => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await closed;
    };
    try {
      await vi.waitFor(() => expect(stdout.trim(), JSON.stringify({ pid: child.pid,
        exitCode: child.exitCode, signal: child.signalCode, launchError, stderr })).toMatch(/^\d+$/), { timeout: 5_000 });
      const identity = readProcessIdentity(child.pid!);
      expect(identity).toBeTypeOf('string');
      ledger.record({ id: 'helper', kind: 'process', pid: child.pid!, processIdentity: identity!, processGroup: child.pid! });
      return { latePid: Number(stdout.trim()), stop };
    } catch (error) { await stop(); throw error; }
  }

  it('BG-TEARDOWN-RECONCILE keeps recursive inventory append-only through late-child reconciliation', async () => {
    const f = fixture();
    const child = spawn(process.execPath, ['-e',
      'const {spawn}=require("node:child_process"); const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); console.log(c.pid); setInterval(()=>{},1000);'],
    { detached: true, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    try {
      await vi.waitFor(() => expect(stdout.trim()).toMatch(/^\d+$/), { timeout: 5_000 });
      const latePid = Number(stdout.trim());
      const identity = readProcessIdentity(child.pid!);
      expect(identity).toBeTypeOf('string');
      f.ledger.record({ id: 'helper', kind: 'process', pid: child.pid!, processIdentity: identity!, processGroup: child.pid! });
      const prefix = readFileSync(f.options.path, 'utf8');
      rmSync(f.owned, { recursive: true });
      const unresolved = await f.ledger.reconcile({ outcome: 'success', custody: f.custody });
      expect(unresolved.sealed).toBe(false);
      expect(unresolved.observations).toContainEqual(expect.objectContaining({ pid: latePid, state: 'live',
        processIdentity: readProcessIdentity(latePid) }));
      const discovered = readFileSync(f.options.path, 'utf8');
      expect(discovered.startsWith(prefix)).toBe(true);
      process.kill(-child.pid!, 'SIGKILL');
      await closed;
      const recovered = verifierResourceInventory({ ...f.options, resume: true, expectedHistory: f.ledger.checkpoint() });
      const terminal = await recovered.reconcile({ outcome: 'success', custody: f.custody });
      expect(terminal).toMatchObject({ sealed: true, status: 'completed', survivors: [] });
      expect(terminal.observations).toContainEqual(expect.objectContaining({ pid: latePid, state: 'exited' }));
      expect(readFileSync(f.options.path, 'utf8').startsWith(discovered)).toBe(true);
      expect(readFileSync(f.peer, 'utf8')).toBe('original peer sentinel');
      expect(() => recovered.record({ id: 'too-late', kind: 'root', path: f.owned })).toThrow('already sealed');
    } finally {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await closed;
    }
  });

  it('BG-TEARDOWN-RECONCILE preserves original parent fire24 owner origin and errors custody', async () => {
    const f = fixture();
    const original = readFileSync(f.options.path, 'utf8');
    const changed = structuredClone(f.custody); changed['error-history'].push('rewritten child history');
    await expect(f.ledger.reconcile({ outcome: 'success', custody: changed })).rejects.toThrow('original parent custody changed');
    expect(readFileSync(f.options.path, 'utf8')).toBe(original);
    expect(() => verifierResourceInventory({ ...f.options, resume: true, expectedHistory: f.ledger.checkpoint(), deadlineEpochMs: 201 }))
      .toThrow('original owner, custody or deadline changed');
  });

  for (const { field, action, testName } of BG_R4_CUSTODY_CASES) {
    it(testName, async () => {
      const f = fixture();
      rmSync(f.owned, { recursive: true });
      const changed: Record<string, unknown> = structuredClone(f.custody);
      if (action === 'delete') delete changed[field];
      else changed[field] = action === 'reset' ? null : action === 'replace' ? { replacement: 'new attempt' } : 'rewritten';
      const before = readFileSync(f.options.path, 'utf8');
      await expect(f.ledger.reconcile({ outcome: 'success', custody: changed })).rejects.toThrow('original parent custody changed');
      expect(readFileSync(f.options.path, 'utf8')).toBe(before);
      const positive = await f.ledger.reconcile({ outcome: 'success', custody: f.custody });
      expect(positive).toMatchObject({ sealed: true, status: 'completed', deadlineExceeded: false });
    });
  }

  for (const { outcome, timing, testName } of BG_R4_TEARDOWN_CASES) {
    it(testName, async () => {
      const f = fixture();
      // A new root is first inventoried during cleanup; it must be present in
      // the terminal census even though the candidate has already been removed.
      const late = join(f.root, 'late-output'); mkdirSync(late);
      rmSync(f.owned, { recursive: true });
      f.ledger.record({ id: 'late-output', kind: 'root', path: late });
      const helper = await helperTree(f.ledger);
      try {
      f.advance(timing === 'immediately-before' ? 199 : timing === 'exactly-at' ? 200 : 201);
      const unresolved = await f.ledger.reconcile({ outcome, custody: f.custody });
      expect(unresolved).toMatchObject({ sealed: false, survivors: expect.arrayContaining(['late-output', 'helper']),
        deadlineExceeded: timing !== 'immediately-before' });
      expect(unresolved.observations).toContainEqual(expect.objectContaining({ pid: helper.latePid, state: 'live' }));
      const prefix = readFileSync(f.options.path, 'utf8');
      rmSync(late, { recursive: true });
      await helper.stop();
      const recovered = verifierResourceInventory({ ...f.options, resume: true, expectedHistory: f.ledger.checkpoint() });
      if (timing === 'immediately-before') {
        // Independent admissible D-epsilon control, then advance THIS unresolved
        // operation through its original D; success cannot erase expiry.
        const control = fixture(); rmSync(control.owned, { recursive: true }); control.advance(199);
        expect(await control.ledger.reconcile({ outcome, custody: control.custody }))
          .toMatchObject({ sealed: true, deadlineExceeded: false, status: outcome === 'success' ? 'completed' : 'failed' });
        f.advance(200);
      }
      const terminal = await recovered.reconcile({ outcome, custody: f.custody });
      expect(terminal).toMatchObject({ outcome, sealed: true, status: 'failed', deadlineEpochMs: 200, deadlineExceeded: true });
      expect(terminal.observations).toContainEqual(expect.objectContaining({ id: 'late-output', state: 'removed' }));
      expect(terminal.observations).toContainEqual(expect.objectContaining({ pid: helper.latePid, state: 'exited' }));
      expect(readFileSync(f.options.path, 'utf8').startsWith(prefix)).toBe(true);
      expect(readFileSync(f.peer, 'utf8')).toBe('original peer sentinel');
      } finally { await helper.stop(); }
    });
  }

  it('BG-TEARDOWN-RECONCILE refuses terminal success after the predeclared teardown deadline', async () => {
    const f = fixture(); f.advance(200);
    expect(await f.ledger.reconcile({ outcome: 'cancellation', custody: f.custody }))
      .toMatchObject({ sealed: false, deadlineExceeded: true, status: 'incomplete' });
    rmSync(f.owned, { recursive: true });
    f.advance(201);
    await expect(f.ledger.reconcile({ outcome: 'success', custody: f.custody })).rejects.toThrow('original teardown outcome changed');
    expect(await f.ledger.reconcile({ outcome: 'cancellation', custody: f.custody }))
      .toMatchObject({ sealed: true, deadlineExceeded: true, status: 'failed', outcome: 'cancellation' });
  });

  it('refuses inventory rewrite, duplicate resource and retained-peer corruption before settlement', async () => {
    const f = fixture();
    const before = readFileSync(f.options.path, 'utf8');
    expect(() => f.ledger.record({ id: 'candidate', kind: 'root', path: f.owned })).toThrow('unique stable id');
    expect(readFileSync(f.options.path, 'utf8')).toBe(before);
    writeFileSync(f.peer, 'changed sentinel');
    await expect(f.ledger.reconcile({ outcome: 'success', custody: f.custody })).rejects.toThrow('retained inventory resource changed');
    const history = f.ledger.checkpoint();
    writeFileSync(f.options.path, before.slice(0, -1));
    expect(() => verifierResourceInventory({ ...f.options, resume: true, expectedHistory: history })).toThrow('incomplete append');
    expect(() => f.ledger.record({ id: 'new', kind: 'root', path: join(f.root, 'new') })).toThrow('history changed before append');
  });

  it('refuses complete-event truncation after restart against independently retained history', () => {
    const f = fixture();
    const history = f.ledger.checkpoint();
    expect(() => verifierResourceInventory({ ...f.options, resume: true })).toThrow('independently retained history anchor');
    const first = readFileSync(f.options.path, 'utf8').split('\n')[0]! + '\n';
    writeFileSync(f.options.path, first);
    expect(() => verifierResourceInventory({ ...f.options, resume: true, expectedHistory: history }))
      .toThrow('recovery history anchor changed');
  });
});

// Ordinary CI checks declarations. Acceptance also uses resolveTestCasePopulation
// with one completed canonical receipt for every row, including this census and
// P-002's restart case. This declaration guard does not manufacture those receipts.
it('bg-r4-census requires exact predeclared selector and branch population', () => {
  const key = (row: { rowId: string; file: string; testName: string }) =>
    JSON.stringify([row.rowId, row.file, row.testName]);
  expect(r4Manifest.revision).toBe(12);
  expect(r4Manifest.cases).toHaveLength(42);
  expect(BG_R4_CASE_REGISTRY.map(key).sort()).toEqual(r4Manifest.cases.map(key).sort());
  expect(new Set(BG_R4_CASE_REGISTRY.map(row => row.rowId)).size).toBe(42);
  expect(new Set(BG_R4_CASE_REGISTRY.map(row => JSON.stringify([row.file, row.testName]))).size).toBe(42);
  expect(new Set(BG_R4_CASE_REGISTRY.map(row => row.file))).toEqual(new Set([
    'packages/operator-core/lib/source-preview-export.test.ts',
    'apps/operator/lib/bundle-host-freshness.test.ts',
    'packages/operator-core/lib/release/operator-artifact.test.ts',
    'packages/operator-core/lib/agent-tools/dev/restart.test.ts',
  ]));
});

// This ordinary CI guard proves declarations only. Acceptance additionally needs
// a completed canonical receipt for every manifest row, including this guard.
it('bg-r1-census requires exact predeclared selector and branch population', () => {
  const key = (row: { rowId: string; file: string; testName: string }) =>
    JSON.stringify([row.rowId, row.file, row.testName]);
  expect(r1Manifest.revision).toBe(10);
  expect(r1Manifest.cases).toHaveLength(32);
  expect(BG_R1_CASE_REGISTRY.map(key).sort()).toEqual(r1Manifest.cases.map(key).sort());
  expect(new Set(BG_R1_CASE_REGISTRY.map(row => row.rowId)).size).toBe(32);
  expect(new Set(BG_R1_CASE_REGISTRY.map(row => JSON.stringify([row.file, row.testName]))).size).toBe(32);
  expect(new Set(BG_R1_CASE_REGISTRY.map(row => row.file))).toEqual(new Set([
    'packages/operator-core/lib/source-preview-export.test.ts',
    'apps/operator/lib/bundle-host-freshness.test.ts',
    'packages/operator-core/lib/release/operator-artifact.test.ts',
  ]));
});

describe('immutable generation verifier snapshots', () => {
  it.each(['complete', 'verifier-binding', 'missing-closure', 'missing-selector', 'changed-input', 'changed-token', 'changed-publication-after-copy', 'missing-output'])(
    'materializes leased independent dependencies and refuses incomplete custody (%s)', async defect => {
      const root = mkdtempSync(join(tmpdir(), 'verifier-generation-case-'));
      const donor = join(root, 'donor'), dest = join(root, 'invoked'), store = join(root, 'generations');
      // Commit current tooling in an isolated fixture so the source loader
      // measures this implementation without substituting older helper bytes.
      const helperPath = 'papercusp-desktop/bin/lib/pinned-deps.sh';
      const helper = join(root, helperPath);
      write(root, helperPath, readFileSync(join(SOURCE_ROOT, helperPath), 'utf8'));
      // The generation implementation remains this test's subject; preserve its
      // relative support files beside the separately frozen helper.
      cpSync(join(SOURCE_ROOT, 'apps/operator/bin/release'), join(root, 'apps/operator/bin/release'),
        { recursive: true });
      const cliEntryPath = 'packages/operator-core/lib/util/cli-entry.ts';
      write(root, cliEntryPath, readFileSync(join(SOURCE_ROOT, cliEntryPath), 'utf8'));
      git(root, ['init', '-q']);
      git(root, ['add', '.']);
      git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'current generation tooling']);
      const generation = join(root, 'apps/operator/bin/release/dependency-generation.sh');
      const env: NodeJS.ProcessEnv & { DEPENDENCY_GENERATION_COPY_LOCK_FILE: string } = {
        ...childEnv(), PAPERCUSP_DEPENDENCY_GENERATION_ROOT: store,
        DEPENDENCY_GENERATION_COPY_LOCK_FILE: join(root, 'copy.lock'),
        DEPENDENCY_GENERATION_ALLOW_HARDLINK: '1' };
      const shell = (file: string, args: string[], extra = {}) => spawnSync('bash', [file, ...args],
        { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60_000 });
      try {
        for (const path of ['package.json', 'package-lock.json']) {
          const body = path === 'package.json' ? '{"name":"fixture","private":true}'
            : JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {
              'node_modules/pkg': { version: '1.0.0' },
              ...(defect === 'verifier-binding'
                ? { 'packages/cli/node_modules/nested': { version: '1.0.0' } } : {}),
            } });
          write(donor, path, body); write(dest, path, body);
        }
        write(donor, 'node_modules/pkg/package.json', '{"name":"pkg","version":"1.0.0"}');
        write(donor, 'node_modules/pkg/index.js', 'published dependency');
        if (defect === 'verifier-binding') {
          // A generation can contain its donor's old release provenance. The
          // verifier producer's own receipt identifies what it actually copied.
          write(donor, 'node_modules/.papercusp-dependency-generation',
            `identity=v1-${'f'.repeat(64)}\nsource=${'f'.repeat(64)}\n`);
          write(donor, 'packages/cli/node_modules/nested/package.json', '{"name":"nested","version":"1.0.0"}');
        }
        const pkg = '{"name":"cli","bin":{"probe":"dist/run.js"}}';
        write(donor, 'packages/cli/package.json', pkg); write(dest, 'packages/cli/package.json', pkg);
        write(donor, 'packages/cli/src/run.js', 'console.log("workspace executable");\n');
        write(dest, 'packages/cli/src/run.js', 'console.log("workspace executable");\n');
        write(donor, 'node_modules/.bin/seed', '');
        symlinkSync('../../packages/cli/dist/run.js', join(donor, 'node_modules/.bin/probe'));
        write(dest, '.verifier-source.json', JSON.stringify({ files: [{ path: 'packages/cli/package.json' }] }));
        for (const tree of [donor, dest]) {
          cpSync(join(root, 'apps/operator/bin/release'), join(tree, 'apps/operator/bin/release'), { recursive: true });
          write(tree, cliEntryPath, readFileSync(join(root, cliEntryPath), 'utf8'));
          write(tree, '.gitignore', 'node_modules/\ndist/\n.verifier-source.json\n');
          write(tree, 'scripts/npm-install-safe.mjs', 'process.stderr.write("DONOR_READ_FORBIDDEN");process.exit(91);');
          git(tree, ['init', '-q']);
          git(tree, ['add', '.']);
          git(tree, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'frozen input fixture']);
        }
        const sourceCommit = git(dest, ['rev-parse', 'HEAD']).trim();
        const build = spawnSync(process.execPath, [join(donor, 'apps/operator/bin/release/dependency-generation-verifier.mjs'),
          'build', donor, 'packages/cli', '--', process.execPath, '-e',
          'const fs=require("node:fs");fs.mkdirSync("dist");fs.copyFileSync("src/run.js","dist/run.js");'],
        { encoding: 'utf8', env: childEnv() });
        expect(build.status, build.stderr).toBe(0);
        const published = shell(generation, ['--integration', donor, '--generation-root', store]);
        expect(published.status, published.stderr).toBe(0);
        const generationPath = published.stdout.match(/\bpath=([^\n]+)$/m)![1]!;
        const input = published.stdout.match(/\binput=([a-f0-9]+)/)![1]!;
        if (defect === 'missing-closure') rmSync(join(generationPath, '.verifier-closure.json'));
        if (defect === 'missing-selector') rmSync(join(store, '.inputs', input));
        if (defect === 'changed-input') write(dest, 'package-lock.json', '{"name":"different","lockfileVersion":3,"packages":{}}');
        if (defect === 'changed-token') {
          const selector = join(store, '.inputs', input);
          writeFileSync(selector, readFileSync(selector, 'utf8').replace(/^token=.*$/m, 'token=v3:' + '0'.repeat(64)));
        }
        if (defect === 'missing-output') rmSync(join(generationPath, 'tree/packages/cli/dist/run.js'));
        const extra: Record<string, string> = {};
        if (defect === 'changed-publication-after-copy') {
          const bin = join(root, 'fault-bin');
          write(root, 'fault-bin/cp', '#!/bin/bash\n/bin/cp "$@" || exit $?\n' +
            'chmod u+w "$TEST_PUBLICATION_MARKER"\n' +
            "sed -i 's/^publication_token=.*/publication_token=invalid/' \"$TEST_PUBLICATION_MARKER\"\n");
          chmodSync(join(bin, 'cp'), 0o755);
          extra.PATH = bin + ':' + env.PATH;
          extra.TEST_PUBLICATION_MARKER = join(generationPath, '.papercusp-dependency-generation');
        }
        // A changed mutable install must never become the verifier's dependency.
        write(donor, 'node_modules/pkg/index.js', 'mutable donor changed');
        const result = shell(helper, ['snapshot-generation-locked', donor, dest, 'copy'], extra);
        expect(result.stderr).not.toContain('DONOR_READ_FORBIDDEN');
        const leases = existsSync(join(store, '.leases')) ? readdirSync(join(store, '.leases')) : [];
        expect(leases.filter(p => p.startsWith('selector-'))).toEqual([]);
        expect(spawnSync('flock', ['-n', env.DEPENDENCY_GENERATION_COPY_LOCK_FILE, 'true']).status).toBe(0);
        if (defect !== 'complete' && defect !== 'verifier-binding') {
          expect(result.status, result.stdout + result.stderr).not.toBe(0);
          expect(existsSync(join(dest, '.papercusp-pinned-deps'))).toBe(false);
          if (defect !== 'missing-output' && defect !== 'changed-publication-after-copy') {
            expect(existsSync(join(dest, 'node_modules'))).toBe(false);
            expect(existsSync(join(root, 'reader-entered'))).toBe(false);
          }
          return;
        }
        expect(result.status, result.stderr).toBe(0);
        const dependency = 'node_modules/pkg/index.js';
        expect(readFileSync(join(dest, dependency), 'utf8')).toBe('published dependency');
        expect(statSync(join(dest, dependency)).ino).not.toBe(statSync(join(generationPath, 'tree', dependency)).ino);
        const launched = spawnSync(process.execPath, [join(dest, 'node_modules/.bin/probe')],
          { encoding: 'utf8', env: childEnv() });
        expect(launched, launched.stderr).toMatchObject({ status: 0, stdout: 'workspace executable\n' });
        expect(readFileSync(join(dest, '.papercusp-pinned-deps'), 'utf8')).toContain('mode=generation-copy');
        if (defect === 'verifier-binding') {
          expect(existsSync(join(dest, 'node_modules/.papercusp-isolated-snapshot'))).toBe(false);
          expect(readFileSync(join(dest, 'node_modules/.papercusp-dependency-generation'), 'utf8'))
            .toContain(`identity=v1-${'f'.repeat(64)}`);
          vi.stubEnv('PAPERCUSP_DEPENDENCY_GENERATION_ROOT', store);
          try {
            const binding = await bindFrozenDependencyGeneration(dest, sourceCommit);
            expect(binding.identity.dependencyGeneration).toBe(generationPath.split(sep).at(-1));
            expect(binding.trees).toEqual(['node_modules', 'packages/cli/node_modules']);
            await binding.assertUnchanged();
            const pin = join(dest, '.papercusp-pinned-deps');
            const original = readFileSync(pin, 'utf8');
            writeFileSync(pin, original.replace(/^token=.*$/m, `token=v3:${'0'.repeat(64)}`));
            await expect(bindFrozenDependencyGeneration(dest, sourceCommit)).rejects.toThrow(/token|generation/);
            await expect(binding.assertUnchanged()).rejects.toThrow(/provenance/);
            writeFileSync(pin, original);
            writeFileSync(pin, original.replace(/^input=.*$/m, `input=${'0'.repeat(64)}`));
            await expect(bindFrozenDependencyGeneration(dest, sourceCommit)).rejects.toThrow(/input/);
            writeFileSync(pin, original);
            writeFileSync(pin, original.replace(/^trees=.*$/m, 'trees=1'));
            await expect(bindFrozenDependencyGeneration(dest, sourceCommit)).rejects.toThrow(/tree count/);
            writeFileSync(pin, original.replace(/^mode=.*$/m, 'mode=copy'));
            await expect(bindFrozenDependencyGeneration(dest, sourceCommit)).rejects.toThrow(/provenance/);
            writeFileSync(pin, original);
            const selector = join(store, '.inputs', input);
            const selectorBytes = readFileSync(selector, 'utf8');
            writeFileSync(selector, selectorBytes.replace(/^identity=.*$/m, `identity=v1-${'0'.repeat(64)}`));
            await expect(bindFrozenDependencyGeneration(dest, sourceCommit)).rejects.toThrow(/input\/generation mismatch/);
            await expect(binding.assertUnchanged()).rejects.toThrow(/provenance/);
            writeFileSync(selector, selectorBytes);
            const publication = join(generationPath, '.papercusp-dependency-generation');
            const publicationBytes = readFileSync(publication, 'utf8');
            chmodSync(publication, 0o644);
            writeFileSync(publication, publicationBytes.replace(/^publication_token=.*$/m, `publication_token=v3:${'0'.repeat(64)}`));
            await expect(bindFrozenDependencyGeneration(dest, sourceCommit)).rejects.toThrow(/invalid publication token/);
            await expect(binding.assertUnchanged()).rejects.toThrow(/provenance/);
            writeFileSync(publication, publicationBytes);
            const lock = join(dest, 'package-lock.json');
            const lockBytes = readFileSync(lock, 'utf8');
            writeFileSync(lock, '{}');
            await expect(bindFrozenDependencyGeneration(dest, sourceCommit)).rejects.toThrow(/committed dependency input changed|stale-build-input:package-lock.json/);
            await expect(binding.assertUnchanged()).rejects.toThrow(/committed dependency input changed/);
            writeFileSync(lock, lockBytes);
            const nested = join(dest, 'packages/cli/node_modules/nested/package.json');
            const nestedBytes = readFileSync(nested, 'utf8');
            chmodSync(nested, 0o644);
            writeFileSync(nested, '{}');
            await expect(bindFrozenDependencyGeneration(dest, sourceCommit)).rejects.toThrow(/materialized dependency tree drift/);
            await expect(binding.assertUnchanged()).rejects.toThrow(/materialized dependency tree changed/);
            writeFileSync(nested, nestedBytes);
          } finally { vi.unstubAllEnvs(); }
        }
        write(dest, 'node_modules/.cache/probe', 'disposable cache');
        chmodSync(join(dest, dependency), 0o644);
        write(dest, dependency, 'verifier mutation');
        expect(readFileSync(join(generationPath, 'tree', dependency), 'utf8')).toBe('published dependency');
      } finally {
        spawnSync('chmod', ['-R', 'u+rwX', root]);
        rmSync(root, { recursive: true, force: true });
      }
    }, 120_000,
  );
});

describe('verifier command disclosure admission', () => {
  const marker = 'PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT';

  it('admits in the caller checkout and transports the actual verdict without changing the caller environment', () => {
    const env = { PATH: '/fixture/bin', DATABASE_URL: 'postgresql://fixture.invalid/application' };
    const preflight = vi.fn(() => ({ verdict: 'admit' as const }));
    const child = verifierCommandAdmissionEnv({ repo: '/caller/checkout', env, preflight });
    expect(preflight).toHaveBeenCalledExactlyOnceWith({ roots: ['/caller/checkout'], env });
    expect(child).toEqual({ ...env, [marker]: 'admitted-by-test-router' });
    expect(env).not.toHaveProperty(marker);
    expect(child).not.toHaveProperty('HARNESS_ADMIN_DATABASE_URL');
  });

  it.each(['restricted_write_held', 'restricted_hold_state_unknown'])(
    'refuses %s before source preparation and never creates an admission marker', (error) => {
      const env = { PATH: '/fixture/bin' };
      const preflight = vi.fn(() => ({ verdict: 'refuse' as const, error, hint: 'nothing may start' }));
      expect(() => verifierCommandAdmissionEnv({ repo: '/caller/checkout', env, preflight }))
        .toThrow(expect.objectContaining({ exitCode: 3, message: expect.stringContaining(error) }));
      expect(env).not.toHaveProperty(marker);
    },
  );

  it('preserves upstream admission but does not turn a test-runner skip into a new admission', () => {
    const preflight = vi.fn(() => ({ verdict: 'skipped', reason: 'nested-in-test-runner' } as const));
    expect(verifierCommandAdmissionEnv({ repo: '/caller/checkout', env: { VITEST: '1' }, preflight }))
      .toEqual({ VITEST: '1' });
    const upstream = { [marker]: 'admitted-by-testing-run' };
    expect(verifierCommandAdmissionEnv({ repo: '/caller/checkout', env: upstream,
      preflight: () => ({ verdict: 'skipped', reason: 'testing-run' }) })).toEqual(upstream);
  });

  it('keeps the caller database available after freezing excludes its local config', () => {
    const repo = mkdtempSync(join(tmpdir(), 'verifier-control-plane-'));
    try {
      write(repo, 'apps/operator/.env.local',
        'DATABASE_URL=postgresql://fixture.invalid/caller-control-plane\nUNRELATED_SECRET=must-not-forward\n');
      const env = { PATH: '/fixture/bin' };
      const child = verifierCommandAdmissionEnv({ repo, env, preflight: () => ({ verdict: 'admit' }) });
      rmSync(join(repo, 'apps/operator/.env.local'));
      expect(child.DATABASE_URL).toBe('postgresql://fixture.invalid/caller-control-plane');
      expect(child[marker]).toBe('admitted-by-test-router');
      expect(child).not.toHaveProperty('UNRELATED_SECRET');
      expect(env).toEqual({ PATH: '/fixture/bin' });
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it.each(['HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL', 'PAPERCUSP_PG_URL'])(
    'preserves an explicit %s instead of importing a higher-priority local pin', (key) => {
      const repo = mkdtempSync(join(tmpdir(), 'verifier-control-plane-pin-'));
      try {
        write(repo, 'apps/operator/.env.local', 'HARNESS_ADMIN_DATABASE_URL=postgresql://fixture.invalid/local\n');
        const env = { [key]: 'postgresql://fixture.invalid/explicit' };
        const child = verifierCommandAdmissionEnv({ repo, env,
          preflight: () => ({ verdict: 'skipped', reason: 'nested-in-test-runner' }) });
        expect(child).toEqual(env);
      } finally { rmSync(repo, { recursive: true, force: true }); }
    },
  );

  it.each([{ PAPERCUSP_PG_PORT: '54321' }, { PAPERCUSP_SKIP_PG_DISCOVERY: '1' }])(
    'keeps isolated PG selection %j away from caller database credentials', (env) => {
      const repo = mkdtempSync(join(tmpdir(), 'verifier-control-plane-isolation-'));
      try {
        write(repo, 'apps/operator/.env.local', 'DATABASE_URL=postgresql://fixture.invalid/live\n');
        const child = verifierCommandAdmissionEnv({ repo, env,
          preflight: () => ({ verdict: 'skipped', reason: 'nested-in-test-runner' }) });
        expect(child).toEqual(env);
      } finally { rmSync(repo, { recursive: true, force: true }); }
    },
  );
});
let manifest: Awaited<ReturnType<typeof exportSnapshot>>['manifest'];

const NATIVE_RUNTIME_FILES = [
  'papercusp-desktop/src-tauri/sidecar.lock',
  'papercusp-desktop/src-tauri/gen/schemas/acl-manifests.json',
  'papercusp-desktop/src-tauri/gen/schemas/capabilities.json',
  'papercusp-desktop/src-tauri/gen/schemas/desktop-schema.json',
  'papercusp-desktop/src-tauri/gen/schemas/linux-schema.json',
  'papercusp-desktop/src-tauri/sidecar/PLACEHOLDER-README.txt',
  'papercusp-desktop/src-tauri/sidecar/db-sql/PLACEHOLDER-README.txt',
  'papercusp-desktop/src-tauri/sidecar/spa/PLACEHOLDER-README.txt',
  'papercusp-desktop/src-tauri/seed/PLACEHOLDER-README.txt',
  'papercusp-desktop/src-tauri/doc-vector-seed/PLACEHOLDER-README.txt',
];

const VITEST_RESULT_CACHE = 'packages/operator-core/.vitest-tmp/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json';
// Outputs of apps/operator-vite's maintained prebuild, including both ORT roots.
const SPA_RUNTIME_FILES = [
  'apps/operator/public/wake-runtime/ort.bundle.min.mjs',
  'apps/operator/public/vad-runtime/ort-wasm-simd-threaded.wasm',
  'apps/operator/public/vditor/dist/index.js',
  'apps/operator/public/vditor-local/d3.min.js',
  'apps/operator/public/monaco/.version',
  'apps/operator/public/excalidraw/chunk-6U3AYISY.js',
  'apps/operator/public/porcupine/porcupine_params.pv',
  'apps/operator/public/elevenlabs-runtime/rawAudioProcessor.js',
  'apps/operator/public/silero_vad_v5.onnx',
  'apps/operator/public/silero_vad_legacy.onnx',
  'apps/operator/public/vad.worklet.bundle.min.js',
  'apps/operator/public/ort-wasm-simd-threaded.wasm',
  'apps/operator/public/ort-wasm-simd-threaded.jsep.mjs',
];
const DEPENDENCY_POLICY_PATH = 'apps/operator/bin/release/dependency-generation.sh';
const DEPENDENCY_POLICY = readFileSync(new URL('../../../' + DEPENDENCY_POLICY_PATH, import.meta.url), 'utf8');

/** Real private loader closure; no links back to the checkout's dependencies. */
function installVerifierTsx(root: string): void {
  const installed = new Set<string>();
  const copy = (name: string, requireFrom: NodeJS.Require) => {
    if (installed.has(name)) return;
    let manifestPath: string;
    try { manifestPath = requireFrom.resolve(name + '/package.json'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
      let dir = dirname(requireFrom.resolve(name));
      while (!existsSync(join(dir, 'package.json'))) {
        const parent = dirname(dir);
        if (parent === dir) throw new Error('package root missing: ' + name);
        dir = parent;
      }
      manifestPath = join(dir, 'package.json');
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.name).toBe(name);
    installed.add(name);
    cpSync(dirname(manifestPath), join(root, 'node_modules', name), { recursive: true, dereference: true });
    const localRequire = createRequire(manifestPath);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) copy(dependency, localRequire);
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      try { localRequire.resolve(dependency + '/package.json'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') continue;
        throw error;
      }
      copy(dependency, localRequire);
    }
  };
  copy('tsx', createRequire(import.meta.url));
}

function listFiles(dir: string): string[] {
  const acc: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else acc.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return acc.sort();
}

/** What the INSTALLER selection would put in source.tar.zst for the same clean tree. */
function installerListing(mono: string): string[] {
  const r = spawnSync('bash', ['-c', [
    'set -euo pipefail',
    '. "$1"',
    'source_tree_selection "$(dirname "$1")/.." "$2" installer',
    'tar "${SELECTION_EXCLUDES[@]}" -C "$2" -cf - "${SELECTION_INCLUDES[@]}" | tar -tf -',
  ].join('\n'), '_', SELECTION_LIB, mono], { encoding: 'utf8', env: childEnv(), maxBuffer: 64 * 1024 * 1024 });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.split('\n').filter((l) => l && !l.endsWith('/')).map((l) => l.replace(/^\.\//, '')).sort();
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'source-preview-export-test-'));
  fx = makeSuperproject(tmp);
  out = join(tmp, 'export');
  ({ manifest } = await exportSnapshot({ repoRoot: fx.repo, ref: 'main', out, env: childEnv() }));
}, 120_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('source-preview export — R-1 selection parity with the installer cut', () => {
  it('ships every selected tracked file, including the submodule contents', () => {
    const files = listFiles(out);
    for (const p of SHIPPED) expect(files, p).toContain(p);
  });

  it('drops every excluded class, node_modules at any depth, and all git metadata', () => {
    const files = listFiles(out);
    for (const p of DROPPED) expect(files, p).not.toContain(p);
    expect(files.filter((f) => f.split('/').includes('node_modules'))).toEqual([]);
    expect(files.filter((f) => f.split('/').includes('.git'))).toEqual([]);
  });

  it('retains the exact eligible bytes from both internal documentation roots', () => {
    for (const [path, body] of Object.entries(INTERNAL_DOC_CONTENTS)) {
      expect(readFileSync(join(out, path), 'utf8'), path).toBe(body);
    }
  });

  it('equals the installer selection over the same clean commit, minus node_modules', () => {
    const mono = join(tmp, 'parity-mono');
    rmSync(mono, { recursive: true, force: true });
    spawnSync('mkdir', ['-p', mono]);
    materializeCommit({ repo: fx.repo, sha: fx.commit, dest: mono, allow: allowlistTops() });
    const installer = installerListing(mono).filter((f) => !f.split('/').includes('node_modules'));
    const preview = listFiles(out).filter((f) => !ADDED_FILES.includes(f));
    expect(preview).toEqual(installer);
    // The comparison is only meaningful if the installer side really shipped node_modules.
    expect(installerListing(mono)).toContain('node_modules/leftpad/index.js');
    for (const path of Object.keys(INTERNAL_DOC_CONTENTS)) expect(installer, path).toContain(path);
    expect(installer).not.toContain('libs/papercusp/plugins/gitnexus-bridge/index.ts');
    expect(installer).toContain('libs/papercusp/plugins/markdown-preview/papercusp.json');
  });
});

describe('verifier dependency staging preparation boundary', () => {
  function fixture(recordedStaging?: string) {
    const dest = mkdtempSync(join(tmp, 'dependency-staging-'));
    write(dest, 'input.mjs', 'export default 1;\n');
    // The no-op models a completed helper that incorrectly left staging behind.
    write(dest, 'papercusp-desktop/bin/lib/pinned-deps.sh', '#!/bin/bash\nexit 0\n');
    if (recordedStaging) write(dest, recordedStaging + '/source.mjs', 'recorded source');
    const files = verifierSourceFiles(dest);
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'a'.repeat(40), submodules: [],
      testedInputs: [{ path: 'input.mjs', sha256: files.find(file => file.path === 'input.mjs')!.sha256 }], files };
    write(dest, '.verifier-source.json', JSON.stringify(receipt));
    return { dest, receipt };
  }

  it.each(['node_modules.pinned-deps-tmp', 'node_modules.pinned-deps-tmp.12345',
    'apps/operator/node_modules.pinned-deps-tmp.12345'])(
    'retains strict source/runtime verification outside preparation for %s, including empty staging', async staging => {
      const { dest, receipt } = fixture();
      await fsPromises.mkdir(join(dest, staging), { recursive: true });
      for (const options of [{}, { runtimeArtifacts: true }])
        await expect(verifyVerifierSource(dest, receipt, options)).rejects.toThrow('unexpected dependency staging');
      await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true, dependencyStaging: true }))
        .resolves.toEqual(receipt);
      write(dest, staging + '/partial', 'retained bytes');
      await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true }))
        .rejects.toThrow('unexpected dependency staging');
    },
  );

  it.each(['node_modules.pinned-deps-tmp.0', 'node_modules.pinned-deps-tmp.0123',
    'node_modules.pinned-deps-tmp.-1', 'node_modules.pinned-deps-tmp.123.tmp',
    'node_modules.pinned-deps-tmp-other'])(
    'rejects the empty staging lookalike %s before the helper', async staging => {
      const { dest, receipt } = fixture();
      await fsPromises.mkdir(join(dest, staging));
      const phases: string[] = [];
      await expect(prepareVerifierDependencies({ donor: dest, dest, receipt,
        runPhase: async (phase, operation) => { phases.push(phase); return operation(); } }))
        .rejects.toThrow('invalid dependency staging name');
      expect(phases).toEqual(['deps.source.before']);
      expect(existsSync(join(dest, staging))).toBe(true);
    },
  );

  it.each(['symlink', 'dangling-link', 'file', 'ambiguous-pids', 'ambiguous-stable', 'redirected-parent'])(
    'rejects %s before helper execution without removing retained evidence', async defect => {
      const { dest, receipt } = fixture();
      const staging = join(dest, 'node_modules.pinned-deps-tmp.12345');
      if (defect === 'symlink') symlinkSync('.', staging);
      else if (defect === 'dangling-link') symlinkSync('absent', staging);
      else if (defect === 'file') writeFileSync(staging, 'retained bytes');
      else if (defect === 'redirected-parent') {
        const external = mkdtempSync(join(tmp, 'redirected-staging-'));
        write(external, 'node_modules.pinned-deps-tmp/partial', 'external bytes');
        symlinkSync(external, join(dest, 'app'));
      } else {
        await fsPromises.mkdir(staging);
        await fsPromises.mkdir(join(dest, defect === 'ambiguous-pids'
          ? 'node_modules.pinned-deps-tmp.67890' : 'node_modules.pinned-deps-tmp'));
      }
      const before = readdirSync(dest).sort();
      const phases: string[] = [];
      await expect(prepareVerifierDependencies({ donor: dest, dest, receipt,
        runPhase: async (phase, operation) => { phases.push(phase); return operation(); } }))
        .rejects.toThrow(/dependency staging|symlink escapes source root/);
      expect(phases).toEqual(['deps.source.before']);
      expect(readdirSync(dest).sort()).toEqual(before);
    },
  );

  it('resumes completed dependency and workspace-output trees while fencing unfinished staging after the helper', async () => {
    const { dest, receipt } = fixture();
    const retained = ['node_modules/dependency/index.js',
      'apps/operator/node_modules/dependency/index.js', 'packages/omp-plugin/dist/cli.js'];
    for (const path of retained) write(dest, path, 'retained dependency bytes');
    await fsPromises.mkdir(join(dest, 'apps/operator/node_modules.pinned-deps-tmp.12345'));
    const phases: string[] = [];
    await expect(prepareVerifierDependencies({ donor: dest, dest, receipt,
      runPhase: async (phase, operation) => { phases.push(phase); return operation(); } }))
      .rejects.toThrow('unexpected dependency staging');
    expect(phases).toEqual(['deps.source.before', 'deps.source.after-runtime-assets',
      'deps.snapshot', 'deps.source.after-snapshot']);
    for (const path of retained) expect(readFileSync(join(dest, path), 'utf8')).toBe('retained dependency bytes');
  });

  it('refuses unrelated added source before resuming retained dependencies', async () => {
    const { dest, receipt } = fixture();
    write(dest, 'node_modules/dependency/index.js', 'retained dependency bytes');
    write(dest, 'apps/operator/unexpected.mjs', 'unaccepted source');
    const phases: string[] = [];
    await expect(prepareVerifierDependencies({ donor: dest, dest, receipt,
      runPhase: async (phase, operation) => { phases.push(phase); return operation(); } }))
      .rejects.toThrow('added apps/operator/unexpected.mjs');
    expect(phases).toEqual(['deps.source.before']);
  });

  it.each(['input.mjs', 'node_modules/source.mjs', 'apps/operator/node_modules/source.mjs',
    'packages/omp-plugin/dist/source.mjs', 'node_modules.pinned-deps-tmp/source.mjs',
    'node_modules.pinned-deps-tmp.12345/source.mjs', 'apps/operator/node_modules.pinned-deps-tmp/source.mjs'])(
    'never exempts changed recorded source at %s', async input => {
      const { dest, receipt } = fixture(input === 'input.mjs' ? undefined : dirname(input));
      write(dest, input, 'changed recorded source');
      if (input === 'input.mjs') write(dest, 'node_modules.pinned-deps-tmp/partial', 'retained bytes');
      const phases: string[] = [];
      await expect(prepareVerifierDependencies({ donor: dest, dest, receipt,
        runPhase: async (phase, operation) => { phases.push(phase); return operation(); } }))
        .rejects.toThrow('changed ' + input);
      expect(phases).toEqual(['deps.source.before']);
    },
  );

  it('rejects unfinished empty staging after the helper and before any invoked Node command', async () => {
    const { dest, receipt } = fixture();
    await fsPromises.mkdir(join(dest, 'node_modules.pinned-deps-tmp'));
    const phases: string[] = [];
    await expect(prepareVerifierDependencies({ donor: dest, dest, receipt,
      runPhase: async (phase, operation) => { phases.push(phase); return operation(); } }))
      .rejects.toThrow('unexpected dependency staging');
    expect(phases).toEqual(['deps.source.before', 'deps.source.after-runtime-assets',
      'deps.snapshot', 'deps.source.after-snapshot']);
    expect(existsSync(join(dest, 'node_modules.pinned-deps-tmp'))).toBe(true);
  });
});

describe('EI-25303741091409100 — pinned verifier source identity', () => {
  const budgetPhases = { 'source.freeze': 103_607, 'receipt.write': 377,
    'deps.source.before': 11_836, 'deps.snapshot': 140_626, 'deps.source.after-snapshot': 22_222,
    'deps.inputs': 212, 'deps.measure': 3_197, 'deps.source.after-preflight': 9_789,
    'deps.census': 556_985, 'deps.receipt.write': 2_778 };

  it('reserves at least two minutes and exposes the absolute child cutoff even without history', () => {
    expect(() => admitVerifierCommandBudget(null, { nowMs: 1_000,
      env: { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '121000' } })).toThrow('TASK_DEADLINE_REFUSAL');
    expect(admitVerifierCommandBudget(null, { nowMs: 1_000,
      env: { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '121001' } })).toMatchObject({
      cleanupReserveMs: 120_000, childCutoffEpochMs: 1_001,
    });
    expect(admitVerifierCommandBudget(null, { nowMs: 1_000, env: {} }))
      .toMatchObject({ deadlineEpochMs: null, childCutoffEpochMs: null, cleanupReserveMs: 120_000 });
    const small = Object.fromEntries(Object.keys(budgetPhases).map(phase => [phase, 1]));
    expect(estimateVerifierCommandBudget(small).cleanupMs).toBe(120_000);
    expect(estimateVerifierCommandBudget({ ...small, cleanup: 180_000 }).cleanupMs).toBe(180_000);
    expect(estimateVerifierCommandBudget({ ...small, 'source.freeze': 190_000 }).cleanupMs).toBe(190_000);
    expect(estimateVerifierCommandBudget({ ...small, 'deps.snapshot': 200_000 }).cleanupMs).toBe(200_000);
  });

  it('refuses a 900-second envelope from measured phases before preparation and reserves the full final census', () => {
    const estimate = estimateVerifierCommandBudget(budgetPhases, 60_000);
    expect(estimate).toMatchObject({ dependencyCheckMs: 556_985, sourceCheckMs: 22_222,
      cleanupMs: 140_626, childEstimateMs: 60_000, unknownChild: false });
    expect(estimate.totalMs).toBeGreaterThan(900_000);
    expect(() => admitVerifierCommandBudget(estimate, { nowMs: 1_000, preparation: true,
      env: { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '901000' } })).toThrow('TASK_DEADLINE_REFUSAL');
    expect(() => admitVerifierCommandBudget(estimate, { nowMs: 1_000,
      env: { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '49368' } })).toThrow('TASK_DEADLINE_REFUSAL');
    expect(admitVerifierCommandBudget(estimate, { nowMs: 1_000, env: {} }).deadlineEpochMs).toBeNull();
    expect(admitVerifierCommandBudget(estimate, { nowMs: 1_000, preparation: true,
      env: { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(estimate.totalMs + 1_001) } }).knownEstimateMs).toBe(estimate.totalMs);
    expect(estimateVerifierCommandBudget(budgetPhases).unknownChild).toBe(true);
  });

  it('reserves preparation growth together with the child reforecast margin before launching', () => {
    const launch = estimateVerifierCommandBudget(budgetPhases, 600_000);
    const slowerPhases = Object.fromEntries(Object.entries(budgetPhases)
      .map(([phase, duration]) => [phase, Math.ceil(duration * 1.25)]));
    const child = estimateVerifierCommandBudget(slowerPhases, 600_000);
    const nowMs = child.preparationMs + launch.launchReserveMs;

    // A slower snapshot consumes the preparation clock AND raises the cleanup
    // reserve at child admission. The launch must cover both without lowering
    // the child, census, cleanup or absolute-deadline guards.
    expect(() => admitVerifierCommandBudget(child, { nowMs,
      env: { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(launch.requiredTimeoutMs) } }))
      .not.toThrow();
    expect(() => admitVerifierCommandBudget(child, { nowMs,
      env: { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(nowMs + child.remainingMs) } }))
      .toThrow('TASK_DEADLINE_REFUSAL');
    expect(child.cleanupMs).toBe(slowerPhases['deps.snapshot']);
  });

  it('does not count failed or unfinished phase records as completed budget observations', () => {
    const path = join(tmp, 'verifier-budget-history.jsonl');
    const rows = [
      { phase: 'deps.census', event: 'started', elapsedMs: 0 },
      { phase: 'deps.census', event: 'failed', elapsedMs: 15, durationMs: 15 },
      { phase: 'child.preflight', event: 'started', elapsedMs: 16 },
    ].map((row, index) => ({ schemaVersion: 'verifier-phase-v1', sequence: index + 1, ...row }));
    writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n'));
    expect(readVerifierPhaseMeasurements(path)).toEqual({});
    expect(() => estimateVerifierCommandBudget(readVerifierPhaseMeasurements(path)))
      .toThrow('requires completed phase');
    writeFileSync(path, JSON.stringify({ ...rows[0], sequence: 9 }));
    expect(() => readVerifierPhaseMeasurements(path)).toThrow('Invalid verifier phase budget receipt');
  });

  it('reserves measured launch time before selecting a caller deadline and refuses an insufficient ceiling', () => {
    // Retained P-012 task 0mvd8yidvzw8rq9kc4z: the old 7,200,000ms
    // envelope lost 6,802ms before admission, exceeding its 4,415ms headroom.
    const measured = { 'source.freeze': 24_263, 'receipt.write': 553,
      'deps.source.before': 5_885, 'deps.snapshot': 817_932,
      'deps.source.after-snapshot': 20_713, 'deps.inputs': 3_206,
      'deps.measure': 10_546, 'deps.source.after-preflight': 20_214,
      'deps.census': 189_372, 'deps.receipt.write': 888,
      'child.preflight': 26_663, 'deps.postverify': 191_638,
      'source.postverify': 23_454, cleanup: 97_791 };
    const options = { observedLaunchMs: 6_802 };
    const estimate = estimateVerifierCommandBudget(measured, 3_600_000, options);
    expect(estimate).toMatchObject({ totalMs: 8_652_740,
      observedLaunchMs: 6_802, launchReserveMs: 30_000, requiredTimeoutMs: 8_683_000 });
    expect(() => admitVerifierCommandBudget(estimate, { nowMs: 6_802, preparation: true,
      env: { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '7200000' } })).toThrow('TASK_DEADLINE_REFUSAL');
    expect(() => estimateVerifierCommandBudget(measured, 3_600_000,
      { ...options, maxTimeoutMs: 7_200_000 })).toThrow('VERIFIER_LAUNCH_BUDGET_REFUSAL');
    expect(admitVerifierCommandBudget(estimate, { nowMs: 6_802, preparation: true,
      env: { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(estimate.requiredTimeoutMs) } }))
      .toMatchObject({ knownEstimateMs: 8_652_740, cleanupReserveMs: 817_932 });
    expect(estimateVerifierCommandBudget(measured, 3_600_000,
      { ...options, maxTimeoutMs: estimate.requiredTimeoutMs })).toEqual(estimate);
    const slowerLaunch = estimateVerifierCommandBudget(measured, 3_600_000,
      { observedLaunchMs: 40_000 });
    expect(slowerLaunch).toMatchObject({ totalMs: estimate.totalMs,
      launchReserveMs: 50_000, requiredTimeoutMs: 8_703_000 });
    expect(estimateVerifierCommandBudget(measured).observedLaunchMs).toBeNull();
  });

  it.each([-1, NaN, Infinity, 1.5])('rejects invalid measured launch time (%s)', observedLaunchMs => {
    expect(() => estimateVerifierCommandBudget(budgetPhases, 60_000, { observedLaunchMs }))
      .toThrow('Invalid verifier launch observation');
  });

  it('transports a complete list beyond the argv/env limit through file and piped stdout receipts', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-large-list-fixture'));
    const paths = Array.from({ length: 2000 }, (_, i) =>
      `apps/operator/acceptance/${String(i).padStart(4, '0')}-${'x'.repeat(70)}.ts`);
    paths.push('apps/operator/acceptance/space and,comma.ts');
    for (const path of paths) write(fixture.repo, path, `// ${path}\n`);
    git(fixture.repo, ['add', 'apps/operator/acceptance']);
    git(fixture.repo, ['commit', '-qm', 'large complete verifier list']);
    const sha = git(fixture.repo, ['rev-parse', 'HEAD']).trim();
    const inputsFile = join(tmp, 'verifier-large-inputs.json');
    const serialized = JSON.stringify(paths);
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(128 * 1024);
    writeFileSync(inputsFile, serialized);
    const dest = join(tmp, 'verifier-large-export');
    const receiptFile = join(tmp, 'verifier-large-receipt.json');
    const tooling = SHIPPED.find((p) => p.startsWith('apps/'))!;
    const result = spawnSync(process.execPath, [join(__dirname, '../../../scripts/source-preview.mjs'),
      'verifier-prepare', '--repo', fixture.repo, '--ref', sha, '--out', dest,
      '--inputs', tooling, '--inputs-file', inputsFile, '--receipt', receiptFile],
    { encoding: 'utf8', env: childEnv(), timeout: 60_000 });
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    expect(receipt.sourceCommit).toBe(sha);
    expect(receipt.submodules.length).toBeGreaterThan(0);
    expect(receipt.testedInputs).toEqual([...paths, tooling].sort().map((path) => ({ path,
      sha256: createHash('sha256').update(readFileSync(join(fixture.repo, path))).digest('hex') })));
    expect(statSync(receiptFile).mode & 0o777).toBe(0o600);
    const expected = await validateVerifierInputs({ repo: fixture.repo, ref: sha,
      inputs: [tooling], inputsFile });
    const checked = spawnSync(process.execPath, [join(__dirname, '../../../scripts/source-preview.mjs'),
      'verifier-inputs-check', '--repo', fixture.repo, '--ref', sha,
      '--inputs', tooling, '--inputs-file', inputsFile],
    { encoding: 'utf8', env: childEnv(), timeout: 60_000, maxBuffer: 1024 * 1024 });
    expect(checked.status, checked.stderr).toBe(0);
    const expectedText = `${JSON.stringify(expected)}\n`;
    expect(Buffer.byteLength(checked.stdout)).toBe(Buffer.byteLength(expectedText));
    expect(JSON.parse(checked.stdout)).toEqual(expected);
  }, 120_000);

  it('flushes a large CLI rejection to piped stderr before preserving exit code 2', () => {
    const inputsFile = join(tmp, 'verifier-large-invalid-inputs.json');
    const invalid = `../${'x'.repeat(200_000)}`;
    writeFileSync(inputsFile, JSON.stringify([invalid]));
    const priorOptions = process.env.NODE_OPTIONS, priorPath = process.env.NODE_PATH;
    let env: NodeJS.ProcessEnv;
    try {
      // A runner's inherited loader must neither add stderr nor substitute the
      // CLI being tested. A missing loader makes contamination fail decisively.
      process.env.NODE_OPTIONS = '--import=/nonexistent/source-preview-test-loader.mjs';
      process.env.NODE_PATH = '/nonexistent/source-preview-test-dependencies';
      env = childEnv();
    } finally {
      if (priorOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = priorOptions;
      if (priorPath === undefined) delete process.env.NODE_PATH;
      else process.env.NODE_PATH = priorPath;
    }
    const result = spawnSync(process.execPath, [join(__dirname, '../../../scripts/source-preview.mjs'),
      'verifier-inputs-check', '--repo', fx.repo, '--ref', fx.commit, '--inputs-file', inputsFile],
    { encoding: 'utf8', env, timeout: 60_000, maxBuffer: 1024 * 1024 });
    expect(result.status).toBe(2);
    const expected = `ERROR: invalid tested input: ${invalid}\n`;
    expect(Buffer.byteLength(result.stderr)).toBe(Buffer.byteLength(expected));
    expect(createHash('sha256').update(result.stderr).digest('hex'))
      .toBe(createHash('sha256').update(expected).digest('hex'));
  });

  it.each(['', '{bad', '{}', '[]', '[null]', '["../outside"]', '[""]'])
    ('refuses malformed or empty input files before exporting (%s)', async (body) => {
      const inputsFile = join(tmp, 'verifier-invalid-inputs.json');
      const dest = join(tmp, 'verifier-invalid-export');
      writeFileSync(inputsFile, body);
      await expect(prepareVerifierSource({ repo: fx.repo, ref: fx.commit, dest,
        inputs: [SHIPPED[0]], inputsFile })).rejects.toThrow();
      expect(existsSync(dest)).toBe(false);
    });

  it('refuses an absent input file rather than using only the mandatory inputs', async () => {
    const dest = join(tmp, 'verifier-absent-input-file-export');
    await expect(prepareVerifierSource({ repo: fx.repo, ref: fx.commit, dest,
      inputs: [SHIPPED[0]], inputsFile: join(tmp, 'does-not-exist.json') })).rejects.toThrow(/ENOENT/);
    expect(existsSync(dest)).toBe(false);
  });

  it.each([{ tail: [] }, { tail: ['--receipt', 'receipt.json'] }])
    ('refuses a missing --inputs-file value despite valid CSV inputs ($tail)', async ({ tail }) => {
    const dest = join(tmp, 'verifier-missing-input-argument-export');
    await expect(runCli(['verifier-prepare', '--repo', fx.repo, '--ref', fx.commit,
      '--out', dest, '--inputs', SHIPPED[0], '--inputs-file', ...tail]))
      .rejects.toThrow('missing value for --inputs-file');
    expect(existsSync(dest)).toBe(false);
  });

  it.each(['dirty', 'missing'])('refuses a %s file-listed input and removes the incomplete export', async (kind) => {
    const fixture = makeSuperproject(join(tmp, `verifier-file-${kind}-fixture`));
    const dest = join(tmp, `verifier-file-${kind}-export`);
    const inputsFile = join(tmp, `verifier-file-${kind}-inputs.json`);
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    if (kind === 'dirty') writeFileSync(join(fixture.repo, input), 'uncommitted acceptance change');
    writeFileSync(inputsFile, JSON.stringify([kind === 'dirty' ? input : 'apps/operator/missing.ts']));
    await expect(prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest,
      inputs: [SHIPPED.find((p) => p !== input)!], inputsFile }))
      .rejects.toThrow(kind === 'dirty' ? /dirty tested-input mismatch/ : /ENOENT/);
    expect(existsSync(dest)).toBe(false);
  });

  it('transports independent verifier provenance to a child and refuses stale or internal receipts', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-child-env-fixture'));
    const dest = join(tmp, 'verifier-child-env-export');
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    const receiptPath = join(tmp, 'verifier-child-env.receipt.json');
    writeFileSync(receiptPath, JSON.stringify(receipt));
    const env = verifierSourceChildEnv({ root: dest, receiptPath, env: {
      PATH: process.env.PATH, VERIFY_TAURI_SOURCE_RECEIPT: '/stale/receipt', VERIFY_TAURI_SOURCE_REF: 'stale',
    } });
    expect(env.VERIFY_TAURI_SOURCE_RECEIPT).toBe(receiptPath);
    expect(env.VERIFY_TAURI_SOURCE_REF).toBe(receipt.sourceCommit);
    vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', env.VERIFY_TAURI_SOURCE_RECEIPT!);
    vi.stubEnv('VERIFY_TAURI_SOURCE_REF', env.VERIFY_TAURI_SOURCE_REF!);
    try {
      expect(captureTestSourceSnapshot(dest)).toEqual({ commit: receipt.sourceCommit, porcelain: '' });
    } finally { vi.unstubAllEnvs(); }
    expect(() => verifierSourceChildEnv({ root: dest, receiptPath: join(dest, '.verifier-source.json') }))
      .toThrow('receipt must be outside the archive');
    writeFileSync(join(dest, input), 'changed after preflight');
    expect(() => verifierSourceChildEnv({ root: dest, receiptPath })).toThrow(`changed ${input}`);
  });

  it('measures pinned source and gitlinks before export, ignoring dirty and untracked bytes', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-size-fixture'));
    const before = measureVerifierSourceBytes({ repo: fixture.repo, ref: fixture.commit });
    const dest = join(tmp, 'verifier-size-export');
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    const exported = listFiles(dest).filter(p => p !== '.verifier-source.json')
      .reduce((bytes, p) => bytes + Math.ceil(statSync(join(dest, p)).size / 4096) * 4096, 0);
    expect(before).toBe(exported);
    expect(receipt.submodules).toHaveLength(1);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runCli(['verifier-measure', '--repo', fixture.repo, '--ref', fixture.commit])).toBe(0);
      expect(output).toHaveBeenCalledWith(before);
    } finally { output.mockRestore(); }
    write(fixture.repo, 'dirty-untracked.bin', 'x'.repeat(100_000));
    write(fixture.repo, input, 'dirty'.repeat(10_000));
    expect(measureVerifierSourceBytes({ repo: fixture.repo, ref: fixture.commit })).toBe(before);
    git(fixture.repo, ['update-index', '--cacheinfo', `160000,${'1'.repeat(40)},libs/papercusp`]);
    git(fixture.repo, ['commit', '-qm', 'unresolvable size fixture']);
    expect(() => measureVerifierSourceBytes({ repo: fixture.repo, ref: 'HEAD' })).toThrow(/unresolvable gitlink/);
  });

  it('round-trips the verifier CLI with an external caller receipt and refuses tampering', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-cli-fixture'));
    const dest = join(tmp, 'verifier-cli-export');
    const receipt = join(tmp, 'verifier-cli-receipt.json');
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    expect(await runCli(['verifier-prepare', '--repo', fixture.repo, '--ref', fixture.commit,
      '--out', dest, '--inputs', input, '--receipt', receipt])).toBe(0);
    expect(statSync(receipt).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(receipt, 'utf8')).sourceCommit).toBe(fixture.commit);
    expect(await runCli(['verifier-verify', '--out', dest, '--receipt', receipt])).toBe(0);
    for (const artifact of NATIVE_RUNTIME_FILES) write(dest, artifact, 'native runtime output');
    await expect(runCli(['verifier-verify', '--out', dest, '--receipt', receipt]))
      .rejects.toThrow('tampered verification source archive');
    expect(await runCli(['verifier-verify', '--out', dest, '--receipt', receipt,
      '--runtime-artifacts'])).toBe(0);
    writeFileSync(join(dest, input), 'changed after preparation');
    await expect(runCli(['verifier-verify', '--out', dest, '--receipt', receipt, '--runtime-artifacts']))
      .rejects.toThrow('tampered verification source archive');
  });

  it('exports exact gitlinks despite unrelated dirty donor bytes and detects archive tampering', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-fixture'));
    const dest = join(tmp, 'verifier-export');
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    write(fixture.repo, 'unrelated-untracked.ts', 'peer edit');
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    expect(receipt.sourceCommit).toBe(fixture.commit);
    expect(receipt.submodules.length).toBeGreaterThan(0);
    expect(existsSync(join(dest, 'unrelated-untracked.ts'))).toBe(false);
    await expect(verifyVerifierSource(dest, receipt)).resolves.toEqual(receipt);
    writeFileSync(join(dest, input), 'tampered');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow(`tampered verification source archive: changed ${input}`);
  });

  it('prepares real Git parent and recursive index semantics without changing the exported source population', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-checkout-fixture'));
    git(fixture.repo, ['commit', '--allow-empty', '-m', 'second verifier revision']);
    const head = git(fixture.repo, ['rev-parse', 'HEAD']);
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const dest = join(tmp, 'verifier-checkout');
    const archive = await prepareVerifierSource({ repo: fixture.repo, ref: head,
      dest: join(tmp, 'verifier-checkout-archive'), inputs: [input] });
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: head, dest, inputs: [input], gitCheckout: true });
    expect(receipt.files).toEqual(archive.files);
    expect(receipt.testedInputs).toEqual(archive.testedInputs);
    expect(receipt.gitCheckout?.parentCommit).toBe(fixture.commit);
    expect(git(dest, ['rev-parse', 'HEAD^'])).toBe(fixture.commit);
    expect(git(dest, ['ls-files', '--recurse-submodules'])).toContain('libs/papercusp/package.json');
    expect(git(dest, ['remote'])).toBe('');
    await expect(verifyVerifierSource(dest, receipt)).resolves.toEqual(receipt);
    expect(git(dest, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    writeFileSync(join(dest, 'unexpected-source.ts'), 'export const unexpected = true;\n');
    expect(git(dest, ['status', '--porcelain', '--untracked-files=all'])).toContain('?? unexpected-source.ts');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('added unexpected-source.ts');
    rmSync(join(dest, 'unexpected-source.ts'));
    writeFileSync(join(dest, '.verifier-source.json'), '{}');
    expect(git(dest, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('tampered verification source provenance');
    writeFileSync(join(dest, '.verifier-source.json'), JSON.stringify(receipt));
    await expect(verifyVerifierSource(dest, receipt)).resolves.toEqual(receipt);

    // Source-byte identity alone cannot detect a changed index.
    git(dest, ['rm', '--cached', '--', input]);
    expect(readFileSync(join(dest, input))).toEqual(readFileSync(join(fixture.repo, input)));
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('tampered verification Git checkout');
  });

  it('keeps native preparation pinned when the canonical donor changes after admission, and refuses fixed-source drift', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-native-race-fixture'));
    for (const path of TAURI_VERIFIER_INPUTS) write(fixture.repo, path, `// ${path}\n`);
    git(fixture.repo, ['add', ...TAURI_VERIFIER_INPUTS]);
    git(fixture.repo, ['commit', '-qm', 'native invocation source']);
    const ref = git(fixture.repo, ['rev-parse', 'HEAD']);
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const sourceRoot = join(tmp, 'verifier-native-race-invocation');
    const options = { ref, inputs: [input], tauriInputs: true };
    const receipt = await prepareVerifierSource({ ...options, repo: fixture.repo,
      dest: sourceRoot, gitCheckout: true });
    const externalReceipt = join(tmp, 'verifier-native-race-receipt.json');
    writeFileSync(externalReceipt, JSON.stringify(receipt));

    // This is the v4 ordering: admission succeeds, then a peer saves the wrapper
    // while external fixtures are being allocated, before native preparation.
    const wrapper = 'scripts/verify-tauri-headless.sh';
    writeFileSync(join(fixture.repo, wrapper), 'peer edit after admission');
    await expect(validateVerifierInputs({ ...options, repo: fixture.repo }))
      .rejects.toThrow(`dirty tested-input mismatch: ${wrapper}`);
    expect(await runCli(['verifier-verify', '--out', sourceRoot, '--receipt', externalReceipt])).toBe(0);
    const nativeReceipt = await prepareVerifierSource({ ...options, repo: sourceRoot,
      dest: join(tmp, 'verifier-native-race-runtime') });
    expect(nativeReceipt.sourceCommit).toBe(ref);
    expect(nativeReceipt.files).toEqual(receipt.files);
    expect(nativeReceipt.testedInputs).toEqual(receipt.testedInputs);
    expect(readFileSync(join(fixture.repo, wrapper), 'utf8')).toBe('peer edit after admission');

    // Independence is not permission to weaken the input fence.
    writeFileSync(join(sourceRoot, wrapper), 'tampered fixed invocation');
    await expect(runCli(['verifier-verify', '--out', sourceRoot, '--receipt', externalReceipt]))
      .rejects.toThrow(`tampered verification source archive: changed ${wrapper}`);
    const refused = join(tmp, 'verifier-native-race-refused');
    await expect(prepareVerifierSource({ ...options, repo: sourceRoot, dest: refused }))
      .rejects.toThrow(`dirty tested-input mismatch: ${wrapper}`);
    expect(existsSync(refused)).toBe(false);
  });

  it.each(['unchanged', 'content', 'added', 'removed', 'mode', 'new-tree', 'workspace-link', 'ephemeral',
    'absolute-link', 'escaping-link', 'indirect-escape', 'dangling-link', 'redirected-tree',
    'duplicate-tree', 'missing-population', 'invalid-path', 'nested-tree'] as const)
  ('measures materialized dependency bytes with the existing census (%s)', async defect => {
    const root = join(tmp, 'dependency-census-' + defect);
    const helper = 'papercusp-desktop/bin/lib/pinned-deps.sh';
    write(root, helper, '#!/bin/bash\nset -eu\ntest "$1" = trees\necho node_modules\nif [ -d "$2/app/node_modules" ]; then echo app/node_modules; fi\n');
    write(root, DEPENDENCY_POLICY_PATH, DEPENDENCY_POLICY);
    write(root, 'node_modules/example/index.mjs', 'export default 1;\n');
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'a'.repeat(40),
      testedInputs: [{ path: 'input.mjs', sha256: 'b'.repeat(64) }], files: [], submodules: [] };
    const before = captureVerifierDependencies({ dest: root, receipt });
    expect(before.trees.map(tree => tree.path)).toEqual(['node_modules']);
    const dependency = join(root, 'node_modules/example/index.mjs');
    if (defect === 'content') writeFileSync(dependency, 'export default 2;\n');
    if (defect === 'added') write(root, 'node_modules/example/extra.mjs', 'added');
    if (defect === 'removed') rmSync(dependency);
    if (defect === 'mode') await fsPromises.chmod(dependency, 0o755);
    if (defect === 'new-tree') write(root, 'app/node_modules/second/index.mjs', 'second');
    if (defect === 'ephemeral') for (const path of ['.cache/out', '.package-lock.json',
      '.papercusp-isolated-snapshot', 'example/.astro/out', 'example/.vite/out',
      'example/.vite-temp/out', 'example/.verdict-data/out']) write(root, 'node_modules/' + path, 'runtime output');
    if (defect === 'workspace-link') {
      write(root, 'app/index.mjs', 'workspace source');
      symlinkSync('../app', join(root, 'node_modules/workspace'));
    }
    if (defect === 'absolute-link') symlinkSync(join(root, 'app'), join(root, 'node_modules/redirect'));
    if (defect === 'escaping-link') symlinkSync('../../', join(root, 'node_modules/redirect'));
    if (defect === 'indirect-escape') {
      symlinkSync(tmp, join(root, 'app'));
      symlinkSync('../app', join(root, 'node_modules/redirect'));
    }
    if (defect === 'dangling-link') symlinkSync('../absent', join(root, 'node_modules/redirect'));
    if (defect === 'redirected-tree') {
      await fsPromises.rename(join(root, 'node_modules'), join(root, 'donor'));
      symlinkSync('donor', join(root, 'node_modules'));
    }
    const populations: Partial<Record<typeof defect, string>> = { 'duplicate-tree': 'node_modules\\nnode_modules',
      'missing-population': '', 'invalid-path': '../node_modules',
      'nested-tree': 'node_modules\\nnode_modules/example/node_modules' };
    const population = populations[defect];
    if (population !== undefined) write(root, helper,
      '#!/bin/bash\nprintf "' + population + '\\n"\n');
    if (['absolute-link', 'escaping-link', 'indirect-escape', 'dangling-link',
      'redirected-tree', 'duplicate-tree', 'missing-population', 'invalid-path', 'nested-tree'].includes(defect)) {
      expect(() => captureVerifierDependencies({ dest: root, receipt })).toThrow();
    } else {
      const after = captureVerifierDependencies({ dest: root, receipt });
      if (defect === 'unchanged' || defect === 'ephemeral') expect(after).toEqual(before);
      else expect(after).not.toEqual(before);
      if (defect === 'workspace-link') expect(after.trees[0]!.files).toContainEqual(expect.objectContaining({
        path: 'workspace', kind: 'symlink', sha256: createHash('sha256').update('../app').digest('hex'),
      }));
    }
  });

  it('reuses dependency hashes only while full source records and manifests remain unchanged', async () => {
    const root = join(tmp, 'dependency-census-cache-fingerprint');
    const helper = 'papercusp-desktop/bin/lib/pinned-deps.sh';
    write(root, helper, '#!/bin/bash\nset -eu\ntest "$1" = trees\necho node_modules\n');
    write(root, DEPENDENCY_POLICY_PATH, DEPENDENCY_POLICY);
    write(root, 'node_modules/example/index.mjs', 'export default 1;\n');
    write(root, 'app/index.mjs', 'workspace app');
    write(root, 'lib/index.mjs', 'workspace lib');
    symlinkSync('../app', join(root, 'node_modules/workspace'));
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'a'.repeat(40),
      testedInputs: [{ path: 'input.mjs', sha256: 'b'.repeat(64) }], files: [], submodules: [] };
    const capture = (currentReceipt = receipt) => {
      const progress: Array<{ cacheHit?: boolean }> = [];
      const result = captureVerifierDependencies({ dest: root, receipt: currentReceipt,
        onProgress: event => progress.push(event) });
      return { result, progress: progress[0] };
    };

    const first = capture();
    expect(first.progress).toMatchObject({ cacheHit: false });
    const unchanged = capture();
    expect(unchanged.progress).toMatchObject({ cacheHit: true });
    expect(unchanged.result).toEqual(first.result);

    const dependency = join(root, 'node_modules/example/index.mjs');
    const originalMtime = statSync(dependency).mtime;
    writeFileSync(dependency, 'export default 2;\n');
    await fsPromises.utimes(dependency, originalMtime, originalMtime);
    const sameSizeEdit = capture();
    expect(sameSizeEdit.progress).toMatchObject({ cacheHit: false });
    expect(sameSizeEdit.result.trees[0]!.files.find(file => file.path === 'example/index.mjs')!.sha256)
      .not.toBe(first.result.trees[0]!.files.find(file => file.path === 'example/index.mjs')!.sha256);
    expect(capture().progress).toMatchObject({ cacheHit: true });

    chmodSync(dependency, 0o755);
    const modeEdit = capture();
    expect(modeEdit.progress).toMatchObject({ cacheHit: false });
    expect(modeEdit.result.trees[0]!.files.find(file => file.path === 'example/index.mjs')!.executable).toBe(true);
    expect(capture().progress).toMatchObject({ cacheHit: true });

    const link = join(root, 'node_modules/workspace');
    rmSync(link);
    symlinkSync('../lib', link);
    const targetEdit = capture();
    expect(targetEdit.progress).toMatchObject({ cacheHit: false });
    expect(targetEdit.result.trees[0]!.files.find(file => file.path === 'workspace')!.sha256)
      .not.toBe(modeEdit.result.trees[0]!.files.find(file => file.path === 'workspace')!.sha256);

    const policyPath = join(root, DEPENDENCY_POLICY_PATH);
    writeFileSync(policyPath, DEPENDENCY_POLICY + '\n# census policy revision\n');
    const policyEdit = capture();
    expect(policyEdit.progress).toMatchObject({ cacheHit: false });
    expect(policyEdit.result.policy.sha256).not.toBe(targetEdit.result.policy.sha256);
    const receiptEdit = capture({ ...receipt, sourceCommit: 'c'.repeat(40) });
    expect(receiptEdit.progress).toMatchObject({ cacheHit: false });
    expect(receiptEdit.result.sourceReceiptSha256).not.toBe(policyEdit.result.sourceReceiptSha256);
  });

  it.each(['shadow-path', 'inherited-override'] as const)(
    'pins the dependency census interpreter under %s', mode => {
      const root = join(tmp, 'dependency-census-interpreter-' + mode);
      const shadow = join(root, 'shadow-bin'), marker = join(root, 'shadow-executed');
      write(root, 'shadow-bin/node', '#!/bin/bash\ntouch "$SHADOW_NODE_MARKER"\nexit 39\n');
      chmodSync(join(shadow, 'node'), 0o755);
      write(root, 'papercusp-desktop/bin/lib/pinned-deps.sh', [
        '#!/bin/bash', 'set -eu', 'test "$1" = trees',
        '"${DEPENDENCY_GENERATION_NODE:-node}" -e \'console.log("node_modules")\'',
      ].join('\n'));
      write(root, DEPENDENCY_POLICY_PATH, DEPENDENCY_POLICY);
      write(root, 'node_modules/example/index.mjs', 'export default 1;\n');
      const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'a'.repeat(40),
        testedInputs: [{ path: 'input.mjs', sha256: 'b'.repeat(64) }], files: [], submodules: [] };
      const env = { ...process.env, PATH: `${shadow}:/usr/bin:/bin`, SHADOW_NODE_MARKER: marker,
        NODE_OPTIONS: '--import=/ambient/loader', NODE_PATH: '/ambient/dependencies',
        ...(mode === 'inherited-override' ? { DEPENDENCY_GENERATION_NODE: join(shadow, 'node') } : {}) };
      expect(captureVerifierDependencies({ dest: root, receipt, env }).trees.map(tree => tree.path))
        .toEqual(['node_modules']);
      expect(existsSync(marker)).toBe(false);
      expect(env.NODE_OPTIONS).toBe('--import=/ambient/loader');
    });

  it.each(['fresh', 'node_modules.pinned-deps-tmp', 'node_modules.pinned-deps-tmp.12345'])(
    'loads TypeScript directory imports with the invoked tree loader before native allocation and survives donor dependency removal (%s)', async staging => {
    const fixture = makeSuperproject(join(tmp, 'verifier-native-dependencies-' + staging));
    git(fixture.repo, ['rm', '-r', '--', 'node_modules', 'apps/operator/node_modules']);
    const script = 'scripts/source-preview.mjs';
    const helper = 'papercusp-desktop/bin/lib/pinned-deps.sh';
    write(fixture.repo, script, "import value from '@native-proof/runtime';\nimport { typed } from './schema';\nif (value !== typed) throw Error('wrong dependency');\nconsole.log(process.argv.includes('verifier-measure') ? '4096' : 'inputs-ok');\n");
    write(fixture.repo, 'scripts/schema/index.ts', "export const typed: string = 'private-snapshot';\n");
    write(fixture.repo, 'scripts/schema/package.json', '{"type":"module"}\n');
    write(fixture.repo, DEPENDENCY_POLICY_PATH, DEPENDENCY_POLICY);
    // Substitute the expensive copy only; execute real Node resolution from the
    // independent source tree, with ambient loaders and NODE_PATH excluded.
    write(fixture.repo, helper, '#!/bin/bash\nset -eu\nif [ "$1" = trees ]; then echo node_modules; exit; fi\ntest "$1" = snapshot-locked\ntest "$4" = hardlink\nshopt -s nullglob\nstaging=("$3"/node_modules.pinned-deps-tmp*)\nif [ "${#staging[@]}" = 1 ]; then mv -- "${staging[0]}" "$3/node_modules"; else mkdir "$3/node_modules"; fi\ncp -al -- "$2/node_modules/." "$3/node_modules/"\n');
    write(fixture.repo, '.gitignore', readFileSync(join(fixture.repo, '.gitignore'), 'utf8') + '\n/.papercusp/scratch/\n');
    git(fixture.repo, ['add', script, 'scripts/schema', helper, '.gitignore', DEPENDENCY_POLICY_PATH]);
    git(fixture.repo, ['commit', '-qm', 'native dependency preflight fixture']);
    const scratch = join(fixture.repo, '.papercusp', 'scratch');
    await fsPromises.mkdir(scratch, { recursive: true });
    const dest = join(scratch, 'invoked');
    const otherTemp = join(tmp, 'verifier-native-dependencies-other-temp-' + staging);
    await fsPromises.mkdir(otherTemp);
    vi.stubEnv('TMPDIR', otherTemp);
    let receipt: Awaited<ReturnType<typeof prepareVerifierSource>>;
    try {
      receipt = await prepareVerifierSource({ repo: fixture.repo, ref: 'HEAD',
        dest, inputs: [script], gitCheckout: true });
    } finally { vi.unstubAllEnvs(); }
    const probe = (loader = false) => spawnSync(process.execPath, [...(loader ? ['--import', 'tsx'] : []), join(dest, script), 'verifier-measure'],
      { cwd: dest, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
    expect(probe().stderr).toContain('ERR_MODULE_NOT_FOUND');
    write(fixture.repo, 'node_modules/@native-proof/runtime/package.json', JSON.stringify({
      name: '@native-proof/runtime', type: 'module', exports: './index.mjs' }));
    write(fixture.repo, 'node_modules/@native-proof/runtime/index.mjs', "export default 'private-snapshot';\n");
    installVerifierTsx(fixture.repo);
    if (staging !== 'fresh') write(dest, staging + '/retained-proof', 'retained private fixture bytes');
    const dependencies = await prepareVerifierDependencies({ donor: fixture.repo, dest, receipt });
    if (staging !== 'fresh') {
      expect(existsSync(join(dest, staging))).toBe(false);
      expect(readFileSync(join(dest, 'node_modules/retained-proof'), 'utf8')).toBe('retained private fixture bytes');
    }
    expect(dependencies.trees[0]!.files.map(file => file.path)).toEqual(expect.arrayContaining([
      '@native-proof/runtime/index.mjs', '@native-proof/runtime/package.json', 'tsx/package.json',
    ]));
    expect(statSync(join(dest, 'node_modules/@native-proof/runtime/index.mjs')).ino)
      .toBe(statSync(join(fixture.repo, 'node_modules/@native-proof/runtime/index.mjs')).ino);
    expect(probe().stderr).toContain('ERR_UNSUPPORTED_DIR_IMPORT');
    rmSync(join(fixture.repo, 'node_modules'), { recursive: true });
    expect(probe(true).status).toBe(0);
    expect(probe(true).stdout.trim()).toBe('4096');
    expect(captureVerifierDependencies({ dest, receipt })).toEqual(dependencies);
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
    rmSync(join(dest, 'node_modules/tsx'), { recursive: true });
    const missingLoader = probe(true);
    expect(missingLoader.status).not.toBe(0);
    expect(missingLoader.stderr).toContain('ERR_MODULE_NOT_FOUND');
  });

  it.each(['explicit-cap', 'cleanup-cutoff', 'explicit-pass', 'default', 'command-cap', 'command-pass', 'census-cap', 'census-cancel'] as const)(
    'bounds dependency preparation and preserves the caller environment (%s)', async mode => {
    const fixture = makeSuperproject(join(tmp, 'verifier-preparation-budget-' + mode));
    git(fixture.repo, ['rm', '-r', '--', 'node_modules', 'apps/operator/node_modules']);
    const helper = 'papercusp-desktop/bin/lib/pinned-deps.sh';
    const script = 'scripts/source-preview.mjs';
    const writer = 'scripts/dependency-progress.cjs';
    const pidPath = join(tmp, mode + '-preparation.pid');
    write(fixture.repo, DEPENDENCY_POLICY_PATH, DEPENDENCY_POLICY);
    const assertEnv = "if (process.env.VERIFIER_PREP_SENTINEL !== 'caller-only' || process.env.NODE_OPTIONS !== '' || process.env.NODE_PATH !== '') throw Error('caller environment lost');\n";
    write(fixture.repo, script, assertEnv + "console.log(process.argv.includes('verifier-measure') ? '4096' : 'inputs-ok');\n");
    write(fixture.repo, writer, assertEnv + [
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.VERIFIER_PREP_PID, String(process.pid));",
      "let completed = 0; const timer = setInterval(() => console.log('snapshot progress: completed=' + (++completed)), 100);",
      "setTimeout(() => { clearInterval(timer); console.log('copy-complete'); }, process.env.VERIFIER_SLOW_CENSUS ? 10000 : 1800);",
    ].join('\n'));
    write(fixture.repo, helper, [
      '#!/bin/bash', 'set -eu',
      'test "$VERIFIER_PREP_SENTINEL" = caller-only',
      'test -z "$NODE_OPTIONS"', 'test -z "$NODE_PATH"',
      'if [ "$1" = trees ]; then if [ -n "${VERIFIER_SLOW_CENSUS:-}" ]; then "$VERIFIER_PREP_NODE" "$2/scripts/dependency-progress.cjs" >&2; fi; echo node_modules; exit; fi',
      'if [ -z "${VERIFIER_SLOW_CENSUS:-}" ]; then "$VERIFIER_PREP_NODE" "$3/scripts/dependency-progress.cjs"; fi',
      'if [ "$4" = copy ]; then cp -a -- "$2/node_modules" "$3/node_modules"; else cp -al -- "$2/node_modules" "$3/node_modules"; fi',
    ].join('\n'));
    write(fixture.repo, '.gitignore', readFileSync(join(fixture.repo, '.gitignore'), 'utf8') + '\n/.papercusp/scratch/\n');
    git(fixture.repo, ['add', helper, script, writer, DEPENDENCY_POLICY_PATH, '.gitignore']);
    git(fixture.repo, ['commit', '-qm', 'bounded dependency preparation fixture']);
    installVerifierTsx(fixture.repo);
    const dest = join(tmp, 'verifier-preparation-dest-' + mode);
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: 'HEAD', dest, inputs: [script], gitCheckout: true });
    const env = childEnv({ VERIFIER_PREP_SENTINEL: 'caller-only', VERIFIER_PREP_PID: pidPath,
      VERIFIER_PREP_NODE: process.execPath, NODE_OPTIONS: '--import=/ambient/loader', NODE_PATH: '/ambient/dependencies',
      ...(['census-cap', 'census-cancel'].includes(mode) ? { VERIFIER_SLOW_CENSUS: '1' } : {}) });
    delete env.PAPERCUSP_TASK_DEADLINE_EPOCH_MS;
    if (mode !== 'default') env.PAPERCUSP_TASK_DEADLINE_EPOCH_MS = String(Date.now() + (mode === 'cleanup-cutoff' ? 121_000 : 300_000));
    const maxMs = mode === 'explicit-cap' || mode === 'command-cap' ? 1000 : mode === 'census-cap' ? 5000 : 15_000;
    const controller = new AbortController(), preparationPhases: string[] = [];
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const receiptPath = join(tmp, mode + '-preparation.json');
    const commandRun = mode === 'command-cap' || mode === 'command-pass';
    const result = commandRun
      ? runVerifierCommand({ repo: fixture.repo, ref: receipt.sourceCommit, inputs: [script], receiptPath,
        command: [process.execPath, '-e', "console.log('provider-ran')"], env, preparationMaxMs: maxMs })
      : prepareVerifierDependencies({ donor: fixture.repo, dest, receipt, env,
        signal: controller.signal,
        runPhase: async (phase, operation) => {
          preparationPhases.push(phase);
          if (mode === 'census-cancel' && phase === 'deps.census')
            cancelTimer = setTimeout(() => controller.abort(), 1000);
          return operation();
        },
        ...(mode === 'default' ? {} : { maxMs }) });
    if (['explicit-cap', 'cleanup-cutoff', 'command-cap', 'census-cap', 'census-cancel'].includes(mode)) {
      await expect(result).rejects.toThrow(mode === 'census-cancel' ? 'canceled' : 'absolute-ceiling');
      if (cancelTimer) clearTimeout(cancelTimer);
      const pid = readFileSync(pidPath, 'utf8');
      if (existsSync(`/proc/${pid}/stat`))
        expect(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]![0]).toMatch(/[ZX]/);
      if (mode === 'census-cap' || mode === 'census-cancel') {
        expect(preparationPhases.at(-1)).toBe('deps.census');
        expect(existsSync(join(dest, 'node_modules'))).toBe(true);
      } else if (!commandRun) expect(existsSync(join(dest, 'node_modules'))).toBe(false);
    } else if (commandRun) {
      await expect(result).resolves.toBe(0);
    } else {
      await expect(result).resolves.toMatchObject({ sourceCommit: receipt.sourceCommit });
    }
    if (commandRun) {
      const task = JSON.parse(readFileSync(receiptPath + '.task.json', 'utf8'));
      expect(task.cleanup).toBe('completed');
      expect(existsSync(task.ownedRoot)).toBe(false);
      if (mode === 'command-cap') expect(existsSync(receiptPath + '.child.json')).toBe(false);
    }
    expect(env.NODE_OPTIONS).toBe('--import=/ambient/loader');
    expect(env.NODE_PATH).toBe('/ambient/dependencies');
  });

  it.each(['missing', 'invalid', 'cleanup-exhausted'] as const)(
    'refuses an explicit preparation grant before touching source or launching a child (%s)', async mode => {
    const env = childEnv();
    delete env.PAPERCUSP_TASK_DEADLINE_EPOCH_MS;
    if (mode === 'invalid') env.PAPERCUSP_TASK_DEADLINE_EPOCH_MS = 'NaN';
    if (mode === 'cleanup-exhausted') env.PAPERCUSP_TASK_DEADLINE_EPOCH_MS = String(Date.now() + 120_000);
    const runPhase = vi.fn();
    await expect(prepareVerifierDependencies({ donor: '/absent/donor', dest: '/absent/dest',
      receipt: {} as Awaited<ReturnType<typeof prepareVerifierSource>>, env, maxMs: 5000, runPhase }))
      .rejects.toThrow(mode === 'cleanup-exhausted' ? 'TASK_DEADLINE_REFUSAL' : 'finite caller task deadline');
    expect(runPhase).not.toHaveBeenCalled();
  });

  it.each(['copy', 'copy-lock'])('lets advancing %s progress cross the initial watchdog deadline', async kind => {
    const progressLine = kind === 'copy'
      ? "'copy progress: fixture written=' + (++written) + 'MiB'"
      : "'copy lock progress: fixture advances=' + (++written)";
    const output = await runVerifierDependencyCommand(process.execPath, ['-e', `
      let written = 0;
      const timer = setInterval(() => console.log(${progressLine}), 100);
      setTimeout(() => { clearInterval(timer); console.log('copy-complete'); }, 1800);
    `], { cwd: tmp, env: childEnv(), timeoutMs: 1000, maxMs: 5000,
      stallWindowMs: 500, extensionMs: 500 });
    expect(output).toContain('copy-complete');
  });

  it('treats completed small-tree snapshots as progress after byte counters go quiet', async () => {
    const output = await runVerifierDependencyCommand(process.execPath, ['-e', `
      let completed = 0;
      const timer = setInterval(() => {
        console.log('snapshot progress: completed=' + (++completed));
        if (completed === 12) {
          clearInterval(timer);
          console.log('copy-complete');
        }
      }, 150);
    `], { cwd: tmp, env: childEnv(), timeoutMs: 1000, maxMs: 5000,
      stallWindowMs: 500, extensionMs: 500 });
    expect(output).toContain('copy-complete');
  });

  it.each([false, true])('distinguishes copy-lock progress across acquisition retries (scoped counter=%s)', async scoped => {
    const run = runVerifierDependencyCommand(process.execPath, ['-e', `
      let tick = 0;
      const timer = setInterval(() => {
        tick++;
        const wait = tick <= 10 ? '100:1' : '100:2';
        const advances = tick <= 10 ? tick : tick - 10;
        console.log('copy lock progress: fixture' + (${scoped} ? ' wait=' + wait : '') + ' advances=' + advances);
        if (tick === 20) { clearInterval(timer); console.log('copy-complete'); }
      }, 100);
    `], { cwd: tmp, env: childEnv(), timeoutMs: 1700, maxMs: 6000,
      stallWindowMs: 500, extensionMs: 500 });
    if (!scoped) {
      await expect(run).rejects.toThrow('progress-stalled');
      return;
    }
    const output = await run;
    expect(output).toContain('wait=100:1 advances=10');
    expect(output).toContain('wait=100:2 advances=1');
    expect(output).toContain('copy-complete');
  });

  it.each(['copy', 'copy-lock', 'snapshot'])('rejects chattering stalled %s and joins a TERM-resistant descendant before cleanup', async kind => {
    const destination = join(tmp, 'dependency-copy-writer');
    const pidPath = join(tmp, 'dependency-copy-writer.pid');
    await fsPromises.mkdir(destination);
    const writer = `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {});
      fs.writeFileSync(process.argv[1], String(process.pid));
      setInterval(() => fs.writeFileSync(process.argv[2] + '/progress', 'writing'), 10);
    `;
    await expect(runVerifierDependencyCommand(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', ${JSON.stringify(writer)}, ${JSON.stringify(pidPath)}, ${JSON.stringify(destination)}],
        { stdio: 'ignore' });
      setInterval(() => console.log(${JSON.stringify(kind === 'copy'
        ? 'copy progress: fixture written=1MiB' : kind === 'copy-lock'
          ? 'copy lock progress: fixture advances=1' : 'snapshot progress: completed=1 tree=fixture')}), 100);
    `], { cwd: tmp, env: childEnv(), timeoutMs: 1500, maxMs: 5000,
      stallWindowMs: 500, extensionMs: 500 })).rejects.toThrow('progress-stalled');
    expect(existsSync(pidPath)).toBe(true);
    // Remove the actual writer's directory only AFTER the awaited exit fence.
    // A surviving descendant would recreate it and invalidate the proof.
    await fsPromises.rm(destination, { recursive: true });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(existsSync(destination)).toBe(false);
    const pid = readFileSync(pidPath, 'utf8');
    if (existsSync(`/proc/${pid}/stat`))
      expect(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]![0]).toMatch(/[ZX]/);
  });

  it.each(['absolute', 'task'])('keeps advancing snapshot progress inside the %s deadline', async boundary => {
    const env = childEnv();
    if (boundary === 'task') env.PAPERCUSP_TASK_DEADLINE_EPOCH_MS = String(Date.now() + 11_000);
    await expect(runVerifierDependencyCommand(process.execPath, ['-e', `
      let completed = 0;
      setInterval(() => console.log('snapshot progress: completed=' + (++completed)), 100);
    `], { cwd: tmp, env, timeoutMs: 500, maxMs: boundary === 'task' ? 5000 : 1000,
      stallWindowMs: 400, extensionMs: 300 })).rejects.toThrow('absolute-ceiling');
  });

  it.for([
    { rootDonor: false, generationHelper: false },
    { rootDonor: true, generationHelper: false },
    { rootDonor: true, generationHelper: true },
  ])('freezes materialized committed source without cloning on root (root donor=$rootDonor, generation helper=$generationHelper)', async ({ rootDonor, generationHelper }, context) => {
    const caseId = `${rootDonor}-${generationHelper}`;
    const startedAt = performance.now();
    const trace = (stage: string) => {
      process.stderr.write('VERIFIER_MATERIALIZED_FIXTURE ' + JSON.stringify({ caseId, stage,
        observedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - startedAt),
        aborted: context.signal.aborted }) + '\n');
      context.signal.throwIfAborted();
    };
    trace('fixture-parent-start');
    const fixtureParent = process.platform === 'linux'
      ? mkdtempSync(rootDonor ? '/var/tmp/source-preview-root-donor-' : '/mnt/data/tmp/source-preview-data-donor-') : tmp;
    try {
    trace('superproject-start');
    const fixture = makeSuperproject(join(fixtureParent, 'verifier-materialized-dependencies-' + caseId));
    trace('superproject-complete');
    const copiesDependencies = process.platform === 'linux' && statSync(fixture.repo).dev === statSync('/').dev;
    git(fixture.repo, ['rm', '-r', '--', 'node_modules', 'apps/operator/node_modules']);
    const script = 'scripts/source-preview.mjs';
    const helper = 'papercusp-desktop/bin/lib/pinned-deps.sh';
    write(fixture.repo, script, "import value from '@native-proof/runtime';\nif (value !== 'private-snapshot') throw Error('wrong dependency');\nconsole.log(process.argv.includes('verifier-measure') ? '4096' : 'inputs-ok');\n");
    write(fixture.repo, DEPENDENCY_POLICY_PATH, DEPENDENCY_POLICY);
    // Keep the physical-donor precondition and real independent Node resolution;
    // substitute only the expensive production dependency census/copy.
    const snapshotVerb = copiesDependencies && generationHelper ? 'snapshot-generation-locked' : 'snapshot-locked';
    write(fixture.repo, helper, [
      '#!/bin/bash', 'set -eu',
      'case "$1" in',
      '  trees) echo node_modules; exit ;;',
      ...(generationHelper ? ['  preflight-generation) exit ;;'] : []),
      '  ' + snapshotVerb + ') ;;',
      '  *) exit 94 ;;',
      'esac',
      'test "$4" = ' + (copiesDependencies ? 'copy' : 'hardlink'),
      'test ! -L "$2/node_modules/.bin"',
      'if [ "$4" = copy ]; then cp -a -- "$2/node_modules" "$3/node_modules"; else cp -al -- "$2/node_modules" "$3/node_modules"; fi',
      '',
    ].join('\n'));
    write(fixture.repo, '.gitignore', readFileSync(join(fixture.repo, '.gitignore'), 'utf8') + '\n/node_modules/\n/.papercusp/scratch/\n');
    git(fixture.repo, ['add', script, helper, '.gitignore', DEPENDENCY_POLICY_PATH]);
    git(fixture.repo, ['commit', '-qm', 'materialized dependency donor fixture']);
    const sha = git(fixture.repo, ['rev-parse', 'HEAD']).trim();
    trace('source-commit-complete');
    write(fixture.repo, 'node_modules/.bin/probe', '#!/bin/sh\n');
    write(fixture.repo, 'node_modules/@native-proof/runtime/package.json', JSON.stringify({
      name: '@native-proof/runtime', type: 'module', exports: './index.mjs' }));
    write(fixture.repo, 'node_modules/@native-proof/runtime/index.mjs', "export default 'private-snapshot';\n");
    trace('loader-install-start');
    installVerifierTsx(fixture.repo);
    trace('loader-install-complete');
    const materialized = join(tmp, 'materialized-dependency-source-' + caseId);
    trace('materialize-start');
    git(fixture.repo, ['clone', '--local', '--shared', '--recurse-submodules', fixture.repo, materialized]);
    trace('materialize-complete');
    const shadow = await import(new URL('../../../scripts/lint-as-committed.mjs', import.meta.url).href);
    write(materialized, shadow.OWNER_MARKER, JSON.stringify({ sha, sourceRepoRoot: fixture.repo }));
    shadow.linkNodeModulesShadow(join(fixture.repo, 'node_modules'), join(materialized, 'node_modules'), fixture.repo, materialized);
    trace('dependency-shadow-complete');
    expect((await fsPromises.lstat(join(materialized, 'node_modules/.bin'))).isSymbolicLink()).toBe(true);
    const receiptPath = join(tmp, 'materialized-dependency-source-receipt-' + caseId + '.json');
    const options = { repo: materialized, ref: sha, inputs: [script], receiptPath,
      command: [process.execPath, script, 'verifier-measure'], signal: context.signal };
    // The donor must pass the ignored-source-scratch guard, not accidentally
    // be admitted because both fixture repositories are beneath OS tmpdir.
    const restrictedTemp = join(tmp, 'materialized-source-only-temp-' + caseId);
    await fsPromises.mkdir(restrictedTemp);
    vi.stubEnv('TMPDIR', restrictedTemp);
    try {
      trace('verifier-command-start');
      expect(await runVerifierCommand(options)).toBe(0);
      trace('verifier-command-complete');
    } finally { vi.unstubAllEnvs(); }
    expect(JSON.parse(readFileSync(receiptPath, 'utf8')).sourceCommit).toBe(sha);
    const dependencyReceipt = JSON.parse(readFileSync(`${receiptPath}.dependencies.json`, 'utf8'));
    if (copiesDependencies) {
      expect(dependencyReceipt.root).toMatch(/^\/mnt\/data\/tmp\/verifier-command-/);
      expect(statSync(fixture.repo).dev).not.toBe(statSync('/mnt/data/tmp').dev);
    }
    expect(relative(fixture.repo, dependencyReceipt.root).startsWith('..' + sep)).toBe(true);
    expect(existsSync(join(fixture.repo, '.papercusp/scratch'))).toBe(false);
    expect(dependencyReceipt.sourceCommit).toBe(sha);
    // The recorded donor must never make a mismatched source identity acceptable.
    write(materialized, shadow.OWNER_MARKER, JSON.stringify({ sha: '0'.repeat(40), sourceRepoRoot: fixture.repo }));
    await expect(runVerifierCommand({ ...options, receiptPath: join(tmp, 'refused-donor-receipt-' + caseId + '.json') }))
      .rejects.toThrow('retained source commit does not match');
    trace('negative-control-complete');
    expect(existsSync(join(tmp, 'refused-donor-receipt-' + caseId + '.json'))).toBe(false);
    } finally {
      process.stderr.write('VERIFIER_MATERIALIZED_FIXTURE ' + JSON.stringify({ caseId, stage: 'cleanup-start',
        observedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - startedAt),
        aborted: context.signal.aborted }) + '\n');
      if (fixtureParent !== tmp) rmSync(fixtureParent, { recursive: true, force: true });
      process.stderr.write('VERIFIER_MATERIALIZED_FIXTURE ' + JSON.stringify({ caseId, stage: 'cleanup-complete',
        observedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - startedAt),
        aborted: context.signal.aborted }) + '\n');
    }
  });

  it.each(['data', 'temporary'] as const)('keeps an immutable donor verified during concurrent verifier commands and independent cleanup (%s)', async placement => {
    const fixture = makeSuperproject(join(tmp, 'verifier-concurrent-donor-fixture-' + placement));
    git(fixture.repo, ['rm', '-r', '--', 'node_modules', 'apps/operator/node_modules']);
    const script = 'scripts/source-preview.mjs';
    const helper = 'papercusp-desktop/bin/lib/pinned-deps.sh';
    write(fixture.repo, script, "console.log(process.argv.includes('verifier-measure') ? '4096' : 'inputs-ok');\n");
    write(fixture.repo, DEPENDENCY_POLICY_PATH, DEPENDENCY_POLICY);
    write(fixture.repo, helper, [
      '#!/bin/bash', 'set -eu', 'case "$1" in',
      '  trees) echo node_modules; exit ;;',
      '  preflight-generation) exit ;;',
      '  snapshot-generation-locked) ;;',
      '  snapshot-locked) ;;',
      '  *) exit 94 ;;', 'esac',
      'if [ "$4" = copy ]; then cp -a -- "$2/node_modules" "$3/node_modules"; else cp -al -- "$2/node_modules" "$3/node_modules"; fi',
    ].join('\n'));
    git(fixture.repo, ['add', script, helper, DEPENDENCY_POLICY_PATH]);
    git(fixture.repo, ['commit', '-qm', 'immutable concurrent donor fixture']);
    installVerifierTsx(fixture.repo);
    const donorParent = placement === 'data' && process.platform === 'linux'
      ? mkdtempSync('/mnt/data/tmp/verifier-concurrent-donor-') : tmp;
    const donor = join(donorParent, 'verifier-concurrent-qualified-donor-' + placement);
    try {
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: 'HEAD', dest: donor,
      inputs: [script], gitCheckout: true });
    await prepareVerifierDependencies({ donor: fixture.repo, dest: donor, receipt, env: childEnv() });
    const before = verifierSourceFiles(donor);
    await expect(verifyVerifierSource(donor, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
    const gates = [0, 1].map(() => {
      let ready!: (root: string) => void, failed!: (error: unknown) => void, release!: () => void;
      const prepared = new Promise<string>((resolve, reject) => { ready = resolve; failed = reject; });
      const proceed = new Promise<void>(resolve => { release = resolve; });
      return { ready, failed, release, prepared, proceed };
    });
    const receipts = gates.map((_, index) => join(tmp, `verifier-concurrent-${placement}-${index}.json`));
    const runs = gates.map((gate, index) => runVerifierCommand({ repo: donor, ref: receipt.sourceCommit,
      inputs: [script], receiptPath: receipts[index]!, env: childEnv(),
      command: [process.execPath, '-e', 'process.exit(0)'],
      prepareChildEnv: async ({ sourceRoot }) => { gate.ready(sourceRoot); await gate.proceed; },
    }).then(code => ({ code, error: null }), error => {
      gate.failed(error); return { code: null, error };
    }));
    try {
      const roots = await Promise.all(gates.map(gate => gate.prepared));
      expect(new Set(roots).size).toBe(2);
      const tasks = receipts.map(path => JSON.parse(readFileSync(path + '.task.json', 'utf8')));
      for (const [index, root] of roots.entries()) {
        expect(relative(donor, root).startsWith('..' + sep)).toBe(true);
        expect(root).toBe(join(tasks[index].ownedRoot, 'invoked-source'));
        expect(tasks[index]).toMatchObject({ repoRoot: donor, cleanup: 'pending' });
      }
      expect(verifierSourceFiles(donor)).toEqual(before);
      await expect(verifyVerifierSource(donor, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
      // Preserve the detector: an actual added donor file must still fail.
      const added = join(donor, 'unexpected-concurrent-source.txt');
      writeFileSync(added, 'must not be ignored');
      try { await expect(verifyVerifierSource(donor, receipt, { runtimeArtifacts: true }))
        .rejects.toThrow('tampered verification source'); }
      finally { rmSync(added); }
      gates[0]!.release();
      expect(await runs[0]).toEqual({ code: 0, error: null });
      expect(existsSync(tasks[0].ownedRoot)).toBe(false);
      expect(existsSync(roots[1]!)).toBe(true);
      await expect(verifyVerifierSource(donor, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
      gates[1]!.release();
      expect(await runs[1]).toEqual({ code: 0, error: null });
      for (const [index, task] of tasks.entries()) {
        expect(existsSync(task.ownedRoot)).toBe(false);
        expect(JSON.parse(readFileSync(receipts[index] + '.task.json', 'utf8')).cleanup).toBe('completed');
        const phases = readFileSync(receipts[index] + '.phases.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(phases.find(row => row.phase === 'source.postverify' && row.event === 'completed')).toBeDefined();
      }
      expect(verifierSourceFiles(donor)).toEqual(before);
      await expect(verifyVerifierSource(donor, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
    } finally {
      for (const gate of gates) gate.release();
      await Promise.all(runs);
    }
    } finally {
      if (donorParent !== tmp) rmSync(donorParent, { recursive: true, force: true });
    }
  }, 120_000);

  it.each([
    { selection: 'automatic', layout: 'superproject' },
    { selection: 'explicit', layout: 'superproject' },
    { selection: 'automatic', layout: 'submodule' },
    { selection: 'explicit', layout: 'submodule' },
  ] as const)('checks $selection generation custody against selected source before dependencies or PG ($layout helper)', async ({ selection, layout }) => {
    const parent = process.platform === 'linux' ? mkdtempSync('/var/tmp/source-preview-generation-preflight-') : tmp;
    try {
      const fixture = makeSuperproject(join(parent, 'generation-' + selection + '-' + layout));
      const usesAutomaticGeneration = process.platform === 'linux' &&
        statSync(fixture.repo).dev === statSync('/').dev;
      if (selection === 'automatic' && !usesAutomaticGeneration) return;
      const helper = 'papercusp-desktop/bin/lib/pinned-deps.sh';
      const helperSource = [
        '#!/bin/bash', 'set -eu', 'case "$1" in',
        '  preflight-generation)',
        '    test "$(cat "$3/selected-source.txt")" = committed-candidate || { echo "checked moving source" >&2; exit 95; }',
        '    echo "missing verifier closure" >&2; exit 74 ;;',
        '  snapshot-generation-locked) echo "snapshot must not start" >&2; exit 93 ;;',
        '  *) exit 94 ;;', 'esac', '',
      ].join('\n');
      if (layout === 'submodule') {
        git(fixture.repo, ['rm', '-r', '--', 'papercusp-desktop']);
        const desktop = join(parent, 'desktop-' + selection);
        mkdirSync(desktop, { recursive: true });
        git(desktop, ['init', '-q', '-b', 'main']);
        write(desktop, 'bin/lib/pinned-deps.sh', helperSource);
        git(desktop, ['add', '-A']);
        git(desktop, ['commit', '-qm', 'pinned generation helper']);
        git(fixture.repo, ['submodule', 'add', '-q', desktop, 'papercusp-desktop']);
      } else write(fixture.repo, helper, helperSource);
      write(fixture.repo, 'selected-source.txt', 'committed-candidate');
      git(fixture.repo, ['add', 'papercusp-desktop', 'selected-source.txt']);
      git(fixture.repo, ['commit', '-qm', 'generation admission fixture']);
      const ref = git(fixture.repo, ['rev-parse', 'HEAD']).trim();
      write(fixture.repo, 'selected-source.txt', 'unrelated-live-change');
      // The selected gitlink's contract must survive a mutable helper rewrite.
      if (layout === 'submodule') write(fixture.repo, helper, '#!/bin/bash\nexit 0\n');
      const prepareChildEnv = vi.fn(async () => { throw new Error('PG must not start'); });
      const receiptPath = join(tmp, 'generation-preflight-' + selection + '-' + layout + '.json');
      await expect(runVerifierCommand({ repo: fixture.repo,
        ref, receiptPath, prepareChildEnv,
        inputs: [layout === 'submodule' ? 'apps/operator/src/index.ts' : helper],
        env: { ...childEnv(), PAPERCUSP_DEPENDENCY_GENERATION_ROOT: selection === 'explicit' ? join(parent, 'store') : '' },
        command: [process.execPath, '-e', 'throw Error("provider must not start")'],
      })).rejects.toThrow('verifier generation preflight failed: missing verifier closure');
      expect(JSON.parse(readFileSync(receiptPath, 'utf8')).sourceCommit).toBe(ref);
      const task = JSON.parse(readFileSync(receiptPath + '.task.json', 'utf8'));
      expect(task.cleanup).toBe('completed');
      expect(existsSync(task.ownedRoot)).toBe(false);
      expect(existsSync(receiptPath + '.dependencies.json')).toBe(false);
      expect(prepareChildEnv).not.toHaveBeenCalled();
      expect(existsSync(join(fixture.repo, '.papercusp/scratch'))).toBe(false);
    } finally {
      if (parent !== tmp) rmSync(parent, { recursive: true, force: true });
    }
  });

  it('checks the committed runtime asset pin before allocating verifier source', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-runtime-asset-preflight'));
    const setup = 'apps/operator/scripts/setup-porcupine-runtime.sh';
    const model = 'apps/operator/public/porcupine/porcupine_params.pv';
    const helper = 'papercusp-desktop/bin/lib/pinned-deps.sh';
    const validModel = 'pinned-model-fixture';
    const checksum = createHash('sha256').update(validModel).digest('hex');
    write(fixture.repo, setup, [
      '#!/bin/bash', 'set -eu', 'test "$1" = --check-source',
      'if ! test -f "$2" || test "$(sha256sum "$2" | cut -d\' \' -f1)" != ' + checksum + '; then',
      '  echo "pinned runtime model missing or invalid" >&2; exit 75', 'fi', '',
    ].join('\n'));
    write(fixture.repo, helper, [
      '#!/bin/bash', 'case "$1" in',
      '  preflight-generation) echo "runtime cache accepted; generation guard reached" >&2; exit 74 ;;',
      '  snapshot-generation-locked) exit 93 ;;', '  *) exit 94 ;;', 'esac', '',
    ].join('\n'));
    git(fixture.repo, ['add', setup, helper]);
    git(fixture.repo, ['commit', '-qm', 'pinned runtime asset admission fixture']);
    const ref = git(fixture.repo, ['rev-parse', 'HEAD']).trim();
    // A mutable donor helper must not replace the selected commit's checksum pin.
    write(fixture.repo, setup, '#!/bin/bash\nexit 0\n');
    const receiptPath = join(tmp, 'runtime-asset-preflight.json');
    const options = { repo: fixture.repo, ref, receiptPath, inputs: [helper],
      env: { ...childEnv(), PAPERCUSP_DEPENDENCY_GENERATION_ROOT: join(tmp, 'runtime-asset-store') },
      command: [process.execPath, '-e', 'throw Error("provider must not start")'] };
    await expect(runVerifierCommand(options)).rejects.toThrow('pinned runtime model missing or invalid');
    write(fixture.repo, model, 'wrong-model');
    await expect(runVerifierCommand(options)).rejects.toThrow('pinned runtime model missing or invalid');
    write(fixture.repo, model, validModel);
    await expect(runVerifierCommand(options)).rejects.toThrow('runtime cache accepted; generation guard reached');
    expect(JSON.parse(readFileSync(receiptPath, 'utf8')).sourceCommit).toBe(ref);
    expect(JSON.parse(readFileSync(receiptPath + '.task.json', 'utf8')).cleanup).toBe('completed');
    expect(existsSync(join(fixture.repo, '.papercusp/scratch'))).toBe(false);
  });

  it('rejects a source-only candidate missing a generated workspace bin before allocating verifier source', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-workspace-bin-donor'));
    const manifest = 'packages/omp-plugin/package.json';
    const input = 'scripts/provider-fixture.mjs';
    const output = 'packages/omp-plugin/dist/omp-plugin.js';
    write(fixture.repo, manifest, JSON.stringify({
      name: '@fixture/omp-plugin',
      bin: './dist/omp-plugin.js',
    }) + '\n');
    write(fixture.repo, input, 'export const fixture = true;\n');
    git(fixture.repo, ['add', manifest, input]);
    git(fixture.repo, ['commit', '-qm', 'workspace bin donor preflight fixture']);
    const ref = git(fixture.repo, ['rev-parse', 'HEAD']).trim();
    // This output exists only in the physical dependency donor, not in the
    // committed source clone selected by committedWorkRootDependencyDonor.
    write(fixture.repo, output, '#!/usr/bin/env node\n');
    const candidate = join(tmp, 'verifier-workspace-bin-candidate');
    git(fixture.repo, ['clone', '--local', '--shared', '--recurse-submodules', fixture.repo, candidate]);
    expect(existsSync(join(fixture.repo, output))).toBe(true);
    expect(existsSync(join(candidate, output))).toBe(false);

    const receiptPath = join(tmp, 'verifier-workspace-bin-receipt.json');
    await expect(runVerifierCommand({
      repo: candidate,
      ref,
      inputs: [input],
      receiptPath,
      command: [process.execPath, '-e', 'process.exit(0)'],
    })).rejects.toThrow('missing-workspace-bin-output:packages/omp-plugin/package.json');
    expect(existsSync(receiptPath)).toBe(false);
    expect(existsSync(join(candidate, '.papercusp/scratch'))).toBe(false);
  });

  it.each(['donor-change', 'child-failure', 'child-output-overflow', 'output-io-failure', 'frozen-tamper', 'dependency-tamper', 'dependency-preflight-failure', 'census-failure', 'phase-io-failure', 'deadline-refusal', 'history-refusal', 'private-pg-release', 'evidence-retention'] as const)
    ('freezes the full command before provider allocation and cleans its owned tree (%s)', async mode => {
      const fixture = makeSuperproject(join(tmp, 'verifier-command-' + mode));
      git(fixture.repo, ['rm', '-r', '--', 'node_modules', 'apps/operator/node_modules']);
      const preflight = 'scripts/source-preview.mjs';
      const provider = 'scripts/provider-fixture.mjs';
      const helper = 'papercusp-desktop/bin/lib/pinned-deps.sh';
      write(fixture.repo, DEPENDENCY_POLICY_PATH, DEPENDENCY_POLICY);
      write(fixture.repo, preflight, "console.log(process.argv.includes('verifier-measure') ? '4096' : 'inputs-ok');\n");
      const snapshotCustody = 'donor=fixture\nmode=generation-copy\ntrees=1\ngeneration=original-generation\ninput=original-input\ntoken=original-token\n';
      write(fixture.repo, helper, '#!/bin/bash\nset -eu\nif [ "$1" = trees ]; then if [ "${VERIFIER_CENSUS_FAIL:-}" = 1 ]; then echo census failure >&2; exit 43; fi; echo node_modules; exit; fi\nif [ "${VERIFIER_PREPARE_FAIL:-}" = 1 ]; then echo missing dependency generation >&2; exit 42; fi\nif [ "$4" = copy ]; then cp -a -- "$2/node_modules" "$3/node_modules"; else cp -al -- "$2/node_modules" "$3/node_modules"; fi\nprintf "' + snapshotCustody.replaceAll('\n', '\\n') + '" > "$3/.papercusp-pinned-deps"\n');
      write(fixture.repo, '.gitignore', readFileSync(join(fixture.repo, '.gitignore'), 'utf8') + '\n/.papercusp/scratch/\n');
      write(fixture.repo, provider, [
        "import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "import value from '@native-proof/runtime';",
        "const donor = process.argv[2], mode = process.argv[3];",
        "writeFileSync(join(donor, 'scripts/provider-fixture.mjs'), 'peer edit after allocation');",
        "rmSync(join(donor, 'node_modules'), { recursive: true, force: true });",
        "const receipt = JSON.parse(readFileSync(process.env.VERIFY_TAURI_SOURCE_RECEIPT, 'utf8'));",
        "writeFileSync(process.argv[4], JSON.stringify({ root: process.cwd(), value, ref: receipt.sourceCommit,",
        "  receipt: process.env.VERIFY_TAURI_SOURCE_RECEIPT, repo: process.env.PAPERCUSP_REPO_DIR,",
        "  source: readFileSync('scripts/provider-fixture.mjs', 'utf8'),",
        "  options: process.env.NODE_OPTIONS, path: process.env.NODE_PATH, flag: process.argv[5],",
        "  privatePgReleaseToken: process.env.PAPERCUSP_PRIVATE_TEST_PG_RELEASE_TOKEN ?? null,",
        "  preparedChildEnv: process.env.VERIFIER_CHILD_ENV_PREPARED ?? null }));",
        "if (mode === 'frozen-tamper') writeFileSync('scripts/provider-fixture.mjs', 'tampered frozen source');",
        "if (mode === 'dependency-tamper') writeFileSync('node_modules/@native-proof/runtime/index.mjs', 'tampered installed bytes');",
        "if (mode === 'child-failure' || mode === 'child-output-overflow') {",
        "  if (mode === 'child-output-overflow') { process.stdout.write('x'.repeat(131072)); process.stderr.write('y'.repeat(131072)); }",
        "  console.log('provider bootstrap stdout'); console.error('provider bootstrap stderr'); process.exitCode = 37;",
        "}",
        "if (mode === 'output-io-failure') { const path = process.env.VERIFY_TAURI_SOURCE_RECEIPT + '.child.json'; rmSync(path); mkdirSync(path); }",
        "if (mode === 'phase-io-failure') { const path = process.env.VERIFY_TAURI_SOURCE_RECEIPT + '.phases.jsonl'; rmSync(path); mkdirSync(path); }",
      ].join('\n'));
      git(fixture.repo, ['add', preflight, provider, helper, '.gitignore', DEPENDENCY_POLICY_PATH]);
      git(fixture.repo, ['commit', '-qm', 'full verifier command fixture']);
      const ref = git(fixture.repo, ['rev-parse', 'HEAD']);
      const original = readFileSync(join(fixture.repo, provider), 'utf8');
      write(fixture.repo, 'node_modules/@native-proof/runtime/package.json', JSON.stringify({
        name: '@native-proof/runtime', type: 'module', exports: './index.mjs' }));
      write(fixture.repo, 'node_modules/@native-proof/runtime/index.mjs', "export default 'private-snapshot';\n");
      installVerifierTsx(fixture.repo);
      const receiptPath = join(tmp, 'verifier-command-' + mode + '.receipt.json');
      const proofPath = join(tmp, 'verifier-command-' + mode + '.proof.json');
      const command = [process.execPath, provider, fixture.repo, mode, proofPath, '--provider-flag=literal'];
      const budgetFrom = join(tmp, 'verifier-command-budget-' + mode + '.jsonl');
      const requestParentPgRelease = vi.fn(async () => {});
      const releasesPrivatePg = mode === 'private-pg-release' || mode === 'output-io-failure';
      const prepareChildEnv = vi.fn(async ({ sourceRoot }: { sourceRoot: string }) => {
        const dependencies = JSON.parse(readFileSync(`${receiptPath}.dependencies.json`, 'utf8'));
        expect(dependencies.sourceCommit).toBe(ref);
        expect(existsSync(join(sourceRoot, 'node_modules'))).toBe(true);
        expect(existsSync(proofPath)).toBe(false);
        return { VERIFIER_CHILD_ENV_PREPARED: 'dependency-generation-ready' };
      });
      const taskId = mode === 'evidence-retention' || mode === 'census-failure' ? 'delayed-consumer-fixture' : null;
      const checkpointLogDir = join(tmp, 'verifier-task-evidence-checkpoint-logs');
      const env = { ...process.env, NODE_OPTIONS: '--import=/nonexistent/ambient-loader', NODE_PATH: '/ambient/dependencies',
        PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(Date.now() + 900_000),
        ...(taskId ? { PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: taskId,
          PAPERCUSP_CHECKPOINT_LOG_DIR: checkpointLogDir } : {}),
        ...(releasesPrivatePg ? { PAPERCUSP_PRIVATE_TEST_PG_RELEASE_TOKEN: 'parent-release-token' } : {}),
        ...(mode === 'dependency-preflight-failure' ? { VERIFIER_PREPARE_FAIL: '1' } : {}),
        ...(mode === 'census-failure' ? { VERIFIER_CENSUS_FAIL: '1' } : {}),
        ...(['history-refusal', 'deadline-refusal'].includes(mode) ? {
          PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(Date.now() + (mode === 'deadline-refusal' ? 180_000 : 60_000)),
        } : {}) };
      if (mode === 'history-refusal') {
        let elapsedMs = 0;
        const rows = Object.entries(budgetPhases).flatMap(([phase, durationMs], index) => [
          { schemaVersion: 'verifier-phase-v1', sequence: index * 2 + 1, phase, event: 'started', elapsedMs },
          { schemaVersion: 'verifier-phase-v1', sequence: index * 2 + 2, phase, event: 'completed', durationMs, elapsedMs: elapsedMs += durationMs },
        ]);
        writeFileSync(budgetFrom, rows.map(row => JSON.stringify(row)).join('\n'));
      }
      const invocation = mode === 'donor-change'
        ? runCli(['verifier-run', '--repo', fixture.repo, '--ref', ref, '--inputs', provider,
          '--receipt', receiptPath, '--', ...command])
        : runVerifierCommand({ repo: fixture.repo, ref, inputs: [provider], receiptPath, command,
          ...(mode === 'history-refusal' ? { budgetFrom } : {}),
          childEstimateMs: mode === 'deadline-refusal' ? 600_000 : 0,
          env,
          prepareChildEnv,
          ...(releasesPrivatePg ? { releaseParentPrivatePg: true,
            requestParentPgReleaseImpl: requestParentPgRelease } : {}) });
      if (mode === 'dependency-preflight-failure' || mode === 'census-failure') {
        await expect(invocation).rejects.toThrow(mode === 'census-failure' ? 'census failure' : 'missing dependency generation');
        expect(prepareChildEnv).not.toHaveBeenCalled();
        expect(existsSync(proofPath)).toBe(false);
        expect(existsSync(join(fixture.repo, '.papercusp/scratch'))).toBe(false);
        const phases = readFileSync(receiptPath + '.phases.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(phases.find(row => row.event === 'failed')).toMatchObject({ phase: mode === 'census-failure' ? 'deps.census' : 'deps.snapshot' });
        expect(phases.some(row => row.phase === 'child.environment' || row.phase === 'child.run')).toBe(false);
        expect(phases.at(-1)).toMatchObject({ phase: 'cleanup', event: 'completed' });
        if (mode === 'census-failure') {
          const task = JSON.parse(readFileSync(`${receiptPath}.task.json`, 'utf8'));
          const manifest = JSON.parse(readFileSync(task.evidenceManifestPath, 'utf8'));
          const original = readFileSync(`${receiptPath}.snapshot.txt`);
          expect(original.toString()).toBe(snapshotCustody);
          rmSync(`${receiptPath}.snapshot.txt`);
          expect(manifest).toMatchObject({ wrapperStatus: 'failed', cleanup: 'completed', childExitCode: null });
          expect(manifest.artifacts['dependencies.json']).toBeUndefined();
          const retained = manifest.artifacts['snapshot.txt'];
          expect(readFileSync(retained.path)).toEqual(original);
          expect(retained.sha256).toBe(createHash('sha256').update(original).digest('hex'));
          expect(statSync(retained.path).mode & 0o777).toBe(0o600);
        }
        return;
      }
      if (mode === 'deadline-refusal' || mode === 'history-refusal') {
        expect(prepareChildEnv).not.toHaveBeenCalled();
        await expect(invocation).rejects.toThrow('TASK_DEADLINE_REFUSAL');
        expect(existsSync(proofPath)).toBe(false);
        expect(existsSync(join(fixture.repo, '.papercusp/scratch'))).toBe(false);
        const phases = readFileSync(receiptPath + '.phases.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(phases.some(row => row.phase === 'child.preflight' || row.phase === 'child.run')).toBe(false);
        expect(phases.filter(row => row.event === 'failed').map(row => row.phase))
          .toEqual([mode === 'history-refusal' ? 'source.admission' : 'child.admission']);
        expect(phases.at(-1)).toMatchObject({ phase: 'cleanup', event: 'completed' });
        expect(readFileSync(join(fixture.repo, provider), 'utf8')).toBe(original);
        if (mode === 'history-refusal') expect(existsSync(receiptPath)).toBe(false);
        else expect(existsSync(receiptPath + '.dependencies.json')).toBe(true);
        return;
      }
      const stdout = mode === 'child-output-overflow' ? vi.spyOn(process.stdout, 'write').mockImplementation(() => true) : null;
      const stderr = mode === 'child-output-overflow' || mode === 'evidence-retention'
        ? vi.spyOn(process.stderr, 'write').mockImplementation(() => true) : null;
      let returnedRefLine: string | undefined;
      try {
        if (mode === 'frozen-tamper') await expect(invocation).rejects.toThrow('tampered verification source archive');
        else if (mode === 'dependency-tamper') await expect(invocation).rejects.toThrow('Verifier materialized dependencies changed during command');
        else if (mode === 'phase-io-failure') await expect(invocation).rejects.toThrow('EISDIR');
        else if (mode === 'output-io-failure') await expect(invocation).rejects.toThrow('Verifier child diagnostics path changed');
        else await expect(invocation).resolves.toBe(['child-failure', 'child-output-overflow'].includes(mode) ? 37 : 0);
        if (mode === 'evidence-retention') {
          returnedRefLine = stderr?.mock.calls.map(([chunk]) => String(chunk))
            .find(line => line.startsWith('VERIFIER_TASK_EVIDENCE '));
        }
        if (mode === 'child-output-overflow') {
          expect(stdout?.mock.calls.some(([chunk]) => String(chunk).includes('provider bootstrap stdout'))).toBe(true);
          expect(stderr?.mock.calls.some(([chunk]) => String(chunk).includes('provider bootstrap stderr'))).toBe(true);
        }
      } finally { stdout?.mockRestore(); stderr?.mockRestore(); }
      expect(prepareChildEnv).toHaveBeenCalledTimes(mode === 'donor-change' ? 0 : 1);
      const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
      expect(proof).toMatchObject({ value: 'private-snapshot', ref, receipt: receiptPath,
        source: original, options: '', path: '', flag: '--provider-flag=literal', privatePgReleaseToken: null });
      if (mode !== 'donor-change') expect(proof.preparedChildEnv).toBe('dependency-generation-ready');
      expect(requestParentPgRelease).toHaveBeenCalledTimes(releasesPrivatePg ? 1 : 0);
      if (releasesPrivatePg) expect(requestParentPgRelease).toHaveBeenCalledWith('parent-release-token');
      expect(proof.root).toBe(proof.repo);
      expect(proof.root).not.toBe(fixture.repo);
      expect(existsSync(proof.root)).toBe(false);
      expect(existsSync(join(fixture.repo, '.papercusp/scratch'))).toBe(false);
      expect(readFileSync(join(fixture.repo, provider), 'utf8')).toBe('peer edit after allocation');
      expect(existsSync(join(fixture.repo, 'node_modules'))).toBe(false);
      expect(JSON.parse(readFileSync(receiptPath, 'utf8')).sourceCommit).toBe(ref);
      if (mode === 'output-io-failure') {
        const phases = readFileSync(receiptPath + '.phases.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const childFailure = phases.find(row => row.phase === 'child.run' && row.event === 'failed');
        const releaseStart = phases.find(row => row.phase === 'private-pg.release' && row.event === 'started');
        expect(childFailure).toBeDefined();
        expect(releaseStart.sequence).toBeGreaterThan(childFailure.sequence);
        expect(phases.find(row => row.phase === 'private-pg.release' && row.event === 'completed')).toBeDefined();
        expect(phases.some(row => row.phase === 'deps.postverify')).toBe(false);
        expect(JSON.parse(readFileSync(receiptPath + '.task.json', 'utf8')).budget.childExitVerifiedAtMs)
          .toBeTypeOf('number');
        return; // Failed retention still joins the child and cleans its tree.
      }
      if (mode === 'child-failure' || mode === 'child-output-overflow') {
        const diagnostics = JSON.parse(readFileSync(receiptPath + '.child.json', 'utf8'));
        expect(diagnostics).toMatchObject({ schemaVersion: 'verifier-child-v1', exitCode: 37, signal: null, error: null });
        for (const stream of ['stdout', 'stderr'] as const) {
          const log = readFileSync(diagnostics[stream].path);
          expect(log.byteLength).toBeLessThanOrEqual(64 * 1024);
          expect(log.toString()).toMatch(new RegExp(`provider bootstrap ${stream}\\n$`));
          expect(diagnostics[stream]).toMatchObject({ retainedBytes: log.byteLength,
            truncated: mode === 'child-output-overflow' });
          expect(statSync(diagnostics[stream].path).mode & 0o777).toBe(0o600);
        }
        expect(statSync(receiptPath + '.child.json').mode & 0o777).toBe(0o600);
      }
      const phasePath = receiptPath + '.phases.jsonl';
      if (mode === 'phase-io-failure') {
        expect(statSync(phasePath).isDirectory()).toBe(true);
        return; // Owned-tree absence above proves telemetry failure still cleans.
      }
      const phases = readFileSync(phasePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(statSync(phasePath).mode & 0o777).toBe(0o600);
      expect(phases.map(row => row.sequence)).toEqual(phases.map((_, index) => index + 1));
      expect(phases.every(row => Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0)).toBe(true);
      expect(phases.filter(row => row.event === 'started').map(row => row.phase)).toEqual([
        'source.admission', 'source.freeze', 'receipt.write', 'deps.source.before',
        'deps.source.after-runtime-assets', 'deps.snapshot',
        'deps.source.after-snapshot', 'deps.inputs', 'deps.measure', 'deps.source.after-preflight',
        'deps.census', 'deps.receipt.write', 'child.admission', 'child.preflight', 'child.environment', 'child.run',
        ...(mode === 'private-pg-release' ? ['private-pg.release'] : []), 'deps.postverify',
        ...(mode === 'dependency-tamper' ? [] : ['source.postverify']), 'cleanup',
      ]);
      expect(phases.filter(row => row.event === 'failed').map(row => row.phase))
        .toEqual(mode === 'frozen-tamper' ? ['source.postverify'] : mode === 'dependency-tamper' ? ['deps.postverify'] : []);
      const beforeDependencies = JSON.parse(readFileSync(receiptPath + '.dependencies.json', 'utf8'));
      const afterDependencies = JSON.parse(readFileSync(receiptPath + '.dependencies.after.json', 'utf8'));
      expect(beforeDependencies.scope).toBe('materialized-dependency-files');
      expect(beforeDependencies.sourceCommit).toBe(ref);
      expect(beforeDependencies.sourceReceiptSha256).toBe(createHash('sha256')
        .update(JSON.stringify(JSON.parse(readFileSync(receiptPath, 'utf8')))).digest('hex'));
      if (mode === 'dependency-tamper') expect(afterDependencies).not.toEqual(beforeDependencies);
      else expect(afterDependencies).toEqual(beforeDependencies);
      expect(phases.find(row => row.phase === 'child.run' && row.event === 'completed'))
        .toMatchObject({ exitCode: ['child-failure', 'child-output-overflow'].includes(mode) ? 37 : 0,
          diagnosticsPath: receiptPath + '.child.json' });
      expect(phases.at(-1)).toMatchObject({ phase: 'cleanup', event: 'completed' });
      if (mode === 'evidence-retention') {
        const taskReceiptPath = `${receiptPath}.task.json`;
        const taskReceipt = JSON.parse(readFileSync(taskReceiptPath, 'utf8'));
        const runId = createHash('sha256').update(receiptPath).digest('hex');
        const expectedManifestPath = join(checkpointLogDir, `verifier-task-${taskId}`, runId, 'manifest.json');
        expect(taskReceipt).toMatchObject({ taskId, cleanup: 'completed', evidenceManifestPath: expectedManifestPath });
        const temporarySources = {
          'source.json': receiptPath,
          'snapshot.txt': `${receiptPath}.snapshot.txt`,
          'dependencies.json': `${receiptPath}.dependencies.json`,
          'dependencies-after.json': `${receiptPath}.dependencies.after.json`,
          'task.json': taskReceiptPath,
          'resources.jsonl': `${receiptPath}.resources.jsonl`,
          'phases.jsonl': `${receiptPath}.phases.jsonl`,
          'child.json': `${receiptPath}.child.json`,
          'stdout.log': `${receiptPath}.stdout.log`,
          'stderr.log': `${receiptPath}.stderr.log`,
        };
        const originalBytes = new Map(Object.entries(temporarySources)
          .map(([name, path]) => [name, readFileSync(path)]));
        for (const path of Object.values(temporarySources)) rmSync(path, { force: true });
        expect(returnedRefLine).toBeDefined();
        const returnedRef = JSON.parse(returnedRefLine!.slice('VERIFIER_TASK_EVIDENCE '.length)) as {
          taskId: string; manifestPath: string;
        };
        expect(returnedRef).toEqual({ taskId, manifestPath: expectedManifestPath });
        const manifest = JSON.parse(readFileSync(returnedRef.manifestPath, 'utf8')) as {
          artifacts: Record<string, { path: string; sizeBytes: number; sha256: string }>;
        };
        expect(manifest).toMatchObject({ schemaVersion: 'verifier-task-evidence-v1', taskId,
          runId, sourceCommit: ref, wrapperStatus: 'completed', cleanup: 'completed', childExitCode: 0,
          childLogs: { stdout: 'stdout.log', stderr: 'stderr.log' } });
        expect(Object.keys(manifest.artifacts).sort()).toEqual(Object.keys(temporarySources).sort());
        for (const [name, artifact] of Object.entries(manifest.artifacts)) {
          const bytes = readFileSync(artifact.path);
          expect(bytes).toEqual(originalBytes.get(name));
          expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
          expect(statSync(artifact.path).mode & 0o777).toBe(0o600);
        }
      }
    });

  it('refuses an aborted verifier before source lookup or allocation', async () => {
    const receiptPath = join(tmp, 'verifier-aborted-before-launch.json');
    const controller = new AbortController();
    controller.abort();
    await expect(runVerifierCommand({ repo: join(tmp, 'absent-aborted-repo'), ref: 'HEAD', receiptPath,
      command: [process.execPath, '-e', 'process.exit(0)'], signal: controller.signal }))
      .rejects.toMatchObject({ message: 'verifier command canceled before launch', exitCode: 143 });
    expect(existsSync(receiptPath)).toBe(false);
    expect(existsSync(receiptPath + '.task.json')).toBe(false);
  });

  it.each(['hung', 'descendant', 'signal-race', 'caller-abort', 'unverified', 'completed', 'no-deadline'] as const)(
    'enforces the cleanup-reserve cutoff through the owned process group (%s)', async mode => {
      const fixture = makeSuperproject(join(tmp, 'verifier-cutoff-' + mode));
      git(fixture.repo, ['rm', '-r', '--', 'node_modules', 'apps/operator/node_modules']);
      const helper = 'papercusp-desktop/bin/lib/pinned-deps.sh';
      const preflight = 'scripts/source-preview.mjs';
      const provider = 'scripts/cutoff-fixture.mjs';
      const ready = join(tmp, 'verifier-cutoff-ready-' + mode);
      write(fixture.repo, DEPENDENCY_POLICY_PATH, DEPENDENCY_POLICY);
      write(fixture.repo, preflight, "console.log(process.argv.includes('verifier-measure') ? '4096' : 'inputs-ok');\n");
      write(fixture.repo, helper, '#!/bin/bash\nset -eu\nif [ "$1" = trees ]; then echo node_modules; exit; fi\nif [ "$4" = copy ]; then cp -a -- "$2/node_modules" "$3/node_modules"; else cp -al -- "$2/node_modules" "$3/node_modules"; fi\n');
      const successful = mode === 'completed' || mode === 'no-deadline';
      write(fixture.repo, provider, [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        successful ? `writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ root: process.cwd(), group: process.pid })); process.exitCode = 37;`
          : `spawn(process.execPath, ['-e', ${JSON.stringify([
            "const fs = require('node:fs'); process.on('SIGTERM', () => {});",
            `fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ root: process.cwd(), group: process.ppid, descendant: process.pid }));`,
            "setInterval(() => {}, 1000);",
          ].join('\n'))}], { stdio: 'ignore' });`,
        ...(!successful && mode !== 'descendant' ? ['setInterval(() => {}, 1000);'] : []),
      ].join('\n'));
      write(fixture.repo, '.gitignore', readFileSync(join(fixture.repo, '.gitignore'), 'utf8') + '\n/.papercusp/scratch/\n');
      git(fixture.repo, ['add', helper, preflight, provider, '.gitignore', DEPENDENCY_POLICY_PATH]);
      git(fixture.repo, ['commit', '-qm', 'owned verifier cutoff fixture']);
      const ref = git(fixture.repo, ['rev-parse', 'HEAD']);
      write(fixture.repo, 'node_modules/@native-proof/runtime/package.json', JSON.stringify({
        name: '@native-proof/runtime', type: 'module', exports: './index.mjs' }));
      write(fixture.repo, 'node_modules/@native-proof/runtime/index.mjs', "export default 'private-snapshot';\n");
      installVerifierTsx(fixture.repo);
      const receiptPath = join(tmp, 'verifier-cutoff-' + mode + '.json');
      let now = 1_000_000;
      const deadline = now + 300_000;
      const pending = new Map<ReturnType<typeof setTimeout>, { callback: () => void; delay: number }>();
      const clock = { now: () => now,
        setTimeout: vi.fn(((callback: () => void, delay: number) => {
          const timer = {} as ReturnType<typeof setTimeout>;
          pending.set(timer, { callback, delay });
          return timer;
        })),
        clearTimeout: vi.fn((timer: ReturnType<typeof setTimeout>) => { pending.delete(timer); }),
      };
      const env = childEnv({ PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(deadline) });
      if (mode === 'no-deadline') delete env.PAPERCUSP_TASK_DEADLINE_EPOCH_MS;
      const controller = new AbortController();
      const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener');
      const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM'), process.listenerCount('SIGHUP')];
      const result = runVerifierCommand({ repo: fixture.repo, ref, receiptPath, inputs: [provider],
        command: [process.execPath, provider], env, clock, signal: controller.signal })
        .then(code => ({ code, error: null }), error => ({ code: null, error }));
      let owned: string | undefined, peer: string | undefined, group: number | undefined;
      const kill = process.kill.bind(process);
      let killSpy: ReturnType<typeof vi.spyOn> | undefined;
      let signalShutdown: Promise<void> | undefined;
      try {
        await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 20_000, interval: 20 });
        const child = JSON.parse(readFileSync(ready, 'utf8'));
        owned = dirname(child.root); group = child.group;
        peer = mkdtempSync(join(dirname(owned!), 'verifier-command-'));
        writeFileSync(join(peer, 'peer-owned'), 'must survive');
        const initial = JSON.parse(readFileSync(receiptPath + '.task.json', 'utf8'));
        expect(initial).toMatchObject({ cleanup: 'pending', ownedRoot: owned });
        if (!successful) {
          expect(pending.size).toBe(1);
          const fire = () => {
            const [timer, scheduled] = [...pending.entries()][0]!;
            pending.delete(timer); scheduled.callback();
          };
          expect([...pending.values()][0]!.delay).toBe(180_000);
          // An early callback must re-arm against the absolute clock.
          now = deadline - 120_000 - 1; fire();
          expect([...pending.values()][0]!.delay).toBe(1);
          expect(existsSync(owned!)).toBe(true);
          if (mode === 'unverified') {
            killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) =>
              pid === -group! && signal !== 0 ? true : kill(pid, signal));
          }
          now++;
          if (mode === 'caller-abort') controller.abort();
          else fire();
          if (mode === 'signal-race') {
            // The shared lifetime's process-shutdown handler also schedules a
            // final group sweep. Join that observed callback before this test
            // admits the next fixture, so a simulated host shutdown cannot kill it.
            let swept!: () => void;
            signalShutdown = new Promise<void>(resolve => { swept = resolve; });
            const schedule = globalThis.setTimeout;
            const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
              schedule(() => { callback(...args); if (delay === 2_000) swept(); }, delay)) as typeof setTimeout);
            try { process.emit('SIGTERM', 'SIGTERM'); }
            finally { timerSpy.mockRestore(); }
          }
        }
        const outcome = await result;
        const task = JSON.parse(readFileSync(receiptPath + '.task.json', 'utf8'));
        const diagnostics = JSON.parse(readFileSync(receiptPath + '.child.json', 'utf8'));
        expect(diagnostics.status).toBe(mode === 'unverified' ? 'incomplete' : 'completed');
        if (mode === 'unverified') expect(diagnostics).toMatchObject({ exitCode: null, signal: null });
        expect(task.budget).toMatchObject({ deadlineEpochMs: mode === 'no-deadline' ? null : deadline,
          cleanupReserveMs: 120_000, childCutoffEpochMs: mode === 'no-deadline' ? null : deadline - 120_000 });
        if (successful) {
          expect(outcome).toEqual({ code: 37, error: null });
          expect(task.budget).toMatchObject({ cutoffTriggeredAtMs: null, childExitVerifiedAtMs: now });
          // A callback already queued at completion cannot cancel a finished run.
          const callback = clock.setTimeout.mock.calls[0]?.[0] as (() => void) | undefined;
          now = deadline; callback?.();
          expect(pending.size).toBe(0);
        } else {
          expect(outcome.error).toBeInstanceOf(Error);
          expect(outcome.error.message).toContain(mode === 'unverified' ? 'exit unverified'
            : mode === 'signal-race' || mode === 'caller-abort' ? 'canceled by SIGTERM' : 'VERIFIER_CHILD_DEADLINE_CUTOFF');
          expect(task.budget.cutoffTriggeredAtMs).toBe(mode === 'caller-abort' ? null : deadline - 120_000);
          expect(task.budget.childExitVerifiedAtMs).toBe(mode === 'unverified' ? null : now);
          expect(outcome.error.exitCode).toBe(mode === 'unverified' ? undefined : mode === 'signal-race' || mode === 'caller-abort' ? 143 : 2);
          if (mode === 'signal-race' || mode === 'caller-abort') expect(task.cancellationSignal).toBe('SIGTERM');
          if (mode !== 'unverified' && existsSync(`/proc/${child.descendant}/stat`))
            expect(readFileSync(`/proc/${child.descendant}/stat`, 'utf8').split(') ')[1]![0]).toMatch(/[ZX]/);
        }
        expect(task.cleanup).toBe(mode === 'unverified' ? 'deferred' : 'completed');
        expect(existsSync(owned!)).toBe(mode === 'unverified');
        expect(readFileSync(join(peer, 'peer-owned'), 'utf8')).toBe('must survive');
        expect(pending.size).toBe(0);
        expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function));
        expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM'), process.listenerCount('SIGHUP')]).toEqual(listeners);
        const phases = readFileSync(receiptPath + '.phases.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(phases.find(row => row.phase === 'child.admission' && row.event === 'completed').budget)
          .toMatchObject({ cleanupReserveMs: 120_000, childCutoffEpochMs: mode === 'no-deadline' ? null : deadline - 120_000 });
        if (!successful) expect(phases.some(row => row.phase === 'deps.postverify')).toBe(false);
        if (mode !== 'unverified') expect(phases.at(-1)).toMatchObject({ phase: 'cleanup', event: 'completed' });
      } finally {
        removeAbortListener.mockRestore();
        killSpy?.mockRestore();
        if (group) { try { kill(-group, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        } }
        await result;
        await signalShutdown;
        if (owned) rmSync(owned, { recursive: true, force: true });
        if (peer) rmSync(peer, { recursive: true, force: true });
      }
    });

  it.each(['snapshot', 'census', 'child', 'sigint', 'sighup', 'sigkill'] as const)(
    'retains plain CLI ownership and truthful cleanup on cancellation during %s', async phase => {
      const fixture = makeSuperproject(join(tmp, 'verifier-cli-cancel-' + phase));
      git(fixture.repo, ['rm', '-r', '--', 'node_modules', 'apps/operator/node_modules']);
      const helper = 'papercusp-desktop/bin/lib/pinned-deps.sh';
      const preflight = 'scripts/source-preview.mjs';
      const provider = 'scripts/cancellation-fixture.mjs';
      write(fixture.repo, DEPENDENCY_POLICY_PATH, DEPENDENCY_POLICY);
      write(fixture.repo, preflight, "console.log(process.argv.includes('verifier-measure') ? '4096' : 'inputs-ok');\n");
      write(fixture.repo, helper, [
        '#!/bin/bash', 'set -eu',
        'if [ "$1" = trees ]; then',
        '  if [ "$VERIFIER_CANCEL_PHASE" = census ]; then printf "%s\\n" "$2" > "$VERIFIER_CANCEL_READY"; sleep 1; fi',
        '  echo node_modules; exit', 'fi',
        'if [ "$VERIFIER_CANCEL_PHASE" = snapshot ] || [ "$VERIFIER_CANCEL_PHASE" = sighup ] || [ "$VERIFIER_CANCEL_PHASE" = sigkill ]; then',
        '  printf "%s\\n" "$3" > "$VERIFIER_CANCEL_READY"; exec sleep 60', 'fi',
        'if [ "$4" = copy ]; then cp -a -- "$2/node_modules" "$3/node_modules"; else cp -al -- "$2/node_modules" "$3/node_modules"; fi',
      ].join('\n') + '\n');
      write(fixture.repo, provider, [
        "import { spawn } from 'node:child_process';",
        "spawn(process.execPath, ['-e', `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(process.env.VERIFIER_CANCEL_READY + '.pid', String(process.pid)); fs.writeFileSync(process.env.VERIFIER_CANCEL_READY, process.cwd()); setInterval(() => {}, 1000);`], { stdio: 'ignore' });",
        "setInterval(() => {}, 1000);",
      ].join('\n'));
      write(fixture.repo, '.gitignore', readFileSync(join(fixture.repo, '.gitignore'), 'utf8') + '\n/.papercusp/scratch/\n');
      git(fixture.repo, ['add', helper, preflight, provider, '.gitignore', DEPENDENCY_POLICY_PATH]);
      git(fixture.repo, ['commit', '-qm', 'plain CLI cancellation fixture']);
      const ref = git(fixture.repo, ['rev-parse', 'HEAD']);
      write(fixture.repo, 'node_modules/@native-proof/runtime/package.json', JSON.stringify({
        name: '@native-proof/runtime', type: 'module', exports: './index.mjs' }));
      write(fixture.repo, 'node_modules/@native-proof/runtime/index.mjs', "export default 'private-snapshot';\n");
      installVerifierTsx(fixture.repo);
      const ready = join(tmp, 'verifier-cli-cancel-ready-' + phase);
      const receiptPath = join(tmp, 'verifier-cli-cancel-source-' + phase + '.json');
      const options = { repo: fixture.repo, ref, receiptPath, inputs: [helper, preflight, provider],
        command: [process.execPath, provider] };
      const cli = new URL('../../../scripts/source-preview.mjs', import.meta.url).href;
      const env = childEnv({ VERIFIER_CANCEL_READY: ready, VERIFIER_CANCEL_PHASE: phase });
      delete env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID;
      const child = spawn(process.execPath, ['--input-type=module', '-e',
        `import { runVerifierCommand } from ${JSON.stringify(cli)}; try { process.exitCode = await runVerifierCommand(${JSON.stringify(options)}); } catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? 1; }`],
      { cwd: fixture.repo, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', bytes => { output += bytes; });
      child.stderr.on('data', bytes => { output += bytes; });
      const closed = once(child, 'close');
      let owned: string | undefined;
      let peer: string | undefined;
      try {
        await vi.waitFor(() => expect(existsSync(ready), output).toBe(true), { timeout: 20_000, interval: 20 });
        owned = dirname(readFileSync(ready, 'utf8').trim());
        const receipt = JSON.parse(readFileSync(receiptPath + '.task.json', 'utf8'));
        expect(receipt).toMatchObject({ schemaVersion: 'verifier-task-v1', taskId: null,
          pid: child.pid, repoRoot: fixture.repo, ownedRoot: owned, cleanup: 'pending' });
        expect(receipt.processIdentity).toBeTypeOf('string');
        expect(receipt.processIdentity.length).toBeGreaterThan(0);
        expect(statSync(receiptPath + '.task.json').mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(join(owned!, '.verifier-task.json'), 'utf8'))).toEqual(receipt);
        peer = mkdtempSync(join(dirname(owned!), 'verifier-command-'));
        writeFileSync(join(peer, 'peer-owned'), 'must survive');
        const signal = phase === 'sigkill' ? 'SIGKILL' : phase === 'sigint' ? 'SIGINT' : phase === 'sighup' ? 'SIGHUP' : 'SIGTERM';
        process.kill(phase === 'sigkill' || phase === 'sighup' ? -child.pid! : child.pid!, signal);
        const result = await closed;
        const final = JSON.parse(readFileSync(receiptPath + '.task.json', 'utf8'));
        if (phase === 'sigkill') {
          expect(result).toEqual([null, 'SIGKILL']);
          expect(final).toEqual(receipt); // A killed finally cannot manufacture cleanup evidence.
          expect(existsSync(owned!)).toBe(true);
        } else {
          expect(result, output).toEqual([phase === 'sigint' ? 130 : phase === 'sighup' ? 129 : 143, null]);
          expect(final).toMatchObject({ ...receipt, cleanup: 'completed', cancellationSignal: signal });
          expect(existsSync(owned!)).toBe(false);
          const phases = readFileSync(receiptPath + '.phases.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line));
          expect(phases.at(-1)).toMatchObject({ phase: 'cleanup', event: 'completed' });
          if (phase !== 'child' && phase !== 'sigint') expect(phases.some(row => row.phase === 'child.run')).toBe(false);
          if (existsSync(ready + '.pid')) {
            const pid = readFileSync(ready + '.pid', 'utf8');
            if (existsSync(`/proc/${pid}/stat`))
              expect(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]![0]).toMatch(/[ZX]/);
          }
        }
        expect(readFileSync(join(peer, 'peer-owned'), 'utf8')).toBe('must survive');
      } finally {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        await closed;
        if (owned) rmSync(owned, { recursive: true, force: true });
        if (peer) rmSync(peer, { recursive: true, force: true });
      }
    });

  it.each([
    ['bash-job', 'spawned', 'repo'], ['bash-job', 'pending', 'repo'],
    ['bash-job', 'spawned', 'data'], ['bash-job', 'pending', 'data'],
    ['test-run', 'spawned', 'repo'], ['test-run', 'pending', 'repo'],
    ['test-run', 'spawned', 'data'], ['test-run', 'pending', 'data'],
  ] as const)('terminal %s close cleans a real SIGKILL with %s enrollment in %s scratch and preserves peers', async (taskClass, enrollment, scratchLocation) => {
    const label = taskClass + '-' + enrollment + '-' + scratchLocation;
    const fixture = makeSuperproject(join(tmp, 'verifier-command-killed-' + label));
    git(fixture.repo, ['rm', '-r', '--', 'node_modules', 'apps/operator/node_modules']);
    const helper = 'papercusp-desktop/bin/lib/pinned-deps.sh';
    write(fixture.repo, helper, '#!/bin/bash\nset -eu\nprintf "%s\\n" "$3" > "$VERIFIER_KILL_READY"\nexec sleep 60\n');
    write(fixture.repo, '.gitignore', readFileSync(join(fixture.repo, '.gitignore'), 'utf8') + '\n/.papercusp/scratch/\n');
    git(fixture.repo, ['add', helper, '.gitignore']);
    git(fixture.repo, ['commit', '-qm', 'kill during verifier preparation']);
    const ref = git(fixture.repo, ['rev-parse', 'HEAD']);
    const ready = join(tmp, 'verifier-kill-ready-' + label), taskId = 'verifierkillfixture';
    const cli = new URL('../../../scripts/source-preview.mjs', import.meta.url).href;
    const options = { repo: fixture.repo, ref, receiptPath: join(tmp, 'verifier-kill-source-' + label + '.json'),
      inputs: [helper], command: [process.execPath, '-e', 'process.exit(0)'] };
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { runVerifierCommand } from ${JSON.stringify(cli)}; process.exitCode = await runVerifierCommand(${JSON.stringify(options)});`],
    { cwd: fixture.repo, detached: true, env: childEnv({
      PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: taskId, VERIFIER_KILL_READY: ready,
    }), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const closed = once(child, 'close');
    const cleanupPaths: string[] = [];
    try {
      await vi.waitFor(() => expect(existsSync(ready), output).toBe(true), { timeout: 15_000, interval: 20 });
      let owned = dirname(readFileSync(ready, 'utf8').trim());
      const receipt = JSON.parse(readFileSync(join(owned, '.verifier-task.json'), 'utf8'));
      expect(receipt).toMatchObject({ taskId, pid: child.pid, repoRoot: fixture.repo });
      expect(statSync(join(owned, '.verifier-task.json')).mode & 0o777).toBe(0o600);
      process.kill(-child.pid!, 'SIGKILL');
      expect(await closed).toEqual([null, 'SIGKILL']);
      expect(existsSync(owned)).toBe(true); // The killed process's finally never ran.
      const phases = readFileSync(options.receiptPath + '.phases.jsonl', 'utf8').trim()
        .split('\n').map(line => JSON.parse(line));
      expect(phases.at(-1)).toMatchObject({ phase: 'deps.snapshot', event: 'started', taskId });
      expect(phases.some(row => row.phase === 'child.run')).toBe(false);
      if (scratchLocation === 'repo') {
        // Older invocations used repository-local scratch. Preserve recovery
        // coverage for those receipts as well as the current external root.
        const legacyScratch = join(fixture.repo, '.papercusp/scratch');
        mkdirSync(legacyScratch, { recursive: true });
        const relocated = mkdtempSync(join(legacyScratch, 'verifier-command-'));
        cleanupPaths.push(relocated);
        cpSync(owned, relocated, { recursive: true, verbatimSymlinks: true });
        rmSync(owned, { recursive: true, force: true });
        owned = relocated;
      }
      const scratch = dirname(owned);
      const peer = mkdtempSync(join(scratch, 'verifier-command-'));
      cleanupPaths.push(peer);
      writeFileSync(join(peer, '.verifier-task.json'), JSON.stringify({ ...receipt, taskId: 'peer-task' }));
      const live = mkdtempSync(join(scratch, 'verifier-command-'));
      cleanupPaths.push(live);
      writeVerifierTaskReceipt(live, fixture.repo, { PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: taskId });
      const link = join(scratch, 'verifier-command-link-' + label);
      cleanupPaths.push(link);
      symlinkSync(peer, link, 'dir');
      const scopeUnit = 'pc-verifierkillfixture.' + (taskClass === 'test-run' ? 'scope' : 'service');
      const classSlice = taskClass === 'test-run' ? 'papercusp-test.slice/papercusp-test-run.slice/'
        : 'papercusp-bash.slice/papercusp-bash-job.slice/';
      const cgroupPath = '/papercusp.slice/' + classSlice + scopeUnit;
      // Model the payload's kernel membership independently of the asynchronous
      // markSpawned write. The real killed process above supplies the death proof.
      const ownedReceipt = { ...receipt, cgroupPath };
      const row = { task_id: taskId, workspace_id: 'fixture-workspace', root_task_id: taskId,
        class: taskClass, cwd: fixture.repo, confined: enrollment === 'spawned',
        state: enrollment === 'spawned' ? 'running' : 'pending', scope_unit: scopeUnit,
        cgroup_path: enrollment === 'spawned' ? cgroupPath : null,
        argv: [], launched_by: 'fixture', ended_at: null };
      const cleanupRow = { taskId, class: taskClass, confined: true, cwd: fixture.repo,
        scopeUnit, cgroupPath } as TaskRow;
      for (const changed of [{ taskId: 'other-task' }, { confined: false },
        { scopeUnit: 'wrong-scope.service' }, { cgroupPath: null }]) {
        await cleanupEndedVerifierDirectories({ ...cleanupRow, ...changed });
        expect(existsSync(owned)).toBe(true);
      }
      const receiptPath = join(owned, '.verifier-task.json');
      const receiptCopy = join(tmp, 'verifier-kill-ownership.json');
      writeFileSync(receiptCopy, JSON.stringify(receipt));
      rmSync(receiptPath);
      symlinkSync(receiptCopy, receiptPath);
      await cleanupEndedVerifierDirectories(cleanupRow);
      expect(existsSync(owned)).toBe(true);
      rmSync(receiptPath);
      if (enrollment === 'pending') {
        const pending = { ...cleanupRow, confined: false, cgroupPath: null, state: 'pending' } as TaskRow;
        for (const kernelPath of [null, '/unconfined/' + scopeUnit,
          cgroupPath.replace(taskId, 'peertask'), cgroupPath + '/../../pc-peertask.service']) {
          writeFileSync(receiptPath, JSON.stringify({ ...ownedReceipt, cgroupPath: kernelPath }));
          await cleanupEndedVerifierDirectories(pending);
          expect(existsSync(owned)).toBe(true);
        }
      }
      writeFileSync(receiptPath, JSON.stringify(ownedReceipt));
      let updated = false;
      const sql = (async (strings: TemplateStringsArray) => {
        if (strings.join('').includes('UPDATE harness_shared.task_ledger')) {
          expect(existsSync(owned)).toBe(false); // Cleanup precedes terminal persistence.
          updated = true;
        }
        return [row];
      }) as unknown as Sql;
      await expect(closeTask(taskId, { state: 'killed', exitCode: 137 }, sql,
        { emitTerminal: vi.fn() })).resolves.toBe(true);
      expect(updated).toBe(true);
      expect(existsSync(peer)).toBe(true);
      expect(existsSync(live)).toBe(true);
      expect(existsSync(link)).toBe(true);
      await cleanupEndedVerifierDirectories({ taskId, class: taskClass, confined: true,
        cwd: fixture.repo, scopeUnit: row.scope_unit, cgroupPath: row.cgroup_path } as TaskRow);
      expect(existsSync(peer)).toBe(true);
    } finally {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await closed;
      for (const path of cleanupPaths) rmSync(path, { recursive: true, force: true });
    }
  });

  it('refuses dirty inputs before running any provider command and rejects missing CLI commands', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-command-dirty'));
    write(fixture.repo, '.gitignore', readFileSync(join(fixture.repo, '.gitignore'), 'utf8') + '\n/.papercusp/scratch/\n');
    git(fixture.repo, ['add', '.gitignore']); git(fixture.repo, ['commit', '-qm', 'ignored verifier scratch']);
    const ref = git(fixture.repo, ['rev-parse', 'HEAD']);
    const input = 'apps/operator/src/index.ts';
    writeFileSync(join(fixture.repo, input), 'dirty before provider allocation');
    const marker = join(tmp, 'refused-provider-marker');
    const receiptPath = join(tmp, 'refused-provider-receipt.json');
    await expect(runVerifierCommand({ repo: fixture.repo, ref, inputs: [input], receiptPath,
      command: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "allocated")', marker] }))
      .rejects.toThrow('dirty tested-input mismatch: ' + input);
    expect(existsSync(marker)).toBe(false); expect(existsSync(receiptPath)).toBe(false);
    expect(existsSync(join(fixture.repo, '.papercusp/scratch'))).toBe(false);
    const phases = readFileSync(receiptPath + '.phases.jsonl', 'utf8').trim()
      .split('\n').map(line => JSON.parse(line));
    expect(phases.find(row => row.event === 'failed')).toMatchObject({
      phase: 'source.freeze', error: expect.stringContaining('dirty tested-input mismatch'),
    });
    expect(phases.some(row => row.phase === 'deps.snapshot' || row.phase === 'child.run')).toBe(false);
    expect(phases.at(-1)).toMatchObject({ phase: 'cleanup', event: 'completed' });
    const retained = readFileSync(receiptPath + '.phases.jsonl', 'utf8');
    await expect(runVerifierCommand({ repo: fixture.repo, ref, inputs: [input], receiptPath,
      command: [process.execPath, '-e', 'process.exit(0)'] })).rejects.toThrow('EEXIST');
    expect(readFileSync(receiptPath + '.phases.jsonl', 'utf8')).toBe(retained);
    expect(existsSync(join(fixture.repo, '.papercusp/scratch'))).toBe(false);
    await expect(runCli(['verifier-run', '--repo', fixture.repo, '--ref', ref, '--receipt', receiptPath,
      '--inputs', input, '--'])).rejects.toThrow('and -- <command>');
  });

  it('preserves unlisted gitlinks and original named mappings in a real verifier checkout', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-unlisted-fixture'));
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const unlisted = 'apps/unlisted';
    git(fixture.repo, ['clone', '--quiet', '--shared', '--', fixture.subSrc, unlisted]);
    git(fixture.repo, ['update-index', '--add', '--cacheinfo', `160000,${fixture.subCommit},${unlisted}`]);
    git(fixture.repo, ['commit', '-m', 'unlisted verifier gitlink']);
    const mappings = readFileSync(join(fixture.repo, '.gitmodules'));
    const head = git(fixture.repo, ['rev-parse', 'HEAD']);
    const archive = await prepareVerifierSource({ repo: fixture.repo, ref: head,
      dest: join(tmp, 'verifier-unlisted-archive'), inputs: [input] });
    const dest = join(tmp, 'verifier-unlisted-checkout');
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: head,
      dest, inputs: [input], gitCheckout: true });
    expect(receipt.files).toEqual(archive.files);
    expect(receipt.submodules).toEqual(archive.submodules);
    expect(readFileSync(join(dest, '.gitmodules'))).toEqual(mappings);
    expect(git(join(dest, unlisted), ['rev-parse', 'HEAD'])).toBe(fixture.subCommit);
    expect(git(dest, ['ls-files', '--recurse-submodules'])).toContain('libs/papercusp/package.json');
    expect(git(dest, ['config', '--get-regexp', '^submodule\\..*\\.url$'])).not.toContain(unlisted);
    await expect(verifyVerifierSource(dest, receipt)).resolves.toEqual(receipt);
    git(join(dest, unlisted), ['rm', '--cached', '--', 'package.json']);
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('tampered verification Git checkout');
  });

  it('prepares a real verifier checkout from a relative repository path', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-relative-repo-fixture'));
    git(fixture.repo, ['commit', '--allow-empty', '-m', 'with parent']);
    const head = git(fixture.repo, ['rev-parse', 'HEAD']);
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const dest = join(tmp, 'verifier-relative-repo-checkout');
    const receipt = await prepareVerifierSource({
      repo: relative(process.cwd(), fixture.repo), ref: head, dest,
      inputs: [input], gitCheckout: true,
    });
    expect(git(dest, ['rev-parse', 'HEAD'])).toBe(head);
    expect(readFileSync(join(dest, input))).toEqual(readFileSync(join(fixture.repo, input)));
    await expect(verifyVerifierSource(dest, receipt)).resolves.toEqual(receipt);
  });

  it('refuses an unreadable parent or submodule checkout before verification runs', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-checkout-parent-fixture'));
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const noParent = join(tmp, 'verifier-checkout-no-parent');
    await expect(prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest: noParent,
      inputs: [input], gitCheckout: true })).rejects.toThrow('HEAD^');
    expect(existsSync(noParent)).toBe(false);

    git(fixture.repo, ['commit', '--allow-empty', '-m', 'with parent']);
    const dest = join(tmp, 'verifier-checkout-submodule');
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: 'HEAD', dest, inputs: [input], gitCheckout: true });
    const submodule = receipt.submodules[0];
    writeFileSync(join(dest, submodule.path, '.git', 'HEAD'), 'invalid checkout identity\n');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('verification Git');
  });

  it('refuses an older committed tested input and cleans the incomplete export', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-dirty-fixture'));
    const dest = join(tmp, 'verifier-dirty-export');
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    writeFileSync(join(fixture.repo, input), 'uncommitted acceptance change');
    await expect(prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] }))
      .rejects.toThrow('dirty tested-input mismatch');
    expect(existsSync(dest)).toBe(false);
  });

  it.each([false, true])('refuses dirty input before materialization (gitCheckout=%s)', async (gitCheckout) => {
    const fixture = makeSuperproject(join(tmp, `verifier-early-dirty-${gitCheckout}`));
    const dest = join(tmp, `verifier-early-dirty-export-${gitCheckout}`);
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    writeFileSync(join(fixture.repo, input), 'uncommitted acceptance change');
    // An archive/clone would encounter this unrelated broken checkout first.
    // The dirty-input diagnostic must win without creating the destination.
    rmSync(join(fixture.repo, 'libs/papercusp/.git'), { recursive: true, force: true });
    const mkdir = vi.spyOn(fsPromises, 'mkdir');
    try {
      await expect(prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit,
        dest, inputs: [input], gitCheckout })).rejects.toThrow('dirty tested-input mismatch');
      expect(mkdir.mock.calls.some(([path]) => path === dest)).toBe(false);
      expect(existsSync(dest)).toBe(false);
    } finally {
      mkdir.mockRestore();
    }
  });

  it('refuses missing, altered provenance and extra archive files', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-provenance-fixture'));
    const dest = join(tmp, 'verifier-provenance-export');
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    await expect(verifyVerifierSource(dest, undefined as never)).rejects.toThrow('missing verification source provenance');
    writeFileSync(join(dest, '.verifier-source.json'), '{}');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('tampered verification source provenance');
    writeFileSync(join(dest, '.verifier-source.json'), JSON.stringify(receipt));
    writeFileSync(join(dest, 'extra.ts'), 'unexpected');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('tampered verification source archive: added extra.ts');
  });

  it('never excludes recorded files under runtime directories from the source verdict', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-runtime-recorded-fixture'));
    const dest = join(tmp, 'verifier-runtime-recorded-export');
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    const recorded = receipt.files.find(file => file.path.startsWith('node_modules/'))!;
    expect(recorded).toBeDefined();
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
    writeFileSync(join(dest, recorded.path), 'changed recorded dependency source');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow('tampered verification source archive');
  });

  it('rebuilds committed verifier output separately while still rejecting source tampering', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-committed-bundle-fixture'));
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const output = 'apps/operator/dist-verify/hono-host.mjs';
    write(fixture.repo, output, 'old generated host');
    git(fixture.repo, ['add', output]);
    git(fixture.repo, ['commit', '-qm', 'record generated host']);
    const dest = join(tmp, 'verifier-committed-bundle-export');
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: 'HEAD', dest, inputs: [input] });
    expect(receipt.files.some(file => file.path.startsWith('apps/operator/dist-verify/'))).toBe(false);
    expect(existsSync(join(dest, output))).toBe(false);
    write(dest, output, 'rebuilt private host');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
    writeFileSync(join(dest, input), 'tampered source');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow(`changed ${input}`);
    await expect(prepareVerifierSource({ repo: fixture.repo, ref: 'HEAD', dest: join(tmp, 'refused-runtime-input'), inputs: [output] }))
      .rejects.toThrow('generated verifier runtime output cannot be a tested source input');
    await expect(prepareVerifierSource({ repo: fixture.repo, ref: 'HEAD', dest: join(tmp, 'refused-runtime-checkout'), inputs: [input], gitCheckout: true }))
      .rejects.toThrow('committed verifier runtime output requires archive export');
  });

  it('rejects a symlink posing as an independent runtime directory', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-runtime-link-fixture'));
    const dest = join(tmp, 'verifier-runtime-link-export');
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    symlinkSync(join(dest, 'apps/operator/src'), join(dest, 'apps/operator/dist-verify'));
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow('runtime artifact is not an independent directory');
  });

  it('allows an unrecorded generated router tree only for runtime source attestation', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-router-runtime-fixture'));
    const dest = join(tmp, 'verifier-router-runtime-export');
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    write(dest, 'apps/operator-vite/src/routeTree.gen.ts', 'generated from recorded routes');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('added apps/operator-vite/src/routeTree.gen.ts');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
    writeFileSync(join(dest, input), 'changed recorded route source');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow(`changed ${input}`);
  });

  it('allows only the exact unrecorded Vitest result cache during runtime source attestation', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-vitest-cache-fixture'));
    const dest = join(tmp, 'verifier-vitest-cache-export');
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    write(dest, VITEST_RESULT_CACHE, '{"results":[]}');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow(`added ${VITEST_RESULT_CACHE}`);
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
    const unexpected = VITEST_RESULT_CACHE.replace('results.json', 'extra.ts');
    write(dest, unexpected, 'export const unexpected = true;');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow(`added ${unexpected}`);
  });

  it('rejects result cache paths outside the Vitest hash namespace', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-vitest-cache-invalid-fixture'));
    const dest = join(tmp, 'verifier-vitest-cache-invalid-export');
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    const unexpected = 'packages/operator-core/.vitest-tmp/vitest/not-a-hash/results.json';
    write(dest, unexpected, '{"results":[]}');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow(`added ${unexpected}`);
  });

  it('allows SPA prebuild mirrors through the later host source census without hiding public source', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-spa-runtime-fixture'));
    const dest = join(tmp, 'verifier-spa-runtime-export');
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    for (const artifact of SPA_RUNTIME_FILES) write(dest, artifact, 'generated SPA runtime asset');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('tampered verification source archive');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
    for (const unexpected of [
      'apps/operator/public/unexpected.js',
      'apps/operator/public/ort-wasm-unexpected.ts',
      'apps/operator/public/silero_vad_unexpected.onnx',
      'apps/operator/public/excalidraw-extra/chunk.js',
    ]) {
      write(dest, unexpected, 'unexpected source');
      await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow(`added ${unexpected}`);
      rmSync(join(dest, unexpected));
    }
    writeFileSync(join(dest, input), 'changed recorded source');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow(`changed ${input}`);
  });

  it.each(['apps/operator-vite/src/routeTree.gen.ts', '.papercusp-pinned-deps', 'libs/generic/sse/dist/index.js', 'packages/omp-plugin/dist/native-extension.mjs', VITEST_RESULT_CACHE, ...NATIVE_RUNTIME_FILES, ...SPA_RUNTIME_FILES])('never excludes recorded output from source attestation: %s', async input => {
    const suffix = input.replaceAll('/', '-');
    const fixture = makeSuperproject(join(tmp, `verifier-output-recorded-${suffix}`));
    write(fixture.repo, input, 'recorded route tree');
    git(fixture.repo, ['add', input]);
    git(fixture.repo, ['commit', '-qm', 'recorded route tree fixture']);
    const ref = git(fixture.repo, ['rev-parse', 'HEAD']).trim();
    const dest = join(tmp, `verifier-output-recorded-export-${suffix}`);
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref, dest, inputs: [input] });
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
    writeFileSync(join(dest, input), 'changed recorded route tree');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow(`changed ${input}`);
  });

  it('accepts unrecorded pinned dependency output while still detecting recorded source changes', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-pinned-output-fixture'));
    const input = 'libs/generic/sse/src/index.ts';
    write(fixture.repo, input, 'export const source = true;');
    git(fixture.repo, ['add', input]);
    git(fixture.repo, ['commit', '-qm', 'pinned runtime source fixture']);
    const ref = git(fixture.repo, ['rev-parse', 'HEAD']).trim();
    const dest = join(tmp, 'verifier-pinned-output-export');
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref, dest, inputs: [input] });
    write(dest, '.papercusp-pinned-deps', 'immutable dependency receipt');
    write(dest, 'libs/generic/sse/dist/index.js', 'export const source = true;');
    write(dest, 'packages/omp-plugin/dist/native-extension.mjs', 'export const source = true;');
    for (const artifact of NATIVE_RUNTIME_FILES) write(dest, artifact, 'generated native build output');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('added .papercusp-pinned-deps');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
    writeFileSync(join(dest, input), 'changed recorded source');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow(`changed ${input}`);
  });

  it.each(['.papercusp-pinned-deps', 'libs/generic/sse/dist', 'packages/omp-plugin/dist', 'papercusp-desktop/src-tauri/gen/schemas', VITEST_RESULT_CACHE, ...NATIVE_RUNTIME_FILES.filter(path => path.endsWith('PLACEHOLDER-README.txt') || path.endsWith('sidecar.lock')), ...new Set(SPA_RUNTIME_FILES.map(path => path.split('/').slice(0, 4).join('/')))])('rejects a redirect posing as runtime output: %s', async artifact => {
    const fixture = makeSuperproject(join(tmp, `verifier-output-link-${artifact.replaceAll('/', '-')}`));
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const dest = join(tmp, `verifier-output-link-export-${artifact.replaceAll('/', '-')}`);
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    write(dest, artifact, 'placeholder');
    rmSync(join(dest, artifact));
    symlinkSync(join(dest, input), join(dest, artifact));
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow('runtime artifact is not an independent');
  });

  it('rejects a symlink posing as an unrecorded generated router tree', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-router-link-fixture'));
    const dest = join(tmp, 'verifier-router-link-export');
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    write(dest, 'apps/operator-vite/src/routeTree.gen.ts', 'placeholder');
    rmSync(join(dest, 'apps/operator-vite/src/routeTree.gen.ts'));
    symlinkSync(join(dest, input), join(dest, 'apps/operator-vite/src/routeTree.gen.ts'));
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow('runtime artifact is not an independent file');
  });

  it('refuses incomplete icon ESM content before verifier input admission and accepts restored content', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-incomplete-icon-content'));
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    write(fixture.repo, 'package-lock.json', JSON.stringify({
      packages: { 'node_modules/react-icons': { version: '5.6.0' } },
    }));
    write(fixture.repo, 'node_modules/react-icons/package.json', JSON.stringify({
      name: 'react-icons', exports: { './ai': './ai/index.mjs' },
    }));
    write(fixture.repo, 'node_modules/react-icons/ai/index.mjs', "export { IconBase } from '../lib/index.mjs';");
    const args = ['verifier-inputs-check', '--repo', fixture.repo, '--ref', fixture.commit, '--inputs', input];
    await expect(runCli(args)).rejects.toThrow(/RUNTIME_DEPS_UNUSABLE[\s\S]*react-icons\/ai/);
    write(fixture.repo, 'node_modules/react-icons/lib/index.mjs', 'export const IconBase = {};');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try { expect(await runCli(args)).toBe(0); }
    finally { output.mockRestore(); }
  });

  it('checks committed inputs without allocating a snapshot and rejects later source edits', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-input-check-fixture'));
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    const before = readdirSync(tmp).sort();
    const result = await validateVerifierInputs({ repo: fixture.repo, ref: fixture.commit, inputs: [input] });
    expect(result.sha).toBe(fixture.commit);
    expect(result.paths).toEqual([input]);
    expect(readdirSync(tmp).sort()).toEqual(before);
    writeFileSync(join(fixture.repo, input), 'changed after commit');
    await expect(validateVerifierInputs({ repo: fixture.repo, ref: fixture.commit, inputs: [input] }))
      .rejects.toThrow(`dirty tested-input mismatch: ${input}`);
    expect(readdirSync(tmp).sort()).toEqual(before);
  });

  it('shares native tooling validation with preparation and refuses drift before allocating', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-tauri-inputs-fixture'));
    for (const path of TAURI_VERIFIER_INPUTS) write(fixture.repo, path, `// ${path}\n`);
    git(fixture.repo, ['add', ...TAURI_VERIFIER_INPUTS]);
    git(fixture.repo, ['commit', '-qm', 'native tooling inputs']);
    const ref = git(fixture.repo, ['rev-parse', 'HEAD']);
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const inputsFile = join(tmp, 'verifier-tauri-inputs.json');
    writeFileSync(inputsFile, JSON.stringify([input]));
    const options = { repo: fixture.repo, ref, inputsFile, tauriInputs: true };
    const checked = await validateVerifierInputs(options);
    expect(checked.paths).toEqual([...new Set([input, ...TAURI_VERIFIER_INPUTS])].sort());
    const dest = join(tmp, 'verifier-tauri-inputs-export');
    const receipt = await prepareVerifierSource({ ...options, dest });
    expect(receipt.testedInputs.map(row => row.path)).toEqual(checked.paths);

    for (const [index, helper] of [
      'apps/operator/bin/release/dependency-generation.sh',
      'packages/operator-core/lib/testing-native-runtime.ts',
      'packages/operator-core/lib/testing-playwright-reporter.ts',
      'scripts/lib/run-in-isolated-netns.sh',
    ].entries()) {
      writeFileSync(join(fixture.repo, helper), 'changed native tooling after commit');
      const refused = join(tmp, `verifier-tauri-inputs-refused-${index}`);
      await expect(validateVerifierInputs(options)).rejects.toThrow(`dirty tested-input mismatch: ${helper}`);
      await expect(prepareVerifierSource({ ...options, dest: refused }))
        .rejects.toThrow(`dirty tested-input mismatch: ${helper}`);
      expect(existsSync(refused)).toBe(false);
      writeFileSync(join(fixture.repo, helper), `// ${helper}\n`);
    }
    await expect(validateVerifierInputs({ repo: fixture.repo, ref, tauriInputs: true }))
      .rejects.toThrow('verification export needs explicit tested inputs');
  });

  it('refuses tracked source symlinks that read outside the immutable export', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-link-fixture'));
    symlinkSync('/tmp/live-peer-source.ts', join(fixture.repo, 'outside-source'));
    git(fixture.repo, ['add', 'outside-source']);
    git(fixture.repo, ['commit', '-qm', 'outside source fixture']);
    const dest = join(tmp, 'verifier-link-export');
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    await expect(prepareVerifierSource({ repo: fixture.repo, ref: 'HEAD', dest, inputs: [input] }))
      .rejects.toThrow('archive symlink escapes source root');
    expect(existsSync(dest)).toBe(false);
  });
});

describe('BG inherited manifest and original source boundaries', () => {
  const inputs = BG_INPUTS;
  const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  let serial = 0;

  function candidate() {
    return makeBgCandidate(join(tmp, `bg-source-${++serial}`));
  }

  it('preserves inherited literal inputs and recursive pins while unrelated canonical source changes', async () => {
    const c = candidate();
    write(c.fixture.repo, 'docs/architecture.md', 'unrelated canonical change');
    const prepared = await prepareBgVerifierSource(c.options);
    const original = readFileSync(join(prepared.root, '.verifier-source.json'));
    writeFileSync(join(c.fixture.repo, inputs[0]!), 'canonical source changed after selection');
    expect(verifyBgVerifierSource(prepared, 'before-build')).toBe(prepared);
    expect(verifyBgVerifierSource(prepared, 'before-publication')).toBe(prepared);
    expect(readFileSync(join(prepared.root, '.verifier-source.json'))).toEqual(original);
    expect(prepared.source.submodules).toContainEqual({ path: 'libs/papercusp', sha: c.fixture.subCommit });
    expect(Object.isFrozen(prepared.source.files[0])).toBe(true);
    c.options.acceptedManifest.members[inputs[0]!] = 'f'.repeat(40);
    expect(prepared.acceptedManifest.members[inputs[0]!]).not.toBe('f'.repeat(40));
  });

  it.each(['absent', 'unknown', 'digest', 'schema', 'literal-member', 'source-blob'] as const)(
    'refuses %s parent authority before creating a candidate', async defect => {
      const c = candidate();
      if (defect === 'absent') c.options.acceptedManifest = undefined as never;
      if (defect === 'unknown') c.options.acceptedManifest.evidenceRef = 'UNKNOWN';
      if (defect === 'digest') c.options.acceptedManifest.sha256 = '0'.repeat(64);
      if (defect === 'schema') c.options.acceptedManifest.schemaVersion = 2 as never;
      if (defect === 'literal-member') delete c.options.acceptedManifest.members[inputs[0]!];
      if (defect === 'source-blob') {
        c.options.acceptedManifest.members[inputs[0]!] = 'f'.repeat(40);
        const bytes = JSON.stringify({ schemaVersion: 1, sourceBlobs: c.options.acceptedManifest.members });
        writeFileSync(c.options.acceptedManifest.path, bytes);
        c.options.acceptedManifest.sha256 = digest(bytes);
      }
      await expect(prepareBgVerifierSource(c.options)).rejects.toThrow(/BG/);
      expect(existsSync(c.options.dest)).toBe(false);
    });

  const boundaries = ['before-build', 'before-publication'] as const;
  const changes = ['changed', 'missing', 'added'] as const;
  async function sourceDefect(boundary: typeof boundaries[number], defect: typeof changes[number]) {
    const c = candidate();
    const prepared = await prepareBgVerifierSource(c.options);
    expect(verifyBgVerifierSource(prepared, boundary)).toBe(prepared);
    if (defect === 'changed') writeFileSync(join(prepared.root, inputs[0]!), 'substituted selected source');
    if (defect === 'missing') rmSync(join(prepared.root, inputs[0]!));
    if (defect === 'added') write(prepared.root, 'packages/core/unaccepted.ts', 'added source');
    expect(() => verifyBgVerifierSource(prepared, boundary)).toThrow(/tampered verification/);
    expect(existsSync(c.options.acceptedManifest.path)).toBe(true);
  }

  it(BG_R1_PARENT_SELECTORS.source.testName, async () => {
    for (const boundary of boundaries) for (const defect of changes) await sourceDefect(boundary, defect);
  });
  for (const { boundary, defect, testName } of BG_R1_SOURCE_CASES) {
    it(testName,
      () => sourceDefect(boundary, defect));
  }

  it.each(['omitted', 'added'] as const)('rejects %s accepted inputs before destination allocation', async defect => {
    const c = candidate();
    const wrong = { ...c.options, inputs: defect === 'omitted' ? inputs.slice(1) : [...inputs, 'package.json'] };
    await expect(prepareBgVerifierSource(wrong)).rejects.toThrow('BG accepted input membership mismatch');
    expect(existsSync(wrong.dest)).toBe(false);
  });

  async function memberDefect(boundary: typeof boundaries[number], defect: 'omitted' | 'added') {
    const c = candidate();
    const prepared = await prepareBgVerifierSource(c.options);
    expect(verifyBgVerifierSource(prepared, boundary)).toBe(prepared);
    // Simulate a replaced attempt record; the original retained manifest and
    // receipt still forbid either an omitted or an added literal member.
    const members = { ...prepared.acceptedManifest.members };
    if (defect === 'omitted') delete members[inputs[0]!];
    else members['package.json'] = git(c.fixture.repo, ['rev-parse', `${c.options.ref}:package.json`]);
    const replaced = { ...prepared, acceptedManifest: { ...prepared.acceptedManifest, members } };
    expect(() => verifyBgVerifierSource(replaced, boundary)).toThrow('BG parent manifest literal membership mismatch');
  }

  it(BG_R1_PARENT_SELECTORS.members.testName, async () => {
    for (const boundary of boundaries) for (const defect of ['omitted', 'added'] as const)
      await memberDefect(boundary, defect);
  });
  for (const { boundary, defect, testName } of BG_R1_MEMBER_CASES) {
    it(testName,
      () => memberDefect(boundary, defect));
  }

  it('rejects original receipt replacement and source Git index drift without restamping', async () => {
    for (const defect of ['receipt', 'index', 'parent-evidence']) {
      const c = candidate();
      const prepared = await prepareBgVerifierSource(c.options);
      const receipt = join(prepared.root, '.verifier-source.json');
      const original = readFileSync(receipt);
      if (defect === 'receipt') writeFileSync(receipt, String(original).trim());
      if (defect === 'index') git(prepared.root, ['rm', '--cached', '--', inputs[0]!]);
      if (defect === 'parent-evidence') writeFileSync(c.options.acceptedManifest.path, '{}');
      expect(() => verifyBgVerifierSource(prepared, 'before-publication')).toThrow();
      if (defect !== 'receipt') expect(readFileSync(receipt)).toEqual(original);
    }
  });

  function bgFixtureTrace(stage: string, enabled = Boolean(process.env.PAPERCUSP_BG_LOGICAL_TRACE)) {
    if (enabled)
      process.stderr.write(`BG_FIXTURE_STAGE ${JSON.stringify({ stage, at: Date.now() })}\n`);
  }

  function expectBgChild(child: SpawnSyncReturns<string>, phases = '') {
    const childError = child.error as NodeJS.ErrnoException | undefined;
    const diagnostics = {
      status: child.status,
      signal: child.signal,
      error: childError ? {
        name: childError.name,
        message: childError.message,
        code: childError.code ?? null,
        errno: childError.errno ?? null,
        syscall: childError.syscall ?? null,
        path: childError.path ?? null,
      } : null,
      stderr: child.stderr,
      phases,
    };
    expect({ status: child.status, signal: child.signal, error: child.error ?? null, stderr: child.stderr },
      `BG child failure diagnostics:\n${JSON.stringify(diagnostics, null, 2)}`)
      .toEqual({ status: 0, signal: null, error: null, stderr: '' });
  }

  it('BG recipe child assertion preserves spawnSync error, signal, and phase evidence', () => {
    const phases = 'phase=bg.compiler.build event=failed';
    const child = {
      pid: 123,
      output: [],
      stdout: '',
      stderr: '',
      status: null,
      signal: 'SIGTERM',
      error: Object.assign(new Error('spawnSync bash ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    } satisfies SpawnSyncReturns<string>;
    let failure: unknown;
    try { expectBgChild(child, phases); } catch (error) { failure = error; }
    const message = String(failure);
    expect(message).toContain('"status": null');
    expect(message).toContain('"signal": "SIGTERM"');
    expect(message).toContain('"code": "ETIMEDOUT"');
    expect(message).toContain('"message": "spawnSync bash ETIMEDOUT"');
    expect(message).toContain(phases);
  });

  it('retains bounded dependency cache progress and rejects invalid extensions', async () => {
    const path = join(tmp, 'dependency-cache-progress.phases.jsonl');
    const run = verifierPhaseRunner(path,
      { ...process.env, PAPERCUSP_CHECKPOINT_LOG_DIR: join(tmp, 'cache-progress-archive') }, path + '.child.json');
    const progress = { completedTrees: 1, totalTrees: 1, currentTree: 'node_modules' };
    await run('deps.census', () => {
      for (const cacheHit of [false, true]) run.reportProgress?.('deps.census', { ...progress, cacheHit });
      run.reportProgress?.('deps.census', progress);
      expect(() => run.reportProgress?.('deps.census', { ...progress, completedTrees: 2 })).toThrow('Invalid verifier dependency progress');
      expect(() => run.reportProgress?.('deps.census', { ...progress, cacheHit: 'yes' } as never)).toThrow('cacheHit must be boolean');
      expect(() => run.reportProgress?.('deps.census', { ...progress, extra: 'unbounded' } as never)).toThrow('must remain bounded');
    });
    const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.filter(row => row.event === 'progress').map(row => row.progress)).toEqual([
      { ...progress, cacheHit: false }, { ...progress, cacheHit: true }, progress,
    ]);
    expect(readVerifierPhaseMeasurements(path)).toEqual({ 'deps.census': expect.any(Number) });
    for (const invalid of [
      { ...progress, completedTrees: 2 },
      { ...progress, cacheHit: 'yes' },
      { ...progress, extra: 'unbounded' },
    ]) {
      const altered = rows.map(row => row.event === 'progress' ? { ...row, progress: invalid } : row);
      writeFileSync(path, altered.map(row => JSON.stringify(row)).join('\n') + '\n');
      expect(() => readVerifierPhaseMeasurements(path)).toThrow();
    }
  });

  function bgRecipePhaseRunner(label: string) {
    const traceEnabled = Boolean(process.env.PAPERCUSP_BG_LOGICAL_TRACE);
    const path = join(tmp, label + '.phases.jsonl');
    const retained = verifierPhaseRunner(path,
      { ...process.env, PAPERCUSP_CHECKPOINT_LOG_DIR: join(tmp, 'bg-phase-archive') }, path + '.child.json');
    return async function runPhase<T>(phase: string, operation: () => T | Promise<T>) {
      bgFixtureTrace(phase + ':started', traceEnabled);
      try {
        const result = await retained(phase, operation);
        bgFixtureTrace(phase + ':completed', traceEnabled);
        return result;
      } catch (error) { bgFixtureTrace(phase + ':failed', traceEnabled); throw error; }
    };
  }

  it('BG compiler phase trace retains original diagnostic intent after environment replacement', async () => {
    const originalEnv = process.env;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      process.env = { ...originalEnv, PAPERCUSP_BG_LOGICAL_TRACE: '1' };
      const runPhase = bgRecipePhaseRunner('compiler-environment-trace');
      process.env = {}; // The private compiler receives only its recorded environment.
      await expect(runPhase('bg.compiler.import', () => 'compiler-result')).resolves.toBe('compiler-result');
      const stages = stderr.mock.calls.map(([chunk]) => String(chunk))
        .filter(line => line.startsWith('BG_FIXTURE_STAGE '))
        .map(line => JSON.parse(line.slice('BG_FIXTURE_STAGE '.length)).stage);
      expect(stages).toEqual(['bg.compiler.import:started', 'bg.compiler.import:completed']);
      const rows = readFileSync(join(tmp, 'compiler-environment-trace.phases.jsonl'), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line));
      expect(rows.map(row => ({ phase: row.phase, event: row.event }))).toEqual([
        { phase: 'bg.compiler.import', event: 'started' },
        { phase: 'bg.compiler.import', event: 'completed' },
      ]);
    } finally { process.env = originalEnv; stderr.mockRestore(); }
  });

  async function compilerCandidate(artifactInputs = false, cliHarness = false) {
    return makeBgCompilerCandidate(join(tmp, `bg-source-${++serial}`), { artifactInputs, cliHarness, trace: bgFixtureTrace });
  }

  it('bg-r1-compiler-resolver-metadata-transient-restored refuses publication after real resolution used changed package metadata then restored it', async () => {
    const { prepared } = await compilerCandidate();
    const metadata = join(prepared.root, 'node_modules/fixture-dependency/package.json');
    const original = readFileSync(metadata);
    write(prepared.root, 'node_modules/fixture-dependency/alternate.js', 'export default 99;\n');
    const dependencies = captureVerifierDependencies({ dest: prepared.root, receipt: prepared.source });
    const custody = createBgVerifierCompilerCustody({ prepared, dependencies });
    const { build } = await import('esbuild');
    let substituted = false, restored = false;
    const result = await build({ absWorkingDir: prepared.root, entryPoints: [inputs[0]!], bundle: true,
      format: 'esm', platform: 'node', write: false, logLevel: 'silent',
      plugins: [custody.plugin, { name: 'independent-transient-resolver-metadata', setup(builder) {
        builder.onResolve({ filter: /^fixture-dependency$/ }, () => {
          writeFileSync(metadata, '{"name":"fixture-dependency","main":"alternate.js"}');
          substituted = true;
          return undefined;
        });
        builder.onEnd(() => { writeFileSync(metadata, original); restored = true; });
      } }] });
    const imported = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.contents).toString('base64'));
    expect({ substituted, restored, dep: imported.dep }).toEqual({ substituted: true, restored: true, dep: 99 });
    expect(readFileSync(metadata)).toEqual(original);
    expect(verifyBgVerifierSource(prepared, 'before-publication')).toBe(prepared);
    expect(captureVerifierDependencies({ dest: prepared.root, receipt: prepared.source })).toEqual(dependencies);
    expect(() => custody.verifyBeforePublication())
      .toThrow('BG compiler original input identity changed: node_modules/fixture-dependency/package.json');
  });

  it('bg-r1-compiler-absent-resolver-metadata refuses a package manifest created during real resolution and removed before publication', async () => {
    const { prepared } = await compilerCandidate();
    const metadata = join(prepared.root, 'node_modules/fixture-dependency/package.json');
    rmSync(metadata);
    write(prepared.root, 'node_modules/fixture-dependency/alternate.js', 'export default 99;\n');
    const dependencies = captureVerifierDependencies({ dest: prepared.root, receipt: prepared.source });
    const custody = createBgVerifierCompilerCustody({ prepared, dependencies });
    const { build } = await import('esbuild');
    let substituted = false, restored = false;
    const result = await build({ absWorkingDir: prepared.root, entryPoints: [inputs[0]!], bundle: true,
      format: 'esm', platform: 'node', write: false, logLevel: 'silent',
      plugins: [custody.plugin, { name: 'independent-absent-resolver-manifest', setup(builder) {
        builder.onResolve({ filter: /^fixture-dependency$/ }, () => {
          writeFileSync(metadata, '{"name":"fixture-dependency","main":"alternate.js"}');
          substituted = true;
          return undefined;
        });
        builder.onEnd(() => { rmSync(metadata); restored = true; });
      } }] });
    const imported = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.contents).toString('base64'));
    expect({ substituted, restored, dep: imported.dep }).toEqual({ substituted: true, restored: true, dep: 99 });
    expect(existsSync(metadata)).toBe(false);
    expect(verifyBgVerifierSource(prepared, 'before-publication')).toBe(prepared);
    expect(captureVerifierDependencies({ dest: prepared.root, receipt: prepared.source })).toEqual(dependencies);
    expect(() => custody.verifyBeforePublication())
      .toThrow('BG compiler original directory identity changed: node_modules/fixture-dependency');
  });

  it('bg-r1-compiler-absent-resolver-metadata qualifies immutable absence during real compilation', async () => {
    const { prepared } = await compilerCandidate();
    const metadata = join(prepared.root, 'node_modules/fixture-dependency/package.json');
    rmSync(metadata);
    const dependencies = captureVerifierDependencies({ dest: prepared.root, receipt: prepared.source });
    const custody = createBgVerifierCompilerCustody({ prepared, dependencies });
    const { build } = await import('esbuild');
    const result = await build({ absWorkingDir: prepared.root, entryPoints: [inputs[0]!], bundle: true,
      format: 'esm', platform: 'node', write: false, logLevel: 'silent', plugins: [custody.plugin] });
    const imported = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.contents).toString('base64'));
    expect(imported.dep).toBe(41);
    expect(existsSync(metadata)).toBe(false);
    expect(custody.verifyBeforePublication().map(row => row.path)).toContain('node_modules/fixture-dependency/index.js');
  });

  it.each(['source-directory', 'source-ancestor'] as const)(
    'bg-r1-compiler-absent-resolver-metadata refuses restored namespace mutation in %s', async kind => {
      const { prepared, dependencies } = await compilerCandidate();
      const custody = createBgVerifierCompilerCustody({ prepared, dependencies });
      const target = join(prepared.root, kind === 'source-directory'
        ? 'packages/core/package.json' : 'packages/.transient-resolver');
      expect(existsSync(target)).toBe(false);
      const { build } = await import('esbuild');
      const result = await build({ absWorkingDir: prepared.root, entryPoints: [inputs[0]!], bundle: true,
        format: 'esm', platform: 'node', write: false, logLevel: 'silent',
        plugins: [custody.plugin, { name: 'independent-restored-source-namespace', setup(builder) {
          builder.onEnd(() => {
            if (kind === 'source-directory') writeFileSync(target, '{}');
            else mkdirSync(target);
            rmSync(target, { recursive: true });
          });
        } }] });
      const imported = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.contents).toString('base64'));
      expect(imported.dep).toBe(41);
      expect(existsSync(target)).toBe(false);
      expect(verifyBgVerifierSource(prepared, 'before-publication')).toBe(prepared);
      expect(captureVerifierDependencies({ dest: prepared.root, receipt: prepared.source })).toEqual(dependencies);
      expect(() => custody.verifyBeforePublication()).toThrow('BG compiler original directory identity changed: packages');
    });

  for (const local of ['package.json', 'node_modules/fixture-dependency/package.json']) {
    it(`bg-r1-compiler-metadata-identical-rewrite refuses original metadata rewritten with identical bytes: ${local}`, async () => {
      const { prepared, dependencies } = await compilerCandidate();
      const target = join(prepared.root, local), original = readFileSync(target);
      const custody = createBgVerifierCompilerCustody({ prepared, dependencies });
      const { build } = await import('esbuild');
      const result = await build({ absWorkingDir: prepared.root, entryPoints: [inputs[0]!], bundle: true,
        format: 'esm', platform: 'node', write: false, logLevel: 'silent',
        plugins: [custody.plugin, { name: 'independent-identical-metadata-rewrite', setup(builder) {
          builder.onEnd(() => { writeFileSync(target, original); });
        } }] });
      const imported = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.contents).toString('base64'));
      expect(imported.dep).toBe(41);
      expect(verifyBgVerifierSource(prepared, 'before-publication')).toBe(prepared);
      expect(captureVerifierDependencies({ dest: prepared.root, receipt: prepared.source })).toEqual(dependencies);
      expect(() => custody.verifyBeforePublication())
        .toThrow(`BG compiler original input identity changed: ${local}`);
    });
  }

  it.each(['stdin', 'virtual'] as const)('refuses %s compiler content that could bypass the frozen file census', async kind => {
    const { prepared, dependencies } = await compilerCandidate();
    const custody = createBgVerifierCompilerCustody({ prepared, dependencies });
    const { build } = await import('esbuild');
    await expect(build({ absWorkingDir: prepared.root, bundle: true, platform: 'node', write: false, logLevel: 'silent',
      ...(kind === 'stdin' ? { stdin: { contents: 'export default 99', loader: 'js' as const } } : { entryPoints: ['virtual-entry'] }),
      plugins: [custody.plugin, { name: 'independent-virtual-provider', setup(builder) {
        builder.onResolve({ filter: /^virtual-entry$/ }, () => ({ path: 'virtual-entry', namespace: 'fixture-virtual' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture-virtual' }, () => ({ contents: 'export default 99' }));
      } }],
    })).rejects.toThrow(kind === 'stdin'
      ? 'BG compiler stdin is outside original census' : 'BG compiler virtual input is outside original census');
  });

  async function outputCandidate() {
    const { prepared, dependencies } = await compilerCandidate(true);
    const invocation = { builder: join(prepared.root, 'apps/operator/bin/bundle-host.sh'),
      argv: [inputs[0]!, '--bundle', '--platform=node', '--format=esm'], node: process.execPath,
      compiler: join(prepared.root, 'node_modules/fixture-compiler/cli.js'),
      packageManager: join(prepared.root, 'node_modules/fixture-package-manager/cli.js'),
      configuration: [join(prepared.root, 'package.json')],
      environment: { NODE_OPTIONS: '', NODE_PATH: '', PATH: '/usr/bin' } };
    const record = prepareBgVerifierBuildRecord({ prepared, dependencies, invocation });
    const entry = join(prepared.root, 'apps/operator/dist-verify/hono-host.mjs');
    // The output namespace is generated-only. Create it before custody snapshots
    // the original input directories so writing artifacts does not look like input drift.
    mkdirSync(dirname(entry), { recursive: true });
    const custody = createBgVerifierCompilerCustody({ prepared, dependencies });
    const { build } = await import('esbuild');
    const result = await build({ absWorkingDir: prepared.root, entryPoints: [inputs[0]!], outfile: entry,
      bundle: true, format: 'esm', platform: 'node', metafile: true, logLevel: 'silent', plugins: [custody.plugin] });
    writeFileSync(entry + '.meta.json', JSON.stringify(result.metafile));
    custody.verifyBeforePublication();
    return { prepared, invocation, record, entry };
  }

  it.each([0, 4 * 1024 * 1024 + 37])(
    'BG toolchain identity hashes every byte of a %i-byte file and refuses later tail drift', async size => {
      const fixture = await outputCandidate();
      const bytes = Buffer.alloc(size, 0x61);
      if (size) bytes.fill(0x62, size - 37);
      writeFileSync(fixture.invocation.packageManager, bytes);
      const dependencies = captureVerifierDependencies({ dest: fixture.prepared.root, receipt: fixture.prepared.source });
      const identity = statSync(fixture.invocation.packageManager), originalRead = nativeFs.readFileSync;
      const wholeFileRead = vi.spyOn(nativeFs, 'readFileSync').mockImplementation((...args) => {
        if (typeof args[0] === 'number') {
          const opened = fstatSync(args[0]);
          if (opened.dev === identity.dev && opened.ino === identity.ino)
            throw new Error('whole-file toolchain reads are forbidden');
        }
        return Reflect.apply(originalRead, nativeFs, args);
      });
      syncBuiltinESMExports();
      try {
        const record = prepareBgVerifierBuildRecord({ ...fixture, dependencies });
        expect(record.invocation.packageManager.sha256).toBe(digest(bytes));
        expect(verifyBgVerifierBuildRecord(record, fixture.invocation, 'before-publication')).toBe(record);
        writeFileSync(fixture.invocation.packageManager, Buffer.concat([bytes, Buffer.from([0x63])]));
        expect(() => verifyBgVerifierBuildRecord(record, fixture.invocation, 'before-publication'))
          .toThrow('BG builder configuration or toolchain identity changed');
      } finally { wholeFileRead.mockRestore(); syncBuiltinESMExports(); }
    });

  async function maintainedCompilerCandidate() {
    const { prepared } = await compilerCandidate(true, true);
    const installed = dirname(createRequire(import.meta.url).resolve('@papercusp/host-esbuild/package.json'));
    const privateCompiler = join(prepared.root, 'node_modules/@papercusp/host-esbuild');
    bgFixtureTrace('private-compiler-copy:start');
    // The pinned binary is bin/esbuild. Omit the unused platform-package
    // fallback: copying it duplicates a 10MB executable in every mutable-input
    // census and makes this hermetic fixture depend on an ambient fallback.
    cpSync(installed, privateCompiler, { recursive: true, dereference: true,
      filter: path => path !== join(installed, 'node_modules') });
    bgFixtureTrace('private-compiler-copy:completed');
    const dependencies = captureVerifierDependencies({ dest: prepared.root, receipt: prepared.source });
    bgFixtureTrace('private-compiler:dependencies-ready');
    const entry = join(prepared.root, 'apps/operator/dist-verify/guarded.mjs');
    const argv = [join(prepared.root, inputs[0]!), '--bundle', '--platform=node', '--format=esm', '--target=node22',
      '--outfile=' + entry, '--metafile=' + entry + '.meta.json', '--log-level=silent',
      '--banner:js=/* retained banner */', '--define:__PAPERCUSP_BUNDLED_SIDECAR__=true',
      '--external:unused-native/*', '--minify-whitespace', '--minify-syntax'];
    const invocation = { builder: join(prepared.root, 'apps/operator/bin/bundle-host.sh'), argv,
      compiler: join(privateCompiler, 'lib/main.js'), node: process.execPath,
      packageManager: join(prepared.root, 'node_modules/fixture-package-manager/cli.js'),
      configuration: [join(prepared.root, 'package.json')], environment: { NODE_OPTIONS: '', NODE_PATH: '', PATH: '/usr/bin',
        TMPDIR: tmpdir(),
        ESBUILD_BINARY_PATH: join(privateCompiler, 'bin/esbuild'), ESBUILD_WORKER_THREADS: '0' } };
    const record = prepareBgVerifierBuildRecord({ prepared, dependencies, invocation });
    bgFixtureTrace('private-compiler:record-ready');
    const expectedVersion = '0.25.0';
    expect(JSON.parse(readFileSync(join(privateCompiler, 'package.json'), 'utf8')).version).toBe(expectedVersion);
    return { prepared, dependencies, invocation, record, argv, entry, expectedVersion };
  }

  it('compiles exact maintained host switches using private real esbuild and retains original custody', async () => {
    const fixture = await maintainedCompilerCandidate();
    const original = JSON.stringify(fixture.record), receipt = readFileSync(join(fixture.prepared.root, '.verifier-source.json'));
    const env = process.env;
    const compiled = await compileBgVerifierInvocation({ ...fixture,
      runPhase: bgRecipePhaseRunner('single-maintained-compiler') });
    expect(process.env).toBe(env);
    expect(compiled.argv).toEqual(fixture.argv);
    expect(compiled.compilerApi).toEqual({ path: 'node_modules/@papercusp/host-esbuild/lib/main.js',
      realpath: fixture.invocation.compiler, sha256: digest(readFileSync(fixture.invocation.compiler)) });
    expect(compiled.compilerBinary).toMatchObject({ kind: 'kernel-sealed-fd-v1',
      sha256: digest(readFileSync(fixture.invocation.environment.ESBUILD_BINARY_PATH)), launches: 1 });
    expect(compiled.consumed.map(row => row.path)).toContain('node_modules/fixture-dependency/index.js');
    const imported = await import('data:text/javascript;base64,' + readFileSync(fixture.entry).toString('base64'));
    expect({ y: imported.y, dep: imported.dep }).toEqual({ y: 2, dep: 41 });
    expect(readFileSync(fixture.entry, 'utf8')).toContain('retained banner');
    expect(JSON.stringify(fixture.record)).toBe(original);
    expect(readFileSync(join(fixture.prepared.root, '.verifier-source.json'))).toEqual(receipt);
    expect((await qualifyBgVerifierOutput(fixture)).artifact.sourceBlobs).toEqual(fixture.prepared.acceptedManifest.members);
  });

  it('BG compiler API refuses substituted JavaScript before evaluation even when restored after import', async () => {
    const fixture = await maintainedCompilerCandidate();
    const api = fixture.invocation.compiler, original = readFileSync(api);
    const sentinel = join(tmp, 'compiler-api-substitution-effect');
    let reachedImport = false, failure: unknown;
    const env = process.env;
    try {
      await compileBgVerifierInvocation({ ...fixture, runPhase: async (phase, operation) => {
        if (phase !== 'bg.compiler.import') return operation();
        reachedImport = true;
        writeFileSync(api, Buffer.concat([original, Buffer.from(
          '\nrequire("fs").writeFileSync(' + JSON.stringify(sentinel) + ', "substituted-api");\n')]));
        try { return await operation(); }
        finally { writeFileSync(api, original); }
      } });
    } catch (error) { failure = error; }
    expect(reachedImport).toBe(true);
    expect(existsSync(sentinel), 'substituted compiler API must have no evaluation effect').toBe(false);
    expect(String(failure)).toContain('BG compiler consumed bytes mismatch: node_modules/@papercusp/host-esbuild/lib/main.js');
    expect(readFileSync(api)).toEqual(original);
    expect(process.env).toBe(env);
    expect(existsSync(fixture.entry)).toBe(false);
  });

  it('BG compiler API evaluates current accepted bytes independently of a stale Node module cache', async () => {
    const fixture = await maintainedCompilerCandidate();
    const api = fixture.invocation.compiler, original = readFileSync(api);
    const stale = original.toString('utf8').replaceAll('0.25.0', '0.24.0');
    expect(stale).not.toBe(original.toString('utf8'));
    const env = process.env;
    try {
      process.env = { ...fixture.invocation.environment };
      writeFileSync(api, stale);
      expect((await import(pathToFileURL(api).href)).version).toBe('0.24.0');
    } finally { writeFileSync(api, original); process.env = env; }
    // Freeze the original A identity AFTER the deliberately stale cache entry.
    fixture.record = prepareBgVerifierBuildRecord(fixture);
    const compiled = await compileBgVerifierInvocation(fixture);
    expect(compiled.compilerVersion).toBe('0.25.0');
    expect(compiled.compilerApi.sha256).toBe(digest(original));
    const output = await import('data:text/javascript;base64,' + readFileSync(fixture.entry).toString('base64'));
    expect({ y: output.y, dep: output.dep }).toEqual({ y: 2, dep: 41 });
    expect(process.env).toBe(env);
  });

  it.each(['bg.compiler.binary-seal', 'bg.compiler.build'] as const)(
    'BG compiler binary substitution has no execution effect at %s even when restored', async boundary => {
      const fixture = await maintainedCompilerCandidate();
      const path = fixture.invocation.environment.ESBUILD_BINARY_PATH, original = readFileSync(path);
      const sentinel = join(tmp, 'compiler-binary-substitution-' + boundary);
      const env = process.env;
      const runPhase = bgRecipePhaseRunner('binary-custody-' + boundary);
      let reachedBoundary = false, failure: unknown;
      try {
        await compileBgVerifierInvocation({ ...fixture, runPhase: async (phase, operation) => {
          if (phase !== boundary) return runPhase(phase, operation);
          reachedBoundary = true;
          writeFileSync(path, '#!/bin/sh\nprintf substituted-binary > ' + JSON.stringify(sentinel) + '\nexit 1\n');
          try { return await runPhase(phase, operation); }
          finally { writeFileSync(path, original); }
        } });
      } catch (error) { failure = error; }
      expect(reachedBoundary).toBe(true);
      expect(existsSync(sentinel), 'substituted native binary must have no execution effect').toBe(false);
      expect(String(failure)).toContain(boundary === 'bg.compiler.binary-seal'
        ? 'broker_source_seal_failed' : 'BG compiler original input identity changed');
      // Native equality checks every byte without the assertion framework
      // recursively visiting ten million indexed Buffer properties.
      bgFixtureTrace('binary-fixture:restoration-check:started');
      expect(readFileSync(path).equals(original)).toBe(true);
      bgFixtureTrace('binary-fixture:restoration-check:completed');
      expect(process.env).toBe(env);
      expect(existsSync(fixture.entry)).toBe(false);
    });

  it.each(['argv', 'unknown-switch', 'version', 'ambient-binary', 'actual-node', 'output-escape'] as const)(
    'refuses %s before guarded compiler output', async defect => {
      const fixture = await maintainedCompilerCandidate();
      if (defect === 'argv') fixture.argv = [...fixture.argv, '--keep-names'];
      if (defect === 'version') fixture.expectedVersion = '0.0.0';
      if (defect === 'actual-node') {
        fixture.invocation.node = fixture.invocation.packageManager;
        fixture.record = prepareBgVerifierBuildRecord(fixture);
      }
      if (defect === 'ambient-binary') {
        fixture.invocation.environment.ESBUILD_BINARY_PATH = process.execPath;
        fixture.record = prepareBgVerifierBuildRecord(fixture);
      }
      if (defect === 'unknown-switch' || defect === 'output-escape') {
        fixture.invocation.argv = fixture.argv = [...fixture.argv,
          defect === 'unknown-switch' ? '--inject=/unaccepted.js' : '--outfile=' + join(tmp, 'outside-bg.mjs')];
        fixture.record = prepareBgVerifierBuildRecord(fixture);
      }
      await expect(compileBgVerifierInvocation(fixture)).rejects.toThrow(defect === 'argv'
        ? 'BG compiler argv differs' : defect === 'version' ? 'BG compiler package version mismatch'
          : defect === 'ambient-binary' ? 'BG compiler binary must be explicitly pinned'
            : defect === 'actual-node' ? 'BG compiler actual Node differs'
            : defect === 'unknown-switch' ? 'BG compiler switch is outside maintained recipe' : 'BG compiler output escaped');
      expect(existsSync(fixture.entry)).toBe(false);
    });

  it('routes guarded shared-shell compilation to its recorded adapter without cache fallback', () => {
    const root = join(tmp, 'bg-shared-dispatch');
    write(root, 'scripts/source-preview.mjs', 'console.log(JSON.stringify(process.argv.slice(2))); process.exit(37);');
    const common = join(SOURCE_ROOT, 'apps/operator/bin/bundle-host-common.sh');
    const child = spawnSync('bash', ['-c',
      'source "$1"; bundle_host_cached_package() { echo cache-fallback >&2; return 99; }; BUNDLE_HOST_BG_BUILD_CONTEXT="$3"; bundle_host_esbuild "$2" "$4" --bundle --outfile="$5"',
      'guarded-dispatch', common, root, join(root, 'original context.json'), 'entry with spaces.ts', 'out with spaces.mjs'],
    { env: childEnv(), encoding: 'utf8', timeout: 30_000 });
    expect(child.status).toBe(37);
    expect(child.stderr).not.toContain('cache-fallback');
    expect(JSON.parse(child.stdout)).toEqual(['bg-compiler', '--context', join(root, 'original context.json'), '--',
      'entry with spaces.ts', '--bundle', '--outfile=out with spaces.mjs']);
  });

  it('runs the selected shared shell through the actual guarded CLI and private pinned esbuild 0.25.0', async () => {
    const fixture = await maintainedCompilerCandidate();
    const context = join(tmp, 'original-bg-compiler-context.json');
    writeFileSync(context, JSON.stringify({ record: fixture.record, invocation: fixture.invocation }));
    const common = join(fixture.prepared.root, 'apps/operator/bin/bundle-host-common.sh');
    const result = spawnSync('bash', ['-c',
      'source "$1"; shift; repo="$1"; shift; bundle_host_cached_package() { echo unexpected-cache-fallback >&2; return 99; }; bundle_host_esbuild "$repo" "$@"',
      'real-guarded-compiler', common, fixture.prepared.root, ...fixture.argv],
    { env: childEnv({ BUNDLE_HOST_BG_BUILD_CONTEXT: context }), encoding: 'utf8', timeout: 60_000 });
    expect(result.stderr).not.toContain('unexpected-cache-fallback');
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    const receipt = JSON.parse(result.stdout);
    expect(receipt.compilerVersion).toBe('0.25.0');
    expect(receipt.argv).toEqual(fixture.argv);
    expect(receipt.binary.realpath).toBe(fixture.invocation.environment.ESBUILD_BINARY_PATH);
    expect(receipt.consumed.map((row: { path: string }) => row.path)).toContain('packages/core/index.ts');
    expect((await qualifyBgVerifierOutput(fixture)).artifact.sourceBlobs).toEqual(fixture.prepared.acceptedManifest.members);
  });

  async function maintainedCompilerContexts() {
    const fixture = await maintainedCompilerCandidate();
    const workerEntry = join(dirname(fixture.entry), 'worker.mjs');
    const workerArgv = fixture.argv.map((arg, index) => index === 0
      ? join(fixture.prepared.root, 'packages/core/index.ts') : arg.replaceAll(fixture.entry, workerEntry));
    const worker = { ...fixture.invocation, argv: workerArgv };
    const contexts = prepareBgVerifierBuildContexts({ ...fixture, invocations: [fixture.invocation, worker] });
    const contextPath = join(dirname(fixture.prepared.root), 'original-multi-entry-contexts.json');
    writeFileSync(contextPath, JSON.stringify(contexts));
    const common = join(fixture.prepared.root, 'apps/operator/bin/bundle-host-common.sh');
    const run = (argv: string[], check = false) => spawnSync('bash', ['-c',
      'source "$1"; shift; repo="$1"; shift; bundle_host_cached_package() { echo unexpected-cache-fallback >&2; return 99; }; if [[ "$1" == check ]]; then bundle_host_prepare_esbuild "$repo"; else shift; bundle_host_esbuild "$repo" "$@"; fi',
      'guarded-multi-entry', common, fixture.prepared.root, check ? 'check' : 'compile', ...argv],
    { env: childEnv({ BUNDLE_HOST_BG_BUILD_CONTEXT: contextPath }), encoding: 'utf8', timeout: 60_000 });
    return { ...fixture, worker, workerEntry, contexts, contextPath, run };
  }

  async function transactionCandidate() {
    const fixture = await maintainedCompilerContexts();
    const bank = dirname(fixture.entry), stage = join(bank, 'owned-build');
    await fsPromises.mkdir(bank, { recursive: true });
    const outputs = [
      { temporary: 'hono-host.mjs.tmp.@BG_PID@', final: 'hono-host.mjs' },
      { temporary: 'hono-host.mjs.tmp.@BG_PID@.meta.json', final: 'hono-host.mjs.meta.json' },
      { temporary: 'worker.mjs.new.@BG_PID@.mjs', final: 'worker.mjs' },
      { temporary: 'worker.mjs.new.@BG_PID@.mjs.meta.json', final: 'worker.mjs.meta.json' },
    ];
    const invocations = [fixture.invocation, fixture.worker].map((invocation, index) => ({ ...invocation,
      argv: invocation.argv.map(arg => arg.replaceAll(index ? fixture.workerEntry : fixture.entry,
        join(stage, outputs[index * 2]!.temporary))) }));
    const recipe = { entry: fixture.argv[0]!, outfile: join(stage, 'hono-host.mjs'), profile: 'release' as const };
    const args = { ...fixture, bank, stageLeaf: 'owned-build', invocations, outputs, recipe,
      assets: [] as { source: string, temporary: string, final: string }[],
      publicationLeaf: 'published-build.json' as string | undefined };
    bgFixtureTrace('transaction-fixture:ready');
    return { ...fixture, args, stage };
  }

  async function transactionRecipe(configure?: (args: Awaited<ReturnType<typeof transactionCandidate>>['args']) => void) {
    const fixture = await transactionCandidate();
    configure?.(fixture.args);
    const transaction = prepareBgVerifierBuildTransaction(fixture.args);
    const bytes = JSON.stringify(transaction);
    const path = join(dirname(fixture.prepared.root), 'original-build-transaction.json');
    writeFileSync(path, bytes);
    const run = (changes: { digest?: string, entry?: string, outfile?: string, profile?: string, extra?: string[],
      bindingOnly?: boolean, publishOnly?: boolean, environment?: Record<string, string> } = {}) =>
      spawnSync('bash', [fixture.invocation.builder, '--bg-transaction', path, changes.digest ?? digest(bytes),
        changes.entry ?? fixture.args.recipe.entry, changes.outfile ?? fixture.args.recipe.outfile,
        changes.profile ?? fixture.args.recipe.profile,
        ...(changes.publishOnly ? ['--publish-qualified-output-only']
          : changes.bindingOnly === false ? [] : ['--binding-preflight-only']), ...(changes.extra ?? [])],
      { env: childEnv({ BUNDLE_HOST_BG_BUILD_CONTEXT: '/must-not-adopt-inherited-context.json',
        PAPERCUSP_CHECKPOINT_LOG_DIR: join(tmp, 'bg-phase-archive'), ...changes.environment }),
        encoding: 'utf8', timeout: 60_000 });
    const recipePhases = (pid: number) => {
      const phasePath = `${path}.phases.${pid}.jsonl`;
      return existsSync(phasePath) ? readFileSync(phasePath, 'utf8') : `No BG phase receipt at ${phasePath}`;
    };
    bgFixtureTrace('transaction-recipe:ready');
    return { ...fixture, transaction, bytes, path, runRecipe: run, recipePhases };
  }

  it('BG recipe output-only mode compiles the original main and worker and publishes complete retained evidence', async () => {
    const traceEnabled = Boolean(process.env.PAPERCUSP_BG_LOGICAL_TRACE);
    const trace = (stage: string) => bgFixtureTrace('output-only:' + stage, traceEnabled);
    trace('fixture:start');
    const fixture = await transactionRecipe();
    trace('fixture:ready');
    const originalSource = readFileSync(join(fixture.prepared.root, '.verifier-source.json'));
    const child = fixture.runRecipe({ publishOnly: true });
    trace('child:ready');
    const phaseEvidence = fixture.recipePhases(child.pid);
    if (traceEnabled) process.stderr.write(`BG_RECIPE_PHASES ${JSON.stringify(phaseEvidence)}\n`);
    expectBgChild(child, phaseEvidence);
    const phases = phaseEvidence.trim().split('\n').map(line => JSON.parse(line));
    expect(phases.filter(row => row.phase === 'bg.compiler.build' && row.event === 'completed')).toHaveLength(2);
    expect(phases.at(-1)).toMatchObject({ phase: 'bg.recipe.verify', event: 'completed' });
    const publication = JSON.parse(child.stdout);
    const { binding, receipts, output, logical } = publication;
    expect(binding.ownerPid).toBe(child.pid);
    expect(binding.transaction).toEqual(fixture.transaction);
    expect(receipts.map((receipt: { argv: string[] }) => receipt.argv))
      .toEqual(fixture.transaction.contexts.invocations.map(entry =>
        entry.original.argv.map(arg => arg.replaceAll('@BG_PID@', String(child.pid)))));
    expect(receipts).toHaveLength(2);
    expect(output.files).toHaveLength(4);
    expect(logical.files.map((row: { final: string }) => row.final)).toEqual(fixture.args.outputs.map(row => row.final));
    trace('publication-verify:start');
    expect(verifyBgVerifierPublication(publication, { binding, receipts, output, logical })).toBe(publication);
    trace('publication-verify:ready');
    const { identity, ...published } = publication;
    expect(JSON.parse(readFileSync(identity.path, 'utf8'))).toEqual(published);
    trace('imports:start');
    const main = await import('data:text/javascript;base64,' + readFileSync(fixture.args.recipe.outfile).toString('base64'));
    const worker = await import('data:text/javascript;base64,' + readFileSync(join(fixture.stage, 'worker.mjs')).toString('base64'));
    trace('imports:ready');
    expect({ y: main.y, dep: main.dep, worker: worker.y }).toEqual({ y: 2, dep: 41, worker: 2 });
    expect(readFileSync(fixture.path, 'utf8')).toBe(fixture.bytes);
    expect(readFileSync(join(fixture.prepared.root, '.verifier-source.json'))).toEqual(originalSource);
    trace('replay:start');
    const replay = fixture.runRecipe({ publishOnly: true });
    trace('replay:ready');
    expect(replay.status).not.toBe(0);
    expect(replay.stderr).toContain('BG recipe publication already exists');
    expect(JSON.parse(readFileSync(identity.path, 'utf8'))).toEqual(published);
  });

  function ancillaryAssets() {
    return [
      { source: 'docs/architecture.md', final: 'blueprints/base/README.md' },
      { source: 'libs/papercusp/libs/db/sql/001-init.sql', final: 'sql/001-init.sql' },
    ].map(row => ({ ...row, temporary: `${row.final}.new.@BG_PID@` }));
  }

  async function assetTreeCandidate(link = false) {
    const c = candidate();
    write(c.fixture.repo, 'asset-tree/base/blueprint.yaml', 'name: base\n');
    write(c.fixture.repo, 'asset-tree/base/prompts/with space.md', 'original prompt\n');
    write(c.fixture.repo, 'asset-sql/001-init.sql', 'select 1;\n');
    write(c.fixture.repo, 'asset-sql/.hidden.sql', 'excluded by the maintained shell glob\n');
    write(c.fixture.repo, 'asset-sql/nested/002-hidden.sql', 'select 2;\n');
    write(c.fixture.repo, 'asset-sql/README.md', 'not a migration\n');
    if (link) symlinkSync('base/blueprint.yaml', join(c.fixture.repo, 'asset-tree/linked.yaml'));
    git(c.fixture.repo, ['add', '-A']);
    git(c.fixture.repo, ['commit', '-qm', 'original ancillary directory population']);
    c.options.ref = git(c.fixture.repo, ['rev-parse', 'HEAD']);
    return prepareBgVerifierSource(c.options);
  }

  it('BG asset tree expansion retains recursive source members and immediate SQL selection in stable order', async () => {
    const prepared = await assetTreeCandidate();
    const assets = expandBgVerifierAssetTrees({ prepared, trees: [
      { source: 'asset-tree', final: 'blueprints', selection: 'recursive' },
      { source: 'asset-sql', final: 'sql', selection: 'sql' },
    ] });
    expect(assets).toEqual([
      { source: 'asset-tree/base/blueprint.yaml', final: 'blueprints/base/blueprint.yaml',
        temporary: 'blueprints/base/blueprint.yaml.new.@BG_PID@' },
      { source: 'asset-tree/base/prompts/with space.md', final: 'blueprints/base/prompts/with space.md',
        temporary: 'blueprints/base/prompts/with space.md.new.@BG_PID@' },
      { source: 'asset-sql/001-init.sql', final: 'sql/001-init.sql', temporary: 'sql/001-init.sql.new.@BG_PID@' },
    ]);
    expect(Object.isFrozen(assets)).toBe(true);
    expect(Object.isFrozen(assets[0])).toBe(true);
  });

  it.each(['escape', 'token', 'unknown-selection', 'empty', 'file', 'duplicate', 'overlap', 'uncensused', 'drift'] as const)(
    'BG asset tree expansion refuses %s population before transaction effects', async defect => {
      const prepared = await assetTreeCandidate();
      const trees = [{ source: 'asset-tree', final: 'blueprints', selection: 'recursive' as 'recursive' | 'sql' }];
      if (defect === 'escape') trees[0]!.source = '../asset-tree';
      if (defect === 'token') trees[0]!.final = 'blueprints/@BG_PID@';
      if (defect === 'unknown-selection') trees[0]!.selection = 'glob' as never;
      if (defect === 'empty') trees[0]!.selection = 'sql';
      if (defect === 'file') trees[0]!.source = 'asset-tree/base/blueprint.yaml';
      if (defect === 'duplicate') trees.push({ ...trees[0]! });
      if (defect === 'overlap') trees.push({ source: 'asset-sql', final: 'blueprints/base/blueprint.yaml', selection: 'sql' });
      if (defect === 'uncensused') {
        write(prepared.root, 'uncensused/foreign.txt', 'foreign');
        trees[0]!.source = 'uncensused';
      }
      if (defect === 'drift') write(prepared.root, 'asset-tree/base/blueprint.yaml', 'changed');
      expect(() => expandBgVerifierAssetTrees({ prepared, trees })).toThrow();
      expect(existsSync(join(prepared.root, 'apps/operator/dist-verify/owned-build'))).toBe(false);
    });

  it('BG asset tree expansion refuses a committed link in the selected directory', async () => {
    const prepared = await assetTreeCandidate(true);
    expect(() => expandBgVerifierAssetTrees({ prepared, trees: [
      { source: 'asset-tree', final: 'blueprints', selection: 'recursive' },
    ] })).toThrow('BG asset tree member must be a regular file');
  });

  it('BG asset tree expansion publishes its retained directory population with real compiler outputs', async () => {
    const fixture = await transactionCandidate();
    fixture.args.assets = expandBgVerifierAssetTrees({ prepared: fixture.prepared, trees: [
      { source: 'docs', final: 'blueprints', selection: 'recursive' },
      { source: 'libs/papercusp/libs/db/sql', final: 'sql', selection: 'sql' },
    ] });
    const transaction = prepareBgVerifierBuildTransaction(fixture.args);
    const publication = await runBgVerifierBuildRecipe({ transaction, ownerPid: process.pid,
      runPhase: bgRecipePhaseRunner('asset-tree-publication') });
    expect(publication.logical.files).toHaveLength(fixture.args.outputs.length + fixture.args.assets.length);
    for (const asset of fixture.args.assets) {
      const source = join(fixture.prepared.root, asset.source), copied = join(fixture.stage, asset.final);
      expect(readFileSync(copied)).toEqual(readFileSync(source));
      expect(statSync(copied).ino).not.toBe(statSync(source).ino);
    }
    expect(verifyBgVerifierPublication(publication, publication)).toBe(publication);
  });

  it('BG ancillary asset custody publishes the original source bytes beside compiled main and worker outputs', async () => {
    const fixture = await transactionRecipe(args => { args.assets = ancillaryAssets(); });
    const child = fixture.runRecipe({ publishOnly: true });
    expectBgChild(child, fixture.recipePhases(child.pid));
    const publication = JSON.parse(child.stdout);
    const { binding, receipts, output, logical } = publication;
    expect(output.files).toHaveLength(6);
    expect(logical.files.map((row: { final: string }) => row.final)).toEqual([
      ...fixture.args.outputs.map(row => row.final), ...fixture.args.assets.map(row => row.final),
    ]);
    for (const asset of fixture.args.assets) {
      const source = join(fixture.prepared.root, asset.source), copied = join(fixture.stage, asset.final);
      expect(readFileSync(copied)).toEqual(readFileSync(source));
      expect(statSync(copied).nlink).toBe(1);
      expect(statSync(copied).ino).not.toBe(statSync(source).ino);
    }
    expect(verifyBgVerifierPublication(publication, { binding, receipts, output, logical })).toBe(publication);
    writeFileSync(join(fixture.stage, fixture.args.assets[0]!.final), 'replaced after publication');
    expect(() => verifyBgVerifierPublication(publication, { binding, receipts, output, logical })).toThrow('BG logical file changed');
  });

  it.each(['uncensused', 'escape', 'collision', 'directory-overlap', 'pid-token'] as const)(
    'BG ancillary asset custody refuses original %s membership before stage creation', async defect => {
      const fixture = await transactionCandidate();
      fixture.args.assets = ancillaryAssets();
      const asset = fixture.args.assets[0]!;
      if (defect === 'uncensused') asset.source = 'node_modules/fixture-dependency/index.js';
      if (defect === 'escape') asset.final = '../outside.md';
      if (defect === 'collision') asset.final = fixture.args.outputs[0]!.final;
      if (defect === 'directory-overlap') asset.final = fixture.args.outputs[0]!.final + '/child.md';
      if (defect === 'pid-token') asset.final = 'blueprints/@BG_PID@.md';
      asset.temporary = `${asset.final}.new.@BG_PID@`;
      expect(() => prepareBgVerifierBuildTransaction(fixture.args)).toThrow(/BG (transaction|asset)/);
      expect(existsSync(fixture.stage)).toBe(false);
      expect(readdirSync(fixture.args.bank)).toEqual([]);
    });

  it.each(['missing', 'changed', 'symlink', 'hardlink', 'unrecorded'] as const)(
    'BG ancillary asset custody refuses %s copied output before logical publication', async defect => {
      const fixture = await transactionCandidate();
      fixture.args.assets = ancillaryAssets();
      const transaction = prepareBgVerifierBuildTransaction(fixture.args);
      const binding = beginBgVerifierBuildTransaction({ transaction, ownerPid: process.pid });
      const receipts: Awaited<ReturnType<typeof compileBgVerifierInvocation>>[] = [];
      for (const entry of binding.contexts.invocations) receipts.push(await compileBgVerifierInvocation({
        record: { ...binding.contexts.record, invocation: entry.original }, invocation: entry.invocation,
        argv: entry.invocation.argv, expectedVersion: '0.25.0',
      }));
      stageBgVerifierAssetCopies(binding);
      const asset = fixture.args.assets[0]!;
      const copied = join(fixture.stage, asset.temporary.replaceAll('@BG_PID@', String(process.pid)));
      if (defect === 'missing') rmSync(copied);
      if (defect === 'changed') writeFileSync(copied, 'foreign bytes');
      if (defect === 'symlink' || defect === 'hardlink') {
        rmSync(copied);
        if (defect === 'symlink') symlinkSync(join(fixture.prepared.root, asset.source), copied);
        else linkSync(join(fixture.prepared.root, asset.source), copied);
      }
      if (defect === 'unrecorded') writeFileSync(join(dirname(copied), 'not-in-original.txt'), 'foreign');
      expect(() => qualifyBgVerifierBuildOutputSet({ binding, receipts })).toThrow();
      expect(existsSync(fixture.args.recipe.outfile)).toBe(false);
      expect(existsSync(join(fixture.args.bank, fixture.args.publicationLeaf!))).toBe(false);
    });

  it('BG ancillary asset custody refuses source drift and never adopts an existing copied destination', async () => {
    const fixture = await transactionCandidate();
    fixture.args.assets = ancillaryAssets();
    const transaction = prepareBgVerifierBuildTransaction(fixture.args);
    const binding = beginBgVerifierBuildTransaction({ transaction, ownerPid: process.pid });
    const path = join(fixture.prepared.root, fixture.args.assets[0]!.source);
    const original = readFileSync(path);
    writeFileSync(path, 'changed source');
    expect(() => stageBgVerifierAssetCopies(binding)).toThrow();
    expect(readdirSync(fixture.stage)).toEqual([]);
    writeFileSync(path, original);
    stageBgVerifierAssetCopies(binding);
    const copied = join(fixture.stage, fixture.args.assets[0]!.temporary.replaceAll('@BG_PID@', String(process.pid)));
    const before = statSync(copied);
    expect(() => stageBgVerifierAssetCopies(binding)).toThrow(/EEXIST/);
    expect(statSync(copied).ino).toBe(before.ino);
    expect(readFileSync(copied)).toEqual(original);
  });

  it('BG recipe output-only mode retains failed later compiler diagnostics without publishing or replaying a partial set', async () => {
    const fixture = await transactionRecipe(args => {
      args.invocations[1]!.argv.push('--define:BG_RECIPE_INVALID=not a valid expression');
    });
    const child = fixture.runRecipe({ publishOnly: true });
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain('Invalid define value');
    expect(child.stdout).toBe('');
    const bindingPath = join(fixture.stage, '.bg-build-binding.json');
    const bindingBytes = readFileSync(bindingPath);
    const binding = JSON.parse(bindingBytes.toString('utf8'));
    expect(binding.ownerPid).toBe(child.pid);
    expect(existsSync(join(fixture.stage, binding.outputs[0].temporary))).toBe(true);
    expect(existsSync(join(fixture.stage, binding.outputs[2].temporary))).toBe(false);
    expect(existsSync(fixture.args.recipe.outfile)).toBe(false);
    expect(existsSync(join(fixture.args.bank, fixture.args.publicationLeaf!))).toBe(false);
    const replay = fixture.runRecipe({ publishOnly: true });
    expect(replay.status).not.toBe(0);
    expect(replay.stderr).toContain('BG transaction stage already exists');
    expect(readFileSync(bindingPath)).toEqual(bindingBytes);
  });

  it('BG recipe output-only mode requires its original publication destination before any build effect', async () => {
    const fixture = await transactionRecipe(args => { args.publicationLeaf = undefined; });
    const child = fixture.runRecipe({ publishOnly: true });
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain('BG recipe publication destination is UNKNOWN');
    expect(existsSync(fixture.stage)).toBe(false);
    expect(readdirSync(fixture.args.bank)).toEqual([]);
  });

  it('binds the maintained BG recipe CLI and actual shell PID before its first build effect', async () => {
    const fixture = await transactionRecipe();
    const receipt = readFileSync(join(fixture.prepared.root, '.verifier-source.json'));
    const child = fixture.runRecipe();
    expectBgChild(child, fixture.recipePhases(child.pid));
    const contextPath = join(fixture.stage, '.bg-build-context.json');
    expect(child.stdout.trim()).toBe('BG_BUILD_BINDING_PASS ' + contextPath);
    const binding = JSON.parse(readFileSync(join(fixture.stage, '.bg-build-binding.json'), 'utf8'));
    expect(binding.ownerPid).toBe(child.pid);
    expect(binding.transactionSha256).toBe(digest(fixture.bytes));
    expect(binding.transaction).toEqual(fixture.transaction);
    expect(JSON.parse(readFileSync(contextPath, 'utf8'))).toEqual(binding.contexts);
    expect(readdirSync(fixture.stage).sort()).toEqual(['.bg-build-binding.json', '.bg-build-context.json']);
    expect(readFileSync(fixture.path, 'utf8')).toBe(fixture.bytes);
    expect(readFileSync(join(fixture.prepared.root, '.verifier-source.json'))).toEqual(receipt);
    writeFileSync(fixture.contextPath, JSON.stringify(binding.contexts));
    for (const entry of [...binding.contexts.invocations].reverse()) {
      const compiled = fixture.run(entry.invocation.argv);
      expect({ status: compiled.status, stderr: compiled.stderr }).toEqual({ status: 0, stderr: '' });
    }
    const imported = await import('data:text/javascript;base64,'
      + readFileSync(join(fixture.stage, binding.outputs[0].temporary)).toString('base64'));
    expect(imported.dep).toBe(41);
    const replay = fixture.runRecipe();
    expect(replay.status).not.toBe(0);
    expect(replay.stderr).toContain('BG transaction stage already exists');
    expect(JSON.parse(readFileSync(join(fixture.stage, '.bg-build-binding.json'), 'utf8'))).toEqual(binding);
  });

  it.each(['digest', 'entry', 'outfile', 'profile', 'extra', 'source', 'dependency', 'original-record',
    'unqualified-publication', 'ambient-node-options', 'ambient-node-path'] as const)(
    'refuses maintained BG recipe %s before stage, log, cache acquisition or compiler effects', async defect => {
      const fixture = await transactionRecipe();
      const changes: Parameters<typeof fixture.runRecipe>[0] = {};
      if (defect === 'digest') changes.digest = '0'.repeat(64);
      if (defect === 'entry') changes.entry = join(fixture.prepared.root, 'packages/core/index.ts');
      if (defect === 'outfile') changes.outfile = join(fixture.args.bank, 'foreign.mjs');
      if (defect === 'profile') changes.profile = 'development';
      if (defect === 'extra') changes.extra = ['unexpected'];
      if (defect === 'unqualified-publication') changes.bindingOnly = false;
      if (defect === 'ambient-node-options') changes.environment = { NODE_OPTIONS: '--no-warnings' };
      if (defect === 'ambient-node-path') changes.environment = { NODE_PATH: '/foreign-node-modules' };
      if (defect === 'source') writeFileSync(join(fixture.prepared.root, inputs[0]!), 'export default 999;');
      if (defect === 'dependency') writeFileSync(join(fixture.prepared.root, 'node_modules/fixture-dependency/index.js'), 'export default 999;');
      if (defect === 'original-record') writeFileSync(fixture.path, fixture.bytes + '\n');
      const child = fixture.runRecipe(changes);
      expect(child.status).not.toBe(0);
      expect(child.stderr).toMatch(defect === 'source' || defect === 'dependency'
        ? /tampered verification|BG |changed|mismatch/ : /BG (transaction|recipe)/);
      expect(existsSync(fixture.stage)).toBe(false);
      expect(readdirSync(fixture.args.bank)).toEqual([]);
    });

  it('binds original PID-temporary commands before real main and worker compilation in an owned bank', async () => {
    const fixture = await transactionCandidate();
    const transaction = prepareBgVerifierBuildTransaction(fixture.args);
    const original = JSON.stringify(transaction), receipt = readFileSync(join(fixture.prepared.root, '.verifier-source.json'));
    expect(existsSync(fixture.stage)).toBe(false);
    const binding = beginBgVerifierBuildTransaction({ transaction, ownerPid: process.pid });
    expect(JSON.stringify(transaction)).toBe(original);
    expect(binding.transactionSha256).toBe(digest(original));
    writeFileSync(fixture.contextPath, JSON.stringify(binding.contexts));
    for (const entry of [...binding.contexts.invocations].reverse()) {
      const result = fixture.run(entry.invocation.argv);
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      expect(JSON.parse(result.stdout).argv).toEqual(entry.invocation.argv);
    }
    for (const output of binding.outputs) expect(existsSync(join(fixture.stage, output.temporary))).toBe(true);
    const imported = await import('data:text/javascript;base64,'
      + readFileSync(join(fixture.stage, binding.outputs[0]!.temporary)).toString('base64'));
    expect(imported.dep).toBe(41);
    expect(() => beginBgVerifierBuildTransaction({ transaction, ownerPid: process.pid + 1 }))
      .toThrow('BG transaction stage already exists');
    expect(readFileSync(join(fixture.prepared.root, '.verifier-source.json'))).toEqual(receipt);
    expect(existsSync(fixture.entry)).toBe(false);
  });

  async function compiledTransaction(configure?: Parameters<typeof transactionRecipe>[0]) {
    const trace = (stage: string) => { if (process.env.PAPERCUSP_BG_LOGICAL_TRACE) process.stderr.write(`BG_LOGICAL_STAGE ${Date.now()} ${stage}\n`); };
    trace('fixture-start');
    const fixture = await transactionRecipe(configure);
    trace('fixture-ready');
    const child = fixture.runRecipe();
    trace('binding-ready');
    expectBgChild(child);
    const binding = JSON.parse(readFileSync(join(fixture.stage, '.bg-build-binding.json'), 'utf8')) as
      ReturnType<typeof beginBgVerifierBuildTransaction>;
    writeFileSync(fixture.contextPath, JSON.stringify(binding.contexts));
    const receipts = [];
    for (const entry of [...binding.contexts.invocations].reverse()) {
      const result = fixture.run(entry.invocation.argv);
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      receipts.push(JSON.parse(result.stdout) as Awaited<ReturnType<typeof compileBgVerifierInvocation>>);
      trace('compiler-ready');
    }
    return { ...fixture, binding, receipts };
  }

  it('qualifies the whole-output set from actual main and worker compiler receipts without publishing', async () => {
    const fixture = await compiledTransaction();
    const receipt = readFileSync(join(fixture.prepared.root, '.verifier-source.json'));
    const original = JSON.stringify(fixture.binding);
    const output = qualifyBgVerifierBuildOutputSet(fixture);
    expect(output.files.map(row => row.temporary)).toEqual(fixture.binding.outputs.map(row => row.temporary));
    expect(output.files.every(row => row.identity?.sha256.length === 64)).toBe(true);
    expect(output.bindingSha256).toBe(digest(original));
    expect(output.compilerReceiptsSha256).toBe(digest(JSON.stringify(fixture.receipts)));
    expect(Object.isFrozen(output.files[0]!.identity)).toBe(true);
    expect(verifyBgVerifierBuildOutputSet(output, fixture)).toBe(output);
    expect(JSON.stringify(fixture.binding)).toBe(original);
    expect(readFileSync(join(fixture.prepared.root, '.verifier-source.json'))).toEqual(receipt);
    for (const row of fixture.binding.outputs) expect(existsSync(join(fixture.stage, row.final))).toBe(false);
  });

  it.each(['missing-receipt', 'duplicate-receipt', 'receipt-record', 'receipt-metafile', 'missing-output',
    'changed-output', 'replaced-identical-output', 'changed-metafile', 'extra-output', 'extra-directory', 'symlink', 'hardlink',
    'binding-membership', 'control-record', 'source', 'dependency', 'stage'] as const)(
    'rejects whole-output %s after compilation while preserving the retained qualification', async defect => {
      const fixture = await compiledTransaction();
      const output = qualifyBgVerifierBuildOutputSet(fixture), original = JSON.stringify(output);
      const first = fixture.receipts[0]!, path = first.output.path;
      if (defect === 'missing-receipt') fixture.receipts.pop();
      if (defect === 'duplicate-receipt') fixture.receipts[1] = first;
      if (defect === 'receipt-record') first.buildRecordSha256 = '0'.repeat(64);
      if (defect === 'receipt-metafile') delete first.metafile;
      if (defect === 'missing-output') rmSync(path);
      if (defect === 'changed-output') writeFileSync(path, 'changed bundle');
      if (defect === 'replaced-identical-output') {
        const bytes = readFileSync(path);
        await fsPromises.rename(path, path + '-original');
        writeFileSync(path, bytes);
        rmSync(path + '-original');
      }
      if (defect === 'changed-metafile') writeFileSync(first.metafile!.path, '{}');
      if (defect === 'extra-output') writeFileSync(join(fixture.stage, 'unrecorded'), 'extra');
      if (defect === 'extra-directory') await fsPromises.mkdir(join(fixture.stage, 'unrecorded'));
      if (defect === 'symlink' || defect === 'hardlink') {
        const originalPath = join(fixture.args.bank, 'outside-stage');
        await fsPromises.rename(path, originalPath);
        if (defect === 'symlink') symlinkSync(originalPath, path);
        else linkSync(originalPath, path);
      }
      if (defect === 'binding-membership') fixture.binding.outputs[0]!.final = 'foreign.mjs';
      if (defect === 'control-record') writeFileSync(join(fixture.stage, '.bg-build-binding.json'), '{}');
      if (defect === 'source') writeFileSync(join(fixture.prepared.root, inputs[0]!), 'export default 999;');
      if (defect === 'dependency') writeFileSync(join(fixture.prepared.root, 'node_modules/fixture-dependency/index.js'), 'changed');
      if (defect === 'stage') {
        await fsPromises.rename(fixture.stage, fixture.stage + '-original');
        await fsPromises.mkdir(fixture.stage);
      }
      expect(() => verifyBgVerifierBuildOutputSet(output, fixture)).toThrow();
      expect(JSON.stringify(output)).toBe(original);
      for (const row of fixture.binding.outputs) expect(existsSync(join(fixture.stage, row.final))).toBe(false);
    });

  async function logicalTransaction(configure?: Parameters<typeof transactionRecipe>[0]) {
    const fixture = await compiledTransaction(configure);
    if (process.env.PAPERCUSP_BG_LOGICAL_TRACE) process.stderr.write(`BG_LOGICAL_STAGE ${Date.now()} qualify-temporary\n`);
    const output = qualifyBgVerifierBuildOutputSet(fixture);
    return { ...fixture, output };
  }

  it('logical-output qualification retains real main/worker inodes and boot-readable artifact paths', async () => {
    const fixture = await logicalTransaction();
    const original = JSON.stringify(fixture.binding);
    const sourceReceipt = readFileSync(join(fixture.prepared.root, '.verifier-source.json'));
    if (process.env.PAPERCUSP_BG_LOGICAL_TRACE) process.stderr.write(`BG_LOGICAL_STAGE ${Date.now()} logical-start\n`);
    const logical = qualifyBgVerifierLogicalOutputSet(fixture);
    if (process.env.PAPERCUSP_BG_LOGICAL_TRACE) process.stderr.write(`BG_LOGICAL_STAGE ${Date.now()} logical-ready\n`);
    expect(verifyBgVerifierLogicalOutputSet(logical, fixture)).toBe(logical);
    expect(Object.isFrozen(logical.files[0]!.identity)).toBe(true);
    for (const [index, row] of logical.files.entries()) {
      expect(existsSync(join(fixture.stage, row.temporary))).toBe(false);
      expect(row.identity.ino).toBe(fixture.output.files[index]!.identity!.ino);
      expect(statSync(row.identity.path).nlink).toBe(1);
    }
    const entry = join(fixture.stage, 'hono-host.mjs');
    const boot = measureBootOperatorArtifact(entry, fixture.prepared.source.sourceCommit, Date.now() + 1000);
    if (process.env.PAPERCUSP_BG_LOGICAL_TRACE) process.stderr.write(`BG_LOGICAL_STAGE ${Date.now()} boot-ready\n`);
    expect(boot.status).toBe('measured');
    expect(JSON.stringify(fixture.binding)).toBe(original);
    expect(readFileSync(join(fixture.prepared.root, '.verifier-source.json'))).toEqual(sourceReceipt);
    const imported = await import('data:text/javascript;base64,' + readFileSync(entry).toString('base64'));
    if (process.env.PAPERCUSP_BG_LOGICAL_TRACE) process.stderr.write(`BG_LOGICAL_STAGE ${Date.now()} import-ready\n`);
    expect(imported.dep).toBe(41);
  });

  it('logical-output publication atomically exposes a complete independently readable receipt', async () => {
    const fixture = await logicalTransaction(), logical = qualifyBgVerifierLogicalOutputSet(fixture);
    const publication = publishBgVerifierLogicalOutputSet({ ...fixture, logical });
    if (process.env.PAPERCUSP_BG_LOGICAL_TRACE) process.stderr.write(`BG_LOGICAL_STAGE ${Date.now()} publication-ready\n`);
    expect(publication.identity.path).toBe(join(fixture.args.bank, fixture.args.publicationLeaf!));
    expect(JSON.parse(readFileSync(publication.identity.path, 'utf8'))).toEqual({
      schemaVersion: 'bg-build-publication-v1', logical, binding: fixture.binding,
      receipts: fixture.receipts, output: fixture.output,
    });
    expect(verifyBgVerifierPublication(publication, { ...fixture, logical })).toBe(publication);
  });

  it('logical-output publication replay preserves the original complete receipt', async () => {
    const fixture = await logicalTransaction(), logical = qualifyBgVerifierLogicalOutputSet(fixture);
    const publication = publishBgVerifierLogicalOutputSet({ ...fixture, logical });
    const bytes = readFileSync(publication.identity.path);
    expect(() => publishBgVerifierLogicalOutputSet({ ...fixture, logical })).toThrow();
    expect(readFileSync(publication.identity.path)).toEqual(bytes);
    expect(existsSync(publication.identity.path + '.tmp.' + fixture.binding.ownerPid)).toBe(false);
  });

  it.each(['metafile-name', 'output-directory'] as const)(
    'logical-output rejects original %s mismatch before converting any temporary file', async defect => {
      const fixture = await logicalTransaction(args => {
        if (defect === 'metafile-name') args.outputs[1]!.final = 'wrong.mjs';
        else {
          args.outputs[2]!.final = 'nested/worker.mjs';
          args.outputs[3]!.final = 'nested/worker.mjs.meta.json';
        }
      });
      expect(() => qualifyBgVerifierLogicalOutputSet(fixture)).toThrow(/BG logical/);
      for (const row of fixture.output.files) expect(existsSync(join(fixture.stage, row.temporary))).toBe(true);
      expect(existsSync(join(fixture.args.bank, fixture.args.publicationLeaf!))).toBe(false);
    });

  it.each(['source', 'dependency', 'bundle', 'metafile', 'artifact', 'control', 'extra-file', 'extra-directory',
    'identical-replacement', 'stage', 'receipt', 'output-record'] as const)(
    'logical-output refuses %s drift before publication and preserves its original qualification', async defect => {
      const fixture = await logicalTransaction();
      const logical = qualifyBgVerifierLogicalOutputSet(fixture), original = JSON.stringify(logical);
      if (defect === 'source') writeFileSync(join(fixture.prepared.root, inputs[0]!), 'export default 999;');
      if (defect === 'dependency') writeFileSync(join(fixture.prepared.root, 'node_modules/fixture-dependency/index.js'), 'changed');
      if (defect === 'bundle') writeFileSync(logical.files[0]!.identity.path, 'changed');
      if (defect === 'metafile') writeFileSync(logical.files[1]!.identity.path, '{}');
      if (defect === 'artifact') writeFileSync(logical.artifact.manifest.path, '{}');
      if (defect === 'control') writeFileSync(join(fixture.stage, '.bg-build-binding.json'), '{}');
      if (defect === 'extra-file') writeFileSync(join(fixture.stage, 'unrecorded'), 'extra');
      if (defect === 'extra-directory') await fsPromises.mkdir(join(fixture.stage, 'unrecorded'));
      if (defect === 'identical-replacement') {
        const path = logical.files[0]!.identity.path, bytes = readFileSync(path);
        await fsPromises.rename(path, path + '-original');
        writeFileSync(path, bytes);
        rmSync(path + '-original');
      }
      if (defect === 'stage') {
        await fsPromises.rename(fixture.stage, fixture.stage + '-original');
        await fsPromises.mkdir(fixture.stage);
      }
      if (defect === 'receipt') fixture.receipts[0]!.buildRecordSha256 = '0'.repeat(64);
      if (defect === 'output-record') fixture.output = { ...fixture.output, bindingSha256: '0'.repeat(64) };
      expect(() => publishBgVerifierLogicalOutputSet({ ...fixture, logical })).toThrow();
      expect(JSON.stringify(logical)).toBe(original);
      expect(existsSync(join(fixture.args.bank, fixture.args.publicationLeaf!))).toBe(false);
    });

  it.each(['file', 'directory', 'dangling-link', 'unowned-temporary', 'unnominated'] as const)(
    'logical-output publication refuses %s without overwriting or removing it', async defect => {
      const fixture = await logicalTransaction(args => {
        if (defect === 'unnominated') args.publicationLeaf = undefined;
      });
      const logical = qualifyBgVerifierLogicalOutputSet(fixture);
      const path = join(fixture.args.bank, 'published-build.json');
      const target = defect === 'unowned-temporary' ? path + '.tmp.' + fixture.binding.ownerPid : path;
      if (defect === 'file' || defect === 'unowned-temporary') writeFileSync(target, 'another producer');
      if (defect === 'directory') await fsPromises.mkdir(target);
      if (defect === 'dangling-link') symlinkSync(join(fixture.args.bank, 'missing'), target);
      expect(() => publishBgVerifierLogicalOutputSet({ ...fixture, logical })).toThrow();
      if (defect === 'file' || defect === 'unowned-temporary') expect(readFileSync(target, 'utf8')).toBe('another producer');
      if (defect === 'directory') expect(readdirSync(target)).toEqual([]);
      if (defect === 'dangling-link') expect((await fsPromises.lstat(target)).isSymbolicLink()).toBe(true);
      if (defect === 'unnominated') expect(existsSync(path)).toBe(false);
      expect(verifyBgVerifierLogicalOutputSet(logical, fixture)).toBe(logical);
    });

  it.each(['receipt-bytes', 'receipt-replacement', 'worker', 'binding-evidence', 'compiler-evidence', 'output-evidence'] as const)(
    'logical-output publication readback refuses later %s replacement', async defect => {
      const fixture = await logicalTransaction(), logical = qualifyBgVerifierLogicalOutputSet(fixture);
      const publication = publishBgVerifierLogicalOutputSet({ ...fixture, logical });
      const path = publication.identity.path, bytes = readFileSync(path);
      if (defect === 'receipt-bytes') writeFileSync(path, '{}');
      if (defect === 'receipt-replacement') {
        await fsPromises.rename(path, path + '-original');
        writeFileSync(path, bytes);
        rmSync(path + '-original');
      }
      if (defect === 'worker') writeFileSync(join(fixture.stage, 'worker.mjs'), 'changed worker');
      if (defect.endsWith('-evidence')) {
        const altered = JSON.parse(JSON.stringify(publication));
        if (defect === 'binding-evidence') altered.binding.ownerPid++;
        if (defect === 'compiler-evidence') altered.receipts[0].argv.push('--keep-names');
        if (defect === 'output-evidence') altered.output.files.pop();
        expect(() => verifyBgVerifierPublication(altered, { ...fixture, logical }))
          .toThrow('BG publication original evidence changed');
        expect(readFileSync(path)).toEqual(bytes);
        return;
      }
      expect(() => verifyBgVerifierPublication(publication, { ...fixture, logical })).toThrow();
    });

  it.each(['missing-output', 'extra-output', 'duplicate-final', 'escape', 'pid-switch', 'pid-directory'] as const)(
    'refuses transaction %s before stage creation or compiler acquisition', async defect => {
      const { args, stage } = await transactionCandidate();
      if (defect === 'missing-output') args.outputs.pop();
      if (defect === 'extra-output') args.outputs.push({ temporary: 'unobserved', final: 'extra' });
      if (defect === 'duplicate-final') args.outputs[1]!.final = args.outputs[0]!.final;
      if (defect === 'escape') args.invocations[0]!.argv = args.invocations[0]!.argv.map(arg =>
        arg.replaceAll(stage, dirname(stage)));
      if (defect === 'pid-switch') args.invocations[0]!.argv.push('--define:OWNER=@BG_PID@');
      if (defect === 'pid-directory') args.invocations[0]!.argv = args.invocations[0]!.argv.map(arg =>
        arg.replaceAll('hono-host.mjs.tmp.@BG_PID@', '@BG_PID@/hono-host.mjs.tmp.@BG_PID@'));
      expect(() => prepareBgVerifierBuildTransaction(args)).toThrow(defect === 'duplicate-final'
        ? 'BG transaction logical output duplicated' : defect === 'escape' ? 'BG transaction compiler output escaped stage'
          : defect.startsWith('pid-') ? 'BG transaction PID token is outside' : 'BG transaction compiler output membership mismatch');
      expect(existsSync(stage)).toBe(false);
    });

  it.each(['builder', 'compiler', 'node', 'packageManager', 'configuration', 'environment'] as const)(
    'BG shared input validation refuses non-first %s divergence at both binding boundaries', async field => {
      const fixture = await transactionCandidate();
      const transaction = prepareBgVerifierBuildTransaction(fixture.args);
      const diverge = (invocation: Parameters<typeof prepareBgVerifierBuildRecord>[0]['invocation']) => {
        if (field === 'environment') invocation.environment = { ...invocation.environment, PATH: '/unaccepted' };
        else if (field === 'configuration') invocation.configuration = [];
        else invocation[field] = field === 'node' ? fixture.invocation.packageManager : fixture.invocation.node;
      };
      const changed = JSON.parse(JSON.stringify(transaction)) as typeof transaction;
      diverge(changed.contexts.invocations[1]!.invocation);
      expect(() => beginBgVerifierBuildTransaction({ transaction: changed, ownerPid: process.pid })).toThrow();
      expect(existsSync(fixture.stage)).toBe(false);
      const binding = beginBgVerifierBuildTransaction({ transaction, ownerPid: process.pid });
      const changedBinding = JSON.parse(JSON.stringify(binding)) as typeof binding;
      diverge(changedBinding.contexts.invocations[1]!.invocation);
      expect(() => stageBgVerifierAssetCopies(changedBinding)).toThrow('BG output original contexts changed');
      expect(readdirSync(fixture.stage)).toEqual([]);
      expect(existsSync(join(fixture.args.bank, fixture.args.publicationLeaf!))).toBe(false);
    });

  it.each(['pid', 'stage', 'bank-link', 'bank-replaced', 'source', 'dependency'] as const)(
    'refuses transaction binding after %s changes the original pre-effect contract', async defect => {
      const { args, stage, prepared } = await transactionCandidate();
      const transaction = prepareBgVerifierBuildTransaction(args);
      if (defect === 'stage') writeFileSync(stage, 'another attempt');
      if (defect === 'bank-link' || defect === 'bank-replaced') {
        await fsPromises.rename(args.bank, args.bank + '-original');
        if (defect === 'bank-link') symlinkSync(args.bank + '-original', args.bank, 'dir');
        else await fsPromises.mkdir(args.bank);
      }
      if (defect === 'source') writeFileSync(join(prepared.root, inputs[0]!), 'export default 999;');
      if (defect === 'dependency') writeFileSync(join(prepared.root, 'node_modules/fixture-dependency/index.js'), 'export default 999;');
      expect(() => beginBgVerifierBuildTransaction({ transaction, ownerPid: defect === 'pid' ? 0 : process.pid })).toThrow();
      if (defect !== 'stage') expect(existsSync(stage)).toBe(false);
    });

  it.each(['bank', 'stage'] as const)('refuses transaction %s replacement after binding before compilation', async defect => {
    const fixture = await transactionCandidate();
    const transaction = prepareBgVerifierBuildTransaction(fixture.args);
    const binding = beginBgVerifierBuildTransaction({ transaction, ownerPid: process.pid });
    writeFileSync(fixture.contextPath, JSON.stringify(binding.contexts));
    const replaced = defect === 'bank' ? fixture.args.bank : fixture.stage;
    await fsPromises.rename(replaced, replaced + '-original');
    await fsPromises.mkdir(replaced);
    for (const check of [true, false]) {
      const result = fixture.run(binding.contexts.invocations[0]!.invocation.argv, check);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('BG build output namespace changed');
      expect(result.stderr).not.toContain('unexpected-cache-fallback');
    }
    for (const output of binding.outputs) expect(existsSync(join(fixture.stage, output.temporary))).toBe(false);
  });

  it('dispatches original per-entry contexts through the maintained shell in either order without npm resolution', async () => {
    const fixture = await maintainedCompilerContexts();
    const original = readFileSync(fixture.contextPath);
    const checked = fixture.run([], true);
    expect({ status: checked.status, stderr: checked.stderr }).toEqual({ status: 0, stderr: '' });
    for (const argv of [fixture.worker.argv, fixture.argv]) {
      const result = fixture.run(argv);
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      expect(JSON.parse(result.stdout).argv).toEqual(argv);
    }
    const worker = await import('data:text/javascript;base64,' + readFileSync(fixture.workerEntry).toString('base64'));
    const main = await import('data:text/javascript;base64,' + readFileSync(fixture.entry).toString('base64'));
    expect({ worker: worker.y, main: main.dep }).toEqual({ worker: 2, main: 41 });
    expect(readFileSync(fixture.contextPath)).toEqual(original);
  });

  it.each(['changed-argv', 'changed-original', 'duplicate-command', 'duplicate-output', 'foreign-identity'] as const)(
    'refuses %s in per-entry contexts before output or cache fallback', async defect => {
      const fixture = await maintainedCompilerContexts();
      const contexts = JSON.parse(JSON.stringify(fixture.contexts));
      let argv = fixture.argv;
      if (defect === 'changed-argv') argv = [...argv, '--keep-names'];
      if (defect === 'changed-original') contexts.invocations[1].invocation.argv.push('--keep-names');
      if (defect === 'duplicate-command') contexts.invocations.push(contexts.invocations[0]);
      if (defect === 'duplicate-output') {
        for (const key of ['invocation', 'original']) contexts.invocations[1][key].argv =
          fixture.worker.argv.map(arg => arg.replaceAll(fixture.workerEntry, fixture.entry));
      }
      if (defect === 'foreign-identity') contexts.invocations[1].original.environment.PATH = '/unaccepted';
      writeFileSync(fixture.contextPath, JSON.stringify(contexts));
      const checked = defect === 'changed-argv' ? null : fixture.run([], true);
      if (checked) expect(checked.status).not.toBe(0);
      const result = fixture.run(argv);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(defect === 'changed-argv' ? 'BG compiler argv is outside original invocation set'
        : defect === 'changed-original' ? 'BG invocation set changed original argv'
          : defect === 'duplicate-command' ? 'BG invocation set duplicated command'
            : defect === 'duplicate-output' ? 'BG invocation set duplicated output' : 'BG invocation set changed common build identity');
      expect(result.stderr).not.toContain('unexpected-cache-fallback');
      expect(existsSync(fixture.entry)).toBe(false);
      expect(existsSync(fixture.workerEntry)).toBe(false);
    });

  it('binds a distinct immutable output record through the maintained artifact writer', async () => {
    const { prepared, invocation, record, entry } = await outputCandidate();
    const original = readFileSync(join(prepared.root, '.verifier-source.json'));
    const originalRecord = JSON.stringify(record);
    const output = await qualifyBgVerifierOutput({ record, invocation, entry });
    expect(output.artifact.sourceBlobs).toEqual(prepared.acceptedManifest.members);
    expect(output.entry.sha256).toBe(digest(readFileSync(entry)));
    expect(output.manifest.sha256).toBe(digest(readFileSync(output.artifact.evidenceRef)));
    expect(output.buildRecordSha256).toBe(digest(originalRecord));
    expect(Object.isFrozen(output.artifact.sourceBlobs)).toBe(true);
    expect(verifyBgVerifierOutputRecord(output, record, invocation)).toBe(output);
    expect(JSON.stringify(record)).toBe(originalRecord);
    expect(readFileSync(join(prepared.root, '.verifier-source.json'))).toEqual(original);
  });

  it('refuses zero-exit compiler output with UNKNOWN artifact provenance', async () => {
    const { invocation, record, entry } = await outputCandidate();
    rmSync(entry + '.meta.json');
    await expect(qualifyBgVerifierOutput({ record, invocation, entry })).rejects.toThrow(/ENOENT/);
    expect(readdirSync(dirname(entry)).some(path => path.includes('.artifact-'))).toBe(false);
  });

  it.each(['omitted', 'added'] as const)('refuses %s artifact source membership without replacing the input record', async defect => {
    const { invocation, record, entry } = await outputCandidate();
    const meta = JSON.parse(readFileSync(entry + '.meta.json', 'utf8'));
    if (defect === 'omitted') delete meta.inputs['packages/core/index.ts'];
    else meta.inputs['libs/papercusp/package.json'] = { bytes: 1 };
    writeFileSync(entry + '.meta.json', JSON.stringify(meta));
    const before = JSON.stringify(record);
    await expect(qualifyBgVerifierOutput({ record, invocation, entry })).rejects.toThrow('BG output accepted member census mismatch');
    expect(JSON.stringify(record)).toBe(before);
  });

  it.each(['bundle', 'manifest', 'build-record', 'environment', 'dependency'] as const)(
    'refuses %s replacement after retaining the original output record', async defect => {
      const { prepared, invocation, record, entry } = await outputCandidate();
      const output = await qualifyBgVerifierOutput({ record, invocation, entry });
      const outputBytes = JSON.stringify(output), originalRecord = JSON.stringify(record);
      let supplied = record;
      if (defect === 'bundle') writeFileSync(entry, 'export default 99;');
      if (defect === 'manifest') writeFileSync(output.artifact.evidenceRef, '{}');
      if (defect === 'build-record') supplied = { ...record, invocation: { ...record.invocation, argv: [...record.invocation.argv, '--minify'] } };
      if (defect === 'environment') invocation.environment.PATH = '/unaccepted/bin';
      if (defect === 'dependency') writeFileSync(join(prepared.root, 'node_modules/fixture-dependency/index.js'), 'export default 99;\n');
      expect(() => verifyBgVerifierOutputRecord(output, supplied, invocation)).toThrow(defect === 'bundle'
        ? 'BG output bundle changed' : defect === 'manifest' ? 'BG output manifest changed'
          : defect === 'dependency' ? 'BG build dependency census changed' : 'BG builder configuration or toolchain identity changed');
      expect(JSON.stringify(output)).toBe(outputBytes);
      expect(JSON.stringify(record)).toBe(originalRecord);
    });
});

describe('D044 independent operator-api input handoff', () => {
  let fixture: Superproject;
  const input = 'apps/operator/src/index.ts';
  const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

  beforeAll(() => {
    fixture = makeSuperproject(join(tmp, 'd044-fixture'));
    // These fixture dependencies are normally tracked. The independent donor
    // must materialize its own dependencies after capturing source membership.
    git(fixture.repo, ['rm', '-r', 'node_modules', 'apps/operator/node_modules']);
    git(fixture.repo, ['commit', '-qm', 'independent materialization fixture']);
    fixture.commit = git(fixture.repo, ['rev-parse', 'HEAD']);
  });

  async function handoff() {
    const evidence = mkdtempSync(join(tmp, 'd044-case-'));
    const root = join(evidence, 'donor');
    const source = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit,
      dest: root, inputs: [input] });
    const sourceReceiptPath = join(evidence, 'source.json');
    writeFileSync(sourceReceiptPath, JSON.stringify(source));
    write(root, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
    symlinkSync('pkg/index.js', join(root, 'node_modules/relative.js'));
    const planned = {
      phase: 'planned', sourceCommit: source.sourceCommit, testPaths: [input],
      helperPaths: ['packages/core/index.ts'], configPaths: ['package-lock.json'],
      executedImports: [input], copiedSources: ['packages/core/index.ts'],
      copiedArtifacts: [{ path: 'copied-helper.ts', sourcePath: 'packages/core/index.ts' }],
      dependencyFiles: verifierSourceFiles(join(root, 'node_modules')),
      externalResolutions: { pkg: 'node_modules/pkg/index.js' },
      schema: { private: 'synthetic-applied-schema' }, environment: { MODE: digest('synthetic') },
      omitted: [] as string[], opaque: [] as string[],
    };
    const operatorApi = { root, sourceReceiptPath, sourceReceiptSha256: digest(readFileSync(sourceReceiptPath)),
      inputReceiptPath: join(evidence, 'planned.json'), inputReceiptSha256: '',
      outputPath: join(evidence, 'operator-api-preflight.json') };
    const repin = () => {
      writeFileSync(operatorApi.inputReceiptPath, JSON.stringify(planned));
      operatorApi.inputReceiptSha256 = digest(readFileSync(operatorApi.inputReceiptPath));
    };
    repin();
    const dest = join(evidence, 'export');
    return { planned, operatorApi, source, sourceReceiptPath, repin, dest,
      prepare: () => prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit,
        dest, inputs: [input], operatorApi }) };
  }

  it('copies pinned dependencies and relative symlinks and hands off the exact independent bytes', async () => {
    const c = await handoff();
    const receipt = await c.prepare();
    expect(receipt.operatorApiInputs).toEqual({ path: c.operatorApi.outputPath,
      sha256: c.operatorApi.inputReceiptSha256 });
    expect(readFileSync(c.operatorApi.outputPath)).toEqual(readFileSync(c.operatorApi.inputReceiptPath));
    expect(verifierSourceFiles(join(c.dest, 'node_modules'))).toEqual(c.planned.dependencyFiles);
    expect(await verifyVerifierSource(c.dest, receipt)).toEqual(receipt);
    const receiptPath = join(c.dest, '..', 'export-source.json');
    writeFileSync(receiptPath, JSON.stringify(receipt));
    expect(verifierSourceChildEnv({ root: c.dest, receiptPath }).VERIFY_TAURI_SOURCE_RECEIPT).toBe(receiptPath);
    writeFileSync(c.operatorApi.outputPath, '{}');
    expect(() => verifierSourceChildEnv({ root: c.dest, receiptPath })).toThrow('Pinned operator-api receipt changed');
  });

  it.each(['executedImports', 'schema', 'environment'] as const)(
    'refuses an absent independent %s observation before allocating the export', async key => {
      const c = await handoff();
      Object.assign(c.planned, { [key]: key === 'executedImports' ? [] : {} });
      c.repin();
      await expect(c.prepare()).rejects.toThrow('required observation missing');
      expect(existsSync(c.dest)).toBe(false);
      expect(existsSync(c.operatorApi.outputPath)).toBe(false);
    });

  it.each(['omitted', 'opaque'] as const)('refuses a required %s dimension before effects', async key => {
    const c = await handoff();
    c.planned[key].push('loaded-host');
    c.repin();
    await expect(c.prepare()).rejects.toThrow(`required dimensions ${key}`);
    expect(existsSync(c.dest)).toBe(false);
  });

  it('requires observed imports separately from static copied source membership', async () => {
    const c = await handoff();
    c.planned.executedImports = ['absent-observed-import.ts'];
    c.repin();
    await expect(c.prepare()).rejects.toThrow('source outside selected archive');
    expect(existsSync(c.dest)).toBe(false);
  });

  it.each(['source', 'dependency', 'receipt'] as const)('refuses %s byte drift before effects', async kind => {
    const c = await handoff();
    if (kind === 'source') writeFileSync(join(c.operatorApi.root, input), 'source drift');
    if (kind === 'dependency') writeFileSync(join(c.operatorApi.root, 'node_modules/pkg/index.js'), 'dependency drift');
    if (kind === 'receipt') writeFileSync(c.operatorApi.inputReceiptPath, '{}');
    await expect(c.prepare()).rejects.toThrow(/changed|census differs/);
    expect(existsSync(c.dest)).toBe(false);
    expect(existsSync(c.operatorApi.outputPath)).toBe(false);
  });

  it('refuses a selected tested-input pin that differs from the archived file', async () => {
    const c = await handoff();
    c.source.testedInputs[0].sha256 = '0'.repeat(64);
    writeFileSync(c.sourceReceiptPath, JSON.stringify(c.source));
    c.operatorApi.sourceReceiptSha256 = digest(readFileSync(c.sourceReceiptPath));
    await expect(c.prepare()).rejects.toThrow('tampered verification source provenance');
    expect(existsSync(c.dest)).toBe(false);
  });

  it('refuses absolute donor dependency links before allocation rather than rebasing their identity', async () => {
    const c = await handoff();
    const target = join(c.operatorApi.root, 'node_modules/pkg/index.js');
    symlinkSync(target, join(c.operatorApi.root, 'node_modules/absolute.js'));
    // Pin the supplied malformed identity without asking the maintained census
    // to validate it before the exporter gets a chance to refuse it.
    c.planned.dependencyFiles.push({ path: 'absolute.js', kind: 'symlink', executable: true, sha256: digest(target) });
    c.repin();
    const copy = vi.spyOn(fsPromises, 'cp');
    try {
      await expect(c.prepare()).rejects.toThrow('archive symlink escapes source root: absolute.js');
      expect(copy).not.toHaveBeenCalled();
      expect(existsSync(c.dest)).toBe(false);
      expect(existsSync(c.operatorApi.outputPath)).toBe(false);
    } finally { copy.mockRestore(); }
  });

  it('refuses a dependency link into an ambient tree before effects', async () => {
    const c = await handoff();
    symlinkSync('../../source.json', join(c.operatorApi.root, 'node_modules/ambient.js'));
    c.planned.dependencyFiles.push({ path: 'ambient.js', kind: 'symlink', executable: true,
      sha256: digest('../../source.json') });
    c.repin();
    await expect(c.prepare()).rejects.toThrow('archive symlink escapes source root: ambient.js');
    expect(existsSync(c.dest)).toBe(false);
  });

  it('refuses an internal handoff path even when reached through a symlinked parent', async () => {
    const c = await handoff();
    symlinkSync(c.dest, join(c.dest, '..', 'export-alias'));
    c.operatorApi.outputPath = join(c.dest, '..', 'export-alias', 'operator-api-preflight.json');
    await expect(c.prepare()).rejects.toThrow('receipt must be outside the archive');
    expect(existsSync(c.dest)).toBe(false);
  });

  it.each(['donor-source', 'export-source', 'planned-receipt'] as const)(
    'removes the new export when %s drifts during dependency copy', async kind => {
      const c = await handoff();
      const original = fsPromises.cp;
      const copy = vi.spyOn(fsPromises, 'cp').mockImplementation(async (...args) => {
        await original(...args);
        if (kind === 'donor-source') writeFileSync(join(c.operatorApi.root, input), 'racing source');
        if (kind === 'export-source') writeFileSync(join(c.dest, input), 'racing source');
        if (kind === 'planned-receipt') writeFileSync(c.operatorApi.inputReceiptPath, '{}');
      });
      try {
        await expect(c.prepare()).rejects.toThrow(/changed/);
        expect(existsSync(c.dest)).toBe(false);
        expect(existsSync(c.operatorApi.outputPath)).toBe(false);
      } finally { copy.mockRestore(); }
    });

  it.each(['partial-write', 'post-write-source-drift'] as const)(
    'removes only its newly created handoff after %s', async kind => {
      const c = await handoff();
      const original = fsPromises.open;
      const open = vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
        const handle = await original(...args);
        if (args[0] === c.operatorApi.outputPath) {
          const write = handle.writeFile.bind(handle);
          handle.writeFile = async (...writeArgs) => {
            await write(...writeArgs);
            if (kind === 'partial-write') throw new Error('synthetic partial handoff write');
            writeFileSync(join(c.dest, input), 'post-write source drift');
          };
        }
        return handle;
      });
      try {
        await expect(c.prepare()).rejects.toThrow(/synthetic partial handoff write|changed/);
        expect(existsSync(c.dest)).toBe(false);
        expect(existsSync(c.operatorApi.outputPath)).toBe(false);
      } finally { open.mockRestore(); }
    });

  it('preserves a preexisting handoff that wins the exclusive-create race', async () => {
    const c = await handoff();
    const original = fsPromises.cp;
    const copy = vi.spyOn(fsPromises, 'cp').mockImplementation(async (...args) => {
      await original(...args);
      writeFileSync(c.operatorApi.outputPath, 'independent existing handoff');
    });
    try {
      await expect(c.prepare()).rejects.toThrow(/EEXIST/);
      expect(existsSync(c.dest)).toBe(false);
      expect(readFileSync(c.operatorApi.outputPath, 'utf8')).toBe('independent existing handoff');
    } finally { copy.mockRestore(); }
  });

  it('preserves complete source-only export without an operator-api handoff', async () => {
    const dest = join(tmp, 'd044-source-only');
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    expect(receipt.operatorApiInputs).toBeUndefined();
    expect(await verifyVerifierSource(dest, receipt)).toEqual(receipt);
    expect(verifierSourceFiles(dest).filter(file => file.path !== '.verifier-source.json')).toEqual(receipt.files);
  });
});

describe('source-preview export — R-3 pinned, history-free snapshot', () => {
  it('records the superproject commit and every exported submodule gitlink in MANIFEST.json', () => {
    const onDisk = JSON.parse(readFileSync(join(out, 'MANIFEST.json'), 'utf8'));
    expect(onDisk).toEqual(manifest);
    expect(manifest.source.commit).toBe(fx.commit);
    expect(manifest.submodules).toEqual([{ path: 'libs/papercusp', sha: fx.subCommit }]);
    expect(manifest.fileCount).toBe(listFiles(out).length - ADDED_FILES.length);
  });

  it('refuses an unresolvable gitlink and leaves no export behind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'source-preview-ghost-'));
    try {
      const ghost = makeSuperproject(root);
      git(ghost.repo, ['update-index', '--cacheinfo', `160000,${'1'.repeat(40)},libs/papercusp`]);
      git(ghost.repo, ['commit', '-q', '-m', 'point the gitlink at a commit that does not exist']);
      const target = join(root, 'export');
      await expect(exportSnapshot({ repoRoot: ghost.repo, ref: 'main', out: target, env: childEnv() }))
        .rejects.toThrow(/unresolvable gitlink libs\/papercusp/);
      expect(existsSync(target)).toBe(false);
      expect(readdirSync(root).filter((n) => n.startsWith('export.partial'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('is deterministic: exporting the same commit twice yields identical bytes', async () => {
    const again = join(tmp, 'export-again');
    await exportSnapshot({ repoRoot: fx.repo, ref: 'main', out: again, env: childEnv() });
    const a = listFiles(out);
    expect(listFiles(again)).toEqual(a);
    for (const f of a) expect(readFileSync(join(again, f)), f).toEqual(readFileSync(join(out, f)));
  }, 120_000);

  it('exports only committed content, never uncommitted working-tree edits', async () => {
    write(fx.repo, 'apps/operator/src/index.ts', 'export const x = "uncommitted";\n');
    try {
      const snap = join(tmp, 'export-dirty');
      await exportSnapshot({ repoRoot: fx.repo, ref: 'main', out: snap, env: childEnv() });
      expect(readFileSync(join(snap, 'apps/operator/src/index.ts'), 'utf8')).toBe('export const x = 1;\n');
    } finally {
      git(fx.repo, ['checkout', '--', 'apps/operator/src/index.ts']);
    }
  }, 120_000);

  it('uses the pinned dependency graph and leaves dirty source, index and branch unchanged (D-007)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'source-preview-pin-'));
    try {
      const pinned = makeSuperproject(root);
      const pinnedLock = JSON.stringify({ lockfileVersion: 3, packages: {
        'node_modules/pinned-dependency': { version: '1.0.0', license: 'MIT' },
      } });
      write(pinned.repo, 'package-lock.json', pinnedLock);
      git(pinned.repo, ['add', 'package-lock.json']);
      git(pinned.repo, ['commit', '-q', '-m', 'pin dependency graph']);
      const ref = git(pinned.repo, ['rev-parse', 'HEAD']);
      // The installed/working tree deliberately disagrees with the pinned graph.
      write(pinned.repo, 'package-lock.json', '{"packages":{"node_modules/integration-only":{"version":"2"}}}\n');
      write(pinned.repo, 'node_modules/integration-only/index.js', 'module.exports = "integration-only";\n');
      write(pinned.repo, 'apps/operator/src/index.ts', 'export const staged = true;\n');
      git(pinned.repo, ['add', 'apps/operator/src/index.ts']);
      const state = () => ({
        head: git(pinned.repo, ['rev-parse', 'HEAD']),
        branch: git(pinned.repo, ['symbolic-ref', 'HEAD']),
        index: git(pinned.repo, ['diff', '--cached', '--binary']),
        worktree: git(pinned.repo, ['diff', '--binary']),
      });
      const before = state();
      expect(before.index).toContain('staged = true');
      expect(before.worktree).toContain('integration-only');
      const target = join(root, 'export');
      const { manifest: receipt } = await exportSnapshot({ repoRoot: pinned.repo, ref, out: target, env: childEnv() });
      expect(receipt.source.commit).toBe(ref);
      expect(receipt.submodules).toEqual([{ path: 'libs/papercusp', sha: pinned.subCommit }]);
      expect(readFileSync(join(target, 'package-lock.json'), 'utf8')).toBe(pinnedLock);
      expect(readFileSync(join(target, 'apps/operator/src/index.ts'), 'utf8')).toBe('export const x = 1;\n');
      expect(existsSync(join(target, 'node_modules'))).toBe(false);
      expect(readFileSync(join(pinned.repo, 'node_modules/integration-only/index.js'), 'utf8'))
        .toBe('module.exports = "integration-only";\n');
      expect(state()).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('source-preview export — R-4 evaluation notice', () => {
  it('writes a NOTICE restricting use to evaluation and forbidding redistribution', () => {
    const notice = readFileSync(join(out, 'NOTICE'), 'utf8');
    expect(notice).toMatch(/EVALUATION ONLY/);
    expect(notice).toMatch(/may not redistribute/);
    expect(notice).toContain(fx.commit);
  });

  it('dates the copyright from real history, not a fixed-date repair-queue admission commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'source-preview-year-'));
    try {
      const repo = makeSuperproject(root).repo;
      const real = Number(git(repo, ['show', '-s', '--format=%cd', '--date=format:%Y', 'HEAD']));
      const fixed = '2000-01-01T00:00:00Z';
      const r = spawnSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'admit 1 path(s) onto frozen lineage'], {
        encoding: 'utf8',
        env: childEnv({
          GIT_AUTHOR_NAME: 'gate', GIT_AUTHOR_EMAIL: 'gate@example.invalid', GIT_AUTHOR_DATE: fixed,
          GIT_COMMITTER_NAME: 'gate', GIT_COMMITTER_EMAIL: 'gate@example.invalid', GIT_COMMITTER_DATE: fixed,
        }),
      });
      expect(r.status, r.stderr).toBe(0);
      expect(git(repo, ['show', '-s', '--format=%cd', '--date=format:%Y', 'HEAD'])).toBe('2000');
      expect(sourceYear(repo, git(repo, ['rev-parse', 'HEAD']))).toBe(real);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('writes README.md naming the snapshot and the workspaces it contains', () => {
    const readme = readFileSync(join(out, 'README.md'), 'utf8');
    expect(readme).toContain(fx.commit);
    expect(readme).toContain('`apps/operator`');
    expect(readme).toContain('the operator host');
  });

  it('links the releases page and explains how and why the release carries this source', () => {
    const readme = readFileSync(join(out, 'README.md'), 'utf8');
    expect(readme).toContain('[Papercusp releases page](https://releases.example.invalid/fixture/index.html)');
    expect(readme).toMatch(/## How this source ships inside every release[\s\S]*`sidecar\/source\.tar\.zst`/);
    expect(readme).toMatch(/## Why the release carries its own source/);
  });

  it('refuses to export without a release host rather than publish a README with no download link', async () => {
    const target = join(tmp, 'export-no-release-host');
    await expect(exportSnapshot({ repoRoot: fx.repo, ref: 'main', out: target, env: childEnv({ PAPERCUSP_UPDATE_BASE_URL: '' }) }))
      .rejects.toThrow(/PAPERCUSP_UPDATE_BASE_URL is unset/);
    expect(existsSync(target)).toBe(false);
  });
});

describe('source-preview export — release host resolution', () => {
  it('fills the base URL from the release-host file only when the environment is silent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'source-preview-release-host-'));
    try {
      const file = join(dir, 'release-host.env');
      writeFileSync(file, '# comment\nPAPERCUSP_RELEASE_HOST=https://file.example.invalid/x\nPAPERCUSP_UPDATE_BASE_URL=https://file.example.invalid/x\n');
      const silent: NodeJS.ProcessEnv = {};
      loadReleaseHost(silent, file);
      expect(silent).toEqual({ PAPERCUSP_UPDATE_BASE_URL: 'https://file.example.invalid/x' });
      const exported: NodeJS.ProcessEnv = { PAPERCUSP_UPDATE_BASE_URL: 'https://env.example.invalid/y' };
      loadReleaseHost(exported, file);
      expect(releasesPageUrl(exported)).toBe('https://env.example.invalid/y/index.html');
      const none: NodeJS.ProcessEnv = {};
      loadReleaseHost(none, join(dir, 'missing.env'));
      expect(() => releasesPageUrl(none)).toThrow(/unset/);
      expect(() => releasesPageUrl({ PAPERCUSP_UPDATE_BASE_URL: 'http://plain.example.invalid' })).toThrow(/not an https URL/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
