import { pageRosterAudit } from './tools/roster-audit';
import type { AuditRecord } from './tools/roster-audit';

export interface PageOracle {
  auditId: string;
  asOf: string;
  populationCount: number;
  recordCount: number;
  baseOffset: number;
  baseCovered: number;
  records: AuditRecord[];
}

export function publicPageViolations(
  expected: PageOracle,
  page: ReturnType<typeof pageRosterAudit> | null,
  offset: number,
  cursor: string | null,
): string[] {
  if (!page || !Array.isArray(page.records)) return ['public-page-unavailable'];
  const errors: string[] = [];
  if (page.auditId !== expected.auditId || page.asOf !== expected.asOf) errors.push('snapshot-changed');
  if (page.projection?.offset !== offset) errors.push('offset-changed');
  const end = offset + page.records.length;
  const wanted = expected.records.slice(offset - expected.baseOffset, end - expected.baseOffset);
  if (JSON.stringify(page.records) !== JSON.stringify(wanted)) errors.push('record-stream-changed');
  const covered = expected.baseCovered + expected.records.slice(0, end - expected.baseOffset)
    .filter(row => row.kind === 'agent').length;
  const complete = end === expected.recordCount;
  const coverage = page.coverage;
  if (!coverage || coverage.total !== expected.populationCount || coverage.covered !== covered
    || coverage.recordsRead !== end || coverage.totalRecords !== expected.recordCount
    || coverage.missing !== 0 || coverage.duplicates !== 0 || coverage.complete !== complete
    || coverage.truncatedByLimit !== !complete) errors.push('coverage-changed');
  if (complete ? page.nextCursor !== null : !page.nextCursor || page.nextCursor === cursor || !page.records.length) {
    errors.push('cursor-did-not-progress');
  }
  return errors;
}

/** A refused dispatch ran no script; semantic failures and unknown outcomes are never retried. */
export async function retryAuditRead<T>(
  read: () => Promise<T>,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolveWait => setTimeout(resolveWait, ms)),
  frozenReadOnly = false,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const admissionRefused = message.includes('operator rejected the request before dispatch (loop_pressure_critical)')
        && message.includes('"reason":"loop_pressure_critical"');
      // This exact MCP authentication refusal is emitted before dispatch. Retrying
      // re-runs authentication; it never bypasses it or replays an unknown write.
      const verifierRefused = message.includes('authenticated audit read exit 1: MCP_ERROR:')
        && message.includes('request_rejected: superuser_native_session_verifier_unavailable');
      const refused = admissionRefused || verifierRefused;
      const interruptedRead = frozenReadOnly && message.includes('authenticated audit read exit 4:')
        && /UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED/.test(message);
      if (attempt === 5 || (!refused && !interruptedRead)) throw error;
      process.stdout.write(`PARKED_AUDIT_TRANSPORT_RETRY ${JSON.stringify({ attempt: attempt + 1,
        reason: refused ? 'refused-before-dispatch' : 'frozen-read-interrupted' })}\n`);
      await wait(Math.min(1000 * 2 ** attempt, 10_000));
    }
  }
}

export interface SearchObservation {
  tools: { query: string; hits: Array<{ tool: string; description: string }> };
  docs: { hits: Array<{ slug: string; url: string }>; legs: { degraded: boolean } };
}

