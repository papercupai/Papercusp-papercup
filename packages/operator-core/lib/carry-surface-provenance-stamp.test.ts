/** The stamper's field-shaping contract (P-014 base + P-015 typed-slot lint).
 *  ownerId is withheld so the transcript legs are skipped — these tests pin
 *  the pure composition, not the IO (turn-ref.test.ts covers verification). */
import { describe, expect, it } from 'vitest';
import {
  applyOwnerTurnAutoVerify,
  carryProvenanceFields,
  expandCurrentTurnSentinel,
  FALSIFIED_OWNER_ANCHOR_NOTE,
  falsifiedOwnerAnchors,
  hasCurrentTurnSentinel,
  mergeQuoteMismatchesIntoLint,
  mergeUnresolvedTurnRefsIntoLint,
  OWNER_TURN_VERDICTS,
  UNRESOLVED_TURN_REF_NOTE,
  UNVERIFIED_OWNER_ATTRIBUTION_MARKER,
  markUnverifiedOwnerAttribution,
  normalizeUnverifiedOwnerAttributionMarkers,
  ownerAttributionEnforcement,
  retainedProvenanceText,
  stampCarrySurfaceProvenance,
} from './carry-surface-provenance-stamp';
import { lintCarrySurfaceProvenance, PROVENANCE_LINT_NOTE } from './carry-surface-provenance-lint';
import type { CurrentTurnStamp, TurnRefVerdict } from './turn-provenance/turn-ref';

describe('stampCarrySurfaceProvenance / carryProvenanceFields', () => {
  it('clean text → undefined stamp / empty fields (no response noise)', async () => {
    expect(await stampCarrySurfaceProvenance('routine progress note', null)).toBeUndefined();
    expect(await carryProvenanceFields('routine progress note', null)).toEqual({});
  });

  it('P-015: owner-question prose → typedSlotLint field', async () => {
    const fields = await carryProvenanceFields('waiting on the owner to pick the pricing model', null);
    expect(fields.typedSlotLint?.flagged).toBe(true);
    expect(fields.typedSlotLint?.matches[0].kind).toBe('owner-question-prose');
    expect(fields.provenanceLint).toBeUndefined();
  });

  it('an [ask:…]-cited question is clean; provenance lint still fires independently', async () => {
    const clean = await carryProvenanceFields('pricing question filed [ask:conv_8f31ab2c]', null);
    expect(clean.typedSlotLint).toBeUndefined();

    const both = await carryProvenanceFields(
      ['the owner said to ship dark', 'need to ask the owner about retention'].join('\n'),
      null,
    );
    expect(both.provenanceLint?.flagged).toBe(true);
    expect(both.typedSlotLint?.flagged).toBe(true);
  });
});

describe('a supplied [turn:…] ref always surfaces, even when verification could not run (EI-22197373539314485)', () => {
  // A resolvable-looking ref with no owner-authority language on its line —
  // clean of the sync lint (a [turn:…] ref exempts its own line) and of the
  // typed-slot lint, so the ONLY reason a stamp exists at all is the ref.
  const text = 'See [turn:abcd1234@2026-08-01T00:00:00Z] for the detail.';

  it('ownerId absent (verification leg skipped entirely) → refs[] still contains one checked:false miss, not an undefined stamp', async () => {
    const stamp = await stampCarrySurfaceProvenance(text, null);
    expect(stamp?.refs).toEqual([
      {
        ref: '[turn:abcd1234@2026-08-01T00:00:00Z]',
        found: false,
        verdict: null,
        origin: null,
        snippet: null,
        quote: null,
        quoteMatch: null,
        checked: false,
      },
    ]);
    expect(stamp?.lint?.flagged).toBe(true);
    expect(stamp?.lint?.note).toBe(UNRESOLVED_TURN_REF_NOTE);
    expect(stamp?.lint?.matches).toEqual([
      {
        line: expect.stringContaining('(found:false; checked:false)'),
        kind: 'unresolved-turn-ref',
      },
    ]);
  });

  it('carryProvenanceFields mirrors the same non-vanishing refs entry', async () => {
    const fields = await carryProvenanceFields(text, null);
    expect(fields.turnProvenance?.refs).toHaveLength(1);
    expect(fields.turnProvenance?.refs?.[0]).toMatchObject({ found: false, checked: false });
    expect(fields.provenanceLint?.matches[0]?.kind).toBe('unresolved-turn-ref');
    expect(fields.turnProvenance?.writtenDuring).toBeUndefined();
  });

  it('a precomputed stamp with a degraded (empty) verified leg is backfilled the same way by the shared shaping — regression guard for the withBoundedTimeout fallback path', async () => {
    // Simulates what `stampCarrySurfaceProvenance` produces when `ownerId` is
    // present but the transcript IO degraded (timeout, or an uncaught
    // rejection from either leg): `verified` comes back `[]` even though a
    // real ref was supplied. Before EI-22197373539314485 this collapsed
    // `stamp.refs` — and, with no lint/slotLint on the line, the WHOLE stamp —
    // to `undefined`, so a supplied anchor read back as if nothing had been
    // written at all.
    const stamp = await stampCarrySurfaceProvenance(text, null);
    expect(stamp?.refs).toBeDefined();
    expect(stamp?.refs?.every((v) => v.checked === false && v.found === false)).toBe(true);
    expect(stamp?.lint?.matches[0]?.kind).toBe('unresolved-turn-ref');
  });
});

