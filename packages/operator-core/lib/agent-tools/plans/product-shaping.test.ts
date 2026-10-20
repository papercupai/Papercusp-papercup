import { describe, expect, it } from 'vitest';
import { previewProductShaping, productShapingScaffold, renderOwnerWalkthrough, type ProductShaping } from './product-shaping';
import { LIBRARIES_SECTION_HEADING, REUSE_SECTION_HEADING } from './plan-declarations';

const source = 'session_turn:codex:original-request:1';
function brief(outcome = 'The user can retry without losing their draft.'): ProductShaping {
  return {
    audience: 'A person reporting a bug', problem: 'A failed submission loses their work', outcome,
    nonGoals: ['Automatic public posting'], sourceRefs: [source],
    context: [{ kind: 'owner-request', text: 'Make bug reporting easy', sourceRefs: [source] },
      { kind: 'assumption', text: 'Retain drafts locally', recommendation: 'Use the existing draft store' }],
    scenarios: [{ id: 'SC-001', title: 'Retry submission', kind: 'normal', trigger: 'A saved draft',
      action: 'Submit the report', outcome, requirementIds: ['R-1'] }],
    considerations: [{ category: 'Network failure', disposition: 'covered', reason: 'Retry retains the draft', scenarioIds: ['SC-001'] },
      { category: 'Billing', disposition: 'not-applicable', reason: 'No payments in this feature', scenarioIds: [] }],
  };
}
function plan(shape: ProductShaping, requirements = '**R-1 — Retry.** The person can retry submission.', map = '| R-1 | P-001 | tree |') {
  return '# Feature\n\n## Product shaping\n\n```product-shaping\n' + JSON.stringify(shape) +
    '\n```\n\n## Requirements\n\n' + requirements + '\n\n## Design\n\n### Bar-to-work map for this plan\n\n| bar | implementing plan items | evidence plane |\n|---|---|---|\n' + map + '\n\n## Build\n\n- **P-001** `todo` Deliver the outcome\n';
}

