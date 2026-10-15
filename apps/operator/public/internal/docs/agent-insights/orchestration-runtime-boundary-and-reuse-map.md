# Orchestration runtime boundary and reuse map
URL: /internal/docs/agent-insights/orchestration-runtime-boundary-and-reuse-map

Source-grounded ownership map for Codex functions.exec, Papercusp code:run, recipes, result-door output safety, capability execution, and the durable task manager.

# Scope and controlling rulings

This map freezes the workspace ownership boundary and the reuse targets for plan `orchestration-runtime-unification-and-safe-output-2026-08-22`, P-001. It follows D-012 through D-015:

* the server-side capability family is the so-called client adapter because the managed client and server share a host;
* `code:run` is the primary orchestration engine;
* Codex `functions.exec` remains a direct-call compatibility door, never a routed backend;
* aggregate output accounting belongs at the MCP result-door choke point;
* Phase 1 output safety is separate from runtime unification, and its summary budget is measured rather than preselected.

# Ownership and enforcement map

| Surface                                        | Implementation owner                 | Editable here? | Boundary and enforcement reach                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------ | -------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex `functions.exec`                         | Codex client                         |             No | A sealed V8 isolate supplied by the client. It evaluates JavaScript outside this repository; `typeof process` is `undefined`. Papercusp cannot patch the isolate or account for bytes that remain entirely inside it. See [Codex functions.exec is a V8 isolate](/internal/docs/agent-insights/codex-functions-exec-runtime-boundary). Under D-013 it is a compatibility door for direct calls, not an internal backend selected by Papercusp. |
| `code:run`                                     | Papercusp operator + generic tooldef |            Yes | Primary server engine. The defineTool is `packages/operator-core/lib/agent-tools/code/run.ts`; orchestration and worker execution live in `libs/generic/tooldef/src/code-orchestration/orchestrate.ts` and `run-script.ts`.                                                                                                                                                                                                                    |
| `recipes:search/get/run`                       | Papercusp operator                   |            Yes | Reuses the existing recipe system: tool surfaces under `packages/operator-core/lib/agent-tools/recipes/`, PG store in `code-recipes-store.ts`, hybrid retrieval in `code-recipes-search.ts`, and capture in `agent-tools/code/capture-recipe.ts`.                                                                                                                                                                                              |
| Model-facing MCP result door                   | Papercusp operator                   |            Yes | `packages/operator-core/lib/result-door.ts`, applied from `endpoint-route/routes/transport/_mcp-handler.ts` after projection/delta handling. It is the universal model-facing MCP choke point, not the boundary for machine-consumed inner dispatches.                                                                                                                                                                                         |
| Scratch spill/reference substrate              | Papercusp operator                   |            Yes | The result door writes validated, private scratch files and returns a cursor/URI reference. This is the existing large-output escape hatch to extend rather than creating another artifact store.                                                                                                                                                                                                                                              |
| Capability execution family                    | Papercusp operator                   |            Yes | `capability:bash`, `bash_output`, `bash_kill`, `terminal`, and `exec-sandbox` are the server-side execution family D-012 calls the client adapter. The `host:same` premise is declared; there is no second client-side DAG.                                                                                                                                                                                                                    |
| Durable task manager                           | Papercusp operator                   |            Yes | `packages/operator-core/lib/task-manager/` supplies task identity, ledgering, cgroup confinement, reconciliation, resource accounting, and safe control. It is the durability substrate for long-lived capability jobs.                                                                                                                                                                                                                        |
| Native Claude/Codex/OMP command and code tools | Each client/runtime                  |   Generally no | Their implementation and disable switches live outside this repository or in client launch configuration. P-024 and P-025 must prove each disable mechanism and parity gate before D-016/D-017 can disable native surfaces for managed agents.                                                                                                                                                                                                 |

# The primary server engine

`code:run` accepts a JavaScript body, exposes only role-scoped tools, and returns the script's own summary. The wrapper deliberately collapses many model/tool/model turns into one server execution:

