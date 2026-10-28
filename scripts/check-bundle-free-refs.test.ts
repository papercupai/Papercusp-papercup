// EI-25217214806027261 / EI-19521771595863238: bundle-host's free-reference guard
// (scripts/check-bundle-free-refs.mjs). esbuild bundles an identifier with no binding in
// scope as a bare GLOBAL reference, so a half-finished edit in the live shared tree
// publishes a host that throws `ReferenceError: X is not defined` only when that code
// runs. The two measured 2026-10-06 regressions are reproduced below as fixtures, each
// beside a control that must stay clean, so this suite can fail in both directions.
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkInputs,
  createCleanInputCache,
  findFreeValueReferences,
  knownGlobalNames,
  main,
  repoOwnedInputs,
} from './check-bundle-free-refs.mjs';

const freeNames = (code: string, opts?: Parameters<typeof findFreeValueReferences>[1]) =>
  findFreeValueReferences(code, opts).map((f) => f.name);

describe('findFreeValueReferences', () => {
  it('flags a value reference with no binding in scope, with its position', () => {
    const found = findFreeValueReferences('const a = 1;\nexport function f() {\n  return a + missingThing;\n}\n');
    expect(found).toEqual([{ name: 'missingThing', line: 3, column: 14 }]);
  });

  it('does not flag imported, declared, parameter, typeof-probed or Node-global names', () => {
    const code = [
      "import { a } from './a';",
      "import * as ns from './ns';",
      'const b = 1;',
      'function c(p: number) { return p; }',
      'class D {}',
      "export const out = [a, ns, b, c(2), new D(), typeof maybeGlobal === 'undefined', process.pid, Buffer.from('x'), globalThis, setTimeout];",
    ].join('\n');
    expect(freeNames(code)).toEqual([]);
  });

  it('does not flag names that appear only in type positions (esbuild erases them)', () => {
    const code = [
      'type T = MissingType;',
      'interface I { x: AlsoMissing }',
      'export function f(v: ParamType): ReturnType2 { return v as unknown as ReturnType2; }',
      'let y: typeof MissingValue | undefined;',
      'export { y };',
    ].join('\n');
    expect(freeNames(code)).toEqual([]);
  });

  it('does not flag the CommonJS wrapper / host-banner names the runtime provides', () => {
    expect(freeNames('export const x = [require, module, exports, __dirname, __filename];')).toEqual([]);
  });

  it('allows DOM constructors only inside serialized page callbacks, retaining host and typo failures', () => {
    const code = [
      'export async function observe(session: any, element: any) {',
      '  const result = await session.page.evaluate(() => document.body instanceof HTMLElement);',
      '  await session.page.$eval("input", node => node instanceof HTMLInputElement);',
      '  await session.page.evaluate(() => missingBrowserHelper());',
      '  return element instanceof HTMLElement;',
      '}',
    ].join('\n');
    expect(freeNames(code)).toEqual(['missingBrowserHelper', 'HTMLElement']);
  });

  it('allows window globals such as requestAnimationFrame only inside serialized page callbacks (WI-6554700010030501)', () => {
    // The browser-session.ts waitForFrame shape that refused every bg-host rebuild 19:25Z-22:30Z.
    const code = [
      'export async function waitForFrame(page: any, ms: number) {',
      '  await page.evaluate((ms) => new Promise<void>((resolve) => {',
      '    requestAnimationFrame(() => resolve());',
      '    setTimeout(resolve, ms);',
      '  }), ms);',
      '  await page.evaluate(() => missingBrowserHelper());',
      '  return requestAnimationFrame;',
      '}',
    ].join('\n');
    expect(freeNames(code)).toEqual(['missingBrowserHelper', 'requestAnimationFrame']);
  });

  it('does not exempt evaluated arguments or non-page methods', () => {
    expect(freeNames('export function f(page: any, service: any) { return [page.evaluate(() => 1, HTMLElement), service.evaluate(() => HTMLElement)]; }'))
      .toEqual(['HTMLElement', 'HTMLElement']);
  });

  it('treats an esbuild --define name as bound only when it is passed as known', () => {
    const code = 'export const sidecar = __PAPERCUSP_BUNDLED_SIDECAR__;';
    expect(freeNames(code)).toEqual(['__PAPERCUSP_BUNDLED_SIDECAR__']);
    expect(freeNames(code, { known: knownGlobalNames(['__PAPERCUSP_BUNDLED_SIDECAR__']) })).toEqual([]);
  });

  describe('the two measured 2026-10-06 regressions', () => {
    it('07:23Z git-sync-action.ts: a block-scoped const referenced outside its block is caught', () => {
      const broken = [
        'export async function tick(installs: string[]) {',
        '  if (installs.length > 0) {',
        '    const loadAttributionRosterForTick = () => installs;',
        '    void loadAttributionRosterForTick;',
        '  }',
        '  return loadAttributionRosterForTick();',
        '}',
      ].join('\n');
      expect(freeNames(broken)).toEqual(['loadAttributionRosterForTick']);
    });

    it('CONTROL: the same const declared in the enclosing scope is clean', () => {
      const fixed = [
        'export async function tick(installs: string[]) {',
        '  const loadAttributionRosterForTick = () => installs;',
        '  return loadAttributionRosterForTick();',
        '}',
      ].join('\n');
      expect(freeNames(fixed)).toEqual([]);
    });

    it('08:23Z admit.ts: a name used before its import was added is caught', () => {
      const broken = 'export function admit(kind: string) { return ADMISSION_RULE_SOURCE_KINDS.includes(kind); }';
      expect(freeNames(broken)).toEqual(['ADMISSION_RULE_SOURCE_KINDS']);
    });

    it('CONTROL: the same call site with its import is clean', () => {
      const fixed = [
        "import { ADMISSION_RULE_SOURCE_KINDS } from './rules';",
        'export function admit(kind: string) { return ADMISSION_RULE_SOURCE_KINDS.includes(kind); }',
      ].join('\n');
      expect(freeNames(fixed)).toEqual([]);
    });
  });
});

