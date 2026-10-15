/**
 * Regression guard for the shared Claude/Codex PreToolUse lock hook. Covers
 * the OPERATOR-INDEPENDENT paths (no live operator needed): tool filtering,
 * workspace scoping, and — critically — the fail-open contract (a hook must
 * NEVER exit non-zero / block an edit, even when the operator is down or the
 * input is junk). The acquire/deny/release paths that need a live operator
 * are exercised by the live functional checks recorded in the plan.
 *
 * The hook is bash+python, so we spawn it as a subprocess with crafted stdin.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

const HOOK = join(__dirname, "..", "pretooluse-locks-acquire.sh");
let home: string, cache: string, ws: string, repo: string;

beforeAll(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), "cchook-home-"));
  fs.mkdirSync(join(home, ".papercusp"), { recursive: true });
  // Install markers — the hook bails out (exit 0) without these.
  fs.writeFileSync(join(home, ".papercusp", "superuser-token"), "test-token\n");
  fs.writeFileSync(join(home, ".papercusp", "su-agent-id"), "test-agent\n");
  cache = fs.mkdtempSync(join(os.tmpdir(), "cchook-cache-"));
  ws = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "cchook-ws-")));
  // A fake worktree that is a direct child of the workspace root, with a
  // `.git` FILE (worktree-style) so find_repo_root resolves it.
  repo = join(ws, "papercup-test");
  fs.mkdirSync(join(repo, "sub"), { recursive: true });
  fs.writeFileSync(join(repo, ".git"), "gitdir: /nonexistent\n");
});
afterAll(() => {
  for (const d of [home, cache, ws])
    fs.rmSync(d, { recursive: true, force: true });
});

function run(input: string, extraEnv: Record<string, string> = {}) {
  const r = spawnSync("bash", [HOOK], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PAPERCUSP_LOCKS_CACHE_DIR: cache,
      PAPERCUSP_WORKSPACE_ROOT: ws,
      // The worktree guard (pretooluse-locks-acquire.sh, worktree-discipline-2026-06-30)
      // denies edits in a workspace-child tree that is NOT the canonical staging tree.
      // This fixture's repo is `<ws>/papercup-test` (a non-canonical sibling), so without
      // this the guard denies every in-workspace edit. Point the guard at the fixture so
      // the operator-independent paths under test (fail-open / scoping) are exercised, not
      // the guard's deny. (The guard's own deny path is covered by pretooluse-locks-decision.)
      PAPERCUSP_CANONICAL_TREE: repo,
      ...extraEnv,
    },
  });
  return { status: r.status, stdout: (r.stdout ?? "").trim() };
}
const payload = (o: object) => JSON.stringify(o);

describe("cc PreToolUse hook — operator-independent paths", () => {
  it("non-edit tool → allow (exit 0, no decision)", () => {
    const r = run(
      payload({
        tool_name: "Read",
        tool_input: { file_path: "/x" },
        tool_use_id: "t",
        session_id: "s",
        cwd: repo,
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("malformed JSON → fail-open allow", () => {
    const r = run("not valid json {");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("edit OUTSIDE the workspace → allow, never coordinated (no operator call)", () => {
    const r = run(
      payload({
        tool_name: "Edit",
        tool_input: { file_path: "/tmp/somewhere-else/x.ts" },
        tool_use_id: "t",
        session_id: "s",
        cwd: "/tmp/somewhere-else",
      }),
      { PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:1" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    // Out-of-scope means we never reached the operator → no error marker.
    expect(fs.existsSync(join(cache, "last-error.json"))).toBe(false);
  });

  it("in-workspace edit + operator unreachable → FAIL-OPEN allow + last-error marker", () => {
    const r = run(
      payload({
        tool_name: "Edit",
        tool_input: { file_path: join(repo, "sub", "f.ts") },
        tool_use_id: "tu",
        session_id: "s",
        cwd: repo,
      }),
      { PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:1" },
    );
    expect(r.status).toBe(0); // never blocks on infra failure
    expect(r.stdout).toBe(""); // no deny decision
    const marker = join(cache, "last-error.json");
    expect(fs.existsSync(marker)).toBe(true);
    expect(JSON.parse(fs.readFileSync(marker, "utf8")).handler).toBe(
      "pretooluse",
    );
  });

  it("valid nested submodule edit reaches the operator instead of being silently skipped", () => {
    const nested = join(repo, "libs", "papercusp");
    fs.mkdirSync(nested, { recursive: true });
    // A real submodule has a gitlink `.git` FILE, not a `.git` directory.
    fs.writeFileSync(join(nested, ".git"), "gitdir: /nonexistent\n");
    const owner = "nested-submodule-owner";
    const marker = join(cache, `owner-${owner}-last-error.json`);
    fs.rmSync(marker, { force: true });

    const r = run(
      payload({
        tool_name: "Edit",
        tool_input: { file_path: join(nested, "packages", "x.ts") },
        tool_use_id: "nested-submodule",
        session_id: "s",
        cwd: repo,
      }),
      {
        PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:1",
        PAPERCUSP_LOCK_SID: owner,
      },
    );
    expect(r.status).toBe(0); // the unreachable operator still fails open
    expect(r.stdout).toBe("");
    // The marker proves the nested path passed the workspace scope gate and
    // attempted locks:acquire; an old direct-child-only gate left no marker.
    expect(fs.existsSync(marker)).toBe(true);
    expect(JSON.parse(fs.readFileSync(marker, "utf8")).handler).toBe(
      "pretooluse",
    );
  });

  it("normalizes a full MCP endpoint before constructing hook routes", () => {
    const owner = "normalize-owner";
    const marker = join(cache, `owner-${owner}-last-error.json`);
    fs.rmSync(marker, { force: true });
    const r = run(
      payload({
        tool_name: "Edit",
        tool_input: { file_path: join(repo, "sub", "normalized.ts") },
        tool_use_id: "normalized",
        session_id: "s",
        cwd: repo,
      }),
      {
        PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:1/api/mcp",
        PAPERCUSP_LOCK_SID: owner,
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(fs.existsSync(marker)).toBe(true);
    const recorded = JSON.parse(fs.readFileSync(marker, "utf8"));
    expect(recorded.operator_url).toBe("http://127.0.0.1:1");
    expect(recorded.owner).toBe(owner);
  });

  it("connection-refused is retried (bounded) before failing open — rides over a restart window", () => {
    // port 1 → ECONNREFUSED on every attempt. A single-shot urlopen fails open
    // near-instantly (refused is immediate); the bounded retry must elapse its
    // ~2.4s budget first. The > 1.5s lower bound reliably distinguishes the two
    // without depending on cross-process server timing.
    const t0 = Date.now();
    const r = run(
      payload({
        tool_name: "Edit",
        tool_input: { file_path: join(repo, "sub", "r.ts") },
        tool_use_id: "tu2",
        session_id: "s",
        cwd: repo,
      }),
      { PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:1" },
    );
    const elapsed = Date.now() - t0;
    expect(r.status).toBe(0); // still fails open after the retries
    expect(r.stdout).toBe(""); // no deny decision
    expect(elapsed).toBeGreaterThan(1500); // proves the retry loop ran
  }, 15000);

  it("not installed (no token) → bail out, allow", () => {
    const bareHome = fs.mkdtempSync(join(os.tmpdir(), "cchook-bare-"));
    const r = spawnSync("bash", [HOOK], {
      input: payload({
        tool_name: "Edit",
        tool_input: { file_path: join(repo, "g.ts") },
        tool_use_id: "t",
        session_id: "s",
        cwd: repo,
      }),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: bareHome,
        PAPERCUSP_LOCKS_CACHE_DIR: cache,
        PAPERCUSP_WORKSPACE_ROOT: ws,
      },
    });
    fs.rmSync(bareHome, { recursive: true, force: true });
    expect(r.status).toBe(0);
    expect((r.stdout ?? "").trim()).toBe("");
  });
});

// ── PostToolUse locks-release hook (EI-1400) ───────────────────────────
// Operator-independent paths only: the no-cached-lock no-op, the fail-open
// contract, and — the regression this exists to guard — a bounded retry on
// connection-refused before giving up, mirroring the PreToolUse hook's own
// retry (added because a single-shot release silently stranded the SERVER-
// SIDE lock for the full 1200s acquire TTL whenever the release POST hit a
// transient refuse, e.g. the few-second window a `lib/**` edit's forced
// :3070 restart refuses connections in — repo-conventions' two-port model).
const RELEASE_HOOK = join(__dirname, "..", "posttooluse-locks-release.sh");

function runRelease(input: string, extraEnv: Record<string, string> = {}) {
  const r = spawnSync("bash", [RELEASE_HOOK], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PAPERCUSP_LOCKS_CACHE_DIR: cache,
      ...extraEnv,
    },
  });
  return { status: r.status, stdout: (r.stdout ?? "").trim() };
}

describe("cc PostToolUse locks-release hook — operator-independent paths", () => {
  it("no cached lock_id for this tool_use_id (Pre didn't run / already released) → no-op", () => {
    const r = runRelease(
      payload({ tool_use_id: "no-such-tu", session_id: "s" }),
      { PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:1" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("connection-refused is retried (bounded) and preserves recovery sidecars after an unconfirmed release", () => {
    const tuId = "release-retry-tu";
    fs.writeFileSync(join(cache, `${tuId}.lock`), "lock-abc\n");
    fs.writeFileSync(join(cache, `${tuId}.paths`), JSON.stringify(["a.ts"]));
    const t0 = Date.now();
    const r = runRelease(
      payload({ tool_use_id: tuId, session_id: "s" }),
      {
        PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:1",
        // Keep both configured origins refused so this test exercises the
        // bounded all-origins retry path rather than the live stable fallback.
        PAPERCUSP_LOCKS_FALLBACK_OPERATOR_URL: "http://127.0.0.1:1",
      },
    );
    const elapsed = Date.now() - t0;
    expect(r.status).toBe(0); // release is always best-effort — never blocks the turn
    // 9ae6b57aad: an unconfirmed release is surfaced to the agent as a
    // LOCK MODE UPDATE (its lock may still be held), never a silent no-op.
    const hookOutput = JSON.parse(r.stdout).hookSpecificOutput;
    expect(hookOutput.hookEventName).toBe("PostToolUse");
    expect(hookOutput.additionalContext).toContain("LOCK MODE UPDATE");
    expect(hookOutput.additionalContext).toContain("manual");
    expect(hookOutput.additionalContext).toContain("a.ts");
    expect(elapsed).toBeGreaterThan(1500); // proves the retry loop actually ran
    // EI-211603: an HTTP/transport failure is not a confirmed release. Keep the
    // token + paths so the parent exec-completion recovery can retry instead of
    // silently stranding the server-side lock until TTL.
    expect(fs.existsSync(join(cache, `${tuId}.lock`))).toBe(true);
    expect(fs.existsSync(join(cache, `${tuId}.paths`))).toBe(true);
    const marker = join(cache, "last-error.json");
    expect(fs.existsSync(marker)).toBe(true);
    expect(JSON.parse(fs.readFileSync(marker, "utf8")).handler).toBe(
      "posttooluse",
    );
  }, 15000);
});

// ── PostToolUse activity-report hook ───────────────────────────────────
// Operator-independent paths only: the psu-session + install gates, the
// fail-open contract, and the first-run cursor behavior. Since EI-11405
// (coordination-hook-rpc-fanout-collapse-2026-07-16) this hook ALSO carries
// the delta-aware coord fold that used to be the separate posttooluse-coord-
// inbox.sh hook (now deleted) — it is therefore SYNCHRONOUS (it must read the
// response to fold), not detached. The live report→agent_activity path AND
// the live hook_bundle inbox→inject fold are exercised by
// posttooluse-activity-report-bundle.test.ts (a stub operator, so the O(1)
// unchanged-generation guard is regression-tested without a live operator)
// plus the live functional smoke recorded in the plan.
const ACTIVITY_HOOK = join(__dirname, "..", "posttooluse-activity-report.sh");
const editPayload = {
  tool_name: "Edit",
  tool_input: { file_path: "/x/y.ts", old_string: "a", new_string: "b" },
  tool_use_id: "t",
  session_id: "s",
  cwd: "/x",
};

function runActivity(
  extraEnv: Record<string, string> = {},
  input: string = payload(editPayload),
  homeDir = home,
) {
  const r = spawnSync("bash", [ACTIVITY_HOOK], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      PAPERCUSP_LOCKS_CACHE_DIR: cache,
      PAPERCUSP_SID: "", // cleared unless a test opts in
      PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:1", // never reach a real operator
      ...extraEnv,
    },
  });
  return { status: r.status, stdout: (r.stdout ?? "").trim() };
}

describe("cc PostToolUse activity-report hook — operator-independent paths", () => {
  it("no PAPERCUSP_SID (not a psu session) → no-op (exit 0, no stdout)", () => {
    const r = runActivity();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("psu session but not installed (no token) → no-op", () => {
    const bareHome = fs.mkdtempSync(join(os.tmpdir(), "acthook-bare-"));
    const r = runActivity(
      { PAPERCUSP_SID: "sid-x" },
      payload(editPayload),
      bareHome,
    );
    fs.rmSync(bareHome, { recursive: true, force: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("operator unreachable → FAIL-OPEN (exit 0, no stdout)", () => {
    const r = runActivity({ PAPERCUSP_SID: "sid-sync" });
    expect(r.status).toBe(0); // a reporting/coord blip never blocks the tool
    expect(r.stdout).toBe(""); // and never emits anything onto the tool result
  });

  it("malformed JSON → fail-open (exit 0, no stdout)", () => {
    const r = runActivity(
      { PAPERCUSP_SID: "sid-junk" },
      "not valid json {",
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("first run does not create a local inbox-floor cursor when the operator is unreachable", () => {
    const sid = "sid-first";
    const cur = join(cache, `activity-hook-bundle-${sid}.json`);
    if (fs.existsSync(cur)) fs.rmSync(cur);
    const r = runActivity({ PAPERCUSP_SID: sid });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(""); // fail-open; no usable bundle means no cursor write
    expect(fs.existsSync(cur)).toBe(false);
  });

  it("subsequent run + operator unreachable → FAIL-OPEN, cursor left untouched", () => {
    const sid = "sid-second";
    const cur = join(cache, `activity-hook-bundle-${sid}.json`);
    fs.writeFileSync(
      cur,
      JSON.stringify({ generation: "host-a:9", since_ts: "2020-01-01T00:00:00Z" }),
    );
    const r = runActivity({ PAPERCUSP_SID: sid });
    expect(r.status).toBe(0); // a coord/operator blip never blocks the turn
    expect(r.stdout).toBe(""); // and never injects junk
    expect(JSON.parse(fs.readFileSync(cur, "utf8"))).toEqual({
      generation: "host-a:9",
      since_ts: "2020-01-01T00:00:00Z",
    });
  });

  // NOTE: the O(1) unchanged-generation guard, the changed→inject fold, the P-015
  // gauge-on-empty-inbox fallback, and the incomplete-hydrate retry reset are all
  // regression-tested against a STUB operator in
  // posttooluse-activity-report-bundle.test.ts (async spawn — spawnSync here would
  // block the stub's own event loop, so those live outside this file). The server-
  // side O(1) skip itself (unchanged generation ⇒ no inbox/glance query at all) is
  // unit-tested in packages/operator-core/lib/agent-tools/activity/hook-bundle.test.ts.

  describe("PAPERCUSP_COORD_FOLD=0 (role-only Codex sessions, role-codex-home.ts)", () => {
    it("never writes a hook_bundle cursor and is detached (NON-BLOCKING) by default", () => {
      const sid = "sid-nofold-detached";
      const cur = join(cache, `activity-hook-bundle-${sid}.json`);
      const t0 = Date.now();
      const r = runActivity({
        PAPERCUSP_SID: sid,
        PAPERCUSP_COORD_FOLD: "0",
        // An unroutable host would hang a synchronous POST for the full timeout;
        // the detached path must return near-instantly (it reparents to init).
        PAPERCUSP_OPERATOR_URL: "http://10.255.255.1:81",
      });
      const elapsed = Date.now() - t0;
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      expect(elapsed).toBeLessThan(2500); // proves it did NOT wait on the 4s POST timeout
      expect(fs.existsSync(cur)).toBe(false); // no coord fold ⇒ no cursor at all
    });

    it("SYNC mode (test-only), operator unreachable → fail-open, no cursor, no stdout", () => {
      const sid = "sid-nofold-sync";
      const cur = join(cache, `activity-hook-bundle-${sid}.json`);
      const r = runActivity({
        PAPERCUSP_SID: sid,
        PAPERCUSP_COORD_FOLD: "0",
        PAPERCUSP_ACTIVITY_SYNC: "1",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      expect(fs.existsSync(cur)).toBe(false);
    });
  });
});

// ── PreToolUse activity-report hook (EI-8997) ──────────────────────────
// Mirrors the PostToolUse suite above — same contract, `phase:'pre'`, fired
// at dispatch time instead of completion (closes the D-003 claim-renewal gap
// a single long-running tool call leaves under PostToolUse-only reporting).
const PRE_ACTIVITY_HOOK = join(
  __dirname,
  "..",
  "pretooluse-activity-report.sh",
);

function runActivityPre(
  extraEnv: Record<string, string> = {},
  input: string = payload(editPayload),
  homeDir = home,
) {
  const r = spawnSync("bash", [PRE_ACTIVITY_HOOK], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      PAPERCUSP_SID: "", // cleared unless a test opts in
      PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:1", // never reach a real operator
      ...extraEnv,
    },
  });
  return { status: r.status, stdout: (r.stdout ?? "").trim() };
}

describe("cc PreToolUse activity-report hook — operator-independent paths", () => {
  it("no PAPERCUSP_SID (not a psu session) → no-op (exit 0, no stdout)", () => {
    const r = runActivityPre();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("psu session but not installed (no token) → no-op", () => {
    const bareHome = fs.mkdtempSync(join(os.tmpdir(), "acthook-pre-bare-"));
    const r = runActivityPre(
      { PAPERCUSP_SID: "sid-x" },
      payload(editPayload),
      bareHome,
    );
    fs.rmSync(bareHome, { recursive: true, force: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("SID + token, SYNC mode, operator unreachable → FAIL-OPEN (exit 0, no stdout)", () => {
    const r = runActivityPre({
      PAPERCUSP_SID: "sid-sync",
      PAPERCUSP_ACTIVITY_SYNC: "1",
    });
    expect(r.status).toBe(0); // a reporting blip never blocks the tool
    expect(r.stdout).toBe(""); // and never emits anything onto the tool result
  });

  it("malformed JSON in SYNC mode → fail-open (exit 0, no stdout)", () => {
    const r = runActivityPre(
      { PAPERCUSP_SID: "sid-junk", PAPERCUSP_ACTIVITY_SYNC: "1" },
      "not valid json {",
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("rewrites an exact colon-form ToolSearch select to Claude's indexed MCP id", () => {
    const r = runActivityPre(
      { PAPERCUSP_SID: "sid-tool-search" },
      payload({
        tool_name: "ToolSearch",
        tool_input: { query: "select:sessions:read", max_results: 7 },
        tool_use_id: "tool-search-1",
        session_id: "session-1",
      }),
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: {
          query: "select:mcp__papercusp-su__sessions_read",
          max_results: 7,
        },
      },
    });
  });

  it.each([
    ["keyword search", "find the sessions read tool"],
    ["already-mangled id", "select:mcp__papercusp-su__sessions_read"],
    ["plugin dot name", "select:repomix.pack"],
    ["too many colon segments", "select:sessions:read:extra"],
  ])("preserves %s ToolSearch queries", (_label, query) => {
    const r = runActivityPre(
      { PAPERCUSP_SID: "sid-tool-search-preserve" },
      payload({
        tool_name: "ToolSearch",
        tool_input: { query },
        tool_use_id: "tool-search-preserve",
        session_id: "session-preserve",
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("does not rewrite colon syntax on another tool or outside a Papercusp session", () => {
    const sameQueryOnRead = runActivityPre(
      { PAPERCUSP_SID: "sid-not-tool-search" },
      payload({
        tool_name: "Read",
        tool_input: { query: "select:sessions:read" },
      }),
    );
    const toolSearchWithoutSid = runActivityPre(
      {},
      payload({
        tool_name: "ToolSearch",
        tool_input: { query: "select:sessions:read" },
      }),
    );
    expect(sameQueryOnRead.status).toBe(0);
    expect(sameQueryOnRead.stdout).toBe("");
    expect(toolSearchWithoutSid.status).toBe(0);
    expect(toolSearchWithoutSid.stdout).toBe("");
  });

  it("fails open when ToolSearch input is malformed", () => {
    const r = runActivityPre(
      { PAPERCUSP_SID: "sid-tool-search-malformed" },
      payload({
        tool_name: "ToolSearch",
        tool_input: { query: ["select:sessions:read"] },
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("detached (default) mode is NON-BLOCKING — returns fast even when the operator would hang", () => {
    const t0 = Date.now();
    const r = runActivityPre({
      PAPERCUSP_SID: "sid-detach",
      PAPERCUSP_OPERATOR_URL: "http://10.255.255.1:81",
    });
    const elapsed = Date.now() - t0;
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(elapsed).toBeLessThan(2500); // proves it did NOT wait on the 3s POST timeout
  });

  // Not a spawnSync-against-a-same-process-server test (like the payload-capture
  // approach might suggest): spawnSync BLOCKS this process's event loop for the
  // whole child lifetime, so a same-process http.createServer server can never
  // actually service the request until spawnSync already returned — a same-process
  // capture race, not a real assertion. The operator-independent scope this file
  // documents up top is deliberate; the live wire payload (phase:'pre' reaching
  // activity:report) is exercised by the activity-tool's own tests + the D-003 live
  // smoke. Here we just pin the SOURCE actually sets phase:'pre' (not 'post') so a
  // future edit can't silently turn this back into a duplicate post-hook.
  it('the script source reports phase:"pre" (never "post")', () => {
    const src = fs.readFileSync(PRE_ACTIVITY_HOOK, "utf8");
    expect(src).toContain("'phase': 'pre'");
    expect(src).not.toContain("'phase': 'post'");
    expect(src).toContain("PAPERCUSP_ROLE");
    expect(src).toContain("PAPERCUSP_AGENT_ROLE");
    expect(src).toContain("args['role'] = role");
  });
});

// ── Fleet statusline (Claude-only progressive enhancement) ─────────────
// The render is fixture-driven (PAPERCUSP_STATUSLINE_FIXTURE) so it's testable
// without a live operator; the fail-open paths must NEVER error.
const STATUSLINE = join(__dirname, "..", "statusline-fleet.sh");

function runStatusline(extraEnv: Record<string, string> = {}, homeDir = home) {
  const r = spawnSync("bash", [STATUSLINE], {
    input: '{"model":"opus","cwd":"/x"}',
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      PAPERCUSP_SID: "",
      PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:1",
      ...extraEnv,
    },
  });
  return { status: r.status, stdout: (r.stdout ?? "").trim() };
}

// ── SessionStart/SessionEnd lifecycle hook ─────────────────────────────
// PAPERCUSP_TEST_LIFECYCLE_HOOK: run this suite against another copy of the hook
// (e.g. a pre-fix blob in a scratch copy of hooks/cc) to prove the guards are
// falsifiable without mutating the shared tree.
const LIFECYCLE_HOOK =
  process.env.PAPERCUSP_TEST_LIFECYCLE_HOOK || join(__dirname, "..", "lifecycle-report.sh");

function runLifecycle(
  payloadObj: object,
  extraEnv: Record<string, string> = {},
  homeDir = home,
) {
  const r = spawnSync("bash", [LIFECYCLE_HOOK], {
    input: payload(payloadObj),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      PAPERCUSP_SID: "",
      PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:1",
      ...extraEnv,
    },
  });
  return { status: r.status, stdout: (r.stdout ?? "").trim() };
}

async function runLifecycleAgainstDisposition(
  disposition: "terminal" | "continuation",
  advSessionId?: string,
  roleEnv: Record<string, string> = {},
  eventName: "SessionEnd" | "Stop" = "SessionEnd",
) {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* asserted below */
      }
      requests.push({ path: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/api/mcp")) {
        const params = body.params as
          | { name?: string; arguments?: Record<string, unknown> }
          | undefined;
        const resultText =
          params?.name === "locks:release"
            ? JSON.stringify({
                ok: true,
                released: Array.isArray(params.arguments?.paths)
                  ? params.arguments.paths
                  : [],
                held_before: 1,
              })
            : JSON.stringify({
                ok: true,
                session_end_disposition: disposition,
              });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [{ type: "text", text: resultText }],
            },
          }),
        );
      } else {
        res.end(JSON.stringify({ ok: true, results: [{ ok: true }] }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture server did not bind TCP");
  const child = spawn("bash", [LIFECYCLE_HOOK], {
    env: {
      ...process.env,
      HOME: home,
      PAPERCUSP_SID: "su-lifecycle-terminal",
      PAPERCUSP_LOCK_SID: "",
      CODEX_HOME: "",
      PAPERCUSP_AGENT: "codex",
      PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${address.port}`,
      ...(advSessionId ? { PAPERCUSP_ADV_SESSION_ID: advSessionId } : {}),
      ...roleEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(
    payload({
      hook_event_name: eventName,
      session_id: "codex-thread-1",
      cwd: repo,
    }),
  );
  const exitCode = await Promise.race([
    new Promise<number | null>((resolve) => child.once("close", resolve)),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("lifecycle hook timed out")), 5_000),
    ),
  ]);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return { exitCode, requests };
}

describe("cc lifecycle hook — operator-independent paths", () => {
  it("no PAPERCUSP_SID → no-op (exit 0, no stdout)", () => {
    const r = runLifecycle({
      hook_event_name: "SessionStart",
      session_id: "s",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("SessionStart + operator unreachable (SYNC) → fail-open (exit 0, no stdout)", () => {
    const r = runLifecycle(
      {
        hook_event_name: "SessionStart",
        source: "startup",
        session_id: "s",
        cwd: "/x",
      },
      { PAPERCUSP_SID: "su-l", PAPERCUSP_ACTIVITY_SYNC: "1" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("SessionEnd + operator unreachable (SYNC) → fail-open (exit 0)", () => {
    const r = runLifecycle(
      { hook_event_name: "SessionEnd", reason: "logout", session_id: "s" },
      { PAPERCUSP_SID: "su-l", PAPERCUSP_ACTIVITY_SYNC: "1" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("a non-lifecycle event (PreToolUse) is ignored — exit 0, no report", () => {
    const r = runLifecycle(
      { hook_event_name: "PreToolUse", tool_name: "Edit" },
      { PAPERCUSP_SID: "su-l", PAPERCUSP_ACTIVITY_SYNC: "1" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("a terminal SessionEnd reports first, then reuses the audited admin fleet:kill route", async () => {
    const { exitCode, requests } = await runLifecycleAgainstDisposition(
      "terminal",
      "42",
      { PAPERCUSP_ROLE: "judge" },
    );
    expect(exitCode).toBe(0);
    expect(requests.map((r) => r.path)).toEqual([
      expect.stringMatching(/^\/api\/mcp\?/),
      "/api/admin/coordination/fleet/kill",
    ]);
    const reportArgs = (
      requests[0].body.params as { arguments?: Record<string, unknown> }
    ).arguments;
    expect(reportArgs).toMatchObject({
      owner: "su-lifecycle-terminal",
      kind: "lifecycle",
      summary: "■ session ended",
      adv_session_id: 42,
      role: "judge",
    });
    expect(requests[1].body).toMatchObject({
      owner: "su-lifecycle-terminal",
      close_terminal: true,
    });
  });

  it("forwards the wake executor's PAPERCUSP_WAKE_DELIVERY_ID as wake_delivery_id (WI-10005679)", async () => {
    const { exitCode, requests } = await runLifecycleAgainstDisposition(
      "terminal",
      undefined,
      { PAPERCUSP_WAKE_DELIVERY_ID: "413379" },
    );
    expect(exitCode).toBe(0);
    expect(
      (requests[0].body.params as { arguments?: Record<string, unknown> })
        .arguments,
    ).toMatchObject({ wake_delivery_id: 413379 });
  });

  it("drops a malformed PAPERCUSP_WAKE_DELIVERY_ID instead of forwarding it", async () => {
    const { requests } = await runLifecycleAgainstDisposition(
      "continuation",
      undefined,
      { PAPERCUSP_WAKE_DELIVERY_ID: "not-a-number" },
    );
    const args = (requests[0].body.params as { arguments?: Record<string, unknown> })
      .arguments;
    expect(args).toBeDefined();
    expect(args).not.toHaveProperty("wake_delivery_id");
  });

  it("a carry/reset continuation SessionEnd never kills the managed host", async () => {
    const { exitCode, requests } = await runLifecycleAgainstDisposition(
      "continuation",
      undefined,
      { PAPERCUSP_AGENT_ROLE: "judge" },
    );
    expect(exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toMatch(/^\/api\/mcp\?/);
    expect(
      (requests[0].body.params as { arguments?: Record<string, unknown> })
        .arguments,
    ).toMatchObject({ role: "judge" });
  });
  it("Stop with a continuation releases only same-owner locks from that native session", async () => {
    const stopCache = fs.mkdtempSync(join(os.tmpdir(), "lifecycle-stop-locks-"));
    const seedLock = (
      toolUseId: string,
      lockId: string,
      owner: string,
      sessionId: string,
      path: string,
    ) => {
      fs.writeFileSync(join(stopCache, `${toolUseId}.lock`), `${lockId}\n`);
      fs.writeFileSync(join(stopCache, `${toolUseId}.paths`), JSON.stringify([path]));
      fs.writeFileSync(join(stopCache, `${toolUseId}.owner`), owner);
      fs.writeFileSync(join(stopCache, `${toolUseId}.session`), sessionId);
    };
    const currentSession = "codex-thread-1";
    seedLock("owned-tu", "lock-owned", "su-lifecycle-terminal", currentSession, "owned.ts");
    seedLock("other-session-tu", "lock-other-session", "su-lifecycle-terminal", "another-session", "other-session.ts");
    seedLock("other-owner-tu", "lock-other-owner", "su-peer", currentSession, "other-owner.ts");

    try {
      const { exitCode, requests } = await runLifecycleAgainstDisposition(
        "continuation",
        undefined,
        { PAPERCUSP_LOCKS_CACHE_DIR: stopCache },
        "Stop",
      );
      const lockReleases = requests.filter(
        (request) =>
          (request.body.params as { name?: string } | undefined)?.name ===
          "locks:release",
      );
      expect(exitCode).toBe(0);
      expect(requests.some((request) => request.path === "/api/admin/coordination/fleet/kill")).toBe(false);
      expect(lockReleases).toHaveLength(1);
      expect(lockReleases[0].body.params).toMatchObject({
        name: "locks:release",
        arguments: { lock_id: "lock-owned", paths: ["owned.ts"] },
      });
      expect(fs.existsSync(join(stopCache, "owned-tu.lock"))).toBe(false);
      expect(fs.existsSync(join(stopCache, "owned-tu.session"))).toBe(false);
      expect(fs.existsSync(join(stopCache, "other-session-tu.lock"))).toBe(true);
      expect(fs.existsSync(join(stopCache, "other-owner-tu.lock"))).toBe(true);
    } finally {
      fs.rmSync(stopCache, { recursive: true, force: true });
    }
  });
  // WI-6554700010009992: Codex fires Stop at the end of EVERY turn. When it was
  // reported as "■ session ended", a parked loop-less session (a warm headless
  // executor after its first turn) got a `terminal` verdict and fleet:kill'ed its
  // own live host. The server verdict is forced to `terminal` here so the hook,
  // not the classifier, is what must keep a turn end from ending the session.
  it("Stop is a turn end — even a terminal verdict never reports an end or kills the host", async () => {
    const { exitCode, requests } = await runLifecycleAgainstDisposition(
      "terminal",
      "42",
      {},
      "Stop",
    );
    expect(exitCode).toBe(0);
    expect(requests.some((request) => request.path === "/api/admin/coordination/fleet/kill")).toBe(false);
    const reports = requests.filter(
      (request) =>
        (request.body.params as { name?: string } | undefined)?.name ===
        "activity:report",
    );
    expect(reports).toEqual([]);
  });
});

describe("cc fleet statusline — render + fail-open", () => {
  it("renders peers + the newest PEER action (excluding my own activity)", () => {
    const fixture = join(cache, "sl-fixture.json");
    fs.writeFileSync(
      fixture,
      JSON.stringify({
        activity: [
          { owner_id: "su-074be3de", summary: "✎ catalog.ts", kind: "tool" },
          { owner_id: "su-me-self", summary: "▶ npm test", kind: "tool" },
          { owner_id: "su-a6146ddc", summary: "👁 README.md", kind: "tool" },
        ],
        count: 3,
      }),
    );
    const r = runStatusline({
      PAPERCUSP_SID: "su-me-self",
      PAPERCUSP_STATUSLINE_FIXTURE: fixture,
    });
    expect(r.status).toBe(0);
    // The static 'papercusp' label was REMOVED 2026-07-03 at owner request (it only ate
    // line width; the ◇ id already identifies the pane) — the line leads with the self chip.
    expect(r.stdout).not.toContain("papercusp");
    expect(r.stdout).toContain("◇ su-me"); // THIS agent's own shorthand id chip
    expect(r.stdout).toContain("2 peers"); // su-074be + su-a6146, not me
    expect(r.stdout).toContain("4be3de"); // newest peer's short id
    expect(r.stdout).toContain("✎ catalog.ts");
    expect(r.stdout).not.toContain("npm test"); // my own action is excluded
  });

  it('renders "solo" + this agent\'s own id when only my own activity exists', () => {
    const fixture = join(cache, "sl-solo.json");
    fs.writeFileSync(
      fixture,
      JSON.stringify({
        activity: [{ owner_id: "su-only-me", summary: "✎ x.ts", kind: "tool" }],
        count: 1,
      }),
    );
    const r = runStatusline({
      PAPERCUSP_SID: "su-only-me",
      PAPERCUSP_STATUSLINE_FIXTURE: fixture,
    });
    expect(r.status).toBe(0);
    // no static 'papercusp' prefix (removed 2026-07-03 at owner request)
    expect(r.stdout).toBe("◇ su-only · solo");
  });

  it("not a psu session → prints nothing (Claude falls back to default), exit 0", () => {
    const r = runStatusline();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("operator unreachable → fail-open empty, exit 0 (never errors the statusline)", () => {
    const r = runStatusline({ PAPERCUSP_SID: "su-x" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  // P-012 (review-system-rework-reduction-2026-09-23): the statusline was ~3.5k coord:glance
  // RPCs/hour fleet-wide. It now reuses the glance the PostToolUse activity hook already cached
  // (refreshed only on coordination change), and single-flights its own refresh. The operator
  // is pinned UNREACHABLE in these tests, so a rendered line proves no RPC was needed: the
  // live-read path returns nothing here (see the fail-open test above).
  describe("glance reuse — no RPC while a fresh snapshot exists", () => {
    const SID = "su-p012-self";
    const displayGlance = (line: string) => ({
      wake: { default: "auto" },
      display: { statusline: [line], title: "" },
      activity: [],
    });
    function dirs() {
      return {
        locks: fs.mkdtempSync(join(os.tmpdir(), "sl-bundle-")),
        own: fs.mkdtempSync(join(os.tmpdir(), "sl-own-")),
      };
    }
    function writeBundle(dir: string, glance: object, observedAgoSec: number) {
      fs.writeFileSync(
        join(dir, `activity-hook-bundle-${SID}.json`),
        JSON.stringify({
          generation: "g1",
          glance,
          glanceObservedAt: new Date(Date.now() - observedAgoSec * 1000).toISOString(),
        }),
      );
    }
    function env(d: { locks: string; own: string }, extra: Record<string, string> = {}) {
      return {
        PAPERCUSP_SID: SID,
        PAPERCUSP_GATEWAY_URL: "http://127.0.0.1:1",
        PAPERCUSP_LOCKS_CACHE_DIR: d.locks,
        PAPERCUSP_STATUSLINE_CACHE_DIR: d.own,
        ...extra,
      };
    }
    // The statusline's own snapshot path: sha256("<operator url>|<owner>")[:24] + ".json"
    // (statusline-fleet.sh _cache_path). If that derivation drifts, the marker/snapshot tests
    // below stop finding the file and fail on the empty render — never pass vacuously.
    const ownPath = (d: { own: string }) =>
      join(
        d.own,
        `${createHash("sha256").update(`http://127.0.0.1:1|${SID}`).digest("hex").slice(0, 24)}.json`,
      );
    function writeOwn(d: { own: string }, line: string, agoSec: number) {
      const p = ownPath(d);
      fs.writeFileSync(p, JSON.stringify(displayGlance(line)));
      const t = new Date(Date.now() - agoSec * 1000);
      fs.utimesSync(p, t, t);
    }

    it("renders the PostToolUse bundle glance when it is fresh (no RPC)", () => {
      const d = dirs();
      writeBundle(d.locks, displayGlance("◇ BUNDLE-LINE"), 5);
      const r = runStatusline(env(d));
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("BUNDLE-LINE");
    });

    it("ignores a bundle glance older than the max age (falls through to the live read)", () => {
      const d = dirs();
      writeBundle(d.locks, displayGlance("◇ OLD-BUNDLE"), 120);
      const r = runStatusline(env(d));
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    });

    it("keys the bundle file by the same owner normalisation as the PostToolUse hook", () => {
      const d = dirs();
      // A different owner's bundle must never be rendered as mine.
      fs.writeFileSync(
        join(d.locks, "activity-hook-bundle-su-someone-else.json"),
        JSON.stringify({ glance: displayGlance("◇ NOT-MINE"), glanceObservedAt: new Date().toISOString() }),
      );
      const r = runStatusline(env(d));
      expect(r.stdout).toBe("");
    });

    it("serves its own snapshot within the 30s TTL and re-reads past it", () => {
      const d = dirs();
      writeOwn(d, "◇ OWN-FRESH", 10);
      expect(runStatusline(env(d)).stdout).toContain("OWN-FRESH");
      writeOwn(d, "◇ OWN-EXPIRED", 45);
      expect(runStatusline(env(d)).stdout).toBe("");
    });

    it("prefers the NEWER of its own snapshot and the bundle glance", () => {
      const d = dirs();
      writeOwn(d, "◇ OWN-OLDER", 20);
      writeBundle(d.locks, displayGlance("◇ BUNDLE-NEWER"), 2);
      expect(runStatusline(env(d)).stdout).toContain("BUNDLE-NEWER");
      writeOwn(d, "◇ OWN-NEWER", 1);
      writeBundle(d.locks, displayGlance("◇ BUNDLE-OLDER"), 20);
      expect(runStatusline(env(d)).stdout).toContain("OWN-NEWER");
    });

    it("single-flight: a peer render's in-flight refresh → show the stale snapshot, no second RPC", () => {
      const d = dirs();
      writeBundle(d.locks, displayGlance("◇ STALE-BUT-SHOWN"), 120); // past the 60s max age
      // Control: no marker → this render claims the refresh, the (unreachable) RPC fails,
      // nothing renders, and the marker is released behind it.
      expect(runStatusline(env(d)).stdout).toBe("");
      expect(fs.existsSync(`${ownPath(d)}.inflight`)).toBe(false);
      // A peer holds the refresh → this render must not issue its own; it shows the stale one.
      fs.writeFileSync(`${ownPath(d)}.inflight`, "");
      expect(runStatusline(env(d)).stdout).toContain("STALE-BUT-SHOWN");
      // A marker older than INFLIGHT_MAX_SEC is a dead render's → reclaimed (live read again).
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(`${ownPath(d)}.inflight`, old, old);
      expect(runStatusline(env(d)).stdout).toBe("");
      expect(fs.existsSync(`${ownPath(d)}.inflight`)).toBe(false);
    });
  });

  // agent-managed-compaction P-015: the `ctx N%` context-usage chip from the glance
  // payload's self.context, ⚠-prefixed at/above the LOUD band (80%). PAPERCUSP_GATEWAY_URL
  // is pinned unroutable so the routed-account read-back (lead()) fails fast → deterministic.
  const CTX_ENV = {
    PAPERCUSP_SID: "su-me-self",
    PAPERCUSP_GATEWAY_URL: "http://127.0.0.1:1",
  };

  it("renders the ⚠-prefixed ctx gauge chip at/above the loud band (self.context.pct ≥ 80)", () => {
    const fixture = join(cache, "sl-ctx-loud.json");
    fs.writeFileSync(
      fixture,
      JSON.stringify({
        wake: { default: "auto" },
        self: { context: { tokens: 425000, limit: 500000, pct: 85 } },
        activity: [],
      }),
    );
    const r = runStatusline({
      ...CTX_ENV,
      PAPERCUSP_STATUSLINE_FIXTURE: fixture,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("⚠ ctx 85%");
  });

  it("renders a quiet ctx gauge chip (no ⚠) below the loud band", () => {
    const fixture = join(cache, "sl-ctx-quiet.json");
    fs.writeFileSync(
      fixture,
      JSON.stringify({
        wake: { default: "auto" },
        self: { context: { tokens: 210000, limit: 500000, pct: 42 } },
        activity: [],
      }),
    );
    const r = runStatusline({
      ...CTX_ENV,
      PAPERCUSP_STATUSLINE_FIXTURE: fixture,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ctx 42%");
    expect(r.stdout).not.toContain("⚠ ctx");
  });

  it("omits the ctx chip when self.context is absent (additive + fail-open)", () => {
    const fixture = join(cache, "sl-ctx-absent.json");
    fs.writeFileSync(
      fixture,
      JSON.stringify({
        wake: { default: "auto" },
        self: {},
        activity: [],
      }),
    );
    const r = runStatusline({
      ...CTX_ENV,
      PAPERCUSP_STATUSLINE_FIXTURE: fixture,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("ctx");
  });
});

// P-012 (review-system-rework-reduction-2026-09-23): activity:report was ~8k calls/hour, most of
// them bursts. Both hooks now keep a minimum interval, recorded in shared per-session marker
// files. Async spawn against a same-process fake operator (spawnSync would block the server —
// see the note above the pre-hook source test) that COUNTS activity:report requests.
describe("cc activity-report hooks — minimum interval (P-012)", () => {
  const PRE = join(__dirname, "..", "pretooluse-activity-report.sh");
  const POST = join(__dirname, "..", "posttooluse-activity-report.sh");
  // `filePath` varies the reported STATE; `toolUseId` varies only the per-call id, which is
  // not state (D-014), so two events differing only in it are the same state.
  const event = (name: string, filePath = "/x", toolUseId = "t1") =>
    JSON.stringify({
      hook_event_name: name,
      tool_name: "Read",
      tool_input: { file_path: filePath },
      tool_response: "ok",
      tool_use_id: toolUseId,
      session_id: "s1",
      cwd: "/x",
    });

  async function withOperator(fn: (url: string, sent: () => number) => Promise<void>) {
    let n = 0;
    const server = createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        if (raw.includes('"activity:report"')) n += 1;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server did not bind TCP");
    try {
      await fn(`http://127.0.0.1:${address.port}`, () => n);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  async function fire(
    hook: string,
    url: string,
    locks: string,
    extra: Record<string, string> = {},
    filePath = "/x",
    toolUseId = "t1",
  ) {
    const child = spawn("bash", [hook], {
      env: {
        ...process.env,
        HOME: home,
        PAPERCUSP_SID: "su-p012-throttle",
        PAPERCUSP_OPERATOR_URL: url,
        PAPERCUSP_LOCKS_CACHE_DIR: locks,
        PAPERCUSP_ACTIVITY_SYNC: "1",
        PAPERCUSP_COORD_FOLD: "0",
        ...extra,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(event(hook === PRE ? "PreToolUse" : "PostToolUse", filePath, toolUseId));
    const code = await Promise.race([
      new Promise<number | null>((resolve) => child.once("close", resolve)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("hook timed out")), 8_000)),
    ]);
    expect(code).toBe(0); // a throttled report is still a clean no-op, never a failure
  }
  const locksDir = () => fs.mkdtempSync(join(os.tmpdir(), "act-throttle-"));

  it("pre: a second dispatch report within 30s is skipped (control: interval 0 sends it)", async () => {
    await withOperator(async (url, sent) => {
      const locks = locksDir();
      await fire(PRE, url, locks);
      expect(sent()).toBe(1);
      await fire(PRE, url, locks);
      expect(sent()).toBe(1);
      await fire(PRE, url, locks, { PAPERCUSP_ACTIVITY_PRE_MIN_INTERVAL_SEC: "0" }, "/y");
      expect(sent()).toBe(2);
    });
  });

  it("pre: a recent POST report also suppresses the dispatch report", async () => {
    await withOperator(async (url, sent) => {
      const locks = locksDir();
      await fire(POST, url, locks);
      expect(sent()).toBe(1);
      await fire(PRE, url, locks);
      expect(sent()).toBe(1);
    });
  });

  it("post: a second completion report within 10s is skipped (control: interval 0 sends it)", async () => {
    await withOperator(async (url, sent) => {
      const locks = locksDir();
      await fire(POST, url, locks);
      expect(sent()).toBe(1);
      await fire(POST, url, locks);
      expect(sent()).toBe(1);
      await fire(POST, url, locks, { PAPERCUSP_ACTIVITY_POST_MIN_INTERVAL_SEC: "0" }, "/y");
      expect(sent()).toBe(2);
    });
  });

  it("post: the same call's dispatch report never suppresses its completion report", async () => {
    await withOperator(async (url, sent) => {
      const locks = locksDir();
      await fire(PRE, url, locks);
      await fire(POST, url, locks);
      expect(sent()).toBe(2);
    });
  });

  // RSR-P-012-A: emit only on a change of state. Interval gates are switched OFF here so the
  // state gate is the only thing under test; D-014's due-flags (lease renewal for pre,
  // coordination fold for post) are the one sanctioned re-send of an identical state.
  const noInterval = {
    PAPERCUSP_ACTIVITY_PRE_MIN_INTERVAL_SEC: "0",
    PAPERCUSP_ACTIVITY_POST_MIN_INTERVAL_SEC: "0",
  };
  for (const [label, hook, dueKey] of [
    ["pre", PRE, "PAPERCUSP_ACTIVITY_KEEPALIVE_SEC"],
    ["post", POST, "PAPERCUSP_ACTIVITY_POST_FOLD_DUE_SEC"],
  ] as const) {
    it(`${label} state: two identical consecutive states emit ONE report (a new tool_use_id is not a new state)`, async () => {
      await withOperator(async (url, sent) => {
        const locks = locksDir();
        await fire(hook, url, locks, noInterval, "/x", "t1");
        await fire(hook, url, locks, noInterval, "/x", "t2");
        expect(sent()).toBe(1);
      });
    });

    it(`${label} state: a changed state emits (control for the identical-state case)`, async () => {
      await withOperator(async (url, sent) => {
        const locks = locksDir();
        await fire(hook, url, locks, noInterval, "/x");
        await fire(hook, url, locks, noInterval, "/y");
        await fire(hook, url, locks, noInterval, "/x");
        expect(sent()).toBe(3);
      });
    });

    it(`${label} state: an identical state is re-sent once its due window has passed (D-014)`, async () => {
      await withOperator(async (url, sent) => {
        const locks = locksDir();
        await fire(hook, url, locks, noInterval);
        await fire(hook, url, locks, { ...noInterval, [dueKey]: "0" });
        expect(sent()).toBe(2);
      });
    });
  }
});
