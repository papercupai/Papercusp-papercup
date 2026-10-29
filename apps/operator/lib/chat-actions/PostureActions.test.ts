import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChatModeAction } from './registry';
import { activeModes } from './PostureActions';
import type { ChatActionContext, ChatModeAction, ChatModeOption } from './types';

// WI-7471: GRADE's options() fetches the live rubric set. Mocked at the
// module boundary so every OTHER axis's options() stays a pure sync array and
// this file keeps testing descriptors rather than the sync layer.
const fetchSyncQueryMock = vi.fn();
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  fetchSyncQuery: (...args: unknown[]) => fetchSyncQueryMock(...args) as unknown,
}));

// Side-effect import — registers the four posture mode-actions into the shared
// registry once for this file (same pattern as importing an Entry module from
// lib/chat-actions/index.ts).
import './PostureActions';

const ctx: ChatActionContext = { sessionOwnerId: 'su-abc123' };

/** ctx carrying a set of standing modes, in the roster row's own shape. */
function ctxWithModes(modes: unknown[]): ChatActionContext {
  return { sessionOwnerId: 'su-abc123', modes };
}

const fetchMock = vi.fn();

/**
 * A mode's options as a SYNC array.
 *
 * `options()` returns `ChatModeOption[] | Promise<ChatModeOption[]>` since
 * WI-7471. Every axis except GRADE is still sync, and asserting that is part of
 * the point: an axis that quietly went async would start costing a fetch on
 * menu open. So this narrows AND checks, rather than blanket-awaiting.
 */
function syncOptions(m: ChatModeAction): ChatModeOption[] {
  const opts = m.options(ctx);
  expect(Array.isArray(opts), `${m.id}.options() should still be synchronous`).toBe(true);
  return opts as ChatModeOption[];
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ ok: true }) });
  vi.stubGlobal('fetch', fetchMock);
  fetchSyncQueryMock.mockReset();
  fetchSyncQueryMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PostureActions — registration (P-005: mode-actions, not buttons)', () => {
  it('registers one autonomy axis + one pill per overlay, all in the "posture" group', () => {
    for (const id of ['mode-autonomy', 'mode-ideate', 'mode-drain', 'mode-grade']) {
      const m = getChatModeAction(id);
      expect(m, `${id} should be registered`).toBeDefined();
      expect(m?.group).toBe('posture');
    }
  });

  it('caps are the axis names the pill shows — AUTO, IDEATE, DRAIN, GRADE', () => {
    expect(getChatModeAction('mode-autonomy')?.cap).toBe('AUTO');
    expect(getChatModeAction('mode-ideate')?.cap).toBe('IDEATE');
    expect(getChatModeAction('mode-drain')?.cap).toBe('DRAIN');
    expect(getChatModeAction('mode-grade')?.cap).toBe('GRADE');
  });

  it('every axis is available only when the context carries a sessionOwnerId', () => {
    for (const id of ['mode-autonomy', 'mode-ideate', 'mode-drain', 'mode-grade']) {
      const m = getChatModeAction(id)!;
      expect(m.available(ctx)).toBe(true);
      expect(m.available({ sessionOwnerId: '' })).toBe(false);
    }
  });
});

describe('activeModes — normalising the roster row shape', () => {
  // The roster types modes as Array<HudMode | string>: federation and a
  // mid-deploy SSE push both produce the bare-string form, so a pill that
  // handled only the object form would silently render "off" for an agent that
  // really is in AUTO — the worst possible failure for this control.
  it('reads both the object form and the bare-string form', () => {
    expect(activeModes(ctxWithModes([{ mode: 'auto' }, 'ideate']))).toEqual(new Set(['auto', 'ideate']));
  });

  it('is empty (never throws) for a missing or non-array modes field', () => {
    expect(activeModes({ sessionOwnerId: 'x' })).toEqual(new Set());
    expect(activeModes({ sessionOwnerId: 'x', modes: null })).toEqual(new Set());
    expect(activeModes({ sessionOwnerId: 'x', modes: 'auto' })).toEqual(new Set());
  });

  it('ignores malformed entries rather than dropping the good ones beside them', () => {
    expect(activeModes(ctxWithModes([null, { nope: 1 }, 'drain']))).toEqual(new Set(['drain']));
  });
});

