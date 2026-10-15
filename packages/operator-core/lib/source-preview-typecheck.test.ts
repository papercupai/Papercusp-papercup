/**
 * scripts/source-preview.mjs cut typecheck — WI-10006584 (plan open-source-release-2026-09-29).
 *
 * Public CI on the public repository runs `npm ci` + `npm run lint:tsc` on each pushed cut.
 * A cut can fail it while the internal tree passes, because the cut drops files other files
 * relied on (5eb41d7e). runCutTypecheck runs the CUT's own lint script over a copy of the
 * export against the internal tree's installed dependencies, so the public push sees that
 * failure before it publishes.
 *
 * The fixture is a tiny internal tree (a workspace link, a scoped package, a nested
 * node_modules, a link to a workspace the cut drops) and a cut whose lint script runs the
 * real TypeScript compiler and prints the LINT_TSC_RESULT verdict line. Everything lives
 * under a tmpdir; nothing touches the shared checkout.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TARGETS, defaultGateFor, runCutTypecheck, runGate, runPublicGate } from '../../../scripts/source-preview.mjs';
import { write } from './source-preview.fixture';

const TYPESCRIPT_DIR = dirname(createRequire(import.meta.url).resolve('typescript/package.json'));

// The compiler's entry comes from its package.json `bin` (TypeScript 6 names it tsc6).
const LINT_SCRIPT = `import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const bin = Object.values(JSON.parse(readFileSync('node_modules/typescript/package.json', 'utf8')).bin)[0];
const r = spawnSync(process.execPath, ['node_modules/typescript/' + bin, '-p', 'tsconfig.json'], { encoding: 'utf8' });
process.stdout.write((r.stdout ?? '') + (r.stderr ?? ''));
const code = r.status === 0 ? 0 : 1;
console.log('LINT_TSC_RESULT label=fixture scope=fixture exit=' + code + ' status=' + (code === 0 ? 'clean' : 'regressed'));
process.exit(code);
`;

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, module: 'esnext', moduleResolution: 'bundler', target: 'es2022', skipLibCheck: true, types: [] },
  include: ['packages/**/*.ts'],
});

let tmp: string;
let internal: string;
let cutCount = 0;

/**
 * The internal tree: its own copy of @fx/core exports `internalOnly`, which the cut's copy
 * does NOT — so a check that resolved the workspace link into the internal tree would pass
 * a cut that public CI fails.
 */
function buildInternal(root: string): void {
  write(root, 'packages/core/package.json', JSON.stringify({ name: '@fx/core', types: 'index.ts' }));
  write(root, 'packages/core/index.ts', 'export const coreValue: number = 1;\nexport const internalOnly: string = "internal";\n');
  mkdirSync(join(root, 'node_modules', '@fx'), { recursive: true });
  symlinkSync(TYPESCRIPT_DIR, join(root, 'node_modules', 'typescript'));
  symlinkSync('../../packages/core', join(root, 'node_modules', '@fx', 'core'));
  symlinkSync('../../packages/gone', join(root, 'node_modules', '@fx', 'gone'));
  write(root, 'node_modules/@fx/dep/package.json', JSON.stringify({ name: '@fx/dep', types: 'index.d.ts' }));
  write(root, 'node_modules/@fx/dep/index.d.ts', 'export declare const depValue: number;\n');
  write(root, 'packages/app/node_modules/leftpad/package.json', JSON.stringify({ name: 'leftpad', types: 'index.d.ts' }));
  write(root, 'packages/app/node_modules/leftpad/index.d.ts', 'export declare function leftpad(s: string): string;\n');
  write(root, 'packages/gone/node_modules/never/package.json', JSON.stringify({ name: 'never' }));
}

/** A cut (an export directory). `app` is the body of packages/app/index.ts. */
function makeCut(app: string, { lint = LINT_SCRIPT, script = 'lint:tsc' }: { lint?: string; script?: string } = {}): string {
  const dir = join(tmp, `cut-${(cutCount += 1)}`);
  write(dir, 'package.json', JSON.stringify({ name: 'fx-cut', private: true, scripts: script ? { [script]: 'node lint.mjs' } : {} }));
  write(dir, 'lint.mjs', lint);
  write(dir, 'tsconfig.json', TSCONFIG);
  write(dir, 'packages/core/package.json', JSON.stringify({ name: '@fx/core', types: 'index.ts' }));
  write(dir, 'packages/core/index.ts', 'export const coreValue: number = 1;\nexport const cutOnly: string = "cut";\n');
  write(dir, 'packages/app/index.ts', app);
  return dir;
}

const USES_CUT = [
  "import { cutOnly } from '@fx/core';",
  "import { depValue } from '@fx/dep';",
  "import { leftpad } from 'leftpad';",
  'export const out: string = leftpad(cutOnly) + String(depValue);',
  '',
].join('\n');

