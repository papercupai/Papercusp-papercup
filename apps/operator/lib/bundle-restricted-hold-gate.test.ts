/**
 * WI-10005745 — the host bundle's restricted-hold gate (D-012 residue of WI-10005724).
 *
 * bg-host's ExecStartPre (bin/bundle-host.sh) bundles the LIVE shared tree and runs it with the
 * network. The gate (bin/bundle-restricted-hold-gate.mjs) snapshots the last-known-good artifacts
 * before the build and restores them unless ONE census over the build's exact inputs admits.
 * The census itself is restricted-hold-fence.ts (`restrictedHoldBundleRefusal`, unit-tested in
 * operator-core and driven from real Postgres in restricted-hold-fence.integration.test.ts); here
 * it is injected so every gate verdict path is exercised without a database.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUNDLE_PREFLIGHT_SKIP_REASONS,
  RESTRICTED_HOLD_PREFLIGHT_EXIT,
  RESTRICTED_HOLD_PREFLIGHT_MARKER,
  interpretRestrictedHoldPreflight,
  runBundleRestrictedHoldPreflight,
} from '../../../scripts/lib/restricted-hold-preflight.mjs';
import {
  GATE_EXIT,
  collectBundleInputs,
  restoreArtifacts,
  runGate,
  snapshotArtifacts,
  type GatePreflight,
} from '../bin/bundle-restricted-hold-gate.mjs';

let work: string;
let outdir: string;
let snapshotDir: string;
let baseDir: string;

function put(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

/** What the build does to an artifact: write a tmp file, then rename it over the old one. */
function publish(name: string, text: string): void {
  put(join(outdir, `${name}.tmp`), text);
  renameSync(join(outdir, `${name}.tmp`), join(outdir, name));
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'bundle-gate-'));
  outdir = join(work, 'dist-host');
  snapshotDir = join(outdir, '.restricted-lkg.test');
  baseDir = join(work, 'apps', 'operator');
  put(join(outdir, 'hono-host.mjs'), 'old host');
  put(join(outdir, 'blueprints', 'base', 'blueprint.yaml'), 'old blueprint');
  put(join(baseDir, 'bin', 'hono-host.ts'), 'entry');
  put(join(work, 'packages', 'core', 'lib', 'used.ts'), 'used');
  put(join(work, 'libs', 'blueprints', 'base', 'blueprint.yaml'), 'source blueprint');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(work, { recursive: true, force: true });
});

function rebuild(): void {
  publish('hono-host.mjs', 'new host');
  rmSync(join(outdir, 'blueprints'), { recursive: true });
  put(join(outdir, 'blueprints', 'base', 'blueprint.yaml'), 'new blueprint');
  put(join(outdir, 'sql', '001.sql'), 'created by this build');
}

function writeMetafile(name: string, inputs: string[]): string {
  const path = join(work, 'meta', name);
  put(path, JSON.stringify({ inputs: Object.fromEntries(inputs.map((key) => [key, { bytes: 1, imports: [] }])) }));
  return path;
}

describe('snapshot + restore', () => {
  it('restores replaced files and dirs and removes artifacts the build created', () => {
    const entries = snapshotArtifacts({ outdir, snapshotDir, artifacts: ['hono-host.mjs', 'blueprints', 'sql'] });
    expect(entries).toEqual([
      { name: 'hono-host.mjs', existed: true },
      { name: 'blueprints', existed: true },
      { name: 'sql', existed: false },
    ]);
    rebuild();
    expect(readFileSync(join(outdir, 'hono-host.mjs'), 'utf8')).toBe('new host');

    restoreArtifacts({ outdir, snapshotDir });
    expect(readFileSync(join(outdir, 'hono-host.mjs'), 'utf8')).toBe('old host');
    expect(readFileSync(join(outdir, 'blueprints', 'base', 'blueprint.yaml'), 'utf8')).toBe('old blueprint');
    expect(existsSync(join(outdir, 'sql'))).toBe(false);
  });
});