describe('product shaping', () => {
  it('keeps the intended outcome, source and assumed technical choice distinct', () => {
    const result = previewProductShaping(plan(brief()));
    expect(result.status).toBe('ready-for-review');
    expect(result.diagnostics).toEqual([]);
    expect(result.trace).toEqual([{ scenarioId: 'SC-001', requirementIds: ['R-1'], planItemIds: ['P-001'] }]);
    expect(result.reviewerBrief.sourceRefs).toEqual([source]);
    expect(result.brief && 'context' in result.brief ? result.brief.context.map(entry => entry.kind) : []).toEqual(['owner-request', 'assumption']);
    expect(result.semanticCompleteness).toBe('not-measured');
    expect(result.sourceContentVerified).toBe(false);
    expect(result.advisory).toBe(true);
  });

  it('guides a legacy plan without inventing product intent or blocking it', () => {
    const result = previewProductShaping('# Legacy\n## Build\n- **P-001** `todo` Work');
    expect(result.status).toBe('missing');
    expect(result.brief).toBeNull();
    expect(result.scaffold).toContain('```product-shaping');
    expect(result.reviewerBrief.sourceRefs).toEqual([]);
  });

  it('the scaffold admits incomplete drafts while exposing their omissions', () => {
    const result = previewProductShaping('# Draft\n' + productShapingScaffold());
    expect(result.status).toBe('incomplete');
    expect(result.diagnostics.map(row => row.code)).toContain('original_sources_missing');
    expect(result.diagnostics.map(row => row.code)).toContain('scenario_field_missing');
  });

  it.each(['{oops', '{"audience":"only a fragment"}'])('reports invalid data without calling it complete: %s', json => {
    const result = previewProductShaping('## Product shaping\n```product-shaping\n' + json + '\n```');
    expect(result.status).toBe('invalid');
    expect(result.brief).toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('rejects duplicate shaping sections and blocks', () => {
    const single = productShapingScaffold();
    expect(previewProductShaping(single + '\n' + single).status).toBe('invalid');
    expect(previewProductShaping(single + '\n```product-shaping\n{}\n```').status).toBe('invalid');
  });

  it('exposes an unsupported extra requirement and dangling implementation mapping', () => {
    const result = previewProductShaping(plan(brief(), '**R-1 — Retry.** Retry works.\n\n**R-2 — Publish.** Public posting works.', '| R-1 | P-999 | tree |\n| R-2 | P-001 | tree |'));
    expect(result.status).toBe('incomplete');
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'requirement_untraced', ref: 'R-2' }),
      expect.objectContaining({ code: 'bar_mapping_unknown', ref: 'R-1' }),
    ]));
  });

  it('flags missing requirements, duplicate scenarios and unresolved material choices together', () => {
    const shape = brief();
    shape.scenarios[0]!.requirementIds = ['R-999'];
    shape.scenarios.push({ ...shape.scenarios[0]! });
    shape.context.push({ kind: 'product-choice', text: 'Public or private reports?', material: true, resolved: false, recommendation: 'Private by default' });
    const codes = previewProductShaping(plan(shape)).diagnostics.map(row => row.code);
    expect(codes).toEqual(expect.arrayContaining(['scenario_requirement_missing', 'scenario_duplicate', 'material_choice_open']));
  });

  it('accepts a reasoned non-applicable concern without manufacturing a scenario', () => {
    expect(previewProductShaping(plan(brief())).diagnostics.some(row => row.ref === 'Billing')).toBe(false);
  });

  it('allows code/document evidence for facts while preserving owner-source distinctions', () => {
    const shape = brief();
    shape.context.push({ kind: 'observed-fact', text: 'Draft storage exists', sourceRefs: ['file:lib/drafts.ts'] });
    expect(previewProductShaping(plan(shape)).status).toBe('ready-for-review');
    shape.context[0]!.sourceRefs = ['file:generated-spec.md'];
    expect(previewProductShaping(plan(shape)).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'owner_source_invalid' }),
    ]));
  });

  it('bounds large diagnostic lists with explicit overflow and a repair path', () => {
    const shape = brief();
    shape.scenarios = Array.from({ length: 30 }, (_, i) => ({ id: 'SC-' + String(i + 1).padStart(3, '0'), title: '', kind: 'normal' as const,
      trigger: '', action: '', outcome: '', requirementIds: [] }));
    const result = previewProductShaping(plan(shape));
    expect(result.diagnostics.length).toBeLessThanOrEqual(20);
    expect(result.diagnosticsOmitted).toBeGreaterThan(0);
    expect(result.overflowRead).toContain('canonical Product shaping');
    expect(result.status).toBe('incomplete');
  });

  it('keeps a large valid brief bounded with original-source and canonical-section pointers', () => {
    const shape = brief();
    shape.problem = 'Problem '.repeat(200);
    shape.sourceRefs = Array.from({ length: 20 }, (_, i) => 'session_turn:codex:' + 'x'.repeat(400) + ':' + i);
    const result = previewProductShaping(plan(shape));
    expect(result.status).toBe('ready-for-review');
    expect(result.briefIsExcerpt).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(6000);
    expect(result.reviewerBrief.readFullContext).toContain('Product shaping');
    expect(result.reviewerBrief.sourceRefs).toHaveLength(3);
  });

  describe('owner walkthrough (R-7)', () => {
    function richBrief(): ProductShaping {
      const shape = brief();
      shape.scenarios.push({ id: 'SC-002', title: 'Offline submit', kind: 'failure', trigger: 'The network drops mid-submit',
        action: 'Press submit again', outcome: 'The draft is still there', requirementIds: ['R-1'] });
      shape.scenarios.unshift({ id: 'SC-000', title: 'Over the size limit', kind: 'boundary', trigger: 'A 50MB attachment',
        action: 'Attach it', outcome: 'A clear size message', requirementIds: ['R-1'] });
      shape.context.push({ kind: 'product-choice', text: 'Public or private reports?', material: true, resolved: false, recommendation: 'Private by default' });
      shape.context.push({ kind: 'product-choice', text: 'Settled choice', material: true, resolved: true, recommendation: 'Done' });
      return shape;
    }

    it('renders every scenario as a trigger/action/outcome line, normal journeys first', () => {
      const walk = previewProductShaping(plan(richBrief())).ownerWalkthrough!;
      expect(walk).toBeTruthy();
      for (const [id, trigger, action, outcome] of [
        ['SC-001', 'A saved draft', 'Submit the report', 'The user can retry without losing their draft.'],
        ['SC-002', 'The network drops mid-submit', 'Press submit again', 'The draft is still there'],
        ['SC-000', 'A 50MB attachment', 'Attach it', 'A clear size message'],
      ]) {
        const line = walk.split('\n').find(row => row.includes(`(${id})`));
        expect(line, id).toBeDefined();
        expect(line).toContain(`When: ${trigger}`);
        expect(line).toContain(`Then: ${action}`);
        expect(line).toContain(`Result: ${outcome}`);
      }
      // Normal journeys come before failure/boundary cases even when authored later.
      expect(walk.indexOf('(SC-001)')).toBeLessThan(walk.indexOf('(SC-000)'));
      expect(walk).toContain('[failure] **Offline submit**');
      expect(walk).toContain('Automatic public posting');
    });

    it('lists assumptions and only the OPEN material choices, each with its recommendation', () => {
      const walk = previewProductShaping(plan(richBrief())).ownerWalkthrough!;
      expect(walk).toMatch(/Assumptions made on your behalf[\s\S]*Retain drafts locally \(proposed: Use the existing draft store\)/);
      expect(walk).toMatch(/Choices for you[\s\S]*Public or private reports\? — recommended: Private by default/);
      expect(walk).not.toContain('Settled choice');
      // Owner requests are the owner's own words, not something to re-confirm.
      expect(walk).not.toContain('Make bug reporting easy');
    });

    it('yields no walkthrough for missing or malformed shaping', () => {
      expect(previewProductShaping('# Legacy\n## Build\n- **P-001** `todo` Work').ownerWalkthrough).toBeNull();
      expect(previewProductShaping('## Product shaping\n```product-shaping\n{oops\n```').ownerWalkthrough).toBeNull();
      expect(renderOwnerWalkthrough(null)).toBeNull();
    });

    it('R-7: walkthrough lists reuse entries and library rows', () => {
      const reuse = {
        searched: [{ where: 'lib/drafts', how: 'grep for draft stores', found: 'drafts.ts' }],
        reused: [
          { ref: 'lib/drafts.ts#saveDraft', kind: 'symbol', provides: 'local draft persistence', items: ['P-001'] },
          { ref: 'harness_shared.bug_reports', kind: 'table', provides: 'report storage', items: ['P-001'] },
        ],
        newSurfaces: [{ name: 'retry-queue.ts', kind: 'module', nearestExisting: 'lib/outbox.ts', whyNotReused: 'outbox is email-only' }],
        notApplicable: null,
      };
      const libraries = {
        needs: [
          { need: 'schema validation', decision: 'already-in-project', package: 'zod', reason: '', existingUse: 'product-shaping.ts' },
          { need: 'backoff timing', decision: 'skip-research', package: '', reason: 'three lines of arithmetic' },
          { need: 'url state', decision: 'owner-specified', package: 'nuqs', reason: '', sourceRef: 'session_turn:claude:abc:3' },
        ],
        notApplicable: null,
      };
      const content = plan(brief())
        + `\n\n## ${REUSE_SECTION_HEADING}\n\n\`\`\`reuse\n${JSON.stringify(reuse)}\n\`\`\``
        + `\n\n## ${LIBRARIES_SECTION_HEADING}\n\n\`\`\`libraries\n${JSON.stringify(libraries)}\n\`\`\``;
      const walk = previewProductShaping(content).ownerWalkthrough!;
      // The brief still leads; the declarations follow it.
      expect(walk.indexOf('**After this ships:**')).toBeLessThan(walk.indexOf('**Reuses:**'));
      for (const entry of reuse.reused) expect(walk).toContain(entry.ref);
      expect(walk).toContain('retry-queue.ts (module) — nearest existing: lib/outbox.ts; not reused because: outbox is email-only');
      for (const row of libraries.needs) expect(walk).toContain(`${row.need}: ${row.decision}`);
      expect(walk).toContain('`zod`');

      // A plan without the sections says so rather than silently omitting them.
      const bare = previewProductShaping(plan(brief())).ownerWalkthrough!;
      expect(bare).toContain('**Reuses:** not declared (missing)');
      expect(bare).toContain('**Libraries:** not declared (missing)');

      // D-013 #5: with no Product shaping brief, the declarations still render.
      const sectionsOnly = content.slice(content.indexOf(`## ${REUSE_SECTION_HEADING}`));
      const noBrief = renderOwnerWalkthrough(null, sectionsOnly)!;
      expect(noBrief).toContain('**Reuses:**');
      for (const entry of reuse.reused) expect(noBrief).toContain(entry.ref);
      for (const row of libraries.needs) expect(noBrief).toContain(`${row.need}: ${row.decision}`);
      // No brief and no sections: nothing to walk through.
      expect(renderOwnerWalkthrough(null, '# Plan\n')).toBeNull();
      expect(renderOwnerWalkthrough(null)).toBeNull();
    });

    it('keeps the walkthrough inside the bounded preview and marks an excerpt explicitly', () => {
      const shape = richBrief();
      shape.scenarios = Array.from({ length: 40 }, (_, i) => ({ id: 'SC-' + String(i + 1).padStart(3, '0'), title: 'Scenario ' + i,
        kind: 'normal' as const, trigger: 'Trigger '.repeat(20), action: 'Action '.repeat(20), outcome: 'Outcome '.repeat(20), requirementIds: ['R-1'] }));
      const result = previewProductShaping(plan(shape));
      expect(JSON.stringify(result).length).toBeLessThan(6000);
      expect(result.ownerWalkthroughIsExcerpt).toBe(true);
      expect(result.ownerWalkthrough).toMatch(/…$/);
      // The full rendering is still available from the data itself.
      expect(renderOwnerWalkthrough(shape)!.split('\n').filter(row => row.startsWith('- **')).length).toBe(40);
    });
  });

  describe('two-pass blind intent review (R-11)', () => {
    it('pass one carries only owner and evidence refs, never the plan\'s interpretation', () => {
      const shape = brief();
      shape.context.push({ kind: 'observed-fact', text: 'Draft storage exists', sourceRefs: ['file:lib/drafts.ts'] });
      shape.context.push({ kind: 'owner-request', text: 'Keep it simple', sourceRefs: ['session_turn:claude:other:4'] });
      const result = previewProductShaping(plan(shape, '**R-1 — Retry works.** The person can retry submission after a failure.'));
      const { passOne, sourceRefs, instructions, readFullContext } = result.reviewerBrief;
      // Owner-request turns are read alongside the brief's own source refs.
      expect(sourceRefs).toEqual([source, 'session_turn:claude:other:4']);
      expect(passOne.observedFactRefs).toEqual(['file:lib/drafts.ts']);
      // Everything a reviewer is handed for pass one: refs, task, instructions.
      const packet = JSON.stringify({ sourceRefs, passOne, instructions, readFullContext });
      for (const leak of ['Retry submission', 'A saved draft', 'Submit the report', 'retry without losing', 'Retry works',
        'retry submission after a failure', 'A person reporting a bug', 'A failed submission loses', 'Retain drafts locally',
        'Draft storage exists', 'Make bug reporting easy', 'Automatic public posting']) {
        expect(packet, leak).not.toContain(leak);
      }
      expect(passOne.consultQuestion).toContain(source);
      expect(passOne.consultQuestion).toMatch(/Without reading the plan/);
    });

    it('pass two compares against the plan and names omissions, unsupported additions and contradictions', () => {
      const { reviewerBrief } = previewProductShaping(plan(brief()));
      expect(reviewerBrief.protocol).toBe('two-pass-blind');
      expect(reviewerBrief.passTwo.task).toMatch(/omission/);
      expect(reviewerBrief.passTwo.task).toMatch(/unsupported addition/);
      expect(reviewerBrief.passTwo.task).toMatch(/contradiction/);
      expect(reviewerBrief.passTwo.reportShape).toContain('ownerRef');
    });

    it('has no consult question when there is no owner source to read', () => {
      expect(previewProductShaping('# Legacy\n## Build\n- **P-001** `todo` Work').reviewerBrief.passOne.consultQuestion).toBeNull();
    });
  });

  it.each([
    ['bug report retry', 'The report draft survives a failed submission.', 'failure'],
    ['notification preferences', 'A disabled notification remains suppressed.', 'boundary'],
    ['collaboration permissions', 'A reader cannot publish changes.', 'authorization'],
  ] as const)('pilot fixture: %s exposes an omitted behavior before tasking', (_name, outcome, kind) => {
    const shape = brief(outcome);
    shape.scenarios.push({ id: 'SC-002', title: _name, kind, trigger: 'Relevant edge case', action: 'Attempt the action', outcome, requirementIds: [] });
    const before = previewProductShaping(plan(shape));
    expect(before.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'scenario_unmapped', ref: 'SC-002' })]));
    shape.scenarios[1]!.requirementIds = ['R-2'];
    const after = previewProductShaping(plan(shape, '**R-1 — Normal.** The normal journey works.\n\n**R-2 — Edge.** ' + outcome, '| R-1 | P-001 | tree |\n| R-2 | P-001 | tree |'));
    expect(after.status).toBe('ready-for-review');
    expect(after.trace[1]?.requirementIds).toEqual(['R-2']);
    // A fixture validates the workflow, not the rate of real owner omissions.
    expect(after.semanticCompleteness).toBe('not-measured');
  });
});
