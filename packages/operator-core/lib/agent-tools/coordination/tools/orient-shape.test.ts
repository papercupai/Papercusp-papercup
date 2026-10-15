/**
 * orient-shape.test.ts — coord:orient payload-tier shapers
 * (context-trimming-tiers-2026-07-01 P-012).
 *
 * The incident contract: no silent caps (every truncation leaves a count + a
 * fetch-pointer), claimable rows project to placement essentials (the
 * duplicated summary / null-spelled / payload-fat row shape measured ~1
 * token/char), and the TOON `me` string is cut at its per-plan coverage tail.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/orient-shape.test.ts
 */
import { describe, expect, it } from 'vitest';
import { SHAPER_BUDGET_CHARS, shapeOrient } from './orient-shape';
import { ORIENT_FACTS_RECOVERY_VIA, ORIENT_OPTIONAL_EVICTION_PRIORITY } from './orient-priority';

const row = (i: number) => ({
  id: `WI-${1000 + i}`,
  kind: 'feature',
  family: 'feature',
  harness: 'papercusp',
  title: `Task ${i} — ${'t'.repeat(200)}`,
  summary: `Task ${i} — duplicated summary ${'s'.repeat(200)}`,
  state: 'todo',
  assignee: 's-1782949238028-795dede8',
  takenAt: '2026-07-01 19:40:56.380194-04',
  lastProgressAt: null,
  assignedBy: null,
  severity: null,
  parent: null,
  payload: {
    plan_item: { item_id: 'P-010', plan_slug: 'some-plan', harness_slug: 'papercusp' },
    other: 'x'.repeat(500),
  },
  rank: null,
});

function fixture(n = 20) {
  return {
    self: 'su-abc',
    ok: true,
    me: `format: toon\nok: true\nself:\n  ownerId: su-abc\nsummary:\n  claims: 0\ncoverage[37]:\n${'  - plan: p\n    item: P-001\n'.repeat(60)}`,
    claimable: Array.from({ length: n }, (_, i) => row(i)),
    inbox: {
      summary: { total: 3327, returned: 10 },
      entries: Array.from({ length: 10 }, (_, i) => ({
        ts: `t${i}`,
        kind: 'message',
        from: 'su-x',
        // Distinct per entry, so the "rows travel ONCE" count below measures duplication
        // of a single row rather than five rows that happen to share identical text.
        // Still exactly 400 chars: fold #2 below pins the source summary length.
        summary: `msg ${i} `.padEnd(400, 'm'),
        body: 'b'.repeat(800),
      })),
    },
    memory: { query: 'q', hits: Array.from({ length: 5 }, (_, i) => ({ id: i, memory: 'x'.repeat(900), score: 0.5 })) },
    planEvents: {
      total: 40,
      recent: Array.from({ length: 10 }, (_, i) => ({
        kind: 'plan_event',
        event: 'now_updated',
        plan_slug: 'token-plan',
        detail: `P-${String(i).padStart(3, '0')}`,
        after: `full plan now body ${i} ${'a'.repeat(900)}`,
      })),
    },
    fleetCatchUp: {
      fleet: 'fleet-a',
      total: 10,
      recent: Array.from({ length: 10 }, (_, i) => ({
        kind: 'message',
        from: 'su-x',
        body: `fleet message ${i} ${'f'.repeat(900)}`,
      })),
    },
    // Standing facts: mostly noisy workspace-scope, with the load-bearing owner +
    // harness facts buried in the middle (they must survive the count cap).
    facts: [
      ...Array.from({ length: 10 }, (_, i) => ({
        scope: 'workspace',
        ref: null,
        body: `ws ${i} ${'w'.repeat(400)}`,
        src: null,
      })),
      { scope: 'owner', ref: 'su-abc', body: `OWNER-WALL ${'o'.repeat(400)}`, src: 'WI-1' },
      { scope: 'harness', ref: 'papercusp', body: `HARNESS-FACT ${'h'.repeat(400)}`, src: 'WI-2' },
      ...Array.from({ length: 8 }, (_, i) => ({ scope: 'workspace', ref: null, body: `ws b${i}`, src: null })),
    ],
    intentDeclared: true,
  };
}

