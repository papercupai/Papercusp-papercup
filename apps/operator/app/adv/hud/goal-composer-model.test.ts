/**
 * The "+ Start a goal" composer's contract (goals-tab-improvement-2026-08-09 P-015).
 *
 * Two things are worth pinning here and neither needs a DOM:
 *
 *   1. KILL CRITERION AND CEILING ARE REQUIRED. GOAL mode mandates both at
 *      creation, and the conversational kickoff that used to ask for them was
 *      deleted with the rail — this form is now the only place the requirement
 *      is enforced client-side, so "the form accepts a goal without them" is a
 *      regression that would ship an unstoppable agent.
 *   2. THE RESPONSE IS A TWO-LAYER ENVELOPE. The projected-tool transport wraps
 *      the tool's `data` in MCP content, so the goal id is one parse deeper than
 *      it looks, and a REFUSAL arrives as isError + prose in that same slot.
 *      Reading the refusal correctly is what turns "unparseable response" into
 *      "the launch failed and everything was rolled back".
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ceilingToCents,
  getGoalStartRequestIdentity,
  postGoalStart,
  validateGoalDraft,
  type GoalComposerDraft,
} from './goal-composer-model';

const DRAFT: GoalComposerDraft = {
  title: 'Ship a paid app',
  killCriterion: 'no paying user by day 30',
  ceiling: '500',
};

/** A fetch stub returning one canned body. */
const fetchReturning = (body: string, init: { ok?: boolean; status?: number } = {}) =>
  vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => body,
  })) as unknown as typeof fetch;

/** The shape the projected-tool transport actually returns. */
const envelope = (data: unknown, isError = false) =>
  JSON.stringify({ content: [{ text: typeof data === 'string' ? data : JSON.stringify(data) }], ...(isError ? { isError: true } : {}) });

describe('ceilingToCents', () => {
  it('accepts the forms an owner actually types', () => {
    expect(ceilingToCents('500')).toBe(50_000);
    expect(ceilingToCents('500.00')).toBe(50_000);
    expect(ceilingToCents('$500')).toBe(50_000);
    expect(ceilingToCents('1,250.50')).toBe(125_050);
    expect(ceilingToCents(' 0 ')).toBe(0);
  });

  it('rejects what is not an amount', () => {
    for (const bad of ['', 'abc', '-5', '5.005', '1e3', '.', '$']) {
      expect(ceilingToCents(bad)).toBeNull();
    }
  });
});

describe('validateGoalDraft', () => {
  it('passes a complete draft through as tool args', () => {
    const v = validateGoalDraft({ ...DRAFT, body: '  what winning looks like  ' });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.args).toEqual({
      title: 'Ship a paid app',
      killCriterion: 'no paying user by day 30',
      budgetCents: 50_000,
      body: 'what winning looks like',
    });
  });

  it('omits an empty body rather than sending a blank string', () => {
    const v = validateGoalDraft({ ...DRAFT, body: '   ' });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect('body' in v.args).toBe(false);
  });

  // ── kill criterion + ceiling are OPTIONAL [owner 2026-08-09] ──────────────
  // These four replace the "REFUSES a goal with no kill criterion / no ceiling"
  // pair. The owner overruled that rule from the live product; a goal you
  // cannot start until you have invented a kill condition is one you do not
  // start.

  it('ACCEPTS a goal with no kill criterion, and OMITS the key entirely', () => {
    const v = validateGoalDraft({ ...DRAFT, killCriterion: '   ' });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    // Omitted, not ''. An empty string would render downstream as a declared-
    // but-blank kill condition rather than as "none declared".
    expect('killCriterion' in v.args).toBe(false);
  });

  it('ACCEPTS a goal with no ceiling, and OMITS the key entirely', () => {
    const v = validateGoalDraft({ ...DRAFT, ceiling: '' });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect('budgetCents' in v.args).toBe(false);
  });

  it('ACCEPTS a title-only draft — the outcome is the one required field', () => {
    const v = validateGoalDraft({ title: 'Ship a paid app', killCriterion: '', ceiling: '' });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.args).toEqual({ title: 'Ship a paid app' });
  });

  it('STILL refuses a MALFORMED ceiling — blank is a choice, a typo is not', () => {
    // The distinction the optional-ness must not erase: accepting "about five
    // hundred" by silently dropping it would discard a constraint the owner DID
    // give, which is the mirror image of fabricating one they did not.
    const v = validateGoalDraft({ ...DRAFT, ceiling: 'about five hundred' });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.ceiling).toContain('dollars');
    // ...and it points at the way out, so the owner is not stuck guessing.
    expect(v.errors.ceiling).toContain('blank');
  });

  it('refuses an EMPTY TITLE and nothing else — title is now the only floor', () => {
    const v = validateGoalDraft({ title: '   ', killCriterion: '', ceiling: '' });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(Object.keys(v.errors)).toEqual(['title']);
  });

  it('distinguishes a DECLARED $0 ceiling from an ABSENT one', () => {
    // The load-bearing case for optionality: both "0" and "" produce a null from
    // ceilingToCents, and collapsing them would turn "no ceiling set" into an
    // instant-kill $0 budget. Same value, opposite meanings.
    const zero = validateGoalDraft({ ...DRAFT, ceiling: '0' });
    expect(zero.ok).toBe(true);
    if (!zero.ok) return;
    expect(zero.args.budgetCents).toBe(0);

    const absent = validateGoalDraft({ ...DRAFT, ceiling: '' });
    expect(absent.ok).toBe(true);
    if (!absent.ok) return;
    expect(absent.args.budgetCents).toBeUndefined();
  });
});