describe('mergeUnresolvedTurnRefsIntoLint (EI-22458695302531198 — pure)', () => {
  const unresolved = (checked: boolean): TurnRefVerdict => ({
    ref: '[turn:wakepump@2026-09-05T21:26:41Z]',
    found: false,
    verdict: null,
    origin: null,
    snippet: null,
    quote: null,
    quoteMatch: null,
    checked,
  });

  it('flags an unchecked miss without changing checked:false into a failed lookup', () => {
    const merged = mergeUnresolvedTurnRefsIntoLint(
      undefined,
      'The wake-pump action is recorded at [turn:wakepump@2026-09-05T21:26:41Z].',
      [unresolved(false)],
    );
    expect(merged?.flagged).toBe(true);
    expect(merged?.note).toBe(UNRESOLVED_TURN_REF_NOTE);
    expect(merged?.matches[0]).toMatchObject({ kind: 'unresolved-turn-ref' });
    expect(merged?.matches[0]?.line).toContain('found:false; checked:false');
  });

  it('also flags a verified-absent timestamp, while keeping the distinction visible', () => {
    const merged = mergeUnresolvedTurnRefsIntoLint(undefined, undefined, [unresolved(true)]);
    expect(merged?.matches[0]?.line).toContain('found:false; checked:true');
  });

  it('leaves clean and resolved verdicts unchanged', () => {
    const clean = { flagged: true as const, note: 'existing', matches: [{ line: 'x', kind: 'owner-attribution' as const }] };
    expect(mergeUnresolvedTurnRefsIntoLint(clean, 'x', [])).toEqual(clean);
    expect(
      mergeUnresolvedTurnRefsIntoLint(clean, 'x', [{ ...unresolved(false), found: true, checked: true }]),
    ).toEqual(clean);
  });
});

describe('current-vs-retained provenance split (EI-21165235642497045)', () => {
  const current = 'the owner said to run the focused suite';
  const retained = 'the owner said to retain the old checkpoint';

  it('keeps current lint separate from lint found only in inherited bytes', async () => {
    const fields = await carryProvenanceFields(current, null, { retainedText: retained });

    expect(fields.provenanceLint?.matches.map((match) => match.line)).toEqual([current]);
    expect(fields.retainedProvenance?.matches.map((match) => match.line)).toEqual([retained]);
    expect(fields.retainedProvenance?.flagged).toBe(true);
  });

  it('recognizes normalized since suffixes as the supplied row, not retained history', () => {
    const stored = [
      `${retained} (since 2026-08-22T18:00:00.000Z)`,
      `${current} (since 2026-08-22T19:00:00.000Z)`,
    ].join('\n');

    expect(retainedProvenanceText(stored, current)).toBe(`${retained} (since 2026-08-22T18:00:00.000Z)`);
  });
});

