/** Pilot quote arithmetic; extends hosted billing using the existing journal's USD unit.
 * Catalog prices and modeled workloads remain provisional. This does not charge a customer.
 */
import { MICROS_PER_CENT } from '../../../cupboard/money-journal';

export const PILOT_COST_CATEGORIES = [
  'compute', 'persistent-storage', 'external-ip', 'egress',
  'inference-input', 'inference-output', 'cache-read', 'cache-write', 'inference-fees',
  'support', 'platform-overhead',
] as const;
export type PilotCostCategory = (typeof PILOT_COST_CATEGORIES)[number];
export type CostPayer = 'platform' | 'consumption' | 'customer-direct';

export interface CostProvenance {
  readonly evidenceRef: string;
  readonly measuredAtMs: number;
}
export interface PilotCostLine {
  readonly id: string;
  readonly category: PilotCostCategory;
  readonly payer: CostPayer;
  /** Count in the rate's unit: seconds, bytes, tokens or staff minutes, for example. */
  readonly quantity: number;
  readonly unit: string;
  readonly usage: CostProvenance & { readonly kind: 'observed' | 'modeled' };
  /** Null means unpriced, never free. An explicit zero quantity proves no exposure. */
  readonly rate: (CostProvenance & {
    readonly unit: string;
    readonly unitsPerRate: number;
    readonly microsPerRate: number;
    readonly minimumBillableUnits?: number;
    readonly billingIncrementUnits?: number;
    /** Measured labor applies only to support and platform overhead. */
    readonly kind: 'provider-billed' | 'measured-labor' | 'catalog' | 'estimate';
  }) | null;
}
export interface PilotPriceSheet {
  readonly version: string;
  readonly asOfMs: number;
  readonly maximumEvidenceAgeMs: number;
  readonly lines: readonly PilotCostLine[];
  readonly platformPriceCents: number;
  readonly consumptionPriceCents: number;
  readonly includedAllowanceMicros: number;
  readonly inferenceMode: 'customer-key' | 'managed';
  readonly overage: 'stop' | 'opt-in';
  readonly paymentFee: (CostProvenance & {
    readonly percentageBps: number;
    readonly fixedCents: number;
    readonly kind: 'merchant-confirmed' | 'catalog' | 'estimate';
  }) | null;
  readonly targetPlatformMarginBps: number;
  readonly targetConsumptionMarginBps: number;
  /** Optional observed case census. This does not establish customer approval. */
  readonly outcomes?: PilotOutcomePopulation;
}
export interface PilotOutcomeObservation extends CostProvenance {
  readonly caseId: string;
  readonly decision: 'accepted' | 'rejected' | 'rework' | null;
  readonly reviewerRef: string | null;
  readonly reviewDurationMs: number | null;
  readonly reworkCount: number | null;
  readonly repeatUse: boolean | null;
}
export interface PilotOutcomePopulation {
  readonly trialRef: string;
  /** Frozen eligible population, including unsuccessful and unreviewed cases. */
  readonly caseIds: readonly string[];
  readonly observations: readonly PilotOutcomeObservation[];
  /** Exact cases covered by this sheet's costs; null means unbound cost. */
  readonly costCaseIds: readonly string[] | null;
  readonly costEvidenceRef: string | null;
}
export interface PilotOutcomeMetrics {
  readonly trialRef: string;
  readonly caseCount: number;
  readonly observedCases: number;
  readonly missingCaseIds: readonly string[];
  readonly decidedCases: number;
  readonly acceptedCases: number;
  readonly acceptanceBps: number | null;
  readonly knownReviewDurationMs: number;
  readonly reviewDurationMs: number | null;
  readonly knownReworkCount: number;
  readonly reworkCount: number | null;
  readonly knownRepeatUseCases: number;
  readonly repeatUseCases: number | null;
  readonly totalCostMicros: number | null;
  readonly costPerAcceptedCaseMicros: number | null;
  readonly gaps: readonly string[];
  readonly evidenceRefs: readonly string[];
}
export interface PilotMargin {
  readonly revenueMicros: number;
  /** A lower bound when costMicros is null. */
  readonly knownCostMicros: number;
  readonly costMicros: number | null;
  readonly paymentFeeMicros: number | null;
  readonly profitMicros: number | null;
  /** Floor of profit / revenue in basis points; null for zero revenue or incomplete cost. */
  readonly marginBps: number | null;
  readonly targetMet: boolean;
  /** Standalone price floor, including this axis's fees. Fixed transaction fee belongs to platform. */
  readonly minimumPriceCents: number | null;
}
export interface PilotEconomics {
  readonly version: string;
  readonly state: 'incomplete' | 'provisional' | 'measured';
  readonly quoteAllowed: boolean;
  readonly reasons: readonly string[];
  readonly costs: readonly { id: string; category: PilotCostCategory; payer: CostPayer; micros: number | null }[];
  readonly customerDirectKnownCostMicros: number;
  readonly paymentFeeCents: number | null;
  readonly platform: PilotMargin;
  readonly consumption: PilotMargin;
  readonly outcomes?: PilotOutcomeMetrics;
}

