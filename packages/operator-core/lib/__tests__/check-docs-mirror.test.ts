/**
 * check-docs-mirror.test.ts — source-to-served docs completeness guard
 * (EI-20041752458165941).
 *
 * A clean mirror run proves only that today's mirror is complete. These tests
 * pin the path mapping and the missing-twin failure that a clean run cannot
 * exercise.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its detector only.
import { findMissingDocMirrors, isVisibleDocPath, sourceToMirrorPaths, judgeMirrorFreshness, readMirrorFreshnessFacts, formatStaleMirror, fingerprintDocsSource } from '../../../../scripts/check-docs-mirror.mjs';

/** 2026-08-30T23:17:36Z — the commit that fixed the vetting runbook's source. */
const SOURCE_FIXED_TS = 1787793456;
/** 2026-08-20T07:52:11Z — the newest mirror commit at the time, ten days older. */
const MIRROR_BUILT_TS = 1786866731;

describe('check-docs-mirror detector (EI-20041752458165941)', () => {
  it('censuses source names and bytes while excluding hidden support and non-page files', () => {
    const root = mkdtempSync(join(tmpdir(), 'docs-census-'));
    try {
      writeFileSync(join(root, 'page.mdx'), 'old');
      const original = fingerprintDocsSource(root);
      writeFileSync(join(root, '.support.mdx'), 'ignored');
      writeFileSync(join(root, 'image.png'), 'ignored');
      expect(fingerprintDocsSource(root)).toBe(original);
      writeFileSync(join(root, 'page.mdx'), 'new');
      expect(fingerprintDocsSource(root)).not.toBe(original);
      writeFileSync(join(root, 'page.mdx'), 'old');
      writeFileSync(join(root, 'added.md'), 'added');
      expect(fingerprintDocsSource(root)).not.toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('maps root and nested index pages to Astro file-format HTML paths', () => {
    expect(sourceToMirrorPaths('index.mdx')).toEqual({
      source: 'index.mdx',
      html: 'index.html',
      markdown: 'index.md',
    });
    expect(sourceToMirrorPaths('agent-insights/index.mdx')).toEqual({
      source: 'agent-insights/index.mdx',
      html: 'agent-insights.html',
      markdown: 'agent-insights/index.md',
    });
    expect(sourceToMirrorPaths('agent-insights/new-page.mdx')).toEqual({
      source: 'agent-insights/new-page.mdx',
      html: 'agent-insights/new-page.html',
      markdown: 'agent-insights/new-page.md',
    });
  });

  it('ignores hidden path segments and non-doc files', () => {
    expect(isVisibleDocPath('agent-insights/.papercusp/raw.md')).toBe(false);
    expect(sourceToMirrorPaths('agent-insights/.papercusp/raw.md')).toBeNull();
    expect(sourceToMirrorPaths('agent-insights/readme.txt')).toBeNull();
    expect(sourceToMirrorPaths('./agent-insights/page.mdx')).toEqual({
      source: 'agent-insights/page.mdx',
      html: 'agent-insights/page.html',
      markdown: 'agent-insights/page.md',
    });
  });

  it('flags a source page when either served twin is absent', () => {
    const missing = findMissingDocMirrors({
      sourceFiles: [
        'index.mdx',
        'agent-insights/index.mdx',
        'agent-insights/new-page.mdx',
        'agent-insights/.papercusp/raw.md',
      ],
      htmlFiles: ['index.html', 'agent-insights.html', 'agent-insights/new-page.html'],
      markdownFiles: ['index.md'],
    });

    expect(missing).toEqual([
      {
        source: 'agent-insights/index.mdx',
        expected: {
          html: 'agent-insights.html',
          markdown: 'agent-insights/index.md',
        },
        missing: ['markdown'],
      },
      {
        source: 'agent-insights/new-page.mdx',
        expected: {
          html: 'agent-insights/new-page.html',
          markdown: 'agent-insights/new-page.md',
        },
        missing: ['markdown'],
      },
    ]);
  });

  it('passes when every visible source page has exact Markdown and mapped HTML twins', () => {
    expect(findMissingDocMirrors({
      sourceFiles: ['index.mdx', 'agent-insights/index.mdx', 'agent-insights/page.md'],
      htmlFiles: ['index.html', 'agent-insights.html', 'agent-insights/page.html', '404.html'],
      markdownFiles: ['index.md', 'agent-insights/index.md', 'agent-insights/page.md'],
    })).toEqual([]);
  });
});

/**
 * Freshness (EI-21929043331389136). Completeness answered "does a twin exist";
 * the ten-day `max_agents:3` regression proved existence was never the failure
 * mode. Every case below is the real incident's shape, not an invented one.
 */
describe('check-docs-mirror freshness (EI-21929043331389136)', () => {
  it('REGRESSION CONTROL — flags the ten-day stale mirror from its real timestamps (advisory)', () => {
    const verdict = judgeMirrorFreshness({
      sourceDirty: [],
      mirrorDirty: [],
      sourceCommitTs: SOURCE_FIXED_TS,
      mirrorCommitTs: MIRROR_BUILT_TS,
    });
    // Deliberately NOT a failure: a source edit that leaves rendered output
    // unchanged advances this watermark and no rebuild can clear it. The signal
    // is still emitted, which is what the completeness half could never do.
    expect(verdict.stale).toBe(false);
    expect(verdict.reason).toBe('source-newer-than-mirror-advisory');
    expect(verdict.detail).toMatch(/257h newer/);
    // The completeness half reported OK on this exact state, every run.
    expect(findMissingDocMirrors({
      sourceFiles: ['agent-insights/acceptance-rubric-vetting.mdx'],
      htmlFiles: ['agent-insights/acceptance-rubric-vetting.html'],
      markdownFiles: ['agent-insights/acceptance-rubric-vetting.md'],
    })).toEqual([]);
  });

  it('catches a source page edited in the working tree with the mirror untouched', () => {
    const verdict = judgeMirrorFreshness({
      sourceDirty: ['apps/operator-docs/src/content/docs/agent-insights/acceptance-rubric-vetting.mdx'],
      mirrorDirty: [],
      sourceCommitTs: MIRROR_BUILT_TS,
      mirrorCommitTs: MIRROR_BUILT_TS,
    });
    expect(verdict.stale).toBe(true);
    expect(verdict.reason).toBe('source-edited-without-rebuild');
    expect(verdict.detail).toContain('acceptance-rubric-vetting.mdx');
    expect(formatStaleMirror(verdict)).toMatch(/npm run docs:rebuild/);
  });

  it('CALIBRATION — a staged rebuild is FRESH even while the committed watermark is older', () => {
    // Without this branch the guard would red a checkout that already holds the
    // fix, which is how a guard teaches people to ignore it.
    const verdict = judgeMirrorFreshness({
      sourceDirty: [],
      mirrorDirty: ['apps/operator/public/internal/docs/agent-insights/acceptance-rubric-vetting.md'],
      sourceCommitTs: SOURCE_FIXED_TS,
      mirrorCommitTs: MIRROR_BUILT_TS,
    });
    expect(verdict.stale).toBe(false);
    expect(verdict.reason).toBe('rebuild-staged');
  });

  it('CALIBRATION — a mirror committed after its source is current', () => {
    expect(
      judgeMirrorFreshness({
        sourceDirty: [],
        mirrorDirty: [],
        sourceCommitTs: MIRROR_BUILT_TS,
        mirrorCommitTs: SOURCE_FIXED_TS,
      }),
    ).toMatchObject({ stale: false, reason: 'current' });
  });

  it('does not invent a verdict when git cannot date a side', () => {
    expect(
      judgeMirrorFreshness({ sourceDirty: [], mirrorDirty: [], sourceCommitTs: null, mirrorCommitTs: null }),
    ).toMatchObject({ stale: false, reason: 'current' });
  });

  it('reads its facts from git without shelling out in the test', () => {
    const calls: string[][] = [];
    const facts = readMirrorFreshnessFacts({
      repoRoot: '/repo',
      runGit: (args: string[]) => {
        calls.push(args);
        if (args[0] === 'status') return ' M apps/operator-docs/src/content/docs/a.mdx\n';
        return `${MIRROR_BUILT_TS}\n`;
      },
    });
    expect(facts.sourceDirty).toEqual(['apps/operator-docs/src/content/docs/a.mdx']);
    expect(facts.sourceCommitTs).toBe(MIRROR_BUILT_TS);
    expect(calls).toHaveLength(4);
  });
});
