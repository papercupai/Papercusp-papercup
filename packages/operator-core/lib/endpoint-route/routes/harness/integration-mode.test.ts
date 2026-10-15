/**
 * P-017 (pot-review-integration-mode-2026-10-05, D-007): the pot-settings route
 * for the ONE question "Where should the agents' work go?". Pins: the GET shows
 * the owner-approved wording with the repo name, the pot's current answer and
 * whether the working copy is selectable; the PUT validates the answer and
 * switches only through choosePotIntegrationMode (the same seam creation uses),
 * passing the pot's home, suite and remotes; refusals come back as 409 with
 * the plain-language message.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { makeIntegrationModeRoutes, repoLabelFromRemote, type IntegrationModeRouteDeps } from './integration-mode';
import { INTEGRATION_MODE_QUESTION } from '../../../harness/git-sync/integration-mode-question';

type RouteLike = { method: string; path: string; handler: (req: Request, ctx: unknown) => Promise<Response> };

const PROJECTS = [
  { slug: 'acme', hive_slug: 'acme', github_remote: 'https://github.com/acme/widgets.git' },
  { slug: 'acme-web', hive_slug: 'acme', github_remote: 'git@github.com:acme/web.git', fork_remote: 'https://github.com/bot/web' },
  { slug: 'solo', self_repo: true, github_remote: 'https://github.com/me/solo' },
  { slug: 'loose' },
];

let deps: { [K in keyof IntegrationModeRouteDeps]-?: ReturnType<typeof vi.fn> };
let get: RouteLike;
let put: RouteLike;

beforeEach(() => {
  deps = {
    loadProjects: vi.fn().mockResolvedValue(PROJECTS),
    workspaceId: vi.fn().mockResolvedValue('ws-1'),
    readMode: vi.fn().mockResolvedValue({ mode: 'direct', source: 'absent' }),
    resolveSuite: vi.fn().mockResolvedValue('npm test'),
    choose: vi.fn().mockResolvedValue({ ok: true, mode: 'review', fork: { url: 'https://github.com/bot/widgets', created: true } }),
    notifySaved: vi.fn().mockResolvedValue(undefined),
  };
  const routes = makeIntegrationModeRoutes(deps as unknown as IntegrationModeRouteDeps) as unknown as RouteLike[];
  get = routes.find((r) => r.method === 'GET')!;
  put = routes.find((r) => r.method === 'PUT')!;
});

async function call(route: RouteLike, slug: string, body?: unknown) {
  const req = new Request(`http://127.0.0.1/api/harness/${slug}/integration-mode`, {
    method: route.method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await route.handler(req, { params: { slug } });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe('repoLabelFromRemote', () => {
  test.each([
    ['https://github.com/acme/widgets.git', 'acme/widgets'],
    ['https://github.com/acme/widgets', 'acme/widgets'],
    ['git@github.com:acme/web.git', 'acme/web'],
    ['https://gitlab.example/x/y.git', 'https://gitlab.example/x/y.git'],
    [undefined, ''],
    ['', ''],
  ])('%s → %s', (remote, label) => {
    expect(repoLabelFromRemote(remote as string | undefined)).toBe(label);
  });
});

describe('GET /harness/:slug/integration-mode', () => {
  test('shows the owner-approved question with the repo name and the current answer', async () => {
    deps.readMode.mockResolvedValue({ mode: 'review', source: 'set' });
    const { status, body } = await call(get, 'acme-web');
    expect(status).toBe(200);
    expect(body.question.prompt).toBe(INTEGRATION_MODE_QUESTION);
    expect(body.question.options.map((o: { label: string }) => o.label)).toEqual([
      'Straight into acme/web',
      'Into a working copy of acme/web',
    ]);
    expect(body.question.options[1].available).toBe(true);
    expect(body.current).toBe('review');
    expect(body.workingCopyUrl).toBe('https://github.com/bot/web');
    // A hive member reads the HOME's setting: the setting is per pot, not per member.
    expect(deps.readMode).toHaveBeenCalledWith('ws-1', 'acme');
  });

  test('a pot with no test suite cannot pick the working copy, with the reason', async () => {
    deps.resolveSuite.mockResolvedValue(null);
    const { body } = await call(get, 'acme');
    const review = body.question.options.find((o: { value: string }) => o.value === 'review');
    expect(review.available).toBe(false);
    expect(review.unavailableReason).toMatch(/no test suite/);
    expect(body.current).toBe('direct');
    expect(body.workingCopyUrl).toBeNull();
  });

  test('a suite-resolver failure leaves the working copy selectable (the PUT re-checks)', async () => {
    deps.resolveSuite.mockRejectedValue(new Error('registry down'));
    const { body } = await call(get, 'acme');
    expect(body.question.options[1].available).toBe(true);
  });

  test('a self-repo pot is its own home', async () => {
    await call(get, 'solo');
    expect(deps.readMode).toHaveBeenCalledWith('ws-1', 'solo');
  });

  test('unknown harness → 404; a non-pot project → 409 not_a_pot', async () => {
    expect((await call(get, 'ghost')).status).toBe(404);
    const loose = await call(get, 'loose');
    expect(loose.status).toBe(409);
    expect(loose.body.error).toBe('not_a_pot');
    expect(deps.readMode).not.toHaveBeenCalled();
  });
});

describe('PUT /harness/:slug/integration-mode', () => {
  test('switching to the working copy goes through choosePotIntegrationMode with the pot facts', async () => {
    const { status, body } = await call(put, 'acme-web', { mode: 'review' });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, mode: 'review', fork: { url: 'https://github.com/bot/widgets', created: true } });
    expect(deps.choose).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      potHomeSlug: 'acme',
      harnessSlug: 'acme-web',
      mode: 'review',
      greenCmd: 'npm test',
      forkRemote: 'https://github.com/bot/web',
      upstreamRemote: 'git@github.com:acme/web.git',
    });
  });

  test('switching back to direct passes mode direct and null remotes when absent', async () => {
    deps.choose.mockResolvedValue({ ok: true, mode: 'direct', fork: null });
    deps.resolveSuite.mockRejectedValue(new Error('down'));
    await call(put, 'solo', { mode: 'direct' });
    expect(deps.choose).toHaveBeenCalledWith(
      expect.objectContaining({ potHomeSlug: 'solo', mode: 'direct', greenCmd: null, forkRemote: null }),
    );
  });

  test.each([[{}], [{ mode: 'fork' }], [{ mode: 'REVIEW' }]])('an invalid answer %j → 400, nothing switched', async (body) => {
    const r = await call(put, 'acme', body);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('mode_required');
    expect(deps.choose).not.toHaveBeenCalled();
  });

  test('a refusal (no test suite) comes back 409 with the plain-language message', async () => {
    deps.choose.mockResolvedValue({ ok: false, error: 'green_cmd_required', message: 'Add a test command first.' });
    const r = await call(put, 'acme', { mode: 'review' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ ok: false, error: 'green_cmd_required', message: 'Add a test command first.' });
  });

  test('a non-pot project is refused before anything is switched', async () => {
    const r = await call(put, 'loose', { mode: 'review' });
    expect(r.status).toBe(409);
    expect(deps.choose).not.toHaveBeenCalled();
  });
});

describe('PUT pushes the live settings read (EI-25188362216785598)', () => {
  test('a saved switch invalidates potIntegration.settings for the harness slug', async () => {
    const r = await call(put, 'acme-web', { mode: 'review' });
    expect(r.status).toBe(200);
    expect(deps.notifySaved).toHaveBeenCalledTimes(1);
    expect(deps.notifySaved).toHaveBeenCalledWith('acme-web');
  });

  test('a refused switch pushes nothing', async () => {
    deps.choose.mockResolvedValueOnce({ ok: false, error: 'test_suite_required', message: 'no suite' });
    const r = await call(put, 'acme-web', { mode: 'review' });
    expect(r.status).toBe(409);
    expect(deps.notifySaved).not.toHaveBeenCalled();
  });

  test('a failed push never fails the save', async () => {
    deps.notifySaved.mockRejectedValueOnce(new Error('bus down'));
    const r = await call(put, 'acme-web', { mode: 'review' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, mode: 'review' });
  });
});
