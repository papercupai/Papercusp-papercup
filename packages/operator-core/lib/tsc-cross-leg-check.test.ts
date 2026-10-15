/**
 * WI-6554700010009433 — the cross-leg primitive must report the diagnostics a file has inside a
 * leg that reaches it ONLY by import, which is exactly what `lint:tsc --files` (owning leg only)
 * misses. The fixture reproduces the WI-6554700010009424 class in miniature: leg A provides an
 * ambient module shim through its include glob, leg B reaches `a/src/f.ts` by import alone.
 *
 * The second half pins the gate wiring built on it: the plan (which leg judges which file), the
 * consumer verdict, the fan-out's red/undetermined rule, the report, and an end-to-end parent run
 * whose owning leg is clean while a sibling leg reds.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { legFileDiagnostics, projectFromTscCommand } from '../../../scripts/lib/tsc-cross-leg-check.mjs';
import {
  CROSS_LEG_CONSUMER_ENV,
  CROSS_LEG_ENV,
  CROSS_LEG_MARKER,
  INLINE_FILES_ARG_MAX_CHARS,
  TOOLCHAIN_FAILURE_EXIT_CODE,
  countByFile,
  discoverSiblingTypecheckGates,
  formatCrossLegReport,
  judgeCrossLegMembers,
  parseExplicitFiles,
  parseTscErrors,
  planCrossLegChecks,
  runCrossLegChecks,
  runCrossLegConsumer,
  scopedFilesArg,
} from '../../../scripts/lib/tsc-baseline-gate.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const gateUrl = pathToFileURL(join(repoRoot, 'scripts/lib/tsc-baseline-gate.mjs')).href;

const LEG_A = 'npx tsc -p a/tsconfig.json --noEmit --incremental false';
const LEG_B = 'npx tsc -p b/tsconfig.json --noEmit --incremental false';

/** The a/b fixture: `a/src/f.ts` leans on a shim only leg A's include glob provides. */
function writeLegFixture(dir: string) {
  const compilerOptions = {
    strict: true,
    target: 'es2022',
    module: 'esnext',
    moduleResolution: 'bundler',
    skipLibCheck: true,
    types: [],
  };
  mkdirSync(join(dir, 'a/src'), { recursive: true });
  mkdirSync(join(dir, 'b'), { recursive: true });
  writeFileSync(join(dir, 'a/tsconfig.json'), JSON.stringify({ compilerOptions, include: ['src/**/*'] }));
  writeFileSync(join(dir, 'a/src/shim.d.ts'), "declare module 'virtual-mod' { export const value: number; }\n");
  writeFileSync(
    join(dir, 'a/src/f.ts'),
    "import { value } from 'virtual-mod';\nexport const doubled: number = value * 2;\n",
  );
  writeFileSync(join(dir, 'b/tsconfig.json'), JSON.stringify({ compilerOptions, include: ['entry.ts'] }));
  writeFileSync(join(dir, 'b/entry.ts'), "import { doubled } from '../a/src/f';\nexport const out = doubled;\n");
}

