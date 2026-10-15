import { describe, it, expect, beforeEach } from 'vitest';
import {
  issueToCandidate,
  readImprovementItems,
  readObservationItems,
  countImprovementItems,
  improvementSourceCounts,
  IMPROVEMENT_TOPIC,
  OBSERVATION_LANE,
  OBSERVATION_TOPIC,
} from './read-items';
import type { EngineerIssue, ListIssuesFilter } from '../../issues-engineer';

function issue(p: Partial<EngineerIssue> & { id: string; title: string }): EngineerIssue {
  return {
    kind: 'bug',
    scope: 'operator',
    body: '',
    severity: 'minor',
    source: 'su',
    state: 'open',
    assignee: null,
    assignedBy: null,
    assignedAt: null,
    payload: null,
    foundDuring: null,
    linkedFeatureId: null,
    createdBy: 'su-test',
    signalOrigin: 'organic',
    assigneeRank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    lastProgressAt: null,
    origin: 'local',
    terminalOwner: null,
    terminalCompletionRef: null,
    createdAt: '2026-06-04T00:00:00Z',
    updatedAt: '2026-06-04T00:00:00Z',
    closedAt: null,
    ...p,
  };
}

describe('issueToCandidate — native kind column (close-loop D-002, deriveKind retired)', () => {
  it('reads the kind COLUMN, not the title (no prefix parsing)', () => {
    const c = issueToCandidate(issue({ id: 'EI-9', title: 'presence overflows', kind: 'bug', severity: 'major' }));
    expect(c).toMatchObject({ id: 'EI-9', kind: 'bug', title: 'presence overflows', severity: 'major', scope: 'operator' });
  });

  it('kind=change passes through', () => {
    expect(issueToCandidate(issue({ id: 'EI-2', title: 'make it bigger', kind: 'change' })).kind).toBe('change');
  });

  it('payload.improvementKind=feature refines a change to a feature candidate', () => {
    const c = issueToCandidate(issue({ id: 'EI-3', title: 'new tab', kind: 'change', payload: { improvementKind: 'feature' } }));
    expect(c.kind).toBe('feature');
  });

  it('maps payload.paths → candidate.paths (the protected-path gate feed)', () => {
    const c = issueToCandidate(
      issue({ id: 'EI-4', title: 'x', kind: 'bug', payload: { paths: ['packages/operator-core/lib/release/deploy.ts', 7] } }),
    );
    expect(c.paths).toEqual(['packages/operator-core/lib/release/deploy.ts']); // non-strings dropped
  });

  it('maps only the observation lane provenance and omits the ordinary lane', () => {
    const observed = issueToCandidate(
      issue({ id: 'EI-OBS', title: 'agent reflection', kind: 'change', payload: { lane: 'observation' } }),
    );
    expect(observed.lane).toBe('observation');
    expect(issueToCandidate(issue({ id: 'EI-ORD', title: 'ordinary improvement', kind: 'bug' }))).not.toHaveProperty('lane');
  });

  it('maps payload.implementAttempts + split owner/legacy flags + assignedAt (the close-loop lifecycle)', () => {
    const c = issueToCandidate(
      issue({
        id: 'EI-5',
        title: 'x',
        kind: 'bug',
        assignee: 'improvement-runner',
        assignedAt: '2026-06-05T01:00:00Z',
        payload: { implementAttempts: 2, needsHuman: true, needsOwnerAction: true },
      }),
    );
    expect(c.attempts).toBe(2);
    expect(c.needsHuman).toBe(true);
    expect(c.needsOwnerAction).toBe(true);
    expect(c.assignedAt).toBe('2026-06-05T01:00:00Z');
  });

  it('omits the lifecycle fields when the payload has none', () => {
    const c = issueToCandidate(issue({ id: 'EI-6', title: 'x', kind: 'bug' }));
    expect(c.attempts).toBeUndefined();
    expect(c.needsHuman).toBeUndefined();
    expect(c.needsOwnerAction).toBeUndefined();
    expect(c.paths).toBeUndefined();
  });

  it('maps payload.sourceRole → candidate.sourceRole (P-010 source-tag)', () => {
    const c = issueToCandidate(
      issue({
        id: 'EI-7',
        title: 'system-filed bug',
        kind: 'bug',
        payload: { sourceRole: 'system' },
      }),
    );
    expect(c.sourceRole).toBe('system');
  });

  it('extracts sourceRole for Queen, bee, and system roles (P-010)', () => {
    for (const role of ['Queen', 'cup', 'system', 'human'] as const) {
      const c = issueToCandidate(
        issue({
          id: `EI-${role}`,
          title: `${role}-filed idea`,
          kind: 'change',
          payload: { sourceRole: role },
        }),
      );
      expect(c.sourceRole).toBe(role);
    }
  });

  it('maps payload.findingClass → candidate.findingClass (frontier P-044 taxonomy slug)', () => {
    const c = issueToCandidate(
      issue({
        id: 'EI-8',
        title: 'resolution gap',
        kind: 'bug',
        payload: { findingClass: 'negative-space:resolution-gap' },
      }),
    );
    expect(c.findingClass).toBe('negative-space:resolution-gap');
    // absent / non-string stays absent
    expect(issueToCandidate(issue({ id: 'EI-9', title: 'y', kind: 'bug' })).findingClass).toBeUndefined();
    expect(
      issueToCandidate(issue({ id: 'EI-10', title: 'z', kind: 'bug', payload: { findingClass: 7 } })).findingClass,
    ).toBeUndefined();
  });
});

