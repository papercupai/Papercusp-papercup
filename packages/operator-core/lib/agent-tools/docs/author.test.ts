/**
 * docs:author pure-helper tests — the footgun-prevention logic (EI-5260):
 * slug/section validation, frontmatter generation, leading-frontmatter strip,
 * and list normalization. The FS + anchor integration is covered by the live
 * smoke; these lock the wrong-dir / bad-frontmatter / clobber guards.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeSlug,
  normalizeSection,
  DOCS_ROOT_SECTION,
  docRefFor,
  insightsIndexNudge,
  stripLeadingFrontmatter,
  normalizeList,
  buildFrontmatter,
  composeDoc,
  parseExistingFrontmatter,
  todayIso,
  discoveredForWrite,
  resolveAuthorHarness,
  descriptionLengthWarning,
  DESCRIPTION_RECOMMENDED_MAX,
  DESCRIPTION_HARD_MAX,
  truncatedBodyVerdict,
  overwriteShrinkVerdict,
  canonicalSourceHint,
  droppedFrontmatterEdits,
  stripReadPreamble,
  SHRINK_REFUSAL_RATIO,
  SHRINK_REFUSAL_MIN_LOSS,
  type FrontmatterInput,
} from './author';
import { MAX_PAYLOAD_BYTES, truncationTail } from '@papercusp/docs-engine';
import { resolveHarnessScope } from '../_harness-scope';
// The SAME parser the anchor system uses to read a doc's `documents:` frontmatter.
// docs:author and harness_docs:anchor must agree on the format or the doc ships
// un-anchored (the EI-4889 class). This round-trips them against each other.
import { frontmatterDocuments } from '../../harness/docs/manual-anchor';

describe('normalizeSlug', () => {
  it('accepts a kebab slug and lowercases', () => {
    expect(normalizeSlug('My-New-Insight')).toEqual({ ok: true, slug: 'my-new-insight' });
  });
  it('strips a trailing .mdx / .md', () => {
    expect(normalizeSlug('foo.mdx')).toEqual({ ok: true, slug: 'foo' });
    expect(normalizeSlug('foo.md')).toEqual({ ok: true, slug: 'foo' });
  });
  it('routes a canonical section/slug path into section plus the final slug', () => {
    expect(normalizeSlug('agent-insights/foo')).toEqual({ ok: true, slug: 'foo', section: 'agent-insights' });
    expect(normalizeSlug('system/decisions/foo.mdx')).toEqual({ ok: true, slug: 'foo', section: 'system/decisions' });
  });
  it('rejects backslash paths rather than treating them as platform-specific sections', () => {
    const r = normalizeSlug('agent-insights\\foo');
    expect(r).toEqual({ ok: false, error: 'slug_must_use_forward_slashes — use `<section>/<slug>` for a canonical doc path' });
  });
  it('rejects non-kebab characters', () => {
    expect(normalizeSlug('foo_bar').ok).toBe(false);
    expect(normalizeSlug('Foo Bar').ok).toBe(false);
    expect(normalizeSlug('').ok).toBe(false);
  });
});

describe('normalizeSection', () => {
  it('defaults to agent-insights', () => {
    expect(normalizeSection(undefined)).toEqual({ ok: true, section: 'agent-insights' });
    expect(normalizeSection('')).toEqual({ ok: true, section: 'agent-insights' });
  });
  it('trims surrounding slashes', () => {
    expect(normalizeSection('/system/')).toEqual({ ok: true, section: 'system' });
  });
  it('rejects path traversal', () => {
    expect(normalizeSection('../etc').ok).toBe(false);
    expect(normalizeSection('a/../b').ok).toBe(false);
  });
  it('allows nested kebab dirs', () => {
    expect(normalizeSection('spec/decisions')).toEqual({ ok: true, section: 'spec/decisions' });
  });
});

// WI-6554700010011197: root-level docs (branding.mdx, index.mdx, performance.mdx) were
// unreachable — '' fell to agent-insights and '.' is rejected. The root is addressable
// only EXPLICITLY, so a bare slug keeps the agent-insights default.
describe('docs-root section (WI-6554700010011197)', () => {
  it('an all-slash section is the docs root', () => {
    expect(normalizeSection('/')).toEqual({ ok: true, section: DOCS_ROOT_SECTION });
    expect(normalizeSection(' // ')).toEqual({ ok: true, section: DOCS_ROOT_SECTION });
  });
  it('absent / empty sections keep the agent-insights default, never the root', () => {
    expect(normalizeSection(undefined)).toEqual({ ok: true, section: 'agent-insights' });
    expect(normalizeSection('')).toEqual({ ok: true, section: 'agent-insights' });
    expect(normalizeSlug('branding.mdx')).toEqual({ ok: true, slug: 'branding' });
  });
  it('a leading-slash slug with no dir is docs-root-absolute (and agrees with "//")', () => {
    expect(normalizeSlug('/branding.mdx')).toEqual({ ok: true, slug: 'branding', section: DOCS_ROOT_SECTION });
    expect(normalizeSlug('//branding')).toEqual({ ok: true, slug: 'branding', section: DOCS_ROOT_SECTION });
    expect(normalizeSlug('/system/foo')).toEqual({ ok: true, slug: 'foo', section: 'system' });
  });
  it('docRefFor composes the root ref without a dir, and every other section with one', () => {
    expect(docRefFor(DOCS_ROOT_SECTION, 'branding')).toEqual({ ref: 'branding', docId: 'branding.mdx' });
    expect(docRefFor('agent-insights', 'x')).toEqual({ ref: 'agent-insights/x', docId: 'agent-insights/x.mdx' });
    expect(docRefFor('spec/decisions', 'd-1')).toEqual({ ref: 'spec/decisions/d-1', docId: 'spec/decisions/d-1.mdx' });
  });
});

describe('insightsIndexNudge', () => {
  it('nudges for a papercusp agent-insights doc (the only dir the generator reads)', () => {
    const msg = insightsIndexNudge('agent-insights', 'papercusp');
    expect(msg).toContain('gen:doc-insights-index');
  });
  it('stays silent for another section in papercusp', () => {
    expect(insightsIndexNudge('system', 'papercusp')).toBeNull();
    expect(insightsIndexNudge('spec/decisions', 'papercusp')).toBeNull();
  });
  it('stays silent for a harness-scoped agent-insights dir — the generator does not read it', () => {
    expect(insightsIndexNudge('agent-insights', 'some-other-harness')).toBeNull();
  });
});

describe('resolveAuthorHarness (EI-20100921170504541)', () => {
  // The regression: docs:search's own schema tells a workspace-scoped caller to reach
  // the agent-insights corpus with harness:'engineering'. Handing that same literal
  // back to docs:author used to fail `unknown_harness`, so the two halves of ONE
  // workflow disagreed about the same corpus.
  it("accepts 'engineering' — the same literal docs:search takes for this corpus", () => {
    expect(resolveAuthorHarness('engineering', { harnessSlug: 'papercusp-workspace' })).toEqual({
      ok: true,
      harnessSlug: 'papercusp',
      engineering: true,
    });
  });

  // Both resolve to the same docs root, but they are different INTENTS and the emitted
  // `surface` metadata reports them apart — so collapsing them would lose a signal.
  it("distinguishes the engineering reference from the 'papercusp' harness named explicitly", () => {
    expect(resolveAuthorHarness('papercusp', {})).toEqual({
      ok: true,
      harnessSlug: 'papercusp',
      engineering: false,
    });
    expect(resolveAuthorHarness('engineering', {})).toEqual({
      ok: true,
      harnessSlug: 'papercusp',
      engineering: true,
    });
  });

  it("treats 'engineering' identically to omitting it, and to the 'all' sentinel", () => {
    const viaSentinel = resolveAuthorHarness('engineering', { isSuperuser: true });
    const viaOmission = resolveAuthorHarness(undefined, { isSuperuser: true });
    const viaAll = resolveAuthorHarness('all', {});
    const viaStar = resolveAuthorHarness('*', {});
    expect(viaSentinel).toEqual(viaOmission);
    expect(viaSentinel).toEqual(viaAll);
    expect(viaSentinel).toEqual(viaStar);
  });

  it('matches the sentinel case-insensitively and around whitespace', () => {
    for (const v of ['ENGINEERING', ' engineering ', 'Engineering']) {
      expect(resolveAuthorHarness(v, {})).toEqual({ ok: true, harnessSlug: 'papercusp', engineering: true });
    }
  });

  it('still routes a concrete slug to that harness, and ctx scope when no arg', () => {
    expect(resolveAuthorHarness('some-harness', {})).toEqual({
      ok: true,
      harnessSlug: 'some-harness',
      engineering: false,
    });
    expect(resolveAuthorHarness(undefined, { harnessSlug: 'scoped-harness' })).toEqual({
      ok: true,
      harnessSlug: 'scoped-harness',
      engineering: false,
    });
  });

  it('fails with an error naming the FIX, not just a registry miss', () => {
    const r = resolveAuthorHarness(undefined, { harnessSlug: '*', isSuperuser: false });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    // The old failure said only "<slug> is not registered", which reads as "that corpus
    // is unreachable from here" — the opposite of true.
    expect(r.error).toMatch(/engineering/);
    expect(r.error).toMatch(/omit/i);
  });

  // SECURITY-RELEVANT, and the reason this fix lives in docs:author rather than in the
  // shared resolver: `resolveHarnessScope` is also used by `plans:*` and
  // `harness_docs:*`, and the 'engineering' literal is deliberately INVISIBLE to the
  // _mcp-handler workspace clamp (that is its whole purpose — EI-18894866320087268).
  // Teaching the shared resolver about it would silently hand every one of those tools
  // a cross-harness escape the clamp cannot see, across a TENANT-data boundary rather
  // than a docs one. If this test ever fails, that widening has happened — do not
  // "fix" it by updating the expectation.
  it('does NOT widen the shared resolver — plans:*/harness_docs:* must not inherit the sentinel', () => {
    expect(resolveHarnessScope('engineering', {})).toEqual({ kind: 'harness', slug: 'engineering' });
  });
});

