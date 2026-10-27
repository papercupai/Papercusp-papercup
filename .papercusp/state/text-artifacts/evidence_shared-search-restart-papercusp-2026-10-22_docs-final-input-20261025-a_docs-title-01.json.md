---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/docs-final-input-20261025-a/docs-title-01.json"
updated_at: 1792923732967
_body: "content"
---

{
  "attemptId": "docs-title-01",
  "request": {
    "query": "Grading retrieval and final-context quality",
    "harness": "engineering",
    "limit": 2,
    "semantic": true
  },
  "startedAt": "2026-10-25T10:21:39.094Z",
  "settledAt": "2026-10-25T10:21:39.452Z",
  "deliveryWallMs": 358,
  "rawResult": {
    "content": [
      {
        "type": "text",
        "text": "handler_error: invalid_input: invalid_args: Unrecognized key: \"build\" CORRECTED CALL — send this: docs:search({ \"query\": \"Grading retrieval and final-context quality\", \"harness\": \"engineering\", \"limit\": 2, \"semantic\": true }) (removed `build` (this tool declares no counterpart — the fix is to drop it, not to look for a synonym)). This resolves the rejected keys against the args you actually sent; it does not guarantee the call validates, since a value-level error would not have been visible to this check. — this tool accepts ONLY: scope, query, limit, harness, semantic. (Dispatch-level args, handled by the transport before this tool's own schema and therefore not in the list above but also accepted: payloadTier, projection, view.) An undeclared arg is REJECTED, not silently ignored (EI-10883): passing an arg a tool does not declare used to return ok:true while quietly doing something else, which is indistinguishable from success. Re-send using only the keys above (or the dispatch-level ones just listed). This server is running build 1777870c66, started 1.1h ago. If this argument was added after that build, the running process has never seen it — restart the app/process to pick up the new code. For the current source tree, retry this call against the Papercusp staging operator at :3170 — add build: 'staging' to this call's arguments (or call tools:invoke { name, args, build: 'staging' }) and the MCP proxy routes it there; with ptool, pass --url=http://127.0.0.1:3170 explicitly."
      }
    ],
    "isError": true
  },
  "executed": false,
  "outcome": "refused",
  "note": "Transport build selector reached strict adapter schema. No query result, labels or cost measurement."
}
