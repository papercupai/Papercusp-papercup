/**
 * Pure-logic unit tests for plans:edit (the targeted old_string → new_string
 * verb). Exercises the exact-match guard + delegation to the shared
 * evaluateSetContent CAS/legacy/lint core, without the SU lock side-database.
 */

import { describe, expect, it } from 'vitest';
import { evaluatePlanEdit } from '../edit';
import { hashPlanContent } from '../content-hash';

const SLUG = 'test-plan-2026-05-21';

/** A minimal non-legacy plan that lints clean. */
const VALID = `---
title: Test Plan
slug: ${SLUG}
created: 2026-05-21
updated: 2026-05-21
status: active
---

# Test Plan

## Now

**State:** Where things stand. The widget runs at 22 fps.

**Next:** The next concrete action.

## Background

The widget runs at 22 fps in two places: 22 fps here.

## Decisions
`;

describe('evaluatePlanEdit — match guard', () => {
  it('not_found when the file is absent', async () => {
    const r = await evaluatePlanEdit(null, 'a', 'b', false, SLUG, undefined);
    expect(r.value.ok).toBe(false);
    expect(r.value.ok === false && r.value.code).toBe('not_found');
    expect(r.newBody).toBeNull();
  });

  it('no_change when old_string === new_string', async () => {
    const r = await evaluatePlanEdit(VALID, 'same', 'same', false, SLUG, undefined);
    expect(r.value.ok === false && r.value.code).toBe('no_change');
  });

  it('string_not_found when old_string is absent', async () => {
    const r = await evaluatePlanEdit(VALID, 'not-in-the-document', 'x', false, SLUG, undefined);
    expect(r.value.ok === false && r.value.code).toBe('string_not_found');
  });

  it('string_not_unique when old_string occurs >1 time without replace_all', async () => {
    const r = await evaluatePlanEdit(VALID, '22 fps', '30 fps', false, SLUG, undefined);
    expect(r.value.ok).toBe(false);
    if (r.value.ok === false && r.value.code === 'string_not_unique') {
      expect(r.value.count).toBe(3);
    } else {
      throw new Error('expected string_not_unique');
    }
  });
});

describe('evaluatePlanEdit — successful edits', () => {
  it('replaces a unique occurrence and returns the new body', async () => {
    const r = await evaluatePlanEdit(VALID, 'The next concrete action.', 'Ship the widget.', false, SLUG, undefined);
    expect(r.value.ok).toBe(true);
    expect(r.newBody).toContain('Ship the widget.');
    expect(r.newBody).not.toContain('The next concrete action.');
    // everything else preserved
    expect(r.newBody).toContain('## Now');
    expect(r.newBody).toContain('## Background');
  });

  it('replace_all rewrites every occurrence', async () => {
    const r = await evaluatePlanEdit(VALID, '22 fps', '30 fps', true, SLUG, undefined);
    expect(r.value.ok).toBe(true);
    expect(r.newBody).not.toContain('22 fps');
    expect((r.newBody!.match(/30 fps/g) ?? []).length).toBe(3);
  });

  it('new_string may be empty (deletes old_string)', async () => {
    const r = await evaluatePlanEdit(VALID, ' The widget runs at 22 fps.', '', false, SLUG, undefined);
    expect(r.value.ok).toBe(true);
    expect(r.newBody).not.toContain('runs at 22 fps.');
  });

  // EI-18693907749585513: this mirrors the SAME bug found + fixed in capability:edit
  // — `String.prototype.replace(old, new)` pattern-interprets `$`-sequences in the
  // replacement string even when the search side is a literal string. `` $` ``
  // expands to "everything before the match" and silently spliced the whole
  // document into itself. Every case must land verbatim, with no hidden duplication.
  describe('new_string containing JS String.replace special patterns lands verbatim', () => {
    const dollarCases: Array<[label: string, newString: string]> = [
      ['$&  (whole match)', 'prefix $& suffix'],
      ["$` (backtick — everything before the match)", 'prefix $` suffix'],
      ["$' (everything after the match)", "prefix $' suffix"],
      ['$1  (capture group, no regex used)', 'prefix $1 suffix'],
      ['$$  (literal dollar escape)', 'prefix $$ suffix'],
    ];

    for (const [label, newString] of dollarCases) {
      it(label, async () => {
        const r = await evaluatePlanEdit(VALID, 'The next concrete action.', newString, false, SLUG, undefined);
        expect(r.value.ok).toBe(true);
        const expected = VALID.replace('The next concrete action.', () => newString); // literal splice via callback form (never pattern-interpreted)
        expect(r.newBody).toBe(expected);
        expect(r.newBody!.length).toBe(VALID.length - 'The next concrete action.'.length + newString.length);
        // The corruption shape observed in production: the document's own
        // preceding content (starting with the frontmatter) spliced back in,
        // which would duplicate the `---` frontmatter delimiters beyond the
        // normal open+close pair.
        expect(r.newBody!.match(/^---$/gm)?.length ?? 0).toBe(2);
      });
    }
  });
});

describe('evaluatePlanEdit — CAS + lint inherited from evaluateSetContent', () => {
  it('rejects stale when expectedHash does not match', async () => {
    const r = await evaluatePlanEdit(VALID, 'concrete action', 'action', false, SLUG, 'deadbeef-not-the-hash');
    expect(r.value.ok === false && r.value.code).toBe('stale');
  });

  it('proceeds when expectedHash matches', async () => {
    const r = await evaluatePlanEdit(VALID, 'concrete action', 'action', false, SLUG, hashPlanContent(VALID));
    expect(r.value.ok).toBe(true);
  });

  it('routes plan lifecycle status changes through plans:set-plan-status', async () => {
    const r = await evaluatePlanEdit(VALID, 'status: active', 'status: shipped', false, SLUG, undefined);
    expect(r.newBody).toBeNull();
    expect(r.value).toMatchObject({
      ok: false,
      code: 'plan_status_change_requires_lifecycle_writer',
      currentStatus: 'active',
      proposedStatus: 'shipped',
      writer: 'plans:set-plan-status',
    });
    if (!r.value.ok && r.value.code === 'plan_status_change_requires_lifecycle_writer') {
      expect(r.value.message).toContain('plans:set-plan-status');
    }
  });

  it('rejects reopening a finished child under a terminal parent through the shared evaluator', async () => {
    const tick = String.fromCharCode(96);
    const terminal = VALID
      .replace('status: active', 'status: shipped')
      .replace(
        '## Decisions',
        [
          '## Phase 1 — Work',
          '',
          '- **P-001** ' + tick + 'done' + tick + ' Historical item',
          '',
          '## Decisions',
        ].join(String.fromCharCode(10)),
      );
    const result = await evaluatePlanEdit(
      terminal,
      tick + 'done' + tick + ' Historical item',
      tick + 'todo' + tick + ' Historical item',
      false,
      SLUG,
      hashPlanContent(terminal),
    );

    expect(result.newBody).toBeNull();
    expect(result.value).toMatchObject({
      ok: false,
      code: 'terminal_parent_child_mutation',
      parentStatus: 'shipped',
      changes: [{ itemId: 'P-001', kind: 'reopened', from: 'done', to: 'todo' }],
    });
  });

  it('lint_failed when the edit removes the required ## Now section', async () => {
    const r = await evaluatePlanEdit(VALID, '## Now', '## Nowww', false, SLUG, undefined);
    expect(r.value.ok === false && r.value.code).toBe('lint_failed');
  });
});