const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const CENT = BigInt(MICROS_PER_CENT);
const BPS = 10_000n;
const inferenceCategories = new Set<PilotCostCategory>(['inference-input', 'inference-output', 'cache-read', 'cache-write', 'inference-fees']);

function integer(value: number, name: string, minimum = 0): bigint {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`invalid ${name}`);
  return BigInt(value);
}
function safe(value: bigint, name: string): number {
  if (value > MAX || value < -MAX) throw new Error(`overflow ${name}`);
  return Number(value);
}
function ceil(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
function floor(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return numerator < 0n && numerator % denominator !== 0n ? quotient - 1n : quotient;
}
function reference(value: string, name: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`invalid ${name}`);
}
function bps(value: number, name: string): bigint {
  const amount = integer(value, name);
  if (amount >= BPS) throw new Error(`invalid ${name}`);
  return amount;
}

/** Project attributed observations, never infer human measurements from usage.
 * Costs cover the entire frozen population, including unsuccessful cases.
 * Evidence refs are supplied observations, not authenticated trial acceptance.
 */
function pilotOutcomeMetrics(sheet: PilotPriceSheet, state: PilotEconomics['state'],
  totalCost: bigint): PilotOutcomeMetrics {
  const population = sheet.outcomes!;
  const outcomeId = (value: string, name: string): void => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)) {
      throw new Error(`invalid pilot outcome ${name}`);
    }
  };
  const census = (ids: readonly string[], name: string): Set<string> => {
    if (!Array.isArray(ids) || ids.length > 500) throw new Error(`invalid pilot outcome ${name} population`);
    ids.forEach((id) => outcomeId(id, name));
    const result = new Set(ids);
    if (result.size !== ids.length) throw new Error(`duplicate pilot outcome ${name}`);
    return result;
  };
  outcomeId(population.trialRef, 'trial');
  const cases = census(population.caseIds, 'case');
  if (!Array.isArray(population.observations) || population.observations.length > 500) {
    throw new Error('invalid pilot outcome observation population');
  }
  const seen = new Set<string>(), evidence = new Set<string>(), gaps: string[] = [];
  let accepted = 0, decided = 0, repeated = 0;
  let review = 0n, rework = 0n;
  let measuredReview = 0, measuredRework = 0, measuredRepeat = 0;
  const keys = ['caseId', 'decision', 'reviewerRef', 'reviewDurationMs', 'reworkCount',
    'repeatUse', 'evidenceRef', 'measuredAtMs'];
  for (const row of population.observations) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some((key) => !keys.includes(key))) {
      throw new Error('invalid pilot outcome observation');
    }
    outcomeId(row.caseId, 'case');
    if (!cases.has(row.caseId)) throw new Error('pilot outcome outside case population');
    if (seen.has(row.caseId)) throw new Error('duplicate pilot outcome observation');
    seen.add(row.caseId);
    outcomeId(row.evidenceRef, 'evidence');
    integer(row.measuredAtMs, 'pilot outcome observation time');
    if (row.measuredAtMs > sheet.asOfMs || sheet.asOfMs - row.measuredAtMs > sheet.maximumEvidenceAgeMs) {
      throw new Error('stale pilot outcome observation');
    }
    evidence.add(row.evidenceRef);
    if (row.decision !== null && !['accepted', 'rejected', 'rework'].includes(row.decision)) {
      throw new Error('invalid pilot outcome decision');
    }
    if (row.reviewerRef !== null) outcomeId(row.reviewerRef, 'reviewer');
    if ((row.decision !== null || row.reviewDurationMs !== null) && row.reviewerRef === null) {
      throw new Error('pilot outcome requires reviewer attribution');
    }
    if (row.decision !== null) decided++;
    if (row.decision === 'accepted') accepted++;
    if (row.reviewDurationMs !== null) {
      review += integer(row.reviewDurationMs, 'pilot outcome review duration'); measuredReview++;
    }
    if (row.reworkCount !== null) {
      rework += integer(row.reworkCount, 'pilot outcome rework'); measuredRework++;
    }
    if (row.repeatUse !== null) {
      if (typeof row.repeatUse !== 'boolean') throw new Error('invalid pilot outcome repeat use');
      measuredRepeat++; if (row.repeatUse) repeated++;
    }
  }
  const missingCaseIds = [...cases].filter((id) => !seen.has(id));
  const count = cases.size, complete = count > 0;
  if (!complete) gaps.push('no-cases');
  if (missingCaseIds.length) gaps.push('missing-observations');
  if (decided !== count) gaps.push('missing-decisions');
  if (measuredReview !== count) gaps.push('missing-review-duration');
  if (measuredRework !== count) gaps.push('missing-rework');
  if (measuredRepeat !== count) gaps.push('missing-repeat-use');
  let costBound = false;
  if (population.costCaseIds !== null) {
    const costCases = census(population.costCaseIds, 'cost case');
    outcomeId(population.costEvidenceRef!, 'cost evidence');
    evidence.add(population.costEvidenceRef!);
    costBound = costCases.size === count && [...costCases].every((id) => cases.has(id));
  } else if (population.costEvidenceRef !== null) {
    throw new Error('pilot outcome cost evidence requires cost population');
  }
  if (!costBound) gaps.push('cost-population-unbound');
  if (state !== 'measured') gaps.push('cost-not-measured');
  if (accepted === 0) gaps.push('no-accepted-cases');
  const costKnown = complete && costBound && state === 'measured';
  return {
    trialRef: population.trialRef, caseCount: count, observedCases: seen.size, missingCaseIds,
    decidedCases: decided, acceptedCases: accepted,
    acceptanceBps: complete && decided === count ? Math.floor(accepted * 10_000 / count) : null,
    knownReviewDurationMs: safe(review, 'pilot outcome review duration'),
    reviewDurationMs: complete && measuredReview === count ? safe(review, 'pilot outcome review duration') : null,
    knownReworkCount: safe(rework, 'pilot outcome rework'),
    reworkCount: complete && measuredRework === count ? safe(rework, 'pilot outcome rework') : null,
    knownRepeatUseCases: repeated, repeatUseCases: complete && measuredRepeat === count ? repeated : null,
    totalCostMicros: costKnown ? safe(totalCost, 'pilot outcome cost') : null,
    costPerAcceptedCaseMicros: costKnown && decided === count && accepted > 0
      ? safe(ceil(totalCost, BigInt(accepted)), 'pilot outcome result cost') : null,
    gaps, evidenceRefs: [...evidence].sort(),
  };
}

