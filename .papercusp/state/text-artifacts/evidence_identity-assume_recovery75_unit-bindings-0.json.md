---
rel_path: "evidence/identity-assume/recovery75/unit-bindings-0.json"
updated_at: 1792982524769
_body: "content"
---

{
  "items": [
    {
      "workItemId": "WI-6554700010025439",
      "specId": "AUTO-BAR-R-1-P-001",
      "specRevision": 5,
      "fromTestRun": 22098177,
      "sourcePaths": [
        "packages/operator-core/lib/session-assume.ts"
      ],
      "fixturePaths": [
        "packages/operator-core/lib/agent-tools/session/assume.test.ts"
      ],
      "details": {
        "scope": "Recovery75 clause-specific committed copy-out mutant. Descriptor and controls/logs in recovery75/unit-mutation-manifest.json.",
        "causalControls": {
          "baselineTestRunId": 22098173,
          "copyBaselineTestRunId": 22098175,
          "mutantTestRunId": 22098177
        },
        "adequacy": {
          "targeted": "AUTO-BAR-R-1-P-001",
          "fixtureCalibrated": true,
          "oracleIndependent": true,
          "pathReachable": true,
          "testLayer": "unit",
          "testCases": [
            "session:assume durable transition boundaries > R-1 reject unrelated-window and env-only fake takeover"
          ]
        }
      }
    },
    {
      "workItemId": "WI-6554700010025439",
      "specId": "AUTO-BAR-R-2-P-001",
      "specRevision": 4,
      "fromTestRun": 22098195,
      "sourcePaths": [
        "packages/operator-core/lib/session-assume.ts"
      ],
      "fixturePaths": [
        "packages/operator-core/lib/agent-tools/session/assume.test.ts"
      ],
      "details": {
        "scope": "Recovery75 clause-specific committed copy-out mutant. Descriptor and controls/logs in recovery75/unit-mutation-manifest.json.",
        "causalControls": {
          "baselineTestRunId": 22098191,
          "copyBaselineTestRunId": 22098193,
          "mutantTestRunId": 22098195
        },
        "adequacy": {
          "targeted": "AUTO-BAR-R-2-P-001",
          "fixtureCalibrated": true,
          "oracleIndependent": true,
          "pathReachable": true,
          "testLayer": "unit",
          "testCases": [
            "session:assume durable transition boundaries > R-2 target inbox and task routing spans before during and after cutover"
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
          "testRunId": 22098177,
          "evidenceKind": "mutation",
          "evidenceRef": "test-run 22098177 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
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
        "id": 70883,
        "workItemId": "WI-6554700010025439",
        "planSlug": "agent-assume-identity-2026-10-23",
        "specId": "AUTO-BAR-R-1-P-001",
        "sourceValId": null,
        "specRevision": 5,
        "specFingerprint": "c3b907cd50a326fad56a344fa0a3db4c74fab44dbca327a793f518a1652c9440",
        "bindingFingerprint": "2166ad7595645993ac3647b74e918cb15abe94d47700a5f1257e77f866bc0629"
      },
      {
        "ok": true,
        "slug": "agent-assume-identity-2026-10-23",
        "derivedFromTestRun": {
          "testRunId": 22098195,
          "evidenceKind": "mutation",
          "evidenceRef": "test-run 22098195 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
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
        "id": 70884,
        "workItemId": "WI-6554700010025439",
        "planSlug": "agent-assume-identity-2026-10-23",
        "specId": "AUTO-BAR-R-2-P-001",
        "sourceValId": null,
        "specRevision": 4,
        "specFingerprint": "a39cdea05a09e5cf0f43f1dd7b1571b06f1b224e70b6cbcb474410d5fe7274dd",
        "bindingFingerprint": "ada46c9c371ec9360c17f5b1e6643ac6b437d985b90038087f744920cb6a7823"
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
        "id": 22098195,
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
            "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -432,7 +432,7 @@\n     observation.nativePid !== caller.nativePid && !!observation.nativeProcessStart &&\n     Number.isSafeInteger(ptyPid) && ptyPid > 0 && ptyPid !== caller.nativePid && !!ptyStart &&\n     observation.nativeWriterPids.length === 1 && observation.nativeWriterPids[0] === observation.nativePid &&\n-    !!observation.directedMessage.id && observation.directedMessage.recipient === target.ownerId &&\n+    !!observation.directedMessage.id && true &&\n     observation.directedMessage.consumedBy === target.ownerId && observation.directedMessage.consumptions === 1 &&\n     !!observation.assignment.id && observation.assignment.assignee === target.ownerId &&\n     observation.assignment.observedBy === target.ownerId;\n",
            "subjectPath": "packages/operator-core/lib/session-assume.ts",
            "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-2 target inbox and task routing spans before during and after cutover'",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
            "mutateExpression": "s/observation\\.directedMessage\\.recipient === target\\.ownerId/true/",
            "probeInvocationId": "b16942e3-0452-4212-a227-dccc17ca9b28",
            "testCommandSha256": "7ac1b57ecd10b9a3e37158b47685652a325626458add5d15aa1241f77913788c",
            "subjectAfterSha256": "fb57dbfd918ec76ac04345054fd5255cdcf25b51cc832e5339dd0e27aabfc532",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
          },
          "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": null,
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-26T02:32:51.333Z",
          "mutationPhase": "mutant",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": "R-2 target inbox and task routing spans before during and after cutover",
          "collectionFailed": false,
          "failedCaseTitles": [
            "session:assume durable transition boundaries > R-2 target inbox and task routing spans before during and after cutover"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "status": "fail",
        "framework": "vitest",
        "startedAt": "2026-10-26T02:32:57.925Z",
        "finishedAt": "2026-10-26T02:32:57.946Z",
        "durationMs": 21,
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": "session:assume durable transition boundaries > R-2 target inbox and task routing spans before during and after cutover: expected 'target-verified' to be 'handoff-accepted' // Object.is equality\nactual: target-verified\nexpected: handoff-accepted",
        "loopLagP95Ms": null,
        "rssMb": 186,
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
            "status": "fail",
            "durationMs": 17,
            "errorTail": "expected 'target-verified' to be 'handoff-accepted' // Object.is equality\nactual: target-verified\nexpected: handoff-accepted"
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
        "id": 22098177,
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
            "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -415,7 +415,7 @@\n   return ['handoff-requested', 'handoff-accepted', 'indeterminate'].includes(receipt.state) &&\n     observation.transitionKey === receipt.transitionKey &&\n     Number.isFinite(observation.observedAt) && observation.observedAt >= receipt.updatedAt &&\n-    observation.hostId === caller.hostId && observation.attachmentId === caller.attachmentId &&\n+    true && observation.attachmentId === caller.attachmentId &&\n     observation.callerNativePid === caller.nativePid && observation.callerExited === true &&\n     observation.targetOwnerId === target.ownerId &&\n     (target.executionNativeSessionId !== null\n",
            "subjectPath": "packages/operator-core/lib/session-assume.ts",
            "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-1 reject unrelated-window and env-only fake takeover'",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
            "mutateExpression": "s/observation\\.hostId === caller\\.hostId/true/",
            "probeInvocationId": "52b5c492-fb03-4860-8099-626710503b66",
            "testCommandSha256": "e14c4de9461eae43af578809f1f5b4e71be7b941ca17f9b8b1fbc284f7281582",
            "subjectAfterSha256": "b6e5444370bc9539bfc23933910f19da687df074e3d79a9577e40b27cccc8e10",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
          },
          "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": null,
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-26T02:31:48.178Z",
          "mutationPhase": "mutant",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": "R-1 reject unrelated-window and env-only fake takeover",
          "collectionFailed": false,
          "failedCaseTitles": [
            "session:assume durable transition boundaries > R-1 reject unrelated-window and env-only fake takeover"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "status": "fail",
        "framework": "vitest",
        "startedAt": "2026-10-26T02:31:52.935Z",
        "finishedAt": "2026-10-26T02:31:52.962Z",
        "durationMs": 27,
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": "session:assume durable transition boundaries > R-1 reject unrelated-window and env-only fake takeover: expected true to be false // Object.is equality\nactual: true\nexpected: false",
        "loopLagP95Ms": null,
        "rssMb": 189.3,
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
            "status": "fail",
            "durationMs": 21,
            "errorTail": "expected true to be false // Object.is equality\nactual: true\nexpected: false"
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
