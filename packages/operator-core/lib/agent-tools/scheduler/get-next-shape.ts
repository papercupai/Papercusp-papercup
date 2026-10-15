/**
 * WI-6554700010008923 — payload-tier shape for `scheduler:get_next`.
 *
 * Measured (400 most recent result-door spills, 2026-10-12): body p50 6.4KB,
 * p90 8.7KB, 83% of calls over the transport cap. Two populations, two wastes:
 *
 *   - CLAIM responses echo `workItem.payload` whole, and most of its bytes are
 *     machine bookkeeping the claimant never acts on (toolFailureProbation,
 *     toolFailureSignature, freshnessEnvelope, implementationReadiness, admission*,
 *     dedupCandidates, `_`-prefixed internals) — ~11% of all bytes.
 *   - NO-CLAIM responses repeat the same ~19 exclusion counters three times
 *     (claimability.population.excluded, each claimability.population.families.*.excluded,
 *     excludedBreakdown.excluded), most of them zero.
 *
 * Runs only for trimmed/standard tiers (agent sessions); `payloadTier:'full'` and
 * tierless programmatic callers get the complete object. It is a DENYLIST on purpose:
 * an unknown payload key passes through, and every omitted key is named with the
 * exact read that returns it, so nothing silently disappears.
 */

const PAYLOAD_BOOKKEEPING_KEY = /^(?:_|toolFailure|admission)|^(?:freshnessEnvelope|implementationReadiness|dedupCandidates)$/;

const SAME_AS_POPULATION = 'same as claimability.population.excluded';

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

/** Drop zero counters; a reader then sees only the floors that actually excluded rows. */
function nonZeroCounters(excluded: unknown): unknown {
  if (!isRec(excluded)) return excluded;
  const out: Rec = {};
  for (const [k, v] of Object.entries(excluded)) if (v !== 0) out[k] = v;
  return out;
}

function shapeClaimPayload(workItem: Rec): Rec | undefined {
  const payload = workItem.payload;
  if (!isRec(payload)) return undefined;
  const kept: Rec = {};
  const omitted: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (PAYLOAD_BOOKKEEPING_KEY.test(k)) omitted.push(k);
    else kept[k] = v;
  }
  if (omitted.length === 0) return undefined;
  const id = typeof workItem.id === 'string' ? workItem.id : '<id>';
  return {
    ...workItem,
    payload: {
      ...kept,
      omittedKeys: omitted,
      omittedKeysRead: `work_items:get { id: '${id}', payloadTier: 'full' }`,
    },
  };
}

function shapeNoClaimCounters(d: Rec): Rec | undefined {
  const claimability = d.claimability;
  if (!isRec(claimability) || !isRec(claimability.population)) return undefined;
  const population = claimability.population;
  const populationExcludedJson = JSON.stringify(population.excluded ?? null);
  const dedupe = (excluded: unknown): unknown =>
    population.excluded !== undefined && JSON.stringify(excluded ?? null) === populationExcludedJson
      ? SAME_AS_POPULATION
      : nonZeroCounters(excluded);

  let families = population.families;
  if (isRec(families)) {
    const next: Rec = {};
    for (const [name, fam] of Object.entries(families)) {
      next[name] = isRec(fam) && 'excluded' in fam ? { ...fam, excluded: dedupe(fam.excluded) } : fam;
    }
    families = next;
  }
  const shapedClaimability: Rec = {
    ...claimability,
    population: {
      ...population,
      ...('excluded' in population ? { excluded: nonZeroCounters(population.excluded) } : {}),
      ...(families !== undefined ? { families } : {}),
    },
  };
  const breakdown = d.excludedBreakdown;
  return {
    ...d,
    claimability: shapedClaimability,
    ...(isRec(breakdown) && 'excluded' in breakdown
      ? { excludedBreakdown: { ...breakdown, excluded: dedupe(breakdown.excluded) } }
      : {}),
  };
}

export function shapeGetNextResult(data: unknown, _ctx?: { tier: 'standard' | 'trimmed' }): unknown {
  if (!isRec(data)) return data;
  let out: Rec = data;
  if (isRec(out.workItem)) {
    const workItem = shapeClaimPayload(out.workItem);
    // Spreading then re-assigning an EXISTING key keeps its position, so the
    // prefix-preserving order the handler chose (claimReceipt first) survives.
    if (workItem) out = { ...out, workItem };
  }
  const counters = shapeNoClaimCounters(out);
  if (counters) out = counters;
  return out;
}
