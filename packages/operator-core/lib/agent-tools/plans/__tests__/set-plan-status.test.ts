/**
 * Pure-logic unit tests for plans:set-plan-status.
 *
 * The verb exports `flipPlanFrontmatterStatus` — the pure frontmatter
 * status-line flip — so the lifecycle transitions, the expectedCurrent
 * guard, the noop short-circuit, and the legacy/no-status refusal can
 * be verified without the SU lock side-database (mirrors
 * write-mutators.test.ts / phase5-mutators.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { applyPlanStatusBody, flipPlanFrontmatterStatus } from '../set-plan-status';

const plan = (status: string, body = '\n# Plan\n\n## Now\n\n**State:** x\n\n**Next:** y\n') =>
  `---\ntitle: P\nslug: p-2026-05-30\ncreated: 2026-05-30\nupdated: 2026-05-30\nstatus: ${status}\n---${body}`;

describe('flipPlanFrontmatterStatus', () => {
  it('approves: draft → ready', () => {
    const r = flipPlanFrontmatterStatus(plan('draft'), 'ready');
    expect(r.code).toBeUndefined();
    expect(r.oldStatus).toBe('draft');
    expect(r.newBody).toContain('status: ready');
    expect(r.newBody).not.toContain('status: draft');
  });

  it('demotes: ready → draft', () => {
    const r = flipPlanFrontmatterStatus(plan('ready'), 'draft');
    expect(r.oldStatus).toBe('ready');
    expect(r.newBody).toContain('status: draft');
  });

  it('ships and rejects', () => {
    expect(flipPlanFrontmatterStatus(plan('ready'), 'shipped').newBody).toContain('status: shipped');
    expect(flipPlanFrontmatterStatus(plan('draft'), 'superseded').newBody).toContain('status: superseded');
  });

  it('respects expectedCurrent — match flips, mismatch refuses', () => {
    const ok = flipPlanFrontmatterStatus(plan('draft'), 'ready', 'draft');
    expect(ok.newBody).toContain('status: ready');

    const bad = flipPlanFrontmatterStatus(plan('active'), 'ready', 'draft');
    expect(bad.code).toBe('unexpected_status');
    expect(bad.oldStatus).toBe('active');
    expect(bad.newBody).toBeNull();
  });

  it('noop when already at target (success, no write)', () => {
    const r = flipPlanFrontmatterStatus(plan('ready'), 'ready');
    expect(r.code).toBe('noop');
    expect(r.oldStatus).toBe('ready');
    expect(r.newBody).toBeNull();
  });

  it('refuses a legacy plan with no frontmatter / no status line', () => {
    expect(flipPlanFrontmatterStatus('# Just a body, no frontmatter\n', 'ready').code).toBe('no_status_line');
    expect(flipPlanFrontmatterStatus('---\ntitle: P\n---\n# body\n', 'ready').code).toBe('no_status_line');
  });

  it('only flips the frontmatter status line, leaving body + other keys intact', () => {
    const body = '\n# Plan\n\nProse mentioning status: draft inline stays.\n';
    const r = flipPlanFrontmatterStatus(plan('draft', body), 'ready');
    expect(r.newBody).toBe(plan('ready', body));
    // body prose untouched
    expect(r.newBody).toContain('Prose mentioning status: draft inline stays.');
    // other frontmatter keys untouched
    expect(r.newBody).toContain('title: P');
    expect(r.newBody).toContain('slug: p-2026-05-30');
  });
});

describe('applyPlanStatusBody — frontmatter flip only (derived-status P-006)', () => {
  // P-006 retired the WI-38303 terminal stamp: the status lives in the
  // frontmatter and readers derive "closed" from it, so a terminal flip
  // writes nothing into the Now.
  it('flips to shipped without writing into the Now', () => {
    const r = applyPlanStatusBody(plan('active'), 'shipped');
    expect(r.changed).toBe(true);
    expect(r.newBody).toContain('status: shipped');
    expect(r.newBody).toContain('**Next:** y');
    expect(r.newBody).not.toContain('PLAN CLOSED');
    expect(r).not.toHaveProperty('nowStamped');
  });

  it('is a true no-op on an already-terminal plan (no stamp repair)', () => {
    const r = applyPlanStatusBody(plan('superseded'), 'superseded');
    expect(r).toMatchObject({ code: 'noop', changed: false, newBody: null });
  });
});
