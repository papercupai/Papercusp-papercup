---
rel_path: "reports/durable-parks/ubp-p028-exact-condition-EI-23890073128532843-20261008-proof.json"
updated_at: 1791484951516
_body: "content"
---

{
  "schemaVersion": "p028-exact-declared-condition-v1",
  "id": "EI-23890073128532843",
  "rootId": "WI-10002662",
  "verifiedAt": "2026-10-08T18:42:31.516Z",
  "positive": {
    "port": "5432",
    "positive": 1
  },
  "declaredReleaseContract": {
    "owner": "su-143d8d53-95ec-40df-988f-dfec83c2017f",
    "trigger": "work-item:done:WI-10002662",
    "evidence": "a live resolver or producer registration can still satisfy the condition",
    "condition": "The linked blocking work-item WI-10002662 reaches terminal state so this implementation can resume.",
    "reachability": "reachable"
  },
  "expectedParkFingerprint": "212f18c743862983a9602ecf8ad12ff153fce623a79c929a7d6ea97d52f3b9b2",
  "rootRead": {
    "id": "WI-10002662",
    "state": "done",
    "authority": "committed",
    "terminal_owner": "su-ff31b576-7af2-434c-bab5-68d373b724fe"
  },
  "verification": {
    "declaredCondition": "The linked blocking work-item WI-10002662 reaches terminal state so this implementation can resume.",
    "observation": "The only declared release predicate is linked blocker terminality; canonical root is DONE/committed. Its row remains share-locked throughout this reconciliation.",
    "boundary": "This proves that terminal-state release predicate, not the subject bug fixed or its implementation/current-source acceptance."
  },
  "cohortRef": "reports/durable-parks/ubp-p028-operational-20261008183436Z-dispositions.json",
  "sourcePayload": {
    "_ei": {
      "scope": "harness:papercusp",
      "source": "su",
      "severity": "major",
      "created_by": "su-4b6798f0-3919-46f5-bc72-79f139ed7d80",
      "signal_origin": "organic"
    },
    "_claimHold": true,
    "filedByRole": "su",
    "watchdogKey": "repeated-tool-error:events:cancel:structural:inherited-composed-root-was-not-cancellable",
    "claim_hold_at": "2026-09-23T09:46:44.184Z",
    "claim_hold_by": "su-143d8d53-95ec-40df-988f-dfec83c2017f",
    "dedupCoverage": {
      "lexical": "ok",
      "degraded": false,
      "semantic": "ok"
    },
    "ideaLifecycle": {
      "state": "open",
      "stateUpdatedAt": "2026-09-21T16:42:29.157Z"
    },
    "dedupCandidates": [
      {
        "id": "EI-21988588300241959",
        "method": "lexical",
        "similarity": 1
      }
    ],
    "externalBlockers": [
      {
        "ref": "locks:acquire workspace advisory-lock path",
        "kind": "runtime",
        "status": "cleared",
        "summary": "The required manual edit lock for loop/end.ts and loop/end.test.ts repeatedly fails before acquiring any file lock.",
        "evidence": "The scoped manual lock for loop/end.ts and loop/end.test.ts was acquired successfully at 2026-09-23T09:09Z and released after verification. The specific blocker no longer prevents this item from progressing. The reason earlier attempts returned workspace_contended remains unknown and is still tracked on WI-10002662.",
        "nextVerb": "locks:acquire",
        "clearedAt": "2026-09-23T09:22:39.932Z",
        "clearedBy": "su-143d8d53-95ec-40df-988f-dfec83c2017f",
        "createdAt": "2026-09-23T07:22:13.914Z",
        "createdBy": "su-143d8d53-95ec-40df-988f-dfec83c2017f",
        "updatedAt": "2026-09-23T09:22:39.932Z",
        "capability": "live-dependency",
        "capabilitySource": "explicit"
      }
    ],
    "admissionIdentity": {
      "titleKey": "title:already call cancel events failure found not settled tool yours",
      "signalKey": "repeated-tool-error:events:cancel:structural:inherited-composed-root-was-not-cancellable",
      "schemaVersion": "admission-identity-v1"
    },
    "claim_hold_reason": "Implementation and focused verification are complete, but linked WI-10002662 is still open and the dependency guard refuses a wip transition. Park this item until that blocker finishes.",
    "freshnessEnvelope": {
      "observedAt": "2026-09-21T16:42:29.157Z",
      "linkedFixRefs": [],
      "reporterSession": "su-4b6798f0-3919-46f5-bc72-79f139ed7d80",
      "observedSourceSha": "91a5dba579",
      "toolSchemaVersion": null,
      "observedRuntimeSha": "91a5dba579",
      "deployBuildIdentity": "91a5dba579@0.0.0",
      "reporterRuntimeVersion": "0.0.0",
      "lastSuccessfulReproductionAt": "2026-09-21T16:42:29.157Z"
    },
    "claim_hold_release": {
      "owner": "su-143d8d53-95ec-40df-988f-dfec83c2017f",
      "trigger": "work-item:done:WI-10002662",
      "evidence": "a live resolver or producer registration can still satisfy the condition",
      "condition": "The linked blocking work-item WI-10002662 reaches terminal state so this implementation can resume.",
      "reachability": "reachable"
    },
    "toolFailureProbation": {
      "class": "structural",
      "state": "promoted",
      "report": {
        "message": "Inherited composed-root:406 was not cancellable from this session; loop:end reported it as surviving but events:cancel root_id 406 found no owned active tree.",
        "toolName": "events:cancel",
        "errorCode": "not_found_or_not_yours_or_already_settled",
        "reproduced": true,
        "directEvidence": {
          "kind": "valid-input-reproduction",
          "actual": "root_id 406 returned not_found_or_not_yours_or_already_settled",
          "expected": "owned active root_id is cancellable"
        }
      },
      "classKey": "repeated-tool-error-class:events:cancel:structural:not_found_or_not_yours_or_already_settled:schema-unknown~field-unknown:runtime-unknown",
      "reporters": [
        "su-4b6798f0-3919-46f5-bc72-79f139ed7d80"
      ],
      "lastSeenAt": "2026-09-21T16:42:27.065Z",
      "firstSeenAt": "2026-09-21T16:42:27.065Z",
      "watchdogKey": "repeated-tool-error:events:cancel:structural:inherited-composed-root-was-not-cancellable",
      "intendedKind": "bug",
      "directEvidence": true,
      "deployedRevision": "runtime-unknown",
      "messageFingerprint": "inherited-composed-root-was-not-cancellable",
      "contractFingerprint": "schema-unknown~field-unknown",
      "correlationFingerprint": "events:cancel|not_found_or_not_yours_or_already_settled|schema-unknown|field-unknown|runtime-unknown|inherited-composed-root-was-not-cancellable"
    },
    "claim_history_post_id": 9001788375295,
    "implementationReadiness": {
      "reason": "existing-immediate-capture-policy",
      "source": "capture-policy",
      "status": "ready",
      "updatedAt": "2026-09-21T16:42:29.157Z",
      "schemaVersion": "implementation-readiness-v1"
    }
  }
}
