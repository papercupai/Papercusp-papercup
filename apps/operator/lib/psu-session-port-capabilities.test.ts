/**
 * WI-6554700010011137 (owner directive #1810): `psu --resume` on a Codex session
 * offered "Port to claude", and the pick failed with
 *   psu: POST /api/adv/sessions/port/inspect (HTTP 400) — V1 targetBackend must be codex|omp
 *
 * Root cause: the staging launcher (consult-backed-parking-2026-10-12 P-011)
 * offers every backend pair, but the serving operator (main d740fc3802) only
 * ports claude → codex|omp. Both speak session-port protocol 2 / transform 4,
 * so the version handshake cannot see the difference, and
 * sessionPortUpgradeError only recognised 404/426 skew — the owner got a raw
 * 400 after choosing a target the server could never accept.
 *
 * Pinned here: the launcher learns the serving operator's pairs BEFORE the
 * picker (GET /port/capabilities, or — for operators older than that route —
 * the side-effect-free targetBackend refusal), hides targets it cannot port to
 * with a one-line reason, and still turns a pair refusal into an actionable
 * message if one gets through.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SESSION_PORT_BACKENDS,
  SESSION_PORT_SUPPORTED_PAIRS,
} from "../../../packages/operator-core/lib/session-port/types";
import {
  SESSION_PORT_PROTOCOL_VERSION,
  SESSION_PORT_TRANSFORM_VERSION,
  fetchSessionPortCapabilities,
  resumePickerBackendsFor,
  sessionPortPairSupported,
  sessionPortPairsFromTargetRefusal,
  sessionPortUpgradeError,
  unsupportedSessionPortTargetsNotice,
} from "../scripts/psu-launcher.mjs";

/** The exact text the owner saw: api()'s failure format around main d740fc3802's refusal. */
const D740_REFUSAL =
  "psu: POST /api/adv/sessions/port/inspect (HTTP 400) — V1 targetBackend must be codex|omp";
const LEGACY_PAIRS = [
  { source: "claude", target: "codex" },
  { source: "claude", target: "omp" },
];

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

const session = (agent: string) => ({ id: 42, agent, role: null });

const sortPairs = (pairs: Array<{ source: string; target: string }>) =>
  pairs.map((p) => `${p.source}->${p.target}`).sort();

describe("sessionPortPairsFromTargetRefusal", () => {
  it("reads main d740fc3802's V1 refusal as claude → codex|omp only", () => {
    expect(sessionPortPairsFromTargetRefusal(D740_REFUSAL)).toEqual(LEGACY_PAIRS);
  });

  it("agrees with the CURRENT operator: its own refusal text parses back to exactly the pairs it advertises", () => {
    // The server builds this message from SESSION_PORT_BACKENDS; if either side
    // drifts, the legacy fallback would misreport a newer operator's pairs.
    const serverRefusal = `psu: POST /api/adv/sessions/port/inspect (HTTP 400) — targetBackend must be ${SESSION_PORT_BACKENDS.join("|")}`;
    expect(sortPairs(sessionPortPairsFromTargetRefusal(serverRefusal) ?? [])).toEqual(
      sortPairs([...SESSION_PORT_SUPPORTED_PAIRS]),
    );
  });

  it("returns null for anything that is not a targetBackend refusal", () => {
    expect(sessionPortPairsFromTargetRefusal("sourceAdvSessionId must be a positive integer")).toBeNull();
    expect(sessionPortPairsFromTargetRefusal("targetBackend must be gemini")).toBeNull();
    expect(sessionPortPairsFromTargetRefusal(undefined)).toBeNull();
  });
});

