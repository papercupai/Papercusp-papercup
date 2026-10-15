/**
 * WI-38297 — the stranded-finished-work triage read.
 *
 * The classifier itself (`checkpointDeclaresTerminal`) is REAL here, never mocked. That
 * is the whole point: this suite's job is to pin what the real predicate actually does
 * over real checkpoint text — including where it is WRONG — so nobody "improves" the
 * scan into an auto-closer without a test telling them what that costs.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyStrandedRows,
  checkpointHead,
  harnessFromIssueScope,
} from './stranded-checkpoint-scan';
import { workItemCheckpointScope } from './work-item-checkpoint';
import { checkpointDeclaresTerminal } from './checkpoint-terminal-claim';

const DAY = 86_400_000;
const daysAgo = (n: number) => Date.now() - n * DAY;

function row(over: Partial<Parameters<typeof classifyStrandedRows>[0][number]> = {}) {
  return {
    issue_id: 'WI-1',
    scope: 'harness:papercusp',
    kind: 'change',
    title: 't',
    assignee: null,
    severity: null,
    origin: 'local',
    note: 'P-001 DONE + VERIFIED + plan item FLIPPED to done. Nothing left here.',
    updated_ts: String(daysAgo(10)),
    ...over,
  };
}

describe('the carry-note scope key: the join premise (WI-38297)', () => {
  /**
   * `scanStrandedCheckpoints` joins carry_notes to work-items on the ID PARSED OUT OF
   * the scope key — `substring(cn.scope from '[^:]+$')`, i.e. everything after the LAST
   * colon. That is a structural assumption about `workItemCheckpointScope`'s output
   * format, and it is invisible from the SQL: if the key ever gains a trailing
   * component, the join silently matches ZERO rows and the tool reports a clean,
   * confident "no stranded work" — the exact shape of failure this whole work-item
   * exists to eliminate. So assert the premise directly against the real key builder.
   */
  const ids = ['WI-5895', 'EI-18681435059177620', 'F-42'];
  const harnesses = ['papercusp', null, '', '*', 'oddsmith-hive', '@singleton'];

  it('always puts the work-item id after the LAST colon', () => {
    for (const h of harnesses) {
      for (const id of ids) {
        const scope = workItemCheckpointScope(h, id);
        expect(scope.slice(scope.lastIndexOf(':') + 1), `scope=${scope}`).toBe(id);
      }
    }
  });

  it("always starts with the 'workitem:' prefix the scan filters on", () => {
    for (const h of harnesses) {
      expect(workItemCheckpointScope(h, 'WI-1').startsWith('workitem:')).toBe(true);
    }
  });

  it('canonicalizes null/empty/* harness onto ONE namespace, so no item is unreachable', () => {
    const wildcard = workItemCheckpointScope('*', 'WI-1');
    expect(workItemCheckpointScope(null, 'WI-1')).toBe(wildcard);
    expect(workItemCheckpointScope('', 'WI-1')).toBe(wildcard);
    // …and the id is STILL the trailing segment for that shape — the harness-null case
    // is precisely the one a rebuilt-in-SQL scope string would have missed (EI-8805).
    expect(wildcard.slice(wildcard.lastIndexOf(':') + 1)).toBe('WI-1');
  });
});

