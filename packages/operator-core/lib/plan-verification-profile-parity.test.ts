/**
 * R-3 (plan-verification-profiles-2026-10-17): routing the six non-code exemptions
 * through the resolver changes no verdict.
 *
 * Each `legacy*` oracle below is the pre-P-001 expression, copied verbatim and frozen
 * here. Every routed implementation must agree with its oracle on (a) the fixtures the
 * existing ship-gate suites use (plan-acceptance-gate.test.ts,
 * plan-requirement-realization.test.ts, spec-test-adequacy.test.ts) and (b) an
 * exhaustive grid of the inputs each exemption reads. Those existing suites still run
 * unchanged and stay the end-to-end parity evidence for the gates themselves.
 */
import { describe, expect, it } from 'vitest';
import {
  executableProofExemption,
  isNonAutomatedBehaviorClass,
  isNonCodeAuditVerdict,
  isNonCodeWorkItemKind,
  isReasonedNonCodeAudit,
  unfinishedItemsAreAuditedNonCode,
} from './plan-verification-profile';
import { deriveNonCodeExemptionProofs } from './plan-requirement-realization';
import { AUDIT_VERDICTS, type PlanItemStatus } from './plan-audits';
import { PLAN_CLASS_RUBRIC_REFS, requiredProofFloor } from './agent-tools/plans/spec-test-adequacy';
import { validExplicitExemption } from './agent-tools/plans/spec-quality';
import {
  SPEC_BEHAVIOR_CLASSES,
  SPEC_LIFECYCLE_STATUSES,
  type SpecClauseRevision,
} from './agent-tools/plans/spec-clauses-store';

// ---- frozen pre-P-001 oracles (verbatim) ----

function legacyIsNonCodeWorkItemKind(kind: string | null | undefined): boolean {
  return typeof kind === 'string' && kind.trim().toLowerCase() === 'task';
}

/** The first two lines of the pre-P-001 requiredProofFloor. */
function legacyFloorExempt(
  clause: Pick<SpecClauseRevision, 'behaviorClass' | 'requiredTestLayers'>,
  workItemKind?: string | null,
): boolean {
  if (legacyIsNonCodeWorkItemKind(workItemKind)) return true;
  if (clause.behaviorClass === 'non-automated' && clause.requiredTestLayers.length === 0) return true;
  return false;
}

function legacyUnfinishedItemsAreAuditedNonCode(
  unfinished: readonly { itemId: string }[],
  effectiveAudits: readonly { entry: { itemId: string; verdict: string } }[],
): boolean {
  if (unfinished.length === 0) return false;
  const verdictByItem = new Map(effectiveAudits.map(({ entry }) => [entry.itemId, entry.verdict]));
  return unfinished.every((item) => verdictByItem.get(item.itemId) === 'not-code');
}

/** plan-acceptance-gate.ts realization selector and plan-requirement-realization.ts:418. */
function legacyReasonedNonCode(entry: { verdict: string; note?: string } | undefined): boolean {
  return entry?.verdict === 'not-code' && Boolean(entry?.note?.trim());
}

function legacyTrimmedField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function legacyValidExplicitExemption(clause: SpecClauseRevision): boolean {
  if (clause.lifecycleStatus !== 'exempt' || clause.behaviorClass !== 'non-automated') return false;
  const exemption = clause.exemption;
  if (!exemption || typeof exemption !== 'object' || Array.isArray(exemption)) return false;
  return Boolean(legacyTrimmedField(exemption.justification) && legacyTrimmedField(exemption.provenance));
}

// ---- fixtures, mirroring the existing ship-gate suites ----

const KINDS = ['task', ' TASK ', 'Task', 'tasks', 'bug', 'change', 'feature', 'research', '', null, undefined];
const ODD_CLASSES = ['Non-Automated', 'non_automated', '', null, undefined] as const;
const LAYER_SETS: string[][] = [[], ['unit'], ['unit', 'integration']];

