#!/usr/bin/env node
// templates-mirror-sync — anti-rot guard for the PUBLIC content mirror
// (plan app-templates-2026-07-04 P-027; RECOVERED + re-wired by
// template-supply-chain-repair-2026-08-10 P-006 / WI-37775).
//
// PROVENANCE — read this before assuming the file is new. It was written
// 2026-07-05 and really did run (it is what vendored the seam package into the
// live mirror), but it was auto-committed in a SIDE CLONE that sat 141 commits
// ahead of its own origin and was never pushed — so it never entered the
// canonical repo, `git log --all` here could not see it, and templates/README.md
// went on advertising a drift guard that did not exist. It is restored here,
// canonically, with the hive->pot rename applied.
//
// Official template/rubric listings and the workspace-host bundle publish from the public mirror repo
// (Papercusp/templates) because the Cupboard worker rejects private repos;
// this monorepo's templates/ tree stays canonical. This script diffs the
// canonical tree against a local clone of the mirror and either reports
// drift (default: exit 1) or applies + commits the sync on a content-addressed
// branch and opens/reuses a PR to protected main (--push). Required checks stay
// in force; the script never pushes to or merges main.
//
// Sync map (mirror uses a FLAT layout — template dirs at repo root):
//   templates/<id>/**                      -> <mirror>/<id>/**
//   templates/README.md                    -> <mirror>/README.md
//   rubrics/<id>/**                        -> <mirror>/<id>/**
//   content-bundles/workspace-host/**      -> <mirror>/bundles/workspace-host/**
//   and for each VENDORED package (template-kit, pot-app-seam — WI-2891):
//   libs/generic/<pkg>/src/**              -> <mirror>/<pkg>/src/**   (minus *.test.ts)
//   libs/generic/<pkg>/package.json        -> <mirror>/<pkg>/package.json
//   libs/generic/<pkg>/tsconfig.json       -> <mirror>/<pkg>/tsconfig.json
// Mirror-OWNED (never synced, never flagged): root package.json /
// package-lock.json / vitest.config.ts etc. (the runnable-harness plumbing,
// including its file: deps), each vendored <pkg>/README.md, node_modules,
// .git.
//
// Usage:
//   npm run mirror:check                  # drift report, exit 1 on ANY drift
//   npm run mirror:push                   # apply + commit + open/reuse a PR
//   node scripts/templates-mirror-sync.mjs [--mirror <path>] [--push] [--message <msg>]
//   mirror path default: $PC_TEMPLATES_MIRROR or /tmp/pc-templates-mirror
//   exit codes: 0 in sync (or PR ready) · 1 drift (check mode) · 2 usage/git/GitHub error

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MIRROR_REMOTE = "github.com/Papercusp/templates";
const MIRROR_OWNER = "Papercusp";
const MIRROR_REPO = "templates";

/**
 * Parse a canonical GitHub HTTPS or SSH remote into its repository identity.
 *
 * Git accepts both `https://github.com/Owner/repo.git` and the scp-shaped
 * `git@github.com:Owner/repo.git` form. Comparing the parsed owner/repo keeps
 * the push guard fail-closed for every other host or repository without
 * rejecting equivalent transport forms.
 *
 * @param {string} remote
 * @returns {{ owner: string, repo: string } | null}
 */
export function parseGithubRemote(remote) {
  const owner = "([A-Za-z0-9][A-Za-z0-9_.-]{0,38})";
  const repo = "([A-Za-z0-9][A-Za-z0-9_.-]{0,99}?)";
  const https = new RegExp(`^https://github\\.com/${owner}/${repo}(?:\\.git)?/?$`);
  const ssh = new RegExp(`^(?:git@github\\.com:|ssh://git@github\\.com/)${owner}/${repo}(?:\\.git)?/?$`);
  const match = https.exec(remote.trim()) ?? ssh.exec(remote.trim());
  if (!match) return null;
  const [, parsedOwner, parsedRepo] = match;
  return parsedOwner && parsedRepo ? { owner: parsedOwner, repo: parsedRepo } : null;
}

