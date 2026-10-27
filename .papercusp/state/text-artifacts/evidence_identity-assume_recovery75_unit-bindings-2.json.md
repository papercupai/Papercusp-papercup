---
rel_path: "evidence/identity-assume/recovery75/unit-bindings-2.json"
updated_at: 1792982550915
_body: "content"
---

{
  "items": [
    {
      "workItemId": "WI-6554700010025439",
      "specId": "AUTO-BAR-R-5-P-001",
      "specRevision": 4,
      "fromTestRun": 22098319,
      "sourcePaths": [
        "packages/operator-core/lib/session-assume.ts"
      ],
      "fixturePaths": [
        "packages/operator-core/lib/agent-tools/session/assume.test.ts"
      ],
      "details": {
        "scope": "Recovery75 clause-specific committed copy-out mutant. Descriptor and controls/logs in recovery75/unit-mutation-manifest.json.",
        "causalControls": {
          "baselineTestRunId": 22098315,
          "copyBaselineTestRunId": 22098317,
          "mutantTestRunId": 22098319
        },
        "adequacy": {
          "targeted": "AUTO-BAR-R-5-P-001",
          "fixtureCalibrated": true,
          "oracleIndependent": true,
          "pathReachable": true,
          "testLayer": "unit",
          "testCases": [
            "session:assume durable transition boundaries > R-5 nonempty caller work and return reference survive handoff failure"
          ]
        }
      }
    },
    {
      "workItemId": "WI-6554700010025439",
      "specId": "AUTO-BAR-R-8-P-001",
      "specRevision": 4,
      "fromTestRun": 22098327,
      "sourcePaths": [
        "packages/operator-core/lib/session-assume.ts"
      ],
      "fixturePaths": [
        "packages/operator-core/lib/agent-tools/session/assume.test.ts"
      ],
      "details": {
        "scope": "Recovery75 clause-specific committed copy-out mutant. Descriptor and controls/logs in recovery75/unit-mutation-manifest.json.",
        "causalControls": {
          "baselineTestRunId": 22098321,
          "copyBaselineTestRunId": 22098325,
          "mutantTestRunId": 22098327
        },
        "adequacy": {
          "targeted": "AUTO-BAR-R-8-P-001",
          "fixtureCalibrated": true,
          "oracleIndependent": true,
          "pathReachable": true,
          "testLayer": "unit",
          "testCases": [
            "session:assume durable transition boundaries > R-8 crash after target custody before exec or verification converges on retry"
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
          "testRunId": 22098319,
          "evidenceKind": "mutation",
          "evidenceRef": "test-run 22098319 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
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
        "id": 70887,
        "workItemId": "WI-6554700010025439",
        "planSlug": "agent-assume-identity-2026-10-23",
        "specId": "AUTO-BAR-R-5-P-001",
        "sourceValId": null,
        "specRevision": 4,
        "specFingerprint": "b6df13a2f84f66ec87e8b4415f063e9bae927d49b5ef1897a70341da033145d8",
        "bindingFingerprint": "338d3541899d24345492a976cf9758774dae3ca9412eaaa077691abbd0ca0673"
      },
      {
        "ok": true,
        "slug": "agent-assume-identity-2026-10-23",
        "derivedFromTestRun": {
          "testRunId": 22098327,
          "evidenceKind": "mutation",
          "evidenceRef": "test-run 22098327 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
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
        "id": 70888,
        "workItemId": "WI-6554700010025439",
        "planSlug": "agent-assume-identity-2026-10-23",
        "specId": "AUTO-BAR-R-8-P-001",
        "sourceValId": null,
        "specRevision": 4,
        "specFingerprint": "d30cfd692b34fa3703717044a6f70364dcf24be009b9a4cc55d5766588b6e9fa",
        "bindingFingerprint": "bc99c052d492eef7a250430d561d2f759c7415937669e06d6450fce00f3cb5b0"
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
        "id": 22098327,
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
            "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -474,7 +474,7 @@\n   const cancelled = observation.kind === 'cancelled' && observation.queuedHandoffCancelled === true &&\n     observation.nativeWriter === 'free' && observation.transitionKey === receipt.transitionKey &&\n     observation.preparationFingerprint === receipt.preparationFingerprint;\n-  if (!cancelled) return receipt;\n+  if (false) return receipt;\n   const restored = !receipt.recovery || await deps.restoreCaller(receipt.preparation, receipt.recovery).catch(() => false);\n   const released = await deps.releaseTarget(receipt.preparation).catch(() => false);\n   const settled: AssumeTransitionReceipt = { ...receipt, updatedAt: deps.now(), durable: true,\n",
            "subjectPath": "packages/operator-core/lib/session-assume.ts",
            "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-8 crash after target custody before exec or verification converges on retry'",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
            "mutateExpression": "s/if \\(!cancelled\\) return receipt;/if (false) return receipt;/",
            "probeInvocationId": "fbc50d75-5589-4e2c-ab43-bde703837f2a",
            "testCommandSha256": "4ab279971f023f092d5243a7e8038d1765c49c09434f3d9ee0155b8cf47005ec",
            "subjectAfterSha256": "5ac41b8ed983874f4eade9e5e60625e78c95472e02f0622a1ba5de955e8c9d59",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
          },
          "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": null,
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-26T02:36:41.246Z",
          "mutationPhase": "mutant",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": "R-8 crash after target custody before exec or verification converges on retry",
          "collectionFailed": false,
          "failedCaseTitles": [
            "session:assume durable transition boundaries > R-8 crash after target custody before exec or verification converges on retry"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "status": "fail",
        "framework": "vitest",
        "startedAt": "2026-10-26T02:36:47.322Z",
        "finishedAt": "2026-10-26T02:36:47.349Z",
        "durationMs": 27,
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": "ition\": {\n    \"directives\": \"retained\",\n    \"inbox\": \"retained\",\n    \"pausedAwaitIds\": [\n      11,\n    ],\n    \"pausedLoopRef\": \"loop:caller\",\n    \"releasedPlanClaims\": [\n      {\n        \"checkpointRef\": \"carry:plan:3\",\n        \"item\": \"P-001\",\n        \"plan\": \"caller-plan\",\n      },\n    ],\n    \"releasedWorkClaims\": [\n      {\n        \"checkpointRef\": \"carry:work:3\",\n        \"id\": \"WI-caller-work\",\n      },\n    ],\n  },\n  \"durable\": true,\n  \"preparation\": {\n    \"authorizationRef\": \"launch-envelope:admin-1\",\n    \"caller\": {\n      \"attachmentId\": \"pty-a\",\n      \"backend\": \"codex\",\n      \"hostId\": \"host-a\",\n      \"incarnation\": \"caller-start\",\n      \"nativePid\": 101,\n      \"nativeSessionId\": \"caller-native\",\n      \"ownerId\": \"su-caller\",\n      \"workspaceId\": \"workspace-a\",\n    },\n    \"expiresAt\"",
        "loopLagP95Ms": null,
        "rssMb": 178.7,
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
            "status": "fail",
            "durationMs": 22,
            "errorTail": "expected { …(9) } to be { …(9) } // Object.is equality\nactual: {\n  \"disposition\": {\n    \"directives\": \"retained\",\n    \"inbox\": \"retained\",\n    \"pausedAwaitIds\": [\n      11,\n    ],\n    \"pausedLoopRef\": \"loop:caller\",\n    \"releasedPlanClaims\": [\n      {\n        \"checkpointRef\": \"carry:plan:3\",\n        \"item\": \"P-001\",\n        \"plan\": \"caller-plan\",\n      },\n    ],\n    \"releasedWorkClaims\": [\n      {\n        \"checkpointRef\": \"carry:work:3\",\n        \"id\": \"WI-caller-work\",\n      },\n    ],\n  },\n  \"durable\": true,\n  \"preparation\": {\n    \"authorizationRef\": \"launch-envelope:admin-1\",\n    \"caller\": {\n      \"attachmentId\": \"pty-a\",\n      \"backend\": \"codex\",\n      \"hostId\": \"host-a\",\n      \"incarnation\": \"caller-start\",\n      \"nativePid\": 101,\n      \"nativeSessionId\": \"caller-native\",\n      \"ownerId\": \"su-caller\",\n      \"workspaceId\": \"workspace-a\",\n    },\n    \"expiresAt\": 121000,\n    \"preparedAt\": 1000,\n    \"requestId\": \"request-a\",\n    \"target\": {\n      \"advSessionId\": 42,\n      \"backend\": \"co"
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
        "id": 22098319,
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
            "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -343,7 +343,7 @@\n     await record('caller-checkpointed');\n     quiesceStarted = true;\n     receipt.disposition = await deps.quiesceCaller(plan, recovery);\n-    await record('caller-quiesced');\n+    receipt.disposition.releasedWorkClaims = []; await record('caller-quiesced');\n     if (!await deps.checkCustody(plan)) throw new Error('custody-changed');\n     await record('target-custody-acquired');\n     // Persist the uncertainty barrier BEFORE sending. Even if the host accepts\n",
            "subjectPath": "packages/operator-core/lib/session-assume.ts",
            "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-5 nonempty caller work and return reference survive handoff failure'",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
            "mutateExpression": "s/await record\\('caller-quiesced'\\);/receipt.disposition.releasedWorkClaims = []; await record('caller-quiesced');/",
            "probeInvocationId": "608f1931-994d-4f4c-8e12-d2fe817774a7",
            "testCommandSha256": "3b104210880fd482544391ad88f93b74173e59f69effae29df8b26b4cd6cbb9e",
            "subjectAfterSha256": "e3593f2ec0a7431140564c4afb7d9eb801e4d784cc6ca64722ab4681bed8c1f6",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
          },
          "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": null,
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-26T02:35:50.608Z",
          "mutationPhase": "mutant",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": "R-5 nonempty caller work and return reference survive handoff failure",
          "collectionFailed": false,
          "failedCaseTitles": [
            "session:assume durable transition boundaries > R-5 nonempty caller work and return reference survive handoff failure"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "status": "fail",
        "framework": "vitest",
        "startedAt": "2026-10-26T02:35:57.081Z",
        "finishedAt": "2026-10-26T02:35:57.104Z",
        "durationMs": 23,
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": "session:assume durable transition boundaries > R-5 nonempty caller work and return reference survive handoff failure: expected { releasedWorkClaims: [], …(5) } to match object { inbox: 'retained', …(4) }\n(1 matching property omitted from actual)\nactual: {\n  \"directives\": \"retained\",\n  \"inbox\": \"retained\",\n  \"pausedAwaitIds\": [\n    11,\n  ],\n  \"pausedLoopRef\": \"loop:caller\",\n  \"releasedWorkClaims\": [],\n}\nexpected: {\n  \"directives\": \"retained\",\n  \"inbox\": \"retained\",\n  \"pausedAwaitIds\": [\n    11,\n  ],\n  \"pausedLoopRef\": \"loop:caller\",\n  \"releasedWorkClaims\": [\n    {\n      \"checkpointRef\": \"carry:work:3\",\n      \"id\": \"WI-caller-work\",\n    },\n  ],\n}",
        "loopLagP95Ms": null,
        "rssMb": 183.8,
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
            "status": "fail",
            "durationMs": 19,
            "errorTail": "expected { releasedWorkClaims: [], …(5) } to match object { inbox: 'retained', …(4) }\n(1 matching property omitted from actual)\nactual: {\n  \"directives\": \"retained\",\n  \"inbox\": \"retained\",\n  \"pausedAwaitIds\": [\n    11,\n  ],\n  \"pausedLoopRef\": \"loop:caller\",\n  \"releasedWorkClaims\": [],\n}\nexpected: {\n  \"directives\": \"retained\",\n  \"inbox\": \"retained\",\n  \"pausedAwaitIds\": [\n    11,\n  ],\n  \"pausedLoopRef\": \"loop:caller\",\n  \"releasedWorkClaims\": [\n    {\n      \"checkpointRef\": \"carry:work:3\",\n      \"id\": \"WI-caller-work\",\n    },\n  ],\n}"
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