describe('descriptionLengthWarning (EI-20100921170504541, second half)', () => {
  it('is silent at or under the recommended length', () => {
    expect(descriptionLengthWarning('short')).toBeNull();
    expect(descriptionLengthWarning('x'.repeat(DESCRIPTION_RECOMMENDED_MAX))).toBeNull();
  });

  it('warns — rather than rejecting — just over the recommendation, and reports the count', () => {
    // 618 chars is the measured real case: a hard reject there cost a resend of the
    // whole call, body included (~6k tokens), for overshooting a display field.
    const w = descriptionLengthWarning('x'.repeat(618));
    expect(w).toBeTruthy();
    expect(w).toContain('618');
    expect(w).toContain(String(DESCRIPTION_RECOMMENDED_MAX));
  });

  it('leaves real headroom above the recommendation before anything is refused', () => {
    expect(DESCRIPTION_HARD_MAX).toBeGreaterThan(DESCRIPTION_RECOMMENDED_MAX);
    expect(descriptionLengthWarning('x'.repeat(DESCRIPTION_HARD_MAX))).toBeTruthy();
  });
});

describe('stripLeadingFrontmatter', () => {
  it('strips a leading --- block', () => {
    const r = stripLeadingFrontmatter('---\ntitle: x\n---\n\nBody here');
    expect(r.stripped).toBe(true);
    expect(r.body.trimStart()).toBe('Body here');
  });
  it('leaves a body without frontmatter untouched', () => {
    const r = stripLeadingFrontmatter('# Heading\n\ntext');
    expect(r.stripped).toBe(false);
    expect(r.body).toBe('# Heading\n\ntext');
  });
  it('does not strip a mid-body --- (only a leading block)', () => {
    const body = 'intro\n\n---\n\nmore';
    const r = stripLeadingFrontmatter(body);
    expect(r.stripped).toBe(false);
    expect(r.body).toBe(body);
  });
});

