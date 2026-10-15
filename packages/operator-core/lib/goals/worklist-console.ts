/** Projections for the dedicated worklist GUI; policy and event storage stay shared. */
import { OrderedSelectionPolicySchema } from '../typed-properties';

export function changedWorklistPlans(before: unknown, after: unknown) {
  const old = OrderedSelectionPolicySchema.safeParse(before);
  const next = OrderedSelectionPolicySchema.safeParse(after);
  if (!old.success || !next.success) return [];
  const state = (policy: typeof old.data, ref: string) => ({
    included: !policy.excluded.includes(ref) && (!policy.included || policy.included.includes(ref)),
    rank: policy.order.filter((id) => !policy.excluded.includes(id) &&
      (!policy.included || policy.included.includes(id))).indexOf(ref) + 1 || null,
  });
  return [...new Set([...old.data.order, ...next.data.order, ...old.data.excluded, ...next.data.excluded])]
    .filter((ref) => /^plan:[^/]+\/.+/.test(ref))
    .flatMap((ref) => {
      const prior = state(old.data, ref), current = state(next.data, ref);
      if (prior.included === current.included && prior.rank === current.rank) return [];
      return [{ ref, before: prior, after: current, label: !current.included ? 'Removed from this goal'
        : !prior.included ? 'Added to this goal' : `Priority ${prior.rank ?? 'unranked'} → ${current.rank ?? 'unranked'}` }];
    });
}

export function projectWorklistHistory(events: Array<{ ts: string; from: string; before?: unknown;
  after?: unknown; detail?: string; msg_id: string }>) {
  return events.slice().reverse().flatMap((event) => changedWorklistPlans(event.before, event.after)
    .map((change) => ({ id: event.msg_id, ref: change.ref, at: event.ts, actor: event.from,
      label: change.label, detail: event.detail ?? null })));
}