describe('checkpointHead — the tool-log tail trap (WI-38297)', () => {
  /**
   * Checkpoints carry an auto-appended `tool-log tail:` block listing TOOL NAMES, and
   * those names include the literal strings `work_items_complete` / `work_items_release`.
   * Measured: 6 of 15 matches in a tail-reading experiment were pure tool-log noise.
   */
  const withToolLog =
    'CLAIMED 03:27Z, no code written yet. Read the item body in full.\n' +
    '\ntool-log tail:\n' +
    'work_items_claim ·\nBash npm run test:file -- packages/… ✓\nwork_items_complete ×2 ·\nwork_items_release ·';

  it('strips the tool-log tail so it cannot be read as completion evidence', () => {
    const head = checkpointHead(withToolLog);
    expect(head).toContain('no code written yet');
    expect(head).not.toContain('tool-log tail');
    expect(head).not.toContain('work_items_complete');
    expect(head).not.toContain('work_items_release');
  });

  it('returns the HEAD, not the tail, when the note exceeds the budget', () => {
    const note = `OPENING VERDICT: this is the part that decides the item.${'x'.repeat(5000)}TAIL`;
    const head = checkpointHead(note, 60);
    expect(head.startsWith('OPENING VERDICT')).toBe(true);
    expect(head).not.toContain('TAIL');
    expect(head.length).toBeLessThanOrEqual(61); // 60 + the ellipsis
  });

  it('leaves a short note whole and un-ellipsized', () => {
    expect(checkpointHead('P-001 DONE. Nothing left here.')).toBe('P-001 DONE. Nothing left here.');
  });
});

