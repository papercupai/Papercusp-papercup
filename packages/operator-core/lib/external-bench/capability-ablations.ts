/**
 * capability-ablations.ts — the registered single-capability ablations for current benchmark runs
 * (benchmark-coverage-frontierswe-v2-2026-10-10#D-018 / P-011, contributed to
 * current-benchmark-modernization-2026-10-09 P-004's reference/ablation surface).
 *
 * A protocol arm declares an ablation in its frozen control block
 * (`reproducibility/schema.ts`: `control.ablation = { of, treatment }`); the schema already proves the
 * pair differs in exactly that one capability. THIS module answers the other half: what "off" means for
 * that capability, what must be preserved, what may never be touched, which evidence admits a lift, and
 * whether a verified assignment-scoped native control exists to realize it. A launch whose treatment
 * has no such control is refused ({@link requireRunnableAblation}) — an unavailable control means
 * NON-RUNNABLE, never an instruction to approximate it.
 *
 * Evidence is recorded per row as `CapabilityExerciseEvidence` (`@papercusp/bench-metrics`
 * capability-exercise.ts) and judged by `admitCapabilityLift`: the off arm must deliver and use zero, the
 * on arm needs a delivered-and-used witness, and an unmeasured count withholds the claim.
 *
 * Definitions only: registering one authorizes no runs (D-001 governs spend).
 */
import type { ArmTopology, BenchmarkCapability, CurrentBenchmarkProtocol } from './reproducibility/schema';

/** The six capabilities D-018 defines; planning and review have no registered ablation yet. */
export type AblatedCapability = Exclude<BenchmarkCapability, 'planning' | 'review'>;

export type NativeAblationControl =
  | { status: 'bound'; ref: string; topologies?: readonly ArmTopology[] }
  | { status: 'unavailable'; reason: string };

export interface CapabilityAblationDefinition {
  capability: AblatedCapability;
  variant: `${AblatedCapability}-off`;
  /** What the off arm withholds. */
  off: string;
  /** What both arms keep identical. */
  preserve: readonly string[];
  /** What the variant must never change, even to realize "off". */
  never: readonly string[];
  /** The receipts that populate available / delivered / used for this capability. */
  evidence: { availability: string; delivery: string; use: string };
  /** Conditions that make a pair inadmissible rather than merely unmeasured. */
  inadmissibleWhen: readonly string[];
  nativeControl: NativeAblationControl;
}

const NO_SCOPED_CONTROL = 'No verified assignment-scoped native control yet (D-018); the variant is non-runnable until one is bound and tested.';

/** Shared across every pair (D-018 common control). */
export const ABLATION_COMMON_FREEZE: readonly string[] = [
  'task, image and grader', 'seeds',
  'the evaluated model and effort max pinned by benchmark-coverage-frontierswe-v2-2026-10-10#D-014 (resolved, never named here)',
  'account route',
  'initial corpus and memory snapshot', 'submission policy', 'concurrency',
  'aggregate dollar, call, token and wall caps counting every worker, leader, consult participant and restart',
];

