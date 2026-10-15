/**
 * Regression test for the endpoint-route audit (2026-05-20, third pass).
 *
 * The bug: Hono resolves overlapping routes by *registration order* — it
 * has no static-over-dynamic precedence (Next.js file routing did). A
 * `defineTool` handler never calls `next()`, so a parametric route
 * registered before a literal sibling swallows it outright. The audit
 * found `GET /api/marketplace/:slug` (registered first) shadowing
 * `GET /api/marketplace/spawnable` — the latter 404'd in the real app.
 *
 * `register.ts` now sorts each phase literal-before-param. This test
 * asserts the invariant against the EXACT order the app mounts
 * (`routeRegistrationOrder()`): no parametric route is registered before
 * a literal route it would shadow. It fails if anyone removes the
 * specificity sort or adds a colliding route the sort can't separate.
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
// A route can load before the registry in a shared fork. Exercise that entry
// order: the plugin catch-all imports the 405 resolver, which reads the registry.
import pluginCatchall from '../routes/plugins/catchall';
import { ALL_ROUTES } from '../routes';
import { routeRegistrationOrder, registerAllRoutes } from '../register';

// The route stack records PostgreSQL telemetry in its finally block. This
// invariant test exercises real route responses but must not open a real DB write.
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

/** Path → segment list (basePath-relative). */
function segs(p: string): string[] {
  return p.replace(/^\//, '').split('/');
}

/**
 * Does parametric pattern `a` shadow the more-literal path `b`?
 * True when: same arity, every `a` segment is either literal-equal to
 * `b`'s or a `:param`, AND at ≥1 position `a` has a `:param` where `b`
 * has a literal (so `b` is a strict specialization `a` would swallow).
 * Wildcard (`*`) routes are excluded — they are intentional catch-alls.
 */
function shadows(a: string, b: string): boolean {
  if (a === b || a.includes('*') || b.includes('*')) return false;
  const A = segs(a);
  const B = segs(b);
  if (A.length !== B.length) return false;
  let sawParamOverLiteral = false;
  for (let i = 0; i < A.length; i++) {
    if (A[i].startsWith(':')) {
      if (!B[i].startsWith(':')) sawParamOverLiteral = true;
      continue;
    }
    if (A[i] !== B[i]) return false;
  }
  return sawParamOverLiteral;
}

describe('route registration order — no parametric route shadows a literal sibling', () => {
  it('retains the plugin catch-all when its module loads before the registry', () => {
    const catchalls = Array.isArray(pluginCatchall) ? pluginCatchall : [pluginCatchall];
    for (const route of catchalls) expect(ALL_ROUTES).toContain(route);
    expect(ALL_ROUTES.every((route) => route != null)).toBe(true);
  });

  it('every literal route registers before any parametric route that would swallow it', () => {
    const order = routeRegistrationOrder();
    const violations: string[] = [];
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const earlier = order[i];
        const later = order[j];
        if (earlier.method !== later.method) continue;
        // `earlier` (parametric) registered before `later` (literal) and
        // would swallow it — the exact bug class the audit found.
        if (shadows(earlier.path, later.path)) {
          violations.push(
            `[${earlier.method}] ${earlier.path} (reg #${i}) shadows literal ${later.path} (reg #${j})`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  // (The original `/marketplace/:slug` ↔ `/marketplace/spawnable` collision case
  // was removed when the legacy `:3057` marketplace `/marketplace/:slug` route was
  // retired — revive-cupboard-distribution D-004. `/marketplace/spawnable` survives
  // as a literal-only route with no parametric sibling, so there's nothing to
  // shadow it; the generic invariant above still guards every route.)

  it('registerAllRoutes mounts cleanly (no duplicate-route throw)', () => {
    const app = new Hono().basePath('/api');
    expect(() => registerAllRoutes(app)).not.toThrow();
  });

  it('resolves wrong plugin methods after loading the registry and preserves unknown-path 404s', async () => {
    const app = new Hono().basePath('/api');
    registerAllRoutes(app);
    const wrongMethod = await app.request('/api/plugins/global', { method: 'DELETE' });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')?.split(', ')).toContain('GET');
    const unknownPath = await app.request('/api/plugins/__route_invariant_missing__', { method: 'DELETE' });
    expect(unknownPath.status).toBe(404);
  });
});
