import { describe, it, expect, beforeEach, vi } from 'vitest';
import exportTool, { publishTool } from './publish';
import { getFlag } from '@papercusp/flags/server';
import { exportHiveLearningsToPack } from '../../knowledge-packs/export';
import { resolveRepoCoordsFromDir } from '../../cupboard/resolve-repo-coords';
import { publishListingToCupboard } from '../../cupboard/publish-listing';

// PG-free unit: the export writer + the Comb publish core have their own suites;
// this pins the TWO tools — flag gate, the export hint-on-ok, and publish's
// repo-coords guard / failure pass-through / PENDING-success envelope
// (learning-packs-2026-06-11 P-016, D-007 approval gate).
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('../../knowledge-packs/export', () => ({ exportHiveLearningsToPack: vi.fn() }));
vi.mock('../../cupboard/resolve-repo-coords', () => ({
  resolveRepoCoordsFromDir: vi.fn(),
  gitOriginUrl: vi.fn(),
  fetchGithubRepoMeta: vi.fn(),
}));
vi.mock('../../cupboard/publish-listing', () => ({ publishListingToCupboard: vi.fn() }));

const mockFlag = vi.mocked(getFlag);
const mockExport = vi.mocked(exportHiveLearningsToPack);
const mockCoords = vi.mocked(resolveRepoCoordsFromDir);
const mockPublish = vi.mocked(publishListingToCupboard);

function call(tool: unknown, args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (tool as { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> }).handler(args, ctx);
}
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

const EXPORT_ARGS = { pot: 'h', packId: 'my-pack', title: 'T', description: 'D', targetDir: '/repo' };
const PUBLISH_ARGS = { packId: 'my-pack', title: 'T', description: 'D', repoDir: '/repo' };
const COORDS = {
  github_repository_id: 9,
  github_owner: 'acme',
  github_name: 'proj',
  github_url: 'https://github.com/acme/proj',
};

describe('knowledge_packs:export tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlag.mockResolvedValue(true);
    mockExport.mockResolvedValue({ ok: true, packId: 'my-pack', files: 7 } as unknown as Awaited<
      ReturnType<typeof exportHiveLearningsToPack>
    >);
  });

  it('refuses when the flag is off', async () => {
    mockFlag.mockResolvedValue(false);
    expect(body(await call(exportTool, EXPORT_ARGS))).toMatchObject({ ok: false, reason: 'feature-disabled' });
    expect(mockExport).not.toHaveBeenCalled();
  });

  it('exports with the mapped args and appends the commit+publish hint on ok', async () => {
    const res = body(await call(exportTool, EXPORT_ARGS));
    expect(mockExport).toHaveBeenCalledWith(
      expect.objectContaining({ potSlug: 'h', packId: 'my-pack', title: 'T', description: 'D', targetDir: '/repo' }),
    );
    expect(res.ok).toBe(true);
    expect(res.hint).toMatch(/knowledge_packs:publish/);
  });

  it('omits the hint when the export itself failed', async () => {
    mockExport.mockResolvedValue({ ok: false, error: 'bad target' } as unknown as Awaited<
      ReturnType<typeof exportHiveLearningsToPack>
    >);
    const res = body(await call(exportTool, EXPORT_ARGS));
    expect(res).toMatchObject({ ok: false, error: 'bad target' });
    expect(res.hint).toBeUndefined();
  });
});

describe('knowledge_packs:publish tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlag.mockResolvedValue(true);
    mockCoords.mockResolvedValue(COORDS as unknown as Awaited<ReturnType<typeof resolveRepoCoordsFromDir>>);
    mockPublish.mockResolvedValue({
      ok: true,
      data: { id: 'listing-1', review_status: 'pending' },
    } as unknown as Awaited<ReturnType<typeof publishListingToCupboard>>);
  });

  it('refuses when the flag is off', async () => {
    mockFlag.mockResolvedValue(false);
    expect(body(await call(publishTool, PUBLISH_ARGS))).toMatchObject({ ok: false, reason: 'feature-disabled' });
    expect(mockCoords).not.toHaveBeenCalled();
  });

  it('returns repo_coords_unresolvable WITH the fix-it hint and never reaches the publish core (null coords)', async () => {
    mockCoords.mockResolvedValue(null as never);
    const res = body(await call(publishTool, PUBLISH_ARGS));
    expect(res).toMatchObject({ ok: false, error: 'repo_coords_unresolvable' });
    expect(res.hint).toMatch(/git repo with a GitHub origin/i);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('surfaces a coords resolution error detail', async () => {
    mockCoords.mockResolvedValue({ error: 'no origin remote' } as never);
    const res = body(await call(publishTool, PUBLISH_ARGS));
    expect(res).toMatchObject({ ok: false, error: 'repo_coords_unresolvable', detail: 'no origin remote' });
  });

  it('passes a publish-core failure through', async () => {
    mockPublish.mockResolvedValue({ ok: false, error: 'gh_token_missing', status: 401 } as unknown as Awaited<
      ReturnType<typeof publishListingToCupboard>
    >);
    expect(body(await call(publishTool, PUBLISH_ARGS))).toMatchObject({ ok: false, error: 'gh_token_missing', status: 401 });
  });

  it('publishes the knowledge-pack listing and reports PENDING review', async () => {
    const res = body(await call(publishTool, PUBLISH_ARGS));
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({ listing_kind: 'knowledge-pack', listing_ref: 'my-pack', project_ref: 'acme/proj' }),
    );
    expect(res).toMatchObject({ ok: true, listingId: 'listing-1', review_status: 'pending' });
    expect(res.hint).toMatch(/PENDING/);
  });

  it('suppresses the PENDING hint when the listing comes back already non-pending (e.g. approved)', async () => {
    mockPublish.mockResolvedValue({
      ok: true,
      data: { id: 'listing-2', review_status: 'approved' },
    } as unknown as Awaited<ReturnType<typeof publishListingToCupboard>>);
    const res = body(await call(publishTool, PUBLISH_ARGS));
    expect(res).toMatchObject({ ok: true, listingId: 'listing-2', review_status: 'approved' });
    expect(res.hint).not.toMatch(/PENDING/);
    expect(res.hint).toContain('/cupboard?kind=my-submissions');
  });
});
