/**
 * workspace-map — the generated "Where to work" section of the SU playbooks
 * (staging-branch-pipeline-2026-06-06).
 *
 * Agents kept needing to know WHICH directory is the real workspace vs the
 * pipeline artifacts (the release + checkpoint checkouts), and which branch the
 * shared tree lives on. Those facts are CONFIG, not prose — they changed on
 * 2026-06-06 (main→staging) and hand-written playbook text drifted. So the
 * playbook carries a `<!-- PAPERCUSP-SU:WORKSPACE-MAP -->` marker and this
 * renderer derives release/checkpoint paths and branches from the same config
 * seams as `release-config.ts` and `dev-deploy-state.ts`; when a serving host
 * differs from the edit tree, `PAPERCUSP_CANONICAL_TREE` names the tree agents
 * should use. Every freshly-rendered psu prompt follows those settings.
 *
 * The canonical edit-tree env wins over the serving integration root: on :3170,
 * `PAPERCUSP_INTEGRATION_ROOT` names the isolated mirror while
 * `PAPERCUSP_CANONICAL_TREE` names the shared checkout agents edit. Then use the
 * git-toplevel fallback > cwd, with sibling-dir defaults for release/checkpoint.
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import * as path from 'node:path';
import { resolveReleaseRoot } from '../release/release-root';

export interface WorkspaceMapConfig {
  integrationRoot: string;
  releaseRoot: string;
  checkpointRoot: string;
  integrationBranch: string;
  releaseRef: string;
  /**
   * EI-8794: false ONLY when `integrationRoot` could NOT be confirmed as a git
   * checkout — `git rev-parse --show-toplevel` failed (not a git repo, e.g. the
   * packaged desktop app's non-git `dev-source` extraction tree) and we fell
   * back to `process.cwd()`. Omitted/undefined and `true` both mean "confirmed"
   * (either git succeeded, or an explicit `PAPERCUSP_INTEGRATION_ROOT` override
   * is trusted without re-verifying). `renderWorkspaceMapSection` must NOT claim
   * this directory is the canonical shared tree when this is `false` — that
   * false claim is what silently strands edits (the 2026-06-30 incident class).
   */
  gitDetected?: boolean;
  /** Whether the configured path is an existing directory in the rendering runtime. */
  integrationRootAvailable?: boolean;
  /** Whether the configured path is an existing directory in the rendering runtime. */
  releaseRootAvailable?: boolean;
  /** Whether the configured path is an existing directory in the rendering runtime. */
  checkpointRootAvailable?: boolean;
}

