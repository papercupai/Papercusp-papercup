---
rel_path: "audits/parked-agent-resumption-2026-10-09/r26-clean-mechanical-proof-22052398-424d5.json"
updated_at: 1792955870963
_body: "content"
---

{
  "at": "2026-10-25T19:17:50.945Z",
  "scope": "R26 mechanical tree adequacy only; whole-plan and original116/R14/runtime walls remain open",
  "priorCheckpointArchive": "audits/parked-agent-resumption-2026-10-09/r24-r25-clean-mechanical-proof-22052299-22052325-424d5.json",
  "specs": {
    "ok": true,
    "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
    "harnessSlug": "papercusp",
    "specs": [
      {
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-26-P-007",
        "sourceValId": null,
        "currentRevision": 2,
        "revision": 1,
        "planItemId": "P-007",
        "behavior": "Existing deduped silent-halt pages leave the configured new-page budget available to new halts.",
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
          "observation": "A deduped page consumes that budget or new pages exceed the configured cap."
        },
        "contentHash": "8c832b66c19b96c9df03f62408a791b1154096d43b7f4931a3f617f70cd397ce",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-17T22:54:22.228Z",
        "acceptedBy": null,
        "acceptedAt": null,
        "acceptanceRef": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09@9:R-26",
        "sourceBar": {
          "barKey": "R-26",
          "barHash": "61cbc067d4f33decf7d7c8bf6e5dc4d8313199a3f9b8a1f888a8667106447f02",
          "barSetHash": "fa0600d29e77c05a36329aa052fe5f1d4cc5f5ba6430ef011f56dcaa3e1bc329",
          "rubricSlug": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09",
          "rubricRevision": 9,
          "evidencePlane": "tree"
        }
      },
      {
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-26-P-007",
        "sourceValId": null,
        "currentRevision": 2,
        "revision": 2,
        "planItemId": "P-007",
        "behavior": "Existing deduped silent-halt pages leave the configured new-page budget available to new halts.",
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
          "observation": "A deduped page consumes that budget or new pages exceed the configured cap."
        },
        "contentHash": "a1495e307cdb9593848fea8d31b2343beeb93d24a884565f40c72f2a4f8649b7",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T19:17:09.812Z",
        "acceptedBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "acceptedAt": "2026-10-25T19:17:09.823Z",
        "acceptanceRef": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09@9:R-26",
        "sourceBar": {
          "barKey": "R-26",
          "barHash": "61cbc067d4f33decf7d7c8bf6e5dc4d8313199a3f9b8a1f888a8667106447f02",
          "barSetHash": "fa0600d29e77c05a36329aa052fe5f1d4cc5f5ba6430ef011f56dcaa3e1bc329",
          "rubricSlug": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09",
          "rubricRevision": 9,
          "evidencePlane": "tree"
        }
      }
    ],
    "count": 2,
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
      "limit": 200,
      "truncatedByLimit": false
    },
    "detail": "full",
    "evidence": [
      {
        "id": 70408,
        "workItemId": "WI-10008158",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-26-P-007",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "a1495e307cdb9593848fea8d31b2343beeb93d24a884565f40c72f2a4f8649b7",
        "evidenceKind": "mutation",
        "evidenceRef": "test-run 22052398 mutation-probe mutant fail packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts @0f9e16607008",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:c62dd1bd8b2cb119ea76b1da08ff4aae2e40c6f1f4f216b7f42d37679c2a34d3",
          "testFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
          "fixtureFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22052398,
        "testRunExecution": {
          "status": "fail",
          "passed": 60,
          "failed": 5,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "passedCaseTitles": [],
          "testLayer": "unit",
          "passedCaseTitleCount": 60,
          "passedCaseTitlesOmitted": 60,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22052398
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
            "mutantDiff": "--- a/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n+++ b/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n@@ -1048,7 +1048,7 @@\n       const existingIntent = typeof outcome === 'object' && outcome !== null && (\n         outcome.intentCreated === false || (outcome.intentCreated == null && outcome.deduped === true)\n       );\n-      if (existingIntent) continue;\n+      if (false) continue;\n       newPages++;\n       // D-006 (3): the fleet's leader can re-place the held work; the owner page alone leaves a\n       // fleet member's lane frozen until a human reads it. Same epoch dedupe as the page.\n",
            "subjectPath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
            "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
            "mutateExpression": "s/if \\(existingIntent\\) continue;/if (false) continue;/",
            "probeInvocationId": "04ed26c6-3756-4b27-b9aa-454f20347171",
            "testCommandSha256": "39bf5a4004de1df81c250b8a7feb486cec3a13475cb35fd6400cfc6b08b47f0a",
            "subjectAfterSha256": "0e9956e89888dbfaf0fa8ab795b80000c14089f99ca24680781c3dcdd3f5fc47",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0"
          },
          "mutationBaseline": {
            "testRunId": 22052395,
            "status": "pass",
            "mutation": {
              "leg": "copy-baseline",
              "mode": "copy-out",
              "mutantDiff": "--- a/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n+++ b/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n@@ -1048,7 +1048,7 @@\n       const existingIntent = typeof outcome === 'object' && outcome !== null && (\n         outcome.intentCreated === false || (outcome.intentCreated == null && outcome.deduped === true)\n       );\n-      if (existingIntent) continue;\n+      if (false) continue;\n       newPages++;\n       // D-006 (3): the fleet's leader can re-place the held work; the owner page alone leaves a\n       // fleet member's lane frozen until a human reads it. Same epoch dedupe as the page.\n",
              "subjectPath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
              "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
              "againstCommit": null,
              "schemaVersion": 1,
              "testFileSha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
              "mutateExpression": "s/if \\(existingIntent\\) continue;/if (false) continue;/",
              "probeInvocationId": "04ed26c6-3756-4b27-b9aa-454f20347171",
              "testCommandSha256": "39bf5a4004de1df81c250b8a7feb486cec3a13475cb35fd6400cfc6b08b47f0a",
              "subjectAfterSha256": "0e9956e89888dbfaf0fa8ab795b80000c14089f99ca24680781c3dcdd3f5fc47",
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
            "sweepSilentHalts — P-007 slice 2 (D-006) > a DEDUPED page does not consume the per-sweep cap, so standing halts cannot starve a new one: (recorded failed assertion)",
            "sweepSilentHalts — P-007 slice 2 (D-006) > a fleet member's NEW page also alerts its fleet leader, once; a deduped page does not: (recorded failed assertion)",
            "sweepSilentHalts — default notification adapter > alerts once for the same owner and epoch, then alerts again for a new epoch: (recorded failed assertion)",
            "sweepSilentHalts — default notification adapter > does not re-alert for an existing intent even when an unfinished channel is delivered: (recorded failed assertion)",
            "sweepSilentHalts — default notification adapter > does not let existing intents with channel attempts starve a new halt out of the page cap: (recorded failed assertion)"
          ],
          "mutationFailedCaseTitles": [
            "sweepSilentHalts — P-007 slice 2 (D-006) > a DEDUPED page does not consume the per-sweep cap, so standing halts cannot starve a new one",
            "sweepSilentHalts — P-007 slice 2 (D-006) > a fleet member's NEW page also alerts its fleet leader, once; a deduped page does not",
            "sweepSilentHalts — default notification adapter > alerts once for the same owner and epoch, then alerts again for a new epoch",
            "sweepSilentHalts — default notification adapter > does not re-alert for an existing intent even when an unfinished channel is delivered",
            "sweepSilentHalts — default notification adapter > does not let existing intents with channel attempts starve a new halt out of the page cap"
          ]
        },
        "details": {
          "testRun": {
            "id": 22052398,
            "source": "mutation-probe",
            "status": "fail",
            "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T19:15:00.141Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
            "mutationPhase": "mutant",
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "AUTO-BAR-R-26-P-007",
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
                "head": "f9439c620fe57d41387a5c7d2a9d13f83174a2fe",
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
        "observedAt": "2026-10-25T19:16:09.119Z",
        "bindingFingerprint": "5e67d24e5a3789460a7517c4c14920bef5230755b150bdf289de886d43f60db5",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T19:17:09.812Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "991d393c00601858b20e9a82901720f717b48526",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-26-P-007",
            "specRevision": 2,
            "specFingerprint": "a1495e307cdb9593848fea8d31b2343beeb93d24a884565f40c72f2a4f8649b7",
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 22052398 mutation-probe mutant fail packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts @0f9e16607008",
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
        "id": 70406,
        "workItemId": "WI-10008158",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-26-P-007",
        "sourceValId": null,
        "specRevision": 1,
        "currentRevision": 2,
        "specFingerprint": "8c832b66c19b96c9df03f62408a791b1154096d43b7f4931a3f617f70cd397ce",
        "evidenceKind": "mutation",
        "evidenceRef": "test-run 22052398 mutation-probe mutant fail packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts @0f9e16607008",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:c62dd1bd8b2cb119ea76b1da08ff4aae2e40c6f1f4f216b7f42d37679c2a34d3",
          "testFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
          "fixtureFingerprint": "sha256-file-set-v1:f5e0ac05769ade4b0cf8dfdc43dc67ad22d36d269b4e031af95e33a95d4aa8d1",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22052398,
        "testRunExecution": {
          "status": "fail",
          "passed": 60,
          "failed": 5,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "passedCaseTitles": [],
          "testLayer": "unit",
          "passedCaseTitleCount": 60,
          "passedCaseTitlesOmitted": 60,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22052398
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
            "mutantDiff": "--- a/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n+++ b/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n@@ -1048,7 +1048,7 @@\n       const existingIntent = typeof outcome === 'object' && outcome !== null && (\n         outcome.intentCreated === false || (outcome.intentCreated == null && outcome.deduped === true)\n       );\n-      if (existingIntent) continue;\n+      if (false) continue;\n       newPages++;\n       // D-006 (3): the fleet's leader can re-place the held work; the owner page alone leaves a\n       // fleet member's lane frozen until a human reads it. Same epoch dedupe as the page.\n",
            "subjectPath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
            "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
            "mutateExpression": "s/if \\(existingIntent\\) continue;/if (false) continue;/",
            "probeInvocationId": "04ed26c6-3756-4b27-b9aa-454f20347171",
            "testCommandSha256": "39bf5a4004de1df81c250b8a7feb486cec3a13475cb35fd6400cfc6b08b47f0a",
            "subjectAfterSha256": "0e9956e89888dbfaf0fa8ab795b80000c14089f99ca24680781c3dcdd3f5fc47",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0"
          },
          "mutationBaseline": {
            "testRunId": 22052395,
            "status": "pass",
            "mutation": {
              "leg": "copy-baseline",
              "mode": "copy-out",
              "mutantDiff": "--- a/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n+++ b/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n@@ -1048,7 +1048,7 @@\n       const existingIntent = typeof outcome === 'object' && outcome !== null && (\n         outcome.intentCreated === false || (outcome.intentCreated == null && outcome.deduped === true)\n       );\n-      if (existingIntent) continue;\n+      if (false) continue;\n       newPages++;\n       // D-006 (3): the fleet's leader can re-place the held work; the owner page alone leaves a\n       // fleet member's lane frozen until a human reads it. Same epoch dedupe as the page.\n",
              "subjectPath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
              "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
              "againstCommit": null,
              "schemaVersion": 1,
              "testFileSha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
              "mutateExpression": "s/if \\(existingIntent\\) continue;/if (false) continue;/",
              "probeInvocationId": "04ed26c6-3756-4b27-b9aa-454f20347171",
              "testCommandSha256": "39bf5a4004de1df81c250b8a7feb486cec3a13475cb35fd6400cfc6b08b47f0a",
              "subjectAfterSha256": "0e9956e89888dbfaf0fa8ab795b80000c14089f99ca24680781c3dcdd3f5fc47",
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
            "sweepSilentHalts — P-007 slice 2 (D-006) > a DEDUPED page does not consume the per-sweep cap, so standing halts cannot starve a new one: (recorded failed assertion)",
            "sweepSilentHalts — P-007 slice 2 (D-006) > a fleet member's NEW page also alerts its fleet leader, once; a deduped page does not: (recorded failed assertion)",
            "sweepSilentHalts — default notification adapter > alerts once for the same owner and epoch, then alerts again for a new epoch: (recorded failed assertion)",
            "sweepSilentHalts — default notification adapter > does not re-alert for an existing intent even when an unfinished channel is delivered: (recorded failed assertion)",
            "sweepSilentHalts — default notification adapter > does not let existing intents with channel attempts starve a new halt out of the page cap: (recorded failed assertion)"
          ],
          "mutationFailedCaseTitles": [
            "sweepSilentHalts — P-007 slice 2 (D-006) > a DEDUPED page does not consume the per-sweep cap, so standing halts cannot starve a new one",
            "sweepSilentHalts — P-007 slice 2 (D-006) > a fleet member's NEW page also alerts its fleet leader, once; a deduped page does not",
            "sweepSilentHalts — default notification adapter > alerts once for the same owner and epoch, then alerts again for a new epoch",
            "sweepSilentHalts — default notification adapter > does not re-alert for an existing intent even when an unfinished channel is delivered",
            "sweepSilentHalts — default notification adapter > does not let existing intents with channel attempts starve a new halt out of the page cap"
          ]
        },
        "details": {
          "testRun": {
            "id": 22052398,
            "source": "mutation-probe",
            "status": "fail",
            "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T19:15:00.141Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
            "mutationPhase": "mutant",
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "AUTO-BAR-R-26-P-007",
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
                "head": "f9439c620fe57d41387a5c7d2a9d13f83174a2fe",
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
        "observedAt": "2026-10-25T19:16:09.119Z",
        "bindingFingerprint": "5a632d0199219bb7020f9bd972d62b42214fe9ca22ca4bc1f0b54e397cb10e7b",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T19:16:09.112Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "991d393c00601858b20e9a82901720f717b48526",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-26-P-007",
            "specRevision": 1,
            "specFingerprint": "8c832b66c19b96c9df03f62408a791b1154096d43b7f4931a3f617f70cd397ce",
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 22052398 mutation-probe mutant fail packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts @0f9e16607008",
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
        "id": 70407,
        "workItemId": "WI-10008158",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-26-P-007",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "a1495e307cdb9593848fea8d31b2343beeb93d24a884565f40c72f2a4f8649b7",
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
        "testRunId": 22052388,
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
                22052388
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "baseline",
          "mutation": {
            "leg": "baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n+++ b/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n@@ -1048,7 +1048,7 @@\n       const existingIntent = typeof outcome === 'object' && outcome !== null && (\n         outcome.intentCreated === false || (outcome.intentCreated == null && outcome.deduped === true)\n       );\n-      if (existingIntent) continue;\n+      if (false) continue;\n       newPages++;\n       // D-006 (3): the fleet's leader can re-place the held work; the owner page alone leaves a\n       // fleet member's lane frozen until a human reads it. Same epoch dedupe as the page.\n",
            "subjectPath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
            "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
            "mutateExpression": "s/if \\(existingIntent\\) continue;/if (false) continue;/",
            "probeInvocationId": "04ed26c6-3756-4b27-b9aa-454f20347171",
            "testCommandSha256": "39bf5a4004de1df81c250b8a7feb486cec3a13475cb35fd6400cfc6b08b47f0a",
            "subjectAfterSha256": "0e9956e89888dbfaf0fa8ab795b80000c14089f99ca24680781c3dcdd3f5fc47",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0"
          },
          "mutationBaseline": null,
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 22052388,
            "source": "mutation-probe",
            "status": "pass",
            "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T19:13:42.488Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
            "mutationPhase": "baseline",
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
                "head": "f9439c620fe57d41387a5c7d2a9d13f83174a2fe",
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
        "observedAt": "2026-10-25T19:16:08.949Z",
        "bindingFingerprint": "f1325feed8890dcac5b97c627bbc36464ed00449c720dca2b7ebee31090489d4",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T19:17:09.812Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "991d393c00601858b20e9a82901720f717b48526",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-26-P-007",
            "specRevision": 2,
            "specFingerprint": "a1495e307cdb9593848fea8d31b2343beeb93d24a884565f40c72f2a4f8649b7",
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
        "id": 70405,
        "workItemId": "WI-10008158",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-26-P-007",
        "sourceValId": null,
        "specRevision": 1,
        "currentRevision": 2,
        "specFingerprint": "8c832b66c19b96c9df03f62408a791b1154096d43b7f4931a3f617f70cd397ce",
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
        "testRunId": 22052388,
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
                22052388
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "baseline",
          "mutation": {
            "leg": "baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n+++ b/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n@@ -1048,7 +1048,7 @@\n       const existingIntent = typeof outcome === 'object' && outcome !== null && (\n         outcome.intentCreated === false || (outcome.intentCreated == null && outcome.deduped === true)\n       );\n-      if (existingIntent) continue;\n+      if (false) continue;\n       newPages++;\n       // D-006 (3): the fleet's leader can re-place the held work; the owner page alone leaves a\n       // fleet member's lane frozen until a human reads it. Same epoch dedupe as the page.\n",
            "subjectPath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
            "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
            "mutateExpression": "s/if \\(existingIntent\\) continue;/if (false) continue;/",
            "probeInvocationId": "04ed26c6-3756-4b27-b9aa-454f20347171",
            "testCommandSha256": "39bf5a4004de1df81c250b8a7feb486cec3a13475cb35fd6400cfc6b08b47f0a",
            "subjectAfterSha256": "0e9956e89888dbfaf0fa8ab795b80000c14089f99ca24680781c3dcdd3f5fc47",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0"
          },
          "mutationBaseline": null,
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 22052388,
            "source": "mutation-probe",
            "status": "pass",
            "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T19:13:42.488Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
            "mutationPhase": "baseline",
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
                "head": "f9439c620fe57d41387a5c7d2a9d13f83174a2fe",
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
        "observedAt": "2026-10-25T19:16:08.949Z",
        "bindingFingerprint": "375a8359a0a996b72cde3899a4425d088097dc30edcb66181d6503ceed63ddcd",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T19:16:08.937Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "991d393c00601858b20e9a82901720f717b48526",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-26-P-007",
            "specRevision": 1,
            "specFingerprint": "8c832b66c19b96c9df03f62408a791b1154096d43b7f4931a3f617f70cd397ce",
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
      }
    ],
    "count": 4,
    "currentness": {
      "current": 2,
      "stale": 2,
      "unknown": 0
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
  "proof": {
    "ok": true,
    "dryRun": false,
    "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
    "evaluatorBuild": {
      "sha": "f9439c620f",
      "version": "0.0.0"
    },
    "classRef": "plan-class-bugfix",
    "governing": true,
    "counts": {
      "clauses": 1,
      "passing": 1,
      "filed": 0,
      "unchanged": 0,
      "refused": 0,
      "notPassing": 0,
      "mechanicallyVerified": 1
    },
    "clauses": [
      {
        "specId": "AUTO-BAR-R-26-P-007",
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
              "bindingId": 70407,
              "evidenceKind": "test",
              "evidenceRef": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
              "status": "measured",
              "measuredAtCommit": "991d393c00601858b20e9a82901720f717b48526",
              "measurementFingerprint": "sha256:2dad283527d048f7ce4c56e15564947fa621891c819de2f156b4ab766c5016bb"
            },
            {
              "bindingId": 70408,
              "evidenceKind": "mutation",
              "evidenceRef": "test-run 22052398 mutation-probe mutant fail packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts @0f9e16607008",
              "status": "measured",
              "measuredAtCommit": "991d393c00601858b20e9a82901720f717b48526",
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
            "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts": 70407
          },
          "caughtMutantBindingIds": [
            70408
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
  "runs": {
    "count": 3,
    "total": 3,
    "truncatedByLimit": false,
    "latestPerFile": false,
    "effectiveSourceFilter": "none (exact testRunIds receipt lookup)",
    "omittedBySourceFilter": 0,
    "runs": [
      {
        "id": 22052398,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
          "failed": 5,
          "passed": 60,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n+++ b/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n@@ -1048,7 +1048,7 @@\n       const existingIntent = typeof outcome === 'object' && outcome !== null && (\n         outcome.intentCreated === false || (outcome.intentCreated == null && outcome.deduped === true)\n       );\n-      if (existingIntent) continue;\n+      if (false) continue;\n       newPages++;\n       // D-006 (3): the fleet's leader can re-place the held work; the owner page alone leaves a\n       // fleet member's lane frozen until a human reads it. Same epoch dedupe as the page.\n",
            "subjectPath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
            "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
            "mutateExpression": "s/if \\(existingIntent\\) continue;/if (false) continue;/",
            "probeInvocationId": "04ed26c6-3756-4b27-b9aa-454f20347171",
            "testCommandSha256": "39bf5a4004de1df81c250b8a7feb486cec3a13475cb35fd6400cfc6b08b47f0a",
            "subjectAfterSha256": "0e9956e89888dbfaf0fa8ab795b80000c14089f99ca24680781c3dcdd3f5fc47",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0"
          },
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-25T19:14:37.943Z",
          "mutationPhase": "mutant",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "failedCaseTitles": [
            "sweepSilentHalts — P-007 slice 2 (D-006) > a DEDUPED page does not consume the per-sweep cap, so standing halts cannot starve a new one",
            "sweepSilentHalts — P-007 slice 2 (D-006) > a fleet member's NEW page also alerts its fleet leader, once; a deduped page does not",
            "sweepSilentHalts — default notification adapter > alerts once for the same owner and epoch, then alerts again for a new epoch",
            "sweepSilentHalts — default notification adapter > does not re-alert for an existing intent even when an unfinished channel is delivered",
            "sweepSilentHalts — default notification adapter > does not let existing intents with channel attempts starve a new halt out of the page cap"
          ],
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
            "sweepSilentHalts — P-007 slice 2 (D-006) > the cap still bounds NEWLY created pages",
            "sweepSilentHalts — P-007 slice 2 (D-006) > a non-fleet session is paged without any fleet-leader alert",
            "sweepSilentHalts — default notification adapter > preserves fail-soft delivery and leader alerting when intent storage is unavailable",
            "countPendingWakeSources — the seam to wake-source-predicate > counts none of the four dead shapes, so a stranded session reads as having no wake source",
            "countPendingWakeSources — the seam to wake-source-predicate > still counts an UNTIMED live watch (D-009: this detector stays lenient) and a bounded inbox await",
            "countPendingWakeSources — the seam to wake-source-predicate > does not query work_items when no candidate has an open await"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
        "status": "fail",
        "framework": "vitest",
        "startedAt": "2026-10-25T19:14:57.487Z",
        "finishedAt": "2026-10-25T19:15:00.141Z",
        "durationMs": 2654,
        "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": "sweepSilentHalts — P-007 slice 2 (D-006) > a DEDUPED page does not consume the per-sweep cap, so standing halts cannot starve a new one: expected [ 'a', 'b', 'c', 'd', 'e' ] to deeply equal [ 'a', 'b', 'c', 'd', 'e', 'f', 'g' ]\nactual: [\n  \"a\",\n  \"b\",\n  \"c\",\n  \"d\",\n  \"e\",\n]\nexpected: [\n  \"a\",\n  \"b\",\n  \"c\",\n  \"d\",\n  \"e\",\n  \"f\",\n  \"g\",\n]\nsweepSilentHalts — P-007 slice 2 (D-006) > a fleet member's NEW page also alerts its fleet leader, once; a deduped page does not: expected [ 'su-halted' ] to deeply equal []\nactual: [\n  \"su-halted\",\n]\nexpected: []\nsweepSilentHalts — default notification adapter > alerts once for the same owner and epoch, then alerts again for a new epoch: expected [ 'su-halted' ] to deeply equal []\nactual: [\n  \"su-halted\",\n]\nexpected: []\nsweepSilentHalts — default notificati",
        "loopLagP95Ms": null,
        "rssMb": 719.8,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "evaluateSilentHalt > flags the real thing: alive process, autonomy posture, loop off, no await, no recent turn",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > INCIDENT ANCHOR (2026-09-01) — a session with NO presence row is GONE, not halted",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > BOUNDARY (unguarded-halt-rescue) — a load-0 halt is NOT ours; that module wakes it",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > held work is what JUSTIFIES the page — the strand is real either way",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > active typed external-blocker holds alone do not justify a silent-halt page (D-010/P-010)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > a blocker park with NO re-check time names no wake: a WAKE-ONLY halt (WI-6554700010018551)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > a wake-only park still respects every earlier exemption and both clocks",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > actionable held work keeps the PAGEABLE verdict even beside an unbounded park",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > still pages on actionable held work and names coexisting blocker-parked IDs",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > a stale heartbeat means the process is gone, not halted",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > a pending await IS a wake source — the 67 -> 3 collapse",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > an ARMED loop belongs to stalled-loops-guard, never this module",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > a session with no autonomy posture has a human in front of it",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > does not page a loop disarmed seconds ago — most disarms self-heal",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > does not page an agent that produced a turn inside the floor",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > fails quiet when nothing establishes DURATION (no turn ever, no disarm timestamp)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > still flags a halt when the agent never produced a turn but the disarm clock is old",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > scales the staleness floor with the loop interval, never below the 30m floor",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "silent-halt wake guidance > checks checkpoint gates before resuming or releasing held work",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > pages the OWNER once for a halted session, with a dedupeKey",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 3,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > keys the dedupeKey to the DISARM EPOCH, so a still-halted session never re-pages",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > a re-armed loop between the two round-trips is NOT paged",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > names an exemption for every spared candidate — a mute sweep is unexplainable",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > dry_run detects without paging",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > caps pages on a mass halt — a cluster is ONE incident, not N",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > a downed push transport does not throw away the remaining pages, and says so",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > an empty candidate set does no status read and pages nobody",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > survives a failed loop-status read by sweeping without turn evidence",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2596,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > first tick: WAKES the halted holder instead of paging — marker written before the wake fires",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > second tick: a marker for the SAME disarm epoch pages with the wake evidence",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > a marker from an OLDER disarm epoch does not spend the new epoch's wake",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > wakes the holder with name-your-wake guidance and raises no owner-facing condition",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > a spent wake for this epoch is never followed by a page",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > with the wake rung off, or a host that needs a relaunch, it still never pages",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > actionable strands are woken first under the cap, and only they reach the owner condition",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > wake produced a turn but the session re-halted in the SAME epoch: the page says so",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > caps the wake fan and DEFERS the overflow — it never falls through to the page",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > marker-READ failure falls back to page-only (never a re-wake storm), and says so",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > marker-WRITE failure skips the wake AND the page — the next tick retries the wake",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > flag OFF: pages immediately with no wake attempt — the pre-P-003 behavior, exactly",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > a parked fleet's member is woken WITH its way back — the park contract, verbatim",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > FRAMING, not gating (D-005): a holder the classifier calls 'deliberate' is still WOKEN, and its page names that verdict",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > the candidate read does NOT count the session's own inbox-wake watcher as a wake source",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a dead work-item await does not exempt the session either (D-008 (1), via the shared predicate)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a live untimed await still exempts the session (D-009: the detector stays lenient)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'blocked' work with a 'active' blocker",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'needs-human' work with a 'active' blocker",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'needs-human' work with a 'cleared' blocker",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'wip' work with a 'active' blocker",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'no recheckAt (a pre-default legacy ro…' names no wake: halted as WAKE-ONLY, not exempt",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'an unparseable recheckAt' names no wake: halted as WAKE-ONLY, not exempt",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a host that needs a relaunch is NOT woken; it is paged at once with the HOST UNHEALTHY remedy",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a healthy, recoverable, or unreadable host keeps the wake-first rung exactly as before",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a host read that THROWS degrades to the wake-first rung, never to silence",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a DEDUPED page does not consume the per-sweep cap, so standing halts cannot starve a new one",
            "occurrence": 1,
            "status": "fail",
            "durationMs": 5,
            "errorTail": "expected [ 'a', 'b', 'c', 'd', 'e' ] to deeply equal [ 'a', 'b', 'c', 'd', 'e', 'f', 'g' ]\nactual: [\n  \"a\",\n  \"b\",\n  \"c\",\n  \"d\",\n  \"e\",\n]\nexpected: [\n  \"a\",\n  \"b\",\n  \"c\",\n  \"d\",\n  \"e\",\n  \"f\",\n  \"g\",\n]"
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > the cap still bounds NEWLY created pages",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a fleet member's NEW page also alerts its fleet leader, once; a deduped page does not",
            "occurrence": 1,
            "status": "fail",
            "durationMs": 2,
            "errorTail": "expected [ 'su-halted' ] to deeply equal []\nactual: [\n  \"su-halted\",\n]\nexpected: []"
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a non-fleet session is paged without any fleet-leader alert",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — default notification adapter > alerts once for the same owner and epoch, then alerts again for a new epoch",
            "occurrence": 1,
            "status": "fail",
            "durationMs": 2,
            "errorTail": "expected [ 'su-halted' ] to deeply equal []\nactual: [\n  \"su-halted\",\n]\nexpected: []"
          },
          {
            "caseKey": "sweepSilentHalts — default notification adapter > does not re-alert for an existing intent even when an unfinished channel is delivered",
            "occurrence": 1,
            "status": "fail",
            "durationMs": 1,
            "errorTail": "expected [ 'su-halted' ] to deeply equal []\nactual: [\n  \"su-halted\",\n]\nexpected: []"
          },
          {
            "caseKey": "sweepSilentHalts — default notification adapter > does not let existing intents with channel attempts starve a new halt out of the page cap",
            "occurrence": 1,
            "status": "fail",
            "durationMs": 2,
            "errorTail": "expected [ 'a', 'b', 'c', 'd', 'e' ] to deeply equal [ 'a', 'b', 'c', 'd', 'e', 'f', 'g' ]\nactual: [\n  \"a\",\n  \"b\",\n  \"c\",\n  \"d\",\n  \"e\",\n]\nexpected: [\n  \"a\",\n  \"b\",\n  \"c\",\n  \"d\",\n  \"e\",\n  \"f\",\n  \"g\",\n]"
          },
          {
            "caseKey": "sweepSilentHalts — default notification adapter > preserves fail-soft delivery and leader alerting when intent storage is unavailable",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "countPendingWakeSources — the seam to wake-source-predicate > counts none of the four dead shapes, so a stranded session reads as having no wake source",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "countPendingWakeSources — the seam to wake-source-predicate > still counts an UNTIMED live watch (D-009: this detector stays lenient) and a bounded inbox await",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "countPendingWakeSources — the seam to wake-source-predicate > does not query work_items when no candidate has an open await",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          }
        ]
      },
      {
        "id": 22052395,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
          "failed": 0,
          "passed": 65,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "mutation": {
            "leg": "copy-baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n+++ b/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n@@ -1048,7 +1048,7 @@\n       const existingIntent = typeof outcome === 'object' && outcome !== null && (\n         outcome.intentCreated === false || (outcome.intentCreated == null && outcome.deduped === true)\n       );\n-      if (existingIntent) continue;\n+      if (false) continue;\n       newPages++;\n       // D-006 (3): the fleet's leader can re-place the held work; the owner page alone leaves a\n       // fleet member's lane frozen until a human reads it. Same epoch dedupe as the page.\n",
            "subjectPath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
            "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
            "mutateExpression": "s/if \\(existingIntent\\) continue;/if (false) continue;/",
            "probeInvocationId": "04ed26c6-3756-4b27-b9aa-454f20347171",
            "testCommandSha256": "39bf5a4004de1df81c250b8a7feb486cec3a13475cb35fd6400cfc6b08b47f0a",
            "subjectAfterSha256": "0e9956e89888dbfaf0fa8ab795b80000c14089f99ca24680781c3dcdd3f5fc47",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0"
          },
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-25T19:13:57.482Z",
          "mutationPhase": "copy-baseline",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
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
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
        "status": "pass",
        "framework": "vitest",
        "startedAt": "2026-10-25T19:14:18.488Z",
        "finishedAt": "2026-10-25T19:14:21.866Z",
        "durationMs": 3378,
        "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": 730.3,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "evaluateSilentHalt > flags the real thing: alive process, autonomy posture, loop off, no await, no recent turn",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 3,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > INCIDENT ANCHOR (2026-09-01) — a session with NO presence row is GONE, not halted",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > BOUNDARY (unguarded-halt-rescue) — a load-0 halt is NOT ours; that module wakes it",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > held work is what JUSTIFIES the page — the strand is real either way",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > active typed external-blocker holds alone do not justify a silent-halt page (D-010/P-010)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > a blocker park with NO re-check time names no wake: a WAKE-ONLY halt (WI-6554700010018551)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > a wake-only park still respects every earlier exemption and both clocks",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > actionable held work keeps the PAGEABLE verdict even beside an unbounded park",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > still pages on actionable held work and names coexisting blocker-parked IDs",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > a stale heartbeat means the process is gone, not halted",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > a pending await IS a wake source — the 67 -> 3 collapse",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > an ARMED loop belongs to stalled-loops-guard, never this module",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > a session with no autonomy posture has a human in front of it",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > does not page a loop disarmed seconds ago — most disarms self-heal",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > does not page an agent that produced a turn inside the floor",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > fails quiet when nothing establishes DURATION (no turn ever, no disarm timestamp)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > still flags a halt when the agent never produced a turn but the disarm clock is old",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > scales the staleness floor with the loop interval, never below the 30m floor",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "silent-halt wake guidance > checks checkpoint gates before resuming or releasing held work",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > pages the OWNER once for a halted session, with a dedupeKey",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 4,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > keys the dedupeKey to the DISARM EPOCH, so a still-halted session never re-pages",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > a re-armed loop between the two round-trips is NOT paged",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > names an exemption for every spared candidate — a mute sweep is unexplainable",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > dry_run detects without paging",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > caps pages on a mass halt — a cluster is ONE incident, not N",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > a downed push transport does not throw away the remaining pages, and says so",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 3,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > an empty candidate set does no status read and pages nobody",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > survives a failed loop-status read by sweeping without turn evidence",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 3327,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > first tick: WAKES the halted holder instead of paging — marker written before the wake fires",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > second tick: a marker for the SAME disarm epoch pages with the wake evidence",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > a marker from an OLDER disarm epoch does not spend the new epoch's wake",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > wakes the holder with name-your-wake guidance and raises no owner-facing condition",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > a spent wake for this epoch is never followed by a page",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > with the wake rung off, or a host that needs a relaunch, it still never pages",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > actionable strands are woken first under the cap, and only they reach the owner condition",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > wake produced a turn but the session re-halted in the SAME epoch: the page says so",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > caps the wake fan and DEFERS the overflow — it never falls through to the page",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > marker-READ failure falls back to page-only (never a re-wake storm), and says so",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > marker-WRITE failure skips the wake AND the page — the next tick retries the wake",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > flag OFF: pages immediately with no wake attempt — the pre-P-003 behavior, exactly",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > a parked fleet's member is woken WITH its way back — the park contract, verbatim",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > FRAMING, not gating (D-005): a holder the classifier calls 'deliberate' is still WOKEN, and its page names that verdict",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > the candidate read does NOT count the session's own inbox-wake watcher as a wake source",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a dead work-item await does not exempt the session either (D-008 (1), via the shared predicate)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a live untimed await still exempts the session (D-009: the detector stays lenient)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'blocked' work with a 'active' blocker",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'needs-human' work with a 'active' blocker",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'needs-human' work with a 'cleared' blocker",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'wip' work with a 'active' blocker",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'no recheckAt (a pre-default legacy ro…' names no wake: halted as WAKE-ONLY, not exempt",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'an unparseable recheckAt' names no wake: halted as WAKE-ONLY, not exempt",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a host that needs a relaunch is NOT woken; it is paged at once with the HOST UNHEALTHY remedy",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a healthy, recoverable, or unreadable host keeps the wake-first rung exactly as before",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a host read that THROWS degrades to the wake-first rung, never to silence",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a DEDUPED page does not consume the per-sweep cap, so standing halts cannot starve a new one",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > the cap still bounds NEWLY created pages",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a fleet member's NEW page also alerts its fleet leader, once; a deduped page does not",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a non-fleet session is paged without any fleet-leader alert",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — default notification adapter > alerts once for the same owner and epoch, then alerts again for a new epoch",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — default notification adapter > does not re-alert for an existing intent even when an unfinished channel is delivered",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — default notification adapter > does not let existing intents with channel attempts starve a new halt out of the page cap",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — default notification adapter > preserves fail-soft delivery and leader alerting when intent storage is unavailable",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "countPendingWakeSources — the seam to wake-source-predicate > counts none of the four dead shapes, so a stranded session reads as having no wake source",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "countPendingWakeSources — the seam to wake-source-predicate > still counts an UNTIMED live watch (D-009: this detector stays lenient) and a bounded inbox await",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "countPendingWakeSources — the seam to wake-source-predicate > does not query work_items when no candidate has an open await",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          }
        ]
      },
      {
        "id": 22052388,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
          "failed": 0,
          "passed": 65,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
          "mutation": {
            "leg": "baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n+++ b/packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts\n@@ -1048,7 +1048,7 @@\n       const existingIntent = typeof outcome === 'object' && outcome !== null && (\n         outcome.intentCreated === false || (outcome.intentCreated == null && outcome.deduped === true)\n       );\n-      if (existingIntent) continue;\n+      if (false) continue;\n       newPages++;\n       // D-006 (3): the fleet's leader can re-place the held work; the owner page alone leaves a\n       // fleet member's lane frozen until a human reads it. Same epoch dedupe as the page.\n",
            "subjectPath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
            "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "2b99e057d767c9dfa43bd59d0185ef5a4a51a8de4c0bd02b7b258dd2ccf6fc21",
            "mutateExpression": "s/if \\(existingIntent\\) continue;/if (false) continue;/",
            "probeInvocationId": "04ed26c6-3756-4b27-b9aa-454f20347171",
            "testCommandSha256": "39bf5a4004de1df81c250b8a7feb486cec3a13475cb35fd6400cfc6b08b47f0a",
            "subjectAfterSha256": "0e9956e89888dbfaf0fa8ab795b80000c14089f99ca24680781c3dcdd3f5fc47",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "88377f9b24222697cd5379015ce04bb1c6ca3ac4796cff81d24ff77c0b82b2e0"
          },
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-25T19:13:21.360Z",
          "mutationPhase": "baseline",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
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
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
        "status": "pass",
        "framework": "vitest",
        "startedAt": "2026-10-25T19:13:39.229Z",
        "finishedAt": "2026-10-25T19:13:42.488Z",
        "durationMs": 3259,
        "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": 670.1,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "evaluateSilentHalt > flags the real thing: alive process, autonomy posture, loop off, no await, no recent turn",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > INCIDENT ANCHOR (2026-09-01) — a session with NO presence row is GONE, not halted",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > BOUNDARY (unguarded-halt-rescue) — a load-0 halt is NOT ours; that module wakes it",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > held work is what JUSTIFIES the page — the strand is real either way",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > active typed external-blocker holds alone do not justify a silent-halt page (D-010/P-010)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > a blocker park with NO re-check time names no wake: a WAKE-ONLY halt (WI-6554700010018551)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > a wake-only park still respects every earlier exemption and both clocks",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > actionable held work keeps the PAGEABLE verdict even beside an unbounded park",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > still pages on actionable held work and names coexisting blocker-parked IDs",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > a stale heartbeat means the process is gone, not halted",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > a pending await IS a wake source — the 67 -> 3 collapse",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > an ARMED loop belongs to stalled-loops-guard, never this module",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > a session with no autonomy posture has a human in front of it",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > does not page a loop disarmed seconds ago — most disarms self-heal",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > does not page an agent that produced a turn inside the floor",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > fails quiet when nothing establishes DURATION (no turn ever, no disarm timestamp)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > still flags a halt when the agent never produced a turn but the disarm clock is old",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "evaluateSilentHalt > scales the staleness floor with the loop interval, never below the 30m floor",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "silent-halt wake guidance > checks checkpoint gates before resuming or releasing held work",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > pages the OWNER once for a halted session, with a dedupeKey",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > keys the dedupeKey to the DISARM EPOCH, so a still-halted session never re-pages",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > a re-armed loop between the two round-trips is NOT paged",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > names an exemption for every spared candidate — a mute sweep is unexplainable",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > dry_run detects without paging",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > caps pages on a mass halt — a cluster is ONE incident, not N",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > a downed push transport does not throw away the remaining pages, and says so",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 3,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > an empty candidate set does no status read and pages nobody",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts > survives a failed loop-status read by sweeping without turn evidence",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 3216,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > first tick: WAKES the halted holder instead of paging — marker written before the wake fires",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > second tick: a marker for the SAME disarm epoch pages with the wake evidence",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > a marker from an OLDER disarm epoch does not spend the new epoch's wake",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > wakes the holder with name-your-wake guidance and raises no owner-facing condition",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > a spent wake for this epoch is never followed by a page",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > with the wake rung off, or a host that needs a relaunch, it still never pages",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551) > actionable strands are woken first under the cap, and only they reach the owner condition",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > wake produced a turn but the session re-halted in the SAME epoch: the page says so",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > caps the wake fan and DEFERS the overflow — it never falls through to the page",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > marker-READ failure falls back to page-only (never a re-wake storm), and says so",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > marker-WRITE failure skips the wake AND the page — the next tick retries the wake",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > flag OFF: pages immediately with no wake attempt — the pre-P-003 behavior, exactly",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > a parked fleet's member is woken WITH its way back — the park contract, verbatim",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — wake-first rung (P-003) > FRAMING, not gating (D-005): a holder the classifier calls 'deliberate' is still WOKEN, and its page names that verdict",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > the candidate read does NOT count the session's own inbox-wake watcher as a wake source",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a dead work-item await does not exempt the session either (D-008 (1), via the shared predicate)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a live untimed await still exempts the session (D-009: the detector stays lenient)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'blocked' work with a 'active' blocker",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'needs-human' work with a 'active' blocker",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'needs-human' work with a 'cleared' blocker",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > applies D-010/P-010 to 'wip' work with a 'active' blocker",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'no recheckAt (a pre-default legacy ro…' names no wake: halted as WAKE-ONLY, not exempt",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a blocker park with 'an unparseable recheckAt' names no wake: halted as WAKE-ONLY, not exempt",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a host that needs a relaunch is NOT woken; it is paged at once with the HOST UNHEALTHY remedy",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a healthy, recoverable, or unreadable host keeps the wake-first rung exactly as before",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a host read that THROWS degrades to the wake-first rung, never to silence",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a DEDUPED page does not consume the per-sweep cap, so standing halts cannot starve a new one",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > the cap still bounds NEWLY created pages",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a fleet member's NEW page also alerts its fleet leader, once; a deduped page does not",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — P-007 slice 2 (D-006) > a non-fleet session is paged without any fleet-leader alert",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — default notification adapter > alerts once for the same owner and epoch, then alerts again for a new epoch",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — default notification adapter > does not re-alert for an existing intent even when an unfinished channel is delivered",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — default notification adapter > does not let existing intents with channel attempts starve a new halt out of the page cap",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "sweepSilentHalts — default notification adapter > preserves fail-soft delivery and leader alerting when intent storage is unavailable",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "countPendingWakeSources — the seam to wake-source-predicate > counts none of the four dead shapes, so a stranded session reads as having no wake source",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "countPendingWakeSources — the seam to wake-source-predicate > still counts an UNTIMED live watch (D-009: this detector stays lenient) and a bounded inbox await",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "countPendingWakeSources — the seam to wake-source-predicate > does not query work_items when no candidate has an open await",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
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