describe('repoOwnedInputs', () => {
  it('keeps repo-owned source inputs only: no node_modules, no namespaced virtual modules, no data files', () => {
    const metafile = {
      inputs: {
        'lib/a.ts': {},
        '../../node_modules/x/index.js': {},
        '<define:process.env.X>': {},
        'lib/data.json': {},
        '/abs/elsewhere/b.mjs': {},
      },
    };
    expect(repoOwnedInputs(metafile, '/repo/apps/operator')).toEqual([
      '/abs/elsewhere/b.mjs',
      '/repo/apps/operator/lib/a.ts',
    ]);
  });
});

describe('checkInputs', () => {
  it('separates unreadable files from parser gaps', () => {
    const files: Record<string, string> = {
      '/r/bad-syntax.ts': 'const = ;',
      '/r/free.ts': 'export const v = freeOne;',
    };
    const readFile = (f: string) => {
      if (!(f in files)) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      return files[f];
    };
    const { findings, unreadable, unparsed } = checkInputs(['/r/bad-syntax.ts', '/r/free.ts', '/r/gone.ts'], {
      known: knownGlobalNames(),
      readFile,
    });
    expect(findings).toEqual([{ file: '/r/free.ts', name: 'freeOne', line: 1, column: 18 }]);
    expect(unreadable).toEqual([{ file: '/r/gone.ts', error: 'unreadable: ENOENT' }]);
    expect(unparsed.map((u) => u.file)).toEqual(['/r/bad-syntax.ts']);
  });
});

