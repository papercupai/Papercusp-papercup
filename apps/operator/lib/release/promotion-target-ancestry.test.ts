// WI-6554700010019060: the green-checkpoint checks that origin/<releaseRef> is an ancestor
// of the candidate BEFORE the suite. Real git repos (a bare origin plus a working clone),
// because the behaviour under test is git's own ancestry and ls-remote output.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkPromotionTargetAncestry,
  type GitRunResult,
  type PromotionAncestryGit,
} from "./promotion-target-ancestry";

let root: string;
let origin: string;
let work: string;
let other: string;

function run(cwd: string, argv: string[]): GitRunResult {
  const r = spawnSync("git", argv, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: root,
    },
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function ok(cwd: string, argv: string[]): string {
  const r = run(cwd, argv);
  if (r.code !== 0) throw new Error(`git ${argv.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(cwd: string, file: string, body: string): string {
  writeFileSync(join(cwd, file), body);
  ok(cwd, ["add", file]);
  ok(cwd, ["commit", "-q", "-m", `${file}=${body}`]);
  return ok(cwd, ["rev-parse", "HEAD"]);
}

const gitIn = (cwd: string): PromotionAncestryGit => async (argv) => run(cwd, argv);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "promo-ancestry-"));
  origin = join(root, "origin.git");
  work = join(root, "work");
  other = join(root, "other");
  ok(root, ["init", "-q", "--bare", "-b", "main", origin]);
  ok(root, ["clone", "-q", origin, work]);
  ok(work, ["checkout", "-q", "-b", "main"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("checkPromotionTargetAncestry (WI-6554700010019060)", () => {
  it("passes when origin/main is an ancestor of the candidate (the normal fast-forward)", async () => {
    const promoted = commit(work, "a", "1");
    ok(work, ["push", "-q", "origin", "main"]);
    const candidate = commit(work, "b", "2");

    const r = await checkPromotionTargetAncestry({ ref: "main", candidate }, gitIn(work));

    expect(r).toMatchObject({ ok: true, status: "ancestor", remoteSha: promoted });
  });

  it("passes when origin/main IS the candidate", async () => {
    const candidate = commit(work, "a", "1");
    ok(work, ["push", "-q", "origin", "main"]);

    const r = await checkPromotionTargetAncestry({ ref: "refs/heads/main", candidate }, gitIn(work));

    expect(r).toMatchObject({ ok: true, status: "ancestor", remoteSha: candidate });
  });

  it("REFUSES when another clone pushed a commit the candidate lacks (the 2026-10-21 b1f1d0cd case)", async () => {
    commit(work, "a", "1");
    ok(work, ["push", "-q", "origin", "main"]);
    ok(root, ["clone", "-q", origin, other]);
    const foreign = commit(other, "drill", "x");
    ok(other, ["push", "-q", "origin", "main"]);
    // The integration clone has never fetched the foreign commit, exactly like the gate tree.
    const candidate = commit(work, "b", "2");

    const r = await checkPromotionTargetAncestry({ ref: "main", candidate }, gitIn(work));

    expect(r).toMatchObject({ ok: false, status: "diverged", remoteSha: foreign });
    expect(r.summary).toContain("REFUSED");
    expect(r.summary).toContain(foreign.slice(0, 12));
    expect(r.summary).toContain("NO verdict");
    // The real push would indeed be refused: the preflight predicted the push outcome.
    const push = run(work, ["push", "origin", `${candidate}:refs/heads/main`]);
    expect(push.code).not.toBe(0);
  });

  it("reports absent (and passes) when origin has no release ref yet", async () => {
    const candidate = commit(work, "a", "1");

    const r = await checkPromotionTargetAncestry({ ref: "main", candidate }, gitIn(work));

    expect(r).toMatchObject({ ok: true, status: "absent", remoteSha: null });
  });

  it("fails OPEN as unknown when origin cannot be reached, so a broken probe never wedges the gate", async () => {
    const candidate = commit(work, "a", "1");
    ok(work, ["remote", "set-url", "origin", join(root, "missing.git")]);

    const r = await checkPromotionTargetAncestry({ ref: "main", candidate }, gitIn(work));

    expect(r).toMatchObject({ ok: true, status: "unknown", remoteSha: null });
    expect(r.summary).toContain("judging anyway");
  });

  it("fails OPEN when the runner itself throws", async () => {
    const r = await checkPromotionTargetAncestry({ ref: "main", candidate: "f".repeat(40) }, async () => {
      throw new Error("spawn git ENOENT");
    });
    expect(r).toMatchObject({ ok: true, status: "unknown" });
  });
});
