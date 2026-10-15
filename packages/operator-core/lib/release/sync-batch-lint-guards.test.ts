/**
 * P-028 (green-main-cycle-time-2026-10-08): repo-wide lint guards per git-sync batch.
 * Pure tests against `SyncLintGuardDeps` fakes, plus the pin that keeps the guard list
 * equal to the gate's `lowMemoryLintSpecs`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RedFinding, SyncBatch } from './sync-batch-delta-check';
import {
  classifyGuardRun,
  diffGuardViolations,
  guardExcerpt,
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
    now: () => 1_000_000,
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

  it('does not re-run guards when the tip has not moved, and skips above the hard load ceiling', async () => {
    const same = fake({ head: 'h1', prior: allPass('h1') });
    expect((await runSyncLintGuardTick(same.deps)).status).toBe('up-to-date');
    expect(same.guardCalls).toEqual([]);

    const loaded = fake({ head: 'h2', prior: allPass('h1'), load1: 10_000 });
    const r = await runSyncLintGuardTick(loaded.deps);
    expect(r.status).toBe('skipped');
    expect(loaded.guardCalls).toEqual([]);
    expect(loaded.state.value?.lastSkipReason).toMatch(/hard ceiling/);
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
