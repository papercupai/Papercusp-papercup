/**
 * P-014: the activation↔completion audit join. See ./plan-requirement-realization.ts.
 *
 * The two exemption rules (non-item targets, non-realizing dispositions) are the
 * dangerous half of this judge: each one makes the gate PASS, so a bug in either is
 * invisible in production and shows up only as a plan that shipped unproven. They
 * get explicit both-directions coverage rather than a single happy-path case.
 */
import { describe, it, expect } from 'vitest';
import {
  judgeRequirementRealization,
  deriveNonCodeExemptionProofs,
  describeUnrealized,
  describeExemptMapping,
  describeDroppedTarget,
  type RequirementRealizationInput,
} from './plan-requirement-realization';
import type {
  ActivationAuditMapping,
  AuditCitation,
  EffectiveItemAudit,
  PlanItemStatus,
} from './plan-audits';
import type { SpecClauseRevision } from './agent-tools/plans/spec-clauses-store';

const mapping = (over: Partial<ActivationAuditMapping> = {}): ActivationAuditMapping => ({
  id: 'M-001',
  sourceRefs: ['session_turn:owner:s1:12'],
  requirement: 'the gate must refuse an unproven requirement',
  planTargets: ['P-001'],
  disposition: 'covered',
  ...over,
});

const itemAudit = (itemId: string, citations: AuditCitation[]): EffectiveItemAudit => ({
  auditSeq: 1,
  entry: { itemId, verdict: 'implemented', citations },
});

const CODE: AuditCitation = { kind: 'code', path: 'packages/operator-core/lib/x.ts' };
const TEST: AuditCitation = { kind: 'test', path: 'packages/operator-core/lib/x.test.ts' };
const DOC: AuditCitation = { kind: 'doc', ref: 'internal/docs/x', reason: 'design note' };
const NONE: AuditCitation = { kind: 'none', reason: 'investigation only' };

const judge = (i: RequirementRealizationInput) => judgeRequirementRealization(i);

const inventoryClause = (over: Partial<SpecClauseRevision> = {}): SpecClauseRevision => ({
  planSlug: 'inventory-plan', specId: 'P-001-consolidation-exempt', planItemId: 'P-001',
  sourceValId: null, sourceBar: null, currentRevision: 1, revision: 1,
  behavior: 'Each legacy request is disposed or assigned to a named owner.',
  behaviorClass: 'non-automated', lifecycleStatus: 'exempt',
  requiredEvidence: [], requiredTestLayers: [], mutationRequired: false, falsifier: null,
  exemption: { justification: 'Ledger bookkeeping changes no product behavior.', provenance: 'owner directive 1691' },
  supersedes: null, contentHash: 'a'.repeat(64), createdBy: 'author', createdAt: '2026-10-11T00:00:00Z',
  acceptedBy: null, acceptedAt: null, acceptanceRef: null, ...over,
});

