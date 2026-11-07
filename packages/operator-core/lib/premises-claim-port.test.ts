/**
 * premises-claim-port.test.ts — false-premise-in-prescriptive-artifacts-2026-08-02
 * P-001.
 *
 * The fixtures are REAL body text sampled from `harness_shared.work_items`
 * (harness papercusp, 2026-08-02) rather than invented sentences — including the
 * measured false positive (WI-7132), whose absence phrase sits entirely inside a
 * backticked error string. A detector validated only against sentences its author
 * wrote is validated against its own assumptions, which is the defect this whole
 * plan is about.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  stripNonProse,
  detectAbsencePremises,
  uncoveredAbsencePremises,
  buildPremisesBrief,
  evidenceNamesScope,
  getClaimTimePremises,
  invalidatedPremiseCitationChecks,
  type DerivedPremise,
  type PremiseCitationProbe,
} from './premises-claim-port';

/** WI-7042 — the root incident. A real search over the wrong scope, stated as an
 *  absolute absence, prescribing a module that already existed. */
const WI_7042 = `Thin PG read for delegated spawn-request facts.
There is no exported read helper for harness_shared.p2p_work_offers, so this needs
a thin PG read module before the trace can synthesize a verdict.`;

/** WI-7132 — the measured FALSE POSITIVE: the only absence phrase is quoted tool
 *  output the author PASTED AS EVIDENCE, not a claim about the codebase. */
const WI_7132 =
  'The query died on real Postgres with `column "payload" does not exist` — the ' +
  'derived table projected narrowly, so compileRank ORDER BY vocabulary regressed.';

const derive = (t: string): DerivedPremise[] => detectAbsencePremises(t, 'work-item');

describe('stripNonProse (the measured false-positive fix)', () => {
  it('blanks inline code spans while preserving offsets', () => {
    const out = stripNonProse('a `bad does not exist` b');
    expect(out).toHaveLength('a `bad does not exist` b'.length);
    expect(out).not.toContain('does not exist');
  });

  it('blanks fenced blocks', () => {
    expect(stripNonProse('x\n```\nthere is no foo\n```\ny')).not.toContain('there is no foo');
  });
});