describe('readImprovementItems', () => {
  it('queries the papercusp-improvement topic and maps to candidates (injected lister, no PG)', async () => {
    const calls: unknown[] = [];
    const fakeList = async (filter: unknown) => {
      calls.push(filter);
      return [
        issue({ id: 'EI-1', title: 'a', kind: 'bug', severity: 'critical' }),
        issue({ id: 'EI-2', title: 'a plain change', kind: 'change' }),
      ];
    };
    const items = await readImprovementItems({}, { listIssues: fakeList });
    expect(calls[0]).toMatchObject({ topic: IMPROVEMENT_TOPIC });
    expect(items.map((i) => i.kind)).toEqual(['bug', 'change']);
    expect(items.map((i) => i.id)).toEqual(['EI-1', 'EI-2']);
  });

  it('passes the state filter through', async () => {
    let seen: any;
    await readImprovementItems({ state: 'open' }, { listIssues: async (f) => ((seen = f), []) });
    expect(seen).toMatchObject({ topic: IMPROVEMENT_TOPIC, state: 'open' });
  });

  it('passes bounded kind, severity, scope, and q filters through the read seam', async () => {
    let seen: ListIssuesFilter | undefined;
    await readImprovementItems(
      {
        q: 'timeout',
        kinds: ['bug'],
        severities: ['critical'],
        scopes: ['harness:foo'],
      },
      { listIssues: async (filter) => ((seen = filter), []) },
    );
    expect(seen).toMatchObject({
      topic: IMPROVEMENT_TOPIC,
      q: 'timeout',
      kinds: ['bug'],
      severities: ['critical'],
      scope: 'harness:foo',
    });
  });

  it('WI-9454: windows the newest rows independently for every discovered scope', async () => {
    const scopeCalls: ListIssuesFilter[] = [];
    const items = await readImprovementItems(
      { windowPerScope: true, limit: 2 },
      {
        listScopes: async (filter) => {
          expect(filter).toMatchObject({ topic: IMPROVEMENT_TOPIC, signalOrigins: ['organic'] });
          return ['operator', 'harness:foo'];
        },
        listIssues: async (filter) => {
          scopeCalls.push(filter);
          return [
            issue({ id: `${filter.scope}-1`, title: `${filter.scope} issue`, scope: filter.scope }),
          ];
        },
      },
    );

    expect(scopeCalls).toHaveLength(2);
    expect(scopeCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ topic: IMPROVEMENT_TOPIC, scope: 'operator', limit: 2 }),
        expect.objectContaining({ topic: IMPROVEMENT_TOPIC, scope: 'harness:foo', limit: 2 }),
      ]),
    );
    expect(items.map((item) => item.scope).sort()).toEqual(['harness:foo', 'operator']);
  });

  it('(P-010) filters by harness scope when harnessSlug is provided', async () => {
    const allIssues = [
      issue({ id: 'EI-1', title: 'a bug', kind: 'bug', scope: 'operator' }),
      issue({ id: 'EI-2', title: 'harness-foo issue', kind: 'change', scope: 'harness:foo' }),
      issue({ id: 'EI-3', title: 'harness-bar issue', kind: 'change', scope: 'harness:bar' }),
      issue({ id: 'EI-4', title: 'another foo issue', kind: 'change', scope: 'harness:foo' }),
    ];
    const fakeList = async () => allIssues;

    // With no harnessSlug, should return all
    const all = await readImprovementItems({}, { listIssues: fakeList });
    expect(all.length).toBe(4);

    // With harnessSlug='foo', should return only 'harness:foo' scoped issues
    const fooItems = await readImprovementItems({ harnessSlug: 'foo' }, { listIssues: fakeList });
    expect(fooItems.length).toBe(2);
    expect(fooItems.map((i) => i.id)).toEqual(['EI-2', 'EI-4']);
    expect(fooItems.every((i) => i.scope === 'harness:foo')).toBe(true);

    // With harnessSlug='bar', should return only 'harness:bar' scoped issues
    const barItems = await readImprovementItems({ harnessSlug: 'bar' }, { listIssues: fakeList });
    expect(barItems.length).toBe(1);
    expect(barItems[0]?.id).toBe('EI-3');
  });

  it('(P-040) filters by a Hive member-harness scope SET when harnessScopes is provided', async () => {
    const allIssues = [
      issue({ id: 'EI-1', title: 'operator-wide', kind: 'bug', scope: 'operator' }),
      issue({ id: 'EI-2', title: 'home issue', kind: 'change', scope: 'harness:my-hive' }),
      issue({ id: 'EI-3', title: 'member issue', kind: 'change', scope: 'harness:member-a' }),
      issue({ id: 'EI-4', title: 'other-hive issue', kind: 'change', scope: 'harness:other' }),
    ];
    const fakeList = async () => allIssues;
    // The Hive lens = the home + member-a scopes; 'other' and 'operator' are excluded.
    const items = await readImprovementItems(
      { harnessScopes: ['harness:my-hive', 'harness:member-a'] },
      { listIssues: fakeList },
    );
    expect(items.map((i) => i.id)).toEqual(['EI-2', 'EI-3']);
  });

  it('(P-040) harnessScopes takes precedence over harnessSlug when both are set', async () => {
    const allIssues = [
      issue({ id: 'EI-2', title: 'home', kind: 'change', scope: 'harness:my-hive' }),
      issue({ id: 'EI-9', title: 'foo', kind: 'bug', scope: 'harness:foo' }),
    ];
    const items = await readImprovementItems(
      { harnessSlug: 'foo', harnessScopes: ['harness:my-hive'] },
      { listIssues: async () => allIssues },
    );
    expect(items.map((i) => i.id)).toEqual(['EI-2']); // the scope set wins, not 'foo'
  });

  it('(P-040) an EMPTY harnessScopes set matches nothing (a Hive with no member harnesses)', async () => {
    const items = await readImprovementItems(
      { harnessScopes: [] },
      { listIssues: async () => [issue({ id: 'EI-1', title: 'x', kind: 'bug', scope: 'harness:my-hive' })] },
    );
    expect(items).toEqual([]);
  });
});

