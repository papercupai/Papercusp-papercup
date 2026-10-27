---
rel_path: "evidence/identity-assume/recovery75/r6-mutation-ledger.json"
updated_at: 1792981746153
_body: "content"
---

{
  "count": 1,
  "total": 1,
  "truncatedByLimit": false,
  "latestPerFile": false,
  "effectiveSourceFilter": "none (exact testRunIds receipt lookup)",
  "omittedBySourceFilter": 0,
  "runs": [
    {
      "id": 22097651,
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
          "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -354,7 +354,7 @@\n       handoffAttempted = false; // a definite negative ack permits rollback\n       throw new Error('host-refused');\n     }\n-    await record('handoff-accepted');\n+    await record('target-verified');\n     return receipt;\n   } catch (error) {\n     // Keep adapter errors private: command lines, credentials and context text\n",
          "subjectPath": "packages/operator-core/lib/session-assume.ts",
          "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-6 accepted requires later process and routed probe verification'",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
          "mutateExpression": "s/await record\\('handoff-accepted'\\);/await record('target-verified');/",
          "probeInvocationId": "e86cf6b2-352b-46e7-a5ab-1fc7de6fbb06",
          "testCommandSha256": "1954f66a3170adc279d61f01a9715709f197cf930d96e42a838375aa74a1d9f0",
          "subjectAfterSha256": "e091f50cc1e90f13ef8731eab8208c09822131c5286f8cc9bc439b49b78a4482",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
        },
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "testLayer": "unit",
        "runGroupId": null,
        "harnessSlug": null,
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-10-26T02:25:09.434Z",
        "mutationPhase": "mutant",
        "schemaVersion": 1,
        "worktreeDirty": false,
        "testNamePattern": "R-6 accepted requires later process and routed probe verification",
        "collectionFailed": false,
        "failedCaseTitles": [
          "session:assume durable transition boundaries > R-6 accepted requires later process and routed probe verification"
        ],
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
      "status": "fail",
      "framework": "vitest",
      "startedAt": "2026-10-26T02:25:12.380Z",
      "finishedAt": "2026-10-26T02:25:12.400Z",
      "durationMs": 20,
      "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
      "runGroupId": null,
      "source": "mutation-probe",
      "branch": null,
      "outputTail": "session:assume durable transition boundaries > R-6 accepted requires later process and routed probe verification: expected 'target-verified' to be 'handoff-accepted' // Object.is equality\nactual: target-verified\nexpected: handoff-accepted",
      "loopLagP95Ms": null,
      "rssMb": 178.9,
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
          "status": "fail",
          "durationMs": 15,
          "errorTail": "expected 'target-verified' to be 'handoff-accepted' // Object.is equality\nactual: target-verified\nexpected: handoff-accepted"
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