describe('getGoalStartRequestIdentity', () => {
  const args = {
    title: 'Ship a paid app',
    killCriterion: 'no paying user by day 30',
    budgetCents: 50_000,
    body: 'First release',
  };
  const scope = { workspaceId: 'ws-1', harnessSlug: 'papercusp' };

  it('reuses the key for identical validated args and rotates it when args or scope change', () => {
    const createKey = vi.fn()
      .mockReturnValueOnce('request-1')
      .mockReturnValueOnce('request-2')
      .mockReturnValueOnce('request-3');
    const first = getGoalStartRequestIdentity(args, scope, null, createKey);
    const retry = getGoalStartRequestIdentity({ ...args }, scope, first, createKey);
    const changedArgs = getGoalStartRequestIdentity({ ...args, body: 'Second release' }, scope, retry, createKey);
    const changedScope = getGoalStartRequestIdentity(args, { ...scope, workspaceId: 'ws-2' }, changedArgs, createKey);

    expect(retry).toBe(first);
    expect(changedArgs.requestKey).toBe('request-2');
    expect(changedScope.requestKey).toBe('request-3');
    expect(createKey).toHaveBeenCalledTimes(3);
  });
});

describe('postGoalStart', () => {
  const opts = { workspaceId: 'ws-1', harnessSlug: 'papercusp', requestKey: 'request-1' };

  it('unwraps the goal id and the agent id from the two-layer envelope', async () => {
    const fetchImpl = fetchReturning(
      envelope({ id: 'ship-paid-app-3f9a1c', agent_owner_id: 'su-abc' }),
    );
    const res = await postGoalStart(
      { title: 't', killCriterion: 'k', budgetCents: 1 },
      { ...opts, fetchImpl },
    );
    expect(res).toEqual({ ok: true, goalId: 'ship-paid-app-3f9a1c', agentOwnerId: 'su-abc' });
  });

  it('POSTs to goals/start with the workspace + harness scoped in', async () => {
    const fetchImpl = fetchReturning(envelope({ id: 'g-1' }));
    await postGoalStart({ title: 't', killCriterion: 'k', budgetCents: 1 }, { ...opts, fetchImpl });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0];
    expect(url).toContain('/api/agent-tools/goals/start');
    expect(url).toContain('ws=ws-1');
    expect(url).toContain('harness=papercusp');
    expect(JSON.parse(String(init.body))).toMatchObject({
      harness: 'papercusp',
      budgetCents: 1,
      requestKey: 'request-1',
    });
  });

  it('ALWAYS asks goals:start for a HEADLESS agent — no console window', async () => {
    // WI-37871 [owner 2026-08-11, interactive]: "Always headless. same for new
    // goal" — the goal composer is the "same for new goal" half.
    //
    // The literal `true`, not OWNER_LAUNCH_HEADLESS: asserting the constant
    // against itself passes however it is defined. This module imports the real
    // constant, so flipping it reds here.
    //
    // It must ride the POST BODY, not just the draft: `headless` is deliberately
    // NOT a GoalStartArgs field, so a test that only checked the args object
    // would pass while the wire carried nothing and the server defaulted to a
    // window.
    const fetchImpl = fetchReturning(envelope({ id: 'g-1' }));
    await postGoalStart({ title: 't' }, { ...opts, fetchImpl });
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0];
    expect(JSON.parse(String(init.body))).toMatchObject({ headless: true });
  });

  it('surfaces a REFUSAL\'s prose, which is what names the rollback', async () => {
    // isError + prose in the content slot. Read as "unparseable" this would
    // tell the owner nothing about whether a half-started goal is now sitting
    // in their board — the one thing they need to know.
    const fetchImpl = fetchReturning(
      envelope("The goal's agent failed to launch (no display). The goal row and its mode stamp were ROLLED BACK.", true),
    );
    const res = await postGoalStart(
      { title: 't', killCriterion: 'k', budgetCents: 1 },
      { ...opts, fetchImpl },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('ROLLED BACK');
  });

  it('does not report success when the tool returned no id', async () => {
    const fetchImpl = fetchReturning(envelope({ degradedReasons: ['no harness in scope'] }));
    const res = await postGoalStart(
      { title: 't', killCriterion: 'k', budgetCents: 1 },
      { ...opts, fetchImpl },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('no harness in scope');
  });

  it('reports an HTTP failure with its status', async () => {
    const fetchImpl = fetchReturning('nope', { ok: false, status: 403 });
    const res = await postGoalStart(
      { title: 't', killCriterion: 'k', budgetCents: 1 },
      { ...opts, fetchImpl },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('403');
  });

  it('reports a transport failure instead of throwing into the click handler', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('operator unreachable');
    }) as unknown as typeof fetch;
    const res = await postGoalStart(
      { title: 't', killCriterion: 'k', budgetCents: 1 },
      { ...opts, fetchImpl },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('operator unreachable');
  });
});
