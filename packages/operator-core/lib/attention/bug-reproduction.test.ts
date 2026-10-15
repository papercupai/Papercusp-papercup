import { describe, expect, it } from 'vitest';
import {
  BUG_REPRODUCTION_SCHEMA_VERSION,
  parseBugReproductionReceipt,
  parseReproductionLedgerRef,
  readBornVerifiedReproduction,
  readStoredBugReproduction,
  sameBuildSha,
  stampFiledBugReproduction,
  verifyBugReproductionReceipt,
  verifyCurrentBugReproductionReceipt,
  verifyAcceptedWorkItemBugReproduction,
  type ReproductionLedgerDeps,
} from './bug-reproduction';

// observation-candidate-acceptance-promotion-2026-09-30 P-013 (D-023 / D-024).

const NOW = new Date('2026-10-05T22:00:00Z');
const BUILD = 'abcdef1234567890abcdef1234567890abcdef12';

function fakeLedger(rows: {
  testRuns?: Record<number, { status: string | null; commitSha: string | null; worktreeDirty: boolean | null }>;
  invocations?: Record<number, { status: string | null; servingBuildSha: string | null }>;
  throws?: boolean;
}): ReproductionLedgerDeps {
  return {
    async readTestRun(id) {
      if (rows.throws) throw new Error('pg down');
      return rows.testRuns?.[id] ?? null;
    },
    async readToolInvocation(id) {
      if (rows.throws) throw new Error('pg down');
      return rows.invocations?.[id] ?? null;
    },
    now: () => NOW,
  };
}

