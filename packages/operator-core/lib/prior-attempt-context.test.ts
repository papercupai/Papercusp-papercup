import { describe, expect, it, vi } from 'vitest';
import {
  buildBoundedPriorAttemptBrief,
  collectPriorAttempts,
  compilePriorAttempts,
  getClaimTimePriorAttemptBrief,
  resolvePriorAttemptRefs,
  type PriorAttemptSource,
} from './prior-attempt-context';
import type { WorkItem } from './work-items';

function source(overrides: Partial<PriorAttemptSource> = {}): PriorAttemptSource {
  return {
    scope: 'plan-wide',
    authority: 'comment',
    rawRef: 'WI-1#comment:1',
    at: '2026-08-20T12:00:00.000Z',
    text: 'Tried the first approach.',
    ...overrides,
  };
}

describe('compilePriorAttempts', () => {
  it('orders canonical authority first, then attempt scope before lower-authority prose', () => {
    const result = compilePriorAttempts([
      source({ rawRef: 'plan#D-001', authority: 'plan-decision', text: 'Plan-wide ruling.' }),
      source({ rawRef: 'WI-2#comment:1', scope: 'same-spec', text: 'Same-spec comment.' }),
      source({ rawRef: 'WI-2#checkpoint', scope: 'same-spec', authority: 'checkpoint', text: 'Checkpoint.' }),
      source({ rawRef: 'WI-2#comment:2', scope: 'same-spec', authority: 'retraction', text: 'False premise: helper was absent.' }),
      source({ rawRef: 'plan#SPEC-1@2', scope: 'same-spec', authority: 'current-spec', text: 'Current behavior.' }),
      source({ rawRef: 'WI-3#completion', scope: 'same-plan-item', authority: 'verified-completion', text: 'Passed.' }),
    ]);
    expect(result.records.map((record) => record.rawRef)).toEqual([
      'plan#SPEC-1@2',
      'plan#D-001',
      'WI-2#comment:2',
      'WI-2#checkpoint',
      'WI-2#comment:1',
      'WI-3#completion',
    ]);
  });

  it('keeps the newest/richer duplicate raw authority ref exactly once', () => {
    const result = compilePriorAttempts([
      source({ text: 'old', at: '2026-08-20T10:00:00Z' }),
      source({ text: 'new and richer', at: '2026-08-20T11:00:00Z' }),
    ]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.text).toBe('new and richer');
    expect(result.deduplicatedCount).toBe(1);
  });

  it('normalizes root cause, retraction, files, tests, and residue without inventing absent fields', () => {
    const result = compilePriorAttempts([
      source({
        authority: 'retraction',
        text: [
          'Approach: changed packages/operator-core/lib/foo.ts.',
          'Root cause: caller discarded the revision.',
          'False premise: there was no existing reader.',
          'Tests: npm run test:file -- packages/operator-core/lib/foo.test.ts',
          'Residue: migration verification remains.',
        ].join('\n'),
      }),
    ]);
    const record = result.records[0]!;
    expect(record.rootCauses).toEqual(['caller discarded the revision.']);
    expect(record.falsePremises).toEqual(['there was no existing reader.']);
    expect(record.touchedFiles).toEqual(expect.arrayContaining([
      'packages/operator-core/lib/foo.ts',
      'packages/operator-core/lib/foo.test.ts',
    ]));
    expect(record.tests.join(' ')).toContain('npm run test:file');
    expect(record.residue).toEqual(['migration verification remains.']);
    expect(record.outcome).toBeNull();
  });

  it('uses deterministic fingerprints independent of caller input order', () => {
    const a = source({ rawRef: 'a', scope: 'same-spec', text: 'A' });
    const b = source({ rawRef: 'b', authority: 'checkpoint', text: 'B' });
    expect(compilePriorAttempts([a, b]).fingerprint).toBe(compilePriorAttempts([b, a]).fingerprint);
  });
});

