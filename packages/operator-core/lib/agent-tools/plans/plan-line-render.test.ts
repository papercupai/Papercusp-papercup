import { describe, expect, it } from 'vitest';
import { formatOperationalProgressNote, parsePlan } from '@papercusp/plan-parser';
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
  it('preserves classified progress notes when graph-owned item text is rendered', () => {
    const note = formatOperationalProgressNote('Running the verification');
    const body = '## Phase 1\n- **P-001** \x60todo\x60 Preserve findings' + note + '\n';
    const item = deriveIndexFromContent(body).items[0]!;
    expect(item.text).toBe('Preserve findings');
    expect(renderPlanLines(body, [item])).toContain(note);
    const updated = renderPlanLines(body, [{ ...item, text: 'Updated findings' }]);
    expect(updated).toContain('Updated findings');
    expect(updated).toContain(note);
    expect(deriveIndexFromContent(updated).items[0]!.text).toBe('Updated findings');
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
  it('consumes wrapped acceptance once across repeated graph read and write cycles', () => {
    const body = '---\ntitle: title\nslug: probe\nstatus: ready\n---\n\n## Phase 1\n\n- **P-001** `todo` Ship the journey.\n  Acceptance: preserve employee and reviewer evidence.\n  blocked-by: P-002 importance: high\n\n  This separate paragraph belongs to the author.\n\n- **P-002** `done` Prerequisite.\n';
    const items = deriveIndexFromContent(body).items;
    let rendered = renderPlanLines(body, items);
    expect(rendered.match(/Acceptance:/g)).toHaveLength(1);
    expect(deriveIndexFromContent(rendered).items).toEqual(items);
    expect(rendered).toContain('\n\n  This separate paragraph belongs to the author.\n');
    for (let cycle = 0; cycle < 3; cycle++) {
      const next = renderPlanLines(rendered, deriveIndexFromContent(rendered).items);
      expect(next).toBe(rendered);
      rendered = next;
    }
  });
  it('removes a deleted item continuation while preserving nested blocks and following prose', () => {
    const body = '## Phase 1\n\n- **P-001** `todo` Old journey.\n  Acceptance: old evidence.\n  - Nested author list.\n\nAfter.\n';
    expect(renderPlanLines(body, [])).toBe('## Phase 1\n\n  - Nested author list.\n\nAfter.\n');
  });
});
