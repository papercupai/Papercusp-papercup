/**
 * Read-side completion freshness/oracle-drift detection.
 *
 * The detector compares the server-stamped terminal evidence with a fresh
 * spawn-free HEAD observation.  These tests pin the three honest outcomes:
 * current, changed, and not observable.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  completionFreshnessForEvidence,
  completionTreeStamp,
  completionTreeStampForEvidence,
  completionSettlementManifest,
  completionTreeContentIdentityMatches,
  unprovenContentIdentityPaths,
  describeUnprovenContentIdentity,
} from './completion-freshness';
import type { CompletionTreeContentIdentity } from '../../coord-lifecycle/records';

const identity: CompletionTreeContentIdentity[] = [
  { path: 'src/fix.ts', workingTreeBlobSha: 'c'.repeat(40), headBlobSha: 'c'.repeat(40) },
];
const stored = { repositoryRoot: '/repo', headSha: 'a'.repeat(40), contentIdentity: identity };
const current = { repositoryRoot: '/repo', headSha: 'b'.repeat(40), contentIdentity: identity };

function gitFixture(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    killSignal: 'SIGKILL',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function initializeIgnoreFixture(root: string, ignoreRules = ['reports/*.json', '!reports/keep.json']): void {
  gitFixture(root, 'init', '-q');
  gitFixture(root, 'config', 'user.email', 'completion-ignore@example.test');
  gitFixture(root, 'config', 'user.name', 'Completion Ignore Fixture');
  gitFixture(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, '.gitignore'), [...ignoreRules, ''].join('\n'));
  gitFixture(root, 'add', '--', '.gitignore');
  gitFixture(root, 'commit', '-qm', 'baseline');
  mkdirSync(join(root, 'reports'), { recursive: true });
  writeFileSync(join(root, 'reports', 'ignored.json'), '{"report":true}\n');
  writeFileSync(join(root, 'reports', 'keep.json'), '{"keep":true}\n');
}

describe('completionTreeStamp Git ignore status (WI-10004491)', () => {
  it('measures an ignored file even when an ancestor directory is ignored', async () => {
    const root = mkdtempSync(join(tmpdir(), 'completion-ignore-parent-'));
    try {
      initializeIgnoreFixture(root, ['reports/']);
      const stamp = await completionTreeStamp({ repoRoot: root, filesChanged: ['reports/ignored.json'] });
      expect(stamp?.contentIdentity?.[0]?.gitIgnoreStatus).toBe('ignored');
      expect(unprovenContentIdentityPaths(stamp)).toEqual([
        { path: 'reports/ignored.json', reason: 'gitignored-path', settles: 'never' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records ignored and negated ignore-pattern results for present files absent from HEAD', async () => {
    const root = mkdtempSync(join(tmpdir(), 'completion-ignore-status-'));
    try {
      initializeIgnoreFixture(root);
      const stamp = await completionTreeStamp({
        repoRoot: root,
        filesChanged: ['reports/ignored.json', 'reports/keep.json'],
      });

      expect(stamp?.contentIdentity?.map(({ path, gitIgnoreStatus }) => [path, gitIgnoreStatus])).toEqual([
        ['reports/ignored.json', 'ignored'],
        ['reports/keep.json', 'not-ignored'],
      ]);
      const rows = unprovenContentIdentityPaths(stamp);
      expect(rows).toEqual([
        { path: 'reports/ignored.json', reason: 'gitignored-path', settles: 'never' },
        { path: 'reports/keep.json', reason: 'missing-from-commit', settles: 'sweep' },
      ]);
      const advice = describeUnprovenContentIdentity(rows, 2)!;
      expect(advice).toContain('MIXED');
      expect(advice).toContain("'reports/ignored.json' is ignored by Git");
      expect(advice).toContain('reports/keep.json');
      expect(advice).not.toContain('WAITING SETTLES THIS');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps ignore status unknown when the bounded probe fails and avoids promising settlement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'completion-ignore-status-unknown-'));
    try {
      initializeIgnoreFixture(root);
      const stamp = await completionTreeStamp({
        repoRoot: root,
        filesChanged: ['reports/ignored.json'],
        gitIgnoreStatusProbe: async () => undefined,
      });
      const rows = unprovenContentIdentityPaths(stamp);
      const advice = describeUnprovenContentIdentity(rows, 1)!;

      expect(stamp?.contentIdentity?.[0]?.gitIgnoreStatus).toBe('unknown');
      expect(rows).toEqual([
        { path: 'reports/ignored.json', reason: 'gitignore-status-unknown', settles: 'unknown' },
      ]);
      expect(advice).toContain('WAITING IS UNVERIFIED');
      expect(advice).toContain('unknown Git ignore status');
      expect(advice).toContain('Verify the ignore rules');
      expect(advice).not.toContain('WAITING SETTLES THIS');
      expect(advice).not.toContain('WAITING WILL NOT SETTLE THIS');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('installed npm artifacts in incidental toolchain checkouts (WI-6554700010016006)', () => {
  async function withRuntimeFixture(run: (fixture: {
    project: string; manager: string; vendor: string; relativeVendor: string;
  }) => Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), 'completion-installed-runtime-'));
    try {
      const project = join(root, 'project');
      const manager = join(root, 'home', '.nvm');
      mkdirSync(project, { recursive: true });
      mkdirSync(manager, { recursive: true });
      initializeIgnoreFixture(project);
      initializeIgnoreFixture(manager, ['versions/', 'reports/', 'src/']);
      const relativeVendor = 'versions/node/v22/lib/node_modules/@example/cli/package.json';
      const vendor = join(manager, relativeVendor);
      mkdirSync(join(vendor, '..'), { recursive: true });
      writeFileSync(vendor, '{"version":"2.0.0"}\n');
      await run({ project, manager, vendor, relativeVendor });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('classifies an absolute ignored installed package without requiring a vendor commit', async () => {
    await withRuntimeFixture(async ({ project, vendor }) => {
      const stamp = await completionTreeStampForEvidence({ filesChanged: [vendor] }, [project]);
      expect(stamp?.contentIdentity).toEqual([
        { path: vendor, workingTreeBlobSha: null, headBlobSha: null, outOfRepoArtifact: true },
      ]);
      expect(completionTreeContentIdentityMatches(stamp?.contentIdentity)).toBe(true);
      expect(completionSettlementManifest({ treeStamp: stamp })).toBeUndefined();
    });
  });

  it('does not let an installed artifact excuse uncommitted project source', async () => {
    await withRuntimeFixture(async ({ project, vendor }) => {
      writeFileSync(join(project, 'fix.ts'), 'export const fixed = true;\n');
      const stamp = await completionTreeStampForEvidence({ filesChanged: [vendor, 'fix.ts'] }, [project]);
      expect(stamp?.contentIdentity).toContainEqual(expect.objectContaining({ path: vendor, outOfRepoArtifact: true }));
      expect(stamp?.contentIdentity).toContainEqual(expect.objectContaining({ path: 'fix.ts', headBlobSha: null }));
      expect(completionTreeContentIdentityMatches(stamp?.contentIdentity)).toBe(false);
      expect(completionSettlementManifest({ treeStamp: stamp })?.normalizedPaths).toEqual(['fix.ts']);
    });
  });

  it('keeps tracked vendor files subject to exact content checks', async () => {
    await withRuntimeFixture(async ({ project, manager, vendor, relativeVendor }) => {
      gitFixture(manager, 'add', '-f', '--', relativeVendor);
      gitFixture(manager, 'commit', '-qm', 'tracked vendor control');
      writeFileSync(vendor, '{"version":"3.0.0"}\n');
      const stamp = await completionTreeStampForEvidence({ filesChanged: [vendor] }, [project]);
      expect(stamp?.contentIdentity?.[0]?.outOfRepoArtifact).toBeUndefined();
      expect(stamp?.contentIdentity?.[0]?.headBlobSha).toEqual(expect.any(String));
      expect(completionTreeContentIdentityMatches(stamp?.contentIdentity)).toBe(false);
    });
  });

  it('does not exempt globally linked project source as an installed artifact', async () => {
    await withRuntimeFixture(async ({ project, vendor }) => {
      const source = join(project, 'linked-source.js');
      writeFileSync(source, 'project source\n');
      rmSync(vendor);
      symlinkSync(source, vendor);
      const stamp = await completionTreeStampForEvidence({ filesChanged: [vendor] }, [project]);
      expect(stamp?.contentIdentity?.[0]?.outOfRepoArtifact).toBeUndefined();
      expect(completionTreeContentIdentityMatches(stamp?.contentIdentity)).toBe(false);
    });
  });

  it('still classifies a manager checkout already inferred by the caller root resolver', async () => {
    await withRuntimeFixture(async ({ project, manager, vendor }) => {
      const stamp = await completionTreeStampForEvidence({ filesChanged: [vendor] }, [project, manager]);
      expect(stamp?.contentIdentity?.[0]?.outOfRepoArtifact).toBe(true);
      expect(completionTreeContentIdentityMatches(stamp?.contentIdentity)).toBe(true);
    });
  });

  it('keeps the primary project checkout Git-backed, even for ignored global-layout paths', async () => {
    await withRuntimeFixture(async ({ manager, vendor }) => {
      const stamp = await completionTreeStampForEvidence({ filesChanged: [vendor] }, [manager]);
      expect(stamp?.contentIdentity?.[0]?.outOfRepoArtifact).toBeUndefined();
      expect(completionTreeContentIdentityMatches(stamp?.contentIdentity)).toBe(false);
    });
  });

  it('keeps ordinary local npm dependencies in sibling checkouts Git-backed', async () => {
    await withRuntimeFixture(async ({ project, manager }) => {
      const dependency = join(manager, 'src', 'node_modules', 'example', 'index.js');
      mkdirSync(join(dependency, '..'), { recursive: true });
      writeFileSync(dependency, 'dependency\n');
      const stamp = await completionTreeStampForEvidence({ filesChanged: [dependency] }, [project]);
      expect(stamp?.contentIdentity?.[0]?.gitIgnoreStatus).toBe('ignored');
      expect(stamp?.contentIdentity?.[0]?.outOfRepoArtifact).toBeUndefined();
      expect(completionTreeContentIdentityMatches(stamp?.contentIdentity)).toBe(false);
    });
  });

  it('keeps ignored source outside managed checkouts Git-backed', async () => {
    await withRuntimeFixture(async ({ project, manager }) => {
      const source = join(manager, 'src', 'fix.ts');
      mkdirSync(join(source, '..'), { recursive: true });
      writeFileSync(source, 'source\n');
      const stamp = await completionTreeStampForEvidence({ filesChanged: [source] }, [project]);
      expect(stamp?.contentIdentity?.[0]?.gitIgnoreStatus).toBe('ignored');
      expect(stamp?.contentIdentity?.[0]?.outOfRepoArtifact).toBeUndefined();
      expect(completionTreeContentIdentityMatches(stamp?.contentIdentity)).toBe(false);
    });
  });

  it('does not exempt a missing installed file', async () => {
    await withRuntimeFixture(async ({ project, vendor }) => {
      const stamp = await completionTreeStampForEvidence({ filesChanged: [vendor + '.missing'] }, [project]);
      expect(stamp?.contentIdentity?.[0]?.outOfRepoArtifact).toBeUndefined();
      expect(completionTreeContentIdentityMatches(stamp?.contentIdentity)).toBe(false);
    });
  });

  it('does not exempt failed or unknown ignore observations', async () => {
    await withRuntimeFixture(async ({ project, vendor }) => {
      const stamp = await completionTreeStampForEvidence({ filesChanged: [vendor] }, [project], {
        gitIgnoreStatusProbe: async () => undefined,
      });
      expect(stamp?.contentIdentity?.[0]?.gitIgnoreStatus).toBe('unknown');
      expect(stamp?.contentIdentity?.[0]?.outOfRepoArtifact).toBeUndefined();
      expect(completionTreeContentIdentityMatches(stamp?.contentIdentity)).toBe(false);
    });
  });

  it('does not exempt an unreadable HEAD tree', async () => {
    await withRuntimeFixture(async ({ project, vendor }) => {
      const stamp = await completionTreeStampForEvidence({ filesChanged: [vendor] }, [project], {
        headBlobs: (_root, _sha, paths) => new Map(paths.map((path) => [path, {
          status: 'unresolvable' as const, reason: 'HEAD read failed',
        }])),
      });
      expect(stamp?.contentIdentity?.[0]?.headBlobUnresolvable).toBe('HEAD read failed');
      expect(stamp?.contentIdentity?.[0]?.outOfRepoArtifact).toBeUndefined();
      expect(completionTreeContentIdentityMatches(stamp?.contentIdentity)).toBe(false);
    });
  });
});

describe('completionFreshnessForEvidence (EI-21259433290500193)', () => {
  it('returns no signal when terminal evidence has no valid tree stamp', async () => {
    expect(await completionFreshnessForEvidence({ verifiedHow: 'unit' })).toBeUndefined();
    expect(
      await completionFreshnessForEvidence({ treeStamp: { repositoryRoot: '/repo', headSha: 'short' } }),
    ).toBeUndefined();
  });

  it('reports fresh when the stored and current stamps match', async () => {
    const currentStamp = vi.fn(() => stored);

    const result = await completionFreshnessForEvidence({ treeStamp: stored }, { currentStamp });

    expect(currentStamp).toHaveBeenCalledWith(stored);
    expect(result).toMatchObject({
      verdict: 'fresh',
      storedTreeStamp: stored,
      currentTreeStamp: stored,
    });
  });

  it('reports fresh when a peer advanced HEAD without changing declared path content', async () => {
    const result = await completionFreshnessForEvidence({ treeStamp: stored }, { currentStamp: () => current });

    expect(result).toMatchObject({
      verdict: 'fresh',
      storedTreeStamp: stored,
      currentTreeStamp: current,
    });
    expect(result?.reason).toMatch(/remains fresh across HEAD movement/);
  });

  it('reports stale when the declared path content changed across HEADs', async () => {
    const changedCurrent = {
      repositoryRoot: '/repo',
      headSha: 'b'.repeat(40),
      contentIdentity: [{ path: 'src/fix.ts', workingTreeBlobSha: 'd'.repeat(40), headBlobSha: 'd'.repeat(40) }],
    };

    const result = await completionFreshnessForEvidence({ treeStamp: stored }, { currentStamp: () => changedCurrent });

    expect(result).toMatchObject({
      verdict: 'stale',
      storedTreeStamp: stored,
      currentTreeStamp: changedCurrent,
    });
    expect(result?.reason).toMatch(/Committed content for src\/fix\.ts changed/);
  });

  it('reports stale when the declared path set changes', async () => {
    const changedCurrent = {
      repositoryRoot: '/repo',
      headSha: 'b'.repeat(40),
      contentIdentity: [{ path: 'src/other.ts', workingTreeBlobSha: 'c'.repeat(40), headBlobSha: 'c'.repeat(40) }],
    };

    const result = await completionFreshnessForEvidence({ treeStamp: stored }, { currentStamp: () => changedCurrent });

    expect(result?.verdict).toBe('stale');
    expect(result?.reason).toMatch(/different declared path set/);
  });

  it('reports unavailable rather than falsely calling evidence fresh', async () => {
    const result = await completionFreshnessForEvidence({ treeStamp: stored }, { currentStamp: () => undefined });

    expect(result).toMatchObject({ verdict: 'unavailable', storedTreeStamp: stored });
    expect(result?.currentTreeStamp).toBeUndefined();
    expect(result?.reason).toMatch(/not established/);
  });

  it('is fail-soft when the injected current-stamp probe throws', async () => {
    const result = await completionFreshnessForEvidence(
      { treeStamp: stored },
      {
        currentStamp: () => {
          throw new Error('EIO');
        },
      },
    );

    expect(result?.verdict).toBe('unavailable');
  });

  it('fails closed when a legacy stamp has no committed-content identity', async () => {
    const result = await completionFreshnessForEvidence(
      { treeStamp: { repositoryRoot: '/repo', headSha: 'a'.repeat(40) } },
      { currentStamp: () => stored },
    );

    expect(result?.verdict).toBe('not-applicable');
    expect(result?.reason).toMatch(/No changed files.*not applicable/);
  });

  it('reports pathless verification as not-applicable for explicit and legacy-empty path lists', async () => {
    for (const evidence of [
      { filesChanged: [], treeStamp: { repositoryRoot: '/repo', headSha: 'a'.repeat(40) } },
      { treeStamp: { repositoryRoot: '/repo', headSha: 'a'.repeat(40) } },
    ]) {
      const currentStamp = vi.fn(() => current);
      const result = await completionFreshnessForEvidence(evidence, { currentStamp });

      expect(result).toMatchObject({
        verdict: 'not-applicable',
        storedTreeStamp: evidence.treeStamp,
      });
      expect(result?.reason).toMatch(/No changed files.*not applicable/);
      expect(currentStamp).not.toHaveBeenCalled();
    }
  });

  it('keeps a file-bearing stamp without content identity unavailable', async () => {
    const result = await completionFreshnessForEvidence(
      { filesChanged: ['src/fix.ts'], treeStamp: { repositoryRoot: '/repo', headSha: 'a'.repeat(40) } },
      { currentStamp: () => current },
    );

    expect(result?.verdict).toBe('unavailable');
    expect(result?.reason).toMatch(/content identity/);
  });

  it('reports stale when a dirty worktree file exists but HEAD has no blob for it', async () => {
    const result = await completionFreshnessForEvidence(
      { treeStamp: stored },
      {
        currentStamp: () => ({
          repositoryRoot: '/repo',
          headSha: stored.headSha,
          contentIdentity: [{ path: 'src/fix.ts', workingTreeBlobSha: 'd'.repeat(40), headBlobSha: null }],
        }),
      },
    );

    expect(result?.verdict).toBe('stale');
    expect(result?.reason).toMatch(/does not match committed HEAD/);
  });

  /**
   * WI-42441 — `stale` is a claim about the EVIDENCE; `unavailable` is a claim about our
   * ABILITY TO CHECK. An unreadable submodule produces the same null headBlobSha as a real
   * drift, so this read path used to report a perfectly current completion as stale and
   * send the reader to re-verify it. The mismatch case above is the permanent CONTROL:
   * both tests assert on the same field, so an implementation that collapses the two
   * verdicts fails one of them whichever way it collapses.
   */
  it('reports unavailable, not stale, when a declared path could not be resolved', async () => {
    const reason = "submodule 'libs/papercusp' could not be read at abc123456789";
    const result = await completionFreshnessForEvidence(
      { treeStamp: stored },
      {
        currentStamp: () => ({
          repositoryRoot: '/repo',
          headSha: stored.headSha,
          contentIdentity: [
            {
              path: 'src/fix.ts',
              workingTreeBlobSha: 'c'.repeat(40),
              headBlobSha: null,
              headBlobUnresolvable: reason,
            },
          ],
        }),
      },
    );

    expect(result?.verdict).toBe('unavailable');
    expect(result?.reason).toContain(reason);
    expect(result?.reason).toMatch(/not evidence of staleness/);
  });
});

