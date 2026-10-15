/**
 * agent-economy-flywheel P-003 (E1, WI-10004287): the Postgres half of shadow metering.
 *
 * Reads one workspace-month of identity-attributed activity and hands it to the pure pricing
 * module (`shadow-metering.ts`). Nothing here writes or bills.
 *
 * Sources (all read-only):
 * - `agent_usage_samples_identity_attribution` (migrations 1149/1177/1275): inference samples
 *   with the identity span active at sample time. 1275 made a month of it answerable; before
 *   that one hour exceeded 30s (WI-10004451).
 * - `session_identity_activation_events` -> `adv_sessions.launch_spec`: the launch profile and
 *   the specification artifact's blueprint-layer inputs. A layer counts only when its document
 *   fills an identity slot, and is reported slot-qualified (`domain:papercusp-engineer`). Layers
 *   are read only from the artifact of the SAME specification revision the span applied: the
 *   launch record's current artifact, or — once the record has moved on — the matching entry of
 *   its `identityHistory` (WI-10004494). The event's own `specification_layer_refs` stamp
 *   (migration 1295, taken at record time) wins over that lookup, because the record churns its
 *   revision per relaunch and evicts history past 12. With none, the row keeps its profile but no layers,
 *   which prices it as `inferred-profile` (never bill-grade) rather than guessing from a newer
 *   artifact.
 * - `tool_invocations_identity_attribution`: tool calls, reported as counts (priced 0, D-009).
 */
import type { Sql } from 'postgres';
import type { WorkItem } from '../work-items';
import { isSufficientEvidence } from '../work-item-completion-authority';
import type { SpecAdequacyCompletionGateResult } from '../agent-tools/work_items/spec-test-adequacy-gate';
import type { FundedIdentityTurn, IdentityWorkItemBinding } from './funded-turn-store';
import { quoteIdentityInferenceTurn } from './identity-per-use-offer';
import { PRICE_TABLE_VERSION } from '@papercusp/model-pricing';
import {
  buildShadowStatements,
  shadowMonthBounds,
  SHADOW_MARKUP_SHEET,
  usdToMicros,
  type ShadowCostBasisRow,
  type ShadowMarkupSheet,
  type ShadowStatement,
  type ShadowToolAggregate,
  type ShadowUsageAggregate,
} from './shadow-metering';

// Preserve the reader's public import path for existing metering consumers.
export { shadowMonthBounds } from './shadow-metering';

interface UsageRow {
  attributed: boolean;
  agent: string | null;
  profile: string | null;
  spec_layers: unknown;
  axis_layers: unknown;
  cost_source: string | null;
  cost_usd: string | null;
  samples: string;
}

/**
 * Inference usage for one workspace-month, one row per (activation event, cost source).
 * Samples are aggregated before the launch record is read, so the large launch spec is parsed
 * once per activation event rather than once per sample.
 */
