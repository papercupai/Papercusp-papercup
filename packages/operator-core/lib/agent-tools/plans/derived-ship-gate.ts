/**
 * derived-status-not-hand-written-2026-10-12 P-002 — the ship-gate step of `derivedStatus`.
 *
 * When every item of an unshipped plan is terminal, the next thing a reader needs is not
 * another item: it is WHAT REFUSES THE SHIP. Hand-written `## Now` prose ("all items done,
 * ready to ship") is exactly where that answer used to rot. This step derives it at read
 * time from the SAME evaluator `plans:set-plan-status` enforces — `evaluatePlanAcceptanceGate`
 * via `resolvePlanAcceptanceGateVerdict`, the resolver `plans:get { shipReadiness:true }` and
 * the UI already read — so it can never name a different code than the write would.
 *
 * Code parity with the dryRun preflight: when the acceptance gate refuses,
 * `shipGatePreflightResult` (set-plan-status.ts) reports `error = gate.code`, so `code`
 * below IS the dryRun's first refusal. When the gate is SATISFIED the dryRun still checks
 * two guards a read does not run (plan admission and frontmatter CAS); `guardsNotChecked`
 * says so and `confirmWith` names the exact read-only preflight call, so a satisfied gate is
 * never rendered as "will ship".
 *
 * Read-only: the only dependency is the injected resolver, which never writes (its
 * contract: "The gate is read-only and never throws"). Fail-soft: a resolver that cannot
 * run yields `unavailableReason`, never an absent field (absent would read as "nothing
 * blocks").
 */
import { isTerminalPlanStatus } from '@papercusp/plan-parser';
import type { PlanAcceptanceGateArgs, PlanAcceptanceGateVerdictRow } from '../../sync-resolver/plan-acceptance-gate-verdict';

export const SHIP_GATE_GUARDS_NOT_CHECKED = ['plan-admission', 'frontmatter-cas'] as const;

export interface DerivedShipGate {
  /** The evaluator this verdict came from — the one `plans:set-plan-status` enforces. */
  source: 'plan-acceptance-gate';
  satisfied: boolean;
  /** The refusal code; equals the dryRun preflight's `error` whenever the gate refuses. */
  code: string | null;
  /** Set ⇒ the gate did not apply (nothing was checked) — never a pass. */
  skipped: string | null;
  message: string | null;
  /** The gate's own repair action for `code`, projected; null when nothing refuses. */
  nextRepair: {
    kind: string;
    /** The verb that repairs it (`repairVerb`, else the suggested next call). */
    verb: string | null;
    nextVerb: { name: string; args: Record<string, unknown> } | null;
    instruction: string;
  } | null;
  /** Checks the dryRun runs that this read does not; only decisive when `satisfied`. */
  guardsNotChecked: readonly string[];
  /** The read-only preflight that confirms the full verdict, guards included. */
  confirmWith: { name: 'plans:set-plan-status'; args: Record<string, unknown> };
  /** True when the caller's own `shipReadiness` verdict was reused (no second evaluation). */
  reusedShipReadiness: boolean;
  unavailableReason: string | null;
  /** One line, ready to render beside `derivedStatus.text`. */
  text: string;
}

interface SummaryCounts {
  total?: unknown;
  nonTerminal?: unknown;
}

/** The step applies to a non-empty, unshipped plan whose items are ALL terminal. */
export function shipGateApplies(derivedStatus: unknown, planStatus: unknown): boolean {
  if (!derivedStatus || typeof derivedStatus !== 'object') return false;
  const counts = (derivedStatus as { counts?: SummaryCounts }).counts;
  if (!counts || typeof counts.total !== 'number' || typeof counts.nonTerminal !== 'number') return false;
  if (counts.total <= 0 || counts.nonTerminal !== 0) return false;
  return !isTerminalPlanStatus(typeof planStatus === 'string' ? planStatus : null);
}