describe('same-turn successful-action proof (EI-21375032920365268)', () => {
  it('clears a proven first-person action claim', async () => {
    const fields = await carryProvenanceFields('Messaged fleet leader su-bce40c51 directly', null, {
      successfulActions: [{ toolName: 'coord:send', args: { to: ['su-bce40c51'] } }],
    });
    expect(fields.provenanceLint).toBeUndefined();
  });

  it('keeps unmatched and peer-reported action claims visible', async () => {
    const fields = await carryProvenanceFields(
      ['Messaged fleet leader su-bce40c51 directly', 'su-deadbeef replied about WI-7'].join('\n'),
      null,
      { successfulActions: [{ toolName: 'coord:send', args: { to: ['su-other'] } }] },
    );
    expect(fields.provenanceLint?.matches.map((m) => m.kind)).toEqual([
      'unverified-action-claim',
      'peer-reported-action',
    ]);
  });
});

describe('applyOwnerTurnAutoVerify (cold-carry-system-hardening-2026-07-19 P-005 — pure)', () => {
  const OWNER_TURN: CurrentTurnStamp = { ref: '[turn:abc123@2026-07-19T03:25:00Z]', verdict: 'owner-typed', origin: null };
  const LOOP_TURN: CurrentTurnStamp = { ref: '[turn:abc124@2026-07-19T03:30:00Z]', verdict: 'agent-injected', origin: 'loop-fire' };
  const lintOf = (text: string) => {
    const r = lintCarrySurfaceProvenance(text);
    return r.flagged ? { flagged: true as const, note: PROVENANCE_LINT_NOTE, matches: r.matches } : undefined;
  };

  it('auto-verifies manual [owner:…] tags when the current turn is owner-typed; lint clears when nothing else', () => {
    const lint = lintOf('[owner:Jane 2026-07-19 "Don\'t do the cut yet"] HOLD ruled — no cut until GO.');
    expect(lint?.matches[0].kind).toBe('manual-owner-tag');
    const out = applyOwnerTurnAutoVerify(lint, OWNER_TURN);
    expect(out.ownerTagsAutoVerified).toBe(1);
    expect(out.lint).toBeUndefined();
  });

  it('keeps non-owner-tag matches: only the manual tags are auto-verified', () => {
    const lint = lintOf(
      ['[owner:Jane 2026-07-19] the ruling', 'the owner said to ship it dark'].join('\n'),
    );
    expect(lint?.matches).toHaveLength(2);
    const out = applyOwnerTurnAutoVerify(lint, OWNER_TURN);
    expect(out.ownerTagsAutoVerified).toBe(1);
    expect(out.lint?.matches).toHaveLength(1);
    expect(out.lint?.matches[0].kind).toBe('owner-attribution');
  });

  it('a machine-injected turn auto-verifies NOTHING (the WI-3532 protection stands)', () => {
    const lint = lintOf('[owner:Jane 2026-07-19] the ruling');
    expect(applyOwnerTurnAutoVerify(lint, LOOP_TURN)).toEqual({ lint, ownerTagsAutoVerified: 0 });
    expect(applyOwnerTurnAutoVerify(lint, null)).toEqual({ lint, ownerTagsAutoVerified: 0 });
  });

  it('an OLD-dated tag is NOT auto-verified by today\'s owner turn (fold #3 — no manufactured provenance)', () => {
    const lint = lintOf('[owner:Jane 2026-07-16 "ship it dark"] standing order');
    const out = applyOwnerTurnAutoVerify(lint, OWNER_TURN); // turn date 2026-07-19
    expect(out.ownerTagsAutoVerified).toBe(0);
    expect(out.lint?.matches[0].kind).toBe('manual-owner-tag');
  });

  it('a turn ref with no parseable date verifies nothing (conservative)', () => {
    const lint = lintOf('[owner:Jane 2026-07-19] the ruling');
    const noDate: CurrentTurnStamp = { ref: '[turn:abc]', verdict: 'owner-typed', origin: null };
    expect(applyOwnerTurnAutoVerify(lint, noDate)).toEqual({ lint, ownerTagsAutoVerified: 0 });
  });

  it('clean lint passes through untouched', () => {
    expect(applyOwnerTurnAutoVerify(undefined, OWNER_TURN)).toEqual({ lint: undefined, ownerTagsAutoVerified: 0 });
  });
});