const clause = (over: Partial<SpecClauseRevision> = {}): SpecClauseRevision => ({
  planSlug: 'inventory-plan', specId: 'P-001-consolidation-exempt', planItemId: 'P-001',
  sourceValId: null, sourceBar: null, currentRevision: 1, revision: 1,
  behavior: 'Each legacy request is disposed or assigned to a named owner.',
  behaviorClass: 'non-automated', lifecycleStatus: 'exempt',
  requiredEvidence: [], requiredTestLayers: [], mutationRequired: false, falsifier: null,
  exemption: { justification: 'Ledger bookkeeping changes no product behavior.', provenance: 'owner directive 1691' },
  supersedes: null, contentHash: 'a'.repeat(64), createdBy: 'author', createdAt: '2026-10-11T00:00:00Z',
  acceptedBy: null, acceptedAt: null, acceptanceRef: null, ...over,
});

describe('exemption 1 and 6: not-code audit verdict', () => {
  it('isNonCodeAuditVerdict matches the literal comparison for every audit verdict', () => {
    for (const verdict of [...AUDIT_VERDICTS, 'Not-Code', '', null, undefined]) {
      expect(isNonCodeAuditVerdict(verdict), String(verdict)).toBe(verdict === 'not-code');
    }
  });

  it('isReasonedNonCodeAudit matches the realization selector for every verdict and note', () => {
    for (const verdict of [...AUDIT_VERDICTS, 'Not-Code']) {
      for (const note of [undefined, '', '   ', 'a doc, not source', ' x ']) {
        const entry = note === undefined ? { verdict } : { verdict, note };
        expect(isReasonedNonCodeAudit(entry), `${verdict}/${String(note)}`).toBe(legacyReasonedNonCode(entry));
      }
    }
    expect(isReasonedNonCodeAudit(undefined)).toBe(legacyReasonedNonCode(undefined));
  });
});

describe('exemption 2 and 3: the executable-proof floor', () => {
  it('isNonCodeWorkItemKind matches the moved function for every kind', () => {
    for (const kind of KINDS) expect(isNonCodeWorkItemKind(kind), String(kind)).toBe(legacyIsNonCodeWorkItemKind(kind));
  });

  it('isNonAutomatedBehaviorClass matches the literal comparison for every behaviour class', () => {
    for (const cls of [...SPEC_BEHAVIOR_CLASSES, ...ODD_CLASSES]) {
      expect(isNonAutomatedBehaviorClass(cls), String(cls)).toBe(cls === 'non-automated');
    }
  });

  it('the membership rewrite in acceptance-bar-amendment matches the array form', () => {
    for (const cls of [...SPEC_BEHAVIOR_CLASSES, 'happy-path', 'custom']) {
      expect(cls !== 'happy-path' && !isNonAutomatedBehaviorClass(cls), cls)
        .toBe(!['happy-path', 'non-automated'].includes(cls));
    }
  });

  it('executableProofExemption and requiredProofFloor agree with the legacy floor exemption on the full grid', () => {
    let cells = 0;
    for (const behaviorClass of SPEC_BEHAVIOR_CLASSES) {
      for (const requiredTestLayers of LAYER_SETS) {
        for (const mutationRequired of [false, true]) {
          for (const workItemKind of KINDS) {
            const c = clause({ behaviorClass, requiredTestLayers: requiredTestLayers as never, mutationRequired });
            const legacy = legacyFloorExempt(c, workItemKind);
            expect(executableProofExemption({ workItemKind, behaviorClass, requiredTestLayers }) !== null).toBe(legacy);
            for (const classRef of PLAN_CLASS_RUBRIC_REFS) {
              const floor = requiredProofFloor(c, classRef, workItemKind);
              if (legacy) expect(floor).toBe('none');
              // Outside the exemption the kind never mattered: the floor equals the non-task floor.
              else expect(floor).toBe(requiredProofFloor(c, classRef, 'bug'));
              cells += 1;
            }
          }
        }
      }
    }
    expect(cells).toBe(SPEC_BEHAVIOR_CLASSES.length * LAYER_SETS.length * 2 * KINDS.length * PLAN_CLASS_RUBRIC_REFS.length);
  });
});

