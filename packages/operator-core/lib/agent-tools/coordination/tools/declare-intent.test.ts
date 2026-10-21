/**
 * Handler-level tests for coord:declare-intent's lane VALIDATION (EI-356):
 * declared items are checked against the same parsed-item set plans:items /
 * plans:set-status see (planItemsForRow — kept REAL here), so an id those
 * surfaces reject with item_not_found is never silently claimed. Unknown ids
 * come back in `claims.unknown` + `hint`; an entirely-unknown lane (or a
 * missing plan) skips reconcile so a typo'd declaration can't release the
 * caller's real claims; an explicit `[]` still releases the whole lane.
 *
 * The PG-touching seams (presence, plan row read, reconcile) are mocked at
 * their modules; planItemsForRow + the zod schema run real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReconcileDeclaredClaimsResult } from '../../../plan-items/claim-discipline';

// ── module-seam mocks (arrow-deref so the hoisted vi.mock factory sees them) ──
const writePresence = vi.fn(async () => 'x' as string | null);
const clearExplicitInboxWakePark = vi.fn(async () => false);
vi.mock('../../../events/await/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../events/await/store')>()),
  clearExplicitInboxWakePark: (...a: unknown[]) => clearExplicitInboxWakePark(...(a as [])),
}));
const getPresence = vi.fn(async () => ({ ownerId: 'su-test', intent: 'x' }));
vi.mock('../presence', async (importOriginal) => ({
  // Spread the real module so PRESENCE_STALE_MS (consumed transitively by
  // presence-wakeability.ts via fleet-roster) survives; override only the
  // PG-touching fns we stub.
  ...(await importOriginal<typeof import('../presence')>()),
  writePresence: (...a: unknown[]) => writePresence(...(a as [])),
  getPresence: (...a: unknown[]) => getPresence(...(a as [])),
}));

const resolveAgentIdentity = vi.fn((): { ownerId: string; ownerLabel: string; workspaceId?: string } =>
  ({ ownerId: 'su-test', ownerLabel: 'su · test' }));
vi.mock('../identity', () => ({
  resolveAgentIdentity: (...a: unknown[]) => resolveAgentIdentity(...(a as [])),
}));

const resolvePlanScope = vi.fn(async () => ({ workspaceId: 'ws-test', harnessSlug: 'papercup' }));
const getPlanRow = vi.fn<() => Promise<Record<string, unknown> | null>>(async () => null);
vi.mock('../../plans/source', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), // planItemsForRow stays REAL
  resolvePlanScope: (...a: unknown[]) => resolvePlanScope(...(a as [])),
  getPlanRow: (...a: unknown[]) => getPlanRow(...(a as [])),
}));

const reconcileDeclaredClaims = vi.fn(
  async (opts: { items: string[] }): Promise<ReconcileDeclaredClaimsResult> => ({
    claimed: [...opts.items],
    alreadyHeld: [],
    conflicts: [],
    released: [],
  }),
);
const releaseOwnClaim = vi.fn(async () => true);
vi.mock('../../../plan-items/claim-discipline', () => ({
  reconcileDeclaredClaims: (...a: unknown[]) =>
    reconcileDeclaredClaims(...(a as [{ items: string[] }])),
  releaseOwnClaim: (...a: unknown[]) => releaseOwnClaim(...(a as [])),
}));
vi.mock('../../../plan-items/agent-names', () => ({
  resolveAdoptedName: async () => null,
  bestEffortOwnerUser: () => 'tester',
}));

// convertPlanItem is a downstream side-effect of a claimed lane (auto-convert
// path, PLAN_ITEM_CLAIM_AUTO_CONVERT). These tests assert claim RECONCILIATION,
// not the convert loop — stub it so an ON flag doesn't drive a real PG write
// (which warns on ECONNREFUSED and trips vitest-fail-on-console) in a unit test.
// Top-level handle (arrow-deref) so the WI-10008206 refusal tests can script a
// result and survive the later vi.resetModules() block re-running this factory.
const convertPlanItem = vi.fn(async (): Promise<Record<string, unknown> | null> => ({}));
vi.mock('../../../plan-items/convert', () => ({
  convertPlanItem: (...a: unknown[]) => convertPlanItem(...(a as [])),
}));

// ── EI-9484 enrichment seams (bounded in the handler) ──
// Kept as fast no-op resolvers so a test can WEDGE one (never-resolve) and
// assert the bounded deadline degrades it instead of hanging the whole call.
// The fast success shapes leave every existing test's happy path unchanged
// (these legs are best-effort / return-payload only, asserted by no prior test).
const drainAndDeliverUserMailbox = vi.fn(async () => [] as unknown[]);
vi.mock('../messages', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  drainAndDeliverUserMailbox: (...a: unknown[]) => drainAndDeliverUserMailbox(...(a as [])),
}));

const resolveActorIdentity = vi.fn(async () => ({ ownerId: 'su-test', githubUserId: null, devicePubkey: null }));
vi.mock('../actor-identity', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), // actorMailboxKeys stays REAL (pure)
  resolveActorIdentity: (...a: unknown[]) => resolveActorIdentity(...(a as [])),
}));

const fetchPresenceFleet = vi.fn(async () => new Map<string, unknown>());
vi.mock('../presence-fleet', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPresenceFleet: (...a: unknown[]) => fetchPresenceFleet(...(a as [])),
}));

const getIntentTimeTaskBrief = vi.fn(async (..._a: unknown[]): Promise<unknown> => null);
vi.mock('../../../code-intelligence/task-brief', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getIntentTimeTaskBrief: (...a: unknown[]) => getIntentTimeTaskBrief(...a),
}));
const recordIntentTaskBrief = vi.fn(async (..._a: unknown[]) => true);
vi.mock('../../../code-intelligence/push-channel', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordIntentTaskBrief: (...a: unknown[]) => recordIntentTaskBrief(...a),
}));

import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

// SUT imported AFTER the seams are wired.
import declareIntentTool from './declare-intent';

type Tool = {
  handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
};
const tool = declareIntentTool as unknown as Tool;
const parse = (r: { content: Array<{ text: string }> }): Record<string, unknown> =>
  JSON.parse(r.content[0].text);
const ctx = {} as never;

describe('coord:declare-intent scheduler work-item bridge', () => {
  it('documents that items is P-NNN-only and scheduler claims declare WI/EI intent', () => {
    const tool = declareIntentTool as { description?: string; guidance?: { when?: string } };
    const contract = `${tool.description ?? ''}\n${tool.guidance?.when ?? ''}`;
    expect(contract).toContain('P-NNN form only');
    expect(contract).toContain('scheduler:get_next');
    expect(contract).toContain('WI-/EI-');
  });

  it('validates generated goal refs and work-item refs at the tool boundary', () => {
    const args = (declareIntentTool.args as { parse: (input: unknown) => Record<string, unknown> }).parse({
      intent: 'reconcile two held items',
      declared_goal_refs: [' work-on-everything-070565 ', 'WI-1', 'EI-2'],
    });
    expect(args.declared_goal_refs).toEqual(['work-on-everything-070565', 'WI-1', 'EI-2']);

    for (const value of ['', '   ', '184073']) {
      expect(() =>
        (declareIntentTool.args as { parse: (input: unknown) => Record<string, unknown> }).parse({
          intent: 'not an actionable typed declaration',
          declared_goal_refs: [value],
        }),
      ).toThrow(/goal ref required/);
    }
  });

  it('accepts null current_plan_slug as equivalent to omission at the tool boundary', async () => {
    const args = (declareIntentTool.args as { parse: (input: unknown) => Record<string, unknown> }).parse({
      intent: 'replacement work',
      current_plan_slug: null,
    });
    expect(args.current_plan_slug).toBeNull();

    const res = parse(await tool.handler(args, ctx));
    expect(res.ok).toBe(true);
    expect(writePresence).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ intent: 'replacement work', currentPlanSlug: null }),
      null,
    );
  });
});

/** A plan row whose Stage-3 structured index carries the given item ids. */
const rowWithItems = (ids: string[]): Record<string, unknown> => ({
  items: ids.map((id) => ({
    id,
    status: 'todo',
    text: `item ${id}`,
    importance: 'normal',
    blockedBy: [],
    decisionRefs: [],
    phase: null,
  })),
  content: '# plan\n',
});

