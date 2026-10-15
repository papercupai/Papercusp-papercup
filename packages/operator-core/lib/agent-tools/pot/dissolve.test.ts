/**
 * pot:dissolve unwinds the pot (hive-tool-namespace-2026-06-08 P-009, D-005/
 * D-006). PG-free: the readers/teardown primitives are mocked; asserts the
 * orchestration — clears the Mug wake, cancels every LIVE cup (dead skipped),
 * deregisters the home harness, and only drops the schema (via dropHarnessSchema,
 * which sanitizes the slug) when asked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ROOT_CTX = { isSuperuser: true, uiClientId: 'su-test', workspaceId: 'default' } as never;
const parse = (r: { content: Array<{ text: string }> }): Record<string, unknown> =>
  JSON.parse(r.content[0].text);
type Tool = { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> };

let cancelCalls: string[];
let clearWakeCalls: string[];
let deregCalls: string[];
let dropSchemaCalls: string[];
let teardownLoopCalls: string[];
let membershipDropCalls: string[];
let releaseRoutineCleanupCalls: Array<{ workspaceId: string; potSlug: string }>;
let releaseRoutineCleanupThrows: boolean;
let teardownOrder: string[];
// P-021: when set, teardownPotLearningLoop throws — proving the dissolve still
// succeeds (best-effort; a failure WARNS, never fails the dissolve).
let teardownLoopThrows: boolean;
let cups: Array<{ holderAlive: boolean; agentId: string | null; harnessSlug: string | null }>;
// B11 / P-014: the owner-action tier gate is mocked here (it has its own
// dedicated integration test, member-tier-gate.integration.test.ts). Default
// allow; a test flips this to prove the dissolve chokepoint honors a denial.
let gateResult: { ok: boolean; tier?: string; reason?: string; message?: string };

beforeEach(() => {
  vi.resetModules();
  cancelCalls = [];
  clearWakeCalls = [];
  deregCalls = [];
  dropSchemaCalls = [];
  teardownLoopCalls = [];
  membershipDropCalls = [];
  releaseRoutineCleanupCalls = [];
  releaseRoutineCleanupThrows = false;
  teardownOrder = [];
  teardownLoopThrows = false;
  gateResult = { ok: true, tier: 'owner', reason: 'solo-unbound' };
  cups = [
    { holderAlive: true, agentId: 's-cup-a', harnessSlug: 'h' },
    { holderAlive: true, agentId: 's-cup-b', harnessSlug: 'h' },
    { holderAlive: false, agentId: 's-dead', harnessSlug: 'h' }, // dead → skipped
  ];
  vi.doMock('./_resolve', () => ({
    resolvePot: async () => ({
      slug: 'h',
      path: '/h',
      kind: 'hive',
      deployment: { target: 'local' },
      deployed: false,
      wake: {},
    }),
  }));
  vi.doMock('../../fleet/assignments', () => ({ listFleetAssignments: async () => cups }));
  vi.doMock('../../fleet/nursery', () => ({
    cancelSubtree: async (_sql: unknown, opts: { rootSpawnId: string }) => {
      cancelCalls.push(opts.rootSpawnId);
      return { cancelled: [{ spawnId: opts.rootSpawnId }] };
    },
  }));
  vi.doMock('../../pot/wake', () => ({
    clearPotTimeWake: async (_sql: unknown, slug: string) => {
      clearWakeCalls.push(slug);
    },
  }));
  vi.doMock('../../scaffold-harness-schema', () => ({
    dropHarnessSchema: async (slug: string) => {
      dropSchemaCalls.push(slug);
    },
  }));
  vi.doMock('../../harness-membership', () => ({
    removeHarnessFromWorkspace: async (_ws: string, slug: string) => {
      deregCalls.push(slug);
      teardownOrder.push('deregister');
      return { changed: true };
    },
  }));
  vi.doMock('../../harness/routines/seed-hive-release-routines', () => ({
    teardownHiveReleaseRoutines: async (opts: { workspaceId: string; potSlug: string }) => {
      releaseRoutineCleanupCalls.push(opts);
      teardownOrder.push('release-routines');
      if (releaseRoutineCleanupThrows) throw new Error('routine delete failed');
      return { deleted: ['green-checkpoint', 'release-trigger'] };
    },
  }));
  // G24 (shared-hive-public-release-2026-06-22): dissolve's membership-teardown leg
  // deletes the pot's hive_members rows (federated). PG-free here — the real fn's
  // federation is proven by lifecycle-membership-teardown.integration.test.ts.
  // hive-membership-store.ts is OUT OF SCOPE for the cup-lexicon rename — mock
  // the REAL module path + export name.
  vi.doMock('../../hive-membership-store', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    removeAllHiveMembers: async (_ws: string, slug: string) => {
      membershipDropCalls.push(slug);
      return 2;
    },
  }));
  vi.doMock('../../pot/provision-learning-loop', () => ({
    teardownPotLearningLoop: async ({ potSlug }: { potSlug: string }) => {
      teardownLoopCalls.push(potSlug);
      if (teardownLoopThrows) throw new Error('boom');
      return { potSlug, gymAutoloop: true, scoutRoutine: true, governorRegistrants: true };
    },
  }));
  vi.doMock('../../fleet/operator-spawn', () => ({ abortLocalSpawn: () => true }));
  vi.doMock('@papercusp/db-org', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@papercusp/db-org')>()),
    getOrgPg: () => ({ sql: {} }),
  }));
  vi.doMock('../../pot/member-tier-gate', () => ({
    requirePotTier: async () => gateResult,
  }));
});

afterEach(() => {
  for (const m of [
    './_resolve',
    '../../fleet/assignments',
    '../../fleet/nursery',
    '../../pot/wake',
    '../../scaffold-harness-schema',
    '../../harness-membership',
    '../../harness/routines/seed-hive-release-routines',
    '../../hive-membership-store',
    '../../pot/provision-learning-loop',
    '../../fleet/operator-spawn',
    '@papercusp/db-org',
    '../../pot/member-tier-gate',
  ]) {
    vi.doUnmock(m);
  }
});

describe('pot:dissolve', () => {
  it('clears the wake, cancels live cups (dead skipped), deregisters — no schema drop by default', async () => {
    const tool = (await import('./dissolve')).default as unknown as Tool;
    const res = parse(await tool.handler({ slug: 'h', confirm: true, workspace: 'default' }, ROOT_CTX));
    expect(res.ok).toBe(true);
    expect(clearWakeCalls).toEqual(['h']);
    expect(cancelCalls.sort()).toEqual(['s-cup-a', 's-cup-b']);
    expect((res.cancelledSpawns as string[]).sort()).toEqual(['s-cup-a', 's-cup-b']);
    expect(deregCalls).toEqual(['h']);
    expect(res.deregistered).toBe(true);
    expect(releaseRoutineCleanupCalls).toHaveLength(1);
    expect(releaseRoutineCleanupCalls[0]).toMatchObject({ workspaceId: 'default', potSlug: 'h' });
    expect(res.releaseRoutinesTornDown).toBe(true);
    expect(res.releaseRoutinesDeleted).toEqual(['green-checkpoint', 'release-trigger']);
    expect(teardownOrder).toEqual(['release-routines', 'deregister']);
    // G24: the pot's membership rows are torn down (the leg dissolve invokes,
    // BEFORE deregister) and the dropped count is surfaced.
    expect(membershipDropCalls).toEqual(['h']);
    expect(res.membershipRowsDropped).toBe(2);
    // P-021: the per-pot learning loop is torn down (gym row + scout routine + governor registrants).
    expect(teardownLoopCalls).toEqual(['h']);
    expect(res.learningLoopTornDown).toBe(true);
    expect(res.learningLoop).toEqual({
      potSlug: 'h',
      gymAutoloop: true,
      scoutRoutine: true,
      governorRegistrants: true,
    });
    expect(res.schemaDropped).toBe(false);
    expect(dropSchemaCalls).toEqual([]);
  });

  it('P-021: a learning-loop teardown failure WARNS but does NOT fail the dissolve (best-effort)', async () => {
    teardownLoopThrows = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tool = (await import('./dissolve')).default as unknown as Tool;
    const res = parse(await tool.handler({ slug: 'h', confirm: true, workspace: 'default' }, ROOT_CTX));
    // The dissolve still succeeds; the prior destructive steps all ran.
    expect(res.ok).toBe(true);
    expect(teardownLoopCalls).toEqual(['h']);
    expect(res.learningLoopTornDown).toBe(false);
    expect(res.learningLoopError).toBe('boom');
    expect(deregCalls).toEqual(['h']);
    // The failure is surfaced as a WARN, not swallowed silently.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('learning-loop teardown for h failed'));
    warn.mockRestore();
  });

  it('release-routine teardown failure WARNS but does NOT block deregistration', async () => {
    releaseRoutineCleanupThrows = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tool = (await import('./dissolve')).default as unknown as Tool;

    const res = parse(await tool.handler({ slug: 'h', confirm: true, workspace: 'default' }, ROOT_CTX));

    expect(res.ok).toBe(true);
    expect(res.releaseRoutinesTornDown).toBe(false);
    expect(res.releaseRoutinesError).toBe('routine delete failed');
    expect(deregCalls).toEqual(['h']);
    expect(teardownOrder).toEqual(['release-routines', 'deregister']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('release-routine teardown for h failed'));
    warn.mockRestore();
  });

  it('requires confirm:true', async () => {
    const tool = (await import('./dissolve')).default as unknown as Tool;
    const res = parse(await tool.handler({ slug: 'h', workspace: 'default' }, ROOT_CTX));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('confirm_required');
  });

  it('drops the schema via dropHarnessSchema when dropSchema:true', async () => {
    const tool = (await import('./dissolve')).default as unknown as Tool;
    const res = parse(
      await tool.handler({ slug: 'h', confirm: true, dropSchema: true, workspace: 'default' }, ROOT_CTX),
    );
    expect(res.ok).toBe(true);
    expect(res.schemaDropped).toBe(true);
    expect(dropSchemaCalls).toEqual(['h']); // sanitized name handled inside dropHarnessSchema
  });

  it('B11: a sub-owner tier is REFUSED — none of the destructive steps run', async () => {
    gateResult = { ok: false, tier: 'read-only', reason: 'github', message: 'access is read-only' };
    const tool = (await import('./dissolve')).default as unknown as Tool;
    const res = parse(await tool.handler({ slug: 'h', confirm: true, workspace: 'default' }, ROOT_CTX));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('insufficient_tier');
    expect(res.tier).toBe('read-only');
    // The gate runs AFTER confirm but BEFORE any teardown — nothing destructive fired.
    expect(clearWakeCalls).toEqual([]);
    expect(cancelCalls).toEqual([]);
    expect(deregCalls).toEqual([]);
    expect(teardownLoopCalls).toEqual([]);
    expect(dropSchemaCalls).toEqual([]);
  });
});