/**
 * Compare the parsed GitHub identity, rather than the spelling of its remote.
 * GitHub repository names are case-insensitive, while the parser remains
 * deliberately strict about host and URL shape.
 *
 * @param {string} remote
 * @returns {boolean}
 */
export function isMirrorRemote(remote) {
  const parsed = parseGithubRemote(remote);
  return Boolean(
    parsed &&
      parsed.owner.toLowerCase() === MIRROR_OWNER.toLowerCase() &&
      parsed.repo.toLowerCase() === MIRROR_REPO.toLowerCase(),
  );
}

/** Refuse bundle publication until its blueprint manifests exist in the public source repos. */
export async function validatePublishedBundleBlueprints(bundleFile, runGh) {
  const bundle = parseYaml(await fs.readFile(bundleFile, "utf8"));
  const units = [...(bundle.blueprint ? [bundle.blueprint] : []), ...(bundle.blueprints ?? [])];
  const repositories = new Map();
  for (const unit of units) {
    const repository = parseGithubRemote(unit.githubUrl ?? "");
    const ref = unit.listingRef ?? "";
    if (!repository || !/^[A-Za-z0-9._/-]*$/.test(ref) || ref.split("/").some(segment => segment === "." || segment === "..")) {
      throw new Error(`unsafe bundle blueprint source: ${unit.id}`);
    }
    const repo = `${repository.owner}/${repository.repo}`;
    let paths = repositories.get(repo.toLowerCase());
    if (!paths) {
      const tree = JSON.parse(runGh("api", `repos/${repo}/git/trees/HEAD?recursive=1`));
      if (tree.truncated !== false || !Array.isArray(tree.tree)) {
        throw new Error(`cannot verify complete public blueprint tree: ${repo}`);
      }
      paths = new Set(tree.tree.filter(entry => entry.type === "blob").map(entry => entry.path));
      repositories.set(repo.toLowerCase(), paths);
    }
    const manifest = ref ? `${ref}/blueprint.yaml` : "blueprint.yaml";
    if (!paths.has(manifest)) {
      throw new Error(`workspace-host bundle references unpublished blueprint "${unit.id}": ${repo}/${manifest}; publish the blueprint mirror before the bundle`);
    }
  }
  return { blueprints: units.length, repositories: repositories.size };
}

// Source-shippable packages vendored into the mirror (zero runtime deps,
// `main: ./src/index.ts`) so builders outside papercup can file:-link them.
// NOTE: `hive-app-seam` was renamed to `pot-app-seam`; the live mirror still
// carries the OLD dir, which is precisely the drift this guard now reports.
export const VENDORED = ["template-kit", "pot-app-seam"];

const exists = (p) =>
  fs.stat(p).then(
    () => true,
    () => false,
  );

/**
 * Recursively list files under dir as dir-relative paths (posix slashes).
 *
 * @param {string} dir
 * @param {{ exclude?: (rel: string) => boolean }} [opts]
 * @returns {Promise<string[]>}
 */
export async function walk(dir, { exclude = () => false } = {}) {
  const out = [];
  const entries = await fs.readdir(dir, {
    recursive: true,
    withFileTypes: true,
  });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const abs = join(e.parentPath, e.name);
    const rel = relative(dir, abs).split(sep).join("/");
    if (rel.split("/").includes("node_modules") || rel.startsWith(".git/"))
      continue;
    if (exclude(rel)) continue;
    out.push(rel);
  }
  return out.sort();
}

/**
 * Build the expected manifest: mirror-relative path -> canonical source abs path.
 * Exported so a test can drive it against a synthetic tree without touching the
 * shared checkout.
 *
 * Throws (with `exitCode: 2`) when a vendored package's source is missing —
 * an empty canonical source would otherwise flag every vendored mirror file
 * extraneous, and `--push` would delete them.
 *
 * @param {string} [root]
 * @param {string[]} [vendored]
 * @returns {Promise<{ expected: Map<string, string>, templateIds: string[], rubricIds: string[] }>}
 */