beforeEach(() => {
  vi.clearAllMocks();
  clearExplicitInboxWakePark.mockReset().mockResolvedValue(false);
  getPlanRow.mockResolvedValue(null);
});

describe('coord:declare-intent resumes an explicit inbox park', () => {
  it('clears the caller park after the work declaration lands', async () => {
    clearExplicitInboxWakePark.mockResolvedValueOnce(true);
    const res = parse(await tool.handler({ intent: 'resume owned work' }, ctx));
    expect(clearExplicitInboxWakePark).toHaveBeenCalledWith('su-test');
    expect(writePresence.mock.invocationCallOrder[0]).toBeLessThan(clearExplicitInboxWakePark.mock.invocationCallOrder[0]);
    expect(res.inboxWakePark).toEqual({ cleared: true });
  });

  it('keeps a rejected declaration from clearing an existing park', async () => {
    const res = parse(await tool.handler({ intent: 'invalid lane', items: ['P-001'] }, ctx));
    expect(res.ok).toBe(false);
    expect(clearExplicitInboxWakePark).not.toHaveBeenCalled();
  });

  it('reports a failed clear without claiming the park resumed', async () => {
    clearExplicitInboxWakePark.mockRejectedValueOnce(new Error('database unavailable'));
    const res = parse(await tool.handler({ intent: 'resume owned work' }, ctx));
    expect(res.ok).toBe(true);
    expect(res.inboxWakePark).toEqual({ cleared: false, warning: expect.stringContaining('database unavailable') });
  });
});

