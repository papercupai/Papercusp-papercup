// @vitest-environment jsdom
/**
 * usePlan.test.tsx — the read/edit split for the one plan-body hook
 * (data-sync-push-completion P-011).
 *
 * usePlan has TWO consumption modes, chosen by `opts.live`:
 *   - `live: true`  → the read-only consumers (PlanItemPreview): subscribe to
 *     the LIVE `useSyncQuery({ queryName:'plans.get', args:{slug,mode:'full'} })`
 *     so a `plans:*` write pushes a fresh row over SSE. data === row[0].
 *   - `live: false` (default) → PlanDetail's Vditor editor: a guarded ONE-SHOT
 *     `fetchPlan` (REST), with `refresh()` + `setData()` the editor drives
 *     itself. A live re-fire mid-edit would clobber the user's draft, so the
 *     editor MUST NOT subscribe.
 *
 * This pins: (a) the live path subscribes with the right queryName/args and
 * is `enabled`, returns row[0], and exposes NO setData; (b) the default path
 * does NOT subscribe (`enabled:false`) and instead hits the REST fetch, and
 * exposes setData (the optimistic-patch seam the editor uses).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';

// Capture every useSyncQuery call so we can assert queryName/args/enabled, and
// drive its returned rows. A disabled query yields no data (mirror real impl).
type SyncCall = { queryName: string; args?: unknown; enabled?: boolean };
const syncCalls: SyncCall[] = [];
let syncRows: unknown[] = [];
const invalidateSpy = vi.fn();
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: (opts: SyncCall) => {
    syncCalls.push(opts);
    if (opts.enabled === false) {
      return { data: undefined, loading: false, error: null, fetching: false, invalidate: invalidateSpy };
    }
    return { data: syncRows, loading: false, error: null, fetching: false, invalidate: invalidateSpy };
  },
}));

import { usePlan, type AsyncResult, type PlanGetResult } from './plans-api';

/** Drive the hook from a throwaway component, surfacing its result. */
function HookProbe({
  slug,
  live,
  sink,
}: {
  slug: string | null;
  live?: boolean;
  sink: (r: AsyncResult<PlanGetResult | null>) => void;
}) {
  sink(usePlan(slug, live === undefined ? undefined : { live }));
  return null;
}