describe('buildBoundedPriorAttemptBrief', () => {
  it('keeps canonical authority and residue while disclosing large-history omissions', () => {
    const sources: PriorAttemptSource[] = [
      source({ rawRef: 'plan#SPEC-1@3', authority: 'current-spec', scope: 'same-spec', text: 'Current contract.' }),
      source({ rawRef: 'plan#D-008', authority: 'plan-decision', text: 'Canonical authority wins.' }),
      source({ rawRef: 'WI-2#comment:9', authority: 'retraction', scope: 'same-spec', text: 'False premise: the reader was absent.' }),
      source({ rawRef: 'WI-2#checkpoint', authority: 'checkpoint', scope: 'same-spec', text: 'Residue: live verification remains.' }),
      ...Array.from({ length: 80 }, (_, index) => source({
        rawRef: `WI-${index + 10}#comment:1`,
        text: `Attempt ${index} ${'x'.repeat(300)}`,
      })),
    ];
    const brief = buildBoundedPriorAttemptBrief(compilePriorAttempts(sources), {
      maxChars: 5_000,
      maxRecords: 12,
      maxTextChars: 300,
    })!;
    expect(brief.authority.map((record) => record.rawRef)).toEqual([
      'plan#SPEC-1@3', 'plan#D-008', 'WI-2#comment:9',
    ]);
    expect(brief.protectedRefs.authority.map((record) => record.rawRef)).toEqual([
      'plan#SPEC-1@3', 'plan#D-008', 'WI-2#comment:9',
    ]);
    expect(brief.residue).toEqual([{ rawRef: 'WI-2#checkpoint', workItemId: undefined, items: ['live verification remains.'] }]);
    expect(brief.omission.truncated).toBe(true);
    expect(brief.omission.omittedRecords).toBeGreaterThan(0);
    expect(brief.omission.omittedByAuthority.comment).toBeGreaterThan(0);
    expect(brief.serializedChars).toBeLessThanOrEqual(5_000);
    expect(brief.rawRefs).toEqual([...new Set(brief.rawRefs)]);
  });

  it('hard-bounds extreme protected history while retaining every protected raw ref', () => {
    const sources = Array.from({ length: 80 }, (_, index) => source({
      rawRef: `plan#D-${String(index + 1).padStart(3, '0')}`,
      authority: 'plan-decision',
      text: `Decision ${index}: ${'ruling '.repeat(100)}`,
    }));
    const brief = buildBoundedPriorAttemptBrief(compilePriorAttempts(sources), { maxChars: 5_000 })!;
    expect(brief.serializedChars).toBeLessThanOrEqual(5_000);
    expect(brief.protectedRefs.authority).toHaveLength(80);
    expect(brief.protectedRefs.authority.map((entry) => entry.rawRef)).toEqual(sources.map((entry) => entry.rawRef));
    expect(brief.omission.truncated).toBe(true);
  });
});

