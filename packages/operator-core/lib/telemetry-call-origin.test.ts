import { describe, expect, it } from "vitest";

import {
  CALL_ORIGIN_HEADER,
  CALL_ORIGIN_QUERY_PARAM,
  classifyCallOrigin,
} from "./telemetry-call-origin";

/**
 * The fixtures below are REAL `metadata_json.requestOrigin` shapes read out of
 * `harness_shared.tool_invocations` on 2026-08-12, not invented ones — the bug this module fixes
 * (EI-20267598379696870) was caused by reasoning about a population from one sample, so the
 * classifier is pinned to the measured populations it claims to separate.
 */
const CLAUDE_MODEL_CALL = {
  query: {
    tools: "coord:orient,work_items:get,dev:pg_query",
    client: "su-6ab684ac-35e9-4fd1-a992-169c86dfdda5",
    harness: "papercusp",
    profile: "engineer",
    ctx_tier: "trimmed",
    superuser: "1",
    workspace: "papercusp-workspace",
  },
  headers: { "user-agent": "claude-code/2.1.228 (cli)" },
};

const CC_HOOK_CALL = {
  query: {
    client: "su-6ab684ac-35e9-4fd1-a992-169c86dfdda5",
    format: "json",
    superuser: "1",
  },
  headers: { "user-agent": "Python-urllib/3.14" },
};

const CODEX_MODEL_CALL = {
  query: { tools: "coord:orient", superuser: "1" },
  headers: { "user-agent": "codex-mcp-client/0.147.0" },
};

const OMP_MODEL_CALL = {
  query: { agent: "omp", tools: "coord:orient", superuser: "1" },
  headers: { "user-agent": "Bun/1.3.14" },
};

const OMP_HOOK_CALL = {
  query: { superuser: "1", client: "su-a23338bf" },
  headers: { "user-agent": "Bun/1.3.14" },
};

describe("classifyCallOrigin — declaration wins", () => {
  it("takes a caller-declared agent origin from the query param", () => {
    expect(
      classifyCallOrigin({ requestOrigin: { query: { [CALL_ORIGIN_QUERY_PARAM]: "agent" } } }),
    ).toEqual({ origin: "agent", source: "declared" });
  });

  it("takes the caller's declared origin from the query param", () => {
    expect(
      classifyCallOrigin({
        requestOrigin: {
          query: { ...CC_HOOK_CALL.query, [CALL_ORIGIN_QUERY_PARAM]: "hook" },
          headers: CC_HOOK_CALL.headers,
        },
      }),
    ).toEqual({ origin: "hook", source: "declared" });
  });

  it("takes the declared origin from the header when the url cannot carry it", () => {
    expect(
      classifyCallOrigin({
        requestOrigin: { headers: { [CALL_ORIGIN_HEADER]: "hook" } },
      }),
    ).toEqual({ origin: "hook", source: "declared" });
  });

  it("lets a declaration OVERRIDE what derivation would have concluded", () => {
    // The model-client launch params would derive `agent`; the declaration must win, or a hook
    // reusing a launch-shaped url would be silently miscounted as agent behavior.
    expect(
      classifyCallOrigin({
        requestOrigin: {
          query: { ...CLAUDE_MODEL_CALL.query, origin: "hook" },
          headers: CLAUDE_MODEL_CALL.headers,
        },
      }),
    ).toEqual({ origin: "hook", source: "declared" });
  });

  it("refuses a declaration of 'unknown' — that verdict is ours, not the caller's", () => {
    const v = classifyCallOrigin({
      requestOrigin: { query: { origin: "unknown" }, headers: {} },
    });
    expect(v.source).toBe("derived");
  });

  it("ignores an unrecognized declared value instead of storing it", () => {
    const v = classifyCallOrigin({
      requestOrigin: { query: { origin: "banana" }, headers: {} },
    });
    expect(v).toEqual({ origin: "unknown", source: "derived" });
  });

  it("accepts a declaration case-insensitively and with surrounding whitespace", () => {
    expect(
      classifyCallOrigin({ requestOrigin: { query: { origin: " HOOK " } } }),
    ).toEqual({ origin: "hook", source: "declared" });
  });
});