describe('coord:declare-intent lane validation (EI-356)', () => {
  it('resolves an omitted harness from the session context for a cross-harness plan lane', async () => {
    getPlanRow.mockResolvedValue(rowWithItems(['P-004']));
    const res = parse(await tool.handler(
      { intent: 'portal plan', current_plan_slug: 'portal-session-search-parity', items: ['P-004'] },
      { harnessSlug: 'portal' },
    ));
    expect(res.ok).toBe(true);
    expect(resolvePlanScope).toHaveBeenCalledWith({ harnessSlug: 'portal' });
    expect(getPlanRow).toHaveBeenCalledWith('portal-session-search-parity', { harnessSlug: 'portal' });
    expect(reconcileDeclaredClaims).toHaveBeenCalledTimes(1);
  });

  it('keeps an explicit harness authoritative over the session context', async () => {
    getPlanRow.mockResolvedValue(rowWithItems(['P-004']));
    const res = parse(await tool.handler(
      { intent: 'portal plan', current_plan_slug: 'portal-session-search-parity', items: ['P-004'], harness: 'portal' },
      { harnessSlug: 'papercusp' },
    ));
    expect(res.ok).toBe(true);
    expect(resolvePlanScope).toHaveBeenCalledWith({ harnessSlug: 'portal' });
    expect(getPlanRow).toHaveBeenCalledWith('portal-session-search-parity', { harnessSlug: 'portal' });
  });

  it('items that parse as plan items are claimed (the happy path is unchanged)', async () => {
    getPlanRow.mockResolvedValue(rowWithItems(['P-001', 'P-002']));
    const res = parse(
      await tool.handler(
        { intent: 'work', current_plan_slug: 'my-plan', items: ['P-001', 'P-002'] },
        ctx,
      ),
    );
    expect(res.ok).toBe(true);
    expect(reconcileDeclaredClaims).toHaveBeenCalledTimes(1);
    expect(reconcileDeclaredClaims.mock.calls[0][0].items).toEqual(['P-001', 'P-002']);
    const claims = res.claims as Record<string, unknown>;
    expect(claims.claimed).toEqual(['P-001', 'P-002']);
    expect(claims.unknown).toBeUndefined();
  });

  it('a mixed lane claims only the parseable ids and reports the rest as unknown', async () => {
    getPlanRow.mockResolvedValue(rowWithItems(['P-001']));
    const res = parse(
      await tool.handler(
        { intent: 'work', current_plan_slug: 'my-plan', items: ['P-001', 'P-099'] },
        ctx,
      ),
    );
    expect(res.ok).toBe(true);
    expect(reconcileDeclaredClaims.mock.calls[0][0].items).toEqual(['P-001']);
    const claims = res.claims as Record<string, unknown>;
    expect(claims.claimed).toEqual(['P-001']);
    expect(claims.unknown).toEqual(['P-099']);
    expect(String(claims.hint)).toMatch(/item_not_found/);
  });

  it('the EI-356 repro: legacy checkbox lines parse as NO items → nothing claimed, nothing released', async () => {
    // Exactly the filed shape: `- [ ] P-006 …` checkbox lines, empty structured index.
    getPlanRow.mockResolvedValue({
      items: [],
      content: '# plan\n\n- [ ] P-006 grading UI\n- [ ] P-007 lens chips\n',
    });
    const res = parse(
      await tool.handler(
        { intent: 'work', current_plan_slug: 'scout-idea-grading', items: ['P-006', 'P-007'] },
        ctx,
      ),
    );
    expect(res.ok).toBe(true); // presence must still write
    expect(writePresence).toHaveBeenCalledTimes(1);
    expect(reconcileDeclaredClaims).not.toHaveBeenCalled(); // a typo'd lane releases nothing
    const claims = res.claims as Record<string, unknown>;
    expect(claims.claimed).toEqual([]);
    expect(claims.unknown).toEqual(['P-006', 'P-007']);
    expect(String(claims.hint)).toMatch(/plans:items|plan format/);
  });

  it('a missing plan is refused before presence or claims are written (EI-22589724741483734)', async () => {
    getPlanRow.mockResolvedValue(null);
    const raw = (await tool.handler(
      { intent: 'work', current_plan_slug: 'no-such-plan', items: ['P-001'] },
      ctx,
    )) as unknown as { isError?: boolean; content: Array<{ text: string }> };
    const res = parse(raw);
    expect(raw.isError).toBe(true);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/current_plan_slug 'no-such-plan'.*not found/);
    expect(String(res.error)).toMatch(/no presence or lane claim was written/);
    expect(writePresence).not.toHaveBeenCalled();
    expect(reconcileDeclaredClaims).not.toHaveBeenCalled();
  });

  it('validates a plan even when no plan items are claimed', async () => {
    getPlanRow.mockResolvedValue(rowWithItems([]));
    const res = parse(await tool.handler({ intent: 'observe plan', current_plan_slug: 'my-plan' }, ctx));
    expect(res.ok).toBe(true);
    expect(writePresence).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ intent: 'observe plan', currentPlanSlug: 'my-plan' }),
      null,
    );
    expect(reconcileDeclaredClaims).not.toHaveBeenCalled();
  });

  it('an explicit [] still releases the whole lane (reconcile runs with no items)', async () => {
    getPlanRow.mockResolvedValue(rowWithItems(['P-001']));
    const res = parse(
      await tool.handler({ intent: 'done here', current_plan_slug: 'my-plan', items: [] }, ctx),
    );
    expect(res.ok).toBe(true);
    expect(reconcileDeclaredClaims).toHaveBeenCalledTimes(1);
    expect(reconcileDeclaredClaims.mock.calls[0][0].items).toEqual([]);
  });

  it('items without current_plan_slug is still rejected', async () => {
    const res = parse(await tool.handler({ intent: 'work', items: ['P-001'] }, ctx));
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/current_plan_slug/);
  });

  it('an empty lane can re-declare presence without a plan slug for a replacement member', async () => {
    const res = parse(await tool.handler({ intent: 'replacement work', items: [] }, ctx));
    expect(res.ok).toBe(true);
    expect(writePresence).toHaveBeenCalledTimes(1);
    expect(writePresence).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ intent: 'replacement work', currentPlanSlug: null }),
      null,
    );
    expect(reconcileDeclaredClaims).not.toHaveBeenCalled();
  });

  it('the items-without-plan guard writes NOTHING — no presence row, no lane reconcile (P2-14)', async () => {
    // The guard short-circuits at handler top (declare-intent.ts:78-91) BEFORE
    // writePresence / reconcileDeclaredClaims, so a malformed call leaves no
    // presence or lane-claim side effect — it isn't a half-applied declaration.
    const res = parse(await tool.handler({ intent: 'work', items: ['P-001'] }, ctx));
    expect(res.ok).toBe(false);
    expect(res.isError ?? undefined).toBeUndefined(); // parse() reads only the text body
    expect(String(res.error)).toMatch(/items requires current_plan_slug/);
    expect(writePresence).not.toHaveBeenCalled();
    expect(reconcileDeclaredClaims).not.toHaveBeenCalled();
  });

  it('the guard sets isError:true on the tool result (P2-14)', async () => {
    const raw = (await tool.handler({ intent: 'work', items: ['P-001'] }, ctx)) as unknown as {
      isError?: boolean;
    };
    expect(raw.isError).toBe(true);
  });
});

