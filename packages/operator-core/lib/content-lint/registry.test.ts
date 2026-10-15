/**
 * The content-detector registry (git-sync-content-guard-2026-06-13 P-003/P-008).
 *
 * Pins the two things the git-sync guard relies on: each detector's SCOPE
 * (`matches`) mirrors the CI lint's exact file set (D-003 — so the guard never
 * quarantines a file the lint wouldn't flag), and its `detect` wrapper normalises
 * the underlying pure detector to a single error string | null. (The MDX detector's
 * no-false-positive corpus behavior is locked separately in check-mdx-guard.test.ts.)
 */
import { describe, it, expect } from 'vitest';
import {
  mdxDetector,
  smartQuotesDetector,
  shellSyntaxDetector,
  conflictMarkersDetector,
  DEFAULT_CONTENT_DETECTORS,
  rootRedirectArtifactDetector,
} from './registry';

describe('mdxDetector', () => {
  it('matches ONLY .mdx under the astro-built docs set (mirrors check-mdx.mjs scope)', () => {
    expect(mdxDetector.matches('apps/operator-docs/src/content/docs/x.mdx')).toBe(true);
    expect(mdxDetector.matches('apps/operator-docs/src/content/docs/agent-insights/y.mdx')).toBe(true);
    // wrong extension / outside the docs set / excluded tree → not in scope
    expect(mdxDetector.matches('apps/operator-docs/src/content/docs/x.md')).toBe(false);
    expect(mdxDetector.matches('docs/elsewhere/x.mdx')).toBe(false);
    expect(mdxDetector.matches('apps/operator-docs/src/content/docs/_retired/old.mdx')).toBe(false);
    expect(mdxDetector.matches('node_modules/pkg/readme.mdx')).toBe(false);
  });

  it('detect returns a positioned error string for a broken doc, null for a valid one', async () => {
    const FM = '---\ntitle: x\n---\n';
    const bad = await mdxDetector.detect('x.mdx', `${FM}\nA "resets <date>" string breaks the build.\n`);
    expect(bad).toMatch(/MDX compile error/i);
    expect(bad).toMatch(/line \d+/);
    expect(await mdxDetector.detect('x.mdx', `${FM}\nA \`<date>\` token in backticks is fine.\n`)).toBeNull();
  });

  it('dispatches to the content-fixer role', () => {
    expect(mdxDetector.fixerRole).toBe('content-fixer');
  });
});

describe('smartQuotesDetector', () => {
  it('matches tracked .ts/.tsx, excluding retired/vendored/build trees (mirrors check-smart-quotes.mjs)', () => {
    expect(smartQuotesDetector.matches('packages/x/lib/a.ts')).toBe(true);
    expect(smartQuotesDetector.matches('apps/operator/components/B.tsx')).toBe(true);
    expect(smartQuotesDetector.matches('README.md')).toBe(false);
    // exclusions mirror check-smart-quotes.mjs EXACTLY (D-003): nested node_modules/dist
    // + the _retired/ prefix. (A top-level node_modules/ path is gitignored, so it is
    // never a tracked/dirty input — the predicate matches CI rather than over-excluding.)
    expect(smartQuotesDetector.matches('packages/x/node_modules/pkg/index.ts')).toBe(false);
    expect(smartQuotesDetector.matches('_retired/old/a.ts')).toBe(false);
    expect(smartQuotesDetector.matches('packages/x/dist/a.ts')).toBe(false);
  });

  it('detect flags a curly quote used as a code delimiter, leaves a clean file null', () => {
    // a curly quote where a string delimiter belongs → hard parse failure
    const bad = smartQuotesDetector.detect('a.ts', "describe(‘x’, () => {});\n");
    expect(bad).toMatch(/curly\/smart quote used as code/i);
    // straight quotes + a curly apostrophe safely INSIDE a string → clean
    expect(smartQuotesDetector.detect('a.ts', "const s = 'the caller’s value';\n")).toBeNull();
  });

  it('dispatches to the content-fixer role', () => {
    expect(smartQuotesDetector.fixerRole).toBe('content-fixer');
  });
});

describe('shellSyntaxDetector', () => {
  it('matches tracked .sh, excluding retired/vendored/build trees', () => {
    expect(shellSyntaxDetector.matches('papercusp-desktop/bin/build-windows-on-vm.sh')).toBe(true);
    expect(shellSyntaxDetector.matches('scripts/pc-heavy.sh')).toBe(true);
    expect(shellSyntaxDetector.matches('README.md')).toBe(false);
    expect(shellSyntaxDetector.matches('_retired/old/a.sh')).toBe(false);
    expect(shellSyntaxDetector.matches('packages/x/node_modules/pkg/a.sh')).toBe(false);
    expect(shellSyntaxDetector.matches('packages/x/dist/a.sh')).toBe(false);
  });

  it('detect flags a syntactically broken script, leaves a clean one null', () => {
    const bad = shellSyntaxDetector.detect('a.sh', 'echo hi\nif true; then\n  echo ok\n');
    expect(bad).toMatch(/bash -n syntax error/i);
    expect(shellSyntaxDetector.detect('a.sh', 'echo hi\nif true; then\n  echo ok\nfi\n')).toBeNull();
  });

  it('dispatches to the content-fixer role', () => {
    expect(shellSyntaxDetector.fixerRole).toBe('content-fixer');
  });

  it('has no autoFix — a corrupted script always needs the LLM fixer to pick the right block', () => {
    expect(shellSyntaxDetector.autoFix).toBeUndefined();
  });
});