describe('CONTROL CASES — the measured false positives (WI-38297)', () => {
  /**
   * ⚠ THESE ASSERTIONS DOCUMENT A KNOWN DEFECT, NOT A DESIRED BEHAVIOUR.
   *
   * `checkpointDeclaresTerminal` measured ~43% precise over the live open backlog
   * (2026-08-12, hand-reading all 23 matches). The strings below are REAL checkpoint
   * heads from that measurement which the classifier MATCHES and which are emphatically
   * NOT finished work. They are pinned permanently because they are the evidence that
   * this surface must stay read-only: an auto-closer built on this predicate would close
   * an item whose own checkpoint opens "⛔ DO NOT CLOSE".
   *
   * If you improve the classifier so one of these stops matching, that is a genuine win
   * — delete it from this list and say so. Do NOT delete the list.
   *
   * ✅ 2026-08-12 — SAYING SO, as instructed. `EI-19474857043229377` ("…the central open
   * question is now CLOSED") was REMOVED from this list because it is FIXED, not because
   * it became inconvenient. The bare adverb `now` was dropped from the assertive-
   * transition marker for the five ambiguous tokens (passed/resolved/closed/blocked/done)
   * after measuring the whole live population: 8 matches fired on `now` alone and ALL 8
   * were false positives. The two survivors below are untouched by that fix and STILL
   * MATCH — they fire on genuinely performative verbs ("flipped done", "DUPLICATE") whose
   * subject merely happens not to be this item, which is a harder problem than word sense.
   * So the surface stays READ-ONLY: precision improved, it did not become trustworthy.
   */
  /**
   * VERBATIM excerpts, including the substring that actually fired — established by
   * running each marker against the real notes and printing the match with its context.
   * Paraphrases are worthless as controls here: an earlier draft of this suite used
   * tidied-up versions of these heads and they did NOT match, because the deciding text
   * sat thousands of characters below the part a human would quote.
   */
  const knownFalsePositives: ReadonlyArray<readonly [string, string]> = [
    [
      'EI-20034001963934568 — "flipped done" describes ANOTHER plan\'s item',
      'CLAIMED 03:27Z, no code written yet. Read the item body in full — it is unusually ' +
        'well-diagnosed; do not re-derive it.\n\n' +
        'goal-mode-2026-08-07 P-001 → WORKSPACE PER GOAL, recorded as D-027, item flipped done. ' +
        "That plan's Phase 1 is unblocked and its downstream items are claimable.",
    ],
    [
      'WI-38071 — a duplicate, not finished work',
      'DUPLICATE LEADER ITEM — do not resume separately. WI-38071 links duplicates → WI-37891.',
    ],
  ];

  it.each(knownFalsePositives)('still matches known false positive: %s', (_label, cp) => {
    expect(checkpointDeclaresTerminal(cp)).toBe(true);
  });

  /**
   * FIXED CASE — graduated OUT of the list above on 2026-08-12. Pinned here in the
   * opposite direction so the win cannot silently regress: this note must NOT match.
   * It is the same VERBATIM head, kept in full because the deciding text ("now CLOSED")
   * sits far below the part a human would quote.
   */
  it('no longer matches EI-19474857043229377 — "now CLOSED" describes a sub-QUESTION (fixed 2026-08-12)', () => {
    const realHead =
      'READ THREAD POST 56018 FIRST — it FALSIFIES the leading hypotheses with measurements.\n\n' +
      'STATE: open, claimed. ⛔ DO NOT CLOSE on the strength of the instrumentation shipped ' +
      'below — the deciding leg is still UNIDENTIFIED.\n\n' +
      'Everything above is a snapshot from 08-04 whose central open question is now CLOSED.\n\n' +
      '**THE DECIDING LEG IS `cupPlaceableFrontier`.**';
    expect(checkpointDeclaresTerminal(realHead)).toBe(false);
  });

  /**
   * THE MECHANISM, pinned separately because it is the actionable half.
   *
   * Five of the six markers are anchored (`^…`) or structurally specific. The sixth —
   * the `<verb> to <terminal-state>` alternation — is NOT anchored, so it fires on a
   * terminal statement made about SOMETHING OTHER THAN THE ITEM, anywhere in a long
   * checkpoint. Measured offsets in the two real notes above: 2,818 and 13,364 chars in.
   * Both anchored markers were clean.
   *
   * This is why the fix is NOT "tighten the regex" from inside this scan: the predicate
   * is shared with the pot placement watchdog's stale-open reconcile, where the
   * false-positive cost is different (it suppresses a re-place page). Restricting the
   * unanchored marker to the note head would likely kill both of these, and is worth
   * doing deliberately, with the watchdog's own cases re-verified — not as a side effect
   * of a triage read.
   */
  it('the imprecision comes from the ONE unanchored marker, firing deep in the note', () => {
    // 2026-08-12: this used to read `…is now CLOSED.` — the NARRATIVE form, now fixed.
    // The mechanism it documents is UNCHANGED and still live, so the case was re-pointed
    // at a PERFORMATIVE verb rather than deleted: an unanchored marker still fires on a
    // terminal statement made about something other than the item, arbitrarily deep in
    // the note. Only the word-sense half of the problem was solved.
    const aboutSomethingElse = `${'context. '.repeat(200)}that plan's item was flipped done.`;
    expect(checkpointDeclaresTerminal(aboutSomethingElse)).toBe(true);
    // …while the anchored markers cannot fire from mid-text at all.
    expect(checkpointDeclaresTerminal(`${'context. '.repeat(200)}TERMINAL — done here.`)).toBe(false);
    expect(checkpointDeclaresTerminal(`${'context. '.repeat(200)}WI-4480 PASSED 2026-07-17.`)).toBe(false);
  });

  it('matches genuine completion declarations too (the calibration case)', () => {
    // Without this, the assertions above would also pass if the predicate matched
    // EVERYTHING — a classifier that is broken open is not the same as one that is 43%.
    expect(
      checkpointDeclaresTerminal('P-001 DONE + VERIFIED + plan item FLIPPED to done. Nothing left here.'),
    ).toBe(true);
    expect(checkpointDeclaresTerminal('WI-4480 PASSED 2026-07-17 15:12Z')).toBe(true);
  });

  it('does NOT match an ordinary in-progress checkpoint (the negative control)', () => {
    expect(checkpointDeclaresTerminal('Read the resolver; next step is to wire the sync query.')).toBe(false);
    expect(checkpointDeclaresTerminal('Investigating why the gate is red; no fix yet.')).toBe(false);
    expect(checkpointDeclaresTerminal('')).toBe(false);
    expect(checkpointDeclaresTerminal(null)).toBe(false);
  });
});