const listTree = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort();

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'source-preview-typecheck-test-'));
  internal = join(tmp, 'internal');
  buildInternal(internal);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('runCutTypecheck', () => {
  it('passes a cut that typechecks against its OWN workspace packages, scoped and nested dependencies', async () => {
    const r = await runCutTypecheck(makeCut(USES_CUT), { modulesRoot: internal });
    expect(r, r.detail).toMatchObject({ ok: true, status: 'clean' });
    expect(r.detail).toMatch(/LINT_TSC_RESULT .*status=clean/);
  }, 60_000);

  it('refuses a cut that relies on something only the internal tree has (the 5eb41d7e class)', async () => {
    const app = "import { internalOnly } from '@fx/core';\nexport const out: string = internalOnly;\n";
    const r = await runCutTypecheck(makeCut(app), { modulesRoot: internal });
    expect(r).toMatchObject({ ok: false, status: 'finding' });
    expect(r.detail).toMatch(/internalOnly/);
  }, 60_000);

  it('refuses an injected type error (positive control)', async () => {
    const r = await runCutTypecheck(makeCut(`${USES_CUT}export const broken: number = 'not a number';\n`), { modulesRoot: internal });
    expect(r).toMatchObject({ ok: false, status: 'finding' });
    expect(r.detail).toMatch(/TS2322/);
  }, 60_000);

  it('never adds anything to the export directory it checks (the push commits that directory)', async () => {
    const cut = makeCut(USES_CUT);
    const before = listTree(cut);
    await runCutTypecheck(cut, { modulesRoot: internal });
    expect(listTree(cut)).toEqual(before);
    expect(existsSync(join(cut, 'node_modules'))).toBe(false);
  }, 60_000);

  it('cannot check a cut without the lint script', async () => {
    const r = await runCutTypecheck(makeCut(USES_CUT, { script: '' }), { modulesRoot: internal });
    expect(r).toMatchObject({ ok: false, status: 'cannot-check' });
    expect(r.detail).toMatch(/no "lint:tsc" script/);
  });

  it('cannot check when the lint script reports no verdict, even on exit 0', async () => {
    const r = await runCutTypecheck(makeCut(USES_CUT, { lint: 'process.exit(0);\n' }), { modulesRoot: internal });
    expect(r).toMatchObject({ ok: false, status: 'cannot-check' });
    expect(r.detail).toMatch(/without a LINT_TSC_RESULT verdict line/);
  }, 60_000);

  it('cannot check when the lint script fails for a reason other than a type regression', async () => {
    const lint = "console.log('LINT_TSC_RESULT label=fixture scope=fixture exit=1 status=preflight-failed'); process.exit(1);\n";
    const r = await runCutTypecheck(makeCut(USES_CUT, { lint }), { modulesRoot: internal });
    expect(r).toMatchObject({ ok: false, status: 'cannot-check' });
    expect(r.detail).toMatch(/status=preflight-failed/);
  }, 60_000);
});

describe('runPublicGate', () => {
  const clean = { ok: true, exitCode: 0, results: [{ name: 'detectors', ok: true, status: 'clean', detail: '' }], findings: [] };
  const refused = { ok: false, exitCode: 1, results: [{ name: 'detectors', ok: false, status: 'finding', detail: 'x' }], findings: [] };

  it('runs the typecheck after clean detectors and refuses on a type finding', async () => {
    const typecheck = vi.fn(async () => ({ name: 'cut typecheck', ok: false, status: 'finding', detail: 'TS2322' }));
    const v = await runPublicGate('/unused', { gate: async () => clean, typecheck });
    expect(typecheck).toHaveBeenCalledTimes(1);
    expect(v).toMatchObject({ ok: false, exitCode: 1 });
    expect(v.results.map((r) => r.name)).toEqual(['detectors', 'cut typecheck']);
  });

  it('reports cannot-check as exit 2', async () => {
    const typecheck = async () => ({ name: 'cut typecheck', ok: false, status: 'cannot-check', detail: '' });
    expect(await runPublicGate('/unused', { gate: async () => clean, typecheck })).toMatchObject({ ok: false, exitCode: 2 });
  });

  it('passes when both legs are clean', async () => {
    const typecheck = async () => ({ name: 'cut typecheck', ok: true, status: 'clean', detail: '' });
    expect(await runPublicGate('/unused', { gate: async () => clean, typecheck })).toMatchObject({ ok: true, exitCode: 0 });
  });

  it('skips the typecheck when the detectors already refused', async () => {
    const typecheck = vi.fn();
    expect(await runPublicGate('/unused', { gate: async () => refused, typecheck })).toBe(refused);
    expect(typecheck).not.toHaveBeenCalled();
  });

  it('is the default gate of the public target only', () => {
    expect(defaultGateFor(TARGETS.public)).toBe(runPublicGate);
    expect(defaultGateFor(TARGETS.preview)).toBe(runGate);
  });
});
