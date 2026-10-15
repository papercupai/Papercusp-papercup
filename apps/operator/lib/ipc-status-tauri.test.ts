import { describe, expect, it } from "vitest";
import { ipcOwnsContentOrigin, type IpcStatusRead } from "./ipc-status-tauri";

function status(ownerIsContentOrigin: boolean): IpcStatusRead {
  return {
    kind: "ok",
    status: {
      resolvedPath: "/run/user/1000/papercusp.sock",
      resolutionDetail: "test",
      client: "connected",
      attempts: 1,
      reuses: 0,
      resolveMisses: 0,
      connectErrors: 0,
      connects: 1,
      invokes: 1,
      msSinceLastAttempt: 0,
      msSinceLastConnect: 0,
      lastError: null,
      connectedPath: "/run/user/1000/papercusp.sock",
      ownerIsContentOrigin,
      snapshotStartedAtUnixMs: 1_700_000_000_000,
      snapshotDurationMs: 0.5,
    },
  };
}

describe("ipcOwnsContentOrigin", () => {
  it("accepts only the shell's positive structured ownership proof", () => {
    expect(ipcOwnsContentOrigin(status(true))).toBe(true);
    expect(ipcOwnsContentOrigin(status(false))).toBe(false);
  });

  it("fails closed for browser and command-error readings", () => {
    expect(ipcOwnsContentOrigin({ kind: "unavailable" })).toBe(false);
    expect(
      ipcOwnsContentOrigin({ kind: "error", error: "command denied" }),
    ).toBe(false);
  });
});