describe('detectAbsencePremises', () => {
  it('fires on the root incident (WI-7042) and captures the subject', () => {
    const [p, ...rest] = derive(WI_7042);
    expect(rest).toHaveLength(0);
    expect(p.kind).toBe('absence');
    expect(p.source).toBe('work-item');
    expect(p.claim).toContain('no exported read helper');
    // D-001 (c): the recheck must NAME the concrete artifact to search for...
    expect(p.recheck).toContain('harness_shared.p2p_work_offers');
    expect(p.recheck).not.toContain('exported read helper');
    // ...and demand the SCOPE, since scope-of-inference is the measured failure.
    expect(p.recheck).toMatch(/whole repo/i);
    expect(p.recheck).toMatch(/scope/i);
  });

  it('keeps flagging temporal absence claims but gives them an observation probe, not a prose grep', () => {
    const [p] = derive('There WAS no wake between 17:21Z and expiry — this wake was the LAST scheduled chance.');
    expect(p.kind).toBe('absence');
    expect(p.recheck).toMatch(/what would falsify/i);
    expect(p.recheck).toMatch(/observe/i);
    expect(p.recheck).not.toMatch(/search|grep|whole repo/i);
  });

  it('does not mistake a negative action disposition for a missing surface', () => {
    expect(derive('The checkpoint records that no such action is being taken now.')).toEqual([]);
    expect(derive('The note says no such action, not reassigning or executing it.')).toEqual([]);
  });

  it('does not turn session-scoped claim/action negatives into repository absences', () => {
    const body = 'We have NO bug claim, NO change-kind declaration, NO code edit/test/rerun yet.';

    expect(derive(body)).toEqual([]);
    expect(uncoveredAbsencePremises(body, 'carry-note')).toEqual([]);
  });

  it('still flags a durable source surface with similar action words', () => {
    expect(derive('There is no code edit/test/rerun parser in the checkpoint writer.')).toHaveLength(1);
  });

  it('does not treat a no-mismatch test outcome as a missing surface', () => {
    const conditional =
      "If the test fails on the 'tip' case precondition, drop 'tip' from it.each (the preflight then honoured the input, so there was no mismatch to test).";
    expect(derive(conditional)).toEqual([]);
    expect(derive('There is no mismatch detector for the it.each preflight.')).toHaveLength(1);
  });

  it('still flags an actually missing action surface', () => {
    expect(derive('There is no action handler for this queue entry.')).toHaveLength(1);
  });

  it('preserves explicit committed-file containment scope (EI-26715154436743115)', () => {
    const [p] = derive(
      'In staging build516579404d, file packages/operator-core/lib/agent-tools/capability/launch-agent.ts is selected and it lacks startupReservation.',
    );
    expect(p.recheck).toContain('git show 516579404d:packages/operator-core/lib/agent-tools/capability/launch-agent.ts');
    expect(p.recheck).not.toMatch(/whole repo/i);
  });

  it('uses the exact named path for an artifact absence without requiring file/path wording', () => {
    const exactPath = '.papercusp/scratch/ei267083-current-qualification-20261023e.json';
    const [p] = derive(
      `There is no E receipt, naming \`${exactPath}\`; guarded capture threw before \`writeFileSync\`.`,
    );
    expect(p.recheck).toContain(`\`${exactPath}\``);
    expect(p.recheck).toMatch(/filesystem existence/i);
    expect(p.recheck).not.toMatch(/whole repo|search for/i);
  });

  it('keeps a serving-runtime absence check on its loaded build', () => {
    const [p] = derive('The served handler at build 516579404d is selected and it lacks startupReservation.');
    expect(p.recheck).toContain('serving runtime/handler at 516579404d');
    expect(p.recheck).toMatch(/loaded code identity/i);
    expect(p.recheck).not.toMatch(/whole repo/i);
  });

  it('retains a repository-wide search when a universal claim cites an example file', () => {
    const [p] = derive('Across the whole repo there is no startupReservation helper, including in packages/operator-core/lib/agent-tools/capability/launch-agent.ts.');
    expect(p.recheck).toMatch(/whole repo/i);
    expect(p.recheck).not.toContain('git show');
  });

  it('does not interpret an unqualified missing handler as a live-runtime census', () => {
    const [p] = derive('There is no startupReservation handler.');
    expect(p.recheck).toMatch(/whole repo/i);
  });

  it('uses scope beyond the displayed claim length', () => {
    const [p] = derive('The serving handler is selected and it lacks startupReservation, '
      + 'and this is a containment comparison against the explicitly selected version rather than a claim about other implementations or about the repository as a whole, '
      + 'in build 516579404d file packages/operator-core/lib/agent-tools/capability/launch-agent.ts.');
    expect(p.claim.length).toBeLessThanOrEqual(220);
    expect(p.recheck).toContain('git show 516579404d:packages/operator-core/lib/agent-tools/capability/launch-agent.ts');
  });

  it('does not synthesize a grep target from transient VCS prose (EI-22412433263118345)', () => {
    const [p] = derive(
      'The pending edit is comment-only, tests-green and tsc-clean, so there is no broken intermediate to bank.',
    );
    expect(p.kind).toBe('absence');
    expect(p.recheck).toMatch(/what would falsify/i);
    expect(p.recheck).toMatch(/observe/i);
    expect(p.recheck).not.toMatch(/search|grep|broken intermediate to bank/i);
  });

  it('does not turn a stopword absence subject into a search term', () => {
    const [p] = derive('what did not exist was any wake I could RELY on');
    expect(p.kind).toBe('absence');
    expect(p.recheck).toMatch(/what would falsify/i);
    expect(p.recheck).not.toMatch(/search|grep|whole repo/i);
  });

  it('uses observation guidance for a long natural-language absence subject', () => {
    const [p] = derive(
      'There is no durable explanation available to future readers of this checkpoint note without additional context.',
    );
    expect(p.kind).toBe('absence');
    expect(p.recheck).toMatch(/what would falsify/i);
    expect(p.recheck).not.toMatch(/whole repo/i);
  });

  it('does NOT fire on quoted tool output (WI-7132, the measured FP)', () => {
    expect(derive(WI_7132)).toEqual([]);
  });

  it('is silent on prose with no absence claim, and on stubs', () => {
    expect(derive('Refactor the resolver to use the shared helper and add a test.')).toEqual([]);
    expect(derive('fix it')).toEqual([]);
    expect(derive('')).toEqual([]);
  });

  it('catches the other measured absence shapes', () => {
    expect(derive('That is the guard that should have caught it, and it does not exist.')).toHaveLength(1);
    expect(derive('There is no such thing as a safe default here, so nothing reads the flag today.')).not.toHaveLength(
      0,
    );
    expect(derive('We have no reader for the offers table, so one must be written.')).toHaveLength(1);
  });

  it('stays quiet for rhetorical `no X` prose while retaining real absence referents', () => {
    for (const sentence of [
      'Cheap enough that there is no excuse for relaying.',
      'There is no reason to wait for a calmer window.',
      'There is no need to add another module.',
      'There is no point in grepping for a rhetorical phrase.',
      'There is no coincidence required to explain this result.',
    ]) {
      expect(derive(sentence), sentence).toEqual([]);
    }

    expect(derive('There is no exported reader for harness_shared.work_items.')).toHaveLength(1);
    expect(derive('The ledger exists, but there is no reader for it.')).toHaveLength(1);
  });

  it('stays quiet for live-state negation while retaining a missing runtime-observer surface', () => {
    expect(derive('The current leg is visibly progressing, so there is no stall to remediate.')).toEqual([]);
    expect(derive('The task is advancing and there is no live blocker to clear.')).toEqual([]);

    // A bounded coord:inbox census reports current state; it does not prove that
    // an inbox reader or handler is absent from the repository.
    expect(derive('The bounded inbox read reports there are no unanswered direct messages.')).toEqual([]);
    expect(derive('There is no reader for unanswered direct messages.')).toHaveLength(1);

    expect(derive('There is no stall detector for affected tasks.')).toHaveLength(1);
  });

  it('dedups repeated claims and bounds the row count', () => {
    const many = Array.from({ length: 9 }, (_, i) => `There is no helper number ${i} anywhere.`).join('\n');
    expect(derive(many).length).toBeLessThanOrEqual(4);
    const repeated = 'There is no reader here.\nThere is no reader here.';
    expect(derive(repeated)).toHaveLength(1);
  });

  it('tags plan-item provenance separately', () => {
    expect(detectAbsencePremises(WI_7042, 'plan-item')[0].source).toBe('plan-item');
  });

  /**
   * EI-19399570274386816 — POLARITY. These patterns match a surface string, not a
   * proposition, so a sentence RETRACTING an absence read identically to one asserting it.
   * That fires hardest on the exact write the guard wants to cause: the author who ran the
   * search, found the thing, and is documenting the correction. An advisory guard that
   * warns on correct behaviour trains agents to dismiss it, which costs it its real catches.
   */
  describe('polarity: a RETRACTION of an absence claim is not an absence claim', () => {
    /** VERBATIM the loop:checkpoint sentence that misfired (the filing incident). */
    const RETRACTION =
      'isCheckpointRunLockHeldCheap (release-checkpoint-launch.ts:648) IS the single ' +
      'authoritative both-origins source I claimed did not exist, so the premise was FALSE.';

    it('⭐ does not fire on the measured retraction sentence', () => {
      expect(derive(RETRACTION)).toEqual([]);
    });

    it('does not fire when a reporting VERB is captured as the subject', () => {
      // "<verb> did not exist" captured "claimed" and then told the reader to grep the
      // repo for "claimed" — a search term that names nothing.
      expect(derive('The helper I claimed did not exist is right there in the module.')).toEqual([]);
      expect(derive('The reader we assumed did not exist has been present since March.')).toEqual([]);
    });

    it('does not fire on an explicit self-retraction in the same sentence', () => {
      expect(derive('I said there is no exported reader for that table, and I was wrong.')).toEqual([]);
      expect(derive('There is no reader for the offers table — RETRACTED, it exists.')).toEqual([]);
      expect(derive('There is no such helper, but that premise was false.')).toEqual([]);
    });

    it('does not fire when an absence claim is explicitly documented as false', () => {
      expect(
        derive(
          '**EI-6971** — its load-bearing ABSENCE claim "there is no persistent outcome memory" is FALSE: ' +
            'last_released_at 7395, terminal_reason 6758, requeue_count>0 1496.',
        ),
      ).toEqual([]);
    });

    it('does not fire on a first-person reporting frame preceding the claim', () => {
      expect(derive('Earlier I claimed there is no exported read helper for that table.')).toEqual([]);
    });

    /**
     * The suppression must stay NARROW. "already exists" / "does exist" read like
     * retraction markers but legitimately share a sentence with a REAL absence claim, so
     * they are deliberately not in the marker set — including them would trade this false
     * positive for a false negative on a genuine claim.
     */
    it('STILL fires on a genuine absence that merely mentions something else existing', () => {
      expect(derive('The table already exists, but there is no reader for the offers table.')).toHaveLength(1);
      expect(derive('The flag does exist, yet nothing reads the offers table today.')).toHaveLength(1);
    });

    /**
     * A falsification criterion states what WOULD disprove a claim — conditional by
     * construction, never an assertion. 4 of the 7 total suppressions measured over 4000
     * real bodies were this shape, and they had been caught only INCIDENTALLY (the literal
     * word "Falsified" sits in the retraction marker set), so a relabel would have quietly
     * restored every false positive.
     */
    it('does not fire on an absence phrase inside a "Falsified if:" criterion', () => {
      const real =
        '- Falsified if: If bash_output already returns a distinct killed verdict for the ' +
        'SIGKILLed sleep, the core bug does not exist in the current build.';
      expect(derive(real)).toEqual([]);
    });

    it('survives a relabel of the falsifier field (the fragility that motivated making it explicit)', () => {
      expect(derive('- Disproved if: the script finds zero packages and the problem does not exist.')).toEqual([]);
      expect(derive('- Refuted if: there is no unregistered package left in the gate.')).toEqual([]);
    });

    it('STILL fires on the root incident and the other measured shapes (no regression)', () => {
      expect(derive(WI_7042)).toHaveLength(1);
      expect(derive('That is the guard that should have caught it, and it does not exist.')).toHaveLength(1);
    });
  });

  /**
   * EI-19399570274386816 — the claim SPAN. `lastIndexOf('.')` treated every dot as a
   * sentence boundary, so a claim citing a file (the common case here) was sliced
   * mid-token: the incident emitted `"ts:648) IS the single authoritative…"`. A rendered
   * claim nobody can parse is worse than none — it looks like output and means nothing.
   */
  describe('claim span: a dot inside a token is not a sentence boundary', () => {
    it('⭐ does not start the claim mid-token on a file.ts:NNN citation', () => {
      const [p] = derive('The probe lives at release-checkpoint-launch.ts:648 and there is no caller for it.');
      expect(p).toBeDefined();
      expect(p.claim).not.toMatch(/^ts:/);
      // The whole sentence survives, so the claim reads as a claim.
      expect(p.claim).toContain('release-checkpoint-launch.ts:648');
      expect(p.claim).toContain('there is no caller');
    });

    it('still ends the claim at a REAL sentence terminator', () => {
      const [p] = derive('There is no reader for that table. A later sentence must not be swallowed.');
      expect(p.claim).toContain('There is no reader for that table');
      expect(p.claim).not.toContain('later sentence');
    });

    it('is not confused by a decimal number inside the claim', () => {
      const [p] = derive('At 1.5x load there is no headroom left on the box.');
      expect(p.claim).toContain('At 1.5x load');
    });

    /**
     * The mirror of the bug above: a terminator followed by CLOSING markup is still a
     * terminator. Without this the span runs past a markdown bold-close and swallows the
     * next sentence — measured on real bodies, where `**That lint does not exist.**
     * Verified repo-wide…` came back as one run-on claim.
     */
    it('treats a terminator followed by closing markup as a real sentence end', () => {
      const [p] = derive('**That lint does not exist.** Verified repo-wide at 04:09Z against the whole tree.');
      expect(p.claim).toContain('That lint does not exist');
      expect(p.claim).not.toContain('Verified repo-wide');
    });

    it('same for a closing paren or quote after the dot', () => {
      const [a] = derive('(There is no reader for that table.) A separate sentence follows here.');
      expect(a.claim).not.toContain('separate sentence');
      const [b] = derive('The note said "there is no such helper." Then the author moved on.');
      expect(b.claim).not.toContain('moved on');
    });
  });
});