const root = mkdtempSync(join(tmpdir(), 'tsc-cross-leg-'));
writeLegFixture(root);
const EMPTY_BASELINE = join(root, 'baseline-empty.json');
const A_ROW_BASELINE = join(root, 'baseline-a-row.json');
writeFileSync(EMPTY_BASELINE, JSON.stringify({ files: {} }));
writeFileSync(A_ROW_BASELINE, JSON.stringify({ files: { 'a/src/f.ts': 1 } }));

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('legFileDiagnostics', () => {
  it('is clean in the owning leg, whose include glob reaches the ambient shim', () => {
    const result = legFileDiagnostics({ root, tscCommand: LEG_A, files: ['a/src/f.ts'] });
    expect(result.members).toEqual(['a/src/f.ts']);
    expect(result.diagnosticCount).toBe(0);
    expect(result.output).toBe('');
  });

  it('reports the import-only leg diagnostic the owning-leg check misses', () => {
    const result = legFileDiagnostics({ root, tscCommand: LEG_B, files: ['a/src/f.ts'] });
    expect(result.members).toEqual(['a/src/f.ts']);
    expect(result.diagnosticCount).toBe(1);
    expect(result.output).toMatch(/^a\/src\/f\.ts\(1,\d+\): error TS2307: Cannot find module 'virtual-mod'/m);
  });

  it('renders output the gate parser attributes to the right file', () => {
    const { output } = legFileDiagnostics({ root, tscCommand: LEG_B, files: ['a/src/f.ts'] });
    expect(countByFile(parseTscErrors(output))).toEqual({ 'a/src/f.ts': 1 });
  });

  it('names a file outside the leg program as a non-member instead of calling it clean', () => {
    const result = legFileDiagnostics({ root, tscCommand: LEG_B, files: ['a/src/shim.d.ts', 'a/src/f.ts'] });
    expect(result.nonMembers).toEqual(['a/src/shim.d.ts']);
    expect(result.members).toEqual(['a/src/f.ts']);
  });
});

describe('projectFromTscCommand', () => {
  it('splits the project from the extra compiler flags', () => {
    expect(
      projectFromTscCommand(
        'npx tsc -p packages/agent-mcp/tsconfig.json --noEmit --incremental false --allowImportingTsExtensions',
      ),
    ).toEqual({
      project: 'packages/agent-mcp/tsconfig.json',
      flags: ['--noEmit', '--incremental', 'false', '--allowImportingTsExtensions'],
    });
  });

  it('returns null when there is no -p operand', () => {
    expect(projectFromTscCommand('npx tsc --noEmit')).toBeNull();
  });
});

const GATE_A = { npmScript: 'lint:tsc:a', prefixes: ['a/'], scriptPath: 'gates/a.mjs', tscCommand: LEG_A };
const GATE_B = { npmScript: 'lint:tsc:b', prefixes: ['b/'], scriptPath: 'gates/b.mjs', tscCommand: LEG_B };
const GATE_MULTI = { npmScript: 'lint:tsc:multi', prefixes: ['c/', 'd/'], scriptPath: 'gates/multi.mjs', tscCommand: null };

describe('planCrossLegChecks', () => {
  it('gives each single-project leg the named files it does not own', () => {
    const { plans, uncheckable } = planCrossLegChecks({
      gates: [GATE_A, GATE_B, GATE_MULTI],
      files: ['a/src/f.ts', './b/entry.ts', 'c/other.ts'],
    });
    expect(plans).toEqual([
      { npmScript: 'lint:tsc:a', scriptPath: 'gates/a.mjs', files: ['b/entry.ts', 'c/other.ts'] },
      { npmScript: 'lint:tsc:b', scriptPath: 'gates/b.mjs', files: ['a/src/f.ts', 'c/other.ts'] },
    ]);
    // A multi-project gate cannot consume: it is NAMED, never silently treated as checked.
    expect(uncheckable).toEqual(['lint:tsc:multi']);
  });

  it('plans nothing for a leg that owns every named file', () => {
    expect(planCrossLegChecks({ gates: [GATE_A], files: ['a/src/f.ts'] })).toEqual({ plans: [], uncheckable: [] });
  });

  it('hands a file no gate owns to every single-project leg', () => {
    const { plans } = planCrossLegChecks({ gates: [GATE_A, GATE_B], files: ['elsewhere/x.ts'] });
    expect(plans.map((plan) => [plan.npmScript, plan.files])).toEqual([
      ['lint:tsc:a', ['elsewhere/x.ts']],
      ['lint:tsc:b', ['elsewhere/x.ts']],
    ]);
  });

  // WI-6554700010009433: `--files=CLAUDE.md` used to cost a full compile of every sibling leg
  // (84s against ~1s for the out-of-scope verdict alone) and then reported those legs clean
  // for a file none of them contains. The real-gate run in lint-tsc.test.ts times out on it.
  it('never plans a non-source file, which no leg program can contain', () => {
    expect(
      planCrossLegChecks({ gates: [GATE_A, GATE_B], files: ['CLAUDE.md', 'a/README.md', './b/data.json'] }),
    ).toEqual({ plans: [], uncheckable: [] });
  });

  it('keeps every TypeScript and JavaScript source extension', () => {
    const sources = ['x/a.ts', 'x/b.tsx', 'x/c.mts', 'x/d.cts', 'x/e.d.ts', 'x/f.js', 'x/g.jsx', 'x/h.mjs', 'x/i.cjs'];
    const { plans } = planCrossLegChecks({ gates: [GATE_A], files: [...sources, 'x/notes.md', 'x/tsconfig.json'] });
    expect(plans).toEqual([{ npmScript: 'lint:tsc:a', scriptPath: 'gates/a.mjs', files: sources }]);
  });
});

