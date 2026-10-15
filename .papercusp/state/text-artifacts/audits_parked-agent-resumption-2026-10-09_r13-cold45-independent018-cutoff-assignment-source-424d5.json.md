---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold45-independent018-cutoff-assignment-source-424d5.json"
updated_at: 1791957011993
_body: "content"
---

{
  "schemaVersion": "r13-cold45-independent018-cutoff-assignment-source-v1",
  "observedAt": "2026-10-14T05:50:11.942Z",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "subject": "su-01864986-d27d-497b-b501-7082b6e0caab",
  "route": "approved SELF/AUTO/P013/account/cold",
  "workItem": "WI-6554700010008887",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "cohortHash": "24ff6981fd54f120f96381dd93732ec9c1bfb2101d7eec063119bf85caeb163a",
  "sourceRefs": {
    "map": {
      "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold33-original116-eligibility-evidence-map-424d5.json",
      "chars": 285683,
      "updatedAt": 1791910595920
    },
    "candidates": {
      "ref": "audits/parked-agent-resumption-2026-10-09/r13-original116-candidates-fire15-v2-424d5.json",
      "chars": 154382,
      "updatedAt": 1791811064307
    },
    "routes": {
      "ref": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
      "chars": 588094,
      "updatedAt": 1791821638804
    },
    "priorWriter": {
      "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold35-original-budget-cutoff-assignment-witness-424d5.json",
      "chars": 9312,
      "updatedAt": 1791915841850
    }
  },
  "originalMapRow": {
    "ownerId": "su-01864986-d27d-497b-b501-7082b6e0caab",
    "candidateReason": "silent-since-failed-respawn",
    "frozenClaimCount": 4,
    "frozenParkedOn": null,
    "originalCutoff": "2026-10-10T16:00:36.515Z",
    "priorWaitEvidence": {
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
      "decision": "resume-candidate",
      "workRefs": [
        "WI-10006302",
        "EI-25433658765688677",
        "EI-25493141603129186",
        "EI-25436508475172020"
      ],
      "stopReason": "",
      "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
    },
    "ambiguousWorkedByItemRefs": [],
    "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
    "existingSixCaseSourceAssessment": null,
    "carryContinuityPreparation": {
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
      "value": "cold",
      "witnessAt": "2026-10-10T01:09:46.552Z",
      "explicitCarryRequestIds": [],
      "implicitArmIds": [],
      "compactionRequestIds": [],
      "accepted": false
    },
    "originalReceiptReferences": [],
    "missingFullOriginalSources": [],
    "retainedUnacceptedNativeFrames": [],
    "eligibilityVerdict": "unfrozen",
    "outcomesJoined": false,
    "remainingEvidence": [
      "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
      "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
    ]
  },
  "originalCandidate": {
    "ownerId": "su-01864986-d27d-497b-b501-7082b6e0caab",
    "candidateReason": "silent-since-failed-respawn",
    "nativeLastTurn": [
      "ok",
      "2026-10-10T02:38:07.691Z"
    ],
    "respawnClassification": "silent-since-failed-respawn",
    "recordedModel": null,
    "recordedAccount": null,
    "recordedCarry": null,
    "frozenPresence": {
      "workspaceId": "papercusp-workspace",
      "harnessSlug": null,
      "fleetSlug": "nonp2p-bug-drain-luna-max-0930",
      "sessionState": "parked",
      "modes": [
        "auto"
      ],
      "claimedItems": [],
      "currentPlanSlug": null,
      "selfWake": "loop",
      "loopArmed": true,
      "awaitingEvent": true,
      "awaitingNote": "headless launch-agent inbox-wake",
      "ownerId": "su-01864986-d27d-497b-b501-7082b6e0caab",
      "claimCount": 4,
      "parkedOn": null
    },
    "eligibility": {
      "status": "unverified",
      "reason": "Diagnostic candidate membership; blocker legitimacy not yet adjudicated from original pre-outcome evidence"
    }
  },
  "originalRoute": {
    "ownerId": "su-01864986-d27d-497b-b501-7082b6e0caab",
    "candidateReason": "silent-since-failed-respawn",
    "frozenClaimCount": 4,
    "frozenParkedOn": null,
    "prior273": {
      "owner_id": "su-01864986-d27d-497b-b501-7082b6e0caab",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    "eligibilityStatus": "unverified",
    "constraint": "Prior0130Z decisions are source evidence, not automatic exclusion from1600Z candidates; no outcomes joined",
    "originalAdvCandidate": {
      "coord_owner_id": "su-01864986-d27d-497b-b501-7082b6e0caab",
      "id": "39433",
      "agent": "codex",
      "first_seen_at": "2026-10-10 02:28:45.309687+00",
      "started_at": "2026-10-10 02:28:47.864475+00",
      "launched_at": null,
      "ended_at": "2026-10-10 22:10:04.573306+00",
      "parent": null,
      "session_id": "01a123a4-39f8-7331-b4eb-18d3bd6c1032",
      "launch_argv": [
        "psu",
        "--no-picker",
        "--agent=codex",
        "--headless",
        "--carry=cold",
        "--harness=papercusp",
        "--no-plan",
        "--model=gpt-6-luna:max",
        "--model-source=explicit",
        "--account=auto",
        "--fleet=nonp2p-bug-drain-luna-max-0930",
        "--auto",
        "--owner-id=su-01864986-d27d-497b-b501-7082b6e0caab"
      ],
      "identity_history": null
    },
    "originalBootstrap": {
      "idempotency_key": "bootstrap-su:4eee5cce-69c6-4425-8128-9499c909ed8d",
      "launched_at": "1791599325279",
      "launched_by": "su-01864986-d27d-497b-b501-7082b6e0caab",
      "adv_session_id": "39433",
      "owner_id": "su-01864986-d27d-497b-b501-7082b6e0caab",
      "agent": "codex",
      "model": "gpt-6-luna:max",
      "account_notice": "routing through the inference gateway (auto — it selects an available codex account).",
      "account_mode": "default",
      "account": null,
      "carry_mode": null,
      "native_session_id": null,
      "fleet_slug": "nonp2p-bug-drain-luna-max-0930"
    },
    "profileCustody": {
      "model": "dated-bootstrap-receipt",
      "account": "dated-bootstrap-account-notice",
      "carry": "earlier-273-loop-snapshot-only",
      "originalAsOfAttestation": "Exact dated receipt joins selected pre-census adv id; retained argv/timestamps remain mutable, carry must bridge original time",
      "eligibility": "unverified"
    },
    "preCensusCarry": {
      "value": "cold",
      "source": "earlier-frozen-loop-carry",
      "armCall": null
    },
    "originalWaitEvidence": {
      "i": 2,
      "ownerId": "su-01864986-d27d-497b-b501-7082b6e0caab",
      "decision": "resume-candidate",
      "reason": "Unfinished assigned work has a remaining source/verification/recovery step, or no valid parking reason was documented. Re-check current state/ownership and preserve actual authority/budget/owner walls before waking.",
      "stopReason": "",
      "workRefs": [
        "WI-10006302",
        "EI-25433658765688677",
        "EI-25493141603129186",
        "EI-25436508475172020"
      ],
      "wakeSourceAtCensus": "loop",
      "resumeConditions": [
        {
          "id": "WI-10006302",
          "next": {
            "status": "known",
            "value": "On the next admitted cold wake, verify WI-10006302 remains held and read loop:status plus events:status {await_id:254510}. Continue only with a settled previous cycle, active await, zero outstanding deliveries, and rewakeGuaranteed=true. Then refresh audit.json rows[85] (row 86), its plan content/index/lifecycle and all linked work items, and post one read-only comment.",
            "source": "checkpoint carry-note ## Next action"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        },
        {
          "id": "EI-25433658765688677",
          "next": {
            "status": "unknown",
            "reason": "the checkpoint has no \"## Next action\" section; read it directly"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        },
        {
          "id": "EI-25493141603129186",
          "next": {
            "status": "known",
            "value": "When this item is next admitted for investigation, re-read its current failure evidence and prior-attempt record before choosing any reproduction or source step.\n\n---\n⟦auto-checkpoint mechanical @2026-10-09T21:11:00.130Z⟧ system turn-end snapshot — the holder's agent-written checkpoint was missing/stale (P-015). Holder-session-level, not item-verified.\nsession: 01a12266-a8e7-7580-9dc7-4195284b454a\nlatest journal: Verified row 83 in [audit.json](/home/marsh-office/papercupai-workspace/papercusp/.papercusp/reports/plan-portfolio-audit-2026-10-06/audit.json) and posted read-back-confirmed comment #1169255. It was a supplemental, out-of-sequence refresh: the live plan is v21/shipped; all four items and linked wo\ntool-log tail:\n[aged] 23 calls: tools_invoke×7 tools_find×4 Bash×3 loop_status×3 events_status×2 work_items_get×2 coord_orient×1 work_items_list×1 · touched: python3 - <<'PY' import json p='.papercusp/repo…, python3 - <<'PY' import json from pathlib impor…\nwork_items_get ×2 ✓\ntools_find ✓\nwork_items_get ✓\nBash python3 - <<'PY' import json r=json.load(open('… ·\nwork_items_comment ✓\nwork_items_get ✓\nevents_status ✓\ntools_invoke ×3 ✓\nloop_status ✓\nevents_status ✓\ntools_invoke ✓",
            "source": "checkpoint carry-note ## Next action"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        },
        {
          "id": "EI-25436508475172020",
          "next": {
            "status": "unknown",
            "reason": "the checkpoint has no \"## Next action\" section; read it directly"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        }
      ],
      "evidence": [
        "census.json",
        "review-data.json",
        "loops-0.json"
      ],
      "reviewed": true
    },
    "preCensusWaitCalls": [],
    "eligibilityDecision": "unverified-no-outcomes-joined"
  },
  "reusedAssignmentWriter": {
    "source": {
      "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold35-original-budget-cutoff-assignment-witness-424d5.json",
      "chars": 9312,
      "updatedAt": 1791915841850
    },
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
    ]
  },
  "query": "SELECT harness_slug,feature_id,origin,fed_ts,first_claimed_at,worked_by_history FROM harness_shared.work_items WHERE workspace_id='papercusp-workspace' AND feature_id IN ('WI-10006302','EI-25433658765688677','EI-25493141603129186','EI-25436508475172020') ORDER BY harness_slug,feature_id",
  "positiveControlSql": "SELECT feature_id FROM harness_shared.work_items WHERE workspace_id='papercusp-workspace' AND feature_id='WI-10008017' LIMIT 1",
  "assignmentRead": {
    "advisory": "ⓘ a tool covers this read: work_items:list / work_items:get — server-side filters, batch id fetch, and the payload/threads projection. Raw SQL stays correct for genuinely ad-hoc analysis (a join, a group-by, a one-off slice); this fired because the query is a plain single-table read.",
    "mode": "query",
    "rowCount": 4,
    "truncated": false,
    "fields": [
      "harness_slug",
      "feature_id",
      "origin",
      "fed_ts",
      "first_claimed_at",
      "worked_by_history"
    ],
    "elapsedMs": 40,
    "rows": [
      {
        "harness_slug": "papercusp",
        "feature_id": "EI-25433658765688677",
        "origin": "local",
        "fed_ts": "1791919221736",
        "first_claimed_at": "2026-10-09 18:44:50.188179+00",
        "worked_by_history": [
          {
            "at": "2026-10-09T14:44:50.188228-04:00",
            "owner": "su-a6f3ca78-f361-4c00-8bd5-2c48cca0f3f4"
          },
          {
            "at": "2026-10-09T14:46:53.942224-04:00",
            "owner": "su-01864986-d27d-497b-b501-7082b6e0caab"
          },
          {
            "at": "2026-10-10T12:27:53.595465-04:00",
            "owner": "su-01864986-d27d-497b-b501-7082b6e0caab"
          }
        ]
      },
      {
        "harness_slug": "papercusp",
        "feature_id": "EI-25436508475172020",
        "origin": "local",
        "fed_ts": "1791649673595",
        "first_claimed_at": "2026-10-09 19:02:01.605053+00",
        "worked_by_history": [
          {
            "at": "2026-10-09T15:02:01.605058-04:00",
            "owner": "su-b9896e0c-d92d-4333-9ee6-370b6911aad4"
          },
          {
            "at": "2026-10-09T15:03:31.330941-04:00",
            "owner": "su-01864986-d27d-497b-b501-7082b6e0caab"
          },
          {
            "at": "2026-10-10T12:27:53.5946-04:00",
            "owner": "su-01864986-d27d-497b-b501-7082b6e0caab"
          }
        ]
      },
      {
        "harness_slug": "papercusp",
        "feature_id": "EI-25493141603129186",
        "origin": "local",
        "fed_ts": "1791917723409",
        "first_claimed_at": "2026-10-09 09:32:55.012361+00",
        "worked_by_history": [
          {
            "at": "2026-10-09T05:32:55.012477-04:00",
            "owner": "su-01864986-d27d-497b-b501-7082b6e0caab"
          },
          {
            "at": "2026-10-10T12:28:22.002213-04:00",
            "owner": "su-01864986-d27d-497b-b501-7082b6e0caab"
          },
          {
            "at": "2026-10-12T02:11:55.460925-04:00",
            "owner": "su-9e686abe-13e1-4ad0-ba6f-9c92a01e22f2"
          },
          {
            "at": "2026-10-12T15:43:54.477383-04:00",
            "owner": "su-9e686abe-13e1-4ad0-ba6f-9c92a01e22f2"
          },
          {
            "at": "2026-10-12T18:13:08.127196-04:00",
            "owner": "su-9e686abe-13e1-4ad0-ba6f-9c92a01e22f2"
          }
        ]
      },
      {
        "harness_slug": "papercusp",
        "feature_id": "WI-10006302",
        "origin": "local",
        "fed_ts": "1791838278674",
        "first_claimed_at": "2026-10-08 01:55:48.171312+00",
        "worked_by_history": [
          {
            "at": "2026-10-07T21:06:17.792564-04:00",
            "owner": "su-371afed7-3a96-49b7-83a6-7ca117fedbb2"
          },
          {
            "at": "2026-10-07T21:55:48.171418-04:00",
            "owner": "su-8e6132e4-770b-45a1-863b-1c9503a30b68"
          },
          {
            "at": "2026-10-08T09:17:01.374351-04:00",
            "owner": "su-8e6132e4-770b-45a1-863b-1c9503a30b68"
          },
          {
            "at": "2026-10-09T01:35:19.484665-04:00",
            "owner": "su-a430825c-e224-4912-ad59-fc03c4cb6c03"
          },
          {
            "at": "2026-10-09T05:51:39.971697-04:00",
            "owner": "su-a430825c-e224-4912-ad59-fc03c4cb6c03"
          },
          {
            "at": "2026-10-09T05:56:21.017525-04:00",
            "owner": "su-01864986-d27d-497b-b501-7082b6e0caab"
          },
          {
            "at": "2026-10-10T12:28:52.627636-04:00",
            "owner": "su-01864986-d27d-497b-b501-7082b6e0caab"
          },
          {
            "at": "2026-10-11T22:38:38.200621-04:00",
            "owner": "su-de92a7ab-1ddd-4075-9489-cb621799cfd4"
          },
          {
            "at": "2026-10-12T15:44:28.384619-04:00",
            "owner": "su-de92a7ab-1ddd-4075-9489-cb621799cfd4"
          },
          {
            "at": "2026-10-12T16:51:18.658844-04:00",
            "owner": "su-de92a7ab-1ddd-4075-9489-cb621799cfd4"
          }
        ]
      }
    ],
    "positiveControl": {
      "rows": [
        {
          "feature_id": "WI-10008017"
        }
      ],
      "rowCount": 1,
      "truncated": false,
      "fields": [
        "feature_id"
      ],
      "status": "passed"
    },
    "_meta": {
      "explicitFullRequest": true,
      "format": "json",
      "_seeAlso": [
        {
          "tool": "work_items:claimable"
        },
        {
          "tool": "plans:list"
        },
        {
          "tool": "db:migrations"
        },
        {
          "tool": "testing:runs"
        },
        {
          "tool": "issues:list / work_items:get"
        },
        {
          "tool": "dev:pg_active_queries"
        },
        {
          "tool": "dev:pg_table_sizes"
        },
        {
          "tool": "dev:pg_health"
        }
      ]
    }
  },
  "assessment": {
    "status": "review-open",
    "frozenPresenceClaimCountIsAggregate": true,
    "frozenClaimedItemsIsPlanOnly": true,
    "earlierReviewWorkRefs": [
      "WI-10006302",
      "EI-25433658765688677",
      "EI-25493141603129186",
      "EI-25436508475172020"
    ],
    "wholeFinalCutoffAssignmentNotEstablished": true,
    "remaining": [
      "Distinguish each claim/release transition and bridge original review work to final cutoff",
      "Inspect applicable owner-stop/dependency controls and independent reachable work",
      "Freeze whole116 eligibility before joining recovery outcomes"
    ],
    "continuityAccepted": false,
    "eligibilityAccepted": false,
    "outcomesJoined": false
  },
  "summary": {
    "originalPopulation": 116,
    "preservedAcceptedReceipts": 113,
    "unresolvedReceipts": 24,
    "newAcquisitions": 0,
    "productTestsRerun": 0,
    "newEligibilityAssessments": 0,
    "continuityAccepted": 0,
    "eligibilityAccepted": 0,
    "outcomesJoined": 0
  }
}