describe('multi-repository completion freshness (WI-6554700010045460)', () => {
  async function withRepositories(run: (primary: string, secondary: string) => Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), 'completion-freshness-repositories-'));
    try {
      const primary = join(root, 'primary-checkout');
      const secondary = join(root, 'secondary');
      for (const repo of [primary, secondary]) {
        mkdirSync(repo);
        initializeIgnoreFixture(repo);
        // Equal relative paths deliberately have different contents in each checkout.
        writeFileSync(join(repo, 'fix.ts'), `export const repository = ${JSON.stringify(repo)};\n`);
        gitFixture(repo, 'add', '--', 'fix.ts');
        gitFixture(repo, 'commit', '-qm', 'source');
      }
      await run(primary, secondary);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  async function evidenceFor(primary: string, secondary: string) {
    const treeStamp = await completionTreeStampForEvidence({
      filesChanged: [join(primary, 'fix.ts'), join(secondary, 'fix.ts')],
      filesDeleted: [join(secondary, 'removed.ts')],
    }, [primary, secondary]);
    expect(treeStamp?.repositoryRoot).toBe(primary);
    expect(treeStamp?.contentIdentity).toContainEqual(expect.objectContaining({
      path: 'fix.ts', repositoryRoot: secondary,
    }));
    expect(completionTreeContentIdentityMatches(treeStamp?.contentIdentity)).toBe(true);
    return { treeStamp };
  }

  it('re-probes each owning checkout, preserving duplicate relative paths, deletions and external artifacts', async () => {
    await withRepositories(async (primary, secondary) => {
      const evidence = await evidenceFor(primary, secondary);
      evidence.treeStamp!.contentIdentity!.push({
        path: '/external/report.json', workingTreeBlobSha: null, headBlobSha: null, outOfRepoArtifact: true,
      });
      const result = await completionFreshnessForEvidence(evidence);
      expect(result?.verdict).toBe('fresh');
      expect(result?.currentTreeStamp?.contentIdentity).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'fix.ts', repositoryRoot: secondary }),
        expect.objectContaining({ path: 'removed.ts', repositoryRoot: secondary, deletion: true }),
        expect.objectContaining({ path: '/external/report.json', outOfRepoArtifact: true }),
      ]));
    });
  });

  it('measures secondary HEAD movement without invalidating unchanged declared content', async () => {
    await withRepositories(async (primary, secondary) => {
      const evidence = await evidenceFor(primary, secondary);
      gitFixture(secondary, 'commit', '--allow-empty', '-qm', 'unrelated');
      const currentHead = gitFixture(secondary, 'rev-parse', 'HEAD');
      const result = await completionFreshnessForEvidence(evidence);
      expect(result?.verdict).toBe('fresh');
      expect(result?.currentTreeStamp?.contentIdentity).toContainEqual(expect.objectContaining({
        path: 'fix.ts', repositoryRoot: secondary, headSha: currentHead,
      }));
    });
  });

  it.each(['dirty', 'committed', 'resurrected deletion'] as const)('reports stale for a secondary %s change', async (change) => {
    await withRepositories(async (primary, secondary) => {
      const evidence = await evidenceFor(primary, secondary);
      const file = change === 'resurrected deletion' ? 'removed.ts' : 'fix.ts';
      writeFileSync(join(secondary, file), 'export const changed = true;\n');
      if (change === 'committed') {
        gitFixture(secondary, 'add', '--', file);
        gitFixture(secondary, 'commit', '-qm', 'changed');
      }
      const result = await completionFreshnessForEvidence(evidence);
      expect(result?.verdict).toBe('stale');
      expect(result?.currentTreeStamp?.contentIdentity).toContainEqual(expect.objectContaining({
        path: file, repositoryRoot: secondary, headSha: gitFixture(secondary, 'rev-parse', 'HEAD'),
      }));
    });
  });

  it('reports unavailable when the secondary checkout cannot be observed', async () => {
    await withRepositories(async (primary, secondary) => {
      const evidence = await evidenceFor(primary, secondary);
      rmSync(join(secondary, '.git'), { recursive: true });
      expect((await completionFreshnessForEvidence(evidence))?.verdict).toBe('unavailable');
    });
  });

  it('rejects a changed owning repository even when the relative path and blobs match', async () => {
    const entry = { ...identity[0]!, repositoryRoot: '/secondary' };
    const result = await completionFreshnessForEvidence({ treeStamp: { ...stored, contentIdentity: [entry] } }, {
      currentStamp: () => ({ ...current, contentIdentity: [{ ...entry, repositoryRoot: '/other' }] }),
    });
    expect(result?.verdict).toBe('stale');
  });
});