describe('shapeOrient trimmed', () => {
  const out = shapeOrient(fixture(), 'trimmed') as Record<string, never> & Record<string, unknown>;

  it('projects claimable rows to placement essentials with a loud cap', () => {
    const rows = out.claimable as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(8);
    const r = rows[0];
    // kept: the placement signal
    expect(r.id).toBe('WI-1000');
    expect(r.state).toBe('todo');
    expect(r.plan_item).toEqual({ item_id: 'P-010', plan_slug: 'some-plan', harness_slug: 'papercusp' });
    // dropped: the token sinks
    expect(r.summary).toBeUndefined();
    expect(r.payload).toBeUndefined();
    expect(r.takenAt).toBeUndefined();
    expect((r.title as string).length).toBeLessThanOrEqual(90);
    // no silent cap
    expect(out.claimableTruncated).toMatchObject({ total: 20, shown: 8 });
  });

  it('cuts the TOON me at the coverage tail with a fetch-pointer', () => {
    const me = out.me as string;
    expect(me).toContain('ownerId: su-abc');
    expect(me).not.toContain('coverage[37]');
    expect(me).toContain('fleet:assignments');
  });

  it('caps inbox/memory/planEvents with pointers; keeps identity + summary fields', () => {
    const inbox = out.inbox as { entries: unknown[]; recent?: unknown; recentTruncated?: unknown; summary?: unknown };
    expect(inbox.entries).toHaveLength(5);
    expect(inbox.summary).toEqual({ total: 3327, returned: 10 });
    expect(inbox.recentTruncated).toBeDefined();
    // EI-18667514339699744 root fix (P-006): the rows travel ONCE, under coord:inbox's key.
    // `recent` is a loud pointer — it reports the real count and is NOT iterable, so a
    // reader on the old key can never see a silent empty inbox — and the serialized
    // orient carries the rows a single time.
    expect(inbox.recent).toEqual({ movedTo: 'inbox.entries', length: 5 });
    expect(() => [...(inbox.recent as Iterable<unknown>)]).toThrow(TypeError);
    const firstSummary = (inbox.entries[0] as { summary: string }).summary;
    expect(JSON.stringify(out.inbox).split(JSON.stringify(firstSummary)).length - 1).toBe(1);
    const memory = out.memory as { hits: Array<{ memory: string }>; hitsTruncated?: unknown };
    expect(memory.hits).toHaveLength(3);
    expect(memory.hits[0].memory.length).toBeLessThanOrEqual(220);
    const events = out.planEvents as { recent: Array<{ after: string; plan_slug: string }>; recentTruncated?: unknown };
    expect(events.recent).toHaveLength(5);
    expect(events.recent[0].plan_slug).toBe('token-plan');
    expect(events.recent[0].after.length).toBeLessThanOrEqual(220);
    expect(events.recentTruncated).toBeDefined();
    const catchUp = out.fleetCatchUp as { recent: Array<{ body: string }>; recentTruncated?: unknown };
    expect(catchUp.recent).toHaveLength(5);
    expect(catchUp.recent[0].body.length).toBeLessThanOrEqual(220);
    expect(catchUp.recentTruncated).toBeDefined();
    expect(out.self).toBe('su-abc');
    expect(out.intentDeclared).toBe(true);
    expect(out.payloadTier).toBe('trimmed');
  });

  it('caps long plan-event prose even when the event count is not truncated', () => {
    const out = shapeOrient(
      { planEvents: { total: 1, recent: [{ event: 'item_added', after: 'x'.repeat(900), detail: 'y'.repeat(900) }] } },
      'trimmed',
    ) as { planEvents: { recent: Array<{ after: string; detail: string }>; recentTruncated?: unknown } };
    expect(out.planEvents.recent).toHaveLength(1);
    expect(out.planEvents.recent[0].after.length).toBeLessThanOrEqual(220);
    expect(out.planEvents.recent[0].detail.length).toBeLessThanOrEqual(220);
    expect(out.planEvents.recentTruncated).toBeUndefined();
  });

  it('bounds an object-shaped fleet assignment fold instead of passing the roster through', () => {
    const agents = Array.from({ length: 93 }, (_, i) => ({
      agentId: `su-${i}`,
      alive: i < 38,
      claims: [{ id: `WI-${i}`, title: `claim ${i} ${'x'.repeat(400)}`, payload: { blob: 'z'.repeat(400) } }],
      doing: { id: `WI-${i}`, title: `doing ${i} ${'d'.repeat(400)}` },
      intent: `intent ${i} ${'i'.repeat(400)}`,
      queued: Array.from({ length: 4 }, () => ({ id: `queued-${i}`, title: 'q'.repeat(200) })),
      isSelf: i === 92,
      verdict: i === 91 ? 'dead' : 'speaking',
    }));
    const me = {
      ok: true,
      summary: { agents: 93, alive: 38, orphaned_claims: 20, stalled_claims: 20 },
      agents,
      orphaned: Array.from({ length: 20 }, (_, i) => ({
        source: 'work_item_claim',
        agent: `su-${i}`,
        id: `WI-${i}`,
        detail: 'orphan detail '.repeat(80),
        verdict: 'orphan',
        action: 'reclaim',
      })),
      stalled: Array.from({ length: 20 }, (_, i) => ({
        source: 'work_item_claim',
        agent: `su-${i}`,
        id: `WI-${i}`,
        detail: 'stalled detail '.repeat(80),
        verdict: 'held-by-live-agent',
        action: 'ask',
      })),
      coverage: Array.from({ length: 37 }, (_, i) => ({ plan: `plan-${i}`, item: `P-${i}`, level: 'full' })),
    };

    const out = shapeOrient({ ...fixture(), me }, 'trimmed') as Record<string, any>;
    const shapedMe = out.me as Record<string, any>;

    // This was the production failure: the nested raw object made orient 64KB+
    // and left the framework's generic projector to drop orientation fields.
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(SHAPER_BUDGET_CHARS);
    expect(shapedMe.agents.length).toBeLessThanOrEqual(6);
    expect(shapedMe.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: 'su-92', isSelf: true }),
        expect.objectContaining({ agentId: 'su-91', verdict: 'dead' }),
      ]),
    );
    expect(shapedMe.agents_truncated).toBe(true);
    expect(shapedMe.agents_hint).toContain('fleet:assignments');
    expect(shapedMe.orphaned.length).toBeLessThanOrEqual(4);
    expect(shapedMe.stalled.length).toBeLessThanOrEqual(4);
    expect(shapedMe.orphaned_note).toContain('fleet:assignments');
    expect(shapedMe.stalled_note).toContain('fleet:assignments');
  });

  it('does not pass a narrow me.coverage table through when the roster is absent', () => {
    const me = {
      ok: true,
      summary: { agents: 1 },
      coverage: Array.from({ length: 18 }, (_, i) => ({
        plan: `plan-${i}`,
        item: `P-${i}`,
        level: 'full',
        links: Array.from({ length: 20 }, (_, j) => ({ id: `WI-${i}-${j}`, blob: 'x'.repeat(500) })),
      })),
    };

    const out = shapeOrient({ ...fixture(), me, recovery: { selfRecall: 'resume' } }, 'trimmed') as Record<string, any>;
    const shapedMe = out.me as Record<string, any>;

    expect(shapedMe.coverage).toBeUndefined();
    expect(shapedMe.coverage_note).toContain('omitted at trimmed tier');
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(SHAPER_BUDGET_CHARS);
    expect(out.recovery).toBeDefined();
  });

  it('projects standard nested coverage rows to bounded placement fields', () => {
    const me = {
      ok: true,
      summary: { agents: 1 },
      coverage: Array.from({ length: 37 }, (_, i) => ({
        plan: `plan-${i}`,
        item: `P-${i}`,
        level: 'full',
        workers: ['su-a', 'su-b'],
        links: Array.from({ length: 20 }, (_, j) => ({ id: `WI-${i}-${j}`, blob: 'x'.repeat(500) })),
      })),
    };

    const out = shapeOrient({ ...fixture(), me }, 'standard') as Record<string, any>;
    const shapedMe = out.me as Record<string, any>;
    const first = shapedMe.coverage[0];

    expect(shapedMe.coverage).toHaveLength(24);
    expect(first).toEqual({ plan: 'plan-0', item: 'P-0', level: 'full', workers: 'su-a,su-b' });
    expect(first.links).toBeUndefined();
    expect(shapedMe.coverage_note).toContain('showing 24 of 37');
  });

  it('preserves same-principal coverage_duplicates through nested orient shaping (EI-21188799646985672)', () => {
    const duplicate = {
      ref: 'plan-x#P-004',
      holder: 'su-A',
      workItemIds: ['WI-1347', 'WI-1348'],
    };
    const me = {
      ok: true,
      summary: { agents: 1, coverage_duplicates: 1 },
      orphaned: [],
      stalled: [],
      coverage_duplicates: [duplicate],
      agents: [{ agentId: 'su-A', claims: [], queued: [], isSelf: true }],
    };

    const out = shapeOrient({ ...fixture(), me }, 'trimmed') as Record<string, any>;
    const shapedMe = out.me as Record<string, any>;

    expect(shapedMe.coverage_duplicates).toEqual([duplicate]);
    expect(shapedMe.summary.coverage_duplicates).toBe(1);
  });

  it('caps standing facts with a pointer, keeping owner + harness scope first (WI-2859)', () => {
    const facts = out.facts as Array<{ scope: string; body: string }>;
    expect(facts).toHaveLength(8);
    // The owner-wall + harness facts were buried at input positions 10/11 but must
    // survive the count cap (they outrank noisy workspace-scope facts).
    const scopes = facts.map((f) => f.scope);
    expect(scopes).toContain('owner');
    expect(scopes).toContain('harness');
    expect(facts[0].scope).toBe('owner'); // owner ranks first
    // bodies capped
    for (const f of facts) expect(f.body.length).toBeLessThanOrEqual(200);
    // no silent cap. The pointer names `full:true` because bare `facts:list`
    // excerpts bodies by default — a recovery pointer that returns a second
    // excerpt does not recover anything.
    expect(out.factsTruncated).toMatchObject({
      total: 20,
      shown: 8,
      more: ORIENT_FACTS_RECOVERY_VIA,
    });
    // The drop is RANKED, not random, so the disclosure names the classes lost:
    // 12 workspace facts were dropped wholesale here.
    expect((out.factsTruncated as { droppedByScope: Record<string, number> }).droppedByScope).toEqual({
      workspace: 12,
    });
  });

  // P-004 / D-006. The two fact-truncation disclosures COMPOSE and are easy to
  // conflate, because the obvious name for either is `factsTruncated`:
  //   factsFoldTruncated — the DATABASE bound. The fold's `ORDER BY updated_at
  //     DESC LIMIT n` never returned the rest, so those rows were never in this
  //     payload to drop. Set upstream in orient.ts.
  //   factsTruncated — the PAYLOAD bound. Rows the fold DID return, dropped here
  //     to fit the budget. Set by this shaper.
  // Measured live on one :3170 orient 2026-09-02: the fold returned 12 of 495
  // workspace + 12 of 366 harness, then the shaper showed 4 of those 24. Reading
  // `factsTruncated` alone says "24 exist" against a true population of 861.
  //
  // This guard exists because the collision ALREADY happened: the first cut of
  // D-006 named its field `factsTruncated`, the shaper silently overwrote it, and
  // every unit test stayed green — only an end-to-end call against the live
  // population exposed it. That is precisely the detector gap this closes.
  describe('the fold bound and the payload bound are separate disclosures', () => {
    it('the shaper does NOT clobber an upstream factsFoldTruncated', () => {
      const foldBound = {
        limitPerSelector: 12,
        scopes: [{ scope: 'workspace', scopeRef: null, shown: 12, total: 495 }],
        reason: 'fold LIMIT, not payload budget',
      };
      const shaped = shapeOrient({ ...fixture(), factsFoldTruncated: foldBound }, 'trimmed') as Record<
        string,
        unknown
      >;
      // Survives shaping intact — a reader must still learn 483 rows never left the DB.
      expect(shaped.factsFoldTruncated).toEqual(foldBound);
      // ...and is NOT the same object the shaper writes for its own, narrower cut.
      expect(shaped.factsTruncated).not.toEqual(foldBound);
      expect(shaped.factsTruncated).toMatchObject({ more: ORIENT_FACTS_RECOVERY_VIA });
    });

    it('both keys ride the facts leg, so neither is evicted without the other', () => {
      const factsLeg = ORIENT_OPTIONAL_EVICTION_PRIORITY.find((l) => l.name === 'facts');
      expect(factsLeg).toBeDefined();
      expect(factsLeg!.fields).toContain('factsFoldTruncated');
      expect(factsLeg!.fields).toContain('factsTruncated');
    });
  });

  it('discloses how many fact BODIES it clipped, not just how many facts it dropped', () => {
    // Distinct from factsTruncated: a fact can survive the COUNT cap and still be
    // delivered with most of its body gone. Both cuts are losses; both are named.
    expect(out.factsBodiesTruncated).toMatchObject({ cap: 200, more: ORIENT_FACTS_RECOVERY_VIA });
    expect((out.factsBodiesTruncated as { facts: number }).facts).toBeGreaterThan(0);
  });

  it('uses valid selector-aware facts:list recovery calls for every folded scope', () => {
    expect(ORIENT_FACTS_RECOVERY_VIA).toContain("scope:'workspace'");
    expect(ORIENT_FACTS_RECOVERY_VIA).toContain("scope:'owner'");
    expect(ORIENT_FACTS_RECOVERY_VIA).toContain("scopeRef:'<ownerId>'");
    expect(ORIENT_FACTS_RECOVERY_VIA).toContain("scope:'harness'");
    expect(ORIENT_FACTS_RECOVERY_VIA).toContain("scopeRef:'<harness>'");
    expect(ORIENT_FACTS_RECOVERY_VIA.match(/all:true/g)).toHaveLength(3);
    expect(ORIENT_FACTS_RECOVERY_VIA.match(/full:true/g)).toHaveLength(3);
    expect(ORIENT_FACTS_RECOVERY_VIA).not.toBe('facts:list { all:true }');
  });

  describe('operative clauses in standing facts survive the body cap', () => {
    // A standing fact's tail is routinely an IMPERATIVE, and the bare `cap` severed
    // it — measured on a live fold, "DO NOT retry — the error says so explicitly"
    // sat past the 200-char cut and shipped as a bare '…'. An agent that loses that
    // clause retries the exact call the fact exists to stop.
    const withFacts = (facts: unknown[]) => shapeOrient({ ...fixture(), facts }, 'trimmed') as Record<string, unknown>;

    const filler = 'x'.repeat(400);

    it('preserves a directive that sits PAST the cut', () => {
      const out2 = withFacts([
        {
          scope: 'harness',
          ref: 'papercusp',
          body: `head ${filler} DO NOT retry — the error is correct.`,
          src: 'WI-3',
        },
      ]);
      const body = (out2.facts as Array<{ body: string }>)[0].body;
      expect(body).toContain('⚠ OPERATIVE');
      expect(body).toContain('DO NOT retry');
    });

    it('CONTROL: a fact with no directive is capped plainly, with no OPERATIVE marker', () => {
      // Permanent falsifier. An implementation that always appends the marker (or
      // never truncates at all) passes the test above and fails this one, so the
      // pair cannot both be satisfied by a degenerate implementation.
      const out2 = withFacts([
        { scope: 'harness', ref: 'papercusp', body: `head ${filler} ordinary trailing prose.`, src: 'WI-4' },
      ]);
      const body = (out2.facts as Array<{ body: string }>)[0].body;
      expect(body).not.toContain('⚠ OPERATIVE');
      expect(body).not.toContain('ordinary trailing prose');
      expect(body.length).toBeLessThanOrEqual(200);
    });

    it('CALIBRATION: a short fact is passed through untouched', () => {
      // Guards the other direction — if the cap fired on everything, the two tests
      // above could pass while the shaper mangled bodies that needed no cutting.
      const out2 = withFacts([{ scope: 'harness', ref: 'papercusp', body: 'short body, nothing to cut', src: 'WI-5' }]);
      expect((out2.facts as Array<{ body: string }>)[0].body).toBe('short body, nothing to cut');
      expect(out2.factsBodiesTruncated).toBeUndefined();
    });
  });

  it('shrinks the payload by an order of magnitude on the incident-shaped fixture', () => {
    const before = JSON.stringify(fixture()).length;
    const after = JSON.stringify(out).length;
    expect(after).toBeLessThan(before / 5);
  });
});

