// EI-23076695727837648 — a carry-respawn that ADOPTS fresh host code must hand its
// first turn to the launcher successor. The in-process respawn injects carryText
// after spawn; an adopting predecessor exits first, so before this fix the
// successor booted on the carry document and idled until an unrelated loop fire or
// wake (measured 3-48 min on 11 of 11 adoptions of one goal holder, 2026-10-01/02).
import { describe, it, expect } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handoffFirstTurnText } from "../scripts/psu-launcher.mjs";
import { writeHostHandoff, readHostHandoff } from "../scripts/psu-pty-host.mjs";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const hostSrc = read("../scripts/psu-pty-host.mjs");
const launcherSrc = read("../scripts/psu-launcher.mjs");

describe("EI-23076695727837648: an adopting carry-respawn hands its first turn to the successor", () => {
  it("handoffFirstTurnText returns the text verbatim, or null for a handoff from an older host", () => {
    const text = "⟦turn-origin:self-compaction nonce:abc⟧\nContinue where you left off";
    expect(handoffFirstTurnText({ firstTurnText: text })).toBe(text);
    expect(handoffFirstTurnText({})).toBeNull();
    expect(handoffFirstTurnText({ firstTurnText: "" })).toBeNull();
    expect(handoffFirstTurnText({ firstTurnText: 42 })).toBeNull();
    expect(handoffFirstTurnText(null)).toBeNull();
  });

  it("firstTurnText survives the on-disk handoff round trip", () => {
    const owner = `su-test-adopt-first-turn-${process.pid}-${Date.now()}`;
    const p = writeHostHandoff(owner, { mode: "carry-respawn", args: ["--x"], firstTurnText: "first turn" });
    try {
      expect(p).toBeTruthy();
      const rec = readHostHandoff(owner, { isAlive: () => false });
      expect(rec?.firstTurnText).toBe("first turn");
      expect(handoffFirstTurnText(rec)).toBe("first turn");
    } finally {
      if (p) rmSync(p, { force: true });
    }
  });

  it("the adopting branch writes firstTurnText from carryText into its handoff", () => {
    const at = hostSrc.indexOf("appendHostEvent(ownerId, 'host-code-adopting'");
    expect(at).toBeGreaterThan(0);
    const writeAt = hostSrc.lastIndexOf("const handoffPath = writeHostHandoff(ownerId, {", at);
    expect(writeAt).toBeGreaterThan(0);
    expect(hostSrc.slice(writeAt, at)).toMatch(/firstTurnText:\s*typeof carryText === 'string'/);
  });

  it("the launcher successor seeds the handoff's first turn instead of dropping it", () => {
    const at = launcherSrc.indexOf("args = hostHandoff.args;");
    expect(at).toBeGreaterThan(0);
    const end = launcherSrc.indexOf("kickoffFile = null;", at);
    expect(end).toBeGreaterThan(at);
    const branch = launcherSrc.slice(at, end);
    expect(branch).toMatch(/kickoff = handoffFirstTurnText\(hostHandoff\);/);
    expect(branch).not.toMatch(/\n\s*kickoff = null;/);
  });

  it("records the front-controller outcome before an adopting re-exec can return early", () => {
    const mainAt = launcherSrc.indexOf("async function main()");
    const startedAt = launcherSrc.indexOf(
      '"host-code-adoption-front-controller-started"',
      mainAt,
    );
    const finishedAt = launcherSrc.indexOf(
      '"host-code-adoption-front-controller-finished"',
      startedAt,
    );
    const handledAt = launcherSrc.indexOf("if (connection.handled)", finishedAt);
    expect(mainAt).toBeGreaterThanOrEqual(0);
    expect(startedAt).toBeGreaterThan(mainAt);
    expect(finishedAt).toBeGreaterThan(startedAt);
    expect(handledAt).toBeGreaterThan(finishedAt);
    expect(launcherSrc.slice(startedAt, handledAt)).toMatch(/argsCount: rawArgv\.length/);
    expect(launcherSrc.slice(finishedAt, handledAt)).toMatch(/handled: connection\.handled === true/);
    expect(launcherSrc.slice(startedAt, handledAt)).toMatch(/host-code-adoption-front-controller-failed/);
  });

  it("records whether the parent-pid handoff contained first-turn text", () => {
    const mainAt = launcherSrc.indexOf("async function main()");
    const readAt = launcherSrc.indexOf("readHostHandoffForParentPid(process.ppid", mainAt);
    const eventAt = launcherSrc.indexOf('"host-code-adoption-handoff-acceptance"', readAt);
    const launchAt = launcherSrc.indexOf("await launchHostHandoff(hostHandoff)", eventAt);
    expect(readAt).toBeGreaterThan(mainAt);
    expect(eventAt).toBeGreaterThan(readAt);
    expect(launchAt).toBeGreaterThan(eventAt);
    // WI-6554700010008431: a refused handoff is consumed; the read must name why,
    // keyed by the handoff's own owner so a shim with no PAPERCUSP_SID still logs.
    const readStage = launcherSrc.slice(readAt, eventAt);
    expect(readStage).toMatch(/ownerId: adoptionEventOwnerId/);
    expect(readStage).toMatch(/onReject:/);
    expect(readStage).toMatch(/"host-code-adoption-handoff-rejected"/);
    expect(readStage).toMatch(/rejection\?\.ownerId \|\| adoptionEventOwnerId/);
    // The fallback owner still starts from the env SID, then widens to the
    // shim's `--owner-id=` (headless fleet shims carry no PAPERCUSP_SID).
    const fallbackAt = launcherSrc.lastIndexOf("const adoptionEventOwnerId =", readAt);
    expect(fallbackAt).toBeGreaterThan(mainAt);
    expect(launcherSrc.slice(fallbackAt, readAt)).toMatch(
      /const adoptionEventOwnerId = adoptionOwnerId \|\| args\.ownerId \|\| null;/,
    );
    const stage = launcherSrc.slice(eventAt, launchAt);
    expect(stage).toMatch(/accepted: Boolean\(hostHandoff\)/);
    expect(stage).toMatch(/firstTurnPresent:/);
    expect(stage).toMatch(/firstTurnBytes:/);
    expect(stage).toMatch(/argsCount:/);
    expect(stage).not.toMatch(/firstTurnText:\s*firstTurnText/);
  });

  it("names a refused owner-keyed handoff before the ordinary launch proceeds (WI-6554700010008431)", () => {
    const readAt = launcherSrc.indexOf("readHostHandoff(ownerId, {");
    const adoptAt = launcherSrc.indexOf("if (hostHandoff) {", readAt);
    expect(readAt).toBeGreaterThan(0);
    expect(adoptAt).toBeGreaterThan(readAt);
    const stage = launcherSrc.slice(readAt, adoptAt);
    expect(stage).toMatch(/onReject:/);
    expect(stage).toMatch(/"host-code-adoption-handoff-rejected"/);
    expect(stage).toMatch(/site: "owner-keyed"/);
  });

  it("records the final kickoff and managed-pty decision before spawning the adopted child", () => {
    const kickoffAt = launcherSrc.indexOf("kickoff = handoffFirstTurnText(hostHandoff);");
    const eventAt = launcherSrc.indexOf('"host-code-adoption-launch-prepared"', kickoffAt);
    const spawnAt = launcherSrc.indexOf("hostThroughPty({", eventAt);
    expect(kickoffAt).toBeGreaterThan(0);
    expect(eventAt).toBeGreaterThan(kickoffAt);
    expect(spawnAt).toBeGreaterThan(eventAt);
    const stage = launcherSrc.slice(eventAt, spawnAt);
    expect(stage).toMatch(/firstTurnPresent:/);
    expect(stage).toMatch(/kickoffPresent:/);
    expect(stage).toMatch(/kickoffBytes:/);
    expect(stage).toMatch(/argsCount:/);
    expect(stage).toMatch(/managedPtyEnabled/);
    expect(stage).not.toMatch(/kickoff:\s*kickoff/);
  });

  it("records child-start proof fields only after the PTY child was spawned", () => {
    const eventAt = hostSrc.indexOf(
      "appendHostEvent(ownerId, 'host-code-adoption-child-started'",
    );
    const spawnAt = hostSrc.lastIndexOf("child = spawnChild();", eventAt);
    expect(spawnAt).toBeGreaterThan(0);
    expect(eventAt).toBeGreaterThan(spawnAt);
    const endAt = hostSrc.indexOf("\n  }", eventAt);
    const stage = hostSrc.slice(eventAt, endAt);
    expect(stage).toMatch(/kickoffPresent:/);
    expect(stage).toMatch(/kickoffBytes:/);
    expect(stage).toMatch(/argsCount:/);
    expect(stage).toMatch(/kickoffFilePresent:/);
    expect(stage).not.toMatch(/kickoff:\s*kickoff/);
  });
});