describe("fetchSessionPortCapabilities", () => {
  it("uses the advertised pairs when the operator has the capabilities route", async () => {
    const apiImpl = vi.fn(async () => ({ ok: true, pairs: SESSION_PORT_SUPPORTED_PAIRS }));
    await expect(fetchSessionPortCapabilities({ apiImpl })).resolves.toEqual({
      known: true,
      via: "capabilities",
      pairs: SESSION_PORT_SUPPORTED_PAIRS,
    });
    expect(apiImpl).toHaveBeenCalledTimes(1);
    expect(apiImpl).toHaveBeenCalledWith("/api/adv/sessions/port/capabilities", { method: "GET" });
  });

  it("falls back to a side-effect-free inspect probe on an operator older than the route (404)", async () => {
    const apiImpl = vi
      .fn()
      .mockRejectedValueOnce(httpError(404, "psu: GET /api/adv/sessions/port/capabilities (HTTP 404) — not found"))
      .mockRejectedValueOnce(httpError(400, D740_REFUSAL));

    await expect(fetchSessionPortCapabilities({ apiImpl })).resolves.toEqual({
      known: true,
      via: "legacy-refusal",
      pairs: LEGACY_PAIRS,
    });
    expect(apiImpl).toHaveBeenCalledTimes(2);
    const [path, opts] = apiImpl.mock.calls[1];
    expect(path).toBe("/api/adv/sessions/port/inspect");
    // The probe must clear the protocol (426) and source-id checks so the
    // operator answers at the targetBackend validator — before any session read.
    expect(JSON.parse(opts.body)).toEqual({
      protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
      transformVersion: SESSION_PORT_TRANSFORM_VERSION,
      sourceAdvSessionId: 1,
      targetBackend: "__psu_capability_probe__",
    });
  });

  it("reports unknown (filters nothing) when the operator is unreachable — no probe is sent", async () => {
    const apiImpl = vi.fn().mockRejectedValueOnce(httpError(502, "operator down"));
    await expect(fetchSessionPortCapabilities({ apiImpl })).resolves.toMatchObject({ known: false });
    expect(apiImpl).toHaveBeenCalledTimes(1);
  });

  it("reports unknown when the legacy probe answers with something other than a pair refusal", async () => {
    const apiImpl = vi
      .fn()
      .mockRejectedValueOnce(httpError(404, "not found"))
      .mockRejectedValueOnce(httpError(426, "unsupported session-port protocol/transform 2/4"));
    await expect(fetchSessionPortCapabilities({ apiImpl })).resolves.toMatchObject({ known: false });
  });
});

describe("resume picker filtered by the serving operator's pairs", () => {
  const legacy = { known: true, via: "legacy-refusal", pairs: LEGACY_PAIRS };

  it("offers a Codex source only its native backend when the operator cannot port codex anywhere (the owner's case)", () => {
    expect(resumePickerBackendsFor(session("codex"), legacy)).toEqual(["codex"]);
  });

  it("keeps every target the operator does port, native first", () => {
    const backends = resumePickerBackendsFor(session("claude"), legacy);
    expect(backends[0]).toBe("claude");
    expect([...backends].sort()).toEqual(["claude", "codex", "omp"]);
  });

  it("offers codex → claude against an operator that advertises it", () => {
    const current = { known: true, via: "capabilities", pairs: [...SESSION_PORT_SUPPORTED_PAIRS] };
    expect(resumePickerBackendsFor(session("codex"), current)).toContain("claude");
    expect(sessionPortPairSupported(current, "codex", "claude")).toBe(true);
  });

  it("CONTROL: unknown capabilities filter nothing — the server refusal stays the backstop", () => {
    expect([...resumePickerBackendsFor(session("codex"), { known: false })].sort()).toEqual([
      "claude",
      "codex",
      "omp",
    ]);
    expect([...resumePickerBackendsFor(session("codex"))].sort()).toEqual(["claude", "codex", "omp"]);
  });

  it("says which targets it hid and why, naming the operator", () => {
    const notice = unsupportedSessionPortTargetsNotice(session("codex"), legacy, "http://127.0.0.1:9071");
    expect(notice).toContain("claude");
    expect(notice).toContain("omp");
    expect(notice).toContain("http://127.0.0.1:9071");
    expect(notice).toMatch(/older than this psu launcher/);
    expect(unsupportedSessionPortTargetsNotice(session("claude"), legacy)).toBeNull();
    expect(unsupportedSessionPortTargetsNotice(session("codex"), { known: false })).toBeNull();
  });

  it("is wired into the interactive picker (chooseResumeTarget)", () => {
    const source = readFileSync(join(__dirname, "..", "scripts", "psu-launcher.mjs"), "utf8");
    const start = source.indexOf("async function chooseResumeTarget(");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = source.slice(start);
    // The fetch is an injectable seam (psu-resume-cross-backend drives it); the
    // production default must remain the real operator capability read.
    const seams = body.slice(0, body.indexOf("} = {}) {"));
    expect(seams).toMatch(/fetchPortCapabilities = fetchSessionPortCapabilities,/);
    expect(body).toContain("await fetchPortCapabilities()");
    expect(body).toContain("resumePickerBackendsFor(session, portCapabilities)");
  });
});

describe("sessionPortUpgradeError — a pair refusal that still gets through", () => {
  it("turns the raw d740 400 into an actionable launcher-newer-than-operator message", () => {
    const mapped = sessionPortUpgradeError(httpError(400, D740_REFUSAL)).message;
    expect(mapped).toContain("only ports claude→codex, claude→omp");
    expect(mapped).toMatch(/newer than the operator/);
    expect(mapped).toContain("V1 targetBackend must be codex|omp");
  });

  it("CONTROL: leaves unrelated 400s untouched", () => {
    expect(sessionPortUpgradeError(httpError(400, "contextSize: unknown size")).message).toBe(
      "contextSize: unknown size",
    );
  });
});