function confirmCall(slug: string, harness: string | null): DerivedShipGate['confirmWith'] {
  return {
    name: 'plans:set-plan-status',
    args: { slug, ...(harness ? { harness } : {}), status: 'shipped', dryRun: true },
  };
}

export function projectDerivedShipGate(
  verdict: Partial<PlanAcceptanceGateVerdictRow> | null | undefined,
  ctx: { slug: string; harness: string | null; reusedShipReadiness: boolean },
): DerivedShipGate {
  const satisfied = verdict?.satisfied === true;
  const repair = verdict?.repairAction;
  const gate: Omit<DerivedShipGate, 'text'> = {
    source: 'plan-acceptance-gate',
    satisfied,
    code: satisfied ? null : verdict?.code ?? null,
    skipped: verdict?.skipped ?? null,
    message: verdict?.message ?? null,
    nextRepair: !satisfied && repair
      ? {
          kind: repair.kind,
          verb: repair.repairVerb ?? repair.nextVerb?.name ?? null,
          nextVerb: repair.nextVerb ?? null,
          instruction: repair.instruction,
        }
      : null,
    guardsNotChecked: SHIP_GATE_GUARDS_NOT_CHECKED,
    confirmWith: confirmCall(ctx.slug, ctx.harness),
    reusedShipReadiness: ctx.reusedShipReadiness,
    unavailableReason: verdict ? verdict.unavailableReason ?? null : 'resolver-unavailable',
  };
  return { ...gate, text: shipGateText(gate) };
}

function shipGateText(gate: Omit<DerivedShipGate, 'text'>): string {
  if (gate.unavailableReason) return 'ship gate: not evaluated';
  if (gate.skipped) return `ship gate: skipped (${gate.skipped})`;
  if (gate.satisfied) return 'ship gate: acceptance satisfied (confirm with the dryRun preflight)';
  return `ship gate: ${gate.code ?? 'refused'}`;
}

export interface AttachDerivedShipGateDeps {
  resolve: (args: PlanAcceptanceGateArgs) => Promise<unknown[]>;
  current?: PlanAcceptanceGateArgs['current'];
}

/**
 * Attach `derivedStatus.shipGate` to every ok plan result the step applies to.
 *
 * IDEMPOTENT by construction: a plan result can be the cachedRead entry itself (the L1
 * cache returns the same object on every hit), so this step only REPLACES
 * `result.derivedStatus` with a fresh copy carrying `shipGate` — it never mutates the
 * shared summary and never appends to `derivedStatus.text`, which would grow on every hit.
 */
export async function attachDerivedShipGates(
  results: Array<Record<string, unknown>>,
  deps: AttachDerivedShipGateDeps,
): Promise<void> {
  for (const result of results) {
    if (result.ok !== true) continue;
    const slug = typeof result.slug === 'string' ? result.slug : null;
    const derivedStatus = result.derivedStatus as Record<string, unknown> | undefined;
    if (!slug || !shipGateApplies(derivedStatus, result.status)) continue;
    const harness = typeof result.harness === 'string' ? result.harness : null;
    const reused = result.shipReadiness as Partial<PlanAcceptanceGateVerdictRow> | undefined;
    let verdict: Partial<PlanAcceptanceGateVerdictRow> | undefined = reused;
    if (!verdict) {
      try {
        const rows = await deps.resolve({
          workspaceId: 'default',
          planSlug: slug,
          ...(harness ? { harnessSlug: harness } : {}),
          ...(deps.current ? { current: deps.current } : {}),
        });
        verdict = rows[0] as Partial<PlanAcceptanceGateVerdictRow> | undefined;
      } catch {
        verdict = undefined;
      }
    }
    const shipGate = projectDerivedShipGate(verdict, { slug, harness, reusedShipReadiness: reused !== undefined });
    result.derivedStatus = { ...derivedStatus, shipGate };
  }
}