describe('shapeOrient standard', () => {
  it('is a looser projection of the same shape', () => {
    const out = shapeOrient(fixture(), 'standard') as Record<string, unknown>;
    expect((out.claimable as unknown[]).length).toBe(15);
    expect(out.payloadTier).toBe('standard');
  });

  it('passes through small results without truncation markers', () => {
    const small = { ok: true, me: 'short', claimable: [row(1)], inbox: { summary: {}, entries: [] } };
    const out = shapeOrient(small, 'trimmed') as Record<string, unknown>;
    expect(out.claimableTruncated).toBeUndefined();
    expect((out.claimable as unknown[]).length).toBe(1);
  });

  it('tolerates junk shapes', () => {
    expect(shapeOrient(null, 'trimmed')).toBeNull();
    expect(shapeOrient('str', 'trimmed')).toBe('str');
    expect(shapeOrient({ me: 42, claimable: 'not-array' }, 'trimmed')).toMatchObject({ me: 42 });
  });
});

describe('shapeOrient — compaction folds (compaction-fold-audit-2026-07-06)', () => {
  it('fold #2: a post-compaction payload (recovery present) relaxes the inbox re-cap', () => {
    const base = fixture(); // 10 inbox entries, summaries 400 chars
    // baseline: NO recovery ⇒ the standard trimmed cap (5 entries, 140-char summaries) applies
    const capped = shapeOrient(base, 'trimmed') as {
      inbox: { entries: Array<{ summary: string }>; recentTruncated?: unknown };
    };
    expect(capped.inbox.entries).toHaveLength(5);
    expect(capped.inbox.recentTruncated).toBeDefined();
    expect(capped.inbox.entries[0].summary.length).toBeLessThanOrEqual(140);
    // recovery present (⇒ afterCompaction) starts with all 10 entries and fuller bodies,
    // then the client-safe budget may walk back the beef to keep the orientation bounded.
    const recovered = shapeOrient({ ...base, recovery: { selfRecall: 'x' } }, 'trimmed') as {
      inbox: { entries: Array<{ summary: string }>; recentTruncated?: unknown };
    };
    expect(recovered.inbox.entries.length).toBeGreaterThan(0);
    expect(recovered.inbox.entries.length).toBeLessThanOrEqual(10);
    expect(JSON.stringify(recovered).length).toBeLessThanOrEqual(SHAPER_BUDGET_CHARS);
    expect(recovered.inbox.entries[0].summary.length).toBeLessThanOrEqual(400);
    if (recovered.inbox.entries.length < 10) expect(recovered.inbox.recentTruncated).toBeDefined();
  });

  it('EI-9031: carries the memory `degraded` marker through tier-shaping (a trimmed fleet-member session must still see it)', () => {
    const degradedMemory = {
      query: 'own-log-fork-guard work',
      hits: [],
      degraded: true,
      degradedReason: 'embedding_backend_degraded',
      filteredLowScore: 4,
    };
    for (const tier of ['trimmed', 'standard'] as const) {
      const out = shapeOrient({ ...fixture(), memory: degradedMemory }, tier) as {
        memory: { degraded?: boolean; degradedReason?: string; filteredLowScore?: number };
      };
      expect(out.memory.degraded).toBe(true);
      expect(out.memory.degradedReason).toBe('embedding_backend_degraded');
      expect(out.memory.filteredLowScore).toBe(4);
    }
    // A healthy recall carries no degraded marker after shaping (backward-compatible).
    const healthy = shapeOrient(fixture(), 'trimmed') as { memory: Record<string, unknown> };
    expect('degraded' in healthy.memory).toBe(false);
  });

  it.each(['cosine', 'rrf', 'lexical', 'unknown'] as const)(
    'retains the memory scoreScale marker through %s tier shaping',
    (scoreScale) => {
      for (const tier of ['trimmed', 'standard'] as const) {
        const out = shapeOrient(
          { ...fixture(), memory: { query: 'q', hits: [], scoreScale } },
          tier,
        ) as { memory: { scoreScale?: string } };
        expect(out.memory.scoreScale).toBe(scoreScale);
      }
    },
  );

  it('does not propagate an invalid scoreScale marker', () => {
    const out = shapeOrient(
      { ...fixture(), memory: { query: 'q', hits: [], scoreScale: 'not-a-scale' } },
      'trimmed',
    ) as { memory: { scoreScale?: string } };
    expect(out.memory.scoreScale).toBeUndefined();
  });

  it('D-002: passes the versioned fleetHealth availability/ref through unchanged', () => {
    const fleetHealth = {
      schemaVersion: 'orient-fleet-health-v1',
      status: 'available',
      ref: 'coord:glance',
    };
    for (const tier of ['trimmed', 'standard'] as const) {
      const out = shapeOrient({ ...fixture(), fleetHealth }, tier) as { fleetHealth: unknown };
      expect(out.fleetHealth).toEqual(fleetHealth);
    }
  });
});