export const CAPABILITY_ABLATIONS: Readonly<Record<AblatedCapability, CapabilityAblationDefinition>> = {
  'memory-recall': {
    capability: 'memory-recall', variant: 'memory-recall-off',
    off: 'Withhold automatic durable recall injection AND explicit memory search/recall access for the assignment.',
    preserve: ['task and source context', 'ordinary session history', 'the same isolated frozen memory snapshot at start'],
    never: ['block only the tool while automatic injection remains'],
    evidence: {
      availability: 'intended retrieval surfaces present for the assignment',
      delivery: 'memory bytes/refs delivered into the agent context',
      use: 'successful agent-originated retrieval calls',
    },
    inadmissibleWhen: ['the off arm received any recall injection or retrieval result'],
    nativeControl: { status: 'bound', topologies: ['solo'],
      ref: 'current-su.ts:currentBenchSoloCapabilityControl + memory:search host-pinned snapshot; explicit local lexical recall only, ambient injection withheld' },
  },
  'carry-respawn': {
    capability: 'carry-respawn', variant: 'carry-respawn-off',
    off: 'At identical preregistered compaction triggers, resume from the initial task plus the identical allowed git submission checkpoint, omitting carry notes and prior conversational recall.',
    preserve: ['the maintained native lifecycle', 'transcripts and accounting retained by the observer', 'identical compaction triggers'],
    never: ['change the trigger schedule between arms'],
    evidence: {
      availability: 'preregistered compaction trigger configured',
      delivery: 'respawn receipts whose input hashes show prior-state carry delivered',
      use: 'respawns that resumed from the delivered carry',
    },
    inadmissibleWhen: ['no trigger fired (unexercised, not a carry-effect comparison)'],
    nativeControl: { status: 'unavailable', reason: NO_SCOPED_CONTROL },
  },
  'fleet-leader': {
    capability: 'fleet-leader', variant: 'fleet-leader-off',
    off: 'Replace leader placement, shared agent messages and coordination with the maintained independent-solver control; an observer performs predetermined dispatch without model judgment.',
    preserve: ['solver population', 'sandbox assignment namespace', 'equal aggregate caps (leader work is charged in the on arm)'],
    never: ['change the solver population', 'change grader selection'],
    evidence: {
      availability: 'launch roster and fleet membership',
      delivery: 'leader decisions and accepted cross-agent deliveries',
      use: 'agent-originated coordination calls (TopologyRowMeta coordination-call count)',
    },
    inadmissibleWhen: ['the off arm shows any leader decision or coordination delivery', 'solver population differs'],
    nativeControl: {
      status: 'unavailable',
      // The bespoke runagents' offeredTools filter is not a control on the maintained native launcher.
      // current-su.ts refuses controlled su arms until their delivered capabilities are host-verified.
      reason: 'No verified assignment-scoped fleet-leader control on the maintained native launcher; the bespoke runagent coordination filter does not bind this runtime. The variant is non-runnable until a native control is bound and tested.',
    },
  },
  'locks': {
    capability: 'locks', variant: 'locks-off',
    off: 'Isolate writers to disposable benchmark-owned copies and suppress experimental agent-facing lock arbitration only where the runtime supports scoped enforcement.',
    preserve: ['solver count', 'concurrency'],
    never: ['disable production or shared-tree locks', 'disable permissions or kernel authority', 'remove observer artifact protection'],
    evidence: {
      availability: 'scoped lock backend active for the assignment',
      delivery: 'scoped lock decisions returned to agents',
      use: 'lock-sensitive writes in the contention/write timeline',
    },
    inadmissibleWhen: ['the off arm shows experimental arbitration', 'the on arm never made a lock-sensitive write'],
    nativeControl: { status: 'unavailable', reason: NO_SCOPED_CONTROL },
  },
  'consult-router': {
    capability: 'consult-router', variant: 'consult-router-off',
    off: 'Deny consult request and delivery through the maintained assignment-scoped control.',
    preserve: ['solver task and initial context'],
    never: ['leave a responder unaccounted', 'use responder pins that violate D-014'],
    evidence: {
      availability: 'consult routing enabled for the assignment',
      delivery: 'delivered answer receipts',
      use: 'consult requests with responder identity and usage charged to the aggregate caps',
    },
    inadmissibleWhen: ['a responder model call is unaccounted', 'a request was sent but never delivered (not use)'],
    nativeControl: { status: 'unavailable', reason: NO_SCOPED_CONTROL },
  },
  'work-item-ledger': {
    capability: 'work-item-ledger', variant: 'work-item-ledger-off',
    off: 'Remove experimental agent-visible task-ledger prompt, tool and inbox surfaces; an external observer retains assignment/progress/terminal/cost records.',
    preserve: ['task scope', 'bounded launch and cancellation'],
    never: ['remove platform ownership or authorization', 'permit anonymous writes'],
    evidence: {
      availability: 'ledger surfaces present in the agent launch',
      delivery: 'ledger context delivered to the agent',
      use: 'agent-originated claim/checkpoint/state operations (observer bookkeeping excluded)',
    },
    inadmissibleWhen: ['agent use and observer bookkeeping cannot be separated'],
    nativeControl: { status: 'bound', topologies: ['solo'],
      ref: 'current-su.ts:currentBenchSoloCapabilityControl + liveCurrentSuBenchPorts exact-item launch confinement; solo ledger only' },
  },
};

const isAblated = (capability: string): capability is AblatedCapability => Object.hasOwn(CAPABILITY_ABLATIONS, capability);

/**
 * The registered definition behind an arm's ablation, or `null` when the arm is not an ablation.
 * Refuses an ablation with no registered definition or no verified native control.
 */
export function requireRunnableAblation(protocol: CurrentBenchmarkProtocol, armId: string): CapabilityAblationDefinition | null {
  const arm = protocol.arms.find(candidate => candidate.id === armId);
  if (!arm) throw new Error(`Arm ${armId} is not in the frozen protocol.`);
  const ablation = arm.control?.ablation;
  if (!ablation) return null;
  if (!isAblated(ablation.treatment)) {
    throw new Error(`Arm ${armId} ablates ${ablation.treatment}, which has no registered ablation definition.`);
  }
  const definition = CAPABILITY_ABLATIONS[ablation.treatment];
  if (definition.nativeControl.status !== 'bound') {
    throw new Error(`Arm ${armId} (${definition.variant}) is not runnable: ${definition.nativeControl.reason}`);
  }
  if (definition.nativeControl.topologies && !definition.nativeControl.topologies.includes(arm.control!.topology))
    throw new Error(`Arm ${armId} (${definition.variant}) is not runnable: native control supports only ${definition.nativeControl.topologies.join(', ')}.`);
  return definition;
}

/** Per-capability runnability, for reports and P-011 completion (all six must be bound and validated). */
export function capabilityAblationReadiness(): Array<{ capability: AblatedCapability; runnable: boolean; detail: string }> {
  return Object.values(CAPABILITY_ABLATIONS).map(definition => definition.nativeControl.status === 'bound'
    ? { capability: definition.capability, runnable: true, detail: definition.nativeControl.ref }
    : { capability: definition.capability, runnable: false, detail: definition.nativeControl.reason });
}
