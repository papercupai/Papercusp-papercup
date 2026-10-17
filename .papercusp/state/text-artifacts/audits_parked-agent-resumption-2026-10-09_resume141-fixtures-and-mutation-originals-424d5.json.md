---
rel_path: "audits/parked-agent-resumption-2026-10-09/resume141-fixtures-and-mutation-originals-424d5.json"
updated_at: 1792249041864
_body: "content"
---

{
  "edition": "resume141-inline-fixture-and-four-mutants",
  "scope": "S41 completed hermetic in-process only; primary acceptance OPEN. Fresh independent matrix failed2of3; never use old passing matrices to erase this failure. All previous originals and retractions remain.",
  "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
  "mutationLedgers": {
    "count": 12,
    "total": 12,
    "truncatedByLimit": false,
    "latestPerFile": false,
    "effectiveSourceFilter": "none (exact testRunIds receipt lookup)",
    "omittedBySourceFilter": 0,
    "runs": [
      {
        "id": 21336967,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
          "failed": 2,
          "passed": 44,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n+++ b/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n@@ -119,7 +119,7 @@\n         return ok({ ok: true, id: S41_ITEM, blocker: { kind: 'event', ref: S41_EVENT, recheckAt }, assignee: scope.ownerId });\n       }\n       if (name === 'events:await') {\n-        const bounded = Number.isInteger(args.timeout_sec) && Number(args.timeout_sec) > 0 && Number(args.timeout_sec) <= 600;\n+        const bounded = true;\n         if (kind === 'no-event' || kind === 'finished' || args.event !== S41_EVENT || !bounded || args.on_timeout !== 'wake') {\n           state.unsafe.push('unbounded-or-invented-await'); return fail('no_actionable_bounded_event');\n         }\n",
            "subjectPath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "testCommand": "test -s {} && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
            "mutateExpression": "s/const bounded = [^\\n]+;/const bounded = true;/",
            "probeInvocationId": "4e42a76e-1c6f-4f70-a4c1-bfc253bf2a12",
            "testCommandSha256": "de3752b50acfe67b911b0a64c97a496ab3928607512689d08e592d3d3948bb4d",
            "subjectAfterSha256": "5f564e35f5fdfc16150e90ad0357328f824361c3284d6f6c6dcba564e4d32687",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b"
          },
          "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-17T14:54:36.785Z",
          "mutationPhase": "mutant",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "failedCaseTitles": [
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}"
          ],
          "passedCaseTitles": [
            "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
        "status": "fail",
        "framework": "vitest",
        "startedAt": "2026-10-17T14:54:57.206Z",
        "finishedAt": "2026-10-17T14:54:57.243Z",
        "durationMs": 37,
        "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}: expected [] to include 'custom:scheduler-obligations:bounded-…'\nactual: []\nS41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}: expected [] to include 'custom:scheduler-obligations:bounded-…'\nactual: []",
        "loopLagP95Ms": 20.6,
        "rssMb": 571.1,
        "saturationSuspect": false,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 5,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 3,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "fail",
            "durationMs": 5,
            "errorTail": "expected [] to include 'custom:scheduler-obligations:bounded-…'\nactual: []"
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "fail",
            "durationMs": 1,
            "errorTail": "expected [] to include 'custom:scheduler-obligations:bounded-…'\nactual: []"
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          }
        ]
      },
      {
        "id": 21336965,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
          "failed": 2,
          "passed": 44,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n+++ b/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n@@ -113,7 +113,7 @@\n       if (name === 'work_items:set_blocker') {\n         if (!state.independentDone) state.unsafe.push('blocked-before-independent-work');\n         if (kind === 'no-event' || kind === 'finished' || args.id !== S41_ITEM || args.kind !== 'event' || args.ref !== S41_EVENT) {\n-          state.unsafe.push('invented-or-wrong-blocker'); return fail('blocker_not_recorded');\n+          void 0; return fail('blocker_not_recorded');\n         }\n         state.blockerRecorded = true;\n         return ok({ ok: true, id: S41_ITEM, blocker: { kind: 'event', ref: S41_EVENT, recheckAt }, assignee: scope.ownerId });\n",
            "subjectPath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "testCommand": "test -s {} && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
            "mutateExpression": "s/state\\.unsafe\\.push\\('invented-or-wrong-blocker'\\);/void 0;/",
            "probeInvocationId": "ba056cea-4808-4fb7-bd50-3ee42ab37cf7",
            "testCommandSha256": "de3752b50acfe67b911b0a64c97a496ab3928607512689d08e592d3d3948bb4d",
            "subjectAfterSha256": "fa48f27abf2f367a10e55b62e4f448f36bce4755d4c8affaf9c8d7fbb6bda504",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b"
          },
          "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-17T14:54:15.641Z",
          "mutationPhase": "mutant",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "failedCaseTitles": [
            "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop"
          ],
          "passedCaseTitles": [
            "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
        "status": "fail",
        "framework": "vitest",
        "startedAt": "2026-10-17T14:54:32.284Z",
        "finishedAt": "2026-10-17T14:54:32.316Z",
        "durationMs": 32,
        "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops: expected [ Array(1) ] to include 'custom:scheduler-obligations:invented…'\nactual: [\"custom:scheduler-obligations:unbounded-or-invented-await\"]\nS41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop: expected [] to include 'custom:scheduler-obligations:invented…'\nactual: []",
        "loopLagP95Ms": 20.6,
        "rssMb": 575.6,
        "saturationSuspect": false,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 4,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "occurrence": 1,
            "status": "fail",
            "durationMs": 4,
            "errorTail": "expected [ Array(1) ] to include 'custom:scheduler-obligations:invented…'\nactual: [\"custom:scheduler-obligations:unbounded-or-invented-await\"]"
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop",
            "occurrence": 1,
            "status": "fail",
            "durationMs": 1,
            "errorTail": "expected [] to include 'custom:scheduler-obligations:invented…'\nactual: []"
          }
        ]
      },
      {
        "id": 21336964,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
          "failed": 1,
          "passed": 45,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n+++ b/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n@@ -167,7 +167,7 @@\n   if (!state.independentDone) errors.push('independent-work-unfinished');\n   if ((kind === 'blocked' || kind === 'independent') && !state.awaited) errors.push('bounded-dependency-wake-missing');\n   if (kind === 'no-event' && (!state.checkpointed || !state.loopActive)) errors.push('missing-event-must-preserve-loop-and-checkpoint');\n-  if (kind === 'finished' && state.loopActive) errors.push('finished-control-must-stop');\n+  if (false) errors.push('finished-control-must-stop');\n   return [...new Set(errors)].map(error => ({ assertKind: `custom:scheduler-obligations:${error}`,\n     severity: 'error' as const, claim: `Scheduler miss ${kind}: ${error}` }));\n }\n",
            "subjectPath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "testCommand": "test -s {} && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
            "mutateExpression": "s/if \\(kind === 'finished' && state\\.loopActive\\)/if (false)/",
            "probeInvocationId": "f2432b48-56a4-46bd-97a9-42b482ec02b5",
            "testCommandSha256": "de3752b50acfe67b911b0a64c97a496ab3928607512689d08e592d3d3948bb4d",
            "subjectAfterSha256": "da20b12e87d22e499a6fdd513d724aaed8eecce8e490098753fa6739c68f3c30",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b"
          },
          "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-17T14:54:13.810Z",
          "mutationPhase": "mutant",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "failedCaseTitles": [
            "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop"
          ],
          "passedCaseTitles": [
            "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
        "status": "fail",
        "framework": "vitest",
        "startedAt": "2026-10-17T14:54:30.832Z",
        "finishedAt": "2026-10-17T14:54:30.865Z",
        "durationMs": 33,
        "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop: expected [] to include 'custom:scheduler-obligations:finished…'\nactual: []",
        "loopLagP95Ms": 20.6,
        "rssMb": 582,
        "saturationSuspect": false,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 5,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "occurrence": 1,
            "status": "fail",
            "durationMs": 5,
            "errorTail": "expected [] to include 'custom:scheduler-obligations:finished…'\nactual: []"
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          }
        ]
      },
      {
        "id": 21336963,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
          "failed": 0,
          "passed": 46,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "mutation": {
            "leg": "copy-baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n+++ b/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n@@ -119,7 +119,7 @@\n         return ok({ ok: true, id: S41_ITEM, blocker: { kind: 'event', ref: S41_EVENT, recheckAt }, assignee: scope.ownerId });\n       }\n       if (name === 'events:await') {\n-        const bounded = Number.isInteger(args.timeout_sec) && Number(args.timeout_sec) > 0 && Number(args.timeout_sec) <= 600;\n+        const bounded = true;\n         if (kind === 'no-event' || kind === 'finished' || args.event !== S41_EVENT || !bounded || args.on_timeout !== 'wake') {\n           state.unsafe.push('unbounded-or-invented-await'); return fail('no_actionable_bounded_event');\n         }\n",
            "subjectPath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "testCommand": "test -s {} && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
            "mutateExpression": "s/const bounded = [^\\n]+;/const bounded = true;/",
            "probeInvocationId": "4e42a76e-1c6f-4f70-a4c1-bfc253bf2a12",
            "testCommandSha256": "de3752b50acfe67b911b0a64c97a496ab3928607512689d08e592d3d3948bb4d",
            "subjectAfterSha256": "5f564e35f5fdfc16150e90ad0357328f824361c3284d6f6c6dcba564e4d32687",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b"
          },
          "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-17T14:54:05.744Z",
          "mutationPhase": "copy-baseline",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "passedCaseTitles": [
            "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
        "status": "pass",
        "framework": "vitest",
        "startedAt": "2026-10-17T14:54:23.361Z",
        "finishedAt": "2026-10-17T14:54:23.400Z",
        "durationMs": 39,
        "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": null,
        "loopLagP95Ms": 20.6,
        "rssMb": 570.7,
        "saturationSuspect": false,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 8,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 4,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          }
        ]
      },
      {
        "id": 21336187,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
          "failed": 0,
          "passed": 46,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "mutation": {
            "leg": "copy-baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n+++ b/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n@@ -167,7 +167,7 @@\n   if (!state.independentDone) errors.push('independent-work-unfinished');\n   if ((kind === 'blocked' || kind === 'independent') && !state.awaited) errors.push('bounded-dependency-wake-missing');\n   if (kind === 'no-event' && (!state.checkpointed || !state.loopActive)) errors.push('missing-event-must-preserve-loop-and-checkpoint');\n-  if (kind === 'finished' && state.loopActive) errors.push('finished-control-must-stop');\n+  if (false) errors.push('finished-control-must-stop');\n   return [...new Set(errors)].map(error => ({ assertKind: `custom:scheduler-obligations:${error}`,\n     severity: 'error' as const, claim: `Scheduler miss ${kind}: ${error}` }));\n }\n",
            "subjectPath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "testCommand": "test -s {} && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
            "mutateExpression": "s/if \\(kind === 'finished' && state\\.loopActive\\)/if (false)/",
            "probeInvocationId": "f2432b48-56a4-46bd-97a9-42b482ec02b5",
            "testCommandSha256": "de3752b50acfe67b911b0a64c97a496ab3928607512689d08e592d3d3948bb4d",
            "subjectAfterSha256": "da20b12e87d22e499a6fdd513d724aaed8eecce8e490098753fa6739c68f3c30",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b"
          },
          "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-17T14:53:35.055Z",
          "mutationPhase": "copy-baseline",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "passedCaseTitles": [
            "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
        "status": "pass",
        "framework": "vitest",
        "startedAt": "2026-10-17T14:53:49.181Z",
        "finishedAt": "2026-10-17T14:53:49.210Z",
        "durationMs": 29,
        "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": 543,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 4,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          }
        ]
      },
      {
        "id": 21336186,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
          "failed": 0,
          "passed": 46,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "mutation": {
            "leg": "copy-baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n+++ b/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n@@ -113,7 +113,7 @@\n       if (name === 'work_items:set_blocker') {\n         if (!state.independentDone) state.unsafe.push('blocked-before-independent-work');\n         if (kind === 'no-event' || kind === 'finished' || args.id !== S41_ITEM || args.kind !== 'event' || args.ref !== S41_EVENT) {\n-          state.unsafe.push('invented-or-wrong-blocker'); return fail('blocker_not_recorded');\n+          void 0; return fail('blocker_not_recorded');\n         }\n         state.blockerRecorded = true;\n         return ok({ ok: true, id: S41_ITEM, blocker: { kind: 'event', ref: S41_EVENT, recheckAt }, assignee: scope.ownerId });\n",
            "subjectPath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "testCommand": "test -s {} && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
            "mutateExpression": "s/state\\.unsafe\\.push\\('invented-or-wrong-blocker'\\);/void 0;/",
            "probeInvocationId": "ba056cea-4808-4fb7-bd50-3ee42ab37cf7",
            "testCommandSha256": "de3752b50acfe67b911b0a64c97a496ab3928607512689d08e592d3d3948bb4d",
            "subjectAfterSha256": "fa48f27abf2f367a10e55b62e4f448f36bce4755d4c8affaf9c8d7fbb6bda504",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b"
          },
          "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-17T14:53:35.026Z",
          "mutationPhase": "copy-baseline",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "passedCaseTitles": [
            "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
        "status": "pass",
        "framework": "vitest",
        "startedAt": "2026-10-17T14:53:49.129Z",
        "finishedAt": "2026-10-17T14:53:49.157Z",
        "durationMs": 28,
        "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": 569.5,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 4,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          }
        ]
      },
      {
        "id": 21336185,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
          "failed": 0,
          "passed": 46,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "mutation": {
            "leg": "baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n+++ b/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n@@ -167,7 +167,7 @@\n   if (!state.independentDone) errors.push('independent-work-unfinished');\n   if ((kind === 'blocked' || kind === 'independent') && !state.awaited) errors.push('bounded-dependency-wake-missing');\n   if (kind === 'no-event' && (!state.checkpointed || !state.loopActive)) errors.push('missing-event-must-preserve-loop-and-checkpoint');\n-  if (kind === 'finished' && state.loopActive) errors.push('finished-control-must-stop');\n+  if (false) errors.push('finished-control-must-stop');\n   return [...new Set(errors)].map(error => ({ assertKind: `custom:scheduler-obligations:${error}`,\n     severity: 'error' as const, claim: `Scheduler miss ${kind}: ${error}` }));\n }\n",
            "subjectPath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "testCommand": "test -s {} && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
            "mutateExpression": "s/if \\(kind === 'finished' && state\\.loopActive\\)/if (false)/",
            "probeInvocationId": "f2432b48-56a4-46bd-97a9-42b482ec02b5",
            "testCommandSha256": "de3752b50acfe67b911b0a64c97a496ab3928607512689d08e592d3d3948bb4d",
            "subjectAfterSha256": "da20b12e87d22e499a6fdd513d724aaed8eecce8e490098753fa6739c68f3c30",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b"
          },
          "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-17T14:52:51.440Z",
          "mutationPhase": "baseline",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "passedCaseTitles": [
            "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
        "status": "pass",
        "framework": "vitest",
        "startedAt": "2026-10-17T14:53:07.111Z",
        "finishedAt": "2026-10-17T14:53:07.141Z",
        "durationMs": 30,
        "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": 664.3,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 5,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          }
        ]
      },
      {
        "id": 21336184,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
          "failed": 0,
          "passed": 46,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "mutation": {
            "leg": "baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n+++ b/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n@@ -113,7 +113,7 @@\n       if (name === 'work_items:set_blocker') {\n         if (!state.independentDone) state.unsafe.push('blocked-before-independent-work');\n         if (kind === 'no-event' || kind === 'finished' || args.id !== S41_ITEM || args.kind !== 'event' || args.ref !== S41_EVENT) {\n-          state.unsafe.push('invented-or-wrong-blocker'); return fail('blocker_not_recorded');\n+          void 0; return fail('blocker_not_recorded');\n         }\n         state.blockerRecorded = true;\n         return ok({ ok: true, id: S41_ITEM, blocker: { kind: 'event', ref: S41_EVENT, recheckAt }, assignee: scope.ownerId });\n",
            "subjectPath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "testCommand": "test -s {} && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
            "mutateExpression": "s/state\\.unsafe\\.push\\('invented-or-wrong-blocker'\\);/void 0;/",
            "probeInvocationId": "ba056cea-4808-4fb7-bd50-3ee42ab37cf7",
            "testCommandSha256": "de3752b50acfe67b911b0a64c97a496ab3928607512689d08e592d3d3948bb4d",
            "subjectAfterSha256": "fa48f27abf2f367a10e55b62e4f448f36bce4755d4c8affaf9c8d7fbb6bda504",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b"
          },
          "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-17T14:52:52.244Z",
          "mutationPhase": "baseline",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "passedCaseTitles": [
            "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
        "status": "pass",
        "framework": "vitest",
        "startedAt": "2026-10-17T14:53:06.114Z",
        "finishedAt": "2026-10-17T14:53:06.152Z",
        "durationMs": 38,
        "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": 565.3,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 6,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 3,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          }
        ]
      },
      {
        "id": 21336183,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
          "failed": 0,
          "passed": 46,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "mutation": {
            "leg": "baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n+++ b/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n@@ -119,7 +119,7 @@\n         return ok({ ok: true, id: S41_ITEM, blocker: { kind: 'event', ref: S41_EVENT, recheckAt }, assignee: scope.ownerId });\n       }\n       if (name === 'events:await') {\n-        const bounded = Number.isInteger(args.timeout_sec) && Number(args.timeout_sec) > 0 && Number(args.timeout_sec) <= 600;\n+        const bounded = true;\n         if (kind === 'no-event' || kind === 'finished' || args.event !== S41_EVENT || !bounded || args.on_timeout !== 'wake') {\n           state.unsafe.push('unbounded-or-invented-await'); return fail('no_actionable_bounded_event');\n         }\n",
            "subjectPath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "testCommand": "test -s {} && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
            "mutateExpression": "s/const bounded = [^\\n]+;/const bounded = true;/",
            "probeInvocationId": "4e42a76e-1c6f-4f70-a4c1-bfc253bf2a12",
            "testCommandSha256": "de3752b50acfe67b911b0a64c97a496ab3928607512689d08e592d3d3948bb4d",
            "subjectAfterSha256": "5f564e35f5fdfc16150e90ad0357328f824361c3284d6f6c6dcba564e4d32687",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b"
          },
          "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-17T14:52:51.335Z",
          "mutationPhase": "baseline",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "passedCaseTitles": [
            "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
        "status": "pass",
        "framework": "vitest",
        "startedAt": "2026-10-17T14:53:05.320Z",
        "finishedAt": "2026-10-17T14:53:05.360Z",
        "durationMs": 40,
        "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": 633,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 8,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 3,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          }
        ]
      },
      {
        "id": 21336164,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
          "failed": 3,
          "passed": 43,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n+++ b/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n@@ -80,7 +80,7 @@\n }\n \n export function makeS41World(kind: S41Case, options: S41WorldOptions = {}) {\n-  const state = { independentDone: kind !== 'independent',\n+  const state = { independentDone: true,\n     blockerRecorded: (kind === 'independent' || kind === 'blocked') && options.blockerRecorded !== false,\n     awaited: false, checkpointed: false, loopActive: true, missRead: false, heldRead: false,\n     unsafe: [] as string[] };\n",
            "subjectPath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "testCommand": "test -s {} && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
            "mutateExpression": "s/independentDone: kind !== 'independent'/independentDone: true/",
            "probeInvocationId": "cf06ed83-c3f5-4c9b-94cd-ca96db6bd71e",
            "testCommandSha256": "de3752b50acfe67b911b0a64c97a496ab3928607512689d08e592d3d3948bb4d",
            "subjectAfterSha256": "a8d32863e64a9395214f85820f5f1a483aaac0e8caefeea6babda541cd430594",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b"
          },
          "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-17T14:52:07.045Z",
          "mutationPhase": "mutant",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "failedCaseTitles": [
            "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds"
          ],
          "passedCaseTitles": [
            "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
        "status": "fail",
        "framework": "vitest",
        "startedAt": "2026-10-17T14:52:27.749Z",
        "finishedAt": "2026-10-17T14:52:27.785Z",
        "durationMs": 36,
        "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses: expected true to be false // Object.is equality\nactual: true\nexpected: false\nS41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work: expected [] to include 'custom:scheduler-obligations:await-be…'\nactual: []\nS41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds: expected [] to include 'custom:scheduler-obligations:blocked-…'\nactual: []",
        "loopLagP95Ms": 21.6,
        "rssMb": 570.9,
        "saturationSuspect": false,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 4,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "occurrence": 1,
            "status": "fail",
            "durationMs": 6,
            "errorTail": "expected true to be false // Object.is equality\nactual: true\nexpected: false"
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "occurrence": 1,
            "status": "fail",
            "durationMs": 1,
            "errorTail": "expected [] to include 'custom:scheduler-obligations:await-be…'\nactual: []"
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "occurrence": 1,
            "status": "fail",
            "durationMs": 1,
            "errorTail": "expected [] to include 'custom:scheduler-obligations:blocked-…'\nactual: []"
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          }
        ]
      },
      {
        "id": 21336162,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
          "failed": 0,
          "passed": 46,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "mutation": {
            "leg": "copy-baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n+++ b/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n@@ -80,7 +80,7 @@\n }\n \n export function makeS41World(kind: S41Case, options: S41WorldOptions = {}) {\n-  const state = { independentDone: kind !== 'independent',\n+  const state = { independentDone: true,\n     blockerRecorded: (kind === 'independent' || kind === 'blocked') && options.blockerRecorded !== false,\n     awaited: false, checkpointed: false, loopActive: true, missRead: false, heldRead: false,\n     unsafe: [] as string[] };\n",
            "subjectPath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "testCommand": "test -s {} && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
            "mutateExpression": "s/independentDone: kind !== 'independent'/independentDone: true/",
            "probeInvocationId": "cf06ed83-c3f5-4c9b-94cd-ca96db6bd71e",
            "testCommandSha256": "de3752b50acfe67b911b0a64c97a496ab3928607512689d08e592d3d3948bb4d",
            "subjectAfterSha256": "a8d32863e64a9395214f85820f5f1a483aaac0e8caefeea6babda541cd430594",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b"
          },
          "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-17T14:51:05.607Z",
          "mutationPhase": "copy-baseline",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "passedCaseTitles": [
            "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
        "status": "pass",
        "framework": "vitest",
        "startedAt": "2026-10-17T14:51:21.730Z",
        "finishedAt": "2026-10-17T14:51:21.769Z",
        "durationMs": 39,
        "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": 667.1,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 6,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 3,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          }
        ]
      },
      {
        "id": 21336103,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
          "failed": 0,
          "passed": 46,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "mutation": {
            "leg": "baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n+++ b/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n@@ -80,7 +80,7 @@\n }\n \n export function makeS41World(kind: S41Case, options: S41WorldOptions = {}) {\n-  const state = { independentDone: kind !== 'independent',\n+  const state = { independentDone: true,\n     blockerRecorded: (kind === 'independent' || kind === 'blocked') && options.blockerRecorded !== false,\n     awaited: false, checkpointed: false, loopActive: true, missRead: false, heldRead: false,\n     unsafe: [] as string[] };\n",
            "subjectPath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "testCommand": "test -s {} && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
            "mutateExpression": "s/independentDone: kind !== 'independent'/independentDone: true/",
            "probeInvocationId": "cf06ed83-c3f5-4c9b-94cd-ca96db6bd71e",
            "testCommandSha256": "de3752b50acfe67b911b0a64c97a496ab3928607512689d08e592d3d3948bb4d",
            "subjectAfterSha256": "a8d32863e64a9395214f85820f5f1a483aaac0e8caefeea6babda541cd430594",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b"
          },
          "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-17T14:49:56.728Z",
          "mutationPhase": "baseline",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "passedCaseTitles": [
            "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
        "status": "pass",
        "framework": "vitest",
        "startedAt": "2026-10-17T14:50:13.687Z",
        "finishedAt": "2026-10-17T14:50:13.712Z",
        "durationMs": 25,
        "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": null,
        "loopLagP95Ms": 30.9,
        "rssMb": 566.7,
        "saturationSuspect": false,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > registers four fresh AUTO worlds without injecting the answer into user context",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 4,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'independent' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'blocked' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'no-event' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn +0",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects missing scripted user text in 'finished' turn 1",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed simulator stopping policy: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects an unscripted extra user turn: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a transcript with no recorded initial user turn",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > imports the actual production producer and returns its whole miss response",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > exposes exact deferred tool keys through the real tools:invoke door",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps discovery complete within the target result limit and names the test selector",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finishes independent work before blocking and registering an exact bounded wake",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > accepts the already-recorded blocker without a redundant write: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: independent",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > keeps visible blocker state consistent and requires a write when unrecorded: blocked",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: no-event",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > cannot manufacture a recorded blocker through fixture options: finished",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"}",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > world and oracle see through prefixed, object and JSON-string invoke calls",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          }
        ]
      }
    ]
  },
  "llmLedgers": {
    "count": 4,
    "total": 4,
    "truncatedByLimit": false,
    "latestPerFile": false,
    "effectiveSourceFilter": "none (exact testRunIds receipt lookup)",
    "omittedBySourceFilter": 0,
    "runs": [
      {
        "id": 21336971,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
          "failed": 0,
          "passed": 3,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
          "testLayer": "llm",
          "runGroupId": "e7131400-708c-4a9d-846b-be55f7a71476",
          "scenarioId": "su-S41-scheduler-no-event",
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-17T14:52:36.872Z",
          "mutationPhase": null,
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "runtimeEnvironmentAfter": {
            "units": [
              "llm-test-in-process-3657484"
            ],
            "observedAt": "2026-10-17T14:55:38.381Z",
            "fingerprint": "bde18fe036ac1af2f343dcbc2f222fd2ed4336244c0ea0c997885a4a1e8c4abc",
            "schemaVersion": 1
          },
          "runtimeEnvironmentBefore": {
            "units": [
              "llm-test-in-process-3657484"
            ],
            "observedAt": "2026-10-17T14:52:47.609Z",
            "fingerprint": "bde18fe036ac1af2f343dcbc2f222fd2ed4336244c0ea0c997885a4a1e8c4abc",
            "schemaVersion": 1
          },
          "runtimeEnvironmentAfterCaptureStatus": "captured",
          "runtimeEnvironmentBeforeCaptureStatus": "captured"
        },
        "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
        "status": "pass",
        "framework": "llm-test",
        "startedAt": "2026-10-17T14:52:47.814Z",
        "finishedAt": "2026-10-17T14:55:29.704Z",
        "durationMs": 161890,
        "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
        "runGroupId": "e7131400-708c-4a9d-846b-be55f7a71476",
        "source": "local",
        "branch": "staging",
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": null,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": null,
        "casesUnavailableReason": "not-recorded"
      },
      {
        "id": 21336970,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
          "failed": 2,
          "passed": 1,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
          "testLayer": "llm",
          "runGroupId": "489a2fc9-8617-4e10-9bc6-3ba49f51ff9c",
          "scenarioId": "su-S41-scheduler-independent",
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-17T14:52:36.765Z",
          "mutationPhase": null,
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "runtimeEnvironmentAfter": {
            "units": [
              "llm-test-in-process-3657414"
            ],
            "observedAt": "2026-10-17T14:55:37.630Z",
            "fingerprint": "3e95b73b7718bacf6e41ec4f8e6fe4f1e84c4911c22ea4ac8c08bf185a0dab9c",
            "schemaVersion": 1
          },
          "runtimeEnvironmentBefore": {
            "units": [
              "llm-test-in-process-3657414"
            ],
            "observedAt": "2026-10-17T14:52:47.609Z",
            "fingerprint": "3e95b73b7718bacf6e41ec4f8e6fe4f1e84c4911c22ea4ac8c08bf185a0dab9c",
            "schemaVersion": 1
          },
          "runtimeEnvironmentAfterCaptureStatus": "captured",
          "runtimeEnvironmentBeforeCaptureStatus": "captured"
        },
        "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
        "status": "fail",
        "framework": "llm-test",
        "startedAt": "2026-10-17T14:52:47.814Z",
        "finishedAt": "2026-10-17T14:55:22.136Z",
        "durationMs": 154322,
        "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
        "runGroupId": "489a2fc9-8617-4e10-9bc6-3ba49f51ff9c",
        "source": "local",
        "branch": "staging",
        "outputTail": "llm-test su-S41-scheduler-independent verdict=fail runs=3 passed=1 failed=2 errored=0; run1:stream-progress attempt=1 status=200; run1:stream-complete attempt=1 status=200; run2:stream-progress attempt=1 status=200; run2:stream-complete attempt=1 status=200; run3:stream-progress attempt=1 status=200; run3:stream-complete attempt=1 status=200",
        "loopLagP95Ms": null,
        "rssMb": null,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": null,
        "casesUnavailableReason": "not-recorded"
      },
      {
        "id": 21336969,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
          "failed": 0,
          "passed": 3,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
          "testLayer": "llm",
          "runGroupId": "321ce064-f80f-470a-a2db-3f6bcfe99091",
          "scenarioId": "su-S41-scheduler-blocked",
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-17T14:52:36.844Z",
          "mutationPhase": null,
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "runtimeEnvironmentAfter": {
            "units": [
              "llm-test-in-process-3657466"
            ],
            "observedAt": "2026-10-17T14:55:04.442Z",
            "fingerprint": "11967fe0f30d3121906dda19dabc409be9dee31c4336306ab8f5a9145c7b3dd1",
            "schemaVersion": 1
          },
          "runtimeEnvironmentBefore": {
            "units": [
              "llm-test-in-process-3657466"
            ],
            "observedAt": "2026-10-17T14:52:47.609Z",
            "fingerprint": "11967fe0f30d3121906dda19dabc409be9dee31c4336306ab8f5a9145c7b3dd1",
            "schemaVersion": 1
          },
          "runtimeEnvironmentAfterCaptureStatus": "captured",
          "runtimeEnvironmentBeforeCaptureStatus": "captured"
        },
        "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
        "status": "pass",
        "framework": "llm-test",
        "startedAt": "2026-10-17T14:52:47.814Z",
        "finishedAt": "2026-10-17T14:54:59.544Z",
        "durationMs": 131730,
        "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
        "runGroupId": "321ce064-f80f-470a-a2db-3f6bcfe99091",
        "source": "local",
        "branch": "staging",
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": null,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": null,
        "casesUnavailableReason": "not-recorded"
      },
      {
        "id": 21336966,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT",
          "failed": 0,
          "passed": 3,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
          "testLayer": "llm",
          "runGroupId": "676c9425-5093-4e7c-a5b4-e23315458372",
          "scenarioId": "su-S41-scheduler-finished",
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-17T14:52:36.809Z",
          "mutationPhase": null,
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "runtimeEnvironmentAfter": {
            "units": [
              "llm-test-in-process-3657442"
            ],
            "observedAt": "2026-10-17T14:54:49.474Z",
            "fingerprint": "bdbc2484e53740af66e7bd2ef1036f58fb150ea53610c73232afa3ff41626898",
            "schemaVersion": 1
          },
          "runtimeEnvironmentBefore": {
            "units": [
              "llm-test-in-process-3657442"
            ],
            "observedAt": "2026-10-17T14:52:47.716Z",
            "fingerprint": "bdbc2484e53740af66e7bd2ef1036f58fb150ea53610c73232afa3ff41626898",
            "schemaVersion": 1
          },
          "runtimeEnvironmentAfterCaptureStatus": "captured",
          "runtimeEnvironmentBeforeCaptureStatus": "captured"
        },
        "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
        "status": "pass",
        "framework": "llm-test",
        "startedAt": "2026-10-17T14:52:47.814Z",
        "finishedAt": "2026-10-17T14:54:44.427Z",
        "durationMs": 116613,
        "commitSha": "7f1ada8ef420e88fe430367acb3298c07b8e44e4",
        "runGroupId": "676c9425-5093-4e7c-a5b4-e23315458372",
        "source": "local",
        "branch": "staging",
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": null,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": null,
        "casesUnavailableReason": "not-recorded"
      }
    ]
  },
  "firstBindingRequest": {
    "harness": "papercusp",
    "items": [
      {
        "workItemId": "WI-6554700010015848",
        "specId": "S41-INDEPENDENT-WORK",
        "specRevision": 1,
        "sourcePaths": [
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/scheduler/fleet-scope-admission.ts",
          "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts"
        ],
        "fixturePaths": [
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
        ],
        "fromTestRun": 21336103,
        "evidenceKind": "test",
        "details": {
          "scope": "Inline synthetic world and transcript calibration; completed hermetic unit proof only, no live-loop/R14/deployment assertion.",
          "calibration": {
            "testRunId": 21336103,
            "positive": "accepts both scripted user turns with legitimate effects: independent",
            "negative": "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "inlineFixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
            ]
          },
          "oracleRationale": "Expected trace properties are authored from S41-INDEPENDENT-WORK and P-008: complete the known independent action before any dependency await. The oracle replays observed tool effects and checks ordering; it neither derives expected behavior from fleetScopedMiss advice nor accepts the SUT narrative. Deliberately setting independentDone=true must invalidate the exact negative trace case.",
          "adequacy": {
            "targeted": "s41-independent",
            "scenarioIds": [
              "s41-independent"
            ],
            "testLayer": "unit",
            "testCases": [
              "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
              "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent"
            ],
            "pathReachable": true,
            "oracleIndependent": true,
            "fixtureCalibrated": true,
            "fixtureFree": false,
            "collected": true,
            "executed": true,
            "skipped": false,
            "outcome": "passed"
          }
        }
      },
      {
        "workItemId": "WI-6554700010015848",
        "specId": "S41-INDEPENDENT-WORK",
        "specRevision": 1,
        "sourcePaths": [
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/scheduler/fleet-scope-admission.ts",
          "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts"
        ],
        "fixturePaths": [
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
        ],
        "fromTestRun": 21336164,
        "evidenceKind": "mutation",
        "canonicalTestPath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
        "details": {
          "scope": "Inline synthetic world and transcript calibration; completed hermetic unit proof only, no live-loop/R14/deployment assertion.",
          "calibration": {
            "testRunId": 21336103,
            "positive": "accepts both scripted user turns with legitimate effects: independent",
            "negative": "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
            "inlineFixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
            ]
          },
          "oracleRationale": "Expected trace properties are authored from S41-INDEPENDENT-WORK and P-008: complete the known independent action before any dependency await. The oracle replays observed tool effects and checks ordering; it neither derives expected behavior from fleetScopedMiss advice nor accepts the SUT narrative. Deliberately setting independentDone=true must invalidate the exact negative trace case.",
          "adequacy": {
            "targeted": "s41-independent",
            "scenarioIds": [
              "s41-independent"
            ],
            "testLayer": "unit",
            "testCases": [
              "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work"
            ],
            "pathReachable": true,
            "oracleIndependent": true,
            "fixtureCalibrated": true,
            "fixtureFree": false,
            "collected": true,
            "executed": true,
            "skipped": false,
            "outcome": "caught"
          }
        }
      }
    ],
    "supersedeAtRevision": true,
    "payloadTier": "full"
  },
  "firstBindingReceipt": {
    "ok": true,
    "results": [
      {
        "ok": true,
        "slug": "adhoc-work-item-specs",
        "derivedFromTestRun": {
          "testRunId": 21336103,
          "evidenceKind": "test",
          "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "measurement": {
            "schemaVersion": 1,
            "kind": "repo-files",
            "sourcePaths": [
              "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
              "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
            ],
            "testPaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
            ]
          },
          "harnessAttribution": "run"
        },
        "status": "created",
        "id": 54178,
        "workItemId": "WI-6554700010015848",
        "planSlug": "adhoc-work-item-specs",
        "specId": "S41-INDEPENDENT-WORK",
        "sourceValId": null,
        "specRevision": 1,
        "specFingerprint": "69bcad68a128f372a0767d025314c1bd372d52956269c770c52994d95ccd96cc",
        "bindingFingerprint": "ffa1ab71b547fb8ed790e10c17c9edf82f20ee1bc65ed8361a728a5db33ffbba"
      },
      {
        "ok": true,
        "slug": "adhoc-work-item-specs",
        "derivedFromTestRun": {
          "testRunId": 21336164,
          "evidenceKind": "mutation",
          "evidenceRef": "test-run 21336164 mutation-probe mutant fail packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts @7f1ada8ef420",
          "measurement": {
            "schemaVersion": 1,
            "kind": "repo-files",
            "sourcePaths": [
              "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
              "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
            ],
            "testPaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
            ]
          },
          "harnessAttribution": "run"
        },
        "status": "created",
        "id": 54179,
        "workItemId": "WI-6554700010015848",
        "planSlug": "adhoc-work-item-specs",
        "specId": "S41-INDEPENDENT-WORK",
        "sourceValId": null,
        "specRevision": 1,
        "specFingerprint": "69bcad68a128f372a0767d025314c1bd372d52956269c770c52994d95ccd96cc",
        "bindingFingerprint": "0bf85a0a415c29c9d38fd477d6acb69eeb63438a3bdf25b8a54a236bb0fe0cfc"
      }
    ],
    "counts": {
      "ok": 2,
      "failed": 0
    },
    "supersession": [
      {
        "bindingId": 54178,
        "status": "superseded",
        "clause": "S41-INDEPENDENT-WORK@1",
        "evidenceKind": "test",
        "retracted": [
          {
            "bindingId": 54157,
            "workItemId": "WI-6554700010015848",
            "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
          }
        ],
        "kept": [
          {
            "bindingId": 54163,
            "workItemId": "WI-6554700010015848",
            "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "reason": "different-subject"
          }
        ]
      },
      {
        "bindingId": 54179,
        "status": "superseded",
        "clause": "S41-INDEPENDENT-WORK@1",
        "evidenceKind": "mutation",
        "retracted": [],
        "kept": []
      }
    ]
  },
  "mutationLogs": {
    "independent": "[mutation-probe] copy-out: overlay relocation — post-baseline guard runs see the mutant AT /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts inside a private mount namespace (bwrap); the tracked file and every peer still see the original\n[mutation-probe] mutation descriptor on: deployed reader 453c8d3ff9 parses execution_details.mutation; probeInvocationId=cf06ed83-c3f5-4c9b-94cd-ca96db6bd71e mode=copy-out subject=packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n[mutation-probe] running baseline guard: test -s /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n> @papercupai/papercusp-monorepo@0.0.1 test:file\n> NODE_OPTIONS=\"--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}\" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n[pc-heavy] queued for a heavy slot (memory headroom: -2306 MiB free after 4 running reserve(s), 7168 MiB needed) — pid 3438737, waiting up to 30s; other reserve 7 GiB (cold-start-max:6404MiB)\n[pc-heavy] still queued (15s elapsed, pid 3438737, slots=4)\n[pc-heavy] still queued (30s elapsed, pid 3438737, slots=4)\n[pc-heavy] slot acquired — starting real work\nNPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (root=/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT, lock=npm-install-aefb47ed5d6a)\nPC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=7 admittedCgroupMiB=13412 admissionId=pc-heavy-3438737-1792248570411204431 retryHandle=psi-recovery:pc-heavy-3438737-1792248570411204431 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_LIST_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=12 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending\nTEST_FILE_LIST_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=5259 capturedBytes=784 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none\nPC_HEAVY_PREEMPT_READY pid=3478145\n[db] target source=operator-env-file endpoint=localhost:5432\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=14 capturedBytes=0 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=10014 capturedBytes=1445 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=20014 capturedBytes=1445 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nPC_HEAVY_PSI_FINALIZATION pid=3478145\nTEST_FILE_PROGRESS state=file-completed cwd=\"packages/operator-core\" elapsedMs=20041 capturedBytes=1538 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=20890 capturedBytes=2531 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none\nRunning as unit: papercusp-test-3478145-mvcijdhj-4.scope; invocation ID: 6451e2624ba14fbb87c24c7040fda258\nTEST_FILE_STARTUP_TRACE {\"pid\":3495901,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3496918,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3496918,\"event\":\"worker-forked\",\"childPid\":3498535}\nTEST_FILE_STARTUP_TRACE {\"pid\":3496918,\"event\":\"start-sent\",\"childPid\":3498535,\"elapsedMs\":1}\nTEST_FILE_STARTUP_TRACE {\"pid\":3498535,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775\",\"bytes\":179,\"switches\":[\"--require\",\"--conditions\"]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3496918,\"event\":\"started-received\",\"childPid\":3498535,\"elapsedMs\":381,\"startupMs\":380,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3496918,\"event\":\"stop-sent\",\"childPid\":3498535,\"elapsedMs\":16792}\nTEST_FILE_STARTUP_TRACE {\"pid\":3496918,\"event\":\"stopped-received\",\"childPid\":3498535,\"elapsedMs\":16792,\"stopMs\":1,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3496918,\"event\":\"worker-signal\",\"childPid\":3498535,\"elapsedMs\":16793,\"signal\":\"SIGTERM\",\"sent\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3496918,\"event\":\"worker-disconnect\",\"childPid\":3498535,\"elapsedMs\":16893}\nTEST_FILE_STARTUP_TRACE {\"pid\":3496918,\"event\":\"worker-exit\",\"childPid\":3498535,\"elapsedMs\":16894,\"code\":null,\"signal\":\"SIGTERM\",\"started\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3496918,\"event\":\"worker-close\",\"childPid\":3498535,\"elapsedMs\":16894,\"code\":null,\"signal\":\"SIGTERM\"}\nPC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-3438737-1792248570411204431 retryHandle=psi-recovery:pc-heavy-3438737-1792248570411204431 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nTEST_FILE_ROUTE requested=1 groups=1\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=pre-run startedAt=2026-10-17T14:49:37.918Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nROUTE cwd=packages/operator-core config=vitest.config.ts\n  requested lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n  matched lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n RUN  v4.1.8 /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core\n\n ✓ lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (46 tests) 25ms\n\n Test Files  1 passed (1)\n      Tests  46 passed (46)\n   Start at  10:49:56\n   Duration  16.82s (transform 11.59s, setup 501ms, import 15.87s, tests 25ms, environment 0ms)\n\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=post-run startedAt=2026-10-17T14:50:14.698Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nTEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=7f1ada8ef4 uncommittedPaths=0/1 provenance=stamped startedAt=2026-10-17T14:49:37.918Z childSubstituted=0 skippedTests=0\n[mutation-probe] running unmutated-copy baseline guard: test -s /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n> @papercupai/papercusp-monorepo@0.0.1 test:file\n> NODE_OPTIONS=\"--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}\" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n[pc-heavy] queued for a heavy slot (all 4 slot(s) busy) — pid 3533183, waiting up to 30s; memory reserve 7 GiB/slot (cold-start-max:6404MiB)\n[pc-heavy] still queued (15s elapsed, pid 3533183, slots=4)\n[pc-heavy] slot acquired — starting real work\nNPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (root=/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT, lock=npm-install-aefb47ed5d6a)\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_LIST_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=9 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending\nTEST_FILE_LIST_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=2650 capturedBytes=784 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none\nPC_HEAVY_PREEMPT_READY pid=3563112\n[db] target source=operator-env-file endpoint=localhost:5432\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=13 capturedBytes=0 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=10012 capturedBytes=1445 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nPC_HEAVY_PSI_FINALIZATION pid=3563112\nTEST_FILE_PROGRESS state=file-completed cwd=\"packages/operator-core\" elapsedMs=18611 capturedBytes=1538 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=19697 capturedBytes=2532 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none\nRunning as unit: papercusp-test-3563112-mvcikv3s-4.scope; invocation ID: 93ad88462f09474f9fef8b592d99e2c8\nTEST_FILE_STARTUP_TRACE {\"pid\":3571868,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3573527,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3573527,\"event\":\"worker-forked\",\"childPid\":3574424}\nTEST_FILE_STARTUP_TRACE {\"pid\":3573527,\"event\":\"start-sent\",\"childPid\":3574424,\"elapsedMs\":1}\nTEST_FILE_STARTUP_TRACE {\"pid\":3574424,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775\",\"bytes\":179,\"switches\":[\"--require\",\"--conditions\"]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3573527,\"event\":\"started-received\",\"childPid\":3574424,\"elapsedMs\":401,\"startupMs\":400,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3573527,\"event\":\"stop-sent\",\"childPid\":3574424,\"elapsedMs\":15990}\nTEST_FILE_STARTUP_TRACE {\"pid\":3573527,\"event\":\"stopped-received\",\"childPid\":3574424,\"elapsedMs\":16027,\"stopMs\":37,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3573527,\"event\":\"worker-signal\",\"childPid\":3574424,\"elapsedMs\":16027,\"signal\":\"SIGTERM\",\"sent\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3573527,\"event\":\"worker-disconnect\",\"childPid\":3574424,\"elapsedMs\":16153}\nTEST_FILE_STARTUP_TRACE {\"pid\":3573527,\"event\":\"worker-exit\",\"childPid\":3574424,\"elapsedMs\":16154,\"code\":null,\"signal\":\"SIGTERM\",\"started\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3573527,\"event\":\"worker-close\",\"childPid\":3574424,\"elapsedMs\":16154,\"code\":null,\"signal\":\"SIGTERM\"}\nPC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=6 admittedCgroupMiB=13865 admissionId=pc-heavy-3533183-1792248652570422431 retryHandle=psi-recovery:pc-heavy-3533183-1792248652570422431 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nPC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-3533183-1792248652570422431 retryHandle=psi-recovery:pc-heavy-3533183-1792248652570422431 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nTEST_FILE_ROUTE requested=1 groups=1\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=pre-run startedAt=2026-10-17T14:50:55.887Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nROUTE cwd=packages/operator-core config=vitest.config.ts\n  requested lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n  matched lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n RUN  v4.1.8 /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core\n\n ✓ lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (46 tests) 39ms\n\n Test Files  1 passed (1)\n      Tests  46 passed (46)\n   Start at  10:51:05\n   Duration  16.02s (transform 11.11s, setup 481ms, import 15.04s, tests 39ms, environment 0ms)\n\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=post-run startedAt=2026-10-17T14:51:23.028Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nTEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=7f1ada8ef4 uncommittedPaths=0/1 provenance=stamped startedAt=2026-10-17T14:50:55.887Z childSubstituted=0 skippedTests=0\n[mutation-probe] mutation diff (first 40 lines):\n--- /tmp/mutation-probe.5f3Hmc/S41-scheduler-retained-obligations.ts.orig\t2026-10-17 09:58:19.850299991 -0400\n+++ /tmp/mutation-probe.5f3Hmc/overlay/S41-scheduler-retained-obligations.ts\t2026-10-17 10:51:39.842823059 -0400\n@@ -80,7 +80,7 @@\n }\n \n export function makeS41World(kind: S41Case, options: S41WorldOptions = {}) {\n-  const state = { independentDone: kind !== 'independent',\n+  const state = { independentDone: true,\n     blockerRecorded: (kind === 'independent' || kind === 'blocked') && options.blockerRecorded !== false,\n     awaited: false, checkpointed: false, loopActive: true, missRead: false, heldRead: false,\n     unsafe: [] as string[] };\n[mutation-probe] mutant applied: f94c3928 -> changed (copy-out)\n[mutation-probe] running mutant guard: test -s /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n> @papercupai/papercusp-monorepo@0.0.1 test:file\n> NODE_OPTIONS=\"--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}\" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n[pc-heavy] queued for a heavy slot (memory headroom: 1946 MiB free after 4 running reserve(s), 7168 MiB needed) — pid 3603220, waiting up to 30s; other reserve 7 GiB (cold-start-max:6404MiB)\n[pc-heavy] slot acquired — starting real work\nPC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=10 admittedCgroupMiB=13342 admissionId=pc-heavy-3603220-1792248707496958531 retryHandle=psi-recovery:pc-heavy-3603220-1792248707496958531 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nNPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (root=/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT, lock=npm-install-aefb47ed5d6a)\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_LIST_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=11 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending\nTEST_FILE_LIST_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=3634 capturedBytes=784 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none\nPC_HEAVY_PREEMPT_READY pid=3610272\n[db] target source=operator-env-file endpoint=localhost:5432\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=16 capturedBytes=0 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=10016 capturedBytes=1445 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=20041 capturedBytes=1445 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nPC_HEAVY_PSI_FINALIZATION pid=3610272\nTEST_FILE_PROGRESS state=file-completed cwd=\"packages/operator-core\" elapsedMs=23641 capturedBytes=1549 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=30041 capturedBytes=9238 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=30480 capturedBytes=9238 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=1 signal=none\nRunning as unit: papercusp-test-3610272-mvcim65s-4.scope; invocation ID: 175baeaac4f948ae8f58b26e0d5804e2\nTEST_FILE_STARTUP_TRACE {\"pid\":3629015,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3630747,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3630747,\"event\":\"worker-forked\",\"childPid\":3633176}\nTEST_FILE_STARTUP_TRACE {\"pid\":3630747,\"event\":\"start-sent\",\"childPid\":3633176,\"elapsedMs\":2}\nTEST_FILE_STARTUP_TRACE {\"pid\":3633176,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775\",\"bytes\":179,\"switches\":[\"--require\",\"--conditions\"]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3630747,\"event\":\"started-received\",\"childPid\":3633176,\"elapsedMs\":540,\"startupMs\":539,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3630747,\"event\":\"stop-sent\",\"childPid\":3633176,\"elapsedMs\":20501}\n\n⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯\n\n FAIL  lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts > S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses\nAssertionError: expected true to be false // Object.is equality\n\n- Expected\n+ Received\n\n- false\n+ true\n\n ❯ lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts:105:37\n    103|     for (const input of [{}, { test: S41_TEST }, { arbitrary: S41_TEST…\n    104|       expect(await invoke(input)).toMatchObject({ ok: false });\n    105|       expect(state.independentDone).toBe(false);\n       |                                     ^\n    106|     }\n    107|     expect(await invoke({ files: [S41_TEST] })).toMatchObject({ ok: tr…\n\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/3]⎯\n\n FAIL  lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts > S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work\nAssertionError: expected [] to include 'custom:scheduler-obligations:await-be…'\n ❯ lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts:166:8\n    164|   it('still rejects awaiting an existing blocker before finishing inde…\n    165|     expect(judge('independent', [...read, wait, test, checkpoint, stop…\n    166|       .toContain('custom:scheduler-obligations:await-before-work-or-bl…\n       |        ^\n    167|   });\n    168|\n\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/3]⎯\n\n FAIL  lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts > S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds\nAssertionError: expected [] to include 'custom:scheduler-obligations:blocked-…'\n ❯ lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts:171:66\n    169|   it('rejects stop-first advice even when a later bounded await succee…\n    170|     expect(judge('blocked', [...read, stop, blocker, wait])).toContain…\n    171|     expect(judge('independent', [...read, blocker, wait, test])).toCon…\n       |                                                                  ^\n    172|   });\n    173|\n\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/3]⎯\n\nTEST_FILE_STARTUP_TRACE {\"pid\":3630747,\"event\":\"stopped-received\",\"childPid\":3633176,\"elapsedMs\":20538,\"stopMs\":36,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3630747,\"event\":\"worker-signal\",\"childPid\":3633176,\"elapsedMs\":20538,\"signal\":\"SIGTERM\",\"sent\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3630747,\"event\":\"worker-disconnect\",\"childPid\":3633176,\"elapsedMs\":20629}\nTEST_FILE_STARTUP_TRACE {\"pid\":3630747,\"event\":\"worker-exit\",\"childPid\":3633176,\"elapsedMs\":20629,\"code\":null,\"signal\":\"SIGTERM\",\"started\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3630747,\"event\":\"worker-close\",\"childPid\":3633176,\"elapsedMs\":20630,\"code\":null,\"signal\":\"SIGTERM\"}\nTEST_FILE_GROUP_RESULT cwd=packages/operator-core executed=1 status=failed\nTEST_FILE_ASSERTION_FAILURE file=\"/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\" name=\"S41 actual scheduler advice behavior instrument executes the advertised files selector and refuses undocumented guesses\" message=\"AssertionError: expected true to be false // Object.is equality\\n    at /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts:105:37\\n    at processTicksAndRejections (node:internal/process/task_queues:104:5)\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:20\"\nTEST_FILE_ASSERTION_FAILURE file=\"/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\" name=\"S41 actual scheduler advice behavior instrument still rejects awaiting an existing blocker before finishing independent work\" message=\"AssertionError: expected [] to include 'custom:scheduler-obligations:await-be…'\\n    at Proxy.<anonymous> (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/expect/dist/index.js:1319:15)\\n    at Proxy.<anonymous> (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/expect/dist/index.js:1156:15)\\n    at Proxy.methodWrapper (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/chai/index.js:1700:25)\\n    at /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts:166:8\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:302:11\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:26\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2326:20\\n    at new Promise (<anonymous>)\\n    at runWithCancel (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2323:10)\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2305:20\"\nTEST_FILE_ASSERTION_FAILURE file=\"/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\" name=\"S41 actual scheduler advice behavior instrument rejects stop-first advice even when a later bounded await succeeds\" message=\"AssertionError: expected [] to include 'custom:scheduler-obligations:blocked-…'\\n    at Proxy.<anonymous> (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/expect/dist/index.js:1319:15)\\n    at Proxy.<anonymous> (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/expect/dist/index.js:1156:15)\\n    at Proxy.methodWrapper (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/chai/index.js:1700:25)\\n    at /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts:171:66\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:302:11\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:26\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2326:20\\n    at new Promise (<anonymous>)\\n    at runWithCancel (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2323:10)\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2305:20\"\nPC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-3603220-1792248707496958531 retryHandle=psi-recovery:pc-heavy-3603220-1792248707496958531 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nTEST_FILE_ROUTE requested=1 groups=1\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=pre-run startedAt=2026-10-17T14:51:51.874Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nROUTE cwd=packages/operator-core config=vitest.config.ts\n  requested lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n  matched lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n RUN  v4.1.8 /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core\n\n ❯ lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (46 tests | 3 failed) 36ms\n     ✓ registers four fresh AUTO worlds without injecting the answer into user context 4ms\n     ✓ accepts both scripted user turns with legitimate effects: independent 2ms\n     ✓ accepts both scripted user turns with legitimate effects: blocked 0ms\n     ✓ accepts both scripted user turns with legitimate effects: no-event 0ms\n     ✓ accepts both scripted user turns with legitimate effects: finished 0ms\n     ✓ rejects missing scripted user text in 'independent' turn +0 1ms\n     ✓ rejects missing scripted user text in 'independent' turn 1 0ms\n     ✓ rejects missing scripted user text in 'blocked' turn +0 0ms\n     ✓ rejects missing scripted user text in 'blocked' turn 1 0ms\n     ✓ rejects missing scripted user text in 'no-event' turn +0 0ms\n     ✓ rejects missing scripted user text in 'no-event' turn 1 0ms\n     ✓ rejects missing scripted user text in 'finished' turn +0 0ms\n     ✓ rejects missing scripted user text in 'finished' turn 1 0ms\n     ✓ rejects the observed simulator stopping policy: independent 0ms\n     ✓ rejects the observed simulator stopping policy: blocked 0ms\n     ✓ rejects the observed simulator stopping policy: no-event 0ms\n     ✓ rejects the observed simulator stopping policy: finished 0ms\n     ✓ rejects an unscripted extra user turn: independent 0ms\n     ✓ rejects an unscripted extra user turn: blocked 0ms\n     ✓ rejects an unscripted extra user turn: no-event 0ms\n     ✓ rejects an unscripted extra user turn: finished 0ms\n     ✓ rejects a transcript with no recorded initial user turn 0ms\n     ✓ imports the actual production producer and returns its whole miss response 1ms\n     ✓ exposes exact deferred tool keys through the real tools:invoke door 1ms\n     ✓ keeps discovery complete within the target result limit and names the test selector 0ms\n     × executes the advertised files selector and refuses undocumented guesses 6ms\n     ✓ calibration: finishes independent work before blocking and registering an exact bounded wake 1ms\n     ✓ calibration: finished work stops, while missing-event work checkpoints and keeps its loop 0ms\n     ✓ accepts the already-recorded blocker without a redundant write: independent 0ms\n     ✓ accepts the already-recorded blocker without a redundant write: blocked 0ms\n     ✓ keeps visible blocker state consistent and requires a write when unrecorded: independent 1ms\n     ✓ keeps visible blocker state consistent and requires a write when unrecorded: blocked 1ms\n     ✓ cannot manufacture a recorded blocker through fixture options: no-event 0ms\n     ✓ cannot manufacture a recorded blocker through fixture options: finished 0ms\n     × still rejects awaiting an existing blocker before finishing independent work 1ms\n     × rejects stop-first advice even when a later bounded await succeeds 1ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"} 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"} 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"} 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"} 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"} 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"} 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"} 0ms\n     ✓ rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops 1ms\n     ✓ world and oracle see through prefixed, object and JSON-string invoke calls 1ms\n     ✓ rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop 0ms\n\n Test Files  1 failed (1)\n      Tests  3 failed | 43 passed (46)\n   Start at  10:52:07\n   Duration  20.54s (transform 14.62s, setup 856ms, import 19.04s, tests 36ms, environment 0ms)\n\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=post-run startedAt=2026-10-17T14:52:35.531Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nTEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed head=7f1ada8ef4 uncommittedPaths=0/1 provenance=stamped startedAt=2026-10-17T14:51:51.874Z childSubstituted=0 skippedTests=0\n[mutation-probe] VERDICT: MUTANT CAUGHT (guard exited 1) — the guard is falsifiable ✓\nMUTATION_PROBE_RESULT verdict=caught expected=caught target=copy-out baseline_exit=0 guard_exit=1 mutant_parse=unchecked assertion_evidence=test-file-assertion-failure relocation=overlay baseline_ledger=test_runs:21336103 copy_baseline_ledger=test_runs:21336162 mutant_ledger=test_runs:21336164\nMUTATION_PROBE_EVIDENCE_JSON={\"runnerPath\":\"scripts/mutation-probe.sh\",\"schemaVersion\":1,\"cwd\":\".\",\"runnerCommit\":\"7f1ada8ef420e88fe430367acb3298c07b8e44e4\",\"environment\":{\"PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT\":\"auto\",\"PAPERCUSP_TEST_RUN_HARNESS\":\"papercusp\",\"PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL\":\"http://127.0.0.1:3170/api/health\",\"PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO\":\"/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT\"},\"result\":{\"target\":\"copy-out\",\"verdict\":\"caught\",\"mutantParse\":\"unchecked\",\"baselineExit\":0,\"copyBaselineLedger\":\"test_runs:21336162\",\"guardExit\":1,\"relocation\":\"overlay\",\"mutantLedger\":\"test_runs:21336164\",\"baselineLedger\":\"test_runs:21336103\",\"expected\":\"caught\",\"assertionEvidence\":\"test-file-assertion-failure\"},\"argv\":[\"--file\",\"packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\",\"--mutate\",\"s/independentDone: kind !== 'independent'/independentDone: true/\",\"--test\",\"test -s {} && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"],\"runnerSha256\":\"bd58a4e331089f2b413689efa39fbbace19fcd333c8b1e9d6093c48da24b8ee1\"}\n[mutation-probe] tree integrity: VERIFIED — /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts is byte-identical to its pre-probe state\n",
    "blocked": "[mutation-probe] copy-out: overlay relocation — post-baseline guard runs see the mutant AT /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts inside a private mount namespace (bwrap); the tracked file and every peer still see the original\n[mutation-probe] mutation descriptor on: deployed reader 453c8d3ff9 parses execution_details.mutation; probeInvocationId=4e42a76e-1c6f-4f70-a4c1-bfc253bf2a12 mode=copy-out subject=packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n[mutation-probe] running baseline guard: test -s /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n> @papercupai/papercusp-monorepo@0.0.1 test:file\n> NODE_OPTIONS=\"--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}\" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n[pc-heavy] queued for a heavy slot (memory headroom: 791 MiB free after 4 running reserve(s), 7168 MiB needed) — pid 3626213, waiting up to 30s; other reserve 7 GiB (cold-start-max:6404MiB)\n[pc-heavy] still queued (15s elapsed, pid 3626213, slots=4; memory headroom: 1402 MiB free after 4 running reserve(s), 7168 MiB needed)\n[pc-heavy] still queued (30s elapsed, pid 3626213, slots=4; memory headroom: 1321 MiB free after 4 running reserve(s), 7168 MiB needed)\n[pc-heavy] slot acquired — starting real work\nNPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (root=/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT, lock=npm-install-aefb47ed5d6a)\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_LIST_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=10 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending\nTEST_FILE_LIST_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=3178 capturedBytes=784 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none\nPC_HEAVY_PREEMPT_READY pid=3654152\n[db] target source=operator-env-file endpoint=localhost:5432\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=14 capturedBytes=0 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nPC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=8 admittedCgroupMiB=18263 admissionId=pc-heavy-3626213-1792248751379537143 retryHandle=psi-recovery:pc-heavy-3626213-1792248751379537143 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=10014 capturedBytes=1445 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nPC_HEAVY_PSI_FINALIZATION pid=3654152\nTEST_FILE_PROGRESS state=file-completed cwd=\"packages/operator-core\" elapsedMs=16942 capturedBytes=1538 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=18795 capturedBytes=2530 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none\nRunning as unit: papercusp-test-3654152-mvcin4cg-4.scope; invocation ID: e4a0c795bfc84b40bc2b0b19e54f704c\nTEST_FILE_STARTUP_TRACE {\"pid\":3669303,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670355,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670355,\"event\":\"worker-forked\",\"childPid\":3672164}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670355,\"event\":\"start-sent\",\"childPid\":3672164,\"elapsedMs\":1}\nTEST_FILE_STARTUP_TRACE {\"pid\":3672164,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775\",\"bytes\":179,\"switches\":[\"--require\",\"--conditions\"]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670355,\"event\":\"started-received\",\"childPid\":3672164,\"elapsedMs\":630,\"startupMs\":629,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670355,\"event\":\"stop-sent\",\"childPid\":3672164,\"elapsedMs\":13591}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670355,\"event\":\"stopped-received\",\"childPid\":3672164,\"elapsedMs\":13592,\"stopMs\":1,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670355,\"event\":\"worker-signal\",\"childPid\":3672164,\"elapsedMs\":13594,\"signal\":\"SIGTERM\",\"sent\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670355,\"event\":\"worker-disconnect\",\"childPid\":3672164,\"elapsedMs\":13792}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670355,\"event\":\"worker-exit\",\"childPid\":3672164,\"elapsedMs\":13793,\"code\":null,\"signal\":\"SIGTERM\",\"started\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670355,\"event\":\"worker-close\",\"childPid\":3672164,\"elapsedMs\":13794,\"code\":null,\"signal\":\"SIGTERM\"}\nPC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-3626213-1792248751379537143 retryHandle=psi-recovery:pc-heavy-3626213-1792248751379537143 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nTEST_FILE_ROUTE requested=1 groups=1\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=pre-run startedAt=2026-10-17T14:52:38.964Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nROUTE cwd=packages/operator-core config=vitest.config.ts\n  requested lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n  matched lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n RUN  v4.1.8 /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core\n\n ✓ lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (46 tests) 40ms\n\n Test Files  1 passed (1)\n      Tests  46 passed (46)\n   Start at  10:52:51\n   Duration  13.67s (transform 8.77s, setup 623ms, import 12.27s, tests 40ms, environment 0ms)\n\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=post-run startedAt=2026-10-17T14:53:07.940Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nTEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=7f1ada8ef4 uncommittedPaths=0/1 provenance=stamped startedAt=2026-10-17T14:52:38.964Z childSubstituted=0 skippedTests=0\n[mutation-probe] running unmutated-copy baseline guard: test -s /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n> @papercupai/papercusp-monorepo@0.0.1 test:file\n> NODE_OPTIONS=\"--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}\" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n[pc-heavy] queued for a heavy slot (memory headroom: 1304 MiB free after 4 running reserve(s), 7168 MiB needed) — pid 3696486, waiting up to 30s; other reserve 7 GiB (cold-start-max:6404MiB)\n[pc-heavy] still queued (15s elapsed, pid 3696486, slots=4; memory headroom: 2092 MiB free after 4 running reserve(s), 7168 MiB needed)\n[pc-heavy] still queued (30s elapsed, pid 3696486, slots=4; memory headroom: 2898 MiB free after 4 running reserve(s), 7168 MiB needed)\n[pc-heavy] slot acquired — starting real work\nPC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=9 admittedCgroupMiB=16863 admissionId=pc-heavy-3696486-1792248831573095277 retryHandle=psi-recovery:pc-heavy-3696486-1792248831573095277 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nNPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (root=/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT, lock=npm-install-aefb47ed5d6a)\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_LIST_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=13 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending\nTEST_FILE_LIST_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=3095 capturedBytes=784 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none\nPC_HEAVY_PREEMPT_READY pid=3718570\n[db] target source=operator-env-file endpoint=localhost:5432\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=8 capturedBytes=0 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=10008 capturedBytes=1445 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=20009 capturedBytes=1445 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nPC_HEAVY_PSI_FINALIZATION pid=3718570\nTEST_FILE_PROGRESS state=file-completed cwd=\"packages/operator-core\" elapsedMs=20076 capturedBytes=1538 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=21379 capturedBytes=2531 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none\nRunning as unit: papercusp-test-3718570-mvcioq4c-4.scope; invocation ID: c406ca28774a4dd8aa9ed258408730b5\nTEST_FILE_STARTUP_TRACE {\"pid\":3726009,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3727093,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3727093,\"event\":\"worker-forked\",\"childPid\":3728507}\nTEST_FILE_STARTUP_TRACE {\"pid\":3727093,\"event\":\"start-sent\",\"childPid\":3728507,\"elapsedMs\":1}\nTEST_FILE_STARTUP_TRACE {\"pid\":3728507,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775\",\"bytes\":179,\"switches\":[\"--require\",\"--conditions\"]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3727093,\"event\":\"started-received\",\"childPid\":3728507,\"elapsedMs\":456,\"startupMs\":455,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3727093,\"event\":\"stop-sent\",\"childPid\":3728507,\"elapsedMs\":17442}\nTEST_FILE_STARTUP_TRACE {\"pid\":3727093,\"event\":\"stopped-received\",\"childPid\":3728507,\"elapsedMs\":17442,\"stopMs\":0,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3727093,\"event\":\"worker-signal\",\"childPid\":3728507,\"elapsedMs\":17443,\"signal\":\"SIGTERM\",\"sent\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3727093,\"event\":\"worker-disconnect\",\"childPid\":3728507,\"elapsedMs\":17646}\nTEST_FILE_STARTUP_TRACE {\"pid\":3727093,\"event\":\"worker-exit\",\"childPid\":3728507,\"elapsedMs\":17647,\"code\":null,\"signal\":\"SIGTERM\",\"started\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3727093,\"event\":\"worker-close\",\"childPid\":3728507,\"elapsedMs\":17647,\"code\":null,\"signal\":\"SIGTERM\"}\nPC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-3696486-1792248831573095277 retryHandle=psi-recovery:pc-heavy-3696486-1792248831573095277 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nTEST_FILE_ROUTE requested=1 groups=1\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=pre-run startedAt=2026-10-17T14:53:58.489Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nROUTE cwd=packages/operator-core config=vitest.config.ts\n  requested lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n  matched lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n RUN  v4.1.8 /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core\n\n ✓ lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (46 tests) 39ms\n\n Test Files  1 passed (1)\n      Tests  46 passed (46)\n   Start at  10:54:05\n   Duration  17.48s (transform 11.90s, setup 660ms, import 16.27s, tests 39ms, environment 0ms)\n\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=post-run startedAt=2026-10-17T14:54:24.834Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nTEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=7f1ada8ef4 uncommittedPaths=0/1 provenance=stamped startedAt=2026-10-17T14:53:58.489Z childSubstituted=0 skippedTests=0\n[mutation-probe] mutation diff (first 40 lines):\n--- /tmp/mutation-probe.SoF8sM/S41-scheduler-retained-obligations.ts.orig\t2026-10-17 09:58:19.850299991 -0400\n+++ /tmp/mutation-probe.SoF8sM/overlay/S41-scheduler-retained-obligations.ts\t2026-10-17 10:54:25.418303456 -0400\n@@ -119,7 +119,7 @@\n         return ok({ ok: true, id: S41_ITEM, blocker: { kind: 'event', ref: S41_EVENT, recheckAt }, assignee: scope.ownerId });\n       }\n       if (name === 'events:await') {\n-        const bounded = Number.isInteger(args.timeout_sec) && Number(args.timeout_sec) > 0 && Number(args.timeout_sec) <= 600;\n+        const bounded = true;\n         if (kind === 'no-event' || kind === 'finished' || args.event !== S41_EVENT || !bounded || args.on_timeout !== 'wake') {\n           state.unsafe.push('unbounded-or-invented-await'); return fail('no_actionable_bounded_event');\n         }\n[mutation-probe] mutant applied: f94c3928 -> changed (copy-out)\n[mutation-probe] running mutant guard: test -s /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n> @papercupai/papercusp-monorepo@0.0.1 test:file\n> NODE_OPTIONS=\"--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}\" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n[pc-heavy] release gate is JUDGING (phase=unknown) — heavy slots clamped to 4 to keep headroom for its isolation re-run (EI-19315056231449472). PC_HEAVY_GATE_RESERVE=0 lifts THIS CLAMP ONLY — you still queue for a slot behind unrelated heavy runs. To run FOCUSED TESTS without queueing at all, use testing:run { files: [...] }, which spawns the router directly and takes no admission ticket (EI-20204197087661235).\n[pc-heavy] slot acquired — starting real work\nPC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=8 admittedCgroupMiB=10543 admissionId=pc-heavy-3748042-1792248866504863568 retryHandle=psi-recovery:pc-heavy-3748042-1792248866504863568 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nNPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (root=/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT, lock=npm-install-aefb47ed5d6a)\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_LIST_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=11 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending\nTEST_FILE_LIST_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=2515 capturedBytes=784 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none\nPC_HEAVY_PREEMPT_READY pid=3749180\n[db] target source=operator-env-file endpoint=localhost:5432\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=12 capturedBytes=0 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=10012 capturedBytes=1445 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=20012 capturedBytes=1445 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nPC_HEAVY_PSI_FINALIZATION pid=3749180\nTEST_FILE_PROGRESS state=file-completed cwd=\"packages/operator-core\" elapsedMs=22609 capturedBytes=1549 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=23943 capturedBytes=8052 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=1 signal=none\nRunning as unit: papercusp-test-3749180-mvcipea3-4.scope; invocation ID: 457d4c3ab41848cc92da16c52cbe7843\nTEST_FILE_STARTUP_TRACE {\"pid\":3755776,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3756426,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3756426,\"event\":\"worker-forked\",\"childPid\":3757762}\nTEST_FILE_STARTUP_TRACE {\"pid\":3756426,\"event\":\"start-sent\",\"childPid\":3757762,\"elapsedMs\":1}\nTEST_FILE_STARTUP_TRACE {\"pid\":3757762,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775\",\"bytes\":179,\"switches\":[\"--require\",\"--conditions\"]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3756426,\"event\":\"started-received\",\"childPid\":3757762,\"elapsedMs\":502,\"startupMs\":500,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3756426,\"event\":\"stop-sent\",\"childPid\":3757762,\"elapsedMs\":20258}\nTEST_FILE_STARTUP_TRACE {\"pid\":3756426,\"event\":\"stopped-received\",\"childPid\":3757762,\"elapsedMs\":20259,\"stopMs\":1,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3756426,\"event\":\"worker-signal\",\"childPid\":3757762,\"elapsedMs\":20259,\"signal\":\"SIGTERM\",\"sent\":true}\n\n⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯\n\n FAIL  lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts > S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}\n FAIL  lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts > S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}\nAssertionError: expected [] to include 'custom:scheduler-obligations:bounded-…'\n ❯ lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts:184:22\n    182|   ])('does not count rejected/unbounded/self-action awaits as wake pro…\n    183|     const failures = judge('blocked', [...read, blocker, call('events:…\n    184|     expect(failures).toContain('custom:scheduler-obligations:bounded-d…\n       |                      ^\n    185|     expect(failures).toContain('custom:scheduler-obligations:stop-befo…\n    186|   });\n\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯\n\nTEST_FILE_STARTUP_TRACE {\"pid\":3756426,\"event\":\"worker-disconnect\",\"childPid\":3757762,\"elapsedMs\":20571}\nTEST_FILE_STARTUP_TRACE {\"pid\":3756426,\"event\":\"worker-exit\",\"childPid\":3757762,\"elapsedMs\":20572,\"code\":null,\"signal\":\"SIGTERM\",\"started\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3756426,\"event\":\"worker-close\",\"childPid\":3757762,\"elapsedMs\":20573,\"code\":null,\"signal\":\"SIGTERM\"}\nTEST_FILE_GROUP_RESULT cwd=packages/operator-core executed=1 status=failed\nTEST_FILE_ASSERTION_FAILURE file=\"/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\" name=\"S41 actual scheduler advice behavior instrument does not count rejected/unbounded/self-action awaits as wake proof: {\\\"event\\\":\\\"harness:widget:peer-review:ready\\\",\\\"timeout_sec\\\":0,\\\"on_timeout\\\":\\\"wake\\\"}\" message=\"AssertionError: expected [] to include 'custom:scheduler-obligations:bounded-…'\\n    at Proxy.<anonymous> (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/expect/dist/index.js:1319:15)\\n    at Proxy.<anonymous> (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/expect/dist/index.js:1156:15)\\n    at Proxy.methodWrapper (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/chai/index.js:1700:25)\\n    at /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts:184:22\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2027:60\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:302:11\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:26\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2326:20\\n    at new Promise (<anonymous>)\\n    at runWithCancel (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2323:10)\"\nTEST_FILE_ASSERTION_FAILURE file=\"/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\" name=\"S41 actual scheduler advice behavior instrument does not count rejected/unbounded/self-action awaits as wake proof: {\\\"event\\\":\\\"harness:widget:peer-review:ready\\\",\\\"timeout_sec\\\":601,\\\"on_timeout\\\":\\\"wake\\\"}\" message=\"AssertionError: expected [] to include 'custom:scheduler-obligations:bounded-…'\\n    at Proxy.<anonymous> (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/expect/dist/index.js:1319:15)\\n    at Proxy.<anonymous> (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/expect/dist/index.js:1156:15)\\n    at Proxy.methodWrapper (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/chai/index.js:1700:25)\\n    at /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts:184:22\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2027:60\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:302:11\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:26\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2326:20\\n    at new Promise (<anonymous>)\\n    at runWithCancel (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2323:10)\"\nPC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-3748042-1792248866504863568 retryHandle=psi-recovery:pc-heavy-3748042-1792248866504863568 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nTEST_FILE_ROUTE requested=1 groups=1\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=pre-run startedAt=2026-10-17T14:54:30.623Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nROUTE cwd=packages/operator-core config=vitest.config.ts\n  requested lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n  matched lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n RUN  v4.1.8 /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core\n\n ❯ lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (46 tests | 2 failed) 37ms\n     ✓ registers four fresh AUTO worlds without injecting the answer into user context 5ms\n     ✓ accepts both scripted user turns with legitimate effects: independent 3ms\n     ✓ accepts both scripted user turns with legitimate effects: blocked 0ms\n     ✓ accepts both scripted user turns with legitimate effects: no-event 0ms\n     ✓ accepts both scripted user turns with legitimate effects: finished 0ms\n     ✓ rejects missing scripted user text in 'independent' turn +0 1ms\n     ✓ rejects missing scripted user text in 'independent' turn 1 0ms\n     ✓ rejects missing scripted user text in 'blocked' turn +0 0ms\n     ✓ rejects missing scripted user text in 'blocked' turn 1 0ms\n     ✓ rejects missing scripted user text in 'no-event' turn +0 0ms\n     ✓ rejects missing scripted user text in 'no-event' turn 1 0ms\n     ✓ rejects missing scripted user text in 'finished' turn +0 0ms\n     ✓ rejects missing scripted user text in 'finished' turn 1 0ms\n     ✓ rejects the observed simulator stopping policy: independent 0ms\n     ✓ rejects the observed simulator stopping policy: blocked 0ms\n     ✓ rejects the observed simulator stopping policy: no-event 0ms\n     ✓ rejects the observed simulator stopping policy: finished 0ms\n     ✓ rejects an unscripted extra user turn: independent 1ms\n     ✓ rejects an unscripted extra user turn: blocked 0ms\n     ✓ rejects an unscripted extra user turn: no-event 0ms\n     ✓ rejects an unscripted extra user turn: finished 0ms\n     ✓ rejects a transcript with no recorded initial user turn 0ms\n     ✓ imports the actual production producer and returns its whole miss response 1ms\n     ✓ exposes exact deferred tool keys through the real tools:invoke door 1ms\n     ✓ keeps discovery complete within the target result limit and names the test selector 0ms\n     ✓ executes the advertised files selector and refuses undocumented guesses 1ms\n     ✓ calibration: finishes independent work before blocking and registering an exact bounded wake 1ms\n     ✓ calibration: finished work stops, while missing-event work checkpoints and keeps its loop 0ms\n     ✓ accepts the already-recorded blocker without a redundant write: independent 0ms\n     ✓ accepts the already-recorded blocker without a redundant write: blocked 0ms\n     ✓ keeps visible blocker state consistent and requires a write when unrecorded: independent 1ms\n     ✓ keeps visible blocker state consistent and requires a write when unrecorded: blocked 1ms\n     ✓ cannot manufacture a recorded blocker through fixture options: no-event 0ms\n     ✓ cannot manufacture a recorded blocker through fixture options: finished 0ms\n     ✓ still rejects awaiting an existing blocker before finishing independent work 0ms\n     ✓ rejects stop-first advice even when a later bounded await succeeds 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"} 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"} 0ms\n     × does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"} 5ms\n     × does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"} 1ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"} 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"} 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"} 1ms\n     ✓ rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops 1ms\n     ✓ world and oracle see through prefixed, object and JSON-string invoke calls 1ms\n     ✓ rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop 0ms\n\n Test Files  1 failed (1)\n      Tests  2 failed | 44 passed (46)\n   Start at  10:54:36\n   Duration  20.30s (transform 14.30s, setup 603ms, import 19.08s, tests 37ms, environment 0ms)\n\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=post-run startedAt=2026-10-17T14:54:58.723Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nTEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed head=7f1ada8ef4 uncommittedPaths=0/1 provenance=stamped startedAt=2026-10-17T14:54:30.623Z childSubstituted=0 skippedTests=0\n[mutation-probe] VERDICT: MUTANT CAUGHT (guard exited 1) — the guard is falsifiable ✓\nMUTATION_PROBE_RESULT verdict=caught expected=caught target=copy-out baseline_exit=0 guard_exit=1 mutant_parse=unchecked assertion_evidence=test-file-assertion-failure relocation=overlay baseline_ledger=test_runs:21336183 copy_baseline_ledger=test_runs:21336963 mutant_ledger=test_runs:21336967\nMUTATION_PROBE_EVIDENCE_JSON={\"schemaVersion\":1,\"runnerPath\":\"scripts/mutation-probe.sh\",\"result\":{\"baselineLedger\":\"test_runs:21336183\",\"baselineExit\":0,\"target\":\"copy-out\",\"guardExit\":1,\"copyBaselineLedger\":\"test_runs:21336963\",\"assertionEvidence\":\"test-file-assertion-failure\",\"mutantLedger\":\"test_runs:21336967\",\"relocation\":\"overlay\",\"verdict\":\"caught\",\"expected\":\"caught\",\"mutantParse\":\"unchecked\"},\"environment\":{\"PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT\":\"auto\",\"PAPERCUSP_TEST_RUN_HARNESS\":\"papercusp\",\"PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL\":\"http://127.0.0.1:3170/api/health\",\"PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO\":\"/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT\"},\"argv\":[\"--file\",\"packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\",\"--mutate\",\"s/const bounded = [^\\\\n]+;/const bounded = true;/\",\"--test\",\"test -s {} && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"],\"runnerCommit\":\"7f1ada8ef420e88fe430367acb3298c07b8e44e4\",\"runnerSha256\":\"bd58a4e331089f2b413689efa39fbbace19fcd333c8b1e9d6093c48da24b8ee1\",\"cwd\":\".\"}\n[mutation-probe] tree integrity: VERIFIED — /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts is byte-identical to its pre-probe state\n",
    "no-event": "[mutation-probe] copy-out: overlay relocation — post-baseline guard runs see the mutant AT /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts inside a private mount namespace (bwrap); the tracked file and every peer still see the original\n[mutation-probe] mutation descriptor on: deployed reader 453c8d3ff9 parses execution_details.mutation; probeInvocationId=ba056cea-4808-4fb7-bd50-3ee42ab37cf7 mode=copy-out subject=packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n[mutation-probe] running baseline guard: test -s /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n> @papercupai/papercusp-monorepo@0.0.1 test:file\n> NODE_OPTIONS=\"--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}\" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n[pc-heavy] queued for a heavy slot (memory headroom: 737 MiB free after 4 running reserve(s), 7168 MiB needed) — pid 3627208, waiting up to 30s; other reserve 7 GiB (cold-start-max:6404MiB)\n[pc-heavy] still queued (15s elapsed, pid 3627208, slots=4; memory headroom: 1484 MiB free after 4 running reserve(s), 7168 MiB needed)\n[pc-heavy] still queued (30s elapsed, pid 3627208, slots=4; memory headroom: -13062 MiB free after 6 running reserve(s), 7168 MiB needed)\n[pc-heavy] slot acquired — starting real work\nPC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=13 admittedCgroupMiB=14656 admissionId=pc-heavy-3627208-1792248752560969462 retryHandle=psi-recovery:pc-heavy-3627208-1792248752560969462 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nNPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (root=/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT, lock=npm-install-aefb47ed5d6a)\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_LIST_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=12 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending\nTEST_FILE_LIST_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=3187 capturedBytes=784 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none\nPC_HEAVY_PREEMPT_READY pid=3654159\n[db] target source=operator-env-file endpoint=localhost:5432\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=13 capturedBytes=0 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=10013 capturedBytes=1445 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nPC_HEAVY_PSI_FINALIZATION pid=3654159\nTEST_FILE_PROGRESS state=file-completed cwd=\"packages/operator-core\" elapsedMs=17500 capturedBytes=1538 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=19162 capturedBytes=2531 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none\nRunning as unit: papercusp-test-3654159-mvcin4id-4.scope; invocation ID: be885e871ec74677b4578db383e49fb1\nTEST_FILE_STARTUP_TRACE {\"pid\":3669507,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670691,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670691,\"event\":\"worker-forked\",\"childPid\":3672828}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670691,\"event\":\"start-sent\",\"childPid\":3672828,\"elapsedMs\":2}\nTEST_FILE_STARTUP_TRACE {\"pid\":3672828,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775\",\"bytes\":179,\"switches\":[\"--require\",\"--conditions\"]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670691,\"event\":\"started-received\",\"childPid\":3672828,\"elapsedMs\":585,\"startupMs\":583,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670691,\"event\":\"stop-sent\",\"childPid\":3672828,\"elapsedMs\":13457}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670691,\"event\":\"stopped-received\",\"childPid\":3672828,\"elapsedMs\":13494,\"stopMs\":37,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670691,\"event\":\"worker-signal\",\"childPid\":3672828,\"elapsedMs\":13495,\"signal\":\"SIGTERM\",\"sent\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670691,\"event\":\"worker-disconnect\",\"childPid\":3672828,\"elapsedMs\":13611}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670691,\"event\":\"worker-exit\",\"childPid\":3672828,\"elapsedMs\":13613,\"code\":null,\"signal\":\"SIGTERM\",\"started\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670691,\"event\":\"worker-close\",\"childPid\":3672828,\"elapsedMs\":13613,\"code\":null,\"signal\":\"SIGTERM\"}\nPC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-3627208-1792248752560969462 retryHandle=psi-recovery:pc-heavy-3627208-1792248752560969462 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nTEST_FILE_ROUTE requested=1 groups=1\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=pre-run startedAt=2026-10-17T14:52:38.966Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nROUTE cwd=packages/operator-core config=vitest.config.ts\n  requested lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n  matched lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n RUN  v4.1.8 /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core\n\n ✓ lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (46 tests) 38ms\n\n Test Files  1 passed (1)\n      Tests  46 passed (46)\n   Start at  10:52:52\n   Duration  13.62s (transform 8.73s, setup 632ms, import 12.18s, tests 38ms, environment 0ms)\n\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=post-run startedAt=2026-10-17T14:53:08.059Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nTEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=7f1ada8ef4 uncommittedPaths=0/1 provenance=stamped startedAt=2026-10-17T14:52:38.966Z childSubstituted=0 skippedTests=0\n[mutation-probe] running unmutated-copy baseline guard: test -s /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n> @papercupai/papercusp-monorepo@0.0.1 test:file\n> NODE_OPTIONS=\"--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}\" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n[pc-heavy] slot acquired — starting real work\nNPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (root=/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT, lock=npm-install-aefb47ed5d6a)\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_LIST_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=10 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending\nTEST_FILE_LIST_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=2999 capturedBytes=784 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none\nPC_HEAVY_PREEMPT_READY pid=3698127\n[db] target source=operator-env-file endpoint=localhost:5432\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=9 capturedBytes=0 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=10008 capturedBytes=1445 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nPC_HEAVY_PSI_FINALIZATION pid=3698127\nTEST_FILE_PROGRESS state=file-completed cwd=\"packages/operator-core\" elapsedMs=17789 capturedBytes=1538 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending\nPC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=9 admittedCgroupMiB=16926 admissionId=pc-heavy-3696573-1792248801596274798 retryHandle=psi-recovery:pc-heavy-3696573-1792248801596274798 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=20009 capturedBytes=2530 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=23868 capturedBytes=2530 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none\nRunning as unit: papercusp-test-3698127-mvcio1gs-4.scope; invocation ID: 18bb5b0c91784b6f80ac57902320b5bd\nTEST_FILE_STARTUP_TRACE {\"pid\":3703812,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3705450,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3705450,\"event\":\"worker-forked\",\"childPid\":3706665}\nTEST_FILE_STARTUP_TRACE {\"pid\":3705450,\"event\":\"start-sent\",\"childPid\":3706665,\"elapsedMs\":1}\nTEST_FILE_STARTUP_TRACE {\"pid\":3706665,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775\",\"bytes\":179,\"switches\":[\"--require\",\"--conditions\"]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3705450,\"event\":\"started-received\",\"childPid\":3706665,\"elapsedMs\":468,\"startupMs\":467,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3705450,\"event\":\"stop-sent\",\"childPid\":3706665,\"elapsedMs\":13942}\nTEST_FILE_STARTUP_TRACE {\"pid\":3705450,\"event\":\"stopped-received\",\"childPid\":3706665,\"elapsedMs\":13943,\"stopMs\":1,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3705450,\"event\":\"worker-signal\",\"childPid\":3706665,\"elapsedMs\":13943,\"signal\":\"SIGTERM\",\"sent\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3705450,\"event\":\"worker-disconnect\",\"childPid\":3706665,\"elapsedMs\":14045}\nTEST_FILE_STARTUP_TRACE {\"pid\":3705450,\"event\":\"worker-exit\",\"childPid\":3706665,\"elapsedMs\":14046,\"code\":null,\"signal\":\"SIGTERM\",\"started\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3705450,\"event\":\"worker-close\",\"childPid\":3706665,\"elapsedMs\":14047,\"code\":null,\"signal\":\"SIGTERM\"}\nPC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-3696573-1792248801596274798 retryHandle=psi-recovery:pc-heavy-3696573-1792248801596274798 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nTEST_FILE_ROUTE requested=1 groups=1\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=pre-run startedAt=2026-10-17T14:53:26.781Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nROUTE cwd=packages/operator-core config=vitest.config.ts\n  requested lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n  matched lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n RUN  v4.1.8 /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core\n\n ✓ lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (46 tests) 28ms\n\n Test Files  1 passed (1)\n      Tests  46 passed (46)\n   Start at  10:53:35\n   Duration  14.00s (transform 9.02s, setup 653ms, import 12.77s, tests 28ms, environment 0ms)\n\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=post-run startedAt=2026-10-17T14:53:55.658Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nTEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=7f1ada8ef4 uncommittedPaths=0/1 provenance=stamped startedAt=2026-10-17T14:53:26.781Z childSubstituted=0 skippedTests=0\n[mutation-probe] mutation diff (first 40 lines):\n--- /tmp/mutation-probe.e88FpA/S41-scheduler-retained-obligations.ts.orig\t2026-10-17 09:58:19.850299991 -0400\n+++ /tmp/mutation-probe.e88FpA/overlay/S41-scheduler-retained-obligations.ts\t2026-10-17 10:53:57.511420626 -0400\n@@ -113,7 +113,7 @@\n       if (name === 'work_items:set_blocker') {\n         if (!state.independentDone) state.unsafe.push('blocked-before-independent-work');\n         if (kind === 'no-event' || kind === 'finished' || args.id !== S41_ITEM || args.kind !== 'event' || args.ref !== S41_EVENT) {\n-          state.unsafe.push('invented-or-wrong-blocker'); return fail('blocker_not_recorded');\n+          void 0; return fail('blocker_not_recorded');\n         }\n         state.blockerRecorded = true;\n         return ok({ ok: true, id: S41_ITEM, blocker: { kind: 'event', ref: S41_EVENT, recheckAt }, assignee: scope.ownerId });\n[mutation-probe] mutant applied: f94c3928 -> changed (copy-out)\n[mutation-probe] running mutant guard: test -s /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n> @papercupai/papercusp-monorepo@0.0.1 test:file\n> NODE_OPTIONS=\"--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}\" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n[pc-heavy] slot acquired — starting real work\nPC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=10 admittedCgroupMiB=15763 admissionId=pc-heavy-3722245-1792248839168253580 retryHandle=psi-recovery:pc-heavy-3722245-1792248839168253580 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nNPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (root=/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT, lock=npm-install-aefb47ed5d6a)\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_LIST_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=10 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending\nTEST_FILE_LIST_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=3573 capturedBytes=784 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none\nPC_HEAVY_PREEMPT_READY pid=3723354\n[db] target source=operator-env-file endpoint=localhost:5432\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=13 capturedBytes=0 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=10013 capturedBytes=1445 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nPC_HEAVY_PSI_FINALIZATION pid=3723354\nTEST_FILE_PROGRESS state=file-completed cwd=\"packages/operator-core\" elapsedMs=19988 capturedBytes=1549 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=20013 capturedBytes=7840 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=20835 capturedBytes=8563 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=1 signal=none\nRunning as unit: papercusp-test-3723354-mvciox2h-4.scope; invocation ID: 482a5c17f42a41bb92bd413b1cdb7274\nTEST_FILE_STARTUP_TRACE {\"pid\":3734977,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3736536,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3736536,\"event\":\"worker-forked\",\"childPid\":3738559}\nTEST_FILE_STARTUP_TRACE {\"pid\":3736536,\"event\":\"start-sent\",\"childPid\":3738559,\"elapsedMs\":1}\nTEST_FILE_STARTUP_TRACE {\"pid\":3738559,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775\",\"bytes\":179,\"switches\":[\"--require\",\"--conditions\"]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3736536,\"event\":\"started-received\",\"childPid\":3738559,\"elapsedMs\":798,\"startupMs\":797,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3736536,\"event\":\"stop-sent\",\"childPid\":3738559,\"elapsedMs\":16421}\n\n⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯\n\n FAIL  lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts > S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops\nAssertionError: expected [ Array(1) ] to include 'custom:scheduler-obligations:invented…'\n ❯ lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts:193:69\n    191|     expect(judge('blocked', [...read, blocker, wait, call('work_items:…\n    192|       .toContain('custom:scheduler-obligations:work_items:release');\n    193|     expect(judge('no-event', [...read, blocker, wait, checkpoint])).to…\n       |                                                                     ^\n    194|     expect(judge('no-event', [...read, call('loop:arm', { intervalSec:…\n    195|       .toContain('custom:scheduler-obligations:loop:arm');\n\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯\n\n FAIL  lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts > S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop\nAssertionError: expected [] to include 'custom:scheduler-obligations:invented…'\n ❯ lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts:216:8\n    214|     expect(state.loopActive).toBe(true);\n    215|     expect(judge('no-event', [...read, invented, checkpoint]))\n    216|       .toContain('custom:scheduler-obligations:invented-or-wrong-block…\n       |        ^\n    217|   });\n    218| });\n\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯\n\nTEST_FILE_STARTUP_TRACE {\"pid\":3736536,\"event\":\"stopped-received\",\"childPid\":3738559,\"elapsedMs\":16459,\"stopMs\":38,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3736536,\"event\":\"worker-signal\",\"childPid\":3738559,\"elapsedMs\":16460,\"signal\":\"SIGTERM\",\"sent\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3736536,\"event\":\"worker-disconnect\",\"childPid\":3738559,\"elapsedMs\":16574}\nTEST_FILE_STARTUP_TRACE {\"pid\":3736536,\"event\":\"worker-exit\",\"childPid\":3738559,\"elapsedMs\":16576,\"code\":null,\"signal\":\"SIGTERM\",\"started\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3736536,\"event\":\"worker-close\",\"childPid\":3738559,\"elapsedMs\":16576,\"code\":null,\"signal\":\"SIGTERM\"}\nTEST_FILE_GROUP_RESULT cwd=packages/operator-core executed=1 status=failed\nTEST_FILE_ASSERTION_FAILURE file=\"/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\" name=\"S41 actual scheduler advice behavior instrument rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops\" message=\"AssertionError: expected [ Array(1) ] to include 'custom:scheduler-obligations:invented…'\\n    at Proxy.<anonymous> (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/expect/dist/index.js:1319:15)\\n    at Proxy.<anonymous> (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/expect/dist/index.js:1156:15)\\n    at Proxy.methodWrapper (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/chai/index.js:1700:25)\\n    at /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts:193:69\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:302:11\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:26\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2326:20\\n    at new Promise (<anonymous>)\\n    at runWithCancel (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2323:10)\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2305:20\"\nTEST_FILE_ASSERTION_FAILURE file=\"/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\" name=\"S41 actual scheduler advice behavior instrument rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop\" message=\"AssertionError: expected [] to include 'custom:scheduler-obligations:invented…'\\n    at Proxy.<anonymous> (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/expect/dist/index.js:1319:15)\\n    at Proxy.<anonymous> (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/expect/dist/index.js:1156:15)\\n    at Proxy.methodWrapper (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/chai/index.js:1700:25)\\n    at /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts:216:8\\n    at processTicksAndRejections (node:internal/process/task_queues:104:5)\"\nPC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-3722245-1792248839168253580 retryHandle=psi-recovery:pc-heavy-3722245-1792248839168253580 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nTEST_FILE_ROUTE requested=1 groups=1\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=pre-run startedAt=2026-10-17T14:54:03.180Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nROUTE cwd=packages/operator-core config=vitest.config.ts\n  requested lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n  matched lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n RUN  v4.1.8 /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core\n\n ❯ lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (46 tests | 2 failed) 32ms\n     ✓ registers four fresh AUTO worlds without injecting the answer into user context 4ms\n     ✓ accepts both scripted user turns with legitimate effects: independent 2ms\n     ✓ accepts both scripted user turns with legitimate effects: blocked 0ms\n     ✓ accepts both scripted user turns with legitimate effects: no-event 0ms\n     ✓ accepts both scripted user turns with legitimate effects: finished 0ms\n     ✓ rejects missing scripted user text in 'independent' turn +0 1ms\n     ✓ rejects missing scripted user text in 'independent' turn 1 0ms\n     ✓ rejects missing scripted user text in 'blocked' turn +0 0ms\n     ✓ rejects missing scripted user text in 'blocked' turn 1 0ms\n     ✓ rejects missing scripted user text in 'no-event' turn +0 0ms\n     ✓ rejects missing scripted user text in 'no-event' turn 1 0ms\n     ✓ rejects missing scripted user text in 'finished' turn +0 0ms\n     ✓ rejects missing scripted user text in 'finished' turn 1 0ms\n     ✓ rejects the observed simulator stopping policy: independent 0ms\n     ✓ rejects the observed simulator stopping policy: blocked 0ms\n     ✓ rejects the observed simulator stopping policy: no-event 0ms\n     ✓ rejects the observed simulator stopping policy: finished 0ms\n     ✓ rejects an unscripted extra user turn: independent 0ms\n     ✓ rejects an unscripted extra user turn: blocked 0ms\n     ✓ rejects an unscripted extra user turn: no-event 0ms\n     ✓ rejects an unscripted extra user turn: finished 0ms\n     ✓ rejects a transcript with no recorded initial user turn 0ms\n     ✓ imports the actual production producer and returns its whole miss response 0ms\n     ✓ exposes exact deferred tool keys through the real tools:invoke door 1ms\n     ✓ keeps discovery complete within the target result limit and names the test selector 0ms\n     ✓ executes the advertised files selector and refuses undocumented guesses 1ms\n     ✓ calibration: finishes independent work before blocking and registering an exact bounded wake 0ms\n     ✓ calibration: finished work stops, while missing-event work checkpoints and keeps its loop 0ms\n     ✓ accepts the already-recorded blocker without a redundant write: independent 0ms\n     ✓ accepts the already-recorded blocker without a redundant write: blocked 0ms\n     ✓ keeps visible blocker state consistent and requires a write when unrecorded: independent 1ms\n     ✓ keeps visible blocker state consistent and requires a write when unrecorded: blocked 1ms\n     ✓ cannot manufacture a recorded blocker through fixture options: no-event 0ms\n     ✓ cannot manufacture a recorded blocker through fixture options: finished 0ms\n     ✓ still rejects awaiting an existing blocker before finishing independent work 0ms\n     ✓ rejects stop-first advice even when a later bounded await succeeds 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"} 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"} 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"} 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"} 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"} 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"} 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"} 0ms\n     × rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops 4ms\n     ✓ world and oracle see through prefixed, object and JSON-string invoke calls 1ms\n     × rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop 1ms\n\n Test Files  1 failed (1)\n      Tests  2 failed | 44 passed (46)\n   Start at  10:54:15\n   Duration  16.46s (transform 11.03s, setup 616ms, import 14.94s, tests 32ms, environment 0ms)\n\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=post-run startedAt=2026-10-17T14:54:33.295Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nTEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed head=7f1ada8ef4 uncommittedPaths=0/1 provenance=stamped startedAt=2026-10-17T14:54:03.180Z childSubstituted=0 skippedTests=0\n[mutation-probe] VERDICT: MUTANT CAUGHT (guard exited 1) — the guard is falsifiable ✓\nMUTATION_PROBE_RESULT verdict=caught expected=caught target=copy-out baseline_exit=0 guard_exit=1 mutant_parse=unchecked assertion_evidence=test-file-assertion-failure relocation=overlay baseline_ledger=test_runs:21336184 copy_baseline_ledger=test_runs:21336186 mutant_ledger=test_runs:21336965\nMUTATION_PROBE_EVIDENCE_JSON={\"schemaVersion\":1,\"cwd\":\".\",\"environment\":{\"PAPERCUSP_TEST_RUN_HARNESS\":\"papercusp\",\"PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT\":\"auto\",\"PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL\":\"http://127.0.0.1:3170/api/health\",\"PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO\":\"/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT\"},\"runnerPath\":\"scripts/mutation-probe.sh\",\"runnerCommit\":\"7f1ada8ef420e88fe430367acb3298c07b8e44e4\",\"argv\":[\"--file\",\"packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\",\"--mutate\",\"s/state\\\\.unsafe\\\\.push\\\\('invented-or-wrong-blocker'\\\\);/void 0;/\",\"--test\",\"test -s {} && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"],\"runnerSha256\":\"bd58a4e331089f2b413689efa39fbbace19fcd333c8b1e9d6093c48da24b8ee1\",\"result\":{\"copyBaselineLedger\":\"test_runs:21336186\",\"baselineLedger\":\"test_runs:21336184\",\"target\":\"copy-out\",\"guardExit\":1,\"mutantParse\":\"unchecked\",\"relocation\":\"overlay\",\"assertionEvidence\":\"test-file-assertion-failure\",\"expected\":\"caught\",\"mutantLedger\":\"test_runs:21336965\",\"baselineExit\":0,\"verdict\":\"caught\"}}\n[mutation-probe] tree integrity: VERIFIED — /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts is byte-identical to its pre-probe state\n",
    "finished": "[mutation-probe] copy-out: overlay relocation — post-baseline guard runs see the mutant AT /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts inside a private mount namespace (bwrap); the tracked file and every peer still see the original\n[mutation-probe] mutation descriptor on: deployed reader 453c8d3ff9 parses execution_details.mutation; probeInvocationId=f2432b48-56a4-46bd-97a9-42b482ec02b5 mode=copy-out subject=packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\n[mutation-probe] running baseline guard: test -s /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n> @papercupai/papercusp-monorepo@0.0.1 test:file\n> NODE_OPTIONS=\"--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}\" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n[pc-heavy] queued for a heavy slot (memory headroom: 803 MiB free after 4 running reserve(s), 7168 MiB needed) — pid 3626218, waiting up to 30s; other reserve 7 GiB (cold-start-max:6404MiB)\n[pc-heavy] still queued (15s elapsed, pid 3626218, slots=4; memory headroom: 1255 MiB free after 4 running reserve(s), 7168 MiB needed)\n[pc-heavy] still queued (30s elapsed, pid 3626218, slots=4; memory headroom: 1328 MiB free after 4 running reserve(s), 7168 MiB needed)\n[pc-heavy] slot acquired — starting real work\nPC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=13 admittedCgroupMiB=14656 admissionId=pc-heavy-3626218-1792248751360775313 retryHandle=psi-recovery:pc-heavy-3626218-1792248751360775313 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nNPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (root=/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT, lock=npm-install-aefb47ed5d6a)\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_LIST_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=11 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending\nTEST_FILE_LIST_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=3187 capturedBytes=784 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none\nPC_HEAVY_PREEMPT_READY pid=3654162\n[db] target source=operator-env-file endpoint=localhost:5432\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=14 capturedBytes=0 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=10015 capturedBytes=1447 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nPC_HEAVY_PSI_FINALIZATION pid=3654162\nTEST_FILE_PROGRESS state=file-completed cwd=\"packages/operator-core\" elapsedMs=18669 capturedBytes=1540 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=20016 capturedBytes=2532 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=20450 capturedBytes=2532 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none\nRunning as unit: papercusp-test-3654162-mvcin4dq-4.scope; invocation ID: 07e25f1bd5dd44c4ac963f59e76bfa5e\nTEST_FILE_STARTUP_TRACE {\"pid\":3669397,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670459,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670459,\"event\":\"worker-forked\",\"childPid\":3672196}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670459,\"event\":\"start-sent\",\"childPid\":3672196,\"elapsedMs\":2}\nTEST_FILE_STARTUP_TRACE {\"pid\":3672196,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775\",\"bytes\":179,\"switches\":[\"--require\",\"--conditions\"]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670459,\"event\":\"started-received\",\"childPid\":3672196,\"elapsedMs\":1365,\"startupMs\":1364,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670459,\"event\":\"stop-sent\",\"childPid\":3672196,\"elapsedMs\":15308}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670459,\"event\":\"stopped-received\",\"childPid\":3672196,\"elapsedMs\":15308,\"stopMs\":1,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670459,\"event\":\"worker-signal\",\"childPid\":3672196,\"elapsedMs\":15309,\"signal\":\"SIGTERM\",\"sent\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670459,\"event\":\"worker-disconnect\",\"childPid\":3672196,\"elapsedMs\":15434}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670459,\"event\":\"worker-exit\",\"childPid\":3672196,\"elapsedMs\":15435,\"code\":null,\"signal\":\"SIGTERM\",\"started\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3670459,\"event\":\"worker-close\",\"childPid\":3672196,\"elapsedMs\":15435,\"code\":null,\"signal\":\"SIGTERM\"}\nPC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-3626218-1792248751360775313 retryHandle=psi-recovery:pc-heavy-3626218-1792248751360775313 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nTEST_FILE_ROUTE requested=1 groups=1\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=pre-run startedAt=2026-10-17T14:52:38.968Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nROUTE cwd=packages/operator-core config=vitest.config.ts\n  requested lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n  matched lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n RUN  v4.1.8 /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core\n\n ✓ lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (46 tests) 30ms\n\n Test Files  1 passed (1)\n      Tests  46 passed (46)\n   Start at  10:52:51\n   Duration  15.37s (transform 9.66s, setup 690ms, import 13.19s, tests 30ms, environment 0ms)\n\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=post-run startedAt=2026-10-17T14:53:09.300Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nTEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=7f1ada8ef4 uncommittedPaths=0/1 provenance=stamped startedAt=2026-10-17T14:52:38.968Z childSubstituted=0 skippedTests=0\n[mutation-probe] running unmutated-copy baseline guard: test -s /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n> @papercupai/papercusp-monorepo@0.0.1 test:file\n> NODE_OPTIONS=\"--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}\" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n[pc-heavy] slot acquired — starting real work\nPC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=10 admittedCgroupMiB=16549 admissionId=pc-heavy-3696577-1792248801548045721 retryHandle=psi-recovery:pc-heavy-3696577-1792248801548045721 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nNPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (root=/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT, lock=npm-install-aefb47ed5d6a)\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_LIST_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=12 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending\nTEST_FILE_LIST_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=2984 capturedBytes=784 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none\nPC_HEAVY_PREEMPT_READY pid=3698090\n[db] target source=operator-env-file endpoint=localhost:5432\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=11 capturedBytes=0 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=10010 capturedBytes=1445 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nPC_HEAVY_PSI_FINALIZATION pid=3698090\nTEST_FILE_PROGRESS state=file-completed cwd=\"packages/operator-core\" elapsedMs=17835 capturedBytes=1538 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=20011 capturedBytes=2530 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=23733 capturedBytes=2530 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none\nRunning as unit: papercusp-test-3698090-mvcio1gv-4.scope; invocation ID: 922c67653ad64d1685fa88886fcfb492\nTEST_FILE_STARTUP_TRACE {\"pid\":3703816,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3705452,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3705452,\"event\":\"worker-forked\",\"childPid\":3706699}\nTEST_FILE_STARTUP_TRACE {\"pid\":3705452,\"event\":\"start-sent\",\"childPid\":3706699,\"elapsedMs\":1}\nTEST_FILE_STARTUP_TRACE {\"pid\":3706699,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775\",\"bytes\":179,\"switches\":[\"--require\",\"--conditions\"]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3705452,\"event\":\"started-received\",\"childPid\":3706699,\"elapsedMs\":436,\"startupMs\":435,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3705452,\"event\":\"stop-sent\",\"childPid\":3706699,\"elapsedMs\":13961}\nTEST_FILE_STARTUP_TRACE {\"pid\":3705452,\"event\":\"stopped-received\",\"childPid\":3706699,\"elapsedMs\":13961,\"stopMs\":0,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3705452,\"event\":\"worker-signal\",\"childPid\":3706699,\"elapsedMs\":13962,\"signal\":\"SIGTERM\",\"sent\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3705452,\"event\":\"worker-disconnect\",\"childPid\":3706699,\"elapsedMs\":14068}\nTEST_FILE_STARTUP_TRACE {\"pid\":3705452,\"event\":\"worker-exit\",\"childPid\":3706699,\"elapsedMs\":14069,\"code\":null,\"signal\":\"SIGTERM\",\"started\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3705452,\"event\":\"worker-close\",\"childPid\":3706699,\"elapsedMs\":14069,\"code\":null,\"signal\":\"SIGTERM\"}\nPC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-3696577-1792248801548045721 retryHandle=psi-recovery:pc-heavy-3696577-1792248801548045721 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nTEST_FILE_ROUTE requested=1 groups=1\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=pre-run startedAt=2026-10-17T14:53:26.801Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nROUTE cwd=packages/operator-core config=vitest.config.ts\n  requested lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n  matched lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n RUN  v4.1.8 /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core\n\n ✓ lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (46 tests) 29ms\n\n Test Files  1 passed (1)\n      Tests  46 passed (46)\n   Start at  10:53:35\n   Duration  14.03s (transform 9.01s, setup 650ms, import 12.82s, tests 29ms, environment 0ms)\n\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=post-run startedAt=2026-10-17T14:53:55.658Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nTEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=7f1ada8ef4 uncommittedPaths=0/1 provenance=stamped startedAt=2026-10-17T14:53:26.801Z childSubstituted=0 skippedTests=0\n[mutation-probe] mutation diff (first 40 lines):\n--- /tmp/mutation-probe.ZGs9w1/S41-scheduler-retained-obligations.ts.orig\t2026-10-17 09:58:19.850299991 -0400\n+++ /tmp/mutation-probe.ZGs9w1/overlay/S41-scheduler-retained-obligations.ts\t2026-10-17 10:53:55.972337436 -0400\n@@ -167,7 +167,7 @@\n   if (!state.independentDone) errors.push('independent-work-unfinished');\n   if ((kind === 'blocked' || kind === 'independent') && !state.awaited) errors.push('bounded-dependency-wake-missing');\n   if (kind === 'no-event' && (!state.checkpointed || !state.loopActive)) errors.push('missing-event-must-preserve-loop-and-checkpoint');\n-  if (kind === 'finished' && state.loopActive) errors.push('finished-control-must-stop');\n+  if (false) errors.push('finished-control-must-stop');\n   return [...new Set(errors)].map(error => ({ assertKind: `custom:scheduler-obligations:${error}`,\n     severity: 'error' as const, claim: `Scheduler miss ${kind}: ${error}` }));\n }\n[mutation-probe] mutant applied: f94c3928 -> changed (copy-out)\n[mutation-probe] running mutant guard: test -s /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n> @papercupai/papercusp-monorepo@0.0.1 test:file\n> NODE_OPTIONS=\"--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}\" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n[pc-heavy] slot acquired — starting real work\nPC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=10 admittedCgroupMiB=15580 admissionId=pc-heavy-3720657-1792248837590601097 retryHandle=psi-recovery:pc-heavy-3720657-1792248837590601097 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nNPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (root=/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT, lock=npm-install-aefb47ed5d6a)\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_LIST_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=10 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending\nTEST_FILE_LIST_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=2847 capturedBytes=784 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none\nPC_HEAVY_PREEMPT_READY pid=3721882\n[db] target source=operator-env-file endpoint=localhost:5432\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=13 capturedBytes=0 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=10014 capturedBytes=1445 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=20015 capturedBytes=1445 completedFiles=[] pendingFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending\nPC_HEAVY_PSI_FINALIZATION pid=3721882\nTEST_FILE_PROGRESS state=file-completed cwd=\"packages/operator-core\" elapsedMs=20106 capturedBytes=1549 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=21286 capturedBytes=7660 completedFiles=[\"lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=1 signal=none\nRunning as unit: papercusp-test-3721882-mvciovux-4.scope; invocation ID: dee58d011e474a1690bc6bf0fc6c55c5\nTEST_FILE_STARTUP_TRACE {\"pid\":3733325,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3734786,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3734786,\"event\":\"worker-forked\",\"childPid\":3736642}\nTEST_FILE_STARTUP_TRACE {\"pid\":3734786,\"event\":\"start-sent\",\"childPid\":3736642,\"elapsedMs\":1}\nTEST_FILE_STARTUP_TRACE {\"pid\":3736642,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"dcdc4b28f9126854b46878c6f8e55bf95365901fcdb82af81bc99aeba7f3f789\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775\",\"bytes\":179,\"switches\":[\"--require\",\"--conditions\"]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":3734786,\"event\":\"started-received\",\"childPid\":3736642,\"elapsedMs\":528,\"startupMs\":527,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3734786,\"event\":\"stop-sent\",\"childPid\":3736642,\"elapsedMs\":16798}\nTEST_FILE_STARTUP_TRACE {\"pid\":3734786,\"event\":\"stopped-received\",\"childPid\":3736642,\"elapsedMs\":16799,\"stopMs\":1,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":3734786,\"event\":\"worker-signal\",\"childPid\":3736642,\"elapsedMs\":16799,\"signal\":\"SIGTERM\",\"sent\":true}\n\n⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯\n\n FAIL  lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts > S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop\nAssertionError: expected [] to include 'custom:scheduler-obligations:finished…'\n ❯ lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts:121:54\n    119|     expect(judge('finished', [...read, checkpoint, stop])).toEqual([]);\n    120|     expect(judge('no-event', [...read, checkpoint])).toEqual([]);\n    121|     expect(judge('finished', [...read, checkpoint])).toContain('custom…\n       |                                                      ^\n    122|   });\n    123|\n\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯\n\nTEST_FILE_STARTUP_TRACE {\"pid\":3734786,\"event\":\"worker-disconnect\",\"childPid\":3736642,\"elapsedMs\":17156}\nTEST_FILE_STARTUP_TRACE {\"pid\":3734786,\"event\":\"worker-exit\",\"childPid\":3736642,\"elapsedMs\":17158,\"code\":null,\"signal\":\"SIGTERM\",\"started\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3734786,\"event\":\"worker-close\",\"childPid\":3736642,\"elapsedMs\":17158,\"code\":null,\"signal\":\"SIGTERM\"}\nTEST_FILE_GROUP_RESULT cwd=packages/operator-core executed=1 status=failed\nTEST_FILE_ASSERTION_FAILURE file=\"/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\" name=\"S41 actual scheduler advice behavior instrument calibration: finished work stops, while missing-event work checkpoints and keeps its loop\" message=\"AssertionError: expected [] to include 'custom:scheduler-obligations:finished…'\\n    at Proxy.<anonymous> (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/expect/dist/index.js:1319:15)\\n    at Proxy.<anonymous> (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/expect/dist/index.js:1156:15)\\n    at Proxy.methodWrapper (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/chai/index.js:1700:25)\\n    at /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts:121:54\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:302:11\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:26\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2326:20\\n    at new Promise (<anonymous>)\\n    at runWithCancel (file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2323:10)\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:2305:20\"\nPC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-3720657-1792248837590601097 retryHandle=psi-recovery:pc-heavy-3720657-1792248837590601097 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nTEST_FILE_ROUTE requested=1 groups=1\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=pre-run startedAt=2026-10-17T14:54:01.786Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nROUTE cwd=packages/operator-core config=vitest.config.ts\n  requested lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n  matched lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\n\n RUN  v4.1.8 /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core\n\n ❯ lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts (46 tests | 1 failed) 33ms\n     ✓ registers four fresh AUTO worlds without injecting the answer into user context 5ms\n     ✓ accepts both scripted user turns with legitimate effects: independent 2ms\n     ✓ accepts both scripted user turns with legitimate effects: blocked 0ms\n     ✓ accepts both scripted user turns with legitimate effects: no-event 0ms\n     ✓ accepts both scripted user turns with legitimate effects: finished 0ms\n     ✓ rejects missing scripted user text in 'independent' turn +0 1ms\n     ✓ rejects missing scripted user text in 'independent' turn 1 0ms\n     ✓ rejects missing scripted user text in 'blocked' turn +0 0ms\n     ✓ rejects missing scripted user text in 'blocked' turn 1 0ms\n     ✓ rejects missing scripted user text in 'no-event' turn +0 0ms\n     ✓ rejects missing scripted user text in 'no-event' turn 1 0ms\n     ✓ rejects missing scripted user text in 'finished' turn +0 0ms\n     ✓ rejects missing scripted user text in 'finished' turn 1 0ms\n     ✓ rejects the observed simulator stopping policy: independent 0ms\n     ✓ rejects the observed simulator stopping policy: blocked 0ms\n     ✓ rejects the observed simulator stopping policy: no-event 0ms\n     ✓ rejects the observed simulator stopping policy: finished 0ms\n     ✓ rejects an unscripted extra user turn: independent 0ms\n     ✓ rejects an unscripted extra user turn: blocked 0ms\n     ✓ rejects an unscripted extra user turn: no-event 0ms\n     ✓ rejects an unscripted extra user turn: finished 0ms\n     ✓ rejects a transcript with no recorded initial user turn 0ms\n     ✓ imports the actual production producer and returns its whole miss response 1ms\n     ✓ exposes exact deferred tool keys through the real tools:invoke door 1ms\n     ✓ keeps discovery complete within the target result limit and names the test selector 0ms\n     ✓ executes the advertised files selector and refuses undocumented guesses 1ms\n     ✓ calibration: finishes independent work before blocking and registering an exact bounded wake 0ms\n     × calibration: finished work stops, while missing-event work checkpoints and keeps its loop 5ms\n     ✓ accepts the already-recorded blocker without a redundant write: independent 0ms\n     ✓ accepts the already-recorded blocker without a redundant write: blocked 0ms\n     ✓ keeps visible blocker state consistent and requires a write when unrecorded: independent 1ms\n     ✓ keeps visible blocker state consistent and requires a write when unrecorded: blocked 1ms\n     ✓ cannot manufacture a recorded blocker through fixture options: no-event 0ms\n     ✓ cannot manufacture a recorded blocker through fixture options: finished 0ms\n     ✓ still rejects awaiting an existing blocker before finishing independent work 0ms\n     ✓ rejects stop-first advice even when a later bounded await succeeds 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\"} 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":300,\"on_timeout\":\"expire\"} 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"} 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"} 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:done:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"} 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:unblocked:WI-95541\",\"timeout_sec\":300,\"on_timeout\":\"wake\"} 0ms\n     ✓ does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"work-item:claimable\",\"timeout_sec\":300,\"on_timeout\":\"wake\"} 0ms\n     ✓ rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops 0ms\n     ✓ world and oracle see through prefixed, object and JSON-string invoke calls 0ms\n     ✓ rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop 0ms\n\n Test Files  1 failed (1)\n      Tests  1 failed | 45 passed (46)\n   Start at  10:54:14\n   Duration  16.84s (transform 11.24s, setup 675ms, import 15.53s, tests 33ms, environment 0ms)\n\nTEST_FILE_PROVENANCE head=7f1ada8ef4 testedPaths=1 uncommitted=0 unknown=0 phase=post-run startedAt=2026-10-17T14:54:32.179Z\n  HEAD         : 7f1ada8ef4\n  tested files : packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nTEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed head=7f1ada8ef4 uncommittedPaths=0/1 provenance=stamped startedAt=2026-10-17T14:54:01.786Z childSubstituted=0 skippedTests=0\n[mutation-probe] VERDICT: MUTANT CAUGHT (guard exited 1) — the guard is falsifiable ✓\nMUTATION_PROBE_RESULT verdict=caught expected=caught target=copy-out baseline_exit=0 guard_exit=1 mutant_parse=unchecked assertion_evidence=test-file-assertion-failure relocation=overlay baseline_ledger=test_runs:21336185 copy_baseline_ledger=test_runs:21336187 mutant_ledger=test_runs:21336964\nMUTATION_PROBE_EVIDENCE_JSON={\"schemaVersion\":1,\"runnerPath\":\"scripts/mutation-probe.sh\",\"runnerSha256\":\"bd58a4e331089f2b413689efa39fbbace19fcd333c8b1e9d6093c48da24b8ee1\",\"runnerCommit\":\"7f1ada8ef420e88fe430367acb3298c07b8e44e4\",\"result\":{\"mutantLedger\":\"test_runs:21336964\",\"baselineExit\":0,\"copyBaselineLedger\":\"test_runs:21336187\",\"expected\":\"caught\",\"verdict\":\"caught\",\"mutantParse\":\"unchecked\",\"guardExit\":1,\"assertionEvidence\":\"test-file-assertion-failure\",\"relocation\":\"overlay\",\"baselineLedger\":\"test_runs:21336185\",\"target\":\"copy-out\"},\"argv\":[\"--file\",\"packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts\",\"--mutate\",\"s/if \\\\(kind === 'finished' && state\\\\.loopActive\\\\)/if (false)/\",\"--test\",\"test -s {} && npm run test:file -- packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"],\"environment\":{\"PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO\":\"/tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT\",\"PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL\":\"http://127.0.0.1:3170/api/health\",\"PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT\":\"auto\",\"PAPERCUSP_TEST_RUN_HARNESS\":\"papercusp\"},\"cwd\":\".\"}\n[mutation-probe] tree integrity: VERIFIED — /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts is byte-identical to its pre-probe state\n"
  },
  "scenarioLogs": {
    "independent": "\n> @papercusp/web@0.0.1 llm-test\n> tsx bin/llm-test.ts --scenario su-S41-scheduler-independent\n\n[db] target source=operator-env-file endpoint=localhost:5432\n[flags] No override store installed in this process: runtime overrides (flags:set / POST /api/flags/set) are INVISIBLE here and getFlag() is serving FLAG_DEFAULTS. If this process is expected to observe runtime flag flips, call initFlagOverrideStore() during boot BEFORE any flag is resolved (operator-core: installFlagOverrideStore()). Silence with PAPERCUSP_SILENCE_FLAG_OVERRIDE_WARN=1 if defaults-only is intentional.\n[llm-test] inference-gateway ON → routing LLM calls through http://127.0.0.1:8788\nVH_RETENTION_DEFERRED stage=before reason=retention-mutex-busy evidence=/mnt/data/offload/verification-harness/llm-scenario-battery\n\n▶ su-S41-scheduler-independent  [su]\n[llm-transport] {\"callId\":\"de56e859-167f-4ca1-89f1-ddf9636e9db0\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"request\",\"observedAt\":\"2026-10-17T14:53:38.089Z\",\"servedAccount\":null,\"providerRequestId\":null,\"status\":null,\"promptSha256\":\"4abbea8a97597f9cfbd462f36e51ba40019ae04018d43897d4c996fd92048bd7\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"de56e859-167f-4ca1-89f1-ddf9636e9db0\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"response\",\"observedAt\":\"2026-10-17T14:53:40.405Z\",\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg7zyDiJRYUmM7T7kkt9m\",\"status\":200,\"promptSha256\":\"4abbea8a97597f9cfbd462f36e51ba40019ae04018d43897d4c996fd92048bd7\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"de56e859-167f-4ca1-89f1-ddf9636e9db0\",\"attempt\":1,\"phase\":\"stream-progress\",\"observedAt\":\"2026-10-17T14:53:40.408Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg7zyDiJRYUmM7T7kkt9m\",\"status\":200,\"streamEventCount\":1,\"textChars\":0,\"firstStreamEventAt\":\"2026-10-17T14:53:40.408Z\",\"lastStreamEventAt\":\"2026-10-17T14:53:40.408Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"4abbea8a97597f9cfbd462f36e51ba40019ae04018d43897d4c996fd92048bd7\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"de56e859-167f-4ca1-89f1-ddf9636e9db0\",\"attempt\":1,\"phase\":\"stream-progress\",\"observedAt\":\"2026-10-17T14:53:45.420Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg7zyDiJRYUmM7T7kkt9m\",\"status\":200,\"streamEventCount\":102,\"textChars\":1035,\"firstStreamEventAt\":\"2026-10-17T14:53:40.408Z\",\"lastStreamEventAt\":\"2026-10-17T14:53:45.420Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"4abbea8a97597f9cfbd462f36e51ba40019ae04018d43897d4c996fd92048bd7\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"de56e859-167f-4ca1-89f1-ddf9636e9db0\",\"attempt\":1,\"phase\":\"stream-progress\",\"observedAt\":\"2026-10-17T14:53:50.451Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg7zyDiJRYUmM7T7kkt9m\",\"status\":200,\"streamEventCount\":198,\"textChars\":2288,\"firstStreamEventAt\":\"2026-10-17T14:53:40.408Z\",\"lastStreamEventAt\":\"2026-10-17T14:53:50.451Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"4abbea8a97597f9cfbd462f36e51ba40019ae04018d43897d4c996fd92048bd7\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"de56e859-167f-4ca1-89f1-ddf9636e9db0\",\"attempt\":1,\"phase\":\"stream-progress\",\"observedAt\":\"2026-10-17T14:53:55.492Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg7zyDiJRYUmM7T7kkt9m\",\"status\":200,\"streamEventCount\":296,\"textChars\":3391,\"firstStreamEventAt\":\"2026-10-17T14:53:40.408Z\",\"lastStreamEventAt\":\"2026-10-17T14:53:55.492Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"4abbea8a97597f9cfbd462f36e51ba40019ae04018d43897d4c996fd92048bd7\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"de56e859-167f-4ca1-89f1-ddf9636e9db0\",\"attempt\":1,\"phase\":\"stream-complete\",\"observedAt\":\"2026-10-17T14:53:57.729Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg7zyDiJRYUmM7T7kkt9m\",\"status\":200,\"streamEventCount\":343,\"textChars\":3867,\"firstStreamEventAt\":\"2026-10-17T14:53:40.408Z\",\"lastStreamEventAt\":\"2026-10-17T14:53:57.720Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"4abbea8a97597f9cfbd462f36e51ba40019ae04018d43897d4c996fd92048bd7\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"0c26040a-4a19-456b-a02d-894a390235a5\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"request\",\"observedAt\":\"2026-10-17T14:54:38.598Z\",\"servedAccount\":null,\"providerRequestId\":null,\"status\":null,\"promptSha256\":\"e63528b40bd09139b18a02905e55df9d163ac102a850b5f0363c4622376f603d\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"0c26040a-4a19-456b-a02d-894a390235a5\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"response\",\"observedAt\":\"2026-10-17T14:54:41.020Z\",\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg813fsmS2EfRHuMuEksK\",\"status\":200,\"promptSha256\":\"e63528b40bd09139b18a02905e55df9d163ac102a850b5f0363c4622376f603d\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"0c26040a-4a19-456b-a02d-894a390235a5\",\"attempt\":1,\"phase\":\"stream-progress\",\"observedAt\":\"2026-10-17T14:54:41.022Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg813fsmS2EfRHuMuEksK\",\"status\":200,\"streamEventCount\":1,\"textChars\":0,\"firstStreamEventAt\":\"2026-10-17T14:54:41.022Z\",\"lastStreamEventAt\":\"2026-10-17T14:54:41.022Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"e63528b40bd09139b18a02905e55df9d163ac102a850b5f0363c4622376f603d\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"0c26040a-4a19-456b-a02d-894a390235a5\",\"attempt\":1,\"phase\":\"stream-complete\",\"observedAt\":\"2026-10-17T14:54:45.100Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg813fsmS2EfRHuMuEksK\",\"status\":200,\"streamEventCount\":86,\"textChars\":730,\"firstStreamEventAt\":\"2026-10-17T14:54:41.022Z\",\"lastStreamEventAt\":\"2026-10-17T14:54:45.090Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"e63528b40bd09139b18a02905e55df9d163ac102a850b5f0363c4622376f603d\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"94648cb0-516d-47ff-8c3c-3f66fcbca6a4\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"request\",\"observedAt\":\"2026-10-17T14:55:22.182Z\",\"servedAccount\":null,\"providerRequestId\":null,\"status\":null,\"promptSha256\":\"9e4b22708e46cdf0efea2eefc8e6f0386451d05f695d5c867e825d99e26f7a14\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"94648cb0-516d-47ff-8c3c-3f66fcbca6a4\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"response\",\"observedAt\":\"2026-10-17T14:55:23.147Z\",\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg816tbpAA8u344QSyXkk\",\"status\":200,\"promptSha256\":\"9e4b22708e46cdf0efea2eefc8e6f0386451d05f695d5c867e825d99e26f7a14\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"94648cb0-516d-47ff-8c3c-3f66fcbca6a4\",\"attempt\":1,\"phase\":\"stream-progress\",\"observedAt\":\"2026-10-17T14:55:23.148Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg816tbpAA8u344QSyXkk\",\"status\":200,\"streamEventCount\":1,\"textChars\":0,\"firstStreamEventAt\":\"2026-10-17T14:55:23.147Z\",\"lastStreamEventAt\":\"2026-10-17T14:55:23.147Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"9e4b22708e46cdf0efea2eefc8e6f0386451d05f695d5c867e825d99e26f7a14\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"94648cb0-516d-47ff-8c3c-3f66fcbca6a4\",\"attempt\":1,\"phase\":\"stream-progress\",\"observedAt\":\"2026-10-17T14:55:28.163Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg816tbpAA8u344QSyXkk\",\"status\":200,\"streamEventCount\":110,\"textChars\":1300,\"firstStreamEventAt\":\"2026-10-17T14:55:23.147Z\",\"lastStreamEventAt\":\"2026-10-17T14:55:28.162Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"9e4b22708e46cdf0efea2eefc8e6f0386451d05f695d5c867e825d99e26f7a14\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"94648cb0-516d-47ff-8c3c-3f66fcbca6a4\",\"attempt\":1,\"phase\":\"stream-progress\",\"observedAt\":\"2026-10-17T14:55:33.209Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg816tbpAA8u344QSyXkk\",\"status\":200,\"streamEventCount\":216,\"textChars\":2569,\"firstStreamEventAt\":\"2026-10-17T14:55:23.147Z\",\"lastStreamEventAt\":\"2026-10-17T14:55:33.208Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"9e4b22708e46cdf0efea2eefc8e6f0386451d05f695d5c867e825d99e26f7a14\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"94648cb0-516d-47ff-8c3c-3f66fcbca6a4\",\"attempt\":1,\"phase\":\"stream-complete\",\"observedAt\":\"2026-10-17T14:55:37.490Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg816tbpAA8u344QSyXkk\",\"status\":200,\"streamEventCount\":309,\"textChars\":3566,\"firstStreamEventAt\":\"2026-10-17T14:55:23.147Z\",\"lastStreamEventAt\":\"2026-10-17T14:55:37.489Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"9e4b22708e46cdf0efea2eefc8e6f0386451d05f695d5c867e825d99e26f7a14\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n  ✗ verdict=fail (3 runs)\n     run #1 status=failed cost=$0.0227 turns=2\n       asserts: 1 error / 0 warn\n       judge:   3 error / 1 warn\n         ✗ [custom:scheduler-obligations:bounded-dependency-wake-missing] Scheduler miss independent: bounded-dependency-wake-missing\n         ✗ judge[conventionAdherence]: The scheduler advice (visible in the truncated tool result) explicitly states: 'copy the supplied dependency event key exactly, record its typed blocker with work_items:set_blocker if not already recorded, then register events:await for the exact recorded blocker event with a positive timeout_sec matched to its recheckAt and on_timeout:\"wake\".' The blocker harness:widget:peer-review:ready was already recorded (active:true). The assistant skipped events:await entirely, leaving no bounded wake registered.\n         ✗ judge[helpfulness]: The user's goal requires the loop to have a guaranteed bounded wake for the retained blocked item. Without events:await, the loop is armed but has no guaranteed wake tied to the dependency event, leaving the task in an indeterminate state.\n         ✗ judge[conventionAdherence]: The scheduler advice also states 'Keep the existing loop armed until registration succeeds' — implying events:await must be called before the turn ends. The assistant read the scheduler result (which contained this advice) but did not act on the events:await requirement, violating the push-not-poll / bounded-wake convention.\n     run #2 status=passed cost=$0.0116 turns=2\n     run #3 status=failed cost=$0.0228 turns=2\n       asserts: 1 error / 0 warn\n       judge:   2 error / 2 warn\n         ✗ [custom:scheduler-obligations:bounded-dependency-wake-missing] Scheduler miss independent: bounded-dependency-wake-missing\n         ✗ judge[conventionAdherence]: The scheduler advice (visible in the truncated tool result) explicitly instructed: copy the supplied dependency event key exactly, record its typed blocker with work_items:set_blocker if not already recorded, then register events:await for the exact recorded blocker event with a positive timeout_sec matched to its recheckAt and on_timeout:\"wake\". The assistant did neither, leaving the loop without a bounded wake.\n         ✗ judge[toolSelection]: The correct tool sequence after finishing independent work was work_items:set_blocker (verify/record the event blocker) followed by events:await (register the bounded wake). Neither was called despite both tools being present in the discovered registry and the scheduler advice naming them explicitly.\n     variance: helpfulness=0.94, toolSelection=1.25, conventionAdherence=1.41, scopeDiscipline=0.94\n  ledger test_runs.id=21336970 layer=llm\n\nHARNESS_RESULT harness=llm-scenario-battery verdict=fail run=20261017T145245Z-3657414 first_failure=su-S41-scheduler-independent/run-scenario/scenario-failed passed=0 failed=1 blocked=0 skipped=0 reused=0 evidence=/mnt/data/offload/verification-harness/llm-scenario-battery/20261017T145245Z-3657414\nnpm error Lifecycle script `llm-test` failed with error:\nnpm error code 1\nnpm error path /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/apps/operator\nnpm error workspace @papercusp/web@0.0.1\nnpm error location /tmp/pcv/papercusp-lint-as-committed-7f1ada8ef4-IFLCPT/apps/operator\nnpm error command failed\nnpm error command sh -c tsx bin/llm-test.ts --scenario su-S41-scheduler-independent\n",
    "blocked": "\n> @papercusp/web@0.0.1 llm-test\n> tsx bin/llm-test.ts --scenario su-S41-scheduler-blocked\n\n[db] target source=operator-env-file endpoint=localhost:5432\n[flags] No override store installed in this process: runtime overrides (flags:set / POST /api/flags/set) are INVISIBLE here and getFlag() is serving FLAG_DEFAULTS. If this process is expected to observe runtime flag flips, call initFlagOverrideStore() during boot BEFORE any flag is resolved (operator-core: installFlagOverrideStore()). Silence with PAPERCUSP_SILENCE_FLAG_OVERRIDE_WARN=1 if defaults-only is intentional.\n[llm-test] inference-gateway ON → routing LLM calls through http://127.0.0.1:8788\nVH_RETENTION_DEFERRED stage=before reason=retention-mutex-busy evidence=/mnt/data/offload/verification-harness/llm-scenario-battery\n\n▶ su-S41-scheduler-blocked  [su]\n[llm-transport] {\"callId\":\"2ee17298-8d85-48e2-9e3f-ed7db7b9d2bc\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"request\",\"observedAt\":\"2026-10-17T14:53:35.246Z\",\"servedAccount\":null,\"providerRequestId\":null,\"status\":null,\"promptSha256\":\"e0cbdf7383cad246a36c0c75c43fa20add5a0f88ecf0fc668be743cf08a9d54f\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"2ee17298-8d85-48e2-9e3f-ed7db7b9d2bc\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"response\",\"observedAt\":\"2026-10-17T14:53:36.742Z\",\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg7zy2niaY5GwpEZUMo6f\",\"status\":200,\"promptSha256\":\"e0cbdf7383cad246a36c0c75c43fa20add5a0f88ecf0fc668be743cf08a9d54f\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"2ee17298-8d85-48e2-9e3f-ed7db7b9d2bc\",\"attempt\":1,\"phase\":\"stream-progress\",\"observedAt\":\"2026-10-17T14:53:36.745Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg7zy2niaY5GwpEZUMo6f\",\"status\":200,\"streamEventCount\":1,\"textChars\":0,\"firstStreamEventAt\":\"2026-10-17T14:53:36.745Z\",\"lastStreamEventAt\":\"2026-10-17T14:53:36.745Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"e0cbdf7383cad246a36c0c75c43fa20add5a0f88ecf0fc668be743cf08a9d54f\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"2ee17298-8d85-48e2-9e3f-ed7db7b9d2bc\",\"attempt\":1,\"phase\":\"stream-complete\",\"observedAt\":\"2026-10-17T14:53:40.182Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg7zy2niaY5GwpEZUMo6f\",\"status\":200,\"streamEventCount\":79,\"textChars\":733,\"firstStreamEventAt\":\"2026-10-17T14:53:36.745Z\",\"lastStreamEventAt\":\"2026-10-17T14:53:40.176Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"e0cbdf7383cad246a36c0c75c43fa20add5a0f88ecf0fc668be743cf08a9d54f\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"4e3b9ed9-7b14-453d-a52b-3d44982920e9\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"request\",\"observedAt\":\"2026-10-17T14:54:20.811Z\",\"servedAccount\":null,\"providerRequestId\":null,\"status\":null,\"promptSha256\":\"0cfd8fd60c406452588eed1b9c900e5710135d5f59b59e1e5f37e827a8ae950b\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"4e3b9ed9-7b14-453d-a52b-3d44982920e9\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"response\",\"observedAt\":\"2026-10-17T14:54:21.796Z\",\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg812Mpn6YhRbm4pVj2H6\",\"status\":200,\"promptSha256\":\"0cfd8fd60c406452588eed1b9c900e5710135d5f59b59e1e5f37e827a8ae950b\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"4e3b9ed9-7b14-453d-a52b-3d44982920e9\",\"attempt\":1,\"phase\":\"stream-progress\",\"observedAt\":\"2026-10-17T14:54:21.797Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg812Mpn6YhRbm4pVj2H6\",\"status\":200,\"streamEventCount\":1,\"textChars\":0,\"firstStreamEventAt\":\"2026-10-17T14:54:21.797Z\",\"lastStreamEventAt\":\"2026-10-17T14:54:21.797Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"0cfd8fd60c406452588eed1b9c900e5710135d5f59b59e1e5f37e827a8ae950b\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"4e3b9ed9-7b14-453d-a52b-3d44982920e9\",\"attempt\":1,\"phase\":\"stream-complete\",\"observedAt\":\"2026-10-17T14:54:26.413Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg812Mpn6YhRbm4pVj2H6\",\"status\":200,\"streamEventCount\":102,\"textChars\":879,\"firstStreamEventAt\":\"2026-10-17T14:54:21.797Z\",\"lastStreamEventAt\":\"2026-10-17T14:54:26.384Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"0cfd8fd60c406452588eed1b9c900e5710135d5f59b59e1e5f37e827a8ae950b\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"08629a1f-a409-4604-96dd-983b165f23eb\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"request\",\"observedAt\":\"2026-10-17T14:54:59.575Z\",\"servedAccount\":null,\"providerRequestId\":null,\"status\":null,\"promptSha256\":\"736944a87fd4283ff10b11d227485ac037de3545612b88dbf7406ae372167655\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"08629a1f-a409-4604-96dd-983b165f23eb\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"response\",\"observedAt\":\"2026-10-17T14:55:00.673Z\",\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg815DnBWD7X2MmDtz7vV\",\"status\":200,\"promptSha256\":\"736944a87fd4283ff10b11d227485ac037de3545612b88dbf7406ae372167655\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"08629a1f-a409-4604-96dd-983b165f23eb\",\"attempt\":1,\"phase\":\"stream-progress\",\"observedAt\":\"2026-10-17T14:55:00.674Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg815DnBWD7X2MmDtz7vV\",\"status\":200,\"streamEventCount\":1,\"textChars\":0,\"firstStreamEventAt\":\"2026-10-17T14:55:00.674Z\",\"lastStreamEventAt\":\"2026-10-17T14:55:00.674Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"736944a87fd4283ff10b11d227485ac037de3545612b88dbf7406ae372167655\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"08629a1f-a409-4604-96dd-983b165f23eb\",\"attempt\":1,\"phase\":\"stream-complete\",\"observedAt\":\"2026-10-17T14:55:04.365Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg815DnBWD7X2MmDtz7vV\",\"status\":200,\"streamEventCount\":82,\"textChars\":679,\"firstStreamEventAt\":\"2026-10-17T14:55:00.674Z\",\"lastStreamEventAt\":\"2026-10-17T14:55:04.365Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"736944a87fd4283ff10b11d227485ac037de3545612b88dbf7406ae372167655\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n  ✓ verdict=pass (3 runs)\n     run #1 status=passed cost=$0.0111 turns=2\n     run #2 status=passed cost=$0.0116 turns=2\n     run #3 status=passed cost=$0.0106 turns=2\n  ledger test_runs.id=21336969 layer=llm\n\nHARNESS_RESULT harness=llm-scenario-battery verdict=pass run=20261017T145245Z-3657466 first_failure=none passed=1 failed=0 blocked=0 skipped=0 reused=0 evidence=/mnt/data/offload/verification-harness/llm-scenario-battery/20261017T145245Z-3657466\n",
    "no-event": "\n> @papercusp/web@0.0.1 llm-test\n> tsx bin/llm-test.ts --scenario su-S41-scheduler-no-event\n\n[db] target source=operator-env-file endpoint=localhost:5432\n[flags] No override store installed in this process: runtime overrides (flags:set / POST /api/flags/set) are INVISIBLE here and getFlag() is serving FLAG_DEFAULTS. If this process is expected to observe runtime flag flips, call initFlagOverrideStore() during boot BEFORE any flag is resolved (operator-core: installFlagOverrideStore()). Silence with PAPERCUSP_SILENCE_FLAG_OVERRIDE_WARN=1 if defaults-only is intentional.\n[llm-test] inference-gateway ON → routing LLM calls through http://127.0.0.1:8788\nVH_RETENTION_DEFERRED stage=before reason=retention-mutex-busy evidence=/mnt/data/offload/verification-harness/llm-scenario-battery\n\n▶ su-S41-scheduler-no-event  [su]\n[llm-transport] {\"callId\":\"09785bd0-b898-4f36-88cd-177c44597770\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"request\",\"observedAt\":\"2026-10-17T14:53:43.353Z\",\"servedAccount\":null,\"providerRequestId\":null,\"status\":null,\"promptSha256\":\"01452b152c11074c148970031979b5fd93eb2dcd1755135f889cc0496432b150\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"09785bd0-b898-4f36-88cd-177c44597770\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"response\",\"observedAt\":\"2026-10-17T14:53:44.242Z\",\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg7zybJ4yPo29WUNiC1qv\",\"status\":200,\"promptSha256\":\"01452b152c11074c148970031979b5fd93eb2dcd1755135f889cc0496432b150\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"09785bd0-b898-4f36-88cd-177c44597770\",\"attempt\":1,\"phase\":\"stream-progress\",\"observedAt\":\"2026-10-17T14:53:44.244Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg7zybJ4yPo29WUNiC1qv\",\"status\":200,\"streamEventCount\":1,\"textChars\":0,\"firstStreamEventAt\":\"2026-10-17T14:53:44.244Z\",\"lastStreamEventAt\":\"2026-10-17T14:53:44.244Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"01452b152c11074c148970031979b5fd93eb2dcd1755135f889cc0496432b150\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"09785bd0-b898-4f36-88cd-177c44597770\",\"attempt\":1,\"phase\":\"stream-progress\",\"observedAt\":\"2026-10-17T14:53:49.269Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg7zybJ4yPo29WUNiC1qv\",\"status\":200,\"streamEventCount\":108,\"textChars\":963,\"firstStreamEventAt\":\"2026-10-17T14:53:44.244Z\",\"lastStreamEventAt\":\"2026-10-17T14:53:49.268Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"01452b152c11074c148970031979b5fd93eb2dcd1755135f889cc0496432b150\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"09785bd0-b898-4f36-88cd-177c44597770\",\"attempt\":1,\"phase\":\"stream-complete\",\"observedAt\":\"2026-10-17T14:53:51.410Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg7zybJ4yPo29WUNiC1qv\",\"status\":200,\"streamEventCount\":156,\"textChars\":1440,\"firstStreamEventAt\":\"2026-10-17T14:53:44.244Z\",\"lastStreamEventAt\":\"2026-10-17T14:53:51.403Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"01452b152c11074c148970031979b5fd93eb2dcd1755135f889cc0496432b150\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"104e90d6-528e-47ed-810a-206220cae8ad\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"request\",\"observedAt\":\"2026-10-17T14:54:47.097Z\",\"servedAccount\":null,\"providerRequestId\":null,\"status\":null,\"promptSha256\":\"4c42f4124474533396224296101dd8338cbaad1f5049ad683760fad13d125c7b\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"104e90d6-528e-47ed-810a-206220cae8ad\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"response\",\"observedAt\":\"2026-10-17T14:54:48.063Z\",\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg814Jd78Ax6QNxoJCAWS\",\"status\":200,\"promptSha256\":\"4c42f4124474533396224296101dd8338cbaad1f5049ad683760fad13d125c7b\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"104e90d6-528e-47ed-810a-206220cae8ad\",\"attempt\":1,\"phase\":\"stream-progress\",\"observedAt\":\"2026-10-17T14:54:48.064Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg814Jd78Ax6QNxoJCAWS\",\"status\":200,\"streamEventCount\":1,\"textChars\":0,\"firstStreamEventAt\":\"2026-10-17T14:54:48.064Z\",\"lastStreamEventAt\":\"2026-10-17T14:54:48.064Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"4c42f4124474533396224296101dd8338cbaad1f5049ad683760fad13d125c7b\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"104e90d6-528e-47ed-810a-206220cae8ad\",\"attempt\":1,\"phase\":\"stream-progress\",\"observedAt\":\"2026-10-17T14:54:53.074Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg814Jd78Ax6QNxoJCAWS\",\"status\":200,\"streamEventCount\":107,\"textChars\":1208,\"firstStreamEventAt\":\"2026-10-17T14:54:48.064Z\",\"lastStreamEventAt\":\"2026-10-17T14:54:53.074Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"4c42f4124474533396224296101dd8338cbaad1f5049ad683760fad13d125c7b\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"104e90d6-528e-47ed-810a-206220cae8ad\",\"attempt\":1,\"phase\":\"stream-complete\",\"observedAt\":\"2026-10-17T14:54:55.877Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg814Jd78Ax6QNxoJCAWS\",\"status\":200,\"streamEventCount\":169,\"textChars\":1727,\"firstStreamEventAt\":\"2026-10-17T14:54:48.064Z\",\"lastStreamEventAt\":\"2026-10-17T14:54:55.870Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"4c42f4124474533396224296101dd8338cbaad1f5049ad683760fad13d125c7b\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"d6118f62-1872-4065-9b01-a445c89c9ee4\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"request\",\"observedAt\":\"2026-10-17T14:55:29.759Z\",\"servedAccount\":null,\"providerRequestId\":null,\"status\":null,\"promptSha256\":\"6a985deb6e82e9ce13dc35ccbb28eceb31493af9b37b0cd2380219ba48115f90\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"d6118f62-1872-4065-9b01-a445c89c9ee4\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"response\",\"observedAt\":\"2026-10-17T14:55:30.809Z\",\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg817TG6iYKBj3uTqb25a\",\"status\":200,\"promptSha256\":\"6a985deb6e82e9ce13dc35ccbb28eceb31493af9b37b0cd2380219ba48115f90\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"d6118f62-1872-4065-9b01-a445c89c9ee4\",\"attempt\":1,\"phase\":\"stream-progress\",\"observedAt\":\"2026-10-17T14:55:30.810Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg817TG6iYKBj3uTqb25a\",\"status\":200,\"streamEventCount\":1,\"textChars\":0,\"firstStreamEventAt\":\"2026-10-17T14:55:30.810Z\",\"lastStreamEventAt\":\"2026-10-17T14:55:30.810Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"6a985deb6e82e9ce13dc35ccbb28eceb31493af9b37b0cd2380219ba48115f90\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"d6118f62-1872-4065-9b01-a445c89c9ee4\",\"attempt\":1,\"phase\":\"stream-progress\",\"observedAt\":\"2026-10-17T14:55:35.834Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg817TG6iYKBj3uTqb25a\",\"status\":200,\"streamEventCount\":102,\"textChars\":897,\"firstStreamEventAt\":\"2026-10-17T14:55:30.810Z\",\"lastStreamEventAt\":\"2026-10-17T14:55:35.833Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"6a985deb6e82e9ce13dc35ccbb28eceb31493af9b37b0cd2380219ba48115f90\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"d6118f62-1872-4065-9b01-a445c89c9ee4\",\"attempt\":1,\"phase\":\"stream-complete\",\"observedAt\":\"2026-10-17T14:55:37.921Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg817TG6iYKBj3uTqb25a\",\"status\":200,\"streamEventCount\":144,\"textChars\":1316,\"firstStreamEventAt\":\"2026-10-17T14:55:30.810Z\",\"lastStreamEventAt\":\"2026-10-17T14:55:37.920Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"6a985deb6e82e9ce13dc35ccbb28eceb31493af9b37b0cd2380219ba48115f90\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n  ✓ verdict=pass (3 runs)\n     run #1 status=passed cost=$0.0125 turns=2\n       judge:   0 error / 1 warn\n     run #2 status=passed cost=$0.0134 turns=2\n     run #3 status=passed cost=$0.0120 turns=2\n       judge:   0 error / 1 warn\n  ledger test_runs.id=21336971 layer=llm\n\nHARNESS_RESULT harness=llm-scenario-battery verdict=pass run=20261017T145245Z-3657484 first_failure=none passed=1 failed=0 blocked=0 skipped=0 reused=0 evidence=/mnt/data/offload/verification-harness/llm-scenario-battery/20261017T145245Z-3657484\n",
    "finished": "\n> @papercusp/web@0.0.1 llm-test\n> tsx bin/llm-test.ts --scenario su-S41-scheduler-finished\n\n[db] target source=operator-env-file endpoint=localhost:5432\n[flags] No override store installed in this process: runtime overrides (flags:set / POST /api/flags/set) are INVISIBLE here and getFlag() is serving FLAG_DEFAULTS. If this process is expected to observe runtime flag flips, call initFlagOverrideStore() during boot BEFORE any flag is resolved (operator-core: installFlagOverrideStore()). Silence with PAPERCUSP_SILENCE_FLAG_OVERRIDE_WARN=1 if defaults-only is intentional.\n[llm-test] inference-gateway ON → routing LLM calls through http://127.0.0.1:8788\n\n▶ su-S41-scheduler-finished  [su]\n[llm-transport] {\"callId\":\"56eabd1f-4fa3-4e31-b727-b94ae856f7d2\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"request\",\"observedAt\":\"2026-10-17T14:53:25.944Z\",\"servedAccount\":null,\"providerRequestId\":null,\"status\":null,\"promptSha256\":\"a18c5ae7639b1d8ebf5a7fb0298c739883e31d55867f70e9b38f7219bd271855\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"56eabd1f-4fa3-4e31-b727-b94ae856f7d2\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"response\",\"observedAt\":\"2026-10-17T14:53:27.139Z\",\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg7zxL1n7suYQJtVWcq6X\",\"status\":200,\"promptSha256\":\"a18c5ae7639b1d8ebf5a7fb0298c739883e31d55867f70e9b38f7219bd271855\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"56eabd1f-4fa3-4e31-b727-b94ae856f7d2\",\"attempt\":1,\"phase\":\"stream-progress\",\"observedAt\":\"2026-10-17T14:53:27.142Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg7zxL1n7suYQJtVWcq6X\",\"status\":200,\"streamEventCount\":1,\"textChars\":0,\"firstStreamEventAt\":\"2026-10-17T14:53:27.142Z\",\"lastStreamEventAt\":\"2026-10-17T14:53:27.142Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"a18c5ae7639b1d8ebf5a7fb0298c739883e31d55867f70e9b38f7219bd271855\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"56eabd1f-4fa3-4e31-b727-b94ae856f7d2\",\"attempt\":1,\"phase\":\"stream-complete\",\"observedAt\":\"2026-10-17T14:53:30.270Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg7zxL1n7suYQJtVWcq6X\",\"status\":200,\"streamEventCount\":71,\"textChars\":691,\"firstStreamEventAt\":\"2026-10-17T14:53:27.142Z\",\"lastStreamEventAt\":\"2026-10-17T14:53:30.264Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"a18c5ae7639b1d8ebf5a7fb0298c739883e31d55867f70e9b38f7219bd271855\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"830d4064-14fd-41b8-9f89-d1263a9ab0d6\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"request\",\"observedAt\":\"2026-10-17T14:54:12.825Z\",\"servedAccount\":null,\"providerRequestId\":null,\"status\":null,\"promptSha256\":\"05433cffebfbd1176c0b4469af89b485f49f3e0c3a0046200b7c14d9e0376f5b\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"830d4064-14fd-41b8-9f89-d1263a9ab0d6\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"response\",\"observedAt\":\"2026-10-17T14:54:13.742Z\",\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg811mw6FEAbu4EUmWP2w\",\"status\":200,\"promptSha256\":\"05433cffebfbd1176c0b4469af89b485f49f3e0c3a0046200b7c14d9e0376f5b\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"830d4064-14fd-41b8-9f89-d1263a9ab0d6\",\"attempt\":1,\"phase\":\"stream-progress\",\"observedAt\":\"2026-10-17T14:54:13.743Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg811mw6FEAbu4EUmWP2w\",\"status\":200,\"streamEventCount\":1,\"textChars\":0,\"firstStreamEventAt\":\"2026-10-17T14:54:13.743Z\",\"lastStreamEventAt\":\"2026-10-17T14:54:13.743Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"05433cffebfbd1176c0b4469af89b485f49f3e0c3a0046200b7c14d9e0376f5b\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"830d4064-14fd-41b8-9f89-d1263a9ab0d6\",\"attempt\":1,\"phase\":\"stream-complete\",\"observedAt\":\"2026-10-17T14:54:17.198Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg811mw6FEAbu4EUmWP2w\",\"status\":200,\"streamEventCount\":78,\"textChars\":706,\"firstStreamEventAt\":\"2026-10-17T14:54:13.743Z\",\"lastStreamEventAt\":\"2026-10-17T14:54:17.192Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"05433cffebfbd1176c0b4469af89b485f49f3e0c3a0046200b7c14d9e0376f5b\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"69d3febc-ea74-4d64-92ed-c0a7f5a23337\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"request\",\"observedAt\":\"2026-10-17T14:54:44.474Z\",\"servedAccount\":null,\"providerRequestId\":null,\"status\":null,\"promptSha256\":\"291631bcbc38267ed9dca4d9f24ef22869b298864f4466d55aa1f8492d580ecf\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"69d3febc-ea74-4d64-92ed-c0a7f5a23337\",\"attempt\":1,\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"governorMode\":\"disabled\",\"loopback\":true,\"requestedAccount\":null,\"phase\":\"response\",\"observedAt\":\"2026-10-17T14:54:45.536Z\",\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg8147VsoJZQZjEAa43uc\",\"status\":200,\"promptSha256\":\"291631bcbc38267ed9dca4d9f24ef22869b298864f4466d55aa1f8492d580ecf\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"69d3febc-ea74-4d64-92ed-c0a7f5a23337\",\"attempt\":1,\"phase\":\"stream-progress\",\"observedAt\":\"2026-10-17T14:54:45.537Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg8147VsoJZQZjEAa43uc\",\"status\":200,\"streamEventCount\":1,\"textChars\":0,\"firstStreamEventAt\":\"2026-10-17T14:54:45.537Z\",\"lastStreamEventAt\":\"2026-10-17T14:54:45.537Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"291631bcbc38267ed9dca4d9f24ef22869b298864f4466d55aa1f8492d580ecf\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n[llm-transport] {\"callId\":\"69d3febc-ea74-4d64-92ed-c0a7f5a23337\",\"attempt\":1,\"phase\":\"stream-complete\",\"observedAt\":\"2026-10-17T14:54:49.324Z\",\"label\":\"anthropic-direct\",\"endpointOrigin\":\"http://127.0.0.1:8788\",\"loopback\":true,\"governorMode\":\"disabled\",\"requestedAccount\":null,\"servedAccount\":\"aviynw3_claude\",\"providerRequestId\":\"req_011Cg8147VsoJZQZjEAa43uc\",\"status\":200,\"streamEventCount\":85,\"textChars\":761,\"firstStreamEventAt\":\"2026-10-17T14:54:45.537Z\",\"lastStreamEventAt\":\"2026-10-17T14:54:49.316Z\",\"callerAborted\":null,\"callerAbortReason\":null,\"promptSha256\":\"291631bcbc38267ed9dca4d9f24ef22869b298864f4466d55aa1f8492d580ecf\",\"model\":\"claude-sonnet-4-6\",\"ownerId\":null}\n  ✓ verdict=pass (3 runs)\n     run #1 status=passed cost=$0.0089 turns=2\n     run #2 status=passed cost=$0.0088 turns=2\n     run #3 status=passed cost=$0.0089 turns=2\n  ledger test_runs.id=21336966 layer=llm\n\nHARNESS_RESULT harness=llm-scenario-battery verdict=pass run=20261017T145246Z-3657442 first_failure=none passed=1 failed=0 blocked=0 skipped=0 reused=0 evidence=/mnt/data/offload/verification-harness/llm-scenario-battery/20261017T145246Z-3657442\n"
  },
  "scenarioSummaries": {
    "independent": {
      "scenarioId": "su-S41-scheduler-independent",
      "verdict": "fail",
      "runs": [
        {
          "status": "failed",
          "costUsd": 0.022662,
          "turns": 2,
          "assertErrors": [
            "[custom:scheduler-obligations:bounded-dependency-wake-missing] Scheduler miss independent: bounded-dependency-wake-missing"
          ],
          "judgeErrors": [
            "conventionAdherence: The scheduler advice (visible in the truncated tool result) explicitly states: 'copy the supplied dependency event key exactly, record its typed blocker with work_items:set_blocker if not already recorded, then register events:await for the exact recorded blocker event with a positive timeout_sec matched to its recheckAt and on_timeout:\"wake\".' The blocker harness:widget:peer-review:ready was already recorded (active:true). The assistant skipped events:await entirely, leaving no bounded wake registered.",
            "helpfulness: The user's goal requires the loop to have a guaranteed bounded wake for the retained blocked item. Without events:await, the loop is armed but has no guaranteed wake tied to the dependency event, leaving the task in an indeterminate state.",
            "conventionAdherence: The scheduler advice also states 'Keep the existing loop armed until registration succeeds' — implying events:await must be called before the turn ends. The assistant read the scheduler result (which contained this advice) but did not act on the events:await requirement, violating the push-not-poll / bounded-wake convention."
          ],
          "llmCallDiagnostics": {
            "events": [
              {
                "callId": "de56e859-167f-4ca1-89f1-ddf9636e9db0",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "request",
                "observedAt": "2026-10-17T14:53:38.089Z",
                "servedAccount": null,
                "providerRequestId": null,
                "status": null
              },
              {
                "callId": "de56e859-167f-4ca1-89f1-ddf9636e9db0",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "response",
                "observedAt": "2026-10-17T14:53:40.405Z",
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg7zyDiJRYUmM7T7kkt9m",
                "status": 200
              },
              {
                "callId": "de56e859-167f-4ca1-89f1-ddf9636e9db0",
                "attempt": 1,
                "phase": "stream-progress",
                "observedAt": "2026-10-17T14:53:40.408Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg7zyDiJRYUmM7T7kkt9m",
                "status": 200,
                "streamEventCount": 1,
                "textChars": 0,
                "firstStreamEventAt": "2026-10-17T14:53:40.408Z",
                "lastStreamEventAt": "2026-10-17T14:53:40.408Z",
                "callerAborted": null,
                "callerAbortReason": null
              },
              {
                "callId": "de56e859-167f-4ca1-89f1-ddf9636e9db0",
                "attempt": 1,
                "phase": "stream-progress",
                "observedAt": "2026-10-17T14:53:45.420Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg7zyDiJRYUmM7T7kkt9m",
                "status": 200,
                "streamEventCount": 102,
                "textChars": 1035,
                "firstStreamEventAt": "2026-10-17T14:53:40.408Z",
                "lastStreamEventAt": "2026-10-17T14:53:45.420Z",
                "callerAborted": null,
                "callerAbortReason": null
              },
              {
                "callId": "de56e859-167f-4ca1-89f1-ddf9636e9db0",
                "attempt": 1,
                "phase": "stream-progress",
                "observedAt": "2026-10-17T14:53:50.451Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg7zyDiJRYUmM7T7kkt9m",
                "status": 200,
                "streamEventCount": 198,
                "textChars": 2288,
                "firstStreamEventAt": "2026-10-17T14:53:40.408Z",
                "lastStreamEventAt": "2026-10-17T14:53:50.451Z",
                "callerAborted": null,
                "callerAbortReason": null
              },
              {
                "callId": "de56e859-167f-4ca1-89f1-ddf9636e9db0",
                "attempt": 1,
                "phase": "stream-progress",
                "observedAt": "2026-10-17T14:53:55.492Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg7zyDiJRYUmM7T7kkt9m",
                "status": 200,
                "streamEventCount": 296,
                "textChars": 3391,
                "firstStreamEventAt": "2026-10-17T14:53:40.408Z",
                "lastStreamEventAt": "2026-10-17T14:53:55.492Z",
                "callerAborted": null,
                "callerAbortReason": null
              },
              {
                "callId": "de56e859-167f-4ca1-89f1-ddf9636e9db0",
                "attempt": 1,
                "phase": "stream-complete",
                "observedAt": "2026-10-17T14:53:57.729Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg7zyDiJRYUmM7T7kkt9m",
                "status": 200,
                "streamEventCount": 343,
                "textChars": 3867,
                "firstStreamEventAt": "2026-10-17T14:53:40.408Z",
                "lastStreamEventAt": "2026-10-17T14:53:57.720Z",
                "callerAborted": null,
                "callerAbortReason": null
              }
            ],
            "total": 7,
            "omitted": 0
          }
        },
        {
          "status": "passed",
          "costUsd": 0.011619,
          "turns": 2,
          "assertErrors": [],
          "judgeErrors": [],
          "llmCallDiagnostics": {
            "events": [
              {
                "callId": "0c26040a-4a19-456b-a02d-894a390235a5",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "request",
                "observedAt": "2026-10-17T14:54:38.598Z",
                "servedAccount": null,
                "providerRequestId": null,
                "status": null
              },
              {
                "callId": "0c26040a-4a19-456b-a02d-894a390235a5",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "response",
                "observedAt": "2026-10-17T14:54:41.020Z",
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg813fsmS2EfRHuMuEksK",
                "status": 200
              },
              {
                "callId": "0c26040a-4a19-456b-a02d-894a390235a5",
                "attempt": 1,
                "phase": "stream-progress",
                "observedAt": "2026-10-17T14:54:41.022Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg813fsmS2EfRHuMuEksK",
                "status": 200,
                "streamEventCount": 1,
                "textChars": 0,
                "firstStreamEventAt": "2026-10-17T14:54:41.022Z",
                "lastStreamEventAt": "2026-10-17T14:54:41.022Z",
                "callerAborted": null,
                "callerAbortReason": null
              },
              {
                "callId": "0c26040a-4a19-456b-a02d-894a390235a5",
                "attempt": 1,
                "phase": "stream-complete",
                "observedAt": "2026-10-17T14:54:45.100Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg813fsmS2EfRHuMuEksK",
                "status": 200,
                "streamEventCount": 86,
                "textChars": 730,
                "firstStreamEventAt": "2026-10-17T14:54:41.022Z",
                "lastStreamEventAt": "2026-10-17T14:54:45.090Z",
                "callerAborted": null,
                "callerAbortReason": null
              }
            ],
            "total": 4,
            "omitted": 0
          }
        },
        {
          "status": "failed",
          "costUsd": 0.022791,
          "turns": 2,
          "assertErrors": [
            "[custom:scheduler-obligations:bounded-dependency-wake-missing] Scheduler miss independent: bounded-dependency-wake-missing"
          ],
          "judgeErrors": [
            "conventionAdherence: The scheduler advice (visible in the truncated tool result) explicitly instructed: copy the supplied dependency event key exactly, record its typed blocker with work_items:set_blocker if not already recorded, then register events:await for the exact recorded blocker event with a positive timeout_sec matched to its recheckAt and on_timeout:\"wake\". The assistant did neither, leaving the loop without a bounded wake.",
            "toolSelection: The correct tool sequence after finishing independent work was work_items:set_blocker (verify/record the event blocker) followed by events:await (register the bounded wake). Neither was called despite both tools being present in the discovered registry and the scheduler advice naming them explicitly."
          ],
          "llmCallDiagnostics": {
            "events": [
              {
                "callId": "94648cb0-516d-47ff-8c3c-3f66fcbca6a4",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "request",
                "observedAt": "2026-10-17T14:55:22.182Z",
                "servedAccount": null,
                "providerRequestId": null,
                "status": null
              },
              {
                "callId": "94648cb0-516d-47ff-8c3c-3f66fcbca6a4",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "response",
                "observedAt": "2026-10-17T14:55:23.147Z",
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg816tbpAA8u344QSyXkk",
                "status": 200
              },
              {
                "callId": "94648cb0-516d-47ff-8c3c-3f66fcbca6a4",
                "attempt": 1,
                "phase": "stream-progress",
                "observedAt": "2026-10-17T14:55:23.148Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg816tbpAA8u344QSyXkk",
                "status": 200,
                "streamEventCount": 1,
                "textChars": 0,
                "firstStreamEventAt": "2026-10-17T14:55:23.147Z",
                "lastStreamEventAt": "2026-10-17T14:55:23.147Z",
                "callerAborted": null,
                "callerAbortReason": null
              },
              {
                "callId": "94648cb0-516d-47ff-8c3c-3f66fcbca6a4",
                "attempt": 1,
                "phase": "stream-progress",
                "observedAt": "2026-10-17T14:55:28.163Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg816tbpAA8u344QSyXkk",
                "status": 200,
                "streamEventCount": 110,
                "textChars": 1300,
                "firstStreamEventAt": "2026-10-17T14:55:23.147Z",
                "lastStreamEventAt": "2026-10-17T14:55:28.162Z",
                "callerAborted": null,
                "callerAbortReason": null
              },
              {
                "callId": "94648cb0-516d-47ff-8c3c-3f66fcbca6a4",
                "attempt": 1,
                "phase": "stream-progress",
                "observedAt": "2026-10-17T14:55:33.209Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg816tbpAA8u344QSyXkk",
                "status": 200,
                "streamEventCount": 216,
                "textChars": 2569,
                "firstStreamEventAt": "2026-10-17T14:55:23.147Z",
                "lastStreamEventAt": "2026-10-17T14:55:33.208Z",
                "callerAborted": null,
                "callerAbortReason": null
              },
              {
                "callId": "94648cb0-516d-47ff-8c3c-3f66fcbca6a4",
                "attempt": 1,
                "phase": "stream-complete",
                "observedAt": "2026-10-17T14:55:37.490Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg816tbpAA8u344QSyXkk",
                "status": 200,
                "streamEventCount": 309,
                "textChars": 3566,
                "firstStreamEventAt": "2026-10-17T14:55:23.147Z",
                "lastStreamEventAt": "2026-10-17T14:55:37.489Z",
                "callerAborted": null,
                "callerAbortReason": null
              }
            ],
            "total": 6,
            "omitted": 0
          }
        }
      ]
    },
    "blocked": {
      "scenarioId": "su-S41-scheduler-blocked",
      "verdict": "pass",
      "runs": [
        {
          "status": "passed",
          "costUsd": 0.011109,
          "turns": 2,
          "assertErrors": [],
          "judgeErrors": [],
          "llmCallDiagnostics": {
            "events": [
              {
                "callId": "2ee17298-8d85-48e2-9e3f-ed7db7b9d2bc",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "request",
                "observedAt": "2026-10-17T14:53:35.246Z",
                "servedAccount": null,
                "providerRequestId": null,
                "status": null
              },
              {
                "callId": "2ee17298-8d85-48e2-9e3f-ed7db7b9d2bc",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "response",
                "observedAt": "2026-10-17T14:53:36.742Z",
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg7zy2niaY5GwpEZUMo6f",
                "status": 200
              },
              {
                "callId": "2ee17298-8d85-48e2-9e3f-ed7db7b9d2bc",
                "attempt": 1,
                "phase": "stream-progress",
                "observedAt": "2026-10-17T14:53:36.745Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg7zy2niaY5GwpEZUMo6f",
                "status": 200,
                "streamEventCount": 1,
                "textChars": 0,
                "firstStreamEventAt": "2026-10-17T14:53:36.745Z",
                "lastStreamEventAt": "2026-10-17T14:53:36.745Z",
                "callerAborted": null,
                "callerAbortReason": null
              },
              {
                "callId": "2ee17298-8d85-48e2-9e3f-ed7db7b9d2bc",
                "attempt": 1,
                "phase": "stream-complete",
                "observedAt": "2026-10-17T14:53:40.182Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg7zy2niaY5GwpEZUMo6f",
                "status": 200,
                "streamEventCount": 79,
                "textChars": 733,
                "firstStreamEventAt": "2026-10-17T14:53:36.745Z",
                "lastStreamEventAt": "2026-10-17T14:53:40.176Z",
                "callerAborted": null,
                "callerAbortReason": null
              }
            ],
            "total": 4,
            "omitted": 0
          }
        },
        {
          "status": "passed",
          "costUsd": 0.011643,
          "turns": 2,
          "assertErrors": [],
          "judgeErrors": [],
          "llmCallDiagnostics": {
            "events": [
              {
                "callId": "4e3b9ed9-7b14-453d-a52b-3d44982920e9",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "request",
                "observedAt": "2026-10-17T14:54:20.811Z",
                "servedAccount": null,
                "providerRequestId": null,
                "status": null
              },
              {
                "callId": "4e3b9ed9-7b14-453d-a52b-3d44982920e9",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "response",
                "observedAt": "2026-10-17T14:54:21.796Z",
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg812Mpn6YhRbm4pVj2H6",
                "status": 200
              },
              {
                "callId": "4e3b9ed9-7b14-453d-a52b-3d44982920e9",
                "attempt": 1,
                "phase": "stream-progress",
                "observedAt": "2026-10-17T14:54:21.797Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg812Mpn6YhRbm4pVj2H6",
                "status": 200,
                "streamEventCount": 1,
                "textChars": 0,
                "firstStreamEventAt": "2026-10-17T14:54:21.797Z",
                "lastStreamEventAt": "2026-10-17T14:54:21.797Z",
                "callerAborted": null,
                "callerAbortReason": null
              },
              {
                "callId": "4e3b9ed9-7b14-453d-a52b-3d44982920e9",
                "attempt": 1,
                "phase": "stream-complete",
                "observedAt": "2026-10-17T14:54:26.413Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg812Mpn6YhRbm4pVj2H6",
                "status": 200,
                "streamEventCount": 102,
                "textChars": 879,
                "firstStreamEventAt": "2026-10-17T14:54:21.797Z",
                "lastStreamEventAt": "2026-10-17T14:54:26.384Z",
                "callerAborted": null,
                "callerAbortReason": null
              }
            ],
            "total": 4,
            "omitted": 0
          }
        },
        {
          "status": "passed",
          "costUsd": 0.010557,
          "turns": 2,
          "assertErrors": [],
          "judgeErrors": [],
          "llmCallDiagnostics": {
            "events": [
              {
                "callId": "08629a1f-a409-4604-96dd-983b165f23eb",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "request",
                "observedAt": "2026-10-17T14:54:59.575Z",
                "servedAccount": null,
                "providerRequestId": null,
                "status": null
              },
              {
                "callId": "08629a1f-a409-4604-96dd-983b165f23eb",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "response",
                "observedAt": "2026-10-17T14:55:00.673Z",
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg815DnBWD7X2MmDtz7vV",
                "status": 200
              },
              {
                "callId": "08629a1f-a409-4604-96dd-983b165f23eb",
                "attempt": 1,
                "phase": "stream-progress",
                "observedAt": "2026-10-17T14:55:00.674Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg815DnBWD7X2MmDtz7vV",
                "status": 200,
                "streamEventCount": 1,
                "textChars": 0,
                "firstStreamEventAt": "2026-10-17T14:55:00.674Z",
                "lastStreamEventAt": "2026-10-17T14:55:00.674Z",
                "callerAborted": null,
                "callerAbortReason": null
              },
              {
                "callId": "08629a1f-a409-4604-96dd-983b165f23eb",
                "attempt": 1,
                "phase": "stream-complete",
                "observedAt": "2026-10-17T14:55:04.365Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg815DnBWD7X2MmDtz7vV",
                "status": 200,
                "streamEventCount": 82,
                "textChars": 679,
                "firstStreamEventAt": "2026-10-17T14:55:00.674Z",
                "lastStreamEventAt": "2026-10-17T14:55:04.365Z",
                "callerAborted": null,
                "callerAbortReason": null
              }
            ],
            "total": 4,
            "omitted": 0
          }
        }
      ]
    },
    "no-event": {
      "scenarioId": "su-S41-scheduler-no-event",
      "verdict": "pass",
      "runs": [
        {
          "status": "passed",
          "costUsd": 0.012486,
          "turns": 2,
          "assertErrors": [],
          "judgeErrors": [],
          "llmCallDiagnostics": {
            "events": [
              {
                "callId": "09785bd0-b898-4f36-88cd-177c44597770",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "request",
                "observedAt": "2026-10-17T14:53:43.353Z",
                "servedAccount": null,
                "providerRequestId": null,
                "status": null
              },
              {
                "callId": "09785bd0-b898-4f36-88cd-177c44597770",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "response",
                "observedAt": "2026-10-17T14:53:44.242Z",
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg7zybJ4yPo29WUNiC1qv",
                "status": 200
              },
              {
                "callId": "09785bd0-b898-4f36-88cd-177c44597770",
                "attempt": 1,
                "phase": "stream-progress",
                "observedAt": "2026-10-17T14:53:44.244Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg7zybJ4yPo29WUNiC1qv",
                "status": 200,
                "streamEventCount": 1,
                "textChars": 0,
                "firstStreamEventAt": "2026-10-17T14:53:44.244Z",
                "lastStreamEventAt": "2026-10-17T14:53:44.244Z",
                "callerAborted": null,
                "callerAbortReason": null
              },
              {
                "callId": "09785bd0-b898-4f36-88cd-177c44597770",
                "attempt": 1,
                "phase": "stream-progress",
                "observedAt": "2026-10-17T14:53:49.269Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg7zybJ4yPo29WUNiC1qv",
                "status": 200,
                "streamEventCount": 108,
                "textChars": 963,
                "firstStreamEventAt": "2026-10-17T14:53:44.244Z",
                "lastStreamEventAt": "2026-10-17T14:53:49.268Z",
                "callerAborted": null,
                "callerAbortReason": null
              },
              {
                "callId": "09785bd0-b898-4f36-88cd-177c44597770",
                "attempt": 1,
                "phase": "stream-complete",
                "observedAt": "2026-10-17T14:53:51.410Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg7zybJ4yPo29WUNiC1qv",
                "status": 200,
                "streamEventCount": 156,
                "textChars": 1440,
                "firstStreamEventAt": "2026-10-17T14:53:44.244Z",
                "lastStreamEventAt": "2026-10-17T14:53:51.403Z",
                "callerAborted": null,
                "callerAbortReason": null
              }
            ],
            "total": 5,
            "omitted": 0
          }
        },
        {
          "status": "passed",
          "costUsd": 0.013413,
          "turns": 2,
          "assertErrors": [],
          "judgeErrors": [],
          "llmCallDiagnostics": {
            "events": [
              {
                "callId": "104e90d6-528e-47ed-810a-206220cae8ad",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "request",
                "observedAt": "2026-10-17T14:54:47.097Z",
                "servedAccount": null,
                "providerRequestId": null,
                "status": null
              },
              {
                "callId": "104e90d6-528e-47ed-810a-206220cae8ad",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "response",
                "observedAt": "2026-10-17T14:54:48.063Z",
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg814Jd78Ax6QNxoJCAWS",
                "status": 200
              },
              {
                "callId": "104e90d6-528e-47ed-810a-206220cae8ad",
                "attempt": 1,
                "phase": "stream-progress",
                "observedAt": "2026-10-17T14:54:48.064Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg814Jd78Ax6QNxoJCAWS",
                "status": 200,
                "streamEventCount": 1,
                "textChars": 0,
                "firstStreamEventAt": "2026-10-17T14:54:48.064Z",
                "lastStreamEventAt": "2026-10-17T14:54:48.064Z",
                "callerAborted": null,
                "callerAbortReason": null
              },
              {
                "callId": "104e90d6-528e-47ed-810a-206220cae8ad",
                "attempt": 1,
                "phase": "stream-progress",
                "observedAt": "2026-10-17T14:54:53.074Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg814Jd78Ax6QNxoJCAWS",
                "status": 200,
                "streamEventCount": 107,
                "textChars": 1208,
                "firstStreamEventAt": "2026-10-17T14:54:48.064Z",
                "lastStreamEventAt": "2026-10-17T14:54:53.074Z",
                "callerAborted": null,
                "callerAbortReason": null
              },
              {
                "callId": "104e90d6-528e-47ed-810a-206220cae8ad",
                "attempt": 1,
                "phase": "stream-complete",
                "observedAt": "2026-10-17T14:54:55.877Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg814Jd78Ax6QNxoJCAWS",
                "status": 200,
                "streamEventCount": 169,
                "textChars": 1727,
                "firstStreamEventAt": "2026-10-17T14:54:48.064Z",
                "lastStreamEventAt": "2026-10-17T14:54:55.870Z",
                "callerAborted": null,
                "callerAbortReason": null
              }
            ],
            "total": 5,
            "omitted": 0
          }
        },
        {
          "status": "passed",
          "costUsd": 0.012039,
          "turns": 2,
          "assertErrors": [],
          "judgeErrors": [],
          "llmCallDiagnostics": {
            "events": [
              {
                "callId": "d6118f62-1872-4065-9b01-a445c89c9ee4",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "request",
                "observedAt": "2026-10-17T14:55:29.759Z",
                "servedAccount": null,
                "providerRequestId": null,
                "status": null
              },
              {
                "callId": "d6118f62-1872-4065-9b01-a445c89c9ee4",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "response",
                "observedAt": "2026-10-17T14:55:30.809Z",
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg817TG6iYKBj3uTqb25a",
                "status": 200
              },
              {
                "callId": "d6118f62-1872-4065-9b01-a445c89c9ee4",
                "attempt": 1,
                "phase": "stream-progress",
                "observedAt": "2026-10-17T14:55:30.810Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg817TG6iYKBj3uTqb25a",
                "status": 200,
                "streamEventCount": 1,
                "textChars": 0,
                "firstStreamEventAt": "2026-10-17T14:55:30.810Z",
                "lastStreamEventAt": "2026-10-17T14:55:30.810Z",
                "callerAborted": null,
                "callerAbortReason": null
              },
              {
                "callId": "d6118f62-1872-4065-9b01-a445c89c9ee4",
                "attempt": 1,
                "phase": "stream-progress",
                "observedAt": "2026-10-17T14:55:35.834Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg817TG6iYKBj3uTqb25a",
                "status": 200,
                "streamEventCount": 102,
                "textChars": 897,
                "firstStreamEventAt": "2026-10-17T14:55:30.810Z",
                "lastStreamEventAt": "2026-10-17T14:55:35.833Z",
                "callerAborted": null,
                "callerAbortReason": null
              },
              {
                "callId": "d6118f62-1872-4065-9b01-a445c89c9ee4",
                "attempt": 1,
                "phase": "stream-complete",
                "observedAt": "2026-10-17T14:55:37.921Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg817TG6iYKBj3uTqb25a",
                "status": 200,
                "streamEventCount": 144,
                "textChars": 1316,
                "firstStreamEventAt": "2026-10-17T14:55:30.810Z",
                "lastStreamEventAt": "2026-10-17T14:55:37.920Z",
                "callerAborted": null,
                "callerAbortReason": null
              }
            ],
            "total": 5,
            "omitted": 0
          }
        }
      ]
    },
    "finished": {
      "scenarioId": "su-S41-scheduler-finished",
      "verdict": "pass",
      "runs": [
        {
          "status": "passed",
          "costUsd": 0.008877,
          "turns": 2,
          "assertErrors": [],
          "judgeErrors": [],
          "llmCallDiagnostics": {
            "events": [
              {
                "callId": "56eabd1f-4fa3-4e31-b727-b94ae856f7d2",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "request",
                "observedAt": "2026-10-17T14:53:25.944Z",
                "servedAccount": null,
                "providerRequestId": null,
                "status": null
              },
              {
                "callId": "56eabd1f-4fa3-4e31-b727-b94ae856f7d2",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "response",
                "observedAt": "2026-10-17T14:53:27.139Z",
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg7zxL1n7suYQJtVWcq6X",
                "status": 200
              },
              {
                "callId": "56eabd1f-4fa3-4e31-b727-b94ae856f7d2",
                "attempt": 1,
                "phase": "stream-progress",
                "observedAt": "2026-10-17T14:53:27.142Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg7zxL1n7suYQJtVWcq6X",
                "status": 200,
                "streamEventCount": 1,
                "textChars": 0,
                "firstStreamEventAt": "2026-10-17T14:53:27.142Z",
                "lastStreamEventAt": "2026-10-17T14:53:27.142Z",
                "callerAborted": null,
                "callerAbortReason": null
              },
              {
                "callId": "56eabd1f-4fa3-4e31-b727-b94ae856f7d2",
                "attempt": 1,
                "phase": "stream-complete",
                "observedAt": "2026-10-17T14:53:30.270Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg7zxL1n7suYQJtVWcq6X",
                "status": 200,
                "streamEventCount": 71,
                "textChars": 691,
                "firstStreamEventAt": "2026-10-17T14:53:27.142Z",
                "lastStreamEventAt": "2026-10-17T14:53:30.264Z",
                "callerAborted": null,
                "callerAbortReason": null
              }
            ],
            "total": 4,
            "omitted": 0
          }
        },
        {
          "status": "passed",
          "costUsd": 0.008766,
          "turns": 2,
          "assertErrors": [],
          "judgeErrors": [],
          "llmCallDiagnostics": {
            "events": [
              {
                "callId": "830d4064-14fd-41b8-9f89-d1263a9ab0d6",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "request",
                "observedAt": "2026-10-17T14:54:12.825Z",
                "servedAccount": null,
                "providerRequestId": null,
                "status": null
              },
              {
                "callId": "830d4064-14fd-41b8-9f89-d1263a9ab0d6",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "response",
                "observedAt": "2026-10-17T14:54:13.742Z",
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg811mw6FEAbu4EUmWP2w",
                "status": 200
              },
              {
                "callId": "830d4064-14fd-41b8-9f89-d1263a9ab0d6",
                "attempt": 1,
                "phase": "stream-progress",
                "observedAt": "2026-10-17T14:54:13.743Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg811mw6FEAbu4EUmWP2w",
                "status": 200,
                "streamEventCount": 1,
                "textChars": 0,
                "firstStreamEventAt": "2026-10-17T14:54:13.743Z",
                "lastStreamEventAt": "2026-10-17T14:54:13.743Z",
                "callerAborted": null,
                "callerAbortReason": null
              },
              {
                "callId": "830d4064-14fd-41b8-9f89-d1263a9ab0d6",
                "attempt": 1,
                "phase": "stream-complete",
                "observedAt": "2026-10-17T14:54:17.198Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg811mw6FEAbu4EUmWP2w",
                "status": 200,
                "streamEventCount": 78,
                "textChars": 706,
                "firstStreamEventAt": "2026-10-17T14:54:13.743Z",
                "lastStreamEventAt": "2026-10-17T14:54:17.192Z",
                "callerAborted": null,
                "callerAbortReason": null
              }
            ],
            "total": 4,
            "omitted": 0
          }
        },
        {
          "status": "passed",
          "costUsd": 0.008898,
          "turns": 2,
          "assertErrors": [],
          "judgeErrors": [],
          "llmCallDiagnostics": {
            "events": [
              {
                "callId": "69d3febc-ea74-4d64-92ed-c0a7f5a23337",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "request",
                "observedAt": "2026-10-17T14:54:44.474Z",
                "servedAccount": null,
                "providerRequestId": null,
                "status": null
              },
              {
                "callId": "69d3febc-ea74-4d64-92ed-c0a7f5a23337",
                "attempt": 1,
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "governorMode": "disabled",
                "loopback": true,
                "requestedAccount": null,
                "phase": "response",
                "observedAt": "2026-10-17T14:54:45.536Z",
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg8147VsoJZQZjEAa43uc",
                "status": 200
              },
              {
                "callId": "69d3febc-ea74-4d64-92ed-c0a7f5a23337",
                "attempt": 1,
                "phase": "stream-progress",
                "observedAt": "2026-10-17T14:54:45.537Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg8147VsoJZQZjEAa43uc",
                "status": 200,
                "streamEventCount": 1,
                "textChars": 0,
                "firstStreamEventAt": "2026-10-17T14:54:45.537Z",
                "lastStreamEventAt": "2026-10-17T14:54:45.537Z",
                "callerAborted": null,
                "callerAbortReason": null
              },
              {
                "callId": "69d3febc-ea74-4d64-92ed-c0a7f5a23337",
                "attempt": 1,
                "phase": "stream-complete",
                "observedAt": "2026-10-17T14:54:49.324Z",
                "label": "anthropic-direct",
                "endpointOrigin": "http://127.0.0.1:8788",
                "loopback": true,
                "governorMode": "disabled",
                "requestedAccount": null,
                "servedAccount": "aviynw3_claude",
                "providerRequestId": "req_011Cg8147VsoJZQZjEAa43uc",
                "status": 200,
                "streamEventCount": 85,
                "textChars": 761,
                "firstStreamEventAt": "2026-10-17T14:54:45.537Z",
                "lastStreamEventAt": "2026-10-17T14:54:49.316Z",
                "callerAborted": null,
                "callerAbortReason": null
              }
            ],
            "total": 4,
            "omitted": 0
          }
        }
      ]
    }
  },
  "next": "Extract original12 llm_test_runs by the four exact runGroupIds in llmLedgers. The new independent failure omits bounded events:await (assert bounded-dependency-wake-missing) in repeats0and2. Diagnose from actual transcript; no retry for recall and no rejudge/backfill. Other3 pass3each and can bind with actual fixturePaths, completedRuntime llm-in-process, exact testCases=scenarioId, scenarioIds required short IDs, pathReachable and implementation-independent oracle rationale. Remaining unit/mutation pairs can reuse new baseline21336103 with identical first recipe: sourcePaths(S41 source, fleet-scope source, invoke-args, _asserts), fixturePaths(S41 source + test). Choose exact mutant failedcase from mutationLedgers for each same-clause passing test. Independent54178+54179 accepted, currentness/adequacy not yet checked; original54163 retained as different subject. Full artifact preserves original proof and unchanged measurement recipes. No terminal close until adequate; do not alias evidence refs.",
  "nativeHandles": "All8 command envelopes drained terminal: all4mutationexit0; llmblocked/noevent/finishedexit0 independentexit1. No locks/source edits. Loop intentionally inactive."
}
