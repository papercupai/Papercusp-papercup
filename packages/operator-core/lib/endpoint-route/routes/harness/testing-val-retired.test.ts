/**
 * verification-system-improvements-2026-10-10 P-003 — the retired VAL-* routes.
 *
 * SPEC-P-003-VAL-WRITERS: the former route WRITER of the legacy VAL-* assertion store
 * (POST /harness/:slug/testing/assertions/:valId) must answer with the typed
 * `val-write-retired` refusal (HTTP 410) and write nothing.
 * SPEC-P-003-VAL-READERS: the former route READERS must answer with the typed
 * `val-read-retired` refusal (HTTP 410) and read nothing.
 *
 * "Touches no store" is measured, not assumed: the org Postgres accessor is replaced by
 * a spy that records every call, and each case asserts the spy stayed at zero.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-test',
}));

const pgCalls: string[] = [];
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const record = (name: string) => () => {
    pgCalls.push(name);
    throw new Error(`retired VAL route touched the store via ${name}`);
  };
  return {
    ...actual,
    getOrgPg: record('getOrgPg'),
    getOrgPgApp: record('getOrgPgApp'),
  };
});

import testingRoutes from './testing';
import assertionRoute from './assertion';
import { VAL_RETIREMENT_REFUSAL_CODES } from '../../../agent-tools/plans/val-retirement';

type Route = {
  method: string;
  path: string;
  handler: (req: Request, ctx: { params: Record<string, string> }) => Promise<Response>;
};

const routes = [...(testingRoutes as unknown as Route[]), assertionRoute as unknown as Route];

function route(method: string, path: string): Route {
  const found = routes.find((r) => r.method === method && r.path === path);
  if (!found) throw new Error(`route ${method} ${path} is not registered`);
  return found;
}

async function call(method: string, path: string, params: Record<string, string>) {
  const url = `http://127.0.0.1/api${path.replace(/:(\w+)/g, (_m, k: string) => params[k] ?? k)}`;
  const req = new Request(url, { method, ...(method === 'POST' ? { body: '{"status":"pass"}' } : {}) });
  const res = await route(method, path).handler(req, { params });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  pgCalls.length = 0;
});

describe('retired VAL-* writer route (SPEC-P-003-VAL-WRITERS)', () => {
  it('POST /harness/:slug/testing/assertions/:valId refuses with val-write-retired (410) and writes nothing', async () => {
    const { status, body } = await call('POST', '/harness/:slug/testing/assertions/:valId', {
      slug: 'my-hive',
      valId: 'VAL-7',
    });
    expect(status).toBe(410);
    expect(body).toMatchObject({ ok: false, code: 'val-write-retired', httpStatus: 410 });
    expect(String(body.message)).toContain('requested VAL-7');
    expect(String(body.repair)).toContain('plans:bind-spec-evidence');
    expect(pgCalls).toEqual([]);
  });
});

describe('retired VAL-* reader routes (SPEC-P-003-VAL-READERS)', () => {
  const readers: Array<[string, string, Record<string, string>]> = [
    ['GET', '/harness/:slug/testing/assertions', { slug: 'my-hive' }],
    ['GET', '/harness/:slug/plan-items-test-status', { slug: 'my-hive' }],
    ['GET', '/harness/:slug/assertion/:valId', { slug: 'my-hive', valId: 'VAL-7' }],
  ];

  it.each(readers)('%s %s refuses with val-read-retired (410) and reads nothing', async (method, path, params) => {
    const { status, body } = await call(method, path, params);
    expect(status).toBe(410);
    expect(body).toMatchObject({ ok: false, code: 'val-read-retired', httpStatus: 410 });
    expect(String(body.repair)).toContain('plans:get');
    expect(pgCalls).toEqual([]);
  });

  it('every refusal these routes return is a registered retirement code', async () => {
    const codes = new Set<string>();
    for (const [method, path, params] of readers) codes.add(String((await call(method, path, params)).body.code));
    codes.add(
      String(
        (await call('POST', '/harness/:slug/testing/assertions/:valId', { slug: 'my-hive', valId: 'VAL-7' })).body
          .code,
      ),
    );
    for (const code of codes) expect(VAL_RETIREMENT_REFUSAL_CODES).toContain(code);
  });
});
