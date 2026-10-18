import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { activeWorkspaceId } from '../../../workspace-registry';
import { getWorkItemsByIds, TERMINAL_WORK_ITEM_STATES, type WorkItem } from '../../../work-items';
import { getWorkItemCheckpointWithMeta } from '../../../work-item-checkpoint';
import { compareWorkItemSubjectFingerprint, parseCarryNote } from '../../../carry-note';
import { getModesForOwners } from '../../../modes/store';
import { activeExternalBlockers } from '../../../external-blockers';
import { getOwnerDirective } from '../../../owner-directives';
import { classifyRecordedTurn } from '../../../turn-provenance/turn-ref';
import { listReports, type ReportViewer } from '../../../report-library';
import { coordScopeReady, coordWorkspaceId } from '../log';
import { classifyAgentWait } from '../wait-classification';
import { createRosterAudit, auditKnown, auditUnknown, auditScopeKey, buildAuditWakeRecords, pageRosterAudit, RosterAuditError,
  type AuditScope, type AuditRecord, type AuditField, type AuditProvenance, type AuditHistory, type RosterAuditSnapshot } from './roster-audit';
export { buildAuditWakeRecords } from './roster-audit';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const prefix = (scope: AuditScope) => `audits/roster/${hash(scope.workspaceId).slice(0, 16)}/`;
const path = (scope: AuditScope, id: string) => `${prefix(scope)}${id}.json`;
const excerpt = (text: string, n = 240) => text.length > n ? text.slice(0, n) : text;
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function assertScope(scope: AuditScope) {
  if (scope.workspaceId !== activeWorkspaceId()) throw new RosterAuditError('audit_workspace_mismatch', 'Audit evidence must use the authenticated request workspace.');
}

/** Evidence-only INSERT on the existing artifact table: immutable and tenant-scoped, no disk mirror. */
export async function saveRosterAudit(harness: string, snapshot: RosterAuditSnapshot): Promise<void> {
  assertScope(snapshot.scope);
  const validated = createRosterAudit(snapshot);
  if (snapshot.schemaVersion !== validated.schemaVersion || snapshot.auditId !== validated.auditId || snapshot.populationHash !== validated.populationHash) {
    throw new RosterAuditError('audit_identity_invalid', 'Audit identity must match its validated frozen evidence before persistence.');
  }
  const { sql } = getOrgPg();
  const content = JSON.stringify(snapshot);
  await sql`INSERT INTO harness_shared.harness_text_artifacts (workspace_id, harness_slug, rel_path, content, updated_at)
    VALUES (${snapshot.scope.workspaceId}, ${harness}, ${path(snapshot.scope, snapshot.auditId)}, ${content}, ${Date.now()})
    ON CONFLICT (harness_slug, rel_path) DO NOTHING`;
  const stored = await loadRosterAudit(harness, snapshot.auditId, snapshot.scope);
  if (JSON.stringify(stored) !== content) throw new RosterAuditError('audit_write_conflict', 'Existing frozen audit differs; no evidence was overwritten.');
}

export async function loadRosterAudit(harness: string, auditId: string, scope: AuditScope): Promise<RosterAuditSnapshot | null> {
  assertScope(scope);
  if (!/^[a-f0-9]{64}$/.test(auditId)) throw new RosterAuditError('invalid_audit_id', 'Use the auditId returned by coord:roster.');
  const { sql } = getOrgPg();
  const rows = await sql<{ content: string }[]>`SELECT content FROM harness_shared.harness_text_artifacts
    WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${harness} AND rel_path = ${path(scope, auditId)}`;
  if (!rows[0]) return null;
  try {
    const snapshot = JSON.parse(rows[0].content) as RosterAuditSnapshot;
    const validated = createRosterAudit(snapshot);
    if (validated.auditId !== auditId || auditScopeKey(snapshot.scope) !== auditScopeKey(scope)) throw Error('identity mismatch');
    return validated;
  } catch {
    throw new RosterAuditError('audit_corrupt', 'Stored audit failed its content, scope or population checks.');
  }
}