describe('usePlan — read-only (live) vs editor (one-shot) split', () => {
  beforeEach(() => {
    syncCalls.length = 0;
    syncRows = [];
    invalidateSpy.mockReset();
    vi.restoreAllMocks();
  });
  afterEach(cleanup);

  it('live:true subscribes to plans.get with {slug,mode:full}, enabled, and returns row[0]', async () => {
    syncRows = [{ slug: 'auth-rework', raw: '# Body', archived: false } as PlanGetResult];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    let result: AsyncResult<PlanGetResult | null> | null = null;

    render(<HookProbe slug="auth-rework" live sink={(r) => (result = r)} />);

    const call = syncCalls.find((c) => c.queryName === 'plans.get');
    expect(call).toBeTruthy();
    expect(call?.args).toEqual({ slug: 'auth-rework', mode: 'full' });
    expect(call?.enabled).toBe(true);
    // data is the resolver row array's first element (resolver returns [r]).
    expect((result as unknown as AsyncResult<PlanGetResult | null>)!.data).toEqual({
      slug: 'auth-rework',
      raw: '# Body',
      archived: false,
    });
    // Read-only: no optimistic-patch seam, and no REST round-trip.
    expect((result as unknown as AsyncResult<PlanGetResult | null>)!.setData).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('live path: refresh() maps to the sync invalidate()', () => {
    let result: AsyncResult<PlanGetResult | null> | null = null;
    render(<HookProbe slug="p1" live sink={(r) => (result = r)} />);
    (result as unknown as AsyncResult<PlanGetResult | null>)!.refresh();
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it('default (editor) path does NOT subscribe live and hits the REST fetch + exposes setData', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ slug: 'p1', raw: '# X', archived: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    let result: AsyncResult<PlanGetResult | null> | null = null;

    render(<HookProbe slug="p1" sink={(r) => (result = r)} />);

    // The plans.get sync subscription, if mounted at all, is disabled (no live).
    const liveCall = syncCalls.find((c) => c.queryName === 'plans.get');
    expect(liveCall?.enabled).toBe(false);

    // The editor path round-trips REST and exposes the optimistic-patch seam.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const url = String((fetchSpy.mock.calls[0]?.[0] as URL | string) ?? '');
    expect(url).toContain('/api/admin/plans/get');
    expect(url).toContain('mode=full');
    expect(url).toContain("includeEnrichments=false");
    expect(typeof (result as unknown as AsyncResult<PlanGetResult | null>)!.setData).toBe('function');
  });

  it("renders the first body before a one-shot decoration read, then merges badges without a live subscription", async () => {
    let finishDecorations!: (response: Response) => void;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            slug: "p1",
            version: 3,
            raw: "# Body",
            items: [{ id: "P-001", effectiveStatus: "todo" }],
            enrichmentsDeferred: true,
          }),
        ),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishDecorations = resolve;
          }),
      );
    let result: AsyncResult<PlanGetResult | null> | null = null;
    render(<HookProbe slug="p1" sink={(r) => (result = r)} />);

    await waitFor(() =>
      expect(
        (result as unknown as AsyncResult<PlanGetResult | null>)!.data?.raw,
      ).toBe("# Body"),
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(
      (result as unknown as AsyncResult<PlanGetResult | null>)!.data
        ?.enrichmentsDeferred,
    ).toBe(true);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
      "includeEnrichments=false",
    );
    expect(String(fetchSpy.mock.calls[1]?.[0])).not.toContain(
      "includeEnrichments=false",
    );
    expect(syncCalls.every((call) => call.enabled === false)).toBe(true);

    finishDecorations(
      new Response(
        JSON.stringify({
          slug: "p1",
          version: 3,
          raw: "# Body",
          items: [{ id: "P-001", effectiveStatus: "blocked" }],
          linkedFeatures: { "P-001": { featureId: "WI-1", status: "open" } },
        }),
      ),
    );
    await waitFor(() =>
      expect(
        (result as unknown as AsyncResult<PlanGetResult | null>)!.data
          ?.enrichmentsDeferred,
      ).toBe(false),
    );
    expect(
      (result as unknown as AsyncResult<PlanGetResult | null>)!.data?.items?.[0]
        ?.effectiveStatus,
    ).toBe("blocked");
    expect(
      (result as unknown as AsyncResult<PlanGetResult | null>)!.data
        ?.linkedFeatures?.["P-001"]?.featureId,
    ).toBe("WI-1");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(syncCalls.every((call) => call.enabled === false)).toBe(true);
  });

  it('dispatches the editor read before a preceding sibling flushes computed styles in a passive effect', async () => {
    const events: string[] = [];
    let requestSignal: AbortSignal | undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      requestSignal = init?.signal ?? undefined;
      events.push('request');
      return new Response(JSON.stringify({ slug: 'p1', raw: '# Body' }));
    });
    function PresenceEffect() {
      useEffect(() => {
        // Radix Presence reads a live computed style here. This synchronous
        // work must not be a prerequisite for starting the plan request.
        events.push('style-read');
      }, []);
      return null;
    }

    const view = render(<><PresenceEffect /><HookProbe slug="p1" sink={() => {}} /></>);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(events).toEqual(['request', 'style-read']);
    expect(requestSignal?.aborted).toBe(false);
    view.unmount();
    expect(requestSignal?.aborted).toBe(true);
  });

  it('null slug: live path stays quiet (disabled) and returns null data', () => {
    let result: AsyncResult<PlanGetResult | null> | null = null;
    render(<HookProbe slug={null} live sink={(r) => (result = r)} />);
    const call = syncCalls.find((c) => c.queryName === 'plans.get');
    expect(call?.enabled).toBe(false);
    expect((result as unknown as AsyncResult<PlanGetResult | null>)!.data).toBeNull();
  });
});
