---
rel_path: "evidence/identity-assume/recovery75/unit-bindings-1.json"
updated_at: 1792982526531
_body: "content"
---

{
  "items": [
    {
      "workItemId": "WI-6554700010025439",
      "specId": "AUTO-BAR-R-3-P-001",
      "specRevision": 4,
      "fromTestRun": 22098248,
      "sourcePaths": [
        "packages/operator-core/lib/session-assume.ts"
      ],
      "fixturePaths": [
        "packages/operator-core/lib/agent-tools/session/assume.test.ts"
      ],
      "details": {
        "scope": "Recovery75 clause-specific committed copy-out mutant. Descriptor and controls/logs in recovery75/unit-mutation-manifest.json.",
        "causalControls": {
          "baselineTestRunId": 22098246,
          "copyBaselineTestRunId": 22098247,
          "mutantTestRunId": 22098248
        },
        "adequacy": {
          "targeted": "AUTO-BAR-R-3-P-001",
          "fixtureCalibrated": true,
          "oracleIndependent": true,
          "pathReachable": true,
          "testLayer": "unit",
          "testCases": [
            "session:assume preparation and exact custody > R-3 unavailable corrupt stale and incompatible context refuses without fallback"
          ]
        }
      }
    },
    {
      "workItemId": "WI-6554700010025439",
      "specId": "AUTO-BAR-R-4-P-001",
      "specRevision": 4,
      "fromTestRun": 22098313,
      "sourcePaths": [
        "packages/operator-core/lib/session-assume.ts"
      ],
      "fixturePaths": [
        "packages/operator-core/lib/agent-tools/session/assume.test.ts"
      ],
      "details": {
        "scope": "Recovery75 clause-specific committed copy-out mutant. Descriptor and controls/logs in recovery75/unit-mutation-manifest.json.",
        "causalControls": {
          "baselineTestRunId": 22098249,
          "copyBaselineTestRunId": 22098311,
          "mutantTestRunId": 22098313
        },
        "adequacy": {
          "targeted": "AUTO-BAR-R-4-P-001",
          "fixtureCalibrated": true,
          "oracleIndependent": true,
          "pathReachable": true,
          "testLayer": "unit",
          "testCases": [
            "session:assume durable transition boundaries > R-4 two callers race one target with one unchanged loser"
          ]
        }
      }
    }
  ],
  "result": {
    "ok": true,
    "results": [
      {
        "ok": true,
        "slug": "agent-assume-identity-2026-10-23",
        "derivedFromTestRun": {
          "testRunId": 22098248,
          "evidenceKind": "mutation",
          "evidenceRef": "test-run 22098248 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
          "measurement": {
            "schemaVersion": 1,
            "kind": "repo-files",
            "sourcePaths": [
              "packages/operator-core/lib/session-assume.ts"
            ],
            "testPaths": [
              "packages/operator-core/lib/agent-tools/session/assume.test.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/agent-tools/session/assume.test.ts"
            ]
          },
          "harnessAttribution": "adopted-caller-harness"
        },
        "status": "created",
        "id": 70885,
        "workItemId": "WI-6554700010025439",
        "planSlug": "agent-assume-identity-2026-10-23",
        "specId": "AUTO-BAR-R-3-P-001",
        "sourceValId": null,
        "specRevision": 4,
        "specFingerprint": "99ab5f33499c4aa5c971266d402fd4e3ac162db5759b2faa3355dc2522a5c284",
        "bindingFingerprint": "6cdf20521810d3206714bba406c11bc078e763bc12b20b9aff589aec76260c3f"
      },
      {
        "ok": true,
        "slug": "agent-assume-identity-2026-10-23",
        "derivedFromTestRun": {
          "testRunId": 22098313,
          "evidenceKind": "mutation",
          "evidenceRef": "test-run 22098313 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
          "measurement": {
            "schemaVersion": 1,
            "kind": "repo-files",
            "sourcePaths": [
              "packages/operator-core/lib/session-assume.ts"
            ],
            "testPaths": [
              "packages/operator-core/lib/agent-tools/session/assume.test.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/agent-tools/session/assume.test.ts"
            ]
          },
          "harnessAttribution": "adopted-caller-harness"
        },
        "status": "created",
        "id": 70886,
        "workItemId": "WI-6554700010025439",
        "planSlug": "agent-assume-identity-2026-10-23",
        "specId": "AUTO-BAR-R-4-P-001",
        "sourceValId": null,
        "specRevision": 4,
        "specFingerprint": "291659974261bd83079c1c3051c9764d2f728bdd6016059e745b49721426e257",
        "bindingFingerprint": "9d81e95466eed37f0cda42dc9285b5240e37df98cae224726c478af2a8f20c0d"
      }
    ],
    "counts": {
      "ok": 2,
      "failed": 0
    },
    "_meta": {
      "explicitFullRequest": true,
      "format": "json",
      "_seeAlso": [
        {
          "tool": "plans:get-spec-evidence (inspect proof/currentness)"
        },
        {
          "tool": "plans:get-specs (resolve exact revisions)"
        }
      ]
    }
  },
  "ledger": {
    "count": 2,
    "total": 2,
    "truncatedByLimit": false,
    "latestPerFile": false,
    "effectiveSourceFilter": "none (exact testRunIds receipt lookup)",
    "omittedBySourceFilter": 0,
    "runs": [
      {
        "id": 22098313,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": null,
        "root": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
          "failed": 1,
          "passed": 0,
          "skipped": 67,
          "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -325,7 +325,7 @@\n     reservationUncertain = true;\n     const reservation = await deps.reserve(plan);\n     reservationUncertain = false;\n-    if (!reservation.acquired) {\n+    if (false) {\n       receipt.reason = `custody-${reservation.status}`;\n       await record('refused');\n       return receipt;\n",
            "subjectPath": "packages/operator-core/lib/session-assume.ts",
            "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-4 two callers race one target with one unchanged loser'",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
            "mutateExpression": "s/if \\(!reservation\\.acquired\\)/if (false)/",
            "probeInvocationId": "a826d9f3-8524-4687-9060-ec4a0f013f60",
            "testCommandSha256": "41115980e0f53c852665b363e43319f566f67656bcf31d1dd520228dab3fb064",
            "subjectAfterSha256": "abe4012007fbc283c0ef8f5ccd3aeec6dad5c9c7bb73ce659b21c0aac7efc0f5",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
          },
          "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": null,
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-26T02:34:56.743Z",
          "mutationPhase": "mutant",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": "R-4 two callers race one target with one unchanged loser",
          "collectionFailed": false,
          "failedCaseTitles": [
            "session:assume durable transition boundaries > R-4 two callers race one target with one unchanged loser"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "status": "fail",
        "framework": "vitest",
        "startedAt": "2026-10-26T02:35:02.609Z",
        "finishedAt": "2026-10-26T02:35:02.630Z",
        "durationMs": 21,
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": "session:assume durable transition boundaries > R-4 two callers race one target with one unchanged loser: expected { …(8) } to match object { state: 'refused', …(1) }\n(23 matching properties omitted from actual)\nactual: {\n  \"state\": \"handoff-accepted\",\n}\nexpected: {\n  \"reason\": \"custody-reserved\",\n  \"state\": \"refused\",\n}",
        "loopLagP95Ms": null,
        "rssMb": 182.4,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "session:assume preparation and exact custody > R-12 preview preserves caller and target runtime and durable snapshots",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-9 unauthorized takeover refuses without disclosure or mutation",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-9 exact caller target incarnation context and expiry bind admission",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-9 commit rechecks administrative authority and reviewer restrictions",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-4 stale target incarnation and writer generation refuses unchanged: identity",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-4 stale target incarnation and writer generation refuses unchanged: incarnation",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-4 stale target incarnation and writer generation refuses unchanged: registration",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-4 stale target incarnation and writer generation refuses unchanged: native session",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-4 stale target incarnation and writer generation refuses unchanged: writer generation",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-4 stale target incarnation and writer generation refuses unchanged: context hash",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-4 stale target incarnation and writer generation refuses unchanged: context revision",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-4 stale target incarnation and writer generation refuses unchanged: backend",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-4 same textual target in foreign workspace refuses",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > refuses live host before custody",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > refuses live registration before custody",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > refuses active writer before custody",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > refuses unknown writer before custody",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > refuses self before custody",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > refuses changed caller hostId before displacement",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > refuses changed caller attachmentId before displacement",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > refuses changed caller incarnation before displacement",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > refuses changed caller nativeSessionId before displacement",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-3 checkpoint selection pins revision hash and fresh context",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-3 native resume preserves exact conversation and backend",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-10 tampered mismatched or non-target checkpoint refuses before custody",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-10 caller history credentials and unapproved environment do not cross context boundary",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-3 unavailable corrupt stale and incompatible context refuses without fallback",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > reuses the durable resume lease with the exact workspace and full-precision incarnation pin",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > preserves preparation identity after jsonb reorders nested object keys",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > pins OMP native identity without inventing a registration session_id",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-5 nonempty caller work and return reference survive handoff failure",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-6 accepted requires later process and routed probe verification",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-6 timeout and host death remain recoverable indeterminate",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-8 fault injection at every transition boundary preserves custody and recovery: caller-checkpointed",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-8 fault injection at every transition boundary preserves custody and recovery: caller-quiesced",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-8 fault injection at every transition boundary preserves custody and recovery: target-custody-acquired",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-8 fault injection at every transition boundary preserves custody and recovery: handoff-requested",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-4 two callers race one target with one unchanged loser",
            "occurrence": 1,
            "status": "fail",
            "durationMs": 17,
            "errorTail": "expected { …(8) } to match object { state: 'refused', …(1) }\n(23 matching properties omitted from actual)\nactual: {\n  \"state\": \"handoff-accepted\",\n}\nexpected: {\n  \"reason\": \"custody-reserved\",\n  \"state\": \"refused\",\n}"
          },
          {
            "caseKey": "session:assume durable transition boundaries > one request id cannot admit changed context or a different target",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > an unknown reservation write stays indeterminate without touching the caller",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > does not claim durability when the accepted acknowledgement and recovery write both fail",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-1 same managed attachment replaces caller execution",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-1 reject unrelated-window and env-only fake takeover",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-2 target inbox and task routing spans before during and after cutover",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-2 preserve target fleet subscriptions and historical authorship",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > accepts verification only after matching native process, attachment, inbox and assignment observations",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-11 takeover audit retains caller target authorization and terminal provenance",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-11 refused verified and rolled-back outcomes remain append-only: refused",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-11 refused verified and rolled-back outcomes remain append-only: verified",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-11 refused verified and rolled-back outcomes remain append-only: rolled-back",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > requires the observed target reanchor for a backend-minted checkpoint id",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > keeps the managed PTY root distinct from its sole native backend writer",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: extra pane",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: other host",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: env-only substitution",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: old caller usable",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: duplicate writer",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: stale observation",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: wrong target",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: wrong native context",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: wrong context bytes",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: message missing",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: message duplicated",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: message routed to caller",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: assignment missing",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: assignment routed to caller",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-8 crash after target custody before exec or verification converges on retry",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > cannot release another transition custody using a stale cancellation receipt",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          }
        ]
      },
      {
        "id": 22098248,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": null,
        "root": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
          "failed": 1,
          "passed": 0,
          "skipped": 67,
          "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -126,7 +126,7 @@\n       (request.contextMode === 'checkpoint' && (target.backend === 'omp' ||\n         (target.backend === 'codex' ? target.executionNativeSessionId !== null\n           : !target.executionNativeSessionId || target.executionNativeSessionId === target.nativeSessionId)))) {\n-    return refuse('context-unavailable');\n+    return null;\n   }\n   return null;\n }\n",
            "subjectPath": "packages/operator-core/lib/session-assume.ts",
            "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-3 unavailable corrupt stale and incompatible context refuses without fallback'",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
            "mutateExpression": "s/    return refuse\\('context-unavailable'\\);/    return null;/",
            "probeInvocationId": "5974ed95-7cc8-4455-90c0-682cbf51759d",
            "testCommandSha256": "8c1944bb6ccb02f5d8802bb1a6fa8effc83e0c1802df52a13952312eabde4fb4",
            "subjectAfterSha256": "63e35ad93799700fec10ca5168842d2fcf87fca3e7b6213ca4bbafca54740c5a",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
          },
          "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": null,
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-26T02:34:03.376Z",
          "mutationPhase": "mutant",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": "R-3 unavailable corrupt stale and incompatible context refuses without fallback",
          "collectionFailed": false,
          "failedCaseTitles": [
            "session:assume preparation and exact custody > R-3 unavailable corrupt stale and incompatible context refuses without fallback"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "status": "fail",
        "framework": "vitest",
        "startedAt": "2026-10-26T02:34:10.717Z",
        "finishedAt": "2026-10-26T02:34:10.742Z",
        "durationMs": 25,
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": "session:assume preparation and exact custody > R-3 unavailable corrupt stale and incompatible context refuses without fallback: expected { ok: true, state: 'prepared', …(2) } to deeply equal { ok: false, …(1) }\nactual: {\n  \"ok\": true,\n  \"preparation\": {\n    \"authorizationRef\": \"launch-envelope:admin-1\",\n    \"caller\": {\n      \"attachmentId\": \"pty-a\",\n      \"backend\": \"codex\",\n      \"hostId\": \"host-a\",\n      \"incarnation\": \"caller-start\",\n      \"nativePid\": 101,\n      \"nativeSessionId\": \"caller-native\",\n      \"ownerId\": \"su-caller\",\n      \"workspaceId\": \"workspace-a\",\n    },\n    \"expiresAt\": 121000,\n    \"preparedAt\": 1000,\n    \"requestId\": \"request-a\",\n    \"target\": {\n      \"advSessionId\": 42,\n      \"backend\": \"codex\",\n      \"binding\": {\n        \"coordOwnerId\": \"su-target\",\n        \"sessionI",
        "loopLagP95Ms": null,
        "rssMb": 183.9,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "session:assume preparation and exact custody > R-12 preview preserves caller and target runtime and durable snapshots",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-9 unauthorized takeover refuses without disclosure or mutation",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-9 exact caller target incarnation context and expiry bind admission",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-9 commit rechecks administrative authority and reviewer restrictions",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-4 stale target incarnation and writer generation refuses unchanged: identity",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-4 stale target incarnation and writer generation refuses unchanged: incarnation",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-4 stale target incarnation and writer generation refuses unchanged: registration",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-4 stale target incarnation and writer generation refuses unchanged: native session",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-4 stale target incarnation and writer generation refuses unchanged: writer generation",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-4 stale target incarnation and writer generation refuses unchanged: context hash",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-4 stale target incarnation and writer generation refuses unchanged: context revision",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-4 stale target incarnation and writer generation refuses unchanged: backend",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-4 same textual target in foreign workspace refuses",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > refuses live host before custody",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > refuses live registration before custody",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > refuses active writer before custody",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > refuses unknown writer before custody",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > refuses self before custody",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > refuses changed caller hostId before displacement",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > refuses changed caller attachmentId before displacement",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > refuses changed caller incarnation before displacement",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > refuses changed caller nativeSessionId before displacement",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-3 checkpoint selection pins revision hash and fresh context",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-3 native resume preserves exact conversation and backend",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-10 tampered mismatched or non-target checkpoint refuses before custody",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-10 caller history credentials and unapproved environment do not cross context boundary",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > R-3 unavailable corrupt stale and incompatible context refuses without fallback",
            "occurrence": 1,
            "status": "fail",
            "durationMs": 19,
            "errorTail": "expected { ok: true, state: 'prepared', …(2) } to deeply equal { ok: false, …(1) }\nactual: {\n  \"ok\": true,\n  \"preparation\": {\n    \"authorizationRef\": \"launch-envelope:admin-1\",\n    \"caller\": {\n      \"attachmentId\": \"pty-a\",\n      \"backend\": \"codex\",\n      \"hostId\": \"host-a\",\n      \"incarnation\": \"caller-start\",\n      \"nativePid\": 101,\n      \"nativeSessionId\": \"caller-native\",\n      \"ownerId\": \"su-caller\",\n      \"workspaceId\": \"workspace-a\",\n    },\n    \"expiresAt\": 121000,\n    \"preparedAt\": 1000,\n    \"requestId\": \"request-a\",\n    \"target\": {\n      \"advSessionId\": 42,\n      \"backend\": \"codex\",\n      \"binding\": {\n        \"coordOwnerId\": \"su-target\",\n        \"sessionId\": \"target-native\",\n        \"startedAt\": \"2026-10-23 20:00:00.123456-04\",\n      },\n      \"context\": {\n        \"mode\": \"checkpoint\",\n        \"ref\": \"target-native\",\n        \"revision\": \"transcript-7\",\n        \"sha256\": \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\n      },\n      \"ended\": true,\n      \"exec"
          },
          {
            "caseKey": "session:assume preparation and exact custody > reuses the durable resume lease with the exact workspace and full-precision incarnation pin",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > preserves preparation identity after jsonb reorders nested object keys",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume preparation and exact custody > pins OMP native identity without inventing a registration session_id",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-5 nonempty caller work and return reference survive handoff failure",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-6 accepted requires later process and routed probe verification",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-6 timeout and host death remain recoverable indeterminate",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-8 fault injection at every transition boundary preserves custody and recovery: caller-checkpointed",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-8 fault injection at every transition boundary preserves custody and recovery: caller-quiesced",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-8 fault injection at every transition boundary preserves custody and recovery: target-custody-acquired",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-8 fault injection at every transition boundary preserves custody and recovery: handoff-requested",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-4 two callers race one target with one unchanged loser",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > one request id cannot admit changed context or a different target",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > an unknown reservation write stays indeterminate without touching the caller",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > does not claim durability when the accepted acknowledgement and recovery write both fail",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-1 same managed attachment replaces caller execution",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-1 reject unrelated-window and env-only fake takeover",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-2 target inbox and task routing spans before during and after cutover",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-2 preserve target fleet subscriptions and historical authorship",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > accepts verification only after matching native process, attachment, inbox and assignment observations",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-11 takeover audit retains caller target authorization and terminal provenance",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-11 refused verified and rolled-back outcomes remain append-only: refused",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-11 refused verified and rolled-back outcomes remain append-only: verified",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-11 refused verified and rolled-back outcomes remain append-only: rolled-back",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > requires the observed target reanchor for a backend-minted checkpoint id",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > keeps the managed PTY root distinct from its sole native backend writer",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: extra pane",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: other host",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: env-only substitution",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: old caller usable",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: duplicate writer",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: stale observation",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: wrong target",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: wrong native context",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: wrong context bytes",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: message missing",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: message duplicated",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: message routed to caller",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: assignment missing",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > rejects a false verification witness: assignment routed to caller",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > R-8 crash after target custody before exec or verification converges on retry",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "session:assume durable transition boundaries > cannot release another transition custody using a stale cancellation receipt",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          }
        ]
      }
    ],
    "_meta": {
      "explicitFullRequest": true,
      "format": "json",
      "_seeAlso": [
        {
          "tool": "testing:flakiness (is this red a known flake — cross-run flip rate)"
        },
        {
          "tool": "testing:run (actually run test files)"
        },
        {
          "tool": "dev:pipeline_position (is my change live / what is blocking it)"
        }
      ]
    }
  }
}
