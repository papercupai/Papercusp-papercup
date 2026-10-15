/**
 * carry-note-probe-scope.test.ts — EI-18741016606334594.
 *
 * Two subjects, and the FIRST one is the dangerous half:
 *
 *  1. The render/parse ROUND-TRIP. `renderCheckLine` now emits a derived
 *     `[scope: …]` marker, and `parseCheckLine` must strip it. If it does not,
 *     the marker is absorbed into the claim, and since every cold wake
 *     re-renders every stored row, each claim in the fleet GROWS by one marker
 *     per wake — silently, forever, across all 4,040 stored rows. That is the
 *     regression these tests exist for; the lint below is decoration by
 *     comparison.
 *
 *  2. The detector rules, each pinned to the corpus measurement that earned it.
 */
import { describe, it, expect } from 'vitest';

import { renderCheckLine, parseCheckLine, type CheckEntry } from './carry-note';
import {
  describeProbeScope,
  detectScopeOverreach,
  isPrescriptiveClaim,
  renderProbeScopeMarker,
  stripProbeScopeMarker,
} from './carry-note-probe-scope';

describe('render/parse round-trip with the derived scope marker', () => {
  const rows: CheckEntry[] = [
    { claim: 'the gate is green', recheck: "journalctl --since '60 min ago' | grep GATE", verified: 'read 19:47Z' },
    { claim: 'no runaway proc', recheck: 'pgrep -af build; tail -5 /tmp/x.log', verified: 'checked' },
    { claim: 'a plain claim', recheck: 'npm run test:file -- x.test.ts', verified: 'ran it' },
    { claim: 'predicted, bounded probe', recheck: 'head -20 /tmp/y.log' },
    { claim: 'no probe at all' },
    { claim: 'with an id', id: 'gate-green', recheck: 'tail -3 log', verified: 'yes' },
    { claim: 'with a since stamp', recheck: 'limit 10', verified: 'yes', sinceMs: Date.parse('2026-08-13T00:00:00Z') },
  ];

  it('parses back to the ORIGINAL claim — the marker never leaks into the claim text', () => {
    for (const row of rows) {
      const parsed = parseCheckLine(renderCheckLine(row));
      expect(parsed, `row: ${row.claim}`).not.toBeNull();
      expect(parsed!.claim, `row: ${row.claim}`).toBe(row.claim);
    }
  });

  it('is IDEMPOTENT over repeated wakes — 10 render→parse cycles leave the row byte-identical', () => {
    for (const row of rows) {
      const first = renderCheckLine(row);
      let cur = first;
      for (let i = 0; i < 10; i += 1) {
        const parsed = parseCheckLine(cur);
        expect(parsed, `cycle ${i} of: ${row.claim}`).not.toBeNull();
        cur = renderCheckLine(parsed!);
      }
      // The exact failure this pins: a claim that grows by one marker per wake.
      expect(cur, `row: ${row.claim}`).toBe(first);
      expect(parseCheckLine(cur)!.claim).toBe(row.claim);
    }
  });

  it('preserves id, recheck, evidence and sinceMs across the round-trip', () => {
    const row = rows[6];
    const parsed = parseCheckLine(renderCheckLine(row))!;
    expect(parsed.recheck).toBe(row.recheck);
    expect(parsed.verified).toBe(row.verified);
    expect(parsed.sinceMs).toBe(row.sinceMs);
    const withId = parseCheckLine(renderCheckLine(rows[5]))!;
    expect(withId.id).toBe('gate-green');
  });

  it('renders the marker only when the probe declares a bound', () => {
    expect(renderCheckLine(rows[0])).toContain('[scope: last 60 min]');
    // An unbounded probe gets NO marker — an unbounded read is not a defect.
    expect(renderCheckLine(rows[2])).not.toContain('[scope:');
    expect(renderCheckLine(rows[4])).not.toContain('[scope:');
  });

  it('survives a row whose claim ALREADY contains a marker-shaped prefix', () => {
    // A hand-authored row, or one round-tripped through an older renderer.
    const parsed = parseCheckLine('- ✓ [scope: last 5 min] the real claim — re-check: tail -2 log — evidence: e');
    expect(parsed!.claim).toBe('the real claim');
    expect(renderCheckLine(parsed!)).toBe(
      '- ✓ [scope: last 2 lines] the real claim — re-check: tail -2 log — evidence: e',
    );
  });

  it('stripProbeScopeMarker is idempotent and leaves unmarked text alone', () => {
    expect(stripProbeScopeMarker('[scope: last 60 min] hello')).toBe('hello');
    expect(stripProbeScopeMarker(stripProbeScopeMarker('[scope: x] hello'))).toBe('hello');
    expect(stripProbeScopeMarker('hello')).toBe('hello');
    // A `]` inside a label can never terminate the marker early.
    expect(renderProbeScopeMarker({ label: 'a]b', kind: 'time' })).toBe('[scope: ab]');
  });
});

