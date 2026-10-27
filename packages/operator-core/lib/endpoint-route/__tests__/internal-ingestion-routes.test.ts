/**
 * P-014 (production-readiness-test-coverage) — the 14 token-gated agent-event
 * ingestion sinks under `routes/internal/`. Two guarantees:
 *
 *   1. **Token-gate enforcement (all 14):** every sink rejects an
 *      unauthenticated request — missing OR non-Bearer `Authorization` — with
 *      401, *before* any PG access. This is the attack-surface invariant: none
 *      of the `auth: {}` ingestion routes is accidentally open.
 *   2. **Payload-shape + token depth (representatives):** escalation-event +
 *      pr-event (identical select-token → insert shape) cover the
 *      unknown-token → 401, bad-body → 400, good-body → 200 + persist branches.
 *
 * Routes are mounted on a throwaway Hono app via `registerRoute` and exercised
 * with `app.request()` — the same harness as auth.test.ts. `@papercusp/db-org`
 * and the fire-and-forget notify deps are mocked; the bearer-gate cases return
 * before `getOrgPg` is ever called, so they exercise the real gate logic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
// notifyAttentionOnce too: it is reached statically at import through
// register-system-actions → connected-apps/alert-sweep, and a hand-listed factory that
// omits it fails the whole file at collection.
vi.mock('../../attention-notify', () => ({
  notifyAttention: vi.fn(async () => {}),
  notifyAttentionOnce: vi.fn(async () => {}),
}));
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

// The route-stack's framework auth step (`requirePrincipal` for `auth: {}`)
// is a SEPARATE gate from the per-route harness-token check this file targets;
// it's covered by its own require-principal tests. Neutralise it to a
// passthrough (anonymous principal, never throws) so each request reaches the
// handler and exercises the handler's own `Bearer`-token gate + payload schema.
vi.mock('../../auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => null),
  PrincipalCheckError: class PrincipalCheckError extends Error {
    status = 401;
    reason = 'mocked';
  },
}));

// getOrgPg returns a configurable chainable `db`; `generated` is a nested proxy
// so any table/column ref (`ti.token`, `he.escalation`, …) resolves to a
// harmless stub the mocked query builder ignores.
const getOrgPg = vi.fn();
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: (...a: unknown[]) => getOrgPg(...(a as [])),
  generated: new Proxy({}, { get: () => new Proxy({}, { get: () => ({}) }) }),
  // Agent-MCP task tools are imported by the route stack and build this
  // response-only schema at module load; this test never exercises that path.
  createSelectSchema: () => ({}),
  schemaOf: () => 'harness_shared',
  setAdminPoolStatementTimeoutProvider: vi.fn(),
}));

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';

import archiveEvent from '../routes/internal/archive-event';
import checkpointEvent from '../routes/internal/checkpoint-event';
import decisionEvent from '../routes/internal/decision-event';
import escalationEvent from '../routes/internal/escalation-event';
import featureDebugNoteEvent from '../routes/internal/feature-debug-note-event';
import hookLogEvent from '../routes/internal/hook-log-event';
import identitySnapshot from '../routes/internal/identity-snapshot';
import logEvent from '../routes/internal/log-event';
import prEvent from '../routes/internal/pr-event';
import runChunk from '../routes/internal/run-chunk';
import skillSnapshot from '../routes/internal/skill-snapshot';
import smokeTestEvent from '../routes/internal/smoke-test-event';
import testSnapshot from '../routes/internal/test-snapshot';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

const ROUTES: Array<{ name: string; path: string; def: AnyRoute }> = [
  { name: 'archive-event', path: '/internal/archive-event', def: archiveEvent as AnyRoute },
  { name: 'checkpoint-event', path: '/internal/checkpoint-event', def: checkpointEvent as AnyRoute },
  { name: 'decision-event', path: '/internal/decision-event', def: decisionEvent as AnyRoute },
  { name: 'escalation-event', path: '/internal/escalation-event', def: escalationEvent as AnyRoute },
  { name: 'feature-debug-note-event', path: '/internal/feature-debug-note-event', def: featureDebugNoteEvent as AnyRoute },
  { name: 'hook-log-event', path: '/internal/hook-log-event', def: hookLogEvent as AnyRoute },
  { name: 'identity-snapshot', path: '/internal/identity-snapshot', def: identitySnapshot as AnyRoute },
  { name: 'log-event', path: '/internal/log-event', def: logEvent as AnyRoute },
  { name: 'pr-event', path: '/internal/pr-event', def: prEvent as AnyRoute },
  { name: 'run-chunk', path: '/internal/run-chunk', def: runChunk as AnyRoute },
  { name: 'skill-snapshot', path: '/internal/skill-snapshot', def: skillSnapshot as AnyRoute },
  { name: 'smoke-test-event', path: '/internal/smoke-test-event', def: smokeTestEvent as AnyRoute },
  { name: 'test-snapshot', path: '/internal/test-snapshot', def: testSnapshot as AnyRoute },
];

function appWith(def: AnyRoute): Hono {
  const app = new Hono();
  registerRoute(app, def);
  return app;
}

/**
 * Chainable drizzle-ish stub: `select().from().where().limit()` resolves to
 * `tokenRows`; `insert().values().onConflictDoUpdate()` / `.returning()`
 * resolve harmlessly. Covers the escalation/pr select-token → insert shape.
 */