describe('completionTreeContentIdentityMatches — WI-1409142 absent-key hole', () => {
  /**
   * Stored evidence really can arrive with these keys MISSING rather than null: a
   * recursive `jsonb_strip_nulls` on the terminal payload write deleted them. Under
   * the old strict `!== null` such an entry read as a MATCH — `undefined !== null` is
   * true twice, then `undefined === undefined` — so the floor would mint `committed`
   * authority from an observation the server never actually made. That is the one
   * direction this check must never fail in.
   */
  it('does NOT report a match when both blob-sha keys are absent', () => {
    expect(completionTreeContentIdentityMatches([
      { path: 'src/fix.ts' } as unknown as CompletionTreeContentIdentity,
    ])).toBe(false);
  });

  it('does NOT report a match when only the HEAD side is absent', () => {
    expect(completionTreeContentIdentityMatches([
      { path: 'src/fix.ts', workingTreeBlobSha: 'c'.repeat(40) } as unknown as CompletionTreeContentIdentity,
    ])).toBe(false);
  });

  it('still matches when both sides carry the same observed sha', () => {
    expect(completionTreeContentIdentityMatches(identity)).toBe(true);
  });

  it('matches an artifact-only identity because the server classified it as out of repo', () => {
    expect(
      completionTreeContentIdentityMatches([
        { path: '/tmp/proof.png', workingTreeBlobSha: null, headBlobSha: null, outOfRepoArtifact: true },
      ]),
    ).toBe(true);
  });

  it('ignores artifacts only after requiring every repo-backed entry to match', () => {
    expect(
      completionTreeContentIdentityMatches([
        identity[0]!,
        { path: '/tmp/proof.png', workingTreeBlobSha: null, headBlobSha: null, outOfRepoArtifact: true },
      ]),
    ).toBe(true);
    expect(
      completionTreeContentIdentityMatches([
        { path: 'src/fix.ts', workingTreeBlobSha: 'd'.repeat(40), headBlobSha: 'c'.repeat(40) },
        { path: '/tmp/proof.png', workingTreeBlobSha: null, headBlobSha: null, outOfRepoArtifact: true },
      ]),
    ).toBe(false);
  });

  it('still rejects an explicit null, unchanged', () => {
    expect(completionTreeContentIdentityMatches([
      { path: 'src/fix.ts', workingTreeBlobSha: 'c'.repeat(40), headBlobSha: null },
    ])).toBe(false);
  });
});

