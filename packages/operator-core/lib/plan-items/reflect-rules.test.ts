/**
 * reflect-rules.test.ts — the work_item → plan-item reflection rules
 * (convert-at-pickup D-015, the read-back half).
 *
 * The rules are PURE (sync matcher over the tool event) — so this tests them
 * directly: registration on the engine, the stamp extraction, the state
 * mapping, and the exact plans:set-status args each rule renders, all from
 * synthetic events. The end-to-end flip is covered by the live E2E pass (the
 * reaction engine + plans:set-status are themselves tested elsewhere).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { reactionRulesFor } from '../events/registry';
import type { ToolInvocationEvent } from '../events/types';
import { reflectedStatus, stampOf } from './reflect-rules';

const STAMP = { plan_slug: 'demo-plan', item_id: 'P-007', harness_slug: 'papercup' };

function evt(tool: string, data: unknown, ok = true): ToolInvocationEvent {
  return {
    tool,
    args: {},
    result: { ok, data },
    ctx: { uiClientId: 'sess-T' } as never,
  };
}

function stamped(state: string, extra: Record<string, unknown> = {}, needsHuman = false) {
  return {
    ok: true,
    workItem: { id: 'WI-9', state, payload: { plan_item: STAMP, ...(needsHuman ? { needsHuman: true } : {}) } },
    ...extra,
  };
}

function ruleById(tool: string, id: string) {
  const rule = reactionRulesFor(tool).find((r) => r.id === id);
  expect(rule, `rule ${id} registered on ${tool}`).toBeTruthy();
  return rule!;
}

function renderArgs(rule: { args?: unknown }, e: ToolInvocationEvent): Record<string, unknown> {
  const a = rule.args;
  return typeof a === 'function' ? (a as (e: ToolInvocationEvent) => Record<string, unknown>)(e) : (a as Record<string, unknown>);
}

function fires(rule: { when?: unknown }, e: ToolInvocationEvent): boolean {
  const w = rule.when;
  return typeof w === 'function' ? (w as (e: ToolInvocationEvent) => boolean)(e) : true;
}

beforeAll(async () => {
  await import('./reflect-rules'); // registration-on-import
});

describe('stampOf — the payload back-link off a tool event', () => {
  it('extracts a valid stamp; rejects missing/partial/non-P-NNN stamps', () => {
    expect(stampOf(evt('t', stamped('open')))).toEqual(STAMP);
    expect(stampOf(evt('t', { ok: true, workItem: { id: 'WI-9' } }))).toBeNull();
    expect(stampOf(evt('t', { ok: true, workItem: { payload: { plan_item: { plan_slug: 'p' } } } }))).toBeNull();
    expect(
      stampOf(evt('t', { ok: true, workItem: { payload: { plan_item: { ...STAMP, item_id: 'EI-8' } } } })),
    ).toBeNull(); // plans:set-status only takes P-NNN — never render a doomed flip
    expect(stampOf(evt('t', undefined))).toBeNull();
  });
});

describe('reflectedStatus — work_item state → plan-item status', () => {
  it('maps terminal-success → done, terminal-drop → dropped, reopen → todo, in-flight → null', () => {
    expect(reflectedStatus('passed')).toBe('done');
    expect(reflectedStatus('resolved')).toBe('done');
    expect(reflectedStatus('done')).toBe('done');
    expect(reflectedStatus('deprecated')).toBe('dropped');
    expect(reflectedStatus('closed')).toBe('dropped');
    expect(reflectedStatus('dropped')).toBe('dropped');
    expect(reflectedStatus('todo')).toBe('todo');
    expect(reflectedStatus('open')).toBe('todo');
    expect(reflectedStatus('validating')).toBeNull();
    expect(reflectedStatus('failing')).toBeNull();
    expect(reflectedStatus(undefined)).toBeNull();
  });

  it('EI-6569: maps a parked work-item onto blocked/needs-human instead of falling through to null', () => {
    // feature-family native 'blocked' state, no needsHuman flag.
    expect(reflectedStatus('blocked')).toBe('blocked');
    // feature-family native distinct 'needs-human' state.
    expect(reflectedStatus('needs-human')).toBe('needs-human');
    // issue-family needs-human ALIAS dialect: state collapses to 'blocked' +
    // payload.needsHuman:true — the second arg disambiguates it from a plain park.
    expect(reflectedStatus('blocked', true)).toBe('needs-human');
    expect(reflectedStatus('blocked', false)).toBe('blocked');
  });
});

describe('plan-item-reflect:complete', () => {
  it('fires plans:set-status → done with the stamp scope on a completion that lands a terminal-success state', () => {
    const rule = ruleById('work_items:complete', 'plan-item-reflect:complete');
    const e = evt('work_items:complete', stamped('resolved', { completion: { summary: 's' } }));
    expect(fires(rule, e)).toBe(true);
    expect(renderArgs(rule, e)).toMatchObject({
      harness: 'papercup',
      slug: 'demo-plan',
      item: 'P-007',
      status: 'done',
      onlyIfNotBlocked: false,
      onlyIfBlockAttributedTo: 'WI-9',
    });
  });

  it('does not duplicate the plan flip when the synchronous finish receipt already converged it', () => {
    const rule = ruleById('work_items:complete', 'plan-item-reflect:complete');
    const e = evt(
      'work_items:complete',
      stamped('resolved', {
        completion: { summary: 's' },
        finish: { planItem: 'done', claimRelease: 'released-or-absent' },
      }),
    );
    expect(fires(rule, e)).toBe(false);
  });

  it('EI-8353: a completion that CLOSES/deprecates the item reflects → dropped, never done', () => {
    const rule = ruleById('work_items:complete', 'plan-item-reflect:complete');
    const closed = evt('work_items:complete', stamped('closed', { completion: { summary: 's' } }));
    expect(fires(rule, closed)).toBe(true);
    expect(renderArgs(rule, closed)).toMatchObject({
      item: 'P-007',
      status: 'dropped',
      note: expect.stringContaining('WI-9'),
    });

    const deprecated = evt('work_items:complete', stamped('deprecated', { completion: { summary: 's' } }));
    expect(fires(rule, deprecated)).toBe(true);
    expect(renderArgs(rule, deprecated)).toMatchObject({ item: 'P-007', status: 'dropped' });
  });

  // The `complete` rule shares setStatusArgs with `set-state`, so it inherits the same drop
  // guards — pinned here so a future refactor of one path cannot silently strip the other.
  it('EI-20129670928216719: a → dropped completion also renders onlyIfNotCompleted', () => {
    const rule = ruleById('work_items:complete', 'plan-item-reflect:complete');
    const closed = evt('work_items:complete', { ...stamped('closed'), completion: { summary: 'closed out' } });
    expect(renderArgs(rule, closed)).toMatchObject({
      status: 'dropped',
      onlyIfNotBlocked: false,
      onlyIfBlockAttributedTo: 'WI-9',
      onlyIfNotCompleted: true,
    });
  });

  it('EI-19972048649686949: a → dropped completion renders onlyIfNoOtherOpenCoverage so it never cascades onto a plan item still covered by a sibling work-item', () => {
    const rule = ruleById('work_items:complete', 'plan-item-reflect:complete');
    const closed = evt('work_items:complete', stamped('closed', { completion: { summary: 's' } }));
    expect(renderArgs(rule, closed)).toMatchObject({ status: 'dropped', onlyIfNoOtherOpenCoverage: true });

    // WI-38908: a → done completion now carries the coverage guard TOO. It used to be
    // drop-only, which meant completing the first of N siblings stamped to one plan item
    // marked the whole item finished. It does NOT carry onlyIfNotCompleted — that guard
    // exists solely to stop a done → dropped DOWNGRADE, which a → done flip cannot be.
    const done = evt('work_items:complete', stamped('resolved', { completion: { summary: 's' } }));
    expect(renderArgs(rule, done)).toMatchObject({
      status: 'done',
      onlyIfNotBlocked: false,
      onlyIfBlockAttributedTo: 'WI-9',
      onlyIfNoOtherOpenCoverage: true,
    });
    expect(renderArgs(rule, done)).not.toHaveProperty('onlyIfNotCompleted');
  });

  it('does NOT fire without a completion record, without a stamp, or when the resulting state is non-terminal', () => {
    const rule = ruleById('work_items:complete', 'plan-item-reflect:complete');
    expect(fires(rule, evt('work_items:complete', stamped('open')))).toBe(false); // no completion
    expect(
      fires(rule, evt('work_items:complete', { ok: true, workItem: { id: 'WI-9' }, completion: {} })),
    ).toBe(false); // unconverted work_item — no stamp
    // EI-8353: a completion recorded WITHOUT a terminal `state` transition (item stays
    // 'open'/claimable) must never flip the plan item to done.
    expect(
      fires(rule, evt('work_items:complete', stamped('open', { completion: { summary: 's' } }))),
    ).toBe(false);
  });
});

describe('plan-item-reflect:set-state', () => {
  it('fires on a mapped state; renders the mapped status', () => {
    const rule = ruleById('work_items:set_state', 'plan-item-reflect:set-state');
    const e = evt('work_items:set_state', stamped('resolved'));
    expect(fires(rule, e)).toBe(true);
    expect(renderArgs(rule, e)).toMatchObject({
      item: 'P-007',
      status: 'done',
      onlyIfNotBlocked: false,
      onlyIfBlockAttributedTo: 'WI-9',
    });

    const drop = evt('work_items:set_state', stamped('deprecated'));
    expect(renderArgs(rule, drop)).toMatchObject({
      status: 'dropped',
      note: expect.stringContaining('WI-9'),
      onlyIfNotBlocked: false,
      onlyIfBlockAttributedTo: 'WI-9',
    });

    const reopen = evt('work_items:set_state', stamped('open'));
    expect(renderArgs(rule, reopen)).toMatchObject({
      status: 'todo',
      onlyIfNotBlocked: false,
      onlyIfNotTerminal: true,
      onlyIfBlockAttributedTo: 'WI-9',
    });
  });

  it('WI-1742073: uses the attributed clear for reopen and terminal edges', () => {
    const rule = ruleById('work_items:set_state', 'plan-item-reflect:set-state');

    for (const state of ['open', 'todo']) {
      const args = renderArgs(rule, evt('work_items:set_state', stamped(state)));
      expect(args, state).toMatchObject({
        status: 'todo',
        onlyIfNotBlocked: false,
        onlyIfNotTerminal: true,
        onlyIfBlockAttributedTo: 'WI-9',
      });
    }

    // Parking retains the non-destructive blocked guard.
    const blocked = renderArgs(rule, evt('work_items:set_state', stamped('blocked')));
    expect(blocked).toMatchObject({ status: 'blocked', onlyIfNotBlocked: true });
    expect(blocked).not.toHaveProperty('onlyIfBlockAttributedTo');

    const done = renderArgs(rule, evt('work_items:set_state', stamped('resolved')));
    expect(done).toMatchObject({
      status: 'done',
      onlyIfNotBlocked: false,
      onlyIfBlockAttributedTo: 'WI-9',
      onlyIfNoOtherOpenCoverage: true,
    });
  });

  it('falls back to the protected reflection when a reopen event has no work-item id', () => {
    const rule = ruleById('work_items:set_state', 'plan-item-reflect:set-state');
    const e = evt('work_items:set_state', {
      ok: true,
      workItem: { state: 'open', payload: { plan_item: STAMP } },
    });
    expect(fires(rule, e)).toBe(true);
    expect(renderArgs(rule, e)).toMatchObject({ status: 'todo', onlyIfNotBlocked: true });
    expect(renderArgs(rule, e)).not.toHaveProperty('onlyIfBlockAttributedTo');

    const terminal = evt('work_items:set_state', {
      ok: true,
      workItem: { state: 'resolved', payload: { plan_item: STAMP } },
    });
    expect(fires(rule, terminal)).toBe(true);
    expect(renderArgs(rule, terminal)).toMatchObject({ status: 'done', onlyIfNotBlocked: true });
    expect(renderArgs(rule, terminal)).not.toHaveProperty('onlyIfBlockAttributedTo');
  });

  // WI-38908 widened this from drop-only to EITHER TERMINAL status. The boundary that
  // still matters is terminal vs non-terminal: marking an item done and abandoning it are
  // the same hazard (both de-queue an item other live work still covers), while a reopen
  // or a park adds no coverage claim and must never pay for the lookup.
  it('EI-19972048649686949 + WI-38908: renders onlyIfNoOtherOpenCoverage on a TERMINAL flip (done or dropped), never on todo/blocked', () => {
    const rule = ruleById('work_items:set_state', 'plan-item-reflect:set-state');

    const drop = evt('work_items:set_state', stamped('deprecated'));
    expect(renderArgs(rule, drop)).toMatchObject({ status: 'dropped', onlyIfNoOtherOpenCoverage: true });

    const done = evt('work_items:set_state', stamped('resolved'));
    expect(renderArgs(rule, done)).toMatchObject({ status: 'done', onlyIfNoOtherOpenCoverage: true });

    const reopen = evt('work_items:set_state', stamped('open'));
    expect(renderArgs(rule, reopen)).not.toHaveProperty('onlyIfNoOtherOpenCoverage');

    const blocked = evt('work_items:set_state', stamped('blocked'));
    expect(renderArgs(rule, blocked)).not.toHaveProperty('onlyIfNoOtherOpenCoverage');
  });

  // EI-20129670928216719. The drop cascade carries TWO complementary guards, and the second
  // exists because the first CANNOT see it: onlyIfNoOtherOpenCoverage counts only NON-terminal
  // siblings, so the `done` work-item that actually completed the plan item is filtered out and
  // the item reads as uncovered. Live case: dropping WI-37872 (merely `relates`-linked) flipped
  // fix-0014-platform-defects-2026-08-10#P-005 from done → dropped 67ms later, while its real
  // completer WI-37735 sat `done`. The release rule had been hardened against exactly this
  // reasoning (EI-19295826179470465); the drop path had not — this pins that it now is.
  it('EI-20129670928216719: renders onlyIfNotCompleted alongside the coverage guard on a → dropped flip only', () => {
    const rule = ruleById('work_items:set_state', 'plan-item-reflect:set-state');

    // Every work-item state that maps to `dropped` must carry BOTH guards — a gap in any one
    // of them re-opens the regression for that state alone.
    for (const state of ['deprecated', 'closed', 'dropped']) {
      expect(renderArgs(rule, evt('work_items:set_state', stamped(state))), state).toMatchObject({
        status: 'dropped',
        onlyIfNoOtherOpenCoverage: true,
        onlyIfNotCompleted: true,
      });
    }

    // Never on a non-drop flip: the guard is scoped to `dropped`, and a genuine done/reopen/park
    // reflection must stay unguarded or it would silently no-op.
    for (const state of ['resolved', 'done', 'passed', 'open', 'todo', 'blocked']) {
      expect(renderArgs(rule, evt('work_items:set_state', stamped(state))), state).not.toHaveProperty(
        'onlyIfNotCompleted',
      );
    }
  });

  it('does NOT fire on an in-flight (unmapped) state', () => {
    const rule = ruleById('work_items:set_state', 'plan-item-reflect:set-state');
    expect(fires(rule, evt('work_items:set_state', stamped('validating')))).toBe(false);
  });

  it('EI-6569: fires on a park into blocked/needs-human instead of leaving the plan item stale', () => {
    const rule = ruleById('work_items:set_state', 'plan-item-reflect:set-state');

    const blocked = evt('work_items:set_state', stamped('blocked'));
    expect(fires(rule, blocked)).toBe(true);
    expect(renderArgs(rule, blocked)).toMatchObject({ item: 'P-007', status: 'blocked', onlyIfNotBlocked: true });

    const needsHumanState = evt('work_items:set_state', stamped('needs-human'));
    expect(fires(rule, needsHumanState)).toBe(true);
    expect(renderArgs(rule, needsHumanState)).toMatchObject({
      item: 'P-007',
      status: 'needs-human',
      onlyIfNotBlocked: true,
    });

    // issue-family alias dialect: state:'blocked' + payload.needsHuman:true.
    const aliasedNeedsHuman = evt('work_items:set_state', stamped('blocked', {}, true));
    expect(fires(rule, aliasedNeedsHuman)).toBe(true);
    expect(renderArgs(rule, aliasedNeedsHuman)).toMatchObject({
      item: 'P-007',
      status: 'needs-human',
      onlyIfNotBlocked: true,
    });
  });
});

describe('lease release mirrors (complete / release also drop the plan-item lease)', () => {
  it('complete fires plan_items:release with the stamp scope', () => {
    const rule = ruleById('work_items:complete', 'plan-item-reflect:complete-releases-lease');
    const e = evt('work_items:complete', stamped('resolved', { completion: { summary: 's' } }));
    expect(fires(rule, e)).toBe(true);
    expect(renderArgs(rule, e)).toEqual({ harness: 'papercup', plan: 'demo-plan', item: 'P-007' });
    // No completion record / no stamp / non-terminal result → no fire.
    expect(fires(rule, evt('work_items:complete', stamped('open')))).toBe(false);
    expect(fires(rule, evt('work_items:complete', { ok: true, workItem: { id: 'WI-9' }, completion: {} }))).toBe(false);
    expect(fires(rule, evt('work_items:complete', stamped('open', { completion: { summary: 's' } })))).toBe(false);
    expect(
      fires(
        rule,
        evt(
          'work_items:complete',
          stamped('resolved', {
            completion: { summary: 's' },
            finish: { planItem: 'done', claimRelease: 'released-or-absent' },
          }),
        ),
      ),
    ).toBe(false);
  });

  it('work_items:release fires plan_items:release for any stamped item (terminal or not)', () => {
    const rule = ruleById('work_items:release', 'plan-item-reflect:release-releases-lease');
    expect(fires(rule, evt('work_items:release', stamped('open')))).toBe(true);
    expect(fires(rule, evt('work_items:release', stamped('resolved')))).toBe(true);
    expect(fires(rule, evt('work_items:release', { ok: true, workItem: { id: 'WI-9' } }))).toBe(false);
    expect(renderArgs(rule, evt('work_items:release', stamped('open')))).toEqual({
      harness: 'papercup',
      plan: 'demo-plan',
      item: 'P-007',
    });
  });
});

describe('plan-item-reflect:release', () => {
  it('fires → todo when a non-terminal converted item is released', () => {
    const rule = ruleById('work_items:release', 'plan-item-reflect:release');
    const e = evt('work_items:release', stamped('open'));
    expect(fires(rule, e)).toBe(true);
    expect(renderArgs(rule, e)).toMatchObject({ item: 'P-007', status: 'todo' });
  });

  it('does NOT fire when the released item is already terminal (never resurrect a done item)', () => {
    const rule = ruleById('work_items:release', 'plan-item-reflect:release');
    expect(fires(rule, evt('work_items:release', stamped('resolved')))).toBe(false);
    expect(fires(rule, evt('work_items:release', stamped('passed')))).toBe(false);
  });

  // RECURRENCE GUARD. The check above only inspects the WORK-ITEM's state, which is all a
  // pure/sync matcher can see. It cannot protect a plan item that reached `done` by another
  // path (flipped directly on the plan, or completed by a SIBLING work-item) — and releasing
  // a still-open work-item then de-completed shipped work, re-pooling it for duplicate pickup
  // and flipping every dependent to a false `blocked`. Live case:
  // memory-write-latency-2026-07-26#P-007, reverted to `todo` by the release of WI-6211.
  //
  // The protection is `onlyIfNotTerminal` on the rendered flip. Deleting it silently restores
  // the bug with no other visible symptom, so it is asserted explicitly rather than left to
  // a toMatchObject that would happily pass without it.
  it('renders onlyIfNotTerminal so a release can NEVER un-finish an already-done plan item', () => {
    const rule = ruleById('work_items:release', 'plan-item-reflect:release');
    const args = renderArgs(rule, evt('work_items:release', stamped('open')));
    expect(args.status).toBe('todo');
    expect(args.onlyIfNotTerminal).toBe(true);
    expect(args.onlyIfNotBlocked).toBe(true);
    expect(args.onlyIfNoOtherInFlightCoverage).toBe(true);
  });

  // A release says "I am no longer holding this" — never "this is unfinished". Any future
  // reflection driven by an OWNERSHIP event must carry the same guard.
  it('keeps the guard on every non-terminal work-item state it fires for', () => {
    const rule = ruleById('work_items:release', 'plan-item-reflect:release');
    for (const state of ['open', 'wip', 'blocked', 'todo']) {
      const e = evt('work_items:release', stamped(state));
      expect(fires(rule, e), `fires for ${state}`).toBe(true);
      expect(renderArgs(rule, e).onlyIfNotTerminal, `guard present for ${state}`).toBe(true);
      expect(renderArgs(rule, e).onlyIfNotBlocked, `blocked guard present for ${state}`).toBe(true);
      expect(renderArgs(rule, e).onlyIfNoOtherInFlightCoverage, `in-flight guard present for ${state}`).toBe(true);
    }
  });
});

/**
 * SET_BLOCKER reflection (deterministic-plan-state-derivation-2026-08-31 P-001 / D-001).
 *
 * `set_blocker` parks and un-parks the work-item through the internal state function
 * rather than the `work_items:set_state` TOOL, so no reaction attached to that tool ever
 * fires — measured as 45 plan items reading `todo` over externally-blocked work. These
 * rules close it off `work_items:set_blocker` itself.
 *
 * The pair is tested TOGETHER on purpose: shipping the park half alone is a regression,
 * not a partial fix, because `onlyIfNotBlocked` makes parking one-way.
 */