export async function readShadowUsageAggregates(
  sql: Sql,
  input: { workspaceId: string; month: string },
): Promise<ShadowUsageAggregate[]> {
  const { startMs, endMs } = shadowMonthBounds(input.month);
  const rows = await sql<UsageRow[]>`
    WITH s AS (
      SELECT a.identity_activation_event_id AS event_id,
             a.identity_specification_revision AS revision,
             a.identity_stack_refs AS stack_refs,
             a.cost_source,
             sum(a.cost_usd::numeric) AS cost_usd,
             count(*) AS samples
        FROM harness_shared.agent_usage_samples_identity_attribution a
       WHERE a.workspace_id = ${input.workspaceId}
         AND a.ts >= ${startMs} AND a.ts < ${endMs}
       GROUP BY 1, 2, 3, 4
    )
    SELECT (s.event_id IS NOT NULL) AS attributed,
           av.launch_spec->>'agent' AS agent,
           av.launch_spec->>'profile' AS profile,
           -- Stamp first (migration 1295, taken at record time while the artifact was reachable);
           -- an unstamped event falls back to re-resolving the artifact from the launch record.
           COALESCE(e.specification_layer_refs,
                    harness_shared.identity_specification_layer_refs(art.artifact),
                    '[]'::jsonb) AS spec_layers,
           COALESCE(s.stack_refs, '[]'::jsonb) AS axis_layers,
           s.cost_source,
           s.cost_usd::text AS cost_usd,
           s.samples::text AS samples
      FROM s
      LEFT JOIN harness_shared.session_identity_activation_events e ON e.id = s.event_id
      LEFT JOIN harness_shared.adv_sessions av ON av.id = e.adv_session_id
      -- WI-10004494 gap 3: the artifact for EXACTLY the revision the span applied. A launch record
      -- that has since moved on keeps its earlier revisions in identityHistory (written beside the
      -- revision it describes, identity-management.ts historyWithCurrent); without this lookup
      -- every such span priced as inferred-profile even though its layers are on record.
      -- Skipped for a stamped event, so a stamped month never detoasts the launch record.
      LEFT JOIN LATERAL (
        SELECT CASE
                 WHEN e.specification_layer_refs IS NOT NULL THEN NULL::jsonb
                 WHEN av.launch_spec->>'specificationRevision' = s.revision
                   THEN av.launch_spec->'specificationArtifact'
                 ELSE (
                   SELECT h->'specificationArtifact'
                     FROM jsonb_array_elements(
                       CASE WHEN jsonb_typeof(av.launch_spec->'identityHistory') = 'array'
                            THEN av.launch_spec->'identityHistory' ELSE '[]'::jsonb END) h
                    WHERE h->>'specificationRevision' = s.revision
                      AND jsonb_typeof(h->'specificationArtifact') = 'object'
                    LIMIT 1)
               END AS artifact
      ) art ON true`;
  return rows.map((row) => ({
    workspaceId: input.workspaceId,
    month: input.month,
    attributed: row.attributed,
    agent: row.agent,
    profile: row.profile,
    specificationLayerRefs: stringArray(row.spec_layers),
    axisLayerRefs: stringArray(row.axis_layers),
    costSource: row.cost_source,
    costMicros: usdToMicros(row.cost_usd == null ? null : Number(row.cost_usd)),
    samples: Number(row.samples),
  }));
}

/** Tool calls for one workspace-month, split by whether an identity span covered them. */
export async function readShadowToolAggregates(
  sql: Sql,
  input: { workspaceId: string; month: string },
): Promise<ShadowToolAggregate[]> {
  const { startMs, endMs } = shadowMonthBounds(input.month);
  const rows = await sql<Array<{ attributed: boolean; calls: string }>>`
    SELECT (t.identity_activation_event_id IS NOT NULL) AS attributed, count(*)::text AS calls
      FROM harness_shared.tool_invocations_identity_attribution t
     WHERE t.workspace_id = ${input.workspaceId}
       AND t.invoked_at >= to_timestamp(${startMs}::double precision / 1000.0)
       AND t.invoked_at < to_timestamp(${endMs}::double precision / 1000.0)
     GROUP BY 1`;
  return rows.map((row) => ({
    workspaceId: input.workspaceId,
    month: input.month,
    attributed: row.attributed,
    calls: Number(row.calls),
  }));
}

/**
 * Plan decision D-018 point 4: what one workspace-month's usage cost was priced against.
 * Counts every usage row in the month, from the base table, because the attribution view
 * exposes neither the price stamp nor the provenance. Measured 2026-10-01 over September
 * (1.19M rows): about 250 ms, a parallel scan, the same population the usage read covers.
 */