describe('parseBugReproductionReceipt', () => {
  it('accepts a complete receipt and normalizes the sha', () => {
    expect(
      parseBugReproductionReceipt({ kind: 'scripted-repro', ref: ' npm run x ', buildSha: 'ABCDEF1' }),
    ).toEqual({ ok: true, receipt: { kind: 'scripted-repro', ref: 'npm run x', buildSha: 'abcdef1' } });
  });

  it('refuses rather than defaults: no object, unknown kind, blank ref, missing or non-hex sha', () => {
    expect(parseBugReproductionReceipt(null)).toMatchObject({ ok: false });
    expect(parseBugReproductionReceipt(['x'])).toMatchObject({ ok: false });
    expect(parseBugReproductionReceipt({ kind: 'hunch', ref: 'r', buildSha: BUILD })).toMatchObject({
      ok: false,
      error: expect.stringContaining('reproduction.kind'),
    });
    expect(parseBugReproductionReceipt({ kind: 'failing-test', ref: ' ', buildSha: BUILD })).toMatchObject({
      ok: false,
      error: expect.stringContaining('reproduction.ref'),
    });
    expect(parseBugReproductionReceipt({ kind: 'failing-test', ref: 'r' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('buildSha'),
    });
    expect(parseBugReproductionReceipt({ kind: 'failing-test', ref: 'r', buildSha: 'staging' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('buildSha'),
    });
  });

  it('lets the filing door default the kind to encounter, and only when it is omitted', () => {
    expect(parseBugReproductionReceipt({ ref: 'r', buildSha: BUILD }, { defaultKind: 'encounter' })).toMatchObject({
      ok: true,
      receipt: { kind: 'encounter' },
    });
    expect(parseBugReproductionReceipt({ ref: 'r', buildSha: BUILD })).toMatchObject({ ok: false });
  });
});

describe('ledger refs and build identity', () => {
  it('parses test_runs / tool_invocations refs and treats anything else as free text', () => {
    expect(parseReproductionLedgerRef('test_runs:12')).toEqual({ table: 'test_runs', id: 12 });
    expect(parseReproductionLedgerRef(' tool_invocations#9 ')).toEqual({ table: 'tool_invocations', id: 9 });
    expect(parseReproductionLedgerRef('test_runs:0')).toBeNull();
    expect(parseReproductionLedgerRef('see test_runs:12 for detail')).toBeNull();
    expect(parseReproductionLedgerRef('ERROR: boom')).toBeNull();
  });

  it('matches a short sha against a full one, and never matches below 7 chars', () => {
    expect(sameBuildSha(BUILD, 'ABCDEF1')).toBe(true);
    expect(sameBuildSha('abcdef1', BUILD)).toBe(true);
    expect(sameBuildSha(BUILD, '1234567')).toBe(false);
    expect(sameBuildSha('abc', 'abc')).toBe(false);
    expect(sameBuildSha(null, BUILD)).toBe(false);
  });
});

describe('current target build reproduction', () => {
  it('refuses unknown and stale builds even with authentic historical failures', async () => {
    const ledger = fakeLedger({ testRuns: { 1: { status: 'fail', commitSha: BUILD, worktreeDirty: false } } });
    const receipt = { kind: 'failing-test' as const, ref: 'test_runs:1', buildSha: BUILD };
    expect((await verifyCurrentBugReproductionReceipt(receipt, null, ledger)).status).toBe('unresolved');
    expect((await verifyCurrentBugReproductionReceipt(receipt, 'b'.repeat(40), ledger)).status).toBe('refuted');
    expect((await verifyCurrentBugReproductionReceipt(receipt, BUILD, ledger)).status).toBe('verified');
  });

  it('re-reads ledger evidence instead of trusting a caller-supplied build match', async () => {
    const receipt = { kind: 'failing-test' as const, ref: 'test_runs:1', buildSha: BUILD };
    for (const row of [
      { status: 'pass', commitSha: BUILD, worktreeDirty: false },
      { status: 'fail', commitSha: 'b'.repeat(40), worktreeDirty: false },
      { status: 'fail', commitSha: BUILD, worktreeDirty: true },
    ]) {
      expect((await verifyCurrentBugReproductionReceipt(receipt, BUILD, fakeLedger({ testRuns: { 1: row } }))).status).toBe('refuted');
    }
    expect((await verifyCurrentBugReproductionReceipt(receipt, BUILD, fakeLedger({}))).status).toBe('unresolved');
    expect((await verifyCurrentBugReproductionReceipt(receipt, BUILD, fakeLedger({ throws: true }))).status).toBe('unresolved');
  });
});

describe('accepted bug execution freshness', () => {
  const item = (receipt: unknown) => ({
    kind: 'bug', harness: 'target-pot', payload: { implementationReadiness: { status: 'ready', evidence: {
      acceptance: { verification: { check: 'reproduction', receipt } },
    } } },
  });
  const receipt = { kind: 'failing-test', ref: 'test_runs:1', buildSha: BUILD };

  it('rechecks the registered target and cited failure on each execution attempt', async () => {
    let currentBuild = BUILD;
    const ledger = fakeLedger({ testRuns: { 1: { status: 'fail', commitSha: BUILD, worktreeDirty: false } } });
    const scopes: string[] = [];
    const deps = { ledger, currentTargetBuild: async (scope: string) => { scopes.push(scope); return currentBuild; } };
    expect((await verifyAcceptedWorkItemBugReproduction(item(receipt), deps))?.status).toBe('verified');
    currentBuild = 'b'.repeat(40);
    expect((await verifyAcceptedWorkItemBugReproduction(item(receipt), deps))?.status).toBe('refuted');
    currentBuild = BUILD;
    ledger.readTestRun = async () => ({ status: 'pass', commitSha: BUILD, worktreeDirty: false });
    expect((await verifyAcceptedWorkItemBugReproduction(item(receipt), deps))?.status).toBe('refuted');
    expect(scopes).toEqual(['harness:target-pot', 'harness:target-pot', 'harness:target-pot']);
  });

  it('refuses unresolved targets and malformed receipts while preserving other lanes', async () => {
    const deps = { ledger: fakeLedger({}), currentTargetBuild: async () => { throw new Error('registry unavailable'); } };
    expect((await verifyAcceptedWorkItemBugReproduction(item(receipt), deps))?.status).toBe('unresolved');
    expect((await verifyAcceptedWorkItemBugReproduction(item({}), deps))?.status).toBe('unresolved');
    expect(await verifyAcceptedWorkItemBugReproduction({ ...item(receipt), kind: 'task' }, deps)).toBeNull();
    expect(await verifyAcceptedWorkItemBugReproduction({ kind: 'bug', payload: {} }, deps)).toBeNull();
    const revision = item(receipt);
    revision.payload.implementationReadiness.status = 'not-ready';
    expect(await verifyAcceptedWorkItemBugReproduction(revision, deps)).toBeNull();
  });
});

describe('verifyBugReproductionReceipt (D-024 §5)', () => {
  const receipt = (ref: string, buildSha = BUILD.slice(0, 10)) => ({ kind: 'encounter' as const, ref, buildSha });

  it('verifies a failing clean test run on the cited build', async () => {
    const deps = fakeLedger({ testRuns: { 5: { status: 'fail', commitSha: BUILD, worktreeDirty: false } } });
    expect(await verifyBugReproductionReceipt(receipt('test_runs:5'), deps)).toMatchObject({
      status: 'verified',
      checkedAt: NOW.toISOString(),
      observed: { status: 'fail', buildSha: BUILD },
    });
  });

  it('refutes a passing run, a run on another build, and a dirty-worktree run', async () => {
    const deps = fakeLedger({
      testRuns: {
        1: { status: 'pass', commitSha: BUILD, worktreeDirty: false },
        2: { status: 'error', commitSha: '1234567890', worktreeDirty: false },
        3: { status: 'fail', commitSha: BUILD, worktreeDirty: true },
      },
    });
    expect((await verifyBugReproductionReceipt(receipt('test_runs:1'), deps)).status).toBe('refuted');
    expect((await verifyBugReproductionReceipt(receipt('test_runs:2'), deps)).detail).toContain('not the cited build');
    expect((await verifyBugReproductionReceipt(receipt('test_runs:3'), deps)).detail).toContain('dirty worktree');
  });

  it('verifies a failed tool invocation on the serving build and refutes an ok one or another build', async () => {
    const deps = fakeLedger({
      invocations: {
        7: { status: 'error', servingBuildSha: BUILD },
        8: { status: 'ok', servingBuildSha: BUILD },
        9: { status: 'error', servingBuildSha: 'fedcba9876' },
        10: { status: null, servingBuildSha: BUILD },
      },
    });
    expect((await verifyBugReproductionReceipt(receipt('tool_invocations:7'), deps)).status).toBe('verified');
    expect((await verifyBugReproductionReceipt(receipt('tool_invocations:8'), deps)).status).toBe('refuted');
    expect((await verifyBugReproductionReceipt(receipt('tool_invocations:9'), deps)).status).toBe('refuted');
    expect((await verifyBugReproductionReceipt(receipt('tool_invocations:10'), deps)).status).toBe('refuted');
  });

  it('is unresolved when the row is missing or the ledger cannot be read, and attested for free text', async () => {
    expect((await verifyBugReproductionReceipt(receipt('test_runs:99'), fakeLedger({}))).status).toBe('unresolved');
    const down = await verifyBugReproductionReceipt(receipt('tool_invocations:1'), fakeLedger({ throws: true }));
    expect(down).toMatchObject({ status: 'unresolved', detail: expect.stringContaining('pg down') });
    expect((await verifyBugReproductionReceipt(receipt('TypeError: x is undefined'), fakeLedger({}))).status).toBe(
      'attested',
    );
  });
});

describe('stampFiledBugReproduction + born-verified read (D-024)', () => {
  const failing = fakeLedger({ invocations: { 7: { status: 'error', servingBuildSha: BUILD } } });

  it('stamps a verified encounter that reads back as born verified', async () => {
    const stamp = await stampFiledBugReproduction({ ref: 'tool_invocations:7', buildSha: BUILD }, { filedBy: 'su-a' }, failing);
    if (!stamp.ok) throw new Error(stamp.error);
    expect(stamp.stored).toMatchObject({
      schemaVersion: BUG_REPRODUCTION_SCHEMA_VERSION,
      filedBy: 'su-a',
      receipt: { kind: 'encounter', ref: 'tool_invocations:7' },
      verification: { status: 'verified' },
    });
    const payload = JSON.parse(JSON.stringify({ reproduction: stamp.stored }));
    expect(readStoredBugReproduction(payload)?.verification.status).toBe('verified');
    expect(readBornVerifiedReproduction(payload)).toEqual(stamp.stored.receipt);
  });

  it('discards a caller-written verdict: a refuted ref stays refuted and is not born verified', async () => {
    const stamp = await stampFiledBugReproduction(
      { ref: 'tool_invocations:7', buildSha: '1234567', verification: { status: 'verified' } },
      { filedBy: 'su-a' },
      failing,
    );
    if (!stamp.ok) throw new Error(stamp.error);
    expect(stamp.stored.verification.status).toBe('refuted');
    expect(readBornVerifiedReproduction({ reproduction: stamp.stored })).toBeNull();
  });

  it('stores an ineligible filing as evidence without letting it skip review', async () => {
    const stamp = await stampFiledBugReproduction(
      { ref: 'tool_invocations:7', buildSha: BUILD },
      { filedBy: 'su-a', ineligibleReason: 'caller-classified' },
      failing,
    );
    if (!stamp.ok) throw new Error(stamp.error);
    expect(stamp.stored.verification).toMatchObject({ status: 'not-eligible', detail: 'caller-classified' });
    expect(readBornVerifiedReproduction({ reproduction: stamp.stored })).toBeNull();
  });

  it('refuses a malformed receipt or an unattributed filer', async () => {
    expect(await stampFiledBugReproduction({ ref: 'r' }, { filedBy: 'su-a' }, failing)).toMatchObject({ ok: false });
    expect(await stampFiledBugReproduction({ ref: 'r', buildSha: BUILD }, { filedBy: ' ' }, failing)).toMatchObject({
      ok: false,
      error: expect.stringContaining('attributable'),
    });
  });

  it('reads nothing from a hand-written or other-version payload', () => {
    const receipt = { kind: 'encounter', ref: 'r', buildSha: BUILD };
    expect(readBornVerifiedReproduction({ reproduction: receipt })).toBeNull();
    expect(
      readBornVerifiedReproduction({
        reproduction: { schemaVersion: 'v0', receipt, filedBy: 'a', verification: { status: 'verified' } },
      }),
    ).toBeNull();
    expect(readBornVerifiedReproduction(null)).toBeNull();
  });
});
