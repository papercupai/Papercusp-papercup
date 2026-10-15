import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REMEDIATING_KINDS,
  claimsRemediation,
  collectApplicableDeclarations,
  evaluateCloseTerminalCriteria,
  evaluateTerminalCriteria,
  readItemTerminalCriteriaDeclaration,
  refuseLoweringDeclaration,
  resolveTerminalCriteria,
  type ProofFloor,
  type TerminalCriteriaDeclaration,
  type TerminalCriteriaInput,
} from './terminal-criteria';

/**
 * Fixtures are the four stored closes of EI-20185455308799001, as measured in D-006 of
 * plan `machine-enforced-terminal-criteria-2026-09-05`. Three were force-reopened; one
 * survived. The evaluator must reject the three and admit the one — rejecting everything
 * would score 3/4 while being useless, which is why the over-reach control below is a
 * separate, explicit assertion rather than an afterthought.
 */

/** Closes #1 and #2: `verifiedHow: 'already-passing'`, no root cause, no files, no tests. */
const closeNoEvidence: TerminalCriteriaInput = {
  itemKind: 'bug',
  status: 'done',
  filesChanged: [],
  filesDeleted: [],
  treeStamp: null,
};

/**
 * Close #3 — the discriminating case. It named a genuine mechanism (a leaf-only resolver
 * recording `scopeUnit:null` under a managed ancestor scope) and cited the commits carrying
 * the fix, but changed nothing itself: `filesChanged` empty, `addedTests:false`. A truthful
 * causal narrative that remediates nothing must still fail.
 */
const closeNarratedCauseChangedNothing: TerminalCriteriaInput = {
  itemKind: 'bug',
  status: 'done',
  filesChanged: [],
  treeStamp: null,
};

/** The close that actually survived: three files changed, resolved against real blobs. */
const closeThatSurvived: TerminalCriteriaInput = {
  itemKind: 'bug',
  status: 'done',
  filesChanged: [
    'packages/operator-core/lib/task-manager/reconcile.ts',
    'packages/operator-core/lib/task-manager/reconcile.test.ts',
    'packages/operator-core/lib/task-manager/scope-unit.ts',
  ],
  treeStamp: {
    contentIdentity: [
      {
        path: 'packages/operator-core/lib/task-manager/reconcile.ts',
        workingTreeBlobSha: 'a'.repeat(40),
        headBlobSha: 'a'.repeat(40),
      },
      {
        path: 'packages/operator-core/lib/task-manager/reconcile.test.ts',
        workingTreeBlobSha: 'b'.repeat(40),
        headBlobSha: null,
      },
      {
        path: 'packages/operator-core/lib/task-manager/scope-unit.ts',
        workingTreeBlobSha: 'c'.repeat(40),
        headBlobSha: 'c'.repeat(40),
      },
    ],
  },
};

describe('evaluateTerminalCriteria — the D-006 replay', () => {
  it('rejects a close that declares no evidence at all', () => {
    const result = evaluateTerminalCriteria(closeNoEvidence);
    expect(result.claimsRemediation).toBe(true);
    expect(result.verdict).toBe('fail');
    expect(result.wouldBlock).toEqual(['durable-change']);
  });

  it('rejects a close that narrates a real cause but changes nothing', () => {
    const result = evaluateTerminalCriteria(closeNarratedCauseChangedNothing);
    expect(result.verdict).toBe('fail');
    expect(result.ratings['durable-change'].rating).toBe('fail');
    expect(result.ratings['durable-change'].evidence).toContain('report, not a fix');
  });

  it('ADMITS the close that survived — the gate is a filter, not a mute', () => {
    const result = evaluateTerminalCriteria(closeThatSurvived);
    expect(result.verdict).toBe('pass');
    expect(result.wouldBlock).toEqual([]);
    expect(result.ratings['durable-change'].rating).toBe('pass');
  });

  it('scores 4/4 on the stored closes rather than refusing everything', () => {
    const verdicts = [
      evaluateTerminalCriteria(closeNoEvidence).verdict,
      evaluateTerminalCriteria(closeNoEvidence).verdict,
      evaluateTerminalCriteria(closeNarratedCauseChangedNothing).verdict,
      evaluateTerminalCriteria(closeThatSurvived).verdict,
    ];
    expect(verdicts).toEqual(['fail', 'fail', 'fail', 'pass']);
  });
});

