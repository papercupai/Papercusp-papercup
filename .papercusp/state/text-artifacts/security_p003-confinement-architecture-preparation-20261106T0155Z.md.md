---
rel_path: "security/p003-confinement-architecture-preparation-20261106T0155Z.md"
updated_at: 1793929866989
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


## Continuation evidence — 2026-11-06T0101Z

This addendum supersedes the earlier selected-source uncertainty about an existing Windows candidate. It does not change the DRAFT_FOR_REVIEW status, P-002 dependency, accepted SEC contracts, or any platform qualification hold.

### Maintained SRT inspection

The executable /home/marsh-office/.local/bin/srt is a shell shim explicitly launching /home/marsh-office/.local/node25/bin/node and that prefix's @anthropic-ai/sandbox-runtime/dist/cli.js. A PATH npm root points elsewhere; its absence there is not absence of SRT. The installed package identifies version 0.0.74. These are installed-source observations, not a proof of package provenance or runtime qualification.

Linux dist/sandbox/linux-sandbox-utils.js lines1290–1340 documents a two-stage bwrap plus apply-seccomp path: the helper establishes a nested PID/user/mount boundary before exec of the workload. Its policy blocks Unix socket creation; README lines700–725 additionally describes io_uring syscall denial. The helper necessarily executes the command after loading this policy. This is NOT a post-Node-bootstrap external-execution/process filter. The exported SeccompConfigSchema (sandbox-config.js:878) accepts applyPath/argv0, which select the helper implementation; it does not specify arbitrary libseccomp syscall rules or a later in-process transition. Missing helper produces a warning path at linux-sandbox-utils.js:1371–1378. The SRT wrapper can also return the raw command when no restriction is requested. Mandatory handler admission must independently refuse incomplete enforcement; no flags or helper names establish it.

macOS dist/sandbox/macos-sandbox-utils.js:450–462 explicitly allows process-exec and process-fork. It has useful Seatbelt filesystem/network configuration and IPC restrictions, but cannot be treated unchanged as handler process confinement. A runtime-safe final policy transition and actual supported-release tests remain required. Inspect exact default Mach/IPC and process-inspection grants when narrowing this adapter.

Windows dist/sandbox/windows-sandbox-utils.js:1180–1287 is a concrete maintained candidate. Its srt-win helper uses a dedicated local sandbox user; README:535 describes a restricted token and job object in a two-hop launch, with WFP keyed to the user SID. This corrects only the earlier statement that no candidate was established by selected reads. Windows execution-denial equivalence, per-handler identity separation, ACL cleanup, descendant containment, supported platform population, initial provisioning and actual native operation are UNMEASURED. README:574 notes session-level allow grants rather than per-command allow overrides, and :575 documents proxy tokens on runner argv. A shared sandbox SID/session-wide ACL grants must not accidentally union authorities between isolated installations. No Windows runnable test was performed here.

The existing capability exec wrapper has required:true refusal before spawn, but its agent/build-purpose environment allowlist intentionally retains NODE_OPTIONS, PYTHONPATH, LD_LIBRARY_PATH and DYLD_LIBRARY_PATH. Do not reuse scrubExecEnv unchanged for ordinary handlers. Preserve the agent execution contract while giving trusted handler bootstrap a separate narrow profile through the existing provider/supervisor seam. Existing provisioning Seatbelt permits process-fork/process-exec, broad file-read and outbound traffic; that is provisioning behavior, not the desired ordinary-handler policy.

### Runtime-safe Linux filter candidate

Reuse libseccomp's maintained rule compiler rather than handwritten BPF. Content-bearing upstream reads of include/seccomp.h.in and seccomp_attr_set.3 confirm CTL_NNP=3 and CTL_TSYNC=4; TSYNC synchronizes all current threads and failure must abort load. Success requires exactly zero from each configuration/load operation. The API defaults TSYNC off, so it must be requested and verified. A process-local prctl-only filter is insufficient for Node's pre-existing threads.

Registry metadata: koffi 3.3.7 is a currently published Node FFI candidate (metadata modified 2026-11-05), dist.integrity sha512-Vrq4UwAE19HPLMou8m7HGCELiTE3l9D+r1nA7XwVHUTNaRdymPM+kzkkD2VGxlyjI2qZTb9tMDaFn7kfZ72v3Q==. Its README claims prebuilt tested Linux x64/arm64 glibc/musl and macOS support. This is a dependency-selection input, NOT validation of libseccomp behavior, Node compatibility, macOS10.15 support, packaging, authorship or signed closure. node-seccomp's last registry modification is 2022 and its version is0.0.2; seccomp is unpublished. No dependency was installed and no custom native binary/filter was added.

Candidate implementation would synchronously call pinned libseccomp through a maintained native bridge only in trusted guest bootstrap, before any handler/dependency constructor. The all-thread filter must irreversibly prohibit execve/execveat and non-thread process creation, process-memory/ptrace and namespace escapes while preserving runtime threads; clone3 requires a tested compatible denial/fallback. Bind architecture handling and alternative ABIs, errors and filter state to actual runtime tests. A simple deny-exec list alone is not a complete containment design. Unknown syscall, unsupported architecture, missing library, attribute failure, TSYNC failure or load failure refuses before handler load. The host boundary, minimal immutable mounts, descriptor sanitation and zero host network remain necessary. This is still an unresolved candidate until packaging and focused native tests prove the design.

