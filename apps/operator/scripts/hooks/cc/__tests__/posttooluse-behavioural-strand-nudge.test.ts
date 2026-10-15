/**
 * posttooluse-behavioural-strand-nudge — the recurrence guard for the BEHAVIOURAL
 * cross-workspace strand class (EI-20022235111425919).
 *
 * WHAT THIS FILE IS FOR. The class is invisible to both instruments an author reads as
 * green: `lint:tsc` sees no type change (only a runtime call count moved) and
 * `test:affected` selects by the workspaces the changed PATHS map into, which is the wrong
 * workspace by construction. Measured cost of one instance (WI-37582): ~3 gate reds, ~2h of
 * frozen `main`, three agents diagnosing it in parallel. A detector already exists; the gap
 * the hook closes is KNOWING TO RUN IT. So the assertion that matters is not "the hook is
 * well-formed" but **it FIRES on the real thing** — exercised against the REAL exported
 * `increasedSeams` / `repoForPath` / `submodulePaths` from
 * scripts/check-behavioural-strands.mjs, never a stand-in.
 *
 * THE DEFECT A COPY OF THE SIBLING HOOK WOULD HAVE, asserted here directly: `libs/generic/*`
 * and `libs/papercusp` are SUBMODULES and they are this guard's whole trigger class. A
 * superproject `git show HEAD:<path>` answers "absent" for a file that is committed inside
 * one, and the hook reads that null as "new file — nothing to strand". Such a hook never
 * fires on exactly the files it exists for, while passing any test written on a superproject
 * fixture. The routing tests below are what make that failure impossible to reintroduce
 * silently: they assert WHICH repo the git questions were asked of, not just the output text.
 *
 * The negative cases matter exactly as much: a nudge that fires on ordinary edits is noise
 * agents learn to ignore, which is how a working detector stops working.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// __dirname = <repo>/apps/operator/scripts/hooks/cc/__tests__ — six levels down.
const ROOT = resolve(__dirname, '../../../../../..');
const HOOK = resolve(__dirname, '../posttooluse-behavioural-strand-nudge.mjs');
const DETECTOR = resolve(ROOT, 'scripts/check-behavioural-strands.mjs');

type Seam = { seam: string; before: number; after: number };
type ControlFlow = { seam: string; function: string; reason: string };
type OutputValue = { property: string; before: string; after: string; reason?: string };
type PackageScriptValue = { property: string; before: string; after: string };
type Injection = {
  member: string;
  owner: string;
  source: string;
  before: number;
  after: number;
  siblings: string[];
};
type Detector = {
  invokedInjectedMembers: (before: string, after: string, file?: string) => Injection[];
  increasedSeams: (before: string, after: string, file?: string) => Seam[];
  changedSeamControlFlow: (before: string, after: string, file?: string) => ControlFlow[];
  diffOutputValues: (before: string, after: string, file?: string) => OutputValue[];
  diffPackageScriptValues: (before: string, after: string) => PackageScriptValue[] | null;
  hasPackageScriptAssertion: (text: string, names: string[], fileName?: string) => boolean;
  repoForPath: (rel: string, subs: string[]) => { submodule: string | null; cwd: string; relPath: string };
  submodulePaths: () => string[];
  candidateSkipReason: (rel: string) => string | null;
};
type Hook = {
  nudgeFor: (p: string, deps?: Record<string, unknown>) => Promise<string | null>;
  isCandidateFile: (p: string) => boolean;
  formatNudge: (
    rel: string,
    seamsOrTriggers:
      | Seam[]
      | {
          seams?: Seam[];
          controlFlow?: ControlFlow[];
          values?: OutputValue[];
          scriptValues?: PackageScriptValue[];
          injections?: Injection[];
        },
    opts?: { baseSha?: string | null; submodule?: string | null },
  ) => string;
  isDirectCliInvocation: (entryPath?: string) => boolean;
};

const loadHook = async (): Promise<Hook> => (await import(`file://${HOOK}`)) as unknown as Hook;
/** The REAL detector — the whole value of this suite is that it is not a fake. */
const loadDetector = async (): Promise<Detector> => (await import(`file://${DETECTOR}`)) as unknown as Detector;