describe('mergeQuoteMismatchesIntoLint (EI-12890 — pure, no IO)', () => {
  const LOOP_REF = '[turn:loop-session@2026-09-12T16:40:19.647Z]';
  const LOOP_TURN: CurrentTurnStamp = { ref: LOOP_REF, verdict: 'agent-injected', origin: 'loop-fire' };
  const verdict = (over: Partial<TurnRefVerdict>): TurnRefVerdict => ({
    ref: '[turn:82909092@2026-07-15T19:50:23Z]',
    found: true,
    verdict: 'owner-typed',
    origin: null,
    snippet: 'I got logged out. Continue where you left off.',
    quote: 'now get our 0.0.11 release out on all 3 platforms',
    quoteMatch: false,
    checked: true,
    ...over,
  });

  it('no lint + no mismatches → undefined (clean case adds nothing)', () => {
    expect(mergeQuoteMismatchesIntoLint(undefined, [])).toBeUndefined();
    expect(mergeQuoteMismatchesIntoLint(undefined, [verdict({ quoteMatch: true })])).toBeUndefined();
    expect(mergeQuoteMismatchesIntoLint(undefined, [verdict({ found: false, quoteMatch: null })])).toBeUndefined();
  });

  it('a quote mismatch on its own → flagged:true with a quote-mismatch match, even with no sync lint', () => {
    const merged = mergeQuoteMismatchesIntoLint(undefined, [verdict({})]);
    expect(merged?.flagged).toBe(true);
    expect(merged?.matches).toHaveLength(1);
    expect(merged?.matches[0].kind).toBe('quote-mismatch');
    expect(merged?.matches[0].line).toContain('now get our 0.0.11 release out on all 3 platforms');
  });

  it('an existing sync-lint flag is preserved and the mismatch is appended, not dropped', () => {
    const lint = { flagged: true as const, note: 'sync note', matches: [{ line: 'the owner said ship dark', kind: 'owner-attribution' as const }] };
    const merged = mergeQuoteMismatchesIntoLint(lint, [verdict({})]);
    expect(merged?.matches).toHaveLength(2);
    expect(merged?.matches.map((m) => m.kind)).toEqual(['owner-attribution', 'quote-mismatch']);
  });

  it('sync lint alone (no mismatch) passes through unchanged', () => {
    const lint = { flagged: true as const, note: 'sync note', matches: [{ line: 'x', kind: 'bare-gate-imperative' as const }] };
    expect(mergeQuoteMismatchesIntoLint(lint, [])).toEqual(lint);
    expect(mergeQuoteMismatchesIntoLint(lint, [verdict({ quoteMatch: true })])).toEqual(lint);
  });

  it('does not flag a quote mismatch on the exact current machine-injected turn', () => {
    const current = verdict({ ref: LOOP_REF, verdict: 'agent-injected', origin: 'loop-fire' });
    expect(mergeQuoteMismatchesIntoLint(undefined, [current], LOOP_TURN)).toBeUndefined();
  });

  it('keeps a quote mismatch from a different machine turn visible', () => {
    const prior = verdict({
      ref: '[turn:loop-session@2026-09-12T16:39:19.647Z]',
      verdict: 'agent-injected',
      origin: 'loop-fire',
    });
    const merged = mergeQuoteMismatchesIntoLint(undefined, [prior], LOOP_TURN);
    expect(merged?.matches).toHaveLength(1);
    expect(merged?.matches[0].kind).toBe('quote-mismatch');
  });

  it('keeps a quote mismatch on the exact current owner turn visible', () => {
    const ownerTurn: CurrentTurnStamp = { ref: LOOP_REF, verdict: 'owner-typed', origin: null };
    const current = verdict({ ref: LOOP_REF, verdict: 'owner-typed', origin: null });
    const merged = mergeQuoteMismatchesIntoLint(undefined, [current], ownerTurn);
    expect(merged?.matches).toHaveLength(1);
    expect(merged?.matches[0].kind).toBe('quote-mismatch');
  });

  it('requires the verified ref to be machine-injected too', () => {
    const current = verdict({ ref: LOOP_REF, verdict: 'owner-typed', origin: null });
    const merged = mergeQuoteMismatchesIntoLint(undefined, [current], LOOP_TURN);
    expect(merged?.matches).toHaveLength(1);
    expect(merged?.matches[0].kind).toBe('quote-mismatch');
  });
});

