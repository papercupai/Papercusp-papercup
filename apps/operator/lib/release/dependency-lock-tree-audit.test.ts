/**
 * WI-6554700010008514 — lock-vs-tree completeness audit for a dependency generation.
 * dependency-generation.sh indexed generation v1-7c590a4e under input 8f48c4a6 although its
 * trees lacked node_modules/sharp/node_modules/semver, and every gate verify sharing that
 * key went red on lint:reachable-advisories. These cases pin the audit that refuses such a
 * tree: a missing or wrong-version locked package is a defect, a missing OPTIONAL package
 * is not, and a workspace member's own lockfile is never audited against the enclosing
 * install's node_modules (measured false positive: libs/generic/resumable-download).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const HELPER = join(__dirname, '../../bin/release/dependency-lock-tree-audit.mjs');

interface Defect { kind: string; path: string; detail: string }
interface Decision { rel: string; status: string; owner?: string; entries: number; defects: number }
interface AuditSummary {
  lockfiles: number;
  audited: number;
  skipped: number;
  entries: number;
  defects: Defect[];
  decisions: Decision[];
}
interface AuditModule {
  auditTree(input: { treeRoot: string; lockRoot: string; lockfiles: string[] }): AuditSummary;
  lockfilesFromManifest(text: string): string[];
}
let mod: AuditModule;
beforeAll(async () => {
  mod = (await import(pathToFileURL(HELPER).href)) as AuditModule;
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lock-tree-audit-'));
  roots.push(root);
  return root;
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function install(root: string, rel: string, version: string): void {
  writeJson(join(root, rel, 'package.json'), { name: rel.split('node_modules/').pop(), version });
}
const lock = (packages: Record<string, Record<string, unknown>>) => ({
  name: 'r',
  lockfileVersion: 3,
  packages: { '': { name: 'r' }, ...packages },
});

/** The measured incident shape: sharp hoisted, its private semver nested under it. */
function sharpRoot(): string {
  const root = makeRoot();
  writeJson(
    join(root, 'package-lock.json'),
    lock({
      'node_modules/semver': { version: '6.3.1' },
      'node_modules/sharp': { version: '0.35.5' },
      'node_modules/sharp/node_modules/semver': { version: '7.8.5' },
      'node_modules/@img/sharp-darwin-arm64': { version: '0.35.5', optional: true },
    }),
  );
  install(root, 'node_modules/semver', '6.3.1');
  install(root, 'node_modules/sharp', '0.35.5');
  install(root, 'node_modules/sharp/node_modules/semver', '7.8.5');
  return root;
}

