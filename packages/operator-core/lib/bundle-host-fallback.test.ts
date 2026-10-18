/**
 * EI-20093985382484201 / WI-41242 — a broken shared tree must fail loudly
 * without corrupting the last-known-good bundle.
 *
 * `papercup-{staging,bg-host,dev}-api` run `bundle-host.sh` in ExecStartPre.
 * Shared-tree callers can observe the seconds between two keystrokes of a
 * multi-part edit; staging instead uses a clean isolated checkout and may reuse
 * a separately proven prebuild. In every case the fallback keeps prior bytes
 * intact, while WI-41242 makes a release caller fail loudly rather than report
 * stale code as current.
 *
 * EI-19457229906581679: "deploy/systemd" in the line above used to be one
 * clause, and that conflation was the defect. A non-zero exit stops deploy-cli
 * from REPORTING a release (correct) but stops systemd from STARTING THE UNIT
 * (an outage) — opposite meanings for the same exit code. The caller now
 * declares which question it is asking via PAPERCUSP_BUNDLE_ALLOW_STALE_START;
 * the default is unchanged, so release callers are unaffected.
 *
 * Measured 2026-08-10: ONE unescaped apostrophe inside a tool `description:`
 * string took :3170 down fleet-wide for ~52s over 4 restarts — the SECOND such
 * outage that day, from a different typo by a different agent. The typo is
 * unremarkable and will recur; the outage is the defect. Filed at least three
 * times (EI-20093985382484201, EI-19457410012213374, EI-20086810553934720).
 *
 * ── Why this test can afford to run the real script ──
 * It drives bundle-host.sh with ABSOLUTE entry/outfile paths into a fresh
 * tmpdir, so every artifact it can write — the bundle, the tmp file, the lock,
 * the build log, the marker — lands outside the repo. That matters more than
 * usual here: proving a guard falsifiable by mutating the shared checkout is
 * how a mutant gets committed by the git-sync sweep mid-probe.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mutationProbeAdmissionDir } from '../../../scripts/lib/mutation-probe-window.mjs';
import { localEsbuildNpxPath } from './test-fixtures/local-esbuild-npx';

const REPO_ROOT = resolve(__dirname, '../../..');
// PROBE_SCRIPT makes the subject path overridable, which is what makes a TIER-2
// mutation probe (mutate a COPY outside the tree) possible at all. Without it the
// only way to prove these assertions falsifiable is to mutate the shared checkout
// — where the git-sync sweep can commit the mutant mid-probe even when nothing
// goes wrong and no handler fails. Defaults to the real script, so every normal
// run is unaffected.
const SCRIPT = process.env.PROBE_SCRIPT || join(REPO_ROOT, 'apps/operator/bin/bundle-host.sh');

/** The last-known-good bundle's exact bytes — the thing that must survive. */
const GOOD_BUNDLE = 'console.log("last known good");\n';

let dir: string;
let outfile: string;
let marker: string;
let compilerPath: string;

/** Inject at the compiler seam after the pinned resolver, preserving the real
 * version check and cache-protected execution used by all bundle entries. */
function compilerShim(directory: string, lines: string[]): string {
  mkdirSync(directory, { recursive: true });
  const compiler = execFileSync('npx', ['--yes', '--package=esbuild@0.25.0', '-c', 'command -v esbuild'],
    { env: { ...process.env, PATH: compilerPath }, encoding: 'utf8' }).trim();
  const shim = join(directory, 'esbuild');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(shim, ['#!/usr/bin/env bash', ...lines, `exec ${quote(compiler)} "$@"`, ''].join('\n'), { mode: 0o755 });
  writeFileSync(join(directory, 'npx'), ['#!/usr/bin/env bash', `printf '%s\\n' ${quote(shim)}`, ''].join('\n'), { mode: 0o755 });
  return `${directory}:${compilerPath}`;
}

