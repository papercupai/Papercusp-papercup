---
rel_path: "audits/parked-agent-resumption-2026-10-09/r22-both-clauses-certified-20261025-424d5.json"
updated_at: 1792953334486
_body: "content"
---

{
  "observedAt": "2026-10-25T18:35:34.446Z",
  "scope": "Both R22 mapped clauses mechanical adequacy; no whole-plan/runtime/final24h acceptance",
  "priorArchive": "audits/parked-agent-resumption-2026-10-09/r22-clean-mechanical-proof-22046685-424d5.json",
  "certification": {
    "ok": true,
    "dryRun": false,
    "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
    "evaluatorBuild": {
      "sha": "4079399712",
      "version": "0.0.0"
    },
    "classRef": "plan-class-bugfix",
    "governing": true,
    "counts": {
      "clauses": 2,
      "passing": 2,
      "filed": 0,
      "unchanged": 0,
      "refused": 0,
      "notPassing": 0,
      "mechanicallyVerified": 2
    },
    "clauses": [
      {
        "specId": "AUTO-BAR-R-22-P-007",
        "specRevision": 2,
        "verdict": "pass",
        "wouldBlock": [],
        "measurementEvidence": {
          "status": "measured",
          "selectedBindings": 2,
          "measuredBindings": 2,
          "unavailableBindings": [],
          "withoutMeasurementBasis": [],
          "bindings": [
            {
              "bindingId": 70348,
              "evidenceKind": "test",
              "evidenceRef": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
              "status": "measured",
              "measuredAtCommit": "7e94aaa9290ec7205c57bd981af0a7863c4bf4b7",
              "measurementFingerprint": "sha256:2dad283527d048f7ce4c56e15564947fa621891c819de2f156b4ab766c5016bb"
            },
            {
              "bindingId": 70349,
              "evidenceKind": "mutation",
              "evidenceRef": "test-run 22047728 mutation-probe mutant fail packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts @0f9e16607008",
              "status": "measured",
              "measuredAtCommit": "7e94aaa9290ec7205c57bd981af0a7863c4bf4b7",
              "measurementFingerprint": "sha256:2dad283527d048f7ce4c56e15564947fa621891c819de2f156b4ab766c5016bb"
            }
          ]
        },
        "mechanicalProof": {
          "applicable": true,
          "verdict": "pass",
          "requiredFiles": [
            "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
          ],
          "passingTestBindingIds": {
            "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts": 70348
          },
          "caughtMutantBindingIds": [
            70349
          ],
          "gaps": []
        },
        "card": {
          "status": "not-required",
          "reason": "mechanical-test-adequacy"
        }
      },
      {
        "specId": "AUTO-BAR-R-22-P-013",
        "specRevision": 2,
        "verdict": "pass",
        "wouldBlock": [],
        "measurementEvidence": {
          "status": "measured",
          "selectedBindings": 3,
          "measuredBindings": 3,
          "unavailableBindings": [],
          "withoutMeasurementBasis": [],
          "bindings": [
            {
              "bindingId": 70316,
              "evidenceKind": "test",
              "evidenceRef": "test-run-group:e1a217db-1e0d-42cb-8637-6a3513d34bba:0",
              "status": "measured",
              "measuredAtCommit": "7e94aaa9290ec7205c57bd981af0a7863c4bf4b7",
              "measurementFingerprint": "sha256:aa7ffec5d7c762a86f0eed3a6a9d6a4889d934f2d49b1ad1b0a6ca62318f64e5"
            },
            {
              "bindingId": 70317,
              "evidenceKind": "test",
              "evidenceRef": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
              "status": "measured",
              "measuredAtCommit": "7e94aaa9290ec7205c57bd981af0a7863c4bf4b7",
              "measurementFingerprint": "sha256:2dad283527d048f7ce4c56e15564947fa621891c819de2f156b4ab766c5016bb"
            },
            {
              "bindingId": 70318,
              "evidenceKind": "mutation",
              "evidenceRef": "test-run 22047728 mutation-probe mutant fail packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts @0f9e16607008",
              "status": "measured",
              "measuredAtCommit": "7e94aaa9290ec7205c57bd981af0a7863c4bf4b7",
              "measurementFingerprint": "sha256:2dad283527d048f7ce4c56e15564947fa621891c819de2f156b4ab766c5016bb"
            }
          ]
        },
        "mechanicalProof": {
          "applicable": true,
          "verdict": "pass",
          "requiredFiles": [
            "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
          ],
          "passingTestBindingIds": {
            "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts": 70317
          },
          "caughtMutantBindingIds": [
            70318
          ],
          "gaps": []
        },
        "card": {
          "status": "not-required",
          "reason": "mechanical-test-adequacy"
        }
      }
    ],
    "completionReadiness": {
      "status": "not-checked",
      "note": "Certification can combine evidence from multiple work items. It does not establish that any work item can close. Supply completionWorkItemId to check the existing scoped completion gate."
    },
    "_meta": {
      "explicitFullRequest": true,
      "format": "json",
      "_seeAlso": [
        {
          "tool": "plans:evaluate-spec-test-adequacy"
        },
        {
          "tool": "scorecards:emit"
        }
      ]
    }
  },
  "specs": {
    "ok": true,
    "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
    "harnessSlug": "papercusp",
    "specs": [
      {
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-22-P-007",
        "sourceValId": null,
        "currentRevision": 2,
        "revision": 1,
        "planItemId": "P-007",
        "behavior": "An otherwise eligible parked autonomous session receives a silent-halt verdict exactly when it holds actionable work without an eligible live wake source.",
        "behaviorClass": "happy-path",
        "requiredEvidence": [
          "tree"
        ],
        "requiredTestLayers": [
          "unit"
        ],
        "mutationRequired": false,
        "lifecycleStatus": "draft",
        "supersedes": null,
        "exemption": null,
        "falsifier": {
          "observation": "An own-inbox or dead-target watch hides actionable held work, a live untimed event watch is rejected, or blocker-only held work is counted as actionable."
        },
        "contentHash": "5f13e94e5708893804b3703e2153ee9479646c73a6f9c513e1101b36a26ee1c6",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-17T22:54:22.228Z",
        "acceptedBy": null,
        "acceptedAt": null,
        "acceptanceRef": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09@9:R-22",
        "sourceBar": {
          "barKey": "R-22",
          "barHash": "f7385c11ad68e316310c4e430afb66acbdd760a9a3eb1589a01cb76d7a662927",
          "barSetHash": "fa0600d29e77c05a36329aa052fe5f1d4cc5f5ba6430ef011f56dcaa3e1bc329",
          "rubricSlug": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09",
          "rubricRevision": 9,
          "evidencePlane": "tree"
        }
      },
      {
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-22-P-007",
        "sourceValId": null,
        "currentRevision": 2,
        "revision": 2,
        "planItemId": "P-007",
        "behavior": "An otherwise eligible parked autonomous session receives a silent-halt verdict exactly when it holds actionable work without an eligible live wake source.",
        "behaviorClass": "happy-path",
        "requiredEvidence": [
          "tree"
        ],
        "requiredTestLayers": [
          "unit"
        ],
        "mutationRequired": false,
        "lifecycleStatus": "active",
        "supersedes": null,
        "exemption": null,
        "falsifier": {
          "observation": "An own-inbox or dead-target watch hides actionable held work, a live untimed event watch is rejected, or blocker-only held work is counted as actionable."
        },
        "contentHash": "588a9581e9098e2a932fddd03cbef0b04356660ffe006ca206f2eec7b427ef06",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T18:35:09.235Z",
        "acceptedBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "acceptedAt": "2026-10-25T18:35:09.243Z",
        "acceptanceRef": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09@9:R-22",
        "sourceBar": {
          "barKey": "R-22",
          "barHash": "f7385c11ad68e316310c4e430afb66acbdd760a9a3eb1589a01cb76d7a662927",
          "barSetHash": "fa0600d29e77c05a36329aa052fe5f1d4cc5f5ba6430ef011f56dcaa3e1bc329",
          "rubricSlug": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09",
          "rubricRevision": 9,
          "evidencePlane": "tree"
        }
      },
      {
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-22-P-013",
        "sourceValId": null,
        "currentRevision": 2,
        "revision": 1,
        "planItemId": "P-013",
        "behavior": "An otherwise eligible parked autonomous session receives a silent-halt verdict exactly when it holds actionable work without an eligible live wake source.",
        "behaviorClass": "happy-path",
        "requiredEvidence": [
          "tree"
        ],
        "requiredTestLayers": [
          "unit"
        ],
        "mutationRequired": false,
        "lifecycleStatus": "draft",
        "supersedes": null,
        "exemption": null,
        "falsifier": {
          "observation": "An own-inbox or dead-target watch hides actionable held work, a live untimed event watch is rejected, or blocker-only held work is counted as actionable."
        },
        "contentHash": "7543110f96de2cf4d8eaa495f9edad57d89182ff3e097bd906c5bdc96adc02ff",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-17T22:54:22.228Z",
        "acceptedBy": null,
        "acceptedAt": null,
        "acceptanceRef": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09@9:R-22",
        "sourceBar": {
          "barKey": "R-22",
          "barHash": "f7385c11ad68e316310c4e430afb66acbdd760a9a3eb1589a01cb76d7a662927",
          "barSetHash": "fa0600d29e77c05a36329aa052fe5f1d4cc5f5ba6430ef011f56dcaa3e1bc329",
          "rubricSlug": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09",
          "rubricRevision": 9,
          "evidencePlane": "tree"
        }
      },
      {
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-22-P-013",
        "sourceValId": null,
        "currentRevision": 2,
        "revision": 2,
        "planItemId": "P-013",
        "behavior": "An otherwise eligible parked autonomous session receives a silent-halt verdict exactly when it holds actionable work without an eligible live wake source.",
        "behaviorClass": "happy-path",
        "requiredEvidence": [
          "tree"
        ],
        "requiredTestLayers": [
          "unit"
        ],
        "mutationRequired": false,
        "lifecycleStatus": "active",
        "supersedes": null,
        "exemption": null,
        "falsifier": {
          "observation": "An own-inbox or dead-target watch hides actionable held work, a live untimed event watch is rejected, or blocker-only held work is counted as actionable."
        },
        "contentHash": "3f64679e80c4de9e832ae2d1741fa6f53fa75afda7237463996589e63bb36e79",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T18:03:01.347Z",
        "acceptedBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "acceptedAt": "2026-10-25T18:03:01.361Z",
        "acceptanceRef": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09@9:R-22",
        "sourceBar": {
          "barKey": "R-22",
          "barHash": "f7385c11ad68e316310c4e430afb66acbdd760a9a3eb1589a01cb76d7a662927",
          "barSetHash": "fa0600d29e77c05a36329aa052fe5f1d4cc5f5ba6430ef011f56dcaa3e1bc329",
          "rubricSlug": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09",
          "rubricRevision": 9,
          "evidencePlane": "tree"
        }
      }
    ],
    "count": 4,
    "mode": "history",
    "_meta": {
      "explicitFullRequest": true,
      "format": "json",
      "_seeAlso": [
        {
          "tool": "plans:set-specs (append a revision)"
        },
        {
          "tool": "plans:get-item (read the owning outcome)"
        }
      ]
    }
  },
  "evidence": {
    "ok": true,
    "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
    "harnessSlug": "papercusp",
    "bounded": {
      "limit": 20,
      "truncatedByLimit": false
    },
    "detail": "full",
    "evidence": [
      {
        "id": 70349,
        "workItemId": "WI-10008158",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-22-P-007",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "588a9581e9098e2a932fddd03cbef0b04356660ffe006ca206f2eec7b427ef06",
        "evidenceKind": "mutation",
        "evidenceRef": "test-run 22047728 mutation-probe mutant fail packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts @0f9e16607008",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:c62dd1bd8b2cb119ea76b1da08ff4aae2e40c6f1f4f216b7f42d37679c2a34d3",
          "testFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
          "fixtureFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22047728,
        "testRunExecution": {
          "status": "fail",
          "passed": 58,
          "failed": 7,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "passedCaseTitles": [],
          "testLayer": "unit",
          "passedCaseTitleCount": 58,
          "passedCaseTitlesOmitted": 58,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22047728
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "mutant",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n+++ b/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n@@ -324,7 +324,7 @@\n   // blocker with none is revisited by nothing, so that hold falls through to the clocks as a\n   // WAKE-ONLY halt: one wake asking the holder to name the wake, never a page.\n   const unboundedParkedIds = input.unboundedBlockerParkedWorkItemIds ?? [];\n-  if (input.heldWorkItems <= 0 && unboundedParkedIds.length === 0) {\n+  if (input.heldWorkItems <= 0) {\n     const blockerParkedIds = input.blockerParkedWorkItemIds ?? [];\n     if (blockerParkedIds.length > 0) {\n       return no(\n",
            "subjectPath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
            "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
            "mutateExpression": "s/input\\.heldWorkItems <= 0 && unboundedParkedIds\\.length === 0/input.heldWorkItems <= 0/",
            "probeInvocationId": "9b40e29e-458e-4331-96b9-340004df7fff",
            "testCommandSha256": "39bf5a4004de1df81c250b8a7feb486cec3a13475cb35fd6400cfc6b08b47f0a",
            "subjectAfterSha256": "e6dc7375cf4471e3efe2ca26bc64873342527a5e818d17b7377d12265e6f7baa",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0"
          },
          "mutationBaseline": {
            "testRunId": 22047224,
            "status": "pass",
            "mutation": {
              "leg": "copy-baseline",
              "mode": "copy-out",
              "mutantDiff": "--- a/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n+++ b/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n@@ -324,7 +324,7 @@\n   // blocker with none is revisited by nothing, so that hold falls through to the clocks as a\n   // WAKE-ONLY halt: one wake asking the holder to name the wake, never a page.\n   const unboundedParkedIds = input.unboundedBlockerParkedWorkItemIds ?? [];\n-  if (input.heldWorkItems <= 0 && unboundedParkedIds.length === 0) {\n+  if (input.heldWorkItems <= 0) {\n     const blockerParkedIds = input.blockerParkedWorkItemIds ?? [];\n     if (blockerParkedIds.length > 0) {\n       return no(\n",
              "subjectPath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
              "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
              "againstCommit": null,
              "schemaVersion": 1,
              "testFileSha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
              "mutateExpression": "s/input\\.heldWorkItems <= 0 && unboundedParkedIds\\.length === 0/input.heldWorkItems <= 0/",
              "probeInvocationId": "9b40e29e-458e-4331-96b9-340004df7fff",
              "testCommandSha256": "39bf5a4004de1df81c250b8a7feb486cec3a13475cb35fd6400cfc6b08b47f0a",
              "subjectAfterSha256": "e6dc7375cf4471e3efe2ca26bc64873342527a5e818d17b7377d12265e6f7baa",
              "mutantDiffTruncated": false,
              "subjectBeforeSha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0"
            },
            "passed": 65,
            "failed": 0,
            "skipped": 0,
            "collectionFailed": false,
            "passedCaseTitles": [
              "evaluateSilentHalt > flags the real thing: alive process, autonomy posture, loop off, no await, no recent turn",
              "evaluateSilentHalt > INCIDENT ANCHOR (2026-09-01) — a session with NO presence row is GONE, not halted",
              "evaluateSilentHalt > BOUNDARY (unguarded-halt-rescue) — a load-0 halt is NOT ours; that module wakes it",
              "evaluateSilentHalt > held work is what JUSTIFIES the page — the strand is real either way",
              "evaluateSilentHalt > active typed external-blocker holds alone do not justify a silent-halt page (D-010/P-010)",
              "evaluateSilentHalt > a blocker park with NO re-check time names no wake: a WAKE-ONLY halt (WI-6554700010018551)",
              "evaluateSilentHalt > a wake-only park still respects every earlier exemption and both clocks",
              "evaluateSilentHalt > actionable held work keeps the PAGEABLE verdict even beside an unbounded park",
              "evaluateSilentHalt > still pages on actionable held work and names coexisting blocker-parked IDs",
              "evaluateSilentHalt > a stale heartbeat means the process is gone, not halted",
              "evaluateSilentHalt > a pending await IS a wake source — the 67 -> 3 collapse",
              "evaluateSilentHalt > an ARMED loop belongs to stalled-loops-guard, never this module",
              "evaluateSilentHalt > a session with no autonomy posture has a human in front of it",
              "evaluateSilentHalt > does not page a loop disarmed seconds ago — most disarms self-heal",
              "evaluateSilentHalt > does not page an agent that produced a turn inside the floor",
              "evaluateSilentHalt > fails quiet when nothing establishes DURATION (no turn ever, no disarm timestamp)",
              "evaluateSilentHalt > still flags a halt when the agent never produced a turn but the disarm clock is old",
              "evaluateSilentHalt > scales the staleness floor with the loop interval, never below the 30m floor",
              "silent-halt wake guidance > checks checkpoint gates before resuming or releasing held work",
              "sweepSilentHalts > pages the OWNER once for a halted session, with a dedupeKey",
              "sweepSilentHalts > keys the dedupeKey to the DISARM EPOCH, so a still-halted session never re-pages",
              "sweepSilentHalts > a re-armed loop between the two round-trips is NOT paged",
              "sweepSilentHalts > names an exemption for every spared candidate — a mute sweep is unexplainable",
              "sweepSilentHalts > dry_run detects without paging",
              "sweepSilentHalts > caps pages on a mass halt — a cluster is ONE incident, not N",
              "sweepSilentHalts > a downed push transport does not throw away the remaining pages, and says so",
              "sweepSilentHalts > an empty candidate set does no status read and pages nobody",
              "sweepSilentHalts > survives a failed loop-status read by sweeping without turn evidence",
              "sweepSilentHalts — wake-first rung (P-003) > first tick: WAKES the halted holder instead of paging — marker written before the wake fires",
              "sweepSilentHalts — wake-first rung (P-003) > second tick: a marker for the SAME disarm epoch pages with the wake evidence",
              "sweepSilentHalts — wake-first rung (P-003) > a marker from an OLDER disarm epoch does not spend the new epoch's wake",
              "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > wakes the holder with name-your-wake guidance and raises no owner-facing condition",
              "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > a spent wake for this epoch is never followed by a page",
              "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > with the wake rung off, or a host that needs a relaunch, it still never pages",
              "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > actionable strands are woken first under the cap, and only they reach the owner condition",
              "sweepSilentHalts — wake-first rung (P-003) > wake produced a turn but the session re-halted in the SAME epoch: the page says so",
              "sweepSilentHalts — wake-first rung (P-003) > caps the wake fan and DEFERS the overflow — it never falls through to the page",
              "sweepSilentHalts — wake-first rung (P-003) > marker-READ failure falls back to page-only (never a re-wake storm), and says so",
              "sweepSilentHalts — wake-first rung (P-003) > marker-WRITE failure skips the wake AND the page — the next tick retries the wake",
              "sweepSilentHalts — wake-first rung (P-003) > flag OFF: pages immediately with no wake attempt — the pre-P-003 behavior, exactly",
              "sweepSilentHalts — wake-first rung (P-003) > a parked fleet's member is woken WITH its way back — the park contract, verbatim",
              "sweepSilentHalts — wake-first rung (P-003) > FRAMING, not gating (D-005): a holder the classifier calls 'deliberate' is still WOKEN, and its page names that verdict",
              "sweepSilentHalts — P-007 slice 2 (D-006) > the candidate read does NOT count the session's own inbox-wake watcher as a wake source",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a dead work-item await does not exempt the session either (D-008 (1), via the shared predicate)",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a live untimed await still exempts the session (D-009: the detector stays lenient)",
              "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'blocked' work with a 'active' blocker",
              "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'needs-human' work with a 'active' blocker",
              "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'needs-human' work with a 'cleared' blocker",
              "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'wip' work with a 'active' blocker",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'no recheckAt (a pre-default legacy ro…' names no wake: halted as WAKE-ONLY, not exempt",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'an unparseable recheckAt' names no wake: halted as WAKE-ONLY, not exempt",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a host that needs a relaunch is NOT woken; it is paged at once with the HOST UNHEALTHY remedy",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a healthy, recoverable, or unreadable host keeps the wake-first rung exactly as before",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a host read that THROWS degrades to the wake-first rung, never to silence",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a DEDUPED page does not consume the per-sweep cap, so standing halts cannot starve a new one",
              "sweepSilentHalts — P-007 slice 2 (D-006) > the cap still bounds NEWLY created pages",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a fleet member's NEW page also alerts its fleet leader, once; a deduped page does not",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a non-fleet session is paged without any fleet-leader alert",
              "sweepSilentHalts — default notification adapter > alerts once for the same owner and epoch, then alerts again for a new epoch",
              "sweepSilentHalts — default notification adapter > does not re-alert for an existing intent even when an unfinished channel is delivered",
              "sweepSilentHalts — default notification adapter > does not let existing intents with channel attempts starve a new halt out of the page cap",
              "sweepSilentHalts — default notification adapter > preserves fail-soft delivery and leader alerting when intent storage is unavailable",
              "countPendingWakeSources — the seam to wake-source-predicate > counts none of the four dead shapes, so a stranded session reads as having no wake source",
              "countPendingWakeSources — the seam to wake-source-predicate > still counts an UNTIMED live watch (D-009: this detector stays lenient) and a bounded inbox await",
              "countPendingWakeSources — the seam to wake-source-predicate > does not query work_items when no candidate has an open await"
            ]
          },
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": false,
          "mutationFailureLines": [
            "evaluateSilentHalt > a blocker park with NO re-check time names no wake: a WAKE-ONLY halt (WI-6554700010018551): (recorded failed assertion)",
            "evaluateSilentHalt > a wake-only park still respects every earlier exemption and both clocks: (recorded failed assertion)",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > wakes the holder with name-your-wake guidance and raises no owner-facing condition: (recorded failed assertion)",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > a spent wake for this epoch is never followed by a page: (recorded failed assertion)",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > actionable strands are woken first under the cap, and only they reach the owner condition: (recorded failed assertion)",
            "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'no recheckAt (a pre-default legacy ro…' names no wake: halted as WAKE-ONLY, not exempt: (recorded failed assertion)",
            "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'an unparseable recheckAt' names no wake: halted as WAKE-ONLY, not exempt: (recorded failed assertion)"
          ],
          "mutationFailedCaseTitles": [
            "evaluateSilentHalt > a blocker park with NO re-check time names no wake: a WAKE-ONLY halt (WI-6554700010018551)",
            "evaluateSilentHalt > a wake-only park still respects every earlier exemption and both clocks",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > wakes the holder with name-your-wake guidance and raises no owner-facing condition",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > a spent wake for this epoch is never followed by a page",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > actionable strands are woken first under the cap, and only they reach the owner condition",
            "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'no recheckAt (a pre-default legacy ro…' names no wake: halted as WAKE-ONLY, not exempt",
            "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'an unparseable recheckAt' names no wake: halted as WAKE-ONLY, not exempt"
          ]
        },
        "details": {
          "testRun": {
            "id": 22047728,
            "source": "mutation-probe",
            "status": "fail",
            "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T17:57:24.134Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-Tyr0BJ",
            "mutationPhase": "mutant",
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "AUTO-BAR-R-22-P-007",
            "collected": true,
            "testLayer": "unit"
          },
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/events/await/wake-source-predicate.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9370a6b976d3a450d6ff8f5918749760ceee2c58682c3b41acee4f5c4192cf69",
                "headBlob": "895ef0ad6996c321233876a1ca9add8a0cfa63de",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/external-blockers.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2a2d4a20a5b06ca92ae33d36b0e42d5e86ed1a4dd661ac90d8e01966a8044261",
                "headBlob": "6d04bed99388a6ce3d90c9ad0594c464abdfcdcd",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
                "repo": ".",
                "clean": true,
                "sha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0",
                "headBlob": "a6c83dbd2a67656328922c1507dc7dfa74096c61",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f",
                "headBlob": "aedb066044139ed16fe6f66a4a43ff26b636085c",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
                "headBlob": "7ce4a2fa2b8bbbf4a20ab9bf989a2f8a8c42f18d",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
                "headBlob": "7ce4a2fa2b8bbbf4a20ab9bf989a2f8a8c42f18d",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "7e94aaa9290ec7205c57bd981af0a7863c4bf4b7",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ],
            "sourcePaths": [
              "packages/operator-core/lib/events/await/wake-source-predicate.ts",
              "packages/operator-core/lib/external-blockers.ts",
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
              "packages/operator-core/lib/scheduler/claim-spec-store.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-25T18:34:49.022Z",
        "bindingFingerprint": "acac2595b22eee7611e180e10d965e5f8979870ab03bd4d05f79f6d3011f11a7",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T18:35:09.235Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "7e94aaa9290ec7205c57bd981af0a7863c4bf4b7",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-22-P-007",
            "specRevision": 2,
            "specFingerprint": "588a9581e9098e2a932fddd03cbef0b04356660ffe006ca206f2eec7b427ef06",
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 22047728 mutation-probe mutant fail packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts @0f9e16607008",
            "sourceFingerprint": "sha256-file-set-v1:c62dd1bd8b2cb119ea76b1da08ff4aae2e40c6f1f4f216b7f42d37679c2a34d3",
            "testFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
            "fixtureFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1"
          }
        },
        "currentness": {
          "overall": "current",
          "dimensions": {
            "spec": "current",
            "source": "current",
            "test": "current",
            "fixture": "current",
            "rubric": "not-applicable",
            "environment": "not-applicable",
            "coverageEvidence": "not-applicable",
            "testRun": "current"
          },
          "staleReasons": [],
          "unknownReasons": [],
          "comparisonSupplied": true,
          "provenance": "server-measured"
        }
      },
      {
        "id": 70345,
        "workItemId": "WI-10008158",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-22-P-007",
        "sourceValId": null,
        "specRevision": 1,
        "currentRevision": 2,
        "specFingerprint": "5f13e94e5708893804b3703e2153ee9479646c73a6f9c513e1101b36a26ee1c6",
        "evidenceKind": "mutation",
        "evidenceRef": "test-run 22047728 mutation-probe mutant fail packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts @0f9e16607008",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:c62dd1bd8b2cb119ea76b1da08ff4aae2e40c6f1f4f216b7f42d37679c2a34d3",
          "testFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
          "fixtureFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22047728,
        "testRunExecution": {
          "status": "fail",
          "passed": 58,
          "failed": 7,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "passedCaseTitles": [],
          "testLayer": "unit",
          "passedCaseTitleCount": 58,
          "passedCaseTitlesOmitted": 58,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22047728
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "mutant",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n+++ b/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n@@ -324,7 +324,7 @@\n   // blocker with none is revisited by nothing, so that hold falls through to the clocks as a\n   // WAKE-ONLY halt: one wake asking the holder to name the wake, never a page.\n   const unboundedParkedIds = input.unboundedBlockerParkedWorkItemIds ?? [];\n-  if (input.heldWorkItems <= 0 && unboundedParkedIds.length === 0) {\n+  if (input.heldWorkItems <= 0) {\n     const blockerParkedIds = input.blockerParkedWorkItemIds ?? [];\n     if (blockerParkedIds.length > 0) {\n       return no(\n",
            "subjectPath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
            "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
            "mutateExpression": "s/input\\.heldWorkItems <= 0 && unboundedParkedIds\\.length === 0/input.heldWorkItems <= 0/",
            "probeInvocationId": "9b40e29e-458e-4331-96b9-340004df7fff",
            "testCommandSha256": "39bf5a4004de1df81c250b8a7feb486cec3a13475cb35fd6400cfc6b08b47f0a",
            "subjectAfterSha256": "e6dc7375cf4471e3efe2ca26bc64873342527a5e818d17b7377d12265e6f7baa",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0"
          },
          "mutationBaseline": {
            "testRunId": 22047224,
            "status": "pass",
            "mutation": {
              "leg": "copy-baseline",
              "mode": "copy-out",
              "mutantDiff": "--- a/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n+++ b/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n@@ -324,7 +324,7 @@\n   // blocker with none is revisited by nothing, so that hold falls through to the clocks as a\n   // WAKE-ONLY halt: one wake asking the holder to name the wake, never a page.\n   const unboundedParkedIds = input.unboundedBlockerParkedWorkItemIds ?? [];\n-  if (input.heldWorkItems <= 0 && unboundedParkedIds.length === 0) {\n+  if (input.heldWorkItems <= 0) {\n     const blockerParkedIds = input.blockerParkedWorkItemIds ?? [];\n     if (blockerParkedIds.length > 0) {\n       return no(\n",
              "subjectPath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
              "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
              "againstCommit": null,
              "schemaVersion": 1,
              "testFileSha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
              "mutateExpression": "s/input\\.heldWorkItems <= 0 && unboundedParkedIds\\.length === 0/input.heldWorkItems <= 0/",
              "probeInvocationId": "9b40e29e-458e-4331-96b9-340004df7fff",
              "testCommandSha256": "39bf5a4004de1df81c250b8a7feb486cec3a13475cb35fd6400cfc6b08b47f0a",
              "subjectAfterSha256": "e6dc7375cf4471e3efe2ca26bc64873342527a5e818d17b7377d12265e6f7baa",
              "mutantDiffTruncated": false,
              "subjectBeforeSha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0"
            },
            "passed": 65,
            "failed": 0,
            "skipped": 0,
            "collectionFailed": false,
            "passedCaseTitles": [
              "evaluateSilentHalt > flags the real thing: alive process, autonomy posture, loop off, no await, no recent turn",
              "evaluateSilentHalt > INCIDENT ANCHOR (2026-09-01) — a session with NO presence row is GONE, not halted",
              "evaluateSilentHalt > BOUNDARY (unguarded-halt-rescue) — a load-0 halt is NOT ours; that module wakes it",
              "evaluateSilentHalt > held work is what JUSTIFIES the page — the strand is real either way",
              "evaluateSilentHalt > active typed external-blocker holds alone do not justify a silent-halt page (D-010/P-010)",
              "evaluateSilentHalt > a blocker park with NO re-check time names no wake: a WAKE-ONLY halt (WI-6554700010018551)",
              "evaluateSilentHalt > a wake-only park still respects every earlier exemption and both clocks",
              "evaluateSilentHalt > actionable held work keeps the PAGEABLE verdict even beside an unbounded park",
              "evaluateSilentHalt > still pages on actionable held work and names coexisting blocker-parked IDs",
              "evaluateSilentHalt > a stale heartbeat means the process is gone, not halted",
              "evaluateSilentHalt > a pending await IS a wake source — the 67 -> 3 collapse",
              "evaluateSilentHalt > an ARMED loop belongs to stalled-loops-guard, never this module",
              "evaluateSilentHalt > a session with no autonomy posture has a human in front of it",
              "evaluateSilentHalt > does not page a loop disarmed seconds ago — most disarms self-heal",
              "evaluateSilentHalt > does not page an agent that produced a turn inside the floor",
              "evaluateSilentHalt > fails quiet when nothing establishes DURATION (no turn ever, no disarm timestamp)",
              "evaluateSilentHalt > still flags a halt when the agent never produced a turn but the disarm clock is old",
              "evaluateSilentHalt > scales the staleness floor with the loop interval, never below the 30m floor",
              "silent-halt wake guidance > checks checkpoint gates before resuming or releasing held work",
              "sweepSilentHalts > pages the OWNER once for a halted session, with a dedupeKey",
              "sweepSilentHalts > keys the dedupeKey to the DISARM EPOCH, so a still-halted session never re-pages",
              "sweepSilentHalts > a re-armed loop between the two round-trips is NOT paged",
              "sweepSilentHalts > names an exemption for every spared candidate — a mute sweep is unexplainable",
              "sweepSilentHalts > dry_run detects without paging",
              "sweepSilentHalts > caps pages on a mass halt — a cluster is ONE incident, not N",
              "sweepSilentHalts > a downed push transport does not throw away the remaining pages, and says so",
              "sweepSilentHalts > an empty candidate set does no status read and pages nobody",
              "sweepSilentHalts > survives a failed loop-status read by sweeping without turn evidence",
              "sweepSilentHalts — wake-first rung (P-003) > first tick: WAKES the halted holder instead of paging — marker written before the wake fires",
              "sweepSilentHalts — wake-first rung (P-003) > second tick: a marker for the SAME disarm epoch pages with the wake evidence",
              "sweepSilentHalts — wake-first rung (P-003) > a marker from an OLDER disarm epoch does not spend the new epoch's wake",
              "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > wakes the holder with name-your-wake guidance and raises no owner-facing condition",
              "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > a spent wake for this epoch is never followed by a page",
              "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > with the wake rung off, or a host that needs a relaunch, it still never pages",
              "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > actionable strands are woken first under the cap, and only they reach the owner condition",
              "sweepSilentHalts — wake-first rung (P-003) > wake produced a turn but the session re-halted in the SAME epoch: the page says so",
              "sweepSilentHalts — wake-first rung (P-003) > caps the wake fan and DEFERS the overflow — it never falls through to the page",
              "sweepSilentHalts — wake-first rung (P-003) > marker-READ failure falls back to page-only (never a re-wake storm), and says so",
              "sweepSilentHalts — wake-first rung (P-003) > marker-WRITE failure skips the wake AND the page — the next tick retries the wake",
              "sweepSilentHalts — wake-first rung (P-003) > flag OFF: pages immediately with no wake attempt — the pre-P-003 behavior, exactly",
              "sweepSilentHalts — wake-first rung (P-003) > a parked fleet's member is woken WITH its way back — the park contract, verbatim",
              "sweepSilentHalts — wake-first rung (P-003) > FRAMING, not gating (D-005): a holder the classifier calls 'deliberate' is still WOKEN, and its page names that verdict",
              "sweepSilentHalts — P-007 slice 2 (D-006) > the candidate read does NOT count the session's own inbox-wake watcher as a wake source",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a dead work-item await does not exempt the session either (D-008 (1), via the shared predicate)",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a live untimed await still exempts the session (D-009: the detector stays lenient)",
              "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'blocked' work with a 'active' blocker",
              "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'needs-human' work with a 'active' blocker",
              "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'needs-human' work with a 'cleared' blocker",
              "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'wip' work with a 'active' blocker",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'no recheckAt (a pre-default legacy ro…' names no wake: halted as WAKE-ONLY, not exempt",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'an unparseable recheckAt' names no wake: halted as WAKE-ONLY, not exempt",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a host that needs a relaunch is NOT woken; it is paged at once with the HOST UNHEALTHY remedy",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a healthy, recoverable, or unreadable host keeps the wake-first rung exactly as before",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a host read that THROWS degrades to the wake-first rung, never to silence",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a DEDUPED page does not consume the per-sweep cap, so standing halts cannot starve a new one",
              "sweepSilentHalts — P-007 slice 2 (D-006) > the cap still bounds NEWLY created pages",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a fleet member's NEW page also alerts its fleet leader, once; a deduped page does not",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a non-fleet session is paged without any fleet-leader alert",
              "sweepSilentHalts — default notification adapter > alerts once for the same owner and epoch, then alerts again for a new epoch",
              "sweepSilentHalts — default notification adapter > does not re-alert for an existing intent even when an unfinished channel is delivered",
              "sweepSilentHalts — default notification adapter > does not let existing intents with channel attempts starve a new halt out of the page cap",
              "sweepSilentHalts — default notification adapter > preserves fail-soft delivery and leader alerting when intent storage is unavailable",
              "countPendingWakeSources — the seam to wake-source-predicate > counts none of the four dead shapes, so a stranded session reads as having no wake source",
              "countPendingWakeSources — the seam to wake-source-predicate > still counts an UNTIMED live watch (D-009: this detector stays lenient) and a bounded inbox await",
              "countPendingWakeSources — the seam to wake-source-predicate > does not query work_items when no candidate has an open await"
            ]
          },
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": false,
          "mutationFailureLines": [
            "evaluateSilentHalt > a blocker park with NO re-check time names no wake: a WAKE-ONLY halt (WI-6554700010018551): (recorded failed assertion)",
            "evaluateSilentHalt > a wake-only park still respects every earlier exemption and both clocks: (recorded failed assertion)",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > wakes the holder with name-your-wake guidance and raises no owner-facing condition: (recorded failed assertion)",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > a spent wake for this epoch is never followed by a page: (recorded failed assertion)",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > actionable strands are woken first under the cap, and only they reach the owner condition: (recorded failed assertion)",
            "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'no recheckAt (a pre-default legacy ro…' names no wake: halted as WAKE-ONLY, not exempt: (recorded failed assertion)",
            "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'an unparseable recheckAt' names no wake: halted as WAKE-ONLY, not exempt: (recorded failed assertion)"
          ],
          "mutationFailedCaseTitles": [
            "evaluateSilentHalt > a blocker park with NO re-check time names no wake: a WAKE-ONLY halt (WI-6554700010018551)",
            "evaluateSilentHalt > a wake-only park still respects every earlier exemption and both clocks",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > wakes the holder with name-your-wake guidance and raises no owner-facing condition",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > a spent wake for this epoch is never followed by a page",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > actionable strands are woken first under the cap, and only they reach the owner condition",
            "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'no recheckAt (a pre-default legacy ro…' names no wake: halted as WAKE-ONLY, not exempt",
            "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'an unparseable recheckAt' names no wake: halted as WAKE-ONLY, not exempt"
          ]
        },
        "details": {
          "testRun": {
            "id": 22047728,
            "source": "mutation-probe",
            "status": "fail",
            "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T17:57:24.134Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-Tyr0BJ",
            "mutationPhase": "mutant",
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "AUTO-BAR-R-22-P-007",
            "collected": true,
            "testLayer": "unit"
          },
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/events/await/wake-source-predicate.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9370a6b976d3a450d6ff8f5918749760ceee2c58682c3b41acee4f5c4192cf69",
                "headBlob": "895ef0ad6996c321233876a1ca9add8a0cfa63de",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/external-blockers.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2a2d4a20a5b06ca92ae33d36b0e42d5e86ed1a4dd661ac90d8e01966a8044261",
                "headBlob": "6d04bed99388a6ce3d90c9ad0594c464abdfcdcd",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
                "repo": ".",
                "clean": true,
                "sha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0",
                "headBlob": "a6c83dbd2a67656328922c1507dc7dfa74096c61",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f",
                "headBlob": "aedb066044139ed16fe6f66a4a43ff26b636085c",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
                "headBlob": "7ce4a2fa2b8bbbf4a20ab9bf989a2f8a8c42f18d",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
                "headBlob": "7ce4a2fa2b8bbbf4a20ab9bf989a2f8a8c42f18d",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "7e94aaa9290ec7205c57bd981af0a7863c4bf4b7",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ],
            "sourcePaths": [
              "packages/operator-core/lib/events/await/wake-source-predicate.ts",
              "packages/operator-core/lib/external-blockers.ts",
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
              "packages/operator-core/lib/scheduler/claim-spec-store.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-25T18:34:49.022Z",
        "bindingFingerprint": "6f44290b33ef945a61b4a3350b2b13a324a40e834a06a85f87c3519c2f088380",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T18:34:48.982Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "7e94aaa9290ec7205c57bd981af0a7863c4bf4b7",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-22-P-007",
            "specRevision": 1,
            "specFingerprint": "5f13e94e5708893804b3703e2153ee9479646c73a6f9c513e1101b36a26ee1c6",
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 22047728 mutation-probe mutant fail packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts @0f9e16607008",
            "sourceFingerprint": "sha256-file-set-v1:c62dd1bd8b2cb119ea76b1da08ff4aae2e40c6f1f4f216b7f42d37679c2a34d3",
            "testFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
            "fixtureFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1"
          }
        },
        "currentness": {
          "overall": "stale",
          "dimensions": {
            "spec": "stale",
            "source": "current",
            "test": "current",
            "fixture": "current",
            "rubric": "not-applicable",
            "environment": "not-applicable",
            "coverageEvidence": "not-applicable",
            "testRun": "current"
          },
          "staleReasons": [
            "spec-stale"
          ],
          "unknownReasons": [],
          "comparisonSupplied": true,
          "provenance": "server-measured"
        }
      },
      {
        "id": 70348,
        "workItemId": "WI-10008158",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-22-P-007",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "588a9581e9098e2a932fddd03cbef0b04356660ffe006ca206f2eec7b427ef06",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:c62dd1bd8b2cb119ea76b1da08ff4aae2e40c6f1f4f216b7f42d37679c2a34d3",
          "testFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
          "fixtureFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22046685,
        "testRunExecution": {
          "status": "pass",
          "passed": 65,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "passedCaseTitles": [],
          "testLayer": "unit",
          "passedCaseTitleCount": 65,
          "passedCaseTitlesOmitted": 65,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22046685
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "framework": "vitest",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 22046685,
            "source": "local",
            "status": "pass",
            "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T17:52:59.942Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-Tyr0BJ",
            "mutationPhase": null,
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "collected": true,
            "testLayer": "unit"
          },
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/events/await/wake-source-predicate.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9370a6b976d3a450d6ff8f5918749760ceee2c58682c3b41acee4f5c4192cf69",
                "headBlob": "895ef0ad6996c321233876a1ca9add8a0cfa63de",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/external-blockers.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2a2d4a20a5b06ca92ae33d36b0e42d5e86ed1a4dd661ac90d8e01966a8044261",
                "headBlob": "6d04bed99388a6ce3d90c9ad0594c464abdfcdcd",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
                "repo": ".",
                "clean": true,
                "sha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0",
                "headBlob": "a6c83dbd2a67656328922c1507dc7dfa74096c61",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f",
                "headBlob": "aedb066044139ed16fe6f66a4a43ff26b636085c",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
                "headBlob": "7ce4a2fa2b8bbbf4a20ab9bf989a2f8a8c42f18d",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
                "headBlob": "7ce4a2fa2b8bbbf4a20ab9bf989a2f8a8c42f18d",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "7e94aaa9290ec7205c57bd981af0a7863c4bf4b7",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ],
            "sourcePaths": [
              "packages/operator-core/lib/events/await/wake-source-predicate.ts",
              "packages/operator-core/lib/external-blockers.ts",
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
              "packages/operator-core/lib/scheduler/claim-spec-store.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-25T18:34:48.673Z",
        "bindingFingerprint": "e6a67dc6711787a3eabd97449ec435e2eaaf4702f8c5622f0b7a08ce3e810f16",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T18:35:09.235Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "7e94aaa9290ec7205c57bd981af0a7863c4bf4b7",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-22-P-007",
            "specRevision": 2,
            "specFingerprint": "588a9581e9098e2a932fddd03cbef0b04356660ffe006ca206f2eec7b427ef06",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:c62dd1bd8b2cb119ea76b1da08ff4aae2e40c6f1f4f216b7f42d37679c2a34d3",
            "testFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
            "fixtureFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1"
          }
        },
        "currentness": {
          "overall": "current",
          "dimensions": {
            "spec": "current",
            "source": "current",
            "test": "current",
            "fixture": "current",
            "rubric": "not-applicable",
            "environment": "not-applicable",
            "coverageEvidence": "not-applicable",
            "testRun": "current"
          },
          "staleReasons": [],
          "unknownReasons": [],
          "comparisonSupplied": true,
          "provenance": "server-measured"
        }
      },
      {
        "id": 70344,
        "workItemId": "WI-10008158",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-22-P-007",
        "sourceValId": null,
        "specRevision": 1,
        "currentRevision": 2,
        "specFingerprint": "5f13e94e5708893804b3703e2153ee9479646c73a6f9c513e1101b36a26ee1c6",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:c62dd1bd8b2cb119ea76b1da08ff4aae2e40c6f1f4f216b7f42d37679c2a34d3",
          "testFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
          "fixtureFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22046685,
        "testRunExecution": {
          "status": "pass",
          "passed": 65,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "passedCaseTitles": [],
          "testLayer": "unit",
          "passedCaseTitleCount": 65,
          "passedCaseTitlesOmitted": 65,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22046685
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "framework": "vitest",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 22046685,
            "source": "local",
            "status": "pass",
            "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T17:52:59.942Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-Tyr0BJ",
            "mutationPhase": null,
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "collected": true,
            "testLayer": "unit"
          },
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/events/await/wake-source-predicate.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9370a6b976d3a450d6ff8f5918749760ceee2c58682c3b41acee4f5c4192cf69",
                "headBlob": "895ef0ad6996c321233876a1ca9add8a0cfa63de",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/external-blockers.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2a2d4a20a5b06ca92ae33d36b0e42d5e86ed1a4dd661ac90d8e01966a8044261",
                "headBlob": "6d04bed99388a6ce3d90c9ad0594c464abdfcdcd",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
                "repo": ".",
                "clean": true,
                "sha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0",
                "headBlob": "a6c83dbd2a67656328922c1507dc7dfa74096c61",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f",
                "headBlob": "aedb066044139ed16fe6f66a4a43ff26b636085c",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
                "headBlob": "7ce4a2fa2b8bbbf4a20ab9bf989a2f8a8c42f18d",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
                "headBlob": "7ce4a2fa2b8bbbf4a20ab9bf989a2f8a8c42f18d",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "7e94aaa9290ec7205c57bd981af0a7863c4bf4b7",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ],
            "sourcePaths": [
              "packages/operator-core/lib/events/await/wake-source-predicate.ts",
              "packages/operator-core/lib/external-blockers.ts",
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
              "packages/operator-core/lib/scheduler/claim-spec-store.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-25T18:34:48.673Z",
        "bindingFingerprint": "7f1b84ab3d7c7dba99f1753c3b1a977d55f5337bd103216648a7b4b22c806d1a",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T18:34:48.655Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "7e94aaa9290ec7205c57bd981af0a7863c4bf4b7",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-22-P-007",
            "specRevision": 1,
            "specFingerprint": "5f13e94e5708893804b3703e2153ee9479646c73a6f9c513e1101b36a26ee1c6",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:c62dd1bd8b2cb119ea76b1da08ff4aae2e40c6f1f4f216b7f42d37679c2a34d3",
            "testFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
            "fixtureFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1"
          }
        },
        "currentness": {
          "overall": "stale",
          "dimensions": {
            "spec": "stale",
            "source": "current",
            "test": "current",
            "fixture": "current",
            "rubric": "not-applicable",
            "environment": "not-applicable",
            "coverageEvidence": "not-applicable",
            "testRun": "current"
          },
          "staleReasons": [
            "spec-stale"
          ],
          "unknownReasons": [],
          "comparisonSupplied": true,
          "provenance": "server-measured"
        }
      },
      {
        "id": 70318,
        "workItemId": "WI-10008164",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-22-P-013",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "3f64679e80c4de9e832ae2d1741fa6f53fa75afda7237463996589e63bb36e79",
        "evidenceKind": "mutation",
        "evidenceRef": "test-run 22047728 mutation-probe mutant fail packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts @0f9e16607008",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:c62dd1bd8b2cb119ea76b1da08ff4aae2e40c6f1f4f216b7f42d37679c2a34d3",
          "testFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
          "fixtureFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22047728,
        "testRunExecution": {
          "status": "fail",
          "passed": 58,
          "failed": 7,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "passedCaseTitles": [],
          "testLayer": "unit",
          "passedCaseTitleCount": 58,
          "passedCaseTitlesOmitted": 58,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22047728
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "mutant",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n+++ b/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n@@ -324,7 +324,7 @@\n   // blocker with none is revisited by nothing, so that hold falls through to the clocks as a\n   // WAKE-ONLY halt: one wake asking the holder to name the wake, never a page.\n   const unboundedParkedIds = input.unboundedBlockerParkedWorkItemIds ?? [];\n-  if (input.heldWorkItems <= 0 && unboundedParkedIds.length === 0) {\n+  if (input.heldWorkItems <= 0) {\n     const blockerParkedIds = input.blockerParkedWorkItemIds ?? [];\n     if (blockerParkedIds.length > 0) {\n       return no(\n",
            "subjectPath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
            "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
            "mutateExpression": "s/input\\.heldWorkItems <= 0 && unboundedParkedIds\\.length === 0/input.heldWorkItems <= 0/",
            "probeInvocationId": "9b40e29e-458e-4331-96b9-340004df7fff",
            "testCommandSha256": "39bf5a4004de1df81c250b8a7feb486cec3a13475cb35fd6400cfc6b08b47f0a",
            "subjectAfterSha256": "e6dc7375cf4471e3efe2ca26bc64873342527a5e818d17b7377d12265e6f7baa",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0"
          },
          "mutationBaseline": {
            "testRunId": 22047224,
            "status": "pass",
            "mutation": {
              "leg": "copy-baseline",
              "mode": "copy-out",
              "mutantDiff": "--- a/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n+++ b/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n@@ -324,7 +324,7 @@\n   // blocker with none is revisited by nothing, so that hold falls through to the clocks as a\n   // WAKE-ONLY halt: one wake asking the holder to name the wake, never a page.\n   const unboundedParkedIds = input.unboundedBlockerParkedWorkItemIds ?? [];\n-  if (input.heldWorkItems <= 0 && unboundedParkedIds.length === 0) {\n+  if (input.heldWorkItems <= 0) {\n     const blockerParkedIds = input.blockerParkedWorkItemIds ?? [];\n     if (blockerParkedIds.length > 0) {\n       return no(\n",
              "subjectPath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
              "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
              "againstCommit": null,
              "schemaVersion": 1,
              "testFileSha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
              "mutateExpression": "s/input\\.heldWorkItems <= 0 && unboundedParkedIds\\.length === 0/input.heldWorkItems <= 0/",
              "probeInvocationId": "9b40e29e-458e-4331-96b9-340004df7fff",
              "testCommandSha256": "39bf5a4004de1df81c250b8a7feb486cec3a13475cb35fd6400cfc6b08b47f0a",
              "subjectAfterSha256": "e6dc7375cf4471e3efe2ca26bc64873342527a5e818d17b7377d12265e6f7baa",
              "mutantDiffTruncated": false,
              "subjectBeforeSha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0"
            },
            "passed": 65,
            "failed": 0,
            "skipped": 0,
            "collectionFailed": false,
            "passedCaseTitles": [
              "evaluateSilentHalt > flags the real thing: alive process, autonomy posture, loop off, no await, no recent turn",
              "evaluateSilentHalt > INCIDENT ANCHOR (2026-09-01) — a session with NO presence row is GONE, not halted",
              "evaluateSilentHalt > BOUNDARY (unguarded-halt-rescue) — a load-0 halt is NOT ours; that module wakes it",
              "evaluateSilentHalt > held work is what JUSTIFIES the page — the strand is real either way",
              "evaluateSilentHalt > active typed external-blocker holds alone do not justify a silent-halt page (D-010/P-010)",
              "evaluateSilentHalt > a blocker park with NO re-check time names no wake: a WAKE-ONLY halt (WI-6554700010018551)",
              "evaluateSilentHalt > a wake-only park still respects every earlier exemption and both clocks",
              "evaluateSilentHalt > actionable held work keeps the PAGEABLE verdict even beside an unbounded park",
              "evaluateSilentHalt > still pages on actionable held work and names coexisting blocker-parked IDs",
              "evaluateSilentHalt > a stale heartbeat means the process is gone, not halted",
              "evaluateSilentHalt > a pending await IS a wake source — the 67 -> 3 collapse",
              "evaluateSilentHalt > an ARMED loop belongs to stalled-loops-guard, never this module",
              "evaluateSilentHalt > a session with no autonomy posture has a human in front of it",
              "evaluateSilentHalt > does not page a loop disarmed seconds ago — most disarms self-heal",
              "evaluateSilentHalt > does not page an agent that produced a turn inside the floor",
              "evaluateSilentHalt > fails quiet when nothing establishes DURATION (no turn ever, no disarm timestamp)",
              "evaluateSilentHalt > still flags a halt when the agent never produced a turn but the disarm clock is old",
              "evaluateSilentHalt > scales the staleness floor with the loop interval, never below the 30m floor",
              "silent-halt wake guidance > checks checkpoint gates before resuming or releasing held work",
              "sweepSilentHalts > pages the OWNER once for a halted session, with a dedupeKey",
              "sweepSilentHalts > keys the dedupeKey to the DISARM EPOCH, so a still-halted session never re-pages",
              "sweepSilentHalts > a re-armed loop between the two round-trips is NOT paged",
              "sweepSilentHalts > names an exemption for every spared candidate — a mute sweep is unexplainable",
              "sweepSilentHalts > dry_run detects without paging",
              "sweepSilentHalts > caps pages on a mass halt — a cluster is ONE incident, not N",
              "sweepSilentHalts > a downed push transport does not throw away the remaining pages, and says so",
              "sweepSilentHalts > an empty candidate set does no status read and pages nobody",
              "sweepSilentHalts > survives a failed loop-status read by sweeping without turn evidence",
              "sweepSilentHalts — wake-first rung (P-003) > first tick: WAKES the halted holder instead of paging — marker written before the wake fires",
              "sweepSilentHalts — wake-first rung (P-003) > second tick: a marker for the SAME disarm epoch pages with the wake evidence",
              "sweepSilentHalts — wake-first rung (P-003) > a marker from an OLDER disarm epoch does not spend the new epoch's wake",
              "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > wakes the holder with name-your-wake guidance and raises no owner-facing condition",
              "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > a spent wake for this epoch is never followed by a page",
              "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > with the wake rung off, or a host that needs a relaunch, it still never pages",
              "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > actionable strands are woken first under the cap, and only they reach the owner condition",
              "sweepSilentHalts — wake-first rung (P-003) > wake produced a turn but the session re-halted in the SAME epoch: the page says so",
              "sweepSilentHalts — wake-first rung (P-003) > caps the wake fan and DEFERS the overflow — it never falls through to the page",
              "sweepSilentHalts — wake-first rung (P-003) > marker-READ failure falls back to page-only (never a re-wake storm), and says so",
              "sweepSilentHalts — wake-first rung (P-003) > marker-WRITE failure skips the wake AND the page — the next tick retries the wake",
              "sweepSilentHalts — wake-first rung (P-003) > flag OFF: pages immediately with no wake attempt — the pre-P-003 behavior, exactly",
              "sweepSilentHalts — wake-first rung (P-003) > a parked fleet's member is woken WITH its way back — the park contract, verbatim",
              "sweepSilentHalts — wake-first rung (P-003) > FRAMING, not gating (D-005): a holder the classifier calls 'deliberate' is still WOKEN, and its page names that verdict",
              "sweepSilentHalts — P-007 slice 2 (D-006) > the candidate read does NOT count the session's own inbox-wake watcher as a wake source",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a dead work-item await does not exempt the session either (D-008 (1), via the shared predicate)",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a live untimed await still exempts the session (D-009: the detector stays lenient)",
              "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'blocked' work with a 'active' blocker",
              "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'needs-human' work with a 'active' blocker",
              "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'needs-human' work with a 'cleared' blocker",
              "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'wip' work with a 'active' blocker",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'no recheckAt (a pre-default legacy ro…' names no wake: halted as WAKE-ONLY, not exempt",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'an unparseable recheckAt' names no wake: halted as WAKE-ONLY, not exempt",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a host that needs a relaunch is NOT woken; it is paged at once with the HOST UNHEALTHY remedy",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a healthy, recoverable, or unreadable host keeps the wake-first rung exactly as before",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a host read that THROWS degrades to the wake-first rung, never to silence",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a DEDUPED page does not consume the per-sweep cap, so standing halts cannot starve a new one",
              "sweepSilentHalts — P-007 slice 2 (D-006) > the cap still bounds NEWLY created pages",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a fleet member's NEW page also alerts its fleet leader, once; a deduped page does not",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a non-fleet session is paged without any fleet-leader alert",
              "sweepSilentHalts — default notification adapter > alerts once for the same owner and epoch, then alerts again for a new epoch",
              "sweepSilentHalts — default notification adapter > does not re-alert for an existing intent even when an unfinished channel is delivered",
              "sweepSilentHalts — default notification adapter > does not let existing intents with channel attempts starve a new halt out of the page cap",
              "sweepSilentHalts — default notification adapter > preserves fail-soft delivery and leader alerting when intent storage is unavailable",
              "countPendingWakeSources — the seam to wake-source-predicate > counts none of the four dead shapes, so a stranded session reads as having no wake source",
              "countPendingWakeSources — the seam to wake-source-predicate > still counts an UNTIMED live watch (D-009: this detector stays lenient) and a bounded inbox await",
              "countPendingWakeSources — the seam to wake-source-predicate > does not query work_items when no candidate has an open await"
            ]
          },
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": false,
          "mutationFailureLines": [
            "evaluateSilentHalt > a blocker park with NO re-check time names no wake: a WAKE-ONLY halt (WI-6554700010018551): (recorded failed assertion)",
            "evaluateSilentHalt > a wake-only park still respects every earlier exemption and both clocks: (recorded failed assertion)",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > wakes the holder with name-your-wake guidance and raises no owner-facing condition: (recorded failed assertion)",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > a spent wake for this epoch is never followed by a page: (recorded failed assertion)",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > actionable strands are woken first under the cap, and only they reach the owner condition: (recorded failed assertion)",
            "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'no recheckAt (a pre-default legacy ro…' names no wake: halted as WAKE-ONLY, not exempt: (recorded failed assertion)",
            "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'an unparseable recheckAt' names no wake: halted as WAKE-ONLY, not exempt: (recorded failed assertion)"
          ],
          "mutationFailedCaseTitles": [
            "evaluateSilentHalt > a blocker park with NO re-check time names no wake: a WAKE-ONLY halt (WI-6554700010018551)",
            "evaluateSilentHalt > a wake-only park still respects every earlier exemption and both clocks",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > wakes the holder with name-your-wake guidance and raises no owner-facing condition",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > a spent wake for this epoch is never followed by a page",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > actionable strands are woken first under the cap, and only they reach the owner condition",
            "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'no recheckAt (a pre-default legacy ro…' names no wake: halted as WAKE-ONLY, not exempt",
            "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'an unparseable recheckAt' names no wake: halted as WAKE-ONLY, not exempt"
          ]
        },
        "details": {
          "testRun": {
            "id": 22047728,
            "source": "mutation-probe",
            "status": "fail",
            "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T17:57:24.134Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-Tyr0BJ",
            "mutationPhase": "mutant",
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "AUTO-BAR-R-22-P-013",
            "collected": true,
            "testLayer": "unit"
          },
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/events/await/wake-source-predicate.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9370a6b976d3a450d6ff8f5918749760ceee2c58682c3b41acee4f5c4192cf69",
                "headBlob": "895ef0ad6996c321233876a1ca9add8a0cfa63de",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/external-blockers.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2a2d4a20a5b06ca92ae33d36b0e42d5e86ed1a4dd661ac90d8e01966a8044261",
                "headBlob": "6d04bed99388a6ce3d90c9ad0594c464abdfcdcd",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
                "repo": ".",
                "clean": true,
                "sha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0",
                "headBlob": "a6c83dbd2a67656328922c1507dc7dfa74096c61",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f",
                "headBlob": "aedb066044139ed16fe6f66a4a43ff26b636085c",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
                "headBlob": "7ce4a2fa2b8bbbf4a20ab9bf989a2f8a8c42f18d",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
                "headBlob": "7ce4a2fa2b8bbbf4a20ab9bf989a2f8a8c42f18d",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "f8d697993f90516ed5a3ffc615ea71f7e5b71f20",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ],
            "sourcePaths": [
              "packages/operator-core/lib/events/await/wake-source-predicate.ts",
              "packages/operator-core/lib/external-blockers.ts",
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
              "packages/operator-core/lib/scheduler/claim-spec-store.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-25T18:01:58.675Z",
        "bindingFingerprint": "3feba050d85e468ce4d9a17af58a6132a175e6747792e2a4bee4df7845ad9b35",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T18:03:01.347Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "7e94aaa9290ec7205c57bd981af0a7863c4bf4b7",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-22-P-013",
            "specRevision": 2,
            "specFingerprint": "3f64679e80c4de9e832ae2d1741fa6f53fa75afda7237463996589e63bb36e79",
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 22047728 mutation-probe mutant fail packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts @0f9e16607008",
            "sourceFingerprint": "sha256-file-set-v1:c62dd1bd8b2cb119ea76b1da08ff4aae2e40c6f1f4f216b7f42d37679c2a34d3",
            "testFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
            "fixtureFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1"
          }
        },
        "currentness": {
          "overall": "current",
          "dimensions": {
            "spec": "current",
            "source": "current",
            "test": "current",
            "fixture": "current",
            "rubric": "not-applicable",
            "environment": "not-applicable",
            "coverageEvidence": "not-applicable",
            "testRun": "current"
          },
          "staleReasons": [],
          "unknownReasons": [],
          "comparisonSupplied": true,
          "provenance": "server-measured"
        }
      },
      {
        "id": 70305,
        "workItemId": "WI-10008164",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-22-P-013",
        "sourceValId": null,
        "specRevision": 1,
        "currentRevision": 2,
        "specFingerprint": "7543110f96de2cf4d8eaa495f9edad57d89182ff3e097bd906c5bdc96adc02ff",
        "evidenceKind": "mutation",
        "evidenceRef": "test-run 22047728 mutation-probe mutant fail packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts @0f9e16607008",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:c62dd1bd8b2cb119ea76b1da08ff4aae2e40c6f1f4f216b7f42d37679c2a34d3",
          "testFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
          "fixtureFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22047728,
        "testRunExecution": {
          "status": "fail",
          "passed": 58,
          "failed": 7,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "passedCaseTitles": [],
          "testLayer": "unit",
          "passedCaseTitleCount": 58,
          "passedCaseTitlesOmitted": 58,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22047728
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "mutant",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n+++ b/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n@@ -324,7 +324,7 @@\n   // blocker with none is revisited by nothing, so that hold falls through to the clocks as a\n   // WAKE-ONLY halt: one wake asking the holder to name the wake, never a page.\n   const unboundedParkedIds = input.unboundedBlockerParkedWorkItemIds ?? [];\n-  if (input.heldWorkItems <= 0 && unboundedParkedIds.length === 0) {\n+  if (input.heldWorkItems <= 0) {\n     const blockerParkedIds = input.blockerParkedWorkItemIds ?? [];\n     if (blockerParkedIds.length > 0) {\n       return no(\n",
            "subjectPath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
            "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
            "mutateExpression": "s/input\\.heldWorkItems <= 0 && unboundedParkedIds\\.length === 0/input.heldWorkItems <= 0/",
            "probeInvocationId": "9b40e29e-458e-4331-96b9-340004df7fff",
            "testCommandSha256": "39bf5a4004de1df81c250b8a7feb486cec3a13475cb35fd6400cfc6b08b47f0a",
            "subjectAfterSha256": "e6dc7375cf4471e3efe2ca26bc64873342527a5e818d17b7377d12265e6f7baa",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0"
          },
          "mutationBaseline": {
            "testRunId": 22047224,
            "status": "pass",
            "mutation": {
              "leg": "copy-baseline",
              "mode": "copy-out",
              "mutantDiff": "--- a/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n+++ b/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n@@ -324,7 +324,7 @@\n   // blocker with none is revisited by nothing, so that hold falls through to the clocks as a\n   // WAKE-ONLY halt: one wake asking the holder to name the wake, never a page.\n   const unboundedParkedIds = input.unboundedBlockerParkedWorkItemIds ?? [];\n-  if (input.heldWorkItems <= 0 && unboundedParkedIds.length === 0) {\n+  if (input.heldWorkItems <= 0) {\n     const blockerParkedIds = input.blockerParkedWorkItemIds ?? [];\n     if (blockerParkedIds.length > 0) {\n       return no(\n",
              "subjectPath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
              "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
              "againstCommit": null,
              "schemaVersion": 1,
              "testFileSha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
              "mutateExpression": "s/input\\.heldWorkItems <= 0 && unboundedParkedIds\\.length === 0/input.heldWorkItems <= 0/",
              "probeInvocationId": "9b40e29e-458e-4331-96b9-340004df7fff",
              "testCommandSha256": "39bf5a4004de1df81c250b8a7feb486cec3a13475cb35fd6400cfc6b08b47f0a",
              "subjectAfterSha256": "e6dc7375cf4471e3efe2ca26bc64873342527a5e818d17b7377d12265e6f7baa",
              "mutantDiffTruncated": false,
              "subjectBeforeSha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0"
            },
            "passed": 65,
            "failed": 0,
            "skipped": 0,
            "collectionFailed": false,
            "passedCaseTitles": [
              "evaluateSilentHalt > flags the real thing: alive process, autonomy posture, loop off, no await, no recent turn",
              "evaluateSilentHalt > INCIDENT ANCHOR (2026-09-01) — a session with NO presence row is GONE, not halted",
              "evaluateSilentHalt > BOUNDARY (unguarded-halt-rescue) — a load-0 halt is NOT ours; that module wakes it",
              "evaluateSilentHalt > held work is what JUSTIFIES the page — the strand is real either way",
              "evaluateSilentHalt > active typed external-blocker holds alone do not justify a silent-halt page (D-010/P-010)",
              "evaluateSilentHalt > a blocker park with NO re-check time names no wake: a WAKE-ONLY halt (WI-6554700010018551)",
              "evaluateSilentHalt > a wake-only park still respects every earlier exemption and both clocks",
              "evaluateSilentHalt > actionable held work keeps the PAGEABLE verdict even beside an unbounded park",
              "evaluateSilentHalt > still pages on actionable held work and names coexisting blocker-parked IDs",
              "evaluateSilentHalt > a stale heartbeat means the process is gone, not halted",
              "evaluateSilentHalt > a pending await IS a wake source — the 67 -> 3 collapse",
              "evaluateSilentHalt > an ARMED loop belongs to stalled-loops-guard, never this module",
              "evaluateSilentHalt > a session with no autonomy posture has a human in front of it",
              "evaluateSilentHalt > does not page a loop disarmed seconds ago — most disarms self-heal",
              "evaluateSilentHalt > does not page an agent that produced a turn inside the floor",
              "evaluateSilentHalt > fails quiet when nothing establishes DURATION (no turn ever, no disarm timestamp)",
              "evaluateSilentHalt > still flags a halt when the agent never produced a turn but the disarm clock is old",
              "evaluateSilentHalt > scales the staleness floor with the loop interval, never below the 30m floor",
              "silent-halt wake guidance > checks checkpoint gates before resuming or releasing held work",
              "sweepSilentHalts > pages the OWNER once for a halted session, with a dedupeKey",
              "sweepSilentHalts > keys the dedupeKey to the DISARM EPOCH, so a still-halted session never re-pages",
              "sweepSilentHalts > a re-armed loop between the two round-trips is NOT paged",
              "sweepSilentHalts > names an exemption for every spared candidate — a mute sweep is unexplainable",
              "sweepSilentHalts > dry_run detects without paging",
              "sweepSilentHalts > caps pages on a mass halt — a cluster is ONE incident, not N",
              "sweepSilentHalts > a downed push transport does not throw away the remaining pages, and says so",
              "sweepSilentHalts > an empty candidate set does no status read and pages nobody",
              "sweepSilentHalts > survives a failed loop-status read by sweeping without turn evidence",
              "sweepSilentHalts — wake-first rung (P-003) > first tick: WAKES the halted holder instead of paging — marker written before the wake fires",
              "sweepSilentHalts — wake-first rung (P-003) > second tick: a marker for the SAME disarm epoch pages with the wake evidence",
              "sweepSilentHalts — wake-first rung (P-003) > a marker from an OLDER disarm epoch does not spend the new epoch's wake",
              "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > wakes the holder with name-your-wake guidance and raises no owner-facing condition",
              "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > a spent wake for this epoch is never followed by a page",
              "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > with the wake rung off, or a host that needs a relaunch, it still never pages",
              "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > actionable strands are woken first under the cap, and only they reach the owner condition",
              "sweepSilentHalts — wake-first rung (P-003) > wake produced a turn but the session re-halted in the SAME epoch: the page says so",
              "sweepSilentHalts — wake-first rung (P-003) > caps the wake fan and DEFERS the overflow — it never falls through to the page",
              "sweepSilentHalts — wake-first rung (P-003) > marker-READ failure falls back to page-only (never a re-wake storm), and says so",
              "sweepSilentHalts — wake-first rung (P-003) > marker-WRITE failure skips the wake AND the page — the next tick retries the wake",
              "sweepSilentHalts — wake-first rung (P-003) > flag OFF: pages immediately with no wake attempt — the pre-P-003 behavior, exactly",
              "sweepSilentHalts — wake-first rung (P-003) > a parked fleet's member is woken WITH its way back — the park contract, verbatim",
              "sweepSilentHalts — wake-first rung (P-003) > FRAMING, not gating (D-005): a holder the classifier calls 'deliberate' is still WOKEN, and its page names that verdict",
              "sweepSilentHalts — P-007 slice 2 (D-006) > the candidate read does NOT count the session's own inbox-wake watcher as a wake source",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a dead work-item await does not exempt the session either (D-008 (1), via the shared predicate)",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a live untimed await still exempts the session (D-009: the detector stays lenient)",
              "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'blocked' work with a 'active' blocker",
              "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'needs-human' work with a 'active' blocker",
              "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'needs-human' work with a 'cleared' blocker",
              "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'wip' work with a 'active' blocker",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'no recheckAt (a pre-default legacy ro…' names no wake: halted as WAKE-ONLY, not exempt",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'an unparseable recheckAt' names no wake: halted as WAKE-ONLY, not exempt",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a host that needs a relaunch is NOT woken; it is paged at once with the HOST UNHEALTHY remedy",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a healthy, recoverable, or unreadable host keeps the wake-first rung exactly as before",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a host read that THROWS degrades to the wake-first rung, never to silence",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a DEDUPED page does not consume the per-sweep cap, so standing halts cannot starve a new one",
              "sweepSilentHalts — P-007 slice 2 (D-006) > the cap still bounds NEWLY created pages",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a fleet member's NEW page also alerts its fleet leader, once; a deduped page does not",
              "sweepSilentHalts — P-007 slice 2 (D-006) > a non-fleet session is paged without any fleet-leader alert",
              "sweepSilentHalts — default notification adapter > alerts once for the same owner and epoch, then alerts again for a new epoch",
              "sweepSilentHalts — default notification adapter > does not re-alert for an existing intent even when an unfinished channel is delivered",
              "sweepSilentHalts — default notification adapter > does not let existing intents with channel attempts starve a new halt out of the page cap",
              "sweepSilentHalts — default notification adapter > preserves fail-soft delivery and leader alerting when intent storage is unavailable",
              "countPendingWakeSources — the seam to wake-source-predicate > counts none of the four dead shapes, so a stranded session reads as having no wake source",
              "countPendingWakeSources — the seam to wake-source-predicate > still counts an UNTIMED live watch (D-009: this detector stays lenient) and a bounded inbox await",
              "countPendingWakeSources — the seam to wake-source-predicate > does not query work_items when no candidate has an open await"
            ]
          },
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": false,
          "mutationFailureLines": [
            "evaluateSilentHalt > a blocker park with NO re-check time names no wake: a WAKE-ONLY halt (WI-6554700010018551): (recorded failed assertion)",
            "evaluateSilentHalt > a wake-only park still respects every earlier exemption and both clocks: (recorded failed assertion)",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > wakes the holder with name-your-wake guidance and raises no owner-facing condition: (recorded failed assertion)",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > a spent wake for this epoch is never followed by a page: (recorded failed assertion)",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > actionable strands are woken first under the cap, and only they reach the owner condition: (recorded failed assertion)",
            "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'no recheckAt (a pre-default legacy ro…' names no wake: halted as WAKE-ONLY, not exempt: (recorded failed assertion)",
            "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'an unparseable recheckAt' names no wake: halted as WAKE-ONLY, not exempt: (recorded failed assertion)"
          ],
          "mutationFailedCaseTitles": [
            "evaluateSilentHalt > a blocker park with NO re-check time names no wake: a WAKE-ONLY halt (WI-6554700010018551)",
            "evaluateSilentHalt > a wake-only park still respects every earlier exemption and both clocks",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > wakes the holder with name-your-wake guidance and raises no owner-facing condition",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > a spent wake for this epoch is never followed by a page",
            "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > actionable strands are woken first under the cap, and only they reach the owner condition",
            "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'no recheckAt (a pre-default legacy ro…' names no wake: halted as WAKE-ONLY, not exempt",
            "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'an unparseable recheckAt' names no wake: halted as WAKE-ONLY, not exempt"
          ]
        },
        "details": {
          "testRun": {
            "id": 22047728,
            "source": "mutation-probe",
            "status": "fail",
            "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T17:57:24.134Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-Tyr0BJ",
            "mutationPhase": "mutant",
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "AUTO-BAR-R-22-P-013",
            "collected": true,
            "testLayer": "unit"
          },
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/events/await/wake-source-predicate.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9370a6b976d3a450d6ff8f5918749760ceee2c58682c3b41acee4f5c4192cf69",
                "headBlob": "895ef0ad6996c321233876a1ca9add8a0cfa63de",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/external-blockers.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2a2d4a20a5b06ca92ae33d36b0e42d5e86ed1a4dd661ac90d8e01966a8044261",
                "headBlob": "6d04bed99388a6ce3d90c9ad0594c464abdfcdcd",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
                "repo": ".",
                "clean": true,
                "sha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0",
                "headBlob": "a6c83dbd2a67656328922c1507dc7dfa74096c61",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f",
                "headBlob": "aedb066044139ed16fe6f66a4a43ff26b636085c",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
                "headBlob": "7ce4a2fa2b8bbbf4a20ab9bf989a2f8a8c42f18d",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
                "headBlob": "7ce4a2fa2b8bbbf4a20ab9bf989a2f8a8c42f18d",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "f8d697993f90516ed5a3ffc615ea71f7e5b71f20",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ],
            "sourcePaths": [
              "packages/operator-core/lib/events/await/wake-source-predicate.ts",
              "packages/operator-core/lib/external-blockers.ts",
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
              "packages/operator-core/lib/scheduler/claim-spec-store.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-25T18:01:58.675Z",
        "bindingFingerprint": "705b357669d22479b64b5cd990b70cfd0510c977c74f576dbeee85b8d54bdae5",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T18:01:58.658Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "7e94aaa9290ec7205c57bd981af0a7863c4bf4b7",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-22-P-013",
            "specRevision": 1,
            "specFingerprint": "7543110f96de2cf4d8eaa495f9edad57d89182ff3e097bd906c5bdc96adc02ff",
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 22047728 mutation-probe mutant fail packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts @0f9e16607008",
            "sourceFingerprint": "sha256-file-set-v1:c62dd1bd8b2cb119ea76b1da08ff4aae2e40c6f1f4f216b7f42d37679c2a34d3",
            "testFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
            "fixtureFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1"
          }
        },
        "currentness": {
          "overall": "stale",
          "dimensions": {
            "spec": "stale",
            "source": "current",
            "test": "current",
            "fixture": "current",
            "rubric": "not-applicable",
            "environment": "not-applicable",
            "coverageEvidence": "not-applicable",
            "testRun": "current"
          },
          "staleReasons": [
            "spec-stale"
          ],
          "unknownReasons": [],
          "comparisonSupplied": true,
          "provenance": "server-measured"
        }
      },
      {
        "id": 70317,
        "workItemId": "WI-10008164",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-22-P-013",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "3f64679e80c4de9e832ae2d1741fa6f53fa75afda7237463996589e63bb36e79",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:c62dd1bd8b2cb119ea76b1da08ff4aae2e40c6f1f4f216b7f42d37679c2a34d3",
          "testFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
          "fixtureFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22046685,
        "testRunExecution": {
          "status": "pass",
          "passed": 65,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "passedCaseTitles": [],
          "testLayer": "unit",
          "passedCaseTitleCount": 65,
          "passedCaseTitlesOmitted": 65,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22046685
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "framework": "vitest",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 22046685,
            "source": "local",
            "status": "pass",
            "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T17:52:59.942Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-Tyr0BJ",
            "mutationPhase": null,
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "collected": true,
            "testLayer": "unit"
          },
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/events/await/wake-source-predicate.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9370a6b976d3a450d6ff8f5918749760ceee2c58682c3b41acee4f5c4192cf69",
                "headBlob": "895ef0ad6996c321233876a1ca9add8a0cfa63de",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/external-blockers.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2a2d4a20a5b06ca92ae33d36b0e42d5e86ed1a4dd661ac90d8e01966a8044261",
                "headBlob": "6d04bed99388a6ce3d90c9ad0594c464abdfcdcd",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
                "repo": ".",
                "clean": true,
                "sha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0",
                "headBlob": "a6c83dbd2a67656328922c1507dc7dfa74096c61",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f",
                "headBlob": "aedb066044139ed16fe6f66a4a43ff26b636085c",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
                "headBlob": "7ce4a2fa2b8bbbf4a20ab9bf989a2f8a8c42f18d",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
                "headBlob": "7ce4a2fa2b8bbbf4a20ab9bf989a2f8a8c42f18d",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "0f9e16607008b5c7f930091a836a80d786268b5a",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ],
            "sourcePaths": [
              "packages/operator-core/lib/events/await/wake-source-predicate.ts",
              "packages/operator-core/lib/external-blockers.ts",
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
              "packages/operator-core/lib/scheduler/claim-spec-store.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-25T17:56:32.639Z",
        "bindingFingerprint": "c291ff977cd5a8a430009011e144fe8dac54d1d79c28b7eca125518f56c77a87",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T18:03:01.347Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "7e94aaa9290ec7205c57bd981af0a7863c4bf4b7",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-22-P-013",
            "specRevision": 2,
            "specFingerprint": "3f64679e80c4de9e832ae2d1741fa6f53fa75afda7237463996589e63bb36e79",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:c62dd1bd8b2cb119ea76b1da08ff4aae2e40c6f1f4f216b7f42d37679c2a34d3",
            "testFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
            "fixtureFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1"
          }
        },
        "currentness": {
          "overall": "current",
          "dimensions": {
            "spec": "current",
            "source": "current",
            "test": "current",
            "fixture": "current",
            "rubric": "not-applicable",
            "environment": "not-applicable",
            "coverageEvidence": "not-applicable",
            "testRun": "current"
          },
          "staleReasons": [],
          "unknownReasons": [],
          "comparisonSupplied": true,
          "provenance": "server-measured"
        }
      },
      {
        "id": 70285,
        "workItemId": "WI-10008164",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-22-P-013",
        "sourceValId": null,
        "specRevision": 1,
        "currentRevision": 2,
        "specFingerprint": "7543110f96de2cf4d8eaa495f9edad57d89182ff3e097bd906c5bdc96adc02ff",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:c62dd1bd8b2cb119ea76b1da08ff4aae2e40c6f1f4f216b7f42d37679c2a34d3",
          "testFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
          "fixtureFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22046685,
        "testRunExecution": {
          "status": "pass",
          "passed": 65,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "passedCaseTitles": [],
          "testLayer": "unit",
          "passedCaseTitleCount": 65,
          "passedCaseTitlesOmitted": 65,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22046685
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "framework": "vitest",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 22046685,
            "source": "local",
            "status": "pass",
            "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T17:52:59.942Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-Tyr0BJ",
            "mutationPhase": null,
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "collected": true,
            "testLayer": "unit"
          },
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/events/await/wake-source-predicate.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9370a6b976d3a450d6ff8f5918749760ceee2c58682c3b41acee4f5c4192cf69",
                "headBlob": "895ef0ad6996c321233876a1ca9add8a0cfa63de",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/external-blockers.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2a2d4a20a5b06ca92ae33d36b0e42d5e86ed1a4dd661ac90d8e01966a8044261",
                "headBlob": "6d04bed99388a6ce3d90c9ad0594c464abdfcdcd",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
                "repo": ".",
                "clean": true,
                "sha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0",
                "headBlob": "a6c83dbd2a67656328922c1507dc7dfa74096c61",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f",
                "headBlob": "aedb066044139ed16fe6f66a4a43ff26b636085c",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
                "headBlob": "7ce4a2fa2b8bbbf4a20ab9bf989a2f8a8c42f18d",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
                "headBlob": "7ce4a2fa2b8bbbf4a20ab9bf989a2f8a8c42f18d",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "0f9e16607008b5c7f930091a836a80d786268b5a",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ],
            "sourcePaths": [
              "packages/operator-core/lib/events/await/wake-source-predicate.ts",
              "packages/operator-core/lib/external-blockers.ts",
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
              "packages/operator-core/lib/scheduler/claim-spec-store.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-25T17:56:32.639Z",
        "bindingFingerprint": "de8385d88552fe6978ef86bd8149e85e37931de22f229f85400891b2635c9627",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T17:56:32.621Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "7e94aaa9290ec7205c57bd981af0a7863c4bf4b7",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-22-P-013",
            "specRevision": 1,
            "specFingerprint": "7543110f96de2cf4d8eaa495f9edad57d89182ff3e097bd906c5bdc96adc02ff",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:c62dd1bd8b2cb119ea76b1da08ff4aae2e40c6f1f4f216b7f42d37679c2a34d3",
            "testFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
            "fixtureFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1"
          }
        },
        "currentness": {
          "overall": "stale",
          "dimensions": {
            "spec": "stale",
            "source": "current",
            "test": "current",
            "fixture": "current",
            "rubric": "not-applicable",
            "environment": "not-applicable",
            "coverageEvidence": "not-applicable",
            "testRun": "current"
          },
          "staleReasons": [
            "spec-stale"
          ],
          "unknownReasons": [],
          "comparisonSupplied": true,
          "provenance": "server-measured"
        }
      },
      {
        "id": 70316,
        "workItemId": "WI-10008164",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-22-P-013",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "3f64679e80c4de9e832ae2d1741fa6f53fa75afda7237463996589e63bb36e79",
        "evidenceKind": "test",
        "evidenceRef": "test-run-group:e1a217db-1e0d-42cb-8637-6a3513d34bba:0",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:c62dd1bd8b2cb119ea76b1da08ff4aae2e40c6f1f4f216b7f42d37679c2a34d3",
          "testFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
          "fixtureFingerprint": null,
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22046475,
        "testRunExecution": {
          "status": "pass",
          "passed": 65,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "passedCaseTitles": [],
          "testLayer": "unit",
          "passedCaseTitleCount": 65,
          "passedCaseTitlesOmitted": 65,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22046475
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "framework": "vitest",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": true
        },
        "details": {
          "adequacy": {
            "outcome": "pass",
            "skipped": false,
            "executed": true,
            "collected": true,
            "testLayer": "unit"
          },
          "testExecution": {
            "phase": "settled",
            "runId": "e1a217db-1e0d-42cb-8637-6a3513d34bba",
            "binding": {
              "specId": "AUTO-BAR-R-22-P-013",
              "testPath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
              "testLayer": "unit",
              "sourcePaths": [
                "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
                "packages/operator-core/lib/events/await/wake-source-predicate.ts",
                "packages/operator-core/lib/external-blockers.ts",
                "packages/operator-core/lib/scheduler/claim-spec-store.ts"
              ],
              "specRevision": 1
            },
            "originRunId": "e1a217db-1e0d-42cb-8637-6a3513d34bba",
            "ledgerStatus": "pass",
            "sourceStable": true,
            "ledgerMatches": 1,
            "schemaVersion": 1,
            "measuredOutcome": "pass",
            "ledgerRunGroupId": "e1a217db-1e0d-42cb-8637-6a3513d34bba",
            "ledgerAttribution": "attributed",
            "observedTestLayer": "unit"
          },
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/events/await/wake-source-predicate.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9370a6b976d3a450d6ff8f5918749760ceee2c58682c3b41acee4f5c4192cf69",
                "headBlob": "895ef0ad6996c321233876a1ca9add8a0cfa63de",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/external-blockers.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2a2d4a20a5b06ca92ae33d36b0e42d5e86ed1a4dd661ac90d8e01966a8044261",
                "headBlob": "6d04bed99388a6ce3d90c9ad0594c464abdfcdcd",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
                "repo": ".",
                "clean": true,
                "sha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0",
                "headBlob": "a6c83dbd2a67656328922c1507dc7dfa74096c61",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f",
                "headBlob": "aedb066044139ed16fe6f66a4a43ff26b636085c",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
                "headBlob": "7ce4a2fa2b8bbbf4a20ab9bf989a2f8a8c42f18d",
                "dimension": "test"
              }
            ],
            "repos": [
              {
                "head": "28d27b043f5032eed5c9a25081295f40a9022bdc",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ],
            "sourcePaths": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
              "packages/operator-core/lib/events/await/wake-source-predicate.ts",
              "packages/operator-core/lib/external-blockers.ts",
              "packages/operator-core/lib/scheduler/claim-spec-store.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-25T17:39:43.539Z",
        "bindingFingerprint": "409a988ba5e19efd590bfc287b99750487413b7809203fa50f3b674f6dac69b3",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T18:03:01.347Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test"
          ],
          "measuredAtCommit": "7e94aaa9290ec7205c57bd981af0a7863c4bf4b7",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-22-P-013",
            "specRevision": 2,
            "specFingerprint": "3f64679e80c4de9e832ae2d1741fa6f53fa75afda7237463996589e63bb36e79",
            "evidenceKind": "test",
            "evidenceRef": "test-run-group:e1a217db-1e0d-42cb-8637-6a3513d34bba:0",
            "sourceFingerprint": "sha256-file-set-v1:c62dd1bd8b2cb119ea76b1da08ff4aae2e40c6f1f4f216b7f42d37679c2a34d3",
            "testFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1"
          }
        },
        "currentness": {
          "overall": "unknown",
          "dimensions": {
            "spec": "current",
            "source": "current",
            "test": "current",
            "fixture": "not-applicable",
            "rubric": "not-applicable",
            "environment": "not-applicable",
            "coverageEvidence": "not-applicable",
            "testRun": "unknown"
          },
          "staleReasons": [],
          "unknownReasons": [
            "test-run-worktree-not-clean"
          ],
          "comparisonSupplied": true,
          "provenance": "server-measured"
        }
      },
      {
        "id": 70257,
        "workItemId": "WI-10008164",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-22-P-013",
        "sourceValId": null,
        "specRevision": 1,
        "currentRevision": 2,
        "specFingerprint": "7543110f96de2cf4d8eaa495f9edad57d89182ff3e097bd906c5bdc96adc02ff",
        "evidenceKind": "test",
        "evidenceRef": "test-run-group:e1a217db-1e0d-42cb-8637-6a3513d34bba:0",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:c62dd1bd8b2cb119ea76b1da08ff4aae2e40c6f1f4f216b7f42d37679c2a34d3",
          "testFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
          "fixtureFingerprint": null,
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22046475,
        "testRunExecution": {
          "status": "pass",
          "passed": 65,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "passedCaseTitles": [],
          "testLayer": "unit",
          "passedCaseTitleCount": 65,
          "passedCaseTitlesOmitted": 65,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22046475
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "framework": "vitest",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": true
        },
        "details": {
          "adequacy": {
            "outcome": "pass",
            "skipped": false,
            "executed": true,
            "collected": true,
            "testLayer": "unit"
          },
          "testExecution": {
            "phase": "settled",
            "runId": "e1a217db-1e0d-42cb-8637-6a3513d34bba",
            "binding": {
              "specId": "AUTO-BAR-R-22-P-013",
              "testPath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
              "testLayer": "unit",
              "sourcePaths": [
                "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
                "packages/operator-core/lib/events/await/wake-source-predicate.ts",
                "packages/operator-core/lib/external-blockers.ts",
                "packages/operator-core/lib/scheduler/claim-spec-store.ts"
              ],
              "specRevision": 1
            },
            "originRunId": "e1a217db-1e0d-42cb-8637-6a3513d34bba",
            "ledgerStatus": "pass",
            "sourceStable": true,
            "ledgerMatches": 1,
            "schemaVersion": 1,
            "measuredOutcome": "pass",
            "ledgerRunGroupId": "e1a217db-1e0d-42cb-8637-6a3513d34bba",
            "ledgerAttribution": "attributed",
            "observedTestLayer": "unit"
          },
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/events/await/wake-source-predicate.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9370a6b976d3a450d6ff8f5918749760ceee2c58682c3b41acee4f5c4192cf69",
                "headBlob": "895ef0ad6996c321233876a1ca9add8a0cfa63de",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/external-blockers.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2a2d4a20a5b06ca92ae33d36b0e42d5e86ed1a4dd661ac90d8e01966a8044261",
                "headBlob": "6d04bed99388a6ce3d90c9ad0594c464abdfcdcd",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
                "repo": ".",
                "clean": true,
                "sha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0",
                "headBlob": "a6c83dbd2a67656328922c1507dc7dfa74096c61",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f",
                "headBlob": "aedb066044139ed16fe6f66a4a43ff26b636085c",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
                "headBlob": "7ce4a2fa2b8bbbf4a20ab9bf989a2f8a8c42f18d",
                "dimension": "test"
              }
            ],
            "repos": [
              {
                "head": "28d27b043f5032eed5c9a25081295f40a9022bdc",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
            ],
            "sourcePaths": [
              "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
              "packages/operator-core/lib/events/await/wake-source-predicate.ts",
              "packages/operator-core/lib/external-blockers.ts",
              "packages/operator-core/lib/scheduler/claim-spec-store.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-25T17:39:43.539Z",
        "bindingFingerprint": "fcd71f09e70c9777ebcea01f1f16fa9d8d1a1723403f40a889345f76629966e5",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T17:39:43.510Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test"
          ],
          "measuredAtCommit": "7e94aaa9290ec7205c57bd981af0a7863c4bf4b7",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-22-P-013",
            "specRevision": 1,
            "specFingerprint": "7543110f96de2cf4d8eaa495f9edad57d89182ff3e097bd906c5bdc96adc02ff",
            "evidenceKind": "test",
            "evidenceRef": "test-run-group:e1a217db-1e0d-42cb-8637-6a3513d34bba:0",
            "sourceFingerprint": "sha256-file-set-v1:c62dd1bd8b2cb119ea76b1da08ff4aae2e40c6f1f4f216b7f42d37679c2a34d3",
            "testFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1"
          }
        },
        "currentness": {
          "overall": "stale",
          "dimensions": {
            "spec": "stale",
            "source": "current",
            "test": "current",
            "fixture": "not-applicable",
            "rubric": "not-applicable",
            "environment": "not-applicable",
            "coverageEvidence": "not-applicable",
            "testRun": "unknown"
          },
          "staleReasons": [
            "spec-stale"
          ],
          "unknownReasons": [
            "test-run-worktree-not-clean"
          ],
          "comparisonSupplied": true,
          "provenance": "server-measured"
        }
      }
    ],
    "count": 10,
    "currentness": {
      "current": 4,
      "stale": 5,
      "unknown": 1
    },
    "_meta": {
      "explicitFullRequest": true,
      "format": "json",
      "_seeAlso": [
        {
          "tool": "plans:bind-spec-evidence (append proof)"
        },
        {
          "tool": "plans:get-specs (canonical behavior)"
        }
      ]
    }
  },
  "semanticEquality": [
    {
      "id": "AUTO-BAR-R-22-P-007",
      "equal": true
    },
    {
      "id": "AUTO-BAR-R-22-P-013",
      "equal": true
    }
  ]
}