describe('auditTree', () => {
  it('passes a tree that realises every installed lock entry (optional platform package absent)', () => {
    const root = sharpRoot();
    const summary = mod.auditTree({ treeRoot: root, lockRoot: root, lockfiles: ['package-lock.json'] });
    expect(summary.defects).toEqual([]);
    expect(summary.audited).toBe(1);
    expect(summary.entries).toBe(4);
  });

  it('reports the missing nested package that broke the gate (sharp/node_modules/semver)', () => {
    const root = sharpRoot();
    rmSync(join(root, 'node_modules/sharp/node_modules'), { recursive: true });
    const summary = mod.auditTree({ treeRoot: root, lockRoot: root, lockfiles: ['package-lock.json'] });
    expect(summary.defects).toEqual([
      { kind: 'missing', path: 'node_modules/sharp/node_modules/semver', detail: 'locked 7.8.5' },
    ]);
  });

  it('reports a present package whose version differs from the lock, even when optional', () => {
    const root = sharpRoot();
    install(root, 'node_modules/sharp', '0.35.4');
    install(root, 'node_modules/@img/sharp-darwin-arm64', '0.35.4');
    const summary = mod.auditTree({ treeRoot: root, lockRoot: root, lockfiles: ['package-lock.json'] });
    expect(summary.defects.map((d) => `${d.kind} ${d.path}`).sort()).toEqual([
      'version-mismatch node_modules/@img/sharp-darwin-arm64',
      'version-mismatch node_modules/sharp',
    ]);
  });

  it('requires a link entry to exist and does not read a package.json through it', () => {
    const root = sharpRoot();
    const lockPath = join(root, 'package-lock.json');
    writeJson(
      lockPath,
      lock({
        'node_modules/sharp': { version: '0.35.5' },
        'node_modules/@papercusp/lib': { resolved: 'libs/lib', link: true },
      }),
    );
    let summary = mod.auditTree({ treeRoot: root, lockRoot: root, lockfiles: ['package-lock.json'] });
    expect(summary.defects).toEqual([
      { kind: 'missing-link', path: 'node_modules/@papercusp/lib', detail: '-> libs/lib' },
    ]);
    mkdirSync(join(root, 'node_modules/@papercusp'), { recursive: true });
    symlinkSync('../../libs/lib', join(root, 'node_modules/@papercusp/lib'));
    summary = mod.auditTree({ treeRoot: root, lockRoot: root, lockfiles: ['package-lock.json'] });
    expect(summary.defects).toEqual([]);
  });

  it('skips a workspace member lockfile owned by the enclosing install (resumable-download false positive)', () => {
    const root = sharpRoot();
    const member = 'libs/generic/resumable-download';
    writeJson(
      join(root, 'package-lock.json'),
      lock({
        [member]: { name: '@papercusp/resumable-download', version: '0.1.0' },
        'node_modules/@papercusp/resumable-download': { resolved: member, link: true },
        [`${member}/node_modules/vitest`]: { version: '4.1.10' },
      }),
    );
    mkdirSync(join(root, 'node_modules/@papercusp'), { recursive: true });
    symlinkSync(`../../${member}`, join(root, 'node_modules/@papercusp/resumable-download'));
    install(root, `${member}/node_modules/vitest`, '4.1.10');
    // The member's own lockfile pins different versions and packages the root hoisted away.
    writeJson(
      join(root, member, 'package-lock.json'),
      lock({ 'node_modules/vitest': { version: '4.1.9' }, 'node_modules/tinybench': { version: '2.9.0' } }),
    );
    const summary = mod.auditTree({
      treeRoot: root,
      lockRoot: root,
      lockfiles: [`${member}/package-lock.json`, 'package-lock.json'],
    });
    expect(summary.defects).toEqual([]);
    expect(summary.decisions).toEqual([
      // 2 installed entries: the member LINK and its nested vitest (the bare member key is a
      // workspace declaration, not installed content).
      { rel: 'package-lock.json', status: 'audited', entries: 2, defects: 0 },
      { rel: `${member}/package-lock.json`, status: 'workspace-member', owner: '.', entries: 0, defects: 0 },
    ]);
  });

  it('audits a standalone nested lockfile and skips one whose node_modules was never installed', () => {
    const root = sharpRoot();
    writeJson(join(root, 'desktop/package-lock.json'), lock({ 'node_modules/tauri': { version: '2.0.0' } }));
    writeJson(join(root, 'templates/x/package-lock.json'), lock({ 'node_modules/left-pad': { version: '1.0.0' } }));
    mkdirSync(join(root, 'desktop/node_modules'), { recursive: true });
    const summary = mod.auditTree({
      treeRoot: root,
      lockRoot: root,
      lockfiles: ['package-lock.json', 'desktop/package-lock.json', 'templates/x/package-lock.json'],
    });
    expect(summary.defects).toEqual([{ kind: 'missing', path: 'desktop/node_modules/tauri', detail: 'locked 2.0.0' }]);
    expect(summary.decisions.map((d) => `${d.status} ${d.rel}`)).toEqual([
      'audited package-lock.json',
      'audited desktop/package-lock.json',
      'not-installed templates/x/package-lock.json',
    ]);
  });
});

describe('lockfilesFromManifest', () => {
  it('keeps only lockfile rows from a dependency-input manifest', () => {
    expect(
      mod.lockfilesFromManifest('package-lock.json\taa\npatches/x+1.0.0.patch\tbb\ndesktop/npm-shrinkwrap.json\tcc\n'),
    ).toEqual(['package-lock.json', 'desktop/npm-shrinkwrap.json']);
  });
});

describe('CLI', () => {
  function run(root: string): { status: number | null; stdout: string } {
    const manifest = join(root, 'manifest');
    writeFileSync(manifest, 'package-lock.json\tdeadbeef\n');
    const res = spawnSync(process.execPath, [HELPER, '--tree-root', root, '--lock-root', root, '--manifest', manifest], {
      encoding: 'utf8',
    });
    return { status: res.status, stdout: res.stdout };
  }

  it('exits 0 with a summary line on a complete tree', () => {
    const { status, stdout } = run(sharpRoot());
    expect(status).toBe(0);
    expect(stdout).toContain('LOCK_TREE_AUDIT lockfiles=1 audited=1 skipped=0 entries=4 defects=0');
  });

  it('exits 3 and names each defect on an incomplete tree', () => {
    const root = sharpRoot();
    rmSync(join(root, 'node_modules/sharp/node_modules'), { recursive: true });
    const { status, stdout } = run(root);
    expect(status).toBe(3);
    expect(stdout).toContain('LOCK_TREE_DEFECT\tmissing\tnode_modules/sharp/node_modules/semver\tlocked 7.8.5');
  });

  it('exits 2 on misuse instead of reporting a vacuous pass', () => {
    const res = spawnSync(process.execPath, [HELPER, '--tree-root', makeRoot()], { encoding: 'utf8' });
    expect(res.status).toBe(2);
  });
});
