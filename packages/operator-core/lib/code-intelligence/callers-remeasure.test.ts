import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callerReferences, parseReferenceOutput, remeasureCallers } from './callers-remeasure';
import { firstPartyCallers } from './first-party-callers';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'callers-remeasure-'));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'es2022', module: 'esnext' } }));
  writeFileSync(join(root, 'sample.ts'), [
    'export function target() { return 1; }',
    'target();',
    '// target() is not code',
    'const label = "target()";',
    'normalizeEventKey();',
    'getEventKey();',
    'target ();',
    'export function $target() {}',
    '$target();',
    '',
  ].join('\n'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
const paths = ['sample.ts'];

describe('committed dual-reference callers re-measurement', () => {
  it('parses filename/line/column and refuses unparsed or impossible lines', () => {
    expect(parseReferenceOutput('./sample.ts:2:1:target();\n')).toEqual([{ path: 'sample.ts', line1: 2, col1: 1, text: 'target();' }]);
    for (const raw of ['2:target();', 'sample.ts:0:1:target();', 'sample.ts:2:0:target();', 'garbage']) {
      expect(() => parseReferenceOutput(raw)).toThrow(/unparsed/);
    }
  });

  it('always counts semantic and literal references, including a single-file operand', () => {
    const refs = callerReferences({ root, name: 'target', paths });
    expect(refs.semantic.map((hit) => hit.line1)).toEqual([1, 2, 3, 4, 7]);
    expect(refs.literal.map((hit) => hit.line1)).toEqual([1, 2, 3, 4, 8, 9]);
    expect(refs.substringOnly.map((hit) => hit.line1)).toEqual([8, 9]);
    expect(refs.semantic.every((hit) => hit.path === 'sample.ts')).toBe(true);
  });

  it('catches EventKey-style partial-name false empties rather than declaring grep empty', () => {
    const answer = firstPartyCallers({ ts, root, name: 'EventKey', paths });
    const measured = remeasureCallers({ ts, root, name: 'EventKey', paths, answer });
    expect(answer.sites).toEqual([]);
    expect(measured.grepLines).toBe(0);
    expect(measured.literal).toMatchObject({ lines: 2, substringOnly: 2 });
    expect(measured.partialNameSearch).toBe(true);
  });

  it('classifies comments/strings while exposing a genuinely omitted call', () => {
    const answer = firstPartyCallers({ ts, root, name: 'target', paths });
    const measured = remeasureCallers({ ts, root, name: 'target', paths, answer });
    expect(measured.grepNotSiteByKind).toEqual({ comment: 1, string: 1 });
    expect(measured.suspicious).toEqual([]);
    expect(measured.siteNotGrep).toEqual([]);
    const missing = remeasureCallers({ ts, root, name: 'target', paths, answer: { ...answer, sites: [] } });
    expect(missing.suspicious).toEqual(['sample.ts:2 [call?]', 'sample.ts:7 [call?]']);
  });

  it('escapes regex metacharacters in valid identifiers and distinguishes real no-matches', () => {
    const dollar = callerReferences({ root, name: '$target', paths });
    expect(dollar.semantic.map((hit) => hit.line1)).toEqual([8, 9]);
    expect(dollar.literal).toHaveLength(2);
    const empty = callerReferences({ root, name: 'neverWritten', paths });
    expect(empty.semantic).toEqual([]);
    expect(empty.literal).toEqual([]);
  });

  it('refuses absent/unsearchable scope, invalid names and a broken reference process', () => {
    for (const badPaths of [[], ['missing.ts'], ['../outside'], ['/etc']]) {
      expect(() => callerReferences({ root, name: 'target', paths: badPaths })).toThrow();
    }
    expect(() => callerReferences({ root, name: 'target|other', paths })).toThrow(/one identifier/);
    const broken = join(root, 'broken-rg');
    writeFileSync(broken, '#!/bin/sh\nprintf "sample.ts:2:1:target();\\n"\nexit 2\n');
    chmodSync(broken, 0o755);
    expect(() => callerReferences({ root, name: 'target', paths, rgPath: broken })).toThrow();
    expect(() => callerReferences({ root, name: 'target', paths, rgPath: join(root, 'absent-rg') })).toThrow();
  });

  it('keeps backend failure and truncation explicit, never an automatic equivalence verdict', () => {
    const answer = firstPartyCallers({ ts, root, name: 'target', paths, limit: 1 });
    expect(remeasureCallers({ ts, root, name: 'target', paths, answer }).truncated).toBe(true);
    expect(remeasureCallers({ ts, root, name: 'target', paths, answer: { ...answer, error: 'worker failed' } }).error).toBe('worker failed');
  });
});
