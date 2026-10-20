import { describe, expect, it } from 'vitest';
import {
  LIBRARIES_DECLARATION_GUIDANCE,
  LIBRARIES_SECTION_HEADING,
  REUSE_SECTION_HEADING,
  planDeclarationsRegressionAdvisory,
  planDeclarationsScaffold,
  planDeclarationsWriteAdvisory,
  previewPlanDeclarations,
  renderDeclarationsWalkthrough,
} from './plan-declarations';

const reuseSection = (block: unknown) =>
  `## ${REUSE_SECTION_HEADING}\n\nGuidance.\n\n\`\`\`reuse\n${typeof block === 'string' ? block : JSON.stringify(block, null, 2)}\n\`\`\``;
const librariesSection = (block: unknown) =>
  `## ${LIBRARIES_SECTION_HEADING}\n\nGuidance.\n\n\`\`\`libraries\n${typeof block === 'string' ? block : JSON.stringify(block, null, 2)}\n\`\`\``;
const plan = (...sections: string[]) => ['---\ntitle: T\n---', '## Now', 'state', ...sections, '## Decisions'].join('\n\n');

const validReuse = {
  searched: [{ where: 'packages/operator-core/lib/agent-tools/plans', how: 'grep for section parsers', found: 'product-shaping.ts' }],
  reused: [{ ref: 'packages/operator-core/lib/agent-tools/plans/plan-sections.ts#splitPlanSections', kind: 'symbol', provides: 'section split', items: ['P-001'] }],
  newSurfaces: [{ name: 'plan-declarations.ts', kind: 'module', nearestExisting: 'product-shaping.ts', whyNotReused: 'keeps that file focused' }],
  notApplicable: null,
};
const validLibraries = {
  needs: [
    { need: 'schema validation', decision: 'already-in-project', package: 'zod', reason: '', existingUse: 'product-shaping.ts' },
    { need: 'trim helper', decision: 'skip-research', package: '', reason: 'two lines of glue code' },
    { need: 'url state', decision: 'owner-specified', package: 'nuqs', reason: '', sourceRef: 'session_turn:claude:abc:3' },
    { need: 'pdf rendering', decision: 'researched', package: 'pdfkit', reason: '', candidates: [
      { name: 'pdfkit', verdict: 'chosen', why: 'streams, maintained' },
      { name: 'jspdf', verdict: 'rejected', why: 'browser-first' },
    ] },
  ],
  notApplicable: null,
};

