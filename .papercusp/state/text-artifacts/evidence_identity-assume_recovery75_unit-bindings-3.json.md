---
rel_path: "evidence/identity-assume/recovery75/unit-bindings-3.json"
updated_at: 1792982555615
_body: "content"
---

{
  "items": [
    {
      "workItemId": "WI-6554700010025439",
      "specId": "AUTO-BAR-R-9-P-001",
      "specRevision": 3,
      "fromTestRun": 22098334,
      "sourcePaths": [
        "packages/operator-core/lib/session-assume.ts"
      ],
      "fixturePaths": [
        "packages/operator-core/lib/agent-tools/session/assume.test.ts"
      ],
      "details": {
        "scope": "Recovery75 clause-specific committed copy-out mutant. Descriptor and controls/logs in recovery75/unit-mutation-manifest.json.",
        "causalControls": {
          "baselineTestRunId": 22098329,
          "copyBaselineTestRunId": 22098332,
          "mutantTestRunId": 22098334
        },
        "adequacy": {
          "targeted": "AUTO-BAR-R-9-P-001",
          "fixtureCalibrated": true,
          "oracleIndependent": true,
          "pathReachable": true,
          "testLayer": "unit",
          "testCases": [
            "session:assume preparation and exact custody > R-9 commit rechecks administrative authority and reviewer restrictions"
          ]
        }
      }
    },
    {
      "workItemId": "WI-6554700010025439",
      "specId": "AUTO-BAR-R-10-P-001",
      "specRevision": 3,
      "fromTestRun": 22098840,
      "sourcePaths": [
        "packages/operator-core/lib/session-assume.ts"
      ],
      "fixturePaths": [
        "packages/operator-core/lib/agent-tools/session/assume.test.ts"
      ],
      "details": {
        "scope": "Recovery75 clause-specific committed copy-out mutant. Descriptor and controls/logs in recovery75/unit-mutation-manifest.json.",
        "causalControls": {
          "baselineTestRunId": 22098337,
          "copyBaselineTestRunId": 22098338,
          "mutantTestRunId": 22098840
        },
        "adequacy": {
          "targeted": "AUTO-BAR-R-10-P-001",
          "fixtureCalibrated": true,
          "oracleIndependent": true,
          "pathReachable": true,
          "testLayer": "unit",
          "testCases": [
            "session:assume preparation and exact custody > R-10 tampered mismatched or non-target checkpoint refuses before custody"
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
          "testRunId": 22098334,
          "evidenceKind": "mutation",
          "evidenceRef": "test-run 22098334 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
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
        "id": 70889,
        "workItemId": "WI-6554700010025439",
        "planSlug": "agent-assume-identity-2026-10-23",
        "specId": "AUTO-BAR-R-9-P-001",
        "sourceValId": null,
        "specRevision": 3,
        "specFingerprint": "0b638afa5ea23070d1aad1599377bc8c6c076fdf0ab646b690bf60874debbd2f",
        "bindingFingerprint": "862976135754445d6641866b6b110e344a8eb867492354b5d51a1ebac398e91d"
      },
      {
        "ok": true,
        "slug": "agent-assume-identity-2026-10-23",
        "derivedFromTestRun": {
          "testRunId": 22098840,
          "evidenceKind": "mutation",
          "evidenceRef": "test-run 22098840 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
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
        "id": 70890,
        "workItemId": "WI-6554700010025439",
        "planSlug": "agent-assume-identity-2026-10-23",
        "specId": "AUTO-BAR-R-10-P-001",
        "sourceValId": null,
        "specRevision": 3,
        "specFingerprint": "f431714147c75b93d6b47d884945d075da9dd4626675a98e1910835a5b795a5f",
        "bindingFingerprint": "876ceb6469e6795bc186bb22733ba8b27a497c75f8aa8653687582626aa3bcd2"
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
        "id": 22098840,
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
            "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -184,7 +184,7 @@\n   if (!target.success) return refuse('target-changed');\n   const rejection = targetRefusal(actor, request, target.data);\n   if (rejection) return rejection;\n-  if (JSON.stringify(target.data) !== JSON.stringify(plan.target)) return refuse('target-changed');\n+  if (false) return refuse('target-changed');\n   return { ok: true, preparation: plan };\n }\n \n",
            "subjectPath": "packages/operator-core/lib/session-assume.ts",
            "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-10 tampered mismatched or non-target checkpoint refuses before custody'",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
            "mutateExpression": "s/if \\(JSON\\.stringify\\(target\\.data\\) !== JSON\\.stringify\\(plan\\.target\\)\\)/if (false)/",
            "probeInvocationId": "3beec27c-db6d-4ce2-a288-9cd4fa93b4f6",
            "testCommandSha256": "b7bc5608c013cce1f0466ad0e65dee20965ef98604cbcda74ced8fb59598e050",
            "subjectAfterSha256": "956860062c7f8770c45ca38527105801815144fa79ce983256e0be83c2011f80",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
          },
          "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": null,
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-26T02:38:11.369Z",
          "mutationPhase": "mutant",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": "R-10 tampered mismatched or non-target checkpoint refuses before custody",
          "collectionFailed": false,
          "failedCaseTitles": [
            "session:assume preparation and exact custody > R-10 tampered mismatched or non-target checkpoint refuses before custody"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "status": "fail",
        "framework": "vitest",
        "startedAt": "2026-10-26T02:38:15.904Z",
        "finishedAt": "2026-10-26T02:38:15.924Z",
        "durationMs": 20,
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": "session:assume preparation and exact custody > R-10 tampered mismatched or non-target checkpoint refuses before custody: expected { ok: true, preparation: { …(7) } } to match object { ok: false }\n(8 matching properties omitted from actual)\nactual: {\n  \"ok\": true,\n}\nexpected: {\n  \"ok\": false,\n}",
        "loopLagP95Ms": null,
        "rssMb": 177.8,
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
            "status": "fail",
            "durationMs": 16,
            "errorTail": "expected { ok: true, preparation: { …(7) } } to match object { ok: false }\n(8 matching properties omitted from actual)\nactual: {\n  \"ok\": true,\n}\nexpected: {\n  \"ok\": false,\n}"
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
        "id": 22098334,
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
            "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -173,7 +173,7 @@\n   const now = deps.now();\n   if (now < plan.preparedAt || now >= plan.expiresAt ||\n       plan.expiresAt - plan.preparedAt !== ASSUME_TOKEN_TTL_MS) return refuse('expired-token');\n-  if (await deps.authorize(actor, plan.target.role) !== plan.authorizationRef) return refuse('unauthorized');\n+  if (false) return refuse('unauthorized');\n   const caller = await deps.caller(actor);\n   if (JSON.stringify(callerSchema.safeParse(caller).data) !== JSON.stringify(plan.caller)) {\n     return refuse('caller-changed');\n",
            "subjectPath": "packages/operator-core/lib/session-assume.ts",
            "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-9 commit rechecks administrative authority and reviewer restrictions'",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
            "mutateExpression": "s/if \\(await deps\\.authorize\\(actor, plan\\.target\\.role\\) !== plan\\.authorizationRef\\)/if (false)/",
            "probeInvocationId": "e5e53f29-60a1-4f0f-8f6b-1bdfb780fe18",
            "testCommandSha256": "9b1daf2b4eca1c43a1ac69c0e7d8c606e3edb02c38e6e62a6bf70dc150b71c18",
            "subjectAfterSha256": "73ab40a4af6c8c34e2f8a59f26bde75c4241e52b0e3c7422c797cd1dd6d2326d",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
          },
          "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": null,
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-26T02:37:30.318Z",
          "mutationPhase": "mutant",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": "R-9 commit rechecks administrative authority and reviewer restrictions",
          "collectionFailed": false,
          "failedCaseTitles": [
            "session:assume preparation and exact custody > R-9 commit rechecks administrative authority and reviewer restrictions"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "status": "fail",
        "framework": "vitest",
        "startedAt": "2026-10-26T02:37:34.933Z",
        "finishedAt": "2026-10-26T02:37:34.960Z",
        "durationMs": 27,
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": "session:assume preparation and exact custody > R-9 commit rechecks administrative authority and reviewer restrictions: expected { ok: true, preparation: { …(7) } } to deeply equal { ok: false, code: 'unauthorized' }\nactual: {\n  \"ok\": true,\n  \"preparation\": {\n    \"authorizationRef\": \"launch-envelope:admin-1\",\n    \"caller\": {\n      \"attachmentId\": \"pty-a\",\n      \"backend\": \"codex\",\n      \"hostId\": \"host-a\",\n      \"incarnation\": \"caller-start\",\n      \"nativePid\": 101,\n      \"nativeSessionId\": \"caller-native\",\n      \"ownerId\": \"su-caller\",\n      \"workspaceId\": \"workspace-a\",\n    },\n    \"expiresAt\": 121000,\n    \"preparedAt\": 1000,\n    \"requestId\": \"request-a\",\n    \"target\": {\n      \"advSessionId\": 42,\n      \"backend\": \"codex\",\n      \"binding\": {\n        \"coordOwnerId\": \"su-target\",\n        \"ses",
        "loopLagP95Ms": null,
        "rssMb": 182.8,
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
            "status": "fail",
            "durationMs": 21,
            "errorTail": "expected { ok: true, preparation: { …(7) } } to deeply equal { ok: false, code: 'unauthorized' }\nactual: {\n  \"ok\": true,\n  \"preparation\": {\n    \"authorizationRef\": \"launch-envelope:admin-1\",\n    \"caller\": {\n      \"attachmentId\": \"pty-a\",\n      \"backend\": \"codex\",\n      \"hostId\": \"host-a\",\n      \"incarnation\": \"caller-start\",\n      \"nativePid\": 101,\n      \"nativeSessionId\": \"caller-native\",\n      \"ownerId\": \"su-caller\",\n      \"workspaceId\": \"workspace-a\",\n    },\n    \"expiresAt\": 121000,\n    \"preparedAt\": 1000,\n    \"requestId\": \"request-a\",\n    \"target\": {\n      \"advSessionId\": 42,\n      \"backend\": \"codex\",\n      \"binding\": {\n        \"coordOwnerId\": \"su-target\",\n        \"sessionId\": \"target-native\",\n        \"startedAt\": \"2026-10-23 20:00:00.123456-04\",\n      },\n      \"context\": {\n        \"mode\": \"native-resume\",\n        \"ref\": \"target-native\",\n        \"revision\": \"transcript-7\",\n        \"sha256\": \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\n      },\n      \"ended\": "
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