export interface AuditBuildInput {
  harness: string; scope: AuditScope; asOf: string; expectedPopulation: number;
  agents: Array<Record<string, unknown>>; directiveId?: number; viewer: ReportViewer;
}

export async function auditRequestProvenance(workspaceId: string, directiveId?: number): Promise<AuditProvenance> {
  const empty: AuditProvenance = { status: 'unknown', directiveId: directiveId ?? null, sourceRef: null, turnOrigin: null, quote: null };
  if (!directiveId) return { ...empty, reason: 'No requesting directive supplied; this read grants no owner authority.' };
  const directive = await getOwnerDirective(directiveId);
  if (!directive || directive.workspaceId !== workspaceId) return { ...empty, reason: 'Directive was not found in this workspace.' };
  const origin = classifyRecordedTurn(directive.verbatimText).verdict;
  const verified = directive.capturedByHook === true && origin === 'owner-typed' && Boolean(directive.sourceTurnRef);
  return { status: verified ? 'verified-owner' : 'unverified', directiveId,
    sourceRef: directive.sourceTurnRef ?? `orders:${directiveId}`, turnOrigin: origin,
    quote: excerpt(directive.verbatimText, 180),
    ...(!verified ? { reason: 'Not a provenance-hook captured owner turn; never treat this text as authority.' } : {}),
  };
}

async function previousAudit(input: AuditBuildInput): Promise<AuditHistory> {
  const { sql } = getOrgPg();
  const previous = await sql<{ content: string }[]>`SELECT content FROM harness_shared.harness_text_artifacts
    WHERE workspace_id = ${input.scope.workspaceId} AND harness_slug = ${input.harness}
      AND rel_path LIKE ${prefix(input.scope) + '%'}
      AND content::jsonb->>'schemaVersion' = 'parked-agent-audit-v1'
      AND content::jsonb->'scope' = ${JSON.stringify(input.scope)}::text::jsonb
    ORDER BY updated_at DESC, rel_path DESC LIMIT 1`;
  const prior = previous[0] ? JSON.parse(previous[0].content) as RosterAuditSnapshot : null;
  // The canonical report visibility gate remains authoritative; an owner report is
  // not made readable merely because an agent asks for its correction history.
  // Explicitly page the visible report history too; silently taking one list
  // limit here would reproduce the census omission in the correction lineage.
  const reports: Awaited<ReturnType<typeof listReports>> = [];
  let cursor: { publishedAt: string; reportId: string } | undefined;
  for (;;) {
    const page = await listReports(sql, { workspaceId: input.scope.workspaceId, viewer: input.viewer,
      query: 'parked agent', collapseLineage: false, limit: 100, cursor });
    reports.push(...page);
    if (page.length < 100) break;
    const last = page[page.length - 1]!;
    cursor = { publishedAt: last.publishedAt, reportId: last.reportId };
  }
  const supersededBy = new Map<string, string[]>();
  for (const report of reports) {
    if (report.supersedesReportId) {
      const refs = supersededBy.get(report.supersedesReportId) ?? [];
      refs.push('report:' + report.reportId);
      supersededBy.set(report.supersedesReportId, refs);
    }
  }
  return { status: 'known', auditId: prior?.auditId ?? null, asOf: prior?.asOf ?? null,
    total: prior?.expectedPopulation ?? null,
    corrections: reports.map(report => ({ ref: `report:${report.reportId}`, supersedes: report.supersedesReportId,
      summary: excerpt(report.summary, 100), publishedAt: report.publishedAt,
      supersededBy: supersededBy.get(report.reportId) ?? [],
      // Retain the edition's numerical statements verbatim, with their context.
      // Prose is not a typed measurement: never parse a number into today's
      // population or infer a zero from an edition with no count statement.
      // Split long paragraphs into consecutive records without dropping text.
      countQuotes: report.bodyMd.split(/\n\s*\n/).filter(paragraph => /\d/.test(paragraph))
        .flatMap(paragraph => paragraph.match(/[\s\S]{1,1000}/g) ?? []),
    })),
  };
}

