import { describe, expect, it } from 'vitest';
import revisionDiff from '../revision-diff';
import revisions from '../revisions-list';

type GuidanceTool = {
  description?: string;
  guidance?: {
    when?: string;
    notWhen?: string;
    chaining?: string;
    seeAlso?: unknown;
  };
};

function guidanceText(tool: GuidanceTool): string {
  const seeAlso = Array.isArray(tool.guidance?.seeAlso)
    ? tool.guidance.seeAlso.map((entry: unknown) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && 'tool' in entry) return String(entry.tool);
        return '';
      })
    : [];
  return [
    tool.description,
    tool.guidance?.when,
    tool.guidance?.notWhen,
    tool.guidance?.chaining,
    ...seeAlso,
  ].join('\n');
}

describe('plan revision tool guidance', () => {
  it('routes the revision list only to current plan tools', () => {
    const text = guidanceText(revisions);

    expect(text).not.toContain('plans:history');
    expect(text).not.toContain('plans:diff');
    expect(text).toContain('plans:revision-diff');
    expect(text).toContain('plans:revision-transcript');
  });

  it('does not direct revision-diff callers to the removed git-diff tool', () => {
    const text = guidanceText(revisionDiff);

    expect(text).not.toContain('plans:history');
    expect(text).not.toContain('plans:diff');
    expect(text).toContain('plans:revisions');
    expect(text).toContain('plans:revision-transcript');
  });
});
