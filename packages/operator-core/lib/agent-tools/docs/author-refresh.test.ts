import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PAYLOAD_BYTES, truncationTail } from '@papercusp/docs-engine';
import type { DocPageRefresh } from '../../search/doc-embed-sync';

const h = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    lineageQuery: vi.fn(async (_sql: string, _params: string[]): Promise<Record<string, unknown>[]> => [{ exists: 1 }]),
    existsSync: vi.fn(() => false),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    resolveHarnessDocPaths: vi.fn(async () => ({ repoRoot: '/tmp/docs-author-refresh-test', docsRoot: '/tmp/docs-author-refresh-test' })),
    generateNativeArchitecture: vi.fn(async () => ({ body: '## Source-backed architecture\n\nCited static relationship.',
      documents: ['api.ts', 'target.ts'], sourceFingerprint: 'a'.repeat(64), statements: 1 })),
    safeJoinUnderRoot: vi.fn((_root: string, docId: string) => `/tmp/docs-author-refresh-test/${docId}`),
    anchorManualDoc: vi.fn(async (_args: { content: string }) => ({
      ok: true,
      anchored: true,
      record: { status: 'active' },
      subjectRef: [],
    })),
    applyProjectionBanner: vi.fn((content: string) => content),
    getAuthoredDocContent: vi.fn<() => Promise<string | null>>(async () => null),
    engineeringAdapter: { name: 'engineering-adapter-test-double' },
    invalidateEngineeringAdapter: vi.fn(() => {
      order.push('invalidate');
    }),
    refreshDocPageSections: vi.fn<() => Promise<DocPageRefresh>>(async () => {
      order.push('refresh');
      return { ok: true, sections: 1, unchanged: false };
    }),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: h.existsSync,
    promises: { ...actual.promises, mkdir: h.mkdir, writeFile: h.writeFile },
  };
});
vi.mock('../../harness/docs/harness-repo', () => ({ resolveHarnessDocPaths: h.resolveHarnessDocPaths }));
vi.mock('../../promotion-lineage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../promotion-lineage')>();
  return { ...actual, validatePromotedFrom: (raw: Parameters<typeof actual.validatePromotedFrom>[0], workspace: string) =>
    actual.validatePromotedFrom(raw, workspace, h.lineageQuery) };
});
vi.mock('../../harness/docs/doc-fs', () => ({ safeJoinUnderRoot: h.safeJoinUnderRoot }));
vi.mock('../../harness/docs/manual-anchor', () => ({ anchorManualDoc: h.anchorManualDoc }));
vi.mock('../../harness/docs/authored-doc-projection', () => ({ applyProjectionBanner: h.applyProjectionBanner }));
vi.mock('../../harness/docs/doc-record', () => ({ getAuthoredDocContent: h.getAuthoredDocContent }));
vi.mock('./_engineering-adapter', () => ({
  engineeringAdapter: h.engineeringAdapter,
  invalidateEngineeringAdapter: h.invalidateEngineeringAdapter,
}));
vi.mock('../../search/doc-embed-sync', () => ({ refreshDocPageSections: h.refreshDocPageSections }));
vi.mock('../../harness/docs/native-architecture', () => ({ generateNativeArchitecture: h.generateNativeArchitecture }));

import authorTool from './author';

type HandlerResult = { content: Array<{ text: string }>; isError?: boolean };
type AuthorHandler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<HandlerResult>;

const callAuthor = (args: Record<string, unknown>) =>
  (authorTool as unknown as { handler: AuthorHandler }).handler(args, { isSuperuser: true, workspaceId: 'lineage-workspace' });

const baseArgs = {
  slug: 'current-refresh',
  section: 'agent-insights',
  title: 'Current refresh coverage',
  description: 'Direct handler refresh coverage.',
  body: '# Current refresh coverage\n\nBody.',
  documents: ['packages/operator-core/lib/agent-tools/docs/author.ts'],
  harness: 'engineering',
};

