/**
 * Real pairing and per-device session authority against the maintained current-build API.
 * Opt in with PAPERCUSP_DEVICE_SESSIONS_LIVE_API and PAPERCUSP_TEST_RUN_WORKSPACE.
 * Uses one private device and a nonexistent session; never sends to or ends a real agent.
 */
import { describe, expect, it } from 'vitest';
import { measureSessionCapabilityScenario } from '../../../../test/session-capability-http-scenario';

const base = process.env.PAPERCUSP_DEVICE_SESSIONS_LIVE_API;
const workspaceId = process.env.PAPERCUSP_TEST_RUN_WORKSPACE;

describe.skipIf(!base)('paired-device sessions on the current-build API', () => {
  it('refuses every unauthorized door, serves the granted roster and refuses immediately after revocation', async () => {
    expect(workspaceId, 'Select the private-fixture workspace explicitly').toBeTruthy();
    const expectedSha = process.env.PAPERCUSP_DEVICE_SESSIONS_EXPECTED_SHA;
    expect(expectedSha, 'Pin the measured containing operator build').toMatch(/^[a-f0-9]{10,40}$/);
    const receipt = await measureSessionCapabilityScenario({
      workspace: workspaceId!, api: base!, expectedSha: expectedSha!,
    });
    console.log(`DEVICE_SESSIONS_RUNTIME=${JSON.stringify({ api: new URL(base!).origin,
      sha: receipt.sha, checks: receipt.checks, deviceRevoked: receipt.deviceRevoked })}`);
  }, 180_000);
});