describe('uncoveredAbsencePremises', () => {
  const claim =
    'The mcp-proxy failure ledger has been written since W8 and there is no reader for it — nothing ingests the file.';

  it('returns the shared detector result when no evidence row covers it', () => {
    expect(uncoveredAbsencePremises(claim, 'carry-note')).toEqual([
      expect.objectContaining({ claim: expect.stringContaining('no reader'), recheck: expect.any(String) }),
    ]);
  });

  it('suppresses a parked probe by word overlap instead of brittle substring identity', () => {
    const probe =
      '✓ VERIFIED — mcp-proxy failure ledger has been written since W8; reader absent; nothing ingests that file';
    expect(uncoveredAbsencePremises(claim, 'carry-note', probe)).toEqual([]);
  });

  it('does not let an unrelated check row silence the absence premise', () => {
    expect(uncoveredAbsencePremises(claim, 'carry-note', '✓ VERIFIED — release gate is green')).toHaveLength(1);
  });
});

describe('evidenceNamesScope (P-002)', () => {
  it('accepts evidence that names where it looked', () => {
    for (const s of [
      'grepped the whole repo 2026-08-02',
      'searched across packages/ and libs/',
      'repo-wide ripgrep, zero hits',
      'checked every call site',
      'rg over packages, libs, apps — nothing',
    ]) {
      expect(evidenceNamesScope(s), s).toBe(true);
    }
  });

  it('rejects evidence that only asserts a search happened', () => {
    for (const s of ['I checked', 'grepped for it and found nothing', 'verified, none found', '']) {
      expect(evidenceNamesScope(s), s).toBe(false);
    }
  });
});