describe('countImprovementItems (EI-18790490225750395 D2 — the TRUE corpus total, unbounded by limit)', () => {
  it('keeps bounded kind, severity, scope, and q filters in parity with the read', async () => {
    const calls: ListIssuesFilter[] = [];
    await countImprovementItems(
      {
        q: 'timeout',
        kinds: ['bug'],
        severities: ['critical'],
        scopes: ['harness:foo'],
      },
      { countIssues: async (filter) => (calls.push(filter), 4) },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      topic: IMPROVEMENT_TOPIC,
      q: 'timeout',
      kinds: ['bug'],
      severities: ['critical'],
      scope: 'harness:foo',
    });
    expect(calls[0]).not.toHaveProperty('limit');
  });

  it('counts the SAME filter readImprovementItems applies, with no `limit` in it anywhere', async () => {
    const calls: ListIssuesFilter[] = [];
    const n = await countImprovementItems(
      { state: 'open' },
      { countIssues: async (f) => (calls.push(f), 4321) },
    );
    expect(n).toBe(4321);
    expect(calls[0]).toMatchObject({ topic: IMPROVEMENT_TOPIC, state: 'open' });
    expect(calls[0]).not.toHaveProperty('limit');
  });

  it('is INVARIANT under any `limit` the caller might separately pass to readImprovementItems — ' +
    'countImprovementItems takes no limit argument at all, so there is nothing for a caller to vary', async () => {
    // (b) of the ticket's required recurrence guard: total must not move when limit does.
    const countIssues = async () => 777;
    const atSmallWindow = await countImprovementItems({}, { countIssues });
    const atLargeWindow = await countImprovementItems({}, { countIssues });
    expect(atSmallWindow).toBe(atLargeWindow);
    expect(atSmallWindow).toBe(777);
  });

  it('scopes to a single harnessSlug as one COUNT with scope=harness:<slug>', async () => {
    const calls: ListIssuesFilter[] = [];
    const n = await countImprovementItems(
      { harnessSlug: 'foo' },
      { countIssues: async (f) => (calls.push(f), 12) },
    );
    expect(n).toBe(12);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ scope: 'harness:foo' });
  });

  it('sums one COUNT per scope for a harnessScopes SET (no SQL IN-list support)', async () => {
    const calls: ListIssuesFilter[] = [];
    const n = await countImprovementItems(
      { harnessScopes: ['harness:my-hive', 'harness:member-a'] },
      { countIssues: async (f) => (calls.push(f), f.scope === 'harness:my-hive' ? 3 : 5) },
    );
    expect(n).toBe(8);
    expect(calls.map((c) => c.scope).sort()).toEqual(['harness:member-a', 'harness:my-hive']);
  });

  it('an EMPTY harnessScopes set is 0 without even calling countIssues (mirrors readImprovementItems)', async () => {
    let called = false;
    const n = await countImprovementItems(
      { harnessScopes: [] },
      { countIssues: async () => ((called = true), 999) },
    );
    expect(n).toBe(0);
    expect(called).toBe(false);
  });

  it('harnessScopes takes precedence over harnessSlug when both are set (mirrors readImprovementItems)', async () => {
    const calls: ListIssuesFilter[] = [];
    await countImprovementItems(
      { harnessSlug: 'foo', harnessScopes: ['harness:my-hive'] },
      { countIssues: async (f) => (calls.push(f), 1) },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.scope).toBe('harness:my-hive');
  });

  // ── loopOutputOnly counts (WI-39675) ────────────────────────────────────────
  //
  // The Learning tab's DEFAULT scope is 'loop', so without a loop-scoped COUNT the
  // tab could only ever report its read WINDOW as the total. The requirement is
  // narrow and easy to get wrong in the harmful direction: the count must be taken
  // over the SAME population the matching read returns, never over the untagged
  // corpus — a total LARGER than the truth is worse than the window bug, because it
  // reads as a plausible corpus count instead of an obviously pinned one.

  it('counts the loop-scoped population by resolving ids into the SAME issueIds predicate the read uses', async () => {
    const calls: ListIssuesFilter[] = [];
    const n = await countImprovementItems(
      { loopOutputOnly: true },
      {
        countIssues: async (f) => (calls.push(f), 3),
        readLoopOutputIds: async () => ['EI-1', 'EI-2', 'EI-3'],
      },
    );
    expect(n).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.issueIds).toEqual(['EI-1', 'EI-2', 'EI-3']);
    // The scope really did narrow the query: an unscoped count would carry no id
    // predicate at all, which is the failure mode that silently counts everything.
    expect(calls[0]?.issueIds).toBeDefined();
  });

  it('returns 0 for an EMPTY loop-output set instead of degrading to an unscoped count', async () => {
    // Mirrors the harnessScopes empty-set rule: an empty id set matches nothing.
    // Degrading here would report the whole untagged corpus under a name that
    // promises the loop's output — reinstating the 8,202-row duplication.
    let called = false;
    const n = await countImprovementItems(
      { loopOutputOnly: true },
      { countIssues: async () => ((called = true), 8202), readLoopOutputIds: async () => [] },
    );
    expect(n).toBe(0);
    expect(called).toBe(false);
  });

  it('fails loudly when loopOutputOnly is asked for without the id resolver, rather than silently counting the untagged whole corpus', async () => {
    await expect(
      countImprovementItems({ loopOutputOnly: true }, { countIssues: async () => 0 }),
    ).rejects.toThrow(/loopOutputOnly/);
  });
});

