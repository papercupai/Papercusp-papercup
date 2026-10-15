import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdmissionOutcome, AdmitPathsInput } from "@papercusp/operator-core/lib/release/repair-head-admission";
import {
  GEN_CHECK_SELF_HEAL_ACTOR,
  applyGenCheckHeal,
  describeGenCheckHeal,
  genCheckEntriesOf,
  healGenCheckLegs,
  makeRealGenCheckHealIo,
  pairedGenWriter,
  parsePorcelainZ,
  publishGenHealGitlinks,
  signatureWithoutHealed,
  type GenCheckHealIo,
} from "./green-checkpoint-gen-check-self-heal";

const CAND = "a".repeat(40);
const HEAD = "b".repeat(40);
const NEXT = "c".repeat(40);
const SRC = "d".repeat(40);

interface FakeOpts {
  /** exit codes per script; a script absent here exits 0 */
  exits?: Record<string, number>;
  /** dirty set before the writer, and the set the writer leaves behind */
  dirtyBefore?: string[];
  dirtyAfter?: string[];
  throwOn?: string;
  admit?: (input: AdmitPathsInput) => AdmissionOutcome;
}

function fakeIo(opts: FakeOpts = {}) {
  const scripts: string[] = [];
  const admits: AdmitPathsInput[] = [];
  const built: { repairHead: string; paths: readonly string[] }[] = [];
  const log: string[] = [];
  let writerRan = false;
  const io: GenCheckHealIo = {
    async runScript(script) {
      scripts.push(script);
      if (opts.throwOn === script) throw new Error(`boom ${script}`);
      if (!script.endsWith(":check")) writerRan = true;
      return { code: opts.exits?.[script] ?? 0, tail: `tail ${script}` };
    },
    async dirtyPaths() {
      return writerRan ? (opts.dirtyAfter ?? []) : (opts.dirtyBefore ?? []);
    },
    async buildSourceCommit(repairHead, paths) {
      built.push({ repairHead, paths });
      return SRC;
    },
    admit(input) {
      admits.push(input);
      if (opts.admit) return opts.admit(input);
      return {
        ok: true,
        commit: NEXT,
        tree: "e".repeat(40),
        entry: {
          commit: NEXT,
          parent: input.repairHead,
          paths: [...input.paths],
          actor: input.actor,
          atMs: input.nowMs,
          source: { ref: input.source.ref, sha: SRC },
          reason: input.reason,
        },
      } as unknown as AdmissionOutcome;
    },
    log: (line) => log.push(line),
    now: () => 1_700_000_000_000,
  };
  return { io, scripts, admits, built, log, resetWriter: () => { writerRan = false; } };
}

const queue = { candidate: CAND, repairHead: HEAD };
const genRed = [{ id: "@papercusp/operator-core :: gen:tool-catalog:check" }];

describe("pairedGenWriter / genCheckEntriesOf", () => {
  it("pairs gen:<x>:check with gen:<x> and nothing else", () => {
    expect(pairedGenWriter("gen:tool-catalog:check")).toBe("gen:tool-catalog");
    expect(pairedGenWriter("gen:client-docs:check")).toBe("gen:client-docs");
    expect(pairedGenWriter("gen:tool-catalog")).toBeNull();
    expect(pairedGenWriter("lint:prompt-projections")).toBeNull();
    expect(pairedGenWriter("lint:tsc")).toBeNull();
  });
  it("selects only gen:*:check entries from a mixed signature, workspace-task or bare, deduped", () => {
    const entries = genCheckEntriesOf([
      { id: "@papercusp/operator-core :: gen:tool-catalog:check" },
      { id: "@papercusp/operator-core :: gen:tool-catalog:check" },
      { id: "gen:client-docs:check" },
      { id: "lint:prompt-projections" },
      { id: "apps/operator/lib/x.test.ts" },
      { id: "@papercusp/operator-core" },
    ]);
    expect(entries).toEqual([
      { id: "@papercusp/operator-core :: gen:tool-catalog:check", check: "gen:tool-catalog:check", writer: "gen:tool-catalog" },
      { id: "gen:client-docs:check", check: "gen:client-docs:check", writer: "gen:client-docs" },
    ]);
  });
});