describe('mode-autonomy — current()', () => {
  it('reports off, with the manual explanation, when neither autonomy mode is set', () => {
    const state = getChatModeAction('mode-autonomy')!.current(ctxWithModes([]));
    expect(state).toMatchObject({ value: 'off', on: false });
    expect(state.title).toMatch(/no standing autonomy mode/i);
  });

  it('reports on when auto is set', () => {
    expect(getChatModeAction('mode-autonomy')!.current(ctxWithModes(['auto']))).toMatchObject({
      value: 'on',
      on: true,
    });
  });

  it('reports the COLDER mode when both are somehow set', () => {
    // Defensive, and the direction matters: reporting "on" for an agent that is
    // actually cold-auto would understate how it behaves between wakes.
    expect(
      getChatModeAction('mode-autonomy')!.current(ctxWithModes(['auto', 'cold-auto'])),
    ).toMatchObject({ value: 'cold', on: true });
  });
});

describe('mode-autonomy — options() + set()', () => {
  it('offers manual/auto/cold-auto with registry-derived labels + hints', () => {
    const options = syncOptions(getChatModeAction('mode-autonomy')!);
    expect(options.map((o) => o.id)).toEqual(['manual', 'auto', 'cold-auto']);
    const auto = options.find((o) => o.id === 'auto');
    expect(auto?.label).toBe('AUTO — act, don’t ask');
    expect(auto?.hint).toMatch(/act on your own judgment/);
    const manual = options.find((o) => o.id === 'manual');
    expect(manual?.label).toBe('Manual');
    expect(manual?.hint).toMatch(/no standing autonomy mode/);
  });

  it('picking "auto" RECONCILES the axis — enables auto AND clears cold-auto', async () => {
    // The pre-P-005 implementation only enabled the chosen mode, so switching
    // cold-auto → auto left BOTH standing. Reconciling the whole axis is what
    // makes the pill's own reading trustworthy afterwards.
    await getChatModeAction('mode-autonomy')!.set(ctx, 'auto');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const byMode = Object.fromEntries(
      fetchMock.mock.calls.map((c) => {
        const body = JSON.parse(c[1].body as string);
        return [body.mode, body.enabled];
      }),
    );
    expect(byMode).toEqual({ auto: true, 'cold-auto': false });
    const first = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/mode/set');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(first).toMatchObject({ agent: 'su-abc123', ownerDirected: true });
  });

  it('picking "cold-auto" enables cold-auto AND clears auto', async () => {
    await getChatModeAction('mode-autonomy')!.set(ctx, 'cold-auto');
    const byMode = Object.fromEntries(
      fetchMock.mock.calls.map((c) => {
        const body = JSON.parse(c[1].body as string);
        return [body.mode, body.enabled];
      }),
    );
    expect(byMode).toEqual({ auto: false, 'cold-auto': true });
  });

  it('picking "manual" clears BOTH autonomy-axis modes', async () => {
    await getChatModeAction('mode-autonomy')!.set(ctx, 'manual');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const modes = fetchMock.mock.calls
      .map((c) => JSON.parse(c[1].body as string))
      .sort((a, b) => a.mode.localeCompare(b.mode));
    expect(modes).toEqual([
      expect.objectContaining({ mode: 'auto', enabled: false }),
      expect.objectContaining({ mode: 'cold-auto', enabled: false }),
    ]);
  });

  it('a non-ok response throws with the mode + status in the message', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    await expect(getChatModeAction('mode-autonomy')!.set(ctx, 'auto')).rejects.toThrow(
      /mode:set\((?:auto|cold-auto)\).*500/,
    );
  });

  it('a stickyConflict response throws a distinct, explanatory error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ ok: false, stickyConflict: true }),
    });
    await expect(getChatModeAction('mode-autonomy')!.set(ctx, 'auto')).rejects.toThrow(
      /owner-directed incumbent/,
    );
  });
});

