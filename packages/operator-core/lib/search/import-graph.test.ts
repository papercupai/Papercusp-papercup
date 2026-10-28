import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveFixtureSupportPaths, deriveSubjectSourcePaths, isTestInfrastructurePath } from './import-graph';

it('derives the same inert first ring for proof fixtures and subject sources', () => {
  const parent = mkdtempSync(join(tmpdir(), 'proof-source-imports-'));
  const root = join(parent, 'repo');
  try {
    mkdirSync(join(root, 'test'), { recursive: true });
    for (const name of ['subject.ts', 'lazy.ts', 'types.ts', 'test/fixture.ts', 'test/export.ts', 'test/lazy.ts'])
      writeFileSync(join(root, name), 'throw new Error("source collection must not evaluate imports");');
    writeFileSync(join(parent, 'outside.ts'), 'throw new Error("outside root");');
    writeFileSync(join(root, 'proof.test.ts'), [
      'import "./test/fixture"; import { value } from "./subject";',
      'import type { T } from "./types"; export type { T } from "./types";',
      'export { fixture } from "./test/export";',
      'import "./test/fixture"; import "../outside"; import "node:fs";',
      '// import("./test/not-a-dependency")',
      'void import("./test/lazy"); void import("./lazy");',
    ].join('\n'));
    expect(deriveFixtureSupportPaths(root, 'proof.test.ts'))
      .toEqual(['test/export.ts', 'test/fixture.ts', 'test/lazy.ts']);
    expect(deriveSubjectSourcePaths(root, 'proof.test.ts')).toEqual(['lazy.ts', 'subject.ts']);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

it('keeps test infrastructure classification shared with evidence binding', () => {
  for (const path of ['a/b.test.ts', 'a/b.spec.mts', 'a/test/helper.ts', 'a/__fixtures__/x.ts', 'a/__mocks__/x.ts'])
    expect(isTestInfrastructurePath(path)).toBe(true);
  for (const path of ['a/testing/helper.ts', 'a/b.ts']) expect(isTestInfrastructurePath(path)).toBe(false);
});