describe('falsifiedOwnerAnchors (WI-42142)', () => {
  const REF = '[turn:codex:01a03d76-8954-76d3-a211-dc9717f3e07c@2026-08-26T09:46:32.215Z]';

  /** The line, verbatim in shape, from stable-candidate-related-gate-2026-08-23#D-085. */
  const D085_LINE = `Owner-directed ordering. The owner checkpoint records the exact source turn as ${REF}: complete the P-046 release gates first.`;

  const anchorVerdict = (over: Partial<TurnRefVerdict> = {}): TurnRefVerdict => ({
    ref: REF,
    found: true,
    verdict: 'agent-injected',
    origin: 'self-compaction',
    snippet: 'Continue where you left off — this is your fresh successor process',
    quote: null,
    quoteMatch: null,
    checked: true,
    ...over,
  });

  it('THE GAP THIS CLOSES: the sync lint flags nothing on the D-085 line, because a [turn:…] ref exempts it', () => {
    // Not a redundancy check — a control. If this ever starts flagging, the new
    // leg's justification changes and this file should be re-argued, not just fixed.
    expect(lintCarrySurfaceProvenance(D085_LINE).flagged).toBe(false);
  });

  it('an owner-authority claim anchored to a self-compaction turn is falsified', () => {
    const found = falsifiedOwnerAnchors(D085_LINE, [anchorVerdict()]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ ref: REF, verdict: 'agent-injected', origin: 'self-compaction' });
    expect(found[0].line).toContain('Owner-directed ordering');
  });

  it.each(['owner-typed', 'owner-turn', 'owner-dialog'] as const)(
    'a %s verdict is the owner speaking and is never falsified',
    (v) => {
      // The trap this guards: `verdict !== "owner-typed"` reads a cross-session-proven
      // owner-turn and an owner-dialog answer as agent speech and refuses a real directive.
      expect(falsifiedOwnerAnchors(D085_LINE, [anchorVerdict({ verdict: v, origin: null })])).toEqual([]);
      expect(OWNER_TURN_VERDICTS.has(v)).toBe(true);
    },
  );

  it.each(['machine-surface', 'synthetic'] as const)('a %s verdict is falsified too', (v) => {
    expect(falsifiedOwnerAnchors(D085_LINE, [anchorVerdict({ verdict: v })])).toHaveLength(1);
  });

  it('a ref that was never CHECKED yields nothing — a failed lookup must not manufacture a refusal', () => {
    expect(falsifiedOwnerAnchors(D085_LINE, [anchorVerdict({ checked: false })])).toEqual([]);
    expect(falsifiedOwnerAnchors(D085_LINE, [anchorVerdict({ found: false, verdict: null })])).toEqual([]);
    expect(falsifiedOwnerAnchors(D085_LINE, [anchorVerdict({ verdict: null })])).toEqual([]);
    expect(falsifiedOwnerAnchors(D085_LINE, [])).toEqual([]);
    expect(falsifiedOwnerAnchors(null, [anchorVerdict()])).toEqual([]);
  });

  it('a falsified ref on a line that claims NO owner authority is left alone', () => {
    const line = `The build failed at ${REF}; the retry is queued.`;
    expect(falsifiedOwnerAnchors(line, [anchorVerdict()])).toEqual([]);
  });

  it('the claim and the falsified ref must share a LINE — a citation elsewhere does not collide', () => {
    const text = [
      'The owner approved the rollout.',
      `Separately, the nightly run is recorded at ${REF}.`,
    ].join('\n');
    expect(falsifiedOwnerAnchors(text, [anchorVerdict()])).toEqual([]);
  });

  it('does not mistake peer-role owners for the human owner, while preserving D-085 detection', () => {
    const roleOwnerLines = [
      `The plan owner is listed in the frontmatter; the failing run is ${REF}.`,
      `The item is blocked by another live owner's gate lane; the failing run is ${REF}.`,
      `The gate owner's lane is recorded beside the failing run ${REF}.`,
    ];
    for (const line of roleOwnerLines) {
      expect(falsifiedOwnerAnchors(line, [anchorVerdict()])).toEqual([]);
    }

    // A real human-owner claim on the same line still wins over a role mention.
    const mixed = `The plan owner is listed; the owner approved the rollout at ${REF}.`;
    expect(falsifiedOwnerAnchors(mixed, [anchorVerdict()])).toHaveLength(1);

    // D-085's owner-directed / owner-checkpoint phrasing is not a peer role label.
    expect(falsifiedOwnerAnchors(D085_LINE, [anchorVerdict()])).toHaveLength(1);
  });

  it('keeps the broad unqualified-owner conjunction and its line-break escape', () => {
    // The bare noun remains broad so D-085's phrasing stays covered. This can still
    // collide with an unqualified owner mention; moving the unrelated citation clears it.
    const line = `The owner is listed in the frontmatter; the failing run is ${REF}.`;
    expect(falsifiedOwnerAnchors(line, [anchorVerdict()])).toHaveLength(1);
    expect(FALSIFIED_OWNER_ANCHOR_NOTE).toContain('put the citation on its own line');

    // …and the documented escape actually works.
    const split = ['The owner is listed in the frontmatter.', `The failing run is ${REF}.`].join('\n');
    expect(falsifiedOwnerAnchors(split, [anchorVerdict()])).toEqual([]);
  });

  it('reports every offending line, not just the first', () => {
    const text = [D085_LINE, 'unrelated prose', `Owner mandate, source ${REF}.`].join('\n');
    expect(falsifiedOwnerAnchors(text, [anchorVerdict()])).toHaveLength(2);
  });
});