describe('improvementSourceCounts (WI-471938 — the corpus source VOCABULARY, not the window\'s)', () => {
  // The bug this guards: the Learning tab derived its "Filed by" chip OPTIONS from the
  // projected rows, so a source whose rows all sat past the 500-row window offered no chip
  // and could not be selected. Measured live 2026-08-28: `system` had 15 corpus rows and 0
  // in the window. The remedy is structural — ask for an aggregate over the same predicate
  // the read applies — so these assertions are about the PREDICATE, not about any count.

  it('asks over the SAME filter readImprovementItems applies, with no `limit` in it anywhere', async () => {
    const calls: ListIssuesFilter[] = [];
    const counts = await improvementSourceCounts(
      { q: 'timeout', kinds: ['bug'], severities: ['critical'], state: 'open' },
      { countIssuesBySourceRole: async (f) => (calls.push(f), { Scout: 7, system: 15 }) },
    );
    expect(counts).toEqual({ Scout: 7, system: 15 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      topic: IMPROVEMENT_TOPIC,
      q: 'timeout',
      kinds: ['bug'],
      severities: ['critical'],
      state: 'open',
    });
    // A `limit` here would reintroduce the very defect: a windowed vocabulary read as the
    // corpus's. The function takes no limit argument, so there is nothing to vary.
    expect(calls[0]).not.toHaveProperty('limit');
  });

  it('resolves loopOutputOnly into the SAME issueIds predicate the read and the count use', async () => {
    const calls: ListIssuesFilter[] = [];
    await improvementSourceCounts(
      { loopOutputOnly: true },
      {
        countIssuesBySourceRole: async (f) => (calls.push(f), { Scout: 1 }),
        readLoopOutputIds: async () => ['EI-1', 'EI-2'],
      },
    );
    expect(calls[0]?.issueIds).toEqual(['EI-1', 'EI-2']);
  });

  it('an EMPTY loop-output id set is {} — never a vocabulary read over the untagged corpus', async () => {
    // Mirrors countImprovementItems' own empty-set rule. Degrading to an unscoped read here
    // would offer chips for sources that are not in the loop's output at all.
    let called = false;
    const counts = await improvementSourceCounts(
      { loopOutputOnly: true },
      {
        countIssuesBySourceRole: async () => ((called = true), { Scout: 9 }),
        readLoopOutputIds: async () => [],
      },
    );
    expect(counts).toEqual({});
    expect(called).toBe(false);
  });

  it('fails LOUDLY when loopOutputOnly has no resolver, rather than reading the whole corpus', async () => {
    await expect(
      improvementSourceCounts({ loopOutputOnly: true }, { countIssuesBySourceRole: async () => ({}) }),
    ).rejects.toThrow(/readLoopOutputIds/);
  });

  it('sums one aggregate per scope for a harnessScopes SET, merging the per-source counts', async () => {
    const calls: ListIssuesFilter[] = [];
    const counts = await improvementSourceCounts(
      { harnessScopes: ['harness:my-hive', 'harness:member-a'] },
      {
        countIssuesBySourceRole: async (f): Promise<Record<string, number>> => {
          calls.push(f);
          return f.scope === 'harness:my-hive' ? { Scout: 3, system: 1 } : { Scout: 5 };
        },
      },
    );
    // Scout appears in BOTH scopes and must be summed, not overwritten by the last read.
    expect(counts).toEqual({ Scout: 8, system: 1 });
    expect(calls.map((c) => c.scope).sort()).toEqual(['harness:member-a', 'harness:my-hive']);
  });

  it('an EMPTY harnessScopes set is {} without calling the aggregate (mirrors the read)', async () => {
    let called = false;
    const counts = await improvementSourceCounts(
      { harnessScopes: [] },
      { countIssuesBySourceRole: async () => ((called = true), { Scout: 9 }) },
    );
    expect(counts).toEqual({});
    expect(called).toBe(false);
  });

  it('preserves the empty-key bucket the SQL layer returns — "unfiled" is data, not absence', async () => {
    // The '' key is how a row with no sourceRole is reported, and keeping it is what makes
    // the histogram total equal countIssues() over the same filter. Dropping it is the
    // CALLER's job (an unfiled row is not a selectable chip), and doing it here instead
    // would silently make this aggregate disagree with the count beside it.
    const counts = await improvementSourceCounts(
      {},
      { countIssuesBySourceRole: async () => ({ '': 1048, Scout: 1007, system: 15 }) },
    );
    expect(counts['']).toBe(1048);
  });
});