describe('judgeCrossLegMembers', () => {
  const ts2307 = parseTscErrors(
    "a/src/f.ts(1,23): error TS2307: Cannot find module 'virtual-mod' or its corresponding type declarations.\n",
  );

  it('reports a member over its baseline as regressed', () => {
    expect(judgeCrossLegMembers({ members: ['a/src/f.ts'], errors: ts2307, baselineByFile: {} })).toEqual({
      regressed: [{ file: 'a/src/f.ts', current: 1, baseline: 0 }],
      broken: [],
    });
  });

  it('is clean at the leg baseline', () => {
    expect(
      judgeCrossLegMembers({ members: ['a/src/f.ts'], errors: ts2307, baselineByFile: { 'a/src/f.ts': 1 } }),
    ).toEqual({ regressed: [], broken: [] });
  });

  it('honours the owning package row inherited through a foreign baseline', () => {
    expect(
      judgeCrossLegMembers({
        members: ['a/src/f.ts'],
        errors: ts2307,
        baselineByFile: {},
        foreignBaselines: [{ prefix: 'a/', files: { 'a/src/f.ts': 1 } }],
      }).regressed,
    ).toEqual([]);
  });

  it('ignores diagnostics in files this leg was not asked to judge', () => {
    const elsewhere = parseTscErrors("b/entry.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.\n");
    expect(judgeCrossLegMembers({ members: ['a/src/f.ts'], errors: elsewhere, baselineByFile: {} })).toEqual({
      regressed: [],
      broken: [],
    });
  });

  it('hard-fails a TS1xxx diagnostic even under a covering baseline', () => {
    const syntax = parseTscErrors("a/src/f.ts(2,1): error TS1005: ';' expected.\n");
    expect(
      judgeCrossLegMembers({ members: ['a/src/f.ts'], errors: syntax, baselineByFile: { 'a/src/f.ts': 5 } }),
    ).toEqual({ regressed: [], broken: ['a/src/f.ts'] });
  });
});