describe('collectBundleInputs', () => {
  it('resolves metafile inputs against esbuild cwd and drops virtual / disabled / namespaced keys', () => {
    const main = writeMetafile('hono-host.mjs.meta.json', [
      'bin/hono-host.ts',
      '../../packages/core/lib/used.ts',
      '<define:process.env.X>',
      '(disabled):fs',
      'ns:virtual-module',
    ]);
    const inputs = collectBundleInputs({ baseDir, metafiles: [main] });
    expect(inputs.files).toEqual([join(work, 'apps/operator/bin/hono-host.ts'), join(work, 'packages/core/lib/used.ts')].sort());
    expect(inputs.dirs).toEqual([]);
  });

  it('adds every *.meta.json of a metafile dir, list-file entries, and classifies paths as files or dirs', () => {
    writeMetafile('worker.mjs.meta.json', ['../../packages/core/lib/used.ts']);
    put(join(work, 'meta', 'copied-sources.txt'), `${join(work, 'packages/core/lib/copied.mjs')}\n\n`);
    put(join(work, 'meta', 'notes.json'), JSON.stringify({ inputs: { 'never-read.ts': {} } }));
    const inputs = collectBundleInputs({
      baseDir,
      metafileDirs: [join(work, 'meta'), join(work, 'absent-dir')],
      listFiles: [join(work, 'meta', 'copied-sources.txt')],
      paths: ['../../libs/blueprints', '../../packages/core/lib/runner.mjs'],
    });
    expect(inputs.files).toEqual(
      [
        join(work, 'packages/core/lib/used.ts'),
        join(work, 'packages/core/lib/copied.mjs'),
        join(work, 'packages/core/lib/runner.mjs'),
      ].sort(),
    );
    expect(inputs.dirs).toEqual([join(work, 'libs/blueprints')]);
  });

  it('throws on a named metafile that does not exist (its artifact has unknown inputs)', () => {
    expect(() => collectBundleInputs({ baseDir, metafiles: [join(work, 'meta', 'missing.meta.json')] })).toThrow(/ENOENT/);
  });
});