describe('coord:declare-intent conflict surfacing (the DOUBLE-PLACEMENT invariant)', () => {
  // The MCP contract: "a claim_conflict means a live peer holds it — coordinate,
  // don't take it." reconcileDeclaredClaims REPORTS a contested item rather than
  // throwing; the handler must still succeed (presence written, the rest of the
  // lane claimed) and surface `claims.conflicts` VERBATIM so the caller can re-lane.
  // The EI-356 suite above only ever sees the mock's default `conflicts:[]`, so
  // the handler's behavior WHEN A CONFLICT IS RETURNED was asserted nowhere — this
  // pins it.
  it('a reported conflict does NOT fail the call: presence still writes, the rest of the lane still claims, conflict surfaced verbatim', async () => {
    getPlanRow.mockResolvedValue(rowWithItems(['P-001', 'P-002']));
    reconcileDeclaredClaims.mockResolvedValueOnce({
      claimed: ['P-001'],
      conflicts: [{ item: 'P-002', reason: 'claimed by su · peer — coordinate', holder: 'su-peer' }],
      released: [],
      alreadyHeld: [],
    });

    const res = parse(
      await tool.handler(
        { intent: 'work', current_plan_slug: 'my-plan', items: ['P-001', 'P-002'] },
        ctx,
      ),
    );

    expect(res.ok).toBe(true); // a contested item is REPORTED, never thrown
    expect(writePresence).toHaveBeenCalledTimes(1); // presence still written
    const claims = res.claims as Record<string, unknown>;
    expect(claims.claimed).toEqual(['P-001']); // the uncontested item still claims
    // the conflict is carried through the envelope BYTE-FOR-BYTE (reason + holder intact)
    expect(claims.conflicts).toEqual([
      { item: 'P-002', reason: 'claimed by su · peer — coordinate', holder: 'su-peer' },
    ]);
    expect(claims.unknown).toBeUndefined(); // every declared id parsed — no unknown leg
  });

  it('a mixed unknown-id + conflict lane: conflict surfaced verbatim AND unknown reported alongside', async () => {
    // P-001 claims, P-002 conflicts (live peer), P-099 is not a plan item.
    getPlanRow.mockResolvedValue(rowWithItems(['P-001', 'P-002']));
    reconcileDeclaredClaims.mockResolvedValueOnce({
      claimed: ['P-001'],
      conflicts: [{ item: 'P-002', reason: 'claimed by su · peer — coordinate', holder: 'su-peer' }],
      released: [],
      alreadyHeld: [],
    });

    const res = parse(
      await tool.handler(
        { intent: 'work', current_plan_slug: 'my-plan', items: ['P-001', 'P-002', 'P-099'] },
        ctx,
      ),
    );

    expect(res.ok).toBe(true);
    expect(writePresence).toHaveBeenCalledTimes(1);
    // only the KNOWN ids reach reconcile — the unknown id is filtered before the claim seam
    expect(reconcileDeclaredClaims.mock.calls[0][0].items).toEqual(['P-001', 'P-002']);
    const claims = res.claims as Record<string, unknown>;
    expect(claims.claimed).toEqual(['P-001']);
    expect(claims.conflicts).toEqual([
      { item: 'P-002', reason: 'claimed by su · peer — coordinate', holder: 'su-peer' },
    ]);
    // the unknown leg is spread on TOP of the reconcile result — both survive
    expect(claims.unknown).toEqual(['P-099']);
    expect(String(claims.hint)).toMatch(/item_not_found/);
  });
});