describe('overlay pills — current(), options(), set()', () => {
  it('each overlay reads only its OWN mode', () => {
    const on = ctxWithModes(['ideate']);
    expect(getChatModeAction('mode-ideate')!.current(on)).toMatchObject({ value: 'on', on: true });
    expect(getChatModeAction('mode-drain')!.current(on)).toMatchObject({ value: 'off', on: false });
    expect(getChatModeAction('mode-grade')!.current(on)).toMatchObject({ value: 'off', on: false });
  });

  it('carries the registry one-liner as the on-state hint, so no copy is written twice', () => {
    const ideate = getChatModeAction('mode-ideate')!;
    expect(ideate.current(ctxWithModes(['ideate'])).title).toMatch(/ideation passes/);
    expect(syncOptions(ideate).find((o) => o.id === 'on')?.hint).toMatch(/ideation passes/);
  });

  it('offers exactly on/off — they are independent booleans, not a shared multi-select', () => {
    // Asserted through IDEATE, the remaining plain overlay. It moved off
    // `mode-drain` in P-005 for the same reason it moved off `mode-grade` in
    // WI-7471: drain's "on" now carries a value (its scope), so its rows are no
    // longer the bare `on`/`off` pair this case is about — asserting it there
    // would be asserting against ids that axis can no longer produce.
    expect(syncOptions(getChatModeAction('mode-ideate')!).map((o) => o.id)).toEqual(['on', 'off']);
  });

  it('writes only its own mode, leaving the other overlays untouched', async () => {
    // The old single `Overlays` checkbox reconciled all three on every submit,
    // so toggling one silently rewrote the other two. Per-pill writes mean a
    // pill can never clear a mode the user did not touch.
    //
    // (Moved off `mode-grade` in WI-7471 — grade no longer has an `on` option,
    // so asserting this through it would have been asserting against an id the
    // menu can never produce.)
    await getChatModeAction('mode-ideate')!.set(ctx, 'on');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
      mode: 'ideate',
      enabled: true,
      agent: 'su-abc123',
      ownerDirected: true,
    });
  });

  it('picking "off" disables that one mode', async () => {
    await getChatModeAction('mode-drain')!.set(ctx, 'off');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
      mode: 'drain',
      enabled: false,
    });
  });
});

/* ── DRAIN's scope instructions (P-005 / plan D-002) ─────────────────────────
   [owner 2026-08-09] "the drain mode should have an input box where you can
   type in instructions for the drain… e.g. all bugs except the ones related to
   the p2p features."

   A drain is a mission, not a switch, so its "on" carries a value — which makes
   it the second axis (after GRADE) that cannot be a plain on/off overlay. ── */
describe('DRAIN — the scope instructions axis', () => {
  const drain = (): ChatModeAction => getChatModeAction('mode-drain')!;
  const body = (call: number): Record<string, unknown> =>
    JSON.parse(fetchMock.mock.calls[call][1].body as string) as Record<string, unknown>;

  it('collects instructions on the ON row and asks nothing on OFF', () => {
    const spec = drain().params?.(ctx, 'on-with-scope');
    expect(spec, 'the ON row must collect a scope').toBeTruthy();
    expect(spec!.presentation).toMatchObject({ kind: 'text', multiline: true });
    // The owner's own example is a sentence with an exclusion in it — a
    // single-line field would be the wrong control for the stated use.
    expect(spec!.presentation).toHaveProperty('placeholder');
    expect(drain().params?.(ctx, 'off'), 'turning a drain OFF has nothing to ask').toBeFalsy();
  });

  it('sends the typed scope as `instructions`, distinct from the reason', async () => {
    await drain().set(ctx, 'on-with-scope', {
      value: 'all bugs except the ones related to the p2p features',
    });
    expect(body(0)).toMatchObject({
      mode: 'drain',
      enabled: true,
      ownerDirected: true,
      instructions: 'all bugs except the ones related to the p2p features',
    });
    // `reason` says WHY the mode changed; `instructions` says WHAT it covers.
    // Collapsing the two would put the scope somewhere mode:set does not make
    // durable — which is the whole point of the separate field.
    expect(body(0).reason).not.toContain('p2p');
  });

  /* THE CASE THIS FIELD EXISTS FOR. An empty box means "no scope", and it must
     CLEAR whatever a previous drain left standing rather than silently
     inheriting it — D-002 is explicit that a stale standing instruction
     delivered verbatim on every wake is worse than none. Omitting the key would
     mean "leave it alone", which is exactly the inheritance to avoid. */
  it('an EMPTY box clears the standing scope — it does not omit the field', async () => {
    await drain().set(ctx, 'on-with-scope', { value: '   ' });
    expect(body(0)).toMatchObject({ mode: 'drain', enabled: true, instructions: '' });
    expect(Object.keys(body(0))).toContain('instructions');
  });

  it('turning drain OFF sends no instructions at all — the server retracts on any disable', async () => {
    await drain().set(ctx, 'off');
    expect(Object.keys(body(0))).not.toContain('instructions');
  });

  /* A Radix Select does not fire onChange for the row already selected. If the
     ON row's id were 'on' it would equal current()'s display value while a
     drain is running, and the row would be DEAD exactly when the owner wants to
     re-scope a live drain. Both halves are pinned: the id must differ from
     every value current() can report, AND current() must not point optionId at
     a row while on. */
  it('the ON row stays reachable while a drain is already running', () => {
    const ids = syncOptions(drain()).map((o) => o.id);
    const running = drain().current(ctxWithModes(['drain']));
    expect(running).toMatchObject({ value: 'on', on: true });
    expect(ids).not.toContain(running.value);
    expect(running.optionId).toBeUndefined();
    // While OFF the real row keeps its checkmark.
    expect(drain().current(ctx).optionId).toBe('off');
    expect(ids).toContain('off');
  });
});

