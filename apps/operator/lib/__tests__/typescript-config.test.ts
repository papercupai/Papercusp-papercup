import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('keeps generated verifier copies outside the operator TypeScript input census', () => {
  const root = mkdtempSync(join(tmpdir(), 'operator-typescript-census-'));
  try {
    const configPath = resolve(import.meta.dirname, '../../tsconfig.json');
    const config = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, 'utf8'));
    expect(config.error).toBeUndefined();
    const live = join(root, 'lib', 'live.ts');
    const mirror = join(root, 'dist-verify', 'build', 'lib', 'live.ts');
    for (const file of [live, mirror]) {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, 'export const value = 1;\n');
    }
    const program = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    expect(program.errors).toEqual([]);
    expect(program.fileNames).toEqual([live]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