// EI-21970667079827352: the `proposed` warning named the RULE but never the FACT, so a
// close whose only problem was an unswept path looked identical to one naming a path that
// does not exist. The first settles itself; the second never does. `settles` is the field
// that changes what the caller actually does, so it is what these pin.
describe('unprovenContentIdentityPaths (EI-21970667079827352)', () => {
  const sha = (c: string) => c.repeat(40);

  it('returns nothing when every declared path is proven — a clean stamp names no paths', () => {
    expect(
      unprovenContentIdentityPaths({
        contentIdentity: [{ path: 'a.ts', workingTreeBlobSha: sha('c'), headBlobSha: sha('c') }],
      }),
    ).toEqual([]);
  });

  it('in the tree but not yet in the commit is missing-from-commit, and a SWEEP settles it', () => {
    expect(
      unprovenContentIdentityPaths({
        contentIdentity: [{ path: 'a.ts', workingTreeBlobSha: sha('c'), headBlobSha: null }],
      }),
    ).toEqual([{ path: 'a.ts', reason: 'missing-from-commit', settles: 'sweep' }]);
  });

  it('uses measured not-ignored status instead of the legacy scratch-prefix rule', () => {
    expect(
      unprovenContentIdentityPaths({
        contentIdentity: [
          {
            path: '.papercusp/scratch/keep.mts',
            workingTreeBlobSha: sha('c'),
            headBlobSha: null,
            gitIgnoreStatus: 'not-ignored',
          },
        ],
      }),
    ).toEqual([{ path: '.papercusp/scratch/keep.mts', reason: 'missing-from-commit', settles: 'sweep' }]);
  });

  it('classifies documented gitignored scratch paths as never-settling, not sweep-pending', () => {
    expect(
      unprovenContentIdentityPaths({
        contentIdentity: [
          {
            path: './.papercusp\\scratch\\probe.mts',
            workingTreeBlobSha: sha('c'),
            headBlobSha: null,
          },
        ],
      }),
    ).toEqual([
      {
        path: './.papercusp\\scratch\\probe.mts',
        reason: 'gitignored-scratch-path',
        settles: 'never',
      },
    ]);
  });

  it('classifies documented gitignored tmp paths as never-settling, including tmp-* roots', () => {
    expect(
      unprovenContentIdentityPaths({
        contentIdentity: [
          { path: '.papercusp/tmp/p013-tauri-live.mjs', workingTreeBlobSha: sha('c'), headBlobSha: null },
          { path: './.papercusp\\tmp-run-42\\driver.mjs', workingTreeBlobSha: sha('d'), headBlobSha: null },
        ],
      }),
    ).toEqual([
      { path: '.papercusp/tmp/p013-tauri-live.mjs', reason: 'gitignored-tmp-path', settles: 'never' },
      { path: './.papercusp\\tmp-run-42\\driver.mjs', reason: 'gitignored-tmp-path', settles: 'never' },
    ]);
  });

  it('two differing blobs is content-mismatch, and a SWEEP settles it', () => {
    expect(
      unprovenContentIdentityPaths({
        contentIdentity: [{ path: 'a.ts', workingTreeBlobSha: sha('c'), headBlobSha: sha('d') }],
      }),
    ).toEqual([{ path: 'a.ts', reason: 'content-mismatch', settles: 'sweep' }]);
  });

  // The whole point of the change: this is the case where waiting is futile, and the old
  // text was indistinguishable from the two above.
  it('absent from BOTH trees can NEVER be settled by waiting — the misspelled/reverted path', () => {
    expect(
      unprovenContentIdentityPaths({
        contentIdentity: [{ path: 'typo.ts', workingTreeBlobSha: null, headBlobSha: null }],
      }),
    ).toEqual([{ path: 'typo.ts', reason: 'absent-from-both', settles: 'never' }]);
  });

  it('in the commit but gone from the working tree also never settles', () => {
    expect(
      unprovenContentIdentityPaths({
        contentIdentity: [{ path: 'deleted.ts', workingTreeBlobSha: null, headBlobSha: sha('d') }],
      }),
    ).toEqual([{ path: 'deleted.ts', reason: 'absent-from-working-tree', settles: 'never' }]);
  });

  // WI-42441 split server-side resolution failure away from "the closer's path is wrong"
  // precisely because they carry opposite remedies. Folding it back in here would undo that.
  it('EXCLUDES a server-side resolution failure — that is WI-42441s branch, with the opposite remedy', () => {
    expect(
      unprovenContentIdentityPaths({
        contentIdentity: [
          {
            path: 'sub/mod.ts',
            workingTreeBlobSha: sha('c'),
            headBlobSha: null,
            headBlobUnresolvable: 'submodule-not-initialized',
          },
        ],
      }),
    ).toEqual([]);
  });

  it('skips explicit out-of-repo artifacts instead of warning absent-from-both', () => {
    expect(
      unprovenContentIdentityPaths({
        contentIdentity: [
          { path: '/tmp/proof.png', workingTreeBlobSha: null, headBlobSha: null, outOfRepoArtifact: true },
        ],
      }),
    ).toEqual([]);
  });

  it('separates a mixed set so the caller can act on each half differently', () => {
    const out = unprovenContentIdentityPaths({
      contentIdentity: [
        { path: 'proven.ts', workingTreeBlobSha: sha('c'), headBlobSha: sha('c') },
        { path: 'pending.ts', workingTreeBlobSha: sha('c'), headBlobSha: null },
        { path: 'typo.ts', workingTreeBlobSha: null, headBlobSha: null },
      ],
    });
    expect(out).toEqual([
      { path: 'pending.ts', reason: 'missing-from-commit', settles: 'sweep' },
      { path: 'typo.ts', reason: 'absent-from-both', settles: 'never' },
    ]);
    expect(out.filter((e) => e.settles === 'never').map((e) => e.path)).toEqual(['typo.ts']);
  });

  it('is empty for a missing or empty stamp rather than throwing', () => {
    expect(unprovenContentIdentityPaths(undefined)).toEqual([]);
    expect(unprovenContentIdentityPaths(null)).toEqual([]);
    expect(unprovenContentIdentityPaths({})).toEqual([]);
  });
});