describe('exemption 5: the grading-recruitment unfinished-item exception', () => {
  // The fixtures of plan-acceptance-gate.test.ts › grading-recruitment unfinished-item exception.
  const unfinished = [{ itemId: 'P-011' }];
  const fixtures: Array<[string, { itemId: string }[], { entry: { itemId: string; verdict: string } }[]]> = [
    ['admits an all-not-code tail', unfinished, [{ entry: { itemId: 'P-011', verdict: 'not-code' } }]],
    ['missing audit', unfinished, []],
    ['implemented audit', unfinished, [{ entry: { itemId: 'P-011', verdict: 'implemented' } }]],
    ['mixed tail', [...unfinished, { itemId: 'P-010' }], [
      { entry: { itemId: 'P-011', verdict: 'not-code' } },
      { entry: { itemId: 'P-010', verdict: 'partial' } },
    ]],
    ['no unfinished items', [], []],
  ];

  it.each(fixtures)('%s keeps its verdict', (_label, items, audits) => {
    expect(unfinishedItemsAreAuditedNonCode(items, audits)).toBe(legacyUnfinishedItemsAreAuditedNonCode(items, audits));
  });

  it('agrees on every two-item tail across all audit verdicts', () => {
    const verdicts = [...AUDIT_VERDICTS, null];
    for (const a of verdicts) {
      for (const b of verdicts) {
        const items = [{ itemId: 'P-001' }, { itemId: 'P-002' }];
        const audits = [
          ...(a ? [{ entry: { itemId: 'P-001', verdict: a } }] : []),
          ...(b ? [{ entry: { itemId: 'P-002', verdict: b } }] : []),
        ];
        expect(unfinishedItemsAreAuditedNonCode(items, audits)).toBe(legacyUnfinishedItemsAreAuditedNonCode(items, audits));
      }
    }
  });
});

describe('exemption 6: explicit non-code exemption proofs in requirement realization', () => {
  const exemptions = [
    null,
    { justification: 'Ledger bookkeeping changes no product behavior.', provenance: 'owner directive 1691' },
    { justification: '   ', provenance: 'owner directive 1691' },
    { justification: 'Ledger bookkeeping changes no product behavior.' },
  ];

  it('validExplicitExemption matches the legacy body on every lifecycle x class x exemption cell', () => {
    for (const lifecycleStatus of SPEC_LIFECYCLE_STATUSES) {
      for (const behaviorClass of SPEC_BEHAVIOR_CLASSES) {
        for (const exemption of exemptions) {
          const c = clause({ lifecycleStatus, behaviorClass, exemption: exemption as never });
          expect(validExplicitExemption(c), `${lifecycleStatus}/${behaviorClass}`).toBe(legacyValidExplicitExemption(c));
        }
      }
    }
  });

  it('deriveNonCodeExemptionProofs keeps its verdict on the plan-requirement-realization fixtures', () => {
    const items: PlanItemStatus[] = [{ itemId: 'P-001', status: 'done', itemText: 'Consolidate legacy requests' } as PlanItemStatus];
    const variants: SpecClauseRevision[][] = [
      [clause()],
      [clause({ behaviorClass: 'failure' })],
      [clause({ lifecycleStatus: 'active' })],
      [clause({ requiredTestLayers: ['unit'] as never })],
      [clause(), clause({ specId: 'P-001-runtime', behaviorClass: 'failure', lifecycleStatus: 'active' })],
    ];
    const expected = [true, false, false, false, false];
    variants.forEach((clauses, index) => {
      const proofs = deriveNonCodeExemptionProofs({ planSlug: 'inventory-plan', clauses, planItems: items });
      // Legacy rule: every current clause of the done item is a valid explicit exemption with no proof demand.
      const legacy = clauses.every((c) => legacyValidExplicitExemption(c) && c.requiredTestLayers.length === 0);
      expect(proofs.length > 0, `variant ${index}`).toBe(legacy);
      expect(proofs.length > 0, `variant ${index}`).toBe(expected[index]);
    });
  });
});