/** A one-call → two-call edit of an injected collaborator: the exact WI-37582 shape. */
const ONE_CALL = 'export function run(source){ return source.lexical(); }';
const TWO_CALLS = 'export function run(source){ source.lexical(); return source.lexical(); }';
/** Same file, edited, but the seam count is unchanged — the calibration control. */
const ONE_CALL_EDITED = 'export function run(source){ /* comment */ return source.lexical(); }';
// `probe` must be IMPORTED: the detector only treats imported or explicitly injected
// bindings as seams (a free global is not a dependency it can reason about).
const CONTROL_FLOW_BEFORE = `
  import { probe } from './probe';
  export async function run(input) {
    for (const spec of input.specs) {
      const evidence = await probe({ runner: input.runner, spec });
      if (evidence.ready) break;
    }
  }
`;
const CONTROL_FLOW_AFTER = `
  import { probe } from './probe';
  export async function run(input) {
    for (const spec of input.specs) {
      const evidence = await probe({ runner: input.runner, spec });
      if (!spec.satisfiesReadiness) continue;
      if (evidence.ready) break;
    }
  }
`;
// EI-23824032487848760 — the measured shape: a factory-built local deps bundle whose OPTIONAL
// member gains an invoker. Nothing about a call COUNT on an imported/injected-param seam changes,
// so only the injected-member trigger sees it.
const INJECTED_DEPS = `
  export interface WatchdogDeps {
    now: () => number;
    escalateGiveUp: (id: string) => Promise<void>;
    reconcileStrandedLatch?: (id: string) => Promise<void>;
  }
`;
const INJECTED_BEFORE = `${INJECTED_DEPS}
  export async function tick(opts) { const deps = makeDeps(opts); await deps.escalateGiveUp('a'); }
`;
const INJECTED_AFTER = `${INJECTED_DEPS}
  export async function tick(opts) {
    const deps = makeDeps(opts);
    await deps.escalateGiveUp('a');
    await (deps.reconcileStrandedLatch ?? fallback)('a');
  }
`;
const OUTPUT_BEFORE = 'export function write(rollup){ return { spentCents: rollup.potCents }; }';
const OUTPUT_AFTER = 'export function write(rollup){ return { spentCents: rollup.pot.samples > 0 ? rollup.potCents : null }; }';

/**
 * Deps that use the REAL detector but inject file content and git answers, so no tree write
 * is needed. `exists` answers true ONLY for the edited file and the detector, which is what
 * makes findRepoRoot resolve the REAL repo root — and therefore what makes the repo-relative
 * path, and the submodule routing computed from it, genuinely exercised rather than faked.
 */
async function depsFor(
  abs: string,
  before: string | null,
  after: string,
  opts: { baseSha?: string | null } = {},
) {
  const detector = await loadDetector();
  const showAtCalls: Array<{ cwd: string; relPath: string; ref: string }> = [];
  const resolveBaseCalls: string[] = [];
  const baseSha = opts.baseSha === undefined ? 'abc1234def' : opts.baseSha;
  return {
    showAtCalls,
    resolveBaseCalls,
    deps: {
      exists: (p: string) => p === abs || p === DETECTOR,
      sizeOf: () => 100,
      readFile: () => after,
      showAt: (cwd: string, relPath: string, ref: string) => {
        showAtCalls.push({ cwd, relPath, ref });
        return before;
      },
      resolveBase: (cwd: string) => {
        resolveBaseCalls.push(cwd);
        return baseSha;
      },
      loadDetector: async () => detector,
    },
  };
}

