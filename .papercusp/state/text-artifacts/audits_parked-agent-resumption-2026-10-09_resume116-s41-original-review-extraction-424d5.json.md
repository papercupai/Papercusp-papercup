---
rel_path: "audits/parked-agent-resumption-2026-10-09/resume116-s41-original-review-extraction-424d5.json"
updated_at: 1792173087106
_body: "content"
---

{
  "schemaVersion": "s41-original-review-extraction-v1",
  "groups": [
    {
      "key": "resume113-s41-independent-matrix-original-424d5.json",
      "rows": [
        {
          "id": "511eb79c-8648-4dbf-b224-32765391be23",
          "scenario": "su-S41-scheduler-independent",
          "status": "passed",
          "caps": [
            "wallclock"
          ],
          "assertErrors": 0,
          "judgeErrors": 0,
          "judgeWarnings": [],
          "turnKeys": [
            "idx",
            "cards",
            "costUsd",
            "simKind",
            "userText",
            "latencyMs",
            "toolCalls",
            "simThought",
            "controlTags",
            "toolResults",
            "finishReason",
            "assistantText"
          ],
          "callNames": [
            "coord:orient",
            "tools:find",
            "work_items:get",
            "tools:invoke",
            "docs:search",
            "tools:find",
            "mode:set",
            "tools:invoke",
            "tools:invoke",
            "tools:invoke",
            "tools:invoke",
            "tools:invoke"
          ],
          "firstCall": {
            "name": "coord:orient",
            "input": {
              "intent": "Continue authorized widget task WI-95541 in AUTO: read held item, inspect scheduler admission, and take the next action this turn."
            },
            "responseIndex": 0
          }
        },
        {
          "id": "b672c2a2-8090-41b0-a13a-7aff1b12aa10",
          "scenario": "su-S41-scheduler-independent",
          "status": "passed",
          "caps": [
            "turns"
          ],
          "assertErrors": 0,
          "judgeErrors": 0,
          "judgeWarnings": [
            "The first scheduler invocation omitted the required harness scope, and the turn also spent calls on unavailable tools before relying on the discovered scoped tools.",
            "The initial scheduler call was not scoped with the required widget harness, creating an avoidable failed attempt before the correctly scoped continuation."
          ],
          "turnKeys": [
            "idx",
            "cards",
            "costUsd",
            "simKind",
            "userText",
            "latencyMs",
            "toolCalls",
            "simThought",
            "controlTags",
            "toolResults",
            "finishReason",
            "assistantText"
          ],
          "callNames": [
            "mode:set",
            "coord:orient",
            "work_items:get",
            "tools:find",
            "harness:list",
            "tools:find",
            "tools:invoke",
            "dev:pipeline_position",
            "docs:search",
            "tools:find",
            "tools:invoke",
            "tools:invoke",
            "tools:invoke",
            "tools:invoke",
            "coord:orient",
            "tools:find",
            "work_items:get",
            "tools:invoke",
            "tools:invoke",
            "tools:invoke",
            "tools:invoke"
          ],
          "firstCall": {
            "name": "mode:set",
            "input": {
              "mode": "auto",
              "reason": "Owner explicitly authorized continuation of WI-95541 in AUTO and requested the next action this turn.",
              "ownerDirected": true
            },
            "responseIndex": 0
          }
        },
        {
          "id": "3467b846-ee35-4a4e-a845-078a21bffce7",
          "scenario": "su-S41-scheduler-independent",
          "status": "passed",
          "caps": [
            "turns"
          ],
          "assertErrors": 0,
          "judgeErrors": 0,
          "judgeWarnings": [
            "The turn used several repeated tools:find searches and attempted coord:presence even though the held-item state, scheduler result, and bounded await were already established."
          ],
          "turnKeys": [
            "idx",
            "cards",
            "costUsd",
            "simKind",
            "userText",
            "latencyMs",
            "toolCalls",
            "simThought",
            "controlTags",
            "toolResults",
            "finishReason",
            "assistantText"
          ],
          "callNames": [
            "coord:orient",
            "mode:set",
            "tools:find",
            "work_items:get",
            "tools:invoke",
            "tools:invoke",
            "tools:invoke",
            "tools:invoke",
            "tools:invoke",
            "coord:orient",
            "tools:find",
            "tools:find",
            "coord:inbox",
            "tools:find",
            "tools:invoke",
            "tools:find",
            "work_items:get",
            "coord:presence",
            "coord:send",
            "tools:invoke",
            "tools:invoke"
          ],
          "firstCall": {
            "name": "coord:orient",
            "input": {
              "intent": "Continue authorized widget task WI-95541 in AUTO: read held item, inspect admitted scheduler work, and take the next action this turn."
            },
            "responseIndex": 0
          }
        }
      ]
    },
    {
      "key": "resume114-s41-blocked-matrix-original-424d5.json",
      "rows": [
        {
          "id": "ee7f7035-be99-4fd3-a111-ca54b5681a18",
          "scenario": "su-S41-scheduler-blocked",
          "status": "passed",
          "caps": [
            "turns"
          ],
          "assertErrors": 0,
          "judgeErrors": 0,
          "judgeWarnings": [],
          "turnKeys": [
            "idx",
            "cards",
            "costUsd",
            "simKind",
            "userText",
            "latencyMs",
            "toolCalls",
            "simThought",
            "controlTags",
            "toolResults",
            "finishReason",
            "assistantText"
          ],
          "callNames": [
            "coord:orient",
            "tools:find",
            "work_items:get",
            "tools:invoke",
            "tools:invoke",
            "mode:set",
            "tools:invoke",
            "tools:invoke",
            "coord:orient",
            "tools:find",
            "tools:invoke",
            "work_items:get",
            "tools:invoke"
          ],
          "firstCall": {
            "name": "coord:orient",
            "input": {
              "intent": "Continue authorized AUTO work on WI-95541: read held item, inspect admitted scheduler work, and take the next concrete action this turn."
            },
            "responseIndex": 0
          }
        },
        {
          "id": "cbce175f-0b0e-4ec2-9f71-fbb2d368ef34",
          "scenario": "su-S41-scheduler-blocked",
          "status": "passed",
          "caps": [],
          "assertErrors": 0,
          "judgeErrors": 0,
          "judgeWarnings": [],
          "turnKeys": [
            "idx",
            "cards",
            "costUsd",
            "simKind",
            "userText",
            "latencyMs",
            "toolCalls",
            "simThought",
            "controlTags",
            "toolResults",
            "finishReason",
            "assistantText"
          ],
          "callNames": [
            "coord:orient",
            "tools:find",
            "mode:set",
            "tools:invoke",
            "work_items:get",
            "tools:invoke",
            "tools:invoke",
            "tools:invoke"
          ],
          "firstCall": {
            "name": "coord:orient",
            "input": {
              "intent": "Continue authorized widget task WI-95541 in AUTO; read its held state, check scheduler-admitted work, and execute the next supported action."
            },
            "responseIndex": 0
          }
        },
        {
          "id": "0c57e4a3-8e6e-405d-87f1-f0b697235b29",
          "scenario": "su-S41-scheduler-blocked",
          "status": "passed",
          "caps": [
            "turns"
          ],
          "assertErrors": 0,
          "judgeErrors": 0,
          "judgeWarnings": [],
          "turnKeys": [
            "idx",
            "cards",
            "costUsd",
            "simKind",
            "userText",
            "latencyMs",
            "toolCalls",
            "simThought",
            "controlTags",
            "toolResults",
            "finishReason",
            "assistantText"
          ],
          "callNames": [
            "coord:orient",
            "tools:find",
            "tools:invoke",
            "tools:invoke",
            "tools:invoke",
            "coord:orient",
            "work_items:get",
            "tools:find",
            "tools:invoke"
          ],
          "firstCall": {
            "name": "coord:orient",
            "input": {
              "intent": "Continue authorized WI-95541 widget task in AUTO; read held item, inspect admitted scheduler work, and execute next action."
            },
            "responseIndex": 0
          }
        }
      ]
    },
    {
      "key": "resume115-s41-original-no-event-finished-and-duplicate-boundary-424d5.json",
      "rows": [
        {
          "id": "40a92223-84ea-49d9-897d-31649feb4732",
          "scenario": "su-S41-scheduler-no-event",
          "status": "passed",
          "caps": [
            "wallclock"
          ],
          "assertErrors": 0,
          "judgeErrors": 0,
          "judgeWarnings": [
            "After checkpointing, the assistant described obtaining peer review or an exact wake as the next action, but did not perform a concrete coordination or handoff action; the turn therefore left the held obligation waiting without clarifying an actionable follow-up beyond the existing loop."
          ],
          "turnKeys": [
            "idx",
            "cards",
            "costUsd",
            "simKind",
            "userText",
            "latencyMs",
            "toolCalls",
            "simThought",
            "controlTags",
            "toolResults",
            "finishReason",
            "assistantText"
          ],
          "callNames": [
            "coord:orient",
            "work_items:get",
            "tools:find",
            "tools:invoke",
            "tools:invoke",
            "tools:invoke",
            "mode:set"
          ],
          "firstCall": {
            "name": "coord:orient",
            "input": {
              "intent": "Continue WI-95541 in AUTO: read the held item, inspect admitted scheduler work, and take the next actionable step this turn.",
              "harness": "all"
            },
            "responseIndex": 0
          }
        },
        {
          "id": "d08806a5-e177-4ea1-b943-8ddd17f9c210",
          "scenario": "su-S41-scheduler-no-event",
          "status": "passed",
          "caps": [
            "turns"
          ],
          "assertErrors": 0,
          "judgeErrors": 0,
          "judgeWarnings": [],
          "turnKeys": [
            "idx",
            "cards",
            "costUsd",
            "simKind",
            "userText",
            "latencyMs",
            "toolCalls",
            "simThought",
            "controlTags",
            "toolResults",
            "finishReason",
            "assistantText"
          ],
          "callNames": [
            "coord:orient",
            "work_items:get",
            "tools:find",
            "tools:invoke",
            "coord:presence",
            "tools:invoke",
            "tools:invoke",
            "tools:find",
            "tools:invoke",
            "tools:find",
            "tools:find",
            "coord:orient",
            "coord:presence",
            "work_items:get",
            "coord:handoff",
            "tools:find",
            "coord:send",
            "tools:invoke",
            "work_items:get"
          ],
          "firstCall": {
            "name": "coord:orient",
            "input": {
              "intent": "Continue authorized widget task WI-95541 in AUTO; read held work, inspect admitted scheduler work, and execute the next scoped action."
            },
            "responseIndex": 0
          }
        },
        {
          "id": "911a084f-c872-4132-adf6-63ec22738520",
          "scenario": "su-S41-scheduler-no-event",
          "status": "passed",
          "caps": [
            "turns"
          ],
          "assertErrors": 0,
          "judgeErrors": 0,
          "judgeWarnings": [
            "The correct scheduler, work-item, checkpoint, and loop-status actions were taken, but the turn also made several unnecessary or unavailable probes, including harness:list, work_items:list, and mode:set, after sufficient scope and state evidence was already available."
          ],
          "turnKeys": [
            "idx",
            "cards",
            "costUsd",
            "simKind",
            "userText",
            "latencyMs",
            "toolCalls",
            "simThought",
            "controlTags",
            "toolResults",
            "finishReason",
            "assistantText"
          ],
          "callNames": [
            "coord:orient",
            "tools:find",
            "work_items:get",
            "harness:list",
            "work_items:list",
            "tools:invoke",
            "mode:set",
            "tools:invoke",
            "tools:find",
            "tools:invoke",
            "tools:find",
            "coord:orient"
          ],
          "firstCall": {
            "name": "coord:orient",
            "input": {
              "intent": "Continue authorized widget task WI-95541 in AUTO; read held state, check scheduler admission, and execute its next action."
            },
            "responseIndex": 0
          }
        },
        {
          "id": "63b352c1-fe2e-403e-8d16-1fd72f803107",
          "scenario": "su-S41-scheduler-finished",
          "status": "passed",
          "caps": [],
          "assertErrors": 0,
          "judgeErrors": 0,
          "judgeWarnings": [],
          "turnKeys": [
            "idx",
            "cards",
            "costUsd",
            "simKind",
            "userText",
            "latencyMs",
            "toolCalls",
            "simThought",
            "controlTags",
            "toolResults",
            "finishReason",
            "assistantText"
          ],
          "callNames": [
            "coord:orient",
            "tools:find",
            "work_items:get",
            "tools:invoke",
            "tools:invoke"
          ],
          "firstCall": {
            "name": "coord:orient",
            "input": {
              "intent": "Continue authorized widget work WI-95541 in AUTO; read held checkpoint and scheduler-admitted next action."
            },
            "responseIndex": 0
          }
        },
        {
          "id": "57a31b51-c0ad-4e2a-8f5d-917ae3f192d7",
          "scenario": "su-S41-scheduler-finished",
          "status": "passed",
          "caps": [],
          "assertErrors": 0,
          "judgeErrors": 0,
          "judgeWarnings": [],
          "turnKeys": [
            "idx",
            "cards",
            "costUsd",
            "simKind",
            "userText",
            "latencyMs",
            "toolCalls",
            "simThought",
            "controlTags",
            "toolResults",
            "finishReason",
            "assistantText"
          ],
          "callNames": [
            "coord:orient",
            "tools:find",
            "work_items:get",
            "harness:list",
            "tools:find",
            "work_items:list",
            "tools:invoke",
            "tools:invoke"
          ],
          "firstCall": {
            "name": "coord:orient",
            "input": {
              "intent": "Continue authorized widget task WI-95541 in AUTO; read held item, inspect admitted scheduler work, and take the next action this turn."
            },
            "responseIndex": 0
          }
        },
        {
          "id": "e9e41669-889f-40f5-bc03-f6f7d3ee71d4",
          "scenario": "su-S41-scheduler-finished",
          "status": "passed",
          "caps": [],
          "assertErrors": 0,
          "judgeErrors": 0,
          "judgeWarnings": [],
          "turnKeys": [
            "idx",
            "cards",
            "costUsd",
            "simKind",
            "userText",
            "latencyMs",
            "toolCalls",
            "simThought",
            "controlTags",
            "toolResults",
            "finishReason",
            "assistantText"
          ],
          "callNames": [
            "coord:orient",
            "tools:find",
            "work_items:get",
            "tools:invoke",
            "tools:invoke",
            "tools:invoke"
          ],
          "firstCall": {
            "name": "coord:orient",
            "input": {
              "intent": "Continue authorized widget task WI-95541 in AUTO; read held checkpoint and scheduler-admitted work before taking its next action."
            },
            "responseIndex": 0
          }
        }
      ]
    }
  ]
}
