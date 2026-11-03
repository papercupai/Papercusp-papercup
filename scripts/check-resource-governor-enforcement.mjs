#!/usr/bin/env node
/**
 * Canonical capless resource-governor policy guard (P-012).
 *
 * This replaces capacity-limit linting. A numeric maximum is not proof that work
 * is safe; the proof is a governed admission/queue/state lifecycle. The inventory
 * is deliberately subsystem-complete and records the migration item that turns
 * each pending lane on. Once a lane is active, every resource start in its paths
 * must carry writer evidence in source.
 */
import { readFileSync } from "node:fs";
import { isCliEntry } from "@papercusp/operator-core/lib/util/cli-entry";
import { describeUnscanned, listTrackedFiles } from "./lib/tracked-files.mjs";
import { stripCommentsAndStrings } from "./lib/strip-comments-and-strings.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

export const RESOURCE_GOVERNOR_INVENTORY = Object.freeze([
  inventory({
    id: "agent-process-memory",
    migration: "P-013",
    enforcement: "active",
    paths: [
      "packages/operator-core/lib/agent-",
      "packages/operator-core/lib/fleet/",
      "packages/operator-core/lib/pty-",
      "apps/operator/scripts/psu-",
      // P-001 (spawn-door-governor-migration-2026-08-31, D-006): the lane's
      // prefixes covered every DOOR but not the two files holding the actual
      // child-start primitives, so a raw spawn() could be added there and the
      // scan would stay green. Measured before widening: console-spawn.ts
      // yielded resource-start-outside-admission with NO registry row, and
      // orchestrator-runner.ts already carried a row that was inert because
      // nothing scanned the path it names. Exact-file entries (the style the
      // P-015 lane uses) rather than a `lib/dbos/` prefix: only these two
      // files start a child, and a directory prefix would silently adopt
      // unrelated future files into an active lane.
      "packages/operator-core/lib/console-spawn.ts",
      "packages/operator-core/lib/dbos/orchestrator-runner.ts",
    ],
    resourceDimensions: ["cpu", "memory", "process", "pty"],
    fanOut:
      "one admission per agent process, one per pty child; nested tool starts inherit the parent AdmissionContext, so the Nth fleet member is attributed to the launch that created it rather than counted as an independent root",
    durableSource:
      "capability:launch-agent's idempotencyKey agent-spawn:<caller>:<spawnStartedAt>:<i>, and the fleet/plan work-item that commissioned the launch",
    telemetry:
      "admissionClass 'agent' and 'process' admission/queue depth, plus psu host liveness through coord presence sessionState",
    contextAndRelease:
      "spawnGovernedAgentProcess holds the execution across the child's whole lifetime and releases actual cost on exit; a throwing spawn calls execution.cancel so a failed start never leaks a reservation",
    currentCaps:
      "none on the governed door: the per-launch spawn ceiling was deleted when capability:launch-agent and fleet:launch-on-plan moved onto spawnGovernedAgentProcess, and psu-launcher/psu-pty-host hold no ceiling of their own. The lane's OTHER door, fleet/operator-spawn.ts spawnAgentInHarness, still enforces effectiveSpawnCeiling at its atomic admission cap: a USER-set maxSimultaneousAgents is an honoured deliberate throttle, while a SEED-sourced value resolves to the governor's live adaptive window instead of the boot-time host guess (WI-586538 / P-009), so it is never a frozen maximum — and over-ceiling spawns QUEUE on the D-004 wake key rather than being rejected. Routing that second door onto spawnGovernedAgentProcess is tracked residue (WI-590490), not a finished migration",
    writerEvidence:
      "beginGovernedExecution at spawn-execution.ts and pty-bridge.ts with AdmissionContext propagated into the spawned process; residual probe/release/ledger sites carry explicit BYPASS_REGISTRY rows",
    sites: [
      {
        path: "packages/operator-core/lib/agent-tools/capability/launch-agent.ts",
        start: "psu agent process — governed, admissionClass 'agent'",
      },
      {
        path: "packages/operator-core/lib/resource-governor/spawn-execution.ts",
        start: "spawnGovernedAgentProcess — the lane's admission seam",
      },
      {
        path: "packages/operator-core/lib/pty-bridge.ts",
        start: "pty child — governed, admissionClass 'process'",
      },
      {
        path: "packages/operator-core/lib/fleet/sidecar-exec-process.ts",
        start: "fleet sidecar exec — governed",
      },
      {
        path: "apps/operator/scripts/psu-launcher.mjs",
        start:
          "agent wrapper via spawnInherit — admitted upstream by launch-agent; probes bypass-registered",
      },
      {
        path: "apps/operator/scripts/psu-pty-host.mjs",
        start:
          "pty.spawn of the launched agent's own child — admitted upstream; bypass-registered",
      },
    ],
  }),
  inventory({
    id: "mcp-http-operator-transport",
    migration: "P-014",
    enforcement: "active",
    paths: [
      "packages/operator-core/lib/endpoint-",
      "packages/operator-core/lib/agent-tools/",
      "apps/operator/bin/",
    ],
    resourceDimensions: ["cpu", "memory", "socket", "process"],
    fanOut:
      "one admission per tool invocation that starts a subprocess; a tool called by an agent inherits that agent's context, so a fleet-wide tool storm attributes to its callers instead of appearing as unrelated roots",
    durableSource:
      "the tool_invocations ledger row for the call, plus the caller's own work-item; never an in-process request queue",
    telemetry:
      "per-tool admission counts and MCP proxy shed responses (HTTP 429 + Retry-After) surfaced as governor admission pressure",
    currentCaps:
      "none on the machine paths: the MCP proxy sheds with a retryable 429 under pressure instead of holding a fixed concurrency ceiling. ONE deliberate exception lives inside this prefix — INTERACTIVE launches (endpoint-route/routes/agent-mcp/console-launch.ts, adv/launch-su.ts) waive brain admission because the human IS the judgment (D-003), but still pass checkInteractiveSafetyFloor, the P-012 / D-013 deterministic concurrency floor: over-ceiling returns 429 with an actionable message, and the floor read fails OPEN so it can guard a human launch without ever gating one",
    contextAndRelease:
      "runGovernedOperation wraps each subprocess-starting tool and releases on settle; the host bootstrap admits its own long-lived listeners once at start",
    writerEvidence:
      "beginGovernedExecution across 21 agent-tools/endpoint writers (build/typecheck, db/migrate, computer, backup/diff, host-bootstrap); cheap git/probe metadata reads carry explicit BYPASS_REGISTRY rows",
    sites: [
      {
        path: "apps/operator/bin/host-bootstrap.ts",
        start: "operator host listeners — governed at boot",
      },
      {
        path: "packages/operator-core/lib/agent-tools/build/typecheck.ts",
        start: "tsc subprocess — governed",
      },
      {
        path: "packages/operator-core/lib/agent-tools/db/migrate.ts",
        start: "migration runner subprocess — governed",
      },
      {
        path: "packages/operator-core/lib/agent-tools/computer/computer.ts",
        start: "desktop automation subprocess — governed",
      },
    ],
  }),
  inventory({
    id: "inference-embedding-provider-batching",
    migration: "P-015",
    enforcement: "active",
    paths: [
      "packages/operator-core/lib/inference-",
      "packages/operator-core/lib/memory/embed-sidecar-server.ts",
      "packages/operator-core/lib/memory/embed-admission.ts",
      "packages/operator-core/lib/memory/bench/",
      "packages/operator-core/lib/llm-",
    ],
    resourceDimensions: ["cpu", "memory", "gpu", "network"],
    fanOut:
      "one admission per embedding batch and per provider request; a recall that fans into N provider calls must carry one parent context, not N roots",
    durableSource:
      "the memory/embedding job row that requested the batch; embed-admission already reads it rather than holding an in-memory backlog",
    telemetry:
      "embedding queue depth and provider latency/ratelimit state, with unknown preserved when a provider does not report",
    contextAndRelease:
      "embed-admission and the sidecar hold one durable admission per unit; provider responses remain live feedback and the gateway watchdog is observe-only, so no local cap is duplicated",
    currentCaps:
      "none on provider execution: gateway.ts uses maxConcurrent: 1 only for the per-account Codex permit-order queue around governor.acquire; ProviderAdmissionLifecycle controls the outer provider window dynamically, while watchdog.mjs only reads live admission state",
    writerEvidence:
      "governed writers: memory/embed-admission.ts, memory/bench/index-cap.ts, and memory/embed-sidecar-server.ts (embedding/inference per-unit runGovernedOperation); gateway-account-rate-pacing.test.ts verifies per-account permit priority; watchdog reads live provider state without admission",
    sites: [
      {
        path: "packages/operator-core/lib/memory/embed-admission.ts",
        start: "embedding batch — governed",
      },
      {
        path: "packages/operator-core/lib/inference-gateway/watchdog.mjs",
        start:
          "provider watchdog — observe-only live admission state; no capacity setting",
      },
    ],
  }),
  inventory({
    id: "database-sidecar-checkpoint-dbos",
    migration: "P-015",
    enforcement: "active",
    paths: [
      "packages/operator-core/lib/db/",
      "packages/operator-core/lib/dbos/queue-concurrency.ts",
      "packages/operator-core/lib/dbos/routines-workflow.ts",
      "packages/operator-core/lib/derived-",
      "packages/operator-core/lib/memory/embed-sidecar-",
    ],
    resourceDimensions: ["cpu", "memory", "database", "process"],
    fanOut:
      "one admission per DBOS workflow start and per sidecar process; a routine that fans into per-harness work must propagate one context so a 21-install sweep is not 21 unrelated roots",
    durableSource:
      "the DBOS workflow row and the routines table entry that scheduled it — both already durable, which is why this lane needs admission rather than a new queue",
    telemetry:
      "one prior-cohort org-admin pool probe per tick plus indexed ENQUEUED/PENDING routineFire counts by queue, durable pool-shed events, and per-routine fire/skip counts; pool exhaustion reads as feedback pressure, not as a terminal error",
    contextAndRelease:
      "sidecar process units carry durable Governor receipts and inherited AdmissionContext; DBOS queues have no local concurrency cap, preserve deferred work as unclaimed durable routine rows, and reopen starts from the next capless previous-cohort feedback epoch after subtracting real in-flight work",
    currentCaps:
      "no numeric ceiling in-lane; the effective limit is the Postgres connection pool, a physical upstream constraint to observe rather than duplicate",
    writerEvidence:
      "packages/operator-core/lib/memory/embed-sidecar-server.ts is governed per sidecar unit; dbos/queue-concurrency.ts removes the former fixed cap while dbos/routines-workflow.ts feeds physical pool health and indexed DBOS occupancy into CaplessAdaptiveController before claim/start and leaves withheld routine rows durably due",
    sites: [
      {
        path: "packages/operator-core/lib/dbos/bootstrap.ts",
        start:
          "DBOS workflow host — durable workflow state; queue capacity is delegated to governor/DB feedback",
      },
      {
        path: "packages/operator-core/lib/dbos/routines-workflow.ts",
        start:
          "routineFire workflow fan-out — one prior-cohort health epoch reads indexed DBOS in-flight rows before claim/start, then the loop spends only its credit",
      },
      {
        path: "packages/operator-core/lib/memory/embed-sidecar-server.ts",
        start:
          "sidecar inference units — durable embedding/inference admission per text",
      },
    ],
  }),
  inventory({
    id: "p2p-sync-index-cache-compaction",
    migration: "P-016",
    enforcement: "active",
    paths: [
      "packages/operator-core/lib/p2p/",
      "packages/operator-core/lib/sync/",
      "packages/operator-core/lib/search/",
    ],
    resourceDimensions: ["cpu", "memory", "network", "disk"],
    fanOut:
      "one admission per fetch/index/compaction pass; a multi-pot sync fans out per pot and must attribute to the sync that started it",
    durableSource:
      "the pot-git fetch cursor and the index generation record; compaction is restartable from them, so nothing needs an in-memory backlog",
    telemetry:
      "index lag, fetch bytes in flight, and compaction backlog age — with stale preserved rather than coerced to zero",
    contextAndRelease:
      "fetch transport owns its durable admission; index and compaction starts are either parent-admitted or explicitly dispositioned below, with release/control paths kept runnable under pressure",
    currentCaps:
      "no numeric ceiling in-lane; disk throughput is the physical upstream constraint and is observed, not duplicated",
    writerEvidence:
      "sync/pot-git/fetch-transport.ts is the governed writer; every other detected start has a path-and-finding disposition in BYPASS_REGISTRY and the active scan validates that registry strictly",
    sites: [
      {
        path: "packages/operator-core/lib/sync/pot-git/fetch-transport.ts",
        start: "git fetch transport — governed",
      },
    ],
  }),
  inventory({
    id: "ci-release-test-workers",
    migration: "P-016",
    enforcement: "active",
    paths: [
      "packages/operator-core/lib/release/",
      "apps/operator/lib/release/",
      "scripts/",
    ],
    resourceDimensions: ["cpu", "memory", "process", "disk"],
    fanOut:
      "one admission per test worker and per release step; the affected-tests runner fans out per workspace and propagates a single parent context so a 71-workspace run is one attributed tree",
    durableSource:
      "the test_runs ledger row per file and the release checkpoint record; a killed worker is re-derivable from them",
    telemetry:
      "per-worker CPU claim and suite wall-time, plus green-checkpoint gate health (consecutive reds, observed candidate)",
    contextAndRelease:
      "governed-test-process.mjs admits each worker and releases on exit; release/control children are parent-owned or explicitly dispositioned in BYPASS_REGISTRY, so no untracked worker remains",
    currentCaps:
      "no numeric worker ceiling; scripts/lib/governed-test-process.mjs replaced the former fixed worker count with admission",
    writerEvidence:
      "runGovernedTestProcess in scripts/lib/governed-test-process.mjs covers test fan-out; release/check helpers carry reviewed per-site parent/bypass evidence in BYPASS_REGISTRY",
    sites: [
      {
        path: "scripts/lib/governed-test-process.mjs",
        start: "test worker — governed admission seam",
      },
      {
        path: "scripts/affected-tests.mjs",
        start: "affected-suite fan-out — governed via the seam above",
      },
      {
        path: "apps/operator/lib/release/deploy-cli.ts",
        start:
          "release deploy — parent-owned admission; residual start is reviewed in the P-016 disposition registry",
      },
    ],
  }),
  inventory({
    id: "background-routines-watchdogs",
    migration: "P-016",
    enforcement: "active",
    paths: [
      "packages/operator-core/lib/system-health/",
      "packages/operator-core/lib/harness/routines/",
      "packages/operator-core/lib/events/",
    ],
    resourceDimensions: ["cpu", "memory", "database", "network"],
    fanOut:
      "one admission per routine fire; the ephemeral executor fans out per host and per install, so a fleet-wide tick must attribute to the tick rather than to each install separately",
    durableSource:
      "the routines table row (nextFireAt/lastFiredAt) — a skipped fire is recoverable from it, so a dropped tick must never be re-queued in memory",
    telemetry:
      "routine fire/skip/overrun counts and watchdog liveness, observed from OUTSIDE the routine process so a saturated main thread cannot self-report healthy",
    contextAndRelease:
      "routine fire owns a durable schedule record; each child start is parent-owned or a release/control operation explicitly dispositioned in BYPASS_REGISTRY, with no hidden resident queue",
    currentCaps:
      "no numeric ceiling; managedSetInterval makes timers visible in schedule:inventory but visibility is not control, which is why admission is still required",
    writerEvidence:
      "routine and system-health starts are covered by parent-scheduler or control-path dispositions in BYPASS_REGISTRY; the active scan now proves no unreviewed finding remains",
    sites: [
      {
        path: "packages/operator-core/lib/harness/routines/supervision-reconcile-action.ts",
        start:
          "supervision reconcile fire — systemd control/probe; residual start is reviewed in the P-016 disposition registry",
      },
      {
        path: "packages/operator-core/lib/system-health/index.ts",
        start:
          "health sweep — bounded system-health operation; residual start is reviewed in the P-016 disposition registry",
      },
    ],
  }),
  inventory({
    id: "governor-core",
    migration: "P-012",
    enforcement: "active",
    paths: ["packages/operator-core/lib/resource-governor/"],
    resourceDimensions: ["cpu", "memory", "process", "database", "network"],
    fanOut:
      "the governor itself starts no resource work; it MEASURES fan-out by minting the typed admissionClass and the child AdmissionContext lineage every other lane propagates",
    durableSource:
      "work_items-backed durable queue receipts — the record that lets capacity pressure queue instead of reject (D-001)",
    telemetry:
      "the governor health/admission/queue/resources/recovery snapshot, which preserves unknown and stale rather than coercing either to zero",
    contextAndRelease:
      "AdmissionContext is propagated to an exact Governor.release(actualDemand); the release path is deliberately never gated on admission so recovery stays runnable under saturation",
    currentCaps:
      "none by construction (D-002): desired admission windows and lease credit are transient feedback state with no upper bound",
    writerEvidence:
      "Governor.admit plus a valid local lease, AdmissionContext, Governor.release, and the governor state writer — all five present in execution.ts and spawn-execution.ts",
    sites: [
      {
        path: "packages/operator-core/lib/resource-governor/execution.ts",
        start: "beginGovernedExecution — the admission primitive",
      },
      {
        path: "packages/operator-core/lib/resource-governor/spawn-execution.ts",
        start: "spawnGovernedAgentProcess — the process-spawn wrapper",
      },
      {
        path: "packages/operator-core/lib/resource-governor/live-health-supervisor.ts",
        start: "live health sampling that feeds the admission window",
      },
    ],
  }),
]);

/**
 * D-004's exemption registry: "Control, release, and non-resident work bypass
 * explicitly. The registry owns exemptions and lint enforces them; callers cannot
 * self-exempt."
 *
 * Two design constraints, both load-bearing:
 *
 *   1. THE REGISTRY OWNS IT, NOT THE CALL SITE. There is deliberately no inline
 *      pragma (`// governor-exempt`). An exemption a caller can write next to its
 *      own spawn is self-exemption, which D-004 forbids in as many words. Adding a
 *      row here is a reviewable diff in a file whose whole purpose is being read.
 *
 *   2. KEYED BY (path, findingCode), NOT BY PATH. A file-level exemption is too
 *      coarse: `capability/bash-jobs.ts` genuinely bypasses admission for a control
 *      kill, but that says nothing about whether it also parks an unbounded resident
 *      queue. Exempting the file would silently retire a check nobody judged — the
 *      decorative-allowlist failure documented at length in
 *      check-no-unenrolled-detached-spawn.mjs ("an allowlist is evidence of what a
 *      guard was ASKED to ignore, never evidence of what it can SEE").
 *
 * `disposition` reuses the inventory vocabulary. Use `bypass` for work that cannot
 * materially increase residency, `upstream` when a physical constraint is observed
 * rather than duplicated, `semantic` for a policy limit that is not a capacity cap.
 * `false-positive` does NOT belong here — a detector that misfires is a detector bug
 * to fix, and registering it would preserve the bug behind a row that reads as
 * judgement.
 *
 * Shrinking this list is the point. Every row states what the process actually does.
 */
/**
 * P-016's active lanes include broad support paths (release helpers, routine
 * actions, drills, and CI scripts). A green scan is not evidence that those
 * paths were reviewed: it is only evidence when every finding has a central,
 * path-and-finding disposition. Keep this manifest explicit and keyed by the
 * exact detector code so a new start or queue cannot inherit a file-wide
 * exemption. Reasons are intentionally path-specific; a shared boilerplate
 * reason would make the review decorative.
 */
export const RESOURCE_GOVERNOR_SCANNER_PATH =
  "scripts/check-resource-governor-enforcement.mjs";
