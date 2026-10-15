/**
 * WI-10006049 — the 1M default survives Claude Code's bare `/model` menu, for every 1M-capable
 * family (owner Avi 2026-10-05 #1369 "if the default is 1m that sounds good", #1371 "make sure
 * this works for all claude models too not just opus").
 *
 * The defect: a session launched WITHOUT `--model` reads its model from its isolated
 * CLAUDE_CONFIG_DIR/settings.json, and carry-respawns reuse that dir. On Claude Code 2.1.289 the
 * bare menu saves the 200k pick (`"model": "opus"` — measured in su-56e2f83b's dir), so every
 * respawn came back at 200k. normalizeSessionSettingsModel runs before each launch and respawn and
 * upgrades the saved pick to the same family's `[1m]` twin; haiku and pinned 4.x ids are untouched.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeSessionSettingsModel,
  normalizeSessionSettingsModelForLaunch,
} from "../scripts/psu-launcher.mjs";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A session config dir (with settings.json) plus a fake HOME carrying a global settings.json. */
function fixture(session: Record<string, unknown> | null, global: Record<string, unknown> | null = null) {
  const root = mkdtempSync(join(tmpdir(), "psu-session-model-"));
  dirs.push(root);
  const configDir = join(root, "session");
  const home = join(root, "home");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  if (session) writeFileSync(join(configDir, "settings.json"), JSON.stringify(session, null, 2));
  if (global) writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(global, null, 2));
  const read = () => JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
  return { configDir, home, read };
}

describe("normalizeSessionSettingsModel — every 1M-capable family gets its [1m] twin", () => {
  it.each([
    ["opus", "opus[1m]"],
    ["sonnet", "sonnet[1m]"],
    ["fable", "fable[1m]"],
    ["opusplan", "opusplan[1m]"],
    ["claude-opus-5-5", "claude-opus-5-5[1m]"],
    ["claude-sonnet-5-5", "claude-sonnet-5-5[1m]"],
    ["claude-fable-5-1", "claude-fable-5-1[1m]"],
  ])("a saved %s menu pick becomes %s", (saved, expected) => {
    const f = fixture({ model: saved, effortLevel: "high", permissions: { defaultMode: "bypassPermissions" } });
    expect(normalizeSessionSettingsModel(f.configDir, { home: f.home })).toEqual({ from: saved, to: expected });
    // Only the model changes; every other key the session settings carry is preserved.
    expect(f.read()).toEqual({ model: expected, effortLevel: "high", permissions: { defaultMode: "bypassPermissions" } });
  });

  it.each(["haiku", "claude-haiku-4-5", "claude-opus-4-1", "claude-sonnet-4-6", "opus[1m]", "sonnet[1m]", "fable[1m]"])(
    "%s is left exactly as it is (no 1M version, a pinned 4.x id, or already 1M)",
    (saved) => {
      const f = fixture({ model: saved });
      const before = readFileSync(join(f.configDir, "settings.json"), "utf8");
      expect(normalizeSessionSettingsModel(f.configDir, { home: f.home })).toBeNull();
      expect(readFileSync(join(f.configDir, "settings.json"), "utf8")).toBe(before);
    },
  );

  it("a missing model key (the menu's Default) is restored to the global model, normalized", () => {
    const f = fixture({ effortLevel: "high" }, { model: "opus" });
    expect(normalizeSessionSettingsModel(f.configDir, { home: f.home })).toEqual({ from: null, to: "opus[1m]" });
    expect(f.read()).toEqual({ effortLevel: "high", model: "opus[1m]" });
  });

  it("a missing key with no usable global model is left alone", () => {
    const noGlobal = fixture({ effortLevel: "high" });
    expect(normalizeSessionSettingsModel(noGlobal.configDir, { home: noGlobal.home })).toBeNull();
    const haikuGlobal = fixture({}, { model: "haiku" });
    expect(normalizeSessionSettingsModel(haikuGlobal.configDir, { home: haikuGlobal.home })).toBeNull();
  });

  it("fails soft: no dir, no settings file, unparseable or non-object settings ⇒ null, file untouched", () => {
    expect(normalizeSessionSettingsModel(null)).toBeNull();
    const missing = fixture(null);
    expect(normalizeSessionSettingsModel(missing.configDir, { home: missing.home })).toBeNull();
    const broken = fixture(null);
    writeFileSync(join(broken.configDir, "settings.json"), "{not json");
    expect(normalizeSessionSettingsModel(broken.configDir, { home: broken.home })).toBeNull();
    expect(readFileSync(join(broken.configDir, "settings.json"), "utf8")).toBe("{not json");
    const arr = fixture(null);
    writeFileSync(join(arr.configDir, "settings.json"), "[]");
    expect(normalizeSessionSettingsModel(arr.configDir, { home: arr.home })).toBeNull();
  });
});

describe("normalizeSessionSettingsModelForLaunch — only a model-less Claude launch reads settings", () => {
  const sessionArgs = ["--session-id", "00000000-0000-4000-8000-000000000001", "--system-prompt-file", "/x.md"];

  it("su-56e2f83b replay: model-less claude respawn with a saved `opus` pick ⇒ opus[1m]", () => {
    const f = fixture({ model: "opus" });
    expect(
      normalizeSessionSettingsModelForLaunch(sessionArgs, { agent: "claude", configDir: f.configDir, home: f.home }),
    ).toEqual({ from: "opus", to: "opus[1m]" });
    expect(f.read().model).toBe("opus[1m]");
  });

  it("an unset agent is the claude argv shape (the host leaves PAPERCUSP_AGENT unset on some launches)", () => {
    const f = fixture({ model: "sonnet" });
    expect(normalizeSessionSettingsModelForLaunch(sessionArgs, { configDir: f.configDir, home: f.home })).toEqual({
      from: "sonnet",
      to: "sonnet[1m]",
    });
  });

  it("an explicit --model wins over settings, so settings are not touched", () => {
    for (const args of [
      [...sessionArgs, "--model", "opus[1m]"],
      [...sessionArgs, "--model=fable[1m]"],
    ]) {
      const f = fixture({ model: "opus" });
      expect(normalizeSessionSettingsModelForLaunch(args, { agent: "claude", configDir: f.configDir, home: f.home })).toBeNull();
      expect(f.read().model).toBe("opus");
    }
  });

  it("codex and omp launches are never touched", () => {
    for (const agent of ["codex", "omp"]) {
      const f = fixture({ model: "opus" });
      expect(normalizeSessionSettingsModelForLaunch(sessionArgs, { agent, configDir: f.configDir, home: f.home })).toBeNull();
      expect(f.read().model).toBe("opus");
    }
  });
});