### Exact installed-source pins

Root: /home/marsh-office/.local/node25/lib/node_modules/@anthropic-ai/sandbox-runtime
Observed: 2026-11-06T01:00:14.471687Z

- package.json sha256:56b6e8e64776210c40f5029df175bf168b6515d624aa52166a0480643accce76
- README.md sha256:2a83852f842317ebfd87f59fb67440d4242510ff5d847e1d7e45c4a9b34ce04b
- dist/sandbox/linux-sandbox-utils.js sha256:0ad385c497ab3f0e8b2ad903f90e826e27dd2bdb38cb9714f6a53036ae62c1e8
- dist/sandbox/macos-sandbox-utils.js sha256:040bd404987514a32027e68e12a40d4d0abe4fa48987e0c0ffb98f775e14f008
- dist/sandbox/windows-sandbox-utils.js sha256:9ac469e2dd54e3a82631307383205ae28b790e95c46a060694d81a5893dfcc55
- dist/sandbox/sandbox-config.js sha256:2ce6b3d66f17b7015a0fa4b3409398cfb4949e9be7219d612c73407731cb6c60
- vendor/seccomp/x64/apply-seccomp sha256:64fa7514fa7199584b836159885e59b9ce3684fb8fef7e13de49965b23f54f6b
- vendor/seccomp/arm64/apply-seccomp sha256:9ace43a76dab5650b5e544230814eaaac8f2136f4a40c2f6069f0631fee230e1

### Next prerequisite

Current original P-001 WI-6554700010044289 is open/unassigned with checkpoint0d55cbe84cc7. Its saved seven-population applicability and independently frozen tuple-ledger prerequisites remain unresolved. Follow its retained preflight and review WI5143 workflow, without rescanning source inputs or treating this source inspection as qualification. P-002 remains OPEN/self. P-003 stays preparatory/blocked; no implementation or acceptance transition was made. No unchanged suites were rerun, no extra implementers launched, no live gate operations entered.


## Native dispatch source bindings — continuation

The three previously unread files were read through the same native shell route after a fresh read-only authorization check succeeded in the canonical staging tree. Their bytes are retained in `security/p001-native-distribution-source-classification-20261106T0150Z.json@papercusp`, whose complete readback parsed successfully, matched the three added source records exactly and preserved the prior source records, candidates and population states.

| Declared route | Pinned source evidence | Design implication |
| --- | --- | --- |
| PTY spawn | Desktop `8dbe1613f64d555b733ab3a8cd6f8fcc1cd34ded`: `src-tauri/permissions/autogenerated/pty_spawn.toml`, SHA256 `3f7b207f8551bd238d2d87b3ee83ca971d63df4f5b02af26fd58b42923d15195`; root `42d905b5b2fcbea2bb651178a7ff3c905cf89626`: generated `tauri-bindings.ts` line89 invokes `pty_spawn` with `opts`. | The command allow/deny declaration has no preconfigured resource scope. Retain a distinct native process-effect route in the expected-surface preparation; measure effective caller/origin binding and resource authorization at the native chokepoint before qualification. |
| Endpoint IPC | Same desktop revision: `endpoint_invoke.toml`, SHA256 `8fdf187bd4124da93818ba8ae0dfeae23eb6401769a9093388a7b1119533ce3b`; generated root binding line195 invokes `endpoint_invoke` with `toolName`, `input`, `channel`. | The wrapper passes caller-supplied invocation data into a registered native command. Establish authenticated caller propagation and downstream policy before crediting confinement of the handler. A typed API alone supplies no authority evidence. |

The complete generated frontend file has SHA256 `746b79385565c5df4ee9cbe6c34bc1913927f05556428492d0556533e2013d49`. These separately pinned repositories have no measured matching installed-artifact identity. The existing default ACL and Rust command-registry reads remain valid source evidence; neither a configured loopback origin nor these wrappers establishes hostile-handler reachability or a current runtime grant.

The earlier authorization timeout remains an incident with unknown root cause. The successful bounded native reads establish recovery for these requests only; they do not close the incident or establish universal service health. No implementation, test run, confinement qualification, applicability approval or shipment transition occurred.

Current ownership correction: canonical P-001 `WI-6554700010044289` was read OPEN/self (`su-9aa0bac1-57ab-408e-a009-fd2b58012aa0`) this continuation. The older unassigned statement above is historical. P-002 remains the unchanged implementation dependency, and P-003 remains preparation. Next independent step is the retained expected-surface/applicability preparation, preserving the seven UNKNOWN population closures, exact precommit requirement and existing review5143 eligibility hold. Apple signing identities, complete authenticated authorship, trusted bootstrap, native10.15 and P-020 installed proof remain outstanding; the earlier async signed-Mac scope question is still pending.

