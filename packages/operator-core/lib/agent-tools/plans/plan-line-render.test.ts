import { describe, expect, it } from 'vitest';
import { parsePlan } from '@papercusp/plan-parser';
import { deriveIndexFromContent } from './derive-index';
import { renderPlanLines } from './plan-line-render';

describe('graph item rendering preserves the author document', () => {
  it('uses body-relative parser coordinates after frontmatter without duplicating nodes or replacing the title', () => {
    const body = '---\ntitle: title\nslug: probe\nstatus: draft\n---\n\n# Title\n\nIntroduction.\n\n## Phase 1\n\nBefore.\n- **P-001** `todo` old\nAfter.\n';
    const items = deriveIndexFromContent(body).items;
    const rendered = renderPlanLines(body, items);
    expect(rendered).toBe(body);
    expect(parsePlan(rendered).items.map((i) => i.id)).toEqual(['P-001']);
    expect(renderPlanLines(body, [{ ...items[0], text: 'updated' }])).toBe(body.replace('`todo` old', '`todo` updated'));
  });
  it('projects graph order and metadata while retaining arbitrary prose and fenced examples', () => {
    const body = '# Plan\n\nAn introduction.\n\n## Phase 1\n\nBefore.\n- **P-001** `todo` stale\nAfter.\n\n```md\n- **P-099** `todo` example\n```\n\n## Decisions\n\n### D-001 — Why\nKeep this whole paragraph.\n';
    const items = deriveIndexFromContent('## Phase 2\n\n- **P-002** `done` actual D-001 deliverable: code\n- **P-003** `todo` next blocked-by: P-002 — note: keep').items;
    const rendered = renderPlanLines(body, items);
    expect(parsePlan(rendered).items.map((i) => [i.id, i.phase, i.blockedBy])).toEqual([
      ['P-002', 'Phase 2', []], ['P-003', 'Phase 2', ['P-002']],
    ]);
    for (const prose of ['An introduction.', 'Before.', 'After.', '```md\n- **P-099** `todo` example\n```', '### D-001 — Why\nKeep this whole paragraph.']) expect(rendered).toContain(prose);
    expect(renderPlanLines(rendered, items)).toBe(rendered);
    expect(deriveIndexFromContent(rendered).items).toEqual(items);
  });
  it('removes the last line without losing surrounding text and inserts into itemless plans', () => {
    const body = '## Phase 1\n\nBefore.\n- **P-001** `todo` old\nAfter.\n\n## Decisions\n\nWhy.';
    const empty = renderPlanLines(body, []);
    expect(empty).toContain('Before.\nAfter.');
    expect(parsePlan(empty).items).toEqual([]);
    const items = deriveIndexFromContent('## Items\n- **P-002** `todo` new').items;
    expect(deriveIndexFromContent(renderPlanLines(empty, items)).items).toEqual(items);
  });
});