const INLINE_PROMISIFIED_RESOURCE_START =
  /\bpromisify\s*\(\s*(?:spawn|spawnSync|fork|execFile|execFileSync)\s*\)\s*\(/;
function resourceStartCallCount(source) {
  const code = stripCommentsAndStrings(source);
  const directStarts = [...code.matchAll(/\b(?:spawn|spawnSync|fork|execFile|execFileSync)\s*\(/g)].length;
  const inlinePromisifiedStarts = [
    ...code.matchAll(new RegExp(INLINE_PROMISIFIED_RESOURCE_START.source, "g")),
  ].length;
  return directStarts + inlinePromisifiedStarts;
}
// Counts child-process verb calls INCLUDING exec/execSync, for dispositions that
// pin "exactly one start" over the wider verb set. A call whose receiver is a
// regular-expression LITERAL (`/re/flags.exec(...)`) is RegExp#exec, never a child
// process, so it is not counted; a named regex (`RE.exec(...)`) or a namespace
// (`cp.exec(...)`) still is. Without this, parsing with a regex literal read as a
// second start and silently voided a reviewed disposition (WI-6554700010030439).
function childProcessVerbCallCount(code) {
  return [...code.matchAll(/\b(?:spawn|spawnSync|fork|execFile|execFileSync|exec|execSync)\s*\(/g)]
    .filter((match) => !(/^exec\s*\($/.test(match[0]) && /\/[dgimsuyv]*\.$/.test(code.slice(Math.max(0, match.index - 16), match.index))))
    .length;
}

export const P016_REVIEWED_DISPOSITIONS = Object.freeze([
  {
    path: "scripts/tauri-surface-verify-dao-workbench.mts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/tauri-surface-verify-dao-workbench.mts (EI-25462239328125754): an isolated native DAO Workbench acceptance driver, matching the existing reviewed native surface verifiers. It requires PAPERCUSP_VERIFY_TAURI_ISOLATED=1 and a verifier workspace/PG scope. Its single execFileSync primitive invokes the native bridge against an explicit target PID, waits for each call, and has a 65s deadline. It creates no detached worker or resident queue; the serving Tauri runtime is owned by the enclosing isolated verifier.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return resourceStartCallCount(source) === 1 &&
        source.includes("assert.equal(process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED, '1')") &&
        source.includes("assert.match(ws, /^verify-tauri-isolated-") &&
        source.includes("'--pid', process.env.VERIFY_TAURI_PID!") &&
        source.includes("timeout: 65_000") &&
        !/\bdetached\s*:\s*true/.test(code) && !/\bnew\s+(?:Worker|Piscina)\s*\(/.test(code) &&
        !hasCalledResourceStartAlias(code);
    },
  },
  {
    path: "scripts/workspace-host/reconcile-hosted-gcp-roles.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/workspace-host/reconcile-hosted-gcp-roles.ts: this is a directly invoked operator CLI, not a runtime lane. Its sole process start is one synchronous execFileSync('gcloud', ['auth', 'print-access-token']) call to obtain the operator's GCP credential; it is awaited to completion and returns one captured token. reconcilePapercuspHostedRoles then handles the two fixed role specs sequentially with in-process fetch calls and at most three attempts per role. It creates no worker, background task, or resident queue. The hosted-role repair is intentionally performed by an operator identity while the control plane only attests roles read-only (WI-10005251), so runtime admission would gate the explicit repair path without governing persistent capacity.",
  },
  {
    path: "scripts/share-source.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/share-source.mjs: this is an operator-invoked CLI that lists, adds, or removes collaborators on the private source-preview GitHub repo, not a runtime lane. Its only start is the `gh(args, env)` helper — one synchronous `spawnSync('gh', args, { encoding })` per GitHub API call, awaited to completion before the next and resolving to one captured stdout/stderr pair with nothing retained between calls. It never detaches a child, never runs inside the operator, bg-host, or a routine, and holds no queue; every call is a single short HTTPS request on behalf of a human at a terminal, so it adds no residency the governor could meter (WI-10003724).",
  },
  {
    path: "scripts/source-preview.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/source-preview.mjs: this is an operator-invoked export CLI (`npm run preview:*`) that materializes one pinned commit with git archive, gates it with audit-release-bundle, gitleaks and trufflehog, and publishes it as a single commit. It is not a runtime lane. Every start goes through the synchronous `run(cmd, args)` helper, or a direct `spawnSync('git', ...)` probe: awaited to completion before the next, bounded by an explicit maxBuffer, fail-closed (a non-zero exit throws PreviewError), and never detached. It never runs inside the operator, bg-host, or a routine, and it holds no resident queue; the work is one human-initiated export at a terminal (WI-10003724).",
  },
  {
    path: "scripts/check-tracked-src-entry-dist.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-tracked-src-entry-dist.mjs: this is a BUILD-TIME tracked-tree guard (WI-10002064 — a src-as-entry package tracking its own unreachable dist/, whose stale _bulk.js re-teaches a removed contract), not a runtime lane. Its only start is a single `execFileSync('git', args, { cwd, encoding, maxBuffer })` helper used to enumerate tracked paths; each call is synchronous, bounded by an explicit maxBuffer, awaited to completion before the next, and resolves to one captured stdout string with nothing retained between calls — so it adds no residency and no independent resident queue. Routing it through Governor.admit would be a category error: the governor admits contended RUNTIME capacity, whereas this process is a lint invoked by the release gate and by developers, and gating it would make the guard unrunnable in exactly the pressured conditions where a wrong tracked dist/ is most likely to ship. Same shape as the git-plumbing bypasses already reviewed for green-checkpoint-gen-check-self-heal.ts.",
  },
  {
    path: "scripts/verify-identities-r4.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/verify-identities-r4.mjs: this is P-015 R-4's acceptance VERIFICATION driver (an isolated, pointer-driven identity review journey against a disposable coord_presence/adv_sessions fixture), not a runtime lane. Its only start is the `checkedCommand` helper — one synchronous `execFileSync(command, args, { encoding, timeout: 45_000 })` per call, awaited to completion before the next and resolving to a single captured stdout string with nothing retained between calls, so it adds no residency and no independent resident queue. Every call site is explicitly bounded: a `git rev-parse HEAD` tree-head read, plus two `bash` settle/liveness probes under 45s and 15s timeouts. The driver cannot run outside `verify-tauri-headless.sh` at all — it throws on the missing VERIFY_TAURI_* env contract — so it only ever executes inside that script's own isolated Xvfb/devUrl/sidecar tree. Routing it through Governor.admit would be a category error for the same reason as the scripts/check-tracked-src-entry-dist.mjs bypass: the governor admits contended RUNTIME capacity, whereas this is an evidence-producing verification driver invoked by a developer or the acceptance gate, and gating it would make the verification unrunnable in exactly the pressured conditions where its evidence matters most.",
  },
  {
    path: "scripts/verify-identities-r3.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/verify-identities-r3.mjs: this is P-015 R-3's live self-drill VERIFICATION driver, the sibling of the reviewed verify-identities-r4.mjs row, run by hand in an observing session. Its starts are three synchronous execFileSync calls, each awaited to completion before the next and retaining only one captured stdout string: `node scripts/mcp-call.mjs` (one tool call, timeout 180s, 8 MiB maxBuffer), the production user-prompt-submit hook (timeout 30s, 8 MiB maxBuffer), and one `git rev-parse HEAD`. It holds no resident queue and adds no residency after it exits. Routing it through Governor.admit would gate an evidence-producing acceptance drill behind the runtime capacity it is meant to observe.",
  },
  {
    path: "scripts/verify-cloud-workspaces-aws.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/verify-cloud-workspaces-aws.mjs (WI-10005277): this is an isolated Tauri UI acceptance driver, not a serving or scheduled runtime. It requires PAPERCUSP_VERIFY_TAURI_ISOLATED=1, a private display >= :90, a live bridge PID, and verifier binaries before acting. Cloud list and mutation responses are intercepted by `window.__cwNative` fixtures; the evidence explicitly records `syntheticCloudResponses=true` and `realAwsLifecycleProven=false`, so the script starts no AWS worker or resource. Its only process-start primitive is `command()`, synchronous `execFileSync` with a 120-second per-child timeout. Every tauri-agent-tools, poll, bash, xdotool, and screenshot child is awaited to exit before the next call; it retains output only for this acceptance run, detaches no child, and holds no resident queue. It adds no independently managed runtime capacity for Governor.admit to meter.",
  },
  {
    path: "scripts/tauri-surface-verify-goal-report.mts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/tauri-surface-verify-goal-report.mts: this is an isolated Tauri UI acceptance driver launched by tauri-surface-verify-suite.sh through verify-tauri-headless.sh, not a serving or scheduled runtime. It requires PAPERCUSP_VERIFY_TAURI_ISOLATED=1. Its native and DOM-poll execFileSync calls are awaited with 60s/90s timeouts, and its sole longer-lived child is one ffmpeg screen recorder explicitly stopped in finally with SIGINT, awaited for exit, then SIGKILLed after a 10s bound. It creates no detached worker or resident work queue; the finite recorder exists only for this disposable acceptance run and adds no independently managed application capacity for Governor.admit to meter.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return (
        [...code.matchAll(/\b(?:spawn|spawnSync|fork|execFile|execFileSync)\s*\(/g)].length === 4 &&
        source.includes("assert.equal(process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED, '1'") &&
        source.includes("timeout: 60_000") &&
        source.includes("timeout: 90_000") &&
        code.includes("recording = spawn(") &&
        source.includes("recording.kill('SIGINT')") &&
        source.includes("recording!.once('exit'") &&
        source.includes("recording!.kill('SIGKILL')") &&
        source.includes("}, 10_000).unref()") &&
        !/\bdetached\s*:\s*true/.test(code) &&
        !/\bnew\s+(?:Worker|Piscina)\s*\(/.test(code) &&
        !hasCalledResourceStartAlias(code)
      );
    },
  },
  {
    path: "scripts/tauri-surface-verify-reports.mts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/tauri-surface-verify-reports.mts (EI-25357092317407008; third start reviewed under WI-10007542; fourth under WI-6554700010008629; fifth under WI-6554700010008580; sixth under EI-25822025814936255): disposable isolated Tauri acceptance, with no resident queue or detached worker. The native ledger preflight is a bounded SELECT-only child, and the two native bridge/poll execFileSync sites have 60s/90s deadlines. The committed native test files run through test:file, admitted upstream by runGovernedTestProcess. The runtime-vintage witness runs in one awaited Node child with a 60s deadline. The prepared source-snapshot bundle has its recorded SHA-256 checked before execFile, preserving the owned private workspace and discovery directory, a 300s deadline, and 4MiB output bound. The optional mutation probe invokes the maintained bounded mutation runner, then rechecks the receipt; the bundle-host preparation is also synchronous, receipt-attested, and bounded to 300s. That recipe retains its dependency-reader mutex and restricted-source checks. verifyVerifierSourceSync checks the archive before and after compilation; profile entries bind the resulting bytes to their source-root paths. Preparation does not consume or widen the native journey's 300s limit. All children are awaited and exit within the enclosing isolated verifier operation; none adds independent managed serving capacity.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return resourceStartCallCount(source) === 8 &&
        [...code.matchAll(/\bexecFileSync\s*\(/g)].length === 7 &&
        [...code.matchAll(/\bexecFile\s*\(/g)].length === 1 &&
        // Fifth start: the awaited native child, with its owned profile restored.
        source.includes("const env = nativeChildEnvironment(profile);") &&
        source.includes("execFile(process.execPath, [bundle, ...args], {") &&
        source.includes("assert.ok(prepared, 'Native child must be bundled from the verified source before the test starts')") &&
        source.includes("assert.equal(prepared.bundle, bundle,") &&
        source.includes("digest('hex'), prepared.sha256,") &&
        source.includes("cwd: sourceRoot, env, timeout: 300_000, maxBuffer: 4 * 1024 * 1024,") &&
        source.includes("return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {") &&
        source.includes("if (!error) { resolve({ stdout, stderr }); return; }") &&
        source.includes("assert.equal(env.PAPERCUSP_VERIFY_TAURI_ISOLATED, '1'") &&
        source.includes("profile.tauriPID === Number(env.VERIFY_TAURI_PID)") &&
        source.includes("execFileSync('npm', ['run', 'test:file', '--', ...testFiles],") &&
        source.includes("const testEnv = nativeTestDatabaseEnvironment(profile);") &&
        source.includes("const env = { ...testEnv, PAPERCUSP_TEST_RUN_COMMIT: receipt.sourceCommit,") &&
        source.includes("assert.equal(env.PAPERCUSP_SKIP_PG_DISCOVERY, '1'") &&
        source.includes("PAPERCUSP_TEST_PG_ADMIN_URL: address.toString()") &&
        source.includes("recordedDataDir === dataDir && port === address.port") &&
        source.includes("command[command.indexOf('-D') + 1] === dataDir") &&
        // Sixth start: finite frozen-source preparation, with no compiler fallback.
        source.includes("execFileSync('bash', [join(sourceRoot, 'apps/operator/bin/bundle-host.sh'), join(sourceRoot, script), bundle],") &&
        source.includes("{ cwd: sourceRoot, stdio: 'inherit', timeout: 300_000, env: testEnv }") &&
        source.includes("new Set(nativeScripts).size === nativeScripts.length") &&
        source.includes("receipt.files.some((entry: { path: string }) => entry.path === script)") &&
        source.split("verifyVerifierSourceSync(sourceRoot, receipt").length - 1 === 3 &&
        // Fourth start (WI-6554700010008629): the bounded runtime-vintage witness child.
        source.includes("await import('./packages/operator-core/lib/runtime-vintage.ts');") &&
        source.includes("verifyVerifierSourceSync(sourceRoot, receipt") &&
        source.includes("{ cwd: sourceRoot, stdio: 'inherit',") &&
        // Keep one isolation assert in each native-operation, committed-test, and Reports
        // fixture phase. Dropping any phase's assertion re-flags the source.
        source.split("assert.equal(process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED, '1'").length - 1 === 2 &&
        source.includes("assert.ok(pid && workspace && process.env.VERIFY_TAURI_POLL") &&
        source.includes("cwd: sourceRoot, stdio: 'inherit', timeout: 60_000, env: nativeLedgerEnvironment(),") &&
        source.includes("timeout: 60_000") &&
        source.includes("timeout: 90_000") &&
        !/\bdetached\s*:\s*true/.test(code) &&
        !/\bnew\s+(?:Worker|Piscina)\s*\(/.test(code) &&
        !hasCalledResourceStartAlias(code);
    },
  },
  {
    path: "scripts/fixmic.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/fixmic.mjs: an owner-invoked host audio RECOVERY command (EI-24190247768567149), not a runtime lane. Its starts are synchronous spawnSync calls through one `command()` helper to host audio tooling — `pactl` source reads, a bounded source-level measurement (timeout = durationMs, default 4s), and one `systemctl --user restart` of the pipewire/wireplumber units. Each is awaited to completion, nothing is retained between calls, and the process exits when recovery ends, so it adds no residency and no queue. Gating a repair of the owner's microphone behind contended agent capacity would make it unavailable exactly when the host is busy.",
  },
  {
    path: "scripts/run-carry-cohort.mts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/run-carry-cohort.mts: the P-005 carry-cohort runner's only detected start is the `git` helper — a synchronous `execFileSync('git', args, { cwd: REPO })` used for a handful of read-only repository reads (rev-parse and blob/path lookups that stamp instrument provenance on the cohort ledger). Each call is awaited to completion and returns one trimmed string; nothing is retained between calls and no child outlives its call. `node:child_process` is imported in this file for that helper alone; starts made by the modules it imports (carry-cohort-driver, psu-launcher) are judged at their own paths, not covered by this row. A read-only git probe adds no residency, so admission would only add a failure mode to the provenance stamp.",
  },
  {
    path: "scripts/tsc-service/server.mjs",
    code: "unbounded-resident-queue",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for scripts/tsc-service/server.mjs: the flagged `queue` is the shared typecheck service's list of pending requests, and its bound is observed upstream rather than duplicated. Each entry is created once per accepted client socket (later data on that socket is ignored), is marked cancelled when the socket closes, and is flushed in whole batches by drain(); a request body is capped at 1 MiB and MAX_REQUEST_FILES paths. So the queue length can never exceed the number of live client connections, and those clients are the gate's `lint:tsc --files` runs, which are themselves admitted by pc-heavy. The service is socket-activated and exits after PAPERCUSP_TSC_SERVICE_IDLE_SEC idle, releasing its memory. A second local cap would duplicate the client admission it already sits behind.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/stale-routine-executor-watchdog.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/harness/routines/stale-routine-executor-watchdog.ts: `runRestartCommand` execFiles the ptool CLI (`dev:restart --json -`) to auto-remediate a STALE routines-enabled bg-host executor. The start is bounded and awaited under an explicit timeout with a 4MB maxBuffer, writes its argument payload to stdin and closes it immediately, and resolves to a single {stdout, error} receipt; nothing is retained between calls, so it adds no residency and no independent resident queue. It must remain runnable while productive capacity is pressured because it is the recovery lever for an executor that has ALREADY stopped making progress — gating it on admission would queue the restart behind the very wedged capacity the restart exists to free. The restart it invokes is itself the governed dev:restart chokepoint, which owns drain/coalescing and its own authorize+reason audit trail.",
  },
  {
    path: "packages/operator-core/lib/release/admission-fix-precheck.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/release/admission-fix-precheck.ts: `defaultExec` is the injectable command-runner seam behind the checkpoint-tree precheck (callers may substitute their own via CheckpointTreeRunnerOptions.exec). Each start is a single awaited child under an enforced timeout, with combined stdout/stderr capped at 256KB, resolving to an explicit {code, signal, timedOut, durationMs} receipt; nothing is retained between calls, so it adds no residency, and it must stay runnable under pressure so an admission precheck can still reach a verdict.",
  },
  {
    path: "scripts/bench-release-task-reuse.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/bench-release-task-reuse.ts: this is a hand-invoked benchmark harness that shells out to read-only git plumbing to pin the source sha, gitlinks and source fingerprints for one controlled release-preparation measurement. The starts are bounded, awaited and non-mutating, they run only when a human runs the bench script rather than on any scheduled or serving path, and they create no resident queue.",
  },
  {
    path: "scripts/agent-capacity/gcp-rails.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/agent-capacity/gcp-rails.ts: the GCP test-project safety rails CLI (budget admission, labels, teardown sweep) for plan agent-capacity-and-cost-gcp-2026-09-30, run by hand. Its only start is the `gcloud` helper: one awaited execFile per Compute API call under a 300 s timeout, resolving to a captured stdout string with nothing retained between calls. The VMs it creates run in the cloud project, not on this host, so the start adds no local residency and no resident queue (WI-10004522).",
  },
  {
    path: "scripts/agent-capacity/load-driver.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for scripts/agent-capacity/load-driver.ts: the capacity benchmark's replay driver, whose detached agent sessions ARE the measured load (a heavy replay peaked at 18 GB). Admission is enforced before any session starts by assertHostAdmission (scripts/agent-capacity/host-admission.ts, tested in host-admission.test.ts): inside the Papercusp tree the run is refused unless it holds a scripts/pc-heavy.sh slot (PC_HEAVY_BYPASS=1), the admission every heavy job on this host goes through; elsewhere it runs only on a disposable ramp VM where the scripts are copied without the operator, so no governor exists and the VM is the measured machine. Concurrency is the caller's --agents N, each session is a transient user service in capdrv.slice, and the ramp reads that slice's OOM and slowdown as its saturation verdict (WI-10004522).",
  },
  {
    path: "scripts/agent-capacity/record-session.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for scripts/agent-capacity/record-session.ts: the capacity corpus recorder, which runs one real Claude or Codex session at a time through a recording proxy and starts it as a detached transient user service so its memory.peak and cpu.stat can be read. The same assertHostAdmission check as load-driver runs first: inside the Papercusp tree it refuses to start without a scripts/pc-heavy.sh slot (PC_HEAVY_BYPASS=1); on a ramp VM, which has no operator, it runs as the measured machine. Its other starts are awaited `--version` probes (the CLI's and node's, on the session PATH) under a 20 s timeout, awaited git reads, and a `systemctl kill` of its own session unit on timeout (WI-10004522).",
  },
  {
    path: "scripts/agent-capacity/session-process.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/agent-capacity/session-process.ts: `runAsync` spawns native `cp -a --reflink=auto` and `rm -rf` (copy workdir mode), or `sudo -n mount -t overlay` / `sudo -n umount` (overlay workdir mode, WI-10004672), to prepare a session work dir from a prepared checkout and remove it afterwards. Each child is awaited to its exit code, is not detached, and holds nothing after exit (an overlay mount is a kernel object the same session unmounts), so it adds no residency or queue of its own. It is called only by load-driver.ts and record-session.ts after their assertHostAdmission check, once per session they were already admitted to run (WI-10004522).",
  },
  {
    path: "scripts/agent-capacity/cost-model.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/agent-capacity/cost-model.ts (WI-6554700010030439): the capacity cost-model CLI's `--qualification-economics` read route. Its only start is one synchronous `spawnSync('python3', [<sibling>/vm/swap-tier.py, 'evaluate-workload', ...])` inside readTrialEconomics, once per selected economics option, re-deriving each option's verdict from retained, hash-checked qualification evidence instead of trusting a saved verdict. Each child runs to completion before the next under a 30 s timeout and a 4 MiB output cap; an error, signal or non-zero exit maps to an `unknown` verdict, and nothing is retained after the call returns. It runs only when an operator invokes the CLI by hand, never from a fleet path, so it adds no resident worker or queue.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return resourceStartCallCount(source) === 1 &&
        [...code.matchAll(/\bspawnSync\s*\(/g)].length === 1 &&
        source.includes("import { spawnSync } from 'node:child_process';") &&
        source.includes("const result = spawnSync('python3', [join(dirname(fileURLToPath(import.meta.url)), 'vm/swap-tier.py'),") &&
        source.includes("'evaluate-workload', '--out', resolve(root, option.qualification.directory),") &&
        source.includes("{ encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });") &&
        source.includes("if (result.error || result.signal || result.status !== 0) return { status: 'unknown' };") &&
        !/\bdetached\s*:\s*true/.test(code) && !/\bnew\s+(?:Worker|Piscina)\s*\(/.test(code);
    },
  },
  {
    path: "scripts/lib/pure-lane-proof-capture.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/pure-lane-proof-capture.mjs (gate-test-reuse-yield P-006, WI-10004717): the green-checkpoint's post-verdict capture of pure-lane test proofs. It has two starts. `defaultGit` runs synchronous read-only `git -C <root>` reads (`rev-parse HEAD`, `status --porcelain`) bounded by a 30 s timeout, SIGKILL and a 64 MiB maxBuffer; each exits before capture continues. `defaultRunSlice` is only the `spawnProcess` seam handed to runVitestProcess, which wraps every slice in runGovernedTestProcess with a declared memory and file-descriptor demand, the same governed launcher each `test:lane-pure` shard uses, so the vitest child is admitted there rather than here. Slices run one at a time, each awaited to exit and killed (SIGTERM, then SIGKILL 10 s later) past its timeout, and the loop stops before the next scheduled gate fire. Nothing is detached and no queue outlives the call.",
  },
  {
    path: "scripts/lib/schema-symbol-drift.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/schema-symbol-drift.mjs: the symbol-level judge that decides whether a regenerated libs/papercusp/libs/db schema voids a gate test proof. Its starts are synchronous `execFileSync` calls behind injectable `exec` seams. `gitReadAtSha` runs `git ls-tree` and `git show <sha>:<path>` reads, walking into submodule gitlinks, each bounded by a 30 s timeout, SIGKILL and a 64 MiB maxBuffer. `drizzleConstructionSmoke` runs one `node --import tsx -e` child (120 s timeout) that imports the two generated schema files and runs drizzle's eager relational-config construction, and the judge evaluates it at most once per run. Every call is awaited to exit and only returns text. Its one production caller is scripts/affected-tests.mjs (`gitSchemaDriftJudge`), which already runs inside the gate run or a pc-heavy test slot, so it adds no residency or queue of its own. Any read, git or smoke failure answers 'affected', the conservative verdict.",
  },
  {
    path: "scripts/lib/tsc-service.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/tsc-service.mjs (WI-10005362): the scoped lint:tsc client of the shared typecheck service. Its only starts are in `tscServiceTemplateSocket`, reached only when PAPERCUSP_TSC_SERVICE_UNIT_TEMPLATE is set (hosted workspace hosts): two synchronous `spawnSync('systemctl', ['--user', 'start' | 'show', <unit>])` calls against the caller's own user manager, each bounded by a 15 s timeout and awaited to exit before the client continues. Nothing is detached and no queue is kept. `systemctl --user start` only makes the per-checkout socket unit listen; the typecheck server it may socket-activate runs in its own systemd unit under the MemoryHigh/MemoryMax limits written by customerTscServiceInstallLines (libs/generic/deployment-driver/src/workspace-host-bootstrap.ts), the same shape as the tower's papercup-tsc-service unit, so its residency is bounded by that cgroup rather than by this client. Any start or show failure returns an error and the caller falls back to its own compile.",
  },
  {
    path: "scripts/lib/targeted-task-reuse.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/targeted-task-reuse.mjs: its only starts are synchronous `execFileSync` reads, `git` (120 s timeout, 64 MB maxBuffer) to fingerprint a task's inputs and `node -p process.version` (30 s timeout) to resolve the runner identity. Each is awaited to exit, not detached, and holds nothing after exit. Its callers are green-checkpoint.ts (`armTargetedTaskReuse`, inside the gate run) and scripts/affected-tests.mjs (inside a pc-heavy test slot or the gate run), both already admitted, so it adds no residency or queue of its own (EI-24538088938561684).",
  },
  {
    path: "scripts/lib/restricted-hold-preflight.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/restricted-hold-preflight.mjs (plan personal-data-reader-set-labels-2026-10-01 D-012; WI-10005713, WI-10005724): its only start is spawnCensus, ONE synchronous `spawnSync(process.execPath, ['--import', 'tsx', restricted-hold-preflight-cli.ts, ...])` (120 s timeout, 16 MiB maxBuffer) that reads the restricted-write census and refuses the test run while a disclosure is held. The parent blocks until the child exits, so it never runs concurrently with the work it guards, detaches nothing and holds nothing after exit. Its callers are scripts/test-files.mjs (spawned by testing:run's governed router start or a pc-heavy slot) and the vitest-root globalSetup in libs/test-config (inside runGovernedTestProcess or the gate run), both admitted; plus two pre-launch gates that run it BEFORE the live-tree work they guard starts: apps/operator/bin/bundle-restricted-hold-gate.mjs (from apps/operator/bin/bundle-host.sh, WI-10005745) and scripts/restricted-hold-tree-gate.mjs (from papercusp-desktop/bin/tauri-guarded dev and scripts/verify-tauri-headless.sh, WI-10005763). The attended desktop dev door has no admission of its own, but there the census is one timeout-bounded read that exits before the launch proceeds. Every caller runs it at most once per process, so it adds no residency or queue of its own. Pinned by matchesSource to that one timeout-bounded start: a second start in this file falls out of the exemption.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return [...code.matchAll(/\b(?:spawn|spawnSync|fork|execFile|execFileSync)\s*\(/g)].length === 1 &&
        /\bconst result = spawn\(process\.execPath,/.test(code) && /\btimeout:\s*timeoutMs\b/.test(code) &&
        !/\bnew\s+Worker\s*\(|\bnew\s+Piscina\s*\(|\.admit\s*\(|\bdetached\b/.test(code) &&
        !hasCalledResourceStartAlias(code);
    },
  },
  {
    path: "scripts/cloud-prod/provision-cloud-sql.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/cloud-prod/provision-cloud-sql.ts (plan cloud-portal-public-release-2026-10-13 P-004, WI-6554700010011217): an operator-run infrastructure-as-code CLI (plan | up | verify | status) that provisions the production Cloud SQL instance in GCP. It is not a runtime lane and nothing imports it at boot. Its only start is realGcloud: ONE `execFile('gcloud', args, { maxBuffer: 32 MiB, timeout: GCLOUD_TIMEOUT_MS })` per call, awaited to completion before the next call. It retains only that call's captured stdout/stderr, detaches nothing and holds no resident queue, so it adds no residency after it exits. The capacity it creates lives in Google Cloud, not on this host. Gating it behind Governor.admit would make the production database unprovisionable or unverifiable while the dev box is under load, which is a category error. Pinned by matchesSource to that one timeout-bounded start: a second start in this file falls out of the exemption.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return [...code.matchAll(/\b(?:spawn|spawnSync|fork|execFile|execFileSync)\s*\(/g)].length === 1 &&
        /\btimeout:\s*GCLOUD_TIMEOUT_MS\b/.test(code) &&
        !/\bnew\s+Worker\s*\(|\bnew\s+Piscina\s*\(|\.admit\s*\(|\bdetached\b/.test(code) &&
        !hasCalledResourceStartAlias(code);
    },
  },
  {
    path: "scripts/lib/committed-source-loader.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/committed-source-loader.mjs (plan personal-data-reader-set-labels-2026-10-01 D-012; WI-10005764, WI-10005802): the `--import` load hook makes the `spawnCensus` restricted-hold census child execute only committed bytes. Its only start is the `git(top, args)` helper: one synchronous `execFileSync(gitExecutable, ['-C', top, ...args])` site that reads `ls-tree -r HEAD` (once per checkout, cached), `check-ignore -q` (per untracked module), and `cat-file blob` (per differing module). The executable resolves through realpath to an absolute executable; each read has a 60 s timeout, is awaited, and leaves no resident child. The hook runs only inside the timeout-bounded restricted-hold census child, which already owns admission. The exact executable-resolution and single-read shape is pinned below.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return childProcessVerbCallCount(code) === 1 &&
        /\breturn execFileSync\(gitExecutable, \['-C', top, \.\.\.args\]/.test(source) &&
        source.includes("const COMMITTED_SOURCE_GIT_ENV = 'PAPERCUSP_COMMITTED_SOURCE_GIT';") &&
        source.includes("if (configured && !isAbsolute(configured))") &&
        source.includes("const resolved = realpathSync(candidate);") &&
        source.includes("accessSync(resolved, fsConstants.X_OK);") &&
        /\btimeout:\s*GIT_TIMEOUT_MS\b/.test(code) &&
        !/\bnew\s+Worker\s*\(|\bnew\s+Piscina\s*\(|\.admit\s*\(|\bdetached\b/.test(code) &&
        !hasCalledResourceStartAlias(code);
    },
  },
  {
    path: "apps/operator/lib/release/cut-seed-cli.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/cut-seed-cli.ts: this release/checkpoint operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "apps/operator/lib/release/workspace-host-release-cut-cli.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for apps/operator/lib/release/workspace-host-release-cut-cli.ts: every start here is the `runStep` helper — one `spawn` per release stage (pinned source checkout, vm-release sidecar build, deterministic pack, minisign sign plus independent verify, tar extract, SBOM/vulnerability audit, identity audit). Each is sequential, awaited to `close` before the next begins, writes into a per-stage log fd rather than an in-memory buffer, and retains nothing between calls, so the file adds no residency and starts no independent resident queue. The whole cut runs under ONE durable `class: 'deploy'` task that `openOperation` registers BEFORE any stage spawns (D-394 / WI-10002539 — 'the row first: a row with no cut is discoverable and harmless; a cut with no row cannot journal'), and that task owns admission, resumption and release for the operation as a whole, including the --task-id/--operation-id resume path. A per-stage receipt would double-count the same release work against a task already accounted for. Same shape as the substrate-sidecar-spawn.ts upstream disposition.",
  },
  {
    path: "apps/operator/lib/release/deploy-deps.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for apps/operator/lib/release/deploy-deps.ts: this release/checkpoint operation is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "apps/operator/lib/release/desktop-perf-gate.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/desktop-perf-gate.ts: its starts are awaited git metadata reads (15s timeout each) that the post-suite desktop-perf gate issues once per green-checkpoint verdict: `readNewestCommitAtMs` (one `git log -n 64 --format=%ct <ref>`, to age the measured build against main, WI-10003815) and `classifyBuildSha` (at most two `git rev-parse --verify` and two `git merge-base --is-ancestor`, to relate the build's recorded sha to the candidate and main, plan desktop-perf-measure-candidate-build-2026-09-29 P-002). They return scalars, retain nothing, start no resident queue, and sit behind an injectable IO seam that tests fake. The gate that calls them is fail-soft, so a failed read degrades the verdict to unknown rather than blocking; release/control metadata must stay runnable while productive capacity is pressured.",
  },
  {
    path: "apps/operator/lib/release/precut-containment-cli.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/precut-containment-cli.ts: an operator-invoked release CLI (`npm --prefix apps/operator run release:precut-containment`, WI-10002524 / WI-10004153) that answers one go/no-go question before a desktop cut: is every listed fix's blob in green main. Its only starts are synchronous local git metadata reads against the shared checkout: one `git rev-parse` per ref (main, staging), one `git show <ref>:<path>` per declared path and ref to compare blob contents and grep a marker, and one `git status --porcelain -- <path>` per path to spot uncommitted edits. The set is a few dozen paths, so the run is seconds of bounded local git with no network, no build and no resident process. It returns a table and an exit code, retains nothing, and writes nothing. A cut decision must stay answerable while productive capacity is pressured, so it is release/control metadata rather than a governed workload.",
  },
  {
    path: "packages/operator-core/lib/sync/pot-git/physical-drill-phase-h.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/sync/pot-git/physical-drill-phase-h.ts: the P-521 F3 (serving identity, drill leg H, WI-10003963) evidence verifier. Its one start is the `git(repoPath, args)` helper, a synchronous `spawnSync('git', ['--git-dir', repoPath, ...])`. `assertCanonicalRepoPath` confines repoPath to the drill's own Phase-A test pot bare repo. Per drill step it reads (show-ref, cat-file) and writes exactly one run-scoped test commit under `refs/namespaces/<device>/refs/heads/p521-phase-h-<step>-<runId>` (hash-object, mktree, commit-tree, update-ref). It refuses a ref that already exists, so it never moves an existing ref. It runs only inside the attended hive-git physical drill. There is no network, no build and no resident process, and each call returns one scalar or oid that the verifier folds into a pass/fail record. The rig itself is serialized by the hive-git-physical-rig resource lock, so the verifier adds only a handful of bounded local reads to an already exclusive, attended run.",
  },
  {
    path: "packages/operator-core/lib/sync/pot-git/physical-drill-phase-i.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/sync/pot-git/physical-drill-phase-i.ts: the P-521 F6-remainder protected-effect fencing check (drill leg I, WI-10003964). Its starts are the `sh(cwd, args)` and `tryRev(gitDir, ref)` helpers, both synchronous `spawnSync('git', ...)` in an absolute scratch directory the phase itself created and asserts exists (`assertDir`). They build and inspect throwaway local repos to prove that release promotion, origin push and fork/PR paths are refused, and they commit with a fixed test identity (COMMIT_ENV). They never touch the shared checkout, never reach a real remote and start no resident process. The phase runs only inside the attended physical drill, serialized by the hive-git-physical-rig resource lock, and its cost is a bounded handful of local git calls per drill run.",
  },
  {
    path: "packages/operator-core/lib/sync/pot-git/physical-drill-preflight.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/sync/pot-git/physical-drill-preflight.ts: the hive-git physical drill's read-only pre-run check (D-086, WI-10004088, WI-10004062), which verifies that the pinned drill source commit carries every drill file before the rig run starts. Its default gatherers are awaited `execFile` reads with explicit bounds: `git -C <repo> ...` metadata reads (status, show, ls-tree) with a 20s timeout and capped maxBuffer, and one `ssh -o BatchMode=yes -o ConnectTimeout=10 <vm>` probe of the VM owner's payload identity. They return scalars, retain nothing and start no resident queue. The gatherers sit behind injectable seams that the tests replace, and the preflight runs once per attended drill run, which the hive-git-physical-rig resource lock already serializes. A refused preflight blocks only that drill, never a productive lane.",
  },
  {
    path: "apps/operator/lib/release/git-ops.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/git-ops.ts: this release/checkpoint operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "apps/operator/lib/release/gitignored-asset-coverage.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/gitignored-asset-coverage.ts: this release/checkpoint operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "apps/operator/lib/release/green-checkpoint.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for apps/operator/lib/release/green-checkpoint.ts: this release/checkpoint operation is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "apps/operator/lib/release/record-release-cli.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/record-release-cli.ts: this release/checkpoint operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "apps/operator/lib/release/release-config.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/release-config.ts: this release/checkpoint operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "apps/operator/lib/release/release-content-scrub.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/release-content-scrub.ts: this release/checkpoint operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "apps/operator/lib/release/retrofit-hive-to-gate.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/retrofit-hive-to-gate.ts: this release/checkpoint operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "apps/operator/lib/release/runtime-workspace-build-coverage.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/runtime-workspace-build-coverage.ts: this release/checkpoint operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "apps/operator/lib/release/seed-identity-guard.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/seed-identity-guard.ts: this release/checkpoint operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/autoloop-release-readiness-action.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/harness/routines/autoloop-release-readiness-action.ts: this scheduled routine child is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/cargo-test-action.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/harness/routines/cargo-test-action.ts: this scheduled routine child is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/gc-verify-instances.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/harness/routines/gc-verify-instances.ts: this scheduled routine child is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/gitnexus-reindex-action.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/harness/routines/gitnexus-reindex-action.ts: this scheduled routine child is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/oddsmith-cron-shared.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/harness/routines/oddsmith-cron-shared.ts: runBounded is the shared bounded-spawn helper for the oddsmith routine actions (oddsmith-paper-cycle-action.ts, oddsmith-error-triage-autofix-action.ts), so every start it makes is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; the child is awaited, hard-bounded by timeoutMs with SIGTERM then SIGKILL across the whole process group, and leaves no independent resident queue, so adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/p2p-perf-actions.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/harness/routines/p2p-perf-actions.ts: this scheduled routine child is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/project-history-refresh-action.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/harness/routines/project-history-refresh-action.ts: this scheduled routine child is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/release-actions.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/harness/routines/release-actions.ts: this scheduled routine child is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/task-reconcile-action.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/harness/routines/task-reconcile-action.ts: this scheduled routine child is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/template-gym-runner.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/harness/routines/template-gym-runner.ts: this scheduled routine child is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/p2p/delegated-spawn-honor.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/p2p/delegated-spawn-honor.ts: this bounded support-path operation is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/p2p/sandbox/drill.ts",
    code: "resource-start-outside-admission",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for packages/operator-core/lib/p2p/sandbox/drill.ts: its finite sandbox drill subprocess is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "packages/operator-core/lib/p2p/sandbox/network-egress.ts",
    code: "resource-start-outside-admission",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for packages/operator-core/lib/p2p/sandbox/network-egress.ts: its finite sandbox drill subprocess is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "packages/operator-core/lib/p2p/sandbox/os-user-isolation.ts",
    code: "resource-start-outside-admission",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for packages/operator-core/lib/p2p/sandbox/os-user-isolation.ts: its finite sandbox drill subprocess is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "packages/operator-core/lib/release/checkpoint-qualification-transaction.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for checkpoint-qualification-transaction.ts: it has one timeout-bounded, awaited systemctl is-active probe for an already-recorded runner and one awaited git helper that validates the immutable candidate with up to three sequential ref/status probes. Both use 5s timeouts and a 1MiB output bound; they inspect existing release/checkpoint state and create no worker or resident queue, so the control path remains available under productive-work pressure.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return resourceStartCallCount(source) === 2 &&
        source.includes("await promisify(execFile)('systemctl', ['--user', 'is-active', unit], {") &&
        source.includes("const git = async (...args: string[]) => (await promisify(execFile)('git', ['-C', input.root, ...args],") &&
        source.includes("timeout: 5_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }") &&
        source.includes("await git('rev-parse', '--show-prefix')") &&
        source.includes("await git('rev-parse', '--verify', 'HEAD')") &&
        source.includes("await git('status', '--porcelain', '--untracked-files=normal')") &&
        source.includes("timeout: 5_000,") &&
        source.includes("if (!unit) return 'unknown';") &&
        !/\bdetached\s*:\s*true/.test(code) &&
        !/\bnew\s+(?:Worker|Piscina)\s*\(/.test(code) &&
        !hasCalledResourceStartAlias(code);
    },
  },
  {
    path: "packages/operator-core/lib/release/checkpoint-required-ancestor.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/release/checkpoint-required-ancestor.ts: this release/checkpoint operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/release/dependency-generation-prebuild.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/release/dependency-generation-prebuild.ts: this release/checkpoint operation is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/release/green-stall-watchdog.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/release/green-stall-watchdog.ts: this watchdog probe/control operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/release/in-flight-retriage.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/release/in-flight-retriage.ts: this release/checkpoint operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/release/worktree-coverage-watchdog.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/release/worktree-coverage-watchdog.ts: this watchdog probe/control operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/search/import-graph.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for packages/operator-core/lib/search/import-graph.ts: its graph traversal worklist is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/boot.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for packages/operator-core/lib/sync/hyperbee/boot.ts: its pending-membership retry set is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/perf/child-driver.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/sync/hyperbee/perf/child-driver.ts: this finite performance harness subprocess is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/perf/netem-inner.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/sync/hyperbee/perf/netem-inner.ts: this finite performance harness subprocess is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/perf/peer-child.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for packages/operator-core/lib/sync/hyperbee/perf/peer-child.ts: its bounded IPC line buffer is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/perf/provenance.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/sync/hyperbee/perf/provenance.ts: this finite performance harness subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/perf/scenarios/netem.ts",
    code: "resource-start-outside-admission",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for packages/operator-core/lib/sync/hyperbee/perf/scenarios/netem.ts: its finite performance harness subprocess is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/seed-provider-corestore.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/sync/hyperbee/seed-provider-corestore.ts: this bounded git seed operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/seed-provider-git.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/sync/hyperbee/seed-provider-git.ts: this bounded git seed operation is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/substrate-ipc-client.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for packages/operator-core/lib/sync/hyperbee/substrate-ipc-client.ts: its in-flight RPC correlation map is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/substrate-sidecar-spawn.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/sync/hyperbee/substrate-sidecar-spawn.ts: this bounded support-path operation is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/sync/pot-git/chunked-blob-scan.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for packages/operator-core/lib/sync/pot-git/chunked-blob-scan.ts: this module EXISTS to impose the very bound the rule hunts for (WI-6254/WI-6258 — `partitionBlobsForScan` splits the admissible range into `chunkBytes` groups so that peak resident content is ONE chunk rather than the whole range, written after ref-announce's OOM took the whole sidecar down). The flagged structures are per-chunk working sets: `groups`/`current` live only across the partition pass, and `files`/`binaryOids` hold one `cat-file --batch` frame that the caller consumes and drops with the chunk — none survives the chunk or starts independent resident work. The one structure that DOES persist is bounded and instrumented rather than unbounded: the verdict memo is capped at `BLOB_SCAN_VERDICT_CACHE_MAX` (100_000) inside `pinModuleState`, `recallVerdict` re-inserts on hit for LRU recency, `rememberVerdict` evicts the oldest key while `size > max`, and the drops are counted and published through `getBlobScanCacheStats().evictions` — a capped memo publishing honest state, not a resident queue.",
  },
  {
    path: "packages/operator-core/lib/sync/pot-git/gate/shards.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for packages/operator-core/lib/sync/pot-git/gate/shards.ts: its dependency traversal stack is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "packages/operator-core/lib/sync/pot-git/physical-drill-host-receipt.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/sync/pot-git/physical-drill-host-receipt.ts: this physical-drill evidence probe is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/sync/pot-git/physical-drill-phase-a.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/sync/pot-git/physical-drill-phase-a.ts: this physical-drill evidence probe is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/sync/pot-git/physical-drill-phase-b.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/sync/pot-git/physical-drill-phase-b.ts: this physical-drill evidence probe is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/sync/pot-git/storage.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/sync/pot-git/storage.ts: this bounded support-path operation is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/system-health/compute.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/system-health/compute.ts: this system-health probe/run is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/system-health/rtk-liveness.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass for packages/operator-core/lib/system-health/rtk-liveness.ts: one synchronous `rtk --version` probe per hourly installed-hook-drift sweep (WI-6554700010009291), capped at a 5-second timeout and awaited in-line; it starts no resident work and runs no user command.",
  },
  {
    path: "packages/operator-core/lib/system-health/desktop-perf-scheduled-run.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/system-health/desktop-perf-scheduled-run.ts: this system-health probe/run is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/system-health/gui-e2e-surface-scheduled-run.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/system-health/gui-e2e-surface-scheduled-run.ts: this system-health probe/run is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/system-health/single-primary-check.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/system-health/single-primary-check.ts: this system-health probe/run is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/affected-tests.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/affected-tests.mjs: its affected-test selection list is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "scripts/burst-probe.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/burst-probe.ts: its finite benchmark fan-out list is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "scripts/cdp-inspector.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/cdp-inspector.mjs: its CDP request correlation map is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "scripts/check-assert-integrity.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/check-assert-integrity.mjs: its assertion graph worklist is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "scripts/check-bundle-budget.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-bundle-budget.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-conflict-markers.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-conflict-markers.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-declared-deps-extracted.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-declared-deps-extracted.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-di-seam-arity-strands.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-di-seam-arity-strands.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-docs-mirror.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-docs-mirror.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-drizzle-drift.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-drizzle-drift.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-env-feature-gates.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-env-feature-gates.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-fixed-but-open.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-fixed-but-open.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-fleet-auth.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-fleet-auth.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-format.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-format.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-full-replacement-mocks.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-full-replacement-mocks.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-guidance-returns-schema.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-guidance-returns-schema.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-host-bundle-builds.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-host-bundle-builds.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-js-syntax.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-js-syntax.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-licenses.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-licenses.mjs (WI-10003906): the license gate's children — `cargo metadata --locked` for the Rust leg, `tar -xf` + `syft` for the report-only installer leg — are synchronous execFileSync calls, each with an explicit timeout, awaited before the next step. It runs as a CI/release guard invoked from the command line, creates no detached worker or resident queue, and must stay runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-lint-guard-reachability.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-lint-guard-reachability.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-mac-bash-portability.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/check-mac-bash-portability.mjs: its portable-file traversal worklist is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "scripts/check-mdx.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-mdx.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-migration-fixture-drift.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-migration-fixture-drift.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-migration-forward-compat.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-migration-forward-compat.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-no-box-identity.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-no-box-identity.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-no-cdn-egress.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-no-cdn-egress.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-no-control-bytes.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-no-control-bytes.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-no-identity-literals.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-no-identity-literals.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-no-nul-in-source.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-no-nul-in-source.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-no-owner-name-tags.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-no-owner-name-tags.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-no-proc-path-fixture.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-no-proc-path-fixture.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-no-raw-harness-sentinel.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-no-raw-harness-sentinel.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-optional-seam-strands.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-optional-seam-strands.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-pipefail-sigpipe.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-pipefail-sigpipe.mjs: its single `git ls-files -z '*.sh'` enumeration of tracked shell scripts is bounded and awaited, creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-required-field-strands.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-required-field-strands.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-retired-resurrection.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-retired-resurrection.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-scope-defaults.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-scope-defaults.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-submodule-coverage-ignore.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-submodule-coverage-ignore.mjs (found by the gate on the frozen candidate, WI-212675): its only start is ONE synchronous, awaited `execFileSync('git', ['check-ignore', '-q', <probe path>])` per invocation — a CI/guard helper probing whether the coverage sentinel is gitignored. It is bounded by the single probe, holds no resident queue, and must remain runnable while productive capacity is pressured because it is part of the release gate's own lint leg.",
  },
  {
    path: "scripts/check-sidecar-fallback-reported.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-sidecar-fallback-reported.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-sql-guidance-justified.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-sql-guidance-justified.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-systemd-dropins-installed.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-systemd-dropins-installed.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-tracked-node-modules.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-tracked-node-modules.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-ungated-mug-kettle.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-ungated-mug-kettle.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-unreachable-tier-mock.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-unreachable-tier-mock.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-vacuous-negative-assertions.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-vacuous-negative-assertions.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-vimock-export-strands.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-vimock-export-strands.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-vite-externalized-warnings.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-vite-externalized-warnings.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-workspace-default-sql.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-workspace-default-sql.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-workspace-deps-complete.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-workspace-deps-complete.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/content-lint-runner.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/content-lint-runner.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/gate-liveness-sentinel.mts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/gate-liveness-sentinel.mts (plan green-main-cycle-time-2026-10-08 P-023): the out-of-operator red-gate liveness alarm, one tick per systemd timer fire. Its only start is ONE awaited `execFile(file, args, { cwd: ROOT, timeout: timeoutMs, ... })` used for two alarm deliveries — the mcp-call notifications:send_owner client (90 s) and notify-send (15 s) — at most once each per tick, and only while a breach is open. It must stay runnable when the operator and productive capacity are down, because that outage is exactly what it reports; it detaches nothing and holds nothing after exit. Pinned by matchesSource to that one timeout-bounded start.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return [...code.matchAll(/\b(?:spawn|spawnSync|fork|execFile|execFileSync|exec|execSync)\s*\(/g)].length === 1 &&
        /\bexecFile\(file, args, \{ cwd: ROOT, timeout: timeoutMs\b/.test(code) &&
        !/\bnew\s+Worker\s*\(|\bnew\s+Piscina\s*\(|\.admit\s*\(|\bdetached\b/.test(code) &&
        !hasCalledResourceStartAlias(code);
    },
  },
  {
    path: "scripts/gen-agent-env.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/gen-agent-env.ts: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/gen-declarations.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/gen-declarations.ts: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/lib/stale-declaration-suppressions.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/stale-declaration-suppressions.ts: importerSources is a build-time helper called by gen-declarations.ts to diagnose newly unused TypeScript suppressions. Its sole process start is one synchronous execFileSync('git', ['-C', repoRoot, 'grep', '-l', '-F', ...patterns, '--', ...importerGlobs]) over the finite tracked source tree, with captured output bounded by maxBuffer. The caller awaits that metadata search before the in-process suppression scan; an empty module set starts nothing, exit 1 means a measured empty result, and other failures remain null/not-measured. It starts no detached worker, provider request, runtime schedule, or resident queue; admitting this local build metadata read would gate the diagnostic rather than govern persistent capacity.",
  },
  {
    path: "scripts/gen-doc-projections.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/gen-doc-projections.ts: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/gen-lib-api-docs.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/gen-lib-api-docs.ts: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/gen-tool-routing.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/gen-tool-routing.ts: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/guard-shared-tree-install.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/guard-shared-tree-install.mjs: its only detected start is a `git` plumbing read wrapped in execFileSync with an explicit 5s timeout, awaited and exiting immediately; this install guard must remain runnable precisely when capacity is pressured, and governing a metadata read would cost more than the admission record it would write.",
  },
  {
    path: "scripts/lexicon-residual-count.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lexicon-residual-count.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/lib/cargo-result.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/cargo-result.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/lib/declaration-export-parity.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/declaration-export-parity.ts: its only start is `ignoredUntrackedPaths`, one synchronous `git ls-files --others --ignored --exclude-standard --directory -z` metadata read per guard invocation (30s timeout, 64 MiB buffer, stdin ignored). It is awaited to completion, retains nothing between calls, starts no resident queue, and fails OPEN to an empty set so a git failure makes the parity guard walk more declarations, never fewer (EI-24553552437295746). A CI/guard metadata read must stay runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/lib/doc-projection.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/doc-projection.ts: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/lib/identity-leak-patterns.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/identity-leak-patterns.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/lib/passing-task-verdict-cache.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/lib/passing-task-verdict-cache.mjs: its TTL verdict cache is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "scripts/lib/related-tests.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/lib/related-tests.mjs: its `pending` module-graph traversal worklist is finite build-time correlation state, not a resident resource queue — every entry is popped and consumed, deduplicated against the `visited` set, and confined by `insideRoot` to tracked files under the repo root, so the queue is bounded by the finite import graph and starts no independent resident work.",
  },
  {
    path: "scripts/lib/tsc-baseline-gate.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/tsc-baseline-gate.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/lib/typecheck-fanout.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/typecheck-fanout.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/lint-affected-gate.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lint-affected-gate.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/lint-as-committed.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lint-as-committed.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/lint-tsc-workspaces.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lint-tsc-workspaces.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/measure-carry-note-population.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/measure-carry-note-population.mjs: its carry-note analysis list is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "scripts/npm-install-safe.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/npm-install-safe.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/okf-backfill-insights.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/okf-backfill-insights.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/patch-coverage.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/patch-coverage.ts: its only start is a single synchronous execFileSync `git diff --unified=0` that computes the added-line set for the patch-coverage report. execFileSync blocks its own caller, so the child is awaited by construction and cannot outlive the call; the file declares no interval, worker, detached spawn or unref, so it parks no resident queue and cannot materially increase residency while productive capacity is pressured.",
  },
  {
    path: "scripts/pg-autotune.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/pg-autotune.ts: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/plugin-mirror-export.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/plugin-mirror-export.mjs: its only starts are synchronous execFileSync `git ls-tree` / `git show` metadata reads of one committed plugin package. execFileSync blocks its caller, so each child is awaited by construction and cannot outlive the call; the file declares no interval, worker, detached spawn or unref, so it parks no resident queue and cannot materially increase residency while productive capacity is pressured.",
  },
  {
    path: "scripts/proc-guard.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/proc-guard.mjs: its process inspection worklist is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "scripts/publish-official-blueprints.mts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/publish-official-blueprints.mts: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/publish-workspace-host-artifacts.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/publish-workspace-host-artifacts.mjs: its single `gh auth token` credential read is bounded and awaited (synchronous execFileSync that prints and exits), creates no independent resident queue, and must remain runnable while productive capacity is pressured — the same class as scripts/check-fleet-auth.mjs.",
  },
  {
    path: "scripts/repair-stale-generated-artifacts.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/repair-stale-generated-artifacts.ts: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/report-cargo-tests.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/report-cargo-tests.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/scan-catastrophic-deletion-commits.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/scan-catastrophic-deletion-commits.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/stats-proof.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/stats-proof.ts: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/templates-mirror-sync.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/templates-mirror-sync.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/time-travel-probe.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/time-travel-probe.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/with-test-pg.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/with-test-pg.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/workspace-test.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/workspace-test.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  // ── EI-21921643279095147: dead-target / dead-citation / drift sweep routines,
  // the frozen-candidate converge helper, three new CI lint scripts, and one
  // ephemeral manual diagnostic — all new P-016-lane files as of 2026-08-30.
  {
    path: "packages/operator-core/lib/harness/routines/dead-citation-sweep-action.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/harness/routines/dead-citation-sweep-action.ts: execFileAsync(git ls-files) lists tracked *.md/*.ts/etc paths as a cheap pre-filter before the in-module dead-citation scan; awaited, exits immediately, creates no independent resident queue.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/dead-target-probe.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/harness/routines/dead-target-probe.ts: execFileAsync(git rev-parse --verify --quiet HEAD^{commit}) and (git status --porcelain --untracked-files=no) are two bounded, explicitly-timed-out reads (probeTimeoutMs) run per install per sweep to classify an install's git object store as readable/corrupt/absent/unknown; both are awaited, read-only, and create no independent resident queue.",
  },
  {
    // frozen-candidate-stays-frozen-through-all-fixes-2026-09-03 P-003 / D-010: this is the
    // read-only half of the former converge-repair-head.ts (renamed when the fast-forward plan
    // was deleted); the disposition below carries over with the code it describes.
    path: "packages/operator-core/lib/release/judged-sha-containment.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/release/judged-sha-containment.ts (formerly converge-repair-head.ts): the GitProbe implemented here is read-only — spawnSync(git rev-parse --verify --quiet), spawnSync(git merge-base --is-ancestor), and a rev-parse blob lookup. This module only answers whether the judged sha CONTAINS a path's blob; it performs no fast-forward, merge, or push itself, and creates no independent resident queue.",
  },
  {
    path: "packages/operator-core/lib/release/repair-head-admission.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/release/repair-head-admission.ts (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03 P-001, the ONE door a fix enters the frozen lineage through): every start is a short synchronous spawnSync('git', …) plumbing call awaited to completion — rev-parse, ls-tree, read-tree/update-index/write-tree against a throwaway temp index, diff-tree (the allowlist proof), and commit-tree — followed by one update-ref. It runs once per explicit `release:repair-queue { op:'admit' }` call under the caller's own admission, holds nothing resident, and creates no independent queue; a resident Governor lease here would gate the gate's own repair path behind the resource it is trying to un-wedge.",
  },
  {
    // WI-10004151 part 2: the admission-time dependency prediction the repair-queue admit door
    // consults before it lands a lockfile change on the frozen lineage.
    path: "packages/operator-core/lib/release/dependency-admission-prediction.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/release/dependency-admission-prediction.ts (WI-10004151): its only start is one execFile('bash', [dependency-generation.sh, '--predict-ref', <ref>]) per explicit `release:repair-queue { op:'admit' }` call, made inside that admit and awaited to completion. The --predict-ref mode is read-only against the generation store and the live trees: it fingerprints the ref's dependency inputs, checks for an existing selector or a live-tree match, and otherwise stages ONLY the ref's lockfiles into a scratch root (removed before it returns) for the dependency-lock-equivalence.mjs comparison. It never installs, never copies node_modules, never publishes, and takes no generation lock. The call is bounded by DEPENDENCY_PREDICTION_TIMEOUT_MS (30s, measured 12.6s at load ~90) plus a 4 MiB maxBuffer, after which the prediction degrades to verdict 'unknown' rather than waiting. It holds nothing resident and creates no independent queue. It is the same shape as the repair-head-admission.ts bypass it sits beside: a resident Governor lease here would gate the frozen lineage's own repair door behind the capacity the gate is trying to recover.",
  },
  {
    path: "scripts/check-integration-teardown-nullsafe.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-integration-teardown-nullsafe.mjs: execFileSync(git ls-files) discovers tracked *.integration.test.ts paths for this CI lint script (an explicit argv override takes precedence over the discovery call entirely); awaited, exits immediately, creates no independent resident queue.",
  },
  {
    path: "scripts/check-narrowing-gated-assertions.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-narrowing-gated-assertions.mjs: execFileSync(git ls-files --recurse-submodules) enumerates tracked files for this CI lint script's AST scan; awaited, exits immediately, creates no independent resident queue.",
  },
  {
    path: "scripts/check-registry-census-drift.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-registry-census-drift.mjs: execFileSync(git grep -l --fixed-strings) is a bounded tracked-file search over *.test.ts/*.test.tsx for this CI lint script; a non-zero exit (no match) is caught as an empty result. Awaited, exits immediately, creates no independent resident queue.",
  },
  {
    path: "scripts/check-deps-wiring-parity.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-deps-wiring-parity.mjs: this CI guard launches bounded, awaited helper probes to inspect dependency wiring and creates no resident production work.",
  },
  {
    path: "scripts/check-no-agent-intent-comments.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-no-agent-intent-comments.mjs: the child git listing is a bounded, awaited source-file enumeration for this CI comment guard, not a resident resource start.",
  },
  {
    path: "scripts/lib/disk-reservations.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/disk-reservations.mjs: its child-process calls are bounded filesystem and process metadata probes used by the reservation ledger, with no independent resident queue.",
  },
  {
    path: "scripts/lib/retry-tree-provenance.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/retry-tree-provenance.mjs: git metadata reads are bounded and awaited to classify retry-tree changes; they start no resident work.",
  },
  {
    path: "scripts/settle-probe.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/settle-probe.mjs: this probe runs bounded child commands to settle diagnostics and exits; it does not create an independent resident queue.",
  },
  {
    path: "apps/operator/lib/release/deploy-parity.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/deploy-parity.ts: its only detected start is readRefUnification's promisified execFile('git', ['rev-parse', '--verify', '--quiet', ref]), called twice (local main, origin/main) to observe ref unification after a deploy; both calls are bounded, awaited, and read-only, spawn no worker, and create no independent resident queue — this honesty check must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/nightly-release-cut-action.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/harness/routines/nightly-release-cut-action.ts: the file mixes two kinds of start, and this disposition covers both rather than exempting the heavier one by citing only the lighter. (1) The 30–40 minute detached desktop-release child is started through managedSpawn under runNightlyCut, which is itself gated by the durable harness_shared.routines schedule for system:nightly-release-cut AND a file-based single-flight lock (acquireNightlyLock/releaseNightlyLock) that already refuses a second concurrent cut and carries the child's own runtimeMaxSec/memoryMaxBytes ceilings in the task-manager's durable spawn ledger — a second local Governor receipt for that same admitted, ledgered, single-flight-locked child would double-count capacity already tracked upstream, not exempt it. (2) The remaining execFileSync calls (readDesktopVersionAtSource's git ls-tree/show, and the sourceSha git rev-parse) are separate, cheap, bounded, awaited metadata reads with no independent resident queue of their own.",
  },
  {
    path: "packages/operator-core/lib/release/gate-fire-drill-deps.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/release/gate-fire-drill-deps.ts: its detected starts are execFileSync('systemctl', ['--user', 'is-active'|'stop', unit]) — a bounded status probe and a bounded control/kill of the drill's own deliberately-launched checkpoint unit — both synchronous, awaited, and read/acted on for release-control metadata; neither spawns a worker or creates an independent resident queue, and the kill leg must remain runnable precisely when capacity is pressured (it is how the drill releases its own admitted test run).",
  },
  {
    path: "packages/operator-core/lib/release/sync-batch-delta-check-deps.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/release/sync-batch-delta-check-deps.ts: every detected start is the file's own run() wrapper around spawnSync with an explicit per-leg timeout (SYNC_DELTA_TIMEOUTS_MS, 30s–25min) and killSignal:'SIGTERM'; each call is synchronous, bounded, and resolves to the deps contract's undetermined value on any failure rather than a fake result, so no call can wedge the routine tick or leave an independent resident queue behind.",
  },
  {
    path: "packages/operator-core/lib/p2p/two-peer-commerce/commerce-peer-launcher.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/p2p/two-peer-commerce/commerce-peer-launcher.ts: its local/SSH children are the measured subjects of one finite two-peer diagnostic run, not a resident service or queue; runTwoPeerCommerce awaits bounded ready/mesh/convergence windows and owns every handle, and its finally cleanup sends stop/end then SIGKILLs local stragglers and tears down remote children before the one-shot run returns.",
  },
  {
    path: "scripts/install-onnxruntime-node.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/install-onnxruntime-node.mjs: the single spawnSync child is the version-pinned onnxruntime package's installer, invoked as an npm postinstall under the serialized install:safe lifecycle; it is synchronous and awaited, returns only after the provider files are verified, and creates no detached worker or independent resident queue.",
  },
  {
    path: "scripts/lib/executed-source-map.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/executed-source-map.mjs: defaultExec performs one synchronous git diff --name-only metadata read for a cached commit pair with a 64 MiB output bound; it is awaited, starts no worker or resident queue, and an unavailable/unknown revision degrades honestly to null so selection keeps rather than drops tests.",
  },
  {
    path: "scripts/ensure-playwright-browsers.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/ensure-playwright-browsers.mjs: its only detected start is a single spawnSync('npx playwright install <browsers>') installer call, synchronous and awaited to completion before the function returns; it runs at most once per missing-browser check, creates no independent resident queue, and must remain runnable so e2e setup is not itself gated behind admission.",
  },
  {
    path: "scripts/check-behavioural-strands.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-behavioural-strands.mjs: its detected starts are execFileSync('git', ...) diff/blame plumbing reads and one spawnSync('npm', ['run','test:file',...]) that re-runs the specific stranded test files it names — each synchronous, awaited, and bounded by the finite strand set it just computed; this is a one-shot PostToolUse/CI lint invocation that creates no independent resident queue and must remain runnable so the guard is not itself gated behind admission.",
  },
  {
    path: "scripts/check-identity-keyed-classification.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-identity-keyed-classification.mjs: its only detected start is a single spawnSync('npx', ['vitest','run', CENSUS_TEST_REL]) that runs one fixed census test file, synchronous and awaited to completion; it is a one-shot CI lint check, creates no independent resident queue, and must remain runnable so the guard is not itself gated behind admission.",
  },
  {
    path: "scripts/check-lockfile-census.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-lockfile-census.mjs: its detected start is execFileSync(<sbom scanner>, ['scan', ...], { maxBuffer }) invoked once per lockfile subject over a finite subject list, synchronous and awaited; it is a one-shot CI census check, creates no independent resident queue, and must remain runnable so the guard is not itself gated behind admission.",
  },
  {
    path: "scripts/check-reachable-advisories.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-reachable-advisories.mjs: its detected start is execFileSync('npm', args, { maxBuffer }) run once to enumerate advisories, synchronous and awaited; it is a one-shot CI reachability check, creates no independent resident queue, and must remain runnable so the guard is not itself gated behind admission.",
  },
  {
    path: "scripts/p2p-witness-manifest.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/p2p-witness-manifest.mjs: every detected start is execFileSync('git', ['-C', repoRoot, ...]) cheap plumbing metadata reads that print and exit, synchronous and awaited; the manifest builder spawns no worker, creates no independent resident queue, and must remain runnable so manifest generation is not itself gated behind admission.",
  },
  {
    path: "scripts/lib/release-task-journal.mts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/release-task-journal.mts: its two execFileSync calls are bounded, awaited git show/ls-tree metadata reads against one pinned source SHA; they start no resident worker or queue and must complete before the journal identity can be accepted.",
  },
  {
    path: "scripts/measure-startup-cache.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/measure-startup-cache.ts (plan token-efficiency-prompts-cache-and-behavior-2026-10-11 P-001): its single spawnSync is one synchronous, awaited, unit-scoped `journalctl --grep startup-cache-evidence/v1` read with a 120s timeout, run by an operator on demand. It starts no worker, no detached child and no resident queue, and the measurement instrument must stay runnable while productive capacity is pressured. journal-read.ts was not reused because its 1,000-line result cap is below one day of gateway evidence lines.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return resourceStartCallCount(source) === 1 &&
        source.includes("spawnSync('journalctl', args,") &&
        source.includes("timeout: 120_000") &&
        !/\bdetached\s*:\s*true/.test(code) && !/\bnew\s+(?:Worker|Piscina)\s*\(/.test(code);
    },
  },
  {
    path: "scripts/lib/stale-swap-leftovers.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/lib/stale-swap-leftovers.mjs: its `pending` array is a depth-first directory-walk worklist consumed to completion within a single synchronous scan of a finite tree, not a resident resource queue; it holds no work across calls and starts no independent resident work.",
  },
  {
    path: "scripts/lib/tracked-files.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/lib/tracked-files.mjs: its `pending` directory-walk worklist in the filesystem fallback is consumed within one synchronous enumeration and is hard-bounded by FALLBACK_MAX_ENTRIES (it throws rather than continue past the bound), so it is finite traversal state, not a resident resource queue, and starts no independent resident work.",
  },
  {
    path: "scripts/check-vacuous-negative-assertions.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/check-vacuous-negative-assertions.mjs: the Aho–Corasick `queue` is a finite trie-construction worklist consumed completely during one synchronous corpus scan; it is bounded by the static probe set for that invocation, retains no work across calls, and starts no independent resident work.",
  },
  {
    path: "scripts/vendor-gitnexus-patch.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/vendor-gitnexus-patch.mjs: this offline installation repair invokes synchronous execFileSync('patch') only for missing entries in the finite, version-pinned local patch manifest; --check starts no child. The child patches a known local package file and is awaited before its marker is verified, with no detached worker, network request, resident queue, or independently scheduled productive work.",
  },
  {
    path: "scripts/project-doc-parts.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/project-doc-parts.mjs: verifyDocClaims() makes exactly one synchronous spawnSync('npx', ['vitest','run',...,'lib/doc-claims/']) to run the doc-claims guards against the corpus this projection just wrote — the only moment that corpus exists on disk before git-sync sweeps it into the gate's candidate. It is not a cheap metadata read (~40s), but it cannot materially increase residency: spawnSync is awaited by construction, exactly one child exists and it must exit before the projection continues, and the child is handed PAPERCUSP_SKIP_DOC_CLAIMS_VERIFY=1 so it provably cannot recurse into a second verify. It runs only when a human or a release script projects doc parts (a handful of times a day), never on a scheduled or serving path, and starts no detached worker, network request, or resident queue. Two deliberate escape hatches (--no-verify, PAPERCUSP_SKIP_DOC_CLAIMS_VERIFY=1) let a mid-repair or non-interactive caller skip the start entirely.",
  },
  {
    path: "apps/operator/lib/release/green-checkpoint.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for green-checkpoint.ts: createCheckpointTerminalEventBuffer's pending Map holds only terminal wake events from one qualification result, keyed by event/sha/runId; flush copies and clears it after the durable result is recorded or withholds it on failure. It is per-run notification correlation state, not resident work or an independently draining queue.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/snapshot-fold-offload.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for snapshot-fold-offload.ts: SnapshotFoldWorker.open obtains the process-wide acquireSnapshotFoldSlot lease before new Worker, permits one fold worker at a time, sets a per-worker V8 heap limit, and releases the exact slot on failed start, close, or exit. The worker is parent-owned by one in-flight pot compaction; it creates no independent scheduled work.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/snapshot-fold-offload.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for snapshot-fold-offload.ts: pending maps request IDs to reply promises inside the single leased worker; each reply or send failure deletes its entry, and close/worker failure rejects and clears all entries. It is active-call correlation, not a resident work backlog.",
  },
  {
    path: "scripts/check-installed-patch-postimages.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for check-installed-patch-postimages.mjs: runGit performs synchronous, awaited local Git metadata and hash reads over the finite tracked patch list during postinstall, each with a 30-second timeout and 32 MiB output bound. It starts no detached worker or resident queue and must run before the installed patch set is trusted.",
  },
  {
    path: "scripts/verify-identities-r7.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for verify-identities-r7.mjs: this operator-invoked acceptance journey awaits each Tauri command before the next UI step, bounds UI/poll commands to 45 seconds, liveness to 15 seconds, and its Git identity read to 5 seconds. It neither detaches children nor retains a resident queue after the journey ends.",
  },
  {
    path: "packages/operator-core/lib/search/bench/near-duplicate-guard-compare-cli.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for near-duplicate-guard-compare-cli.ts: gitBlob runs one awaited execFileSync(git hash-object <path>) per compared artifact to stamp provenance on this operator-invoked bench CLI; a failure is caught as null. It exits immediately and creates no detached worker or resident queue.",
  },
  {
    path: "packages/operator-core/lib/search/bench/chunk-search-ab-cli.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for chunk-search-ab-cli.ts: its sole child-process call reads Git metadata for measuredCode provenance (HEAD, blob and dirty state), with a 30-second timeout and 1 MiB output bound. The attended A/B CLI awaits each read, catches failures as explicit error text, detaches nothing and creates no resident process queue. This disposition rejects additional child starts or removal of the read bounds.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return [...code.matchAll(/\b(?:spawn|spawnSync|fork|execFile|execFileSync)\s*\(/g)].length === 1 &&
        source.includes("execFileSync('git', ['-C', repo, ...args]") &&
        /timeout:\s*30_000/.test(code) && /maxBuffer:\s*1024\s*\*\s*1024/.test(code) &&
        !START_NON_VERB.test(code) && !hasCalledResourceStartAlias(code);
    },
  },
  {
    path: "packages/operator-core/lib/search/bench/bm25-bakeoff-cli.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for bm25-bakeoff-cli.ts (WI-10008294, plan bm25-lexical-search-evoke-adoption-2026-10-10 P-001): an attended, operator-invoked research bench. Every child start is a blocking spawnSync (docker build/run/exec/restart/logs, a read-only `docker image inspect` preflight for --skip-build, one read-only sudo psql COPY, git rev-parse); the parent waits for each to exit, detaches nothing and keeps no resident queue. The one long-lived resource, the throwaway bake-off container, is removed by `docker rm -f` in a finally block unless the operator passes --keep. This disposition rejects any asynchronous or detached start (spawn/fork/execFile) or removal of the finally cleanup.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return [...code.matchAll(/\b(?:spawn|fork|execFile|execFileSync|exec|execSync)\s*\(/g)].length === 0 &&
        [...code.matchAll(/\bspawnSync\s*\(/g)].length === 6 &&
        source.includes("if (!args.keep) spawnSync('docker', ['rm', '-f', c.name]") &&
        !START_NON_VERB.test(code) && !hasCalledResourceStartAlias(code);
    },
  },
  {
    path: "packages/operator-core/lib/search/embedding-space-parity-cases.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for embedding-space-parity-cases.ts: censusFilterCallSites runs one awaited execFileSync(git grep --untracked -lE) over packages/apps/libs to enumerate call-site files for an in-process AST census. It is a bounded local metadata search that exits immediately and starts no detached worker or resident queue.",
  },
  {
    path: "packages/operator-core/lib/release/admission-import-completeness.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for admission-import-completeness.ts: pending is a function-local import-data traversal frontier, seeded only from the finite admission source map. Each entry is synchronously consumed by shift; imported bindings are restricted to sourceByPath and deduplicated by visited before their exported data enters the frontier. It starts no work and retains no queue after the probe returns. The source predicate requires that consumption and deduplication and rejects any additional queue writer.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      const writers = [...code.matchAll(RESIDENT_QUEUE)];
      return writers.length === 1 && writers[0][1] === "pending" &&
        code.includes("const pending = sources.map(") &&
        code.includes("const visited = new Set<string>();") &&
        code.includes("while (pending.length > 0)") &&
        code.includes("pending.shift()") &&
        code.includes("sourceByPath.has(candidate)") &&
        code.includes("if (visited.has(key)) continue;") &&
        code.includes("visited.add(key);") &&
        code.includes("pending.push({ path: imported, data: value });") &&
        !/\b(?:async|await)\b/.test(code);
    },
  },
  {
    path: "packages/operator-core/lib/release/admission-offthread.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for admission-offthread.ts: its Worker is a process-scoped execution host for the frozen-repair queue's synchronous builders, not a per-request worker. pinModuleState gives one HostState per process and ensureWorker shares state.ready; runAdmissionJob permits one active job and refuses overlap instead of retaining queued work; the worker is unrefed between jobs and terminated by the idle reaper, with failed starts and worker errors clearing shared state. It starts no detached worker or independent schedule. admission-offthread.test.ts covers fail-fast overlap, idle reaping, and a later fresh start.",
  },
  {
    path: "scripts/check-tracked-ignored.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-tracked-ignored.mjs: this CI lint script runs awaited spawnSync(git ls-files / check-ignore) metadata reads per repository with a 256 MiB output bound. Each exits immediately, and it creates no detached worker or resident queue.",
  },
  {
    path: "scripts/lib/graph-dependency-suggestions.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/lib/graph-dependency-suggestions.mjs: this is a call-local traversal frontier, not queued background work. Both initial changed-path seeds and discovered importers are deduplicated in `seen` and limited by the existing MAX_VISITED_FILES bound; excess seeds set `truncated` and are omitted from suggestions, while the baseline selection remains untouched. The cursor-index walk retains at most that same bound and is discarded when the suggestion call returns.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/operator-e2e-isolated-action.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for operator-e2e-isolated-action.ts: the routine starts exactly one isolated E2E task through managedSpawn. It uses the task-manager OPERATOR_E2E_TASK_CLASS and launched-by identity, memory/runtime limits, and a ledger-backed single-flight check; the local spawn alias is the injected managedSpawn seam, not a raw child start outside the task manager.",
    matchesSource: (source) => resourceStartCallCount(source) === 1 &&
      source.includes("const spawn = opts.spawnFn ?? managedSpawn;") &&
      source.includes("class: OPERATOR_E2E_TASK_CLASS") &&
      source.includes("launchedBy: OPERATOR_E2E_TASK_LAUNCHED_BY") &&
      source.includes("memoryMaxBytes: OPERATOR_E2E_MEMORY_MAX_BYTES") &&
      source.includes("runtimeMaxSec: OPERATOR_E2E_RUNTIME_MAX_SEC") &&
      source.includes("if (inFlight.length > 0)"),
  },
  {
    path: "packages/operator-core/lib/release/staging-fix-proposal-cli.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for staging-fix-proposal-cli.ts: its sole direct process start reads one local Git integration ref before constructing an operator-invoked proposal. The multi-minute precheck is delegated to createCheckpointTreeFixPrecheckRunner in its own precheck tree; this read itself creates no resident job or retry queue.",
    matchesSource: (source) => resourceStartCallCount(source) === 1 &&
      source.includes("execFileSync('git', ['rev-parse', '--verify'") &&
      source.includes("createCheckpointTreeFixPrecheckRunner({") &&
      source.includes("precheckRoot,"),
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/seed-frozen-execution.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for seed-frozen-execution.ts: each committed security-package row gets one awaited Python stdlib tar inspection after the HTTPS response is timeout-bounded and its lockfile sha512 is verified. The child emits only the file-digest map under a 16 MiB output bound; it is finite snapshot construction, not serving or resident work.",
    matchesSource: (source) => resourceStartCallCount(source) === 1 &&
      source.includes("const archive = JSON.parse(execFileSync('python3'") &&
      source.includes("AbortSignal.timeout(120000)") &&
      source.includes("maxBuffer: 16 * 1024 * 1024") &&
      source.includes("createHash('sha512').update(bytes)"),
  },
  {
    path: "packages/operator-core/lib/system-health/claude-update-canary.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for claude-update-canary.ts: one ephemeral CLI probe per configured canary variant is routed through the inference gateway with an isolated owner header, a 150-second timeout, a 4 MiB output ceiling, and unconditional temporary-directory cleanup. It leaves no resident child or queue.",
    matchesSource: (source) => resourceStartCallCount(source) === 1 &&
      source.includes("const PROBE_TIMEOUT_MS = 150_000") &&
      source.includes("execFile(input.binary, args, { cwd, env, timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024") &&
      source.includes("ANTHROPIC_BASE_URL: `http://127.0.0.1:${gatewayPort()}`") &&
      source.includes("finally {\n    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});"),
  },
  {
    path: "scripts/e2e-fixture-affected.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for e2e-fixture-affected.mjs: this operator-invoked test runner first ensures the Playwright browser and then runs only the selected fixture specs with one worker; --print exits before either child. It creates no service process or resident queue.",
    matchesSource: (source) => resourceStartCallCount(source) === 2 &&
      source.includes("scripts/ensure-playwright-browsers.mjs") &&
      source.includes('["--no-install", "playwright", "test", ...specArgs, "--workers=1"]') &&
      source.includes("if (args.print || selection.selected.length === 0) return 0;"),
  },
  {
    path: "scripts/provision-lsp.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for provision-lsp.ts: a manually invoked, foreground provisioning CLI (`tsx scripts/provision-lsp.ts python go`) that installs the pinned pyright/gopls versions into the LSP adapter's versioned vendor directories. Its three children (an `npm install --prefix <vendor dir>` of the exact pyright pin, a `go install` of the exact gopls pin with GOTOOLCHAIN=local, and a `gopls version` check) run synchronously with inherited stdio and exit before the command returns. It never runs inside the operator, a routine, or a test, and leaves no service, worker, or resident process behind.",
    matchesSource: (source) => resourceStartCallCount(source) === 3 &&
      source.includes("execFileSync('npm', ['install', '--prefix', dir, '--save-exact', `pyright@${PYRIGHT_VERSION}`], { stdio: 'inherit' })") &&
      source.includes("execFileSync(go, ['install', `golang.org/x/tools/gopls@${GOPLS_VERSION}`], {") &&
      source.includes("execFileSync(join(bin, 'gopls'), ['version'], { stdio: 'inherit' })") &&
      !/\bdetached\s*:\s*true/.test(stripCommentsAndStrings(source)),
  },
  {
    path: "scripts/gen-asana-openapi-subset.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for gen-asana-openapi-subset.mjs: this manually invoked generator reads the immutable Asana OpenAPI commit with a 64 MiB output ceiling, then runs the pinned openapi-typescript version to produce checked-in artifacts. Both children exit before the generator returns; no runtime service or resident process is created.",
    matchesSource: (source) => resourceStartCallCount(source) === 2 &&
      source.includes("const ASANA_OAS_COMMIT = '1b1c15108d490fc5b780bb83e070293b5815d522';") &&
      source.includes("execFileSync('curl', ['-fsSL', SOURCE_URL], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })") &&
      source.includes("execFileSync('npx', ['-y', OPENAPI_TYPESCRIPT, typegenInput, '-o', tmpDts]"),
  },
  {
    path: "scripts/gen-asana-openapi-subset.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for gen-asana-openapi-subset.mjs: queue is a call-local schema-reference traversal over the pinned OpenAPI document. The `seen` set consumes each schema name once, references are read only from `all`, and the frontier is discarded when this one-shot generator returns; it is not queued runtime work.",
    matchesSource: (source) => source.includes("const seen = new Set();") &&
      source.includes("const queue = [...ROOT_SCHEMAS];") &&
      source.includes("queue.push(...bodyRefs);") &&
      source.includes("while (queue.length > 0)") &&
      source.includes("if (seen.has(name)) continue;") &&
      source.includes("seen.add(name);") &&
      source.includes("collectRefs(all[name], refs);") &&
      source.includes("queue.push(...refs);"),
  },
  {
    path: "scripts/gen-graph-dependency-snapshot.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for gen-graph-dependency-snapshot.mjs: direct Cypher intentionally starts the gitnexus CLI once per bounded page and sends its large stdout to a temporary file; runCliToFile kills the child at the supplied timeout and removes the file in finally. First-party source enumeration is a one-shot local Git read with a 256 MiB output ceiling. This is an attended snapshot generator, not an MCP request path.",
    matchesSource: (source) => resourceStartCallCount(source) === 2 &&
      source.includes("runToFile = runCliToFile") &&
      source.includes("const timer = setTimeout(() => child.kill(\"SIGKILL\"), timeoutMs);") &&
      source.includes("rmSync(dir, { recursive: true, force: true });") &&
      source.includes("maxBuffer: 1 << 28") &&
      source.includes("const MAX_PAGES = 20000;"),
  },
  {
    path: "scripts/npm-install-safe.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for npm-install-safe.mjs: pending is a call-local manifest-closure traversal. It is seeded from the repository's workspace manifests, deduplicated by `inspected`/`inputPaths`, and accepts file dependencies only when their target stays strictly inside the repository; it holds no install work after the layout probe returns.",
    matchesSource: (source) => source.includes('const pending = ["package.json", ...workspaceManifestPaths];') &&
      source.includes("const inspected = new Set();") &&
      source.includes("while (pending.length > 0)") &&
      source.includes("if (inspected.has(manifestPath)) continue;") &&
      source.includes("if (!isStrictlyWithin(repoRoot, targetPath))") &&
      source.includes("if (!inputPaths.has(targetRelative)) {\n          inputPaths.add(targetRelative);\n          pending.push(targetRelative);"),
  },
  {
    path: "scripts/remeasure-callers.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for remeasure-callers.ts: the only child is one local `git rev-parse HEAD` read for provenance in this explicitly operator-run CLI. Caller analysis then runs in-process and returns one row per finite fixture sample; it starts no resident worker or background queue.",
    matchesSource: (source) => resourceStartCallCount(source) === 1 &&
      source.includes("execFileSync('git', ['rev-parse', 'HEAD']") &&
      source.includes("const root = process.cwd();") &&
      source.includes("if (isCliEntry(import.meta.url))"),
  },
  {
    path: "scripts/review-cloud-tutorial-native.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for review-cloud-tutorial-native.mjs: the attended native tutorial review runs under pc-heavy with one headed Playwright worker. Its browser readiness probe owns a process group and 15s deadline with SIGTERM/SIGKILL cleanup; the desktop phase tracks its window-manager, accessibility and test children and stops them in finally. These four lexical start sites create no serving workload.",
    matchesSource: (source) => resourceStartCallCount(source) === 4 &&
      source.includes("scripts/pc-heavy.sh") &&
      source.includes("--workers=1") &&
      source.includes("const stop = () => { for (const c of children)") &&
      source.includes("} finally { stop(); }"),
  },
  {
    path: "scripts/reviewer-operator-assert.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for reviewer-operator-assert.mjs: the isolated ptool seed call has a 60-second deadline and the native-capture transport (an awaited `ssh -o BatchMode=yes -o ConnectTimeout=20` into the explicitly named mobile host, which replaced the earlier `gh run watch` path in d2956e100b) has a 65-minute deadline; both cap output at 2 MiB. The only resident child is a loopback socat relay on the verifier's reserved port; readiness is limited to five seconds, and finally terminates the relay. Its launcher runs the assertion inside the disposable Tauri verifier.",
    matchesSource: (source) => resourceStartCallCount(source) === 3 &&
      source.includes("timeout: 60_000, maxBuffer: 2_000_000") &&
      source.includes("timeout: 65 * 60_000 });") &&
      source.includes("'ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20'") &&
      source.includes("TCP-LISTEN:${relayPort},bind=127.0.0.1,fork,reuseaddr") &&
      source.includes("const deadline = Date.now() + 5000;") &&
      source.includes("} finally { stop(); }"),
  },
  {
    path: "scripts/tauri-surface-verify-reporter-status.mts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for tauri-surface-verify-reporter-status.mts: its one native Tauri-driver start is inside the scheduled isolated reporter-status phase and every command has a 60-second timeout. The phase requires the isolated verifier DB and a concrete target PID; it leaves no process or queue behind.",
    matchesSource: (source) => resourceStartCallCount(source) === 1 &&
      source.includes("execFileSync(tool, [...args, '--pid', pid], { encoding: 'utf8', timeout: 60_000 })") &&
      source.includes("assert.equal(process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED, '1'") &&
      source.includes("runPhase(ctx)"),
  },
  {
    path: "scripts/pg-url.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/pg-url.mjs (reviewed under WI-10007542 after its `--exec` mode landed 2026-10-08): this is a directly invoked DSN resolver CLI, not a runtime lane. Its one start is `--exec -- COMMAND`, an env-binding wrapper in the shape of `env VAR=… cmd`: it spawns exactly the caller-named child with shell:false and inherited stdio, sets only HARNESS_ADMIN_DATABASE_URL, awaits the child's exit and returns its code. It refuses to start anything unless an explicit env or isolated-PG pin selected the database. The child's cost belongs to the door that invoked pg-url (a capability:bash task, or pc-heavy when the caller wraps it), which already confines and accounts for the whole subtree, so a second receipt here would double-count the same work.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return resourceStartCallCount(source) === 1 &&
        source.includes("const child = spawn(executable, commandArgs, {") &&
        source.includes("shell: false,") &&
        source.includes("stdio: 'inherit',") &&
        source.includes("child.once('exit', (code) => resolve(code ?? 1));") &&
        source.includes("if (args.mode === 'exec' && !['env', 'isolated-pg-port'].includes(resolution.source))") &&
        !/\bdetached\b/.test(code) &&
        !/\bnew\s+(?:Worker|Piscina)\s*\(/.test(code) &&
        !hasCalledResourceStartAlias(code);
    },
  },
  {
    path: "scripts/lib/verify-tauri-assertion-env.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for verify-tauri-assertion-env.mjs: the runtime-MCP preflight makes one synchronous, authenticated coord:whoami probe before the native verifier exists. The child is awaited with a 30-second timeout and 1 MiB output bound, writes only redacted identity evidence, and leaves no worker or resident queue.",
    matchesSource: (source) =>
      resourceStartCallCount(source) === 1 &&
      source.includes("const call = spawnSync(process.execPath, [mcpPath, 'coord:whoami', '--port', portText,") &&
      source.includes("encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,") &&
      source.includes("if (call.status !== 0) throw new Error('authenticated-runtime-read-failed');") &&
      source.includes("if (receipt.ownerId !== owner || receipt.workspaceId !== workspace) throw new Error('authenticated-runtime-identity-mismatch');"),
  },
  {
    path: "scripts/qualify-sync-lint-proof.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for qualify-sync-lint-proof.mjs: its only process start is a bounded synchronous git metadata reader used to fingerprint the verifier input closure. Each call is awaited with a 60-second deadline and captured output, and the script retains no child or runtime queue.",
    matchesSource: (source) =>
      resourceStartCallCount(source) === 1 &&
      source.includes("const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], {") &&
      source.includes("encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],") &&
      source.includes("export function collectVerifierInputClosure(repo, roots)"),
  },
  {
    path: "scripts/qualify-sync-lint-proof.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for qualify-sync-lint-proof.mjs: queue is a finite, per-call traversal frontier for literal verifier imports. Each path is deduplicated before enqueue, the indexed loop consumes the frontier synchronously, and the array is discarded when closure collection returns; it schedules no work and survives no call.",
    matchesSource: (source) =>
      source.includes("const paths = new Set(), queue = [], imports = [], unresolved = [], workingHashes = {};") &&
      source.includes("paths.add(path); queue.push(path);") &&
      source.includes("for (let i = 0; i < queue.length; i++)") &&
      source.includes("const from = queue[i], absolute = join(repo, from);") &&
      source.includes("return { roots: [...new Set(roots)].sort(), paths: [...paths].sort(), imports, unresolved, workingHashes };"),
  },
  {
    path: "scripts/with-documenso-sandbox.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/with-documenso-sandbox.mjs (WI-6554700010009231; readiness extension WI-6554700010009544; child-failure diagnostics WI-6554700010015560): a one-shot isolated e2e wrapper, never a serving or scheduled runtime. Its reviewed finite Docker/openssl clients and wrapped-command child retain process-group stop and finally cleanup. The legacy shape has no reaper. The reaper shape retains its sole Testcontainers import for the socket path, --rm, 30s no-client and 1s reconnection timeouts, owner-label filter acknowledgement before allocation, awaited remover, and fail-closed residue check. Readiness clients use a5s deadline and100000-byte output bound. The database caller passes password redactions and stop predicate to a finite31-attempt progress loop. The child-failure client inspects the exact three owned containers and at most200 provider log lines, emitting fixed diagnostic signals only, before finally cleanup. matchesSource pins these extensions and the original lifecycle. Any other start, missing timeout, unlimited readiness loop, widened label filter or dropped cleanup falls out of this disposition.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      // Without the reaper: the shape committed at 8cc9307dd5, where cleanup is
      // two of the seven starts. With it: cleanup removes through the awaited
      // dockerAllocation client, leaving five starts, and the reaper must stay
      // bounded and filtered to this run's owner label.
      const testcontainersImports = [
        ...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]@?testcontainers\b/g),
      ].length;
      const hasReadiness = /\bwaitForSandboxPostgres\b/.test(code);
      const readinessPinned = !hasReadiness || (
        [...source.matchAll(/\bdiagnosticRun\s*=\s*args\s*=>\s*spawnSync\('docker', args, \{ encoding: 'utf8', timeout: 5000, maxBuffer: 100_000 \}\)/g)].length === 3 &&
        source.includes("await runPhase('database-ready', () => waitForSandboxPostgres(database,") &&
        source.includes("{ run: diagnosticRun, secrets: [databasePassword], isStopped: () => stopped }));") &&
        source.includes("attempts = 31, isStopped = () => false") &&
        source.includes("for (let attempt = 0; ; attempt++) {\n    if (isStopped()) return;") &&
        source.includes("stalledAttempts = observedStage > startupStage ? 1 : stalledAttempts + 1;") &&
        source.includes("if (terminal || stalledAttempts >= attempts)")
      );
      const hasChildDiagnostic = /\bwaitForSandboxChild\b/.test(code);
      const childDiagnosticPinned = !hasChildDiagnostic || (
        source.includes("  run = args => spawnSync('docker', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 100_000 }),") &&
        source.includes("const exitCode = await waitForSandboxChild(child, { runtime });") &&
        source.includes("[runtime.container, runtime.network + '-pg', runtime.network + '-mail']") &&
        source.includes("if (['exited', 'dead'].includes(containers[0].status))") &&
        source.includes("run(['logs', '--tail', '200', runtime.container])") &&
        source.includes("signals: sandboxProviderFailureSignals((result.stdout || '') + (result.stderr || ''))")
      );
      const shapePinned = source.includes("REAPER_IMAGE")
        ? resourceStartCallCount(source) === (hasChildDiagnostic ? 10 : 9) && readinessPinned && childDiagnosticPinned &&
          testcontainersImports === 1 &&
          source.includes("import { getContainerRuntimeClient, Wait } from 'testcontainers';") &&
          source.includes("getClient = getContainerRuntimeClient, allocate = dockerAllocation,") &&
          source.includes("const containerId = await allocate(['run', '-d', '--rm', '--pull=missing', '--name', name,") &&
          source.includes("'-e', 'RYUK_CONNECTION_TIMEOUT=30s', '-e', 'RYUK_RECONNECTION_TIMEOUT=1s', REAPER_IMAGE]);") &&
          source.includes("socket.write('label=papercusp.test.owner=' + owner + '\\n')") &&
          source.includes("  reaper.assertConnected();\n  containers.push(name);") &&
          source.includes("    reaper.assertConnected();\n    await dockerAllocation(['network', 'create', ") &&
          source.includes("  remove = args => dockerAllocation(args) }) {") &&
          source.includes("try { await remove(['rm', '-f', '-v', name]); }") &&
          source.includes("try { await remove(['network', 'rm', network]); }") &&
          source.includes("if (remainingContainers || remainingNetworks) {") &&
          (source.includes("try { await cleanupSandboxResources({ containers, network, networkCreated, inspect: docker }); }") ||
            (source.includes("if (containers.length || networkCreated) {") &&
              source.includes("await cleanupSandboxResources({ containers, network, networkCreated, inspect: docker });"))) &&
          source.includes("    try { await runPhase('cleanup', cleanup); }\n    finally { reaper?.close(); }")
        : resourceStartCallCount(source) === 7 &&
          testcontainersImports === 0 &&
          source.includes("    await cleanup();");
      return shapePinned &&
        [...code.matchAll(/\bspawnChild\s*\(/g)].length === 1 &&
        source.includes("spawnChild = spawn, pendingAfterMs = 30_000,") &&
        source.includes("child = spawn(command[0], command.slice(1), { stdio: 'inherit', detached: true,") &&
        source.includes("try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already ended */ }") &&
        !/\bnew\s+(?:Worker|Piscina)\s*\(/.test(code) &&
        !/\b(?:fork|execFile|execFileSync)\s*\(/.test(code) &&
        !/\bpromisify\s*\(/.test(code);
    },
  },
  {
    path: "scripts/with-documenso-sandbox.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for dockerAllocationScope: pending contains only allocation promises already sent to the Docker daemon. close marks the scope closed, joins every pending promise with Promise.allSettled, and then performs one cleanup; settled promises are deleted immediately. It is a bounded lifecycle ledger, not a resident work queue.",
    matchesSource: (source) =>
      source.includes("export function dockerAllocationScope({ allocate = dockerAllocation } = {})") &&
      source.includes("const pending = new Set();") &&
      source.includes("pending.add(outcome);") &&
      source.includes("outcome.then(() => pending.delete(outcome), () => pending.delete(outcome));") &&
      source.includes("await Promise.allSettled([...pending]);") &&
      source.includes("return remove();"),
  },
  {
    path: "packages/operator-core/lib/system-health/cluster-lag-watchdog.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for packages/operator-core/lib/system-health/cluster-lag-watchdog.ts (WI-6554700010009231): `pending` is the watchdog's per-worker recovery state, not a work queue. It maps a cluster worker id to whether that killed worker's exit has been observed. An entry is set only when the scan SIGKILLs a silent worker (and flipped on that worker's exit), and is deleted when the worker's heartbeat resumes or a replacement worker's first heartbeat arrives. So it holds at most one entry per cluster worker, carries no work to execute, and only decides whether the cluster-lag condition is still open; condition delivery is the separate ordered `delivery` chain. Pinned by matchesSource to that declaration, its heartbeat delete, and `pending` being the file's only queue-shaped write.",
    matchesSource: (source) =>
      source.includes("const pending = new Map<number, boolean>(); // worker id → exit observed") &&
      source.includes("pending.delete(worker.id);") &&
      [...stripCommentsAndStrings(source, "cluster-lag-watchdog.ts").matchAll(RESIDENT_QUEUE)]
        .map((match) => match[1])
        .join(",") === "pending,pending",
  },
  {
    path: "packages/operator-core/lib/release/sibling-tree-root.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/release/sibling-tree-root.ts (WI-6554700010009501): one awaited read-only git rev-parse probe identifies the enclosing checkout for sibling-tree path resolution. Each child has a 10s timeout and 64KiB output bound; the existing outer walk visits at most 16 ancestors and stops on the first failed probe. It creates no resident workload or queue.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return [...code.matchAll(/\bexecFileAsync\s*\(/g)].length === 1 &&
        source.includes("let execFileAsyncMemo: typeof execFile.__promisify__ | null = null;") &&
        source.includes("const execFileAsync = ((...args: unknown[]) =>") &&
        source.includes("Reflect.apply((execFileAsyncMemo ??= promisify(execFile)), undefined, args)") &&
        source.includes("execFileAsync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {") &&
        source.includes("timeout: 10_000") && source.includes("maxBuffer: 64 * 1024") &&
        source.includes("const MAX_ENCLOSING_HOPS = 16;") &&
        source.includes("for (let hop = 0; hop < MAX_ENCLOSING_HOPS; hop++)");
    },
  },
  {
    path: "scripts/bench-work-item-continuations.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/bench-work-item-continuations.ts: this explicit staging measurement uses the attributed mcp-call CLI to measure real work-item writes and readbacks. It requires the current session and already-owned items; each child is awaited with a 35s timeout, 1MiB output bound, and propagated abort signal. The fixed experiment drains all outstanding calls in finally.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return resourceStartCallCount(source) === 0 &&
        source.includes("let execMemo: typeof execFile.__promisify__ | null = null;") &&
        source.includes("const exec = ((...args: unknown[]) =>") &&
        source.includes("Reflect.apply((execMemo ??= promisify(execFile)), undefined, args)") &&
        [...code.matchAll(/(?<![\w$.])exec\s*\(/g)].length === 1 &&
        source.includes("resolve(ROOT, 'scripts/mcp-call.mjs')") &&
        source.includes("timeout: 35_000, maxBuffer: 1024 * 1024, signal");
    },
  },
  {
    path: "scripts/bench-work-item-continuations.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/bench-work-item-continuations.ts: pending holds exactly the three controlled outstanding promises (held, cancelled, ordered), not queued work. The scenario creates those three at fixed call sites and awaits all of them with Promise.allSettled in finally.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return [...code.matchAll(RESIDENT_QUEUE)].map((match) => match[1]).join(",") ===
          "pending,pending,pending" &&
        source.includes("pending.push(heldWrite);") &&
        source.includes("pending.push(cancelled);") &&
        source.includes("pending.push(ordered);") &&
        source.includes("await Promise.allSettled(pending);");
    },
  },
  {
    path: "scripts/bench-work-items-get.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/bench-work-items-get.ts: this one-shot staging cohort measures attributed mcp-call startup and authoritative summary reads. It accepts 1–10 item ids and 1–10 repeats, executes calls sequentially (at most 100), and bounds each child to 35s and 1MiB output; it creates no independently managed serving capacity.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return resourceStartCallCount(source) === 0 &&
        source.includes("let execMemo: typeof execFile.__promisify__ | null = null;") &&
        source.includes("const exec = ((...args: unknown[]) =>") &&
        source.includes("Reflect.apply((execMemo ??= promisify(execFile)), undefined, args)") &&
        [...code.matchAll(/(?<![\w$.])exec\s*\(/g)].length === 1 &&
        source.includes("timeout: 35_000, maxBuffer: 1024 * 1024") &&
        source.includes("input.ids.length > 10") && source.includes("input.repeats > 10") &&
        source.includes("if (port !== '3170')");
    },
  },
  {
    path: "scripts/lib/git-index-fault.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/git-index-fault.mjs: the explicit audit-sink diagnostic uses bounded synchronous sudo/auditctl and state reads under one 10s probe deadline. Each execFileSync inherits the remaining timeout, caps output at 4MiB, and exits before the probe continues; it creates no resident worker or queue.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return resourceStartCallCount(source) === 1 &&
        source.includes("run = (args, budget) => execFileSync('sudo', ['-n', ...args], {") &&
        source.includes("timeout: budget, killSignal: 'SIGKILL'") &&
        source.includes("maxBuffer: 4 * 1024 * 1024") &&
        source.includes("const deadline = started + Math.min(10_000, Math.max(1, timeoutMs));") &&
        source.includes("process.argv.includes('--audit-sink')");
    },
  },
  {
    path: "scripts/lib/related-tests.mjs",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for scripts/lib/related-tests.mjs: its three awaited child sites only enumerate maintained test inputs (command-selection, safe glob expansion, and Vitest config contracts) for the root test:affected job admitted by pc-heavy. The two selector reads have 10s deadlines; config resolution has a 120s deadline and 64MiB output bound. Actual test execution remains with the governed test runner.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return resourceStartCallCount(source) === 3 &&
        source.includes("execFileSync(executable, args, { cwd: wsRoot, encoding: 'utf8', timeout: 10_000 })") &&
        source.includes("execFileSync('/bin/sh', ['-c',") &&
        source.includes("execFileSync(process.execPath, [path.join(root, 'scripts/resolve-vitest-config-contracts.mjs')") &&
        source.includes("timeout: 120_000") && source.includes("maxBuffer: 64 * 1024 * 1024") &&
        !/\bspawn\s*\(/.test(code);
    },
  },
  {
    path: "scripts/resolve-vitest-config-contracts.mjs",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for scripts/resolve-vitest-config-contracts.mjs: the single child synchronizes and inspects an Astro test-selection workspace for the admitted test:affected selector. Requests are processed sequentially; each child has a 120s timeout and 64MiB output bound, and actual tests run only in the governed test runner.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return resourceStartCallCount(source) === 1 &&
        source.includes("execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--astro-selection-child']") &&
        source.includes("timeout: 120_000, maxBuffer: 64 * 1024 * 1024") &&
        source.includes("for (const request of requests)");
    },
  },
  {
    path: "scripts/review-cloud-tutorial-native.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/review-cloud-tutorial-native.mjs: pending is the browser-readiness probe's CDP request correlation map, not a work queue. Entries are created only for protocol SEND ids and removed on matching RECV; the isolated browser process is killed on its 15s deadline, and remaining ids are diagnostic output.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return [...code.matchAll(RESIDENT_QUEUE)].map((match) => match[1]).join(",") === "pending" &&
        source.includes("const phases = [], pending = new Map();") &&
        source.includes("pending.set(message.id, { id: message.id, method: message.method, at: match[1] });") &&
        source.includes("pending.delete(message.id);") &&
        source.includes("pending: [...pending.values()]") &&
        source.includes("timeoutMs = 15000");
    },
  },
  {
    path: "packages/operator-core/lib/release/admission-private-test-pg.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for admission-private-test-pg.ts: admission-fix-precheck-managed owns this child as part of the registered admission-precheck test-run. It launches only the maintained with-test-pg wrapper into a private UUID scratch root, validates the loopback endpoint receipt, and owns the whole process group through exit and cleanup. Bootstrap and stop deadlines remain explicit; the fixture never borrows product database pins.",
    matchesSource: (source) => resourceStartCallCount(source) === 1 &&
      source.includes("ADMISSION_TEST_ENVIRONMENT = 'pinned-private-pg-test-mode-v4'") &&
      source.includes("const wrapper = join(root, 'scripts/with-test-pg.mjs');") &&
      source.includes("spawn(process.execPath,\n    [wrapper, '--', process.execPath, '-e', childCode],") &&
      source.includes("processGroupLifetime(child,") &&
      source.includes("options.timeoutMs ?? 20 * 60_000") &&
      source.includes("options.stopTimeoutMs ?? 30_000") &&
      source.includes("await lifetime.waitForExit({ timeoutMs: 10_000 });") &&
      source.includes("if (groupExited) rmSync(fixtureTmp, { recursive: true, force: true });"),
  },
  {
    path: "packages/operator-core/lib/release/checkpoint-qualification-command.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for checkpoint-qualification-command.ts: the single child is launched only after the qualification owner records its exact scope enrollment. managedSpawn requires the task-run registration and OS confinement, inherits the attempt deadline, and cleanup verifies scope death before releasing custody.",
    matchesSource: (source) => resourceStartCallCount(source) === 1 &&
      source.includes("recordStoredQualificationChildScope") &&
      source.includes("const launch = deps.spawn(command, argv.slice(1), {") &&
      source.includes("class: 'test-run', title: 'Frozen qualification command'") &&
      source.includes("launchedBy: 'green-checkpoint:qualification'") &&
      source.includes("requireConfinement: true, requireRegistration: true") &&
      source.includes("deadlineEpochMs: options.deadlineEpochMs") &&
      source.includes("await bounded(managed.waitForCompletion());"),
  },
  {
    path: "packages/operator-core/lib/release/operator-artifact.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for operator-artifact.ts: its only child site is the bounded asynchronous local Git reader used to bind bundle inputs to exact commit blobs. Each read has a 60-second timeout and 8 MiB output cap; reads are awaited sequentially and leave no worker or resident queue.",
    matchesSource: (source) => resourceStartCallCount(source) === 1 &&
      source.includes("const gitRead: GitRead = (root, args) => new Promise((resolve, reject) => {") &&
      source.includes("execFile('git', ['-C', root, ...args], {") &&
      source.includes("timeout: 60_000, maxBuffer: 8 * 1024 * 1024") &&
      source.includes("git(root, ['ls-tree', '-rz', '--full-tree', sha])") &&
      source.includes("await operatorArtifactSource(root, git) !== input.sourceSha") &&
      !/\bdetached\s*:\s*true/.test(stripCommentsAndStrings(source)),
  },
  {
    path: "scripts/check-code-health.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for check-code-health.ts: this advisory CLI performs one synchronous Git reader for the caller-selected diff and source blobs, then computes health in-process. Its captured output is capped at 32 MiB and each Git command has a 30-second timeout; it creates no service, detached process, or resident queue.",
    matchesSource: (source) => resourceStartCallCount(source) === 1 &&
      source.includes("const git = (...command: string[]) => execFileSync('git', command, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000 })") &&
      source.includes("git('diff', '--name-only', '-z', base, '--', '*.ts', '*.tsx')") &&
      source.includes("compareCodeHealth(merge(snapshots.before), merge(snapshots.after), lineage)") &&
      !/\bdetached\s*:\s*true/.test(stripCommentsAndStrings(source)),
  },
  {
    path: "scripts/check-new-clones.mts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for check-new-clones.mts: this manually invoked advisory ratchet uses one synchronous Git helper to reconstruct the selected baseline and changed paths, with a 32 MiB output cap and a 30-second per-command timeout. Clone analysis is in-process and any baseline write is the explicit --seed path; no worker remains after the CLI returns.",
    matchesSource: (source) => resourceStartCallCount(source) === 1 &&
      source.includes("const git = (cwd: string, ...argv: string[]) => execFileSync('git', argv,") &&
      source.includes("maxBuffer: 32 * 1024 * 1024, timeout: 30_000") &&
      source.includes("const scopes = [{ prefix: '', cwd: root, ref: base }, ...declaredSubmodules(root).map(") &&
      source.includes("if (seed && shrink) throw new Error('Choose either --seed or --shrink');") &&
      !/\bdetached\s*:\s*true/.test(stripCommentsAndStrings(source)),
  },
  {
    path: "scripts/lib/runtime-compatibility-census.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for runtime-compatibility-census.mjs: the two synchronous child sites read committed Git objects and ELF metadata for an attended, one-shot installed-artifact census. Git commands have a 120-second per-command timeout; ELF inspection has a 10-second timeout and 1 MiB output cap; neither site leaves work resident.",
    matchesSource: (source) => resourceStartCallCount(source) === 2 &&
      source.includes("function git(root, args, options = {})") &&
      source.includes("execFileSync('git', ['-C', root, ...args], { encoding: 'utf8',") &&
      source.includes("maxBuffer: 256 * 1024 * 1024") &&
      source.includes("...options, timeout: 120_000") &&
      source.includes("const inspectElf = (path) => execFileSync('readelf', ['--file-header', '--dynamic', '--wide', '--', path],") &&
      source.includes("timeout: 10_000, maxBuffer: 1024 * 1024") &&
      source.includes("export function readCommittedSources(") &&
      !/\bdetached\s*:\s*true/.test(stripCommentsAndStrings(source)),
  },
  {
    path: "scripts/lib/runtime-compatibility-probes.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for runtime-compatibility-probes.mjs: its three worker starts and two process starts are explicit protocol probes selected by capability id. Each uses a private temporary fixture, joins the child or worker, and terminates it in finally; none opens application data or starts a background owner.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      const workerStarts = [...code.matchAll(new RegExp(START_NON_VERB.source, "g"))].length;
      return resourceStartCallCount(source) === 2 && workerStarts === 3 &&
        source.includes("const worker = new Worker(script, { execArgv: [] });") &&
        source.includes("worker = new Worker(script, { execArgv: [] });") &&
        source.includes("workerData: { ortPath }") &&
        source.includes("child = fork(script, [], { execPath: process.execPath, execArgv: [],") &&
        source.includes("if (child && child.exitCode === null) child.kill('SIGKILL');") &&
        source.includes("finally { data.dispose(); terminal.kill(); }") &&
        source.includes("await rm(directory, { recursive: true, force: true });");
    },
  },
  {
    path: "scripts/lib/runtime-compatibility.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for runtime-compatibility.mjs: its two child sites are a synchronous runtime identity probe and an isolated semantic probe. The identity read has a 30-second timeout and 16 KiB output cap; the child probe has a validated 1–60 second deadline, a 1 MiB output ceiling, process-group kill, and terminal close handling.",
    matchesSource: (source) => resourceStartCallCount(source) === 2 &&
      source.includes("execFileSync(executable, ['--input-type=module', '-e', RUNTIME_PROBE], {") &&
      source.includes("timeout: 30_000, maxBuffer: 16_384") &&
      source.includes("const child = spawn(resolved, ['--input-type=module', '-e', CHILD, nonce, capabilityId, probePath ?? ''], {") &&
      source.includes("timeoutMs > 60_000") &&
      source.includes("maxOutputBytes > 1024 * 1024") &&
      source.includes("process.kill(-child.pid, 'SIGKILL')") &&
      source.includes("child.on('close', (code, signal) => {") &&
      source.includes("clearTimeout(timer);"),
  },
  {
    path: "scripts/lib/verify-tauri-native-env.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for verify-tauri-native-env.mjs: its two synchronous Git source-pin reads each have a 30-second deadline and 16 KiB output cap; the census preflight is bounded at 120 seconds, and the exact-checkout TypeScript verifier service and command have startup/stop deadlines plus a 120-second checker timeout and 8 MiB output cap.",
    matchesSource: (source) => resourceStartCallCount(source) === 5 &&
      source.includes("execFileSync('git', ['rev-parse', env.VERIFY_TAURI_SOURCE_REF || 'HEAD']") &&
      source.includes("cwd: repoRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: 16_384,") &&
      source.includes("execFileSync('git', ['rev-parse', 'HEAD']") &&
      source.includes("cwd: source, encoding: 'utf8', timeout: 30_000, maxBuffer: 16_384,") &&
      source.includes("preflightNativeVerifier(repoRoot, env, spawn = spawnSync)") &&
      source.includes("timeout: 120_000, maxBuffer: 1024 * 1024") &&
      source.includes("const child = spawn(process.execPath, [join(root, 'scripts/tsc-service/server.mjs')],") &&
      source.includes("Native TypeScript service startup timed out") &&
      source.includes("setTimeout(() => child.kill('SIGKILL'), 10_000)") &&
      source.includes("timeout: 120_000, maxBuffer: 8 * 1024 * 1024") &&
      source.includes("await child;"),
  },
  {
    path: "scripts/lib/workspace-host-gcs-publication.mjs",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for workspace-host-gcs-publication.mjs: its two gcloud start sites belong to the existing journaled release adoption/publication consumer. The command and private-byte read have explicit 30-minute and 15-minute deadlines; byte verification binds the exact digest and size, metadata mutation requires the original journal, and direct publication is stage-only. Re-reviewed 2026-10-28 (WI-6554700010042408): `exec` is now promisified lazily on first call (EI-10161 class: an eager module-scope promisify(execFile) crashes a narrow node:child_process test mock at import time). It wraps the same execFile and adds no start site.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      const gcloudStarts = childProcessVerbCallCount(code) +
        [...code.matchAll(/\bspawnImpl\s*\(/g)].length;
      return gcloudStarts === 2 &&
        source.includes("const exec = (...args) => (cachedExec ??= promisify(execFile))(...args);") &&
        source.includes("const runGcloud = async (args) => (await exec('gcloud', args, {") &&
        source.includes("maxBuffer: 4 * 1024 * 1024, timeout: 1800_000") &&
        source.includes("spawnImpl('gcloud', ['storage', 'cat', uri], {") &&
        source.includes("timeout: 900_000") &&
        source.includes("child.kill()") &&
        source.includes("if (!stageOnly) throw new Error('Direct GCS publication is private staging only;");
    },
  },
  {
    path: "scripts/verify-engineering-evidence-release.mjs",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for verify-engineering-evidence-release.mjs: its two synchronous children are the selected current-build integration receipt and the maintained headless Tauri browser journey. Each receives the remaining admitTaskDeadline budget and bounded output; the script retains phase receipts and starts no independent service.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      const runCalls = [...code.matchAll(/\brun\s*\(/g)].length;
      const unexpectedStarts = childProcessVerbCallCount(code) +
        [...code.matchAll(/\bspawnImpl\s*\(/g)].length;
      return runCalls === 2 && unexpectedStarts === 0 &&
        source.includes("run = spawnSync") &&
        source.includes("ENGINEERING_RELEASE_BUDGET_MS = 45 * 60_000") &&
        source.includes("const tests = run(process.execPath, [join(root, 'scripts/with-test-pg.mjs'), '--',") &&
        source.includes("const child = run('bash', [join(root, 'scripts/verify-tauri-headless.sh'), '--',") &&
        source.includes("timeout: budget.childCutoffEpochMs - nowMs") &&
        source.includes("maxBuffer: 16 * 1024 * 1024") &&
        source.includes("maxBuffer: 4 * 1024 * 1024") &&
        source.includes("admitTaskDeadline({ env: childEnv, nowMs })");
    },
  },
  {
    path: "scripts/verify-engineering-evidence-tauri.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for verify-engineering-evidence-tauri.mjs: the single synchronous child helper is used for finite checks inside the Tauri verifier owned by verify-tauri-headless.sh. Every command has a 90-second timeout and 8 MiB output cap, and each result is retained as evidence before the next check.",
    matchesSource: (source) => resourceStartCallCount(source) === 1 &&
      source.includes("function child(label, command, args, options = {})") &&
      source.includes("spawnSync(command, args, { env, encoding: 'utf8', timeout: 90_000,") &&
      source.includes("maxBuffer: 8 * 1024 * 1024") &&
      source.includes("assert(!result.error && !result.signal && result.status === 0") &&
      source.includes("const wait = (label, expression) => child(label, 'bash', [env.VERIFY_TAURI_POLL,"),
  },
  {
    path: "scripts/verify-fleet-capacity-recovery.mts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for verify-fleet-capacity-recovery.mts: its only child reads the exact native evidence blob from the run's immutable Git commit with a 30-second deadline and 4 MiB output ceiling. The verifier then checks that blob in-process and emits a read-only semantic result; no worker or queue is created.",
    matchesSource: (source) => resourceStartCallCount(source) === 1 &&
      source.includes("execFileSync('git', ['show', native.commitSha + ':' + native.filePath], {") &&
      source.includes("cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,") &&
      source.includes("inspectCommittedOperationalEvidence(root, native.filePath, createHash('sha256').update(bytes).digest('hex'))") &&
      source.includes("This is a one-shot, read-only CLI.") &&
      !/\bdetached\s*:\s*true/.test(stripCommentsAndStrings(source)),
  },
]);

// Supplemental reviewed rows join the shared scanner registry. Rows with explicit
// P-016 reviewed provenance also enter the P-016 exact-lane census.
const SUPPLEMENTAL_REVIEWED_DISPOSITIONS = Object.freeze([
  {
    path: "packages/operator-core/lib/llm-testing/tool-delivery-clean-cohort.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-015 reviewed bypass disposition for tool-delivery-clean-cohort.mjs: this prospective acceptance verifier makes one bounded read-only ptool code:run authority read and uses one synchronous Git helper to pin source and fixture bytes. It starts no serving process, detached child, or retained queue.",
    matchesSource: (source) => resourceStartCallCount(source) === 2 &&
      source.includes("export async function main(argv = process.argv.slice(2))") &&
      source.includes("JSON.parse(execFileSync('ptool', ['code:run'") &&
      source.includes("timeout: 180_000, maxBuffer: 1024 * 1024") &&
      source.includes("const gitAt = (base, args, directory) => execFileSync('git', args,") &&
      source.includes("timeout: 10_000, maxBuffer: 64 * 1024 * 1024") &&
      source.includes("claimCleanCohort(directory,"),
  },
  {
    path: "packages/operator-core/lib/memory/bench/runtime-qualification-cli.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-015 reviewed upstream disposition for runtime-qualification-cli.ts: its only child is the local strace wrapper required to capture runtime file opens. The CLI is explicitly restricted to the governed task/pc-heavy route, writes private write-once outputs, waits for the exact child exit, shuts down the embedder, and records a terminal receipt.",
    matchesSource: (source) => resourceStartCallCount(source) === 1 &&
      source.includes("Run under the governed task/pc-heavy route; outputs are private/write-once.") &&
      source.includes("const processChild = spawn('/usr/bin/strace',runtimeFileTraceArguments(outputs['file-opens.log'],[") &&
      source.includes("processChild.on('close',(code,signal)=>resolve({code,signal}));") &&
      source.includes("stopObserving();") &&
      source.includes("await shutdownLocalEmbedder();") &&
      source.includes("fs.closeSync(outFd);fs.closeSync(errFd);"),
  },
  {
    path: "apps/operator/scripts/psu-carry-fence.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "The pending WeakSet tracks only unbound legacy carry messages while their delivery is active; it does not strongly retain payloads. A scalar count lets fence() refuse safely until each message settles, and end() deletes each weak key idempotently. This is lifecycle state, not queued resource work.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source, "psu-carry-fence.mjs");
      const writers = [...code.matchAll(RESIDENT_QUEUE)];
      return source.includes("const pending = new WeakSet();") &&
        source.includes("let pendingLegacyCount = 0;") &&
        source.includes("const isWeakKey = value => value !== null &&") &&
        source.includes("message?.carryNonce === undefined") &&
        source.includes("!pending.has(message)") &&
        source.includes("pending.add(message);") &&
        source.includes("pending.delete(message)") &&
        source.includes("pendingLegacyCount > 0") &&
        source.includes("pendingLegacyCount += 1;") &&
        source.includes("pendingLegacyCount -= 1;") &&
        writers.length === 1 && writers[0][1] === "pending";
    },
  },
  {
    path: "packages/operator-core/lib/agent-identities/idop-p001-baseline.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-013 reviewed bypass disposition for idop-p001-baseline.ts: buildIdopP001Baseline has two sequential local Git metadata reads and is reachable only through this module's direct CLI guard; the integration-test importer calls inspectIdopP001PromptArchive, which starts no process. Each execFileSync waits for exit with a 10-second timeout and 1 KiB output bound. A failure propagates before the immutable baseline is written, and no child or queue remains. This one-shot evidence generator is not an agent runtime and carries no persistent capacity for a Governor receipt to meter.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return resourceStartCallCount(source) === 2 &&
        source.includes("const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {") &&
        source.includes("encoding: 'utf8', timeout: 10_000, maxBuffer: 1024,") &&
        source.includes("promptGitBlob: execFileSync('git', ['-C', root, 'hash-object', IDOP_P001_PROMPT_REL], {") &&
        source.includes("if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))") &&
        source.includes("{ flag: 'wx' }") &&
        !/\bdetached\s*:\s*true/.test(code) &&
        !hasCalledResourceStartAlias(code);
    },
  },
  {
    path: "packages/operator-core/lib/agent-identities/idop-p001-stack-population.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "The implication worklist is local to one pure population calculation. Mode ids are validated against the finite registry, the seen Set prevents implication cycles, and overlay enumeration is explicitly limited to 16 axes; it starts no resident work.",
    matchesSource: (source) => {
      const start = source.indexOf("export function enumerateIdopP001Stacks(");
      const end = source.indexOf("\ntype GeneratedComponent", start);
      if (start < 0 || end < 0) return false;
      const section = source.slice(start, end);
      const code = stripCommentsAndStrings(section, "idop-p001-stack-population.ts");
      const writers = [...code.matchAll(RESIDENT_QUEUE)];
      return section.includes("overlays.length > 16") &&
        section.includes("const queue = selected.flatMap(mode => [...mode.implies]);") &&
        section.includes("const id = queue.shift()!;") &&
        section.includes("if (seen.has(id)) continue;") &&
        section.includes("seen.add(id);") &&
        section.includes("queue.push(...implied.implies);") &&
        writers.length === 1 && writers[0][1] === "queue";
    },
  },
  {
    path: "packages/operator-core/lib/agent-identities/idop-p001-stack-population.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-013 reviewed bypass for the P-001 population source reader. Its sole process primitive is a synchronous local Git helper used by the dedicated population test to read the frozen superproject/submodule source set. Each call performs one submodule `ls-tree` and six sequential `show` reads, with a 15-second timeout and 4 MiB output cap per command; it creates no detached worker, retry loop, durable queue, or resident runtime work. Any failed pin/blob read aborts before the candidate population is returned. The source predicate pins the exact read set, command, timeout, buffer, and non-detached behavior.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      const pathsStart = source.indexOf("  const paths = [");
      const pathsEnd = source.indexOf("\n  ];", pathsStart);
      const pathsBlock = pathsStart >= 0 && pathsEnd >= 0
        ? source.slice(pathsStart, pathsEnd)
        : "";
      const pinnedPaths = [...pathsBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]);
      const expectedPaths = [
        "packages/operator-core/lib/modes/registry.ts",
        "packages/operator-core/lib/modes/store.ts",
        "packages/operator-core/lib/agent-tools/fleet_registry/join.ts",
        "packages/operator-core/lib/agent-tools/fleet_registry/take-leadership-core.ts",
        "libs/papercusp/packages/orchestrator/src/blueprint/mode-catalog.generated.ts",
        "libs/papercusp/packages/orchestrator/src/blueprint/su-stack.ts",
      ];
      return resourceStartCallCount(source) === 1 &&
        JSON.stringify(pinnedPaths) === JSON.stringify(expectedPaths) &&
        source.includes("export function readIdopP001StackSources(root: string, superprojectCommit: string)") &&
        source.includes("execFileSync('git', ['-C', repo, ...args], {") &&
        source.includes("encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 15_000,") &&
        source.includes("git(root, ['ls-tree', superprojectCommit, 'libs/papercusp'])") &&
        source.includes("const sources = paths.map(path => {") &&
        source.includes("const text = git(repo, ['show',") &&
        source.includes("const commit = nested ? gitlink : superprojectCommit;") &&
        !/\bdetached\s*:\s*true/.test(code) &&
        !hasCalledResourceStartAlias(code);
    },
  },
  {
    path: "packages/operator-core/lib/agent-tools/capability/__fixtures__/managed-api-client.mts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-014 reviewed parent-owned test-process start. The canonical managed-capability integration file runs under test-files' runGovernedTestFileProcess/runGovernedTestProcess receipt and passes its admission environment through with-test-pg into this test-only fixture. The fixture starts one non-detached private operator host, waits for readiness, then observes its exact process identity gone and closes its loopback page server in teardown before the admitted file worker exits. This adds no independent serving service or resident queue; its lifecycle is covered by the parent test-file admission.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      const caller = readFileSync(new URL("../packages/operator-core/lib/agent-tools/capability/managed-capability-api.integration.test.ts", import.meta.url), "utf8");
      const testRunner = readFileSync(new URL("./test-files.mjs", import.meta.url), "utf8");
      const pgWrapper = readFileSync(new URL("./with-test-pg.mjs", import.meta.url), "utf8");
      const privateHostEnv = readFileSync(new URL("../packages/operator-core/test/private-http-workspace-preflight.ts", import.meta.url), "utf8");
      const governedRunner = readFileSync(new URL("./lib/governed-test-process.mjs", import.meta.url), "utf8");
      return resourceStartCallCount(source) === 1 &&
        source.includes("assert(workspace?.startsWith('test-runtime-'), 'Disposable runtime identity required')") &&
        source.includes("assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '0');") &&
        source.includes("assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');") &&
        source.includes("const host = spawn(process.execPath, [bundle], { env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });") &&
        source.includes("try { await waitForPrivateOperator({ host, base, evidenceDir, environment: hostEnv, hostIdentity }); }") &&
        source.includes("catch (error) { await stopPrivateOperatorHost(host); throw error; }") &&
        source.includes("async () => { await stopPrivateOperatorHost(host);") &&
        source.includes("pageServer.close(() => resolve())") &&
        source.includes("await finishManagedApiTeardown({ hasProof: !!proof, rowCount: rows.length, cleanupErrors, close: [") &&
        !/\bdetached\s*:\s*true/.test(code) &&
        !hasCalledResourceStartAlias(code) &&
        caller.includes("filePath: 'packages/operator-core/lib/agent-tools/capability/managed-capability-api.integration.test.ts'") &&
        caller.includes("'packages/operator-core/lib/agent-tools/capability/__fixtures__/managed-api-client.mts'") &&
        caller.includes("resolve(__dirname, '__fixtures__/managed-api-client.mts')") &&
        caller.includes("captureIsolatedWorker(child, evidenceDir, isolatedTestFileWorkerOptions(childEnv, 1))") &&
        testRunner.includes("return runGovernedTestFileProcess(governedProcessImpl, governedOptions, runChild") &&
        testRunner.includes("const childEnv = startupTraceEnv(governedEnv ?? env);") &&
        testRunner.includes("env: childEnv,") &&
        testRunner.includes("child.once('close', (status, signal) => {") &&
        pgWrapper.includes("...childEnv,") &&
        privateHostEnv.includes("return { ...env, NODE_OPTIONS: kept.join(' ') }") &&
        governedRunner.includes("return await api.runGovernedOperation(operation, (context) => {");
    },
  },
  {
    path: "packages/operator-core/lib/agent-tools/plans/tree-instruments.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "The committed-submodule worklist now tracks each canonical repository path plus commit and fails closed on a repeated pair, preventing symlink aliases from making the walk recurse forever. Each remaining entry is a distinct checked-out repository snapshot in this synchronous census; it is not resident service work.",
    matchesSource: (source) => {
      const start = source.indexOf("async function notificationCensusAtCommit(");
      const end = source.indexOf("\n  const sources: Record<string, string> = {};", start);
      if (start < 0 || end < 0) return false;
      const section = source.slice(start, end);
      const code = stripCommentsAndStrings(section, "tree-instruments.ts");
      const writers = [...code.matchAll(RESIDENT_QUEUE)];
      return section.includes("const pending = [{ repo: '.', commit }];") &&
        section.includes("const visitedRepos = new Set<string>();") &&
        section.includes("const repoKey = JSON.stringify([await realpath(dir), next.commit]);") &&
        section.includes("visitedRepos.has(repoKey)") &&
        section.includes("visitedRepos.add(repoKey);") &&
        section.includes("const next = pending.shift()!;") &&
        section.includes("pending.push({ repo: path, commit: entry.object });") &&
        writers.length === 1 && writers[0][1] === "pending";
    },
  },
  {
    path: "packages/operator-core/lib/memory/bench/runtime-file-opens.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "The pending Map correlates unfinished strace records by thread while parsing one already-retained trace string. Duplicate starts, unmatched resumes, and leftovers fail closed; the map is discarded when this parser returns and starts no work.",
    matchesSource: (source) => {
      const start = source.indexOf("export function bindRuntimeModelOpens(");
      if (start < 0) return false;
      const nextExport = source.indexOf("\nexport function ", start + 1);
      const section = source.slice(start, nextExport < 0 ? source.length : nextExport);
      const code = stripCommentsAndStrings(section, "runtime-file-opens.mjs");
      const writers = [...code.matchAll(RESIDENT_QUEUE)];
      return section.includes("const pending = new Map(), lines = [], edges = [];") &&
        section.includes("pending.set(tid, { call: call.slice(0, -16), atMs });") &&
        section.includes("pending.delete(tid);") &&
        section.includes("if (pending.size) throw new Error('incomplete strace capture');") &&
        writers.length === 1 && writers[0][1] === "pending";
    },
  },
  {
    path: "packages/operator-core/lib/memory/bench/runtime-source-capture.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "Each worker's pending Map is protocol-response correlation for the bounded enable/breakpoint/resume handshake. Responses and transport errors delete entries; source capture holds the worker paused until reads settle, and the process terminal receipt exposes any leftover request. This diagnostic census does not queue independent resident work.",
    matchesSource: (source) => {
      const start = source.indexOf("export function startRuntimeSourceCapture(");
      const end = source.indexOf("\nif (process.env.PAPERCUSP_RUNTIME_SOURCE_CAPTURE)", start);
      if (start < 0 || end < 0) return false;
      const section = source.slice(start, end);
      const code = stripCommentsAndStrings(section, "runtime-source-capture.mjs");
      const writers = [...code.matchAll(RESIDENT_QUEUE)];
      return section.includes("pending: new Map(), nextId: 0, live: true") &&
        section.includes("target.pending.set(requestId, callback);") &&
        section.includes("child.pending.get(message.id)") &&
        section.includes("child.pending.delete(message.id);") &&
        section.includes("target.pending.delete(requestId)") &&
        section.includes("target.sourcePending = (target.sourcePending ?? 0) + 1;") &&
        section.includes("if (!target.paused || target.sourcePending || !target.live) return;") &&
        section.includes("target.pending.size + (target.sourcePending ?? 0)") &&
        writers.length === 1 && writers[0][1] === "target.pending";
    },
  },
  {
    path: "scripts/check-fire-and-forget-classification.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition: the queue and detachedQueue are local graph traversals over the already-parsed symbol population. queued prevents duplicate pending symbols and detached prevents duplicate propagation; this analysis creates no background work.",
    matchesSource: (source) => {
      const start = source.indexOf("const reverse = new Map();");
      const end = source.indexOf("const occurrences = new Map();", start);
      if (start < 0 || end < 0) return false;
      const section = source.slice(start, end);
      const code = stripCommentsAndStrings(section, "check-fire-and-forget-classification.mjs");
      const writers = [...code.matchAll(RESIDENT_QUEUE)];
      return section.includes("const queue = [...symbols.values()].filter(s => s.roots.size).map(s => s.id);") &&
        section.includes("const queued = new Set(queue);") &&
        section.includes("if (changed && !queued.has(receiver)) { queued.add(receiver); queue.push(receiver); }") &&
        section.includes("const detachedQueue = [];") &&
        section.includes("if (id && !detached.has(id)) { detached.add(id); detachedQueue.push(id); }") &&
        writers.length === 2 && writers.some(match => match[1] === "queue") &&
        writers.some(match => match[1] === "detachedQueue");
    },
  },
  {
    path: "scripts/lib/affected-path-routes.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition: the local queue computes reverse-dependency closure for one route selection. Every discovered workspace enters affected before enqueue, so each finite graph node is processed at most once; it starts no resident work.",
    matchesSource: (source) => {
      const start = source.indexOf("export function expandAffectedWorkspaceNames(");
      const end = source.indexOf("\n}", start);
      if (start < 0 || end < 0) return false;
      const section = source.slice(start, end);
      const code = stripCommentsAndStrings(section, "affected-path-routes.mjs");
      const writers = [...code.matchAll(RESIDENT_QUEUE)];
      return section.includes("const affected = new Set(included);") &&
        section.includes("const queue = [...seeds];") &&
        section.includes("if (affected.has(name)) continue;") &&
        section.includes("affected.add(name);") &&
        section.includes("queue.push(name);") &&
        section.includes("return affected;") &&
        writers.length === 1 && writers[0][1] === "queue";
    },
  },
  {
    path: "scripts/lib/pure-lane-proof-capture.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition: this per-invocation queue partitions the finite plan.order file list into slices. A timeout replaces one slice with disjoint sub-slices from that same list, and a single-file hang is terminal, so queued file count is conserved and no persistent service queue is created.",
    matchesSource: (source) => {
      const start = source.indexOf("  const queue = [];");
      const end = source.indexOf("\n  summary.state = \"done\";", start);
      if (start < 0 || end < 0) return false;
      const section = source.slice(start, end);
      const code = stripCommentsAndStrings(section, "pure-lane-proof-capture.mjs");
      const writers = [...code.matchAll(RESIDENT_QUEUE)];
      return section.includes("queue.push(plan.order.slice(i, i + sliceSize));") &&
        section.includes("const slice = queue[0];") &&
        section.includes("queue.shift();") &&
        section.includes("const parts = splitTimedOutSlice(slice);") &&
        section.includes("queue.unshift(...parts);") &&
        source.includes("if (slice.length <= 1) return [];") &&
        source.includes("out.push(slice.slice(i, i + size));") &&
        writers.length === 1 && writers[0][1] === "queue";
    },
  },
  {
    path: "scripts/lib/runtime-compatibility-census.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition: the pending array is a local traversal of the pinned ELF dependency graph. realpath inspection and traversed sets deduplicate nodes, while maxLibraries is validated as a positive safe integer and bounds the inspected population; no resident service work is queued.",
    matchesSource: (source) => {
      const start = source.indexOf("const libraries = [], edges = [], unresolved = [], inspected = new Map(), pending = [], traversed = new Set();");
      const end = source.indexOf("const result = { schema: 'papercusp-elf-library-candidates-v1'", start);
      if (start < 0 || end < 0) return false;
      const section = source.slice(start, end);
      const code = stripCommentsAndStrings(section, "runtime-compatibility-census.mjs");
      const writers = [...code.matchAll(RESIDENT_QUEUE)];
      return source.includes("!Number.isSafeInteger(maxLibraries) || maxLibraries < 1") &&
        section.includes("inspected.set(realPath, null);") &&
        section.includes("if (inspected.size > maxLibraries)") &&
        section.includes("pending.push(row);") &&
        section.includes("traversed.add(source.realPath);") &&
        section.includes("pending.push(target);") &&
        writers.length === 2 && writers.every(match => match[1] === "pending");
    },
  },
  {
    path: "scripts/lib/tsc-service.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition: takeTscServiceProjectBatch drains the caller-owned queue into a local snapshot, removes cancelled entries, returns one project batch, and puts only the unchanged remaining entries back. Queue cardinality cannot grow in this helper; the actual service queue has its own upstream disposition.",
    matchesSource: (source) => {
      const start = source.indexOf("export function takeTscServiceProjectBatch(queue)");
      const end = source.indexOf("\n}", start);
      if (start < 0 || end < 0) return false;
      const section = source.slice(start, end);
      const code = stripCommentsAndStrings(section, "tsc-service.mjs");
      const writers = [...code.matchAll(RESIDENT_QUEUE)];
      return section.includes("const pending = queue.splice(0).filter(item => !item.cancelled);") &&
        section.includes("const project = pending[0]?.request.project;") &&
        section.includes("if (item.request.project === project) batch.push(item);") &&
        section.includes("else queue.push(item);") &&
        section.includes("return batch;") &&
        writers.length === 1 && writers[0][1] === "queue";
    },
  },
  {
    path: "scripts/lib/verify-tauri-assertion-env.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition: the parser worklist contains only suffixes of one finite shell command after comment newlines. Each pushed suffix consumes a newline from its parent, so this is local tokenization state, not queued resource work.",
    matchesSource: (source) => {
      const start = source.indexOf("const pending = [command];");
      const end = source.indexOf("\n    if (hasPlaywrightTest(tokens))", start);
      if (start < 0 || end < 0) return false;
      const section = source.slice(start, end);
      const code = stripCommentsAndStrings(section, "verify-tauri-assertion-env.mjs");
      const writers = [...code.matchAll(RESIDENT_QUEUE)];
      return section.includes("while (pending.length) {") &&
        section.includes("parse(pending.shift(), key => key === 'OPERATOR_SOURCE_ROOT'") &&
        section.includes("if (newline >= 0) pending.push(token.comment.slice(newline + 1));") &&
        section.includes("else tokens.push(token);") &&
        writers.length === 1 && writers[0][1] === "pending";
    },
  },
  {
    path: "apps/operator/bin/release/dependency-lock-equivalence.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-014 reviewed bypass disposition for dependency-lock-equivalence.mjs (WI-10004151): its one child start is a synchronous, read-only git metadata probe used to compare immutable lockfile inputs. execFileSync is awaited, bounded to 64 MiB output, and retains no child, worker or queue after the comparison. The release admission path already owns the parent operation; adding a second local lease would double-count the same frozen repair check.",
    matchesSource: (source) =>
      resourceStartCallCount(source) === 1 &&
      source.includes("const runGit = (root, args) => execFileSync('git', ['-C', root, ...args], {") &&
      source.includes("maxBuffer: 64 * 1024 * 1024") &&
      source.includes("stdio: ['ignore', 'pipe', 'pipe']") &&
      source.includes("export function createGitInputManifestReader(git = runGit)"),
  },
  {
    path: "apps/operator/bin/release/dependency-lock-tree-audit.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-014 reviewed bypass disposition for dependency-lock-tree-audit.mjs: this standalone, node-only dependency verifier is called by dependency-generation.sh and imported by npm-install-safe, not started as a serving runtime. Its only child is the synchronous per-copy SQLite usability probe: `spawnSync(process.execPath, ['--eval', SQLITE_RUNTIME_PROBE, resolve(packagePath)], ...)` runs sequentially for installed better-sqlite3 lock entries, waits for exit, and is bounded to 15 seconds. The probe closes its in-memory database in finally; the parent retains no child or queue. Callers serialize install writes with their filesystem mutex and generation builds with the identity lock, but those locks are not represented as a Governor receipt for this nested probe. Keeping this helper node-only lets release and install checks run while the operator is down; a second resident lease would add no persistent capacity to govern.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return resourceStartCallCount(source) === 1 &&
        source.includes("import { spawnSync } from 'node:child_process';") &&
        source.includes("spawnSync(process.execPath, ['--eval', SQLITE_RUNTIME_PROBE, resolve(packagePath)], {") &&
        source.includes("encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,") &&
        source.includes("} finally { db.close(); }") &&
        !/\bdetached\s*:\s*true/.test(code) &&
        !/\bnew\s+(?:Worker|Piscina)\s*\(/.test(code) &&
        !hasCalledResourceStartAlias(code);
    },
  },
  {
    path: "packages/operator-core/lib/agent-chat-stream.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-013 reviewed upstream disposition for agent-chat-stream.ts: the native child is started only inside the shared runner's injected spawn seam, after reserveHostedAgentSlot has started a durable hosted-agent reservation. Exit/error handlers settle that reservation and the catch path settles failed starts, so the child inherits the parent host admission rather than opening a second root lease.",
    matchesSource: (source) =>
      resourceStartCallCount(source) === 1 &&
      source.includes("const reservation = await reserveHostedAgentSlot(") &&
      source.includes("randomUUID()") &&
      source.includes("await reservation?.start();") &&
      source.includes("const child = opts.spawnProcess ? await opts.spawnProcess(command, args, options) : spawn(command, args, options);") &&
      source.includes("child.once('exit', release);") &&
      source.includes("child.once('error', release);") &&
      source.includes("await reservation?.finish().catch(() => console.warn('[hosted-agent-admission] settlement_failed_charge_retained'));"),
  },
  {
    path: "scripts/lib/runtime-compatibility-admission.mjs",
    code: "missing-admission-context-or-release",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition: this isolated runtime-compatibility fixture validates both admission outcomes. On the admitted gateway path it checks outcome.kind before passing that same outcome.context to governor.release; on the enqueue path it reports the queued receipt without claiming or releasing execution capacity. The context is the runtime Governor result contract, although this JavaScript fixture has no TypeScript AdmissionContext token for the lexical checker.",
    matchesSource: (source) => {
      const admit = source.indexOf("outcome = await governor.admit({ idempotencyKey: 'same-request'");
      const admittedGuard = source.indexOf(
        "if (outcome.kind !== 'admitted') throw new Error('Gateway did not return an admitted receipt');",
        admit,
      );
      const release = source.indexOf("const released = await governor.release(outcome.context);", admittedGuard);
      return admit >= 0 && admittedGuard > admit && release > admittedGuard &&
        source.includes("const result = await new Governor(driver, { now: () => nowMs }).admit({") &&
        source.includes("return { queued: result.kind === 'queued' };") &&
        source.includes("return { admitted: true, stateAfterCompetitor: status.state, released: released.released };");
    },
  },
]);
export const P016_DISPOSITION_REGISTRY = new Map(
  [
    ...P016_REVIEWED_DISPOSITIONS,
    ...SUPPLEMENTAL_REVIEWED_DISPOSITIONS.filter(({ path, reason }) =>
      reason.startsWith("P-016 reviewed") &&
      RESOURCE_GOVERNOR_INVENTORY.some(({ migration, paths }) =>
        migration === "P-016" && paths.some((prefix) => path.startsWith(prefix))),
    ),
  ].map(({ path, code, disposition, reason, matchesSource }) => [
    `${path}::${code}`,
    { disposition, reason, ...(matchesSource ? { matchesSource } : {}) },
  ]),
);

export const BYPASS_REGISTRY = new Map([
  ...P016_DISPOSITION_REGISTRY,
  ...SUPPLEMENTAL_REVIEWED_DISPOSITIONS.map(({ path, code, disposition, reason, matchesSource }) => [
    `${path}::${code}`,
    { disposition, reason, ...(matchesSource ? { matchesSource } : {}) },
  ]),
  [
    "packages/operator-core/lib/agent-tools/coordination/inbox-visibility.ts::unbounded-resident-queue",
    {
      disposition: "semantic",
      reason:
        "The pending Map inside relevantSystemNoticeDelivery is a per-call index of digest metadata for the current input rows. The function fills it while filtering, reads it while building returned state, and discards it on return; it neither schedules work nor retains a queue between calls. The source pin keeps this exact Map type, set/get use, return, and sole queue-shaped write.",
      matchesSource: (source) => {
        const start = source.indexOf("export function relevantSystemNoticeDelivery<");
        const end = source.indexOf("\nexport function coalesceRepeatedBroadcasts", start);
        if (start < 0 || end < 0) return false;
        const section = source.slice(start, end);
        const code = stripCommentsAndStrings(section, "inbox-visibility.ts");
        const writers = [...code.matchAll(RESIDENT_QUEUE)];
        return section.includes("const pending = new Map<T, { key: string; fingerprint: string }>();") &&
          section.includes("pending.set(entry, { key, fingerprint });") &&
          section.includes("const notice = pending.get(entry);") &&
          section.includes("return { entries: kept, state, suppressed: entries.length - kept.length };") &&
          writers.length === 1 && writers[0][1] === "pending";
      },
    },
  ],
  [
    "packages/operator-core/lib/llm-testing/isolated-hosted-test-user.mts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "P-015 reviewed test-helper disposition: this child isolates the tsx module graph for hosted-test fixtures, not a serving or scheduled runtime. Each child speaks over IPC, serializes requests, and is stopped on fixture close or failure; stop sends SIGTERM, escalates to SIGKILL after one second, and awaits exit. The child adds no detached worker or retained queue beyond the current test fixture.",
      matchesSource: (source) => {
        const code = stripCommentsAndStrings(source);
        return resourceStartCallCount(source) === 1 &&
          source.includes("const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker], {") &&
          source.includes("stdio: ['ignore', 'ignore', 'ignore', 'ipc'],") &&
          source.includes("child.kill('SIGTERM');") &&
          source.includes("const timer = setTimeout(() => child.kill('SIGKILL'), 1_000);") &&
          source.includes("try { await exited; } finally { clearTimeout(timer); }") &&
          source.includes("finally { await stop(); }") &&
          !/\bdetached\s*:\s*true/.test(code) &&
          !hasCalledResourceStartAlias(code);
      },
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/work_items/semantic-dedup-probe-alarm.ts::unbounded-resident-queue",
    {
      disposition: "semantic",
      reason:
        "P-014 reviewed semantic disposition for semantic-dedup-probe-alarm.ts (WI-6554700010009231): the module-level `pending` Map holds one promise-chain TAIL per condition-key prefix, which serializes that prefix's alarm raise/recover delivery in arrival order. Each chained run belongs to the request that appended it, and that request awaits it; `finally` deletes the entry once the newest tail settles. So the map holds at most one entry per distinct prefix, the chain is never longer than the requests currently awaiting it, and nothing stays resident after they return. Pinned by matchesSource to that set/await/delete triple and to `pending` being the file's only queue-shaped write.",
      matchesSource: (source) =>
        source.includes("const pending = new Map<string, Promise<void>>();") &&
        source.includes("pending.set(prefix, next);") &&
        source.includes("try { await next; } finally { if (pending.get(prefix) === next) pending.delete(prefix); }") &&
        [...stripCommentsAndStrings(source, "semantic-dedup-probe-alarm.ts").matchAll(RESIDENT_QUEUE)]
          .map((match) => match[1])
          .join(",") === "pending",
    },
  ],
  [
    "packages/operator-core/lib/endpoint-route/routes/transport/pgbouncer-pool-sample.mjs::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "Reviewed bypass disposition for pgbouncer-pool-sample.mjs (WI-10006055): a deadline diagnostic shared by the MCP host and the MCP proxy watchdog. Each sample runs at most two `psql` children through an injectable execFile alias: a PgBouncer `SHOW POOLS` admin query (5-second timeout) and a direct pg_stat_activity snapshot (1.5-second timeout). Both use killSignal SIGKILL and a 32 KiB output ceiling. A per-process debounce (MIN_SAMPLE_INTERVAL_MS, 20 s by default) refuses overlapping samples. It must stay runnable when the pool or PgBouncer is the thing being diagnosed, so admission behind that same capacity would defeat it. It creates no worker, queue or resident process.",
      matchesSource: (source) => resourceStartCallCount(source) === 0 &&
        source.includes("execFileImpl = execFile,") &&
        source.includes("timeout: timeoutMs,") &&
        source.includes("killSignal: 'SIGKILL',") &&
        source.includes("maxBuffer: MAX_PSQL_BUFFER_BYTES,") &&
        source.includes("const ACTIVITY_TIMEOUT_MS = 1_500;") &&
        source.includes("if (requestedAtMs - lastSampleAt < MIN_SAMPLE_INTERVAL_MS) {") &&
        !/\bdetached\s*:\s*true/.test(stripCommentsAndStrings(source)),
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/plans/spec-test-adequacy.ts::unbounded-resident-queue",
    {
      disposition: "semantic",
      reason:
        "Reviewed semantic disposition for spec-test-adequacy.ts (WI-10006055): in metadataCoverageLimitations, pending is a function-local depth-first stack over one evidence details object. It is seeded with that object alone, consumed synchronously by pop, and each object is expanded at most once per disclosure mode (three modes) because the seen WeakMap skips any revisit at the same or a lower mode, so cycles terminate. It starts no work, holds no handle, and is discarded when the function returns. The source predicate requires that single writer, the pop consumption and the seen dedup, and rejects any additional queue writer.",
      matchesSource: (source) => {
        const code = stripCommentsAndStrings(source);
        const writers = [...code.matchAll(RESIDENT_QUEUE)];
        return writers.length === 1 && writers[0][1] === "pending" &&
          code.includes("const seen = new WeakMap<object, number>();") &&
          code.includes("while (pending.length > 0) {") &&
          code.includes("pending.pop()!") &&
          code.includes("if ((seen.get(value) ?? -1) >= mode) continue;") &&
          code.includes("seen.set(value, mode);") &&
          code.includes("pending.push({ value: child,");
      },
    },
  ],
  [
    "packages/operator-core/lib/endpoint-route/hosted-workspace-session.ts::unbounded-resident-queue",
    {
      disposition: "semantic",
      reason:
        "Reviewed semantic disposition for hosted-workspace-session.ts (WI-10006055): in authorizeHostSession, pending is the per-connector-socket set of in-flight authority request IDs, not queued work. A request is refused once 64 are in flight or when its ID is already present; each ID is removed in the finally that also clears the 15-second authority timer; and the set lives in a WeakMap keyed by the socket, so it is released with the connection. The authority read it guards is a single awaited principal lookup per request, not a started worker. The source predicate requires the 64 ceiling, the dedup, the finally removal and the WeakMap owner, and rejects any additional queue writer.",
      matchesSource: (source) => {
        const code = stripCommentsAndStrings(source);
        const writers = [...code.matchAll(RESIDENT_QUEUE)];
        return writers.length === 1 && writers[0][1] === "pending" &&
          code.includes("private readonly authorityRequests = new WeakMap<HostedWorkspaceRelaySocket, Set<string>>();") &&
          code.includes("const pending = this.authorityRequests.get(socket) ?? new Set<string>();") &&
          code.includes("if (pending.size >= 64 || pending.has(requestId)) return;") &&
          code.includes("pending.add(requestId);") &&
          code.includes("finally { if (timer) clearTimeout(timer); pending.delete(requestId); }");
      },
    },
  ],
  ["apps/operator/scripts/psu-terminal-diagnostics.mjs::resource-start-outside-admission", {
    disposition: "bypass",
    reason:
      "EI-25462239328125754: one call-local stty -a read of the interactive launcher terminal. It must work before an operator or admission service exists. The child is killed after 750ms or 8192 output characters, and its promise settles on close/error/timeout. It creates no application worker or resident queue. This disposition covers that single bounded terminal read, not arbitrary spawnCommand calls.",
    matchesSource: (source) => {
      const code = stripCommentsAndStrings(source);
      return resourceStartCallCount(source) === 0 &&
        [...code.matchAll(/\bspawnCommand\s*\(/g)].length === 1 &&
        source.includes("spawnCommand('stty', ['-a']") &&
        source.includes("platform === 'win32' || !interactive") &&
        source.includes("child.kill(); finish(null); }, 750)") &&
        source.includes("text.length > 8192") &&
        !/\bdetached\s*:\s*true/.test(code) && !/\bnew\s+(?:Worker|Piscina)\s*\(/.test(code);
    },
  }],
  [
    "packages/operator-core/lib/agent-tools/plans/committed-tree-reader.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "Reviewed bypass disposition for committed-tree-reader.ts: the sole child is a local `git cat-file --batch` reader with a per-batch timeout, awaited child close, and bounded blob batching. It reads immutable commit objects for the requested path closure; no detached process or resident work is retained.",
      matchesSource: (source) => resourceStartCallCount(source) === 1 &&
        source.includes("spawn('git', ['-C', repoDir, 'cat-file', '--batch']") &&
        source.includes("BLOB_BATCH_TIMEOUT_MS") &&
        source.includes("const timer = setTimeout(() => child.kill('SIGKILL'), BLOB_BATCH_TIMEOUT_MS)") &&
        source.includes("child.on('close'"),
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/plans/committed-tree-reader.ts::unbounded-resident-queue",
    {
      disposition: "semantic",
      reason:
        "Reviewed semantic disposition for committed-tree-reader.ts: queue is a per-call Git repository/submodule traversal frontier. Commits and pending repositories deduplicate work, listed records cache completed tree prefixes, and only gitlinks intersecting the requested base paths are enqueued; the local frontier is discarded when the read returns.",
      matchesSource: (source) => source.includes("const pending = new Set<string>();") &&
        source.includes("if (commits.has(repo) || pending.has(repo)) return;") &&
        source.includes("const queue: Array<{ repo: string; commit: string; prefixes: string[] }> = [];") &&
        source.includes("const listed = new Set<string>();") &&
        source.includes("if (entry.mode === '160000')") &&
        source.includes("if (covered.length)"),
    },
  ],
  [
    "packages/operator-core/lib/memory/bench/measurement-dossier.fixture.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "Reviewed bypass disposition for measurement-dossier.fixture.ts: its single execFileSync site is a test-fixture helper that runs finite git init/add/commit commands in a newly created temporary repository; cleanup removes that repository. It is not imported by a serving path.",
      matchesSource: (source) => resourceStartCallCount(source) === 1 &&
        source.includes("execFileSync('git'") &&
        source.includes("mkdtempSync(path.join(os.tmpdir(), 'measurement-dossier-'))") &&
        source.includes("cleanup: () => fs.rmSync(root, { recursive: true, force: true })"),
    },
  ],
  [
    "packages/operator-core/lib/memory/bench/measurement-dossier.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "Reviewed bypass disposition for measurement-dossier.ts: repoRootOf performs one synchronous local `git rev-parse --show-toplevel` metadata read to identify which repository owns an operator-supplied dossier; failures return null and no child survives the read.",
      matchesSource: (source) => resourceStartCallCount(source) === 1 &&
        source.includes("execFileSync('git', ['-C', path.dirname(path.resolve(file)), 'rev-parse', '--show-toplevel']") &&
        source.includes("Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))") &&
        source.includes("catch {\n    return null;\n  }"),
    },
  ],
  [
    "packages/operator-core/lib/memory/bench/tracked-evidence.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "Reviewed bypass disposition for tracked-evidence.ts: its shared git helper performs awaited, read-only rev-parse and ls-files metadata queries for the finite evidence paths in an operator-provided dossier. Missing files and non-tracked manifests return null; it creates no resident process or queue.",
      matchesSource: (source) => resourceStartCallCount(source) === 1 &&
        source.includes("return execFileSync('git', ['-C', cwd, ...args]") &&
        source.includes("git(repoRoot, ['ls-files', '--error-unmatch', '--', repoRelative])") &&
        source.includes("if (!repoRelative || repoRelative.startsWith('../')) return null;"),
    },
  ],
  [
    "packages/operator-core/lib/memory/bench/fixtures/native-ort-teardown-control.mjs::resource-start-outside-admission",
    {
      disposition: "upstream",
      reason:
        "Reviewed upstream disposition for WI-10005599's 130-byte native Mul teardown control: native-cuda-allocation-preflight.test.ts runs capture under the canonical test parent (runGovernedTestProcess/withGovernedAdmissionContext), which owns the receipt and test deadline. capture/debug-capture propagate process.env and await child close/pipe EOF; target owns one FILE Worker and awaits termination. No embedding weights, service, detach or resident queue. Source conditioning pins the tiny graph, three nested starts and awaited lifetime. Historical standalone capability:bash launches remain task-attributed only: their typed admission inheritance is unmeasured and is not certified by this source disposition.",
      matchesSource: (source) => {
        const code = stripCommentsAndStrings(source);
        return [...code.matchAll(/\b(?:spawn|spawnSync|fork|execFile|execFileSync)\s*\(/g)].length === 2 &&
          [...code.matchAll(/\bnew\s+Worker\s*\(/g)].length === 1 &&
          !/\bnew\s+Piscina\s*\(|\.admit\s*\(/.test(code) && !hasCalledResourceStartAlias(code) &&
          source.includes("const graphSha = '71f431c4e9321ec6fbeb158d02ed240459a7dcc98673fa79a4f439ce42efaf10'") &&
          /embeddingModelInferencePerformed:\s*false/.test(code) &&
          [...code.matchAll(/await\s+worker\.terminate\s*\(/g)].length === 2 && /child\.once\s*\(/.test(code) &&
          /env:\s*process\.env/.test(code);
      },
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/work_items/completion-freshness.ts::unbounded-resident-queue",
    {
      disposition: "semantic",
      reason:
        "Reviewed semantic disposition: createPersistedCompletionHistorySearchMemo retains completed Git-search verdicts for CompletionHistoryMemoStore.save, not future resource starts. flush writes and clears those records and restores failed writes; hydrate restores saved results. The existing memo limit evicts old cache results without throttling productive work. Scope this disposition to pending writes inside that memo and reject any additional resident queue or removal of persistence.",
      matchesSource: (source) => {
        const code = stripCommentsAndStrings(source);
        const start = code.indexOf('export function createPersistedCompletionHistorySearchMemo(');
        const end = code.indexOf('\n}', start) + 2;
        return start >= 0 && end > start && /\bstore\.save\s*\(/.test(code.slice(start, end)) &&
          [...code.matchAll(RESIDENT_QUEUE)].every((match) =>
            match[1] === 'pending' && match.index >= start && match.index < end);
      },
    },
  ],
  [
    "apps/operator/scripts/psu-pty-host.mjs::unbounded-resident-queue",
    {
      disposition: "semantic",
      reason:
        "P-013 reviewed semantic disposition: resolveLinuxCodexStartupPid uses a function-local breadth-first walk of an existing process tree, stops descending at maxDepth (default 4), and discards its traversal queue on return; it enqueues no resident work or child process.",
    },
  ],
  [
    "packages/operator-core/lib/dbos/routines-workflow.ts::unbounded-resident-queue",
    {
      disposition: "semantic",
      reason:
        "P-015 reviewed semantic disposition: remainingStartsByQueue is a per-tick Map of available-start counters initialized from dispatchEpoch.queues and decremented as workflows are scheduled; it tracks admission credits, not queued work.",
    },
  ],
  // Outside every P-016 inventory row's paths (agent-tools/testing/), so it is
  // dispositioned here beside its sibling affected-plan.ts rather than in
  // P016_REVIEWED_DISPOSITIONS, whose census covers only P-016 paths.
  [
    "packages/operator-core/lib/agent-tools/testing/mutation-probe-fence.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "Reviewed bypass disposition for mutation-probe-fence.ts: committedUnchanged runs awaited `git ls-tree -z HEAD` and `git hash-object` metadata reads over the probe's finite path list via promisified execFile, each bounded by a 5-second timeout and 1 MiB output, with an outer 10-second deadline that keeps the fence in force on a stall. It detaches nothing and creates no resident queue.",
    },
  ],
  // Same directory, same reason it lives here rather than in P016_REVIEWED_DISPOSITIONS.
  [
    "packages/operator-core/lib/agent-tools/testing/restricted-hold-fence.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "Reviewed bypass disposition for restricted-hold-fence.ts (plan personal-data-reader-set-labels-2026-10-01 D-012; WI-10005634, WI-10005724): its only start is runGit, an awaited `execFile('git', ...)` (60-second GIT_TIMEOUT_MS, 64 MiB maxBuffer) used by listDirtyFilesRecursive for one `git submodule status --recursive` and then one `git status --porcelain` per repository, strictly sequential, so at most one git metadata read runs at a time. It runs inside one testing:run request, before the governed router start it gates. A timeout or failure throws, and the fence then refuses the run (fail-closed). It detaches nothing and creates no resident queue.",
      matchesSource: (source) => {
        const code = stripCommentsAndStrings(source);
        return [...code.matchAll(/\b(?:spawn|spawnSync|fork|execFile|execFileSync)\s*\(/g)].length === 1 &&
          source.includes("execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS,") &&
          !/\bnew\s+Worker\s*\(|\bnew\s+Piscina\s*\(|\.admit\s*\(|\bdetached\b/.test(code) &&
          !hasCalledResourceStartAlias(code);
      },
    },
  ],
  [
    "packages/operator-core/lib/agent-identities/sink-evaluator.ts::hidden-or-static-capacity",
    {
      disposition: "semantic",
      reason:
        "P-013 reviewed semantic disposition for sink-evaluator.ts (portable-identity-packages P-010, D-009/D-017; WI-10003925): the only concurrency bound is SinkHostLimits.perSessionConcurrency, a per-session Semaphore that caps how many of ONE session's identity context providers are in flight at its sink invocations. A slot is released only when the provider's promise settles, so a provider that ignores its abort signal stays counted against its own session instead of becoming an orphan (D-009's hard admission cap). It is a sink-evaluation policy, like the per-invocation token and wall-clock budgets beside it, not a host capacity figure: the former static per-host Semaphore was removed, so host in-flight is at most perSessionConcurrency times the live sessions, and launched sessions already hold a durable Governor 'agent' admission lease (spawnGovernedAgentProcess). Providers run in-process inside the turn hook and may call only approved read-only bindings (D-009); any process such a binding starts is admitted at its own seam. sinkHostStatus() publishes live per-session and summed host in-flight counts.",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/testing/mutation-probe-closure.ts::unbounded-resident-queue",
    {
      disposition: "semantic",
      reason:
        "P-014 reviewed semantic disposition for mutation-probe-closure.ts: this import-closure queue is a per-request graph traversal, not resident work. Each file enters once, the metafile input population is refused above CLOSURE_FILE_CAP (20,000), and the build has a 20-second deadline. It starts no independent task and is discarded when the one preflight returns.",
    },
  ],
  [
    "apps/operator/bin/bundle-host-freshness.mjs::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "Every detected start is execFileSync('git', ...) for bounded repository identity and dirty-state metadata with an explicit 30s timeout; each call is synchronous and awaited, creates no worker or resident queue, and must remain available to reject a stale host bundle before launch.",
    },
  ],
  // ── cheap metadata reads: a git plumbing call that prints and exits ──────────
  // These are D-004's "cheap metadata operations that cannot materially increase
  // residency": single short-lived plumbing processes, awaited, no worker, no queue.
  // Governing them would add an admission round-trip per call to operations whose
  // whole cost is less than the admission record they would write.
  [
    "packages/operator-core/lib/agent-tools/plans/audit.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "git rev-parse HEAD — cheap metadata read, awaited, exits immediately",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/plans/git-history.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "git rev-parse --show-toplevel — cheap metadata read, awaited, exits immediately",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/plans/viewer-identity.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "git config user.email — cheap metadata read, awaited, exits immediately",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/harness/create.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "Reviewed bypass disposition for harness:create's registrationOnly path (WI-6554700010030439): before registering an existing checkout it proves the caller's path is that checkout's root, at the expected commit, and clean. Those proofs are exactly three awaited `git` metadata reads (rev-parse --show-toplevel, rev-parse --verify HEAD, status --porcelain) through one lazily promisified execFile alias, each under a 10 s timeout and a 1 MiB output cap, run once per tool call inside the caller's own tool invocation. No child outlives the call and nothing is queued; scaffolding paths start no process. The source predicate pins that single alias, its one call site, the three reads and their bounds, and rejects any additional start.",
      matchesSource: (source) => {
        const code = stripCommentsAndStrings(source);
        const branch = source.indexOf("if (args.registrationOnly === true) {");
        const alias = source.indexOf("const execFileAsync = promisify(execFile);");
        return resourceStartCallCount(source) === 0 &&
          branch >= 0 && alias > branch &&
          [...code.matchAll(/\bpromisify\s*\(\s*execFile\s*\)/g)].length === 1 &&
          [...code.matchAll(/\bexecFileAsync\s*\(/g)].length === 1 &&
          [...code.matchAll(/\bawait\s+git\s*\(/g)].length === 3 &&
          source.includes("const git = async (...argv: string[]) => (await execFileAsync('git', ['--no-optional-locks', '-C', path, ...argv], {") &&
          source.includes("env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 10_000, maxBuffer: 1024 * 1024,") &&
          source.includes("await git('rev-parse', '--show-toplevel')") &&
          source.includes("await git('rev-parse', '--verify', 'HEAD')") &&
          source.includes("await git('-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none')") &&
          !/\bdetached\s*:\s*true/.test(code) && !/\bnew\s+(?:Worker|Piscina)\s*\(/.test(code);
      },
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts::unbounded-resident-queue",
    {
      disposition: "semantic",
      reason:
        "Reviewed semantic disposition for spec-evidence-store.ts (WI-6554700010030439): in stringLeaves, pending is a function-local depth-first stack over one evidence value. It is seeded with that value alone, consumed synchronously by pop, and each object is expanded at most once because the seen Set skips revisits, so cyclic evidence terminates. It starts no work, holds no handle, and is discarded when the function returns its string leaves. The source predicate requires that single writer, the pop consumption and the seen dedup, and rejects any additional queue writer.",
      matchesSource: (source) => {
        const code = stripCommentsAndStrings(source);
        const writers = [...code.matchAll(RESIDENT_QUEUE)];
        const start = source.indexOf("function stringLeaves(value: unknown): string[] {");
        const end = source.indexOf("\n}\n", start);
        if (start < 0 || end < 0) return false;
        const section = source.slice(start, end);
        return writers.length === 1 && writers[0][1] === "pending" &&
          section.includes("const pending: unknown[] = [value];") &&
          section.includes("const seen = new Set<object>();") &&
          section.includes("while (pending.length > 0) {") &&
          section.includes("const current = pending.pop();") &&
          section.includes("if (current === null || typeof current !== 'object' || seen.has(current)) continue;") &&
          section.includes("seen.add(current);") &&
          section.includes("pending.push(...(Array.isArray(current) ? current : Object.values(current)));");
      },
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/work_items/fabricated-paths.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "git log -1 --format=%H --all over one path — cheap metadata read proving a cited path ever existed, awaited, exits immediately",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/work_items/untouched-paths.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "git status --porcelain and git log -1 --format=%ct over one path, each capped at a 5s timeout — cheap metadata reads, awaited, exit immediately",
    },
  ],
  [
    // NOT a git plumbing read, and deliberately not dispositioned as one: this
    // starts a node child running scripts/affected-tests.mjs. It is bypassed on
    // BOUNDEDNESS rather than cheapness — the start is awaited inside a single
    // Promise, carries an explicit timeout (AFFECTED_PLAN_TIMEOUT_MS), an 8MB
    // maxBuffer, and an optional AbortSignal, and the child prints its plan and
    // exits. It spawns no worker and leaves no resident queue, so it cannot
    // materially increase residency; the plan path deliberately RUNS NO TESTS.
    "packages/operator-core/lib/agent-tools/testing/affected-plan.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "node scripts/affected-tests.mjs --print-affected — bounded awaited child with an explicit timeout, maxBuffer and abort signal; prints the affected-test plan and exits, starting no worker and no resident queue",
    },
  ],
  [
    "apps/operator/bin/ascii-escape-bundle.mjs::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "node --check over one staged bundle — awaited syntax validation before atomic replacement, not resident runtime work",
    },
  ],
  // ── liveness/capability probes: ask the OS a question, start nothing ─────────
  [
    "apps/operator/bin/serve.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "ps -o command= -p <pid> — reads one process table row to identify a peer; starts no work",
    },
  ],
  [
    "packages/operator-core/lib/endpoint-route/routes/desktop/setup-pty-commands.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason: "which gh — binary-presence probe, exits immediately",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/computer/desktop-provisioner-core.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "xdpyinfo -display — X display liveness probe (spawnSync, stdio ignored, reads only the exit status); the provisioning start it guards is governed separately. Path repointed 2026-09-20: desktop-provisioner.ts was split on 2026-09-19 (6ec387d053) and is now a 1.7KB shim that only injects managedSpawn; the probe itself moved to desktop-provisioner-core.ts, so the old row went finding-absent while the new path carried an unreviewed finding",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/capability/exec-sandbox.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "bwrap /bin/true — one cached sandbox capability probe with a five-second timeout; starts no resident work",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/coordination/machine-capability-tags.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "docker info — one cached machine-capability probe with a 1.5-second timeout; starts no resident work",
    },
  ],
  // ── release / control path: D-004 names these explicitly ─────────────────────
  // Admission must never gate the path that RELEASES resources, or a saturated host
  // cannot recover: the kill that would free capacity would itself queue behind the
  // capacity it is trying to free. This is a deadlock, not an optimisation.
  [
    "packages/operator-core/lib/agent-tools/capability/bash-jobs.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "systemctl --user kill — cancellation/release of an already-admitted job; gating release on admission deadlocks recovery under saturation",
    },
  ],
  // ── P-015 sidecar/provider control and upstream-admitted starts ─────────────
  // P-001 (spawn-door-governor-migration-2026-08-31, D-006). console-spawn is
  // not a door — it is the low-level child-start PRIMITIVE that governed doors
  // wrap. resource-governor/spawn-execution.ts imports its result types (:3)
  // and spawnGovernedAgentProcess admits FIRST and then calls this as its
  // spawnProcess(context), so the lease is held by the caller across the
  // child's whole lifetime and re-admitting here would double-count one agent
  // start. Same shape as the psu-launcher.mjs row above. This row disposes of
  // the PRIMITIVE only: whether each importer (launch-agent, launch-on-plan,
  // goals/start, capability/terminal, fleet-headcount-action, goal-auto-start,
  // terminal-spawn) is itself admitted stays enforced against those files in
  // their own scanned prefixes — this is not a blanket exemption for callers.
  [
    "packages/operator-core/lib/console-spawn.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "spawnConsole/spawnHeadless are the child-start primitive that spawnGovernedAgentProcess wraps, not an independent door: admission and the lease are held by the calling seam across the child's lifetime (spawn-execution.ts imports this module's result types and calls it as spawnProcess(context)), so admitting here would double-count a single agent start; each importer remains separately enforced in its own scanned prefix",
    },
  ],
  [
    "packages/operator-core/lib/dbos/orchestrator-runner.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "spawnInvokeOnce is the DBOS pipeline agent-process chokepoint: its durable workflow supplies the receipt and its governorForBackend acquire supplies provider pacing; this direct child start is not a second resident queue, and re-admitting it would double-count the same agent turn",
    },
  ],
  [
    "packages/operator-core/lib/inference-gateway/gateway-sidecar-spawn.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "systemd/loopback gateway sidecar supervision and crash-respawn control; the child gateway owns provider admission, while this control path must remain runnable during gateway pressure",
    },
  ],
  [
    "packages/operator-core/lib/inference-gateway/watchdog.mjs::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "watchdog systemctl restart is release/recovery control for an external gateway process; gating it on the failed gateway would deadlock recovery",
    },
  ],
  [
    "packages/operator-core/lib/inference-gateway/watchdog.mjs::hidden-or-static-capacity",
    {
      disposition: "semantic",
      reason:
        "admission.maxConcurrent is a live provider-gateway health gauge used only to detect a frozen queue; it is not configured or enforced by this watchdog, so no capacity ceiling is duplicated",
    },
  ],
  [
    "packages/operator-core/lib/inference-gateway/gateway.ts::hidden-or-static-capacity",
    {
      disposition: "semantic",
      reason:
        "Reviewed for EI-26751546283561244: the single maxConcurrent: 1 is a per-account Codex attempt permit-order queue around RateLimitGovernor.acquire. It serializes permit acquisition to preserve priority; it does not cap provider execution, which uses the separate ProviderAdmissionLifecycle window. The gateway-account-rate-pacing test proves an interactive waiter passes a background waiter after the first acquire settles. Request abort and maxQueueWaitMs cancel queued attempts. The source pin requires this exact one-slot queue, acquire-only task body, and cancellation path; drift restores the finding for review.",
      matchesSource: (source) => {
        const code = stripCommentsAndStrings(source);
        const staticCaps = [...code.matchAll(new RegExp(STATIC_CAP.source, "gi"))].map(([match]) =>
          match.replace(/\s+/g, " ").toLowerCase(),
        );
        const functionStart = source.indexOf("const acquireCodexAttemptPermit = async (");
        const functionEnd = functionStart < 0 ? -1 : source.indexOf("\n  };", functionStart);
        const attemptSource =
          functionEnd > functionStart ? source.slice(functionStart, functionEnd) : "";
        return (
          staticCaps.length === 1 &&
          staticCaps[0] === "maxconcurrent: 1" &&
          !HIDDEN_SEMAPHORE.test(code) &&
          source.includes("const codexAttemptQueues = new Map<RateLimitGovernor, PriorityAdmissionQueue>();") &&
          attemptSource.includes("queue = new PriorityAdmissionQueue({ maxConcurrent: 1 });") &&
          attemptSource.includes(
            "const governor = governorForAccount(model || SERVICEABLE_CLAMP_MODEL, accountId, 'codex');",
          ) &&
          attemptSource.includes(
            "const release = await queue.run(priorityFromLabel(priorityLabel), () => {",
          ) &&
          attemptSource.includes("return governor.acquire({}, {") &&
          attemptSource.includes("signal: waitingSignal,") &&
          attemptSource.includes(
            "const timer = setTimeout(() => deadline.abort(), maxQueueWaitMs);",
          ) &&
          attemptSource.includes("}, { signal: waitingSignal });") &&
          attemptSource.includes(
            "finally {\n      clearTimeout(timer);\n      unsubscribe();",
          )
        );
      },
    },
  ],
  [
    "packages/operator-core/lib/memory/embed-sidecar-spawn.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "supervised sidecar child lifecycle (startup/respawn/release control); each sidecar request unit is admitted by embed-sidecar-server.ts and re-admitting the supervisor would double-count the process",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/dev/restart.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "delayed systemd restart — control/recovery path that releases the current operator and must remain runnable under saturation",
    },
  ],
  [
    "packages/operator-core/lib/endpoint-route/routes/harness/features.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "git worktree remove + branch delete — feature teardown releases filesystem/process coordination state and must remain runnable under saturation",
    },
  ],
  // ── bounded benchmark/diagnostic work ───────────────────────────────────────
  // These paths either inspect metadata or drain a finite, caller-owned fixture.
  // They do not create resident service work and therefore do not need a second
  // durable admission receipt; keep the exemption explicit and reviewable.
  [
    "packages/operator-core/lib/dbos/bootstrap.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "git rev-parse used only to locate the canonical checkout before arming a watchdog; no resident work starts",
    },
  ],
  [
    "packages/operator-core/lib/memory/audit-anchors.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "git ls-files builds a bounded read-only index of repository anchors; it starts no resident work",
    },
  ],
  [
    "packages/operator-core/lib/memory/bench/wi-6512-known-item-replay-cli.ts::unbounded-resident-queue",
    {
      disposition: "semantic",
      reason:
        "finite in-memory benchmark pair list is test workload enumeration, not a resident production queue; evidence required",
    },
  ],
  [
    "packages/operator-core/lib/memory/bench/measurement-manifest.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "the frozen-manifest contract for the hand-invoked memory benchmarks (embedder-eval-cli.ts, candidate-hybrid-bench.ts) runs two synchronous, read-only git metadata probes per measurement cell: `git check-ignore --quiet` (the summary path must stay Git-eligible) and `git merge-base --is-ancestor <sourceCommit> HEAD` (the frozen source commit must still be in history). Each returns one exit status, retains nothing and starts no resident work; they run only when a human runs a benchmark, never on a scheduled or serving path (WI-10004627)",
    },
  ],
  [
    "packages/operator-core/lib/memory/op-deadline.ts::unbounded-resident-queue",
    {
      disposition: "semantic",
      reason:
        "pending promise set tracks already-started memory operations until settlement; it is a lifecycle ledger, not queued work; evidence required",
    },
  ],
  [
    "packages/operator-core/lib/inference-gateway/stall-waker.ts::unbounded-resident-queue",
    {
      disposition: "semantic",
      reason:
        "pending map is a TTL-bounded stall observation set; it never queues resource starts; evidence required",
    },
  ],
  // ── P-013 agent-process-memory lane (D-026 remediation) ──────────────────────
  // The lane's governed seams are pty-bridge.ts:192 (beginGovernedExecution,
  // admissionClass 'process' -> spawn :247), resource-governor/spawn-execution.ts:46
  // (admissionClass 'agent'), and fleet/sidecar-exec-process.ts:96. The rows below are
  // the residue those seams deliberately do NOT cover: probes, release/control calls,
  // and correlation ledgers. Each states what its own process actually does.
  [
    "apps/operator/scripts/psu-launcher.mjs::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        'launcher CLI, 9 detected starts, every one a bounded probe or an interactive install: curl operator-health (:225,:250,:4390,:8214), systemctl unit query (:241), gh auth token (:5136), ps -o tty= (:6722), which-bin probe (:11660), runInstallerInherit (:11739, awaited, stdio inherit, one backend install). ⚠ EVIDENCE OF WHAT THIS ROW DOES NOT COVER: the file ALSO starts the real resident agent wrapper at spawnInherit (:8342) via spawnImpl(wrapperBin, args, {detached:true}) (:8367), where `spawnImpl = spawn` is defaulted at :8347 — the START regex cannot match an aliased call, so that start is registered here by hand rather than detected. It is admitted upstream when operator-launched (capability/launch-agent.ts:1250 -> spawnGovernedAgentProcess -> beginGovernedExecution admissionClass "agent"); a human typing psu in a terminal is the operator entry path itself, not fleet-initiated fan-out. Detector gap tracked separately; evidence required',
    },
  ],
  [
    "apps/operator/scripts/psu-pty-host.mjs::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        'pty.spawn (:3743) starts the launched agent\'s OWN child under the host that already represents it; admission happened upstream at capability/launch-agent.ts:1250 -> spawnGovernedAgentProcess -> beginGovernedExecution admissionClass "agent" (spawn-execution.ts:46). Re-admitting the same logical agent inside its own host would double-count it. The other two START hits are a detector coincidence, not starts: turnCoalescer.admit (:4820) and staleFireGuard.admit (:5041) are local fold/dedupe methods matched by the `.admit(` alternative; evidence required',
    },
  ],
  [
    "apps/operator/scripts/psu-operator-down-diagnosis.mjs::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "Reviewed P-013 bypass disposition for psu-operator-down-diagnosis.mjs: the psu launcher uses this control-path helper only after its operator health request stays pending, to identify the systemd unit that is down. The helper's only child start is a synchronous `systemctl --user` read with a 3-second timeout; commands are awaited, sequential and return captured output. It creates no worker, detached child, durable queue or resident work. psu-launcher guards the notice to once per launcher process. This is an operator recovery diagnostic, not runtime workload; its exact source predicate below rejects added starts or removal of the bounded systemctl timeout.",
      matchesSource: (source) => {
        const code = stripCommentsAndStrings(source);
        return [...code.matchAll(/\b(?:spawn|spawnSync|fork|execFile|execFileSync)\s*\(/g)].length === 1 &&
          source.includes('const SYSTEMCTL_TIMEOUT_MS = 3_000;') &&
          source.includes('spawnSync("systemctl", ["--user", ...args, "--no-pager"], {') &&
          code.includes("timeout: SYSTEMCTL_TIMEOUT_MS") &&
          !/\bnew\s+(?:Worker|Piscina)\s*\(/.test(code) &&
          !/\bdetached\s*:\s*true/.test(code);
      },
    },
  ],
  [
    "packages/operator-core/lib/agent-auth-detect.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "seven credential-presence probes, all spawnSync (awaited by construction) with explicit timeouts and no resident work: security find-generic-password (:42,:87), security dump-keychain (:100), a keychain read (:130), gh auth status (:312), git config --get-all credential.helper (:318). Same cheap-metadata class as agent-tools/plans/viewer-identity.ts; evidence required",
    },
  ],
  [
    "packages/operator-core/lib/agent-bin-detect.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        'spawnSync("which", [bin]) (:111) — single binary-presence probe, awaited, exits immediately. Identical to the already-registered setup-pty-commands.ts "which gh" row; evidence required',
    },
  ],
  [
    "packages/operator-core/lib/agent-state-divergence.ts::unbounded-resident-queue",
    {
      disposition: "semantic",
      reason:
        "pending.push(c) (:704) appends to a LOCAL DivergenceCall[] that cuts an already-materialized call timeline into consecutive-failure episodes; it is reset to [] at every success and discarded when the loop ends. It is an analysis buffer over finite input, bounded by the timeline being read, and starts nothing; evidence required",
    },
  ],
  [
    "packages/operator-core/lib/fleet/spawner-ipc-client.ts::unbounded-resident-queue",
    {
      disposition: "semantic",
      reason:
        "this.pending.set(id, {resolve, reject}) (:186) is an in-flight RPC CORRELATION map, not queued work: every entry is self-evicting via a 30s default timeout that deletes it (:176-178) and both settle paths delete it. Bounded by concurrently in-flight RPCs; the requests it correlates were already started. Same lifecycle-ledger shape as memory/op-deadline.ts; evidence required",
    },
  ],
  [
    "packages/operator-core/lib/fleet/spawner-sidecar-spawn.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "killOwnedScope (:62) execFileSync systemctl --user kill of the sidecar's OWN managed scope — a RELEASE/control call that frees residency. Synchronous on purpose: its call sites are a process-exit hook and a timer callback, neither of which has an async turn left. Gating release on admission deadlocks recovery under saturation, exactly as the registered bash-jobs.ts row states; evidence required",
    },
  ],
  // ── binding-aware detector dispositions (EI-21714833795753624) ─────────────
  // These aliases are now detected by hasCalledResourceStartAlias. Each is a
  // bounded probe, metadata read, setup write, or user-requested git operation;
  // none creates a resident worker or an in-memory queue of work.
  [
    "packages/operator-core/lib/agent-tools/capability/bash_output.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "scopeExecFile is promisify(execFile) used for bounded systemd/cgroup liveness metadata; it probes an already-recorded task and starts no resident work.",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/dev/systemd-service-probe.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "run is promisify(execFile) for bounded systemd/ps start-time diagnostics; it reads service metadata and starts no resident work.",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/git_sync/run.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "execFileP is promisify(execFile) for a bounded git rev-parse preflight around the durable git-sync routine; no independent resident worker starts.",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/setup/set_git_identity.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "exec is promisify(execFile) for two awaited user-requested git-config writes; setup metadata is finite and does not create resident work.",
    },
  ],
  [
    "packages/operator-core/lib/endpoint-route/routes/desktop/git-identity.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "exec is promisify(execFile) for bounded git-config reads/writes in the user-facing setup endpoint; each command is awaited and finite.",
    },
  ],
  [
    "packages/operator-core/lib/endpoint-route/routes/desktop/preflight.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "exec is promisify(execFile) for bounded binary --version and bundled-path probes in preflight; it starts no resident work.",
    },
  ],
  [
    "packages/operator-core/lib/endpoint-route/routes/desktop/setup-status.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "exec is promisify(execFile) for bounded git identity metadata probes in setup-status; failures degrade to status and no queue is retained.",
    },
  ],
  [
    "packages/operator-core/lib/endpoint-route/routes/misc/health-deep.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "runProbeCommand spawns one bwrap user-namespace probe (BWRAP_USERNS_PROBE_ARGS, a /bin/true payload) for the agent-sandbox health leg: awaited to exit, not detached, SIGKILLed at AGENT_SANDBOX_PROBE_TIMEOUT_MS (30 s), single-flight, and a definitive answer is cached for AGENT_SANDBOX_PROBE_TTL_MS (10 min). It holds nothing after exit and must stay runnable under pressure because it reports whether agents can sandbox at all (WI-10004649).",
    },
  ],
  [
    "packages/operator-core/lib/endpoint-route/routes/harness/feature-views.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "execFileP is promisify(execFile) for bounded, user-requested git diff/stat reads with maxBuffer limits; output is returned, not queued as resident work.",
    },
  ],
  [
    "packages/operator-core/lib/endpoint-route/routes/harness/notes-diff.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "execFileP is promisify(execFile) for bounded git diff/status reads with maxBuffer limits in a user-facing endpoint; no resident worker remains.",
    },
  ],
  [
    "packages/operator-core/lib/endpoint-route/routes/harness/project-history-source.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "defaultGit() wraps execFile for ONE bounded `git log` per History page: PROJECT_HISTORY_GIT_TIMEOUT_MS (20s) and a 32MB maxBuffer, awaited, its output returned and parsed in-process with no resident worker left behind. This file exists to REDUCE residency rather than add it — it replaced a CLI provider that shelled out once per plan and per work-item and then walked the entire commit graph with --name-only (~290s against a 90s child budget, hundreds of children, WI-10001548 defect A) with a single grep-bounded child per page.",
    },
  ],
  [
    "packages/operator-core/lib/endpoint-route/routes/harness/sync.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "execFileAsync is promisify(execFile) for bounded, user-requested git fetch/rebase/status operations in a durable user worktree; git owns recovery state and no in-memory resident queue is created.",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/capability/rtk-rewrite.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "`rtk rewrite <command>` — one string-to-string translation per capability:bash call (WI-6554700010009291), killed after RTK_REWRITE_TIMEOUT_MS (2s) and awaited before the governed job spawn; it runs no user work and leaves nothing resident. The command it returns is executed by bash-jobs' existing admitted spawn.",
    },
  ],
  // ── reviewed retry around a receipt-producing write (EI-21850494041821321) ───
  [
    "packages/operator-core/lib/resource-governor/queue.ts::retry-around-receipt",
    {
      disposition: "semantic",
      reason:
        "The one retry in this file wraps store.enqueue — the write that CREATES the receipt — via acquireWithContentionRetry, and is keyed by idempotencyKey: a pg lock/statement timeout aborts its transaction so nothing is committed, and if an earlier attempt HAD committed, the retry returns that same row and the requestFingerprint check still raises a genuine idempotency conflict. Non-contention faults propagate on the first attempt. Admission is PRE-execution, so dropping the record would mean running ungoverned; the retry is the correct lever. The detector recognizes the retry callback and receipt-producing enqueue operation rather than unrelated option-type fields.",
    },
  ],
  // ── identity-surface census: a bounded git index read (identity-system-everything-migration-2026-10-18 P-001) ──
  [
    "packages/operator-core/lib/agent-identities/identity-surface-census.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "Reviewed bypass disposition for identity-surface-census.ts: the sole child is a synchronous local `git ls-files -z` index listing with a 60s timeout, run only by the census generator script and its drift test. execFileSync waits for exit, so no detached process, worker or resident queue outlives the call, and it holds no machine capacity a Governor.admit ticket would meter.",
      matchesSource: (source) => resourceStartCallCount(source) === 1 &&
        source.includes("execFileSync('git', ['-C', cwd, 'ls-files', '-z', '--', ...pathspecs]") &&
        source.includes("timeout: GIT_LS_FILES_TIMEOUT_MS") &&
        !/\bdetached\b/.test(stripCommentsAndStrings(source)),
    },
  ],
  // ── spawner-sidecar forkserver (sidecar-forkserver-2026-10-21, WI-6554700010019379) ──
  [
    "packages/operator-core/lib/fleet/forkserver/forkserver-client.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "Reviewed bypass for the spawner sidecar's forkserver client. startForkserver starts one task-manager sidecar with managedSpawn; that server performs no user work and only forks a requested child so the large sidecar stops forking on its admission event loop. directSpawn is the fallback for that same request. sidecar-exec-process.ts calls spawnSidecarChild only after beginGovernedExecution holds the per-request admission, then settles it on process-group exit. Pin the managed sidecar start and the single direct fallback primitive; neither adds an independent work queue.",
      matchesSource: (source) => resourceStartCallCount(source) === 1 &&
        source.includes("void managedSpawn('/usr/bin/env', ['-u', 'NODE_OPTIONS', process.execPath, '-e', FORKSERVER_SOURCE], {") &&
        source.includes("class: 'sidecar', title: 'spawner forkserver'") &&
        source.includes("return spawn(req.command, req.args, {") &&
        source.includes("if (req.forkserverIdentity === null) return directSpawn(req);"),
    },
  ],
  [
    "packages/operator-core/lib/fleet/forkserver/forkserver-client.ts::unbounded-resident-queue",
    {
      disposition: "semantic",
      reason:
        "server.pending and server.children are in-flight correlation maps, not queued work. Each entry is one child that execProcess already admitted and is awaiting. A pending entry moves to children on the forkserver's 'spawned' ack. A children entry is deleted on 'close'. Both maps are cleared when the forkserver dies, and every entry is settled as an infrastructure fault. Their size is bounded by the sidecar's concurrently admitted execs.",
      matchesSource: (source) => source.includes("server.pending.delete(m.id)") &&
        source.includes("server.children.delete(m.id)") &&
        source.includes("server.pending.clear()") &&
        source.includes("server.children.clear()"),
    },
  ],
]);