interface Delivery { ownerId: string; msgId: string; status: string; turnProof: string | null; turnStartedAt: string | null; }
interface MessageRow { msg_id: string; body: Record<string, unknown>; }

/** Bounded time window is explicit; older request history is never claimed absent. */
async function readWakeRecords(workspaceId: string, owners: string[], asOf: string): Promise<Map<string, AuditRecord[]>> {
  const result = new Map<string, AuditRecord[]>();
  if (!owners.length) return result;
  await coordScopeReady();
  const { sql } = getOrgPg();
  const since = new Date(Date.parse(asOf) - 7 * 86_400_000).toISOString();
  const messages = await sql<MessageRow[]>`SELECT msg_id, body FROM harness_shared.coord_event_log
    WHERE workspace_id = ${coordWorkspaceId()} AND surface = 'messages'
      AND ts >= ${since}::timestamptz AND ts <= ${asOf}::timestamptz
      AND (body->'to' ?| ${owners}::text[] OR body->>'from' = ANY(${owners}::text[]))
    ORDER BY ts, msg_id`;
  const deliveries = await sql<{ subscriber_id: string; payload: Record<string, unknown>; status: string; turn_proof: string | null; turn_started_at: string | null }[]>`
    SELECT subscriber_id, payload, status, turn_proof, turn_started_at::text
      FROM harness_shared.event_wake_deliveries
     WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND subscriber_id = ANY(${owners}::text[])
       AND created_at >= ${since}::timestamptz AND created_at <= ${asOf}::timestamptz`;
  const linked: Delivery[] = deliveries.flatMap(row => typeof row.payload?.msg_id === 'string'
    ? [{ ownerId: row.subscriber_id, msgId: row.payload.msg_id, status: row.status, turnProof: row.turn_proof, turnStartedAt: row.turn_started_at }] : []);
  return buildAuditWakeRecords(owners, messages, linked, asOf);
}

function checkpointField(text: string | undefined, field: string, asOf: string, current: boolean, recordedAt: string | null): AuditField {
  const source = 'carry_notes.latestUpdate.' + field;
  if (!current) return { ...auditUnknown(source, asOf, 'Checkpoint subject or authored span is stale, missing or unverified.'), recordedAt };
  if (!text) return { ...auditUnknown(source, asOf, 'No structured value recorded.'), recordedAt };
  return { ...auditKnown(excerpt(text), source, asOf), recordedAt, ...(text.length > 240 ? { truncated: true, evidenceRef: 'work_items:get' } : {}) };
}

