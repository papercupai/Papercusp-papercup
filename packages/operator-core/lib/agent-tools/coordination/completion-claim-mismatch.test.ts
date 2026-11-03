import { describe, expect, it } from 'vitest';
import { completionClaimMismatch, COMPLETION_CLAIM_MISMATCH_FIELD } from './completion-claim-mismatch';

const read = (...refs: string[]) => refs.map((ref) => ({ ref }));

describe('completionClaimMismatch', () => {
  it('flags a named completed plan that is absent from the sender read trace', () => {
    expect(
      completionClaimMismatch({
        summary: 'completed plan:shipped-feature',
        basedOn: read('plan:unrelated-plan'),
      }),
    ).toEqual({
      kind: 'unread-artifact',
      declaredRefs: ['plan:shipped-feature'],
      missingFromBasedOn: ['plan:shipped-feature'],
      note: 'claims completion on artifacts absent from the recent read trace',
    });
  });

  it('does not mistake the routed parent plan for a verified draft artifact', () => {
    expect(completionClaimMismatch({
      summary: 'Continuing owned BG repair; need overlap/admission answer for derived generation plan',
      body: [{
        text: [
          'I recovered latest loop checkpoint and retained both claims.',
          'Draft bg-host-committed-generation-2026-10-24 has three dependent items for verified export/build, guarded atomic activation, and cohort acceptance.',
          'Current service 95 drop-in rebuilds mutable staging; bundle-host already accepts verifier receipts.',
          'I will repair the derived draft and pursue canonical activation under existing EI-26785152335918923. Please confirm any overlapping implementer or governing decision, and admit the derived plan to the fleet claim spec if its generated items require it.',
        ].join('\n'),
      }],
      planSlug: 'loop-rebase-critical-sweep-floor-2026-10-24',
      basedOn: read(
        'work-item:WI-6554700010025840',
        'plan:bg-host-committed-generation-2026-10-24',
        'work-item:EI-26785152335918923',
        'work-item:EI-26890541008406387',
        'work-item:EI-18752496371939475',
        'work-item:EI-26883864551800000',
        'work-item:EI-26881885626002938',
      ),
    })).toBeUndefined();
  });

  it('infers the routed plan only for a direct, affirmative plan-completion clause', () => {
    expect(completionClaimMismatch({
      summary: 'The plan is complete.',
      planSlug: 'loop-rebase-critical-sweep-floor-2026-10-24',
      basedOn: [],
    })).toMatchObject({
      declaredRefs: ['plan:loop-rebase-critical-sweep-floor-2026-10-24'],
      missingFromBasedOn: ['plan:loop-rebase-critical-sweep-floor-2026-10-24'],
    });

    expect(completionClaimMismatch({
      summary: 'The plan will be completed next wake.',
      planSlug: 'loop-rebase-critical-sweep-floor-2026-10-24',
      basedOn: [],
    })).toBeUndefined();
  });

  it('treats a rubric read as the matching persisted plan read', () => {
    expect(
      completionClaimMismatch({
        summary: 'graded rubric "acceptance-rubric" and shipped the result',
        basedOn: read('plan:acceptance-rubric'),
      }),
    ).toBeUndefined();
  });

  it('collects explicit work-item and plan premises from structured message sections', () => {
    expect(
      completionClaimMismatch({
        summary: 'verified the delivery',
        body: [
          {
            text: 'The acceptance is complete.',
            premises: ['WI-2045#completion', 'release-plan#D-004'],
          },
        ],
        basedOn: read('work-item:WI-2045'),
      }),
    ).toMatchObject({
      declaredRefs: ['work-item:WI-2045', 'plan:release-plan'],
      missingFromBasedOn: ['plan:release-plan'],
    });
  });

  it('does not stamp negated completion claims or unnamed completion prose', () => {
    expect(
      completionClaimMismatch({
        summary: 'did not complete plan:shipped-feature',
        basedOn: [],
      }),
    ).toBeUndefined();
    expect(
      completionClaimMismatch({
        summary: 'the completion check is still pending',
        basedOn: [],
      }),
    ).toBeUndefined();
  });

  it('ignores future and modal intent refs while retaining past completion refs', () => {
    expect(
      completionClaimMismatch({
        summary: 'completed WI-2045; will read WI-2046, will reconcile WI-2047, and next I will inspect WI-2048',
        basedOn: read('work-item:WI-2045'),
      }),
    ).toBeUndefined();

    expect(
      completionClaimMismatch({
        summary: 'completed WI-2045; next I will inspect WI-2046; have verified WI-2047',
        basedOn: read('work-item:WI-2045'),
      }),
    ).toMatchObject({
      declaredRefs: ['work-item:WI-2045', 'work-item:WI-2047'],
      missingFromBasedOn: ['work-item:WI-2047'],
    });
  });

  it('ignores read-only reconciliation refs in a prospective unit hand-off', () => {
    expect(
      completionClaimMismatch({
        summary: 'Accepted WI-42228 investigate-only gate',
        body: [
          {
            text: 'I am limiting this unit to fresh read-only reconciliation of WI-212675, then checkpointing WI-42228.',
          },
        ],
        basedOn: read('work-item:WI-42228'),
      }),
    ).toBeUndefined();
  });

  it('does not attach a verified source claim to a pending tool-operation target', () => {
    const report = 'Under owned WI45036 / parent WI19918 I freshly verified D103 core containment in staging faf4c4b4fa and called only scorecards:repair target EI-27699140584578252. Tool returned resource_exclusive_pending before dispatch; your staging-server reservation is exclusive/draining. What exact completion event should my registered leader continuation await before retrying this one repair? Keep your existing resource operation; I will not bypass it.';

    expect(completionClaimMismatch({
      summary: 'Exact audit repair refused while your staging-server exclusive reservation drains',
      body: report,
      goalRef: 'WI-6554700010045036',
      basedOn: read(
        'work-item:EI-27667223632942599',
        'work-item:WI-6554700010045036',
        'plan:green-main-cycle-time-2026-10-08',
        'work-item:WI-6554700010019918',
      ),
    })).toBeUndefined();

    expect(completionClaimMismatch({
      summary: 'Verified EI-27699140584578252 after the repair.',
      basedOn: [],
    })).toMatchObject({
      missingFromBasedOn: ['work-item:EI-27699140584578252'],
    });
  });

  it('exports the stable envelope field name used by the send seam', () => {
    expect(COMPLETION_CLAIM_MISMATCH_FIELD).toBe('completionClaimMismatch');
  });

  it.each(['plain', 'structured'])('does not claim completion of pending owner asks in a %s GOAL report', (format) => {
    const lines = [
      'MOVED: loop armed; D-011 custody kept; no fleet launched.',
      'COST: unknown; coverage=no-ceiling; source=goal-lineage-rollup',
      'OWNER-WALLED: WI-10004856 register Cupboard GitHub App/set3secrets; WI-10004875 approve Worker+D1(035-043) deploy or rescope; WI-10005042 approve request/USD cap for paid quality+cache run or decline.',
      'KILLED: none this pass; historical coverage truncated.',
      'NEXT WAKE: 60s warm work loop; guarantee verified.',
    ];
    expect(completionClaimMismatch({
      summary: 'Goal work-on-everything-fresh-grading-and-improvement-60d3a8 — report',
      body: format === 'plain' ? lines.join('\n') : lines.map((text) => ({ text })),
      basedOn: read(...Array.from({ length: 8 }, (_, i) => 'work-item:WI-' + (9000 + i))),
    })).toBeUndefined();
  });

  it('associates completion with its own statement rather than pending subjects elsewhere', () => {
    expect(completionClaimMismatch({
      summary: 'Completed WI-2045; WI-2046 awaits owner approval.',
      body: [{ text: 'OWNER-WALLED: WI-2047 approve the deployment.' }, { text: 'NEXT WAKE: guarantee verified.' }],
      basedOn: [],
    })).toMatchObject({ declaredRefs: ['work-item:WI-2045'], missingFromBasedOn: ['work-item:WI-2045'] });
  });

  it('keeps a real unread completion claim under an owner-wall label', () => {
    expect(completionClaimMismatch({
      body: [{ text: 'OWNER-WALLED: WI-2045 completed after owner approval.' }],
      basedOn: [],
    })).toMatchObject({ missingFromBasedOn: ['work-item:WI-2045'] });
  });

  it('ignores negated and future completion even when the subject comes first', () => {
    expect(completionClaimMismatch({
      summary: 'Completed WI-2045; WI-2046 has not been completed; WI-2047 will be completed.',
      basedOn: read('work-item:WI-2045'),
    })).toBeUndefined();
  });

  it('does not turn a shortened issue id in a log filename into a completion subject', () => {
    expect(completionClaimMismatch({
      summary: 'Real-DB holder fixture/control suite26PASS0skip; repaired fixture prerequisites now verified, changed isolated native7 starting.',
      body: 'Terminal /tmp/ei-251616-holder-fixture-green3.log exit0 proves actual holder election/liveness. Native7 will verify the same named query.',
      basedOn: read('work-item:EI-25161673334137018'),
    })).toBeUndefined();
  });

  it.each(['diag-EI-251616-unlabeled', 'EI-251616-holder-fixture.log', 'fixture_EI-251616_log'])('ignores identifier fragments in %s', (filename) => {
    expect(completionClaimMismatch({
      summary: `Verified fixture evidence in ${filename}`,
      basedOn: [],
    })).toBeUndefined();
  });

  it('still detects an unread exact short id beside a log filename and a longer read id', () => {
    expect(completionClaimMismatch({
      summary: 'Verified EI-251616; evidence /tmp/ei-251616-holder-fixture.log',
      basedOn: read('work-item:EI-25161673334137018'),
    })).toMatchObject({
      declaredRefs: ['work-item:EI-251616'],
      missingFromBasedOn: ['work-item:EI-251616'],
    });
  });

  it('uses a matching structured goal read to resolve an abbreviated completion id', () => {
    const goalRef = 'EI-26250875597402287';
    expect(completionClaimMismatch({
      goalRef,
      summary: 'EI-262 source fix and regression verified; R-4 and deferred wake item remain open (part 2/2)',
      basedOn: read(`work-item:${goalRef}`),
    })).toBeUndefined();
  });

  it('does not use an unread or unrelated goal to resolve an abbreviated completion id', () => {
    expect(completionClaimMismatch({
      goalRef: 'EI-26250875597402287',
      summary: 'Verified EI-262 source fix.',
      basedOn: read('work-item:EI-26250875597402288'),
    })).toMatchObject({ missingFromBasedOn: ['work-item:EI-262'] });
  });
});