describe('explicit non-code exemption realization', () => {
  const items = [{ itemId: 'P-001', status: 'done', itemText: 'Consolidate legacy requests' }];
  const prove = (clauses: SpecClauseRevision[], planItems = items) => deriveNonCodeExemptionProofs({
    planSlug: 'inventory-plan', clauses, planItems,
  });
  const audit = () => ({ auditSeq: 1, entry: {
    itemId: 'P-001', verdict: 'not-code' as const, citations: [NONE],
    note: 'Completed census: every request is disposed or assigned; completion record names the population.',
  } });
  it('realizes a completed, audited inventory using its explicit exemption without an invented BAR', () => {
    const proofs = prove([inventoryClause()]);
    expect(proofs).toEqual([{ planItemId: 'P-001', barKeys: [], evidenceRefs: [],
      exemptionRefs: [`inventory-plan#P-001-consolidation-exempt@1:${'a'.repeat(64)}`] }]);
    expect(judge({ mappings: [mapping()], itemAudits: [audit()], planItems: items,
      nonCodeItemProofs: proofs }).ok).toBe(true);
    expect(judge({ mappings: [mapping()], itemAudits: [audit()], planItems: items }).ok).toBe(false);
  });
  it.each([
    ['no clause', []],
    ['wrong plan', [inventoryClause({ planSlug: 'other-plan' })]],
    ['wrong item', [inventoryClause({ planItemId: 'P-002' })]],
    ['stale revision', [inventoryClause({ currentRevision: 2 })]],
    ['missing provenance', [inventoryClause({ exemption: { justification: 'Ledger work' } })]],
    ['blank justification', [inventoryClause({ exemption: { justification: ' ', provenance: 'owner' } })]],
    ['behavioral class', [inventoryClause({ behaviorClass: 'happy-path' })]],
    ['draft', [inventoryClause({ lifecycleStatus: 'draft' })]],
    ['requires tests', [inventoryClause({ requiredTestLayers: ['unit'] })]],
    ['requires evidence', [inventoryClause({ requiredEvidence: ['test'] })]],
    ['requires mutation', [inventoryClause({ mutationRequired: true })]],
    ['declared falsifier', [inventoryClause({ falsifier: { observation: 'Product behavior failed' } })]],
    ['active sibling', [inventoryClause(), inventoryClause({ specId: 'behavior', lifecycleStatus: 'active' })]],
    ['draft sibling', [inventoryClause(), inventoryClause({ specId: 'behavior', lifecycleStatus: 'draft' })]],
  ] as const)('does not exempt %s', (_label, clauses) => {
    expect(prove([...clauses])).toEqual([]);
  });
  it.each(['wip', 'dropped'])('does not realize an item whose status is %s', (status) => {
    expect(prove([inventoryClause()], [{ ...items[0], status }])).toEqual([]);
  });
  it('still requires a reasoned not-code completion audit', () => {
    const proofs = prove([inventoryClause()]);
    for (const itemAudits of [[], [itemAudit('P-001', [DOC])], [{ ...audit(), entry: { ...audit().entry, note: '' } }]]) {
      expect(judge({ mappings: [mapping()], itemAudits, planItems: items, nonCodeItemProofs: proofs }).ok).toBe(false);
    }
  });
});