export async function readShadowCostBasis(
  sql: Sql,
  input: { workspaceId: string; month: string; priceTableVersion?: string },
): Promise<ShadowCostBasisRow> {
  const { startMs, endMs } = shadowMonthBounds(input.month);
  const version = input.priceTableVersion ?? PRICE_TABLE_VERSION;
  const [row] = await sql<Array<{ samples: string; stale: string; unpriced: string; lower_bound: string }>>`
    SELECT count(*)::text AS samples,
           count(*) FILTER (WHERE u.cost_source IS DISTINCT FROM 'provider'
                              AND u.price_table_version IS DISTINCT FROM ${version})::text AS stale,
           count(*) FILTER (WHERE u.cost_usd IS NULL)::text AS unpriced,
           count(*) FILTER (WHERE u.usage_provenance->>'costBound' = 'lower')::text AS lower_bound
      FROM harness_shared.agent_usage_samples u
     WHERE u.workspace_id = ${input.workspaceId}
       AND u.ts >= ${startMs} AND u.ts < ${endMs}`;
  return {
    workspaceId: input.workspaceId,
    month: input.month,
    priceTableVersion: version,
    samples: Number(row?.samples ?? 0),
    staleSamples: Number(row?.stale ?? 0),
    unpricedSamples: Number(row?.unpriced ?? 0),
    lowerBoundSamples: Number(row?.lower_bound ?? 0),
  };
}