1. `roleScopedToolNames` builds the permitted facade and excludes recursive `code:run`.
2. Every nested call still enters the real projected dispatcher, so endpoint policy, authorization, telemetry, schema validation, and tool effects remain authoritative.
3. `dryRun:true` executes reads but records and skips write-effect calls, returning planned mutations for review.
4. The script runs in a worker thread with a `node:vm` context. Worker termination enforces the overall deadline; the orchestration layer also derives an `AbortController` from the request signal and timeout and passes cancellation to nested dispatches.
5. Only the returned summary re-enters model context. Console capture and execution metadata are separately bounded. A script can use `Promise.all` or `Promise.allSettled` for in-script fan-out and isolate child failures.
6. Successful non-dry runs are captured best-effort as recipes. Capture failure is soft; execution success is not retroactively changed.

The current foreground timeout is 30 seconds by default and is clamped below the MCP transport ceiling when a caller asks for more. There is no `code:run` background mode today. A worker timeout stops the script worker, but a host-side write already dispatched before cancellation may have landed; the result records executed, failed, and uncertain writes instead of manufacturing rollback certainty.

# Recipes are the reusable orchestration layer

The shipped recipe system is the store, search, promotion, and replay rail to extend:

* `code-recipes-store.ts` owns the PG row model and lifecycle; existing numbered migrations back it.
* `code-recipes-search.ts` performs lexical plus semantic retrieval with bounded embedding behavior.
* `recipes:search` discovers a reusable script before new orchestration is written.
* `recipes:get` returns the saved body and metadata.
* `recipes:run` revalidates the current tool schema, recipe revision/entity authority, the caller's live lane, and the reuser role envelope before dispatch.
* `capture-recipe.ts` records successful `code:run` executions and surfaces similar recipes as advisory data.

Do not create a parallel recipe table, search index, promotion rail, or replay authorization model.

# Result-door output safety

The result door is the correct aggregate-accounting integration point because every model-facing MCP result crosses it after projection. Its current behavior is deliberately narrower than D-014's target:

* it enforces a per-result text budget of roughly 1,500 tokens / 6,000 characters at the 8K context floor;
* oversized text spills to a validated private scratch file with restrictive permissions, and the result returns a cursor/reference;
* structured content is preserved;
* non-text image/audio/resource blocks pass through and are metered/noticed rather than rewritten as text;
* machine-consumed inner dispatches bypass the door by design;
* there is no per-turn or per-`code:run` aggregate budget yet.

Therefore Papercusp can enforce aggregate accounting for bytes that cross its own model-facing MCP door. It cannot claim enforcement over native-client shell output or values retained wholly inside the Codex V8 isolate. That residue must stay explicit in the rollout and measurement.

# Capability execution and sandbox boundary

`capability:bash` is a real server-side Bash execution surface with:

* explicit working-directory resolution;
* an environment allowlist, plus narrowly authorized encrypted integration-key bindings whose raw values are redacted from events, results, reads, and logs;
* foreground streaming through the `output` event;
* request-signal and wall-clock cancellation;
* a foreground timeout clamped below the transport deadline;
* detached jobs that return a process-local `bash_id`, durable `task_id`, deadline, and spill-log path;
* carry-safe output reattachment through `capability:bash_output { task_id }`;
* SIGTERM then SIGKILL control through `capability:bash_kill` / `processes:kill`;
* code-mode structured output with truthful `ok`, status, exit code, duration, cwd, combined output, truncation, and log path.

`exec-sandbox.ts` is complementary confinement, not a replacement for the environment allowlist. When enabled and bubblewrap works, it prefers SRT for filesystem, credential, and domain-allowlist egress parity. The fallback bwrap path provides a read-only host view, writable cwd/tmp/build-cache bindings, credential and `systemd-run` masks, PID/IPC/UTS/cgroup namespaces, and optional deny-all egress. The current gate is default-off and fail-open when the flag, wrapper, or host user namespaces are unavailable. That means parity matrices must report the live policy honestly: a maintained sandbox exists, but confinement is not guaranteed merely because `capability:bash` was selected.

# Durable task-manager substrate

The task manager is the existing long-lived execution substrate:

1. `managedSpawn` registers a pending ledger row before fork.
2. Where available, it launches the full subtree in a transient `pc-<taskId>.scope` under a Papercusp class slice.
3. It stamps a kernel process identity and flips the row to running.
4. Scope names carry the ledger key, so reconciliation is an exact join rather than a command-line heuristic.
5. The lifecycle distinguishes exited, killed, timed out, stranded, and ended-unobserved states.
6. Control addresses confined work by validated cgroup scope. Unconfined PID control re-reads the kernel identity before signalling, preventing recycled-PID kills.
7. SIGTERM escalates to SIGKILL and success is reported only after a fresh verification sees the scope empty.
8. If the task-manager flag, ledger, or confinement plane is unavailable, spawning fails soft and reports the degradation; it does not turn observability into an execution outage.

This is the substrate for background hand-off, carry-safe task handles, cancellation, resource budgets, reconciliation, and process-tree ownership. New orchestration work must extend it rather than adding an in-memory job registry.

# Reuse requirements for later lanes

P-003 through P-026 should treat these as mandatory reuse points:

* orchestration: extend `code:run` and the generic orchestration modules;
* saved workflows: extend `recipes:*`, the recipe PG store, and its existing search/capture/replay checks;
* command execution: extend the `capability:*` family rather than adding a client-side backend;
* long-lived jobs and PTYs: enrol them through the task manager and return durable task handles;
* large model-facing output: account and spill at `result-door.ts`;
* file/reference delivery: reuse the scratch cursor/URI substrate;
* permissions: reuse defineTool role/effect gating and the live projected dispatcher;
* cancellation: preserve request `AbortSignal` propagation, task-manager control, and honest uncertain-write reporting;
* rollout: native surfaces remain enabled until P-024/P-025 enumerate parity, P-017 proves it, steering and adoption telemetry ship, and a tested break-glass path exists.

# Parity checklist frozen by P-001

Later command- and script-parity work must evaluate at least:

1. cwd resolution and environment fidelity/redaction;
2. foreground and background lifecycle;
3. durable reattachment and how completion wakes or re-invokes the managed client;
4. interrupt and process-tree cancellation propagation;
5. foreground, background, transport, and script timeouts;
6. streaming, incremental reads, spill references, and aggregate output caps;
7. sandbox filesystem, credential, network, and process isolation;
8. permission UX, role/effect authorization, dry-run, and write uncertainty;
9. in-script parallel fan-out and child-failure isolation;
10. multimodal emitters and resource/reference returns;
11. PTY/session creation, input, resize, output, and termination;
12. retry ergonomics, typed errors, field-miss diagnostics, and current-schema replay;
13. client disable configuration, teaching-deny messages, adoption telemetry, and operator-down break-glass.

# Verification basis

This map was verified against the listed source files on staging on 2026-08-22. The Codex boundary was cited from the existing PG-projected agent-insights page rather than re-derived. The map records implementation ownership and reuse constraints; P-024 and P-025 own the client-by-client positive controls and rollout matrices.

# Persistent foreground JavaScript cells (2026-10-09)

The P-017 continuation of `managed-agent-capability-contract-and-native-cutover-2026-09-13` extends the existing `code:run` and tooldef worker. Native TUI features remain enabled under D-032/D-033; replacement readiness does not activate cutover.

`code:run { kernel: { op: "open" } }` returns a live id. Pass `kernel: { op: "run", id }` with a JavaScript script; `status` inspects that lifetime and `close` terminates it. An open call may also execute its first script. The host derives ownership from authenticated owner, workspace and harness context. The caller cannot supply or widen that scope.

Use `globalThis` for values needed in later cells. Live objects, functions and typed arrays persist in the same worker VM; declarations local to a cell do not. Each cell receives a fresh tool facade and dispatches under current authority. A function retaining an ended cell's dispatch closure is refused. Parallel cells on the same id are rejected, so state and caller contexts cannot interleave.

Each cell keeps the existing foreground budget, cancellation, uncertain-write accounting, console limits, summary shaping, result-door spill and explicit final image/audio contract. Retained media is emitted only when the current cell explicitly returns it; previous console/media output is not replayed. Cell-local sleep timers are cleaned up on completion. Timeout, caller cancellation or worker failure loses VM state; `close` also cancels active work. Idle workers expire after five minutes. A scope may hold four live workers, each with a 128 MiB V8 old-generation limit; this is not a total host-memory guarantee.