describe('the floor applies only to closes claiming remediation', () => {
  it('rates a zero-code wontfix not-applicable, never fail', () => {
    const result = evaluateTerminalCriteria({
      itemKind: 'bug',
      status: 'done',
      terminalReason: 'wontfix',
      filesChanged: [],
    });
    expect(result.claimsRemediation).toBe(false);
    expect(result.ratings['durable-change'].rating).toBe('not-applicable');
    expect(result.wouldBlock).toEqual([]);
    expect(result.verdict).toBe('pass');
  });

  it.each(['wontfix', 'wont-fix', 'WONT_FIX', "won't fix", 'Wont Fix', 'NOT_REPRODUCIBLE', 'by design'])(
    'collapses the free-text disposition %j onto its canonical key',
    (terminalReason) => {
      expect(claimsRemediation({ itemKind: 'bug', status: 'DONE', terminalReason })).toBe(false);
    },
  );

  it('still treats an unrecognised disposition as remediating rather than silently excusing it', () => {
    expect(claimsRemediation({ itemKind: 'bug', status: 'done', terminalReason: 'fixed in passing' })).toBe(true);
  });

  it('leaves a task close alone — task is not a remediating kind by default', () => {
    const result = evaluateTerminalCriteria({ itemKind: 'task', status: 'done', filesChanged: [] });
    expect(result.claimsRemediation).toBe(false);
    expect(result.wouldBlock).toEqual([]);
    expect(DEFAULT_REMEDIATING_KINDS).not.toContain('task');
  });

  it('does not apply to a non-success status', () => {
    expect(claimsRemediation({ itemKind: 'bug', status: 'dropped' })).toBe(false);
  });

  it('honours a widened remediating-kind set', () => {
    const result = evaluateTerminalCriteria({
      itemKind: 'task',
      status: 'done',
      filesChanged: [],
      remediatingKinds: ['bug', 'change', 'task'],
    });
    expect(result.claimsRemediation).toBe(true);
    expect(result.verdict).toBe('fail');
  });
});

describe('a measurement failure is never charged to the closer', () => {
  it('rates an unreadable HEAD side unknown, not fail', () => {
    const result = evaluateTerminalCriteria({
      itemKind: 'bug',
      status: 'done',
      filesChanged: ['packages/operator-core/lib/x.ts'],
      treeStamp: {
        contentIdentity: [
          {
            path: 'packages/operator-core/lib/x.ts',
            workingTreeBlobSha: null,
            headBlobSha: null,
            headBlobUnresolvable: 'ambiguous ref',
          },
        ],
      },
    });
    expect(result.ratings['durable-change'].rating).toBe('unknown');
    expect(result.verdict).toBe('unknown');
  });

  it('rates a missing tree stamp unknown — absence means NOT OBSERVED', () => {
    const result = evaluateTerminalCriteria({
      itemKind: 'bug',
      status: 'done',
      filesChanged: ['packages/operator-core/lib/x.ts'],
      treeStamp: null,
    });
    expect(result.ratings['durable-change'].rating).toBe('unknown');
    expect(result.ratings['durable-change'].evidence).toContain('NOT OBSERVED');
  });

  it('fails a declared path that resolved to nothing and was not reported unresolvable', () => {
    const result = evaluateTerminalCriteria({
      itemKind: 'bug',
      status: 'done',
      filesChanged: ['papercusp/packages/operator-core/lib/x.ts'],
      treeStamp: {
        contentIdentity: [
          { path: 'papercusp/packages/operator-core/lib/x.ts', workingTreeBlobSha: null, headBlobSha: null },
        ],
      },
    });
    expect(result.ratings['durable-change'].rating).toBe('fail');
  });
});

describe('deletions and non-code artifacts', () => {
  it('accepts a proven deletion as a durable change', () => {
    const result = evaluateTerminalCriteria({
      itemKind: 'change',
      status: 'done',
      filesDeleted: ['packages/operator-core/lib/dead.ts'],
      treeStamp: {
        contentIdentity: [
          {
            path: 'packages/operator-core/lib/dead.ts',
            workingTreeBlobSha: null,
            headBlobSha: null,
            deletion: true,
          },
        ],
      },
    });
    expect(result.verdict).toBe('pass');
  });

  it('does not count an out-of-repo evidence artifact as a code change', () => {
    const result = evaluateTerminalCriteria({
      itemKind: 'bug',
      status: 'done',
      filesChanged: ['/tmp/run.log'],
      treeStamp: {
        contentIdentity: [
          { path: '/tmp/run.log', workingTreeBlobSha: 'd'.repeat(40), outOfRepoArtifact: true },
        ],
      },
    });
    expect(result.ratings['durable-change'].rating).toBe('fail');
  });
});

/**
 * P-008 falsifiability guard.
 *
 * A guard test that has never failed is a guard nobody has tested. The control below is a
 * permanently-wrong evaluator kept IN this file — never an in-tree mutation of the real
 * module, because git-sync sweeps the whole working tree on a schedule and would commit
 * the mutant even if nothing went wrong.
 *
 * It proves the assertions above discriminate: a broken evaluator that admits everything
 * must FAIL the checks the real one passes. Without this, every assertion above would also
 * pass against an evaluator that did nothing at all.
 */