describe('readObservationItems (turn-end-reflection-observations-2026-06-14 D-005)', () => {
  it('selects the SEPARATE observation LANE — never the improvement topic (keeps observations out of the work pipeline)', async () => {
    // P-006/D-031: this used to assert `topic: OBSERVATION_TOPIC`. The intent is
    // unchanged — observations are selected by something of their OWN, so they can
    // never be read as improvement work — but the selector is now the `lane` column.
    // The topic join was fenced to coordScopeWorkspace() and under-read the population
    // by 834 rows, in both directions; `lane` is the same column the claim-queue
    // EXCLUSION keys on, which is what makes the two sides agree.
    let seen: any;
    await readObservationItems({}, { listIssues: async (f) => ((seen = f), []) });
    expect(seen).toMatchObject({ lane: OBSERVATION_LANE });
    expect(seen.topic).toBeUndefined();
    expect(seen.lane).not.toBe(IMPROVEMENT_TOPIC);
  });

  it('maps observation rows to candidates', async () => {
    const items = await readObservationItems(
      {},
      { listIssues: async () => [issue({ id: 'EI-OBS-1', title: 'docs were stale', kind: 'change' })] },
    );
    expect(items.map((i) => i.id)).toEqual(['EI-OBS-1']);
  });
});

describe('readImprovementItems — signal provenance gate (frontier P-002 / D-002)', () => {
  const mixedStore = [
    issue({ id: 'EI-1', title: 'a real bug', kind: 'bug' }), // organic (helper default)
    issue({ id: 'EI-2', title: 'planted flaky test', kind: 'bug', signalOrigin: 'drill' }),
    issue({ id: 'EI-3', title: 'replay counterfactual artifact', kind: 'change', signalOrigin: 'replay' }),
    issue({ id: 'EI-4', title: 'shadow ablation artifact', kind: 'change', signalOrigin: 'shadow' }),
  ];

  it('DEFAULT read passes the organic-only allowlist down to listIssues (SQL-side filter)', async () => {
    let seen: any;
    await readImprovementItems({}, { listIssues: async (f) => ((seen = f), []) });
    expect(seen.signalOrigins).toEqual(['organic']);
  });

  it('DEFAULT read excludes every synthetic row even when the lister ignores signalOrigins (belt + braces)', async () => {
    // Fake lister returns the FULL mixed store regardless of the filter — the
    // TS-side gate must still keep drill/replay/shadow away from the consumer.
    const items = await readImprovementItems({}, { listIssues: async () => mixedStore });
    expect(items.map((i) => i.id)).toEqual(['EI-1']);
    expect(items[0]?.origin).toBe('organic');
  });

  it('a row with NO stored origin reads as organic (pre-migration legacy semantics)', async () => {
    const legacy = issue({ id: 'EI-9', title: 'legacy row', kind: 'bug' });
    delete (legacy as unknown as Record<string, unknown>).signalOrigin;
    const items = await readImprovementItems({}, { listIssues: async () => [legacy] });
    expect(items.map((i) => i.id)).toEqual(['EI-9']);
  });

  it('a junk origin value fails CLOSED — excluded from organic reads', async () => {
    const junk = issue({ id: 'EI-9', title: 'junk-origin row', kind: 'bug' });
    (junk as unknown as Record<string, unknown>).signalOrigin = 'mystery';
    const items = await readImprovementItems({}, { listIssues: async () => [junk] });
    expect(items).toEqual([]);
  });

  it('explicit opt-in sees exactly the requested origins (the vaccination measurement read)', async () => {
    const items = await readImprovementItems({ origins: ['drill'] }, { listIssues: async () => mixedStore });
    expect(items.map((i) => i.id)).toEqual(['EI-2']);
    expect(items[0]?.origin).toBe('drill');
  });

  it('multi-origin opt-in composes (replay + shadow audit read)', async () => {
    const items = await readImprovementItems(
      { origins: ['replay', 'shadow'] },
      { listIssues: async () => mixedStore },
    );
    expect(items.map((i) => i.id)).toEqual(['EI-3', 'EI-4']);
  });

  it('issueToCandidate carries the origin onto the candidate', () => {
    const c = issueToCandidate(issue({ id: 'EI-2', title: 'planted', kind: 'bug', signalOrigin: 'drill' }));
    expect(c.origin).toBe('drill');
  });
});

