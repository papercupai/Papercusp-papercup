/**
 * WI-6554700010030031 — an in-place context reset (`/clear`) rotates a Claude
 * child's native id while the SAME child keeps presenting the id it was launched
 * with (its papercusp-su MCP header carries PAPERCUSP_NATIVE_SESSION_ID). The
 * reset report must carry that launch id so the operator keeps it as an accepted
 * alias; every other respawn report (a NEW process) must omit it so the operator
 * clears any stale alias.
 *
 * Kept out of psu-launcher.test.ts on purpose: peers' bound spec evidence
 * fingerprints that file, and an unrelated edit would stale their proofs.
 */
import { describe, expect, it, vi } from "vitest";
import * as launcher from "../scripts/psu-launcher.mjs";

// The .mjs option defaults are `= null`, which TypeScript infers as type `null`;
// a loose signature lets the test pass real values without editing the launcher.
type Reporter = (advSessionId: string, sessionId: string, opts: Record<string, unknown>) => Promise<unknown>;
const reportSessionRespawned = launcher.reportSessionRespawned as unknown as Reporter;
const reportSessionRespawnedDurably = launcher.reportSessionRespawnedDurably as unknown as Reporter;

const LAUNCH_ID = "6e4a2d87-3500-44ff-bcae-49d97851d3d3";
const FRESH_ID = "1d70c364-c3dd-4dc0-a014-2bbfdd4ccd3f";
const NEWER_ID = "2e81d475-d4ee-4ed1-b125-3cceee5dde4e";

describe("respawn reports and the child launch-id alias (WI-6554700010030031)", () => {
  it("an in-place reset report carries the child's launch id; a plain respawn report does not", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = async (_url: string, opts: { body: string }) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true };
    };
    await reportSessionRespawned("42", FRESH_ID, {
      childLaunchSessionId: LAUNCH_ID,
      fetchImpl,
      operatorUrl: "http://op:1",
      token: "t",
    });
    await reportSessionRespawned("42", FRESH_ID, {
      fetchImpl,
      operatorUrl: "http://op:1",
      token: "t",
    });
    expect(bodies).toEqual([
      { advSessionId: 42, childLaunchSessionId: LAUNCH_ID, sessionId: FRESH_ID },
      { advSessionId: 42, sessionId: FRESH_ID },
    ]);
  });

  it("the durable reporter forwards the launch id only when it was supplied", async () => {
    const reportImpl = vi.fn(async () => true);
    const sleepImpl = () => new Promise<void>(() => {});
    await reportSessionRespawnedDurably("42", FRESH_ID, {
      coordOwnerId: "su-owner",
      childLaunchSessionId: LAUNCH_ID,
      reportImpl,
      sleepImpl,
    });
    await reportSessionRespawnedDurably("42", NEWER_ID, {
      coordOwnerId: "su-owner",
      reportImpl,
      sleepImpl,
    });
    expect(reportImpl.mock.calls).toEqual([
      ["42", FRESH_ID, { coordOwnerId: "su-owner", childLaunchSessionId: LAUNCH_ID }],
      ["42", NEWER_ID, { coordOwnerId: "su-owner" }],
    ]);
  });
});