describe('ranking — oldest strand first (WI-38297)', () => {
  /**
   * REGRESSION PIN for a rationale the live data refuted. The first cut ranked
   * `citesBgJob` ABOVE age, reasoning that a checkpoint promising a background-job
   * result was the strongest strand signal. Measured against the live backlog, the four
   * bg-citing matches were 0d/0d/3d/10d old while every genuine strand (WI-3529 33d,
   * WI-5372 24d, WI-5457 23d) cited no job at all: an agent whose checkpoint mentions a
   * running job is usually an agent working RIGHT NOW.
   */
  it('ranks an OLD strand above a fresh one that cites a background job', () => {
    const r = classifyStrandedRows(
      [
        row({
          issue_id: 'FRESH-BG',
          // WI-5895's real phrasing: the strand as it is actually created.
          note:
            'WI-5895 DONE — fix committed. test:affected running in background (bash id bx76day3h) ' +
            'to confirm no other suite depended on the old behavior — will report+complete once it finishes.',
          updated_ts: String(daysAgo(0)),
        }),
        row({ issue_id: 'OLD-STRAND', updated_ts: String(daysAgo(30)) }),
      ],
      { limit: 10 },
    );
    expect(r.candidates.map((c) => c.id)).toEqual(['OLD-STRAND', 'FRESH-BG']);
    expect(r.candidates[1]!.citesBgJob).toBe(true);
  });

  it('breaks an age tie toward the background-job citation', () => {
    const r = classifyStrandedRows(
      [
        row({ issue_id: 'PLAIN', updated_ts: String(daysAgo(5)) }),
        row({
          issue_id: 'BG',
          note: 'WI-3561 DONE. tsc --noEmit running in background; awaiting result before considering this done.',
          updated_ts: String(daysAgo(5)),
        }),
      ],
      { limit: 10 },
    );
    expect(r.candidates.map((c) => c.id)).toEqual(['BG', 'PLAIN']);
  });
});

describe('counts are totals, never page-bounded (WI-38297)', () => {
  /**
   * A count computed over a capped fetch is indistinguishable from a real total, and
   * THIS count gets read as "how much stranded work is there". So `matched` must span
   * the whole population even when the row list is a page.
   */
  const many = Array.from({ length: 25 }, (_, i) =>
    row({ issue_id: `WI-${i}`, updated_ts: String(daysAgo(i + 1)) }),
  );

  it('reports the full match count beside a truncated page, and says it is truncated', () => {
    const r = classifyStrandedRows(many, { limit: 5 });
    expect(r.scanned).toBe(25);
    expect(r.matched).toBe(25);
    expect(r.returned).toBe(5);
    expect(r.candidates).toHaveLength(5);
    expect(r.truncatedByLimit).toBe(true);
  });

  it('does not claim truncation when the page holds everything', () => {
    const r = classifyStrandedRows(many, { limit: 100 });
    expect(r.matched).toBe(25);
    expect(r.returned).toBe(25);
    expect(r.truncatedByLimit).toBe(false);
  });

  it('counts only classifier matches, not the scanned population', () => {
    const r = classifyStrandedRows(
      [row({ issue_id: 'HIT' }), row({ issue_id: 'MISS', note: 'still working on the resolver' })],
      { limit: 10 },
    );
    expect(r.scanned).toBe(2);
    expect(r.matched).toBe(1);
    expect(r.candidates.map((c) => c.id)).toEqual(['HIT']);
  });
});

