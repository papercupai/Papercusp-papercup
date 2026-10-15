/**
 * WI-10006543: graph:query callers from the first-party TypeScript backend.
 * Runs on a throwaway repo with the repo's own `typescript` and the host's `rg`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firstPartyCallers, findCandidateFiles, resolveRipgrep, resolveSearchPaths } from './first-party-callers';
import {
  incomingCallSites,
  openScopedTsTree,
  openTsTree,
  reExportStub,
  tsDeclarations,
  type TsTree,
} from './typescript-service';

const FILES: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true } }),
  // Two same-named declarations: grep never chooses, so the answer unions both.
  'src/a.ts': 'export function target(n: number): number {\n  return n + 1;\n}\n',
  'src/dependency.ts': 'export function helper(n: number) { return n + 1; }\n',
  'src/compose.ts': 'import { helper } from "./dependency";\nexport function compose(n: number) {\n  return helper(n);\n}\n',
  'src/model.ts': [
    'import { helper } from "./dependency";',
    'export interface Runner { run(n: number): number; }',
    'export class Base {',
    '  value = 0;',
    '  run(n: number) { return n; }',
    '}',
    'export class Derived extends Base implements Runner {',
    '  override run(n: number) {',
    '    this.value += helper(n);',
    '    return this.value;',
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/model-use.ts': [
    'import { Base, Derived } from "./model";',
    'const base = new Base();',
    'const derived = new Derived();',
    'base.value = 2;',
    'derived.value++;',
    'export const read = base.value;',
    'const dynamic: any = base;',
    'dynamic.value = 99;',
    'const other = { value: 0 };',
    'other.value = 3;',
    '',
  ].join('\n'),
  'src/b.test.ts': 'function target(): string {\n  return "stub";\n}\nexport const fromStub = target();\n',
  // The barrel does not contain the word, so it is served as a re-export stub.
  'src/barrel.ts': 'export * from "./a";\nexport const unrelated = 1;\n',
  'src/use.ts': [
    'import { target } from "./barrel";',
    '// target(1) in a comment is not a call',
    'const label = "target(2) in a string is not a call";',
    'export const viaBarrel = target(3);',
    'export const parsed = parseInt(label);',
    '',
  ].join('\n'),
  // An untyped receiver: the checker cannot say which `target` this is.
  'scripts/hook.mjs': 'export function run(client) {\n  return client.target(4);\n}\n',
};

let root = '';
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'first-party-callers-'));
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const lines = (sites: readonly { path: string; line1: number | null }[]): string[] =>
  sites.map((s) => `${s.path}:${s.line1}`).sort();

describe('unsupported caller scopes cannot certify an empty', () => {
  it.each([['rs', 'rust'], ['py', 'python'], ['go', 'go'], ['cpp', 'cpp']])(
    'refuses %s as a file or directory while preserving a genuine JS/TS absence', (extension, language) => {
      const project = mkdtempSync(join(tmpdir(), 'native-unsupported-callers-'));
      try {
        mkdirSync(join(project, 'foreign'));
        writeFileSync(join(project, 'foreign', `control.${extension}`), 'target();\n');
        writeFileSync(join(project, 'control.ts'), 'export const unrelated = 1;\n');
        for (const paths of [[`foreign/control.${extension}`], ['foreign']]) {
          const result = firstPartyCallers({ ts, root: project, name: 'target', paths });
          expect(result.error).toContain('unsupported');
          expect(result.sites).toEqual([]);
          expect(result.freshness.health).not.toBe('healthy');
          expect(result.evidence!.languageCapabilities).toEqual([{ language, intent: 'callers', status: 'unsupported' }]);
        }
        const absent = firstPartyCallers({ ts, root: project, name: 'target', paths: ['control.ts'] });
        expect(absent.error).toBeNull();
        expect(absent.sites).toEqual([]);
        expect(absent.freshness.health).toBe('healthy');
      } finally { rmSync(project, { recursive: true, force: true }); }
    });
});

describe('firstPartyCallers', () => {
  it('unions every same-named declaration and follows an export-star chain through a stubbed barrel', () => {
    const a = firstPartyCallers({ ts, root, name: 'target' });
    expect(a.error).toBeNull();
    expect(a.backend).toBe('typescript-service');
    expect(a.attribution?.declarationCount).toBe(2);
    const resolved = a.sites.filter((s) => !s.detail);
    expect(lines(resolved)).toEqual(['src/b.test.ts:4', 'src/use.ts:4']);
    // The barrel was reached but not served in full.
    expect(a.attribution?.stubbedFiles).toBeGreaterThanOrEqual(1);
  });

  it('lists a call on an untyped receiver as unattributed, with the reason', () => {
    const a = firstPartyCallers({ ts, root, name: 'target' });
    const un = a.sites.filter((s) => s.detail);
    expect(lines(un)).toEqual(['scripts/hook.mjs:2']);
    expect(un[0]!.detail).toMatch(/^unattributed: the checker cannot type the receiver/);
    expect(a.attribution?.unattributed).toEqual({ external: 0, 'other-in-repo': 0, unresolved: 1 });
  });

  it('never reports comments, strings or the declarations themselves', () => {
    const keys = lines(firstPartyCallers({ ts, root, name: 'target' }).sites);
    for (const notACall of ['src/use.ts:2', 'src/use.ts:3', 'src/a.ts:1', 'src/b.test.ts:1']) {
      expect(keys).not.toContain(notACall);
    }
  });

  it('labels a call that resolves outside the repo as external', () => {
    const a = firstPartyCallers({ ts, root, name: 'parseInt' });
    expect(a.error).toBeNull();
    expect(lines(a.sites)).toEqual(['src/use.ts:5']);
    expect(a.sites[0]!.detail).toMatch(/^unattributed: resolves to a declaration outside the repo/);
    expect(a.attribution?.unattributed.external).toBe(1);
  });

  it('answers a name no source file contains with a healthy, trustworthy empty', () => {
    const a = firstPartyCallers({ ts, root, name: 'neverWrittenAnywhere' });
    expect(a.error).toBeNull();
    expect(a.sites).toEqual([]);
    expect(a.freshness.health).toBe('healthy');
    expect(a.attribution?.candidateFiles).toBe(0);
  });

  it('reports truncation against the full count', () => {
    const a = firstPartyCallers({ ts, root, name: 'target', limit: 1 });
    expect(a.sites).toHaveLength(1);
    expect(a.truncation).toEqual({ truncated: true, totalAvailable: 3, continuation: null });
  });

  it('fails loudly, never with a bare empty, when the question or the search cannot be answered', () => {
    const bad = firstPartyCallers({ ts, root, name: 'not an identifier' });
    expect(bad.error).toMatch(/one identifier/);
    expect(bad.freshness.health).toBe('unhealthy');
    const noRg = firstPartyCallers({ ts, root, name: 'target', rgPath: join(root, 'no-such-rg') });
    expect(noRg.error).toMatch(/^ripgrep could not run/);
    expect(noRg.sites).toEqual([]);
  });
});

describe('P007 first-party symbol/context/callees', () => {
  it('bounds symbol declarations to candidate source while callees retain full dependency versions', () => {
    const project = mkdtempSync(join(tmpdir(), 'native-symbol-scope-'));
    const entry = 'import { heavy } from "./dependency";\nexport function scopedDeclaration(n: number) { return heavy(n); }\n';
    try {
      writeFileSync(join(project, 'entry.ts'), entry);
      writeFileSync(join(project, 'dependency.ts'), 'export function heavy(n: number) { return n + 1; }\n');
      const query = (op: 'symbol' | 'callees') => firstPartyCallers({ ts, root: project, op,
        name: 'scopedDeclaration', filePath: 'entry.ts', paths: ['entry.ts'] });
      const symbol = query('symbol');
      const callees = query('callees');
      expect(symbol.error).toBeNull();
      expect(lines(symbol.sites)).toEqual(['entry.ts:2']);
      expect(symbol.evidence!.sourceScope.supportingFiles).toEqual([expect.objectContaining({
        path: 'entry.ts', representation: 'full-source', contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      })]);
      expect(symbol.evidence!.graphScope.limitations.join(' ')).toMatch(/other reached files are re-export stubs/);
      expect(callees.error).toBeNull();
      expect(callees.evidence!.sourceScope.supportingFiles).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'dependency.ts', representation: 'full-source' }),
      ]));
      writeFileSync(join(project, 'dependency.ts'), 'export function heavy(n: number) { return n + 100; }\n');
      const symbolAfter = query('symbol');
      expect(symbolAfter.error).toBeNull();
      expect(symbolAfter.evidence!.sourceScope.sourceFingerprint).toBe(symbol.evidence!.sourceScope.sourceFingerprint);
      expect(query('callees').evidence!.sourceScope.sourceFingerprint).not.toBe(callees.evidence!.sourceScope.sourceFingerprint);
    } finally { rmSync(project, { recursive: true, force: true }); }
  });

  it('refuses ambiguity and resolves the defining-file selector with actual source identity', () => {
    const ambiguous = firstPartyCallers({ ts, root, op: 'symbol', name: 'target' });
    expect(ambiguous.error).toMatch(/Ambiguous symbol.*file_path/);
    expect(lines(ambiguous.sites)).toEqual(['src/a.ts:1', 'src/b.test.ts:1']);
    const selected = firstPartyCallers({ ts, root, op: 'symbol', name: 'target', filePath: 'src/a.ts' });
    expect(selected.error).toBeNull();
    expect(lines(selected.sites)).toEqual(['src/a.ts:1']);
    expect(selected.evidence!.siteIdentities[0]).toMatchObject({ sourcePath: 'src/a.ts', contentHash: expect.stringMatching(/^[a-f0-9]{64}$/), versionedSymbolId: expect.any(String) });
    expect(selected.evidence!.relationships[0]).toMatchObject({ kind: 'definition', origin: 'compiler', runtimeExecution: 'unknown' });
  });

  it('returns the outgoing call site and loads its dependency as actual source rather than a re-export stub', () => {
    const answer = firstPartyCallers({ ts, root, op: 'callees', name: 'compose' });
    expect(answer.error).toBeNull();
    expect(answer.intent).toBe('callees');
    expect(lines(answer.sites)).toEqual(['src/compose.ts:3']);
    expect(answer.sites[0]).toMatchObject({ name: 'helper', detail: expect.stringContaining('src/dependency.ts:1') });
    expect(answer.evidence!.relationships[0]).toMatchObject({ kind: 'callees', origin: 'compiler', knowledge: 'observed' });
    expect(answer.evidence!.sourceScope.supportingFiles[0].representation).toBe('full-source');
  });

  it('joins the declaration and outgoing source-site evidence in context', () => {
    const answer = firstPartyCallers({ ts, root, op: 'context', name: 'compose' });
    expect(answer.error).toBeNull();
    expect(lines(answer.sites)).toEqual(['src/compose.ts:1', 'src/compose.ts:2', 'src/compose.ts:3']);
    expect(answer.evidence!.relationships.map(r => r.kind)).toEqual(['definition', 'callees', 'imports']);
    expect(answer.evidence!.siteIdentities.every(s => s.contentHash && s.versionedSymbolId)).toBe(true);
    const capped = firstPartyCallers({ ts, root, op: 'context', name: 'compose', limit: 1 });
    expect(capped.truncation).toEqual({ truncated: true, totalAvailable: 3, continuation: null });
    expect(capped.evidence!.siteIdentities).toHaveLength(1);
  });

  it('limits cited context to full cited files and does not certify uncited dependency bodies', () => {
    const query = { ts, root, op: 'context' as const, contextScope: 'cited-files' as const,
      name: 'compose', filePath: 'src/compose.ts', paths: ['src/compose.ts'] };
    const scoped = firstPartyCallers(query);
    expect(scoped.error).toBeNull();
    expect(scoped.evidence!.relationships.some(edge => edge.kind === 'definition')).toBe(true);
    expect(scoped.evidence!.graphScope.sourceCompleteness).toBe('unverified');
    expect(scoped.evidence!.graphScope.limitations.join(' ')).toContain('dependency bodies and relationships outside those files are not inspected');
    expect(scoped.evidence!.sourceScope.supportingFiles.some(file => file.path === 'src/dependency.ts' && file.representation === 'full-source')).toBe(false);
    expect(scoped.evidence!.relationships.some(edge => edge.target?.site.path === 'src/dependency.ts' && edge.target.versionedSymbolId)).toBe(false);
    const included = firstPartyCallers({ ...query, paths: ['src/compose.ts', 'src/dependency.ts'] });
    expect(included.error).toBeNull();
    expect(included.evidence!.relationships.some(edge => edge.kind === 'callees' && edge.target?.site.path === 'src/dependency.ts' && edge.target.versionedSymbolId)).toBe(true);
    expect(included.evidence!.sourceScope.supportingFiles.find(file => file.path === 'src/dependency.ts')?.representation).toBe('full-source');
  });

  it('refuses cited context without explicit source files or with broader enrichment', () => {
    const query = { ts, root, name: 'compose', op: 'context' as const, contextScope: 'cited-files' as const };
    for (const overrides of [{}, { paths: ['src'] }, { paths: ['src/compose.ts'], op: 'symbol' as const },
      { paths: ['src/compose.ts'], includeInterfaces: true }]) {
      expect(firstPartyCallers({ ...query, ...overrides }).error).toContain('Cited-file context requires');
    }
  });

  it('re-resolves the outgoing target version after a dependency edit at an unchanged call site', () => {
    const before = firstPartyCallers({ ts, root, op: 'callees', name: 'compose' });
    const dependency = FILES['src/dependency.ts']!;
    try {
      writeFileSync(join(root, 'src/dependency.ts'), `\n${dependency}`);
      const after = firstPartyCallers({ ts, root, op: 'callees', name: 'compose' });
      expect(after.error).toBeNull();
      expect(lines(after.sites)).toEqual(['src/compose.ts:3']);
      expect(after.sites[0].detail).toContain('src/dependency.ts:2');
      expect(after.evidence!.sourceScope.sourceFingerprint).not.toBe(before.evidence!.sourceScope.sourceFingerprint);
    } finally { writeFileSync(join(root, 'src/dependency.ts'), dependency); }
  });

  it('does not certify a missing declaration or mismatched selector as an empty graph', () => {
    for (const args of [{ name: 'neverWrittenAnywhere' }, { name: 'compose', filePath: 'src/a.ts' },
      { name: 'compose', line1: 99 }]) {
      const answer = firstPartyCallers({ ts, root, op: 'context', ...args });
      expect(answer.error).toMatch(/No declaration/);
      expect(answer.freshness.health).toBe('unhealthy');
    }
  });

  it('joins declared heritage, used imports, members and actual base overrides with versioned targets', () => {
    const answer = firstPartyCallers({ ts, root, op: 'context', name: 'Derived', filePath: 'src/model.ts' });
    expect(answer.error).toBeNull();
    const relationships = answer.evidence!.relationships.map(edge => ({
      kind: edge.kind, line: answer.sites[edge.siteIndex]!.line1,
      target: edge.target ? `${edge.target.site.path}:${edge.target.site.line1}` : null,
    }));
    expect(relationships).toEqual(expect.arrayContaining([
      { kind: 'imports', line: 1, target: 'src/dependency.ts:1' },
      { kind: 'inheritance', line: 7, target: 'src/model.ts:3' },
      { kind: 'implementations', line: 7, target: 'src/model.ts:2' },
      { kind: 'members', line: 8, target: 'src/model.ts:8' },
      { kind: 'overrides', line: 8, target: 'src/model.ts:5' },
    ]));
    expect(answer.evidence!.relationships.filter(edge => edge.target).every(edge =>
      /^[a-f0-9]{64}$/.test(edge.target!.contentHash) && edge.target!.versionedSymbolId)).toBe(true);
    expect(answer.coverage!.limitations.join(' ')).toContain('Structural implementations use lsp:query');
  });

  it('separates property reads, writes and read-modify-write from same-name fields and untyped receivers', () => {
    const answer = firstPartyCallers({ ts, root, op: 'context', name: 'value', filePath: 'src/model.ts', line1: 4 });
    expect(answer.error).toBeNull();
    const fieldSites = (kind: string) => answer.evidence!.relationships.filter(edge => edge.kind === kind)
      .map(edge => `${answer.sites[edge.siteIndex]!.path}:${answer.sites[edge.siteIndex]!.line1}`).sort();
    expect(fieldSites('field-read')).toEqual(['src/model-use.ts:5', 'src/model-use.ts:6', 'src/model.ts:10', 'src/model.ts:9']);
    expect(fieldSites('field-write')).toEqual(['src/model-use.ts:4', 'src/model-use.ts:5', 'src/model.ts:9']);
    expect(answer.evidence!.relationships.filter(edge => edge.kind.startsWith('field-')).every(edge =>
      edge.target?.site.path === 'src/model.ts' && edge.target.site.line1 === 4)).toBe(true);
  });

  it.each([['rust', '.rs'], ['python', '.py'], ['go', '.go']])('refuses unadmitted %s graph operations explicitly', (language, extension) => {
    const answer = firstPartyCallers({ ts, root, op: 'context', name: 'target', filePath: `src/unsupported${extension}` });
    expect(answer.error).toContain('unsupported');
    expect(answer.sites).toEqual([]);
    expect(answer.evidence!.languageCapabilities).toEqual([{ language, intent: 'definition', status: 'unsupported' }]);
  });
});

describe('firstPartyCallers paths scope (WI-10006543)', () => {
  it('answers only from the named roots and says so', () => {
    const scripts = firstPartyCallers({ ts, root, name: 'target', paths: ['scripts'] });
    expect(scripts.error).toBeNull();
    expect(lines(scripts.sites)).toEqual(['scripts/hook.mjs:2']);
    expect(scripts.attribution?.candidateFiles).toBe(1);
    expect(scripts.coverage?.limitations).toContain('Searched only under: scripts.');
  });

  it('still lists a call whose declaration lies outside the scope', () => {
    const a = firstPartyCallers({ ts, root, name: 'target', paths: ['./src/use.ts'] });
    expect(a.error).toBeNull();
    expect(lines(a.sites)).toEqual(['src/use.ts:4']);
  });

  it('refuses a root it cannot search instead of answering empty', () => {
    for (const [paths, why] of [
      [['../elsewhere'], /outside the repository/],
      [['/etc'], /relative to the repository root/],
      [['no-such-dir'], /does not exist/],
    ] as const) {
      const a = firstPartyCallers({ ts, root, name: 'target', paths: [...paths] });
      expect(a.error).toMatch(why);
      expect(a.freshness.health).toBe('unhealthy');
    }
  });
});

describe('resolveSearchPaths', () => {
  it('defaults to the whole repository and normalises, dedupes and scopes the rest', () => {
    expect(resolveSearchPaths(root, undefined)).toEqual({ ok: true, paths: ['.'], scoped: false });
    expect(resolveSearchPaths(root, [])).toEqual({ ok: true, paths: ['.'], scoped: false });
    expect(resolveSearchPaths(root, ['./src/', 'src', 'scripts/hook.mjs'])).toEqual({
      ok: true,
      paths: ['src', 'scripts/hook.mjs'],
      scoped: true,
    });
    expect(resolveSearchPaths(root, ['.', 'src'])).toEqual({ ok: true, paths: ['.', 'src'], scoped: false });
    expect(resolveSearchPaths(root, Array.from({ length: 51 }, () => 'src')).ok).toBe(false);
  });
});

describe('resolveRipgrep', () => {
  const only = (...paths: string[]) => (p: string): boolean => paths.includes(p);

  it('takes PATH first, in order', () => {
    expect(resolveRipgrep({ PATH: '/a:/b' }, '/home/u', only('/b/rg', '/home/u/.local/bin/rg'))).toBe('/b/rg');
  });

  it('falls back to per-user install dirs a systemd unit PATH lacks', () => {
    expect(resolveRipgrep({ PATH: '/usr/sbin' }, '/home/u', only('/home/u/.local/bin/rg'))).toBe('/home/u/.local/bin/rg');
    expect(resolveRipgrep({}, '/home/u', only('/home/u/.cargo/bin/rg'))).toBe('/home/u/.cargo/bin/rg');
  });

  it('honours an absolute PAPERCUSP_RG and refuses a relative or missing one', () => {
    expect(resolveRipgrep({ PAPERCUSP_RG: '/opt/rg', PATH: '/b' }, '/h', only('/opt/rg', '/b/rg'))).toBe('/opt/rg');
    expect(resolveRipgrep({ PAPERCUSP_RG: 'rg', PATH: '/b' }, '/h', only('/b/rg'))).toBeNull();
    expect(resolveRipgrep({ PAPERCUSP_RG: '/opt/rg' }, '/h', only())).toBeNull();
  });

  it('returns null when no rg exists, and the answer says so instead of an empty', () => {
    expect(resolveRipgrep({ PATH: '/x' }, '/h', only())).toBeNull();
    const prev = process.env.PAPERCUSP_RG;
    process.env.PAPERCUSP_RG = join(root, 'no-such-rg');
    try {
      const a = firstPartyCallers({ ts, root, name: 'target' });
      expect(a.error).toMatch(/^ripgrep \(rg\) was not found/);
      expect(a.sites).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_RG;
      else process.env.PAPERCUSP_RG = prev;
    }
  });
});

describe('scoped program', () => {
  it('finds candidates by whole word only', () => {
    const found = findCandidateFiles(root, 'target').files.map((f) => f.slice(root.length + 1)).sort();
    expect(found).toEqual(['scripts/hook.mjs', 'src/a.ts', 'src/b.test.ts', 'src/use.ts']);
  });

  it('keeps only the re-export statements of a stubbed file', () => {
    expect(reExportStub(ts, 'x.ts', FILES['src/barrel.ts']!)).toBe('export * from "./a";');
  });

  const resolvedOf = (tree: TsTree): string[] => {
    const program = tree.service.getProgram()!;
    return lines(incomingCallSites(tree, program, tsDeclarations(tree, program, 'target')));
  };
  const withTree = <T>(tree: TsTree, fn: (t: TsTree) => T): T => {
    try {
      return fn(tree);
    } finally {
      tree.service.dispose();
    }
  };

  it('resolves the same callers as the whole-tree program the bench measured', () => {
    const scoped = withTree(openScopedTsTree(ts, root, findCandidateFiles(root, 'target').files), resolvedOf);
    const whole = withTree(openTsTree(ts, root), resolvedOf);
    expect(scoped).toEqual(whole);
    expect(scoped).toEqual(['src/b.test.ts:4', 'src/use.ts:4']);
  });

  it('serves the full transitive closure when the stub is the identity', () => {
    const candidates = findCandidateFiles(root, 'target').files;
    const closure = withTree(openScopedTsTree(ts, root, candidates, (_ts, _f, text) => text), resolvedOf);
    expect(closure).toEqual(['src/b.test.ts:4', 'src/use.ts:4']);
  });

  // Falsifiability control for the parity above: a stub that drops the barrel's
  // `export *` must break the chain, so the parity test is sensitive to the one
  // thing reExportStub is responsible for keeping.
  it('loses the export-star caller when the stub drops re-exports (control)', () => {
    const candidates = findCandidateFiles(root, 'target').files;
    const lossy = withTree(openScopedTsTree(ts, root, candidates, () => ''), resolvedOf);
    expect(lossy).not.toContain('src/use.ts:4');
    expect(lossy).toContain('src/b.test.ts:4');
    // ...and firstPartyCallers still lists the call, now as unattributed: the
    // syntactic sweep is what keeps grep-equivalence when resolution fails.
    const a = firstPartyCallers({ ts, root, name: 'target' });
    expect(lines(a.sites)).toContain('src/use.ts:4');
  });
});
