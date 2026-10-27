---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/report-source-20261026-a/typecheck.json"
updated_at: 1792979915803
_body: "content"
---

{
  "ok": true,
  "engine": "tsc-cli",
  "errorCount": 0,
  "errors": [],
  "otherErrorCount": 27,
  "otherErrors": [
    {
      "file": "libs/generic/chat-protocol/src/conversation-context.ts",
      "line": 165,
      "column": 30,
      "code": "TS2551",
      "category": "error",
      "message": "Property 'findLastIndex' does not exist on type 'readonly ContextRecord[]'. Did you mean 'findIndex'?"
    },
    {
      "file": "libs/generic/chat-protocol/src/conversation-context.ts",
      "line": 165,
      "column": 44,
      "code": "TS7006",
      "category": "error",
      "message": "Parameter 'm' implicitly has an 'any' type."
    },
    {
      "file": "libs/generic/sync/src/index.ts",
      "line": 1,
      "column": 30,
      "code": "TS6142",
      "category": "error",
      "message": "Module './SyncProvider' was resolved to '/home/marsh-office/papercupai-workspace/papercusp/libs/generic/sync/src/SyncProvider.tsx', but '--jsx' is not set."
    },
    {
      "file": "packages/operator-core/lib/agent-tools/capability/launch-agent.ts",
      "line": 1561,
      "column": 70,
      "code": "TS2741",
      "category": "error",
      "message": "Property 'requireTerminal' is missing in type '{ workspaceId: string; binding: AdvSessionExpectedBinding; }' but required in type 'AdvSessionResumePin'."
    },
    {
      "file": "packages/operator-core/lib/agent-tools/cross_harness/docs-resource-index.ts",
      "line": 20,
      "column": 3,
      "code": "TS2353",
      "category": "error",
      "message": "Object literal may only specify known properties, and 'profile' does not exist in type 'ResourceDefinitionInput'."
    },
    {
      "file": "packages/operator-core/lib/agent-tools/fleet/kill.ts",
      "line": 472,
      "column": 11,
      "code": "TS2322",
      "category": "error",
      "message": "Type '((ownerId: string, dir?: string, opts?: AsyncDiscoveryOptions) => Promise<PsuPtyHost | null>) | ((ownerId: string) => Promise<PsuPtyHost | null> | PsuPtyHost | null)' is not assignable to type '((ownerId: string, dir?: string, opts?: DiscoveryOptions) => PsuPtyHost | null) | ((ownerId: string, dir?: string, opts?: AsyncDiscoveryOptions) => Promise<...>) | undefined'. Type '(ownerId: string) => Promise<PsuPtyHost | null> | PsuPtyHost | null' is not assignable to type '((ownerId: string, dir?: string, opts?: DiscoveryOptions) => PsuPtyHost | null) | ((ownerId: string, dir?: string, opts?: AsyncDiscoveryOptions) => Promise<...>) | undefined'. Type '(ownerId: string) => Promise<PsuPtyHost | null> | PsuPtyHost | null' is not assignable to type '(ownerId: string, dir?: string, opts?: DiscoveryOptions) => PsuPtyHost | null'. Type 'Promise<PsuPtyHost | null> | PsuPtyHost | null' is not assignable to type 'PsuPtyHost | null'. Type 'Promise<PsuPtyHost | null>' is missing the following properties from type 'PsuPtyHost': ownerId, advSessionId, pid, ptyPid, and 3 more."
    },
    {
      "file": "packages/operator-core/lib/agent-tools/plans/liveness-decoration.ts",
      "line": 83,
      "column": 59,
      "code": "TS2345",
      "category": "error",
      "message": "Argument of type '{ owner_id: string; heartbeat_at: string; last_active_at: string | null; }[]' is not assignable to parameter of type 'RowList<{ owner_id: string; heartbeat_at: string; last_active_at: string | null; }[]>'. Type '{ owner_id: string; heartbeat_at: string; last_active_at: string | null; }[]' is missing the following properties from type 'ResultQueryMeta<number, \"heartbeat_at\" | \"last_active_at\" | \"owner_id\">': columns, count, command, statement, state"
    },
    {
      "file": "packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts",
      "line": 1553,
      "column": 63,
      "code": "TS2322",
      "category": "error",
      "message": "Type 'Promise<{ message?: undefined; source?: undefined; status: \"work_item_not_found\"; workItemId: string; planSlug?: undefined; specId?: undefined; planItemId?: undefined; actualPlanSlug?: undefined; actualPlanItemIds?: undefined; ... 12 more ...; mismatched?: undefined; } | ... 20 more ... | { ...; }>' is not assignable to type 'Promise<BindSpecEvidenceResult>'. Type '{ message?: undefined; source?: undefined; status: \"work_item_not_found\"; workItemId: string; planSlug?: undefined; specId?: undefined; planItemId?: undefined; actualPlanSlug?: undefined; actualPlanItemIds?: undefined; ... 12 more ...; mismatched?: undefined; } | ... 20 more ... | { ...; }' is not assignable to type 'BindSpecEvidenceResult'. Type '{ workItemId?: undefined; planSlug?: undefined; specId?: undefined; planItemId?: undefined; actualPlanSlug?: undefined; actualPlanItemIds?: undefined; coverageEvidenceRef?: undefined; scopeMismatch?: undefined; ... 13 more ...; mismatched?: undefined; }' is not assignable to type 'BindSpecEvidenceResult'. Type '{ workItemId?: undefined; planSlug?: undefined; specId?: undefined; planItemId?: undefined; actualPlanSlug?: undefined; actualPlanItemIds?: undefined; coverageEvidenceRef?: undefined; scopeMismatch?: undefined; ... 13 more ...; mismatched?: undefined; }' is not assignable to type '{ status: \"created\" | \"unchanged\"; id: number; workItemId: string; planSlug: string; specId: string; sourceValId: string | null; specRevision: number; specFingerprint: string; bindingFingerprint: string; advisory?: DuplicateLiveTestRunBindingAdvisory | undefined; } | ... 13 more ... | { ...; }'. Type '{ workItemId?: undefined; planSlug?: undefined; specId?: undefined; planItemId?: undefined; actualPlanSlug?: undefined; actualPlanItemIds?: undefined; coverageEvidenceRef?: undefined; scopeMismatch?: undefined; ... 13 more ...; mismatched?: undefined; }' is not assignable to type '{ status: \"work_item_plan_item_mismatch\"; workItemId: string; planSlug: string; specId: string; …"
    },
    {
      "file": "packages/operator-core/lib/agent-tools/pot/set_steering.ts",
      "line": 189,
      "column": 40,
      "code": "TS2322",
      "category": "error",
      "message": "Type '{ name: string; spec: string; backend?: string | undefined; when?: string | undefined; }[] | null' is not assignable to type 'ModelTier[] | null | undefined'. Type '{ name: string; spec: string; backend?: string | undefined; when?: string | undefined; }[]' is not assignable to type 'ModelTier[]'. Type '{ name: string; spec: string; backend?: string | undefined; when?: string | undefined; }' is not assignable to type 'ModelTier'. Types of property 'backend' are incompatible. Type 'string | undefined' is not assignable to type '\"claude-code\" | \"codex\" | \"omp\" | undefined'. Type 'string' is not assignable to type '\"claude-code\" | \"codex\" | \"omp\" | undefined'."
    },
    {
      "file": "packages/operator-core/lib/cupboard/tool-find.ts",
      "line": 264,
      "column": 81,
      "code": "TS2345",
      "category": "error",
      "message": "Argument of type 'string | null' is not assignable to parameter of type 'string'. Type 'null' is not assignable to type 'string'."
    },
    {
      "file": "packages/operator-core/lib/dbos/coord-spawn-runner.ts",
      "line": 66,
      "column": 69,
      "code": "TS2345",
      "category": "error",
      "message": "Argument of type 'Record<string, string | undefined>' is not assignable to parameter of type 'Record<string, string>'. 'string' index signatures are incompatible. Type 'string | undefined' is not assignable to type 'string'. Type 'undefined' is not assignable to type 'string'."
    },
    {
      "file": "packages/operator-core/lib/dock-layouts.ts",
      "line": 805,
      "column": 39,
      "code": "TS2345",
      "category": "error",
      "message": "Argument of type 'Record<string, unknown>' is not assignable to parameter of type 'JSONValue'. Type 'Record<string, unknown>' is missing the following properties from type 'Date': toDateString, toTimeString, toLocaleDateString, toLocaleTimeString, and 37 more."
    },
    {
      "file": "packages/operator-core/lib/dock-layouts.ts",
      "line": 840,
      "column": 19,
      "code": "TS2345",
      "category": "error",
      "message": "Argument of type 'Record<string, unknown>' is not assignable to parameter of type 'JSONValue'. Type 'Record<string, unknown>' is missing the following properties from type 'Date': toDateString, toTimeString, toLocaleDateString, toLocaleTimeString, and 37 more."
    },
    {
      "file": "packages/operator-core/lib/endpoint-route/routes/transport/_mcp-host.ts",
      "line": 5644,
      "column": 45,
      "code": "TS2739",
      "category": "error",
      "message": "Type '{ sizeWalkMs: number; sizeWalkDirectories: number; sizeWalkEntries: number; sizeWalkFiles: number; readdirOperations: number; statOperations: number; operationTotalMs: number; maxOperationMs: number; maxOperationKind: null; currentOperationKind: null; ... 13 more ...; deletedBytes: number; }' is missing the following properties from type 'ScratchQuotaRecoveryDiagnostics': deletePreflightMs, pinProtectionMs, rmAsyncMs, deletePreflightSkips, lastDeletePreflightErrorCode"
    },
    {
      "file": "packages/operator-core/lib/external-bench/queen-ablation.ts",
      "line": 65,
      "column": 19,
      "code": "TS18048",
      "category": "error",
      "message": "'input.bees' is possibly 'undefined'."
    },
    {
      "file": "packages/operator-core/lib/external-bench/queen-ablation.ts",
      "line": 89,
      "column": 23,
      "code": "TS18048",
      "category": "error",
      "message": "'input.bees' is possibly 'undefined'."
    },
    {
      "file": "packages/operator-core/lib/fleet/sidecar-exec-process.ts",
      "line": 319,
      "column": 33,
      "code": "TS2345",
      "category": "error",
      "message": "Argument of type 'unknown' is not assignable to parameter of type 'ExecParams'."
    },
    {
      "file": "packages/operator-core/lib/harness/bootstrap-papercusp-hive.ts",
      "line": 1117,
      "column": 43,
      "code": "TS2345",
      "category": "error",
      "message": "Argument of type '{ slug: string; path?: string | undefined; self_repo?: boolean | undefined; remote_hive?: boolean | undefined; hive_pubkey?: string | undefined; owner_device_pubkey?: string | undefined; }' is not assignable to parameter of type 'ProjectEntry'. Types of property 'path' are incompatible. Type 'string | undefined' is not assignable to type 'string'. Type 'undefined' is not assignable to type 'string'."
    },
    {
      "file": "packages/operator-core/lib/harness/routines/sql-read-census-action.ts",
      "line": 350,
      "column": 16,
      "code": "TS2322",
      "category": "error",
      "message": "Type 'Sql<{}> | undefined' is not assignable to type 'SqlLike | undefined'. Type 'Sql<{}>' is not assignable to type 'SqlLike'. Type 'Helper<any, any>' is not assignable to type 'PromiseLike<unknown>'. Property 'then' is private in type 'Helper<any, any>' but not in type 'PromiseLike<unknown>'."
    },
    {
      "file": "packages/operator-core/lib/hive-publish-from-repo.ts",
      "line": 234,
      "column": 5,
      "code": "TS2345",
      "category": "error",
      "message": "Argument of type 'HiveDirectoryMeta' is not assignable to parameter of type 'HiveDirectoryMeta & { visibility: \"invite\" | \"public\"; }'. Type 'HiveDirectoryMeta' is not assignable to type '{ visibility: \"invite\" | \"public\"; }'. Types of property 'visibility' are incompatible. Type 'HiveVisibility' is not assignable to type '\"invite\" | \"public\"'. Type '\"private\"' is not assignable to type '\"invite\" | \"public\"'."
    },
    {
      "file": "packages/operator-core/lib/llm-testing/ledger.ts",
      "line": 121,
      "column": 62,
      "code": "TS2345",
      "category": "error",
      "message": "Argument of type 'Record<string, unknown>' is not assignable to parameter of type 'JSONValue'. Type 'Record<string, unknown>' is missing the following properties from type 'Date': toDateString, toTimeString, toLocaleDateString, toLocaleTimeString, and 37 more."
    },
    {
      "file": "packages/operator-core/lib/log-events.ts",
      "line": 149,
      "column": 20,
      "code": "TS18048",
      "category": "error",
      "message": "'pluginExecCtx' is possibly 'undefined'."
    },
    {
      "file": "packages/operator-core/lib/operator-prompt.ts",
      "line": 74,
      "column": 59,
      "code": "TS2740",
      "category": "error",
      "message": "Type 'Promise<HarnessMarkdownEntry[]>' is missing the following properties from type 'HarnessMarkdownEntry[]': length, pop, push, concat, and 29 more."
    },
    {
      "file": "packages/operator-core/lib/release/admission-fix-precheck-managed.ts",
      "line": 379,
      "column": 5,
      "code": "TS2353",
      "category": "error",
      "message": "Object literal may only specify known properties, and 'assertTestEnvironment' does not exist in type '{ integrationRoot: string; checkpointRoot: string; testRunHarness: string; prepareTestEnvironment?: ((root: string, onOutput: () => void) => Promise<ProcessEnv>) | undefined; }'."
    },
    {
      "file": "packages/operator-core/lib/sync/hyperbee/substrate-ipc-client.ts",
      "line": 175,
      "column": 30,
      "code": "TS2322",
      "category": "error",
      "message": "Type '(value: T | PromiseLike<T>) => void' is not assignable to type '(value: unknown) => void'. Types of parameters 'value' and 'value' are incompatible. Type 'unknown' is not assignable to type 'T | PromiseLike<T>'."
    },
    {
      "file": "packages/operator-core/lib/voice-prefs.ts",
      "line": 502,
      "column": 5,
      "code": "TS2740",
      "category": "error",
      "message": "Type 'Record<string, unknown>' is missing the following properties from type 'VoicePrefs': speakSuggestions, speakBackgroundToasts, speakModeFlips, speakCadenceStatus, and 55 more."
    },
    {
      "file": "packages/operator-core/lib/voice-prefs.ts",
      "line": 502,
      "column": 35,
      "code": "TS2345",
      "category": "error",
      "message": "Argument of type 'VoicePrefs' is not assignable to parameter of type 'Record<string, unknown>'. Index signature for type 'string' is missing in type 'VoicePrefs'."
    }
  ],
  "exitCode": 0,
  "scopedVerdict": "requested-files-clean"
}