describe('buildBoundedPriorAttemptBrief omission drill-down (P-017)', () => {
  it('names every omitted record by raw ref, not only by authority tally', () => {
    // 40 ordinary records against a 5-record budget: 35 must be dropped.
    const sources = Array.from({ length: 40 }, (_, i) =>
      source({ rawRef: `WI-5#comment:${i}`, scope: 'same-spec', text: `Attempt ${i}.` }),
    );
    const brief = buildBoundedPriorAttemptBrief(compilePriorAttempts(sources), { maxRecords: 5 });
    expect(brief).not.toBeNull();
    expect(brief!.omission.omittedRecords).toBe(35);
    expect(brief!.omission.omittedByAuthority.comment).toBe(35);

    // The tally alone cannot say WHICH history was dropped. The refs can, and
    // they must be exactly the complement of what the brief admitted.
    const omittedRefs = brief!.omission.omittedRefs.map((entry) => entry.rawRef);
    expect(omittedRefs).toHaveLength(35);
    expect(brief!.omission.omittedRefsTruncated).toBe(false);
    expect(new Set(omittedRefs).size).toBe(35);
    for (const ref of omittedRefs) expect(brief!.rawRefs).not.toContain(ref);
    expect([...brief!.rawRefs, ...omittedRefs].sort()).toEqual(sources.map((s) => s.rawRef).sort());
  });

  it('carries enough identity on an omitted ref to route the drill-down', () => {
    const brief = buildBoundedPriorAttemptBrief(
      compilePriorAttempts([
        source({ rawRef: 'plan#SPEC-1@2', scope: 'same-spec', authority: 'current-spec', text: 'Current.' }),
        source({ rawRef: 'WI-7#comment:1', scope: 'same-plan-item', workItemId: 'WI-7', text: 'Dropped attempt.' }),
      ]),
      { maxRecords: 1 },
    );
    expect(brief!.omission.omittedRefs).toEqual([
      {
        authority: 'comment',
        scope: 'same-plan-item',
        rawRef: 'WI-7#comment:1',
        workItemId: 'WI-7',
        specId: undefined,
        at: '2026-08-20T12:00:00.000Z',
        // effort-scoped-continuity P-015/D-010: WHY it is not inline. `budget` says
        // "raise the budget to see this"; `empty-at-depth` says "there is nothing to
        // see at this resolution". A ref without the distinction sends a reader to
        // re-fetch a record that has nothing more to give.
        reason: 'budget',
      },
    ]);
  });

  it('marks a clipped body so a truncated retraction is not read as the whole record', () => {
    // The retraction lives PAST the cut — truncated, this record reads as
    // endorsement of the very approach its tail withdraws.
    const long = `Approach: reused the reader. ${'x'.repeat(900)} False premise: the reader never existed.`;
    const brief = buildBoundedPriorAttemptBrief(
      compilePriorAttempts([source({ rawRef: 'WI-8#checkpoint', authority: 'checkpoint', text: long })]),
      { maxTextChars: 120 },
    );
    const record = brief!.attempts[0]!;
    expect(record.textTruncated).toBe(true);
    expect(record.fullTextChars).toBe(long.length);
    expect(record.text).not.toContain('False premise');
    expect(record.rawRef).toBe('WI-8#checkpoint');
  });

  it('reports its own ref-list truncation rather than passing an exhausted list off as complete', () => {
    const sources = Array.from({ length: 260 }, (_, i) =>
      source({ rawRef: `WI-6#comment:${i}`, text: `Attempt ${i}.` }),
    );
    const brief = buildBoundedPriorAttemptBrief(compilePriorAttempts(sources), { maxRecords: 1 });
    expect(brief!.omission.omittedRecords).toBe(259);
    // Whatever the cap costs, a shortened list must SAY it is shortened —
    // an exhausted list read as complete is a false "that is all of it".
    expect(brief!.omission.omittedRefs.length).toBeLessThanOrEqual(200);
    expect(brief!.omission.omittedRefs.length).toBeLessThan(brief!.omission.omittedRecords);
    expect(brief!.omission.omittedRefsTruncated).toBe(true);
  });

  it('never spends a canonical authority row on the omitted-ref list', () => {
    // REGRESSION GUARD. Carrying the refs inside the size-enforcement envelope
    // let an 84-record history put 8.5KB of refs inside a 5KB budget; the
    // enforcement pass then stripped attempts, residue AND every protected
    // current-spec/decision/retraction row trying to fit, so the brief dropped
    // the facts it exists to guarantee in order to describe the ones it lost.
    const sources: PriorAttemptSource[] = [
      source({ rawRef: 'plan#SPEC-1@3', authority: 'current-spec', scope: 'same-spec', text: 'Current contract.' }),
      source({ rawRef: 'plan#D-008', authority: 'plan-decision', text: 'Canonical authority wins.' }),
      source({ rawRef: 'WI-2#comment:9', authority: 'retraction', scope: 'same-spec', text: 'False premise: the reader was absent.' }),
      ...Array.from({ length: 80 }, (_, i) =>
        source({ rawRef: `WI-${i + 10}#comment:1`, text: `Attempt ${i} ${'x'.repeat(300)}` }),
      ),
    ];
    const brief = buildBoundedPriorAttemptBrief(compilePriorAttempts(sources), { maxChars: 5_000 })!;
    expect(brief.authority.map((record) => record.rawRef)).toEqual([
      'plan#SPEC-1@3', 'plan#D-008', 'WI-2#comment:9',
    ]);
    expect(brief.serializedChars).toBeLessThanOrEqual(5_000);
    // Refs yielded instead — and said so.
    expect(brief.omission.omittedRefsTruncated).toBe(true);
  });

  it('counts a record rejected twice — budget then envelope overflow — as one omission', () => {
    const sources = Array.from({ length: 12 }, (_, i) =>
      source({ rawRef: `WI-4#comment:${i}`, text: `Attempt ${i}. ${'y'.repeat(600)}` }),
    );
    const brief = buildBoundedPriorAttemptBrief(compilePriorAttempts(sources), { maxChars: 2_000 });
    const refs = brief!.omission.omittedRefs.map((entry) => entry.rawRef);
    expect(new Set(refs).size).toBe(refs.length);
    // The AUTHORITY tally is the one that must equal the omission count; the
    // ref list may legitimately be shorter (it yields bytes first) but then
    // says so.
    expect(Object.values(brief!.omission.omittedByAuthority).reduce((a, b) => a + b, 0)).toBe(
      brief!.omission.omittedRecords,
    );
    if (refs.length < brief!.omission.omittedRecords) {
      expect(brief!.omission.omittedRefsTruncated).toBe(true);
    }
  });
});