describe('terminal evidence invalidates a cited premise (EI-18733326519945478)', () => {
  const invalidated = 'Resolved as a wrong-premise proposal: the supposedly missing promotion guard already exists.';

  const probeWith = (
    rows: Record<string, { state: string; terminalCompletionRef: string | null }>,
  ): PremiseCitationProbe =>
    vi.fn(async (id: string) => {
      const row = rows[id];
      return row ? { id, ...row } : null;
    });

  it('reproduces the EI-10203 -> WI-4329 incident without using item age as a proxy', async () => {
    const probe = probeWith({
      'WI-4329': { state: 'done', terminalCompletionRef: invalidated },
    });

    const rows = await invalidatedPremiseCitationChecks(
      'EI-10203 proposes a new promotion gate and cites WI-4329 as its foundation.',
      { selfId: 'EI-10203', probe, max: 1 },
    );

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith('WI-4329');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.claim).toContain('WI-4329 is done');
    expect(rows[0]!.claim).toContain('wrong-premise');
    expect(rows[0]!.recheck).toMatch(/before building/i);
  });

  it('stays silent for live refs and ordinary terminal completions', async () => {
    const probe = probeWith({
      'WI-1001': { state: 'open', terminalCompletionRef: invalidated },
      'WI-1002': { state: 'done', terminalCompletionRef: 'Implemented and verified with focused tests.' },
    });

    await expect(invalidatedPremiseCitationChecks('Depends on WI-1001 and WI-1002.', { probe })).resolves.toEqual([]);
  });

  it('fails soft on an unresolved/rejected citation and honors a zero probe budget', async () => {
    const rejecting: PremiseCitationProbe = vi.fn(async () => {
      throw new Error('read failed');
    });
    await expect(invalidatedPremiseCitationChecks('Depends on WI-9999.', { probe: rejecting })).resolves.toEqual([]);

    const bounded = vi.fn(async () => ({ id: 'WI-9999', state: 'done', terminalCompletionRef: invalidated }));
    await expect(invalidatedPremiseCitationChecks('Depends on WI-9999.', { probe: bounded, max: 0 })).resolves.toEqual(
      [],
    );
    expect(bounded).not.toHaveBeenCalled();
  });

  it('flows the invalidation through the claim-time brief without adding an absence warning', async () => {
    const probe = probeWith({
      'WI-4329': { state: 'resolved', terminalCompletionRef: invalidated },
    });

    const brief = await getClaimTimePremises({
      workItem: {
        id: 'EI-10203',
        payload: {},
        title: 'Build a new promotion gate',
        summary: 'This proposal depends on the findings in WI-4329.',
      },
      citedWorkItemProbe: probe,
    });

    expect(brief?.rendered.join('\n')).toContain('WI-4329 is resolved');
    expect(brief?.note).toMatch(/terminal evidence explicitly INVALIDATED its premise/);
    expect(brief?.note).not.toContain('Absence claims');
  });
});