describe('behavioural-strand nudge — fires on the real trap', () => {
  it('FIRES when an edit adds a call to an injected seam, naming the seam and both counts', async () => {
    const hook = await loadHook();
    const abs = resolve(ROOT, 'packages/operator-core/lib/x.ts');
    const { deps } = await depsFor(abs, ONE_CALL, TWO_CALLS);
    const out = await hook.nudgeFor(abs, deps);
    expect(out).not.toBeNull();
    expect(out).toContain('SEAM CALL-COUNT INCREASE');
    expect(out).toContain('source.lexical');
    expect(out).toContain('called 1× → 2×');
    // It must point at the detector, since KNOWING TO RUN IT is the entire gap.
    expect(out).toContain('check-behavioural-strands.mjs');
  });

  it('CONTROL: the same file, edited, with the seam count UNCHANGED produces nothing', async () => {
    // Calibrates the assertion above: without this, a hook that fired on every edit would
    // pass the first test just as well.
    const hook = await loadHook();
    const abs = resolve(ROOT, 'packages/operator-core/lib/x.ts');
    const { deps } = await depsFor(abs, ONE_CALL, ONE_CALL_EDITED);
    expect(await hook.nudgeFor(abs, deps)).toBeNull();
  });

  it('FIRES when control-flow changes a dependency call’s invocation eligibility without adding a call site', async () => {
    const hook = await loadHook();
    const abs = resolve(ROOT, 'packages/operator-core/lib/x.ts');
    const { deps } = await depsFor(abs, CONTROL_FLOW_BEFORE, CONTROL_FLOW_AFTER);
    const out = await hook.nudgeFor(abs, deps);
    expect(out).not.toBeNull();
    expect(out).toContain('CONTROL-FLOW STRAND RISK');
    expect(out).toContain('probe()');
    expect(out).toContain('invocation eligibility changed');
  });

  it('produces nothing when the file is byte-identical to its base', async () => {
    const hook = await loadHook();
    const abs = resolve(ROOT, 'packages/operator-core/lib/x.ts');
    const { deps } = await depsFor(abs, TWO_CALLS, TWO_CALLS);
    expect(await hook.nudgeFor(abs, deps)).toBeNull();
  });

  it('produces nothing for a NEW file (no version at the base to strand against)', async () => {
    const hook = await loadHook();
    const abs = resolve(ROOT, 'packages/operator-core/lib/x.ts');
    const { deps } = await depsFor(abs, null, TWO_CALLS);
    expect(await hook.nudgeFor(abs, deps)).toBeNull();
  });

  it('FIRES when a returned output value changes, using the real detector', async () => {
    const hook = await loadHook();
    const abs = resolve(ROOT, 'packages/operator-core/lib/x.ts');
    const { deps } = await depsFor(abs, OUTPUT_BEFORE, OUTPUT_AFTER);
    const out = await hook.nudgeFor(abs, deps);
    expect(out).not.toBeNull();
    expect(out).toContain('OUTPUT-VALUE STRAND');
    expect(out).toContain('spentCents');
    expect(out).toContain('rollup.potCents');
    expect(out).toContain('toHaveProperty');
  });

  it('FIRES when a package script string changes, naming its stable key and anchored detector command', async () => {
    const hook = await loadHook();
    const abs = resolve(ROOT, 'package.json');
    const before = JSON.stringify({ scripts: { 'test:file': 'node old-runner.mjs' } });
    const after = JSON.stringify({ scripts: { 'test:file': 'node new-runner.mjs' } });
    const { deps } = await depsFor(abs, before, after);
    const out = await hook.nudgeFor(abs, deps);
    expect(out).not.toBeNull();
    expect(out).toContain('PACKAGE-SCRIPT STRAND RISK');
    expect(out).toContain('scripts["test:file"]');
    expect(out).toContain('node old-runner.mjs');
    expect(out).toContain('node new-runner.mjs');
    expect(out).toContain('--files=package.json');
    expect(out).toContain('regex assertion');
    expect(out).not.toContain('ANOTHER workspace');
  });

  it('FIRES when an OPTIONAL Deps member gains an invoker, naming the member and its siblings (EI-23824032487848760)', async () => {
    const hook = await loadHook();
    const abs = resolve(ROOT, 'packages/operator-core/lib/x.ts');
    const { deps } = await depsFor(abs, INJECTED_BEFORE, INJECTED_AFTER);
    const out = await hook.nudgeFor(abs, deps);
    expect(out).not.toBeNull();
    expect(out).toContain('INJECTED-MEMBER STRAND RISK');
    expect(out).toContain('reconcileStrandedLatch on WatchdogDeps');
    expect(out).toContain('invoked 0× → 1×');
    // The sibling members are the join key the CLI matches partial fixtures on.
    expect(out).toContain('siblings: escalateGiveUp, now');
    // It is a same-workspace class, so it must not claim the stranded fixtures are in ANOTHER workspace.
    expect(out).not.toContain('are in a DIFFERENT one');
    expect(out).toContain('vitest-fail-on-console');
    expect(out).toContain('check-behavioural-strands.mjs');
  });

  it('CONTROL: the same file edited with the member invocation count UNCHANGED produces nothing', async () => {
    const hook = await loadHook();
    const abs = resolve(ROOT, 'packages/operator-core/lib/x.ts');
    const { deps } = await depsFor(abs, INJECTED_AFTER, `${INJECTED_AFTER}\n// edited`);
    expect(await hook.nudgeFor(abs, deps)).toBeNull();
  });

  it('degrades to silence — not a crash — when the loaded detector predates invokedInjectedMembers', async () => {
    const hook = await loadHook();
    const abs = resolve(ROOT, 'packages/operator-core/lib/x.ts');
    const { deps } = await depsFor(abs, INJECTED_BEFORE, INJECTED_AFTER);
    const real = await loadDetector();
    const { invokedInjectedMembers: _omitted, ...older } = real;
    void _omitted;
    expect(await hook.nudgeFor(abs, { ...deps, loadDetector: async () => older })).toBeNull();
  });

  it('keeps the other triggers’ wording unchanged when an injection rides along with a call-count increase', async () => {
    const hook = await loadHook();
    const out = hook.formatNudge(
      'a/b.ts',
      {
        seams: [{ seam: 's.m', before: 1, after: 2 }],
        injections: [
          { member: 'opt', owner: 'XDeps', source: 'interface', before: 0, after: 1, siblings: ['a', 'b'] },
        ],
      },
      { baseSha: 'abc1234' },
    );
    expect(out).toContain('SEAM CALL-COUNT INCREASE');
    expect(out).not.toContain('INJECTED-MEMBER STRAND RISK');
    // …while the injection is still named, and the cross-workspace explanation still applies.
    expect(out).toContain('opt on XDeps');
    expect(out).toContain('ANOTHER workspace');
  });
});