describe('falsifiability control', () => {
  const alwaysAdmits = (_input: TerminalCriteriaInput) => ({
    claimsRemediation: true,
    ratings: { 'durable-change': { rating: 'pass' as const, evidence: 'control: admits everything' } },
    wouldBlock: [] as const,
    verdict: 'pass' as const,
  });

  it('the real evaluator rejects what the always-admits control lets through', () => {
    expect(alwaysAdmits(closeNoEvidence).verdict).toBe('pass');
    expect(evaluateTerminalCriteria(closeNoEvidence).verdict).toBe('fail');

    expect(alwaysAdmits(closeNarratedCauseChangedNothing).verdict).toBe('pass');
    expect(evaluateTerminalCriteria(closeNarratedCauseChangedNothing).verdict).toBe('fail');
  });

  it('a refuse-everything control would also score 3/4 — which is why the admit case is asserted', () => {
    const alwaysRefuses = () => ({ verdict: 'fail' as const });
    expect(alwaysRefuses().verdict).toBe('fail');
    expect(evaluateTerminalCriteria(closeThatSurvived).verdict).toBe('pass');
  });
});

describe('resolveTerminalCriteria — criteria may only tighten (D-002)', () => {
  const cls: TerminalCriteriaDeclaration = {
    source: 'class',
    sourceRef: 'plan-class-bugfix',
    minProofFloor: 'l3',
    requireDurableChange: true,
    forbiddenEvidenceOnlyModes: ['already-passing'],
  };

  it('takes the max floor and the union of forbidden modes', () => {
    const resolved = resolveTerminalCriteria([
      cls,
      { source: 'item', sourceRef: 'EI-1', minProofFloor: 'l4', forbiddenEvidenceOnlyModes: ['manual'] },
    ]);
    expect(resolved.minProofFloor).toBe('l4');
    expect(resolved.requireDurableChange).toBe(true);
    expect(resolved.forbiddenEvidenceOnlyModes).toEqual(['alreadypassing', 'manual']);
    expect(resolved.sources).toEqual(['plan-class-bugfix', 'EI-1']);
  });

  it('a weakening declaration cannot pull the resolved floor down', () => {
    const resolved = resolveTerminalCriteria([
      cls,
      { source: 'item', sourceRef: 'EI-1', minProofFloor: 'none', requireDurableChange: false },
    ]);
    expect(resolved.minProofFloor).toBe('l3');
    expect(resolved.requireDurableChange).toBe(true);
  });

  it('is MONOTONIC: adding any declaration never lowers the effective floor', () => {
    const floors: ProofFloor[] = ['none', 'l3', 'l4'];
    const rank = { none: 0, l3: 1, l4: 2 } as const;
    for (const base of floors) {
      for (const added of floors) {
        const before = resolveTerminalCriteria([{ source: 'class', sourceRef: 'c', minProofFloor: base }]);
        const after = resolveTerminalCriteria([
          { source: 'class', sourceRef: 'c', minProofFloor: base },
          { source: 'item', sourceRef: 'i', minProofFloor: added },
        ]);
        expect(rank[after.minProofFloor]).toBeGreaterThanOrEqual(rank[before.minProofFloor]);
      }
    }
  });

  it('resolves an empty declaration set to the weakest floor rather than throwing', () => {
    expect(resolveTerminalCriteria([])).toMatchObject({
      minProofFloor: 'none',
      requireDurableChange: false,
      forbiddenEvidenceOnlyModes: [],
    });
  });
});

describe('refuseLoweringDeclaration — a silent drop and a typo look identical, so refuse', () => {
  const baseline = { requireDurableChange: true, minProofFloor: 'l3' as ProofFloor };

  it('refuses a floor below the baseline', () => {
    const reason = refuseLoweringDeclaration(
      { source: 'item', sourceRef: 'EI-1', minProofFloor: 'none' },
      baseline,
    );
    expect(reason).toContain('may only tighten');
  });

  it('refuses switching requireDurableChange off', () => {
    expect(
      refuseLoweringDeclaration({ source: 'item', sourceRef: 'EI-1', requireDurableChange: false }, baseline),
    ).toContain('requireDurableChange');
  });

  it('admits a tightening declaration, and an inheriting one', () => {
    expect(refuseLoweringDeclaration({ source: 'item', sourceRef: 'EI-1', minProofFloor: 'l4' }, baseline)).toBeNull();
    expect(refuseLoweringDeclaration({ source: 'item', sourceRef: 'EI-1' }, baseline)).toBeNull();
  });
});