// P-016 (voice-public-release-readiness-2026-07-12): the papercup pane digest is a
// rendered markdown block — cap by chars with the D-004 fetch-pointer; deepWork is
// bounded at source (newest≤3) and must pass through untouched.
describe('P-016 role-fold shaping (paneContext cap / deepWork pass-through)', () => {
  it('caps a fat paneContext by chars with a fetch-pointer; deepWork passes through unchanged', () => {
    const digest = `## Live system status — papercusp\n${'x'.repeat(8_000)}`;
    const deepWork = {
      count: 1,
      oldestAgeMs: 5_000,
      newest: [{ msgId: 'm1', from: 'sentinel-1', summary: 'why is the deploy red?', ageMs: 5_000 }],
    };
    for (const tier of ['trimmed', 'standard'] as const) {
      const out = shapeOrient({ ...fixture(), paneContext: digest, deepWork }, tier) as {
        paneContext: string;
        deepWork: unknown;
      };
      expect(out.paneContext.length).toBeLessThan(digest.length);
      expect(out.paneContext).toContain('… (trimmed');
      expect(out.paneContext.startsWith('## Live system status')).toBe(true);
      expect(out.deepWork).toEqual(deepWork);
    }
  });

  it('a small paneContext passes through byte-identical (no gratuitous truncation)', () => {
    const small = '## Live system status — papercusp\n_no anomalies — system healthy._';
    for (const tier of ['trimmed', 'standard'] as const) {
      const out = shapeOrient({ ...fixture(), paneContext: small }, tier) as { paneContext: string };
      expect(out.paneContext).toBe(small);
    }
  });
});