function isDirectoryAvailable(directory: string): boolean {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve the canonical edit tree plus the release-gate paths/branches. */
export function resolveWorkspaceMapConfig(): WorkspaceMapConfig {
  let integrationRoot =
    process.env.PAPERCUSP_CANONICAL_TREE?.trim() || process.env.PAPERCUSP_INTEGRATION_ROOT?.trim() || '';
  let gitDetected: boolean | undefined;
  if (!integrationRoot) {
    try {
      integrationRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        timeout: 5000,
        // EI-8794: a failing git call (e.g. run against a non-git tree) must
        // NOT leak "fatal: not a git repository" onto the parent's own
        // stderr/log stream — mirrors build-info.ts's defaultGitSha().
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      integrationRoot = process.cwd();
      gitDetected = false;
    }
  }
  const parent = path.dirname(integrationRoot);
  const releaseRoot = resolveReleaseRoot({ integrationRoot });
  const checkpointRoot =
    process.env.PAPERCUSP_CHECKPOINT_ROOT ?? path.join(parent, `${path.basename(integrationRoot)}-checkpoint`);
  return {
    integrationRoot,
    // WI-10005161: the one shared release-checkout resolver.
    releaseRoot,
    // Per-root, matching release-config.ts (2026-07-02 cross-lineage race fix):
    // <basename(integrationRoot)>-checkpoint, never a fixed shared name.
    checkpointRoot,
    integrationBranch: process.env.PAPERCUSP_INTEGRATION_BRANCH ?? 'staging',
    releaseRef: process.env.PAPERCUSP_RELEASE_REF ?? 'main',
    integrationRootAvailable: isDirectoryAvailable(integrationRoot),
    releaseRootAvailable: isDirectoryAvailable(releaseRoot),
    checkpointRootAvailable: isDirectoryAvailable(checkpointRoot),
    // Only set (to false) when detection genuinely failed; path availability is
    // reported independently so a stale explicit override is not called canonical.
    ...(gitDetected === false ? { gitDetected: false as const } : {}),
  };
}

/**
 * Render the "Where to work" markdown section. Pure over the (injectable)
 * config so the content is unit-testable without env games.
 */
export function renderWorkspaceMapSection(cfg: WorkspaceMapConfig = resolveWorkspaceMapConfig()): string {
  const { integrationRoot, releaseRoot, checkpointRoot, integrationBranch, releaseRef, gitDetected } = cfg;
  // EI-8794: never claim an unconfirmed directory is the canonical git tree — that
  // false claim is exactly what silently stranded edits in the packaged-desktop
  // dev-source case (a non-git tree, mislabeled "✅ ... work happens here").
  const canonicalLine =
    gitDetected === false
      ? `- ⚠️ \`${integrationRoot}\` — NOT a git checkout (\`git rev-parse --show-toplevel\` failed here, so this could NOT be confirmed as the canonical shared tree). Do NOT treat this directory as canonical: an edit made here may never be committed or deployed. Locate the real canonical git checkout (or set \`PAPERCUSP_INTEGRATION_ROOT\`) before editing.`
      : cfg.integrationRootAvailable === false
        ? `- ⚠️ \`${integrationRoot}\` — the configured integration tree does not exist in this runtime. Do NOT use it as the canonical checkout or pass it as a command cwd; correct \`PAPERCUSP_CANONICAL_TREE\` / \`PAPERCUSP_INTEGRATION_ROOT\` first.`
      : `- ✅ \`${integrationRoot}\` — the canonical shared tree (branch \`${integrationBranch}\`). ALL repo work happens here — superproject and submodules alike, edited in place; git-sync sweeps this tree to \`origin/${integrationBranch}\` on a schedule.`;
  const releaseLine =
    cfg.releaseRootAvailable === false
      ? `- ⚠️ \`${releaseRoot}\` — the configured release checkout does not exist in this runtime. Do NOT pass this path as a command cwd; correct \`PAPERCUSP_RELEASE_ROOT\` / release-gate configuration and render the map again.`
      : `- 🚫 \`${releaseRoot}\` — the live operator's deploy artifact, pinned to green \`${releaseRef}\`. NEVER edit it: every deploy resets + cleans it and rebuilds its SPA dist, so a change there is clobbered and never reaches origin. If the live host lacks your fix, the fix isn't deployed yet — work in the canonical tree and let the pipeline carry it.`;
  const checkpointLine =
    cfg.checkpointRootAvailable === false
      ? `- ⚠️ \`${checkpointRoot}\` — the configured isolated checkpoint tree does not exist in this runtime. Do NOT pass this path as a command cwd; re-check the checkpoint-root configuration before using it.`
      : `- 🚫 \`${checkpointRoot}\` — the green-checkpoint's ISOLATED test tree. Never edit it and never leave stray files in it (it is reset + cleaned every run; untracked debris there can poison the green gate for the whole fleet).`;
  return [
    `**Where to work — the workspace map** *(generated from the live release-gate config; configured roots are checked against this runtime)*:`,
    ``,
    canonicalLine,
    releaseLine,
    checkpointLine,
    `- 🚫 other sibling \`papercup-*\` directories — preserved special-purpose worktrees on their own branches. Not for new work.`,
    ``,
    `\`${releaseRef}\` is automation-only — green-checkpoint fast-forwards it from green \`${integrationBranch}\`; a pre-push hook blocks manual pushes. Quick self-check before editing: \`pwd\` is under \`${integrationRoot}\` and \`git branch --show-current\` prints \`${integrationBranch}\`.`,
  ].join('\n');
}
