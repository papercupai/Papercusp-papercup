---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold35-original-budget-cutoff-assignment-witness-424d5.json"
updated_at: 1791915841850
_body: "content"
---

{
  "schemaVersion": "r13-cold35-cutoff-assignment-source-v1",
  "observedAt": "2026-10-13T18:23:13.779Z",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "subject": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "sourceRows": [
    {
      "harness_slug": "papercusp",
      "feature_id": "EI-25477838487191856",
      "origin": "local",
      "fed_ts": 1791720910898,
      "first_claimed_at": "2026-10-09 02:49:54.104205-04",
      "worked_by_history": [
        {
          "at": "2026-10-09T02:49:54.104369-04:00",
          "owner": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a"
        },
        {
          "at": "2026-10-10T12:28:22.000004-04:00",
          "owner": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a"
        },
        {
          "at": "2026-10-11T07:52:02.452988-04:00",
          "owner": "su-828322e7-3f12-42b6-9d24-8df0dfd8795f"
        },
        {
          "at": "2026-10-11T08:00:57.768559-04:00",
          "owner": "su-828322e7-3f12-42b6-9d24-8df0dfd8795f"
        }
      ]
    }
  ],
  "writers": [
    {
      "definition": "CREATE OR REPLACE FUNCTION harness_shared.record_work_item_worked_by_history()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nDECLARE\n  worker text;\nBEGIN\n  -- Remote rows are owned by their authoring peer. Their projected claim churn\n  -- must not become local prior-worker attribution on this node.\n  IF NEW.fed_ts IS DISTINCT FROM OLD.fed_ts\n     OR COALESCE(NEW.origin, 'local') = 'remote' THEN\n    RETURN NEW;\n  END IF;\n\n  -- UPDATE OF taken_by also fires for an idempotent same-holder claim; only a\n  -- real holder transition is a new piece of work history.\n  IF NEW.taken_by IS NOT DISTINCT FROM OLD.taken_by THEN\n    RETURN NEW;\n  END IF;\n\n  -- On claim use NEW.taken_by; on release NEW is NULL, so use OLD.taken_by.\n  -- Ignore the legacy unassigned sentinel rather than attributing work to it.\n  worker := NULLIF(btrim(COALESCE(NEW.taken_by, OLD.taken_by)), '');\n  IF worker IS NULL OR lower(worker) = 'unassigned' THEN\n    RETURN NEW;\n  END IF;\n\n  -- D-003: the immutable first-claim stamp, on the same real holder transition\n  -- this trigger already isolates.\n  --\n  -- Test NEW.taken_by directly rather than reusing `worker`: on a RELEASE the\n  -- transition is just as real and `worker` falls back to OLD.taken_by, but a\n  -- release is not a claim and must not stamp. COALESCE keeps the first value\n  -- forever, so a re-claim after release leaves the original stamp intact.\n  IF NULLIF(btrim(COALESCE(NEW.taken_by, '')), '') IS NOT NULL THEN\n    NEW.first_claimed_at := COALESCE(OLD.first_claimed_at, clock_timestamp());\n  END IF;\n\n  -- Keep the parser's durable shape small and stable. Existing malformed/null\n  -- values degrade to a fresh array rather than making the claim fail.\n  NEW.worked_by_history :=\n    CASE WHEN jsonb_typeof(NEW.worked_by_history) = 'array'\n      THEN NEW.worked_by_history\n      ELSE '[]'::jsonb\n    END\n    || jsonb_build_array(jsonb_build_object('owner', worker, 'at', clock_timestamp()));\n\n  RETURN NEW;\nEND;\n$function$\n"
    }
  ],
  "triggers": [
    {
      "tgname": "record_work_item_worked_by_history_trg",
      "definition": "CREATE TRIGGER record_work_item_worked_by_history_trg BEFORE UPDATE OF taken_by ON harness_shared.work_items FOR EACH ROW EXECUTE FUNCTION harness_shared.record_work_item_worked_by_history()"
    }
  ],
  "limits": [
    "Current item outcome fields deliberately omitted; no remediation outcome join",
    "worked_by_history entries alone have no claim/release direction",
    "First-claim stamp and original cutoff census provide independent assignment witnesses",
    "Original eligibility remains unfrozen until whole-work and control continuity are established"
  ],
  "sourceRefs": [
    {
      "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold34-original-budget-stop-source-witness-424d5.json",
      "sha256": "6c403069a82ba8ff6b1784de9549a3cd660ab3581f90376af67dfa615d31986d"
    },
    {
      "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold33-original116-eligibility-evidence-map-424d5.json",
      "sha256": "69fa71b2d06f7b2c3a1b160cf04cca91fa1369df767e5325b01f095acdf187ee"
    }
  ],
  "frozenCensus": {
    "path": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/park-audit/pres-full.json",
    "bytes": 1613397,
    "sha256": "633e47d809ba6f1b4b9c690c662a6b076b414c674ab465f65ee8fd7e56e1af27",
    "asOf": "2026-10-10T16:00:36.515Z",
    "exactOwner": {
      "ownerId": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a",
      "ownerLabel": "su · su-ec24b",
      "workspaceId": "papercusp-workspace",
      "source": "omp-hook-session",
      "host": "main-server-Precision-7865-Tower",
      "pid": 3883549,
      "startedAt": "2026-10-09 02:44:27.475118-04",
      "agentRole": "su",
      "potSlug": "papercusp",
      "fleetSlug": "nonp2p-bug-drain-luna-max-0930",
      "fleetRole": "member",
      "fleetControlState": "active",
      "canAcquireWork": true,
      "model": null,
      "userId": null,
      "federated": null,
      "devicePubkey": null,
      "harnessSlug": null,
      "intent": "[idle 1d7h] Resume EI-25477838487191856: verify current disk headroom/resource lock, then validate git-sync and staging proof.",
      "intentDeclaredAt": "2026-10-09 03:52:28.252228-04",
      "currentPlanSlug": null,
      "currentView": null,
      "currentFiles": [],
      "claimedItems": [],
      "claimCount": 1,
      "claimedPlanItemRefs": null,
      "awaitingEvent": true,
      "awaitingEventKey": "coord:inbox-wake:su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a",
      "awaitingNote": "loop-armed inbox-wake (loop-su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a)",
      "wakeMode": "auto",
      "revoked": false,
      "lastActiveSecAgo": 113933,
      "lastActiveSource": "presence",
      "intentStale": true,
      "intentAgeSec": 115688,
      "intentDivergent": true,
      "sessionState": "parked",
      "wakeable": true,
      "confirmLiveness": false,
      "loopArmed": false,
      "selfWake": "none",
      "dormantScheduled": null,
      "nextFireAt": null,
      "contextPressure": "ok",
      "contextPressureAgeSec": 17,
      "onDesktop": false,
      "viewerAttached": false,
      "coordHook": null,
      "coordLastReadAgoSec": null,
      "isSelf": null,
      "modes": [
        "auto"
      ],
      "parkedOn": null
    },
    "expandedShape": {
      "type": "array",
      "keys": []
    }
  },
  "budgetWitnessAssessment": {
    "budgetStop": "source-supported",
    "eligibilityStatus": "review-open",
    "reason": "Actual pre-cutoff disarm562822 records max-duration1218s>600s, original bounded arm34520480 and indexed final control prose retained. Final census has exactly one claim and an EI-naming intent, but its selected presence fields do not prove the exact held-item assignment or all independent work at cutoff.",
    "remaining": [
      "Exact final cutoff assigned-item custody",
      "Whole-scope reachable work and owner-stop/dependency reconciliation"
    ],
    "sourceSupportIsNotEligibilityFreeze": true,
    "outerInvocationStatusIsNotReceipt": true,
    "noOutcomesJoined": true
  },
  "cohortHash": "24ff6981fd54f120f96381dd93732ec9c1bfb2101d7eec063119bf85caeb163a",
  "assignmentAssessment": {
    "status": "source-supported-not-eligibility-freeze",
    "itemRef": "EI-25477838487191856",
    "firstClaimAtUTC": "2026-10-09T06:49:54.104205Z",
    "firstHistoryAtUTC": "2026-10-09T06:49:54.104369Z",
    "preCutoffHistoryRows": 1,
    "nextRecordedTransitionAtUTC": "2026-10-10T16:28:22.000004Z",
    "nextTransitionIsAfterCutoff": true,
    "reason": "First claim stamp is contemporaneous with the subject owner history entry. No intervening owner transition is recorded before the frozen cutoff, whose independent census reports one claim and names this item in intent. The deployed trigger records real local holder transitions and stamps only claims. History direction alone is not used as proof.",
    "limits": [
      "Current writer read is not itself a historical deployed-source pin",
      "Post-cutoff transition entries retained for assignment custody only; no outcome field or recovery outcome joined",
      "Whole-work reachability, owner-stop/dependency and control continuity remain unreviewed"
    ]
  },
  "summary": {
    "originalPopulation": 116,
    "membershipUnchanged": true,
    "preservedReceiptPopulation": 137,
    "preservedAcceptedReceipts": 113,
    "unresolvedReceipts": 24,
    "existingSourceSupportedEligible": 4,
    "existingSourceSupportedExcluded": 2,
    "newEligibilityAssessments": 0,
    "continuityAccepted": 0,
    "eligibilityAccepted": 0,
    "outcomesJoined": 0,
    "newAcquisitions": 0,
    "productTestsRerun": 0,
    "newAssignmentWitnesses": 1
  },
  "transport": {
    "successfulNarrowRead": "/tmp/parked-cold35-ec24-cutoff-assignment-writer-424d5.json",
    "failedBroadReadOutcome": "unknown; expected output file absent, not proof of source absence",
    "incidents": [
      "EI-24802357246708467",
      "EI-25327340966227321"
    ],
    "capture429": "trace1ad8c040-2b73-4f80-be87-32fc50207d3c not_forwarded; original repeated502 trace2a155cbf-a291-4f59-8df2-664526d95895 remains to capture"
  }
}
