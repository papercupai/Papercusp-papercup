import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FORK_BASE_INHERITANCE_MIN_START_MS,
  FORK_BASE_INHERITANCE_STOP_STARTING_MS,
  attemptForkBaseInheritance,
  classifyFailingEntries,
  decideForkBaseInheritance,
  forkDeltaOverlayRefusal,
  isFlagOnlyLockfileDiff,
  parseAffectedTestsResult,
  parseRawDiffZ,
  SUITE_COVERAGE_ACCOUNTING_KEYS,
  suiteResultRefusal,
  type ForkBaseFileOutcome,
  type ForkBaseInheritanceDeps,
  type ForkBaseInheritanceInput,
  type RawDiffEntry,
} from './fork-base-inherited-tests';
import type { FailingFile, IsolationResult } from './green-checkpoint';
import { inheritUpstreamGateLegs } from '@papercusp/operator-core/lib/release/upstream-inherited-legs';

const OC = '@papercusp/operator-core';
const A: FailingFile = { workspace: OC, file: 'lib/a.test.ts' };
const B: FailingFile = { workspace: OC, file: 'lib/b.test.ts' };
const FAILED_RESULT =
  'AFFECTED_TESTS_RESULT status=failed tasks=6 failed=2 quarantinedFailed=0 timedOutTasks=0 undeterminedTasks=0';

describe('parseRawDiffZ', () => {
  it('parses modify, add and delete records', () => {
    const out =
      ':100644 100644 aaa bbb M\0lib/x.ts\0' +
      ':000000 100644 000 ccc A\0lib/new.ts\0' +
      ':100644 000000 ddd 000 D\0lib/gone.ts\0';
    expect(parseRawDiffZ(out)).toEqual([
      { srcMode: '100644', dstMode: '100644', status: 'M', path: 'lib/x.ts' },
      { srcMode: '000000', dstMode: '100644', status: 'A', path: 'lib/new.ts' },
      { srcMode: '100644', dstMode: '000000', status: 'D', path: 'lib/gone.ts' },
    ]);
  });
  it('returns null for a malformed record instead of a partial list', () => {
    expect(parseRawDiffZ(':100644 100644 aaa bbb M\0')).toBeNull();
    expect(parseRawDiffZ('garbage\0lib/x.ts\0')).toBeNull();
  });
});

describe('isFlagOnlyLockfileDiff', () => {
  it('accepts install-flag churn only', () => {
    const diff = [
      'diff --git a/package-lock.json b/package-lock.json',
      '--- a/package-lock.json',
      '+++ b/package-lock.json',
      '@@ -10 +10 @@',
      '-      "dev": true,',
      '+      "devOptional": true,',
    ].join('\n');
    expect(isFlagOnlyLockfileDiff(diff)).toBe(true);
  });
  it('refuses a version, resolved or integrity change, and an empty diff', () => {
    expect(isFlagOnlyLockfileDiff('@@ -1 +1 @@\n-      "version": "1.0.0",\n+      "version": "1.0.1",')).toBe(false);
    expect(isFlagOnlyLockfileDiff('+      "dev": true,\n+      "resolved": "https://x"')).toBe(false);
    expect(isFlagOnlyLockfileDiff('')).toBe(false);
  });
});

describe('forkDeltaOverlayRefusal', () => {
  const m = (p: string, extra: Partial<RawDiffEntry> = {}): RawDiffEntry => ({
    srcMode: '100644',
    dstMode: '100644',
    status: 'M',
    path: p,
    ...extra,
  });
  it('allows source changes and flag-only lockfile churn', () => {
    const diffs = new Map([['package-lock.json', '-  "dev": true,\n+  "devOptional": true,']]);
    expect(forkDeltaOverlayRefusal([m('apps/x.ts'), m('package-lock.json')], diffs)).toBeNull();
  });
  it('refuses anything that can change installed dependencies or submodules', () => {
    expect(forkDeltaOverlayRefusal([m('packages/p/package.json')], new Map())).toMatch(/^dependency-shaping-change:/);
    expect(forkDeltaOverlayRefusal([m('.gitmodules')], new Map())).toMatch(/^dependency-shaping-change:/);
    expect(forkDeltaOverlayRefusal([m('libs/sub', { dstMode: '160000' })], new Map())).toMatch(/^gitlink-change:/);
    expect(
      forkDeltaOverlayRefusal([m('package-lock.json')], new Map([['package-lock.json', '-  "version": "1",\n+  "version": "2",']])),
    ).toMatch(/^lockfile-version-change:/);
    expect(forkDeltaOverlayRefusal([m('package-lock.json')], new Map())).toMatch(/^lockfile-version-change:/);
    expect(forkDeltaOverlayRefusal([], new Map())).toBe('empty-delta');
  });
});