describe('runGate', () => {
  function gate(preflight: GatePreflight, metafiles: string[]) {
    const lines: string[] = [];
    const code = runGate({ root: work, baseDir, outdir, snapshotDir, metafiles, preflight, log: (line) => lines.push(line) });
    return { code, lines };
  }

  it('retains input collection and census timeout evidence outside redirected process output', () => {
    snapshotArtifacts({ outdir, snapshotDir, artifacts: ['hono-host.mjs'] });
    rebuild();
    const journal = join(work, 'steps.jsonl');
    vi.stubEnv('BUNDLE_HOST_STEP_LOG', journal);
    const main = writeMetafile('hono-host.mjs.meta.json', ['bin/hono-host.ts']);
    let inputsFile: string | undefined;
    const { code } = gate(opts => {
      inputsFile = opts.inputsFile;
      return runBundleRestrictedHoldPreflight({ ...opts,
        spawn: (() => ({ status: null, signal: 'SIGKILL', error: new Error('ETIMEDOUT'),
          pid: 0, output: [], stdout: '', stderr: '' })) as unknown as typeof spawnSync,
      });
    }, [main]);
    expect(code).toBe(GATE_EXIT.refuse);
    expect(readFileSync(join(outdir, 'hono-host.mjs'), 'utf8')).toBe('old host');
    expect(existsSync(snapshotDir)).toBe(false);
    expect(inputsFile).toBe(join(outdir, 'bundle-restricted-hold-inputs.json'));
    expect(JSON.parse(readFileSync(inputsFile!, 'utf8'))).toEqual({
      files: [join(baseDir, 'bin/hono-host.ts')], dirs: [],
    });
    expect(statSync(inputsFile!).mode & 0o777).toBe(0o600);
    const records = readFileSync(journal, 'utf8').trim().split('\n').map(row => JSON.parse(row));
    expect(records.map(({ step, event, status }) => ({ step, event, status }))).toEqual([
      { step: 'restricted-hold-inputs', event: 'start', status: undefined },
      { step: 'restricted-hold-inputs', event: 'end', status: 0 },
      { step: 'restricted-hold-census', event: 'start', status: undefined },
      { step: 'restricted-hold-census', event: 'end', status: 3 },
    ]);
    expect(records.at(-1).error).toContain('ETIMEDOUT');
    expect(records.every(row => typeof row.at === 'number' && typeof row.pid === 'number')).toBe(true);
  });

  it('restores the last-known-good bundle when the retained journal cannot be written', () => {
    snapshotArtifacts({ outdir, snapshotDir, artifacts: ['hono-host.mjs'] });
    rebuild();
    vi.stubEnv('BUNDLE_HOST_STEP_LOG', work); // a directory cannot be appended to
    const preflight = vi.fn(() => ({ verdict: 'admit' as const }));
    const { code, lines } = gate(preflight, []);
    expect(code).toBe(GATE_EXIT.refuse);
    expect(preflight).not.toHaveBeenCalled();
    expect(readFileSync(join(outdir, 'hono-host.mjs'), 'utf8')).toBe('old host');
    expect(lines.join('\n')).toContain('EISDIR');
  });

  it('admits: keeps the fresh bundle, discards the snapshot, and hands the census the exact inputs', () => {
    snapshotArtifacts({ outdir, snapshotDir, artifacts: ['hono-host.mjs', 'blueprints', 'sql'] });
    rebuild();
    const main = writeMetafile('hono-host.mjs.meta.json', ['bin/hono-host.ts', '../../packages/core/lib/used.ts']);
    let seen: unknown;
    const { code, lines } = gate(({ repoRoot, inputsFile }) => {
      expect(repoRoot).toBe(work);
      seen = JSON.parse(readFileSync(inputsFile, 'utf8'));
      return { verdict: 'admit' };
    }, [main]);
    expect(code).toBe(GATE_EXIT.admit);
    expect(seen).toEqual({ files: [join(work, 'apps/operator/bin/hono-host.ts'), join(work, 'packages/core/lib/used.ts')].sort(), dirs: [] });
    expect(readFileSync(join(outdir, 'hono-host.mjs'), 'utf8')).toBe('new host');
    expect(existsSync(snapshotDir)).toBe(false);
    expect(lines.join('\n')).toMatch(/2 bundle inputs checked/);
  });

  it('refuses: restores every last-known-good artifact and prints the greppable refusal line', () => {
    snapshotArtifacts({ outdir, snapshotDir, artifacts: ['hono-host.mjs', 'blueprints', 'sql'] });
    rebuild();
    const main = writeMetafile('hono-host.mjs.meta.json', ['../../packages/core/lib/used.ts']);
    const { code, lines } = gate(
      () => ({ verdict: 'refuse', error: 'restricted_write_held', hint: 'packages/core/lib/used.ts is a bundle input and a held restricted write' }),
      [main],
    );
    expect(code).toBe(GATE_EXIT.refuse);
    expect(readFileSync(join(outdir, 'hono-host.mjs'), 'utf8')).toBe('old host');
    expect(readFileSync(join(outdir, 'blueprints', 'base', 'blueprint.yaml'), 'utf8')).toBe('old blueprint');
    expect(existsSync(join(outdir, 'sql'))).toBe(false);
    expect(existsSync(snapshotDir)).toBe(false);
    expect(lines[0]).toMatch(/^BUNDLE_RESTRICTED_HOLD_REFUSED error=restricted_write_held published=last-known-good /);
  });

  it('fails closed: inputs it cannot establish restore the snapshot without consulting the census', () => {
    snapshotArtifacts({ outdir, snapshotDir, artifacts: ['hono-host.mjs'] });
    publish('hono-host.mjs', 'new host');
    let consulted = false;
    const { code, lines } = gate(() => {
      consulted = true;
      return { verdict: 'admit' };
    }, [join(work, 'meta', 'missing.meta.json')]);
    expect(code).toBe(GATE_EXIT.refuse);
    expect(consulted).toBe(false);
    expect(readFileSync(join(outdir, 'hono-host.mjs'), 'utf8')).toBe('old host');
    expect(lines[0]).toMatch(/error=restricted_hold_state_unknown/);
  });

  it('removes a previous input receipt when the next build cannot establish its own inputs', () => {
    const inputsFile = join(outdir, 'bundle-restricted-hold-inputs.json');
    put(inputsFile, JSON.stringify({ files: ['stale-source.ts'], dirs: [] }));
    snapshotArtifacts({ outdir, snapshotDir, artifacts: ['hono-host.mjs'] });
    publish('hono-host.mjs', 'new host');
    const preflight = vi.fn(() => ({ verdict: 'admit' as const }));
    expect(gate(preflight, [join(work, 'missing.meta.json')]).code).toBe(GATE_EXIT.refuse);
    expect(preflight).not.toHaveBeenCalled();
    expect(existsSync(inputsFile)).toBe(false);
    expect(readFileSync(join(outdir, 'hono-host.mjs'), 'utf8')).toBe('old host');
  });
});

