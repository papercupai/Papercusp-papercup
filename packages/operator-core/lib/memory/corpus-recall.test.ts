/**
 * Pure-core tests for the P-008 second retrieval leg (D-037).
 *
 * Everything here is deterministic: no PG, no embedder, no clock. The live
 * leg's own degradation paths are covered in corpus-recall-io.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  CORPUS_BLOCK_HEADING,
  CORPUS_MAX_ITEMS,
  CORPUS_QUERY_MAX_TERMS,
  corpusQueryText,
  corpusTerms,
  handleRefOfHit,
  relativeAgeLabel,
  renderCorpusBlock,
  selectCorpusLines,
  sessionIdOfHit,
  type CorpusHit,
} from './corpus-recall';

const turn = (over: Partial<CorpusHit> = {}): CorpusHit => ({
  source: 'session_turn',
  sourceId: 'claude:sess-a:12',
  excerpt: 'the endpoint_ipc docstring records the http2 transport decision',
  score: 0.03,
  ts: '2026-07-31T10:00:00.000Z',
  rankers: ['bm25'],
  ...over,
});

const wi = (over: Partial<CorpusHit> = {}): CorpusHit => ({
  source: 'work_item',
  sourceId: 'WI-6512',
  scope: 'harness:papercusp',
  excerpt: '[bug/open/major] http2 transport regression on the sse endpoint',
  score: 0.03,
  ts: null,
  rankers: ['bm25'],
  ...over,
});

const QUERY = 'why did the http2 transport change on the sse endpoint';

describe('complete knowledge context', () => {
  it('retains the known Report when broad plan matches would consume its budget', () => {
    const report: CorpusHit = { source: 'report',sourceId: 'warm-report',scope: 'papercusp',
      excerpt: 'warmquartz diagnostic snapshot recovery evidence. Retain the snapshot.',
      score: .04,rankers: ['lexical'] };
    const broadPlans: CorpusHit[] = ['amber','cobalt','jade','zephyr'].map(token => ({
      source: 'plan',sourceId: `papercusp:${token}`,scope: 'harness:papercusp',
      excerpt: 'Ordinary background. '.repeat(20) + `${token} diagnostic snapshot recovery evidence.`,
      score: .02,rankers: ['lexical'],
    }));
    const result = selectCorpusLines({ hits: [report,...broadPlans],
      queryText: 'warmquartz diagnostic',harnessSlugs: ['papercusp'] });
    expect(result.lines[0].handle.ref).toBe('report:warm-report');
    expect(result.lines.some(line => line.line.includes('Retain the snapshot'))).toBe(true);
    expect(result.dropped.some(drop => drop.reason === 'budget-exhausted')).toBe(true);
  });

  it('retains prerequisite context and resolves all three source kinds', () => {
    const hits: CorpusHit[] = [
      { source: 'plan',sourceId: 'papercusp:repair',scope: 'harness:papercusp',excerpt: 'http2 transport repair',score: .03 },
      { source: 'doc',sourceId: 'harness:papercusp:repair',scope: 'harness:papercusp',
        excerpt: 'Prerequisite: retain the snapshot. Apply the http2 transport recovery.',
        highlight: 'http2 transport',score: .03,meta: { section: 'Recovery' } },
      { source: 'report',sourceId: 'R1',scope: 'papercusp',excerpt: 'http2 transport incident evidence',score: .03 },
    ];
    const selected = selectCorpusLines({ hits,queryText: QUERY,harnessSlugs: ['papercusp'],budgetChars: 2000 });
    expect(selected.lines).toHaveLength(3);
    expect(selected.lines.map(l=>l.handle.kind).sort()).toEqual(['doc','plan','report']);
    const block = renderCorpusBlock(selected.lines)!;
    expect(block).toContain('retain the snapshot');
    expect(block).toContain('plans:get');
    expect(block).toContain('docs:get');
    expect(selected.lines.find(l=>l.handle.kind === 'doc')?.handle.resolve)
      .toBe('docs:get {"slugs":["repair"],"harness":"papercusp"}');
    expect(block).toContain('reports:get');
    expect(block).toContain('dated evidence');
    expect(selectCorpusLines({ hits,queryText: QUERY,ambientExcludedRefs: new Set(['report:R1']) }).lines
      .some(l=>l.handle.ref === 'report:R1')).toBe(false);
  });

  it('selects maintained guidance ahead of conflicting dated evidence within a single slot', () => {
    const report: CorpusHit = { source: 'report',sourceId: 'R1',excerpt: 'http2 transport: discard the snapshot',
      score: .04,rankers: ['lexical','embeddings'] };
    const doc: CorpusHit = { source: 'doc',sourceId: 'papercusp-engineering:repair',scope: 'operator',
      excerpt: 'http2 transport: retain the snapshot',score: .01,rankers: ['lexical'] };
    const result = selectCorpusLines({ hits: [report,doc],queryText: QUERY,maxItems: 1 });
    expect(result.lines[0].handle.kind).toBe('doc');
    expect(result.lines[0].line).toContain('retain the snapshot');
    expect(result.lines[0].handle.resolve).toBe('docs:get {"slugs":["repair"],"harness":"engineering"}');
  });
});

describe('corpusTerms', () => {
  it('drops stopwords and short tokens but keeps id-shaped ones', () => {
    const terms = corpusTerms('Why does WI-6512 block P-008 and the D-037 decision?');
    expect(terms).toContain('wi-6512');
    expect(terms).toContain('p-008');
    expect(terms).toContain('d-037');
    expect(terms).toContain('block');
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('and');
    // 'why' / 'does' are short/stopwords — neither is a useful match term.
    expect(terms).not.toContain('why');
  });

  it('is order-preserving and de-duplicated', () => {
    expect(corpusTerms('alpha beta alpha gamma')).toEqual(['alpha', 'beta', 'gamma']);
  });
});

describe('corpusQueryText — the AND-satisfiability fix', () => {
  it('collapses a long prompt envelope to two distinctive terms', () => {
    // plainto_tsquery ANDs every lexeme, so the raw 1000-char turn-start
    // envelope would produce an AND of ~150 terms and match nothing, ever.
    const q = corpusQueryText(QUERY);
    expect(q.split(' ')).toHaveLength(2);
    expect(q).toContain('transport');
  });

  it('uses an id-shaped token ALONE — the near-unique retrieval key', () => {
    expect(corpusQueryText('please look at WI-6512 about the sse transport regression')).toBe(
      'wi-6512',
    );
    expect(corpusQueryText('does D-037 govern the injection budget question')).toBe('d-037');
  });

  it('does NOT short-circuit on a bare digit run — WI-7237', () => {
    // Measured 2026-08-03 replaying real agent batches: a bare 3+ digit
    // number is overwhelmingly incidental (a port, a byte count, a limit),
    // never a resolvable id on its own. Letting it short-circuit the way an
    // ID-PREFIXED token does threw away all the prose in the batch.
    const portBatch =
      'curl a health check against 127.0.0.1 on the operator port to confirm the service replies';
    const q1 = corpusQueryText(portBatch);
    expect(q1).not.toBe('127');
    expect(q1.split(' ')).toHaveLength(2);

    const byteCountBatch =
      'truncate the excerpt with left(text,1500) before writing the teaser to the corpus block';
    const q2 = corpusQueryText(byteCountBatch);
    expect(q2).not.toBe('1500');
    expect(q2.split(' ')).toHaveLength(2);
  });

  it('still lets a bare digit run WIN when nothing longer is available', () => {
    // corpusTerms keeps a bare number as a valid short candidate term (it may
    // legitimately help the overlap guard); this only asserts it can no
    // longer unilaterally decide the query the way an id-prefixed token does.
    expect(corpusQueryText('the port is 8788 and')).toContain('8788');
  });

  it('never returns more terms than asked, however long the input', () => {
    const envelope = `${'boilerplate envelope preamble '.repeat(40)} ${QUERY}`;
    expect(corpusQueryText(envelope).split(' ').length).toBeLessThanOrEqual(
      CORPUS_QUERY_MAX_TERMS,
    );
  });

  it('returns empty for text with nothing searchable', () => {
    expect(corpusQueryText('   ')).toBe('');
    expect(corpusQueryText('a of to the and')).toBe('');
  });

  it('is deterministic for the same input', () => {
    expect(corpusQueryText(QUERY)).toBe(corpusQueryText(QUERY));
  });
});

describe('corpusQueryText — BANDED term selection (P-018 / D-064)', () => {
  /** A DF oracle over raw `corpusTerms` tokens. Absent ⇒ df 0 ⇒ unattested. */
  const dfOf = (table: Record<string, number>) => (t: string) => table[t] ?? 0;

  it('prefers the RAREST attested term over the longest one', () => {
    // `aftercompaction` is envelope boilerplate the corpus is saturated with;
    // `updatechip` is the term that actually discriminates. Length picks the
    // boilerplate because it is four characters longer.
    const text = 'the aftercompaction envelope mentions updatechip in passing';
    const df = dfOf({ aftercompaction: 598, envelope: 300, mentions: 400, updatechip: 15 });

    expect(corpusQueryText(text, 2)).toContain('aftercompaction');
    expect(corpusQueryText(text, 2, { df })).not.toContain('aftercompaction');
    expect(corpusQueryText(text, 2, { df }).split(' ')[0]).toBe('updatechip');
  });

  it('REFUSES a df<minDf term even though it is the rarest — the D-064 falsifier', () => {
    // The guard that would have caught P-018 as originally prescribed. Pure
    // rarity ranks the hex digest first (df 0 ⇒ maximal idf), and a term the
    // corpus does not attest cannot retrieve: under AND it empties the result
    // set. Measured across 400 real turns, naive rarity spent 53.3% of its
    // slots on exactly these tokens. If this test ever passes with the digest
    // selected, the band has been removed and the leg is querying on noise.
    const text = 'the 20c4f13019f25684 digest appeared while draining the backlog queue';
    const df = dfOf({
      '20c4f13019f25684': 0, // a hapax hex digest — rarest, and unretrievable
      digest: 40,
      appeared: 220,
      draining: 12,
      backlog: 142,
      queue: 180,
    });

    const q = corpusQueryText(text, 2, { df });
    expect(q).not.toContain('20c4f13019f25684');
    // …and it still picks the rarest of what IS attested.
    expect(q.split(' ')).toEqual(['draining', 'digest']);

    // SELF-PROVING: the same fixture, band removed, really does select the
    // unretrievable digest first. Without this line the assertions above would
    // still pass if banding were deleted and some other mechanism happened to
    // exclude the digest — a guard that cannot be shown to fail is vacuous.
    expect(corpusQueryText(text, 2, { df, minDf: 0 }).split(' ')[0]).toBe('20c4f13019f25684');
  });

  it('falls back to LENGTH when every candidate is unattested — never worse than production', () => {
    // A turn made entirely of session ids and nonces. There is nothing worth
    // querying on, so the honest move is production's existing behaviour, not
    // an empty query and not a query on noise.
    const text = 'bl6bwnz5r and 013to2uezjqpwd3wmdxkf4re appeared together';
    const df = dfOf({}); // nothing attested at all

    expect(corpusQueryText(text, 2, { df })).toBe(corpusQueryText(text, 2));
    expect(corpusQueryText(text, 2, { df })).not.toBe('');
  });

  it('leaves the id short-circuit untouched — DF never overrides a record handle', () => {
    // 66.3% of real queries take this path (D-064 R2), so a regression here
    // would dwarf anything selection buys on the other third.
    const df = dfOf({ 'wi-6512': 0, transport: 900, regression: 800 });
    expect(corpusQueryText('look at WI-6512 about the transport regression', 2, { df })).toBe(
      'wi-6512',
    );
  });

  it('is a no-op when no df is supplied — the un-wired caller is unchanged', () => {
    expect(corpusQueryText(QUERY, 2, {})).toBe(corpusQueryText(QUERY, 2));
  });

  it('respects maxTerms and stays deterministic under banding', () => {
    const text = 'draining the backlog queue after the digest appeared in the envelope';
    const df = dfOf({ draining: 12, backlog: 142, queue: 180, digest: 40, envelope: 300 });
    expect(corpusQueryText(text, 3, { df }).split(' ')).toHaveLength(3);
    expect(corpusQueryText(text, 2, { df })).toBe(corpusQueryText(text, 2, { df }));
  });
});