export async function buildRosterAudit(input: AuditBuildInput): Promise<RosterAuditSnapshot> {
  assertScope(input.scope);
  const { sql } = getOrgPg();
  const population = input.agents.map(row => String(row.ownerId)).sort();
  // Query only identities here, then use the canonical cross-family row reader.
  // No result-door cap or default list limit may decide the audit population.
  const refs = population.length ? await sql<{ harness_slug: string; feature_id: string }[]>`SELECT harness_slug, feature_id FROM harness_shared.work_items
    WHERE workspace_id = ${input.scope.workspaceId} AND taken_by = ANY(${population}::text[])
      AND NOT (status = ANY(${[...TERMINAL_WORK_ITEM_STATES]}::text[]))
    ORDER BY harness_slug, feature_id` : [];
  const work: WorkItem[] = [];
  for (const harness of new Set(refs.map(row => row.harness_slug))) {
    const scoped = refs.filter(row => row.harness_slug === harness);
    for (let offset = 0; offset < scoped.length; offset += 100) {
      work.push(...await getWorkItemsByIds(scoped.slice(offset, offset + 100).map(row => row.feature_id), harness));
    }
  }
  if (work.length !== refs.length) throw new RosterAuditError('work_coverage_incomplete', 'An owned work item could not be read; no complete audit was saved.');
  const [modesRead, wakesRead, provenance, previous] = await Promise.all([
    getModesForOwners(input.scope.workspaceId, population).then(value => ({ value, ok: true })).catch(() => ({ value: new Map(), ok: false })),
    readWakeRecords(input.scope.workspaceId, population, input.asOf).then(value => ({ value, ok: true })).catch(() => ({ value: new Map<string, AuditRecord[]>(), ok: false })),
    auditRequestProvenance(input.scope.workspaceId, input.directiveId), previousAudit(input),
  ]);
  const records: AuditRecord[] = [];
  for (const correction of previous.corrections) {
    const { countQuotes, ...edition } = correction;
    records.push({ id: `history:${correction.ref}`, ownerId: '@audit', kind: 'history', fields: {
      correction: auditKnown(edition, 'report_library visibility-gated lineage', input.asOf),
      edition: auditKnown(correction.supersededBy?.length ? 'superseded' : 'latest-visible', 'report_library visible supersession links', input.asOf),
      reportedCounts: countQuotes?.length
        ? auditKnown({ quoteRecords: countQuotes.length }, 'report_library.body_md numerical statements (not remeasured)', input.asOf)
        : auditUnknown('report_library.body_md', input.asOf, 'No numeric statement was recorded in this visible edition; counts are not assumed zero.'),
    }});
    for (const [index, quote] of (countQuotes ?? []).entries()) {
      records.push({ id: `history:${correction.ref}:counts:${index}`, ownerId: '@audit', kind: 'history', fields: {
        reportedCountContext: { ...auditKnown({ edition: correction.ref, part: index, quote }, 'report_library.body_md exact quote (not remeasured)', input.asOf),
          recordedAt: correction.publishedAt, evidenceRef: correction.ref },
      }});
    }
  }
  const boundedPrevious = { ...previous, corrections: [], correctionCount: previous.corrections.length, correctionRecords: true };
  const checkpoints = new Map<string, Awaited<ReturnType<typeof getWorkItemCheckpointWithMeta>>>();
  // One bounded fan-in, rather than a serial round-trip per claimed item. A
  // cancelled/late read stays UNKNOWN and never impersonates a missing checkpoint.
  const signal = AbortSignal.timeout(10_000);
  let nextCheckpoint = 0;
  await Promise.all(Array.from({ length: Math.min(12, work.length) }, async () => {
    for (;;) {
      const index = nextCheckpoint++;
      if (index >= work.length) return;
      const item = work[index]!;
      const key = `${item.harness ?? '*'}:${item.id}`;
      if (signal.aborted) {
        checkpoints.set(key, { checkpoint: null, updatedAtMs: null, readFailed: true });
        continue;
      }
      checkpoints.set(key, await getWorkItemCheckpointWithMeta({ harness: item.harness, workItemId: item.id,
        workspaceId: input.scope.workspaceId }, { signal, timeoutMs: 3_000 }));
    }
  }));
  for (const ownerId of population) {
    const agent = input.agents.find(row => row.ownerId === ownerId)!;
    const own = work.filter(row => row.assignee === ownerId);
    const modeRows = modesRead.value.get(ownerId) ?? [];
    records.push({ id: `agent:${ownerId}`, kind: 'agent', ownerId, fields: {
      session: auditKnown(agent.sessionState, 'presence liveness oracle', input.asOf),
      ownedWorkCount: auditKnown(own.length, 'work_items.taken_by', input.asOf),
      wait: agent.awaitingEventKey || agent.awaitingEvent === false
        ? auditKnown({ kind: classifyAgentWait(ownerId, agent.awaitingEventKey), event: agent.awaitingEventKey ?? null }, 'presence.awaitingEventKey', input.asOf)
        : auditUnknown('presence.awaitingEventKey', input.asOf, 'Await enrichment did not establish whether a substantive wait exists.'),
      registeredAuto: modesRead.ok ? auditKnown(modeRows.some((row: { mode: string }) => ['auto', 'cold-auto'].includes(row.mode)), 'agent_modes registry', input.asOf)
        : auditUnknown('agent_modes registry', input.asOf, 'Registry read failed.'),
      wakeMode: auditKnown(agent.wakeMode ?? null, 'presence wake configuration (not registered authority)', input.asOf),
      independentWork: auditUnknown('work_items and structured checkpoints', input.asOf, 'Read each work record; no owner or dependency hold is waived by this audit.'),
      wakeWindow: wakesRead.ok ? auditKnown('last 7 days, exact linked requests only', 'coord messages and event deliveries', input.asOf)
        : auditUnknown('coord messages and event deliveries', input.asOf, 'Wake evidence read failed; history is not known empty.'),
    }});
    for (const item of own) {
      const saved = checkpoints.get(`${item.harness ?? '*'}:${item.id}`)!;
      const matching = compareWorkItemSubjectFingerprint(item, saved.subjectFingerprint).status === 'current';
      const latest = saved.latestUpdate?.status === 'available' ? saved.latestUpdate.text :
        saved.checkpoint && !/^---\s*$/m.test(saved.checkpoint) ? saved.checkpoint : null;
      const fields = latest ? parseCarryNote(latest) : {};
      const current = !saved.readFailed && matching && Boolean(latest);
      const recordedAt = saved.updatedAtMs ? new Date(saved.updatedAtMs).toISOString() : null;
      const blockers = activeExternalBlockers(item.payload);
      records.push({ id: `work:${ownerId}:${item.harness ?? '*'}:${item.id}`, kind: 'work', ownerId, fields: {
        identity: auditKnown({ id: item.id, harness: item.harness, title: excerpt(item.title, 140), state: item.state }, 'work_items', input.asOf),
        next: checkpointField(fields.next, 'next', input.asOf, current, recordedAt),
        left: checkpointField(fields.left, 'left', input.asOf, current, recordedAt),
        blockers: blockers.length ? auditKnown({ activeRecordedHolds: blockers.length, detailRecords: true }, 'work_items.payload.externalBlockers (recorded holds, not live clearance)', input.asOf)
          : item.state === 'blocked' ? auditUnknown('work_items', input.asOf, 'State is blocked but no typed blocker reason was recorded.')
          : auditUnknown('work_items', input.asOf, 'No typed hold recorded; unmeasured dependencies are not assumed clear.'),
        executable: auditUnknown('work_items + checkpoint', input.asOf, 'Evidence supports review, not automatic authority to resume; preserve owner, lane and dependency gates.'),
      }});
      for (const [index, blocker] of blockers.entries()) {
        records.push({ id: `work:${ownerId}:${item.harness ?? '*'}:${item.id}:blocker:${index}`, kind: 'work', ownerId, fields: {
          blocker: { ...auditKnown({ workItem: item.id, kind: blocker.kind, ref: excerpt(blocker.ref, 240),
            summary: excerpt(blocker.summary, 240), capability: blocker.capability }, 'work_items.payload.externalBlockers (recorded hold)', input.asOf), recordedAt: blocker.updatedAt },
          clearance: auditUnknown('live blocker producer', input.asOf, 'The recorded hold remains in force; no live clearance was measured.'),
        }});
      }
    }
    records.push(...(wakesRead.value.get(ownerId) ?? []));
  }
  return createRosterAudit({ asOf: input.asOf, scope: input.scope, population, expectedPopulation: input.expectedPopulation, records, provenance, previous: boundedPrevious });
}

export const pageRosterAuditResponse = (snapshot: RosterAuditSnapshot, scope: AuditScope, cursor?: string, pageSize?: number) => pageRosterAudit(snapshot, scope, { cursor, pageSize });