describe('behavioural-strand nudge — submodule routing (the sibling-copy defect)', () => {
  it('asks git of the SUBMODULE that owns the file, with the submodule-relative path', async () => {
    // libs/generic/* IS the trigger class. A superproject `git show HEAD:<that path>` answers
    // absent, which a naive hook reads as "new file" and returns null — never firing on the
    // very files it exists for. This asserts the routing, not merely the output.
    const hook = await loadHook();
    const abs = resolve(ROOT, 'libs/generic/search/src/hybrid.ts');
    const { deps, showAtCalls, resolveBaseCalls } = await depsFor(abs, ONE_CALL, TWO_CALLS);
    const out = await hook.nudgeFor(abs, deps);

    expect(out).not.toBeNull();
    expect(showAtCalls).toHaveLength(1);
    expect(showAtCalls[0].cwd).toBe(resolve(ROOT, 'libs/generic/search'));
    expect(showAtCalls[0].relPath).toBe('src/hybrid.ts');
    // The base is pinned ONCE, in the owning repo, and reused for the comparison and the
    // prescribed command — resolving it twice would leave a git-sync window between them.
    expect(resolveBaseCalls).toEqual([resolve(ROOT, 'libs/generic/search')]);
    expect(showAtCalls[0].ref).toBe('abc1234def');
    // The file is still named superproject-relative, because `--files=` is superproject-rooted.
    expect(out).toContain('libs/generic/search/src/hybrid.ts');
    expect(out).toContain('resolved in submodule libs/generic/search');
  });

  it('CONTROL: a superproject file routes to the superproject, with no submodule note', async () => {
    const hook = await loadHook();
    const abs = resolve(ROOT, 'packages/operator-core/lib/x.ts');
    const { deps, showAtCalls, resolveBaseCalls } = await depsFor(abs, ONE_CALL, TWO_CALLS);
    const out = await hook.nudgeFor(abs, deps);

    expect(out).not.toBeNull();
    expect(showAtCalls[0].cwd).toBe(ROOT);
    expect(showAtCalls[0].relPath).toBe('packages/operator-core/lib/x.ts');
    expect(resolveBaseCalls).toEqual([ROOT]);
    expect(out).not.toContain('resolved in submodule');
  });
});

