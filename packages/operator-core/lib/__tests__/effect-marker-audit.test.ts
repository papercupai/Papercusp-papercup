/**
 * effect-marker-audit.test.ts — B-CX-EFFECT (code-execution-tool-orchestration).
 *
 * The code-execution dry-run/confirm gate (B-CX-2A) gates ONLY tool calls whose def is
 * `effect: 'write'` — in dryRun a write-effect call is recorded, not executed; outside
 * dryRun it can prompt for confirm. A mutator mis-inferred as `'read'` therefore EXECUTES
 * during a "preview", which is exactly the unsafety this guards.
 *
 * `effect` is inferred from the capability (a `:write/:admin/:delete/:manage/:execute`
 * suffix OR the central WRITE_CAPABILITIES set in libs/generic/tooldef/src/define-tool.ts),
 * overridable per tool with an explicit `effect`. This test enumerates known mutators
 * across every tool family over the REAL registered catalog and asserts NONE infer 'read'.
 *
 * Adding a mutating tool whose capability doesn't already imply write? Either give it an
 * explicit `effect: 'write'`, or (if the capability is a dedicated mutator with no read
 * sibling) add the capability to WRITE_CAPABILITIES — then list the tool here.
 */
import { describe, it, expect } from 'vitest';
import '../agent-tools/index'; // side-effect: register the full operator-core agent-tool catalog
import { lookupByMcpName } from '@papercusp/tooldef';

// (1) Mutators whose capability does NOT end in a write-suffix — the dangerous class this
// audit fixed. Each resolves to 'write' via the central WRITE_CAPABILITIES set OR an
// explicit per-tool override (the two `*:read`-capability file-writers).
const NON_SUFFIX_MUTATORS = [
  'operator:converse', // operator:converse — brain turn (spawns, spend, mem0)
  'turn:interrupt', // turn:interrupt — ends a peer's turn
  'ui:dispatch', // ui:dispatch — performs a UI intent in a browser tab
  'tui:dispatch', // tui:dispatch — performs a control intent against a pui workbench
  'activity:report', // activity:report — inserts an agent-activity row
  'capability:fetch', // capability:net — outbound HTTP (can POST/PUT/DELETE)
  'capability:bash',
  'capability:write',
  'capability:edit',
  'capability:git',
  'capability:computer',
  'capability:terminal', // opens arbitrary command windows
  'capability:launch-agent', // capability:terminal — launches/resumes/forks agent processes
  'fleet:launch-on-plan', // capability:terminal — launches a visible/headless member fleet
  'processes:kill',
  'knowledge_packs:export', // capability memory:read + explicit effect:'write' (writes pack files)
  'plans:export', // capability plans:read + explicit effect:'write' (toDir writes .md files)
  // WI-10004595: fleet-registry control verbs + terminal-window control + test-run recording.
  // Each has a dedicated non-suffixed capability that used to default-infer 'read', so a code:run
  // dryRun "preview" EXECUTED them. Resolved via the central WRITE_CAPABILITIES set.
  'fleet:create', 'fleet:join', 'fleet:leave', 'fleet:take-leadership',
  'fleet:resume', 'fleet:pause', 'fleet:wind-down', 'fleet:supersede',
  'fleet:headcount-target', 'fleet:request_remote_spawn', 'fleet:recolor',
  'fleet:reconfigure-member', 'fleet:respawn-member',
  'coord:mark-terminal', 'coord:focus-window', // capability coord:mark-terminal
  'testing:record-run', 'testing:record-native-check', 'testing:run', // capability testing:run
  // WI-10004577: mutators that SHARE a `*:read` capability with genuine readers, so they carry an
  // explicit per-tool `effect:'write'` (the documented convention at WRITE_CAPABILITIES).
  'voice:say', // speaks aloud (writes the sentinel_says FIFO)
  'voice:delegate_deep', // mints a deep-delegation work_item + wakes/spawns an agent
  'memory:sweep', // mode:'apply' soft-forgets duplicate rows
  'behaviour:run', // mode:'launch' spawns a real agent (shares harness:read with readers)
  'inbox:bulk-run-manifest', // refreshes the run's resolver heartbeat (coord:read capability)
];

