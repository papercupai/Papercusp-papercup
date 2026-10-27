import type { OpEnvelope } from './op-envelope-types';

export type MergeRule = 'lww' | 'append-only' | 'set-union' | 'counter';

/** Explicit production census. A new replicated table must choose its semantics. */
export const TABLE_MERGE_RULES: Readonly<Record<string, MergeRule>> = {
  contributors: 'lww',
  claims: 'append-only',
  queue: 'lww',
  'working-set': 'lww',
  'features-by-id': 'lww',
  'plans-by-slug': 'lww',
  issues: 'lww',
  presence: 'lww',
  // Usage is an immutable event ledger; additive totals are derived from its rows.
  usage: 'append-only',
  'coord-conversations': 'lww',
  'coord-messages': 'lww',
  'coord-threads': 'lww',
  'coord-thread-posts': 'lww',
  'item-assignments': 'lww',
  'hive-settings-by-key': 'lww',
  'agent-facts-by-key': 'lww',
  'p2p-memories-by-id': 'lww',
  'gym-qd-elites-by-niche': 'lww',
  'bee-claim-specs': 'lww',
  'gate-verdicts': 'append-only',
  'hive-policy': 'lww',
  'hive-reports': 'lww',
  'hive-pending-joins': 'lww',
  'hive-members': 'set-union',
  'hive-epoch-keys': 'lww',
  'engineer-issues': 'lww',
  'plan-parts': 'lww',
  'p2p-peer-grants': 'lww',
  'p2p-receipts': 'append-only',
  'p2p-fleet-directory': 'lww',
  'p2p-work-offers': 'lww',
  'p2p-fleet-leader-leases': 'lww',
};

export function mergeRuleFor(table: string, declared?: unknown): MergeRule | undefined {
  const rule = declared ?? TABLE_MERGE_RULES[table];
  if (rule === undefined) return undefined;
  if (rule === 'lww' || rule === 'append-only' || rule === 'set-union' || rule === 'counter') return rule;
  throw new Error(`Invalid merge rule for replicated table ${table}`);
}

/** Fold addresses never rewrite the wire key or author used by encrypted AAD. */
export function operationGroupKey(op: OpEnvelope, rule = mergeRuleFor(op.table ?? '')): string {
  const key = `${op.table}::${op.hbKey}`;
  if (rule === undefined || rule === 'lww') return key;
  // Each contribution reaches its idempotent table writer. In particular, an old
  // contribution from another source must not lose to the latest same-key clock.
  return `${key}::event:${JSON.stringify([
    op.sourceLogKeyHex ?? '', op.writerPubkey ?? '', op.hlc ?? null, op.ts ?? null, op.type,
  ])}`;
}