beforeEach(() => {
  h.order.length = 0;
  vi.clearAllMocks();
  h.existsSync.mockImplementation(() => false);
  h.getAuthoredDocContent.mockResolvedValue(null);
  h.lineageQuery.mockReset();
  h.lineageQuery.mockResolvedValue([{ exists: 1 }]);
  h.generateNativeArchitecture.mockResolvedValue({ body: '## Source-backed architecture\n\nCited static relationship.',
    documents: ['api.ts', 'target.ts'], sourceFingerprint: 'a'.repeat(64), statements: 1 });
});

describe('docs:author promotion lineage write boundary', () => {
  it('persists resolved lineage in canonical frontmatter and the projection', async () => {
    const promotedFrom = [{ kind: 'work-item', ref: 'WI-123' }];
    const result = await callAuthor({ ...baseArgs, promotedFrom });
    expect(JSON.parse(result.content[0].text).ok).toBe(true);
    expect(h.lineageQuery).toHaveBeenCalledWith(expect.stringContaining('harness_shared.work_items'), ['lineage-workspace', 'WI-123']);
    const content = h.anchorManualDoc.mock.calls[0][0].content;
    expect(authorTool).toBeDefined();
    expect(content).toContain('promotedFrom:');
    expect(content).toContain('WI-123');
    expect(h.writeFile).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('WI-123'), 'utf8');
  });

  it.each(['missing', 'unavailable'])('refuses %s lineage before canonical persistence or projection', async (state) => {
    if (state === 'missing') h.lineageQuery.mockResolvedValue([]);
    else h.lineageQuery.mockRejectedValue(new Error('resolver offline'));
    await expect(callAuthor({ ...baseArgs, promotedFrom: [{ kind: 'work-item', ref: 'WI-123' }] }))
      .rejects.toThrow(state === 'missing' ? 'source missing' : 'resolution unavailable');
    expect(h.anchorManualDoc).not.toHaveBeenCalled();
    expect(h.writeFile).not.toHaveBeenCalled();
    expect(h.refreshDocPageSections).not.toHaveBeenCalled();
  });
});

describe('docs:author native architecture write boundary', () => {
  const architecture = { name: 'entry', file: 'api.ts', paths: ['api.ts', 'target.ts'] };
  it('persists the generated section and its source anchors through canonical authorship', async () => {
    const result = await callAuthor({ ...baseArgs, architecture });
    expect(JSON.parse(result.content[0].text).ok).toBe(true);
    expect(h.generateNativeArchitecture).toHaveBeenCalledWith('/tmp/docs-author-refresh-test', architecture, expect.any(Function));
    expect(h.anchorManualDoc).toHaveBeenCalledWith(expect.objectContaining({
      documents: expect.arrayContaining(['api.ts', 'target.ts', baseArgs.documents[0]]),
      content: expect.stringContaining('## Source-backed architecture'),
    }));
    expect(h.writeFile).toHaveBeenCalled();
  });
  it('refuses uncited graph evidence before canonical persistence, projection or search refresh', async () => {
    h.generateNativeArchitecture.mockRejectedValueOnce(new Error('native_architecture_uncited_relationship'));
    const result = await callAuthor({ ...baseArgs, architecture });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe('native_architecture_uncited_relationship');
    expect(h.anchorManualDoc).not.toHaveBeenCalled();
    expect(h.writeFile).not.toHaveBeenCalled();
    expect(h.refreshDocPageSections).not.toHaveBeenCalled();
  });
});