describe('handle derivation', () => {
  it('collapses a turn to its SESSION, not its turn index', () => {
    expect(handleRefOfHit(turn({ sourceId: 'claude:sess-a:12' }))).toBe('claude:sess-a');
    expect(handleRefOfHit(turn({ sourceId: 'claude:sess-a:99' }))).toBe('claude:sess-a');
  });

  it('tolerates a session id that itself contains colons', () => {
    const h = turn({ sourceId: 'omp:host:abc:7' });
    expect(sessionIdOfHit(h)).toBe('host:abc');
    expect(handleRefOfHit(h)).toBe('omp:host:abc');
  });

  it('uses the issue id for a work-item', () => {
    expect(handleRefOfHit(wi())).toBe('WI-6512');
    expect(sessionIdOfHit(wi())).toBeNull();
  });
});

describe('selectCorpusLines', () => {
  it('renders the bounded matched excerpt as self-contained evidence without a resolve CTA', () => {
    const { lines } = selectCorpusLines({ hits: [wi()], queryText: QUERY });
    expect(lines).toHaveLength(1);
    expect(lines[0].line).toContain('work-item WI-6512');
    expect(lines[0].handle.resolve).toBe("work_items:get { id: 'WI-6512' }");
    expect(lines[0].line).toContain('http2 transport regression');
    expect(lines[0].line).not.toContain("work_items:get { id: 'WI-6512' }");
  });

  it('uses relative age and marks a pointer from a different work-item', () => {
    const now = Date.parse('2026-08-12T12:00:00.000Z');
    expect(relativeAgeLabel('2026-08-12T11:48:00.000Z', now)).toBe('12m ago');
    expect(relativeAgeLabel('2026-08-12T00:00:00.000Z', now)).toBe('12h ago');

    const { lines } = selectCorpusLines({
      hits: [wi({ sourceId: 'WI-38041', ts: '2026-08-12T00:00:00.000Z' })],
      queryText: QUERY,
      declaredWorkItemId: 'WI-38148',
      now,
    });
    expect(lines[0]!.line).toContain('different work-item from current WI-38148');
    expect(lines[0]!.line).toContain('12h ago');
    expect(lines[0]!.line).not.toContain('2026-08-12');
  });

  it('does not mark a pointer whose subject matches the declared work-item', () => {
    const { lines } = selectCorpusLines({
      hits: [wi({ sourceId: 'wi-6512', ts: '2026-08-12T11:59:30.000Z' })],
      queryText: QUERY,
      declaredWorkItemId: 'WI-6512',
      now: Date.parse('2026-08-12T12:00:00.000Z'),
    });
    expect(lines[0]!.line).not.toContain('different work-item');
    expect(lines[0]!.line).toContain('just now');
  });

  it('renders a session handle as a sessions:search call carrying the matched terms', () => {
    const { lines } = selectCorpusLines({ hits: [turn()], queryText: QUERY });
    expect(lines[0].handle.kind).toBe('session');
    expect(lines[0].handle.ref).toBe('claude:sess-a');
    expect(lines[0].handle.resolve).toMatch(/^sessions:search \{ session: 'sess-a', query: '/);
    // The re-pull query is the SHARED terms, so it reproduces the match.
    expect(lines[0].handle.query).toContain('transport');
  });

  it('drops this session’s own turns as echo', () => {
    const { lines, dropped } = selectCorpusLines({
      hits: [turn({ sourceId: 'claude:sess-self:3' }), wi()],
      queryText: QUERY,
      excludeSessionIds: new Set(['sess-self']),
    });
    expect(lines.map((l) => l.handle.ref)).toEqual(['WI-6512']);
    expect(dropped).toContainEqual({ ref: 'claude:sess-self', reason: 'self-session' });
  });

  it('drops EVERY session in the caller’s owner chain, not just the live one', () => {
    // EI-19460887729945170: an agent's identity outlives one native session, so
    // after a compaction its EARLIER turns stop being "self" and — being the
    // densest documents in the corpus for whatever it is working on — evict the
    // durable answer. Measured live: excluding only the newest session freed a
    // slot that went to ANOTHER of the caller's sessions while WI-6512 stayed
    // dropped `cap-exhausted`.
    const { lines, dropped } = selectCorpusLines({
      hits: [
        turn({ sourceId: 'claude:sess-live:3' }),
        turn({ sourceId: 'claude:sess-prior:9' }),
        wi(),
      ],
      queryText: QUERY,
      excludeSessionIds: new Set(['sess-live', 'sess-prior']),
    });
    expect(lines.map((l) => l.handle.ref)).toEqual(['WI-6512']);
    expect(dropped).toContainEqual({ ref: 'claude:sess-live', reason: 'self-session' });
    expect(dropped).toContainEqual({ ref: 'claude:sess-prior', reason: 'self-session' });
  });

  it('CONTROL: an EMPTY exclusion set admits the very turns the owner-wide set drops', () => {
    // Calibration for the two tests above, and a portrait of the shipped bug:
    // `excludeSessionId` held an ownerId, which can never equal a native
    // transcript uuid, so the effective exclusion set was ALWAYS empty and the
    // caller's own turns were admitted every time. Same hits, same query — only
    // the set differs. If this ever passes together with the drop tests, the
    // drop is not the thing doing the work.
    const hits = [
      turn({ sourceId: 'claude:sess-live:3' }),
      turn({ sourceId: 'claude:sess-prior:9' }),
      wi(),
    ];
    const { lines, dropped } = selectCorpusLines({
      hits,
      queryText: QUERY,
      excludeSessionIds: new Set<string>(),
    });
    // Order is WI-6512-first (not fused-input order) because of the WI-9592 kind
    // tiebreak below — all three tie on agreement (one 'bm25' ranker each), and a
    // work-item now outranks a session at equal agreement. What this CONTROL
    // actually calibrates — that an empty exclusion set admits every hit and
    // drops none as self-session — is unaffected by which order they admit in.
    expect(lines.map((l) => l.handle.ref)).toEqual([
      'WI-6512',
      'claude:sess-live',
      'claude:sess-prior',
    ]);
    expect(dropped.filter((d) => d.reason === 'self-session')).toEqual([]);
  });

  it('keeps a PEER’s turns — the filter is the caller’s own chain, not all turns', () => {
    const { lines } = selectCorpusLines({
      hits: [turn({ sourceId: 'claude:sess-peer:3' })],
      queryText: QUERY,
      excludeSessionIds: new Set(['sess-live', 'sess-prior']),
    });
    expect(lines.map((l) => l.handle.ref)).toEqual(['claude:sess-peer']);
  });

  it('drops a strongly matching ambient holdout before ranking/cap while retaining the control', () => {
    // The holdout is first and otherwise identical to the control, so this fails
    // if the fence is absent: the cap would admit WI-40293 and hide the control.
    const holdout = wi({ sourceId: 'WI-40293' });
    const control = wi({ sourceId: 'WI-71001' });
    const { lines, dropped } = selectCorpusLines({
      hits: [holdout, control],
      queryText: QUERY,
      ambientExcludedRefs: new Set(['WI-40293']),
      maxItems: 1,
    });
    expect(lines.map((l) => l.handle.ref)).toEqual(['WI-71001']);
    expect(dropped).toContainEqual({ ref: 'WI-40293', reason: 'ambient-excluded' });
  });

  it('narrows WORK-ITEMS by harness but never narrows turns', () => {
    const { lines, dropped } = selectCorpusLines({
      hits: [wi({ sourceId: 'WI-999', scope: 'harness:other' }), turn()],
      queryText: QUERY,
      harnessSlugs: ['papercusp'],
    });
    expect(dropped).toContainEqual({ ref: 'WI-999', reason: 'out-of-scope' });
    // The turn survives despite carrying no harness scope at all — 99.993% of
    // real turns are like this, so narrowing them would empty the leg.
    expect(lines.map((l) => l.handle.ref)).toEqual(['claude:sess-a']);
  });

  it('keeps operator-scoped work-items regardless of the harness in scope', () => {
    const { lines } = selectCorpusLines({
      hits: [wi({ sourceId: 'WI-777', scope: 'operator' })],
      queryText: QUERY,
      harnessSlugs: ['papercusp'],
    });
    expect(lines.map((l) => l.handle.ref)).toEqual(['WI-777']);
  });

  it('drops a hit that shares no term with the query', () => {
    const { lines, dropped } = selectCorpusLines({
      hits: [wi({ sourceId: 'WI-111', excerpt: 'unrelated kettle brewing schedule' })],
      queryText: QUERY,
    });
    expect(lines).toHaveLength(0);
    expect(dropped).toContainEqual({ ref: 'WI-111', reason: 'no-term-overlap' });
  });

  it('emits ONE line per session even when several of its turns rank', () => {
    const { lines, dropped } = selectCorpusLines({
      hits: [
        turn({ sourceId: 'claude:sess-a:1' }),
        turn({ sourceId: 'claude:sess-a:2' }),
        turn({ sourceId: 'claude:sess-a:3' }),
      ],
      queryText: QUERY,
    });
    expect(lines).toHaveLength(1);
    expect(dropped.filter((d) => d.reason === 'duplicate-ref')).toHaveLength(2);
  });

  it('drops refs the agent already carries', () => {
    const { lines, dropped } = selectCorpusLines({
      hits: [wi(), turn()],
      queryText: QUERY,
      knownRefs: new Set(['WI-6512']),
    });
    expect(lines.map((l) => l.handle.ref)).toEqual(['claude:sess-a']);
    expect(dropped).toContainEqual({ ref: 'WI-6512', reason: 'not-novel' });
  });

  it('enforces the item cap independently of the mem0 ceiling', () => {
    const hits = Array.from({ length: CORPUS_MAX_ITEMS + 2 }, (_, i) =>
      wi({ sourceId: `WI-${100 + i}` }),
    );
    const { lines, dropped } = selectCorpusLines({ hits, queryText: QUERY });
    expect(lines).toHaveLength(CORPUS_MAX_ITEMS);
    expect(dropped.filter((d) => d.reason === 'cap-exhausted')).toHaveLength(2);
  });

  it('enforces its own char budget, admitting exactly what fits in rank order', () => {
    const hits = [wi({ sourceId: 'WI-101' }), wi({ sourceId: 'WI-102' })];
    // Both hits render to (near-)identical line lengths (same shape, different ref) —
    // derive the real one-line length rather than hardcoding it, so this doesn't drift
    // if the render format changes.
    const { lines: oneHitLines } = selectCorpusLines({ hits: [hits[0]], queryText: QUERY });
    const oneLineLen = oneHitLines[0]!.line.length;
    const { lines, dropped } = selectCorpusLines({
      hits,
      queryText: QUERY,
      budgetChars: oneLineLen + 5, // room for exactly one line, not two
    });
    expect(lines).toHaveLength(1);
    expect(dropped).toContainEqual({ ref: 'WI-102', reason: 'budget-exhausted' });
  });

  // WI-6870: the admission loop used to let the FIRST entry through no matter its
  // size ("lines.length > 0" exemption) — measured live as one 4,901-char memory
  // blowing an entire 4,000-char budget by itself, starving every other candidate.
  // That exemption is gone: a budget too small for even one line now admits NOTHING,
  // rather than force-admitting an oversized first entry.
  it('admits nothing, and drops every hit as budget-exhausted, when even one line cannot fit (WI-6870 — no first-entry exemption)', () => {
    const hits = [wi({ sourceId: 'WI-101' }), wi({ sourceId: 'WI-102' })];
    const { lines, dropped } = selectCorpusLines({ hits, queryText: QUERY, budgetChars: 10 });
    expect(lines).toHaveLength(0);
    expect(dropped).toEqual([
      { ref: 'WI-101', reason: 'budget-exhausted' },
      { ref: 'WI-102', reason: 'budget-exhausted' },
    ]);
  });

  it('prefers a hit BOTH rankers found — the one scale-free quality signal', () => {
    const { lines } = selectCorpusLines({
      hits: [
        wi({ sourceId: 'WI-201', rankers: ['bm25'] }),
        wi({ sourceId: 'WI-202', rankers: ['bm25', 'embeddings'] }),
      ],
      queryText: QUERY,
      maxItems: 2,
    });
    expect(lines.map((l) => l.handle.ref)).toEqual(['WI-202', 'WI-201']);
  });

  // WI-9592 direction 2 (built now that WI-9273 — the reach redesign D-069
  // deferred to — is done): at EQUAL retrieval agreement, a work-item outranks
  // a session, so peer restatements crowding the fused order ahead of it (the
  // turn-63 shape D-069 measured live) don't shut it out of the cap.
  it('prefers a work-item over a session at equal agreement, even when it was fused BEHIND them', () => {
    const { lines } = selectCorpusLines({
      hits: [
        turn({ sourceId: 'claude:sess-a:1' }),
        turn({ sourceId: 'claude:sess-b:1' }),
        turn({ sourceId: 'claude:sess-c:1' }),
        wi({ sourceId: 'WI-6512' }),
      ],
      queryText: QUERY,
      maxItems: 3,
    });
    expect(lines.map((l) => l.handle.ref)).toEqual([
      'WI-6512',
      'claude:sess-a',
      'claude:sess-b',
    ]);
  });

  it('still breaks a same-kind tie by fused rank, kind tiebreak aside', () => {
    const { lines } = selectCorpusLines({
      hits: [wi({ sourceId: 'WI-301' }), wi({ sourceId: 'WI-302' })],
      queryText: QUERY,
      maxItems: 1,
    });
    expect(lines.map((l) => l.handle.ref)).toEqual(['WI-301']);
  });

  // P-009. `applyRecencyRerank` appends 'recency' to the rankers of every hit that
  // HAD A USABLE TIMESTAMP, and this sort keys on ranker COUNT as an agreement
  // proxy — so without filtering, "carries a date" is indistinguishable from "two
  // independent rankers agreed". Each of these fails against the unfiltered count.
  it('does NOT count the recency label as multi-ranker agreement', () => {
    const { lines } = selectCorpusLines({
      hits: [
        // Single-leg, but dated — 2 labels, 1 retrieval ranker.
        wi({ sourceId: 'WI-401', rankers: ['bm25', 'recency'], ts: '2026-08-09T00:00:00.000Z' }),
        // Genuinely found by both legs — 2 labels, 2 retrieval rankers.
        wi({ sourceId: 'WI-402', rankers: ['bm25', 'embeddings'] }),
      ],
      queryText: QUERY,
      maxItems: 2,
    });
    expect(lines.map((l) => l.handle.ref)).toEqual(['WI-402', 'WI-401']);
  });

  // FALSIFIABILITY CONTROL for the two guards above. A guard that has never failed
  // is untested, but mutating the real module to prove it would race git-sync's
  // whole-tree sweep (a probe legitimately holds the mutation for the length of the
  // run, and a sweep landing in that window COMMITS it). So the wrong
  // implementation lives here permanently instead: the naive ranker COUNT the
  // guards replaced, asserted to produce the WRONG order on the same input.
  it('control: the naive ranker COUNT gets those orderings wrong', () => {
    const naiveOrder = (hits: readonly CorpusHit[]) =>
      [...hits]
        .sort((a, b) => (b.rankers?.length ?? 1) - (a.rankers?.length ?? 1))
        .map((h) => h.sourceId);

    // Dated single-leg vs. genuinely-agreed: both count 2, so the tie falls to
    // input order and the dated hit wrongly leads.
    expect(
      naiveOrder([
        wi({ sourceId: 'WI-401', rankers: ['bm25', 'recency'] }),
        wi({ sourceId: 'WI-402', rankers: ['bm25', 'embeddings'] }),
      ]),
    ).toEqual(['WI-401', 'WI-402']);

    // Same for BM25-run-twice.
    expect(
      naiveOrder([
        wi({ sourceId: 'WI-411', rankers: ['lexical', 'lexical-fresh'] }),
        wi({ sourceId: 'WI-412', rankers: ['lexical', 'embeddings'] }),
      ]),
    ).toEqual(['WI-411', 'WI-412']);
  });

  it('does NOT count lexical-fresh as a second ranker — it is BM25 run twice', () => {
    const { lines } = selectCorpusLines({
      hits: [
        wi({ sourceId: 'WI-411', rankers: ['lexical', 'lexical-fresh'] }),
        wi({ sourceId: 'WI-412', rankers: ['lexical', 'embeddings'] }),
      ],
      queryText: QUERY,
      maxItems: 2,
    });
    expect(lines.map((l) => l.handle.ref)).toEqual(['WI-412', 'WI-411']);
  });

  it('keeps the engine’s recency-blended order WITHIN one agreement tier', () => {
    // Both single-leg + dated: agreement ties, so the engine's order (which the
    // recency re-rank has already applied) must survive untouched.
    const { lines } = selectCorpusLines({
      hits: [
        wi({ sourceId: 'WI-421', rankers: ['bm25', 'recency'], ts: '2026-08-09T00:00:00.000Z' }),
        wi({ sourceId: 'WI-422', rankers: ['bm25', 'recency'], ts: '2026-06-20T00:00:00.000Z' }),
      ],
      queryText: QUERY,
      maxItems: 2,
    });
    expect(lines.map((l) => l.handle.ref)).toEqual(['WI-421', 'WI-422']);
  });

  it('floors a hit whose only label is non-retrieval at one ranker, not zero', () => {
    // Must TIE with a plain single-leg hit (so input order decides), never sort
    // below it — a hit still had to be retrieved by something to be here at all.
    const { lines } = selectCorpusLines({
      hits: [
        wi({ sourceId: 'WI-431', rankers: ['recency'], ts: '2026-08-09T00:00:00.000Z' }),
        wi({ sourceId: 'WI-432', rankers: ['bm25'] }),
      ],
      queryText: QUERY,
      maxItems: 2,
    });
    expect(lines.map((l) => l.handle.ref)).toEqual(['WI-431', 'WI-432']);
  });

  it('otherwise preserves the engine’s fused order', () => {
    const { lines } = selectCorpusLines({
      hits: [wi({ sourceId: 'WI-301' }), wi({ sourceId: 'WI-302' })],
      queryText: QUERY,
      maxItems: 2,
    });
    expect(lines.map((l) => l.handle.ref)).toEqual(['WI-301', 'WI-302']);
  });

  it('bounds the teaser so it can never become a content payload', () => {
    const { lines } = selectCorpusLines({
      hits: [wi({ excerpt: `http2 ${'x'.repeat(5000)}` })],
      queryText: QUERY,
      budgetChars: 100_000,
    });
    // teaser <= 220 chars; the rest of the line is the source label.
    expect(lines[0].line.length).toBeLessThan(400);
    expect(lines[0].line).not.toContain('x'.repeat(500));
  });

  it('ignores hits from sources it does not own', () => {
    const { lines } = selectCorpusLines({
      hits: [{ ...wi(), source: 'coord_message', sourceId: 'cm-1' }],
      queryText: QUERY,
    });
    expect(lines).toHaveLength(0);
  });
});

describe('teaser source — the match fragment beats the body lead', () => {
  it('teases and JUDGES on the highlight, so a deep match is not dropped', () => {
    const deep = wi({
      // The lead says nothing about the query; the match is 3000 chars in.
      excerpt: '[bug/open/major] the :3270 dev operator churns a new pid every 30s',
      highlight: '… blocked on the <mark>http2</mark> <mark>transport</mark> cutover …',
    });
    const { lines } = selectCorpusLines({ hits: [deep], queryText: QUERY });
    expect(lines).toHaveLength(1);
    expect(lines[0].line).toContain('http2 transport');
    // ts_headline markup is web emphasis — noise in a prompt.
    expect(lines[0].line).not.toContain('<mark>');
  });

  it('falls back to the excerpt when a source produced no highlight', () => {
    const { lines } = selectCorpusLines({
      hits: [wi({ highlight: '' })],
      queryText: QUERY,
    });
    expect(lines[0].line).toContain('http2 transport regression');
  });
});

/**
 * observation-and-recall-surface-honesty-2026-08-16 P-003 (honest label) and
 * P-004 (the boost is restricted to the curated lane).
 *
 * WHY THIS IS NOT A COSMETIC TEST: `harness_shared.engineer_issues` holds BOTH
 * populations under one `source: 'work_item'` — measured 2026-08-16, 37,089
 * observation rows against 28,335 work-items, i.e. 56.7% of everything this
 * source can return. So before P-003 the majority of the boosted, work-item-
 * labelled population was one agent's unreviewed turn-end reflection.
 */
const obs = (over: Partial<CorpusHit> = {}): CorpusHit =>
  wi({
    sourceId: 'EI-20587312505064997',
    lane: 'observation',
    excerpt: '[change/open/major] http2 transport regression on the sse endpoint',
    ...over,
  });

describe('observation-lane hits are labelled and ranked honestly', () => {
  it('labels an observation as an observation, not as a work-item (P-003)', () => {
    const { lines } = selectCorpusLines({ hits: [obs()], queryText: QUERY });
    expect(lines[0].line).toContain('observation EI-20587312505064997');
    expect(lines[0].line).not.toContain('work-item EI-');
    expect(lines[0].handle.kind).toBe('observation');
  });

  it('says what an observation IS, so a sample cannot read as a filed item', () => {
    const { lines } = selectCorpusLines({ hits: [obs()], queryText: QUERY });
    expect(lines[0].line).toMatch(/turn-end reflection, not a filed work-item/);
  });

  it('still resolves through work_items:get — same relation, same id space', () => {
    const { lines } = selectCorpusLines({ hits: [obs()], queryText: QUERY });
    expect(lines[0].handle.resolve).toBe("work_items:get { id: 'EI-20587312505064997' }");
  });

  it('does NOT claim an observation is a "different work-item from" the current one', () => {
    // That context clause presumes the ref is a work-item; on an observation it
    // asserted a comparison between two things that were never the same kind.
    const { lines } = selectCorpusLines({
      hits: [obs()],
      queryText: QUERY,
      declaredWorkItemId: 'WI-39407',
    });
    expect(lines[0].line).not.toContain('different work-item');
  });

  it('CONTROL: a real work-item keeps its label, its context clause and its boost', () => {
    const { lines } = selectCorpusLines({
      hits: [wi()],
      queryText: QUERY,
      declaredWorkItemId: 'WI-39407',
    });
    expect(lines[0].line).toContain('work-item WI-6512');
    expect(lines[0].line).toContain('different work-item from current WI-39407');
    expect(lines[0].handle.kind).toBe('work-item');
  });

  it('a curated work-item still outranks a session at equal agreement (D-069 intact)', () => {
    // The pre-existing behaviour this change must NOT have broken: the session is
    // fed first, so only the kind tiebreak can move the work-item ahead of it.
    const { lines } = selectCorpusLines({
      hits: [turn(), wi()],
      queryText: QUERY,
    });
    expect(lines.map((l) => l.handle.kind)).toEqual(['work-item', 'session']);
  });

  it('an observation does NOT outrank a session — the boost premise is false for it (P-004)', () => {
    // Same shape as the control above, with the ONLY difference being the lane.
    // Fed session-first, so an observation that still carried the boost would sort
    // ahead of it exactly as the work-item does.
    const { lines } = selectCorpusLines({
      hits: [turn(), obs()],
      queryText: QUERY,
    });
    expect(lines.map((l) => l.handle.kind)).toEqual(['session', 'observation']);
  });

  it('does not EXCLUDE or penalise observations below sessions (plan D-003)', () => {
    // D-003: a relevant past observation is often genuinely useful context. The
    // defect was the unearned boost and the label, never the row's presence — so
    // fed observation-first, it stays first.
    const { lines } = selectCorpusLines({
      hits: [obs(), turn()],
      queryText: QUERY,
    });
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.handle.kind)).toEqual(['observation', 'session']);
  });

  it('FAILS TOWARD work-item when the lane never projected (absent, null, unknown)', () => {
    // A lane column that stops projecting must degrade to the pre-P-003 behaviour,
    // never relabel + demote all 28,335 genuine work-items at once.
    for (const lane of [undefined, null, '', 'improvement'] as const) {
      const { lines } = selectCorpusLines({
        hits: [wi(lane === undefined ? {} : { lane })],
        queryText: QUERY,
      });
      expect(lines[0].handle.kind, `lane=${String(lane)}`).toBe('work-item');
    }
  });

  it('reads the lane case/whitespace-insensitively, but only that exact lane', () => {
    expect(
      selectCorpusLines({ hits: [wi({ lane: '  Observation ' })], queryText: QUERY }).lines[0].handle
        .kind,
    ).toBe('observation');
    // A session_turn can never be an observation however its lane is stamped.
    expect(
      selectCorpusLines({ hits: [turn({ lane: 'observation' })], queryText: QUERY }).lines[0].handle
        .kind,
    ).toBe('session');
  });
});

describe('renderCorpusBlock', () => {
  it('returns null when nothing was admitted', () => {
    expect(renderCorpusBlock([])).toBeNull();
  });

  it('renders under an excerpt heading, so the block describes its self-contained payload', () => {
    const { lines } = selectCorpusLines({ hits: [wi()], queryText: QUERY });
    const block = renderCorpusBlock(lines);
    expect(block).toContain(`### ${CORPUS_BLOCK_HEADING}`);
    expect(block).toContain('WI-6512');
  });
});
