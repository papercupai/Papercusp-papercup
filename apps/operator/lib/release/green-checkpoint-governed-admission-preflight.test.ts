// WI-6554700010018689: the green-checkpoint probes its governed-admission target before
// setupTree, so a wrong target (run 63b14b89: 28P01 on every affected-test task, ~55 min
// in, zero tests judged) ends the run in seconds as a no-verdict instead.
import { describe, expect, it, vi } from "vitest";
import {
  classifyGovernedAdmissionProbeError,
  preflightGovernedAdmissionTarget,
  redactDatabaseUrl,
} from "./governed-admission-preflight";

const TARGET = "postgresql://harness_admin:s3cr%40t@localhost:5432/papercusp";

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("preflightGovernedAdmissionTarget (WI-6554700010018689)", () => {
  it("passes the target that answers select 1, probing the exact URL it was handed", async () => {
    const probe = vi.fn(async () => {});
    const result = await preflightGovernedAdmissionTarget(TARGET, probe);
    expect(probe).toHaveBeenCalledWith(TARGET);
    expect(result).toMatchObject({
      ok: true,
      probed: true,
      target: "harness_admin@localhost:5432/papercusp",
    });
  });

  it("refuses a target that rejects the credentials (28P01) with the auth reason", async () => {
    const result = await preflightGovernedAdmissionTarget(TARGET, async () => {
      throw pgError("28P01", 'password authentication failed for user "harness_admin"');
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "admission-target-auth",
      code: "28P01",
      target: "harness_admin@localhost:5432/papercusp",
    });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.summary).toContain("NO verdict");
    expect(result.summary).toContain("28P01");
  });

  it("refuses an unreachable target with the unreachable reason", async () => {
    const result = await preflightGovernedAdmissionTarget(TARGET, async () => {
      throw pgError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:18058");
    });
    expect(result).toMatchObject({ ok: false, reason: "admission-target-unreachable" });
  });

  it("refuses a target that never answers, at the deadline, without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let rejectLate: (error: Error) => void = () => {};
      const result = await preflightGovernedAdmissionTarget(
        TARGET,
        () =>
          new Promise<void>((_, reject) => {
            rejectLate = reject;
          }),
        { timeoutMs: 20 },
      );
      expect(result).toMatchObject({
        ok: false,
        reason: "admission-target-unreachable",
        code: "PREFLIGHT_TIMEOUT",
      });
      // The losing probe rejects after the verdict was rendered; that must stay handled.
      rejectLate(pgError("CONNECT_TIMEOUT", "write CONNECT_TIMEOUT"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("never throws, even when the probe throws synchronously", async () => {
    const result = await preflightGovernedAdmissionTarget(TARGET, () => {
      throw new Error("db-org import failed");
    });
    expect(result).toMatchObject({ ok: false, reason: "admission-target-error", code: null });
  });

  it("does not probe, and does not refuse, when no admission target is set", async () => {
    const probe = vi.fn(async () => {});
    for (const unset of [undefined, null, "", "   "]) {
      const result = await preflightGovernedAdmissionTarget(unset, probe);
      expect(result).toMatchObject({ ok: true, probed: false, target: null });
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it("never leaks the password into the refusal, even when the error text quotes the URL", async () => {
    const result = await preflightGovernedAdmissionTarget(TARGET, async () => {
      throw pgError("3D000", `database does not exist at ${TARGET} (password s3cr@t)`);
    });
    expect(result).toMatchObject({ ok: false, reason: "admission-target-error", code: "3D000" });
    expect(result.summary).not.toContain("s3cr");
    expect(result.summary).not.toContain(TARGET);
  });
});

describe("governed-admission preflight helpers", () => {
  it("redacts the password and defaults the port", () => {
    expect(redactDatabaseUrl("postgres://u:pw@db.example:6432/papercusp")).toBe(
      "u@db.example:6432/papercusp",
    );
    expect(redactDatabaseUrl("postgres://u:pw@db.example/papercusp")).toBe(
      "u@db.example:5432/papercusp",
    );
    expect(redactDatabaseUrl("not a url")).toBe("<unparseable database url>");
  });

  it("classifies auth, unreachable and other probe failures", () => {
    expect(classifyGovernedAdmissionProbeError(pgError("28000", "x"))).toBe("admission-target-auth");
    expect(classifyGovernedAdmissionProbeError(pgError("ENOTFOUND", "x"))).toBe(
      "admission-target-unreachable",
    );
    expect(classifyGovernedAdmissionProbeError(pgError("42P01", "x"))).toBe("admission-target-error");
    expect(classifyGovernedAdmissionProbeError("boom")).toBe("admission-target-error");
  });
});
