/** Authenticated readback from the actual capture project. No receipt or project
 * identity supplied by a caller can stand in for this measurement. */
import { randomUUID } from 'node:crypto';
import { context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { getPosthogConfigWithSource } from '../posthog-config';
import { runtimeTraceDeliveryConfig } from './runtime';

export interface ObservedProjectEvent {
  uuid: string; event: string; timestamp: number; traceId: string; spanId: string;
  parentSpanId: string | null; callId: string | null; isError: boolean; httpClient: boolean; spanName: string;
  requestId?: string | null;
}
export type ProjectReadback =
  | { status: 'available'; projectId: string; queriedAt: number; evidenceRef: string; events: ObservedProjectEvent[] }
  | { status: 'unknown' | 'broken'; reason: string };

/** Read a bounded trace population, with a fresh absent-UUID query as an
 * independent control. Availability means the query worked, not acceptance. */
export async function readConfiguredTraceProject(traceIds: readonly string[]): Promise<ProjectReadback> {
  if (!traceIds.length || traceIds.length > 16 || traceIds.some(id => !/^[a-f0-9]{32}$/.test(id) || /^0+$/.test(id))) {
    return { status: 'unknown', reason: 'invalid-trace-selectors' };
  }
  return context.with(suppressTracing(context.active()), async (): Promise<ProjectReadback> => {
    try {
      const capture = await runtimeTraceDeliveryConfig();
      const configured = getPosthogConfigWithSource().config;
      if (!capture.allowed || !configured?.personalApiKey) return { status: 'unknown', reason: 'project-query-not-authorized' };
      const host = new URL(capture.host);
      if (host.username || host.password || (host.protocol !== 'https:' &&
        !(host.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)))) {
        return { status: 'unknown', reason: 'unsafe-project-origin' };
      }
      if (new URL(configured.host).origin !== host.origin || configured.projectKey !== capture.projectKey) {
        return { status: 'unknown', reason: 'capture-query-authority-mismatch' };
      }
      const signal = AbortSignal.timeout(10_000);
      const request = async (path: string, query?: string): Promise<Record<string, unknown>> => {
        const url = new URL(path, host.origin);
        if (url.origin !== host.origin || url.username || url.password) throw Error('foreign-origin');
        const response = await fetch(url, {
          method: query ? 'POST' : 'GET', redirect: 'error', signal,
          headers: { authorization: `Bearer ${configured.personalApiKey}`, 'content-type': 'application/json' },
          ...(query ? { body: JSON.stringify({ refresh: 'force_blocking', query: { kind: 'HogQLQuery', query } }) } : {}),
        });
        if (!response.ok) throw Error('project-query-unavailable');
        return response.json();
      };
      const projects: Record<string, unknown>[] = [];
      let next: string | null = '/api/projects/?limit=100';
      for (let page = 0; next && page < 10; page++) {
        const data = await request(next);
        if (!Array.isArray(data.results) || (data.next != null && typeof data.next !== 'string')) throw Error('incomplete-project-catalog');
        projects.push(...data.results);
        next = data.next as string | null;
      }
      if (next) throw Error('incomplete-project-catalog');
      const matches = projects.filter(project => project.api_token === capture.projectKey);
      if (matches.length !== 1 || !Number.isSafeInteger(matches[0]!.id) || Number(matches[0]!.id) < 1) {
        return { status: 'unknown', reason: 'configured-project-unverified' };
      }
      const projectId = String(matches[0]!.id);
      const endpoint = `/api/projects/${projectId}/query/`;
      const absentUuid = randomUUID();
      const control = await request(endpoint, `SELECT uuid FROM events WHERE uuid = '${absentUuid}' LIMIT 1`);
      if (!Array.isArray(control.results)) throw Error('unreadable-query-control');
      if (control.results.length) return { status: 'broken', reason: 'absent-uuid-control-returned-event' };
      const selectors = [...new Set(traceIds)].map(id => `'${id}'`).join(',');
      // The invocation writer owns the expected population, including expired
      // journeys. An independent age window here would hide delivered leaves
      // and turn a healthy old trace into a false missing-event failure.
      const query = "SELECT uuid,event,toUnixTimestamp64Milli(timestamp),properties.$ai_trace_id," +
        "properties.$ai_span_id,properties.$ai_parent_id,properties.`papercusp.call_id`,properties.$ai_is_error,properties.`papercusp.http_client`,properties.$ai_span_name,properties.`papercusp.request_id` " +
        `FROM events WHERE properties.$ai_trace_id IN (${selectors}) LIMIT 501`;
      const result = await request(endpoint, query);
      if (!Array.isArray(result.results) || result.results.length > 500 || result.hasMore === true || result.next) throw Error('incomplete-event-query');
      const events: ObservedProjectEvent[] = [];
      for (const row of result.results) {
        if (!Array.isArray(row) || row.length !== 11 || typeof row[0] !== 'string' || typeof row[1] !== 'string' ||
          !Number.isFinite(row[2]) || !traceIds.includes(row[3]) || !/^[a-f0-9]{16}$/.test(row[4]) ||
          /^0+$/.test(row[4]) || (row[5] != null && (!/^[a-f0-9]{16}$/.test(row[5]) || /^0+$/.test(row[5]))) ||
          (row[6] != null && typeof row[6] !== 'string') || typeof row[7] !== 'boolean' || typeof row[8] !== 'boolean' ||
          !['papercusp.tool', 'papercusp.model', 'papercusp.http', 'papercusp.span'].includes(row[9]) ||
          (row[10] != null && (typeof row[10] !== 'string' || row[10].length > 200 || /[\r\n\u0000]/.test(row[10])))) throw Error('unreadable-event-row');
        events.push({ uuid: row[0], event: row[1], timestamp: row[2], traceId: row[3], spanId: row[4],
          parentSpanId: row[5] ?? null, callId: row[6] ?? null, isError: row[7], httpClient: row[8], spanName: row[9], requestId: row[10] ?? null });
      }
      return { status: 'available', projectId, queriedAt: Date.now(),
        evidenceRef: `${host.origin}${endpoint} traceIds=${[...new Set(traceIds)].join(',')} absentUuid=${absentUuid}`, events };
    } catch {
      // Endpoint bodies and exception text can contain credentials or content.
      return { status: 'unknown', reason: 'project-query-unavailable-or-incomplete' };
    }
  });
}
