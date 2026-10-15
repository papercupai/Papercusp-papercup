---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold56-original018-four-postcutoff-release-receipts-424d5.json"
updated_at: 1791997873689
_body: "content"
---

{
  "schemaVersion": "r13-cold56-original018-four-postcutoff-release-receipts-v1",
  "observedAt": "2026-10-14T17:11:13.664Z",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "workItem": "WI-6554700010008887",
  "subjectOwner": "su-01864986-d27d-497b-b501-7082b6e0caab",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "sourceRefs": [
    "audits/parked-agent-resumption-2026-10-09/r13-cold54-seven-source-control-dispositions-v2-withdrawal-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold55-original018-partial-directional-custody-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold45-independent018-cutoff-assignment-source-v2-424d5.json"
  ],
  "queries": {
    "receiptSql": "SELECT id,tool_name,invoked_at,status,duration_ms,output_ref,args_json,error_code,error_message,serving_build_sha,metadata_json->'kernel' AS kernel,metadata_json->'dispatchStages' AS dispatch_stages FROM harness_shared.tool_invocations WHERE workspace_id='papercusp-workspace' AND id IN (35462396,35462400,35462589,35462905) ORDER BY id",
    "messageSql": "SELECT id,surface,writer_key,msg_id,ts,body FROM harness_shared.coord_event_log WHERE workspace_id='papercusp-workspace' AND id IN (23889402,23889403,23889429,23889443,23889573,23889580,23889938,23889946) ORDER BY id",
    "latchSql": "SELECT workspace_id,event_key,first_fired_at,last_fired_at,last_fired_by,last_payload,fire_count FROM harness_shared.event_key_fires WHERE event_key IN ('work-item:claimed:EI-25433658765688677','claim:released:EI-25433658765688677','work-item:claimed:EI-25436508475172020','claim:released:EI-25436508475172020','work-item:claimed:EI-25493141603129186','claim:released:EI-25493141603129186','work-item:claimed:WI-10006302','claim:released:WI-10006302') ORDER BY workspace_id,event_key"
  },
  "releaseReceipts": {
    "advisory": "ⓘ a tool covers this read: activity:tool-log / dev:telemetry / dev:tool_cooccurrence — per-tool rollups (count, error rate, p50/p95) and the compact per-session call log. Raw SQL stays correct for genuinely ad-hoc analysis (a join, a group-by, a one-off slice); this fired because the query is a plain single-table read.",
    "mode": "query",
    "rowCount": 4,
    "truncated": false,
    "fields": [
      "id",
      "tool_name",
      "invoked_at",
      "status",
      "duration_ms",
      "output_ref",
      "args_json",
      "error_code",
      "error_message",
      "serving_build_sha",
      "kernel",
      "dispatch_stages"
    ],
    "elapsedMs": 189,
    "rows": [
      {
        "id": "35462396",
        "tool_name": "work_items:release",
        "invoked_at": "2026-10-10 16:28:03.79+00",
        "status": "timeout",
        "duration_ms": 10925,
        "output_ref": null,
        "args_json": {
          "id": "EI-25433658765688677",
          "force": true,
          "reason": "[owner:Avi 2026-10-10 #1594] plan bug-queue-legitimacy P-008: holder inactive >2h with no item progress >2h; stale reservation released so the drain fleet can claim it. Holder may re-claim if still working.",
          "harness": "papercusp"
        },
        "error_code": "timeout",
        "error_message": "tool \"work_items:release\" exceeded timeout of 60s (handler returned but signal had aborted)",
        "serving_build_sha": "d740fc3802",
        "kernel": {
          "enforce": {
            "applied": true,
            "decision": "allow",
            "serverAudit": {
              "identityLaunchRecord": {
                "xmin": "842000467",
                "advSessionId": "39716"
              }
            },
            "availability": "available",
            "policyRevision": "control:1",
            "revisionSource": "applied",
            "executionRevision": {
              "stateRevision": "37b21f82cba4d206174fa104",
              "specificationRevision": "8aa94313494b4857c27402e2085d2ee213c2121df235d643f911595f2afc2abe"
            }
          },
          "preflight": {
            "applied": true,
            "decision": "allow",
            "serverAudit": {
              "identityLaunchRecord": {
                "xmin": "842000467",
                "advSessionId": "39716"
              }
            },
            "availability": "available",
            "policyRevision": "control:1",
            "revisionSource": "applied",
            "executionRevision": {
              "stateRevision": "37b21f82cba4d206174fa104",
              "specificationRevision": "8aa94313494b4857c27402e2085d2ee213c2121df235d643f911595f2afc2abe"
            }
          },
          "executionRevision": {
            "stateRevision": "37b21f82cba4d206174fa104",
            "specificationRevision": "8aa94313494b4857c27402e2085d2ee213c2121df235d643f911595f2afc2abe"
          }
        },
        "dispatch_stages": {
          "unit": "ms",
          "steps": [
            {
              "name": "kernel-preflight",
              "elapsedMs": 42.288131000474095
            },
            {
              "name": "default-deny",
              "elapsedMs": 0.0006009992212057114
            },
            {
              "name": "role-allowlist",
              "elapsedMs": 0.0021439995616674423
            },
            {
              "name": "capability-check",
              "elapsedMs": 0.0008709989488124847
            },
            {
              "name": "capability-envelope",
              "elapsedMs": 127.42934199981391
            },
            {
              "name": "role-requirement",
              "elapsedMs": 0.0009320005774497986
            },
            {
              "name": "harness-check",
              "elapsedMs": 0.0005409996956586838
            },
            {
              "name": "quota",
              "elapsedMs": 0.027462998405098915
            },
            {
              "name": "authorize",
              "elapsedMs": 0.0008109994232654572
            },
            {
              "name": "preconditions",
              "elapsedMs": 0.0017730016261339188
            },
            {
              "name": "entity-check",
              "elapsedMs": 0.0011630002409219742
            },
            {
              "name": "timeout",
              "elapsedMs": 0.022342998534440994
            },
            {
              "name": "idle-watchdog",
              "elapsedMs": 0.0012829992920160294
            },
            {
              "name": "replay-buffer",
              "elapsedMs": 0.0005910005420446396
            },
            {
              "name": "ctx-bindings",
              "elapsedMs": 0.2558629997074604
            },
            {
              "name": "kernel-enforce",
              "elapsedMs": 40.24289599992335
            },
            {
              "name": "invoke",
              "elapsedMs": 10714.029907001182
            }
          ],
          "timing": "wall-time-sequential-steps",
          "elapsedMs": 10924.31656499952,
          "schemaVersion": "dispatch-stages-v1"
        }
      },
      {
        "id": "35462400",
        "tool_name": "work_items:release",
        "invoked_at": "2026-10-10 16:28:03.856+00",
        "status": "timeout",
        "duration_ms": 10989,
        "output_ref": null,
        "args_json": {
          "id": "EI-25436508475172020",
          "force": true,
          "reason": "[owner:Avi 2026-10-10 #1594] plan bug-queue-legitimacy P-008: holder inactive >2h with no item progress >2h; stale reservation released so the drain fleet can claim it. Holder may re-claim if still working.",
          "harness": "papercusp"
        },
        "error_code": "timeout",
        "error_message": "tool \"work_items:release\" exceeded timeout of 60s (handler returned but signal had aborted)",
        "serving_build_sha": "d740fc3802",
        "kernel": {
          "enforce": {
            "applied": true,
            "decision": "allow",
            "serverAudit": {
              "identityLaunchRecord": {
                "xmin": "842000467",
                "advSessionId": "39716"
              }
            },
            "availability": "available",
            "policyRevision": "control:1",
            "revisionSource": "applied",
            "executionRevision": {
              "stateRevision": "37b21f82cba4d206174fa104",
              "specificationRevision": "8aa94313494b4857c27402e2085d2ee213c2121df235d643f911595f2afc2abe"
            }
          },
          "preflight": {
            "applied": true,
            "decision": "allow",
            "serverAudit": {
              "identityLaunchRecord": {
                "xmin": "842000467",
                "advSessionId": "39716"
              }
            },
            "availability": "available",
            "policyRevision": "control:1",
            "revisionSource": "applied",
            "executionRevision": {
              "stateRevision": "37b21f82cba4d206174fa104",
              "specificationRevision": "8aa94313494b4857c27402e2085d2ee213c2121df235d643f911595f2afc2abe"
            }
          },
          "executionRevision": {
            "stateRevision": "37b21f82cba4d206174fa104",
            "specificationRevision": "8aa94313494b4857c27402e2085d2ee213c2121df235d643f911595f2afc2abe"
          }
        },
        "dispatch_stages": {
          "unit": "ms",
          "steps": [
            {
              "name": "kernel-preflight",
              "elapsedMs": 40.08761600032449
            },
            {
              "name": "default-deny",
              "elapsedMs": 0.0012919995933771133
            },
            {
              "name": "role-allowlist",
              "elapsedMs": 0.002333998680114746
            },
            {
              "name": "capability-check",
              "elapsedMs": 0.00086200051009655
            },
            {
              "name": "capability-envelope",
              "elapsedMs": 127.72026399895549
            },
            {
              "name": "role-requirement",
              "elapsedMs": 0.000682000070810318
            },
            {
              "name": "harness-check",
              "elapsedMs": 0.0004009995609521866
            },
            {
              "name": "quota",
              "elapsedMs": 0.0007310006767511368
            },
            {
              "name": "authorize",
              "elapsedMs": 0.0006309989839792252
            },
            {
              "name": "preconditions",
              "elapsedMs": 0.0009109992533922195
            },
            {
              "name": "entity-check",
              "elapsedMs": 0.0009909998625516891
            },
            {
              "name": "timeout",
              "elapsedMs": 0.016541000455617905
            },
            {
              "name": "idle-watchdog",
              "elapsedMs": 0.0008010007441043854
            },
            {
              "name": "replay-buffer",
              "elapsedMs": 0.0005010012537240982
            },
            {
              "name": "ctx-bindings",
              "elapsedMs": 0.14917800016701221
            },
            {
              "name": "kernel-enforce",
              "elapsedMs": 42.270708000287414
            },
            {
              "name": "invoke",
              "elapsedMs": 10778.872354000807
            }
          ],
          "timing": "wall-time-sequential-steps",
          "elapsedMs": 10989.133842999116,
          "schemaVersion": "dispatch-stages-v1"
        }
      },
      {
        "id": "35462589",
        "tool_name": "work_items:release",
        "invoked_at": "2026-10-10 16:28:24.225+00",
        "status": "ok",
        "duration_ms": 2652,
        "output_ref": null,
        "args_json": {
          "id": "EI-25493141603129186",
          "force": true,
          "reason": "[owner:Avi 2026-10-10 #1594] plan bug-queue-legitimacy P-008: holder inactive >2h with no item progress >2h; stale reservation released so the drain fleet can claim it. Holder may re-claim if still working.",
          "harness": "papercusp"
        },
        "error_code": null,
        "error_message": null,
        "serving_build_sha": "d740fc3802",
        "kernel": {
          "enforce": {
            "applied": true,
            "decision": "allow",
            "serverAudit": {
              "identityLaunchRecord": {
                "xmin": "842000467",
                "advSessionId": "39716"
              }
            },
            "availability": "available",
            "policyRevision": "control:1",
            "revisionSource": "applied",
            "executionRevision": {
              "stateRevision": "37b21f82cba4d206174fa104",
              "specificationRevision": "8aa94313494b4857c27402e2085d2ee213c2121df235d643f911595f2afc2abe"
            }
          },
          "preflight": {
            "applied": true,
            "decision": "allow",
            "serverAudit": {
              "identityLaunchRecord": {
                "xmin": "842000467",
                "advSessionId": "39716"
              }
            },
            "availability": "available",
            "policyRevision": "control:1",
            "revisionSource": "applied",
            "executionRevision": {
              "stateRevision": "37b21f82cba4d206174fa104",
              "specificationRevision": "8aa94313494b4857c27402e2085d2ee213c2121df235d643f911595f2afc2abe"
            }
          },
          "executionRevision": {
            "stateRevision": "37b21f82cba4d206174fa104",
            "specificationRevision": "8aa94313494b4857c27402e2085d2ee213c2121df235d643f911595f2afc2abe"
          }
        },
        "dispatch_stages": {
          "unit": "ms",
          "steps": [
            {
              "name": "kernel-preflight",
              "elapsedMs": 10.90625700000237
            },
            {
              "name": "default-deny",
              "elapsedMs": 0.0017440000010537915
            },
            {
              "name": "role-allowlist",
              "elapsedMs": 0.0025349999996251427
            },
            {
              "name": "capability-check",
              "elapsedMs": 0.001542999998491723
            },
            {
              "name": "capability-envelope",
              "elapsedMs": 16.41464299999643
            },
            {
              "name": "role-requirement",
              "elapsedMs": 0.002365000000281725
            },
            {
              "name": "harness-check",
              "elapsedMs": 0.0017130000051110983
            },
            {
              "name": "quota",
              "elapsedMs": 0.002183999997214414
            },
            {
              "name": "authorize",
              "elapsedMs": 0.002135000002454035
            },
            {
              "name": "preconditions",
              "elapsedMs": 0.003938000001653563
            },
            {
              "name": "entity-check",
              "elapsedMs": 0.0032159999973373488
            },
            {
              "name": "timeout",
              "elapsedMs": 0.02287400000204798
            },
            {
              "name": "idle-watchdog",
              "elapsedMs": 0.0025749999986146577
            },
            {
              "name": "replay-buffer",
              "elapsedMs": 0.0013920000055804849
            },
            {
              "name": "ctx-bindings",
              "elapsedMs": 0.3433920000024955
            },
            {
              "name": "kernel-enforce",
              "elapsedMs": 29.85426699999516
            },
            {
              "name": "invoke",
              "elapsedMs": 2594.8337850000025
            }
          ],
          "timing": "wall-time-sequential-steps",
          "elapsedMs": 2652.4338510000016,
          "schemaVersion": "dispatch-stages-v1"
        }
      },
      {
        "id": "35462905",
        "tool_name": "work_items:release",
        "invoked_at": "2026-10-10 16:28:54.421+00",
        "status": "ok",
        "duration_ms": 1896,
        "output_ref": null,
        "args_json": {
          "id": "WI-10006302",
          "force": true,
          "reason": "[owner:Avi 2026-10-10 #1594] plan bug-queue-legitimacy P-008: holder inactive >2h with no item progress >2h; stale reservation released so the drain fleet can claim it. Holder may re-claim if still working.",
          "harness": "papercusp"
        },
        "error_code": null,
        "error_message": null,
        "serving_build_sha": "d740fc3802",
        "kernel": {
          "enforce": {
            "applied": true,
            "decision": "allow",
            "serverAudit": {
              "identityLaunchRecord": {
                "xmin": "842000467",
                "advSessionId": "39716"
              }
            },
            "availability": "available",
            "policyRevision": "control:1",
            "revisionSource": "applied",
            "executionRevision": {
              "stateRevision": "37b21f82cba4d206174fa104",
              "specificationRevision": "8aa94313494b4857c27402e2085d2ee213c2121df235d643f911595f2afc2abe"
            }
          },
          "preflight": {
            "applied": true,
            "decision": "allow",
            "serverAudit": {
              "identityLaunchRecord": {
                "xmin": "842000467",
                "advSessionId": "39716"
              }
            },
            "availability": "available",
            "policyRevision": "control:1",
            "revisionSource": "applied",
            "executionRevision": {
              "stateRevision": "37b21f82cba4d206174fa104",
              "specificationRevision": "8aa94313494b4857c27402e2085d2ee213c2121df235d643f911595f2afc2abe"
            }
          },
          "executionRevision": {
            "stateRevision": "37b21f82cba4d206174fa104",
            "specificationRevision": "8aa94313494b4857c27402e2085d2ee213c2121df235d643f911595f2afc2abe"
          }
        },
        "dispatch_stages": {
          "unit": "ms",
          "steps": [
            {
              "name": "kernel-preflight",
              "elapsedMs": 10.21737800000119
            },
            {
              "name": "default-deny",
              "elapsedMs": 0.004990000001271255
            },
            {
              "name": "role-allowlist",
              "elapsedMs": 0.00662200000078883
            },
            {
              "name": "capability-check",
              "elapsedMs": 0.0026350000116508454
            },
            {
              "name": "capability-envelope",
              "elapsedMs": 3.9489380000013625
            },
            {
              "name": "role-requirement",
              "elapsedMs": 0.002043999993475154
            },
            {
              "name": "harness-check",
              "elapsedMs": 0.002134000009391457
            },
            {
              "name": "quota",
              "elapsedMs": 0.0019539999921107665
            },
            {
              "name": "authorize",
              "elapsedMs": 0.00279499999305699
            },
            {
              "name": "preconditions",
              "elapsedMs": 0.0015330000023823231
            },
            {
              "name": "entity-check",
              "elapsedMs": 0.0030660000047646463
            },
            {
              "name": "timeout",
              "elapsedMs": 0.024447000003419816
            },
            {
              "name": "idle-watchdog",
              "elapsedMs": 0.0021140000026207417
            },
            {
              "name": "replay-buffer",
              "elapsedMs": 0.0013730000064242631
            },
            {
              "name": "ctx-bindings",
              "elapsedMs": 0.22479400000884198
            },
            {
              "name": "kernel-enforce",
              "elapsedMs": 19.478782999998657
            },
            {
              "name": "invoke",
              "elapsedMs": 1861.9021150000044
            }
          ],
          "timing": "wall-time-sequential-steps",
          "elapsedMs": 1895.8802159999905,
          "schemaVersion": "dispatch-stages-v1"
        }
      }
    ]
  },
  "coordinateMessages": {
    "advisory": "ⓘ a tool covers this read: coord:feed / coord:catch-up — audience-scoped history with membership gating, instead of raw envelope rows. Raw SQL stays correct for genuinely ad-hoc analysis (a join, a group-by, a one-off slice); this fired because the query is a plain single-table read.",
    "mode": "query",
    "rowCount": 8,
    "truncated": false,
    "fields": [
      "id",
      "surface",
      "writer_key",
      "msg_id",
      "ts",
      "body"
    ],
    "elapsedMs": 188,
    "rows": [
      {
        "id": "23889402",
        "surface": "messages",
        "writer_key": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
        "msg_id": "mv2lyjwv-0005-c36f8e1c72ba42b3b27e23a56cee87ec",
        "ts": "2026-10-10 16:27:58.927+00",
        "body": {
          "to": [
            "su-01864986-d27d-497b-b501-7082b6e0caab"
          ],
          "ts": "2026-10-10T16:27:58.927Z",
          "auto": true,
          "from": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
          "kind": "message",
          "basis": "holder-warm-idle",
          "msg_id": "mv2lyjwv-0005-c36f8e1c72ba42b3b27e23a56cee87ec",
          "expects": "none",
          "summary": "⚠ Your claim on EI-25436508475172020 was FORCE-RELEASED by su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb (basis: holder-warm-idle) — [owner:Avi 2026-10-10 #1594] plan bug-queue-legitimacy P-008: holder inactive >2h with no item progress >2h; stale reservation released so t",
          "lifecycle": "force_release",
          "work_item": "EI-25436508475172020",
          "harness_slug": "papercusp",
          "fieldProvenance": {
            "expects": "system-emitter-derived"
          }
        }
      },
      {
        "id": "23889403",
        "surface": "messages",
        "writer_key": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
        "msg_id": "mv2lyjwv-0008-3785faa28c9945918009e047307da5e1",
        "ts": "2026-10-10 16:27:58.927+00",
        "body": {
          "to": [
            "su-01864986-d27d-497b-b501-7082b6e0caab"
          ],
          "ts": "2026-10-10T16:27:58.927Z",
          "auto": true,
          "from": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
          "kind": "message",
          "basis": "holder-warm-idle",
          "msg_id": "mv2lyjwv-0008-3785faa28c9945918009e047307da5e1",
          "expects": "none",
          "summary": "⚠ Your claim on EI-25433658765688677 was FORCE-RELEASED by su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb (basis: holder-warm-idle) — [owner:Avi 2026-10-10 #1594] plan bug-queue-legitimacy P-008: holder inactive >2h with no item progress >2h; stale reservation released so t",
          "lifecycle": "force_release",
          "work_item": "EI-25433658765688677",
          "harness_slug": "papercusp",
          "fieldProvenance": {
            "expects": "system-emitter-derived"
          }
        }
      },
      {
        "id": "23889429",
        "surface": "messages",
        "writer_key": "work-items",
        "msg_id": "mv2lyoim-000e-4798874e19954c9296dde8066ec4189b",
        "ts": "2026-10-10 16:28:04.894+00",
        "body": {
          "to": [
            "su-71978e21-6b3b-4458-9bb2-7fd1c2a7d290"
          ],
          "ts": "2026-10-10T16:28:04.894Z",
          "auto": true,
          "body": "{\"id\":\"EI-25436508475172020\",\"kind\":\"bug\",\"severity\":\"major\",\"harness\":\"papercusp\",\"title\":\"mcp__papercusp_su__coord_declare_intent tool-call failure (native_tool_owner_unsupported_capability)\",\"state\":\"open\",\"assignee\":null,\"goal\":null,\"reason\":\"released\",\"plan\":null,\"tags\":[],\"payloadObservedAt\":\"2026-10-10T16:27:54.673Z\"}",
          "from": "work-items",
          "kind": "message",
          "msg_id": "mv2lyoim-000e-4798874e19954c9296dde8066ec4189b",
          "expects": "none",
          "summary": "[event] work-item:claimable — EI-25436508475172020 claimable (released): mcp__papercusp_su__coord_declare_intent tool-call failure (native_tool_owner_unsupported_capability)",
          "category": "event",
          "event_key": "work-item:claimable",
          "fieldProvenance": {
            "expects": "system-emitter-derived"
          }
        }
      },
      {
        "id": "23889443",
        "surface": "messages",
        "writer_key": "work-items",
        "msg_id": "mv2lyomt-0000-97a4afbf4495433b989c1ad4120429aa",
        "ts": "2026-10-10 16:28:05.045+00",
        "body": {
          "to": [
            "su-71978e21-6b3b-4458-9bb2-7fd1c2a7d290"
          ],
          "ts": "2026-10-10T16:28:05.045Z",
          "auto": true,
          "body": "{\"id\":\"EI-25433658765688677\",\"kind\":\"bug\",\"severity\":\"major\",\"harness\":\"papercusp\",\"title\":\"tools:find tool-call failure (upstream_died_mid_stream)\",\"state\":\"open\",\"assignee\":null,\"goal\":null,\"reason\":\"released\",\"plan\":null,\"tags\":[],\"payloadObservedAt\":\"2026-10-10T16:27:54.902Z\"}",
          "from": "work-items",
          "kind": "message",
          "msg_id": "mv2lyomt-0000-97a4afbf4495433b989c1ad4120429aa",
          "expects": "none",
          "summary": "[event] work-item:claimable — EI-25433658765688677 claimable (released): tools:find tool-call failure (upstream_died_mid_stream)",
          "category": "event",
          "event_key": "work-item:claimable",
          "fieldProvenance": {
            "expects": "system-emitter-derived"
          }
        }
      },
      {
        "id": "23889573",
        "surface": "messages",
        "writer_key": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
        "msg_id": "mv2lz30y-0002-fe29b3dc3299490eacb1c2c7a403b18f",
        "ts": "2026-10-10 16:28:23.698+00",
        "body": {
          "to": [
            "su-01864986-d27d-497b-b501-7082b6e0caab"
          ],
          "ts": "2026-10-10T16:28:23.698Z",
          "auto": true,
          "from": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
          "kind": "message",
          "basis": "holder-warm-idle",
          "msg_id": "mv2lz30y-0002-fe29b3dc3299490eacb1c2c7a403b18f",
          "expects": "none",
          "summary": "⚠ Your claim on EI-25493141603129186 was FORCE-RELEASED by su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb (basis: holder-warm-idle) — [owner:Avi 2026-10-10 #1594] plan bug-queue-legitimacy P-008: holder inactive >2h with no item progress >2h; stale reservation released so t",
          "lifecycle": "force_release",
          "work_item": "EI-25493141603129186",
          "harness_slug": "papercusp",
          "fieldProvenance": {
            "expects": "system-emitter-derived"
          }
        }
      },
      {
        "id": "23889580",
        "surface": "messages",
        "writer_key": "work-items",
        "msg_id": "mv2lz3jr-0000-7f9ad501c48b44b380c6978a3769924f",
        "ts": "2026-10-10 16:28:24.375+00",
        "body": {
          "to": [
            "su-71978e21-6b3b-4458-9bb2-7fd1c2a7d290"
          ],
          "ts": "2026-10-10T16:28:24.375Z",
          "auto": true,
          "body": "{\"id\":\"EI-25493141603129186\",\"kind\":\"bug\",\"severity\":\"minor\",\"harness\":\"papercusp\",\"title\":\"Tool sessions:read timing out repeatedly (superuser-native-session-verifier-unavailable)\",\"state\":\"open\",\"assignee\":null,\"goal\":null,\"reason\":\"released\",\"plan\":null,\"tags\":[],\"payloadObservedAt\":\"2026-10-10T16:28:23.006Z\"}",
          "from": "work-items",
          "kind": "message",
          "msg_id": "mv2lz3jr-0000-7f9ad501c48b44b380c6978a3769924f",
          "expects": "none",
          "summary": "[event] work-item:claimable — EI-25493141603129186 claimable (released): Tool sessions:read timing out repeatedly (superuser-native-session-verifier-unavailable)",
          "category": "event",
          "event_key": "work-item:claimable",
          "fieldProvenance": {
            "expects": "system-emitter-derived"
          }
        }
      },
      {
        "id": "23889938",
        "surface": "messages",
        "writer_key": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
        "msg_id": "mv2lzq8y-0001-c2dd55dbeb8e43268611a1f459f8e3f9",
        "ts": "2026-10-10 16:28:53.794+00",
        "body": {
          "to": [
            "su-01864986-d27d-497b-b501-7082b6e0caab"
          ],
          "ts": "2026-10-10T16:28:53.794Z",
          "auto": true,
          "from": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
          "kind": "message",
          "basis": "holder-warm-idle",
          "msg_id": "mv2lzq8y-0001-c2dd55dbeb8e43268611a1f459f8e3f9",
          "expects": "none",
          "summary": "⚠ Your claim on WI-10006302 was FORCE-RELEASED by su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb (basis: holder-warm-idle) — [owner:Avi 2026-10-10 #1594] plan bug-queue-legitimacy P-008: holder inactive >2h with no item progress >2h; stale reservation released so t",
          "lifecycle": "force_release",
          "work_item": "WI-10006302",
          "harness_slug": "papercusp",
          "fieldProvenance": {
            "expects": "system-emitter-derived"
          }
        }
      },
      {
        "id": "23889946",
        "surface": "messages",
        "writer_key": "work-items",
        "msg_id": "mv2lzqrl-0000-012a94eb8d5f4cebac6fdb637af7d350",
        "ts": "2026-10-10 16:28:54.465+00",
        "body": {
          "to": [
            "su-71978e21-6b3b-4458-9bb2-7fd1c2a7d290"
          ],
          "ts": "2026-10-10T16:28:54.465Z",
          "auto": true,
          "body": "{\"id\":\"WI-10006302\",\"kind\":\"bug\",\"severity\":\"minor\",\"harness\":\"papercusp\",\"title\":\"Non-shipped plan audit finds 27 content/item-index divergences and residual status contradictions requiring evidence-preserving reconciliation\",\"state\":\"open\",\"assignee\":null,\"goal\":null,\"reason\":\"released\",\"plan\":null,\"tags\":[],\"payloadObservedAt\":\"2026-10-10T16:28:52.681Z\"}",
          "from": "work-items",
          "kind": "message",
          "msg_id": "mv2lzqrl-0000-012a94eb8d5f4cebac6fdb637af7d350",
          "expects": "none",
          "summary": "[event] work-item:claimable — WI-10006302 claimable (released): Non-shipped plan audit finds 27 content/item-index divergences and residual status contradictions requiring evidence-preserving reconciliation",
          "category": "event",
          "event_key": "work-item:claimable",
          "fieldProvenance": {
            "expects": "system-emitter-derived"
          }
        }
      }
    ],
    "positiveControl": {
      "rows": [
        {
          "id": "23766617"
        }
      ],
      "rowCount": 1,
      "truncated": false,
      "fields": [
        "id"
      ],
      "status": "passed"
    }
  },
  "eventLatches": {
    "mode": "query",
    "rowCount": 8,
    "truncated": false,
    "fields": [
      "workspace_id",
      "event_key",
      "first_fired_at",
      "last_fired_at",
      "last_fired_by",
      "last_payload",
      "fire_count"
    ],
    "elapsedMs": 154,
    "rows": [
      {
        "workspace_id": "default",
        "event_key": "claim:released:EI-25433658765688677",
        "first_fired_at": "2026-10-09 18:46:53.996749+00",
        "last_fired_at": "2026-10-10 16:27:54.676749+00",
        "last_fired_by": "work-items",
        "last_payload": {
          "id": "EI-25433658765688677",
          "kind": "bug",
          "state": "open",
          "title": "tools:find tool-call failure (upstream_died_mid_stream)",
          "harness": "papercusp",
          "payloadObservedAt": "2026-10-10T16:27:54.657Z"
        },
        "fire_count": "2"
      },
      {
        "workspace_id": "default",
        "event_key": "claim:released:EI-25436508475172020",
        "first_fired_at": "2026-10-09 19:03:35.090491+00",
        "last_fired_at": "2026-10-10 16:27:54.638631+00",
        "last_fired_by": "work-items",
        "last_payload": {
          "id": "EI-25436508475172020",
          "kind": "bug",
          "state": "open",
          "title": "mcp__papercusp_su__coord_declare_intent tool-call failure (native_tool_owner_unsupported_capability)",
          "harness": "papercusp",
          "payloadObservedAt": "2026-10-10T16:27:54.632Z"
        },
        "fire_count": "2"
      },
      {
        "workspace_id": "default",
        "event_key": "claim:released:EI-25493141603129186",
        "first_fired_at": "2026-10-10 16:28:22.732322+00",
        "last_fired_at": "2026-10-12 19:43:54.698309+00",
        "last_fired_by": "work-items",
        "last_payload": {
          "id": "EI-25493141603129186",
          "kind": "bug",
          "state": "open",
          "title": "Tool sessions:read timing out repeatedly (superuser-native-session-verifier-unavailable)",
          "harness": "papercusp",
          "payloadObservedAt": "2026-10-12T19:43:54.697Z"
        },
        "fire_count": "2"
      },
      {
        "workspace_id": "default",
        "event_key": "claim:released:WI-10006302",
        "first_fired_at": "2026-10-08 01:06:17.919879+00",
        "last_fired_at": "2026-10-12 19:44:28.8574+00",
        "last_fired_by": "work-items",
        "last_payload": {
          "id": "WI-10006302",
          "kind": "bug",
          "state": "open",
          "title": "Non-shipped plan audit finds 27 content/item-index divergences and residual status contradictions requiring evidence-preserving reconciliation",
          "harness": "papercusp",
          "payloadObservedAt": "2026-10-12T19:44:28.831Z"
        },
        "fire_count": "5"
      },
      {
        "workspace_id": "default",
        "event_key": "work-item:claimed:EI-25433658765688677",
        "first_fired_at": "2026-10-09 18:44:55.119394+00",
        "last_fired_at": "2026-10-09 18:46:54.069777+00",
        "last_fired_by": "work-items",
        "last_payload": {
          "id": "EI-25433658765688677",
          "kind": "bug",
          "state": "open",
          "title": "tools:find tool-call failure (upstream_died_mid_stream)",
          "harness": "papercusp",
          "assignee": "su-01864986-d27d-497b-b501-7082b6e0caab",
          "payloadObservedAt": "2026-10-09T18:46:54.069Z"
        },
        "fire_count": "2"
      },
      {
        "workspace_id": "default",
        "event_key": "work-item:claimed:EI-25436508475172020",
        "first_fired_at": "2026-10-09 19:02:02.170976+00",
        "last_fired_at": "2026-10-09 19:03:35.953937+00",
        "last_fired_by": "work-items",
        "last_payload": {
          "id": "EI-25436508475172020",
          "kind": "bug",
          "state": "open",
          "title": "mcp__papercusp_su__coord_declare_intent tool-call failure (native_tool_owner_unsupported_capability)",
          "harness": "papercusp",
          "assignee": "su-01864986-d27d-497b-b501-7082b6e0caab",
          "payloadObservedAt": "2026-10-09T19:03:35.912Z"
        },
        "fire_count": "2"
      },
      {
        "workspace_id": "default",
        "event_key": "work-item:claimed:EI-25493141603129186",
        "first_fired_at": "2026-10-09 09:32:55.080143+00",
        "last_fired_at": "2026-10-13 18:55:24.033989+00",
        "last_fired_by": "work-items",
        "last_payload": {
          "id": "EI-25493141603129186",
          "kind": "bug",
          "state": "open",
          "title": "Tool sessions:read timing out repeatedly (superuser-native-session-verifier-unavailable)",
          "harness": "papercusp",
          "assignee": "su-9e686abe-13e1-4ad0-ba6f-9c92a01e22f2",
          "payloadObservedAt": "2026-10-13T18:55:24.032Z"
        },
        "fire_count": "6"
      },
      {
        "workspace_id": "default",
        "event_key": "work-item:claimed:WI-10006302",
        "first_fired_at": "2026-10-06 02:45:57.629322+00",
        "last_fired_at": "2026-10-12 20:51:21.506795+00",
        "last_fired_by": "work-items",
        "last_payload": {
          "id": "WI-10006302",
          "kind": "bug",
          "state": "open",
          "title": "Non-shipped plan audit finds 27 content/item-index divergences and residual status contradictions requiring evidence-preserving reconciliation",
          "harness": "papercusp",
          "assignee": "su-de92a7ab-1ddd-4075-9489-cb621799cfd4",
          "payloadObservedAt": "2026-10-12T20:51:21.291Z"
        },
        "fire_count": "8"
      }
    ]
  },
  "immutableWriter": {
    "releaseReceiptServingBuild": "d740fc3802",
    "sources": [
      {
        "path": "packages/operator-core/lib/work-items-events.ts",
        "sha256": "11445a197805a905679efced37b46776c642e60e1558febd9609cfd3346c3c5a",
        "line": 401
      },
      {
        "path": "packages/operator-core/lib/work-items.ts",
        "sha256": "620caf946fa9b4102e7b9c0a5a0edd2d868caa2d563faf8105ba21360a93b5f3",
        "line": 9146
      },
      {
        "path": "packages/operator-core/lib/events/await/store.ts",
        "sha256": "a7d99ce57bdadffea2e9651e2b6fe3f086791015d34454e4b4c00d4b42e2427d",
        "line": 3010
      }
    ],
    "semantics": "Release emitter lacks prior holder; four dated force-release messages independently identify original018. Key latch stores first/latest fires only, not complete history."
  },
  "assessment": {
    "fourDirectionalPostCutoffReleaseWitnesses": 4,
    "receiptOk": 2,
    "receiptTimeout": 2,
    "timeoutInterpretation": "Two timeout receipts coexist with dated force-release messages and canonical released claimable notifications. No no-op inferred; do not replay.",
    "original018Assignment": "four-postcutoff-releases-source-supported; complete-cutoff-continuity-review-open",
    "allSevenControlApplicability": "review-open",
    "other110Ready": false,
    "originalCohort": 116,
    "receiptPopulation": 137,
    "acceptedReceipts": 113,
    "unresolvedReceipts": 24,
    "whole116EligibilityAccepted": 0,
    "continuityAccepted": 0,
    "outcomesJoined": 0
  },
  "limits": [
    "Four dated releases are directional custody witnesses, not proof every held item actionable at cutoff.",
    "Event latch has first/latest fires only; complete historical control and assignment continuity remains to be established.",
    "Preserve R5/root961/R12/final-all-fix-runtime/actual>=24h R14. No native replay/acquisition/restore/route/account/gate/terminal redo."
  ],
  "next": "Reuse frozen original held response and dated source map for exact-cutoff assignments/actionability, then seven applicability, other110/whole116 eligibility/continuity before outcomes."
}