function registryKey(path, code) {
  return `${path}::${code}`;
}

/**
 * Build one inventory row. Every descriptive field is REQUIRED and none has a
 * default — deliberately.
 *
 * The previous signature defaulted fanOut/durableSource/telemetry/contextAndRelease/
 * currentCaps/writerEvidence to five shared constants, so every lane inherited
 * identical prose and `validateInventory`'s presence check passed while the
 * inventory described nothing (auditSeq 9, D-026). Removing the defaults is what
 * makes that regression structurally impossible rather than merely detected: a new
 * lane cannot be decorative by omission, because omission no longer compiles into
 * boilerplate — it produces `undefined` and trips `inventory-missing`.
 */
function inventory(row) {
  return Object.freeze({
    disposition: "govern",
    ...row,
    enforcement: row.enforcement ?? `pending-${row.migration}`,
    sites: Object.freeze((row.sites ?? []).map((s) => Object.freeze(s))),
  });
}

const START_VERBS = ["spawn", "spawnSync", "fork", "execFile", "execFileSync"];
const START_NON_VERB = /new\s+(?:Worker|Piscina)\s*\(/;
// A start verb is also the natural NAME for a caller-supplied callback: a pacing,
// retry, or instrumentation wrapper takes `spawn: () => Promise<T>` and calls
// `spawn()` while starting nothing itself. The real child process is started by the
// caller it wraps, at a site this same scan already covers, so counting the wrapper
// as a start reports the one start twice and pins the finding on the file that does
// not make it. That is a detector misfire, and BYPASS_REGISTRY deliberately refuses
// to absorb misfires ("a detector that misfires is a detector bug to fix, and
// registering it would preserve the bug behind a row that reads as judgement"), so
// it is narrowed HERE rather than dispositioned.
//
// The exemption is deliberately hard to obtain, because it must not become a way to
// launder a real start: the identifier has to be declared as a function-typed
// binding in this same file (`spawn: (`), AND the file must never import or require
// that name. A file that pulls in the real primitive keeps its finding even when it
// also happens to carry a callback parameter of the same name.
function isLocalCallbackBinding(code, name) {
  if (!new RegExp(`\\b${name}\\s*:\\s*\\(`).test(code)) return false;
  return !new RegExp(`\\b(?:import|require)\\b[^;\\n]*\\b${name}\\b`).test(
    code,
  );
}
function hasResourceStart(code) {
  if (START_NON_VERB.test(code)) return true;
  if (INLINE_PROMISIFIED_RESOURCE_START.test(code)) return true;
  for (const verb of START_VERBS) {
    if (!new RegExp(`\\b${verb}\\s*\\(`).test(code)) continue;
    if (isLocalCallbackBinding(code, verb)) continue;
    return true;
  }
  return false;
}
// Direct-call matching misses dependency-injected aliases such as
// `const spawnImpl = spawn` / `spawnImpl(...)` and
// `const exec = promisify(execFile)` / `exec(...)`. Match only identifiers
// syntactically bound to one of the real child-process starts, then require a
// call to that same identifier. Widening by name (`spawn[A-Z]...`) is unsafe:
// it turns ordinary domain words such as `spawnRowKind` into false starts.
const ALIAS_BIND =
  /\b([A-Za-z_$][\w$]*)\s*[=:]\s*(?:promisify\s*\(\s*)?(?:spawn|spawnSync|fork|execFile|execFileSync)\s*[,\)\s;}]/g;