describe('behavioural-strand nudge — the prescribed command is anchored', () => {
  it('carries BOTH pins so it reproduces this comparison after git-sync sweeps the edit', async () => {
    const hook = await loadHook();
    const abs = resolve(ROOT, 'packages/operator-core/lib/x.ts');
    const { deps } = await depsFor(abs, ONE_CALL, TWO_CALLS, { baseSha: 'deadbee' });
    const out = await hook.nudgeFor(abs, deps);
    expect(out).toContain('--base deadbee --files=packages/operator-core/lib/x.ts');
  });

  it('degrades to the --files-only form (still firing) when the base cannot be resolved', async () => {
    // Fails open rather than losing the nudge: a detached/empty repo or no git at all.
    const hook = await loadHook();
    const abs = resolve(ROOT, 'packages/operator-core/lib/x.ts');
    const { deps } = await depsFor(abs, ONE_CALL, TWO_CALLS, { baseSha: null });
    const out = await hook.nudgeFor(abs, deps);
    expect(out).not.toBeNull();
    expect(out).toContain('--files=packages/operator-core/lib/x.ts');
    expect(out).not.toContain('--base');
  });

  it('tells the reader to read the EXIT CODE, and that 2 is not a clean bill', async () => {
    const hook = await loadHook();
    const out = hook.formatNudge('a/b.ts', [{ seam: 's.m', before: 1, after: 2 }], { baseSha: 'abc1234' });
    expect(out).toContain('2 = NOT CHECKED');
    // The narrowing is a RANKING, not a boundary — saying so is what stops a reader treating
    // an empty narrow set as "nothing to check".
    expect(out).toContain('--wide');
    // Adding a call is usually correct; the fix for a stranded assertion is to UPDATE the
    // count, never to delete or loosen the assertion that makes the class detectable.
    expect(out).toContain('do not delete or');
  });
});