describe('describeProbeScope — the bound a probe declares about itself', () => {
  it.each([
    ["journalctl --user -u x --since '60 min ago' | grep G", 'last 60 min'],
    ['logs --since "24 hours ago"', 'last 24 hours'],
    ['git log --since=\'2026-08-02 20:00\' --name-only', 'since 2026-08-02'],
    ['journalctl --since today | grep -c boot', 'since today'],
    ["ss -tn --since '-30min'", 'last 30 min'],
    ['testing:runs { filePath, sinceHours: 24 }', 'last 24 hours'],
    ['head -20 /tmp/a.log', 'first 20 lines'],
    ['tail -n 5 /tmp/a.log', 'last 5 lines'],
    ['git push --dry-run 2>&1 | tail -2', 'last 2 lines'],
    ['grep -n PAT file.sh | head', 'first few lines'],
    ['SELECT a FROM t LIMIT 10', 'limit 10'],
    ['capability:read { file_path: x, limit: 86 }', 'limit 86'],
  ])('reads %s as %s', (recheck, label) => {
    expect(describeProbeScope(recheck)?.label).toBe(label);
  });

  it('unions bounds and scalar observations across top-level commands', () => {
    const recheck =
      "journalctl --since '60 min ago' | grep GATE; tail -2 /tmp/send.log; pgrep -cf '[h]n-send-remaining'";
    expect(describeProbeScope(recheck)).toEqual({
      label: 'last 60 min + last 2 lines + process count',
      kind: 'composite',
    });
  });

  it('returns null for an UNBOUNDED probe — the common, correct answer', () => {
    for (const r of [
      'npm run test:file -- packages/operator-core/lib/x.test.ts',
      'git rev-parse HEAD',
      'work_items:get { id: EI-1 }',
      're-read the file before editing',
      '',
      undefined,
      null,
    ]) {
      expect(describeProbeScope(r as string | null | undefined)).toBeNull();
    }
  });

  it('never emits a label containing `]` — that would break the row grammar', () => {
    for (const r of ["--since '60 min ago'", 'tail -3', 'limit 9']) {
      expect(describeProbeScope(r)!.label).not.toContain(']');
    }
  });

  it('is total — no input throws', () => {
    for (const r of ['--since', 'tail -', 'limit', '(((', ' ', '\x00', 'a'.repeat(5000)]) {
      expect(() => describeProbeScope(r)).not.toThrow();
    }
  });
});

