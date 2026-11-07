---
rel_path: "security/p003-confinement-architecture-preparation-20261106T0050Z.md"
updated_at: 1793926221320
_body: "content"
---

# P-003 handler confinement architecture preparation

Status: DRAFT_FOR_REVIEW — no implementation, design acceptance, SEC qualification or shipment claim.
Plan: app-security-runtime-boundaries-and-defense-in-depth-2026-10-31@papercusp.
Implementing work-item: WI-6554700010044292, self-owned and blocked by P-002.
Authority: Avi AUTO/direct, D-007 through D-010. No additional implementation agents.
Plan pin: immutable revision41/id84496, SHA2568ad52fe3c10ca55ecca0e9b5d79f2e075832d5b521d0bd4d995f1b399351cc40; mutable CAS38 is separate.
Contracts: accepted SEC-003-01r2#5ca2b5ba5d178984d8c3a0237b3c7fe5f7350da5c6eef3a54df6240948bbef1f and SEC-003-02r2#fc1620f3166eebab4b410d0b04680828c3358e3cc3e2a8383e7fc82de2a83c9c. Also preserve R-2/R-4/R-13 and all other original BARs.

## Outcome and scope

Ordinary handler code, dependencies and runtime startup extensions execute only inside an established OS boundary. Direct protected host-file, process, socket and network effects fail; authorized typed effects cross the existing host policy resolver. Preserve voice, streams, integrations and permitted collaboration. Unavailable confinement refuses before untrusted execution. A trusted exception requires explicit independently reviewed scope and is never labelled confined.

P-003 provides the restricted runtime and host proxy seams. P-004 owns complete typed-service migration. P-005/P-006 protect trusted services and release authority; P-016 completes budgets. These are real dependencies, not claims that a subprocess alone satisfies security.

## Measured existing routes

1. libs/generic/plugin-loader/src/loader.ts calls admitManifest before runtimeDispatch, locateEntry and importEntry. A runtimeDispatch result can return a shim without host import.
2. packages/plugin-loader/src/index.ts ordinary importPluginEntry uses createRequire in the host. WASM/daemon/manifest-only shims already exist in runtimeDispatch.
3. packages/plugin-loader/src/daemon/supervisor.ts provider mode always uses fixed bwrap. A completed failed probe refuses; an inconclusive probe still uses bwrap, which must establish the profile before its command executes. Legacy plugin mode can fall back to raw spawn.
4. packages/plugin-loader/src/daemon/bwrap-args.ts provider mode has read-only plugin/runtime/system mounts, private temp, network/PID/IPC isolation and cleared environment. It mounts broad /usr,/bin and has no post-bootstrap external-exec restriction. It is a reuse base, not complete R-2 proof.
5. packages/operator-core/lib/plugin-host-runtime.ts initializeDaemonPlugin does not select provider mode for ordinary action daemons.
6. Existing daemon/jsonrpc-bridge.ts already supports daemon-to-host requests. integrations/daemon-provider.ts binds host.fetch to live call tokens and source; reuse this transport and lifetime pattern while retaining the original host policy intersection.
7. capability/exec-sandbox.ts has SRT/bwrap adapters but intentionally raw flag-off/unavailable paths. It cannot be used unchanged as a strict ordinary-handler guarantee.
8. p2p/sandbox/os-user-isolation.ts and cgroup-limits.ts describe real provisioning/apply helpers used by a drill, explicitly not wired to production spawn. Reuse validated primitives when appropriate; do not report them as deployed handler enforcement.
9. design-phase.ts is a UI-oriented heuristic/lifecycle. The needsDesign=true row is not evidence that a security architecture belongs in UI JSON IR. This document does not set ignored/accepted or fabricate a UI spec.

## Proposed extension of existing seams

Host discovery parses bounded non-executable manifest data and resolves installation identity without importing entry/dependency code. Extend the existing runtimeDispatch to return an ordinary JS proxy under the enforcement posture. Use the existing supervisor/bridge for lifecycle and messaging. Do not add a parallel discovery service, policy store, daemon protocol or scheduler.

Trusted host code resolves an immutable runtime/bundle/dependency closure and an explicit enforcement profile. The guest must not receive a writable checkout, whole home, policy store, signing material, unrestricted runtime prefix or an agent-chosen mount. Validate symlink resolution, protect the snapshot from mutation, and bind its digest. Complete closure/authorship remains an explicit P-006/final acceptance obligation.

Before launch, the host provisions the boundary and limits, scrubs environment and inherited descriptors, and rejects untrusted NODE_OPTIONS, preload, loader, debugger and interpreter startup controls. Mount only required read-only runtime/bundle inputs, private bounded temporary storage and explicit IPC pipes. A host-owned readiness handshake reports established profile/runtime/bundle identity; host state, not guest assertions alone, decides whether invocation is admissible. Do not import handler code merely to discover its exported tools: manifest declarations and confined descriptor validation supply the proxy shape.

