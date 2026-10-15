/**
 * set-now.note-only.test.ts — derived-status-not-hand-written-2026-10-12 P-006.
 *
 * The Now note is a note, not a status claim. Plan status is derived at read
 * time (P-001 `derivedStatus`), the note carries its own date and age (P-003,
 * P-004), and the dashboard marks a note the plan has moved past (P-005). So the
 * mechanisms that existed only to police hand-written Now status are retired:
 *
 *   - the terminal Now stamp (`⛔ PLAN CLOSED` banner on ship/supersede),
 *   - the greenlit Now stamp (`✅ PLAN GREENLIT` banner on draft → ready),
 *   - the plans:set-now `now_item_status_contradiction` refusal.
 *
 * Clauses: AUTO-BAR-R-5-P-006 (set-now accepts a note that names a finished
 * item; no stamp is prepended on ship or greenlight) and SPEC-P-006 (shipping
 * leaves the content without a terminal Now stamp).
 *
 * Expected values are literals written here, never values computed by the code
 * under test. The two banner marks are spelled out because their modules are
 * deleted by this item.
 */
import { describe, expect, it } from 'vitest';
import { evaluateNowUpdate } from './set-now';
import { applyPlanStatusBody } from './set-plan-status';
import { buildFirstClassPlanBody } from './set-frontmatter';
import { evaluateSetContent } from './set-content';

const SLUG = 'set-now-note-only-2026-10-12';
const CLOSED_MARK = '⛔ PLAN CLOSED';
const GREENLIT_MARK = '✅ PLAN GREENLIT';

const NOW_SECTION =
  '## Now\n\n' +
  '**State:** Draft — awaiting triage; not active until greenlit.\n\n' +
  '**Next:** Continue with P-001, then claim P-002.\n';

function plan(status: string, items: string): string {
  return (
    `---\ntitle: Note only\nslug: ${SLUG}\nstatus: ${status}\ncreated: 2026-10-12\nupdated: 2026-10-12\n---\n\n` +
    `# Note only\n\n${NOW_SECTION}\n## Phase 1\n\n${items}\n\n## Decisions\n`
  );
}

const ONE_DONE = '- **P-001** `done` Finished item.\n- **P-002** `todo` Open item.';
const ALL_DONE = '- **P-001** `done` Finished item.\n- **P-002** `done` Finished item.';

/** The `## Now` section exactly as it sits in a plan body. */
function nowSection(body: string): string {
  const start = body.indexOf('## Now');
  const end = body.indexOf('\n## ', start + 1);
  return body.slice(start, end);
}

describe('plans:set-now accepts a note that names a finished item (AUTO-BAR-R-5-P-006)', () => {
  it('stores a Next that directs work at a done item', () => {
    const r = evaluateNowUpdate(plan('active', ONE_DONE), 'P-001 landed.', 'Continue with P-001.', SLUG, {
      author: 'su-test',
      eventId: null,
    });
    expect(r.value).toEqual({ ok: true });
    expect(r.newBody).toBeNull();
    expect(r.nowNote?.state).toBe('P-001 landed.');
    expect(r.nowNote?.next).toBe('Continue with P-001.');
    expect(r.nowNote?.author).toBe('su-test');
  });

  it('stores a State that presents a done item as current work', () => {
    const r = evaluateNowUpdate(plan('active', ONE_DONE), 'Working on P-001 now.', 'Finish P-001.', SLUG, {
      author: 'su-test',
      eventId: null,
    });
    expect(r.value).toEqual({ ok: true });
    expect(r.nowNote?.state).toBe('Working on P-001 now.');
    expect(r.nowNote?.next).toBe('Finish P-001.');
  });

  it('stores a note on a plan whose items are all done', () => {
    const r = evaluateNowUpdate(plan('active', ALL_DONE), 'Both items landed.', 'Claim P-002 for review.', SLUG, {
      author: 'su-test',
      eventId: null,
    });
    expect(r.value).toEqual({ ok: true });
    expect(r.nowNote?.next).toBe('Claim P-002 for review.');
  });

  it('still refuses an exhaustive Next that omits a live item (the omission guard is not retired)', () => {
    const threeItems = `${ONE_DONE}\n- **P-003** \`todo\` Another open item.`;
    const r = evaluateNowUpdate(plan('active', threeItems), 'Work remains.', 'P-002 only, and it is not actionable yet.', SLUG, {
      author: 'su-test',
      eventId: null,
    });
    expect(r.value.ok).toBe(false);
    expect(r.value).toMatchObject({ ok: false, code: 'now_item_omission' });
    expect(r.nowNote).toBeUndefined();
  });
});

describe('a lifecycle flip leaves the Now section unstamped (SPEC-P-006, AUTO-BAR-R-5-P-006)', () => {
  it('shipping flips only the status line; the Now section is byte-identical', () => {
    const before = plan('active', ALL_DONE);
    const r = applyPlanStatusBody(before, 'shipped');
    expect(r.changed).toBe(true);
    expect(r.oldStatus).toBe('active');
    expect(r.newBody).toBe(before.replace('status: active', 'status: shipped'));
    expect(r.newBody).not.toContain(CLOSED_MARK);
    expect(nowSection(r.newBody!)).toBe(nowSection(before));
  });

  it('superseding does not stamp either', () => {
    const before = plan('active', ALL_DONE);
    const r = applyPlanStatusBody(before, 'superseded');
    expect(r.newBody).toBe(before.replace('status: active', 'status: superseded'));
    expect(r.newBody).not.toContain(CLOSED_MARK);
  });

  it('re-applying shipped to an unstamped shipped plan is a no-op, not a repair stamp', () => {
    const r = applyPlanStatusBody(plan('shipped', ALL_DONE), 'shipped');
    expect(r).toMatchObject({ code: 'noop', changed: false, newBody: null });
  });

  it('greenlighting a draft (draft -> ready) prepends no banner', () => {
    const before = plan('draft', ONE_DONE);
    const r = applyPlanStatusBody(before, 'ready');
    expect(r.changed).toBe(true);
    expect(r.newBody).toBe(before.replace('status: draft', 'status: ready'));
    expect(r.newBody).not.toContain(GREENLIT_MARK);
    expect(nowSection(r.newBody!)).toContain('not active until greenlit');
  });

  it('a legacy conversion to ready or shipped keeps the Now section as written', () => {
    const legacy = `# Plan\n\n${NOW_SECTION}`;
    for (const status of ['ready', 'shipped']) {
      const out = buildFirstClassPlanBody(legacy, { slug: SLUG, title: 'Note only', status }, '2026-10-13');
      expect(out.body).not.toContain(CLOSED_MARK);
      expect(out.body).not.toContain(GREENLIT_MARK);
      expect(nowSection(out.body)).toBe(nowSection(legacy));
    }
  });

  it('a raw content write to a shipped plan is stored as written', async () => {
    const terminal = plan('shipped', ALL_DONE);
    const proposed = terminal.replace('# Note only\n', '# Note only\n\nHistorical note added after ship.\n');
    const { newBody, value } = await evaluateSetContent(terminal, proposed, SLUG, undefined, { allowShrink: true });
    expect(value.ok).toBe(true);
    expect(newBody).toBe(proposed);
  });
});