describe('issueToCandidate — federation workItemOrigin, DISTINCT from signalOrigin (EI-15659)', () => {
  it('a remote-authored (federated) row surfaces workItemOrigin:remote', () => {
    const c = issueToCandidate(issue({ id: 'EI-10524', title: 'federated in', kind: 'bug', origin: 'remote' }));
    expect(c.workItemOrigin).toBe('remote');
  });

  it('WI-10006515: an OWN-NODE row stranded at origin=remote omits workItemOrigin (not routed to human)', () => {
    const c = issueToCandidate(issue({ id: 'EI-OWN', title: 'ours', kind: 'bug', origin: 'remote' }), { ownNode: true });
    expect(c).not.toHaveProperty('workItemOrigin');
  });

  it('WI-10006515: readImprovementItems classifies remote rows in ONE batch; a true peer row keeps its label', async () => {
    const asked: string[][] = [];
    const items = await readImprovementItems(
      {},
      {
        listIssues: async () => [
          issue({ id: 'EI-OWN', title: 'ours', kind: 'bug', origin: 'remote' }),
          issue({ id: 'EI-PEER', title: 'theirs', kind: 'bug', origin: 'remote' }),
          issue({ id: 'EI-LOC', title: 'local', kind: 'bug', origin: 'local' }),
        ],
        ownNodeRemoteIds: async (ids) => ((asked.push([...ids])), new Set(['EI-OWN'])),
      },
    );
    expect(asked).toEqual([['EI-OWN', 'EI-PEER']]);
    expect(Object.fromEntries(items.map((c) => [c.id, c.workItemOrigin ?? null]))).toEqual({
      'EI-OWN': null,
      'EI-PEER': 'remote',
      'EI-LOC': null,
    });
  });

  it('WI-10006515: a failing classifier is fail-closed (every remote row keeps its label); no remote row ⇒ no call', async () => {
    const failing = await readImprovementItems(
      {},
      {
        listIssues: async () => [issue({ id: 'EI-R', title: 'r', kind: 'bug', origin: 'remote' })],
        ownNodeRemoteIds: async () => {
          throw new Error('pg down');
        },
      },
    );
    expect(failing[0]!.workItemOrigin).toBe('remote');

    let called = false;
    await readImprovementItems(
      {},
      {
        listIssues: async () => [issue({ id: 'EI-L', title: 'l', kind: 'bug', origin: 'local' })],
        ownNodeRemoteIds: async () => ((called = true), new Set<string>()),
      },
    );
    expect(called).toBe(false);
  });

  it('a local row omits workItemOrigin (byte-identical candidate for the common case)', () => {
    const c = issueToCandidate(issue({ id: 'EI-1', title: 'local', kind: 'bug', origin: 'local' }));
    expect(c.workItemOrigin).toBeUndefined();
  });

  it('a null-origin (legacy pre-federation) row also omits workItemOrigin', () => {
    const c = issueToCandidate(issue({ id: 'EI-0', title: 'legacy', kind: 'bug', origin: null }));
    expect(c.workItemOrigin).toBeUndefined();
  });
});