describe('collectPriorAttempts', () => {
  it('projects existing spec/decision/evidence/checkpoint/thread/completion stores without minting authority', async () => {
    const item = {
      id: 'WI-9',
      family: 'issue',
      harness: 'papercusp',
      sourcePlanItemIds: ['P-009'],
      payload: {},
      terminalCompletionRef: 'npm run test:file -- lib/prior.test.ts passed',
      terminalCompletionEvidence: null,
      completionAuthority: 'verified',
      terminalOwner: 'agent-a',
      closedAt: '2026-08-20T12:00:00Z',
      updatedAt: '2026-08-20T12:00:00Z',
    } as unknown as WorkItem;
    const deps = {
      getPlan: async () => ({ content: '## Decisions\n\n### D-001 — Reuse the reader\nDate: 2026-08-20\nDo not add a ledger.' }),
      specs: async () => [{
        planSlug: 'plan', specId: 'SPEC-1', sourceValId: null, currentRevision: 2, revision: 2,
        planItemId: 'P-009', behavior: 'Compile prior attempts', behaviorClass: 'lifecycle',
        requiredEvidence: ['focused test'], requiredTestLayers: ['unit'], mutationRequired: false,
        lifecycleStatus: 'active', supersedes: null, exemption: null, contentHash: 'hash',
        createdBy: 'author', createdAt: '2026-08-20T09:00:00Z', acceptedBy: 'author',
        acceptedAt: '2026-08-20T09:00:00Z', acceptanceRef: null,
      }],
      edges: async () => [{ workItemId: 'WI-9', planSlug: 'plan', specId: 'SPEC-1', specRevision: 2, specFingerprint: 'hash' }],
      evidence: async () => [{ workItemId: 'WI-9' }],
      item: async () => item,
      items: async () => [item],
      thread: async () => ({
        posts: [{ id: 7, thread_id: 't', author_id: 'agent-a', body: 'False premise: no reader existed.', created_ts: '2026-08-20T11:00:00Z' }],
        total: 1, topics: [], createdAt: '2026-08-20T08:00:00Z',
      }),
      checkpoint: async () => ({ checkpoint: 'Approach: reused the reader.', updatedAtMs: Date.parse('2026-08-20T10:00:00Z') }),
      lifecycle: async () => ({ events: [], flags: { needsHuman: false, claimHold: false, heldOpenBy: null, heldOpenReason: null }, coverage: { auditRows: 0, reopenEntries: 0, notRecorded: [], degraded: false } }),
      priorWork: async () => null,
    };
    const result = await collectPriorAttempts({
      harnessSlug: 'papercusp', planSlug: 'plan', planItemId: 'P-009', workItemId: 'WI-9',
    }, deps as never);
    expect(result.records.map((record) => record.authority)).toEqual([
      'current-spec', 'plan-decision', 'retraction', 'verified-completion', 'checkpoint',
    ]);
    // effort-scoped-continuity P-018: WI-9 IS the requested ref, so its own records sit
    // at `self` — distance zero — rather than borrowing the `same-spec` label from the
    // spec edge it happens to share. This used to read `same-spec` because the ladder
    // was plan-anchored and had no word for "the item you are actually claiming"; that
    // absence is why the whole surface returned null for the 94% of items with no plan.
    expect(result.records.filter((record) => record.workItemId === 'WI-9').every((record) => record.scope === 'self')).toBe(true);
    // The SPEC record still carries `same-spec` — it is about the clause, not the item.
    expect(result.records.find((record) => record.authority === 'current-spec')?.scope).toBe('same-spec');
    expect(result.records.find((record) => record.authority === 'retraction')?.rawRef).toBe('WI-9#comment:7');
  });
});