// EI-19314271768708528: `leaderBrief` had no shaper, so it reached the result-door's
// bounded-payload pass full-fat and was dropped WHOLE — on a monitor wake (the mode that
// exists to deliver it) the leader was left with `me`, its own one-row assignment view,
// which reads exactly like a fleet-wide "1 alive, 0 stalled" verdict. Shaping it is what
// makes tier 2b's ordering promotion in assembleOrientOutput actually land: promoted-but-
// oversized and never-folded are indistinguishable to the reader.
describe('EI-19314271768708528 leaderBrief shaping (monitor-wake fleet visibility)', () => {
  const member = (i: number, over: Record<string, unknown> = {}) => ({
    agentId: `su-member-${i}`,
    label: `su · m${i}`,
    fleetRole: 'member',
    sessionState: 'live',
    verdict: 'monitoring',
    wakeMode: 'auto',
    contextPressure: 'ok',
    load: 1,
    queuedCount: 1,
    workItemIds: [`EI-${1000 + i}`],
    doing: { id: `EI-${1000 + i}`, title: 'x'.repeat(400), status: 'open' },
    stalled: false,
    ...over,
  });

  // The reporting incident: 11 members, one dead, one idle-with-claimable carrying a
  // ~450-char benchSuggestion.reason, one at critical context with an unanswered body.
  const fatBrief = () => ({
    summary: {
      fleet: 'nonp2p-bug-drain-0801',
      members: 11,
      dead: 1,
      stalled: 0,
      idle_with_claimable: 1,
      unanswered_directed: 5,
      unowned_criticals: 18,
      idleWithClaimableAlert: true,
    },
    members: [
      ...Array.from({ length: 8 }, (_, i) => member(i)),
      member(8, { sessionState: 'ended', verdict: 'dead', doing: null, workItemIds: [] }),
      member(9, {
        doing: null,
        workItemIds: [],
        load: 0,
        benchSuggestion: { kind: 'idle-with-claimable', item: null, reason: 'r'.repeat(450) },
      }),
      member(10, {
        contextPressure: 'critical',
        unanswered: { count: 1, oldestAgeMs: 1_918_532, newest: [{ body: 'b'.repeat(900) }] },
      }),
    ],
    unownedCriticals: Array.from({ length: 18 }, (_, i) => ({ id: `EI-${i}`, title: 'y'.repeat(200) })),
  });

  it('keeps summary WHOLE — every aggregate alert a leader acts on survives the cap', () => {
    for (const tier of ['trimmed', 'standard'] as const) {
      const out = shapeOrient({ ...fixture(), leaderBrief: fatBrief() }, tier) as {
        leaderBrief: { summary: Record<string, unknown> };
      };
      expect(out.leaderBrief.summary).toEqual(fatBrief().summary);
    }
  });

  it('shrinks the brief monotonically by tier so the door has no reason to drop it whole', () => {
    const before = JSON.stringify(fatBrief()).length;
    const sized = (tier: 'trimmed' | 'standard') =>
      JSON.stringify(
        (shapeOrient({ ...fixture(), leaderBrief: fatBrief() }, tier) as { leaderBrief: unknown }).leaderBrief,
      ).length;
    const trimmed = sized('trimmed');
    const standard = sized('standard');
    // Both tiers shrink; trimmed is strictly the leaner projection (standard keeps the
    // whole roster of a normal-sized fleet on purpose, so it shrinks by less).
    expect(standard).toBeLessThan(before);
    expect(trimmed).toBeLessThan(standard);
    // The bound that actually matters: `trimmed` is the tier the reporting incident ran
    // under (tier=trimmed, forced=true), so it must land small enough to survive the
    // budget alongside me/claimable/inbox rather than being dropped whole.
    expect(trimmed).toBeLessThan(4_000);
  });

  it('ranks actionable members FIRST — a head-slice would hide the dead one behind 8 healthy', () => {
    const out = shapeOrient({ ...fixture(), leaderBrief: fatBrief() }, 'trimmed') as {
      leaderBrief: { members: Array<{ agentId: string }> };
    };
    const kept = out.leaderBrief.members.map((m) => m.agentId);
    // dead (8), pressured/unanswered (10) and idle-with-claimable (9) are the rows a
    // leader must intervene on; a naive .slice(0,6) would have kept members 0-5 only.
    expect(kept).toContain('su-member-8');
    expect(kept).toContain('su-member-10');
    expect(kept).toContain('su-member-9');
  });

  it('leaves the D-004 count + fetch-pointer when the roster is capped', () => {
    const out = shapeOrient({ ...fixture(), leaderBrief: fatBrief() }, 'trimmed') as {
      leaderBrief: { members: unknown[]; membersTruncated?: { total: number; shown: number; more: string } };
    };
    expect(out.leaderBrief.members.length).toBe(6);
    expect(out.leaderBrief.membersTruncated).toMatchObject({ total: 11, shown: 6, more: 'fleet:leader-brief' });
  });

  it('caps the unbounded advisory rosters with a pointer', () => {
    const out = shapeOrient({ ...fixture(), leaderBrief: fatBrief() }, 'trimmed') as {
      leaderBrief: { unownedCriticals: unknown[]; unownedCriticalsTruncated?: { total: number } };
    };
    expect(out.leaderBrief.unownedCriticals.length).toBe(5);
    expect(out.leaderBrief.unownedCriticalsTruncated).toMatchObject({ total: 18 });
  });

  it('drops per-member unanswered message BODIES but keeps the count a leader acts on', () => {
    const out = shapeOrient({ ...fixture(), leaderBrief: fatBrief() }, 'trimmed') as {
      leaderBrief: { members: Array<{ agentId: string; unanswered?: { count: number; newest?: unknown } }> };
    };
    const pressured = out.leaderBrief.members.find((m) => m.agentId === 'su-member-10');
    expect(pressured?.unanswered).toMatchObject({ count: 1, oldestAgeMs: 1_918_532 });
    expect(pressured?.unanswered).not.toHaveProperty('newest');
  });

  it('passes a small brief through without inventing truncation markers', () => {
    const small = { summary: { fleet: 'f', members: 2, dead: 0 }, members: [member(0), member(1)] };
    const out = shapeOrient({ ...fixture(), leaderBrief: small }, 'standard') as {
      leaderBrief: { members: unknown[]; membersTruncated?: unknown };
    };
    expect(out.leaderBrief.members.length).toBe(2);
    expect(out.leaderBrief.membersTruncated).toBeUndefined();
  });
});

describe('EI-203907 fleetSummaries shaping', () => {
  it('keeps bounded count-only summaries and discloses a capped fleet list', () => {
    const summaries = Array.from({ length: 30 }, (_, i) => ({
      fleet: `fleet-${i}`,
      summary: {
        members: i + 1,
        stalled: i % 3,
        cumulative: { admission_blocked: i % 4 },
        reason: 'r'.repeat(500),
      },
      members: Array.from({ length: 20 }, () => ({ id: 'member', blob: 'x'.repeat(500) })),
      unavailable: i === 1,
      reason: 'unavailable because '.repeat(40),
    }));
    const out = shapeOrient({ fleetSummaries: summaries }, 'trimmed') as {
      fleetSummaries: Array<Record<string, any>>;
      fleetSummariesTruncated?: Record<string, unknown>;
    };

    expect(out.fleetSummaries).toHaveLength(12);
    expect(out.fleetSummariesTruncated).toMatchObject({
      total: 30,
      shown: 12,
      more: 'coord:orient { mode: "monitor" } / fleet:leader-brief',
    });
    expect(out.fleetSummaries[0]).toMatchObject({
      fleet: 'fleet-0',
      summary: { members: 1, stalled: 0, cumulative: { admission_blocked: 0 } },
    });
    expect(out.fleetSummaries[0].summary.reason.length).toBeLessThanOrEqual(240);
    expect(out.fleetSummaries[1]).toMatchObject({ unavailable: true });
    expect(out.fleetSummaries[1].reason.length).toBeLessThanOrEqual(240);
    expect(out.fleetSummaries[0]).not.toHaveProperty('members');
  });

  it('does not invent a truncation marker for a short summary list', () => {
    const out = shapeOrient(
      { fleetSummaries: [{ fleet: 'fleet-a', summary: { members: 2, stalled: 0 } }] },
      'standard',
    ) as { fleetSummaries: unknown[]; fleetSummariesTruncated?: unknown };
    expect(out.fleetSummaries).toEqual([{ fleet: 'fleet-a', summary: { members: 2, stalled: 0 } }]);
    expect(out.fleetSummariesTruncated).toBeUndefined();
  });
});

/**
 * EI-19408488769901676 — the shaper must hit its own budget so a result NEVER reaches the
 * framework's generic bounded projection (`projectBoundedPayload`), which drops whole
 * fields blind.
 *
 * Measured live 2026-08-03 on a real post-compaction orient: the trimmed shaper produced
 * 30,812 chars against a 30,000 hard ceiling — over by 812 (2.7%) — and the generic
 * fallback then cut it to 6,360 with 44 fields dropped, including the entire
 * `inbox.entries` array and a `cursor` truncated mid-string.
 *
 * The overshoot was self-inflicted: the post-compaction fold BEEFS the inbox (cap 5 -> 20,
 * summaries 140 -> 700) precisely because a just-compacted agent lost its message context,
 * so `afterCompaction` is both the call that most needs a complete picture and the one most
 * likely to overshoot. Until P-006 (oversized-tool-results-reduction-2026-10-12) `entries`
 * was also aliased to the SAME projected array as `recent`, so every inbox entry was
 * serialized TWICE. The rows now travel once, so 20 beefed entries (~16.5KB) sit just under
 * the 17KB budget, and a real overshoot needs other passthrough bulk beside them. The
 * fixture below supplies that bulk through `control`.
 */