export async function buildExpected(root = ROOT, vendored = VENDORED) {
  const expected = new Map();

  const templatesDir = join(root, "templates");
  const templateIds = (await fs.readdir(templatesDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name !== "node_modules")
    .map((e) => e.name)
    .sort();
  for (const id of templateIds) {
    for (const rel of await walk(join(templatesDir, id))) {
      expected.set(`${id}/${rel}`, join(templatesDir, id, rel));
    }
  }
  expected.set("README.md", join(templatesDir, "README.md"));

  // Rubrics share this EXISTING public content mirror rather than introducing a
  // second distribution repository. Their ids do not overlap template refs, so
  // both self-describing kinds can remain at the mirror root — the single-segment
  // listing_ref shape their standard Cupboard installers require.
  const rubricsDir = join(root, "rubrics");
  const rubricIds = (await fs.readdir(rubricsDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name !== "node_modules")
    .map((e) => e.name)
    .sort();
  for (const id of rubricIds) {
    if (templateIds.includes(id)) {
      const err = new Error(`template/rubric mirror ref collision: ${id}`);
      err.exitCode = 2;
      throw err;
    }
    for (const rel of await walk(join(rubricsDir, id))) {
      expected.set(`${id}/${rel}`, join(rubricsDir, id, rel));
    }
  }

  const workspaceHostBundle = join(
    root,
    "content-bundles",
    "workspace-host",
    "bundle.yaml",
  );
  if (!(await exists(workspaceHostBundle))) {
    const err = new Error(
      `workspace-host content bundle missing: ${workspaceHostBundle}`,
    );
    err.exitCode = 2;
    throw err;
  }
  expected.set("bundles/workspace-host/bundle.yaml", workspaceHostBundle);

  for (const pkg of vendored) {
    const pkgDir = join(root, "libs/generic", pkg);
    if (!(await exists(join(pkgDir, "package.json")))) {
      // An uninitialized submodule reads as an EMPTY canonical source, which
      // would flag every vendored mirror file extraneous (and --push would
      // delete them) — refuse instead.
      const err = new Error(`vendored package source missing: ${pkgDir}`);
      err.hint = `submodule not initialized? git submodule update --init libs/generic/${pkg}`;
      err.exitCode = 2;
      throw err;
    }
    for (const rel of await walk(join(pkgDir, "src"), {
      exclude: (r) => r.endsWith(".test.ts"),
    })) {
      expected.set(`${pkg}/src/${rel}`, join(pkgDir, "src", rel));
    }
    // Only expect a top-level file the canonical package ACTUALLY has. tsconfig.json
    // used to be added unconditionally, which was wrong in both directions for
    // pot-app-seam (which ships none): `mirror:check` reported a permanent
    // `missing pot-app-seam/tsconfig.json` that no push could ever satisfy, and
    // `--push` then threw ENOENT out of fs.copyFile mid-apply — breaking the one
    // command the templates README documents for repairing the mirror.
    for (const meta of ["package.json", "tsconfig.json"]) {
      if (await exists(join(pkgDir, meta)))
        expected.set(`${pkg}/${meta}`, join(pkgDir, meta));
    }
  }

  return { expected, templateIds, rubricIds };
}

/**
 * Enumerate the mirror's ACTUAL state over the SYNCED surface only.
 *
 * @param {string} mirror
 * @param {string[]} [vendored]
 * @returns {Promise<Set<string>>}
 */
export async function buildActual(mirror, vendored = VENDORED) {
  const actual = new Set();
  const mirrorRootEntries = await fs.readdir(mirror, { withFileTypes: true });
  const ownedTopDirs = new Set(["node_modules", ".git", ".github"]);
  for (const e of mirrorRootEntries) {
    if (
      e.isDirectory() &&
      !ownedTopDirs.has(e.name) &&
      !vendored.includes(e.name)
    ) {
      for (const rel of await walk(join(mirror, e.name)))
        actual.add(`${e.name}/${rel}`);
    }
  }
  if (await exists(join(mirror, "README.md"))) actual.add("README.md");
  for (const pkg of vendored) {
    if (await exists(join(mirror, pkg))) {
      for (const rel of await walk(join(mirror, pkg), {
        exclude: (r) => r === "README.md",
      })) {
        actual.add(`${pkg}/${rel}`);
      }
    }
  }
  return actual;
}

/**
 * Diff expected vs actual. Byte-compares every file present on both sides.
 *
 * @param {Map<string, string>} expected
 * @param {Set<string>} actual
 * @param {string} mirror
 * @returns {Promise<{ missing: string[], changed: string[], extraneous: string[] }>}
 */
export async function computeDrift(expected, actual, mirror) {
  const drift = { missing: [], changed: [], extraneous: [] };
  for (const [rel, src] of expected) {
    if (!actual.has(rel)) {
      drift.missing.push(rel);
      continue;
    }
    const [a, b] = await Promise.all([
      fs.readFile(src),
      fs.readFile(join(mirror, rel)),
    ]);
    if (!a.equals(b)) drift.changed.push(rel);
  }
  for (const rel of actual) if (!expected.has(rel)) drift.extraneous.push(rel);
  return drift;
}

/**
 * @param {{ missing: string[], changed: string[], extraneous: string[] }} drift
 * @returns {number}
 */
export const driftTotal = (drift) =>
  drift.missing.length + drift.changed.length + drift.extraneous.length;

async function contentAddressedSyncBranch(expected) {
  const hash = createHash("sha256");
  for (const [rel, source] of [...expected].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(rel);
    hash.update("\0");
    hash.update(await fs.readFile(source));
    hash.update("\0");
  }
  return "templates-sync-" + hash.digest("hex").slice(0, 12);
}

async function findMirrorPullRequest(runGh, branch) {
  const output = runGh(
    "pr",
    "list",
    "--repo",
    "Papercusp/templates",
    "--state",
    "all",
    "--head",
    "Papercusp:" + branch,
    "--json",
    "number,url,state",
  );
  const prs = JSON.parse(output || "[]");
  return Array.isArray(prs) ? (prs[0] ?? null) : null;
}

async function ensureMirrorPullRequest(runGh, branch, message) {
  const existing = await findMirrorPullRequest(runGh, branch);
  if (existing?.state === "OPEN" && typeof existing.url === "string")
    return existing.url;
  if (existing?.state === "CLOSED" && existing.number != null) {
    runGh(
      "pr",
      "reopen",
      String(existing.number),
      "--repo",
      "Papercusp/templates",
    );
    return existing.url;
  }
  if (existing?.state === "MERGED") {
    throw new Error(
      "the content-addressed sync branch already has a merged PR; refresh the mirror clone and retry",
    );
  }

  const body =
    "This pull request syncs the canonical Papercusp template tree into the public mirror.\n\n" +
    "The protected main branch is updated only by merging this pull request after its required " +
    "cupboard-verify check succeeds. The sync tool does not push to or merge main.";
  const output = runGh(
    "pr",
    "create",
    "--repo",
    "Papercusp/templates",
    "--base",
    "main",
    "--head",
    branch,
    "--title",
    message,
    "--body",
    body,
  );
  const url = output.match(/https:\/\/github\.com\/Papercusp\/templates\/pull\/\d+/)?.[0];
  if (!url) throw new Error("gh pr create did not return a pull request URL");
  return url;
}

async function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : (args.splice(i, 1), true);
  };
  const opt = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return undefined;
    const [, v] = args.splice(i, 2);
    return v;
  };
  const push = flag("--push") ?? false;
  const mirror =
    opt("--mirror") ??
    process.env.PC_TEMPLATES_MIRROR ??
    "/tmp/pc-templates-mirror";
  const message =
    opt("--message") ??
    "sync templates mirror from monorepo (templates-mirror-sync)";
  if (args.length) {
    console.error("unknown args:", args.join(" "));
    return 2;
  }

  if (!(await exists(join(mirror, ".git")))) {
    console.error(`mirror clone not found at ${mirror}`);
    console.error(
      `  git clone https://github.com/Papercusp/templates.git ${mirror}`,
    );
    console.error(
      `  then re-run with --mirror ${mirror} (or set PC_TEMPLATES_MIRROR)`,
    );
    return 2;
  }

  let expected;
  let templateIds;
  let rubricIds;
  try {
    ({ expected, templateIds, rubricIds } = await buildExpected(
      ROOT,
      VENDORED,
    ));
  } catch (err) {
    console.error(err.message);
    if (err.hint) console.error(`  ${err.hint}`);
    return err.exitCode ?? 2;
  }

  let actual;
  let drift;
  let syncBranch = null;
  let syncBranchExists = false;
  let restoreMain = false;
  let safeToDiscardScriptChanges = false;
  const runGit = (...gitArgs) => {
    const result = spawnSync("git", ["-C", mirror, ...gitArgs], {
      encoding: "utf8",
    });
    if (result.error)
      throw new Error("git " + gitArgs.join(" ") + " failed: " + result.error.message);
    if (result.status !== 0)
      throw new Error(
        "git " +
          gitArgs.join(" ") +
          " failed:\n" +
          (result.stderr || result.stdout || "unknown git error"),
      );
    return (result.stdout ?? "").trim();
  };
  const runGh = (...ghArgs) => {
    const result = spawnSync("gh", ghArgs, { encoding: "utf8" });
    if (result.error)
      throw new Error("gh " + ghArgs.join(" ") + " failed: " + result.error.message);
    if (result.status !== 0)
      throw new Error(
        "gh " +
          ghArgs.join(" ") +
          " failed:\n" +
          (result.stderr || result.stdout || "unknown gh error"),
      );
    return (result.stdout ?? "").trim();
  };
  const restoreMainCheckout = ({ discardScriptChanges = false } = {}) => {
    if (!restoreMain) return true;
    if (discardScriptChanges) {
      if (!safeToDiscardScriptChanges) {
        console.error(
          "[templates-mirror-sync] refusing cleanup because the mirror was not confirmed clean before sync",
        );
        return false;
      }
      const reset = spawnSync(
        "git",
        ["-C", mirror, "reset", "--hard", "origin/main"],
        { encoding: "utf8" },
      );
      if (reset.error || reset.status !== 0) {
        console.error(
          "[templates-mirror-sync] could not discard the sync's local changes: " +
            (reset.error?.message || reset.stderr || reset.stdout || "unknown git error"),
        );
        return false;
      }
      const clean = spawnSync("git", ["-C", mirror, "clean", "-fd"], {
        encoding: "utf8",
      });
      if (clean.error || clean.status !== 0) {
        console.error(
          "[templates-mirror-sync] could not remove the sync's untracked files: " +
            (clean.error?.message || clean.stderr || clean.stdout || "unknown git error"),
        );
        return false;
      }
    }
    const restored = spawnSync(
      "git",
      ["-C", mirror, "switch", "--detach", "origin/main"],
      { encoding: "utf8" },
    );
    if (restored.error || restored.status !== 0) {
      console.error(
        "[templates-mirror-sync] could not restore mirror clone to origin/main: " +
          (restored.error?.message || restored.stderr || restored.stdout || "unknown git error"),
      );
      return false;
    }
    return true;
  };

  if (push) {
    try {
      const status = runGit("status", "--porcelain");
      if (status)
        throw new Error(
          "mirror clone has local changes; commit or discard them before running mirror:push",
        );
      safeToDiscardScriptChanges = true;
      const origin = runGit("remote", "get-url", "origin");
      if (!isMirrorRemote(origin))
        throw new Error(
          "refusing to sync: origin '" + origin + "' is not " + MIRROR_REMOTE,
        );
      // The bundle is published by this repo, but its blueprints live in another mirror. Local
      // source coverage cannot prove those dependencies were published first (EI-25968237672096071).
      await validatePublishedBundleBlueprints(
        expected.get("bundles/workspace-host/bundle.yaml"),
        runGh,
      );
      runGit(
        "fetch",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
      );
      runGit("switch", "--detach", "origin/main");
      restoreMain = true;
      actual = await buildActual(mirror, VENDORED);
      drift = await computeDrift(expected, actual, mirror);

      if (driftTotal(drift) > 0) {
        runGh("auth", "status", "--hostname", "github.com");
        syncBranch = await contentAddressedSyncBranch(expected);
        const previousPr = await findMirrorPullRequest(runGh, syncBranch);
        if (previousPr?.state === "MERGED") {
          syncBranch += "-" + runGit("rev-parse", "--short", "origin/main");
        }

        const remoteBranch = spawnSync(
          "git",
          [
            "-C",
            mirror,
            "ls-remote",
            "--exit-code",
            "--heads",
            "origin",
            "refs/heads/" + syncBranch,
          ],
          { encoding: "utf8" },
        );
        if (remoteBranch.error)
          throw new Error("git ls-remote failed: " + remoteBranch.error.message);
        if (remoteBranch.status === 0) {
          syncBranchExists = true;
          runGit(
            "fetch",
            "origin",
            "+refs/heads/" +
              syncBranch +
              ":refs/remotes/origin/" +
              syncBranch,
          );
          runGit("switch", "--detach", "origin/" + syncBranch);
          actual = await buildActual(mirror, VENDORED);
          drift = await computeDrift(expected, actual, mirror);

          const branchFiles = runGit(
            "diff",
            "--name-only",
            "origin/main...origin/" + syncBranch,
          )
            .split("\n")
            .filter(Boolean);
          const allowedFiles = new Set([...expected.keys(), ...actual]);
          const unrelated = branchFiles.filter((path) => !allowedFiles.has(path));
          if (unrelated.length > 0)
            throw new Error(
              "sync branch contains files outside the mirror surface: " +
                unrelated.join(", "),
            );
        } else if (remoteBranch.status !== 2) {
          throw new Error(
            "git ls-remote failed:\n" +
              (remoteBranch.stderr || remoteBranch.stdout || "unknown git error"),
          );
        }
      }
    } catch (err) {
      console.error(
        "[templates-mirror-sync] protected-main preflight failed: " +
          (err instanceof Error ? err.message : String(err)),
      );
      restoreMainCheckout();
      return 2;
    }
  } else {
    actual = await buildActual(mirror, VENDORED);
    drift = await computeDrift(expected, actual, mirror);
  }

  for (const kind of ["missing", "changed", "extraneous"]) {
    for (const rel of drift[kind].sort())
      console.log(`${kind.padEnd(10)} ${rel}`);
  }
  console.log(
    `[templates-mirror-sync] ${templateIds.length} template dirs + ${rubricIds.length} rubric dirs + workspace-host bundle + ${VENDORED.length} vendored packages + README · ` +
      `${expected.size} files expected · drift: ${drift.missing.length} missing, ` +
      `${drift.changed.length} changed, ${drift.extraneous.length} extraneous`,
  );

  if (driftTotal(drift) === 0) {
    if (push && syncBranchExists && syncBranch) {
      try {
        const prUrl = await ensureMirrorPullRequest(runGh, syncBranch, message);
        console.log(
          "[templates-mirror-sync] sync branch already contains the canonical tree; PR " +
            prUrl +
            " is ready for cupboard-verify",
        );
      } catch (err) {
        console.error(
          "[templates-mirror-sync] could not open or reuse the mirror PR: " +
            (err instanceof Error ? err.message : String(err)),
        );
        restoreMainCheckout();
        return 2;
      }
    }
    if (push && !restoreMainCheckout()) {
      return 2;
    }
    console.log(
      push && syncBranchExists
        ? "[templates-mirror-sync] sync branch matches the canonical tree; protected main changes after PR merge"
        : "[templates-mirror-sync] mirror is IN SYNC with the canonical tree",
    );
    return 0;
  }

  if (!push) {
    console.error(
      "[templates-mirror-sync] DRIFT — the published mirror trails the canonical tree.",
    );
    console.error("  apply + open a protected-main PR with: npm run mirror:push");
    return 1;
  }

  // ---- --push: apply, commit, push
  let failed = false;
  const git = (...a) => {
    const r = spawnSync("git", ["-C", mirror, ...a], { encoding: "utf8" });
    if (r.error || r.status !== 0) {
      console.error(
        `git ${a.join(" ")} failed:\n${r.error?.message || r.stderr || r.stdout || "unknown git error"}`,
      );
      failed = true;
      return "";
    }
    return r.stdout.trim();
  };

  const origin = git("remote", "get-url", "origin");
  if (failed) {
    restoreMainCheckout();
    return 2;
  }
  if (!isMirrorRemote(origin)) {
    console.error(
      `refusing to push: origin '${origin}' is not ${MIRROR_REMOTE}`,
    );
    restoreMainCheckout();
    return 2;
  }

  for (const rel of [...drift.missing, ...drift.changed]) {
    const dst = join(mirror, rel);
    try {
      await fs.mkdir(dirname(dst), { recursive: true });
      await fs.copyFile(expected.get(rel), dst);
    } catch (err) {
      console.error(
        "[templates-mirror-sync] could not apply " +
          rel +
          ": " +
          (err instanceof Error ? err.message : String(err)),
      );
      restoreMainCheckout({ discardScriptChanges: true });
      return 2;
    }
  }
  for (const rel of drift.extraneous) {
    try {
      await fs.rm(join(mirror, rel));
    } catch (err) {
      console.error(
        "[templates-mirror-sync] could not remove extraneous file " +
          rel +
          ": " +
          (err instanceof Error ? err.message : String(err)),
      );
      restoreMainCheckout({ discardScriptChanges: true });
      return 2;
    }
  }

  if (git("status", "--porcelain") === "") {
    if (failed) {
      restoreMainCheckout({ discardScriptChanges: true });
      return 2;
    }
    console.error(
      "[templates-mirror-sync] expected drift produced no commit; check mirror ignore rules",
    );
    restoreMainCheckout({ discardScriptChanges: true });
    return 2;
  }
  git("add", "-A");
  if (failed) {
    restoreMainCheckout({ discardScriptChanges: true });
    return 2;
  }
  git("commit", "-m", message);
  if (failed) {
    restoreMainCheckout({ discardScriptChanges: true });
    return 2;
  }
  if (!syncBranch) {
    console.error("[templates-mirror-sync] protected sync branch was not prepared");
    restoreMainCheckout({ discardScriptChanges: true });
    return 2;
  }
  git("push", "origin", "HEAD:refs/heads/" + syncBranch);
  if (failed) {
    restoreMainCheckout({ discardScriptChanges: true });
    return 2;
  }
  let prUrl;
  try {
    prUrl = await ensureMirrorPullRequest(runGh, syncBranch, message);
  } catch (err) {
    console.error(
      "[templates-mirror-sync] branch was pushed but the mirror PR could not be opened: " +
        (err instanceof Error ? err.message : String(err)),
    );
    restoreMainCheckout();
    return 2;
  }
  const shortSha = git("rev-parse", "--short", "HEAD");
  if (failed) {
    restoreMainCheckout();
    return 2;
  }
  console.log(
    `[templates-mirror-sync] pushed ${shortSha} to ${origin}`,
  );
  if (!restoreMainCheckout()) return 2;
  console.log(
    "[templates-mirror-sync] PR " +
      prUrl +
      " is ready for cupboard-verify; merge it after the required check passes",
  );
  return 0;
}

// Run only when executed directly, so the helpers above stay importable.
const invoked = process.argv[1]
  ? await fs.realpath(process.argv[1]).catch(() => process.argv[1])
  : "";
if (invoked === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv));
}
