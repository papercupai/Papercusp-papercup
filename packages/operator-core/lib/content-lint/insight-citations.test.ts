/**
 * insight-citations.test.ts — the stale-citation detector (WI-1576).
 *
 * Runs against a synthetic repoRoot (a real tmp dir with a couple of real files),
 * not the live corpus — the live-corpus no-false-positive proof is
 * `scripts/check-insight-citations.mjs` running green in CI.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findStaleInsightCitations, formatStaleCitations } from './insight-citations';

let repoRoot: string;

beforeAll(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'insight-citations-test-'));
  mkdirSync(join(repoRoot, 'packages/operator-core/lib'), { recursive: true });
  writeFileSync(join(repoRoot, 'packages/operator-core/lib/real-file.ts'), '// exists\n');
});

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

const withFrontmatter = (documentsBlock: string, body = '# Hi\n') =>
  `---\ntitle: x\ndocuments:\n${documentsBlock}\n---\n\n${body}`;

describe('findStaleInsightCitations', () => {
  it('returns [] when there is no `documents:` field at all', () => {
    expect(findStaleInsightCitations('---\ntitle: x\n---\n\nbody\n', repoRoot)).toEqual([]);
  });

  it('returns [] when every cited path exists on disk', () => {
    const body = withFrontmatter('  - packages/operator-core/lib/real-file.ts');
    expect(findStaleInsightCitations(body, repoRoot)).toEqual([]);
  });

  it('FLAGS a cited path that does not exist on disk (the renamed/deleted-file case)', () => {
    const body = withFrontmatter('  - packages/operator-core/lib/moved-away.ts');
    const stale = findStaleInsightCitations(body, repoRoot);
    expect(stale).toEqual([{ path: 'packages/operator-core/lib/moved-away.ts', kind: 'path' }]);
  });

  // EI-18820414923640246 — both of these were PERMANENT reds: input that could never
  // pass, on a leg whose whole value is that a red means something. A guard that reds on
  // unverifiable-by-construction input teaches the fleet to stop reading it.
  it('IGNORES a work-item id citation (F-/WI-/EI-) — it names a work item, not a path', () => {
    const body = withFrontmatter('  - "EI-13317"\n  - "WI-1576"\n  - "F-3"');
    expect(findStaleInsightCitations(body, repoRoot)).toEqual([]);
  });

  // WI-6554700010008908: same permanent-red class as the EI- case above, for plan refs.
  it('IGNORES a scoped plan item/decision citation — it names a plan record, not a path', () => {
    const body = withFrontmatter(
      "  - 'byoc-cloud-workspaces-gcp-aws-azure-2026-08-22#D-143'\n  - some-plan#P-004\n  - packages/operator-core/lib/moved-away.ts",
    );
    expect(findStaleInsightCitations(body, repoRoot)).toEqual([
      { path: 'packages/operator-core/lib/moved-away.ts', kind: 'path' },
    ]);
  });

  it('IGNORES an ABSOLUTE path — the contract is repo-relative, so it is not ours to verify', () => {
    // join(repoRoot, '/etc/x') silently yields <repoRoot>/etc/x, so these were checked at
    // a path nobody ever meant to exist. Docs legitimately cite files outside the tree
    // (an installed global CLI, a systemd drop-in).
    const body = withFrontmatter(
      '  - /etc/systemd/resolved.conf.d/papercusp-fallback-dns.conf\n' +
      '  - /home/linuxbrew/.linuxbrew/lib/node_modules/tauri-agent-tools/dist/commands/check.js',
    );
    expect(findStaleInsightCitations(body, repoRoot)).toEqual([]);
  });

  it('still FLAGS a repo-relative stale path alongside ignored refs (the guard is not weakened)', () => {
    // The negative control: making the two cases above pass must not make everything pass.
    const body = withFrontmatter('  - "EI-13317"\n  - /etc/some.conf\n  - packages/operator-core/lib/moved-away.ts');
    expect(findStaleInsightCitations(body, repoRoot)).toEqual([
      { path: 'packages/operator-core/lib/moved-away.ts', kind: 'path' },
    ]);
  });

  it('checks the FILE part of a `path :: symbol` citation, ignoring the symbol name', () => {
    const goodSymbol = withFrontmatter('  - packages/operator-core/lib/real-file.ts :: someExport');
    expect(findStaleInsightCitations(goodSymbol, repoRoot)).toEqual([]);

    const staleSymbol = withFrontmatter('  - packages/operator-core/lib/gone.ts :: someExport');
    expect(findStaleInsightCitations(staleSymbol, repoRoot)).toEqual([
      { path: 'packages/operator-core/lib/gone.ts', kind: 'symbol' },
    ]);
  });

  it('skips a feature ref (F-NNN / WI-NNN) — it names a work item, not a path', () => {
    const body = withFrontmatter('  - WI-1576\n  - F-42');
    expect(findStaleInsightCitations(body, repoRoot)).toEqual([]);
  });

  it('skips a glob-bearing entry — it matches a set, not one file', () => {
    const body = withFrontmatter('  - packages/operator-core/lib/**/*.ts');
    expect(findStaleInsightCitations(body, repoRoot)).toEqual([]);
  });

  it('reports EVERY stale entry, not just the first', () => {
    const body = withFrontmatter(
      '  - packages/operator-core/lib/real-file.ts\n' +
        '  - packages/operator-core/lib/first-gone.ts\n' +
        '  - packages/operator-core/lib/second-gone.ts',
    );
    const stale = findStaleInsightCitations(body, repoRoot);
    expect(stale.map((s) => s.path)).toEqual([
      'packages/operator-core/lib/first-gone.ts',
      'packages/operator-core/lib/second-gone.ts',
    ]);
  });
});

describe('formatStaleCitations', () => {
  it('returns null for an empty list', () => {
    expect(formatStaleCitations([])).toBeNull();
  });

  it('renders a single human-readable string naming every stale path', () => {
    const msg = formatStaleCitations([
      { path: 'a/b.ts', kind: 'path' },
      { path: 'c/d.rs', kind: 'symbol' },
    ]);
    expect(msg).toMatch(/stale documents: citation/i);
    expect(msg).toContain('a/b.ts');
    expect(msg).toContain('c/d.rs');
  });
});
