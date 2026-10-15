/**
 * Pure-logic unit tests for the Phase 5 write verbs
 * (plans:set-content + plans:set-frontmatter).
 *
 * Mirrors write-mutators.test.ts: the verbs export their pure decision
 * functions (`evaluateSetContent`, `buildFrontmatter`,
 * `applyFrontmatterBlock`) so the CAS / legacy-boundary / lint logic
 * and the frontmatter splice can be verified without the SU lock
 * side-database. Lock integration is covered by the concurrency test.
 */

import { describe, expect, it } from 'vitest';
import { evaluateSetContent } from '../set-content';
import { appendChunkToContent } from '../set-content-chunk';
import { buildFirstClassPlanBody, buildFrontmatter, applyFrontmatterBlock } from '../set-frontmatter';
import { hashPlanContent } from '../content-hash';

const SLUG = 'test-plan-2026-05-21';

/** A minimal non-legacy plan that lints clean — valid frontmatter,
 *  a `## Now` block, no items (so no item-level findings). */
const VALID = `---
title: Test Plan
slug: ${SLUG}
created: 2026-05-21
updated: 2026-05-21
status: active
---

# Test Plan

## Now

**State:** Where things stand.

**Next:** The next concrete action.

## Decisions
`;

/** Non-legacy (valid frontmatter) but missing the required `## Now`
 *  section — lints with a `missing_now_section` error. */
const NO_NOW = `---
title: Test Plan
slug: ${SLUG}
created: 2026-05-21
updated: 2026-05-21
status: active
---

# Test Plan

Just prose, no Now block.
`;

/** No frontmatter at all — parses legacy. */
const LEGACY = `# Some old plan

Free prose, never had frontmatter.
`;

describe('evaluateSetContent — CAS', () => {
  it('rejects not_found when the file is absent', async () => {
    const r = await evaluateSetContent(null, VALID, SLUG, undefined);
    expect(r.newBody).toBeNull();
    expect(r.value).toEqual({ ok: false, code: 'not_found' });
  });

  it('rejects stale when expectedHash does not match the live file', async () => {
    const r = await evaluateSetContent(VALID, VALID, SLUG, 'deadbeef-not-the-hash');
    expect(r.newBody).toBeNull();
    expect(r.value.ok).toBe(false);
    if (r.value.ok === false && r.value.code === 'stale') {
      expect(r.value.currentContent).toBe(VALID);
      expect(r.value.currentHash).toBe(hashPlanContent(VALID));
    } else {
      throw new Error('expected a stale rejection');
    }
  });

  it('proceeds when expectedHash matches the live file', async () => {
    const r = await evaluateSetContent(VALID, VALID, SLUG, hashPlanContent(VALID));
    expect(r.value.ok).toBe(true);
    expect(r.newBody).toBe(VALID);
  });

  it('proceeds when expectedHash is omitted (CAS check skipped)', async () => {
    const r = await evaluateSetContent(VALID, VALID, SLUG, undefined);
    expect(r.value.ok).toBe(true);
  });

  // plans-pg-canonical-migration D-005: optimistic version CAS (preferred over hash).
  it('rejects stale when expectedVersion does not match the live row version', async () => {
    const r = await evaluateSetContent(VALID, VALID, SLUG, undefined, {
      expectedVersion: 999,
      meta: { version: 1, contentHash: hashPlanContent(VALID) },
    });
    expect(r.newBody).toBeNull();
    expect(r.value.ok).toBe(false);
    if (r.value.ok === false && r.value.code === 'stale') {
      expect(r.value.currentVersion).toBe(1);
    } else {
      throw new Error('expected a stale rejection');
    }
  });

  it('proceeds when expectedVersion matches the live row version', async () => {
    const r = await evaluateSetContent(VALID, VALID, SLUG, undefined, {
      expectedVersion: 1,
      meta: { version: 1, contentHash: hashPlanContent(VALID) },
    });
    expect(r.value.ok).toBe(true);
    expect(r.newBody).toBe(VALID);
  });
});

describe('evaluateSetContent — legacy-boundary guard', () => {
  it('rejects a write that carries its OWN incomplete frontmatter (a real legacy degrade)', async () => {
    // EI-1812: a body that simply OMITS frontmatter is now re-attached (the canonical
    // frontmatter lives in PG columns), NOT treated as a degrade — see
    // set-content-shrink-guard.test.ts. The legacy-boundary guard still fires when the
    // proposed body carries its OWN partial frontmatter that drops slug:/status:, which
    // re-attach intentionally skips (a body already starting with a `---…---` block).
    const PARTIAL = `---\ntitle: Some old plan\n---\n\n${LEGACY}`;
    const r = await evaluateSetContent(VALID, PARTIAL, SLUG, undefined);
    expect(r.newBody).toBeNull();
    expect(r.value).toEqual({ ok: false, code: 'would_orphan_frontmatter' });
  });

  it('allows a legacy→legacy write (no real frontmatter to orphan)', async () => {
    // current is legacy, proposed is legacy — the guard does not fire.
    // (It still has to clear lint, but legacy plans are lint-exempt.)
    const r = await evaluateSetContent(LEGACY, LEGACY, SLUG, undefined);
    expect(r.value.ok).toBe(true);
  });
});