/** Run bundle-host.sh, returning its exit code and combined output. */
function runBundler(entry: string, extraEnv?: Record<string, string>): { code: number; output: string } {
  // An inherited exported binding would mask a missing export in the script.
  const inheritedEnv = { ...process.env };
  delete inheritedEnv.BUNDLE_HOST_STEP_LOG;
  // EI-24917607035361603: bundle-host.sh's restricted-hold gate (WI-10005745) would read the
  // real org-admin census, which the unit guard refuses, and fail every case closed. Inject an
  // empty census (nothing held) through the CLI's VITEST-only seam; the gate itself still runs.
  const census = join(dir, 'restricted-hold-census.json');
  writeFileSync(census, '[]\n');
  try {
    const output = execFileSync('bash', [SCRIPT, entry, outfile], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 240_000,
      // The strict release path is the default contract. Set it explicitly so
      // a supervisor-only opt-in inherited from the invoking agent/service
      // cannot silently change the first two cases into successful stale boots.
      // WI-10005321: the bundler's mutation-probe gate reads admission markers from this
      // scratch dir, not the live /tmp, so a peer's probe window cannot fail these cases.
      env: {
        ...inheritedEnv,
        PAPERCUSP_BUNDLE_ALLOW_STALE_START: '0',
        PAPERCUSP_MUTATION_PROBE_TMPDIR: dir,
        PAPERCUSP_RESTRICTED_HOLD_CENSUS_FILE: census,
        PATH: compilerPath,
        ...extraEnv,
      },
    });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function writeBrokenEntry(): string {
  const entry = join(dir, 'broken-entry.ts');
  // The REAL 2026-08-10 shape: an unescaped apostrophe closes the string early,
  // leaving the parser inside an object literal expecting `}` and finding `s`.
  writeFileSync(entry, "export const tool = { description: 'this install's root' };\n");
  return entry;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bundle-host-fallback-'));
  outfile = join(dir, 'dist-host', 'hono-host.mjs');
  marker = join(dir, 'dist-host', '.bundle-stale.json');
  compilerPath = localEsbuildNpxPath(join(dir, 'local-compiler'), REPO_ROOT);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('shared bundle compiler pin', () => {
  function runPinnedCompiler(version: string, removeBetweenUses = false) {
    const shimDir = join(dir, 'pin-shim');
    mkdirSync(shimDir);
    const compiler = join(shimDir, 'esbuild');
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(compiler, [
      '#!/usr/bin/env bash',
      '[[ "${BUNDLE_TEST_CACHE_LEASE:-}" == 1 ]] || exit 90',
      'if [[ "${1:-}" == --version ]]; then printf \'%s\\n\' ' + quote(version) + '; exit 0; fi',
      'printf "%s\\n" "$*" >> "$BUNDLE_TEST_COMPILES"',
      '',
    ].join('\n'), { mode: 0o755 });
    writeFileSync(join(shimDir, 'npx'), [
      '#!/usr/bin/env bash',
      '[[ "${BUNDLE_TEST_CACHE_LEASE:-}" == 1 ]] || exit 90',
      'printf "%s\\n" "$*" >> "$BUNDLE_TEST_RESOLVES"',
      `printf '%s\\n' ${quote(compiler)}`,
      '',
    ].join('\n'), { mode: 0o755 });
    const compiles = join(dir, 'compiles.log');
    const resolves = join(dir, 'resolves.log');
    const result = execFileSyncResult('bash', ['-c', [
      'set -euo pipefail',
      'source "$1"',
      'run_sidecar_cached_package() { BUNDLE_TEST_CACHE_LEASE=1 "$@"; }',
      'bundle_host_esbuild "$2" first',
      ...(removeBetweenUses ? ['rm "$3"'] : []),
      'bundle_host_esbuild "$2" second',
    ].join('\n'), 'pin-guard', join(REPO_ROOT, 'apps/operator/bin/bundle-host-common.sh'), REPO_ROOT, compiler],
    { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, BUNDLE_TEST_COMPILES: compiles, BUNDLE_TEST_RESOLVES: resolves });
    return { ...result, compiles: existsSync(compiles) ? readFileSync(compiles, 'utf8') : '',
      resolves: existsSync(resolves) ? readFileSync(resolves, 'utf8') : '' };
  }

  function execFileSyncResult(command: string, args: string[], env: NodeJS.ProcessEnv) {
    try { return { code: 0, output: execFileSync(command, args, { env, encoding: 'utf8', timeout: 10_000 }) }; }
    catch (error) {
      const result = error as { status?: number; stdout?: string; stderr?: string };
      return { code: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
    }
  }

  it('resolves once and validates and compiles each use inside the cache lease', () => {
    const result = runPinnedCompiler('0.25.0');
    expect(result.code, result.output).toBe(0);
    expect(result.resolves.trim().split('\n')).toEqual(['--yes --package=esbuild@0.25.0 -c command -v esbuild']);
    expect(result.compiles.trim().split('\n')).toEqual(['first', 'second']);
  });

  it('refuses a newer resolved compiler before compiling', () => {
    const result = runPinnedCompiler('0.27.3');
    expect(result.code).toBe(78);
    expect(result.output).toContain('requires esbuild 0.25.0; resolved 0.27.3');
    expect(result.compiles).toBe('');
  });

  it('fails closed if cache cleanup removed the resolved compiler between uses', () => {
    const result = runPinnedCompiler('0.25.0', true);
    expect(result.code).toBe(78);
    expect(result.compiles.trim()).toBe('first');
    expect(result.resolves.trim().split('\n')).toHaveLength(1);
  });
});

describe('bundle-host.sh standalone spawner fallback', () => {
  it.each([
    { caller: 'release', allowStale: '0', previousSibling: true, expectedCode: 1 },
    { caller: 'supervisor with prior sibling', allowStale: '1', previousSibling: true, expectedCode: 0 },
    { caller: 'supervisor using the full-host route', allowStale: '1', previousSibling: false, expectedCode: 0 },
  ])('$caller reports a refused standalone build without publishing it', ({ allowStale, previousSibling, expectedCode }) => {
    mkdirSync(join(dir, 'dist-host'), { recursive: true });
    const sibling = join(dir, 'dist-host', 'spawner-sidecar.mjs');
    if (previousSibling) writeFileSync(sibling, GOOD_BUNDLE);
    // A valid custom entry with a maintained entry's basename reaches the REAL
    // worker + spawner wrapper without compiling the full HTTP host graph.
    const entry = join(dir, 'hono-host.ts');
    writeFileSync(entry, 'export const freshHost = true;\n');
    const shimDir = join(dir, 'shim');
    const path = compilerShim(shimDir, [
      'for a in "$@"; do',
      '  if [[ "$a" == */apps/operator/bin/spawner-sidecar.ts ]]; then',
      '    echo "ERROR: injected standalone compiler refusal" >&2; exit 1',
      '  fi',
      'done',
    ]);
    const { code, output } = runBundler(entry, {
      PATH: path,
      PAPERCUSP_BUNDLE_ALLOW_STALE_START: allowStale,
    });
    expect(code, output).toBe(expectedCode);
    expect(output).toContain('standalone spawner build failed');
    expect(readFileSync(outfile, 'utf8')).toContain('freshHost');
    expect(existsSync(sibling)).toBe(previousSibling);
    if (previousSibling) expect(readFileSync(sibling, 'utf8')).toBe(GOOD_BUNDLE);
    const stale = JSON.parse(readFileSync(marker, 'utf8'));
    expect(stale.entry).toBe('bin/spawner-sidecar.ts');
    expect(stale.outfile).toBe(sibling);
    // The failure must remain diagnosable after the calling terminal exits.
    expect(stale.error).toContain('injected standalone compiler refusal');
    expect(readFileSync(sibling + '.build-error.log', 'utf8')).toContain('injected standalone compiler refusal');
    expect(existsSync(join(dir, 'dist-host', '.bundle-fresh.json'))).toBe(false);
  }, 260_000);
});

describe('bundle-host.sh last-known-good fallback', () => {
  it.each(['ASCII', 'rewritten'])('rejects an invalid final %s banner without publishing over LKG', kind => {
    mkdirSync(join(dir, 'dist-host'), { recursive: true });
    writeFileSync(outfile, GOOD_BUNDLE);
    const entry = join(dir, 'invalid-banner-entry.ts');
    writeFileSync(entry, 'export const validInput = true;\n');
    const shimDir = join(dir, 'banner-shim');
    const suffix = kind === 'rewritten' ? ` // ${String.fromCharCode(0xb7)}` : '';
    const path = compilerShim(shimDir, [
      'args=()',
      'for a in "$@"; do',
      `  if [[ "$a" == --banner:js=* ]]; then a="$a const __pc_dirname=1;${suffix}"; fi`,
      '  args+=("$a")',
      'done',
      'set -- "${args[@]}"',
    ]);
    const result = runBundler(entry, { PATH: path });
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain('final bundle failed node --check');
    expect(readFileSync(outfile, 'utf8')).toBe(GOOD_BUNDLE);
    expect(existsSync(marker)).toBe(true);
  }, 260_000);

  it.each([
    '--import=tsx',
    `--import=tsx --import=${REPO_ROOT}/scripts/lib/committed-source-loader.mjs`,
  ])('orders the committed loader before inherited TypeScript hooks (%s)', (nodeOptions) => {
    const entry = join(dir, 'loader-order-entry.ts');
    writeFileSync(entry, 'export const loaderOrder: string = "compiled";\n');
    const result = runBundler(entry, { NODE_OPTIONS: nodeOptions });
    expect(result.code, result.output).toBe(0);
    expect(readFileSync(outfile, 'utf8')).toContain('compiled');
    expect(existsSync(marker)).toBe(false);
  }, 260_000);

  it('retains the accepted dependency graph after cleanup and preserves it on a rejected rebuild', () => {
    const entry = join(dir, 'graph-entry.ts');
    const dependency = join(dir, 'graph-dependency.ts');
    writeFileSync(dependency, 'export const retainedGraphValue = 42;\n');
    writeFileSync(entry, "import { retainedGraphValue } from './graph-dependency'; console.log(retainedGraphValue);\n");

    const accepted = runBundler(entry);
    expect(accepted.code, accepted.output).toBe(0);
    const bundle = readFileSync(outfile);
    const metadata = readFileSync(outfile + '.meta.json');
    const graph = JSON.parse(metadata.toString());
    // The real Bash -> Node gate -> census chain must share the retained
    // journal, including the last phase reached if preparation is killed.
    const steps = readFileSync(outfile + '.build-steps.jsonl', 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { step: string; event: string; status?: number; pid: number });
    for (const step of ['restricted-hold-inputs', 'restricted-hold-census', 'restricted-hold-live-census']) {
      expect(steps, step).toEqual(expect.arrayContaining([
        expect.objectContaining({ step, event: 'start', pid: expect.any(Number) }),
        expect.objectContaining({ step, event: 'end', status: 0, pid: expect.any(Number) }),
      ]));
    }
    // Gate and census run in separate Node children, rather than having the
    // parent shell synthesize rows after the child has already returned.
    expect(steps.find(row => row.step === 'restricted-hold-inputs')!.pid)
      .not.toBe(steps.find(row => row.step === 'restricted-hold-live-census')!.pid);
    // npm-install-safe executes the compiler from repoRoot, regardless of the shell's cwd.
    const inputPaths = Object.keys(graph.inputs).map(path => resolve(REPO_ROOT, path));
    expect(inputPaths, JSON.stringify({ inputs: graph.inputs, inputPaths, entry, dependency })).toContain(entry);
    expect(inputPaths).toContain(dependency);
    expect(readdirSync(join(dir, 'dist-host')).some(name => name.startsWith('.restricted-gate-meta.'))).toBe(false);

    writeFileSync(dependency, 'export const retainedGraphValue = ;\n');
    const rejected = runBundler(entry);
    expect(rejected.code, rejected.output).not.toBe(0);
    expect(readFileSync(outfile)).toEqual(bundle);
    expect(readFileSync(outfile + '.meta.json')).toEqual(metadata);
  }, 260_000);

  it('resolves compiler inputs from the repo root and restores bundle and metadata on a held import', () => {
    const entry = join(dir, 'held-import-entry.ts');
    const modulePath = join(REPO_ROOT, 'libs/generic/module-singleton/src/index.ts');
    const source = (value: number) => `import * as maintained from ${JSON.stringify(modulePath)}; console.log(maintained.pinModuleState, ${value});\n`;
    writeFileSync(entry, source(1));
    const accepted = runBundler(entry);
    expect(accepted.code, accepted.output).toBe(0);
    const bundle = readFileSync(outfile);
    const metadata = readFileSync(outfile + '.meta.json');
    const inputs = Object.keys(JSON.parse(metadata.toString()).inputs).map(path => resolve(REPO_ROOT, path));
    expect(inputs).toContain(modulePath);

    const census = join(dir, 'held-import-census.json');
    writeFileSync(census, JSON.stringify([{ path: modulePath, owner: 'fixture', intent: 'held-import regression', coordinationDomain: REPO_ROOT }]));
    writeFileSync(entry, source(2));
    const refused = runBundler(entry, { PAPERCUSP_RESTRICTED_HOLD_CENSUS_FILE: census });
    expect(refused.code, refused.output).not.toBe(0);
    expect(refused.output).toContain('held restricted write');
    expect(readFileSync(outfile)).toEqual(bundle);
    expect(readFileSync(outfile + '.meta.json')).toEqual(metadata);
  }, 260_000);

  it.each(['relative', 'absolute'] as const)('refuses a held copied SQL source using a %s directory', frame => {
    const entry = join(dir, 'clean-copy-entry.ts');
    writeFileSync(entry, 'export const clean = true;\n');
    mkdirSync(join(dir, 'dist-host'), { recursive: true });
    writeFileSync(outfile, GOOD_BUNDLE);
    const locksDir = join(REPO_ROOT, 'libs/papercusp/packages/locks/src/sql');
    const held = join(locksDir, '004-rename-coordination-domain.sql');
    const census = join(dir, 'held-copy-census.json');
    writeFileSync(census, JSON.stringify([{ path: held, owner: 'fixture',
      intent: 'held-copy regression', coordinationDomain: REPO_ROOT }]));
    const refused = runBundler(entry, { PAPERCUSP_RESTRICTED_HOLD_CENSUS_FILE: census,
      PAPERCUSP_LOCKS_SQL_DIR: frame === 'absolute' ? locksDir : '../../libs/papercusp/packages/locks/src/sql' });
    expect(refused.code, refused.output).not.toBe(0);
    expect(refused.output).toContain('004-rename-coordination-domain.sql is a bundle input and a held restricted write');
    expect(readFileSync(outfile, 'utf8')).toBe(GOOD_BUNDLE);
  }, 260_000);

  it('enters the install-safe mutex before resolving bundle dependencies', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    const guardIdx = src.indexOf('--exec-under-lock');
    const commonInputsIdx = src.indexOf('source "$SCRIPT_DIR/bundle-host-common.sh"');
    const esbuildIdx = src.indexOf('compiler-resolve bundle_host_prepare_esbuild');

    expect(guardIdx).toBeGreaterThan(-1);
    expect(src).toContain('installMutexIsHeld(installLockNameForRoot(process.argv[2]))');
    expect(src).toContain('"file://$REPO_ROOT/scripts/lib/install-lock-name.mjs" "$REPO_ROOT"');
    expect(guardIdx).toBeLessThan(commonInputsIdx);
    expect(guardIdx).toBeLessThan(esbuildIdx);
  });

  it(
    'RETAINS the previous bundle when the tree is momentarily broken, but fails loudly',
    () => {
      // A service that was serving fine a moment ago.
      execFileSync('mkdir', ['-p', join(dir, 'dist-host')], { timeout: 10_000, killSignal: 'SIGKILL' });
      writeFileSync(outfile, GOOD_BUNDLE);

      const { code, output } = runBundler(writeBrokenEntry());

      // THE POINT: ExecStartPre fails, so systemd/deploy cannot report stale
      // code as a successful release.
      expect(code).not.toBe(0);

      // The bundle that was already on disk is untouched — this is what the
      // pre-existing atomic swap (EI-9413) buys us: esbuild writes a tmp file
      // and we rename it in, so a FAILED build cannot corrupt the good one.
      expect(readFileSync(outfile, 'utf8')).toBe(GOOD_BUNDLE);

      // ...and it is impossible to miss. A SILENTLY stale service is worse than
      // a down one: an agent verifies a fix against pre-fix code and believes it.
      expect(output).toMatch(/FALLING BACK/);
      expect(output).toMatch(/STALE CODE/);

      expect(existsSync(marker)).toBe(true);
      const parsed = JSON.parse(readFileSync(marker, 'utf8'));
      expect(parsed.schema).toBe('bundle-stale-v1');
      // Names the file to go fix, so nobody reconstructs it from the journal.
      expect(parsed.failingFiles.join('\n')).toMatch(/broken-entry\.ts:\d+:\d+/);
      expect(parsed.error).toMatch(/ERROR/);
      expect(parsed.servingBundleMtime).toBeTruthy();
    },
    260_000,
  );

  // WI-10005321: bg-host bundled the live tree inside a peer's in-tree mutation-probe window
  // (2026-10-02) and ran with a tool-ceiling denial disabled for ~8 min. The probe restored the
  // file; nothing could restore the bundle. The gate must refuse, and the last-known-good stays.
  it(
    'REFUSES to bundle while a mutation probe holds a file in the tree mutated, keeping the last-known-good bundle',
    () => {
      execFileSync('mkdir', ['-p', join(dir, 'dist-host')], { timeout: 10_000, killSignal: 'SIGKILL' });
      writeFileSync(outfile, GOOD_BUNDLE);
      const entry = join(dir, 'good-entry.ts');
      writeFileSync(entry, 'export const ok = 1;\n');
      const admission = mutationProbeAdmissionDir(REPO_ROOT, { tmpDir: dir });
      mkdirSync(admission, { recursive: true });
      const manifest = join(admission, 'original.manifest');
      const fields = [REPO_ROOT, join(REPO_ROOT, 'probed.ts'), join(dir, 'probed.orig'), String(process.pid)];
      writeFileSync(manifest, fields.map((f) => `${f}\0`).join(''), 'latin1');

      const { code, output } = runBundler(entry, { PAPERCUSP_BUNDLE_PROBE_WAIT_SEC: '0' });

      expect(code).not.toBe(0);
      expect(output).toMatch(/BUILD_MUTATION_PROBE_WINDOW state=active subject=probed\.ts/);
      expect(output).toMatch(/FALLING BACK/);
      expect(readFileSync(outfile, 'utf8')).toBe(GOOD_BUNDLE);

      // Calibration: the same valid entry replaces the bundle once the window closes, so the
      // refusal above came from the window and not from the entry.
      rmSync(manifest);
      const clean = runBundler(entry, { PAPERCUSP_BUNDLE_PROBE_WAIT_SEC: '0' });
      expect(clean.output).not.toMatch(/BUILD_MUTATION_PROBE_WINDOW/);
      expect(readFileSync(outfile, 'utf8')).not.toBe(GOOD_BUNDLE);
    },
    260_000,
  );

  it(
    'still REFUSES to start when there is no previous bundle to fall back to',
    () => {
      // Nothing to serve: exec'ing a missing entrypoint would crash-loop anyway,
      // and a fallback is only correct when something exists to fall back to.
      const { code, output } = runBundler(writeBrokenEntry());

      expect(code).not.toBe(0);
      expect(output).toMatch(/NO previous bundle/);
      expect(existsSync(outfile)).toBe(false);
      // Calibration for the WI-10005113 case below: a real build error is
      // reported with its own status and log, never as an external kill.
      expect(output).toMatch(/bundle step exit status: 1/);
      expect(output).not.toMatch(/KILLED by signal/);
      expect(output).not.toMatch(/build log is EMPTY/);
    },
    260_000,
  );

  // WI-10005113: measured 2026-10-01 22:03:10-22:03:20Z, the first staging
  // generation bundle died 10s in with an EMPTY build log. The old
  // `if ! ( … ); then bundle_rc=1` discarded the subshell's real status, so a
  // kill read exactly like a build error and the cause was unrecoverable once
  // the candidate checkout was pruned. A compiler shim SIGKILLs its cache-helper
  // parent; preserve that signal through the compiler function and subshell.
  it(
    'reports an EXTERNAL kill during compilation as a signal with retained diagnostics',
    () => {
      const entry = join(dir, 'ok-entry.ts');
      writeFileSync(entry, 'export const ok = 1;\nconsole.log(ok);\n');
      const shimDir = join(dir, 'shim');
      const path = compilerShim(shimDir, [
          'for a in "$@"; do',
          '  if [[ "$a" == "$BUNDLE_TEST_KILL_ENTRY" ]]; then kill -9 "$PPID"; sleep 1; exit 0; fi',
          'done',
      ]);

      const { code, output } = runBundler(entry, {
        PATH: path,
        BUNDLE_TEST_KILL_ENTRY: entry,
      });

      expect(code).not.toBe(0);
      expect(output).toMatch(/KILLED by signal 9 \(SIGKILL, exit status 137\)/);
      expect(output).toContain('NPM_INSTALL_SAFE guarding package-cache reader');
      expect(output).not.toMatch(/build log is EMPTY/);
      expect(output).toMatch(/NO previous bundle/);
      expect(existsSync(outfile)).toBe(false);
    },
    260_000,
  );

  // ── EI-19457229906581679: the SUPERVISOR caller ──────────────────────────
  // A systemd ExecStartPre asks "may the unit start?", not "did the requested
  // code build?". The two tests above pin the RELEASE answer (the default, and
  // unchanged). These pin the supervisor answer, which the same exit code had
  // been silently denying: measured 2026-08-27, a bundle failed at 10:47:11Z
  // with a good bundle on disk and :3170 still died into its start-limit.
  it(
    'lets a SUPERVISOR boot on the last-known-good bundle when it opts in',
    () => {
      execFileSync('mkdir', ['-p', join(dir, 'dist-host')], { timeout: 10_000, killSignal: 'SIGKILL' });
      writeFileSync(outfile, GOOD_BUNDLE);

      const { code, output } = runBundler(writeBrokenEntry(), {
        PAPERCUSP_BUNDLE_ALLOW_STALE_START: '1',
      });

      // THE POINT: the unit starts instead of crash-looping every RestartSec=5.
      expect(code).toBe(0);

      // Availability is bought WITHOUT giving up any of the loudness. Silence
      // here would be the worse failure: an agent verifying a fix against
      // pre-fix code and believing it.
      expect(readFileSync(outfile, 'utf8')).toBe(GOOD_BUNDLE);
      expect(output).toMatch(/FALLING BACK/);
      expect(output).toMatch(/STALE CODE/);
      expect(existsSync(marker)).toBe(true);
    },
    260_000,
  );

  it(
    'REFUSES to start even for an opted-in supervisor when no bundle exists',
    () => {
      // The opt-in trades freshness for availability; it must never license
      // exec'ing an entrypoint that is not there. This is exactly why the fix
      // is an env var and not `ExecStartPre=-` in the drop-in: the `-` prefix
      // ignores ALL failures, so this branch would proceed to a MODULE_NOT_FOUND
      // crash-loop instead of refusing cleanly with a diagnosis.
      const { code, output } = runBundler(writeBrokenEntry(), {
        PAPERCUSP_BUNDLE_ALLOW_STALE_START: '1',
      });

      expect(code).not.toBe(0);
      expect(output).toMatch(/NO previous bundle/);
      expect(existsSync(outfile)).toBe(false);
    },
    260_000,
  );

  // ── WI-10005087: a RUNTIME WORKER failure, after the entry built ───────────
  // Measured 2026-10-01 21:01-21:10Z: the entry bundled, esbuild then failed on
  // snapshot-fold.worker.ts, and the worker step's bare `|| exit 1` kept bg-host
  // down ~9 min although its drop-in opts in and a good worker sat on disk.
  // The failure is injected through the embed worker's source override (a path
  // that does not exist), so no file in the shared tree is touched.
  // DERIVED from the script's own HOST_WORKER_OUTPUTS, never restated here: a
  // hand-kept copy went stale the moment mutation-probe-closure.worker.mjs was
  // added (2033cf9106), and every worker case then failed on a fixture that no
  // longer staged all previous outputs (WI-10005113 found it 2026-10-01 22:27Z).
  const WORKER_OUTPUTS = (() => {
    const common = readFileSync(join(REPO_ROOT, 'apps/operator/bin/bundle-host-common.sh'), 'utf8');
    const body = /^HOST_WORKER_OUTPUTS=\(\n([\s\S]*?)\n\)/m.exec(common)?.[1] ?? '';
    return body
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter((line) => line.length > 0);
  })();
  const GOOD_WORKER = 'export const lastKnownGoodWorker = true;\n';

  it('derives the worker list from bundle-host-common.sh (positive control)', () => {
    // An unparseable array must fail HERE, not vacuously pass the cases below.
    expect(WORKER_OUTPUTS.length).toBeGreaterThanOrEqual(5);
    expect(WORKER_OUTPUTS).toContain('snapshot-fold.worker.mjs');
    expect(WORKER_OUTPUTS).toContain('event-loop-sentinel.worker.mjs');
    expect(WORKER_OUTPUTS.every((w) => /^[\w.-]+\.mjs$/.test(w))).toBe(true);
  });

  function stageWorkerFailure(previousOutputs: string[]): { entry: string; env: Record<string, string> } {
    execFileSync('mkdir', ['-p', join(dir, 'dist-host')], { timeout: 10_000, killSignal: 'SIGKILL' });
    for (const output of previousOutputs) writeFileSync(join(dir, 'dist-host', output), GOOD_WORKER);
    const entry = join(dir, 'fine-entry.ts');
    writeFileSync(entry, 'export const ok = 1;\nconsole.log(ok);\n');
    return { entry, env: { PAPERCUSP_EMBED_WORKER_SCRIPT: join(dir, 'missing-embed-worker.script.mjs') } };
  }

  it(
    'lets a SUPERVISOR boot on last-known-good WORKERS when a worker fails to build',
    () => {
      const { entry, env } = stageWorkerFailure(WORKER_OUTPUTS);

      const { code, output } = runBundler(entry, { ...env, PAPERCUSP_BUNDLE_ALLOW_STALE_START: '1' });

      // THE POINT: the unit starts instead of crash-looping on a worker edit.
      expect(code, output).toBe(0);
      for (const worker of WORKER_OUTPUTS) {
        expect(readFileSync(join(dir, 'dist-host', worker), 'utf8')).toBe(GOOD_WORKER);
      }
      // ...and the mixed dist-host (fresh entry, older worker) is loud, not silent.
      expect(output).toMatch(/FALLING BACK/);
      expect(output).toMatch(/STALE CODE/);
      expect(existsSync(marker)).toBe(true);
      const parsed = JSON.parse(readFileSync(marker, 'utf8'));
      expect(parsed.schema).toBe('bundle-stale-v1');
      expect(parsed.entry).toBe(env.PAPERCUSP_EMBED_WORKER_SCRIPT);
      expect(parsed.outfile).toMatch(/local-embedder-worker\.script\.mjs$/);
      expect(parsed.servingBundleMtime).toBeTruthy();
      expect(parsed.error).toMatch(/missing runtime worker/);
    },
    260_000,
  );

  it(
    'FAILS a release caller on a worker failure, still marking dist-host stale',
    () => {
      const { entry, env } = stageWorkerFailure(WORKER_OUTPUTS);

      const { code, output } = runBundler(entry, env);

      expect(code).not.toBe(0);
      expect(output).toMatch(/CALLER FAILS/);
      // The fresh entry was published before the worker step, so dist-host is a
      // mix whatever the caller decides — the marker records that fact.
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(join(dir, 'dist-host', WORKER_OUTPUTS[4]), 'utf8')).toBe(GOOD_WORKER);
    },
    260_000,
  );

  it(
    'REFUSES an opted-in supervisor when a worker has no previous output',
    () => {
      // snapshot-fold.worker.mjs is absent: spawning a missing worker would fail
      // at runtime, so the opt-in must not license it.
      const { entry, env } = stageWorkerFailure(WORKER_OUTPUTS.slice(0, 4));

      const { code, output } = runBundler(entry, { ...env, PAPERCUSP_BUNDLE_ALLOW_STALE_START: '1' });

      expect(code).not.toBe(0);
      expect(output).toMatch(/NO previous/);
      expect(output).toMatch(/snapshot-fold\.worker\.mjs/);
    },
    260_000,
  );

  it(
    'CLEARS the marker once the tree builds again',
    () => {
      // Without this the marker would latch: /api/health would keep reporting a
      // long-fixed staleness, which trains readers to ignore it — the failure
      // mode that makes a warning worse than no warning at all.
      execFileSync('mkdir', ['-p', join(dir, 'dist-host')], { timeout: 10_000, killSignal: 'SIGKILL' });
      writeFileSync(outfile, GOOD_BUNDLE);
      writeFileSync(marker, JSON.stringify({ schema: 'bundle-stale-v1', outfile }));

      const entry = join(dir, 'fine-entry.ts');
      writeFileSync(entry, 'export const ok = 1;\nconsole.log(ok);\n');

      const { code, output } = runBundler(entry);

      expect(code).toBe(0);
      expect(output).toMatch(/✓ bundled/);
      expect(existsSync(marker)).toBe(false);
      // The good bundle was genuinely replaced, not merely left alone.
      expect(readFileSync(outfile, 'utf8')).not.toBe(GOOD_BUNDLE);
      // Generated output carries the marker consumed by content-lint's
      // generated-file exemption; future banner changes must preserve it.
      // The banner is ASCII-only ON PURPOSE (a plain hyphen, not an em dash):
      // bundle-host.sh runs ascii-escape-bundle.mjs over the finished bundle
      // (WI-38221 widen-avoidance), which rewrites every non-ASCII char as a
      // \uXXXX escape — a non-ASCII banner therefore (a) guaranteed the pass had
      // ≥1 hit on EVERY bundle and (b) came out as `—` on disk, which is
      // what this assertion caught red on the frozen candidate (WI-2141194 #6b).
      expect(readFileSync(outfile, 'utf8')).toMatch(
        /^\/\* @generated by apps\/operator\/bin\/bundle-host\.sh - do not edit \*\//,
      );
    },
    260_000,
  );
});
