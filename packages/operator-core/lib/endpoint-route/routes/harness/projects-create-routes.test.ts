/**
 * projects-create-routes.test.ts — the error→HTTP status maps for the two
 * mutating "create a hive" HTTP routes in projects.ts (the CreateHarnessPicker's
 * new-hive + GitHub-URL entry points). Following the join-invite.test.ts
 * template: inject the side-effecting composition (createHive* mocked) and
 * assert each {ok:false,error} variant lands on the documented status, plus the
 * malformed-body fast-fails before any side effect.
 *
 *   Gap 7 — POST /harness/pots/from-repo (createHiveFromRepoRoute, :470-540):
 *     invalid_url|invalid_slug→400, hive_not_found→404, slug_exhausted/
 *     clone_dest_exists*→409, clone_auth_required→401, clone_not_found→404,
 *     else→502; malformed body (no githubUrl)→400 invalid_url; bogus visibility
 *     coerced to 'public'.
 *   Gap 8 — POST /harness/pots (createHive, :423-461): invalid slug→400
 *     invalid_slug, slug_exists/dest_exists→409, other error→400.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The routes dynamic-import these inside the handler — mock the modules so the
// composition never runs (no clone, no PG, no registry mutation).
const createHiveFromRepo = vi.fn();
const createHiveHarness = vi.fn();
const loadHarnessRegistry = vi.fn();
const mutateHarnessRegistry = vi.fn();
const teardownPotLearningLoop = vi.fn();

vi.mock('../../../agent-tools/pot/_create_from_repo', () => ({
  createPotFromRepo: (...a: unknown[]) => createHiveFromRepo(...a),
}));
vi.mock('../../../agent-tools/pot/_create', () => ({
  createPotHarness: (...a: unknown[]) => createHiveHarness(...a),
}));
vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-test',
}));
vi.mock('../../../harness-registry', async (orig) => ({
  ...(await orig<typeof import('../../../harness-registry')>()),
  loadHarnessRegistry: (...a: unknown[]) => loadHarnessRegistry(...a),
  mutateHarnessRegistry: (...a: unknown[]) => mutateHarnessRegistry(...a),
}));
vi.mock('../../../pot/provision-learning-loop', () => ({
  teardownPotLearningLoop: (...a: unknown[]) => teardownPotLearningLoop(...a),
}));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: vi.fn() }),
}));
vi.mock('../../../harness/projects-lite', () => ({
  bustProjectsLiteCache: vi.fn(),
  buildProjectsLitePayload: vi.fn(async () => ({ projects: [] })),
}));

import routes from './projects';

const byPath = (path: string) => {
  const r = (routes as Array<{ path: string }>).find((x) => x.path === path);
  if (!r) throw new Error(`no route for ${path}`);
  return r as unknown as { path: string; auth?: string; handler: (req: Request, ctx: unknown) => Promise<Response> };
};

const fromRepoRoute = byPath('/harness/pots/from-repo');
const createHiveRoute = byPath('/harness/pots');
const deleteProjectRoute = (() => {
  const route = (routes as Array<{ path: string; method: string; handler: (req: Request, ctx: unknown) => Promise<Response> }>).find(
    (x) => x.path === '/harness/projects/:slug' && x.method === 'DELETE',
  );
  if (!route) throw new Error('no DELETE route for /harness/projects/:slug');
  return route;
})();

async function post(
  route: { path: string; handler: (req: Request, ctx: unknown) => Promise<Response> },
  body: unknown,
  { raw }: { raw?: string } = {},
) {
  const req = new Request('http://127.0.0.1/api' + route.path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw !== undefined ? raw : JSON.stringify(body),
  });
  const res = await route.handler(req, {});
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

async function removeProject(slug: string) {
  const req = new Request(`http://127.0.0.1/api/harness/projects/${slug}`, { method: 'DELETE' });
  const res = await deleteProjectRoute.handler(req, { params: { slug } });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

beforeEach(() => {
  createHiveFromRepo.mockReset();
  createHiveHarness.mockReset();
  loadHarnessRegistry.mockReset().mockResolvedValue({ projects: [{ slug: 'gone', path: '/tmp/gone' }] });
  mutateHarnessRegistry.mockReset().mockImplementation(async (mutator: (reg: { projects: Array<{ slug: string; path: string }> }) => unknown) => {
    await mutator({ projects: [{ slug: 'gone', path: '/tmp/gone' }] });
  });
  teardownPotLearningLoop.mockReset().mockResolvedValue({
    potSlug: 'gone',
    gymAutoloop: true,
    scoutRoutine: true,
    dreamRoutines: true,
    governorRegistrants: true,
    gitSyncRoutines: true,
  });
});

// ── Gap 7: POST /harness/pots/from-repo status map ──────────────────────────
describe('POST /api/harness/pots/from-repo — error→status map (Gap 7)', () => {
  it('declares the loopback auth tier (mutating route, Wave 1)', () => {
    expect(fromRepoRoute.auth).toBe('loopback');
  });

  it.each([
    ['invalid_url', 400],
    ['invalid_slug', 400],
    ['hive_not_found', 404],
    ['slug_exhausted', 409],
    ['clone_dest_exists', 409],
    ['clone_dest_exists: /tmp/x already exists', 409], // startsWith match
    ['clone_auth_required', 401],
    ['clone_not_found', 404],
    ['clone_git_missing', 502], // unmapped clone_* → fallthrough 502
    ['something_unexpected', 502],
  ])('maps error %s → HTTP %i', async (error, status) => {
    createHiveFromRepo.mockResolvedValue({ ok: false, error, message: `msg:${error}` });
    const { status: got, body } = await post(fromRepoRoute, { githubUrl: 'https://github.com/o/r' });
    expect(got).toBe(status);
    expect(body).toMatchObject({ code: error });
    expect(createHiveFromRepo).toHaveBeenCalledTimes(1);
  });

  it('passes res.cleanup through on a failure that carries it', async () => {
    createHiveFromRepo.mockResolvedValue({ ok: false, error: 'something', message: 'm', cleanup: ['/tmp/a'] });
    const { body } = await post(fromRepoRoute, { githubUrl: 'https://github.com/o/r' });
    expect(body).toMatchObject({ cleanup: ['/tmp/a'] });
  });

  it('falls back to res.error as the message when message is absent', async () => {
    createHiveFromRepo.mockResolvedValue({ ok: false, error: 'invalid_url' });
    const { status, body } = await post(fromRepoRoute, { githubUrl: 'https://github.com/o/r' });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'invalid_url', code: 'invalid_url' });
  });

  it('400s invalid_url for a missing githubUrl WITHOUT touching the composition', async () => {
    const { status, body } = await post(fromRepoRoute, {});
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'invalid_url' });
    expect(createHiveFromRepo).not.toHaveBeenCalled();
  });

  it('400s invalid_url for a malformed (non-JSON) body without touching the composition', async () => {
    const { status, body } = await post(fromRepoRoute, undefined, { raw: 'not json{' });
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'invalid_url' });
    expect(createHiveFromRepo).not.toHaveBeenCalled();
  });

  it.each(['private', 'invite', 'public', 'bogus'])(
    'IGNORES a client-sent visibility (%s) — visibility is derived from repo privacy server-side',
    async (vis) => {
      // hive-visibility-from-repo-privacy: the client no longer chooses visibility;
      // createHiveFromRepo derives it from the resolved repo's `private` flag. The
      // route must NOT forward a client-sent `visibility` (any value is dropped).
      createHiveFromRepo.mockResolvedValue({ ok: true, created: { potSlug: 'r', memberSlug: 'r', memberPath: '/p' } });
      await post(fromRepoRoute, { githubUrl: 'https://github.com/o/r', visibility: vis });
      expect(createHiveFromRepo).toHaveBeenCalledTimes(1);
      expect(createHiveFromRepo.mock.calls[0][0]).not.toHaveProperty('visibility');
    },
  );

  it('returns the success envelope (200) on ok', async () => {
    const created = { ok: true, created: { potSlug: 'repo', memberSlug: 'repo', memberPath: '/p' } };
    createHiveFromRepo.mockResolvedValue(created);
    const { status, body } = await post(fromRepoRoute, { githubUrl: 'https://github.com/o/repo' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true });
  });

  // P-017 (pot-review-integration-mode-2026-10-05, D-007): the creation-time
  // "where should the agents' work go" answer reaches the composition.
  it.each(['direct', 'review'] as const)('forwards integrationMode=%s to createPotFromRepo', async (mode) => {
    createHiveFromRepo.mockResolvedValue({ ok: true, created: { potSlug: 'r', memberSlug: 'r', memberPath: '/p' } });
    await post(fromRepoRoute, { githubUrl: 'https://github.com/o/r', integrationMode: mode });
    expect(createHiveFromRepo.mock.calls[0][0]).toMatchObject({ integrationMode: mode });
  });

  it.each([undefined, 'bogus', '', 7])('omits integrationMode for an unanswered/unknown value (%s)', async (mode) => {
    createHiveFromRepo.mockResolvedValue({ ok: true, created: { potSlug: 'r', memberSlug: 'r', memberPath: '/p' } });
    await post(fromRepoRoute, { githubUrl: 'https://github.com/o/r', integrationMode: mode });
    expect(createHiveFromRepo.mock.calls[0][0]).not.toHaveProperty('integrationMode');
  });
});

// ── Gap 8: POST /harness/pots status map ────────────────────────────────────
describe('POST /api/harness/pots — createHive error→status map (Gap 8)', () => {
  it('declares the loopback auth tier', () => {
    expect(createHiveRoute.auth).toBe('loopback');
  });

  it.each([
    ['', 'empty slug'],
    ['Bad_Slug', 'uppercase/underscore'],
    ['-leading', 'leading dash'],
    ['has space', 'whitespace'],
  ])('400s invalid_slug for %s (%s) WITHOUT touching createHiveHarness', async (slug) => {
    const { status, body } = await post(createHiveRoute, { slug });
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'invalid_slug' });
    expect(createHiveHarness).not.toHaveBeenCalled();
  });

  it('400s invalid_slug for a malformed (non-JSON) body', async () => {
    const { status, body } = await post(createHiveRoute, undefined, { raw: '{bad' });
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'invalid_slug' });
    expect(createHiveHarness).not.toHaveBeenCalled();
  });

  it.each([
    ['slug_exists', 409],
    ['dest_exists', 409],
    ['blueprint_invalid', 400],
    ['not_a_hive_blueprint', 400],
    ['create_failed', 400],
  ])('maps createHive error %s → HTTP %i', async (error, status) => {
    createHiveHarness.mockResolvedValue({ ok: false, error, message: `m:${error}` });
    const { status: got, body } = await post(createHiveRoute, { slug: 'good-slug' });
    expect(got).toBe(status);
    expect(body).toMatchObject({ code: error });
    expect(createHiveHarness).toHaveBeenCalledTimes(1);
  });

  it('returns the success envelope (200) with hive:true on ok', async () => {
    createHiveHarness.mockResolvedValue({ ok: true, slug: 'good-slug', path: '/p', waked: false });
    const { status, body } = await post(createHiveRoute, { slug: 'good-slug' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, hive: true, project: { slug: 'good-slug', path: '/p' } });
  });

  // LINK-EXISTING ("every created Pot is a hive"): a `path` body field links an
  // existing local repo in place (existingPath); `parentDir` provisions a fresh dir.
  it('passes existingPath when the body carries a path (link-in-place)', async () => {
    createHiveHarness.mockResolvedValue({ ok: true, slug: 'good-slug', path: '/repo', waked: false });
    await post(createHiveRoute, { slug: 'good-slug', path: '  /home/me/repo  ' });
    expect(createHiveHarness).toHaveBeenCalledTimes(1);
    const arg = createHiveHarness.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toMatchObject({ slug: 'good-slug', existingPath: '/home/me/repo' }); // trimmed
    expect(arg).not.toHaveProperty('parentDir'); // link mode does not also pass parentDir
  });

  it('passes parentDir (no existingPath) when the body carries parentDir but no path (fresh dir)', async () => {
    createHiveHarness.mockResolvedValue({ ok: true, slug: 'good-slug', path: '/p', waked: false });
    await post(createHiveRoute, { slug: 'good-slug', parentDir: '/home/me/hives' });
    expect(createHiveHarness).toHaveBeenCalledTimes(1);
    const arg = createHiveHarness.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toMatchObject({ slug: 'good-slug', parentDir: '/home/me/hives' });
    expect(arg).not.toHaveProperty('existingPath');
  });

  it('maps path_not_found → 400 (link target missing)', async () => {
    createHiveHarness.mockResolvedValue({ ok: false, error: 'path_not_found', message: 'm:path_not_found' });
    const { status, body } = await post(createHiveRoute, { slug: 'good-slug', path: '/no/such/dir' });
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'path_not_found' });
  });

  // domain-generic-hive P-006: the picker's domain headings (work hive,
  // Comb-blueprint) pass a non-default kind:'hive' blueprint id; absent ⇒
  // createHiveHarness's own default (the coding `hive`).
  it('passes a trimmed blueprintId through when the body carries one', async () => {
    createHiveHarness.mockResolvedValue({ ok: true, slug: 'good-slug', path: '/p', waked: false });
    await post(createHiveRoute, { slug: 'good-slug', parentDir: '/h', blueprintId: '  work  ' });
    expect(createHiveHarness).toHaveBeenCalledTimes(1);
    const arg = createHiveHarness.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toMatchObject({ slug: 'good-slug', blueprintId: 'work' }); // trimmed
  });

  it('omits blueprintId (createHiveHarness defaults to coding) when the body has none', async () => {
    createHiveHarness.mockResolvedValue({ ok: true, slug: 'good-slug', path: '/p', waked: false });
    await post(createHiveRoute, { slug: 'good-slug', parentDir: '/h' });
    expect(createHiveHarness).toHaveBeenCalledTimes(1);
    const arg = createHiveHarness.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty('blueprintId');
  });
});

describe('DELETE /api/harness/projects/:slug — explicit uninstall retirement seam', () => {
  it('retires install-scoped learning/infrastructure rows before atomically removing the registry entry', async () => {
    const { status, body } = await removeProject('gone');

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(teardownPotLearningLoop).toHaveBeenCalledWith({
      sql: expect.any(Function),
      workspaceId: 'ws-test',
      potSlug: 'gone',
    });
    expect(mutateHarnessRegistry).toHaveBeenCalledWith(expect.any(Function), 'ws-test', { allowEmpty: true });
    expect(teardownPotLearningLoop.mock.invocationCallOrder[0]).toBeLessThan(
      mutateHarnessRegistry.mock.invocationCallOrder[0],
    );
  });

  it('keeps the registry entry when any routine retirement step fails so removal can be retried', async () => {
    teardownPotLearningLoop.mockResolvedValueOnce({
      potSlug: 'gone',
      gymAutoloop: true,
      scoutRoutine: true,
      dreamRoutines: false,
      governorRegistrants: true,
      gitSyncRoutines: true,
    });

    const { status, body } = await removeProject('gone');

    expect(status).toBe(503);
    expect(body).toEqual({ error: 'routine retirement incomplete', failed: ['dreamRoutines'] });
    expect(mutateHarnessRegistry).not.toHaveBeenCalled();
  });

  it('does not retire routines when the registry has no matching harness', async () => {
    const { status, body } = await removeProject('missing');

    expect(status).toBe(404);
    expect(body).toEqual({ error: 'not found' });
    expect(teardownPotLearningLoop).not.toHaveBeenCalled();
    expect(mutateHarnessRegistry).not.toHaveBeenCalled();
  });
});