describe('docs:author search refresh', () => {
  it('rejects unbound MDX expression identifiers before persistence or refresh', async () => {
    const result = await callAuthor({ ...baseArgs, body: 'An optional plan {publisher, product, name}.\n' });
    const payload = JSON.parse(result.content[0].text) as { ok: boolean; error?: string };
    expect(result.isError).toBe(true);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('invalid_mdx');
    expect(payload.error).toContain('publisher');
    expect(h.anchorManualDoc).not.toHaveBeenCalled();
    expect(h.writeFile).not.toHaveBeenCalled();
    expect(h.invalidateEngineeringAdapter).not.toHaveBeenCalled();
    expect(h.refreshDocPageSections).not.toHaveBeenCalled();
  });

  it('rejects MDX-invalid prose before the canonical write', async () => {
    const result = await callAuthor({
      ...baseArgs,
      slug: 'invalid-mdx-before-write',
      body: '# Invalid MDX\n\nA list<plan-ref> appears in prose.\n',
    });
    const payload = JSON.parse(result.content[0].text) as { ok: boolean; error?: string };

    expect(result.isError).toBe(true);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('invalid_mdx');
    expect(payload.error).toContain('Expected a closing tag');
    expect(h.anchorManualDoc).not.toHaveBeenCalled();
    expect(h.writeFile).not.toHaveBeenCalled();
    expect(h.invalidateEngineeringAdapter).not.toHaveBeenCalled();
    expect(h.refreshDocPageSections).not.toHaveBeenCalled();
  });

  it('explains that raw less-than comparisons need MDX-safe notation', async () => {
    const result = await callAuthor({
      ...baseArgs,
      slug: 'invalid-mdx-less-than-comparison',
      body: '# Benchmark notation\n\nThe target is <=0.8x the baseline.\n',
    });
    const payload = JSON.parse(result.content[0].text) as { ok: boolean; error?: string };

    expect(result.isError).toBe(true);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('invalid_mdx');
    expect(payload.error).toContain('Raw less-than comparisons');
    expect(payload.error).toContain('≤0.8x');
    expect(payload.error).toContain('&lt;=0.8x');
    expect(h.anchorManualDoc).not.toHaveBeenCalled();
  });

  it('invalidates the engineering adapter before refreshing the authored page', async () => {
    const result = await callAuthor(baseArgs);
    const payload = JSON.parse(result.content[0].text) as {
      ok: boolean;
      ref?: string;
      harness?: string;
      storageHarness?: string;
      surface?: string;
      read?: { slugs?: string[]; harness?: string };
    };

    expect(result.isError).not.toBe(true);
    expect(payload.ok).toBe(true);
    expect(payload).toMatchObject({
      ref: 'agent-insights/current-refresh',
      harness: 'engineering',
      storageHarness: 'papercusp',
      surface: 'engineering',
      read: { slugs: ['agent-insights/current-refresh'], harness: 'engineering' },
    });
    expect(h.invalidateEngineeringAdapter).toHaveBeenCalledTimes(1);
    expect(h.refreshDocPageSections).toHaveBeenCalledWith(h.engineeringAdapter, 'agent-insights/current-refresh');
    expect(h.order).toEqual(['invalidate', 'refresh']);
  });

  it('keeps author success but surfaces a refresh failure as a warning', async () => {
    h.refreshDocPageSections.mockResolvedValueOnce({
      ok: false,
      reason: 'page_not_found:agent-insights/current-refresh',
    });

    const result = await callAuthor(baseArgs);
    const payload = JSON.parse(result.content[0].text) as { ok: boolean; warnings?: string[] };

    expect(result.isError).not.toBe(true);
    expect(payload.ok).toBe(true);
    expect(payload.warnings?.some((warning) => warning.includes('page_not_found:agent-insights/current-refresh'))).toBe(
      true,
    );
  });

  it('preserves an over-limit legacy description when an overwrite omits description', async () => {
    const legacyDescription = 'x'.repeat(1_945);
    h.existsSync.mockReturnValue(true);
    h.getAuthoredDocContent.mockResolvedValue(`---
title: "Legacy insight"
description: "${legacyDescription}"
---

# Legacy insight
`);
    const { description: _unusedDescription, ...overwriteWithoutDescription } = baseArgs;

    const result = await callAuthor({
      ...overwriteWithoutDescription,
      slug: 'legacy-description-overwrite',
      title: 'Updated legacy insight',
      overwrite: true,
    });
    const payload = JSON.parse(result.content[0].text) as { ok: boolean; warnings?: string[] };

    expect(result.isError).not.toBe(true);
    expect(payload.ok).toBe(true);
    expect(payload.warnings?.some((warning) => warning.includes(String(legacyDescription.length)))).toBe(true);
    const anchorArgs = h.anchorManualDoc.mock.calls[0]?.[0] as { content: string } | undefined;
    expect(anchorArgs?.content).toContain(`description: "${legacyDescription}"`);
  });

  it('still requires description when creating a new doc', async () => {
    const { description: _unusedDescription, ...createWithoutDescription } = baseArgs;
    const result = await callAuthor({
      ...createWithoutDescription,
      slug: 'missing-description',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('description_required');
    expect(h.anchorManualDoc).not.toHaveBeenCalled();
  });
});

// ── EI-21940075757786953: the truncated-body guards, at the HANDLER seam ────────
//
// author.test.ts proves the two verdict helpers decide correctly. These prove the
// handler is actually WIRED to them and refuses BEFORE anything is written —
// which is the whole point: the canonical row write (anchorManualDoc) is what
// would have destroyed the page.
describe('docs:author truncated-body guards', () => {
  /** The stored doc, at the size that produced the measured failure. */
  const STORED_LENGTH = 137_030;
  const storedDoc = (() => {
    const fm = '---\ntitle: "Agent E2E"\ndescription: "The playbook."\n---\n\n';
    return fm + 'y'.repeat(STORED_LENGTH - fm.length);
  })();
  const overwriteArgs = { ...baseArgs, slug: 'agent-e2e-overwrite', overwrite: true };

  const expectNothingWritten = () => {
    expect(h.anchorManualDoc).not.toHaveBeenCalled();
    expect(h.writeFile).not.toHaveBeenCalled();
    expect(h.invalidateEngineeringAdapter).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    h.existsSync.mockReturnValue(true);
    h.getAuthoredDocContent.mockResolvedValue(storedDoc);
  });

  it('refuses a body that is a verbatim clipped docs:get read', async () => {
    const result = await callAuthor({
      ...overwriteArgs,
      body: 'x'.repeat(MAX_PAYLOAD_BYTES) + truncationTail({ firstH2Id: 'intro', h2Count: 9 }),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('truncated_body');
    expectNothingWritten();
  });

  it('refuses a clipped read even with confirmShrink — the marker is not overridable', async () => {
    const result = await callAuthor({
      ...overwriteArgs,
      confirmShrink: true,
      body: 'x'.repeat(MAX_PAYLOAD_BYTES) + truncationTail({ h2Count: 0 }),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('truncated_body');
    expectNothingWritten();
  });

  it('refuses an implausible shrink and names the doc + the override', async () => {
    const result = await callAuthor({ ...overwriteArgs, body: 'x'.repeat(MAX_PAYLOAD_BYTES) });
    const payload = JSON.parse(result.content[0].text) as { ok: boolean; error?: string };

    expect(result.isError).toBe(true);
    expect(payload.error).toContain('implausible_shrink');
    expect(payload.error).toContain('agent-insights/agent-e2e-overwrite.mdx');
    expect(payload.error).toContain('confirmShrink:true');
    expectNothingWritten();
  });

  it('writes the same shrink when confirmShrink:true says it is deliberate', async () => {
    const result = await callAuthor({
      ...overwriteArgs,
      confirmShrink: true,
      body: 'x'.repeat(MAX_PAYLOAD_BYTES),
    });
    const payload = JSON.parse(result.content[0].text) as { ok: boolean };

    expect(result.isError).not.toBe(true);
    expect(payload.ok).toBe(true);
    expect(h.anchorManualDoc).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire on an ordinary edit that trims a section', async () => {
    // Calibration — without this, a guard that refused every overwrite would pass
    // all three refusal cases above and look correct.
    const result = await callAuthor({ ...overwriteArgs, body: 'z'.repeat(130_000) });
    const payload = JSON.parse(result.content[0].text) as { ok: boolean };

    expect(result.isError).not.toBe(true);
    expect(payload.ok).toBe(true);
    expect(h.anchorManualDoc).toHaveBeenCalledTimes(1);
  });

  it('strips a docs:get read preamble instead of writing it into the doc', async () => {
    // The unguarded half: a SMALL doc round-trips complete, so no truncation guard
    // fires — but the header docs:get prepends would still land in the body.
    const result = await callAuthor({
      ...overwriteArgs,
      confirmShrink: true, // the shrink here is real; the preamble is the subject
      body: '# Agent insights — overview\nURL: /internal/docs/agent-insights/index\n\nWhat an insight is.\n\nThe real body.\n',
    });
    const payload = JSON.parse(result.content[0].text) as { ok: boolean; warnings?: string[] };
    const written = (h.anchorManualDoc.mock.calls[0]?.[0] as { content: string } | undefined)?.content ?? '';

    expect(payload.ok).toBe(true);
    expect(written).not.toContain('URL: /internal/docs/agent-insights/index');
    expect(written).toContain('The real body.');
    expect(payload.warnings?.some((w) => w.includes('read preamble'))).toBe(true);
  });

  it('does NOT fire on a create — there is no stored doc to shrink', async () => {
    h.existsSync.mockReturnValue(false);
    h.getAuthoredDocContent.mockResolvedValue(null);

    const result = await callAuthor({ ...baseArgs, slug: 'brand-new-doc', body: 'x'.repeat(MAX_PAYLOAD_BYTES) });
    const payload = JSON.parse(result.content[0].text) as { ok: boolean };

    expect(result.isError).not.toBe(true);
    expect(payload.ok).toBe(true);
  });
});

// WI-6554700010011197: a ROOT-level page (branding.mdx, index.mdx, performance.mdx) must
// reach the canonical writer, the projection and the stored-row read under the dir-less
// doc id — not `agent-insights/branding.mdx`, and not `//branding.mdx`.
describe('docs:author docs-root section (WI-6554700010011197)', () => {
  type RootPayload = { ok: boolean; path?: string; ref?: string; section?: string; read?: { slugs: string[] } };
  const parse = (r: HandlerResult) => JSON.parse(r.content[0].text) as RootPayload;

  it('section "/" writes <docsRoot>/<slug>.mdx with a dir-less ref', async () => {
    const result = await callAuthor({ ...baseArgs, slug: 'branding', section: '/' });

    expect(result.isError).not.toBe(true);
    expect(parse(result)).toMatchObject({
      ok: true,
      path: 'branding.mdx',
      ref: 'branding',
      section: '/',
      read: { slugs: ['branding'] },
    });
    expect(h.safeJoinUnderRoot).toHaveBeenCalledWith('/tmp/docs-author-refresh-test', 'branding.mdx');
    expect(h.anchorManualDoc).toHaveBeenCalledWith(expect.objectContaining({ docId: 'branding.mdx' }));
    expect(h.writeFile).toHaveBeenCalledWith('/tmp/docs-author-refresh-test/branding.mdx', expect.any(String), 'utf8');
  });

  it('an overwrite via a leading-slash slug reads the stored root row by its root doc id', async () => {
    h.existsSync.mockReturnValue(true);
    h.getAuthoredDocContent.mockResolvedValue(
      '---\ntitle: "Branding"\ndescription: "Brand guide."\n---\n\n# Branding\n\nOld body.\n',
    );
    const { section: _omitted, ...noSection } = baseArgs;

    const result = await callAuthor({ ...noSection, slug: '/branding.mdx', overwrite: true });

    expect(result.isError).not.toBe(true);
    expect(h.getAuthoredDocContent).toHaveBeenCalledWith(expect.any(String), 'branding.mdx');
    expect(parse(result)).toMatchObject({ ok: true, path: 'branding.mdx', ref: 'branding' });
  });

  it('a bare slug with no section still lands in agent-insights, never the root', async () => {
    const { section: _omitted, ...noSection } = baseArgs;

    const result = await callAuthor({ ...noSection, slug: 'branding' });

    expect(parse(result)).toMatchObject({ ok: true, path: 'agent-insights/branding.mdx', ref: 'agent-insights/branding' });
    expect(h.anchorManualDoc).toHaveBeenCalledWith(expect.objectContaining({ docId: 'agent-insights/branding.mdx' }));
  });
});