describe('coord:declare-intent — EI-5873 broad-intent over-coverage nudge', () => {
  it('a broad "all remaining items" intent with no structured items gets an advisory hint', async () => {
    const res = parse(await tool.handler({ intent: 'continue working on all the remaining items' }, ctx));
    expect(res.ok).toBe(true);
    expect(String(res.overCoverageHint)).toMatch(/EI-5873/);
    expect(String(res.overCoverageHint)).toMatch(/structured `items`/);
  });

  it('"everything" alone also reads as broad', async () => {
    const res = parse(await tool.handler({ intent: 'finish everything' }, ctx));
    expect(res.overCoverageHint).toBeTruthy();
  });

  it('the SAME broad intent declared WITH structured items gets NO hint — the claim system already covers it', async () => {
    getPlanRow.mockResolvedValue(rowWithItems(['P-001', 'P-002']));
    const res = parse(
      await tool.handler(
        { intent: 'working all remaining items', current_plan_slug: 'my-plan', items: ['P-001', 'P-002'] },
        ctx,
      ),
    );
    expect(res.ok).toBe(true);
    expect(res.overCoverageHint).toBeUndefined();
  });

  it('a narrow, specific intent never gets the hint (no false-positive noise on the common case)', async () => {
    const res = parse(await tool.handler({ intent: 'fixing the null-icon crash in EI-12' }, ctx));
    expect(res.overCoverageHint).toBeUndefined();
  });

  it('a broad intent with an explicit EMPTY items array (a lane release, not a claim) still gets the hint', async () => {
    getPlanRow.mockResolvedValue(rowWithItems(['P-001']));
    const res = parse(
      await tool.handler(
        { intent: 'done — releasing everything', current_plan_slug: 'my-plan', items: [] },
        ctx,
      ),
    );
    expect(res.overCoverageHint).toBeTruthy();
  });
});

describe('coord:declare-intent — EI-9484: bounded enrichment legs never hang the handler', () => {
  // The bug: coord:declare-intent exceeded the 60s MCP tool timeout on ~2% of
  // calls under fleet load ("handler returned but signal had aborted"). The
  // essential write (writePresence) is one upsert, but the handler then AWAITS
  // best-effort ENRICHMENT legs — the @user: mailbox drain (a serial appendLine
  // loop) and the getPresence / fetchPresenceFleet return-payload reads. Any one
  // stalling under DB-pool saturation held the whole call past the timeout even
  // though the declaration already succeeded. Each leg is now bounded with
  // withBoundedTimeout, so a wedged leg degrades to a fallback within its budget
  // instead of hanging. A never-resolving mock simulates the wedge; fake timers
  // fire the bounded deadline in virtual time rather than waiting 8s of wall-clock.

  it('the un-wedged fast path is transparent — presence is still echoed back', async () => {
    const res = parse(await tool.handler({ intent: 'work' }, ctx));
    expect(res.ok).toBe(true);
    expect(writePresence).toHaveBeenCalledTimes(1);
    // EI-23110847647700079: the upsert itself returns the pre-write intent.
    // Only the post-write response-shaping read remains; a separate pre-read
    // would recreate the 1500ms warning that red-pinned installed-PUI tests.
    expect(getPresence).toHaveBeenCalledTimes(1);
    expect(writePresence.mock.invocationCallOrder[0]).toBeLessThan(getPresence.mock.invocationCallOrder[0]);
    // getPresence's value flows through the bound unchanged (fleet label joined).
    expect(res.presence).toMatchObject({ ownerId: 'su-test', fleetSlug: null, fleetRole: null });
  });

  it('a WEDGED @user: mailbox drain degrades to a no-op — the declaration still lands', async () => {
    // withBoundedTimeout logs one console.warn when it degrades; assert it (the
    // vitest-fail-on-console contract) rather than let the expected warn fail us.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      // The serial appendLine drain never resolves (the fleet-load stall).
      drainAndDeliverUserMailbox.mockImplementationOnce(() => new Promise<never>(() => {}));
      const p = tool.handler({ intent: 'work' }, ctx);
      // Advance well past every sequential leg's 8s bound so the wedged leg's
      // deadline fires and the handler assembles its degraded-but-complete result.
      await vi.advanceTimersByTimeAsync(40_000);
      const res = parse(await p);
      expect(res.ok).toBe(true);
      expect(writePresence).toHaveBeenCalledTimes(1); // essential write ran regardless
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('declare-intent:mailbox-drain'));
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  it('a WEDGED getPresence read degrades the echoed-back presence to null — no hang', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      // Only the return-payload read remains; the upsert returns the previous
      // intent atomically for P-015 pivot detection.
      getPresence.mockImplementationOnce(() => new Promise<never>(() => {}));
      const p = tool.handler({ intent: 'work' }, ctx);
      await vi.advanceTimersByTimeAsync(40_000);
      const res = parse(await p);
      expect(res.ok).toBe(true);
      expect(writePresence).toHaveBeenCalledTimes(1);
      expect(res.presence).toBeNull(); // bounded fallback (record → null), never a hang
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('declare-intent:getPresence'));
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  it('a WEDGED fetchPresenceFleet lookup degrades the fleet label but still returns presence', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      fetchPresenceFleet.mockImplementationOnce(() => new Promise<never>(() => {}));
      const p = tool.handler({ intent: 'work' }, ctx);
      await vi.advanceTimersByTimeAsync(40_000);
      const res = parse(await p);
      expect(res.ok).toBe(true);
      // getPresence still answered (fast) — presence is present, fleet label null.
      expect(res.presence).toMatchObject({ ownerId: 'su-test', fleetSlug: null, fleetRole: null });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('declare-intent:fetchPresenceFleet'));
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });
});

