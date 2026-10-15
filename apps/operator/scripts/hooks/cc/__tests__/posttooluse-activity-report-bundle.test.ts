/**
 * posttooluse-activity-report-bundle.test.ts — the merged activity-report hook's
 * OPERATOR-DEPENDENT delta-fold regression (EI-11405 / coordination-hook-rpc-fanout
 * -collapse-2026-07-16, WI-4654).
 *
 * cc-hooks.test.ts covers the operator-INDEPENDENT paths (psu-session gate, install
 * gate, first-run generation cursor behavior, fail-open on an unreachable operator). This suite
 * closes the remaining cell with a STUB operator (the same in-process HTTP stub
 * pattern as pretooluse-locks-decision.test.ts — async `spawn`, never `spawnSync`,
 * so the stub can actually answer): the exact GUARD the bug asked for —
 *
 *   - a CHANGED generation folds the coord:inbox injection into ONE PostToolUse
 *     additionalContext output, and persists generation + the complete glance;
 *     the server owns
 *     the inbox floor so a first call cannot seed itself past unread mail;
 *   - the VERY NEXT call forwards that persisted generation back to the server
 *     unchanged — which is what makes an UNCHANGED generation return no `surfaces`
 *     at all (server-side O(1), already unit-tested in hook-bundle.test.ts) — and the
 *     hook then emits NOTHING (no stdout), never re-asking for inbox/glance;
 *   - a P-015 context-gauge fallback still fires on a quiet fold with an empty inbox;
 *   - an INCOMPLETE fold (partial hydrate failure) resets the persisted generation to
 *     null so the NEXT call retries a full hydrate instead of wrongly believing it is
 *     caught up.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { runHookProcess } from "./spawn-hook";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

const HOOK = join(__dirname, "..", "posttooluse-activity-report.sh");
const ACTIVITY_HOOK_BUNDLE_SCHEMA = "activity-hook-bundle-v1";
const GREP_NO_RESULT_ADVISORY =
  "⚠ Native Grep returned no results. Treat this zero as UNMEASURED: run a positive-control search for a token you know exists in the same batch, then use `rg` via Bash and its exit status before claiming absence.";

let home: string, cache: string;
let server: Server;
let port: number;
/** The `activity:report` tool result body the stub returns next. */
let nextResult: unknown = { ok: true, id: 1 };
let lastRequest: { url: string; body: Record<string, any> } | null = null;
let requestCount = 0;

beforeAll(async () => {
  home = fs.mkdtempSync(join(os.tmpdir(), "cchook-actbundle-home-"));
  fs.mkdirSync(join(home, ".papercusp"), { recursive: true });
  fs.writeFileSync(join(home, ".papercusp", "superuser-token"), "test-token\n");
  cache = fs.mkdtempSync(join(os.tmpdir(), "cchook-actbundle-cache-"));

  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requestCount += 1;
      lastRequest = {
        url: req.url ?? "",
        body: JSON.parse(body) as Record<string, any>,
      };
      const rpc = {
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: JSON.stringify(nextResult) }],
        },
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rpc));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  nextResult = { ok: true, id: 1 };
  lastRequest = null;
  requestCount = 0;
  cache = fs.mkdtempSync(join(os.tmpdir(), "cchook-actbundle-cache-"));
});

afterEach(() => {
  if (cache && fs.existsSync(cache))
    fs.rmSync(cache, { recursive: true, force: true });
});