describe('owner-attribution persistence enforcement (P-016 / EI-212678)', () => {
  const REF = '[turn:codex:machine1234@2026-08-26T09:46:32.215Z]';
  const machineStamp: TurnRefVerdict = {
    ref: REF,
    found: true,
    verdict: 'agent-injected',
    origin: 'self-compaction',
    snippet: 'Continue where you left off.',
    quote: null,
    quoteMatch: null,
    checked: true,
  };

  it('treats exact owner-authority lint kinds as unverified', () => {
    const text = 'the owner said to ship it dark';
    const lint = lintCarrySurfaceProvenance(text);
    const enforcement = ownerAttributionEnforcement(text, { lint: { flagged: true, note: 'x', matches: lint.matches } });
    expect(enforcement.unverified).toBe(true);
    expect(enforcement.matches[0]?.kind).toBe('owner-attribution');
  });

  it('treats a same-line ref resolved to a machine turn as unverified', () => {
    const text = `Owner-directed ordering is approved at ${REF}.`;
    const enforcement = ownerAttributionEnforcement(text, { refs: [machineStamp] });
    expect(enforcement.unverified).toBe(true);
    expect(enforcement.falsifiedAnchors).toHaveLength(1);
  });

  it.each(['owner-typed', 'owner-turn', 'owner-dialog'] as const)('accepts a %s same-line owner ref', (verdict) => {
    const enforcement = ownerAttributionEnforcement(textForRef(REF), {
      refs: [{ ...machineStamp, verdict, origin: null }],
    });
    expect(enforcement.unverified).toBe(false);
  });

  it('keeps an unchecked owner ref unverified until an owner verdict resolves', () => {
    const enforcement = ownerAttributionEnforcement(textForRef(REF), {
      refs: [{ ...machineStamp, checked: false }],
    });
    expect(enforcement.unverified).toBe(true);
    expect(enforcement.unresolvedAnchorLines).toHaveLength(1);
  });

  it('prefixes an idempotent marker', () => {
    const text = 'the owner said to ship it dark';
    const marked = markUnverifiedOwnerAttribution(text)!;
    expect(marked.startsWith(`${UNVERIFIED_OWNER_ATTRIBUTION_MARKER}\n`)).toBe(true);
    expect(markUnverifiedOwnerAttribution(marked)).toBe(marked);
    expect(markUnverifiedOwnerAttribution(null)).toBeNull();
  });

  it('collapses duplicate standalone markers from legacy read-modify-write notes', () => {
    const duplicated = [
      UNVERIFIED_OWNER_ATTRIBUTION_MARKER,
      'first state block',
      '---',
      UNVERIFIED_OWNER_ATTRIBUTION_MARKER,
      'second state block',
      '---',
      UNVERIFIED_OWNER_ATTRIBUTION_MARKER,
    ].join('\n');
    const expected = [UNVERIFIED_OWNER_ATTRIBUTION_MARKER, 'first state block', '---', 'second state block', '---'].join(
      '\n',
    );

    expect(normalizeUnverifiedOwnerAttributionMarkers(duplicated)).toBe(expected);
    expect(markUnverifiedOwnerAttribution(duplicated)).toBe(expected);
  });

  function textForRef(ref: string): string {
    return `Owner-directed ordering is approved at ${ref}.`;
  }
});