function makeDb(tokenRows: unknown[]) {
  const sel: Record<string, unknown> = {};
  sel.from = () => sel;
  sel.where = () => sel;
  sel.orderBy = () => sel;
  sel.limit = () => Promise.resolve(tokenRows);
  const ins: Record<string, unknown> = {};
  ins.values = () => ins;
  ins.onConflictDoUpdate = () => Promise.resolve(undefined);
  ins.onConflictDoNothing = () => Promise.resolve(undefined);
  ins.returning = () => Promise.resolve([]);
  const del: Record<string, unknown> = {};
  del.where = () => Promise.resolve(undefined);
  return { select: () => sel, insert: () => ins, delete: () => del, sql: vi.fn() };
}

beforeEach(() => {
  getOrgPg.mockReturnValue({ db: makeDb([]), sql: vi.fn() });
});
afterEach(() => vi.clearAllMocks());

describe('internal ingestion routes — token gate (P-014)', () => {
  for (const r of ROUTES) {
    it(`${r.name} rejects a request with no Authorization header (401)`, async () => {
      const res = await appWith(r.def).request(r.path, { method: 'POST' });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'missing bearer' });
    });

    it(`${r.name} rejects a non-Bearer Authorization header (401)`, async () => {
      const res = await appWith(r.def).request(r.path, {
        method: 'POST',
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      });
      expect(res.status).toBe(401);
    });
  }
});

const authd = (body: unknown) => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', authorization: 'Bearer tok_test' },
});

describe('escalation-event — token + payload depth (P-014)', () => {
  const path = '/internal/escalation-event';
  const app = () => appWith(escalationEvent as AnyRoute);

  it('a valid-shaped but unknown token → 401 invalid bearer', async () => {
    getOrgPg.mockReturnValue({ db: makeDb([]), sql: vi.fn() }); // token lookup empty
    const res = await app().request(path, authd({ escalation: 'help' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid bearer' });
  });

  it('a known token with an empty body → 400 (needs escalation|supervisorNotes)', async () => {
    getOrgPg.mockReturnValue({ db: makeDb([{ harness_slug: 'papercup' }]), sql: vi.fn() });
    const res = await app().request(path, authd({}));
    expect(res.status).toBe(400);
  });

  it('a known token with a valid body → 200 ok', async () => {
    getOrgPg.mockReturnValue({ db: makeDb([{ harness_slug: 'papercup' }]), sql: vi.fn() });
    const res = await app().request(path, authd({ escalation: 'needs your attention' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('pr-event — token + payload depth (P-014)', () => {
  const path = '/internal/pr-event';
  const app = () => appWith(prEvent as AnyRoute);

  it('a valid-shaped but unknown token → 401', async () => {
    getOrgPg.mockReturnValue({ db: makeDb([]), sql: vi.fn() });
    const res = await app().request(path, authd({ featureId: 'F-1', url: 'https://x/pull/1' }));
    expect(res.status).toBe(401);
  });

  it('a known token with a missing required field → 400', async () => {
    getOrgPg.mockReturnValue({ db: makeDb([{ harness_slug: 'papercup' }]), sql: vi.fn() });
    const res = await app().request(path, authd({ featureId: 'F-1' })); // url missing
    expect(res.status).toBe(400);
  });

  it('a known token with a valid body → 200 ok', async () => {
    getOrgPg.mockReturnValue({ db: makeDb([{ harness_slug: 'papercup' }]), sql: vi.fn() });
    const res = await app().request(
      path,
      authd({ featureId: 'F-1', url: 'https://x/pull/1', state: 'open' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

// The VAL-* assertion cache refresh this block used to pin (EI-21437624500324717)
// is RETIRED with the VAL store (verification-system-improvements-2026-10-10
// P-003; see the note in routes/internal/test-snapshot.ts). Pin the retirement:
// a snapshot must neither read nor write harness_plan_assertions, whether its
// payload names covered VALs or it is an empty replacement.
describe('test-snapshot — VAL assertion refresh is retired (verification-system-improvements-2026-10-10 P-003)', () => {
  const path = '/internal/test-snapshot';
  const app = () => appWith(testSnapshot as AnyRoute);

  it('issues no harness_plan_assertions SQL for a covering payload or an empty replacement', async () => {
    const sql = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => [] as unknown[]);
    getOrgPg.mockReturnValue({ db: makeDb([{ harness_slug: 'papercup' }]), sql });

    const covered = await app().request(
      path,
      authd({
        phase: 'staging',
        files: [{ testId: 'covering.test.ts', payload: { status: 'passing', coversVALs: ['VAL-1'] } }],
      }),
    );
    expect(covered.status).toBe(200);
    const empty = await app().request(path, authd({ phase: 'production', files: [] }));
    expect(empty.status).toBe(200);

    const assertionQueries = sql.mock.calls
      .map(([strings]) => strings.join(' '))
      .filter((query) => query.includes('harness_plan_assertions'));
    expect(assertionQueries).toEqual([]);
  });
});