/**
 * WI-1511581 — a discarded frontmatter EDIT must not read as a clean write.
 *
 * `docs:get { source: true }` returns the doc WITH its frontmatter, which is the
 * read this tool's refusals now point at, so a round-tripped body carries a block
 * by design. The block is discarded (a body read minutes ago must not revert a
 * peer's metadata write) — but an author who edited `title:` inside it needs to be
 * told, or they get a success with their edit silently missing.
 *
 * The quiet-on-the-faithful-path case is the load-bearing one: a warning that fires
 * on every correct round trip is noise, and noise stops being read.
 */
describe('droppedFrontmatterEdits', () => {
  const stored = { title: 'Old', description: 'desc', tags: ['a', 'b'], status: 'active' };

  it('is SILENT when the submitted block matches what will be written', () => {
    expect(droppedFrontmatterEdits(stored, { ...stored })).toEqual([]);
  });

  it('names an edited key — the case a clean-looking success would hide', () => {
    expect(droppedFrontmatterEdits({ ...stored, title: 'New title' }, stored)).toEqual(['title']);
  });

  it('names several edited keys, sorted, and only those', () => {
    expect(
      droppedFrontmatterEdits({ ...stored, title: 'New', tags: ['a', 'b', 'c'] }, stored),
    ).toEqual(['tags', 'title']);
  });

  it('treats list order/format differences as equal — normalizeList is the comparison', () => {
    expect(droppedFrontmatterEdits({ tags: 'a, b' }, { tags: ['a', 'b'] })).toEqual([]);
  });

  it('ignores whitespace-only differences in scalars', () => {
    expect(droppedFrontmatterEdits({ title: ' Old ' }, { title: 'Old' })).toEqual([]);
  });

  it('reports a key the submitted block adds that the write will not carry', () => {
    expect(droppedFrontmatterEdits({ ...stored, custom: 'mine' }, stored)).toEqual(['custom']);
  });

  it('says nothing about a stored key the submitted block simply lacks', () => {
    // Absent from the submission is not an edit — it is what a body with no
    // frontmatter looks like, and preservedFrontmatter carries it through anyway.
    expect(droppedFrontmatterEdits({ title: 'Old' }, stored)).toEqual([]);
  });
});