describe('minAgeDays floor (WI-38297)', () => {
  it('drops matches younger than the floor and echoes the floor beside the count', () => {
    const rows = [
      row({ issue_id: 'OLD', updated_ts: String(daysAgo(30)) }),
      row({ issue_id: 'YOUNG', updated_ts: String(daysAgo(1)) }),
    ];
    expect(classifyStrandedRows(rows, { limit: 10 }).matched).toBe(2);
    const floored = classifyStrandedRows(rows, { limit: 10, minAgeDays: 7 });
    expect(floored.matched).toBe(1);
    expect(floored.minAgeDays).toBe(7);
    expect(floored.candidates.map((c) => c.id)).toEqual(['OLD']);
  });

  it('KEEPS an undated checkpoint under a floor — unknown age is not evidence of freshness', () => {
    const r = classifyStrandedRows([row({ issue_id: 'NO-TS', updated_ts: null })], {
      limit: 10,
      minAgeDays: 30,
    });
    expect(r.matched).toBe(1);
    expect(r.candidates[0]!.checkpointAgeDays).toBeNull();
    expect(r.candidates[0]!.checkpointWrittenTs).toBeNull();
  });

  it('reports minAgeDays 0 when no floor was asked for', () => {
    expect(classifyStrandedRows([row()], { limit: 10 }).minAgeDays).toBe(0);
  });
});

describe('row projection (WI-38297)', () => {
  it('derives the harness from the issue scope, and tolerates a non-harness scope', () => {
    expect(harnessFromIssueScope('harness:papercusp')).toBe('papercusp');
    expect(harnessFromIssueScope('harness:@singleton')).toBe('@singleton');
    expect(harnessFromIssueScope('operator')).toBeNull();
    expect(harnessFromIssueScope(null)).toBeNull();
  });

  it('carries the evidence a reader needs to overturn the match', () => {
    const r = classifyStrandedRows(
      [row({ issue_id: 'WI-5895', assignee: 'su-7a80832c', severity: 'major' })],
      { limit: 10 },
    );
    const c = r.candidates[0]!;
    expect(c).toMatchObject({
      id: 'WI-5895',
      harness: 'papercusp',
      kind: 'change',
      assignee: 'su-7a80832c',
      severity: 'major',
    });
    expect(c.checkpointHead).toContain('DONE');
    expect(c.checkpointAgeDays).toBe(10);
  });

  it('handles a numeric updated_ts as well as the bigint-as-string form', () => {
    const ts = daysAgo(3);
    expect(classifyStrandedRows([row({ updated_ts: ts })], { limit: 1 }).candidates[0]!.checkpointAgeDays).toBe(3);
    expect(
      classifyStrandedRows([row({ updated_ts: String(ts) })], { limit: 1 }).candidates[0]!.checkpointAgeDays,
    ).toBe(3);
  });
});

/**
 * A remote-authored item REFUSES `work_items:complete` on this node — "its authoring
 * peer must claim/resolve it, and this node will receive the terminal state through
 * federation". Nothing else in a candidate row predicts that, so before this existed a
 * drain agent paid the ENTIRE verification cost and only then discovered it could not
 * close the item. Measured live 2026-08-12: 74 of 489 open checkpointed items (15%).
 */
