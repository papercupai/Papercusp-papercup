import { describe, expect, it } from 'vitest';
import setFrontmatterTool, { buildFirstClassPlanBody } from './set-frontmatter';
import { parsePlan } from './parser';

describe('plans:set-frontmatter initial lifecycle status', () => {
  const base = { harness: 'papercusp', slug: 'legacy-plan', title: 'Legacy Plan' };

  it('accepts a non-terminal status when converting a legacy plan', () => {
    expect(setFrontmatterTool.args.safeParse({ ...base, status: 'active' }).success).toBe(true);
  });

  it.each(['shipped', 'superseded'])('rejects terminal conversion status %s', (status) => {
    expect(setFrontmatterTool.args.safeParse({ ...base, status }).success).toBe(false);
  });

  it('preserves an already-drained legacy item graph when converting it to ready', () => {
    const legacy = [
      '# Legacy Plan',
      '',
      '## Phase 1',
      '',
      '- **P-001** `done` Already complete.',
      '- **P-002** `dropped` No longer needed.',
      '',
    ].join('\n');
    const path = `${base.slug}.md`;
    const before = parsePlan(legacy, { filePath: path });
    expect(before.isLegacy).toBe(true);
    expect(before.items.map(({ id, storedStatus }) => [id, storedStatus])).toEqual([
      ['P-001', 'done'],
      ['P-002', 'dropped'],
    ]);

    const converted = buildFirstClassPlanBody(
      legacy,
      { ...base, status: 'ready' },
      '2026-10-05',
    );
    const after = parsePlan(converted.body, { filePath: path });
    expect(after.isLegacy).toBe(false);
    expect(after.frontmatter.status).toBe('ready');
    expect(after.items.map(({ id, storedStatus }) => [id, storedStatus])).toEqual([
      ['P-001', 'done'],
      ['P-002', 'dropped'],
    ]);
  });
});