describe('runCrossLegConsumer', () => {
  async function consume(args: {
    tscCommand: string;
    baselineFile: string;
    foreignBaselines?: { prefix: string; baselineFile: string }[];
    diagnose?: () => never;
  }) {
    const lines: string[] = [];
    const warnings: string[] = [];
    const code = await runCrossLegConsumer({
      root,
      label: 'leg',
      files: ['a/src/f.ts'],
      log: (line: string) => lines.push(line),
      warn: (line: string) => warnings.push(line),
      ...args,
    });
    return { code, marker: lines.at(-1), warnings: warnings.join('\n') };
  }

  it('exits 1 with a regressed marker when the importing leg cannot see the shim', async () => {
    const { code, marker, warnings } = await consume({ tscCommand: LEG_B, baselineFile: EMPTY_BASELINE });
    expect(code).toBe(1);
    expect(marker).toBe(`${CROSS_LEG_MARKER} leg=leg status=regressed members=1 nonMembers=0 regressed=1`);
    expect(warnings).toMatch(/error TS2307: Cannot find module 'virtual-mod'/);
  });

  it('exits 0 with a clean marker in the leg whose include glob provides the shim', async () => {
    const { code, marker } = await consume({ tscCommand: LEG_A, baselineFile: EMPTY_BASELINE });
    expect(code).toBe(0);
    expect(marker).toBe(`${CROSS_LEG_MARKER} leg=leg status=clean members=1 nonMembers=0 regressed=0`);
  });

  it('accepts an error the owning package baseline already records', async () => {
    const { code } = await consume({
      tscCommand: LEG_B,
      baselineFile: EMPTY_BASELINE,
      foreignBaselines: [{ prefix: 'a/', baselineFile: A_ROW_BASELINE }],
    });
    expect(code).toBe(0);
  });

  it('is undetermined, never clean, when its own baseline is unreadable', async () => {
    const { code, marker } = await consume({ tscCommand: LEG_B, baselineFile: join(root, 'missing.json') });
    expect(code).toBe(66);
    expect(marker).toBe(`${CROSS_LEG_MARKER} leg=leg status=undetermined reason=baseline-unreadable`);
  });

  it('is undetermined when the leg program cannot be built', async () => {
    const { code, marker } = await consume({
      tscCommand: LEG_B,
      baselineFile: EMPTY_BASELINE,
      diagnose: () => {
        throw new Error('no -p project');
      },
    });
    expect(code).toBe(TOOLCHAIN_FAILURE_EXIT_CODE);
    expect(marker).toBe(`${CROSS_LEG_MARKER} leg=leg status=undetermined reason=program-failed`);
  });
});

describe('scopedFilesArg (WI-6554700010009716: spawn E2BIG on a huge --files list)', () => {
  const tmpRoots: string[] = [];
  afterAll(() => {
    for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
  });
  // ~560 KB joined: past Linux's 128 KiB MAX_ARG_STRLEN for a single argv string.
  const many = Array.from({ length: 20_000 }, (_, i) => `packages/x/src/file-${String(i).padStart(5, '0')}.ts`);

  it('keeps a short list inline with nothing to clean up', () => {
    const r = scopedFilesArg(['a.ts', 'b.ts']);
    expect(r).toMatchObject({ arg: '--files=a.ts,b.ts', responseFile: null });
    r.cleanup();
  });

  it('moves a list past the inline cap into a --files-from response file that parses to the same set', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'scoped-files-arg-'));
    tmpRoots.push(tmpRoot);
    const r = scopedFilesArg(many, { tmpRoot });
    expect(r.arg.startsWith('--files-from=')).toBe(true);
    expect(r.arg.length).toBeLessThan(INLINE_FILES_ARG_MAX_CHARS);
    expect(existsSync(r.responseFile!)).toBe(true);
    expect(parseExplicitFiles([r.arg])).toEqual(new Set(many));
    r.cleanup();
    expect(existsSync(r.responseFile!)).toBe(false);
  });

  it('a real cross-leg child receives a >128 KiB file list instead of dying with spawn E2BIG', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cross-leg-e2big-'));
    tmpRoots.push(dir);
    expect(`--files=${many.join(',')}`.length).toBeGreaterThan(128 * 1024);
    const gate = pathToFileURL(fileURLToPath(new URL('../../../scripts/lib/tsc-baseline-gate.mjs', import.meta.url))).href;
    const script = join(dir, 'child.mjs');
    writeFileSync(
      script,
      `import { parseExplicitFiles, CROSS_LEG_MARKER } from ${JSON.stringify(gate)};\n` +
        'const n = parseExplicitFiles(process.argv.slice(2))?.size ?? 0;\n' +
        'console.log(`${CROSS_LEG_MARKER} leg=x status=clean members=${n} nonMembers=0 regressed=0`);\n',
    );
    const report = await runCrossLegChecks({ root: dir, plans: [{ npmScript: 'leg', scriptPath: script, files: many }] });
    expect(report.undetermined).toEqual([]);
    expect(report.clean).toEqual(['leg']);
  }, 60_000);
});