describe("healGenCheckLegs", () => {
  it("returns nothing-to-heal when the signature has no gen:*:check entry (runs nothing)", async () => {
    const f = fakeIo();
    const out = await healGenCheckLegs(f.io, { root: "/r", queue, signature: [{ id: "lint:tsc" }] });
    expect(out).toEqual({ kind: "nothing-to-heal" });
    expect(f.scripts).toEqual([]);
    expect(f.admits).toEqual([]);
  });

  it("heals: writer → recheck passes → admits ONLY the writer delta from a commit built on repairHead, actor=gate", async () => {
    const f = fakeIo({
      dirtyBefore: ["apps/operator/.vitest-tmp/debris.txt"],
      dirtyAfter: ["apps/operator/.vitest-tmp/debris.txt", ".papercusp/tool-catalog.json"],
    });
    const out = await healGenCheckLegs(f.io, { root: "/r", queue, signature: genRed });
    expect(out.kind).toBe("healed");
    if (out.kind !== "healed") return;
    expect(f.scripts).toEqual(["gen:tool-catalog", "gen:tool-catalog:check"]);
    // D-001: only the proved writer delta — pre-existing debris in the verification tree never rides in.
    expect(out.paths).toEqual([".papercusp/tool-catalog.json"]);
    expect(f.built).toEqual([{ repairHead: HEAD, paths: [".papercusp/tool-catalog.json"] }]);
    expect(f.admits).toHaveLength(1);
    const admit = f.admits[0]!;
    expect(admit).toMatchObject({
      root: "/r",
      candidate: CAND,
      repairHead: HEAD,
      paths: [".papercusp/tool-catalog.json"],
      source: { ref: SRC },
      actor: GEN_CHECK_SELF_HEAL_ACTOR,
      nowMs: 1_700_000_000_000,
    });
    expect(admit.reason).toContain("P-005 gen:*:check self-heal");
    expect(out.toRepairHead).toBe(NEXT);
    expect(out.healedIds).toEqual(["@papercusp/operator-core :: gen:tool-catalog:check"]);
    expect(describeGenCheckHeal(out)).toContain("HEALED");
  });

  it("runs each distinct writer once and every check when several gen legs are red", async () => {
    const f = fakeIo({ dirtyAfter: ["a.json", "b.md"] });
    const out = await healGenCheckLegs(f.io, {
      root: "/r",
      queue,
      signature: [
        { id: "@papercusp/operator-core :: gen:tool-catalog:check" },
        { id: "@papercusp/operator-core :: gen:client-docs:check" },
      ],
    });
    expect(out.kind).toBe("healed");
    expect(f.scripts).toEqual(["gen:tool-catalog", "gen:client-docs", "gen:tool-catalog:check", "gen:client-docs:check"]);
    expect(f.admits[0]!.paths).toEqual(["a.json", "b.md"]);
  });

  it("regeneration-failed (R-5's only real failure) when the writer exits non-zero — no recheck, no admission", async () => {
    const f = fakeIo({ exits: { "gen:tool-catalog": 2 }, dirtyAfter: ["x"] });
    const out = await healGenCheckLegs(f.io, { root: "/r", queue, signature: genRed });
    expect(out).toMatchObject({ kind: "regeneration-failed", writer: "gen:tool-catalog", detail: expect.stringContaining("exit 2") });
    expect(f.scripts).toEqual(["gen:tool-catalog"]);
    expect(f.admits).toEqual([]);
    expect(describeGenCheckHeal(out)).toContain("GEN_CHECK_REGENERATION_FAILED");
  });

  it("regeneration-failed when the writer throws", async () => {
    const f = fakeIo({ throwOn: "gen:tool-catalog" });
    const out = await healGenCheckLegs(f.io, { root: "/r", queue, signature: genRed });
    expect(out).toMatchObject({ kind: "regeneration-failed", detail: "boom gen:tool-catalog" });
    expect(f.admits).toEqual([]);
  });

  it("no-delta when the writer changes nothing — not artifact drift, nothing admitted", async () => {
    const f = fakeIo({ dirtyBefore: ["debris"], dirtyAfter: ["debris"] });
    const out = await healGenCheckLegs(f.io, { root: "/r", queue, signature: genRed });
    expect(out).toEqual({ kind: "no-delta", ids: ["@papercusp/operator-core :: gen:tool-catalog:check"] });
    expect(f.scripts).toEqual(["gen:tool-catalog"]);
    expect(f.admits).toEqual([]);
  });

  it("recheck-failed: regenerated but the check still fails → NOTHING is admitted", async () => {
    const f = fakeIo({ exits: { "gen:tool-catalog:check": 1 }, dirtyAfter: [".papercusp/tool-catalog.json"] });
    const out = await healGenCheckLegs(f.io, { root: "/r", queue, signature: genRed });
    expect(out).toMatchObject({ kind: "recheck-failed", check: "gen:tool-catalog:check", paths: [".papercusp/tool-catalog.json"] });
    expect(f.built).toEqual([]);
    expect(f.admits).toEqual([]);
    expect(describeGenCheckHeal(out)).toContain("NOT admitted");
  });

  it("admission-refused surfaces the door's typed refusal", async () => {
    const f = fakeIo({
      dirtyAfter: ["x.json"],
      admit: () => ({ ok: false, code: "lineage-ref-moved", detail: "moved", paths: ["x.json"] }) as AdmissionOutcome,
    });
    const out = await healGenCheckLegs(f.io, { root: "/r", queue, signature: genRed });
    expect(out).toMatchObject({ kind: "admission-refused", refusal: { code: "lineage-ref-moved" }, paths: ["x.json"] });
  });

  it("regenerates on the current head when a concurrent admission moves the lineage", async () => {
    const newerHead = "f".repeat(40);
    const f = fakeIo({
      dirtyAfter: [".papercusp/tool-catalog.json"],
      admit: (input) => input.repairHead === HEAD
        ? { ok: false, code: "lineage-ref-moved", detail: "a fixer admitted" } as AdmissionOutcome
        : {
            ok: true, commit: NEXT, tree: "e".repeat(40),
            entry: {
              fromRepairHead: newerHead, toRepairHead: NEXT,
              paths: [".papercusp/tool-catalog.json"],
              atMs: 1_700_000_000_000,
            },
          } as AdmissionOutcome,
    });
    const freshQueue = { ...queue, repairHead: newerHead, updatedAtMs: 2 } as never;
    f.io.refreshAfterRefMove = async () => {
      f.resetWriter(); // rematerializing the new head discards the old writer delta
      return freshQueue;
    };
    const out = await healGenCheckLegs(f.io, { root: "/r", queue, signature: genRed });
    expect(out).toMatchObject({
      kind: "healed", fromRepairHead: newerHead, refreshedQueue: freshQueue,
    });
    expect(f.built.map((b) => b.repairHead)).toEqual([HEAD, newerHead]);
    expect(f.scripts).toEqual([
      "gen:tool-catalog", "gen:tool-catalog:check",
      "gen:tool-catalog", "gen:tool-catalog:check",
    ]);
    expect(f.admits.map((a) => a.repairHead)).toEqual([HEAD, newerHead]);
    if (out.kind === "healed") {
      const applied = applyGenCheckHeal(out.refreshedQueue!, out);
      expect(applied.repairHead).toBe(NEXT);
      expect(applied.admissions?.at(-1)?.fromRepairHead).toBe(newerHead);
    }
  });

  it("probe-failed when the source commit cannot be built", async () => {
    const f = fakeIo({ dirtyAfter: ["x.json"] });
    f.io.buildSourceCommit = async () => {
      throw new Error("commit-tree exploded");
    };
    const out = await healGenCheckLegs(f.io, { root: "/r", queue, signature: genRed });
    expect(out).toMatchObject({ kind: "probe-failed", detail: expect.stringContaining("commit-tree exploded") });
    expect(f.admits).toEqual([]);
  });
});

