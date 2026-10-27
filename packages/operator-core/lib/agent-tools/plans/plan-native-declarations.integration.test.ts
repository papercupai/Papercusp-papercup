/** Ordinary isolated repositories exercise the maintained citation -> declaration
 * pipeline. No mobile checkout, DB, native workload or authority grant is used. */
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { repoCitationDeps } from '../../plan-audits';
import { defaultReuseReferenceResolvers } from './plan-declaration-resolvers';
import { parseReuseRef, resolveReuseReferences, type ReuseDeclaration } from './plan-declarations';

vi.mock('@papercusp/flags/server', async (original) => ({
  ...await original<typeof import('@papercusp/flags/server')>(), getFlag: async () => true,
}));
vi.mock('../../code-intelligence/lsp-facade', async (original) => ({
  ...await original<typeof import('../../code-intelligence/lsp-facade')>(),
  lspFacade: async () => ({ error: 'isolated fixture has no LSP project', sites: [] }),
}));

describe('native declaration audit', () => {
  const declaration = (ref: string): ReuseDeclaration => ({ searched: [], newSurfaces: [], notApplicable: null,
    reused: [{ kind: 'file', ref, provides: 'existing source', items: ['P-001'] }] });
  async function fixture(check: (root: string, workspace: string) => Promise<void>) {
    const workspace = await mkdtemp(path.join(tmpdir(), 'native-audit-'));
    try {
      const root = path.join(workspace, 'parent');
      await mkdir(path.join(root, '.git'), { recursive: true });
      await mkdir(path.join(workspace, 'mobile', '.git'), { recursive: true });
      await writeFile(path.join(workspace, 'mobile', 'Cargo.toml'), '[package]\nname="native-app"\nversion="1.0.0"\n');
      await check(root, workspace);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }
  it('R-1 preserves canonical reference identity', async () => {
    await fixture(async (root, workspace) => {
      const report = await resolveReuseReferences(declaration('mobile/Cargo.toml'), {
        resolvers: defaultReuseReferenceResolvers({ repoRoot: root, citationDeps: repoCitationDeps(root) }),
        planItemIds: new Set(['P-001']),
      });
      expect(report.ok).toBe(true);
      expect(report.unverified).toEqual([]);
      expect(report.checks).toContainEqual(expect.objectContaining({ ref: 'mobile/Cargo.toml', status: 'found',
        detail: expect.stringContaining(path.join(workspace, 'mobile', 'Cargo.toml')) }));
    });
  });
  it('R-3 cannot grant admission or execution', async () => {
    await fixture(async (root, workspace) => {
      await writeFile(path.join(workspace, 'outside'), 'restricted source');
      await symlink(path.join(workspace, 'outside'), path.join(root, 'escape'));
      const resolvers = defaultReuseReferenceResolvers({ repoRoot: root, citationDeps: repoCitationDeps(root) });
      for (const ref of ['../outside', '/etc/passwd', 'escape', 'unknown/source']) {
        const report = await resolveReuseReferences(declaration(ref), { resolvers, planItemIds: new Set(['P-001']) });
        expect(report.checks.every((check) => check.status !== 'found')).toBe(true);
      }
      const invalidScope = await resolveReuseReferences(declaration('mobile/Cargo.toml'), { resolvers, planItemIds: new Set(['P-002']) });
      expect(invalidScope.ok).toBe(false);
      const offline = await resolveReuseReferences(declaration('mobile/Cargo.toml'), {
        resolvers: defaultReuseReferenceResolvers({ repoRoot: root, citationDeps: { locate: () => { throw new Error('fixture backend unavailable'); } } }),
        planItemIds: new Set(['P-001']),
      });
      expect(offline.ok).toBe(true);
      expect(offline.unverified).toContain('mobile/Cargo.toml');
      expect(offline.checks).toContainEqual(expect.objectContaining({ status: 'unverified', detail: expect.stringContaining('fixture backend unavailable') }));
      // The production resolver exposes evidence only; no execution/admission surface.
      expect(Object.keys(resolvers).sort()).toEqual(['doc', 'file', 'package', 'routine', 'symbol', 'table', 'tool']);
    });
  });
  it('certifies real grammar declarations rather than identifier occurrences', async () => {
    await fixture(async (root) => {
      const sources = [
        ['sample.ts', 'export function target() {}\nconst use = target;'],
        ['sample.js', 'function target() {}\nconst use = target;'],
        ['sample.rs', 'pub fn target() {}\nfn use_it() { target(); }'],
        ['sample.py', 'def target():\n  pass\nuse = target\n'],
        ['sample.go', 'package sample\nfunc target() {}\nfunc useIt() { target() }'],
      ];
      const resolvers = defaultReuseReferenceResolvers({ repoRoot: root, citationDeps: repoCitationDeps(root) });
      for (const [file, source] of sources) {
        await writeFile(path.join(root, file!), source!);
        const ref = parseReuseRef('symbol', file + '#target');
        if (!ref.ok) throw new Error(ref.detail);
        expect(await resolvers.symbol!(ref.parsed), file).toMatchObject({ outcome: 'found' });
      }
      await writeFile(path.join(root, 'occurrence.rs'), 'fn other() { target(); }');
      const ref = parseReuseRef('symbol', 'occurrence.rs#target');
      if (!ref.ok) throw new Error(ref.detail);
      expect(await resolvers.symbol!(ref.parsed)).toMatchObject({ outcome: 'unavailable' });
      await writeFile(path.join(root, 'constant.ts'), 'export const value = 1;');
      const unsupported = parseReuseRef('symbol', 'constant.ts#value');
      if (!unsupported.ok) throw new Error(unsupported.detail);
      expect(await resolvers.symbol!(unsupported.parsed)).toMatchObject({ outcome: 'unavailable' });
    });
  });
});
