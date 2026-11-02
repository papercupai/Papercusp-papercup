import { describe, expect, it } from 'vitest';
import { rankResearchAnchors, RESEARCH_TRAIL_RETENTION_MS, type ResearchSubject } from './research-trail';

describe('P012 research anchor ranking', () => {
  it('ranks recent research first and symbols ahead of files at the same time', () => {
    const now = Date.now();
    expect(rankResearchAnchors([
      { kind: 'path', requested: 'old.ts', path: 'old.ts', seenAt: now - 1 },
      { kind: 'path', requested: 'target.ts', path: 'target.ts', seenAt: now },
      { kind: 'symbol', requested: 'target', path: 'target.ts', seenAt: now },
    ])).toEqual([{ symbol: 'target', path: 'target.ts' }, { path: 'target.ts' }, { path: 'old.ts' }]);
  });

  it('rejects unsafe and expired links, deduplicates aliases, and respects the anchors input limit', () => {
    const now = Date.now();
    const subjects: ResearchSubject[] = Array.from({ length: 40 }, (_, i) => ({
      kind: 'path', requested: `file-${i}.ts`, path: `file-${i}.ts`, seenAt: now - i,
    }));
    subjects.unshift({ kind: 'path', requested: 'alias', path: 'file-0.ts', seenAt: now },
      { kind: 'path', requested: '../outside.ts', path: '../outside.ts', seenAt: now },
      { kind: 'path', requested: 'expired.ts', path: 'expired.ts', seenAt: now - RESEARCH_TRAIL_RETENTION_MS });
    const anchors = rankResearchAnchors(subjects);
    expect(anchors).toHaveLength(32);
    expect(anchors[0]).toEqual({ path: 'file-0.ts' });
    expect(anchors).not.toContainEqual({ path: '../outside.ts' });
    expect(anchors).not.toContainEqual({ path: 'expired.ts' });
    expect(new Set(anchors.map(anchor => JSON.stringify(anchor))).size).toBe(32);
  });
});
