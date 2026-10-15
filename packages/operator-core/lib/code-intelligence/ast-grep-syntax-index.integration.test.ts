import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn().mockResolvedValue(true) }));
import { astGrepSyntaxIndex, astGrepIdentity } from './ast-grep-facade';
import structuralTool from '../agent-tools/lsp/astgrep';
import type { CodeIntelAnswer } from './contracts';

let root: string;
const fixtures = [
  { language: 'ts', file: 'a.ts', text: 'import { Parent } from "./parent";\nexport class Child extends Parent {}\nexport function target() {}\n// function fake() {}\nconst text = "class Fake extends Parent {}";\n', inheritance: true },
  { language: 'tsx', file: 'a.tsx', text: 'import { Parent } from "./parent";\nclass Child extends Parent { render() { return <div/>; } }\n', inheritance: true },
  { language: 'js', file: 'a.js', text: 'import Parent from "./parent.js";\nclass Child extends Parent {}\nfunction target() {}\n', inheritance: true },
  { language: 'jsx', file: 'a.jsx', text: 'import Parent from "./parent.js";\nclass Child extends Parent { render() { return <div/>; } }\n', inheritance: true },
  { language: 'rust', file: 'a.rs', text: 'use crate::parent::Parent;\nstruct Child;\nimpl Parent for Child {}\nfn target() {}\n', inheritance: true },
  { language: 'python', file: 'a.py', text: 'from parent import Parent\nclass Child(Parent):\n    pass\ndef target():\n    pass\n', inheritance: true },
  { language: 'go', file: 'a.go', text: 'package probe\nimport "fmt"\ntype Child struct {}\nfunc target() { fmt.Println("target") }\n', inheritance: false },
] as const;
beforeAll(async () => {
  const identity = await astGrepIdentity();
  expect(identity).toMatchObject({ ok: true, identity: { version: '0.45.1' } });
  root = mkdtempSync(join(tmpdir(), 'syntax-index-'));
  for (const fixture of fixtures) writeFileSync(join(root, fixture.file), fixture.text);
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('P-005 maintained grammar indexing through the native surface', () => {
  it('rejects an unadmitted grammar instead of returning a trustworthy empty', async () => {
    const result = await astGrepSyntaxIndex({ language: 'cpp' as 'ts', rootPath: root, paths: ['a.cpp'] });
    expect(result.error).toContain('unsupported');
    expect(result.freshness.health).toBe('unknown');
    expect(result.sites).toEqual([]);
    expect(structuralTool.args.safeParse({ op: 'syntax_index', language: 'cpp', paths: ['a.cpp'] }).success).toBe(false);
  });
  it.each(fixtures)('$language emits language-aware syntax and keeps relationships inferred', async fixture => {
    const args = { op: 'syntax_index' as const, language: fixture.language, paths: [fixture.file], rootPath: root };
    expect(structuralTool.args.safeParse(args).success).toBe(true);
    const response = await structuralTool.handler(args, {} as never);
    const result = (response as { data: CodeIntelAnswer }).data;
    expect(result.error).toBeNull();
    expect(result.sites.some(site => site.kind === 'declaration')).toBe(true);
    expect(result.sites.some(site => site.kind === 'imports')).toBe(true);
    expect(result.sites.some(site => site.kind === 'inheritance')).toBe(fixture.inheritance);
    expect(result.sites.some(site => site.detail?.includes('fake'))).toBe(false);
    expect(result.evidence?.sourceScope.supportingFiles).toEqual([{ path: fixture.file,
      contentHash: createHash('sha256').update(fixture.text).digest('hex'), language: fixture.language, representation: 'full-source' }]);
    expect(result.evidence?.relationships.length).toBe(result.sites.length);
    for (const relation of result.evidence!.relationships) expect(relation).toMatchObject({ origin: 'syntax', knowledge: 'inferred', runtimeExecution: 'unknown' });
    expect(result.evidence?.languageCapabilities[0].status).toBe('syntax-only');
    expect(result.evidence?.siteIdentities.every(site => site.versionedSymbolId !== null)).toBe(true);
  });
  it('reports exclusions, refuses wrong scope and preserves source identity across edits', async () => {
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'generated.ts'), 'class Generated {}');
    const excluded = await astGrepSyntaxIndex({ language: 'ts', paths: ['dist/generated.ts'], rootPath: root });
    expect(excluded.coverage?.limitations).toContain('Excluded generated/vendor path: dist/generated.ts');
    const outside = join(root, '..', 'outside-' + root.split('/').at(-1) + '.ts');
    writeFileSync(outside, 'class Outside {}');
    try {
      symlinkSync(outside, join(root, 'linked.ts'));
      const refused = await astGrepSyntaxIndex({ language: 'ts', paths: ['linked.ts'], rootPath: root });
      expect(refused.error).toContain('outside project');
      expect(refused.freshness.health).toBe('unknown');
    } finally { rmSync(outside); }
    const before = await astGrepSyntaxIndex({ language: 'ts', paths: ['a.ts'], rootPath: root, limit: 1 });
    expect(before.truncation.truncated).toBe(true);
    writeFileSync(join(root, 'a.ts'), 'class Changed {}\n');
    const after = await astGrepSyntaxIndex({ language: 'ts', paths: ['a.ts'], rootPath: root });
    expect(before.evidence?.sourceScope.sourceFingerprint).not.toBe(after.evidence?.sourceScope.sourceFingerprint);
    expect(before.evidence?.sourceScope.supportingFiles[0].contentHash).toBe(createHash('sha256').update(fixtures[0].text).digest('hex'));
    expect(after.coverage?.sourceCompleteness).toBe('unverified');
  });
});