describe('buildPremisesBrief', () => {
  it('returns null when there is nothing to warn about', () => {
    expect(buildPremisesBrief([], [])).toBeNull();
  });

  it('frames the item as a HYPOTHESIS rather than annotating the prescription', () => {
    const brief = buildPremisesBrief([], derive(WI_7042))!;
    expect(brief.unverified).toBe(1);
    expect(brief.note).toMatch(/HYPOTHESIS, not a spec/);
    expect(brief.note).toMatch(/BEFORE building/);
    expect(brief.rendered[0].startsWith('- ?')).toBe(true); // PREDICTED badge
  });

  it('a VERIFIED declared premise REPLACES the overlapping derived row (D-001 a)', () => {
    const declared = [
      {
        claim: 'There is no exported read helper for harness_shared.p2p_work_offers',
        verified: 'grepped the whole repo 2026-08-02 — offer-store.ts exports none',
      },
    ];
    // Verified + no surviving unverified row ⇒ silent, not "here is a premise, and
    // also it might be wrong".
    expect(buildPremisesBrief(declared, derive(WI_7042))).toBeNull();
  });

  it('an UNVERIFIED declared premise does not silence the derived row', () => {
    const declared = [{ claim: 'There is no exported read helper for harness_shared.p2p_work_offers' }];
    const brief = buildPremisesBrief(declared, derive(WI_7042))!;
    expect(brief.unverified).toBeGreaterThan(0);
  });

  it('a SCOPE-LESS declared absence premise does NOT silence the derived row (P-002)', () => {
    // WI-7042's premise WAS checked — a real grep, over the wrong leg. So "I
    // checked" is not evidence of an absence; only "I checked HERE" is.
    const declared = [
      {
        claim: 'There is no exported read helper for harness_shared.p2p_work_offers',
        verified: 'I grepped for it and found nothing',
      },
    ];
    const brief = buildPremisesBrief(declared, derive(WI_7042))!;
    expect(brief).not.toBeNull();
    expect(brief.unverified).toBeGreaterThan(0);
    // Replaced, not annotated: no ✓ badge survives on that row.
    expect(brief.rendered.some((r) => r.startsWith('- ✓'))).toBe(false);
    expect(brief.rendered.join('\n')).toMatch(/SCOPE NOT NAMED/);
    // The original observation is preserved, not deleted.
    expect(brief.rendered.join('\n')).toContain('I grepped for it and found nothing');
  });

  it('a NON-absence premise keeps its ✓ on plain evidence (the stricter bar is absence-only)', () => {
    const declared = [{ claim: 'The gate was green at cut time', verified: 'checked at 23:00Z' }];
    const brief = buildPremisesBrief(declared, derive(WI_7042))!;
    expect(brief.rendered.some((r) => r.startsWith('- ✓'))).toBe(true);
  });

  it('keeps an unrelated derived row even when another premise is verified', () => {
    const declared = [{ claim: 'The gate is green', verified: 'checked at 23:00Z' }];
    const brief = buildPremisesBrief(declared, derive(WI_7042))!;
    expect(brief.premises.some((p) => p.claim.includes('exported read helper'))).toBe(true);
    expect(brief.unverified).toBe(1);
  });
});

