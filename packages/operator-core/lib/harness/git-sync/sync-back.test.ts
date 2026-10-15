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