describe('behavioural-strand nudge — candidate filter', () => {
  it('accepts an ordinary shared-lib source file', async () => {
    const hook = await loadHook();
    expect(hook.isCandidateFile('libs/generic/search/src/hybrid.ts')).toBe(true);
    expect(hook.isCandidateFile('packages/operator-core/lib/x.ts')).toBe(true);
  });

  it('excludes TEST files on purpose — a test is not something anyone injects', async () => {
    const hook = await loadHook();
    expect(hook.isCandidateFile('packages/operator-core/lib/x.test.ts')).toBe(false);
    expect(hook.isCandidateFile('packages/operator-core/lib/x.spec.tsx')).toBe(false);
  });

  it('MIRRORS the CLI exactly: the test exclusion is by SUFFIX, so a __tests__/ helper is in scope', async () => {
    // Not an oversight, and deliberately pinned rather than "fixed" in the hook alone. The
    // hook's filter is a copy of the detector's (SOURCE_RE / TEST_RE / EXCLUDED_DIR_RE /
    // EXCLUDED_ROOT_RE in scripts/check-behavioural-strands.mjs) and the hook PRESCRIBES that
    // detector's command — so a hook that narrowed further would nudge on a set the command it
    // hands you does not judge, which is worse than the occasional nudge on a __tests__/
    // helper. If the exclusion should become directory-aware, change it in the DETECTOR and
    // let the hook keep mirroring it; this assertion is what would then fail and point here.
    const hook = await loadHook();
    expect(hook.isCandidateFile('packages/operator-core/lib/__tests__/helpers.ts')).toBe(true);
  });

  it('excludes declarations and build/vendor output', async () => {
    const hook = await loadHook();
    expect(hook.isCandidateFile('packages/operator-core/lib/x.d.ts')).toBe(false);
    expect(hook.isCandidateFile('node_modules/pkg/index.ts')).toBe(false);
    expect(hook.isCandidateFile('packages/operator-core/dist/x.js')).toBe(false);
  });

  it('excludes a non-source file outright', async () => {
    const hook = await loadHook();
    expect(hook.isCandidateFile('README.md')).toBe(false);
    expect(hook.isCandidateFile('package.json')).toBe(true);
    expect(hook.isCandidateFile('packages/x/package.json')).toBe(true);
    expect(hook.isCandidateFile('node_modules/pkg/package.json')).toBe(false);
  });

  it('accepts JavaScript sources — scripts/*.mjs and hooks hold shared seams too (WI-10004906)', async () => {
    const hook = await loadHook();
    expect(hook.isCandidateFile('scripts/lib/test-pass-reuse.mjs')).toBe(true);
    expect(hook.isCandidateFile('scripts/legacy.cjs')).toBe(true);
    expect(hook.isCandidateFile('apps/web/src/Widget.jsx')).toBe(true);
    expect(hook.isCandidateFile('scripts/lib/not-checked.d.mts')).toBe(false);
    expect(hook.isCandidateFile('scripts/__tests__/a.test.mjs')).toBe(false);
  });

  it('agrees with the DETECTOR path by path — the hook copy cannot drift from candidateSkipReason', async () => {
    // The hook keeps its own copy of the filter (it decides before loading TypeScript), so
    // this is the pin: a widening made in the detector and not here — the WI-10004906 shape —
    // fails this test instead of silently narrowing the nudge.
    const [hook, detector] = await Promise.all([loadHook(), loadDetector()]);
    const paths = [
      'libs/generic/search/src/hybrid.ts',
      'packages/operator-core/lib/x.tsx',
      'packages/x/lib/y.mts',
      'packages/x/lib/y.cts',
      'scripts/lib/test-pass-reuse.mjs',
      'scripts/legacy.cjs',
      'apps/operator/scripts/hooks/cc/hook.js',
      'apps/web/src/Widget.jsx',
      'packages/operator-core/lib/__tests__/helpers.ts',
      'packages/operator-core/lib/x.test.ts',
      'packages/operator-core/lib/x.spec.tsx',
      'scripts/__tests__/a.test.mjs',
      'packages/x/lib/a.spec.cjs',
      'packages/operator-core/lib/x.d.ts',
      'scripts/lib/not-checked.d.mts',
      'packages/x/index.d.cts',
      'node_modules/pkg/index.ts',
      'packages/operator-core/dist/x.js',
      '.papercusp/scratch/probe.mts',
      'papercup-release/apps/x.ts',
      'README.md',
      'package.json',
      'packages/x/package.json',
      'node_modules/pkg/package.json',
      'scripts/run.sh',
    ];
    for (const p of paths) {
      expect(hook.isCandidateFile(p), p).toBe(detector.candidateSkipReason(p) === null);
    }
  });

  it('the shipped --self-test passes (the installed hook is self-consistent)', () => {
    // The installed copy runs `--self-test`, not this suite. WI-10004906 widened the filter
    // and left a stale 'skips non-TS' self-test case red while every vitest case was green;
    // nothing in the gate ran it. The required-field sibling already pins its own this way.
    const out = execFileSync(process.execPath, [HOOK, '--self-test'], { encoding: 'utf8' });
    expect(out).toContain('self-test passed');
  });

  it('the measured regex assertion reads the script key the detector joins on', async () => {
    const detector = await loadDetector();
    const source = readFileSync(resolve(ROOT, 'scripts/npm-install-safe.test.mjs'), 'utf8');
    expect(detector.hasPackageScriptAssertion(source, ['test:file'], 'scripts/npm-install-safe.test.mjs')).toBe(true);
  });
});

