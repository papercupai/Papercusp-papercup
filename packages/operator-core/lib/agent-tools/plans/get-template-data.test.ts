import { describe, expect, it } from 'vitest';
import { projectAcceptanceTemplateData } from './get-template-data';

describe('projectAcceptanceTemplateData', () => {
  const stored = {
    kind: 'acceptance',
    subjectPlan: 'subject-plan',
    subjectHarnessSlug: 'papercusp',
    criteria: [{
      key: 'r-1',
      barKey: 'R-1',
      method: 'old method',
      check: { kind: 'tests', files: ['old.test.ts'] },
    }],
    additiveFieldFromNewerBuild: { preserved: true },
  };

  it('matches rubrics:get by overlaying live verification fields and preserving raw fields', async () => {
    const projected = await projectAcceptanceTemplateData('rubric', stored, {
      readSubjectPlanContent: async () => ({ content: 'subject plan', version: 8 }),
      parseRequirementBars: () => ({
        ok: true,
        bars: [{
          barKey: 'R-1',
          criterion: { method: 'new method', check: { kind: 'tests', files: ['new.test.ts'] } },
        }],
      }),
    });

    expect(projected.templateData).toMatchObject({
      additiveFieldFromNewerBuild: { preserved: true },
      criteria: [{ method: 'new method', check: { kind: 'tests', files: ['new.test.ts'] } }],
    });
    expect(projected.liveRequirements).toMatchObject({
      source: 'live-plan',
      subjectPlan: 'subject-plan',
      subjectPlanVersion: 8,
      live: ['R-1'],
      changed: ['R-1'],
    });
  });

  it('returns non-rubric data untouched without reading a subject plan', async () => {
    let reads = 0;
    const result = await projectAcceptanceTemplateData('other', stored, {
      readSubjectPlanContent: async () => {
        reads += 1;
        return null;
      },
    });

    expect(result).toEqual({ templateData: stored });
    expect(reads).toBe(0);
  });

  it('keeps the stored data and explains the fallback when the subject plan is unavailable', async () => {
    const result = await projectAcceptanceTemplateData('rubric', stored, {
      readSubjectPlanContent: async () => null,
    });

    expect(result.templateData).toBe(stored);
    expect(result.liveRequirements).toMatchObject({ source: 'stored-rubric', reason: 'subject-plan-unreadable' });
  });
});