describe('set_blocker → plan-item park / un-park', () => {
  const blocked = (n: number, state = 'blocked', needsHuman = false) =>
    evt(
      'work_items:set_blocker',
      stamped(state, { activeBlockers: Array.from({ length: n }, (_, i) => ({ ref: `b${i}` })) }, needsHuman),
    );

  it('parks the plan item while any external blocker is active', () => {
    const rule = ruleById('work_items:set_blocker', 'plan-item-reflect:blocker-set');
    const e = blocked(1);
    expect(fires(rule, e)).toBe(true);
    const args = renderArgs(rule, e);
    expect(args.status).toBe('blocked');
    expect(args.item).toBe('P-007');
    // Parking must never un-finish shipped work.
    expect(args.onlyIfNotTerminal).toBe(true);
  });

  it('writes the status word INTO the note, which is what makes the clear attributable', () => {
    const rule = ruleById('work_items:set_blocker', 'plan-item-reflect:blocker-set');
    const note = String(renderArgs(rule, blocked(2)).note);
    expect(note).toContain('WI-9');
    expect(note).toContain('blocked');
    expect(note).toContain('2 external blockers');
  });

  it('routes a human-capability blocker to needs-human, via the issue-family alias', () => {
    const rule = ruleById('work_items:set_blocker', 'plan-item-reflect:blocker-set');
    expect(renderArgs(rule, blocked(1, 'blocked', true)).status).toBe('needs-human');
    expect(renderArgs(rule, blocked(1, 'needs-human')).status).toBe('needs-human');
  });

  it('un-parks when the LAST blocker clears, opting into the attributed clear', () => {
    const rule = ruleById('work_items:set_blocker', 'plan-item-reflect:blocker-cleared');
    const e = blocked(0, 'open');
    expect(fires(rule, e)).toBe(true);
    const args = renderArgs(rule, e);
    expect(args.status).toBe('todo');
    // Deliberately overriding the inherited guard — lifting the block IS the intent.
    expect(args.onlyIfNotBlocked).toBe(false);
    // ...but narrowed to the one work-item allowed to lift it.
    expect(args.onlyIfBlockAttributedTo).toBe('WI-9');
    expect(args.onlyIfNotTerminal).toBe(true);
  });

  // The two rules share a trigger tool, so each must decline the other's event or a
  // single set_blocker call would fire both and race itself.
  it('the two directions are mutually exclusive on the same event', () => {
    const set = ruleById('work_items:set_blocker', 'plan-item-reflect:blocker-set');
    const cleared = ruleById('work_items:set_blocker', 'plan-item-reflect:blocker-cleared');
    expect(fires(set, blocked(1)), 'set fires while blockers remain').toBe(true);
    expect(fires(cleared, blocked(1)), 'clear declines while blockers remain').toBe(false);
    expect(fires(set, blocked(0, 'open')), 'set declines once drained').toBe(false);
    expect(fires(cleared, blocked(0, 'open')), 'clear fires once drained').toBe(true);
  });

  it('neither direction fires without a plan-item stamp', () => {
    const unstamped = evt('work_items:set_blocker', { ok: true, workItem: { id: 'WI-9', state: 'blocked' }, activeBlockers: [{ ref: 'b' }] });
    expect(fires(ruleById('work_items:set_blocker', 'plan-item-reflect:blocker-set'), unstamped)).toBe(false);
    expect(fires(ruleById('work_items:set_blocker', 'plan-item-reflect:blocker-cleared'), unstamped)).toBe(false);
  });

  it('declines when the result carries no activeBlockers array at all', () => {
    // A shape change in set_blocker must fail CLOSED — never park or un-park on a guess.
    const shapeless = evt('work_items:set_blocker', stamped('blocked'));
    expect(fires(ruleById('work_items:set_blocker', 'plan-item-reflect:blocker-set'), shapeless)).toBe(false);
    expect(fires(ruleById('work_items:set_blocker', 'plan-item-reflect:blocker-cleared'), shapeless)).toBe(false);
  });

  it('does not return a FINISHED work-item to the pool when its blocker clears', () => {
    const cleared = ruleById('work_items:set_blocker', 'plan-item-reflect:blocker-cleared');
    for (const terminal of ['done', 'resolved', 'closed', 'dropped', 'deprecated', 'passed']) {
      expect(fires(cleared, blocked(0, terminal)), `declines for ${terminal}`).toBe(false);
    }
  });
});