describe('judgeRequirementRealization', () => {
  it('realizes a completed, reasoned non-code outcome with exact current BAR proof', () => {
    const audit = itemAudit('P-001', [DOC]);
    audit.entry.verdict = 'not-code';
    audit.entry.note = 'The deliverable is verified operational behavior, not new source.';
    const v = judge({
      mappings: [mapping()],
      itemAudits: [audit],
      planItems: [{ itemId: 'P-001', status: 'done', itemText: 'Verify the live outcome' }],
      nonCodeItemProofs: [{ planItemId: 'P-001', barKeys: ['R-1'], evidenceRefs: ['probe:current'] }],
    });
    expect(v.ok).toBe(true);
    expect(v.unrealized).toEqual([]);
  });

  it.each(['implemented', 'missing', 'partial', 'dropped'] as const)(
    'does not use operational proof to excuse an audit verdict of %s', (verdict) => {
      const audit = itemAudit('P-001', [DOC]);
      audit.entry.verdict = verdict;
      audit.entry.note = 'A document claiming the work is finished.';
      expect(judge({ mappings: [mapping()], itemAudits: [audit],
        planItems: [{ itemId: 'P-001', status: 'done', itemText: 'The outcome' }],
        nonCodeItemProofs: [{ planItemId: 'P-001', barKeys: ['R-1'], evidenceRefs: ['probe:current'] }],
      }).ok).toBe(false);
    },
  );

  it.each(['missing proof', 'wrong target', 'missing reason', 'unfinished', 'dropped', 'unknown items'])(
    'keeps a not-code outcome unproven with %s', (gap) => {
      const audit = itemAudit('P-001', [NONE]);
      audit.entry.verdict = 'not-code';
      audit.entry.note = gap === 'missing reason' ? '' : 'Verified live behavior.';
      expect(judge({ mappings: [mapping()], itemAudits: [audit],
        planItems: gap === 'unknown items' ? [] : [{ itemId: 'P-001',
          status: gap === 'unfinished' ? 'wip' : gap === 'dropped' ? 'dropped' : 'done', itemText: 'The outcome' }],
        nonCodeItemProofs: gap === 'missing proof' ? [] : [{
          planItemId: gap === 'wrong target' ? 'P-002' : 'P-001', barKeys: ['R-1'], evidenceRefs: ['probe:current'],
        }],
      }).ok).toBe(false);
    },
  );

  describe('the violations it must catch', () => {
    it('catches a covered requirement whose target has NO item audit', () => {
      const v = judge({ mappings: [mapping()], itemAudits: [] });
      expect(v.ok).toBe(false);
      expect(v.unrealized).toHaveLength(1);
      expect(v.unrealized[0]?.reason).toBe('no-item-audit');
      expect(v.unrealized[0]?.planTarget).toBe('P-001');
    });

    it('catches a covered requirement audited with only a doc citation (D-008)', () => {
      const v = judge({ mappings: [mapping()], itemAudits: [itemAudit('P-001', [DOC])] });
      expect(v.ok).toBe(false);
      expect(v.unrealized[0]?.reason).toBe('no-verifying-citation');
    });

    it("catches `none` citations too — the honest escape is still not verification", () => {
      const v = judge({ mappings: [mapping()], itemAudits: [itemAudit('P-001', [NONE])] });
      expect(v.ok).toBe(false);
      expect(v.unrealized[0]?.reason).toBe('no-verifying-citation');
    });

    it('catches a `repaired` mapping, not just `covered`', () => {
      const v = judge({
        mappings: [mapping({ disposition: 'repaired' })],
        itemAudits: [itemAudit('P-001', [DOC])],
      });
      expect(v.ok).toBe(false);
      expect(v.unrealized[0]?.disposition).toBe('repaired');
    });

    it('reports EVERY failing target of a multi-target mapping, not just the first', () => {
      const v = judge({
        mappings: [mapping({ planTargets: ['P-001', 'P-002', 'P-003'] })],
        itemAudits: [itemAudit('P-002', [CODE])],
      });
      expect(v.ok).toBe(false);
      expect(v.unrealized.map((u) => u.planTarget)).toEqual(['P-001', 'P-003']);
      expect(v.checkedTargets).toBe(3);
    });
  });

  describe('the exemptions — each one makes the gate PASS, so both directions matter', () => {
    it('passes when a verifying code citation backs the target', () => {
      const v = judge({ mappings: [mapping()], itemAudits: [itemAudit('P-001', [CODE])] });
      expect(v.ok).toBe(true);
      expect(v.checkedTargets).toBe(1);
    });

    it('accepts a test citation as verification', () => {
      const v = judge({ mappings: [mapping()], itemAudits: [itemAudit('P-001', [TEST])] });
      expect(v.ok).toBe(true);
    });

    it('accepts a mix so long as at least one citation verifies', () => {
      const v = judge({ mappings: [mapping()], itemAudits: [itemAudit('P-001', [DOC, NONE, CODE])] });
      expect(v.ok).toBe(true);
    });

    it('SKIPS D-NNN targets — decisions have no completion-audit counterpart', () => {
      const v = judge({ mappings: [mapping({ planTargets: ['D-004'] })], itemAudits: [] });
      expect(v.ok).toBe(true);
      expect(v.skippedTargets).toEqual(['D-004']);
      expect(v.checkedTargets).toBe(0);
    });

    it('SKIPS section: targets', () => {
      const v = judge({ mappings: [mapping({ planTargets: ['section:Risks'] })], itemAudits: [] });
      expect(v.ok).toBe(true);
      expect(v.skippedTargets).toEqual(['section:Risks']);
    });

    it('still judges the P-NNN targets of a mapping that ALSO has exempt ones', () => {
      const v = judge({
        mappings: [mapping({ planTargets: ['D-004', 'P-001', 'section:Risks'] })],
        itemAudits: [],
      });
      expect(v.ok).toBe(false);
      expect(v.checkedTargets).toBe(1);
      expect(v.skippedTargets).toEqual(['D-004', 'section:Risks']);
    });

    it('ignores `rejected` and `open` — they claim no absorption, so they owe no evidence', () => {
      const v = judge({
        mappings: [
          mapping({ id: 'M-001', disposition: 'rejected' }),
          mapping({ id: 'M-002', disposition: 'open' }),
        ],
        itemAudits: [],
      });
      expect(v.ok).toBe(true);
      expect(v.checkedTargets).toBe(0);
    });

    it('is vacuously ok with no mappings at all', () => {
      const v = judge({ mappings: [], itemAudits: [] });
      expect(v.ok).toBe(true);
      expect(v.checkedTargets).toBe(0);
    });
  });

  describe('robustness', () => {
    it('tolerates whitespace around a target id', () => {
      const v = judge({ mappings: [mapping({ planTargets: ['  P-001  '] })], itemAudits: [] });
      expect(v.ok).toBe(false);
      expect(v.unrealized[0]?.planTarget).toBe('P-001');
    });

    it('does not treat a P-NNN-ish string as a plan item', () => {
      const v = judge({ mappings: [mapping({ planTargets: ['P-1', 'PP-001', 'P-001x'] })], itemAudits: [] });
      expect(v.checkedTargets).toBe(0);
      expect(v.skippedTargets).toEqual(['P-1', 'PP-001', 'P-001x']);
    });
  });

  describe('describeUnrealized', () => {
    it('names the mapping, disposition, target and why', () => {
      const v = judge({ mappings: [mapping()], itemAudits: [itemAudit('P-001', [DOC])] });
      const line = describeUnrealized(v.unrealized[0]!);
      expect(line).toContain('M-001');
      expect(line).toContain('covered');
      expect(line).toContain('P-001');
      expect(line).toContain('no verifying');
    });

    it('truncates a long requirement so one entry cannot swallow the message', () => {
      const v = judge({
        mappings: [mapping({ requirement: 'x'.repeat(300) })],
        itemAudits: [],
      });
      expect(describeUnrealized(v.unrealized[0]!).length).toBeLessThan(200);
    });
  });

  /**
   * P-015 / D-035. P-015 asked to REFUSE these mappings; that was rejected after
   * measuring what they are — conversational requirements ("explain this more?") whose
   * honest home is a decision or a section, on 366 of 2,493 realizing mappings including
   * 10 on this plan's own audit. So the contract under test is deliberately two-sided:
   * they must be REPORTED, and they must NOT gate.
   */
  describe('exemptMappings — reported, never a violation', () => {
    it('reports a realizing mapping whose targets are ALL non-item', () => {
      const v = judge({
        mappings: [mapping({ planTargets: ['D-011', 'section:Now'] })],
        itemAudits: [],
      });
      expect(v.exemptMappings).toHaveLength(1);
      expect(v.exemptMappings[0]?.mappingId).toBe('M-001');
      expect(v.exemptMappings[0]?.planTargets).toEqual(['D-011', 'section:Now']);
    });

    it('STILL PASSES on such a mapping — this is the half P-015 would have broken', () => {
      const v = judge({
        mappings: [mapping({ planTargets: ['D-011', 'section:Now'] })],
        itemAudits: [],
      });
      expect(v.ok).toBe(true);
      expect(v.unrealized).toHaveLength(0);
      expect(v.checkedTargets).toBe(0);
    });

    it('does NOT report a mapping that carries a P-NNN beside its non-item targets', () => {
      // The distinction that makes the mapping-level count honest: measured fleet-wide,
      // 41.3% of realizing TARGETS are non-item but only 14.7% of realizing MAPPINGS have
      // no P-NNN at all, because most non-item targets sit beside one and ARE judged.
      const v = judge({
        mappings: [mapping({ planTargets: ['D-011', 'P-001', 'section:Now'] })],
        itemAudits: [itemAudit('P-001', [CODE])],
      });
      expect(v.ok).toBe(true);
      expect(v.exemptMappings).toHaveLength(0);
      expect(v.checkedTargets).toBe(1);
      expect(v.skippedTargets).toEqual(['D-011', 'section:Now']);
    });

    it('ignores non-realizing dispositions — rejected/open claim nothing to be exempt from', () => {
      const v = judge({
        mappings: [
          mapping({ id: 'M-002', disposition: 'rejected', planTargets: ['D-011'] }),
          mapping({ id: 'M-003', disposition: 'open', planTargets: ['section:Now'] }),
        ],
        itemAudits: [],
      });
      expect(v.exemptMappings).toHaveLength(0);
    });

    it('separates an exempt mapping from an unrealized one in the same audit', () => {
      const v = judge({
        mappings: [
          mapping({ id: 'M-001', planTargets: ['D-011'] }),
          mapping({ id: 'M-002', planTargets: ['P-002'] }),
        ],
        itemAudits: [itemAudit('P-002', [DOC])],
      });
      expect(v.exemptMappings.map((e) => e.mappingId)).toEqual(['M-001']);
      expect(v.unrealized.map((u) => u.mappingId)).toEqual(['M-002']);
      expect(v.ok).toBe(false); // driven by M-002 alone, never by the exemption
    });

    it('describeExemptMapping names the mapping, disposition and where it terminated', () => {
      const v = judge({
        mappings: [mapping({ planTargets: ['D-011', 'section:Now'] })],
        itemAudits: [],
      });
      const line = describeExemptMapping(v.exemptMappings[0]!);
      expect(line).toContain('M-001');
      expect(line).toContain('covered');
      expect(line).toContain('D-011');
      expect(line).toContain('section:Now');
    });
  });

  /**
   * P-016 / D-040: TARGET LIVENESS. Resolving a `P-NNN` against the folded audit answers
   * "was this item ever verified?", never "is this item still in the plan?" — and
   * `getEffectiveItemAudits` spans every completion pass with no filter by the current
   * item list, so a deleted item's verifying entry outlives it and keeps satisfying the
   * coverage claim.
   *
   * Both directions, because each rule here can only make the gate wrong in ONE of them:
   * `target-not-in-plan` makes it REFUSE (a false positive blocks a good plan) and the
   * dropped-target report makes it PASS (a false negative hides an abandoned target).
   */
  describe('target liveness against the plan current items (P-016)', () => {
    const planItem = (itemId: string, status: string): PlanItemStatus => ({
      itemId,
      status,
      itemText: `text for ${itemId}`,
    });

    it('REFUSES a target the plan no longer contains, though a verifying audit survives for it', () => {
      // The exact silent orphan P-016 was filed for: P-001 was deleted from the plan, but
      // its pre-deletion audit entry is still in the fold and still carries a code citation.
      const v = judge({
        mappings: [mapping({ planTargets: ['P-001'] })],
        itemAudits: [itemAudit('P-001', [CODE])],
        planItems: [planItem('P-002', 'done')],
      });
      expect(v.ok).toBe(false);
      expect(v.unrealized).toHaveLength(1);
      expect(v.unrealized[0]?.reason).toBe('target-not-in-plan');
      expect(v.unrealized[0]?.planTarget).toBe('P-001');
    });

    it('CALIBRATION: that same stale audit passes when the item is still in the plan', () => {
      // Without this the case above proves nothing — it would read identically if the
      // judge had simply started refusing everything.
      const v = judge({
        mappings: [mapping({ planTargets: ['P-001'] })],
        itemAudits: [itemAudit('P-001', [CODE])],
        planItems: [planItem('P-001', 'done')],
      });
      expect(v.ok).toBe(true);
      expect(v.unrealized).toHaveLength(0);
    });

    it('FAILS OPEN on an empty item list — getPlanItemStatuses returns [] on a read error', () => {
      // Convicting every target here would refuse every plan in the fleet on one bad read.
      const v = judge({
        mappings: [mapping({ planTargets: ['P-001'] })],
        itemAudits: [itemAudit('P-001', [CODE])],
        planItems: [],
      });
      expect(v.ok).toBe(true);
      expect(v.unrealized).toHaveLength(0);
      expect(v.droppedTargets).toHaveLength(0);
    });

    it('behaves exactly as before P-016 when planItems is not supplied at all', () => {
      const v = judge({
        mappings: [mapping({ planTargets: ['P-001'] })],
        itemAudits: [itemAudit('P-001', [CODE])],
      });
      expect(v.ok).toBe(true);
      expect(v.unrealized).toHaveLength(0);
      expect(v.droppedTargets).toHaveLength(0);
    });

    it('REPORTS a dropped target vouched by a pre-drop citation without refusing it', () => {
      // D-002 makes dropping a legitimate exit, so this must not gate — but the pairing
      // (abandoned item + surviving verifying citation) is precisely what was invisible.
      const v = judge({
        mappings: [mapping({ planTargets: ['P-001'] })],
        itemAudits: [itemAudit('P-001', [CODE])],
        planItems: [planItem('P-001', 'dropped')],
      });
      expect(v.ok).toBe(true);
      expect(v.unrealized).toHaveLength(0);
      expect(v.droppedTargets).toHaveLength(1);
      expect(v.droppedTargets[0]?.planTarget).toBe('P-001');
      expect(v.droppedTargets[0]?.vouchedByStaleAudit).toBe(true);
    });

    it('does NOT loosen a dropped target that has no verifying citation', () => {
      // The dropped targets that fail today must keep failing; the report is additive.
      const v = judge({
        mappings: [mapping({ planTargets: ['P-001'] })],
        itemAudits: [itemAudit('P-001', [DOC])],
        planItems: [planItem('P-001', 'dropped')],
      });
      expect(v.ok).toBe(false);
      expect(v.unrealized[0]?.reason).toBe('no-verifying-citation');
      expect(v.droppedTargets[0]?.vouchedByStaleAudit).toBe(false);
    });

    it('leaves a mapping with a live verified sibling passing, reporting only the dropped one', () => {
      const v = judge({
        mappings: [mapping({ planTargets: ['P-001', 'P-002'] })],
        itemAudits: [itemAudit('P-001', [CODE]), itemAudit('P-002', [TEST])],
        planItems: [planItem('P-001', 'dropped'), planItem('P-002', 'done')],
      });
      expect(v.ok).toBe(true);
      expect(v.droppedTargets.map((d) => d.planTarget)).toEqual(['P-001']);
    });

    it('never applies liveness to a non-item target — a D-NNN is exempt, not missing', () => {
      // A `D-NNN` is never in plan_items, so a naive liveness check would convict every
      // decision-terminated mapping. It must stay on the exemption path (D-035).
      const v = judge({
        mappings: [mapping({ planTargets: ['D-011'] })],
        itemAudits: [],
        planItems: [planItem('P-001', 'done')],
      });
      expect(v.ok).toBe(true);
      expect(v.unrealized).toHaveLength(0);
      expect(v.exemptMappings).toHaveLength(1);
    });

    it('does not report a dropped target for a non-realizing disposition', () => {
      const v = judge({
        mappings: [mapping({ disposition: 'rejected', planTargets: ['P-001'] })],
        itemAudits: [],
        planItems: [planItem('P-001', 'dropped')],
      });
      expect(v.ok).toBe(true);
      expect(v.droppedTargets).toHaveLength(0);
    });

    it('describeUnrealized explains a missing target in repair terms', () => {
      const v = judge({
        mappings: [mapping({ planTargets: ['P-001'] })],
        itemAudits: [itemAudit('P-001', [CODE])],
        planItems: [planItem('P-002', 'done')],
      });
      const line = describeUnrealized(v.unrealized[0]!);
      expect(line).toContain('P-001');
      expect(line).toContain('the plan no longer contains this item');
    });

    it('names a dropped unrealized target without exempting it from evidence', () => {
      const v = judge({
        mappings: [mapping({ planTargets: ['P-001'] })],
        itemAudits: [itemAudit('P-001', [DOC])],
        planItems: [planItem('P-001', 'dropped')],
      });
      const line = describeUnrealized(v.unrealized[0]!);

      expect(v.ok).toBe(false);
      expect(v.droppedTargets).toHaveLength(1);
      expect(line).toContain('P-001 (dropped; still subject to the evidence rule)');
      expect(line).toContain('no verifying');
    });

    it('describeDroppedTarget names the target and whether a stale citation still vouches', () => {
      const v = judge({
        mappings: [mapping({ planTargets: ['P-001'] })],
        itemAudits: [itemAudit('P-001', [CODE])],
        planItems: [planItem('P-001', 'dropped')],
      });
      const line = describeDroppedTarget(v.droppedTargets[0]!);
      expect(line).toContain('M-001');
      expect(line).toContain('P-001');
      expect(line).toContain('dropped');
      expect(line).toContain('still vouched by a pre-drop verifying citation');
    });
  });
});
