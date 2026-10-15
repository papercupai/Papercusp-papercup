import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EVAL_BATTERY_SOURCE_HASHES } from './battery';
import { captureSourceHash } from './index';

describe('loaded evaluator source identity', () => {
  it('keeps an existing but unobserved file unknown rather than hashing disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-source-'));
    try {
      const path = join(dir, 'module.ts');
      writeFileSync(path, 'export const policy = 1;');
      expect(captureSourceHash(pathToFileURL(path).href)).toBeNull();
      writeFileSync(path, 'export const policy = 2;');
      expect(captureSourceHash(pathToFileURL(path).href)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps unavailable module bytes unknown', () => {
    expect(captureSourceHash('data:text/javascript,export default 1')).toBeNull();
    expect(captureSourceHash(pathToFileURL(join(tmpdir(), 'missing-evaluator', 'module.ts')).href)).toBeNull();
  });

  it('retains each engine, judge, parser, scoring and pause boundary independently', () => {
    expect(Object.keys(EVAL_BATTERY_SOURCE_HASHES).sort()).toEqual(
      ['engine', 'judge', 'parser', 'ratePause', 'scoring', 'sourceIdentity']);
    expect(Object.isFrozen(EVAL_BATTERY_SOURCE_HASHES)).toBe(true);
    // Vite's worker evaluator does not use the native Node load boundary.
    // Existing source files are insufficient evidence of their loaded bytes.
    for (const value of Object.values(EVAL_BATTERY_SOURCE_HASHES)) expect(value).toBeNull();
  });

  it.each(['stable', 'self-restoring', 'typescript', 'commonjs', 'reloaded', 'no-preload'] as const)
    ('uses the actual existing Node load receipt (%s)', kind => {
      const dir = mkdtempSync(join(tmpdir(), 'eval-original-source-'));
      const identity = fileURLToPath(new URL('./source-identity.ts', import.meta.url));
      const preload = fileURLToPath(new URL('../../../test-config/src/executed-config-load-capture.ts', import.meta.url));
      const path = join(dir, kind === 'commonjs' ? 'policy.cjs' : kind === 'typescript' ? 'policy.ts' : 'policy.mjs');
      const restored = 'export const policy = 1;\n';
      const original = kind === 'commonjs' ? 'exports.policy = 1;\n' :
        `import { captureSourceHash } from ${JSON.stringify(pathToFileURL(identity).href)};
         import { writeFileSync } from 'node:fs';
         ${kind === 'self-restoring' ? `writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(restored)});` : ''}
         export const policy${kind === 'typescript' ? ': number' : ''} = 2;
         export const sourceHash = captureSourceHash(import.meta.url);`;
      try {
        writeFileSync(path, original);
        const script = `import { writeFileSync } from 'node:fs';
          const module = await import(${JSON.stringify(pathToFileURL(path).href)});
          const { captureSourceHash } = await import(${JSON.stringify(pathToFileURL(identity).href)});
          ${kind === 'reloaded' ? `writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(restored)});
            await import(${JSON.stringify(pathToFileURL(path).href + '?second')});` : ''}
          console.log(JSON.stringify({ initial: module.sourceHash ?? null,
            current: captureSourceHash(${JSON.stringify(pathToFileURL(path).href)}),
            identity: captureSourceHash(${JSON.stringify(pathToFileURL(identity).href)}) }));`;
        const result = JSON.parse(execFileSync(process.execPath,
          [...(kind === 'no-preload' ? [] : ['--import', preload]), '--input-type=module', '--eval', script], {
            cwd: dir, encoding: 'utf8', timeout: 30000,
            env: { PATH: process.env.PATH, PC_EXECUTED_SOURCE_MAP_PRELOAD: '1',
              PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'eval-source-test', PC_EXECUTED_SOURCE_MAP_OUT: join(dir, 'out.json') },
          }).trim());
        if (kind === 'no-preload' || kind === 'commonjs' || kind === 'reloaded') expect(result.current).toBeNull();
        else {
          expect(result.initial).toBe(createHash('sha256').update(original).digest('hex'));
          expect(result.current).toBe(result.initial);
        }
        if (kind === 'no-preload') expect(result.identity).toBeNull();
        else expect(result.identity).toMatch(/^[a-f0-9]{64}$/);
        if (kind === 'self-restoring') expect(result.current).not.toBe(createHash('sha256').update(restored).digest('hex'));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});
