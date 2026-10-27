/**
 * Admin `/api/admin/plans/:verb` READ-dispatch payload-tier contract (WI-5520).
 *
 * This Hono admin route is the NON-live REST path the operator UI's
 * `usePlan`/`fetchPlan` uses (the PlanDetail popup, the /admin/plans editor).
 * Like its sync-path sibling `callPlansReadRaw` (read-dispatch.test.ts), it has
 * no model-context budget and MUST take the EXPLICIT `payloadTier:'full'`
 * escape hatch out of the payload-tier HARD CEILING (WI-5078 / WI-2859).
 *
 * The regression it pins: without `payloadTier:'full'`, a >30KB `mode:'full'`
 * plan read was force-shaped down to fit the transport cap — the prose body was
 * DROPPED and every item past the first was emptied to `{}`. That produced BOTH
 * reported symptoms of the popup bug: a blank Vditor body (no prose to render)
 * AND a whole-view crash ("This view hit an error") on plans whose items lost
 * their `id` (PlanActions' `previewNextItemId` threw on `id.match(...)`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  calls: [] as Array<{ pathname: string; body: Record<string, unknown>; headers: Record<string, string | undefined> }>,
  invalidate: vi.fn(async (_name: string, _args?: unknown) => {}),
}));

vi.mock('../../../sync-sse', () => ({ notifySyncInvalidate: H.invalidate }));

vi.mock('@papercusp/agent-mcp', async (importActual) => {
  const actual = await importActual<typeof import('@papercusp/agent-mcp')>();
  return {
    ...actual,
    handleHttpToolRequest: vi.fn(
      async (req: { pathname: string; body: Record<string, unknown>; headers: Record<string, string | undefined> }) => {
        H.calls.push({ pathname: req.pathname, body: req.body, headers: req.headers });
        // A minimal single-plan bulk envelope so unwrapBulkGet has something to unwrap.
        return {
          status: 200,
          body: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  results: [{ ok: true, slug: 'demo', prose: '# Demo', items: [] }],
                  counts: { ok: 1, failed: 0 },
                }),
              },
            ],
          },
        };
      },
    ),
  };
});

import routes, { dispatchRead } from './plans';

const reqFor = (verb: string, extraQs = ''): Request =>
  new Request(`http://localhost/api/admin/plans/${verb}?slug=demo&mode=full${extraQs}`);
// The route only reads ctx.params.verb.
const ctxFor = (verb: string) => ({ params: { verb } }) as unknown as Parameters<typeof dispatchRead>[1];

beforeEach(() => {
  H.calls = [];
  H.invalidate.mockClear();
});

describe('admin plans read dispatch — payload-tier contract (WI-5520 / WI-5078)', () => {
  it.each(['GET', 'POST'])('threads the admitted workspace instead of a forged header/query on %s', async method => {
    const verb = method === 'GET' ? 'get' : 'set-archived';
    const request = new Request(`http://localhost:3170/api/admin/plans/${verb}?workspace=forged-query`, {
      method, headers: { origin: 'http://localhost:3170', 'x-papercusp-workspace': 'forged-header',
        'content-type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ slug: 'demo', archived: true }) } : {}),
    });
    const context = { ...ctxFor(verb), principal: { workspaceId: 'admitted-private-workspace' } };
    if (method === 'GET') await dispatchRead(request, context as Parameters<typeof dispatchRead>[1]);
    else await routes[1].handler(request, context as Parameters<typeof dispatchRead>[1]);
    expect(H.calls).toHaveLength(1);
    expect(H.calls[0].headers['x-papercusp-workspace']).toBe('admitted-private-workspace');
    if (method === 'POST') expect(H.invalidate).toHaveBeenCalledWith('plans.get', { slug: 'demo' });
    else expect(H.invalidate).not.toHaveBeenCalled();
  });

  it('get requests the EXPLICIT full tier so the hard ceiling cannot trim the UI read', async () => {
    await dispatchRead(reqFor('get'), ctxFor('get'));
    expect(H.calls).toHaveLength(1);
    expect(H.calls[0].pathname).toBe('/api/agent-tools/plans/get');
    expect(H.calls[0].body.payloadTier).toBe('full');
    // The editor still opts into raw bytes for the set-content CAS round-trip.
    expect(H.calls[0].body.includeRaw).toBe(true);
  });

  it('applies the full tier to every read verb, not just get', async () => {
    await dispatchRead(reqFor('items'), ctxFor('items'));
    await dispatchRead(reqFor('list'), ctxFor('list'));
    expect(H.calls.every((c) => c.body.payloadTier === 'full')).toBe(true);
  });

  it('reads a run transcript without injecting an unsupported harness argument', async () => {
    await dispatchRead(new Request('http://localhost/api/admin/plans/run-transcript?runId=42'), ctxFor('run-transcript'));
    expect(H.calls).toHaveLength(1);
    expect(H.calls[0].pathname).toBe('/api/agent-tools/plans/run-transcript');
    expect(H.calls[0].body).toMatchObject({ runId: '42', payloadTier: 'full' });
    expect(H.calls[0].body).not.toHaveProperty('harness');
  });

  it('omits unused descendant history on the actual popup REST path while preserving the document', async () => {
    const res = await dispatchRead(reqFor('get'), ctxFor('get'));
    expect(H.calls[0].body).toMatchObject({
      mode: 'full', includeRaw: true, includeHistory: false, payloadTier: 'full',
    });
    expect(await res.json()).toEqual({ ok: true, slug: 'demo', prose: '# Demo', items: [] });
  });

  it.each(['true', 'false'])('forwards an explicit includeHistory=%s as a boolean', async (value) => {
    await dispatchRead(reqFor('get', `&includeHistory=${value}`), ctxFor('get'));
    expect(H.calls[0].body.includeHistory).toBe(value === 'true');
  });

  it('preserves explicit history selection and leaves other verbs alone', async () => {
    await dispatchRead(reqFor('get', '&heading=History'), ctxFor('get'));
    await dispatchRead(reqFor('items'), ctxFor('items'));
    expect(H.calls[0].body.heading).toBe('History');
    expect(H.calls[1].body).not.toHaveProperty('includeHistory');
  });

  it('unwraps the single-row get-input-schema bulk response for the admin UI', async () => {
    const res = await dispatchRead(reqFor('get-input-schema'), ctxFor('get-input-schema'));
    const body = await res.json();
    expect(body).toEqual(expect.objectContaining({ ok: true, slug: 'demo' }));
    expect(body.results).toBeUndefined();
  });

  it('respects an explicit lower payloadTier from the query (opt-in shaped reads stay possible)', async () => {
    await dispatchRead(reqFor('get', '&payloadTier=trimmed'), ctxFor('get'));
    expect(H.calls[0].body.payloadTier).toBe('trimmed');
  });
});