describe('successful input analysis reuse (EI-27247628229290204)', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'free-refs-cache-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
  const clean = 'export const value = 1;';
  const known = knownGlobalNames();
  const open = (implementation = 'scanner-v1') => createCleanInputCache({ directory, implementation });

  it('reuses a persisted result after relocation, while still reading each input', () => {
    const producer = open();
    expect(checkInputs(['/first/a.ts'], { cache: producer, known, readFile: () => clean }).findings).toEqual([]);
    expect(producer.stats).toEqual({ analyzed: 1, hits: 0 });
    producer.flush();
    const reader = open();
    let reads = 0;
    expect(checkInputs(['/relocated/a.ts'], { cache: reader, known, readFile: () => { reads++; return clean; } }))
      .toEqual({ findings: [], unreadable: [], unparsed: [] });
    expect(reads).toBe(1);
    expect(reader.stats).toEqual({ analyzed: 0, hits: 1 });
  });

  it('invalidates changed bytes and globals, and never caches a finding', () => {
    const cache = open();
    const scan = (code: string, globals = known) => checkInputs(['/a.ts'], { cache, known: globals, readFile: () => code });
    scan(clean);
    expect(scan('export const value = missing;').findings.map(f => f.name)).toEqual(['missing']);
    expect(scan('export const value = missing;').findings.map(f => f.name)).toEqual(['missing']);
    expect(scan('export const value = provided;', knownGlobalNames(['provided'])).findings).toEqual([]);
    expect(scan('export const value = provided;').findings.map(f => f.name)).toEqual(['provided']);
    expect(cache.stats).toEqual({ analyzed: 5, hits: 0 });
  });

  it('separates JSX grammar and implementation identities, and never caches parser gaps', () => {
    const cache = open();
    const readFile = () => 'export const node = <div />;';
    expect(checkInputs(['/a.tsx'], { cache, known, readFile }).unparsed).toEqual([]);
    expect(checkInputs(['/a.ts'], { cache, known, readFile }).unparsed).toHaveLength(1);
    expect(checkInputs(['/a.ts'], { cache, known, readFile }).unparsed).toHaveLength(1);
    expect(cache.stats).toEqual({ analyzed: 3, hits: 0 });
    cache.flush();
    const changed = open('scanner-v2');
    checkInputs(['/a.tsx'], { cache: changed, known, readFile });
    expect(changed.stats).toEqual({ analyzed: 1, hits: 0 });
  });

  it('rechecks unreadable inputs and treats corrupt or unavailable storage as a miss', () => {
    const producer = open();
    checkInputs(['/a.ts'], { cache: producer, known, readFile: () => clean }); producer.flush();
    expect(checkInputs(['/a.ts'], { cache: producer, known, readFile: () => { throw new Error('gone'); } }).unreadable).toHaveLength(1);
    const blocked = path.join(directory, 'not-a-directory'); writeFileSync(blocked, 'blocked');
    const unavailable = createCleanInputCache({ directory: blocked, implementation: 'scanner-v1' });
    checkInputs(['/a.ts'], { cache: unavailable, known, readFile: () => clean });
    expect(() => unavailable.flush()).not.toThrow();
    expect(unavailable.stats).toEqual({ analyzed: 1, hits: 0 });
    // A syntactically valid but altered entry must not suppress a real finding.
    const file = path.join(directory, `${createHash('sha256').update('scanner-v1').digest('hex')}.json`);
    writeFileSync(file, '{"version":1,"clean":["' + '0'.repeat(64) + '"],"sha256":"wrong"}');
    const corrupted = open();
    checkInputs(['/a.ts'], { cache: corrupted, known, readFile: () => clean });
    expect(corrupted.stats).toEqual({ analyzed: 1, hits: 0 });
  });

  it('bounds persisted entries without changing the outcome of evicted inputs', () => {
    const openBounded = () => createCleanInputCache({ directory, implementation: 'bounded', maxEntries: 1 });
    const producer = openBounded();
    checkInputs(['/a.ts', '/b.ts'], { cache: producer, known,
      readFile: file => file === '/a.ts' ? clean : 'export const other = 2;' });
    producer.flush();
    const reader = openBounded();
    expect(checkInputs(['/b.ts', '/a.ts'], { cache: reader, known,
      readFile: file => file === '/a.ts' ? clean : 'export const other = 2;' }).findings).toEqual([]);
    expect(reader.stats).toEqual({ analyzed: 1, hits: 1 });
  });
});