// Lazy wrappers avoid eagerly promisifying an undefined test mock. They still
// invoke the same child-process primitive; Reflect.apply is not an exemption.
const LAZY_PROMISIFY_ALIAS_BIND =
  /\b([A-Za-z_$][\w$]*)\s*=\s*\(\s*\([^)]*\)\s*=>\s*Reflect\.apply\s*\(\s*\(\s*[A-Za-z_$][\w$]*\s*\?\?=\s*promisify\s*\(\s*(?:spawn|spawnSync|fork|execFile|execFileSync)\s*\)\s*\)/g;
function hasCalledResourceStartAlias(code) {
  const aliases = new Set();
  for (const pattern of [ALIAS_BIND, LAZY_PROMISIFY_ALIAS_BIND]) {
    for (const match of code.matchAll(pattern)) {
      const name = match[1];
      if (/^(?:spawn|spawnSync|fork|execFile|execFileSync)$/.test(name)) continue;
      aliases.add(name);
    }
  }
  for (const name of aliases) {
    const escaped = name.replace(/\$/g, "\\$");
    if (new RegExp(`\\b${escaped}\\s*\\(`).test(code)) return true;
  }
  return false;
}
const GOVERNED =
  /\bGovernor\.admit\b|\bgovernor\.admit\s*\(|\bbeginGovernedExecution\s*\(|\bwithGovernedExecution\s*\(|\brunGovernedOperation(?:\s*<[^;()]*>)?\s*\(|\brunGovernedTestProcess\s*\(|\bAdmissionContext\b|\bvalid(?:ated)?\s+local\s+lease\b/i;
const RELEASE = /\.release\s*\(|\bAdmissionRelease\b/;
const STATIC_CAP =
  /\b(?:maxConcurrent|maxWorkers|maxQueue|maxSimultaneous|capacityCeiling)\b\s*(?:[:=]|\?\?)\s*\d+/i;
const HIDDEN_SEMAPHORE = /\b(?:Semaphore|semaphore|p-limit|Bottleneck)\b/;
const DURABLE_QUEUE_OBJECT = /(?:work_items|durable|receipt|postgres|DBOS)/i;
// Match collections whose identifier says they are a queue/backlog.  The old
// `(?:queue|pending|backlog)\w*` prefix also matched diagnostic Sets such as
// `pendingGradingAuditTargetIds.add(...)`: that is an ID accumulator, not a
// resident work queue, and made the active P-014 lane fail on its own gate
// bookkeeping.  Keep the exact `pending` spelling for the small conventional
// case, while requiring a Queue/Backlog suffix for compound names so pending
// IDs, tokens, and targets do not look like resident work.
const RESIDENT_QUEUE =
  /\b((?:[A-Za-z_$][\w$]*\.)*(?:queue|backlog|pending|[A-Za-z_$][\w$]*(?:Queue|Backlog)))\.(?:push|set|add)\s*\(/g;
function hasUndurableResidentQueue(code) {
  for (const match of code.matchAll(RESIDENT_QUEUE)) {
    if (!DURABLE_QUEUE_OBJECT.test(match[1] ?? "")) return true;
  }
  return false;
}
const RECEIPT_WRITE =
  /\b(?:[A-Za-z_$][\w$]*\.)*(?:enqueue|enqueueReceipt|createReceipt|persistReceipt|insertReceipt|saveReceipt|writeReceipt|storeReceipt)\s*\(/i;
const DISHONEST_METRIC =
  /\b(?:oldestAgeMs|arrivalRatePerSec|drainRatePerSec|confidence)\b[^\n]{0,80}\?\?\s*0\b/;

/**
 * Return the closing parenthesis for a call whose opening parenthesis is at
 * `openIndex`. The source has already gone through stripCommentsAndStrings, so
 * parentheses in comments, strings, and regex literals cannot perturb this
 * small structural walk.
 */
function matchingCallEnd(code, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < code.length; index += 1) {
    if (code[index] === "(") {
      depth += 1;
    } else if (code[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Detect a retry construct only when it invokes a callback that performs a
 * receipt-producing operation. Identifier proximity is not enough: unrelated
 * fields such as `admissionRetryBackoffsMs` and `receiptId` can sit next to
 * each other in a type declaration without any retry or write taking place.
 */
function hasRetryAroundReceipt(code) {
  for (const match of code.matchAll(
    /\b(?:retry|again|[A-Za-z_$][\w$]*(?:retry|again)[A-Za-z_$\d]*)\s*\(/gi,
  )) {
    const openIndex = match.index + match[0].lastIndexOf("(");
    const closeIndex = matchingCallEnd(code, openIndex);
    if (closeIndex < 0) continue;
    const args = code.slice(openIndex + 1, closeIndex);
    if (!/(?:=>|\bfunction\s*\()/i.test(args)) continue;
    if (RECEIPT_WRITE.test(args)) return true;
  }
  return false;
}

export function inspectGovernorSource(source) {
  const code = stripCommentsAndStrings(source, "fixture.ts");
  const findings = [];
  if (
    (hasResourceStart(code) || hasCalledResourceStartAlias(code)) &&
    !GOVERNED.test(code)
  )
    findings.push("resource-start-outside-admission");
  if (
    (STATIC_CAP.test(code) || HIDDEN_SEMAPHORE.test(code)) &&
    !/transient feedback state|physical upstream constraint/i.test(code)
  ) {
    findings.push("hidden-or-static-capacity");
  }
  if (hasUndurableResidentQueue(code)) findings.push("unbounded-resident-queue");
  if (hasRetryAroundReceipt(code)) findings.push("retry-around-receipt");
  if (
    /\bgovernor\.admit\s*\(/.test(code) &&
    (!/\bAdmissionContext\b/.test(code) || !RELEASE.test(code))
  ) {
    findings.push("missing-admission-context-or-release");
  }
  if (DISHONEST_METRIC.test(code))
    findings.push("undefined-partial-or-stale-metric-coerced-to-zero");
  return findings;
}

/**
 * P-001 acceptance is that each admission SITE names its own resource dimensions,
 * fan-out, durable source, telemetry, context/release path and the cap to delete.
 *
 * A PRESENCE check cannot enforce that, and the audit (auditSeq 9) proved it: the
 * seven lanes shared five identical boilerplate constants, satisfied `required`
 * completely, and carried no per-site information whatsoever. A field that every
 * row can satisfy with the SAME string is not describing anything — it is a check
 * that cannot fail. So presence is necessary and no longer sufficient:
 *
 *   1. NO SHARED BOILERPLATE. If two rows give byte-identical prose for a
 *      descriptive field, neither row is describing itself. Duplicate ⇒ finding.
 *   2. SITES ARE NAMED, NOT IMPLIED. Every governed lane enumerates the concrete
 *      admission sites it owns; a lane that names none is a path prefix, not an
 *      inventory.
 *   3. NAMED SITES MUST EXIST. `pathExists` (injected by scanTree, omitted by pure
 *      callers) resolves each site against the tree, so the inventory cannot drift
 *      into citing files that were renamed or deleted — the decorative-inventory
 *      failure one level up from the decorative-allowlist one.
 */
const DESCRIPTIVE_FIELDS = [
  "fanOut",
  "durableSource",
  "telemetry",
  "contextAndRelease",
  "currentCaps",
  "writerEvidence",
];

export function validateInventory(
  rows = RESOURCE_GOVERNOR_INVENTORY,
  { pathExists = null } = {},
) {
  const findings = [];
  const ids = new Set();
  const required = [
    "id",
    "disposition",
    "enforcement",
    "paths",
    "resourceDimensions",
    "fanOut",
    "durableSource",
    "telemetry",
    "contextAndRelease",
    "currentCaps",
    "writerEvidence",
    "sites",
  ];
  // (1) shared boilerplate across rows — the exact defect auditSeq 9 found.
  for (const field of DESCRIPTIVE_FIELDS) {
    const seen = new Map();
    for (const row of rows) {
      const value = row[field];
      if (typeof value !== "string" || value === "") continue;
      const norm = value.trim().replace(/\s+/g, " ");
      if (!seen.has(norm)) seen.set(norm, []);
      seen.get(norm).push(row.id);
    }
    for (const [, sharers] of seen) {
      if (sharers.length > 1)
        findings.push(
          `inventory-boilerplate:${field}:${sharers.sort().join("+")}`,
        );
    }
  }
  for (const row of rows) {
    if (ids.has(row.id)) findings.push(`duplicate-inventory:${row.id}`);
    ids.add(row.id);
    for (const field of required) {
      const value = row[field];
      if (
        value == null ||
        value === "" ||
        (Array.isArray(value) && value.length === 0)
      )
        findings.push(`inventory-missing:${row.id}:${field}`);
    }
    // (2)+(3) named sites, and they must resolve against the tree.
    for (const site of row.sites ?? []) {
      if (!site?.path || !site?.start)
        findings.push(`inventory-site-incomplete:${row.id}`);
      else if (pathExists && !pathExists(site.path))
        findings.push(`inventory-site-missing:${row.id}:${site.path}`);
    }
    if (
      !["govern", "bypass", "semantic", "upstream", "false-positive"].includes(
        row.disposition,
      )
    )
      findings.push(`inventory-disposition:${row.id}`);
    if (
      ["bypass", "semantic", "upstream"].includes(row.disposition) &&
      !/evidence|required|constraint|registry/i.test(row.writerEvidence ?? "")
    ) {
      findings.push(`inventory-writer-evidence:${row.id}`);
    }
  }
  return findings;
}

export function scanInventory(
  files,
  { migrations = [], validateRegistry = false } = {},
) {
  const selected = RESOURCE_GOVERNOR_INVENTORY.filter(
    (row) =>
      row.enforcement === "active" ||
      migrations.some(
        (migration) => row.enforcement === `pending-${migration}`,
      ),
  );
  const findings = [];
  const scannedPaths = new Set();
  const observedRegistryKeys = new Set();
  for (const [path, source] of files) {
    // The guard's own regex literals/documentation intentionally contain
    // detector vocabulary (for example the retry receipt pattern). Scanning
    // this implementation as product code would make its self-description a
    // finding and would force a self-exemption row. Exclude only this exact
    // canonical scanner path; all caller paths remain strictly dispositioned.
    if (path === RESOURCE_GOVERNOR_SCANNER_PATH) continue;
    if (
      !selected.some((row) =>
        row.paths.some((prefix) => path.startsWith(prefix)),
      )
    )
      continue;
    scannedPaths.add(path);
    for (const code of inspectGovernorSource(source)) {
      const key = registryKey(path, code);
      observedRegistryKeys.add(key);
      const disposition = BYPASS_REGISTRY.get(key);
      if (!disposition || (disposition.matchesSource && !disposition.matchesSource(source)))
        findings.push(`${path}:${code}`);
    }
  }
  if (validateRegistry) {
    for (const key of BYPASS_REGISTRY.keys()) {
      const separator = key.lastIndexOf("::");
      const path = key.slice(0, separator);
      const selectedPath = selected.some((row) =>
        row.paths.some((prefix) => path.startsWith(prefix)),
      );
      if (!selectedPath) continue;
      if (!scannedPaths.has(path)) {
        if (validateRegistry === "strict")
          findings.push(`stale-bypass-registry:${key}:path-not-scanned`);
        continue;
      }
      if (!observedRegistryKeys.has(key))
        findings.push(`stale-bypass-registry:${key}:finding-absent`);
    }
  }
  return findings;
}

export function scanActiveInventory(files, options = {}) {
  return scanInventory(files, options);
}

function scanTree() {
  const { files, unscanned } = listTrackedFiles(ROOT);
  const sourceFiles = [];
  for (const path of files) {
    if (
      !/\.(?:ts|tsx|mts|mjs)$/.test(path) ||
      /\.(?:test|spec)\./.test(path) ||
      path.includes("/_retired/")
    )
      continue;
    try {
      sourceFiles.push([path, readFileSync(`${ROOT}${path}`, "utf8")]);
    } catch {
      /* concurrent deletion */
    }
  }
  const tracked = new Set(files);
  const enforced = RESOURCE_GOVERNOR_INVENTORY.filter(
    (row) => row.enforcement === "active",
  );
  const pending = RESOURCE_GOVERNOR_INVENTORY.filter(
    (row) => row.enforcement !== "active",
  );
  const scannedCount = sourceFiles.filter(([path]) =>
    enforced.some((row) => row.paths.some((prefix) => path.startsWith(prefix))),
  ).length;
  return {
    findings: [
      ...validateInventory(RESOURCE_GOVERNOR_INVENTORY, {
        pathExists: (path) => tracked.has(path),
      }),
      ...scanActiveInventory(sourceFiles, { validateRegistry: "strict" }),
    ],
    unscanned,
    coverage: {
      enforced,
      pending,
      scannedCount,
      sourceCount: sourceFiles.length,
    },
  };
}

function main() {
  const { findings, unscanned, coverage } = scanTree();
  // A lane sitting at `pending-P-NNN` is NOT scanned, so "8 lanes inventoried"
  // read as "8 lanes checked" while only two were — the exact misreading that let
  // the agent-process lane stay blind through a whole audit (D-026). Report what
  // was ENFORCED and name what was not, so the gate's own output can never again
  // present coverage it does not have.
  const coverageLine =
    `${coverage.enforced.length}/${RESOURCE_GOVERNOR_INVENTORY.length} lanes ENFORCED ` +
    `(${coverage.scannedCount}/${coverage.sourceCount} source files scanned)` +
    (coverage.pending.length
      ? `; ${coverage.pending.length} NOT ENFORCED and therefore UNSCANNED: ` +
        coverage.pending.map((r) => `${r.id}(${r.enforcement})`).join(", ")
      : "");
  // WI-6776: the submodule half of coverage was hand-rolled as a bare COUNT
  // ("3 unscanned submodule(s)"), which says a gap exists but not why it exists or
  // what it costs. In a release-shaped checkout (papercusp-checkpoint /
  // papercusp-release) submodule source is git archive-extracted, so there is no .git
  // to descend into and this scan reaches ZERO submodule files — about 22% of the tree
  // — while still printing a confident ✓. describeUnscanned() diagnoses the cause by
  // TREE SHAPE (present-but-not-a-repo vs absent vs uninitialized) instead of guessing
  // "not initialized" for all three, so the success line can no longer overstate itself.
  const unscannedNote = describeUnscanned(unscanned);
  if (findings.length === 0) {
    console.log(
      `[resource-governor-enforcement] OK — ${coverageLine}; active writer evidence clean.${unscannedNote}`,
    );
    return;
  }
  console.error(
    `[resource-governor-enforcement] coverage: ${coverageLine}${unscannedNote}`,
  );
  console.error(
    "[resource-governor-enforcement] FAIL — capless admission/queue/state policy violations:",
  );
  for (const finding of findings) console.error(`  ${finding}`);
  console.error(
    "\nDo not add a new cap. Route the start through Governor.admit or a registered valid lease, preserve its durable receipt and AdmissionContext, release exact actual cost, and publish honest unknown/stale state. Semantic/policy/upstream constraints require explicit writer evidence.",
  );
  process.exitCode = 1;
}

if (isCliEntry(import.meta.url)) main();