describe('normalizeList', () => {
  it('handles string, array, comma-join, dedupe, trim', () => {
    expect(normalizeList('a, b ,a')).toEqual(['a', 'b']);
    expect(normalizeList(['a', ' b', 'a'])).toEqual(['a', 'b']);
    expect(normalizeList(['a,b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(normalizeList(undefined)).toEqual([]);
    expect(normalizeList('')).toEqual([]);
  });
});

const base: FrontmatterInput = {
  title: 'A title: with a colon',
  description: 'one line desc',
  discovered: '2026-06-30',
  status: 'active',
  type: 'Insight',
  tags: [],
  documents: [],
  plans: [],
};

describe('buildFrontmatter', () => {

  it('quotes title/description (colons stay valid YAML) and emits required keys', () => {
    const fm = buildFrontmatter(base);
    expect(fm.startsWith('---\n')).toBe(true);
    expect(fm.endsWith('\n---')).toBe(true);
    expect(fm).toContain('title: "A title: with a colon"');
    expect(fm).toContain('description: "one line desc"');
    expect(fm).toContain('discovered: 2026-06-30');
    expect(fm).toContain('status: active');
  });

  it('normalizes historical status aliases before persistence', () => {
    expect(buildFrontmatter({ ...base, status: 'current' })).toContain('status: active');
    expect(buildFrontmatter({ ...base, status: 'retired' })).toContain('status: superseded');
  });

  it('omits empty tags/documents/plans/sidebar', () => {
    const fm = buildFrontmatter(base);
    expect(fm).not.toContain('tags:');
    expect(fm).not.toContain('documents:');
    expect(fm).not.toContain('plans:');
    expect(fm).not.toContain('sidebar:');
  });

  it('emits inline tags, block documents/plans, and sidebar order', () => {
    const fm = buildFrontmatter({
      ...base,
      tags: ['plans', 'federation'],
      documents: ['packages/a/b.ts', 'packages/a/b.ts :: fn'],
      plans: ['my-plan-2026-06-30'],
      sidebarOrder: 13,
    });
    expect(fm).toContain('tags: ["plans", "federation"]');
    expect(fm).toContain('documents:\n  - "packages/a/b.ts"\n  - "packages/a/b.ts :: fn"');
    expect(fm).toContain('plans:\n  - "my-plan-2026-06-30"');
    expect(fm).toContain('sidebar:\n  order: 13');
  });
});

describe('overwrite frontmatter preservation', () => {
  const existing = `---
title: "Existing convention"
description: "Existing description"
type: Convention
discovered: 2026-07-01
tags: [old-tag]
status: current
documents:
  - "packages/existing.ts"
plans:
  - existing-plan
sidebar:
  order: 7
normative: true
governs:
  - an existing convention
generated:
  by: agent
  at: 2026-07-01
---

# Existing body
`;

  it('parses persisted frontmatter dates as strings and keeps unknown mappings', () => {
    const parsed = parseExistingFrontmatter(existing);
    expect(parsed.discovered).toBe('2026-07-01');
    expect(parsed.generated).toEqual({ by: 'agent', at: '2026-07-01' });
  });

  it('restores explicit normative/governs while preserving undeclared metadata on overwrite', () => {
    const preservedFrontmatter = parseExistingFrontmatter(existing);
    const content = composeDoc(
      {
        ...base,
        status: 'current',
        type: 'Convention',
        tags: normalizeList(preservedFrontmatter.tags),
        documents: normalizeList(preservedFrontmatter.documents),
        plans: normalizeList(preservedFrontmatter.plans),
        sidebarOrder: 7,
        normative: true,
        governs: normalizeList(preservedFrontmatter.governs),
        preservedFrontmatter,
      },
      '# Re-authored body',
    );
    const parsed = parseExistingFrontmatter(content);
    expect(parsed.normative).toBe(true);
    expect(parsed.governs).toEqual(['an existing convention']);
    expect(parsed.generated).toEqual({ by: 'agent', at: '2026-07-01' });
    expect(parsed.status).toBe('active');
    expect(parsed.sidebar).toEqual({ order: 7 });
  });

  it('lets explicit false and empty lists clear inherited owned fields', () => {
    const preservedFrontmatter = parseExistingFrontmatter(existing);
    const content = composeDoc(
      {
        ...base,
        normative: false,
        governs: [],
        tags: [],
        documents: [],
        plans: [],
        preservedFrontmatter,
      },
      '# Re-authored body',
    );
    const parsed = parseExistingFrontmatter(content);
    expect(parsed.normative).toBe(false);
    expect(parsed.governs).toEqual([]);
    expect(parsed.tags).toBeUndefined();
    expect(parsed.documents).toBeUndefined();
    expect(parsed.plans).toBeUndefined();
    expect(parsed.generated).toEqual({ by: 'agent', at: '2026-07-01' });
  });
});

describe('composeDoc', () => {
  it('strips a leading frontmatter from body and reassembles with generated frontmatter + trailing newline', () => {
    const fm: FrontmatterInput = {
      title: 'T',
      description: 'D',
      discovered: '2026-06-30',
      status: 'active',
      type: 'Insight',
      tags: [],
      documents: ['pkg/x.ts'],
      plans: [],
    };
    const out = composeDoc(fm, '---\ntitle: WRONG\n---\n\n# Body\n\ntext\n');
    expect(out).toContain('title: "T"');
    expect(out).not.toContain('WRONG');
    expect(out).toContain('documents:\n  - "pkg/x.ts"');
    expect(out.endsWith('# Body\n\ntext\n')).toBe(true);
    // exactly one blank line between frontmatter close and body
    expect(out).toContain('---\n\n# Body');
  });
});

describe('todayIso', () => {
  it('formats YYYY-MM-DD', () => {
    expect(todayIso(new Date('2026-06-30T12:34:56Z'))).toBe('2026-06-30');
    expect(/^\d{4}-\d{2}-\d{2}$/.test(todayIso())).toBe(true);
  });
});

describe('discoveredForWrite (EI-20090410833629115)', () => {
  it('preserves the original discovered vintage when re-authoring canonical content', () => {
    const existing = '---\ntitle: "Old"\ndiscovered: 2026-07-27\nstatus: active\n---\n\nBody\n';
    expect(discoveredForWrite(existing, '2026-08-12')).toBe('2026-07-27');
  });

  it('stamps today for creation or malformed legacy frontmatter', () => {
    expect(discoveredForWrite(null, '2026-08-12')).toBe('2026-08-12');
    expect(discoveredForWrite('---\ntitle: old\n---\n', '2026-08-12')).toBe('2026-08-12');
  });
});

describe('author ↔ anchor round-trip', () => {
  // The whole point of docs:author is that the file it writes is anchor-ready.
  // Generate frontmatter, then parse it back with the anchor's OWN parser — the
  // documents must come out identical (block-list form).
  it('block-list documents round-trip through the anchor parser', () => {
    const docs = ['packages/a/b.ts', 'packages/a/b.ts :: someFn', 'F-3'];
    const fm: FrontmatterInput = {
      title: 'Round trip: with a colon',
      description: 'desc',
      discovered: '2026-06-30',
      status: 'active',
      type: 'Insight',
      tags: ['x', 'y'],
      documents: docs,
      plans: ['plan-2026-06-30'],
    };
    const content = composeDoc(fm, '# Body\n\nsome text');
    expect(frontmatterDocuments(content)).toEqual(docs);
  });

  it('a doc with no documents parses as undefined (anchor → untracked, as designed)', () => {
    const fm: FrontmatterInput = {
      title: 'T',
      description: 'D',
      discovered: '2026-06-30',
      status: 'active',
      type: 'Insight',
      tags: [],
      documents: [],
      plans: [],
    };
    const content = composeDoc(fm, 'body');
    expect(frontmatterDocuments(content)).toBeUndefined();
  });
});

// ── EI-21940075757786953: the truncated-body guards ─────────────────────────────
//
// The measured failure: docs:get returned 50,141 of `testing/agent-e2e`'s 137,030
// chars with found:true, and docs:author takes a FULL replacement body — so the
// documented read→edit→write pipeline would have deleted 63% of the page.
//
// FALSIFIABILITY (repo rule: a guard that has never failed is a guard you have not
// tested). Rather than mutating the shared tree, the guards are exercised against a
// deliberately-wrong CONTROL kept permanently in this file: `naiveShrinkGuard`
// flags any shrink at all. The cases below assert where the real guard and the
// control DISAGREE, so a real guard that decayed into the naive one — or into one
// that never fires — fails here instead of passing.
const naiveShrinkGuard = (existing: number, next: number): boolean => next < existing;

describe('truncatedBodyVerdict', () => {
  const clipped = 'x'.repeat(MAX_PAYLOAD_BYTES) + truncationTail({ firstH2Id: 'intro', h2Count: 9 });

  it('refuses a verbatim clipped docs:get read, with no override offered', () => {
    const v = truncatedBodyVerdict(clipped);
    expect(v?.code).toBe('truncated_body');
    expect(v?.overridable).toBe(false);
    expect(v?.detail).toContain(String(MAX_PAYLOAD_BYTES));
  });

  it('needs BOTH signals — a short doc that merely quotes the marker is fine', () => {
    // Calibration: the marker alone must not condemn a doc written ABOUT this bug.
    const aboutTheBug = `# The trap\n\n\`\`\`\n${truncationTail({ h2Count: 0 })}\n\`\`\`\n`;
    expect(aboutTheBug).toContain('truncated at');
    expect(truncatedBodyVerdict(aboutTheBug)).toBeNull();
    // …and length alone must not condemn a genuinely long doc.
    expect(truncatedBodyVerdict('y'.repeat(MAX_PAYLOAD_BYTES * 3))).toBeNull();
  });
});

describe('overwriteShrinkVerdict', () => {
  it('refuses the measured agent-e2e case (137,030 -> 50,141)', () => {
    const v = overwriteShrinkVerdict({ existingLength: 137_030, bodyLength: 50_141, contentLength: 50_400 });
    expect(v?.code).toBe('implausible_shrink');
    expect(v?.overridable).toBe(true);
    expect(v?.detail).toContain('confirmShrink');
  });

  it('catches a clipped read the RATIO test alone would miss', () => {
    // A 70KB doc clipped at the 50KB cap keeps 71% — over the ratio floor, so a
    // lone ratio check would wave it through. The read-cap fingerprint is what
    // fires, and this case is what distinguishes the real guard from that.
    expect(50_400 < 70_000 * SHRINK_REFUSAL_RATIO).toBe(false);
    expect(
      overwriteShrinkVerdict({ existingLength: 70_000, bodyLength: MAX_PAYLOAD_BYTES, contentLength: 50_400 })?.code,
    ).toBe('implausible_shrink');
  });

  it('allows an ordinary edit that trims a section — where the naive control refuses', () => {
    expect(overwriteShrinkVerdict({ existingLength: 137_030, bodyLength: 129_500, contentLength: 130_000 })).toBeNull();
    expect(naiveShrinkGuard(137_030, 130_000)).toBe(true); // the control would have refused it
  });

  it('allows a small doc losing most of its bytes (under the absolute-loss floor)', () => {
    expect(900 - 300).toBeLessThan(SHRINK_REFUSAL_MIN_LOSS);
    expect(overwriteShrinkVerdict({ existingLength: 900, bodyLength: 100, contentLength: 300 })).toBeNull();
    expect(naiveShrinkGuard(900, 300)).toBe(true); // the control would have refused it
  });

  it('allows growth', () => {
    expect(overwriteShrinkVerdict({ existingLength: 137_030, bodyLength: 141_000, contentLength: 141_005 })).toBeNull();
  });

  it('returns null with no baseline — absence of evidence, not a verdict of fine', () => {
    expect(overwriteShrinkVerdict({ existingLength: null, bodyLength: 10, contentLength: 20 })).toBeNull();
    expect(overwriteShrinkVerdict({ existingLength: 0, bodyLength: 10, contentLength: 20 })).toBeNull();
  });
});

describe('stripReadPreamble', () => {
  // The UNGUARDED half of the class: a doc under the 50KB cap comes back complete,
  // no truncation guard fires, and the natural read→edit→write injects docs:get's
  // header into the body once per edit. Measured shape below is verbatim from
  // docs:get { slugs:['agent-insights/index'] } on 2026-08-31.
  const served = (desc: string, body: string) =>
    `# Agent insights — overview\nURL: /internal/docs/agent-insights/index\n\n${desc}\n\n${body}`;

  it('strips the preamble docs:get actually served', () => {
    const r = stripReadPreamble(served('What an insight is, when to write one.', 'This section is the **agent knowledge base**.'));
    expect(r.stripped).toBe(true);
    expect(r.body).toBe('This section is the **agent knowledge base**.');
  });

  it('handles a doc whose description is empty', () => {
    const r = stripReadPreamble(served('', '# Real heading\n\nbody'));
    expect(r.stripped).toBe(true);
    expect(r.body).toBe('# Real heading\n\nbody');
  });

  it('leaves an ordinary doc that merely OPENS with an H1 alone', () => {
    // The `URL:` second line is what keeps this off authored content.
    const authored = '# My insight\n\nSome prose about a URL: it is a link.\n\nMore.\n';
    expect(stripReadPreamble(authored)).toEqual({ body: authored, stripped: false });
  });

  it('leaves a body with no leading heading alone', () => {
    const authored = 'Just prose.\n\nURL: /somewhere\n\nmore\n';
    expect(stripReadPreamble(authored)).toEqual({ body: authored, stripped: false });
  });

  it('composeDoc on a stripped body does not carry the header into the doc', () => {
    const fm: FrontmatterInput = {
      title: 'Agent insights — overview',
      description: 'D',
      discovered: '2026-08-31',
      status: 'active',
      type: 'Insight',
      tags: [],
      documents: [],
      plans: [],
    };
    const round = composeDoc(fm, stripReadPreamble(served('D', 'The real body.')).body);
    expect(round).not.toContain('URL: /internal/docs/agent-insights/index');
    expect(round).toContain('The real body.');
  });
});

describe('canonicalSourceHint', () => {
  // A refusal with no usable exit is a dead end — and an exit that returns something
  // WRONG is worse, because the caller acts on it. The obvious exit was wrong for a
  // long time: a DEFAULT docs:get serves a rendered, preamble-prefixed projection
  // (measured 2026-08-31 — agent-insights/index came back 1,712 chars for an
  // 1,812-char row, with a `# title` + `URL:` header prepended, and the MDX→markdown
  // pass rewrites every JSX component; 163 of 956 papercusp rows carry one).
  //
  // WI-1511581 built the exit that IS faithful — `docs:get { source: true }` — so the
  // hint now names it FIRST, still names the read cap, and still steers off the
  // default read. These assertions pin the DIRECTION of the advice, which is the
  // part that outlives the session reading it.
  it('names the faithful read first, as a call that can be run as written', () => {
    const hint = canonicalSourceHint(
      '/repo/apps/operator-docs/src/content/docs/testing/agent-e2e.mdx',
      'testing/agent-e2e',
      'engineering',
    );
    expect(hint).toContain('source: true');
    expect(hint).toContain('"testing/agent-e2e"');
    // The harness is load-bearing, not decoration: without it a workspace-scoped
    // session gets `harness_required` and the repair reads as a dead end.
    expect(hint).toContain('harness: "engineering"');
    expect(hint.indexOf('source: true')).toBeLessThan(hint.indexOf('capability:read'));
  });

  it('keeps the concrete projection path as the fallback read', () => {
    const hint = canonicalSourceHint('/repo/apps/operator-docs/src/content/docs/testing/agent-e2e.mdx');
    expect(hint).toContain('capability:read');
    expect(hint).toContain('/repo/apps/operator-docs/src/content/docs/testing/agent-e2e.mdx');
  });

  it('warns off a DEFAULT docs:get as an overwrite source', () => {
    const hint = canonicalSourceHint('/x.mdx');
    expect(hint).toContain('Do NOT source an overwrite body from a DEFAULT docs:get');
    expect(hint).toContain(String(MAX_PAYLOAD_BYTES));
  });

  it('still gives a usable exit when the path could not be resolved', () => {
    const hint = canonicalSourceHint(null);
    // No path to offer, so the faithful tool call is the whole exit — and it must
    // not degrade into prose containing a literal "null" path.
    expect(hint).toContain('docs:get');
    expect(hint).toContain('source: true');
    expect(hint).not.toContain('null');
  });
});
