import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localEsbuildNpxPath } from './local-esbuild-npx';

const root = resolve(__dirname, '../../../..');
let directory: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'local-esbuild-cli-'));
  env = { ...process.env, PATH: localEsbuildNpxPath(join(directory, 'bin'), root) };
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('local bundle compiler fixture', () => {
  it('resolves the exact pinned compiler for the shared builder', () => {
    const result = spawnSync('npx', ['--yes', '--package=esbuild@0.25.0', '-c', 'command -v esbuild'],
      { env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const compiler = result.stdout.trim();
    expect(compiler).toMatch(/^\//);
    expect(spawnSync(compiler, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('0.25.0');
  });

  it('emits and executes real compiled bytes without invoking npm', () => {
    const entry = join(directory, 'entry.ts');
    const output = join(directory, 'entry.mjs');
    writeFileSync(entry, 'const answer: number = 42; console.log(answer);');
    const result = spawnSync('npx', ['--yes', 'esbuild@0.25.0', entry,
      '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`], { env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).not.toContain(': number');
    expect(spawnSync(process.execPath, [output], { encoding: 'utf8' }).stdout.trim()).toBe('42');
  });

  it('preserves a real compiler refusal and leaves no published output', () => {
    const entry = join(directory, 'broken.ts');
    const output = join(directory, 'broken.mjs');
    writeFileSync(entry, 'export const value = ;');
    const result = spawnSync('npx', ['--yes', 'esbuild@0.25.0', entry,
      `--outfile=${output}`], { env, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ERROR');
    expect(() => readFileSync(output)).toThrow();
  });

  it('refuses an unexpected npm command instead of reaching the registry', () => {
    const result = spawnSync('npx', ['--yes', 'unexpected-package'], { env, encoding: 'utf8' });
    expect(result.status).toBe(78);
    expect(result.stderr).toContain('unexpected npm exec in bundle fixture');
  });
});
