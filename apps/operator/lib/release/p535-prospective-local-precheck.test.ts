/** Independent prospective P535 acceptance, WI-6554700010020476. */
import { describe, expect, it } from "vitest";
import {
  buildP2pCandidateManifest,
  candidateArtifactDigest,
  type P2pCandidateProvenance,
  type P2pJourneyResult,
} from "./p2p-candidate-manifest";

// Owner-authored P521 population; a production deletion cannot shrink the oracle.
const JOURNEYS = [
  "discovery-join",
  "git-consistency-signed-scope",
  "serving-identity-restart",
  "replicated-write-outage-replay",
  "delegated-seat-lifecycle",
  "protected-effect-fencing",
  "github-bridge",
  "full-installer-compat",
] as const;
const candidate: P2pCandidateProvenance = {
  version: "0.0.99",
  channel: "alpha",
  sourceSha: "a".repeat(40),
  artifacts: [{ name: "candidate.deb", sha256: "b".repeat(64) }],
};
const now = Date.parse("2026-10-22T15:00:00Z");
function journeys() {
  const pass: P2pJourneyResult = {
    verdict: "pass",
    reason: "physical journey observed",
    measuredAt: new Date(now - 1_000).toISOString(),
    evidence: [{ ref: "physical-fixture", kind: "physical-drill" }],
    artifactDigest: candidateArtifactDigest(candidate.artifacts),
    observedPeers: ["mac-vm", "tower"],
  };
  return Object.fromEntries(JOURNEYS.map((key) => [key, { ...pass }]));
}

describe("P535 prospective same-artifact local precheck admission", () => {
  it.each(JOURNEYS)(
    "physical success cannot admit %s without its local precheck",
    async (key) => {
      // Deliberately supply no local precheck. Physical evidence alone cannot
      // discharge P535, even when every physical journey is otherwise green.
      const manifest = await buildP2pCandidateManifest({
        candidate,
        now,
        journeys: journeys(),
      });
      expect(manifest.current.go).toBe(false);
      expect(
        manifest.current.rows.find((row) => row.capability === key)?.state,
      ).not.toBe("passed-on-this-artifact");
    },
  );

  it("an entirely unmeasured candidate remains refused", async () => {
    const manifest = await buildP2pCandidateManifest({ candidate, now });
    expect(manifest.current.go).toBe(false);
    expect(manifest.current.rows.map((row) => row.capability)).toEqual(
      JOURNEYS,
    );
  });
});