describe('main (the CLI bundle-host.sh runs)', () => {
  let dir: string;
  let metafilePath: string;
  let baseline: string;
  let logs: string[];
  let errors: string[];
  const io = () => ({ log: (l: string) => logs.push(l), error: (l: string) => errors.push(l) });
  const result = () => logs.find((l) => l.startsWith('BUNDLE_FREE_REFS_RESULT')) ?? '';

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bundle-free-refs-'));
    logs = [];
    errors = [];
    writeFileSync(path.join(dir, 'old.ts'), 'export const s = staleFree;');
    writeFileSync(path.join(dir, 'new.ts'), 'export const f = freshFree;');
    writeFileSync(path.join(dir, 'clean.ts'), "import { z } from './z';\nexport const c = z;");
    metafilePath = path.join(dir, 'meta.json');
    writeFileSync(metafilePath, JSON.stringify({ inputs: { 'old.ts': {}, 'new.ts': {}, 'clean.ts': {} } }));
    baseline = path.join(dir, 'hono-host.mjs');
    writeFileSync(baseline, '// last-known-good bundle');
    const now = Date.now() / 1000;
    utimesSync(path.join(dir, 'old.ts'), now - 100, now - 100);
    utimesSync(path.join(dir, 'clean.ts'), now - 100, now - 100);
    utimesSync(baseline, now - 50, now - 50);
    utimesSync(path.join(dir, 'new.ts'), now, now);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('checks only inputs modified after the last-known-good bundle and refuses on a free reference', () => {
    const code = main(['--metafile', metafilePath, '--base-dir', dir, '--since', baseline], io());
    expect(code).toBe(1);
    expect(result()).toMatch(/status=refused selection=changed-since-baseline inputs=3 checked=1 findings=1 unreadable=0 unparsed=0/);
    expect(errors.join('\n')).toContain('`freshFree`');
    expect(errors.join('\n')).not.toContain('staleFree');
  });

  it('passes when the changed input is clean', () => {
    writeFileSync(path.join(dir, 'new.ts'), "import { freshFree } from './f';\nexport const f = freshFree;");
    const code = main(['--metafile', metafilePath, '--base-dir', dir, '--since', baseline], io());
    expect(code).toBe(0);
    expect(result()).toMatch(/status=clean selection=changed-since-baseline inputs=3 checked=1 findings=0 unreadable=0/);
  });

  it('reports inconclusive and refuses publication when every selected input is unparsed', () => {
    writeFileSync(path.join(dir, 'new.ts'), 'const = ;');
    const code = main(['--metafile', metafilePath, '--base-dir', dir, '--since', baseline], io());
    expect(code).toBe(1);
    expect(result()).toMatch(/status=inconclusive selection=changed-since-baseline inputs=3 checked=1 findings=0 unreadable=0 unparsed=1/);
    expect(errors.join('\n')).toContain('no selected inputs could be analysed');
  });

  it('retains clean when some selected inputs parse cleanly beside an unparsed input', () => {
    writeFileSync(path.join(dir, 'new.ts'), 'const = ;');
    writeFileSync(path.join(dir, 'clean.ts'), "import { z } from './z';\nexport const c = z;");
    const now = Date.now() / 1000;
    utimesSync(path.join(dir, 'clean.ts'), now, now);
    const code = main(['--metafile', metafilePath, '--base-dir', dir, '--since', baseline], io());
    expect(code).toBe(0);
    expect(result()).toMatch(/status=clean selection=changed-since-baseline inputs=3 checked=2 findings=0 unreadable=0 unparsed=1/);
  });

  it("honours esbuild's own --define:NAME=VALUE arguments, passed through verbatim", () => {
    const code = main(['--metafile', metafilePath, '--base-dir', dir, '--since', baseline, '--define:freshFree="x"'], io());
    expect(code).toBe(0);
    expect(result()).toMatch(/status=clean/);
  });

  // WI-6554700010030641: a scratch-outdir build has no last-known-good bundle. It used to
  // report status=skipped and exit 0 — indistinguishable from a pass — so a smoke-test build
  // read green over a tree the live rebuild refused. No baseline must mean a FULL scan.
  it('checks EVERY input, and refuses on a finding, when there is no last-known-good bundle', () => {
    const code = main(['--metafile', metafilePath, '--base-dir', dir, '--since', path.join(dir, 'absent.mjs')], io());
    expect(code).toBe(1);
    expect(result()).toMatch(/status=refused selection=no-baseline-full inputs=3 checked=3 findings=2 unreadable=0 unparsed=0/);
    expect(result()).not.toMatch(/skipped/);
    // staleFree is OLDER than any baseline would be: only a full scan can see it.
    expect(errors.join('\n')).toContain('`staleFree`');
    expect(errors.join('\n')).toContain('no last-known-good bundle');
  });

  it('reports clean (exit 0) on a no-baseline full scan only after analysing every input', () => {
    writeFileSync(path.join(dir, 'old.ts'), "import { staleFree } from './s';\nexport const s = staleFree;");
    writeFileSync(path.join(dir, 'new.ts'), "import { freshFree } from './f';\nexport const f = freshFree;");
    const code = main(['--metafile', metafilePath, '--base-dir', dir, '--since', path.join(dir, 'absent.mjs')], io());
    expect(code).toBe(0);
    expect(result()).toMatch(/status=clean selection=no-baseline-full inputs=3 checked=3 findings=0/);
  });

  it('refuses when a metafile input cannot be read instead of reporting a clean analysis', () => {
    const missingMeta = path.join(dir, 'missing-input-meta.json');
    writeFileSync(missingMeta, JSON.stringify({ inputs: { 'missing.ts': {} } }));
    const code = main(['--metafile', missingMeta, '--base-dir', dir, '--all'], io());
    expect(code).toBe(1);
    expect(result()).toMatch(/status=refused selection=all inputs=1 checked=1 findings=0 unreadable=1 unparsed=0/);
    expect(errors.join('\n')).toContain('could not read');
    expect(errors.join('\n')).toContain('refusing to publish an input the guard could not analyze');
  });

  it('--all checks every repo-owned input', () => {
    const code = main(['--metafile', metafilePath, '--base-dir', dir, '--all', '--json'], io());
    expect(code).toBe(1);
    const report = JSON.parse(logs[0]) as { checked: number; findings: Array<{ name: string }> };
    expect(report.checked).toBe(3);
    expect(report.findings.map((f) => f.name).sort()).toEqual(['freshFree', 'staleFree']);
  });

  it('exits 2 on misuse instead of reading as clean', () => {
    expect(main(['--base-dir', dir], io())).toBe(2);
    expect(main(['--metafile', metafilePath, '--base-dir', dir, '--bogus'], io())).toBe(2);
    expect(main(['--metafile', path.join(dir, 'no-such-meta.json'), '--base-dir', dir], io())).toBe(2);
    expect(logs.filter((l) => l === 'BUNDLE_FREE_REFS_RESULT status=error')).toHaveLength(3);
  });
});

describe('bundle-host.sh wiring', () => {
  const script = readFileSync(path.join(__dirname, '..', 'apps', 'operator', 'bin', 'bundle-host.sh'), 'utf8');

  it('runs the guard against the last-known-good bundle BEFORE the atomic swap, and fails the build on findings', () => {
    const guard = script.indexOf('scripts/check-bundle-free-refs.mjs');
    const swap = script.indexOf('mv -f "$TMPFILE" "$OUTFILE"');
    expect(guard).toBeGreaterThan(-1);
    expect(swap).toBeGreaterThan(guard);
    // The guard's own `if !` block, up to its closing `fi` LINE (a bare 'fi' also matches '--metafile').
    const invocation = script.slice(guard, script.indexOf('\n  fi\n', guard));
    expect(invocation).toContain('--since "$OUTFILE"');
    expect(invocation).toContain('--metafile "$METAFILE"');
    // esbuild's metafile input keys are repository-root relative. A wrong base can
    // turn every input into ENOENT, so keep the caller aligned with that path basis.
    expect(invocation).toContain('--base-dir "$REPO_ROOT"');
    expect(invocation).toContain('exit 1');
  });
});