// The sentence is the deliverable: it is the only part of this a closing agent reads, and
// the whole defect was that it described the RULE instead of the FACT. These pin the one
// distinction that changes the caller's next action.
describe('describeUnprovenContentIdentity (EI-21970667079827352)', () => {
  const pending = { path: 'a.ts', reason: 'missing-from-commit' as const, settles: 'sweep' as const };
  const typo = { path: 'typo.ts', reason: 'absent-from-both' as const, settles: 'never' as const };

  it('says nothing when nothing is unproven — no rows, no sentence', () => {
    expect(describeUnprovenContentIdentity([], 3)).toBeUndefined();
  });

  it('names the offending path and the declared total, so 1-of-6 does not read as all-of-6', () => {
    const out = describeUnprovenContentIdentity([pending], 6)!;
    expect(out).toContain('1 of 6 declared');
    expect(out).toContain('`a.ts` (missing-from-commit)');
  });

  it('preview shares the exact path facts without claiming a close was recorded or will settle', () => {
    const preview = describeUnprovenContentIdentity([pending, typo], 6, 'preview')!;
    expect(preview).toContain('2 of 6 declared');
    expect(preview).toContain('`a.ts` (missing-from-commit)');
    expect(preview).toContain('`typo.ts` (absent-from-both)');
    expect(describeUnprovenContentIdentity([pending, typo], 6)).toContain(preview);
    expect(preview).not.toMatch(/accepted|recorded|reconciler|re-call|WAITING/);
    expect(describeUnprovenContentIdentity([], 6, 'preview')).toBeUndefined();
  });

  it('an all-sweep set tells the caller settlement is automatic after git-sync', () => {
    const out = describeUnprovenContentIdentity([pending], 6)!;
    expect(out).toContain('WAITING SETTLES THIS');
    expect(out).toContain('completion-settlement reconciler');
    expect(out).toContain('automatically');
    expect(out).not.toContain('re-send this IDENTICAL completion');
    expect(out).toContain('Do not re-call `work_items:complete`');
    // It must NOT send them to re-verify work that is already correct — the old text did.
    expect(out).toContain('re-verify work that is already correct');
    expect(out).not.toContain('WAITING WILL NOT SETTLE');
  });

  it('WI-10004711: names the one post-close event that falsifies "waiting settles this", and its signal', () => {
    // Without this, a closer whose file was edited again before the sweep sat on an
    // unsettleable close forever, obeying "Do not re-call work_items:complete".
    for (const out of [
      describeUnprovenContentIdentity([pending], 6)!,
      describeUnprovenContentIdentity([pending, { path: 'gone.ts', reason: 'absent-from-both', settles: 'never' }], 6)!,
    ]) {
      expect(out).toContain('`superseded-before-commit`');
      expect(out).toContain('sends you a coord message');
      expect(out).toContain('re-send `work_items:complete` for this id');
    }
  });

  // The case the old single sentence could not express, and the reason this item existed:
  // an unbounded wait for something that can never happen.
  it('an all-never set says WAITING WILL NOT SETTLE and sends them to fix the path', () => {
    const out = describeUnprovenContentIdentity([typo], 2)!;
    expect(out).toContain('WAITING WILL NOT SETTLE THIS');
    expect(out).toContain('`typo.ts` (absent-from-both)');
    expect(out).toContain('never a plausible-looking guess');
    expect(out).not.toContain('WAITING SETTLES THIS');
  });

  it('names gitignored scratch paths as permanently non-committable instead of waitable', () => {
    const scratch = {
      path: '.papercusp/scratch/probe.mts',
      reason: 'gitignored-scratch-path' as const,
      settles: 'never' as const,
    };
    const out = describeUnprovenContentIdentity([scratch], 1)!;
    expect(out).toContain('WAITING WILL NOT SETTLE THIS');
    expect(out).toContain('documented gitignored `.papercusp/scratch/` prefix');
    expect(out).toContain('NO sweep can ever commit it');
    expect(out).toContain('Remove it from `filesChanged`');
    expect(out).not.toContain('WAITING SETTLES THIS');
    expect(out).not.toContain('absent from the working tree');
  });

  it('names gitignored tmp paths as permanently non-committable instead of waitable', () => {
    const tmp = {
      path: '.papercusp/tmp/p013-tauri-live.mjs',
      reason: 'gitignored-tmp-path' as const,
      settles: 'never' as const,
    };
    const out = describeUnprovenContentIdentity([tmp], 1)!;
    expect(out).toContain('WAITING WILL NOT SETTLE THIS');
    expect(out).toContain('documented gitignored `.papercusp/tmp/ or .papercusp/tmp-*` prefix');
    expect(out).toContain('NO sweep can ever commit it');
    expect(out).toContain('Remove it from `filesChanged`');
    expect(out).not.toContain('WAITING SETTLES THIS');
    expect(out).not.toContain('absent from the working tree');
  });

  it('a MIXED set separates the halves — waiting alone must not read as sufficient', () => {
    const out = describeUnprovenContentIdentity([pending, typo], 5)!;
    expect(out).toContain('MIXED');
    expect(out).toContain('2 of 5 declared');
    expect(out).toContain('`a.ts` (missing-from-commit) will be checked automatically');
    expect(out).toContain('completion-settlement reconciler');
    // Singular here on purpose: one never-settling path, so "is", not "are".
    expect(out).toContain('`typo.ts` (absent-from-both) is absent from the working tree');
    expect(out).toContain('leaves this close `proposed` indefinitely');
  });

  it('falls back to the row count when no declared count is available, never reporting "of 0"', () => {
    const out = describeUnprovenContentIdentity([pending], 0)!;
    expect(out).toContain('1 of 1 declared');
    expect(out).not.toContain('of 0');
  });

  it('agrees in number for a single never-settling path (is/it, not are/them)', () => {
    const out = describeUnprovenContentIdentity([typo], 1)!;
    expect(out).toContain('is absent from the working tree');
    expect(out).toContain('can ever commit it');
  });
});