describe('collectApplicableDeclarations — decision scope needs a plan (D-010)', () => {
  const decision: TerminalCriteriaDeclaration = { source: 'decision', sourceRef: 'some-plan#D-003', minProofFloor: 'l4' };
  const item: TerminalCriteriaDeclaration = { source: 'item', sourceRef: 'EI-1', minProofFloor: 'l3' };

  it('drops decision scope entirely when the item has no source plan', () => {
    const applicable = collectApplicableDeclarations({
      itemDeclaration: item,
      decisionDeclaration: decision,
      sourcePlanSlug: null,
    });
    expect(applicable.map((d) => d.sourceRef)).toEqual(['EI-1']);
    expect(resolveTerminalCriteria(applicable).minProofFloor).toBe('l3');
  });

  it('treats a blank slug as no plan rather than as a plan named ""', () => {
    expect(
      collectApplicableDeclarations({ decisionDeclaration: decision, sourcePlanSlug: '   ' }),
    ).toHaveLength(0);
  });

  it('applies decision scope when a source plan really exists', () => {
    const applicable = collectApplicableDeclarations({
      itemDeclaration: item,
      decisionDeclaration: decision,
      sourcePlanSlug: 'some-plan',
    });
    expect(resolveTerminalCriteria(applicable).minProofFloor).toBe('l4');
  });
});

/* -------------------------------------------------------------------------- *
 * P-006 — forbidden evidence-only modes (D-013, D-014).
 * -------------------------------------------------------------------------- */

/**
 * The residual this criterion actually buys. Measured (D-014): of the 835 closes stating
 * the bare token `already-passing`, 87 DECLARE changed paths — so they pass
 * `durable-change` and are invisible to it. Something landed; the only stated verification
 * is that pre-existing tests were already green.
 */
const closeLandedButOnlyAlreadyPassing: TerminalCriteriaInput = {
  ...closeThatSurvived,
  verifiedHow: 'already-passing',
};

describe('forbidden evidence-only modes (P-006)', () => {
  it('catches a close that LANDED code but states only already-passing — the case durable-change cannot see', () => {
    const result = evaluateTerminalCriteria(closeLandedButOnlyAlreadyPassing);
    expect(result.ratings['durable-change'].rating).toBe('pass');
    expect(result.ratings['forbidden-evidence-mode'].rating).toBe('fail');
    expect(result.wouldBlock).toEqual(['forbidden-evidence-mode']);
    expect(result.verdict).toBe('fail');
  });

  // The WONT_FIX bug, one criterion over: a hyphen-preserving or case-sensitive comparison
  // silently admits every one of these. Table-driven so a new spelling is one line.
  it.each([
    'already-passing',
    'ALREADY_PASSING',
    'Already Passing',
    'already passing',
    'already-passing.',
    '  already-passing  ',
    'AlreadyPassing',
  ])('folds the separator/case variant %j onto the forbidden key', (verifiedHow) => {
    const result = evaluateTerminalCriteria({ ...closeThatSurvived, verifiedHow });
    expect(result.ratings['forbidden-evidence-mode'].rating).toBe('fail');
  });

  /**
   * THE ANTI-OVER-FIRE GUARD, and the reason the rule is equality rather than substring.
   * These are the REAL values measured in the live population (D-014) — each occurred
   * exactly once, and each names a second, genuine verification beside the token. A
   * substring rule rates all of them `fail`, punishing precisely the closers who did more
   * and said so.
   */
  it.each([
    'already-passing; focused unit suite re-run at current HEAD after the ledger freshness warn',
    'already-passing + live database predicate reproduction',
    'already-passing source audit plus focused regression suite',
    'already-passing; live schema and rev47 resolution probes',
    'already-passing; current-source writer inspection plus focused unit tests',
    'already-passing; focused in-process proxy fixtures plus dev:pipeline_position',
    'already-passing: direct :3070 coord:presence found no live/ended owner row',
  ])('ADMITS the qualified real-world close %j — it named other verification', (verifiedHow) => {
    const result = evaluateTerminalCriteria({ ...closeThatSurvived, verifiedHow });
    expect(result.ratings['forbidden-evidence-mode'].rating).toBe('pass');
    expect(result.verdict).toBe('pass');
  });

  it('rates a close stating NO verifiedHow not-applicable, never fail', () => {
    // Requiring a verifiedHow at all is a DIFFERENT criterion. Failing here would smuggle
    // it in under this one and manufacture failures across the whole population.
    const result = evaluateTerminalCriteria({ ...closeThatSurvived, verifiedHow: null });
    expect(result.ratings['forbidden-evidence-mode'].rating).toBe('not-applicable');
    expect(result.verdict).toBe('pass');
  });

  it('rates a non-remediating close not-applicable even when it states the forbidden token', () => {
    const result = evaluateTerminalCriteria({
      itemKind: 'bug',
      status: 'done',
      terminalReason: 'WONT_FIX',
      verifiedHow: 'already-passing',
      filesChanged: [],
      treeStamp: null,
    });
    expect(result.claimsRemediation).toBe(false);
    expect(result.ratings['forbidden-evidence-mode'].rating).toBe('not-applicable');
    expect(result.verdict).toBe('pass');
  });

  it('is disabled by an empty forbidden set, and driven by the resolved set when supplied', () => {
    const off = evaluateTerminalCriteria({
      ...closeLandedButOnlyAlreadyPassing,
      forbiddenEvidenceOnlyModes: [],
    });
    expect(off.ratings['forbidden-evidence-mode'].rating).toBe('not-applicable');

    // A tightening declaration can forbid a mode the default set does not.
    const widened = evaluateTerminalCriteria({
      ...closeThatSurvived,
      verifiedHow: 'typecheck',
      forbiddenEvidenceOnlyModes: resolveTerminalCriteria([
        { source: 'item', sourceRef: 'EI-1', forbiddenEvidenceOnlyModes: ['typecheck'] },
      ]).forbiddenEvidenceOnlyModes,
    });
    expect(widened.ratings['forbidden-evidence-mode'].rating).toBe('fail');
  });

  it('applies to bug kind — D-013: rootCauseVerification reads a DISJOINT field and cannot cover this', () => {
    // D-011 would have exempted bugs on the premise that the live rootCause gate already
    // covers them. That gate tests the PRESENCE of completion.rootCauseVerification and
    // never reads verifiedHow, so a close carrying a valid contrastive record and this
    // token passes it untouched. Exempting bugs would leave the largest remediating kind
    // outside the only check that reaches the case.
    expect(DEFAULT_REMEDIATING_KINDS).toContain('bug');
    const result = evaluateTerminalCriteria({ ...closeLandedButOnlyAlreadyPassing, itemKind: 'bug' });
    expect(result.ratings['forbidden-evidence-mode'].rating).toBe('fail');
  });

  it('FALSIFIABILITY CONTROL: an honest close passes, so the criterion is not vacuously failing', () => {
    const honest = evaluateTerminalCriteria({
      ...closeThatSurvived,
      verifiedHow: 'unit+integration; added a regression test that fails without the change',
    });
    expect(honest.ratings['forbidden-evidence-mode'].rating).toBe('pass');
    expect(honest.wouldBlock).toEqual([]);
    expect(honest.verdict).toBe('pass');
  });
});