/**
 * P-014 (fleet-lead-instrumentation-audit-2026-08-09) — the lint QUOTED the redacted
 * prose it detects on, so backticked identifiers were blanked out of the sentence it
 * echoed back at the author. Stripping code is right for DECIDING whether a line is an
 * absence claim (a pasted error string is evidence, not an assertion); it is wrong for
 * QUOTING, and an incoherent quote plus a recheck saying "grep for this" is worse than
 * no lint — it trains the reader to ignore a leg that catches a real class.
 */
describe('quoting: the echoed claim keeps the identifiers the author wrote (P-014)', () => {
  // The shape of the reported incident: backticked identifiers inside the sentence.
  const NOTE =
    'I checked the schema and there is no `severity` column on `harness_shared.work_items` ' +
    'and no top-level accessor — the id column is `payload._ei`.';

  it('echoes the identifiers instead of the blanked husk', () => {
    const [p] = derive(NOTE);
    expect(p).toBeDefined();
    expect(p!.claim).toContain('`severity`');
    expect(p!.claim).toContain('`harness_shared.work_items`');
    // The measured symptom: collapsed blanks leaving a stranded fragment.
    expect(p!.claim).not.toMatch(/\s{2,}/);
    expect(p!.claim).not.toContain('there is no  ');
  });

  it('names the real identifier in the recheck, so the grep it prescribes can succeed', () => {
    const [p] = derive(NOTE);
    expect(p!.recheck).toContain('severity');
    expect(p!.recheck).not.toContain('`'); // backticks are markdown, not part of the search
  });

  it('CONTROL — detection still runs on REDACTED prose: a pasted error string is not a claim', () => {
    // Calibration for the two cases above: if restoring the quote had also restored code
    // to the DETECTION input, this would start firing — the exact false positive the
    // stripping exists to prevent.
    const pasted =
      'The migration failed and I captured the output verbatim below, which is why I am filing this. ' +
      'The server said `column "payload" does not exist` when the deploy ran.';
    expect(derive(pasted)).toEqual([]);
  });

  it('CONTROL — a subject that is ENTIRELY code still does not register as a claim', () => {
    // The subject group runs to the sentence end, so it is only fully redacted when the
    // code span IS the rest of the sentence. Restoring the quote must not change this:
    // the skip happens at subject-resolution, before anything is quoted.
    expect(derive('I read the schema dump carefully just now and there is no `severity_rank`.')).toEqual([]);
  });

  it('quotes an ordinary code-free claim exactly as before (no regression on the common path)', () => {
    const plain = 'I searched the whole tree and there is no exported read helper for this table anywhere.';
    const [p] = derive(plain);
    expect(p!.claim).toBe('I searched the whole tree and there is no exported read helper for this table anywhere');
  });

  it('does not let a dot INSIDE a code span end the quoted sentence early', () => {
    // Why bounds are still computed on the redacted text: scanning the ORIGINAL would
    // treat the dot in `a.b` as a sentence end and truncate the claim mid-identifier.
    const withDot = 'Checking now, there is no `payload._ei` accessor on the view and that breaks the audit.';
    const [p] = derive(withDot);
    expect(p!.claim).toContain('that breaks the audit');
  });
});
