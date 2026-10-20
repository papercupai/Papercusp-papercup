/**
 * P-028 (green-main-cycle-time-2026-10-08): repo-wide lint guards per git-sync batch.
 * Pure tests against `SyncLintGuardDeps` fakes, plus the pin that keeps the guard list
 * equal to the gate's `lowMemoryLintSpecs`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CoverageTick, RedFinding, SyncBatch } from './sync-batch-delta-check';
import {
  classifyGuardRun,
  diffGuardViolations,
  guardExcerpt,
  LINT_GUARDS_COVERAGE_ALARM_SUBJECT,
  LINT_GUARDS_JUDGE_DEADLINE_MS,
  lintGuardCoverageTick,
  parseGuardOffenders,
  runSyncLintGuardTick,
  SYNC_LINT_GUARD_SCRIPTS,
  type GuardRun,
  type SyncLintGuardDeps,
  type SyncLintGuardScript,
  type SyncLintGuardState,
} from './sync-batch-lint-guards';

const ROOT = '/repo/root';
const REPO = join(__dirname, '..', '..', '..', '..');

describe('guard list pin', () => {
  it('equals the gate lowMemoryLintSpecs scripts, in order', () => {
    const src = readFileSync(join(REPO, 'apps/operator/lib/release/green-checkpoint.ts'), 'utf8');
    const start = src.indexOf('const lowMemoryLintSpecs');
    expect(start, 'lowMemoryLintSpecs not found in green-checkpoint.ts').toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('];', start));
    const gate = [...block.matchAll(/script:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(gate.length).toBeGreaterThan(0);
    expect([...SYNC_LINT_GUARD_SCRIPTS]).toEqual(gate);
  });
});

describe('classifyGuardRun', () => {
  it('exit 0 is pass and a plain non-zero exit is fail', () => {
    expect(classifyGuardRun({ exitCode: 0, output: '✓ clean' })).toBe('pass');
    expect(classifyGuardRun({ exitCode: 1, output: '✗ NEW bare setInterval() call(s)\n  apps/a/b.ts' })).toBe('fail');
  });
  it('does not treat incomplete design-lint runner output as a source violation', () => {
    const runnerOnly = [
      'COMMITTED_SOURCE substituted scripts/npm-install-safe.mjs: working tree differs from HEAD; entry scripts/test-files.mjs',
      'TEST_FILE_SCOPE_PREFLIGHT {"ok":true}',
      'TEST_FILE_LIST_PROGRESS state=started cwd="apps/operator" elapsedMs=9 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending',
    ].join('\n');
    expect(classifyGuardRun({ exitCode: 1, output: runnerOnly }, 'lint:design-primitives')).toBe('undetermined');
    expect(parseGuardOffenders(runnerOnly, ROOT, 'lint:design-primitives')).toEqual([]);

    const assertion = `TEST_FILE_ASSERTION_FAILURE file="${ROOT}/apps/operator/app/_lints/design-primitives.test.ts" name="blocks native tables" message=${JSON.stringify('Native <table> found in unapproved files:\n  operator/app/example.tsx\n\nUse the shared primitive.')}`;
    const actualLintFailure = `${runnerOnly}\n${assertion}`;
    expect(classifyGuardRun({ exitCode: 1, output: actualLintFailure }, 'lint:design-primitives')).toBe('fail');
    expect(parseGuardOffenders(actualLintFailure, ROOT, 'lint:design-primitives')).toEqual(['apps/operator/app/example.tsx']);
  });
  it('treats a JSON-escaped runner stack in a design-lint assertion as undetermined', () => {
    const testFile = `${ROOT}/apps/operator/app/_lints/design-primitives.test.ts`;
    const stack = `Error: STACK_TRACE_ERROR\n    at task (${testFile}:100:1)`;
    const output = `TEST_FILE_ASSERTION_FAILURE file=${JSON.stringify(testFile)} ` +
      `name=${JSON.stringify('blocks new native <select> controls in app UI')} message=${JSON.stringify(stack)}`;

    expect(output).not.toContain('\n    at task (');
    expect(classifyGuardRun({ exitCode: 1, output }, 'lint:design-primitives')).toBe('undetermined');
    expect(parseGuardOffenders(output, ROOT, 'lint:design-primitives')).toEqual([]);
  });
  it('timeouts, spawn failures, crashes and environment faults are undetermined', () => {
    expect(classifyGuardRun({ exitCode: null, output: '' })).toBe('undetermined');
    expect(
      classifyGuardRun({ exitCode: 1, output: '', diagnostic: { outcome: 'timeout', durationMs: 1, exitCode: null } }),
    ).toBe('undetermined');
    const crash = 'Error: boom\n    at WorkItemAdmissionQueueDriver.admit (/repo/root/packages/x/queue.ts:788:13)\n';
    expect(classifyGuardRun({ exitCode: 1, output: crash })).toBe('undetermined');
    expect(classifyGuardRun({ exitCode: 1, output: 'connect ECONNREFUSED 127.0.0.1:6432' })).toBe('undetermined');
    expect(classifyGuardRun({ exitCode: 1, output: 'npm error Missing script: "lint:x"' })).toBe('undetermined');
  });
});

describe('parseGuardOffenders', () => {
  it('reads the path formats the real guards print', () => {
    const out = [
      '❌ mock-cast-escape per-file ratchet exceeded in 2 file(s) (+2).',
      '   packages/operator-core/lib/acceptance-grader.test.ts: 1 > 0 (+1)',
      '     L161: deps.resolveTarget.mockResolvedValue({ ...target } as never);',
      '  docs/evidence/receipt-2026-10-13.json:33  [build-hostname]',
      '    apps/operator/e2e/_keyboard-input.ts',
      `    at fn (${ROOT}/packages/x/abs.ts:1:2)`,
      '  see check-no-owner-name-tags.mjs and ../relative/thing.ts and node_modules/a/b.js',
      '  app/api/[[...route]]/route.ts',
    ].join('\n');
    expect(parseGuardOffenders(out, ROOT)).toEqual([
      'packages/operator-core/lib/acceptance-grader.test.ts',
      'docs/evidence/receipt-2026-10-13.json',
      'apps/operator/e2e/_keyboard-input.ts',
      'packages/x/abs.ts',
      'app/api/[[...route]]/route.ts',
    ]);
  });

  it('uses identity-lint diagnostic headers, not paths inside matched source excerpts', () => {
    const out = [
      '  docs/evidence/green-main-materialized-dependencies-preparation-20261014.json:57  [build-user-name]',
      '      { "scope": "scripts/source-preview.d.mts only; .mjs is outside scripts compiler program", "exitCode": 0 }',
      '  docs/evidence/green-main-ordered-chain-preparation-20261014.json:28  [build-user-name]',
    ].join('\n');

    expect(parseGuardOffenders(out, ROOT, 'lint:no-identity-literals')).toEqual([
      'docs/evidence/green-main-materialized-dependencies-preparation-20261014.json',
      'docs/evidence/green-main-ordered-chain-preparation-20261014.json',
    ]);
  });

  it('uses owner-name-tag diagnostic headers, not paths in the explanation or source excerpts', () => {
    const bracketTag = ['[owner', ':Person …]'].join('');
    const parentheticalTag = 'OWNER … (Person, …)';
    const out = [
      '✗ 2 named provenance tags in shipped source (bin/audit-release-bundle.py)',
      '  docs/evidence/owner-name-tag-output.md:79  ' + bracketTag,
      '      **Source turn:** ' + bracketTag + ' appears in this excerpt',
      '  docs/evidence/other-owner-name-tag-output.md:1991  ' + parentheticalTag,
      '      another excerpt mentioning docs/evidence/unrelated.md',
    ].join('\n');

    expect(parseGuardOffenders(out, ROOT, 'lint:no-owner-name-tags')).toEqual([
      'docs/evidence/owner-name-tag-output.md',
      'docs/evidence/other-owner-name-tag-output.md',
    ]);
  });

  it('uses box-identity diagnostic headers, not paths inside matched source excerpts', () => {
    const out = [
      '✗ 1 hardcoded home path(s) in tracked source.',
      '  docs/evidence/green-main-materialized-dependencies-preparation-20261014.json:57  (user "build-user-name")',
      '      { "scope": "scripts/source-preview.d.mts only; .mjs is outside scripts compiler program", "exitCode": 0, "log": "~/.papercusp/scratch/check.log" }',
    ].join('\n');

    expect(parseGuardOffenders(out, ROOT, 'lint:no-box-identity')).toEqual([
      'docs/evidence/green-main-materialized-dependencies-preparation-20261014.json',
    ]);
  });

  it('uses structured assertion paths instead of committed-source instrumentation paths', () => {
    const failedFile = `${ROOT}/apps/operator/app/settings/storage/page.tsx`;
    const out = [
      'COMMITTED_SOURCE substituted packages/coordination/src/presence/pg-store.ts: the working tree differs from HEAD',
      `TEST_FILE_ASSERTION_FAILURE file=${JSON.stringify(failedFile)} name="design primitive assertion" message="expected token"`,
      'TEST_FILE_RESULT requested=3 executed=3 matched=3 status=failed skippedTests=0',
    ].join('\n');

    expect(parseGuardOffenders(out, ROOT)).toEqual(['apps/operator/app/settings/storage/page.tsx']);
  });

  it('routes design lint to the files listed in its assertion message, not the lint test or loader', () => {
    const message = 'Error: Native <table> found in unapproved files:\n' +
      '  operator/app/settings/storage/page.tsx\n  operator-vite/src/example.tsx\n\n' +
      'Use the shared primitive.\n    at warnOrFail (/repo/root/apps/operator/app/_lints/design-primitives.test.ts:699:9)';
    const assertion = `TEST_FILE_ASSERTION_FAILURE file="${ROOT}/apps/operator/app/_lints/design-primitives.test.ts" name="blocks native tables" message=${JSON.stringify(message)}`;
    const output = 'COMMITTED_SOURCE substituted scripts/npm-install-safe.mjs: working tree differs\n' +
      'COMMITTED_SOURCE substituted apps/operator/app/settings/storage/page.tsx: working tree differs\n' + assertion;
    expect(parseGuardOffenders(output, ROOT, 'lint:design-primitives')).toEqual([
      'apps/operator/app/settings/storage/page.tsx',
      'apps/operator-vite/src/example.tsx',
    ]);
    expect(guardExcerpt(output, 'apps/operator/app/settings/storage/page.tsx')[0]).toBe(assertion);
  });

  it('does not blame the design lint test when its offender list is unavailable or malformed', () => {
    const head = `TEST_FILE_ASSERTION_FAILURE file="${ROOT}/apps/operator/app/_lints/design-primitives.test.ts" name="blocks native tables"`;
    for (const message of ['message="unexpected assertion"', 'message="bad JSON', 'message="Error: Native <table> found in unapproved files:\\n  ../outside.tsx\\n\\nHint"']) {
      expect(parseGuardOffenders(`${head} ${message}`, ROOT, 'lint:design-primitives')).toEqual([]);
    }
  });
});

describe('diffGuardViolations', () => {
  const rec = (status: 'pass' | 'fail', offenders: string[], extra = {}) => ({ status, offenders, sha: 'a', atMs: 1, ...extra });
  const s: SyncLintGuardScript = 'lint:no-raw-setinterval';
  it('a first measurement is a baseline and files nothing', () => {
    expect(diffGuardViolations(s, undefined, 'fail', ['x/y.ts'])).toEqual([]);
  });
  it('pass -> fail files every named path, or one unattributed flip', () => {
    expect(diffGuardViolations(s, rec('pass', []), 'fail', ['x/y.ts'])).toEqual([{ script: s, path: 'x/y.ts' }]);
    expect(diffGuardViolations(s, rec('pass', []), 'fail', [])).toEqual([{ script: s, path: null }]);
  });
  it('fail -> fail files only paths the guard did not name before', () => {
    expect(diffGuardViolations(s, rec('fail', ['old/a.ts']), 'fail', ['old/a.ts', 'new/b.ts'])).toEqual([
      { script: s, path: 'new/b.ts' },
    ]);
    expect(diffGuardViolations(s, rec('fail', ['old/a.ts'], { offendersTruncated: true }), 'fail', ['new/b.ts'])).toEqual(
      [],
    );
  });
  it('pass and undetermined never file', () => {
    expect(diffGuardViolations(s, rec('pass', []), 'pass', [])).toEqual([]);
    expect(diffGuardViolations(s, rec('pass', []), 'undetermined', [])).toEqual([]);
  });
});

// ── the tick, end to end against fakes ──────────────────────────────────────

interface Fake {
  deps: SyncLintGuardDeps;
  state: { value: SyncLintGuardState | null };
  filed: RedFinding[];
  guardCalls: string[];
}

function fake(opts: {
  head: string;
  prior?: SyncLintGuardState | null;
  runs?: Partial<Record<SyncLintGuardScript, GuardRun>>;
  batches?: SyncBatch[];
  editors?: Array<{ file: string; agent: string; tsMs: number }>;
  load1?: number;
  refuseAssignee?: string;
  now?: () => number;
}): Fake {
  const state = { value: opts.prior ?? null };
  const filed: RedFinding[] = [];
  const guardCalls: string[] = [];
  const deps: SyncLintGuardDeps = {
    repoRoot: ROOT,
    hostLoad: () => ({ load1: opts.load1 ?? 10, cores: 100 }),
    greenCheckpointRunning: async () => false,
    headSha: async () => opts.head,
    listBatches: async () => opts.batches ?? [],
    lookupEditors: async (files) => (opts.editors ?? []).filter((e) => files.includes(e.file)),
    fileRed: async (finding) => {
      if (finding.assignee && finding.assignee === opts.refuseAssignee) return { ok: false, error: 'unknown owner' };
      filed.push(finding);
      return { ok: true, id: `WI-${filed.length}` };
    },
    readGuardState: async () => state.value,
    writeGuardState: async (next) => {
      state.value = next;
    },
    runGuard: async (script) => {
      guardCalls.push(script);
      return opts.runs?.[script] ?? { exitCode: 0, output: 'clean' };
    },
    now: opts.now ?? (() => 1_000_000),
    log: () => {},
  };
  return { deps, state, filed, guardCalls };
}

const allPass = (sha: string): SyncLintGuardState => ({
  sha,
  atMs: 500_000,
  guards: Object.fromEntries(
    SYNC_LINT_GUARD_SCRIPTS.map((s) => [s, { status: 'pass' as const, offenders: [], sha, atMs: 500_000 }]),
  ),
});

const setIntervalRed = (paths: string[]): GuardRun => ({
  exitCode: 1,
  output: ['✗ NEW bare setInterval() call(s) outside the scheduled-registry:', ...paths.map((p) => `    ${p}`)].join('\n'),
});

describe('runSyncLintGuardTick', () => {
  it('bootstraps every guard and files nothing on its first run', async () => {
    const f = fake({ head: 'h1', runs: { 'lint:no-raw-setinterval': setIntervalRed(['apps/old/timer.ts']) } });
    const r = await runSyncLintGuardTick(f.deps);
    expect(r.status).toBe('bootstrapped');
    expect(f.filed).toEqual([]);
    expect(f.guardCalls).toHaveLength(SYNC_LINT_GUARD_SCRIPTS.length);
    expect(f.state.value?.guards['lint:no-raw-setinterval']).toMatchObject({ status: 'fail', offenders: ['apps/old/timer.ts'] });
  });

  it('a seeded violation is filed, attributed and routed to its author (the P-028 bar)', async () => {
    const batch: SyncBatch = { sha: 'b2', committedAtMs: 900_000, agent: 'su-trailer', paths: ['apps/new/timer.ts'] };
    const f = fake({
      head: 'h2',
      prior: allPass('h1'),
      runs: { 'lint:no-raw-setinterval': setIntervalRed(['apps/new/timer.ts']) },
      batches: [batch],
      editors: [{ file: 'apps/new/timer.ts', agent: 'su-author', tsMs: 950_000 }],
    });
    const r = await runSyncLintGuardTick(f.deps);
    expect(r.status).toBe('measured');
    expect(f.filed).toHaveLength(1);
    expect(f.filed[0]).toMatchObject({
      conditionKey: 'sync-delta-guard:lint:no-raw-setinterval:apps/new/timer.ts',
      assignee: 'su-author',
      authorSource: 'edit-ledger:failing-file',
    });
    expect(f.filed[0]!.body).toContain('Batch that touched it: b2');
    expect(f.state.value?.guards['lint:no-raw-setinterval']).toMatchObject({ status: 'fail', offenders: ['apps/new/timer.ts'], sha: 'h2' });

    // The same offender on the next tick is no longer new.
    const again = fake({ head: 'h3', prior: f.state.value, runs: { 'lint:no-raw-setinterval': setIntervalRed(['apps/new/timer.ts']) } });
    await runSyncLintGuardTick(again.deps);
    expect(again.filed).toEqual([]);
  });

  it('routes by the batch trailer when the edit ledger is silent, and re-files unassigned on a refused owner', async () => {
    const batch: SyncBatch = { sha: 'b2', committedAtMs: 900_000, agent: 'su-gone', paths: ['apps/new/timer.ts'] };
    const f = fake({
      head: 'h2',
      prior: allPass('h1'),
      runs: { 'lint:no-raw-setinterval': setIntervalRed(['apps/new/timer.ts']) },
      batches: [batch],
      refuseAssignee: 'su-gone',
    });
    const r = await runSyncLintGuardTick(f.deps);
    expect(f.filed).toHaveLength(1);
    expect(f.filed[0]!.assignee).toBeNull();
    expect(r.filed[0]).toMatchObject({ authorSource: 'trailer', assignee: null });
  });

  it('routes the real design-lint record to the UI editor and retains assertion evidence', async () => {
    const path = 'apps/operator/app/settings/storage/page.tsx';
    const message = 'Error: Native <table> found in unapproved files:\n  operator/app/settings/storage/page.tsx\n\nUse the shared primitive.';
    const assertion = `TEST_FILE_ASSERTION_FAILURE file="${ROOT}/apps/operator/app/_lints/design-primitives.test.ts" name="blocks new native tables" message=${JSON.stringify(message)}`;
    const f = fake({
      head: 'h2', prior: allPass('h1'),
      runs: { 'lint:design-primitives': { exitCode: 1, output: `COMMITTED_SOURCE substituted scripts/npm-install-safe.mjs: working tree differs\n${assertion}` } },
      editors: [
        { file: path, agent: 'su-ui-editor', tsMs: 950_000 },
        { file: 'scripts/npm-install-safe.mjs', agent: 'su-wrapper-editor', tsMs: 950_000 },
      ],
    });
    await runSyncLintGuardTick(f.deps);
    expect(f.filed).toHaveLength(1);
    expect(f.filed[0]).toMatchObject({
      conditionKey: `sync-delta-guard:lint:design-primitives:${path}`,
      assignee: 'su-ui-editor', authorSource: 'edit-ledger:failing-file',
    });
    expect(f.filed[0].body).toContain('TEST_FILE_ASSERTION_FAILURE');
    expect(f.filed[0].body).not.toContain('COMMITTED_SOURCE');
    expect(f.state.value?.guards['lint:design-primitives']?.offenders).toEqual([path]);
  });

  it.each([undefined, 'wake not queued'])('reports the adopted holder even when notification is %s', async notificationError => {
    const f = fake({ head: 'h2', prior: allPass('h1'),
      runs: { 'lint:no-raw-setinterval': setIntervalRed(['apps/new/timer.ts']) },
      editors: [{ file: 'apps/new/timer.ts', agent: 'su-proposed-author', tsMs: 900_000 }],
    });
    f.deps.fileRed = async () => ({ ok: true, id: 'WI-adopted', adopted: true,
      assignee: 'su-existing-holder', ...(notificationError ? { notificationError } : {}) });
    const result = await runSyncLintGuardTick(f.deps);
    expect(result.filed[0]).toMatchObject({ id: 'WI-adopted', adopted: true,
      assignee: 'su-existing-holder', authorSource: 'edit-ledger:failing-file' });
    expect(result.deferred).toHaveLength(notificationError ? 1 : 0);
  });

  it('an undetermined guard keeps its prior record and files nothing', async () => {
    const prior = allPass('h1');
    const f = fake({
      head: 'h2',
      prior,
      runs: {
        'lint:condition-rail': { exitCode: 1, output: 'Error: x\n    at f (/repo/root/packages/a/q.ts:1:1)' },
      },
    });
    const r = await runSyncLintGuardTick(f.deps);
    expect(r.verdicts['lint:condition-rail']).toBe('undetermined');
    expect(f.filed).toEqual([]);
    expect(f.state.value?.guards['lint:condition-rail']).toEqual(prior.guards['lint:condition-rail']);
  });

  it('retries an undetermined guard at the same head before declaring the batch complete', async () => {
    const f = fake({
      head: 'h2', prior: allPass('h1'),
      runs: { 'lint:condition-rail': { exitCode: null, output: 'timed out' } },
    });
    await runSyncLintGuardTick(f.deps);
    f.deps.runGuard = async () => ({ exitCode: 0, output: 'clean' });
    const retry = await runSyncLintGuardTick(f.deps);
    expect(retry.status).toBe('measured');
    expect(retry.state?.guards['lint:condition-rail']).toMatchObject({ status: 'pass', sha: 'h2' });
    expect((await runSyncLintGuardTick(f.deps)).status).toBe('up-to-date');
  });

  it('retries a refused finding without requiring another commit', async () => {
    const f = fake({ head: 'h2', prior: allPass('h1'),
      runs: { 'lint:no-raw-setinterval': setIntervalRed(['apps/new/timer.ts']) } });
    const fileRed = f.deps.fileRed;
    f.deps.fileRed = async () => ({ ok: false, error: 'store unavailable' });
    expect((await runSyncLintGuardTick(f.deps)).deferred).toHaveLength(1);
    f.deps.fileRed = fileRed;
    const retry = await runSyncLintGuardTick(f.deps);
    expect(retry.filed).toHaveLength(1);
    expect(retry.filed[0]).toMatchObject({ path: 'apps/new/timer.ts', id: 'WI-1' });
    expect((await runSyncLintGuardTick(f.deps)).status).toBe('up-to-date');
  });

  it('keeps a filed red pending until its notification succeeds at the same head', async () => {
    const f = fake({ head: 'h2', prior: allPass('h1'),
      runs: { 'lint:no-raw-setinterval': setIntervalRed(['apps/new/timer.ts']) } });
    f.deps.fileRed = async () => ({ ok: true, id: 'WI-1', notificationError: 'wake not queued' });
    const first = await runSyncLintGuardTick(f.deps);
    expect(first.filed[0]).toMatchObject({ id: 'WI-1', notificationError: 'wake not queued' });
    expect(first.deferred).toHaveLength(1);
    expect(first.state?.guards['lint:no-raw-setinterval']?.sha).toBe('h1');
    f.deps.fileRed = async () => ({ ok: true, id: 'WI-1', adopted: true });
    const retry = await runSyncLintGuardTick(f.deps);
    expect(retry.filed[0]).toMatchObject({ id: 'WI-1', adopted: true });
    expect(retry.deferred).toHaveLength(0);
    expect((await runSyncLintGuardTick(f.deps)).status).toBe('up-to-date');
  });

  it('does not re-run guards when the tip has not moved', async () => {
    const same = fake({ head: 'h1', prior: allPass('h1') });
    expect((await runSyncLintGuardTick(same.deps)).status).toBe('up-to-date');
    expect(same.guardCalls).toEqual([]);
  });

  // green-main-ratchet-convergence-2026-10-17 P-009 / R-8 falsifier (1): load never skips
  // the guards. The measured pre-change state was a skip at load 384.91 > 384 (cores x 3).
  it('runs every guard above the hard load ceiling and when load is unreadable (no load skip)', async () => {
    const loaded = fake({ head: 'h2', prior: allPass('h1'), load1: 10_000 });
    const logs: string[] = [];
    loaded.deps.log = (m) => logs.push(m);
    const r = await runSyncLintGuardTick(loaded.deps);
    expect(r.status).toBe('measured');
    expect(loaded.guardCalls).toHaveLength(SYNC_LINT_GUARD_SCRIPTS.length);
    expect(loaded.state.value?.sha).toBe('h2');
    expect(loaded.state.value?.lastSkipReason).toBeUndefined();
    expect(logs.some((m) => /running under load: .*hard ceiling/.test(m))).toBe(true);

    const blind = fake({ head: 'h2', prior: allPass('h1') });
    blind.deps.hostLoad = () => null;
    const b = await runSyncLintGuardTick(blind.deps);
    expect(b.status).toBe('measured');
    expect(blind.guardCalls).toHaveLength(SYNC_LINT_GUARD_SCRIPTS.length);
  });

  it('caps filings per tick and files the deferred offender on the next tick', async () => {
    const f = fake({
      head: 'h2',
      prior: allPass('h1'),
      runs: { 'lint:no-raw-setinterval': setIntervalRed(['apps/a/one.ts', 'apps/b/two.ts']) },
    });
    const r = await runSyncLintGuardTick(f.deps, { maxFilings: 1 });
    expect(f.filed.map((x) => x.conditionKey)).toEqual(['sync-delta-guard:lint:no-raw-setinterval:apps/a/one.ts']);
    expect(r.deferred).toEqual([{ script: 'lint:no-raw-setinterval', path: 'apps/b/two.ts' }]);

    const next = fake({
      head: 'h2',
      prior: f.state.value,
      runs: { 'lint:no-raw-setinterval': setIntervalRed(['apps/a/one.ts', 'apps/b/two.ts']) },
    });
    await runSyncLintGuardTick(next.deps, { maxFilings: 1 });
    expect(next.filed.map((x) => x.conditionKey)).toEqual(['sync-delta-guard:lint:no-raw-setinterval:apps/b/two.ts']);
  });
});

// ── coverage (green-main-ratchet-convergence-2026-10-17 P-009 / R-8 falsifiers 2 and 3) ──

describe('lint-guard coverage', () => {
  const MIN = 60_000;
  const T0 = 1_800_000_000_000;
  /** `count` five-minute slots ending one slot before `endMs`; every `badEvery`-th unjudged. */
  const history = (endMs: number, count: number, badEvery: number | null): CoverageTick[] =>
    Array.from({ length: count }, (_, i) => {
      const atMs = endMs - (count - i) * 5 * MIN;
      const bad = badEvery !== null && i % badEvery === 0;
      return bad
        ? { atMs, evaluated: false, status: 'skipped' as const, reason: 'git-unreadable' }
        : { atMs, evaluated: true, status: 'up-to-date' as const };
    });
  /** A clock that reads `startMs` at the tick's start and `endMs` afterwards. */
  const clock = (startMs: number, endMs: number) => {
    let calls = 0;
    return () => (calls++ === 0 ? startMs : endMs);
  };
  const isAlarm = (f: RedFinding) => f.conditionKey === LINT_GUARDS_COVERAGE_ALARM_SUBJECT.conditionKey;

  it('a fully measured tick and an up-to-date tick each record one judged slot', async () => {
    const f = fake({ head: 'h2', prior: allPass('h1'), now: () => T0 });
    await runSyncLintGuardTick(f.deps);
    expect(f.state.value?.coverage?.ticks).toEqual([{ atMs: T0, evaluated: true, status: 'measured' }]);

    const later = fake({ head: 'h2', prior: f.state.value, now: () => T0 + 5 * MIN });
    expect((await runSyncLintGuardTick(later.deps)).status).toBe('up-to-date');
    expect(later.state.value?.coverage?.ticks.map((t) => [t.status, t.evaluated])).toEqual([
      ['measured', true],
      ['up-to-date', true],
    ]);
  });

  it('a measuring tick keeps the coverage history it inherited', async () => {
    const prior = { ...allPass('h1'), coverage: { ticks: history(T0, 10, null) } };
    const f = fake({ head: 'h2', prior, now: () => T0 });
    await runSyncLintGuardTick(f.deps);
    expect(f.state.value?.coverage?.ticks).toHaveLength(11);
  });

  it('keeps its own fixed 30-minute credit deadline, not the delta check derived one (D-031)', async () => {
    expect(LINT_GUARDS_JUDGE_DEADLINE_MS).toBe(30 * MIN);
    expect(LINT_GUARDS_COVERAGE_ALARM_SUBJECT.judgeDeadlineMs).toBe(LINT_GUARDS_JUDGE_DEADLINE_MS);
    const timedOut: GuardRun = { exitCode: null, output: 'timed out after 600000ms' };
    const f = fake({ head: 'h2', prior: allPass('h1'), runs: { 'lint:guard-reachability': timedOut }, now: () => T0 });
    await runSyncLintGuardTick(f.deps);
    // Measured 40 minutes later: inside the delta check's 135 min, outside this routine's 30.
    const late = fake({ head: 'h3', prior: f.state.value, now: () => T0 + 40 * MIN });
    await runSyncLintGuardTick(late.deps);
    const first = (late.state.value?.coverage?.ticks ?? [])[0];
    expect(first).toMatchObject({ atMs: T0, status: 'partial', evaluated: false });
    expect(first?.judgedAtMs).toBeUndefined();
  });

  it('a tick where a guard gave no verdict is partial (not judged), and a later full tick credits it', async () => {
    const timedOut: GuardRun = { exitCode: null, output: 'timed out after 600000ms' };
    const f = fake({ head: 'h2', prior: allPass('h1'), runs: { 'lint:guard-reachability': timedOut }, now: () => T0 });
    const r = await runSyncLintGuardTick(f.deps);
    expect(r.status).toBe('measured');
    expect(f.state.value?.coverage?.ticks).toEqual([
      { atMs: T0, evaluated: false, status: 'partial', reason: 'undetermined: lint:guard-reachability' },
    ]);

    // Ten minutes later the guard is measured: the partial slot was judged within 30 minutes.
    const retry = fake({ head: 'h2', prior: f.state.value, now: () => T0 + 10 * MIN });
    await runSyncLintGuardTick(retry.deps);
    const ticks = retry.state.value?.coverage?.ticks ?? [];
    expect(ticks[0]).toMatchObject({ atMs: T0, status: 'partial', evaluated: true, judgedAtMs: T0 + 10 * MIN });
    expect(ticks.at(-1)).toMatchObject({ atMs: T0 + 10 * MIN, status: 'measured', evaluated: true });
  });

  it('slots missed during a long tick are recorded, and credited by the next tick that judges them in time', async () => {
    const prior = { ...allPass('h1'), coverage: { ticks: history(T0, 1, null) } };
    const f = fake({ head: 'h2', prior, now: clock(T0, T0 + 12 * MIN) });
    await runSyncLintGuardTick(f.deps);
    const missed = (f.state.value?.coverage?.ticks ?? []).filter((t) => t.status === 'missed-opportunity');
    // Started at T0 and finished 12 minutes later: two five-minute slots passed meanwhile.
    expect(missed.map((t) => t.atMs)).toEqual([T0 + 5 * MIN, T0 + 10 * MIN]);
    // Their commits can postdate the tip this tick read at its start, so it does not credit them.
    expect(missed.every((t) => !t.evaluated)).toBe(true);

    // The next tick starts at T0+13m and measures the new tip: both slots are within 30 minutes.
    const next = fake({ head: 'h3', prior: f.state.value, now: clock(T0 + 13 * MIN, T0 + 14 * MIN) });
    await runSyncLintGuardTick(next.deps);
    const credited = (next.state.value?.coverage?.ticks ?? []).filter((t) => t.status === 'missed-opportunity');
    expect(credited.map((t) => [t.atMs, t.evaluated, t.judgedAtMs])).toEqual([
      [T0 + 5 * MIN, true, T0 + 14 * MIN],
      [T0 + 10 * MIN, true, T0 + 14 * MIN],
    ]);
  });

  it('raises the alarm once when 24h coverage falls below 95%, naming the unjudged slots', async () => {
    // 200 slots, every 10th unjudged = 90% judged.
    const prior = { ...allPass('h1'), coverage: { ticks: history(T0, 200, 10) } };
    const f = fake({ head: 'h1', prior, now: () => T0 });
    await runSyncLintGuardTick(f.deps);
    const alarms = f.filed.filter(isAlarm);
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.title).toMatch(/^sync-batch lint guards coverage low: 90% of schedule slots judged over 24h$/);
    expect(alarms[0]!.body).toContain('skipped (git-unreadable) x20');
    expect(alarms[0]!.body).toContain('system:sync-batch-lint-guards');
    expect(alarms[0]!.paths).toEqual(['packages/operator-core/lib/release/sync-batch-lint-guards.ts']);
    expect(f.state.value?.coverage?.alarmOpenSinceMs).toBe(T0);

    // Still low on the next slot: no second item while the alarm is open.
    const again = fake({ head: 'h1', prior: f.state.value, now: () => T0 + 5 * MIN });
    await runSyncLintGuardTick(again.deps);
    expect(again.filed.filter(isAlarm)).toHaveLength(0);
    expect(again.state.value?.coverage?.alarmOpenSinceMs).toBe(T0);
  });

  it('does not alarm at or above 95%, nor on fewer than 144 slots of history', async () => {
    const healthy = fake({ head: 'h1', prior: { ...allPass('h1'), coverage: { ticks: history(T0, 200, 25) } }, now: () => T0 });
    await runSyncLintGuardTick(healthy.deps);
    expect(healthy.filed.filter(isAlarm)).toHaveLength(0);

    const young = fake({ head: 'h1', prior: { ...allPass('h1'), coverage: { ticks: history(T0, 100, 2) } }, now: () => T0 });
    await runSyncLintGuardTick(young.deps);
    expect(young.filed.filter(isAlarm)).toHaveLength(0);
  });

  it('clears the open alarm once coverage recovers', async () => {
    const prior = { ...allPass('h1'), coverage: { ticks: history(T0, 200, null), alarmOpenSinceMs: T0 - 60 * MIN } };
    const f = fake({ head: 'h1', prior, now: () => T0 });
    await runSyncLintGuardTick(f.deps);
    expect(f.filed.filter(isAlarm)).toHaveLength(0);
    expect(f.state.value?.coverage?.alarmOpenSinceMs).toBeUndefined();
  });

  it('a coverage failure never fails the tick', async () => {
    const prior = { ...allPass('h1'), coverage: { ticks: history(T0, 200, 10) } };
    const f = fake({ head: 'h1', prior, now: () => T0 });
    f.deps.fileRed = async () => {
      throw new Error('store down');
    };
    const logs: string[] = [];
    f.deps.log = (m) => logs.push(m);
    const r = await runSyncLintGuardTick(f.deps);
    expect(r.status).toBe('up-to-date');
    expect(logs.some((m) => m.includes('coverage not recorded: store down'))).toBe(true);
  });

  it('lintGuardCoverageTick: a skip carries its reason and is not judged', () => {
    expect(lintGuardCoverageTick({ status: 'skipped', reason: 'git-unreadable', verdicts: {} }, SYNC_LINT_GUARD_SCRIPTS, T0)).toEqual({
      atMs: T0,
      evaluated: false,
      status: 'skipped',
      reason: 'git-unreadable',
    });
  });
});