/**
 * EI-18776963284535761 — the handler must PASS `current_files` THROUGH to the store,
 * never default it. `undefined` is the store's documented "leave untouched" sentinel
 * (see presence-current-files.integration.test.ts, which proves the store honours it
 * against real PG); the old `args.current_files ?? []` collapsed that sentinel into an
 * explicit CLEAR at this exact line. Because `coord:orient` re-declares intent WITHOUT
 * the arg on every wake, that one `?? []` emptied the column for every agent on the box.
 *
 * These guard the SEAM specifically: the store-level integration test would stay green
 * even if someone re-introduced the default here, because it never goes through the tool.
 */
describe('current_files pass-through (EI-18776963284535761)', () => {
  // `writePresence` is declared as vi.fn(async () => {}), so its `calls` entries are
  // typed as the empty tuple — cast to the real (identity, input) shape to read arg 1.
  const filesArg = (): unknown => {
    const call = writePresence.mock.calls.at(-1) as unknown as
      | [unknown, { currentFiles?: unknown }]
      | undefined;
    return call?.[1]?.currentFiles;
  };

  it('an OMITTED current_files reaches the store as undefined (untouched), not []', async () => {
    await tool.handler({ intent: 'a bare re-declare, exactly what coord:orient sends' }, ctx);
    expect(writePresence).toHaveBeenCalled();
    expect(filesArg()).toBeUndefined();
  });

  it('an EXPLICIT [] reaches the store as [] (a real clear)', async () => {
    await tool.handler({ intent: 'off those files now', current_files: [] }, ctx);
    expect(filesArg()).toEqual([]);
  });

  it('a declared list reaches the store verbatim', async () => {
    await tool.handler({ intent: 'editing', current_files: ['a.ts', 'b.ts'] }, ctx);
    expect(filesArg()).toEqual(['a.ts', 'b.ts']);
  });
});

/**
 * EI-21096338043071922 — the ambient retrieval fence has the same omission
 * contract as current_files: coord:orient re-declares intent without this arg,
 * so omission must preserve the durable session fence; only an explicit []
 * clears it. Keep this at the handler seam so a future `?? []` cannot silently
 * erase a blind session's exclusions before the store sees them.
 */
describe('ambient_excluded_refs pass-through (EI-21096338043071922)', () => {
  const ambientExcludedRefsArg = (): unknown => {
    const call = writePresence.mock.calls.at(-1) as unknown as
      | [unknown, { ambientExcludedRefs?: unknown }]
      | undefined;
    return call?.[1]?.ambientExcludedRefs;
  };

  it('an OMITTED ambient_excluded_refs reaches the store as undefined (untouched)', async () => {
    await tool.handler({ intent: 'a routine re-declare without changing the fence' }, ctx);
    expect(writePresence).toHaveBeenCalled();
    expect(ambientExcludedRefsArg()).toBeUndefined();
  });

  it('an EXPLICIT [] reaches the store as [] (a real clear)', async () => {
    await tool.handler({ intent: 'clear the ambient retrieval fence', ambient_excluded_refs: [] }, ctx);
    expect(ambientExcludedRefsArg()).toEqual([]);
  });

  it('a declared exclusion list reaches the store verbatim', async () => {
    await tool.handler(
      {
        intent: 'exclude the held-out answer key',
        ambient_excluded_refs: ['WI-40293', 'EI-21096338043071922'],
      },
      ctx,
    );
    expect(ambientExcludedRefsArg()).toEqual(['WI-40293', 'EI-21096338043071922']);
  });
});