describe('bundle-host.sh wiring', () => {
  const script = readFileSync(fileURLToPath(new URL('../bin/bundle-host.sh', import.meta.url)), 'utf8');
  const common = readFileSync(fileURLToPath(new URL('../bin/bundle-host-common.sh', import.meta.url)), 'utf8');
  const at = (needle: string, last = false): number => {
    const index = last ? script.lastIndexOf(needle) : script.indexOf(needle);
    expect(index, `bundle-host.sh lost ${needle}`).toBeGreaterThan(-1);
    return index;
  };

  it('snapshots before esbuild, gates after the last publish and before the freshness stamp', () => {
    const order = [
      at('"$GATE_HELPER" snapshot'),
      at('bundle_host_run_step host-compile bundle_host_esbuild "$REPO_ROOT" "$ENTRY"'),
      at('cp -f "$METAFILE" "$BUNDLE_HOST_GATE_META_DIR/${OUTFILE##*/}.meta.json"'),
      at('mv -f "$TMPFILE" "$OUTFILE"'),
      at('GATE_PENDING=1'),
      at('bundle_host_workers "$REPO_ROOT"'),
      at('bundle_host_spawner "$REPO_ROOT"'),
      // The LAST occurrence is the normal-path gate; the first is inside the EXIT trap handler.
      at('if [[ "$GATE_PENDING" == "1" ]] && ! restricted_hold_gate; then', true),
      at('"$FRESHNESS_HELPER" stamp'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('gates every later exit from the EXIT trap, including the worker/spawner stale-start exits', () => {
    expect(script).toMatch(/^trap bundle_host_on_exit EXIT$/m);
    const onExit = script.slice(at('bundle_host_on_exit() {'), at('trap bundle_host_on_exit EXIT'));
    expect(onExit).toContain('if [[ "$GATE_PENDING" == "1" ]] && ! restricted_hold_gate; then');
    expect(onExit).toContain('rm -rf "$GATE_SNAPSHOT_DIR" "$BUNDLE_HOST_GATE_META_DIR"');
    // The stale-start exits sit AFTER the gate was armed, so the trap is what gates them.
    expect(at('GATE_PENDING=1')).toBeLessThan(script.lastIndexOf('availability over freshness'));
  });

  it('snapshots every artifact the build replaces', () => {
    const snapshotLoop = script.slice(at('for gate_artifact in'), at('mkdir -p "$BUNDLE_HOST_GATE_META_DIR"'));
    for (const artifact of ['"${OUTFILE##*/}"', 'spawner-sidecar.mjs', '"${HOST_WORKER_OUTPUTS[@]}"', '"${HOST_RUNTIME_SIBLING_OUTPUTS[@]}"', 'blueprints', 'sql']) {
      expect(snapshotLoop).toContain(artifact);
    }
  });

  it('records worker inputs only when bundle-host.sh asks (the packaged sidecar build is unchanged)', () => {
    expect(common).toContain('meta_args=(--metafile="$BUNDLE_HOST_GATE_META_DIR/$output.meta.json")');
    expect(common).toContain('"${meta_args[@]}"; then');
    expect(common).toContain('>> "$BUNDLE_HOST_GATE_META_DIR/copied-sources.txt"');
  });

  /**
   * WI-10005802: everything bundle-host.sh runs in node BEFORE the gate judges the build (and the
   * gate itself) comes from the live shared tree, so each starts under the committed-source loader
   * and runs its committed (HEAD) bytes. A plain `node "<helper>"` would run a held write unjudged.
   * `node --input-type=module --check < file` only parses stdin, so it is the one allowed form.
   */
  it('starts every node helper under the committed-source loader (WI-10005802)', () => {
    expect(script).toContain('COMMITTED_NODE=(node --import "$REPO_ROOT/scripts/lib/committed-source-loader.mjs")');
    const plainNode = (text: string) =>
      text
        .split('\n')
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        .filter(({ line }) => !line.startsWith('#') && /(^|[\s!(;]|\$\()node\s+"/.test(line));
    // The ONE exemption (EI-27162307954577154): the caller-owned BG transaction branch
    // (bg-host-committed-generation-2026-10-24) binds its attempt BEFORE any loader. Its only
    // helper, source-preview.mjs bg-build-*, refuses ambient Node resolution (the recorded
    // NODE_OPTIONS must be empty, which this loader would break) and requires the builder and
    // repository to be the selected generation's own (prepared.root), never the live shared tree,
    // so its bytes are already the committed generation's. Pin the branch so the exemption cannot
    // widen: it must refuse NODE_OPTIONS/NODE_PATH, exit on every path, run only bg-build-*, and
    // sit before the loader is configured.
    const lines = script.split('\n');
    const bgStart = lines.indexOf('if [[ "${1:-}" == --bg-transaction ]]; then');
    expect(bgStart, 'bundle-host.sh lost its --bg-transaction branch').toBeGreaterThan(-1);
    const bgEnd = lines.indexOf('fi', bgStart);
    expect(bgEnd).toBeGreaterThan(bgStart);
    const bgBlock = lines.slice(bgStart, bgEnd + 1).join('\n');
    const outsideBg = [...lines.slice(0, bgStart), ...lines.slice(bgEnd + 1)].join('\n');
    expect(bgEnd, 'the BG branch must run before the committed-source loader is configured')
      .toBeLessThan(lines.findIndex((line) => line.startsWith('COMMITTED_NODE=(')));
    expect(bgBlock).toContain('if [[ -n "${NODE_OPTIONS:-}" || -n "${NODE_PATH:-}" ]]; then');
    expect(lines.slice(bgStart, bgEnd).filter((line) => line.trim()).at(-1)?.trim(),
      'every path through the BG branch must exit before the build continues').toBe('exit 0');
    const bgNode = plainNode(bgBlock);
    expect(bgNode.length, 'the BG branch must keep exactly its two source-preview steps').toBe(2);
    for (const { line } of bgNode) {
      expect(line, 'the BG branch may run only source-preview bg-build-*')
        .toMatch(/node "\$REPO_ROOT\/scripts\/source-preview\.mjs" bg-build-(begin|run) \\$/);
    }
    expect(plainNode(outsideBg), 'bundle-host.sh runs a helper with plain node').toEqual([]);
    expect(plainNode(common), 'bundle-host-common.sh runs a helper with plain node').toEqual([]);
    for (const helper of [
      '"$REPO_ROOT/scripts/npm-install-safe.mjs"',
      '"$FRESHNESS_HELPER" check',
      '"$GATE_HELPER" snapshot',
      '"$GATE_HELPER" "${args[@]}"',
      '"$HELPER_DIR/write-bundle-stale-marker.mjs"',
      '"$REPO_ROOT/scripts/mutation-probe-window-gate.mjs" wait',
      '"$REPO_ROOT/scripts/check-bundled-cli-entry-guards.mjs"',
      '"$HELPER_DIR/ascii-escape-bundle.mjs"',
      '"$FRESHNESS_HELPER" stamp',
    ]) {
      expect(script, `bundle-host.sh lost the loader on ${helper}`).toContain(`"\${COMMITTED_NODE[@]}" ${helper}`);
    }
    // WI-10006398: systemd runs bundle-host.sh from a temp-dir snapshot, where SCRIPT_DIR is that
    // temp dir. Node helpers import through node_modules and ../../../scripts, which resolve only
    // from the checkout, so they must come from HELPER_DIR ($OPERATOR_DIR/bin), never SCRIPT_DIR.
    expect(script).toContain('HELPER_DIR="$OPERATOR_DIR/bin"');
    for (const name of ['FRESHNESS_HELPER', 'GATE_HELPER']) {
      expect(script).toMatch(new RegExp(`^${name}="\\$HELPER_DIR/`, 'm'));
    }
    const snapshotRelativeHelpers = script
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#') && /\$SCRIPT_DIR\/[\w.-]+\.m?js\b/.test(line));
    expect(snapshotRelativeHelpers, 'a node helper is resolved beside the (snapshot) script').toEqual([]);
  });

  it("bundle-host-common.sh's helpers use bundle-host.sh's loader, and plain node for other callers", () => {
    const declaration = common.split('\n').find((line) => line.includes('local -a run_node='));
    expect(declaration, 'bundle-host-common.sh lost its run_node declaration').toBeDefined();
    // Run the exact declaration in bash: with COMMITTED_NODE unset (release packaging) and set.
    const probe = `f() { ${declaration!.trim()}; printf '%s|' "\${run_node[@]}"; echo; }; f; COMMITTED_NODE=(node --import /x/loader.mjs); f`;
    const result = spawnSync('bash', ['-c', probe], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['node|', 'node|--import|/x/loader.mjs|']);
    expect(common).toContain('"${run_node[@]}" "$repo_root/scripts/check-bundled-cli-entry-guards.mjs"');
  });
});

/**
 * WI-10005770: bundle-host.sh runs from apps/operator, so with the default OUTFILE
 * (dist-host/hono-host.mjs) the gate's snapshot dir is RELATIVE to that cwd, while the census
 * child runs with cwd = repo root. The injected-preflight tests above never cross that spawn
 * boundary, which is how a relative inputs path refused every default build (ENOENT) unnoticed.
 */
describe('runGate through the real census spawn boundary (WI-10005770)', () => {
  type ChildResult = { status: number; stdout: string; stderr: string; signal: null };
  /** Stands in for restricted-hold-preflight-cli.ts: it opens --bundle-inputs from ITS OWN cwd. */
  function childCensus(seen: { cwd?: string; inputsArg?: string }) {
    return (_cmd: string, args: readonly string[], opts: { cwd?: string }): ChildResult => {
      const inputsArg = args[args.indexOf('--bundle-inputs') + 1];
      seen.cwd = opts.cwd;
      seen.inputsArg = inputsArg;
      try {
        readFileSync(resolve(opts.cwd ?? '.', inputsArg), 'utf8');
      } catch (error) {
        return { status: 1, stdout: '', stderr: `restricted-hold preflight crashed (${(error as Error).message})`, signal: null };
      }
      const verdict = `${RESTRICTED_HOLD_PREFLIGHT_MARKER} ${JSON.stringify({ verdict: 'admit' })}\n`;
      return { status: RESTRICTED_HOLD_PREFLIGHT_EXIT.admit, stdout: verdict, stderr: '', signal: null };
    };
  }

  it('admits a build whose snapshot dir is relative to the caller while the census child runs at the repo root', () => {
    // A repo root deeper than any test cwd, so `..` segments cannot clamp at `/` and land on
    // the right file by accident: from here the caller-relative path must NOT resolve.
    const repoRoot = join(work, ...Array.from({ length: 40 }, () => 'r'));
    mkdirSync(repoRoot, { recursive: true });
    const relativeSnapshot = relative(process.cwd(), snapshotDir);
    expect(isAbsolute(relativeSnapshot)).toBe(false);
    expect(resolve(repoRoot, relativeSnapshot)).not.toBe(resolve(relativeSnapshot));

    snapshotArtifacts({ outdir, snapshotDir: relativeSnapshot, artifacts: ['hono-host.mjs', 'blueprints', 'sql'] });
    rebuild();
    const main = writeMetafile('hono-host.mjs.meta.json', ['bin/hono-host.ts']);

    // Control: the stand-in child really is cwd-sensitive, so the admit below is earned by the
    // fix (the path is absolutized before the cwd changes), not by a lenient fake.
    const control = interpretRestrictedHoldPreflight(
      childCensus({})('node', ['--bundle-inputs', relative(process.cwd(), main)], { cwd: repoRoot }),
    );
    expect(control).toMatchObject({ verdict: 'refuse', error: 'restricted_hold_state_unknown' });

    const seen: { cwd?: string; inputsArg?: string } = {};
    const lines: string[] = [];
    const code = runGate({
      root: repoRoot,
      baseDir,
      outdir,
      snapshotDir: relativeSnapshot,
      metafiles: [main],
      preflight: ({ repoRoot: root, inputsFile }) =>
        runBundleRestrictedHoldPreflight({ repoRoot: root, inputsFile, env: {}, spawn: childCensus(seen) as never }),
      log: (line) => lines.push(line),
    });
    expect(seen.cwd).toBe(repoRoot);
    expect(isAbsolute(seen.inputsArg ?? '')).toBe(true);
    expect(lines.join('\n')).not.toMatch(/BUNDLE_RESTRICTED_HOLD_REFUSED/);
    expect(code).toBe(GATE_EXIT.admit);
    expect(readFileSync(join(outdir, 'hono-host.mjs'), 'utf8')).toBe('new host');
  });
});

describe('GitHub Actions runners host no Papercusp operator (WI-10006976)', () => {
  const failingChild = (calls: string[]) => (_cmd: string, args: readonly string[]) => {
    calls.push(args.join(' '));
    return { status: 1, stdout: '', stderr: 'disclosure_ledger_unavailable', signal: null };
  };

  it('the bundle preflight skips the census on GITHUB_ACTIONS=true and runs it otherwise', () => {
    const calls: string[] = [];
    const inputsFile = join(work, 'inputs.json');
    expect(runBundleRestrictedHoldPreflight({ repoRoot: work, inputsFile, env: { GITHUB_ACTIONS: 'true' }, spawn: failingChild(calls) as never }))
      .toEqual({ verdict: 'skipped', reason: 'github-actions' });
    expect(calls).toHaveLength(0);
    // Control: the generic CI flag (which local tooling also sets) is NOT a skip; the census runs and fails closed.
    expect(runBundleRestrictedHoldPreflight({ repoRoot: work, inputsFile, env: { CI: 'true' }, spawn: failingChild(calls) as never }))
      .toMatchObject({ verdict: 'refuse', error: 'restricted_hold_state_unknown' });
    expect(calls).toHaveLength(1);
  });

  it('runGate keeps the fresh bundle on the github-actions skip and discloses it', () => {
    snapshotArtifacts({ outdir, snapshotDir, artifacts: ['hono-host.mjs'] });
    publish('hono-host.mjs', 'new host');
    const main = writeMetafile('hono-host.mjs.meta.json', ['bin/hono-host.ts']);
    const lines: string[] = [];
    const code = runGate({
      root: work, baseDir, outdir, snapshotDir, metafiles: [main],
      preflight: () => ({ verdict: 'skipped', reason: 'github-actions' }) as never,
      log: (line) => lines.push(line),
    });
    expect(code).toBe(GATE_EXIT.admit);
    expect(readFileSync(join(outdir, 'hono-host.mjs'), 'utf8')).toBe('new host');
    expect(existsSync(snapshotDir)).toBe(false);
    expect(lines.join('\n')).toMatch(/census skipped \(github-actions/);
  });

  it('runGate still fails closed on any other skip reason, under a refusal that names it', () => {
    snapshotArtifacts({ outdir, snapshotDir, artifacts: ['hono-host.mjs'] });
    publish('hono-host.mjs', 'new host');
    const main = writeMetafile('hono-host.mjs.meta.json', ['bin/hono-host.ts']);
    const lines: string[] = [];
    const code = runGate({
      root: work, baseDir, outdir, snapshotDir, metafiles: [main],
      preflight: () => ({ verdict: 'skipped', reason: 'testing-run' }) as never,
      log: (line) => lines.push(line),
    });
    expect(code).toBe(GATE_EXIT.refuse);
    expect(readFileSync(join(outdir, 'hono-host.mjs'), 'utf8')).toBe('old host');
    // A bare skipped verdict used to print `error=undefined ... undefined`.
    expect(lines.join('\n')).toMatch(/BUNDLE_RESTRICTED_HOLD_REFUSED error=restricted_hold_skip_undeclared .*"testing-run"/);
    expect(lines.join('\n')).not.toMatch(/undefined/);
  });
});

describe('every bundle-preflight skip is admitted by the gate (WI-6554700010030421)', () => {
  // 3632d7de77 taught runBundleRestrictedHoldPreflight to skip on the green-checkpoint identity while
  // runGate admitted only github-actions: every gate-run host bundle was refused and, with no
  // last-known-good artifact, bundle-host.sh exited 1 (native-ecosystem.e2e red on every gate run).
  const neverCensus = (calls: string[]) => (_cmd: string, args: readonly string[]) => {
    calls.push(args.join(' '));
    return { status: 1, stdout: '', stderr: 'census must not run on a declared skip', signal: null };
  };
  // The env that produces each declared skip. A reason added to BUNDLE_PREFLIGHT_SKIP_REASONS with no
  // row here fails the completeness check below, so the table cannot drift from the preflight.
  const skipEnvs: Record<string, NodeJS.ProcessEnv> = {
    'release-gate': { PC_HEAVY_RELEASE_GATE: '1', GREEN_CHECKPOINT: '1' },
    'github-actions': { GITHUB_ACTIONS: 'true' },
  };

  it('the table lists exactly the reasons the preflight can return', () => {
    expect(Object.keys(skipEnvs).sort()).toEqual(Object.keys(BUNDLE_PREFLIGHT_SKIP_REASONS).sort());
  });

  it.each(Object.keys(skipEnvs))('the REAL preflight skip "%s" keeps the fresh bundle through runGate', (reason) => {
    const calls: string[] = [];
    snapshotArtifacts({ outdir, snapshotDir, artifacts: ['hono-host.mjs'] });
    publish('hono-host.mjs', 'new host');
    const main = writeMetafile('hono-host.mjs.meta.json', ['bin/hono-host.ts']);
    const lines: string[] = [];
    const code = runGate({
      root: work, baseDir, outdir, snapshotDir, metafiles: [main],
      preflight: ((opts: Parameters<typeof runBundleRestrictedHoldPreflight>[0]) =>
        runBundleRestrictedHoldPreflight({ ...opts, env: skipEnvs[reason], spawn: neverCensus(calls) as never })) as never,
      log: (line) => lines.push(line),
    });
    expect(calls).toHaveLength(0);
    expect(code).toBe(GATE_EXIT.admit);
    expect(readFileSync(join(outdir, 'hono-host.mjs'), 'utf8')).toBe('new host');
    expect(existsSync(snapshotDir)).toBe(false);
    expect(lines.join('\n')).toContain(`census skipped (${reason}: `);
  });

  it('only the PAIRED gate identity skips: GREEN_CHECKPOINT=1 alone still runs the census and fails closed', () => {
    const calls: string[] = [];
    snapshotArtifacts({ outdir, snapshotDir, artifacts: ['hono-host.mjs'] });
    publish('hono-host.mjs', 'new host');
    const main = writeMetafile('hono-host.mjs.meta.json', ['bin/hono-host.ts']);
    const code = runGate({
      root: work, baseDir, outdir, snapshotDir, metafiles: [main],
      preflight: ((opts: Parameters<typeof runBundleRestrictedHoldPreflight>[0]) =>
        runBundleRestrictedHoldPreflight({ ...opts, env: { GREEN_CHECKPOINT: '1' }, spawn: neverCensus(calls) as never })) as never,
      log: () => {},
    });
    expect(calls).toHaveLength(1);
    expect(code).toBe(GATE_EXIT.refuse);
    expect(readFileSync(join(outdir, 'hono-host.mjs'), 'utf8')).toBe('old host');
  });
});
