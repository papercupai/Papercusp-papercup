---
rel_path: "verification/WI-10006164/fire151-stateless-authorization-proof.json"
updated_at: 1791263636134
_body: "content"
---

{
  "scope": "WI-10006164 source prerequisite only; not native monetary authorization, provider invoice enforcement, full producer acceptance or shipment",
  "rootCause": "The shared final Anthropic fetch boundary had output validation and observations but no trusted host authorization hook; the operator adapter could not forward one. SDK retries and redirects could therefore bypass any caller-side grant check.",
  "reuse": "Extended existing RunAgentChatOptions/createStatelessDiagnosticFetch and the concrete operator llmCall. Existing GatewayCarryTrialBinding is Codex-only; no new table, tool, service or parallel budget store was added.",
  "testCommand": "PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- libs/papercusp-shared/src/agent/chat-stream-transport.test.ts packages/operator-core/lib/llm-testing/__tests__/llm-client-error.test.ts",
  "baseline": {
    "log": "/tmp/fire151-authorization-before.log",
    "runIds": [
      20825818,
      20825821
    ],
    "failed": 13,
    "passed": 80
  },
  "final": {
    "log": "/tmp/fire151-authorization-final2.log",
    "runIds": [
      20825897,
      20825900
    ],
    "passed": 96,
    "failed": 0,
    "skipped": 0,
    "requestedFiles": 2,
    "executedFiles": 2,
    "ledger": "Both exact rows independently reread pass/local/papercusp/worktreeDirty=true/runGroupId=null/root commit335341d37afd0f8722e8f05595d9073d6e5400f6"
  },
  "initialFinal": {
    "log": "/tmp/fire151-authorization-final.log",
    "runIds": [
      20825858,
      20825859
    ],
    "passed": 93,
    "note": "Superseded by final2 after three added boundary controls; do not add repeated test totals."
  },
  "typechecks": {
    "shared": {
      "project": "libs/papercusp-shared",
      "engine": "tsc-cli",
      "namedFiles": 2,
      "totalErrorCount": 0,
      "unattributedErrorCount": 0,
      "compilerExitCode": 0
    },
    "operator": {
      "project": "packages/operator-core",
      "engine": "tsc-service",
      "namedFiles": 2,
      "checkedFiles": 35,
      "totalErrorCount": 0,
      "unattributedErrorCount": 0,
      "compilerExitCode": 0
    },
    "scope": "Focused source/import coverage; not the full CI gate."
  },
  "files": [
    {
      "path": "libs/papercusp-shared/src/agent/chat-stream.ts",
      "workingBlob": "7eaf2220dc9c938b9677efb1ba0133b3f2207498",
      "headBlob": "7eaf2220dc9c938b9677efb1ba0133b3f2207498",
      "gitRoot": "libs/papercusp-shared"
    },
    {
      "path": "libs/papercusp-shared/src/agent/chat-stream-transport.test.ts",
      "workingBlob": "87cfa074fb72bc9eb402e162cbe79929e8686d5c",
      "headBlob": "87cfa074fb72bc9eb402e162cbe79929e8686d5c",
      "gitRoot": "libs/papercusp-shared"
    },
    {
      "path": "packages/operator-core/lib/llm-testing/llm-client.ts",
      "workingBlob": "fbfb7b8ccea5b5aa9a2e9044864bc4f042ae0b82",
      "headBlob": "3fa0ecdb52acfd8abefc0713d717405e55751d5b",
      "gitRoot": "."
    },
    {
      "path": "packages/operator-core/lib/llm-testing/__tests__/llm-client-error.test.ts",
      "workingBlob": "0186c4d3b4821dd410999c908ab3284f5752e0e3",
      "headBlob": "cc8e8ee097bbf8d46d2855f8c8063dc8d83acca6",
      "gitRoot": "."
    }
  ],
  "headsAtMeasurement": {
    "root": "335341d37afd0f8722e8f05595d9073d6e5400f6",
    "shared": "af5dccdde323fca7f43794ebc72d895f3a45879a"
  },
  "guard": "Immutable Request/policy input, unique attempt ids and body/credential digests, cancellation/revocation/async-validator refusal, final check after diagnostics, no transparent redirects, caller policy snapshot, unsupported backend refusal, actual SDK retries, and late-refusal unknown-spend preservation including credential-refresh wrappers.",
  "limitations": "The hook trusts host policy. No production grant issuer/consumer was added; delegated gateways may change provider credentials after this local boundary. No automatic refund, provider monetary guarantee, complete graph identity, native manual-pipeline authorization or actual six-producer contract proof.",
  "friction": "EI-25205520355704602 is a probation observation for serving-generation/schema recovery, not a substitute implementation mission.",
  "diffCheck": "Both root changed paths and shared submodule paths passed git diff --check."
}