describe('shapeOrient — in-shaper budget ladder (EI-19408488769901676)', () => {
  const bigInbox = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      kind: 'message',
      ts: `2026-08-03T0${i % 10}:00:00.000Z`,
      from: `su-${i}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
      summary: `msg ${i} — ${'m'.repeat(900)}`,
    }));

  /** A post-compaction payload whose BEEFED inbox blows the budget but whose plain
   *  trimmed inbox fits comfortably — i.e. exactly the production shape. */
  const overflowing = () => ({
    self: { ownerId: 'su-7854d874', ownerLabel: 'su · su-7854d' },
    recovery: { selfRecall: 'sessions:search { session: "self" }', loop: { active: true, intervalSec: 900 } },
    // ~4KB of passthrough bulk (survives every rung unchanged): beef + bulk overshoots the
    // 17KB budget, while plain-trimmed inbox + bulk fits comfortably.
    control: { state: { modes: ['auto'], carry: 'warm' }, stack: Array.from({ length: 40 }, (_, i) => `layer-${i}:${'c'.repeat(90)}`) },
    inbox: { summary: { total: 517, returned: 25 }, entries: bigInbox(40) },
  });

  it('TEETH: a post-compaction orient that overshoots is tightened IN-SHAPER, not handed to the generic projector', () => {
    const out = shapeOrient(overflowing(), 'trimmed') as Record<string, any>;

    // Without the ladder this returns the beefed shape (>30k), which production then
    // hands to projectBoundedPayload — the 44-field blind drop this test exists to prevent.
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(SHAPER_BUDGET_CHARS);

    // It stepped down exactly one rung — walking back the beef, not the whole payload.
    expect(out.shaperTightened).toBeDefined();
    expect(out.shaperTightened.rung).toBe('trimmed');
    expect(out.shaperTightened.more).toContain("payloadTier:'full'");
  });

  it('the tightened result still CARRIES the orientation — recovery/control/self survive, inbox is non-empty, pointers intact', () => {
    const out = shapeOrient(overflowing(), 'trimmed') as Record<string, any>;

    // The whole point: the fields a just-respawned agent bootstraps from are passthrough
    // and survive every rung. The generic projector dropped exactly these.
    expect(out.recovery).toBeDefined();
    expect(out.recovery.selfRecall).toBeTruthy();
    expect(out.recovery.loop.active).toBe(true);
    expect(out.control).toBeDefined();
    expect(out.self.ownerId).toBe('su-7854d874');

    // The inbox is TRIMMED, never emptied — an empty list reads as "no messages".
    expect(out.inbox.entries.length).toBeGreaterThan(0);
    expect(out.inbox.recent).toEqual({ movedTo: 'inbox.entries', length: out.inbox.entries.length });
    // D-004: no silent caps — the truncation still leaves a count + a fetch-pointer.
    expect(out.inbox.recentTruncated.total).toBe(40);
    expect(out.inbox.recentTruncated.more).toBe('coord:inbox');
  });

  it('does NOT fire on a payload that already fits — the common case stays byte-identical', () => {
    const small = {
      self: { ownerId: 'su-1' },
      recovery: { selfRecall: 'x' },
      inbox: { summary: { total: 2 }, entries: bigInbox(2) },
    };
    const out = shapeOrient(small, 'trimmed') as Record<string, any>;

    // Rung 0 (the beefed post-compaction shape) fit, so no step-down and no marker.
    expect(out.shaperTightened).toBeUndefined();
    // ...and the beef genuinely applied: both entries kept, summaries at the relaxed cap.
    expect(out.inbox.entries.length).toBe(2);
    expect(out.inbox.entries[0].summary.length).toBeGreaterThan(200);
  });

  it('a payload too big even at floor caps is flagged overBudget rather than silently looking normal', () => {
    // The residue is in an UNCAPPED passthrough field, so no rung can shrink it — the
    // honest answer is to say so, since the generic projection may still drop fields.
    const out = shapeOrient({ self: { ownerId: 'su-1' }, recovery: { blob: 'z'.repeat(40_000) } }, 'trimmed') as Record<
      string,
      any
    >;

    expect(out.shaperTightened.overBudget).toBe(true);
    expect(out.shaperTightened.rung).toBe('floor');
    // Even here it must not have thrown away the passthrough it cannot shrink.
    expect(out.recovery.blob.length).toBe(40_000);
  });

  it('CLIENT-SAFE GUARD: an ordinary payload that overflows is tightened in-shaper', () => {
    // WI-20183757506064439: WI-37843 intentionally resolves orient's normal call to full,
    // so the tool's own ceiling must have a domain-aware fallback for ordinary calls too.
    // Otherwise the result-door exemption turns a large inbox into a hard client rejection.
    const huge = { self: { ownerId: 'su-1' }, inbox: { summary: { total: 40 }, entries: bigInbox(40) } };
    const out = shapeOrient(huge, 'trimmed') as Record<string, any>;

    expect(out.recovery).toBeUndefined(); // precondition: this is NOT a post-compaction orient
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(SHAPER_BUDGET_CHARS);
    // Keep the orientation's highest-value fold and its recovery pointer rather than
    // falling through to the generic projector, which drops fields by declaration order.
    expect(out.inbox.entries.length).toBe(5);
    expect(out.inbox.recentTruncated.more).toBe('coord:inbox');
  });

  it('DRIFT GUARD: the shaper budget stays strictly under the framework hard ceiling', async () => {
    // orient-shape.ts is deliberately dependency-free, so the budget is a local constant.
    // That is only safe if this test fails loudly when the framework ceiling moves under
    // it — a budget at or above the ceiling would silently restore the old fall-through.
    const { PAYLOAD_TIER_HARD_CEILING_CHARS } = await import('@papercusp/tooldef');
    expect(SHAPER_BUDGET_CHARS).toBeLessThan(PAYLOAD_TIER_HARD_CEILING_CHARS);
    // The orient tool has a stricter client-safe ceiling than the shared framework default.
    // Keep this local budget in the 15–20k client-safe band unless the downstream consumer
    // is re-measured before widening it.
    expect(SHAPER_BUDGET_CHARS).toBeGreaterThanOrEqual(15_000);
    expect(SHAPER_BUDGET_CHARS).toBeLessThanOrEqual(20_000);
  });
});

/**
 * EI-20113865649946366 — the claimable list is cut TWICE (handler, then this shaper)
 * and only the HANDLER can measure the first cut. This rung must therefore not
 * overwrite what it was told.
 *
 * The defect these pin: this shaper published `d.claimable.length` as `total`. That
 * length is the list the handler HANDED DOWN, already bounded by its own limit — so
 * orient reported `total: 20` while the oracle's authoritative count was ~1677. A
 * bounded measurement rendered as a population is worse than silence: a confident
 * number does not invite a re-read.
 */
describe('EI-20113865649946366: shaper carries upstream disclosure, never re-derives it', () => {
  const upstream = {
    shown: 20,
    total: 1677,
    totalScope: 'issue-family (bug/change/task)',
    limit: 20,
    more: 'work_items:claimable { harness } for the authoritative count',
  };

  it('CARRIES the authoritative total and only restates its own `shown`', () => {
    const out = shapeOrient(
      { ok: true, me: 'x', claimable: Array.from({ length: 20 }, (_, i) => row(i)), claimableTruncated: upstream },
      'trimmed',
    ) as { claimable: unknown[]; claimableTruncated: Record<string, unknown> };

    // The authoritative facts survive this rung untouched...
    expect(out.claimableTruncated.total).toBe(1677);
    expect(out.claimableTruncated.totalScope).toBe(upstream.totalScope);
    // ...and `shown` tracks what THIS rung actually delivered.
    expect(out.claimableTruncated.shown).toBe(out.claimable.length);
    // The regression guard proper: if a refactor re-derives `total` from the list it
    // was handed, this is what catches it.
    expect(out.claimableTruncated.total).not.toBe(out.claimable.length);
  });

  it('no upstream disclosure + its own cut ⇒ the delivered count IS the population', () => {
    // The handler emits its marker IFF its own fetch was incomplete, so ABSENCE is
    // informative: the handed-down list is the whole lane and `total` is honest here.
    const out = shapeOrient(
      { ok: true, me: 'x', claimable: Array.from({ length: 20 }, (_, i) => row(i)) },
      'trimmed',
    ) as { claimable: unknown[]; claimableTruncated?: Record<string, unknown> };
    expect(out.claimableTruncated?.total).toBe(20);
    expect(out.claimableTruncated?.shown).toBe(out.claimable.length);
  });

  it('ABSENT when this rung cuts nothing and nothing was cut upstream', () => {
    const out = shapeOrient({ ok: true, me: 'x', claimable: [row(0)] }, 'trimmed') as {
      claimableTruncated?: unknown;
    };
    expect(out.claimableTruncated).toBeUndefined();
  });

  it('a body clipped by THIS rung is flagged, and the fold-level marker survives', () => {
    // `cap()` appends a bare '…', which names no fetch path and is indistinguishable
    // from an ellipsis in the text itself — so the structural flag has to be raised
    // here too, and the handler's fold-level marker must not be dropped (EI-9031 class:
    // this rung rebuilds `memory` field-by-field, so anything unlisted vanishes).
    const out = shapeOrient(
      {
        ok: true,
        me: 'x',
        claimable: [],
        memory: {
          query: 'q',
          hits: [{ id: 'm1', memory: 'y'.repeat(400), score: 0.9 }],
          bodiesTruncated: { hits: 1, cap: 200, more: 'memory:search { query }' },
        },
      },
      'trimmed',
    ) as { memory: { hits: Array<Record<string, unknown>>; bodiesTruncated?: Record<string, unknown> } };

    expect(out.memory.hits[0].truncated).toBe(true);
    expect(out.memory.bodiesTruncated).toBeDefined();
    expect(out.memory.bodiesTruncated?.more).toMatch(/memory:search/);
  });

  it('ABSENT on the memory fold when no delivered body was clipped', () => {
    const out = shapeOrient(
      { ok: true, me: 'x', claimable: [], memory: { query: 'q', hits: [{ id: 'm1', memory: 'short', score: 0.9 }] } },
      'trimmed',
    ) as { memory: { hits: Array<Record<string, unknown>>; bodiesTruncated?: unknown } };
    expect(out.memory.hits[0].truncated).toBeUndefined();
    expect(out.memory.bodiesTruncated).toBeUndefined();
  });
});

describe('EI-20213176698128052: `recovery` is ladder-aware (the last uncapped passthrough)', () => {
  /** Measured on a real post-compaction payload BEFORE this fix: the ladder walked all
   *  the way to `floor` and still produced 23,786 chars against a 17,000 budget, with
   *  `recovery` 7,320 of it (30.8%) — larger than the whole 6,786-char overflow. Because
   *  `recovery` had no cap key, the ladder was mathematically unable to reach budget on
   *  the ONE path where `recovery` exists, and fell through to the generic projector,
   *  which drops WHOLE FIELDS. */
  const held = (i: number, o: { checkpointChars: number; priorTotal?: number }) => ({
    id: `WI-${3000 + i}`,
    title: `Held ${i}`,
    body: 'b'.repeat(600),
    checkpoint: 'c'.repeat(o.checkpointChars),
    ...(o.priorTotal
      ? {
          checkpointTruncated: {
            keptChars: o.checkpointChars,
            totalChars: o.priorTotal,
            withheldChars: o.priorTotal - o.checkpointChars,
            more: `work_items:get { id: 'WI-${3000 + i}' }`,
          },
        }
      : {}),
  });

  const fatInbox = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      kind: 'message',
      ts: '2026-08-12T00:00:00.000Z',
      from: `su-${i}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
      summary: `msg ${i} — ${'m'.repeat(900)}`,
    }));

  /** Post-compaction payload heavy enough to force the ladder past the rungs where the
   *  recovery caps are deliberate no-ops. `taskToolSchemaPack` is a real uncapped
   *  passthrough (2,530 chars in the measured specimen) and stands in here for the
   *  irreducible residue that makes the tighter rungs necessary at all. */
  const heavy = (checkpoints: unknown[]) => ({
    self: { ownerId: 'su-3a93abaa' },
    control: { state: { modes: ['auto'] } },
    taskToolSchemaPack: 'x'.repeat(6_000),
    inbox: { summary: { total: 500, returned: 25 }, entries: fatInbox(40) },
    recovery: { selfRecall: 'sessions:search { session: "self" }', loop: { active: true }, checkpoints },
  });

  it('TEETH: a tightened rung SHRINKS recovery.checkpoints instead of leaving them uncapped', () => {
    const many = Array.from({ length: 9 }, (_, i) => held(i, { checkpointChars: 1_200 }));
    const out = shapeOrient(heavy(many), 'trimmed') as Record<string, any>;

    // Rungs 0 and 1 leave the recovery caps at the upstream fixed values ON PURPOSE, so
    // name the rung: this test is only meaningful past the point where they tighten.
    expect(out.shaperTightened).toBeDefined();
    expect(['trimmed-half', 'floor']).toContain(out.shaperTightened.rung);
    const ckpt = out.recovery.checkpoints[0];
    // Before the fix this stayed at the full 1,200 no matter how tight the rung got.
    expect(ckpt.checkpoint.length).toBeLessThan(1_200);
    // ...but the field is still PRESENT and still carries content — never dropped.
    expect(out.recovery.checkpoints.length).toBeGreaterThan(0);
    expect(out.recovery.checkpoints.length).toBeLessThan(9);
    expect(ckpt.checkpoint.length).toBeGreaterThan(0);
    expect(out.recovery.selfRecall).toBeTruthy();
    expect(out.recovery.loop.active).toBe(true);
  });

  it('HONESTY: re-capping an already-disclosed excerpt reports the ORIGINAL total, not the excerpt length', () => {
    // Upstream (compaction-recovery.ts) already cut a 20,000-char checkpoint to 1,200 and
    // said so. A tighter rung re-caps that 1,200-char excerpt — and must NOT recompute the
    // total from the excerpt, which would report ~600 withheld for a checkpoint that is
    // really missing ~19,400. That under-report is a silent-loss regression in the very
    // code that exists to prevent one.
    const out = shapeOrient(heavy([held(2, { checkpointChars: 1_200, priorTotal: 20_000 })]), 'trimmed') as Record<
      string,
      any
    >;

    const t = out.recovery.checkpoints[0].checkpointTruncated;
    const kept = out.recovery.checkpoints[0].checkpoint.length;
    expect(t).toBeDefined();
    expect(t.totalChars).toBe(20_000);
    expect(t.keptChars).toBe(kept);
    expect(t.withheldChars).toBe(20_000 - kept);
    expect(t.more).toContain('work_items:get');

    // FALSIFIABLE CONTROL — the naive re-derivation this test exists to forbid. If
    // recapDisclosed ever recomputes the total from the excerpt it receives,
    // withheldChars collapses to this much smaller number and the assertions above fail.
    const naiveWithheld = 1_200 - kept;
    expect(t.withheldChars).not.toBe(naiveWithheld);
    expect(t.withheldChars).toBeGreaterThan(naiveWithheld);
  });

  it('D-004: dropping whole held items leaves a count + a fetch-pointer, never a silent short list', () => {
    const many = Array.from({ length: 9 }, (_, i) => held(i, { checkpointChars: 1_200 }));
    const out = shapeOrient(heavy(many), 'trimmed') as Record<string, any>;

    expect(out.recovery.checkpoints.length).toBeLessThan(9);
    expect(out.recovery.checkpointsTruncated.total).toBe(9);
    expect(out.recovery.checkpointsTruncated.shown).toBe(out.recovery.checkpoints.length);
    expect(out.recovery.checkpointsTruncated.more).toContain('work_items:list');
  });

  it('the happy path stays byte-identical — a payload that fits is not re-capped', () => {
    // trimmed's recovery caps are set to exactly the upstream fixed caps (1,200 / 600), so
    // rung 0 is a no-op. A fix that silently tightened the common case would fail here.
    const fits = {
      self: { ownerId: 'su-1' },
      recovery: { selfRecall: 'x', checkpoints: [held(1, { checkpointChars: 1_200 })] },
    };
    const out = shapeOrient(fits, 'trimmed') as Record<string, any>;
    expect(out.shaperTightened).toBeUndefined(); // it fit at rung 0
    expect(out.recovery.checkpoints[0].checkpoint).toBe('c'.repeat(1_200));
    expect(out.recovery.checkpoints[0].body).toBe('b'.repeat(600));
    expect(out.recovery.checkpoints[0].checkpointTruncated).toBeUndefined();
  });

  it('recovery shapes that carry no `checkpoints` array are left exactly as they were', () => {
    // The fix is deliberately narrow: only the checkpoints list is ladder-aware, so every
    // other recovery key keeps the passthrough guarantee it always had.
    const out = shapeOrient({ self: { ownerId: 'su-1' }, recovery: { blob: 'z'.repeat(40_000) } }, 'trimmed') as Record<
      string,
      any
    >;
    expect(out.recovery.blob.length).toBe(40_000);
  });
});

