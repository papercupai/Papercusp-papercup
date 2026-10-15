/**
 * WI-6554700010011967: POST /admin/psu-pty/quota-starvation turns a pty host's
 * starvation report into fleet:member-quota-starved:<slug>.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fleetSlugOfAgent = vi.fn();
const emitFleetMemberQuotaStarvedEvent = vi.fn();
vi.mock('../../../../fleet-transition-events', () => ({
  fleetSlugOfAgent: (...args: unknown[]) => fleetSlugOfAgent(...args),
  emitFleetMemberQuotaStarvedEvent: (...args: unknown[]) => emitFleetMemberQuotaStarvedEvent(...args),
}));

import route, { parseQuotaStarvationBody } from '../psu-pty-quota-starvation';

function post(body: unknown, query = ''): Request {
  return new Request(`http://127.0.0.1:3070/api/admin/psu-pty/quota-starvation${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function call(req: Request): Promise<Response> {
  // The route default-exports a bare defineTool definition (the routes index
  // accepts either a definition or an array of them), so read .handler off it.
  type RouteDef = { handler: (r: Request, ctx: unknown) => Promise<Response> };
  const exported = route as unknown as RouteDef | RouteDef[];
  const def = Array.isArray(exported) ? exported[0] : exported;
  return def.handler(req, {});
}

describe('parseQuotaStarvationBody', () => {
  it('keeps finite numbers and non-empty strings, nulls everything else', () => {
    expect(
      parseQuotaStarvationBody({
        ownerId: ' su-a ',
        ageMs: 360000,
        attemptedGatedInjections: '3',
        successfulGatedInjections: 0,
        thresholdMs: Number.NaN,
        agent: 'codex',
        accountId: '',
      }),
    ).toEqual({
      ownerId: 'su-a',
      workspace: null,
      signal: {
        blockedSinceMs: null,
        ageMs: 360000,
        thresholdMs: null,
        attemptedGatedInjections: null,
        successfulGatedInjections: 0,
        agent: 'codex',
        accountId: null,
      },
    });
    expect(parseQuotaStarvationBody(null).ownerId).toBeNull();
  });
});

describe('POST /admin/psu-pty/quota-starvation', () => {
  beforeEach(() => {
    fleetSlugOfAgent.mockReset();
    emitFleetMemberQuotaStarvedEvent.mockReset();
  });

  it("resolves the member's fleet in the query workspace and emits the event", async () => {
    fleetSlugOfAgent.mockResolvedValue('enterprise-readiness');
    emitFleetMemberQuotaStarvedEvent.mockResolvedValue(true);
    const res = await call(post({ ownerId: 'su-a', ageMs: 420000, attemptedGatedInjections: 2 }, '?workspace=ws-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, workspace: 'ws-1', fleetSlug: 'enterprise-readiness', emitted: true });
    expect(fleetSlugOfAgent).toHaveBeenCalledWith('ws-1', 'su-a');
    expect(emitFleetMemberQuotaStarvedEvent).toHaveBeenCalledWith(
      'enterprise-readiness',
      'su-a',
      expect.objectContaining({ ageMs: 420000, attemptedGatedInjections: 2 }),
    );
  });

  it('reports emitted:false for a member outside any fleet, without failing', async () => {
    fleetSlugOfAgent.mockResolvedValue(null);
    emitFleetMemberQuotaStarvedEvent.mockResolvedValue(false);
    const res = await call(post({ ownerId: 'su-solo', workspace: 'ws-body' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, workspace: 'ws-body', fleetSlug: null, emitted: false });
  });

  it('rejects a report with no ownerId and fires nothing', async () => {
    const res = await call(post('not json'));
    expect(res.status).toBe(400);
    expect(fleetSlugOfAgent).not.toHaveBeenCalled();
    expect(emitFleetMemberQuotaStarvedEvent).not.toHaveBeenCalled();
  });
});
