// WI-6554700010018666: the green-checkpoint suite env is a DSN-free allowlist, so the
// governed-admission client inside scripts/affected-tests.mjs fell through to the
// discovery file (the installed Papercusp Server's cluster on :18058). Every
// affected-test task then failed admission with 28P01 and zero tests ran. The gate now
// hands ONLY the admission client an explicit operator target.
import { describe, expect, it } from "vitest";
import { GOVERNED_ADMISSION_DATABASE_URL_ENV as GOVERNOR_KEY } from "@papercusp/operator-core/lib/resource-governor/execution";
import {
  buildGreenCheckpointEnv,
  GOVERNED_ADMISSION_DATABASE_URL_ENV,
} from "./green-checkpoint";

const OPERATOR_URL = "postgresql://harness_admin:secret@localhost:5432/papercusp";
const BASE_SOURCE = { PATH: "/usr/bin", HOME: "/home/x" } as const;

describe("buildGreenCheckpointEnv governed-admission target (WI-6554700010018666)", () => {
  it("uses the same key the governed-admission client reads", () => {
    expect(GOVERNED_ADMISSION_DATABASE_URL_ENV).toBe(GOVERNOR_KEY);
  });

  it("hands the gate's admin DSN to the admission key while the suite stays DSN-free", () => {
    const env = buildGreenCheckpointEnv(null, {
      ...BASE_SOURCE,
      HARNESS_ADMIN_DATABASE_URL: OPERATOR_URL,
      DATABASE_URL: "postgresql://other@localhost:5432/papercusp",
    });
    expect(env[GOVERNED_ADMISSION_DATABASE_URL_ENV]).toBe(OPERATOR_URL);
    expect(env.HARNESS_ADMIN_DATABASE_URL).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.HARNESS_DATABASE_URL).toBeUndefined();
  });

  it("falls back to DATABASE_URL when that is the gate's only DSN", () => {
    const env = buildGreenCheckpointEnv(null, { ...BASE_SOURCE, DATABASE_URL: OPERATOR_URL });
    expect(env[GOVERNED_ADMISSION_DATABASE_URL_ENV]).toBe(OPERATOR_URL);
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("sets no admission target when the gate itself has no DSN", () => {
    const env = buildGreenCheckpointEnv(null, { ...BASE_SOURCE });
    expect(env[GOVERNED_ADMISSION_DATABASE_URL_ENV]).toBeUndefined();
  });

  it("never forwards a host-leaked admission key; the gate's own DSN decides", () => {
    const env = buildGreenCheckpointEnv(null, {
      ...BASE_SOURCE,
      [GOVERNED_ADMISSION_DATABASE_URL_ENV]: "postgresql://leak@localhost:18058/papercusp",
    });
    expect(env[GOVERNED_ADMISSION_DATABASE_URL_ENV]).toBeUndefined();
  });
});
