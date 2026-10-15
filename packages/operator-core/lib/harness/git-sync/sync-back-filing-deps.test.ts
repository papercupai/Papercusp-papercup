/**
 * P-016 (pot-review-integration-mode): the PRODUCTION wiring of the sync-back conflict
 * filing — `makeSyncBackConflictFilingDeps`, which git-sync-action uses verbatim.
 *
 * The load-bearing invariant: the dedupe lookup reads the SAME watchdog key the create
 * stamps. If they diverge, the lookup never finds the item it filed and a stuck merge
 * re-files a fresh work-item on every git-sync tick.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  fileSyncBackConflict,
  makeSyncBackConflictFilingDeps,
  syncBackConflictWatchdogKey,
  syncBackConflictTitlePrefix,
  SYNC_BACK_CONFLICT_PATHS_CAP,
  type SyncBackConflictCaptureInput,
  type SyncBackConflictFilingSinks,
  type SyncBackResult,
} from './sync-back';

const cfg = { upstreamRemote: 'origin', upstreamBranch: 'main' };

/** An in-memory issue store keyed on watchdogKey — the shape the real sinks persist. */
function memorySinks() {
  const filed: Array<SyncBackConflictCaptureInput & { id: string; state: string }> = [];
  const sinks: SyncBackConflictFilingSinks = {
    findIssuesByWatchdogKeys: vi.fn(async (keys: string[]) =>
      filed.filter((i) => keys.includes(i.watchdogKey)).map((i) => ({ id: i.id, state: i.state })),
    ),
    captureImprovement: vi.fn(async (input: SyncBackConflictCaptureInput) => {
      const id = `WI-${filed.length + 1}`;
      filed.push({ ...input, id, state: 'open' });
      return { issue: { id } };
    }),
  };
  return { sinks, filed };
}

function conflict(sha: string, files: string[]): SyncBackResult {
  return { status: 'conflict', upstreamSha: sha, conflictedFiles: files } as SyncBackResult;
}

describe('makeSyncBackConflictFilingDeps (production filing wiring)', () => {
  it('files once, then dedupes the same stuck merge across upstream advances', async () => {
    const { sinks, filed } = memorySinks();
    const deps = (files: string[]) =>
      makeSyncBackConflictFilingDeps({ slug: 'widget', workspaceId: 'ws', cfg, conflictedFiles: files }, sinks);

    const first = await fileSyncBackConflict(conflict('a'.repeat(40), ['src/a.ts']), cfg, deps(['src/a.ts']));
    expect(first).toEqual({ action: 'filed', id: 'WI-1' });
    // Upstream moved on while the conflict is unresolved: a NEW sha, same stuck merge.
    const second = await fileSyncBackConflict(conflict('b'.repeat(40), ['src/a.ts']), cfg, deps(['src/a.ts']));
    expect(second).toEqual({ action: 'exists', id: 'WI-1' });
    expect(filed).toHaveLength(1);
  });

  it('the lookup key equals the key the create stamped', async () => {
    const { sinks, filed } = memorySinks();
    const deps = makeSyncBackConflictFilingDeps({ slug: 'widget', workspaceId: 'ws', cfg, conflictedFiles: [] }, sinks);
    await fileSyncBackConflict(conflict('c'.repeat(40), []), cfg, deps);
    const expectedKey = syncBackConflictWatchdogKey('widget', syncBackConflictTitlePrefix('origin', 'main'));
    expect(filed[0]?.watchdogKey).toBe(expectedKey);
    expect(sinks.findIssuesByWatchdogKeys).toHaveBeenCalledWith([expectedKey]);
  });

  it('files a major bug scoped to the pot, attributed to git-sync, with capped paths', async () => {
    const { sinks, filed } = memorySinks();
    const many = Array.from({ length: SYNC_BACK_CONFLICT_PATHS_CAP + 5 }, (_, i) => `f${i}.ts`);
    const deps = makeSyncBackConflictFilingDeps({ slug: 'widget', workspaceId: 'ws-1', cfg, conflictedFiles: many }, sinks);
    await fileSyncBackConflict(conflict('d'.repeat(40), many), cfg, deps);
    expect(filed[0]).toMatchObject({
      kind: 'bug',
      severity: 'major',
      workspaceId: 'ws-1',
      scope: 'harness:widget',
      createdBy: 'system:git-sync',
    });
    expect(filed[0]?.paths).toEqual(many.slice(0, SYNC_BACK_CONFLICT_PATHS_CAP));
  });

  it('a terminal item does not dedupe — a recurring conflict files afresh', async () => {
    const { sinks, filed } = memorySinks();
    const deps = makeSyncBackConflictFilingDeps({ slug: 'widget', workspaceId: 'ws', cfg, conflictedFiles: [] }, sinks);
    await fileSyncBackConflict(conflict('e'.repeat(40), []), cfg, deps);
    filed[0]!.state = 'done';
    const again = await fileSyncBackConflict(conflict('f'.repeat(40), []), cfg, deps);
    expect(again).toEqual({ action: 'filed', id: 'WI-2' });
  });

  it('pots do not dedupe each other', async () => {
    const { sinks } = memorySinks();
    const mk = (slug: string) => makeSyncBackConflictFilingDeps({ slug, workspaceId: 'ws', cfg, conflictedFiles: [] }, sinks);
    await fileSyncBackConflict(conflict('1'.repeat(40), []), cfg, mk('alpha'));
    const other = await fileSyncBackConflict(conflict('1'.repeat(40), []), cfg, mk('beta'));
    expect(other).toEqual({ action: 'filed', id: 'WI-2' });
  });
});