async function run(
  sid: string,
  extraEnv: Record<string, string> = {},
  event: Record<string, unknown> = {},
): Promise<{ status: number | null; stdout: string }> {
  const { status, stdout } = await runHookProcess("bash", [HOOK], {
    input: JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "/x/y.ts", old_string: "a", new_string: "b" },
      tool_use_id: "t",
      session_id: "s",
      cwd: "/x",
      ...event,
    }),
    env: {
      ...process.env,
      HOME: home,
      PAPERCUSP_LOCKS_CACHE_DIR: cache,
      PAPERCUSP_SID: sid,
      PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${port}`,
      ...extraEnv,
    },
  });
  return { status, stdout: stdout.trim() };
}

interface HookCursor {
  generation?: string | null;
  glance?: Record<string, unknown>;
  glanceObservedAt?: string;
}

function cursorFor(sid: string): HookCursor | null {
  const p = join(cache, `activity-hook-bundle-${sid}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

describe("cc PostToolUse activity-report hook — hook_bundle fold (stub operator)", () => {
  it("forwards the fine-grained launch role into activity:report", async () => {
    nextResult = { ok: true, id: 0 };
    const r = await run("sid-role", { PAPERCUSP_ROLE: "judge" });
    expect(r.status).toBe(0);
    expect(lastRequest?.body.params.arguments).toMatchObject({ role: "judge" });
  });

  it("native Grep no-result response emits the unmeasured-result advisory", async () => {
    nextResult = { ok: true, id: 1 }; // no fold response; the local advisory is independent
    const r = await run(
      "sid-grep-nudge",
      {},
      {
        tool_name: "Grep",
        tool_response: "No files found",
      },
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: GREP_NO_RESULT_ADVISORY,
      },
    });
  });

  it("appends the Grep advisory after folded coord context", async () => {
    nextResult = {
      ok: true,
      id: 1,
      hook_bundle: {
        schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA,
        generation: "host-a:1",
        changed: true,
        complete: true,
        surfaces: {
          inbox: {
            entries: [{ ts: "2026-07-16T00:01:00Z", msg_id: "m0" }],
            injection: "[coord+1] peer: check this",
            summary: { newest_ts: "2026-07-16T00:01:00Z" },
          },
        },
      },
    };
    const r = await run(
      "sid-grep-coord",
      {},
      {
        tool_name: "Grep",
        tool_response: "No matches found",
      },
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `[coord+1] peer: check this\n\n${GREP_NO_RESULT_ADVISORY}`,
      },
    });
  });

  it("emits the Grep advisory even when the operator is unreachable", async () => {
    const r = await run(
      "sid-grep-down",
      { PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:1" },
      { tool_name: "Grep", tool_response: "No matches found" },
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: GREP_NO_RESULT_ADVISORY,
      },
    });
  });

  it("keeps positive Grep results silent", async () => {
    nextResult = { ok: true, id: 1 }; // no local advisory and no fold injection
    const r = await run(
      "sid-grep-positive",
      {},
      {
        tool_name: "Grep",
        tool_response: "Found 12 files",
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("normalizes a Codex update_plan snapshot before generic input capping loses the list", async () => {
    nextResult = { ok: true, id: 1 };
    const r = await run(
      "sid-update-plan",
      {},
      {
        tool_name: "update_plan",
        tool_input: {
          explanation: "Advance after verification",
          plan: [
            { step: "Inspect the seam", status: "completed" },
            { step: "Implement the adapter", status: "in_progress" },
            { step: "Run focused tests", status: "pending" },
          ],
        },
      },
    );
    expect(r.status).toBe(0);
    expect(lastRequest?.body.params.arguments).toMatchObject({
      tool_name: "update_plan",
      todos: [
        {
          content: "Inspect the seam",
          activeForm: "Inspect the seam",
          status: "completed",
        },
        {
          content: "Implement the adapter",
          activeForm: "Implement the adapter",
          status: "in_progress",
        },
        {
          content: "Run focused tests",
          activeForm: "Run focused tests",
          status: "pending",
        },
      ],
    });
    expect(lastRequest?.body.params.arguments.tool_input).toBeUndefined();
  });

  it("first call: sends only a generation cursor and preserves a pre-session inbox injection", async () => {
    const sid = "sid-seed";
    const observedAt = new Date().toISOString();
    const glance = { display: { title: "fresh title", notice: null } };
    nextResult = {
      ok: true,
      id: 1,
      hook_bundle: {
        schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA,
        generation: "host-a:1",
        changed: true,
        complete: true,
        provenance: { observedAt },
        surfaces: {
          glance,
          inbox: {
            entries: [{ ts: "2026-07-16T00:01:00Z", msg_id: "m0" }],
            injection: "[coord+1] pre-session peer mail",
            summary: { newest_ts: "2026-07-16T00:01:00Z" },
          },
        },
      },
    };
    const r = await run(sid, { PAPERCUSP_HARNESS_SLUG: "papercusp" });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "[coord+1] pre-session peer mail",
      },
    });
    expect(lastRequest?.body.params.arguments.hook_bundle).toEqual({
      generation: null,
    });
    expect(lastRequest?.body.params.arguments.harness_slug).toBe("papercusp");
    const cur = cursorFor(sid);
    expect(cur).toEqual({
      generation: "host-a:1",
      glance,
      glanceObservedAt: observedAt,
    });
  });

  it("keys the MCP client and shared cache by the native session owner when the ambient SID is stale", async () => {
    const ambientSid = "sid-stale";
    const resolvedSid = "su-resolved-owner";
    const nativeSessionId = "0123abcd-1234-5678-9abc-def012345678";
    const owners = join(home, ".papercusp", "psu-session-owners");
    fs.mkdirSync(owners, { recursive: true });
    fs.writeFileSync(
      join(owners, nativeSessionId),
      JSON.stringify({ v: 1, ownerId: resolvedSid }),
    );
    const observedAt = new Date().toISOString();
    const glance = { display: { title: "resolved title", notice: null } };
    nextResult = {
      ok: true,
      id: 11,
      hook_bundle: {
        schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA,
        generation: "host-a:1",
        changed: true,
        complete: true,
        provenance: { observedAt },
        surfaces: {
          inbox: { entries: [], summary: { newest_ts: null } },
          glance,
        },
      },
    };

    try {
      const r = await run(ambientSid, {}, { session_id: nativeSessionId });
      expect(r.status).toBe(0);
      expect(lastRequest?.url).toContain(`client=${resolvedSid}`);
      expect(new URL(lastRequest?.url ?? '', 'http://127.0.0.1').searchParams.get('native_session')).toBe(nativeSessionId);
      expect(lastRequest?.body.params.arguments.owner).toBe(resolvedSid);
      expect(cursorFor(resolvedSid)).toEqual({
        generation: "host-a:1",
        glance,
        glanceObservedAt: observedAt,
      });
      expect(cursorFor(ambientSid)).toBeNull();
    } finally {
      fs.rmSync(join(owners, nativeSessionId), { force: true });
    }
  });

  it("changed generation with a real message: injects it and advances generation only", async () => {
    const sid = "sid-changed";
    // Seed a cursor as if a prior call already ran (skips the "first call" branch).
    fs.writeFileSync(
      join(cache, `activity-hook-bundle-${sid}.json`),
      JSON.stringify({ generation: "host-a:1" }),
    );
    nextResult = {
      ok: true,
      id: 2,
      hook_bundle: {
        schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA,
        generation: "host-a:2",
        changed: true,
        complete: true,
        surfaces: {
          inbox: {
            entries: [
              {
                ts: "2026-07-16T01:00:00Z",
                msg_id: "m1",
                from: "peer",
                kind: "message",
                summary: "hi",
              },
            ],
            injection: "[coord+1] peer: hi",
            summary: { newest_ts: "2026-07-16T01:00:00Z" },
          },
        },
      },
    };
    const r = await run(sid);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "[coord+1] peer: hi",
      },
    });
    // No glance is cached yet, so the client asks for the GLANCE leg — not a
    // full resync. Pre-split this read `force_resync: true`, which is exactly
    // the coupling WI-10002436 (compromise B) removed: an absent DISPLAY cache
    // is not evidence that the delivery leg needs re-hydrating.
    expect(lastRequest?.body.params.arguments.hook_bundle).toEqual({
      generation: "host-a:1",
      glance_stale: true,
    });
    const cur = cursorFor(sid);
    expect(cur).toEqual({ generation: "host-a:2" });
  });

  it("THE GUARD: an unchanged generation (no new coord deltas) is forwarded back untouched and injects nothing", async () => {
    const sid = "sid-quiet";
    const glance = { display: { title: "cached title", notice: null } };
    const glanceObservedAt = new Date().toISOString();
    fs.writeFileSync(
      join(cache, `activity-hook-bundle-${sid}.json`),
      JSON.stringify({ generation: "host-a:2", glance, glanceObservedAt }),
    );
    // The server's real behavior on a matching generation: no `surfaces` at all
    // (hook-bundle.test.ts already pins this server-side; here we pin the CLIENT
    // reacts correctly to it — no extra inbox/glance call, no injection, generation held).
    nextResult = {
      ok: true,
      id: 3,
      hook_bundle: {
        schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA,
        generation: "host-a:2",
        changed: false,
        complete: true,
      },
    };
    const r = await run(sid);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(""); // O(1): nothing folded, nothing injected
    expect(requestCount).toBe(1); // exactly ONE round trip for this tool call — the whole point of the fix
    expect(lastRequest?.body.params.arguments.hook_bundle).toEqual({
      generation: "host-a:2",
      glance_stale: false,
    });
    const cur = cursorFor(sid);
    expect(cur).toEqual({ generation: "host-a:2", glance, glanceObservedAt }); // untouched
  });

  it("an owner-irrelevant generation advance preserves a fresh glance snapshot and its original age", async () => {
    const sid = "sid-owner-irrelevant";
    const glance = { display: { title: "cached title", notice: null } };
    const glanceObservedAt = new Date().toISOString();
    fs.writeFileSync(
      join(cache, `activity-hook-bundle-${sid}.json`),
      JSON.stringify({ generation: "host-a:2", glance, glanceObservedAt }),
    );
    nextResult = {
      ok: true,
      id: 31,
      hook_bundle: {
        schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA,
        generation: "host-a:3",
        changed: false,
        complete: true,
        provenance: { observedAt: new Date().toISOString() },
      },
    };
    const r = await run(sid);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(lastRequest?.body.params.arguments.hook_bundle).toEqual({
      generation: "host-a:2",
      glance_stale: false,
    });
    expect(cursorFor(sid)).toEqual({
      generation: "host-a:3",
      glance,
      glanceObservedAt,
    });
  });

  it("an aged-out glance cache asks for the GLANCE leg only, and atomically replaces the snapshot", async () => {
    const sid = "sid-stale-glance";
    const oldGlance = { display: { title: "old title", notice: null } };
    const newGlance = { display: { title: "new title", notice: null } };
    const newObservedAt = new Date().toISOString();
    fs.writeFileSync(
      join(cache, `activity-hook-bundle-${sid}.json`),
      JSON.stringify({
        generation: "host-a:2",
        glance: oldGlance,
        glanceObservedAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    nextResult = {
      ok: true,
      id: 32,
      hook_bundle: {
        schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA,
        generation: "host-a:3",
        changed: true,
        complete: true,
        provenance: { observedAt: newObservedAt },
        surfaces: {
          inbox: { entries: [], summary: { newest_ts: null } },
          glance: newGlance,
        },
      },
    };
    const r = await run(sid);
    expect(r.status).toBe(0);
    // THE LEG SPLIT, asserted at the wire: a stale DISPLAY cache sends
    // `glance_stale`, never `force_resync`. The distinction is the whole point —
    // `force_resync` is the server's replace-everything contract and would drag
    // the delivery leg through a hydration this client never needed
    // (WI-10002436, compromise B; measured 61% of folds pre-split).
    expect(lastRequest?.body.params.arguments.hook_bundle).toEqual({
      generation: "host-a:2",
      glance_stale: true,
    });
    expect(lastRequest?.body.params.arguments.hook_bundle.force_resync).toBeUndefined();
    expect(cursorFor(sid)).toEqual({
      generation: "host-a:3",
      glance: newGlance,
      glanceObservedAt: newObservedAt,
    });
  });

  it("marks a fresh glance cache explicitly and keeps it on an inbox-only fold", async () => {
    const sid = "sid-fresh-glance";
    const glance = { display: { title: "fresh title", notice: null } };
    const glanceObservedAt = new Date().toISOString();
    fs.writeFileSync(
      join(cache, `activity-hook-bundle-${sid}.json`),
      JSON.stringify({ generation: "host-a:2", glance, glanceObservedAt }),
    );
    nextResult = {
      ok: true,
      id: 33,
      hook_bundle: {
        schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA,
        generation: "host-a:3",
        changed: true,
        complete: true,
        provenance: { observedAt: new Date().toISOString() },
        surfaces: { inbox: { entries: [], summary: { newest_ts: null } } },
      },
    };

    const r = await run(sid);
    expect(r.status).toBe(0);
    expect(lastRequest?.body.params.arguments.hook_bundle).toEqual({
      generation: "host-a:2",
      glance_stale: false,
    });
    expect(cursorFor(sid)).toEqual({ generation: "host-a:3", glance, glanceObservedAt });
  });

  it("quiet fold with an empty inbox still surfaces the P-015 context gauge", async () => {
    const sid = "sid-gauge";
    fs.writeFileSync(
      join(cache, `activity-hook-bundle-${sid}.json`),
      JSON.stringify({ generation: "host-a:2" }),
    );
    nextResult = {
      ok: true,
      id: 4,
      hook_bundle: {
        schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA,
        generation: "host-a:3",
        changed: true,
        complete: true,
        surfaces: {
          inbox: {
            entries: [],
            injection: "",
            summary: { newest_ts: null },
            context_gauge: "⚠ context 82%",
          },
        },
      },
    };
    const r = await run(sid);
    expect(JSON.parse(r.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "⚠ context 82%",
      },
    });
    const cur = cursorFor(sid);
    expect(cur).toEqual({ generation: "host-a:3" });
  });

  it("an INCOMPLETE fold (partial hydrate failure) resets generation to null so the next call retries fully", async () => {
    const sid = "sid-incomplete";
    const glance = { display: { title: "stale but usable", notice: null } };
    const glanceObservedAt = "2000-01-01T00:00:00.000Z";
    fs.writeFileSync(
      join(cache, `activity-hook-bundle-${sid}.json`),
      JSON.stringify({ generation: "host-a:2", glance, glanceObservedAt }),
    );
    nextResult = {
      ok: true,
      id: 5,
      hook_bundle: {
        schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA,
        generation: "host-a:3",
        changed: true,
        complete: false, // glance hydrate failed server-side; inbox may still be present
        surfaces: {
          inbox: { entries: [], injection: "", summary: { newest_ts: null } },
        },
      },
    };
    const r = await run(sid);
    expect(r.status).toBe(0);
    const cur = cursorFor(sid);
    expect(cur).toEqual({ generation: null, glance, glanceObservedAt });
  });

  it("a response with no usable hook_bundle (server predates the fold) never advances the cursor", async () => {
    const sid = "sid-nobundle";
    fs.writeFileSync(
      join(cache, `activity-hook-bundle-${sid}.json`),
      JSON.stringify({ generation: "host-a:2" }),
    );
    nextResult = { ok: true, id: 6 }; // no hook_bundle field at all
    const r = await run(sid);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const cur = cursorFor(sid);
    expect(cur).toEqual({ generation: "host-a:2" }); // held, not clobbered
  });
});