/* ── [owner 2026-08-03] "I want the rubric picker back, add that to the grade
      on/off toggle." (WI-7471)

   GRADE is the one axis whose "on" carries a VALUE, so it is not an on/off
   overlay: its menu is `Off` plus one row per ACTIVE rubric. These cases pin
   the three things that separate it from the plain overlays above. ── */
describe('mode-grade — the rubric picker lives ON the pill', () => {
  const rubricRows = [
    { rubricId: 'hive-coordination-health', characteristic: 'coordination', title: 'Hive coordination health', status: 'active' },
    { rubricId: 'draft-thing', characteristic: 'drafts', title: 'Draft thing', status: 'proposed' },
    { rubricId: 'old-thing', characteristic: 'legacy', title: 'Old thing', status: 'retired' },
  ];

  it('offers Off first, then one row per ACTIVE rubric — never a proposed or retired one', async () => {
    fetchSyncQueryMock.mockResolvedValue(rubricRows);
    const opts = await getChatModeAction('mode-grade')!.options(ctx);
    expect(fetchSyncQueryMock).toHaveBeenCalledWith(expect.objectContaining({
      queryName: 'rubrics.list', args: {}, restEndpoint: '/api/zero-harness',
      requestContext: expect.objectContaining({ headers: {
        'x-papercusp-machine': 'local', 'x-papercusp-workspace': 'default',
      } }),
    }));
    expect(opts.map((o) => o.id)).toEqual(['off', 'hive-coordination-health']);
    expect(opts[1].label).toBe('Hive coordination health');
  });

  /* WI-6552 [owner 2026-07-27]: the owner met the old picker with no idea what
     it would do — "something that comes up that explains what grade mode is".
     That explanation was the deleted card's `prompt`; it must survive the move
     onto the pill, or this change re-creates the confusion it is restoring. */
  it('still EXPLAINS what grade mode is, now on the Off row', async () => {
    fetchSyncQueryMock.mockResolvedValue(rubricRows);
    const opts = await getChatModeAction('mode-grade')!.options(ctx);
    expect(opts[0].hint).toMatch(/score its own work against a rubric/i);
  });

  it('picking a rubric turns grade ON and names the rubric in the reason', async () => {
    await getChatModeAction('mode-grade')!.set(ctx, 'hive-coordination-health');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ mode: 'grade', enabled: true, agent: 'su-abc123', ownerDirected: true });
    // The rubric rides the free-text reason — the same carrier the deleted
    // GradeAction used, so chat-protocol still never learns what a rubric IS.
    expect(body.reason).toMatch(/hive-coordination-health/);
  });

  it('picking Off turns grade off and does NOT name a rubric', async () => {
    await getChatModeAction('mode-grade')!.set(ctx, 'off');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ mode: 'grade', enabled: false });
    expect(body.reason).not.toMatch(/rubric \S/);
  });

  /* The reason this axis is allowed to be async at all (types.ts): the fetch is
     paid on menu OPEN, never on render. If GRADE's options were ever resolved
     eagerly the popup would carry a standing rubrics.list read — the exact cost
     WI-6617 is removing from this screen. */
  it('fetches NOTHING until options() is actually called', () => {
    getChatModeAction('mode-grade')!.current(ctx);
    expect(fetchSyncQueryMock).not.toHaveBeenCalled();
  });

  /* ── [owner 2026-08-03] "grade mode rubric selector should have a create
        rubric option if there are no rubrics. If there are a lot rubrics too
        much to show that should be handled gracefully."

     Both ends of the same range. The picker was only correct in the middle:
     zero rubrics rendered `Off` alone (a menu whose only option is "no"), and
     N rubrics rendered N rows inside a height-constrained popup. ── */
  const manyRubrics = Array.from({ length: 23 }, (_, i) => ({
    rubricId: `rubric-${String(i).padStart(2, '0')}`,
    characteristic: `characteristic ${i}`,
    // Deliberately reverse-sorted, so a test that passes proves the code sorts
    // rather than inheriting the resolver's order.
    title: `Rubric ${String(99 - i).padStart(2, '0')}`,
    status: 'active',
  }));

  it('with NO active rubrics, offers a create row instead of a dead-end Off', async () => {
    // Non-empty on the wire but nothing ACTIVE — the case a naive `rows.length`
    // check would miss, and the one a fresh workspace actually hits.
    fetchSyncQueryMock.mockResolvedValue([rubricRows[1], rubricRows[2]]);
    const opts = await getChatModeAction('mode-grade')!.options(ctx);
    expect(opts.map((o) => o.id)).toEqual(['off', '__create-rubric']);
    expect(opts[1].label).toBe('Ask this agent to create one');
    // It must say WHY there is nothing to pick, not just offer a verb.
    expect(opts[1].hint).toMatch(/no rubrics exist yet/i);
    expect(opts[1].hint).toMatch(/written by agents/i);
  });

  it('offers the create row ONLY when there is nothing to grade against', async () => {
    fetchSyncQueryMock.mockResolvedValue(rubricRows);
    const opts = await getChatModeAction('mode-grade')!.options(ctx);
    expect(opts.map((o) => o.id)).not.toContain('__create-rubric');
  });

  /* ── [owner 2026-08-03, follow-up the same day] "the grade mode popup should
        not offer to ask the agent, it should just have a scroll and a search
        filter in the dropdown."

     The TOO-MANY end of the range moved out of this module and into the
     control: the menu scrolls and filters, so the option set is simply
     complete. What used to sit here — a cap of 8 plus a `__more-rubrics` row
     reading "15 more — ask this agent to choose" — is gone, and these tests are
     the ratchet that stops either coming back. ── */
  it('lists EVERY active rubric — no cap, however many there are', async () => {
    fetchSyncQueryMock.mockResolvedValue(manyRubrics);
    const opts = await getChatModeAction('mode-grade')!.options(ctx);
    // Off + all 23. Nothing is withheld from the reader.
    expect(opts).toHaveLength(24);
    expect(opts.filter((o) => o.id.startsWith('rubric-'))).toHaveLength(23);
  });

  it('never offers to ask the agent to choose — the owner rejected that row', async () => {
    fetchSyncQueryMock.mockResolvedValue(manyRubrics);
    const opts = await getChatModeAction('mode-grade')!.options(ctx);
    expect(opts.map((o) => o.id)).not.toContain('__more-rubrics');
    /* Assert the BEHAVIOUR, not just the id: a differently-named row that still
       punts the reading of the list to the agent is the same defect. */
    for (const o of opts) {
      expect(`${o.label} ${o.hint ?? ''}`).not.toMatch(/ask (this )?agent to choose|more —/i);
    }
  });

  it('sorts the rubrics, so a list long enough to scroll can still be scanned', async () => {
    fetchSyncQueryMock.mockResolvedValue(manyRubrics);
    const opts = await getChatModeAction('mode-grade')!.options(ctx);
    const titles = opts.slice(1).map((o) => o.label);
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
    // The fixture arrives reverse-sorted, so an unsorted implementation would
    // have started at "Rubric 99" — this is the positive control for the sort.
    expect(titles[0]).toBe('Rubric 77');
  });

  /* The bar reads these two to decide WHICH control renders the menu. Without
     them the pill silently falls back to the plain Select — i.e. no scroll and
     no filter, the defect this change exists to fix — while every options()
     test above still passes. */
  it('declares itself searchable, which is what gets it the scroll + filter control', () => {
    const grade = getChatModeAction('mode-grade')!;
    expect(grade.searchable).toBe(true);
    expect(grade.searchPlaceholder).toMatch(/rubric/i);
  });

  it('the bounded axes stay UNsearchable — a search box over three states is noise', () => {
    for (const id of ['mode-autonomy', 'mode-ideate', 'mode-drain']) {
      const action = getChatModeAction(id);
      // Resolve, don't skip — a renamed axis must fail here rather than let the
      // loop pass over nothing and read as coverage.
      expect(action, `${id} is not registered`).toBeTruthy();
      expect(action!.searchable).toBeFalsy();
    }
  });

  /* The critical guard on the create row. Turning grade mode ON without a
     rubric is the WI-7471 defect itself — a mode set with no criteria, the
     rubric surviving only as free text — so a friendlier label must not smuggle
     it back in. This row ASKS; it does not set. */
  it('__create-rubric asks the agent via coord:send and never touches grade mode', async () => {
    await getChatModeAction('mode-grade')!.set(ctx, '__create-rubric');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/admin/coord/send');
    const body = JSON.parse(init.body as string);
    expect(body.to).toEqual(['su-abc123']);
    expect(body.wake).toBe('required');
    expect(body.body).toMatch(/create a rubric/i);
    // The whole point: no mode was set, so grade cannot end up ON with no rubric.
    expect(url).not.toBe('/api/admin/mode/set');
    expect(body.mode).toBeUndefined();
  });
});