describe('evaluateSetContent — lint gate', () => {
  it('rejects a proposed body that fails lint, returning the findings', async () => {
    const r = await evaluateSetContent(VALID, NO_NOW, SLUG, undefined);
    expect(r.newBody).toBeNull();
    expect(r.value.ok).toBe(false);
    if (r.value.ok === false && r.value.code === 'lint_failed') {
      expect(r.value.errors.some((e) => e.code === 'missing_now_section')).toBe(true);
    } else {
      throw new Error('expected a lint_failed rejection');
    }
  });

  it('accepts a clean proposed body and returns its contentHash', async () => {
    const r = await evaluateSetContent(VALID, VALID, SLUG, undefined);
    expect(r.newBody).toBe(VALID);
    if (r.value.ok) {
      expect(r.value.slug).toBe(SLUG);
      expect(r.value.contentHash).toBe(hashPlanContent(VALID));
    } else {
      throw new Error('expected ok');
    }
  });
});


describe('appendChunkToContent', () => {
  it('builds a body from multiple chunks without adding separators', () => {
    const chunks = ['---\n', 'title: Chunked\n', '---\n\n# Chunked\n'];
    expect(chunks.reduce((body, chunk) => appendChunkToContent(body, chunk), '')).toBe(
      '---\ntitle: Chunked\n---\n\n# Chunked\n',
    );
  });

  it('leaves content unchanged when commit supplies no final chunk', () => {
    expect(appendChunkToContent('already staged', undefined)).toBe('already staged');
  });
});
describe('hashPlanContent', () => {
  it('is deterministic', () => {
    expect(hashPlanContent(VALID)).toBe(hashPlanContent(VALID));
  });
  it('differs for different content', () => {
    expect(hashPlanContent(VALID)).not.toBe(hashPlanContent(VALID + ' '));
  });
  it('is a 64-char sha256 hex digest', () => {
    expect(hashPlanContent(VALID)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('buildFrontmatter', () => {
  it('emits a complete valid block with owner', () => {
    const fm = buildFrontmatter(
      { slug: SLUG, title: 'My Plan', status: 'draft', created: '2026-01-02', owner: 'a@b.c' },
      '2026-05-21',
    );
    expect(fm).toBe(
      [
        '---',
        'title: My Plan',
        `slug: ${SLUG}`,
        'created: 2026-01-02',
        'updated: 2026-05-21',
        'status: draft',
        'owner: a@b.c',
        '---',
      ].join('\n'),
    );
  });

  it('omits the owner line when no owner is given', () => {
    const fm = buildFrontmatter(
      { slug: SLUG, title: 'My Plan', status: 'active' },
      '2026-05-21',
    );
    expect(fm).not.toContain('owner:');
    expect(fm).toContain('status: active');
  });

  it('defaults created to today when omitted', () => {
    const fm = buildFrontmatter(
      { slug: SLUG, title: 'My Plan', status: 'active' },
      '2026-05-21',
    );
    expect(fm).toContain('created: 2026-05-21');
  });

  it('collapses newlines in the title to keep the block one-line-per-field', () => {
    const fm = buildFrontmatter(
      { slug: SLUG, title: 'Line one\nline two', status: 'active' },
      '2026-05-21',
    );
    expect(fm).toContain('title: Line one line two');
    expect(fm.split('\n').filter((l) => l.startsWith('title:'))).toHaveLength(1);
  });
});

describe('applyFrontmatterBlock', () => {
  const FM = '---\ntitle: T\nslug: s\n---';

  it('prepends a block to a file with no frontmatter', () => {
    const out = applyFrontmatterBlock('# Heading\n\nbody.\n', FM);
    expect(out).toBe(FM + '\n\n# Heading\n\nbody.\n');
  });

  it('replaces an existing malformed leading block, keeping the body', () => {
    const legacyWithBadFm = '---\ngarbage\n---\n\n# Real Body\n\ncontent.\n';
    const out = applyFrontmatterBlock(legacyWithBadFm, FM);
    expect(out).toBe(FM + '\n\n# Real Body\n\ncontent.\n');
    expect(out).not.toContain('garbage');
  });

  it('treats a leading --- with no closing --- as no frontmatter (prepends)', () => {
    const noClose = '---\nstuff with no close\n\n# Body\n';
    const out = applyFrontmatterBlock(noClose, FM);
    expect(out).toBe(FM + '\n\n' + noClose);
  });
});

describe('buildFirstClassPlanBody — no Now stamp (derived-status P-006)', () => {
  // P-006 retired the WI-38303 terminal stamp: status is derived from the
  // frontmatter, so converting a legacy plan only writes the frontmatter and
  // leaves the author's Now exactly as written.
  it('converts a legacy plan straight to a terminal status without touching its Now', () => {
    const now = '## Now\n\n**State:** historical\n\n**Next:** do finished work\n';
    const legacy = `# Plan\n\n${now}`;
    const out = buildFirstClassPlanBody(
      legacy,
      { slug: SLUG, title: 'My Plan', status: 'shipped' },
      '2026-08-13',
    );
    expect(Object.keys(out)).toEqual(['body']);
    expect(out.body).toContain('status: shipped');
    expect(out.body).toContain(now);
    expect(out.body).not.toContain('PLAN CLOSED');
    expect(out.body).not.toContain('no longer actionable');
  });

  it('converts a legacy plan to a non-terminal status without touching its Now', () => {
    const now = '## Now\n\n**Next:** do current work\n';
    const out = buildFirstClassPlanBody(
      `# Plan\n\n${now}`,
      { slug: SLUG, title: 'My Plan', status: 'ready' },
      '2026-08-13',
    );
    expect(out.body).toContain(now);
  });
});
