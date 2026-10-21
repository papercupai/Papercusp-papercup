/**
 * POST /api/admin/plan-item-type-fields (plan-item-types-registry-cupboard-2026-10-20 P-007, R-20):
 * the Plans-pane completion form's submit. Verifies the request parsing (400s), the scope it hands
 * `checkPlanItemTypeFields`, that a refusal is answered 200 with its errors, and 404 for an unknown
 * plan or item. The check itself is the real one in item-type-view.integration.test.ts; here only
 * the CORS and the check boundaries are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/agent-mcp';

vi.mock('../../cors', () => ({ requireAllowedOriginOr403: () => null }));

const h = vi.hoisted(() => ({ checkPlanItemTypeFields: vi.fn() }));
vi.mock('../../../plan-types/item-type-view', () => ({ checkPlanItemTypeFields: h.checkPlanItemTypeFields }));

import routes, { planItemTypeFieldsHandler } from './plan-item-type-fields';

const ctx = {} as RouteContext;

function post(body: unknown): Request {
  return new Request('http://127.0.0.1/api/admin/plan-item-type-fields', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  h.checkPlanItemTypeFields.mockReset();
});

describe('POST /admin/plan-item-type-fields', () => {
  it('is one POST route on the VTL trust tier', () => {
    expect(routes).toHaveLength(1);
    const route = routes[0] as unknown as { method: string; path: string; auth: { trust: string[] } };
    expect(route.method).toBe('POST');
    expect(route.path).toBe('/admin/plan-item-type-fields');
    expect(route.auth.trust).toEqual(['verified', 'trusted', 'unverified-loopback']);
  });

  it('checks the fields against the named plan item and answers the check', async () => {
    h.checkPlanItemTypeFields.mockResolvedValue({ ok: true });
    const res = await planItemTypeFieldsHandler(
      post({ slug: 'memo-plan', harness: 'papercusp', itemId: 'P-002', typeFields: { pages: 3 } }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true });
    expect(h.checkPlanItemTypeFields).toHaveBeenCalledWith({
      planSlug: 'memo-plan',
      harnessSlug: 'papercusp',
      itemId: 'P-002',
      typeFields: { pages: 3 },
    });
  });

  it('answers a schema refusal with 200 and its errors', async () => {
    const refusal = { ok: false, code: 'type_fields_invalid', errors: ['pages: must be >= 1'] };
    h.checkPlanItemTypeFields.mockResolvedValue(refusal);
    const res = await planItemTypeFieldsHandler(post({ slug: 'memo-plan', itemId: 'P-002', typeFields: { pages: 0 } }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(refusal);
    expect(h.checkPlanItemTypeFields.mock.calls[0]![0]).not.toHaveProperty('harnessSlug');
  });

  it.each(['plan_not_found', 'plan_item_not_found'])('answers %s with 404', async (code) => {
    h.checkPlanItemTypeFields.mockResolvedValue({ ok: false, code, errors: ['missing'] });
    const res = await planItemTypeFieldsHandler(post({ slug: 'nope', itemId: 'P-009', typeFields: {} }), ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code });
  });

  it.each([
    ['malformed JSON', '{not json', 'Invalid request JSON'],
    ['a missing slug', { itemId: 'P-001', typeFields: {} }, 'slug is required'],
    ['a non-item id', { slug: 'p', itemId: 'WI-1', typeFields: {} }, 'itemId must be a plan item id (P-NNN)'],
    ['array typeFields', { slug: 'p', itemId: 'P-001', typeFields: [] }, 'typeFields must be an object'],
    ['a non-string harness', { slug: 'p', harness: 3, itemId: 'P-001', typeFields: {} }, 'harness must be a string'],
  ])('refuses %s with 400 before running the check', async (_label, body, error) => {
    const res = await planItemTypeFieldsHandler(post(body), ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error });
    expect(h.checkPlanItemTypeFields).not.toHaveBeenCalled();
  });
});