// (2) Representative write-suffix mutators across families — the brief's named candidates
// (pot:wake, deploy:*, plans:* writes, …) plus a broad sweep, pinned so a
// future capability rename can't silently flip them back to 'read'.
// (`cup:spawn` was in this list until P-059 retired it; every name here is
// asserted REGISTERED at :69, so a retired tool must leave the list with its
// registration or this audit hard-fails on a tool that no longer exists.)
const SUFFIX_MUTATORS = [
  'fleet:cancel', 'fleet:place_batch', 'fleet:drain',
  'pot:wake', 'pot:declare-wake', 'pot:create', 'pot:dissolve', 'pot:set-steering',
  'deploy:harness', 'deploy:pot',
  'accounts:register', 'instance:boot', 'experiment:run', 'harness:create',
  'plans:new', 'plans:set-now', 'plans:set-status', 'plans:promote', 'plans:launch', 'plans:set-content',
  'work_items:create', 'work_items:set_state', 'work_items:claim', 'work_items:complete',
  'plan_items:claim', 'plan_items:convert',
  'coord:send', 'coord:escalate', 'coord:handoff', 'coord:declare-intent', 'events:emit', 'watch:create',
  // 'messages:send' / 'messages:dismiss' removed — work-item mail surface retired
  // 2026-07-26 (WI-6097, retire-work-item-mail-surface-2026-07-26).
  'memory:remember', 'memory:forget',
  'topics:create', 'agent_chats:create',
  'backup:restore', 'storage:prune', 'autoloop:control', 'discovery:set_pot',
  'flags:set', 'trust:add',
  'autonomy:policy_set', 'autonomy:record_disposition',
  'locks:acquire', 'db:migrate',
];

const ALL_MUTATORS = [...new Set([...NON_SUFFIX_MUTATORS, ...SUFFIX_MUTATORS])];

describe('effect-marker audit (B-CX-EFFECT): known mutators are effect:write', () => {
  it.each(ALL_MUTATORS)("'%s' is registered and marked effect:'write'", (name) => {
    const tool = lookupByMcpName(name);
    expect(tool, `mutator '${name}' is not registered — fix its name or its catalog import`).toBeDefined();
    expect(
      tool?.effect,
      `'${name}' must be effect:'write' so the code-execution dry-run/confirm gate covers it`,
    ).toBe('write');
  });

  // Control: genuine readers must STAY 'read'. Guards against an over-broad flip (which
  // would gate everything) AND proves the effect field is actually populated, not defaulted.
  it.each([
    'coord:inbox',
    'work_items:list',
    'plans:get',
    'memory:search',
    'work_items:get',
    'capability:pty_read_screen',
  ])(
    "reader '%s' stays effect:'read'",
    (name) => {
      const tool = lookupByMcpName(name);
      expect(tool, `reader '${name}' not registered`).toBeDefined();
      expect(tool?.effect).toBe('read');
    },
  );
});

/**
 * WI-10004577 — the late-completion READ policy's registry guard.
 *
 * `papercuspLateCompletionRead` (agent-mcp/capability-tiers-papercusp.ts) lets a completed-after-deadline
 * result SURFACE for any tool that is `effect:'read'` AND whose every capability is a `*:read` one. That
 * is correct for pure reads and WRONG for a mutator that shares a `*:read` capability but never declared
 * `effect:'write'` (it would report success for a possibly-cancelled write). Neither signal can tell a
 * mutator by itself, so this guard enumerates the REAL admitted population and forces a conscious
 * decision for any tool whose NAME carries a mutating verb: either mark it `effect:'write'` (it leaves
 * the admitted set) or list it in REVIEWED_PURE with the reason it only reads.
 */
const MUTATING_VERB =
  /(^|[:_\-])(say|delegate|sweep|attest|decide|create|set|update|delete|remove|send|post|run|start|stop|kill|write|record|claim|release|complete|spawn|apply|merge|resolve|dispatch|emit|ack|mark|enqueue|reset|clear|purge|rotate|restore|import|export|install|upload|sync|refresh|reindex|rebuild|trigger|fire|publish|approve|reject|cancel|pause|resume|retry|grade|file|add|assign|link|unlink|bulk|dedup|heartbeat|touch|register|unregister|subscribe|unsubscribe|ingest|capture|remember|forget|retract|assert|checkpoint|comment|promote|ratify|supersede|drain|wake)([:_\-]|$)/;