describe('issueToCandidate — payload.ideation surfacing (su-ideate-learning-substrate P-007)', () => {
  const stored = {
    lens: 'risk-first',
    bet: 'halves triage latency for su ideas',
    cheapExperiment: {
      hypothesis: 'triage decisions land twice as fast',
      method: 'measure one week of triage latency',
      falsifiableSignal: 'median triage latency unchanged',
    },
  };

  it('surfaces the persisted payload.ideation verbatim', () => {
    const c = issueToCandidate(
      issue({ id: 'EI-70', title: 'su idea', kind: 'change', payload: { improvementKind: 'feature', ideation: stored } }),
    );
    expect(c.ideation).toEqual(stored);
  });

  it('absent on rows without ideation (enrichment only — the common case)', () => {
    expect(issueToCandidate(issue({ id: 'EI-71', title: 'plain', kind: 'bug' })).ideation).toBeUndefined();
  });

  it('junk shapes read as absent, never throw (untrusted payload round-trip)', () => {
    expect(
      issueToCandidate(issue({ id: 'EI-72', title: 'x', kind: 'bug', payload: { ideation: 'nope' } })).ideation,
    ).toBeUndefined();
    expect(
      issueToCandidate(issue({ id: 'EI-73', title: 'x', kind: 'bug', payload: { ideation: { lens: 42, bet: '   ' } } }))
        .ideation,
    ).toBeUndefined();
  });

  it('keeps only string fields of a partial cheapExperiment (completeness judged later by isBettable)', () => {
    const c = issueToCandidate(
      issue({
        id: 'EI-74',
        title: 'x',
        kind: 'change',
        payload: { ideation: { cheapExperiment: { hypothesis: 'a real hypothesis', method: 7 } } },
      }),
    );
    expect(c.ideation).toEqual({ cheapExperiment: { hypothesis: 'a real hypothesis' } });
  });
});

