---
rel_path: "evidence/native-p026-grading-audit-recovery-20261103-v1.json"
updated_at: 1793667600683
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-10007889",
  "sourceCard": "EI-27724167979425848",
  "priorProof": "papercusp/evidence/native-p026-activation-and-spec-quality-20261103-v1.json",
  "timeoutAwait": 398248,
  "receipt": {
    "ok": true,
    "requestedTargetIds": [
      "EI-27724167979425848"
    ],
    "receipts": [
      {
        "issueId": "EI-27724167979425848",
        "rubricRef": "spec-quality",
        "state": "launched",
        "idempotencyKey": "grading-audit:EI-27724167979425848:recovery:96e67a0e831096c8",
        "launch": {
          "deduped": false,
          "requestKind": "capability:launch-agent",
          "launchState": "completed",
          "startedAt": 1793667315969,
          "expectedCount": 1,
          "targetMembers": [
            {
              "ownerId": "su-a462b27b-0dca-4581-a2ad-61d384d96f5a",
              "label": "grading-audit:EI-27724167979425848",
              "headless": true
            }
          ],
          "spawnAttempted": true,
          "nativeSpawnAttempted": [
            0
          ],
          "reconciliationRequired": false,
          "memberResults": {
            "0": {
              "memberIndex": 0,
              "ownerId": "su-a462b27b-0dca-4581-a2ad-61d384d96f5a",
              "label": "grading-audit:EI-27724167979425848",
              "headless": true,
              "status": "ok",
              "outcome": "opened",
              "pid": 2605477,
              "taskId": "0mvzz7j1bqugiw31w6n",
              "logPath": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/fleet-logs/grading-audit-EI-27724167979425848-1820019-1793667316501.log",
              "normalizedLogPath": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/fleet-logs/grading-audit-EI-27724167979425848-1820019-1793667316501.normalized.log"
            }
          },
          "processHandles": {
            "0": {
              "memberIndex": 0,
              "ownerId": "su-a462b27b-0dca-4581-a2ad-61d384d96f5a",
              "label": "grading-audit:EI-27724167979425848",
              "headless": true,
              "status": "ok",
              "outcome": "opened",
              "pid": 2605477,
              "taskId": "0mvzz7j1bqugiw31w6n",
              "logPath": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/fleet-logs/grading-audit-EI-27724167979425848-1820019-1793667316501.log",
              "normalizedLogPath": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/fleet-logs/grading-audit-EI-27724167979425848-1820019-1793667316501.normalized.log"
            }
          },
          "goalAdmission": null,
          "finalGoalAdmissions": [
            {
              "memberIndex": 0,
              "ownerId": "su-a462b27b-0dca-4581-a2ad-61d384d96f5a",
              "receiptId": "RG-a3afb6b7-b280-488e-9d2d-cef1bf3d8bb6",
              "admission": null,
              "outcome": "opened"
            }
          ],
          "opened": 1,
          "failed": 0,
          "failures": [],
          "partial": false,
          "compactionLimitWarnings": [],
          "command": "psu --launched-by=system:grading-audit-dispatch --no-picker --account=auto --agent=codex --owner-id=su-a462b27b-0dca-4581-a2ad-61d384d96f5a --harness=papercusp --headless --model=gpt-5.6-sol:high --model-source=explicit --role=judge --stack=domain:judge-domain --stack=practice:judge-grading-integrity",
          "fleet": null,
          "independent": true,
          "goalVerifier": null,
          "verifierCoupling": null,
          "headcountProfile": null,
          "mode": "fresh",
          "resumedOwnerId": null,
          "ownerIds": [
            "su-a462b27b-0dca-4581-a2ad-61d384d96f5a"
          ],
          "launchEvidence": {
            "version": 1,
            "processOpened": 1,
            "sessionRegistered": null,
            "firstTurn": null,
            "taskDisposition": {
              "claimed": 0,
              "noClaim": 0,
              "unknown": 1
            }
          },
          "tasks": [
            {
              "taskId": "0mvzz7j1bqugiw31w6n",
              "logPath": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/fleet-logs/grading-audit-EI-27724167979425848-1820019-1793667316501.log",
              "normalizedLogPath": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/fleet-logs/grading-audit-EI-27724167979425848-1820019-1793667316501.normalized.log",
              "pid": 2605477,
              "terminalPid": null,
              "label": "grading-audit:EI-27724167979425848",
              "ownerId": "su-a462b27b-0dca-4581-a2ad-61d384d96f5a",
              "headless": true,
              "kickoffProof": {
                "persisted": true,
                "nativeRef": "/home/marsh-office/.papercusp/su-codex-homes/session-55587/sessions/2026/11/02/rollout-2026-11-02T19-55-22-01a19ee7-5344-7b13-a521-4fe0045fc882.jsonl",
                "reason": null
              }
            }
          ]
        },
        "routingFallback": "generation-bound card requires a fresh judge launched from this compatible dispatcher build",
        "terminalRecovery": {
          "retiredTaskIds": [
            "0mvzy3tq5aio1m9u9aa"
          ],
          "attempts": 1,
          "codes": [
            "model_quota_exhausted"
          ],
          "fallback": {
            "agent": "codex",
            "model": "gpt-5.6-sol",
            "effort": "high",
            "account": "auto"
          },
          "routedTo": "codex"
        }
      }
    ],
    "_dataPlaneMayBeDegraded": "⚠ DATA PLANE MAY BE DEGRADED: this session's local MCP proxy observed an upstream retry or connection failure at 2026-11-03T00:59:50.937Z. During this short warning window, an unexpected empty/not-found result may be a transport symptom rather than authoritative absence. Retry or verify independently before concluding that data is missing."
  },
  "verifiedPickup": {
    "ownerId": "su-a462b27b-0dca-4581-a2ad-61d384d96f5a",
    "sessionState": "live",
    "lastToolCallAt": "2026-11-03T00:57:53.925Z"
  },
  "limitations": "Independent audit is pending; recovery launch/pickup is not a grading verdict, start, native admission or shipment."
}
