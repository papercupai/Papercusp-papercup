/** Independent prospective P535 acceptance, WI-6554700010020476. */
import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deriveDrillJourneyEvidence, type DrillJourneyEvidenceInput } from "./p521-drill-journey-evidence";
import { evidenceVerdict } from "./p2p-candidate-evidence";
import {
  buildP2pCandidateManifest,
  candidateArtifactDigest,
  P521_JOURNEYS,
  type BuildP2pCandidateManifestOptions,
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
type Subject = { artifactDigest: string; installerSha256?: string; runtimeSha256?: string; seedSha256?: string };
type Precheck = { journey: string; check: string; verdict: string; startedAt: string; finishedAt: string;
  subject: Subject; command: string[]; evidence: Array<{ ref: string; kind: string }>; exitCode?: number; skipped?: boolean | number };
const subject: Subject = { artifactDigest: candidateArtifactDigest(candidate.artifacts),
  installerSha256: "b".repeat(64), runtimeSha256: "c".repeat(64), seedSha256: "d".repeat(64) };
function receipts(at = now, target = subject): Precheck[] {
  return JOURNEYS.map(journey => ({ journey, check: `p521-local-precheck:${journey}`, verdict: "pass",
    startedAt: new Date(at - 2000).toISOString(), finishedAt: new Date(at - 1000).toISOString(),
    subject: { ...target }, command: ["fixture-local-precheck"], evidence: [{ ref: "local-fixture", kind: "local-precheck" }], exitCode: 0, skipped: false }));
}
function withPrechecks(localPrechecks: Precheck[]): BuildP2pCandidateManifestOptions & { localPrechecks: Precheck[] } {
  return { candidate, now, journeys: Object.fromEntries(Object.entries(journeys()).map(([key, result]) => [key,
    { ...result, startedAt: new Date(now - 500).toISOString(), precheckSubject: { ...subject } }])), localPrechecks };
}
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

  it("the canonical journey census requires one named local check per journey", () => {
    expect(P521_JOURNEYS.map(row => row.key)).toEqual(JOURNEYS);
    for (const row of P521_JOURNEYS) expect(Reflect.get(row, "localPrecheck")).toBe(`p521-local-precheck:${row.key}`);
  });

  it("earlier passing prechecks on the complete identical subject admit physical passes", async () => {
    expect((await buildP2pCandidateManifest(withPrechecks(receipts()))).current.go).toBe(true);
  });

  it.each(["red", "skipped", "late", "wrong-artifact", "wrong-installer", "wrong-runtime", "wrong-seed",
    "missing-subject-field", "empty-command", "empty-evidence", "bad-time", "exit-nonzero"])(
    "manifest refuses an otherwise green physical run with %s prerequisite", async variant => {
      const local = receipts();
      const first = local[0];
      if (variant === "red") first.verdict = "fail";
      if (variant === "skipped") first.skipped = 1;
      if (variant === "late") first.finishedAt = new Date(now - 500).toISOString();
      if (variant === "wrong-artifact") first.subject.artifactDigest = "f".repeat(64);
      if (variant === "wrong-installer") first.subject.installerSha256 = "f".repeat(64);
      if (variant === "wrong-runtime") first.subject.runtimeSha256 = "f".repeat(64);
      if (variant === "wrong-seed") first.subject.seedSha256 = "f".repeat(64);
      if (variant === "missing-subject-field") delete first.subject.seedSha256;
      if (variant === "empty-command") first.command = [];
      if (variant === "empty-evidence") first.evidence = [];
      if (variant === "bad-time") first.startedAt = "not-a-time";
      if (variant === "exit-nonzero") first.exitCode = 1;
      expect((await buildP2pCandidateManifest(withPrechecks(local))).current.go).toBe(false);
    });

  it.each(["duplicate", "unknown-journey", "wrong-check"])("manifest refuses %s receipt census", async variant => {
    const local = receipts();
    if (variant === "duplicate") local.push(structuredClone(local[0]));
    if (variant === "unknown-journey") local[0].journey = "not-a-canonical-journey";
    if (variant === "wrong-check") local[0].check = "some-other-check";
    const result = await buildP2pCandidateManifest(withPrechecks(local)).then(value => value.current.go, () => false);
    expect(result).toBe(false);
  });

  it.each(["missing", "red", "late", "wrong-runtime"])("drill adapter refuses %s prerequisite", variant => {
    const local = variant === "missing" ? [] : receipts();
    if (variant === "red") local.forEach(row => { row.verdict = "fail"; });
    if (variant === "late") local.forEach(row => { row.finishedAt = new Date(now - 500).toISOString(); });
    if (variant === "wrong-runtime") local.forEach(row => { row.subject.runtimeSha256 = "f".repeat(64); });
    const input: DrillJourneyEvidenceInput & { localPrechecks: Precheck[]; precheckSubject: Subject } = {
      drill: { schemaVersion: "hive-git-physical-evidence/v3", runId: "p535-independent",
        window: { startedAt: new Date(now - 500).toISOString(), finishedAt: new Date(now).toISOString() },
        legVerdicts: "ABCDEFGHIJ".split("").map(leg => ({ leg, status: "pass", scope: "physical" })) },
      drillPath: "fixture/drill.json", drillSha256: "e".repeat(64), validation: { ok: true, errors: [], summary: "fixture valid" },
      release: candidate.version, artifact: candidate.artifacts[0].name, actualDebSha256: "b".repeat(64),
      expectedDebSha256: "b".repeat(64), observer: "independent-author", command: ["fixture-drill"],
      precheckSubject: subject, localPrechecks: local,
    };
    const docs = deriveDrillJourneyEvidence(input);
    expect(docs).toHaveLength(6);
    for (const { doc } of docs) expect(evidenceVerdict(doc).verdict).not.toBe("pass");
  });

  it.each([
    ["hive-git-physical-probe.sh", [], "missing"],
    ["p202-workdist.sh", ["--i-accept-live-spawn"], "missing"],
    ...["valid", "red", "skipped", "late", "wrong-runtime", "wrong-seed", "tampered-file", "duplicate"].map(variant =>
      ["p202-workdist.sh", ["--i-accept-live-spawn"], variant] as const),
  ] as const)("%s dispatch admission with args %j and %s precheck", (script, flags, variant) => {
    const root = mkdtempSync(join(tmpdir(), "p535-dispatch-sentinel-"));
    try {
      const effects = join(root, "effects");
      const init = join(root, "sentinels.sh");
      const sentinel = '#!/bin/bash\nprintf "%s\\n" "$0 $*" >> "$P535_EFFECT_LOG"\nexit 97\n';
      // The production driver runs intact. Every external effect is intercepted
      // in both this shell and descendant shells; no physical host is contacted.
      for (const command of ["ssh", "scp", "rsync", "curl", "psql", "ptool"]) {
        const file = join(root, command);
        writeFileSync(file, sentinel);
        chmodSync(file, 0o755);
      }
      writeFileSync(init, [
        'export PATH="$P535_SENTINEL_BIN:$PATH"',
        'p535_effect() { printf "%s\\n" "$*" >> "$P535_EFFECT_LOG"; exit 97; }',
        ...["ssh", "scp", "rsync", "curl", "psql", "ptool"].map(command =>
          `${command}() { p535_effect ${command} "$@"; }`),
        // Even an absolute ptool/API/SSH path must stop inside the fixture.
        'set -T',
        'trap \'case "$BASH_COMMAND" in */ptool\\ *|/usr/bin/ssh\\ *|/usr/bin/curl\\ *) p535_effect "$BASH_COMMAND";; esac\' DEBUG',
      ].join("\n"));
      const probe = script === "hive-git-physical-probe.sh";
      const args = probe ? [join(root, "evidence.json"), join(root, "trust.json")] : [...flags];
      let bundlePath: string | undefined;
      if (variant !== "missing") {
        const file = join(root, "candidate.deb"), runtime = join(root, "runtime"), seed = join(root, "seed");
        writeFileSync(file, "independent installer bytes"); writeFileSync(runtime, "independent runtime bytes"); writeFileSync(seed, "independent seed bytes");
        const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
        const actual = { ...candidate, artifacts: [{ name: "candidate.deb", sha256: hash(file) }] };
        const target = { artifactDigest: candidateArtifactDigest(actual.artifacts), installerSha256: hash(file), runtimeSha256: hash(runtime), seedSha256: hash(seed) };
        const local = receipts(Date.now() - 10_000, target).filter(row => row.journey === "delegated-seat-lifecycle");
        if (variant === "red") local[0].verdict = "fail";
        if (variant === "skipped") local[0].skipped = 1;
        if (variant === "late") local[0].finishedAt = new Date(Date.now() + 3_600_000).toISOString();
        if (variant === "wrong-runtime") local[0].subject.runtimeSha256 = "f".repeat(64);
        if (variant === "wrong-seed") local[0].subject.seedSha256 = "f".repeat(64);
        if (variant === "duplicate") local.push(structuredClone(local[0]));
        bundlePath = join(root, "prechecks.json");
        writeFileSync(bundlePath, JSON.stringify({ candidate: actual, artifactDir: root, precheckSubject: target,
          bytePaths: { installer: file, runtime, seed }, localPrechecks: local }));
        if (variant === "tampered-file") writeFileSync(runtime, "different runtime bytes after receipt");
      }
      const run = spawnSync("bash", [resolve("../../papercusp-desktop/bin/vm-rig", script), ...args], {
        encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, BASH_ENV: init, PATH: `${root}:${process.env.PATH}`,
          P535_EFFECT_LOG: effects, P535_SENTINEL_BIN: root,
          HIVE_GIT_PHYSICAL_PLAN: "p2p-git-live-activation-2026-07-09",
          HIVE_GIT_PHYSICAL_PHASES: "A",
          PCUSP_TOWER_MCP: "1", PCUSP_VM_MCP: "1", PCUSP_TOWER_DSN: "postgresql://fixture@127.0.0.1:1/fixture",
          PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: "p535-disposable-fixture",
          PCUSP_P202_MODEL: "gpt-5.6-sol", PCUSP_P202_EFFORT: "xhigh",
          P521_LOCAL_PRECHECKS_FILE: bundlePath,
        },
      });
      const attempted = existsSync(effects) ? readFileSync(effects, "utf8") : "";
      expect(run.error).toBeUndefined();
      if (variant === "valid") {
        expect(attempted).not.toBe("");
        return;
      }
      expect(attempted, run.stdout + run.stderr).toBe("");
      expect(run.status).not.toBe(0);
      expect(run.stdout + run.stderr).toMatch(/precheck.*(missing|absent|required|refus)|(?:missing|required|refus).*precheck/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