/* -------------------------------------------------------------------------- *
 * Close-time composition (P-007).
 * -------------------------------------------------------------------------- */

describe('readItemTerminalCriteriaDeclaration (P-007, D-010)', () => {
  it('reads a well-formed declaration out of work_items.payload', () => {
    const declaration = readItemTerminalCriteriaDeclaration(
      { ideaLifecycle: 'routed', terminalCriteria: { requireDurableChange: true, minProofFloor: 'l4' } },
      'EI-1',
    );
    expect(declaration).toEqual({
      source: 'item',
      sourceRef: 'EI-1',
      requireDurableChange: true,
      minProofFloor: 'l4',
    });
  });

  // payload is free-form JSON written by many callers and is not schema-bound. Every one of
  // these is a real shape a payload can hold; none may throw and none may coerce.
  it.each([
    ['null payload', null],
    ['a non-object payload', 'terminalCriteria'],
    ['an array payload', [{ terminalCriteria: { requireDurableChange: true } }]],
    ['a payload without the key', { ideaLifecycle: 'routed' }],
    ['a non-object declaration', { terminalCriteria: 'strict' }],
    ['an array declaration', { terminalCriteria: ['strict'] }],
    ['a declaration of only unrecognised fields', { terminalCriteria: { strictness: 'max' } }],
    ['an unrecognised floor', { terminalCriteria: { minProofFloor: 'l9' } }],
    ['a non-boolean requireDurableChange', { terminalCriteria: { requireDurableChange: 'yes' } }],
    ['an empty forbidden list', { terminalCriteria: { forbiddenEvidenceOnlyModes: [] } }],
    ['a forbidden list of non-strings', { terminalCriteria: { forbiddenEvidenceOnlyModes: [1, null] } }],
  ])('returns null for %s rather than coercing it', (_label, payload) => {
    expect(readItemTerminalCriteriaDeclaration(payload, 'EI-1')).toBeNull();
  });
});

