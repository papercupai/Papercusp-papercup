/**
 * plans:new — idempotent-completion opt-in regression (EI-11507).
 *
 * A plans:new whose wall-clock beat the 55s transport deadline STILL COMMITTED the plan
 * (the slug write runs inside withPlanLock, synchronously before the handler returns) — and
 * a genuine retry is safe (the plan lock's slug uniqueness makes a re-create a `slug_exists`
 * no-op, never a duplicate plan). Declaring `idempotent: true` opts the tool into the dispatch
 * abort-race branch (libs/generic/tooldef dispatch-stack.ts) that surfaces the TRUTHFUL success
 * instead of a spurious `timeout`, so the caller stops the forced verify-read. The abort-race
 * branch itself is exercised in dispatch-projected.test.ts; this pins the missing link — that
 * THIS mutation tool declares the flag, mirroring plans:set-status's own W6/P-007 remediation.
 */

import { describe, it, expect } from 'vitest';
import newPlan, { buildTemplate } from './new';
import { BUDGET, promptWeight } from '../tool-guidance-budget';
import {
  LIBRARIES_SECTION_DESCRIPTION,
  REUSE_SECTION_DESCRIPTION,
  planDeclarationsWriteAdvisory,
  previewPlanDeclarations,
} from './plan-declarations';

// plan-reuse-and-library-declarations-2026-10-20 R-1.
describe('plans:new declaration scaffolds', () => {
  const base = { slug: 'plan-a-2026-10-20', title: 'Plan A', status: 'draft', owner: null, date: '2026-10-20' };

  it('R-1: plans:new scaffolds the reuse and libraries sections with guidance', () => {
    const content = buildTemplate(base);
    expect(content).toContain('## Existing infrastructure reused');
    expect(content).toContain('## Third-party libraries');
    expect(content).toContain(REUSE_SECTION_DESCRIPTION);
    expect(content).toContain(LIBRARIES_SECTION_DESCRIPTION);
    expect(content).toMatch(/```reuse\n\{[\s\S]*?\n```/);
    expect(content).toMatch(/```libraries\n\{[\s\S]*?\n```/);
    // The sections sit after Product shaping and before the item phase.
    expect(content.indexOf('## Product shaping')).toBeLessThan(content.indexOf('## Existing infrastructure reused'));
    expect(content.indexOf('## Third-party libraries')).toBeLessThan(content.indexOf('## Phase 1'));
    // The scaffold is found (it is a draft to fill in, so it is not yet valid).
    const preview = previewPlanDeclarations(content);
    expect(preview.reuse.status).not.toBe('missing');
    expect(preview.libraries.status).not.toBe('missing');
  });

  it('R-1: a caller-supplied body without the sections lands with an advisory and the scaffold', () => {
    const body = '# Plan A\n\n## Items\n\n- **P-001** `todo` Do the thing.\n';
    const content = buildTemplate({ ...base, body });
    expect(content).not.toContain('## Existing infrastructure reused');
    const advisory = planDeclarationsWriteAdvisory(content);
    expect(advisory).toMatchObject({
      advisory: true,
      sections: [
        { heading: 'Existing infrastructure reused', status: 'missing' },
        { heading: 'Third-party libraries', status: 'missing' },
      ],
    });
    expect(advisory?.scaffold).toContain('```reuse');
    expect(advisory?.scaffold).toContain('```libraries');
  });

  // R-8 / D-013 #6: the plans:new guidance names both sections in one line, and the
  // libraries guidance names the three cases that need no research.
  it('R-8: plans:new guidance names both sections; libraries guidance names the no-research cases', () => {
    const when = (newPlan as unknown as { guidance: { when: string } }).guidance.when;
    const line = when.split(/(?<=\.)\s+/).find((sentence) => sentence.includes('## Existing infrastructure reused'));
    expect(line).toBeDefined();
    expect(line).toContain('## Third-party libraries');
    for (const decision of ['owner-specified', 'already-in-project', 'skip-research']) {
      expect(LIBRARIES_SECTION_DESCRIPTION).toContain(decision);
    }
  });

  // D-013 #6: the section line must not push plans:new over the per-tool guidance budget that
  // tool-guidance-budget.test.ts enforces catalog-wide; this pins it for this tool alone.
  it('R-8: plans:new description and guidance stay within the tool guidance budget', () => {
    expect(promptWeight(newPlan as Parameters<typeof promptWeight>[0])).toBeLessThanOrEqual(BUDGET);
  });
});

describe('plans:new idempotent-completion opt-in (EI-11507)', () => {
  it('declares idempotent:true so a committed-but-slow create surfaces success, not a false timeout', () => {
    expect((newPlan as { idempotent?: boolean }).idempotent).toBe(true);
  });
});

describe('plans:new initial lifecycle status', () => {
  const base = { harness: 'papercusp', slug: 'initial-status-plan', title: 'Initial Status Plan' };

  it('accepts non-terminal initial statuses', () => {
    expect(newPlan.args.safeParse({ ...base, status: 'active' }).success).toBe(true);
  });

  it.each(['shipped', 'superseded'])('rejects terminal initial status %s', (status) => {
    expect(newPlan.args.safeParse({ ...base, status }).success).toBe(false);
  });
});