describe("signatureWithoutHealed / parsePorcelainZ", () => {
  it("drops exactly the healed ids and keeps the rest of the red", () => {
    const sig = [
      { id: "@papercusp/operator-core :: gen:tool-catalog:check", kind: "workspace-task" },
      { id: "lint:prompt-projections", kind: "lint-leg" },
    ];
    const rest = signatureWithoutHealed(sig, {
      kind: "healed",
      healedIds: ["@papercusp/operator-core :: gen:tool-catalog:check"],
      entry: {} as never,
      fromRepairHead: HEAD,
      toRepairHead: NEXT,
      paths: [],
      reason: "",
    });
    expect(rest).toEqual([{ id: "lint:prompt-projections", kind: "lint-leg" }]);
  });
  it("parses NUL-separated porcelain including untracked and rename records", () => {
    const out = ["M  a/b.ts", "?? c.json", "R  new.md", "old.md", " M d.ts", ""].join("\0");
    expect(parsePorcelainZ(out)).toEqual(["a/b.ts", "c.json", "new.md", "d.ts"]);
  });
});

describe("makeRealGenCheckHealIo.buildSourceCommit (real git)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t.invalid",
      },
    }).trim();

  /** An integration superproject pinning libs/sub, and a verification tree materialized at its head. */
  function fixture() {
    const base = mkdtempSync(join(tmpdir(), "gen-heal-gitlink-"));
    roots.push(base);
    const integ = join(base, "integ");
    const integSub = join(integ, "libs", "sub");
    mkdirSync(integSub, { recursive: true });
    git(integSub, ["init", "-q"]);
    writeFileSync(join(integSub, "gen.txt"), "stale\n");
    writeFileSync(join(integSub, "keep.txt"), "keep\n");
    git(integSub, ["add", "."]);
    git(integSub, ["commit", "-qm", "pin"]);
    const pin = git(integSub, ["rev-parse", "HEAD"]);
    git(integ, ["init", "-q"]);
    writeFileSync(join(integ, "top.txt"), "top\n");
    git(integ, ["add", "top.txt"]);
    git(integ, ["update-index", "--add", "--cacheinfo", `160000,${pin},libs/sub`]);
    git(integ, ["commit", "-qm", "head"]);
    const head = git(integ, ["rev-parse", "HEAD"]);
    const ckpt = join(base, "ckpt");
    git(base, ["clone", "-q", integ, ckpt]);
    rmSync(join(ckpt, "libs", "sub"), { recursive: true, force: true });
    git(base, ["clone", "-q", integSub, join(ckpt, "libs", "sub")]);
    git(join(ckpt, "libs", "sub"), ["checkout", "-q", "--detach", pin]);
    const io = makeRealGenCheckHealIo({
      checkpointRoot: ckpt,
      integrationRoot: integ,
      runScript: async () => ({ code: 0, tail: "" }),
      log: () => {},
    });
    return { base, integ, integSub, ckpt, pin, head, io };
  }
  const gitlinkAt = (f: ReturnType<typeof fixture>, commit: string) =>
    git(f.integ, ["ls-tree", commit, "--", "libs/sub"]).split(/\s+/)[2]!;

  it("commits a writer delta inside a submodule on its pin and stages that commit as the gitlink", async () => {
    const f = fixture();
    writeFileSync(join(f.ckpt, "libs", "sub", "gen.txt"), "fresh\n");
    writeFileSync(join(f.ckpt, "top.txt"), "top2\n");
    const paths = await f.io.dirtyPaths();
    expect(paths.sort()).toEqual(["libs/sub", "top.txt"]);

    const src = await f.io.buildSourceCommit(f.head, paths);
    expect(git(f.integ, ["rev-parse", `${src}^`])).toBe(f.head);
    expect(git(f.integ, ["diff", "--name-only", f.head, src]).split("\n")).toEqual(["libs/sub", "top.txt"]);
    const [mode, , subCommit] = git(f.integ, ["ls-tree", src, "--", "libs/sub"]).split(/\s+/);
    expect(mode).toBe("160000");
    expect(git(f.integSub, ["rev-parse", `${subCommit}^`])).toBe(f.pin);
    expect(git(f.integSub, ["diff", "--name-only", f.pin, subCommit!])).toBe("gen.txt");
    expect(git(f.integSub, ["show", `${subCommit}:gen.txt`])).toBe("fresh");
    // The checkout clones submodules from the integration repo; the ref keeps the commit from gc.
    expect(git(f.integSub, ["rev-parse", `refs/papercusp/gen-heal/${subCommit}`])).toBe(subCommit);
  });

  it("refuses a submodule whose HEAD moved off its pin instead of admitting that history", async () => {
    const f = fixture();
    const sub = join(f.ckpt, "libs", "sub");
    writeFileSync(join(sub, "gen.txt"), "fresh\n");
    git(sub, ["commit", "-qam", "moved"]);
    await expect(f.io.buildSourceCommit(f.head, ["libs/sub"])).rejects.toThrow(/not its pin/);
  });

  it("builds the same submodule commit every time, so its gate-pin can be published ahead", async () => {
    const f = fixture();
    writeFileSync(join(f.ckpt, "libs", "sub", "gen.txt"), "fresh\n");
    const first = gitlinkAt(f, await f.io.buildSourceCommit(f.head, ["libs/sub"]));
    const second = gitlinkAt(f, await f.io.buildSourceCommit(f.head, ["libs/sub"]));
    expect(second).toBe(first);
    expect(git(f.integSub, ["show", "-s", "--format=%aI %cI", first])).toBe(
      "2000-01-01T00:00:00+00:00 2000-01-01T00:00:00+00:00",
    );
  });

  it("publishes a gate-pin tag on the submodule's origin for a heal-built gitlink only", async () => {
    const f = fixture();
    const origin = join(f.base, "sub-origin.git");
    git(f.base, ["init", "-q", "--bare", origin]);
    git(f.integSub, ["remote", "add", "origin", origin]);
    expect(await publishGenHealGitlinks({ integrationRoot: f.integ, candidateSha: f.head })).toEqual([]);

    writeFileSync(join(f.ckpt, "libs", "sub", "gen.txt"), "fresh\n");
    const src = await f.io.buildSourceCommit(f.head, ["libs/sub"]);
    const healed = gitlinkAt(f, src);
    expect(await publishGenHealGitlinks({ integrationRoot: f.integ, candidateSha: src })).toEqual([
      { path: "libs/sub", sha: healed },
    ]);
    expect(git(origin, ["rev-parse", `refs/tags/gate-pin/${healed}^{commit}`])).toBe(healed);
  });

  it("throws when the gate-pin cannot be published, so promotion holds", async () => {
    const f = fixture();
    git(f.integSub, ["remote", "add", "origin", join(f.base, "missing-origin.git")]);
    writeFileSync(join(f.ckpt, "libs", "sub", "gen.txt"), "fresh\n");
    const src = await f.io.buildSourceCommit(f.head, ["libs/sub"]);
    await expect(publishGenHealGitlinks({ integrationRoot: f.integ, candidateSha: src })).rejects.toThrow(
      /gate-pin publication for libs\/sub/,
    );
  });
});