describe('evaluateCloseTerminalCriteria (P-007)', () => {
  it('D-016: durable-change alone REPORTS but does not downgrade — it fails 48.1% of real defect closes', () => {
    // Measured 2026-09-05 over the 10,320 committed bug/change closes since 2026-08-17:
    // durable-change fails on 4,969 of them. A close can legitimately remediate and declare
    // no path, so a hard downgrade there would re-rate half the system's defect closes on an
    // assumption — the same assumption this module already refuses to make about `task`.
    const outcome = evaluateCloseTerminalCriteria({ ...closeNoEvidence, itemRef: 'EI-1' });
    expect(outcome.unmet).toContain('durable-change');
    expect(outcome.downgrading).not.toContain('durable-change');
    expect(outcome.downgrade).toBe(false);
    // It is still REPORTED — silence would be the other failure.
    expect(outcome.warning).toContain('durable-change');
    expect(outcome.warning).toContain('did NOT change the completion authority');
  });

  it('D-016: an explicit requireDurableChange opt-in turns that same close INTO a downgrade', () => {
    const outcome = evaluateCloseTerminalCriteria({
      ...closeNoEvidence,
      itemRef: 'EI-1',
      payload: { terminalCriteria: { requireDurableChange: true } },
    });
    expect(outcome.downgrading).toContain('durable-change');
    expect(outcome.downgrade).toBe(true);
    // D-003: the completion is recorded either way — the message must say so, because a
    // caller who reads "unmet" as "rejected" will re-send a close that already landed.
    expect(outcome.warning).toContain('RECORDED');
  });

  it('D-016: forbidden-evidence-mode downgrades BY DEFAULT — it is the measured discriminating case', () => {
    // 633 of the same 10,320 closes (6.1%), of which 74 landed code and are therefore
    // invisible to durable-change and to the content-identity stage alike.
    const outcome = evaluateCloseTerminalCriteria({
      ...closeThatSurvived,
      verifiedHow: 'already-passing',
      itemRef: 'EI-1',
    });
    expect(outcome.result.ratings['durable-change'].rating).toBe('pass');
    expect(outcome.downgrading).toEqual(['forbidden-evidence-mode']);
    expect(outcome.downgrade).toBe(true);
  });

  it('FALSIFIABILITY CONTROL: an honest close does not downgrade and carries no warning', () => {
    const outcome = evaluateCloseTerminalCriteria({
      ...closeThatSurvived,
      verifiedHow: 'unit+integration; added a regression test that fails without the change',
      itemRef: 'EI-1',
    });
    expect(outcome.downgrade).toBe(false);
    expect(outcome.unmet).toEqual([]);
    expect(outcome.warning).toBeUndefined();
  });

  it('D-015: an UNKNOWN rating does NOT downgrade — a measurement failure is not a closer failure', () => {
    // Declared paths but no observed tree stamp: durable-change rates `unknown`, which
    // `wouldBlock` includes and this stage deliberately does not act on.
    const outcome = evaluateCloseTerminalCriteria({
      itemKind: 'bug',
      status: 'done',
      filesChanged: ['packages/operator-core/lib/x.ts'],
      treeStamp: null,
      verifiedHow: 'unit',
      itemRef: 'EI-1',
    });
    expect(outcome.result.ratings['durable-change'].rating).toBe('unknown');
    expect(outcome.result.wouldBlock).toContain('durable-change');
    expect(outcome.downgrade).toBe(false);
    expect(outcome.warning).toBeUndefined();
  });

  it('an item declaration WIDENS requireDurableChange onto a kind outside the default set', () => {
    const base = { itemKind: 'task', status: 'done', filesChanged: [], treeStamp: null, itemRef: 'EI-1' };
    // `task` is deliberately outside DEFAULT_REMEDIATING_KINDS, so it is exempt by default.
    expect(evaluateCloseTerminalCriteria(base).downgrade).toBe(false);
    const declared = evaluateCloseTerminalCriteria({
      ...base,
      payload: { terminalCriteria: { requireDurableChange: true } },
    });
    expect(declared.resolved.requireDurableChange).toBe(true);
    expect(declared.downgrade).toBe(true);
    expect(declared.unmet).toContain('durable-change');
  });

  it('an item declaration TIGHTENS the forbidden set by union, never replacing the default', () => {
    const outcome = evaluateCloseTerminalCriteria({
      ...closeThatSurvived,
      verifiedHow: 'smoke-checked',
      payload: { terminalCriteria: { forbiddenEvidenceOnlyModes: ['smoke-checked'] } },
      itemRef: 'EI-1',
    });
    expect(outcome.resolved.forbiddenEvidenceOnlyModes).toEqual(
      expect.arrayContaining(['alreadypassing', 'smokechecked']),
    );
    expect(outcome.downgrade).toBe(true);
    expect(outcome.unmet).toEqual(['forbidden-evidence-mode']);
  });

  it('D-002: an item declaration cannot DISABLE the default forbidden mode by overriding it', () => {
    // The regression this pins: passing the resolved set straight through let a declaration
    // REPLACE the default rather than extend it, so declaring one unrelated mode silently
    // dropped `already-passing`. An override is the first thing an evasive closer writes.
    for (const declared of [[], ['smoke-checked'], ['manual']]) {
      const outcome = evaluateCloseTerminalCriteria({
        ...closeThatSurvived,
        verifiedHow: 'already-passing',
        payload: { terminalCriteria: { forbiddenEvidenceOnlyModes: declared } },
        itemRef: 'EI-1',
      });
      expect(outcome.result.ratings['forbidden-evidence-mode'].rating).toBe('fail');
      expect(outcome.downgrade).toBe(true);
    }
  });

  it('D-002: a LOWERING item declaration is refused and reported, never silently honoured', () => {
    const classDeclaration: TerminalCriteriaDeclaration = {
      source: 'class',
      sourceRef: 'class:defect',
      requireDurableChange: true,
      minProofFloor: 'l4',
    };
    const outcome = evaluateCloseTerminalCriteria({
      itemKind: 'task',
      status: 'done',
      filesChanged: [],
      treeStamp: null,
      itemRef: 'EI-1',
      classDeclaration,
      payload: { terminalCriteria: { requireDurableChange: false, minProofFloor: 'none' } },
    });
    expect(outcome.refusedDeclaration).toMatch(/only tighten/i);
    // The floor the class set still stands: the override neither applied nor weakened it.
    expect(outcome.resolved.requireDurableChange).toBe(true);
    expect(outcome.resolved.minProofFloor).toBe('l4');
    expect(outcome.downgrade).toBe(true);
  });

  it('D-010: decision-scope contributes nothing when the item has no source plan', () => {
    const decisionDeclaration: TerminalCriteriaDeclaration = {
      source: 'decision',
      sourceRef: 'some-plan#D-001',
      forbiddenEvidenceOnlyModes: ['manual'],
    };
    const withoutPlan = evaluateCloseTerminalCriteria({
      ...closeThatSurvived,
      verifiedHow: 'manual',
      decisionDeclaration,
      itemRef: 'EI-1',
    });
    expect(withoutPlan.resolved.sources).not.toContain('some-plan#D-001');
    expect(withoutPlan.downgrade).toBe(false);

    const withPlan = evaluateCloseTerminalCriteria({
      ...closeThatSurvived,
      verifiedHow: 'manual',
      decisionDeclaration,
      sourcePlanSlug: 'some-plan',
      itemRef: 'EI-1',
    });
    expect(withPlan.resolved.sources).toContain('some-plan#D-001');
    expect(withPlan.downgrade).toBe(true);
  });

  it('names the contributing criteria sources so a downgrade is attributable', () => {
    const outcome = evaluateCloseTerminalCriteria({
      itemKind: 'task',
      status: 'done',
      filesChanged: [],
      treeStamp: null,
      itemRef: 'EI-1',
      payload: { terminalCriteria: { requireDurableChange: true } },
    });
    expect(outcome.warning).toContain('EI-1');
  });

  it('is total: a hostile payload yields a verdict rather than throwing (D-003)', () => {
    const hostile = { terminalCriteria: { forbiddenEvidenceOnlyModes: 'already-passing' } };
    expect(() =>
      evaluateCloseTerminalCriteria({ ...closeThatSurvived, payload: hostile, itemRef: 'EI-1' }),
    ).not.toThrow();
  });

  it('a non-remediating disposition is exempt, so a wontfix close is never downgraded', () => {
    const outcome = evaluateCloseTerminalCriteria({
      itemKind: 'bug',
      status: 'done',
      terminalReason: 'WONT_FIX',
      filesChanged: [],
      treeStamp: null,
      verifiedHow: 'already-passing',
      itemRef: 'EI-1',
    });
    expect(outcome.downgrade).toBe(false);
    expect(outcome.result.claimsRemediation).toBe(false);
  });
});

