import { createHash } from 'node:crypto';

/** Frozen evidence uses the existing text-artifact store; paging never re-derives liveness. */
export const ROSTER_AUDIT_SCHEMA = 'parked-agent-audit-v1' as const;
export const ROSTER_AUDIT_PREFIX = 'audits/roster/';
export const ROSTER_AUDIT_PAGE_SIZE = 10;

export interface AuditScope {
  workspaceId: string;
  scope: 'workspace' | 'hive';
  potId: string | null;
  owner: string | null;
  /** A bundle can contain the reader's visibility-gated report metadata. */
  readerId?: string | null;
}

export interface AuditField<T = unknown> {
  status: 'known' | 'unknown';
  source: string;
  observedAt: string;
  value?: T;
  reason?: string;
  recordedAt?: string | null;
  truncated?: boolean;
  evidenceRef?: string;
}

export interface AuditRecord {
  id: string;
  kind: 'agent' | 'work' | 'wake' | 'history';
  ownerId: string;
  fields: Record<string, AuditField>;
}

/** Advisory assessment of the assigned step, never permission to clear a hold. */
export function auditExecutableStep(input: {
  current: boolean; next?: string; auto: boolean | null; held: boolean;
  dependencies: 'clear' | 'blocked' | 'unknown'; planLinked: boolean; observedAt: string;
  planLane?: 'clear' | 'blocked' | 'unknown';
}): AuditField<boolean> {
  const source = 'work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions';
  if (input.held || input.dependencies === 'blocked' || input.planLane === 'blocked') return {
    ...auditKnown(false, source, input.observedAt),
    reason: input.held ? 'A recorded owner, external or state hold remains in force.'
      : input.planLane === 'blocked' ? 'The current plan lane, dependency or owner decision blocks this step.'
      : 'A current dependency remains unresolved.',
  };
  const reason = !input.current || !input.next?.trim() ? 'No current, subject-matching next step is available.'
    : input.dependencies === 'unknown' ? 'Current dependency evidence was unavailable.'
    : input.auto !== true ? 'Registered AUTO authority was not established.'
    : input.planLinked && input.planLane !== 'clear' ? 'Current plan lane and owner-decision evidence was unavailable; dependency clearance alone is insufficient.'
    : null;
  return reason ? auditUnknown<boolean>(source, input.observedAt, reason)
    : { ...auditKnown(true, source, input.observedAt), reason: 'The assigned current step has registered AUTO authority and no measured work dependency or recorded hold. This is evidence, not a new grant of authority.' };
}

export interface AuditProvenance {
  status: 'verified-owner' | 'unverified' | 'unknown';
  directiveId: number | null;
  sourceRef: string | null;
  turnOrigin: string | null;
  quote: string | null;
  reason?: string;
}

export interface AuditHistory {
  auditId: string | null;
  asOf: string | null;
  total: number | null;
  corrections: Array<{ ref: string; supersedes: string | null; summary: string;
    publishedAt?: string; supersededBy?: string[]; countQuotes?: string[] }>;
  status: 'known' | 'unknown';
  reason?: string;
  correctionCount?: number;
  correctionRecords?: boolean;
}

export interface RosterAuditSnapshot {
  schemaVersion: typeof ROSTER_AUDIT_SCHEMA;
  auditId: string;
  asOf: string;
  scope: AuditScope;
  population: string[];
  populationHash: string;
  expectedPopulation: number;
  records: AuditRecord[];
  provenance: AuditProvenance;
  previous: AuditHistory;
}

export class RosterAuditError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export function auditKnown<T>(value: T, source: string, observedAt: string): AuditField<T> {
  return { status: 'known', value, source, observedAt };
}

export function auditUnknown<T = unknown>(source: string, observedAt: string, reason: string): AuditField<T> {
  return { status: 'unknown', source, observedAt, reason };
}