describe('behavioural-strand nudge — never runs main() on import', () => {
  it('isDirectCliInvocation is TRUE only for this hook’s own basename', async () => {
    // Importing the module must not run main(): main() waits on stdin and then calls
    // process.exit(0), which kills the vitest worker mid-run — the sibling hook's suite
    // caught exactly that (10 passed, run reported FAILED). This whole file is the standing
    // proof that it does not, and these two assertions name the mechanism.
    const hook = await loadHook();
    expect(hook.isDirectCliInvocation('/home/u/.papercusp/hooks/cc/posttooluse-behavioural-strand-nudge.mjs')).toBe(
      true,
    );
    expect(hook.isDirectCliInvocation('/repo/node_modules/vitest/dist/worker.js')).toBe(false);
    expect(hook.isDirectCliInvocation(undefined)).toBe(false);
  });
});

// WI-6554700010008923 (oversized-tool-results-reduction-2026-10-12#P-008): hook output
// bypasses the result door, so an identical nudge repeated per Edit lands in context
// in full each time. Measured: two Edits to one file in one batch printed the ~2 KB
// block twice.
describe('behavioural-strand nudge — one session sees an identical block once', () => {
  type Dedupe = {
    shouldEmitNudge: (sessionId: unknown, filePath: string, msg: string, opts?: { stateDir?: string }) => boolean;
  };
  const withStateDir = async (fn: (hook: Dedupe, stateDir: string) => void | Promise<void>) => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const stateDir = mkdtempSync(resolve(tmpdir(), 'strand-nudge-dedupe-'));
    try {
      await fn((await import(`file://${HOOK}`)) as unknown as Dedupe, stateDir);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  };

  it('emits the first time and suppresses the identical block for the same file and session', () =>
    withStateDir((hook, stateDir) => {
      expect(hook.shouldEmitNudge('sess-1', '/r/a.ts', 'BLOCK', { stateDir })).toBe(true);
      expect(hook.shouldEmitNudge('sess-1', '/r/a.ts', 'BLOCK', { stateDir })).toBe(false);
    }));

  it('re-emits when the block CHANGES (a different seam set is news)', () =>
    withStateDir((hook, stateDir) => {
      expect(hook.shouldEmitNudge('sess-1', '/r/a.ts', 'BLOCK v1', { stateDir })).toBe(true);
      expect(hook.shouldEmitNudge('sess-1', '/r/a.ts', 'BLOCK v2', { stateDir })).toBe(true);
      expect(hook.shouldEmitNudge('sess-1', '/r/a.ts', 'BLOCK v2', { stateDir })).toBe(false);
    }));

  it('never suppresses across files or across sessions', () =>
    withStateDir((hook, stateDir) => {
      expect(hook.shouldEmitNudge('sess-1', '/r/a.ts', 'BLOCK', { stateDir })).toBe(true);
      expect(hook.shouldEmitNudge('sess-1', '/r/b.ts', 'BLOCK', { stateDir })).toBe(true);
      expect(hook.shouldEmitNudge('sess-2', '/r/a.ts', 'BLOCK', { stateDir })).toBe(true);
    }));

  it('fails OPEN: no usable session id always emits', () =>
    withStateDir((hook, stateDir) => {
      for (const bad of [undefined, '', '../escape', 42]) {
        expect(hook.shouldEmitNudge(bad, '/r/a.ts', 'BLOCK', { stateDir })).toBe(true);
        expect(hook.shouldEmitNudge(bad, '/r/a.ts', 'BLOCK', { stateDir })).toBe(true);
      }
    }));
});