The trusted guest bootstrap validates the expected tuple and installs the final OS restrictions before any handler-controlled preload/module/native constructor/dynamic import/worker/interpreter file can execute. A proposed Linux implementation needs a maintained libseccomp binding with no_new_privs and all-thread synchronization. It must deny execve/execveat after trusted Node bootstrap and restrict process/namespace/ptrace/process-memory authority while allowing required runtime threads. clone3 pointer arguments and thread startup require explicit platform tests; do not assume a generic filter is Node-safe. This is an unresolved implementation choice, not a claim that such a maintained binding already exists here. JavaScript monkey-patching or Node permission flags alone are insufficient against native dependencies.

All ordinary guest routes use mandatory confinement; missing provider or final-filter setup never selects the legacy raw branch. Restart repeats the complete confinement/bootstrap sequence and invalidates old invocation channels. Explicit shell authority is a typed broker operation with scoped resources, not permission to spawn arbitrary guest processes.

The host binds each invocation channel to server-owned installation, caller/workspace, tool, argument digest, policy revision, capability intersection, cancellation/deadline and nonce/lifetime. Reuse P-002's production policy adapter and existing checked services. The guest cannot choose authenticatedPrincipal, host origin or bypass flags. Each protected effect revalidates live authority and normalized resource policy immediately before effect. Bound request schemas, output and queues; unknown methods, oversized messages, replay, cross-channel tokens and stale work refuse. Nested calls attenuate parent authority across async/background boundaries. This sketches P-004/P-007 migration obligations without claiming they are implemented by the transport.

Lifecycle teardown revokes channel authority first, cancels queued/broker work, terminates the confined descendant tree, and verifies no late host effects. Reuse validated cgroup/budget primitives; do not mistake a periodic disk check or killing only the immediate child for R-13 completion. Keep unrelated workloads in separate ownership envelopes.

## Platform qualification and preserved use

Linux starts with the provider profile plus narrowed immutable mounts and runtime-safe exec/process restrictions. Existing SRT/bwrap integration may supply maintained pieces; evaluate exact restrictions rather than copying its permissive fallback.

macOS requires a measured native adapter on actual maintained releases including 10.15. Existing SRT/Seatbelt dependency discovery is not enforcement evidence. A sandbox-exec binary being present is not proof that required process, socket, credential and startup restrictions hold. Inspect the maintained SRT adapter before choosing native integration. Windows needs the actual supported shipping population and a measured restricted-token/AppContainer/job implementation or equivalent; no such adapter was established by this selected-source read. Unknown is not N/A. No platform is silently dropped, and no broad enforcement claim is made from Linux tests.

Preserve long-lived voice/stream/integration journeys through explicit broker operations, lifetime/stream handles and cancellation, including reconnect/backpressure/authentication. Migrate ordinary first-party handlers as well as plugins. Any necessary trusted control-plane exception must be independently enumerated and reviewed; first-party provenance alone never grants a general bypass.

## Verification plan

Before qualification outcomes, use the same independently frozen P-001 manifest/applicability and tuple-ledger revision under Design Security population and proof contract v2. Current census inputs are provisional, not complete closure.

Maintained project tests must separately cover:
- Earliest-load sentinels in preload, direct module initialization, transitive/native constructors, dynamic import, worker/bootstrap and interpreter startup. Fail each setup stage; all untrusted sentinels stay absent. Execute the authorized post-confinement control.
- Real raw filesystem, process/native-addon, process-inspection, host Unix/abstract socket and outbound probes, observed by host canaries/listeners. Include read and mutation, alternate executable paths, symlinks and inherited descriptors. Pair each denial with an authorized control.
- Missing/broken confinement, probe failure/inconclusive spawn, final-filter failure, restarts and legacy-route substitution. A mutant that loads each class early or takes raw fallback must be killed by its named detector.
- Live channel/identity/resource substitution, replay and pre-effect revoke/cancel barriers. These become typed-service runtime tests in P-004/P-007, not generic bridge unit-test acceptance.
- Runtime threads, budgets, cancellation, descendant cleanup and unrelated-session survival; preserve supported normal journeys on each applicable row.

Bind each observation to exact source/test/fixture/loaded-runtime digests and stable row IDs. Distinguish infrastructure failure from a killed mutant. Local unit/integration tests are development proof until the independent pre-execution commitment and row-specific evidence exist. Final P-020 repeats applicable journeys on exact signed installed artifacts.

## Open decisions and next implementation gate

P-002 prerequisite and full independent acceptance remain open. Do not change its plan dependency or claim P-003 implementing/complete from this document. Before editing, declare changeKinds and acquire manual repo-relative file locks.

Unresolved: maintained runtime-safe exec/process filter binding; exact immutable Node/dependency closure; host IPC schemas and complete migration; each platform adapter; dedicated-principal provisioning/initial trusted bootstrap; budgets and complete population. Investigate these through the existing source/workflow first.

One substantial consult was requested after the source pass: conv-mw498hw2-0000-84e9d576f2d14becb1e738d07ea58170. It returned no_qualified_responder/no_available_responder; no review or answer is coming and it must not be treated as approval. Retrieval fallback yielded no exact seccomp match in the selected transcript read; no absence claim follows. Do not duplicate the unchanged consult.

All Apple Developer ID Application/Installer, authenticated complete authorship, initial administrator-trusted verifier, native10.15, independent SEC and exact signed-installed P-020 holds remain open. Avi was asked asynchronously whether final signed Mac shipment remains in scope while protected credentials are pending; until answered, preserve the original scope.