describe('plan declarations', () => {
  it('accepts valid reuse and libraries sections', () => {
    const preview = previewPlanDeclarations(plan(reuseSection(validReuse), librariesSection(validLibraries)));
    expect(preview.diagnostics).toEqual([]);
    expect(preview.ok).toBe(true);
    expect(preview.reuse.status).toBe('declared');
    expect(preview.libraries.status).toBe('declared');
  });

  it('accepts a not-applicable reason in place of entries', () => {
    const preview = previewPlanDeclarations(plan(
      reuseSection({ searched: [], reused: [], newSurfaces: [], notApplicable: 'docs-only plan' }),
      librariesSection({ needs: [], notApplicable: 'no code is written' }),
    ));
    expect(preview.ok).toBe(true);
    expect(preview.reuse.status).toBe('not-applicable');
    expect(preview.libraries.status).toBe('not-applicable');
  });

  it('R-2: each malformed declaration is reported with its field path', () => {
    const badJson = previewPlanDeclarations(plan(reuseSection('{ "searched": [ }'), librariesSection(validLibraries)));
    expect(badJson.ok).toBe(false);
    expect(badJson.diagnostics.map((d) => d.code)).toEqual(['declaration_invalid_json']);
    expect(badJson.diagnostics[0]!.section).toBe(REUSE_SECTION_HEADING);

    const unknownDecision = previewPlanDeclarations(plan(reuseSection(validReuse), librariesSection({
      needs: [{ need: 'dates', decision: 'guessed', package: 'dayjs', reason: '' }], notApplicable: null,
    })));
    expect(unknownDecision.diagnostics).toEqual([
      expect.objectContaining({ code: 'declaration_invalid', section: LIBRARIES_SECTION_HEADING, path: 'needs.0.decision' }),
    ]);

    const missingField = previewPlanDeclarations(plan(reuseSection({
      ...validReuse, reused: [{ ref: 'packages/x.ts', kind: 'file' }],
    }), librariesSection(validLibraries)));
    expect(missingField.diagnostics).toEqual([
      expect.objectContaining({ code: 'declaration_invalid', section: REUSE_SECTION_HEADING, path: 'reused.0.provides' }),
    ]);

    const decisionRules = previewPlanDeclarations(plan(reuseSection(validReuse), librariesSection({
      needs: [
        { need: 'a', decision: 'owner-specified', package: 'nuqs', reason: '', sourceRef: 'the owner said so' },
        { need: 'b', decision: 'already-in-project', package: 'zod', reason: '' },
        { need: 'c', decision: 'skip-research', package: '', reason: '' },
        { need: 'd', decision: 'researched', package: 'pdfkit', reason: '', candidates: [{ name: 'pdfkit', verdict: 'chosen', why: 'x' }] },
      ],
      notApplicable: null,
    })));
    expect(decisionRules.diagnostics.map((d) => d.path)).toEqual([
      'needs.0.sourceRef', 'needs.1.existingUse', 'needs.2.reason', 'needs.3.candidates',
    ]);
  });

  it('reports a missing section, a missing block and an empty declaration', () => {
    const missing = previewPlanDeclarations(plan(reuseSection(validReuse)));
    expect(missing.libraries.status).toBe('missing');
    expect(missing.diagnostics).toEqual([expect.objectContaining({ code: 'declaration_section_missing', section: LIBRARIES_SECTION_HEADING })]);

    const noBlock = previewPlanDeclarations(plan(`## ${REUSE_SECTION_HEADING}\n\nWe reuse the existing sync layer.`, librariesSection(validLibraries)));
    expect(noBlock.diagnostics.map((d) => d.code)).toEqual(['declaration_block_missing_or_ambiguous']);

    const empty = previewPlanDeclarations(plan(
      reuseSection({ searched: [], reused: [], newSurfaces: [], notApplicable: null }),
      librariesSection({ needs: [], notApplicable: null }),
    ));
    expect(empty.diagnostics.map((d) => d.path)).toEqual(['searched', 'reused', 'needs']);
  });

  it('an unfilled scaffold is invalid and names the fields to fill', () => {
    const preview = previewPlanDeclarations(plan(planDeclarationsScaffold()));
    expect(preview.reuse.status).toBe('invalid');
    expect(preview.libraries.status).toBe('invalid');
    expect(preview.diagnostics.map((d) => d.path)).toEqual(expect.arrayContaining(['searched.0.where', 'reused.0.kind', 'needs.0.decision']));
  });

  it('R-8: libraries guidance names all three no-research cases', () => {
    expect(LIBRARIES_DECLARATION_GUIDANCE).toMatch(/owner already named the library \(owner-specified/);
    expect(LIBRARIES_DECLARATION_GUIDANCE).toMatch(/project already uses a library for this \(already-in-project/);
    expect(LIBRARIES_DECLARATION_GUIDANCE).toMatch(/expect no suitable library \(skip-research/);
    expect(LIBRARIES_DECLARATION_GUIDANCE).toMatch(/Research only when a library would remove a lot of work and fits the use case/);
  });

  it('renders every reuse entry, new surface and library row for the walkthrough', () => {
    const lines = renderDeclarationsWalkthrough(previewPlanDeclarations(plan(reuseSection(validReuse), librariesSection(validLibraries))));
    const text = lines.join('\n');
    expect(text).toContain('plan-sections.ts#splitPlanSections');
    expect(text).toContain('nearest existing: product-shaping.ts; not reused because: keeps that file focused');
    for (const row of validLibraries.needs) expect(text).toContain(`${row.need}: ${row.decision}`);
  });

  it('write advisory carries the scaffold only while a section is missing', () => {
    const advisory = planDeclarationsWriteAdvisory(plan());
    expect(advisory?.scaffold).toContain(`## ${REUSE_SECTION_HEADING}`);
    expect(advisory?.sections.map((s) => s.status)).toEqual(['missing', 'missing']);
    expect(planDeclarationsWriteAdvisory(plan(reuseSection(validReuse), librariesSection(validLibraries)))).toBeNull();
  });

  it('regression advisory fires only when an edit breaks a section that parsed before', () => {
    const good = plan(reuseSection(validReuse), librariesSection(validLibraries));
    const legacy = plan();
    // A plan that never had the sections stays quiet on edit.
    expect(planDeclarationsRegressionAdvisory(legacy, plan('## Extra\n\nmore text'))).toBeNull();
    // An edit that keeps both sections valid stays quiet.
    expect(planDeclarationsRegressionAdvisory(good, `${good}\n\nappended note`)).toBeNull();

    const removed = planDeclarationsRegressionAdvisory(good, plan(librariesSection(validLibraries)));
    expect(removed?.sections).toEqual([{ heading: REUSE_SECTION_HEADING, before: 'declared', after: 'missing' }]);

    const broken = planDeclarationsRegressionAdvisory(
      good,
      plan(reuseSection(validReuse), librariesSection({ needs: [{ need: 'x', decision: 'bogus' }], notApplicable: null })),
    );
    expect(broken?.sections).toEqual([{ heading: LIBRARIES_SECTION_HEADING, before: 'declared', after: 'invalid' }]);
    expect(broken?.diagnostics.length).toBeGreaterThan(0);
    expect(broken?.next).toMatch(/Write accepted/);
  });
});
