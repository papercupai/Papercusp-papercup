import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import {
  measureRetainedReplaySourceIdentity, retainedReplaySourceIdentity, RETAINED_REPLAY_SOURCE_FILES,
} from './retained-replay-identity';

const root = resolve(import.meta.dirname, '../../..');
const identityPath = 'packages/operator-core/lib/retained-replay-identity.ts';
const common = join(root, 'apps/operator/bin/bundle-host-common.sh');

function sourceCopy() {
  const copy = mkdtempSync(join(tmpdir(), 'retained-replay-source-'));
  for (const path of RETAINED_REPLAY_SOURCE_FILES) {
    mkdirSync(dirname(join(copy, path)), { recursive: true });
    copyFileSync(join(root, path), join(copy, path));
  }
  return copy;
}

function runNode(source: string, args: string[] = []) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, ...args], {
    encoding: 'utf8', timeout: 20_000,
  });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim());
}

describe('retained replay source identity', () => {
  it('is byte-bound and relocation-independent, including evaluator, parser, redaction and dependency changes', () => {
    const copy = sourceCopy();
    try {
      const expected = measureRetainedReplaySourceIdentity(root);
      expect(expected).toMatch(/^[a-f0-9]{64}$/);
      expect(retainedReplaySourceIdentity()).toBe(expected);
      expect(measureRetainedReplaySourceIdentity(copy)).toBe(expected);
      for (const path of RETAINED_REPLAY_SOURCE_FILES) {
        const file = join(copy, path), bytes = readFileSync(file);
        writeFileSync(file, Buffer.concat([bytes, Buffer.from('\nchanged implementation input\n')]));
        expect(measureRetainedReplaySourceIdentity(copy), path).not.toBe(expected);
        writeFileSync(file, bytes);
      }
      rmSync(join(copy, RETAINED_REPLAY_SOURCE_FILES[0]!));
      expect(() => measureRetainedReplaySourceIdentity(copy)).toThrow();
    } finally { rmSync(copy, { recursive: true, force: true }); }
  });

  it('source execution refuses drift after initialization instead of relabeling loaded code', () => {
    const copy = sourceCopy();
    try {
      const observed = runNode(`
        import { appendFileSync } from 'node:fs';
        const identity = await import(process.argv[1]);
        const before = identity.retainedReplaySourceIdentity();
        appendFileSync(process.argv[2], '\\n// changed after load\\n');
        console.log(JSON.stringify({ before, after: identity.retainedReplaySourceIdentity() }));
      `, [pathToFileURL(join(copy, identityPath)).href, join(copy, 'packages/operator-core/lib/retained-sql.ts')]);
      expect(observed.before).toBe(measureRetainedReplaySourceIdentity(root));
      expect(observed.after).toBeNull();
    } finally { rmSync(copy, { recursive: true, force: true }); }
  });

  it('the maintained compiler gives formatting and renamed-local variants the same original source identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'retained-replay-compiler-'));
    try {
      const entry = join(dir, 'entry.ts');
      writeFileSync(entry, `
        import { retainedReplaySourceIdentity } from ${JSON.stringify(join(root, identityPath))};
        function parser(value: number) { const twice = value * 2; return twice; }
        console.log(JSON.stringify({ identity: retainedReplaySourceIdentity(), parser: parser.toString(), value: parser(7) }));
      `);
      const variants: string[][] = [[], ['--minify-whitespace', '--minify-syntax'], ['--minify', '--keep-names']];
      const outputs = variants.map((flags, i) => {
        const outfile = join(dir, `compiled-${i}.mjs`);
        const compile = spawnSync('bash', ['-c',
          'set -euo pipefail\nsource "$1"\nshift\nbundle_host_esbuild "$@"',
          'retained-replay-test', common, root, entry,
          '--bundle', '--platform=node', '--format=esm', '--target=node22', `--outfile=${outfile}`, ...flags],
        { cwd: root, encoding: 'utf8', timeout: 60_000 });
        expect(compile.status, compile.stderr + compile.stdout).toBe(0);
        return runNode('await import(process.argv[1]);', [pathToFileURL(outfile).href]);
      });
      for (const output of outputs) {
        expect(output.identity).toBe(measureRetainedReplaySourceIdentity(root));
        expect(output.value).toBe(14);
      }
      // Positive reproduction of the old bug: compiler output is different.
      expect(new Set(outputs.map(output => createHash('sha256').update(output.parser).digest('hex'))).size)
        .toBeGreaterThan(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 210_000);

  it('bundles missing or malformed producing-build identity stay unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'retained-replay-unwitnessed-'));
    try {
      for (const define of [undefined, 'null', JSON.stringify('not-a-digest')]) {
        const outfile = join(dir, 'unwitnessed.mjs');
        await build({ stdin: { contents: `import { retainedReplaySourceIdentity } from ${JSON.stringify(join(root, identityPath))};
          console.log(JSON.stringify(retainedReplaySourceIdentity()));`, resolveDir: root },
        bundle: true, platform: 'node', format: 'esm', outfile,
        ...(define ? { define: { __PAPERCUSP_RETAINED_REPLAY_SOURCE_SHA256__: define } } : {}) });
        expect(runNode('await import(process.argv[1]);', [pathToFileURL(outfile).href])).toBeNull();
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
