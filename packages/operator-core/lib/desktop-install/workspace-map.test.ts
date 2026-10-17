/**
 * workspace-map.test.ts — the generated "Where to work" playbook section
 * (staging-branch-pipeline-2026-06-06). The CONTENT is config-derived, so the
 * tests pin the contract: paths/branches come from the (injectable) config,
 * env seams override, and the section carries the three load-bearing rules
 * (work in the integration tree; never touch the release/checkpoint trees;
 * the green pin is automation-only).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { renderWorkspaceMapSection, resolveWorkspaceMapConfig } from './workspace-map';

// EI-8794: the fallback-detection tests below stub `execFileSync` itself (rather
// than relying on the real `git` binary), so the "detection failed" path is
// deterministic regardless of what git checkout the test happens to run inside.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
import { execFileSync } from 'node:child_process';

const CFG = {
  integrationRoot: '/work/papercup',
  releaseRoot: '/work/papercup-release',
  checkpointRoot: '/work/papercup-checkpoint',
  integrationBranch: 'staging',
  releaseRef: 'main',
};

describe('renderWorkspaceMapSection', () => {
  it('renders the canonical tree + branch and the two do-not-touch artifact trees', () => {
    const s = renderWorkspaceMapSection(CFG);
    expect(s).toContain('Where to work');
    expect(s).toContain('✅ `/work/papercup`');
    expect(s).toContain('branch `staging`');
    expect(s).toContain('origin/staging');
    expect(s).toContain('🚫 `/work/papercup-release`');
    expect(s).toContain('🚫 `/work/papercup-checkpoint`');
  });

  it('states the green pin is automation-only and includes the self-check', () => {
    const s = renderWorkspaceMapSection(CFG);
    expect(s).toContain('`main` is automation-only');
    expect(s).toContain('green-checkpoint fast-forwards it');
    expect(s).toContain('git branch --show-current');
  });

  it('follows the config, not hardcoded names (the whole point — branches changed once already)', () => {
    const s = renderWorkspaceMapSection({
      ...CFG,
      integrationBranch: 'firehose',
      releaseRef: 'golden',
    });
    expect(s).toContain('branch `firehose`');
    expect(s).toContain('`golden` is automation-only');
    expect(s).not.toContain('branch `staging`');
  });

  it('EI-8794: does NOT claim the canonical-tree ✅ when gitDetected is false', () => {
    const s = renderWorkspaceMapSection({ ...CFG, gitDetected: false });
    expect(s).not.toContain('✅');
    expect(s).not.toContain('ALL repo work happens here');
    expect(s).toContain('⚠️');
    expect(s).toContain('NOT a git checkout');
    expect(s).toContain('/work/papercup');
    // The other trees' warnings are unaffected.
    expect(s).toContain('🚫 `/work/papercup-release`');
    expect(s).toContain('🚫 `/work/papercup-checkpoint`');
  });

  it('does not present configured roots missing from this runtime as usable cwd paths', () => {
    const s = renderWorkspaceMapSection({
      ...CFG,
      integrationRootAvailable: false,
      releaseRootAvailable: false,
      checkpointRootAvailable: false,
    });

    expect(s).toContain('configured integration tree does not exist in this runtime');
    expect(s).toContain('configured release checkout does not exist in this runtime');
    expect(s).toContain('configured isolated checkpoint tree does not exist in this runtime');
    expect(s).not.toContain('✅ `/work/papercup`');
    expect(s).not.toContain('🚫 `/work/papercup-release`');
    expect(s).not.toContain('🚫 `/work/papercup-checkpoint`');
  });

  it('renders the canonical ✅ claim when gitDetected is omitted or true (unaffected by the EI-8794 guard)', () => {
    expect(renderWorkspaceMapSection(CFG)).toContain('✅ `/work/papercup`');
    expect(renderWorkspaceMapSection({ ...CFG, gitDetected: true })).toContain('✅ `/work/papercup`');
  });
});

describe('resolveWorkspaceMapConfig', () => {
  beforeEach(() => vi.stubEnv('PAPERCUSP_CANONICAL_TREE', ''));
  afterEach(() => vi.unstubAllEnvs());

  it('uses the canonical edit tree instead of the staging serving mirror', () => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-map-roots-'));
    try {
      const canonical = join(root, 'papercusp');
      const staging = join(root, 'papercusp-staging');
      const release = join(root, 'papercup-release');
      const checkpoint = join(root, 'papercusp-checkpoint');
      for (const directory of [canonical, staging, release, checkpoint]) mkdirSync(directory);
      vi.stubEnv('PAPERCUSP_CANONICAL_TREE', canonical);
      vi.stubEnv('PAPERCUSP_INTEGRATION_ROOT', staging);
      vi.stubEnv('PAPERCUSP_RELEASE_ROOT', release);
      vi.stubEnv('PAPERCUSP_CHECKPOINT_ROOT', checkpoint);

      const cfg = resolveWorkspaceMapConfig();
      expect(cfg.integrationRoot).toBe(canonical);
      expect(cfg.integrationRootAvailable).toBe(true);
      const rendered = renderWorkspaceMapSection(cfg);
      expect(rendered).toContain(`✅ \`${canonical}\``);
      expect(rendered).not.toContain(`✅ \`${staging}\``);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('honours the release-gate env seams', () => {
    vi.stubEnv('PAPERCUSP_INTEGRATION_ROOT', '/x/integ');
    vi.stubEnv('PAPERCUSP_RELEASE_ROOT', '/x/rel');
    vi.stubEnv('PAPERCUSP_CHECKPOINT_ROOT', '/x/chk');
    vi.stubEnv('PAPERCUSP_INTEGRATION_BRANCH', 'staging');
    vi.stubEnv('PAPERCUSP_RELEASE_REF', 'main');
    expect(resolveWorkspaceMapConfig()).toEqual({
      integrationRoot: '/x/integ',
      releaseRoot: '/x/rel',
      checkpointRoot: '/x/chk',
      integrationBranch: 'staging',
      releaseRef: 'main',
      integrationRootAvailable: false,
      releaseRootAvailable: false,
      checkpointRootAvailable: false,
    });
  });

  it('derives sibling defaults from the integration root', () => {
    vi.stubEnv('PAPERCUSP_INTEGRATION_ROOT', '/srv/papercup');
    const cfg = resolveWorkspaceMapConfig();
    expect(cfg.releaseRoot).toBe('/srv/papercup-release');
    expect(cfg.checkpointRoot).toBe('/srv/papercup-checkpoint');
    expect(cfg.integrationBranch).toBe('staging'); // code default mirrors release-config.ts
    expect(cfg.releaseRef).toBe('main');
    expect(cfg.integrationRootAvailable).toBe(false);
    expect(cfg.releaseRootAvailable).toBe(false);
    expect(cfg.checkpointRootAvailable).toBe(false);
  });

  it('checkpoint default is per-root (<basename>-checkpoint), matching release-config.ts', () => {
    // releaseRoot keeps the legacy fixed name; checkpointRoot must NOT — the 2026-07-02
    // cross-lineage race fix namespaces it by the integration root's basename.
    vi.stubEnv('PAPERCUSP_INTEGRATION_ROOT', '/srv/papercusp');
    const cfg = resolveWorkspaceMapConfig();
    expect(cfg.releaseRoot).toBe('/srv/papercup-release');
    expect(cfg.checkpointRoot).toBe('/srv/papercusp-checkpoint');
    expect(cfg.integrationRootAvailable).toBe(false);
    expect(cfg.releaseRootAvailable).toBe(false);
    expect(cfg.checkpointRootAvailable).toBe(false);
  });

  it('EI-8794: suppresses git stderr (stdio-suppressed) via the execFileSync call', () => {
    vi.stubEnv('PAPERCUSP_INTEGRATION_ROOT', '');
    (vi.mocked(execFileSync) as unknown as { mockReturnValueOnce: (v: string) => void }).mockReturnValueOnce(
      '/repo/toplevel\n',
    );
    resolveWorkspaceMapConfig();
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--show-toplevel'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'ignore'] }),
    );
  });

  it('EI-8794: falls back to cwd + gitDetected:false when git rev-parse fails (not a git checkout)', () => {
    vi.stubEnv('PAPERCUSP_INTEGRATION_ROOT', '');
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error('fatal: not a git repository (or any of the parent directories): .git');
    });
    const cfg = resolveWorkspaceMapConfig();
    expect(cfg.integrationRoot).toBe(process.cwd());
    expect(cfg.gitDetected).toBe(false);
  });

  it('EI-8794: gitDetected is omitted (not false) when git rev-parse succeeds', () => {
    vi.stubEnv('PAPERCUSP_INTEGRATION_ROOT', '');
    (vi.mocked(execFileSync) as unknown as { mockReturnValueOnce: (v: string) => void }).mockReturnValueOnce(
      '/repo/toplevel\n',
    );
    const cfg = resolveWorkspaceMapConfig();
    expect(cfg.integrationRoot).toBe('/repo/toplevel');
    expect(cfg.gitDetected).not.toBe(false);
  });
});

describe('live staging workspace-map agreement', () => {
  it('prescribes the existing worktree checked out on the staging branch', (ctx) => {
    // LIVE-environment check: its subject is the checkout this process runs in. It is
    // only meaningful inside the staging worktree itself, or when an explicit canonical
    // override names the tree. The green-checkpoint gate runs the suite from its own
    // detached checkpoint checkout, where `--show-toplevel` (the config's fallback) is
    // that checkout — a different subject, not a regression (WI-10002602).
    const hasCanonicalOverride = Boolean(
      process.env.PAPERCUSP_CANONICAL_TREE?.trim() || process.env.PAPERCUSP_INTEGRATION_ROOT?.trim(),
    );
    const currentBranch = execFileSync('git', ['branch', '--show-current'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!hasCanonicalOverride && currentBranch !== 'staging') {
      ctx.skip();
      return;
    }
    const listing = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const stagingPaths = listing
      .split(/\n{2,}/)
      .map((block) => {
        const worktree = block.match(/^worktree (.+)$/m)?.[1]?.trim();
        const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1]?.trim();
        const prunable = /^prunable(?:\s|$)/m.test(block);
        return worktree && branch === 'staging' && !prunable && existsSync(worktree) ? worktree : null;
      })
      .filter((worktree): worktree is string => worktree !== null);

    expect(stagingPaths).toHaveLength(1);
    const actualStagingPath = stagingPaths[0]!;
    const config = resolveWorkspaceMapConfig();
    expect(config.integrationBranch).toBe('staging');
    expect(resolvePath(config.integrationRoot)).toBe(resolvePath(actualStagingPath));
  });
});