describe('suite result gate', () => {
  it('passes a plain measured red', () => {
    expect(suiteResultRefusal(parseAffectedTestsResult(`noise\n${FAILED_RESULT}\n`))).toBeNull();
  });
  it('refuses timed-out, undetermined, aborted and missing results (the LAST line wins)', () => {
    expect(suiteResultRefusal(parseAffectedTestsResult(FAILED_RESULT.replace('timedOutTasks=0', 'timedOutTasks=1')))).toBe(
      'suite-timedOutTasks=1',
    );
    expect(
      suiteResultRefusal(parseAffectedTestsResult(FAILED_RESULT.replace('undeterminedTasks=0', 'undeterminedTasks=2'))),
    ).toBe('suite-undeterminedTasks=2');
    expect(suiteResultRefusal(parseAffectedTestsResult(`${FAILED_RESULT}\n${FAILED_RESULT.replace('status=failed', 'status=aborted')}`))).toBe(
      'suite-status-aborted',
    );
    expect(suiteResultRefusal(parseAffectedTestsResult('no result here'))).toBe('no-suite-result-line');
  });
  it('ignores the coverage-accounting fields the REAL emitter appends (drill run 6bf1c1a5, coverageUnreadableTasks=35)', async () => {
    // Built with the real formatter, not a hand-copied fixture: FAILED_RESULT predates these fields,
    // which is how a substring-matched `unreadable` skipped inheritance on every real fork red.
    const { formatCoverageFields } = await import('../../../../scripts/lib/vitest-summary.mjs');
    const fields = String(formatCoverageFields({ executed: 6878, skipped: 8, unreadableTasks: 35, notExecuted: [] }));
    const keys = [...fields.matchAll(/\b([A-Za-z]+)=\d+/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(SUITE_COVERAGE_ACCOUNTING_KEYS.has(k), `unlisted coverage field ${k}`).toBe(true);
    expect(suiteResultRefusal(parseAffectedTestsResult(`${FAILED_RESULT} ${fields}`))).toBeNull();
    expect(
      suiteResultRefusal(parseAffectedTestsResult(`${FAILED_RESULT.replace('timedOutTasks=0', 'timedOutTasks=1')} ${fields}`)),
    ).toBe('suite-timedOutTasks=1');
  });
});

describe('classifyFailingEntries', () => {
  it('covers file, workspace and test-task entries only through located files', () => {
    const entries = [
      'lib/a.test.ts',
      OC,
      `${OC} :: test:lane-pure`,
      `${OC} :: lint:tsc`,
      '@papercusp/desktop :: test',
      '@papercusp/operator-vite',
    ];
    const all = classifyFailingEntries(entries, [A, B], new Set([`${OC}::lib/a.test.ts`, `${OC}::lib/b.test.ts`]));
    expect(all.inherited).toEqual(['lib/a.test.ts', OC, `${OC} :: test:lane-pure`]);
    expect(all.uncovered).toEqual([`${OC} :: lint:tsc`, '@papercusp/desktop :: test', '@papercusp/operator-vite']);
  });
  it('blocks a workspace entry unless EVERY located file in it inherited', () => {
    const one = classifyFailingEntries([`${OC} :: test:lane-pure`, 'lib/a.test.ts'], [A, B], new Set([`${OC}::lib/a.test.ts`]));
    expect(one.inherited).toEqual(['lib/a.test.ts']);
    expect(one.blocking).toEqual([`${OC} :: test:lane-pure`]);
    expect(one.uncovered).toEqual([]);
  });
});

describe('decideForkBaseInheritance', () => {
  const entries = [`${OC} :: test:lane-pure`, 'lib/a.test.ts', 'lib/b.test.ts'];
  const decide = (a: ForkBaseFileOutcome, b?: ForkBaseFileOutcome) =>
    decideForkBaseInheritance({
      failingTests: entries,
      failingFiles: [A, B],
      outcomes: new Map<string, ForkBaseFileOutcome>([
        [`${OC}::lib/a.test.ts`, a],
        ...(b ? ([[`${OC}::lib/b.test.ts`, b]] as const) : []),
      ]),
    });
  it('inherits only when every file fails at the base', () => {
    expect(decide('fails-at-base', 'fails-at-base').allInherited).toBe(true);
  });
  it('keeps the red for a pass, an error, a skipped re-run or a missing result', () => {
    for (const d of [
      decide('fails-at-base', 'passes-at-base'),
      decide('fails-at-base', 'errored'),
      decide('fails-at-base', 'not-run'),
      decide('fails-at-base'),
    ]) {
      expect(d.allInherited).toBe(false);
      expect(d.blockingFiles).toEqual([`${OC}::lib/b.test.ts`]);
      expect(d.blockingEntries).toContain(`${OC} :: test:lane-pure`);
    }
  });
});

// ── the orchestrator over a fake git ─────────────────────────────────────────────────────────

const BASE = 'b'.repeat(40);
const CAND = 'c'.repeat(40);
const DELTA_Z =
  ':100644 100644 aaa bbb M\0lib/a.ts\0' + ':000000 100644 000 ccc A\0lib/new.ts\0' + ':100644 000000 ddd 000 D\0lib/gone.ts\0';

function input(over: Partial<ForkBaseInheritanceInput> = {}): ForkBaseInheritanceInput {
  return {
    suiteOutput: FAILED_RESULT,
    failingTests: [`${OC} :: test:lane-pure`, 'lib/a.test.ts', 'lib/b.test.ts'],
    failingFiles: [A, B],
    base: BASE,
    candidate: CAND,
    upstreamInstall: 'papercusp',
    upstreamRef: 'refs/remotes/origin/staging',
    treeIsCheckpointRoot: true,
    ...over,
  };
}

function fakeDeps(opts: {
  passAtBase?: string[];
  throwOn?: string[];
  ancestorUpstream?: boolean;
  dirtyAfterRestore?: boolean;
  remaining?: () => number;
}) {
  const calls: string[] = [];
  const events: string[] = [];
  const deps: ForkBaseInheritanceDeps = {
    async git(args) {
      calls.push(args.join(' '));
      const [cmd] = args;
      if (cmd === 'rev-parse') return { code: 0, stdout: `${CAND}\n` };
      if (cmd === 'merge-base') {
        const upstream = args[3] === 'refs/remotes/origin/staging';
        return { code: upstream && opts.ancestorUpstream === false ? 1 : 0, stdout: '' };
      }
      if (cmd === 'diff') return { code: 0, stdout: DELTA_Z };
      if (cmd === 'checkout' || cmd === 'rm') {
        events.push(`${cmd}:${args[1] === BASE ? 'base' : args[1] === CAND ? 'candidate' : 'rm'}:${args.slice(args.indexOf('--') + 1).join(',')}`);
        return { code: 0, stdout: '' };
      }
      if (cmd === 'status') return { code: 0, stdout: opts.dirtyAfterRestore ? ' M lib/a.ts\n' : '' };
      return { code: 1, stdout: '' };
    },
    async runFile(f): Promise<IsolationResult> {
      events.push(`run:${f.file}`);
      if (opts.throwOn?.includes(f.file)) throw new Error('runner crashed');
      return { workspace: f.workspace, file: f.file, passed: opts.passAtBase?.includes(f.file) ?? false };
    },
    remainingMs: opts.remaining,
    log: () => {},
  };
  return { deps, calls, events };
}

describe('attemptForkBaseInheritance', () => {
  it('combines measured upstream workspace lints with measured failing files before coverage checks', async () => {
    const lint = `${OC} :: lint:condition-rail`;
    const { deps, events } = fakeDeps({});
    deps.inheritGateLegs = entries => inheritUpstreamGateLegs({
      failingTests: entries, upstreamInstall: 'papercusp', workspaceId: 'test', nowMs: 1000,
      read: async () => ({ failingTestsMeasured: true, failingTests: [lint], observedAt: 900 }),
    });
    const out = await attemptForkBaseInheritance(input({ failingTests: [...input().failingTests, lint] }), deps);
    expect(out.status).toBe('inherited');
    expect(out.decision?.inheritedEntries).toContain(lint);
    expect(out.decision?.blockingEntries).toEqual([]);
    expect(events.filter(e => e.startsWith('run:'))).toEqual(['run:lib/a.test.ts', 'run:lib/b.test.ts']);
    expect(events.at(-2)).toBe('checkout:candidate:lib/a.ts,lib/new.ts');
  });

  it.each(['new', 'unmeasured', 'stale', 'read-error'] as const)(
    'keeps a %s upstream non-test claim blocking without touching the checkout', async kind => {
      const lint = `${OC} :: lint:condition-rail`;
      const { deps, calls } = fakeDeps({});
      deps.inheritGateLegs = entries => inheritUpstreamGateLegs({
        failingTests: entries, upstreamInstall: 'papercusp', workspaceId: 'test', nowMs: 1000, maxAgeMs: 100,
        read: async () => {
          if (kind === 'read-error') throw new Error('unavailable');
          return { failingTestsMeasured: kind !== 'unmeasured', failingTests: kind === 'new' ? [] : [lint],
            observedAt: kind === 'stale' ? 1 : 950 };
        },
      });
      const out = await attemptForkBaseInheritance(input({ failingTests: [...input().failingTests, lint] }), deps);
      expect(out).toMatchObject({ status: 'skipped', reason: `uncovered-entry:${lint}` });
      expect(calls).toEqual([]);
    },
  );

  it('still blocks a file that passes at base when its accompanying lint is inherited', async () => {
    const lint = `${OC} :: lint:condition-rail`;
    const { deps } = fakeDeps({ passAtBase: ['lib/b.test.ts'] });
    deps.inheritGateLegs = entries => inheritUpstreamGateLegs({
      failingTests: entries, upstreamInstall: 'papercusp', workspaceId: 'test', nowMs: 1000,
      read: async () => ({ failingTestsMeasured: true, failingTests: [lint, 'lib/b.test.ts'], observedAt: 900 }),
    });
    const out = await attemptForkBaseInheritance(input({ failingTests: [...input().failingTests, lint] }), deps);
    expect(out.status).toBe('blocking');
    expect(out.decision?.blockingFiles).toEqual([`${OC}::lib/b.test.ts`]);
    expect(out.decision?.inheritedEntries).toContain(lint);
  });

  it('overlays the delta at base, re-runs every file, then restores the candidate', async () => {
    const { deps, events } = fakeDeps({});
    const out = await attemptForkBaseInheritance(input(), deps);
    expect(out.status).toBe('inherited');
    expect(out.line).toMatch(/^FORK_BASE_INHERITED status=inherited blocking=0 blockingFiles=0 inherited=2 base=bbbbbbbbbbbb/);
    expect(events).toEqual([
      'checkout:base:lib/a.ts,lib/gone.ts',
      'rm:rm:lib/new.ts',
      'run:lib/a.test.ts',
      'run:lib/b.test.ts',
      'checkout:candidate:lib/a.ts,lib/new.ts',
      'rm:rm:lib/gone.ts',
    ]);
  });

  it("blocks on the fork's own new failure: a file that passes at base", async () => {
    const { deps } = fakeDeps({ passAtBase: ['lib/b.test.ts'] });
    const out = await attemptForkBaseInheritance(input(), deps);
    expect(out.status).toBe('blocking');
    expect(out.decision?.blockingFiles).toEqual([`${OC}::lib/b.test.ts`]);
  });

  it('treats a crashed re-run as blocking and still restores the candidate', async () => {
    const { deps, events } = fakeDeps({ throwOn: ['lib/a.test.ts'] });
    const out = await attemptForkBaseInheritance(input(), deps);
    expect(out.status).toBe('blocking');
    expect(events.slice(-2)).toEqual(['checkout:candidate:lib/a.ts,lib/new.ts', 'rm:rm:lib/gone.ts']);
  });

  it('reports a restore that does not converge so the caller can refuse to judge the tree', async () => {
    const { deps } = fakeDeps({ dirtyAfterRestore: true });
    const out = await attemptForkBaseInheritance(input(), deps);
    expect(out.status).toBe('skipped');
    expect(out.restoreFailure).toMatch(/still differ/);
  });

  it('stops starting re-runs when the ceiling gets close; unrun files block', async () => {
    let left = FORK_BASE_INHERITANCE_MIN_START_MS;
    const { deps, events } = fakeDeps({
      remaining: () => {
        const now = left;
        left = FORK_BASE_INHERITANCE_STOP_STARTING_MS - 1;
        return now;
      },
    });
    const out = await attemptForkBaseInheritance(input(), deps);
    expect(out.status).toBe('blocking');
    expect(events.filter((e) => e.startsWith('run:'))).toEqual([]);
    expect(out.reason).toContain('not-run=2');
  });

  it.each([
    ['no-upstream-install', { upstreamInstall: null }],
    ['no-upstream-ref', { upstreamRef: 'refs/heads/staging' }],
    ['base-is-candidate', { base: CAND }],
    ['tree-not-checkpoint-root', { treeIsCheckpointRoot: false }],
    ['no-located-files', { failingFiles: [] }],
    ['suite-timedOutTasks=1', { suiteOutput: FAILED_RESULT.replace('timedOutTasks=0', 'timedOutTasks=1') }],
    ['uncovered-entry:@papercusp/desktop :: test', { failingTests: ['lib/a.test.ts', '@papercusp/desktop :: test'] }],
  ] as const)('skips without touching git: %s', async (reason, over) => {
    const { deps, calls } = fakeDeps({});
    const out = await attemptForkBaseInheritance(input(over as Partial<ForkBaseInheritanceInput>), deps);
    expect(out).toMatchObject({ status: 'skipped', reason });
    expect(calls).toEqual([]);
  });

  it('skips when too little of the run is left to start', async () => {
    const { deps, calls } = fakeDeps({ remaining: () => FORK_BASE_INHERITANCE_MIN_START_MS - 1 });
    const out = await attemptForkBaseInheritance(input(), deps);
    expect(out.reason).toMatch(/^insufficient-time-remaining:/);
    expect(calls).toEqual([]);
  });

  it('refuses a base that is not upstream content, before any overlay', async () => {
    const { deps, events } = fakeDeps({ ancestorUpstream: false });
    const out = await attemptForkBaseInheritance(input(), deps);
    expect(out.reason).toBe('base-not-upstream-content');
    expect(events).toEqual([]);
  });
});

// ── the overlay against a real git repository ────────────────────────────────────────────────

describe('attemptForkBaseInheritance over a real checkout', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('presents exactly the base content while re-running, and the candidate content after', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'fork-base-overlay-'));
    dirs.push(repo);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
      }).trim();
    const lock = (flag: string) => `{\n  "packages": {\n    "node_modules/x": {\n      "version": "1.0.0",\n      "${flag}": true\n    }\n  }\n}\n`;
    git('init', '-q');
    writeFileSync(path.join(repo, 'a.ts'), 'base a\n');
    writeFileSync(path.join(repo, 'gone.ts'), 'base gone\n');
    writeFileSync(path.join(repo, 'package-lock.json'), lock('dev'));
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/staging', base);
    writeFileSync(path.join(repo, 'a.ts'), 'fork a\n');
    writeFileSync(path.join(repo, 'new.ts'), 'fork new\n');
    rmSync(path.join(repo, 'gone.ts'));
    writeFileSync(path.join(repo, 'package-lock.json'), lock('devOptional'));
    git('add', '-A');
    git('commit', '-q', '-m', 'fork delta');
    const candidate = git('rev-parse', 'HEAD');

    const seen: Array<Record<string, string | null>> = [];
    const read = (p: string) => (existsSync(path.join(repo, p)) ? readFileSync(path.join(repo, p), 'utf8') : null);
    const out = await attemptForkBaseInheritance(
      {
        suiteOutput: FAILED_RESULT,
        failingTests: [`${OC} :: test:lane-pure`, 'lib/a.test.ts'],
        failingFiles: [A],
        base,
        candidate,
        upstreamInstall: 'papercusp',
        upstreamRef: 'refs/remotes/origin/staging',
        treeIsCheckpointRoot: true,
      },
      {
        async git(args) {
          try {
            return { code: 0, stdout: execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }) };
          } catch (e) {
            return { code: (e as { status?: number }).status ?? 1, stdout: '' };
          }
        },
        async runFile(f) {
          seen.push({ a: read('a.ts'), new: read('new.ts'), gone: read('gone.ts'), lock: read('package-lock.json') });
          return { workspace: f.workspace, file: f.file, passed: false };
        },
        log: () => {},
      },
    );

    expect(out.status).toBe('inherited');
    expect(seen).toEqual([{ a: 'base a\n', new: null, gone: 'base gone\n', lock: lock('dev') }]);
    expect(read('a.ts')).toBe('fork a\n');
    expect(read('new.ts')).toBe('fork new\n');
    expect(read('gone.ts')).toBeNull();
    expect(git('rev-parse', 'HEAD')).toBe(candidate);
    expect(git('status', '--porcelain=v1', '--untracked-files=all')).toBe('');
  });
});
