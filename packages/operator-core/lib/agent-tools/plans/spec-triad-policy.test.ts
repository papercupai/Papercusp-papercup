import { describe, it, expect } from 'vitest';
import {
  planInSpecTriadScope,
  specTriadGate,
  readSpecTriadDeclaration,
  specTriadEpoch,
  SPEC_TRIAD_EPOCH_DEFAULT,
  SPEC_TRIAD_EPOCH_ENV,
  SPEC_TRIAD_EXCLUDED_TEMPLATES,
  isSpecTriadExcludedTemplate,
} from './spec-triad-policy';
import { SPEC_TRIAD_EXCLUDED_TEMPLATES as SWEEP_EXCLUDED_TEMPLATES } from './spec-triad-sweep';

const EPOCH = new Date('2026-08-09T00:00:00.000Z');
const ON = { flagEnabled: true, epoch: EPOCH };

const REQ = 'Recall must surface anchor staleness to the agent, not only to the settings UI.';
const DESIGN = 'Fold the nightly sweep verdict into memory:search as a prepended banner.';

function planContent(o: { triad?: boolean; declare?: 'required' | 'exempt'; items?: number } = {}): string {
  const fm = ['---', 'slug: t', 'status: active'];
  if (o.declare) fm.push(`specTriad: ${o.declare}`);
  fm.push('---', '');
  const body: string[] = ['# T', ''];
  if (o.triad) body.push('## Requirements', '', REQ, '', '## Design', '', DESIGN, '');
  const n = o.items ?? 1;
  body.push('## Items', '');
  for (let i = 1; i <= n; i++) body.push(`- **P-${String(i).padStart(3, '0')}** todo — thing ${i}`);
  return [...fm, ...body, ''].join('\n');
}

describe('readSpecTriadDeclaration', () => {
  it('reads required / exempt out of the frontmatter block', () => {
    expect(readSpecTriadDeclaration(planContent({ declare: 'required' }))).toBe('required');
    expect(readSpecTriadDeclaration(planContent({ declare: 'exempt' }))).toBe('exempt');
    expect(readSpecTriadDeclaration(planContent())).toBe(null);
  });

  it('ignores a specTriad: line in the BODY — only frontmatter declares', () => {
    const src = ['---', 'slug: t', '---', '', 'Prose that mentions specTriad: exempt inline.', ''].join('\n');
    expect(readSpecTriadDeclaration(src)).toBe(null);
  });

  it('is null on a document with no frontmatter at all', () => {
    expect(readSpecTriadDeclaration('# just a title\n')).toBe(null);
  });
});

describe('planInSpecTriadScope', () => {
  it('the flag OFF puts every plan out of scope', () => {
    const s = planInSpecTriadScope(
      { content: planContent({ declare: 'required' }), created: '2027-01-01' },
      { flagEnabled: false, epoch: EPOCH },
    );
    expect(s).toEqual({ inScope: false, reason: 'flag-off' });
  });

  it('a plan created AFTER the epoch is in scope', () => {
    expect(planInSpecTriadScope({ content: planContent(), created: '2026-08-10' }, ON)).toEqual({
      inScope: true,
      reason: 'created-after-epoch',
    });
  });

  it('a plan created BEFORE the epoch is not — this is the freeze guard', () => {
    expect(planInSpecTriadScope({ content: planContent(), created: '2026-08-08' }, ON)).toEqual({
      inScope: false,
      reason: 'created-before-epoch',
    });
  });

  it('the epoch boundary is inclusive', () => {
    expect(
      planInSpecTriadScope({ content: planContent(), created: '2026-08-09T00:00:00.000Z' }, ON).inScope,
    ).toBe(true);
  });

  it.each([
    ['absent', null],
    ['unparseable', 'sometime last spring'],
    ['empty', ''],
  ])('a %s created date FAILS OPEN (out of scope)', (_label, created) => {
    const s = planInSpecTriadScope({ content: planContent(), created }, ON);
    expect(s.inScope).toBe(false);
    expect(s.reason).toBe('created-unknown');
  });

  it('an explicit `required` declaration overrides an old creation date', () => {
    expect(
      planInSpecTriadScope(
        { content: planContent({ declare: 'required' }), created: '2020-01-01' },
        ON,
      ),
    ).toEqual({ inScope: true, reason: 'required-declared' });
  });

  it('an explicit `exempt` declaration overrides a new creation date — the escape hatch', () => {
    expect(
      planInSpecTriadScope(
        { content: planContent({ declare: 'exempt' }), created: '2099-01-01' },
        ON,
      ),
    ).toEqual({ inScope: false, reason: 'exempt-declared' });
  });

  it('exempt beats required when a plan somehow declares both', () => {
    const src = ['---', 'slug: t', 'specTriad: exempt', 'specTriad: required', '---', ''].join('\n');
    expect(planInSpecTriadScope({ content: src, created: '2099-01-01' }, ON).inScope).toBe(false);
  });
});