describe('runCrossLegChecks', () => {
  const plan = (npmScript: string) => ({ npmScript, scriptPath: `gates/${npmScript}.mjs`, files: ['a/src/f.ts'] });
  const withMarker = (status: string) =>
    `noise before the marker\n${CROSS_LEG_MARKER} leg=x status=${status} members=1 nonMembers=0 regressed=0\n`;
  const outcomes: Record<string, { status: number | null; stdout: string; stderr: string }> = {
    clean: { status: 0, stdout: withMarker('clean'), stderr: '' },
    red: { status: 1, stdout: withMarker('regressed'), stderr: '❌ evidence\n' },
    crashed: { status: null, stdout: '', stderr: 'Killed\n' },
    exitOneNoMarker: { status: 1, stdout: 'Error: cannot import\n', stderr: '' },
    cleanMarkerExitOne: { status: 1, stdout: withMarker('clean'), stderr: '' },
    regressedMarkerExitZero: { status: 0, stdout: withMarker('regressed'), stderr: '' },
  };

  it('is red only on exit 1 with a regressed marker; every other outcome is undetermined', async () => {
    const report = await runCrossLegChecks({
      root,
      plans: Object.keys(outcomes).map(plan),
      spawnChild: async (child: { npmScript: string }) => outcomes[child.npmScript],
    });
    expect(report.clean).toEqual(['clean']);
    expect(report.red).toEqual([{ npmScript: 'red', stderr: '❌ evidence\n' }]);
    expect(report.undetermined).toEqual([
      { npmScript: 'crashed', reason: `exit signal, no ${CROSS_LEG_MARKER} marker` },
      { npmScript: 'exitOneNoMarker', reason: `exit 1, no ${CROSS_LEG_MARKER} marker` },
      { npmScript: 'cleanMarkerExitOne', reason: 'exit 1, status=clean' },
      { npmScript: 'regressedMarkerExitZero', reason: 'exit 0, status=regressed' },
    ]);
  });

  it('routes a clean leg that compiled none of the named files to notMember, never clean', async () => {
    // WI-6554700010009515: a members=0 clean is vacuous, since that leg checked nothing.
    const byLeg: Record<string, { status: number | null; stdout: string; stderr: string }> = {
      member: outcomes.clean,
      nonMember: { status: 0, stdout: `${CROSS_LEG_MARKER} leg=x status=clean members=0 nonMembers=2 regressed=0\n`, stderr: '' },
      legacyNoMembersField: { status: 0, stdout: `${CROSS_LEG_MARKER} leg=x status=clean\n`, stderr: '' },
    };
    const report = await runCrossLegChecks({
      root,
      plans: Object.keys(byLeg).map(plan),
      spawnChild: async (child: { npmScript: string }) => byLeg[child.npmScript],
    });
    expect(report.clean).toEqual(['member', 'legacyNoMembersField']);
    expect(report.notMember).toEqual(['nonMember']);
    expect(report.red).toEqual([]);
    expect(report.undetermined).toEqual([]);
  });

  it('runs at most `concurrency` children at once, and each plan exactly once', async () => {
    let inFlight = 0;
    let peak = 0;
    const started: string[] = [];
    const names = ['p1', 'p2', 'p3', 'p4', 'p5'];
    const report = await runCrossLegChecks({
      root,
      concurrency: 2,
      plans: names.map(plan),
      spawnChild: async (child: { npmScript: string }) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        started.push(child.npmScript);
        await new Promise((done) => setTimeout(done, 5));
        inFlight -= 1;
        return outcomes.clean;
      },
    });
    expect(peak).toBe(2);
    expect([...started].sort()).toEqual(names);
    expect(report.clean).toEqual(names);
  });

  it('spawns the leg script with --files from the repo root, as a consumer that cannot recurse', async () => {
    // The default spawn path, with a stand-in leg that reports what it was given as red evidence.
    writeFileSync(
      join(root, 'echo-leg.mjs'),
      'console.error(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), ' +
        `consumer: process.env.${CROSS_LEG_CONSUMER_ENV} ?? null, autoRoute: process.env.PAPERCUSP_TSC_AUTO_ROUTE ?? null }));\n` +
        `console.log('${CROSS_LEG_MARKER} leg=echo status=regressed members=2 nonMembers=0 regressed=0');\n` +
        'process.exit(1);\n',
    );
    const report = await runCrossLegChecks({
      root,
      plans: [{ npmScript: 'lint:tsc:echo', scriptPath: 'echo-leg.mjs', files: ['a/src/f.ts', 'b/entry.ts'] }],
    });
    expect(report.undetermined).toEqual([]);
    const seen = JSON.parse(report.red[0].stderr);
    expect(seen.argv).toEqual(['--files=a/src/f.ts,b/entry.ts']);
    expect(realpathSync(seen.cwd)).toBe(realpathSync(root));
    expect(seen.consumer).toBe('1');
    expect(seen.autoRoute).toBe('1');
  });

  it('stops waiting on a cross-leg child after the bounded deadline and reports it undetermined', async () => {
    writeFileSync(join(root, 'stuck-leg.mjs'), 'setInterval(() => {}, 60_000);\n');
    const startedAt = Date.now();
    const report = await runCrossLegChecks({
      root,
      childTimeoutMs: 50,
      plans: [{ npmScript: 'lint:tsc:stuck', scriptPath: 'stuck-leg.mjs', files: ['a/src/f.ts'] }],
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(report.clean).toEqual([]);
    expect(report.red).toEqual([]);
    expect(report.undetermined).toEqual([
      { npmScript: 'lint:tsc:stuck', reason: 'timed out after 50ms' },
    ]);
  });
});

describe('formatCrossLegReport', () => {
  it('summarises the fan-out on one machine-readable line', () => {
    expect(
      formatCrossLegReport({ clean: ['lint:tsc'], red: [], undetermined: [], uncheckable: ['lint:tsc:workspaces'] }),
    ).toEqual([
      `${CROSS_LEG_MARKER} checked=1 clean=lint:tsc red=- undetermined=- uncheckable=lint:tsc:workspaces notMember=-`,
    ]);
  });

  it('names a notMember leg separately and never counts it as checked', () => {
    const lines = formatCrossLegReport({
      clean: ['lint:tsc'],
      notMember: ['lint:tsc:operator-vite', 'lint:tsc:orchestrator'],
      red: [],
      undetermined: [],
      uncheckable: [],
    });
    expect(lines[0]).toBe(
      `${CROSS_LEG_MARKER} checked=1 clean=lint:tsc red=- undetermined=- uncheckable=- ` +
        'notMember=lint:tsc:operator-vite,lint:tsc:orchestrator',
    );
    expect(lines).toContain(
      'ⓘ cross-leg: lint:tsc:operator-vite compiles none of the named files; nothing was checked there (it cannot red on them).',
    );
    expect(lines.filter((line) => line.startsWith('ⓘ cross-leg:'))).toHaveLength(2);
  });

  it('quotes the red leg evidence and names an undetermined leg as unchecked', () => {
    const lines = formatCrossLegReport({
      clean: [],
      red: [{ npmScript: 'lint:tsc:scripts', stderr: '❌ red\n\n   a/src/f.ts(1,1): error TS2307: missing\n' }],
      undetermined: [{ npmScript: 'lint:tsc:operator', reason: 'exit signal, no LINT_TSC_CROSS_LEG marker' }],
      uncheckable: [],
    });
    expect(lines[0]).toBe(
      `${CROSS_LEG_MARKER} checked=1 clean=- red=lint:tsc:scripts undetermined=lint:tsc:operator uncheckable=- notMember=-`,
    );
    expect(lines).toContain('   ❌ red');
    expect(lines).toContain('      a/src/f.ts(1,1): error TS2307: missing');
    expect(lines.some((line) => line.startsWith('⚠ cross-leg: lint:tsc:operator UNDETERMINED'))).toBe(true);
    expect(lines.at(-1)).toMatch(/--no-cross-leg/);
  });
});

describe('discoverSiblingTypecheckGates on the real roster', () => {
  it('returns a repo-relative scriptPath, and a tscCommand only for single-project legs', async () => {
    const { gates, rosterReadable } = await discoverSiblingTypecheckGates(repoRoot);
    expect(rosterReadable).toBe(true);
    const byName = new Map(gates.map((gate) => [gate.npmScript, gate]));
    expect(byName.get('lint:tsc:scripts')).toMatchObject({
      scriptPath: 'scripts/lint-tsc-scripts.mjs',
      tscCommand: expect.stringMatching(/-p scripts\/tsconfig\.json\b/),
    });
    expect(byName.get('lint:tsc:workspaces')?.tscCommand).toBeNull();
    for (const gate of gates) expect(isAbsolute(gate.scriptPath)).toBe(false);
  }, 60_000);
});

describe('runTscBaselineGate cross-leg fan-out, end to end', () => {
  // A roster of two real gate CLIs. Each runs only as a consumer child: the parent imports both
  // modules during discovery, and neither must start a gate run there.
  function writeRoster(dir: string) {
    writeLegFixture(dir);
    mkdirSync(join(dir, 'gates'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { 'lint:tsc:a': 'node gates/a.mjs', 'lint:tsc:b': 'node gates/b.mjs' } }),
    );
    for (const [leg, command] of [
      ['a', LEG_A],
      ['b', LEG_B],
    ]) {
      writeFileSync(join(dir, `baseline-${leg}.json`), JSON.stringify({ files: {} }));
      writeFileSync(
        join(dir, `gates/${leg}.mjs`),
        `import { runTscBaselineGate } from ${JSON.stringify(gateUrl)};\n` +
          `export const TSC_COMMAND = ${JSON.stringify(command)};\n` +
          `if (process.env.${CROSS_LEG_CONSUMER_ENV} === '1') {\n` +
          `  await runTscBaselineGate({ root: ${JSON.stringify(dir)}, tscCommand: TSC_COMMAND, ` +
          `baselineFile: ${JSON.stringify(join(dir, `baseline-${leg}.json`))}, label: 'lint:tsc:${leg}', ` +
          'argv: process.argv.slice(2) });\n' +
          '}\n',
      );
    }
  }

  /** The parent: an owning-leg stand-in whose own compile only leaves a marker file. */
  function runParent(dir: string, argv: string[], env: Record<string, string> = {}) {
    const compiled = join(dir, 'parent-compiled');
    rmSync(compiled, { force: true });
    writeFileSync(
      join(dir, 'parent.mjs'),
      `import { runTscBaselineGate } from ${JSON.stringify(gateUrl)};\n` +
        `await runTscBaselineGate({ root: ${JSON.stringify(dir)}, tscCommand: ${JSON.stringify(`printf tsc > ${compiled}`)}, ` +
        `baselineFile: ${JSON.stringify(join(dir, 'baseline-parent.json'))}, label: 'parent', argv: ${JSON.stringify(argv)} });\n`,
    );
    writeFileSync(join(dir, 'baseline-parent.json'), JSON.stringify({ files: {} }));
    // Strip the fan-out controls this test process may carry, THEN apply the case's own.
    const childEnv: Record<string, string | undefined> = { ...process.env };
    delete childEnv[CROSS_LEG_CONSUMER_ENV];
    delete childEnv.PAPERCUSP_TSC_AUTO_ROUTE;
    delete childEnv[CROSS_LEG_ENV];
    Object.assign(childEnv, env);
    try {
      const out = execFileSync(process.execPath, [join(dir, 'parent.mjs')], {
        cwd: dir,
        encoding: 'utf8',
        stdio: 'pipe',
        env: childEnv,
        timeout: 120_000,
      });
      return { out, code: 0, compiled: existsSync(compiled) };
    } catch (e: any) {
      return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? -1, compiled: existsSync(compiled) };
    }
  }

  const e2eRoot = mkdtempSync(join(tmpdir(), 'tsc-cross-leg-e2e-'));
  writeRoster(e2eRoot);
  afterAll(() => rmSync(e2eRoot, { recursive: true, force: true }));

  it('fails the run when a sibling leg reaches the named file and cannot see its shim', () => {
    const { out, code, compiled } = runParent(e2eRoot, ['--files=a/src/f.ts']);
    expect(code).toBe(1);
    expect(out).toContain(`${CROSS_LEG_MARKER} checked=1 clean=- red=lint:tsc:b undetermined=- uncheckable=-`);
    expect(out).toMatch(/a\/src\/f\.ts\(1,\d+\): error TS2307: Cannot find module 'virtual-mod'/);
    expect(out).toMatch(/LINT_TSC_RESULT label=parent scope=files exit=1 status=routed-failed/);
    // The red arrives BEFORE the parent's own compile, which therefore never ran.
    expect(compiled).toBe(false);
  }, 120_000);

  it('proceeds to its own compile when every sibling leg is clean against its baseline', () => {
    writeFileSync(join(e2eRoot, 'baseline-b.json'), JSON.stringify({ files: { 'a/src/f.ts': 1 } }));
    try {
      const { out, code, compiled } = runParent(e2eRoot, ['--files=a/src/f.ts']);
      expect(code).toBe(0);
      expect(out).toContain(`${CROSS_LEG_MARKER} checked=1 clean=lint:tsc:b red=- undetermined=- uncheckable=-`);
      expect(out).toMatch(/LINT_TSC_RESULT label=parent scope=files exit=0 status=clean/);
      expect(compiled).toBe(true);
    } finally {
      writeFileSync(join(e2eRoot, 'baseline-b.json'), JSON.stringify({ files: {} }));
    }
  }, 120_000);

  it.each([
    ['--no-cross-leg', ['--files=a/src/f.ts', '--no-cross-leg'], {}],
    [`${CROSS_LEG_ENV}=0`, ['--files=a/src/f.ts'], { [CROSS_LEG_ENV]: '0' }],
    ['a routed child (no recursion)', ['--files=a/src/f.ts'], { PAPERCUSP_TSC_AUTO_ROUTE: '1' }],
  ])('skips the fan-out under %s', (_name, argv, env) => {
    const { out, code, compiled } = runParent(e2eRoot, argv as string[], env as Record<string, string>);
    expect(out).not.toContain(CROSS_LEG_MARKER);
    expect(code).toBe(0);
    expect(compiled).toBe(true);
  }, 120_000);

  it('does not fan out on a whole-program run', () => {
    const { out } = runParent(e2eRoot, []);
    expect(out).not.toContain(CROSS_LEG_MARKER);
  }, 120_000);

  it('refuses a consumer child run that names no files', () => {
    let code = 0;
    let out = '';
    try {
      execFileSync(process.execPath, [join(e2eRoot, 'gates/b.mjs')], {
        cwd: e2eRoot,
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, [CROSS_LEG_CONSUMER_ENV]: '1' },
        timeout: 60_000,
      });
    } catch (e: any) {
      code = e.status ?? -1;
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(code).toBe(64);
    expect(out).toContain(`${CROSS_LEG_CONSUMER_ENV}=1 requires --files`);
  }, 60_000);
});