export function searchViolations(observation: SearchObservation | null): string[] {
  if (!observation || !Array.isArray(observation.tools?.hits) || !Array.isArray(observation.docs?.hits)) {
    return ['live-search-unavailable'];
  }
  const errors: string[] = [];
  if (observation.tools.query !== 'parked agent audit') errors.push('wrong-query');
  if (!observation.tools.hits.slice(0, 3).some(hit => hit.tool === 'coord:roster'
    && /view\s*[:=]\s*["']?audit\b/.test(hit.description))) errors.push('tools:find:missing-top-three');
  if (!observation.docs.hits.slice(0, 3).some(hit => hit.slug === 'agent-insights/parked-agent-audit-roster-view'
    && hit.url === '/internal/docs/agent-insights/parked-agent-audit-roster-view')) errors.push('docs:search:missing-top-three');
  if (observation.docs.legs?.degraded !== false) errors.push('docs:search:unavailable-ranking');
  return errors;
}

export interface Census {
  asOf: string;
  startCount: number;
  records: Array<{ presence: { ownerId: string; sessionState: string } }>;
}

export interface Dispositions {
  asOf: string;
  population: number;
  decisions: Array<{
    ownerId: string;
    decision: string;
    reason: string;
    evidence: string[];
    reviewed: boolean;
  }>;
}

export interface Review {
  asOf: string;
  population: number;
  rows: Array<{
    ownerId: string;
    work: Array<{
      id: string;
      next: { status: string };
      blockers: { status: string };
      left: { status: string };
    }>;
  }>;
}

export interface WakeAudit {
  observedAt: string;
  targets: number;
  requestCount: number;
  rows: Array<{
    ownerId: string;
    requests: Array<{
      ownerId: string;
      msgId: string;
      at: string;
      receipt?: { pickupConfirmed?: boolean };
    }>;
    deliveries: Array<{
      id: string | null;
      owner_id: string;
      msg_id: string;
      first_agent_call: string | null;
    }>;
    outcome: string;
  }>;
}

function duplicates(ids: string[]): string[] {
  return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].sort();
}

/** Independent set oracle; the declared counts are checked against the actual rows. */
export function auditPopulationViolations(census: Census, dispositions: Dispositions, review: Review): string[] {
  const errors: string[] = [];
  const owners = census.records.map((row) => row.presence.ownerId);
  const population = new Set(owners);
  if (!owners.length) errors.push('empty-population');
  if (owners.length !== census.startCount) errors.push('census-count-mismatch');
  if (duplicates(owners).length) errors.push('duplicate-census-owner');
  if (census.records.some((row) => !row.presence.ownerId || row.presence.sessionState !== 'parked')) {
    errors.push('invalid-start-population');
  }
  for (const [name, rows, count, asOf] of [
    ['dispositions', dispositions.decisions, dispositions.population, dispositions.asOf],
    ['review', review.rows, review.population, review.asOf],
  ] as const) {
    const ids = rows.map((row) => row.ownerId);
    if (asOf !== census.asOf) errors.push(`${name}:snapshot-mismatch`);
    if (count !== census.startCount || ids.length !== count) errors.push(`${name}:count-mismatch`);
    if (duplicates(ids).length) errors.push(`${name}:duplicate-owner`);
    for (const id of population) if (!ids.includes(id)) errors.push(`${name}:missing:${id}`);
    for (const id of ids) if (!population.has(id)) errors.push(`${name}:foreign:${id}`);
  }
  for (const row of dispositions.decisions) {
    if (!row.reviewed || !row.decision?.trim() || !row.reason?.trim() || !row.evidence?.length) {
      errors.push(`dispositions:unexplained:${row.ownerId}`);
    }
  }
  for (const row of review.rows) {
    for (const work of row.work) {
      for (const field of ['next', 'blockers', 'left'] as const) {
        if (!['known', 'unknown'].includes(work[field]?.status)) {
          errors.push(`review:unlabelled:${row.ownerId}:${work.id}:${field}`);
        }
      }
    }
  }
  return errors.sort();
}

/** R-2 records request outcomes; activity after a request does not establish causation. */
export function auditWakeOutcomeViolations(
  dispositions: Dispositions,
  audit: WakeAudit,
  nonWakingMessageIds: string[] = [],
): string[] {
  const errors: string[] = [];
  const candidates = dispositions.decisions.filter((row) => row.decision === 'resume-candidate').map((row) => row.ownerId);
  const owners = audit.rows.map((row) => row.ownerId);
  if (!candidates.length) errors.push('empty-resume-population');
  if (duplicates(candidates).length) errors.push('duplicate-resume-candidate');
  if (duplicates(owners).length) errors.push('duplicate-wake-owner');
  if (audit.targets !== candidates.length || owners.length !== candidates.length) errors.push('wake-count-mismatch');
  for (const owner of candidates) if (!owners.includes(owner)) errors.push(`missing-wake-outcome:${owner}`);
  for (const owner of owners) if (!candidates.includes(owner)) errors.push(`foreign-wake-owner:${owner}`);
  const requests = audit.rows.flatMap((row) => row.requests);
  if (requests.length !== audit.requestCount) errors.push('request-count-mismatch');
  if (duplicates(requests.map((row) => row.msgId)).length) errors.push('duplicate-request-id');
  if (duplicates(audit.rows.flatMap((row) => row.deliveries.flatMap((delivery) => delivery.id ? [delivery.id] : []))).length) {
    errors.push('duplicate-delivery-id');
  }
  for (const row of audit.rows) {
    if (!row.requests.some((request) => request.receipt)) errors.push(`missing-request:${row.ownerId}`);
    for (const request of row.requests) {
      if (request.ownerId !== row.ownerId || !request.msgId || !Number.isFinite(Date.parse(request.at))) {
        errors.push(`invalid-request:${row.ownerId}`);
      }
      if (request.receipt?.pickupConfirmed === true) errors.push(`enqueue-claims-pickup:${row.ownerId}`);
      if (!request.receipt) {
        if (!nonWakingMessageIds.includes(request.msgId)) errors.push(`unverified-nonwake:${row.ownerId}:${request.msgId}`);
        continue;
      }
      if (nonWakingMessageIds.includes(request.msgId)) errors.push(`wake-labelled-nonwake:${row.ownerId}:${request.msgId}`);
      if (!row.deliveries.some((delivery) => delivery.id && delivery.owner_id === row.ownerId && delivery.msg_id === request.msgId)) {
        errors.push(`missing-delivery:${row.ownerId}:${request.msgId}`);
      }
    }
    for (const delivery of row.deliveries) {
      if (delivery.owner_id !== row.ownerId || !row.requests.some((request) => request.msgId === delivery.msg_id)) {
        errors.push(`foreign-delivery:${row.ownerId}`);
      }
      if (!delivery.id && (!nonWakingMessageIds.includes(delivery.msg_id) || delivery.first_agent_call !== null)) {
        errors.push(`unverified-null-delivery:${row.ownerId}:${delivery.msg_id}`);
      }
    }
    const activityObserved = row.deliveries.some((delivery) => {
      const request = row.requests.find((request) => request.msgId === delivery.msg_id);
      const callAt = delivery.first_agent_call ? Date.parse(delivery.first_agent_call) : NaN;
      const requestAt = request ? Date.parse(request.at) : NaN;
      return Boolean(delivery.id && request?.receipt) && Number.isFinite(callAt) && callAt >= requestAt && callAt <= requestAt + 600_000;
    });
    const expected = activityObserved ? 'turn-observed-after-wake' : 'delivery-recorded-pickup-unconfirmed';
    if (row.outcome !== expected) errors.push(`unsupported-outcome:${row.ownerId}`);
  }
  return errors.sort();
}