/** EI-19425644478222007: the agent is asked to cite a value it is never given, so the
 *  ref gets guessed and stores an anchor that resolves to nothing. `[turn:self]` is the
 *  claim it CAN make honestly; the platform expands it at write time. */
describe('expandCurrentTurnSentinel', () => {
  const REAL_REF = '[turn:claude:9f3c1a2b@2026-09-05T00:31:12.402Z]';
  const turn = (): CurrentTurnStamp => ({ ref: REAL_REF, verdict: 'agent-injected', origin: 'loop-fire' });

  it('expands [turn:self] and [turn:current], every occurrence', () => {
    const text = 'Posted evidence [turn:self]; messaged the leader [turn:current]; and again [turn:self].';
    const out = expandCurrentTurnSentinel(text, turn())!;
    expect(out).not.toMatch(/\[turn:(?:self|current)\]/i);
    expect([...out.matchAll(/\[turn:claude:9f3c1a2b@/g)]).toHaveLength(3);
  });

  it('is case-insensitive on the sentinel', () => {
    expect(expandCurrentTurnSentinel('done [TURN:SELF]', turn())).toBe(`done ${REAL_REF}`);
  });

  // The safety property: an unresolvable current turn must NOT invent an anchor.
  it('leaves the sentinel verbatim when the turn cannot be resolved', () => {
    const text = 'Posted evidence [turn:self].';
    expect(expandCurrentTurnSentinel(text, null)).toBe(text);
    expect(expandCurrentTurnSentinel(null, turn())).toBeNull();
  });

  it('passes through text carrying no sentinel', () => {
    const text = `Approved at ${REAL_REF}.`;
    expect(expandCurrentTurnSentinel(text, turn())).toBe(text);
  });

  // Guards the classic /g `.test()` lastIndex bug: CURRENT_TURN_SENTINEL_RE is global,
  // so a checker reusing it would alternate true/false on identical input.
  it('hasCurrentTurnSentinel is stateless across repeated calls', () => {
    const text = 'Posted evidence [turn:self].';
    expect([
      hasCurrentTurnSentinel(text),
      hasCurrentTurnSentinel(text),
      hasCurrentTurnSentinel(text),
    ]).toEqual([true, true, true]);
    expect(hasCurrentTurnSentinel('no sentinel here')).toBe(false);
    expect(hasCurrentTurnSentinel(null)).toBe(false);
  });

  // Cross-module contract. These two assertions are the whole point of the fix: the
  // sentinel must NOT itself satisfy the lint (else it becomes a way to silence the
  // lint without an anchor), and expanding it MUST produce a ref the lint accepts.
  it('is lint-flagged BEFORE expansion and lint-clean AFTER', () => {
    const claim = 'Posted the completion evidence to WI-2144600';
    const before = lintCarrySurfaceProvenance(`${claim} [turn:self]`);
    expect(before.flagged).toBe(true);

    const after = lintCarrySurfaceProvenance(expandCurrentTurnSentinel(`${claim} [turn:self]`, turn())!);
    expect(after.flagged).toBe(false);
  });
});