/**
 * Plan `bug-queue-legitimacy-and-actionable-validation-2026-10-10`, D-011 ruling A
 * (SPEC-BQL-P-009-RECEIPT). The replayed close is EI-25318915268790777 as measured
 * 2026-10-11: a reproduction-validation bug closed `done` with authority `committed` by
 * shipping a fix, while its agent review still read revision-requested/reproduction. Every
 * OTHER criterion passes on that close — it declared real files and a real verification — so
 * only this criterion can tell it apart from an honest close.
 */
describe('reproduction-receipt criterion (D-011 A)', () => {
  const pendingReproduction = {
    agentReview: {
      status: 'revision-requested',
      revisionKind: 'reproduction',
      submittedBy: 'su-submitter',
      ledgerIdeaId: 'idea-1',
      round: 2,
    },
  };
  const honestFixClose = {
    ...closeThatSurvived,
    verifiedHow: 'unit+integration; added a regression test that fails without the change',
    itemRef: 'EI-25318915268790777',
  };

  it('DOWNGRADES a successful bug close that skipped the reproduction it was returned for', () => {
    const outcome = evaluateCloseTerminalCriteria({ ...honestFixClose, payload: pendingReproduction });
    expect(outcome.result.ratings['durable-change'].rating).toBe('pass');
    expect(outcome.result.ratings['forbidden-evidence-mode'].rating).toBe('pass');
    expect(outcome.result.ratings['reproduction-receipt'].rating).toBe('fail');
    expect(outcome.unmet).toEqual(['reproduction-receipt']);
    // Downgrading BY DEFAULT, unlike durable-change: no declaration is needed to enforce it.
    expect(outcome.downgrading).toEqual(['reproduction-receipt']);
    expect(outcome.downgrade).toBe(true);
  });

  it('the warning names BOTH legitimate exits and says the close is still recorded', () => {
    const outcome = evaluateCloseTerminalCriteria({ ...honestFixClose, payload: pendingReproduction });
    expect(outcome.warning).toContain('reproduction-receipt');
    expect(outcome.warning).toContain("improvements:agent-review { mode:'resubmit'");
    expect(outcome.warning).toContain("state:'dropped'");
    // D-003: downgrade, never refusal — a caller who reads "unmet" as "rejected" re-sends.
    expect(outcome.warning).toContain('RECORDED');
  });

  it('FALSIFIABILITY CONTROL: the same close with no pending reproduction is not downgraded', () => {
    for (const payload of [
      undefined,
      {},
      { agentReview: { ...pendingReproduction.agentReview, revisionKind: 'content' } },
      { agentReview: { ...pendingReproduction.agentReview, status: 'approved' } },
      { agentReview: { ...pendingReproduction.agentReview, status: 'pending' } },
    ]) {
      const outcome = evaluateCloseTerminalCriteria({ ...honestFixClose, payload });
      expect(outcome.result.ratings['reproduction-receipt'].rating).toBe('not-applicable');
      expect(outcome.downgrade).toBe(false);
      expect(outcome.warning).toBeUndefined();
    }
  });

  it("the 'not reproducible' exit is open: a dropped close of a pending bug is not-applicable", () => {
    const outcome = evaluateCloseTerminalCriteria({
      itemKind: 'bug',
      status: 'dropped',
      filesChanged: [],
      treeStamp: null,
      verifiedHow: 'ran the scripted repro on the current build; it does not reproduce',
      payload: pendingReproduction,
      itemRef: 'EI-1',
    });
    expect(outcome.result.ratings['reproduction-receipt'].rating).toBe('not-applicable');
    expect(outcome.downgrade).toBe(false);
  });

  it.each([
    ['a duplicate close (superseded by its survivor)', { terminalReason: 'duplicate' }],
    ['a not-reproducible disposition', { terminalReason: 'not-reproducible' }],
    ['a non-bug kind', { itemKind: 'change' }],
  ])('rates %s not-applicable', (_label, override) => {
    const outcome = evaluateCloseTerminalCriteria({ ...honestFixClose, ...override, payload: pendingReproduction });
    expect(outcome.result.ratings['reproduction-receipt'].rating).toBe('not-applicable');
    expect(outcome.downgrading).not.toContain('reproduction-receipt');
  });

  it('a requireDurableChange declaration widening the remediating kinds does NOT widen this criterion', () => {
    // Only `bug` rows carry the reproduction gate; widening durable-change onto `task` must
    // not drag a task with a stray review block into a reproduction requirement.
    const outcome = evaluateCloseTerminalCriteria({
      ...honestFixClose,
      itemKind: 'task',
      payload: { ...pendingReproduction, terminalCriteria: { requireDurableChange: true } },
    });
    expect(outcome.resolved.requireDurableChange).toBe(true);
    expect(outcome.result.ratings['reproduction-receipt'].rating).toBe('not-applicable');
  });

  it('may only TIGHTEN: an explicit false cannot wave a payload-pending row through', () => {
    const outcome = evaluateCloseTerminalCriteria({
      ...honestFixClose,
      reproductionValidationPending: false,
      payload: pendingReproduction,
    });
    expect(outcome.result.ratings['reproduction-receipt'].rating).toBe('fail');
    expect(outcome.downgrade).toBe(true);
  });

  it('the pure evaluator stands down when pending was not observed, and fails when it was', () => {
    const base: TerminalCriteriaInput = { ...closeThatSurvived, verifiedHow: 'unit' };
    expect(evaluateTerminalCriteria(base).ratings['reproduction-receipt'].rating).toBe('not-applicable');
    const pending = evaluateTerminalCriteria({ ...base, reproductionValidationPending: true });
    expect(pending.ratings['reproduction-receipt'].rating).toBe('fail');
    expect(pending.wouldBlock).toEqual(['reproduction-receipt']);
    expect(pending.verdict).toBe('fail');
  });
});