describe('detectScopeOverreach — the advisory lint', () => {
  const overreaching: CheckEntry = {
    claim: 'No gate run produced a verdict today.',
    recheck: "journalctl -u gate --since '60 min ago' | grep -E 'GATE:'",
    verified: 'Read first-hand 19:47Z including the Finished line',
  };

  it('flags the ROOT INCIDENT: a claim about a day backed by a 60-minute probe', () => {
    const hits = detectScopeOverreach([overreaching]);
    expect(hits).toHaveLength(1);
    // Sentence-initial "No" is the actual quantifier — a case-restricted match
    // used to skip it and report `today` instead, missing the root incident.
    expect(hits[0].quantifier).toBe('No');
    expect(hits[0].probeScope).toBe('last 60 min');
    expect(hits[0].claim).toContain('No gate run produced a verdict today');
  });

  it('does NOT flag a ? PREDICTED row — there is no badge to inherit', () => {
    const { verified: _dropped, ...predicted } = overreaching;
    expect(detectScopeOverreach([predicted])).toHaveLength(0);
  });

  it('does NOT flag an unbounded probe — an unbounded read cannot be outrun', () => {
    expect(detectScopeOverreach([{ ...overreaching, recheck: 'journalctl -u gate | grep GATE' }])).toHaveLength(0);
  });

  it('does NOT flag an unquantified claim', () => {
    expect(
      detectScopeOverreach([{ ...overreaching, claim: 'the 14:42 run SKIPPED after 165.71s' }]),
    ).toHaveLength(0);
  });

  it('does NOT flag a zero-process claim when a later command directly returns that count', () => {
    const recheck =
      "journalctl --since '60 min ago' | tail -2; jq '.items | length' state.json; pgrep -cf '[h]n-send-remaining'";
    expect(
      detectScopeOverreach([
        {
          claim: 'ZERO hn-send-remaining processes were running at 21:45Z.',
          recheck,
          verified: 'checked',
        },
      ]),
    ).toEqual([]);
  });

  it('still flags a count claim whose subject is not covered by the scalar observation', () => {
    const recheck =
      "journalctl --since '60 min ago' | tail -2; pgrep -cf '[h]n-send-remaining'";
    expect(
      detectScopeOverreach([
        {
          claim: 'ZERO gate runs produced a verdict today.',
          recheck,
          verified: 'checked',
        },
      ]),
    ).toMatchObject([{ quantifier: 'ZERO', probeScope: 'last 60 min + process count' }]);
  });

  it('does not treat a process count as proof of a universal positive claim', () => {
    expect(
      detectScopeOverreach([
        {
          claim: 'ALL hn-send-remaining processes were healthy.',
          recheck: "pgrep -cf '[h]n-send-remaining'",
          verified: 'checked',
        },
      ]),
    ).toMatchObject([{ quantifier: 'ALL', probeScope: 'process count' }]);
  });

  /**
   * The measured false-positive class. This fleet writes standing discipline as
   * checks rows, and those carry universal quantifiers by construction while
   * describing no bounded observation at all. Every string below is taken from
   * the real corpus (`harness_shared.carry_notes`).
   */
  it('does NOT flag PRESCRIPTIVE rows — the dominant measured false positive', () => {
    const prescriptive = [
      '⛔ Do NOT pass --mobile-root to any cut/upload. The android leg builds all 4 ABIs then ABORTS.',
      'NEVER trust a background task-completion notification exit code — it reported 0 for runs that exited 1.',
      'For ANY red-test item: re-run at HEAD FIRST, then read the failing assertion values.',
      '⚠ Read a background run via its TEE target, NEVER capability:bash_output, when the pipeline ends in head.',
    ];
    for (const claim of prescriptive) {
      expect(isPrescriptiveClaim(claim), claim).toBe(true);
      expect(detectScopeOverreach([{ claim, recheck: 'tail -5 /tmp/x.log', verified: 'yes' }]), claim).toHaveLength(0);
    }
  });

  it('still flags an ordinary-prose observational claim carrying the same words', () => {
    expect(
      detectScopeOverreach([
        {
          claim: 'the socket-death regime is not reproducible — no bulk transfer starts at all',
          recheck: "journalctl --since today | grep -oE 'moved' | tail -3",
          verified: 'read it',
        },
      ]),
    ).toHaveLength(1);
  });

  it('does not flag a result-scoped no-truncation claim when returned metadata says truncated=0', () => {
    expect(
      detectScopeOverreach([
        {
          claim: 'returned 3 messages, no truncation',
          recheck: "coord:inbox { from:'leader', directed:true, limit:10 }",
          verified: 'fresh response: total=3, returned=3, truncated=0',
        },
      ]),
    ).toEqual([]);
  });

  it('still flags a workspace-wide no-truncation claim from one bounded response', () => {
    expect(
      detectScopeOverreach([
        {
          claim: 'returned 3 messages, no truncation anywhere in the workspace today',
          recheck: "coord:inbox { from:'leader', directed:true, limit:10 }",
          verified: 'fresh response: total=3, returned=3, truncated=0',
        },
      ]),
    ).toMatchObject([{ quantifier: 'no', probeScope: 'limit 10' }]);
  });

  it('requires explicit no-truncation metadata for a result-scoped exception', () => {
    expect(
      detectScopeOverreach([
        {
          claim: 'returned 3 messages, no truncation',
          recheck: "coord:inbox { from:'leader', directed:true, limit:10 }",
          verified: 'fresh response: total=3, returned=3',
        },
      ]),
    ).toMatchObject([{ quantifier: 'no', probeScope: 'limit 10' }]);
  });

  it('does NOT flag quantifier-looking fragments inside hyphenated identifiers', () => {
    const claims = [
      'the sql_read_census deliberate-no-pair TRI-STATE is shipped and running.',
      'the no-op path is shipped and running.',
      'the no-fall branch is covered and running.',
    ];
    for (const claim of claims) {
      expect(
        detectScopeOverreach([{ claim, recheck: 'tail -5 /tmp/x.log', verified: 'read it' }]),
        claim,
      ).toHaveLength(0);
    }
  });

  it('does NOT flag quantifiers inside conditional trigger antecedents', () => {
    const triggers = [
      'ESCALATION FLOOR: if no values ping by ~22:55Z, ping cc991 for run-6 status.',
      'When no values arrive, ping the owner for a fresh status.',
      'Unless every worker reports ready, keep the run parked.',
      'Past 24 hours with no gate verdict, escalate to the release owner.',
    ];
    for (const claim of triggers) {
      expect(
        detectScopeOverreach([{ claim, recheck: 'tail -5 /tmp/x.log', verified: 'yes' }]),
        claim,
      ).toHaveLength(0);
    }
  });

  it('does NOT flag quantifiers inside imperative/directive clauses', () => {
    const directives = [
      'Emit the FULL C1-C6 set in ONE card, never C6 alone.',
      'Verify that every item passes before reporting the result.',
      'Do not trust any cached verdict until release:trace confirms it.',
    ];
    for (const claim of directives) {
      expect(
        detectScopeOverreach([{ claim, recheck: 'tail -5 /tmp/x.log', verified: 'yes' }]),
        claim,
      ).toHaveLength(0);
    }
  });

  it('keeps declarative assertions visible when a row mixes them with triggers or directives', () => {
    expect(
      detectScopeOverreach([
        {
          claim: 'No gate run produced a verdict today; if no values arrive, ping the owner.',
          recheck: 'tail -5 /tmp/x.log',
          verified: 'split evidence',
        },
        {
          claim: 'Emit the full report, never C6 alone; no gate run produced a verdict today.',
          recheck: 'tail -5 /tmp/x.log',
          verified: 'split evidence',
        },
      ]),
    ).toMatchObject([
      { quantifier: 'No', probeScope: 'last 5 lines' },
      { quantifier: 'no', probeScope: 'last 5 lines' },
    ]);
  });

  it('does NOT flag quantifiers used to disclaim the writer\'s own scope', () => {
    const narrowing = [
      {
        claim: 'I split the badge and added never run by me to the recheck.',
        recheck: 'npm run lint:tsc:operator | tail -25',
        verified: 'peer assertion',
      },
      {
        claim: 'MEASURED (this is the whole of what my probe saw).',
        recheck: 'npm run lint:tsc:operator | tail -25',
        verified: 'yes',
      },
      {
        claim:
          'Says nothing about grading-integrity cards from other authors/subjects — the probe was never scoped to enumerate those.',
        recheck: "scorecards:list { rubricRef:'grading-integrity', limit:25 }",
        verified: 'three named cards',
      },
    ];

    expect(detectScopeOverreach(narrowing)).toEqual([]);
  });

  // The lint's advisory tells a writer to narrow an over-broad claim. When it
  // masked only `says? nothing about`, the narrowed row was flagged AGAIN on the
  // disclaimer itself, which trains the writer to ignore every flag. These are
  // the verbs the corpus actually carries in front of `nothing about` (measured
  // 2026-09-08: 29/29 occurrences scope-limiting, zero breadth assertions), and
  // they are here so the fix is not silently narrowed back to one verb.
  it('does NOT flag a scope disclaimer written with any verb before "nothing about"', () => {
    const disclaimed = [
      'It observes nothing about other peers, nothing about plan decisions.',
      'Grep the BUNDLE — the source proves nothing about what runs.',
      'I verified nothing about the suite itself.',
      'Their SPEND ruling stands; my finding changes nothing about it.',
      'It forbids nothing about score floors.',
      'The default path is byte-for-byte historical, so nothing about the live deploy changes.',
    ].map((claim) => ({
      claim,
      recheck: "coord:inbox { from:'su-8b9d39ca', limit:6 }",
      verified: 'read at 07:35Z',
    }));

    expect(detectScopeOverreach(disclaimed)).toEqual([]);
  });

  // Calibration control, from the corpus: this is the SAME disclaimer plus an
  // independent second quantifier ("produced no test evidence"). The mask must
  // blank only the bigram and leave the neighbouring `no` visible — if this
  // stops flagging, the mask is swallowing whole clauses and the clean cases
  // above would pass for the wrong reason.
  it('leaves a second quantifier visible when a claim also carries a "nothing about" disclaimer', () => {
    expect(
      detectScopeOverreach([
        {
          claim: 'I verified nothing about the suite itself and produced no test evidence.',
          recheck: "coord:inbox { from:'su-8b9d39ca', limit:6 }",
          verified: 'read at 07:35Z',
        },
      ]),
    ).toMatchObject([{ quantifier: 'no' }]);
  });

  // Second calibration control: the mask must narrow the BIGRAM only. A bare
  // `nothing` is the common breadth shape, so if this stops flagging, the
  // disclaimer mask (or QUANTIFIER_RE) has been loosened too far.
  it('still flags a bare "nothing" breadth claim that is not followed by "about"', () => {
    expect(
      detectScopeOverreach([
        {
          claim: 'Nothing has changed in the repair queue since the freeze.',
          recheck: "coord:inbox { from:'su-8b9d39ca', limit:6 }",
          verified: 'read at 07:35Z',
        },
      ]),
    ).toMatchObject([{ quantifier: 'Nothing' }]);
  });

  it('still flags a broad assertion that shares a row with a scope disclaimer', () => {
    expect(
      detectScopeOverreach([
        {
          claim: 'No gate run produced a verdict today; the peer result was never run by me.',
          recheck: 'npm run lint:tsc:operator | tail -25',
          verified: 'split evidence',
        },
      ]),
    ).toMatchObject([{ quantifier: 'No', probeScope: 'last 25 lines' }]);
  });

  it('bounds its output and is total on junk input', () => {
    const many = Array.from({ length: 20 }, () => overreaching);
    expect(detectScopeOverreach(many)).toHaveLength(3);
    expect(detectScopeOverreach(many, 5)).toHaveLength(5);
    expect(detectScopeOverreach(null)).toEqual([]);
    expect(detectScopeOverreach(undefined)).toEqual([]);
    expect(detectScopeOverreach([{}, { claim: '' }, { claim: '   ' }])).toEqual([]);
  });

  /**
   * CALIBRATION + CONTROL (repo discipline: a guard that has never failed is a
   * guard you have not tested, and proving falsifiability must never mutate the
   * shared tree). The control is a deliberately-scope-BLIND implementation kept
   * permanently here: it must flag the root incident AND the prescriptive rows,
   * while the real detector flags only the former. If both ever agree, the
   * prescriptive exclusion has silently stopped working.
   */
  it('a scope-BLIND control flags what the real detector correctly skips', () => {
    const blind = (row: CheckEntry): boolean =>
      /\b(no|never|every|all|any|today)\b/i.test(row.claim) && !!describeProbeScope(row.recheck);

    const prescriptiveRow: CheckEntry = {
      claim: 'NEVER trust a background task exit code — it reported 0 for every run that exited 1.',
      recheck: 'tail -5 /tmp/x.log',
      verified: 'yes',
    };

    // Calibration: both agree on the genuine overreach, so the control is live.
    expect(blind(overreaching)).toBe(true);
    expect(detectScopeOverreach([overreaching])).toHaveLength(1);

    // Discrimination: only the blind control fires on standing discipline.
    expect(blind(prescriptiveRow)).toBe(true);
    expect(detectScopeOverreach([prescriptiveRow])).toHaveLength(0);
  });
});