/** name → why it is a pure read despite the mutating-looking verb. A new entry is a REVIEW, not a rubber stamp. */
const REVIEWED_PURE: Record<string, string> = {
  'intel:spawn_tree': 'renders the spawn lineage tree; reads only',
  'operator:dedup_check': 'reports whether a duplicate exists; no write',
  'operator:trigger_state': 'reads the current trigger state',
  'dev:code_run_adoption': 'adoption statistics over tool_invocations',
  'dev:orient_dedup_rate': 'a measured rate over existing rows',
  'release:trace': 'reads release trace truth (workspace-global read)',
  'dev:resolve_owner': 'resolves an owner id to a label',
  'testing:run-status': 'polls a run snapshot; starting a run is testing:run',
  'flags:attest': 'asks processes what a flag resolves to; read-only probes',
  'autonomy:decide': 'returns auto|gated for an action; its own guidance says it never mutates',
  'knowledge_packs:sweep': 'conflict judge over a pool, reports pairs; read-only by its description',
  'accounts:link-status': 'polls an in-memory held-link record (getCliLinkStatus); finalization is server-driven, not triggered by the poll',
  'provisioner:plan_install': 'computes an install PLAN only; provisioner:install is the mutator',
  'cert:run': 'probes a served backend and returns a CertReport; writes no papercusp state (catalog entry is hand-added)',
  'instance:capture': 'reads a live harness into an InstanceSpec descriptor; persists nothing (instance:boot/clone mutate)',
  'scheduler:get_claim_spec': 'reads the current claim spec row (the read counterpart of scheduler:set_claim_spec); claims nothing',
  'plans:run-transcript': 'renders a plan run transcript from stored rows; reads only',
  'events:lost-wake-check': 'reports wakes that never fired; diagnostic read, repairs nothing',
  'trigger-packs:review': 'lists installed packs and builds a review report; reads only',
};

describe('late-completion read policy (WI-10004577): the admitted population is registry-guarded', () => {
  // Resolve the policy through the same module the host registers it from.
  const admitted = async () => {
    const { papercuspLateCompletionRead } = await import('@papercusp/agent-mcp');
    const { listAllProjectedTools } = await import('@papercusp/tooldef');
    return [...listAllProjectedTools()]
      .map((t) => ({
        name: (t.expose?.mcp?.name ?? t.pluginName ?? '?') as string,
        capabilities: t.capabilities ?? [],
        effect: t.effect,
      }))
      .filter((t) => papercuspLateCompletionRead(t));
  };

  it('admits genuine reads and rejects the mutators that share a *:read capability', async () => {
    const names = new Set((await admitted()).map((t) => t.name));
    for (const pure of ['coord:inbox', 'memory:search', 'intel:spawn_tree', 'flags:attest', 'trigger-packs:review']) {
      expect(names.has(pure), `${pure} is a pure read and should be admitted`).toBe(true);
    }
    for (const mutator of ['voice:say', 'voice:delegate_deep', 'memory:sweep', 'plans:export', 'knowledge_packs:export', 'trigger-packs:export', 'fleet:create']) {
      expect(names.has(mutator), `${mutator} mutates and must NOT be admitted`).toBe(false);
    }
  });

  it('no admitted tool carries a mutating verb unless it is REVIEWED_PURE (mark it effect:write or review it)', async () => {
    const unreviewed = (await admitted())
      .map((t) => t.name)
      .filter((n) => MUTATING_VERB.test(n) && !(n in REVIEWED_PURE));
    expect(
      unreviewed,
      `admitted-as-read tools with a mutating-verb name: ${unreviewed.join(', ')}. Declare effect:'write' on the tool, ` +
        `or add it to REVIEWED_PURE with the reason it only reads.`,
    ).toEqual([]);
  });

  it('REVIEWED_PURE has no stale entries (every name is registered and still admitted)', async () => {
    const names = new Set((await admitted()).map((t) => t.name));
    const stale = Object.keys(REVIEWED_PURE).filter((n) => !names.has(n));
    expect(stale, `REVIEWED_PURE entries no longer admitted/registered: ${stale.join(', ')}`).toEqual([]);
  });
});