describe('loopOutputOnly — the Improve view scope (learning-tab-surface P-001 / D-002)', () => {
  const seen: ListIssuesFilter[] = [];
  const capture = (rows: EngineerIssue[] = []) => ({
    listIssues: async (f: ListIssuesFilter) => {
      seen.push(f);
      return rows;
    },
  });

  beforeEach(() => {
    seen.length = 0;
  });

  it('pushes the provenance union into the SQL filter, NOT a post-hoc filter', async () => {
    // The whole point: `limit` is applied by Postgres. If the scope were applied
    // after the read we would get the first N of the 8,272-row corpus and THEN
    // shrink it — an arbitrary fraction of the real answer that still looks fine.
    await readImprovementItems(
      { loopOutputOnly: true, limit: 500 },
      { ...capture(), readLoopOutputIds: async () => ['EI-1', 'EI-2', 'EI-3'] },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.issueIds).toEqual(['EI-1', 'EI-2', 'EI-3']);
    expect(seen[0]?.topic).toBe(IMPROVEMENT_TOPIC);
    expect(seen[0]?.limit).toBe(500);
  });

  it('an EMPTY union matches nothing rather than falling back to the whole corpus', async () => {
    await readImprovementItems(
      { loopOutputOnly: true },
      { ...capture(), readLoopOutputIds: async () => [] },
    );
    // [] must reach SQL as an empty ANY() (matches no row) — NOT be dropped as
    // falsy, which would silently widen the scope back to every captured improvement.
    expect(seen[0]?.issueIds).toEqual([]);
  });

  it('THROWS when the scope is requested without a resolver, instead of silently widening', async () => {
    await expect(readImprovementItems({ loopOutputOnly: true }, capture())).rejects.toThrow(
      /readLoopOutputIds/,
    );
  });

  it('omits issueIds entirely when the scope is off — byte-identical to the old read', async () => {
    await readImprovementItems({}, capture());
    expect(seen[0]).not.toHaveProperty('issueIds');
  });

  it('observations never carry the loop-output scope (separate LANE selector, D-005/D-031)', async () => {
    await readObservationItems({}, capture());
    expect(seen[0]?.lane).toBe(OBSERVATION_LANE);
    expect(seen[0]?.topic).toBeUndefined();
    expect(seen[0]).not.toHaveProperty('issueIds');
  });
});