describe('conflictMarkersDetector', () => {
  it('matches every tracked file, excluding retired/vendored/build trees (mirrors check-conflict-markers.mjs scope)', () => {
    expect(conflictMarkersDetector.matches('apps/operator/app/globals.css')).toBe(true);
    expect(conflictMarkersDetector.matches('README.md')).toBe(true);
    expect(conflictMarkersDetector.matches('packages/x/lib/a.ts')).toBe(true);
    expect(conflictMarkersDetector.matches('_retired/old/a.ts')).toBe(false);
    expect(conflictMarkersDetector.matches('packages/x/node_modules/pkg/a.ts')).toBe(false);
    expect(conflictMarkersDetector.matches('packages/x/dist/a.js')).toBe(false);
  });

  it('detect flags a committed conflict marker, leaves a clean file null', () => {
    const marker = '<'.repeat(7);
    const bad = conflictMarkersDetector.detect(
      'apps/operator/app/globals.css',
      `.a {}\n${marker} Updated upstream\n.b {}`,
    );
    expect(bad).toMatch(/committed git conflict marker at line 2/i);
    expect(conflictMarkersDetector.detect('apps/operator/app/globals.css', '.a { color: red; }\n')).toBeNull();
  });

  it('dispatches to the content-fixer role', () => {
    expect(conflictMarkersDetector.fixerRole).toBe('content-fixer');
  });

  it('has no autoFix — a real conflict needs a human/LLM to pick the correct side', () => {
    expect(conflictMarkersDetector.autoFix).toBeUndefined();
  });
});

describe('rootRedirectArtifactDetector', () => {
  const artifact = 'VERDICT: WORKING (cpu is being consumed)';

  it('matches only extensionless superproject-root names with a colon and whitespace', () => {
    expect(rootRedirectArtifactDetector.matches(artifact)).toBe(true);
    expect(rootRedirectArtifactDetector.matches('CPU: report.md')).toBe(false);
    expect(rootRedirectArtifactDetector.matches('logs/VERDICT: WORKING (cpu is being consumed)')).toBe(false);
    expect(rootRedirectArtifactDetector.matches('VERDICT: WORKING.txt')).toBe(false);
    expect(rootRedirectArtifactDetector.matches('VERDICT-WORKING')).toBe(false);
    expect(rootRedirectArtifactDetector.repoScope).toBe('superproject-only');
  });

  it('explains how to dispose of a likely redirected-output artifact', () => {
    expect(rootRedirectArtifactDetector.detect(artifact, '1.02067')).toMatch(
      /root-level shell output artifact.*delete accidental output/i,
    );
  });
});

describe('DEFAULT_CONTENT_DETECTORS', () => {
  it('ships all fourteen seeded detectors, keyed for the guard + escalation', () => {
    expect(DEFAULT_CONTENT_DETECTORS.map((d) => d.key)).toEqual([
      // EI-21230011589307899: ordered FIRST. Every other detector here guards a
      // BUILD, where a miss is repaired by the next commit; this one guards git
      // HISTORY, where a miss freezes the pot's egress permanently and only a
      // path exemption clears it. When a file trips several detectors, that is
      // the message that must be recorded and escalated.
      'secrets',
      // EI-19381677675617429: ordered next to secrets for the same reason — an
      // identity leak that reaches HEAD is not repaired by the next commit; it is
      // in git history permanently, and the release source drop ships it.
      'identity-leak',
      'mdx',
      'smart-quotes',
      'nul-bytes',
      // EI-19415157731625374: ordered BEFORE ts-parse for the same reason
      // smart-quotes is — a backtick in a SQL comment is a parse error whose
      // generic diagnostic points tens of lines from the cause, so the specific
      // message must be recorded first. It also catches the SILENT form, where
      // the file parses and ts-parse is structurally blind.
      'sql-comment-backtick',
      // Empty source modules are parseable, so quarantine a zero-byte executable
      // TS file before git-sync can publish an accidental truncate/write state.
      'empty-ts-source',
      // EI-5240: the bundler's own transform verdict must run before the
      // TypeScript-only check, which can accept source that esbuild rejects.
      'esbuild-transform',
      // WI-6683: ordered after smart-quotes so the more specific curly-quote
      // message is recorded first for a file that trips both. nul-bytes sits
      // between them without disturbing that: a NUL byte is a distinct, more
      // specific offence than either, and ts-parse remains after smart-quotes.
      'ts-parse',
      'shell-syntax',
      'conflict-markers',
      // EI-19446174755157221: ordered after ts-parse — a file that does not parse
      // cannot be meaningfully inspected for a constant-forced branch, and the
      // detector reports clean on one so a single break is never quarantined twice.
      'constant-conditional',
      // EI-19447067535467975: constant-conditional's sibling from the same
      // incident — that one catches a disabled BRANCH, this one a disabled FILE.
      // Ordered adjacent to it (same class: an unfinished edit the sweep
      // committed) and scoped to test/spec files, so it never overlaps the
      // detectors above on ordinary source.
      'focused-test',
      'root-redirect-artifact',
    ]);
  });
});