/** Exact fee-aware floor, including the fee's whole-cent rounding. */
function priceFloor(cost: bigint, fixedCents: bigint, feeBps: bigint, targetBps: bigint): number | null {
  if (feeBps + targetBps >= BPS) return null;
  const maximum = MAX / CENT;
  const meets = (price: bigint): boolean => {
    const revenue = price * CENT;
    const fee = price === 0n ? 0n : (ceil(price * feeBps, BPS) + fixedCents) * CENT;
    return (revenue - cost - fee) * BPS >= revenue * targetBps;
  };
  // Ignoring fee rounding gives a proven lower bound. Rounding adds less than
  // one cent, so at most ceil(10000 / denominator) further cents are needed.
  // The predicate can briefly turn false at a fee step: binary search is unsafe.
  const denominator = BPS - feeBps - targetBps;
  const lower = ceil((cost + fixedCents * CENT) * BPS, denominator * CENT);
  const upper = lower + ceil(BPS, denominator);
  for (let price = lower; price <= upper && price <= maximum; price += 1n) {
    if (meets(price)) return safe(price, 'minimum price');
  }
  return null;
}

export function calculatePilotEconomics(sheet: PilotPriceSheet): PilotEconomics {
  reference(sheet.version, 'sheet version');
  integer(sheet.asOfMs, 'as-of time');
  integer(sheet.maximumEvidenceAgeMs, 'evidence age', 1);
  integer(sheet.includedAllowanceMicros, 'finite allowance', 1);
  if (!['customer-key', 'managed'].includes(sheet.inferenceMode)) throw new Error('invalid inference mode');
  if (!['stop', 'opt-in'].includes(sheet.overage)) throw new Error('invalid overage policy');
  const platformCents = integer(sheet.platformPriceCents, 'platform price');
  const consumptionCents = integer(sheet.consumptionPriceCents, 'consumption price');
  const platformRevenue = platformCents * CENT;
  const consumptionRevenue = consumptionCents * CENT;
  safe(platformRevenue + consumptionRevenue, 'total revenue');
  const targets = {
    platform: bps(sheet.targetPlatformMarginBps, 'platform margin target'),
    consumption: bps(sheet.targetConsumptionMarginBps, 'consumption margin target'),
  };
  const sums: Record<CostPayer, bigint> = { platform: 0n, consumption: 0n, 'customer-direct': 0n };
  const complete: Record<CostPayer, boolean> = { platform: true, consumption: true, 'customer-direct': true };
  const reasons: string[] = [];
  let provisional = false;
  const seen = new Set<string>();
  const categories = new Set<PilotCostCategory>();
  const checkProvenance = (provenance: CostProvenance, name: string): void => {
    reference(provenance.evidenceRef, `${name} evidence`);
    integer(provenance.measuredAtMs, `${name} time`);
    if (provenance.measuredAtMs > sheet.asOfMs || sheet.asOfMs - provenance.measuredAtMs > sheet.maximumEvidenceAgeMs) {
      reasons.push(`stale-evidence:${name}`);
      provisional = true;
    }
  };
  const costs = sheet.lines.map((line) => {
    reference(line.id, 'line id');
    if (seen.has(line.id)) throw new Error(`duplicate line ${line.id}`);
    seen.add(line.id);
    if (!(PILOT_COST_CATEGORIES as readonly string[]).includes(line.category)) throw new Error('invalid cost category');
    if (!Object.hasOwn(sums, line.payer)) throw new Error('invalid cost payer');
    if ((line.category === 'support' || line.category === 'platform-overhead') && line.payer !== 'platform') {
      throw new Error('support and overhead belong to platform');
    }
    if (inferenceCategories.has(line.category) && line.payer !== (sheet.inferenceMode === 'customer-key' ? 'customer-direct' : 'consumption')) {
      throw new Error('inference payer disagrees with key policy');
    }
    categories.add(line.category);
    const quantity = integer(line.quantity, `${line.id} quantity`);
    reference(line.unit, `${line.id} unit`);
    if (!['observed', 'modeled'].includes(line.usage.kind)) throw new Error('invalid usage kind');
    checkProvenance(line.usage, `${line.id}:usage`);
    if (line.usage.kind === 'modeled') {
      reasons.push(`modeled-usage:${line.id}`);
      provisional = true;
    }
    let amount: bigint | null = quantity === 0n ? 0n : null;
    if (line.rate !== null) {
      if (line.rate.unit !== line.unit) throw new Error(`unit mismatch ${line.id}`);
      const units = integer(line.rate.unitsPerRate, `${line.id} rate units`, 1);
      const rate = integer(line.rate.microsPerRate, `${line.id} rate`);
      const minimum = integer(line.rate.minimumBillableUnits ?? 0, `${line.id} minimum billable units`);
      const increment = integer(line.rate.billingIncrementUnits ?? 1, `${line.id} billing increment`, 1);
      if (!['provider-billed', 'measured-labor', 'catalog', 'estimate'].includes(line.rate.kind)) throw new Error('invalid rate kind');
      if (line.rate.kind === 'measured-labor' && line.category !== 'support' && line.category !== 'platform-overhead') {
        throw new Error('measured labor rate requires a labor cost category');
      }
      checkProvenance(line.rate, `${line.id}:rate`);
      const billable = quantity === 0n ? 0n : ceil(quantity < minimum ? minimum : quantity, increment) * increment;
      safe(billable, `${line.id} billable quantity`);
      amount = ceil(billable * rate, units);
      if (quantity > 0n && (line.rate.kind === 'catalog' || line.rate.kind === 'estimate')) {
        reasons.push(`estimated-cost:${line.id}`);
        provisional = true;
      }
    }
    if (amount === null) {
      reasons.push(`unpriced:${line.id}`);
      complete[line.payer] = false;
    } else sums[line.payer] += amount;
    return { id: line.id, category: line.category, payer: line.payer, micros: amount === null ? null : safe(amount, line.id) };
  });
  for (const category of PILOT_COST_CATEGORIES) {
    if (categories.has(category)) continue;
    reasons.push(`missing-cost:${category}`);
    // An omitted exposure has no measured payer either. Do not present partial sums as a margin.
    complete.platform = complete.consumption = complete['customer-direct'] = false;
  }
  safe(sums.platform + sums.consumption + sums['customer-direct'], 'total cost');
  let feeCents: bigint | null = null;
  let platformFee: bigint | null = null;
  let consumptionFee: bigint | null = null;
  let percentage: bigint | null = null;
  let fixed: bigint | null = null;
  if (sheet.paymentFee === null) reasons.push('unpriced:payment-fee');
  else {
    percentage = bps(sheet.paymentFee.percentageBps, 'payment percentage');
    fixed = integer(sheet.paymentFee.fixedCents, 'fixed payment fee');
    if (!['merchant-confirmed', 'catalog', 'estimate'].includes(sheet.paymentFee.kind)) throw new Error('invalid payment fee kind');
    checkProvenance(sheet.paymentFee, 'payment-fee');
    if (sheet.paymentFee.kind !== 'merchant-confirmed') {
      reasons.push('estimated-cost:payment-fee');
      provisional = true;
    }
    const totalCents = platformCents + consumptionCents;
    const variableFee = ceil(totalCents * percentage, BPS) * CENT;
    const fixedFee = totalCents === 0n ? 0n : fixed * CENT;
    safe(variableFee + fixedFee, 'payment fee');
    feeCents = (variableFee + fixedFee) / CENT;
    // Allocate the variable fee proportionally; put its exact residue on consumption.
    const platformVariable = totalCents === 0n ? 0n : variableFee * platformCents / totalCents;
    platformFee = platformVariable + fixedFee;
    consumptionFee = variableFee - platformVariable;
  }
  const margin = (payer: 'platform' | 'consumption', revenue: bigint, fee: bigint | null): PilotMargin => {
    const cost = complete[payer] ? sums[payer] : null;
    const profit = cost === null || fee === null ? null : revenue - cost - fee;
    const marginBps = profit === null || revenue === 0n ? null : floor(profit * BPS, revenue);
    return {
      revenueMicros: safe(revenue, `${payer} revenue`),
      knownCostMicros: safe(sums[payer], `${payer} cost`),
      costMicros: cost === null ? null : safe(cost, `${payer} cost`),
      paymentFeeMicros: fee === null ? null : safe(fee, `${payer} fee`),
      profitMicros: profit === null ? null : safe(profit, `${payer} profit`),
      marginBps: marginBps === null ? null : safe(marginBps, `${payer} margin`),
      targetMet: marginBps !== null && marginBps >= targets[payer],
      minimumPriceCents: cost === null || percentage === null || fixed === null ? null
        : priceFloor(cost, payer === 'platform' ? fixed : 0n, percentage, targets[payer]),
    };
  };
  const platform = margin('platform', platformRevenue, platformFee);
  const consumption = margin('consumption', consumptionRevenue, consumptionFee);
  if (!platform.targetMet) reasons.push('margin-target:platform');
  if (consumptionRevenue > 0n && !consumption.targetMet) reasons.push('margin-target:consumption');
  if (consumptionRevenue === 0n && sums.consumption > 0n) reasons.push('unfunded-consumption');
  const incomplete = Object.values(complete).some((value) => !value) || sheet.paymentFee === null;
  const state = incomplete ? 'incomplete' : provisional ? 'provisional' : 'measured';
  return {
    version: sheet.version, state,
    quoteAllowed: state === 'measured' && platform.targetMet && (consumptionRevenue === 0n ? sums.consumption === 0n : consumption.targetMet),
    reasons, costs, customerDirectKnownCostMicros: safe(sums['customer-direct'], 'customer direct cost'),
    paymentFeeCents: feeCents === null ? null : safe(feeCents, 'payment fee'), platform, consumption,
    ...(sheet.outcomes === undefined ? {} : { outcomes: pilotOutcomeMetrics(sheet, state,
      sums.platform + sums.consumption + sums['customer-direct']) }),
  };
}