describe("classifyCallOrigin — derivation, on the measured populations", () => {
  it("derives agent from the psu launch shape (claude-code)", () => {
    expect(classifyCallOrigin({ requestOrigin: CLAUDE_MODEL_CALL })).toEqual({
      origin: "agent",
      source: "derived",
    });
  });

  it("derives agent for codex", () => {
    expect(classifyCallOrigin({ requestOrigin: CODEX_MODEL_CALL })).toEqual({
      origin: "agent",
      source: "derived",
    });
  });

  it("derives hook for the cc hook POST client", () => {
    expect(classifyCallOrigin({ requestOrigin: CC_HOOK_CALL })).toEqual({
      origin: "hook",
      source: "derived",
    });
  });

  it("derives ui for the desktop palette bridge", () => {
    expect(
      classifyCallOrigin({ requestOrigin: CC_HOOK_CALL, spawnId: "palette" }),
    ).toEqual({ origin: "ui", source: "derived" });
  });

  it("separates OMP model calls from OMP hook calls, which share a user-agent", () => {
    // Bun is BOTH populations, so a user-agent list alone cannot resolve OMP. The launch-shape
    // rule is what does it — and this pair is the exact case whose misreading produced the
    // retracted finding on WI-37884.
    expect(classifyCallOrigin({ requestOrigin: OMP_MODEL_CALL }).origin).toBe(
      "agent",
    );
    expect(classifyCallOrigin({ requestOrigin: OMP_HOOK_CALL }).origin).toBe(
      "unknown",
    );
  });
});

describe("classifyCallOrigin — refuses to guess", () => {
  it("returns unknown for the ambiguous `node` population rather than defaulting", () => {
    // 2,078 rows / 75 owners / 92 tool names over 3h, splitting both ways on every signal we
    // have. A default here — in EITHER direction — would recreate the original bug: a
    // classification that cannot be told apart from a real one.
    expect(
      classifyCallOrigin({
        requestOrigin: { query: { superuser: "1" }, headers: { "user-agent": "node" } },
      }),
    ).toEqual({ origin: "unknown", source: "derived" });
  });

  it("returns unknown when there is no request origin at all (in-process dispatch)", () => {
    expect(classifyCallOrigin({})).toEqual({
      origin: "unknown",
      source: "derived",
    });
    expect(classifyCallOrigin({ requestOrigin: null })).toEqual({
      origin: "unknown",
      source: "derived",
    });
  });

  it("derives system only for reserved machine markers when caller metadata is absent", () => {
    for (const spawnId of ["event-reaction", "predicate-watch", "cell-read"]) {
      expect(classifyCallOrigin({ spawnId })).toEqual({
        origin: "system",
        source: "derived",
      });
    }

    expect(classifyCallOrigin({ spawnId: "unregistered-worker" })).toEqual({
      origin: "unknown",
      source: "derived",
    });
    expect(
      classifyCallOrigin({ spawnId: "cell-read", requestOrigin: CLAUDE_MODEL_CALL }),
    ).toEqual({ origin: "agent", source: "derived" });
    expect(
      classifyCallOrigin({
        spawnId: "event-reaction",
        requestOrigin: { query: { origin: "hook" } },
      }),
    ).toEqual({ origin: "hook", source: "declared" });
  });

  it("never throws on a malformed request origin — telemetry may not fail a tool call", () => {
    const malformed = [
      { requestOrigin: { query: null, headers: null } },
      { requestOrigin: {} },
      { requestOrigin: { headers: { "user-agent": "" } } },
      { spawnId: null },
    ];
    for (const input of malformed) {
      expect(() => classifyCallOrigin(input)).not.toThrow();
      expect(classifyCallOrigin(input).source).toBe("derived");
    }
  });

  it("always reports a source, so a derived verdict can never be read as a declared one", () => {
    const all = [
      classifyCallOrigin({ requestOrigin: CLAUDE_MODEL_CALL }),
      classifyCallOrigin({ requestOrigin: CC_HOOK_CALL }),
      classifyCallOrigin({ requestOrigin: { query: { origin: "hook" } } }),
      classifyCallOrigin({}),
    ];
    for (const v of all) {
      expect(["declared", "derived"]).toContain(v.source);
      expect(["agent", "hook", "ui", "system", "unknown"]).toContain(v.origin);
    }
  });
});