export function auditScopeKey(scope: AuditScope): string {
  return JSON.stringify([scope.workspaceId, scope.scope, scope.potId, scope.owner, scope.readerId ?? null]);
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Fail closed before persisting an incomplete census or a stream with duplicate identities. */
export function createRosterAudit(input: Omit<RosterAuditSnapshot, 'schemaVersion' | 'auditId' | 'populationHash'>): RosterAuditSnapshot {
  if (!Number.isFinite(Date.parse(input.asOf))) throw new RosterAuditError('invalid_as_of', 'Audit observation time is invalid.');
  if (typeof input.expectedPopulation !== 'number' || !Number.isSafeInteger(input.expectedPopulation) || input.expectedPopulation < 0) {
    throw new RosterAuditError('writer_count_invalid', 'Audit writer population must be a measured non-negative safe integer.');
  }
  if (!input.scope.workspaceId || input.expectedPopulation !== input.population.length) {
    throw new RosterAuditError('population_incomplete', 'Returned parked owners do not match the roster writer population.');
  }
  const owners = new Set(input.population);
  if (owners.size !== input.population.length || input.population.some(id => !id.trim())) {
    throw new RosterAuditError('population_duplicate', 'Parked population identities are missing or duplicated.');
  }
  const headers = input.records.filter(row => row.kind === 'agent').map(row => row.ownerId);
  if (headers.length !== owners.size || new Set(headers).size !== owners.size || headers.some(id => !owners.has(id))) {
    throw new RosterAuditError('agent_coverage_invalid', 'Every parked owner must have exactly one agent record.');
  }
  const ids = new Set<string>();
  for (const record of input.records) {
    if ((record.kind !== 'history' && !owners.has(record.ownerId)) || !record.id || ids.has(record.id)) {
      throw new RosterAuditError('record_identity_invalid', 'Audit records contain a foreign owner or duplicate identity.');
    }
    ids.add(record.id);
    if (JSON.stringify(record).length > 3600) {
      throw new RosterAuditError('record_too_large', 'Audit evidence record exceeds the bounded page contract; split its evidence into separate records.');
    }
    for (const field of Object.values(record.fields)) {
      if (!['known', 'unknown'].includes(field.status) || !field.source || !Number.isFinite(Date.parse(field.observedAt))) {
        throw new RosterAuditError('evidence_unlabelled', 'Every evidence field requires its status, source and observation time.');
      }
      if (field.status === 'unknown' && !field.reason) {
        throw new RosterAuditError('unknown_unexplained', 'Unknown evidence requires a reason.');
      }
    }
  }
  if (input.provenance.status === 'verified-owner' &&
      (!input.provenance.directiveId || !input.provenance.sourceRef || input.provenance.turnOrigin !== 'owner-typed')) {
    throw new RosterAuditError('provenance_invalid', 'Owner authority requires a captured owner turn and its durable directive reference.');
  }
  const populationHash = digest([...owners].sort());
  const auditId = digest([input.asOf, auditScopeKey(input.scope), populationHash, input.records, input.provenance, input.previous]);
  return { ...input, schemaVersion: ROSTER_AUDIT_SCHEMA, auditId, populationHash };
}

interface AuditCursor { v: 1; auditId: string; scope: string; offset: number; }

export function decodeAuditCursor(token: string): AuditCursor {
  try {
    if (token.length > 2_000) throw Error('too large');
    const value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as AuditCursor;
    if (value.v !== 1 || !/^[a-f0-9]{64}$/.test(value.auditId) || typeof value.scope !== 'string' ||
        !Number.isSafeInteger(value.offset) || value.offset < 0) throw Error('invalid cursor');
    return value;
  } catch {
    throw new RosterAuditError('invalid_cursor', 'Use the exact nextCursor returned by this audit.');
  }
}

/** Records, rather than whole agents, are paged: one agent's many work items remain bounded. */
export function pageRosterAudit(snapshot: RosterAuditSnapshot, scope: AuditScope, options: { cursor?: string; pageSize?: number } = {}) {
  if (snapshot.schemaVersion !== ROSTER_AUDIT_SCHEMA || auditScopeKey(snapshot.scope) !== auditScopeKey(scope)) {
    throw new RosterAuditError('audit_scope_mismatch', 'Audit does not belong to the requested workspace and lens.');
  }
  const cursor = options.cursor ? decodeAuditCursor(options.cursor) : null;
  if (cursor && (cursor.auditId !== snapshot.auditId || cursor.scope !== auditScopeKey(scope))) {
    throw new RosterAuditError('cursor_scope_mismatch', 'Cursor belongs to a different audit or scope.');
  }
  const offset = cursor?.offset ?? 0;
  if (offset > snapshot.records.length) throw new RosterAuditError('cursor_out_of_range', 'Cursor is outside this frozen audit.');
  const pageSize = options.pageSize ?? ROSTER_AUDIT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10) throw new RosterAuditError('invalid_page_size', 'Audit pageSize must be between 1 and 10.');
  let end = Math.min(offset + pageSize, snapshot.records.length);
  // A row-count limit alone does not bound the result door. Honor the requested
  // maximum while returning fewer records if necessary; the cursor covers the rest.
  while (end > offset + 1 && JSON.stringify(snapshot.records.slice(offset, end)).length > 2800) end--;
  const records = snapshot.records.slice(offset, end);
  const complete = end === snapshot.records.length;
  const nextCursor = complete ? null : Buffer.from(JSON.stringify({ v: 1, auditId: snapshot.auditId, scope: auditScopeKey(scope), offset: end })).toString('base64url');
  const covered = snapshot.records.slice(0, end).filter(row => row.kind === 'agent').length;
  return {
    view: 'audit', auditId: snapshot.auditId, asOf: snapshot.asOf, scope: snapshot.scope,
    populationHash: snapshot.populationHash, records, nextCursor,
    coverage: { total: snapshot.expectedPopulation, covered, missing: 0, duplicates: 0, recordsRead: end,
      totalRecords: snapshot.records.length, complete, truncatedByLimit: !complete },
    // Repeat small continuity metadata on every page; a carry need only retain its cursor.
    provenance: snapshot.provenance, previous: snapshot.previous,
    projection: { project: 'audit', returned: records.length, offset, truncatedByLimit: !complete },
  };
}