describe('coord:declare-intent — WI-10008206: a gate-refused pickup is reported and releases only the lease this call took', () => {
  // WI-10008137 made a CODED convertPlanItem refusal (activation_audit_required on an
  // unaudited draft plan) come back as claims.notConverted instead of being dropped.
  // WI-10008206 releases the lease when the gate refuses an item THIS call just
  // claimed, so a refused start leaves no claim behind; a lease held from before the
  // call is left alone. The flag is forced ON so the convert loop runs regardless of
  // the environment's flag state.
  const REASON = 'plan my-plan has no activation audit — record plans:audit { phase:"activation" } first';
  const lane = { intent: 'work', current_plan_slug: 'my-plan', items: ['P-001'] };

  beforeEach(() => {
    setFlagOverridesForTest({ [FLAGS.PLAN_ITEM_CLAIM_AUTO_CONVERT]: true });
    getPlanRow.mockResolvedValue(rowWithItems(['P-001']));
  });
  afterEach(() => {
    setFlagOverridesForTest(null);
  });

  it('a just-claimed item refused with activation_audit_required is listed with leaseReleased:true and dropped from claimed', async () => {
    convertPlanItem.mockResolvedValueOnce({ status: 'refused', code: 'activation_audit_required', reason: REASON });

    const res = parse(await tool.handler(lane, ctx));

    expect(convertPlanItem).toHaveBeenCalledTimes(1); // precondition: the convert loop actually ran
    expect(res.ok).toBe(true);
    const claims = res.claims as Record<string, unknown>;
    expect(claims.notConverted).toEqual([
      { item: 'P-001', code: 'activation_audit_required', reason: REASON, leaseReleased: true },
    ]);
    expect(releaseOwnClaim).toHaveBeenCalledTimes(1);
    expect(releaseOwnClaim).toHaveBeenCalledWith('ws-test', 'papercup', 'my-plan', 'P-001', 'su-test');
    expect(claims.claimed).toEqual([]); // the released item is no longer reported as claimed
  });

  it('a refusal with NO code is not listed and releases nothing (control)', async () => {
    convertPlanItem.mockResolvedValueOnce({ status: 'refused', reason: 'transient' });

    const res = parse(await tool.handler(lane, ctx));

    expect(convertPlanItem).toHaveBeenCalledTimes(1);
    const claims = res.claims as Record<string, unknown>;
    expect(claims.notConverted).toBeUndefined();
    expect(releaseOwnClaim).not.toHaveBeenCalled();
    expect(claims.claimed).toEqual(['P-001']);
  });

  it('an item held BEFORE this call is reported but its lease is kept (leaseReleased:false)', async () => {
    reconcileDeclaredClaims.mockResolvedValueOnce({
      claimed: [],
      alreadyHeld: ['P-001'],
      conflicts: [],
      released: [],
    });
    convertPlanItem.mockResolvedValueOnce({ status: 'refused', code: 'activation_audit_required', reason: REASON });

    const res = parse(await tool.handler(lane, ctx));

    expect(convertPlanItem).toHaveBeenCalledTimes(1);
    const claims = res.claims as Record<string, unknown>;
    expect(claims.notConverted).toEqual([
      { item: 'P-001', code: 'activation_audit_required', reason: REASON, leaseReleased: false },
    ]);
    expect(releaseOwnClaim).not.toHaveBeenCalled();
    expect(claims.alreadyHeld).toEqual(['P-001']);
  });

  it('a different coded refusal is reported but does not release the lease', async () => {
    convertPlanItem.mockResolvedValueOnce({ status: 'refused', code: 'some_other_gate', reason: 'other' });

    const res = parse(await tool.handler(lane, ctx));

    const claims = res.claims as Record<string, unknown>;
    expect(claims.notConverted).toEqual([
      { item: 'P-001', code: 'some_other_gate', reason: 'other', leaseReleased: false },
    ]);
    expect(releaseOwnClaim).not.toHaveBeenCalled();
    expect(claims.claimed).toEqual(['P-001']);
  });
});