describe('EI-20213176698128052: floor-only disclosed optional-leg eviction', () => {
  const payload = () => ({
    self: { ownerId: 'su-e3259c03' },
    recovery: {
      selfRecall: "sessions:search { session:'self' }",
      checkpoints: [{ id: 'EI-20213176698128052', checkpoint: 'resume the fix' }],
    },
    ok: true,
    me: { agents: [{ agentId: 'su-e3259c03', isSelf: true }] },
    claimable: [],
    inbox: { summary: { total: 0 }, entries: [] },
    leaderBrief: { summary: { members: 1, dead: 0 } },
    laneClaim: { requested: ['P-001'], claimed: ['P-001'] },
    // Tier 3: expensive but transition-re-delivered. It must survive while a
    // lower-priority tier-4 candidate can recover enough space.
    taskToolSchemaPack: { blob: 's'.repeat(10_000) },
    // Lowest present tier-4 leg. One atomic eviction is sufficient.
    ownerPresent: { present: true, blob: 'o'.repeat(8_000) },
  });

  it('fits under budget by evicting a prefix of shared tier-4-then-tier-3 priority', () => {
    const source = payload();
    const out = shapeOrient(source, 'trimmed') as Record<string, any>;
    const omitted = out.optionalLegsOmitted.omitted as Array<{
      leg: string;
      fields?: string[];
      recoverVia: string;
    }>;
    const presentOrder = ORIENT_OPTIONAL_EVICTION_PRIORITY.filter((leg) =>
      leg.fields.some((field) => Object.prototype.hasOwnProperty.call(source, field)),
    ).map((leg) => leg.name);

    expect(JSON.stringify(out).length).toBeLessThanOrEqual(SHAPER_BUDGET_CHARS);
    expect(omitted.map((entry) => entry.leg)).toEqual(presentOrder.slice(0, omitted.length));
    expect(omitted[0]).toMatchObject({ leg: 'ownerPresent' });
    expect(omitted[0]).not.toHaveProperty('tier');
    expect(omitted[0]).not.toHaveProperty('fields');
    expect(omitted[0].recoverVia).toContain('coord:orient');
    const verbose = omitted.map((entry) => ({
      ...entry,
      tier: ORIENT_OPTIONAL_EVICTION_PRIORITY.find((leg) => leg.name === entry.leg)!.tier,
      fields: entry.fields ?? [entry.leg],
    }));
    expect(JSON.stringify(omitted).length).toBeLessThan(JSON.stringify(verbose).length);
    expect(out.ownerPresent).toBeUndefined();
    expect(out.taskToolSchemaPack).toBeDefined();
    expect(out.shaperTightened).toMatchObject({ rung: 'floor-optional-eviction' });
    expect(out.shaperTightened.overBudget).toBeUndefined();
  });

  it('retains exact omitted field groups and recovery hints for every evicted leg', () => {
    const source: Record<string, any> = { ...payload(), recovery: { blob: 'x'.repeat(40_000) } };
    for (const leg of ORIENT_OPTIONAL_EVICTION_PRIORITY) {
      for (const field of leg.fields) source[field] = { blob: 'x'.repeat(8_000) };
    }
    const out = shapeOrient(source, 'trimmed') as Record<string, any>;
    for (const entry of out.optionalLegsOmitted.omitted) {
      const leg = ORIENT_OPTIONAL_EVICTION_PRIORITY.find((leg) => leg.name === entry.leg)!;
      expect(entry.fields ?? [entry.leg]).toEqual(leg.fields);
      expect(entry.recoverVia).toBe(leg.recoverVia);
      for (const field of leg.fields) expect(out).not.toHaveProperty(field);
    }
    expect(out.optionalLegsOmitted.more).toContain("payloadTier:'full'");
  });

  it('never evicts core, recovery, leaderBrief, or laneClaim', () => {
    const out = shapeOrient(payload(), 'trimmed') as Record<string, any>;
    expect(out.self.ownerId).toBe('su-e3259c03');
    expect(out.recovery.selfRecall).toContain('sessions:search');
    expect(out.ok).toBe(true);
    expect(out.me).toBeDefined();
    expect(out.claimable).toEqual([]);
    expect(out.inbox).toBeDefined();
    expect(out.leaderBrief.summary.members).toBe(1);
    expect(out.laneClaim.claimed).toEqual(['P-001']);
  });
});