The lifetime is process-local. Restarting or routing to another operator process returns an explicit unrecoverable handle, not recovered state. There is no Python kernel, background-cell execution, lexical-declaration persistence or cross-process affinity guarantee. VM state changes are not replay-safe; kernel calls refuse dry-run and do not issue safe replay proofs or capture state-dependent cells as portable recipes.

The worker belongs to the operator process and does not spawn an independent OS job. Foreground completion uses the existing dispatcher/result path. A cell that launches a background command must use the existing capability/task-manager contract and durable task id; the kernel id is not a task id and does not replace task-manager process control or completion wakes. No new durable job or recipe store is introduced.

Canonical recurrence checks live in `libs/generic/tooldef/src/code-orchestration/persistent-kernel.test.ts` and `packages/operator-core/lib/agent-tools/code/run-kernel.test.ts`. The latter verifies retained final media and timeout state loss at the actual tool handler. Current-build API acceptance and cross-client acceptance remain separately recorded on WI-10007800 and P-015/P-020; these tests alone do not prove deployment or complete native parity.

# Managed browser observation (2026-10-09)

P-018 / WI-10007812 extends `capability:fetch` with a `browser` option rather than adding a second network or process-management service. Native TUI features remain enabled; no cutover stage is activated.

Use `browser: { op: "open" }` to create a fresh browser profile and return an id. An optional HTTP(S) `url` navigates the first page. Subsequent `navigate` calls require that id and a URL; `observe` reads the existing page; `close` retires its process. Optional `selector` waits for and observes a CSS target, `screenshot` emits a viewport PNG, and `max_text_chars` limits DOM text (default 10000, ceiling 20000). HTTP-only method, header, body and size/redirect arguments are rejected with browser operations. This interface provides navigation and observation; it does not claim click/fill, arbitrary evaluation, download, tab-management or cross-process recovery parity.

The server derives scope from verified owner, workspace and harness. Another scope cannot observe or close the id. Current boundary authority is checked at operation start, after launch, and at each relayed request. A change retires the session before another request. Concurrent operations on one id are refused. Pending launches count toward capacity: two per scope, sixteen globally. Idle expiry is five minutes. Completed or lost lifetimes return explicit unrecoverable state; a kernel/browser id is not a durable task id.

HTTP resources pass through the existing destination/DNS/address-pinning/method/credential/redirect policy. Browser redirects are returned manually so each destination enters that policy separately. POST and other remote writes are refused. WebSockets and service workers are blocked; downloads are disabled. Outside an active operation, HTTP relay is blocked, and finishing an operation aborts pending host fetches. No host browser profile or raw host credentials are inherited. Confined callers keep the existing execution sandbox requirement and fail closed when unavailable; Chromium uses the existing offline bwrap command, with network provided by the host policy relay. Trusted callers keep the existing raw fallback and receive explicit sandbox metadata. Raw fallback is not a claim of OS confinement.

Streamed resources preserve binary bytes and are capped at 2 MiB each, 16 MiB and 100 requests per operation. Returned text, links and viewport PNG are bounded; the existing result door still handles model-facing byte limits and spill. Remote DOM content is labelled external-untrusted. HTTP fetch can use arbitrary methods and browser lifetimes mutate state, so `capability:fetch` declares write effect: orchestration dry-run skips it and cannot issue a safe read-replay proof for a browser mutation.

The maintained Playwright launcher owns process-group close/kill and temporary profiles. The existing task ledger is registered before browser launch and receives PID identity and terminal facts. Its cgroup-confinement field stays false for an SDK process group; the separate execution-sandbox metadata describes bwrap. Explicit close is serialized with active cancellation and reports closed after process cleanup. Task-ledger persistence on the actual operator and unplanned host-restart cleanup remain acceptance obligations; the browser id itself cannot recover across operator processes.

Canonical tests are `browser-session.test.ts` and `browser-session.e2e.test.ts` under `packages/operator-core/lib/agent-tools/capability/`. The e2e test drives real Chromium/HTTP, dynamic DOM, redirects, rejected POSTs, PNG, repeated observation and controlled process close; only its ledger adapter is mocked. It writes no PostgreSQL data and uses the maintained e2e lane. PG-backed integration tests retain their own storage precondition. The isolated driver proof does not attest a deployed API, real ledger writes or a confined host's browser acceptance. Those remain on WI-10007812 and P-015/P-020.
