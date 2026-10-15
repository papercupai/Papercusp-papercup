import { describe, expect, it } from 'vitest';
import { makeReportBackfill } from './report-backfill';
describe('Reports historical backfill', () => {
  it('preserves the complete source and incomplete-audit caveat, and embeds its editable diagram', () => {
    const original = '# Architecture audit — interim report\n\n**Incomplete:** the broad audit remains paused.\n\nOriginal findings.\n';
    const report = makeReportBackfill({ workspaceId: 'ws', sourcePath: 'docs/audit.md', sourceRef: 'work-item:WI-1',
      bodyMd: original, diagramMd: 'graph TD; A-->B' });
    expect(report.bodyMd?.startsWith(original)).toBe(true);
    expect(report.bodyMd).toContain('```mermaid\ngraph TD; A-->B\n```');
    expect(report).toMatchObject({ source: 'backfill', visibility: 'owner', title: 'Architecture audit — interim report' });
  });
  it('uses the original record as retry identity and refuses missing source content', () => {
    const input = { workspaceId: 'ws', sourcePath: 'docs/audit.md', sourceRef: 'work-item:WI-1', bodyMd: '# Audit\nComplete source' };
    expect(makeReportBackfill(input).requestKey).toBe(makeReportBackfill(input).requestKey);
    expect(makeReportBackfill({ ...input, sourceRef: 'work-item:WI-2' }).requestKey).not.toBe(makeReportBackfill(input).requestKey);
    expect(() => makeReportBackfill({ ...input, bodyMd: '' })).toThrow('empty historical report');
    expect(() => makeReportBackfill({ ...input, bodyMd: 'missing title' })).toThrow('must have a title');
  });
});