describe('resolvePriorAttemptRefs (P-017 raw drill-down)', () => {
  const item = {
    id: 'WI-9',
    family: 'issue',
    harness: 'papercusp',
    sourcePlanItemIds: ['P-009'],
    payload: {},
    terminalCompletionRef: null,
    terminalCompletionEvidence: null,
    completionAuthority: null,
    terminalOwner: null,
    closedAt: null,
    updatedAt: '2026-08-20T12:00:00Z',
  } as unknown as WorkItem;
  // A checkpoint body long enough that any bounded brief must clip it — the
  // drill-down exists precisely for what the clip removes.
  const longCheckpoint = `Approach: reused the reader. ${'z'.repeat(1_200)} False premise: the reader never existed.`;
  const deps = {
    getPlan: async () => ({ content: '## Decisions\n\n### D-001 — Reuse the reader\nDate: 2026-08-20\nDo not add a ledger.' }),
    specs: async () => [],
    edges: async () => [],
    evidence: async () => [],
    item: async () => item,
    items: async () => [item],
    thread: async () => ({ posts: [], total: 0, topics: [], createdAt: '2026-08-20T08:00:00Z' }),
    checkpoint: async () => ({ checkpoint: longCheckpoint, updatedAtMs: Date.parse('2026-08-20T10:00:00Z') }),
    lifecycle: async () => ({ events: [], flags: { needsHuman: false, claimHold: false, heldOpenBy: null, heldOpenReason: null }, coverage: { auditRows: 0, reopenEntries: 0, notRecorded: [], degraded: false } }),
    priorWork: async () => null,
  };
  const pointer = { harness: 'papercusp', planSlug: 'plan', planItemId: 'P-009', workItemId: 'WI-9' };

  it('returns the FULL text a bounded brief had to clip', async () => {
    const brief = await getClaimTimePriorAttemptBrief({ ...pointer, budget: { maxTextChars: 100 } }, deps as never);
    // The collector promotes a checkpoint whose body withdraws a premise to
    // canonical `retraction` authority, so look across both tiers rather than
    // assuming which one holds it.
    const clipped = [...brief!.authority, ...brief!.attempts].find(
      (record) => record.rawRef === 'WI-9#checkpoint',
    )!;
    expect(clipped).toBeDefined();
    expect(clipped.textTruncated).toBe(true);
    expect(clipped.text).not.toContain('False premise');

    const resolved = await resolvePriorAttemptRefs({ ...pointer, rawRefs: [clipped.rawRef] }, deps as never);
    expect(resolved!.records).toHaveLength(1);
    // The withdrawal that the clip hid is recoverable from the ref alone.
    expect(resolved!.records[0]!.text).toContain('False premise: the reader never existed.');
    expect(resolved!.records[0]!.text.length).toBeGreaterThan(clipped.text.length);
  });

  it('reports refs that no longer compile instead of silently returning fewer records', async () => {
    const resolved = await resolvePriorAttemptRefs(
      { ...pointer, rawRefs: ['WI-9#checkpoint', 'WI-9#comment:404'] },
      deps as never,
    );
    expect(resolved!.records.map((record) => record.rawRef)).toEqual(['WI-9#checkpoint']);
    expect(resolved!.unresolved).toEqual(['WI-9#comment:404']);
  });

  it('recovers an exact older comment while rejecting other threads, unadmitted items and invalid ids', async () => {
    const archive = {
      id: 1, thread_id: 'issue-thread-WI-9', author_id: 'su-original',
      body: `Original archive: ${'preserved λ '.repeat(400)}`.trimEnd(), created_ts: '2026-08-20T08:00:00Z',
    };
    const posts = Array.from({ length: 14 }, (_, index) => ({
      ...archive, id: index + 2, body: `Later post ${index + 2}`,
    }));
    const thread = vi.fn(async (_id: string, limit: number) => ({
      posts: posts.slice(-limit), total: 15, topics: [], createdAt: archive.created_ts,
    }));
    const threadPost = vi.fn(async ({ postId }: { workspaceId: string; postId: number }) =>
      postId === 1 ? archive : postId === 404 ? { ...archive, id: 404, thread_id: 'another-thread' } : null,
    );
    const refs = ['WI-9#comment:1', 'WI-9#comment:1', 'WI-9#comment:404',
      'WI-other#comment:1', 'WI-9#comment:1junk', 'WI-9#comment:9007199254740992'];
    const resolved = await resolvePriorAttemptRefs(
      { ...pointer, rawRefs: refs }, { ...deps, thread, threadPost } as never,
    );
    expect(thread).toHaveBeenCalledWith('WI-9', 12, 'papercusp');
    expect(resolved?.records).toHaveLength(1);
    expect(resolved?.records[0]).toMatchObject({
      rawRef: 'WI-9#comment:1', text: archive.body, actor: archive.author_id, at: archive.created_ts,
    });
    expect(resolved?.unresolved).toEqual(refs.slice(2));
    expect(threadPost.mock.calls.map(([input]) => input.postId)).toEqual([1, 404]);
    expect(threadPost.mock.calls.every(([input]) => Boolean(input.workspaceId))).toBe(true);
  });

  it('returns unknown when an exact comment read fails instead of declaring the saved source missing', async () => {
    const post = { id: 2, thread_id: 'issue-thread-WI-9', author_id: 'su-original',
      body: 'Later post', created_ts: '2026-08-20T08:00:00Z' };
    const resolved = await resolvePriorAttemptRefs({ ...pointer, rawRefs: ['WI-9#comment:1'] }, {
      ...deps,
      thread: async () => ({ posts: [post], total: 14, topics: [], createdAt: post.created_ts }),
      threadPost: async () => { throw new Error('exact post store unavailable'); },
    } as never);
    expect(resolved).toBeNull();
  });

  it('stamps the fingerprint it resolved against so a caller can detect history moving under it', async () => {
    const brief = await getClaimTimePriorAttemptBrief(pointer, deps as never);
    const resolved = await resolvePriorAttemptRefs({ ...pointer, rawRefs: ['WI-9#checkpoint'] }, deps as never);
    expect(resolved!.fingerprint).toBe(brief!.fingerprint);
    expect(resolved!.schemaVersion).toBe('prior-attempt-refs-v1');
  });

  it('asks for nothing when given no refs, and fails soft on a pathological read', async () => {
    expect(await resolvePriorAttemptRefs({ ...pointer, rawRefs: [] }, deps as never)).toBeNull();
    expect(await resolvePriorAttemptRefs({ ...pointer, rawRefs: ['  '] }, deps as never)).toBeNull();

    const never = () => new Promise<never>(() => {});
    const started = performance.now();
    const result = await resolvePriorAttemptRefs(
      { ...pointer, rawRefs: ['WI-9#checkpoint'], timeoutMs: 25 },
      {
        getPlan: never, specs: never, edges: never, evidence: never, item: never,
        items: never, thread: never, checkpoint: never, lifecycle: never, priorWork: never,
      } as never,
    );
    expect(result).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });

  // WI-2142613 RETIRED THE PIN THAT USED TO SIT HERE, deliberately rather than by
  // tripping over it. It read `it('returns null without a plan pointer rather than
  // guessing a scope')` and asserted this exact call returned null. Its title states
  // an intent that P-018 has since answered: the requested ref IS the anchor, so there
  // is no scope left to guess. Keeping it pinned the drill-down dead for the 94% of
  // open items carrying no plan — the same population whose BRIEF P-018 had just
  // fixed — so those items received a bounded brief advertising omitted refs that
  // could never be resolved. The two tests below split what that one conflated:
  // "carries no plan" (must now RESOLVE) from "has no anchor at all" (still null).
  it('resolves an ORPHAN ref from its own self rung, where the plan-pointer gate used to return null', async () => {
    const resolved = await resolvePriorAttemptRefs(
      { workItemId: 'WI-9', rawRefs: ['WI-9#checkpoint'] },
      deps as never,
    );
    expect(resolved).not.toBeNull();
    // CONTENT, not merely a non-null envelope: the whole point of the drill-down is
    // that a brief which clipped this checkpoint can get the withdrawn premise back.
    // Asserting only non-null would pass on an empty record set, which is the same
    // dead end wearing a different shape.
    expect(resolved!.records.map((record) => record.rawRef)).toEqual(['WI-9#checkpoint']);
    expect(resolved!.unresolved).toEqual([]);
    expect(resolved!.records[0]!.text).toContain('False premise: the reader never existed.');
  });

  it('still returns null when there is NO anchor at all — neither a work-item id nor a plan pointer', async () => {
    // The narrow guard that legitimately survives the removal. This function needs
    // SOME ref to resolve against; that is a different condition from "carries no
    // plan", which is what the removed gate actually tested.
    expect(await resolvePriorAttemptRefs({ rawRefs: ['WI-9#checkpoint'] }, deps as never)).toBeNull();
  });
});

describe('getClaimTimePriorAttemptBrief', () => {
  it('bounds a pathological history read and fails soft without changing the claim verdict', async () => {
    const never = () => new Promise<never>(() => {});
    const started = performance.now();
    const result = await getClaimTimePriorAttemptBrief({
      planSlug: 'plan', planItemId: 'P-009', workItemId: 'WI-9', timeoutMs: 25,
    }, {
      getPlan: never,
      specs: never,
      edges: never,
      evidence: never,
      item: never,
      items: never,
      thread: never,
      checkpoint: never,
      lifecycle: never,
      priorWork: never,
    } as never);
    expect(result).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });
});