/** The would-have-cost statement for one workspace-month. Read-only; bills nothing. */
export async function readShadowStatement(
  sql: Sql,
  input: { workspaceId: string; month: string; sheet?: ShadowMarkupSheet; priceTableVersion?: string },
): Promise<ShadowStatement> {
  const sheet = input.sheet ?? SHADOW_MARKUP_SHEET;
  const [usage, tools, basis] = await Promise.all([
    readShadowUsageAggregates(sql, input),
    readShadowToolAggregates(sql, input),
    readShadowCostBasis(sql, input),
  ]);
  const statement = buildShadowStatements(usage, tools, sheet, [basis])
    .find((s) => s.workspaceId === input.workspaceId && s.month === input.month);
  if (statement) return statement;
  // No activity at all: still return the itemized empty statement (verdict `no-usage`).
  const empty: ShadowUsageAggregate = {
    workspaceId: input.workspaceId, month: input.month, attributed: false, agent: null, profile: null,
    specificationLayerRefs: [], axisLayerRefs: [], costSource: null, costMicros: 0, samples: 0,
  };
  return buildShadowStatements([empty], [], sheet, [basis])[0]!;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** A closed turn's exact usage population, supplied by the authenticated host. */
export interface IdentityTurnUsageBinding {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly principalId: string;
  readonly nativeSessionId: string;
  readonly nativeTurnId: string;
  readonly specificationRevision: string;
  readonly stateRevision: string;
  readonly usageEventKeys: readonly string[];
}

export type IdentityTurnBilledCost = {
  readonly ok: true;
  readonly billedInferenceMicros: bigint;
  readonly samples: readonly { usageEventKey: string; sampleId: string; activationEventId: string;
    /** Decimal integer microUSD, retained per event for exact request reconciliation. */
    billedInferenceMicros?: string }[];
} | {
  readonly ok: false;
  readonly code: 'identity-usage-invalid-binding' | 'identity-usage-incomplete' |
    'identity-usage-not-bill-grade' | 'identity-usage-binding-mismatch' | 'identity-usage-unavailable';
  readonly detail: string;
};

/**
 * Read bill-grade evidence for ONE completed turn (P-017/D-042), including a
 * carried native session through the canonical attribution view. Never infer
 * completion from whatever rows happen to have arrived: the host supplies the
 * complete expected event population. An empty population cannot prove zero cost.
 * Estimates, unknown costs and a changed identity binding refuse settlement.
 * This reader issues no voucher and grants no admission authority.
 */
export async function readIdentityTurnBilledCost(sql: Sql, input: IdentityTurnUsageBinding): Promise<IdentityTurnBilledCost> {
  const fail = (code: Exclude<IdentityTurnBilledCost, { ok: true }>['code'], detail: string): IdentityTurnBilledCost =>
    ({ ok: false, code, detail });
  if ([input.workspaceId, input.ownerId, input.principalId, input.nativeSessionId, input.nativeTurnId,
    input.specificationRevision, input.stateRevision].some((v) => typeof v !== 'string' || !v.trim()) ||
      !Array.isArray(input.usageEventKeys) || input.usageEventKeys.length === 0 || input.usageEventKeys.length > 1000 ||
      input.usageEventKeys.some((key) => typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) ||
      new Set(input.usageEventKeys).size !== input.usageEventKeys.length) {
    return fail('identity-usage-invalid-binding', 'a closed authenticated turn needs a nonempty exact usage-event population');
  }
  // Copy before awaiting IO: the closed-turn population and identity cannot
  // be changed while the read is in flight.
  const binding = { ...input, usageEventKeys: [...input.usageEventKeys] };
  let rows: {
    usage_event_key: string; sample_id: string; activation_event_id: string | null;
    session_id: string | null; turn_id: string | null; owner_id: string | null; principal_id: string | null;
    specification_revision: string | null; state_revision: string | null;
    cost_source: string | null; cost_bound: string | null; cost_micros: string | null;
  }[];
  try {
    rows = await sql<typeof rows>`
      SELECT u.usage_event_key, u.id::text AS sample_id,
             a.identity_activation_event_id::text AS activation_event_id,
             a.session_id, u.usage_provenance->>'turnId' AS turn_id,
             a.identity_owner_id AS owner_id, a.identity_principal_id AS principal_id,
             a.identity_specification_revision AS specification_revision,
             a.identity_state_revision AS state_revision,
             a.cost_source, u.usage_provenance->>'costBound' AS cost_bound,
             (a.cost_usd::numeric * 1000000)::text AS cost_micros
        FROM harness_shared.agent_usage_samples u
        JOIN harness_shared.agent_usage_samples_identity_attribution a
          ON a.workspace_id = u.workspace_id AND a.id = u.id
       WHERE u.workspace_id = ${binding.workspaceId}
         AND u.usage_event_key = ANY(${binding.usageEventKeys}::text[])`;
  } catch {
    return fail('identity-usage-unavailable', 'the canonical billed usage read could not be verified');
  }
  const expected = new Set(binding.usageEventKeys);
  const seen = new Set<string>();
  if (rows.length !== expected.size) return fail('identity-usage-incomplete', 'the closed turn usage population is not fully available');
  let billedInferenceMicros = 0n;
  const samples: Extract<IdentityTurnBilledCost, { ok: true }>['samples'][number][] = [];
  for (const row of rows) {
    if (!expected.has(row.usage_event_key) || seen.has(row.usage_event_key)) {
      return fail('identity-usage-incomplete', 'usage-event identities are missing, repeated or outside the closed turn');
    }
    seen.add(row.usage_event_key);
    if (!row.activation_event_id || row.session_id !== binding.nativeSessionId || row.turn_id !== binding.nativeTurnId ||
        row.owner_id !== binding.ownerId || row.principal_id !== binding.principalId ||
        row.specification_revision !== binding.specificationRevision || row.state_revision !== binding.stateRevision) {
      return fail('identity-usage-binding-mismatch', 'usage does not match the admitted payer, native turn and exact worn identity');
    }
    const money = typeof row.cost_micros === 'string' ? /^(\d+)(?:\.0+)?$/.exec(row.cost_micros) : null;
    if (row.cost_source !== 'provider' || row.cost_bound !== null || !money) {
      return fail('identity-usage-not-bill-grade', 'every usage event needs provider-reported nonnegative integer microUSD cost');
    }
    billedInferenceMicros += BigInt(money[1]!);
    samples.push({ usageEventKey: row.usage_event_key, sampleId: row.sample_id, activationEventId: row.activation_event_id,
      billedInferenceMicros: BigInt(money[1]!).toString() });
  }
  return { ok: true, billedInferenceMicros, samples };
}

export type OutcomeWorkItem = Pick<WorkItem, 'id' | 'harness' | 'state' | 'kind' | 'payload' |
  'terminalOwner' | 'terminalCompletionRef' | 'terminalCompletionEvidence' | 'completionAuthority'>;
export type IdentityOutcomeCost = {
  readonly basis: 'local-funded-release-usage';
  readonly releaseRef: string;
  readonly currency: 'USD';
} & ({
  readonly status: 'verified';
  readonly costPerAcceptedOutcomeMicros: string;
  readonly totalCostMicros: string;
  readonly acceptedOutcomes: number;
  readonly totalOutcomes: number;
  readonly turns: number;
  readonly evidenceRefs: readonly string[];
} | {
  readonly status: 'unavailable';
  readonly costPerAcceptedOutcomeMicros: null;
  readonly reason: string;
});

/** D-076: local funded spend includes failed outcomes; only current, graded
 * successful completions enter the denominator. This is not global BYOC spend.
 * No empty/partial/legacy population establishes a zero-dollar outcome. */
export async function readIdentityOutcomeCost(sql: Sql, input: { workspaceId: string; releaseRef: string }, deps: {
  readTurns?: (workspaceId: string, releaseRef: string) => Promise<FundedIdentityTurn[]>;
  readWorkItem?: (ref: IdentityWorkItemBinding) => Promise<OutcomeWorkItem | null>;
  readBilled?: typeof readIdentityTurnBilledCost;
  grade?: (item: OutcomeWorkItem) => Promise<SpecAdequacyCompletionGateResult>;
} = {}): Promise<IdentityOutcomeCost> {
  const scope = { basis: 'local-funded-release-usage' as const, releaseRef: input.releaseRef, currency: 'USD' as const };
  const unavailable = (reason: string): IdentityOutcomeCost =>
    ({ ...scope, status: 'unavailable', costPerAcceptedOutcomeMicros: null, reason });
  if (!input.workspaceId?.trim() || !input.releaseRef?.startsWith('identity-release:')) return unavailable('invalid-scope');
  // Copy authority before the first await; a caller cannot retarget an in-flight read.
  const workspaceId = input.workspaceId, releaseRef = input.releaseRef;
  try {
    const { FundedIdentityTurnStore, isIdentityWorkItemBinding } = await import('./funded-turn-store');
    const turns = await (deps.readTurns ?? ((workspace, release) =>
      new FundedIdentityTurnStore(sql).readReleasePopulation(workspace, release)))(workspaceId, releaseRef);
    if (turns.length === 0) return unavailable('no-funded-usage');
    if (turns.length > 500) return unavailable('population-limit');
    const population = structuredClone(turns);
    const seenTurns = new Set<string>(), seenEvents = new Set<string>(), evidence = new Set<string>();
    const outcomes = new Map<string, { ref: IdentityWorkItemBinding; owners: Set<string> }>();
    let totalCost = 0n;
    for (const turn of population) {
      const b = turn.binding, pending = turn.settlementOutbox;
      if (b.workspaceId !== workspaceId || b.offer.skuRef !== releaseRef || seenTurns.has(turn.turnId))
        return unavailable('population-binding-mismatch');
      seenTurns.add(turn.turnId);
      if (!isIdentityWorkItemBinding(b.workItem)) return unavailable('unlinked-outcome');
      if (turn.state !== 'settled' || !pending || !turn.fundingReceipt || !turn.usageEventKeys?.length ||
          turn.closedAtMs === null || b.nativeTurnId === null) return unavailable('unsettled-turn');
      const billed = await (deps.readBilled ?? readIdentityTurnBilledCost)(sql, { ...b,
        nativeTurnId: b.nativeTurnId, usageEventKeys: [...turn.usageEventKeys] });
      if (!billed.ok) return unavailable(billed.code);
      if (pending.billedInferenceMicros !== String(billed.billedInferenceMicros)) return unavailable('billed-cost-mismatch');
      const decimal = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v);
      if (!decimal(pending.priorRemainderNumerator) || !decimal(pending.receipt.amountMicros))
        return unavailable('settlement-evidence-mismatch');
      const quote = quoteIdentityInferenceTurn({ offer: b.offer, billedInferenceMicros: billed.billedInferenceMicros,
        inferenceCeilingMicros: b.inferenceCeilingMicros, priorRemainderNumerator: BigInt(pending.priorRemainderNumerator) });
      const r = pending.receipt, f = turn.fundingReceipt;
      if (!quote.ok || r.amountMicros !== String(quote.amountMicros) ||
          pending.remainderNumerator !== String(quote.remainderNumerator) ||
          r.channelId !== b.channelId || r.usageNonce !== turn.turnId || r.voucherDigest !== f.voucherDigest ||
          r.meterQuantity !== String(quote.reservationQuantity) || !r.signature?.trim() || r.occurredAtMs !== turn.closedAtMs ||
          f.usageNonce !== turn.turnId || f.channelId !== b.channelId || f.releaseRef !== releaseRef ||
          f.payer !== b.payer || f.seller !== b.seller || f.priceVersion !== b.offer.priceVersion ||
          f.splitManifestHash !== b.offer.splitManifestHash)
        return unavailable('settlement-evidence-mismatch');
      const expectedEvents = new Set(turn.usageEventKeys);
      if (expectedEvents.size !== turn.usageEventKeys.length || billed.samples.length !== expectedEvents.size)
        return unavailable('usage-population-mismatch');
      for (const sample of billed.samples) {
        if (!expectedEvents.delete(sample.usageEventKey) || seenEvents.has(sample.usageEventKey) ||
            !sample.sampleId || !sample.activationEventId) return unavailable('usage-population-mismatch');
        seenEvents.add(sample.usageEventKey);
        evidence.add(`agent-usage-sample:${sample.sampleId}`);
        evidence.add(`identity-activation:${sample.activationEventId}`);
      }
      evidence.add(`funded-identity-turn:${turn.turnId}`);
      totalCost += billed.billedInferenceMicros + quote.amountMicros;
      const key = JSON.stringify([b.workItem.harness, b.workItem.id]);
      const outcome = outcomes.get(key) ?? { ref: { ...b.workItem }, owners: new Set<string>() };
      outcome.owners.add(b.ownerId);
      outcomes.set(key, outcome);
    }
    const readItem = deps.readWorkItem ?? (async (ref: IdentityWorkItemBinding) =>
      (await import('../work-items')).getWorkItem(ref.id, ref.harness, {}, sql));
    const grade = deps.grade ?? (async (item: OutcomeWorkItem) =>
      (await import('../agent-tools/work_items/spec-test-adequacy-gate')).specTestAdequacyCompletionGate({ workItem: item,
        attestation: { classRef: item.kind === 'bug' ? 'plan-class-bugfix' : 'plan-class-feature-ship' } }));
    let acceptedOutcomes = 0;
    for (const { ref, owners } of outcomes.values()) {
      const item = await readItem(ref);
      if (!item || item.id !== ref.id || item.harness !== ref.harness) return unavailable('outcome-binding-mismatch');
      // Canonical successful states and legacy equivalents; dropped outcomes
      // contribute their spend, never a fabricated successful denominator.
      if (!['done', 'passed', 'resolved', 'dropped', 'deprecated', 'closed'].includes(item.state))
        return unavailable('outcome-pending');
      if (['dropped', 'deprecated', 'closed'].includes(item.state)) continue;
      if (owners.size !== 1 || !item.terminalOwner || !owners.has(item.terminalOwner) ||
          !item.terminalCompletionRef || !['committed', 'validated'].includes(item.completionAuthority ?? '') ||
          !isSufficientEvidence(item.terminalCompletionEvidence)) return unavailable('completion-unverified');
      const grading = await grade(item);
      if (!grading.ok || !grading.applicable || grading.checked.length === 0 || grading.exempted?.length)
        return unavailable('grading-unverified');
      acceptedOutcomes += 1;
      evidence.add(`work-item:${ref.harness}:${ref.id}:${item.terminalCompletionRef}`);
      for (const clause of grading.checked) evidence.add(`graded-clause:${clause}`);
    }
    if (acceptedOutcomes === 0) return unavailable('no-accepted-outcomes');
    const denominator = BigInt(acceptedOutcomes);
    return { ...scope, status: 'verified', costPerAcceptedOutcomeMicros: String((totalCost + denominator - 1n) / denominator),
      totalCostMicros: String(totalCost), acceptedOutcomes, totalOutcomes: outcomes.size, turns: population.length,
      evidenceRefs: [...evidence].sort() };
  } catch {
    return unavailable('evidence-unavailable');
  }
}