describe('closableLocally: the federation wall a drain agent otherwise hits last (WI-38297)', () => {
  it('marks a remote-authored candidate unclosable and keeps its raw origin', () => {
    const r = classifyStrandedRows([row({ issue_id: 'WI-3529', origin: 'remote' })], { limit: 5 });
    expect(r.candidates[0]!.closableLocally).toBe(false);
    expect(r.candidates[0]!.origin).toBe('remote');
    expect(r.candidates[0]!.ownNodeAuthored).toBe(false);
  });

  /**
   * WI-10006562: a row this node authored but a sync echo stranded at origin='remote' is
   * closable here (the write paths heal its origin). Measured 2026-10-06: all 66 open
   * checkpointed remote rows on the dev box were own-node, so every one was mislabelled.
   */
  it('treats an own-node row stranded at origin=remote as closable, and does not count it', () => {
    const r = classifyStrandedRows(
      [
        row({ issue_id: 'OWN', origin: 'remote', own_node_authored: true, updated_ts: String(daysAgo(20)) }),
        row({ issue_id: 'PEER', origin: 'remote', own_node_authored: false, updated_ts: String(daysAgo(19)) }),
      ],
      { limit: 5 },
    );
    const byId = Object.fromEntries(r.candidates.map((c) => [c.id, c]));
    expect(byId.OWN).toMatchObject({ closableLocally: true, ownNodeAuthored: true, origin: 'remote' });
    expect(byId.PEER).toMatchObject({ closableLocally: false, ownNodeAuthored: false, origin: 'remote' });
    expect(r.matchedNotClosableLocally).toBe(1);
  });

  it.each([[null], [undefined]])('keeps the remote wall when own-node is unknown (%s)', (own) => {
    const r = classifyStrandedRows([row({ origin: 'remote', own_node_authored: own })], { limit: 5 });
    expect(r.candidates[0]!.closableLocally).toBe(false);
    expect(r.candidates[0]!.ownNodeAuthored).toBe(false);
  });

  it('reports ownNodeAuthored only for a remote-labelled row', () => {
    const r = classifyStrandedRows([row({ origin: 'local', own_node_authored: true })], { limit: 5 });
    expect(r.candidates[0]!.ownNodeAuthored).toBe(false);
    expect(r.candidates[0]!.closableLocally).toBe(true);
  });

  it('treats a locally-authored candidate as closable', () => {
    const r = classifyStrandedRows([row({ issue_id: 'WI-5372', origin: 'local' })], { limit: 5 });
    expect(r.candidates[0]!.closableLocally).toBe(true);
  });

  /**
   * FAILS OPEN, deliberately. Only an explicit 'remote' is a wall: if the column is ever
   * null/renamed/unmapped, every row would read as unclosable and the tool would hide the
   * entire drainable backlog behind a phantom wall. Being wrong the other way costs one
   * cheap, authoritative refusal from the server.
   */
  it.each([[null], ['unknown-future-value']])('treats origin %s as closable (fails open)', (origin) => {
    const r = classifyStrandedRows([row({ origin })], { limit: 5 });
    expect(r.candidates[0]!.closableLocally).toBe(true);
  });

  it('counts matchedNotClosableLocally over the WHOLE population, never the returned page', () => {
    const rows = [
      row({ issue_id: 'R-1', origin: 'remote', updated_ts: String(daysAgo(30)) }),
      row({ issue_id: 'R-2', origin: 'remote', updated_ts: String(daysAgo(29)) }),
      row({ issue_id: 'R-3', origin: 'remote', updated_ts: String(daysAgo(28)) }),
      row({ issue_id: 'L-1', origin: 'local', updated_ts: String(daysAgo(27)) }),
    ];
    // limit:1 returns a single row — the aggregate must still describe all four, or a
    // caller sizing "how much of this can I drain" reads a floor as a total.
    const r = classifyStrandedRows(rows, { limit: 1 });
    expect(r.returned).toBe(1);
    expect(r.truncatedByLimit).toBe(true);
    expect(r.matched).toBe(4);
    expect(r.matchedNotClosableLocally).toBe(3);
  });

  it('counts only MATCHED rows — a non-matching remote row is not counted', () => {
    const r = classifyStrandedRows(
      [
        row({ issue_id: 'REMOTE-BUT-NOT-A-STRAND', origin: 'remote', note: 'still working on the resolver' }),
        row({ issue_id: 'REMOTE-STRAND', origin: 'remote' }),
      ],
      { limit: 5 },
    );
    expect(r.matched).toBe(1);
    expect(r.matchedNotClosableLocally).toBe(1);
  });

  it('does not let origin disturb the measured age-first ranking', () => {
    // Age is the primary key and remains so: a FRESH local row must not outrank an OLD
    // remote one just because the local one is actionable here.
    const r = classifyStrandedRows(
      [
        row({ issue_id: 'YOUNG-LOCAL', origin: 'local', updated_ts: String(daysAgo(2)) }),
        row({ issue_id: 'OLD-REMOTE', origin: 'remote', updated_ts: String(daysAgo(40)) }),
      ],
      { limit: 5 },
    );
    expect(r.candidates.map((c) => c.id)).toEqual(['OLD-REMOTE', 'YOUNG-LOCAL']);
  });
});