/** Match the writer's exact message and recipient; unrelated later activity is not pickup. */
export function auditWakeEvidence(input: {
  ownerId: string; msgId: string; observedAt: string; messageExists: boolean;
  deliveries: Array<{ ownerId: string; msgId: string; status: string; turnProof: string | null; turnStartedAt: string | null }>;
  replies: Array<{ from: string; relatedMsgId: string }>;
}) {
  const deliveries = input.deliveries.filter(row => row.ownerId === input.ownerId && row.msgId === input.msgId);
  const knownTrue = (value: boolean, name: string) => value ? auditKnown(true, name, input.observedAt)
    : auditUnknown(name, input.observedAt, 'No matching positive evidence was recorded.');
  return {
    // Persisting sender intent precedes the wake fan and does not establish
    // that this recipient entered the durable queue. Even a later dead/dropped
    // delivery proves enqueueing, while an unrelated recipient never does.
    queued: knownTrue(deliveries.length > 0, 'event_wake_deliveries:' + input.msgId),
    delivered: knownTrue(deliveries.some(row => row.status === 'delivered'), 'event_wake_deliveries:' + input.msgId),
    turnStarted: knownTrue(deliveries.some(row => ['observed', 'host-attested'].includes(row.turnProof ?? '') &&
      row.turnStartedAt !== null && Number.isFinite(Date.parse(row.turnStartedAt))), 'event_wake_deliveries.turn_proof:' + input.msgId),
    replied: knownTrue(input.replies.some(row => row.from === input.ownerId && row.relatedMsgId === input.msgId), 'coord_event_log.related_msg_id:' + input.msgId),
  };
}

export function buildAuditWakeRecords(
  owners: string[], messages: Array<{ msg_id: string; body: Record<string, unknown> }>,
  linked: Array<{ ownerId: string; msgId: string; status: string; turnProof: string | null; turnStartedAt: string | null }>,
  asOf: string,
): Map<string, AuditRecord[]> {
  const wanted = new Set(owners);
  const requests = new Map(owners.map(owner => [owner, new Map<string, { msg_id: string; body: Record<string, unknown> }>()]));
  const deliveries = new Map<string, Map<string, typeof linked>>();
  const replies = new Map<string, Map<string, Array<{ from: string; relatedMsgId: string }>>>();
  for (const delivery of linked) {
    const ownerId = delivery.ownerId;
    const msgId = delivery.msgId;
    if (!wanted.has(ownerId)) continue;
    const byMessage = deliveries.get(ownerId) ?? new Map<string, typeof linked>();
    const matches = byMessage.get(msgId) ?? [];
    matches.push(delivery);
    byMessage.set(msgId, matches);
    deliveries.set(ownerId, byMessage);
  }
  for (const message of messages) {
    const body = message.body;
    if (typeof body.from === 'string' && typeof body.related_msg_id === 'string' && wanted.has(body.from)) {
      const byMessage = replies.get(body.from) ?? new Map<string, Array<{ from: string; relatedMsgId: string }>>();
      byMessage.set(body.related_msg_id, [{ from: body.from, relatedMsgId: body.related_msg_id }]);
      replies.set(body.from, byMessage);
    }
    if (!Array.isArray(body.to)) continue;
    for (const recipient of body.to) {
      if (typeof recipient !== 'string' || !wanted.has(recipient)) continue;
      if (body.wake === true || body.wake === 'required' || deliveries.get(recipient)?.has(message.msg_id)) {
        requests.get(recipient)!.set(message.msg_id, message);
      }
    }
  }
  const result = new Map<string, AuditRecord[]>();
  for (const ownerId of owners) {
    const requested = requests.get(ownerId)!;
    for (const msgId of deliveries.get(ownerId)?.keys() ?? []) {
      if (!requested.has(msgId)) requested.set(msgId, { msg_id: msgId, body: {} });
    }
    result.set(ownerId, [...requested.values()].map(message => ({
      id: 'wake:' + ownerId + ':' + message.msg_id, ownerId, kind: 'wake', fields: {
        request: auditKnown(message.msg_id, 'coord_event_log / exact delivery payload', asOf),
        ...auditWakeEvidence({
          ownerId, msgId: message.msg_id, observedAt: asOf, messageExists: Object.keys(message.body).length > 0,
          deliveries: deliveries.get(ownerId)?.get(message.msg_id) ?? [],
          replies: replies.get(ownerId)?.get(message.msg_id) ?? [],
        }),
      },
    })));
  }
  return result;
}