describe('excluded templates (WI-10005441)', () => {
  // The promotion runner reaches specTriadGate too. Until WI-10005441 only the sweep knew a
  // rubric row was out of scope, so promotion kept filing triad items against rubric rows.
  it('puts an acceptance rubric row out of scope even when it would otherwise owe the triad', () => {
    const rubric = { planSlug: 'acceptance-x', content: planContent(), created: '2026-10-01', template: 'rubric' };
    expect(planInSpecTriadScope(rubric, ON)).toEqual({ inScope: false, reason: 'template-excluded' });
    const v = specTriadGate(rubric, ON);
    expect(v.gated).toBe(false);
    expect(v.missing).toEqual([]);
    // Calibration: the same row without the template IS gated, so the template is what decides.
    expect(specTriadGate({ ...rubric, planSlug: 'ordinary-x', template: null }, ON).gated).toBe(true);
  });

  it('outranks an explicit specTriad: required declaration', () => {
    const v = planInSpecTriadScope(
      { content: planContent({ declare: 'required' }), created: '2026-10-01', template: 'rubric' },
      ON,
    );
    expect(v).toEqual({ inScope: false, reason: 'template-excluded' });
  });

  it('is one list shared with the sweep, and only excludes the listed templates', () => {
    expect(SWEEP_EXCLUDED_TEMPLATES).toBe(SPEC_TRIAD_EXCLUDED_TEMPLATES);
    expect(isSpecTriadExcludedTemplate('rubric')).toBe(true);
    expect(isSpecTriadExcludedTemplate('initiative')).toBe(false);
    expect(isSpecTriadExcludedTemplate(null)).toBe(false);
    expect(isSpecTriadExcludedTemplate(undefined)).toBe(false);
  });
});

describe('specTriadGate', () => {
  it('exempts acceptance companions without template metadata, even with an explicit required declaration', () => {
    expect(specTriadGate({ planSlug: 'acceptance-x', content: planContent({ declare: 'required' }), created: '2026-10-01' }, ON))
      .toMatchObject({ gated: false, triad: null, scope: { reason: 'companion-excluded' } });
    expect(specTriadGate({ planSlug: 'acceptance-runtime-plane', content: planContent(), created: '2026-10-01' }, ON).gated).toBe(false);
    expect(specTriadGate({ planSlug: 'ordinary-acceptance-x', content: planContent(), created: '2026-10-01' }, ON).gated).toBe(true);
  });
  it('gates an in-scope plan that owes a leg, and names what it owes', () => {
    const v = specTriadGate({ planSlug: 'p', content: planContent(), created: '2026-08-10' }, ON);
    expect(v.gated).toBe(true);
    expect(v.missing).toEqual(['requirements', 'design']);
    expect(v.note).toMatch(/p/);
    expect(v.note).toMatch(/specTriad: exempt/);
  });

  it('does not gate an in-scope plan that carries the triad', () => {
    const v = specTriadGate(
      { planSlug: 'p', content: planContent({ triad: true }), created: '2026-08-10' },
      ON,
    );
    expect(v.gated).toBe(false);
    expect(v.triad?.complete).toBe(true);
    expect(v.note).toBe(null);
  });

  it('an OUT-OF-SCOPE plan is never evaluated at all (triad stays null)', () => {
    // Not merely "not gated" — the detector must not even run, because the
    // common path is every plan in the corpus and it would parse all of them.
    const v = specTriadGate({ planSlug: 'p', content: planContent(), created: '2020-01-01' }, ON);
    expect(v.gated).toBe(false);
    expect(v.triad).toBe(null);
    expect(v.scope.reason).toBe('created-before-epoch');
  });

  it('THE REGRESSION THIS FEATURE EXISTS TO PREVENT: the pre-epoch corpus is untouched', () => {
    // Measured 2026-08-08 on the live corpus: of 1000 plans, 0 carried
    // `## Requirements`, 51 carried `## Design`, 0 carried both, and 330 were
    // live. The design as literally written ("must be non-empty before items can
    // be marked actionable") turns all of them non-actionable at once and freezes
    // plan-driven dispatch fleet-wide. Every one of them predates the epoch, so
    // the correct policy gates NONE of them.
    const corpus = [
      { slug: 'no-sections', content: planContent(), created: '2026-05-20' },
      { slug: 'design-only', content: planContent().replace('## Items', `## Design\n\n${DESIGN}\n\n## Items`), created: '2026-06-01' },
      { slug: 'no-created', content: planContent(), created: null },
      { slug: 'weird-created', content: planContent(), created: 'last tuesday' },
      { slug: 'day-before-epoch', content: planContent(), created: '2026-08-08T23:59:59.000Z' },
    ];
    for (const p of corpus) {
      const v = specTriadGate({ planSlug: p.slug, content: p.content, created: p.created }, ON);
      expect(v.gated, `${p.slug} must not be gated`).toBe(false);
    }
  });

  it('uses a caller-supplied itemCount for the tasks leg', () => {
    const noItems = planContent({ triad: true, items: 0 }).replace('## Items\n', '');
    expect(
      specTriadGate({ content: noItems, created: '2026-08-10', itemCount: 0 }, ON).missing,
    ).toEqual(['tasks']);
    expect(
      specTriadGate({ content: noItems, created: '2026-08-10', itemCount: 4 }, ON).gated,
    ).toBe(false);
  });
});

describe('specTriadEpoch', () => {
  it('defaults to the shipped epoch', () => {
    expect(specTriadEpoch({}).toISOString()).toBe(new Date(SPEC_TRIAD_EPOCH_DEFAULT).toISOString());
  });

  it('honours a valid env override', () => {
    const d = specTriadEpoch({ [SPEC_TRIAD_EPOCH_ENV]: '2030-01-01T00:00:00.000Z' } as NodeJS.ProcessEnv);
    expect(d.toISOString()).toBe('2030-01-01T00:00:00.000Z');
  });

  it('IGNORES an unparseable override rather than throwing or drifting to 1970', () => {
    // A bad env var must not be able to move the epoch backwards and retro-gate
    // the whole corpus — the failure mode would be indistinguishable from the
    // freeze this design was corrected to avoid.
    const d = specTriadEpoch({ [SPEC_TRIAD_EPOCH_ENV]: 'yesterday' } as NodeJS.ProcessEnv);
    expect(d.toISOString()).toBe(new Date(SPEC_TRIAD_EPOCH_DEFAULT).toISOString());
  });
});
