/**
 * Registry-backed companion to hosted-operator-http.test.ts. Import the service
 * registry during collection here so policy/census selections in that file stay
 * independent, and registry startup never consumes an individual test's budget.
 */
import { describe, expect, it } from 'vitest';
import { ALL_ROUTES } from '../endpoint-route/routes';
import { decideOperatorHttpRoute, OPERATOR_HTTP_ROUTE_ALLOWLIST } from './hosted-operator-http';

describe('OPERATOR_HTTP_ROUTE_ALLOWLIST — awaitsRouteBudget', () => {
  // A route relayed with no header budget is bounded ONLY by the operator route's own
  // watchdog, so each one must resolve to a real route whose timeoutSec is finite
  // (null means "no watchdog" in route-stack.ts).
  const budgeted = OPERATOR_HTTP_ROUTE_ALLOWLIST.filter((entry) => entry.awaitsRouteBudget);

  it('covers the Add-a-pot writes', () => {
    expect(budgeted.map((entry) => entry.surface)).toEqual(expect.arrayContaining(['pot create', 'Cupboard install']));
  });

  it.each(['link-start', 'link-complete'])('lets account %s use its provider watchdog', (operation) => {
    const path = `/api/admin/deploy-accounts/${operation}`;
    expect(decideOperatorHttpRoute('POST', path)).toMatchObject({ ok: true, awaitsRouteBudget: true });
    const route = ALL_ROUTES.find((entry) => entry.method === 'POST' && `/api${entry.path}` === path);
    expect(route?.timeoutSec).toBe(90);
    expect(decideOperatorHttpRoute('POST', '/api/admin/deploy-accounts/link-status'))
      .toMatchObject({ ok: true, awaitsRouteBudget: false });
  });

  it.each(budgeted.map((entry) => [entry.method, entry.surface, entry] as const))(
    '%s %s resolves to an operator route with a finite timeoutSec',
    (_method, _surface, entry) => {
      const matches = ALL_ROUTES.filter(
        (route) => route.method === entry.method && entry.pattern.test(`/api${route.path.replace(/:[^/]+/g, 'x')}`),
      );
      expect(matches.length).toBeGreaterThan(0);
      for (const route of matches) expect(route.timeoutSec).not.toBeNull();
    },
  );
});

describe('native Settings route coverage', () => {
  it('resolves Autonomy save to the existing admin handler, which admits the relayed loopback caller', () => {
    const route = ALL_ROUTES.find((entry) => entry.method === 'POST' && entry.path === '/admin/inbox/:verb');
    // The relay forwards to loopback with no bearer and no cookie (rule 2 in
    // hosted-operator-http.ts), so the operator resolves a relayed save as
    // `unverified-loopback`. A VT-only handler 403s it. That was this route's tier
    // until WI-6554700010009809, while the companion relay tests mock the operator
    // and could not notice. The boundary is the relay allowlist plus the handler's
    // requireAllowedOriginOr403. The desktop webview's bare fetch needs the same tier.
    expect(route).toMatchObject({ auth: { trust: ['verified', 'trusted', 'unverified-loopback'] } });
    expect(decideOperatorHttpRoute('POST', '/api/admin/inbox/automation-policy')).toMatchObject({ ok: true });
  });
});
