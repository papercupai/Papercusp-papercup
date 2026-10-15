/**
 * Where a hive's gate-owned sibling trees (`<slug>-checkpoint`, `<slug>-release`) live on
 * disk. WI-6554700010009501.
 *
 * The gate derives each tree as a SIBLING of the hive's integration root:
 * `<dirname(integrationRoot)>/<slug>-checkpoint`. That is right for a top-level checkout
 * (`…/papercupai-workspace/oddsmith` → `…/papercupai-workspace/oddsmith-checkpoint`) and
 * wrong for a hive whose checkout is NESTED inside another git working tree. The
 * slack-asana-bug-drill hive lives at `papercusp/apps/slack-asana-bug-drill`, so its
 * checkpoint worktree landed at `papercusp/apps/slack-asana-bug-drill-checkpoint`, inside
 * the shared papercusp tree. Every live-tree scanner then read it as papercusp's own
 * files: `lint:tests` reported 10 ORPHANs (measured 2026-10-13), and `git status` shows it
 * as untracked.
 *
 * Rule: when the sibling's parent directory is inside a git working tree, hop above the
 * OUTERMOST enclosing work tree and name the tree after it as well:
 * `papercusp/apps/slack-asana-bug-drill` → `…/papercupai-workspace/
 * papercusp-slack-asana-bug-drill-checkpoint`. A top-level checkout keeps today's sibling
 * byte-for-byte.
 *
 * ⚠ The enclosing-tree oracle is git itself (`rev-parse --show-toplevel`), never a walk-up
 * for a `.git` entry. This box has a stub `~/.git` directory holding only `info/`, which git
 * rejects as "not a git repository". A `.git`-existence walk would treat `~` as an
 * enclosing repo and move papercusp's OWN checkpoint out of `~/papercupai-workspace`.
 */
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Returns the git work tree containing `dir`, or null when `dir` is not inside one. */
export type EnclosingWorkTreeProbe = (dir: string) => string | null | Promise<string | null>;

/** Default probe: git's own answer, so invalid or stub `.git` entries are ignored. */
export async function gitEnclosingWorkTree(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    const top = stdout.trim();
    return top ? path.resolve(top) : null;
  } catch {
    return null;
  }
}

/** Bound on nested work trees we will climb through; real layouts nest at most 2 deep. */
const MAX_ENCLOSING_HOPS = 16;

/**
 * The outermost git work tree that contains `dir`, or null when `dir` is in none. Climbs
 * because the enclosing tree can itself be a submodule or nested clone; stopping at the
 * innermost one would still place the sibling inside the outer tree.
 */
export async function outermostEnclosingWorkTree(
  dir: string,
  probe: EnclosingWorkTreeProbe = gitEnclosingWorkTree,
): Promise<string | null> {
  let outermost: string | null = null;
  let cursor = path.resolve(dir);
  for (let hop = 0; hop < MAX_ENCLOSING_HOPS; hop++) {
    const top = await probe(cursor);
    if (!top) break;
    const resolved = path.resolve(top);
    if (resolved === outermost) break;
    outermost = resolved;
    const parent = path.dirname(resolved);
    if (parent === resolved) break;
    cursor = parent;
  }
  return outermost;
}

export interface SiblingTreeRootInput {
  /** The hive's integration root (its checked-out working tree). */
  integrationRoot: string;
  /** The tree's own name, e.g. `<slug>-checkpoint` or `<slug>-release`. */
  name: string;
  probe?: EnclosingWorkTreeProbe;
}

export interface SiblingTreeRootResolution {
  root: string;
  /** Set when the plain sibling would have landed inside this work tree. */
  enclosingWorkTree: string | null;
}

/** Where the named tree lives, plus the enclosing work tree that forced a relocation. */
export async function describeSiblingTreeRoot(input: SiblingTreeRootInput): Promise<SiblingTreeRootResolution> {
  const parent = path.dirname(path.resolve(input.integrationRoot));
  const enclosingWorkTree = await outermostEnclosingWorkTree(parent, input.probe);
  if (!enclosingWorkTree) {
    return { root: path.join(parent, input.name), enclosingWorkTree: null };
  }
  return {
    root: path.join(
      path.dirname(enclosingWorkTree),
      `${path.basename(enclosingWorkTree)}-${input.name}`,
    ),
    enclosingWorkTree,
  };
}

/** The named sibling tree's path. See {@link describeSiblingTreeRoot}. */
export async function resolveSiblingTreeRoot(input: SiblingTreeRootInput): Promise<string> {
  return (await describeSiblingTreeRoot(input)).root;
}