/**
 * EI-20317240969858799 — an UNEXPANDED PLACEHOLDER in a recheck.
 *
 * Measured before wiring, per this module's own D-001 rule: 308 of 3,315 stored
 * notes with a `## Checks` section carry one (9.29%), ~11x the 0.8% that earned
 * `detectScopeOverreach` its place.
 *
 * The FALSE-POSITIVE controls below are the load-bearing half. A pattern that
 * hunts `<...>` inside shell text is one careless widening away from badging
 * every `Promise<void>` in the corpus, and the badge it would add is rendered
 * into every cold wake. They are written as standing controls rather than
 * one-off assertions so that widening fails HERE.
 */
describe('placeholder rechecks — a probe a successor cannot run', () => {
  it("flags the item's own named pattern, and reports it as a placeholder", () => {
    const scope = describeProbeScope('npm run lint:tsc -- --files=<all 11 edited TS files>');
    expect(scope?.kind).toBe('placeholder');
    expect(scope?.label).toBe('placeholder <all 11 edited TS files>');
  });

  it('flags the shapes actually measured in the corpus', () => {
    for (const recheck of ['cd <repo root>', 'git show <candidate>', 'npx tsx <scratch>', 'kill -0 <pid>']) {
      expect(describeProbeScope(recheck)?.kind).toBe('placeholder');
    }
  });

  /**
   * CALIBRATION CONTROL. Each of these contains a `<`, and a naive matcher
   * badges all of them. A generic is ATTACHED to the identifier it
   * parameterises, which is exactly what the negative lookbehind keys on; a
   * redirect never closes with `>`.
   */
  it('does NOT fire on generics, tags, or shell redirects', () => {
    for (const recheck of [
      "grep -n 'Promise<void>' src/x.ts",
      'rg "Array<string>" packages',
      'tsc --noEmit 2>&1 | tail -5',
      'psql -f - <<EOF',
      'sort < input.txt',
      'test $a -lt 5',
    ]) {
      expect(describeProbeScope(recheck)?.kind).not.toBe('placeholder');
    }
  });

  it('outranks a bound in the same string — an unreachable bound is not a bound', () => {
    // Contains BOTH a placeholder and a real `tail -3` line cut.
    const scope = describeProbeScope('grep ERROR <the failing log> | tail -3');
    expect(scope?.kind).toBe('placeholder');
  });

  /**
   * The consumer regression. `detectScopeOverreach` calls `describeProbeScope`
   * and reports any scope beside a quantified claim, so adding a kind silently
   * recruited placeholders into a lint that means something else. The
   * calibration half proves the lint is still LIVE rather than switched off.
   */
  it('is excluded from the scope-overreach lint, which still fires on real overreach', () => {
    const placeholderRow: CheckEntry = {
      claim: 'every scheduler test passes on the current tree.',
      recheck: 'npm run test:file -- <the changed files>',
      verified: 'ran them',
    };
    const realOverreach: CheckEntry = {
      claim: 'no gate run produced a verdict today.',
      recheck: "journalctl --since '60 min ago' | grep GATE:",
      verified: 'checked',
    };

    // Calibration: the lint is live and still catches the shape it was built for.
    expect(detectScopeOverreach([realOverreach])).toHaveLength(1);
    // Discrimination: the placeholder row is left to its own advisory.
    expect(detectScopeOverreach([placeholderRow])).toHaveLength(0);
  });

  /**
   * The dangerous half, per this file's header: the marker is DERIVED at render
   * time and must be stripped on parse. If it is not, every cold wake re-renders
   * the row and the claim grows by one marker, forever.
   */
  it('round-trips: the derived marker never accretes into the claim', () => {
    const row: CheckEntry = {
      claim: 'the six edited files typecheck clean.',
      recheck: 'npm run lint:tsc -- --files=<your files>',
      verified: 'status=clean',
    };

    const line = renderCheckLine(row);
    expect(line).toContain('[scope: placeholder <your files>]');

    const parsed = parseCheckLine(line);
    expect(parsed?.claim).toBe('the six edited files typecheck clean.');
    expect(parsed?.claim).not.toContain('[scope:');

    // Re-rendering the parsed row is byte-stable — the accretion regression.
    expect(renderCheckLine({ ...row, ...parsed })).toBe(line);
    expect(stripProbeScopeMarker(renderProbeScopeMarker({ label: 'placeholder <x>', kind: 'placeholder' }))).toBe('');
  });
});