describe('coord:declare-intent — EI-22662451852499659: the pivot embed race is gated on cheap, WARM local embedding', () => {
  // The bug: on a COLD process the lazy pivot embedder pays an in-process model
  // load per text, so the 1500ms pivot deadline fired on every first call and
  // logged a [bounded-timeout] warning that vitest-fail-on-console turned into an
  // independent acceptance-test failure. Two gates now precede the embedding
  // race: (1) local acquisition must be cheap, (2) this process must already
  // have completed one embed. A cold call answers lexically (no deadline, no
  // warning) and warms the embedder in the background; only later calls race it.
  const LONG_A = 'investigate the release gate promotion push failure on the frozen candidate lineage';
  const LONG_B = 'refactor the desktop webview bridge to stream tauri agent tool captures over ipc';

  async function runWith(cheap: boolean, embedImpl: (t: string) => Promise<number[]>, nextIntent = LONG_B) {
    vi.resetModules();
    const embed = vi.fn(embedImpl);
    vi.doMock('../../../memory/embed-sidecar-wiring', () => ({ isLocalEmbedAcquisitionCheap: () => cheap }));
    vi.doMock('../../../search/embed-backfill', () => ({
      resolveBackfillEmbedder: async () => ({ mode: 'local', embed }),
    }));
    const detect = vi.fn();
    vi.doMock('../../../intent-pivot', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../../intent-pivot')>();
      detect.mockImplementation(real.detectIntentPivot);
      return { ...real, detectIntentPivot: detect };
    });
    const mod = await import('./declare-intent');
    mod.__resetPivotEmbedWarmForTest();
    const t = mod.default as unknown as Tool;
    writePresence.mockResolvedValue(LONG_A);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const first = parse(await t.handler({ intent: nextIntent }, ctx));
      // Let the background warm-up settle before the second call.
      await new Promise((r) => setTimeout(r, 0));
      const second = parse(await t.handler({ intent: nextIntent }, ctx));
      return { first, second, embed, detect, warnings: warnSpy.mock.calls.map((c) => String(c[0])) };
    } finally {
      warnSpy.mockRestore();
      vi.doUnmock('../../../memory/embed-sidecar-wiring');
      vi.doUnmock('../../../search/embed-backfill');
      vi.doUnmock('../../../intent-pivot');
    }
  }

  it.each(['portal plan', LONG_A])('does not warm a model for an ineligible intent: %s', async intent => {
    const r = await runWith(true, async () => [1, 0], intent);
    expect(r.first.ok).toBe(true); expect(r.second.ok).toBe(true);
    expect(r.embed).not.toHaveBeenCalled(); expect(r.warnings).toEqual([]);
  });

  it('NOT cheap (cold sidecar): every call is lexical, the embedder is never resolved, no deadline warning', async () => {
    const r = await runWith(false, async () => [1, 0]);
    expect(r.first.ok).toBe(true);
    expect(r.second.ok).toBe(true);
    expect(r.embed).not.toHaveBeenCalled();
    expect(r.detect).toHaveBeenCalledTimes(2);
    for (const call of r.detect.mock.calls) expect(call[2]).toEqual({});
    expect(r.warnings.filter((w) => w.includes('intent-pivot-embed'))).toEqual([]);
  });

  it('cheap but COLD process: the first call answers lexically and warms in the background; the next call races the warm embedder', async () => {
    const r = await runWith(true, async () => [1, 0]);
    expect(r.detect.mock.calls[0]?.[2]).toEqual({}); // first: lexical, no race
    expect(r.embed).toHaveBeenCalled(); // background warm-up ran
    expect(r.detect.mock.calls.at(-1)?.[2]).toHaveProperty('embed'); // final comparison: embedding race offered
    expect(r.warnings.filter((w) => w.includes('intent-pivot-embed'))).toEqual([]);
  });

  it('a warm-up that FAILS leaves the process cold — later calls stay lexical rather than racing a broken embedder', async () => {
    const r = await runWith(true, async () => {
      throw new Error('model load failed');
    });
    expect(r.detect.mock.calls[0]?.[2]).toEqual({});
    expect(r.detect.mock.calls[1]?.[2]).toEqual({});
  });
});

describe('coord:declare-intent records its intent-time task brief (WI-6554700010018439)', () => {
  const brief = { status: 'current', files: [{ path: 'lib/a.ts', sha256: 'a'.repeat(64), kind: 'implementation' }] };
  const declare = () => tool.handler(
    (declareIntentTool.args as { parse: (input: unknown) => unknown }).parse({ intent: 'fix a', current_files: ['lib/a.ts'] }), ctx);
  beforeEach(() => {
    resolveAgentIdentity.mockImplementation(() => ({ ownerId: 'su-test', ownerLabel: 'su · test', workspaceId: 'ws-test' }));
    setFlagOverridesForTest({ [FLAGS.CODE_INTEL_PUSH_INTENT]: true });
  });
  afterEach(() => {
    resolveAgentIdentity.mockImplementation(() => ({ ownerId: 'su-test', ownerLabel: 'su · test' }));
    setFlagOverridesForTest(null);
  });

  it('records the delivered brief once in the push ledger', async () => {
    getIntentTimeTaskBrief.mockResolvedValueOnce({ taskBrief: brief });
    const res = parse(await declare());
    expect(res.taskBrief).toEqual(brief);
    expect(recordIntentTaskBrief).toHaveBeenCalledOnce();
    expect(recordIntentTaskBrief).toHaveBeenCalledWith({ workspace: 'ws-test', owner: 'su-test' }, brief);
  });

  it('records nothing for an unmeasured brief or with the intent flag off', async () => {
    getIntentTimeTaskBrief.mockResolvedValueOnce({ taskBrief: { ...brief, status: 'unknown' } });
    expect(parse(await declare()).taskBrief).toMatchObject({ status: 'unknown' });
    setFlagOverridesForTest({ [FLAGS.CODE_INTEL_PUSH_INTENT]: false });
    expect(parse(await declare()).taskBrief).toBeUndefined();
    expect(getIntentTimeTaskBrief).toHaveBeenCalledOnce();
    expect(recordIntentTaskBrief).not.toHaveBeenCalled();
  });

  it('a failed ledger write never fails the declaration', async () => {
    getIntentTimeTaskBrief.mockResolvedValueOnce({ taskBrief: brief });
    recordIntentTaskBrief.mockRejectedValueOnce(new Error('ledger down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = parse(await declare());
      expect(res.ok).toBe(true);
      expect(res.taskBrief).toEqual(brief);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('declare-intent:task-brief-ledger failed: ledger down'));
    } finally { warn.mockRestore(); }
  });
});
