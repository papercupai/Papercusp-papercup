// P-016 (plan pot-review-integration-mode-2026-10-05): a sync-back conflict becomes ONE
// fix-it work-item in the pot, deduped on the sha-free title prefix.
import { describe, expect, it, vi } from 'vitest';
import {
  fileSyncBackConflict,
  syncBackConflictTitle,
  syncBackConflictTitlePrefix,
  type SyncBackConflictFilingDeps,
} from './sync-back';

const cfg = { upstreamRemote: 'origin', upstreamBranch: 'main' };
const conflict = {
  status: 'conflict' as const,
  upstreamSha: 'abcdef0123456789abcdef0123456789abcdef01',
  conflictedFiles: ['src/a.ts', 'README.md'],
};

function deps(existing: string | null): SyncBackConflictFilingDeps & {
  findOpenByTitlePrefix: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
} {
  return {
    findOpenByTitlePrefix: vi.fn(async () => existing),
    create: vi.fn(async () => 'WI-NEW'),
  };
}

// EI-27142578298088040: a fixed conflict left its item open, so a LATER different conflict
// deduped into the stale item and the fork pot stalled for 3 days with no fresh signal.
describe('fileSyncBackConflict resolves the open item on sync-back success', () => {
  function resolvingDeps(open: string | null) {
    let openId = open;
    const d = {
      findOpenByTitlePrefix: vi.fn(async () => openId),
      create: vi.fn(async () => 'WI-FRESH'),
      resolve: vi.fn(async () => {
        openId = null;
      }),
    };
    return d;
  }
  const upstreamSha = '2336e41ab31bbe854f5bc3912e50fc0d71a8e266';

  it('resolves the open item with the merged sha as completion evidence', async () => {
    const d = resolvingDeps('EI-STALE');
    const merged = { status: 'merged' as const, upstreamSha, mergedSha: '8abfd4f252aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
    await expect(fileSyncBackConflict(merged, cfg, d)).resolves.toEqual({ action: 'resolved', id: 'EI-STALE' });
    expect(d.findOpenByTitlePrefix).toHaveBeenCalledWith(syncBackConflictTitlePrefix('origin', 'main'));
    expect(d.resolve).toHaveBeenCalledTimes(1);
    const [id, ref] = d.resolve.mock.calls[0] as unknown as [string, string];
    expect(id).toBe('EI-STALE');
    expect(ref).toContain('origin/main @ 2336e41ab31b');
    expect(ref).toContain('8abfd4f252aa');
    expect(d.create).not.toHaveBeenCalled();
  });

  it('resolves on up-to-date too (a hand-merged conflict is first seen as already contained)', async () => {
    const d = resolvingDeps('EI-STALE');
    await expect(fileSyncBackConflict({ status: 'up-to-date', upstreamSha }, cfg, d)).resolves.toEqual({
      action: 'resolved',
      id: 'EI-STALE',
    });
    expect((d.resolve.mock.calls[0] as unknown as [string, string])[1]).toContain('up-to-date');
  });

  it('does nothing on success when no item is open', async () => {
    const d = resolvingDeps(null);
    await expect(fileSyncBackConflict({ status: 'up-to-date', upstreamSha }, cfg, d)).resolves.toEqual({ action: 'none' });
    expect(d.resolve).not.toHaveBeenCalled();
  });

  it('never resolves on skipped or error results', async () => {
    for (const result of [{ status: 'skipped' as const, reason: 'x' }, { status: 'error' as const, message: 'fetch failed' }]) {
      const d = resolvingDeps('EI-OPEN');
      await expect(fileSyncBackConflict(result, cfg, d)).resolves.toEqual({ action: 'none' });
      expect(d.resolve).not.toHaveBeenCalled();
    }
  });

  it('a conflict AFTER a successful sync-back files a FRESH item instead of deduping into the stale one', async () => {
    const d = resolvingDeps('EI-STALE');
    await fileSyncBackConflict({ status: 'merged', upstreamSha, mergedSha: 'b'.repeat(40) }, cfg, d);
    const later = { status: 'conflict' as const, upstreamSha: 'c'.repeat(40), conflictedFiles: ['.papercusp/memory/raw.md'] };
    await expect(fileSyncBackConflict(later, cfg, d)).resolves.toEqual({ action: 'filed', id: 'WI-FRESH' });
    expect((d.create.mock.calls[0] as unknown as [{ summary: string }])[0].summary).toContain('- .papercusp/memory/raw.md');
  });
});

describe('fileSyncBackConflict', () => {
  it('does nothing when sync-back did not conflict', async () => {
    for (const result of [
      undefined,
      { status: 'merged' as const, upstreamSha: 'a', mergedSha: 'b' },
      { status: 'up-to-date' as const, upstreamSha: 'a' },
      { status: 'skipped' as const, reason: 'x' },
      { status: 'error' as const, message: 'x' },
    ]) {
      const d = deps(null);
      await expect(fileSyncBackConflict(result, cfg, d)).resolves.toEqual({ action: 'none' });
      expect(d.findOpenByTitlePrefix).not.toHaveBeenCalled();
      expect(d.create).not.toHaveBeenCalled();
    }
  });

  it('does not file a second item while one is open (deduped on the sha-free prefix)', async () => {
    const d = deps('WI-OPEN');
    await expect(fileSyncBackConflict(conflict, cfg, d)).resolves.toEqual({ action: 'exists', id: 'WI-OPEN' });
    expect(d.findOpenByTitlePrefix).toHaveBeenCalledWith(syncBackConflictTitlePrefix('origin', 'main'));
    expect(d.create).not.toHaveBeenCalled();
  });

  it('files a fix-it item naming the conflicted paths and the resolution recipe', async () => {
    const d = deps(null);
    await expect(fileSyncBackConflict(conflict, cfg, d)).resolves.toEqual({ action: 'filed', id: 'WI-NEW' });
    expect(d.create).toHaveBeenCalledTimes(1);
    const input = d.create.mock.calls[0][0] as { title: string; summary: string };
    expect(input.title).toBe(syncBackConflictTitle('origin', 'main', conflict.upstreamSha));
    expect(input.title.startsWith(syncBackConflictTitlePrefix('origin', 'main'))).toBe(true);
    expect(input.summary).toContain('- src/a.ts');
    expect(input.summary).toContain('- README.md');
    expect(input.summary).toContain('git fetch origin main');
    expect(input.summary).toContain('git merge origin/main');
  });
});
