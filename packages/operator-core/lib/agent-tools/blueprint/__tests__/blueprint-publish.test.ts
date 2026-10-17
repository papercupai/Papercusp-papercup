/**
 * blueprint:publish — P-016 (domain-generic-hive-architecture-2026-06-18).
 *
 * PG-free unit (the Comb publish core + repo-coords resolver have their own
 * suites). Pins the publish tool: the not-in-repo guard, the repo-coords guard /
 * failure pass-through, the blueprint.yaml `kind` → `blueprint_kind` discriminator
 * (delta-not-copy: it reads the kind but never flattens the blueprint), and the
 * PENDING-success envelope (D-007 approval gate). Uses a real temp-dir blueprint
 * so the yaml read + kind extraction run for real; only the network boundaries
 * (coords + publish core) are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import publishTool from '../publish';
import { operatorResolveExtends } from '../../../blueprint/installed-blueprints';
import { resolveRepoCoordsFromDir } from '../../../cupboard/resolve-repo-coords';
import { publishListingToCupboard } from '../../../cupboard/publish-listing';
import { prepareBlueprintPublicRelease } from '../../../cupboard/blueprint-release';

vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('../../../blueprint/installed-blueprints', () => ({
  operatorResolveExtends: vi.fn(() => () => null),
}));
vi.mock('../../../cupboard/resolve-repo-coords', () => ({
  resolveRepoCoordsFromDir: vi.fn(),
  gitOriginUrl: vi.fn(),
  fetchGithubRepoMeta: vi.fn(),
}));
vi.mock('../../../cupboard/publish-listing', () => ({ publishListingToCupboard: vi.fn() }));
vi.mock('../../../cupboard/blueprint-release', () => {
  class BlueprintLifecycleError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  }
  return {
    BlueprintLifecycleError,
    prepareBlueprintPublicRelease: vi.fn(async ({ listingRef }: { listingRef: string }) => ({
      source: {
        id: listingRef,
        version: '1.0.0',
        raw: { id: listingRef, ...(listingRef.includes('hive') ? { kind: 'hive' } : {}) },
        archive: {
          package: { rootHash: `sha256:${'a'.repeat(64)}` },
          root: { contentHash: 'b'.repeat(64) },
          pins: [],
        },
      },
      release: { visibility: 'public', manifest: {}, bytes: Buffer.from('release') },
      manifest: {},
    })),
  };
});

const mockCoords = vi.mocked(resolveRepoCoordsFromDir);
const mockPublish = vi.mocked(publishListingToCupboard);
const mockResolveExtends = vi.mocked(operatorResolveExtends);
const mockPrepareRelease = vi.mocked(prepareBlueprintPublicRelease);

function call(tool: unknown, args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (tool as { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> }).handler(
    args,
    ctx,
  );
}
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

const COORDS = {
  github_repository_id: 9,
  github_owner: 'acme',
  github_name: 'proj',
  github_url: 'https://github.com/acme/proj',
};

const dirs: string[] = [];
function repoWithBlueprint(id: string, yaml: string): string {
  const repo = mkdtempSync(join(tmpdir(), 'bp-pub-'));
  dirs.push(repo);
  const bpDir = join(repo, '.papercusp', 'blueprints', id);
  mkdirSync(bpDir, { recursive: true });
  writeFileSync(join(bpDir, 'blueprint.yaml'), yaml);
  return repo;
}

function repoWithLibraryBlueprint(id: string, yaml: string): string {
  const repo = mkdtempSync(join(tmpdir(), 'bp-pub-library-'));
  dirs.push(repo);
  const bpDir = join(repo, 'packages', 'harness', 'blueprints', id);
  mkdirSync(bpDir, { recursive: true });
  writeFileSync(join(bpDir, 'blueprint.yaml'), yaml);
  return repo;
}
afterEach(() => {
  vi.useRealTimers();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('blueprint:publish tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCoords.mockResolvedValue(COORDS as unknown as Awaited<ReturnType<typeof resolveRepoCoordsFromDir>>);
    mockPublish.mockResolvedValue({
      ok: true,
      data: { id: 'listing-1', review_status: 'pending' },
    } as unknown as Awaited<ReturnType<typeof publishListingToCupboard>>);
  });

  it('documents and enforces the unscoped-only global publication contract', async () => {
    expect(publishTool.crossWorkspace).toBe(true);
    expect(publishTool.description).toMatch(/UNSCOPED-ONLY/i);
    const guidance = `${publishTool.guidance?.when ?? ''}\n${publishTool.guidance?.notWhen ?? ''}\n${publishTool.guidance?.chaining ?? ''}`;
    expect(guidance).toMatch(/unscoped \(--all-workspaces\)/i);
    expect(guidance).toMatch(/workspace-scoped session.*refus/i);
    expect(publishTool.args.shape.workspace.description).toMatch(/does not make a workspace-scoped call eligible/i);
    expect(publishTool.args.shape.workspace.description).toMatch(/unscoped \(--all-workspaces\)/i);

    const repo = repoWithBlueprint('scoped-bp', 'id: scoped-bp\nextends: coding\n');
    const res = body(
      await call(
        publishTool,
        { blueprintId: 'scoped-bp', title: 'T', description: 'D', repoDir: repo, workspace: 'ws-scoped' },
        { principal: { workspaceId: 'ws-scoped' } },
      ),
    );
    expect(res).toMatchObject({ ok: false, error: 'workspace_forbidden', status: 403 });
    expect(res.hint).toMatch(/unscoped \(--all-workspaces\)/i);
    expect(mockPrepareRelease).not.toHaveBeenCalled();
    expect(mockCoords).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('returns blueprint_not_in_repo when the blueprint dir is missing (never reaches coords/publish)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'bp-pub-empty-'));
    dirs.push(repo);
    const res = body(await call(publishTool, { blueprintId: 'nope', title: 'T', description: 'D', repoDir: repo }));
    expect(res).toMatchObject({ ok: false, error: 'blueprint_not_in_repo' });
    expect(mockCoords).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('returns repo_coords_unresolvable WITH the fix-it hint and never publishes (null coords)', async () => {
    const repo = repoWithBlueprint('my-bp', 'id: my-bp\nextends: coding\nkind: harness\n');
    mockCoords.mockResolvedValue(null as never);
    const res = body(await call(publishTool, { blueprintId: 'my-bp', title: 'T', description: 'D', repoDir: repo }));
    expect(res).toMatchObject({ ok: false, error: 'repo_coords_unresolvable' });
    expect(res.hint).toMatch(/git repo with a GitHub origin/i);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('starts repo resolution concurrently and returns a typed timeout when release preparation stalls', async () => {
    vi.useFakeTimers();
    const repo = repoWithBlueprint('slow-bp', 'id: slow-bp\nextends: coding\n');
    mockPrepareRelease.mockImplementationOnce(() => new Promise(() => {}));

    const pending = call(publishTool, { blueprintId: 'slow-bp', title: 'T', description: 'D', repoDir: repo });
    await vi.advanceTimersByTimeAsync(0);

    expect(mockCoords).toHaveBeenCalledTimes(1);
    expect(mockPublish).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(body(await pending)).toMatchObject({
      ok: false,
      error: 'blueprint_publish_timeout',
      status: 504,
      detail: { stage: 'blueprint_release', timeoutMs: 20_000 },
    });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('surfaces a coords resolution error detail', async () => {
    const repo = repoWithBlueprint('my-bp', 'id: my-bp\nextends: coding\n');
    mockCoords.mockResolvedValue({ error: 'no origin remote' } as never);
    const res = body(await call(publishTool, { blueprintId: 'my-bp', title: 'T', description: 'D', repoDir: repo }));
    expect(res).toMatchObject({ ok: false, error: 'repo_coords_unresolvable', detail: 'no origin remote' });
  });

  it('passes a publish-core failure through', async () => {
    const repo = repoWithBlueprint('my-bp', 'id: my-bp\nextends: coding\n');
    mockPublish.mockResolvedValue({ ok: false, error: 'gh_token_missing', status: 401 } as unknown as Awaited<
      ReturnType<typeof publishListingToCupboard>
    >);
    expect(
      body(await call(publishTool, { blueprintId: 'my-bp', title: 'T', description: 'D', repoDir: repo })),
    ).toMatchObject({ ok: false, error: 'gh_token_missing', status: 401 });
  });

  it("publishes a kind='blueprint' listing (delta-not-copy), carries the hive blueprint_kind, reports PENDING", async () => {
    const repo = repoWithBlueprint('my-hive-bp', 'id: my-hive-bp\nextends: coding\nkind: hive\n');
    const res = body(
      await call(publishTool, { blueprintId: 'my-hive-bp', title: 'T', description: 'D', repoDir: repo }),
    );
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        listing_kind: 'blueprint',
        listing_ref: 'my-hive-bp',
        blueprint_kind: 'hive',
        project_ref: 'acme/proj',
        release: expect.objectContaining({ visibility: 'public' }),
      }),
    );
    expect(res).toMatchObject({ ok: true, listingId: 'listing-1', blueprintKind: 'hive', review_status: 'pending' });
    expect(res.hint).toMatch(/PENDING/);
    expect(res.mySubmissionsPath).toBe('/cupboard?kind=my-submissions');
    expect(res.mySubmissionsTool).toBe('cupboard:my-listings');
  });

  it("defaults blueprint_kind to 'harness' when the blueprint.yaml declares no hive kind", async () => {
    const repo = repoWithBlueprint('my-bp', 'id: my-bp\nextends: coding\n'); // no `kind:`
    await call(publishTool, { blueprintId: 'my-bp', title: 'T', description: 'D', repoDir: repo });
    expect(mockPublish).toHaveBeenCalledWith(expect.objectContaining({ blueprint_kind: 'harness' }));
  });

  it('publishes an identity from the official packages/harness/blueprints library root', async () => {
    const repo = repoWithLibraryBlueprint(
      'papercusp-engineer',
      'id: papercusp-engineer\nversion: 1.0.0\nslots: [{ slot: domain }]\n',
    );
    const res = body(
      await call(publishTool, {
        blueprintId: 'papercusp-engineer',
        title: 'Papercusp engineer',
        description: 'Engineering domain identity',
        repoDir: repo,
      }),
    );
    expect(res).toMatchObject({ ok: true, listingId: 'listing-1' });
    expect(mockResolveExtends).toHaveBeenCalledWith({
      localDirs: [join(repo, 'packages', 'harness', 'blueprints')],
    });
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({ listing_kind: 'blueprint', listing_ref: 'papercusp-engineer' }),
    );
  });

  it('suppresses the PENDING hint when the listing comes back approved', async () => {
    const repo = repoWithBlueprint('my-bp', 'id: my-bp\nextends: coding\n');
    mockPublish.mockResolvedValue({
      ok: true,
      data: { id: 'listing-2', review_status: 'approved' },
    } as unknown as Awaited<ReturnType<typeof publishListingToCupboard>>);
    const res = body(await call(publishTool, { blueprintId: 'my-bp', title: 'T', description: 'D', repoDir: repo }));
    expect(res).toMatchObject({ ok: true, listingId: 'listing-2', review_status: 'approved' });
    expect(res.hint).toContain('approved');
    expect(res.hint).toContain('My submissions');
    expect(res.hint).not.toContain('PENDING');
  });
});
