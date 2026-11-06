---
rel_path: "runtime-migration/p006-d8d0-audit-recovery-started-0dcd3-20261106.json"
updated_at: 1793940928220
_body: "content"
---

{
  "schemaVersion": "bun-p006-independent-audit-recovery-v1",
  "ownerId": "su-0dcd3a3c-a45f-482b-a8cd-e957407353f9",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "workItem": "WI-6554700010022072",
  "issueId": "EI-28010179012065277",
  "subject": {
    "ref": "spec-set:plan-class-migration:d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40:3bf31049db04120e",
    "kind": "plan"
  },
  "observedAudit": {
    "state": "pending",
    "metaRubricRef": "grading-integrity",
    "stampedAt": "2026-11-06T04:09:47.647Z",
    "rubricRevision": 14,
    "criteriaHash": "795ad5a5aa77061bf0aeb54bd7c412307036cf576777ac42932b8afa8d6b4da9"
  },
  "runtime": {
    "url": "http://127.0.0.1:3170",
    "registryRevision": "projected-tool-registry-v1:d597d0355a0d8ca3",
    "servingGeneration": "serving-generation-v1:7245681b58949709f2504a98681dc240b3342076dc3ea3d2b88e5da7d6045c17"
  },
  "repair": {
    "ok": true,
    "requestedTargetIds": [
      "EI-28010179012065277"
    ],
    "receipts": [
      {
        "issueId": "EI-28010179012065277",
        "rubricRef": "spec-quality",
        "state": "launched",
        "idempotencyKey": "grading-audit:EI-28010179012065277:recovery:02858e3cb827026d",
        "launch": {
          "deduped": false,
          "requestKind": "capability:launch-agent",
          "launchState": "completed",
          "startedAt": 1793940829999,
          "expectedCount": 1,
          "targetMembers": [
            {
              "ownerId": "su-011669fa-febe-4a52-adcf-2feee5ac08a4",
              "label": "grading-audit:EI-28010179012065277",
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
              "ownerId": "su-011669fa-febe-4a52-adcf-2feee5ac08a4",
              "label": "grading-audit:EI-28010179012065277",
              "headless": true,
              "status": "ok",
              "outcome": "opened",
              "pid": 297418,
              "taskId": "0mw4i1yzn10jp03izq8",
              "logPath": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/fleet-logs/grading-audit-EI-28010179012065277-3076316-1793940834476.log",
              "normalizedLogPath": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/fleet-logs/grading-audit-EI-28010179012065277-3076316-1793940834476.normalized.log"
            }
          },
          "processHandles": {
            "0": {
              "memberIndex": 0,
              "ownerId": "su-011669fa-febe-4a52-adcf-2feee5ac08a4",
              "label": "grading-audit:EI-28010179012065277",
              "headless": true,
              "status": "ok",
              "outcome": "opened",
              "pid": 297418,
              "taskId": "0mw4i1yzn10jp03izq8",
              "logPath": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/fleet-logs/grading-audit-EI-28010179012065277-3076316-1793940834476.log",
              "normalizedLogPath": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/fleet-logs/grading-audit-EI-28010179012065277-3076316-1793940834476.normalized.log"
            }
          },
          "goalAdmission": null,
          "finalGoalAdmissions": [
            {
              "memberIndex": 0,
              "ownerId": "su-011669fa-febe-4a52-adcf-2feee5ac08a4",
              "receiptId": "RG-2d753496-1483-4365-8151-6e463d5c2c33",
              "admission": null,
              "outcome": "opened"
            }
          ],
          "opened": 1,
          "failed": 0,
          "failures": [],
          "partial": false,
          "compactionLimitWarnings": [],
          "command": "psu --launched-by=system:grading-audit-dispatch --no-picker --account=auto --agent=codex --owner-id=su-011669fa-febe-4a52-adcf-2feee5ac08a4 --harness=papercusp --headless --model=gpt-6.1-sol:xhigh --model-source=explicit --role=judge --stack=domain:judge-domain --stack=practice:judge-grading-integrity",
          "fleet": null,
          "independent": true,
          "goalVerifier": null,
          "verifierCoupling": null,
          "headcountProfile": null,
          "mode": "fresh",
          "resumedOwnerId": null,
          "ownerIds": [
            "su-011669fa-febe-4a52-adcf-2feee5ac08a4"
          ],
          "launchEvidence": {
            "version": 1,
            "processOpened": 1,
            "sessionRegistered": 1,
            "firstTurn": true,
            "taskDisposition": {
              "claimed": 0,
              "noClaim": 0,
              "unknown": 1
            }
          },
          "tasks": [
            {
              "taskId": "0mw4i1yzn10jp03izq8",
              "logPath": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/fleet-logs/grading-audit-EI-28010179012065277-3076316-1793940834476.log",
              "normalizedLogPath": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/fleet-logs/grading-audit-EI-28010179012065277-3076316-1793940834476.normalized.log",
              "pid": 297418,
              "terminalPid": null,
              "label": "grading-audit:EI-28010179012065277",
              "ownerId": "su-011669fa-febe-4a52-adcf-2feee5ac08a4",
              "headless": true,
              "kickoffProof": {
                "persisted": true,
                "nativeRef": "/home/marsh-office/.papercusp/su-codex-homes/session-56332/sessions/2026/11/05/rollout-2026-11-05T23-54-02-01a1af34-e831-7613-b374-eabafd56c2dd.jsonl",
                "reason": null
              },
              "nativeSession": {
                "backend": "codex",
                "source": "adv_sessions",
                "ownerId": "su-011669fa-febe-4a52-adcf-2feee5ac08a4",
                "codexHome": "/home/marsh-office/.papercusp/su-codex-homes/session-56332",
                "rolloutId": "01a1af34-e831-7613-b374-eabafd56c2dd",
                "exactResumeSupported": true,
                "missingReason": null
              }
            }
          ],
          "agentStarted": true,
          "freshVerdict": {
            "agentStarted": true,
            "sessions": [
              {
                "ownerId": "su-011669fa-febe-4a52-adcf-2feee5ac08a4",
                "sessionId": "01a1af34-e831-7613-b374-eabafd56c2dd",
                "advSessionId": 56332
              }
            ]
          }
        },
        "routingFallback": "explicit routine grading profile requires a fresh judge with the pinned model",
        "terminalRecovery": {
          "retiredTaskIds": [
            "0mw4h1vandabr69t3i3"
          ],
          "attempts": 2,
          "codes": [
            "inference_gateway_error"
          ],
          "fallback": {
            "agent": "codex",
            "model": "gpt-6.1-sol",
            "effort": "xhigh",
            "account": "auto"
          },
          "routedTo": "codex"
        }
      }
    ]
  },
  "limits": [
    "Launch proof only; no grading PASS or Bun acceptance.",
    "D011-D019 terminal, no retry; distinct coordinator admission/current activation audit/canonical start proof required after exact independent PASS.",
    "No additional implementation agents; canonical independent judge is required acceptance."
  ]
}
